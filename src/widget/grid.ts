/**
 * The chart grid: several widgets in one workspace.
 *
 * `createChartGrid(container, options)` lays one widget out per cell on a rows
 * by columns grid, puts splitters between the tracks, keeps one cell active,
 * links the charts through the engine's link groups, and reads and writes the
 * portable payload of `openalgo-charts/workspace`, so a saved desk opens here
 * with the geometry, weights, focus and links it was saved with.
 *
 * Decisions worth recording:
 *
 * - **Every cell is an ordinary widget.** The grid adds layout, focus and
 *   linking around them and reaches each one through its public API, so a
 *   cell loads, cancels and tears down its own feed exactly as a lone widget.
 * - **One active cell answers the keyboard.** Every widget listens on the
 *   document, so without a referee one chord reaches each chart the pointer or
 *   the focus happens to touch. Other cells are silenced through
 *   `keyboardRoute`, and a key pressed with the focus on the page itself goes
 *   to the active chart while the pointer is over the grid.
 * - **Applying a workspace is all or nothing.** The new cells are built and
 *   restored off to the side; the first failure destroys them, which cancels
 *   their history requests, and the charts on screen are never touched.
 * - **A view set by data is not a pan.** A chart fitting bars it has just
 *   received moves its window, and broadcasting that to a follower on another
 *   timeframe would squeeze the follower's data into a sliver. Data-driven
 *   moves stay local; linked views converge on the next real pan or zoom.
 * - **Each chart keeps drawings per instrument, for itself.** A cell's store
 *   is its own, keyed by its pane id: two cells on one symbol writing one
 *   shared document would each overwrite the other's lines. The documents of
 *   the instruments a cell is not showing are saved beside the workspace,
 *   whose own payload carries only what each chart shows.
 * - **Maximizing is a view, not a layout.** It shows the active chart alone
 *   the way the compact width does, keeps every other chart alive behind it,
 *   and is not saved: a desk reopens as the grid it is.
 * - **The grid's chrome is the host's choice.** The bar over the charts and
 *   the one under them are off unless asked for, so a host with controls of
 *   its own keeps its page as it was, and each chart keeps its own Go to and
 *   market status until a bar under the grid takes them over.
 */
import type { ChartEventMap, ChartTheme, DataFeed, DataVariant, LinkChart, LinkOptions, ResolvedLinkOptions } from 'openalgo-charts';
import type { WorkspaceChartState, WorkspacePane, WorkspacePayload, WorkspaceStore } from 'openalgo-charts/workspace';
import type { DrawingsDocument } from 'openalgo-charts/draw';
import {
  WidgetBus, WidgetStorage, createOverlayStack, createTipController, h,
  type AsyncStorageLike, type OverlayOptions, type OverlayStack, type StorageLike, type TipController, type WidgetContext,
} from './context';
import { defaultWidgetStore } from './storage';
import { mountBottombar, type BottombarHandle } from './bottombar';
import type { LayoutsController } from './layouts';
import { errorText, widgetText } from './localization';
import { applyTokens, widgetTokens, TOKEN_PREFIX, WIDGET_FONT, type WidgetThemeName } from './tokens';
import { captureName, type MenuRow } from './topbar';
import { GRID_BAR_CHARTS, createWidget, resolveTheme, SAVE_DEBOUNCE_MS, type Widget, type WidgetOptions } from './widget';
import type { GridSaved } from './grid-saved';
import { cellDrawingStore, checkWorkspace, readChartDrawings, type ChartDrawings } from './grid-payload';
import { CHART_GRID_LAYOUTS, focusSlot, isChartGridLayout, type ChartGridLayoutId } from './grid-layouts';
import {
  ALL_OFF, GridLinks, channelsOf, describeGroups, instrument,
  type ChartGridLinkGroup, type GridGroup, type LinkChannel,
} from './grid-links';
import type { GridBarHandle, GridBarHost } from './grid-bar';
import { captureRatio, composeGridCapture, type CaptureBox, type GridCapturePiece } from './grid-capture';
import { groupMark, installGridKeys, installHeaderDrag, neighbour } from './grid-cells';
import { KEYMAP_KEY } from './keymap';
import { lazyPart, partFailed, usePart, type PartSlot } from './lazy';

/** The grid bar, fetched when a grid shows it, and its menus, fetched when one first opens (lazy.ts). Internal. */
export const gridBarPart = lazyPart(() => import('./grid-bar'));
export const gridMenusPart = lazyPart(() => import('./grid-menus'));

export { CHART_GRID_PRESETS, type ChartGridPreset } from './grid-layouts';

export interface ChartGridOptions extends Omit<WidgetOptions, 'persist' | 'storage' | 'keyboardRoute' | 'feed' | 'drawingStore' | 'captureRows'> {
  /**
   * Where the charts load bars: one feed for every chart, or a function that
   * builds each chart's feed from its pane id and the `historyPeriod` its
   * workspace pane carries, for a host whose source answers by period.
   */
  feed?: DataFeed | ((chart: { readonly id: string; readonly historyPeriod?: string }) => DataFeed);
  /** The layout to start with when nothing is restored: a preset or any `CHART_GRID_LAYOUTS` id. Default `1x1`. */
  preset?: ChartGridLayoutId;
  /** Link channels the first group starts with, and every new group. Default: crosshair and viewport on, the rest off. */
  links?: LinkOptions;
  /** At or below this width in CSS px only the active chart shows, with tabs to switch. 0 turns it off. Default 640. */
  compactWidth?: number;
  /** Keep the workspace between visits: `true` for one shared namespace, a string to name one. Default off. */
  persist?: boolean | string;
  /**
   * The store behind `persist`. Default: IndexedDB where the page has it
   * (since 2.5.10), else the page's `localStorage`. Over an asynchronous
   * store the saved desk lands when `ready` settles; a synchronous one, such
   * as `localStorage` passed here, restores it before `createChartGrid` returns.
   */
  storage?: StorageLike | AsyncStorageLike | null;
  /**
   * Show the grid bar over the charts: the layout picker, maximize and
   * restore, the link menu, a capture of every chart and, with `workspaces`,
   * the desk's saved layouts. Default false, so a host with its own controls
   * keeps its page as it was.
   */
  toolbar?: boolean;
  /**
   * One bottom bar under the grid, acting on the active chart: preset ranges,
   * Go to, the market status, the clock and the price scale toggles (since
   * 2.5.10). The charts then leave Go to out of their own bars and the market
   * status off their status lines. Default false, as for `toolbar`: each
   * chart keeps both.
   */
  bottombar?: boolean;
  /**
   * Saved layouts of the whole desk, and indicator templates in every
   * chart's picker: a `WorkspaceRepository` from `openalgo-charts/workspace`,
   * or a host's own `WorkspaceStore`. With the grid bar (`toolbar`) the grid
   * keeps a layouts controller over every chart: a Layouts control in the bar
   * saves and opens the desk, autosave follows it, and the layout that was
   * active when the page last closed opens once `ready` settles, unless the
   * host has applied a workspace by then. Without the bar the charts get their
   * templates only. Taken as a type only.
   */
  workspaces?: WorkspaceStore;
  /**
   * What the grid bar's Layouts control drives instead of the grid's own
   * controller: one the host built over this grid; false for no control.
   * Without the bar (`toolbar`), a controller given here drives each chart's
   * own Layouts button instead. A chart never saves a layout of its own inside
   * a grid.
   */
  layouts?: LayoutsController | false;
  /**
   * The layouts the bar's picker offers, in its order, as `intervals` lists
   * the intervals beside `interval`. Default: every `CHART_GRID_LAYOUTS`
   * entry. Empty: the bar has no Layout control. (`layouts` keeps its widget
   * meaning here: the saved-layouts controller every chart's menu drives.)
   */
  presets?: readonly ChartGridLayoutId[];
}

export interface ChartGridCell {
  /** The workspace pane id. */
  readonly id: string;
  readonly widget: Widget;
  /** The `.oac-grid__cell` element the widget lives in. */
  readonly element: HTMLElement;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  /**
   * The host's name for how much history the chart loads, from the applied
   * workspace pane or the active chart a preset copied. The grid only keeps it
   * and writes it back; a `feed` function is what honours it.
   */
  readonly historyPeriod?: string;
  /** The id of the link group the chart is in, or null when it links with none. */
  readonly linkGroup: string | null;
}

export interface ChartGridLayout {
  rows: number;
  columns: number;
  /** The layout id or saved preset name the layout came from, or null. */
  preset: string | null;
  rowWeights: number[];
  columnWeights: number[];
}

export interface ChartGridApplyReport {
  applied: boolean;
  reason?: string;
}

