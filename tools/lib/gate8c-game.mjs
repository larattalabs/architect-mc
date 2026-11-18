// Phase 8c's in-game lane items (tools/gate8c.mjs; docs/CONTRACT.md "Phase 8c" PB, WU, CR) on the flat base: river_demo and fall_island
// (kit/regions; the hand IRs of kit/lib/fluids/handriver.mjs) through Regions.checkPlan and realiseApproved, then Remove. HY-core's
// helpers (tools/lib/gate6chy-core.mjs) do the census, the snapshot and the diff.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boxAround, censusOf, diff, groundOf, regionOf, snap, bodiesOf } from './gate6chy-core.mjs';

export const OWNER = 'test:8c';
export const FLAT = 'G6B Flat Base';
/** The claim on the flat world (96 x 64). */
export const CLAIM = [9500, 9200, 9595, 9263];
const C = { minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;

async function demo(ctx, which) {
  return import(pathToFileURL(path.join(ctx.KIT, 'regions', `${which}.mjs`)).href);
}
async function layout(ctx) {
  return import(pathToFileURL(path.join(ctx.KIT, 'lib', 'fluids', 'handriver.mjs')).href);
}

/** The flat world's ground at the claim, read from the world's survey (as the kit's plan reads it: HY's groundOf). */
async function ground(ctx) {
  return groundOf(ctx, CLAIM);
}

/** A fresh flat world, exact rules, the player over the claim. */
async function fresh(ctx, name) {
  const { L } = ctx;
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 40, (CLAIM[1] + CLAIM[3]) / 2);
  return ground(ctx);
}

/** The river's meadow flowers (natural: /setblock before the check), the wash rule's cells. */
async function plantMeadow(ctx, g) {
  const D = await demo(ctx, 'river_demo');
  const L = (await layout(ctx)).riverLayout(D.riverOrigin(C), g, 'none', 'river');
  for (const [x, y, z] of L.meadow) await ctx.L.cmd(`/setblock ${x} ${y} ${z} minecraft:dandelion`);
  return L;
}

