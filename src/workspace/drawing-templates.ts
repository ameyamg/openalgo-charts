/**
 * Drawing style templates: the look of a drawing tool saved by name, and the
 * look a tool starts with ("save as default"), kept per namespace in one
 * revision-checked catalog.
 *
 * A template stores settings by the dot paths of the tool's settings schema
 * (`style.color`, `text.fontSize`, `props.showPrices`), the same keys the
 * drawing tier reads and writes with `readDrawingSettings` and
 * `applyDrawingSettings`. That keeps this tier free of the drawing tier and of
 * any tool: the catalog validates shape and bounds, and the host applies a
 * template through the tool's own schema, which drops a path the tool no
 * longer declares and coerces every value to its field's kind. A template
 * never carries what a drawing says or where it is (`text.value`, anchors, a
 * lock, a pane): those are the drawing's, not its look.
 */
import { list, number, readJson, record, string, WorkspaceDocumentError, type Json } from './json';
import { createIndexedDbCatalogStorage, type IndexedDbCatalogStorage } from './indexed-db';

/** Named templates per namespace, and values per template. A template is a look, not a library. */
const MAX_TEMPLATES = 200;
const MAX_DEFAULTS = 200;
const MAX_VALUES = 64;
const MAX_LEVELS = 64;
const MAX_STRING = 256;

/** One level of a Fibonacci-family ladder, as `style.levels` holds it. */
export interface DrawingTemplateLevel {
  ratio: number;
  color?: string;
  enabled?: boolean;
  label?: string;
}

/** A settings value: what a schema field of any kind stores. */
export type DrawingTemplateValue = string | number | boolean | DrawingTemplateLevel[];

/** Settings by schema path, as `readDrawingSettings` returns them. */
export type DrawingTemplateValues = Record<string, DrawingTemplateValue>;

/** A saved look for one tool. */
export interface DrawingTemplate {
  id: string;
  name: string;
  /** The drawing tool id the template was saved from, and the only tool it is offered for. */
  tool: string;
  values: DrawingTemplateValues;
  createdAt: number;
  updatedAt: number;
}

/** The look a tool's new drawings start with. At most one per tool. */
export interface DrawingToolDefault {
  tool: string;
  values: DrawingTemplateValues;
  updatedAt: number;
}

export interface DrawingTemplateCatalog {
  version: 1;
  revision: number;
  templates: DrawingTemplate[];
  defaults: DrawingToolDefault[];
}

export interface DrawingTemplateOperationOptions {
  /** Cancellation is effective until the storage transaction commits. */
  signal?: AbortSignal | undefined;
  /** Refuse the change when the catalog has moved past this revision. */
  expectedRevision?: number;
}

/** The host must atomically reject writes whose expectedRevision is stale. */
export interface DrawingTemplateStorage {
  read(namespace: string): Promise<unknown | null>;
  write(namespace: string, catalog: DrawingTemplateCatalog, expectedRevision: number, options?: DrawingTemplateOperationOptions): Promise<void>;
}

export interface DrawingTemplateRepositoryOptions { now?: () => number; id?: () => string }

/**
 * What the widget calls, and nothing more. `DrawingTemplateRepository`
 * implements it; a host that keeps templates on its own server can implement
 * it directly instead.
 */
export interface DrawingTemplateStore {
  load(): Promise<DrawingTemplateCatalog>;
  /** Called after each change this store commits, before that change's promise resolves. Returns the unsubscribe. */
  subscribe(listener: (catalog: DrawingTemplateCatalog) => void): () => void;
  /**
   * Save `values` under `name` for `tool`. A template of the same tool whose
   * name matches (ignoring case and outer spaces) takes the new values and
   * keeps its identity, so saving twice under one name never makes two.
   */
  saveTemplate(name: string, tool: string, values: DrawingTemplateValues, options?: DrawingTemplateOperationOptions): Promise<DrawingTemplate>;
  renameTemplate(id: string, name: string, options?: DrawingTemplateOperationOptions): Promise<DrawingTemplate>;
  removeTemplate(id: string, options?: DrawingTemplateOperationOptions): Promise<void>;
  /** The look new drawings of `tool` start with; null forgets it, and the tool's own look returns. */
  setDefault(tool: string, values: DrawingTemplateValues | null, options?: DrawingTemplateOperationOptions): Promise<void>;
}

