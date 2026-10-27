import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPaneApi,
  type IPriceLine,
  type ISeriesApi,
  type PriceFormat,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '../../shared';
import { barLabelTime } from '../chart-time';
import { INDICATORS } from './registry';
import { IndicatorDrawingPrimitive } from './drawing-primitive';
import { IndicatorPlotPrimitive } from './plot-primitive';
import type {
  IndicatorContext,
  IndicatorOverlay,
  IndicatorPlot,
  IndicatorPreference,
  IndicatorPreferences,
} from './types';

type PlotSeries = (
  | { type: 'line'; api: ISeriesApi<'Line'>; zeroLine?: IPriceLine }
  | { type: 'histogram'; api: ISeriesApi<'Histogram'> }
) & {
  primitive?: IndicatorPlotPrimitive;
  referenceLines?: Map<number, IPriceLine>;
};

interface Instance {
  pane: IPaneApi<Time>;
  plots: Map<string, PlotSeries>;
  preference?: IndicatorPreference;
  primitive?: IndicatorDrawingPrimitive;
  overlay?: IndicatorOverlay;
  context?: IndicatorContext;
}

/** Reconcile series in place so visibility/settings never recreate the price chart. */
export class IndicatorRenderer {
  private instances = new Map<string, Instance>();
  private previousBars: readonly Bar[] | undefined;
  private coloredCandles = false;
  private warningKey = '';

  constructor(
    private chart: IChartApi,
    private priceFormat: PriceFormat,
    private duration: number,
    private prices: ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>,
    private onWarnings?: (warnings: string[]) => void,
  ) {}

  update(
    bars: readonly Bar[],
    preferences: IndicatorPreferences,
    context?: IndicatorContext,
  ) {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    const definitions = INDICATORS.filter(
      (definition) =>
        preferences[definition.id]?.visible &&
        (!definition.requiresCandles ||
          this.prices.seriesType() === 'Candlestick'),
    );
    for (const [id, instance] of this.instances) {
      if (definitions.some((definition) => definition.id === id)) continue;
      if (instance.primitive) this.prices.detachPrimitive(instance.primitive);
      for (const plot of instance.plots.values()) this.removePlot(plot);
      this.instances.delete(id);
    }
    let subIndex = 1;
    for (const definition of definitions) {
      const preference = preferences[definition.id];
      if (!preference?.visible) continue;
      let instance = this.instances.get(definition.id);
      if (!instance) {
        const pane =
          definition.type === 'main'
            ? this.chart.panes()[0]
            : this.chart.addPane();
        if (definition.type === 'sub')
          pane.setStretchFactor(definition.paneWeight ?? 1);
        instance = { pane, plots: new Map() };
        this.instances.set(definition.id, instance);
      }
      if (definition.type === 'sub') {
        if (instance.pane.paneIndex() !== subIndex)
          instance.pane.moveTo(subIndex);
        subIndex += 1;
      }
      if (
        this.previousBars === bars &&
        instance.preference === preference &&
        (definition.id !== 'volumeProfile' || instance.context === context)
      )
        continue;
      const plots = definition.render(bars, preference.parameters);
      if (definition.renderOverlay) {
        instance.overlay = definition.renderOverlay(
          bars,
          preference.parameters,
          this.duration,
          context,
        );
        if (!instance.primitive) {
          instance.primitive = new IndicatorDrawingPrimitive();
          this.prices.attachPrimitive(instance.primitive);
        }
        instance.primitive.setDrawings(instance.overlay.drawings);
      }
      const format: PriceFormat =
        definition.priceFormat === 'volume'
          ? { type: 'volume', precision: 0, minMove: 1 }
          : definition.type === 'main' &&
              definition.priceFormat !== 'oscillator'
            ? this.priceFormat
            : {
                type: 'price',
                precision: definition.precision ?? 4,
                minMove: 10 ** -(definition.precision ?? 4),
              };
      // Keep the pane while reconciling a script whose set of plots changes.
      instance.pane.setPreserveEmptyPane(true);
      for (const [id, series] of instance.plots) {
        if (plots.some((plot) => plot.id === id && plot.type === series.type))
          continue;
        this.removePlot(series);
        instance.plots.delete(id);
      }
      for (const plot of plots) {
        let series = instance.plots.get(plot.id);
        if (!series) {
          series =
            plot.type === 'line'
              ? {
                  type: 'line',
                  api: instance.pane.addSeries(LineSeries, {
                    priceFormat: format,
                  }),
                }
              : {
                  type: 'histogram',
                  api: instance.pane.addSeries(HistogramSeries, {
                    priceFormat: format,
                  }),
                };
          instance.plots.set(plot.id, series);
        }
        this.updatePlot(series, plot);
      }
      instance.pane.setPreserveEmptyPane(false);
      instance.preference = preference;
      instance.context = context;
    }
    const instances = [...this.instances.values()];
    const warnings = instances.flatMap(
      (instance) => instance.overlay?.warnings ?? [],
    );
    const warningKey = JSON.stringify(warnings);
    if (this.warningKey !== warningKey) {
      this.warningKey = warningKey;
      this.onWarnings?.(warnings);
    }
    const colors = instances.map((instance) => instance.overlay?.candleColors);
    const hasColors = colors.some((values) =>
      values?.some((value) => value !== undefined),
    );
    // Replacing data also clears stale per-candle overrides when a layer is hidden.
    if (
      this.prices.seriesType() === 'Candlestick' &&
      (hasColors || this.coloredCandles)
    ) {
      (this.prices as ISeriesApi<'Candlestick'>).setData(
        bars.map((bar, index) => {
          const color = colors
            .map((values) => values?.[index])
            .findLast((value) => value !== undefined);
          return {
            time: barLabelTime(bar.time, this.duration) as UTCTimestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            ...(color ? { color, borderColor: color, wickColor: color } : {}),
          };
        }),
      );
    }
    this.coloredCandles = hasColors;
    this.previousBars = bars;
    if (range) this.chart.timeScale().setVisibleLogicalRange(range);
  }

