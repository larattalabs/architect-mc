// Turbo (exclusive) gate runs and the fair run queue for tools/gate-run.mjs (docs/GATES.md "Turbo").
//
// Every gate run (not --plan) queues for the machine in <slots dir>/queue/ and then takes slot files, as before:
//   shared  one slot of slot-1..slot-<slots>, as before. It goes only when no ticket queued before it is still waiting and no turbo
//           run holds or is reserving the machine (FIFO: a later run never overtakes an earlier one, and a run queued behind a
//           turbo run starts as soon as that turbo run ends).
//   turbo   the whole machine: once no ticket queued before it is still waiting, it writes its pid into EVERY slot file
//           slot-1..slot-<fill> as each one frees ("reserving"), and runs when it holds all of them. Runners from before this
//           change only look at slot files, so they wait behind it too and print it as the holder.
// Stale state is found by pid, as slots always were: a ticket or slot whose pid is dead is free. The queue is serialised by the
// same short mkdir mutex the slot claim always used. No deadlock: the head of the queue waits only on running holders (which end
// or die), and every other ticket waits only on tickets ahead of it (a total order by enqueue time, pid).
//
// Also here: the turbo shard choice (no cpu or slots cap: the run owns the machine) and a machine sampler (load, memory, swap,
// per-shard resident memory) that a run writes to <out>/machine.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { availableMemGB } from './shard-auto.mjs';

export const TURBO_DEFAULTS = {
  max: 12, // shards.turbo.max: the knee (docs/GATES.md "Turbo": measured)
  minSteps: 20, // a tier run (change | slice | release) of at least this many steps is turbo by default
  offlineLanes: 2, // lanes for the client-less steps (units, lints), beside the in-game shards
  portRange: [8940, 8999], // turbo port pairs (the lanes get a pair too, unused by their steps but never shared)
  memPerShardGB: 5,
  reserveGB: 8,
  planSlack: 0.03, // turbo: a shard more must save more than 3% of the wall
  fillSlots: 8, // a turbo run fills slot-1..max(this, slots.max, --slots, the highest existing slot) so every runner waits
  pollMs: 5000, // a turbo run polls faster than shared runs (15 s) so it takes freed slots before a pre-queue runner does
};

export function turboConfig(cfg) {
  return { ...TURBO_DEFAULTS, ...(cfg.shards?.turbo ?? {}) };
}

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null; // missing or half-written: treated as free (the claim re-checks under the mutex)
  }
};
const writeAtomic = (f, obj) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f);
};

export const slotFile = (dir, i) => path.join(dir, `slot-${i}.json`);
const queueDir = (dir) => path.join(dir, 'queue');
const ticketFile = (dir, me) => path.join(queueDir(dir), `t-${me.enqueuedAt}-${me.pid}.json`);

/** Runs fn under the slot dir's mkdir mutex (atomic); a mutex older than 10 s is a crashed claimer's. -> fn's result, or null when
 * the mutex stayed busy (the caller polls again). */
export async function withMutex(dir, fn, { tries = 40, waitMs = 50 } = {}) {
  const mutex = path.join(dir, '.mutex');
  fs.mkdirSync(dir, { recursive: true });
  let got = false;
  for (let i = 0; i < tries && !got; i++) {
    try {
      fs.mkdirSync(mutex);
      got = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(mutex).mtimeMs > 10_000) fs.rmdirSync(mutex);
      } catch {
        // raced
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (!got) return null;
  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(mutex);
    } catch {
      // gone
    }
  }
}

/** Every slot file in the dir: [{ i, holder | null }] (holder null: missing, unreadable or a dead pid). */
export function readSlots(dir, { alive = pidAlive } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^slot-\d+\.json$/.test(f));
  } catch {
    // no dir yet
  }
  return names.map((f) => {
    const i = Number(f.match(/\d+/)[0]);
    const h = readJson(path.join(dir, f));
    return { i, holder: h && h.pid && alive(h.pid) ? h : null };
  }).sort((a, b) => a.i - b.i);
}

