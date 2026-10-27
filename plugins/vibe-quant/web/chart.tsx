import type { MarketStrategyHint } from '../signal-types';
import {
  strategyHintMarkers,
  strategyHintDrawings,
} from './signals/chart-overlays';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@app/plugin-ui';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type PriceFormat,
  type LogicalRange,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { MONTH_DURATION, type Bar } from '../shared';
import { IndicatorRenderer } from './indicators/renderer';
import type { IndicatorPreferences } from './indicators/types';
import { centeredRange, type PageDirection } from './chart-navigation';
import { DrawingController } from './drawings/controller';
import { DrawingHint, DrawingToolbar } from './drawings/toolbar';
import { EMPTY_DRAWING_STATE, type Drawing } from './drawings/model';
import { ChartReadout, type ChartReadoutHandle } from './chart-readout';
import { pricePrecision } from './readout-format';
import { barLabelTime, barStartTime } from './chart-time';
import { tradeMarkers } from './trade-markers';
import type {
  RiskLevelRecord,
  TradeRecord,
  TradeReplay,
} from '../strategy-types';
import { TradeRiskPrimitive } from './trade-risk-primitive';
import { tradeRiskDrawings } from './trade-risk';
import { exitMarkerLabel } from './trade-exit';
import {
  useVolumeProfile,
  type VolumeProfileSource,
} from './indicators/main/volume-profile/use-volume-profile';

