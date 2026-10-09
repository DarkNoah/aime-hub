import { sessionStub } from './fixtures/thread-session.js';
import type { ChatSession } from '../apps/server/src/modules/threads/session.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ThreadService,
  type ChatRunner,
} from '../apps/server/src/modules/threads/service.js';
import { fakeMemory } from './fixtures/thread-memory.js';
import { validateToolResponse } from '../apps/server/src/modules/threads/tool-interactions.js';
import { groupMessageParts } from '../apps/web/src/components/chat/messages.js';
import type { ToolInteraction, RunInput } from '@aime/shared/threads';

const settings = { model: null, reasoningEffort: 'auto' } as const;
const input = (id: string): RunInput => ({
  ...settings,
  id,
  isImmediate: false,
  parts: [{ type: 'text', text: id }],
});
const question: ToolInteraction = {
  id: 'question-1',
  runId: 'run-1',
  toolCallId: 'call-1',
  toolName: 'ask_user',
  kind: 'suspended',
  suspendPayload: {
    question: 'Which changes?',
    options: [{ label: 'Tests' }, { label: 'Docs' }],
    selectionMode: 'multi_select',
  },
};
const approval: ToolInteraction = {
  id: 'approval-1',
  runId: 'run-1',
  toolCallId: 'call-2',
  toolName: 'delete_file',
  kind: 'approval',
  input: { path: 'example.txt' },
};
const base = {
  async validate() {},
  async createWorkspace() {
    return 'workspace';
  },
};
test('ask_user can be declined without an answer while other response rules still apply', () => {
  const response = { id: 'response1', action: 'decline' } as const;
  assert.doesNotThrow(() =>
    validateToolResponse(
      {
        ...question,
        resumeSchema: { type: 'array', items: { type: 'string' } },
      },
      response,
    ),
  );
  assert.doesNotThrow(() => validateToolResponse(approval, response));
  assert.throws(
    () =>
      validateToolResponse({ ...question, toolName: 'review_plan' }, response),
    { code: 'VALIDATION_ERROR' },
  );
  assert.throws(
    () =>
      validateToolResponse(question, { id: 'response1', action: 'approve' }),
    { code: 'VALIDATION_ERROR' },
  );
});

test('generic suspension responses follow the serialized resume schema before consumption', () => {
  const interaction: ToolInteraction = {
    ...question,
    toolName: 'review_plan',
    resumeSchema: JSON.stringify({
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
      additionalProperties: false,
    }),
  };
  assert.throws(
    () =>
      validateToolResponse(interaction, {
        id: 'response1',
        action: 'resume',
        data: { approved: 'yes' },
      }),
    { code: 'VALIDATION_ERROR' },
  );
  assert.throws(
    () =>
      validateToolResponse(interaction, {
        id: 'response1',
        action: 'resume',
        data: {},
      }),
    { code: 'VALIDATION_ERROR' },
  );
  assert.doesNotThrow(() =>
    validateToolResponse(interaction, {
      id: 'response1',
      action: 'resume',
      data: { approved: true },
    }),
  );
  assert.throws(
    () =>
      validateToolResponse(approval, {
        id: 'response1',
        action: 'resume',
        data: { approved: true },
      }),
    { code: 'VALIDATION_ERROR' },
  );
});

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Timed out waiting for tool interaction');
}

