import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../server/config.js';
import { searchTerms, supports } from '../server/symbols.js';
import { MarketStore } from '../server/clickhouse.js';
import type { Instrument } from '../shared.js';

const config = {
  engine: 'tdx',
  clickhouseUrl: 'http://127.0.0.1:8123',
  clickhouseDatabase: 'vibe_quant',
  clickhouseUser: 'test',
  clickhousePassword: 'test',
  tdxServers: '127.0.0.1:7709',
  beforeOpenMinutes: 5,
  afterCloseMinutes: 10,
  flushSeconds: 2,
  pollSeconds: 5,
  historyBars: 1000,
  maxSubscriptions: 100,
};
test('engine validation is conditional and SQL identifiers are constrained', () => {
  assert.equal(parseConfig(config).engine, 'tdx');
  assert.equal(
    parseConfig({ ...config, tdxServers: '192.0.2.1:7709\n192.0.2.2:80' })
      .engine,
    'tdx',
  );
  for (const tdxServers of [
    '',
    'bad:7709',
    '256.1.1.1:80',
    '192.0.2.1:65536',
    '192.0.2.1:0',
    '192.0.2.1:7709\n'.repeat(33),
  ])
    assert.throws(() => parseConfig({ ...config, tdxServers }));
  assert.throws(
    () => parseConfig({ ...config, engine: 'tqsdk' }),
    /参数未填写完整/,
  );
  assert.throws(() =>
    parseConfig({ ...config, clickhouseDatabase: 'x`; DROP TABLE bars' }),
  );
  assert.throws(() =>
    parseConfig({ ...config, clickhouseUrl: 'http://user:secret@localhost' }),
  );
});
test('search recognizes continuous aliases and option prefixes without guessing exchanges', () => {
  assert.deepEqual(searchTerms('IM主连'), { term: 'IM', continuous: true });
  assert.deepEqual(searchTerms('MOxxx'), { term: 'MO', continuous: false });
  assert.deepEqual(searchTerms('000852'), {
    term: '000852',
    continuous: false,
  });
  assert.equal(searchTerms('a%b_').term, 'a\\%b\\_');
});
test('engine capabilities reject unsupported markets and expired contracts', () => {
  const item: Instrument = {
    symbol: 'CFFEX.IM2610',
    kind: 'future',
    name: 'IM2610',
    product: 'IM',
    priceTick: 0.2,
    exchange: 'CFFEX',
    underlying: '',
    expired: false,
  };
  assert.equal(supports('tqsdk', item), true);
  assert.equal(supports('tdx', item), false);
  assert.equal(supports('tqsdk', { ...item, expired: true }), false);
});
test('ClickHouse parameterizes all values, scopes engine, reverses bars and redacts failures', async () => {
  const original = globalThis.fetch;
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ data: [{ time: 2 }, { time: 1 }] }));
  };
  try {
    const store = new MarketStore(parseConfig(config));
    const bars = await store.bars('tdx', 'SSE.000852', 60);
    assert.deepEqual(
      bars.map((bar) => bar.time),
      [1, 2],
    );
    assert.equal(calls[0].url.searchParams.get('param_engine'), 'tdx');
    assert.equal(calls[0].url.searchParams.get('param_symbol'), 'SSE.000852');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.ok(!calls[0].url.toString().includes('secret'));
    globalThis.fetch = async () =>
      new Response('password=secret; SQL detail', { status: 403 });
    await assert.rejects(
      () => store.quotes('tqsdk', ['SSE.000852']),
      /^Error: CLICKHOUSE_HTTP_403$/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
