import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, MessageList } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
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

function deepseekResponse(stream: boolean, tool: boolean, count: number) {
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
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
      }
    : {
        type: 'message',
        id: `ds_msg_${count}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
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
          type: 'response.function_call_arguments.delta',
          item_id: output.id,
          output_index: 1,
          delta: '{}',
        }
      : {
          type: 'response.output_text.delta',
          item_id: output.id,
          output_index: 1,
          content_index: 0,
          delta: 'done',
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
