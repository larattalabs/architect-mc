// The sim designer (no Claude), ported from AgentCraft's agents/sim/designer.ts, for tests and
// offline UI work. A job walks through a few fake progress steps, then takes a kit example
// (kit/designs/<type>.mjs if there is one, else cabin.mjs) as its "design" under the new id and
// runs it through the real pipeline: the scratch dir, the pristine-kit check (`kit/build.mjs` in a
// child process), the renderer and the never-overwrite install into the library.
//
// Phase 4b: it runs as many designs at once as the pool hands it. A design with a bible builds the
// example under the bible's roles (`--bible bible/bible.json`); an open type is written into the
// copy (type and profile). `simDesignUsd` (config) is the cost each step reports, so budgets can be
// tested. A request whose notes contain `sim:usage_limit` hits a usage limit once (it lasts
// `simLimitMs`): every design holds (the running ones stop at their next step and go back to the
// front of their lane) and all resume together after the reset.
//
// Phase 4c: a massing job installs the kit's example massing for the type (kit/massings/<type>_massing.mjs, else the
// cabin's, else the type's design example), with the requested type written in (the massing profile has no type rules).
// A redirect starts from the previous version and changes it: the first int param's default goes up by one (the fixture
// massing grows a wing), else the first gable roof becomes a hip (a visibly different silhouette, still within the
// example's size). A detail pass builds the type's design example with --massing, so the example pairs conform.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSdk } from './claude/sdk.js';
import { zeroCost } from './jobs/cost.js';
import { checkDesign, designBaseId, freeLibraryId, isFinalDesign, KIT, renderPreviews, withDesignId } from './designs.js';
import type { Design } from './protocol.js';
import { BUILDING_TYPES } from './protocol.js';
import { prepareScratch } from './scratch.js';
import type { Designer, RunOutcome, Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';
import { runNode } from './designs.js';
import { simToken, type PolishBackend, type PolishTurnResult } from './polish.js';

const STEPS: Array<{ status: 'designing'; step: string }> = [
  { status: 'designing', step: 'reading the brief' },
  { status: 'designing', step: 'sketching the floor plan' },
  { status: 'designing', step: 'raising the walls and the roof' },
];

/** A request asks the sim to hit a usage limit (once). */
export const SIM_LIMIT_MARK = 'sim:usage_limit';

/** (6c 0a) The ext key that scripts sim faults, as the notes' `sim:<fault>` tokens do: a string or an array of strings. */
export const SIM_EXT = 'architect:sim';

/**
 * (6c 0a) The sim faults a request asks for: `sim:<name>` tokens in its notes, and the names in ext["architect:sim"] (a
 * string or an array of strings, with or without the `sim:` prefix). Known names: usage_limit (one usage limit), fail (the
 * design fails), repair (one repair round).
 */
export function simFaults(req: { notes?: string | undefined; ext?: Record<string, unknown> | undefined }): Set<string> {
  const out = new Set<string>();
  for (const m of (req.notes ?? '').matchAll(/(?:^|[^A-Za-z0-9_])sim:([a-z_]+)(?![A-Za-z0-9_=])/g)) out.add(m[1]!);
  const e = req.ext?.[SIM_EXT];
  for (const v of Array.isArray(e) ? e : [e]) if (typeof v === 'string' && v.trim()) out.add(v.trim().replace(/^sim:/, ''));
  return out;
}

/** (6c 0a) The sim's round state of one design (DesignWork.sim). */
export interface SimRoundWork {
  /** 1 = the first design round, 2 = the repair round */
  round: number;
  /** what the round has charged so far (simCosts) */
  charged: number;
  /** sim:repair's round is done */
  repaired?: boolean;
}

class Cancelled extends Error {}
class Limited extends Error {}

/** The kit example a sim job copies for a request type. */
export function simSource(kitDir: string, type: string): string | undefined {
  const has = (id: string) => fs.existsSync(path.join(kitDir, 'designs', `${id}.mjs`));
  if (has(type)) return type;
  if (has('cabin')) return 'cabin';
  return undefined;
}

/** The kit's example massing for a type (massings/<type>_massing.mjs, else the cabin's, else the first), as a path. */
export function simMassingSource(kitDir: string, type: string): string | undefined {
  const dir = path.join(kitDir, 'massings');
  for (const f of [`${type}_massing.mjs`, `${type}.mjs`, 'cabin_massing.mjs', 'cabin.mjs']) if (fs.existsSync(path.join(dir, f))) return path.join(dir, f);
  const any = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()[0] : undefined;
  return any ? path.join(dir, any) : undefined;
}

// ---- (6c 0a) fitting the request's maxSize ------------------------------------------------------------------

type Size3 = { x: number; y: number; z: number };
type ParamSpec = { type: string; min?: number; max?: number; default?: unknown; options?: unknown[] };
interface Built {
  size: Size3;
  front?: string;
  anchors?: { entrance?: { x: number; y: number; z: number; yaw?: number }; spawn?: { x: number; y: number; z: number; yaw?: number } };
}
interface KitModule {
  params?: Record<string, ParamSpec>;
  default: (values?: Record<string, unknown>) => Built;
}
const fits = (s: Size3, m: Size3) => s.x <= m.x && s.y <= m.y && s.z <= m.z;

async function loadKitModule(file: string): Promise<KitModule> {
  // a fresh copy each time is not needed: the kit examples are fixed for the sidecar's life
  return (await import(pathToFileURL(file).href)) as KitModule;
}

/** Every combination of a design's params (ints over their range, bools both ways, enums their options), defaults first. */
function paramCombos(params: Record<string, ParamSpec>): Array<Record<string, unknown>> {
  let out: Array<Record<string, unknown>> = [{}];
  for (const [k, sp] of Object.entries(params)) {
    let vals: unknown[];
    if (sp.type === 'int' && Number.isInteger(sp.min) && Number.isInteger(sp.max)) vals = Array.from({ length: sp.max! - sp.min! + 1 }, (_, i) => sp.max! - i);
    else if (sp.type === 'bool') vals = [true, false];
    else if (sp.type === 'enum' && Array.isArray(sp.options)) vals = sp.options;
    else vals = [sp.default];
    vals = [sp.default, ...vals.filter((v) => v !== sp.default)];
    const next: Array<Record<string, unknown>> = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next.slice(0, 4096);
  }
  return out;
}

/**
 * (6c 0a) The kit example (and its param values) the sim builds for a request of `type` within `maxSize`: the type's own example
 * at its defaults when that fits (as before), else the combination of its params with the largest footprint that fits, else the
 * other examples the same way. Undefined when nothing in the kit fits (the request then fails as before, with the checker's reason).
 */
export async function simFit(kitDir: string, type: string, maxSize: Size3 | undefined): Promise<{ src: string; values: Record<string, unknown>; built: Built; changed: boolean } | undefined> {
  const dir = path.join(kitDir, 'designs');
  const own = simSource(kitDir, type);
  const order = [...new Set([...(own ? [own] : []), ...(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).sort() : [])])];
  for (const src of order) {
    let mod: KitModule;
    try {
      mod = await loadKitModule(path.join(dir, `${src}.mjs`));
    } catch {
      continue;
    }
    const defaults = Object.fromEntries(Object.entries(mod.params ?? {}).map(([k, v]) => [k, v.default]));
    let best: { values: Record<string, unknown>; built: Built; area: number; changes: number } | undefined;
    for (const combo of paramCombos(mod.params ?? {})) {
      let built: Built;
      try {
        built = mod.default({ ...combo });
      } catch {
        continue;
      }
      if (maxSize && !fits(built.size, maxSize)) continue;
      const changes = Object.keys(combo).filter((k) => combo[k] !== defaults[k]).length;
      if (changes === 0) return { src, values: combo, built, changed: src !== own };
      const area = built.size.x * built.size.z;
      if (!best || area > best.area || (area === best.area && changes < best.changes)) best = { values: combo, built, area, changes };
    }
    if (best) return { src, values: best.values, built: best.built, changed: true };
  }
  return undefined;
}

