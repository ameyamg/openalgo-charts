// Importing the transform tier registers the point and figure and Kagi
// renderers and the six transforms a chart can apply itself.
import '/dist/openalgo-charts.transform.mjs';
// Off the namespace, as main.js reads the newer surfaces: a dist/ from before
// in-chart transforms still draws a chart, and main.js says what it lacks.
import * as engine from '/dist/openalgo-charts.mjs';

/** Whether this dist/ can apply a transform in the chart. */
export const inChartTransforms = typeof engine.getSeriesTransform === 'function';

// ── Family-B transforms ────────────────────────────────────────────────
// A transform re-buckets bars by price movement rather than the clock, so one
// source bar can form no element, one, or several. The chart applies it: the
// series is fed the raw bars as ever, and the chart draws the bricks, boxes or
// line, forming them again as each bar and tick lands (replay shows it live).
// A size left out is taken from the loaded history, a fortieth of its range
// (twice that for range bars and Kagi), so one default suits AAPL and BTC.
// Point and figure can size its box from price or volatility instead: 'atr'
// and 'percent' re-resolve the box each time a column opens.
//
// `sel` is the chart type select's value: a renderer, or `t:<transform>`. The
// value 't:range' predates the transform's own id and stays for saved layouts.
export function chartTypeSeries(sel, pfmode = 'fixed') {
  if (!sel.startsWith('t:') || !inChartTransforms) return { type: sel.startsWith('t:') ? 'candlestick' : sel, transform: null };
  const kind = sel === 't:range' ? 'range-bars' : sel.slice(2);
  const transform = kind === 'point-figure' && pfmode !== 'fixed' ? { type: kind, options: { mode: pfmode } } : { type: kind };
  return { type: engine.getSeriesTransform(kind).renderer, transform };
}

/**
 * Whether a switch between two chart types (`{ chartType, pfmode }`) keeps
 * the view. A transform other than Heikin Ashi draws elements of its own, so a
 * view kept from bars, or from other elements, would point at nothing: a
 * switch into or out of one starts from a fitted view.
 */
export function keepsView(shown, next) {
  const own = (type) => Boolean(type?.chartType?.startsWith('t:')) && type.chartType !== 't:heikin-ashi';
  return !(own(shown) || own(next)) || (shown.chartType === next.chartType && shown.pfmode === next.pfmode);
}
