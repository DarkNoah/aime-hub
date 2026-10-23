import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext } from '@app/plugin-sdk/server';
import type { StateStore } from '../server/state-store.js';
import type { MarketStore } from '../server/clickhouse.js';
import { parseConfig } from '../server/config.js';
import { SyncWorker } from '../server/worker.js';
import type { OrderBook, Tick } from '../shared.js';

for (const { depthOnly, readOnly, tickOnly } of [
  { depthOnly: false, readOnly: false, tickOnly: false },
  { depthOnly: true, readOnly: false, tickOnly: false },
  { depthOnly: false, readOnly: true, tickOnly: false },
  { depthOnly: false, readOnly: false, tickOnly: true },
])
  test(
    `managed process retries ${tickOnly ? 'tick-only' : depthOnly ? 'depth-only' : 'bar and depth'} batches in ${readOnly ? 'read-only' : 'writer'} mode`,
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
emit({type:'data',quotes:[],bars:${depthOnly || tickOnly ? '[]' : "[{symbol:'SSE.000852',time:100,duration:60,open:1,high:2,low:1,close:2,volume:10}]"},orderBooks:${tickOnly ? '[]' : "[{snapshotId:'fixed-retry-id',symbol:'SSE.600000',receivedAt:100,sourceTime:null,timePrecision:'unknown',bidPrices:[10],bidVolumes:[25],askPrices:[11],askVolumes:[20],volumeUnit:'source',underlying:''}]"},ticks:${tickOnly ? "[{symbol:'CFFEX.IM2611',tickId:'42',timeNs:'1792373400000000123',tradingDay:'2026-10-19',volume:50}]" : '[]'}});
emit({type:'status',state:'syncing',message:'fixture',active:1});
setInterval(()=>emit({type:'status',state:'syncing',message:'fixture',active:1}),200);
});
`,
        { mode: 0o700 },
      );
      let writes = 0;
      let attempts = 0;
      let unlocked = 0;
      let locks = 0;
      let checks = 0;
      let liveBatches = 0;
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
          query: async () => {
            throw new Error('Runtime state must not use PostgreSQL');
          },
        },
      } as unknown as PluginContext;
      const state = {
        acquireLease: async () => {
          locks++;
          return true;
        },
        releaseLease: async () => {
          unlocked++;
        },
        saveCatalog: async () => {},
        completeCatalog: async () => {},
        subscriptions: async () => ['SSE.000852'],
        catalogCount: async () => 1,
        saveStatus: async (_id: string, status: object) => {
          statuses.push({ ...status });
        },
      } as unknown as StateStore;
      const store = {
        retainSymbols: () => {},
        write: async (
          _engine: string,
          _quotes: unknown[],
          bars: unknown[],
          books: OrderBook[],
          _ownerId: string,
          ticks: Tick[],
        ) => {
          if (!books.length && !ticks.length) return;
          assert.ok(
            liveBatches > 0,
            'SDK feed receives data before durable storage succeeds',
          );
          assert.equal(bars.length, depthOnly || tickOnly ? 0 : 1);
          attempts++;
          snapshotIds.push(
            tickOnly
              ? ticks[0].timeNs + ':' + ticks[0].tickId
              : books[0].snapshotId,
          );
          if (attempts === 1) throw new Error('simulated storage outage');
          writes += books.length + ticks.length;
        },
        validateTickVolumes: async (
          _engine: string,
          symbol: string,
          tradingDay: string,
        ) => {
          checks++;
          return { symbol, tradingDay, state: 'partial', rows: 1 };
        },
      } as unknown as MarketStore;
      const config = parseConfig({
        engine: tickOnly ? 'tqsdk' : 'tdx',
        tqUser: 'fixture',
        tqPassword: 'fixture',
        clickhouseUrl: 'http://localhost:8123',
        clickhouseDatabase: 'test',
        clickhouseUser: 'test',
        clickhousePassword: 'test',
        clickhouseReadOnly: readOnly,
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
        state,
        async () => executable,
        () => {
          liveBatches++;
        },
      );
      try {
        worker.start();
        for (let i = 0; i < 60 && !writes; i++) await delay(100);
        assert.ok(writes > 0, 'batch survives failed storage write');
        assert.ok(attempts >= 2);
        assert.ok(
          liveBatches >= 1,
          'collector restarts may republish source data',
        );
        if (tickOnly) {
          assert.equal(
            checks,
            1,
            'periodic validation runs after a committed tick-only batch',
          );
          assert.equal(worker.getStatus().tickValidation?.[0].state, 'partial');
        }
        assert.equal(
          snapshotIds[0],
          snapshotIds[1],
          'retry retains snapshot identity',
        );
        if (readOnly) {
          assert.equal(worker.getStatus().clickhouseReadOnly, true);
          assert.ok(worker.getStatus().lastReceivedAt);
          assert.equal(worker.getStatus().lastWriteAt, null);
          assert.ok(
            statuses.length > 0,
            'market-only mode still persists its own heartbeat',
          );
        } else {
          assert.ok(
            statuses.some((status) => status.lastWriteAt),
            'depth-only writes update heartbeat',
          );
        }
      } finally {
        await worker.stop();
        await rm(dir, { recursive: true, force: true });
      }
      if (readOnly) {
        assert.equal(
          locks,
          0,
          'each read-only process collects its own live data',
        );
        assert.equal(unlocked, 0);
      } else {
        assert.ok(locks > 0);
        assert.ok(unlocked > 0);
      }
    },
  );
