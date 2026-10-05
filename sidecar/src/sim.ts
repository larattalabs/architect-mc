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
import { loadSdk } from './claude/sdk.js';
import { zeroCost } from './jobs/cost.js';
import { checkDesign, designBaseId, freeLibraryId, isFinalDesign, KIT, renderPreviews, withDesignId } from './designs.js';
import type { Design } from './protocol.js';
import { BUILDING_TYPES } from './protocol.js';
import { prepareScratch } from './scratch.js';
import type { Designer, RunOutcome, Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';

const STEPS: Array<{ status: 'designing'; step: string }> = [
  { status: 'designing', step: 'reading the brief' },
  { status: 'designing', step: 'sketching the floor plan' },
  { status: 'designing', step: 'raising the walls and the roof' },
];

/** A request asks the sim to hit a usage limit (once). */
export const SIM_LIMIT_MARK = 'sim:usage_limit';

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
      .then((): RunOutcome => 'finished')
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

  private sleep(ms: number, id: string, r: Run): Promise<void> {
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

  private async runJob(id: string, r: Run): Promise<void> {
    const sc = this.sc;
    const cfg = sc.config;
    const d = sc.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    const req = d.request;
    const src = simSource(cfg.kitDir, req.type);
    if (!src) throw new Error(`the sim copies a kit example, but ${path.join(cfg.kitDir, 'designs')} has neither ${req.type}.mjs nor cabin.mjs`);
    // (4c) a massing job builds under its massing id
    const bp = d.massing ? d.massing.id : freeLibraryId(cfg.libraryDir, designBaseId(req), new Set([...this.taken].filter(([k]) => k !== id).map(([, v]) => v)));
    if (!d.massing) this.taken.set(id, bp);
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp, ...sc.scratchExtras(d) });
    let cost = d.cost ?? zeroCost();
    for (const s of STEPS) {
      sc.designStep(id, s.status, `${s.step} (simulated)`);
      if (req.notes?.includes(SIM_LIMIT_MARK) && !this.limitedOnce.has(id) && s === STEPS[1]) {
        this.limitedOnce.add(id);
        sc.designStep(id, 'queued', 'usage limit (simulated): waiting for the reset');
        this.hitLimit();
        throw new Limited();
      }
      await this.sleep(this.stepMs, id, r);
      // the sim's notional spend: simDesignUsd per step
      cost = { ...cost, usd: Math.round((cost.usd + cfg.simDesignUsd) * 1e6) / 1e6, turns: cost.turns + 1 };
      sc.designCost(id, cost);
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
        source = withDesignId(fs.readFileSync(ex ?? path.join(scratch, KIT, 'designs', `${src}.mjs`), 'utf8'), bp);
        what = ex ? `the kit example massing ${path.basename(ex, '.mjs')}` : `the kit example ${src} (the kit has no example massing)`;
        if (!ex) note = 'no example massing in the kit';
      }
      // the massing profile has no type rules: the requested type is written in
      source = source.replace(/type:\s*'(?!(?:int|bool|enum)')[a-z0-9_]+'/, `type: '${req.type}'`);
    } else {
      // the "design": the example under the new id (an open type and its profile written in)
      source = withDesignId(fs.readFileSync(path.join(scratch, KIT, 'designs', `${src}.mjs`), 'utf8'), bp);
      if (open) source = source.replace(new RegExp(`type: '${src}'`), `type: '${req.type}', profile: ${JSON.stringify(req.profile ?? ['door', 'lit', 'no_floating'])}`);
      what = `the kit example ${src}`;
      if (src !== req.type) note = `copied ${src} (no ${req.type} example)`;
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
    sc.installChecked(d, {
      scratch,
      bp,
      baseId: designBaseId(req),
      res,
      previews: rp.files,
      taken: new Set([...this.taken].filter(([k]) => k !== id).map(([, v]) => v)),
      name: req.name ?? `Sim ${req.style} ${req.type}`,
      description: `Simulated ${d.massing ? 'massing' : 'design'} (${what})${req.notes ? `: ${truncate(req.notes, 200)}` : ''}`,
      notes: [note, rp.skipped ? 'no renderer' : rp.error ? `previews: ${truncate(rp.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''],
    });
  }
}

/** Is the Agent SDK installed (for the status line, also under the sim)? */
async function sdkResolvable(): Promise<boolean> {
  return !!(await loadSdk());
}
