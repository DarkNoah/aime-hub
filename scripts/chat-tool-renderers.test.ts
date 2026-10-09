import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolInteraction } from '@aime/shared/threads';
import { groupMessageParts } from '../apps/web/src/components/chat/messages.js';
import {
  createSubmitPlanResponse,
  getSubmitPlanData,
} from '../apps/web/src/components/chat/tool-renderers/submit-plan-data.js';
import {
  getToolName,
  isSpecialTool,
} from '../apps/web/src/components/chat/tool-renderers/registry.js';
import { validateToolResponse } from '../apps/server/src/modules/threads/tool-interactions.js';

const interaction: ToolInteraction = {
  id: 'plan-1',
  runId: 'run-1',
  toolCallId: 'call-plan',
  toolName: 'submit_plan',
  kind: 'suspended',
  input: { path: 'old.md' },
  suspendPayload: { path: '.mastracode/plans/方案.md' },
  resumeSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['approved', 'rejected'] },
      feedback: { type: 'string' },
      path: { type: 'string' },
    },
  },
};

test('static and dynamic plans stay independent between regular tool groups, including history', () => {
  for (const type of ['tool-submit_plan', 'dynamic-tool'] as const) {
    for (const state of ['input-available', 'output-available'] as const) {
      const plan = {
        type,
        toolName: 'submit_plan',
        toolCallId: 'plan',
        input: {},
        ...(state === 'output-available' ? { state, output: {} } : { state }),
      } as NonNullable<Parameters<typeof getToolName>[0]>;
      const read = {
        type: 'tool-read',
        toolCallId: 'read',
        state: 'output-available',
        input: {},
        output: false,
      } as const;
      const parts = [read, plan, { ...read, toolCallId: 'read-2' }];
      const groups = groupMessageParts({
        id: 'message',
        role: 'assistant',
        parts,
      });
      assert.deepEqual(
        groups.map((group) => group.type),
        ['tools', 'part', 'tools'],
      );
      assert.equal(getToolName(plan), 'submit_plan');
      assert.ok(isSpecialTool(getToolName(plan)));
    }
  }
  assert.equal(isSpecialTool('toString'), false);
  assert.equal(isSpecialTool(undefined), false);
});

test('plan data prefers the suspension and preserves the file path after rejection and history replay', () => {
  assert.equal(
    getSubmitPlanData(interaction).path,
    '.mastracode/plans/方案.md',
  );
  assert.equal(getSubmitPlanData(interaction).decision, undefined);
  const output = {
    submittedPlan: {
      path: 'reviewed.md',
      title: 'Plan',
      action: 'rejected',
      feedback: 'Add tests',
    },
  };
  const historical = getSubmitPlanData(undefined, {
    type: 'dynamic-tool',
    toolName: 'submit_plan',
    toolCallId: 'plan',
    state: 'output-available',
    input: {},
    output,
  });
  assert.equal(historical.path, 'reviewed.md');
  assert.equal(historical.decision, 'rejected');
  assert.equal(historical.feedback, 'Add tests');
  assert.equal(historical.title, 'Plan');
});

test('an acknowledged response updates the decision before the tool output arrives', () => {
  const response = {
    id: 'response1',
    ...createSubmitPlanResponse('rejected', 'plan.md', '  Adjust scope  '),
  };
  const data = getSubmitPlanData(interaction, undefined, response);
  assert.equal(data.decision, 'rejected');
  assert.equal(data.feedback, 'Adjust scope');
  assert.equal(data.path, 'plan.md');
});

test('approve and reject use valid resume data; rejection does not require feedback', () => {
  for (const action of ['approved', 'rejected'] as const) {
    const response = {
      id: 'response1',
      ...createSubmitPlanResponse(action, 'plan.md', '   '),
    };
    assert.deepEqual(response.data, { action, path: 'plan.md' });
    assert.doesNotThrow(() => validateToolResponse(interaction, response));
  }
  assert.throws(
    () =>
      validateToolResponse(interaction, { id: 'response1', action: 'decline' }),
    { code: 'VALIDATION_ERROR' },
  );
});

test('malformed and fallback outputs never imply plan approval', () => {
  for (const output of [
    null,
    false,
    0,
    'done',
    [],
    { content: 'Submitted for review' },
    { submittedPlan: { action: 'unknown', path: 3 } },
  ]) {
    const data = getSubmitPlanData(undefined, {
      type: 'tool-submit_plan',
      toolCallId: 'plan',
      state: 'output-available',
      input: { path: 'plan.md' },
      output,
    });
    assert.equal(data.decision, undefined);
    assert.equal(data.path, 'plan.md');
  }
  assert.equal(
    getSubmitPlanData(undefined, {
      type: 'tool-submit_plan',
      toolCallId: 'plan',
      state: 'output-available',
      input: {},
      output: { isError: true },
    }).failed,
    true,
  );
});
