import { useEffect, useRef, useState, type ReactNode } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
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
import { Loader2, LocateFixed } from 'lucide-react';
import { toast } from 'sonner';
import { monitorExecutionModel } from '../../signal-types';
import type { MarketStrategyHint } from '../../signal-types';
import type { SignalHistoryPage } from '../../signal-history';
import type { OpenTrade, Trade } from '../../strategy-types';
import { durationLabel } from '../../shared';
import { PeriodReturns } from '../strategies/period-returns';
import { dateTime, errorText, number, percent } from '../strategies/format';
import { TradeExitBadge } from '../trade-exit-badge';

function HistoryTab({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <TabsContent
      value={value}
      forceMount
      className="flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
    >
      <ScrollArea
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        viewportProps={{ className: 'min-h-0 flex-1 [&>div]:block!' }}
      >
        <div className="space-y-6 p-4 sm:p-5">{children}</div>
      </ScrollArea>
    </TabsContent>
  );
}

function Trades({
  rows,
  open = false,
  points = false,
  jumping,
  onJumpToEntry,
}: {
  rows: (Trade | OpenTrade)[];
  open?: boolean;
  points?: boolean;
  jumping: string | null;
  onJumpToEntry: (trade: Trade | OpenTrade) => void;
}) {
  return (
    <div className="rounded-md border">
      <ScrollArea className="w-full">
        <Table aria-label={open ? '当前持仓' : '历史入场离场记录'}>
          <TableHeader>
            <TableRow>
              <TableHead>标的 / 方向</TableHead>
              <TableHead>数量</TableHead>
              <TableHead>入场时间</TableHead>
              <TableHead>入场价</TableHead>
              <TableHead>离场时间</TableHead>
              <TableHead>离场价</TableHead>
              {!open && <TableHead>离场原因</TableHead>}
              <TableHead>{points ? '净收益（点）' : '净收益'}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {row.symbol}{' '}
                  <Badge variant="outline">
                    {row.side === 'long' ? '多' : '空'}
                  </Badge>
                </TableCell>
                <TableCell>{number(row.quantity)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto gap-1.5 p-0 font-normal tabular-nums"
                    disabled={jumping !== null}
                    title="跳转到入场时间"
                    aria-label={`跳转到 ${row.symbol} ${dateTime(row.entry_time)} 的入场时间`}
                    onClick={() => onJumpToEntry(row)}
                  >
                    {jumping === row.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <LocateFixed className="size-3.5" />
                    )}
                    {dateTime(row.entry_time)}
                  </Button>
                </TableCell>
                <TableCell>{number(row.entry_price)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {open ? (
                    <Badge variant="secondary">持仓中</Badge>
                  ) : (
                    dateTime(row.exit_time)
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {number(row.exit_price)}
                  {!open && row.trigger_price != null && (
                    <div className="text-xs text-muted-foreground">
                      触发价 {number(row.trigger_price)}
                    </div>
                  )}
                </TableCell>
                {!open && (
                  <TableCell className="whitespace-nowrap">
                    <TradeExitBadge reason={row.exit_reason} />
                  </TableCell>
                )}
                <TableCell>{number(row.net_pnl)}</TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell
                  colSpan={open ? 7 : 8}
                  className="py-6 text-center text-muted-foreground"
                >
                  {open ? '当前无持仓' : '暂无已完成的入场离场记录'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  );
}

export function HintPerformance({
  pluginId,
  item,
  onClose,
  onJumpToEntry,
}: {
  pluginId: string;
  item: MarketStrategyHint;
  onClose: () => void;
  onJumpToEntry: (time: number) => Promise<boolean>;
}) {
  const [page, setPage] = useState<SignalHistoryPage | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [signals, setSignals] = useState<MarketStrategyHint['signals']>([]);
  const [signalsNext, setSignalsNext] = useState<string | null>(null);
  const [older, setOlder] = useState<'trade' | 'signal' | null>(null);
  const [error, setError] = useState('');
  const [jumping, setJumping] = useState<string | null>(null);
  const paginated = useRef({ trade: false, signal: false });
  const lifecycle = useRef<AbortController | null>(null);
  const path = `/strategies/monitors/${item.id}/history`;
  useEffect(() => {
    const abort = new AbortController();
    lifecycle.current = abort;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const fresh = await pluginRequest<SignalHistoryPage>(pluginId, path, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setPage(fresh);
        setTrades((old) => [
          ...fresh.trades,
          ...old.filter(
            (row) => !fresh.trades.some((value) => value.id === row.id),
          ),
        ]);
        setSignals((old) => [
          ...fresh.signals,
          ...old.filter(
            (row) => !fresh.signals.some((value) => value.id === row.id),
          ),
        ]);
        if (!paginated.current.trade) setNext(fresh.next);
        if (!paginated.current.signal) setSignalsNext(fresh.signals_next);
        setError('');
      } catch (error) {
        if (!abort.signal.aborted) setError(errorText(error));
      } finally {
        if (!abort.signal.aborted)
          timer = setTimeout(() => void poll(), document.hidden ? 10000 : 2000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, path]);
  async function jumpToEntry(trade: Trade | OpenTrade) {
    if (jumping !== null) return;
    setJumping(trade.id);
    const signal = lifecycle.current?.signal;
    try {
      const success = await onJumpToEntry(trade.entry_time);
      if (signal?.aborted) return;
      if (success) onClose();
    } catch (error) {
      if (!signal?.aborted) toast.error(errorText(error));
    } finally {
      if (!signal?.aborted) setJumping(null);
    }
  }
  async function loadOlder(kind: 'trade' | 'signal') {
    const cursor = kind === 'trade' ? next : signalsNext;
    if (!cursor || older) return;
    setOlder(kind);
    const signal = lifecycle.current?.signal;
    try {
      const fresh = await pluginRequest<SignalHistoryPage>(
        pluginId,
        `${path}?${kind === 'trade' ? 'before' : 'signalsBefore'}=${encodeURIComponent(cursor)}`,
        { signal },
      );
      if (signal?.aborted) return;
      paginated.current[kind] = true;
      if (kind === 'signal') {
        setSignalsNext(fresh.signals_next);
        setSignals((old) => [
          ...old,
          ...fresh.signals.filter(
            (row) => !old.some((value) => value.id === row.id),
          ),
        ]);
        return;
      }
      setNext(fresh.next);
      setTrades((old) => [
        ...old,
        ...fresh.trades.filter(
          (row) => !old.some((value) => value.id === row.id),
        ),
      ]);
    } catch (error) {
      if (!signal?.aborted) toast.error(errorText(error));
    } finally {
      if (!signal?.aborted) setOlder(null);
    }
  }
  const summary = page?.summary;
  const monitor = page?.monitor ?? item;
  const points = monitorExecutionModel(monitor.config) === 'points';
  const computing = monitor.status === 'starting' || summary?.replaying;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 p-0 sm:max-w-5xl">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>{item.strategy_name} · 历史记录</SheetTitle>
          <SheetDescription>
            {item.config.symbol} · v{item.version_number} ·{' '}
            {durationLabel(item.config.duration)}
            。加入后自动计算全部已存行情，并持续更新当前入场、离场与持仓。
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-2 border-b px-4 py-3 sm:px-5">
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Badge
                variant={monitor.status === 'error' ? 'destructive' : 'outline'}
              >
                {monitor.status === 'error'
                  ? '计算异常'
                  : monitor.status === 'paused'
                    ? '已暂停'
                    : computing
                      ? '计算全量历史中'
                      : '实时更新'}
              </Badge>
              {computing && <Loader2 className="size-3 animate-spin" />}
              <span>{monitor.message}</span>
            </div>
            {summary && (
              <p>
                数据起点：{dateTime(summary.start)} · 已计算至：
                {dateTime(summary.through)}
              </p>
            )}
            {monitorExecutionModel(item.config) === 'continuous_price' && (
              <p>
                <Badge variant="secondary">主连价格模拟</Badge>{' '}
                入场、离场和持仓按主连价格模拟，不代表实际合约成交，不计合约价差与换月成本。
              </p>
            )}
            {points && (
              <p>
                <Badge variant="secondary">点数模拟</Badge> 固定 1
                单位模拟多空，收益与回撤以点数统计。
              </p>
            )}
            <p>移除该策略提示会清除全部历史记录，再次加入将重新计算。</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Tabs
          defaultValue="trades"
          className="min-h-0 flex-1 gap-0 overflow-hidden"
        >
          <div className="shrink-0 border-b px-4 py-3 sm:px-5">
            <TabsList
              className="grid w-full grid-cols-3"
              aria-label="历史记录分类"
            >
              <TabsTrigger value="trades">交易记录</TabsTrigger>
              <TabsTrigger value="signals">信号记录</TabsTrigger>
              <TabsTrigger value="overview">收益概览</TabsTrigger>
            </TabsList>
          </div>
          {!page && !error ? (
            <Skeleton className="m-4 h-48 sm:m-5" />
          ) : !summary ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              正在准备历史记录，计算进度与新记录将自动显示。
            </p>
          ) : (
            <>
              <HistoryTab value="trades">
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">当前持仓</h3>
                  <Trades
                    rows={summary.open_trades}
                    points={points}
                    open
                    jumping={jumping}
                    onJumpToEntry={(trade) => void jumpToEntry(trade)}
                  />
                </section>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">入场与离场记录</h3>
                  <Trades
                    rows={trades}
                    points={points}
                    jumping={jumping}
                    onJumpToEntry={(trade) => void jumpToEntry(trade)}
                  />
                  {next && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={older !== null}
                      onClick={() => void loadOlder('trade')}
                    >
                      {older === 'trade' ? '正在加载…' : '加载更早记录'}
                    </Button>
                  )}
                </section>
              </HistoryTab>
              <HistoryTab value="signals">
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">入场与离场信号</h3>
                  <div className="divide-y rounded-md border">
                    {signals.length ? (
                      signals.map((signal) => (
                        <div
                          key={signal.id}
                          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
                        >
                          <Badge
                            variant={
                              signal.type === 'entry' ? 'default' : 'secondary'
                            }
                          >
                            {signal.type === 'entry' ? '入场' : '离场'}
                            {signal.side === 'long'
                              ? ' · 多'
                              : signal.side === 'short'
                                ? ' · 空'
                                : ''}
                          </Badge>
                          {signal.type === 'exit' && (
                            <TradeExitBadge reason={signal.reason} />
                          )}
                          <span>{signal.symbol}</span>
                          <span className="tabular-nums">
                            {number(signal.price)}
                          </span>
                          <span className="text-muted-foreground">
                            {dateTime(signal.time)}
                          </span>
                          {signal.type === 'entry' && (
                            <span>{signal.reason}</span>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="p-4 text-sm text-muted-foreground">
                        暂无信号
                      </p>
                    )}
                  </div>
                  {signalsNext && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={older !== null}
                      onClick={() => void loadOlder('signal')}
                    >
                      {older === 'signal' ? '正在加载…' : '加载更早信号'}
                    </Button>
                  )}
                </section>
              </HistoryTab>
              <HistoryTab value="overview">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {(points
                    ? [
                        [
                          '累计收益（点）',
                          number(summary.metrics.total_points),
                        ],
                        [
                          '已实现收益（点）',
                          number(summary.metrics.realized_points),
                        ],
                        ['已完成交易', number(summary.metrics.trade_count)],
                        ['胜率', percent(summary.metrics.win_rate)],
                        [
                          '最大回撤（点）',
                          number(summary.metrics.max_drawdown_points),
                        ],
                        [
                          '未实现收益（点）',
                          number(summary.metrics.unrealized_points),
                        ],
                        ['当前持仓', String(summary.open_trades.length)],
                        [
                          '平均每笔（点）',
                          number(summary.metrics.average_trade_points),
                        ],
                      ]
                    : [
                        ['累计收益', percent(summary.metrics.total_return)],
                        ['净收益', number(summary.metrics.total_pnl)],
                        ['已完成交易', number(summary.metrics.trade_count)],
                        ['胜率', percent(summary.metrics.win_rate)],
                        ['最大回撤', percent(summary.metrics.max_drawdown)],
                        ['账户权益', number(summary.metrics.final_equity)],
                        ['当前持仓', String(summary.open_trades.length)],
                        ['初始资金', number(summary.initial_cash)],
                      ]
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-1 text-lg font-semibold tabular-nums">
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">月度与年度收益</h3>
                  <PeriodReturns
                    points={points}
                    monthly={summary.monthly_returns}
                    yearly={summary.yearly_returns}
                  />
                </section>
              </HistoryTab>
            </>
          )}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
