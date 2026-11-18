import assert from 'node:assert/strict';
import test from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import {
  isValidationError,
  noopObserve,
  type ToolExecutionContext,
} from '@mastra/core/tools';
import { createExecTool } from '../../mastra/tools/exec.js';
import { buildTools } from './service.js';

const basicExec = createExecTool({ getTools: async () => [] });
async function run(
  code: string,
  context: Partial<ToolExecutionContext> = {},
  tool = basicExec,
) {
  const output = await tool.execute!(
    { code, yield_time_ms: 5_000, max_output_tokens: 200 },
    { observe: noopObserve, ...context },
  );
  assert.ok(output && !isValidationError(output));
  return output;
}

test('all browser imports dispatch to the current request and emit screenshots as images', async () => {
  const requestContext = new RequestContext();
  const calls: unknown[] = [];
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG9sAAAAASUVORK5CYII=';
  requestContext.set(
    'execBrowser',
    async (name: string, args: unknown, signal: AbortSignal) => {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      calls.push([name, args]);
      if (name === 'screenshot') return `data:image/png;base64,${png}`;
      if (name === 'snapshot') return 'textbox [ref=e1]';
    },
  );
  const output = await run(
    `
    import browser, { browser as named, goto } from 'browser';
    const { snapshot } = await import('browser');
    await goto('about:blank');
    text(await snapshot({ interactiveOnly: true }));
    await named.fill('@e1', 'hello');
    image(await browser.screenshot());
  `,
    { requestContext },
  );
  assert.deepEqual(output, {
    content: [
      { type: 'text', text: 'textbox [ref=e1]' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ],
  });
  assert.deepEqual(calls, [
    ['goto', { url: 'about:blank' }],
    ['snapshot', { interactiveOnly: true }],
    ['fill', { target: '@e1', value: 'hello' }],
    ['screenshot', {}],
  ]);
});

test('browser module requires a host binding even for direct VM dispatch', async () => {
  for (const code of [
    "import { tabs } from 'browser'; await tabs()",
    "await globalThis.__execModuleCall('browser.tabs', {})",
  ]) {
    const result = await run(code);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Browser module unavailable/);
  }
});

test('each exec pins the initiating author before catalog discovery', async () => {
  const requestContext = new RequestContext();
  requestContext.set('execBrowser', async () => ['first author']);
  const switchAuthor = createExecTool({
    getTools: async () => {
      requestContext.set('execBrowser', async () => ['next author']);
      return [];
    },
  });
  const code = "import browser from 'browser'; text(await browser.tabs())";
  const first = await run(code, { requestContext }, switchAuthor);
  const next = await run(code, { requestContext });
  assert.deepEqual(first.content, [{ type: 'text', text: '["first author"]' }]);
  assert.deepEqual(next.content, [{ type: 'text', text: '["next author"]' }]);
});

test('the exec catalog omits native browser tools supplied by Mastra', async () => {
  const tools = await buildTools(['exec']);
  const browser = {
    getTools() {
      assert.fail('exec should not request native browser tools');
    },
  } as unknown as ToolExecutionContext['browser'];
  const result = await run(
    "text(ALL_TOOLS.filter(tool => tool.name.startsWith('browser_')))",
    { browser },
    tools.exec as typeof basicExec,
  );
  assert.deepEqual(result.content, [{ type: 'text', text: '[]' }]);
});

test('legacy operation exclusions apply to browser module calls and raw dispatch', async () => {
  const tools = await buildTools(
    ['exec'],
    { browser_click: { enabled: false } },
    {
      disabledTools: ['browser_tabs', 'browser_type'],
    },
  );
  const exec = tools.exec as typeof basicExec;
  const requestContext = new RequestContext();
  let called = 0;
  requestContext.set('execBrowser', async () => {
    called++;
  });
  const result = await run(
    `
    import browser from 'browser';
    for (const operation of [
      () => browser.newTab('about:blank'),
      () => browser.fill('input', 'hello'),
      () => browser.click('button'),
      () => globalThis.__execModuleCall('browser.closeTab', {}),
      () => globalThis.__execModuleCall('browser.constructor', {}),
    ]) {
      try { await operation(); } catch (error) { text(error.message); }
    }
    await browser.snapshot();
  `,
    { requestContext },
    exec,
  );
  assert.equal(called, 1);
  assert.deepEqual(
    result.content.map((part) => part.type === 'text' && part.text),
    [
      'Browser operation disabled: newTab',
      'Browser operation disabled: fill',
      'Browser operation disabled: click',
      'Browser operation disabled: closeTab',
      'Unknown browser operation: constructor',
    ],
  );
  const tabsOnly = await buildTools(
    ['exec'],
    {},
    { disabledTools: ['browser_goto'] },
  );
  const navigation = await run(
    "import browser from 'browser'; await browser.newTab(); await browser.newTab('about:blank')",
    { requestContext },
    tabsOnly.exec as typeof basicExec,
  );
  assert.match(
    JSON.stringify(navigation.content),
    /Browser operation disabled: goto/,
  );
  assert.equal(called, 2);
});

test('aborting exec wakes the VM while its browser call is still pending', async () => {
  const controller = new AbortController();
  const requestContext = new RequestContext();
  let markStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    markStarted = resolve;
  });
  requestContext.set(
    'execBrowser',
    (_name: string, _args: unknown, signal: AbortSignal) => {
      markStarted(signal);
      return new Promise(() => {});
    },
  );
  const pending = run("import browser from 'browser'; await browser.tabs()", {
    requestContext,
    abortSignal: controller.signal,
  });
  const browserSignal = await started;
  controller.abort();
  const output = await pending;
  assert.equal(browserSignal.aborted, true);
  assert.deepEqual(output, {
    isError: true,
    content: [{ type: 'text', text: 'exec: 用户中止了操作' }],
  });
});
