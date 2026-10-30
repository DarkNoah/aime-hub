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
import type {
  OptimizationReport,
  OptimizationVersionResult,
} from '../../optimization-types';
import { runVersionName, strategyVersionName } from '../../strategy-version';
import { dateTime, errorText } from './format';
import { OptimizationResult } from './optimization-result';
import { RunForm } from './run-form';

type Summary = {
  run: BacktestRun;
  optimization: OptimizationReport | null;
  version: StrategyVersion | null;
  strategy: StrategyDetail | null;
  version_deleted?: boolean;
};

export function OptimizationPanel({
  pluginId,
  strategy,
  versions,
  initial,
  canRun,
  onClose,
  onVersion,
  onOpenVersion,
}: {
  pluginId: string;
  strategy: StrategySummary;
  versions: StrategyVersion[];
  initial?: BacktestInput;
  canRun: boolean;
  onClose: () => void;
  onVersion: (result: OptimizationVersionResult) => void;
  onOpenVersion: (id: string) => void;
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
  const applied = useRef(new Set<string>());
  const onVersionRef = useRef(onVersion);
  useEffect(() => {
    onVersionRef.current = onVersion;
  }, [onVersion]);
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
        if (next.version && next.strategy) {
          if (!applied.current.has(next.version.id)) {
            applied.current.add(next.version.id);
            onVersionRef.current({
              version: next.version,
              strategy: next.strategy,
            });
          }
          if (notify.current === selected) {
            toast.success(
              `调优完成，已创建 ${strategyVersionName(next.version)}`,
            );
            notify.current = '';
          }
        }
        if (
          activeRun(next.run.status) ||
          (next.run.status === 'completed' &&
            !next.version &&
            !next.version_deleted &&
            (!next.run.optimization_draft_id ||
              next.run.optimization_version_id))
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
              搜索所选版本的默认参数，成功后在当前策略中创建调优版本。
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
                          {runVersionName(item)} · {item.config.symbol}
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
                    先选择原版本，再设置默认参数的搜索范围与验证区间。完成后自动创建新版本，例如
                    v6.opt.v1。
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
                  {result?.version ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-4">
                      <div>
                        <Badge variant="secondary">调优版本已创建</Badge>
                        <p className="mt-2 text-sm font-medium">
                          {strategyVersionName(result.version)}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          保留原版本源码，最佳参数已保存为新版本的默认参数。
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => onOpenVersion(result.version!.id)}
                      >
                        查看新版本
                        <ArrowUpRight className="size-4" />
                      </Button>
                    </div>
                  ) : result?.version_deleted ? (
                    <Badge variant="outline">调优版本已删除</Badge>
                  ) : (
                    job.status === 'completed' && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const saved =
                              await pluginRequest<OptimizationVersionResult>(
                                pluginId,
                                `/strategies/optimizations/${job.id}/version`,
                                { method: 'POST' },
                              );
                            applied.current.add(saved.version.id);
                            onVersionRef.current(saved);
                            setSummary((old) =>
                              old?.run.id === job.id
                                ? { ...old, ...saved }
                                : old,
                            );
                            toast.success(
                              `已创建 ${strategyVersionName(saved.version)}`,
                            );
                          })
                        }
                      >
                        保存调优版本
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
          primaryVersionId={strategy.primary_version_id}
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
