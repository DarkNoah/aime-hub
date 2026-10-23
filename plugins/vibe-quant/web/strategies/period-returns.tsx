import { memo } from 'react';
import {
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/plugin-ui';
import type { BacktestResult } from '../../strategy-types';
import { number, percent } from './format';

type PeriodReturn = BacktestResult['monthly_returns'][number];

function returnColor(value: number) {
  if (value > 0) return 'text-rose-600 dark:text-rose-400';
  if (value < 0) return 'text-emerald-600 dark:text-emerald-400';
  return 'text-muted-foreground';
}

export const PeriodReturns = memo(function PeriodReturns({
  monthly,
  yearly,
}: {
  monthly: PeriodReturn[];
  yearly: PeriodReturn[];
}) {
  const groups = new Map<
    string,
    { months: PeriodReturn[]; total?: PeriodReturn }
  >();
  for (const total of yearly) {
    groups.set(total.period, { months: [], total });
  }
  for (const month of monthly) {
    const year = month.period.slice(0, 4);
    const group = groups.get(year) ?? { months: [] };
    group.months.push(month);
    groups.set(year, group);
  }
  const years = [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));

  return (
    <div className="space-y-2">
      <div className="rounded-md border">
        <ScrollArea className="w-full">
          <Table aria-label="月度收益与年度合计">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead className="text-right">收益率</TableHead>
                <TableHead className="text-right">收益（元）</TableHead>
              </TableRow>
            </TableHeader>
            {years.map(([year, { months, total }]) => (
              <TableBody key={year}>
                {months
                  .sort((a, b) => b.period.localeCompare(a.period))
                  .map((month) => (
                    <TableRow key={month.period}>
                      <TableCell className="tabular-nums">
                        {month.period}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${returnColor(month.return)}`}
                      >
                        {percent(month.return)}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums ${returnColor(month.pnl)}`}
                      >
                        {number(month.pnl)}
                      </TableCell>
                    </TableRow>
                  ))}
                {total && (
                  <TableRow className="border-y bg-muted/50 font-semibold hover:bg-muted/50">
                    <TableCell>{year} 年合计</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${returnColor(total.return)}`}
                    >
                      {percent(total.return)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${returnColor(total.pnl)}`}
                    >
                      {number(total.pnl)}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            ))}
            {!years.length && (
              <TableBody>
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-10 text-center text-muted-foreground"
                  >
                    暂无月度或年度收益数据
                  </TableCell>
                </TableRow>
              </TableBody>
            )}
          </Table>
        </ScrollArea>
      </div>
      {years.length > 0 && (
        <p className="text-xs text-muted-foreground">
          年度合计仅包含本次回测覆盖的时间。
        </p>
      )}
    </div>
  );
});
