import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CompositeFilesystem, LocalFilesystem } from '@mastra/core/workspace';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { MemoryMDProcessor } from '../../mastra/processors/memory-md.js';
import { groupChatMemoryLocation } from './memory.js';

const binding = { roomId: 'room000000000001', memberId: 'agent00000000001' };
function request(): ProcessLLMRequestArgs {
  return {
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Read the new room event.' }],
      },
    ],
    model: new MastraLanguageModelV2Mock({}),
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    abort: (reason) => {
      throw new Error(reason);
    },
  };
}

test('composite room memory is writable at its advertised virtual path and injected from the same disk file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'group-chat-memory-'));
  const filesystem = new CompositeFilesystem({
    mounts: {
      '/.uploads': new LocalFilesystem({
        basePath: join(root, '.uploads'),
        contained: true,
      }),
      '/data': new LocalFilesystem({
        basePath: join(root, 'data'),
        contained: true,
      }),
    },
  });
  await filesystem.init();
  t.after(async () => {
    await filesystem.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const location = groupChatMemoryLocation(root, binding, filesystem);
  assert.equal(
    location.filePath,
    '/.uploads/.group-chats/room000000000001/agent00000000001/MEMORY.md',
  );
  const processor = new MemoryMDProcessor(location.directory);
  assert.equal(await processor.processLLMRequest(request()), undefined);

  await filesystem.mkdir(posix.dirname(location.filePath), { recursive: true });
  await filesystem.writeFile(
    location.filePath,
    'Prefer concise Chinese replies.',
  );
  assert.equal(
    await readFile(join(location.directory, 'MEMORY.md'), 'utf8'),
    'Prefer concise Chinese replies.',
  );
  const injected = await processor.processLLMRequest(request());
  assert.deepEqual(injected?.prompt?.[0], {
    role: 'user',
    content: [
      {
        type: 'text',
        text: '<memory>\nPrefer concise Chinese replies.\n</memory>',
      },
    ],
  });
  // The same processor reloads changes on the next model call instead of caching.
  await filesystem.writeFile(location.filePath, 'Deliver reports in PDF.');
  assert.match(
    JSON.stringify(await processor.processLLMRequest(request())),
    /Deliver reports in PDF/,
  );
  assert.doesNotMatch(
    JSON.stringify(await processor.processLLMRequest(request())),
    /concise Chinese/,
  );
});

test('room memory files remain separate across agents and rooms in a composite workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'group-chat-memory-isolation-'));
  const filesystem = new CompositeFilesystem({
    mounts: {
      '/.uploads': new LocalFilesystem({
        basePath: join(root, '.uploads'),
        contained: true,
      }),
    },
  });
  await filesystem.init();
  t.after(async () => {
    await filesystem.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const own = groupChatMemoryLocation(root, binding, filesystem);
  await filesystem.mkdir(posix.dirname(own.filePath), { recursive: true });
  await filesystem.writeFile(own.filePath, 'Own memory');
  for (const other of [
    { ...binding, roomId: 'room000000000002' },
    { ...binding, memberId: 'agent00000000002' },
  ]) {
    const location = groupChatMemoryLocation(root, other, filesystem);
    assert.notEqual(location.directory, own.directory);
    assert.equal(
      await new MemoryMDProcessor(location.directory).processLLMRequest(
        request(),
      ),
      undefined,
    );
  }
});

test('personal and simple project workspaces retain a contained .agents memory path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'group-chat-memory-local-'));
  const filesystem = new LocalFilesystem({ basePath: root, contained: true });
  await filesystem.init();
  t.after(async () => {
    await filesystem.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const location = groupChatMemoryLocation(root, binding, filesystem);
  assert.equal(
    location.directory,
    join(root, '.agents', 'group-chats', binding.roomId, binding.memberId),
  );
  assert.equal(location.filePath, join(location.directory, 'MEMORY.md'));
  await filesystem.mkdir(location.directory, { recursive: true });
  await filesystem.writeFile(location.filePath, 'Keep this room decision.');
  const injected = await new MemoryMDProcessor(
    location.directory,
  ).processLLMRequest(request());
  assert.match(JSON.stringify(injected), /Keep this room decision/);
});
