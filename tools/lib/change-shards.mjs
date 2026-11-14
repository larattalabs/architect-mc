// Shards for shared change and slice runs (docs/GATES.md "Speed rules", "Slice GX as built"). A shared (`--no-turbo`) change or
// slice run with more than `shards.change.minSteps` steps and one `--ports` pair is split over a few in-game shards plus offline
// lanes (the client-less unit and sim steps, as turbo's lanes), all on port pairs derived from that one pair: pair, pair+stride,
// pair+2 x stride (the coordinator assigns the base pair; the brief names the pairs a slice may use). Nothing is derived into the
// turbo range (8940-8999) or onto 8892-8895, and a derived pair another live run recorded, or one that won't bind, is not used.
//
// The run still takes one slot (the slot caps runs; docs/GATES.md "Slot lock"), and the load-aware start (rule 5's 300 s
// spacing, rule 10's bounds) gates it as one start. Pure functions; the runner calls `chooseChange` under the slot mutex.

import net from 'node:net';

export const CHANGE_DEFAULTS = {
  minSteps: 10, // more than this many planned steps: shard (else one shard, as before)
  pairs: 3, // port pairs a run may take from its base pair: in-game shards + offline lanes
  stride: 2, // pair k is base + (k - 1) x stride
  maxGame: 2, // in-game shards (each a client or headless server: the load that slows the box)
  planSlack: 0.05, // one more worker must save more than 5% of the wall
  memPerShardGB: 5,
  laneGB: 2,
  reserveGB: 8,
  tiers: ['change', 'slice'], // where timing is recorded, not judged (an offline lane's steps run under nice -n 10)
  nice: 10,
};

export function changeConfig(cfg) {
  return { ...CHANGE_DEFAULTS, ...(cfg.shards?.change ?? {}) };
}

/** Ports nothing but turbo may bind (gate-chains.json shards.turbo.portRange) and the gates' old-version clients' ports. */
export function forbiddenPort(p, turboRange = [8940, 8999]) {
  return (p >= turboRange[0] && p <= turboRange[1]) || (p >= 8892 && p <= 8895);
}

/**
 * The derived pairs: [[s, d], [s + stride, d + stride], ...], `count` of them, from the base pair. Throws when a derived port would
 * land in the turbo range or on 8892-8895 (the base pair is the coordinator's; a slice never derives into another's range by
 * accident: the brief names the pairs, and the plan prints them).
 */
export function derivePairs(base, count, { stride = 2, turboRange = [8940, 8999] } = {}) {
  const [s, d] = base;
  if (!(Number.isInteger(s) && Number.isInteger(d))) throw new Error(`base pair ${base}: two port numbers`);
  const out = [];
  for (let k = 0; k < count; k++) {
    const p = [s + k * stride, d + k * stride];
    if (p.some((x) => forbiddenPort(x, turboRange))) throw new Error(`derived pair ${p.join(':')} falls in the turbo range ${turboRange.join('-')} or 8892-8895: name the pairs with --ports, or --shards 1`);
    out.push(p);
  }
  const all = out.flat();
  if (new Set(all).size !== all.length) throw new Error(`derived pairs overlap (stride ${stride}): ${out.map((x) => x.join(':')).join(',')}`);
  return out;
}

const bindable = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

/** The usable pairs among `pairs`, in order, stopping at the first unusable one (so a run's pairs are always a prefix). */
export async function usablePairs(pairs, { taken = new Set(), canBind = bindable } = {}) {
  const out = [];
  for (const [s, d] of pairs) {
    if (taken.has(s) || taken.has(d)) break;
    if (!(await canBind(s)) || !(await canBind(d))) break;
    out.push([s, d]);
  }
  return out;
}

