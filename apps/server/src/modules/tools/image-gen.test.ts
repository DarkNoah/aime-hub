import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import { Workspace, LocalFilesystem } from '@mastra/core/workspace';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultImageGenConfig,
  imageGenConfigSchema,
} from '@aime/shared/tools';
import { emptyModelDefaults } from '@aime/shared/providers';
import { ToolService } from './service.js';
import { createImageGenTool } from '../../mastra/tools/image_gen.js';
import { createImageModel } from '../../mastra/providers/image-model.js';
import { OpenAICompatibleProvider } from '../../mastra/providers/openai-compatible.js';
import { NewApiProvider } from '../../mastra/providers/newapi.js';
import { readFileBlocks } from '../../../../web/src/components/chat/message-preview/read-file-output.js';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Memory } from '@mastra/memory';
import { RequestContext } from '@mastra/core/request-context';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQmcAAAAASUVORK5CYII=',
  'base64',
);
const provider = {
  id: 'images',
  type: 'openai',
  baseUrl: 'https://images.example/v1',
  apiKey: 'synthetic-secret',
  enabled: true,
};
type Request = Parameters<typeof createImageModel>[2];
function transport() {
  const calls: { url: string; options: Parameters<NonNullable<Request>>[1] }[] =
    [];
  const request: NonNullable<Request> = async (url, options) => {
    calls.push({ url, options });
    return {
      url,
      status: 200,
      headers: {},
      body: Buffer.from(
        JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
      ),
    };
  };
  return { calls, request };
}
function runnable(instance: ReturnType<typeof createImageGenTool>) {
  type Execute = NonNullable<typeof instance.execute>;
  return {
    toModelOutput: instance.toModelOutput,
    execute: async (
      input: Parameters<Execute>[0],
      context: Partial<Parameters<Execute>[1]> = {},
    ) => {
      const output = await instance.execute!(input, {
        observe: { span: async (_name, fn) => fn(), log: () => {} },
        ...context,
      });
      assert.ok(output && 'content' in output);
      return output;
    },
  };
}
function tool(request: Request, config = defaultImageGenConfig) {
  return runnable(
    createImageGenTool(config, {
      resolveModel: async () => ({
        reference: 'images/draw',
        model: createImageModel(provider, 'draw', request),
      }),
    }),
  );
}
function fixture() {
  const rows = new Map<string, { id: string; value: unknown }>();
  const database = {
    getRepository: () => ({
      findOneBy: async ({ id }: { id: string }) => rows.get(id),
      upsert: async (row: { id: string; value: unknown }) => {
        rows.set(row.id, structuredClone(row));
      },
    }),
  } as unknown as DataSource;
  const f = transport();
  const state = {
    imageModel: 'images/default',
    enabled: true,
    providerEnabled: true,
    output: ['image'],
    missing: false,
  };
  let defaultReads = 0;
  const providers: ConstructorParameters<typeof ToolService>[1] = {
    getProvider: async () => {
      throw new Error('Unused');
    },
    getDefaults: async () => {
      defaultReads++;
      return { ...emptyModelDefaults, imageModel: state.imageModel || null };
    },
    getModel: async (reference) => {
      if (state.missing) throw new Error('Deleted model');
      return {
        id: reference.slice(reference.indexOf('/') + 1),
        providerId: 'images',
        enabled: state.enabled,
        modalitiesOutput: state.output,
      } as Awaited<ReturnType<typeof providers.getModel>>;
    },
    getProviderInstance: async () => {
      if (!state.providerEnabled) throw new Error('Disabled provider');
      const instance = new OpenAICompatibleProvider(provider);
      instance.imageModel = (id) => createImageModel(provider, id, f.request);
      return instance;
    },
  };
  return {
    ...f,
    rows,
    state,
    providers,
    getDefaultReads: () => defaultReads,
    service: new ToolService(database, providers),
  };
}
async function execute(service: ToolService) {
  const tools = await service.buildTools(['image_gen']);
  const selected = tools.image_gen;
  assert.ok('execute' in selected && selected.execute);
  return selected.execute({ prompt: 'A small tree' }, {});
}

