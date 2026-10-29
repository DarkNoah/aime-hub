import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  FACTOR_GROUPS,
  UNGROUPED,
  groupDescendants,
} from '../factor-groups.js';
import {
  builtinDetail,
  builtinSummaries,
  builtinVersion,
} from '../server/factors/builtins.js';
import { factorFixture } from './factor-fixture.js';
import { FactorStore } from '../server/factors/store.js';
import { factorSchema } from '../server/factors/schema.js';

test('all four built-in libraries have stable published snapshots and explicit data requirements', () => {
  const rows = builtinSummaries();
  assert.equal(rows.length, 810);
  assert.equal(new Set(rows.map((r) => r.id)).size, 810);
  for (const [family, count] of Object.entries({
    worldquant101: 101,
    gtja191: 191,
    qlib158: 158,
    qlib360: 360,
  })) {
    assert.equal(
      rows.filter((r) => r.builtin?.family === family).length,
      count,
    );
  }
  for (const row of rows) {
    const detail = builtinDetail(row.id)!;
    assert.ok(FACTOR_GROUPS.some((g) => g.id === row.group_id));
    assert.equal(detail.versions.length, 1);
    assert.equal(builtinVersion(detail.versions[0].id)?.source, detail.source);
    assert.ok(detail.builtin!.lookback > 0 && detail.builtin!.lookback <= 500);
    assert.equal(
      factorSchema.safeParse({
        ...detail,
        name: `${detail.name} copy`,
        description: '',
      }).success,
      true,
    );
  }
  const wq = rows.find(
    (r) => r.builtin?.family === 'worldquant101' && r.name === 'ALPHA007',
  )!;
  assert.ok(wq.builtin?.fields.includes('amount'));
});

test('group descendants handle nested branches without leaking sibling groups', () => {
  const groups = [
    { id: 'a', name: 'a', parent_id: null, builtin: false },
    { id: 'b', name: 'b', parent_id: 'a', builtin: false },
    { id: 'c', name: 'c', parent_id: 'b', builtin: false },
    { id: 'd', name: 'd', parent_id: null, builtin: false },
  ];
  assert.deepEqual([...groupDescendants(groups, 'a')], ['a', 'b', 'c']);
});

test(
  'real ClickHouse group CRUD, fixed-group protection, concurrency, migration and built-in analysis',
  {
    skip: process.env.QUANT_FACTOR_INTEGRATION !== '1',
    timeout: 60_000,
  },
  async () => {
    const f = await factorFixture();
    const request = async (
      method: string,
      path: string,
      body: unknown,
      admin = true,
    ) =>
      f.app.request(`/factors${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-admin': String(admin),
        },
        body: JSON.stringify(body),
      });
    try {
      assert.deepEqual(await f.records.groups(), {
        groups: FACTOR_GROUPS,
        revision: 0,
      });
      await f.records.initialize();
      const count = await f.records.rows<{ count: number }>(
        `SELECT count() AS count FROM ${f.records.table('quant_factor_versions')} FINAL`,
      );
      assert.equal(Number(count[0].count), 810);
      for (const group of FACTOR_GROUPS) {
        assert.equal(
          (await request('DELETE', `/groups/${group.id}`, { revision: 0 }))
            .status,
          403,
        );
        assert.equal(
          (
            await request('PUT', `/groups/${group.id}`, {
              revision: 0,
              name: 'changed',
              parent_id: null,
            })
          ).status,
          403,
        );
      }
      assert.equal(
        (await request('POST', '/groups', { revision: 0, name: 'test' }, false))
          .status,
        403,
      );
      const first = await request('POST', '/groups', {
        revision: 0,
        name: '趋势',
      });
      assert.equal(first.status, 201, await first.clone().text());
      let tree = await first.json();
      const parent = tree.groups.find((g: { builtin: boolean }) => !g.builtin);
      assert.equal(
        (
          await request('POST', '/groups', {
            revision: tree.revision,
            name: '趋势',
          })
        ).status,
        409,
      );
      tree = await f.records.saveGroup('test', {
        revision: tree.revision,
        name: '子组',
        parent_id: parent.id,
      });
      const child = tree.groups.find(
        (g: { parent_id: string }) => g.parent_id === parent.id,
      )!;
      await assert.rejects(
        f.records.saveGroup(
          'test',
          { revision: tree.revision, name: '趋势', parent_id: child.id },
          parent.id,
        ),
        /自身或子组/,
      );
      const concurrent = await Promise.allSettled(
        [0, 1, 2].map((i) =>
          new FactorStore(f.config).saveGroup(
            'test',
            { revision: tree.revision, name: `改名 ${i}`, parent_id: null },
            parent.id,
          ),
        ),
      );
      assert.equal(
        concurrent.filter((r) => r.status === 'fulfilled').length,
        1,
      );
      tree = await f.records.groups();
      const builtin = builtinDetail(
        builtinSummaries().find(
          (r) => r.builtin?.family === 'gtja191' && r.name === 'ALPHA014',
        )!.id,
      )!;
      const copy = await f.records.save('test', {
        name: '自定义因子',
        description: '',
        source: builtin.source,
        parameters: {},
        enabled: true,
        group_id: child.id,
      });
      assert.equal(
        (await new FactorStore(f.config).detail(copy.id)).group_id,
        child.id,
      );
      const old = await f.records.save('test', {
        name: '旧因子',
        description: '',
        source: builtin.source,
        parameters: {},
        enabled: true,
      });
      assert.equal(old.group_id, UNGROUPED);
      await assert.rejects(
        f.records.save(
          'test',
          { ...copy, group_id: randomUUID() },
          copy.id,
          copy.revision,
        ),
        /分组不存在/,
      );
      await assert.rejects(
        f.records.save('test', builtin, builtin.id, 1),
        /只读/,
      );
      tree = await f.records.deleteGroup('test', parent.id, tree.revision);
      assert.equal(tree.groups.length, 5);
      assert.equal((await f.records.detail(copy.id)).group_id, UNGROUPED);
      assert.equal(
        (await f.records.list()).find((r) => r.id === copy.id)!.group_id,
        UNGROUPED,
      );
      assert.equal((await f.records.detail(copy.id)).source, builtin.source);
      assert.equal(
        (
          await request('PUT', `/groups/${randomUUID()}`, {
            revision: tree.revision,
            name: 'missing',
          })
        ).status,
        404,
      );
      const result = await f.service.analyze(
        'test',
        builtin.id,
        {
          version_id: builtin.versions[0].id,
          symbols: f.instruments.map((i) => i.symbol),
          start: '2026-01-05',
          end: '2026-01-30',
          holding_days: 2,
          groups: 3,
          direction: 1,
        },
        new AbortController().signal,
      );
      assert.equal(result.status, 'completed', result.message);
      assert.ok(result.report!.metrics.rank_ic_mean! > 0.99);
      assert.equal(
        (await new FactorStore(f.config).analysis(result.id)).source_hash,
        builtin.versions[0].source_hash,
      );
    } finally {
      await f.close();
    }
  },
);
