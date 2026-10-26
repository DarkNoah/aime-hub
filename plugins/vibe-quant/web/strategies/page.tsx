import { useEffect, useState } from 'react';
import { pluginRequest, type PluginPageProps } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
} from '@app/plugin-ui';
import { Code2, FileCode2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  STRATEGY_STATUS_LABELS,
  type ScriptDraft,
  type StrategyDetail,
  type StrategyStatus,
  type StrategySummary,
} from '../../strategy-types';
import { errorText } from './format';
import { StrategyEditor } from './editor';

type Template = ScriptDraft & { canRun: boolean };
export default function StrategiesPage({ pluginId }: PluginPageProps) {
  const [items, setItems] = useState<StrategySummary[] | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get('strategy') ?? '',
  );
  const [status, setStatus] = useState<StrategyStatus>('active');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [create, setCreate] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      pluginRequest<StrategySummary[]>(pluginId, '/strategies?status=all', {
        signal: abort.signal,
      }),
      pluginRequest<Template>(pluginId, '/strategies/template', {
        signal: abort.signal,
      }),
    ])
      .then(([rows, example]) => {
        setItems(rows);
        setTemplate(example);
        setSelected(
          (old) =>
            old || rows.find((item) => item.status === 'active')?.id || '',
        );
        setError('');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [pluginId, retry]);
  const update = (item: StrategySummary) =>
    setItems((old) =>
      old?.some((v) => v.id === item.id)
        ? old.map((v) => (v.id === item.id ? item : v))
        : [item, ...(old ?? [])],
    );
  const filtered = items?.filter(
    (item) =>
      item.status === status &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selectedId =
    filtered?.find((item) => item.id === selected)?.id ??
    filtered?.[0]?.id ??
    '';
  const openStrategy = (id: string) => {
    setStatus(items?.find((item) => item.id === id)?.status ?? 'active');
    setQuery('');
    setSelected(id);
  };
  return (
    <ScrollArea
      className="h-full"
      viewportProps={{ className: '[&>div]:block! [&>div]:h-full' }}
    >
      <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <Code2 className="size-5" />
              策略
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Python 脚本、版本和可追溯的回测记录
            </p>
          </div>
          <Button
            size="sm"
            disabled={!template}
            onClick={() => setCreate(true)}
          >
            <Plus className="size-4" />
            新建策略
          </Button>
        </header>
        {error ? (
          <div role="alert" className="p-6 text-sm">
            <p className="mb-3 text-destructive">{error}</p>
            <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
              重新加载
            </Button>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-rows-1 lg:grid-cols-[250px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-b bg-muted/15 lg:border-b-0 lg:border-r">
              <div className="mx-3 mt-3">
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value as StrategyStatus)}
                >
                  <SelectTrigger className="w-full" aria-label="策略分类">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(STRATEGY_STATUS_LABELS).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label} ·{' '}
                          {items?.filter((item) => item.status === value)
                            .length ?? 0}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="relative m-3">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  aria-label="搜索策略"
                  className="pl-9"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索策略"
                />
              </div>
              <ScrollArea
                className="max-h-48 min-h-0 flex-1 lg:max-h-none"
                viewportProps={{ className: '[&>div]:block!' }}
              >
                <div className="space-y-1 px-2 pb-3">
                  {items === null ? (
                    <div className="space-y-3 p-2">
                      <Skeleton className="h-16" />
                      <Skeleton className="h-16" />
                    </div>
                  ) : (
                    filtered?.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelected(item.id)}
                        className={`w-full rounded-md border p-3 text-left transition-colors ${selectedId === item.id ? 'border-border bg-background shadow-xs' : 'border-transparent hover:bg-accent'}`}
                        aria-current={
                          selectedId === item.id ? 'page' : undefined
                        }
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {item.name}
                          </span>
                          <Badge
                            variant={
                              item.status === 'deleted'
                                ? 'destructive'
                                : item.status === 'active' && item.enabled
                                  ? 'secondary'
                                  : 'outline'
                            }
                            className="text-[10px]"
                          >
                            {item.status === 'deleted'
                              ? '已删除'
                              : item.status === 'archived'
                                ? '已归档'
                                : item.enabled
                                  ? '启用'
                                  : '停用'}
                          </Badge>
                        </div>
                        <p className="mt-1.5 truncate text-xs text-muted-foreground">
                          {item.description || '暂无描述'}
                        </p>
                        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>
                            {item.version_count
                              ? `${item.version_count} 个版本`
                              : '尚未发布'}
                          </span>
                          <span>
                            {new Date(item.updated_at).toLocaleDateString(
                              'zh-CN',
                            )}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                  {items && !filtered?.length && (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {query
                        ? '没有匹配的策略'
                        : status === 'active'
                          ? '创建策略后会显示在这里'
                          : status === 'archived'
                            ? '暂无归档策略'
                            : '回收站为空'}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </aside>
            <main className="min-h-[32rem] min-w-0 lg:min-h-0">
              {selectedId && template ? (
                <DetailLoader
                  key={selectedId}
                  pluginId={pluginId}
                  id={selectedId}
                  canRun={template.canRun}
                  onUpdate={update}
                  onOpenStrategy={openStrategy}
                />
              ) : items && !filtered?.length ? (
                <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center">
                  <FileCode2 className="mb-4 size-9 text-muted-foreground" />
                  <h2 className="text-base font-medium">
                    {query
                      ? '没有匹配的策略'
                      : status === 'archived'
                        ? '暂无归档策略'
                        : status === 'deleted'
                          ? '回收站为空'
                          : '从一份策略脚本开始'}
                  </h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                    {status === 'active'
                      ? '保存草稿，发布版本，再配置回测。内置均线模板可用于 IM 主连、商品主连和股票。'
                      : '策略的脚本、版本和回测记录会保留，可随时恢复到当前策略。'}
                  </p>
                  {status === 'active' && !query && (
                    <Button
                      className="mt-5"
                      disabled={!template}
                      onClick={() => setCreate(true)}
                    >
                      <Plus className="size-4" />
                      新建策略
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-4 p-6">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-80" />
                </div>
              )}
            </main>
          </div>
        )}
        {create && template && (
          <CreateDialog
            pluginId={pluginId}
            template={template}
            onClose={() => setCreate(false)}
            onCreated={(item) => {
              update(item);
              setStatus('active');
              setQuery('');
              setSelected(item.id);
              setCreate(false);
            }}
          />
        )}
      </div>
    </ScrollArea>
  );
}
function CreateDialog({
  pluginId,
  template,
  onClose,
  onCreated,
}: {
  pluginId: string;
  template: Template;
  onClose: () => void;
  onCreated: (item: StrategyDetail) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90svh] flex-col">
        <DialogHeader>
          <DialogTitle>新建策略</DialogTitle>
          <DialogDescription>
            创建后可编辑 Python 脚本。回测和实时计算沿用同一份 SDK 策略。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const item = await pluginRequest<StrategyDetail>(
                pluginId,
                '/strategies',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    name,
                    description,
                    enabled: true,
                    draft: {
                      source: template.source,
                      parameters: template.parameters,
                    },
                  }),
                },
              );
              onCreated(item);
              toast.success('策略已创建');
            } catch (e) {
              setError(errorText(e));
              toast.error(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <ScrollArea
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            viewportProps={{ className: 'min-h-0 flex-1' }}
          >
            <div className="space-y-4 p-1">
              <Label className="grid gap-2">
                名称
                <Input
                  required
                  maxLength={100}
                  value={name}
                  autoFocus
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如 IM 均线方向策略"
                />
              </Label>
              <Label className="grid gap-2">
                描述
                <Textarea
                  value={description}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="记录信号逻辑和适用标的"
                />
              </Label>
              <p className="text-xs text-muted-foreground">
                以均线交叉模板创建；交易规则和资金在每次回测时配置。
              </p>

              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? '创建中…' : '创建策略'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function DetailLoader({
  pluginId,
  id,
  canRun,
  onUpdate,
  onOpenStrategy,
}: {
  pluginId: string;
  id: string;
  canRun: boolean;
  onUpdate: (item: StrategySummary) => void;
  onOpenStrategy: (id: string) => void;
}) {
  const [item, setItem] = useState<StrategyDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    pluginRequest<StrategyDetail>(pluginId, `/strategies/${id}`, {
      signal: abort.signal,
    })
      .then((v) => {
        setItem(v);
        setError('');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorText(e));
      });
    return () => abort.abort();
  }, [pluginId, id, retry]);
  if (error)
    return (
      <div className="p-6" role="alert">
        <p className="text-sm text-destructive">{error}</p>
        <Button
          variant="outline"
          className="mt-3"
          onClick={() => setRetry((n) => n + 1)}
        >
          重试
        </Button>
      </div>
    );
  return item ? (
    <StrategyEditor
      initial={item}
      pluginId={pluginId}
      canRun={canRun}
      onUpdate={onUpdate}
      onOpenStrategy={onOpenStrategy}
    />
  ) : (
    <div className="space-y-4 p-6">
      <Skeleton className="h-14" />
      <Skeleton className="h-80" />
    </div>
  );
}
