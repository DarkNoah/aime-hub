import { useEffect, useRef, useState } from 'react';
import { pluginRequest, type PluginPageProps } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Switch,
} from '@app/plugin-ui';
import {
  Activity,
  ChartCandlestick,
  Plus,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  KIND_LABELS,
  type Instrument,
  type InstrumentKind,
  type OrderBook,
  type Quote,
  type SyncStatus,
  type WatchItem,
} from '../shared';
import { MarketChartPanel } from './components/market-chart-panel';
import { useMarketBars } from './use-market-bars';
import { readChartPeriod } from './chart-period';
import { OrderBookPanel } from './order-book';
import { useStrategyHints } from './signals/use-strategy-hints';
import { StrategyHints } from './signals/strategy-hints';

const ENGINE_NAMES = { tqsdk: 'TqSdk', tushare: 'Tushare', tdx: '通达信' };
const STATE_LABELS = {
  starting: '连接中',
  syncing: '同步中',
  closed: '休市',
  idle: '待订阅',
  error: '连接中',
  standby: '待命',
};
const price = (value?: number | null) =>
  value == null
    ? '—'
    : value.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      });
const quantity = (value?: number | null) =>
  value == null
    ? '—'
    : Intl.NumberFormat('zh-CN', {
        notation: 'compact',
        maximumFractionDigits: 2,
      }).format(value);
const change = (quote?: Quote) =>
  quote?.last != null && quote.preClose
    ? (quote.last / quote.preClose - 1) * 100
    : null;
const errorText = (error: unknown) =>
  error instanceof Error && error.message === 'SUBSCRIPTION_LIMIT'
    ? '已达到合并订阅上限，请调整插件参数或暂停其他订阅'
    : error instanceof Error && error.message === 'UNSUPPORTED_INSTRUMENT'
      ? '当前数据引擎不支持此标的，请切换引擎'
      : '操作失败，请检查连接与插件状态后重试';
const timeText = (value?: string | null) =>
  value
    ? new Date(value).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      })
    : '暂无';

