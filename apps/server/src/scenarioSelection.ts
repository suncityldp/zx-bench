import fs from 'node:fs';
import type { BenchmarkPack, Difficulty, EvalRunConfig, Scenario } from '@zxbench/types';
import { createBenchmarkPack } from '@zxbench/core';
import { decodeScenario } from './evaluationSnapshot.js';

export class ScenarioSelectionError extends Error {}

const dimensions = ['program', 'reasoning_math', 'safety_authority', 'cli_deep_tasks', 'data_extraction', 'agent_workflow', 'instruction_following', 'tool_cli_workflow', 'agent_loop', 'hallucination_resistance', 'structured_output'];
const difficulties = ['easy', 'medium', 'hard', 'adversarial'];
const specialPacks = ['default', 'mixed', 'all', 'migration-189'];
function releasedCatalogue(): Scenario[] {
  return JSON.parse(fs.readFileSync(new URL('../../../data/scenarios/benchmark.json', import.meta.url), 'utf8'));
}
function migrationHashes(): Map<string, string> {
  const plan = JSON.parse(fs.readFileSync(new URL('../../../data/execution/migration-plan.json', import.meta.url), 'utf8'));
  const hashes = new Map<string, string>(plan.migrationTasks.map((t: { taskId: string; scenarioHash: string }) => [t.taskId, t.scenarioHash]));
  if (plan.taskCount !== 306 || hashes.size !== 306) throw new ScenarioSelectionError('Invalid frozen migration plan');
  return hashes;
}

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
  if (special !== 'default' && config.evaluationMode === 'official') throw new ScenarioSelectionError('Special packs require development mode');
  let selected = rows.filter(s => s.status === 'valid').map(decodeScenario);
  if (special !== 'default') {
    if (config.scenarioIds?.length) throw new ScenarioSelectionError('Special packs use their fixed catalogue, not custom scenarioIds');
    if (special === 'migration-189') {
      const hashes = migrationHashes();
      selected = selected.filter(s => hashes.has(s.id));
      if (hashes.size !== 306 || selected.length !== 306) throw new ScenarioSelectionError(`Migration pack incomplete: ${selected.length}/306`);
      if (selected.some(s => s.scenarioHash !== hashes.get(s.id))) throw new ScenarioSelectionError('Migration task database is out of sync');
    } else {
      const released = new Map(releasedCatalogue().filter(s => s.status === 'valid' && s.dimension === 'structured_output' && s.tags?.includes('structured-contract-development-release') && (special !== 'mixed' || s.tags.includes('screening:mixed'))).map(s => [s.id, s]));
      selected = selected.filter(s => released.has(s.id));
      if (selected.length !== released.size || selected.some(s => s.scenarioHash !== released.get(s.id)?.scenarioHash)) throw new ScenarioSelectionError('Structured pack database is missing questions or out of sync');
    }
  } else {
    selected = selected.filter(s => (!config.dimensionFilter?.length || config.dimensionFilter.includes(s.dimension)) && (!config.difficultyFilter?.length || config.difficultyFilter.includes(s.difficulty)));
    if (config.evaluationMode === 'official') {
      const released = new Map(releasedCatalogue().filter(s => s.status === 'valid').map(s => [s.id, s]));
      selected = selected.filter(s => released.has(s.id));
      if (selected.some(s => s.scenarioHash !== released.get(s.id)?.scenarioHash)) throw new ScenarioSelectionError(`Official benchmark database is out of sync: ${selected.filter(s => s.scenarioHash !== released.get(s.id)?.scenarioHash).map(s => s.id).join(', ')}`);
    }
    if (config.scenarioIds?.length) {
      selected = selected.filter(s => config.scenarioIds!.includes(s.id));
      const found = new Set(selected.map(s => s.id));
      const missing = config.scenarioIds.filter(id => !found.has(id));
      if (missing.length) throw new ScenarioSelectionError(`Scenario selection missing or outside filters: ${missing.join(', ')}`);
      if (config.evaluationMode !== 'official') {
        const hashes = migrationHashes();
        if (selected.some(s => hashes.has(s.id) && s.scenarioHash !== hashes.get(s.id))) throw new ScenarioSelectionError('Migration task database is out of sync');
      }
    }
    if (config.evaluationMode === 'official' || !config.scenarioIds?.length) selected = selected.filter(s => (s.requirements as { developmentShadow?: boolean })?.developmentShadow !== true);
  }
  if (config.evaluationMode !== 'official') {
    const unexpired = selected.filter(s => {
      const until = (s.requirements as { validUntil?: string })?.validUntil;
      return !until || (Number.isFinite(Date.parse(until)) && Date.parse(until) >= now);
    });
    if (special !== 'default' && unexpired.length !== selected.length) throw new ScenarioSelectionError('Special pack contains expired questions');
    selected = unexpired;
  }
  return createBenchmarkPack(selected, config.evaluationMode, now);
}
