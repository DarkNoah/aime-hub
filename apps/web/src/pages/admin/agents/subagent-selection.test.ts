import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentNameSchema } from '@aime/shared/agents';
import { updateSubagentSelection } from './subagent-selection.js';

test('multi-select preserves existing prompt aliases and removes all aliases for deselected agents', () => {
  const saved = {
    researcher: 'default',
    fallback: 'default',
    writer: 'code:assistant',
    missing: 'deleted',
  };
  const selected = updateSubagentSelection(saved, [
    'default',
    'code:assistant',
    'new-agent',
    'new-agent',
  ]);
  assert.deepEqual(selected, {
    researcher: 'default',
    fallback: 'default',
    writer: 'code:assistant',
    'new-agent': 'new-agent',
  });
  assert.deepEqual(updateSubagentSelection(selected, ['new-agent']), {
    'new-agent': 'new-agent',
  });
  assert.deepEqual(updateSubagentSelection(saved, []), {});
  assert.equal(saved.missing, 'deleted');
});

test('generated delegation names remain unique and valid when IDs normalize or truncate to the same name', () => {
  const ids = [
    'code:assistant',
    'code_assistant',
    `${'a'.repeat(58)}:one`,
    `${'a'.repeat(58)}:two`,
  ];
  const selected = updateSubagentSelection({ code_assistant: 'saved-agent' }, [
    'saved-agent',
    ...ids,
  ]);
  assert.equal(selected.code_assistant, 'saved-agent');
  assert.deepEqual(
    new Set(Object.values(selected)),
    new Set(['saved-agent', ...ids]),
  );
  assert.equal(Object.keys(selected).length, 5);
  for (const name of Object.keys(selected))
    assert.ok(subagentNameSchema.safeParse(name).success);
});
