// The design scheduler: puts designs (single ones and group items) and bible jobs into the pool (pool.ts) and hands each
// one to the designer when its slot comes. Lanes: `single`, `group:<g>` (capped at the group's concurrency), `bibles`.
//
// A ticket waits (stays queued, in order) while the designer cannot run (auth being checked, a usage limit), while its
// group is paused by the soft budget or cancelled, and while an earlier wave of its group is unfinished. When auth has
// failed for good, everything waiting fails with the reason. A design the designer hands back with 'requeue' (a usage
// limit) goes back to the front of its lane.
import type { Design } from './protocol.js';
import { isFinalDesign } from './designs.js';
import type { Sidecar } from './sidecar.js';

export const designKey = (id: string) => `design:${id}`;
export const bibleKey = (id: string) => `bible:${id}`;
export const laneOf = (d: Design) => (d.request.group ? `group:${d.request.group}` : 'single');

export class DesignScheduler {
  constructor(private sc: Sidecar) {}

  /** Queue a design (new, picked up after a restart, or requeued after a usage limit). */
  enqueue(id: string, front = false): void {
    const d = this.sc.designs.get(id);
    if (!d || isFinalDesign(d) || this.sc.pool.isRunning(designKey(id))) return;
    this.sc.pool.submit(
      {
        key: designKey(id),
        lane: laneOf(d),
        ready: () => this.ready(id),
        start: () => this.start(id),
      },
      front,
    );
  }

  /** Queue a bible job (it takes one slot, like a design). */
  enqueueBible(id: string, front = false): void {
    if (this.sc.pool.isRunning(bibleKey(id))) return;
    this.sc.pool.submit({ key: bibleKey(id), lane: 'bibles', ready: () => this.sc.bibles.ready(id), start: () => this.sc.bibles.run(id) }, front);
  }

  private ready(id: string): boolean {
    const d = this.sc.designs.get(id);
    if (!d || isFinalDesign(d)) return true; // starts and ends at once (drops out of the queue)
    if (!this.sc.designerReady()) return false;
    return this.sc.groups.itemReady(d);
  }

  private async start(id: string): Promise<void> {
    const d = this.sc.designs.get(id);
    if (!d || isFinalDesign(d)) return;
    this.sc.estimates.started(id);
    const out = await this.sc.runDesign(id);
    // (after the pool has released this run's slot)
    if (out === 'requeue') setImmediate(() => this.enqueue(id, true));
  }

  /** Drop a waiting design (cancel); a running one is stopped by the designer. */
  withdraw(id: string): void {
    this.sc.pool.withdraw(designKey(id));
  }

  /** The designs running now. */
  runningIds(): string[] {
    return this.sc.pool.runningKeys().filter((k) => k.startsWith('design:')).map((k) => k.slice('design:'.length));
  }

  /** The designs waiting for a slot. */
  waitingIds(): string[] {
    return this.sc.pool.waitingKeys().filter((k) => k.startsWith('design:')).map((k) => k.slice('design:'.length));
  }

  /**
   * Something changed (auth, the usage limit, a group): fail what waits when Claude is blocked for good, else start
   * what can start.
   */
  kick(): void {
    const why = this.sc.designerBlocked();
    if (why) {
      for (const id of this.waitingIds()) {
        this.sc.pool.withdraw(designKey(id));
        this.sc.designFailed(id, why);
      }
      this.sc.bibles.failWaiting(why);
    }
    this.sc.pool.kick();
  }
}
