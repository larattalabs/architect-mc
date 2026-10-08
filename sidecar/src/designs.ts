// Building designs (ported from AgentCraft's foreman/src/designs.ts): the design records, and the
// file side of a design job that is the same for every designer (Claude and sim):
//
//   - DesignBook: the designs in state.json, `design.upsert` on every change; a final design
//     (done / failed / cancelled) never changes again, so a cancel can never be overwritten by a
//     job that was still finishing
//   - the scratch dir of a job (docs/CONTRACT.md "Kit CLI"): <data>/designs/<designId>/ with kit/
//     (a fresh copy of the kit), BRIEF.md, CONTRACT.md and remix/ (optional); the agent writes
//     kit/designs/<id>.mjs
//   - checking a built design with a PRISTINE copy of the kit (the agent may have edited its copy),
//     in a child process with a minimal environment (it runs agent-written code)
//   - rendering previews with the kit's renderer
//   - installing the result into the library as <library>/<id>/, never overwriting anything
import fs from 'node:fs';
import path from 'node:path';
import { zeroCost } from './jobs/cost.js';
import type { Store } from './store.js';
import type { Conformance, Design, DesignRequest, DesignStatus, Outbound } from './protocol.js';
import { truncate } from './util/text.js';
import { run } from './util/proc.js';
import { withPathFirst } from './util/env.js';

/** designs listed in the snapshot (queued/running ones always are) */
export const DESIGN_SNAPSHOT_LIMIT = 20;
/** finished designs kept in state.json */
const DESIGN_KEEP = 100;
const FINAL: ReadonlySet<DesignStatus> = new Set(['done', 'failed', 'cancelled']);

export const isFinalDesign = (d: Design): boolean => FINAL.has(d.status);

export type DesignPatch = Partial<Pick<Design, 'status' | 'step' | 'blueprintId' | 'size' | 'previews' | 'error' | 'cost' | 'massing' | 'conformance' | 'critique' | 'critiqueOf'>>;

export interface BookCtx {
  store: Store;
  emit(msg: Outbound): void;
  now(): number;
}

export class DesignBook {
  constructor(private ctx: BookCtx) {}

  private get all(): Design[] {
    return (this.ctx.store.data.designs ??= []);
  }

  list(): Design[] {
    return this.all;
  }

  get(id: string): Design | undefined {
    return this.all.find((d) => d.id === id);
  }

  /** queued or running */
  active(): Design[] {
    return this.all.filter((d) => !isFinalDesign(d));
  }

  /** what the snapshot carries: the last DESIGN_SNAPSHOT_LIMIT plus every unfinished one, oldest first */
  recent(): Design[] {
    const tail = this.all.slice(-DESIGN_SNAPSHOT_LIMIT);
    const extra = this.active().filter((d) => !tail.includes(d));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((d) => structuredClone(d));
  }

  /** A new queued design; `massing` (4c) marks a massing job and the massing version it makes. */
  create(request: DesignRequest, massing?: Design['massing']): Design {
    const now = this.ctx.now();
    const d: Design = { id: this.ctx.store.nextId('d'), request: structuredClone(request), status: 'queued', step: 'waiting for the designer', cost: zeroCost(), ...(massing ? { massing: { ...massing } } : {}), createdAt: now, updatedAt: now };
    this.all.push(d);
    this.trim();
    this.ctx.store.markDirty();
    this.ctx.emit({ type: 'design.upsert', design: structuredClone(d) });
    return d;
  }

  /** Patch and broadcast. A final design is never changed (returns it unchanged). */
  update(id: string, patch: DesignPatch): Design | undefined {
    const d = this.get(id);
    if (!d || isFinalDesign(d)) return d;
    let changed = false;
    for (const [k, v] of Object.entries(patch) as Array<[keyof DesignPatch, unknown]>) {
      if (v === undefined) continue;
      const val = k === 'step' || k === 'error' ? truncate(String(v).replace(/\s+/g, ' ').trim(), k === 'step' ? 120 : 1500) : v;
      if (JSON.stringify(d[k]) !== JSON.stringify(val)) {
        (d as Record<string, unknown>)[k] = val;
        changed = true;
      }
    }
    if (changed) {
      d.updatedAt = this.ctx.now();
      this.ctx.store.markDirty();
      this.ctx.emit({ type: 'design.upsert', design: structuredClone(d) });
    }
    return d;
  }

