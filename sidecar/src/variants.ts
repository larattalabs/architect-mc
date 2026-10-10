// Variants and imports without Claude (docs/CONTRACT.md "Variants without Claude", "Import / export").
//
//   - VariantBook: the variant/import jobs in state.json, `variant.upsert` on every change; done and
//     failed are final
//   - a variant: the library entry's .mjs source is copied into a scratch kit copy
//     (<data>/variants/<v>/kit/designs/<newId>.mjs), built with the palette and values through the
//     pristine-kit check (kit/build.mjs in a child process with a minimal env, `--type` = the entry's
//     type, no `--max`: a variant may grow), rendered, and installed as a new entry
//     (<from>_<palette>, or <from>_v2, ...; never overwriting) with `variantOf`, the original's
//     `request` and a `displayName`
//   - an import: an .nbt from <gameDir>/architect/imports/ or a world's generated/<ns>/structures/
//     goes through kit/import.mjs (custom profile, import severity), is rendered and installed with
//     `imported: true` and no source
//   - VariantRunner: one job at a time, on its own queue, so a variant never waits behind a design
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './context.js';
import type { Config } from './config.js';
import { checkDesign, finishCheck, freeLibraryId, installDesign, KIT, CHECK_DIR, refreshKit, renderPreviews, runNode, slugify, withDesignId, type CheckResult, type Sidecar as SidecarJson } from './designs.js';
import type { BibleIndex } from './bibles.js';
import type { BiblePin, DesignRequest, Outbound, PaletteSpec, ParamValues, Reskin, ReskinFrom, Variant, VariantStatus } from './protocol.js';
import type { Store } from './store.js';
import { truncate } from './util/text.js';
import { SIM_COPY_FAIL, SIM_COPY_SIZE } from './copies.js';

/** (0b) the kit's recipe (kit/lib/variation.mjs chooseRecipe) */
export interface CopyRecipe {
  shift: { name: string; set: Record<string, string> } | null;
  param: { name: string; value: unknown } | null;
  roles: Record<string, string>;
  values: Record<string, unknown>;
  mirror: boolean;
  ordinal: number;
  attempt: number;
  levers?: string[];
  changed?: number;
  bar?: boolean;
}

/** (0b) The same 32-bit seed as kit/lib/variation.mjs seedOf (sha256 of the parts joined by NUL). */
export function seedOf(...parts: string[]): number {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest().readUInt32BE(0);
}

/** What a copy's derivation records (§2.4): enough to rebuild it from any later source version. */
function recipeRecord(r: CopyRecipe, v: Variant, c: NonNullable<Variant['copy']>): Record<string, unknown> {
  return { shift: r.shift, param: r.param, values: r.values, mirror: r.mirror, roles: r.roles, bible: v.bible, group: c.group, itemKey: c.itemKey, archetype: c.archetype, ordinal: c.ordinal, attempt: r.attempt, ...(r.levers ? { levers: r.levers } : {}), ...(r.changed !== undefined ? { changed: r.changed } : {}), ...(r.bar !== undefined ? { bar: r.bar } : {}) };
}

function recipeLabel(r: CopyRecipe): string {
  return [r.shift ? `shift ${r.shift.name}` : 'no shift', r.param ? `${r.param.name} ${JSON.stringify(r.param.value)}` : 'no param', r.mirror ? 'mirrored' : 'not mirrored'].join(', ');
}

function parseJsonLine(stdout: string): unknown {
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  try {
    return line ? JSON.parse(line) : undefined;
  } catch {
    return undefined;
  }
}

/** A sim fault's check result (no build). */
function simFault(kind: 'check' | 'size'): CheckResult {
  return { ok: false, problem: kind === 'size' ? 'the checker refused the design:\n- size exceeds the limit (sim:copysize)' : 'the checker refused the design:\n- sim:copyfail', output: '', warnings: [] };
}

export const VARIANT_SNAPSHOT_LIMIT = 20;
const VARIANT_KEEP = 100;
const FINAL: ReadonlySet<VariantStatus> = new Set(['done', 'failed']);
/** per kit child process (a variant is seconds, not minutes) */
const KIT_TIMEOUT_MS = 120_000;

export const isFinalVariant = (v: Variant): boolean => FINAL.has(v.status);

/** A request the client can fix (answered with ack ok:false and the reason). */
export class VariantRefused extends Error {}

// ---- the book ---------------------------------------------------------------------------------

export type VariantPatch = Partial<Pick<Variant, 'status' | 'step' | 'blueprintId' | 'size' | 'previews' | 'error' | 'name' | 'copy'>>;

export interface VariantBookCtx {
  store: Store;
  emit(msg: Outbound): void;
  now(): number;
}

export class VariantBook {
  constructor(private ctx: VariantBookCtx) {}

  private get all(): Variant[] {
    return (this.ctx.store.data.variants ??= []);
  }

  list(): Variant[] {
    return this.all;
  }

  get(id: string): Variant | undefined {
    return this.all.find((v) => v.id === id);
  }

  active(): Variant[] {
    return this.all.filter((v) => !isFinalVariant(v));
  }

  /** what the snapshot carries: the last VARIANT_SNAPSHOT_LIMIT plus every unfinished one, oldest first */
  recent(): Variant[] {
    const tail = this.all.slice(-VARIANT_SNAPSHOT_LIMIT);
    const extra = this.active().filter((v) => !tail.includes(v));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((v) => structuredClone(v));
  }

