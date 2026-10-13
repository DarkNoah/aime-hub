import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolsInput } from '@mastra/core/agent';
import {
  createTool,
  isValidationError,
  noopObserve,
  type ToolExecutionContext,
} from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';
import { createExecTool } from '../../mastra/tools/exec.js';
import { getWorkspace, userDirectory } from '../threads/workspace.js';
import { resolveAgentSkillPaths } from '../threads/skills.js';
import { buildTools } from './service.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG9sAAAAASUVORK5CYII=';
function fixture(tools: ToolsInput = {}) {
  const tool = createExecTool({ getTools: async () => tools });
  return {
    tool,
    run: async (
      code: string,
      context: Partial<ToolExecutionContext> = {},
      options = {},
    ) => {
      const output = await tool.execute!(
        { code, yield_time_ms: 3000, max_output_tokens: 1000, ...options },
        { observe: noopObserve, ...context },
      );
      assert.ok(output && !isValidationError(output));
      return output;
    },
  };
}
const texts = (output: { content: { type: string; text?: string }[] }) =>
  output.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

test('only explicit output is returned, preserving call order and fresh runtime state', async () => {
  const f = fixture();
  const output = await f.run(
    'globalThis.previous = 1; text({ n: 2 }); text(false); text(undefined); text(null); return "hidden";',
  );
  assert.equal(texts(output), '{"n":2}\nfalse\nundefined\nnull');
  assert.deepEqual(await f.run('42; return { secret: true };'), {
    content: [],
  });
  assert.equal(texts(await f.run('text(typeof previous);')), 'undefined');
  assert.equal(
    texts(
      await f.run(
        'text([typeof process,typeof require,typeof fetch,typeof console,typeof setTimeout]);',
      ),
    ),
    '["undefined","undefined","undefined","undefined","undefined"]',
  );
});

test('catalog metadata, hidden built-ins and schemas are available without exposing exec recursively', async () => {
  const tools = await buildTools(['exec'], { sleep: { enabled: false } });
  assert.deepEqual(Object.keys(tools), ['exec']);
  const exec = tools.exec as ReturnType<typeof createExecTool>;
  const output = await exec.execute!(
    {
      code: 'text(ALL_TOOLS); text(tools.curr_time.inputSchema); text(await tools.curr_time({}));',
      yield_time_ms: 3000,
      max_output_tokens: 10000,
    },
    { observe: noopObserve },
  );
  assert.ok(
    output && !isValidationError(output) && !output.isError,
    JSON.stringify(output),
  );
  const content = output.content;
  assert.equal(content[0].type, 'text');
  const catalog = JSON.parse(
    content[0].type === 'text' ? content[0].text : '[]',
  );
  assert.ok(
    catalog.some(
      (t: { name: string; description: string }) =>
        t.name === 'curr_time' && t.description,
    ),
  );
  assert.equal(
    catalog.some((t: { name: string }) => ['exec', 'sleep'].includes(t.name)),
    false,
  );
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['description', 'name']);
  assert.equal(content.length, 3);
});

test('parallel built-in and MCP calls preserve results, schema validation and request context', async () => {
  const requestContext = new RequestContext();
  requestContext.set('owner', 'alice');
  let active = 0,
    maxActive = 0,
    runs = 0,
    outputs = 0;
  const echo = createTool({
    id: 'echo',
    description: 'Echo a number',
    inputSchema: z.object({ n: z.number(), offset: z.number().default(1) }),
    execute: async ({ n, offset }, context) => {
      assert.equal(context.requestContext?.get('owner'), 'alice');
      assert.ok(context.abortSignal);
      runs++;
      active++;
      maxActive = Math.max(active, maxActive);
      await delay(n === 1 ? 30 : 5);
      active--;
      return { n: n + offset };
    },
    onOutput: () => {
      outputs++;
    },
  });
  const f = fixture({ echo, mcp__test__echo: echo });
  const output = await f.run(
    'text(await Promise.all([tools.echo({n:1}), tools.mcp__test__echo({n:2})]));',
    { requestContext },
  );
  assert.equal(texts(output), '[{"n":2},{"n":3}]');
  assert.equal(maxActive, 2);
  assert.equal(outputs, 2);
  const invalid = await f.run('await tools.echo({n:"invalid"});', {
    requestContext,
  });
  assert.equal(invalid.isError, true);
  assert.equal(runs, 2);
  const caught = await f.run(
    'try { await tools.echo({n:"bad"}); } catch(e) { text(e.message); }',
    { requestContext },
  );
  assert.equal(caught.isError, undefined);
  assert.match(texts(caught), /validation|invalid/i);
});

