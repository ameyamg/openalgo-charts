import { describe, it, expect } from 'vitest';
import { chartTypeSeries, inChartTransforms } from '../src/transforms.js';

describe('chartTypeSeries', () => {
  it('hands a renderer choice straight through', () => {
    expect(chartTypeSeries('line')).toEqual({ type: 'line', transform: null });
    expect(chartTypeSeries('candlestick', 'atr')).toEqual({ type: 'candlestick', transform: null });
  });

  it('maps each transform choice onto the renderer and the transform the chart applies', () => {
    expect(inChartTransforms).toBe(true);
    expect(chartTypeSeries('t:heikin-ashi')).toEqual({ type: 'candlestick', transform: { type: 'heikin-ashi' } });
    expect(chartTypeSeries('t:renko')).toEqual({ type: 'candlestick', transform: { type: 'renko' } });
    expect(chartTypeSeries('t:line-break')).toEqual({ type: 'candlestick', transform: { type: 'line-break' } });
    expect(chartTypeSeries('t:kagi')).toEqual({ type: 'kagi', transform: { type: 'kagi' } });
    // The select's value predates the transform's own id and stays for saved layouts.
    expect(chartTypeSeries('t:range')).toEqual({ type: 'candlestick', transform: { type: 'range-bars' } });
  });

  it('sizes point and figure boxes as the box-mode select says', () => {
    expect(chartTypeSeries('t:point-figure', 'fixed')).toEqual({ type: 'point-figure', transform: { type: 'point-figure' } });
    expect(chartTypeSeries('t:point-figure', 'atr').transform).toEqual({ type: 'point-figure', options: { mode: 'atr' } });
    expect(chartTypeSeries('t:point-figure', 'percent').transform).toEqual({ type: 'point-figure', options: { mode: 'percent' } });
  });
});
