import {beforeEach,describe,it,expect,vi} from 'vitest';
import type {JudgeInput,ModelConfig,ModelResponse} from '@zxbench/types';
import {callModel} from '../model/caller.js';
import {runTieredJudge,runJudgeEnsemble} from './index.js';
import {judgeProvenance,validateScoreEvidence} from './integrity.js';
vi.mock('../model/caller.js',()=>({callModel:vi.fn()}));
const input={questionId:'audit',dimension:'reasoning_math',task:'2×3',requirements:[],candidateAnswer:{},rawModelOutput:'2×3=5。\nANSWER: 6',outputMetadata:{truncated:false},judgeEvidenceContract:'criterion_evidence_v1'} as JudgeInput;
const options={localModel:{name:'judge',defaultParams:{maxTokens:16000}} as ModelConfig,escalationThreshold:.85};
const valid={verdict:'partial',math_correctness:1,reasoning_validity:0,task_completeness:1,confidence:.95,score_evidence:{reasoning_validity:{kind:'assertion',quote:'2×3=5',explanation:'乘法等式错误，应为6'}}};
beforeEach(()=>vi.clearAllMocks());
const mock=(payload:unknown)=>vi.mocked(callModel).mockResolvedValue({content:JSON.stringify(payload),finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}} as ModelResponse);
describe('lineage and opt-in traceable deduction evidence',()=>{
  it('binds full input/prompt/candidate; no model credentials',()=>{
    const p=judgeProvenance(input,'s','u','r','judge');
    expect(p.inputHash).not.toBe(judgeProvenance({...input,expectedAnswer:7},'s','u','r','judge').inputHash);
    expect(p.candidateHash).not.toBe(judgeProvenance({...input,rawModelOutput:'changed'},'s','u','r','judge').candidateHash);
    expect(p.promptHash).not.toBe(judgeProvenance(input,'s','other','r','judge').promptHash);
  });
  it('persists valid evidence and invocation fingerprints',async()=>{
    mock(valid);const result=await runTieredJudge(input,options);
    expect(result.finalJudge.scoreEvidence?.reasoning_validity.quote).toBe('2×3=5');
    expect(result.finalJudge.provenance).toHaveLength(1);
    expect(vi.mocked(callModel).mock.calls[0][0].systemPrompt).toContain('score_evidence');
  });
  it('fails absent or fabricated deduction quotes without spending retry calls',async()=>{
    mock({...valid,score_evidence:{reasoning_validity:{kind:'assertion',quote:'没有ANSWER',explanation:'不在原文'}}});
    await expect(runTieredJudge(input,options)).rejects.toThrow('JUDGE_EVIDENCE_INVALID');
    expect(callModel).toHaveBeenCalledTimes(1);
  });
  it('requires evidence for missing required components, without fictional quotes',()=>{
    expect(()=>validateScoreEvidence(input,{...valid,score_evidence:{}})).toThrow('missing');
    expect(()=>validateScoreEvidence(input,{...valid,score_evidence:{reasoning_validity:{kind:'omission',quote:'made up',explanation:'missing'}}})).toThrow('omissions');
    expect(validateScoreEvidence(input,{...valid,score_evidence:{reasoning_validity:{kind:'omission',explanation:'required component absent'}}})).toBeDefined();
  });
  it('legacy Judge inputs do not silently acquire new grading requirements',async()=>{
    mock({...valid,score_evidence:undefined});
    expect((await runTieredJudge({...input,judgeEvidenceContract:undefined},options)).finalJudge.rootCause).toBe(0);
  });
  it('retains every invocation in an ensemble, not the first provenance only',async()=>{
    mock(valid);const r=await runJudgeEnsemble(input,options,3);
    expect(r.finalJudge.provenance).toHaveLength(3);expect(r.finalJudge.scoreEvidence).toBeUndefined();
  });
  it('shadow policy does not silently repair malformed JSON',async()=>{
    vi.mocked(callModel).mockResolvedValue({content:JSON.stringify(valid).slice(0,-1),finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}} as ModelResponse);
    await expect(runTieredJudge(input,options)).rejects.toThrow('JUDGE_INVALID_JSON');
    expect(callModel).toHaveBeenCalledTimes(2);
  });
});