  private trim(): void {
    const all = this.all;
    while (all.length > DESIGN_KEEP) {
      const i = all.findIndex((d) => isFinalDesign(d));
      if (i < 0) break;
      all.splice(i, 1);
    }
  }
}

// ---- naming -----------------------------------------------------------------------------------

/** "Lakeside Cabin" -> "lakeside_cabin" (library ids are [a-z0-9_]+). */
export function slugify(s: string, max = 32): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // "é" -> "e" + a combining mark: keep the letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
}

/**
 * The base library id for a request: gen_<slug of the name>, else gen_<style>_<type> ("gen_rustic_cabin").
 * Always `gen_`-prefixed, so a generated id never equals a bundled example's (cabin, tower, ...).
 */
export function designBaseId(req: DesignRequest): string {
  const fromName = req.name ? slugify(req.name) : '';
  if (fromName) return `gen_${fromName}`;
  const type = req.type === 'custom' ? 'building' : req.type;
  const style = slugify(req.style, 20);
  const slug = slugify(style && style !== type ? `${style}_${type}` : type);
  return `gen_${slug || 'building'}`;
}

/** `base`, `base_2`, `base_3`, ...: the first id with no folder in the library and not in `taken`. */
export function freeLibraryId(library: string, base: string, taken: ReadonlySet<string> = new Set()): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}_${n}`;
    if (taken.has(id)) continue;
    if (fs.existsSync(path.join(library, id))) continue;
    return id;
  }
}

// ---- the sidecar JSON -------------------------------------------------------------------------

export interface Sidecar {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  size?: { x: number; y: number; z: number };
  [k: string]: unknown;
}

/** What a built design is checked against: the request's maximum size (none for a variant) and type. */
export interface Limits {
  maxSize?: DesignRequest['maxSize'] | undefined;
  type?: string | undefined;
  /** (4b, open types) the checker profile the request asked for (`--profile`) */
  profile?: string[] | undefined;
}

/** Does the built blueprint fit the request? (undefined = yes, else why not) */
export function sidecarProblem(sc: Sidecar, limits: Limits): string | undefined {
  const s = sc.size;
  if (!s || ![s.x, s.y, s.z].every((n) => Number.isInteger(n) && n > 0)) return 'the sidecar has no valid size';
  const m = limits.maxSize;
  if (m && (s.x > m.x || s.y > m.y || s.z > m.z)) return `size ${s.x}x${s.y}x${s.z} exceeds the maximum ${m.x}x${m.y}x${m.z} (x*y*z); make it smaller`;
  if (limits.type && sc.type !== limits.type) return `type is "${String(sc.type)}" but the request is for a ${limits.type}`;
  return undefined;
}

// ---- running the kit --------------------------------------------------------------------------

/** The kit inside a scratch dir, and where its outputs go. */
export const KIT = 'kit';
export const CHECK_DIR = 'check';
export const PREVIEW_DIR = 'previews';

/** An environment with nothing secret in it, for running agent-written code. */
export function minimalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT', 'windir', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  // the node running us comes first (Minecraft starts the sidecar with a minimal PATH)
  return withPathFirst(env, path.dirname(process.execPath)) as NodeJS.ProcessEnv;
}

export interface NodeRun {
  ok: boolean;
  code: number;
  stdout: string;
  output: string;
  timedOut: boolean;
}

/** Run a kit script with this node, in a minimal environment. */
export async function runNode(script: string, args: string[], cwd: string, timeoutMs: number): Promise<NodeRun> {
  try {
    const r = await run(process.execPath, [script, ...args], { cwd, env: minimalEnv(), timeoutMs });
    return { ok: r.code === 0 && !r.timedOut, code: r.code, stdout: r.stdout, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim(), timedOut: r.timedOut };
  } catch (e) {
    return { ok: false, code: -1, stdout: '', output: (e as Error).message, timedOut: false };
  }
}

/** The last lines of a tool's output, for an error message. */
export function outputTail(text: string, lines = 12, max = 1200): string {
  return truncate(text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n'), max);
}

const SKIP_IN_KIT = /(^|[\\/])(node_modules|\.git|out)([\\/]|$)/;

/**
 * Copy the kit (every file but node_modules, .git and out/) from `kitSrc` into `<scratch>/kit`,
 * replacing whatever is there, except the design modules listed in `keep` (designs/<id>.mjs).
 */
export function refreshKit(kitSrc: string, scratch: string, keep: string[] = []): void {
  const dst = path.join(scratch, KIT);
  const saved = new Map<string, Buffer>();
  for (const id of keep) {
    const f = path.join(dst, 'designs', `${id}.mjs`);
    if (fs.existsSync(f)) saved.set(id, fs.readFileSync(f));
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(kitSrc, dst, { recursive: true, filter: (p) => !SKIP_IN_KIT.test(path.relative(kitSrc, p)) });
  fs.mkdirSync(path.join(dst, 'designs'), { recursive: true });
  for (const [id, buf] of saved) fs.writeFileSync(path.join(dst, 'designs', `${id}.mjs`), buf);
}

export function rendererIn(scratch: string): string | undefined {
  const r = path.join(scratch, KIT, 'render.mjs');
  return fs.existsSync(r) ? r : undefined;
}

/** `export const id = '<old>'` -> the new id (a design module names its own id). */
export function withDesignId(source: string, id: string): string {
  return source.replace(/export\s+const\s+id\s*=\s*(['"`])[^'"`]*\1/, `export const id = '${id}'`);
}

