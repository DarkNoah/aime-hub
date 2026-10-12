import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { InMemoryStore } from '@mastra/core/storage';
import { isValidationError, noopObserve } from '@mastra/core/tools';
import { createExecTool } from '../../mastra/tools/exec.js';
import { McpService } from './service.js';

const tool = {
  name: 'read',
  description: 'Read a fixture value',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path to read' } },
  },
};
function reply(
  request: {
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
  },
  value: string,
  catalog = [tool],
) {
  if (request.id === undefined) return undefined;
  const result =
    request.method === 'initialize'
      ? {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'fixture', version: '1.0.0' },
          capabilities: { tools: {} },
        }
      : request.method === 'tools/list'
        ? { tools: catalog }
        : request.method === 'tools/call'
          ? { content: [{ type: 'text', text: value }] }
          : request.method === 'ping'
            ? {}
            : undefined;
  return result
    ? { jsonrpc: '2.0', id: request.id, result }
    : {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' },
      };
}

test(
  'real Mastra SDK connects to Stdio, reads tools and reuses one child for execution',
  { timeout: 25000 },
  async (t) => {
    const service = new McpService(
      (await new InMemoryStore().getStore('mcpClients'))!,
    );
    t.after(() => service.shutdown());
    // Single-line script is a literal argv value, not shell interpolation.
    const script = `const tool = ${JSON.stringify(tool)}; const reply = ${reply.toString().replace(/\n/g, ' ')}; require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const result = reply(JSON.parse(line), process.env.MCP_FIXTURE_VALUE); if (result) process.stdout.write(JSON.stringify(result) + '\\n'); });`;
    const [draft] = await service.create('admin', {
      servers: [
        {
          name: 'stdio_fixture',
          config: {
            command: process.execPath,
            args: ['-e', script],
            env: { MCP_FIXTURE_VALUE: 'stdio=a=b==' },
          },
        },
      ],
    });
    const published = await service.setStatus(draft.id, {
      status: 'published',
      revision: draft.revision,
    });
    assert.equal(published.status, 'published');
    assert.deepEqual(await service.listTools(draft.id), [tool]);
    const first = await service.getTools();
    assert.equal(Object.keys(first).length, 1);
    assert.equal(
      Object.values(first)[0],
      Object.values(await service.getTools())[0],
    );
    const output = await Object.values(first)[0].execute!({}, {} as never);
    assert.match(JSON.stringify(output), /stdio=a=b==/);
  },
);

test(
  'long MCP names publish and remain distinct through SDK discovery and exec calls',
  { timeout: 25000 },
  async (t) => {
    const service = new McpService(
      (await new InMemoryStore().getStore('mcpClients'))!,
    );
    t.after(() => service.shutdown());
    const toolNames = [
      'docker.getContainersByAppLabel',
      'docker.getContainersByAppNameMatch',
    ];
    const catalog = toolNames.map((name) => ({ ...tool, name }));
    const script = `const tool = ${JSON.stringify(tool)}; const catalog = ${JSON.stringify(catalog)}; const reply = ${reply.toString().replace(/\n/g, ' ')}; require('node:readline').createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); const result = reply(request, request.params?.name ?? '', catalog); if (result) process.stdout.write(JSON.stringify(result) + '\\n'); });`;
    const expectedNames: string[] = [];
    for (const name of [
      'dokploy-mcp',
      'dokploy-mcp-long-service-primary',
      'dokploy-mcp-long-service-secondary',
    ]) {
      const [draft] = await service.create('admin', {
        servers: [
          { name, config: { command: process.execPath, args: ['-e', script] } },
        ],
      });
      const published = await service.setStatus(draft.id, {
        status: 'published',
        revision: draft.revision,
      });
      assert.equal(published.status, 'published');
      assert.deepEqual(await service.listTools(draft.id), catalog);
      expectedNames.push(
        ...toolNames.map(
          (toolName) =>
            `mcp__${name.replaceAll('-', '_')}__${toolName.replaceAll('.', '_')}`,
        ),
      );
    }
    const tools = await service.getTools();
    assert.deepEqual(Object.keys(tools).sort(), expectedNames.sort());
    assert.ok(expectedNames.some((name) => name.length > 64));
    for (const name of expectedNames) assert.equal(tools[name].id, name);
    const exec = createExecTool({ getTools: () => service.getTools() });
    const output = await exec.execute!(
      {
        code: `text(ALL_TOOLS.map(t => t.name).sort()); ${expectedNames.map((name) => `text(await tools.${name}({}));`).join(' ')}`,
        yield_time_ms: 3000,
        max_output_tokens: 4000,
      },
      { observe: noopObserve },
    );
    assert.ok(
      output && !isValidationError(output) && !output.isError,
      JSON.stringify(output),
    );
    assert.deepEqual(output.content[0], {
      type: 'text',
      text: JSON.stringify(expectedNames),
    });
    assert.equal(output.content.length, expectedNames.length + 1);
    expectedNames.forEach((name, index) => {
      const result = output.content[index + 1];
      assert.equal(result.type, 'text');
      if (result.type === 'text') {
        const expected = toolNames.find((toolName) =>
          name.endsWith(toolName.replaceAll('.', '_')),
        );
        assert.ok(expected);
        assert.equal(JSON.parse(result.text).content[0].text, expected);
      }
    });
  },
);

for (const transport of ['http', 'sse'] as const) {
  test(
    `real Mastra SDK discovers and executes ${transport} tools with authenticated requests`,
    { timeout: 25000 },
    async (t) => {
      const requests: {
        method?: string;
        url?: string;
        authorization?: string;
      }[] = [];
      const streams = new Set<ServerResponse>();
      let eventStream: ServerResponse | undefined;
      const server = createServer(async (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        if (request.headers.authorization !== 'Bearer fixture=a==') {
          response.writeHead(401).end();
          return;
        }
        if (request.method === 'GET' && request.url === '/sse') {
          eventStream = response;
          streams.add(response);
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          response.write('event: endpoint\ndata: /messages\n\n');
          request.on('close', () => streams.delete(response));
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(405).end();
          return;
        }
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const result = reply(JSON.parse(body), `${transport}-fixture`);
        if (transport === 'sse') {
          response.writeHead(202).end();
          if (result)
            eventStream?.write(
              `event: message\ndata: ${JSON.stringify(result)}\n\n`,
            );
        } else if (!result) response.writeHead(202).end();
        else
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify(result));
      });
      const service = new McpService(
        (await new InMemoryStore().getStore('mcpClients'))!,
      );
      t.after(async () => {
        await service.shutdown();
        streams.forEach((stream) => stream.end());
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const [draft] = await service.create('admin', {
        servers: [
          {
            name: transport,
            config: {
              url: `http://127.0.0.1:${address.port}/${transport === 'sse' ? 'sse' : 'mcp'}`,
              headers: { Authorization: 'Bearer fixture=a==' },
            },
          },
        ],
      });
      await service.setStatus(draft.id, {
        status: 'published',
        revision: draft.revision,
      });
      const tools = await service.getTools();
      assert.deepEqual(await service.listTools(draft.id), [tool]);
      assert.equal(Object.keys(tools).length, 1);
      const output = await Object.values(tools)[0].execute!({}, {} as never);
      assert.match(JSON.stringify(output), new RegExp(`${transport}-fixture`));
      assert.equal(
        requests.every(
          (request) => request.authorization === 'Bearer fixture=a==',
        ),
        true,
      );
      if (transport === 'sse')
        assert.ok(
          requests.some(
            (request) => request.method === 'GET' && request.url === '/sse',
          ),
        );
    },
  );
}
