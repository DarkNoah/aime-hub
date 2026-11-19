import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBackgroundConfig } from '@mastra/core/background-tasks';
import { RequestContext } from '@mastra/core/request-context';
import { createTool, isValidationError, noopObserve } from '@mastra/core/tools';
import { z } from 'zod';
import { createExecTool } from '../../mastra/tools/exec.js';

const backgroundContext = {
  observe: noopObserve,
  agent: {
    agentId: 'agent',
    toolCallId: 'outer',
    messages: [],
    suspend: async () => {},
    isBackgroundTask: true,
  },
  background: {
    taskId: 'task',
    disposition: 'deferred' as const,
    adopt: () => assert.fail('Only Mastra can adopt the outer task'),
  },
};

test('deferred exec waits beyond the foreground deadline and nests tools inline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const requestContext = new RequestContext();
  requestContext.set('userId', 'original');
  const child = createTool({
    id: 'child',
    description: 'Run a foreground child',
    inputSchema: z.object({}),
    background: { enabled: true, defaultDisposition: 'foreground' },
    requireApproval: (_input, context) =>
      context?.requestContext?.userId !== 'original',
    execute: async (_input, context) => {
      assert.equal(context.agent?.isBackgroundTask, undefined);
      assert.equal(context.background, undefined);
      assert.equal(context.agent?.agentId, 'agent');
      assert.notEqual(context.agent?.toolCallId, 'outer');
      assert.equal(context.requestContext?.get('userId'), 'original');
      t.mock.timers.tick(31_000);
      return 'final output';
    },
  });
  const tool = createExecTool({
    getTools: async (context) => {
      requestContext.set('userId', 'next-author');
      assert.equal(context.requestContext?.get('userId'), 'original');
      return [child];
    },
  });
  const config = {
    toolName: tool.id,
    toolConfig: tool.background,
    llmBgOverrides: {},
  };
  assert.equal(resolveBackgroundConfig(config).disposition, 'foreground');
  assert.equal(
    resolveBackgroundConfig({
      ...config,
      llmBgOverrides: { disposition: 'deferred' },
    }).disposition,
    'deferred',
  );
  const result = await tool.execute!(
    { code: 'text(await tools.child({}))', max_output_tokens: 100 },
    { ...backgroundContext, requestContext },
  );
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'final output' }],
  });
});

test('deferred exec propagates cancellation to in-flight tools and the task manager', async () => {
  const controller = new AbortController();
  const reason = new Error('用户中止了操作');
  let childSignal: AbortSignal | undefined;
  const job = createTool({
    id: 'wait',
    description: 'Wait for cancellation',
    execute: async (_input, context) => {
      childSignal = context.abortSignal;
      controller.abort(reason);
      childSignal?.throwIfAborted();
    },
  });
  const tool = createExecTool({ getTools: async () => [job] });
  await assert.rejects(
    () =>
      tool.execute!(
        { code: 'await tools.wait({})', max_output_tokens: 100 },
        { ...backgroundContext, abortSignal: controller.signal },
      ),
    reason,
  );
  assert.equal(childSignal?.reason, reason);
});

test('deferred exec respects an explicit script timeout while discovering tools', async () => {
  const tool = createExecTool({ getTools: () => new Promise(() => {}) });
  await assert.rejects(
    () =>
      tool.execute!(
        { code: 'text(1)', yield_time_ms: 10, max_output_tokens: 100 },
        backgroundContext,
      ),
    /exec execution timed out/,
  );
});

for (const defaultDisposition of [
  undefined,
  'deferred',
  'foreground',
] as const) {
  test(`exec preserves native background dispatch (default=${defaultDisposition})`, async () => {
    let executions = 0;
    const background = createTool({
      id: 'background_job',
      description: 'Run a persistent job.',
      inputSchema: z.object({}),
      background: { enabled: true, defaultDisposition },
      execute: async () => {
        executions++;
        return { completed: true };
      },
    });
    const exec = createExecTool({ getTools: async () => [background] });
    const result = await exec.execute!(
      {
        code: 'text(ALL_TOOLS[0].description); text(await tools.background_job({}));',
        yield_time_ms: 3000,
        max_output_tokens: 1000,
      },
      { observe: noopObserve },
    );
    assert.ok(result && !isValidationError(result));
    const text = result.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n');
    if (defaultDisposition === 'foreground') {
      assert.equal(executions, 1);
      assert.equal(result.isError, undefined);
      assert.match(text, /"completed":true/);
    } else {
      assert.equal(
        executions,
        0,
        'exec must not start a background job inline',
      );
      assert.equal(result.isError, true);
      assert.match(text, /Call background_job directly through the Agent/);
      assert.match(
        text,
        /requires a direct Agent call for native background execution/,
      );
    }
  });
}

for (const override of [
  { enabled: true },
  { disposition: 'deferred' },
  { disposition: 'awaited' },
  { enabled: false },
  { disposition: 'foreground' },
  { enabled: true, disposition: 'foreground' },
] as const) {
  test(`exec honors explicit native background overrides: ${JSON.stringify(override)}`, async () => {
    let executions = 0;
    const job = createTool({
      id: 'optional_background_job',
      description: 'Block by default; support native background on request.',
      inputSchema: z.object({}),
      background: { enabled: true, defaultDisposition: 'foreground' },
      execute: async () => {
        executions++;
        return { completed: true };
      },
    });
    const exec = createExecTool({ getTools: async () => [job] });
    const result = await exec.execute!(
      {
        code: `text(await tools.optional_background_job(${JSON.stringify({ _background: override })}));`,
        yield_time_ms: 3000,
        max_output_tokens: 1000,
      },
      { observe: noopObserve },
    );
    assert.ok(result && !isValidationError(result));
    const foreground =
      'disposition' in override
        ? override.disposition === 'foreground'
        : !override.enabled;
    assert.equal(executions, foreground ? 1 : 0);
    assert.equal(result.isError, foreground ? undefined : true);
    if (!foreground)
      assert.match(
        JSON.stringify(result),
        /direct Agent call for native background execution/,
      );
  });
}
