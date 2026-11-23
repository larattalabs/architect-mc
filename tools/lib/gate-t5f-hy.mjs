// (slice T5Fb, CONTRACT T5F §4.2, §7) T5F's ordered-course rows on hy_core_demo (a flat world, headless; run by tools/gate6chy.mjs, steps
// t5clr and t5clx): the waiting reaches' fluid.clear (WROTE -> CLEARED, written again at their wave) and its TX points.
import { CLAIM, censusOf, checkCourse, freshCourse, realiseApproved, regionOf, removeWait, boxOf, snap, diff } from './gate6chy-core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;

async function waitDown(ctx) {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await ctx.L.call('dev.state', {}, 10_000).catch(() => null);
    if (s && s.inWorld === false) return true;
  }
  return false;
}

async function sourcesOf(ctx, cells) {
  const set = new Set(cells.map(k3));
  const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]), zs = cells.map((c) => c[2]);
  const box = [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  const c = await ctx.L.call('dev.fluid.census', { box }, 120_000);
  return c.fluids.filter(([x, y, z, s]) => set.has(`${x},${y},${z}`) && (s === 'minecraft:water' || s === 'minecraft:water[level=0]')).map(([x, y, z]) => [x, y, z]);
}

/** A top-layer cell with the fewest horizontal neighbours in the body (an edge source). */
function edgeCell(body) {
  const own = new Set(body.cells.map(k3));
  const ymax = Math.max(...body.cells.map((c) => c[1]));
  const n = (c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => own.has(`${c[0] + dx},${c[1]},${c[2] + dz}`)).length;
  return body.cells.filter((c) => c[1] === ymax).sort((a, b) => n(a) - n(b) || a[0] - b[0] || a[2] - b[2])[0];
}

