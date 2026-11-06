import type { LaunchOptions } from 'playwright-core';

/** Only explicitly configured global variables apply to the shared user browser. */
export function browserProxy(
  environment: Record<string, string>,
): LaunchOptions['proxy'] {
  const value =
    environment.http_proxy?.trim() || environment.HTTP_PROXY?.trim();
  if (!value) return undefined;

  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (
      !['http:', 'https:', 'socks5:'].includes(url.protocol) ||
      !url.hostname ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    )
      throw new Error();
    // Chromium does not support authenticated SOCKS proxies.
    if (url.protocol === 'socks5:' && (url.username || url.password))
      throw new Error();
    const proxy: NonNullable<LaunchOptions['proxy']> = {
      server: `${url.protocol}//${url.host}`,
    };
    if (url.username || url.password) {
      proxy.username = decodeURIComponent(url.username);
      proxy.password = decodeURIComponent(url.password);
    }
    const bypass = (
      environment.no_proxy?.trim() || environment.NO_PROXY?.trim()
    )
      ?.split(',')
      .map((host) => host.trim())
      .filter(Boolean)
      .join(',');
    if (bypass) proxy.bypass = bypass;
    return proxy;
  } catch {
    // URL parsing errors can contain credentials. Never forward their input/cause.
    throw new Error(
      '浏览器 http_proxy 配置无效：请使用 HTTP(S) 代理地址或无需认证的 SOCKS5 地址',
    );
  }
}
