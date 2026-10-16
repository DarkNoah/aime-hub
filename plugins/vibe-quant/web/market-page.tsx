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
  ArrowLeft,
  ChartCandlestick,
  Plus,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DURATIONS,
  KIND_LABELS,
  type Bar,
  type Instrument,
  type InstrumentKind,
  type OrderBook,
  type Quote,
  type SyncStatus,
  type WatchItem,
} from '../shared';
import { MarketChart } from './chart';
import { OrderBookPanel } from './order-book';

const ENGINE_NAMES = { tqsdk: 'TqSdk', tushare: 'Tushare', tdx: '通达信' };
const STATE_LABELS = {
  starting: '连接中',
  syncing: '同步中',
  closed: '休市',
  idle: '待订阅',
  error: '同步异常',
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
    : '尚未写入';

export function MarketPage({ pluginId }: PluginPageProps) {
  const [list, setList] = useState<WatchItem[]>([]);
  const [selected, setSelected] = useState('');
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orderBooks, setOrderBooks] = useState<OrderBook[]>([]);
  const [status, setStatus] = useState<SyncStatus>();
  const [error, setError] = useState('');
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
  const [duration, setDuration] = useState<number>(60);
  const [bars, setBars] = useState<Bar[]>([]);
  const [barsIdentity, setBarsIdentity] = useState('');
  const [barsError, setBarsError] = useState('');
  const [barsLoading, setBarsLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [hasOlder, setHasOlder] = useState(true);
  const identity = `${status?.engine ?? ''}:${selected}:${duration}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
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
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) setError('行情连接中断，正在重试');
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
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setBars([]);
    setHasOlder(true);
    setBarsError('');
    setOlderLoading(false);
    if (!selected) return;
    setBarsLoading(true);
    async function poll() {
      try {
        const data = await pluginRequest<Bar[]>(
          pluginId,
          `/bars?symbol=${encodeURIComponent(selected)}&duration=${duration}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setBars((current) =>
            [
              ...new Map(
                [...current, ...data].map((bar) => [bar.time, bar]),
              ).values(),
            ].sort((a, b) => a.time - b.time),
          );
          setBarsIdentity(identity);
          setBarsError('');
        }
      } catch {
        if (!controller.signal.aborted) setBarsError('K 线读取失败，正在重试');
      }
      if (!controller.signal.aborted) {
        setBarsLoading(false);
        timer = setTimeout(() => void poll(), document.hidden ? 10000 : 3000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pluginId, selected, duration, status?.engine, retry]);
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
  async function loadOlder() {
    if (olderLoading || !bars.length) return;
    setOlderLoading(true);
    const key = identity;
    try {
      const data = await pluginRequest<Bar[]>(
        pluginId,
        `/bars?symbol=${encodeURIComponent(selected)}&duration=${duration}&before=${bars[0].time}`,
      );
      if (identityRef.current !== key) return;
      setBars((current) =>
        [
          ...new Map(
            [...data, ...current].map((bar) => [bar.time, bar]),
          ).values(),
        ].sort((a, b) => a.time - b.time),
      );
      setHasOlder(data.length === 1000);
    } catch {
      toast.error('读取历史行情失败');
    } finally {
      if (identityRef.current === key) setOlderLoading(false);
    }
  }
  const item = list.find((entry) => entry.symbol === selected);
  const currentQuote = quotes.find((entry) => entry.symbol === selected);
  const delta = change(currentQuote);
  const deltaColor =
    delta == null || delta === 0
      ? 'text-muted-foreground'
      : delta > 0
        ? 'text-red-600 dark:text-red-400'
        : 'text-emerald-700 dark:text-emerald-400';
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
        <div className="flex items-center gap-2">
          <Badge variant="outline">
            {status ? ENGINE_NAMES[status.engine] : '连接引擎'}
          </Badge>
          <Badge
            variant={
              status?.state === 'error' || error ? 'destructive' : 'secondary'
            }
          >
            <Activity className="mr-1 size-3" />
            {error
              ? '连接异常'
              : status
                ? STATE_LABELS[status.state]
                : '连接中'}
          </Badge>
        </div>
      </header>
      {(error || listError) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          <span>{listError || error}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRetry((value) => value + 1)}
          >
            重新连接
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
                return (
                  <button
                    key={entry.symbol}
                    aria-pressed={selected === entry.symbol}
                    onClick={() => setSelected(entry.symbol)}
                    className={`flex w-full items-center justify-between gap-3 border-b px-4 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selected === entry.symbol ? 'bg-accent' : 'hover:bg-muted/60'}`}
                  >
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
                    <span className="shrink-0 text-right tabular-nums">
                      <span className="block text-sm">{price(q?.last)}</span>
                      <span
                        className={`mt-1 block text-xs ${d == null || d === 0 ? 'text-muted-foreground' : d > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'}`}
                      >
                        {d == null
                          ? '等待行情'
                          : `${d > 0 ? '+' : ''}${d.toFixed(2)}%`}
                      </span>
                    </span>
                  </button>
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
        <section className="min-w-0">
          {item ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4 border-b p-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{item.name}</h2>
                    <Badge variant="outline">{KIND_LABELS[item.kind]}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.symbol}
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline gap-3">
                    <span
                      className={`text-3xl font-semibold tabular-nums ${deltaColor}`}
                    >
                      {price(currentQuote?.last)}
                    </span>
                    <span className={`text-sm tabular-nums ${deltaColor}`}>
                      {delta == null
                        ? '等待首次报价'
                        : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`}
                    </span>
                  </div>
                  {currentQuote?.underlying && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      当前标的：{currentQuote.underlying}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={item.enabled}
                      disabled={!!busy}
                      onCheckedChange={(enabled) =>
                        void mutate(item.symbol, 'toggle', enabled)
                      }
                      aria-label="自动同步"
                    />
                    自动同步
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`移除 ${item.name} 自选`}
                    disabled={!!busy}
                    onClick={() => void mutate(item.symbol, 'delete')}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <dl className="grid grid-cols-3 gap-x-5 gap-y-3 border-b px-5 py-3 text-xs sm:grid-cols-6">
                {[
                  ['今开', price(currentQuote?.open)],
                  ['最高', price(currentQuote?.high)],
                  ['最低', price(currentQuote?.low)],
                  ['昨收', price(currentQuote?.preClose)],
                  ['成交量', quantity(currentQuote?.volume)],
                  ['持仓量', quantity(currentQuote?.openInterest)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="mt-1 font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <div className="flex flex-wrap gap-1" aria-label="K 线周期">
                  {DURATIONS.map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      variant={duration === value ? 'secondary' : 'ghost'}
                      aria-pressed={duration === value}
                      onClick={() => setDuration(value)}
                    >
                      {value === 86400 ? '日线' : `${value / 60}分`}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!hasOlder || !bars.length || olderLoading}
                  onClick={() => void loadOlder()}
                >
                  <ArrowLeft className="mr-1 size-3" />
                  {olderLoading ? '加载中' : hasOlder ? '更早行情' : '已到最早'}
                </Button>
              </div>
              <div className="relative min-w-0">
                <MarketChart
                  bars={barsIdentity === identity ? bars : []}
                  identity={identity}
                  priceTick={item.priceTick}
                />
                {!bars.length && (
                  <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
                    <div className="max-w-sm rounded-lg bg-card/95 p-5">
                      <ChartCandlestick className="mx-auto mb-3 size-8 text-muted-foreground" />
                      <p className="text-sm font-medium">
                        {barsLoading
                          ? '正在读取 K 线…'
                          : barsError || '等待行情写入'}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-muted-foreground">
                        {status?.state === 'error'
                          ? status.message
                          : '首次订阅需要加载历史数据。请确认当前引擎具备此标的行情权限。'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {barsError && !!bars.length && (
                <p role="alert" className="px-5 py-2 text-xs text-destructive">
                  {barsError}，当前显示上次成功读取的数据。
                </p>
              )}
            </>
          ) : (
            <div className="flex min-h-[500px] items-center justify-center p-8 text-center">
              <div className="max-w-md">
                <ChartCandlestick className="mx-auto mb-5 size-10 text-primary/70" />
                <h2 className="text-lg font-medium">从关注的标的开始</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  添加自选后，行情和 K
                  线会自动同步并持续保存。切换不同周期，查看价格与成交量。
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
          <OrderBookPanel
            book={orderBooks.find((book) => book.symbol === selected)}
            symbol={selected}
            priceTick={item.priceTick}
          />
        )}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {status?.message ?? '正在连接同步服务'} · 最近入库{' '}
          {timeText(status?.lastWriteAt)}
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