async function lastRegion(ctx) {
  return (await ctx.L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
}

/**
 * t5-water-bucket's ordered variant (P2-a, N3; §4.2's clear): hy_core_demo with the write held; the tiles write every body; the player
 * buckets an edge source of a waiting water reach (one with `after`; vanilla's infinite-source rule off); released: the first wave's
 * fluid.clear clears the reach (CLEARED) but keeps the bucketed cell WROTE; at its wave the reach is written again except that cell
 * (Architect's traced writes include the reach, never the cell); every standing cell ends WROTE. Recorded, not judged: the course's
 * end state with the hole (N3: the census reacts as it does today). Regions.remove ends REMOVED.
 */
export async function clearBucket(ctx) {
  const { L, check, log, json } = ctx;
  const out = {};
  const world = 'G6B HY T5CLR';
  await freshCourse(ctx, world, 'exact');
  await L.cmd('/gamerule water_source_conversion false');
  const ck = await checkCourse(ctx, 't5clr');
  await L.call('dev.fluid.hold', { write: true }, 10_000);
  let region = null;
  try {
    region = (await L.call('dev.region.realiseApproved', { sha: ck.artifactSha }, 300_000)).region;
    let r = null;
    for (let i = 0; i < 300; i++) { r = await regionOf(ctx, region).catch(() => null); if (r?.fstate?.phase === 'writing') break; await sleep(2000); }
    const reach = (r?.bodies ?? []).find((b) => b.fluid !== 'lava' && b.after.length > 0 && b.grate.length === 0);
    check(!!reach, `CLR: the precondition: a waiting water reach (after ${json(reach?.after)})`);
    if (!reach) return out;
    for (let i = 0; i < 300; i++) { if ((await sourcesOf(ctx, reach.cells)).length >= reach.cells.length) break; await sleep(2000); }
    const cell = edgeCell(reach);
    const b = await L.call('dev.player.bucket', { at: cell }, 30_000);
    await sleep(3000);
    const empty = !(await sourcesOf(ctx, [cell])).length;
    out.pre = { reach: reach.id, cells: reach.cells.length, cell, bucket: b?.result, empty };
    check(/success|consume/i.test(String(b?.result)) && empty, `CLR: the precondition: the tiles wrote reach ${reach.id}, the player bucketed ${k3(cell)} (${b?.result}); empty with the write held (${empty})`);
    await L.call('dev.fluid.writeTrace', { on: true }, 10_000);
    await L.call('dev.fluid.hold', { write: false }, 10_000);
    const st = await L.waitRegion(region, 3_600_000);
    await sleep(3000);
    const trace = (await L.call('dev.fluid.writeTrace', { on: false }, 10_000)).cells ?? [];
    const traced = new Set(trace.map(k3));
    const rewrote = traced.has(k3(cell));
    const reachWritten = reach.cells.filter((c) => traced.has(k3(c))).length;
    const mk = await L.call('dev.fluid.marks', { region }, 30_000);
    const rb = (mk.bodies ?? []).find((x) => x.id === reach.id) ?? {};
    const unmarked = (mk.bodies ?? []).reduce((a, x) => a + (x.standing - x.wroteStanding), 0);
    const r2 = await regionOf(ctx, region);
    out.after = { state: st.view.state, fluids: r2.fluids.map((x) => [x.body, x.state, x.reason ?? null]), rewrote, reachWritten, reachMarks: rb, unmarked, traced: trace.length };
    log(`  CLR: ${json(out)}`);
    check(!rewrote, `CLR (P2-a, N3): Architect never writes the bucketed reach cell ${k3(cell)} (red on 8cT: writeBody writes it again)`);
    check(reachWritten > 0 && reachWritten <= reach.cells.length - 1 && rb.cleared === 0, `CLR (§4.2 regression): the cleared reach written again at its wave: ${reachWritten} traced writes of ${reach.cells.length} cells, CLEARED left ${rb.cleared}`);
    check(unmarked === 0 && rb.takenWrote >= 0, `CLR (I1): every standing cell WROTE (unmarked ${unmarked}); the bucketed cell WROTE and not standing (${rb.takenWrote})`);
    const rm = await removeWait(ctx, region).catch((e) => ({ state: `error ${e.message}` }));
    out.removal = rm.state;
    check(rm.state === 'REMOVED', `CLR: Regions.remove ends REMOVED (${rm.state})`);
  } finally {
    await L.call('dev.fluid.hold', { write: false }, 10_000).catch(() => null);
    await L.call('dev.fluid.writeTrace', { on: false }, 10_000).catch(() => null);
    await L.leaveWorld().catch(() => null);
  }
  return out;
}

/**
 * The TX matrix's ordered points (§7): hy_core_demo realised and halted at TX:fluid.write:clear (the first clear W and its receipt),
 * +save and bare: the start replays the wave txn; PLACED, every body settled, census equal, 0 fluid outside, every standing cell WROTE,
 * none CLEARED left; Regions.remove E-flat 0.
 */
export async function clearTx(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  for (const point of ['TX:fluid.write:clear+save', 'TX:fluid.write:clear']) {
    const tag = point.endsWith('+save') ? 'save' : 'bare';
    const world = `G6B HY T5CLX ${tag}`;
    const { g } = await freshCourse(ctx, world, 'exact');
    const ck = await checkCourse(ctx, `t5clx-${tag}`);
    const box = boxOf(g);
    const file = await snap(ctx, box, `hy-t5clx-${tag}`);
    let region = null;
    await L.call('dev.journal.killAt', { point }, 10_000);
    L.call('dev.region.realiseApproved', { sha: ck.artifactSha }, 300_000).then((x) => { region = x.region; }).catch(() => null);
    const down = await waitDown(ctx);
    check(down, `CLX (${point}): the precondition: the kill point halted the server`);
    if (!down) return out;
    await L.openWorld(world);
    await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
    region ??= await lastRegion(ctx);
    const st = await L.waitRegion(region, 3_600_000);
    const r = await regionOf(ctx, region);
    let outside = 0, mism = 0;
    for (const b of r.bodies) { const c = await censusOf(ctx, b, null, r.bodies); outside += c.outsideCount; mism += c.mismatch.length; }
    const mk = await L.call('dev.fluid.marks', { region }, 30_000);
    const unmarked = (mk.bodies ?? []).reduce((a, x) => a + (x.standing - x.wroteStanding), 0);
    const cleared = (mk.bodies ?? []).reduce((a, x) => a + x.cleared, 0);
    const rm = await removeWait(ctx, region).catch((e) => ({ state: `error ${e.message}` }));
    await sleep(3000);
    const df = await diff(ctx, box, file);
    out[tag] = { state: st.view.state, fluids: r.fluids.map((x) => [x.body, x.state]), outside, mism, unmarked, cleared, removal: rm.state, mismatches: df.mismatches };
    check(st.view.state === 'PLACED' && r.fluids.length === 4 && r.fluids.every((x) => x.state === 'settled') && outside === 0 && mism === 0, `CLX (${point}): the start replays the wave: ${st.view.state} (${json(out[tag].fluids)}), census ${mism}, outside ${outside}`);
    check(unmarked === 0 && cleared === 0, `CLX (${point}): every standing cell WROTE (unmarked ${unmarked}), no CLEARED left (${cleared})`);
    check(rm.state === 'REMOVED' && df.mismatches === 0, `CLX (${point}) conservation: Regions.remove ${rm.state}, E-flat ${df.mismatches}`, df.sample);
    await L.leaveWorld();
  }
  return out;
}
