import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
} from '@app/plugin-ui';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Database,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ProductSyncContract,
  ProductSyncOverview,
} from '../../product-sync-types';
import { useMarketSearch } from '../use-market-search';
import { barLabelTime } from '../chart-time';

type Overview = ProductSyncOverview & { writable: boolean };

const minuteLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const minuteTime = (seconds: number) =>
  minuteLabel.format(barLabelTime(seconds, 60) * 1000);

function ContractChoice({
  item,
  covered,
  pending,
  onSelect,
}: {
  item: ProductSyncContract;
  covered: boolean;
  pending?: boolean;
  onSelect: (key: string, selected: boolean) => Promise<void>;
}) {
  const checked = pending ?? item.selected;
  const active = !item.expired && (checked || covered);
  const last = item.lastBarAt ? minuteTime(item.lastBarAt) : '';
  const first = item.firstBarAt ? minuteTime(item.firstBarAt) : '';
  let status = item.ready ? '已就绪' : active ? '待入库' : '';
  if (item.outcome === 'empty')
    status = active ? '暂无 K 线 · 待重试' : '暂无 K 线';
  if (item.outcome === 'error')
    status = active ? '采集失败 · 待重试' : '上次采集失败';
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-accent">
      <Checkbox
        checked={checked}
        disabled={pending !== undefined || (item.expired && !item.selected)}
        aria-label={`单独同步 ${item.symbol}`}
        onCheckedChange={(value) => void onSelect(item.symbol, value === true)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
        <span className="truncate font-mono">{item.symbol}</span>
        {item.name && item.name !== item.symbol && (
          <span className="truncate text-muted-foreground">{item.name}</span>
        )}
        {last && (
          <span
            className="text-[11px] tabular-nums text-muted-foreground"
            title={`本地分钟线（北京时间） ${first || '—'} 至 ${last}`}
          >
            分钟线截至 {last.slice(5)}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        {item.expired ? (
          <Badge variant="outline">已到期</Badge>
        ) : (
          covered && !checked && <Badge variant="outline">品种已覆盖</Badge>
        )}
        {status && (
          <Badge
            variant={item.outcome === 'error' ? 'destructive' : 'secondary'}
          >
            {status}
          </Badge>
        )}
      </span>
    </label>
  );
}

export function ProductSyncPicker({ pluginId }: { pluginId: string }) {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<Overview>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [productKey, setProductKey] = useState('');
  const [contractQuery, setContractQuery] = useState('');
  const [pending, setPending] = useState(() => new Map<string, boolean>());
  const mutations = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  const contracts = useMarketSearch<ProductSyncContract>(
    pluginId,
    open && productKey
      ? `/product-sync/contracts?product=${encodeURIComponent(productKey)}&q=${encodeURIComponent(contractQuery.trim())}`
      : null,
    15000,
  );

  useEffect(() => {
    const requests = mutations.current;
    return () => {
      for (const controller of requests.values()) controller.abort();
      requests.clear();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const before = generation.current;
      try {
        const data = await pluginRequest<Overview>(pluginId, '/product-sync', {
          signal: controller.signal,
        });
        if (
          !controller.signal.aborted &&
          before === generation.current &&
          mutations.current.size === 0
        ) {
          setOverview(data);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted)
        timer = setTimeout(() => void poll(), document.hidden ? 60000 : 15000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pluginId, revision]);

  async function save(key: string, selected: boolean) {
    if (mutations.current.has(key)) return;
    const controller = new AbortController();
    mutations.current.set(key, controller);
    generation.current++;
    setPending((current) => new Map(current).set(key, selected));
    try {
      await pluginRequest(pluginId, '/product-sync', {
        method: 'PUT',
        body: JSON.stringify({ key, selected }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      contracts.updateItems((items) =>
        items.map((item) =>
          item.symbol === key ? { ...item, selected } : item,
        ),
      );
      setOverview(
        (current) =>
          current && {
            ...current,
            options: current.options.map((item) =>
              item.key === key ? { ...item, selected } : item,
            ),
          },
      );
      toast.success(`${selected ? '已勾选' : '已取消勾选'} ${key}`);
    } catch {
      if (!controller.signal.aborted) toast.error('同步选择保存失败，请重试');
    } finally {
      if (!controller.signal.aborted) {
        generation.current++;
        mutations.current.delete(key);
        setPending((current) => {
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        if (!mutations.current.size) setRevision((value) => value + 1);
      }
    }
  }

  const options = overview?.options ?? [];
  const product = options.find((item) => item.key === productKey);
  const filtered = options.filter((item) =>
    item.key.toUpperCase().includes(query.trim().toUpperCase()),
  );
  const status =
    overview &&
    (overview.matched > 0 ||
      overview.selectedContracts > 0 ||
      options.some((item) => item.selected));
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setQuery('');
          setProductKey('');
          setContractQuery('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="自动同步品种"
        >
          <Database className="size-3.5 text-muted-foreground" />
          自动同步品种
          {status && (
            <Badge
              variant="secondary"
              className="px-1.5 tabular-nums"
              title="已就绪合约 / 匹配合约"
            >
              已就绪 {overview.ready}/{overview.matched}
            </Badge>
          )}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="自动同步品种"
        className="w-96 max-w-[calc(100vw-1.5rem)] space-y-2 p-3"
      >
        {productKey ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="返回品种列表"
              onClick={() => setProductKey('')}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="font-mono text-sm font-medium">{productKey}</span>
            <span className="text-xs text-muted-foreground">
              同步所选合约的 1 分钟 K 线
            </span>
          </div>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            勾选品种可同步全部挂牌合约的 1 分钟 K 线，展开可单独选择合约。
          </p>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label={productKey ? '搜索合约' : '搜索品种'}
            className="h-9 pl-8"
            value={productKey ? contractQuery : query}
            placeholder={
              productKey ? '搜索合约代码或名称' : '搜索交易所或品种代码'
            }
            onChange={(event) =>
              (productKey ? setContractQuery : setQuery)(event.target.value)
            }
          />
        </div>
        {failed && (
          <div
            role="alert"
            className="flex items-center justify-between text-xs text-destructive"
          >
            品种同步状态读取失败
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRevision((value) => value + 1)}
            >
              重试
            </Button>
          </div>
        )}
        <ScrollArea
          key={productKey}
          viewportProps={{ className: 'max-h-[min(50dvh,22rem)]' }}
        >
          <div className="pr-2">
            {productKey ? (
              <>
                {contracts.items.map((item) => (
                  <ContractChoice
                    key={item.symbol}
                    item={item}
                    covered={!!product?.selected}
                    pending={pending.get(item.symbol)}
                    onSelect={save}
                  />
                ))}
                {contracts.loading && (
                  <p className="p-3 text-xs text-muted-foreground">
                    正在读取合约…
                  </p>
                )}
                {contracts.error && (
                  <p role="alert" className="p-2 text-xs text-destructive">
                    合约读取失败
                  </p>
                )}
                {!contracts.loading &&
                  !contracts.error &&
                  !contracts.items.length && (
                    <p className="p-3 text-xs text-muted-foreground">
                      没有匹配的合约
                    </p>
                  )}
                {(contracts.nextCursor || contracts.error) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={contracts.loadingMore}
                    onClick={() =>
                      contracts.nextCursor
                        ? void contracts.loadMore()
                        : contracts.retry()
                    }
                  >
                    {contracts.error
                      ? '重试'
                      : contracts.loadingMore
                        ? '加载中…'
                        : '加载更多合约'}
                  </Button>
                )}
              </>
            ) : (
              <>
                {filtered.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center gap-1 rounded-md px-2 hover:bg-accent"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2">
                      <Checkbox
                        checked={pending.get(item.key) ?? item.selected}
                        disabled={
                          pending.has(item.key) ||
                          (!item.total && !item.selected)
                        }
                        aria-label={`同步品种 ${item.key}`}
                        onCheckedChange={(checked) =>
                          void save(item.key, checked === true)
                        }
                      />
                      <span className="min-w-0 truncate font-mono text-xs">
                        {item.key}
                      </span>
                    </label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {item.selectedContracts > 0
                        ? `单选 ${item.selectedContracts} · `
                        : ''}
                      {item.total} 合约
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`查看 ${item.key} 合约`}
                      onClick={() => {
                        setProductKey(item.key);
                        setContractQuery('');
                      }}
                    >
                      <ChevronRight className="size-4" />
                    </Button>
                  </div>
                ))}
                {!filtered.length && !failed && (
                  <p className="p-3 text-xs text-muted-foreground">
                    {!overview
                      ? '正在读取品种…'
                      : options.length
                        ? '没有匹配的品种'
                        : '等待行情引擎加载合约目录…'}
                  </p>
                )}
              </>
            )}
          </div>
        </ScrollArea>
        {overview?.writable === false && (
          <p className="border-t pt-2 text-xs text-muted-foreground">
            本实例只读，所选行情由连接同库的写入实例同步。
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
