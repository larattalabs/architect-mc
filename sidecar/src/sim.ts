// The sim designer (no Claude), ported from AgentCraft's agents/sim/designer.ts, for tests and
// offline UI work. A job walks through a few fake progress steps, then takes a kit example
// (kit/designs/<type>.mjs if there is one, else cabin.mjs) as its "design" under the new id and
// runs it through the real pipeline: the scratch dir, the pristine-kit check (`kit/build.mjs` in a
// child process), the renderer and the never-overwrite install into the library.
import fs from 'node:fs';
import path from 'node:path';
import { loadSdk } from './claude/sdk.js';
import { zeroCost } from './jobs/cost.js';
import { checkDesign, designBaseId, freeLibraryId, installDesign, KIT, renderPreviews, withDesignId } from './designs.js';
import type { Design } from './protocol.js';
import { prepareScratch } from './scratch.js';
import type { Designer, Sidecar } from './sidecar.js';
import { truncate } from './util/text.js';

const STEPS: Array<{ status: 'designing'; step: string }> = [
  { status: 'designing', step: 'reading the brief' },
  { status: 'designing', step: 'sketching the floor plan' },
  { status: 'designing', step: 'raising the walls and the roof' },
];

class Cancelled extends Error {}

/** The kit example a sim job copies for a request type. */
export function simSource(kitDir: string, type: string): string | undefined {
  const has = (id: string) => fs.existsSync(path.join(kitDir, 'designs', `${id}.mjs`));
  if (has(type)) return type;
  if (has('cabin')) return 'cabin';
  return undefined;
}

export class SimDesigner implements Designer {
  readonly name = 'sim' as const;
  private queue: string[] = [];
  private current: string | undefined;
  private cancelled = new Set<string>();
  private stopped = false;
  private wake: (() => void) | undefined;
  private runP: Promise<void> | undefined;

  constructor(
    private sc: Sidecar,
    /** ms per fake step */
    private stepMs = 400,
  ) {}

  async start(): Promise<void> {
    this.sc.heavy.onFree(() => this.kick());
    this.sc.setAuth({ auth: 'ok', authSource: 'sim (no Claude)', sdk: await sdkResolvable() ? 'ready' : 'missing', message: 'sim designer: installs kit examples, no Claude' });
  }

  authChanged(): void {
    /* the sim needs no credentials */
  }

  runningId(): string | undefined {
    return this.current;
  }

  request(d: Design): void {
    if (this.queue.includes(d.id) || this.current === d.id) return;
    this.cancelled.delete(d.id);
    this.queue.push(d.id);
    this.kick();
  }

  cancel(id: string): void {
    this.queue = this.queue.filter((x) => x !== id);
    if (this.current === id) {
      this.cancelled.add(id);
      this.wake?.();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.runP?.catch(() => undefined);
  }

  /** resolves when nothing is queued or running (tests) */
  async idle(): Promise<void> {
    while (this.runP) await this.runP.catch(() => undefined);
  }

  private kick(): void {
    if (this.runP || this.stopped || !this.queue.length) return;
    // one design or agent job at a time (agent jobs share the design queue's slot)
    if (!this.sc.heavy.tryAcquire('design')) return;
    this.runP = (async () => {
      try {
        while (!this.stopped && this.queue.length) {
          const id = this.queue.shift()!;
          this.current = id;
          this.sc.statusChanged();
          try {
            await this.runJob(id);
          } catch (e) {
            if (!(e instanceof Cancelled)) this.sc.designFailed(id, (e as Error).message);
          } finally {
            this.current = undefined;
            this.cancelled.delete(id);
            this.sc.statusChanged();
          }
        }
      } finally {
        this.runP = undefined;
        this.sc.heavy.release('design');
      }
    })();
  }

  private sleep(ms: number, id: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(t);
        this.wake = undefined;
        if (this.stopped || this.cancelled.has(id)) reject(new Cancelled());
        else resolve();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.wake = done;
    });
  }

  private check(id: string): void {
    const d = this.sc.designs.get(id);
    if (this.stopped || this.cancelled.has(id) || !d || d.status === 'cancelled') throw new Cancelled();
  }

  private async runJob(id: string): Promise<void> {
    const sc = this.sc;
    const cfg = sc.config;
    const d = sc.designs.get(id);
    if (!d || d.status === 'cancelled' || d.status === 'done' || d.status === 'failed') return;
    const req = d.request;
    const src = simSource(cfg.kitDir, req.type);
    if (!src) throw new Error(`the sim copies a kit example, but ${path.join(cfg.kitDir, 'designs')} has neither ${req.type}.mjs nor cabin.mjs`);
    const bp = freeLibraryId(cfg.libraryDir, designBaseId(req));
    const scratch = prepareScratch({ dataDir: cfg.dataDir, kitDir: cfg.kitDir, libraryDir: cfg.libraryDir, design: d, bp });
    for (const s of STEPS) {
      sc.designStep(id, s.status, `${s.step} (simulated)`);
      await this.sleep(this.stepMs, id);
    }
    // no Claude, no spend: the cost record still shows the steps
    sc.designCost(id, { ...zeroCost(), turns: STEPS.length });
    // the "design": the example under the new id
    const design = path.join(scratch, KIT, 'designs', `${bp}.mjs`);
    fs.writeFileSync(design, withDesignId(fs.readFileSync(path.join(scratch, KIT, 'designs', `${src}.mjs`), 'utf8'), bp));
    this.check(id);
    sc.designStep(id, 'checking', 'checking the design (simulated designer)');
    // a fallback example (cabin for a tower) is checked as what it is, not as the requested type
    const res = await checkDesign(cfg.kitDir, scratch, bp, { maxSize: req.maxSize, type: src === req.type ? req.type : undefined });
    this.check(id);
    if (!res.ok) throw new Error(`the sim installs the kit example ${src}, which did not pass: ${res.problem ?? 'the check failed'}`);
    sc.designStep(id, 'rendering', 'rendering previews');
    const r = await renderPreviews(scratch, res.nbt!);
    this.check(id);
    const installed = installDesign({
      library: cfg.libraryDir,
      baseId: designBaseId(req),
      nbt: res.nbt!,
      sidecar: res.sidecar!,
      source: design,
      previews: r.files,
      meta: {
        name: req.name ?? `Sim ${req.style} ${req.type}`,
        description: `Simulated design (a copy of the kit example ${src})${req.notes ? `: ${truncate(req.notes, 200)}` : ''}`,
        request: req,
        createdAt: sc.now(),
        ...(req.ext && Object.keys(req.ext).length ? { extra: { ext: req.ext } } : {}),
      },
    });
    const s = res.sidecar!.size!;
    const notes = [src !== req.type ? `copied ${src} (no ${req.type} example)` : '', r.skipped ? 'no renderer' : r.error ? `previews: ${truncate(r.error, 80)}` : '', res.warnings.length ? `${res.warnings.length} checker warning(s)` : ''].filter(Boolean).join('; ');
    sc.designDone(id, installed, { x: s.x, y: s.y, z: s.z }, notes);
  }
}

/** Is the Agent SDK installed (for the status line, also under the sim)? */
async function sdkResolvable(): Promise<boolean> {
  return !!(await loadSdk());
}
