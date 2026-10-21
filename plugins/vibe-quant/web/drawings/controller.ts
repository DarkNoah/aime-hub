import type { IChartApi } from 'lightweight-charts';
import { toast } from 'sonner';
import type { Bar } from '../../shared';
import { DrawingPrimitive, type PriceSeries } from './primitive';
import {
  drawingStorageKey,
  sharedDrawingStorageKey,
  moveDrawing,
  createPosition,
  adjustPosition,
  parseDrawings,
  type Anchor,
  type Drawing,
  type DrawingPart,
  type DrawingState,
  type DrawingTool,
  type Point,
} from './model';

export class DrawingController {
  readonly primitive: DrawingPrimitive;
  private tool: DrawingTool = 'cursor';
  private first: Anchor | null = null;
  private placementOrigin: Point | null = null;
  private placementDragged = false;
  private pointer: number | null = null;
  private drag: {
    original: Drawing;
    part: DrawingPart;
    logical: number;
    price: number;
  } | null = null;
  private readonly initialScroll;
  private readonly initialScale;
  private readonly initialTouchAction: string;
  private readonly localKey: string;
  private readonly sharedKey: string;
  private defaultCrossPeriod = false;

  constructor(
    private chart: IChartApi,
    private series: PriceSeries,
    private container: HTMLDivElement,
    scope: string,
    sharedScope: string,
    private cache: Map<string, Drawing[]>,
    private onState: (state: DrawingState) => void,
  ) {
    this.initialScroll = structuredClone(chart.options().handleScroll);
    this.initialScale = structuredClone(chart.options().handleScale);
    this.initialTouchAction = container.style.touchAction;
    this.localKey = drawingStorageKey(scope);
    this.sharedKey = sharedDrawingStorageKey(sharedScope);
    this.primitive = new DrawingPrimitive(chart, series);
    for (const key of [this.localKey, this.sharedKey]) {
      if (cache.has(key)) continue;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(key);
      } catch {
        /* in-memory editing remains available */
      }
      cache.set(key, parseDrawings(stored));
    }
    this.primitive.drawings = [
      ...new Map(
        [
          ...cache.get(this.localKey)!,
          ...cache
            .get(this.sharedKey)!
            .map((drawing) => ({ ...drawing, crossPeriod: true })),
        ].map((drawing) => [drawing.id, drawing]),
      ).values(),
    ];
    try {
      this.defaultCrossPeriod =
        localStorage.getItem(`${this.sharedKey}:default`) === 'true';
    } catch {
      /* use current-period default */
    }
    series.attachPrimitive(this.primitive);
    container.addEventListener('pointerdown', this.down, true);
    container.addEventListener('pointermove', this.move, true);
    container.addEventListener('pointerup', this.up, true);
    container.addEventListener('pointercancel', this.cancelPointer, true);
    container.addEventListener('keydown', this.keydown);
    this.publish();
  }

  updateBars(bars: Bar[]) {
    this.primitive.bars = bars;
    this.primitive.refresh();
  }

  setTool(tool: DrawingTool) {
    this.cancel();
    this.tool = tool;
    this.primitive.selected = null;
    this.interacting(tool !== 'cursor');
    this.container.focus({ preventScroll: true });
    this.publish();
  }

  deleteSelected() {
    if (!this.primitive.selected) return;
    this.primitive.drawings = this.primitive.drawings.filter(
      (item) => item.id !== this.primitive.selected,
    );
    this.primitive.selected = null;
    this.persist();
    this.publish();
    toast.success('已删除划线');
  }

  setCrossPeriod(crossPeriod: boolean) {
    if (this.primitive.selected) {
      this.primitive.drawings = this.primitive.drawings.map((drawing) =>
        drawing.id === this.primitive.selected
          ? { ...drawing, crossPeriod }
          : drawing,
      );
      this.persist();
      toast.success(
        crossPeriod
          ? '该划线已在同一标的的所有周期显示'
          : '该划线仅在当前周期显示',
      );
    } else {
      this.defaultCrossPeriod = crossPeriod;
      try {
        localStorage.setItem(`${this.sharedKey}:default`, String(crossPeriod));
      } catch {
        this.storageError();
      }
    }
    this.publish();
  }

  clear() {
    this.cancel();
    this.primitive.drawings = [];
    this.primitive.selected = null;
    this.persist();
    this.publish();
    toast.success('已清空当前视图的划线');
  }

  dispose() {
    this.cancel();
    this.container.removeEventListener('pointerdown', this.down, true);
    this.container.removeEventListener('pointermove', this.move, true);
    this.container.removeEventListener('pointerup', this.up, true);
    this.container.removeEventListener(
      'pointercancel',
      this.cancelPointer,
      true,
    );
    this.container.removeEventListener('keydown', this.keydown);
    this.series.detachPrimitive(this.primitive);
  }

  private publish() {
    this.primitive.refresh();
    const selected = this.primitive.drawings.find(
      (drawing) => drawing.id === this.primitive.selected,
    );
    this.onState({
      tool: this.tool,
      selected: this.primitive.selected,
      count: this.primitive.drawings.length,
      placingEnd: this.first !== null,
      crossPeriod: selected ? !!selected.crossPeriod : this.defaultCrossPeriod,
      sharedCount: this.primitive.drawings.filter(
        (drawing) => drawing.crossPeriod,
      ).length,
      selectedPosition: selected?.kind === 'position' ? selected.side : null,
    });
  }

  private persist() {
    this.cache.set(
      this.localKey,
      this.primitive.drawings.filter((drawing) => !drawing.crossPeriod),
    );
    this.cache.set(
      this.sharedKey,
      this.primitive.drawings.filter((drawing) => drawing.crossPeriod),
    );
    try {
      for (const key of [this.localKey, this.sharedKey])
        localStorage.setItem(key, JSON.stringify(this.cache.get(key)));
    } catch {
      this.storageError();
    }
  }

  private storageError() {
    toast.error('浏览器未能保存划线，本次修改仅在当前页面生效', {
      id: 'chart-drawing-storage-error',
    });
  }

  private interacting(active: boolean) {
    this.chart.applyOptions({
      handleScroll: active ? false : this.initialScroll,
      handleScale: active ? false : this.initialScale,
    });
    this.container.style.cursor = active ? 'crosshair' : '';
    this.container.style.touchAction = active
      ? 'none'
      : this.initialTouchAction;
  }

  private point(event: PointerEvent): Point {
    const rect = this.container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private inPane(point: Point) {
    return (
      point.x >= 0 &&
      point.x < this.chart.timeScale().width() &&
      point.y >= 0 &&
      point.y < this.chart.panes()[0].getHeight()
    );
  }

  private anchor(point: Point, clamp = false): Anchor | null {
    const logical = this.chart.timeScale().coordinateToLogical(point.x);
    const price = this.series.coordinateToPrice(point.y);
    if (logical === null || price === null) return null;
    const index = clamp
      ? Math.max(
          0,
          Math.min(this.primitive.bars.length - 1, Math.round(logical)),
        )
      : Math.round(logical);
    const bar = this.primitive.bars[index];
    return bar ? { time: bar.time, price } : null;
  }

  private own(event: PointerEvent) {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pointer = event.pointerId;
    this.container.setPointerCapture(event.pointerId);
    this.container.focus({ preventScroll: true });
  }

  private positionCandidate(anchor: Anchor, id = 'draft') {
    if (!this.first || (this.tool !== 'long' && this.tool !== 'short'))
      return null;
    // A vertical gesture still needs a visible horizontal span.
    if (anchor.time === this.first.time) {
      const bars = this.primitive.bars;
      const index = bars.findIndex((bar) => bar.time === anchor.time);
      const left = Math.max(0, index - 40),
        right = Math.min(bars.length - 1, index + 40);
      const end = right - index >= index - left ? right : left;
      if (bars[end]) anchor = { ...anchor, time: bars[end].time };
    }
    return createPosition(id, this.tool, this.first, anchor);
  }

  private down = (event: PointerEvent) => {
    if (event.button !== 0 || this.pointer !== null) return;
    const point = this.point(event);
    if (!this.inPane(point) || !this.primitive.bars.length) return;
    if (this.tool !== 'cursor') {
      this.own(event);
      if (this.tool === 'horizontal') {
        const price = this.series.coordinateToPrice(point.y);
        if (price !== null)
          this.add({ id: crypto.randomUUID(), kind: 'horizontal', price });
      } else {
        const anchor = this.anchor(point);
        if (!anchor) return;
        if (!this.first) {
          this.first = anchor;
          if (this.tool === 'long' || this.tool === 'short') {
            this.placementOrigin = point;
            this.placementDragged = false;
          }
          this.primitive.preview =
            this.tool === 'trend'
              ? {
                  id: 'draft',
                  kind: 'trend',
                  start: anchor,
                  end: anchor,
                }
              : { id: 'draft', kind: 'horizontal', price: anchor.price };
          this.publish();
        } else if (this.tool === 'long' || this.tool === 'short') {
          const position = this.positionCandidate(anchor, crypto.randomUUID());
          if (position) this.add(position);
          else
            toast.error('请在入场价上方或下方设置止盈或止损', {
              id: 'chart-position-placement',
            });
        } else if (
          anchor.time !== this.first.time ||
          Math.abs(anchor.price - this.first.price) > 1e-8
        ) {
          this.add({
            id: crypto.randomUUID(),
            kind: 'trend',
            start: this.first,
            end: anchor,
          });
        }
      }
      return;
    }
    const hit = this.primitive.hit(point);
    this.primitive.selected = hit?.id ?? null;
    if (hit) {
      const logical = this.chart.timeScale().coordinateToLogical(point.x);
      const price = this.series.coordinateToPrice(point.y);
      if (logical !== null && price !== null) {
        this.own(event);
        this.drag = {
          original: this.primitive.drawings.find((item) => item.id === hit.id)!,
          part: hit.part,
          logical,
          price,
        };
        this.interacting(true);
      }
    }
    this.publish();
  };

  private move = (event: PointerEvent) => {
    const point = this.point(event);
    if (this.drag && event.pointerId === this.pointer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const { original, part, logical, price } = this.drag;
      const nextPrice = this.series.coordinateToPrice(point.y);
      const nextLogical = this.chart.timeScale().coordinateToLogical(point.x);
      if (nextPrice === null || nextLogical === null) return;
      let drawing = original;
      if (part === 'line')
        drawing = moveDrawing(
          original,
          nextLogical - logical,
          nextPrice - price,
          this.primitive.bars,
        );
      else if (
        original.kind === 'trend' &&
        (part === 'start' || part === 'end')
      ) {
        const anchor = this.anchor(point, true);
        if (anchor) drawing = { ...original, [part]: anchor };
      } else if (original.kind === 'position') {
        if (part === 'start' || part === 'end') {
          const anchor = this.anchor(point, true);
          if (
            anchor &&
            anchor.time !== original[part === 'start' ? 'end' : 'start']
          )
            drawing = { ...original, [part]: anchor.time };
        } else if (part === 'entry' || part === 'target' || part === 'stop') {
          const format = this.series.options().priceFormat;
          const tick = format.type === 'custom' ? 0.01 : format.minMove;
          drawing = adjustPosition(
            original,
            part,
            original[part] + nextPrice - price,
            tick,
          );
        }
      }
      this.primitive.drawings = this.primitive.drawings.map((item) =>
        item.id === drawing.id ? drawing : item,
      );
      this.primitive.refresh();
      return;
    }
    if (this.tool === 'cursor') return;
    if (
      this.placementOrigin &&
      event.pointerId === this.pointer &&
      Math.hypot(
        point.x - this.placementOrigin.x,
        point.y - this.placementOrigin.y,
      ) >= 4
    ) {
      this.placementDragged = true;
    }
    if (!this.inPane(point)) {
      this.primitive.preview = null;
      this.primitive.refresh();
      return;
    }
    if (this.tool === 'horizontal') {
      const price = this.series.coordinateToPrice(point.y);
      this.primitive.preview =
        price === null ? null : { id: 'draft', kind: 'horizontal', price };
    } else if (this.first) {
      const end = this.anchor(point);
      this.primitive.preview =
        this.tool === 'trend'
          ? end
            ? { id: 'draft', kind: 'trend', start: this.first, end }
            : null
          : end
            ? (this.positionCandidate(end) ?? {
                id: 'draft',
                kind: 'horizontal',
                price: this.first.price,
              })
            : null;
    }
    this.primitive.refresh();
  };

  private up = (event: PointerEvent) => {
    if (event.pointerId !== this.pointer) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.placementDragged && this.inPane(this.point(event))) {
      const anchor = this.anchor(this.point(event));
      const position =
        anchor && this.positionCandidate(anchor, crypto.randomUUID());
      if (position) this.add(position);
    }
    this.placementOrigin = null;
    this.placementDragged = false;
    if (this.drag) {
      this.drag = null;
      this.persist();
    }
    this.release();
    this.interacting(this.tool !== 'cursor');
    this.publish();
  };

  private add(drawing: Drawing) {
    drawing = { ...drawing, crossPeriod: this.defaultCrossPeriod };
    this.primitive.drawings = [...this.primitive.drawings, drawing];
    this.primitive.selected = drawing.id;
    this.first = null;
    this.placementOrigin = null;
    this.placementDragged = false;
    this.primitive.preview = null;
    this.tool = 'cursor';
    this.interacting(false);
    this.persist();
    this.publish();
  }

  private release() {
    if (this.pointer !== null && this.container.hasPointerCapture(this.pointer))
      this.container.releasePointerCapture(this.pointer);
    this.pointer = null;
  }

  private cancel() {
    if (this.drag) {
      const original = this.drag.original;
      this.primitive.drawings = this.primitive.drawings.map((item) =>
        item.id === original.id ? original : item,
      );
    }
    this.drag = null;
    this.first = null;
    this.placementOrigin = null;
    this.placementDragged = false;
    this.primitive.preview = null;
    this.tool = 'cursor';
    this.release();
    this.interacting(false);
    this.primitive.refresh();
  }

  private cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === this.pointer) {
      this.cancel();
      this.publish();
    }
  };

  private keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      this.primitive.selected = null;
      this.publish();
    } else if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.primitive.selected
    ) {
      event.preventDefault();
      this.deleteSelected();
    }
  };
}
