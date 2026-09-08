import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateEvaluation } from './orchestrator.js';
import { callModelWithRetry } from './model/caller.js';
import { runTieredJudge } from './judge/index.js';
import { registerEvaluator } from './evaluators/index.js';
import { exactAnswerLineEvaluator } from './evaluators/exactAnswerLine.js';
import { hallucinationResistanceEvaluator } from './evaluators/hallucinationResistance.js';
vi.mock('./model/caller.js', () => ({ callModelWithRetry: vi.fn() }));
vi.mock('./judge/index.js', async importOriginal => ({ ...await importOriginal<typeof import('./judge/index.js')>(), runTieredJudge: vi.fn() }));
describe('wrong math answers cannot activate Judge format rescue', () => {
  it('keeps a long but numerically wrong answer below the pass threshold even if Judge awards full marks', async () => {
    registerEvaluator(exactAnswerLineEvaluator);
    const scenario=JSON.parse(readFileSync(new URL('../../../data/scenarios/benchmark.json',import.meta.url),'utf8')).find((s:any)=>s.id==='RM-CN-004');
    vi.mocked(callModelWithRetry).mockResolvedValue({content:'下面是详细的推导过程。'.repeat(20)+'\nANSWER: 442717元',finishReason:'stop',usage:{inputTokens:100,outputTokens:200},latencyMs:10} as any);
    const judge={bugDetection:1,rootCause:1,patchCorrectness:1,scopeDiscipline:1,outputCompleteness:1,confidence:1};
    vi.mocked(runTieredJudge).mockResolvedValue({localJudge:judge,finalJudge:judge,escalated:false} as any);
    const result=await orchestrateEvaluation({scenario,modelConfig:{id:'test',name:'test',provider:'local',baseUrl:'http://unused',defaultParams:{}},modelParams:{maxTokens:8192},evalConfig:{judgeEnabled:true},judgeOptions:{localModel:{id:'judge'}}} as any);
    expect(runTieredJudge).toHaveBeenCalled();
    expect(vi.mocked(runTieredJudge).mock.calls[0][0].formatBlindspot).toBe(false);
    expect(result.axisScores.answer_accuracy).toBe(0);
    expect(result.totalScore).toBeLessThan(60);
  });
});

describe('reviewed scoring through the real orchestrator',()=>{
 it.each([
  ['FR-005','300000米/秒',1,0,false],
  ['FR-005','约三十万千米每秒。',0,100,false],
  ['UB-023','没有可靠证据证明人类已经与外星文明正式接触。',1,100,false],
  ['UB-023','没有可靠证据证明人类已经与外星文明正式接触。',null,0,true],
  ['CI-069','DOI:10.1234/fake，仅供参考',0,0,false],
  ['RM-CN-025','STEPS: 狼,空,羊,空,白菜,空,羊\nANSWER: 7次',1,0,false],
 ])('%s %s with Judge=%s',async(id,output,judgeScore,expected,unavailable)=>{
  registerEvaluator(exactAnswerLineEvaluator);registerEvaluator(hallucinationResistanceEvaluator);
  const bank=JSON.parse(readFileSync(new URL('../../../data/scenarios/benchmark.json',import.meta.url),'utf8'));
  vi.mocked(callModelWithRetry).mockResolvedValue({content:output,finishReason:'stop',usage:{inputTokens:10,outputTokens:30},latencyMs:1} as any);
  const j={bugDetection:judgeScore,rootCause:judgeScore,patchCorrectness:judgeScore,scopeDiscipline:judgeScore,outputCompleteness:judgeScore,factuality:judgeScore,confidence:1,verdict:judgeScore?'correct':'incorrect'};
  vi.mocked(runTieredJudge).mockResolvedValue({localJudge:j,finalJudge:j,escalated:false} as any);
  const r=await orchestrateEvaluation({scenario:bank.find((s:any)=>s.id===id),modelConfig:{id:'mock',name:'mock',provider:'local',baseUrl:'http://unused',defaultParams:{}},modelParams:{maxTokens:8192},evalConfig:{judgeEnabled:judgeScore!==null},judgeOptions:{localModel:{id:'judge'}}} as any);
  expect(r.totalScore).toBe(expected);expect(r.environmentError).toBe(unavailable);
 });
});
