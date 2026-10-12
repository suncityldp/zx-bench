// Read-only acceptance: no candidate/Judge calls, credential probes, or database writes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedBenchmark } from './seed-benchmark.mjs';
import { loadBenchmarkImportScope } from './benchmark-import-scope.mjs';

export async function checkDeployment({ base, version, scenarios, fetchImpl = fetch, log = console }) {
  const get = async route => {
    const result = await fetchImpl(base.replace(/\/$/, '') + route, { signal: AbortSignal.timeout(30_000) });
    if (!result.ok) throw new Error(`Deployment HTTP check failed: ${route} (${result.status})`);
    return result;
  };
  const health = await (await get('/api/health')).json();
  const current = await (await get('/api/version')).json();
  if (health.status !== 'ok' || health.version !== version || current.version !== version) {
    throw new Error(`Running server version mismatch; expected ${version}. Restart the server from this checkout`);
  }
  const html = await (await get('/')).text();
  if (!/id=["']root["']/.test(html) || !/<script/.test(html)) throw new Error('Frontend build is not being served');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]);
  if (!scripts.length) throw new Error('Frontend JavaScript asset is missing');
  for (const script of scripts) {
    const url = new URL(script, base);
    if (url.origin !== new URL(base).origin) throw new Error('Unexpected frontend asset origin');
    await get(url.pathname + url.search);
  }
  const bank = await seedBenchmark({ scenarios, base, checkOnly: true, fetchImpl, log });
  if (bank.fail || bank.missing.length || bank.drifted.length) throw new Error('Released database is incomplete; run pnpm bank:sync');
  return { ready: true, version, base, frontend: 'ready', releasedScenarioCount: scenarios.length,
    bankMissing: bank.missing.length, bankDrifted: bank.drifted.length, modelRequests: 0 };
}

export async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const { scenarios } = loadBenchmarkImportScope(resolve(root, 'data/scenarios'));
  console.log(JSON.stringify(await checkDeployment({ base: process.env.BASE_URL ?? 'http://127.0.0.1:3001', version, scenarios }), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
