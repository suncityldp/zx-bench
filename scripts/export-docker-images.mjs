// Export the exact explicit image contracts of a frozen question bank. No pulls or re-pinning.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImageContracts, checkDockerImages } from './check-docker-images.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function planImageExport(bankBytes, run, selectedImages = []) {
  const contracts = collectImageContracts(JSON.parse(bankBytes.toString('utf8')));
  for (const image of selectedImages) {
    if (!contracts.some(row => row.image === image)) throw new Error(`Image is not declared in question bank: ${image}`);
  }
  const report = checkDockerImages(selectedImages.length
    ? contracts.filter(row => selectedImages.includes(row.image)) : contracts, run);
  if (!report.ok) throw new Error(`Image preflight failed: ${JSON.stringify(report)}`);
  if (!report.images.length) throw new Error('Question bank has no explicit image contracts');
  // A matching ID alone cannot make an image executable on this release's host architecture.
  if (report.images.some(row => row.architecture !== report.daemon.architecture)) {
    throw new Error('Image architecture differs from the Docker server; verify on a matching host first');
  }
  return { bankSha256: sha256(bankBytes), scope: selectedImages.length
    ? 'selected_explicit_question_bank_images' : 'explicit_question_bank_images',
    daemon: report.daemon, images: report.images,
    scenarioCount: new Set(report.images.flatMap(row => row.scenarioIds)).size };
}

/** Verify the saved bytes, so a tag moved during docker save cannot produce a false receipt. */
export function verifyArchiveManifest(manifest, configs, images) {
  if (!Array.isArray(manifest)) throw new Error('Invalid Docker archive manifest');
  const identities = [];
  for (const image of images) {
    const entries = manifest.filter(entry => entry.RepoTags?.includes(image.image));
    if (entries.length !== 1) throw new Error(`Archive must contain exactly one tag: ${image.image}`);
    const bytes = configs.get(entries[0].Config);
    if (!bytes) throw new Error(`Archive image ID mismatch: ${image.image}`);
    const configDigest = `sha256:${sha256(bytes)}`;
    const config = JSON.parse(bytes.toString('utf8'));
    if (config.os !== image.os || config.architecture !== image.architecture) {
      throw new Error(`Archive platform mismatch: ${image.image}`);
    }
    let idKind = 'config';
    // The classic store exposes config digest as .Id; containerd exposes the target descriptor.
    if (configDigest !== image.actualImageId) {
      const indexBytes = configs.get('index.json');
      if (!indexBytes) throw new Error(`Archive image ID mismatch: ${image.image}`);
      const index = JSON.parse(indexBytes.toString('utf8'));
      const refs = new Set([image.image, `docker.io/${image.image}`,
        ...(!image.image.includes('/') ? [`docker.io/library/${image.image}`] : [])]);
      const targets = (index.manifests ?? []).filter(entry =>
        refs.has(entry.annotations?.['io.containerd.image.name']) && entry.digest === image.actualImageId);
      if (targets.length !== 1) throw new Error(`Archive OCI target mismatch: ${image.image}`);
      const visited = new Set();
      const reachesConfig = descriptor => {
        if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) throw new Error('Invalid OCI digest');
        const blob = configs.get(`blobs/sha256/${descriptor.digest.slice(7)}`);
        if (!blob) return false; // Other platform variants may not be installed/exported.
        if (blob.length !== descriptor.size || `sha256:${sha256(blob)}` !== descriptor.digest) {
          throw new Error(`Archive OCI blob mismatch: ${descriptor.digest}`);
        }
        if (visited.has(descriptor.digest)) return false;
        visited.add(descriptor.digest);
        const document = JSON.parse(blob.toString('utf8'));
        if (document.config) return document.config.digest === configDigest && document.config.size === bytes.length;
        return (document.manifests ?? []).some(child => (!child.platform
          || (child.platform.os === image.os && child.platform.architecture === image.architecture)) && reachesConfig(child));
      };
      if (!reachesConfig(targets[0])) throw new Error(`Archive OCI target does not reference config: ${image.image}`);
      idKind = targets[0].mediaType?.includes('index') || targets[0].mediaType?.includes('manifest.list') ? 'oci_index' : 'oci_manifest';
    }
    identities.push({ image: image.image, imageId: image.actualImageId, configDigest, idKind });
  }
  return identities;
}

