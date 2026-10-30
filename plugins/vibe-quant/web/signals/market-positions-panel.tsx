import { runVersionName } from '../../strategy-version';
import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  ScrollArea,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@app/plugin-ui';
import {
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
} from 'lucide-react';
import type {
  MarketPosition,
  MarketPositionMonitor,
} from '../../market-positions';
import { monitorExecutionModel } from '../../signal-types';
import { durationLabel } from '../../shared';
import { tradeHoldingEnd } from '../../strategy-types';
import { dateTime, holdingDuration, number } from '../strategies/format';
import { TradeExitBadge } from '../trade-exit-badge';
import { useMarketPositions } from './use-market-positions';
import { MarketStrategyList } from './market-strategy-list';

const statuses = {
  starting: '准备中',
  running: '监听中',
  paused: '已暂停',
  error: '异常',
};
const price = (value: number | null) =>
  value == null
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: 6 });

function PositionRow({
  row,
  monitor,
}: {
  row: MarketPosition;
  monitor: MarketPositionMonitor;
}) {
  const trade = row.trade;
  const open = trade.status === 'open';
  const model = monitorExecutionModel(monitor.config);
  const displaySymbol = monitor.config.display_symbol ?? monitor.config.symbol;
  return (
    <li className="min-w-0 space-y-2.5 px-4 py-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">
            {monitor.strategy_name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {runVersionName(monitor)} · {durationLabel(monitor.config.duration)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={open ? 'secondary' : 'outline'}>
            {open ? '持仓中' : '已平仓'}
          </Badge>
          <Badge
            variant="outline"
            className={
              trade.side === 'long'
                ? 'border-rose-500/30 text-rose-700 dark:text-rose-300'
                : 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
            }
          >
            {trade.side === 'long' ? '多头' : '空头'}
          </Badge>
        </div>
      </div>
      <dl className="space-y-1 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">来源标的</dt>
          <dd className="break-all text-right font-medium">{trade.symbol}</dd>
        </div>
        {monitor.config.symbol !== trade.symbol && (
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">计算标的</dt>
            <dd className="break-all text-right">{monitor.config.symbol}</dd>
          </div>
        )}
        {displaySymbol !== trade.symbol && (
          <div className="flex justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">挂载图表</dt>
            <dd className="break-all text-right">{displaySymbol}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">数量 / 持仓时长</dt>
          <dd className="tabular-nums">
            {number(trade.quantity)} /{' '}
            {holdingDuration(trade.entry_time, tradeHoldingEnd(trade))}
          </dd>
        </div>
      </dl>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">入场</span>
        <time
          className="tabular-nums"
          dateTime={new Date(trade.entry_time * 1000).toISOString()}
        >
          {dateTime(trade.entry_time)}
        </time>
        <span className="text-right font-medium tabular-nums">
          {price(trade.entry_price)}
        </span>
        <span className="text-muted-foreground">离场</span>
        {open ? (
          <span className="col-span-2 text-muted-foreground">尚未离场</span>
        ) : (
          <>
            <time
              className="tabular-nums"
              dateTime={new Date(trade.exit_time * 1000).toISOString()}
            >
              {dateTime(trade.exit_time)}
            </time>
            <span className="text-right font-medium tabular-nums">
              {price(trade.exit_price)}
            </span>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">
          {monitor.config.simulation_engine === 'tqsdk'
            ? 'TqSim'
            : model === 'points'
              ? '点数模拟'
              : model === 'continuous_price'
                ? '主连价格模拟'
                : '策略模拟'}
        </Badge>
        {open ? (
          <Badge
            variant={monitor.status === 'error' ? 'destructive' : 'outline'}
          >
            {monitor.replaying ? '计算历史中' : statuses[monitor.status]}
          </Badge>
        ) : (
          <TradeExitBadge reason={trade.exit_reason} />
        )}
        {!open && (
          <span
            className={`ml-auto text-xs font-medium tabular-nums ${trade.net_pnl > 0 ? 'text-rose-700 dark:text-rose-300' : trade.net_pnl < 0 ? 'text-emerald-700 dark:text-emerald-300' : ''}`}
          >
            净收益 {trade.net_pnl > 0 ? '+' : ''}
            {number(trade.net_pnl)}
            {model === 'points' ? ' 点' : ' 元'}
          </span>
        )}
      </div>
      {open && (
        <p className="text-[11px] text-muted-foreground">
          计算至 {dateTime(monitor.through)}（北京时间）
        </p>
      )}
    </li>
  );
}

export function MarketPositionsPanel({
  pluginId,
  engine,
  marketOverview,
}: {
  pluginId: string;
  engine?: string;
  marketOverview?: ReactNode;
}) {
  const positions = useMarketPositions(pluginId, engine);
  const [tab, setTab] = useState('positions');
  const data = positions.data;
  const monitors = new Map(
    data?.monitors.map((monitor) => [monitor.id, monitor]),
  );
  const activeTab = tab === 'market' && !marketOverview ? 'positions' : tab;
  const rows: MarketPosition[] = [
    ...(data?.open ?? []),
    ...(positions.historyReady ? (data?.history ?? []) : []),
  ];
  return (
    <aside
      aria-label="策略持仓与行情"
      className="flex min-h-0 min-w-0 flex-col border-t lg:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-4 pb-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <BriefcaseBusiness className="size-4 text-primary" />
          策略持仓
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新策略持仓"
          disabled={positions.loading || !engine}
          onClick={positions.refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        当前引擎 · 全部 {data?.monitors.length ?? '—'} 条策略 · 模拟持仓
      </p>
      <Tabs
        value={activeTab}
        onValueChange={setTab}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList className="mx-3 mb-2 w-auto shrink-0" aria-label="行情侧栏">
          <TabsTrigger value="positions" className="text-xs">
            持仓记录
          </TabsTrigger>
          <TabsTrigger value="strategies" className="gap-1 text-xs">
            已加载策略
            {data && (
              <Badge variant="secondary" className="px-1.5 tabular-nums">
                {data.monitors.length}
              </Badge>
            )}
          </TabsTrigger>
          {marketOverview && (
            <TabsTrigger value="market" className="text-xs">
              行情盘口
            </TabsTrigger>
          )}
        </TabsList>
        {activeTab !== 'market' && positions.error && (
          <div
            role="alert"
            className="space-y-1 border-y border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          >
            <p>
              {activeTab === 'strategies' ? '策略' : '持仓'}更新失败：
              {positions.error}
            </p>
            {data && <p>当前显示上次成功获取的数据。</p>}
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={positions.refresh}
            >
              {activeTab === 'strategies' ? '重试策略加载' : '重试持仓加载'}
            </Button>
          </div>
        )}
        <TabsContent
          value="positions"
          forceMount
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <ScrollArea
            key={positions.page}
            className="h-[420px] xl:h-0 xl:min-h-0 xl:flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            {rows.length > 0 && (
              <ul aria-label="持仓记录列表" className="divide-y">
                {rows.map((row) => {
                  const monitor = monitors.get(row.monitor_id);
                  return monitor ? (
                    <PositionRow
                      key={`${row.trade.status === 'open' ? 'open' : 'closed'}:${row.monitor_id}:${row.trade.id}`}
                      row={row}
                      monitor={monitor}
                    />
                  ) : null;
                })}
              </ul>
            )}
            {!positions.historyReady && positions.loading ? (
              <div
                className="space-y-3 p-4"
                role="status"
                aria-label="正在加载持仓"
              >
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
              </div>
            ) : (
              !rows.length &&
              !positions.error && (
                <div className="px-5 py-10 text-center">
                  <p className="text-sm font-medium">
                    {!data?.monitors.length ? '尚未添加策略' : '暂无持仓记录'}
                  </p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {!data?.monitors.length
                      ? '在图表上方的「策略」菜单添加策略后，这里会汇总各标的的持仓。'
                      : '策略产生入场后会自动显示，离场后保留在同一列表中。'}
                  </p>
                </div>
              )
            )}
          </ScrollArea>
          {data &&
            (data.history.length > 0 || data.next || positions.page > 1) && (
              <div className="flex shrink-0 items-center justify-between gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 text-xs"
                  disabled={positions.page === 1 || positions.loading}
                  onClick={positions.latest}
                >
                  最新历史
                </Button>
                <span className="tabular-nums">历史第 {positions.page} 页</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="较新持仓"
                    disabled={positions.page === 1 || positions.loading}
                    onClick={positions.newer}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="更早持仓"
                    disabled={
                      !positions.historyReady || !data.next || positions.loading
                    }
                    onClick={positions.older}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
        </TabsContent>
        <TabsContent
          value="strategies"
          forceMount
          className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        >
          <MarketStrategyList
            data={data}
            loading={positions.loading}
            error={positions.error}
          />
        </TabsContent>
        {marketOverview && (
          <TabsContent value="market" className="flex min-h-0 flex-1 flex-col">
            <ScrollArea className="h-[420px] xl:h-0 xl:min-h-0 xl:flex-1">
              {marketOverview}
            </ScrollArea>
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}