/** checkPlan of a hand IR: {c, artifactSha}. */
async function checkHand(ctx, which, tag, params = {}) {
  const D = await demo(ctx, which);
  const fn = which === 'river_demo' ? D.riverPlan : D.fallPlan;
  const { plan, anchors } = fn(C, params);
  const c = await ctx.L.call('dev.region.checkPlan', { plan, claim: CLAIM, owner: OWNER, anchors, load: 'generate' }, 900_000);
  fs.writeFileSync(path.join(ctx.OUT, `8c-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  return { c, artifactSha: c.check?.artifactSha ?? null };
}

/** The box every item snapshots and diffs: the claim grown by 8, from under the pools to over the island. */
const boxOf = (g) => [CLAIM[0] - 8, g - 6, CLAIM[1] - 8, CLAIM[2] + 8, g + 24, CLAIM[3] + 8];

async function fluidsIn(ctx, box) {
  const c = await ctx.L.call('dev.fluid.census', { box }, 600_000);
  return new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
}

/** dev.fluid.river: per body its predicted vs census, levels, and the item entities spawned in its own and predicted cells. */
async function river(ctx, region) {
  return ctx.L.call('dev.fluid.river', { region }, 120_000).catch((e) => ({ error: String(e.message ?? e) }));
}
const itemsOf = (rv) => (typeof rv?.items === 'number' ? rv.items + (rv.itemsNow ?? 0) : -1); // (the spawn counter, plus the items standing in the bodies' own and predicted cells now)

/** A Remove watched until it ends: the fluids removal phases seen on the view, the final state. */
async function removeWatched(ctx, region, { again = false } = {}) {
  const { L } = ctx;
  const t0 = Date.now();
  const first = L.call('dev.region.remove', { region, requester: OWNER }, 3_600_000).catch((e) => ({ error: String(e.message ?? e) }));
  const phases = [];
  let second = null;
  for (let i = 0; i < 2400; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    const fr = st?.view?.fluidsRemoval ?? null;
    if (fr && phases.at(-1) !== fr.phase) phases.push(fr.phase);
    if (again && !second && fr && fr.phase === 'draining') {
      second = await L.call('dev.region.remove', { region, requester: OWNER }, 600_000).catch((e) => ({ error: String(e.message ?? e) }));
    }
    if (!s || s === 'REMOVED' || s === 'PARTIAL' || s === 'FAILED') {
      return { state: s ?? 'REMOVED', phases, seconds: (Date.now() - t0) / 1000, first: await first, second, watch: st?.view?.ext?.['architect_mc:fluidsWatch'] ?? null };
    }
    await sleep(500);
  }
  throw new Error(`removal of ${region} did not finish`);
}

/** Realise from the approved artifact and wait: the region's view, rows, record, bodies. */
async function realise(ctx, sha) {
  const { L } = ctx;
  const rr = await L.call('dev.region.realiseApproved', { sha }, 300_000);
  if (rr.refused) return { refused: rr.refused };
  await L.waitRegion(rr.region, 3_600_000);
  return regionOf(ctx, rr.region);
}

/** Every body's census against its prediction, the sums. */
async function censusAll(ctx, r, before) {
  const out = {};
  for (const b of r.bodies) out[b.id] = await censusOf(ctx, b, before, r.bodies);
  return { all: out, ok: Object.values(out).every((c) => c.ok && c.ticks === 0), sum: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v.sources, v.flowing, v.mismatch.length, v.outsideCount, v.ticks]])) };
}

/** The item entities in a box (dev.stockpile.audit's entities: every dropped item). */
async function itemEntities(ctx, box) {
  const a = await ctx.L.call('dev.stockpile.audit', { owner: OWNER, min: box.slice(0, 3), max: box.slice(3) }, 120_000).catch(() => null);
  return a ? Object.values(a.entities ?? {}).reduce((x, y) => x + y, 0) : null;
}

/** Realise, check the rows and the census, Remove watched, diff: the common row of WU and CR. */
async function fullRow(ctx, tag, which, { params = {}, meadow = which === 'river_demo', expectFlowing } = {}) {
  const { L, check, json } = ctx;
  const g = await fresh(ctx, `G6B 8c ${tag}`);
  if (meadow) await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, which, tag, params);
  check(ck.c.check?.overall === 'READY', `${tag}: ${which} through Regions.checkPlan: ${ck.c.check?.overall} (${json((ck.c.check?.parts ?? []).map((a) => [a.part, a.class]))})`);
  const box = boxOf(g);
  const file = await snap(ctx, box, `8c-${tag}`);
  const before = await fluidsIn(ctx, box);
  const r = await realise(ctx, ck.artifactSha);
  if (r.refused) { check(false, `${tag}: realiseApproved refused (${json(r.refused)})`); return { refused: r.refused }; }
  const out = { region: r.region, state: r.view.state, rows: r.fluids };
  check(r.view.state === 'PLACED' && r.fluids.length === 2 && r.fluids.every((x) => x.state === 'settled'), `${tag}: PLACED once both bodies settled (${r.view.state}; ${json(r.fluids.map((x) => [x.body, x.state, x.why ?? null, x.settledAt]))})`);
  const head = r.fluids.find((x) => /_r1$/.test(x.body));
  check(!!head && Array.isArray(head.box) && head.box.length === 6 && (head.flow === 'current' || head.lip === 'form') && head.flowing === expectFlowing && typeof head.settleTicks === 'number',
    `${tag}: the head's row carries box, flow/lip, flowing (${head?.flowing} == ${expectFlowing}), settleTicks, ${meadow ? `washed ${head?.washed}` : `on ${head?.on}`}`);
  const cs = await censusAll(ctx, r, before);
  out.census = cs.sum;
  check(cs.ok, `${tag}: every census equals its prediction, no tick, 0 fluid outside the declared cells (${json(cs.sum)})`, Object.fromEntries(Object.entries(cs.all).map(([k, v]) => [k, { mismatch: v.mismatch, outside: v.outside }])));
  const rv = await river(ctx, r.region);
  out.river = rv;
  check(itemsOf(rv) === 0, `${tag}: 0 new item entities from the bodies' own and predicted cells (${itemsOf(rv)})`);
  const rm = await removeWatched(ctx, r.region);
  await sleep(3000);
  const df = await diff(ctx, box, file);
  out.removal = { state: rm.state, phases: rm.phases, seconds: rm.seconds, mismatches: df.mismatches, sample: df.sample };
  check(rm.state === 'REMOVED' && df.mismatches === 0, `${tag}: Remove: ${rm.state}, E-flat ${df.mismatches} (the watch sets inside the box)`, df.sample);
  check(rm.phases.includes('draining'), `${tag}: the view's fluidsRemoval said draining while the river drained (${json(rm.phases)})`);
  const rv2 = await river(ctx, r.region);
  check(itemsOf(rv2) === 0, `${tag}: 0 new item entities through the removal (${itemsOf(rv2)})`);
  await L.leaveWorld();
  return out;
}

// ------------------------------------------------------------------ WU (8c-ingame)

export const INGAME = [
  { key: 'river', name: 'river_demo: PLACED, census equal, the wash clears journaled, Remove E-flat 0, 0 items', run: (ctx) => fullRow(ctx, 'river', 'river_demo', { expectFlowing: 126 }) },
  { key: 'fall', name: 'fall_island: PLACED, census equal, Remove E-flat 0', run: (ctx) => fullRow(ctx, 'fall', 'fall_island', { expectFlowing: 51 }) },
  { key: 'nowash', name: 'the control: river_demo nowash washes its meadow (the mint the wash rule stops), recorded', run: nowash },
  { key: 'torch', name: 'the wash rule at the gate: a torch placed in a predicted cell after approval holds the head (why wash), 0 items', run: torch },
  { key: 'foreign', name: 'W5 in the drain: a player\'s source in the current is foreign: the drain leaves it', run: foreign },
  { key: 'join', name: 'a Remove asked while the river drains joins the removal (never SITE_BUSY)', run: join },
];

async function nowash(ctx) {
  const { L, check, json } = ctx;
  const g = await fresh(ctx, 'G6B 8c nowash');
  const M = await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, 'river_demo', 'nowash', { variant: 'nowash' });
  const box = boxOf(g);
  const r = await realise(ctx, ck.artifactSha);
  if (r.refused) { check(false, `nowash: refused ${json(r.refused)}`); return {}; }
  await sleep(3000);
  const rv = await river(ctx, r.region);
  const ents = await itemEntities(ctx, box);
  const left = await fluidsIn(ctx, boxAround(M.meadow, 0));
  const out = { items: itemsOf(rv), entities: ents, state: r.view.state, flowers: M.meadow.length, meadowWater: left.size };
  check(true, `nowash (recorded, the control): without the wash list the flow washes the meadow's ${M.meadow.length} flowers: ${out.items} item entit(ies) from the predicted cells, ${ents} in the box (${r.view.state})`);
  await L.leaveWorld();
  return out;
}

async function torch(ctx) {
  const { L, check, json } = ctx;
  const g = await fresh(ctx, 'G6B 8c torch');
  const M = await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, 'river_demo', 'torch');
  const box = boxOf(g);
  const file = await snap(ctx, box, '8c-torch');
  // a torch on the meadow's north lane (a predicted cell, not a wash cell) after approval, right before the fluids gate's check
  const t = [M.meadow[1][0], M.meadow[1][1], M.meadow[1][2] - 1];
  await L.call('dev.fluid.beforeGate', { setblock: [[...t, 'minecraft:torch']] }, 10_000);
  const r = await realise(ctx, ck.artifactSha);
  if (r.refused) { check(false, `torch: refused ${json(r.refused)}`); return {}; }
  await sleep(3000);
  const rows = r.fluids;
  const head = rows.find((x) => x.body === 'river_r1');
  const tail = rows.find((x) => x.body === 'river_r2');
  const stands = await L.call('dev.fluid.census', { box: [...t, ...t] }, 60_000);
  const rv = await river(ctx, r.region);
  const out = { state: r.view.state, head, tail, items: itemsOf(rv) };
  check(head?.state === 'drained' && head?.why === 'wash' && /M25:wash/.test(head?.reason ?? '') && tail?.state === 'settled' && r.view.state === 'PARTIAL',
    `torch: the head is not written (drained, why ${head?.why}: ${String(head?.reason ?? '').slice(0, 120)}); the pool it lands in stands (${tail?.state}); the region ${r.view.state}`);
  check(itemsOf(rv) === 0 && stands.fluids.length === 0, `torch: 0 item entities from the predicted cells (${itemsOf(rv)}), no water at the torch (${stands.fluids.length})`);
  const rm = await removeWatched(ctx, r.region);
  await sleep(3000);
  const df = await diff(ctx, box, file);
  const onlyTorch = df.mismatches === 1 && (df.sample[0]?.pos ?? df.sample[0]?.at ?? df.sample[0] ?? []).toString().includes(String(t[0]));
  out.removal = { state: rm.state, mismatches: df.mismatches, sample: df.sample };
  check(rm.state === 'REMOVED' && df.mismatches <= 1, `torch: Remove ${rm.state}: E-flat ${df.mismatches} (the player's torch alone, never taken: ${onlyTorch})`, df.sample);
  await L.leaveWorld();
  return out;
}

