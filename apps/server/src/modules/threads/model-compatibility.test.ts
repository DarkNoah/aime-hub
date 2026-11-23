import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, MessageList } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type { UsageRecord } from '@aime/db';
import type { ChatSettings } from '@aime/shared/threads';
import { buildAgent } from '../../mastra/agents/factory.js';
import { getAgent } from '../../mastra/agents/index.js';
import type { LanguageModelService } from '../models/language-model.js';
import { createChatRunner } from './runner.js';
import type { ChatSessionEvent } from './session.js';
import { createDeepSeekResponsesModel } from '../../mastra/providers/deepseek.js';
import {
  ModelCompatibilityProcessor,
  compatiblePrompt,
  modelResponseScope,
} from '../../mastra/processors/model-compatibility.js';

type Selection = Parameters<typeof modelResponseScope>[0];
type Wire = Record<string, unknown>;
const legacyId = '721bb3bc-c5a2-475c-bb06-9d2633532863';
const thought = '先查找数据，再回答。';
const deepseek: Selection = {
  reference: 'account/deepseek-flash',
  model: {
    providerId: 'openai',
    modelId: 'deepseek-flash',
    url: 'https://processor-fixture.test/v1',
    apiKey: 'fixture',
    api: 'responses',
  },
  providerOptions: { openai: { reasoningEffort: 'medium', store: false } },
};
const gpt: Selection = {
  ...deepseek,
  reference: 'gateway/gpt-6.1-sol',
  model: {
    ...(deepseek.model as object),
    modelId: 'gpt-6.1-sol',
  } as Selection['model'],
  providerOptions: { openai: { reasoningEffort: 'none' } },
};

