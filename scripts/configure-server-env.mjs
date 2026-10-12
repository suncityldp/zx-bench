import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configureServerEnv(path, port = 3001) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
  if (existsSync(path)) return { created: false, path, note: 'Existing configuration preserved, including encryption key' };
  mkdirSync(dirname(path), { recursive: true });
  const text = `DATABASE_URL="file:../../data/zxbench.db"\nPORT=${port}\nZXBENCH_HOST=127.0.0.1\nZXBENCH_CORS_ORIGIN=\nZXBENCH_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\n`;
  writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  return { created: true, path, note: 'Local configuration created; encryption key is not printed' };
}

export function main(args = process.argv.slice(2)) {
  let port = 3001;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1])) throw new Error('Usage: pnpm setup:env [--port 3001]');
    port = Number(args[1]);
  }
  console.log(JSON.stringify(configureServerEnv(fileURLToPath(new URL('../apps/server/.env', import.meta.url)), port)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