test('image tool configuration rejects invalid references and timeouts', () => {
  assert.deepEqual(imageGenConfigSchema.parse({}), defaultImageGenConfig);
  for (const patch of [
    { model: '' },
    { model: 'bare' },
    { model: 'images/' },
    { timeoutMs: 0 },
    { timeoutMs: 600001 },
    { providerId: 'images' },
    { apiKey: 'secret' },
  ])
    assert.equal(
      imageGenConfigSchema.safeParse({ ...defaultImageGenConfig, ...patch })
        .success,
      false,
    );
  assert.equal(
    imageGenConfigSchema.parse({ model: 'images/vendor/model' }).model,
    'images/vendor/model',
  );
});

test('unset model resolves the current default image model on each execution; explicit model wins', async () => {
  const f = fixture();
  assert.deepEqual(
    (await f.service.get('image_gen')).config,
    defaultImageGenConfig,
  );
  const built = (await f.service.buildTools(['image_gen'])).image_gen;
  assert.ok('execute' in built && built.execute);
  assert.equal(
    (await built.execute({ prompt: 'Tree' }, {})).model,
    'images/default',
  );
  f.state.imageModel = 'images/next';
  assert.equal(
    (await built.execute({ prompt: 'Tree' }, {})).model,
    'images/next',
  );
  await f.service.update('image_gen', {
    ...defaultImageGenConfig,
    model: 'images/vendor/custom',
  });
  const reads = f.getDefaultReads();
  assert.equal((await execute(f.service)).model, 'images/vendor/custom');
  assert.equal(f.getDefaultReads(), reads);
  assert.equal(
    JSON.parse(String(f.calls.at(-1)!.options.body)).model,
    'vendor/custom',
  );
  assert.doesNotMatch(
    JSON.stringify([...f.rows.values()]),
    /synthetic-secret|apiKey/,
  );
  await f.service.update('image_gen', {
    ...defaultImageGenConfig,
    enabled: false,
  });
  assert.deepEqual(await f.service.buildTools(['image_gen']), {});
});

test('missing default and disabled/deleted/non-image models fail before generation', async () => {
  const f = fixture();
  f.state.imageModel = '';
  const missing = await execute(f.service);
  assert.equal(missing.ok, false);
  assert.match(JSON.stringify(missing), /default image generation model/);
  f.state.imageModel = 'images/default';
  for (const patch of [
    { enabled: false },
    { providerEnabled: false },
    { missing: true },
    { output: ['text'] },
  ]) {
    Object.assign(
      f.state,
      {
        enabled: true,
        providerEnabled: true,
        missing: false,
        output: ['image'],
      },
      patch,
    );
    await assert.rejects(
      f.service.update('image_gen', {
        ...defaultImageGenConfig,
        model: 'images/selected',
      }),
      { code: 'INVALID_IMAGE_MODEL' },
    );
    assert.equal((await execute(f.service)).isError, true);
  }
  assert.equal(f.calls.length, 0);
});