/** The live holders, one per pid (a turbo run holds every slot): [{ pid, chain, worktree, turbo, state, shards, ports, slots: [i] }]. */
export function liveHolders(dir, opts = {}) {
  const by = new Map();
  for (const { i, holder } of readSlots(dir, opts)) {
    if (!holder) continue;
    const h = by.get(holder.pid) ?? { ...holder, slots: [] };
    h.slots.push(i);
    by.set(holder.pid, h);
  }
  return [...by.values()];
}

/** The live tickets in queue order (enqueue time, then pid); dead ones are removed. */
export function liveTickets(dir, { alive = pidAlive, prune = true } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(queueDir(dir)).filter((f) => /^t-\d+-\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    const t = readJson(path.join(queueDir(dir), f));
    if (!t || !alive(t.pid)) {
      if (prune) fs.rmSync(path.join(queueDir(dir), f), { force: true });
      continue;
    }
    out.push(t);
  }
  return out.sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.pid - b.pid);
}

const before = (a, b) => a.enqueuedAt < b.enqueuedAt || (a.enqueuedAt === b.enqueuedAt && a.pid < b.pid);
export const describeRun = (h) => `pid ${h.pid} ${h.turbo ? 'TURBO ' : ''}${h.chain ?? '?'} ${h.worktree ?? ''}${h.state === 'reserving' ? ' (reserving the machine)' : ''}${h.startedAt ? ` since ${h.startedAt}` : h.enqueuedAt ? ` queued ${new Date(h.enqueuedAt).toISOString()}` : ''}`;

/** me: { pid, worktree, chain, turbo }. Writes the ticket under the mutex and sets me.enqueuedAt there, later than every live
 * ticket's: the order is the order of enqueueing, so a ticket can never appear ahead of one already queued (which could otherwise
 * deadlock a reserving turbo run against it). */
export async function enqueue(dir, me) {
  fs.mkdirSync(queueDir(dir), { recursive: true });
  const r = await withMutex(dir, () => {
    me.enqueuedAt = Math.max(Date.now(), ...liveTickets(dir, { prune: false }).map((t) => t.enqueuedAt + 1));
    writeAtomic(ticketFile(dir, me), me);
    return true;
  }, { tries: 400 });
  if (!r) throw new Error(`could not take the slot mutex in ${dir}`);
}

/**
 * One attempt, under the mutex. shared: slots 1..slots; turbo: every slot 1..fill (more if higher slot files exist).
 * decide(n) runs under the same mutex once the run can go and returns what its slot files record ({ shards, ports }).
 * -> { acquired: true, slot, slots } | { acquired: false, waitingOn: [string] } | null (mutex busy)
 */
export async function tryAcquire(dir, me, { slots, fill = slots, decide = async () => ({}), alive = pidAlive } = {}) {
  return withMutex(dir, async () => {
    const tickets = liveTickets(dir, { alive });
    const ahead = tickets.filter((t) => t.pid !== me.pid && before(t, me));
    const all = readSlots(dir, { alive });
    const others = liveHolders(dir, { alive }).filter((h) => h.pid !== me.pid);
    if (me.turbo) {
      if (ahead.length) {
        // never reserve while an earlier run waits: it goes first (it may need one of the slots we would take). Enqueueing under the
        // mutex makes this unreachable once we reserved; if it ever happens, give the reserved slots back
        for (const s of all) if (s.holder?.pid === me.pid) fs.rmSync(slotFile(dir, s.i), { force: true });
        return { acquired: false, waitingOn: ahead.map((t) => `queued before it: ${describeRun(t)}`) };
      }
      const top = Math.max(fill, ...all.map((s) => s.i));
      const rec = { pid: me.pid, worktree: me.worktree, chain: me.chain, turbo: true, state: 'reserving', enqueuedAt: me.enqueuedAt };
      const mine = [];
      for (let i = 1; i <= top; i++) {
        const h = all.find((s) => s.i === i)?.holder;
        if (h && h.pid !== me.pid) continue;
        if (!h) writeAtomic(slotFile(dir, i), rec);
        mine.push(i);
      }
      if (others.length) return { acquired: false, waitingOn: others.map((h) => `running: ${describeRun(h)}`), reserved: mine };
      const d = await decide(mine[0]);
      const held = { pid: me.pid, worktree: me.worktree, chain: me.chain, turbo: true, state: 'running', startedAt: new Date().toISOString(), shards: d.shards, ports: d.ports };
      for (const i of mine) writeAtomic(slotFile(dir, i), held);
      fs.rmSync(ticketFile(dir, me), { force: true });
      return { acquired: true, slot: mine[0], slots: mine };
    }
    const turbo = others.filter((h) => h.turbo);
    if (turbo.length) return { acquired: false, waitingOn: turbo.map((h) => `the machine: ${describeRun(h)}`) };
    if (ahead.length) return { acquired: false, waitingOn: ahead.map((t) => `queued before it: ${describeRun(t)}`) };
    for (let n = 1; n <= slots; n++) {
      const h = all.find((s) => s.i === n)?.holder;
      if (h) continue;
      const d = await decide(n);
      writeAtomic(slotFile(dir, n), { pid: me.pid, worktree: me.worktree, chain: me.chain, turbo: false, startedAt: new Date().toISOString(), shards: d.shards, ports: d.ports });
      fs.rmSync(ticketFile(dir, me), { force: true });
      return { acquired: true, slot: n, slots: [n] };
    }
    return { acquired: false, waitingOn: [`a free slot (${slots} in use: ${others.map(describeRun).join('; ')})`] };
  });
}

