import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { afterEach, beforeEach } from 'node:test';
import { requestProviderJson } from '../apps/server/src/modules/providers/network.js';
import {
  publicWebAddress,
  requestWebResource,
} from '../apps/server/src/mastra/web/request.js';
import { XinferenceProvider } from '../apps/server/src/mastra/providers/xinference.js';
import { NewApiProvider } from '../apps/server/src/mastra/providers/newapi.js';
import { createImageModel } from '../apps/server/src/mastra/providers/image-model.js';
import { JinaAIProvider } from '../apps/server/src/mastra/providers/jina-ai.js';

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.ALLOW_ALL_NETWORKS;
  delete process.env.ALLOW_ALL_NETWORKS;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ALLOW_ALL_NETWORKS;
  else process.env.ALLOW_ALL_NETWORKS = previous;
});

const signal = () => AbortSignal.timeout(3000);
const config = {
  id: 'local-test',
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'synthetic-key',
};

test('network access stays restricted unless explicitly enabled', async () => {
  for (const value of [undefined, 'false', '1', 'TRUE']) {
    if (value === undefined) delete process.env.ALLOW_ALL_NETWORKS;
    else process.env.ALLOW_ALL_NETWORKS = value;
    await assert.rejects(requestProviderJson(config.baseUrl), {
      code: 'INVALID_URL',
    });
    await assert.rejects(
      requestProviderJson('http://8.8.8.8/models', config.apiKey),
      { code: 'INVALID_URL' },
    );
    for (const url of [
      config.baseUrl,
      'http://169.254.169.254',
      'http://[::1]',
    ])
      await assert.rejects(requestWebResource(url, { signal: signal() }), {
        code: 'INVALID_URL',
      });
    assert.throws(() => new NewApiProvider(config));
    assert.throws(() => createImageModel(config, 'image-model'));
    await assert.rejects(
      new JinaAIProvider({ ...config, timeoutMs: 1000 }).webFetch(
        'https://example.com',
      ),
      /Invalid reader provider configuration/,
    );
  }
});

test('opt-in accepts private, loopback and link-local IPv4 and IPv6 addresses', async () => {
  process.env.ALLOW_ALL_NETWORKS = 'true';
  for (const host of [
    '10.0.0.1',
    '172.16.0.1',
    '192.168.10.4',
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    '[fd00::1]',
    '[::ffff:192.168.10.4]',
  ]) {
    const address = await publicWebAddress(`http://${host}:9997`, signal());
    assert.ok(address.address);
  }
  for (const url of ['file:///etc/passwd', 'http://user:pass@127.0.0.1']) {
    await assert.rejects(requestWebResource(url, { signal: signal() }), {
      code: 'INVALID_URL',
    });
    await assert.rejects(requestProviderJson(url), { code: 'INVALID_URL' });
  }
});

test('opt-in enables real HTTP provider and web requests; disabling restores isolation', async (t) => {
  const requests: { url?: string; authorization?: string }[] = [];
  const models = {
    data: [{ id: 'local-embedding', model_type: 'embedding' }],
  };
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/must-not-follow' }).end();
    } else if (req.url === '/reader') {
      res.end('Local reader content');
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(models));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const local = { ...config, baseUrl };
  process.env.ALLOW_ALL_NETWORKS = 'true';

  assert.deepEqual(
    await requestProviderJson(`${baseUrl}/v1/models`, config.apiKey),
    models,
  );
  assert.equal(requests.at(-1)?.authorization, `Bearer ${config.apiKey}`);
  await requestProviderJson(`${baseUrl}/v1/models`, config.apiKey, 1000, {
    apiKeyParameter: 'api_key',
  });
  assert.equal(requests.at(-1)?.url, '/v1/models?api_key=synthetic-key');
  assert.equal(requests.at(-1)?.authorization, undefined);

  const discovered = await new XinferenceProvider(local).getModelList();
  assert.equal(discovered[0]?.modelType, 'embedding');
  assert.equal(requests.at(-1)?.url, '/v1/models');
  assert.equal(requests.at(-1)?.authorization, `Bearer ${config.apiKey}`);
  assert.equal(
    (await new NewApiProvider(local).getLanguageModelList())[0]?.id,
    'local-embedding',
  );
  assert.doesNotThrow(() => createImageModel(local, 'image-model'));
  assert.equal(
    (
      await new JinaAIProvider({
        ...local,
        baseUrl: `${baseUrl}/reader`,
        timeoutMs: 3000,
      }).webFetch(baseUrl)
    ).content,
    'Local reader content',
  );

  const page = await requestWebResource(`${baseUrl}/v1/models`, {
    signal: signal(),
  });
  assert.equal(page.status, 200);
  assert.deepEqual(JSON.parse(page.body.toString()), models);
  assert.equal(
    (await requestWebResource(`${baseUrl}/redirect`, { signal: signal() }))
      .status,
    302,
  );
  await assert.rejects(
    requestProviderJson(`${baseUrl}/redirect`, config.apiKey),
    { code: 'UPSTREAM_ERROR' },
  );
  assert.equal(
    requests.some((req) => req.url === '/must-not-follow'),
    false,
  );
  await assert.rejects(
    requestWebResource(baseUrl, { signal: signal(), maxBytes: 2 }),
    { code: 'TOO_LARGE' },
  );
  await assert.rejects(requestProviderJson(baseUrl, config.apiKey, 2), {
    code: 'UPSTREAM_ERROR',
  });

  const count = requests.length;
  const abort = AbortSignal.abort(new Error('test cancellation'));
  await assert.rejects(
    requestWebResource(baseUrl, { signal: abort }),
    /test cancellation/,
  );
  process.env.ALLOW_ALL_NETWORKS = 'false';
  await assert.rejects(new XinferenceProvider(local).getModelList(), {
    code: 'INVALID_URL',
  });
  await assert.rejects(requestProviderJson(baseUrl), { code: 'INVALID_URL' });
  assert.equal(requests.length, count);
});