  private updatePlot(series: PlotSeries, plot: IndicatorPlot) {
    series.api.applyOptions({
      title: plot.title,
      color: plot.color,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    if (series.type === 'line') {
      series.api.applyOptions({ lineWidth: plot.lineWidth ?? 2 });
      if (plot.zeroLine && !series.zeroLine) {
        series.zeroLine = series.api.createPriceLine({
          price: 0,
          color: '#87948b',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: false,
        });
      } else if (!plot.zeroLine && series.zeroLine) {
        series.api.removePriceLine(series.zeroLine);
        series.zeroLine = undefined;
      }
    }
    series.api.setData(
      plot.data.map((point) => ({
        ...point,
        time: barLabelTime(point.time, this.duration) as UTCTimestamp,
      })),
    );
    const referenceLines = (series.referenceLines ??= new Map());
    for (const [value, line] of referenceLines) {
      if (plot.referenceLines?.some((reference) => reference.value === value))
        continue;
      series.api.removePriceLine(line);
      referenceLines.delete(value);
    }
    for (const reference of plot.referenceLines ?? []) {
      const options = {
        price: reference.value,
        color: reference.color,
        lineWidth: 1 as const,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
      };
      const line = referenceLines.get(reference.value);
      if (line) line.applyOptions(options);
      else
        referenceLines.set(
          reference.value,
          series.api.createPriceLine(options),
        );
    }
    if (plot.overlay) {
      if (!series.primitive) {
        series.primitive = new IndicatorPlotPrimitive();
        series.api.attachPrimitive(series.primitive);
      }
      series.primitive.setOverlay(plot.overlay);
    } else if (series.primitive) {
      series.api.detachPrimitive(series.primitive);
      series.primitive = undefined;
    }
  }

  private removePlot(series: PlotSeries) {
    if (series.primitive) series.api.detachPrimitive(series.primitive);
    this.chart.removeSeries(series.api);
  }

  dispose() {
    for (const instance of this.instances.values()) {
      if (instance.primitive) this.prices.detachPrimitive(instance.primitive);
      for (const series of instance.plots.values()) this.removePlot(series);
    }
    this.instances.clear();
    this.previousBars = undefined;
  }
}
