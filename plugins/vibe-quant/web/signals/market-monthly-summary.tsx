import { useState } from 'react';
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@app/plugin-ui';
import type { MarketPositionMonth } from '../../market-positions';
import { number, percent } from '../strategies/format';

const monthLabel = (month: string) =>
  `${month.slice(0, 4)}年${Number(month.slice(5))}月`;
const signed = (value: number) => `${value > 0 ? '+' : ''}${number(value)}`;
const pnlColor = (value: number) =>
  value > 0
    ? 'text-rose-700 dark:text-rose-300'
    : value < 0
      ? 'text-emerald-700 dark:text-emerald-300'
      : '';

function MonthlyResult({ row }: { row: MarketPositionMonth }) {
  const total = row.winning_trades + row.losing_trades + row.breakeven_trades;
  const unit = row.unit === 'points' ? '点' : '元';
  return (
    <div className="min-w-0 space-y-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline" className="text-[10px]">
          {row.unit === 'points' ? '点数模拟' : '金额模拟'}
        </Badge>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          已平仓 {number(total)} 笔
        </span>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">净盈亏</dt>
          <dd
            className={`break-words text-lg font-semibold tabular-nums ${pnlColor(row.net_pnl)}`}
          >
            {signed(row.net_pnl)}
            <span className="ml-1 text-xs font-normal">{unit}</span>
          </dd>
        </div>
        <div className="space-y-1 text-right">
          <dt className="text-xs text-muted-foreground">胜率</dt>
          <dd className="text-lg font-semibold tabular-nums">
            {percent(total ? row.winning_trades / total : null)}
          </dd>
        </div>
      </dl>
      <dl className="grid grid-cols-3 gap-2 rounded-md bg-background/70 px-2 py-2 text-center text-xs">
        {(
          [
            ['盈利', row.winning_trades, pnlColor(1)],
            ['亏损', row.losing_trades, pnlColor(-1)],
            ['持平', row.breakeven_trades, ''],
          ] as const
        ).map(([label, count, color]) => (
          <div key={label} className="min-w-0 space-y-1">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className={`break-words font-medium tabular-nums ${color}`}>
              {number(count)} 笔
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div className="min-w-0">
          <dt className="text-muted-foreground">盈利合计</dt>
          <dd
            className={`break-words tabular-nums ${pnlColor(row.gross_profit)}`}
          >
            {signed(row.gross_profit)} {unit}
          </dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-muted-foreground">亏损合计</dt>
          <dd
            className={`break-words tabular-nums ${pnlColor(row.gross_loss)}`}
          >
            {signed(row.gross_loss)} {unit}
          </dd>
        </div>
      </dl>
    </div>
  );
}

export function MarketMonthlySummary({
  monthly,
  loading,
}: {
  monthly?: MarketPositionMonth[];
  loading: boolean;
}) {
  const [selectedMonth, setSelectedMonth] = useState('');
  const currentMonth = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  const dataMonths = [...new Set(monthly?.map((row) => row.month))].sort(
    (a, b) => b.localeCompare(a),
  );
  const months = [...new Set([currentMonth, ...dataMonths])].sort((a, b) =>
    b.localeCompare(a),
  );
  const month = months.includes(selectedMonth)
    ? selectedMonth
    : (dataMonths[0] ?? currentMonth);
  const rows = (monthly ?? [])
    .filter((row) => row.month === month)
    .toSorted((a, b) => a.unit.localeCompare(b.unit));
  return (
    <section
      aria-label="月度盈亏汇总"
      className="mx-3 my-3 min-w-0 rounded-lg border bg-muted/30 p-3"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">月度盈亏</h3>
        <Select value={month} onValueChange={setSelectedMonth}>
          <SelectTrigger
            size="sm"
            aria-label="统计月份"
            className="h-7 max-w-full gap-1 px-2 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="end">
            {months.map((value) => (
              <SelectItem key={value} value={value} className="text-xs">
                {monthLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!monthly && loading ? (
        <div role="status" aria-label="正在加载月度盈亏" className="space-y-2">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-12" />
        </div>
      ) : rows.length ? (
        <div className="divide-y">
          {rows.map((row) => (
            <MonthlyResult key={row.unit} row={row} />
          ))}
        </div>
      ) : (
        <p className="py-3 text-center text-xs text-muted-foreground">
          该月暂无已平仓记录
        </p>
      )}
      <p className="mt-3 text-[10px] leading-4 text-muted-foreground">
        按北京时间平仓月份统计，盈亏已扣费用。
      </p>
    </section>
  );
}
