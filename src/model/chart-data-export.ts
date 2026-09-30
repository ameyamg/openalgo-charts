import type { Chart } from '../core/chart';
import type { ComparisonHandle } from '../compare/controller';
import { captureCsvSnapshot } from './chart-data-export-snapshot';
import { alignCsvRows } from './chart-data-export-alignment';
import { serializeCsv } from './chart-data-export-formatting';

/** Inclusive UTC-second bounds over installed primary rows. Omitted bounds are unbounded. */
export interface ChartDataCsvRange {
  readonly from?: number;
  readonly to?: number;
}

/** Canonical identities stay available even when a callback changes visible headers. */
export type ChartDataColumn = Readonly<{ key: string; title: string } & (
  | { kind: 'time' | 'timeLabel' | 'logicalIndex' | 'timeOrigin' }
  | { kind: 'primary'; field: 'open' | 'high' | 'low' | 'close' | 'volume' | 'oi' }
  | { kind: 'indicator'; instanceId: string; plotKey: string; field?: 'open' | 'high' | 'low' | 'close' }
  | { kind: 'comparison'; comparisonIndex: number; symbol: string; field: 'close' }
)>;

/** Detached installed axis. Replay never exposes its unrevealed source history here. */
export interface ChartDataProjectionContext {
  readonly axisTimes: readonly number[];
  readonly replay?: Readonly<{ time: number; forming: boolean; asOf?: number }>;
}

export interface ChartDataCsvFormatters {
  /** Adds a time_label column without replacing raw UTC seconds. */
  time?: (utcSeconds: number) => string;
  /** Called only for finite primary, study and comparison values. */
  value?: (value: number, column: ChartDataColumn) => string;
  header?: (column: ChartDataColumn) => string;
}

/** Options for a numeric snapshot of the chart's currently loaded data. */
export interface ChartDataCsvOptions {
  /** All studies by default, false for none, or instance IDs in the requested column order. Hidden studies remain eligible. */
  indicators?: boolean | readonly string[];
  /** Filter rows after full installed-history calculation, without changing study warmup. */
  range?: ChartDataCsvRange;
  /** Override the chart's registered comparisons, for example with an explicitly managed controller's list. */
  comparisons?: readonly Pick<ComparisonHandle, 'symbol' | 'barAt'>[];
  /** Source rows by default. Display uses effective study offsets on the shared axis. */
  alignment?: 'source' | 'display';
  /** Resolves positions outside the captured axis. Null explicitly leaves time unknown. */
  projectTime?: (logicalIndex: number, context: Readonly<ChartDataProjectionContext>) => number | null;
  formatters?: ChartDataCsvFormatters;
}

function ownOption(options: ChartDataCsvOptions, key: keyof ChartDataCsvOptions): unknown {
  if (options === null || typeof options !== 'object') throw new TypeError('Invalid CSV options');
  const property = Object.getOwnPropertyDescriptor(options, key);
  if (property ? !('value' in property) : key in options) throw new TypeError(`CSV ${key} must be an own data property`);
  return property?.value;
}

function selectedFormatters(input: unknown): ChartDataCsvFormatters {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid CSV formatters');
  const properties = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(properties)) { // own keys, so each has a descriptor
    if (!['time', 'value', 'header'].includes(key as string) || !('value' in properties[key as string]!)) {
      throw new TypeError('Invalid CSV formatter property');
    }
  }
  const result: Record<string, unknown> = {};
  for (const key of ['time', 'value', 'header']) {
    const property = properties[key];
    if (!property && key in input) throw new TypeError('CSV formatters must be own properties');
    const value: unknown = property?.value;
    if (value !== undefined && typeof value !== 'function') throw new TypeError('CSV formatters must be functions');
    result[key] = value;
  }
  return result as ChartDataCsvFormatters;
}

function selectedIds(input: unknown): boolean | string[] {
  if (input === undefined || input === true) return true;
  if (input === false) return false;
  if (!Array.isArray(input)) throw new TypeError('CSV indicators must be a boolean or an array of instance IDs');
  const properties = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(properties).length !== input.length + 1) throw new TypeError('Invalid CSV indicator ID array');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const property = properties[String(i)];
    if (!property || !('value' in property) || typeof property.value !== 'string' || property.value.trim().length === 0) {
      throw new TypeError('CSV indicator IDs must be nonempty strings in a dense data array');
    }
    const id = property.value;
    if (seen.has(id)) throw new RangeError(`Duplicate CSV indicator ID: ${id}`);
    seen.add(id); ids.push(id);
  }
  return ids.length === 0 ? false : ids;
}

function selectedRange(input: unknown): ChartDataCsvRange {
  if (input === undefined) return {};
  if (input === null || typeof input !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new TypeError('Invalid CSV range');
  const properties = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(properties)) { // own keys, as above
    if ((key !== 'from' && key !== 'to') || !('value' in properties[key]!)) throw new TypeError('Invalid CSV range property');
  }
  const range: { from?: number; to?: number } = {};
  for (const key of ['from', 'to'] as const) {
    const property = properties[key];
    if (!property && key in input) throw new TypeError('CSV range bounds must be own properties');
    const value: unknown = property?.value;
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('CSV range bounds must be finite UTC seconds');
      range[key] = value;
    }
  }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) throw new RangeError('CSV range is reversed');
  return range;
}

/**
 * CSV with UTC seconds, unrounded OHLC/volume/OI, study values and aligned comparison closes.
 * Reads only installed primary rows, so replay exposes only its revealed prefix.
 * Missing or nonfinite values are blank. Source alignment precedes visual offsets;
 * display alignment shifts selected plots, expanding candle plots into OHLC fields.
 * Primary and comparison cells remain on installed primary positions in both modes.
 * Formatter text is escaped and protected against spreadsheet formula execution.
 * Does not fetch data, include trading state or initiate a browser download.
 */
export function exportChartDataCsv(chart: Chart, options: ChartDataCsvOptions = {}): string {
  const selection = selectedIds(ownOption(options, 'indicators'));
  const range = selectedRange(ownOption(options, 'range'));
  const requestedAlignment = ownOption(options, 'alignment');
  const alignment = requestedAlignment === undefined ? 'source' : requestedAlignment;
  if (alignment !== 'source' && alignment !== 'display') throw new TypeError('Invalid CSV alignment');
  const projectTime = ownOption(options, 'projectTime') as ChartDataCsvOptions['projectTime'];
  if (projectTime !== undefined && (typeof projectTime !== 'function' || alignment !== 'display')) throw new TypeError('CSV projectTime requires display alignment and a function');
  const formatters = selectedFormatters(ownOption(options, 'formatters'));
  const snapshot = captureCsvSnapshot(chart, selection, alignment, range, options.comparisons);
  const rows = alignCsvRows(snapshot, alignment, range, projectTime);
  return serializeCsv(snapshot.columns, rows, alignment, formatters);
}