export function MarketChart({
  bars,
  identity,
  duration,
  intraday = false,
  priceTick,
  indicators,
  targetTime = null,
  historical = false,
  onLoadMore,
  drawingScope = identity,
  drawingSharedScope = drawingScope,
  trade,
  markerTimes,
  riskLevels,
  strategyHints,
  showDrawingTools = true,
  volumeProfileSource,
  replay = false,
  onSelectReplayTime,
}: {
  bars: Bar[];
  identity: string;
  duration: number;
  intraday?: boolean;
  priceTick: number;
  indicators: IndicatorPreferences;
  targetTime?: number | null;
  historical?: boolean;
  onLoadMore?: (direction: PageDirection) => void;
  drawingScope?: string;
  drawingSharedScope?: string;
  trade?: TradeRecord;
  markerTimes?: TradeReplay['markerTimes'];
  riskLevels?: readonly RiskLevelRecord[];
  strategyHints?: readonly MarketStrategyHint[];
  showDrawingTools?: boolean;
  volumeProfileSource?: VolumeProfileSource;
  replay?: boolean;
  onSelectReplayTime?: (time: number) => void;
}) {
  const hasStrategyHints = strategyHints !== undefined;
  const container = useRef<HTMLDivElement>(null);
  const readout = useRef<ChartReadoutHandle | null>(null);
  const chart = useRef<IChartApi | null>(null);
  const prices = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(
    null,
  );
  const indicatorRenderer = useRef<IndicatorRenderer | null>(null);
  const riskRenderer = useRef<TradeRiskPrimitive | null>(null);
  const previous = useRef<Bar[]>([]);
  const fitAfterIndicators = useRef(false);
  const rangeAfterIndicators = useRef<{ from: number; to: number } | null>(
    null,
  );
  const focused = useRef(false);
  const applyingData = useRef(false);
  const userInput = useRef(false);
  const loadMore = useRef(onLoadMore);
  loadMore.current = onLoadMore;
  const selectReplayTime = useRef(onSelectReplayTime);
  selectReplayTime.current = onSelectReplayTime;
  const updateFrame = useRef(0);
  const warningFrame = useRef(0);
  const drawingController = useRef<DrawingController | null>(null);
  const drawingCache = useRef(new Map<string, Drawing[]>());
  const [drawingState, setDrawingState] = useState(EMPTY_DRAWING_STATE);
  const [indicatorWarnings, setIndicatorWarnings] = useState<string[]>([]);
  const [profileViewport, setProfileViewport] = useState({
    identity: '',
    from: 0,
    to: 0,
  });
  const viewport =
    profileViewport.identity === identity
      ? profileViewport
      : { from: Math.max(0, bars.length - 200), to: bars.length - 1 };
  const firstVisible =
    bars[Math.max(0, Math.min(bars.length - 1, viewport.from))]?.time;
  const lastVisible =
    bars[Math.max(0, Math.min(bars.length - 1, viewport.to))]?.time;
  const profile = useVolumeProfile(
    volumeProfileSource,
    indicators.volumeProfile,
    firstVisible,
    lastVisible === undefined ? undefined : lastVisible + duration,
    duration,
    historical,
    intraday,
    bars.length ? bars[bars.length - 1].time + duration : undefined,
    identity,
  );
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
    const formatTime = (time: number) =>
      formatter.format(new Date(time * 1000));
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
        rightOffset: hasStrategyHints ? 18 : 5,
        tickMarkFormatter: formatTime,
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: formatTime,
      },
      crosshair: { mode: 0 },
    });
    chart.current = api;
    const onCrosshairMove = (event: MouseEventParams) => {
      readout.current?.update(
        typeof event.time === 'number'
          ? barStartTime(event.time, duration)
          : null,
        event.point !== undefined,
      );
    };
    api.subscribeCrosshairMove(onCrosshairMove);
    const onClick = (event: MouseEventParams) => {
      if (
        !selectReplayTime.current ||
        typeof event.time !== 'number' ||
        event.paneIndex !== 0
      )
        return;
      const time = barStartTime(event.time, duration);
      if (previous.current.some((bar) => bar.time === time))
        selectReplayTime.current(time);
    };
    api.subscribeClick(onClick);
    let previousRange: LogicalRange | null = null;
    let edgeTimer: ReturnType<typeof setTimeout>;
    let profileTimer: ReturnType<typeof setTimeout>;
    const pendingEdges = new Set<PageDirection>();
    const onRangeChange = (range: LogicalRange | null) => {
      clearTimeout(profileTimer);
      if (range)
        profileTimer = setTimeout(() => {
          const from = Math.floor(range.from),
            to = Math.ceil(range.to);
          setProfileViewport((old) =>
            old.identity === identity && old.from === from && old.to === to
              ? old
              : { identity, from, to },
          );
        }, 150);
      const oldRange = previousRange;
      previousRange = range;
      const requestedByUser = userInput.current;
      userInput.current = false;
      if (applyingData.current) {
        clearTimeout(edgeTimer);
        pendingEdges.clear();
        return;
      }
      if (intraday || !requestedByUser || !range || !oldRange) return;
      if (range.from < oldRange.from && range.from < 20)
        pendingEdges.add('before');
      if (range.to > oldRange.to && range.to > previous.current.length - 21)
        pendingEdges.add('after');
      clearTimeout(edgeTimer);
      edgeTimer = setTimeout(() => {
        for (const direction of pendingEdges) loadMore.current?.(direction);
        pendingEdges.clear();
      }, 120);
    };
    api.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
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
    const tick = Number.isFinite(priceTick) && priceTick > 0 ? priceTick : 0.01;
    const priceFormat: PriceFormat = {
      type: 'price',
      minMove: tick,
      precision: pricePrecision(tick),
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
    riskRenderer.current = new TradeRiskPrimitive();
    prices.current.attachPrimitive(riskRenderer.current);
    indicatorRenderer.current = new IndicatorRenderer(
      api,
      priceFormat,
      duration,
      prices.current,
      (warnings) => {
        // Warm-up warnings change with each revealed candle. Coalesce them to
        // the next frame instead of nesting state updates inside data effects.
        cancelAnimationFrame(warningFrame.current);
        warningFrame.current = requestAnimationFrame(() =>
          setIndicatorWarnings(warnings),
        );
      },
    );
    drawingController.current = showDrawingTools
      ? new DrawingController(
          api,
          prices.current,
          container.current,
          drawingScope,
          drawingSharedScope,
          drawingCache.current,
          setDrawingState,
        )
      : null;
    previous.current = [];
    fitAfterIndicators.current = false;
    rangeAfterIndicators.current = null;
    focused.current = false;
    userInput.current = false;
    return () => {
      clearTimeout(edgeTimer);
      clearTimeout(profileTimer);
      cancelAnimationFrame(updateFrame.current);
      cancelAnimationFrame(warningFrame.current);
      api.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      api.unsubscribeCrosshairMove(onCrosshairMove);
      api.unsubscribeClick(onClick);
      observer.disconnect();
      drawingController.current?.dispose();
      drawingController.current = null;
      indicatorRenderer.current?.dispose();
      indicatorRenderer.current = null;
      if (riskRenderer.current)
        prices.current?.detachPrimitive(riskRenderer.current);
      riskRenderer.current = null;
      api.remove();
      chart.current = null;
      prices.current = null;
      previous.current = [];
      fitAfterIndicators.current = false;
    };
  }, [
    identity,
    priceTick,
    duration,
    intraday,
    drawingScope,
    drawingSharedScope,
    showDrawingTools,
    hasStrategyHints,
  ]);
  const pickingReplay = !!onSelectReplayTime;
  useEffect(() => {
    drawingController.current?.setEnabled(!pickingReplay);
    if (pickingReplay) container.current?.focus({ preventScroll: true });
  }, [
    pickingReplay,
    identity,
    priceTick,
    duration,
    intraday,
    drawingScope,
    drawingSharedScope,
    showDrawingTools,
    hasStrategyHints,
  ]);
  useEffect(() => {
    if (!prices.current) return;
    if (!bars.length) {
      prices.current.setData([]);
      drawingController.current?.updateBars([]);
      previous.current = [];
      return;
    }
    const point = (bar: Bar) => ({
      time: barLabelTime(bar.time, duration) as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      value: bar.close,
    });
    const old = previous.current;
    applyingData.current = true;
    cancelAnimationFrame(updateFrame.current);
    updateFrame.current = requestAnimationFrame(() => {
      applyingData.current = false;
    });
    const range = chart.current?.timeScale().getVisibleLogicalRange();
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
              prev.volume !== bar.volume ||
              prev.amount !== bar.amount
            );
          })(),
      );
    const newSession = intraday && old[0]?.time !== bars[0].time;
    const appended =
      lastTime === undefined
        ? 0
        : bars.filter((bar) => bar.time > lastTime).length;
    const truncated =
      bars.length < old.length ||
      (lastTime !== undefined && bars.at(-1)!.time < lastTime);
    if (
      !old.length ||
      historicalChanged ||
      newSession ||
      appended > 1 ||
      truncated
    ) {
      prices.current.setData(bars.map(point));
      if (!old.length || newSession) fitAfterIndicators.current = true;
      else if (range) {
        const prependCount = bars.filter(
          (bar) => bar.time < old[0].time,
        ).length;
        rangeAfterIndicators.current = {
          from: range.from + prependCount,
          to: range.to + prependCount,
        };
      }
    } else {
      for (const bar of bars.filter((value) => value.time >= lastTime!)) {
        prices.current.update(point(bar));
      }
      if (historical && range) rangeAfterIndicators.current = range;
    }
    if (replay && old.length && range) {
      // Follow the revealed edge while retaining the user's zoom. A pan into
      // earlier history stays put until the replay edge leaves the viewport.
      const delta = bars.length - old.length;
      rangeAfterIndicators.current =
        range.to >= old.length - 1 || bars.length - 1 < range.from
          ? { from: range.from + delta, to: range.to + delta }
          : range;
    }
    previous.current = bars;
    drawingController.current?.updateBars(bars);
  }, [
    bars,
    identity,
    priceTick,
    intraday,
    historical,
    duration,
    drawingScope,
    drawingSharedScope,
    replay,
  ]);
  useEffect(() => {
    indicatorRenderer.current?.update(bars, indicators, profile.context);
    // Fit only after all series drop the previous session's timestamps.
    if (fitAfterIndicators.current) {
      chart.current?.timeScale().fitContent();
      fitAfterIndicators.current = false;
    }
    if (rangeAfterIndicators.current) {
      chart.current
        ?.timeScale()
        .setVisibleLogicalRange(rangeAfterIndicators.current);
      rangeAfterIndicators.current = null;
    }
    if (!focused.current && targetTime !== null) {
      const range = centeredRange(bars, targetTime);
      if (range) {
        chart.current?.timeScale().setVisibleLogicalRange(range);
        focused.current = true;
      }
    }
  }, [
    bars,
    indicators,
    profile.context,
    identity,
    priceTick,
    intraday,
    targetTime,
    duration,
    historical,
    drawingScope,
    drawingSharedScope,
  ]);
  useEffect(() => {
    const series = prices.current;
    if (!series || !trade) return;
    const visibleMarkers = tradeMarkers(
      trade,
      bars,
      duration,
      priceTick,
      markerTimes,
    );
    const markers = createSeriesMarkers(series, visibleMarkers);
    const lines: IPriceLine[] = [];
    if (!replay || visibleMarkers.some((marker) => marker.color === '#2563eb'))
      lines.push(
        series.createPriceLine({
          price: trade.entry_price,
          color: '#2563eb',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: '入场',
        }),
      );
    if (
      trade.exit_price !== null &&
      (!replay || visibleMarkers.some((marker) => marker.color === '#d97706'))
    )
      lines.push(
        series.createPriceLine({
          price: trade.exit_price,
          color: '#d97706',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: exitMarkerLabel(trade.exit_reason),
        }),
      );
    return () => {
      markers.detach();
      for (const line of lines) series.removePriceLine(line);
    };
  }, [
    trade,
    markerTimes,
    bars,
    duration,
    identity,
    priceTick,
    intraday,
    drawingScope,
    drawingSharedScope,
    showDrawingTools,
    replay,
  ]);
  useEffect(() => {
    const series = prices.current;
    if (!series || !strategyHints) return;
    const markers = createSeriesMarkers(
      series,
      strategyHintMarkers(strategyHints, bars, duration, priceTick),
    );
    return () => markers.detach();
  }, [
    strategyHints,
    bars,
    duration,
    priceTick,
    identity,
    intraday,
    drawingScope,
    drawingSharedScope,
    showDrawingTools,
  ]);
  useEffect(() => {
    riskRenderer.current?.setDrawings([
      ...(trade && riskLevels
        ? tradeRiskDrawings(trade, riskLevels, bars, duration, priceTick)
        : []),
      ...strategyHintDrawings(strategyHints ?? [], bars, duration, priceTick),
    ]);
  }, [
    trade,
    riskLevels,
    strategyHints,
    bars,
    duration,
    identity,
    priceTick,
    intraday,
    drawingScope,
    drawingSharedScope,
    showDrawingTools,
  ]);
  return (
    <div className="relative flex min-h-[440px] min-w-0 flex-1 lg:min-h-[560px]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChartReadout
          key={identity}
          ref={readout}
          bars={bars}
          priceTick={priceTick}
          replay={replay}
        />
        {profile.enabled && (
          <div
            className="flex flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground"
            role="status"
          >
            <Badge variant="outline" className="text-[10px]">
              成交量分布
            </Badge>
            <span>
              {profile.pending
                ? '正在读取分笔…'
                : `${profile.count} 段 · 通达信分笔 · 红：买入 / 绿：卖出 / 灰：中性`}
            </span>
            {!!indicators.volumeProfile?.parameters.showCurrent && (
              <span>含未完成区间</span>
            )}
          </div>
        )}
        {indicatorWarnings.length > 0 && (
          <div
            className="flex min-w-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground"
            role="status"
          >
            <Badge variant="outline" className="shrink-0 text-[10px]">
              指标
            </Badge>
            <span className="truncate" title={indicatorWarnings.join('\n')}>
              {indicatorWarnings.join(' ')}
            </span>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <div
            ref={container}
            tabIndex={0}
            onPointerDownCapture={() => {
              userInput.current = true;
            }}
            onPointerMoveCapture={(event) => {
              if (!event.buttons) return;
              userInput.current = true;
              // Drawing drags consume native chart events; keep their readout live too.
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = event.clientX - bounds.left;
              const y = event.clientY - bounds.top;
              const api = chart.current;
              const inside =
                !!api &&
                x >= 0 &&
                x < api.timeScale().width() &&
                y >= 0 &&
                y < bounds.height;
              const time = inside ? api!.timeScale().coordinateToTime(x) : null;
              readout.current?.update(
                typeof time === 'number' ? barStartTime(time, duration) : null,
                inside,
              );
            }}
            onPointerLeave={() => readout.current?.update(null, false)}
            onWheelCapture={() => {
              userInput.current = true;
            }}
            className={`h-full min-w-0 focus-visible:outline-2 focus-visible:outline-ring ${pickingReplay ? 'cursor-crosshair' : ''}`}
            aria-label={
              intraday
                ? 'TradingView 分时走势与技术指标图表'
                : 'TradingView K 线与技术指标图表'
            }
          />
          <DrawingHint state={drawingState} />
          {pickingReplay && (
            <div
              className="pointer-events-none absolute top-2 left-2 rounded-md border bg-card px-2 py-1 text-xs text-foreground"
              role="status"
            >
              点选 K 线开始回放
            </div>
          )}
        </div>
      </div>
      {!!bars.length && showDrawingTools && (
        <DrawingToolbar
          key={drawingScope}
          disabled={pickingReplay}
          state={drawingState}
          onTool={(tool) => drawingController.current?.setTool(tool)}
          onDelete={() => drawingController.current?.deleteSelected()}
          onClear={() => drawingController.current?.clear()}
          onCrossPeriod={(value) =>
            drawingController.current?.setCrossPeriod(value)
          }
          onFibonacciOptions={(options) =>
            drawingController.current?.setFibonacciOptions(options)
          }
        />
      )}
    </div>
  );
}
