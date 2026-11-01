import { Button, ScrollArea, Skeleton } from '@app/plugin-ui';
import type { BacktestLogs } from '../../backtest-view-types';
import { useBacktestResource } from './use-backtest-resource';

export function ResultLogs({
  pluginId,
  runId,
}: {
  pluginId: string;
  runId: string;
}) {
  const { data, error, reload } = useBacktestResource<BacktestLogs>(
    pluginId,
    `/strategies/runs/${runId}/view/logs`,
  );
  if (error)
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" onClick={reload}>
          重试
        </Button>
      </div>
    );
  if (!data) return <Skeleton className="h-24" />;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        订单 {data.counts.orders} · 成交 {data.counts.fills} · 信号{' '}
        {data.counts.signals} · 日志 {data.counts.logs} · 止盈止损{' '}
        {data.counts.risk_levels}
        。此处展示最近 100 条，导出包含完整记录。
      </p>
      {[
        ['订单', data.orders],
        ['策略日志', data.logs],
        ['止盈止损计算记录', data.risk_levels],
        ['账户与持仓', data.account],
      ].map(([title, values]) => (
        <details
          key={title as string}
          className="rounded-md border p-3 text-xs"
        >
          <summary className="cursor-pointer">{title as string}</summary>
          <ScrollArea className="mt-2 h-60">
            <pre className="whitespace-pre-wrap break-all font-mono">
              {JSON.stringify(values, null, 2)}
            </pre>
          </ScrollArea>
        </details>
      ))}
    </>
  );
}
