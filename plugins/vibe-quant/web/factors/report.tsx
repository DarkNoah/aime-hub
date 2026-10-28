import { lazy, Suspense, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Skeleton,
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
} from '@app/plugin-ui';
import type { FactorAnalysis } from '../../factor-types';
import { dateTime, number } from './format';

const Chart = lazy(() => import('./chart'));
export function FactorReportView({ run }: { run: FactorAnalysis }) {
  const [page, setPage] = useState(0);
  const report = run.report;
  const groupSeries = useMemo(
    () =>
      report?.groups.map((g, index) => ({
        name: g.name,
        points: report.curve.map((p) => ({
          time: p.time,
          value: p.values[index],
        })),
      })) ?? [],
    [report],
  );
  const icSeries = useMemo(
    () =>
      report
        ? [
            {
              name: 'IC',
              points: report.ic.map((p) => ({ time: p.time, value: p.ic })),
            },
            {
              name: 'Rank IC',
              points: report.ic.map((p) => ({
                time: p.time,
                value: p.rank_ic,
              })),
            },
          ]
        : [],
    [report],
  );
  const status = {
    running: '分析中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已中止',
  };
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>
          {status[run.status]}
        </Badge>
        <span>{dateTime(run.created_at)}</span>
        <span>{run.config.version_id ? '固定版本' : '草稿快照'}</span>
      </div>
      <details className="rounded-md border px-3 py-2 text-xs">
        <summary className="cursor-pointer font-medium">本次分析参数</summary>
        <div className="mt-3 space-y-2 leading-5 text-muted-foreground">
          <p>
            {run.config.start} 至 {run.config.end} · 日线 · 每{' '}
            {run.config.holding_days} 个交易日调仓 · {run.config.groups} 组 ·{' '}
            {run.config.direction === 1 ? '正向' : '反向'}
          </p>
          <p className="break-words">合约：{run.config.symbols.join('、')}</p>
          <p className="break-all">参数：{JSON.stringify(run.parameters)}</p>
          <p className="break-all">源码 SHA-256：{run.source_hash}</p>
        </div>
      </details>
      {!report ? (
        <p
          role="status"
          className={
            run.status === 'failed'
              ? 'text-sm text-destructive'
              : 'text-sm text-muted-foreground'
          }
        >
          {run.message}
        </p>
      ) : (
        <>
          {report.warnings.length > 0 && (
            <div className="space-y-1 rounded-md bg-muted/50 p-3 text-xs leading-5">
              {report.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          )}
          <section>
            <h2 className="mb-4 text-sm font-semibold">分组累计收益</h2>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <Chart
                series={groupSeries}
                label="分组及多空组合累计收益"
                percent
              />
            </Suspense>
          </section>
          <section>
            <h2 className="mb-3 text-sm font-semibold">核心指标</h2>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-y py-4 sm:grid-cols-3 xl:grid-cols-4">
              {[
                ['多空收益', number(report.groups.at(-1)?.total_return, true)],
                ['多空夏普', number(report.groups.at(-1)?.sharpe)],
                ['多空年化', number(report.groups.at(-1)?.annual_return, true)],
                [
                  '多空回撤（调仓点）',
                  number(report.groups.at(-1)?.max_drawdown, true),
                ],
                ['IC 均值', number(report.metrics.ic_mean)],
                ['Rank IC', number(report.metrics.rank_ic_mean)],
                ['IC 标准差', number(report.metrics.ic_std)],
                ['IC IR', number(report.metrics.ic_ir)],
                ['Rank IC IR', number(report.metrics.rank_ic_ir)],
                ['t 统计量', number(report.metrics.t_stat)],
                [
                  'P(IC > 0.02)',
                  number(report.metrics.positive_ic_ratio, true),
                ],
                [
                  'P(IC < −0.02)',
                  number(report.metrics.negative_ic_ratio, true),
                ],
                ['单调性', number(report.metrics.monotonicity)],
                ['有效 IC 样本', String(report.metrics.observations)],
                ['持有区间', String(report.metrics.periods)],
              ].map(([name, value]) => (
                <div key={name}>
                  <dt className="text-xs text-muted-foreground">{name}</dt>
                  <dd className="mt-1 font-mono text-base font-medium tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <Tabs defaultValue="groups">
            <TabsList>
              <TabsTrigger value="groups">分组收益</TabsTrigger>
              <TabsTrigger value="latest">最新因子值</TabsTrigger>
              <TabsTrigger value="coverage">数据覆盖</TabsTrigger>
            </TabsList>
            <TabsContent value="groups">
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      '分组',
                      '累计收益',
                      '年化收益',
                      '最大回撤',
                      '年化波动',
                      '换手率',
                      '夏普',
                    ].map((h) => (
                      <TableHead key={h} className="whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.groups.map((g) => (
                    <TableRow key={g.name}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {g.name}
                      </TableCell>
                      {[
                        g.total_return,
                        g.annual_return,
                        g.max_drawdown,
                        g.volatility,
                        g.turnover,
                      ].map((v, i) => (
                        <TableCell key={i} className="font-mono tabular-nums">
                          {number(v, true)}
                        </TableCell>
                      ))}
                      <TableCell className="font-mono">
                        {number(g.sharpe)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
            <TabsContent value="latest">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>交易日</TableHead>
                    <TableHead>合约</TableHead>
                    <TableHead>因子值</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.latest.slice(page * 10, page * 10 + 10).map((v) => (
                    <TableRow key={v.symbol}>
                      <TableCell>{v.day}</TableCell>
                      <TableCell className="font-mono">{v.symbol}</TableCell>
                      <TableCell className="font-mono">
                        {number(v.value)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-2 flex items-center justify-end gap-3 text-xs">
                <span>共 {report.latest.length} 条</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <span>{page + 1}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(page + 1) * 10 >= report.latest.length}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="coverage">
              <Table>
                <TableHeader>
                  <TableRow>
                    {[
                      '合约',
                      '历史日线',
                      '有效值',
                      '首个有效日',
                      '最后有效日',
                    ].map((h) => (
                      <TableHead key={h} className="whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.coverage.map((v) => (
                    <TableRow key={v.symbol}>
                      <TableCell className="font-mono">{v.symbol}</TableCell>
                      <TableCell>{v.bars}</TableCell>
                      <TableCell>{v.values}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {v.first}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {v.last}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TabsContent>
          </Tabs>
          <section>
            <h2 className="mb-4 text-sm font-semibold">IC 与 Rank IC 序列</h2>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <Chart series={icSeries} label="IC 与 Rank IC 时间序列" />
            </Suspense>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">IC 衰减</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>持有交易日</TableHead>
                  <TableHead>IC 均值</TableHead>
                  <TableHead>Rank IC 均值</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.decay.map((v) => (
                  <TableRow key={v.days}>
                    <TableCell>{v.days} 日</TableCell>
                    <TableCell className="font-mono">{number(v.ic)}</TableCell>
                    <TableCell className="font-mono">
                      {number(v.rank_ic)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
          <details
            className="border-t pt-3 text-xs leading-5 text-muted-foreground"
            open
          >
            <summary className="cursor-pointer font-medium text-foreground">
              计算口径
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {report.methodology.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
