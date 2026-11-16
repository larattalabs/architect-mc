// Gate-run slots for outside callers (Steward's e2e and slice clients; docs/GATES.md "Slot lock", "Outside callers (Steward)").
//
// No second implementation: this is tools/lib/turbo.mjs's queue as gate-run uses it (enqueue + acquire under the same mkdir
// mutex, FIFO with gate runs, the same slot file format, a dead pid's ticket or slot is free, the load-aware start, a running or
// reserving turbo run keeps it out). The differences are only who holds what:
//   - the queue ticket's pid is the waiting process (this one): if it dies while waiting, its ticket is pruned like any other;
//   - the slot file's pid is the holder (--pid: the caller's long-lived driver), so the slot frees when the driver dies. One
//     holder pid may hold several slots (one per client); each acquire has its own ticket id, and release frees only that one.
// The slot record adds { who, label, ticket, outside: true }; chain is "<who>:<label>" so gate-run's waiting log names it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, describeRun, LOAD_BOUNDS, liveTickets, loadConfig, pidAlive, readSlots, slotFile, withMutex } from './turbo.mjs';

/** The Architect checkout this file is in (resolved from its own path, so any cwd works). */
export const ARCHITECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The gate-run config (tools/gate-chains.json) of this checkout. */
export function readGateConfig(root = ARCHITECT_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tools', 'gate-chains.json'), 'utf8'));
}

/** The slots dir gate-run uses: GATE_SLOTS_DIR, else <checkout>/../.gate-slots (gate-run: path.join(MAIN, '..', '.gate-slots')). */
export function resolveSlotsDir({ env = process.env, root = ARCHITECT_ROOT } = {}) {
  return path.resolve(env.GATE_SLOTS_DIR || path.join(root, '..', '.gate-slots'));
}

/** The slot limit gate-run uses: GATE_SLOTS, else slots.max (6). */
export function slotLimit(cfg, env = process.env) {
  const n = Number(env.GATE_SLOTS || cfg.slots?.max || 3);
  if (!(Number.isInteger(n) && n >= 1)) throw new Error(`slot limit ${n}: not a positive integer`);
  return n;
}

const round1 = (x) => Math.round(x * 10) / 10;

/** The turbo state of the machine: running, reserving (holds some slots, waiting for the rest) and queued turbo runs. */
function turboState(dir, { alive = pidAlive } = {}) {
  const held = new Map();
  for (const { i, holder } of readSlots(dir, { alive })) {
    if (!holder?.turbo) continue;
    const h = held.get(holder.pid) ?? { pid: holder.pid, chain: holder.chain, worktree: holder.worktree, state: holder.state ?? 'running', slots: [] };
    h.slots.push(i);
    held.set(holder.pid, h);
  }
  const all = [...held.values()];
  const queued = liveTickets(dir, { alive, prune: false }).filter((t) => t.turbo && !held.has(t.pid)).map((t) => ({ pid: t.pid, chain: t.chain, worktree: t.worktree, enqueuedAt: t.enqueuedAt }));
  const running = all.filter((h) => h.state !== 'reserving');
  const reserving = all.filter((h) => h.state === 'reserving');
  return { active: all.length > 0 || queued.length > 0, running, reserving, queued };
}

const turboText = (t) => (t.running.length ? `running (pid ${t.running.map((h) => h.pid).join(',')})`
  : t.reserving.length ? `reserving (pid ${t.reserving.map((h) => h.pid).join(',')})`
  : t.queued.length ? `queued (pid ${t.queued.map((h) => h.pid).join(',')})` : 'none');

/**
 * The machine now: -> { dir, limit, holders: [per slot { slot, pid, who, label, worktree, chain, turbo, state, startedAt, ticket }],
 * queue: [tickets in order], load: { load1, load5, max1, settleSec, maxWaitMin }, turbo: { active, running, reserving, queued }, free }.
 */
export function slotStatus(dir, { cfg = readGateConfig(), env = process.env, alive = pidAlive, loadNow = () => os.loadavg() } = {}) {
  const limit = slotLimit(cfg, env);
  const slots = readSlots(dir, { alive });
  const holders = slots.filter((s) => s.holder).map(({ i, holder: h }) => ({
    slot: i, pid: h.pid, who: h.who ?? (h.outside ? '?' : 'gate-run'), label: h.label ?? h.chain ?? null, worktree: h.worktree ?? null, chain: h.chain ?? null,
    turbo: !!h.turbo, state: h.state ?? 'running', startedAt: h.startedAt ?? null, ticket: h.ticket ?? null, shards: h.shards ?? null,
  }));
  const queue = liveTickets(dir, { alive, prune: false }).map((t) => ({ ticket: `t-${t.enqueuedAt}-${t.pid}`, pid: t.pid, who: t.who ?? 'gate-run', label: t.label ?? t.chain ?? null, worktree: t.worktree ?? null, turbo: !!t.turbo, holdPid: t.holdPid ?? null, enqueuedAt: t.enqueuedAt }));
  const [l1, l5] = loadNow();
  const lc = loadConfig(cfg, env, () => {});
  const used = new Set(holders.map((h) => h.slot));
  let free = 0;
  for (let n = 1; n <= limit; n++) if (!used.has(n)) free++;
  return { dir, limit, free, holders, queue, load: { load1: round1(l1), load5: round1(l5 ?? l1), max1: lc.max1, settleSec: lc.settleSec, maxWaitMin: lc.maxWaitMin }, turbo: turboState(dir, { alive }) };
}