/** Removes every slot file holding pid and its ticket (sync: also safe on process exit). */
export function releaseAll(dir, pid) {
  for (const { i } of readSlots(dir, { alive: () => true })) {
    const f = slotFile(dir, i);
    try {
      if (readJson(f)?.pid === pid) fs.rmSync(f, { force: true });
    } catch {
      // gone
    }
  }
  try {
    for (const f of fs.readdirSync(queueDir(dir))) if (f.endsWith(`-${pid}.json`)) fs.rmSync(path.join(queueDir(dir), f), { force: true });
  } catch {
    // no queue
  }
}

/**
 * Waits for the machine: enqueue, then tryAcquire every pollMs, logging who it waits on (at once, on every change, and every 5
 * minutes). -> { slot, slots, waitedSeconds }. On a signal while waiting the caller's exit handler calls releaseAll.
 */
export async function acquire(dir, me, { slots, fill, decide, pollMs = 15_000, log = console.log, alive = pidAlive, shouldStop = () => false } = {}) {
  await enqueue(dir, me);
  const t0 = Date.now();
  let lastText = '';
  let lastLog = 0;
  for (;;) {
    const r = await tryAcquire(dir, me, { slots, fill, decide, alive });
    if (r?.acquired) return { slot: r.slot, slots: r.slots, waitedSeconds: Math.round((Date.now() - t0) / 1000) };
    if (r) {
      const text = r.waitingOn.join('; ');
      if (text !== lastText || Date.now() - lastLog > 300_000) {
        log(`waiting${me.turbo ? ' (turbo: the whole machine)' : ''}${r.reserved?.length ? `, holding slot(s) ${r.reserved.join(',')} for it` : ''}: ${text}`);
        lastText = text;
        lastLog = Date.now();
      }
    }
    if (shouldStop()) throw new Error('stopped while waiting');
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/** The queue and holders now, for --plan. */
export function describeQueue(dir) {
  const holders = liveHolders(dir);
  const tickets = liveTickets(dir, { prune: false });
  return { holders, tickets, text: `${holders.length ? holders.map(describeRun).join('; ') : 'no run'}${tickets.length ? `; queued: ${tickets.map(describeRun).join('; ')}` : ''}` };
}

// ------------------------------------------------------------------ the turbo shard choice

/**
 * The turbo run owns the machine: N is the smallest of max (turbo max or --shards), plan (the smallest N within planSlack of the
 * best wall up to max), memory and the free port pairs (each in-game shard and each lane takes a pair). No cpu or slots cap.
 */
export function chooseTurbo(tc, { max, probe, lanes, wallFor, pairs }) {
  const table = [];
  for (let n = 1; n <= max; n++) table.push({ n, wallMin: wallFor(n) });
  const best = Math.min(...table.map((t) => t.wallMin));
  const plan = table.find((t) => t.wallMin <= best * (1 + tc.planSlack))?.n ?? 1;
  const caps = {
    max,
    plan,
    memory: Math.floor((probe.freeGB - tc.reserveGB) / tc.memPerShardGB) - lanes,
    ports: pairs - lanes,
  };
  const n = Math.max(1, Math.min(...Object.values(caps)));
  const bound = Object.entries(caps).filter(([, v]) => v === n).map(([k]) => k);
  return { n, bound: bound.length ? bound : ['at least 1'], caps, table, best };
}

export function describeTurbo(c, probe, tc, lanes) {
  return [
    `turbo: ${c.n} in-game shard(s) + ${lanes} offline lane(s), bound by ${c.bound.join(', ')}`,
    `  probe${probe.injected ? ' (INJECTED via GATE_AUTO_PROBE)' : ''}: ${probe.cores} cores, load ${probe.load1}/${probe.load5}, ${probe.freeGB} GB available`,
    `  caps: ${Object.entries(c.caps).map(([k, v]) => `${k} ${v}`).join(', ')} (no cpu or slots cap: the run holds the machine)`,
    `  wall by N: ${c.table.map((t) => `${t.n}: ${Math.round(t.wallMin)}`).join(', ')} min (plan = smallest N within ${Math.round(tc.planSlack * 100)}% of the best)`,
  ].join('\n');
}

// ------------------------------------------------------------------ the machine sampler

/** swap used in GB (sysctl vm.swapusage), or null. */
export function swapUsedGB() {
  try {
    const r = spawnSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 5000 });
    const m = r.stdout.match(/used = ([\d.]+)M/);
    return m ? Math.round(Number(m[1]) / 102.4) / 10 : null;
  } catch {
    return null;
  }
}

