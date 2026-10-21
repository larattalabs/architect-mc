// Adaptive shard count for tools/gate-run.mjs (`--shards auto`; docs/GATES.md "Adaptive shards").
//
// A run picks N from four caps and takes the smallest:
//   slots   the machine-wide shard budget less the shards the other live slot holders recorded (a holder from an older runner
//           that recorded none counts as legacyShards), less a reserve for one more run while run slots are still free
//   cpu     (cores x overcommit - max(load1, load5)) / cpuPerShard
//   memory  (free + inactive + purgeable + speculative memory - reserveGB) / memPerShardGB
//   plan    the smallest N whose longest-first schedule is within planSlack of the best one up to max
// and the free port pairs in the configured range (or the pairs --ports names). Pure functions plus two probes (load and memory,
// port binding); the runner calls them under the slot mutex so two auto runs never see the same budget or ports.

import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

export const AUTO_DEFAULTS = {
  max: 6, // hard cap per run (shards.max)
  minSteps: 20, // `--shards` omitted: auto for slice/release with more than this many planned steps
  machineShards: 12, // shards across every live gate run on the machine
  legacyShards: 3, // a slot holder that recorded no shard count (an older runner)
  reserveShards: 2, // kept back for one more run while run slots are free
  overcommit: 1.5, // target load = cores x overcommit
  cpuPerShard: 3, // load units one busy shard adds (measured; docs/GATES.md "Adaptive shards")
  memPerShardGB: 5, // a headless server or client (3-4.7 GB peak) + its sidecar + gradle
  reserveGB: 8,
  planSlack: 0.05, // a shard more must save more than 5% of the wall
  floor: 3, // when plan, memory and ports allow it, never fewer than this: the old fixed --shards 3 (docs/GATES.md "Adaptive shards")
  portRange: [8980, 8999],
};

export function autoConfig(cfg) {
  return { ...AUTO_DEFAULTS, ...(cfg.shards?.auto ?? {}), max: cfg.shards?.max ?? AUTO_DEFAULTS.max };
}

/** Available memory in GB: vm_stat's free + inactive + purgeable + speculative pages (os.freemem() counts free pages only). */
export function availableMemGB() {
  try {
    const r = spawnSync('vm_stat', [], { encoding: 'utf8', timeout: 5000 });
    const page = Number(r.stdout.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
    const get = (k) => Number(r.stdout.match(new RegExp(`Pages ${k}:\\s+(\\d+)`))?.[1] ?? 0);
    const pages = get('free') + get('inactive') + get('purgeable') + get('speculative');
    if (pages > 0) return Math.round((pages * page) / 2 ** 30 * 10) / 10;
  } catch {
    // not macOS
  }
  return Math.round(os.freemem() / 2 ** 30 * 10) / 10;
}

/** The machine now. GATE_AUTO_PROBE='{"load1":1,"load5":1,"freeGB":100}' overrides fields (to show a plan for another load). */
export function probeMachine() {
  const [l1, l5] = os.loadavg();
  const p = { cores: os.cpus().length, load1: Math.round(l1 * 10) / 10, load5: Math.round(l5 * 10) / 10, freeGB: availableMemGB(), injected: false };
  if (process.env.GATE_AUTO_PROBE) {
    Object.assign(p, JSON.parse(process.env.GATE_AUTO_PROBE));
    p.injected = true;
  }
  return p;
}

const bindable = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

/** The free sidecar:DevBridge pairs: from `given` (--ports) or the range, skipping ports other live runs recorded and 8892-8895. */
export async function freePairs({ range, given, taken }) {
  const cands = given ?? [];
  if (!given) for (let p = range[0]; p + 1 <= range[1]; p += 2) cands.push([p, p + 1]);
  const out = [];
  for (const [s, d] of cands) {
    if ([s, d].some((p) => taken.has(p) || (p >= 8892 && p <= 8895))) continue;
    if (given || ((await bindable(s)) && (await bindable(d)))) out.push([s, d]);
  }
  return out;
}

/**
 * Choose N. probe: probeMachine(); holders: the other live slot holders ({shards}); freeRunSlots: run slots still free after this
 * one; wallFor(n): the scheduled wall in minutes on n shards; pairs: free port pairs. Returns { n, bound, caps, table }.
 */
export function chooseShards(ac, { probe, holders, freeRunSlots, wallFor, pairs }) {
  const used = holders.reduce((a, h) => a + (Number.isInteger(h.shards) ? h.shards : ac.legacyShards), 0);
  const load = Math.max(probe.load1, probe.load5);
  const table = [];
  for (let n = 1; n <= ac.max; n++) table.push({ n, wallMin: wallFor(n) });
  const best = Math.min(...table.map((t) => t.wallMin));
  const plan = table.find((t) => t.wallMin <= best * (1 + ac.planSlack))?.n ?? 1;
  const caps = {
    max: ac.max,
    plan,
    slots: ac.machineShards - used - (freeRunSlots > 0 ? ac.reserveShards : 0),
    cpu: Math.floor((probe.cores * ac.overcommit - load) / ac.cpuPerShard),
    memory: Math.floor((probe.freeGB - ac.reserveGB) / ac.memPerShardGB),
    ports: pairs.length,
  };
  let n = Math.min(...Object.values(caps));
  let bound = Object.entries(caps).filter(([, v]) => v === n).map(([k]) => k);
  // the floor: a plan that wants 3+ gets 3 when only the load-derived caps (cpu, slots) say less; memory, ports and the plan itself
  // still bind
  const hard = Math.min(caps.max, caps.plan, caps.memory, caps.ports);
  if (n < ac.floor && hard >= ac.floor) {
    n = ac.floor;
    bound = [`floor ${ac.floor} (${bound.join(', ')} said ${Math.min(...Object.values(caps))})`];
  }
  n = Math.max(1, n);
  return { n, bound, caps, used, load, table, best };
}

export function describeChoice(c, probe, ac) {
  const why = `${c.n} shard(s), bound by ${c.bound.join(', ')}`;
  const caps = Object.entries(c.caps).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `shards auto: ${why}`,
    `  probe${probe.injected ? ' (INJECTED via GATE_AUTO_PROBE)' : ''}: ${probe.cores} cores, load ${probe.load1}/${probe.load5} (1/5 min, ${c.load} used), ${probe.freeGB} GB available; other runs' shards ${c.used} of ${ac.machineShards}`,
    `  caps: ${caps}`,
    `  cpu = floor((${probe.cores} x ${ac.overcommit} - ${c.load}) / ${ac.cpuPerShard}); memory = floor((${probe.freeGB} - ${ac.reserveGB}) / ${ac.memPerShardGB}); plan = smallest N within ${Math.round(ac.planSlack * 100)}% of the best wall`,
    `  wall by N: ${c.table.map((t) => `${t.n}: ${Math.round(t.wallMin)} min`).join(', ')}`,
  ].join('\n');
}
