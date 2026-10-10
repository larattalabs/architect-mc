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
//
// Phase 4c (docs/CONTRACT.md "Phase 4c contract" and "4c review folded in"):
//   - `context` goes into every item's brief (massing and detail)
//   - massingFirst: every item starts as a massing job (stage `massing`), in waves like designs. A finished massing
//     waits for the caller (stage `approval`); once no massing of the group is open, the group is `awaiting_approval`
//     (`awaiting` lists the items). `group.approve { approve, redirect, cancel }` starts detail passes (stage `detail`,
//     bound to the item's latest massing version), makes new massing versions from notes (at most maxRedirects per item,
//     counted in `rounds`) or drops items. approvalUi "owner": only a group.approve naming the group's owner counts.
//   - an item's cost is every design it made (massings, redirects, the detail), so they count toward the group's
//     aggregate and its soft/hard budget; superseded designs' cost is committed to the item (state.json trims old designs)
//   - status precedence: cancelled > awaiting_approval (an item waits and no massing is open) > paused_budget >
//     held_usage > running > queued
import type { Cost, Design, DesignRequest as DesignRequestT, Group, GroupItem, GroupRequest, GroupStatus, Massing, Outbound } from './protocol.js';
import { DesignRequest } from './protocol.js';
import { isFinalDesign } from './designs.js';
import { addCost, zeroCost } from './jobs/cost.js';
import { itemModel } from './estimates.js';
import { expandItems, itemCritique, withNote } from './copies.js';
import { RefusedError } from './errors.js';
import type { Sidecar } from './sidecar.js';
import { ClientError } from './sidecar.js';

export const GROUP_SNAPSHOT_LIMIT = 20;
const GROUP_KEEP = 100;
const FINAL: ReadonlySet<GroupStatus> = new Set(['done', 'failed', 'cancelled']);
export const isFinalGroup = (g: Group): boolean => FINAL.has(g.status);
const RUNNING = new Set(['designing', 'checking', 'rendering', 'critiquing']);

/** A group's own bookkeeping (not sent to clients). */
export interface GroupWork {
  /** the soft budget paused dispatching */
  paused?: boolean;
  /** resumed past the soft budget at this budget (no new pause until the budget changes) */
  softOverride?: number;
  /** cancelled by the client */
  cancelled?: boolean;
  /** (4c) item key -> its request without the massing fields (the detail pass and every redirect start from it) */
  itemRequests?: Record<string, DesignRequestT>;
  /** (4c) item key -> the cost of its superseded designs (massings and redirects before the current one) */
  itemCost?: Record<string, Cost>;
  /** (4c) item key -> it ended without a design to say so (dropped or cancelled while awaiting approval, the hard budget) */
  ended?: Record<string, 'cancelled' | 'budget'>;
  /** (0b) copy item key -> its place among its archetype's copies */
  ordinals?: Record<string, number>;
}