test('exec skill tools honor dynamic automatic and custom scope restrictions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'exec-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, marker] of [
    ['.agents/skills/shared', 'GLOBAL_SKILL_CONTENT'],
    ['users/tester/.agents/skills/personal', 'PERSONAL_SKILL_CONTENT'],
    ['users/other/.agents/skills/private', 'PRIVATE_SKILL_CONTENT'],
  ]) {
    const directory = join(root, path);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ignored\ndescription: ${marker}\n---\n${marker}`,
    );
  }
  for (const { skillsMode, skillPaths } of [
    { skillsMode: 'auto', skillPaths: [] },
    { skillsMode: 'custom', skillPaths: ['shared'] },
    { skillsMode: 'custom', skillPaths: [] },
  ] as const) {
    const workspace = getWorkspace(
      root,
      'tester',
      join(userDirectory(root, 'tester'), skillsMode),
      undefined,
      () =>
        resolveAgentSkillPaths(root, 'tester', {
          source: 'database',
          skillsMode,
          skillPaths: [...skillPaths],
        }),
    );
    t.after(() => workspace.destroy());
    const output = await fixture().run(
      'text(await tools.skill({name:"shared"})); text(await tools.skill({name:"personal"})); text(await tools.skill({name:"private"}));',
      { workspace, requestContext: new RequestContext() },
    );
    assert.equal(output.isError, undefined, texts(output));
    if (skillsMode === 'auto' || skillPaths.length)
      assert.match(texts(output), /GLOBAL_SKILL_CONTENT/);
    else assert.doesNotMatch(texts(output), /GLOBAL_SKILL_CONTENT/);
    assert.doesNotMatch(texts(output), /PRIVATE_SKILL_CONTENT/);
    if (skillsMode === 'auto')
      assert.match(texts(output), /PERSONAL_SKILL_CONTENT/);
    else assert.doesNotMatch(texts(output), /PERSONAL_SKILL_CONTENT/);
  }
});

test('real workspace tools honor paths, disabled tools and multimodal read output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'exec-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(userDirectory(root, 'tester'), 'session');
  const workspace = getWorkspace(root, 'tester', path);
  await workspace.init();
  t.after(() => workspace.destroy());
  await writeFile(join(path, 'readme.txt'), 'workspace-content');
  await writeFile(join(path, 'pixel.png'), Buffer.from(png, 'base64'));
  const f = fixture();
  const output = await f.run(
    'text(ALL_TOOLS.map(t => t.name)); text(await tools.read_file({path:"readme.txt"})); image(await tools.read_file({path:"pixel.png"}));',
    { workspace },
  );
  assert.equal(output.isError, undefined, texts(output));
  assert.match(texts(output), /read_file/);
  assert.match(texts(output), /workspace-content/);
  assert.doesNotMatch(texts(output), /"delete"|"list_files"/);
  assert.deepEqual(output.content.at(-1), {
    type: 'image',
    data: png,
    mimeType: 'image/png',
  });
  const denied = await f.run(
    'text(await tools.read_file({path:"../../../../etc/passwd"}));',
    { workspace },
  );
  assert.equal(denied.isError, true);
});

test('image helpers emit real content parts and text(image) stays text', async () => {
  const f = fixture();
  const output = await f.run(
    `image('data:image/png;base64,${png}'); image({type:'image',data:'${png}',mimeType:'image/png'}); image({image_url:'data:image/png;base64,${png}'}); text({type:'image',data:'${png}',mimeType:'image/png'});`,
  );
  assert.deepEqual(
    output.content.map((p) => p.type),
    ['image', 'image', 'image', 'text'],
  );
  const model = f.tool.toModelOutput!(output) as {
    type: string;
    value: { type: string; mediaType?: string }[];
  };
  assert.equal(model.type, 'content');
  assert.deepEqual(model.value[0], {
    type: 'image-data',
    data: png,
    mediaType: 'image/png',
  });
  for (const code of [
    'image("https://example.com/photo.png")',
    'image({data:"%%%%",mimeType:"image/png"})',
  ])
    assert.equal((await f.run(code)).isError, true);
});

test('async timeout and caller cancellation abort nested calls and discard late output', async () => {
  let nested: AbortSignal | undefined;
  const wait = createTool({
    id: 'wait',
    description: 'Wait',
    execute: async (_, context) => {
      nested = context.abortSignal;
      await delay(500, undefined, { signal: nested });
      return 'late';
    },
  });
  const f = fixture({ wait });
  const timed = await f.run(
    'text("before"); text(await tools.wait({}));',
    {},
    { yield_time_ms: 40 },
  );
  assert.equal(timed.isError, true);
  assert.match(texts(timed), /before\nexec: .*timed out/);
  assert.equal(nested?.aborted, true);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('caller cancelled')),
    30,
  );
  const cancelled = await f.run('await tools.wait({});', {
    abortSignal: controller.signal,
  });
  clearTimeout(timer);
  assert.match(texts(cancelled), /caller cancelled/);
  assert.equal(nested?.aborted, true);
  assert.equal(texts(await f.run('text("healthy")')), 'healthy');
});

test('infinite loops, async infinite loops, memory exhaustion and unresolved promises terminate', async () => {
  const f = fixture();
  for (const code of [
    'while(true) {}',
    'await Promise.resolve(); while(true) {}',
    'const a=[]; while(true) a.push(new Array(100000).fill(1));',
    'await new Promise(() => {});',
  ]) {
    const result = await f.run(code, {}, { yield_time_ms: 100 });
    assert.equal(result.isError, true, code);
  }
  assert.equal(texts(await f.run('text(1)')), '1');
});

test('unawaited calls do not emit results or leave a live VM', async () => {
  let started = 0;
  const tool = createTool({
    id: 'work',
    description: 'Work',
    execute: async () => {
      started++;
      return 'hidden';
    },
  });
  const f = fixture({ work: tool });
  assert.deepEqual(await f.run('tools.work({}); text("done");'), {
    content: [{ type: 'text', text: 'done' }],
  });
  assert.equal(started, 0);
});

test('approval and suspension tools cannot bypass the Agent interaction flow', async () => {
  let runs = 0;
  const guarded = createTool({
    id: 'guarded',
    description: 'Guarded',
    requireApproval: true,
    execute: async () => {
      runs++;
    },
  });
  const suspending = createTool({
    id: 'suspending',
    description: 'Suspend',
    suspendSchema: z.object({}),
    execute: async () => {
      runs++;
    },
  });
  const f = fixture({ guarded, suspending });
  for (const name of ['guarded', 'suspending']) {
    const output = await f.run(`await tools.${name}({});`);
    assert.equal(output.isError, true);
    assert.match(texts(output), /direct Agent call/);
  }
  assert.equal(runs, 0);
});

test('text budgets preserve UTF-8 and errors remain visible after truncation', async () => {
  const f = fixture();
  const output = await f.run(
    'text("中文内容"); text("hidden"); throw new Error("failed");',
    {},
    { max_output_tokens: 1 },
  );
  assert.equal(output.truncated, true);
  assert.equal(
    output.content[0].type === 'text' && output.content[0].text,
    '中',
  );
  assert.match(texts(output), /failed/);
  assert.doesNotMatch(texts(output), /�/);
});

test('normalized names are callable and collisions fail explicitly', async () => {
  const tool = createTool({
    id: 'named',
    description: 'Name',
    execute: async () => 'ok',
  });
  const f = fixture({ 'mcp__test__read-file': tool });
  assert.equal(
    texts(await f.run('text(await tools.mcp__test__read_file({}));')),
    'ok',
  );
  const collision = await fixture({ 'a-b': tool, a_b: tool }).run('text(1)');
  assert.equal(collision.isError, true);
  assert.match(texts(collision), /Conflicting/);
});

test('tool discovery timeout and pre-aborted contexts finish without running code', async () => {
  const tool = createExecTool({ getTools: () => new Promise(() => {}) });
  const result = await tool.execute!(
    { code: 'text(1)', yield_time_ms: 20, max_output_tokens: 100 },
    { observe: noopObserve },
  );
  assert.ok(result && !isValidationError(result));
  assert.equal(result.isError, true);
  assert.match(texts(result), /timed out/);
  const controller = new AbortController();
  controller.abort(new Error('already cancelled'));
  const cancelled = await fixture().run('text(1)', {
    abortSignal: controller.signal,
  });
  assert.equal(cancelled.isError, true);
  assert.doesNotMatch(texts(cancelled), /^1/);
});

test('dynamic approval uses validated defaults and browser tools are included', async () => {
  let executions = 0;
  const guarded = createTool({
    id: 'browser_action',
    description: 'Browser action',
    inputSchema: z.object({ allow: z.boolean().default(false) }),
    requireApproval: ({ allow }) => !allow,
    execute: async () => {
      executions++;
      return 'done';
    },
  });
  const browser = {
    getTools: () => ({ browser_action: guarded }),
  } as unknown as ToolExecutionContext['browser'];
  const f = fixture();
  assert.equal(
    (await f.run('await tools.browser_action({});', { browser })).isError,
    true,
  );
  assert.equal(executions, 0);
  assert.equal(
    texts(
      await f.run('text(await tools.browser_action({allow:true}));', {
        browser,
      }),
    ),
    'done',
  );
  assert.equal(executions, 1);
});

test('wildcard screenshot media is recognized and unsupported image bytes are rejected', async () => {
  const f = fixture();
  const output = await f.run(
    `image({type:'media',data:'${png}',mediaType:'image/*'});`,
  );
  assert.equal(output.isError, undefined);
  assert.equal(
    output.content[0].type === 'image' && output.content[0].mimeType,
    'image/png',
  );
  assert.equal(
    (await f.run('image({data:"SGVsbG8=",mimeType:"image/png"});')).isError,
    true,
  );
});

test('pending calls are aborted after an awaited sibling fails, even if a tool ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  const slow = createTool({
    id: 'slow',
    description: 'Slow',
    execute: async (_, context) => {
      signal = context.abortSignal;
      await delay(30);
      return 'late';
    },
  });
  const fail = createTool({
    id: 'fail',
    description: 'Fail',
    execute: async () => {
      throw new Error('sibling failed');
    },
  });
  const f = fixture({ slow, fail });
  const result = await f.run(
    'await Promise.all([tools.slow({}).then(text), tools.fail({})]);',
  );
  assert.equal(result.isError, true);
  assert.equal(signal?.aborted, true);
  await delay(50);
  assert.doesNotMatch(texts(result), /late/);
  assert.equal(texts(await f.run('text("next")')), 'next');
});

test('nested call and output limits bound memory use', async () => {
  const work = createTool({
    id: 'work',
    description: 'Work',
    execute: async () => 'ok',
  });
  const f = fixture({ work });
  for (const code of [
    'await Promise.all(Array.from({length:33}, () => tools.work({})));',
    'for(let i=0;i<257;i++) await tools.work({});',
  ]) {
    const result = await f.run(code);
    assert.equal(result.isError, true);
    assert.match(texts(result), /tool call limit/);
  }
  const imageLimit = await f.run(
    `image({data:'${png}' + 'A'.repeat(15*1024*1024),mimeType:'image/png'});`,
    {},
    { yield_time_ms: 5000 },
  );
  assert.equal(imageLimit.isError, true);
});

test('string arguments and primitive nested results cross the VM boundary unchanged', async () => {
  const echo = createTool({
    id: 'echo',
    description: 'Echo',
    inputSchema: z.string(),
    execute: async (value) => value,
  });
  const f = fixture({ echo });
  assert.equal(texts(await f.run('text(await tools.echo("hello"));')), 'hello');
});
