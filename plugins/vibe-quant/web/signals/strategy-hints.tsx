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
import { ChartNoAxesCombined, Plus, Settings2, Trash2 } from 'lucide-react';
import type { Instrument } from '../../shared';
import { durationLabel, MONTH_DURATION } from '../../shared';
import type { MarketStrategyHint, SignalMonitor } from '../../signal-types';
import type { StrategySummary, StrategyVersion } from '../../strategy-types';
import { strategyNotifications } from '../../strategy-notifications';
import { StrategyNotificationSettings } from './notification-settings';
import { dateTime, errorText } from '../strategies/format';
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
const price = (value: number | null) =>
  value === null
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
export function StrategyHints({
  pluginId,
  instrument,
  duration,
  hints,
}: {
  pluginId: string;
  instrument: Instrument;
  duration: number;
  hints: ReturnType<typeof useStrategyHints>;
}) {
  const [adding, setAdding] = useState(false);
  const [settings, setSettings] = useState<string>();
  const [performance, setPerformance] = useState<string>();
  const historical = hints.items.find((item) => item.id === performance);
  const edited = hints.items.find((item) => item.id === settings);
  return (
    <section aria-label={`${instrument.name} 策略提示`} className="border-b">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="text-xs font-medium">
          策略提示{hints.items.length ? ` · ${hints.items.length}` : ''}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus className="size-3.5" />
          添加策略提示
        </Button>
      </div>
      {hints.error && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {hints.error}
        </p>
      )}
      {hints.loading && !hints.items.length ? (
        <Skeleton className="mx-3 mb-3 h-9" />
      ) : !hints.items.length ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          为此标的添加策略，在图上查看入场、离场及策略输出的止盈止损。
        </p>
      ) : (
        <ScrollArea
          className="max-h-64"
          viewportProps={{ className: 'max-h-64' }}
        >
          <div className="divide-y border-t">
            {hints.items.map((item) => (
              <div key={item.id} className="space-y-2 px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="min-w-0 break-words text-xs font-medium">
                    {item.strategy_name} · v{item.version_number} ·{' '}
                    {durationLabel(item.config.duration)}
                  </span>
                  <Badge
                    variant={
                      item.status === 'error' ? 'destructive' : 'outline'
                    }
                  >
                    {labels[item.status]}
                  </Badge>
                  <div className="ml-auto flex flex-wrap items-center gap-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-1.5 text-xs"
                      aria-label={`${item.strategy_name} 历史表现`}
                      onClick={() => setPerformance(item.id)}
                    >
                      <ChartNoAxesCombined className="size-3.5" />
                      历史表现
                    </Button>
                    <Label className="flex items-center gap-1.5 text-xs">
                      计算
                      <Switch
                        aria-label={`${item.strategy_name} 策略计算`}
                        checked={item.enabled}
                        disabled={!!hints.busy}
                        onCheckedChange={(enabled) =>
                          void hints.change(item, { enabled })
                        }
                      />
                    </Label>
                    <Label className="flex items-center gap-1.5 text-xs">
                      通知
                      <Switch
                        aria-label={`${item.strategy_name} 信号通知`}
                        checked={item.notifications_enabled !== false}
                        disabled={!!hints.busy}
                        onCheckedChange={(notifications_enabled) =>
                          void hints.change(item, {
                            notifications_enabled,
                            ...(notifications_enabled &&
                            !(
                              item.notifications?.channels.toast?.enabled ||
                              item.notifications?.channels.desktop?.enabled
                            )
                              ? {
                                  notifications: strategyNotifications({
                                    channels: {
                                      ...item.notifications?.channels,
                                      toast: { enabled: true },
                                    },
                                  }),
                                }
                              : {}),
                          })
                        }
                      />
                    </Label>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${item.strategy_name} 通知设置`}
                      onClick={() => setSettings(item.id)}
                    >
                      <Settings2 className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`移除 ${item.strategy_name} 策略提示`}
                      disabled={!!hints.busy}
                      onClick={() =>
                        void hints.change(item, {
                          deleted: true,
                          enabled: false,
                        })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                {item.status !== 'running' && (
                  <p
                    className={`text-xs ${item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {item.message}
                  </p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {item.signals.slice(0, 2).map((signal) => (
                    <span key={signal.id}>
                      {signal.side === 'long'
                        ? '多头'
                        : signal.side === 'short'
                          ? '空头'
                          : ''}
                      {signal.type === 'entry' ? '入场' : '离场'}{' '}
                      {price(signal.price)} · {dateTime(signal.time)}
                    </span>
                  ))}
                  {!item.signals.length && <span>等待新的入场／离场信号</span>}
                </div>
                {item.overlay.levels.length ? (
                  <div className="space-y-1 text-xs">
                    {item.overlay.levels.map((level) => (
                      <div
                        key={level.id}
                        className="flex flex-wrap gap-x-4 gap-y-1"
                      >
                        <span className="font-mono text-muted-foreground">
                          {level.symbol}
                        </span>
                        <span>止盈 {price(level.take_profit)}</span>
                        <span>止损 {price(level.stop_loss)}</span>
                        <span className="text-muted-foreground">
                          更新于 {dateTime(level.time)}
                        </span>
                      </div>
                    ))}
                    {instrument.kind === 'continuous' && (
                      <p className="text-muted-foreground">
                        价格为实际合约值，图中保护线按同期主连价差投影；缺少对应行情时仅显示数值。
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    当前无有效止盈止损，策略输出后自动显示。
                  </p>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
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
        <Suspense fallback={<p className="p-3 text-xs">正在打开历史表现…</p>}>
          <HintPerformance
            key={historical.id}
            pluginId={pluginId}
            item={historical}
            onClose={() => setPerformance(undefined)}
          />
        </Suspense>
      )}
      {edited && (
        <HintSettings
          key={`${edited.id}:${edited.revision}`}
          item={edited}
          busy={!!hints.busy}
          onClose={() => setSettings(undefined)}
          onSave={async (notifications) => {
            if (await hints.change(edited, { notifications }))
              setSettings(undefined);
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
  onSave: (value: ReturnType<typeof strategyNotifications>) => Promise<void>;
}) {
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
          <DialogTitle>{item.strategy_name} · 通知设置</DialogTitle>
          <DialogDescription>
            仅影响 {item.config.symbol}{' '}
            上的这条策略提示。通知关闭时图表仍持续更新。
          </DialogDescription>
        </DialogHeader>
        <ScrollArea
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          viewportProps={{ className: 'min-h-0 flex-1' }}
        >
          <StrategyNotificationSettings
            value={value}
            onChange={setValue}
            disabled={busy}
          />
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void onSave(value)}>
            保存通知设置
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
      toast.success('已添加策略提示，开始实时计算');
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
            周期计算。
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
