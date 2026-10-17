import type { IndicatorSettings } from 'openalgo-charts';

/** Explicit sufficient seed lengths, not convergence guarantees for recursive kernels. */
export function timeframeHistoryBars(id: string, settings: Readonly<IndicatorSettings>): number | null {
  const n = (key: string, fallback: number): number => Math.max(1, Math.round(Number(settings[key] ?? fallback)));
  const length = n('length', 20), offset = Math.max(0, Math.round(Number(settings.offset ?? 0)));
  switch (id) {
    case 'sma': case 'ema': case 'wma': return n('length', 9);
    case 'vwma': case 'lsma': case 'donchian': return length + offset;
    case 'alma': case 'smma': case 'mcginley-dynamic': case 'bollinger': case 'envelope': return length;
    case 'dema': return 2 * length - 1;
    case 'tema': return 3 * length - 2;
    case 't3': return 6 * length - 5;
    case 'hma': return length + Math.ceil(Math.sqrt(length));
    case 'zlema': return length + Math.floor((length - 1) / 2);
    case 'kama': return n('erLength', 10) + 1;
    case 'vidya': return length + n('cmoLength', 9) + 1;
    case 'rsi': return n('length', 14) + 1;
    case 'macd': return Math.max(n('fastPeriod', 12), n('slowPeriod', 26)) + n('signalPeriod', 9) - 1;
    case 'stochastic': return n('kPeriod', 14) + n('kSmoothing', 1) + n('dPeriod', 3) - 2;
    case 'stochastic-rsi': return n('lengthRSI', 14) + n('lengthStoch', 14) + n('smoothK', 3) + n('smoothD', 3);
    case 'adx': return n('period', 14) + n('adxPeriod', 14);
    case 'atr': case 'supertrend': return n('period', 14) + 1;
    case 'keltner-channel': return Math.max(length, n('atrlength', 10)) + 1;
    case 'parabolic-sar': return 2;
    case 'williams-percent-r': return n('length', 14);
    case 'cci': return n('period', 20);
    default: return null;
  }
}
