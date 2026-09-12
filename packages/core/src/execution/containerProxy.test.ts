import { describe, it, expect } from 'vitest';
import { containerProxyEnv } from './containerProxy.js';
describe('explicit network-only proxy', () => {
  it('does not give offline tests a proxy or inherit host environment credentials', () => {
    expect(containerProxyEnv(true, 'http://host.docker.internal:7890')).toEqual({});
    expect(containerProxyEnv(false)).toEqual({});
  });
  it('sets a configured proxy for network-authorized tests', () => {
    expect(containerProxyEnv(false, 'http://host.docker.internal:7890').HTTPS_PROXY).toBe('http://host.docker.internal:7890/');
  });
  it.each(['http://user:secret@proxy:8080', 'file:///tmp/proxy', 'http://proxy/?secret=x'])('rejects secret-bearing or non-HTTP proxy: %s', value => {
    expect(() => containerProxyEnv(false, value)).toThrow();
  });
});
