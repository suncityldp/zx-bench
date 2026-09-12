/** Explicit, credential-free proxy for network-authorized containers only. */
export function containerProxyEnv(networkDisabled: boolean, configured?: string): Record<string, string> {
  if (networkDisabled || !configured) return {};
  const proxy = new URL(configured);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) {
    throw new Error('ZXB_CONTAINER_HTTP_PROXY must be a credential-free HTTP(S) proxy URL');
  }
  return { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href, http_proxy: proxy.href, https_proxy: proxy.href };
}
