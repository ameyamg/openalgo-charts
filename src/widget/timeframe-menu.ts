import { intervalParts } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import { h, glyph, type WidgetContext } from './context';
import { widgetText, type WidgetBuiltinMessage } from './localization';
import { customTimeframeCode, type TimeframePreferences, type TimeframeUnit } from './timeframe-preferences';

export type TimeframeMenuContext = Pick<WidgetContext, 'document' | 'openOverlay' | 'translate'>;
type Context = TimeframeMenuContext;
export interface TimeframeMenuOptions {
  intervals: readonly string[];
  current(): string;
  preferences: TimeframePreferences;
  canSelect?(code: string): boolean;
  onSelect(code: string): void;
}

const GROUPS: Readonly<Record<string, WidgetBuiltinMessage>> = { tick: 'Ticks', s: 'Seconds', m: 'Minutes', h: 'Hours', D: 'Days', W: 'Weeks', M: 'Months', other: 'Other intervals' };
const ORDER = ['tick', 's', 'm', 'h', 'D', 'W', 'M', 'other'];
function label(ctx: Context, code: string): string {
  const parts = intervalParts(code);
  if (!parts || parts.unit === 'other') return code;
  const name = GROUPS[parts.unit]!.toLowerCase();
  return widgetText(ctx, `schema.timeframe.${parts.unit}.${parts.multiplier === 1 ? 'one' : 'many'}`, { count: parts.multiplier }, `${parts.multiplier} ${parts.multiplier === 1 ? name.slice(0, -1) : name}`);
}
function button(ctx: Context, text: string, icon?: string): HTMLButtonElement {
  const node = h(ctx.document, 'button', 'oac-btn', { type: 'button', 'aria-label': text, title: text });
  if (icon) node.appendChild(glyph(ctx.document, chromeIconSvg(icon), 'chrome'));
  else node.textContent = text;
  return node;
}

/** Unit/count entry with host-owned validation; the overlay owns focus and Escape. */
export function openCustomTimeframeDialog(ctx: TimeframeMenuContext, anchor: HTMLElement, opts: TimeframeMenuOptions): () => void {
  const panel = h(ctx.document, 'div', 'oac-dialog oac-timeframe-dialog', { role: 'dialog', 'aria-label': widgetText(ctx, 'Add custom interval') });
  const header = h(ctx.document, 'div', 'oac-timeframe-dialog__header'), title = h(ctx.document, 'h3');
  title.textContent = widgetText(ctx, 'Add custom interval');
  const dismiss = button(ctx, widgetText(ctx, 'Close'), 'close'); header.append(title, dismiss); panel.appendChild(header);
  const fields = h(ctx.document, 'div', 'oac-timeframe-dialog__fields');
  const typeLabel = h(ctx.document, 'label'), quantityLabel = h(ctx.document, 'label');
  typeLabel.textContent = widgetText(ctx, 'Type'); quantityLabel.textContent = widgetText(ctx, 'Interval');
  const unit = h(ctx.document, 'select', 'oac-input', { name: 'unit', 'aria-label': widgetText(ctx, 'Type') });
  for (const name of ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'quarters', 'years'] as const) {
    const option = h(ctx.document, 'option', undefined, { value: name }); option.textContent = widgetText(ctx, `schema.timeframe.unit.${name}`, {}, name); unit.appendChild(option);
  }
  unit.value = 'minutes';
  const quantity = h(ctx.document, 'input', 'oac-input', { name: 'quantity', type: 'number', min: '1', max: '100000', step: '1', inputmode: 'numeric', 'aria-label': widgetText(ctx, 'Interval') });
  const unitWrap = h(ctx.document, 'span', 'oac-timeframe-dialog__unit');
  unitWrap.append(unit, glyph(ctx.document, chromeIconSvg('chevron-down'), 'chrome'));
  typeLabel.appendChild(unitWrap); quantityLabel.appendChild(quantity); fields.append(typeLabel, quantityLabel); panel.appendChild(fields);
  const error = h(ctx.document, 'div', 'oac-timeframe-dialog__error', { role: 'status' }); panel.appendChild(error);
  const footer = h(ctx.document, 'div', 'oac-timeframe-dialog__footer'), cancel = button(ctx, widgetText(ctx, 'Cancel')), add = button(ctx, widgetText(ctx, 'Add'));
  add.dataset.confirmInterval = ''; add.classList.add('is-primary'); footer.append(cancel, add); panel.appendChild(footer);
  let code = '', close = (): void => {};
  const validate = (): void => {
    try {
      code = customTimeframeCode(Number(quantity.value), unit.value as TimeframeUnit);
      if (opts.canSelect && !opts.canSelect(code)) throw new Error(widgetText(ctx, 'The current source cannot build this interval'));
      add.disabled = false; error.textContent = '';
    } catch (failure) { code = ''; add.disabled = true; error.textContent = quantity.value ? String((failure as Error).message) : ''; }
  };
  const commit = (): void => { validate(); if (!code) return; try { opts.preferences.addCustom(code); close(); opts.onSelect(code); } catch (failure) { error.textContent = String((failure as Error).message); } };
  quantity.addEventListener('input', validate); unit.addEventListener('change', validate); add.addEventListener('click', commit);
  quantity.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); commit(); } });
  dismiss.addEventListener('click', () => close()); cancel.addEventListener('click', () => close()); validate();
  close = ctx.openOverlay(panel, { anchor, placement: 'center', initialFocus: quantity });
  return close;
}

