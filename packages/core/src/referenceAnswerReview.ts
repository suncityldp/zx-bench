/** Issue #7: old math scores remain audit evidence, but are not comparable with v3. */
const mathIds = new Set(Array.from({ length: 35 }, (_, i) => i + 1)
  .filter(n => n !== 26).map(n => `RM-CN-${String(n).padStart(3, '0')}`));
const disputedIds = new Set(['RM-CN-013', 'RM-CN-014', 'RM-CN-028', 'RM-CN-031']);

export interface ReferenceAnswerRow {
  scenarioId?: string;
  scenarioVersion?: string;
  graderVersion?: string;
}

export function referenceAnswerWarnings(rows: ReferenceAnswerRow[]): string[] {
  const warnings = new Set<string>();
  for (const row of rows) {
    if (!row.scenarioId || !mathIds.has(row.scenarioId)) continue;
    if (disputedIds.has(row.scenarioId)) {
      warnings.add(`${row.scenarioId}: 题面存在歧义，已暂停计分（issue #7）`);
    } else if (row.scenarioVersion !== '3.0.0'
      || !['exact_answer_line@exact_answer_v3', 'exact_answer_v3'].includes(row.graderVersion ?? '')) {
      warnings.add(`${row.scenarioId}: 旧版参考答案或评分规则，需用 v3 题库重新评测（issue #7）`);
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
