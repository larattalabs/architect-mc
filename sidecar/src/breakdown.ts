// (6c 0a, C7; docs/CONTRACT.md "Phase 6c slice 0a" §7) A group's cost and time per stage, its `seq` and `lastAction`.
//
// Stages: MASSING = the first round of each massing (every version), DETAIL = the first design round of each detail pass,
// REPAIR = rounds 2 and later of both, CRITIQUE = critic calls and loop revisions, QUEUED and USAGE_HOLD = time only; BIBLE =
// the job(s) that made the pinned bible version, counted in the first group of the same owner that pins it (later groups
// show 0), listing the job ids. A design's first round is what its turn cost was while its round was 1 and it was not
// revising (DesignWork.r1Usd, set by Sidecar.designCost); critique is Design.critique.cost (critic + revise); repair is the
// rest. Each design's figures are kept in the group's work, so they outlive the design records state.json trims.
// `ms` is summed item time, attributed at each refresh by the item's state since the last one.
//
// `seq` goes up only when a transition field changes: the status, the reason, the wave, the awaiting set, or an item's
// status, stage, entryId, massing version or rounds. Cost, step text and updatedAt never bump it.
import type { Design, Group, GroupItem } from './protocol.js';
import type { Sidecar } from './sidecar.js';

type Stage = 'bible' | 'massing' | 'detail' | 'repair' | 'critique' | 'queued' | 'usage_hold' | 'copy';
interface DesignFig {
  kind: 'massing' | 'detail';
  first: number;
  repair: number;
  critique: number;
  repairs: number;
  critics: number;
  ms: number;
  repairMs: number;
  critiqueMs: number;
}
export interface BreakdownWork {
  designs: Record<string, DesignFig>;
  items: Record<string, { queuedMs: number; holdMs: number; copyMs?: number; state?: ItemState; designId?: string }>;
  lastTick: number;
  firstDetailedAt?: number;
  bible?: { usd: number; ms: number; jobIds: string[] };
  seq?: number;
  sig?: string;
  /** an explicit action (approved, redirected, extended, resumed, cancelled) for the next transition */
  action?: string;
  /** the transition fields of the last bump, per item (to name the action) */
  prev?: { status: string; items: Record<string, { status: string; stage?: string }> };
}
type ItemState = 'queued' | 'held' | 'active' | 'repair' | 'critiquing' | 'copy' | 'other';

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const RUN = new Set(['designing', 'checking', 'rendering']);

/** The round a design is in (the sim's own counter, else the Claude designer's turns). */
export function designRound(sc: Sidecar, id: string): number {
  const w = sc.store.data.work?.[id];
  return w?.sim?.round ?? (w?.round || 1);
}

/** The bible line of a new group: the jobs that made its pinned version, if it is the owner's first group to pin it. */
export function bibleLine(sc: Sidecar, g: Group): BreakdownWork['bible'] {
  const claims = (sc.store.data.bibleClaims ??= {});
  const k = `${g.bible.id}@${g.bible.version}|${g.owner ?? ''}`;
  if (claims[k] && claims[k] !== g.id) return { usd: 0, ms: 0, jobIds: [] };
  claims[k] = g.id;
  const jobs = sc.bibles.list().filter((j) => j.bibleId === g.bible.id && j.version === g.bible.version && j.status === 'done');
  return { usd: r6(jobs.reduce((a, j) => a + j.cost.usd, 0)), ms: jobs.reduce((a, j) => a + Math.max(0, j.updatedAt - j.createdAt), 0), jobIds: jobs.map((j) => j.id) };
}

/** Update a design's figures from its record (while it exists). */
function figure(sc: Sidecar, d: Design, prev: DesignFig | undefined): DesignFig {
  const crit = d.critique?.cost;
  const critique = r6((crit?.critic.usd ?? 0) + (crit?.revise.usd ?? 0));
  const total = d.cost?.usd ?? 0;
  const w = sc.store.data.work?.[d.id];
  const first = r6(Math.min(Math.max(0, total - critique), w?.r1Usd ?? Math.max(0, total - critique)));
  const repair = r6(Math.max(0, total - critique - first));
  const round = designRound(sc, d.id);
  return {
    kind: d.massing ? 'massing' : 'detail',
    first,
    repair,
    critique,
    repairs: Math.max(0, round - 1),
    critics: d.critique?.rounds.length ?? 0,
    ms: prev?.ms ?? 0,
    repairMs: prev?.repairMs ?? 0,
    critiqueMs: prev?.critiqueMs ?? 0,
  };
}

/**
 * Refresh a group's breakdown (call from derive, after the items were updated). `limited`: a usage limit holds new turns.
 */
