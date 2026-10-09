import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { installChatRequestLogging } from './request-logging.js';
import type { CapturedChatRequest } from '@aime/shared/request-logs';

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

test('logs exact outgoing bodies, including streamed UTF-8, without changing fetch or unrelated requests', async () => {
  const fixture = await upstream((_request, response) => response.end('ok'));
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const records: CapturedChatRequest[] = [];
  const dispose = installChatRequestLogging(
    (log) => logs.push(log),
    (record) => records.push(record),
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
        headers: { authorization: 'Bearer header-secret' },
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
  const fixture = await upstream((_request, response, body) => {
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
  const dispose = installChatRequestLogging((log) => logs.push(log));
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
      modelSettings: { maxRetries: 1 },
    });
    assert.equal(result.text, 'done');
    const streamed = await agent.stream('stream test', {
      modelSettings: { maxRetries: 0 },
    });
    assert.equal(await streamed.text, 'streamed');
    assert.equal(attempts, 4);
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
  const dispose = installChatRequestLogging(() => {
    throw new Error('log sink unavailable');
  });
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
  const dispose = installChatRequestLogging((log) => logs.push(log));
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
      } as RequestInit,
    );
    await firstChunk;
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /body=incomplete\n/);
    assert.deepEqual(loggedBodies(logs), [prefix]);
  } finally {
    controller.abort();
    await dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});