test('generation uses the Images endpoint, returns multimodal bytes and reuses the media preview', async () => {
  const f = transport();
  const instance = tool(f.request);
  const output = await instance.execute!(
    { prompt: 'A tree', remove_background: true },
    {},
  );
  assert.ok(!('error' in output) && output.ok);
  assert.equal(output.width, 1);
  assert.equal(output.height, 1);
  assert.equal(f.calls[0].url, 'https://images.example/v1/images/generations');
  assert.deepEqual(JSON.parse(String(f.calls[0].options.body)), {
    model: 'draw',
    prompt: 'A tree',
    n: 1,
    background: 'transparent',
    output_format: 'png',
  });
  assert.equal(
    f.calls[0].options.headers?.authorization,
    'Bearer synthetic-secret',
  );
  const blocks = readFileBlocks(output);
  const image = blocks.find((block) => block.type === 'media');
  assert.equal(image?.mediaType, 'image/png');
  assert.equal(
    image?.source,
    `data:image/png;base64,${png.toString('base64')}`,
  );
  assert.deepEqual(instance.toModelOutput!(output), {
    type: 'content',
    value: [
      output.content[0],
      {
        type: 'image-data',
        data: png.toString('base64'),
        mediaType: 'image/png',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(output), /synthetic-secret/);
});

test('reference images use multipart edits and generated images are saved inside the workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'image-gen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  await workspace.filesystem!.writeFile('reference.png', png);
  const f = transport();
  const output = await tool(f.request).execute!(
    {
      prompt: 'Make it blue',
      ref_images: ['reference.png'],
      remove_background: true,
    },
    { workspace },
  );
  assert.ok(!('error' in output) && output.ok);
  assert.match(output.file_path!, /^outputs\/images\/.+\.png$/);
  assert.deepEqual(await readFile(join(directory, output.file_path!)), png);
  assert.equal(f.calls[0].url, 'https://images.example/v1/images/edits');
  const form = await new Response(
    new Uint8Array(Buffer.from(f.calls[0].options.body!)),
    {
      headers: { 'Content-Type': f.calls[0].options.headers!['content-type'] },
    },
  ).formData();
  assert.equal(form.get('prompt'), 'Make it blue');
  assert.equal(form.get('background'), 'transparent');
  assert.deepEqual(
    Buffer.from(await (form.get('image') as File).arrayBuffer()),
    png,
  );
});

test('invalid reference image and paths outside workspace do not invoke the provider', async () => {
  const f = transport();
  for (const reference of [
    'data:image/png;base64,bm90LWltYWdl',
    '/etc/passwd',
  ]) {
    const output = await tool(f.request).execute!(
      { prompt: 'Edit', ref_images: [reference] },
      {},
    );
    assert.ok(!('error' in output) && output.isError);
    assert.match(JSON.stringify(output), /reference images/);
  }
  assert.equal(f.calls.length, 0);
});

test('URL results are downloaded without provider credentials; HTML and empty results fail safely', async () => {
  const calls: Parameters<NonNullable<Request>>[] = [];
  const request: NonNullable<Request> = async (url, options) => {
    calls.push([url, options]);
    return {
      url,
      status: 200,
      headers: {},
      body:
        options.method === 'POST'
          ? Buffer.from(
              JSON.stringify({
                data: [
                  { url: 'https://cdn.example/generated.png?signature=test' },
                ],
              }),
            )
          : png,
    };
  };
  const output = await tool(request).execute!({ prompt: 'Tree' }, {});
  assert.ok(!('error' in output) && output.ok);
  assert.equal(calls[1][1].headers, undefined);
  for (const body of [
    { data: [] },
    {
      data: [
        { b64_json: Buffer.from('<html>secret</html>').toString('base64') },
      ],
    },
  ]) {
    const output = await tool(async (url) => ({
      url,
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(body)),
    })).execute!({ prompt: 'Tree' }, {});
    assert.ok(!('error' in output) && output.isError);
    assert.doesNotMatch(JSON.stringify(output), /secret|html/);
  }
});

test('cancellation, timeout and upstream failures produce safe errors without retries', async () => {
  const f = transport();
  const cancelled = await tool(f.request).execute!(
    { prompt: 'Tree' },
    { abortSignal: AbortSignal.abort() },
  );
  assert.match(JSON.stringify(cancelled), /cancelled/);
  assert.equal(f.calls.length, 0);
  let calls = 0;
  const failed = await tool(async () => {
    calls++;
    throw new Error('Bearer synthetic-secret');
  }).execute!({ prompt: 'Tree' }, {});
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/);
  const timeout = await tool(
    async (_url, { signal }) =>
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Test did not abort')),
          1500,
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    { ...defaultImageGenConfig, timeoutMs: 1000 },
  ).execute!({ prompt: 'Tree' }, {});
  assert.match(JSON.stringify(timeout), /timed out/);
});

test('New API normalizes /v1 for image generation and supports reference images', async () => {
  const f = transport();
  const instance = new NewApiProvider(
    { ...provider, baseUrl: 'https://images.example' },
    f.request,
  );
  const tool = runnable(
    createImageGenTool(defaultImageGenConfig, {
      resolveModel: async () => ({
        reference: 'images/draw',
        model: instance.imageModel('draw'),
      }),
    }),
  );
  const output = await tool.execute!(
    {
      prompt: 'Tree',
      ref_images: [`data:image/png;base64,${png.toString('base64')}`],
    },
    {},
  );
  assert.ok(!('error' in output) && output.ok);
  assert.equal(f.calls[0].url, 'https://images.example/v1/images/edits');
});