/** A design source with its params' defaults (the params block and the build() signature) set to `values`. */
export function withDefaults(source: string, values: Record<string, unknown>): string {
  let out = source;
  for (const [k, v] of Object.entries(values)) {
    const lit = typeof v === 'string' ? `'${v}'` : String(v);
    out = out.replace(new RegExp(`(\\b${k}\\s*:\\s*\\{[^}]*?default:\\s*)('[^']*'|-?\\d+|true|false)`), `$1${lit}`);
    out = out.replace(new RegExp(`(\\b${k}\\s*=\\s*)('[^']*'|-?\\d+|true|false)(\\s*[,}])`), `$1${lit}$3`);
  }
  return out;
}

/** The size of a kit example massing at its defaults (undefined when it can't be built here). */
async function massingSize(file: string): Promise<Size3 | undefined> {
  try {
    return (await loadKitModule(file)).default().size;
  } catch {
    return undefined;
  }
}

/**
 * (6c 0a) A stand-in massing for a request the kit's example massings don't fit: one box, as large as the fitted detail (so the
 * detail conforms: size, front, entrance), under the massing profile. Its source has no params (a redirect changes nothing).
 */
export function standInMassing(bp: string, type: string, d: Built): string {
  const s = d.size;
  const e = d.anchors?.entrance;
  const front = (d.front ?? 'south').toLowerCase();
  const ex = Math.max(1, Math.min(s.x - 2, Math.floor(e?.x ?? s.x / 2)));
  const ez = Math.max(1, Math.min(s.z - 2, Math.floor(e?.z ?? s.z - 1)));
  const yaw = e?.yaw ?? (front === 'north' ? 0 : front === 'east' ? 270 : front === 'west' ? 90 : 180);
  const h = Math.max(3, s.y - 1);
  // the box stops one row short of the entrance (the entrance and the spawn stand outside it, as the detail's do); the door faces it
  const box =
    front === 'south' ? [0, 0, 0, s.x - 1, h, Math.max(2, ez - 1)]
    : front === 'north' ? [0, 0, Math.min(s.z - 3, ez + 1), s.x - 1, h, s.z - 1]
    : front === 'east' ? [0, 0, 0, Math.max(2, ex - 1), h, s.z - 1]
    : [Math.min(s.x - 3, ex + 1), 0, 0, s.x - 1, h, s.z - 1];
  const door = front === 'east' || front === 'west' ? [ez, 1] : [ex, 1];
  // the path from the door to the template's edge (the template's extents are the declared size)
  const path0 =
    front === 'south' ? [Math.max(0, ex - 1), box[5]! + 1, Math.min(s.x - 1, ex + 1), s.z - 1]
    : front === 'north' ? [Math.max(0, ex - 1), 0, Math.min(s.x - 1, ex + 1), box[2]! - 1]
    : front === 'east' ? [box[3]! + 1, Math.max(0, ez - 1), s.x - 1, Math.min(s.z - 1, ez + 1)]
    : [0, Math.max(0, ez - 1), box[0]! - 1, Math.min(s.z - 1, ez + 1)];
  const sp = d.anchors?.spawn;
  const sx = Math.max(0, Math.min(s.x - 1, Math.floor(sp?.x ?? ex)));
  const sz = Math.max(0, Math.min(s.z - 1, Math.floor(sp?.z ?? s.z - 1)));
  return `// A stand-in massing (the sim, 6c 0a): one box the size of the fitted kit example, for a request its example massings exceed.
import { Blueprint, PALETTES } from '../lib/kit.mjs';
import { massing } from '../lib/massing.mjs';

export const id = '${bp}';

export default function build({ palette: p = PALETTES.rustic } = {}) {
  const bp = new Blueprint({ id, name: 'Stand-in massing', type: '${type}', size: [${s.x}, ${s.y}, ${s.z}], palette: p, front: '${front}' });
  const m = massing(bp);
  m.mass('main', [${box.join(', ')}]);
  m.opening('main', '${front}', [${door.join(', ')}], [1, 2]);
  bp.part('path', () => bp.floor(${path0.join(', ')}, 0, p.path));
  bp.spot('entrance', ${ex}, ${ez}, ${yaw});
  bp.spot('spawn', ${sx}, ${sz}, ${yaw});
  return bp;
}
`;
}

