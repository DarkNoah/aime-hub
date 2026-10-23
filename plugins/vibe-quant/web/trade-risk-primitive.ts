import { IndicatorDrawingPrimitive } from './indicators/drawing-primitive';
import type { IndicatorDrawing } from './indicators/types';

/** Reuse the indicator overlay renderer; only visible risk ranges affect autoscale. */
export class TradeRiskPrimitive extends IndicatorDrawingPrimitive {
  private ranges: IndicatorDrawing[] = [];

  setDrawings(drawings: IndicatorDrawing[]) {
    this.ranges = drawings;
    super.setDrawings(drawings);
  }

  autoscaleInfo(start: number, end: number) {
    let minValue = Infinity,
      maxValue = -Infinity;
    for (const range of this.ranges) {
      if (range.to < start || range.from > end) continue;
      minValue = Math.min(minValue, range.top, range.bottom);
      maxValue = Math.max(maxValue, range.top, range.bottom);
    }
    return Number.isFinite(minValue)
      ? { priceRange: { minValue, maxValue } }
      : null;
  }
}
