import assert from 'node:assert/strict';
import test from 'node:test';
import { createTool, isValidationError, noopObserve } from '@mastra/core/tools';
import { z } from 'zod';
import { createExecTool } from '../../mastra/tools/exec.js';

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
