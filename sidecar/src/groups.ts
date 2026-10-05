// Design groups (docs/CONTRACT.md phase 4b, "Design groups (A2, R9)" and "4b review folded in"): N designs with one
// style bible, designed together in about the wall time of one.
//
//   - `design.group` creates every item as a design at once (status queued; the request carries group, itemKey, wave,
//     role, bible + bibleVersion) and answers { groupId, designIds, itemKeys }
//   - scheduling: the items are tickets in the pool's lane `group:<g>`, capped at the group's concurrency; an item waits
//     until every item of the earlier waves is final (anchor = wave 0), and while the group is paused or over budget
//   - a usage limit (the shared store.data.limit) holds the whole group: status `held_usage`, every item waits, all
//     resume together after the reset
//   - budget: at `softBudgetFraction` (default 0.8) of budgetUsd the group stops dispatching (`paused_budget`, a reason);
//     `group.extend` sets a new budget and `group.resume` continues. At 100% (the hard cap) queued items are cancelled
//     and running ones stopped, all with error "budget". A running item's own budget is what is left of the group's.
//   - partial results: each item installs when it is done (entries carry `bible` and `group`); a cancel keeps them
//   - the groups and their items persist in state.json (store.data.groups), so ext and itemKey survive a restart
import type { Cost, Design, Group, GroupItem, GroupRequest, GroupStatus, Outbound } from './protocol.js';
import { DesignRequest } from './protocol.js';
import { isFinalDesign } from './designs.js';
import { addCost, zeroCost } from './jobs/cost.js';
import { itemModel } from './estimates.js';
import type { Sidecar } from './sidecar.js';
import { ClientError } from './sidecar.js';

export const GROUP_SNAPSHOT_LIMIT = 20;
const GROUP_KEEP = 100;
const FINAL: ReadonlySet<GroupStatus> = new Set(['done', 'failed', 'cancelled']);
export const isFinalGroup = (g: Group): boolean => FINAL.has(g.status);
const RUNNING = new Set(['designing', 'checking', 'rendering']);

/** A group's own bookkeeping (not sent to clients). */
export interface GroupWork {
  /** the soft budget paused dispatching */
  paused?: boolean;
  /** resumed past the soft budget at this budget (no new pause until the budget changes) */
  softOverride?: number;
  /** cancelled by the client */
  cancelled?: boolean;
}

export class Groups {
  private refreshing = false;
  private again = false;

  constructor(private sc: Sidecar) {}

  private get all(): Group[] {
    return (this.sc.store.data.groups ??= []);
  }

  private work(id: string): GroupWork {
    const w = (this.sc.store.data.groupWork ??= {});
    return (w[id] ??= {});
  }

  get(id: string): Group | undefined {
    return this.all.find((g) => g.id === id);
  }

  list(): Group[] {
    return this.all;
  }

  active(): Group[] {
    return this.all.filter((g) => !isFinalGroup(g));
  }

  /** the last GROUP_SNAPSHOT_LIMIT plus every unfinished one, oldest first */
  recent(): Group[] {
    const tail = this.all.slice(-GROUP_SNAPSHOT_LIMIT);
    const extra = this.active().filter((g) => !tail.includes(g));
    return [...extra, ...tail].sort((a, b) => a.createdAt - b.createdAt).map((g) => structuredClone(g));
  }

  private emit(g: Group): void {
    this.sc.emit({ type: 'group.upsert', group: structuredClone(g) } as Outbound);
  }

  /** After a restart: lane caps back, statuses refreshed (the designs are re-queued by the sidecar). */
  start(): void {
    for (const g of this.active()) this.sc.pool.setLaneCap(`group:${g.id}`, g.concurrency);
    this.refreshActive();
  }

  // ---- create -----------------------------------------------------------------------------------

