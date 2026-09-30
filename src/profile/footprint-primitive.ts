/** Footprint columns, volume profiles and cluster ladders from classified trades. */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from 'openalgo-charts';
import type { FootprintBar, FootprintCell } from './profile-model';
import { diagonalImbalances, stackedImbalances } from './footprint';
import { footprintTextColor, readableTextColor, type FootprintTextColorMode } from './footprint-colors';
import { parseColor, withAlpha } from '../render/pill';

export type FootprintStatRow = 'volume' | 'bidVolume' | 'askVolume' | 'delta' | 'minDelta' | 'maxDelta' | 'deltaPct' | 'cvd' | 'trades';
export type FootprintDisplayMode = 'bidask' | 'delta' | 'volume';
export type FootprintCellStyle = 'heatmap' | 'profile' | 'ladder';
export type { FootprintTextColorMode } from './footprint-colors';

export interface FootprintOptions {
  /** Preferred full column width in media px, capped to the available bar slot. */
  cellWidth?: number;
  /** Fraction of the bar slot occupied by the column and candle. Default 0.9. */
  widthFactor: number;
  /** Effective price step (tickSize * rowTicks). Overrides bar.rowSize. */
  tickSize?: number;
  font: number;
  minTextHeight: number;
  textFade: number;
  displayMode: FootprintDisplayMode;
  /** Display quantities divided by this positive value; 1 shows raw units. Stats remain raw. */
  volumeDivisor: number;
  /** Intensity cells, volume-proportional bars, or square high-contrast cells. */
  cellStyle: FootprintCellStyle;
  /** Text comparisons are independent of the cell background. */
  textColorMode: FootprintTextColorMode;
  textColor?: string;
  buyTextColor?: string;
  sellTextColor?: string;
  imbalanceRatio: number;
  imbalanceThreshold: number;
  /** Adjacent same-side imbalance run length. 0 disables brackets. */
  stackedImbalances: number;
  statsRows: readonly FootprintStatRow[];
  /** Ordered rows for a separate table below the footprints. Empty disables it (default). */
  tableRows: readonly FootprintStatRow[];
  /** Fixed table label column width in media px. Default 150. */
  tableLabelWidth: number;
  statsRowHeight: number;
  /** Fixed pane footer or labeled cards beneath each bar. */
  statsPosition: 'bottom' | 'bar';
  /** Cumulative delta preceding the supplied bars, for a rolling window. */
  cvdOffset: number;
  /** Draw real OHLC if supplied; legacy bars show a neutral range line. */
  showCandle: boolean;
  showPoc: boolean;
  pocStyle: 'marker' | 'outline';
  showValueArea: boolean;
  /** Fraction of volume in the contiguous value area around the POC. */
  valueAreaPercent: number;
  valueAreaColor?: string;
  buyColor?: string;
  sellColor?: string;
  pocColor: string;
  radius: number;
}

export const DEFAULT_FOOTPRINT_OPTIONS: FootprintOptions = {
  widthFactor: 0.9, font: 10, minTextHeight: 11, textFade: 4,
  displayMode: 'bidask', volumeDivisor: 1, cellStyle: 'heatmap', textColorMode: 'contrast',
  imbalanceRatio: 3, imbalanceThreshold: 0, stackedImbalances: 3,
  statsRows: [], tableRows: [], tableLabelWidth: 150, statsRowHeight: 15,
  statsPosition: 'bottom', cvdOffset: 0, showCandle: true, showPoc: true,
  pocStyle: 'marker', pocColor: '#f0a020', showValueArea: false, valueAreaPercent: 0.7, radius: 2,
};

export interface FootprintBarStats {
  time: number;
  volume: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  /** Intrabar running delta extremes, including initial zero; null without trade-path metadata. */
  minDelta: number | null;
  maxDelta: number | null;
  deltaPct: number;
  cvd: number;
  /** Null when a legacy input does not include an actual trade count. */
  trades: number | null;
  poc: number;
  vah: number;
  val: number;
}

