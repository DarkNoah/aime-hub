import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, MessageList } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
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

function chatResponse(stream: boolean, tool: boolean, count: number) {
  const call = {
    index: 0,
    id: `call_${count}`,
    type: 'function',
    function: { name: 'lookup', arguments: '{}' },
  };
  const common = {
    id: `chat_${count}`,
    created: 1792754490,
    model: 'deepseek-flash',
  };
  const usage = { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 };
  const finish_reason = tool ? 'tool_calls' : 'stop';
  if (!stream)
    return Response.json({
      ...common,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason,
          message: {
            role: 'assistant',
            reasoning_content: thought,
            content: tool ? null : 'done',
            ...(tool ? { tool_calls: [call] } : {}),
          },
        },
      ],
      usage,
    });
  const events = [
    {
      ...common,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', reasoning_content: thought.slice(0, 3) },
          finish_reason: null,
        },
      ],
    },
    {
      ...common,
      choices: [
        {
          index: 0,
          delta: { reasoning_content: thought.slice(3) },
          finish_reason: null,
        },
      ],
    },
    {
      ...common,
      choices: [
        {
          index: 0,
          delta: tool ? { tool_calls: [call] } : { content: 'done' },
          finish_reason: null,
        },
      ],
    },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason }], usage },
  ];
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') +
      'data: [DONE]\r\n\r\n',
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split UTF-8 characters and SSE boundaries to exercise the native parser.
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
      if (String(url).endsWith('/chat/completions')) {
        assert.equal(body.reasoning_effort, 'high');
        assert.deepEqual(body.thinking, { type: 'enabled' });
        assert.ok(!JSON.stringify(body).includes('responseOrigin'));
        return chatResponse(
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
        execute: async () => 'found',
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
  assert.match(JSON.stringify(requests[1].body.messages), new RegExp(thought));
  assert.match(JSON.stringify(requests[1].body.messages), /call_1/);
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
  assert.equal(reasoning?.reasoning, thought);
  assert.equal(
    reasoning?.providerMetadata?.responseOrigin?.scope,
    modelResponseScope(deepseek),
  );
  assert.equal((await agent.generate('Continue.', options)).text, 'done');
  assert.match(JSON.stringify(requests[2].body.messages), new RegExp(thought));
  await memory.settled();

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
  const returned = JSON.stringify(requests[5].body.messages);
  assert.ok(returned.includes(thought));
  assert.ok(!returned.includes('gpt-encrypted'));
  assert.ok(!returned.includes('GPT reasoning'));
  assert.ok(!returned.includes('msg_gpt'));
  const assistantMessages = (requests[5].body.messages as Wire[]).filter(
    (m) => m.role === 'assistant',
  );
  assert.ok(
    assistantMessages.every((m) => typeof m.reasoning_content === 'string'),
  );
  assert.ok(assistantMessages.some((m) => m.reasoning_content === ''));
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

test('DeepSeek effort and abort are preserved through native per-step routing', async () => {
  for (const [effort, expected] of [
    ['none', undefined],
    ['minimal', 'low'],
    ['medium', 'high'],
    ['max', 'max'],
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
    assert.equal((result.model as { api: string }).api, 'chat');
    assert.equal(result.providerOptions?.deepseek.reasoningEffort, expected);
    assert.deepEqual(result.providerOptions?.deepseek.thinking, {
      type: effort === 'none' ? 'disabled' : 'enabled',
    });
    assert.equal((original.model as { api: string }).api, 'responses');
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
