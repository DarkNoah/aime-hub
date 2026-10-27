import { lazy, Suspense, useState } from 'react';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Label,
  ScrollArea,
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
import { durationLabel } from '../../shared';
import type { MarketStrategyHint, SignalMonitor } from '../../signal-types';
import { monitorExecutionModel } from '../../signal-types';
import { StrategyPicker } from './strategy-picker';
import { strategyNotifications } from '../../strategy-notifications';
import { StrategyNotificationSettings } from './notification-settings';
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
  hints,
  onJumpToEntry,
}: {
  pluginId: string;
  instrument: Instrument;
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
              暂无策略，点击下方「添加策略」开始添加。
            </p>
          ) : (
            <ScrollArea
              className="w-full min-w-0"
              viewportProps={{
                className: 'max-h-[min(60dvh,360px)] [&>div]:block!',
              }}
            >
              {hints.items.map((item) => (
                <div
                  key={item.id}
                  role="group"
                  aria-label={item.strategy_name}
                  className="flex w-full min-w-0 items-center gap-1 rounded-sm px-2 py-1"
                >
                  <span
                    className="min-w-0 flex-1 truncate pr-2 text-xs font-medium"
                    title={`${item.strategy_name} · v${item.version_number} · ${durationLabel(item.config.duration)}${monitorExecutionModel(item.config) === 'points' ? ' · 点数模拟' : monitorExecutionModel(item.config) === 'continuous_price' ? ' · 主连价格模拟' : ''}`}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            aria-label="添加策略提示"
            onSelect={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
            添加策略
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {adding && (
        <StrategyPicker
          pluginId={pluginId}
          symbolName={instrument.name}
          onClose={() => setAdding(false)}
          symbol={instrument.symbol}
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
            {monitorExecutionModel(item.config) === 'points' && ' · 点数模拟'}
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
                      value.channels.desktop?.enabled ||
                      value.channels.sound?.enabled
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
