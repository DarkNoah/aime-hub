import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { test } from 'node:test';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { installChatRequestLogging } from './request-logging.js';
import type {
  CapturedChatRequest,
  CapturedChatResponse,
} from '@aime/shared/request-logs';

async function upstream(
  respond: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => void,
) {
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    bodies.push(body);
    respond(request, response, body);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const loggedBodies = (logs: string[]) =>
  logs.map((log) => log.slice(log.indexOf('\n') + 1));

test('shortens base64 in console logs while sending and capturing the full request', async () => {
  const fixture = await upstream((_request, response) => response.end('ok'));
  const logs: string[] = [];
  const records: CapturedChatRequest[] = [];
  const dispose = installChatRequestLogging(
    (log) => logs.push(log),
    (record) => records.push(record),
  );
  const payload = Buffer.from('image bytes'.repeat(50)).toString('base64');
  const body = JSON.stringify({
    messages: [{ url: `data:image/png;base64,${payload}` }],
  });
  try {
    await fetch(`${fixture.url}/v1/responses`, { method: 'POST', body }).then(
      (response) => response.text(),
    );
    assert.deepEqual(fixture.bodies, [body]);
    assert.equal(records[0].body, body);
    assert.equal(
      JSON.parse(loggedBodies(logs)[0]).messages[0].url,
      `data:image/png;base64,${payload.slice(0, 30)}…`,
    );
  } finally {
    await dispose();
    await fixture.close();
  }
});

test('logs exact outgoing bodies, including streamed UTF-8, without changing fetch or unrelated requests', async () => {
  const fixture = await upstream((_request, response) => response.end('ok'));
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const records: CapturedChatRequest[] = [];
  const responses: CapturedChatResponse[] = [];
  const dispose = installChatRequestLogging(
    (log) => logs.push(log),
    (record) => records.push(record),
    (response) => responses.push(response),
  );
  assert.equal(installChatRequestLogging(), dispose);
  try {
    const body = JSON.stringify({
      model: 'fixture/model',
      messages: [{ role: 'user', content: '你好🌍'.repeat(4000) }],
      stream: true,
    });
    const bytes = Buffer.from(body);
    // Split every byte so multibyte characters cross chunk boundaries.
    const streamedBody = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const request = new Request(
      `${fixture.url}/v1/responses?api_key=query-secret`,
      {
        method: 'POST',
        body: streamedBody,
        duplex: 'half',
        headers: {
          authorization: 'Bearer header-secret',
          cookie: 'session=cookie-secret',
          'X-THREAD-ID': 'thread-first',
          'x-RESOURCE-id': 'project:resource-first',
          'X-USER-ID': 'user-first',
          'X-PROJECT-ID': 'project-first',
        },
      } as RequestInit,
    );
    await Promise.all([
      fetch(request).then((response) => response.text()),
      fetch(`${fixture.url}/v1/chat/completions`, {
        method: 'POST',
        body: '{ "model": "second", "messages": [] }',
      }).then((response) => response.text()),
      fetch(`${fixture.url}/api/auth`, {
        method: 'POST',
        body: 'unrelated-secret',
      }).then((response) => response.text()),
    ]);
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(logs.length, 2);
    const first = records.find((record) => record.body === body)!;
    assert.equal(first.threadId, 'thread-first');
    assert.equal(first.resourceId, 'project:resource-first');
    assert.equal(first.userId, 'user-first');
    assert.equal(first.projectId, 'project-first');
    const second = records.find((record) => record !== first)!;
    for (const field of [
      'threadId',
      'resourceId',
      'userId',
      'projectId',
    ] as const)
      assert.equal(second[field], null);
    assert.doesNotMatch(
      JSON.stringify(records),
      /header-secret|cookie-secret|query-secret/,
    );
    assert.deepEqual(
      records.map((record) => record.body),
      loggedBodies(logs),
    );
    assert.ok(
      records.every(
        (record) =>
          record.complete && Number.isFinite(Date.parse(record.createdAt)),
      ),
    );
    assert.deepEqual(
      loggedBodies(logs).sort(),
      fixture.bodies.filter((body) => body !== 'unrelated-secret').sort(),
    );
    assert.ok(logs.every((log) => log.includes('body=complete\n')));
    assert.doesNotMatch(
      logs.join('\n'),
      /query-secret|header-secret|unrelated-secret/,
    );
    assert.equal(
      new Set(logs.map((log) => log.match(/id=(\S+)/)?.[1])).size,
      2,
    );
    await dispose();
    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.ok(records.some((record) => record.id === response.id));
      assert.equal(response.httpStatus, 200);
      assert.equal(response.responseBody, 'ok');
      assert.equal(response.responseStatus, 'complete');
      assert.ok(response.durationMs >= 0);
    }
    await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    }).then((response) => response.text());
    assert.equal(logs.length, 2);
  } finally {
    await dispose();
    await fixture.close();
  }
});