/** Grouped interval choices with fixed action columns for stable pointer targets. */
export function openTimeframeMenu(ctx: TimeframeMenuContext, anchor: HTMLElement, opts: TimeframeMenuOptions): () => void {
  const panel = h(ctx.document, 'div', 'oac-menu oac-timeframe-menu', { role: 'dialog', 'aria-label': widgetText(ctx, 'Timeframes') });
  const add = button(ctx, widgetText(ctx, 'Add custom interval')); add.dataset.addInterval = ''; add.prepend(glyph(ctx.document, chromeIconSvg('plus'), 'chrome')); panel.appendChild(add);
  const body = h(ctx.document, 'div', 'oac-timeframe-menu__body'); panel.appendChild(body);
  const collapsed = new Set<string>();
  let close = (): void => {}, off = (): void => {};
  add.addEventListener('click', () => { close(); openCustomTimeframeDialog(ctx, anchor, opts); });
  const paint = (): void => {
    const focus = ctx.document.activeElement as HTMLElement | null;
    const focusCode = focus?.dataset.favorite ?? focus?.dataset.removeInterval;
    const wasRemove = focus?.dataset.removeInterval !== undefined;
    body.textContent = '';
    const codes = [...new Set([...opts.intervals, ...opts.preferences.custom(), ...opts.preferences.favorites(), opts.current()])];
    const favorites = new Set(opts.preferences.favorites()), custom = new Set(opts.preferences.custom());
    for (const group of ORDER) {
      const items = codes.filter(code => (intervalParts(code)?.unit ?? 'other') === group);
      if (!items.length) continue;
      const section = h(ctx.document, 'div', 'oac-timeframe-menu__group'), heading = button(ctx, widgetText(ctx, GROUPS[group]!));
      heading.classList.add('oac-timeframe-menu__heading'); heading.setAttribute('aria-expanded', String(!collapsed.has(group)));
      heading.appendChild(glyph(ctx.document, chromeIconSvg(collapsed.has(group) ? 'chevron-down' : 'chevron-up'), 'chrome'));
      heading.addEventListener('click', () => { if (!collapsed.delete(group)) collapsed.add(group); paint(); });
      section.appendChild(heading); body.appendChild(section);
      if (collapsed.has(group)) continue;
      for (const code of items.sort((a, b) => (intervalParts(a)?.multiplier ?? 0) - (intervalParts(b)?.multiplier ?? 0))) {
        const row = h(ctx.document, 'div', 'oac-timeframe-menu__row'); row.dataset.selected = String(opts.current() === code);
        const pick = button(ctx, label(ctx, code)); pick.dataset.pickInterval = code; pick.dataset.interval = code; pick.classList.add('oac-timeframe-menu__pick');
        pick.setAttribute('aria-pressed', String(opts.current() === code)); pick.disabled = opts.canSelect?.(code) === false;
        if (pick.disabled) pick.title = widgetText(ctx, 'The current source cannot build this interval');
        pick.addEventListener('click', () => { if (pick.disabled) return; close(); opts.onSelect(code); });
        const remove = button(ctx, widgetText(ctx, 'Remove {code}', { code }), 'trash'); remove.dataset.removeInterval = code; remove.hidden = !custom.has(code);
        remove.addEventListener('click', () => opts.preferences.removeCustom(code));
        const star = button(ctx, widgetText(ctx, favorites.has(code) ? 'Remove {code} from favorites' : 'Add {code} to favorites', { code }), favorites.has(code) ? 'star-filled' : 'star');
        star.dataset.favorite = code; star.setAttribute('aria-pressed', String(favorites.has(code))); star.addEventListener('click', () => opts.preferences.toggle(code));
        const actions = h(ctx.document, 'div', 'oac-timeframe-menu__actions'); actions.append(remove, star); row.append(pick, actions); section.appendChild(row);
      }
    }
    if (focusCode) Array.from(body.querySelectorAll<HTMLElement>('button')).find(node =>
      (wasRemove ? node.dataset.removeInterval : node.dataset.favorite) === focusCode)?.focus();
  };
  paint(); off = opts.preferences.subscribe(paint);
  panel.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const nodes = Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).filter(node => !node.hidden && !node.disabled);
    const at = nodes.indexOf(ctx.document.activeElement as HTMLButtonElement), step = key === 'ArrowDown' ? 1 : -1;
    nodes[(at + step + nodes.length) % nodes.length]?.focus(); event.preventDefault(); event.stopPropagation();
  });
  const selected = Array.from(body.querySelectorAll<HTMLButtonElement>('[data-pick-interval]')).find(node => node.dataset.pickInterval === opts.current());
  const dismiss = ctx.openOverlay(panel, { anchor, placement: 'below', initialFocus: selected ?? add, onClose: () => off() });
  close = () => { off(); dismiss(); };
  return close;
}