export interface FootprintHover {
  time: number;
  /** The exact bucket price; null over a statistics card/table. */
  price: number | null;
  cell: FootprintCell | null;
  stats: FootprintBarStats;
}

/** Three significant figures, preserving fractional quantities and suffix rollover. */
export function compactVol(v: number): string {
  if (!Number.isFinite(v)) return '-';
  const rounded = Number(v.toPrecision(3));
  const a = Math.abs(rounded);
  const [suffix, div] = a >= 1e9 ? ['B', 1e9] : a >= 1e6 ? ['M', 1e6] : a >= 1e3 ? ['K', 1e3] : ['', 1];
  return String(Number((rounded / div).toPrecision(3))) + suffix;
}
const signed = (v: number): string => (v >= 0 ? '+' : '') + compactVol(v);

function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a), cb = parseColor(b);
  if (ca === null || cb === null) return b;
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(ca.r + (cb.r - ca.r) * k)},${Math.round(ca.g + (cb.g - ca.g) * k)},${Math.round(ca.b + (cb.b - ca.b) * k)})`;
}

interface RowHit { cell: FootprintCell; top: number; bottom: number }
interface Column {
  bar: FootprintBar;
  stats: FootprintBarStats;
  x: number;
  x0: number;
  width: number;
  rowSize: number;
  rows: RowHit[];
  card?: { top: number; bottom: number };
  table?: { left: number; right: number; top: number; bottom: number };
}
const STAT_LABEL: Record<FootprintStatRow, string> = {
  volume: 'Volume', bidVolume: 'Bid Volume', askVolume: 'Ask Volume', delta: 'Delta',
  minDelta: 'Min Delta', maxDelta: 'Max Delta', deltaPct: 'Delta %', cvd: 'CVD', trades: 'Trades',
};
const TABLE_LABEL = { ...STAT_LABEL, volume: 'Total Volume', bidVolume: 'Total Bid Volume', askVolume: 'Total Ask Volume', cvd: 'Cumulative Delta' };
const unsignedRow = (row: FootprintStatRow): boolean => row === 'volume' || row === 'trades' || row === 'bidVolume' || row === 'askVolume';

export class Footprint implements IPrimitive {
  private _bars: FootprintBar[] = [];
  private _opts: FootprintOptions;
  private _host: PrimitiveHost | null = null;
  private _stats: FootprintBarStats[] = [];
  /** Only visible painted rows/cards are interactive, in media pixels. */
  private _cols: Column[] = [];
  private _rc: PrimitiveRenderContext | null = null;
  private _inferredStep = 0;

  public constructor(opts: Partial<FootprintOptions> = {}) {
    this._opts = { ...DEFAULT_FOOTPRINT_OPTIONS, ...opts,
      statsRows: [...(opts.statsRows ?? DEFAULT_FOOTPRINT_OPTIONS.statsRows)], tableRows: [...(opts.tableRows ?? [])] };
    this._validateOptions(this._opts);
  }
  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; this._rc = null; this._cols = []; }
  public zOrder(): ZOrder { return 'normal'; }

  private _validateOptions(o: FootprintOptions): void {
    for (const v of [o.widthFactor, o.font, o.statsRowHeight, o.tableLabelWidth, o.imbalanceRatio, o.volumeDivisor]) {
      if (!Number.isFinite(v) || v <= 0) throw new RangeError('Footprint dimensions and ratio must be positive and finite');
    }
    for (const v of [o.radius, o.minTextHeight, o.textFade, o.imbalanceThreshold]) {
      if (!Number.isFinite(v) || v < 0) throw new RangeError('Footprint thresholds and radius must be nonnegative and finite');
    }
    for (const v of [o.cellWidth, o.tickSize]) {
      if (v !== undefined && (!Number.isFinite(v) || v <= 0)) throw new RangeError('Footprint width and row step must be positive and finite');
    }
    if (!Number.isSafeInteger(o.stackedImbalances) || o.stackedImbalances < 0) throw new RangeError('Footprint stack length must be a nonnegative integer');
    if (!Number.isFinite(o.cvdOffset)) throw new RangeError('Footprint CVD offset must be finite');
    if (!Number.isFinite(o.valueAreaPercent) || o.valueAreaPercent <= 0 || o.valueAreaPercent > 1) throw new RangeError('Footprint value area must be in (0, 1]');
    for (const rows of [o.statsRows, o.tableRows]) {
      if (rows.some(row => !Object.prototype.hasOwnProperty.call(STAT_LABEL, row)) || new Set(rows).size !== rows.length) throw new RangeError('Footprint statistics rows must be known and unique');
    }
  }

  public setBars(bars: readonly FootprintBar[]): void {
    this._bars = bars.map(bar => ({ ...bar, cells: bar.cells.map(cell => ({ ...cell })).sort((a, b) => b.price - a.price) }));
    let step = Infinity;
    for (const bar of this._bars) {
      if (bar.rowSize !== undefined && bar.rowSize > 0) step = Math.min(step, bar.rowSize);
      for (let i = 1; i < bar.cells.length; i++) {
        const gap = bar.cells[i - 1]!.price - bar.cells[i]!.price;
        if (gap > 0) step = Math.min(step, gap);
      }
    }
    this._inferredStep = Number.isFinite(step) ? step : 0;
    this._cols = [];
    this._recomputeStats();
    this._host?.requestUpdate();
  }

  public setOptions(patch: Partial<FootprintOptions>): void {
    const next = { ...this._opts, ...patch };
    this._validateOptions(next);
    this._opts = { ...next, statsRows: [...next.statsRows], tableRows: [...next.tableRows] };
    this._cols = [];
    if (patch.cvdOffset !== undefined || patch.valueAreaPercent !== undefined) this._recomputeStats();
    this._host?.requestUpdate();
  }
  public options(): FootprintOptions { return { ...this._opts, statsRows: [...this._opts.statsRows], tableRows: [...this._opts.tableRows] }; }
  public stats(): readonly FootprintBarStats[] { return this._stats; }
  private _step(bar: FootprintBar): number { return this._opts.tickSize ?? bar.rowSize ?? this._inferredStep; }

  public autoscaleInfo(): { min: number; max: number } | null {
    let min = Infinity, max = -Infinity;
    for (const bar of this._bars) {
      const half = this._step(bar) / 2;
      for (const cell of bar.cells) { min = Math.min(min, cell.price - half); max = Math.max(max, cell.price + half); }
      if (this._opts.showCandle) {
        if (bar.low !== undefined) min = Math.min(min, bar.low);
        if (bar.high !== undefined) max = Math.max(max, bar.high);
      }
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  private _recomputeStats(): void {
    let cvd = this._opts.cvdOffset;
    this._stats = this._bars.map(bar => {
      const totals = bar.cells.map(cell => cell.bidVol + cell.askVol);
      const volume = totals.reduce((sum, v) => sum + v, 0);
      const bidVolume = bar.cells.reduce((sum, cell) => sum + cell.bidVol, 0);
      const askVolume = bar.cells.reduce((sum, cell) => sum + cell.askVol, 0);
      // Indexes stay in 0..totals.length - 1: the loop bound and the guards on
      // each step keep them there.
      let pocIndex = 0;
      for (let i = 1; i < totals.length; i++) if (totals[i]! > totals[pocIndex]!) pocIndex = i;
      let hi = pocIndex, lo = pocIndex, sum = totals[pocIndex] ?? 0;
      while (sum < volume * this._opts.valueAreaPercent && (hi > 0 || lo < totals.length - 1)) {
        if ((hi > 0 ? totals[hi - 1]! : -1) >= (lo < totals.length - 1 ? totals[lo + 1]! : -1)) sum += totals[--hi]!;
        else sum += totals[++lo]!;
      }
      cvd += bar.delta;
      return { time: bar.time, volume, bidVolume, askVolume, delta: bar.delta,
        minDelta: bar.minDelta ?? null, maxDelta: bar.maxDelta ?? null, deltaPct: volume > 0 ? bar.delta / volume * 100 : 0,
        cvd, trades: bar.tradeCount ?? null, poc: bar.cells[pocIndex]?.price ?? 0,
        vah: bar.cells[hi]?.price ?? 0, val: bar.cells[lo]?.price ?? 0 };
    });
  }

  /** Price boundaries, not a minimum pixel size: tiny rows must never overlap. */
  private _bounds(price: number, step: number, rc: PrimitiveRenderContext): { top: number; bottom: number } {
    const y = rc.priceScale.priceToY(price);
    if (!(step > 0)) return { top: y - 8, bottom: y + 8 };
    const a = rc.priceScale.priceToY(price - step / 2), b = rc.priceScale.priceToY(price + step / 2);
    return { top: Math.min(a, b), bottom: Math.max(a, b) };
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._rc = rc;
    this._cols = [];
    if (this._bars.length === 0 || rc.plotHeight <= 0 || rc.plotWidth <= 0) return;
    const o = this._opts, dpr = rc.dpr;
    const buy = o.buyColor ?? rc.theme.upColor, sell = o.sellColor ?? rc.theme.downColor;
    const bg = rc.theme.background;
    const slot = rc.timeScale.barSpacing;
    const outerWidth = Math.max(0.1, Math.min(o.cellWidth ?? slot * o.widthFactor, slot * 0.96));
    const gutter = o.showCandle && outerWidth >= 20 ? Math.min(9, outerWidth * 0.15) : 0;
    const width = Math.max(0.1, outerWidth - gutter);
    const tableRows = o.tableRows.length ? o.tableRows : o.statsPosition === 'bottom' ? o.statsRows : [];
    const statsH = Math.min(rc.plotHeight, tableRows.length * o.statsRowHeight);
    const cellBottom = rc.plotHeight - statsH;
    const range = rc.timeScale.visibleRange();
    // setBars recomputes the statistics, so there is one per bar.
    for (let i = 0; i < this._bars.length; i++) {
      const bar = this._bars[i]!;
      if (!bar.cells.length) continue;
      const index = rc.dataLayer.timeToIndex(bar.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const x0 = rc.timeScale.indexToX(index) - outerWidth / 2 + gutter;
      if (x0 + width < 0 || x0 > rc.plotWidth) continue;
      this._cols.push({ bar, stats: this._stats[i]!, x: x0 + width / 2, x0, width, rowSize: this._step(bar), rows: [] });
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, rc.plotWidth * dpr, rc.plotHeight * dpr); ctx.clip();
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, rc.plotWidth * dpr, cellBottom * dpr); ctx.clip();
    for (const col of this._cols) this._drawColumn(ctx, rc, col, gutter, buy, sell, bg, cellBottom);
    ctx.restore();
    if (o.statsRows.length && o.statsPosition === 'bar') {
      for (const col of this._cols) this._drawCard(ctx, rc, col, buy, sell, bg, cellBottom);
    }
    if (tableRows.length) this._drawFooter(ctx, rc, buy, sell, bg, statsH, tableRows);
    ctx.restore();
  }

  private _drawColumn(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, col: Column,
    gutter: number, buy: string, sell: string, bg: string, cellBottom: number): void {
    const o = this._opts, dpr = rc.dpr;
    const { bar, stats } = col;
    const width = col.width * dpr, half = width / 2, x0 = col.x0 * dpr, center = col.x * dpr;
    const flags = diagonalImbalances(bar.cells, o.imbalanceRatio, col.rowSize || undefined, o.imbalanceThreshold);
    const buys = new Set(flags.filter(flag => flag.side === 'buy').map(flag => flag.price));
    const sells = new Set(flags.filter(flag => flag.side === 'sell').map(flag => flag.price));
    let peak = 0, textPeak = 0;
    for (const cell of bar.cells) {
      peak = Math.max(peak, o.displayMode === 'volume' ? cell.bidVol + cell.askVol
        : o.displayMode === 'delta' ? Math.abs(cell.askVol - cell.bidVol) : Math.max(cell.bidVol, cell.askVol));
      textPeak = Math.max(textPeak, o.displayMode === 'bidask' ? Math.max(cell.bidVol, cell.askVol) : cell.bidVol + cell.askVol);
    }
    if (gutter > 0) this._drawCandle(ctx, rc, col, gutter, buy, sell);
    for (const cell of bar.cells) {
      const bounds = this._bounds(cell.price, col.rowSize, rc);
      if (bounds.bottom <= 0 || bounds.top >= cellBottom) continue;
      col.rows.push({ cell, top: Math.max(0, bounds.top), bottom: Math.min(cellBottom, bounds.bottom) });
      const top = bounds.top * dpr, rowH = (bounds.bottom - bounds.top) * dpr;
      const h = Math.max(0, rowH - Math.min(dpr, rowH * 0.1));
      const textAlpha = Math.max(0, Math.min(1, ((bounds.bottom - bounds.top) - o.minTextHeight) / Math.max(1, o.textFade) + 1));
      ctx.font = `${o.font * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      if (o.displayMode === 'bidask') {
        const gap = Math.min(dpr, half * 0.08), w = half - gap;
        this._cell(ctx, rc, cell, x0, top, w, h, cell.bidVol, peak, textPeak, sell, buy, sell, bg, sells.has(cell.price), textAlpha, 'bid');
        this._cell(ctx, rc, cell, center + gap, top, w, h, cell.askVol, peak, textPeak, buy, buy, sell, bg, buys.has(cell.price), textAlpha, 'ask');
      } else {
        const value = o.displayMode === 'delta' ? cell.askVol - cell.bidVol : cell.bidVol + cell.askVol;
        const direction = cell.askVol - cell.bidVol;
        this._cell(ctx, rc, cell, x0, top, width, h, value, peak, textPeak, direction > 0 ? buy : direction < 0 ? sell : mix(buy, sell, 0.5), buy, sell, bg,
          direction > 0 ? buys.has(cell.price) : direction < 0 && sells.has(cell.price), textAlpha, 'single');
      }
      if (o.showPoc && cell.price === stats.poc) {
        if (o.pocStyle === 'outline') {
          ctx.strokeStyle = o.pocColor; ctx.lineWidth = Math.max(1, dpr);
          ctx.strokeRect(x0, top + dpr / 2, width, Math.max(0, h - dpr));
        } else { ctx.fillStyle = o.pocColor; ctx.fillRect(x0 - 2 * dpr, top, 2 * dpr, h); }
      }
    }
    if (o.showValueArea && stats.volume > 0) {
      const hi = this._bounds(stats.vah, col.rowSize, rc), lo = this._bounds(stats.val, col.rowSize, rc);
      ctx.strokeStyle = o.valueAreaColor ?? rc.theme.axisText; ctx.lineWidth = dpr;
      ctx.beginPath();
      for (const y of [Math.min(hi.top, lo.top), Math.max(hi.bottom, lo.bottom)]) {
        ctx.moveTo(x0, y * dpr); ctx.lineTo(x0 + width, y * dpr);
      }
      ctx.stroke();
    }
    if (o.stackedImbalances > 0 && col.width >= 16) {
      const runs = stackedImbalances(bar.cells, o.imbalanceRatio, o.stackedImbalances, col.rowSize || undefined, o.imbalanceThreshold);
      for (const run of runs) {
        const a = this._bounds(run.startPrice, col.rowSize, rc), b = this._bounds(run.endPrice, col.rowSize, rc);
        const top = Math.min(a.top, b.top) * dpr, bottom = Math.max(a.bottom, b.bottom) * dpr;
        const bx = (run.side === 'buy' ? col.x0 + col.width - 1 : col.x0 + 1) * dpr;
        const dx = (run.side === 'buy' ? -3 : 3) * dpr;
        ctx.strokeStyle = run.side === 'buy' ? buy : sell; ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.moveTo(bx + dx, top); ctx.lineTo(bx, top); ctx.lineTo(bx, bottom); ctx.lineTo(bx + dx, bottom); ctx.stroke();
      }
    }
  }

  private _drawCandle(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, col: Column, gutter: number, buy: string, sell: string): void {
    const b = col.bar, dpr = rc.dpr;
    const x = (col.x0 - gutter / 2) * dpr;
    const bodyWidth = Math.min(4, gutter * 0.45) * dpr;
    // A column is only made for a bar with cells.
    const high = b.high ?? b.cells[0]!.price, low = b.low ?? b.cells[b.cells.length - 1]!.price;
    const y1 = rc.priceScale.priceToY(high) * dpr, y2 = rc.priceScale.priceToY(low) * dpr;
    const hasBody = b.open !== undefined && b.close !== undefined;
    const color = hasBody ? ((b.close as number) >= (b.open as number) ? buy : sell) : rc.theme.axisText;
    ctx.fillStyle = color;
    ctx.fillRect(x, Math.min(y1, y2), dpr, Math.max(dpr, Math.abs(y2 - y1)));
    if (hasBody) {
      const open = rc.priceScale.priceToY(b.open as number) * dpr, close = rc.priceScale.priceToY(b.close as number) * dpr;
      ctx.fillRect(x - bodyWidth / 2, Math.min(open, close), bodyWidth, Math.max(dpr, Math.abs(close - open)));
    }
  }

  private _cell(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, cell: FootprintCell,
    x: number, y: number, w: number, h: number, value: number, peak: number, textPeak: number, color: string,
    buy: string, sell: string, bg: string, hot: boolean, alpha: number, side: 'bid' | 'ask' | 'single'): void {
    if (w <= 0 || h <= 0) return;
    const o = this._opts, dpr = rc.dpr, profile = o.cellStyle === 'profile';
    const strength = Math.max(0, Math.min(1, peak > 0 ? Math.abs(value) / peak : 0));
    const fill = hot ? color : mix(bg, color, o.cellStyle === 'ladder' ? 0.18 + 0.82 * Math.sqrt(strength) : 0.08 + 0.62 * Math.sqrt(strength));
    const fillW = profile ? w * strength : w;
    const fillX = profile && side === 'bid' ? x + w - fillW : x;
    if (fillW > 0) {
      ctx.fillStyle = fill; ctx.beginPath();
      ctx.roundRect(fillX, y, fillW, h, o.cellStyle === 'ladder' || profile ? 0 : Math.min(o.radius * dpr, h / 2, fillW / 2)); ctx.fill();
    }
    if (alpha <= 0 || h < o.font * dpr * 0.6) return;
    const label = compactVol(value / o.volumeDivisor), textW = ctx.measureText(label).width;
    if (textW + 4 * dpr > w) return;
    ctx.textAlign = profile && side !== 'single' ? (side === 'bid' ? 'right' : 'left') : 'center';
    const tx = profile && side !== 'single' ? (side === 'bid' ? x + w - 2 * dpr : x + 2 * dpr) : x + w / 2;
    const left = ctx.textAlign === 'right' ? tx - textW : ctx.textAlign === 'left' ? tx : tx - textW / 2;
    const right = left + textW;
    let background = fill;
    if (profile) {
      if (fillW === 0 || right <= fillX || left >= fillX + fillW) background = bg;
      else if (left < fillX || right > fillX + fillW) {
        // A number crossing a bright profile edge cannot contrast with both
        // surfaces. Give the glyphs one opaque backplate on that row.
        background = bg; ctx.fillStyle = bg;
        ctx.fillRect(left - dpr, y, textW + 2 * dpr, h);
      }
    }
    const neutral = o.textColor ?? readableTextColor(rc.theme.axisText, bg);
    const text = footprintTextColor({ mode: o.textColorMode, side, bidVol: cell.bidVol, askVol: cell.askVol,
      peak: textPeak, hot, neutral, buy: o.buyTextColor ?? buy, sell: o.sellTextColor ?? sell, background });
    ctx.fillStyle = withAlpha(text, alpha);
    ctx.fillText(label, tx, y + h / 2);
  }

  private _drawCard(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, col: Column, buy: string, sell: string, bg: string, cellBottom: number): void {
    const o = this._opts, dpr = rc.dpr;
    if (col.width < 68 || col.rows.length === 0) return;
    let bottom = -Infinity;
    for (const cell of col.bar.cells) bottom = Math.max(bottom, this._bounds(cell.price, col.rowSize, rc).bottom);
    if (o.showCandle) for (const price of [col.bar.high, col.bar.low]) if (price !== undefined) bottom = Math.max(bottom, rc.priceScale.priceToY(price));
    const top = bottom + 8, height = o.statsRows.length * o.statsRowHeight + 8;
    if (top < 0 || top + height > cellBottom) return;
    col.card = { top, bottom: top + height };
    const fill = mix(bg, rc.theme.axisText, 0.13);
    ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(col.x0 * dpr, top * dpr, col.width * dpr, height * dpr, 2 * dpr); ctx.fill();
    ctx.font = `${Math.max(8, o.font - 1) * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    o.statsRows.forEach((row, i) => {
      const value = this._metric(col.stats, row), text = this._statText(value, row);
      const y = (top + 4 + (i + 0.5) * o.statsRowHeight) * dpr;
      const label = STAT_LABEL[row];
      if (ctx.measureText(label).width + ctx.measureText(text).width + 12 * dpr > col.width * dpr) return;
      ctx.textAlign = 'left'; ctx.fillStyle = readableTextColor(o.textColor ?? rc.theme.axisText, fill);
      ctx.fillText(label, (col.x0 + 4) * dpr, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = readableTextColor(this._statColor(row, value, o.textColor ?? rc.theme.axisText, o.buyTextColor ?? buy, o.sellTextColor ?? sell), fill);
      ctx.fillText(text, (col.x0 + col.width - 4) * dpr, y);
    });
  }

  private _drawFooter(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, buy: string, sell: string, bg: string, height: number, rows: readonly FootprintStatRow[]): void {
    const o = this._opts, dpr = rc.dpr, top = rc.plotHeight - height;
    const labelWidth = Math.min(o.tableLabelWidth, rc.plotWidth);
    ctx.fillStyle = bg; ctx.fillRect(0, top * dpr, rc.plotWidth * dpr, height * dpr);
    ctx.font = `${Math.max(8, o.font - 0.5) * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    const slot = rc.timeScale.barSpacing;
    for (const col of this._cols) {
      const x = rc.timeScale.indexToX(rc.dataLayer.timeToIndex(col.bar.time)!);
      const left = Math.max(labelWidth, x - slot / 2), right = Math.min(rc.plotWidth, x + slot / 2);
      if (left < right) col.table = { left, right, top, bottom: rc.plotHeight };
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(labelWidth * dpr, top * dpr, (rc.plotWidth - labelWidth) * dpr, height * dpr); ctx.clip();
    rows.forEach((row, i) => {
      let peak = 1;
      for (const col of this._cols) if (col.table) peak = Math.max(peak, Math.abs(this._metric(col.stats, row) ?? 0));
      for (const col of this._cols) {
        if (!col.table) continue;
        const value = this._metric(col.stats, row), v = value ?? 0;
        const fill = mix(bg, this._statColor(row, value, rc.theme.axisText, buy, sell), 0.1 + 0.4 * Math.abs(v) / peak);
        const x = rc.timeScale.indexToX(rc.dataLayer.timeToIndex(col.bar.time)!);
        const y = (top + i * o.statsRowHeight) * dpr;
        ctx.fillStyle = fill;
        ctx.fillRect((x - slot / 2) * dpr, y + dpr, Math.max(0, slot * dpr - dpr), Math.max(0, o.statsRowHeight * dpr - dpr));
        const text = this._statText(value, row);
        const halfText = ctx.measureText(text).width / (2 * dpr) + 2;
        if (x - halfText < col.table.left || x + halfText > col.table.right) continue;
        ctx.fillStyle = readableTextColor(o.textColor ?? rc.theme.axisText, fill);
        ctx.fillText(text, x * dpr, y + o.statsRowHeight * dpr / 2);
      }
    });
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(0, top * dpr, labelWidth * dpr, height * dpr); ctx.clip();
    const labelFill = mix(bg, rc.theme.axisText, 0.09);
    ctx.fillStyle = labelFill; ctx.fillRect(0, top * dpr, labelWidth * dpr, height * dpr);
    ctx.fillStyle = readableTextColor(o.textColor ?? rc.theme.axisText, labelFill); ctx.textAlign = 'left';
    rows.forEach((row, i) => ctx.fillText(TABLE_LABEL[row], 6 * dpr, (top + (i + 0.5) * o.statsRowHeight) * dpr));
    ctx.restore();
    ctx.strokeStyle = mix(bg, rc.theme.axisText, 0.25); ctx.lineWidth = dpr; ctx.beginPath();
    for (let i = 0; i <= rows.length; i++) {
      const y = (top + i * o.statsRowHeight) * dpr;
      ctx.moveTo(0, y); ctx.lineTo(rc.plotWidth * dpr, y);
    }
    ctx.moveTo(labelWidth * dpr, top * dpr); ctx.lineTo(labelWidth * dpr, rc.plotHeight * dpr); ctx.stroke();
  }
  private _statColor(row: FootprintStatRow, value: number | null, neutral: string, buy: string, sell: string): string {
    if (value === null || value === 0 || row === 'volume' || row === 'trades') return neutral;
    if (row === 'askVolume') return buy;
    if (row === 'bidVolume') return sell;
    return value > 0 ? buy : sell;
  }
  private _metric(s: FootprintBarStats, row: FootprintStatRow): number | null { return row === 'deltaPct' ? s.deltaPct : s[row]; }
  private _statText(value: number | null, row: FootprintStatRow): string {
    if (value === null) return '-';
    if (row === 'deltaPct') return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
    const displayed = row === 'trades' ? value : value / this._opts.volumeDivisor;
    return unsignedRow(row) ? compactVol(displayed) : signed(displayed);
  }

  public hitTest(x: number, y: number): PrimitiveHit | null {
    const hover = this.hoverAt(x, y);
    return hover ? { externalId: `footprint:${hover.time}`, zOrder: 'normal', distance: 0, cursor: 'crosshair' } : null;
  }
  public hoverAt(x: number, y: number, rc?: PrimitiveRenderContext): FootprintHover | null {
    const context = rc ?? this._rc;
    if (!context || x < 0 || x > context.plotWidth || y < 0 || y > context.plotHeight) return null;
    const table = this._cols.find(c => c.table && x >= c.table.left && x < c.table.right && y >= c.table.top && y <= c.table.bottom);
    if (table) return { time: table.bar.time, price: null, cell: null, stats: table.stats };
    const col = this._cols.find(c => x >= c.x0 && x <= c.x0 + c.width);
    if (!col) return null;
    const row = col.rows.find(r => y >= r.top && y < r.bottom);
    if (row) return { time: col.bar.time, price: row.cell.price, cell: row.cell, stats: col.stats };
    if (col.card && y >= col.card.top && y <= col.card.bottom) return { time: col.bar.time, price: null, cell: null, stats: col.stats };
    return null;
  }
}
