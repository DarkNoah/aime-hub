import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { SyncWorker } from '../server/worker.js';
import type { OrderBook } from '../shared.js';

for (const depthOnly of [false, true])
  test(
    `managed process retries ${depthOnly ? 'depth-only' : 'bar and depth'} batches and releases its producer lock on stop`,
    { timeout: 15000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'quant-worker-'));
      const executable = join(dir, 'fixture-python');
      await writeFile(
        executable,
        `#!/usr/bin/env node
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
emit({type:'catalog',instruments:[{symbol:'SSE.000852',name:'fixture',kind:'stock'}]});
emit({type:'catalog_complete'});
emit({type:'data',quotes:[],bars:${depthOnly ? '[]' : "[{symbol:'SSE.000852',time:100,duration:60,open:1,high:2,low:1,close:2,volume:10}]"},orderBooks:[{snapshotId:'fixed-retry-id',symbol:'SSE.600000',receivedAt:100,sourceTime:null,timePrecision:'unknown',bidPrices:[10],bidVolumes:[25],askPrices:[11],askVolumes:[20],volumeUnit:'source',underlying:''}]});
emit({type:'status',state:'syncing',message:'fixture',active:1});
setInterval(()=>emit({type:'status',state:'syncing',message:'fixture',active:1}),200);
});
`,
        { mode: 0o700 },
      );
      let writes = 0;
      let attempts = 0;
      let releases = 0;
      let unlocked = 0;
      const snapshotIds: string[] = [];
      const statuses: { lastWriteAt?: string }[] = [];
      const context = {
        id: 'vibe-quant',
        runtime: {
          paths: {
            pluginRoot: join(process.cwd(), '../..', 'plugins/vibe-quant'),
          },
        },
        assertEnabled: async () => {},
        database: {
          createQueryRunner: () => ({
            connect: async () => {},
            release: async () => {
              releases++;
            },
            query: async (sql: string) => {
              if (sql.includes('pg_try_advisory_lock'))
                return [{ locked: true }];
              if (sql.includes('pg_advisory_unlock')) unlocked++;
              return [];
            },
          }),
          query: async (sql: string, params: unknown[]) => {
            if (sql.includes('INSERT INTO plugin_vibe_quant_status'))
              statuses.push(JSON.parse(params[0] as string));
            return sql.includes('SELECT DISTINCT w.symbol')
              ? [{ symbol: 'SSE.000852' }]
              : sql.includes('SELECT count')
                ? [{ count: 1 }]
                : [];
          },
        },
      } as unknown as PluginContext;
      const store = {
        write: async (
          _engine: string,
          _quotes: unknown[],
          bars: unknown[],
          books: OrderBook[],
        ) => {
          if (!books.length) return;
          assert.equal(bars.length, depthOnly ? 0 : 1);
          attempts++;
          snapshotIds.push(books[0].snapshotId);
          if (attempts === 1) throw new Error('simulated storage outage');
          writes += books.length;
        },
      } as unknown as MarketStore;
      const config = parseConfig({
        engine: 'tdx',
        clickhouseUrl: 'http://localhost:8123',
        clickhouseDatabase: 'test',
        clickhouseUser: 'test',
        clickhousePassword: 'test',
        tdxServers: '192.0.2.1:7709',
        beforeOpenMinutes: 5,
        afterCloseMinutes: 10,
        flushSeconds: 1,
        pollSeconds: 5,
        historyBars: 100,
        maxSubscriptions: 10,
      });
      const worker = new SyncWorker(
        context,
        config,
        store,
        async () => executable,
      );
      try {
        worker.start();
        for (let i = 0; i < 60 && !writes; i++) await delay(100);
        assert.ok(writes > 0, 'batch survives failed storage write');
        assert.ok(attempts >= 2);
        assert.equal(
          snapshotIds[0],
          snapshotIds[1],
          'retry retains snapshot identity',
        );
        assert.ok(
          statuses.some((status) => status.lastWriteAt),
          'depth-only writes update heartbeat',
        );
      } finally {
        await worker.stop();
        await rm(dir, { recursive: true, force: true });
      }
      assert.ok(releases > 0);
      assert.ok(unlocked > 0);
    },
  );
