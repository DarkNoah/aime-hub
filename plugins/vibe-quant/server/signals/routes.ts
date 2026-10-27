import { Hono } from 'hono';
import { z } from 'zod';
import type { PluginHttpEnv } from '@app/plugin-sdk/server';
import type { StrategyStore } from '../strategies/store.js';
import { backtestSchema, StrategyError } from '../strategies/schema.js';
import type { StateStore } from '../state-store.js';
import type { QuantConfig } from '../config.js';
import {
  strategyNotificationsSchema,
  strategyNotifications,
} from '../../strategy-notifications.js';
import { supports } from '../symbols.js';
import type { MonitorStore } from './store.js';
import {
  isIndexSymbol,
  monitorExecutionModel,
  strategyHintDuration,
} from '../../signal-types.js';
import { POINT_BACKTEST_RULES } from '../../strategy-types.js';

const shape = backtestSchema.shape;
export const monitorSchema = z.object({
  version_id: shape.version_id,
  symbol: shape.symbol,
  duration: shape.duration,
  parameters: shape.parameters,
  rules: shape.rules,
  initial_cash: shape.initial_cash,
  calendar: shape.calendar,
  execution_model: shape.execution_model,
  point_cost: shape.point_cost,
  notifications: strategyNotificationsSchema.optional(),
  notifications_enabled: z.boolean().optional(),
  warmup_days: z.number().int().min(1).max(90).default(7),
  events: z
    .object({ entry: z.boolean(), exit: z.boolean() })
    .default({ entry: true, exit: true }),
});
// Market hints use the published version's timeframe, independently of the chart.
// Keep full input support for existing callers and immutable stored monitors.
const createMonitorSchema = monitorSchema.extend({
  duration: shape.duration.optional(),
  parameters: shape.parameters.optional(),
  rules: shape.rules.optional(),
  initial_cash: shape.initial_cash.optional(),
});
export function signalRoutes(
  get: () => {
    records: StrategyStore;
    monitors: MonitorStore;
    state: StateStore;
    config: QuantConfig;
    wake: () => void;
  },
) {
  const api = new Hono<PluginHttpEnv>();
  api.onError((error, c) =>
    error instanceof StrategyError
      ? c.json({ code: error.code }, error.status)
      : c.json({ code: 'STRATEGY_SERVICE_UNAVAILABLE' }, 503),
  );
  const editable = async (id: string) => {
    const row = await get().records.storedStrategy(id);
    if ((row.status ?? 'active') !== 'active')
      throw new StrategyError(
        row.status === 'deleted' ? 'STRATEGY_DELETED' : 'STRATEGY_ARCHIVED',
        409,
      );
    if (!row.enabled) throw new StrategyError('STRATEGY_DISABLED', 409);
    return row;
  };
  api.get('/monitors/:id/history', async (c) => {
    const { monitors } = get();
    const monitor = await monitors.get(c.req.param('id'), c.get('userId'));
    if (monitor.deleted) throw new StrategyError('MONITOR_NOT_FOUND', 404);
    const [history, view] = await Promise.all([
      monitors.history.read(
        monitor.id,
        c.req.query('before'),
        c.req.query('signalsBefore'),
      ),
      monitors.view(monitor),
    ]);
    return c.json({ ...history, monitor: view });
  });
  api.get('/monitors', async (c) => {
    const { monitors, records, config } = get();
    const owner = c.get('userId'),
      symbol = c.req.query('symbol');
    if (!symbol || !shape.symbol.safeParse(symbol).success)
      throw new StrategyError('INVALID_MONITOR_CONFIG');
    const rawFrom = c.req.query('from'),
      rawTo = c.req.query('to');
    const range =
      rawFrom !== undefined || rawTo !== undefined
        ? { from: Number(rawFrom), to: Number(rawTo) }
        : undefined;
    if (
      range &&
      (!Number.isFinite(range.from) ||
        !Number.isFinite(range.to) ||
        range.from < 0 ||
        range.from >= range.to)
    )
      throw new StrategyError('INVALID_MONITOR_CONFIG');
    const rows = (await monitors.list(owner)).filter(
      (row) => row.config.symbol === symbol && row.engine === config.engine,
    );
    return c.json(
      await Promise.all(
        rows.map(async (row) => {
          const [monitor, strategy, signals, overlay, chart] =
            await Promise.all([
              monitors.view(row),
              records.storedStrategy(row.strategy_id),
              monitors.signals(owner, row.id),
              monitors.overlay(row.id),
              monitors.history.chart(row.id, range),
            ]);
          return {
            ...monitor,
            strategy_name: strategy.name,
            notifications: strategyNotifications(
              row.notifications ?? strategy.notifications,
            ),
            signals,
            overlay,
            ...chart,
          };
        }),
      ),
    );
  });
  api.get('/:strategyId/monitors', async (c) => {
    const { records, monitors } = get();
    await records.storedStrategy(c.req.param('strategyId'));
    return c.json(
      await Promise.all(
        (await monitors.list(c.get('userId'), c.req.param('strategyId'))).map(
          (row) => monitors.view(row),
        ),
      ),
    );
  });
  api.post('/:strategyId/monitors', async (c) => {
    if (!c.get('isAdmin'))
      throw new StrategyError('SCRIPT_EXECUTION_ADMIN_REQUIRED', 403);
    const parsed = createMonitorSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new StrategyError('INVALID_MONITOR_CONFIG');
    const { records, monitors, state, config, wake } = get();
    const owner = c.get('userId'),
      strategyId = c.req.param('strategyId');
    await editable(strategyId);
    const version = await records.version(owner, parsed.data.version_id);
    if (version.strategy_id !== strategyId)
      throw new StrategyError('VERSION_NOT_FOUND', 404);
    const item = await state.instrument(config.engine, parsed.data.symbol);
    const executionModel = monitorExecutionModel(parsed.data);
    if (
      !item ||
      item.expired ||
      item.kind === 'option' ||
      (isIndexSymbol(item.symbol) && executionModel !== 'points') ||
      (executionModel === 'continuous_price' &&
        (item.kind !== 'continuous' || !item.symbol.startsWith('KQ.m@'))) ||
      !supports(config.engine, item) ||
      (item.kind === 'continuous' && !item.symbol.startsWith('KQ.m@'))
    )
      throw new StrategyError('UNSUPPORTED_INSTRUMENT');
    const stock = item.kind === 'stock';
    const points = executionModel === 'points';
    const rules = parsed.data.rules ?? {
      multiplier: stock ? 1 : 200,
      margin_rate: stock ? 1 : 0.12,
      lot_size: stock ? 100 : 1,
      t_plus_one: stock,
      fees: {
        mode: 'fixed',
        per_unit: 0,
        rate: 0,
        minimum: 0,
        close_today_per_unit: null,
        close_today_rate: null,
        sell_tax_rate: 0,
      },
    };
    const { notifications, notifications_enabled, ...monitorConfig } =
      monitorSchema.parse({
        ...parsed.data,
        // The simple market picker reuses the published version. Full legacy
        // callers supply explicit parameters and retain their requested period.
        duration:
          parsed.data.parameters === undefined
            ? (strategyHintDuration(version.parameters) ?? 60)
            : (parsed.data.duration ??
              strategyHintDuration(version.parameters) ??
              60),
        ...(points ? { execution_model: 'points' } : {}),
        parameters: parsed.data.parameters ?? version.parameters,
        initial_cash: points ? 1 : (parsed.data.initial_cash ?? 1_000_000),
        rules: points
          ? structuredClone(POINT_BACKTEST_RULES)
          : stock
            ? { ...rules, multiplier: 1, margin_rate: 1 }
            : rules,
      });
    const monitor = await monitors.create(
      owner,
      strategyId,
      version.number,
      config.engine,
      monitorConfig,
      {
        notifications: strategyNotifications(
          notifications ?? {
            channels: { toast: { enabled: true }, desktop: { enabled: false } },
          },
        ),
        notifications_enabled: notifications_enabled ?? false,
      },
    );
    wake();
    return c.json(monitor, 201);
  });
  api.patch('/monitors/:id', async (c) => {
    const parsed = z
      .object({
        revision: z.number().int().positive(),
        enabled: z.boolean().optional(),
        notifications_enabled: z.boolean().optional(),
        notifications: strategyNotificationsSchema.optional(),
        deleted: z.boolean().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new StrategyError('INVALID_MONITOR_CONFIG');
    const { monitors, wake } = get();
    const owner = c.get('userId'),
      row = await monitors.get(c.req.param('id'), owner);
    if (parsed.data.enabled && !parsed.data.deleted && !row.enabled) {
      if (!c.get('isAdmin'))
        throw new StrategyError('SCRIPT_EXECUTION_ADMIN_REQUIRED', 403);
      await editable(row.strategy_id);
    }
    const result = await monitors.update(
      owner,
      row.id,
      parsed.data.revision,
      (parsed.data.enabled ?? row.enabled) && !parsed.data.deleted,
      parsed.data.deleted,
      {
        ...(parsed.data.notifications === undefined
          ? {}
          : { notifications: parsed.data.notifications }),
        ...(parsed.data.notifications_enabled === undefined
          ? {}
          : { notifications_enabled: parsed.data.notifications_enabled }),
      },
    );
    wake();
    return c.json(result);
  });
  api.get('/monitors/:id/signals', async (c) =>
    c.json(await get().monitors.signals(c.get('userId'), c.req.param('id'))),
  );
  return api;
}
