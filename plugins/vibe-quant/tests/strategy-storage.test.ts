import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { strategyFixture, input } from './strategy-fixture.js';
import { StrategyStore } from '../server/strategies/store.js';
import { StrategySources, sha256 } from '../server/strategies/sources.js';
import { migrateStrategies } from '../server/strategies/migrate.js';

const enabled = process.env.QUANT_STRATEGY_INTEGRATION === '1';
const body = (source = "from quant_sdk import Strategy\n# 中文 ' \\\n") => ({
  name: 'storage test',
  description: '',
  enabled: true,
  draft: { source, parameters: {} },
});

test(
  'ClickHouse serializes concurrent edits, publishes, queue capacity and claims across clients',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const f = await strategyFixture();
    const peer = `strategy_peer_${randomUUID().replaceAll('-', '')}`;
    try {
      await f.records.request(`CREATE USER ${peer} IDENTIFIED BY 'local-test'`);
      await f.records.request(
        `GRANT SELECT, INSERT ON ${f.config.clickhouseDatabase}.* TO ${peer}`,
      );
      await f.records.request(`GRANT CREATE TEMPORARY TABLE ON *.* TO ${peer}`);
      const second = new StrategyStore({
        ...f.config,
        clickhouseUser: peer,
        clickhousePassword: 'local-test',
      });
      const stores = Array.from({ length: 8 }, (_, i) =>
        i % 2 ? f.records : second,
      );
      const created = await f.records.save('alice', body());
      const saves = await Promise.allSettled(
        stores.map((store, i) =>
          store.save(
            'alice',
            body(`# edit ${i}\n`),
            created.id,
            created.revision,
          ),
        ),
      );
      assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
      for (const result of saves)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'STRATEGY_CONFLICT');
      const changed = await f.records.detail('alice', created.id);
      const publishes = await Promise.allSettled(
        stores.map((store) =>
          store.publish('alice', changed.id, changed.revision, 'concurrent'),
        ),
      );
      assert.equal(publishes.filter((r) => r.status === 'fulfilled').length, 1);
      const [version] = await second.versions('alice', changed.id);
      assert.equal(version.number, 1);
      assert.equal((await second.detail('alice', changed.id)).version_count, 1);
      await assert.rejects(second.detail('bob', changed.id), {
        code: 'STRATEGY_NOT_FOUND',
      });
      await assert.rejects(second.version('bob', version.id), {
        code: 'VERSION_NOT_FOUND',
      });
      const other = await f.records.save('alice', body('# second strategy'));
      const otherVersion = await f.records.publish(
        'alice',
        other.id,
        other.revision,
        '',
      );
      const queued = await Promise.allSettled(
        stores.map((store, i) =>
          store.enqueue(
            'alice',
            i % 2 ? other.id : changed.id,
            input(i % 2 ? otherVersion.version.id : version.id),
            'tqsdk',
          ),
        ),
      );
      assert.equal(queued.filter((r) => r.status === 'fulfilled').length, 3);
      for (const result of queued)
        if (result.status === 'rejected')
          assert.equal(result.reason.code, 'RUN_QUEUE_FULL');
      assert.equal(
        await new StrategyStore({ ...f.config, engine: 'tdx' }).claim(
          randomUUID(),
        ),
        undefined,
      );
      const claims = (
        await Promise.all(stores.map((store) => store.claim(randomUUID())))
      ).filter((r) => !!r);
      assert.equal(claims.length, 3);
      assert.equal(new Set(claims.map((r) => r.id)).size, 3);
      const run = claims[0];
      assert.equal(await second.heartbeat(run.id, 'wrong-worker'), false);
      await second.cancel('alice', run.id);
      assert.equal(await second.heartbeat(run.id, run.worker_id!), false);
      await f.records.status(run.id, run.worker_id!, 'completed');
      assert.equal((await second.run('alice', run.id)).status, 'cancelled');
      await f.records.putArtifact(run.id, 'result', '{"value":"中文"}');
      await second.putArtifact(run.id, 'result', '{"value":"中文"}');
      await assert.rejects(
        second.putArtifact(run.id, 'result', '{"value":2}'),
        /冲突/,
      );
      assert.equal(
        (await second.artifact(run.id, 'result'))!.text,
        '{"value":"中文"}',
      );
      // Business operations must not create any PostgreSQL strategy data.
      for (const table of [
        'sources',
        'strategies',
        'versions',
        'runs',
        'run_artifacts',
      ]) {
        const [{ count }] = await f.db.query(
          `SELECT count(*)::int AS count FROM plugin_vibe_quant_${table}`,
        );
        assert.equal(count, 0);
      }
    } finally {
      await f.records.request(`DROP USER IF EXISTS ${peer}`);
      await f.close();
    }
  },
);

