import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  ScrollArea,
  ScrollBar,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@app/plugin-ui';
import {
  ArrowLeft,
  ArrowRight,
  ChartCandlestick,
  Download,
} from 'lucide-react';
import type {
  BacktestResult,
  BacktestRun,
  TradeRecord,
} from '../../strategy-types';
import { tradeHoldingEnd } from '../../strategy-types';
import { resultTradeRecords, closedTradeWinRate } from '../../strategy-trades';
import {
  dateTime,
  errorText,
  holdingDuration,
  number,
  percent,
} from './format';
import { exitReasonLabel } from '../trade-exit';
import { PeriodReturns } from './period-returns';
const EquityChart = lazy(() => import('./equity-chart'));
const BacktestMarketChart = lazy(() => import('./backtest-market-chart'));
const metricLabels: [string, string, boolean?][] = [
  ['total_pnl', '总收益（元）'],
  ['total_return', '收益率', true],
  ['annual_return', '年化收益', true],
  ['max_drawdown', '最大回撤', true],
  ['sharpe', '夏普比率'],
  ['trade_count', '交易笔数'],
  ['win_rate', '胜率', true],
  ['final_equity', '最终权益'],
  ['benchmark_return', '基准收益', true],
  ['benchmark_annual_return', '基准年化', true],
  ['sortino', '索提诺比率'],
  ['calmar', '卡玛比率'],
  ['profit_factor', 'PF'],
];
const pointMetricLabels: [string, string, boolean?][] = [
  ['total_points', '累计收益（点）'],
  ['realized_points', '已实现收益（点）'],
  ['unrealized_points', '未平仓净收益（点）'],
  ['max_drawdown_points', '最大回撤（点）'],
  ['average_trade_points', '平均每笔（点）'],
  ['trade_count', '交易笔数'],
  ['win_rate', '胜率', true],
  ['profit_factor', 'PF'],
  ['benchmark_points', '基准涨跌（点）'],
];
export function ResultView({
  pluginId,
  run,
}: {
  pluginId: string;
  run: BacktestRun;
}) {
  const [data, setData] = useState<{
    result: BacktestResult | null;
    manifest: Record<string, unknown> | null;
  } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<{ trade: TradeRecord } | null>(
    null,
  );
  const marketSection = useRef<HTMLElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    pluginRequest<{
      result: BacktestResult | null;
      manifest: Record<string, unknown> | null;
    }>(pluginId, `/strategies/runs/${run.id}/result`, { signal: abort.signal })
      .then((value) => {
        setData(value);
        setError('');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [pluginId, run.id, run.status, retry]);
  const result = data?.result;
  const points = run.config.execution_model === 'points';
  const native = run.config.backtest_engine === 'tqsdk';
  const tqRules = data?.manifest?.tq_rules as
    Record<string, number> | undefined;
  const winRate = useMemo(
    () => (!native && result ? closedTradeWinRate(result) : null),
    [result, native],
  );
  const sortedTrades = useMemo(
    () =>
      (result ? resultTradeRecords(result) : []).sort(
        (a, b) =>
          Number(b.status === 'open') - Number(a.status === 'open') ||
          (b.exit_time ?? b.entry_time) - (a.exit_time ?? a.entry_time) ||
          b.entry_time - a.entry_time,
      ),
    [result],
  );
  if (error)
    return (
      <div role="alert" className="space-y-3 p-6 text-sm">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
          重试
        </Button>
      </div>
    );
  if (!data)
    return (
      <div className="space-y-4 p-5">
        <Skeleton className="h-24" />
        <Skeleton className="h-72" />
      </div>
    );
  return (
    <div className="space-y-6 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">v{run.version_number}</Badge>
          <Badge variant="secondary">
            {native ? '天勤回测 · TqSim' : '内置回测'}
          </Badge>
          {points && <Badge variant="secondary">点数回测 · 固定 1 单位</Badge>}
          {run.config.execution_model === 'continuous_price' && (
            <Badge variant="secondary">主连价格模拟</Badge>
          )}
          <span className="font-mono">{run.config.symbol}</span>
          <span className="text-muted-foreground">
            {run.engine} · {dateTime(run.created_at)}
          </span>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={`/api/plugins/${pluginId}/strategies/runs/${run.id}/export`}
            download
          >
            <Download className="size-3.5" />
            导出回测
          </a>
        </Button>
      </div>
      {run.message && (
        <p
          role={run.status === 'failed' ? 'alert' : 'status'}
          className={
            run.status === 'failed'
              ? 'text-sm text-destructive'
              : 'text-sm text-muted-foreground'
          }
        >
          {run.message}
        </p>
      )}
      <details className="rounded-md border p-3 text-xs">
        <summary className="cursor-pointer font-medium">
          回测参数与数据依据
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-muted-foreground sm:grid-cols-2">
          <div className="sm:col-span-2">
            成交模式：
            {points
              ? '点数回测（固定 1 单位，按多空价格点差记账）'
              : run.config.execution_model === 'continuous_price'
                ? '主连价格模拟（不计实际合约价差和换月成交成本）'
                : '实际合约价格'}
          </div>
          <div>
            区间：{dateTime(run.config.start)} — {dateTime(run.config.end)}
          </div>
          {points ? (
            <div>
              单边成本：{number(run.config.point_cost ?? 0)} 点 · 滑点：
              {run.config.slippage_ticks} 跳
            </div>
          ) : (
            <div>
              资金：{number(run.config.initial_cash)} 元 · 滑点：
              {run.config.slippage_ticks} 跳
            </div>
          )}
          {native && (
            <div className="sm:col-span-2">
              乘数：{number(tqRules?.multiplier)} · 每手保证金：
              {number(tqRules?.margin_per_lot)} 元 · 每手单边手续费：
              {number(tqRules?.commission_per_lot)} 元
            </div>
          )}
          {!points && !native && (
            <div>
              乘数：{run.config.rules.multiplier} · 保证金：
              {percent(run.config.rules.margin_rate)}
            </div>
          )}
          <div>
            {!points && !native && (
              <>成交量参与率：{percent(run.config.participation_rate)} · </>
            )}
            基准：
            {run.config.benchmark_symbol ?? '无'}
          </div>
          <div className="break-all sm:col-span-2">
            脚本 SHA-256：{run.source_hash}
          </div>
          {data.manifest && (
            <div className="break-all sm:col-span-2">
              SDK：
              {native
                ? `TqSdk ${String(data.manifest.tqsdk_version ?? '—')}`
                : String(data.manifest.sdk_version ?? '0.1.0')}{' '}
              · 数据快照：
              {String(data.manifest.data_snapshot_hash ?? '—')}
            </div>
          )}
        </dl>
        <ScrollArea className="mt-3 max-h-52 rounded bg-muted/40">
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px]">
            {JSON.stringify(
              {
                execution_model:
                  run.config.execution_model ?? 'actual_contract',
                backtest_engine: run.config.backtest_engine ?? 'builtin',
                parameters: run.config.parameters,
                ...(run.config.optimization
                  ? { optimization: run.config.optimization }
                  : {}),
                ...(points
                  ? {
                      point_cost: run.config.point_cost ?? 0,
                      position_units: 1,
                    }
                  : {
                      ...(native
                        ? { tq_rules: data.manifest?.tq_rules }
                        : { rules: run.config.rules }),
                      annualization: run.config.annualization,
                      risk_free_rate: run.config.risk_free_rate,
                    }),
              },
              null,
              2,
            )}
          </pre>
        </ScrollArea>
      </details>
      {native && (
        <p className="text-xs leading-5 text-muted-foreground">
          资金与成交取自
          TqSim。委托按对手价加滑点提交，不模拟部分成交或成交量参与率；止盈止损按回放行情最新价触发，K
          线回放不还原完整盘中路径。手续费与保证金采用上方记录的设置，不代表历史费率表。
        </p>
      )}
      {!result ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          {['queued', 'preparing', 'running'].includes(run.status)
            ? '回测完成后，这里会展示收益、净值和逐笔交易。'
            : '本次运行没有生成结果。可检查上方原因，调整参数后重新运行。'}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 divide-x divide-y rounded-lg border sm:grid-cols-3 xl:grid-cols-4">
            {(points
              ? pointMetricLabels
              : native
                ? metricLabels.map(([key, label, ratio]) =>
                    key === 'profit_factor'
                      ? (['profit_loss_ratio', '盈亏额比例（天勤）', false] as [
                          string,
                          string,
                          boolean?,
                        ])
                      : key === 'trade_count'
                        ? ([key, '平仓成交笔数（天勤）', ratio] as [
                            string,
                            string,
                            boolean?,
                          ])
                        : ([key, label, ratio] as [string, string, boolean?]),
                  )
                : metricLabels
            ).map(([key, label, ratio]) => (
              <div key={key} className="px-4 py-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd
                  className={`mt-1 text-lg font-medium tabular-nums ${['total_pnl', 'total_points'].includes(key) ? ((result.metrics[key] ?? 0) >= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400') : ''}`}
                >
                  {ratio
                    ? percent(
                        key === 'win_rate' && !native
                          ? winRate
                          : result.metrics[key],
                      )
                    : number(result.metrics[key])}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {native
              ? '绩效指标直接使用天勤报告：胜率按平仓手数及毛盈亏计算，持平计为盈利；回撤、年化与风险指标采用天勤口径。'
              : '胜率按已平仓交易的净盈亏计算，盈亏持平计入交易总数，未平仓交易不计入。'}
          </p>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {points ? '累计点数曲线' : '净值曲线'}
              </h3>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>● 策略</span>
                <span>— 基准</span>
              </div>
            </div>
            {result.equity_curve.length ? (
              <Suspense fallback={<Skeleton className="h-72" />}>
                <EquityChart
                  points={result.equity_curve}
                  pointMode={points}
                  initial={run.config.initial_cash}
                />
              </Suspense>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                暂无净值数据
              </p>
            )}
          </section>
          <section
            ref={marketSection}
            aria-label="回测行情"
            className="min-w-0 scroll-mt-4"
          >
            <Suspense fallback={<Skeleton className="h-[640px]" />}>
              <BacktestMarketChart
                key={run.id}
                pluginId={pluginId}
                run={run}
                selection={selection}
                riskLevels={result.risk_levels}
                onClearSelection={() => setSelection(null)}
              />
            </Suspense>
          </section>
          <Tabs defaultValue="trades">
            <TabsList>
              <TabsTrigger value="trades">
                交易记录 · {sortedTrades.length}
              </TabsTrigger>
              <TabsTrigger value="periods">月度 / 年度</TabsTrigger>
              <TabsTrigger value="logs">订单与日志</TabsTrigger>
            </TabsList>
            <TabsContent value="trades" className="mt-3">
              <div className="rounded-md border">
                <ScrollArea className="w-full">
                  <Table aria-label="历史交易记录">
                    <TableHeader>
                      <TableRow>
                        <TableHead>标的 / 方向</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>入场</TableHead>
                        <TableHead>离场</TableHead>
                        <TableHead
                          className="whitespace-nowrap text-right"
                          title="按自然时间计算；未平仓记录截至回测最后观测时间"
                        >
                          持仓时间
                        </TableHead>
                        <TableHead>离场原因</TableHead>
                        <TableHead className="text-right">数量</TableHead>
                        <TableHead className="text-right">
                          {points ? '成本（点）' : '手续费'}
                        </TableHead>
                        <TableHead className="text-right">
                          {points ? '净收益（点）' : '净收益'}
                        </TableHead>
                        <TableHead className="sticky right-0 bg-background text-right">
                          行情
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedTrades
                        .slice(page * 20, (page + 1) * 20)
                        .map((item) => (
                          <TableRow
                            key={item.id}
                            data-state={
                              selection?.trade.id === item.id
                                ? 'selected'
                                : undefined
                            }
                          >
                            <TableCell>
                              <div className="font-mono text-xs">
                                {item.symbol}
                              </div>
                              <Badge className="mt-1" variant="outline">
                                {item.side === 'long' ? '多头' : '空头'}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  item.status === 'open'
                                    ? 'secondary'
                                    : 'outline'
                                }
                              >
                                {item.status === 'open' ? '未平仓' : '已平仓'}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs tabular-nums">
                              <div>{number(item.entry_price)}</div>
                              <span className="whitespace-nowrap text-muted-foreground">
                                {dateTime(item.entry_time)}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs tabular-nums">
                              <div>{number(item.exit_price)}</div>
                              <span className="whitespace-nowrap text-muted-foreground">
                                {dateTime(item.exit_time)}
                              </span>
                              {item.exit_time_precision === 'bar' && (
                                <div
                                  className="text-muted-foreground"
                                  title="该分钟内触发；记录该根 K 线结束时间，不代表精确成交秒数"
                                >
                                  K 线内成交
                                </div>
                              )}
                            </TableCell>
                            <TableCell
                              className="whitespace-nowrap text-right tabular-nums"
                              title={
                                item.status === 'open'
                                  ? `截至 ${dateTime(item.observed_until)}（回测最后观测时间）`
                                  : undefined
                              }
                            >
                              {holdingDuration(
                                item.entry_time,
                                tradeHoldingEnd(item),
                              )}
                            </TableCell>
                            <TableCell>
                              {item.status === 'open' ? (
                                '—'
                              ) : (
                                <Badge
                                  variant="outline"
                                  title={item.exit_reason}
                                >
                                  {exitReasonLabel(item.exit_reason)}
                                </Badge>
                              )}
                              {item.trigger_price != null && (
                                <div className="mt-1 text-xs text-muted-foreground">
                                  触发价 {number(item.trigger_price)}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {item.quantity}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {number(item.fees)}
                            </TableCell>
                            <TableCell
                              className={`text-right tabular-nums ${item.net_pnl === null ? 'text-muted-foreground' : item.net_pnl >= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                            >
                              {number(item.net_pnl)}
                            </TableCell>
                            <TableCell className="sticky right-0 bg-background text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setSelection({ trade: item });
                                  marketSection.current?.scrollIntoView({
                                    block: 'start',
                                    behavior: window.matchMedia(
                                      '(prefers-reduced-motion: reduce)',
                                    ).matches
                                      ? 'auto'
                                      : 'smooth',
                                  });
                                }}
                                aria-pressed={selection?.trade.id === item.id}
                                aria-label={`${item.status === 'open' ? '查看入场' : '回放'} ${item.symbol} ${dateTime(item.entry_time)} 的交易`}
                              >
                                <ChartCandlestick className="size-4" />
                                {item.status === 'open' ? '查看入场' : '回放'}
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      {!sortedTrades.length && (
                        <TableRow>
                          <TableCell
                            colSpan={10}
                            className="py-10 text-center text-muted-foreground"
                          >
                            暂无交易记录，可在订单与日志中检查信号和拒单原因。
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                  <ScrollBar orientation="horizontal" />
                </ScrollArea>
              </div>
              {sortedTrades.length > 20 && (
                <div className="mt-3 flex items-center justify-end gap-3 text-xs text-muted-foreground">
                  <span>
                    {page + 1} / {Math.ceil(sortedTrades.length / 20)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page === 0}
                    onClick={() => setPage((n) => n - 1)}
                    aria-label="上一页交易"
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(page + 1) * 20 >= sortedTrades.length}
                    onClick={() => setPage((n) => n + 1)}
                    aria-label="下一页交易"
                  >
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              )}
            </TabsContent>
            <TabsContent value="periods" className="mt-3">
              <PeriodReturns
                points={points}
                monthly={result.monthly_returns}
                yearly={result.yearly_returns}
              />
            </TabsContent>
            <TabsContent value="logs" className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                订单 {result.orders.length} · 成交 {result.fills.length} · 信号{' '}
                {result.signals.length} · 日志 {result.logs.length} · 止盈止损{' '}
                {result.risk_levels?.length ?? 0}
                。此处展示最近 100 条，导出包含完整记录。
              </p>
              {[
                ['订单', result.orders],
                ['策略日志', result.logs],
                ['止盈止损计算记录', result.risk_levels ?? []],
                ['账户与持仓', result.account],
              ].map(([title, values]) => (
                <details
                  key={title as string}
                  className="rounded-md border p-3 text-xs"
                >
                  <summary className="cursor-pointer">
                    {title as string}
                  </summary>
                  <ScrollArea className="mt-2 h-60">
                    <pre className="whitespace-pre-wrap break-all font-mono">
                      {JSON.stringify(
                        Array.isArray(values) ? values.slice(-100) : values,
                        null,
                        2,
                      )}
                    </pre>
                  </ScrollArea>
                </details>
              ))}
            </TabsContent>
          </Tabs>
          <p className="text-xs leading-5 text-muted-foreground">
            {points
              ? '点数收益已扣单边成本与滑点，未平仓头寸按最新价计入累计点数。每个标的固定 1 单位，忽略下单数量大小及资金、保证金、乘数、成交量、T+1 限制；不表示真实资金收益。未平仓净收益含已付开仓成本。'
              : native
                ? '资金、保证金与逐日结算取自 TqSim；交易明细按实际成交进行 FIFO 归并，手续费计入净收益。未平仓记录显示剩余数量及对应开仓手续费。'
                : '收益已扣费用，未平仓头寸按最新价计入权益；交易笔数按 FIFO 平仓片段统计。期货逐日结算采用前一交易日最后观测价。未平仓记录显示剩余数量及对应开仓手续费，净收益在平仓后记录。'}
            “—”表示样本不足或指标无定义。
          </p>
          {!native && data.manifest?.risk_model != null && (
            <p className="text-xs leading-5 text-muted-foreground">
              止盈止损从计算后的下一根执行 K
              线生效；跳空按开盘价，同根同时触及按止损优先。
              {points
                ? '成交计入滑点与点数成本。'
                : '成交计入滑点与费用，并受成交量和 T+1 限制。'}
              盘中触发按该根 K 线结束时间记账，回放定位触发 K 线。
            </p>
          )}
        </>
      )}
    </div>
  );
}