function deepseekResponse(
  stream: boolean,
  tool: boolean,
  count: number,
  toolInput = '{}',
  toolInputEvent: 'delta' | 'done' = 'delta',
  toolName = 'lookup',
  answer = 'done',
) {
  const reasoningText = `${thought}${count}`;
  const reasoning = {
    type: 'reasoning',
    id: `rs_ds_${count}`,
    summary: [],
    content: [{ type: 'reasoning_text', text: reasoningText }],
  };
  const output = tool
    ? {
        type: 'function_call',
        id: `fc_${count}`,
        call_id: `call_${count}`,
        name: toolName,
        arguments: toolInput,
        status: 'completed',
      }
    : {
        type: 'message',
        id: `ds_msg_${count}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      };
  const response = {
    id: `resp_ds_${count}`,
    object: 'response',
    model: 'deepseek-flash',
    created_at: 1792754490,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [reasoning, output],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      output_tokens_details: { reasoning_tokens: 3 },
    },
  };
  if (!stream) return Response.json(response);
  const events = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [], usage: null },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...reasoning, content: [] },
    },
    ...[reasoningText.slice(0, 3), reasoningText.slice(3)].map((delta) => ({
      type: 'response.reasoning_text.delta',
      item_id: reasoning.id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    {
      type: 'response.reasoning_text.done',
      item_id: reasoning.id,
      output_index: 0,
      content_index: 0,
      text: reasoningText,
    },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        ...output,
        ...(tool ? { arguments: '' } : { content: [] }),
        status: 'in_progress',
      },
    },
    tool
      ? {
          type: `response.function_call_arguments.${toolInputEvent}`,
          item_id: output.id,
          output_index: 1,
          ...(toolInputEvent === 'done'
            ? { arguments: toolInput }
            : { delta: toolInput }),
        }
      : {
          type: 'response.output_text.delta',
          item_id: output.id,
          output_index: 1,
          content_index: 0,
          delta: answer,
        },
    { type: 'response.output_item.done', output_index: 1, item: output },
    { type: 'response.completed', response },
  ];
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event, sequence_number) =>
          `event: ${event.type}\r\ndata: ${JSON.stringify({ ...event, sequence_number })}\r\n\r\n`,
      )
      .join(''),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split UTF-8 characters and SSE boundaries; DeepSeek has no [DONE] sentinel.
        for (let i = 0; i < bytes.length; i += 17)
          controller.enqueue(bytes.slice(i, i + 17));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function responsesResponse() {
  return Response.json({
    id: 'resp_gpt',
    model: 'gpt-6.1-sol',
    created_at: 1792754490,
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        type: 'reasoning',
        id: 'rs_gpt',
        summary: [{ type: 'summary_text', text: 'GPT reasoning' }],
        encrypted_content: 'gpt-encrypted',
      },
      {
        type: 'message',
        id: 'msg_gpt',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
  });
}

test('native Mastra processors preserve reasoning across tool calls, saved turns and DeepSeek → GPT → DeepSeek', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, init?: RequestInit) => {
      assert.ok(String(url).startsWith('https://processor-fixture.test/'));
      const body = JSON.parse(String(init?.body)) as Wire;
      requests.push({ url: String(url), body });
      assert.ok(String(url).endsWith('/responses'));
      if (body.model === 'deepseek-flash') {
        assert.deepEqual(body.reasoning, { effort: 'high' });
        assert.equal(body.previous_response_id, undefined);
        assert.ok(!JSON.stringify(body).includes('responseOrigin'));
        return deepseekResponse(
          body.stream === true,
          requests.length === 1,
          requests.length,
        );
      }
      assert.ok(String(url).endsWith('/responses'));
      assert.equal(body.store, false);
      return responsesResponse();
    },
  );
  const requests: { url: string; body: Wire }[] = [];
  let selection = deepseek;
  const compatibility = new ModelCompatibilityProcessor(() => selection);
  const storage = new InMemoryStore();
  const memory = new Memory({
    storage,
    options: { lastMessages: 30, generateTitle: false },
  });
  const agent = new Agent({
    id: 'compatibility-test',
    name: 'compatibility-test',
    instructions: 'Use lookup.',
    model: deepseek.model,
    memory,
    inputProcessors: [compatibility],
    outputProcessors: [compatibility],
    tools: {
      lookup: createTool({
        id: 'lookup',
        description: 'Lookup',
        inputSchema: z.object({}),
        execute: async () => ({ image: 'iVBORw0KGgo=' }),
        toModelOutput: (result) => ({
          type: 'content',
          value: [
            { type: 'text', text: 'Screenshot' },
            {
              type: 'image-data',
              data: (result as { image: string }).image,
              mediaType: 'image/png',
            },
          ],
        }),
      }),
    },
  });
  const options = {
    memory: { thread: 'compatibility-thread', resource: 'user' },
    maxSteps: 3,
    modelSettings: { maxRetries: 0 },
  };
  const first = await agent.stream('Look up a value.', options);
  await first.consumeStream();
  assert.equal(await first.text, 'done');
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].body.input), new RegExp(thought));
  assert.match(JSON.stringify(requests[1].body.input), /call_1/);
  const toolOutput = (requests[1].body.input as Wire[]).find(
    (item) => item.type === 'function_call_output',
  );
  assert.deepEqual(toolOutput?.output, [
    { type: 'input_text', text: 'Screenshot' },
    {
      type: 'input_image',
      image_url: 'data:image/png;base64,iVBORw0KGgo=',
      detail: 'auto',
    },
  ]);
  await memory.settled();
  const store = (await storage.getStore('memory'))!;
  const saved = (
    await store.listMessages({
      threadId: 'compatibility-thread',
      perPage: false,
    })
  ).messages;
  const parts = saved.flatMap((message) => message.content.parts);
  const reasoning = parts.find((part) => part.type === 'reasoning');
  assert.equal(reasoning?.reasoning, `${thought}1`);
  assert.equal(
    reasoning?.providerMetadata?.responseOrigin?.scope,
    modelResponseScope(deepseek),
  );
  assert.equal((await agent.generate('Continue.', options)).text, 'done');
  assert.match(JSON.stringify(requests[2].body.input), new RegExp(thought));
  assert.deepEqual(
    (requests[2].body.input as Wire[]).find(
      (item) => item.type === 'function_call_output',
    )?.output,
    toolOutput?.output,
  );
  await memory.settled();

  const afterGenerate = await store.listMessages({
    threadId: 'compatibility-thread',
    perPage: false,
  });
  assert.equal(
    afterGenerate.messages
      .flatMap((message) => message.content.parts)
      .filter(
        (part) =>
          part.type === 'reasoning' && part.reasoning.startsWith(thought),
      ).length,
    3,
  );

  selection = gpt;
  assert.equal((await agent.generate('Switch to GPT.', options)).text, 'done');
  const switchedInput = requests[3].body.input as Wire[];
  assert.ok(switchedInput.some((item) => item.type === 'function_call_output'));
  assert.ok(!switchedInput.some((item) => item.type === 'reasoning'));
  assert.ok(!JSON.stringify(switchedInput).includes(thought));
  await memory.settled();
  // A same-model turn retains OpenAI's encrypted reasoning and message IDs.
  assert.equal(
    (await agent.generate('Continue on GPT.', options)).text,
    'done',
  );
  assert.match(JSON.stringify(requests[4].body.input), /gpt-encrypted/);
  await memory.settled();

  selection = deepseek;
  assert.equal(
    (await agent.generate('Switch back to DeepSeek.', options)).text,
    'done',
  );
  const returned = JSON.stringify(requests[5].body.input);
  assert.ok(returned.includes(thought));
  assert.ok(!returned.includes('gpt-encrypted'));
  assert.ok(!returned.includes('GPT reasoning'));
  assert.ok(!returned.includes('msg_gpt'));
  const reasoningItems = (requests[5].body.input as Wire[]).filter(
    (item) => item.type === 'reasoning',
  );
  assert.ok(reasoningItems.length > 0);
  assert.ok(
    reasoningItems.every((item) =>
      JSON.stringify(item.content).includes(thought),
    ),
  );
  assert.ok(reasoningItems.every((item) => !item.encrypted_content));
  await memory.settled();
  // Switching only rewrites outbound prompts, leaving original saved reasoning intact.
  const after = (
    await store.listMessages({
      threadId: 'compatibility-thread',
      perPage: false,
    })
  ).messages;
  for (const original of saved)
    assert.deepEqual(
      after.find((m) => m.id === original.id),
      original,
    );
});

test('native Responses executes a tool once with arguments supplied only at the end of the stream', async (t) => {
  const expected = { value: 'lookup target' };
  const received: (typeof expected)[] = [];
  t.mock.method(globalThis, 'fetch', async () =>
    deepseekResponse(true, true, 1, JSON.stringify(expected), 'done'),
  );
  const agent = new Agent({
    id: 'responses-final-tool-arguments',
    name: 'Responses final tool arguments',
    instructions: 'Use lookup.',
    model: gpt.model,
    tools: {
      lookup: createTool({
        id: 'lookup',
        description: 'Lookup',
        inputSchema: z.object({ value: z.string() }),
        execute: async (input) => {
          received.push(input);
          return 'found';
        },
      }),
    },
  });
  const result = await agent.stream('Look up a value.', { maxSteps: 1 });
  await result.consumeStream();
  assert.deepEqual(received, [expected]);
});

test('malformed tool arguments remain paired on Responses replay and the model can correct them', async (t) => {
  const requests: Wire[] = [];
  let executed = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Wire;
      requests.push(body);
      if (requests.length > 1) {
        const items = body.input as Wire[];
        const failed = items.find(
          (item) => item.type === 'function_call' && item.call_id === 'call_1',
        );
        assert.equal(failed?.arguments, '{}');
        const error = items.find(
          (item) =>
            item.type === 'function_call_output' && item.call_id === 'call_1',
        );
        assert.match(
          String(error?.output),
          /invalid arguments|could not be parsed/i,
        );
      }
      return deepseekResponse(
        true,
        requests.length < 3,
        requests.length,
        requests.length === 1 ? '{"value":oops}' : '{"value":"corrected"}',
      );
    },
  );
  const compatibility = new ModelCompatibilityProcessor(() => deepseek);
  const memory = new Memory({
    storage: new InMemoryStore(),
    options: { lastMessages: 30, generateTitle: false },
  });
  const agent = new Agent({
    id: 'invalid-tool-input',
    name: 'invalid-tool-input',
    instructions: 'Use lookup.',
    model: deepseek.model,
    memory,
    inputProcessors: [compatibility],
    outputProcessors: [compatibility],
    tools: {
      lookup: createTool({
        id: 'lookup',
        description: 'Lookup',
        inputSchema: z.object({ value: z.string() }),
        execute: async ({ value }) => {
          executed++;
          assert.equal(value, 'corrected');
          return 'found';
        },
      }),
    },
  });
  const options = {
    memory: { thread: 'invalid-input-thread', resource: 'user' },
    maxSteps: 3,
    modelSettings: { maxRetries: 0 },
  };
  const result = await agent.stream('Look up a value.', options);
  await result.consumeStream();
  assert.equal(await result.text, 'done');
  assert.equal(executed, 1);
  assert.equal(requests.length, 3);
  await memory.settled();
  const next = await agent.stream('Continue.', options);
  await next.consumeStream();
  assert.equal(await next.text, 'done');
  assert.equal(executed, 1);
  assert.equal(requests.length, 4);
});

test(
  'an idle native completion reuses the dispatching settings and replays the completed tool on the stateless Responses wire',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp('/tmp/runner-notification-');
    const storage = new InMemoryStore();
    const mastra = new Mastra({
      storage,
      logger: false,
      backgroundTasks: { enabled: true },
    });
    const memory = new Memory({ storage, options: { generateTitle: false } });
    const config = getAgent('code')!;
    const settings = {
      model: deepseek.reference,
      reasoningEffort: 'auto',
    } as const;
    const requests: { body: Wire; headers: Headers }[] = [];
    const records: UsageRecord[] = [];
    function gate() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }
    const toolResult = gate();
    const dispatchRequest = gate();
    const allowDispatch = gate();
    let completed = false;
    let agent!: Agent;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: unknown, init?: RequestInit) => {
        assert.ok(String(url).startsWith('https://processor-fixture.test/'));
        const body = JSON.parse(String(init?.body)) as Wire;
        requests.push({ body, headers: new Headers(init?.headers) });
        if (requests.length === 2) {
          dispatchRequest.release();
          await allowDispatch.promise;
          return deepseekResponse(
            true,
            true,
            2,
            JSON.stringify({
              cmd: 'python video.py',
              _background: { disposition: 'deferred' },
            }),
            'delta',
            'exec_command',
          );
        }
        return deepseekResponse(
          true,
          false,
          requests.length,
          '{}',
          'delta',
          'lookup',
          completed ? 'Video is ready: video.mp4' : 'done',
        );
      },
    );
    const runner = createChatRunner(
      mastra,
      {
        getLanguageModel: async (_user: string, selected: ChatSettings) => ({
          ...(selected.model === gpt.reference ? gpt : deepseek),
          supportsImages: false,
          toolCall: true,
        }),
      } as unknown as LanguageModelService,
      root,
      undefined,
      {
        buildTools: async () => ({
          exec_command: createTool({
            id: 'exec_command',
            description: 'Video command',
            inputSchema: z.object({ cmd: z.string() }),
            background: { enabled: true, defaultDisposition: 'foreground' },
            execute: async () => {
              await toolResult.promise;
              return { exit_code: 0, output: 'video.mp4' };
            },
          }),
        }),
      },
      {
        getConfig: async () => config,
        getAgent: async (_id, options) => (agent = buildAgent(config, options)),
      },
      {
        record: async (row) => {
          records.push(row);
        },
      },
    );
    const projectId = 'project123456789';
    await runner.createWorkspace('alice', projectId);
    const thread = await memory.createThread({
      resourceId: `project:${projectId}`,
      title: 'Background completion',
      metadata: { createdBy: 'alice' },
    });
    const events: ChatSessionEvent[] = [];
    const session = await runner.open({
      thread,
      settings,
      onEvent: (event) => events.push(event),
    });
    const notify = agent.__notifyBackgroundTaskFinished.bind(agent);
    let authorAtCompletion: unknown;
    t.mock.method(
      agent,
      '__notifyBackgroundTaskFinished',
      (params: Parameters<typeof notify>[0]) => {
        authorAtCompletion = params.requestContext?.get('userId');
        return notify(params);
      },
    );
    t.after(async () => {
      toolResult.release();
      allowDispatch.release();
      await session.close();
      await mastra.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    async function waitForFinish(author: string, after = 0) {
      for (let i = 0; i < 500; i++) {
        const error = events.find((event) => event.type === 'error');
        if (error?.type === 'error') throw error.error;
        const finished = events.filter(
          (event) => event.type === 'status' && event.status === 'success',
        );
        if (
          records
            .slice(after)
            .some(
              (row) =>
                row.userId === author &&
                finished.some(
                  (event) =>
                    event.type === 'status' && event.runId === row.runId,
                ),
            )
        )
          return;
        await delay(10);
      }
      assert.fail(
        JSON.stringify({
          events: events.map((e) => (e.type === 'status' ? e.status : e.type)),
          models: requests.map((r) => [
            r.body.model,
            r.headers.get('x-user-id'),
          ]),
          records: records.map((r) => [r.userId, r.modelReference]),
        }),
      );
    }
    // This older project signal must not override the settings or author of the background call.
    await session.send({
      ...settings,
      id: 'message01',
      createdBy: 'alice',
      isImmediate: false,
      parts: [{ type: 'text', text: 'Earlier request' }],
    });
    await waitForFinish('alice');
    events.length = 0;
    const target = { threadId: thread.id, resourceId: thread.resourceId };
    const scope = modelResponseScope(gpt);
    const reasoning = (
      itemId: string,
      origin: string,
      ciphertext?: string,
    ) => ({
      type: 'reasoning' as const,
      reasoning: itemId,
      details: [],
      providerMetadata: {
        responseOrigin: { scope: origin },
        openai: {
          itemId,
          ...(ciphertext && { reasoningEncryptedContent: ciphertext }),
        },
      },
    });
    const store = (await storage.getStore('memory'))!;
    await store.saveMessages({
      messages: [
        {
          ...target,
          id: 'completed-command',
          role: 'assistant',
          createdAt: new Date(),
          content: {
            format: 2,
            parts: [
              reasoning('rs_encrypted', scope, 'same-account-ciphertext'),
              reasoning('rs_missing', scope),
              reasoning(
                'rs_foreign',
                modelResponseScope(deepseek),
                'foreign-ciphertext',
              ),
              {
                type: 'text',
                text: 'Generating video.',
                providerMetadata: {
                  responseOrigin: { scope },
                  openai: { itemId: 'msg_waiting' },
                },
              },
            ],
          },
        },
      ],
    });
    const requestContext = new RequestContext();
    requestContext.set('userId', 'bob');
    requestContext.set('chatSettings', {
      agentId: config.id,
      model: gpt.reference,
      reasoningEffort: 'none',
    });
    // Let the dispatching run end while its tool is still running, as after untilIdle expires.
    const output = await agent.stream('Generate the video.', {
      memory: { thread: thread.id, resource: thread.resourceId },
      requestContext,
    });
    const chunks: string[] = [];
    const consuming = (async () => {
      for await (const chunk of output.fullStream) {
        if (chunk.type === 'error') throw chunk.payload.error;
        if (chunk.type === 'tool-error')
          assert.fail(JSON.stringify(chunk.payload));
        chunks.push(chunk.type);
      }
    })();
    await dispatchRequest.promise;
    const queued = agent.queueMessage(
      {
        contents: 'My follow-up',
        metadata: { createdBy: 'alice', chatSettings: settings },
      },
      target,
    );
    await queued.accepted;
    allowDispatch.release();
    await consuming;
    assert.ok(
      chunks.includes('background-task-started'),
      JSON.stringify(chunks),
    );
    await waitForFinish('alice', 1);
    assert.equal(
      requestContext.get('userId'),
      'alice',
      JSON.stringify(
        records.map((row) => [row.userId, row.modelReference, row.runId]),
      ),
    );
    const countBeforeCompletion = requests.length;
    assert.ok(
      requests.slice(2).some((r) => r.headers.get('x-user-id') === 'alice'),
      JSON.stringify(
        requests.map((r) => [r.body.model, r.headers.get('x-user-id')]),
      ),
    );
    events.length = 0;
    completed = true;
    toolResult.release();
    await waitForFinish('bob', countBeforeCompletion);
    assert.equal(
      authorAtCompletion,
      'alice',
      'the native executor still carries the subsequent author when it finishes',
    );
    assert.equal(requests.length, countBeforeCompletion + 1);
    const { body, headers } = requests.at(-1)!;
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.store, false);
    assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.equal(headers.get('x-user-id'), 'bob');
    assert.equal(headers.get('x-thread-id'), thread.id);
    const input = body.input as Wire[];
    assert.ok(!input.some((item) => item.type === 'item_reference'));
    assert.deepEqual(
      input
        .filter((item) => item.type === 'reasoning')
        .map((item) => item.encrypted_content),
      ['same-account-ciphertext'],
    );
    assert.doesNotMatch(
      JSON.stringify(input),
      /rs_missing|rs_foreign|foreign-ciphertext/,
    );
    assert.match(JSON.stringify(input), /Generating video/);
    const call = input.find(
      (item) => item.type === 'function_call' && item.call_id === 'call_2',
    );
    assert.equal(call?.name, 'exec_command');
    assert.equal(JSON.parse(String(call.arguments)).cmd, 'python video.py');
    const result = input.find(
      (item) =>
        item.type === 'function_call_output' && item.call_id === 'call_2',
    );
    assert.match(String(result?.output), /video\.mp4/);
    assert.equal(records.length, requests.length);
    assert.ok(
      records.every(
        (row) =>
          row.modelReference ===
          (row.userId === 'alice' ? deepseek.reference : gpt.reference),
      ),
    );
    assert.equal(records.at(-1)?.userId, 'bob');
    const saved = await memory.recall({ ...target });
    assert.ok(
      saved.messages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content.parts.some(
            (part) =>
              part.type === 'text' && part.text === 'Video is ready: video.mp4',
          ),
      ),
    );
  },
);

test('legacy UUID metadata is removed after native history conversion without losing text or tool pairs', () => {
  const list = new MessageList();
  list.add(
    [
      {
        id: 'legacy-message',
        role: 'assistant',
        createdAt: new Date(),
        content: {
          format: 2,
          parts: [
            {
              type: 'reasoning',
              reasoning: '',
              details: [],
              providerMetadata: {
                openai: {
                  itemId: 'reasoning-uuid',
                  reasoningEncryptedContent: 'foreign-encrypted',
                },
              },
            },
            {
              type: 'text',
              text: 'Saved answer',
              providerMetadata: {
                openai: { itemId: legacyId, phase: 'commentary' },
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolCallId: 'call_legacy',
                toolName: 'lookup',
                args: {},
                result: 'found',
              },
              providerMetadata: { openai: { itemId: 'tool-uuid' } },
            },
          ],
        },
      },
    ],
    'memory',
  );
  const prompt = list.get.all.aiV5.model() as Parameters<
    typeof compatiblePrompt
  >[0];
  const before = structuredClone(prompt);
  const cleaned = compatiblePrompt(prompt, modelResponseScope(gpt), false);
  const json = JSON.stringify(cleaned);
  assert.ok(!json.includes(legacyId));
  assert.ok(!json.includes('foreign-encrypted'));
  assert.ok(json.includes('Saved answer'));
  assert.equal(json.match(/call_legacy/g)?.length, 2);
  assert.deepEqual(prompt, before);
});

test('account, endpoint, key and model changes invalidate replay provenance; returning to the original keeps it', () => {
  const scope = modelResponseScope(deepseek);
  const prompt: Parameters<typeof compatiblePrompt>[0] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: thought,
          providerOptions: {
            responseOrigin: { scope },
            openai: {
              itemId: 'rs_original',
              reasoningEncryptedContent: 'encrypted',
            },
          },
        },
        {
          type: 'text',
          text: 'saved',
          providerOptions: {
            responseOrigin: { scope },
            openai: { itemId: legacyId },
          },
        },
      ],
    },
  ];
  const before = structuredClone(prompt);
  for (const change of [
    { reference: 'other/deepseek-flash' },
    {
      model: {
        ...(deepseek.model as object),
        url: 'https://other.test/v1',
      } as Selection['model'],
    },
    {
      model: {
        ...(deepseek.model as object),
        apiKey: 'rotated',
      } as Selection['model'],
    },
    gpt,
  ]) {
    const changedScope = modelResponseScope({ ...deepseek, ...change });
    const json = JSON.stringify(compatiblePrompt(prompt, changedScope, false));
    assert.ok(!json.includes(thought));
    assert.ok(!json.includes(legacyId));
    assert.ok(json.includes('saved'));
  }
  assert.match(
    JSON.stringify(compatiblePrompt(prompt, scope, true)),
    new RegExp(thought),
  );
  assert.deepEqual(prompt, before);
});

test('DeepSeek effort and abort are preserved through native per-step routing', async (t) => {
  let body: Wire = {};
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Wire;
      return deepseekResponse(false, false, 1);
    },
  );
  for (const [effort, expected] of [
    ['none', 'none'],
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'high'],
    ['max', 'max'],
    ['ultra', 'max'],
  ] as const) {
    const original = {
      ...deepseek,
      providerOptions: { openai: { reasoningEffort: effort } },
    };
    const processor = new ModelCompatibilityProcessor(() => original);
    const state = {};
    const result = await processor.processInputStep({
      state,
    } as ProcessInputStepArgs);
    assert.equal(
      (result.model as { provider: string }).provider,
      'deepseek.responses',
    );
    assert.equal(result.providerOptions?.deepseek.reasoningEffort, expected);
    assert.equal(result.providerOptions?.deepseek.thinking, undefined);
    assert.equal((original.model as { api: string }).api, 'responses');
    const model = result.model as Awaited<
      ReturnType<typeof createDeepSeekResponsesModel>
    >;
    const generated = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
      providerOptions: result.providerOptions,
    });
    await generated.stream.pipeTo(new WritableStream());
    assert.deepEqual(body.reasoning, { effort: expected });
    assert.equal(body.thinking, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.conversation, undefined);
    assert.ok(!JSON.stringify(model).includes('fixture'));
  }
  const controller = new AbortController();
  controller.abort(new Error('用户中止了操作'));
  let called = false;
  const processor = new ModelCompatibilityProcessor(() => {
    called = true;
    return deepseek;
  });
  await assert.rejects(
    processor.processInputStep({
      state: {},
      abortSignal: controller.signal,
    } as ProcessInputStepArgs),
    /用户中止了操作/,
  );
  assert.equal(called, false);
});

test('explicit Chat selection still uses Chat; non-DeepSeek Responses keeps its native route', async () => {
  const chat: Selection = {
    ...deepseek,
    model: { ...(deepseek.model as object), api: 'chat' } as Selection['model'],
  };
  const selected = await new ModelCompatibilityProcessor(
    () => chat,
  ).processInputStep({ state: {} } as ProcessInputStepArgs);
  assert.equal((selected.model as { api: string }).api, 'chat');
  assert.deepEqual(selected.providerOptions?.deepseek.thinking, {
    type: 'enabled',
  });
  const other = await new ModelCompatibilityProcessor(
    () => gpt,
  ).processInputStep({ state: {} } as ProcessInputStepArgs);
  assert.deepEqual(other.model, gpt.model);
  assert.equal(other.providerOptions?.openai.store, false);
});

test('DeepSeek Responses propagates HTTP errors, stream failures and truncation', async (t) => {
  const model = await createDeepSeekResponsesModel(
    deepseek.model as Parameters<typeof createDeepSeekResponsesModel>[0],
  );
  const prompt = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'test' }],
    },
  ];
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      {
        error: {
          message: 'context too long',
          type: 'invalid_request_error',
          param: '',
          code: 'context_length_exceeded',
        },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(
    async () => model.doGenerate({ prompt }),
    /context too long/,
  );
  for (const failed of [true, false]) {
    const response = {
      id: 'resp_failure',
      object: 'response',
      model: 'deepseek-flash',
      created_at: 1,
      status: failed ? 'failed' : 'incomplete',
      output: [],
      error: failed
        ? { code: 'server_error', message: 'upstream failed' }
        : null,
      incomplete_details: failed ? null : { reason: 'max_output_tokens' },
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    mock.mock.mockImplementation(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: failed ? 'response.failed' : 'response.incomplete', sequence_number: 0, response })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const result = await model.doStream({ prompt });
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    if (failed)
      assert.ok(
        chunks.some(
          (chunk) =>
            chunk.type === 'error' &&
            JSON.stringify(chunk.error).includes('upstream failed'),
        ),
      );
    else
      assert.ok(
        chunks.some(
          (chunk) =>
            chunk.type === 'finish' && chunk.finishReason.unified === 'length',
        ),
      );
  }
});

test('DeepSeek Responses passes cancellation to the active HTTP request', async (t) => {
  const model = await createDeepSeekResponsesModel(
    deepseek.model as Parameters<typeof createDeepSeekResponsesModel>[0],
  );
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        assert.ok(init?.signal);
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
        started();
      }),
  );
  const controller = new AbortController();
  const pending = model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }],
    abortSignal: controller.signal,
  });
  await ready;
  controller.abort(new Error('用户中止了操作'));
  await assert.rejects(async () => pending, /用户中止了操作/);
});
