import { runVersionName } from '../../strategy-version';
import {
  Badge,
  Button,
  Label,
  ScrollArea,
  Skeleton,
  Switch,
} from '@app/plugin-ui';
import { SlidersHorizontal, Trash2 } from 'lucide-react';
import type {
  MarketPositionMonitor,
  MarketPositionsPage,
} from '../../market-positions';
import { durationLabel } from '../../shared';
import { dateTime } from '../strategies/format';

const statuses = {
  starting: '准备中',
  running: '监听中',
  paused: '已暂停',
  error: '异常',
};

export function MarketStrategyList({
  data,
  filtered = false,
  loading,
  error,
  hiddenStrategyIds,
  onVisibleChange,
  onEditParameters,
  onRemove,
  busy,
}: {
  data?: MarketPositionsPage;
  filtered?: boolean;
  loading: boolean;
  error: string;
  hiddenStrategyIds: ReadonlySet<string>;
  onVisibleChange: (id: string, visible: boolean) => void;
  onEditParameters: (item: MarketPositionMonitor) => void;
  onRemove: (item: MarketPositionMonitor) => void;
  busy: boolean;
}) {
  const openCounts = new Map<string, number>();
  for (const row of data?.open ?? [])
    openCounts.set(row.monitor_id, (openCounts.get(row.monitor_id) ?? 0) + 1);
  return (
    <ScrollArea
      className="h-[420px] xl:h-0 xl:min-h-0 xl:flex-1"
      viewportProps={{ className: '[&>div]:block!' }}
    >
      {!data && loading ? (
        <div className="space-y-3 p-4" role="status" aria-label="正在加载策略">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : data?.monitors.length ? (
        <ul aria-label="已加载策略列表" className="divide-y">
          {data.monitors.map((monitor) => {
            const attachmentId = monitor.attachment_id ?? monitor.id;
            const visible = !hiddenStrategyIds.has(attachmentId);
            const displaySymbol =
              monitor.config.display_symbol ?? monitor.config.symbol;
            const status = !monitor.enabled ? 'paused' : monitor.status;
            const statusLabel =
              status === 'paused' || status === 'error'
                ? statuses[status]
                : monitor.replaying
                  ? '计算历史中'
                  : statuses[status];
            return (
              <li key={monitor.id} className="min-w-0 space-y-2.5 px-4 py-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">
                      {monitor.strategy_name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {runVersionName(monitor)} ·{' '}
                      {durationLabel(monitor.config.duration)}
                    </p>
                  </div>
                  <Badge
                    variant={status === 'error' ? 'destructive' : 'outline'}
                    className="shrink-0"
                  >
                    {statusLabel}
                  </Badge>
                </div>
                <dl className="space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">来源标的</dt>
                    <dd className="break-all text-right font-medium">
                      {monitor.config.symbol}
                    </dd>
                  </div>
                  {displaySymbol !== monitor.config.symbol && (
                    <div className="flex justify-between gap-3">
                      <dt className="shrink-0 text-muted-foreground">
                        挂载图表
                      </dt>
                      <dd className="break-all text-right">{displaySymbol}</dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">当前持仓</dt>
                    <dd className="tabular-nums">
                      {openCounts.get(monitor.id) ?? 0} 笔
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-muted-foreground">信号通知</dt>
                    <dd>
                      <Badge variant="secondary">
                        {monitor.notifications_enabled === false
                          ? '已关闭'
                          : '已开启'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
                <Label className="flex items-center justify-between gap-3 text-xs">
                  图表显示
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant={visible ? 'secondary' : 'outline'}>
                      {visible ? '已显示' : '已隐藏'}
                    </Badge>
                    <Switch
                      checked={visible}
                      aria-label={`${monitor.strategy_name} ${runVersionName(monitor)} 图表显示`}
                      onCheckedChange={(checked) =>
                        onVisibleChange(attachmentId, checked)
                      }
                    />
                  </span>
                </Label>
                {monitor.message && status !== 'running' && (
                  <p
                    className={`break-words text-xs leading-5 ${status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {monitor.message}
                  </p>
                )}
                <div className="flex items-center gap-1">
                  <p className="mr-auto text-[11px] text-muted-foreground">
                    {monitor.through == null
                      ? '尚未完成持仓计算'
                      : `计算至 ${dateTime(monitor.through)}（北京时间）`}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs"
                    aria-label={`编辑 ${monitor.strategy_name} 参数`}
                    onClick={() => onEditParameters(monitor)}
                  >
                    <SlidersHorizontal className="size-3.5" /> 参数
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs text-destructive hover:text-destructive"
                    aria-label={`移除 ${monitor.strategy_name} ${runVersionName(monitor)} ${displaySymbol} 策略提示`}
                    title="移除策略提示并清除本次加载的历史记录"
                    disabled={busy}
                    onClick={() => onRemove(monitor)}
                  >
                    <Trash2 className="size-3.5" /> 移除
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : !error ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium">
            {filtered ? '没有匹配的已加载策略' : '尚未添加策略'}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {filtered
              ? '可切换策略或选择「全部策略」查看。'
              : '在图表上方的「策略」菜单添加后，这里会显示所有已加载策略及其运行状态。'}
          </p>
        </div>
      ) : null}
    </ScrollArea>
  );
}