test('logs every Mastra HTTP attempt, tool continuation and streaming call', async () => {
  let attempts = 0;
  const headers = {
    'X-THREAD-ID': 'thread-mastra',
    'X-RESOURCE-ID': 'user:mastra',
    'X-USER-ID': 'mastra',
  };
  const receivedHeaders: IncomingMessage['headers'][] = [];
  const fixture = await upstream((request, response, body) => {
    receivedHeaders.push(request.headers);
    attempts++;
    if (attempts === 1) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'retry fixture' } }));
      return;
    }
    const input = JSON.parse(body);
    if (input.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choice of [
        {
          delta: { role: 'assistant', content: 'streamed' },
          finish_reason: null,
        },
        { delta: {}, finish_reason: 'stop' },
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, ...choice }] })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
      return;
    }
    const useTool = !input.messages.some(
      (message: { role: string }) => message.role === 'tool',
    );
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: `completion-${attempts}`,
        object: 'chat.completion',
        created: 1,
        model: input.model,
        choices: [
          {
            index: 0,
            message: useTool
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tool-1',
                      type: 'function',
                      function: {
                        name: 'lookup',
                        arguments: '{"value":"test"}',
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: 'done' },
            finish_reason: useTool ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  const logs: string[] = [];
  const records: CapturedChatRequest[] = [];
  const responses: CapturedChatResponse[] = [];
  const dispose = installChatRequestLogging(
    (log) => logs.push(log),
    (record) => records.push(record),
    (response) => responses.push(response),
  );
  try {
    const agent = new Agent({
      id: 'request-logging-fixture',
      name: 'Request logging fixture',
      instructions: 'Call lookup.',
      model: {
        providerId: 'openai',
        modelId: 'fixture/model',
        url: `${fixture.url}/v1`,
        apiKey: 'fixture-secret',
        api: 'chat',
      },
      tools: {
        lookup: createTool({
          id: 'lookup',
          description: 'Return the value',
          inputSchema: z.object({ value: z.string() }),
          execute: async (input) => ({ result: input.value }),
        }),
      },
    });
    const result = await agent.generate('look up test', {
      maxSteps: 3,
      modelSettings: { maxRetries: 1, headers },
      prepareStep: async () => ({
        modelSettings: { maxOutputTokens: 100, maxRetries: 1, headers },
      }),
    });
    assert.equal(result.text, 'done');
    const streamed = await agent.stream('stream test', {
      modelSettings: { maxRetries: 0, headers },
      prepareStep: async () => ({
        modelSettings: { maxOutputTokens: 100, maxRetries: 0, headers },
      }),
    });
    assert.equal(await streamed.text, 'streamed');
    await dispose();
    assert.deepEqual(
      responses.map((response) => response.httpStatus),
      [500, 200, 200, 200],
    );
    assert.deepEqual(
      responses.map((response) => response.id),
      records.map((record) => record.id),
    );
    assert.equal(
      JSON.parse(responses[0].responseBody!).error.message,
      'retry fixture',
    );
    assert.match(responses[3].responseBody!, /data: \[DONE\]\n\n$/);
    assert.equal(responses[3].responseContentType, 'text/event-stream');
    assert.equal(attempts, 4);
    for (const received of receivedHeaders) {
      for (const [name, value] of Object.entries(headers))
        assert.equal(received[name.toLowerCase()], value);
      assert.equal(received['x-project-id'], undefined);
    }
    assert.equal(records.length, attempts);
    for (const record of records) {
      assert.equal(record.threadId, headers['X-THREAD-ID']);
      assert.equal(record.resourceId, headers['X-RESOURCE-ID']);
      assert.equal(record.userId, headers['X-USER-ID']);
      assert.equal(record.projectId, null);
    }
    assert.deepEqual(loggedBodies(logs), fixture.bodies);
    assert.equal(JSON.parse(fixture.bodies[0]).model, 'fixture/model');
    assert.ok(
      JSON.parse(fixture.bodies[2]).messages.some(
        (message: { role: string }) => message.role === 'tool',
      ),
    );
    assert.doesNotMatch(logs.join('\n'), /fixture-secret/);
  } finally {
    await dispose();
    await fixture.close();
  }
});