export class DrawingTemplateConflictError extends Error {
  constructor() { super('The saved drawing templates changed in another session. Reload and retry.'); this.name = 'DrawingTemplateConflictError'; }
}

/**
 * The paths a template may hold: a key under `style`, `text` or `props`, as a
 * drawing's settings schema names them, and never the text a drawing says.
 */
const PATH = /^(style|text|props)\.[A-Za-z][A-Za-z0-9_]{0,63}$/;

function parseLevel(input: Json): DrawingTemplateLevel {
  const source = record(input, 'template level');
  const out: DrawingTemplateLevel = { ratio: number(source.ratio, 'level ratio', -1e6, 1e6) };
  if (source.color !== undefined) out.color = string(source.color, 'level color', 64);
  if (source.enabled !== undefined) {
    if (typeof source.enabled !== 'boolean') throw new WorkspaceDocumentError('level enabled must be a boolean');
    out.enabled = source.enabled;
  }
  if (source.label !== undefined) out.label = string(source.label, 'level label', 64, true);
  return out;
}

function parseValue(input: Json | undefined, path: string): DrawingTemplateValue {
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return number(input, path, -1e9, 1e9);
  if (typeof input === 'string') return string(input, path, MAX_STRING, true);
  if (Array.isArray(input)) return list(input, path, MAX_LEVELS).map(parseLevel);
  throw new WorkspaceDocumentError(`${path} must be a string, a number, a boolean or a list of levels`);
}

/** Validate a template's values: bounded, schema-shaped paths, no drawing content. */
export function parseDrawingTemplateValues(input: unknown): DrawingTemplateValues {
  const source = record(readJson(input), 'template values');
  const paths = Object.keys(source);
  if (paths.length > MAX_VALUES) throw new WorkspaceDocumentError(`template values must be within the ${MAX_VALUES} setting limit`);
  const out: DrawingTemplateValues = {};
  for (const path of paths) {
    // What the drawing says is the drawing's, never part of its look.
    if (!PATH.test(path) || path === 'text.value') throw new WorkspaceDocumentError(`${path} is not a template setting`);
    out[path] = parseValue(source[path], path);
  }
  return out;
}

const toolId = (input: Json | undefined): string => string(input, 'drawing tool', 100);

function parseTemplate(input: Json): DrawingTemplate {
  const source = record(input, 'drawing template');
  const createdAt = number(source.createdAt, 'createdAt', 0);
  return {
    id: string(source.id, 'template ID', 100), name: string(source.name, 'name', 120), tool: toolId(source.tool),
    values: parseDrawingTemplateValues(source.values), createdAt, updatedAt: number(source.updatedAt, 'updatedAt', createdAt),
  };
}

function parseDefault(input: Json): DrawingToolDefault {
  const source = record(input, 'drawing default');
  return { tool: toolId(source.tool), values: parseDrawingTemplateValues(source.values), updatedAt: number(source.updatedAt, 'updatedAt', 0) };
}

/** Parse the complete catalog before any mutation; corrupt storage is never replaced. */
export function parseDrawingTemplateCatalog(input: unknown): DrawingTemplateCatalog {
  const source = record(readJson(input), 'drawing template catalog');
  if (source.version !== 1) throw new WorkspaceDocumentError('Unsupported drawing template catalog version');
  const templates = list(source.templates, 'drawing templates', MAX_TEMPLATES).map(parseTemplate);
  if (new Set(templates.map(item => item.id)).size !== templates.length) throw new WorkspaceDocumentError('Duplicate template ID');
  const defaults = list(source.defaults, 'drawing defaults', MAX_DEFAULTS).map(parseDefault);
  if (new Set(defaults.map(item => item.tool)).size !== defaults.length) throw new WorkspaceDocumentError('Duplicate tool default');
  return { version: 1, revision: number(source.revision, 'catalog revision', 0, Number.MAX_SAFE_INTEGER, true), templates, defaults };
}

