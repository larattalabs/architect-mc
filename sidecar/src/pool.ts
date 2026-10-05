// The design pool (docs/CONTRACT.md phase 4b, "4b review folded in" item 9): `designConcurrency` slots (default 3) shared
// round-robin by lanes, so groups are served fairly (not FIFO by group) next to single designs. Lanes:
//
//   single         design requests that are not in a group
//   group:<g>      the items of a design group (capped at the group's `concurrency`)
//   bibles         bible jobs (one slot each)
//   jobs           agent jobs (protocol 2)
//
// Whoever wants a slot submits a ticket. A ticket is asked `ready()` each time the pool looks for work (a usage limit, a
// paused group or a later wave makes it wait without leaving the queue). When a slot is free, the pool takes the lane
// after the one it served last that has a ready ticket and room under its cap, and starts that lane's first ready
// ticket. Variants and re-skins never use the pool (they have their own queue).
export interface Ticket {
  /** unique: "design:d3", "bible:b1", "job:j4" */
  key: string;
  lane: string;
  /** may it start now? (asked at every dispatch) */
  ready(): boolean;
  /** run it; the slot is held until the promise settles */
  start(): Promise<unknown>;
}

export class Pool {
  private waiting: Ticket[] = [];
  private running = new Map<string, string>();
  private laneCaps = new Map<string, number>();
  /** lanes in the order they first asked, for the round robin */
  private ring: string[] = [];
  private lastLane: string | undefined;
  private kicking = false;
  private again = false;
  private stopped = false;

  constructor(
    private capacity: () => number,
    private onError: (key: string, e: unknown) => void = () => undefined,
  ) {}

  get size(): number {
    return Math.max(1, Math.floor(this.capacity()));
  }

  /** Queue a ticket (a ticket with the same key is replaced); `front` puts it first in its lane. */
  submit(t: Ticket, front = false): void {
    this.waiting = this.waiting.filter((w) => w.key !== t.key);
    if (front) this.waiting.unshift(t);
    else this.waiting.push(t);
    if (!this.ring.includes(t.lane)) this.ring.push(t.lane);
    this.kick();
  }

  /** Drop a waiting ticket (no effect on a running one). Returns whether it was waiting. */
  withdraw(key: string): boolean {
    const n = this.waiting.length;
    this.waiting = this.waiting.filter((w) => w.key !== key);
    return this.waiting.length !== n;
  }

  isWaiting(key: string): boolean {
    return this.waiting.some((w) => w.key === key);
  }

  isRunning(key: string): boolean {
    return this.running.has(key);
  }

  /** running keys (of one lane) */
  runningKeys(lane?: string): string[] {
    return [...this.running].filter(([, l]) => lane === undefined || l === lane).map(([k]) => k);
  }

  waitingKeys(lane?: string): string[] {
    return this.waiting.filter((w) => lane === undefined || w.lane === lane).map((w) => w.key);
  }

  /** At most `cap` tickets of this lane run at once (undefined: only the pool's size). */
  setLaneCap(lane: string, cap: number | undefined): void {
    if (cap === undefined) this.laneCaps.delete(lane);
    else this.laneCaps.set(lane, Math.max(1, Math.floor(cap)));
    this.kick();
  }

  /** Take a slot outside any ticket (tests; nothing starts while the pool is full). */
  hold(key: string, lane = 'hold'): boolean {
    if (this.running.size >= this.size || this.running.has(key)) return false;
    this.running.set(key, lane);
    return true;
  }

  release(key: string): void {
    if (this.running.delete(key)) this.kick();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Start what can start (re-entrant calls are folded into one more pass). */
  kick(): void {
    if (this.stopped) return;
    if (this.kicking) {
      this.again = true;
      return;
    }
    this.kicking = true;
    try {
      do {
        this.again = false;
        while (this.running.size < this.size && this.startOne());
      } while (this.again && !this.stopped);
    } finally {
      this.kicking = false;
    }
  }

  private runningIn(lane: string): number {
    let n = 0;
    for (const l of this.running.values()) if (l === lane) n++;
    return n;
  }

  /** Start the next ticket in round-robin order; false when nothing can start. */
  private startOne(): boolean {
    // forget lanes with nothing waiting and nothing running
    this.ring = this.ring.filter((l) => this.waiting.some((w) => w.lane === l) || this.runningIn(l) > 0 || l === this.lastLane);
    if (!this.ring.length) return false;
    const from = this.lastLane === undefined ? 0 : this.ring.indexOf(this.lastLane) + 1;
    for (let i = 0; i < this.ring.length; i++) {
      const lane = this.ring[(from + i) % this.ring.length]!;
      const cap = this.laneCaps.get(lane);
      if (cap !== undefined && this.runningIn(lane) >= cap) continue;
      let t: Ticket | undefined;
      for (const w of this.waiting) {
        if (w.lane !== lane) continue;
        let ok = false;
        try {
          ok = w.ready();
        } catch (e) {
          this.onError(w.key, e);
        }
        if (ok) {
          t = w;
          break;
        }
      }
      if (!t) continue;
      this.waiting = this.waiting.filter((w) => w !== t);
      this.running.set(t.key, lane);
      this.lastLane = lane;
      const ticket = t;
      let p: Promise<unknown>;
      try {
        p = Promise.resolve(ticket.start());
      } catch (e) {
        p = Promise.reject(e);
      }
      p.catch((e) => this.onError(ticket.key, e)).finally(() => {
        if (this.running.get(ticket.key) === lane) this.running.delete(ticket.key);
        this.kick();
      });
      return true;
    }
    return false;
  }
}
