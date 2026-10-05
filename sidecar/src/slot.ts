// One slot shared by the design queue and agent jobs (docs/CONTRACT.md "Jobs (R2)": "Agent jobs
// share the design queue's limit until 4b brings job groups"): one design or one agent job runs
// at a time. Whoever releases it wakes the others (each re-checks its own queue).
export class Slot {
  private holder: string | undefined;
  private listeners = new Set<() => void>();

  get busy(): string | undefined {
    return this.holder;
  }

  tryAcquire(who: string): boolean {
    if (this.holder !== undefined && this.holder !== who) return false;
    this.holder = who;
    return true;
  }

  release(who: string): void {
    if (this.holder !== who) return;
    this.holder = undefined;
    for (const fn of [...this.listeners]) {
      if (this.holder !== undefined) break;
      try {
        fn();
      } catch {
        /* a listener's own problem */
      }
    }
  }

  onFree(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
