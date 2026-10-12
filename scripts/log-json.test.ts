import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stringifyLogJson,
  truncateBase64,
  truncateJsonBody,
} from '@aime/shared/log-json';
import { RequestLogService } from '../apps/server/src/modules/request-logs/service.js';

const payload = Buffer.from('Binary image content '.repeat(40)).toString(
  'base64',
);
const short = `${payload.slice(0, 30)}…`;

test('deeply shortens media in arrays, objects and JSON-encoded tool results without mutation', () => {
  const original = [
    {
      parts: [
        { type: 'file', url: `data:image/png;base64,${payload}` },
        { output: { nested: [{ b64_json: payload }, { arbitrary: payload }] } },
        { output: JSON.stringify({ nested: { data: payload } }) },
      ],
    },
  ];
  const before = JSON.stringify(original);
  const result = JSON.parse(stringifyLogJson(original, 2));
  assert.equal(result[0].parts[0].url, `data:image/png;base64,${short}`);
  assert.deepEqual(result[0].parts[1].output.nested, [
    { b64_json: short },
    { arbitrary: short },
  ]);
  assert.equal(JSON.parse(result[0].parts[2].output).nested.data, short);
  assert.equal(JSON.stringify(original), before);
});

test('handles boundaries, data URL prefixes and repeated truncation', () => {
  for (const length of [0, 29, 30, 31, 64]) {
    const data = 'A'.repeat(length);
    const expected = length > 30 ? `${data.slice(0, 30)}…` : data;
    assert.equal(truncateBase64(data), expected);
    const body = JSON.stringify({
      base64: data,
      url: `data:audio/wav;base64,${data}`,
    });
    const shortened = truncateJsonBody(body);
    assert.deepEqual(JSON.parse(shortened), {
      base64: expected,
      url: `data:audio/wav;base64,${expected}`,
    });
    assert.equal(truncateJsonBody(shortened), shortened);
  }
});

test('preserves ordinary text, URLs, identifiers, primitives and unchanged whitespace', () => {
  const original = {
    text: 'A long ordinary message with punctuation. '.repeat(50),
    url: `https://example.com/${'image'.repeat(60)}`,
    id: '12345678-abcd-efab-cdef-123456789012',
    model: 'a-model-with-a-somewhat-long-name',
    short: 'SGVsbG8=',
    enabled: true,
    count: 42,
    missing: null,
  };
  const body = JSON.stringify(original, null, 4);
  assert.equal(truncateJsonBody(body), body);
  assert.deepEqual(JSON.parse(stringifyLogJson(original)), original);
});

test('keeps incomplete JSON and non-JSON logs available', () => {
  for (const body of [
    '',
    '{"messages":[',
    'data: {"delta":"hello"}\n\n',
    'plain text',
  ]) {
    assert.equal(truncateJsonBody(body), body);
  }
});

test('supports URL-safe base64 and nested JSON with data URLs', () => {
  const safe = payload
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  const body = JSON.stringify({
    output: JSON.stringify({
      data: safe,
      url: `data:image/png;base64,${payload}`,
    }),
  });
  const parsed = JSON.parse(JSON.parse(truncateJsonBody(body)).output);
  assert.equal(parsed.data, `${safe.slice(0, 30)}…`);
  assert.equal(parsed.url, `data:image/png;base64,${short}`);
  assert.equal(
    JSON.parse(
      stringifyLogJson({ text: `[image](data:image/png;base64,${payload})` }),
    ).text,
    `[image](data:image/png;base64,${short})`,
  );
});

test('request persistence truncates only the log body while retaining original byte count and metadata', async () => {
  let saved: Record<string, unknown> | undefined;
  const database = {
    getRepository: () => ({
      insert: async (row: Record<string, unknown>) => {
        saved = row;
      },
    }),
  } as unknown as ConstructorParameters<typeof RequestLogService>[0];
  const body = JSON.stringify({
    model: 'test',
    stream: true,
    messages: [{ image: payload }],
  });
  const request = {
    id: 'log-1',
    createdAt: '2026-10-11T00:00:00.000Z',
    method: 'POST',
    url: 'https://example.com/v1/responses',
    complete: true,
    body,
    threadId: null,
    resourceId: null,
    userId: null,
    projectId: null,
  };
  const service = new RequestLogService(database);
  service.record(request);
  await service.settled();
  assert.ok(saved);
  assert.equal(saved.body, truncateJsonBody(body));
  assert.equal(saved.bodyBytes, Buffer.byteLength(body));
  assert.equal(saved.model, 'test');
  assert.equal(saved.stream, true);
  assert.equal(request.body, body);
});
