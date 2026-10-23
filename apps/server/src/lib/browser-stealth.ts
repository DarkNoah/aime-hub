import { createRequire } from 'node:module';

type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

type CompatiblePage = {
  _client: CdpClient | (() => CdpClient);
  browser(): { userAgent(): Promise<string>; version(): Promise<string> };
};

type UserAgentPlugin = {
  _isPuppeteerExtraPlugin: boolean;
  name: string;
  onPageCreated(page: CompatiblePage): Promise<void>;
};

// This upstream evasion has no TypeScript declaration. Reuse its UA, platform
// and client-hint calculation without changing the installed dependency.
const userAgentPlugin = createRequire(import.meta.url)(
  'puppeteer-extra-plugin-stealth/evasions/user-agent-override',
) as (options?: Record<string, unknown>) => UserAgentPlugin;

export function createUserAgentPlugin(options?: Record<string, unknown>) {
  const plugin = userAgentPlugin(options);
  const onPageCreated = plugin.onPageCreated.bind(plugin);
  plugin.onPageCreated = async (page) => {
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    const wrappedPage = new Proxy(page, {
      get(target, property) {
        if (property !== '_client') return Reflect.get(target, property);
        const client =
          typeof target._client === 'function'
            ? target._client()
            : target._client;
        const wrappedClient: CdpClient = {
          send(method, params) {
            const command = client.send(method, params);
            // Upstream 2.11.2 does not await/return this promise. Observe it
            // immediately, then propagate failure through onPageCreated so
            // playwright-extra's plugin error handler can handle it.
            pending.push(
              command.then(
                (value) => ({ status: 'fulfilled', value }),
                (reason: unknown) => ({ status: 'rejected', reason }),
              ),
            );
            return command;
          },
        };
        return typeof target._client === 'function'
          ? () => wrappedClient
          : wrappedClient;
      },
    });
    let results: PromiseSettledResult<unknown>[];
    try {
      await onPageCreated(wrappedPage);
    } finally {
      results = await Promise.all(pending);
    }
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  };
  return plugin;
}
