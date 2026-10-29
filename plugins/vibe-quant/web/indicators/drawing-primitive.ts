// Adapted from stock-rl's SMC rendering, © LuxAlgo, CC BY-NC-SA 4.0.
// https://creativecommons.org/licenses/by-nc-sa/4.0/
import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
} from 'lightweight-charts';
import type { IndicatorDrawing } from './types';

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Draw on the attached series pane without introducing timestamps or price bounds. */
export class IndicatorDrawingPrimitive implements ISeriesPrimitive {
  private attachedTo?: SeriesAttachedParameter;
  private drawings: IndicatorDrawing[] = [];
  private readonly views: IPrimitivePaneView[] = [
    {
      zOrder: () => 'normal',
      renderer: () => ({
        drawBackground: (target) => this.draw(target, true),
        draw: (target) => this.draw(target, false),
      }),
    },
  ];

  attached(parameter: SeriesAttachedParameter) {
    this.attachedTo = parameter;
  }
  detached() {
    this.attachedTo = undefined;
  }
  paneViews() {
    return this.views;
  }
  setDrawings(drawings: IndicatorDrawing[]) {
    this.drawings = drawings;
    this.attachedTo?.requestUpdate();
  }

  private draw(target: DrawTarget, background: boolean) {
    const attached = this.attachedTo;
    if (!attached) return;
    const scale = attached.chart.timeScale();
    const coordinate = (index: number) => {
      if (!Number.isFinite(index)) return null;
      const whole = Math.floor(index);
      const start = scale.logicalToCoordinate(whole as Logical);
      if (start === null || whole === index) return start;
      const end = scale.logicalToCoordinate((whole + 1) as Logical);
      return end === null ? null : start + (end - start) * (index - whole);
    };
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, mediaSize.width, mediaSize.height);
      ctx.clip();
      for (const drawing of this.drawings) {
        const x1 = coordinate(drawing.from);
        const x2 = drawing.extendRight
          ? mediaSize.width
          : coordinate(drawing.to);
        const y1 = attached.series.priceToCoordinate(drawing.top);
        const y2 = attached.series.priceToCoordinate(drawing.bottom);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        if (Math.max(x1, x2) < -200 || Math.min(x1, x2) > mediaSize.width + 200)
          continue;
        if (background) {
          if (drawing.kind !== 'box') continue;
          ctx.fillStyle = drawing.color;
          const left = Math.min(x1, x2),
            top = Math.min(y1, y2);
          const width = Math.abs(x2 - x1),
            height = Math.abs(y2 - y1);
          ctx.fillRect(left, top, width, height);
          if (drawing.border) {
            ctx.strokeStyle = drawing.color;
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
            ctx.strokeRect(left, top, width, height);
          }
          continue;
        }
        if (drawing.kind === 'line') {
          ctx.strokeStyle = drawing.color;
          ctx.lineWidth = drawing.lineWidth ?? 1;
          ctx.setLineDash(
            drawing.style === 'dashed'
              ? [5, 4]
              : drawing.style === 'dotted'
                ? [1, 3]
                : [],
          );
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
        if (!drawing.text) continue;
        if (
          drawing.clampLabel &&
          (Math.min(x1, x2) > mediaSize.width || Math.max(x1, x2) < 0)
        )
          continue;
        const x = coordinate(drawing.labelIndex ?? drawing.from);
        const y = attached.series.priceToCoordinate(
          drawing.labelPrice ?? drawing.top,
        );
        if (x === null || y === null) continue;
        const size =
          drawing.size === 'normal' ? 14 : drawing.size === 'small' ? 12 : 10;
        ctx.font = `${size}px Arial, sans-serif`;
        ctx.fillStyle =
          drawing.kind === 'box' ? drawing.color.slice(0, 7) : drawing.color;
        ctx.textAlign = drawing.align === 'left' ? 'left' : 'center';
        ctx.textBaseline =
          drawing.align === 'below'
            ? 'top'
            : drawing.align === 'left'
              ? 'middle'
              : 'bottom';
        const maxWidth = Math.max(1, mediaSize.width - 12);
        const halfWidth =
          Math.min(ctx.measureText(drawing.text).width, maxWidth) / 2;
        const labelX = drawing.clampLabel
          ? Math.max(
              halfWidth + 6,
              Math.min(mediaSize.width - halfWidth - 6, mediaSize.width / 2, x),
            )
          : x;
        if (drawing.clampLabel) ctx.textAlign = 'center';
        const textX = labelX + (drawing.align === 'left' ? 3 : 0);
        const pointer =
          drawing.labelPointer &&
          drawing.labelBackground &&
          drawing.align !== 'left';
        const labelGap = pointer ? 12 : 3;
        const textY =
          y +
          (drawing.align === 'below'
            ? labelGap
            : drawing.align === 'left'
              ? 0
              : -labelGap);
        if (drawing.labelBackground) {
          const textWidth = ctx.measureText(drawing.text).width;
          const left = ctx.textAlign === 'left' ? textX : textX - textWidth / 2;
          const top =
            ctx.textBaseline === 'top'
              ? textY
              : ctx.textBaseline === 'middle'
                ? textY - size / 2
                : textY - size;
          const textColor = ctx.fillStyle;
          ctx.fillStyle = drawing.labelBackground;
          if (pointer) {
            const badgeLeft = left - 4;
            const badgeRight = left + textWidth + 4;
            const badgeTop = top - 2;
            const badgeBottom = top + size + 2;
            // A single pentagonal badge: the entire edge forms the arrowhead.
            // Keep the tip at the candle and the text inside the rectangle.
            ctx.beginPath();
            if (drawing.align === 'below') {
              ctx.moveTo(textX, y + 2);
              ctx.lineTo(badgeRight, badgeTop);
              ctx.lineTo(badgeRight, badgeBottom);
              ctx.lineTo(badgeLeft, badgeBottom);
              ctx.lineTo(badgeLeft, badgeTop);
            } else {
              ctx.moveTo(badgeLeft, badgeTop);
              ctx.lineTo(badgeRight, badgeTop);
              ctx.lineTo(badgeRight, badgeBottom);
              ctx.lineTo(textX, y - 2);
              ctx.lineTo(badgeLeft, badgeBottom);
            }
            ctx.closePath();
            ctx.fill();
          } else ctx.fillRect(left - 3, top - 2, textWidth + 6, size + 4);
          ctx.fillStyle = textColor;
        }
        if (drawing.clampLabel)
          ctx.fillText(drawing.text, textX, textY, maxWidth);
        else ctx.fillText(drawing.text, textX, textY);
      }
      ctx.restore();
    });
  }
}