export interface CheckResult {
  ok: boolean;
  /** what to tell the designer / the user when not ok */
  problem?: string;
  output: string;
  warnings: string[];
  sidecar?: Sidecar;
  nbt?: string;
  json?: string;
  /** (4c) a detail pass: the kit's massing conformance result (`--massing`), when it printed one */
  conformance?: Conformance;
  /** (5a) the kit's metrics (accentShare, detailNoise, windowsPerFacade, paletteAdherence, parts, ...), when it printed them */
  metrics?: Record<string, unknown>;
}

/** The kit's `--json` line (`{ ok, errors[], warnings[], nbt, sidecar }`), if it printed one. */
export function parseBuildJson(stdout: string): { ok?: boolean; errors: string[]; warnings: string[]; conformance?: Conformance; metrics?: Record<string, unknown> } | undefined {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as { ok?: unknown; errors?: unknown; warnings?: unknown; conformance?: unknown; metrics?: unknown };
      const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
      const c = j.conformance && typeof j.conformance === 'object' ? (j.conformance as Record<string, unknown>) : undefined;
      // (4c) `conformance: { ok, errors[], issues[] }` (warnings is accepted for issues)
      const conformance = c ? { ok: c.ok !== false && !list(c.errors).length, errors: list(c.errors), issues: list(c.issues ?? c.warnings) } : undefined;
      const metrics = j.metrics && typeof j.metrics === 'object' && !Array.isArray(j.metrics) ? (j.metrics as Record<string, unknown>) : undefined;
      return { ...(typeof j.ok === 'boolean' ? { ok: j.ok } : {}), errors: list(j.errors), warnings: list(j.warnings), ...(conformance ? { conformance } : {}), ...(metrics ? { metrics } : {}) };
    } catch {
      /* not it */
    }
  }
  return undefined;
}

/**
 * Build kit/designs/<bp>.mjs with a pristine kit and check it (`node kit/build.mjs <bp> --out check
 * [--max x,y,z] [--type <t>] [extra args] --json`), then the size and type against the request. The
 * exit code and the files on disk decide; the JSON line only supplies the error and warning text.
 * `extra` carries a variant's `--palette` / `--values`.
 */
export async function checkDesign(kitSrc: string, scratch: string, bp: string, limits: Limits, timeoutMs = 120_000, extra: string[] = []): Promise<CheckResult> {
  const rel = `${KIT}/designs/${bp}.mjs`;
  if (!fs.existsSync(path.join(scratch, KIT, 'designs', `${bp}.mjs`))) return { ok: false, problem: `there is no ${rel}`, output: '', warnings: [] };
  refreshKit(kitSrc, scratch, [bp]);
  const out = path.join(scratch, CHECK_DIR);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const m = limits.maxSize;
  const args = [bp, '--out', out, ...(m ? ['--max', `${m.x},${m.y},${m.z}`] : []), ...(limits.type ? ['--type', limits.type] : []), ...(limits.profile?.length ? ['--profile', limits.profile.join(',')] : []), ...extra, '--json'];
  return finishCheck(await runNode(path.join(KIT, 'build.mjs'), args, scratch, timeoutMs), out, bp, limits, timeoutMs);
}

