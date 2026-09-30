/** Current catalogue and retired archive are disjoint sources. Execution
 * migration instances are not additional source questions. */
export function benchmarkCounts(pack, archive = []) {
  const ids = new Set(pack.map(s => s.id));
  if (ids.size !== pack.length || new Set(archive.map(s => s.id)).size !== archive.length) throw new Error('Duplicate question IDs');
  if (archive.some(s => ids.has(s.id) || s.status !== 'retired')) throw new Error('Archive overlaps current catalogue or contains non-retired questions');
  const valid = pack.filter(s => s.status === 'valid');
  const defaults = valid.filter(s => s.requirements?.developmentShadow !== true || s.benchmarkSource?.releaseId === 'nine-model-adopted-2026-09-29');
  const dimensions = {};
  for (const s of valid) dimensions[s.dimension] = (dimensions[s.dimension] ?? 0) + 1;
  return {
    count: valid.length, validCount: valid.length,
    currentRecordCount: pack.length,
    retiredCount: pack.filter(s => s.status === 'retired').length,
    archivedRetiredCount: archive.length,
    totalCount: pack.length + archive.length,
    developmentShadowCount: valid.filter(s => s.requirements?.developmentShadow === true).length,
    defaultRunCount: defaults.length,
    sourceQuestionCount: new Set(defaults.map(s => s.benchmarkSource?.id ?? s.id)).size,
    executionInstanceCount: defaults.length,
    dimensions: Object.fromEntries(Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b))),
  };
}