/** A redirect in the sim: bump the first int param's default (if it can grow), else turn the first gable roof into a hip. */
export function simRedirect(source: string): { source: string; change: string } {
  const params = /export\s+const\s+params\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
  if (params) {
    const re = /(\w+)\s*:\s*\{([^}]*type:\s*'int'[^}]*)\}/g;
    for (let m = re.exec(params[1]!); m; m = re.exec(params[1]!)) {
      const max = /max:\s*(-?\d+)/.exec(m[2]!);
      const def = /default:\s*(-?\d+)/.exec(m[2]!);
      if (!max || !def || Number(def[1]) >= Number(max[1])) continue;
      const block = m[0].replace(/default:\s*-?\d+/, `default: ${Number(def[1]) + 1}`);
      return { source: source.replace(m[0], block), change: `${m[1]} ${def[1]} -> ${Number(def[1]) + 1}` };
    }
  }
  if (/roof:\s*'gable'/.test(source)) return { source: source.replace(/roof:\s*'gable'/, "roof: 'hip'"), change: 'a gable roof became a hip' };
  return { source, change: 'no change the sim knows how to make' };
}

interface Run {
  cancelled: boolean;
  wake?: () => void;
}

export class SimDesigner implements Designer {
  readonly name = 'sim' as const;
  private runs = new Map<string, Run>();
  private stopped = false;
  private limitTimer: NodeJS.Timeout | undefined;
  /** designs that hit their simulated limit already */
  private limitedOnce = new Set<string>();
  /** ids handed out to running jobs (a library id is taken only when installed) */
  private taken = new Map<string, string>();