/**
 * The common end of a kit build or import run: the exit code and the files on disk decide, the JSON
 * line supplies the error and warning text.
 */
export function finishCheck(r: NodeRun, out: string, bp: string, limits: Limits, timeoutMs: number): CheckResult {
  const j = parseBuildJson(r.stdout);
  const warnings = j?.warnings ?? [];
  const conf = { ...(j?.conformance ? { conformance: j.conformance } : {}), ...(j?.metrics ? { metrics: j.metrics } : {}) };
  const nbt = path.join(out, `${bp}.nbt`);
  const json = path.join(out, `${bp}.blueprint.json`);
  if (!r.ok) {
    if (r.timedOut) return { ok: false, problem: `build.mjs timed out after ${timeoutMs / 1000}s`, output: r.output, warnings, ...conf };
    const what = r.code === 1 ? 'the checker refused the design' : 'the kit failed (the design threw, or bad usage)';
    const errs = [...(j?.errors ?? []), ...(j?.conformance?.errors ?? []).filter((e) => !j!.errors.includes(e))];
    const detail = errs.length ? errs.map((e) => `- ${e}`).join('\n') : outputTail(r.output);
    return { ok: false, problem: `${what}:\n${truncate(detail, 1500)}`, output: r.output, warnings, ...conf };
  }
  if (!fs.existsSync(nbt) || !fs.existsSync(json)) return { ok: false, problem: `the kit did not write ${bp}.nbt and ${bp}.blueprint.json`, output: r.output, warnings, ...conf };
  let sc: Sidecar;
  try {
    sc = JSON.parse(fs.readFileSync(json, 'utf8')) as Sidecar;
  } catch (e) {
    return { ok: false, problem: `the sidecar is not valid JSON: ${(e as Error).message}`, output: r.output, warnings, ...conf };
  }
  const p = sidecarProblem(sc, limits);
  if (p) return { ok: false, problem: p, output: r.output, warnings, sidecar: sc, ...conf };
  return { ok: true, output: r.output, warnings, sidecar: sc, nbt, json, ...conf };
}

/**
 * Render previews of `nbt` into <scratch>/previews with the renderer of a pristine kit, if the kit
 * has one. Returns the PNGs (named <id>.preview-<view>.png), or an error.
 */
export async function renderPreviews(scratch: string, nbt: string, timeoutMs = 120_000): Promise<{ files: string[]; error?: string; skipped?: boolean }> {
  const renderer = rendererIn(scratch);
  if (!renderer) return { files: [], skipped: true };
  const out = path.join(scratch, PREVIEW_DIR);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const r = await runNode(path.relative(scratch, renderer), [nbt, '--out', out], scratch, timeoutMs);
  const files = fs
    .readdirSync(out)
    .filter((f) => /\.preview-[a-z0-9_-]+\.png$/i.test(f))
    .sort()
    .map((f) => path.join(out, f));
  if (!r.ok) return { files, error: r.timedOut ? 'the renderer timed out' : outputTail(r.output, 6, 400) };
  return { files };
}

// ---- installing -------------------------------------------------------------------------------

/** (5b) `<base>.parts.nbt` next to `<base>.nbt` (the kit writes both). */
export function partsFileOf(nbt: string): string {
  return nbt.replace(/\.nbt$/i, '.parts.nbt');
}

/** (5b) Copy `<base>.parts.nbt` next to a copied template, when the source has one (tolerates none). */
export function copyPartsAlong(fromNbt: string, toNbt: string): void {
  const src = partsFileOf(fromNbt);
  if (fs.existsSync(src)) fs.copyFileSync(src, partsFileOf(toNbt));
}

