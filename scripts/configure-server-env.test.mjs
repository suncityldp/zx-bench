import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureServerEnv } from './configure-server-env.mjs';

test('creates a private random key without printing it and preserves an existing deployment on rerun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zxbench-env-'));
  const path = join(dir, '.env');
  try {
    const result = configureServerEnv(path, 31011);
    const content = readFileSync(path, 'utf8');
    const key = content.match(/ZXBENCH_ENCRYPTION_KEY=([a-f0-9]{64})/)[1];
    assert.match(content, /PORT=31011\n/);
    assert.equal(result.created, true);
    assert(!JSON.stringify(result).includes(key));
    assert.equal(configureServerEnv(path, 3001).created, false);
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.throws(() => configureServerEnv(path, 70000), /Invalid/);
  } finally { unlinkSync(path); rmdirSync(dir); }
});
