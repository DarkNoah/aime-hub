import assert from 'node:assert/strict';
import test from 'node:test';
import { isToolUIPart, type UIMessage } from 'ai';
import type { ChatToolGroup } from '@aime/shared/chat-turns';
import { getTurnToolGroup, groupTurns, summarizeTurn } from './turns.js';
import { isToolForceRendered } from '../tools/registry.js';

type Part = UIMessage['parts'][number];
const assistant = (id: string, parts: Part[]): UIMessage => ({
  id,
  role: 'assistant',
  parts,
});
const text = (value: string): Part => ({ type: 'text', text: value });
const tool = (id: string, output: unknown = 'large result'): Part => ({
  type: 'tool-read_file',
  toolCallId: id,
  state: 'output-available',
  input: { path: 'example.txt' },
  output,
});
const groups = (parts: Part[]) =>
  parts.flatMap((part) =>
    part.type === 'data-tool-group' ? [part.data as ChatToolGroup] : [],
  );

test('registered display tools expose their definition flag without creating execution tools', () => {
  for (const name of [
    'image_gen',
    'speech',
    'ask_user',
    'intelligent_ui',
    'request_authorization',
  ])
    assert.equal(isToolForceRendered(name), true, name);
  for (const name of ['read_file', 'view_file', 'exec', 'unknown'])
    assert.equal(isToolForceRendered(name), false, name);
});

test('consecutive tools and reasoning collapse across messages, preserving all text and group-only details', () => {
  const reasoning: Part = { type: 'reasoning', text: 'hidden reasoning' };
  const turn = {
    id: 'turn',
    messages: [
      assistant('a', [text('First update'), reasoning, tool('one')]),
      assistant('b', [
        tool('two'),
        { type: 'step-start' },
        text('Second update'),
      ]),
      assistant('c', [tool('three'), text('Final answer')]),
    ],
  };
  const original = structuredClone(turn);
  const summary = summarizeTurn(turn);
  assert.deepEqual(
    summary.assistant?.parts.map((part) => part.type),
    ['text', 'data-tool-group', 'text', 'data-tool-group', 'text'],
  );
  assert.deepEqual(
    summary.assistant?.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text),
    ['First update', 'Second update', 'Final answer'],
  );
  const [first, second] = groups(summary.assistant!.parts);
  assert.equal(first.id, 'a:1');
  assert.equal(first.count, 2);
  assert.equal(first.reasoningIndex, 0);
  assert.equal(first.reasoningOnly, undefined);
  assert.equal(second.id, 'three');
  assert.equal(second.count, 1);
  assert.equal(second.reasoningIndex, undefined);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /hidden reasoning|large result|example.txt/,
  );
  const detail = getTurnToolGroup(turn, first.id)!;
  assert.deepEqual(detail.summary, first);
  assert.deepEqual(
    detail.messages.flatMap((message) => message.parts),
    [reasoning, tool('one'), tool('two')],
  );
  assert.equal(getTurnToolGroup(turn, 'missing'), undefined);
  assert.deepEqual(turn, original);
});

test('group identity survives appended tools and revisions ignore other groups and visible text', () => {
  const thinking: Part = {
    type: 'reasoning',
    text: 'Thinking',
    state: 'streaming',
  };
  const turn = { id: 'turn', messages: [assistant('a', [thinking])] };
  const initial = groups(summarizeTurn(turn).assistant!.parts)[0];
  assert.equal(initial.state, 'running');
  assert.equal(initial.reasoningOnly, true);
  assert.equal(initial.reasoningIndex, 0);
  const twoThoughts = groups(summarizeTurn({ id: 'turn', messages: [assistant('a', [thinking, { ...thinking, text: 'Latest thought' }])] }).assistant!.parts)[0];
  assert.equal(twoThoughts.reasoningIndex, 1);
  assert.equal(twoThoughts.reasoningOnly, true);
  const finishedThinking: Part = { ...thinking, state: 'done' };
  const next = {
    ...turn,
    messages: [
      assistant('a', [
        finishedThinking,
        tool('one'),
        text('Visible'),
        tool('two'),
      ]),
    ],
  };
  const [first, second] = groups(summarizeTurn(next).assistant!.parts);
  assert.equal(first.id, initial.id);
  assert.notEqual(first.revision, initial.revision);
  assert.equal(first.state, 'completed');
  assert.equal(first.reasoningOnly, undefined, 'adding a tool preserves the group even when its reasoning is hidden');
  const changed = {
    ...next,
    messages: [
      assistant('a', [
        finishedThinking,
        next.messages[0].parts[1],
        text('Changed text'),
        tool('two', 'new result'),
      ]),
    ],
  };
  const [unchangedFirst, changedSecond] = groups(
    summarizeTurn(changed).assistant!.parts,
  );
  assert.equal(unchangedFirst.revision, first.revision);
  assert.notEqual(changedSecond.revision, second.revision);
});

