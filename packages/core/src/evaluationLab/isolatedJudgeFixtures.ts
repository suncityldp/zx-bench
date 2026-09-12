import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {snapshotHash} from '../contracts/pack.js';
import {shuffle} from './methodsV2/types.js';
import type {AuditItem} from './atomicJudge.js';
import type {VerifiedFixture} from './verifiedAtomicJudge.js';
export const ISOLATED_JUDGE_VERSION='isolated-judge-context-2026-09-12-v1';
export const ISOLATED_INPUT_FILES=[
  'isolated-old-inputs.json',
  'isolated-bindings.json',
  'isolated-review.json',
  'isolated-holdout-pack.json',
  'isolated-submission.json',
  'isolated-grades.json'];
export function isolatedJudgeFixtures(_root?:string):VerifiedFixture[]{
  const [oldInputs,bindings,review,pack,sub,grades]=ISOLATED_INPUT_FILES.map(p=>JSON.parse(readFileSync(new URL(`./fixtures/${p}`,import.meta.url),'utf8')));
  assert.equal(review.decision,'stop');const all:VerifiedFixture[]=[];
  const dev=[['RA-474ff550509fdc','pass'],['RA-4e7b15a79821f0','pass'],['RA-a2c612e4211d2d','fail'],['RA-337a6cadc34c7c','fail']] as const;
  for(const [id,expected] of dev){
    const old=oldInputs.items.find((i:any)=>i.id===id),binding=bindings.find((b:any)=>b.id===id);assert(old&&binding);assert.equal(snapshotHash(old.candidate),binding.outputHash);
    const {dimension,sources,focus,candidate}=old,item:AuditItem={id,dimension,sources,focus,candidate};
    all.push({item,expected,split:'development',family:dimension==='reasoning_math'?'actual_partition_proof':'actual_source_admissibility',
      basis:dimension==='reasoning_math'?'P1 pieces 01/011 end in 1, contradicting the claimed all-end-in-0 premise; final classification remains correct.'
        :id==='RA-474ff550509fdc'?'D32 admits only D06, therefore refuted.':'D32 admits only D72 with sample-size information, therefore insufficient; unlisted D06/D66 cannot create conflict.',
      oracleEvidence:{origin:'unaltered_real_answer',outputHash:binding.outputHash,originalPublicItemHash:snapshotHash(old),binding}});
  }
  const flip:Record<string,string>={supported:'insufficient',insufficient:'refuted',refuted:'conflict',conflict:'supported'};
  for(const c of pack.cases.filter((c:any)=>c.kind==='evidence')){
    const answer=sub.answers.find((a:any)=>a.id===c.id),grade=grades.rows.find((g:any)=>g.id===c.id);assert(answer?.outcome==='completed');assert.equal(answer.questionHash,c.question.questionHash);
    assert.equal(snapshotHash(answer.output),grade.outputHash);const parsed=JSON.parse(answer.output);assert.equal(parsed.status,c.gold.status);
    const prompt=c.question.messages[0].content,first=prompt.indexOf('\n\n[D');assert(first>0);
    const focus='核对证据状态结论和附加解释，依据下列完整规则与命题。只输出JSON的格式和sources数组是否完整由程序单列，本审查不因单纯漏引编号判fail；但使用不合格证据得出的错误结论属于实质错误。\n'+prompt.slice(0,first);
    for(const correct of [true,false]){
      const candidate=correct?answer.output:JSON.stringify({...parsed,status:flip[parsed.status]});
      const item:AuditItem={id:'ISO-'+snapshotHash({questionHash:c.question.questionHash,candidate}).slice(0,14),dimension:'hallucination_resistance',sources:c.documents,focus,candidate};
      all.push({item,expected:correct?'pass':'fail',split:'holdout',family:'heldout_temporal_validity',basis:`Question's admissible temporal evidence state is ${c.gold.status}; candidate ${correct?'matches':'changes only the status away from it'}.`,
        oracleEvidence:{origin:correct?'unaltered_real_answer':'authored_status_mutation_not_model_answer',questionId:c.id,questionHash:c.question.questionHash,originalOutputHash:grade.outputHash,expectedState:c.gold.status}});
    }
  }
  assert.equal(all.length,12);
  return [...all.filter(f=>f.split==='development'),...shuffle(all.filter(f=>f.split==='holdout'),20260912)];
}
