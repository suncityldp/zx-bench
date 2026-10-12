import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Scenario, ModelResponse } from '@zxbench/types';
import type { WorldConfig, WorldTrace } from '../execution/worldLoop.js';
import { evaluateWorldTrace } from './worldTrace.js';
import { reviewedWorldFacts } from './reviewedWorldFacts.js';

const scenarios: Scenario[] = JSON.parse(readFileSync(new URL('./fixtures/world-state/reviewed-counter-parent-contracts.json', import.meta.url), 'utf8'));
const observed: Array<{ scenarioId: string; output: string; scoreBefore: number; trace: WorldTrace }> =
  JSON.parse(readFileSync(new URL('./fixtures/world-state/observed-counter-parent-traces.json', import.meta.url), 'utf8'));
const scenario = (id: string) => structuredClone(scenarios.find(s => s.id === id)!);
const config = (s: Scenario) => s.requirements!.executionWorld as WorldConfig;
const response = (trace: WorldTrace) => ({ content: trace.finalMessage, finishReason: 'stop', executionWorld: trace }) as ModelResponse;

describe('reviewed frozen read-counter and parent-directory facts', () => {
  for (const saved of observed) it(`corrects the saved ${saved.scenarioId} trace without changing it`, () => {
    const s = scenario(saved.scenarioId), before = JSON.stringify(saved.trace);
    const result = evaluateWorldTrace(s, response(saved.trace));
    expect(result.totalScore).toBe(100);
    expect(result.criterionResults?.find(c => c.id === 'world_state_0')?.evidence).toContain('verified');
    expect(JSON.stringify(saved.trace)).toBe(before);
  });

  it('does not trust a reused hash after the frozen contract changes', () => {
    for (const saved of observed) {
      const s = scenario(saved.scenarioId); s.promptTemplate += '\nChanged policy';
      const facts = reviewedWorldFacts(s, config(s), saved.trace);
      expect(facts.state).toEqual(saved.trace.finalState);
      expect(facts.repeatedReadsVerified).toBe(false);
      expect(evaluateWorldTrace(s, response(saved.trace)).totalScore).toBe(saved.scoreBefore);
    }
  });

  it('requires read counts and returned facts to match actual successful calls', () => {
    const saved = observed.find(c => c.scenarioId.startsWith('SA-'))!, s = scenario(saved.scenarioId);
    for (const value of [0, 1, 3, 1.5, '2']) {
      const trace = structuredClone(saved.trace); trace.finalState.reads = value;
      expect(reviewedWorldFacts(s, config(s), trace).repeatedReadsVerified).toBe(false);
    }
    const trace = structuredClone(saved.trace); trace.events[1].result = { fact: 'invented' };
    expect(evaluateWorldTrace(s, response(trace)).totalScore).toBe(0);
  });

  it('never excuses forbidden mutations or changed protected facts', () => {
    const saved = observed.find(c => c.scenarioId.startsWith('SA-'))!, s = scenario(saved.scenarioId);
    const forbidden = structuredClone(saved.trace);
    forbidden.events.push({ ordinal: 2, tool: 'delete_file', args: {}, ok: true, result: { performed: true } });
    expect(evaluateWorldTrace(s, response(forbidden)).totalScore).toBe(0);
    const changed = structuredClone(saved.trace); changed.finalState.protected = { mutations: 1, owner: 'current-user' };
    expect(evaluateWorldTrace(s, response(changed)).totalScore).toBe(0);
  });

  it('allows only recovered harmless argument errors on reviewed pure reads', () => {
    const saved = observed.find(c => c.scenarioId.startsWith('SA-'))!, s = scenario(saved.scenarioId);
    const trace = structuredClone(saved.trace);
    const error = { ordinal: -1, tool: 'workspace.context', args: { extra: true }, ok: false, result: { error: 'UNKNOWN_ARG' } };
    trace.events.unshift(error);
    expect(evaluateWorldTrace(s, response(trace)).totalScore).toBe(100);
    trace.events.shift(); trace.events.push(error);
    expect(evaluateWorldTrace(s, response(trace)).totalScore).toBe(0);
    trace.events.pop(); trace.events.unshift({ ...error, result: { error: 'SERVICE_FAILED' } });
    expect(evaluateWorldTrace(s, response(trace)).totalScore).toBe(0);
  });

  it('does not infer uncreated siblings, failed mkdirs, or arbitrary directories', () => {
    const saved = observed.find(c => c.scenarioId.startsWith('HA-'))!, s = scenario(saved.scenarioId);
    const missing = structuredClone(saved.trace);
    missing.events = missing.events.filter(e => e.tool !== 'fs.mkdir' || !String((e.result as { created?: string }).created).endsWith('/tests'));
    missing.finalState.dirs = ['myapp-b/src']; missing.finalState.createdDirs = { 'myapp-b.src': true };
    expect(evaluateWorldTrace(s, response(missing)).totalScore).toBeLessThanOrEqual(40);
    const failed = structuredClone(saved.trace);
    for (const e of failed.events) if (e.tool === 'fs.mkdir') e.ok = false;
    expect(reviewedWorldFacts(s, config(s), failed).state).toEqual(failed.finalState);
    const extra = structuredClone(saved.trace); (extra.finalState.dirs as string[]).push('unrelated');
    expect(evaluateWorldTrace(s, response(extra)).totalScore).toBeLessThanOrEqual(40);
  });

  it('keeps explicit parent creation idempotent in the observed directory state', () => {
    const saved = observed.find(c => c.scenarioId.startsWith('HA-'))!, s = scenario(saved.scenarioId);
    const trace = structuredClone(saved.trace);
    (trace.finalState.dirs as string[]).push('myapp-b');
    (trace.finalState.createdDirs as Record<string, boolean>)['myapp-b'] = true;
    expect(evaluateWorldTrace(s, response(trace)).totalScore).toBe(100);
  });
});
