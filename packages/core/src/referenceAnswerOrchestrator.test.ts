import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateEvaluation } from './orchestrator.js';
import { callModelWithRetry } from './model/caller.js';
import { runTieredJudge } from './judge/index.js';
import { registerEvaluator } from './evaluators/index.js';
import { exactAnswerLineEvaluator } from './evaluators/exactAnswerLine.js';
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