test(
  'legacy migration verifies scripts and artifacts, retries partial copies and preserves new ClickHouse state',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const f = await strategyFixture();
    try {
      const strategy = randomUUID(),
        version = randomUUID(),
        run = randomUUID();
      const source = body().draft.source,
        hash = sha256(source),
        artifact = '{"metrics":{"total_return":0.2}}';
      await f.db.query(
        'INSERT INTO plugin_vibe_quant_sources (hash,source) VALUES ($1,$2)',
        [hash, source],
      );
      await f.db.query(
        `INSERT INTO plugin_vibe_quant_strategies
        (id,user_id,name,description,draft_hash,draft_entrypoint,draft_parameters,revision,version_count)
        VALUES ($1,'alice','legacy','',$2,'Strategy','{}',3,1)`,
        [strategy, hash],
      );
      await f.db.query(
        `INSERT INTO plugin_vibe_quant_versions
        (id,strategy_id,number,source_hash,entrypoint,parameters,note) VALUES ($1,$2,1,$3,'Strategy','{}','legacy')`,
        [version, strategy, hash],
      );
      await f.db.query(
        `INSERT INTO plugin_vibe_quant_runs (id,strategy_id,version_id,engine,status,config,heartbeat_at)
        VALUES ($1,$2,$3,'tqsdk','running',$4,now())`,
        [run, strategy, version, input(version)],
      );
      await f.db.query(
        `INSERT INTO plugin_vibe_quant_run_artifacts (run_id,kind,hash,data) VALUES ($1,'result',$2,$3)`,
        [run, sha256(artifact), gzipSync('corrupt')],
      );
      await assert.rejects(migrateStrategies(f.db, f.records), /哈希校验/);
      assert.equal(
        (
          await f.records.rows(
            `SELECT * FROM ${f.records.table('quant_strategy_migrations')}`,
          )
        ).length,
        0,
      );
      await f.db.query(
        'UPDATE plugin_vibe_quant_run_artifacts SET data=$1 WHERE run_id=$2',
        [gzipSync(artifact), run],
      );
      await migrateStrategies(f.db, f.records);
      const detail = await f.records.detail('alice', strategy);
      assert.equal(detail.revision, 3);
      assert.equal(detail.draft.source, source);
      assert.equal((await f.records.version('alice', version)).source, source);
      assert.equal((await f.records.run('alice', run)).status, 'failed');
      assert.equal((await f.records.artifact(run, 'result'))!.text, artifact);
      const updated = await f.records.save(
        'alice',
        body('# newer\n'),
        strategy,
        detail.revision,
      );
      await f.records.publish('alice', strategy, updated.revision, 'new');
      await migrateStrategies(f.db, f.records);
      // Also simulate loss of the completion marker after successful writes.
      await f.records.request(
        `TRUNCATE TABLE ${f.records.table('quant_strategy_migrations')}`,
      );
      await migrateStrategies(f.db, f.records);
      assert.equal(
        (await f.records.detail('alice', strategy)).draft.source,
        '# newer\n',
      );
      assert.equal((await f.records.versions('alice', strategy)).length, 2);
      const [legacy] = await f.db.query(
        'SELECT revision FROM plugin_vibe_quant_strategies WHERE id=$1',
        [strategy],
      );
      assert.equal(legacy.revision, 3);
      // Verify normal runtime reads/writes work even after all legacy tables are unavailable.
      await f.db.query(
        'DROP TABLE plugin_vibe_quant_run_artifacts, plugin_vibe_quant_runs, plugin_vibe_quant_versions, plugin_vibe_quant_strategies, plugin_vibe_quant_sources',
      );
      const loaded = await f.records.detail('alice', strategy);
      await f.records.save(
        'alice',
        body('# no postgres\n'),
        strategy,
        loaded.revision,
      );
      assert.equal((await f.records.version('alice', version)).source, source);
      assert.equal((await f.records.artifact(run, 'result'))!.text, artifact);
    } finally {
      await f.close();
    }
  },
);

test(
  'failed script writes do not commit a draft; corrupt stored scripts cannot be published or executed',
  { skip: !enabled, timeout: 60000 },
  async (t) => {
    const f = await strategyFixture();
    try {
      const created = await f.records.save('alice', body());
      const failed = t.mock.method(
        StrategySources.prototype,
        'put',
        async () => {
          throw new Error('storage unavailable');
        },
      );
      await assert.rejects(
        f.records.save('alice', body('# fail'), created.id, created.revision),
        /unavailable/,
      );
      failed.mock.restore();
      assert.equal(
        (await f.records.detail('alice', created.id)).revision,
        created.revision,
      );
      const hash = sha256(created.draft.source);
      await f.records.sources.request(
        `INSERT INTO ${f.records.table('quant_strategy_sources')} (hash, source) FORMAT JSONEachRow`,
        {},
        JSON.stringify({ hash, source: 'corrupt' }),
      );
      await assert.rejects(f.records.detail('alice', created.id), /哈希校验/);
      await assert.rejects(
        f.records.publish('alice', created.id, created.revision, ''),
        /哈希校验/,
      );
    } finally {
      await f.close();
    }
  },
);
