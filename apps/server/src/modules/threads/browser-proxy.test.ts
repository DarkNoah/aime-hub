import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { LaunchOptions } from 'playwright-core';
import { chromium } from '../../lib/browser.js';
import { ThreadBrowser } from './browser.js';
import { browserProxy } from './browser/proxy.js';
import { createChatRunner } from './runner.js';

test('browser proxy is optional and accepts lowercase or uppercase global settings', () => {
  assert.equal(browserProxy({}), undefined);
  assert.equal(browserProxy({ http_proxy: '  ', HTTP_PROXY: '' }), undefined);
  assert.deepEqual(browserProxy({ http_proxy: ' proxy.test:7890 ' }), {
    server: 'http://proxy.test:7890',
  });
  assert.deepEqual(browserProxy({ HTTP_PROXY: 'https://proxy.test:8443/' }), {
    server: 'https://proxy.test:8443',
  });
  assert.deepEqual(browserProxy({ http_proxy: 'socks5://proxy.test:1080' }), {
    server: 'socks5://proxy.test:1080',
  });
});

test('browser proxy separates encoded credentials and normalizes bypass rules', () => {
  assert.deepEqual(
    browserProxy({
      http_proxy: 'http://user%40name:p%3Ass%2Fword@proxy.test:7890',
      HTTP_PROXY: 'http://ignored.test:8888',
      no_proxy: ' localhost, 127.0.0.1, , .example.com ',
      NO_PROXY: 'ignored.test',
    }),
    {
      server: 'http://proxy.test:7890',
      username: 'user@name',
      password: 'p:ss/word',
      bypass: 'localhost,127.0.0.1,.example.com',
    },
  );
  assert.deepEqual(
    browserProxy({ HTTP_PROXY: '[::1]:7890', NO_PROXY: '*.internal, *' }),
    { server: 'http://[::1]:7890', bypass: '*.internal,*' },
  );
});

