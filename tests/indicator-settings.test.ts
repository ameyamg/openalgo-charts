/**
 * How the built-ins read a settings blob. A blob carries whatever a settings
 * UI, a saved chart or a host wrote, so every built-in reads it by one rule,
 * whichever module it lives in: the same value means the same thing to all of
 * them.
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_INDICATORS } from '../src/indicators/index';
import { indicatorDefaults } from '../src/model/indicator-registry';
import type { IndicatorDescriptor, IndicatorSettings, IndicatorValues } from '../src/model/indicator-registry';
import { completeSessions } from './helpers/indicator-golden';

const bars = completeSessions().slice(0, 400);

/**
 * Everything a study derives from its settings: its columns, the colour every
 * coloured plot gives each bar, and what each optional hook returns.
 */
function output(d: IndicatorDescriptor, settings: IndicatorSettings): unknown {
  const values: IndicatorValues = d.calc(bars, settings, {});
  const colours: Record<string, unknown[]> = {};
  for (const plot of d.plots) {
    if (plot.colorBy === undefined && plot.colorParts === undefined) continue;
    colours[plot.key] = (values[plot.key] ?? []).map((value, index) => value === null ? null : [
      plot.colorBy?.({ value, index, values, settings }),
      plot.colorParts?.({ value, index, values, settings }),
    ]);
  }
  const ctx = { bars, values, settings };
  return {
    values, colours,
    markers: d.markers?.(ctx), table: d.table?.(ctx), tables: d.tables?.(ctx), draws: d.draws?.(ctx),
    background: d.background?.(ctx), barColors: d.barColors?.(ctx),
    levels: d.levels?.({ ...settings, settings, bars, values }), range: d.range?.(settings),
  };
}

/** Each built-in with one input set to `value`, against the same study on its defaults. */
function cases(pick: (input: IndicatorDescriptor['inputs'][number]) => boolean) {
  return BUILTIN_INDICATORS.flatMap((d) => d.inputs.filter(pick).map((input) => ({ d, key: input.key })));
}

describe('built-in settings', () => {
  it('reads an empty colour or choice as its declared default', () => {
    const differ: string[] = [];
    for (const { d, key } of cases((input) => input.type === 'color' || input.type === 'select')) {
      const defaults = indicatorDefaults(d);
      if (JSON.stringify(output(d, { ...defaults, [key]: '' })) !== JSON.stringify(output(d, defaults))) {
        differ.push(`${d.id}:${key}`);
      }
    }
    expect(differ).toEqual([]);
  });
});