async function foreign(ctx) {
  const { L, check, json } = ctx;
  const g = await fresh(ctx, 'G6B 8c foreign');
  const M = await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, 'river_demo', 'foreign');
  const r = await realise(ctx, ck.artifactSha);
  if (r.refused) { check(false, `foreign: refused ${json(r.refused)}`); return {}; }
  check(r.view.state === 'PLACED', `foreign: PLACED (${r.view.state})`);
  // a player's water source in the meadow run's south lane (natural ground, a predicted cell, no journal cell of the region's)
  const s = [M.meadow[2][0], M.meadow[2][1], M.meadow[2][2] + 1];
  await L.cmd(`/setblock ${s.join(' ')} minecraft:water`);
  await sleep(4000);
  const rm = await removeWatched(ctx, r.region);
  await sleep(3000);
  const at = await L.call('dev.fluid.census', { box: [...s, ...s] }, 60_000);
  const src = at.fluids.find((q) => q[0] === s[0] && q[1] === s[1] && q[2] === s[2]);
  const out = { removal: rm.state, phases: rm.phases, source: src ?? null };
  check(rm.state === 'REMOVED' && !!src && /^minecraft:water(\[level=0\])?$/.test(src[3]), `foreign: the removal leaves the player's source in the current (${json(src ?? null)}; ${rm.state}, phases ${json(rm.phases)})`);
  await L.leaveWorld();
  return out;
}

