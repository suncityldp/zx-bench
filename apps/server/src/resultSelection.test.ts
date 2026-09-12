import { describe, expect, it } from 'vitest';
import { selectLatestResultsByKey, selectLatestScenarioResults } from './resultSelection.js';

describe('selectLatestScenarioResults', () => {
  it('uses the latest completed retry even when its score is lower', () => {
    const rows = [
      { id: 'old', scenarioId: 'Q-1', totalScore: 96, finishedAt: new Date('2026-09-08T10:00:00Z') },
      { id: 'new', scenarioId: 'Q-1', totalScore: 42, finishedAt: new Date('2026-09-08T11:00:00Z') },
    ];

    expect(selectLatestScenarioResults(rows)).toEqual([rows[1]]);
  });

  it('does not revive an older success when the latest retry is an environment error', () => {
    const rows = [
      { id: 'old', scenarioId: 'Q-1', totalScore: 80, environmentError: false, finishedAt: '2026-09-08T10:00:00Z' },
      { id: 'new', scenarioId: 'Q-1', totalScore: 0, environmentError: true, finishedAt: '2026-09-08T11:00:00Z' },
    ];

    expect(selectLatestScenarioResults(rows)).toEqual([rows[1]]);
  });

  it('selects independently per scenario and is stable on timestamp ties', () => {
    const rows = [
      { id: 'a', scenarioId: 'Q-1', totalScore: 10, startedAt: '2026-09-08T09:00:00Z', finishedAt: '2026-09-08T10:00:00Z' },
      { id: 'b', scenarioId: 'Q-2', totalScore: 20, startedAt: '2026-09-08T09:00:00Z', finishedAt: '2026-09-08T10:00:00Z' },
      { id: 'c', scenarioId: 'Q-1', totalScore: 30, startedAt: '2026-09-08T09:30:00Z', finishedAt: '2026-09-08T10:00:00Z' },
    ];

    expect(selectLatestScenarioResults(rows).map((row) => row.id)).toEqual(['c', 'b']);
  });

  it('can select the latest attempt independently within each run', () => {
    const rows = [
      { runId: 'R-1', scenarioId: 'Q-1', totalScore: 90, finishedAt: '2026-09-08T10:00:00Z' },
      { runId: 'R-1', scenarioId: 'Q-1', totalScore: 40, finishedAt: '2026-09-08T11:00:00Z' },
      { runId: 'R-2', scenarioId: 'Q-1', totalScore: 70, finishedAt: '2026-09-08T12:00:00Z' },
    ];

    expect(selectLatestResultsByKey(rows, (row) => `${row.runId}:${row.scenarioId}`).map((row) => row.totalScore)).toEqual([40, 70]);
  });
});
