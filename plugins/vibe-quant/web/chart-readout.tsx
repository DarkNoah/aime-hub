import { useImperativeHandle, useMemo, useState, type Ref } from 'react';
import { Badge } from '@app/plugin-ui';
import type { Bar } from '../shared';
import { pricePrecision, readoutQuantity, readoutTime } from './readout-format';
import { barLabelTime } from './chart-time';

export interface ChartReadoutHandle {
  update: (time: number | null, inside: boolean) => void;
}

/** Mouse movement only renders this small readout, not the chart or indicators. */
export function ChartReadout({
  bars,
  priceTick,
  replay = false,
  ref,
}: {
  bars: Bar[];
  priceTick: number;
  replay?: boolean;
  ref: Ref<ChartReadoutHandle>;
}) {
  const [selection, setSelection] = useState<number | 'latest' | 'empty'>(
    'latest',
  );
  const byTime = useMemo(
    () => new Map(bars.map((bar) => [bar.time, bar])),
    [bars],
  );
  useImperativeHandle(
    ref,
    () => ({
      update: (time, inside) =>
        setSelection(!inside ? 'latest' : (time ?? 'empty')),
    }),
    [],
  );
  const bar =
    selection === 'latest'
      ? bars.at(-1)
      : typeof selection === 'number'
        ? byTime.get(selection)
        : undefined;
  const time = bar ? barLabelTime(bar.time, bar.duration) : undefined;
  const precision = pricePrecision(priceTick);
  const format = useMemo(
    () =>
      new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      }),
    [precision],
  );
  const price = (value?: number) =>
    value === undefined || !Number.isFinite(value) ? '—' : format.format(value);
  const color =
    bar && bar.close !== bar.open
      ? bar.close > bar.open
        ? 'text-[#cc3e4d] dark:text-rose-400'
        : 'text-[#248659] dark:text-emerald-400'
      : '';
  return (
    <section
      aria-label="指针行情"
      className="@container/readout shrink-0 border-b bg-card px-3 py-2 text-[11px] tabular-nums"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex basis-full items-center gap-2 @min-[780px]/readout:basis-auto">
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {bar
              ? selection === 'latest'
                ? replay
                  ? '回放'
                  : '最新'
                : '指针'
              : '暂无数据'}
          </Badge>
          <time
            dateTime={
              time === undefined
                ? undefined
                : new Date(time * 1000).toISOString()
            }
            title={
              bar && bar.duration < 86400
                ? 'K 线结束时间 · 中国标准时间 UTC+8'
                : '中国标准时间 UTC+8'
            }
          >
            {readoutTime(time)}
          </time>
          <span className="text-[10px] text-muted-foreground">UTC+8</span>
        </div>
        <dl className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {(['open', 'high', 'low', 'close'] as const).map((key, index) => (
            <div
              key={key}
              className="flex items-baseline gap-1 whitespace-nowrap"
            >
              <dt className="text-muted-foreground">
                {['开', '高', '低', '收'][index]}
              </dt>
              <dd className={color}>{price(bar?.[key])}</dd>
            </div>
          ))}
          <div
            className="flex items-baseline gap-1 whitespace-nowrap"
            title={
              bar
                ? `成交量 ${bar.volume.toLocaleString('zh-CN')}（数据源单位）`
                : undefined
            }
          >
            <dt className="text-muted-foreground">成交量</dt>
            <dd>{readoutQuantity(bar?.volume)}</dd>
          </div>
          <div
            className="flex items-baseline gap-1 whitespace-nowrap"
            title={
              bar
                ? bar.amount == null
                  ? '成交额未提供，或该区间 Tick 数据不完整'
                  : `成交额 ${bar.amount.toLocaleString('zh-CN')} 元`
                : undefined
            }
          >
            <dt className="text-muted-foreground">成交额</dt>
            <dd>{readoutQuantity(bar?.amount, true)}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
