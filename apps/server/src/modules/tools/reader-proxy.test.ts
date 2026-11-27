import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { defaultWebFetchConfig } from '@aime/shared/tools';
import { LocalProvider } from '../../mastra/providers/local.js';
import { readerProxy } from '../../mastra/web/reader-proxy.js';
import { createWebFetchTool } from '../../mastra/tools/web_fetch.js';
import { noopObserve } from '@mastra/core/tools';
import { ToolService } from './service.js';

test('reader proxy selection uses the HTTPS reader host and the scoped environment', () => {
  const url = 'https://r.jina.ai';
  const env = {
    HTTPS_PROXY: 'secure-proxy:7890',
    all_proxy: 'socks5h://all:1080',
    http_proxy: 'http://last:80',
  };
  assert.equal(readerProxy(url, env)?.host, 'secure-proxy:7890');
  assert.equal(
    readerProxy(url, { ...env, https_proxy: '' })?.href,
    'socks5://all:1080',
  );
  assert.equal(
    readerProxy(url, { http_proxy: env.http_proxy })?.hostname,
    'last',
  );
  assert.equal(readerProxy(url, {}), undefined);
  assert.equal(readerProxy('http://reader.internal', env), undefined);
  for (const no_proxy of ['*', 'localhost, .jina.ai:443', 'r.jina.ai']) {
    assert.equal(readerProxy(url, { ...env, no_proxy }), undefined);
  }
  assert.ok(
    readerProxy(url, { ...env, NO_PROXY: 'cffex.com.cn, r.jina.ai:8080' }),
  );
  assert.throws(
    () => readerProxy(url, { https_proxy: 'bad://secret@proxy.test' }),
    {
      message: 'Invalid reader proxy configuration',
    },
  );
});

test('web_fetch opens an authenticated Jina tunnel using the live execution scope and falls back on proxy failure', async (t) => {
  const originalPolicy = process.env.ALLOW_ALL_NETWORKS;
  process.env.ALLOW_ALL_NETWORKS = 'true';
  t.after(() => {
    if (originalPolicy === undefined) delete process.env.ALLOW_ALL_NETWORKS;
    else process.env.ALLOW_ALL_NETWORKS = originalPolicy;
  });
  const tunnels: Array<{ host?: string; proxyAuth?: string; auth?: string }> =
    [];
  const proxy = createServer();
  proxy.on('connect', (req, socket) => {
    tunnels.push({
      host: req.url,
      proxyAuth: req.headers['proxy-authorization'],
      auth: req.headers.authorization,
    });
    socket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n',
    );
  });
  await new Promise<void>((resolve, reject) =>
    proxy.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const address = proxy.address();
  assert.ok(address && typeof address === 'object');
  t.mock.method(LocalProvider.prototype, 'webFetch', async (url: string) => ({
    url,
    content: 'Local fallback',
  }));
  const provider = {
    id: 'reader',
    type: 'jina-ai',
    baseUrl: 'https://reader.invalid',
    enabled: true,
    apiKey: 'reader-test-token',
  };
  const database = {
    getRepository: () => ({
      findOneBy: async () => ({
        value: { ...defaultWebFetchConfig, providerId: provider.id },
      }),
    }),
  } as unknown as ConstructorParameters<typeof ToolService>[0];
  const providers = {
    getProvider: async () => provider,
  } as unknown as ConstructorParameters<typeof ToolService>[1];
  const scopes: Array<[string | undefined, string | undefined]> = [];
  const service = new ToolService(
    database,
    providers,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async getEnv(userId, projectId) {
        scopes.push([userId, projectId]);
        return {
          http_proxy: 'http://proxy-user:test@127.0.0.1:' + address.port,
        };
      },
    },
  );
  const tool = (await service.buildTools(['web_fetch']))
    .web_fetch as ReturnType<typeof createWebFetchTool>;
  for (const scope of ['personal', 'project', 'system']) {
    const requestContext = new RequestContext();
    requestContext.set('userId', 'alice');
    if (scope === 'project') requestContext.set('projectId', 'p');
    if (scope === 'system') requestContext.set('systemEnvironment', true);
    const result = await tool.execute!(
      { url: 'https://1.1.1.1/article' },
      { requestContext, observe: noopObserve },
    );
    assert.ok(result && 'fallback' in result);
    assert.equal(result.fallback, true);
    assert.equal(result.provider, 'local');
  }
  assert.deepEqual(scopes, [
    ['alice', undefined],
    [undefined, 'p'],
    [undefined, undefined],
  ]);
  assert.deepEqual(
    tunnels,
    scopes.map(() => ({
      host: 'reader.invalid:443',
      proxyAuth: 'Basic ' + Buffer.from('proxy-user:test').toString('base64'),
      auth: undefined,
    })),
  );
});