// Read only manifest/config entries from an uncompressed docker-save tar; never extract files.
async function readArchiveJsonEntries(path) {
  const handle = await open(path, 'r');
  const size = (await handle.stat()).size;
  const entries = new Map();
  try {
    let offset = 0;
    while (offset + 512 <= size) {
      const header = Buffer.alloc(512);
      if ((await handle.read(header, 0, 512, offset)).bytesRead !== 512) throw new Error('Truncated tar header');
      if (header.every(byte => byte === 0)) break;
      const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
      const prefix = field(345, 500);
      const name = (prefix ? `${prefix}/` : '') + field(0, 100);
      const lengthField = field(124, 136).trim();
      if (!/^[0-7]+$/.test(lengthField)) throw new Error('Unsupported tar entry size');
      const length = Number.parseInt(lengthField, 8);
      if (!Number.isSafeInteger(length) || offset + 512 + length > size) throw new Error('Truncated tar entry');
      const regular = header[156] === 0 || header[156] === 48;
      if (regular && (['manifest.json', 'index.json'].includes(name) || /^[a-f0-9]{64}\.json$/.test(name)
        || /^blobs\/sha256\/[a-f0-9]{64}$/.test(name)) && length <= 16 * 1024 * 1024) {
        const bytes = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const result = await handle.read(bytes, read, length - read, offset + 512 + read);
          if (!result.bytesRead) throw new Error('Truncated tar JSON');
          read += result.bytesRead;
        }
        if (entries.has(name)) throw new Error(`Duplicate tar entry: ${name}`);
        entries.set(name, bytes);
      }
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    if (!entries.has('manifest.json')) throw new Error('Docker save archive has no manifest.json');
    return entries;
  } finally { await handle.close(); }
}

export async function verifySavedArchive(path, images) {
  const entries = await readArchiveJsonEntries(path);
  const identities = verifyArchiveManifest(JSON.parse(entries.get('manifest.json').toString('utf8')), entries, images);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { sha256: hash.digest('hex'), bytes: (await stat(path)).size, identities };
}

function saveImages(path, images) {
  return new Promise((resolveSave, reject) => {
    const child = spawn('docker', ['image', 'save', '-o', path, ...images],
      { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let detail = '';
    child.stderr.on('data', bytes => { detail = (detail + bytes.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveSave() : reject(new Error(`docker image save failed (${code}): ${detail}`)));
  });
}

export async function main(args = process.argv.slice(2)) {
  let bank = fileURLToPath(new URL('../data/scenarios/benchmark.json', import.meta.url));
  let output;
  let dryRun = false;
  const selectedImages = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    else if (['--bank', '--output', '--image'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const flag = args[i++];
      if (flag === '--bank') bank = resolve(args[i]);
      else if (flag === '--image') selectedImages.push(args[i]);
      else output = resolve(args[i]);
    } else throw new Error('Usage: node scripts/export-docker-images.mjs [--bank path] [--image ref ...] [--dry-run] --output path.tar');
  }
  if (!output) throw new Error('--output is required');
  for (const path of [output, `${output}.partial`, `${output}.manifest.json`, `${output}.sha256`]) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite: ${path}`);
  }
  const plan = planImageExport(readFileSync(bank), undefined, selectedImages);
  const names = [...new Set(plan.images.map(row => row.image))];
  console.log(JSON.stringify({ dryRun, bank, output, ...plan }, null, 2));
  if (dryRun) return;
  mkdirSync(dirname(output), { recursive: true });
  // A failed or interrupted save stays .partial and cannot be mistaken for a verified bundle.
  await saveImages(`${output}.partial`, names);
  const archive = await verifySavedArchive(`${output}.partial`, plan.images);
  const receipt = { schemaVersion: 1, createdAt: new Date().toISOString(), bank, ...plan, archive };
  writeFileSync(`${output}.manifest.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(`${output}.sha256`, `${archive.sha256}  ${output.split(/[\\/]/).at(-1)}\n`, { flag: 'wx' });
  renameSync(`${output}.partial`, output);
  console.log(`Verified export: ${output} (${archive.bytes} bytes, SHA-256 ${archive.sha256})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
