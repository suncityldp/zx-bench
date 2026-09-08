/** Issue #7: old math scores remain audit evidence, but are not comparable with v3. */
const mathIds = new Set(Array.from({ length: 35 }, (_, i) => i + 1)
  .filter(n => n !== 26).map(n => `RM-CN-${String(n).padStart(3, '0')}`));
// These IDs were disputed at 3.0.0 and became scoreable only after prompt repair.
const restoredIds = new Set(['RM-CN-013', 'RM-CN-014', 'RM-CN-028', 'RM-CN-031']);

export interface ReferenceAnswerRow {
  scenarioId?: string;
  scenarioVersion?: string;
  graderVersion?: string;
}

export function referenceAnswerWarnings(rows: ReferenceAnswerRow[]): string[] {
  const warnings = new Set<string>();
  for (const row of rows) {
    if (!row.scenarioId) continue;
    if (/^(?:FR|UB|TD|HP|GC|CI)-\d{3}$/.test(row.scenarioId)) {
      if (row.scenarioVersion !== '5.0.0' || !['hallucination_v5','hallucination_resistance@hallucination_v5'].includes(row.graderVersion ?? '')) warnings.add(row.scenarioId + ': needs reviewed hallucination 5.0.0 / hallucination_v5');
      continue;
    }
    if (!mathIds.has(row.scenarioId)) continue;
    const requiredVersion = '3.2.0';
    if (row.scenarioVersion !== requiredVersion
      || !['exact_answer_line@exact_answer_v4', 'exact_answer_v4'].includes(row.graderVersion ?? '')) {
      warnings.add(`${row.scenarioId}: 旧版或未核验的题面/评分规则，需用 ${requiredVersion} 题面及 exact_answer_v4 重新评测（issue #7）`);
    }
  }
  return [...warnings];
}

/** Exclude whole runs before latest/best aggregation, including cached summaries. */
export function partitionReferenceAnswerRuns<T extends { id: string; results: ReferenceAnswerRow[] }>(runs: T[]) {
  const eligible: T[] = [];
  const excluded: Array<{ runId: string; issues: string[] }> = [];
  for (const run of runs) {
    const issues = referenceAnswerWarnings(run.results);
    if (issues.length) excluded.push({ runId: run.id, issues });
    else eligible.push(run);
  }
  return { eligible, excluded };
}
