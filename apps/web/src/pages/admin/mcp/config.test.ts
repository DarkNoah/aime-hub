import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpConfigSchema } from '@aime/shared/mcp';
import {
  formToInput,
  inputToForm,
  parseKeyValues,
  parseMcpJson,
  serializeMcpJson,
} from './config';

test('form removes blank arguments and preserves argument boundaries, equals signs and empty env values', () => {
  const form = {
    ...inputToForm(),
    name: ' chrome_devtools ',
    command: ' npx ',
    args: '-y\r\n \r\nchrome-devtools-mcp@latest\n--proxy-server=http://127.0.0.1:10809\n--label=hello world\n',
    env: 'API_KEY=a=b==\nEMPTY=\nSPACE=  value  \n\n',
  };
  assert.deepEqual(formToInput(form), {
    name: 'chrome_devtools',
    config: {
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@latest',
        '--proxy-server=http://127.0.0.1:10809',
        '--label=hello world',
      ],
      env: { API_KEY: 'a=b==', EMPTY: '', SPACE: '  value  ' },
    },
  });
});

test('multiple JSON servers round trip through forms without losing credentials', () => {
  const inputs = [
    {
      name: 'local',
      config: { command: 'node', args: ['tool.js'], env: { KEY: 'a=b==' } },
    },
    {
      name: 'remote',
      config: {
        url: 'https://example.com/sse',
        headers: { Authorization: 'Bearer x=y==' },
      },
    },
  ];
  assert.deepEqual(
    parseMcpJson(serializeMcpJson(inputs)).map(inputToForm).map(formToInput),
    inputs,
  );
  assert.throws(() => parseMcpJson(serializeMcpJson(inputs), true), {
    code: 'mcp.singleServer',
  });
});

test('transport changes omit inactive fields and validate mutually exclusive configuration', () => {
  const form = {
    ...inputToForm(),
    name: 'remote',
    command: 'npx',
    args: '-y',
    env: 'BROKEN',
    transport: 'http' as const,
    url: 'http://localhost:3000/mcp',
    headers: 'Authorization=Bearer token',
  };
  assert.deepEqual(mcpConfigSchema.parse(formToInput(form).config), {
    url: form.url,
    headers: { Authorization: 'Bearer token' },
  });
  for (const config of [
    {},
    { command: 'npx', url: 'https://example.com' },
    { command: 'npx', headers: {} },
    { url: 'https://example.com', env: {} },
    { url: 'https://example.com', args: [] },
    { url: 'file:///tmp/mcp' },
    { url: 'bad-url' },
    { command: 'npx', type: 'stdio' },
    { command: 'npx', args: 'arg' },
    { command: 'npx', env: { 'BAD-KEY': 'x' } },
    {
      url: 'https://example.com',
      headers: { Authorization: 'a', authorization: 'b' },
    },
    {
      url: 'https://example.com',
      headers: { Authorization: 'a\nInjected: 1' },
    },
  ])
    assert.equal(
      mcpConfigSchema.safeParse(config).success,
      false,
      JSON.stringify(config),
    );
});

test('invalid JSON, unknown fields, empty imports, invalid key-value lines and duplicate names are rejected', () => {
  for (const json of [
    '{',
    '{}',
    '{"mcpServers":{}}',
    '{"mcpServers":{"name":{"command":"npx","unknown":1}}}',
    '{"mcpServers":{"__proto__":{"command":"npx"}}}',
  ])
    assert.throws(() => parseMcpJson(json));
  assert.throws(() => parseKeyValues('MISSING', 'env'), {
    code: 'mcp.keyValueInvalid',
    line: 1,
  });
  assert.throws(() => parseKeyValues('A=1\nA=2', 'env'), {
    code: 'mcp.duplicateKey',
    line: 2,
  });
  assert.throws(
    () => parseKeyValues('Authorization=a\nauthorization=b', 'headers'),
    { code: 'mcp.duplicateKey' },
  );
  assert.throws(
    () =>
      serializeMcpJson([
        { name: 'same', config: { command: 'node' } },
        { name: 'same', config: { command: 'npx' } },
      ]),
    { code: 'mcp.duplicateName' },
  );
});
