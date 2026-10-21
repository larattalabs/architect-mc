// (fix/drain-holders) The H gate's holder items (tools/gate6ch.mjs steps `holders` and `rmcrash`): a region's whole-group drain against a
// later site that holds a body cell (docs/CONTRACT.md 6d review responses, third pass, finding 4 "on main too"), and the crash windows of a
// plain Regions.remove around its R2 commit (finding 2).
//
//   holders  (h-holders)   h_core_demo realised under the exact rules; a separate cell site (another owner's addition, as Steward's, placed
//                          with OverlapPolicy.LAYER) puts a waterlogged oak stair in one of the pond's interior source cells; the stack there
//                          is the region's cell under the stair site's. Regions.remove (covered keep): the stair stands, waterlogged, the
//                          only fluid left in the pond's watch box; E-flat 0 outside that cell; the removal hands the cell down to the
//                          stair site. Then the stair site removed: E-flat 0 over the whole box, nothing kept.
//   rmcrash  (h-rmcrash)   the same world, the removal halted at FL3+save (drained, before the solids: the resumed drain runs again),
//                          K6+save (R2 committed, the records not yet pending), R2q+save (R2 durable, the queue file not saved after it)
//                          and K7+save (mid-R4: a region cell site's restore halted after its first 64 cells; RG6 fires only in a template site's restore); each reopened and the removal asked again: REMOVED,
//                          E-flat 0 outside the stair cell, the stair kept, and after the stair site goes E-flat 0.
import { CLAIM, OWNER, censusOf, crashAt, demoBox, diff, freshFlat, planDemo, realiseWait, snap } from './gate6ch-core.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
export const STAIR = 'minecraft:oak_stairs[waterlogged=true]';

/** An /apitest step's JSON answer. */
async function api(ctx, args) {
  const r = await ctx.L.cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('['));
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
  return JSON.parse(line);
}
/** An async /apitest step: started, then its result polled with `get <key>`. */
async function later(ctx, args, key, timeoutMs = 600_000) {
  await api(ctx, args);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const g = await api(ctx, `get ${key}`);
    if (g.value !== undefined && g.value !== null) return g.value;
    await sleep(500);
  }
  throw new Error(`/apitest ${args}: no result for ${key}`);
}

/** The pond's interior top source cell: the highest layer, its four sides pond cells too (a cell whose neighbours all drain). */
export function stairCell(pond) {
  const own = new Set(pond.cells.map(k3));
  const ice = new Set(pond.ice.map(k3));
  const top = Math.max(...pond.cells.map((c) => c[1]));
  const inner = pond.cells.filter(([x, y, z]) => y === top && !ice.has(k3([x, y, z])) && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => own.has(`${x + dx},${y},${z + dz}`)));
  inner.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  return inner[Math.floor(inner.length / 2)] ?? null;
}

/** The state at one cell (dev.fluid.census lists every fluid cell; none: no fluid there). */
async function fluidAt(ctx, c) {
  const r = await ctx.L.call('dev.fluid.census', { box: [c[0], c[1], c[2], c[0], c[1], c[2]] }, 60_000);
  return r.fluids.find(([x, y, z]) => x === c[0] && y === c[1] && z === c[2])?.[3] ?? null;
}

/** Regions.remove asked (covered keep), then the region's state polled until it ends; a removal that answers removed: false ends at once. */
async function removeRegion(ctx, region) {
  const L = ctx.L;
  const t0 = Date.now();
  const r = await L.call('dev.region.remove', { region, requester: OWNER, covered: 'keep' }, 3_600_000).catch((e) => ({ error: String(e.message ?? e) }));
  for (let i = 0; i < 1200; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return { result: r, seconds: (Date.now() - t0) / 1000, state: s ?? 'REMOVED' };
    if (s === 'PARTIAL' || s === 'FAILED' || r.removed === false || r.error) return { result: r, seconds: (Date.now() - t0) / 1000, state: s };
    await sleep(500);
  }
  return { result: r, seconds: (Date.now() - t0) / 1000, state: 'TIMEOUT' };
}

/**
 * A world with h_core_demo realised (exact rules), its pre-region snapshot, and the stair site layered over a pond source cell; the
 * precondition checked: the stair site's cell on top of the region's (another group, a higher layer).
 */
async function setUp(ctx, world, tag) {
  const { L, check, json } = ctx;
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, {});
  const pond = d.bodies.find((b) => b.id === 'pond');
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, `h-holders-${tag}`);
  const r = await realiseWait(ctx, d.p.planId);
  const settled = r.view.state === 'PLACED' && (r.fluids ?? []).every((x) => x.state === 'settled');
  check(settled, `${tag}: h_core_demo PLACED, every body settled (${r.view.state}; ${json((r.fluids ?? []).map((x) => [x.body, x.state]))})`);
  const cell = stairCell(pond);
  if (!cell) throw new Error('the pond has no interior top source cell');
  const under = await L.call('dev.journal.at', { x: cell[0], y: cell[1], z: cell[2] }, 10_000);
  const placed = await later(ctx, `cells ${json({ kind: 'apitest:stair', cells: [[cell[0], cell[1], cell[2], STAIR]], overlap: 'LAYER', naturalOnly: false, owner: OWNER, tag: `stair${tag}` })}`, `cells:stair${tag}`);
  const stack = (await L.call('dev.journal.at', { x: cell[0], y: cell[1], z: cell[2] }, 10_000)).stack ?? [];
  const top = stack.at(-1);
  const regionCell = stack.slice(0, -1).find((e) => e.group === r.view.groupId || (e.group && e.group !== top?.group));
  const stateNow = await fluidAt(ctx, cell);
  const pre = !!placed.placed && top?.site === placed.siteId && !!regionCell && regionCell.group !== top.group && regionCell.layer < top.layer
    && /^minecraft:oak_stairs\[/.test(stateNow ?? '') && /waterlogged=true/.test(stateNow ?? '');
  check(pre, `${tag}: precondition: the stair site ${placed.siteId} (layered) holds pond source cell ${json(cell)} over the region's own cell (stack ${json(stack.map((e) => [e.site, e.group, e.layer]))}; the world ${stateNow})`, { under: under.stack, stack, placed });
  return { d, pond, box, file, region: r.region, cell, stairSite: placed.siteId, stack };
}

