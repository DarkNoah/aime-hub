import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Skeleton,
} from '@app/plugin-ui';
import { Loader2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { MarketStrategyHint } from '../../signal-types';
import type { BacktestRun } from '../../strategy-types';
import { durationLabel } from '../../shared';
import { ResultView } from '../strategies/result-view';
import { dateTime, errorText } from '../strategies/format';

interface HistoryPage {
  runs: BacktestRun[];
  next: string | null;
  canRun: boolean;
}
const statusLabels: Record<BacktestRun['status'], string> = {
  queued: '排队中',
  preparing: '准备中',
  running: '计算中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const active = (run: BacktestRun) =>
  ['queued', 'preparing', 'running'].includes(run.status);
const merge = (fresh: BacktestRun[], old: BacktestRun[]) => [
  ...fresh,
  ...old.filter((row) => !fresh.some((value) => value.id === row.id)),
];
const shortDate = (value: number) =>
  new Date(value * 1000).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
  });

export function HintPerformance({
  pluginId,
  item,
  onClose,
}: {
  pluginId: string;
  item: MarketStrategyHint;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [selected, setSelected] = useState('');
  const [months, setMonths] = useState('12');
  const [next, setNext] = useState<string | null>(null);
  const [canRun, setCanRun] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const paginated = useRef(false);
  const lifecycle = useRef<AbortController | null>(null);
  const run = runs.find((value) => value.id === selected);
  const pending = runs.some(active);
  const path = `/strategies/monitors/${item.id}/history`;
  useEffect(() => {
    const abort = new AbortController();
    lifecycle.current = abort;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const page = await pluginRequest<HistoryPage>(pluginId, path, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setRuns((old) => merge(page.runs, old));
        setSelected(
          (old) =>
            old ||
            page.runs.find((row) => row.status === 'completed')?.id ||
            page.runs[0]?.id ||
            '',
        );
        if (!paginated.current) setNext(page.next);
        setCanRun(page.canRun);
        setLoaded(true);
        setError('');
      } catch (error) {
        if (!abort.signal.aborted) {
          setError(errorText(error));
          setLoaded(true);
        }
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, path, retry]);
  async function calculate() {
    if (busy || pending) return;
    setBusy(true);
    try {
      const created = await pluginRequest<BacktestRun>(pluginId, path, {
        method: 'POST',
        body: JSON.stringify({ months: Number(months) }),
      });
      if (lifecycle.current?.signal.aborted) return;
      setRuns((old) => merge([created], old));
      setSelected(created.id);
      setError('');
      toast.success('已开始计算历史表现，完成后自动显示结果');
    } catch (error) {
      setError(errorText(error));
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!run || busy) return;
    setBusy(true);
    try {
      const updated = await pluginRequest<BacktestRun>(
        pluginId,
        `/strategies/runs/${run.id}/cancel`,
        { method: 'POST' },
      );
      setRuns((old) =>
        old.map((row) => (row.id === updated.id ? updated : row)),
      );
      toast.success('已请求取消计算');
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function loadOlder() {
    if (!next || older) return;
    setOlder(true);
    try {
      const page = await pluginRequest<HistoryPage>(
        pluginId,
        `${path}?before=${encodeURIComponent(next)}`,
        { signal: lifecycle.current?.signal },
      );
      paginated.current = true;
      setNext(page.next);
      setRuns((old) => merge(old, page.runs));
      setSelected((old) => old || page.runs[0]?.id || '');
    } catch (error) {
      if (!lifecycle.current?.signal.aborted) toast.error(errorText(error));
    } finally {
      setOlder(false);
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent className="w-full sm:max-w-5xl gap-0 p-0">
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle>{item.strategy_name} · 历史表现</SheetTitle>
          <SheetDescription>
            {item.config.symbol} · v{item.version_number} ·{' '}
            {durationLabel(item.config.duration)}
            。展示对应版本与参数的历史回测，费用与资金按所选回测记录。
          </SheetDescription>
        </SheetHeader>
        <ScrollArea
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          viewportProps={{ className: 'min-h-0 flex-1 [&>div]:block!' }}
        >
          <div className="space-y-3 border-b p-4 sm:p-5">
            <div className="flex flex-wrap items-end gap-3">
              <Label className="grid min-w-0 flex-1 basis-64 grid-cols-1 gap-2 text-xs">
                回测记录
                <Select
                  value={selected}
                  onValueChange={setSelected}
                  disabled={!runs.length}
                >
                  <SelectTrigger
                    className="w-full min-w-0"
                    aria-label="选择历史回测"
                  >
                    <SelectValue
                      className="min-w-0 truncate"
                      placeholder={loaded ? '暂无匹配的历史回测' : '正在加载…'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((row) => (
                      <SelectItem key={row.id} value={row.id}>
                        {shortDate(row.config.start)} —{' '}
                        {shortDate(row.config.end)} · {statusLabels[row.status]}{' '}
                        · {shortDate(Date.parse(row.created_at) / 1000)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Label>
              <Label className="grid gap-2 text-xs">
                计算区间
                <Select
                  value={months}
                  onValueChange={setMonths}
                  disabled={busy || pending}
                >
                  <SelectTrigger className="w-28" aria-label="历史计算区间">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">近 3 个月</SelectItem>
                    <SelectItem value="12">近 1 年</SelectItem>
                    <SelectItem value="36">近 3 年</SelectItem>
                  </SelectContent>
                </Select>
              </Label>
              <Button
                disabled={!canRun || busy || pending}
                onClick={() => void calculate()}
              >
                {busy || pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                {pending ? '正在计算' : '计算历史表现'}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="刷新历史表现"
                onClick={() => setRetry((n) => n + 1)}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {next && (
              <Button
                variant="ghost"
                size="sm"
                disabled={older}
                onClick={() => void loadOlder()}
              >
                {older ? '正在加载…' : '加载更早回测'}
              </Button>
            )}
            {loaded && !canRun && (
              <p className="text-xs text-muted-foreground">
                可以查看已有结果；新建历史计算需要管理员权限。
              </p>
            )}
            {run && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant={run.status === 'failed' ? 'destructive' : 'outline'}
                >
                  {statusLabels[run.status]}
                </Badge>
                <span>
                  回测区间：{dateTime(run.config.start)} —{' '}
                  {dateTime(run.config.end)}
                </span>
                {active(run) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || run.cancel_requested}
                    onClick={() => void cancel()}
                  >
                    {run.cancel_requested ? '取消中…' : '取消计算'}
                  </Button>
                )}
              </div>
            )}
          </div>
          {!loaded ? (
            <Skeleton className="m-5 h-48" />
          ) : run ? (
            <ResultView key={run.id} pluginId={pluginId} run={run} />
          ) : (
            <div className="space-y-2 p-8 text-center text-sm text-muted-foreground">
              <p>还没有该标的、版本、周期和参数的历史回测。</p>
              <p>选择计算区间，即可生成交易记录、胜率与月度／年度收益。</p>
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