const emptyCatalog = (): DrawingTemplateCatalog => ({ version: 1, revision: 0, templates: [], defaults: [] });
const copy = <T>(value: T): T => readJson(value) as T;
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Drawing templates and tool defaults with serialized, revision-checked
 * writes. Each change is applied to the catalog as stored at that moment, so
 * a template saved in another session survives; only a write racing it is
 * refused, as a conflict. Create a new repository when the account changes.
 */
export class DrawingTemplateRepository implements DrawingTemplateStore {
  private readonly _storage: DrawingTemplateStorage;
  private readonly _namespace: string;
  private readonly _now: () => number;
  private readonly _id: () => string;
  private readonly _listeners = new Set<(catalog: DrawingTemplateCatalog) => void>();
  private _queue: Promise<void> = Promise.resolve();

  constructor(storage: DrawingTemplateStorage, namespace: string, options: DrawingTemplateRepositoryOptions = {}) {
    this._storage = storage;
    this._namespace = string(namespace, 'storage namespace');
    this._now = options.now ?? Date.now;
    this._id = options.id ?? (() => {
      if (!globalThis.crypto?.randomUUID) throw new WorkspaceDocumentError('Supply an ID factory when crypto.randomUUID is unavailable');
      return globalThis.crypto.randomUUID();
    });
  }

  get namespace(): string { return this._namespace; }

  async load(): Promise<DrawingTemplateCatalog> {
    await this._queue;
    return this._read();
  }

