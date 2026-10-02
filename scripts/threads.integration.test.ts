import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { Auth } from '@aime/auth';
import {
  createDataSource,
  Provider,
  ProviderModel,
  ProjectMember,
} from '@aime/db';
import { createApp } from '../apps/server/src/app.js';
import { createMastraRuntime } from '../apps/server/src/mastra/index.js';
import { createPersonalChatRunner } from '../apps/server/src/modules/threads/runner.js';
import { ThreadService } from '../apps/server/src/modules/threads/service.js';
import { LanguageModelService } from '../apps/server/src/modules/models/language-model.js';
import { ProviderService } from '../apps/server/src/modules/providers/service.js';
import { ProjectService } from '../apps/server/src/modules/projects/service.js';

async function close(server?: Server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('Thread did not reach expected state');
}

test(
  'PostgreSQL + Mastra + HTTP/SSE chat lifecycle (local deterministic provider)',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    // Opt-in manual browser verification uses the same isolated schemas and local provider.
    const browserVerify = process.env.CHAT_BROWSER_VERIFY === '1';
    const browserPort = Number(process.env.CHAT_BROWSER_PORT ?? 3001);
    const browserOrigin =
      process.env.CHAT_BROWSER_ORIGIN ?? 'http://localhost:5173';
    const schema = `chat_test_${randomBytes(6).toString('hex')}`;
    const connectionString = process.env.TEST_DATABASE_URL!;
    const root = new Pool({ connectionString });
    const pool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    const database = createDataSource(connectionString).setOptions({
      schema,
      extra: { options: `-c search_path=${schema}` },
    });
    const directory = await mkdtemp(join(tmpdir(), 'aime-chat-test-'));
    const { mastra, storage, memory } = createMastraRuntime(
      pool,
      `${schema}_mastra`,
    );
    let server: Server | undefined = undefined;
    let threads: ThreadService | undefined = undefined;
    const requests: Array<{
      model: string;
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    let release: (() => void) | undefined;
    let toolMode = false;
    const upstream = createServer(async (req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const toolStep =
        toolMode &&
        !requests.at(-1)!.messages.some((message) => message.role === 'tool');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (
        delta: Record<string, unknown>,
        finish_reason: string | null = null,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      emit({ role: 'assistant', content: 'Aime ' });
      await new Promise<void>((resolve) => {
        release = resolve;
        res.once('close', resolve);
        if (browserVerify) setTimeout(resolve, 12_000);
      });
      if (!res.destroyed) {
        if (toolStep) {
          emit({
            tool_calls: [
              {
                index: 0,
                id: 'fixture-list-call',
                type: 'function',
                function: {
                  name: 'mastra_workspace_list_files',
                  arguments: '{"path":"."}',
                },
              },
            ],
          });
          emit({}, 'tool_calls');
          res.end('data: [DONE]\n\n');
          return;
        }
        emit({ content: 'reply from fixture.' });
        emit({}, 'stop');
        res.end('data: [DONE]\n\n');
      }
    });
    t.after(async () => {
      release?.();
      await threads?.shutdown();
      await memory.settled();
      await Promise.all([close(server), close(upstream)]);
      if (database.isInitialized) await database.destroy();
      await mastra.shutdown();
      await pool.end();
      await root.query(`DROP SCHEMA IF EXISTS "${schema}_mastra" CASCADE`);
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
      await rm(directory, { recursive: true, force: true });
    });
    await root.query(`CREATE SCHEMA "${schema}"`);
    await database.initialize();
    await database.runMigrations();
    await storage.init();
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
    await database.manager.save(Provider, {
      id: 'test-provider',
      name: 'Fixture',
      type: 'openai',
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
      enabled: true,
      metadata: {},
    });
    await database.manager.save(ProviderModel, {
      providerId: 'test-provider',
      id: 'fixture-model',
      name: 'Fixture',
      modalitiesInput: ['text', 'image'],
      modalitiesOutput: ['text'],
      enabled: true,
      reasoning: false,
      toolCall: false,
      metadata: {},
    });
    const providers = new ProviderService(database);
    await providers.setDefaults({
      defaultModel: 'test-provider/fixture-model',
      fastModel: null,
      imageModel: null,
      thinkingMode: 'medium',
    });
    const models = new LanguageModelService(database, providers);
    const projects = new ProjectService(database);
    threads = new ThreadService(
      memory,
      createPersonalChatRunner(mastra, models, directory),
      projects,
    );
    const auth = {
      api: {
        async getSession({ headers }: { headers: Headers }) {
          const userId = browserVerify ? 'alice' : headers.get('cookie');
          return userId && ['alice', 'bob'].includes(userId)
            ? { user: { id: userId } }
            : null;
        },
      },
      handler: async () =>
        browserVerify
          ? Response.json({
              user: {
                id: 'alice',
                name: 'Chat QA',
                username: 'chat-qa',
                role: 'user',
                email: 'qa@example.test',
              },
              session: {
                id: 'fixture-session',
                userId: 'alice',
                expiresAt: new Date(Date.now() + 3600000).toISOString(),
              },
            })
          : new Response(null, { status: 404 }),
    } as unknown as Auth;
    server = createApp(
      auth,
      { service: providers, webOrigin: browserOrigin },
      { threads, models, projects, webOrigin: browserOrigin },
    ).listen(browserVerify ? browserPort : 0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/threads`;
    if (browserVerify) {
      for (let i = 23; i > 0; i--) {
        await threads.createThread('alice', {
          model: null,
          reasoningEffort: 'auto',
          title: `分页验证 ${String(i).padStart(2, '0')}`,
        });
      }
      console.log(
        `Isolated browser fixture ready on port ${browserPort}. Stop with SIGINT or SIGTERM to remove test schemas.`,
      );
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
      return;
    }
    const request = (
      path: string,
      method = 'GET',
      body?: unknown,
      cookie = 'alice',
      origin = 'http://localhost:5173',
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: { cookie, origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await request('', 'GET', undefined, '')).status, 401);
    assert.equal(
      (await request('', 'POST', {}, 'alice', 'https://untrusted.example'))
        .status,
      403,
    );
    assert.equal(
      (await request('', 'POST', { resourceId: 'user:bob' })).status,
      400,
    );
    const created = await request('', 'POST', {});
    assert.equal(created.status, 201);
    const thread = await created.json();
    assert.match(thread.id, /^[\w-]{16}$/);
    assert.equal(
      (await request(`/${thread.id}`, 'GET', undefined, 'bob')).status,
      404,
    );
    assert.equal(
      (await request(`/${thread.id}/messages`, 'GET', undefined, 'bob')).status,
      404,
    );
    const input = {
      id: 'fixture-message-1',
      parts: [{ type: 'text', text: 'Please reply.' }],
      model: null,
      reasoningEffort: 'auto',
    };
    assert.equal(
      (await request(`/${thread.id}/messages`, 'POST', input)).status,
      202,
    );
    await until(async () => requests.length === 1 && !!release);
    const controller = new AbortController();
    const response = await fetch(`${base}/${thread.id}/messages`, {
      headers: { cookie: 'alice' },
      signal: controller.signal,
    });
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
    );
    const reader = response.body!.getReader();
    let content = '';
    while (!content.includes('Aime ')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      content += new TextDecoder().decode(chunk.value);
    }
    assert.match(content, /event: snapshot/);
    assert.match(content, /Aime /);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    assert.equal(
      (await threads.getThread('alice', thread.id)).thread.status,
      'running',
    );
    // Retrying the accepted message does not execute the provider twice.
    assert.equal(
      (await request(`/${thread.id}/messages`, 'POST', input)).status,
      202,
    );
    release!();
    await until(
      async () =>
        (await threads!.getThread('alice', thread.id)).thread.status !==
        'running',
    );
    const snapshot = await threads.getThread('alice', thread.id);
    assert.equal(
      snapshot.thread.status,
      'idle',
      JSON.stringify(snapshot.thread),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'fixture-model');
    const history = await (await request(`/${thread.id}/history`)).json();
    assert.equal(
      history.messages.filter(
        (message: { role: string }) => message.role === 'user',
      ).length,
      1,
    );
    const reply = history.messages.find(
      (message: { role: string }) => message.role === 'assistant',
    );
    assert.ok(
      reply.parts.some(
        (part: { text?: string }) => part.text === 'Aime reply from fixture.',
      ),
    );
    assert.ok(
      snapshot.messages.some((message) => message.id === reply.id),
      'Live and persisted replies must share the same message ID',
    );
    const stored = await memory.getThreadById({ threadId: thread.id });
    assert.equal(stored?.resourceId, 'user:alice');
    assert.match(
      String(stored?.metadata?.workspace),
      /users\/alice\/\d{4}-\d{2}-\d{2}-[\w-]{6}$/,
    );
    const renamed = await request(`/${thread.id}`, 'PATCH', {
      title: 'Renamed chat',
    });
    assert.equal((await renamed.json()).title, 'Renamed chat');
    release = undefined;
    assert.equal(
      (
        await request(`/${thread.id}/messages`, 'POST', {
          ...input,
          id: 'fixture-message-2',
        })
      ).status,
      202,
    );
    await until(async () => requests.length === 2 && !!release);
    await until(async () =>
      (await threads!.getThread('alice', thread.id)).messages.some(
        (message) => message.role === 'assistant' && message.id !== reply.id,
      ),
    );
    assert.equal(
      (
        await request(`/${thread.id}/messages`, 'POST', {
          ...input,
          id: 'fixture-message-3',
        })
      ).status,
      202,
    );
    assert.equal((await request(`/${thread.id}/abort`, 'POST')).status, 200);
    await until(
      async () =>
        (await threads!.getThread('alice', thread.id)).thread.status === 'idle',
    );
    assert.equal(
      (await threads.getThread('alice', thread.id)).thread.queue.length,
      1,
    );
    assert.equal(requests.length, 2);
    const stoppedHistory = await threads.history('alice', thread.id);
    assert.ok(
      stoppedHistory.messages.some(
        (message) => message.role === 'assistant' && message.id !== reply.id,
      ),
      'Stopped partial reply is persisted',
    );
    assert.equal((await request(`/${thread.id}/resume`, 'POST')).status, 200);
    await until(async () => requests.length === 3);
    release!();
    await until(
      async () =>
        (await threads!.getThread('alice', thread.id)).thread.status === 'idle',
    );
    assert.equal((await request(`/${thread.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/${thread.id}`)).status, 404);
    await database.manager.update(
      ProviderModel,
      { providerId: 'test-provider', id: 'fixture-model' },
      { toolCall: true },
    );
    toolMode = true;
    const toolThread = await (await request('', 'POST', {})).json();
    await request(`/${toolThread.id}/messages`, 'POST', {
      ...input,
      id: 'tool-message-1',
    });
    await until(async () => requests.length === 4);
    assert.ok(
      requests[3].tools?.some(
        (tool) => tool.function.name === 'mastra_workspace_list_files',
      ),
    );
    await request(`/${toolThread.id}/messages`, 'POST', {
      ...input,
      id: 'tool-message-2',
      isImmediate: true,
      parts: [{ type: 'text', text: 'Injected after the tool.' }],
    });
    release!();
    await until(async () => requests.length === 5);
    assert.match(
      JSON.stringify(requests[4].messages),
      /Injected after the tool/,
    );
    release!();
    await until(
      async () =>
        (await threads!.getThread('alice', toolThread.id)).thread.status ===
        'idle',
    );
    const toolHistory = await threads.history('alice', toolThread.id);
    assert.equal(
      toolHistory.messages.filter((message) => message.role === 'user').length,
      2,
    );
    assert.equal(
      (await threads.getThread('alice', toolThread.id)).thread.queue.length,
      0,
    );
    // The same real Mastra runner, native memory and local provider also serve shared project threads.
    toolMode = false;
    const project = await projects.create('alice', {
      name: 'Shared fixture project',
    });
    await database.manager.save(ProjectMember, {
      projectId: project.id,
      userId: 'bob',
      role: 'member',
    });
    const shared = await (
      await request('', 'POST', { projectId: project.id })
    ).json();
    const projectStored = await memory.getThreadById({ threadId: shared.id });
    assert.equal(projectStored?.resourceId, `project:${project.id}`);
    assert.equal(
      projectStored?.metadata?.workspace,
      join(directory, 'projects', project.id),
    );
    const sharedAgain = await threads.createThread('bob', {
      projectId: project.id,
      model: null,
      reasoningEffort: 'auto',
    });
    assert.equal(
      (await memory.getThreadById({ threadId: sharedAgain.id }))?.metadata
        ?.workspace,
      projectStored?.metadata?.workspace,
    );
    await request(
      `/${shared.id}/messages`,
      'POST',
      { ...input, id: 'project-message1' },
      'bob',
    );
    await until(async () => requests.length === 6);
    const memberStreams = await Promise.all(
      ['alice', 'bob'].map(async (userId) => {
        const abort = new AbortController();
        const response = await fetch(`${base}/${shared.id}/messages`, {
          headers: { cookie: userId },
          signal: abort.signal,
        });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        let text = '';
        while (!text.includes('Aime ')) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += new TextDecoder().decode(chunk.value);
        }
        abort.abort();
        await reader.cancel().catch(() => undefined);
        return text;
      }),
    );
    assert.ok(memberStreams.every((stream) => stream.includes('Aime ')));
    release!();
    await until(
      async () =>
        (await threads!.getThread('bob', shared.id)).thread.status === 'idle',
    );
    const aliceHistory = await threads.history('alice', shared.id);
    const bobHistory = await threads.history(
      'bob',
      shared.id,
      0,
      aliceHistory.anchor,
    );
    assert.deepEqual(aliceHistory, bobHistory);
    assert.ok(
      bobHistory.messages.some((message) => message.role === 'assistant'),
    );
    assert.equal(
      (await threads.getThread('alice', shared.id)).thread.error,
      null,
    );
  },
);