export function updateBreakdown(sc: Sidecar, g: Group, bw: BreakdownWork, limited: boolean, isOpen: (it: GroupItem) => boolean): void {
  const now = sc.now();
  const dt = Math.max(0, now - (bw.lastTick || g.createdAt));
  bw.lastTick = now;
  for (const it of g.items) {
    const iw = (bw.items[it.itemKey] ??= { queuedMs: 0, holdMs: 0 });
    // the time since the last refresh goes to the state the item was in
    if (dt && iw.state) {
      const f = iw.designId ? bw.designs[iw.designId] : undefined;
      if (iw.state === 'queued') iw.queuedMs += dt;
      else if (iw.state === 'held') iw.holdMs += dt;
      else if (iw.state === 'copy') iw.copyMs = (iw.copyMs ?? 0) + dt;
      else if (f && iw.state === 'active') f.ms += dt;
      else if (f && iw.state === 'repair') f.repairMs += dt;
      else if (f && iw.state === 'critiquing') f.critiqueMs += dt;
    }
    // (0b) a copy: time only, while its variant job builds (waiting for its archetype is not queueing for a slot)
    if (it.kind === 'copy') {
      iw.state = isOpen(it) && it.status === 'checking' ? 'copy' : 'other';
      continue;
    }
    const d = it.designId ? sc.designs.get(it.designId) : undefined;
    if (d) bw.designs[d.id] = figure(sc, d, bw.designs[d.id]);
    const open = isOpen(it) && it.stage !== 'approval';
    iw.designId = it.designId;
    iw.state = !open ? 'other' : it.status === 'queued' ? (limited ? 'held' : 'queued') : it.status === 'critiquing' ? 'critiquing' : RUN.has(it.status) ? (designRound(sc, it.designId) > 1 ? 'repair' : 'active') : 'other';
    if (bw.firstDetailedAt === undefined && it.status === 'done' && (it.stage === undefined || it.stage === 'detail')) bw.firstDetailedAt = now;
  }
  const lines: Record<Stage, { usd: number; ms: number; count: number }> = {
    bible: { usd: bw.bible?.usd ?? 0, ms: bw.bible?.ms ?? 0, count: bw.bible?.jobIds.length ?? 0 },
    massing: { usd: 0, ms: 0, count: 0 },
    detail: { usd: 0, ms: 0, count: 0 },
    repair: { usd: 0, ms: 0, count: 0 },
    critique: { usd: 0, ms: 0, count: 0 },
    queued: { usd: 0, ms: 0, count: 0 },
    usage_hold: { usd: 0, ms: 0, count: 0 },
    copy: { usd: 0, ms: 0, count: g.items.filter((it) => it.kind === 'copy' && it.status === 'done').length },
  };
  for (const f of Object.values(bw.designs)) {
    const l = lines[f.kind];
    l.usd += f.first;
    l.ms += f.ms;
    l.count++;
    lines.repair.usd += f.repair;
    lines.repair.ms += f.repairMs;
    lines.repair.count += f.repairs;
    lines.critique.usd += f.critique;
    lines.critique.ms += f.critiqueMs;
    lines.critique.count += f.critics;
  }
  for (const iw of Object.values(bw.items)) {
    lines.queued.ms += iw.queuedMs;
    if (iw.queuedMs > 0) lines.queued.count++;
    lines.usage_hold.ms += iw.holdMs;
    lines.copy.ms += iw.copyMs ?? 0;
    if (iw.holdMs > 0) lines.usage_hold.count++;
  }
  const stages: Record<string, { usd: number; ms: number; count: number }> = {};
  for (const [k, l] of Object.entries(lines)) stages[k] = { usd: r6(l.usd), ms: Math.round(l.ms), count: l.count };
  g.breakdown = {
    stages,
    totalUsd: r6(g.cost.usd + (bw.bible?.usd ?? 0)),
    wallMs: Math.max(0, now - g.createdAt),
    firstDetailedMs: bw.firstDetailedAt !== undefined ? bw.firstDetailedAt - g.createdAt : 0,
    bibleJobIds: bw.bible?.jobIds ?? [],
  };
}

/** The transition fields of a group (what bumps seq). */
function signature(g: Group): string {
  return JSON.stringify([g.status, g.reason ?? null, g.wave ?? null, g.awaiting ?? [], g.items.map((it) => [it.itemKey, it.status, it.stage ?? null, it.entryId ?? null, it.massing?.version ?? null, it.rounds ?? 0])]);
}

/**
 * Bump seq and name lastAction when a transition field changed. Returns undefined when it did not bump, else the status at
 * the previous bump ("" for the first).
 */
export function bumpSeq(g: Group, bw: BreakdownWork): string | undefined {
  const sig = signature(g);
  if (sig === bw.sig) {
    delete bw.action;
    return undefined;
  }
  const prev = bw.prev;
  bw.sig = sig;
  bw.seq = (bw.seq ?? 0) + 1;
  g.seq = bw.seq;
  g.lastAction = !prev ? 'created' : bw.action ?? actionOf(g, prev);
  delete bw.action;
  bw.prev = { status: g.status, items: Object.fromEntries(g.items.map((it) => [it.itemKey, { status: it.status, ...(it.stage ? { stage: it.stage } : {}) }])) };
  return prev?.status ?? '';
}

function actionOf(g: Group, prev: NonNullable<BreakdownWork['prev']>): string {
  if (g.status !== prev.status) {
    if (g.status === 'done' || g.status === 'failed' || g.status === 'cancelled') return g.status;
    if (g.status === 'awaiting_approval') return 'awaiting_approval';
    if (g.status === 'paused_budget') return 'paused_budget';
    if (g.status === 'held_usage') return 'held_usage';
    if (prev.status === 'held_usage') return 'usage_reset';
  }
  let started = false;
  for (const it of g.items) {
    const p = prev.items[it.itemKey];
    if (!p) continue;
    if (it.stage === 'approval' && p.stage !== 'approval') return 'massing_ready';
    if (it.status !== p.status) {
      if (it.status === 'done') return 'item_done';
      if (it.status === 'failed' || it.status === 'cancelled') return 'item_failed';
      if (RUN.has(it.status) && !RUN.has(p.status)) started = true;
    }
  }
  return started ? 'item_started' : (g.lastAction ?? 'created');
}
