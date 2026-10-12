// Prepare only missing explicit question-bank image contracts. Never mutate a frozen bank.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EnvHttpProxyAgent, fetch as fetchThroughDispatcher } from 'undici';
import { collectImageContracts, checkDockerImages, dockerCommand } from './check-docker-images.mjs';

export function selectScenarios(bank, { scenarios = [], dimensions = [] } = {}) {
  for (const id of scenarios) if (!bank.some(row => row.id === id)) throw new Error(`Unknown scenario: ${id}`);
  for (const dimension of dimensions) if (!bank.some(row => row.dimension === dimension)) throw new Error(`Unknown dimension: ${dimension}`);
  return bank.filter(row => (!scenarios.length || scenarios.includes(row.id)) && (!dimensions.length || dimensions.includes(row.dimension)));
}

export function validateRuntimeManifest(manifest) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.images)) throw new Error('Invalid runtime manifest');
  const seen = new Set();
  for (const row of manifest.images) {
    if (!row.image || seen.has(row.image) || !/^sha256:[a-f0-9]{64}$/.test(row.imageId)
      || !/^sha256:[a-f0-9]{64}$/.test(row.configDigest) || row.platform !== 'linux/amd64') throw new Error('Invalid runtime image contract');
    seen.add(row.image);
    if (row.source?.type === 'registry') {
      if (!row.source.repository || row.source.digest !== row.imageId) throw new Error('Invalid registry digest');
    } else if (row.source?.type === 'archive') {
      if (!/^[\w.-]+$/.test(row.source.asset ?? '') || basename(row.source.asset) !== row.source.asset
        || !/^https:\/\//.test(row.source.url ?? '') || !/^[a-f0-9]{64}$/.test(row.source.sha256 ?? '')
        || !Number.isSafeInteger(row.source.bytes) || row.source.bytes <= 0) throw new Error('Invalid archive contract');
    } else throw new Error('Invalid runtime source');
  }
  return manifest;
}

export function probeImageStore(run = dockerCommand) {
  const result = run(['info', '--format', '{{json .DriverStatus}}']);
  if (result.error || result.status !== 0) return 'unknown';
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { return 'unknown'; }
  if (!Array.isArray(rows)) return 'unknown';
  return rows.some(row => Array.isArray(row) && row.includes('io.containerd.snapshotter.v1')) ? 'containerd' : 'classic';
}

export function planPreparation(contracts, report, manifest, store) {
  validateRuntimeManifest(manifest);
  const entries = contracts.map(contract => {
    const checked = report.images.find(row => row.image === contract.image && row.expectedImageId === contract.expectedImageId);
    const spec = manifest.images.find(row => row.image === contract.image);
    const entry = { ...contract, status: checked?.status ?? report.daemon.status, action: 'blocked', spec };
    if (report.daemon.status !== 'ready') entry.reason = 'Docker Linux engine is not ready; start it before preparing images';
    else if (checked?.status === 'ready') entry.action = 'skip';
    else if (!spec || (contract.expectedImageId && contract.expectedImageId !== spec.imageId)) entry.reason = 'No published source for this frozen image contract; supply the matching release manifest';
    else if (!['unavailable', 'id_mismatch'].includes(checked?.status)) entry.reason = 'Image platform or inspection is unsupported';
    else if (checked?.actualImageId === spec.configDigest && spec.imageId !== spec.configDigest) entry.reason = 'IMAGE_STORE_IDENTITY: configuration exists, but the frozen ID is an OCI target; use a compatible containerd image store';
    else if (spec.imageIdKind !== 'config' && store !== 'containerd') entry.reason = 'IMAGE_STORE_IDENTITY: frozen OCI target IDs require a containerd image store; downloading the same content will not fix this mode';
    else if (report.daemon.architecture !== 'amd64') entry.reason = 'This release was verified for linux/amd64; use a matching engine';
    else entry.action = spec.source.type === 'registry' ? 'pull' : 'download';
    return entry;
  });
  return { scope: 'selected_explicit_question_bank_images', store, daemon: report.daemon,
    entries, blocked: entries.some(row => row.action === 'blocked'), ready: entries.every(row => row.action === 'skip') };
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

export async function ensureArchive(source, cacheDir, fetchImpl) {
  mkdirSync(cacheDir, { recursive: true });
  const archive = resolve(cacheDir, source.asset);
  if (existsSync(archive) && await fileSha256(archive) === source.sha256) return archive;
  const partial = `${archive}.${randomUUID()}.partial`;
  // Node 22's built-in fetch does not honor proxy environment variables by itself.
  const dispatcher = fetchImpl ? undefined : new EnvHttpProxyAgent();
  const download = fetchImpl ?? ((url, options) => fetchThroughDispatcher(url, { ...options, dispatcher }));
  try {
    const response = await download(source.url, { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`Archive download failed: HTTP ${response.status}`);
    const hash = createHash('sha256');
    let bytes = 0;
    const verify = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > source.bytes) return callback(new Error('Archive size exceeds the release contract'));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(partial, { flags: 'wx' }));
    if (bytes !== source.bytes || hash.digest('hex') !== source.sha256) throw new Error('Archive checksum or size mismatch; Docker load was not performed');
    renameSync(partial, archive);
    return archive;
  } catch (error) { rmSync(partial, { force: true }); throw error; }
  finally { await dispatcher?.close(); }
}