test('tool states aggregate without leaking error or approval payloads', () => {
  const failed: Part = {
    type: 'tool-command',
    toolCallId: 'failed',
    state: 'output-error',
    input: {},
    errorText: 'private error',
  };
  const pending: Part = {
    type: 'tool-command',
    toolCallId: 'pending',
    state: 'input-available',
    input: { secret: 'hidden' },
  };
  const snapshot = (parts: Part[]) =>
    summarizeTurn({ id: 'turn', messages: [assistant('a', parts)] });
  assert.equal(groups(snapshot([failed]).assistant!.parts)[0].state, 'failed');
  assert.equal(
    groups(snapshot([failed, pending]).assistant!.parts)[0].state,
    'running',
  );
  assert.equal(
    groups(snapshot([tool('error', { ok: false })]).assistant!.parts)[0].state,
    'failed',
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot([failed, pending])),
    /private error|secret|hidden/,
  );
});

test('force-rendered cards split tool groups and retain required interaction data', () => {
  const ask: Part = {
    type: 'tool-ask_user',
    toolCallId: 'ask',
    state: 'output-available',
    input: { questions: [{ question: 'Choose one', options: ['A', 'B'] }] },
    output: { answer: 'A' },
  };
  const ui: Part = {
    type: 'tool-intelligent_ui',
    toolCallId: 'ui',
    state: 'input-available',
    input: { html: '<p>Choose</p>', title: 'Panel', waitForResponse: true },
  };
  const auth: Part = {
    type: 'tool-request_authorization',
    toolCallId: 'auth',
    state: 'output-available',
    input: { mcpId: 'test' },
    output: { authorized: true },
  };
  const turn = {
    id: 'turn',
    messages: [
      assistant('a', [
        tool('before'),
        ask,
        tool('between'),
        ui,
        auth,
        tool('after'),
      ]),
    ],
  };
  const summary = summarizeTurn(turn);
  assert.deepEqual(
    summary.assistant?.parts.map((part) => part.type),
    [
      'data-tool-group',
      ask.type,
      'data-tool-group',
      ui.type,
      auth.type,
      'data-tool-group',
    ],
  );
  const visible = summary.assistant!.parts.filter(isToolUIPart);
  assert.equal(visible.length, 3);
  for (const part of visible)
    assert.equal('forceRender' in part && part.forceRender, true);
  assert.deepEqual(visible[0].input, ask.input);
  assert.deepEqual(visible[0].output, ask.output);
  assert.deepEqual(visible[1].input, ui.input);
  const custom = summarizeTurn(
    { id: 'turn', messages: [assistant('a', [tool('custom')])] },
    undefined,
    { forceRender: (name) => name === 'read_file' },
  );
  assert.equal(custom.assistant?.parts[0].type, 'tool-read_file');
  assert.equal(custom.hasDetails, false);
});