export interface ChartGridEvents {
  active: { id: string };
  /** `preset`, `weights`, `workspace`, `compact`, `maximize` or `swap`. */
  layout: { reason: string };
  /** The active chart's link channels, after any link, group or active chart change. */
  links: ResolvedLinkOptions;
  /** Every chart changed theme, through `setTheme` or one chart's own control. */
  theme: { theme: WidgetThemeName };
  [key: string]: unknown;
}

export type ChartGridEventName = 'active' | 'layout' | 'links' | 'theme';

export type { ChartGridLinkGroup } from './grid-links';

export interface ChartGrid {
  /** The `.oac-grid` element. */
  readonly root: HTMLElement;
  readonly isDestroyed: boolean;
  /** The cells in reading order: by row, then by column. */
  cells(): readonly ChartGridCell[];
  active(): ChartGridCell;
  /** Make a cell the one the keyboard and shared controls act on. False for an unknown id. */
  setActive(id: string, options?: { focus?: boolean }): boolean;
  layout(): ChartGridLayout;
  /**
   * What restoring the persisted workspace did when the grid was built: null
   * when nothing was stored, and until `ready` settles over an asynchronous
   * store. A refused desk stays stored, untouched, until the user changes the grid.
   */
  restored(): ChartGridApplyReport | null;
  /**
   * Settles once the persisted workspace has been read and applied (since
   * 2.5.10): at once without `persist` or over a synchronous store. Over an
   * asynchronous one (IndexedDB, the default) the grid is built from the
   * preset, out of sight and loading nothing, until then; a workspace applied
   * meanwhile wins over the stored one. Never rejects.
   */
  readonly ready: Promise<void>;
  /**
   * Reflow into a layout. The charts that fit keep their state in reading
   * order and new ones copy the active chart's instrument; in an uneven layout
   * the active chart takes the large slot, and stays even when it sat past the
   * charts that fit. Weights reset to the layout's.
   * Throws for an id that is not in `CHART_GRID_LAYOUTS`.
   */
  setPreset(preset: ChartGridLayoutId): void;
  /** Show one chart alone, the active one by default; the others stay alive. False for an unknown id or a single chart. */
  maximize(id?: string): boolean;
  /** Show every chart again after `maximize`. */
  restore(): void;
  /** The maximized chart's id, or null while the grid shows every chart. */
  maximized(): string | null;
  /** Trade the places of two charts, spans included. False for an unknown or repeated id. */
  swap(first: string, second: string): boolean;
  /** The active chart's link channels (the whole desk's until groups are made); every channel off when it links with none. */
  linkOptions(): ResolvedLinkOptions;
  /**
   * Switch channels of the active chart's group, or of every group when it is
   * in none. Switching symbol, interval or chart type linking on adopts the
   * active chart's choice.
   */
  setLinks(patch: LinkOptions): void;
  /** Every link group, in the order they were made, with the charts in each. */
  linkGroups(): readonly ChartGridLinkGroup[];
  /** Move a chart into a group, or out of every group with null. It adopts what the group links on. */
  setLinkGroup(cell: string, group: string | null): boolean;
  /** Start a group with this chart in it; the id, or null for an unknown chart or when sixteen groups exist. */
  addLinkGroup(cell: string, options?: { name?: string; links?: LinkOptions }): string | null;
  /** Switch channels of one group. False for an unknown group. */
  setGroupLinks(group: string, patch: LinkOptions): boolean;
  /** Name a group, 1 to 120 characters after trimming. */
  renameLinkGroup(group: string, name: string): boolean;
  /**
   * Send a chart's drawings to the charts its group shares drawings with, on
   * the same instrument. Drawings made before the switch went on stay private
   * until shared. The number shared, 0 when there is nowhere to share them.
   */
  shareDrawings(cell: string): number;
  theme(): WidgetThemeName;
  setTheme(theme: WidgetThemeName | ChartTheme): void;
  /** Whether the grid is narrow enough to show one chart at a time. */
  compact(): boolean;
  /**
   * One image of every chart at its place on the grid, at the device pixel
   * ratio. Null while the grid shows one chart at a time (compact or
   * maximized), when the hidden charts would come out blank.
   */
  takeScreenshot(): HTMLCanvasElement | null;
  /** Save `takeScreenshot()` as a PNG. False when there is no image or the runtime cannot save it. */
  downloadScreenshot(filename?: string): boolean;
  getWorkspace(): WorkspacePayload;
  /** Replace every chart with a validated payload, or change nothing and say why. */
  applyWorkspace(payload: WorkspacePayload): ChartGridApplyReport;
  on<K extends ChartGridEventName>(event: K, cb: (payload: ChartGridEvents[K]) => void): () => void;
  destroy(): void;
}

interface Cell {
  id: string;
  widget: Widget;
  element: HTMLElement;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  historyPeriod?: string;
  member: LinkChart;
  group: GridGroup<Cell> | null;
  /** The chart type last reported to the group, so a repeated notice is not a change. */
  type: string;
  /** The link group mark in the chart's bar, while groups are in use. */
  mark: HTMLButtonElement | null;
  offs: Array<() => void>;
  /** Bars across the window the chart showed last, 0 while it had no plot. */
  span: number;
  /** Keep that window through the next resize: set when a maximize or restore changes the chart's size. */
  hold: boolean;
}

interface Source { symbol?: string; exchange?: string; interval?: string; variant?: DataVariant; chartType?: string; historyPeriod?: string }
type Axis = 'row' | 'column';

/** Pixels between tracks, and the track a splitter sits in. */
const GUTTER = 4;
/** The smaller of two resized tracks keeps at least this share of the pair. */
const MIN_SHARE = 0.15;
/**
 * A cell narrower or shorter than this, in CSS px, is dense: its rail and the
 * secondary controls of its bar give their room to the chart. A four by four
 * grid on a laptop is about 300 by 180 per cell, and a full top bar there
 * wraps over a third of the chart; maximizing a cell brings everything back.
 */
const DENSE_WIDTH = 560;
const DENSE_HEIGHT = 340;
const STATE_KEY = 'grid';
/** The drawings of each chart, per instrument, beside the workspace. */
const DRAWINGS_KEY = 'grid-drawings';
const THEME_SETTING = 'widget.theme';
// `drawingStore` too: each cell gets a store of its own from the grid.
const GRID_ONLY_KEYS = ['preset', 'links', 'compactWidth', 'persist', 'storage', 'drawingStore', 'toolbar', 'presets'];

const round = (v: number): number => Math.round(v * 1e4) / 1e4;
const ones = (n: number): number[] => Array.from({ length: n }, () => 1);
const tracks = (weights: readonly number[]): string => weights.map(w => `minmax(0,${w}fr)`).join(` ${GUTTER}px `);

/**
 * Build a chart grid inside `container`: an element, or a selector resolved
 * against `options.document` or the page.
 */
