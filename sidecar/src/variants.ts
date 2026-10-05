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
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './context.js';
import type { Config } from './config.js';
import { checkDesign, finishCheck, freeLibraryId, installDesign, KIT, CHECK_DIR, refreshKit, renderPreviews, runNode, slugify, withDesignId, type Sidecar as SidecarJson } from './designs.js';
import type { DesignRequest, Outbound, PaletteSpec, ParamValues, Variant, VariantStatus } from './protocol.js';
import type { Store } from './store.js';
import { truncate } from './util/text.js';

export const VARIANT_SNAPSHOT_LIMIT = 20;
const VARIANT_KEEP = 100;
const FINAL: ReadonlySet<VariantStatus> = new Set(['done', 'failed']);
/** per kit child process (a variant is seconds, not minutes) */
const KIT_TIMEOUT_MS = 120_000;

export const isFinalVariant = (v: Variant): boolean => FINAL.has(v.status);

/** A request the client can fix (answered with ack ok:false and the reason). */
export class VariantRefused extends Error {}

// ---- the book ---------------------------------------------------------------------------------

export type VariantPatch = Partial<Pick<Variant, 'status' | 'step' | 'blueprintId' | 'size' | 'previews' | 'error'>>;

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

  create(fields: Pick<Variant, 'kind' | 'from'> & Partial<Pick<Variant, 'palette' | 'values' | 'name'>>): Variant {
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
      this.ctx.store.markDirty();
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
  const kitSrc = path.join(kitDir, 'designs', `${from}.mjs`);
  if (fs.existsSync(kitSrc)) {
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

/** The palette to build with: a preset string as asked, or palette inputs over the entry's recorded ones. */
export function mergePalette(recorded: unknown, asked: PaletteSpec | undefined): PaletteSpec | undefined {
  if (asked === undefined) return isPaletteInputs(recorded) ? recorded : undefined;
  if (typeof asked === 'string') return asked;
  return { ...(isPaletteInputs(recorded) ? recorded : {}), ...asked };
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
export function variantId(libraryDir: string, from: string, palette: PaletteSpec | undefined, taken: ReadonlySet<string> = new Set()): string {
  const sfx = typeof palette === 'string' ? slugify(palette, 20) : palette ? slugify((palette.wood ?? palette.stone ?? palette.roof ?? palette.accent ?? palette.preset ?? '').replace(/^minecraft:/, ''), 20) : '';
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
export function importRoots(libraryDir: string): { imports: string; saves: string } {
  const architect = path.dirname(libraryDir);
  return { imports: path.join(architect, 'imports'), saves: path.join(path.dirname(architect), 'saves') };
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
  const allowed = `an .nbt file in ${roots.imports}${path.sep} or in a world's ${path.join('saves', '<world>', 'generated', '<namespace>', 'structures')}${path.sep}`;
  const refuse = (why: string): never => {
    throw new VariantRefused(`import refused: ${why}. Architect imports only ${allowed}`);
  };
  if (!path.isAbsolute(p)) refuse(`"${p}" is not an absolute path`);
  if (!/\.nbt$/i.test(p)) refuse(`"${path.basename(p)}" is not an .nbt file`);
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
  if (inside(real(roots.imports))) return file;
  const parts = inside(real(roots.saves));
  // <world>/generated/<namespace>/structures/<...>.nbt
  if (parts && parts.length >= 5 && parts[1] === 'generated' && parts[3] === 'structures') return file;
  return refuse(`${p} is outside those folders`);
}

// ---- the runner ---------------------------------------------------------------------------------

/** What the runner needs from the sidecar. */
export interface VariantHost {
  readonly config: Config;
  readonly variants: VariantBook;
  readonly log: Logger;
  now(): number;
}

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
    const bp = variantId(cfg.libraryDir, v.from, v.palette, this.taken);
    this.taken.add(bp);
    try {
      const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
      fs.writeFileSync(design, withDesignId(normalizeKitImports(fs.readFileSync(src.sourceFile, 'utf8')), bp));
      let palette = mergePalette(entry.palette, v.palette);
      if (palette !== undefined && typeof palette !== 'string' && !isPaletteInputs(entry.palette) && !palette.preset) {
        // an entry without a recorded palette (built before phase 2): start from the design's own default
        palette = { ...(await this.defaultPalette(scratch, bp)), ...palette };
      }
      const baseValues = entry.values && typeof entry.values === 'object' ? (entry.values as Record<string, unknown>) : {};
      const values = { ...baseValues, ...(v.values ?? {}) };
      const type = typeof entry.type === 'string' ? entry.type : undefined;
      this.step(v.id, `building ${bp} and checking it`);
      const extra = [
        ...(palette !== undefined ? ['--palette', typeof palette === 'string' ? palette : JSON.stringify(palette)] : []),
        ...(Object.keys(values).length ? ['--values', JSON.stringify(values)] : []),
      ];
      const res = await checkDesign(cfg.kitDir, scratch, bp, { type }, KIT_TIMEOUT_MS, extra);
      if (!res.ok) throw new Error(`the variant did not pass: ${res.problem ?? 'the check failed'}`);
      this.step(v.id, 'rendering previews');
      const r = await renderPreviews(scratch, res.nbt!, KIT_TIMEOUT_MS);
      const sc = res.sidecar!;
      const name = typeof entry.name === 'string' ? entry.name : typeof sc.name === 'string' ? sc.name : v.from;
      const displayName = v.name ?? variantDisplayName(name, { palette: v.palette, values: v.values, baseValues, params: sc.params as Record<string, ParamDecl> | undefined });
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: this.othersTaken(bp),
        nbt: res.nbt!,
        sidecar: sc,
        source: design,
        previews: r.files,
        meta: {
          name,
          description: typeof entry.description === 'string' ? entry.description : undefined,
          request: entry.request && typeof entry.request === 'object' ? (entry.request as DesignRequest) : undefined,
          createdAt: this.host.now(),
          extra: { variantOf: v.from, displayName },
        },
      });
      this.finish(v.id, installed.blueprintId, sc, installed.previews, [r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; '));
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
      const installed = installDesign({
        library: cfg.libraryDir,
        baseId: bp,
        taken: this.othersTaken(bp),
        nbt: res.nbt!,
        sidecar: sc,
        previews: rp.files,
        meta: { createdAt: this.host.now(), extra: { imported: true } },
      });
      this.finish(v.id, installed.blueprintId, sc, installed.previews, [rp.error ? `previews: ${truncate(rp.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} warning(s)` : ''].filter(Boolean).join('; '));
    } finally {
      this.taken.delete(bp);
    }
  }

  private finish(id: string, blueprintId: string, sc: SidecarJson, previews: string[], note: string): void {
    const s = sc.size!;
    this.host.variants.update(id, {
      status: 'done',
      step: `done: ${blueprintId} (${s.x}x${s.y}x${s.z})${note ? `; ${note}` : ''}`,
      blueprintId,
      size: { x: s.x, y: s.y, z: s.z },
      previews,
    });
  }
}