  constructor(
    private sc: Sidecar,
    /** ms per fake step */
    private stepMs = 400,
  ) {}

  async start(): Promise<void> {
    this.sc.setAuth({ auth: 'ok', authSource: 'sim (no Claude)', sdk: (await sdkResolvable()) ? 'ready' : 'missing', message: 'sim designer: installs kit examples, no Claude' });
    this.armLimit();
  }

  authChanged(): void {
    /* the sim needs no credentials */
  }

  canRun(): boolean {
    return !this.stopped && !this.limited();
  }

  blocked(): string | undefined {
    return undefined;
  }

  limitChanged(): void {
    this.armLimit();
  }

  run(id: string): Promise<RunOutcome> {
    const r: Run = { cancelled: false };
    this.runs.set(id, r);
    this.sc.statusChanged();
    return this.runJob(id, r)
      .catch((e): RunOutcome => {
        if (e instanceof Limited) {
          this.sc.designStep(id, 'queued', 'usage limit (simulated): waiting for the reset');
          return 'requeue';
        }
        if (e instanceof Cancelled) return this.stopped ? 'stopped' : 'finished';
        this.sc.designFailed(id, (e as Error).message);
        return 'finished';
      })
      .finally(() => {
        this.runs.delete(id);
        this.taken.delete(id);
        this.sc.statusChanged();
      });
  }

  cancel(id: string): void {
    const r = this.runs.get(id);
    if (!r) return;
    r.cancelled = true;
    r.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    const runs = [...this.runs.values()];
    for (const r of runs) r.wake?.();
    while (this.runs.size) await new Promise((res) => setTimeout(res, 5));
  }

  /** resolves when nothing is running or waiting (tests) */
  async idle(): Promise<void> {
    while (this.runs.size || this.sc.scheduler.waitingIds().length) await new Promise((res) => setTimeout(res, 10));
  }

  // ---- the simulated usage limit -----------------------------------------------------------------

  private limited(): boolean {
    const l = this.sc.store.data.limit;
    return !!l && l.until > Date.now();
  }

  private hitLimit(): void {
    const until = Date.now() + this.sc.config.simLimitMs;
    this.sc.store.data.limit = { until, type: 'sim' };
    this.sc.store.markDirty();
    this.sc.log.warn(`usage limit reached (simulated): designs wait ${this.sc.config.simLimitMs} ms`);
    this.sc.limitChanged();
    this.sc.statusChanged();
    // every running design stops at its next step
    for (const r of this.runs.values()) r.wake?.();
  }

  /** Clear the limit when it ends, then let the queues start again. */
  private armLimit(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = undefined;
    const l = this.sc.store.data.limit;
    if (!l || this.stopped) return;
    const left = l.until - Date.now();
    if (left <= 0) {
      delete this.sc.store.data.limit;
      this.sc.store.markDirty();
      this.sc.log.info('usage limit over (simulated): designs resume');
      this.sc.jobs.limitChanged();
      this.sc.groups.refreshActive();
      this.sc.statusChanged();
      this.sc.scheduler.kick();
      return;
    }
    this.limitTimer = setTimeout(() => this.armLimit(), left + 5);
    this.limitTimer.unref?.();
  }

  // ---- one design -----------------------------------------------------------------------------------

  /** (6c 0a) The sim's own round state of a design (persisted with its work): the round, what it charged in it, the repair. */
  private simWork(id: string, bp: string): SimRoundWork {
    const w = ((this.sc.store.data.work ??= {})[id] ??= { bp, round: 0 });
    return (w.sim ??= { round: 1, charged: 0 });
  }

