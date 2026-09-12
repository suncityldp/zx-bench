import {describe,it,expect} from 'vitest';
import {buildChallengePack,candidateQuestion,gradeChallenge,referenceAnswer} from './challengePack.js';
import {buildRebalancedEvidenceChallenges} from './challengeRebalance.js';
import type {EvidenceCase} from './challengeTypes.js';
import {readFileSync} from 'node:fs';

const cases=buildRebalancedEvidenceChallenges();
const item=(id:string)=>cases.find(c=>c.id===id)!;
const answer=(c:EvidenceCase)=>referenceAnswer(c) as Record<string,{value:unknown;status:string;sources:string[]}>;
describe('citation rubric v2 separates support, relevance and factual correctness',()=>{
 it('keeps all twenty public prompts, facts and answer/status gold unchanged from v1.2.2',()=>{
  const frozen=JSON.parse(readFileSync(new URL('./fixtures/challenge-pack-v1.2.2.json',import.meta.url),'utf8'));
  for(const c of buildChallengePack().cases){const old=frozen.cases.find((x:EvidenceCase)=>x.id===c.id);
   expect(candidateQuestion(c)).toEqual(candidateQuestion(old));
   if(c.dimension==='hallucination_resistance')for(const f of c.fields){const before=old.fields.find((x:{id:string})=>x.id===f.id);expect(f.expected.value).toEqual(before.expected.value);expect(f.expected.status).toBe(before.expected.status);}
  }
 });
 it('accepts research-directory context without penalizing a correct evidence chain',()=>{
  const c=item('HC3-001'),a=answer(c);a.r17_tested_repair.sources=['D1','D2'];
  expect(gradeChallenge(c,JSON.stringify(a))).toMatchObject({strictPass:true,answerPass:true,evidencePass:true});
 });
 it('accepts the scan caveat when the full vulnerability chain is already present',()=>{
  const c=item('HC2-005'),a=answer(c);a.c_affected.sources=['D1','D2','D3','D4','D5','D6'];
  expect(gradeChallenge(c,JSON.stringify(a)).strictPass).toBe(true);
 });
 it('preserves failure for a missing randomized-design source',()=>{
  const c=item('HC3-002'),a=answer(c);a.reminder_finding.sources=['D3'];const g=gradeChallenge(c,JSON.stringify(a));
  expect(g).toMatchObject({strictPass:false,answerPass:true,evidencePass:false});
  expect(g.citationDiagnostics?.find(d=>d.field==='reminder_finding')).toMatchObject({valid:true,sufficient:false,relevant:true});
 });
 it('distinguishes unrelated real citations from missing evidence and wrong facts',()=>{
  const c=item('HC3-001'),a=answer(c);a.r17_tested_repair.sources=['D1','D7'];const g=gradeChallenge(c,JSON.stringify(a));
  expect(g).toMatchObject({strictPass:false,answerPass:true,evidencePass:true});
  expect(g.citationDiagnostics?.[0]).toMatchObject({valid:true,sufficient:true,relevant:false,unsupportedSources:['D7']});
 });
 it.each([['D1','D999'],['D1','D1'],[],['D1','D2','D3','D4','D5','D6','D7']])('invalid citations cannot certify support: %j',(...sources)=>{
  const c=item('HC3-001'),a=answer(c);a.r17_tested_repair.sources=sources as string[];
  expect(gradeChallenge(c,JSON.stringify(a))).toMatchObject({strictPass:false,evidencePass:false});
 });
 it('keeps incorrect conclusions and incomplete answers from passing diagnostic aggregates',()=>{
  const c=item('HC3-001'),a=answer(c);a.r17_tested_repair.value=true;
  expect(gradeChallenge(c,JSON.stringify(a))).toMatchObject({strictPass:false,answerPass:false,evidencePass:false});
  expect(gradeChallenge(c,JSON.stringify(answer(c)),false)).toMatchObject({strictPass:false,answerPass:false,evidencePass:false});
 });
 it('does not change grading semantics when loading an older case without the new policy',()=>{
  const c=structuredClone(item('HC3-001'));delete c.citationPolicy;c.fields[0].allowedSources=['D1'];
  const a=answer(c);a.r17_tested_repair.sources=['D1','D2'];const g=gradeChallenge(c,JSON.stringify(a));
  expect(g.strictPass).toBe(false);expect(g.citationDiagnostics).toBeUndefined();
 });
});