  create(fields: Pick<Variant, 'kind' | 'from'> & Partial<Pick<Variant, 'palette' | 'values' | 'name' | 'bible' | 'reskin' | 'copy'>>): Variant {
    const now = this.ctx.now();
    const v: Variant = {
      id: this.ctx.store.nextId('v'),
      kind: fields.kind,
      from: fields.from,
      status: 'queued',
      step: 'waiting for the variant builder',
      ...(fields.palette !== undefined ? { palette: structuredClone(fields.palette) } : {}),
      ...(fields.values !== undefined ? { values: { ...fields.values } } : {}),
      ...(fields.name !== undefined ? { name: fields.name } : {}),
      ...(fields.bible !== undefined ? { bible: { ...fields.bible } } : {}),
      ...(fields.reskin !== undefined ? { reskin: fields.reskin } : {}),
      ...(fields.copy !== undefined ? { copy: structuredClone(fields.copy) } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.all.push(v);
    while (this.all.length > VARIANT_KEEP) {
      const i = this.all.findIndex((x) => isFinalVariant(x));
      if (i < 0) break;
      this.all.splice(i, 1);
    }
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'variant.upsert', variant: structuredClone(v) });
    return v;
  }

  /** Patch and broadcast; a final job never changes. */
  update(id: string, patch: VariantPatch): Variant | undefined {
    const v = this.get(id);
    if (!v || isFinalVariant(v)) return v;
    let changed = false;
    for (const [k, val0] of Object.entries(patch) as Array<[keyof VariantPatch, unknown]>) {
      if (val0 === undefined) continue;
      const val = k === 'step' || k === 'error' ? truncate(String(val0).replace(k === 'step' ? /\s+/g : /[ \t]+/g, ' ').trim(), k === 'step' ? 120 : 1500) : val0;
      if (JSON.stringify(v[k]) !== JSON.stringify(val)) {
        (v as Record<string, unknown>)[k] = val;
        changed = true;
      }
    }
    if (changed) {
      v.updatedAt = this.ctx.now();
      // a variant that just became final is on disk before any client hears of it (as DesignBook.update): after a crash
      // between the emit and a later flush the restart would build it again and install a second library entry under
      // a new id, next to the one the client was told about
      if (isFinalVariant(v)) this.ctx.store.flush();
      else this.ctx.store.markDirty();
      this.ctx.emit({ type: 'variant.upsert', variant: structuredClone(v) });
    }
    return v;
  }
}

// ---- where a variant comes from ---------------------------------------------------------------

export interface VariantSource {
  from: string;
  /** the .mjs to copy */
  sourceFile: string;
  /** the entry's sidecar JSON (a bundled example's from kit/examples, if the kit has it) */
  entry?: Record<string, unknown>;
  bundled: boolean;
}

