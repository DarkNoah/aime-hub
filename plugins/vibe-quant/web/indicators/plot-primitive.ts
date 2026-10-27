import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
} from 'lightweight-charts';
import { IndicatorDrawingPrimitive } from './drawing-primitive';
import type { IndicatorPlotOverlay } from './types';

/** Plot-local fills and labels follow the oscillator's own pane and scale. */
export class IndicatorPlotPrimitive implements ISeriesPrimitive {
  private attachedTo?: SeriesAttachedParameter;
  private overlay: IndicatorPlotOverlay = { drawings: [], fills: [] };
  private readonly drawings = new IndicatorDrawingPrimitive();
  private readonly views: IPrimitivePaneView[] = [
    {
      zOrder: () => 'bottom',
      renderer: () => ({ draw: (target) => this.drawFills(target) }),
    },
    ...this.drawings.paneViews(),
  ];

  attached(parameter: SeriesAttachedParameter) {
    this.attachedTo = parameter;
    this.drawings.attached(parameter);
  }
  detached() {
    this.attachedTo = undefined;
    this.drawings.detached();
  }
  paneViews() {
    return this.views;
  }
  autoscaleInfo() {
    const range = this.overlay.valueRange;
    return range
      ? { priceRange: { minValue: range.min, maxValue: range.max } }
      : null;
  }
  setOverlay(overlay: IndicatorPlotOverlay) {
    this.overlay = overlay;
    this.drawings.setDrawings(overlay.drawings);
  }

  private drawFills(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    const attached = this.attachedTo;
    if (!attached) return;
    const scale = attached.chart.timeScale();
    const price = (value: number) => attached.series.priceToCoordinate(value);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, mediaSize.width, mediaSize.height);
      ctx.clip();
      for (const fill of this.overlay.fills) {
        ctx.fillStyle = fill.color;
        if (fill.gradient) {
          const top = price(fill.gradient.top),
            bottom = price(fill.gradient.bottom);
          if (top === null || bottom === null) continue;
          const gradient = ctx.createLinearGradient(0, top, 0, bottom);
          gradient.addColorStop(0, fill.gradient.topColor);
          gradient.addColorStop(1, fill.gradient.bottomColor);
          ctx.fillStyle = gradient;
        }
        if (fill.kind === 'band') {
          const top = price(fill.top),
            bottom = price(fill.bottom);
          if (top !== null && bottom !== null)
            ctx.fillRect(
              0,
              Math.min(top, bottom),
              mediaSize.width,
              Math.abs(bottom - top),
            );
          continue;
        }
        let segment: { x: number; top: number; bottom: number }[] = [];
        const flush = () => {
          if (segment.length > 1) {
            ctx.beginPath();
            ctx.moveTo(segment[0].x, segment[0].top);
            for (let i = 1; i < segment.length; i++)
              ctx.lineTo(segment[i].x, segment[i].top);
            for (let i = segment.length - 1; i >= 0; i--)
              ctx.lineTo(segment[i].x, segment[i].bottom);
            ctx.closePath();
            ctx.fill();
          }
          segment = [];
        };
        for (const point of fill.data) {
          if (
            point.upper === undefined ||
            point.lower === undefined ||
            !Number.isFinite(point.upper) ||
            !Number.isFinite(point.lower)
          ) {
            flush();
            continue;
          }
          const x = scale.logicalToCoordinate(point.index as Logical);
          const top = price(point.upper),
            bottom = price(point.lower);
          if (x === null || top === null || bottom === null) {
            flush();
            continue;
          }
          segment.push({ x, top, bottom });
        }
        flush();
      }
      ctx.restore();
    });
  }
}