export const TIMEFRAME_MENU_CSS = `
.oac-timeframe-menu{width:260px;max-width:calc(100vw - 24px);padding:6px}
.oac-timeframe-menu>[data-add-interval]{display:flex;gap:8px;width:100%;justify-content:flex-start;min-height:34px}
.oac-timeframe-menu__body{max-height:min(65vh,560px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--oac-sb-thumb) transparent}
.oac-timeframe-menu__body::-webkit-scrollbar{width:6px}.oac-timeframe-menu__body::-webkit-scrollbar-thumb{background:var(--oac-sb-thumb);border-radius:3px}
.oac-timeframe-menu__body::-webkit-scrollbar-thumb:hover{background:var(--oac-sb-thumb-hover)}
.oac-timeframe-menu__group{border-top:1px solid var(--oac-bd);padding:5px 0}
.oac-timeframe-menu__heading{width:100%;display:flex;justify-content:space-between;text-transform:uppercase;font-size:10px;letter-spacing:.06em;color:var(--oac-mut);min-height:28px}
.oac-timeframe-menu__row{display:flex;align-items:center;border-radius:4px;min-height:34px}
.oac-timeframe-menu__row:hover,.oac-timeframe-menu__row:focus-within{background:var(--oac-elev-2)}
.oac-timeframe-menu__row[data-selected="true"]{background:var(--oac-on-bg)}
.oac-timeframe-menu__pick{flex:1;text-align:left;min-height:34px;justify-content:flex-start}
.oac-timeframe-menu__actions{display:grid;grid-template-columns:28px 28px;flex:none;gap:2px}
.oac-timeframe-menu__actions button{width:28px;height:28px;padding:5px}.oac-timeframe-menu__actions [hidden]{display:block;visibility:hidden;pointer-events:none}
.oac-timeframe-dialog{width:340px;max-width:calc(100vw - 24px);padding:14px}
.oac-timeframe-dialog__header,.oac-timeframe-dialog__footer{display:flex;align-items:center;justify-content:space-between;gap:10px}
.oac-timeframe-dialog__header h3{font-size:15px;margin:0}.oac-timeframe-dialog__fields{display:grid;gap:12px;margin-top:20px}
.oac-timeframe-dialog__fields label{display:grid;grid-template-columns:80px 1fr;align-items:center;gap:12px}
.oac-timeframe-dialog__unit{position:relative;display:block}.oac-timeframe-dialog__unit .oac-glyph{position:absolute;right:8px;top:8px;pointer-events:none}
.oac-timeframe-dialog__unit select{padding-right:30px}
.oac-timeframe-dialog__fields input,.oac-timeframe-dialog__fields select{width:100%;min-width:0;background:var(--oac-bg);color:var(--oac-tx);border:1px solid var(--oac-bd);border-radius:4px;padding:7px;appearance:none}
.oac-timeframe-dialog__error{min-height:30px;padding:8px 0;font-size:11px;color:var(--oac-mut)}
.oac-timeframe-dialog__footer{justify-content:flex-end}.oac-timeframe-dialog__footer button{min-width:58px;min-height:30px}
`;