export interface InstallInput {
  library: string;
  baseId: string;
  /** ids other jobs are about to use */
  taken?: ReadonlySet<string>;
  nbt: string;
  /** (5b) the per-cell part map (default: <nbt base>.parts.nbt next to `nbt`, when it exists) */
  parts?: string | undefined;
  sidecar: Sidecar;
  /** the design's .mjs source (its `export const id` is rewritten to the installed id); none for an import */
  source?: string | undefined;
  /** preview PNGs named <anything>.preview-<view>.png */
  previews: string[];
  /** (4b) more files for the entry folder: `to` relative to it (`bible/components.mjs`: the design's bible files) */
  files?: Array<{ from: string; to: string }> | undefined;
  /** written into the sidecar JSON (`extra`: variantOf, displayName, imported, ...) */
  meta: { name?: string | undefined; description?: string | undefined; request?: DesignRequest | undefined; createdAt: number; extra?: Record<string, unknown> };
}

export interface Installed {
  blueprintId: string;
  dir: string;
  nbt: string;
  json: string;
  source?: string;
  previews: string[];
}

/**
 * Install a built design as <library>/<id>/ under a fresh id (`baseId`, `baseId_2`, ...). Never
 * overwrites anything: the folder is created exclusively (an existing one moves on to the next id)
 * and every file in it with O_EXCL. The sidecar JSON is written last (the mod lists a design by it).
 */
export function installDesign(input: InstallInput): Installed {
  fs.mkdirSync(input.library, { recursive: true });
  const tried = new Set(input.taken ?? []);
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = freeLibraryId(input.library, input.baseId, tried);
    tried.add(id);
    const dir = path.join(input.library, id);
    try {
      fs.mkdirSync(dir); // not recursive: EEXIST if someone made it meanwhile
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw e;
    }
    try {
      const nbt = path.join(dir, `${id}.nbt`);
      fs.copyFileSync(input.nbt, nbt, fs.constants.COPYFILE_EXCL);
      // (5b) the per-cell part map travels with the template (none for an import or a pre-5b build)
      const parts = input.parts ?? partsFileOf(input.nbt);
      if (parts && fs.existsSync(parts)) fs.copyFileSync(parts, path.join(dir, `${id}.parts.nbt`), fs.constants.COPYFILE_EXCL);
      let source: string | undefined;
      if (input.source) {
        source = path.join(dir, `${id}.mjs`);
        fs.writeFileSync(source, withDesignId(fs.readFileSync(input.source, 'utf8'), id), { flag: 'wx' });
      }
      const previews: string[] = [];
      for (const p of input.previews) {
        const view = /\.preview-([a-z0-9_-]+)\.png$/i.exec(p)?.[1];
        if (!view) continue;
        const dst = path.join(dir, `${id}.preview-${view.toLowerCase()}.png`);
        fs.copyFileSync(p, dst, fs.constants.COPYFILE_EXCL);
        previews.push(dst);
      }
      for (const f of input.files ?? []) {
        const rel = path.normalize(f.to);
        if (path.isAbsolute(rel) || rel.startsWith('..')) throw new Error(`install: ${f.to} is outside the entry folder`);
        if (!fs.existsSync(f.from)) continue;
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.copyFileSync(f.from, path.join(dir, rel), fs.constants.COPYFILE_EXCL);
      }
      const json = path.join(dir, `${id}.blueprint.json`);
      const m = input.meta;
      const sidecar: Record<string, unknown> = {
        ...input.sidecar,
        id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.description ? { description: m.description } : {}),
        createdAt: m.createdAt,
        ...(m.request ? { request: m.request } : {}),
        ...(m.extra ?? {}),
      };
      if (source) sidecar.source = `${id}.mjs`;
      else delete sidecar.source;
      // the mod's user metadata is never written here (docs/CONTRACT.md "Library entry"), only `displayName` as a starting name
      for (const k of ['favorite', 'userTags']) delete sidecar[k];
      if (!(m.extra && 'displayName' in m.extra)) delete sidecar.displayName;
      fs.writeFileSync(json, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: 'wx' });
      return { blueprintId: id, dir, nbt, json, ...(source ? { source } : {}), previews };
    } catch (e) {
      // the folder is ours (created exclusively above): take it back out
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  throw new Error(`could not find a free library id for ${input.baseId} in ${input.library}`);
}

/** One line describing a request, for the log. */
export function describeRequest(req: DesignRequest): string {
  const what = `${req.style} ${req.type}`;
  return `${req.name ? `"${req.name}" (${what})` : what}, max ${req.maxSize.x}x${req.maxSize.y}x${req.maxSize.z}`;
}
