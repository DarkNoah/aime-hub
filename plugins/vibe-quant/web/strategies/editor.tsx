import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  CodeEditor,
  JsonObjectEditor,
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
  Switch,
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
  Textarea,
} from '@app/plugin-ui';
import {
  CopyPlus,
  Download,
  FileCode2,
  History,
  Play,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Square,
  Upload,
} from 'lucide-react';
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
import { dateTime, errorText, parseObject } from './format';
import { RunForm } from './run-form';
import { ResultView } from './result-view';
import { OptimizationPanel } from './optimization-panel';
import { LifecycleActions } from './lifecycle-actions';

type EditState = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  parameters: string;
};
const editState = (item: StrategyDetail): EditState => ({
  name: item.name,
  description: item.description,
  enabled: item.enabled,
  source: item.draft.source,
  parameters: JSON.stringify(item.draft.parameters, null, 2),
});
export function StrategyEditor({
  initial,
  pluginId,
  canRun,
  onUpdate,
  onOpenStrategy,
}: {
  initial: StrategyDetail;
  pluginId: string;
  canRun: boolean;
  onUpdate: (item: StrategySummary) => void;
  onOpenStrategy: (id: string) => void;
}) {
  const cacheKey = `vibe-quant:strategy-draft:${initial.id}`;
  const [record, setRecord] = useState(initial);
  const [edit, setEdit] = useState<EditState>(() => {
    if (initial.status !== 'active') return editState(initial);
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null');
      if (
        cached &&
        typeof cached.edit?.source === 'string' &&
        typeof cached.edit?.parameters === 'string'
      ) {
        const restored = editState(initial);
        // Restore only current fields so retired settings cannot mark a draft dirty.
        for (const key of Object.keys(restored) as (keyof EditState)[]) {
          if (key === 'enabled') {
            if (typeof cached.edit[key] === 'boolean')
              restored[key] = cached.edit[key];
          } else if (typeof cached.edit[key] === 'string')
            restored[key] = cached.edit[key];
        }
        return restored;
      }
    } catch {
      /* No cached draft. */
    }
    return editState(initial);
  });
  const [baseRevision, setBaseRevision] = useState(() => {
    if (initial.status !== 'active') return initial.revision;
    try {
      const value = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null');
      if (Number.isInteger(value?.revision)) return value.revision as number;
    } catch {
      /* No saved revision. */
    }
    return initial.revision;
  });
  const [reloadDraft, setReloadDraft] = useState(false);
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [runs, setRuns] = useState<BacktestRun[]>([]);
  const [selectedVersion, setSelectedVersion] = useState('draft');
  const [selectedRun, setSelectedRun] = useState('');
  const [tab, setTab] = useState('script');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [publish, setPublish] = useState(false);
  const [note, setNote] = useState('');
  const [settings, setSettings] = useState(false);
  const [optimizationOpen, setOptimizationOpen] = useState(false);
  const [runForm, setRunForm] = useState<{ initial?: BacktestInput } | null>(
    null,
  );
  const upload = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(edit) !== JSON.stringify(editState(record));
  const readOnly = record.status !== 'active';
  const viewed = versions.find((v) => v.id === selectedVersion);
  const run = runs.find((v) => v.id === selectedRun);
  useEffect(() => {
    if (readOnly) return;
    try {
      if (dirty)
        sessionStorage.setItem(
          cacheKey,
          JSON.stringify({ revision: baseRevision, edit }),
        );
      else sessionStorage.removeItem(cacheKey);
    } catch {
      /* Server save remains available when browser storage is disabled. */
    }
  }, [cacheKey, edit, baseRevision, dirty, readOnly]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll(first: boolean) {
      try {
        const [rows, saved] = await Promise.all([
          pluginRequest<BacktestRun[]>(
            pluginId,
            `/strategies/${initial.id}/runs`,
            { signal: abort.signal },
          ),
          first
            ? pluginRequest<StrategyVersion[]>(
                pluginId,
                `/strategies/${initial.id}/versions`,
                { signal: abort.signal },
              )
            : Promise.resolve(null),
        ]);
        if (abort.signal.aborted) return;
        setRuns((old) => {
          const map = new Map(old.map((r) => [r.id, r]));
          rows.forEach((r) => map.set(r.id, r));
          return [...map.values()].sort((a, b) =>
            b.created_at.localeCompare(a.created_at),
          );
        });
        if (first) {
          setHasMore(rows.length === 30);
          setSelectedRun((old) => old || rows[0]?.id || '');
        }
        if (saved) setVersions(saved);
        setLoaded(true);
        setListError('');
      } catch (e) {
        if (!abort.signal.aborted) setListError(errorText(e));
      }
      if (!abort.signal.aborted)
        timer = setTimeout(() => void poll(false), 3000);
    }
    void poll(true);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [pluginId, initial.id, retry]);
  const setField = <K extends keyof EditState>(key: K, value: EditState[K]) =>
    setEdit((old) => ({
      ...old,
      [key]: value,
    }));
  async function save() {
    const next = await pluginRequest<StrategyDetail>(
      pluginId,
      `/strategies/${record.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: edit.name,
          description: edit.description,
          enabled: edit.enabled,
          revision: baseRevision,
          draft: {
            source: edit.source,
            parameters: parseObject(edit.parameters),
          },
        }),
      },
    );
    setRecord(next);
    setBaseRevision(next.revision);
    setEdit(editState(next));
    onUpdate(next);
    return next;
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const blob = new Blob([viewed?.source ?? edit.source], {
      type: 'text/x-python;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `strategy-${viewed ? `v${viewed.number}` : 'draft'}.py`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold">
                {record.name}
              </h2>
              <Badge variant="outline">Python SDK</Badge>
              {readOnly && (
                <Badge
                  variant={
                    record.status === 'deleted' ? 'destructive' : 'secondary'
                  }
                >
                  {record.status === 'deleted' ? '已删除' : '已归档'}
                </Badge>
              )}
              {dirty && <Badge variant="secondary">草稿未保存</Badge>}
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {record.description || '同一份脚本用于回测和实时计算'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!loaded || !versions.length}
              onClick={() => setOptimizationOpen(true)}
            >
              <SlidersHorizontal className="size-4" />
              调优参数
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || busy}
              onClick={() => setSettings(true)}
            >
              <Settings2 className="size-4" />
              设置
            </Button>
            <Button
              size="sm"
              disabled={
                readOnly ||
                busy ||
                !loaded ||
                !versions.length ||
                !record.enabled ||
                !canRun
              }
              onClick={() => setRunForm({})}
            >
              <Play className="size-4" />
              新建回测
            </Button>
            <LifecycleActions
              pluginId={pluginId}
              strategy={record}
              busy={busy}
              dirty={dirty}
              onBusy={setBusy}
              onError={setError}
              onChanged={(next) => {
                setRecord((old) => ({ ...old, ...next }));
                setBaseRevision(next.revision);
                setError('');
                onUpdate(next);
              }}
            />
          </div>
        </div>
        {!canRun && (
          <p className="mt-2 text-xs text-muted-foreground">
            脚本在服务器插件 venv 中执行，运行操作需要管理员权限。
          </p>
        )}
        {readOnly && (
          <p className="mt-2 text-xs text-muted-foreground">
            {record.status === 'deleted' ? '策略已移入回收站' : '策略已归档'}
            ，脚本、版本和历史结果仍可查看。恢复后可继续编辑或新建任务；已提交的回测会继续执行，实时监听暂停。
          </p>
        )}
      </div>
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <TabsList>
            <TabsTrigger value="script">
              <FileCode2 className="size-3.5" />
              脚本与版本
            </TabsTrigger>
            <TabsTrigger value="runs">
              <History className="size-3.5" />
              回测记录
            </TabsTrigger>
          </TabsList>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {versions.length} 个固定版本
          </span>
        </div>
        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b bg-destructive/5 px-4 py-3 text-xs text-destructive"
          >
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReloadDraft(true)}
            >
              重新载入
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setError('')}>
              关闭
            </Button>
          </div>
        )}
        {listError && (
          <div
            role="alert"
            className="flex items-center gap-3 border-b px-4 py-2 text-xs text-destructive"
          >
            {listError}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRetry((n) => n + 1)}
            >
              重试
            </Button>
          </div>
        )}
        <TabsContent
          value="script"
          forceMount
          className="data-[state=inactive]:hidden flex min-h-0 flex-1 flex-col"
        >
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <Select value={selectedVersion} onValueChange={setSelectedVersion}>
              <SelectTrigger className="w-[185px]" aria-label="选择草稿或版本">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">工作草稿</SelectItem>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.number} · {v.note || v.source_hash.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex flex-wrap gap-2">
              {viewed ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={readOnly || dirty || busy}
                  title={dirty ? '请先保存当前草稿' : undefined}
                  onClick={() => {
                    setEdit((old) => ({
                      ...old,
                      source: viewed.source,
                      parameters: JSON.stringify(viewed.parameters, null, 2),
                    }));
                    setSelectedVersion('draft');
                    toast.success('版本已复制到草稿，保存后可发布新版本');
                  }}
                >
                  <RotateCcw className="size-3.5" />
                  基于此版本编辑
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || busy || !dirty}
                    onClick={() =>
                      void action(async () => {
                        await save();
                        toast.success('草稿已保存');
                      })
                    }
                  >
                    <Save className="size-3.5" />
                    保存草稿
                  </Button>
                  <Button
                    size="sm"
                    disabled={readOnly || busy}
                    onClick={() => setPublish(true)}
                  >
                    发布版本
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={download}
                aria-label="下载 Python 脚本"
              >
                <Download className="size-4" />
              </Button>
              {!viewed && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly || busy}
                  onClick={() => upload.current?.click()}
                  aria-label="导入 Python 脚本"
                >
                  <Upload className="size-4" />
                </Button>
              )}
            </div>
          </div>
          <input
            ref={upload}
            type="file"
            accept=".py,text/x-python"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                if (file.size > 120_000) throw new Error('脚本文件过大');
                const source = await file.text();
                if (source.length > 60_000)
                  throw new Error('脚本最多 60,000 字符');
                setField('source', source);
                toast.success('脚本已载入草稿，入口将自动识别');
              } catch (e) {
                toast.error(errorText(e));
              }
            }}
          />
          {viewed && (
            <div className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              <p>
                v{viewed.number} · {dateTime(viewed.created_at)} ·{' '}
                {viewed.note || '无版本说明'}
              </p>
              <p className="mt-1 break-all font-mono text-[10px]">
                SHA-256 {viewed.source_hash}
              </p>
            </div>
          )}
          <ScrollArea
            className="min-h-0 flex-1"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div className="space-y-4 p-4 sm:p-5">
              <JsonObjectEditor
                key={selectedVersion}
                label="默认参数"
                readOnly={readOnly || !!viewed}
                value={
                  viewed
                    ? JSON.stringify(viewed.parameters, null, 2)
                    : edit.parameters
                }
                onChange={(value) => setField('parameters', value)}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                参数随版本固定，创建回测时可覆盖。单一 Strategy
                子类自动作为入口。
              </p>
              <CodeEditor
                key={`script-${selectedVersion}`}
                value={viewed?.source ?? edit.source}
                readOnly={readOnly || !!viewed}
                onChange={(value) => setField('source', value)}
                onSave={() => {
                  if (!readOnly && !viewed && !busy && dirty)
                    void action(async () => {
                      await save();
                      toast.success('草稿已保存');
                    });
                }}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                版本发布后不可修改；修改历史版本会复制为新草稿。尚未保存的编辑暂存在当前浏览器标签页。代码依赖来自插件空间的
                Python venv。
              </p>
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent
          value="runs"
          forceMount
          className="data-[state=inactive]:hidden min-h-0 flex-1"
        >
          <ScrollArea
            className="h-full"
            viewportProps={{ className: '[&>div]:block!' }}
          >
            <div className="border-b">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">版本 / 标的</TableHead>
                    <TableHead className="hidden sm:table-cell">
                      创建时间
                    </TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="pr-5 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((item) => (
                    <TableRow
                      key={item.id}
                      data-state={
                        selectedRun === item.id ? 'selected' : undefined
                      }
                    >
                      <TableCell className="pl-5">
                        <span className="text-xs">v{item.version_number}</span>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {item.config.symbol}
                        </p>
                        <p className="mt-1 whitespace-nowrap text-[10px] text-muted-foreground sm:hidden">
                          {dateTime(item.created_at)}
                        </p>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap text-xs sm:table-cell">
                        {dateTime(item.created_at)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            item.status === 'failed'
                              ? 'destructive'
                              : activeRun(item.status)
                                ? 'secondary'
                                : 'outline'
                          }
                        >
                          {RUN_LABELS[item.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            size="sm"
                            variant={
                              selectedRun === item.id ? 'secondary' : 'ghost'
                            }
                            onClick={() => setSelectedRun(item.id)}
                          >
                            结果
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={
                              readOnly ||
                              !canRun ||
                              !record.enabled ||
                              !versions.some((v) => v.id === item.version_id)
                            }
                            title="将这条记录的参数填入新建回测窗体"
                            onClick={() =>
                              setRunForm({
                                initial: structuredClone(item.config),
                              })
                            }
                          >
                            <CopyPlus className="size-3.5" />
                            复用参数
                          </Button>
                          {activeRun(item.status) && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-8"
                              disabled={item.cancel_requested || busy}
                              aria-label="取消回测"
                              onClick={() =>
                                void action(async () => {
                                  const next = await pluginRequest<BacktestRun>(
                                    pluginId,
                                    `/strategies/runs/${item.id}/cancel`,
                                    { method: 'POST' },
                                  );
                                  setRuns((old) =>
                                    old.map((r) =>
                                      r.id === next.id ? next : r,
                                    ),
                                  );
                                  toast.success('已请求取消回测');
                                })
                              }
                            >
                              <Square className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {loaded && !runs.length && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {versions.length
                          ? '还没有回测记录。选择一个版本，配置参数后开始回测。'
                          : '先发布一个脚本版本，再创建回测。'}
                      </TableCell>
                    </TableRow>
                  )}
                  {!loaded && (
                    <TableRow>
                      <TableCell colSpan={4}>
                        <Skeleton className="my-3 h-16" />
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              {hasMore && (
                <div className="p-3 text-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={moreBusy}
                    onClick={async () => {
                      setMoreBusy(true);
                      try {
                        const rows = await pluginRequest<BacktestRun[]>(
                          pluginId,
                          `/strategies/${record.id}/runs?before=${runs.at(-1)!.id}`,
                        );
                        setRuns((old) => [
                          ...old,
                          ...rows.filter(
                            (r) => !old.some((v) => v.id === r.id),
                          ),
                        ]);
                        setHasMore(rows.length === 30);
                      } catch (e) {
                        toast.error(errorText(e));
                      } finally {
                        setMoreBusy(false);
                      }
                    }}
                  >
                    加载更早记录
                  </Button>
                </div>
              )}
            </div>
            {run && <ResultView key={run.id} pluginId={pluginId} run={run} />}
          </ScrollArea>
        </TabsContent>
      </Tabs>
      {reloadDraft && (
        <Dialog open onOpenChange={setReloadDraft}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重新载入已保存草稿</DialogTitle>
              <DialogDescription>
                当前未保存的编辑会被替换。可以先下载脚本保留修改。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={download}>
                下载当前脚本
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const next = await pluginRequest<StrategyDetail>(
                      pluginId,
                      `/strategies/${record.id}`,
                    );
                    setRecord(next);
                    setBaseRevision(next.revision);
                    setEdit(editState(next));
                    onUpdate(next);
                    setError('');
                    setReloadDraft(false);
                  })
                }
              >
                重新载入
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {settings && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!busy) setSettings(open);
          }}
        >
          <DialogContent className="flex max-h-[90svh] flex-col">
            <DialogHeader>
              <DialogTitle>策略设置</DialogTitle>
              <DialogDescription>
                修改与当前草稿一起保存，已发布版本保持不变。
              </DialogDescription>
            </DialogHeader>
            <ScrollArea
              className="flex min-h-0 flex-1 flex-col overflow-hidden"
              viewportProps={{ className: 'min-h-0 flex-1' }}
            >
              <div className="space-y-4 p-1">
                <Label className="grid gap-2">
                  名称
                  <Input
                    value={edit.name}
                    maxLength={100}
                    disabled={busy}
                    onChange={(e) => setField('name', e.target.value)}
                  />
                </Label>
                <Label className="grid gap-2">
                  描述
                  <Textarea
                    value={edit.description}
                    maxLength={2000}
                    disabled={busy}
                    onChange={(e) => setField('description', e.target.value)}
                  />
                </Label>
                <Label className="flex items-center justify-between">
                  启用策略
                  <Switch
                    disabled={busy}
                    checked={edit.enabled}
                    onCheckedChange={(value) => setField('enabled', value)}
                  />
                </Label>
              </div>
            </ScrollArea>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await save();
                    setSettings(false);
                    toast.success('策略已更新');
                  })
                }
              >
                {busy ? '保存中…' : '保存设置'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {publish && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!busy) setPublish(open);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>发布 v{record.version_count + 1}</DialogTitle>
              <DialogDescription>
                保存当前草稿并创建固定版本。后续编辑不影响这个版本和它的回测记录。
              </DialogDescription>
            </DialogHeader>
            <Label className="grid gap-2">
              版本说明
              <Textarea
                value={note}
                maxLength={2000}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如调整均线窗口，增加换月平仓处理"
              />
            </Label>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setPublish(false)}
              >
                取消
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const saved = dirty ? await save() : record;
                    const result = await pluginRequest<{
                      strategy: StrategyDetail;
                      version: StrategyVersion;
                    }>(pluginId, `/strategies/${record.id}/versions`, {
                      method: 'POST',
                      body: JSON.stringify({ revision: saved.revision, note }),
                    });
                    setRecord(result.strategy);
                    setBaseRevision(result.strategy.revision);
                    onUpdate(result.strategy);
                    setVersions((old) => [result.version, ...old]);
                    setPublish(false);
                    setNote('');
                    toast.success(`v${result.version.number} 已发布`);
                  })
                }
              >
                {busy ? '发布中…' : '发布版本'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {runForm && (
        <RunForm
          pluginId={pluginId}
          strategyId={record.id}
          versions={versions}
          initial={runForm.initial}
          onClose={() => setRunForm(null)}
          onCreated={(next) => {
            setRuns((old) => [next, ...old]);
            setSelectedRun(next.id);
            setTab('runs');
            setRunForm(null);
          }}
        />
      )}
      {optimizationOpen && (
        <OptimizationPanel
          pluginId={pluginId}
          strategy={record}
          versions={versions}
          initial={runs[0]?.config}
          canRun={canRun}
          onClose={() => setOptimizationOpen(false)}
          onDraft={onUpdate}
          onOpenDraft={onOpenStrategy}
        />
      )}
    </div>
  );
}