  /** design.group: validate, pin the bible, create every item as a design and queue them. */
  create(req: GroupRequest): Group {
    const cfg = this.sc.config;
    const pin = this.sc.bibleIndex.resolve(req.bible).pin;
    const id = req.id && /^[a-z0-9_-]{1,64}$/i.test(req.id) && !this.get(req.id) ? req.id : this.sc.store.nextId('g');
    const now = this.sc.now();
    const items: GroupItem[] = [];
    const designs: Design[] = [];
    for (const [i, it] of req.items.entries()) {
      const itemKey = it.itemKey ?? `item${i + 1}`;
      const role = it.role ?? 'ordinary';
      const wave = it.anchor ? 0 : (it.wave ?? 1);
      const model = itemModel(it, cfg.groups);
      const { itemKey: _k, role: _r, anchor: _a, wave: _w, model: _m, ext, owner, budgetUsd: _b, ...base } = it;
      const request = DesignRequest.parse({
        ...base,
        ...(owner ?? req.owner ? { owner: owner ?? req.owner } : {}),
        ...(ext && Object.keys(ext).length ? { ext } : {}),
        model,
        bible: pin.id,
        bibleVersion: pin.version,
        group: id,
        itemKey,
        wave,
        role,
      });
      const d = this.sc.designs.create(request);
      designs.push(d);
      items.push({ itemKey, ...(ext && Object.keys(ext).length ? { ext } : {}), designId: d.id, status: d.status, step: d.step, cost: zeroCost(), wave, role, model, type: request.type, ...(request.name ? { name: request.name } : {}) });
    }
    const g: Group = {
      id,
      name: req.name,
      bible: pin,
      ...(req.owner ? { owner: req.owner } : {}),
      ...(req.ext && Object.keys(req.ext).length ? { ext: req.ext } : {}),
      concurrency: req.concurrency ?? 3,
      ...(req.budgetUsd !== undefined ? { budgetUsd: req.budgetUsd } : {}),
      softBudgetFraction: cfg.groups.softBudgetFraction,
      status: 'queued',
      items,
      designs: items.map((it) => ({ id: it.designId, status: it.status, step: it.step })),
      done: 0,
      failed: 0,
      cost: zeroCost(),
      createdAt: now,
      updatedAt: now,
    };
    this.all.push(g);
    while (this.all.length > GROUP_KEEP) {
      const k = this.all.findIndex((x) => isFinalGroup(x));
      if (k < 0) break;
      const [gone] = this.all.splice(k, 1);
      if (gone) delete this.sc.store.data.groupWork?.[gone.id];
    }
    this.sc.store.markDirty();
    this.sc.pool.setLaneCap(`group:${id}`, g.concurrency);
    this.refresh(g, true);
    this.sc.log.info(`group ${id} "${g.name}": ${items.length} item(s), bible ${pin.id} v${pin.version}, concurrency ${g.concurrency}${g.budgetUsd !== undefined ? `, budget $${g.budgetUsd}` : ''}`);
    for (const d of designs) this.sc.scheduler.enqueue(d.id);
    return g;
  }

  // ---- scheduling ---------------------------------------------------------------------------------

  /** May this design start now? (a single design: yes) */
  itemReady(d: Design): boolean {
    const gid = d.request.group;
    if (!gid) return true;
    const g = this.get(gid);
    if (!g) return true;
    if (isFinalGroup(g)) return false;
    const w = this.work(gid);
    if (w.paused || w.cancelled) return false;
    if (g.budgetUsd !== undefined && g.cost.usd >= g.budgetUsd) return false;
    const wave = d.request.wave ?? 1;
    // a wave starts when every earlier wave is done (or failed)
    return g.items.every((it) => it.wave >= wave || isFinalDesign({ status: this.sc.designs.get(it.designId)?.status ?? 'done' } as Design));
  }

  /** What a group item may still spend (the group's budget minus what the others spent); undefined: no group budget. */
  budgetFor(d: Design): number | undefined {
    const g = d.request.group ? this.get(d.request.group) : undefined;
    if (!g || g.budgetUsd === undefined) return undefined;
    const others = g.items.filter((it) => it.designId !== d.id).reduce((a, it) => a + (this.sc.designs.get(it.designId)?.cost?.usd ?? 0), 0);
    return Math.max(0, Math.round((g.budgetUsd - others) * 1e6) / 1e6);
  }

  /** The finished items of earlier waves (for a design's neighbour renders), newest first. */
  earlierFinished(d: Design): GroupItem[] {
    const g = d.request.group ? this.get(d.request.group) : undefined;
    if (!g) return [];
    const wave = d.request.wave ?? 1;
    return g.items
      .filter((it) => it.wave < wave && it.designId !== d.id && it.entryId && this.sc.designs.get(it.designId)?.status === 'done')
      .sort((a, b) => (this.sc.designs.get(b.designId)?.updatedAt ?? 0) - (this.sc.designs.get(a.designId)?.updatedAt ?? 0));
  }

  // ---- client actions -------------------------------------------------------------------------------

  cancel(id: string): Group {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (isFinalGroup(g)) throw new ClientError(`group ${id} is already ${g.status}`);
    this.work(id).cancelled = true;
    g.reason = 'cancelled';
    this.sc.store.markDirty();
    for (const it of g.items) {
      const d = this.sc.designs.get(it.designId);
      if (d && !isFinalDesign(d)) this.sc.stopDesign(it.designId, 'cancelled', undefined, 'cancelled with its group');
    }
    this.refresh(g);
    this.sc.log.info(`group ${id} cancelled (finished items stay in the library)`);
    return g;
  }

  extend(id: string, budgetUsd: number): Group {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (isFinalGroup(g)) throw new ClientError(`group ${id} is already ${g.status}`);
    if (budgetUsd <= g.cost.usd) throw new ClientError(`the new budget $${budgetUsd} is not above what the group spent ($${g.cost.usd.toFixed(2)})`);
    g.budgetUsd = budgetUsd;
    const w = this.work(id);
    delete w.softOverride;
    this.sc.store.markDirty();
    this.sc.log.info(`group ${id}: budget extended to $${budgetUsd}${w.paused ? ' (still paused: group.resume continues it)' : ''}`);
    this.refresh(g, true);
    return g;
  }

