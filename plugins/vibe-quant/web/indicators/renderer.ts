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
import { INDICATORS } from './registry';
import type {
  IndicatorPlot,
  IndicatorPreference,
  IndicatorPreferences,
} from './types';

type PlotSeries =
  | { type: 'line'; api: ISeriesApi<'Line'>; zeroLine?: IPriceLine }
  | { type: 'histogram'; api: ISeriesApi<'Histogram'> };

interface Instance {
  pane: IPaneApi<Time>;
  plots: Map<string, PlotSeries>;
  preference?: IndicatorPreference;
}

/** Reconcile series in place so visibility/settings never recreate the price chart. */
export class IndicatorRenderer {
  private instances = new Map<string, Instance>();
  private previousBars: readonly Bar[] | undefined;

  constructor(
    private chart: IChartApi,
    private priceFormat: PriceFormat,
  ) {}

  update(bars: readonly Bar[], preferences: IndicatorPreferences) {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    for (const [id, instance] of this.instances) {
      if (preferences[id]?.visible) continue;
      for (const plot of instance.plots.values())
        this.chart.removeSeries(plot.api);
      this.instances.delete(id);
    }
    let subIndex = 1;
    for (const definition of INDICATORS) {
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
      if (this.previousBars === bars && instance.preference === preference)
        continue;
      const plots = definition.render(bars, preference.parameters);
      const format: PriceFormat =
        definition.priceFormat === 'volume'
          ? { type: 'volume', precision: 0, minMove: 1 }
          : definition.type === 'main' &&
              definition.priceFormat !== 'oscillator'
            ? this.priceFormat
            : { type: 'price', precision: 4, minMove: 0.0001 };
      // Keep the pane while reconciling a script whose set of plots changes.
      instance.pane.setPreserveEmptyPane(true);
      for (const [id, series] of instance.plots) {
        if (plots.some((plot) => plot.id === id && plot.type === series.type))
          continue;
        this.chart.removeSeries(series.api);
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
    }
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
        time: point.time as UTCTimestamp,
      })),
    );
  }

  dispose() {
    for (const instance of this.instances.values()) {
      for (const series of instance.plots.values())
        this.chart.removeSeries(series.api);
    }
    this.instances.clear();
    this.previousBars = undefined;
  }
}
