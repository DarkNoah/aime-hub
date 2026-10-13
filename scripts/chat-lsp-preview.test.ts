import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLspOutput } from '../apps/web/src/components/chat/message-preview/lsp-output.js';

test('LSP preview preserves native hover, diagnostics, definitions and implementations', () => {
  const output = {
    hover: {
      kind: 'markdown',
      value: '```typescript\nconst count: number\n```',
    },
    diagnostics: [
      { severity: 'error', message: 'Type mismatch', source: 'typescript' },
    ],
    definition: [
      {
        location: '/workspace/values.ts:L1:C14',
        preview: 'export const count = 42;',
      },
    ],
    implementation: ['/workspace/other.ts:L3:C1'],
  };
  assert.deepEqual(parseLspOutput(output), output);
  assert.deepEqual(parseLspOutput(JSON.stringify(output)), output);
});

test('LSP preview distinguishes an empty inspection from an error or unknown output', () => {
  assert.deepEqual(parseLspOutput({}), {});
  assert.deepEqual(parseLspOutput({ error: 'No language server available' }), {
    error: 'No language server available',
  });
  for (const value of [
    undefined,
    null,
    [],
    'truncated...',
    { unexpected: true },
    { hover: 'invalid' },
    { diagnostics: [{ message: 'incomplete' }] },
  ]) {
    assert.equal(parseLspOutput(value), null);
  }
});
