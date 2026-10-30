import { runVersionName } from '../../strategy-version';
import { Badge, Button, Label, ScrollArea, Switch } from '@app/plugin-ui';
import { useId } from 'react';
import type { StrategyReplayView } from './use-strategy-replay';
import { number } from '../strategies/format';
import { durationLabel } from '../../shared';

export function ReplayStrategies({
  view,
  notifications,
  onNotificationsChange,
}: {
  view: StrategyReplayView;
  notifications: boolean;
  onNotificationsChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <section
      className="shrink-0 space-y-2 border-t px-3 py-2 text-xs"
      aria-label="回放策略状态"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">策略联动</Badge>
        <span className="text-muted-foreground">
          {view.pending
            ? view.error
              ? '策略计算未完成'
              : '正在计算当前回放状态…'
            : '信号、持仓与止盈止损已同步'}
        </span>
        <Label htmlFor={id} className="ml-auto flex items-center gap-2 text-xs">
          回放通知
          <Switch
            id={id}
            checked={notifications}
            onCheckedChange={onNotificationsChange}
          />
        </Label>
      </div>
      {view.error && (
        <div role="alert" className="flex items-center gap-2 text-destructive">
          {view.error}
          <Button size="sm" variant="outline" onClick={view.retry}>
            重试策略计算
          </Button>
        </div>
      )}
      <ScrollArea viewportProps={{ className: 'max-h-40 [&>div]:block!' }}>
        <div className="divide-y">
          {view.items
            .filter((item) => item.enabled)
            .map((item) => {
              const page = view.pages[item.id];
              const positions = page?.summary?.open_trades ?? [];
              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
                  aria-label={`${item.strategy_name} 回放持仓`}
                >
                  <span className="font-medium">
                    {item.strategy_name} · {runVersionName(item)}
                  </span>
                  <span className="text-muted-foreground">
                    {durationLabel(item.config.duration)}
                  </span>
                  {!page ? (
                    <Badge variant={view.error ? 'destructive' : 'secondary'}>
                      {view.error ? '计算失败' : '计算中'}
                    </Badge>
                  ) : !positions.length ? (
                    <Badge variant="outline">空仓</Badge>
                  ) : (
                    positions.map((position) => (
                      <span
                        key={position.id}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <Badge variant="secondary">
                          {position.side === 'long' ? '多头' : '空头'}{' '}
                          {number(position.quantity)}
                        </Badge>
                        <span>
                          {position.symbol} · 入场{' '}
                          {number(position.entry_price)}
                        </span>
                      </span>
                    ))
                  )}
                  {item.overlay.levels.map((level) => (
                    <span
                      key={level.id}
                      className="flex items-center gap-2 tabular-nums"
                    >
                      {level.stop_loss !== null && (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          止损 {number(level.stop_loss)}
                        </span>
                      )}
                      {level.take_profit !== null && (
                        <span className="text-rose-700 dark:text-rose-400">
                          止盈 {number(level.take_profit)}
                        </span>
                      )}
                    </span>
                  ))}
                  {page && (
                    <span className="text-muted-foreground">
                      {page.signals.length} 个信号
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </ScrollArea>
      <p className="text-muted-foreground">
        通知沿用策略设置；定位和回退不补发历史通知，再次前进到信号时重新提示。
      </p>
    </section>
  );
}