  private sleep(ms: number, id: string, r: Run): Promise<void> {
    // stopped or cancelled before the step began (e.g. during the async fit): no step at all
    if (this.stopped || r.cancelled || this.gone(id)) return Promise.reject(new Cancelled());
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        r.wake = undefined;
        if (this.stopped || r.cancelled || this.gone(id)) reject(new Cancelled());
        else if (this.limited()) reject(new Limited());
        else resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      r.wake = done;
    });
  }

  private gone(id: string): boolean {
    const d = this.sc.designs.get(id);
    return !d || isFinalDesign(d);
  }

  private check(id: string, r: Run): void {
    if (this.stopped || r.cancelled || this.gone(id)) throw new Cancelled();
  }

  private async runJob(id: string, r: Run): Promise<RunOutcome> {
    const sc = this.sc;
    const cfg = sc.config;
    const d = sc.designs.get(id);
    if (!d || isFinalDesign(d)) return 'finished';
    // (5a) a revision after critique
    if (sc.critiques.revising(id)) return this.revise(id, d, r);
    // (5b) a polish: the polish engine with scripted turns
    if (d.kind === 'polish') return sc.polishes.run(id, this.polishBackend(id, r));
    const req = d.request;
    let src = simSource(cfg.kitDir, req.type);
    if (!src) throw new Error(`the sim copies a kit example, but ${path.join(cfg.kitDir, 'designs')} has neither ${req.type}.mjs nor cabin.mjs`);
    // (6c 0a) the example (and its params) that fits the request's max size (a small lot: a smaller cabin, a stand-in massing)
    const fit = await simFit(cfg.kitDir, req.type, req.maxSize);
    // (4c) a massing job builds under its massing id
    const bp = d.massing ? d.massing.id : freeLibraryId(cfg.libraryDir, designBaseId(req), new Set([...this.taken].filter(([k]) => k !== id).map(([, v]) => v)));
    if (!d.massing) this.taken.set(id, bp);
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp, ...sc.scratchExtras(d) });
    let cost = d.cost ?? zeroCost();
    const faults = simFaults(req);
    // (6c 0a) the notional per-item costs (config simCosts): round 1 costs the massing's or the detail's figure, spread over
    // its steps so the round sums exactly; a step that runs again (a usage limit, a restart) adds nothing more
    const costs = cfg.simCosts;
    const sw = this.simWork(id, bp);
    const charge = (round: number, k: number, n: number, target: number): number => {
      if (!costs) return cfg.simDesignUsd;
      if (sw.round !== round) Object.assign(sw, { round, charged: 0 });
      const due = Math.round(((target * k) / n) * 1e6) / 1e6;
      const add = Math.max(0, Math.round((due - sw.charged) * 1e6) / 1e6);
      sw.charged = Math.max(sw.charged, due);
      sc.store.markDirty();
      return add;
    };
    for (const [i, s] of STEPS.entries()) {
      if (sw.round > 1) break; // round 1 is behind it (a restart during the repair round)
      sc.designStep(id, s.status, `${s.step} (simulated)`);
      if (faults.has('usage_limit') && !this.limitedOnce.has(id) && s === STEPS[1]) {
        this.limitedOnce.add(id);
        sc.designStep(id, 'queued', 'usage limit (simulated): waiting for the reset');
        this.hitLimit();
        throw new Limited();
      }
      await this.sleep(this.stepMs, id, r);
      // the sim's notional spend: simDesignUsd per step, or (simCosts) the item's share
      cost = { ...cost, usd: Math.round((cost.usd + charge(1, i + 1, STEPS.length, costs ? (d.massing ? costs.massing : costs.detail) : 0)) * 1e6) / 1e6, turns: cost.turns + 1 };
      sc.designCost(id, cost);
      // (6c 0a) sim:fail: the design fails after its first step
      if (faults.has('fail')) throw new Error('the design failed (simulated: sim:fail)');
    }
    // (6c 0a) sim:repair: round 1's check fails (simulated), and one repair round (round 2) fixes it
    if (faults.has('repair') && sw.round <= 2 && !sw.repaired) {
      this.check(id, r);
      sc.designStep(id, 'checking', `checking the ${d.massing ? 'massing' : 'design'} (simulated designer): the check failed (sim:repair)`);
      sc.log.info(`design ${id}: round 1's check failed (simulated, sim:repair); repair round 2`);
      sc.designStep(id, 'designing', 'round 2: fixing what the check found (simulated, sim:repair)');
      await this.sleep(this.stepMs, id, r);
      cost = { ...cost, usd: Math.round((cost.usd + charge(2, 1, 1, costs ? costs.repair : 0)) * 1e6) / 1e6, turns: cost.turns + 1 };
      sc.designCost(id, cost);
      sw.repaired = true;
      sc.store.markDirty();
    }
    this.check(id, r);
    const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
    const open = !(BUILDING_TYPES as readonly string[]).includes(req.type);
    let source: string;
    let what: string;
    let note = '';
    if (d.massing) {
      // (4c) a massing: the previous version changed (a redirect), else the kit's example massing
      const prev = req.redirect ? sc.massings.get(d.massing.id, req.redirect.fromVersion) : undefined;
      if (prev) {
        const r2 = simRedirect(fs.readFileSync(path.join(prev.dir, `${prev.id}.mjs`), 'utf8'));
        source = withDesignId(r2.source, bp);
        what = `massing ${prev.id} v${prev.version} redirected (${r2.change})`;
        note = r2.change;
      } else {
        const ex = simMassingSource(cfg.kitDir, req.type);
        const exSize = ex ? await massingSize(ex) : undefined;
        if (fit && req.maxSize && (!ex || (exSize && !fits(exSize, req.maxSize)))) {
          // (6c 0a) the example massing exceeds the max size: a one-box stand-in the size of the fitted detail
          source = standInMassing(bp, req.type, fit.built);
          what = `a stand-in massing ${fit.built.size.x}x${fit.built.size.y}x${fit.built.size.z} (the kit's example massing exceeds ${req.maxSize.x}x${req.maxSize.y}x${req.maxSize.z})`;
          note = 'a stand-in massing (the example massing is over the max size)';
        } else {
          source = withDesignId(fs.readFileSync(ex ?? path.join(scratch, KIT, 'designs', `${src}.mjs`), 'utf8'), bp);
          what = ex ? `the kit example massing ${path.basename(ex, '.mjs')}` : `the kit example ${src} (the kit has no example massing)`;
          if (!ex) note = 'no example massing in the kit';
        }
      }
      // the massing profile has no type rules: the requested type is written in
      source = source.replace(/type:\s*'(?!(?:int|bool|enum)')[a-z0-9_]+'/, `type: '${req.type}'`);
    } else {
      // the "design": the example under the new id (an open type and its profile written in); (6c 0a) fitted to the max size
      if (fit?.changed) src = fit.src;
      source = withDesignId(fs.readFileSync(path.join(scratch, KIT, 'designs', `${src}.mjs`), 'utf8'), bp);
      if (fit?.changed) source = withDefaults(source, fit.values);
      if (open) source = source.replace(new RegExp(`type: '${src}'`), `type: '${req.type}', profile: ${JSON.stringify(req.profile ?? ['door', 'lit', 'no_floating'])}`);
      what = `the kit example ${src}${fit?.changed && Object.keys(fit.values).length ? ` (${Object.entries(fit.values).map(([k, v]) => `${k} ${v}`).join(', ')}: fitted to the max size)` : ''}`;
      if (src !== req.type) note = `copied ${src} (no ${req.type} example${fit?.changed ? ' that fits' : ''})`;
    }
    fs.writeFileSync(design, source);
    sc.designStep(id, 'checking', `checking the ${d.massing ? 'massing' : 'design'} (simulated designer)`);
    const bibleArgs = req.bible && fs.existsSync(path.join(scratch, 'bible', 'bible.json')) ? ['--bible', path.join('bible', 'bible.json')] : [];
    sc.syncScratchBible(scratch, d);
    // (4c) the plan every designer checks with: the massing profile, or a detail pass's hard cap and --massing
    const plan = sc.checkPlan(d, bibleArgs);
    // a fallback example (cabin for a tower) is checked as what it is, not as the requested type
    const limits = d.massing ? plan.limits : { ...plan.limits, type: src === req.type || open ? req.type : undefined, profile: open ? (req.profile ?? ['door', 'lit', 'no_floating']) : undefined };
    const res = await checkDesign(cfg.kitDir, scratch, bp, limits, 120_000, plan.extra);
    this.check(id, r);
    const problem = res.ok ? sc.checkOutcome(d, res) : (sc.checkOutcome(d, res), res.problem ?? 'the check failed');
    if (problem) throw new Error(`the sim installs ${what}, which did not pass: ${problem}`);
    sc.designStep(id, 'rendering', 'rendering previews');
    const rp = await renderPreviews(scratch, res.nbt!);
    this.check(id, r);
    const name = req.name ?? `Sim ${req.style} ${req.type}`;
    const description = `Simulated ${d.massing ? 'massing' : 'design'} (${what})${req.notes ? `: ${truncate(req.notes, 200)}` : ''}`;
    const notes = [note, rp.skipped ? 'no renderer' : rp.error ? `previews: ${truncate(rp.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''];
    // (5a) the critique loop takes the round (the slot is given back while its critic call runs)
    if ((await sc.critiques.roundReady(sc.designs.get(id)!, { scratch, bp, res, previews: rp.files, baseId: designBaseId(req), name, description, notes: notes.filter(Boolean) })) === 'critique') return 'critique';
    sc.installChecked(d, {
      scratch,
      bp,
      baseId: designBaseId(req),
      res,
      previews: rp.files,
      taken: new Set([...this.taken].filter(([k]) => k !== id).map(([, v]) => v)),
      name: req.name ?? `Sim ${req.style} ${req.type}`,
      description: `Simulated ${d.massing ? 'massing' : 'design'} (${what})${req.notes ? `: ${truncate(req.notes, 200)}` : ''}`,
      notes,
    });
    return 'finished';
  }

  /**
   * (5b) The sim's polish turns, scripted by the entry's notes `sim:polish=<t1>/<t2>/...` (polish.ts simToken), one token
   * per step: an edit of one full-block cell in the target part (always, unless `z`: no edit), `x<k>` a stray edit
   * outside the allowed parts until fix turn k (`x`: never fixed), `t<k>` a design that throws until fix turn k, `L` a
   * usage limit once (the step's turn runs again after the reset). Each turn costs one design step (simDesignUsd).
   */
  private polishBackend(id: string, r: Run): PolishBackend {
    const sc = this.sc;
    return {
      name: 'sim',
      stopping: () => this.stopped,
      turn: async (spec): Promise<PolishTurnResult> => {
        const tok = simToken(spec.notes, spec.step);
        const zero = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
        const key = `${id}:${spec.step}`;
        if (tok.includes('L') && !this.limitedOnce.has(key)) {
          this.limitedOnce.add(key);
          sc.designStep(id, 'queued', 'usage limit (simulated): waiting for the reset');
          this.hitLimit();
          return { outcome: 'limit', cost: zero };
        }
        try {
          await this.sleep(this.stepMs, id, r);
        } catch (e) {
          if (e instanceof Limited) return { outcome: 'limit', cost: zero };
          return { outcome: r.cancelled || this.gone(id) ? 'cancelled' : 'stopped', cost: zero };
        }
        const cost = { ...zero, usd: sc.config.simDesignUsd, turns: 1 };
        const fixAfter = (flag: string): number | undefined => {
          const m = new RegExp(`${flag}(\\d*)`).exec(tok);
          if (!m) return undefined;
          return m[1] ? Number(m[1]) : Infinity;
        };
        const fixTurn = spec.turn - 1; // 0 = the step's own turn
        let src = fs.readFileSync(path.join(spec.baseDir, `${spec.bp}.mjs`), 'utf8');
        const lines: string[] = [];
        const helper = path.join(spec.scratch, 'polish', 'simcell.mjs');
        fs.mkdirSync(path.dirname(helper), { recursive: true });
        fs.writeFileSync(helper, SIM_CELL);
        const cell = async (mode: 'part' | 'outside', names: string[]) => {
          const out = await runNode(helper, [path.join(spec.baseDir, `${spec.bp}.nbt`), mode, names.join(',')], spec.scratch, 60_000);
          try {
            return JSON.parse(out.stdout.trim().split('\n').pop() ?? 'null') as { d: number[]; v: string; part: string | null } | null;
          } catch {
            return null;
          }
        };
        const block = (v: string) => (v.startsWith('minecraft:mossy_cobblestone[') ? 'minecraft:cobblestone' : 'minecraft:mossy_cobblestone');
        const part = spec.target?.part ?? spec.allowed[0];
        if (!tok.includes('z') && part) {
          const c = await cell('part', [part]);
          if (c) lines.push(`  bp.part('${part}', () => bp.set(${c.d.join(', ')}, '${block(c.v)}'));`);
        }
        const stray = fixAfter('x');
        if (stray !== undefined && fixTurn < stray) {
          const c = await cell('outside', spec.allowed);
          if (c) lines.push(c.part ? `  bp.part('${c.part}', () => bp.set(${c.d.join(', ')}, '${block(c.v)}'));` : `  bp.set(${c.d.join(', ')}, '${block(c.v)}');`);
        }
        const broken = fixAfter('t');
        if (broken !== undefined && fixTurn < broken) lines.push("  throw new Error('a broken polish (simulated)');");
        const at = src.lastIndexOf('return bp;');
        if (at >= 0 && lines.length) src = `${src.slice(0, at)}${lines.join('\n')}\n  ${src.slice(at)}`;
        fs.writeFileSync(path.join(spec.scratch, 'kit', 'designs', `${spec.bp}.mjs`), src);
        sc.designStep(id, 'designing', `polish step ${spec.step}, turn ${spec.turn} (simulated): ${tok}`);
        return { outcome: 'done', cost };
      },
    };
  }

  /**
   * (5a) A simulated revision: one step that costs like a design step, then the same source is checked and rendered
   * again (the scripted critic decides the scores). Notes `sim:revise=fail` make every revision fail its check, so the
   * loop ends check_failed after the revision's own allowance.
   */
  private async revise(id: string, d: Design, r: Run): Promise<RunOutcome> {
    const sc = this.sc;
    const cfg = sc.config;
    const w = sc.store.data.work[id]!;
    const bp = w.critique!.bp;
    const req = d.request;
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp, ...sc.scratchExtras(d) });
    const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
    const good = fs.readFileSync(path.join(scratch, 'rounds', String(w.critique!.round - 1), `${bp}.mjs`), 'utf8');
    for (;;) {
      if (!sc.critiques.beforeRevision(sc.designs.get(id)!)) return 'finished';
      sc.designStep(id, 'designing', `${sc.critiques.revisionStep(sc.designs.get(id)!)} (simulated)`);
      let cost = sc.critiques.turnsCost(sc.designs.get(id)!);
      // a revision costs one design step (a warm session, a smaller change than round 0)
      for (let i = 0; i < 1; i++) {
        try {
          await this.sleep(this.stepMs, id, r);
        } catch (e) {
          sc.critiques.undoTurn(id);
          throw e;
        }
        // (6c 0a) with simCosts, a loop revision costs a repair round
        cost = { ...cost, usd: Math.round((cost.usd + (cfg.simCosts ? cfg.simCosts.repair : cfg.simDesignUsd)) * 1e6) / 1e6, turns: cost.turns + 1 };
        sc.designCost(id, cost);
      }
      this.check(id, r);
      // the revision (sim: the same source, or a broken one when the notes ask for a failing revision)
      fs.writeFileSync(design, req.notes?.includes('sim:revise=fail') ? `${good}\nthrow new Error('a broken revision (simulated)');\n` : good);
      sc.designStep(id, 'checking', 'checking the revision (simulated designer)');
      sc.syncScratchBible(scratch, d);
      const src = simSource(cfg.kitDir, req.type);
      const open = !(BUILDING_TYPES as readonly string[]).includes(req.type);
      const bibleArgs = req.bible && fs.existsSync(path.join(scratch, 'bible', 'bible.json')) ? ['--bible', path.join('bible', 'bible.json')] : [];
      const plan = sc.checkPlan(d, bibleArgs);
      const limits = d.massing ? plan.limits : { ...plan.limits, type: src === req.type || open ? req.type : undefined, profile: open ? (req.profile ?? ['door', 'lit', 'no_floating']) : undefined };
      const res = await checkDesign(cfg.kitDir, scratch, bp, limits, 120_000, plan.extra);
      this.check(id, r);
      const problem = res.ok ? sc.checkOutcome(d, res) : (res.problem ?? 'the check failed');
      if (problem) {
        if (sc.critiques.mayFixRevision(id)) continue;
        sc.critiques.revisionEnded(id, 'check_failed', problem);
        return 'finished';
      }
      sc.designStep(id, 'rendering', 'rendering previews');
      const rp = await renderPreviews(scratch, res.nbt!);
      this.check(id, r);
      return (await sc.critiques.roundReady(sc.designs.get(id)!, { scratch, bp, res, previews: rp.files, baseId: designBaseId(req) })) === 'critique' ? 'critique' : 'finished';
    }
  }
}

/**
 * (5b) A cell of a base build for the sim's scripted edits (a node script in the scratch kit): the first cell (y, z, x)
 * of `part` (`--outside a,b`: of any part not listed, or in no part), preferring full blocks so an edit does not change a
 * neighbour's connections.
 */
const SIM_CELL = `import { loadVersion } from '../kit/lib/diff.mjs';
const [file, mode, list] = process.argv.slice(2);
const names = (list ?? '').split(',').filter(Boolean);
const v = loadVersion(file);
const cube = /(planks|stone|bricks|cobblestone|_log|_wood|terracotta|concrete|_block|deepslate|sandstone|plaster)\\[/;
const pick = (c) => (mode === 'part' ? c.part === names[0] : c.part === null || !names.includes(c.part)) && !c.v.startsWith('minecraft:air');
const cells = v.cells.filter(pick).sort((a, b) => a.d[1] - b.d[1] || a.d[2] - b.d[2] || a.d[0] - b.d[0]);
const c = cells.find((x) => cube.test(x.v)) ?? cells[0];
console.log(JSON.stringify(c ? { d: c.d, v: c.v, part: c.part } : null));
`;

/** Is the Agent SDK installed (for the status line, also under the sim)? */
async function sdkResolvable(): Promise<boolean> {
  return !!(await loadSdk());
}
