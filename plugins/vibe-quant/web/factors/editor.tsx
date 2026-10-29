import { useEffect, useRef, useState } from 'react';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  CodeEditor,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  JsonObjectEditor,
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
import { BookOpen, Copy, Play, Save, Settings2, Square } from 'lucide-react';
import { toast } from 'sonner';
import type {
  FactorAnalysis,
  FactorAnalysisInput,
  FactorAnalysisSummary,
  FactorDetail,
  FactorGroup,
  FactorSummary,
  FactorVersion,
} from '../../factor-types';
import { AnalysisForm } from './analysis-form';
import { FactorSettings } from './settings';
import { FactorReportView } from './report';
import { dateTime, factorError } from './format';
import { factorStrategySource } from '../../factor-strategy';
import type { StrategyDetail } from '../../strategy-types';
import { UNGROUPED } from '../../factor-groups';
import { BuiltinInfo } from './builtin-info';

export function FactorEditor({
  pluginId,
  id,
  canRun,
  onUpdate,
  onDirty,
  groups,
  onCreated,
}: {
  pluginId: string;
  id: string;
  canRun: boolean;
  groups: FactorGroup[];
  onCreated: (row: FactorSummary) => void;
  onUpdate: (row: FactorSummary) => void;
  onDirty: (value: boolean) => void;
}) {
  const [record, setRecord] = useState<FactorDetail | null>(null);
  const [source, setSource] = useState('');
  const [parameters, setParameters] = useState('{}');
  const [history, setHistory] = useState<FactorAnalysisSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [result, setResult] = useState<FactorAnalysis | null>(null);
  const [versionId, setVersionId] = useState('draft');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [resultError, setResultError] = useState('');
  const [retry, setRetry] = useState(0);
  const [settings, setSettings] = useState(false);
  const [copying, setCopying] = useState(false);
  const [publish, setPublish] = useState(false);
  const [note, setNote] = useState('');
  const [guide, setGuide] = useState(false);
  const [restore, setRestore] = useState<FactorVersion | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [config, setConfig] = useState<FactorAnalysisInput>(() => ({
    version_id: null,
    start: new Date(Date.now() - 365 * 86400_000).toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    }),
    end: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
    holding_days: 5,
    groups: 5,
    direction: 1,
    symbols: [],
  }));
  const dirty =
    !!record &&
    (source !== record.source ||
      parameters !== JSON.stringify(record.parameters, null, 2));
  const viewed = record?.versions.find((v) => v.id === versionId);
  useEffect(() => {
    onDirty(dirty || running);
  }, [dirty, running, onDirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || running) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, running]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      pluginRequest<FactorDetail>(pluginId, `/factors/${id}`, {
        signal: abort.signal,
      }),
      pluginRequest<FactorAnalysisSummary[]>(
        pluginId,
        `/factors/${id}/analyses`,
        { signal: abort.signal },
      ),
    ])
      .then(([row, runs]) => {
        setRecord(row);
        setSource(row.source);
        setParameters(JSON.stringify(row.parameters, null, 2));
        setHistory(runs);
        setSelectedRun(runs[0]?.id ?? '');
        setError('');
        if (runs[0]) setConfig(runs[0].config);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(factorError(e));
      });
    return () => abort.abort();
  }, [pluginId, id, retry]);
  useEffect(() => {
    if (!selectedRun) return;
    const abort = new AbortController();
    pluginRequest<FactorAnalysis>(
      pluginId,
      `/factors/analyses/${selectedRun}`,
      { signal: abort.signal },
    )
      .then((row) => {
        setResult(row);
        setResultError('');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setResultError(factorError(e));
      });
    return () => abort.abort();
  }, [pluginId, selectedRun]);

  const action = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      toast.error(factorError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async (overrides: Partial<FactorDetail> = {}) => {
    if (!record) throw new Error('因子尚未加载');
    let params: unknown;
    try {
      params = JSON.parse(parameters);
    } catch {
      throw new Error('参数必须是有效 JSON 对象');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params))
      throw new Error('参数必须是 JSON 对象');
    const next = await pluginRequest<FactorDetail>(pluginId, `/factors/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...record,
        source,
        parameters: params,
        ...overrides,
        group_id: groups.some(
          (g) => g.id === (overrides.group_id ?? record.group_id),
        )
          ? (overrides.group_id ?? record.group_id)
          : UNGROUPED,
      }),
    });
    setRecord(next);
    setSource(next.source);
    setParameters(JSON.stringify(next.parameters, null, 2));
    onUpdate(next);
    return next;
  };
  const analyze = async () => {
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setBusy(true);
    try {
      if (dirty && !viewed) await save();
      const row = await pluginRequest<FactorAnalysis>(
        pluginId,
        `/factors/${id}/analyses`,
        {
          method: 'POST',
          signal: abort.signal,
          body: JSON.stringify({ ...config, version_id: viewed?.id ?? null }),
        },
      );
      setHistory((old) => [row, ...old.filter((r) => r.id !== row.id)]);
      setSelectedRun(row.id);
      setResult(row);
      if (row.status === 'completed') toast.success('因子分析完成');
      else toast.error(row.message);
    } catch (e) {
      if (abort.signal.aborted) {
        toast.info('已中止因子分析');
        const rows = await pluginRequest<FactorAnalysisSummary[]>(
          pluginId,
          `/factors/${id}/analyses`,
        ).catch(() => null);
        if (rows) setHistory(rows);
      } else toast.error(factorError(e));
    } finally {
      setRunning(false);
      setBusy(false);
      abortRef.current = null;
    }
  };
  if (error)
    return (
      <div role="alert" className="p-6">
        <p className="mb-3 text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => setRetry(retry + 1)}>
          重新加载
        </Button>
      </div>
    );
  if (!record)
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10" />
        <Skeleton className="h-64" />
      </div>
    );
  const canEdit = canRun && !record.builtin;
  const pinnedVersion = viewed ?? record.versions[0];
  const invocation = factorStrategySource(
    pinnedVersion?.id ?? '发布后获得版本ID',
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2
              className="truncate text-base font-semibold"
              title={record.name}
            >
              {record.name}
            </h2>
            <Badge variant="outline">
              {record.enabled ? '已启用' : '已停用'}
            </Badge>
            {dirty && <Badge variant="secondary">未保存</Badge>}
          </div>
          {record.description && (
            <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
              {record.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!canRun || busy || dirty}
            onClick={() => setCopying(true)}
          >
            <Copy className="size-3.5" />
            复制因子
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="因子 SDK 用法"
            onClick={() => setGuide(true)}
          >
            <BookOpen className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="因子设置"
            disabled={!canEdit || busy}
            onClick={() => setSettings(true)}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(340px,0.85fr)_minmax(0,1.15fr)]">
        <ScrollArea
          className="min-h-0 border-b xl:border-b-0 xl:border-r"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="space-y-5 p-4 sm:p-5">
            {record.builtin && <BuiltinInfo info={record.builtin} />}
            <div className="flex flex-wrap items-center gap-2">
              <Select
                disabled={busy}
                value={versionId}
                onValueChange={setVersionId}
              >
                <SelectTrigger className="min-w-0 flex-1" aria-label="因子版本">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">
                    {record.builtin ? '内置公式' : '当前草稿'}
                  </SelectItem>
                  {record.versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      v{v.number} · {dateTime(v.created_at)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || busy || !!viewed || !dirty}
                onClick={() =>
                  void action(async () => {
                    await save();
                    toast.success('因子已保存');
                  })
                }
              >
                <Save className="size-3.5" />
                保存
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canEdit || busy || !!viewed || !record.enabled}
                onClick={() => setPublish(true)}
              >
                发布版本
              </Button>
            </div>
            {viewed && (
              <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs">
                <p className="break-words">
                  {viewed.note || `v${viewed.number} 固定版本`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit || busy}
                    onClick={() => setRestore(viewed)}
                  >
                    <Copy className="size-3.5" />
                    复制为草稿
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setGuide(true)}
                  >
                    策略调用示例
                  </Button>
                </div>
              </div>
            )}
            <AnalysisForm
              value={config}
              onChange={setConfig}
              pluginId={pluginId}
              disabled={busy}
            />
            <Button
              className="w-full"
              disabled={
                !canRun ||
                (!running &&
                  (busy ||
                    !record.enabled ||
                    config.symbols.length < Math.max(config.groups, 3)))
              }
              variant={running ? 'outline' : 'default'}
              onClick={() =>
                running ? abortRef.current?.abort() : void analyze()
              }
            >
              {running ? (
                <>
                  <Square className="size-4" />
                  中止分析
                </>
              ) : (
                <>
                  <Play className="size-4" />
                  运行分析
                </>
              )}
            </Button>
            {running && (
              <p role="status" className="text-xs text-muted-foreground">
                正在读取行情并计算因子，完成后会保存本次分析。
              </p>
            )}
            {!canRun && (
              <p className="text-xs text-muted-foreground">
                当前账号可查看因子和报告；修改与运行 Python 因子需要管理员权限。
              </p>
            )}
            <JsonObjectEditor
              value={
                viewed ? JSON.stringify(viewed.parameters, null, 2) : parameters
              }
              onChange={setParameters}
              readOnly={busy || !canEdit || !!viewed}
              label="因子参数"
            />
            <CodeEditor
              filename="factor.py"
              label="Python 因子脚本"
              value={viewed?.source ?? source}
              onChange={setSource}
              readOnly={busy || !canEdit || !!viewed}
              onSave={() => {
                if (dirty && !busy && canEdit && !viewed)
                  void action(async () => {
                    await save();
                    toast.success('因子已保存');
                  });
              }}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              一个 Factor 子类，compute 返回数值或 None。lookback
              指定所需历史条数（最多 500）；计算仅接收已收盘 K 线。
            </p>
          </div>
        </ScrollArea>
        <ScrollArea
          className="min-h-0"
          viewportProps={{ className: '[&>div]:block!' }}
        >
          <div className="space-y-5 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">分析报告</h2>
              {history.length > 0 && (
                <Select value={selectedRun} onValueChange={setSelectedRun}>
                  <SelectTrigger
                    className="w-64 max-w-full"
                    aria-label="历史分析"
                  >
                    <SelectValue placeholder="选择历史分析" />
                  </SelectTrigger>
                  <SelectContent>
                    {history.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {dateTime(r.created_at)} ·{' '}
                        {r.status === 'completed'
                          ? '完成'
                          : r.status === 'failed'
                            ? '失败'
                            : r.status === 'cancelled'
                              ? '中止'
                              : '进行中'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {resultError ? (
              <p role="alert" className="text-sm text-destructive">
                {resultError}
              </p>
            ) : selectedRun && result?.id !== selectedRun ? (
              <Skeleton className="h-72" />
            ) : result ? (
              <FactorReportView key={result.id} run={result} />
            ) : (
              <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 text-center">
                <BookOpen className="size-7 text-muted-foreground" />
                <h3 className="text-sm font-medium">还没有分析报告</h3>
                <p className="max-w-xs text-xs leading-6 text-muted-foreground">
                  添加期货合约、选择日期后运行分析，查看分组收益、IC
                  与最新因子值。
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      {settings && (
        <FactorSettings
          initial={{
            ...record,
            group_id: groups.some((g) => g.id === record.group_id)
              ? record.group_id
              : UNGROUPED,
          }}
          groups={groups}
          busy={busy}
          onClose={() => setSettings(false)}
          onSave={(values) =>
            void action(async () => {
              await save(values);
              setSettings(false);
              toast.success('因子设置已更新');
            })
          }
        />
      )}
      {copying && (
        <FactorSettings
          creating
          copying
          initial={{
            ...record,
            name: `${record.name.slice(0, 90)} 副本`,
            description: record.description.slice(0, 2000),
            group_id: UNGROUPED,
          }}
          groups={groups}
          busy={busy}
          onClose={() => setCopying(false)}
          onSave={(values) =>
            void action(async () => {
              const next = await pluginRequest<FactorDetail>(
                pluginId,
                '/factors',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    ...values,
                    source: viewed?.source ?? record.source,
                    parameters: viewed?.parameters ?? record.parameters,
                  }),
                },
              );
              setCopying(false);
              onCreated(next);
              toast.success('已复制为自定义因子');
            })
          }
        />
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
              <DialogTitle>发布因子版本</DialogTitle>
              <DialogDescription>
                保存当前代码和默认参数，校验入口后创建不可变版本。策略通过版本
                ID 引用。
              </DialogDescription>
            </DialogHeader>
            <Label className="grid gap-2">
              版本说明
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
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
                    const next = await pluginRequest<FactorDetail>(
                      pluginId,
                      `/factors/${id}/versions`,
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          revision: saved.revision,
                          note,
                        }),
                      },
                    );
                    setRecord(next);
                    onUpdate(next);
                    setPublish(false);
                    setNote('');
                    toast.success(`v${next.version_count} 已发布`);
                  })
                }
              >
                {busy ? '校验并发布中…' : '发布版本'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {restore && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRestore(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>复制 v{restore.number} 为草稿</DialogTitle>
              <DialogDescription>
                当前编辑区将替换为这个版本的代码和参数，保存后生效。
                {dirty ? '当前未保存的编辑将被覆盖。' : ''}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestore(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  setSource(restore.source);
                  setParameters(JSON.stringify(restore.parameters, null, 2));
                  setVersionId('draft');
                  setRestore(null);
                }}
              >
                复制为草稿
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {guide && (
        <Dialog open onOpenChange={setGuide}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>在策略中使用因子</DialogTitle>
              <DialogDescription>
                先发布版本，在 on_start 中用字面量版本 ID 加载，再于 on_bar
                中调用 value。策略需订阅对应周期并留足预热数据。
              </DialogDescription>
            </DialogHeader>
            <CodeEditor
              filename="factor_usage.py"
              value={invocation}
              onChange={() => {}}
              readOnly
            />
            <DialogFooter>
              <Button
                disabled={
                  !canRun ||
                  !pinnedVersion ||
                  busy ||
                  !!record.builtin?.cross_sectional
                }
                onClick={() =>
                  void action(async () => {
                    const strategy = await pluginRequest<StrategyDetail>(
                      pluginId,
                      '/strategies',
                      {
                        method: 'POST',
                        body: JSON.stringify({
                          name: `${record.name.slice(0, 80)} · 因子策略`,
                          description: `引用因子 v${pinnedVersion!.number}，请补充交易和风控规则。`,
                          enabled: true,
                          draft: {
                            source: invocation,
                            parameters: { duration: 86400 },
                          },
                        }),
                      },
                    );
                    toast.success('策略草稿已创建', {
                      action: {
                        label: '打开策略',
                        onClick: () =>
                          window.open(
                            `/p/${pluginId}/strategies?strategy=${strategy.id}`,
                            '_blank',
                            'noopener',
                          ),
                      },
                    });
                  })
                }
              >
                创建策略草稿
              </Button>
            </DialogFooter>
            <p className="text-xs leading-5 text-muted-foreground">
              版本默认参数自动生效；可传 window=30
              等参数覆盖。支持内置回测、天勤模拟、实时监控及回放。停用因子不会改变已发布版本。
            </p>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
