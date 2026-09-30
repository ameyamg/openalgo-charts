import type { ChartDataCsvOptions } from 'openalgo-charts';
import type { WidgetContext } from './context';
import { button, dialogFrame, el, openPanel, renderForm, type FormControl, type PanelHandle } from './form';
import { errorText, widgetText } from './localization';
import { studyNames } from './objects-panel';

let sequence = 0;

/** Capture the offered studies and viewport once; the caller guards the source at download. */
export function openChartDataExportDialog(
  ctx: WidgetContext, anchor: HTMLElement, onDownload: (options: ChartDataCsvOptions) => void,
): PanelHandle {
  const chart = ctx.chart;
  const names = studyNames(chart);
  const studies = chart.indicators().map(study => ({ id: study.id, name: names.get(study.id)!, hidden: !study.visible() }));
  const viewport = chart.getVisibleLogicalRange();
  const visible = chart.primaryBars().filter(bar => {
    const index = chart.dataLayer.timeToIndex(bar.time);
    return Number.isFinite(bar.time) && index !== undefined && index >= viewport.from && index <= viewport.to;
  });
  const visibleRange = visible.length ? { from: visible[0]!.time, to: visible[visible.length - 1]!.time } : null; // not empty here
  let closed = false;
  let panel: PanelHandle | null = null;
  let offDestroy = (): void => {};
  const frame = dialogFrame(ctx.document, {
    translate: ctx.translate, title: widgetText(ctx, 'Download chart data (CSV)'), className: 'oac-csv', onClose: close,
  });
  const hint = el(ctx.document, 'p', 'oac-csv__hint', widgetText(ctx, 'Only loaded rows are exported. Blank bounds include all loaded times.'));
  const actions = el(ctx.document, 'div', 'oac-csv__ranges');
  const formHost = el(ctx.document, 'div');
  const error = el(ctx.document, 'p', 'oac-csv__error');
  error.setAttribute('role', 'alert');
  frame.body.append(hint, actions, formHost, error);
  const controls: FormControl[] = [
    { key: 'from', kind: 'text', label: widgetText(ctx, 'From (UTC seconds)') },
    { key: 'to', kind: 'text', label: widgetText(ctx, 'To (UTC seconds)') },
    { key: 'alignment', kind: 'select', label: widgetText(ctx, 'Study alignment'), options: [
      { value: 'source', label: widgetText(ctx, 'Source rows') },
      { value: 'display', label: widgetText(ctx, 'Displayed rows') },
    ] },
    ...studies.map((study, index): FormControl => ({
      key: `study-${index}`, kind: 'boolean', group: widgetText(ctx, 'Studies'),
      label: study.hidden ? widgetText(ctx, '{name}, hidden', { name: study.name }) : study.name,
    })),
  ];
  const form = renderForm(formHost, controls, {
    idPrefix: `oac-csv-${++sequence}`, translate: ctx.translate, openOverlay: ctx.openOverlay,
    values: { from: '', to: '', alignment: 'source', ...Object.fromEntries(studies.map((_, index) => [`study-${index}`, true])) },
    onChange: key => { form.setError(key, null); error.textContent = ''; },
  });
  const setBounds = (from: string, to: string): void => {
    form.setError('from', null); form.setError('to', null); error.textContent = '';
    form.sync({ from, to });
  };
  const visibleButton = button(ctx.document, { label: widgetText(ctx, 'Use captured visible range'),
    onClick: () => { if (visibleRange) setBounds(String(visibleRange.from), String(visibleRange.to)); } });
  visibleButton.dataset.action = 'csv-visible';
  visibleButton.disabled = visibleRange === null;
  const allButton = button(ctx.document, { label: widgetText(ctx, 'All loaded rows'), onClick: () => setBounds('', '') });
  allButton.dataset.action = 'csv-all';
  actions.append(visibleButton, allButton);
  const cancel = button(ctx.document, { label: widgetText(ctx, 'Cancel'), onClick: close });
  const download = button(ctx.document, { label: widgetText(ctx, 'Download CSV'), variant: 'primary', onClick: commit });
  download.dataset.action = 'download-csv';
  frame.actions.append(cancel, download);
  function close(): void {
    if (closed) return;
    closed = true;
    offDestroy(); form.destroy(); panel?.close();
  }
  function commit(): void {
    if (closed) return;
    const draft = form.values();
    const range: { from?: number; to?: number } = {};
    try {
      for (const key of ['from', 'to'] as const) {
        form.setError(key, null);
        const text = String(draft[key] ?? '').trim();
        if (text === '') continue;
        const value = Number(text);
        if (!Number.isFinite(value)) {
          const message = widgetText(ctx, 'Enter finite UTC seconds or leave the bound blank');
          form.setError(key, message); throw new Error(message);
        }
        range[key] = value;
      }
      if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
        const message = widgetText(ctx, 'The From bound must be before or equal to the To bound');
        form.setError('to', message); throw new Error(message);
      }
      onDownload({ indicators: studies.filter((_, index) => draft[`study-${index}`] === true).map(study => study.id),
        range, alignment: draft.alignment === 'display' ? 'display' : 'source' });
      close();
    } catch (cause) {
      const message = errorText(ctx, cause);
      error.textContent = message;
      ctx.status(widgetText(ctx, 'Data export failed: {error}', { error: message }), 'error');
    }
  }
  offDestroy = chart.on('destroy', close);
  panel = openPanel(ctx, frame.el, { anchor, modal: true, placement: 'center' }, close);
  if (closed) panel.close();
  return { el: frame.el, close, isOpen: () => !closed && panel!.isOpen() };
}
