import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAutomationToolResult } from '../apps/web/src/components/chat/message-preview/automation-data.js';

const automation = {
  id: 'agent_test',
  name: 'Daily digest',
  prompt: 'Summarize changes',
  cron: '0 9 * * *',
  enabled: false,
  maxSteps: 100,
  separateThread: true,
  desktopNotification: false,
  settings: { agentId: null, model: null, reasoningEffort: 'auto' },
  timezone: 'Asia/Shanghai',
  threadId: 'schedule:1234567890123456',
  threadCreated: true,
  resourceId: 'user:alice',
  scope: { scope: 'personal' },
  createdBy: 'alice',
  createdAt: '2026-10-16T00:00:00Z',
  updatedAt: '2026-10-16T00:00:00Z',
  nextFireAt: null,
  lastFireAt: '2026-10-16T01:00:00Z',
};

test('automation previews preserve requested versus actual execution results and paused status', () => {
  const requested = { automation, requested: true };
  assert.deepEqual(parseAutomationToolResult(requested), requested);
  const history = {
    automation,
    runs: [
      {
        id: 'r1',
        firedAt: '2026-10-16T01:00:00Z',
        status: 'failed',
        text: '',
        error: 'AUTOMATION_RUN_FAILED',
      },
      {
        id: 'r2',
        firedAt: '2026-10-16T00:00:00Z',
        status: 'succeeded',
        text: 'Result',
        error: null,
      },
    ],
  };
  assert.deepEqual(parseAutomationToolResult(history), history);
  assert.deepEqual(parseAutomationToolResult(JSON.stringify(history)), history);
});

test('empty, read-only and deletion snapshots keep their meaning; malformed outputs fall back', () => {
  for (const value of [
    { items: [], canManage: false, timezone: 'UTC' },
    { items: [automation], canManage: true, timezone: 'Asia/Shanghai' },
    { id: automation.id, deleted: true },
  ])
    assert.deepEqual(parseAutomationToolResult(value), value);
  for (const value of [
    undefined,
    null,
    'bad json',
    {},
    { items: [] },
    { automation: { ...automation, enabled: 'false' } },
    { automation, requested: false },
    { id: automation.id, deleted: false },
    { automation, runs: [{ status: 'unknown' }] },
  ])
    assert.equal(parseAutomationToolResult(value), null);
});