export function MarketPage({ pluginId }: PluginPageProps) {
  const [list, setList] = useState<WatchItem[]>([]);
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get('symbol') ?? '',
  );
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orderBooks, setOrderBooks] = useState<OrderBook[]>([]);
  const [status, setStatus] = useState<SyncStatus>();
  const [reconnecting, setReconnecting] = useState(false);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<InstrumentKind | 'all'>('all');
  const [results, setResults] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [period, setPeriod] = useState(readChartPeriod);
  const isIntraday = period === 'intraday';
  const duration = isIntraday ? 60 : period;
  const identity = `${status?.engine ?? ''}:${selected}:${period}`;
  const marketBars = useMarketBars({
    pluginId,
    symbol: selected,
    duration,
    intraday: isIntraday,
    identity,
    retry,
  });
  const hints = useStrategyHints(
    pluginId,
    selected,
    status?.engine,
    marketBars.bars[0]?.time,
    marketBars.bars.length
      ? marketBars.bars.at(-1)!.time + duration
      : undefined,
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void pluginRequest<WatchItem[]>(pluginId, '/watchlist', {
      signal: controller.signal,
    })
      .then((items) => {
        setList(items);
        setSelected((current) =>
          items.some((item) => item.symbol === current)
            ? current
            : (items[0]?.symbol ?? ''),
        );
        setListError('');
      })
      .catch(() => {
        if (!controller.signal.aborted) setListError('无法读取自选列表');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [pluginId, retry]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await pluginRequest<{
          status: SyncStatus;
          quotes: Quote[];
          orderBooks: OrderBook[];
        }>(pluginId, '/snapshot', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setQuotes(data.quotes);
          setOrderBooks(data.orderBooks ?? []);
          setStatus(data.status);
          setReconnecting(false);
        }
      } catch {
        if (!controller.signal.aborted) setReconnecting(true);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), document.hidden ? 10000 : 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pluginId, retry]);
  useEffect(() => {
    if (!searchOpen) return;
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void pluginRequest<Instrument[]>(
        pluginId,
        `/instruments?q=${encodeURIComponent(query)}&kind=${kind}`,
        { signal: controller.signal },
      )
        .then((items) => {
          setResults(items);
          setSearchError('');
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearchError('搜索失败，请重试');
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pluginId, query, kind, searchOpen, retry]);
  async function mutate(
    symbol: string,
    action: 'add' | 'delete' | 'toggle',
    enabled?: boolean,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(symbol);
    try {
      if (action === 'add') {
        const item = await pluginRequest<WatchItem>(pluginId, '/watchlist', {
          method: 'POST',
          body: JSON.stringify({ symbol }),
        });
        setList((current) =>
          current.some((entry) => entry.symbol === symbol)
            ? current.map((entry) => (entry.symbol === symbol ? item : entry))
            : [...current, item],
        );
        setSelected(symbol);
        setSearchOpen(false);
        toast.success('已加入自选，自动同步已开启');
      } else if (action === 'delete') {
        await pluginRequest(
          pluginId,
          `/watchlist/${encodeURIComponent(symbol)}`,
          { method: 'DELETE' },
        );
        const next = list.filter((entry) => entry.symbol !== symbol);
        setList(next);
        if (selected === symbol) setSelected(next[0]?.symbol ?? '');
        toast.success('已移除自选');
      } else {
        await pluginRequest(
          pluginId,
          `/watchlist/${encodeURIComponent(symbol)}`,
          { method: 'PATCH', body: JSON.stringify({ enabled }) },
        );
        setList((current) =>
          current.map((entry) =>
            entry.symbol === symbol ? { ...entry, enabled: !!enabled } : entry,
          ),
        );
        toast.success(enabled ? '已开启自动同步' : '已暂停此自选的自动同步');
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }
  const item = list.find((entry) => entry.symbol === selected);
  const currentQuote = quotes.find((entry) => entry.symbol === selected);
  return (
    <div className="space-y-4" data-page-width="full">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <ChartCandlestick className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">
              量化行情{' '}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                Vibe Quant
              </span>
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              自选驱动同步 · 中国标准时间 UTC+8
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {status ? ENGINE_NAMES[status.engine] : '连接引擎'}
          </Badge>
          {status?.clickhouseReadOnly && (
            <Badge variant="outline">行情不落库</Badge>
          )}
          <Badge variant="secondary">
            <Activity className="mr-1 size-3" />
            {reconnecting
              ? '连接中'
              : status
                ? STATE_LABELS[status.state]
                : '连接中'}
          </Badge>
        </div>
      </header>
      {listError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <span>{listError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      )}
      <div
        className={`grid min-w-0 overflow-hidden rounded-xl border bg-card lg:grid-cols-[280px_minmax(0,1fr)] ${item ? 'xl:grid-cols-[280px_minmax(0,1fr)_240px]' : ''}`}
      >
        <aside className="min-w-0 border-b lg:border-r lg:border-b-0">
          <div className="border-b p-4">
            <Button
              variant="outline"
              className="w-full justify-start text-muted-foreground"
              onClick={() => setSearchOpen(true)}
            >
              <Search className="mr-2 size-4" />
              搜索代码或名称
              <Plus className="ml-auto size-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Star className="size-4 text-primary" />
              我的自选
            </h2>
            <Badge variant="secondary">{list.length}</Badge>
          </div>
          <ScrollArea className="h-[220px] lg:h-[586px]">
            {loading ? (
              <p className="p-4 text-sm text-muted-foreground" role="status">
                正在读取自选…
              </p>
            ) : list.length ? (
              list.map((entry) => {
                const q = quotes.find((value) => value.symbol === entry.symbol);
                const d = change(q);
                const underlying = q?.underlying || entry.underlying;
                const isSelected = selected === entry.symbol;
                const changeColor =
                  d == null || d === 0
                    ? 'text-muted-foreground'
                    : d > 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-emerald-700 dark:text-emerald-400';
                return (
                  <div
                    key={entry.symbol}
                    className={`border-b ${isSelected ? 'bg-accent' : ''}`}
                  >
                    <button
                      aria-pressed={isSelected}
                      onClick={() => setSelected(entry.symbol)}
                      className={`w-full px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${isSelected ? '' : 'hover:bg-muted/60'}`}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {entry.name}
                          </span>
                          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                            {entry.symbol}
                          </span>
                          <span className="mt-1 block text-[11px] text-muted-foreground">
                            {KIND_LABELS[entry.kind]}
                            {!entry.enabled && ' · 已暂停'}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-right tabular-nums ${changeColor}`}
                        >
                          <span className="block text-sm">
                            {price(q?.last)}
                          </span>
                          <span className="mt-1 block text-xs">
                            {d == null
                              ? '等待行情'
                              : `${d > 0 ? '+' : ''}${d.toFixed(2)}%`}
                          </span>
                        </span>
                      </span>
                      {underlying && (
                        <span className="mt-2 block break-all text-[11px] text-muted-foreground">
                          当前标的：
                          <span className="font-mono">{underlying}</span>
                        </span>
                      )}
                    </button>
                    {isSelected && (
                      <div className="flex items-center justify-between gap-3 px-4 pb-3">
                        <label className="flex items-center gap-2 text-xs">
                          <Switch
                            checked={entry.enabled}
                            disabled={!!busy}
                            onCheckedChange={(enabled) =>
                              void mutate(entry.symbol, 'toggle', enabled)
                            }
                            aria-label={`${entry.name} 自动同步`}
                          />
                          自动同步
                        </label>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`移除 ${entry.name} 自选`}
                          disabled={!!busy}
                          onClick={() => void mutate(entry.symbol, 'delete')}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="space-y-3 px-5 py-10 text-center">
                <p className="text-sm font-medium">添加第一个自选</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  搜索 000852、IM2610、MO 或 IM主连。加入后自动开始同步。
                </p>
                <Button size="sm" onClick={() => setSearchOpen(true)}>
                  <Plus className="mr-1 size-4" />
                  添加自选
                </Button>
              </div>
            )}
          </ScrollArea>
        </aside>
        <section className="flex min-w-0 flex-col">
          {item ? (
            <>
              <MarketChartPanel
                toolbarActions={
                  <StrategyHints
                    key={`${status?.engine}:${selected}`}
                    pluginId={pluginId}
                    instrument={item}
                    hints={hints}
                    onJumpToEntry={marketBars.navigate}
                  />
                }
                strategyHints={hints.items}
                view={marketBars}
                identity={identity}
                drawingSharedScope={`${status?.engine ?? ''}:${selected}`}
                period={period}
                onPeriodChange={setPeriod}
                priceTick={item.priceTick}
                volumeProfileSource={{
                  pluginId,
                  path: `/volume-profile?symbol=${encodeURIComponent(selected)}`,
                }}
              />
            </>
          ) : (
            <div className="flex min-h-[500px] flex-1 items-center justify-center p-8 text-center">
              <div className="max-w-md">
                <ChartCandlestick className="mx-auto mb-5 size-10 text-primary/70" />
                <h2 className="text-lg font-medium">从关注的标的开始</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {status?.clickhouseReadOnly
                    ? '添加自选后，查询历史数据并展示实时行情。实时数据不写入 ClickHouse。'
                    : '添加自选后，行情和 K 线会自动同步并持续保存。'}
                  切换不同周期，查看价格与成交量。
                </p>
                <Button className="mt-5" onClick={() => setSearchOpen(true)}>
                  <Search className="mr-2 size-4" />
                  搜索行情
                </Button>
              </div>
            </div>
          )}
        </section>
        {item && (
          <aside
            aria-label="行情概览与盘口"
            className="min-w-0 border-t lg:col-span-2 xl:col-span-1 xl:border-t-0 xl:border-l"
          >
            <dl
              aria-label="行情概览"
              className="grid grid-cols-2 gap-x-4 gap-y-4 border-b p-4 text-xs sm:grid-cols-3 xl:grid-cols-2"
            >
              {[
                ['今开', price(currentQuote?.open)],
                ['最高', price(currentQuote?.high)],
                ['最低', price(currentQuote?.low)],
                ['昨收', price(currentQuote?.preClose)],
                ['成交量', quantity(currentQuote?.volume)],
                ['持仓量', quantity(currentQuote?.openInterest)],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="mt-1 break-all font-medium tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <OrderBookPanel
              book={orderBooks.find((book) => book.symbol === selected)}
              symbol={selected}
              priceTick={item.priceTick}
            />
          </aside>
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {reconnecting || status?.state === 'error'
            ? '正在连接同步服务'
            : (status?.message ?? '正在连接同步服务')}{' '}
          · {status?.clickhouseReadOnly ? '最近接收' : '最近入库'}{' '}
          {timeText(
            status?.clickhouseReadOnly
              ? status.lastReceivedAt
              : status?.lastWriteAt,
          )}
        </span>
        <span>
          开市前 {status?.beforeOpenMinutes ?? '—'} 分钟 / 休市后{' '}
          {status?.afterCloseMinutes ?? '—'} 分钟 ·{' '}
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            TradingView
          </a>
        </span>
      </footer>
      <Dialog open={searchOpen} onOpenChange={setSearchOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>搜索行情</DialogTitle>
            <DialogDescription>
              选择准确的交易所与合约类型，加入自选后自动同步。
              {status?.engine &&
                status.engine !== 'tqsdk' &&
                '当前引擎支持沪深股票与指数。'}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute top-3 left-3 size-4 text-muted-foreground" />
            <Input
              autoFocus
              aria-label="股票或合约代码"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="000852 / IM2610 / MOxxx / IM主连"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1" aria-label="行情分类">
            {(['all', 'stock', 'future', 'option', 'continuous'] as const).map(
              (value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={kind === value ? 'secondary' : 'ghost'}
                  aria-pressed={kind === value}
                  onClick={() => setKind(value)}
                >
                  {value === 'all' ? '全部' : KIND_LABELS[value]}
                </Button>
              ),
            )}
          </div>
          <ScrollArea className="h-[340px]">
            {searching ? (
              <p
                role="status"
                className="p-6 text-center text-sm text-muted-foreground"
              >
                正在搜索…
              </p>
            ) : searchError ? (
              <div role="alert" className="p-6 text-center">
                <p className="text-sm text-destructive">{searchError}</p>
                <Button
                  variant="ghost"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  重试搜索
                </Button>
              </div>
            ) : results.length ? (
              results.map((entry) => (
                <div
                  key={entry.symbol}
                  className="flex items-center justify-between gap-3 border-b px-1 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{entry.name}</span>
                      <Badge variant="outline">{KIND_LABELS[entry.kind]}</Badge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {entry.symbol}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !!busy ||
                      list.some((item) => item.symbol === entry.symbol)
                    }
                    onClick={() => void mutate(entry.symbol, 'add')}
                  >
                    {busy === entry.symbol
                      ? '添加中…'
                      : list.some((item) => item.symbol === entry.symbol)
                        ? '已添加'
                        : '加入自选'}
                  </Button>
                </div>
              ))
            ) : (
              <div className="space-y-2 p-8 text-center">
                <p className="text-sm">没有匹配的标的</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {status?.catalogCount
                    ? '试试完整代码或切换分类。只有当前引擎支持的有效合约会显示。'
                    : '合约目录尚未就绪，请检查引擎配置、账号权限与连接状态。'}
                </p>
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
