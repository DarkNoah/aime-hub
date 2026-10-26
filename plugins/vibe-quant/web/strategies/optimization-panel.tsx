import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from '@app/plugin-ui';
import { ArrowUpRight, Plus, SlidersHorizontal, Square } from 'lucide-react';
import { toast } from 'sonner';
import {
  activeRun,
  RUN_LABELS,
  type BacktestInput,
  type BacktestRun,
  type StrategyDetail,
  type StrategySummary,
  type StrategyVersion,
} from '../../strategy-types';
import type { OptimizationReport } from '../../optimization-types';
import { dateTime, errorText } from './format';
import { OptimizationResult } from './optimization-result';
import { RunForm } from './run-form';

type Summary = {
  run: BacktestRun;
  optimization: OptimizationReport | null;
  draft: StrategyDetail | null;
};

export function OptimizationPanel({
  pluginId,
  strategy,
  versions,
  initial,
  canRun,
  onClose,
  onDraft,
  onOpenDraft,
}: {
  pluginId: string;
  strategy: StrategySummary;
  versions: StrategyVersion[];
  initial?: BacktestInput;
  canRun: boolean;
  onClose: () => void;
  onDraft: (draft: StrategyDetail) => void;
  onOpenDraft: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<BacktestRun[] | null>(null);
  const [selected, setSelected] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [form, setForm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const notify = useRef('');
  const onDraftRef = useRef(onDraft);
  useEffect(() => {
    onDraftRef.current = onDraft;
  }, [onDraft]);
  const job = jobs?.find((item) => item.id === selected);
  const result = summary?.run.id === selected ? summary : null;
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let first = true;
    async function poll() {
      try {
        const rows = await pluginRequest<BacktestRun[]>(
          pluginId,
          `/strategies/${strategy.id}/optimizations`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setJobs((old) => {
          const merged = new Map((old ?? []).map((item) => [item.id, item]));
          rows.forEach((item) => merged.set(item.id, item));
          return [...merged.values()].sort((a, b) =>
            b.created_at.localeCompare(a.created_at),
          );
        });
        if (first) {
          setMore(rows.length === 30);
          first = false;
        }
        setSelected((old) => old || rows[0]?.id || '');
        setError('');
      } catch (e) {
        if (!abort.signal.aborted) setError(errorText(e));
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, strategy.id, retry]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await pluginRequest<Summary>(
          pluginId,
          `/strategies/optimizations/${selected}/result`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        setSummary(next);
        if (next.draft) {
          onDraftRef.current(next.draft);
          if (notify.current === selected) {
            toast.success('调优完成，已创建新的策略草稿');
            notify.current = '';
          }
        }
        if (
          activeRun(next.run.status) ||
          (next.run.status === 'completed' && !next.draft)
        )
          timer = setTimeout(() => void poll(), 3000);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(errorText(e));
          timer = setTimeout(() => void poll(), 5000);
        }
      }
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, selected, retry]);

  async function action(operation: () => Promise<void>) {
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Sheet
        open={!form}
        onOpenChange={(open) => {
          if (!open && !form) onClose();
        }}
      >
        <SheetContent className="w-full gap-0 p-0 sm:max-w-3xl">
          <SheetHeader className="border-b p-5">
            <SheetTitle className="flex items-center gap-2">
              <SlidersHorizontal className="size-4" />
              调优参数
            </SheetTitle>
            <SheetDescription>
              {strategy.name} · 通过 Optuna
              搜索参数，成功后另存为未发布的策略草稿。
            </SheetDescription>
          </SheetHeader>
          <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
            <span className="text-xs text-muted-foreground">
              调优任务与普通回测独立管理
            </span>
            <Button
              size="sm"
              disabled={
                strategy.status !== 'active' ||
                !canRun ||
                !strategy.enabled ||
                !versions.length
              }
              onClick={() => setForm(true)}
            >
              <Plus className="size-4" />
              新建调优
            </Button>
          </div>
          <ScrollArea
            className="min-h-0 flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div className="space-y-5 p-5">
              {error && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 text-sm text-destructive"
                >
                  {error}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    重试
                  </Button>
                </div>
              )}
              {jobs === null ? (
                <Skeleton className="h-24" />
              ) : jobs.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {jobs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelected(item.id)}
                      aria-pressed={selected === item.id}
                      className={`rounded-md border p-3 text-left transition-colors ${selected === item.id ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/40'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm">
                          v{item.version_number} · {item.config.symbol}
                        </span>
                        <Badge
                          variant={
                            item.status === 'failed' ? 'destructive' : 'outline'
                          }
                        >
                          {item.status === 'running'
                            ? '调优中'
                            : RUN_LABELS[item.status]}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {dateTime(item.created_at)} ·{' '}
                        {item.config.optimization?.n_trials} 次试验
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed px-5 py-10 text-center">
                  <SlidersHorizontal className="mx-auto mb-3 size-7 text-muted-foreground" />
                  <p className="text-sm font-medium">为策略寻找一组候选参数</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    选择已发布版本，设置搜索范围与验证区间。完成后可打开新草稿，继续编辑或发布。
                  </p>
                </div>
              )}
              {more && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      const rows = await pluginRequest<BacktestRun[]>(
                        pluginId,
                        `/strategies/${strategy.id}/optimizations?before=${jobs!.at(-1)!.id}`,
                      );
                      setJobs((old) => [
                        ...(old ?? []),
                        ...rows.filter(
                          (item) => !old?.some((v) => v.id === item.id),
                        ),
                      ]);
                      setMore(rows.length === 30);
                    })
                  }
                >
                  加载更早任务
                </Button>
              )}
              {job && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-3">
                    <p className="text-xs leading-5">
                      {job.message ||
                        (job.status === 'queued'
                          ? '等待开始调优'
                          : job.status === 'preparing'
                            ? '正在准备历史行情与策略环境'
                            : '调优结果')}
                    </p>
                    {activeRun(job.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const next = await pluginRequest<BacktestRun>(
                              pluginId,
                              `/strategies/optimizations/${job.id}/cancel`,
                              { method: 'POST' },
                            );
                            setJobs(
                              (old) =>
                                old?.map((item) =>
                                  item.id === next.id ? next : item,
                                ) ?? [],
                            );
                            toast.success('已请求停止调优');
                          })
                        }
                      >
                        <Square className="size-3.5" />
                        停止
                      </Button>
                    )}
                  </div>
                  {result?.draft ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-4">
                      <div>
                        <Badge variant="secondary">新草稿已创建</Badge>
                        <p className="mt-2 text-sm font-medium">
                          {result.draft.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          包含最佳参数与所选版本源码，尚未发布。
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => onOpenDraft(result.draft!.id)}
                      >
                        打开新草稿
                        <ArrowUpRight className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    job.status === 'completed' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const draft = await pluginRequest<StrategyDetail>(
                              pluginId,
                              `/strategies/optimizations/${job.id}/draft`,
                              { method: 'POST' },
                            );
                            onDraftRef.current(draft);
                            setSummary((old) =>
                              old?.run.id === job.id ? { ...old, draft } : old,
                            );
                            toast.success('新策略草稿已保存');
                          })
                        }
                      >
                        生成调优草稿
                      </Button>
                    )
                  )}
                  {result?.optimization && (
                    <OptimizationResult
                      key={job.id}
                      report={result.optimization}
                    />
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
      {form && (
        <RunForm
          mode="optimization"
          pluginId={pluginId}
          strategyId={strategy.id}
          versions={versions}
          initial={job?.config ?? initial}
          onClose={() => setForm(false)}
          onCreated={(next) => {
            notify.current = next.id;
            setJobs((old) => [next, ...(old ?? [])]);
            setSelected(next.id);
            setForm(false);
          }}
        />
      )}
    </>
  );
}