  subscribe(listener: (catalog: DrawingTemplateCatalog) => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  async saveTemplate(name: string, tool: string, values: DrawingTemplateValues, options?: DrawingTemplateOperationOptions): Promise<DrawingTemplate> {
    const title = string(name, 'name', 120);
    const id = toolId(tool);
    const parsed = parseDrawingTemplateValues(values);
    return this._transact(catalog => {
      const now = this._now();
      const existing = catalog.templates.find(item => item.tool === id && sameName(item.name, title));
      if (existing) {
        existing.values = parsed;
        existing.updatedAt = this._later(existing.updatedAt, now);
        return existing;
      }
      const doc: DrawingTemplate = { id: this._newId(catalog), name: title, tool: id, values: parsed, createdAt: now, updatedAt: now };
      catalog.templates.push(doc);
      return doc;
    }, options);
  }

  async renameTemplate(id: string, name: string, options?: DrawingTemplateOperationOptions): Promise<DrawingTemplate> {
    const title = string(name, 'name', 120);
    return this._transact(catalog => {
      const doc = this._find(catalog, id);
      if (catalog.templates.some(item => item !== doc && item.tool === doc.tool && sameName(item.name, title))) {
        throw new WorkspaceDocumentError(`A template named ${title} already exists for this tool`);
      }
      doc.name = title;
      doc.updatedAt = this._later(doc.updatedAt, this._now());
      return doc;
    }, options);
  }

  async removeTemplate(id: string, options?: DrawingTemplateOperationOptions): Promise<void> {
    return this._transact(catalog => {
      const doc = this._find(catalog, id);
      catalog.templates = catalog.templates.filter(item => item !== doc);
    }, options);
  }

  async setDefault(tool: string, values: DrawingTemplateValues | null, options?: DrawingTemplateOperationOptions): Promise<void> {
    const id = toolId(tool);
    const parsed = values === null ? null : parseDrawingTemplateValues(values);
    return this._transact(catalog => {
      const existing = catalog.defaults.find(item => item.tool === id);
      if (parsed === null) {
        catalog.defaults = catalog.defaults.filter(item => item !== existing);
        return;
      }
      const updatedAt = this._later(existing?.updatedAt ?? 0, this._now());
      if (existing) { existing.values = parsed; existing.updatedAt = updatedAt; }
      else catalog.defaults.push({ tool: id, values: parsed, updatedAt });
    }, options);
  }

  private async _read(): Promise<DrawingTemplateCatalog> {
    const input = await this._storage.read(this._namespace);
    return input === null ? emptyCatalog() : parseDrawingTemplateCatalog(input);
  }

  private _transact<T>(mutate: (catalog: DrawingTemplateCatalog) => T, options: DrawingTemplateOperationOptions = {}): Promise<T> {
    const { signal } = options;
    const expected = options.expectedRevision === undefined ? undefined
      : number(options.expectedRevision, 'expected revision', 0, Number.MAX_SAFE_INTEGER, true);
    const operation = this._queue.then(async () => {
      signal?.throwIfAborted();
      const catalog = await this._read();
      signal?.throwIfAborted();
      if (expected !== undefined && catalog.revision !== expected) throw new DrawingTemplateConflictError();
      const revision = catalog.revision;
      const result = mutate(catalog);
      catalog.revision++;
      // Validate the entire candidate, including limits, before touching storage.
      const next = parseDrawingTemplateCatalog(catalog);
      signal?.throwIfAborted();
      await this._storage.write(this._namespace, next, revision, { signal });
      for (const listener of Array.from(this._listeners)) {
        // A host listener failing is reported, but the write has committed and resolves.
        try { listener(copy(next)); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
      return result === undefined ? result : copy(result);
    });
    this._queue = operation.then(() => {}, () => {});
    return operation;
  }

  private _find(catalog: DrawingTemplateCatalog, id: string): DrawingTemplate {
    const key = string(id, 'template ID', 100);
    const doc = catalog.templates.find(item => item.id === key);
    if (!doc) throw new WorkspaceDocumentError('Saved drawing template does not exist');
    return doc;
  }

  private _later(previous: number, now: number): number {
    return Math.max(previous, number(now, 'current time', 0));
  }

  private _newId(catalog: DrawingTemplateCatalog): string {
    const id = string(this._id(), 'generated template ID', 100);
    if (catalog.templates.some(item => item.id === id)) throw new WorkspaceDocumentError('Generated template ID collision');
    return id;
  }
}

/**
 * Revision-checked storage in memory: for tests, previews and hosts without
 * IndexedDB. Nothing outlives the page. `seed` maps namespaces to catalogs.
 */
export function createMemoryDrawingTemplateStorage(seed: Readonly<Record<string, unknown>> = {}): DrawingTemplateStorage {
  const values = new Map<string, unknown>(Object.entries(seed).map(([key, value]) => [key, copy(value)]));
  return {
    async read(namespace) {
      const value = values.get(string(namespace, 'storage namespace'));
      return value === undefined ? null : copy(value);
    },
    async write(namespace, catalog, expectedRevision, options) {
      options?.signal?.throwIfAborted();
      const key = string(namespace, 'storage namespace');
      const expected = number(expectedRevision, 'expected revision', 0, Number.MAX_SAFE_INTEGER, true);
      const next = parseDrawingTemplateCatalog(catalog);
      if (next.revision !== expected + 1) throw new WorkspaceDocumentError('A write must advance the catalog revision by one');
      const previous = values.get(key);
      if ((previous === undefined ? 0 : parseDrawingTemplateCatalog(previous).revision) !== expected) throw new DrawingTemplateConflictError();
      values.set(key, next);
    },
  };
}

export type IndexedDbDrawingTemplateStorage = IndexedDbCatalogStorage<DrawingTemplateCatalog> & DrawingTemplateStorage;

/**
 * Browser persistence with one atomic compare-and-write transaction per
 * catalog, the contract the workspace and watchlist adapters keep. Pass the
 * host's indexedDB explicitly; importing this module needs no browser.
 */
export function createIndexedDbDrawingTemplateStorage(factory: IDBFactory, databaseName = 'openalgo-chart-drawing-templates'): IndexedDbDrawingTemplateStorage {
  return createIndexedDbCatalogStorage(factory, databaseName, 'Drawing template', parseDrawingTemplateCatalog, () => new DrawingTemplateConflictError());
}
