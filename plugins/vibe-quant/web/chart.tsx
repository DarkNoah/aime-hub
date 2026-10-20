import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type PriceFormat,
  type UTCTimestamp,
} from 'lightweight-charts';
import { MONTH_DURATION, type Bar } from '../shared';
import { IndicatorRenderer } from './indicators/renderer';
import type { IndicatorPreferences } from './indicators/types';

export function MarketChart({
  bars,
  identity,
  duration,
  intraday = false,
  priceTick,
  indicators,
}: {
  bars: Bar[];
  identity: string;
  duration: number;
  intraday?: boolean;
  priceTick: number;
  indicators: IndicatorPreferences;
}) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const prices = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(
    null,
  );
  const indicatorRenderer = useRef<IndicatorRenderer | null>(null);
  const previous = useRef<Bar[]>([]);
  const fitAfterIndicators = useRef(false);
  useEffect(() => {
    if (!container.current) return;
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: duration >= 86400 ? 'numeric' : undefined,
      month: intraday ? undefined : '2-digit',
      day: intraday || duration === MONTH_DURATION ? undefined : '2-digit',
      hour: duration < 86400 ? '2-digit' : undefined,
      minute: duration < 86400 ? '2-digit' : undefined,
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
        timeVisible: duration < 86400,
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
    const priceFormat: PriceFormat = {
      type: 'price',
      minMove: tick,
      precision: Math.min(
        8,
        Math.max(0, (String(tick).split('.')[1] ?? '').length),
      ),
    };
    prices.current = intraday
      ? api.addSeries(LineSeries, {
          color: '#3b82f6',
          lineWidth: 2,
          title: '分时',
          priceFormat,
        })
      : api.addSeries(CandlestickSeries, {
          upColor: '#cc3e4d',
          downColor: '#248659',
          borderVisible: false,
          wickUpColor: '#cc3e4d',
          wickDownColor: '#248659',
          priceFormat,
        });
    api.panes()[0].setStretchFactor(3);
    indicatorRenderer.current = new IndicatorRenderer(api, priceFormat);
    previous.current = [];
    fitAfterIndicators.current = false;
    return () => {
      observer.disconnect();
      indicatorRenderer.current?.dispose();
      indicatorRenderer.current = null;
      api.remove();
      chart.current = null;
      prices.current = null;
      previous.current = [];
      fitAfterIndicators.current = false;
    };
  }, [identity, priceTick, duration, intraday]);
  useEffect(() => {
    if (!prices.current) return;
    if (!bars.length) {
      prices.current.setData([]);
      previous.current = [];
      return;
    }
    const point = (bar: Bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      value: bar.close,
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
    const newSession = intraday && old[0]?.time !== bars[0].time;
    if (!old.length || historicalChanged || newSession) {
      const range = chart.current?.timeScale().getVisibleLogicalRange();
      prices.current.setData(bars.map(point));
      if (!old.length || newSession) fitAfterIndicators.current = true;
      else if (range) {
        const prependCount = bars.filter(
          (bar) => bar.time < old[0].time,
        ).length;
        chart.current?.timeScale().setVisibleLogicalRange({
          from: range.from + prependCount,
          to: range.to + prependCount,
        });
      }
    } else {
      for (const bar of bars.filter((value) => value.time >= lastTime!)) {
        prices.current.update(point(bar));
      }
    }
    previous.current = bars;
  }, [bars, identity, priceTick, intraday]);
  useEffect(() => {
    indicatorRenderer.current?.update(bars, indicators);
    // Fit only after all series drop the previous session's timestamps.
    if (fitAfterIndicators.current) {
      chart.current?.timeScale().fitContent();
      fitAfterIndicators.current = false;
    }
  }, [bars, indicators, identity, priceTick, intraday]);
  return (
    <div
      ref={container}
      className="h-[440px] min-w-0 flex-1 lg:h-[560px]"
      aria-label={
        intraday
          ? 'TradingView 分时走势与技术指标图表'
          : 'TradingView K 线与技术指标图表'
      }
    />
  );
}