test('invalid browser proxy settings fail without exposing credentials or falling back to direct access', () => {
  for (const value of [
    'http://user:secret@',
    'ftp://user:secret@proxy.test',
    'http://proxy.test:bad',
    'http://user:secret@proxy.test/path',
    'http://proxy.test?secret',
    'http://proxy.test#secret',
    'http://user:secret%ZZ@proxy.test',
    'socks5://user:secret@proxy.test:1080',
  ]) {
    assert.throws(
      () =>
        browserProxy({ http_proxy: value, HTTP_PROXY: 'http://fallback.test' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /http_proxy 配置无效/);
        assert.doesNotMatch(error.stack ?? '', /secret/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'browser-proxy-'));
  let environment: Record<string, string> = {};
  const reads: unknown[][] = [];
  const runner = createChatRunner(
    { getStorage: () => ({}) } as never,
    {} as never,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      async getEnv(...scope) {
        reads.push(scope);
        return environment;
      },
    },
  );
  const browsers = runner.browsers!;
  t.after(async () => {
    await browsers.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    reads,
    browsers,
    configure(value: Record<string, string>) {
      environment = value;
    },
  };
}

test('chat runner loads only global proxy variables at launch, including retries after configuration changes', async (t) => {
  const { browsers, configure, reads } = await fixture(t);
  const proxies: LaunchOptions['proxy'][] = [];
  const stopped = new Error('Launch captured');
  t.mock.method(
    chromium,
    'launchPersistentContext',
    async (_path: string, options?: LaunchOptions) => {
      proxies.push(options?.proxy);
      throw stopped;
    },
  );
  const browser = browsers.acquire('project-thread', 'alice')
    .browser as ThreadBrowser;
  assert.deepEqual(reads, []);
  configure({ http_proxy: 'http://proxy.test:7890', no_proxy: 'localhost' });
  await assert.rejects(browser.ensureReady(), stopped);
  configure({ HTTP_PROXY: 'http://second.test:8888' });
  await assert.rejects(browser.ensureReady(), stopped);
  configure({});
  await assert.rejects(browser.ensureReady(), stopped);
  assert.deepEqual(reads, [[], [], []]);
  assert.deepEqual(proxies, [
    { server: 'http://proxy.test:7890', bypass: 'localhost' },
    { server: 'http://second.test:8888' },
    undefined,
  ]);
});

async function listen(t: TestContext, server: Server) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

test(
  'real user browser proxies HTTP/HTTPS and resources with authentication, bypasses excluded hosts and reloads settings after close',
  { skip: process.env.BROWSER_INTEGRATION !== '1', timeout: 60000 },
  async (t) => {
    const { root, browsers, configure, reads } = await fixture(t);
    const key = join(root, 'key.pem');
    const cert = join(root, 'cert.pem');
    await promisify(execFile)('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=browser-proxy.invalid',
    ]);
    const securePort = await listen(
      t,
      createHttpsServer(
        { key: await readFile(key), cert: await readFile(cert) },
        (_req, res) =>
          res.end('<html><title>Secure through proxy</title></html>'),
      ),
    );
    let directHits = 0;
    const directPort = await listen(
      t,
      createServer((_req, res) => {
        directHits++;
        res.end('<html><title>Direct</title></html>');
      }),
    );
    const hits: string[] = [];
    const tunnels: string[] = [];
    const authorization = `Basic ${Buffer.from('browser:sec:ret').toString('base64')}`;
    const proxy = createServer((req, res) => {
      if (!req.url?.startsWith('http://browser-proxy.invalid/')) {
        res.writeHead(502).end();
        return;
      }
      if (req.headers['proxy-authorization'] !== authorization) {
        res
          .writeHead(407, {
            'Proxy-Authenticate': 'Basic realm="browser-test"',
          })
          .end();
        return;
      }
      hits.push(req.url);
      if (req.url.endsWith('/script.js')) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end('document.title = "HTTP through proxy";');
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<html><script src="/script.js"></script><body>Proxied page</body></html>',
        );
      }
    });
    proxy.on('connect', (req, socket, head) => {
      if (req.url !== 'browser-proxy.invalid:443') {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        return;
      }
      if (req.headers['proxy-authorization'] !== authorization) {
        socket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="browser-test"\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      tunnels.push(req.url);
      const upstream = connect(securePort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    const proxyPort = await listen(t, proxy);
    configure({
      http_proxy: `http://browser:sec%3Aret@127.0.0.1:${proxyPort}`,
      no_proxy: '127.0.0.1',
    });
    const browser = browsers.acquire('thread', 'alice')
      .browser as ThreadBrowser;
    await browser.ensureReady();
    const manager = await browser.getManagerForThread('thread');
    const page = manager.getPage();
    await page.goto('http://browser-proxy.invalid/article');
    assert.equal(await page.title(), 'HTTP through proxy');
    assert.ok(hits.includes('http://browser-proxy.invalid/article'));
    assert.ok(hits.includes('http://browser-proxy.invalid/script.js'));

    // Trust only this test's self-signed origin, without weakening production TLS.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
    await page.goto('https://browser-proxy.invalid/secure');
    assert.equal(await page.title(), 'Secure through proxy');
    assert.ok(tunnels.includes('browser-proxy.invalid:443'));
    await cdp.detach();
    await page.goto(`http://127.0.0.1:${directPort}/bypassed`);
    assert.equal(await page.title(), 'Direct');
    assert.ok(directHits > 0);

    configure({ http_proxy: 'invalid://proxy' });
    await browser.ensureReady();
    const other = browsers.acquire('other-thread', 'alice')
      .browser as ThreadBrowser;
    await other.ensureReady();
    assert.equal(reads.length, 1);
    assert.equal(
      (await other.getManagerForThread('other-thread')).getContext(),
      page.context(),
    );
    await browser.close();
    await assert.rejects(browser.ensureReady(), /http_proxy 配置无效/);

    configure({});
    await browser.ensureReady();
    const reopened = (await browser.getManagerForThread('thread')).getPage();
    assert.notEqual(reopened.context(), page.context());
    await reopened.goto(`http://127.0.0.1:${directPort}/without-proxy`);
    assert.equal(await reopened.title(), 'Direct');
    assert.deepEqual(reads, [[], [], []]);
  },
);
