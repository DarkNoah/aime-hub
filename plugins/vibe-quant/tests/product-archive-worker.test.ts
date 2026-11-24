import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ProductSyncTarget } from '../product-sync-types.js';
import type { QuantConfig } from '../server/config.js';
import { ProductArchiveWorker } from '../server/product-sync/worker.js';

async function fixture(t: TestContext, script: string, historyBars = 1000) {
  const cwd = await mkdtemp(join(tmpdir(), 'product-archive-'));
  const path = join(cwd, 'provider.py');
  await writeFile(path, script);
  const events = new EventEmitter();
  const config = { engine: 'tqsdk', historyBars } as QuantConfig;
  const targets: ProductSyncTarget[] = ['A', 'B'].map((symbol) => ({
    symbol,
    latest: {},
  }));
  const worker = new ProductArchiveWorker(
    config,
    path,
    {
      write: async (engine, quotes, bars, books, owner) => {
        assert.equal(engine, 'tqsdk');
        assert.equal(owner, 'writer');
        assert.equal(quotes.length + (books?.length ?? 0), 0);
        events.emit('write', bars);
      },
    },
    {
      due: async (_engine, limit) => {
        events.emit('limit', limit);
        return targets;
      },
      record: async (_engine, owner, results) => {
        assert.equal(owner, 'writer');
        events.emit('record', results);
      },
    },
    'writer',
  );
  t.after(async () => {
    await worker.stop();
    await rm(cwd, { recursive: true, force: true });
  });
  return { worker, events };
}

test(
  'archive checkpoints only completed contracts after their fenced market writes',
  { timeout: 7000 },
  async (t) => {
    const { worker, events } = await fixture(
      t,
      `
import json, sys
request = json.loads(sys.stdin.readline())
assert len(request['targets']) == 2
assert 'clickhousePassword' not in request
print(json.dumps({'type':'bars','bars':[{'symbol':'A','duration':60,'time':60}]}))
print(json.dumps({'type':'result','result':{'symbol':'A','outcome':'ready','latest':{'60':60},'firstBarAt':60,'lastBarAt':60}}))
sys.exit(1)
`,
    );
    const written = once(events, 'write');
    const recorded = once(events, 'record');
    const batchLimit = once(events, 'limit');
    worker.start('python3');
    assert.equal((await batchLimit)[0], 12);
    assert.equal((await written)[0][0].symbol, 'A');
    const [results] = await recorded;
    assert.deepEqual(
      results.map((result: { outcome: string }) => result.outcome),
      ['ready', 'error'],
    );
    assert.deepEqual(results[1].latest, {});
  },
);

test(
  'stopping the writer terminates its archive process and does not advance progress',
  { timeout: 7000 },
  async (t) => {
    const { worker, events } = await fixture(
      t,
      `
import sys, time
sys.stdin.readline()
print('{"type":"bars","bars":[{"symbol":"A","duration":60,"time":60}]}', flush=True)
time.sleep(120)
`,
      8000,
    );
    let checkpoints = 0;
    events.on('record', () => {
      checkpoints++;
    });
    const written = once(events, 'write');
    const batchLimit = once(events, 'limit');
    worker.start('python3');
    assert.equal((await batchLimit)[0], 8);
    await written;
    await worker.stop();
    assert.equal(checkpoints, 0);
  },
);
