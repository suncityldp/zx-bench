import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { referenceAnswerWarnings, partitionReferenceAnswerRuns } from './referenceAnswerReview.js';
import { analyzeRunQuality } from './quality.js';
import { hashScenarioShort } from './contracts/canonicalize.js';

const old = { scenarioId: 'RM-CN-004', scenarioVersion: '2.0.1', graderVersion: 'exact_answer_line@exact_answer_v2' };
const current = { ...old, scenarioVersion: '3.2.0', graderVersion: 'exact_answer_line@exact_answer_v4' };
describe('reference answer compatibility and historical preservation', () => {
  it('excludes retired HAL history and old new-bank versions without rewriting rows', () => {
    const rows = [{scenarioId:'HAL-CN-001',scenarioVersion:'3.0.0',graderVersion:'hallucination_v3'}, {scenarioId:'FR-001',scenarioVersion:'4.0.0',graderVersion:'hallucination_v4'}];
    const before = JSON.stringify(rows);
    expect(referenceAnswerWarnings(rows)).toHaveLength(2);
    expect(referenceAnswerWarnings([{scenarioId:'FR-001',scenarioVersion:'5.0.0',graderVersion:'hallucination_resistance@hallucination_v5'}])).toEqual([]);
    expect(partitionReferenceAnswerRuns([{id:'old',results:rows}]).eligible).toEqual([]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('isolates old gold, old scoring, missing versions and disputed scenarios', () => {
    for (const row of [old, { ...current, graderVersion: old.graderVersion }, { scenarioId: old.scenarioId }, { ...current, scenarioVersion: '3.1.0', scenarioId: 'RM-CN-031' }]) {
      expect(referenceAnswerWarnings([row]).length).toBe(1);
    }
    expect(referenceAnswerWarnings([current, { ...current, graderVersion: 'exact_answer_v4' }, { scenarioId: 'CP-L4-001' }])).toEqual([]);
  });
  it('excludes the whole mixed run before latest/best can use cached or highest scores', () => {
    const runs = [
      { id:'mixed', results:[current, old], summary:{averageScore:100} },
      { id:'old', results:[old], summary:{averageScore:99} },
      { id:'new', results:[current], summary:{averageScore:70} },
      { id:'other', results:[{scenarioId:'DE-CN-001'}], summary:{averageScore:80} },
    ];
    const before = JSON.stringify(runs);
    const {eligible,excluded}=partitionReferenceAnswerRuns(runs);
    expect(eligible.map(r=>r.id)).toEqual(['new','other']);expect(excluded.map(r=>r.runId)).toEqual(['mixed','old']);
    expect(JSON.stringify(runs)).toBe(before);
  });
  it.each(['RM-CN-013','RM-CN-014','RM-CN-028','RM-CN-031'])('admits only the verified restored version of %s', scenarioId => {
    const restored = {...current, scenarioId, scenarioVersion:'3.2.0'};
    for (const graderVersion of ['exact_answer_v4','exact_answer_line@exact_answer_v4']) {
      expect(referenceAnswerWarnings([{...restored,graderVersion}])).toEqual([]);
    }
    for (const scenarioVersion of [undefined,'2.0.0','3.0.0','3.1.0']) {
      expect(referenceAnswerWarnings([{...restored,scenarioVersion}])).toHaveLength(1);
    }
    expect(referenceAnswerWarnings([{...restored,graderVersion:old.graderVersion}])).toHaveLength(1);
    const mixed={id:'mixed',results:[restored,{...restored,scenarioVersion:'3.0.0'}]};
    const before=JSON.stringify(mixed);
    expect(partitionReferenceAnswerRuns([mixed,{id:'restored',results:[restored]}]).eligible.map(r=>r.id)).toEqual(['restored']);
    expect(JSON.stringify(mixed)).toBe(before);
  });
  it('marks old history as non-comparable without classifying it as an environment or model failure', () => {
    const q = analyzeRunQuality([{...old,totalScore:100,judgeScore:null,deterministicScore:100,modelOutput:'ANSWER: 442717元',outputMetadata:'{}'}],1);
    expect(q).toMatchObject({grade:'critical',scoringComplete:false,referenceAnswerIssueCount:1,environmentErrorCount:0});
  });
  it('inventory script reads a SQLite fixture without changing bytes or including model/API secrets', async () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dir=mkdtempSync(join(tmpdir(),'zx-reference-review-')), dbPath=join(dir,'test.db');
    try {
      const db=new DatabaseSync(dbPath);
      db.exec('CREATE TABLE ScenarioResult(id TEXT, evalRunId TEXT, scenarioId TEXT, scenarioVersion TEXT, graderVersion TEXT, modelOutput TEXT)');
      const insert=db.prepare('INSERT INTO ScenarioResult VALUES(?,?,?,?,?,?)');
      for(const [id,row] of [['old',old],['new',current]] as const) insert.run(id,id,row.scenarioId,row.scenarioVersion,row.graderVersion,'private answer');
      db.close();const before=readFileSync(dbPath);
      const output=execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/audit-reference-results.mjs',import.meta.url)),dbPath],{encoding:'utf8'});
      const result=JSON.parse(output);expect(result).toMatchObject({scannedMathRows:2,affectedRows:1,affectedRuns:1});
      expect(result.rows[0].id).toBe('old');expect(output).not.toContain('private answer');expect(readFileSync(dbPath)).toEqual(before);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('export retains disputed definitions and uses the same hash contract and valid counts', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const dir=mkdtempSync(join(tmpdir(),'zx-reference-export-')), dbPath=join(dir,'test.db'), out=join(dir,'output');
    try {
      const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE ScenarioDefinition(id TEXT, dimension TEXT, status TEXT, requirements TEXT)');
      const insert=db.prepare('INSERT INTO ScenarioDefinition VALUES(?,?,?,?)');
      for(const [id,status] of [['valid','valid'],['disputed','ambiguous'],['retired','retired']]) insert.run(id,'reasoning_math',status,'{"answer":1}');
      db.close();const before=readFileSync(dbPath);
      execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/export-scenarios.mjs',import.meta.url))],{env:{...process.env,ZXBENCH_DB_PATH:dbPath,ZXBENCH_EXPORT_DIR:out},stdio:'pipe'});
      const exported=JSON.parse(readFileSync(join(out,'benchmark.json'),'utf8'));
      expect(exported.map((s:any)=>s.id)).toEqual(['disputed','valid']);
      for(const s of exported)expect(s.scenarioHash).toBe(hashScenarioShort(s));
      const metadata=JSON.parse(readFileSync(join(out,'benchmark-meta.json'),'utf8'));
      expect(metadata).toMatchObject({count:1,ambiguousCount:1,reviewCount:1,retiredCount:1,totalCount:3,dimensions:{reasoning_math:1}});
      expect(readFileSync(dbPath)).toEqual(before);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

// Exercise the actual route using a read-only Prisma stub, including summary and
// best-of-run branches. No server listener, database or model API is started.
vi.mock('../../../apps/server/src/index.js',()=>({prisma:{
  evalRun:{findMany:vi.fn()}, scenarioResult:{findMany:vi.fn()},
  scenarioDefinition:{findMany:vi.fn(),count:vi.fn().mockResolvedValue(1)},
}}));
vi.mock('../../../apps/server/src/ws/index.js',()=>({broadcastProgress:vi.fn(),getLatestProgress:vi.fn()}));
describe('leaderboard API reference isolation', () => {
  it.each(['latest','best'].flatMap(scope=>[false,true].map(restored=>({scope,restored}))))('$scope leaderboard handles restored=$restored without admitting old results', async ({scope,restored}) => {
    const { prisma } = await import('../../../apps/server/src/index.js');
    const { registerRoutes } = await import('../../../apps/server/src/routes/index.js');
    const model={id:'m',name:'model',provider:'local',reasoningModel:false};
    const run=(id:string,row:typeof current,score:number)=>({id,modelConfigId:'m',modelConfig:model,config:'{}',dimensionFilter:'["reasoning_math"]',summary:JSON.stringify({averageScore:score,dimensionAverages:{reasoning_math:score}}),createdAt:new Date(),results:[row]});
    const newRow=restored?{...current,scenarioId:'RM-CN-031',scenarioVersion:'3.2.0'}:current;
    const oldRow=restored?{...newRow,scenarioVersion:'3.0.0'}:old;
    vi.mocked(prisma.evalRun.findMany).mockResolvedValue([run('old',oldRow,100),run('new',newRow,70)] as any);
    vi.mocked(prisma.scenarioDefinition.findMany).mockResolvedValue([{id:newRow.scenarioId,dimension:'reasoning_math',category:'financial_calc',difficulty:'hard',status:'valid'}] as any);
    vi.mocked(prisma.scenarioResult.findMany).mockImplementation(async (args:any)=>{
      expect(args.where.evalRunId.in).toEqual(['new']);
      return [{...newRow,dimension:'reasoning_math',totalScore:70,safetyLevel:'safe',formatParseSuccess:true,outputMetadata:'{}',environmentError:false}] as any;
    });
    const handlers=new Map<string,Function>();
    const app:any={get:(path:string,handler:Function)=>handlers.set(path,handler),post:vi.fn(),patch:vi.fn(),delete:vi.fn(),put:vi.fn(),addHook:vi.fn()};
    await registerRoutes(app);
    const response=await handlers.get('/api/leaderboard')!({query:{scope}});
    expect(response.excludedRuns.map((r:any)=>r.runId)).toEqual(['old']);
    expect(response.data).toHaveLength(1);expect(response.data[0].averageScore).toBe(70);
  });
});