/**
 * Choose the in-game shards and offline lanes. wallFor(n, lanes): the scheduled wall in minutes; offline/game: the counts of
 * client-less and in-game steps; pairs: usable pairs (n + lanes may not exceed it); probe: { freeGB }.
 * -> { n, lanes, bound, table: [{ n, lanes, wallMin }], caps }.
 * Every combination with n >= 1 in-game shard (n <= maxGame, and no more than there are in-game steps), lanes <= offline steps, and
 * n + lanes within the pairs and memory is scheduled; the fewest workers whose wall is within planSlack of the best one wins (ties:
 * fewer in-game shards, then fewer lanes), so a shard or a lane is added only when it pays for itself.
 */
export function chooseChange(cc, { wallFor, offline, game, pairs, probe = {} }) {
  const memory = Math.max(1, Math.floor(((probe.freeGB ?? 100) - cc.reserveGB) / cc.memPerShardGB));
  const maxN = Math.max(1, Math.min(cc.maxGame, game || 1, memory, pairs));
  const table = [];
  for (let n = 1; n <= maxN; n++) {
    for (let lanes = 0; n + lanes <= Math.min(pairs, cc.pairs); lanes++) {
      if (lanes > offline) break;
      if (lanes && !game) break; // lanes run beside in-game shards; an all-offline plan just takes shards
      if ((probe.freeGB ?? 100) - cc.reserveGB < n * cc.memPerShardGB + lanes * cc.laneGB && (n > 1 || lanes)) continue;
      table.push({ n, lanes, wallMin: wallFor(n, lanes) });
    }
  }
  if (!table.length) table.push({ n: 1, lanes: 0, wallMin: wallFor(1, 0) });
  const best = Math.min(...table.map((t) => t.wallMin));
  const ok = table.filter((t) => t.wallMin <= best * (1 + cc.planSlack) + 1e-9);
  ok.sort((a, b) => (a.n + a.lanes) - (b.n + b.lanes) || a.n - b.n || a.lanes - b.lanes);
  const pick = ok[0];
  const bound = [];
  if (pick.n + pick.lanes >= Math.min(pairs, cc.pairs)) bound.push(pairs < cc.pairs ? `ports (${pairs} usable pair(s))` : `pairs (shards.change.pairs ${cc.pairs})`);
  if (pick.n >= cc.maxGame) bound.push(`maxGame ${cc.maxGame}`);
  if (!bound.length) bound.push('plan');
  return { n: pick.n, lanes: pick.lanes, bound, caps: { pairs, memory, maxGame: cc.maxGame }, table };
}

/** Whether a run is one this applies to: a shared tier run (change/slice) with more than minSteps steps and no --shards. */
export function changeApplies(cc, { chain, turbo, shardsArg, steps, portsGiven }) {
  if (turbo) return { on: false, why: 'turbo run' };
  if (!cc.tiers.includes(chain)) return { on: false, why: `${chain} is not ${cc.tiers.join('/')}` };
  if (shardsArg !== undefined) return { on: false, why: `--shards ${shardsArg}` };
  if (steps <= cc.minSteps) return { on: false, why: `${steps} steps <= shards.change.minSteps ${cc.minSteps}` };
  if (portsGiven !== 1) return { on: false, why: portsGiven ? `--ports names ${portsGiven} pairs (used as given)` : 'no --ports pair to derive from' };
  return { on: true, why: `a shared ${chain} of ${steps} steps > ${cc.minSteps}` };
}

export function describeChange(c, cc, pairs) {
  const used = pairs.slice(0, c.n + c.lanes).map((p) => p.join(':'));
  return `change shards: ${c.n} in-game shard(s) + ${c.lanes} offline lane(s) (bound by ${c.bound.join(', ')}); ports ${used.join(', ')} `
    + `(derived from the base pair, stride ${cc.stride}); wall by shards+lanes: ${c.table.map((t) => `${t.n}+${t.lanes} ${Math.round(t.wallMin)}m`).join(', ')}; `
    + `one slot for the run; offline lanes run under nice -n ${cc.nice}`;
}