const FINAL_DESIGN = new Set(['done', 'failed', 'cancelled']);

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
    const itemRequests: Record<string, DesignRequestT> = {};
    // (0b) count / copyOf / copyCap: the placements (originals and copies); refusals before anything is created
    const expanded = expandItems(req);
    const waveOf = new Map<string, number>();
    const ordinals: Record<string, number> = {};
    for (const e of expanded) {
      const it = e.input;
      const itemKey = e.itemKey;
      const role = it.role ?? 'ordinary';
      const wave = e.kind === 'copy' ? (waveOf.get(e.copyOf!) ?? 1) : it.anchor ? 0 : (it.wave ?? 1);
      waveOf.set(itemKey, wave);
      const model = itemModel(it, cfg.groups);
      const { itemKey: _k, role: _r, anchor: _a, wave: _w, model: _m, ext, owner, budgetUsd: _b, critique: ownCritique, ...base } = it;
      // (5a) the item's critique wins over the group's default; (0b, C2) a small item drops the default report critique
      const critique = itemCritique(ownCritique, req.critique, e.effort);
      const request = withNote(
        DesignRequest.parse({
          ...base,
          ...(critique && critique.mode !== 'off' ? { critique } : {}),
          ...(owner ?? req.owner ? { owner: owner ?? req.owner } : {}),
          ...(ext && Object.keys(ext).length ? { ext } : {}),
          model,
          bible: pin.id,
          bibleVersion: pin.version,
          group: id,
          itemKey,
          wave,
          role,
          ...(req.context !== undefined ? { context: req.context } : {}),
          ...(e.effort === 'small' ? { effort: 'small' as const } : {}),
        }),
        e.note,
      );
      const small = e.effort === 'small' ? { effort: 'small' as const } : {};
      // (0b) a copy has no design: it waits for its archetype, then builds on the variant queue ($0)
      if (e.kind === 'copy') {
        itemRequests[itemKey] = request;
        ordinals[itemKey] = e.ordinal!;
        items.push({
          itemKey,
          ...(ext && Object.keys(ext).length ? { ext } : {}),
          designId: '',
          status: 'queued',
          step: `waiting for ${e.copyOf} (a copy)`,
          cost: zeroCost(),
          wave,
          role,
          model,
          type: request.type,
          ...(request.name ? { name: request.name } : {}),
          stage: 'copy' as const,
          kind: 'copy' as const,
          copyOf: e.copyOf!,
          ...small,
        });
        continue;
      }
      // (4c) massing first: the item's first design is its massing (the massing model); the detail pass comes at approval
      let d: Design;
      if (req.massingFirst) {
        itemRequests[itemKey] = request;
        // (5a) the critique belongs to the detail pass, not the item's massing
        const { critique: _c, effort: _ef, ...noCritique } = request;
        const mreq: DesignRequestT = { ...noCritique, massing: true, model: cfg.massing.model };
        d = this.sc.designs.create(mreq, { id: this.sc.massings.reserveId(mreq), version: 1 });
      } else {
        // (0b) an archetype's request is kept: a copy that falls back designs from it
        if (expanded.some((x) => x.copyOf === itemKey)) itemRequests[itemKey] = request;
        d = this.sc.designs.create(request);
      }
      designs.push(d);
      items.push({
        itemKey,
        ...(ext && Object.keys(ext).length ? { ext } : {}),
        designId: d.id,
        status: d.status,
        step: d.step,
        cost: zeroCost(),
        wave,
        role,
        model,
        type: request.type,
        ...(request.name ? { name: request.name } : {}),
        ...(req.massingFirst ? { stage: 'massing' as const, massing: { ...d.massing! }, rounds: 0, designIds: [d.id] } : {}),
        ...small,
      });
    }
    const copies = expanded.filter((e) => e.kind === 'copy');
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
      ...(req.massingFirst ? { massingFirst: true, approvalUi: req.approvalUi ?? 'architect', maxRedirects: req.maxRedirects ?? cfg.massing.maxRedirects, awaiting: [] } : req.approvalUi ? { approvalUi: req.approvalUi } : {}),
      ...(req.context !== undefined ? { context: req.context } : {}),
      ...(req.copyCap !== undefined ? { copyCap: req.copyCap } : copies.length ? { copyCap: 3 } : {}),
      ...(req.smallBySize ? { smallBySize: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    if (Object.keys(itemRequests).length) this.work(id).itemRequests = itemRequests;
    if (copies.length) this.work(id).ordinals = ordinals;
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
    this.sc.log.info(`group ${id} "${g.name}": ${items.length} item(s)${copies.length ? ` (${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}, cap ${g.copyCap})` : ''}, bible ${pin.id} v${pin.version}, concurrency ${g.concurrency}${g.budgetUsd !== undefined ? `, budget $${g.budgetUsd}` : ''}${g.massingFirst ? `, massing first (approval: ${g.approvalUi}, ${g.maxRedirects} redirect(s) per item)` : ''}`);
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
    // (5a) a revision after critique starts even in a paused group: it then ends its loop with "budget" at once
    if (this.sc.critiques.revising(d.id) && !w.cancelled) return true;
    if (w.paused || w.cancelled) return false;
    if (g.budgetUsd !== undefined && g.cost.usd >= g.budgetUsd) return false;
    const wave = d.request.wave ?? 1;
    // a wave starts when every earlier wave is done (or failed)
    return g.items.every((it) => it.wave >= wave || isFinalDesign({ status: this.sc.designs.get(it.designId)?.status ?? 'done' } as Design));
  }

  /** (5a) Is this design's group paused by its soft budget (or out of budget)? Critique rounds are dropped first. */
  pausedFor(d: Design): boolean {
    const g = d.request.group ? this.get(d.request.group) : undefined;
    if (!g) return false;
    const w = this.work(g.id);
    return !!w.paused || (g.budgetUsd !== undefined && g.cost.usd >= g.softBudgetFraction * g.budgetUsd && w.softOverride !== g.budgetUsd);
  }

  /** What a group item may still spend (the group's budget minus what the others spent); undefined: no group budget. */
  budgetFor(d: Design): number | undefined {
    const g = d.request.group ? this.get(d.request.group) : undefined;
    if (!g || g.budgetUsd === undefined) return undefined;
    // every other design of the group (their current designs live, superseded ones committed), and this item's past ones
    const committed = Object.values(this.work(g.id).itemCost ?? {}).reduce((a, c) => a + c.usd, 0);
    const others = g.items.filter((it) => it.designId !== d.id).reduce((a, it) => a + (this.sc.designs.get(it.designId)?.cost?.usd ?? 0), 0);
    return Math.max(0, Math.round((g.budgetUsd - others - committed) * 1e6) / 1e6);
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

  /** (4c) a massing job's neighbours: the latest massings of the earlier waves' items, newest first. */
  earlierMassings(d: Design): Massing[] {
    const g = d.request.group ? this.get(d.request.group) : undefined;
    if (!g?.massingFirst) return [];
    const wave = d.request.wave ?? 1;
    return g.items
      .filter((it) => it.wave < wave && it.massing && it.stage !== 'massing')
      .flatMap((it) => {
        const m = this.sc.massings.get(it.massing!.id, it.massing!.version);
        return m ? [m] : [];
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---- client actions -------------------------------------------------------------------------------

  /**
   * (4c) group.approve: start the detail pass of `approve`, make a new massing version of each `redirect` item from its
   * notes, drop `cancel` items. Validated as a whole before anything is applied. With approvalUi "owner", only the
   * group's owner may approve.
   */
  approve(id: string, a: { approve: string[]; redirect: Record<string, string>; cancel: string[]; owner?: string | undefined }): { groupId: string; approved: Record<string, string>; redirected: Record<string, { designId: string; version: number }>; cancelled: string[] } {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (!g.massingFirst) throw new ClientError(`group ${id} was not made with massingFirst: there is nothing to approve`);
    if (isFinalGroup(g)) throw new ClientError(`group ${id} is already ${g.status}`);
    if (g.approvalUi === 'owner' && a.owner !== g.owner) throw new ClientError(`group ${id} is approved by its owner only (approvalUi "owner"; owner ${g.owner}${a.owner ? `, not ${a.owner}` : ''})`);
    const w = this.work(id);
    const redirectKeys = Object.keys(a.redirect);
    const all = [...a.approve, ...redirectKeys, ...a.cancel];
    if (!all.length) throw new ClientError('group.approve needs approve, redirect or cancel');
    if (new Set(all).size !== all.length) throw new ClientError('an item may be approved, redirected or cancelled, only one of them, once');
    const item = (key: string) => {
      const it = g.items.find((x) => x.itemKey === key);
      if (!it) throw new ClientError(`group ${id} has no item "${key}"`);
      return it;
    };
    const awaits = (it: GroupItem) => it.stage === 'approval' && !w.ended?.[it.itemKey];
    for (const key of [...a.approve, ...redirectKeys]) {
      const it = item(key);
      if (!awaits(it)) throw new ClientError(`item ${key} is not awaiting approval (${w.ended?.[key] ?? it.stage ?? it.status})`);
      if (!w.itemRequests?.[key]) throw new ClientError(`item ${key} has lost its request (state.json from an older sidecar?)`);
    }
    for (const key of redirectKeys) {
      const it = item(key);
      const max = g.maxRedirects ?? this.sc.config.massing.maxRedirects;
      if ((it.rounds ?? 0) >= max) throw new ClientError(`item ${key} has used its ${max} redirect round${max === 1 ? '' : 's'}: approve or cancel it`);
    }
    for (const key of a.cancel) {
      const it = item(key);
      if (w.ended?.[key] || (it.stage !== 'approval' && FINAL_DESIGN.has(it.status))) throw new ClientError(`item ${key} has already ended (${it.status})`);
    }
    if ((a.approve.length || redirectKeys.length) && g.budgetUsd !== undefined && g.cost.usd >= g.budgetUsd) throw new ClientError(`the group budget ($${g.budgetUsd}) is spent: extend it first`);
    const out = { groupId: id, approved: {} as Record<string, string>, redirected: {} as Record<string, { designId: string; version: number }>, cancelled: [] as string[] };
    const moveOn = (it: GroupItem, d: Design) => {
      // the superseded design's cost stays with the item (old designs are trimmed from state.json)
      const prev = this.sc.designs.get(it.designId);
      if (prev?.cost) (w.itemCost ??= {})[it.itemKey] = addCost(w.itemCost?.[it.itemKey] ?? zeroCost(), prev.cost);
      it.designId = d.id;
      it.designIds = [...(it.designIds ?? []), d.id];
      it.status = d.status;
      it.step = d.step;
      delete it.error;
    };
    for (const key of a.approve) {
      const it = item(key);
      const req: DesignRequestT = { ...w.itemRequests![key]!, fromMassing: it.massing!.id, massingVersion: it.massing!.version };
      const d = this.sc.designs.create(req);
      moveOn(it, d);
      it.stage = 'detail';
      out.approved[key] = d.id;
      this.sc.log.info(`group ${id}: ${key} approved (massing ${it.massing!.id} v${it.massing!.version}); detail pass ${d.id}`);
    }
    for (const [key, notes] of Object.entries(a.redirect)) {
      const it = item(key);
      const { critique: _c, ...noCritique } = w.itemRequests![key]!;
      const req: DesignRequestT = { ...noCritique, massing: true, model: this.sc.config.massing.model, redirect: { fromVersion: it.massing!.version, notes } };
      const version = this.sc.massings.nextVersion(it.massing!.id);
      const d = this.sc.designs.create(req, { id: it.massing!.id, version });
      moveOn(it, d);
      it.stage = 'massing';
      it.rounds = (it.rounds ?? 0) + 1;
      out.redirected[key] = { designId: d.id, version };
      this.sc.log.info(`group ${id}: ${key} redirected (round ${it.rounds}): massing ${it.massing!.id} v${version} (${d.id})`);
    }
    for (const key of a.cancel) {
      const it = item(key);
      (w.ended ??= {})[key] = 'cancelled';
      const d = this.sc.designs.get(it.designId);
      if (d && !isFinalDesign(d)) this.sc.stopDesign(d.id, 'cancelled', undefined, 'cancelled with its group item');
      out.cancelled.push(key);
    }
    this.sc.store.markDirty();
    this.refresh(g, true);
    for (const d of [...Object.values(out.approved), ...Object.values(out.redirected).map((r) => r.designId)]) this.sc.scheduler.enqueue(d);
    return out;
  }

  cancel(id: string): Group {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (isFinalGroup(g)) throw new ClientError(`group ${id} is already ${g.status}`);
    this.work(id).cancelled = true;
    g.reason = 'cancelled';
    this.sc.store.markDirty();
    for (const it of g.items) {
      // (0b) a copy: a queued variant is dropped; one building finishes (its entry stays in the library, as a finished item's)
      if (it.kind === 'copy') {
        if (!['done', 'failed', 'cancelled'].includes(it.status)) (this.work(id).ended ??= {})[it.itemKey] = 'cancelled';
        if (it.variantJob && this.sc.variants.get(it.variantJob)?.status === 'queued') this.sc.variants.update(it.variantJob, { status: 'failed', step: 'cancelled with its group', error: 'cancelled' });
        continue;
      }
      const d = it.designId ? this.sc.designs.get(it.designId) : undefined;
      if (d && !isFinalDesign(d)) this.sc.stopDesign(it.designId, 'cancelled', undefined, 'cancelled with its group');
      // (4c) an item awaiting approval has no design left to cancel
      if (it.stage === 'approval') (this.work(id).ended ??= {})[it.itemKey] ??= 'cancelled';
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
    // (0b) copies: start the ones whose archetype is done, fail the ones whose archetype ended, fall back
    if (!isFinalGroup(g) && this.advanceCopies(g)) this.refresh(g, true);
    // a wave may have opened, a pause lifted
    this.sc.pool.kick();
  }

  // ---- (0b) copies ----------------------------------------------------------------------------------

  /** A copy item's state from its variant job (and its end, when it was cancelled). */
  private syncCopy(g: Group, it: GroupItem): void {
    const w = this.work(g.id);
    const ended = w.ended?.[it.itemKey];
    const v = it.variantJob ? this.sc.variants.get(it.variantJob) : undefined;
    if (v) {
      if (v.status === 'done' && v.blueprintId) {
        it.status = 'done';
        it.entryId = v.blueprintId;
        it.step = v.step;
        if (v.copy?.recipe) it.recipe = v.copy.recipe;
      } else if (v.status === 'failed') {
        // a failed variant with a fallback reason becomes a FALLBACK original (advanceCopies); until then it is building
        if (!v.copy?.fallbackReason) {
          it.status = ended ? 'cancelled' : 'failed';
          it.error = v.error ?? 'the copy failed';
          it.step = v.step;
        }
      } else if (!ended) {
        it.status = v.status === 'queued' ? 'queued' : 'checking';
        it.step = v.step;
      }
    }
    if (ended && it.status !== 'done') {
      it.status = 'cancelled';
      it.step = 'cancelled with its group';
    }
  }

  /** Start, fail or fall back copies; returns whether anything changed. */
  private advanceCopies(g: Group): boolean {
    const w = this.work(g.id);
    let changed = false;
    for (const it of g.items) {
      if (it.kind !== 'copy' || w.ended?.[it.itemKey]) continue;
      if (['done', 'failed', 'cancelled'].includes(it.status) && !it.variantJob) continue;
      const arch = g.items.find((x) => x.itemKey === it.copyOf);
      if (!it.variantJob) {
        if (!arch) continue;
        const archEnded = !!w.ended?.[arch.itemKey] || arch.status === 'failed' || arch.status === 'cancelled';
        if (arch.status === 'done' && arch.entryId && (arch.stage === undefined || arch.stage === 'detail')) {
          const v = this.sc.requestCopy(g, it, arch, w.ordinals?.[it.itemKey] ?? 1);
          it.variantJob = v.id;
          it.status = 'checking';
          it.step = `building the copy of ${arch.entryId}`;
          changed = true;
        } else if (archEnded) {
          it.status = 'failed';
          it.error = 'source_failed';
          it.step = `failed: its archetype ${arch.itemKey} ${w.ended?.[arch.itemKey] ?? arch.status} (source_failed)`;
          changed = true;
        }
        continue;
      }
      const v = this.sc.variants.get(it.variantJob);
      if (v?.status === 'failed' && v.copy?.fallbackReason) {
        this.fallBack(g, it, `${v.copy.fallbackReason}: ${(v.error ?? '').split('\n')[0]}`.slice(0, 300));
        changed = true;
      }
    }
    if (changed) this.sc.store.markDirty();
    return changed;
  }

  /** A copy becomes a FALLBACK original: under massingFirst the detail pass of its archetype's approved massing. */
  private fallBack(g: Group, it: GroupItem, reason: string): void {
    const w = this.work(g.id);
    const base = w.itemRequests?.[it.itemKey];
    if (!base) {
      it.status = 'failed';
      it.error = `fallback: the item has lost its request (${reason})`;
      return;
    }
    const arch = g.items.find((x) => x.itemKey === it.copyOf);
    const req: DesignRequestT = g.massingFirst && arch?.massing ? { ...base, fromMassing: arch.massing.id, massingVersion: arch.massing.version } : base;
    const d = this.sc.designs.create(req);
    it.kind = 'fallback';
    it.designId = d.id;
    it.designIds = [...(it.designIds ?? []), d.id];
    it.status = d.status;
    it.step = d.step;
    it.fallbackReason = reason;
    delete it.entryId;
    delete it.error;
    delete it.recipe;
    if (g.massingFirst) it.stage = 'detail';
    else delete it.stage;
    this.sc.log.info(`group ${g.id}: ${it.itemKey} falls back to an original (${reason}); design ${d.id}${g.massingFirst && arch?.massing ? ` bound to massing ${arch.massing.id} v${arch.massing.version}` : ''}`);
    this.sc.scheduler.enqueue(d.id);
  }

  /**
   * (0b) promoteCopy: a copy that did not fit at placement becomes a FALLBACK original. Refused for a non-copy, a copy
   * still building, or a final group.
   */
  promoteCopy(id: string, itemKey: string, reason: string): Group {
    const g = this.get(id);
    if (!g) throw new ClientError(`no group "${id}"`);
    if (isFinalGroup(g)) throw new RefusedError('COPY_REFUSED', 'final', `group ${id} is already ${g.status}`);
    const it = g.items.find((x) => x.itemKey === itemKey);
    if (!it) throw new ClientError(`group ${id} has no item "${itemKey}"`);
    if (it.kind !== 'copy') throw new RefusedError('COPY_REFUSED', 'not_copy', `item ${itemKey} is not a copy (${it.kind ?? 'original'})`);
    if (this.work(id).ended?.[itemKey]) throw new RefusedError('COPY_REFUSED', 'final', `item ${itemKey} was cancelled`);
    if (it.status !== 'done' && it.status !== 'failed') throw new RefusedError('COPY_REFUSED', 'building', `item ${itemKey} is still building (${it.status})`);
    this.fallBack(g, it, `promoted: ${reason}`);
    this.sc.store.markDirty();
    this.refresh(g, true);
    return g;
  }

  /** (0b) What a copy's variant job needs from its group at run time: the recipes of its archetype's earlier copies. */
  copySiblings(groupId: string, archetype: string, ordinal: number): Array<Record<string, unknown>> {
    const g = this.get(groupId);
    if (!g) return [];
    const w = this.work(groupId);
    return g.items
      .filter((x) => x.kind === 'copy' && x.copyOf === archetype && (w.ordinals?.[x.itemKey] ?? 0) < ordinal)
      .sort((a, b) => (w.ordinals?.[a.itemKey] ?? 0) - (w.ordinals?.[b.itemKey] ?? 0))
      .flatMap((x) => {
        const r = x.recipe ?? (x.variantJob ? this.sc.variants.get(x.variantJob)?.copy?.recipe : undefined);
        return r ? [r] : [];
      });
  }

  /** (0b) A variant changed: a copy's group follows. */
  variantChanged(v: { copy?: { group: string } | undefined }): void {
    const g = v.copy ? this.get(v.copy.group) : undefined;
    if (g) this.refresh(g);
  }

  /** One pass; returns whether the group changed. */
  private derive(g: Group): boolean {
    const before = JSON.stringify(g);
    if (isFinalGroup(g)) return false;
    const w = this.work(g.id);
    let cost: Cost = zeroCost();
    for (const it of g.items) {
      // (0b) a copy follows its variant job
      if (it.kind === 'copy') {
        this.syncCopy(g, it);
        continue;
      }
      const d = it.designId ? this.sc.designs.get(it.designId) : undefined;
      const committed = w.itemCost?.[it.itemKey] ?? zeroCost();
      if (d) {
        it.status = d.status;
        it.step = d.step;
        it.cost = addCost(committed, d.cost ?? zeroCost());
        if (d.blueprintId) it.entryId = d.blueprintId;
        if (d.error) it.error = d.error;
        if (d.critique) it.critique = { rounds: d.critique.rounds.length, ...(d.critique.best !== undefined ? { best: d.critique.best } : {}), ...(d.critique.end ? { end: d.critique.end } : {}), ...(d.critique.overall !== undefined ? { overall: d.critique.overall } : {}) };
        // (4c) a finished massing (or redirect) waits for approval
        if (it.stage === 'massing' && d.status === 'done' && d.massing) {
          it.stage = 'approval';
          it.massing = { ...d.massing };
          it.step = `massing v${d.massing.version} ready: awaiting approval`;
        }
      }
      const ended = w.ended?.[it.itemKey];
      if (ended && it.stage === 'approval') {
        it.status = 'cancelled';
        it.step = ended === 'budget' ? 'stopped: the group budget is spent' : 'cancelled (not approved)';
        if (ended === 'budget') it.error = 'budget';
      }
      cost = addCost(cost, it.cost);
    }
    g.cost = cost;
    g.designs = g.items.map((it) => ({ id: it.designId, status: it.status, step: it.step }));
    // an item is open while its design is, or while it awaits approval
    const isOpen = (it: GroupItem) => !w.ended?.[it.itemKey] && (it.stage === 'approval' || !FINAL_DESIGN.has(it.status));
    g.done = g.items.filter((it) => it.status === 'done' && (it.stage === undefined || it.stage === 'detail' || it.stage === 'copy')).length;
    g.failed = g.items.filter((it) => !isOpen(it) && (it.status === 'failed' || it.status === 'cancelled')).length;
    const open = g.items.filter(isOpen);
    const waves = open.map((it) => it.wave);
    if (waves.length) g.wave = Math.min(...waves);
    else delete g.wave;
    if (g.massingFirst) g.awaiting = open.filter((it) => it.stage === 'approval').map((it) => it.itemKey);
    // budget: the hard cap stops everything left, the soft one pauses dispatching
    if (g.budgetUsd !== undefined && open.some((it) => it.kind !== 'copy')) {
      if (g.cost.usd >= g.budgetUsd) {
        g.reason = 'budget';
        for (const it of open) {
          if (it.stage === 'approval') (w.ended ??= {})[it.itemKey] = 'budget';
          // (0b) copies cost nothing: they go on (a copy whose archetype is stopped fails with source_failed)
          else if (it.kind === 'copy') continue;
          else this.sc.stopDesign(it.designId, 'budget', 'budget', `stopped: the group budget ($${g.budgetUsd}) is spent`);
        }
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
    const awaiting = g.awaiting?.length && !open.some((it) => it.stage === 'massing');
    if (!open.length) status = w.cancelled ? 'cancelled' : g.done > 0 ? 'done' : 'failed';
    else if (w.cancelled) status = 'cancelled';
    else if (awaiting) status = 'awaiting_approval';
    else if (w.paused) status = 'paused_budget';
    else if (limited) status = 'held_usage';
    else if (open.some((it) => RUNNING.has(it.status))) status = 'running';
    else status = 'queued';
    if (status === 'awaiting_approval' && g.status !== 'awaiting_approval') this.sc.log.info(`group ${g.id} awaits approval: ${g.awaiting!.join(', ')}`);
    g.status = status;
    if (status === 'held_usage' && limit) g.usageLimitUntil = limit.until;
    else delete g.usageLimitUntil;
    if (status === 'failed' && !g.reason) g.reason = g.items.find((it) => it.error)?.error?.split('\n')[0] ?? 'every item failed';
    // a soft-budget reason only describes paused_budget: clear it on any other status (a group that finished while paused kept it)
    if (status !== 'paused_budget' && status !== 'awaiting_approval' && g.reason && g.reason.startsWith('soft budget')) delete g.reason;
    return JSON.stringify(g) !== before;
  }
}