async function join(ctx) {
  const { L, check, json } = ctx;
  const g = await fresh(ctx, 'G6B 8c join');
  await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, 'river_demo', 'join');
  const box = boxOf(g);
  const file = await snap(ctx, box, '8c-join');
  const r = await realise(ctx, ck.artifactSha);
  if (r.refused) { check(false, `join: refused ${json(r.refused)}`); return {}; }
  const rm = await removeWatched(ctx, r.region, { again: true });
  await sleep(3000);
  const df = await diff(ctx, box, file);
  const sec = rm.second;
  const busy = JSON.stringify(sec ?? {}).includes('SITE_BUSY');
  const out = { second: sec, state: rm.state, phases: rm.phases, mismatches: df.mismatches };
  check(!!sec && !busy && !sec.error && sec.removed !== false, `join: a Remove asked while draining joins the removal (${json(sec)})`);
  check(rm.state === 'REMOVED' && df.mismatches === 0, `join: the removal ends REMOVED, E-flat ${df.mismatches}`, df.sample);
  await L.leaveWorld();
  return out;
}

// ------------------------------------------------------------------ CR (8c-crash)

async function crashAt(ctx, world, point, action) {
  const L = ctx.L;
  await L.call('dev.journal.killAt', { point }, 10_000);
  action().catch(() => null);
  let down = false;
  for (let i = 0; i < 240 && !down; i++) {
    await sleep(2000);
    const s = await L.call('dev.state', {}, 10_000).catch(() => null);
    down = !!s && s.inWorld === false;
  }
  if (!down) throw new Error(`the kill point ${point} did not halt the server`);
  ctx.log(`  ${point}: the server halted; opening ${world} again`);
  await L.openWorld(world);
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 40, (CLAIM[1] + CLAIM[3]) / 2);
}
async function lastRegion(ctx) {
  return (await ctx.L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
}

/** One kill point: before it, the snapshot; the action halted there; after the start, the realise or removal resumed; E-flat, items, conservation. */
async function crashRow(ctx, point, during) {
  const { L, check, json } = ctx;
  const tag = point.replace('+', 'p').toLowerCase();
  const world = `G6B 8c Crash ${tag}`;
  const g = await fresh(ctx, world);
  await plantMeadow(ctx, g);
  const ck = await checkHand(ctx, 'river_demo', `crash-${tag}`);
  const box = boxOf(g);
  const file = await snap(ctx, box, `8c-crash-${tag}`);
  const before = await fluidsIn(ctx, box);
  const ents0 = await itemEntities(ctx, box);
  const out = { point, during };
  let region = null;
  if (during === 'realise') {
    await crashAt(ctx, world, point, async () => { region = (await L.call('dev.region.realiseApproved', { sha: ck.artifactSha }, 300_000)).region; });
    region ??= await lastRegion(ctx);
    await L.waitRegion(region, 3_600_000);
    const r = await regionOf(ctx, region);
    out.realise = { state: r.view.state, rows: r.fluids.map((x) => [x.body, x.state, x.why ?? null]) };
    // (a bare halt before the gate's check may lose the earlier stages' unsaved chunks: the start's check then finds the shells gone, and
    // no body is written (H §3.5: drained, uncontained, nothing of it stands); with +save, or once the check passed, the realise completes)
    const lost = !point.includes('+save') && r.view.state === 'PARTIAL' && r.fluids.every((x) => x.state === 'drained' && x.why === 'uncontained');
    check(r.view.state === 'PLACED' && r.fluids.every((x) => x.state === 'settled') || lost, `${point}: the start resumes the realise: ${r.view.state} (${json(out.realise.rows)})${lost ? ' (the halt lost the unsaved shells: nothing written, H §3.5)' : ''}`);
    if (!lost) {
      const cs = await censusAll(ctx, r, before);
      check(cs.ok, `${point}: every census equals its prediction after the resume (${json(cs.sum)})`);
    }
    const rm = await removeWatched(ctx, region);
    out.removal = rm.state;
  } else {
    const r = await realise(ctx, ck.artifactSha);
    region = r.region;
    check(r.view?.state === 'PLACED', `${point}: realised and settled before the removal (${r.view?.state})`);
    await crashAt(ctx, world, point, async () => { await L.call('dev.region.remove', { region, requester: OWNER }, 600_000); });
    // (Steward's SD2 sweep asks for the Remove again after a restart: it joins the resumed removal)
    const rm = await removeWatched(ctx, region);
    out.removal = rm.state;
    out.again = rm.first;
    check(!JSON.stringify(rm.first ?? {}).includes('SITE_BUSY'), `${point}: the Remove asked again after the start joins the resumed removal, never SITE_BUSY (${json(rm.first)})`);
  }
  await sleep(3000);
  const df = await diff(ctx, box, file);
  out.mismatches = df.mismatches;
  check(out.removal === 'REMOVED' && df.mismatches === 0, `${point}: the region removed (${out.removal}), E-flat ${df.mismatches}`, df.sample);
  const rv = await river(ctx, region);
  const ents1 = await itemEntities(ctx, box);
  out.items = { river: itemsOf(rv), before: ents0, after: ents1 };
  check(itemsOf(rv) === 0 && (ents1 ?? 0) - (ents0 ?? 0) === 0, `${point}: conservation: 0 new item entities from the bodies' cells (${itemsOf(rv)}), the box's items ${ents0} -> ${ents1}`);
  await L.leaveWorld();
  return out;
}

export const CRASH = [
  ['FL7', 'realise'], ['FL7+save', 'realise'],
  ['FL8', 'removal'], ['FL8+save', 'removal'],
  ['FL9', 'removal'], ['FL9+save', 'removal'],
  ['FL1+save', 'realise'], ['FL2+save', 'realise'], ['FL4+save', 'realise'], ['FL5+save', 'removal'],
].map(([point, during]) => ({ key: point.replace('+', 'p').toLowerCase(), name: `${point} (${during})`, run: (ctx) => crashRow(ctx, point, during) }));

// ------------------------------------------------------------------ PB (8c-probe): recorded

/**
 * PB, recorded: (a) river_demo's long flow, census against prediction cell by cell and its settles; (b) fall damage at 24, 32 and 48
 * drops into basins 2 and 3 deep (villagers over /fill basins). Written into kit/lint/water-calibration.json's `flowing` member.
 */
export async function probe(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  {
    const g = await fresh(ctx, 'G6B 8c Probe');
    await plantMeadow(ctx, g);
    const ck = await checkHand(ctx, 'river_demo', 'probe');
    const before = await fluidsIn(ctx, boxOf(g));
    const r = await realise(ctx, ck.artifactSha);
    const cs = await censusAll(ctx, r, before);
    out.river = { state: r.view?.state, settles: Object.fromEntries((r.fluids ?? []).map((x) => [x.body, x.settledAt])), bounds: Object.fromEntries(r.bodies.map((b) => [b.id, b.settleTicks])), census: cs.sum, mismatch: Object.fromEntries(Object.entries(cs.all).map(([k, v]) => [k, v.mismatch])) };
    check(true, `PB (recorded): river_demo's long flow: census ${cs.ok ? '==' : '!='} prediction (${json(cs.sum)}); settles ${json(out.river.settles)} within bounds ${json(out.river.bounds)}`);
    await L.leaveWorld();
  }
  {
    const g = await fresh(ctx, 'G6B 8c Falls');
    const res = [];
    const t0 = Date.now();
    let x = CLAIM[0] + 6;
    for (const depth of [2, 3]) for (const h of [24, 32, 48]) {
      const z = CLAIM[1] + 10 + depth * 12;
      const s = g + 4;
      await L.cmd(`/fill ${x - 1} ${g + 1} ${z - 1} ${x + 1} ${s} ${z + 1} minecraft:stone`);
      await L.cmd(`/fill ${x} ${s - depth + 1} ${z} ${x} ${s} ${z} minecraft:water`);
      await L.tp(x, s + 60, z);
      await L.cmd(`/summon minecraft:villager ${x + 0.5} ${s + h + 0.5} ${z + 0.5} {CustomName:'"fall_${depth}_${h}"',PersistenceRequired:1b}`);
      res.push({ depth, h, at: [x, s, z] });
      x += 4;
    }
    await sleep(12000);
    const dmg = await L.call('dev.entity.damage', { since: t0, type: 'fall' }, 10_000);
    for (const q of res) q.fall = dmg.events.filter((e) => Math.abs(e.at[0] - q.at[0]) <= 1 && Math.abs(e.at[2] - q.at[2]) <= 1).reduce((a, e) => a + e.amount, 0);
    out.falls = res.map((q) => ({ depth: q.depth, drop: q.h, fall: q.fall }));
    log(`  PB, recorded: fall damage by (depth, drop): ${json(res.map((q) => [q.depth, q.h, q.fall]))}`);
    check(true, `PB (recorded): fall damage landing in water by (depth, drop): ${json(res.map((q) => [q.depth, q.h, q.fall]))}`);
    await L.leaveWorld();
  }
  {
    // (c) WM's approximations (the coordinator's PB item): a waterlogged block is a foreign source whose collision faces stop its water
    // (world.mjs wlMask: stairs, slabs and closed trapdoors only); each block alone on a stone pad, its 4 sides and the cell under it open:
    // which faces does vanilla's water leave by, against the faces WM's mask leaves open? Recorded, not judged. (A v4 volume's block ids
    // carry no properties: the planner reads a waterlogged state only from the plan's own writes.)
    const g = await fresh(ctx, 'G6B 8c WL');
    const W = await import(pathToFileURL(path.join(ctx.KIT, 'lib', 'fluids', 'world.mjs')).href);
    const states = ['minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=true]', 'minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=true]',
      'minecraft:oak_slab[type=bottom,waterlogged=true]', 'minecraft:oak_slab[type=top,waterlogged=true]', 'minecraft:oak_trapdoor[half=bottom,open=false,waterlogged=true]',
      'minecraft:oak_trapdoor[facing=north,half=bottom,open=true,waterlogged=true]', 'minecraft:oak_fence[waterlogged=true]', 'minecraft:cobblestone_wall[waterlogged=true]',
      'minecraft:glass_pane[waterlogged=true]', 'minecraft:iron_bars[waterlogged=true]', 'minecraft:lantern[waterlogged=true]', 'minecraft:ladder[facing=north,waterlogged=true]'];
    const F = { east: [1, 0, 0], west: [-1, 0, 0], south: [0, 0, 1], north: [0, 0, -1], down: [0, -1, 0] };
    const BIT = { east: 1, west: 2, south: 4, north: 8, up: 16, down: 32 };
    const rows = [];
    let x = CLAIM[0] + 6;
    const z = CLAIM[1] + 30;
    for (const st of states) {
      // a pad of stone 7 x 7 at g + 3 with a 1-cell well under the block (to g + 1), the block at g + 4
      await L.cmd(`/fill ${x - 3} ${g + 3} ${z - 3} ${x + 3} ${g + 3} ${z + 3} minecraft:stone`);
      await L.cmd(`/setblock ${x} ${g + 3} ${z} minecraft:air`);
      await L.cmd(`/setblock ${x} ${g + 4} ${z} ${st}`);
      rows.push({ state: st, at: [x, g + 4, z] });
      x += 9;
    }
    await L.call('dev.fluid.tick', { cells: rows.map((r) => r.at) }, 10_000).catch(() => null);
    await sleep(6000);
    for (const r of rows) {
      const [bx, by, bz] = r.at;
      const c = await L.call('dev.fluid.census', { box: [bx - 1, by - 1, bz - 1, bx + 1, by, bz + 1] }, 60_000);
      const wet = new Set(c.fluids.filter((q) => /^minecraft:water/.test(q[3])).map((q) => `${q[0]},${q[1]},${q[2]}`));
      r.vanilla = Object.entries(F).filter(([, d]) => wet.has(`${bx + d[0]},${by + d[1]},${bz + d[2]}`)).map(([k]) => k);
      const m = W.wlMask(r.state);
      r.wm = m === null ? 'none' : Object.keys(F).filter((k) => !(m & BIT[k]));
      r.agree = Array.isArray(r.wm) && JSON.stringify([...r.wm].sort()) === JSON.stringify([...r.vanilla].sort());
      r.noProps = W.wlMask(r.state.replace(/\[.*$/, '')); // (what a v4 volume's id alone gives)
    }
    out.waterlogged = rows.map((r) => ({ state: r.state, vanilla: r.vanilla, wm: r.wm, agree: r.agree, fromIdAlone: r.noProps }));
    check(true, `PB (recorded): a waterlogged block's open faces, vanilla against WM's mask: ${json(out.waterlogged.map((r) => [r.state.replace('minecraft:', '').replace(/,?waterlogged=true/, ''), r.vanilla.join('+'), Array.isArray(r.wm) ? r.wm.join('+') : r.wm, r.agree]))}`);
    await L.leaveWorld();
  }
  const f = path.join(ctx.root, 'kit', 'lint', 'water-calibration.json');
  const cal = JSON.parse(fs.readFileSync(f, 'utf8'));
  cal.flowing = { about: '(8c PB, tools/gate8c.mjs probe) recorded, not judged: river_demo\'s in-game settles and census against its prediction; fall damage landing in water by basin depth and drop', river: out.river, falls: out.falls, recorded: { at: new Date().toISOString().slice(0, 10) } };
  fs.writeFileSync(path.join(ctx.OUT, 'water-calibration-8c.json'), `${JSON.stringify(cal.flowing, null, 1)}\n`);
  out.record = 'artifacts water-calibration-8c.json (copy into kit/lint/water-calibration.json `flowing` by hand)';
  return out;
}

export { bodiesOf };
