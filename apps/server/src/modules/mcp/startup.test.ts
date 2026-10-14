import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { initializeMcpAfterListen } from './startup.js';

function close(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

test('HTTP responds while MCP discovery is pending', async (t) => {
  let release!: () => void;
  const discovery = new Promise<{ connected: number; failed: number }>(
    (resolve) => {
      release = () => resolve({ connected: 0, failed: 0 });
    },
  );
  let started = false;
  const server = createServer((_request, response) => response.end('ready'));
  t.after(async () => {
    release();
    await close(server);
  });
  initializeMcpAfterListen(server, {
    initialize: () => {
      started = true;
      return discovery;
    },
  });
  assert.equal(started, false);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  assert.equal(started, true);
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}`, {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(await response.text(), 'ready');
});

test('an occupied API port never starts MCP discovery', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const server = createServer();
  t.after(async () => {
    await close(server);
    await close(occupied);
  });
  let started = false;
  initializeMcpAfterListen(server, {
    initialize: async () => {
      started = true;
      return { connected: 0, failed: 0 };
    },
  });
  server.listen((occupied.address() as AddressInfo).port, '127.0.0.1');
  await assert.rejects(once(server, 'listening'), { code: 'EADDRINUSE' });
  assert.equal(started, false);
});

test('MCP initialization rejection is contained and does not expose credentials', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const server = createServer();
  t.after(() => close(server));
  initializeMcpAfterListen(server, {
    initialize: async () => {
      throw new Error('secret=credential');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.listening, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('secret'), false);
});
