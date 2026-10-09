import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrepOutput } from '../apps/web/src/components/chat/message-preview/grep-output.js';

test('grep groups matching and context lines while preserving indentation and hunk gaps', () => {
  const result = parseGrepOutput(
    [
      '3 matches across 2 files',
      '---',
      './src/a.ts:1- const enabled = true;',
      './src/a.ts:2:3:   // TODO: update',
      './src/a.ts:3- ',
      '--',
      './src/a.ts:10:1: TODO: verify',
      '--',
      './src/b.ts:5:7: const TODO = 1;',
    ].join('\n'),
  );
  assert.equal(result?.matchCount, 3);
  assert.equal(result?.fileCount, 2);
  assert.deepEqual(result?.files[0], {
    path: './src/a.ts',
    lines: [
      {
        line: 1,
        column: undefined,
        content: 'const enabled = true;',
        gapBefore: false,
      },
      { line: 2, column: 3, content: '  // TODO: update', gapBefore: false },
      { line: 3, column: undefined, content: '', gapBefore: false },
      { line: 10, column: 1, content: 'TODO: verify', gapBefore: true },
    ],
  });
  assert.equal(result?.files[1].lines[0].gapBefore, false);
});

test('grep parses singular summaries and preserves colons in paths and source content', () => {
  const result = parseGrepOutput(
    '1 match across 1 file\n---\nC:/folder/name:part.ts:12:2: file:42:5: literal text',
  );
  assert.equal(result?.files[0].path, 'C:/folder/name:part.ts');
  assert.equal(result?.files[0].lines[0].content, 'file:42:5: literal text');
});

test('grep keeps partial-output notices and incomplete rows visible', () => {
  const result = parseGrepOutput(
    '1000 matches across 42 files (truncated at 1000) (2 paths skipped: read error)\n---\na.ts:2:1: TODO\npartial output\n[output truncated]',
  );
  assert.equal(result?.matchCount, 1000);
  assert.equal(
    result?.note,
    '(truncated at 1000) (2 paths skipped: read error)',
  );
  assert.equal(result?.unparsed, 'partial output\n[output truncated]');
  assert.equal(result?.files.length, 1);
});

test('grep accepts CRLF output without losing source indentation', () => {
  const result = parseGrepOutput(
    '1 match across 1 file\r\n---\r\na.ts:1:3:   TODO\r\n',
  );
  assert.equal(result?.files[0].lines[0].content, '  TODO');
  assert.equal(result?.unparsed, '');
});

test('grep distinguishes an empty search from a missing target and leaves unknown formats untouched', () => {
  assert.deepEqual(parseGrepOutput('0 matches across 0 files\n---'), {
    matchCount: 0,
    fileCount: 0,
    note: '',
    files: [],
    unparsed: '',
  });
  assert.equal(
    parseGrepOutput(
      '0 matches across 0 files (target path not found: nothing searched)\n---',
    )?.note,
    '(target path not found: nothing searched)',
  );
  for (const value of [
    undefined,
    null,
    false,
    {},
    'Error: Invalid regex pattern',
    'a.ts:1:1: TODO',
    '1 match across 1 file',
  ])
    assert.equal(parseGrepOutput(value), null);
});
