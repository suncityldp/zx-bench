import { selectReleasedPack } from './releasedBenchmark.js';
import type { BenchmarkPack, Difficulty, EvalRunConfig, Scenario } from '@zxbench/types';
import { decodeScenario } from './evaluationSnapshot.js';

export class ScenarioSelectionError extends Error {}

const dimensions = ['program', 'reasoning_math', 'safety_authority', 'cli_deep_tasks', 'data_extraction', 'agent_workflow', 'instruction_following', 'tool_cli_workflow', 'agent_loop', 'hallucination_resistance', 'structured_output'];
const difficulties = ['easy', 'medium', 'hard', 'adversarial'];
const specialPacks = ['default', 'migration-189'];
function enumList(value: unknown, allowed: string[], name: string): void {
  if (value == null) return;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !allowed.includes(v))) throw new ScenarioSelectionError(`Invalid ${name}`);
}

/** The same persisted selection configuration is used by preview, single and batch. */
export function selectionConfig(config: EvalRunConfig, request: { scenarioIds?: string[]; difficultyIds?: Difficulty[]; dimensionIds?: string[] }): EvalRunConfig {
  const result = { ...config };
  if (request.scenarioIds !== undefined) result.scenarioIds = request.scenarioIds;
  if (request.difficultyIds !== undefined) result.difficultyFilter = request.difficultyIds;
  if (request.dimensionIds !== undefined) result.dimensionFilter = request.dimensionIds;
  enumList(result.dimensionFilter, dimensions, 'dimensionIds');
  enumList(result.difficultyFilter, difficulties, 'difficultyIds');
  if (result.specialPack && result.specialPack !== 'default') {
    // Fixed groups ignore optional filters all the way through worker recovery.
    result.dimensionFilter = [];
    result.difficultyFilter = [];
    result.runsPerQuestion = 1;
    result.judgeEnabled = false;
    result.escalationEnabled = false;
    result.structuredOutputEnabled = false;
  }
  return result;
}

export function selectScenarioPack(rows: Parameters<typeof decodeScenario>[0][], config: EvalRunConfig, now = Date.now()): BenchmarkPack {
  enumList(config.dimensionFilter, dimensions, 'dimensionIds');
  enumList(config.difficultyFilter, difficulties, 'difficultyIds');
  if (config.scenarioIds != null && (!Array.isArray(config.scenarioIds) || config.scenarioIds.some(id => typeof id !== 'string' || !id))) throw new ScenarioSelectionError('Invalid scenarioIds');
  if (config.evaluationMode && !['development', 'official'].includes(config.evaluationMode)) throw new ScenarioSelectionError('Invalid evaluationMode');
  if (!Number.isInteger(config.runsPerQuestion) || config.runsPerQuestion < 1 || config.runsPerQuestion > 10) throw new ScenarioSelectionError('runsPerQuestion must be an integer between 1 and 10');
  if (config.judgeEnsembleRuns != null && (!Number.isInteger(config.judgeEnsembleRuns) || config.judgeEnsembleRuns < 1 || config.judgeEnsembleRuns > 10)) throw new ScenarioSelectionError('judgeEnsembleRuns must be an integer between 1 and 10');
  if (config.parallelMode && !['global', 'per_dimension'].includes(config.parallelMode)) throw new ScenarioSelectionError('Invalid parallelMode');
  if (config.constraints?.visibleRationale && !['auto', 'forbidden', 'required'].includes(config.constraints.visibleRationale)) throw new ScenarioSelectionError('Invalid visibleRationale');
  if (config.constraints?.onLimit && !['fail', 'degrade', 'flag'].includes(config.constraints.onLimit)) throw new ScenarioSelectionError('Invalid onLimit');
  const special = config.specialPack ?? 'default';
  if (!specialPacks.includes(special)) throw new ScenarioSelectionError('Invalid specialPack');
  try { return selectReleasedPack(rows,config,config.dimensionFilter); }
  catch (error) { throw new ScenarioSelectionError(error instanceof Error ? error.message : String(error)); }
}
