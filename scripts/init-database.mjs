// Initialize only the configured SQLite file, then let Prisma synchronize tables.
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configuredDatabaseUrl(envPath, env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  let source;
  try { source = readFileSync(envPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('先将 apps/server/.env.example 复制为 apps/server/.env 并配置 DATABASE_URL'); throw error; }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const match = line.match(/^DATABASE_URL\s*=(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) return value;
  }
  throw new Error('请在 apps/server/.env 中配置 DATABASE_URL');
}

export function prepareSqliteFile(databaseUrl, schemaDirectory) {
  if (!databaseUrl.startsWith('file:') || !databaseUrl.slice(5) || databaseUrl === 'file::memory:') throw new Error('DATABASE_URL 必须指向 SQLite 文件');
  const target = resolve(schemaDirectory, decodeURIComponent(databaseUrl.slice(5).split('?')[0]));
  mkdirSync(dirname(target), { recursive: true });
  try { closeSync(openSync(target, 'wx')); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return target;
}

export function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const databaseUrl = configuredDatabaseUrl(resolve(root, 'apps/server/.env'));
  prepareSqliteFile(databaseUrl, resolve(root, 'apps/server/prisma'));
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'db', 'push'], {
    cwd: resolve(root, 'apps/server'), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
