import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  LineSeries,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestResult } from '../../strategy-types';

export default function EquityChart({
  points,
  initial,
}: {
  points: BacktestResult['equity_curve'];
  initial: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !points.length) return;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' } },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#87948b22' },
      },
      // Multi-year minute curves exceed the default 0.5px minimum spacing.
      timeScale: { borderVisible: false, minBarSpacing: 0.001 },
      rightPriceScale: { borderVisible: false },
      localization: { locale: 'zh-CN' },
    });
    const colors = () =>
      chart.applyOptions({
        layout: {
          textColor:
            getComputedStyle(host.current!)
              .getPropertyValue('--muted-foreground')
              .trim() || '#637368',
        },
      });
    colors();
    const observer = new MutationObserver(colors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    // The SDK can record several account changes at the same clock instant.
    const ordered = [...new Map(points.map((p) => [p.time, p])).values()].sort(
      (a, b) => a.time - b.time,
    );
    chart
      .addSeries(LineSeries, {
        color: '#248659',
        lineWidth: 2,
        title: '策略净值',
        priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
      })
      .setData(
        ordered.map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.equity / initial,
        })),
      );
    chart
      .addSeries(LineSeries, { color: '#8893a5', lineWidth: 1, title: '基准' })
      .setData(
        ordered
          .filter((p) => p.benchmark_equity != null)
          .map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.benchmark_equity! / initial,
          })),
      );
    // Tabs may mount before their final width is known. Fit once a real size
    // arrives, after the chart's own auto-size observer has resized its canvas.
    let frame = 0;
    const sizeObserver = new ResizeObserver(([entry]) => {
      if (!entry?.contentRect.width) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => chart.timeScale().fitContent());
    });
    sizeObserver.observe(host.current);
    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      observer.disconnect();
      chart.remove();
    };
  }, [points, initial]);
  return (
    <div
      ref={host}
      className="h-72 min-w-0"
      role="img"
      aria-label="策略和基准归一化净值曲线"
    />
  );
}
