import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageList, type MastraDBMessage } from '@mastra/core/agent';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import type { ProcessInputStepArgs } from '@mastra/core/processors';
import { IncompleteToolCallsProcessor } from '../../mastra/processors/incomplete-tool-calls.js';

type Part = MastraDBMessage['content']['parts'][number];
function call(id: string, state: 'call' | 'partial-call' = 'call'): Part {
  return {
    type: 'tool-invocation',
    toolInvocation: {
      state,
      toolName: 'exec_command',
      toolCallId: id,
      args: { command: 'example' },
    },
    providerMetadata: { openai: { itemId: `item-${id}` } },
  };
}
function message(
  parts: Part[],
  metadata?: Record<string, unknown>,
): MastraDBMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    createdAt: new Date('2026-10-18T14:40:44Z'),
    content: { format: 2, parts, metadata },
  };
}
function process(messageList: MessageList, abortSignal?: AbortSignal) {
  return new IncompleteToolCallsProcessor().processInputStep({
    messageList,
    abortSignal,
  } as ProcessInputStepArgs);
}

test('interrupted reasoning/tool history becomes a paired tool error and is queued for persistence', async () => {
  const reasoning: Part = {
    type: 'reasoning',
    reasoning: '',
    details: [{ type: 'text', text: '' }],
    providerMetadata: {
      openai: { itemId: 'reasoning-1', reasoningEncryptedContent: 'opaque' },
    },
  };
  const list = new MessageList().add(
    [message([reasoning, call('interrupted')])],
    'memory',
  );
  assert.deepEqual(list.get.all.aiV5.prompt().at(-1)?.content, [
    {
      type: 'reasoning',
      text: '',
      providerOptions: reasoning.providerMetadata,
    },
  ]);

  assert.equal(process(list), list);
  const prompt = await list.get.all.aiV5.llmPrompt();
  const parts = prompt.flatMap((m) =>
    typeof m.content === 'string' ? [] : m.content,
  );
  assert.equal(prompt.at(-1)?.role, 'tool');
  assert.equal(parts.filter((p) => p.type === 'tool-call').length, 1);
  const result = parts.find((p) => p.type === 'tool-result');
  assert.equal(result?.toolCallId, 'interrupted');
  assert.equal(result?.output.type, 'error-text');
  assert.match(JSON.stringify(result?.output), /interrupted or terminated/);
  assert.match(JSON.stringify(result?.output), /outcome is unknown/i);
  assert.deepEqual(list.get.all.db()[0].content.parts[0], reasoning);
  const tool = list.get.all.db()[0].content.parts[1];
  assert.equal(tool.type, 'tool-invocation');
  if (tool.type !== 'tool-invocation') return;
  assert.deepEqual(tool.toolInvocation.args, { command: 'example' });
  assert.deepEqual(tool.providerMetadata, {
    openai: { itemId: 'item-interrupted' },
  });
  assert.equal(list.isNewMessage('assistant-1'), true);

  const once = structuredClone(list.get.all.db());
  process(list);
  assert.deepEqual(list.get.all.db(), once);
});

test('partial and parallel interrupted calls get one error each while completed falsy results are preserved', async () => {
  const done: Part = {
    type: 'tool-invocation',
    toolInvocation: {
      state: 'result',
      toolName: 'exec_command',
      toolCallId: 'done',
      args: {},
      result: false,
    },
  };
  const list = new MessageList().add(
    [message([call('one'), done, call('two', 'partial-call')])],
    'memory',
  );
  process(list);
  const prompt = await list.get.all.aiV5.llmPrompt();
  const results = prompt
    .flatMap((m) => (typeof m.content === 'string' ? [] : m.content))
    .filter((p) => p.type === 'tool-result');
  assert.deepEqual(
    results.map((p) => p.toolCallId),
    ['one', 'done', 'two'],
  );
  assert.equal(results.filter((p) => p.output.type === 'error-text').length, 2);
  assert.deepEqual(list.get.all.db()[0].content.parts[1], done);
});

test('approval, suspended, background and provider-owned calls remain under their native lifecycle', () => {
  const approval = call('approval');
  assert.equal(approval.type, 'tool-invocation');
  if (approval.type !== 'tool-invocation') return;
  approval.toolInvocation.state = 'approval-requested';
  approval.toolInvocation.approval = { id: 'approval-1' };
  const provider = call('provider');
  assert.equal(provider.type, 'tool-invocation');
  if (provider.type !== 'tool-invocation') return;
  provider.providerExecuted = true;
  const list = new MessageList().add(
    [
      message(
        [
          approval,
          provider,
          call('suspended'),
          call('metadata-approval'),
          call('background'),
          call('data-suspended'),
          {
            type: 'data-tool-call-suspended',
            data: { toolCallId: 'data-suspended' },
          },
        ],
        {
          suspendedTools: { suspension: { toolCallId: 'suspended' } },
          pendingToolApprovals: { 'metadata-approval': {} },
          backgroundTasks: { background: { taskId: 'task-1', startedAt: 1 } },
        },
      ),
    ],
    'memory',
  );
  const before = structuredClone(list.get.all.db());
  process(list);
  assert.deepEqual(list.get.all.db(), before);
  assert.equal(list.isNewMessage('assistant-1'), false);
});

test('a stale incomplete duplicate cannot overwrite a recorded outcome', () => {
  const older = message([call('same')]);
  const newer = message([
    {
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId: 'same',
        toolName: 'exec_command',
        args: {},
        result: 'real result',
      },
    },
  ]);
  newer.id = 'assistant-2';
  const list = new MessageList().add([older, newer], 'memory');
  const before = structuredClone(list.get.all.db());
  process(list);
  assert.deepEqual(list.get.all.db(), before);
});

test('an aborted run does not alter incomplete history', () => {
  const list = new MessageList().add([message([call('one')])], 'memory');
  const before = structuredClone(list.get.all.db());
  assert.throws(() => process(list, AbortSignal.abort()), /abort/i);
  assert.deepEqual(list.get.all.db(), before);
});

test('the Responses adapter serializes the repaired call with a textual function_call_output', async (t) => {
  const list = new MessageList().add(
    [
      message([
        {
          type: 'reasoning',
          reasoning: '',
          details: [{ type: 'text', text: '' }],
          providerMetadata: {
            openai: {
              itemId: 'reasoning-1',
              reasoningEncryptedContent: 'opaque',
            },
          },
        },
        call('interrupted'),
      ]),
    ],
    'memory',
  );
  process(list);
  let request: { input: Record<string, unknown>[] } | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          error: {
            message: 'Offline request captured',
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const model = new ModelRouterLanguageModel({
    providerId: 'openai',
    modelId: 'deepseek-flash',
    api: 'responses',
    url: 'https://offline-replay.invalid/v1',
    apiKey: 'offline-placeholder',
  });
  await assert.rejects(
    model.doStream({
      prompt: await list.get.all.aiV5.llmPrompt(),
      providerOptions: { openai: { store: false } },
    }),
    /Offline request captured/,
  );
  assert.ok(request);
  const tail = request.input.slice(-3);
  assert.deepEqual(
    tail.map((p) => p.type),
    ['reasoning', 'function_call', 'function_call_output'],
  );
  assert.equal(tail[1].call_id, 'interrupted');
  assert.equal(tail[2].call_id, 'interrupted');
  assert.match(String(tail[2].output), /interrupted or terminated/);
});
