import type { Bar } from './bar';
import type {
  IndicatorAlertContext, IndicatorAlertFrequency, IndicatorAlertPayload, IndicatorAlertSpec,
  IndicatorCalcContext, IndicatorSettings, IndicatorValues,
} from './indicator-registry';

/** What a declared alert delivers before the instance adds whose it is. */
type PolicyAlert = Omit<IndicatorAlertPayload, 'indicatorId' | 'instanceId'>;

/** Original calculation inputs and an ownership fence supplied by the instance. */
export interface IndicatorAlertPolicyPass {
  bars: readonly Bar[];
  values: IndicatorValues;
  settings: Readonly<IndicatorSettings>;
  calculation: IndicatorCalcContext;
  tailOnly: boolean;
  refresh: boolean;
  current(): boolean;
}

interface Entry {
  spec: IndicatorAlertSpec & { frequency: IndicatorAlertFrequency };
  onceSpent: boolean;
  perBarTime: number;
  closedTime: number;
  failedCloses: Set<number>;
  busy: boolean;
}

const FREQUENCIES = new Set<string>(['everyUpdate', 'oncePerBar', 'onBarClose', 'once']);

function copyValues(values: IndicatorValues, end?: number): IndicatorValues {
  const result: IndicatorValues = {};
  for (const key of Object.keys(values)) {
    Object.defineProperty(result, key, {
      value: Object.freeze(values[key]!.slice(0, end)), enumerable: true, // an own key
    });
  }
  return Object.freeze(result);
}

/** Explicit policies only. The instance retains the omitted-frequency legacy path. */
export class IndicatorAlertPolicy {
  private readonly _entries: Entry[] = [];
  private readonly _legacyCalculations = new WeakSet<IndicatorCalcContext>();
  private _initialized = false;
  private _native = false;
  private _sourceId: number | undefined;
  private _historyRevision: number | undefined;
  private _revision: number | undefined;
  private _replaying = false;
  private _epoch = 0;

  public constructor(specs: readonly IndicatorAlertSpec[]) {
    const ids = new Set<string>();
    for (const spec of specs) {
      const frequency = spec.frequency;
      if (frequency === undefined) continue;
      if (!FREQUENCIES.has(frequency)) throw new TypeError('Indicator alert frequency is invalid');
      if (typeof spec.id !== 'string' || spec.id.trim() === '') throw new TypeError('Explicit indicator alert id must be nonempty');
      if (ids.has(spec.id)) throw new TypeError('Explicit indicator alert ids must be unique');
      ids.add(spec.id);
      this._entries.push({
        spec: Object.freeze({ ...spec, frequency }), onceSpent: false,
        perBarTime: -Infinity, closedTime: -Infinity, failedCloses: new Set(), busy: false,
      });
    }
  }

  /** Evaluate one observed calculation. There is no timer or notification transport. */
  public evaluate(pass: IndicatorAlertPolicyPass, emit: (payload: PolicyAlert) => void): void {
    if (this._entries.length === 0 || !pass.current()) return;
    const execution = pass.calculation.execution;
    const native = execution !== undefined;
    const replaying = execution?.provenance === 'replay';
    const generation = !this._initialized || this._native !== native || (native && (
      execution.sourceId !== this._sourceId || execution.historyRevision !== this._historyRevision || replaying !== this._replaying
    ));
    if (native) {
      if (!generation && this._revision !== undefined && execution.revision <= this._revision) return;
    } else {
      if (this._legacyCalculations.has(pass.calculation)) return;
      this._legacyCalculations.add(pass.calculation);
    }

    // Reserve before callbacks. Repeated reads of a failed revision cannot
    // redeliver successful siblings or retry a failed predicate immediately.
    const epoch = ++this._epoch;
    this._initialized = true;
    this._native = native;
    this._sourceId = execution?.sourceId;
    this._historyRevision = execution?.historyRevision;
    this._revision = execution?.revision;
    this._replaying = replaying;
    const confirmed = pass.calculation.barState.isConfirmed;
    const refresh = pass.refresh || execution?.change === 'refresh';
    const live = native ? execution.provenance === 'live' : pass.tailOnly;
    if (generation || (!refresh && !live)) {
      this._seed(pass.bars, confirmed);
      return;
    }
    if (refresh || !live || pass.bars.length === 0) return;

    const bars = Object.freeze(pass.bars.map(bar => Object.freeze({ ...bar })));
    const values = copyValues(pass.values);
    const settings = Object.freeze({ ...pass.settings });
    const current = (): boolean => this._epoch === epoch && pass.current();
    if (!current()) return;
    let failed = false;
    let firstError: unknown;
    const last = bars.length - 1;
    const closed = confirmed ? last : last - 1;
    for (const entry of this._entries) {
      if (!current()) return;
      if (entry.busy || (entry.spec.frequency === 'once' && entry.onceSpent)) continue;
      const close = entry.spec.frequency === 'onBarClose';
      const indices = close ? this._closeIndices(entry, bars, closed) : [last];
      for (const index of indices) { // bar indices, `last` at most
        if (!current()) return;
        const time = bars[index]!.time;
        if (entry.spec.frequency === 'oncePerBar' && time <= entry.perBarTime) continue;
        const context: IndicatorAlertContext = {
          bars: close ? Object.freeze(bars.slice(0, index + 1)) : bars,
          values: close ? copyValues(values, index + 1) : values,
          settings, index,
        };
        let committed = false;
        entry.busy = true;
        try {
          if (!current()) return;
          const matches = entry.spec.when(context);
          if (!current()) return;
          if (!matches) {
            if (close) this._judgeClose(entry, time);
            continue;
          }
          const message = typeof entry.spec.message === 'function'
            ? entry.spec.message(context) : entry.spec.message ?? entry.spec.title;
          if (!current()) return;
          const payload: PolicyAlert = { alertId: entry.spec.id, title: entry.spec.title, message, time, index };
          // Native event dispatch is the commitment boundary. A subscriber
          // exception cannot make a spent alert available for another delivery.
          if (entry.spec.frequency === 'once') entry.onceSpent = true;
          if (entry.spec.frequency === 'oncePerBar') entry.perBarTime = time;
          if (close) this._judgeClose(entry, time);
          committed = true;
          emit(payload);
          if (!current()) return;
        } catch (error) {
          if (!current()) return;
          if (close && !committed) entry.failedCloses.add(time);
          if (!failed) { failed = true; firstError = error; }
        } finally {
          entry.busy = false;
        }
      }
    }
    if (failed && current()) throw firstError;
  }

  private _seed(bars: readonly Bar[], confirmed: boolean): void {
    const index = bars.length - (confirmed ? 1 : 2);
    const time = index >= 0 ? bars[index]!.time : -Infinity;
    for (const entry of this._entries) {
      entry.perBarTime = time;
      entry.closedTime = time;
      entry.failedCloses.clear();
    }
  }

  private _judgeClose(entry: Entry, time: number): void {
    entry.closedTime = Math.max(entry.closedTime, time);
    entry.failedCloses.delete(time);
  }

  private _closeIndices(entry: Entry, bars: readonly Bar[], end: number): number[] {
    const indices: number[] = [];
    const available = new Set<number>();
    for (let i = 0; i <= end; i++) { // `end` is a bar index
      const time = bars[i]!.time;
      if (time > entry.closedTime || entry.failedCloses.has(time)) indices.push(i);
      available.add(time);
    }
    for (const time of entry.failedCloses) if (!available.has(time)) entry.failedCloses.delete(time);
    return indices;
  }
}
