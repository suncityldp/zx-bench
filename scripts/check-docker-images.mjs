// Read-only deployment diagnosis. No pulls, builds, model calls or database writes.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function collectImageContracts(scenarios) {
  if (!Array.isArray(scenarios)) throw new Error('Question bank must be an array');
  const contracts = new Map();
  const add = (scenario, image, expectedImageId) => {
    if (typeof image !== 'string' || !image.trim()) throw new Error(`Invalid image in ${scenario.id}`);
    if (expectedImageId !== undefined && typeof expectedImageId !== 'string') throw new Error(`Invalid image ID in ${scenario.id}`);
    const key = JSON.stringify([image, expectedImageId ?? null]);
    const contract = contracts.get(key) ?? { image, expectedImageId, scenarioIds: [] };
    if (!contract.scenarioIds.includes(scenario.id)) contract.scenarioIds.push(scenario.id);
    contracts.set(key, contract);
  };
  for (const scenario of scenarios) {
    const req = scenario.requirements ?? {};
    if (req.executionCases?.length) add(scenario, req.executionImage ?? 'python:3.12-alpine', req.executionImageId);
    if (req.executionWorld) add(scenario, req.executionWorld.image ?? 'python:3.12-alpine', req.executionWorld.expectedImageId);
    if (req.executionShell) add(scenario, req.executionShell.image ?? 'python:3.12-alpine', req.executionShell.expectedImageId);
    if (req.agentLoop?.backend === 'docker') add(scenario, 'node:22-alpine', req.agentLoop.expectedImageId);
    if (req.image) add(scenario, req.image);
  }
  return [...contracts.values()];
}

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

export function checkDockerImages(contracts, run = docker) {
  const daemon = run(['version', '--format', '{{json .Server}}']);
  if (daemon.error || daemon.status !== 0) return {
    ok: false, daemon: { status: daemon.error?.code === 'ENOENT' ? 'cli_missing' : 'unavailable',
      detail: (daemon.error?.message || daemon.stderr || 'Docker server unavailable').trim().slice(0, 2000) }, images: [],
  };
  let server;
  try { server = JSON.parse(daemon.stdout); } catch { throw new Error('Invalid Docker server response'); }
  if (!server?.Os || !server?.Arch) throw new Error('Docker server response is incomplete');
  const cache = new Map();
  const images = contracts.map(contract => {
    let inspected = cache.get(contract.image);
    if (!inspected) {
      const result = run(['image', 'inspect', contract.image]);
      if (result.error || result.status !== 0) inspected = { status: 'unavailable',
        detail: (result.error?.message || result.stderr || 'Image inspect failed').trim().slice(0, 1000) };
      else {
        const image = JSON.parse(result.stdout)?.[0];
        if (!image?.Id) throw new Error(`Docker inspect returned no ID: ${contract.image}`);
        inspected = { status: 'ready', actualImageId: image.Id, architecture: image.Architecture,
          os: image.Os, repoDigests: image.RepoDigests ?? [] };
      }
      cache.set(contract.image, inspected);
    }
    let status = inspected.status;
    if (status === 'ready' && contract.expectedImageId && contract.expectedImageId !== inspected.actualImageId) status = 'id_mismatch';
    if (status === 'ready' && inspected.os !== 'linux') status = 'unsupported_image_os';
    return { ...contract, ...inspected, status };
  });
  return { ok: server.Os === 'linux' && images.every(image => image.status === 'ready'),
    daemon: { status: server.Os === 'linux' ? 'ready' : 'unsupported_os', os: server.Os, architecture: server.Arch }, images };
}

export function main(args = process.argv.slice(2)) {
  let bank = fileURLToPath(new URL('../data/scenarios/benchmark.json', import.meta.url));
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--bank' && args[i + 1] && !args[i + 1].startsWith('--')) bank = resolve(args[++i]);
    else throw new Error('Usage: node scripts/check-docker-images.mjs [--bank path] [--json]');
  }
  const report = { bank, scope: 'explicit_question_bank_images',
    ...checkDockerImages(collectImageContracts(JSON.parse(readFileSync(bank, 'utf8')))) };
  report.blockedScenarioIds = [...new Set(report.images.filter(image => image.status !== 'ready').flatMap(image => image.scenarioIds))];
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Docker: ${report.daemon.status} (${report.daemon.os ?? '?'} / ${report.daemon.architecture ?? '?'})`);
    if (report.daemon.detail) console.log(report.daemon.detail);
    for (const image of report.images) {
      console.log(`[${image.status}] ${image.image} — ${image.scenarioIds.length} questions (${image.scenarioIds.slice(0, 3).join(', ')})`);
      if (image.status === 'id_mismatch') console.log(`  expected: ${image.expectedImageId}\n  actual:   ${image.actualImageId}`);
      if (image.detail) console.log(`  ${image.detail}`);
    }
    console.log(`Blocked explicit image contracts: ${report.blockedScenarioIds.length} questions.`);
    console.log('Scope: explicit images in the question bank only; language runtimes embedded in graders, mounts and container execution still need verification.');
    if (report.daemon.status !== 'ready') console.log('Make the Docker CLI and Linux engine accessible to the user/process running the server.');
    if (report.images.some(image => image.status !== 'ready')) console.log('See docs/docker-deployment-troubleshooting.md for exact-image transfer; pulling a tag or rebuilding can change its ID.');
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
