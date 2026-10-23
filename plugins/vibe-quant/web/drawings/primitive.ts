import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Logical,
} from 'lightweight-charts';
import type { Bar } from '../../shared';
import {
  logicalAtTime,
  barEndTime,
  segmentDistance,
  raySegment,
  type Anchor,
  type Drawing,
  type DrawingPart,
  type Point,
  type PositionDrawing,
} from './model';
import {
  drawPosition,
  hitPosition,
  type PositionGeometry,
} from './position-renderer';
import {
  drawFibonacci,
  fibonacciGeometry,
  hitFibonacci,
} from './fibonacci-renderer';

export type PriceSeries = ISeriesApi<'Candlestick'> | ISeriesApi<'Line'>;

/** A native series primitive follows both chart scales without adding time points. */
export class DrawingPrimitive implements ISeriesPrimitive {
  bars: Bar[] = [];
  drawings: Drawing[] = [];
  selected: string | null = null;
  preview: Drawing | null = null;
  private requestUpdate = () => {};
  private readonly views: IPrimitivePaneView[] = [
    {
      zOrder: () => 'top',
      renderer: () => ({ draw: (target) => this.draw(target) }),
    },
  ];

  constructor(
    private chart: IChartApi,
    private series: PriceSeries,
  ) {}
  attached({ requestUpdate }: SeriesAttachedParameter) {
    this.requestUpdate = requestUpdate;
  }
  detached() {
    this.requestUpdate = () => {};
  }
  paneViews() {
    return this.views;
  }
  refresh() {
    this.requestUpdate();
  }

  point(anchor: Anchor): Point | null {
    const index = logicalAtTime(anchor.time, this.bars);
    if (index === null) return null;
    const x = this.chart.timeScale().logicalToCoordinate(index as Logical);
    const y = this.series.priceToCoordinate(anchor.price);
    return x === null || y === null ? null : { x, y };
  }

  segment(drawing: Drawing): [Point, Point] | null {
    if (!this.bars.length) return null;
    if (drawing.kind === 'horizontal') {
      const y = this.series.priceToCoordinate(drawing.price);
      return y === null
        ? null
        : [
            { x: 0, y },
            { x: this.chart.timeScale().width(), y },
          ];
    }
    const startTime =
      drawing.kind === 'position' ? drawing.start : drawing.start.time;
    const endTime =
      drawing.kind === 'position' ? drawing.end : drawing.end.time;
    const first = this.bars[0].time,
      last = barEndTime(this.bars.at(-1)!);
    if (
      drawing.kind !== 'ray' &&
      !(
        drawing.kind === 'fibonacci' &&
        (drawing.extendLeft || drawing.extendRight)
      ) &&
      (Math.max(startTime, endTime) < first ||
        Math.min(startTime, endTime) > last)
    )
      return null;
    const start = this.point(
        drawing.kind === 'position'
          ? { time: drawing.start, price: drawing.entry }
          : drawing.start,
      ),
      end = this.point(
        drawing.kind === 'position'
          ? { time: drawing.end, price: drawing.entry }
          : drawing.end,
      );
    return start && end ? [start, end] : null;
  }

  private visibleSegment(drawing: Drawing, anchors: [Point, Point]) {
    return drawing.kind === 'ray'
      ? raySegment(
          anchors[0],
          anchors[1],
          this.chart.timeScale().width(),
          this.chart.panes()[0].getHeight(),
        )
      : anchors;
  }

  positionGeometry(drawing: PositionDrawing): PositionGeometry | null {
    const segment = this.segment(drawing);
    const target = this.series.priceToCoordinate(drawing.target),
      stop = this.series.priceToCoordinate(drawing.stop);
    return segment && target !== null && stop !== null
      ? {
          start: segment[0].x,
          end: segment[1].x,
          entry: segment[0].y,
          target,
          stop,
        }
      : null;
  }

  hit(point: Point): { id: string; part: DrawingPart } | null {
    const width = this.chart.timeScale().width(),
      height = this.chart.panes()[0].getHeight();
    if (point.x < 0 || point.x > width || point.y < 0 || point.y > height)
      return null;
    for (const drawing of [...this.drawings].reverse()) {
      if (drawing.kind === 'position') {
        const geometry = this.positionGeometry(drawing);
        const part =
          geometry &&
          hitPosition(point, geometry, drawing.id === this.selected);
        if (part) return { id: drawing.id, part };
        continue;
      }
      const anchors = this.segment(drawing);
      if (!anchors) continue;
      const [start, end] = anchors;
      if (drawing.kind !== 'horizontal' && drawing.id === this.selected) {
        if (Math.hypot(point.x - start.x, point.y - start.y) <= 9)
          return { id: drawing.id, part: 'start' };
        if (Math.hypot(point.x - end.x, point.y - end.y) <= 9)
          return { id: drawing.id, part: 'end' };
      }
      if (drawing.kind === 'fibonacci') {
        const geometry = fibonacciGeometry(drawing, anchors, width, (price) =>
          this.series.priceToCoordinate(price),
        );
        if (geometry && hitFibonacci(point, geometry))
          return { id: drawing.id, part: 'line' };
        continue;
      }
      const segment = this.visibleSegment(drawing, anchors);
      if (segment && segmentDistance(point, ...segment) <= 7)
        return { id: drawing.id, part: 'line' };
    }
    return null;
  }

  hitTest(x: number, y: number) {
    const hit = this.hit({ x, y });
    return hit
      ? {
          externalId: hit.id,
          cursorStyle:
            hit.part === 'line'
              ? 'move'
              : hit.part === 'entry' ||
                  hit.part === 'stop' ||
                  hit.part === 'target'
                ? 'ns-resize'
                : 'crosshair',
          zOrder: 'top' as const,
        }
      : null;
  }

  private draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const dark = document.documentElement.classList.contains('dark');
      const color = dark ? '#60a5fa' : '#2563eb';
      for (const drawing of [
        ...this.drawings,
        ...(this.preview ? [this.preview] : []),
      ]) {
        if (drawing.kind === 'position') {
          const geometry = this.positionGeometry(drawing);
          if (geometry)
            drawPosition(
              ctx,
              geometry,
              drawing,
              drawing.id === this.selected || drawing === this.preview,
              drawing === this.preview,
              mediaSize,
              (price) => this.series.priceFormatter().format(price),
            );
          continue;
        }
        const anchors = this.segment(drawing);
        if (!anchors) continue;
        if (drawing.kind === 'fibonacci') {
          const geometry = fibonacciGeometry(
            drawing,
            anchors,
            mediaSize.width,
            (price) => this.series.priceToCoordinate(price),
          );
          if (geometry)
            drawFibonacci(
              ctx,
              geometry,
              drawing,
              drawing.id === this.selected || drawing === this.preview,
              drawing === this.preview,
              mediaSize,
              (price) => this.series.priceFormatter().format(price),
              dark,
            );
          continue;
        }
        const segment = this.visibleSegment(drawing, anchors);
        if (!segment) continue;
        const [start, end] = segment;
        const selected =
          drawing.id === this.selected || drawing === this.preview;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = selected ? 2.5 : 1.5;
        ctx.lineCap = 'round';
        ctx.setLineDash(drawing === this.preview ? [5, 4] : []);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        if (drawing.kind === 'horizontal') {
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(
            this.series.priceFormatter().format(drawing.price),
            mediaSize.width - 8,
            start.y - 6,
          );
        } else if (selected) {
          ctx.setLineDash([]);
          for (const point of anchors) {
            ctx.beginPath();
            ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    });
  }
}
