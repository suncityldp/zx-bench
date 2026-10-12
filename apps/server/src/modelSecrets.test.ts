import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCipheriv, scryptSync } from 'node:crypto';
import { encryptApiKey, decryptApiKey, maskApiKey } from './modelSecrets.js';

afterEach(() => vi.unstubAllEnvs());
function storedWith(secret:string, plain:string) {
  const iv=Buffer.alloc(16,1),cipher=createCipheriv('aes-256-cbc',scryptSync(secret,'zxbench-salt',32),iv);
  return iv.toString('hex')+':'+cipher.update(plain,'utf8','hex')+cipher.final('hex');
}
describe('model credentials after environment loading', () => {
  it('uses the configured key even when the module was imported before .env loaded', () => {
    vi.stubEnv('ZXBENCH_ENCRYPTION_KEY','test-only-late-loaded-key');
    const encrypted=encryptApiKey('test-only-api-key');
    const [iv,data]=encrypted.split(':');
    expect(encrypted).toMatch(/^[a-f0-9]{32}:[a-f0-9]+$/);
    expect(decryptApiKey(encrypted)).toBe('test-only-api-key');
    expect(decryptApiKey(storedWith('test-only-late-loaded-key','external-fixture'))).toBe('external-fixture');
    expect(encrypted).not.toContain('test-only-api-key');
    expect(iv).toHaveLength(32);expect(data.length).toBeGreaterThan(0);
    vi.stubEnv('ZXBENCH_ENCRYPTION_KEY','different-test-key');
    expect(()=>decryptApiKey(encrypted)).toThrow();
  });
  it('reads records from the old pre-.env default without writing with it', () => {
    const old=storedWith('zxbench-default-key-change-me!','legacy-test-token');
    vi.stubEnv('ZXBENCH_ENCRYPTION_KEY','test-only-upgrade-key');
    expect(decryptApiKey(old)).toBe('legacy-test-token');
    const current=encryptApiKey(decryptApiKey(old));
    vi.stubEnv('ZXBENCH_ENCRYPTION_KEY','zxbench-default-key-change-me!');
    expect(()=>decryptApiKey(current)).toThrow();
  });
  it('preserves plaintext legacy values and credential masking', () => {
    expect(decryptApiKey('legacy-test-token')).toBe('legacy-test-token');
    expect(maskApiKey('short')).toBe('*hort');expect(maskApiKey(null)).toBeNull();
    expect(maskApiKey('abc')).toBe('****');
  });
});
