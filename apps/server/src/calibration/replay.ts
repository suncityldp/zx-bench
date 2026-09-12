import { Worker } from 'node:worker_threads';
import type { CriterionResult, OutputMetadata, Scenario } from '@zxbench/types';

/** Legacy/user-authored regexes execute outside the API event loop and have a hard timeout. */
export function replayInstructionCriteria(scenario: Scenario, modelOutput: string, metadata: OutputMetadata, timeoutMs = 1500, fixtureEntry?: string): Promise<{ criteria: CriterionResult[]; version: string; issue?: string }> {
  return new Promise(resolve => {
    let settled = false;
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { instructionChecklistEvaluator: evaluator } = await import(workerData.entry);
        const result = await evaluator.evaluate(workerData.scenario, workerData.answer, workerData.metadata);
        parentPort.postMessage({ criteria: result.criterionResults || [], version: evaluator.version });
      })().catch(error => parentPort.postMessage({ criteria: [], version: 'unavailable', issue: String(error) }));
    `, { eval: true, workerData: { entry: fixtureEntry ?? import.meta.resolve('@zxbench/core'), scenario, answer: modelOutput, metadata } });
    const finish = (result: { criteria: CriterionResult[]; version: string; issue?: string }) => {
      if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(result);
    };
    const timer = setTimeout(() => finish({ criteria: [], version: 'unavailable', issue: `Rubric replay exceeded ${timeoutMs}ms; unmeasured` }), timeoutMs);
    worker.once('message', finish);
    worker.once('error', err => finish({ criteria: [], version: 'unavailable', issue: String(err) }));
    worker.once('exit', code => { if (!settled) finish({ criteria: [], version: 'unavailable', issue: `Rubric worker exited ${code} before a result` }); });
  });
}