test('large media and ordinary results produce small summaries with lazy authenticated URLs', () => {
  const data = 'A'.repeat(4 * 1024 * 1024);
  const image: Part = {
    type: 'tool-image_gen',
    toolCallId: 'image',
    state: 'output-available',
    input: {
      prompt: 'private prompt',
      ref_images: [`data:image/png;base64,${data}`],
    },
    output: {
      ok: true,
      content: [
        { type: 'text', text: 'Saved' },
        { type: 'image', mimeType: 'image/png', data },
      ],
    },
  };
  const speech: Part = {
    type: 'tool-speech',
    toolCallId: 'speech',
    state: 'output-available',
    input: {
      input: 'Hello',
      reference_audio: `data:audio/wav;base64,${data}`,
      reference_text: 'private reference',
    },
    output: {
      ok: true,
      content: [{ type: 'audio', mimeType: 'audio/wav', data }],
    },
  };
  const turn = {
    id: 'turn/id',
    messages: [
      assistant('a/id', [tool('large', data), image, speech, text('Done')]),
    ],
  };
  const summary = summarizeTurn(turn, 'cursor/value', {
    threadId: 'thread/id',
  });
  const serialized = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(serialized) < 2500);
  assert.doesNotMatch(
    serialized,
    /base64|private prompt|private reference|AAAA/,
  );
  const media = summary.assistant!.parts.filter(isToolUIPart);
  const output = media[0].output as { content: { url: string }[] };
  assert.equal(
    output.content[0].url,
    '/api/threads/thread%2Fid/turns/turn%2Fid/media?messageId=a%2Fid&toolCallId=image&contentIndex=1&cursor=cursor%2Fvalue',
  );
  assert.deepEqual(media[1].input, { input: 'Hello' });
  const saved = summarizeTurn(
    {
      ...turn,
      messages: [
        assistant('a', [
          {
            ...image,
            output: {
              ok: true,
              file_path: 'outputs/image.png',
              content: [{ type: 'image', mimeType: 'image/png', data }],
            },
          } as Part,
        ]),
      ],
    },
    undefined,
    { threadId: 'thread' },
  );
  const savedOutput = saved.assistant!.parts.filter(isToolUIPart)[0].output as {
    content: { url: string }[];
  };
  assert.equal(
    savedOutput.content[0].url,
    '/api/threads/thread/files/raw?path=outputs%2Fimage.png',
  );
});

test('user boundaries preserve distinct user messages and prevent tool group merging', () => {
  const user = (id: string): UIMessage => ({
    id,
    role: 'user',
    parts: [text(id)],
  });
  const turns = groupTurns([
    user('one'),
    assistant('a', [tool('a')]),
    user('two'),
    assistant('b', [tool('b')]),
  ]);
  const summaries = turns.map((turn) => summarizeTurn(turn));
  assert.deepEqual(
    summaries.map((turn) => turn.user?.id),
    ['one', 'two'],
  );
  assert.deepEqual(
    summaries.map((turn) =>
      groups(turn.assistant!.parts).map((group) => group.id),
    ),
    [['a'], ['b']],
  );
});

test('streaming text updates reuse the unchanged large tool digest for groups and turn revisions', () => {
  let serialized = 0;
  const output = {
    get payload() {
      serialized++;
      return 'A'.repeat(1024 * 1024);
    },
  };
  const large = tool('large', output);
  const first = summarizeTurn({
    id: 'turn',
    messages: [assistant('a', [large, text('First')])],
  });
  assert.equal(
    serialized,
    1,
    'group and message revisions share the part digest',
  );
  const second = summarizeTurn({
    id: 'turn',
    messages: [assistant('a', [large, text('Second')])],
  });
  assert.equal(
    serialized,
    1,
    'text deltas never reserialize unchanged tool output',
  );
  assert.notEqual(first.revision, second.revision);
  assert.equal(
    groups(first.assistant!.parts)[0].revision,
    groups(second.assistant!.parts)[0].revision,
  );
});

test('streaming text updates reuse lightweight media projections without parsing saved base64 again', (t) => {
  const output = JSON.stringify({
    ok: true,
    content: [
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(1024 * 1024) },
    ],
  });
  let parsed = 0;
  const original = JSON.parse;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    if (args[0] === output) parsed++;
    return original(...args);
  });
  const image: Part = {
    type: 'tool-image_gen',
    toolCallId: 'image',
    state: 'output-available',
    input: {},
    output,
  };
  const first = summarizeTurn(
    { id: 'turn', messages: [assistant('a', [image, text('First')])] },
    undefined,
    { threadId: 'thread' },
  );
  const second = summarizeTurn(
    { id: 'turn', messages: [assistant('a', [image, text('Second')])] },
    undefined,
    { threadId: 'thread' },
  );
  assert.equal(parsed, 1);
  assert.equal(first.assistant?.parts[0], second.assistant?.parts[0]);
  assert.doesNotMatch(JSON.stringify(second), /AAAA/);
});