test('a failed log sink does not fail the HTTP request', async () => {
  const fixture = await upstream((_request, response) => response.end('ok'));
  const fail = () => {
    throw new Error('log sink unavailable');
  };
  const dispose = installChatRequestLogging(fail, fail, fail);
  try {
    const response = await fetch(`${fixture.url}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(await response.text(), 'ok');
  } finally {
    await dispose();
    await fixture.close();
  }
});

test('an aborted upload logs only sent bytes and marks the body incomplete', async () => {
  let received!: () => void;
  const firstChunk = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer((request) => {
    request.once('data', received);
    request.on('error', () => {});
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const logs: string[] = [];
  const records: CapturedChatRequest[] = [];
  const dispose = installChatRequestLogging(
    (log) => logs.push(log),
    (record) => records.push(record),
  );
  const controller = new AbortController();
  const prefix = '{"messages":["你好';
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(Buffer.from(prefix));
    },
  });
  try {
    const response = fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: 'POST',
        body,
        duplex: 'half',
        signal: controller.signal,
        headers: { 'X-THREAD-ID': 'thread-aborted', 'X-PROJECT-ID': ' ' },
      } as RequestInit,
    );
    await firstChunk;
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /body=incomplete\n/);
    assert.deepEqual(loggedBodies(logs), [prefix]);
    assert.equal(records[0].threadId, 'thread-aborted');
    assert.equal(records[0].projectId, null);
  } finally {
    controller.abort();
    await dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

for (const encoding of ['identity', 'gzip', 'deflate', 'br'] as const) {
  test(`captures delayed ${encoding} responses and full duration without buffering delivery`, async () => {
    const responseBody = 'data: {"delta":"你好🌍"}\n\ndata: [DONE]\n\n';
    const raw = Buffer.from(responseBody);
    const bytes =
      encoding === 'identity'
        ? raw
        : {
            gzip: gzipSync,
            deflate: deflateSync,
            br: brotliCompressSync,
          }[encoding](raw);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await upstream((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'content-encoding': encoding,
        'set-cookie': 'response-secret=do-not-log',
      });
      // Split in the middle of a UTF-8 character for the identity response.
      const split =
        encoding === 'identity' ? raw.indexOf(Buffer.from('你')) + 1 : 5;
      response.write(bytes.subarray(0, split));
      void gate.then(() => response.end(bytes.subarray(split)));
    });
    const requests: CapturedChatRequest[] = [];
    const responses: CapturedChatResponse[] = [];
    const dispose = installChatRequestLogging(
      () => {},
      (r) => requests.push(r),
      (r) => responses.push(r),
    );
    try {
      const response = await fetch(`${fixture.url}/v1/responses`, {
        method: 'POST',
        body: '{}',
      });
      assert.equal(requests.length, 1);
      assert.equal(responses.length, 0);
      const reader = response.body!.getReader();
      let prefix = Buffer.alloc(0);
      if (encoding === 'identity') {
        const first = await reader.read();
        assert.equal(first.done, false);
        prefix = Buffer.from(first.value!);
        assert.ok(prefix.length < raw.length);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Disposing while the response is still open must retain its final log.
      const closing = dispose();
      release();
      const chunks = [prefix];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      await closing;
      assert.equal(Buffer.concat(chunks).toString('utf8'), responseBody);
      assert.equal(responses.length, 1);
      const captured = responses[0];
      assert.equal(captured.id, requests[0].id);
      assert.equal(captured.responseBody, responseBody);
      assert.equal(captured.responseBytes, bytes.length);
      assert.equal(captured.responseBodyEncoding, 'utf8');
      assert.equal(captured.responseContentEncoding, encoding);
      assert.equal(captured.responseStatus, 'complete');
      assert.ok(
        captured.durationMs >= 50,
        `duration was ${captured.durationMs} ms`,
      );
      assert.doesNotMatch(
        JSON.stringify(captured),
        /response-secret|do-not-log/,
      );
    } finally {
      release();
      await dispose();
      await fixture.close();
    }
  });
}

test('captures the received SSE prefix on abort without changing request send status', async () => {
  const prefix = 'data: {"delta":"你好"}\n\n';
  const fixture = await upstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(prefix);
  });
  const requests: CapturedChatRequest[] = [];
  const responses: CapturedChatResponse[] = [];
  const dispose = installChatRequestLogging(
    () => {},
    (r) => requests.push(r),
    (r) => responses.push(r),
  );
  const controller = new AbortController();
  try {
    const response = await fetch(`${fixture.url}/v1/responses`, {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read());
    await dispose();
    assert.equal(requests[0].complete, true);
    assert.equal(responses[0].id, requests[0].id);
    assert.equal(responses[0].responseStatus, 'incomplete');
    assert.equal(responses[0].httpStatus, 200);
    assert.equal(responses[0].responseBody, prefix);
    assert.equal(responses[0].responseBytes, Buffer.byteLength(prefix));
  } finally {
    controller.abort();
    await dispose();
    await fixture.close();
  }
});

test('records connection failures before any body is sent, and empty HTTP responses', async () => {
  const fixture = await upstream((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const requests: CapturedChatRequest[] = [];
  const responses: CapturedChatResponse[] = [];
  const dispose = installChatRequestLogging(
    () => {},
    (r) => requests.push(r),
    (r) => responses.push(r),
  );
  try {
    await fetch(`${fixture.url}/v1/responses`, { method: 'POST' }).then((r) =>
      r.text(),
    );
    await fixture.close();
    await assert.rejects(
      fetch(`${fixture.url}/v1/responses`, { method: 'POST', body: '{}' }),
    );
    await dispose();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, '');
    assert.equal(responses[0].httpStatus, 204);
    assert.equal(responses[0].responseBody, '');
    assert.equal(responses[0].responseStatus, 'complete');
    assert.equal(requests[1].complete, false);
    assert.equal(requests[1].body, '');
    assert.equal(responses[1].httpStatus, null);
    assert.equal(responses[1].responseBody, null);
    assert.equal(responses[1].responseStatus, 'incomplete');
    assert.ok(responses[1].durationMs >= 0);
  } finally {
    await dispose();
  }
});