test('onOutput records only saved successful images with trusted agent scope and actual dimensions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'image-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  const recorded: unknown[] = [];
  const instance = createImageGenTool(defaultImageGenConfig, {
    resolveModel: async () => ({
      reference: 'images/draw',
      model: createImageModel(provider, 'draw', transport().request),
    }),
    recordAsset: async (asset) => {
      recorded.push(asset);
    },
  });
  const executable = runnable(instance);
  const agent = {
    agentId: 'agent',
    toolCallId: 'call',
    messages: [],
    suspend: async () => {},
    threadId: 'thread0000000001',
    resourceId: 'user:owner',
  };
  const output = await executable.execute(
    { prompt: 'One pixel' },
    { workspace, agent },
  );
  await instance.onOutput!({
    output,
    toolName: 'image_gen',
    toolCallId: 'call',
  });
  assert.deepEqual(recorded, [
    {
      threadId: agent.threadId,
      resourceId: agent.resourceId,
      createdBy: 'owner',
      path: output.file_path,
      metadata: { width: 1, height: 1 },
      mimeType: 'image/png',
      size: png.length,
      toolName: 'image_gen',
      toolCallId: 'call',
      model: 'images/draw',
    },
  ]);
  const unsaved = await executable.execute(
    { prompt: 'No workspace' },
    { agent },
  );
  const cancelled = await executable.execute(
    { prompt: 'Cancelled' },
    { workspace, agent, abortSignal: AbortSignal.abort() },
  );
  const unscoped = await executable.execute(
    { prompt: 'No scope' },
    { workspace },
  );
  for (const result of [
    unsaved,
    cancelled,
    unscoped,
    { ...output, ok: false },
    { ...output, isError: true },
  ]) {
    await instance.onOutput!({
      output: result,
      toolName: 'image_gen',
      toolCallId: 'ignored',
    });
  }
  assert.equal(recorded.length, 1);
});

test('invalid image dimensions fail without writing a workspace asset', async () => {
  const invalid = png.subarray(0, 12);
  const instance = tool(async (url) => ({
    url,
    status: 200,
    headers: {},
    body: Buffer.from(
      JSON.stringify({ data: [{ b64_json: invalid.toString('base64') }] }),
    ),
  }));
  const output = await instance.execute({ prompt: 'Broken image' });
  assert.equal(output.ok, false);
  assert.equal(output.file_path, undefined);
});

test('native Mastra streaming invokes the asset onOutput hook with the thread and resource context', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'image-hook-'));
  const workspace = new Workspace({
    filesystem: new LocalFilesystem({ basePath: directory }),
  });
  await workspace.init();
  t.after(async () => {
    await workspace.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const recorded: unknown[] = [];
  let step = 0;
  const model = new MastraLanguageModelV2Mock({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          if (step++ === 0)
            controller.enqueue({
              type: 'tool-call',
              toolCallId: 'native-image-call',
              toolName: 'image_gen',
              input: JSON.stringify({ prompt: 'A tiny image' }),
            });
          else {
            controller.enqueue({ type: 'text-start', id: 'text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'text',
              delta: 'Done',
            });
            controller.enqueue({ type: 'text-end', id: 'text' });
          }
          controller.enqueue({
            type: 'finish',
            finishReason: step === 1 ? 'tool-calls' : 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    }),
  });
  const agent = new Agent({
    id: 'image-hook-test',
    name: 'Image hook test',
    instructions: 'Generate the image.',
    model,
    workspace,
    memory: new Memory({
      storage: new InMemoryStore(),
      options: { generateTitle: false },
    }),
    tools: {
      image_gen: createImageGenTool(defaultImageGenConfig, {
        resolveModel: async () => ({
          reference: 'images/draw',
          model: createImageModel(provider, 'draw', transport().request),
        }),
        recordAsset: async (asset) => {
          recorded.push(asset);
        },
      }),
    },
  });
  const requestContext = new RequestContext();
  requestContext.set('userId', 'project-member');
  const result = await agent.stream('Generate an image', {
    requestContext,
    memory: { thread: 'native-thread', resource: 'project:project000000001' },
    maxSteps: 2,
  });
  await result.consumeStream();
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    threadId: 'native-thread',
    resourceId: 'project:project000000001',
    createdBy: 'project-member',
    path: (recorded[0] as { path: string }).path,
    metadata: { width: 1, height: 1 },
    mimeType: 'image/png',
    size: png.length,
    toolName: 'image_gen',
    toolCallId: 'native-image-call',
    model: 'images/draw',
  });
});