/**
 * Waits for one shared slot, FIFO with the gate runs, honouring the load gate and turbo, then writes the slot file held by `pid`.
 *   who       the caller ("steward")             worktree  its checkout (recorded; default cwd)
 *   label     its flow or step                   pid       the holder: a live long-lived pid (the slot frees when it dies)
 *   maxWaitMin  give up after this many minutes (default and cap: rule 10's 15); the load gate's own cap is the same
 *   noLoadWait  skip the load-aware start (max1 0)
 * -> { slot, ticket, path, dir, waitedSeconds, loadWait }. Throws (err.code 'SLOT_TIMEOUT', err.status = slotStatus) on timeout, and
 * 'SLOT_HOLDER_DEAD' when the holder pid is or goes dead.
 */
export async function acquireSlot(dir, { who, worktree = process.cwd(), label, pid, maxWaitMin = LOAD_BOUNDS.maxWaitMinMax, noLoadWait = false, cfg = readGateConfig(), env = process.env,
  alive = pidAlive, loadNow, pollMs = Number(env.GATE_SLOT_POLL_MS || 15_000), log = (m) => console.error(m), waiterPid = process.pid } = {}) {
  if (!who) throw new Error('acquireSlot: who is required');
  if (!label) throw new Error('acquireSlot: label is required');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`acquireSlot: pid ${pid} is not a pid`);
  if (!alive(pid)) throw Object.assign(new Error(`holder pid ${pid} is not alive`), { code: 'SLOT_HOLDER_DEAD' });
  const waitMin = Math.min(Number.isFinite(maxWaitMin) && maxWaitMin >= 0 ? maxWaitMin : LOAD_BOUNDS.maxWaitMinMax, LOAD_BOUNDS.maxWaitMinMax);
  const load = noLoadWait ? { ...loadConfig(cfg, env, () => {}), max1: 0 } : loadConfig(cfg, env, log);
  const slots = slotLimit(cfg, env);
  fs.mkdirSync(dir, { recursive: true });
  const me = { pid: waiterPid, worktree, chain: `${who}:${label}`, turbo: false, who, label, holdPid: pid };
  const deadline = Date.now() + waitMin * 60_000;
  // the load gate's own cap (maxWaitMin: start anyway, recorded as gaveUp) ends at the deadline, so load alone never fails an
  // outside caller, as it never stops a gate run; full slots, a turbo run or the queue ahead still time out
  if (load.max1 > 0) {
    load.maxWaitMin = Math.min(load.maxWaitMin, waitMin);
    me.loadWaitSince = deadline - load.maxWaitMin * 60_000;
  }
  let stopWhy = null;
  let lastTry = false;
  const shouldStop = () => {
    if (!alive(pid)) stopWhy = 'SLOT_HOLDER_DEAD';
    else if (Date.now() >= deadline) {
      // one more attempt past the deadline, where the load gate's cap has run out (it then starts anyway)
      if (!lastTry) lastTry = true;
      else stopWhy = 'SLOT_TIMEOUT';
    }
    return !!stopWhy;
  };
  // the ticket id is the queue ticket's name (set once enqueue fixes enqueuedAt); slotExtra is read when the slot is written
  me.slotExtra = { outside: true, who, label, get ticket() { return `t-${me.enqueuedAt}-${me.pid}`; } };
  try {
    const got = await acquire(dir, me, { slots, fill: slots, decide: async () => ({ shards: 1, ports: [] }), pollMs, log: (m) => log(`slot ${who}:${label}: ${m}`), alive, shouldStop, load, loadNow });
    return { slot: got.slot, ticket: `t-${me.enqueuedAt}-${me.pid}`, path: slotFile(dir, got.slot), dir, waitedSeconds: got.waitedSeconds, loadWait: got.loadWait };
  } catch (e) {
    // our ticket leaves the queue (also pruned by pid once this process exits)
    if (me.enqueuedAt) fs.rmSync(path.join(dir, 'queue', `t-${me.enqueuedAt}-${me.pid}.json`), { force: true });
    if (!stopWhy) throw e;
    const st = slotStatus(dir, { cfg, env, alive, loadNow: loadNow ? () => [loadNow(), loadNow()] : undefined });
    const msg = stopWhy === 'SLOT_TIMEOUT'
      ? `waited ${waitMin >= 1 ? `${round1(waitMin)} min` : `${Math.round(waitMin * 60)} s`} for a slot (load ${st.load.load1} / max1 ${st.load.max1}; turbo ${turboText(st.turbo)}; holders: ${st.holders.map((h) => `${h.slot} ${h.who} ${h.label ?? ''} pid ${h.pid}`).join('; ') || 'none'})`
      : `holder pid ${pid} died while waiting for a slot`;
    throw Object.assign(new Error(msg), { code: stopWhy, status: st });
  }
}

/** Frees the one slot written for `ticket` (and drops the ticket if it is still queued). -> { released: [slot], queued: bool }. */
export async function releaseTicket(dir, ticket) {
  if (!/^t-\d+-\d+$/.test(ticket ?? '')) throw new Error(`release: ${ticket} is not a ticket (t-<enqueuedAt>-<pid>)`);
  const r = await withMutex(dir, () => {
    const released = [];
    for (const { i } of readSlots(dir, { alive: () => true })) {
      let h = null;
      try {
        h = JSON.parse(fs.readFileSync(slotFile(dir, i), 'utf8'));
      } catch {
        continue;
      }
      if (h?.ticket === ticket) {
        fs.rmSync(slotFile(dir, i), { force: true });
        released.push(i);
      }
    }
    const q = path.join(dir, 'queue', `${ticket}.json`);
    const queued = fs.existsSync(q);
    if (queued) fs.rmSync(q, { force: true });
    return { released, queued };
  }, { tries: 400 });
  if (!r) throw new Error(`could not take the slot mutex in ${dir}`);
  return r;
}

export { describeRun };
