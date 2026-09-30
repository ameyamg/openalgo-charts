/**
 * The price tag a working order line and a position marker put on the price
 * axis, placed the way a PriceLine places its own (primitives/price-line.ts):
 * in the column of the scale the pane binds, on its side, confined to that
 * column when the chart gives its offset, and left out when the scale shows
 * no axis. A context that says nothing of placement keeps the right-edge tag
 * both have always drawn.
 */
import type { PrimitiveRenderContext } from 'openalgo-charts';

/** Drawn in the caller's font; a label wider than a narrow column is written smaller to fit it. */
export function drawAxisTag(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, y: number, label: string,
  colors: { fill: string; text: string }, box: { height: number; padX: number }): void {
  if (rc.priceAxisSide === 'hidden' || !(rc.priceAxisWidth > 0)) return;
  const { dpr } = rc, { height, padX } = box;
  const left = rc.priceAxisSide === 'left';
  if (!left && rc.priceAxisOffset === undefined) {
    const x = Math.round(rc.plotWidth * dpr) + 1;
    ctx.fillStyle = colors.fill;
    ctx.fillRect(x, y - height / 2, ctx.measureText(label).width + padX * 2, height);
    ctx.fillStyle = colors.text;
    ctx.fillText(label, x + padX, y);
    return;
  }
  const offset = rc.priceAxisOffset ?? 0;
  const edge = Math.round(offset * dpr);
  const outer = Math.round((offset + (left ? -rc.priceAxisWidth : rc.priceAxisWidth)) * dpr);
  const available = (rc.priceAxisOffset === undefined ? Math.round(rc.priceAxisWidth * dpr) : Math.abs(outer - edge)) - 1;
  if (!Number.isFinite(edge) || !Number.isFinite(outer) || available <= 0 || rc.plotHeight * dpr < height) return;
  const font = ctx.font;
  ctx.save();
  if (rc.priceAxisOffset !== undefined) {
    ctx.beginPath();
    ctx.rect(Math.min(edge, outer), 0, available + 1, rc.plotHeight * dpr);
    ctx.clip();
  }
  const padding = Math.min(padX, available / 4), textWidth = ctx.measureText(label).width;
  const width = Math.min(available, textWidth + padding * 2);
  const x = left ? edge - 1 - width : edge + 1;
  // Kept whole inside the plot, as a PriceLine's tag is, when the line runs near its edge.
  const tagY = Math.max(height / 2, Math.min(rc.plotHeight * dpr - height / 2, y));
  ctx.fillStyle = colors.fill;
  ctx.fillRect(x, tagY - height / 2, width, height);
  ctx.fillStyle = colors.text;
  ctx.font = `500 ${11 * dpr * (textWidth > 0 ? Math.min(1, (width - padding * 2) / textWidth) : 1)}px system-ui, sans-serif`;
  ctx.fillText(label, x + padding, tagY);
  ctx.restore();
  ctx.font = font;
}