export function createChartGrid(container: HTMLElement | string, options: ChartGridOptions = {}): ChartGrid {
  if (typeof container === 'string') {
    const found = (options.document ?? (globalThis as { document?: Document }).document)?.querySelector<HTMLElement>(container);
    if (!found) throw new Error(`openalgo-charts grid: no element matches "${container}"`);
    container = found;
  }
  const doc = options.document ?? container.ownerDocument;
  const text = options;
  const cellOptions = { ...options } as Record<string, unknown>;
  for (const key of GRID_ONLY_KEYS) delete cellOptions[key];
  // A cell in a two-column grid is often narrower than the phone threshold,
  // so cells keep desktop chrome unless the host asks for touch controls.
  // Each chart's capture menu offers the whole grid beside its own picture.
  Object.assign(cellOptions, { document: doc, mobile: options.mobile ?? 'never', captureRows: () => captureRows() });
  // A chart has no bottom bar of its own; the grid's one bar, when it has
  // one, acts on the active chart.
  cellOptions.bottombar = false;
  // Layouts: a chart never saves a layout of its own inside a grid. The
  // `workspaces` store still gives every picker its templates. The desk's
  // Layouts control is the grid bar's; without the bar, a controller the host
  // passes drives the menu of every chart.
  cellOptions.layouts = options.toolbar === true ? false : options.layouts ?? false;
  const store = options.persist ? (options.storage === undefined ? defaultWidgetStore() : options.storage) : null;
  const storage = new WidgetStorage(typeof options.persist === 'string' ? options.persist : 'default', store, {
    // The grid has no status line of its own; the active chart's says it. A
    // read that failed is a toast as well, as in one widget: the charts'
    // first loads take the status line over at once.
    onError: failure => {
      if (destroyed || active === null) return;
      const error = errorText(text, failure.error);
      const context = active.widget.context;
      if (failure.operation !== 'load') {
        context.status(widgetText(text, 'Saved chart settings could not be written: {error}', { error }), 'error');
        return;
      }
      const message = widgetText(text, 'Saved chart settings could not be read, so changes are kept for this session only: {error}', { error });
      context.status(message, 'error');
      context.toast(message, 'error');
    },
  });
  /**
   * An asynchronous store has not answered yet: nothing is written, so the
   * preset cannot be saved over the desk it holds, and the preset's charts
   * are built without an instrument, so none of them asks the feed for one.
   */
  let restoring = !storage.loaded;
  /**
   * A workspace was applied through `applyWorkspace`: one applied while the
   * store was read wins over the stored desk, and one applied before the saved
   * layouts reopen the last layout wins over that.
   */
  let given = false;
  const bus = new WidgetBus<ChartGridEvents>();
  const links = new GridLinks<Cell>(options.links);
  const offs: Array<() => void> = [];
  let cells: Cell[] = [];
  // The user's chords belong to the desk, not to one chart: one record in the
  // grid's storage, applied to every chart and passed on when a chart changes
  // it. Read when the stored desk is, since an asynchronous store has no copy before.
  let chords: unknown = null;
  let sharing = false;
  let active: Cell | null = null;
  const splits: HTMLElement[] = [];
  let rows = 1, cols = 1, rowW = [1], colW = [1];
  let preset: string | null = null;
  let theme: WidgetThemeName | ChartTheme = options.theme ?? 'dark';
  let themeSync = false, compact = false, maxed = false, pointerIn = false, destroyed = false;
  /** True while the grid itself moves a chart's window, which is no user navigation. */
  let syncing = false;
  let nextId = 0;
  let saveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let saveQueued = false;
  /** A stored desk this grid refused to restore, kept until the user changes something. */
  let held = false;
  let restored: ChartGridApplyReport | null = null;
  /** The drawings of the charts on the grid, for the instruments each one is not showing. */
  let drawings: ChartDrawings = new Map();

  const root = h(doc, 'div', 'oac-grid');
  const tabs = h(doc, 'div', 'oac-grid__tabs', { role: 'tablist', 'aria-label': widgetText(text, 'Charts') });
  const body = h(doc, 'div', 'oac-grid__cells');
  tabs.hidden = true;
  // The strip is laid out at the bar's height now, so the charts keep their size when the bar arrives.
  const barEl = options.toolbar === true ? h(doc, 'div', 'oac-widget oac-grid__bar', { role: 'toolbar', 'aria-label': widgetText(text, 'Chart grid') }) : null;
  // The bottom bar's rules are scoped under `.oac-widget`, like every piece of the widget's chrome.
  const footEl = options.bottombar === true ? h(doc, 'div', 'oac-widget oac-grid__foot') : null;
  root.append(...(barEl === null ? [] : [barEl]), tabs, body, ...(footEl === null ? [] : [footEl]));
  /**
   * The grid's own menus hang over every chart, so they live in a layer over
   * the whole grid rather than in any one widget. Made on first use: a grid
   * with no bar and one link group never opens a menu, and its page keeps
   * exactly the elements it had.
   */
  let chromeLayer: { el: HTMLElement; overlays: OverlayStack; tips: TipController } | null = null;
  const chrome = (): { el: HTMLElement; overlays: OverlayStack; tips: TipController } => {
    if (chromeLayer === null) {
      const el = h(doc, 'div', 'oac-widget oac-grid__overlay');
      el.dataset.theme = resolveTheme(theme).name;
      root.appendChild(el);
      const overlays = createOverlayStack(el, doc);
      chromeLayer = { el, overlays, tips: createTipController(el, overlays.layer, doc) };
    }
    return chromeLayer;
  };

  const emit = <K extends ChartGridEventName>(event: K, payload: ChartGridEvents[K]): void => bus.emit(event, payload);
  /** A stream of changes (a pan, a zoom, a drag) settles before it is written. */
  const scheduleSave = (): void => {
    held = false;
    if (!storage.enabled || destroyed) return;
    if (saveTimer !== 0) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };
  /**
   * A discrete change (a preset, a link, an instrument) is written before the
   * task ends. A write left to a timer or to the unload flush can be lost when
   * the page reloads at once: one browser engine was seen to drop storage
   * writes made while the page unloads.
   */
  const saveSoon = (): void => {
    held = false;
    if (!storage.enabled || destroyed || saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => { saveQueued = false; saveNow(); });
  };
  function saveNow(): void {
    if (saveTimer !== 0) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!storage.enabled || destroyed || held || restoring || active === null) return;
    storage.set(STATE_KEY, grid.getWorkspace());
    // Only the charts on the grid: a chart the grid dropped takes its drawings with it.
    const charts: Record<string, Record<string, DrawingsDocument>> = {};
    for (const cell of cells) {
      const mine = drawings.get(cell.id);
      if (mine !== undefined && mine.size > 0) charts[cell.id] = Object.fromEntries(mine);
    }
    storage.set(DRAWINGS_KEY, { version: 1, charts });
  }
  const paintTheme = (): void => {
    const t = resolveTheme(theme);
    root.dataset.theme = t.name;
    for (const el of [chromeLayer?.el, barEl, footEl]) if (el != null) el.dataset.theme = t.name;
    applyTokens(root, widgetTokens(t.theme, t.name));
  };
  /**
   * A chart's context over the grid's own layer: a panel the grid's chrome
   * opens for a chart (the Layouts menu, the go-to panel) hangs over the
   * whole grid, next to the control that opened it, where one small chart
   * would clip it. One opened with no anchor hangs from `anchor`.
   */
  const overGrid = (ctx: WidgetContext, anchor?: () => HTMLElement | null): WidgetContext => Object.create(ctx, {
    root: { value: chrome().el },
    openOverlay: { value: (el: HTMLElement, o: OverlayOptions = {}) => chrome().overlays.open(el, { ...o, anchor: o.anchor ?? anchor?.() ?? undefined }) },
  }) as WidgetContext;

  // ── focus ──────────────────────────────────────────────────────────────
  /**
   * Who answers a key. A cell that is not active never does. The active one
   * takes the key outright when the focus is on the page itself and the
   * pointer is over the grid; a focused splitter, tab or bar control keeps
   * its own keys; anything else is the widget's usual pointer-or-focus decision.
   */
  const route = (cell: Cell): boolean | undefined => {
    if (cell !== active) return false;
    const focus = doc.activeElement;
    if (focus === null || focus === doc.body || focus === doc.documentElement) return pointerIn ? true : undefined;
    return root.contains(focus) && !cells.some(c => c.element.contains(focus)) ? false : undefined;
  };

  /** One chart at a time: below the compact width, or while one is maximized. */
  const solo = (): boolean => compact || maxed;

  const syncCompact = (): void => {
    for (const c of cells) c.element.hidden = solo() && c !== active;
    for (const split of splits) split.hidden = solo();
    tabs.hidden = !solo() || cells.length < 2;
    const said = (c: Cell): string => `${c.widget.symbol()} ${c.widget.interval()}`.trim();
    tabs.replaceChildren(...(tabs.hidden ? [] : cells.map((c, i) => {
      // One tab stop for the row; the arrows walk it (see the listener below).
      const tab = h(doc, 'button', 'oac-grid__tab', { type: 'button', role: 'tab', 'aria-selected': String(c === active), tabindex: c === active ? '0' : '-1' });
      tab.textContent = said(c);
      // Two charts of one symbol and interval are told apart by their place.
      if (cells.some(o => o !== c && said(o) === said(c))) tab.setAttribute('aria-label', `${said(c)} (${i + 1})`);
      tab.addEventListener('click', () => grid.setActive(c.id, { focus: true }));
      return tab;
    })));
    bar?.refresh();
  };

  const markActive = (): void => {
    for (const c of cells) {
      c.element.dataset.active = String(c === active);
      if (c === active) c.element.setAttribute('aria-current', 'true');
      else c.element.removeAttribute('aria-current');
    }
    syncCompact();
  };

  /** Mark each cell dense or not from its size; unmeasured cells keep their mark. */
  const density = (): void => {
    for (const c of cells) {
      const box = c.element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) c.element.dataset.dense = String(box.width < DENSE_WIDTH || box.height < DENSE_HEIGHT);
    }
  };

  const measure = (): void => {
    if (destroyed) return;
    density();
    const width = root.getBoundingClientRect().width;
    const limit = options.compactWidth ?? 640;
    // Zero means not laid out yet (hidden, or not in the document): no verdict.
    const next = limit > 0 && width > 0 && width <= limit;
    root.dataset.compact = String(next);
    if (next === compact) return;
    compact = next;
    syncCompact();
    density();
    emit('layout', { reason: 'compact' });
  };

  // ── maximize ───────────────────────────────────────────────────────────
  const setMaxed = (on: boolean): boolean => {
    if (on === maxed) return false;
    maxed = on;
    // Maximizing is looking closer, not further back: the chart keeps the
    // window it showed as it grows, and again as it shrinks back.
    if (active !== null) active.hold = true;
    root.dataset.maximized = String(on);
    syncCompact();
    // The cell changed size with no change to the grid's, which is all the size observer watches.
    density();
    emit('layout', { reason: 'maximize' });
    return true;
  };
  const maximizeBlocked = (): string | null => {
    if (cells.length < 2) return widgetText(text, 'There is only one chart');
    if (compact) return widgetText(text, 'The grid shows one chart at a time at this width');
    return null;
  };
  const toggleMaximize = (cell: Cell | null = active): void => {
    if (cell === null) return;
    if (maxed && cell === active) grid.restore();
    else grid.maximize(cell.id);
  };

  // ── splitters ──────────────────────────────────────────────────────────
  const valueNow = (split: HTMLElement): void => {
    const w = split.dataset.axis === 'column' ? colW : rowW;
    const b = Number(split.dataset.index);
    split.setAttribute('aria-valuenow', String(Math.round(w[b] / (w[b] + w[b + 1]) * 100)));
  };

  const resize = (axis: Axis, b: number, first: number, dragging = false): void => {
    const w = (axis === 'column' ? colW : rowW).slice();
    const pair = w[b] + w[b + 1];
    const next = round(Math.min(pair * (1 - MIN_SHARE), Math.max(pair * MIN_SHARE, first)));
    if (next === w[b]) return;
    w[b] = next;
    w[b + 1] = round(pair - next);
    if (axis === 'column') { colW = w; body.style.gridTemplateColumns = tracks(w); }
    else { rowW = w; body.style.gridTemplateRows = tracks(w); }
    splits.forEach(valueNow);
    density();
    if (dragging) scheduleSave();
    else saveSoon();
    emit('layout', { reason: 'weights' });
  };

  const splitter = (axis: Axis, b: number, area: string): void => {
    const col = axis === 'column';
    const split = h(doc, 'div', 'oac-grid__split', {
      role: 'separator', tabindex: '0', 'aria-orientation': col ? 'vertical' : 'horizontal',
      'aria-label': widgetText(text, col ? 'Resize columns {first} and {second}' : 'Resize rows {first} and {second}', { first: b + 1, second: b + 2 }),
      'aria-valuemin': '15', 'aria-valuemax': '85',
    });
    split.dataset.axis = axis;
    split.dataset.index = String(b);
    split.style.gridArea = area;
    const weights = (): number[] => (col ? colW : rowW);
    split.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      const w = weights();
      const size = (col ? rect.width : rect.height) - GUTTER * (w.length - 1);
      const total = w.reduce((a, v) => a + v, 0);
      const start = col ? e.clientX : e.clientY;
      const first = w[b];
      split.setPointerCapture?.(e.pointerId);
      split.classList.add('is-drag');
      const move = (m: PointerEvent): void => {
        if (size > 0) resize(axis, b, first + ((col ? m.clientX : m.clientY) - start) / size * total, true);
      };
      const end = (): void => {
        // The drag is over, so its last weights are written now, not after the debounce.
        if (saveTimer !== 0) saveNow();
        split.classList.remove('is-drag');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', end);
        split.removeEventListener('pointercancel', end);
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', end);
      split.addEventListener('pointercancel', end);
    });
    split.addEventListener('keydown', (e: KeyboardEvent) => {
      const dir = (col ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']).indexOf(e.key);
      if (dir < 0) return;
      // Claimed here so neither the charts' keymaps nor the engine pan with it.
      e.preventDefault();
      e.stopPropagation();
      const w = weights();
      resize(axis, b, w[b] + (dir * 2 - 1) * (w[b] + w[b + 1]) * (e.shiftKey ? 0.2 : 0.05));
    });
    split.addEventListener('dblclick', () => { const w = weights(); resize(axis, b, (w[b] + w[b + 1]) / 2); });
    split.hidden = solo();
    body.appendChild(split);
    splits.push(split);
    valueNow(split);
  };

  /** One splitter per run of tracks a boundary separates; a spanning chart interrupts the run. */
  const splitters = (axis: Axis): void => {
    const col = axis === 'column';
    const across = col ? rows : cols;
    for (let b = 0; b < (col ? cols : rows) - 1; b++) {
      let start = -1;
      for (let i = 0; i <= across; i++) {
        const open = i < across && !cells.some(c => {
          const [lo, len, at, span] = col ? [c.column, c.columnSpan, c.row, c.rowSpan] : [c.row, c.rowSpan, c.column, c.columnSpan];
          return lo <= b && lo + len > b + 1 && at <= i && at + span > i;
        });
        if (open && start < 0) start = i;
        if (!open && start >= 0) {
          // Grid lines, with a gutter track between every two chart tracks.
          const [from, to, gap] = [2 * start + 1, 2 * i, 2 * b + 2];
          splitter(axis, b, (col ? [from, gap, to, gap + 1] : [gap, from, gap + 1, to]).join(' / '));
          start = -1;
        }
      }
    }
  };

  // ── link group marks ───────────────────────────────────────────────────
  const groupName = (group: GridGroup<Cell>): string => group.name ?? widgetText(text, 'Group {letter}', { letter: group.letter });
  const describe = (): ChartGridLinkGroup[] => describeGroups(links, cells, groupName);
  const describeOf = (group: GridGroup<Cell> | null): ChartGridLinkGroup | null => describe().find(g => g.id === group?.id) ?? null;

  /**
   * Each chart's name for assistive technology, and its group mark. The marks
   * appear once the desk has more than the one group every chart starts in,
   * so a desk that never uses groups looks as it always has.
   */
  const paintMarks = (): void => {
    const plain = links.trivial(cells);
    cells.forEach((c, i) => {
      const index = i + 1;
      c.element.setAttribute('aria-label', plain ? widgetText(text, 'Chart {index}', { index })
        : c.group === null ? widgetText(text, 'Chart {index}, not linked', { index })
          : widgetText(text, 'Chart {index}, linked in {name}', { index, name: groupName(c.group) }));
      if (plain) { c.mark?.remove(); c.mark = null; return; }
      if (c.mark === null) {
        const mark = c.mark = h(doc, 'button', 'oac-grid__mark', { type: 'button', 'aria-haspopup': 'menu' });
        mark.addEventListener('click', () => { grid.setActive(c.id); barHost.openMenu('link', mark); });
        const head = c.widget.root.querySelector('.oac-topbar');
        if (head !== null) head.prepend(mark);
        else { mark.classList.add('oac-grid__mark--float'); c.element.appendChild(mark); }
      }
      c.mark.replaceChildren(groupMark(doc, describeOf(c.group)));
      const title = c.group === null ? widgetText(text, 'Not linked') : widgetText(text, 'Linked in {name}', { name: groupName(c.group) });
      c.mark.setAttribute('aria-label', title);
      c.mark.title = title;
      if (c.group === null) delete c.mark.dataset.group;
      else c.mark.dataset.group = c.group.letter;
    });
    bar?.refresh();
  };

  /** After any change to groups or membership: marks, the bar, the event and the saved desk. */
  const linksChanged = (): void => {
    links.prune(cells);
    paintMarks();
    saveSoon();
    emit('links', grid.linkOptions());
  };

  const render = (): void => {
    body.style.gridTemplateColumns = tracks(colW);
    body.style.gridTemplateRows = tracks(rowW);
    for (const split of splits.splice(0)) split.remove();
    // The page order is what Tab and a screen reader follow, and what each
    // cell's `Chart {index}` name counts, so it follows the places a swap or
    // an uneven layout gives. Moving a node takes the focus off it; it goes back.
    const focused = doc.activeElement as HTMLElement | null;
    cells.forEach((c, i) => {
      c.element.style.gridArea = `${2 * c.row + 1} / ${2 * c.column + 1} / ${2 * (c.row + c.rowSpan)} / ${2 * (c.column + c.columnSpan)}`;
      const at = body.children[i] ?? null;
      if (at !== c.element) body.insertBefore(c.element, at);
    });
    if (focused !== null && focused !== doc.activeElement && cells.some(c => c.element.contains(focused))) focused.focus({ preventScroll: true });
    splitters('column');
    splitters('row');
    root.dataset.single = String(cells.length === 1);
    paintMarks();
    markActive();
    density();
  };

  // ── cells ──────────────────────────────────────────────────────────────
  const makeCell = (id: string, source: Source, parent: HTMLElement, cellTheme: WidgetThemeName | ChartTheme, docs: ChartDrawings): Cell => {
    const element = h(doc, 'div', 'oac-grid__cell', { role: 'group' });
    element.dataset.paneId = id;
    parent.appendChild(element);
    const { historyPeriod } = source, feed = options.feed;
    const cell = { id, element, row: 0, column: 0, rowSpan: 1, columnSpan: 1, offs: [], span: 0, hold: false, historyPeriod, group: null, mark: null, type: '' } as unknown as Cell;
    const chartOptions: WidgetOptions = {
      ...cellOptions, theme: cellTheme, symbol: restoring ? undefined : source.symbol, exchange: source.exchange, interval: source.interval,
      variant: source.variant, chartType: source.chartType, keyboardRoute: () => route(cell),
      feed: typeof feed === 'function' ? feed({ id, historyPeriod }) : feed, drawingStore: cellDrawingStore(id, docs),
    };
    // The bar under the grid carries this chart's Go to, which opens over the grid from that bar.
    if (footEl !== null) GRID_BAR_CHARTS.set(chartOptions, ctx => overGrid(ctx, () => footEl.querySelector<HTMLElement>('.oac-bottombar__goto')));
    try {
      cell.widget = createWidget(element, chartOptions);
    } catch (error) {
      element.remove();
      throw error;
    }
    cell.type = cell.widget.chartType();
    // Read live, like the cell's place: a host holding a cell sees it move between groups.
    Object.defineProperty(cell, 'linkGroup', { enumerable: true, get: () => cell.group?.id ?? null });
    return cell;
  };

  /** A chart with no plot shows an empty window, and has none to give. */
  const span = (cell: Cell): number => {
    const range = cell.widget.chart.getVisibleLogicalRange();
    return range.to - range.from;
  };
  /** The linked window of the chart's group becomes the one this chart shows. */
  const keep = (cell: Cell): void => {
    const group = cell.group;
    if (group === null) return;
    const chart = cell.widget.chart, range = chart.getVisibleLogicalRange(), data = chart.dataLayer;
    const from = data.indexToTimeFloat(range.from), to = data.indexToTimeFloat(range.to);
    if (to > from) { group.view = { from, to }; group.keeper = cell; }
  };
  const forget = (group: GridGroup<Cell> | null): void => {
    if (group !== null) { group.view = null; group.keeper = null; }
  };

  /**
   * After a resize a linked chart shows the window it showed before. The
   * engine keeps its right edge, so a chart following new bars goes on
   * following them; putting its span back, rather than its bar width, keeps
   * charts of different widths on the same window. A chart that had no plot
   * (hidden behind the compact tabs or a maximized chart) had no window, and
   * takes its group's linked one. Before any linked navigation there is no
   * shared window, and a resize is left to the engine.
   */
  const fit = (cell: Cell): void => {
    const chart = cell.widget.chart, range = chart.getVisibleLogicalRange(), data = chart.dataLayer, had = cell.span;
    const group = cell.group;
    const linked = group !== null && group.links.options().viewport ? group.view : null;
    const hold = cell.hold && had > 0;
    cell.hold = false;
    if (hold || (linked !== null && (had > 0 || cell !== group?.keeper))) {
      syncing = true;
      try {
        chart.setVisibleLogicalRange(had > 0 || linked === null ? { from: range.to - had, to: range.to }
          : { from: data.timeToIndexFloat(linked.from), to: data.timeToIndexFloat(linked.to) });
      } finally { syncing = false; }
    }
    cell.span = span(cell);
    if (cell === group?.keeper || (linked !== null && had === 0)) keep(cell);
  };

  /** Wire a built cell into the save, tab and link bookkeeping. Its group is joined separately. */
  const join = (cell: Cell): void => {
    const { widget } = cell;
    const chart = widget.chart;
    if (options.shortcutsEditor !== false) {
      const km = widget.context.keymap;
      km.applyOverrides(chords);
      cell.offs.push(km.onChange(() => {
        if (sharing) return;
        sharing = true;
        try {
          const next = km.overrides();
          chords = next;
          for (const other of cells) if (other !== cell) other.widget.context.keymap.applyOverrides(next);
          if (Object.keys(next).length === 0) storage.remove(KEYMAP_KEY); else storage.set(KEYMAP_KEY, next);
        } finally { sharing = false; }
      }));
    }
    let settling = false, following = false;
    // A window set by fresh bars, by the grid or by the link group following
    // another chart is not the user's navigation: the chart that was navigated
    // keeps the linked window, whichever of the two hears the pan first.
    const own = (): boolean => settling || syncing || following;
    cell.offs.push(chart.on('data:update', () => {
      settling = true;
      queueMicrotask(() => { settling = false; });
      cell.span = span(cell);
      if (cell === cell.group?.keeper) keep(cell);
    }));
    cell.member = {
      // The link group asks only for names the chart's map declares, so the
      // forward stays on the typed overload rather than the string form 3.0.0 drops.
      on: (event, cb) => chart.on(event as keyof ChartEventMap, event === 'pan' || event === 'zoom'
        ? payload => { if (!own()) cb(payload); }
        : event === 'symbol'
          ? payload => { const p = payload as { symbol: string; exchange: string }; cb({ symbol: instrument(p.symbol, p.exchange) }); }
          : cb),
      getVisibleLogicalRange: () => chart.getVisibleLogicalRange(),
      setVisibleLogicalRange: range => {
        following = true;
        try { chart.setVisibleLogicalRange(range); } finally { following = false; }
      },
      get dataLayer() { return chart.dataLayer; },
      get isDestroyed() { return chart.isDestroyed; },
      panes: () => chart.panes(),
      addPrimitive: (primitive, pane) => chart.addPrimitive(primitive, pane),
      removePrimitive: primitive => chart.removePrimitive(primitive),
      setLinkedCrosshairIndex: index => chart.setLinkedCrosshairIndex(index),
    };
    // A new instrument fits its own view, so the keeper's window is no longer
    // the linked one; the other charts still show it.
    const changed = (): void => { if (cell === cell.group?.keeper) forget(cell.group); syncCompact(); saveSoon(); };
    const moved = (): void => {
      const mine = !own();
      cell.span = span(cell);
      // A navigation sets the linked window; the keeper's other moves carry it along.
      if (mine || cell === cell.group?.keeper) keep(cell);
      // A window set by data is still written, but a desk held after a refused restore stays held.
      if (mine || !held) scheduleSave();
    };
    // The widget reports a chart type change as a layout change, from its
    // own menu, an undo or a restore alike; the group hears it once.
    const typed = (): void => {
      const next = widget.chartType();
      if (next === cell.type) return;
      cell.type = next;
      cell.group?.links.setChartType(cell.member, next);
    };
    cell.offs.push(
      widget.on('interval', ({ interval }) => cell.group?.links.setInterval(cell.member, interval)),
      widget.on('theme', ({ chartTheme }) => { if (!themeSync) grid.setTheme(chartTheme); }),
      widget.on('symbol', changed),
      widget.on('interval', changed),
      widget.on('variant', changed),
      widget.on('layout', typed),
      widget.on('layout', scheduleSave),
      chart.on('pan', moved),
      chart.on('zoom', moved),
      chart.on('resize', () => fit(cell)),
      ...installGridKeys({
        keymap: widget.context.keymap, text, maximized: () => maxed,
        toggleMaximize: () => {
          if (!maxed && maximizeBlocked() !== null) return false;
          toggleMaximize(cell);
          return true;
        },
        restore: () => setMaxed(false),
        focus: dir => {
          const next = neighbour(cells, cell, dir);
          if (next === undefined) return false;
          // After this key is done: every chart's keymap hears it on the
          // document, and the chart made active now would take it as its own.
          queueMicrotask(() => { if (!destroyed) grid.setActive(next.id, { focus: true }); });
          return true;
        },
        swap: dir => {
          const next = neighbour(cells, cell, dir);
          if (next === undefined || solo()) return false;
          grid.swap(cell.id, next.id);
          return true;
        },
      }),
    );
    for (const event of ['draw:add', 'draw:remove', 'alert:created', 'alert:removed'] as const) cell.offs.push(chart.on(event, saveSoon));
    // These arrive once per frame while something is dragged.
    for (const event of ['draw:update', 'alert:updated', 'objects:change'] as const) cell.offs.push(chart.on(event, scheduleSave));
  };

  const drop = (cell: Cell): void => {
    if (cell === cell.group?.keeper) forget(cell.group);
    for (const off of cell.offs.splice(0)) off();
    if (cell.member !== undefined) links.leave(cell);
    cell.widget.destroy();
    cell.element.remove();
  };

  const activateFrom = (target: EventTarget | null): void => {
    const cell = cells.find(c => c.element.contains(target as Node | null));
    if (cell !== undefined) grid.setActive(cell.id);
  };

  /** The member the group follows when a switch goes on: the active chart when it is in the group, else its first chart. */
  const leaderOf = (group: GridGroup<Cell>): Cell | undefined => (active?.group === group ? active : cells.find(c => c.group === group));
  /** Record the leader's instrument, interval and type, so a channel switched on converges on them. */
  const lead = (group: GridGroup<Cell>, patch: LinkOptions): void => {
    const leader = leaderOf(group);
    if (leader === undefined) return;
    if (patch.symbol) group.links.setSymbol(leader.member, instrument(leader.widget.symbol(), leader.widget.exchange()));
    if (patch.interval) group.links.setInterval(leader.member, leader.widget.interval());
    if (patch.chartType) group.links.setChartType(leader.member, leader.widget.chartType());
  };
  const patchGroup = (group: GridGroup<Cell>, patch: LinkOptions): void => {
    // A window from before viewport linking came on says nothing about the charts now.
    if (patch.viewport && !group.links.options().viewport) forget(group);
    // Recorded before the switch flips, so the group converges on its leader.
    lead(group, patch);
    group.links.setOptions(patch);
  };

  // ── capture ────────────────────────────────────────────────────────────
  /** Why the whole grid cannot be captured now: at a compact width no chart but one can show, so the reason says so. */
  const captureBlocked = (): string | null => (cells.length < 2 || !solo() ? null
    : widgetText(text, compact ? 'The grid shows one chart at a time at this width' : 'Show every chart to capture them together'));
  const report = (message: string, kind: 'info' | 'error' = 'info'): void => { active?.widget.context.toast(message, kind); };
  const captureFile = (): string => captureName('charts', preset ?? `${rows}x${cols}`) + '.png';
  const downloadAll = (): void => {
    if (grid.downloadScreenshot()) report(widgetText(text, 'Saved a PNG of every chart'));
    else report(widgetText(text, 'The image could not be saved: {error}', { error: captureBlocked() ?? widgetText(text, 'This runtime cannot save files') }), 'error');
  };
  const canCopy = (): boolean => {
    const g = globalThis as { navigator?: { clipboard?: { write?: unknown } }; ClipboardItem?: unknown };
    return g.navigator?.clipboard?.write !== undefined && g.ClipboardItem !== undefined;
  };
  const copyAll = (): void => {
    const canvas = grid.takeScreenshot();
    if (canvas === null) return;
    const fail = (error: unknown): void => report(widgetText(text, 'Copy failed: {error}', { error: errorText(text, error) }), 'error');
    try {
      canvas.toBlob(blob => {
        if (blob === null) { report(widgetText(text, 'The canvas produced no image'), 'error'); return; }
        const Item = (globalThis as unknown as { ClipboardItem: new (parts: Record<string, Blob>) => unknown }).ClipboardItem;
        (globalThis.navigator.clipboard as unknown as { write(items: unknown[]): Promise<void> })
          .write([new Item({ 'image/png': blob })]).then(() => report(widgetText(text, 'Every chart copied')), fail);
      }, 'image/png');
    } catch (error) { fail(error); }
  };
  /** The rows each chart's own capture menu adds for the whole grid. */
  function captureRows(): Array<MenuRow | string> {
    if (cells.length < 2) return [];
    const blocked = captureBlocked();
    return [widgetText(text, 'Every chart'),
      { label: widgetText(text, 'Download PNG of every chart'), sub: blocked ?? undefined, disabled: blocked !== null, onSelect: downloadAll },
      { label: widgetText(text, 'Copy image of every chart'), sub: blocked ?? undefined, disabled: blocked !== null || !canCopy(), onSelect: copyAll }];
  }

  // ── the bar ────────────────────────────────────────────────────────────
  /** A menu on its way: of the bar's menus pressed meanwhile, the last one opens, once, as one press after another would leave it. */
  const menuSlot: PartSlot = { waiting: null };
  const barHost: GridBarHost = {
    doc, text,
    get overlays() { return chrome().overlays; },
    get tips() { return chrome().tips; },
    layouts: (options.presets ?? (Object.keys(CHART_GRID_LAYOUTS) as ChartGridLayoutId[])).filter(isChartGridLayout),
    layout: () => preset,
    setLayout: id => grid.setPreset(id),
    maximized: () => maxed,
    maximizeBlocked,
    toggleMaximize: () => toggleMaximize(),
    links: {
      groups: describe,
      current: () => describeOf(active?.group ?? null),
      setGroup: id => { if (active !== null) grid.setLinkGroup(active.id, id); },
      newGroup: () => { if (active !== null) grid.addLinkGroup(active.id); },
      rename: (id, name) => grid.renameLinkGroup(id, name),
      setChannel: (channel: LinkChannel | 'nearest', on) => {
        const group = active?.group;
        if (group == null) return;
        grid.setGroupLinks(group.id, channel === 'nearest' ? { whenMissing: on ? 'nearest' : 'hide' } : { [channel]: on });
      },
      share: () => {
        const count = active === null ? 0 : grid.shareDrawings(active.id);
        report(count > 0 ? widgetText(text, count === 1 ? 'Shared {count} drawing' : 'Shared {count} drawings', { count }) : widgetText(text, 'No drawing here can be shared'));
        return count;
      },
    },
    capture: { blocked: captureBlocked, download: downloadAll, copy: copyAll, canCopy },
    get saved() { return saved ?? undefined; },
    openMenu: (which, anchor) => usePart(gridMenusPart, module => {
      if (which === 'layouts') module.openLayoutPicker(barHost, anchor);
      else if (which === 'link') module.openLinkMenu(barHost, anchor);
      else module.openCaptureMenu(barHost, anchor);
    }, error => report(partFailed(text, widgetText(text, which === 'layouts' ? 'Arrange charts' : which === 'link' ? 'Linking' : 'Capture every chart'), error), 'error'),
    () => !destroyed && anchor.isConnected, { slot: menuSlot, doc, from: anchor }),
  };
  let bar: GridBarHandle | null = null;
  let foot: BottombarHandle | null = null;
  let saved: GridSaved | null = null;
  let ready: Promise<void> = Promise.resolve();

  const grid: ChartGrid = {
    root,
    get ready() { return ready; },
    get isDestroyed() { return destroyed; },
    restored: () => restored,
    cells: () => cells.slice() as unknown as ChartGridCell[],
    active: () => active as unknown as ChartGridCell,
    theme: () => resolveTheme(theme).name,
    compact: () => compact,
    maximized: () => (maxed && active !== null ? active.id : null),
    linkOptions: () => links.optionsOf(active),
    linkGroups: describe,
    layout: () => ({ rows, columns: cols, preset, rowWeights: rowW.slice(), columnWeights: colW.slice() }),
    on: (event, cb) => bus.on(event, cb),

    setActive(id, opts = {}) {
      const cell = cells.find(c => c.id === id);
      if (cell === undefined || destroyed) return false;
      const changed = cell !== active;
      const before = active?.group ?? null;
      active = cell;
      markActive();
      if (opts.focus) cell.widget.root.querySelector<HTMLElement>('.oac-chart')?.focus({ preventScroll: true });
      if (changed) {
        // Focus is no edit, so it never ends the hold on a refused desk.
        if (!held) saveSoon();
        emit('active', { id });
        if (before !== cell.group) emit('links', grid.linkOptions());
      }
      return true;
    },

    setPreset(next) {
      if (!isChartGridLayout(next)) throw new Error(`openalgo-charts grid: "${String(next)}" is not a preset or layout`);
      if (destroyed) return;
      const spec = CHART_GRID_LAYOUTS[next];
      const count = spec.slots.length;
      const kept = cells.slice(0, count);
      const focus = focusSlot(spec);
      // The large slot is the active chart's, so it stays even when it sits
      // past the charts that fit; the last of those makes room for it.
      if (focus >= 0 && active !== null && !kept.includes(active)) kept.splice(count - 1, 1, active);
      const before = active;
      // Read now: dropping a chart takes it out of its group.
      const group = before === null ? links.groups[0] ?? links.create() : before.group;
      const from = active?.widget;
      const source: Source = from === undefined ? options
        : { symbol: from.symbol(), exchange: from.exchange(), interval: from.interval(), variant: from.variant(), chartType: from.chartType(), historyPeriod: active?.historyPeriod };
      const made: Cell[] = [];
      try {
        while (kept.length + made.length < count) {
          let id: string;
          do id = `p${nextId++}`; while (cells.some(cell => cell.id === id));
          made.push(makeCell(id, source, body, theme, drawings));
        }
      } catch (error) {
        made.forEach(drop);
        throw error;
      }
      maxed = false;
      root.dataset.maximized = 'false';
      for (const cell of cells.filter(c => !kept.includes(c))) { drop(cell); drawings.delete(cell.id); }
      if (active === null || !kept.includes(active)) active = kept[0] ?? made[0];
      // In an uneven layout the chart being worked on takes the large slot;
      // the others keep their reading order around it.
      const order = [...kept, ...made];
      if (focus >= 0) { order.splice(order.indexOf(active), 1); order.splice(focus, 0, active); }
      order.forEach((cell, i) => Object.assign(cell, spec.slots[i]));
      cells = order;
      made.forEach(join);
      // A new chart copies the active chart's instrument and joins its group.
      if (group !== null) for (const cell of made) links.join(cell, group);
      links.prune(cells);
      rows = spec.rows; cols = spec.columns; rowW = spec.rowWeights.slice(); colW = spec.columnWeights.slice(); preset = next;
      render();
      saveSoon();
      emit('layout', { reason: 'preset' });
      if (active !== before) emit('active', { id: active.id });
    },

    maximize(id) {
      const cell = id === undefined ? active : cells.find(c => c.id === id);
      if (destroyed || cell == null || cells.length < 2) return false;
      grid.setActive(cell.id);
      setMaxed(true);
      return true;
    },

    restore() {
      if (!destroyed) setMaxed(false);
    },

    swap(first, second) {
      const a = cells.find(c => c.id === first), b = cells.find(c => c.id === second);
      if (destroyed || a === undefined || b === undefined || a === b) return false;
      const place = (c: Cell): Pick<Cell, 'row' | 'column' | 'rowSpan' | 'columnSpan'> => ({ row: c.row, column: c.column, rowSpan: c.rowSpan, columnSpan: c.columnSpan });
      const [pa, pb] = [place(a), place(b)];
      Object.assign(a, pb);
      Object.assign(b, pa);
      cells.sort((x, y) => x.row - y.row || x.column - y.column);
      render();
      saveSoon();
      emit('layout', { reason: 'swap' });
      return true;
    },

    setLinks(patch) {
      const groups = active?.group != null ? [active.group] : links.groups;
      for (const group of groups) patchGroup(group, patch);
      saveSoon();
      paintMarks();
      emit('links', grid.linkOptions());
    },

    setLinkGroup(cellId, groupId) {
      const cell = cells.find(c => c.id === cellId);
      const group = groupId === null ? null : links.find(groupId);
      if (destroyed || cell === undefined || group === undefined) return false;
      if (group === null) links.leave(cell);
      else links.join(cell, group);
      linksChanged();
      return true;
    },

    addLinkGroup(cellId, opts = {}) {
      const cell = cells.find(c => c.id === cellId);
      if (destroyed || cell === undefined) return null;
      const name = opts.name?.trim();
      const group = links.create({ name: name === undefined || name === '' ? null : name.slice(0, 120), links: opts.links });
      if (group === null) return null;
      links.join(cell, group);
      linksChanged();
      return group.id;
    },

    setGroupLinks(groupId, patch) {
      const group = links.find(groupId);
      if (destroyed || group === undefined) return false;
      patchGroup(group, patch);
      saveSoon();
      paintMarks();
      emit('links', grid.linkOptions());
      return true;
    },

    renameLinkGroup(groupId, name) {
      const group = links.find(groupId);
      const clean = name.trim();
      if (destroyed || group === undefined || clean === '' || clean.length > 120) return false;
      group.name = clean;
      linksChanged();
      return true;
    },

    shareDrawings(cellId) {
      const cell = cells.find(c => c.id === cellId);
      const group = cell?.group;
      if (destroyed || cell === undefined || group == null || !group.links.options().drawings) return 0;
      return group.drawings.share(cell.widget.chart);
    },

    setTheme(next) {
      theme = next;
      paintTheme();
      themeSync = true;
      try { for (const c of cells) c.widget.setTheme(next); }
      finally { themeSync = false; }
      saveSoon();
      emit('theme', { theme: resolveTheme(next).name });
    },

    takeScreenshot() {
      if (destroyed || captureBlocked() !== null) return null;
      const base = body.getBoundingClientRect();
      const box = (el: Element | null): CaptureBox => {
        const r = el?.getBoundingClientRect();
        return r === undefined ? { left: 0, top: 0, width: 0, height: 0 } : { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
      };
      const pieces: GridCapturePiece[] = cells.map(c => ({
        cell: box(c.element), chart: box(c.widget.root.querySelector('.oac-chart')), image: c.widget.chart.takeScreenshot(),
        label: `${c.widget.symbol()} ${c.widget.interval()}`.trim(),
      }));
      const fallback = (options as { pixelRatio?: () => number }).pixelRatio?.() ?? (doc.defaultView?.devicePixelRatio ?? 1);
      const tokens = widgetTokens(resolveTheme(theme).theme, resolveTheme(theme).name);
      const token = (name: string): string => tokens[TOKEN_PREFIX + name];
      return composeGridCapture(doc, { width: base.width, height: base.height }, captureRatio(pieces, fallback), pieces,
        { gutter: token('bd-soft'), panel: token('panel'), text: token('tx'), font: WIDGET_FONT });
    },

    downloadScreenshot(filename) {
      const canvas = grid.takeScreenshot();
      if (canvas === null) return false;
      try {
        // A canvas tainted by a cross-origin image refuses here; the caller hears it.
        const url = canvas.toDataURL('image/png');
        const a = doc.createElement('a');
        a.href = url;
        a.download = filename ?? captureFile();
        (doc.body ?? doc.documentElement).appendChild(a);
        a.click();
        a.remove();
        return true;
      } catch {
        return false;
      }
    },

    getWorkspace() {
      const plain = links.trivial(cells);
      const payload: WorkspacePayload = {
        layout: {
          rows, columns: cols,
          slots: cells.map(c => ({ paneId: c.id, row: c.row, column: c.column, rowSpan: c.rowSpan, columnSpan: c.columnSpan })),
          ...(preset === null ? {} : { preset }), rowWeights: rowW.slice(), columnWeights: colW.slice(),
        },
        panes: cells.map((c): WorkspacePane => {
          const s = c.widget.getState();
          // The widget draws no separate volume series and no comparisons, so
          // it saves neither rather than claim a preference it cannot show.
          return { id: c.id, symbol: s.symbol, exchange: s.exchange, interval: s.interval, ...(s.variant ? { variant: s.variant } : {}), chartType: s.chartType,
            chart: s.chart as WorkspaceChartState, settings: { [THEME_SETTING]: s.theme }, volume: false,
            magnet: s.rail?.magnet ?? 'off', stay: s.rail?.stay ?? false, comparisons: [], comparisonMode: 'percent', historyPeriod: c.historyPeriod,
            ...(plain || c.group === null ? {} : { linkGroup: c.group.id }) };
        }),
        activePaneId: (active as Cell).id,
        sync: links.sync(cells, groupName),
      };
      // Chart states carry absent optional fields; the portable form is plain JSON.
      return JSON.parse(JSON.stringify(payload)) as WorkspacePayload;
    },

    applyWorkspace(payload) {
      const report = apply(payload, new Map());
      // The newer desk: neither the stored one nor the last saved layout replaces it.
      if (report.applied) given = true;
      return report;
    },

    destroy() {
      if (destroyed) return;
      saveNow();
      // Sends an asynchronous store's writes, and stops following other tabs' changes to it.
      void storage.flush();
      storage.close();
      destroyed = true;
      for (const off of offs.splice(0)) off();
      saved?.destroy();
      // Before the overlays: the bar closes its zone menu there.
      foot?.destroy();
      chromeLayer?.overlays.destroy();
      chromeLayer?.tips.destroy();
      bar?.destroy();
      cells.splice(0).forEach(drop);
      links.destroy();
      root.remove();
      bus.clear();
    },
  };

  /**
   * Apply a workspace whose charts start from `docs` for the instruments
   * they are not showing: the saved ones when the grid restores its own
   * desk, none for a desk the host hands over, whose payload carries only
   * the drawings each chart shows.
   */
  function apply(payload: WorkspacePayload, docs: ChartDrawings): ChartGridApplyReport {
    if (destroyed) return { applied: false, reason: 'the grid is destroyed' };
    const reason = checkWorkspace(payload);
    if (reason !== '') return { applied: false, reason };
    const saved = payload.panes.find(p => p.id === payload.activePaneId)?.settings?.[THEME_SETTING];
    const nextTheme = saved === 'dark' || saved === 'light' ? saved : theme;
    const staging = doc.createElement('div');
    const made: Cell[] = [];
    try {
      for (const slot of payload.layout.slots.slice().sort((a, b) => a.row - b.row || a.column - b.column)) {
        const pane = payload.panes.find(p => p.id === slot.paneId) as WorkspacePane;
        const cell = makeCell(pane.id, pane, staging, nextTheme, docs);
        made.push(cell);
        Object.assign(cell, { row: slot.row, column: slot.column, rowSpan: slot.rowSpan ?? 1, columnSpan: slot.columnSpan ?? 1 });
        const rail = cell.widget.getState().rail;
        const report = cell.widget.restoreState({ version: 1, symbol: pane.symbol, exchange: pane.exchange, interval: pane.interval,
          ...(pane.variant ? { variant: pane.variant } : {}), chartType: pane.chartType, chart: pane.chart, ...(rail === null ? {} : { rail: { ...rail, magnet: pane.magnet, stay: pane.stay } }) });
        if (!report.applied) throw new Error(`${pane.id}: ${report.reason ?? 'the chart state could not be restored'}`);
        cell.type = cell.widget.chartType();
      }
    } catch (error) {
      made.reverse().forEach(drop);
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    }
    maxed = false;
    root.dataset.maximized = 'false';
    cells.forEach(drop);
    links.destroy();
    cells = made;
    drawings = docs;
    const { layout, sync } = payload;
    rows = layout.rows; cols = layout.columns;
    rowW = layout.rowWeights?.slice() ?? ones(rows);
    colW = layout.columnWeights?.slice() ?? ones(cols);
    preset = layout.preset ?? null;
    theme = nextTheme;
    paintTheme();
    active = made.find(c => c.id === payload.activePaneId) as Cell;
    made.forEach(join);
    // Every channel off while the charts join, so joining cannot overwrite a
    // saved chart; the checks above make the final switch-on agree already.
    const groups = sync.groups === undefined ? [{ id: undefined, name: null, channels: channelsOf(sync), panes: payload.panes }]
      : sync.groups.map(g => ({ id: g.id, name: g.name, channels: channelsOf(g), panes: payload.panes.filter(p => p.linkGroup === g.id) }));
    for (const entry of groups) {
      const group = links.create({ id: entry.id, name: entry.name, links: ALL_OFF }) as GridGroup<Cell>;
      // A group is saved under the name it shows, because the schema needs one.
      // Read back as that same name it would count as named: a desk back to
      // one group would keep its marks and keep writing groups. It stays
      // unnamed, and shows the name in whatever language opens it.
      if (group.name === widgetText(text, 'Group {letter}', { letter: group.letter })) group.name = null;
      for (const pane of entry.panes) links.join(made.find(c => c.id === pane.id) as Cell, group);
      // Record the leader's choices first, then switch on: the group converges on what it just heard.
      lead(group, { symbol: true, interval: true, chartType: true });
      group.links.setOptions(entry.channels);
    }
    links.prune(cells);
    render();
    saveSoon();
    emit('layout', { reason: 'workspace' });
    emit('active', { id: active.id });
    emit('links', grid.linkOptions());
    return { applied: true };
  }

  paintTheme();
  container.appendChild(root);
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void => {
    target.addEventListener(type, fn, capture);
    offs.push(() => target.removeEventListener(type, fn, capture));
  };
  // The tabs follow the arrows, Home and End, each one showing its chart as the focus lands.
  listen(tabs, 'keydown', e => {
    const key = (e as KeyboardEvent).key;
    const list = Array.from(tabs.children);
    const at = list.indexOf(doc.activeElement as Element);
    const to = at < 0 ? -1 : key === 'ArrowRight' ? (at + 1) % list.length : key === 'ArrowLeft' ? (at - 1 + list.length) % list.length
      : key === 'Home' ? 0 : key === 'End' ? list.length - 1 : -1;
    if (to < 0 || cells[to] === undefined) return;
    // Claimed here, as a splitter claims its arrows, so no chart pans with it.
    e.preventDefault();
    e.stopPropagation();
    grid.setActive(cells[to].id);
    (tabs.children[to] as HTMLElement | undefined)?.focus();
  });
  // Capture, so a chart that stops its own pointer events still activates.
  listen(root, 'pointerdown', e => activateFrom(e.target), true);
  listen(root, 'focusin', e => activateFrom(e.target));
  listen(root, 'pointerenter', () => { pointerIn = true; });
  listen(root, 'pointerleave', () => { pointerIn = false; });
  offs.push(installHeaderDrag({
    doc, body, root,
    cells: () => cells,
    enabled: () => !solo() && cells.length > 1,
    swap: (a, b) => grid.swap(a.id, b.id),
    toggleMaximize: cell => { if (cells.length > 1 && !compact) { grid.setActive(cell.id); toggleMaximize(cell); } },
  }));
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const Observer = win?.ResizeObserver;
  if (Observer !== undefined) {
    const observer = new Observer(measure);
    observer.observe(root);
    offs.push(() => observer.disconnect());
  }
  /**
   * A debounced save still pending when the tab closes is the user's last
   * change, and so is a layout's inside autosave's quiet period; an
   * asynchronous store journals what may not land in time. Hiding writes
   * only a save still pending, as in one widget: a tab left for another on
   * the same desk would otherwise write its older desk over the one saved
   * there, at every switch.
   */
  const leaving = (hiding: boolean): void => {
    if (!hiding || saveTimer !== 0) saveNow();
    void storage.flush();
    saved?.flush();
  };
  if (win != null && typeof win.addEventListener === 'function') {
    if (Observer === undefined) listen(win, 'resize', measure);
    listen(win, 'pagehide', () => leaving(false));
  }
  // Hiding is the last moment a page is sure to see; unload may never come.
  listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') leaving(true); });

  /** The desk's chords on every chart built before the store answered. */
  const shareChords = (): void => {
    if (options.shortcutsEditor === false) return;
    sharing = true;
    try { for (const cell of cells) cell.widget.context.keymap.applyOverrides(chords); } finally { sharing = false; }
  };
  /** The stored desk, or the preset when none can be applied. `late`: the preset was built while the store was read. */
  const restore = (late: boolean): void => {
    chords = storage.get(KEYMAP_KEY);
    // Written now, since nothing was while the store was read; the stored desk is older.
    if (given) { shareChords(); saveSoon(); return; }
    const stored = storage.get(STATE_KEY);
    restored = stored === null ? null : apply(stored as WorkspacePayload, readChartDrawings(storage.get(DRAWINGS_KEY)));
    if (restored?.applied === true) return;
    if (!late) grid.setPreset(options.preset ?? '1x1');
    else {
      shareChords();
      // Built with no instrument, so none asked the feed for one; they load it
      // now. Before `held` is set: a symbol change clears it.
      if (options.symbol !== undefined) for (const cell of cells) cell.widget.setSymbol(options.symbol, options.exchange);
    }
    if (restored !== null) {
      // The stored desk may only be waiting for a study or chart type the page
      // registers later, so it is kept, not overwritten by this fallback.
      held = true;
      grid.active().widget.context.toast(widgetText(text, 'The saved layout could not be restored: {error}', { error: restored.reason ?? '' }), 'error');
    }
  };
  if (!restoring) restore(false);
  else {
    grid.setPreset(options.preset ?? '1x1');
    root.style.visibility = 'hidden';
    ready = storage.load().then(() => {
      if (destroyed) return;
      restoring = false;
      // `ready` never rejects: a desk that cannot be applied is reported, as the widget reports its own.
      try { restore(true); } catch (error) {
        grid.active().widget.context.toast(widgetText(text, 'The saved layout could not be restored: {error}', { error: errorText(text, error) }), 'error');
      } finally { root.style.visibility = ''; }
    });
  }

  // ── chrome, over the charts the grid opened with ─────────────────────
  if (footEl !== null) {
    const { tips, overlays } = chrome();
    const strip = footEl.appendChild(h(doc, 'div'));
    foot = mountBottombar({
      document: doc, locale: options.locale, translate: options.translate, tips, openOverlay: overlays.open,
      status: (message, kind) => active?.widget.context.status(message, kind),
    }, strip, { target: () => active?.widget ?? null, ranges: options.ranges, now: options.now, onGoTo: () => active?.widget.openDateNavigation() });
    offs.push(bus.on('active', () => foot?.refresh()));
  }
  // The desk's saved layouts come with the bar that shows them, and load with it.
  if (barEl !== null) {
    usePart(gridBarPart, module => {
      saved = module.attachGridSaved({
        grid, ready, workspaces: options.workspaces, layouts: options.layouts,
        context: () => overGrid((active as Cell).widget.context), opened: () => given,
      });
      bar = module.mountGridBar(barHost, barEl);
    }, error => report(partFailed(text, widgetText(text, 'Chart grid'), error), 'error'), () => !destroyed);
  }
  measure();
  return grid;
}