  resume(id: string): Group {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (isFinalGroup(g)) throw new ClientError(`group ${id} is already ${g.status}`);
    const w = this.work(id);
    if (w.paused) {
      w.paused = false;
      // past the soft budget already: no new pause until the budget changes (the hard cap still holds)
      if (g.budgetUsd !== undefined && g.cost.usd >= g.softBudgetFraction * g.budgetUsd) w.softOverride = g.budgetUsd;
      delete g.reason;
      this.sc.store.markDirty();
      this.sc.log.info(`group ${id} resumed`);
    }
    this.refresh(g, true);
    this.sc.pool.kick();
    return g;
  }

  // ---- state ----------------------------------------------------------------------------------------

  /** A design changed: its group (if any) follows. */
  designChanged(d: Design): void {
    const gid = d.request.group;
    if (!gid) return;
    const g = this.get(gid);
    if (g) this.refresh(g);
  }

  /** The usage limit or the clock changed: every unfinished group re-derives its status. */
  refreshActive(): void {
    for (const g of this.active()) this.refresh(g);
  }

  /**
   * Re-derive a group from its designs: items, cost, counts, budget (soft pause, hard stop), status. Emits group.upsert
   * when anything changed (or `force`). Re-entrant calls (a hard stop cancels designs, which report back) fold into one
   * more pass.
   */
  refresh(g: Group, force = false): void {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refreshing = true;
    try {
      let emit = force;
      do {
        this.again = false;
        if (this.derive(g)) emit = true;
      } while (this.again);
      if (emit) {
        g.updatedAt = this.sc.now();
        this.sc.store.markDirty();
        this.emit(g);
        if (isFinalGroup(g)) this.sc.log.info(`group ${g.id} ${g.status}: ${g.done} done, ${g.failed} failed, $${g.cost.usd.toFixed(4)}`);
      }
    } finally {
      this.refreshing = false;
    }
    // a wave may have opened, a pause lifted
    this.sc.pool.kick();
  }

  /** One pass; returns whether the group changed. */
  private derive(g: Group): boolean {
    const before = JSON.stringify(g);
    if (isFinalGroup(g)) return false;
    const w = this.work(g.id);
    let cost: Cost = zeroCost();
    for (const it of g.items) {
      const d = this.sc.designs.get(it.designId);
      if (!d) continue;
      it.status = d.status;
      it.step = d.step;
      it.cost = d.cost ?? zeroCost();
      if (d.blueprintId) it.entryId = d.blueprintId;
      if (d.error) it.error = d.error;
      cost = addCost(cost, it.cost);
    }
    g.cost = cost;
    g.designs = g.items.map((it) => ({ id: it.designId, status: it.status, step: it.step }));
    g.done = g.items.filter((it) => it.status === 'done').length;
    g.failed = g.items.filter((it) => it.status === 'failed' || it.status === 'cancelled').length;
    const open = g.items.filter((it) => !isFinalDesign({ status: it.status } as Design));
    const waves = open.map((it) => it.wave);
    if (waves.length) g.wave = Math.min(...waves);
    else delete g.wave;
    // budget: the hard cap stops everything left, the soft one pauses dispatching
    if (g.budgetUsd !== undefined && open.length) {
      if (g.cost.usd >= g.budgetUsd) {
        g.reason = 'budget';
        for (const it of open) this.sc.stopDesign(it.designId, 'budget', 'budget', `stopped: the group budget ($${g.budgetUsd}) is spent`);
        this.again = true;
      } else if (!w.paused && w.softOverride !== g.budgetUsd && g.cost.usd >= g.softBudgetFraction * g.budgetUsd) {
        w.paused = true;
        g.reason = `soft budget: $${g.cost.usd.toFixed(2)} of $${g.budgetUsd} spent (${Math.round(g.softBudgetFraction * 100)}% reached); extend the budget or resume`;
        this.sc.log.warn(`group ${g.id} paused: ${g.reason}`);
      }
    }
    const limit = this.sc.store.data.limit;
    const limited = !!limit && limit.until > this.sc.now();
    let status: GroupStatus;
    if (!open.length) status = w.cancelled ? 'cancelled' : g.done > 0 ? 'done' : 'failed';
    else if (w.cancelled) status = 'cancelled';
    else if (w.paused) status = 'paused_budget';
    else if (limited) status = 'held_usage';
    else if (open.some((it) => RUNNING.has(it.status))) status = 'running';
    else status = 'queued';
    g.status = status;
    if (status === 'held_usage' && limit) g.usageLimitUntil = limit.until;
    else delete g.usageLimitUntil;
    if (status === 'failed' && !g.reason) g.reason = g.items.find((it) => it.error)?.error?.split('\n')[0] ?? 'every item failed';
    // a soft-budget reason only describes paused_budget: clear it on any other status (a group that finished while paused kept it)
    if (status !== 'paused_budget' && g.reason && g.reason.startsWith('soft budget')) delete g.reason;
    return JSON.stringify(g) !== before;
  }
}
