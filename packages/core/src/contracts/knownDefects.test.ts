import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@zxbench/types';
import { knownScenarioDefects } from './knownDefects.js';
import { checkScenarioEligibility } from './eligibility.js';
import { orchestrateEvaluation, type OrchestrateOptions } from '../orchestrator.js';
import { callModelWithRetry } from '../model/caller.js';
import { runWorldLoop } from '../execution/worldLoop.js';
vi.mock('../model/caller.js', async original => ({ ...await original<object>(), callModelWithRetry: vi.fn() }));
vi.mock('../execution/worldLoop.js', async original => ({ ...await original<object>(), runWorldLoop: vi.fn() }));
const bank = JSON.parse(readFileSync('packages/core/src/contracts/fixtures/known-bad-workflow.json', 'utf8')) as Scenario[];
const tasks = bank.filter(s => /^HA-CN-004-RECOVERY-[01]$/.test(s.id));

describe('confirmed benchmark defects stop generation before token spending', () => {
  it('blocks superseded permission and read-confirmation revisions', () => {
    const superseded=JSON.parse(readFileSync('packages/core/src/contracts/fixtures/superseded-workflow-contracts.json','utf8')) as Scenario[];
    expect(superseded).toHaveLength(18);
    for(const task of superseded){
      expect(knownScenarioDefects(task).length,task.id).toBeGreaterThan(0);
      expect(checkScenarioEligibility(task).eligible,task.id).toBe(false);
    }
  });
  it('quarantines both frozen defective instances even though they are in the released catalogue', () => {
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(knownScenarioDefects(task).join()).toContain('HA-CN-004_SEARCH_LANGUAGE');
      expect(checkScenarioEligibility(task).eligible).toBe(false);
    }
  });
  it('does not quarantine unrelated questions or a repaired search implementation', () => {
    expect(knownScenarioDefects({id:'unrelated',scenarioHash:'normal'} as Scenario)).toEqual([]);
    const repaired = structuredClone(tasks[0]);
    const world=(repaired.requirements as unknown as { executionWorld: { tools: Array<{name:string;script:string}> } }).executionWorld;
    world.tools.find(t=>t.name==='session_search')!.script="query=args['query'].casefold()\nif not any(term in query for term in ('network','网络')): raise ValueError('NO_MATCH')";
    expect(knownScenarioDefects(repaired)).toEqual([]);
  });
  it('blocks all reviewed defective frozen contracts, and keeps unaffected tasks eligible', () => {
    const audit = JSON.parse(readFileSync('packages/core/src/contracts/fixtures/confirmed-contract-defects.json', 'utf8'));
    const ids = new Set(audit.findings.flatMap((r: { instances: Array<{instanceId:string}> }) => r.instances.map(i=>i.instanceId)));
    expect(ids.size).toBe(25);
    for (const task of bank.filter(s=>s.dimension==='agent_workflow')) {
      expect(knownScenarioDefects(task).length > 0, task.id).toBe(ids.has(task.id));
    }
  });
  it('rejects direct evaluator calls before the model or tool loop starts', async () => {
    vi.clearAllMocks();
    await expect(orchestrateEvaluation({ scenario:tasks[0] } as OrchestrateOptions))
      .rejects.toThrow('KNOWN_BENCHMARK_DEFECT');
    expect(callModelWithRetry).not.toHaveBeenCalled();
    expect(runWorldLoop).not.toHaveBeenCalled();
  });
});