/**
 * After the removal: the stair stands waterlogged, the only fluid of the pond's watch box; E-flat 0 outside its cell; then the stair site
 * removed: E-flat 0 over the box, nothing kept.
 */
async function judge(ctx, tag, s, rm) {
  const { check, json } = ctx;
  const out = { removal: rm.state, seconds: rm.seconds, handedDown: rm.result?.handedDown ?? null, result: rm.result };
  check(rm.state === 'REMOVED', `${tag}: Regions.remove ends REMOVED (${rm.state}; ${json(rm.result?.blockers ?? rm.result?.error ?? null)})`, rm.result);
  const at = await fluidAt(ctx, s.cell);
  out.stair = at;
  check(/^minecraft:oak_stairs\[/.test(at ?? '') && /waterlogged=true/.test(at ?? ''), `${tag}: the stair site's block in pond cell ${json(s.cell)} stands after the removal, waterlogged (${at ?? 'no fluid there'})`);
  const c = await censusOf(ctx, s.pond, null, s.d.bodies);
  const wet = [...c.fluids].filter(([k]) => k !== k3(s.cell));
  out.otherFluid = wet.slice(0, 12);
  check(wet.length === 0, `${tag}: the stair's cell is the only fluid left in the pond's watch box (${wet.length} other: ${json(wet.slice(0, 6))})`);
  // (no `exclude`: before v0.40.1 RegionHash's DIFF skipped an excluded cell without reading its snapshot entry, so every later cell was
  // compared with the previous one's value; fixed in v0.40.1, but the full diff is still read and the stair's cell filtered here)
  const d1 = await ctx.L.call('dev.region.hash', { box: s.box, mode: 'diff', file: s.file }, 4 * 3_600_000);
  const outside = (d1.list ?? []).filter((m) => m.pos !== k3(s.cell));
  d1.mismatches = outside.length + Math.max(0, d1.mismatches - (d1.list ?? []).length);
  d1.list = outside;
  out.eflatOutside = { mismatches: d1.mismatches, sample: (d1.list ?? []).slice(0, 12) };
  check(d1.mismatches === 0, `${tag}: E-flat ${d1.mismatches} outside the stair's cell against the world before the region`, out.eflatOutside.sample);
  const g = await later(ctx, `remove ${s.stairSite} - force`, `remove:${s.stairSite}:-:force`); // (force: its owner is not the player)
  out.stairRemoved = g;
  await sleep(2000);
  const d2 = await diff(ctx, s.box, s.file);
  out.eflatAfterStair = d2;
  check(g.removed && (g.kept ?? 0) === 0 && d2.mismatches === 0, `${tag}: the stair site removed after (kept ${g.kept}): E-flat ${d2.mismatches} over the whole box (the cell handed down to it came back)`, d2.sample);
  return out;
}

/** The holder case without a crash. */
export async function holders(ctx) {
  const s = await setUp(ctx, 'G6B H Holders', 'holders');
  const rm = await removeRegion(ctx, s.region);
  const out = { cell: s.cell, stairSite: s.stairSite, stack: s.stack, ...(await judge(ctx, 'holders', s, rm)) };
  const hd = rm.result?.handedDown ?? {};
  out.handed = hd;
  ctx.check((hd[s.stairSite] ?? 0) >= 1, `holders: the removal hands the cell down to the stair site (handedDown ${ctx.json(hd)})`);
  await ctx.L.leaveWorld();
  return out;
}

/** The holder case through the removal's crash windows (finding 2 with the drain's holders). */
export async function rmcrash(ctx) {
  const out = {};
  for (const point of ['FL3+save', 'K6+save', 'R2q+save', 'K7+save']) {
    const tag = point.replace('+save', '');
    const world = `G6B H Hold ${tag}`;
    ctx.log(`-- ${point}`);
    try {
      const s = await setUp(ctx, world, tag);
      await crashAt(ctx, world, point, async () => { await ctx.L.call('dev.region.remove', { region: s.region, requester: OWNER, covered: 'keep' }, 600_000); });
      await sleep(5000);
      const rm = await removeRegion(ctx, s.region);
      out[tag] = { cell: s.cell, ...(await judge(ctx, tag, s, rm)) };
    } catch (e) {
      ctx.check(false, `${point}: ${String(e?.message ?? e).slice(0, 300)}`);
      out[tag] = { error: String(e?.stack ?? e) };
    }
    await ctx.L.leaveWorld().catch(() => null);
  }
  void CLAIM;
  return out;
}
