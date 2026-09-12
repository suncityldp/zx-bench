import { describe, expect, it } from 'vitest';
import type { Scenario, OutputMetadata } from '@zxbench/types';
import { replayInstructionCriteria } from './replay.js';

describe('isolated legacy rubric replay', () => {
  it('a hard deadline returns unmeasured and leaves the main event loop responsive', async () => {
    const result = await replayInstructionCriteria({} as Scenario, 'answer', {} as OutputMetadata, 0, 'data:text/javascript,export {}');
    expect(result.criteria).toEqual([]);
    expect(result.issue).toContain('exceeded');
    await expect(new Promise(resolve => setTimeout(() => resolve('responsive'), 0))).resolves.toBe('responsive');
  });
  it('returns the isolated grader result without requiring built workspace packages', async () => {
    const entry = 'data:text/javascript,' + encodeURIComponent('export const instructionChecklistEvaluator = { version: "fixture", evaluate: async () => ({ criterionResults: [{id:"test",status:"pass"}] }) };');
    const result = await replayInstructionCriteria({} as Scenario, 'answer', {} as OutputMetadata, 5000, entry);
    expect(result).toMatchObject({ version: 'fixture', criteria: [{ id: 'test', status: 'pass' }] });
  });
});
