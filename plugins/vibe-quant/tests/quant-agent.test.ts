import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestContext } from '@mastra/core/request-context';
import { noopObserve } from '@mastra/core/tools';
import { PluginTool, type PluginContext } from '@app/plugin-sdk/server';
import { BaseTool } from '@app/plugin-sdk/tools';
import { agentInputSchema } from '@aime/shared/agents';
import { toolIdSchema } from '@aime/shared/tools';
import { createQuantMastra } from '../mastra/index.js';
import type { QuantDependencies } from '../mastra/tools/context.js';
import { StrategyError } from '../server/strategies/schema.js';
import { newsIndustries } from '../server/news/catalog.js';
import type { NewsArticle } from '../news-types.js';
import type {
  BacktestResult,
  BacktestRun,
  StrategyDetail,
  StrategyVersion,
} from '../strategy-types.js';
import { input, strategyFixture } from './strategy-fixture.js';
import createServer from '../server/index.js';

const strategyId = randomUUID();
const versionId = randomUUID();
const runId = randomUUID();
const article: NewsArticle = {
  id: 'a'.repeat(64),
  sourceId: 'b'.repeat(24),
  sourceName: '测试来源',
  industry: newsIndustries[0].key,
  url: 'https://example.com/news/1',
  title: '市场资讯',
  summary: '资讯摘要',
  content: '已保存正文',
  publishedAt: null,
  publishedRaw: '',
  discoveredAt: 123,
  sortAt: 123,
  contentStatus: 'ready',
  contentFetchedAt: 124,
  contentUrl: '',
  contentProvider: 'test',
  contentTruncated: false,
  contentError: '',
  attempts: 1,
  nextRetryAt: 0,
};
const original: StrategyDetail = {
  status: 'active',
  id: strategyId,
  name: '原始策略',
  description: '保留描述',
  enabled: false,
  revision: 3,
  version_count: 1,
  updated_at: new Date().toISOString(),
  draft: {
    source: 'original source',
    parameters: { fast: 2, slow: 5 },
  },
};
const version: StrategyVersion = {
  ...original.draft,
  id: versionId,
  strategy_id: strategyId,
  number: 1,
  source_hash: 'hash',
  note: '',
  created_at: original.updated_at,
};
const queued: BacktestRun = {
  id: runId,
  strategy_id: strategyId,
  version_id: versionId,
  version_number: 1,
  source_hash: 'hash',
  engine: 'tqsdk',
  status: 'queued',
  message: '',
  config: input(versionId),
  cancel_requested: false,
  created_at: original.updated_at,
  started_at: null,
  finished_at: null,
};

