import assert from 'node:assert/strict';
import test from 'node:test';
import type { UIMessage } from 'ai';
import {
  mergeThreadMessages,
  reconcileThreadMessages,
} from '@aime/shared/thread-messages';

const assistant = (id: string, parts: UIMessage['parts']): UIMessage => ({
  id,
  role: 'assistant',
  parts,
});
const text = (value: string) => ({ type: 'text' as const, text: value });

test('a delayed compact abort record and its segmented draft converge in either order and on history reload', () => {
  const draft = assistant('draft', [
    { type: 'step-start' },
    { type: 'reasoning', text: 'Thinking' },
    text('First '),
    text('Second'),
  ]);
  for (const storedText of ['First Sec', 'First Second', 'First Second!']) {
    const saved = assistant('saved', [
      {
        ...text(storedText),
        providerMetadata: { mastra: { createdAt: 123 } },
      },
    ]);
    const observed = {
      ...saved,
      metadata: { interruptedReply: { draftId: draft.id, storedId: saved.id } },
    };
    for (const initial of [
      mergeThreadMessages([draft], [observed]),
      mergeThreadMessages([observed], [draft]),
    ]) {
      for (const result of [
        initial,
        mergeThreadMessages([saved], initial),
        mergeThreadMessages(initial, [saved]),
      ]) {
        assert.equal(result.length, 1);
        assert.deepEqual(result[0].parts, [
          ...draft.parts.slice(0, -1),
          {
            ...text(storedText.endsWith('!') ? 'Second!' : 'Second'),
            providerMetadata: { mastra: { createdAt: 123 } },
          },
        ]);
      }
    }
  }
});

test('a stale save updates the tool without erasing the later step or the separate narrative parts', () => {
  const marker = { type: 'step-start' } as const;
  const tool = {
    type: 'tool-search',
    toolCallId: 'call',
    state: 'input-available',
    input: {},
  } as const;
  const result = {
    ...tool,
    state: 'output-available',
    output: 'result',
  } as const;
  const reasoning = { type: 'reasoning', text: 'Checking' } as const;
  const tail = [reasoning, text('First paragraph.'), text('Second paragraph.')];
  const stampedIntro = {
    ...text('Intro'),
    providerMetadata: { mastra: { createdAt: 123 } },
  };
  const live = assistant('same', [
    marker,
    text('Intro'),
    tool,
    marker,
    ...tail,
  ]);
  const saved = assistant('same', [stampedIntro, result, marker]);
  saved.metadata = { createdAt: 123 };
  const merged = mergeThreadMessages([live], [saved]);
  for (const state of [
    merged,
    mergeThreadMessages([saved], [live]),
    mergeThreadMessages(merged, [saved]),
    mergeThreadMessages(merged, [live]),
  ]) {
    assert.deepEqual(state, [
      { ...saved, parts: [marker, stampedIntro, result, marker, ...tail] },
    ]);
  }
});

test('same-ID storage can omit reasoning and save a shorter prefix while a stopped draft still has its final text', () => {
  const draft = assistant('draft', [
    { type: 'reasoning', text: 'Checking' },
    text('Partial answer'),
  ]);
  const saved = assistant(draft.id, [text('Partial')]);
  saved.metadata = { createdAt: 123 };
  assert.deepEqual(mergeThreadMessages([draft], [saved]), [
    { ...saved, parts: draft.parts },
  ]);
});

test('a new assistant step can start with the same words as an earlier tool step', () => {
  const user: UIMessage = { id: 'user', role: 'user', parts: [text('Check')] };
  const earlier = assistant('earlier', [
    text('Checking'),
    {
      type: 'tool-search',
      toolCallId: 'c',
      state: 'output-available',
      input: {},
      output: 'result',
    },
  ]);
  const live = assistant('live', [text('Checking complete')]);
  const current = [user, earlier, live];
  assert.deepEqual(
    reconcileThreadMessages(current, [user, earlier], [live.id]),
    current,
  );
});

test('matching text alone cannot consume another turn or an ambiguous repeated narrative', () => {
  const draft = assistant('draft', [text('Again')]);
  const saved = assistant('saved', [text('Again')]);
  const extra = assistant('extra', [text('Again')]);
  const user: UIMessage = { id: 'user', role: 'user', parts: [text('More')] };
  assert.equal(
    reconcileThreadMessages([draft, user], [saved], [draft.id]).length,
    3,
  );
  assert.equal(
    reconcileThreadMessages([draft], [saved, extra], [draft.id]).length,
    3,
  );
  assert.equal(
    reconcileThreadMessages([draft, extra], [saved], [draft.id, extra.id])
      .length,
    3,
  );
});
