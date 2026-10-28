import { useCallback, useEffect, useState } from 'react';
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
  ScrollArea,
  Skeleton,
} from '@app/plugin-ui';
import { FlaskConical, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import type {
  FactorDetail,
  FactorDraft,
  FactorSummary,
} from '../../factor-types';
import { FactorEditor } from './editor';
import { FactorSettings } from './settings';
import { factorError } from './format';

type Template = Pick<FactorDraft, 'source' | 'parameters'> & {
  canRun: boolean;
};
export default function FactorsPage({ pluginId }: PluginPageProps) {
  const [items, setItems] = useState<FactorSummary[] | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [selected, setSelected] = useState(
    () => new URLSearchParams(window.location.search).get('factor') ?? '',
  );
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      pluginRequest<FactorSummary[]>(pluginId, '/factors', {
        signal: abort.signal,
      }),
      pluginRequest<Template>(pluginId, '/factors/template', {
        signal: abort.signal,
      }),
    ])
      .then(([rows, example]) => {
        setItems(rows);
        setTemplate(example);
        setSelected((old) =>
          rows.some((i) => i.id === old) ? old : (rows[0]?.id ?? ''),
        );
        setError('');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(factorError(e));
      });
    return () => abort.abort();
  }, [pluginId, retry]);
  const update = useCallback(
    (row: FactorSummary) =>
      setItems((old) =>
        old?.some((item) => item.id === row.id)
          ? old.map((item) => (item.id === row.id ? row : item))
          : [row, ...(old ?? [])],
      ),
    [],
  );
  const select = (id: string) => {
    if (id === selected) return;
    if (dirty) setPending(id);
    else setSelected(id);
  };
  const filtered = items?.filter((item) =>
    `${item.name} ${item.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <ScrollArea
      data-page-width="full"
      className="h-[calc(100dvh-8.5rem)] min-h-[32rem]"
      viewportProps={{ className: '[&>div]:block! [&>div]:h-full' }}
    >
      <div className="flex min-h-full flex-col lg:h-full lg:min-h-0">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-6">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <FlaskConical className="size-5" />
              因子库
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              期货因子研究、Python 公式与策略复用
            </p>
          </div>
          <Button
            size="sm"
            disabled={!template?.canRun || dirty}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            新建因子
          </Button>
        </header>
        {error ? (
          <div role="alert" className="p-6">
            <p className="mb-3 text-sm text-destructive">{error}</p>
            <Button variant="outline" onClick={() => setRetry(retry + 1)}>
              重新加载
            </Button>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)] lg:grid-rows-1">
            <aside className="flex min-h-0 flex-col border-b bg-muted/15 lg:border-b-0 lg:border-r">
              <div className="relative m-3">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  aria-label="搜索因子"
                  placeholder="搜索因子"
                  className="pl-9"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <ScrollArea
                className="max-h-48 min-h-0 flex-1 lg:max-h-none"
                viewportProps={{ className: '[&>div]:block!' }}
              >
                <div className="space-y-1 px-2 pb-3">
                  {items === null ? (
                    <div className="space-y-3 p-2">
                      <Skeleton className="h-20" />
                      <Skeleton className="h-20" />
                    </div>
                  ) : filtered?.length ? (
                    filtered.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={selected === item.id ? 'page' : undefined}
                        onClick={() => select(item.id)}
                        className={`w-full rounded-md border p-3 text-left transition-colors ${selected === item.id ? 'border-border bg-background' : 'border-transparent hover:bg-accent'}`}
                      >
                        <p
                          className="truncate text-sm font-medium"
                          title={item.name}
                        >
                          {item.name}
                        </p>
                        <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
                          {item.description || 'Python 期货因子'}
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            {item.enabled ? '启用' : '停用'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {item.version_count
                              ? `${item.version_count} 个版本`
                              : '草稿'}
                          </span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      {query
                        ? '没有匹配的因子'
                        : '新建一个 Python 因子开始研究'}
                    </p>
                  )}
                </div>
              </ScrollArea>
            </aside>
            {selected ? (
              <FactorEditor
                key={selected}
                pluginId={pluginId}
                id={selected}
                canRun={template?.canRun ?? false}
                onUpdate={update}
                onDirty={setDirty}
              />
            ) : (
              <div className="flex min-h-80 items-center justify-center p-8 text-center text-sm text-muted-foreground">
                {items === null
                  ? '正在加载因子库…'
                  : '创建因子后，在这里编辑代码并查看分析结果。'}
              </div>
            )}
          </div>
        )}
      </div>
      {creating && template && (
        <FactorSettings
          creating
          initial={{ ...template, name: '', description: '', enabled: true }}
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={(values) => {
            setBusy(true);
            void pluginRequest<FactorDetail>(pluginId, '/factors', {
              method: 'POST',
              body: JSON.stringify({ ...template, ...values }),
            })
              .then((row) => {
                update(row);
                setSelected(row.id);
                setCreating(false);
                toast.success('因子已创建');
              })
              .catch((e) => toast.error(factorError(e)))
              .finally(() => setBusy(false));
          }}
        />
      )}
      {pending && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPending('');
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>切换因子</DialogTitle>
              <DialogDescription>
                当前因子存在未保存的修改或正在运行的分析。切换会丢弃未保存的编辑并中止当前分析。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPending('')}>
                继续编辑
              </Button>
              <Button
                onClick={() => {
                  setSelected(pending);
                  setPending('');
                  setDirty(false);
                }}
              >
                切换因子
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </ScrollArea>
  );
}