function runDocker(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '';
    child.stderr.on('data', bytes => { detail = (detail + bytes.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun() : reject(new Error(`Docker ${args[0]} failed (${code}): ${detail}`)));
  });
}

export async function prepareDockerImages({ contracts, manifest, cacheDir, checkOnly = false }, deps = {}) {
  validateRuntimeManifest(manifest);
  const run = deps.run ?? dockerCommand;
  const command = deps.command ?? runDocker;
  const archive = deps.archive ?? ((source, directory) => ensureArchive(source, directory));
  const log = deps.log ?? console.log;
  const store = probeImageStore(run);
  const initial = planPreparation(contracts, checkDockerImages(contracts, run), manifest, store);
  if (checkOnly) return initial;
  if (initial.blocked) throw new Error(JSON.stringify(initial.entries.filter(row => row.action === 'blocked')));
  for (const row of initial.entries) {
    // A concurrent installer may have completed this image since the initial plan.
    const current = planPreparation([row], checkDockerImages([row], run), manifest, store).entries[0];
    if (current.action === 'skip') { log(`[ready] ${row.image}; no download`); continue; }
    if (current.action === 'blocked') throw new Error(current.reason);
    const spec = row.spec;
    if (current.action === 'pull') {
      const ref = `${spec.source.repository}@${spec.source.digest}`;
      log(`[pull] ${row.image} by frozen digest`);
      await command(['pull', ref]);
      const pulled = checkDockerImages([{ image: ref, expectedImageId: spec.imageId, scenarioIds: [] }], run);
      if (!pulled.ok) throw new Error(`Pulled image does not satisfy the frozen ID/platform: ${JSON.stringify(pulled.images)}; check Docker image store mode`);
      await command(['image', 'tag', ref, row.image]);
    } else {
      log(`[download] ${row.image} (${spec.source.bytes} bytes)`);
      const path = await archive(spec.source, cacheDir);
      await command(['image', 'load', '--input', path]);
    }
    const verified = checkDockerImages([{ image: row.image, expectedImageId: spec.imageId, scenarioIds: [] }], run);
    if (!verified.ok) throw new Error(`Prepared image does not satisfy release ID/platform: ${JSON.stringify(verified.images)}; check Docker image store mode`);
  }
  return planPreparation(contracts, checkDockerImages(contracts, run), manifest, store);
}

export async function main(args = process.argv.slice(2)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let bank = resolve(root, 'data/scenarios/benchmark.json');
  let manifestPath = resolve(root, 'docker/execution-images/runtime.json');
  let cacheDir = resolve(root, 'tmp/runtime');
  let checkOnly = false;
  let json = false;
  const images = [], scenarios = [], dimensions = [];
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--dry-run'].includes(args[i])) checkOnly = true;
    else if (args[i] === '--json') json = true;
    else if (['--bank', '--manifest', '--cache-dir', '--image', '--scenario', '--dimension'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const flag = args[i++], value = args[i];
      if (flag === '--bank') bank = resolve(value);
      if (flag === '--manifest') manifestPath = resolve(value);
      if (flag === '--cache-dir') cacheDir = resolve(value);
      if (flag === '--image') images.push(value);
      if (flag === '--scenario') scenarios.push(value);
      if (flag === '--dimension') dimensions.push(value);
    } else throw new Error('Usage: pnpm runtime:prepare [--check] [--json] [--image ref] [--scenario ID] [--dimension name] [--bank path] [--manifest path] [--cache-dir path]');
  }
  const selected = selectScenarios(JSON.parse(readFileSync(bank, 'utf8')), { scenarios, dimensions });
  let contracts = collectImageContracts(selected);
  for (const image of images) if (!contracts.some(row => row.image === image)) throw new Error(`Image is not declared in the selected bank: ${image}`);
  if (images.length) contracts = contracts.filter(row => images.includes(row.image));
  if (!contracts.length) {
    console.log(JSON.stringify({ ready: true, scope: 'selected_explicit_question_bank_images', entries: [], note: 'No explicit Docker image dependencies in this selection' }));
    return 0;
  }
  const report = await prepareDockerImages({ contracts, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), cacheDir, checkOnly }, { log: json ? () => {} : undefined });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const row of report.entries) console.log(`[${row.action}] ${row.image}: ${row.reason ?? row.status}`);
    console.log(`Scope: explicit images of the selected questions only. ${report.ready ? 'Ready' : 'Not ready'}; no model calls or score/database changes.`);
  }
  return report.blocked || (!checkOnly && !report.ready) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
