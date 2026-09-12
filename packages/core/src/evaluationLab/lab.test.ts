import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario } from '@zxbench/types';
import { evaluateTypedMath, legacyMathShadowContract, simulateFlowShop, solveFlowShop, verifyFlowShop } from './typedMath.js';
import { buildReliabilityPilot, verifyPilotCase, verifyPilotMath } from './pilot.js';
import { buildJudgeFixtures, qualificationRequest, summarizeJudgeQualification, type JudgeObservation } from './qualification.js';
import { summarizeReliability, summarizeAnswerability, type TrialEvent } from './reliability.js';
const bank:Scenario[]=JSON.parse(readFileSync(new URL('../../../../data/scenarios/benchmark.json',import.meta.url),'utf8'));
const contract=(id:string)=>legacyMathShadowContract(bank.find(s=>s.id===id)!)!;

describe('versioned typed math shadow',()=>{
  it.each([
    ['RM-CN-011','ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=[17.00]km'],
    ['RM-CN-011','ANSWER: 路线=仓库→A→B→C→D→E→仓库，总距离=17km'],
    ['RM-CN-012','ANSWER: 顺序=[J3,J1,J4,J2,J5]，最短完工时间=[23]小时'],
    ['RM-CN-018','ANSWER: 平均[79.50]，中位数[82.00]，众数[85]，极差[33]，方差[98.05]'],
  ])('accepts equivalent actual regression %s', (id,answer)=>expect(evaluateTypedMath(contract(id),answer).totalScore).toBe(100));
  it.each([
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=[18]km',
    'ANSWER: 路线=[仓库,A,C,B,D,E,仓库]，总距离=17km',
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=17m',
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=17km 或18km',
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=17km，总距离=18km',
    'ANSWER: 路线=[[仓库,A,B,C,D,E,仓库]]，总距离=17km',
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=17.00001km',
    'ANSWER: 路线=[仓库,A,B,C,D,E,仓库]，总距离=17km\n解释',
  ])('rejects close wrong answers without fuzzy scoring %s',answer=>expect(evaluateTypedMath(contract('RM-CN-011'),answer).totalScore).toBe(0));
  it('reports fields separately, not arbitrary blended partial credit',()=>{
    const r=evaluateTypedMath(contract('RM-CN-018'),'ANSWER: 平均79.5，中位数82，众数85，极差33，方差98.06');
    expect(r.totalScore).toBe(0);expect(r.axisScores?.answer_accuracy).toBe(80);
  });
  it('does not claim a truncated response is strictly solved',()=>expect(evaluateTypedMath(contract('RM-CN-018'),'ANSWER: 平均79.5，中位数82，众数85，极差33，方差98.05',{truncated:true}).totalScore).toBe(0));
  it('guards migration against reference mismatch',()=>{
    const s=bank.find(s=>s.id==='RM-CN-011')!;
    expect(legacyMathShadowContract({...s,requirements:{answer:'changed'} as any})).toBeNull();
  });
  it.each(['1,000.00','[1000]','1e3'])('accepts legal exact scalar %s',value=>expect(evaluateTypedMath({version:1,fields:[{id:'x',label:'x',separator:'=',kind:'decimal',expected:'1000'}]},`ANSWER: x=${value}`).totalScore).toBe(100));
  it.each(['10,00','1,00,0','1000.00001','[1000]]','NaN','1000或999'])('rejects malformed scalar %s',value=>expect(evaluateTypedMath({version:1,fields:[{id:'x',label:'x',separator:'=',kind:'decimal',expected:'1000'}]},`ANSWER: x=${value}`).totalScore).toBe(0));
});

