import { lazy, Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { pluginRequest } from '@app/plugin-sdk/web';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
} from '@app/plugin-ui';
import {
  ChartNoAxesCombined,
  ChevronDown,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Instrument } from '../../shared';
import { durationLabel, MONTH_DURATION } from '../../shared';
import type { MarketStrategyHint, SignalMonitor } from '../../signal-types';
import { monitorExecutionModel } from '../../signal-types';
import type { StrategySummary, StrategyVersion } from '../../strategy-types';
import { strategyNotifications } from '../../strategy-notifications';
import { StrategyNotificationSettings } from './notification-settings';
import { errorText } from '../strategies/format';
import type { useStrategyHints } from './use-strategy-hints';

const HintPerformance = lazy(() =>
  import('./hint-performance').then((module) => ({
    default: module.HintPerformance,
  })),
);
const labels = {
  starting: '准备中',
  running: '监听中',
  paused: '已暂停',
  error: '异常',
};
export function StrategyHints({
  pluginId,
  instrument,
  duration,
  hints,
  onJumpToEntry,
}: {
  pluginId: string;
  instrument: Instrument;
  duration: number;
  hints: ReturnType<typeof useStrategyHints>;
  onJumpToEntry: (time: number) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState<string>();
  const [performance, setPerformance] = useState<string>();
  const historical = hints.items.find((item) => item.id === performance);
  const edited = hints.items.find((item) => item.id === settings);
  return (
    <section
      aria-label={`${instrument.name} 策略提示`}
      className="flex shrink-0 items-center gap-1"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 px-2 text-xs"
            aria-label="策略菜单"
          >
            策略
            <Badge variant="secondary" className="px-1.5 tabular-nums">
              {hints.items.length}
            </Badge>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          aria-label={`${instrument.name} 策略列表`}
          className="w-[34rem] max-w-[calc(100vw-2rem)] overflow-hidden motion-reduce:animate-none"
        >
          {hints.error && (
            <p role="alert" className="px-2 py-2 text-xs text-destructive">
              {hints.error}
            </p>
          )}
          {hints.loading && !hints.items.length ? (
            <Skeleton className="m-2 h-8" />
          ) : !hints.items.length ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              暂无策略，点击旁边的 ＋ 添加。
            </p>
          ) : (
            <ScrollArea
              viewportProps={{ className: 'max-h-[min(60dvh,360px)]' }}
            >
              {hints.items.map((item) => (
                <div
                  key={item.id}
                  role="group"
                  aria-label={item.strategy_name}
                  className="flex min-w-0 items-center gap-1 rounded-sm px-2 py-1"
                >
                  <span
                    className="min-w-0 flex-1 truncate pr-2 text-xs font-medium"
                    title={`${item.strategy_name} · v${item.version_number} · ${durationLabel(item.config.duration)}${monitorExecutionModel(item.config) === 'continuous_price' ? ' · 主连价格模拟' : ''}`}
                  >
                    {item.strategy_name} · v{item.version_number}
                  </span>
                  <Badge
                    variant={
                      item.status === 'error' ? 'destructive' : 'outline'
                    }
                    className="mr-1 shrink-0"
                  >
                    {labels[item.status]}
                  </Badge>
                  <DropdownMenuItem
                    asChild
                    onSelect={() => setPerformance(item.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`${item.strategy_name} 历史记录`}
                      title="历史记录"
                    >
                      <ChartNoAxesCombined className="size-3.5" />
                    </Button>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    asChild
                    onSelect={() => setSettings(item.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`编辑 ${item.strategy_name}`}
                      title="编辑策略"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    asChild
                    variant="destructive"
                    disabled={!!hints.busy}
                    onSelect={(event) => {
                      event.preventDefault();
                      void hints.change(item, {
                        deleted: true,
                        enabled: false,
                      });
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      aria-label={`移除 ${item.strategy_name} 策略提示`}
                      title="删除策略提示及历史记录"
                      disabled={!!hints.busy}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </DropdownMenuItem>
                </div>
              ))}
            </ScrollArea>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="添加策略提示"
        title="添加策略提示"
        onClick={() => setAdding(true)}
      >
        <Plus className="size-3.5" />
      </Button>
      {adding && (
        <StrategyPicker
          pluginId={pluginId}
          symbolName={instrument.name}
          onClose={() => setAdding(false)}
          symbol={instrument.symbol}
          duration={duration}
          onCreated={(item, strategy) => {
            hints.add({
              ...item,
              strategy_name: strategy.name,
              signals: [],
              overlay: { updated_at: null, levels: [] },
            });
            setAdding(false);
          }}
        />
      )}
      {historical && (
        <Suspense fallback={<p className="p-3 text-xs">正在打开历史记录…</p>}>
          <HintPerformance
            key={historical.id}
            pluginId={pluginId}
            item={historical}
            onClose={() => setPerformance(undefined)}
            onJumpToEntry={onJumpToEntry}
          />
        </Suspense>
      )}
      {edited && (
        <HintSettings
          key={`${edited.id}:${edited.revision}`}
          item={edited}
          busy={!!hints.busy}
          onClose={() => setSettings(undefined)}
          onSave={async (patch) => {
            if (await hints.change(edited, patch)) setSettings(undefined);
          }}
        />
      )}
    </section>
  );
}
function HintSettings({
  item,
  busy,
  onClose,
  onSave,
}: {
  item: MarketStrategyHint;
  busy: boolean;
  onClose: () => void;
  onSave: (
    value: Pick<
      SignalMonitor,
      'enabled' | 'notifications_enabled' | 'notifications'
    >,
  ) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(item.enabled);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    item.notifications_enabled !== false,
  );
  const [value, setValue] = useState(() =>
    strategyNotifications(item.notifications),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90svh] flex-col">
        <DialogHeader>
          <DialogTitle>编辑策略 · {item.strategy_name}</DialogTitle>
          <DialogDescription>
            {item.config.symbol} · v{item.version_number} ·{' '}
            {durationLabel(item.config.duration)}
            {monitorExecutionModel(item.config) === 'continuous_price' &&
              ' · 主连价格模拟'}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          viewportProps={{ className: 'min-h-0 flex-1' }}
        >
          <div className="space-y-4 pb-4">
            <Label className="flex items-center justify-between gap-4">
              策略计算
              <Switch
                checked={enabled}
                disabled={busy}
                aria-label={`${item.strategy_name} 策略计算`}
                onCheckedChange={setEnabled}
              />
            </Label>
            <Label className="flex items-center justify-between gap-4">
              信号通知
              <Switch
                checked={notificationsEnabled}
                disabled={busy}
                aria-label={`${item.strategy_name} 信号通知`}
                onCheckedChange={(checked) => {
                  setNotificationsEnabled(checked);
                  if (
                    checked &&
                    !(
                      value.channels.toast?.enabled ||
                      value.channels.desktop?.enabled
                    )
                  )
                    setValue(
                      strategyNotifications({
                        channels: {
                          ...value.channels,
                          toast: { enabled: true },
                        },
                      }),
                    );
                }}
              />
            </Label>
          </div>
          <StrategyNotificationSettings
            value={value}
            onChange={setValue}
            disabled={busy || !notificationsEnabled}
          />
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void onSave({
                enabled,
                notifications_enabled: notificationsEnabled,
                notifications: value,
              })
            }
          >
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function StrategyPicker({
  pluginId,
  symbolName,
  symbol,
  duration,
  onClose,
  onCreated,
}: {
  pluginId: string;
  symbolName: string;
  symbol: string;
  duration: number;
  onClose: () => void;
  onCreated: (item: SignalMonitor, strategy: StrategySummary) => void;
}) {
  const calculationDuration = duration === MONTH_DURATION ? 86400 : duration;
  const [items, setItems] = useState<StrategySummary[]>();
  const [selected, setSelected] = useState('');
  const [versions, setVersions] = useState<{
    strategyId: string;
    items: StrategyVersion[];
  }>();
  const [versionId, setVersionId] = useState('');
  const [canRun, setCanRun] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const availableVersions =
    versions?.strategyId === selected ? versions.items : undefined;
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      pluginRequest<StrategySummary[]>(pluginId, '/strategies', {
        signal: abort.signal,
      }),
      pluginRequest<{ canRun: boolean }>(pluginId, '/strategies/template', {
        signal: abort.signal,
      }),
    ])
      .then(([rows, permissions]) => {
        if (abort.signal.aborted) return;
        const usable = rows.filter(
          (row) =>
            row.status === 'active' && row.enabled && row.version_count > 0,
        );
        setItems(usable);
        setSelected(usable[0]?.id ?? '');
        setCanRun(permissions.canRun);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorText(error));
      });
    return () => abort.abort();
  }, [pluginId]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void pluginRequest<StrategyVersion[]>(
      pluginId,
      `/strategies/${selected}/versions`,
      { signal: abort.signal },
    )
      .then((rows) => {
        if (abort.signal.aborted) return;
        const sorted = [...rows].sort((a, b) => b.number - a.number);
        setVersions({ strategyId: selected, items: sorted });
        setVersionId(sorted[0]?.id ?? '');
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(errorText(error));
      });
    return () => abort.abort();
  }, [pluginId, selected]);
  async function add() {
    const strategy = items?.find((item) => item.id === selected);
    if (
      !strategy ||
      !availableVersions?.some((version) => version.id === versionId) ||
      busy
    )
      return;
    setBusy(true);
    setError('');
    try {
      const item = await pluginRequest<SignalMonitor>(
        pluginId,
        `/strategies/${strategy.id}/monitors`,
        {
          method: 'POST',
          body: JSON.stringify({
            version_id: versionId,
            symbol,
            duration: calculationDuration,
          }),
        },
      );
      onCreated(item, strategy);
      toast.success('已添加策略提示，开始计算全量历史并监听实时行情');
    } catch (error) {
      setError(errorText(error));
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加策略提示 · {symbolName}</DialogTitle>
          <DialogDescription>
            使用所选版本的参数，按 {durationLabel(calculationDuration)}{' '}
            周期计算全部已存行情，完成后持续实时更新。
            {symbol.startsWith('KQ.m@') &&
              '主连按主连价格模拟，不计实际合约价差与换月成本。'}
            {duration === MONTH_DURATION
              ? '月线视图使用日线计算信号。'
              : '周期取自当前行情图表。'}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!items ? (
          <Skeleton className="h-9" />
        ) : items.length ? (
          <>
            <Label className="grid min-w-0 grid-cols-1 gap-2">
              策略
              <Select
                value={selected}
                disabled={busy}
                onValueChange={(value) => {
                  setSelected(value);
                  setVersionId('');
                  setError('');
                }}
              >
                <SelectTrigger className="w-full" aria-label="选择提示策略">
                  <SelectValue className="min-w-0 truncate" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid min-w-0 grid-cols-1 gap-2">
              版本
              <Select
                value={versionId}
                disabled={busy || !availableVersions?.length}
                onValueChange={setVersionId}
              >
                <SelectTrigger className="w-full" aria-label="选择策略版本">
                  <SelectValue
                    placeholder={
                      !availableVersions ? '正在加载版本…' : '暂无已发布版本'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {availableVersions?.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      v{version.number}
                      {version.note ? ` · ${version.note}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            暂无可用策略，请先到
            <a
              className="ml-1 underline"
              href={`/plugins/${pluginId}/strategies`}
            >
              策略页面
            </a>
            发布并启用一个版本。
          </p>
        )}
        {items && !canRun && (
          <p className="text-xs text-muted-foreground">
            运行策略需要管理员权限。
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={
              !availableVersions?.some((version) => version.id === versionId) ||
              !canRun ||
              busy
            }
            onClick={() => void add()}
          >
            {busy ? '正在添加…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
