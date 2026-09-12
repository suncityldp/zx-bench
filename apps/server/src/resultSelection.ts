/**
 * Select the authoritative result row for each question.
 *
 * A retry, resume, or Judge-only rescore supersedes the earlier row. Scores are
 * deliberately not considered: choosing the highest score would bias reruns and
 * make a failed corrective rerun disappear from the aggregate.
 */
export function selectLatestScenarioResults<
  T extends { scenarioId: string; finishedAt: Date | string; startedAt?: Date | string; id?: string },
>(results: readonly T[]): T[] {
  return selectLatestResultsByKey(results, (result) => result.scenarioId);
}

/** Same replacement policy for composite scopes such as run + scenario. */
export function selectLatestResultsByKey<
  T extends { finishedAt: Date | string; startedAt?: Date | string; id?: string },
>(results: readonly T[], keyOf: (result: T) => string): T[] {
  const selected = new Map<string, T>();

  for (const result of results) {
    const key = keyOf(result);
    const previous = selected.get(key);
    if (!previous || compareResultOrder(result, previous) > 0) {
      selected.set(key, result);
    }
  }

  return Array.from(selected.values());
}

function compareResultOrder(
  left: { finishedAt: Date | string; startedAt?: Date | string; id?: string },
  right: { finishedAt: Date | string; startedAt?: Date | string; id?: string },
): number {
  const finished = timestamp(left.finishedAt) - timestamp(right.finishedAt);
  if (finished !== 0) return finished;

  const started = timestamp(left.startedAt) - timestamp(right.startedAt);
  if (started !== 0) return started;

  return (left.id ?? '').localeCompare(right.id ?? '');
}

function timestamp(value: Date | string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