/**
 * One sample: load, available memory, swap, and per lane/shard the resident memory of the processes in its run worktree
 * (JVM, sidecar, gradle, node), with the largest single process. lanes: [{ name, needles: [path + sep] }].
 */
export function sampleMachine(lanes, loadavg) {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const procs = r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, rss, cmd]) => ({ pid: Number(pid), rssMB: Number(rss) / 1024, cmd }));
  const per = {};
  for (const ln of lanes) {
    const mine = procs.filter((p) => ln.needles.some((n) => p.cmd.includes(n)));
    const java = mine.filter((p) => /\bjava\b/.test(p.cmd.split(' ')[0]) || /\/bin\/java /.test(p.cmd));
    per[ln.name] = { rssGB: Math.round(mine.reduce((a, p) => a + p.rssMB, 0) / 102.4) / 10, javaGB: Math.round(java.reduce((a, p) => a + p.rssMB, 0) / 102.4) / 10, procs: mine.length,
      maxProcGB: Math.round(Math.max(0, ...mine.map((p) => p.rssMB)) / 102.4) / 10 };
  }
  const [l1, l5] = loadavg;
  return { t: new Date().toISOString(), load1: Math.round(l1 * 10) / 10, load5: Math.round(l5 * 10) / 10, availGB: availableMemGB(), swapGB: swapUsedGB(), lanes: per };
}

/** Folds machine.jsonl samples into the summary's numbers: load p50/p90/max, min available GB, max swap, per-lane max RSS. */
export function foldSamples(samples) {
  if (!samples.length) return null;
  const q = (xs, p) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const loads = samples.map((s) => s.load1);
  const lanes = {};
  for (const s of samples) for (const [k, v] of Object.entries(s.lanes ?? {})) {
    lanes[k] = { rssGBMax: Math.max(lanes[k]?.rssGBMax ?? 0, v.rssGB), javaGBMax: Math.max(lanes[k]?.javaGBMax ?? 0, v.javaGB), maxProcGB: Math.max(lanes[k]?.maxProcGB ?? 0, v.maxProcGB) };
  }
  const totals = samples.map((s) => Object.values(s.lanes ?? {}).reduce((a, v) => a + v.rssGB, 0));
  return {
    samples: samples.length, loadP50: q(loads, 0.5), loadP90: q(loads, 0.9), loadMax: Math.max(...loads),
    availGBMin: Math.min(...samples.map((s) => s.availGB)), swapGBMax: Math.max(0, ...samples.map((s) => s.swapGB ?? 0)),
    gateRssGBMax: Math.round(Math.max(...totals) * 10) / 10, lanes,
  };
}
