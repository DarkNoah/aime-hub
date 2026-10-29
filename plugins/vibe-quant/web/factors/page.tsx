import { useCallback, useEffect, useState } from 'react';
import { pluginRequest, type PluginPageProps } from '@app/plugin-sdk/web';
import {
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
  FactorGroups,
} from '../../factor-types';
import { FactorEditor } from './editor';
import { FactorSettings } from './settings';
import { factorError } from './format';
import { FactorGroupTree } from './group-tree';
import { GroupDialog, type GroupAction } from './group-dialog';
import { UNGROUPED } from '../../factor-groups';

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
  const [tree, setTree] = useState<FactorGroups>({ groups: [], revision: 0 });
  const [activeGroup, setActiveGroup] = useState(UNGROUPED);
  const [groupAction, setGroupAction] = useState<GroupAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      pluginRequest<FactorGroups>(pluginId, '/factors/groups', {
        signal: abort.signal,
      }),
      pluginRequest<FactorSummary[]>(pluginId, '/factors', {
        signal: abort.signal,
      }),
      pluginRequest<Template>(pluginId, '/factors/template', {
        signal: abort.signal,
      }),
    ])
      .then(([groups, rows, example]) => {
        setTree(groups);
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
  const applyTree = (next: FactorGroups) => {
    setTree(next);
    const valid = new Set(next.groups.map((g) => g.id));
    setItems(
      (old) =>
        old?.map((item) =>
          valid.has(item.group_id ?? UNGROUPED)
            ? item
            : { ...item, group_id: UNGROUPED },
        ) ?? null,
    );
    setActiveGroup((old) => (valid.has(old) ? old : UNGROUPED));
  };
  const saveGroup = async (name: string, parent_id: string | null) => {
    if (!groupAction) return;
    setBusy(true);
    const { type } = groupAction;
    try {
      const next = await pluginRequest<FactorGroups>(
        pluginId,
        type === 'create'
          ? '/factors/groups'
          : `/factors/groups/${groupAction.group.id}`,
        {
          method:
            type === 'create' ? 'POST' : type === 'edit' ? 'PUT' : 'DELETE',
          body: JSON.stringify({ name, parent_id, revision: tree.revision }),
        },
      );
      applyTree(next);
      setGroupAction(null);
      toast.success(
        type === 'delete' ? '分组已删除，因子已移到未分类' : '分组已保存',
      );
    } catch (error) {
      toast.error(factorError(error));
      // A stale tree revision is recoverable without replacing the factor editor.
      try {
        applyTree(
          await pluginRequest<FactorGroups>(pluginId, '/factors/groups'),
        );
      } catch {
        /* retain existing tree */
      }
    } finally {
      setBusy(false);
    }
  };
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
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] lg:grid-cols-[270px_minmax(0,1fr)] lg:grid-rows-1">
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
                {items === null ? (
                  <div className="space-y-3 p-3">
                    <Skeleton className="h-32" />
                    <Skeleton className="h-32" />
                  </div>
                ) : (
                  <FactorGroupTree
                    groups={tree.groups}
                    items={items}
                    query={query}
                    selected={selected}
                    activeGroup={activeGroup}
                    canEdit={!!template?.canRun && !busy && !dirty}
                    onGroup={setActiveGroup}
                    onSelect={select}
                    onAction={setGroupAction}
                  />
                )}
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
                groups={tree.groups}
                onCreated={(row) => {
                  update(row);
                  setSelected(row.id);
                  setActiveGroup(row.group_id ?? UNGROUPED);
                }}
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
          initial={{
            ...template,
            name: '',
            description: '',
            enabled: true,
            group_id: activeGroup || UNGROUPED,
          }}
          groups={tree.groups}
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
      {groupAction && (
        <GroupDialog
          action={groupAction}
          groups={tree.groups}
          busy={busy}
          onClose={() => setGroupAction(null)}
          onSave={(name, parent) => void saveGroup(name, parent)}
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