describe('bounded independent construction oracle',()=>{
  const jobs=[{id:'J1',first:3,second:6},{id:'J2',first:5,second:2},{id:'J3',first:1,second:2},{id:'J4',first:6,second:4},{id:'J5',first:7,second:1}];
  it('independently confirms original optimum 23',()=>expect(solveFlowShop(jobs).minimum).toBe(23));
  it('accepts optimal alternative sequences, rejects false time/invalid visit',()=>{
    const equal=[{id:'A',first:1,second:1},{id:'B',first:1,second:1}];
    for(const order of ['A,B','B,A'])expect(verifyFlowShop(equal,`ANSWER: 顺序=[${order}]，最短完工时间=3小时`).strictPass).toBe(true);
    expect(verifyFlowShop(equal,'ANSWER: 顺序=[A,B]，最短完工时间=2小时').strictPass).toBe(false);
    expect(verifyFlowShop(equal,'ANSWER: 顺序=[A,B，最短完工时间=3小时').strictPass).toBe(false);
    expect(verifyFlowShop(equal,'ANSWER: 顺序=A-B]，最短完工时间=3小时').strictPass).toBe(false);
    expect(simulateFlowShop(equal,['A','A'])).toBeNull();
  });
});

describe('isolated reproducible pilot and Judge qualification',()=>{
  const pilot=buildReliabilityPilot();
  it('freezes a deterministic unreviewed public-development package',()=>{
    expect(pilot.hash).toBe(buildReliabilityPilot().hash);expect(pilot.cases).toHaveLength(20);
    expect(pilot.reviewStatus).toBe('unreviewed');expect(new Set(pilot.cases.map(c=>c.id)).size).toBe(20);
    for(const c of pilot.cases)verifyPilotCase(c);
    expect(()=>verifyPilotCase({...pilot.cases[0],prompt:'tampered'})).toThrow('hash');
  });
  for(const c of pilot.cases.filter(c=>c.dimension==='reasoning_math'))it(`reference passes independent executable check: ${c.id}`,()=>expect(verifyPilotMath(c,c.reference)).toBe(true));
  it('independently checks statistical formula rather than trusting fixture gold',()=>{
    for(const c of pilot.cases.filter(c=>c.family==='math-statistics')) {
      const xs=[c.seed,c.seed+2,c.seed+4,c.seed+6];const mean=xs.reduce((a,b)=>a+b)/xs.length;
      const variance=xs.reduce((sum,x)=>sum+(x-mean)**2,0)/xs.length;
      expect(verifyPilotMath(c,`ANSWER: 平均=${mean}，方差=${variance}`)).toBe(true);
    }
  });
  it('no observations means no Judge certification and null error rates',()=>{
    const q=summarizeJudgeQualification(buildJudgeFixtures(),[]);
    expect(q.coverage).toBe(0);expect(q.status).toBe('not_qualified');expect(q.falsePassRate).toBeNull();
  });
  it('rejects mixed, duplicate, stale and fabricated evidence observations',()=>{
    const fixtures=buildJudgeFixtures(),f=fixtures[0];
    const obs:JudgeObservation={fixtureId:f.id,inputHash:f.inputHash,judgeIdentity:'judge-config-v1',promptHash:qualificationRequest(f).promptHash,response:{verdict:'incorrect',confidence:.9,rubric_scores:{answer:0,evidence:1,boundaries:1},critical_error:false,score_evidence:{answer:{kind:'assertion',quote:'不存在的原文',explanation:'错误'}}}};
    expect(summarizeJudgeQualification(fixtures,[obs]).measured).toBe(0);
    expect(summarizeJudgeQualification(fixtures,[obs]).issues.some(i=>i.includes('quote not in candidate'))).toBe(true);
    expect(()=>summarizeJudgeQualification(fixtures,[obs,obs])).toThrow('Duplicate');
    expect(summarizeJudgeQualification(fixtures,[{...obs,inputHash:'bad'}]).issues.some(i=>i.includes('lineage'))).toBe(true);
  });
  it('never claims independent human qualification from synthetic full-pass observations',()=>{
    const fixtures=buildJudgeFixtures();
    const observations=fixtures.map(f=>({fixtureId:f.id,inputHash:f.inputHash,promptHash:qualificationRequest(f).promptHash,judgeIdentity:'mock-unit-test-only',
      response:{verdict:Object.values(f.expected).every(v=>v===1)?'correct':'partial',confidence:.9,critical_error:false,
        ...(f.input.dimension==='reasoning_math'?f.expected:{rubric_scores:f.expected}),
        score_evidence:Object.fromEntries(Object.entries(f.expected).filter(([,v])=>v===0).map(([id])=>[id,{kind:'assertion',quote:f.input.rawModelOutput!,explanation:'Fixture test only; not a real Judge'}]))}}));
    const q=summarizeJudgeQualification(fixtures,observations);
    expect(q.coverage).toBe(1);expect(q.falsePassRate).toBe(0);expect(q.falseFailRate).toBe(0);
    expect(q.status).toBe('fixture_passed_needs_independent_human_calibration');
  });
  it('all-full-score Judge is rejected for letting injected errors through',()=>{
    const fixtures=buildJudgeFixtures();
    const observations=fixtures.map(f=>({fixtureId:f.id,inputHash:f.inputHash,promptHash:qualificationRequest(f).promptHash,judgeIdentity:'always-pass-mock',
      response:{verdict:'correct',confidence:.9,critical_error:false,
        ...(f.input.dimension==='reasoning_math'?Object.fromEntries(Object.keys(f.expected).map(id=>[id,1])):{rubric_scores:{answer:1,evidence:1,boundaries:1}}),score_evidence:{}}}));
    const q=summarizeJudgeQualification(fixtures,observations);expect(q.falsePassRate).toBe(1);expect(q.status).toBe('not_qualified');
  });
});

