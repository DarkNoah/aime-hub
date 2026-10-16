import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '../shared';

export function MarketChart({
  bars,
  identity,
  priceTick,
}: {
  bars: Bar[];
  identity: string;
  priceTick: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const previous = useRef<Bar[]>([]);
  useEffect(() => {
    if (!container.current) return;
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const api = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: true },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#87948b22' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        rightOffset: 5,
        tickMarkFormatter: (time: number) =>
          formatter.format(new Date(time * 1000)),
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: number) =>
          formatter.format(new Date(time * 1000)),
      },
      crosshair: { mode: 0 },
    });
    chart.current = api;
    const colors = () => {
      const style = getComputedStyle(container.current!);
      api.applyOptions({
        layout: {
          background: {
            type: ColorType.Solid,
            color: style.getPropertyValue('--card').trim() || '#ffffff',
          },
          textColor:
            style.getPropertyValue('--muted-foreground').trim() || '#5e6b63',
        },
      });
    };
    colors();
    const observer = new MutationObserver(colors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    const tick = priceTick > 0 ? priceTick : 0.01;
    candles.current = api.addSeries(CandlestickSeries, {
      upColor: '#cc3e4d',
      downColor: '#248659',
      borderVisible: false,
      wickUpColor: '#cc3e4d',
      wickDownColor: '#248659',
      priceFormat: {
        type: 'price',
        minMove: tick,
        precision: Math.min(
          8,
          Math.max(0, (String(tick).split('.')[1] ?? '').length),
        ),
      },
    });
    volume.current = api.addSeries(
      HistogramSeries,
      { priceFormat: { type: 'volume' }, priceScaleId: '' },
      1,
    );
    api.panes()[1].setHeight(110);
    previous.current = [];
    return () => {
      observer.disconnect();
      api.remove();
      chart.current = null;
      candles.current = null;
      volume.current = null;
      previous.current = [];
    };
  }, [identity, priceTick]);
  useEffect(() => {
    if (!candles.current || !volume.current || !bars.length) return;
    const candle = (bar: Bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
    const histogram = (bar: Bar) => ({
      time: bar.time as UTCTimestamp,
      value: bar.volume,
      color: bar.close >= bar.open ? '#cc3e4d80' : '#24865980',
    });
    const old = previous.current;
    const oldByTime = new Map(old.map((bar) => [bar.time, bar]));
    const lastTime = old.at(-1)?.time;
    const historicalChanged =
      old.length > 0 &&
      bars.some(
        (bar) =>
          bar.time < lastTime! &&
          (() => {
            const prev = oldByTime.get(bar.time);
            return (
              !prev ||
              prev.open !== bar.open ||
              prev.high !== bar.high ||
              prev.low !== bar.low ||
              prev.close !== bar.close ||
              prev.volume !== bar.volume
            );
          })(),
      );
    if (!old.length || historicalChanged) {
      const range = chart.current?.timeScale().getVisibleLogicalRange();
      candles.current.setData(bars.map(candle));
      volume.current.setData(bars.map(histogram));
      if (!old.length) chart.current?.timeScale().fitContent();
      else if (range) {
        const prependCount = bars.filter(
          (bar) => bar.time < old[0].time,
        ).length;
        chart.current
          ?.timeScale()
          .setVisibleLogicalRange({
            from: range.from + prependCount,
            to: range.to + prependCount,
          });
      }
    } else {
      for (const bar of bars.filter((value) => value.time >= lastTime!)) {
        candles.current.update(candle(bar));
        volume.current.update(histogram(bar));
      }
    }
    previous.current = bars;
  }, [bars, identity, priceTick]);
  return (
    <div
      ref={container}
      className="h-[440px] min-w-0 flex-1 lg:h-[560px]"
      aria-label="TradingView K 线与成交量图表"
    />
  );
}