function fixture() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, ...args: unknown[]) =>
    calls.push({ name, args });
  const owner = (userId: string) => {
    if (userId !== 'alice') throw new StrategyError('STRATEGY_NOT_FOUND', 404);
  };
  const records: QuantDependencies['records'] = {
    async list(userId) {
      record('list', userId);
      return userId === 'alice' ? [original] : [];
    },
    async detail(userId, id) {
      record('detail', userId, id);
      owner(userId);
      return structuredClone(original);
    },
    async save(userId, value, id, revision) {
      record('save', userId, value, id, revision);
      return { ...original, ...value, revision: (revision ?? 0) + 1 };
    },
    async version(userId, id) {
      record('version', userId, id);
      owner(userId);
      return structuredClone(version);
    },
    async versions(userId, id) {
      record('versions', userId, id);
      owner(userId);
      return [version];
    },
    async publish(userId, id, revision, note) {
      record('publish', userId, id, revision, note);
      owner(userId);
      return { strategy: original, version };
    },
    async enqueue(userId, id, config, engine) {
      record('enqueue', userId, id, config, engine);
      return {
        ...queued,
        config,
        user_id: userId,
        worker_id: null,
        heartbeat_at: null,
      };
    },
    async runs(userId, id, before) {
      record('runs', userId, id, before);
      owner(userId);
      return [queued];
    },
    async run(userId, id) {
      record('run', userId, id);
      owner(userId);
      return queued;
    },
    async cancel(userId, id) {
      record('cancel', userId, id);
      owner(userId);
      return { ...queued, status: 'cancelled' };
    },
    async artifact(id, kind) {
      record('artifact', id, kind);
      return null;
    },
  };
  let role = 'user,admin';
  let banned = false;
  let enabled = true;
  const context = {
    id: 'vibe-quant',
    runtime: { paths: { pluginRoot: resolve('plugins/vibe-quant') } },
    database: {
      async query(_sql: string, params: unknown[]) {
        record('user', ...params);
        return [{ role, banned }];
      },
    },
    async assertEnabled() {
      if (!enabled) throw new Error('disabled');
    },
  } as unknown as PluginContext;
  const deps: QuantDependencies = {
    records,
    config: {
      engine: 'tqsdk',
      newsEnabled: false,
    } as QuantDependencies['config'],
    news: {
      async list(query) {
        record('news.list', query);
        const { content, publishedRaw, ...summary } = article;
        void content;
        void publishedRaw;
        return {
          items: [summary],
          nextCursor: Buffer.from(
            JSON.stringify({ time: 123, id: article.id }),
          ).toString('base64url'),
        };
      },
      async article(id) {
        record('news.article', id);
        return id === article.id ? { ...article } : null;
      },
    },
    state: {
      async search(engine, query, kind) {
        record('search', engine, query, kind);
        return [];
      },
      async instrument(engine, symbol) {
        record('instrument', engine, symbol);
        return {
          symbol,
          name: symbol,
          kind: symbol.startsWith('SSE.')
            ? 'stock'
            : symbol.startsWith('OPTION')
              ? 'option'
              : 'future',
          priceTick: 0.2,
          exchange: 'CFFEX',
          product: 'IM',
          underlying: '',
          expired: false,
        };
      },
    },
    wake() {
      record('wake');
    },
  };
  const mastra = createQuantMastra(context, () => deps);
  const tools: Record<string, PluginTool> = Object.fromEntries(
    mastra.tools.map((tool) => [tool.id, tool]),
  );
  const call = async (
    name: string,
    value: object = {},
    userId: string | null = 'alice',
    signal?: AbortSignal,
  ) => {
    const requestContext = new RequestContext();
    if (userId !== null) requestContext.set('userId', userId);
    requestContext.set('isAdmin', true); // Must never be trusted for execution authorization.
    const [tool] = await tools[`plugin_vibe_quant_${name}`].getTools();
    assert.ok(tool && 'execute' in tool && tool.execute);
    return tool.execute(value, {
      requestContext,
      abortSignal: signal,
      observe: noopObserve,
    });
  };
  return {
    calls,
    records,
    context,
    deps,
    tools,
    mastra,
    call,
    role: (value: string) => {
      role = value;
    },
    ban: () => {
      banned = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}

test('plugin registers a selectable quant-agent and 16 valid tools without starting resources', () => {
  const f = fixture();
  const server = createServer(f.context);
  assert.equal(server.agents?.[0].id, 'plugin:vibe-quant:quant-agent');
  const agent = Object.fromEntries(
    Object.entries(server.agents![0]).filter(
      ([key]) => key !== 'id' && key !== 'source',
    ),
  );
  assert.ok(agentInputSchema.safeParse(agent).success);
  assert.equal(server.tools?.length, 16);
  for (const tool of server.tools!) {
    assert.ok(tool instanceof PluginTool);
    assert.ok(tool instanceof BaseTool);
    assert.ok(toolIdSchema.safeParse(tool.id).success);
  }
  assert.equal(f.calls.length, 0);
});

test('guide reads the current SDK and template; tool scope comes from the message author', async () => {
  const f = fixture();
  const guide = await f.call('strategy_guide');
  assert.equal(guide.can_run, true);
  assert.match(guide.template.source, /class MovingAverage/);
  assert.match(guide.reference, /RiskLevels/);
  assert.deepEqual((await f.call('strategy_list', {}, 'bob')).strategies, []);
  assert.deepEqual(
    await f.call('strategy_read', { strategy_id: strategyId }, 'bob'),
    { error: 'STRATEGY_NOT_FOUND' },
  );
  assert.deepEqual(await f.call('backtest_result', { run_id: runId }, 'bob'), {
    error: 'STRATEGY_NOT_FOUND',
  });
  assert.ok(!f.calls.some((c) => c.name === 'artifact'));
  assert.deepEqual(await f.call('strategy_list', {}, null), {
    error: 'UNAUTHORIZED',
  });
  f.ban();
  assert.deepEqual(await f.call('strategy_list'), { error: 'UNAUTHORIZED' });
  f.disable();
  assert.equal(
    (await f.call('strategy_list')).error,
    'QUANT_SERVICE_UNAVAILABLE',
  );
});

test('flat strategy inputs default parameters and report invalid drafts before saving', async () => {
  const f = fixture();
  const created = await f.call('strategy_create', {
    name: ' 新策略 ',
    source: 'class Example: pass',
  });
  assert.equal(created.strategy.name, '新策略');
  assert.deepEqual(created.strategy.draft.parameters, {});
  assert.equal(created.strategy.enabled, true);
  assert.equal(created.strategy.description, '');
  const invalid = await f.call('strategy_update', {
    strategy_id: strategyId,
    revision: 3,
    source: '',
  });
  assert.equal(invalid.error, 'INVALID_ARGUMENTS');
  assert.equal(invalid.issues[0].field, 'draft.source');
  // A legacy nested payload must not silently become a no-op save.
  await f.call('strategy_update', {
    strategy_id: strategyId,
    revision: 3,
    draft: { source: 'legacy' },
  });
  assert.equal(f.calls.filter((c) => c.name === 'save').length, 1);
});

test('partial updates preserve omitted fields, reject stale revisions, and publish with CAS', async () => {
  const f = fixture();
  const result = await f.call('strategy_update', {
    strategy_id: strategyId,
    revision: 3,
    source: 'new source',
  });
  assert.equal(result.strategy.description, original.description);
  assert.equal(result.strategy.enabled, false);
  assert.equal(Object.hasOwn(result.strategy.draft, 'entrypoint'), false);
  assert.deepEqual(result.strategy.draft.parameters, original.draft.parameters);
  assert.equal(result.strategy.draft.source, 'new source');
  assert.equal(result.strategy.revision, 4);
  assert.deepEqual(
    await f.call('strategy_update', {
      strategy_id: strategyId,
      revision: 2,
      enabled: true,
    }),
    { error: 'STRATEGY_CONFLICT' },
  );
  assert.equal(f.calls.filter((c) => c.name === 'save').length, 1);
  await f.call('strategy_publish', {
    strategy_id: strategyId,
    revision: 3,
    note: '验证版本',
  });
  assert.deepEqual(f.calls.find((c) => c.name === 'publish')?.args, [
    'alice',
    strategyId,
    3,
    '验证版本',
  ]);
});

test('backtest requires a current admin and same-strategy version, merges parameters, normalizes stocks', async () => {
  const f = fixture();
  const config = {
    ...input(versionId, 'SSE.600000'),
    strategy_id: strategyId,
    parameters: { fast: 3 },
  };
  f.role('user');
  assert.deepEqual(await f.call('backtest_start', config), {
    error: 'SCRIPT_EXECUTION_ADMIN_REQUIRED',
  });
  assert.ok(!f.calls.some((c) => c.name === 'enqueue'));
  f.role('user,admin');
  const saved = f.records.version;
  f.records.version = async () => ({ ...version, strategy_id: randomUUID() });
  assert.deepEqual(await f.call('backtest_start', config), {
    error: 'VERSION_NOT_FOUND',
  });
  f.records.version = saved;
  config.rules.multiplier = 200;
  config.rules.margin_rate = 0.12;
  const result = await f.call('backtest_start', config);
  assert.deepEqual(result.run.config.parameters, { fast: 3, slow: 5 });
  assert.equal(result.run.config.rules.multiplier, 1);
  assert.equal(result.run.config.rules.margin_rate, 1);
  assert.equal(config.rules.multiplier, 200);
  assert.equal(result.run.user_id, undefined);
  assert.equal(f.calls.filter((c) => c.name === 'wake').length, 1);
  assert.deepEqual(
    await f.call('backtest_start', { ...config, symbol: 'OPTION.test' }),
    { error: 'UNSUPPORTED_INSTRUMENT' },
  );
  const invalid = await f.call('backtest_start', {
    ...config,
    end: config.start,
  });
  assert.equal(invalid.error, 'INVALID_BACKTEST_TIME_RANGE');
});

test('minimal backtest input resolves its strategy and keeps defaults and backend validation', async () => {
  const f = fixture();
  const config = input(versionId);
  const minimal = {
    version_id: versionId,
    symbol: config.symbol,
    start: config.start,
    end: config.end,
    rules: config.rules,
  };
  const result = await f.call('backtest_start', minimal);
  assert.equal(result.run.strategy_id, strategyId);
  assert.deepEqual(result.run.config.parameters, version.parameters);
  assert.equal(result.run.config.duration, 60);
  assert.equal(result.run.config.initial_cash, 1_000_000);
  assert.equal(result.run.config.participation_rate, 0.1);
  assert.equal(result.run.config.annualization, 252);
  assert.equal(result.run.config.slippage_ticks, 1);
  assert.equal(result.run.config.benchmark_symbol, null);
  assert.deepEqual(
    await f.call('backtest_start', { ...minimal, initial_cash: -1 }),
    {
      error: 'INVALID_BACKTEST_CONFIG',
    },
  );
  assert.equal(f.calls.filter((c) => c.name === 'enqueue').length, 1);
});

test('backtest agent preserves explicit fixed, rate and combined fee settings', async () => {
  const f = fixture();
  const config = input(versionId);
  for (const mode of ['fixed', 'rate', 'combined']) {
    const fees = { ...config.rules.fees, mode, close_today_per_unit: 0 };
    const result = await f.call('backtest_start', {
      ...config,
      rules: { ...config.rules, fees },
    });
    assert.deepEqual(result.run.config.rules.fees, fees);
  }
});

test('news search uses saved data, accepts industry names and follows an opaque cursor', async () => {
  const f = fixture();
  const first = await f.call('news_search', {
    query: ' 市场 ',
    industry: newsIndustries[0].name,
  });
  assert.equal(first.sync_enabled, false);
  assert.equal(first.articles[0].source, article.sourceName);
  assert.equal(first.articles[0].published_at, null);
  assert.equal(first.articles[0].discovered_at, 123);
  assert.equal(first.articles[0].content, undefined);
  assert.deepEqual(f.calls.find((c) => c.name === 'news.list')?.args, [
    {
      q: '市场',
      industry: article.industry,
      before: undefined,
      limit: 20,
    },
  ]);
  await f.call('news_search', { cursor: first.next_cursor });
  assert.deepEqual(f.calls.filter((c) => c.name === 'news.list').at(-1)?.args, [
    {
      q: '',
      industry: undefined,
      before: { time: 123, id: article.id },
      limit: 20,
    },
  ]);
  assert.deepEqual(await f.call('news_search', { cursor: 'invalid' }), {
    error: 'INVALID_NEWS_CURSOR',
  });
  assert.equal(
    (await f.call('news_search', { industry: 'unknown' })).error,
    'UNKNOWN_NEWS_INDUSTRY',
  );
  assert.equal(f.calls.filter((c) => c.name === 'news.list').length, 2);
});

test('news read preserves content status and enforces account, plugin and abort checks', async () => {
  const f = fixture();
  const result = await f.call('news_read', { article_id: article.id });
  assert.equal(result.article.content, article.content);
  assert.equal(result.article.url, article.url);
  f.deps.news.article = async () => ({
    ...article,
    content: '',
    contentStatus: 'failed',
    contentTruncated: true,
    contentError: 'FETCH_FAILED',
  });
  const failed = await f.call('news_read', { article_id: article.id });
  assert.equal(failed.article.content_status, 'failed');
  assert.equal(failed.article.content_truncated, true);
  f.deps.news.article = async () => null;
  assert.deepEqual(await f.call('news_read', { article_id: 'missing' }), {
    error: 'NEWS_NOT_FOUND',
  });
  assert.deepEqual(await f.call('news_search', {}, null), {
    error: 'UNAUTHORIZED',
  });
  f.ban();
  assert.deepEqual(await f.call('news_search'), { error: 'UNAUTHORIZED' });
  f.disable();
  assert.equal(
    (await f.call('news_search')).error,
    'QUANT_SERVICE_UNAVAILABLE',
  );
  assert.ok(!f.calls.some((c) => c.name === 'news.list'));

  const waiting = fixture();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  waiting.deps.news.article = () => {
    started();
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const pending = waiting.call(
    'news_read',
    { article_id: article.id },
    'alice',
    controller.signal,
  );
  await reading;
  controller.abort();
  assert.deepEqual(await pending, {
    cancelled: true,
    message: '用户中止了操作',
  });
});

test('results distinguish incomplete/failed runs, bound pages and expose zero-trade evidence', async () => {
  const f = fixture();
  assert.equal(
    (await f.call('backtest_result', { run_id: runId })).result,
    null,
  );
  f.records.run = async () => ({ ...queued, status: 'completed' });
  const result = {
    status: 'succeeded',
    message: '',
    metrics: { total_return: 0 },
    metric_notes: { sharpe: 'no variance' },
    account: {},
    monthly_returns: [],
    yearly_returns: [],
    trades: [],
    orders: [],
    fills: [],
    signals: Array.from({ length: 60 }, (_, i) => ({ id: String(i) })),
    logs: [],
    equity_curve: [],
  };
  f.records.artifact = async () => ({
    hash: 'verified-hash',
    text: JSON.stringify(result),
  });
  const summary = await f.call('backtest_result', { run_id: runId });
  assert.equal(summary.terminal, true);
  assert.equal(summary.result.counts.trades, 0);
  assert.equal(summary.result.counts.signals, 60);
  assert.equal(summary.result.result_hash, 'verified-hash');
  const page = await f.call('backtest_result', {
    run_id: runId,
    section: 'signals',
    offset: 50,
  });
  assert.equal(page.data.length, 10);
  assert.equal(page.next_offset, null);
  f.records.run = async () => ({
    ...queued,
    status: 'failed',
    message: '历史映射缺失',
  });
  const status = await f.call('backtest_status', { run_id: runId, wait: true });
  assert.equal(status.terminal, true);
  assert.equal(status.run.message, '历史映射缺失');
});

test('abort returns immediately, stops later mutations and cancels a late queue insert', async () => {
  const f = fixture();
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await f.call('strategy_list', {}, 'alice', aborted.signal), {
    cancelled: true,
    message: '用户中止了操作',
  });
  assert.equal(f.calls.length, 0);
  let finish!: (value: StrategyDetail) => void;
  f.records.detail = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const updateAbort = new AbortController();
  const pending = f.call(
    'strategy_update',
    { strategy_id: strategyId, revision: 3, name: 'changed' },
    'alice',
    updateAbort.signal,
  );
  await delay(10);
  updateAbort.abort();
  assert.equal((await pending).cancelled, true);
  finish(original);
  await delay(10);
  assert.ok(!f.calls.some((c) => c.name === 'save'));
  f.records.detail = async () => original;
  let enqueueDone!: () => void;
  const enqueue = f.records.enqueue;
  f.records.enqueue = async (...args) => {
    await new Promise<void>((resolve) => {
      enqueueDone = resolve;
    });
    return enqueue(...args);
  };
  const queueAbort = new AbortController();
  const creating = f.call(
    'backtest_start',
    { ...input(versionId), strategy_id: strategyId },
    'alice',
    queueAbort.signal,
  );
  await delay(10);
  queueAbort.abort();
  assert.equal((await creating).cancelled, true);
  enqueueDone();
  await delay(10);
  assert.ok(f.calls.some((c) => c.name === 'cancel'));
  assert.ok(!f.calls.some((c) => c.name === 'wake'));
  const waitAbort = new AbortController();
  const waiting = f.call(
    'backtest_status',
    { run_id: runId, wait: true },
    'alice',
    waitAbort.signal,
  );
  await delay(10);
  waitAbort.abort();
  assert.equal((await waiting).message, '用户中止了操作');
});

test(
  'quant tools create, update, publish and backtest through real ClickHouse and Python',
  { skip: process.env.QUANT_STRATEGY_INTEGRATION !== '1', timeout: 120000 },
  async () => {
    const f = await strategyFixture();
    try {
      await f.db.query(
        "ALTER TABLE users ADD COLUMN role text DEFAULT 'admin', ADD COLUMN banned boolean DEFAULT false",
      );
      const news = fixture().deps.news;
      const { tools } = createQuantMastra(f.context, () => ({
        records: f.records,
        state: f.state,
        config: f.config,
        news,
        wake: () => f.worker.wake(),
      }));
      const requestContext = new RequestContext();
      requestContext.set('userId', 'alice');
      const call = async (name: string, input: object = {}) => {
        const definition = tools.find(
          (t) => t.id === `plugin_vibe_quant_${name}`,
        )!;
        const [tool] = await definition.getTools();
        assert.ok(tool && 'execute' in tool && tool.execute);
        return tool.execute(input, { requestContext, observe: noopObserve });
      };
      const guide = await call('strategy_guide');
      const created = await call('strategy_create', {
        name: 'Quant Agent 集成验证',
        description: 'fixture market',
        ...guide.template,
      });
      assert.equal(created.strategy.revision, 1);
      const changed = await call('strategy_update', {
        strategy_id: created.strategy.id,
        revision: 1,
        parameters: { fast: 2, slow: 4, quantity: 1 },
      });
      assert.equal(changed.strategy.revision, 2);
      const published = await call('strategy_publish', {
        strategy_id: created.strategy.id,
        revision: 2,
        note: 'agent tool validation',
      });
      f.worker.start();
      const started = await call('backtest_start', {
        ...input(published.version.id),
        parameters: {},
        strategy_id: created.strategy.id,
      });
      assert.ok(started.run?.id, JSON.stringify(started));
      let status;
      for (let i = 0; i < 8; i++) {
        status = await call('backtest_status', {
          run_id: started.run.id,
          wait: true,
        });
        if (status.terminal) break;
      }
      assert.equal(status?.run.status, 'completed', JSON.stringify(status));
      const result = await call('backtest_result', { run_id: started.run.id });
      assert.equal(result.result.status, 'succeeded');
      assert.ok(result.result.counts.trades > 0);
      const artifact = await f.records.artifact(started.run.id, 'result');
      assert.deepEqual(
        result.result.metrics,
        (JSON.parse(artifact!.text) as BacktestResult).metrics,
      );
      requestContext.set('userId', 'bob');
      assert.deepEqual(
        await call('backtest_result', { run_id: started.run.id }),
        { error: 'RUN_NOT_FOUND' },
      );
      await f.db.query("UPDATE users SET role = 'user' WHERE id = 'alice'");
      requestContext.set('userId', 'alice');
      assert.deepEqual(
        await call('backtest_start', {
          ...input(published.version.id),
          strategy_id: created.strategy.id,
        }),
        { error: 'SCRIPT_EXECUTION_ADMIN_REQUIRED' },
      );
    } finally {
      await f.close();
    }
  },
);

test('Optuna tool shares authorization, immutable parameters, queue cancellation and result pagination', async () => {
  const f = fixture();
  const config = {
    ...input(versionId),
    parameters: { fast: 3 },
    optimization: {
      search_space: { fast: { type: 'int', low: 2, high: 4 } },
    },
  };
  f.role('user');
  assert.deepEqual(await f.call('backtest_optimize', config), {
    error: 'SCRIPT_EXECUTION_ADMIN_REQUIRED',
  });
  f.role('admin');
  assert.deepEqual(await f.call('backtest_optimize', config, 'bob'), {
    error: 'STRATEGY_NOT_FOUND',
  });
  const started = await f.call('backtest_optimize', config);
  assert.equal(started.run.config.optimization.n_trials, 30);
  assert.deepEqual(started.run.config.parameters, { fast: 3, slow: 5 });
  assert.equal(f.calls.filter((c) => c.name === 'enqueue').length, 1);
  f.records.run = async () => ({ ...started.run, status: 'failed' });
  f.records.artifact = async (_id, kind) =>
    kind === 'optimization'
      ? {
          hash: 'report-hash',
          text: JSON.stringify({
            status: 'failed',
            best_trial: null,
            trials: Array.from({ length: 60 }, (_, number) => ({
              number,
              state: 'failed',
            })),
          }),
        }
      : null;
  const result = await f.call('backtest_result', { run_id: runId });
  assert.equal(result.result, null);
  assert.equal(result.optimization.status, 'failed');
  assert.equal(result.optimization.trial_count, 60);
  assert.equal(result.optimization.trials, undefined);
  const page = await f.call('backtest_result', {
    run_id: runId,
    section: 'optimization_trials',
    offset: 50,
  });
  assert.equal(page.data.length, 10);
  assert.equal(page.data[0].number, 50);
  assert.equal(page.next_offset, null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await f.call('backtest_optimize', config, 'alice', controller.signal))
      .message,
    '用户中止了操作',
  );
  assert.equal(f.calls.filter((c) => c.name === 'enqueue').length, 1);
});
