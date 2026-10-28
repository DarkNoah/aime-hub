import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  LineSeries,
  type UTCTimestamp,
} from 'lightweight-charts';

const colors = [
  '#64748b',
  '#c17a19',
  '#8066b6',
  '#27878c',
  '#248659',
  '#b85261',
  '#748524',
  '#547ab5',
  '#a46a40',
  '#746284',
  '#d15a29',
];
export default function FactorChart({
  series,
  label,
  percent = false,
}: {
  series: { name: string; points: { time: number; value: number | null }[] }[];
  label: string;
  percent?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' } },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#87948b22' },
      },
      timeScale: { borderVisible: false, minBarSpacing: 0.01 },
      rightPriceScale: { borderVisible: false },
      localization: { locale: 'zh-CN' },
    });
    const theme = () =>
      chart.applyOptions({
        layout: {
          textColor:
            getComputedStyle(host.current!)
              .getPropertyValue('--foreground')
              .trim() || '#64748b',
        },
      });
    theme();
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    series.forEach((item, index) =>
      chart
        .addSeries(LineSeries, {
          title: item.name,
          color: colors[index % colors.length],
          lineWidth: 2,
          priceFormat: percent
            ? { type: 'percent', precision: 2, minMove: 0.01 }
            : { type: 'price', precision: 3, minMove: 0.001 },
        })
        .setData(
          item.points.map((p) =>
            p.value === null
              ? { time: p.time as UTCTimestamp }
              : {
                  time: p.time as UTCTimestamp,
                  value: p.value * (percent ? 100 : 1),
                },
          ),
        ),
    );
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => chart.timeScale().fitContent());
    });
    resize.observe(host.current);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      chart.remove();
    };
  }, [series, percent]);
  return (
    <div>
      <div ref={host} className="h-64 min-w-0" role="img" aria-label={label} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {series.map((item, index) => (
          <span key={item.name} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: colors[index % colors.length] }}
            />
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}
