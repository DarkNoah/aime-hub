/** Only the HTTPS reader endpoint may receive a provider key via a scoped tunnel. */
export function readerProxy(
  reader: string,
  env: Record<string, string>,
): URL | undefined {
  const target = new URL(reader);
  if (target.protocol !== 'https:') return;
  const setting = (name: string) =>
    (env[name] ?? env[name.toUpperCase()])?.trim();
  const value =
    setting('https_proxy') || setting('all_proxy') || setting('http_proxy');
  if (!value) return;
  const bypass = setting('no_proxy')
    ?.toLowerCase()
    .split(/[,\s]+/);
  const hostname = target.hostname.toLowerCase();
  if (
    bypass?.some((entry) => {
      if (entry === '*') return true;
      const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
      if (!match || (match[2] && match[2] !== (target.port || '443')))
        return false;
      const domain = match[1]!.replace(/^\*?\./, '');
      return hostname === domain || hostname.endsWith('.' + domain);
    })
  )
    return;
  try {
    const proxy = new URL(value.includes('://') ? value : 'http://' + value);
    if (proxy.protocol === 'socks5h:') proxy.protocol = 'socks5:';
    if (
      !['http:', 'https:', 'socks5:'].includes(proxy.protocol) ||
      !proxy.hostname ||
      (proxy.pathname && proxy.pathname !== '/') ||
      proxy.search ||
      proxy.hash
    )
      throw new Error();
    return proxy;
  } catch {
    throw new Error('Invalid reader proxy configuration');
  }
}