describe('reliability accounting',()=>{
  const plan=[{scenarioId:'a',family:'f',trials:3}];
  const event=(id:string,trial:number,strictPass:boolean|null):TrialEvent=>({id,scenarioId:'a',trial,strictPass,kind:'independent',protocolHash:'a'.repeat(64),candidateHash:id,environmentError:false,modelMs:100,judgeMs:10,outputTokens:50});
  it('counts repeated failures, never best-of',()=>{
    const r=summarizeReliability(plan,[event('a1',1,true),event('a2',2,false),event('a3',3,true)]);
    expect(r.measuredSuccessRate).toBe(2/3);expect(r.allTrialsPassedRate).toBe(0);expect(r.modelMsPerDeliveredSuccess).toBe(150);
  });
  it('does not hide missing trials and zero successes',()=>{
    const r=summarizeReliability(plan,[event('a1',1,null)]);
    expect(r.measuredSuccessRate).toBeNull();expect(r.deliveredSuccessRate).toBe(0);expect(r.modelMsPerDeliveredSuccess).toBeNull();
  });
  it('rejects mixed experiment budgets/identities',()=>expect(()=>summarizeReliability(plan,[event('a1',1,true),{...event('a2',2,true),protocolHash:'b'.repeat(64)}])).toThrow('Mixed'));
  it('supports explicit infrastructure replacement plus same-answer Judge-only',()=>{
    const bad={...event('a1',1,null),environmentError:true};
    const retry={...event('a2',1,null),kind:'replacement' as const,replaces:'a1'};
    const judge={...event('a3',1,true),kind:'judge_only' as const,replaces:'a2',candidateHash:'a2',modelMs:0,outputTokens:0};
    const r=summarizeReliability(plan,[bad,retry,judge]);expect(r.passed).toBe(1);expect(r.totalModelMs).toBe(200);expect(r.totalJudgeMs).toBe(30);
    expect(()=>summarizeReliability(plan,[event('a1',1,false),retry])).toThrow('valid model failure');
    expect(()=>summarizeReliability(plan,[bad,retry,{...judge,candidateHash:'other'}])).toThrow('Judge-only');
  });
  it('does not award a paired success for a missing condition',()=>{
    const r=summarizeAnswerability([{scenarioId:'a',family:'f',condition:'sufficient',correct:true,refused:false,unsupportedAssertion:false}]);
    expect(r.pairedAllPassedRate).toBe(0);
  });
});
