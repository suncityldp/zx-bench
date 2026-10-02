import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configuredDatabaseUrl, prepareSqliteFile } from './init-database.mjs';

test('loads the configured URL without exposing other settings, preferring process env', () => {
  const root = mkdtempSync(join(tmpdir(), 'zxbench-init-test-'));
  const envPath = join(root, '.env');
  writeFileSync(envPath, '# DATABASE_URL=ignored\nDATABASE_URL="file:../../data/test.db"\nOTHER=private\n');
  assert.equal(configuredDatabaseUrl(envPath, {}), 'file:../../data/test.db');
  assert.equal(configuredDatabaseUrl(envPath, { DATABASE_URL:'file:override.db' }), 'file:override.db');
  assert.throws(() => configuredDatabaseUrl(join(root,'missing.env'), {}), /复制/);
});
test('creates the parent and empty SQLite file but preserves an existing database', () => {
  const root = mkdtempSync(join(tmpdir(), 'zxbench-init-test-'));
  const target = prepareSqliteFile('file:../data/bench.db', join(root,'prisma'));
  assert.equal(target, resolve(root,'data/bench.db'));
  assert.equal(readFileSync(target).length, 0);
  writeFileSync(target, 'existing SQLite data');
  prepareSqliteFile('file:../data/bench.db', join(root,'prisma'));
  assert.equal(readFileSync(target,'utf8'), 'existing SQLite data');
  assert.throws(() => prepareSqliteFile('postgresql://host/db', root), /SQLite/);
});