test('pending interactions survive restart, block new input, and resume the exact run once', async (t) => {
  const { memory } = fakeMemory();
  const seen: Parameters<ChatSession['respond']>[] = [];
  let sends = 0;
  const runner: ChatRunner = {
    ...base,
    async open({ onEvent }) {
      return sessionStub({
        async send() {
          sends++;
          for (const interaction of [question, approval])
            onEvent({ type: 'interaction', interaction, settings });
          onEvent({ type: 'status', status: 'suspended', runId: 'run-1' });
        },
        async respond(...args) {
          seen.push(args);
          onEvent({
            type: 'status',
            status: seen.length === 1 ? 'suspended' : 'success',
            runId: 'run-1',
          });
        },
      });
    },
  };
  const first = new ThreadService(memory, runner);
  const thread = await first.createThread('alice', settings);
  await first.run('alice', thread.id, input('message01'));
  await until(
    async () =>
      (await first.getThread('alice', thread.id)).toolInteractions?.length ===
      2,
  );
  await first.shutdown();
  const service = new ThreadService(memory, runner);
  t.after(() => service.shutdown());
  assert.equal(
    (await service.getThread('alice', thread.id)).toolInteractions?.length,
    2,
  );
  await assert.rejects(service.run('alice', thread.id, input('message02')), {
    code: 'TOOL_RESPONSE_REQUIRED',
  });
  assert.equal(sends, 1);
  await assert.rejects(
    service.respondToTool('bob', thread.id, question.id, {
      id: 'response1',
      action: 'resume',
      data: ['Tests'],
    }),
    { code: 'THREAD_NOT_FOUND' },
  );
  await assert.rejects(
    service.respondToTool('alice', thread.id, approval.id, {
      id: 'response1',
      action: 'resume',
      data: true,
    }),
    { code: 'VALIDATION_ERROR' },
  );
  await assert.rejects(
    service.respondToTool('alice', thread.id, question.id, {
      id: 'response1',
      action: 'resume',
      data: 'Tests',
    }),
    { code: 'VALIDATION_ERROR' },
  );
  const response = {
    id: 'response1',
    action: 'resume',
    data: ['Tests', 'Docs'],
  } as const;
  await Promise.all(
    [1, 2].map(() =>
      service.respondToTool('alice', thread.id, question.id, {
        ...response,
        data: [...response.data],
      }),
    ),
  );
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status ===
      'suspended',
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].id, question.id);
  assert.equal(seen[0][0].runId, 'run-1');
  assert.equal(seen[0][0].toolCallId, 'call-1');
  assert.deepEqual(seen[0][1], response);
  await assert.rejects(
    service.respondToTool('alice', thread.id, question.id, {
      id: 'response2',
      action: 'resume',
      data: ['Tests'],
    }),
    { code: 'TOOL_NOT_PENDING' },
  );
  await service.respondToTool('alice', thread.id, approval.id, {
    id: 'response3',
    action: 'decline',
    reason: 'Keep the file',
  });
  await until(
    async () =>
      (await service.getThread('alice', thread.id)).thread.status === 'success',
  );
  assert.equal(seen.length, 2);
  assert.equal(seen[1][1].action, 'decline');
  const snapshot = await service.getThread('alice', thread.id);
  assert.equal(
    snapshot.toolInteractions?.filter((item) => item.response).length,
    2,
  );
  assert.equal(snapshot.thread.queueCount, 0);
});

test('a tool can request more input on the same call without reusing the previous approval', async (t) => {
  const { memory } = fakeMemory();
  const service = new ThreadService(memory, {
    ...base,
    async open({ onEvent }) {
      const suspend = (interaction: typeof question) => {
        onEvent({ type: 'interaction', interaction, settings });
        onEvent({
          type: 'status',
          status: 'suspended',
          runId: interaction.runId,
        });
      };
      return sessionStub({
        async send() {
          suspend(approval);
        },
        async respond() {
          suspend({
            ...question,
            id: 'question-2',
            suspendPayload: { question: 'Any additional notes?' },
          });
        },
      });
    },
  });
  t.after(() => service.shutdown());
  const thread = await service.createThread('alice', settings);
  await service.run('alice', thread.id, input('message01'));
  await until(
    async () =>
      !!(await service.getThread('alice', thread.id)).toolInteractions?.length,
  );
  await service.respondToTool('alice', thread.id, approval.id, {
    id: 'response1',
    action: 'approve',
  });
  await until(
    async () =>
      !!(await service.getThread('alice', thread.id)).toolInteractions?.some(
        (item) => item.id === 'question-2',
      ),
  );
  assert.equal(
    (await service.getThread('alice', thread.id)).toolInteractions?.find(
      (item) => item.id === 'question-2',
    )?.response,
    undefined,
  );
});

test('ask_user and generic pending tools stay outside collapsed tool groups', () => {
  const parts = [
    {
      type: 'tool-read',
      toolCallId: 'read-1',
      state: 'output-available',
      input: {},
      output: 'read',
    },
    {
      type: 'tool-ask_user',
      toolCallId: 'ask-1',
      state: 'input-available',
      input: { question: 'Where?' },
    },
    {
      type: 'dynamic-tool',
      toolName: 'delete',
      toolCallId: 'delete-1',
      state: 'input-available',
      input: {},
    },
  ] as const;
  const groups = groupMessageParts(
    { id: 'assistant', role: 'assistant', parts: [...parts] },
    new Set(['delete-1']),
  );
  assert.deepEqual(
    groups.map((group) => group.type),
    ['tools', 'part', 'part'],
  );
});
