import { useState } from 'react';
import {
  Badge,
  Button,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/plugin-ui';
import {
  OPTIMIZATION_METRICS,
  type OptimizationReport,
} from '../../optimization-types';
import { dateTime, number, percent } from './format';

const states = {
  complete: '有效',
  failed: '失败',
  pruned: '未入选',
  cancelled: '已取消',
};
export function OptimizationResult({ report }: { report: OptimizationReport }) {
  const points = report.pnl_unit === 'points';
  const [page, setPage] = useState(0);
  const ratio = ['total_return', 'annual_return', 'max_drawdown'].includes(
    report.metric,
  );
  const score = (value: number | null | undefined) =>
    ratio ? percent(value) : number(value);
  return (
    <section className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Optuna 调参结果</h3>
          <Badge variant="secondary">
            {report.completed_trials} / {report.trials.length} 次有效
          </Badge>
          <Badge variant="outline">
            {report.validation ? '留出验证' : '仅样本内'}
          </Badge>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {OPTIMIZATION_METRICS[report.metric]}
        {report.direction === 'minimize' ? '最小化' : '最大化'} · TPE · 种子{' '}
        {report.seed} · 计划 {report.requested_trials} 次。
        最佳参数按训练期指标选择；验证数据不参与选参。
      </p>
      <dl className="grid gap-4 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">训练区间</dt>
          <dd className="mt-1">
            {dateTime(report.training.start)} 至 {dateTime(report.training.end)}
          </dd>
          <dd className="mt-2 font-medium">
            最佳目标值：{score(report.best_value)}
            {report.best_trial !== null
              ? ` · 试验 #${report.best_trial + 1}`
              : ''}
          </dd>
        </div>
        {report.validation && (
          <div>
            <dt className="text-muted-foreground">验证区间</dt>
            <dd className="mt-1">
              {dateTime(report.validation.start)} 至{' '}
              {dateTime(report.validation.end)}
            </dd>
            <dd className="mt-2">
              <Badge
                variant={
                  report.validation.status === 'failed'
                    ? 'destructive'
                    : 'outline'
                }
              >
                {report.validation.status === 'succeeded'
                  ? '已验证'
                  : report.validation.status === 'failed'
                    ? '验证失败'
                    : report.validation.status === 'cancelled'
                      ? '已取消'
                      : '未验证'}
              </Badge>
            </dd>
            <dd className="mt-2">
              目标值 {score(report.validation.metrics[report.metric])} · 收益{' '}
              {points
                ? `${number(report.validation.metrics.total_points)} 点`
                : percent(report.validation.metrics.total_return)}{' '}
              · 回撤{' '}
              {points
                ? `${number(report.validation.metrics.max_drawdown_points)} 点`
                : percent(report.validation.metrics.max_drawdown)}{' '}
              · {number(report.validation.metrics.trade_count)} 笔交易
            </dd>
            {report.validation.message && (
              <dd className="mt-1 text-muted-foreground">
                {report.validation.message}
              </dd>
            )}
          </div>
        )}
      </dl>
      {report.best_parameters && (
        <details open>
          <summary className="cursor-pointer text-xs font-medium">
            最佳参数
          </summary>
          <ScrollArea className="mt-2 max-h-48 rounded bg-muted/40">
            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs">
              {JSON.stringify(report.best_parameters, null, 2)}
            </pre>
          </ScrollArea>
        </details>
      )}
      <details>
        <summary className="cursor-pointer text-xs font-medium">
          试验记录（{report.trials.length}）
        </summary>
        <ScrollArea className="mt-3 w-full">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>试验</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>目标值</TableHead>
                <TableHead>参数 / 原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.trials.slice(page * 20, (page + 1) * 20).map((trial) => (
                <TableRow key={trial.number}>
                  <TableCell className="whitespace-nowrap">
                    #{trial.number + 1}
                    {trial.number === report.best_trial && (
                      <Badge className="ml-2" variant="secondary">
                        最佳
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        trial.state === 'failed' ? 'destructive' : 'outline'
                      }
                    >
                      {states[trial.state]}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {score(trial.value)}
                  </TableCell>
                  <TableCell className="max-w-80 whitespace-normal break-all text-xs">
                    <code>{JSON.stringify(trial.parameters)}</code>
                    {trial.message && (
                      <p className="mt-1 text-muted-foreground">
                        {trial.message}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
        {report.trials.length > 20 && (
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </Button>
            {page + 1} / {Math.ceil(report.trials.length / 20)}
            <Button
              size="sm"
              variant="ghost"
              disabled={(page + 1) * 20 >= report.trials.length}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </details>
    </section>
  );
}
