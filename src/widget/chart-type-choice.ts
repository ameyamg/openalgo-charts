/**
 * Whether a widget can show a chart type. A leaf module, so the layout,
 * persistence and grid code that validate a saved chart type need not import
 * the top bar, which imports the Layouts button and through it those modules.
 */
import { registeredChartTypes, registeredSeriesTransforms } from 'openalgo-charts';

/** Whether a widget can show this chart type: a registered renderer, or a transform the chart applies. Internal. */
export function isChartTypeChoice(id: unknown): id is string {
  return typeof id === 'string' && (registeredChartTypes().includes(id) || registeredSeriesTransforms().includes(id));
}
