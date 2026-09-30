import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildEvidenceExam, gradePart as gradeEvidencePart, referenceOutput as evidenceReference } from './evidenceExam/index.js';
import { buildExamPaper as buildMathExpansion, referenceOutput as mathReference } from './examExpansion/index.js';
import { ULTRA_MATH_RUBRICS } from './ultraMathRubric.js';
import { ultraBatchPartEvaluator } from '../evaluators/ultraBatchPart.js';

const manifest=JSON.parse(readFileSync('data/scenarios/ultra-batch-release-manifest.json','utf8'));
const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
const archived=JSON.parse(readFileSync('data/scenarios/archive/benchmark-retired.json','utf8'));
const development=JSON.parse(readFileSync('data/scenarios/archive/benchmark-development.json','utf8'));
const historical=[...bank,...archived,...development];

describe('three-dimension ultra batch release',()=>{
  it('publishes twelve four-part groups in every target dimension',()=>{
    expect(manifest.structure).toMatchObject({dimensions:3,groupsPerDimension:12,partsPerGroup:4,groups:36,parts:144});
    expect(manifest.dimensions.reasoning_math.groups).toHaveLength(12);
    expect(manifest.dimensions.data_extraction.groups).toHaveLength(12);
    expect(manifest.dimensions.hallucination_resistance.groups).toHaveLength(12);
    expect(manifest.dimensions.reasoning_math.groups.map((x:{id:string})=>x.id)).not.toContain('MX3-06');
    expect(manifest.dimensions.reasoning_math.groups.map((x:{id:string})=>x.id)).not.toContain('MX3-12');
  });

  it('preserves original atomic-release fixtures in the active catalogue or retired archive',()=>{
    expect(manifest.defaultAtomicBank).toBe(true);
    for(const prefix of ['DX3-','HX3-'])expect(bank.filter((x:{id:string})=>x.id.startsWith(prefix))).toHaveLength(48);
    const selected=new Set(manifest.dimensions.reasoning_math.groups.map((x:{id:string})=>x.id));
    expect(historical.filter((x:{id:string})=>selected.has(x.id.replace(/-P[1-4]$/,'')))).toHaveLength(48);
  });

  it('binds every evidence group to a frozen executable paper and replays all references',()=>{
    const paper=buildEvidenceExam(),ids=new Set(paper.parts.map(x=>x.groupId));
    expect([...new Set(paper.parts.filter(x=>x.dimension==='data_extraction').map(x=>x.groupId))].sort()).toEqual([...manifest.dimensions.data_extraction.groups].sort());
    expect([...new Set(paper.parts.filter(x=>x.dimension==='hallucination_resistance').map(x=>x.groupId))].sort()).toEqual([...manifest.dimensions.hallucination_resistance.groups].sort());
    expect(ids.size).toBe(24);
    for(const part of paper.parts)expect(gradeEvidencePart(part,evidenceReference(part)).earned).toBe(part.points);
  });

  it('binds the selected math groups and keeps rejected capstones out',()=>{
    const entries=manifest.dimensions.reasoning_math.groups as {id:string;source:string}[],selected=entries.map(x=>x.id),expansion=buildMathExpansion();
    const expansionIds=new Set(expansion.parts.map(x=>x.groupId));
    const ultraIds=new Set(ULTRA_MATH_RUBRICS.map(x=>x.groupId));
    for(const id of selected)expect(expansionIds.has(id)||ultraIds.has(id as 'UMX-01'|'UMX-02')).toBe(true);
    // 2026-09-16：新增 MX3-13/14/15 三个题组后，题库里 MX3 条目的来源版本不再唯一
    // （冻结发布清单记录 v3，新题组为当前题包版本）。断言「所有来源版本都是已知版本」，
    // 而不是「只有一个版本」——后者会在任何题包版本升级时误报。
    const knownVersions=new Set<string>([
      ...entries.filter(x=>x.id.startsWith('MX3-')).map(x=>x.source),
      manifest.version,
      expansion.policy.version,
    ]);
    const bankMx3=new Set<string>(bank.filter((x:{id:string})=>/^MX3-/.test(x.id)).map((x:any)=>String(x.requirements?.sourcePackVersion)));
    for(const v of bankMx3)expect(knownVersions.has(v),v).toBe(true);
    // 2026-09-16 新增的高难度题组必须真实落入题库（而不是只存在于题包）
    for(const g of ['MX3-13','MX3-14','MX3-15','MX3-16','MX3-17','MX3-18','MX3-19','MX3-20','MX3-21','MX3-22','MX3-23','MX3-24'])for(let n=1;n<=4;n++){
      expect(historical.some((x:{id:string})=>x.id===`${g}-P${n}`),`${g}-P${n}`).toBe(true);
    }
  });

  it('gives full deterministic credit to every released executable reference',async()=>{
    const evidence=buildEvidenceExam();
    for(const part of evidence.parts){
      const result=await ultraBatchPartEvaluator.evaluate({id:part.id} as never,evidenceReference(part),{} as never);
      expect(result.totalScore).toBe(100);
    }
    const selected=manifest.dimensions.reasoning_math.groups.map((x:{id:string})=>x.id).filter((x:string)=>x.startsWith('MX3-'));
    const math=buildMathExpansion({groupIds:selected});
    for(const part of math.parts){
      const result=await ultraBatchPartEvaluator.evaluate({id:part.id} as never,mathReference(part),{} as never);
      expect(result.totalScore).toBe(100);
    }
  });

  it('does not serialize coordinator gold or explicit answer labels into model questions',()=>{
    const evidence=buildEvidenceExam(),selected=new Set(manifest.dimensions.reasoning_math.groups.map((x:{id:string})=>x.id));
    const questions=[...evidence.questions,...buildMathExpansion().questions.filter(x=>selected.has(x.id.replace(/-P[1-4]$/,'')))];
    for(const question of questions){
      const prompt=question.messages.map(x=>x.content).join('\n');
      expect(prompt).not.toMatch(/referenceAnswer|referenceOutput|正确答案|答案是|"expected"/i);
    }
  });
});