/** A non-empty `ext` object (namespaced metadata other mods keep on an entry). */
export function isExt(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The source a variant of `from` is built from: <library>/<from>/<from>.mjs, or for a bundled
 * example (it lives in the mod's jar, not in the library) the kit's designs/<from>.mjs. Throws
 * VariantRefused with the reason (an import has no source, so no variants).
 */
export function findVariantSource(libraryDir: string, kitDir: string, from: string): VariantSource {
  const dir = path.join(libraryDir, from);
  const json = path.join(dir, `${from}.blueprint.json`);
  if (fs.existsSync(json)) {
    const entry = readJsonFile(json);
    if (!entry) throw new VariantRefused(`library entry ${from}: its ${from}.blueprint.json is not valid JSON`);
    if (entry.imported === true) throw new VariantRefused(`${from} is an imported structure: it has no source, so no variants`);
    const src = path.join(dir, `${from}.mjs`);
    if (!fs.existsSync(src)) throw new VariantRefused(`library entry ${from} has no source (${from}.mjs), so no variants`);
    return { from, sourceFile: src, entry, bundled: false };
  }
  const kitSrc = [path.join(kitDir, 'designs', `${from}.mjs`), path.join(kitDir, 'examples', from, `${from}.mjs`)].find((f) => fs.existsSync(f));
  if (kitSrc) {
    const entry = readJsonFile(path.join(kitDir, 'examples', from, `${from}.blueprint.json`));
    return { from, sourceFile: kitSrc, ...(entry ? { entry } : {}), bundled: true };
  }
  throw new VariantRefused(`no library entry "${from}"`);
}

/**
 * Point a source's kit imports at the scratch kit: any relative specifier ending in lib/<name>.mjs
 * becomes ../lib/<name>.mjs (where kit/lib is from kit/designs/), whatever path it had in the library.
 */
export function normalizeKitImports(source: string): string {
  return source.replace(/(['"])((?:\.\.?\/)+(?:[^'"\n]*\/)?)lib\/([\w.-]+\.mjs)\1/g, (_m, q: string, _p: string, file: string) => `${q}../lib/${file}${q}`);
}

/**
 * The palette to build with: a preset string as asked, or palette inputs over the entry's recorded ones. A recorded
 * bible palette (4b: `{ bible: { id, version, roles } }`) is passed on as it is when nothing is asked, and replaced by
 * whatever is asked.
 */
export function mergePalette(recorded: unknown, asked: PaletteSpec | undefined): PaletteSpec | Record<string, unknown> | undefined {
  if (asked === undefined) return isPaletteInputs(recorded) ? recorded : isBiblePalette(recorded) ? recorded : undefined;
  if (typeof asked === 'string') return asked;
  return { ...(isPaletteInputs(recorded) ? recorded : {}), ...asked };
}

/** A recorded bible palette: { bible: { id, version, roles } }. */
export function isBiblePalette(p: unknown): p is { bible: { id: string; version: number; roles: Record<string, string> } } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  const b = (p as { bible?: unknown }).bible;
  return Object.keys(p).length === 1 && !!b && typeof b === 'object' && !!(b as { roles?: unknown }).roles;
}

function isPaletteInputs(p: unknown): p is Exclude<PaletteSpec, string> {
  return !!p && typeof p === 'object' && !Array.isArray(p) && Object.entries(p).every(([k, v]) => ['preset', 'wood', 'stone', 'roof', 'accent'].includes(k) && typeof v === 'string');
}

/** A short label of an asked palette: the preset name, or its wood / stone / roof / accent. */
export function paletteLabel(p: PaletteSpec | undefined): string {
  if (p === undefined) return '';
  if (typeof p === 'string') return p.replace(/_/g, ' ');
  return [p.wood, p.stone, p.roof, p.accent].filter(Boolean).map((s) => s!.replace(/^minecraft:/, '').replace(/_/g, ' ')).join(', ') || (p.preset ?? '').replace(/_/g, ' ');
}

/**
 * The new entry's id: <from>_<palette> (then _2, _3, ...) when a palette is asked, else <from>_v2,
 * <from>_v3, ...; never one with a folder in the library or in `taken`.
 */
export function variantId(libraryDir: string, from: string, palette: PaletteSpec | undefined, taken: ReadonlySet<string> = new Set(), bible?: string): string {
  const sfx = bible ? slugify(bible.replace(/^bib_/, ''), 20) : typeof palette === 'string' ? slugify(palette, 20) : palette ? slugify((palette.wood ?? palette.stone ?? palette.roof ?? palette.accent ?? palette.preset ?? '').replace(/^minecraft:/, ''), 20) : '';
  const stem = from.slice(0, 40);
  if (sfx) return freeLibraryId(libraryDir, `${stem}_${sfx}`, taken);
  for (let n = 2; ; n++) {
    const id = `${stem}_v${n}`;
    if (!taken.has(id) && !fs.existsSync(path.join(libraryDir, id))) return id;
  }
}

interface ParamDecl {
  type?: string;
  label?: string;
}

/** "<name> (<palette>, floors 2, no porch)"; only the values that differ from the entry's. */
export function variantDisplayName(base: string, opts: { palette?: PaletteSpec | undefined; values?: ParamValues | undefined; baseValues?: Record<string, unknown> | undefined; params?: Record<string, ParamDecl> | undefined }): string {
  const parts: string[] = [];
  const pl = paletteLabel(opts.palette);
  if (pl) parts.push(pl);
  for (const [k, v] of Object.entries(opts.values ?? {})) {
    if (opts.baseValues && opts.baseValues[k] === v) continue;
    const label = (opts.params?.[k]?.label ?? k.replace(/_/g, ' ')).toLowerCase();
    parts.push(typeof v === 'boolean' ? (v ? label : `no ${label}`) : `${label} ${String(v).replace(/_/g, ' ')}`);
  }
  return truncate(`${base} (${parts.length ? parts.join(', ') : 'variant'})`, 80);
}

// ---- imports ------------------------------------------------------------------------------------

/**
 * Where imports may come from, derived from the library path (<gameDir>/architect/library):
 * <gameDir>/architect/imports/ and <gameDir>/saves/<world>/generated/<namespace>/structures/.
 */
export function importRoots(libraryDir: string): { imports: string; exports: string; saves: string } {
  const architect = path.dirname(libraryDir);
  return { imports: path.join(architect, 'imports'), exports: path.join(architect, 'exports'), saves: path.join(path.dirname(architect), 'saves') };
}

const real = (p: string): string | undefined => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Check an import path and return its real path, or throw VariantRefused saying why. The file must
 * be an existing .nbt whose real path (links resolved) is under <gameDir>/architect/imports/ or in
 * a world's generated/<namespace>/structures/.
 */
export function checkImportPath(p: string, libraryDir: string): string {
  const roots = importRoots(libraryDir);
  const allowed = `an .nbt file in ${roots.imports}${path.sep}, in ${roots.exports}${path.sep} or in a world's ${path.join('saves', '<world>', 'generated', '<namespace>', 'structure')}${path.sep} (or structures${path.sep})`;
  const refuse = (why: string): never => {
    throw new VariantRefused(`import refused: ${why}. Architect imports only ${allowed}`);
  };
  if (!path.isAbsolute(p)) refuse(`"${p}" is not an absolute path`);
  if (!/\.nbt$/i.test(p)) refuse(`"${path.basename(p)}" is not an .nbt file`);
  // (5b) <id>.parts.nbt is an entry's per-cell part map, not a structure
  if (/\.parts\.nbt$/i.test(p)) refuse(`"${path.basename(p)}" is a part map (<id>.parts.nbt), not a structure`);
  const r = real(p);
  if (!r) refuse(`there is no file ${p}`);
  const file = r!;
  if (!fs.statSync(file).isFile()) refuse(`${p} is not a file`);
  if (!/\.nbt$/i.test(file)) refuse(`${p} leads to ${file}, not an .nbt file`);
  const inside = (root: string | undefined) => {
    if (!root) return undefined;
    const rel = path.relative(root, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep) : undefined;
  };
  if (inside(real(roots.imports)) || inside(real(roots.exports))) return file;
  const parts = inside(real(roots.saves));
  // <world>/generated/<namespace>/structure/<...>.nbt (26.3 structure-block saves; `structures` as older versions had)
  if (parts && parts.length >= 5 && parts[1] === 'generated' && (parts[3] === 'structure' || parts[3] === 'structures')) return file;
  return refuse(`${p} is outside those folders`);
}

// ---- the runner ---------------------------------------------------------------------------------

/** What the runner needs from the sidecar. */
export interface VariantHost {
  readonly config: Config;
  readonly variants: VariantBook;
  readonly log: Logger;
  /** (4b) re-skins build with a bible's roles */
  readonly bibleIndex: Pick<BibleIndex, 'resolve'>;
  now(): number;
  /** (0b) an entry's head version (1 for a bundled example or an entry without versions) */
  entryHead?(entryId: string): number;
  /** (0b) a copy: the recipes of its archetype's earlier copies */
  copySiblings?(groupId: string, archetype: string, ordinal: number): Array<Record<string, unknown>>;
  /** (0b) a massing version's blueprint JSON path */
  massingFile?(id: string, version: number): string | undefined;
  /** (0b) the sim backend: copies honour the sim faults (sim:copyfail, sim:copysize) */
  readonly simFaults?: boolean;
}

/** (0b) Up to this many recipes per copy; then the item falls back to an original. */
export const COPY_RECIPES = 3;

export class VariantRunner {
  private queue: string[] = [];
  private current: string | undefined;
  private stopped = false;
  private runP: Promise<void> | undefined;
  /** ids an unfinished job is about to install under */
  private taken = new Set<string>();

  constructor(private host: VariantHost) {}

  /** Pick up the jobs that were queued or building when the sidecar stopped. */
  start(): void {
    for (const v of this.host.variants.active()) {
      this.host.variants.update(v.id, { status: 'queued', step: 'picked up again after a restart' });
      this.enqueue(v.id);
    }
  }

  runningId(): string | undefined {
    return this.current;
  }

  enqueue(id: string): void {
    if (this.queue.includes(id) || this.current === id) return;
    this.queue.push(id);
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.runP?.catch(() => undefined);
  }

  /** resolves when nothing is queued or running (tests) */
  async idle(): Promise<void> {
    while (this.runP) await this.runP.catch(() => undefined);
  }

  private kick(): void {
    if (this.runP || this.stopped) return;
    this.runP = (async () => {
      try {
        while (!this.stopped && this.queue.length) {
          const id = this.queue.shift()!;
          this.current = id;
          const t0 = Date.now();
          try {
            const v = this.host.variants.get(id);
            if (!v || isFinalVariant(v)) continue;
            if (v.kind === 'import') await this.runImport(v);
            else if (v.copy) await this.runCopy(v);
            else await this.runVariant(v);
            const done = this.host.variants.get(id);
            if (done?.status === 'done') this.host.log.info(`${v.kind} ${id} is ready: ${done.blueprintId} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          } catch (e) {
            const msg = (e as Error).message;
            this.host.variants.update(id, { status: 'failed', step: `failed: ${msg.split('\n')[0]}`, error: msg });
            this.host.log.warn(`variant job ${id} failed: ${truncate(msg.split('\n')[0] ?? msg, 200)}`);
          } finally {
            this.current = undefined;
          }
        }
      } finally {
        this.runP = undefined;
      }
    })();
  }

  /** the ids other jobs hold (a job installs under its own) */
  private othersTaken(bp: string): Set<string> {
    return new Set([...this.taken].filter((x) => x !== bp));
  }

  private step(id: string, step: string): void {
    this.host.variants.update(id, { status: 'building', step });
  }

  /** <data>/variants/<id>/ with a fresh copy of the kit (its physical path). */
  private scratch(id: string): string {
    const dir = path.join(this.host.config.dataDir, 'variants', id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const scratch = fs.realpathSync(dir);
    refreshKit(this.host.config.kitDir, scratch);
    return scratch;
  }

  private async runVariant(v: Variant): Promise<void> {
    const cfg = this.host.config;
    this.step(v.id, 'copying the source');
    const src = findVariantSource(cfg.libraryDir, cfg.kitDir, v.from);
    const entry = src.entry ?? {};
    const scratch = this.scratch(v.id);
    const bp = variantId(cfg.libraryDir, v.from, v.palette, this.taken, v.bible?.id);
    this.taken.add(bp);
    try {
      const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(fs.readFileSync(src.sourceFile, 'utf8')), bp));
      // 4b: a bible design imports ../../bible/ (its bible.json and components): the entry keeps a copy in bible/
      const own = path.join(path.dirname(src.sourceFile), 'bible');
      if (!src.bundled && fs.existsSync(own)) fs.cpSync(own, path.join(scratch, 'bible'), { recursive: true });
      const bibleFiles = fs.existsSync(path.join(scratch, 'bible')) ? ['bible.json', 'bible.md', 'components.mjs'].map((f) => ({ from: path.join(scratch, 'bible', f), to: path.join('bible', f) })) : [];
      let palette = v.bible ? undefined : mergePalette(entry.palette, v.palette);
      if (palette !== undefined && typeof palette !== 'string' && !isBiblePalette(palette) && !isPaletteInputs(entry.palette) && !(palette as { preset?: string }).preset) {
        // an entry without a recorded palette (built before phase 2): start from the design's own default
        palette = { ...(await this.defaultPalette(scratch, bp)), ...palette };
      }
      // a re-skin (4b): the target bible's roles; the design keeps its own components (they read the roles)
      let bibleArgs: string[] = [];
      let bibleName: string | undefined;
      if (v.bible) {
        const target = this.host.bibleIndex.resolve(v.bible);
        fs.copyFileSync(target.files.json, path.join(scratch, 'target-bible.json'));
        bibleArgs = ['--bible', 'target-bible.json'];
        bibleName = target.info.name;
      }
      const baseValues = entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : {};
      const values = { ...baseValues, ...(v.values ?? {}) };
      const type = typeof entry.type === 'string' ? entry.type : undefined;
      this.step(v.id, `building ${bp} and checking it`);
      const extra = [
        ...(palette !== undefined ? ['--palette', typeof palette === 'string' ? palette : JSON.stringify(palette)] : []),
        ...bibleArgs,
        ...(Object.keys(values).length ? ['--values', JSON.stringify(values)] : []),
      ];
      const res = await checkDesign(cfg.kitDir, scratch, bp, { type, ...(Array.isArray(entry.profile) ? { profile: entry.profile as string[] } : {}) }, KIT_TIMEOUT_MS, extra);
      if (!res.ok) throw new Error(`the variant did not pass: ${res.problem ?? 'the check failed'}`);
      this.step(v.id, 'rendering previews');
      const r = await renderPreviews(scratch, res.nbt!, KIT_TIMEOUT_MS);
      const sc = res.sidecar!;
      const name = typeof entry.name === 'string' ? entry.name : typeof sc.name === 'string' ? sc.name : v.from;
      const displayName = v.name ?? (bibleName ? truncate(`${name} (${bibleName})`, 80) : variantDisplayName(name, { palette: v.palette, values: v.values, baseValues, params: sc.params as Record<string, ParamDecl> | undefined }));
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: this.othersTaken(bp),
        nbt: res.nbt!,
        sidecar: sc,
        source: design,
        previews: r.files,
        files: bibleFiles,
        meta: {
          name,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          request: entry.request && typeof entry.request === 'object' ? (entry.request as DesignRequest) : undefined,
          createdAt: this.host.now(),
          // the entry's ext (docs/CONTRACT.md "ext (R5)": builds, variants and imports keep it); a re-skin's bible (the
          // kit records it too), else the bible the entry was built with
          extra: {
            variantOf: v.from,
            // (0b, §2.4) which version it was made from, and how (a re-skin or a player variant; their builds are unchanged)
            variantOfVersion: this.host.entryHead?.(v.from) ?? 1,
            derivation: {
              source: v.from,
              sourceVersion: this.host.entryHead?.(v.from) ?? 1,
              kind: v.reskin || v.bible ? 'reskin' : 'variant',
              recipe: {
                ...(v.palette !== undefined ? { palette: v.palette } : {}),
                ...(v.values !== undefined ? { values: v.values } : {}),
                ...(v.bible ? { bible: v.bible } : {}),
                ...(v.reskin ? { reskin: v.reskin } : {}),
              },
            },
            displayName,
            ...(isExt(entry.ext) ? { ext: entry.ext } : {}),
            ...(v.bible ? { bible: v.bible } : entry.bible && typeof entry.bible === 'object' ? { bible: entry.bible } : {}),
            ...(Array.isArray(entry.profile) ? { profile: entry.profile } : {}),
            ...(v.reskin ? { reskin: v.reskin } : {}),
          },
        },
      });
      this.finish(v.id, installed.blueprintId, sc, installed.previews, [r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; '), displayName);
    } finally {
      this.taken.delete(bp);
    }
  }

  /**
   * (0b, §2.2-§2.4) A copy in a design group: the archetype entry's source under a new id, a recipe chosen by the kit
   * (tools/copy-recipe.mjs: palette shift inside the group's bible, one param, the mirror), built and checked with the
   * full kit check at the copy item's own maxSize and, under massingFirst, conformance against the archetype's massing
   * mirrored with it. Up to COPY_RECIPES recipes; when all fail, the job fails with `copy.fallbackReason` and the group
   * makes the item a FALLBACK original. Installed with `derivation: { kind: 'copy', recipe }` (rebuildable from
   * sourceVersion) and the copy item's group, itemKey, ext and request.
   */
  private async runCopy(v: Variant): Promise<void> {
    const cfg = this.host.config;
    const c = v.copy!;
    const plan = (c.plan ?? {}) as { request?: DesignRequest; massing?: { id: string; version: number } };
    const req = plan.request;
    this.step(v.id, `copying ${v.from}`);
    const src = findVariantSource(cfg.libraryDir, cfg.kitDir, v.from);
    const entry = src.entry ?? {};
    const scratch = this.scratch(v.id);
    const bp = freeLibraryId(cfg.libraryDir, `${v.from.slice(0, 40)}_copy`, this.taken);
    this.taken.add(bp);
    try {
      const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(fs.readFileSync(src.sourceFile, 'utf8')), bp));
      const own = path.join(path.dirname(src.sourceFile), 'bible');
      if (!src.bundled && fs.existsSync(own)) fs.cpSync(own, path.join(scratch, 'bible'), { recursive: true });
      if (!v.bible) throw new Error('a copy needs its group\'s bible pin');
      const target = this.host.bibleIndex.resolve(v.bible);
      const bible = JSON.parse(fs.readFileSync(target.files.json, 'utf8')) as { id?: string; version?: number; roles: Record<string, string>; name?: string };
      fs.copyFileSync(target.files.json, path.join(scratch, 'group-bible.json'));
      const values = entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : {};
      const massingFile = plan.massing ? this.host.massingFile?.(plan.massing.id, plan.massing.version) : undefined;
      if (plan.massing && !massingFile) throw new Error(`the archetype's massing ${plan.massing.id} v${plan.massing.version} is gone`);
      const sourceVersion = this.host.entryHead?.(v.from) ?? 1;
      const siblings = this.host.copySiblings?.(c.group, c.archetype, c.ordinal) ?? [];
      const faultText = `${req?.notes ?? ''} ${JSON.stringify(req?.ext ?? {})}`;
      const fault = this.host.simFaults ? (faultText.includes(SIM_COPY_FAIL) ? 'check' : faultText.includes(SIM_COPY_SIZE) ? 'size' : undefined) : undefined;
      const type = typeof entry.type === 'string' ? entry.type : req?.type;
      const profile = Array.isArray(entry.profile) ? (entry.profile as string[]) : undefined;
      let last: { reason: 'size' | 'conformance' | 'check'; problem: string } | undefined;
      for (let attempt = 0; attempt < COPY_RECIPES; attempt++) {
        this.step(v.id, `choosing recipe ${attempt + 1} of ${COPY_RECIPES} for ${c.itemKey}`);
        fs.writeFileSync(path.join(scratch, 'recipe-request.json'), JSON.stringify({ bible: { id: bible.id ?? v.bible.id, version: bible.version ?? v.bible.version, roles: bible.roles }, values, seed: seedOf(c.group, c.archetype), ordinal: c.ordinal, siblings, ...(req?.maxSize ? { max: req.maxSize } : {}), ...(massingFile ? { massing: massingFile } : {}), attempt }));
        const rr = await runNode(path.join(KIT, 'tools', 'copy-recipe.mjs'), [bp, '--in', 'recipe-request.json'], scratch, KIT_TIMEOUT_MS);
        const parsed = parseJsonLine(rr.stdout) as { ok?: boolean; recipe?: CopyRecipe; error?: string } | undefined;
        if (!parsed?.ok || !parsed.recipe) {
          last = { reason: 'check', problem: parsed?.error ?? truncate(rr.output, 600) };
          continue;
        }
        const recipe = parsed.recipe;
        const derived = { id: bible.id ?? v.bible.id, version: bible.version ?? v.bible.version, ...(bible.name ? { name: bible.name } : {}), roles: recipe.roles };
        fs.writeFileSync(path.join(scratch, 'copy-bible.json'), `${JSON.stringify(derived, null, 2)}\n`);
        const extra = ['--bible', 'copy-bible.json', ...(Object.keys(recipe.values ?? {}).length ? ['--values', JSON.stringify(recipe.values)] : []), ...(recipe.mirror ? ['--mirror'] : []), ...(massingFile ? ['--massing', massingFile] : []), '--restraint', 'group-bible.json'];
        this.host.variants.update(v.id, { step: `building ${bp} (recipe ${attempt + 1}: ${recipeLabel(recipe)})`, copy: { ...c, attempts: attempt + 1, recipe: recipeRecord(recipe, v, c) } });
        const res = fault ? simFault(fault) : await checkDesign(cfg.kitDir, scratch, bp, { maxSize: req?.maxSize, type, ...(profile ? { profile } : {}) }, KIT_TIMEOUT_MS, extra);
        if (!res.ok) {
          last = { reason: fault ?? (res.conformance?.errors.length ? 'conformance' : /exceeds the (limit|maximum)|size .* exceeds/.test(res.problem ?? '') ? 'size' : 'check'), problem: res.problem ?? 'the check failed' };
          this.host.log.info(`copy ${v.id} (${c.itemKey}): recipe ${attempt + 1} failed (${last.reason}): ${truncate((res.problem ?? '').split('\n')[0] ?? '', 160)}`);
          continue;
        }
        this.step(v.id, 'rendering previews');
        const r = await renderPreviews(scratch, res.nbt!, KIT_TIMEOUT_MS);
        const sc = res.sidecar!;
        const name = typeof entry.name === 'string' ? entry.name : typeof sc.name === 'string' ? sc.name : v.from;
        const displayName = truncate(`${req?.name ?? name} (copy ${c.ordinal + 1})`, 80);
        const installed = installDesign({
          library: cfg.libraryDir,
          baseId: bp,
          taken: this.othersTaken(bp),
          nbt: res.nbt!,
          sidecar: sc,
          source: design,
          previews: r.files,
          files: fs.existsSync(path.join(scratch, 'bible')) ? ['bible.json', 'bible.md', 'components.mjs'].map((f) => ({ from: path.join(scratch, 'bible', f), to: path.join('bible', f) })) : [],
          meta: {
            name: req?.name ?? name,
            description: typeof entry.description === 'string' ? entry.description : undefined,
            request: req,
            createdAt: this.host.now(),
            extra: {
              variantOf: v.from,
              variantOfVersion: sourceVersion,
              derivation: { source: v.from, sourceVersion, kind: 'copy', recipe: recipeRecord(recipe, v, c) },
              displayName,
              bible: v.bible,
              group: c.group,
              groupItem: c.itemKey,
              ...(isExt(req?.ext) ? { ext: req!.ext } : {}),
              ...(profile ? { profile } : {}),
            },
          },
        });
        this.host.variants.update(v.id, { copy: { ...c, attempts: attempt + 1, recipe: recipeRecord(recipe, v, c) } });
        this.finish(v.id, installed.blueprintId, sc, installed.previews, [`recipe ${attempt + 1}: ${recipeLabel(recipe)}`, r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; '), displayName);
        return;
      }
      const why = last ?? { reason: 'check' as const, problem: 'no recipe' };
      this.host.variants.update(v.id, { status: 'failed', step: `failed: ${COPY_RECIPES} recipes failed (${why.reason}); the item falls back to an original`, error: why.problem, copy: { ...this.host.variants.get(v.id)!.copy!, fallbackReason: why.reason } });
    } finally {
      this.taken.delete(bp);
    }
  }

  /** The palette inputs a design builds with by default (one plain build of it). */
  private async defaultPalette(scratch: string, bp: string): Promise<Record<string, string>> {
    const out = path.join(scratch, 'default');
    const r = await runNode(path.join(KIT, 'build.mjs'), [bp, '--out', out, '--json'], scratch, KIT_TIMEOUT_MS);
    const sc = readJsonFile(path.join(out, `${bp}.blueprint.json`));
    if (!r.ok && !sc) throw new Error(`the source does not build: ${truncate(r.output, 600)}`);
    return isPaletteInputs(sc?.palette) ? (sc!.palette as Record<string, string>) : {};
  }

  private async runImport(v: Variant): Promise<void> {
    const cfg = this.host.config;
    this.step(v.id, 'reading the structure file');
    const file = checkImportPath(v.from, cfg.libraryDir);
    const scratch = this.scratch(v.id);
    const importer = path.join(scratch, KIT, 'import.mjs');
    if (!fs.existsSync(importer)) throw new Error('this kit has no import.mjs');
    const copy = path.join(scratch, 'in', path.basename(file));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    const base = `imp_${slugify(path.basename(file).replace(/\.nbt$/i, ''), 32) || 'structure'}`;
    const bp = freeLibraryId(cfg.libraryDir, base, this.taken);
    this.taken.add(bp);
    try {
      this.step(v.id, `checking ${path.basename(file)}`);
      const out = path.join(scratch, CHECK_DIR);
      fs.rmSync(out, { recursive: true, force: true });
      const args = [copy, '--id', bp, '--out', out, ...(v.name ? ['--name', v.name] : []), '--json'];
      const r = await runNode(path.join(KIT, 'import.mjs'), args, scratch, KIT_TIMEOUT_MS);
      const res = finishCheck(r, out, bp, { type: 'custom' }, KIT_TIMEOUT_MS);
      if (!res.ok) throw new Error(`${path.basename(file)} cannot be imported: ${(res.problem ?? 'the check failed').replace(/^the checker refused the design/, 'the checker refused it')}`);
      this.step(v.id, 'rendering previews');
      const rp = await renderPreviews(scratch, res.nbt!, KIT_TIMEOUT_MS);
      const sc = res.sidecar!;
      // an exported entry (<id>.nbt next to <id>.blueprint.json) brings its ext along
      const ext = readJsonFile(file.replace(/\.nbt$/i, '.blueprint.json'))?.ext;
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: this.othersTaken(bp),
        nbt: res.nbt!,
        sidecar: sc,
        previews: rp.files,
        meta: { createdAt: this.host.now(), extra: { imported: true, ...(isExt(ext) ? { ext } : {}) } },
      });
      this.finish(v.id, installed.blueprintId, sc, installed.previews, [rp.error ? `previews: ${truncate(rp.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} warning(s)` : ''].filter(Boolean).join('; '), typeof sc.name === 'string' ? sc.name : undefined);
    } finally {
      this.taken.delete(bp);
    }
  }

  private finish(id: string, blueprintId: string, sc: SidecarJson, previews: string[], note: string, name: string | undefined): void {
    const s = sc.size!;
    this.host.variants.update(id, {
      status: 'done',
      step: `done: ${blueprintId} (${s.x}x${s.y}x${s.z})${note ? `; ${note}` : ''}`,
      blueprintId,
      size: { x: s.x, y: s.y, z: s.z },
      previews,
      ...(name ? { name } : {}),
    });
  }
}

// ---- re-skins (4b) --------------------------------------------------------------------------------

export const RESKIN_SNAPSHOT_LIMIT = 20;
const RESKIN_KEEP = 100;

/** What a re-skin needs from the sidecar. */
export interface ReskinHost {
  readonly config: Config;
  readonly store: Store;
  readonly variants: VariantBook;
  readonly log: Logger;
  readonly bibleIndex: Pick<BibleIndex, 'resolve'>;
  now(): number;
  emit(m: Outbound): void;
  requestVariant(from: string, palette?: PaletteSpec, values?: ParamValues, name?: string, bible?: BiblePin, reskin?: string): Variant;
  /** a group's finished entries, when the sidecar knows the group */
  groupEntries?(groupId: string): string[] | undefined;
}

/**
 * `reskin.request { bibleId, version?, from: { group | bible (+ bibleVersion) | entries } }`: one variant per library
 * entry of the collection, each built with the bible's roles (free, no Claude; the variant queue), reported as one
 * `reskin.upsert` record that lists the variants and, as they finish, the new entries.
 */
export class Reskins {
  constructor(private host: ReskinHost) {}

  private get all(): Reskin[] {
    return (this.host.store.data.reskins ??= []);
  }

  get(id: string): Reskin | undefined {
    return this.all.find((r) => r.id === id);
  }

  recent(): Reskin[] {
    const tail = this.all.slice(-RESKIN_SNAPSHOT_LIMIT);
    const extra = this.all.filter((r) => r.status === 'building' && !tail.includes(r));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((r) => structuredClone(r));
  }

  start(): void {
    for (const r of this.all.filter((x) => x.status === 'building')) this.refresh(r);
  }

  /** The library entries of a collection (imports and entries without a source are left out). */
  collection(from: ReskinFrom): string[] {
    const lib = this.host.config.libraryDir;
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(lib).filter((d) => /^[a-z0-9_]+$/.test(d)).sort();
    } catch {
      return [];
    }
    // a group the sidecar knows: exactly its items' entries (a crash between an install and the state write could
    // leave a second copy carrying the group)
    const known = from.group ? this.host.groupEntries?.(from.group) : undefined;
    const out: string[] = [];
    for (const id of ids) {
      if (known && from.group && !known.includes(id) && !from.entries?.includes(id) && !from.bible) continue;
      const j = readJsonFile(path.join(lib, id, `${id}.blueprint.json`));
      if (!j || j.imported === true || !fs.existsSync(path.join(lib, id, `${id}.mjs`))) continue;
      const bible = j.bible && typeof j.bible === 'object' ? (j.bible as { id?: unknown; version?: unknown }) : undefined;
      const match =
        (from.entries?.includes(id) ?? false) ||
        (!!from.group && j.group === from.group) ||
        (!!from.bible && bible?.id === from.bible && (from.bibleVersion === undefined || bible?.version === from.bibleVersion));
      if (match) out.push(id);
    }
    return out;
  }

  request(bibleId: string, version: number | undefined, from: ReskinFrom): Reskin {
    const pin = this.host.bibleIndex.resolve(version ? { id: bibleId, version } : bibleId).pin;
    const entries = this.collection(from);
    if (!entries.length) throw new VariantRefused(`the collection ${JSON.stringify(from)} has no library entries with a source`);
    const now = this.host.now();
    const r: Reskin = { id: this.host.store.nextId('r'), bible: pin, from: structuredClone(from), status: 'building', step: `re-skinning ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} with ${pin.id} v${pin.version}`, variants: [], entries: [], done: 0, failed: 0, createdAt: now, updatedAt: now };
    this.all.push(r);
    while (this.all.length > RESKIN_KEEP) {
      const k = this.all.findIndex((x) => x.status !== 'building');
      if (k < 0) break;
      this.all.splice(k, 1);
    }
    for (const e of entries) r.variants.push(this.host.requestVariant(e, undefined, undefined, undefined, pin, r.id).id);
    this.host.store.markDirty();
    this.host.emit({ type: 'reskin.upsert', reskin: structuredClone(r) } as Outbound);
    this.host.log.info(`reskin ${r.id}: ${entries.length} variant(s) with ${pin.id} v${pin.version}`);
    this.refresh(r);
    return r;
  }

  variantChanged(v: Variant): void {
    if (!v.reskin) return;
    const r = this.get(v.reskin);
    if (r) this.refresh(r);
  }

  private refresh(r: Reskin): void {
    const before = JSON.stringify(r);
    const vs = r.variants.map((id) => this.host.variants.get(id));
    r.done = vs.filter((v) => v?.status === 'done').length;
    r.failed = vs.filter((v) => !v || v.status === 'failed').length;
    r.entries = vs.filter((v) => v?.status === 'done' && v.blueprintId).map((v) => v!.blueprintId!);
    if (r.variants.length && r.done + r.failed === r.variants.length) {
      r.status = r.done > 0 ? 'done' : 'failed';
      r.step = `${r.done} re-skinned with ${r.bible.id} v${r.bible.version}${r.failed ? `, ${r.failed} failed` : ''}`;
      if (r.failed) r.error = vs.filter((v) => v?.status === 'failed').map((v) => `${v!.from}: ${(v!.error ?? '').split('\n')[0]}`).join('\n');
    } else r.step = `${r.done + r.failed} of ${r.variants.length} built`;
    if (JSON.stringify(r) !== before) {
      r.updatedAt = this.host.now();
      this.host.store.markDirty();
      this.host.emit({ type: 'reskin.upsert', reskin: structuredClone(r) } as Outbound);
    }
  }
}
