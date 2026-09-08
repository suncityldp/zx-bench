// Targeted upsert: avoids the generic seed script's metadata-file crash (#6).
// Defaults to a local dry run. Use --apply after backing up the deployment database.
import fs from 'node:fs';
const scenarios = JSON.parse(fs.readFileSync(new URL('../data/scenarios/benchmark.json', import.meta.url), 'utf8'))
  .filter(s => s.dimension === 'reasoning_math');
const apply = process.argv.includes('--apply');
const base = process.env.BASE_URL || 'http://localhost:3001';
if (!apply) {
  console.log(JSON.stringify({ dryRun: true, count: scenarios.length,
    scenarios: scenarios.map(({ id, status, scenarioVersion, scenarioHash }) => ({ id, status, scenarioVersion, scenarioHash })) }, null, 2));
} else {
  let failed = 0;
  for (const scenario of scenarios) {
    try {
      const response = await fetch(new URL('/api/scenarios', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenario), signal: AbortSignal.timeout(30000),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || `HTTP ${response.status}`);
      console.log(`Updated ${scenario.id} ${scenario.scenarioVersion} ${scenario.status}`);
    } catch (error) { failed++; console.error(`${scenario.id}: ${error.message}`); }
  }
  if (failed) { console.error(`${failed} updates failed; retry before starting new evaluations.`); process.exitCode = 1; }
}
