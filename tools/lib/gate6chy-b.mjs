// (6c HY) HY-b's items of the HY gate (tools/gate6chy.mjs; docs/CONTRACT.md "Phase 6c slice HY" §14, §15). Slice HY-b owns this file.
// `items` maps a step of the driver (unit, ingame, crash, natural, cold, look) to a list of {name, async run(ctx)}: each runs after
// HY-core's items of that step, with ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp, json, root, check, log, core} (core: HY-core's
// helpers, tools/lib/gate6chy-core.mjs: census, snapshots, removal).
//
// Item 9 (every new kind through Regions.checkPlan and realiseApproved, the H RC lesson): each HY valid/ fixture's terrain is built on a
// fresh copy of the flat base world (tools/lib/gate6chy-b.mjs buildTerrain: its survey bands as dirt, grass and water, shifted to the
// world's claim), then the fixture's own plan goes through dev.region.checkPlan (the two-plan flow) and dev.region.realiseApproved with
// the approval artifact: READY, PLACED with every body settled and each census equal to its prediction, every guard flat, then removed
// under the exact rules and judged E-flat 0 (the terrain itself is in the snapshot, so it is restored exactly or not at all). The
// fixture plan is the same JSON kit CI checks, so the kit and the game check one plan.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;

/** The world claim's corner for every fixture (the flat base, clear of HY-core's 9300..9395). */
export const WORLD = Object.freeze({ X0: 9500, Z0: 9000, ground: -61 });
/** The asks claim as survey bands (plan-helpers.mjs asksSurvey: the lake and the stream to the east edge). */
export const ASKS = Object.freeze({ W: 320, D: 320, x0: 0, z0: 0, y: 64, bands: [{ x0: 240, x1: 279, z0: 240, z1: 267, y: 60, water: 4 }, { x0: 280, x1: 319, z0: 252, z1: 255, y: 60, water: 4 }] });
export const FLAT = Object.freeze({ W: 240, D: 160, x0: 1000, z0: 2000, y: 64, bands: [] });

/** A fixture's terrain ({W, D, x0, z0, y, bands}). */
export function terrainOf(fx) {
  if (fx.terrain) return { W: 240, D: 160, x0: 1000, z0: 2000, y: 64, bands: [], ...fx.terrain };
  if (fx.on === 'asks') return ASKS;
  if (fx.on === 'flat' || !fx.on) return FLAT;
  throw new Error(`terrainOf: no in-game terrain for on: ${fx.on}`);
}

/** The world placement of a terrain: {claim: [x0, z0, x1, z1], dx, dz, off (kit y + off = world y), minY, maxY}. */
export function worldOf(T, ground = WORLD.ground) {
  let lo = T.y, hi = T.y;
  for (const b of T.bands) { lo = Math.min(lo, b.y); hi = Math.max(hi, b.water ? b.y + b.water : b.y); }
  // (the lowest floor stands one over the flat world's grass, so every band is built over it)
  const off = ground + 1 - lo;
  const dx = WORLD.X0 - T.x0, dz = WORLD.Z0 - T.z0;
  return { claim: [WORLD.X0, WORLD.Z0, WORLD.X0 + T.W - 1, WORLD.Z0 + T.D - 1], dx, dz, off, minY: lo + off, maxY: hi + off, ground };
}

/** /fill a box in slabs of at most 32768 blocks. */
async function fillBox(L, [x0, y0, z0, x1, y1, z1], block) {
  if (y1 < y0) return;
  if (block === 'minecraft:water' || block === 'minecraft:air') { /* (sources and air: placed as given) */ }
  if (y1 < y0) return;
  const per = (y1 - y0 + 1) * (z1 - z0 + 1);
  const step = Math.max(1, Math.floor(32768 / per));
  if (per > 32768) {
    const zs = Math.max(1, Math.floor(32768 / (y1 - y0 + 1)));
    for (let z = z0; z <= z1; z += zs) await fillBox(L, [x0, y0, z, x1, y1, Math.min(z1, z + zs - 1)], block);
    return;
  }
  for (let x = x0; x <= x1; x += step) {
    const r = await L.cmd(`/fill ${x} ${y0} ${z0} ${Math.min(x1, x + step - 1)} ${y1} ${z1} ${block}`);
    const msg = JSON.stringify(r?.messages ?? r ?? '');
    if (/not loaded|too many|cannot|Unknown|error/i.test(msg)) throw new Error(`/fill ${x} ${y0} ${z0}: ${msg.slice(0, 200)}`);
  }
}

/** Build a terrain over the flat base (the claim and 8 round it): dirt to the ground, grass on top; each band as flatSurvey reads it. */
export async function buildTerrain(ctx, T) {
  const L = ctx.L;
  const w0 = worldOf(T);
  const [cx0, cz0, cx1, cz1] = w0.claim;
  // (every chunk of the claim and 8 round it loaded while it is built: /forceload, at most 256 chunks a call)
  await L.tp((cx0 + cx1) / 2, 120, (cz0 + cz1) / 2);
  for (let x = (cx0 - 8) >> 4; x <= (cx1 + 8) >> 4; x += 12) for (let z = (cz0 - 8) >> 4; z <= (cz1 + 8) >> 4; z += 12) {
    await L.cmd(`/forceload add ${x * 16} ${z * 16} ${Math.min((cx1 + 8) >> 4, x + 11) * 16 + 15} ${Math.min((cz1 + 8) >> 4, z + 11) * 16 + 15}`);
  }
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  await L.settle(3000);
  // (the flat base's own ground, surveyed: every band is built over it)
  const ground = await ctx.core.groundOf(ctx, w0.claim);
  const W = worldOf(T, ground);
  const g = (y) => y + W.off;
  const base = [cx0 - 8, W.ground + 1, cz0 - 8, cx1 + 8, g(T.y), cz1 + 8];
  if (g(T.y) > W.ground + 1) await fillBox(L, [base[0], base[1], base[2], base[3], g(T.y) - 1, base[5]], 'minecraft:dirt');
  await fillBox(L, [base[0], g(T.y), base[2], base[3], g(T.y), base[5]], 'minecraft:grass_block');
  for (const b of T.bands) {
    const bx0 = Math.max(T.x0, b.x0) + W.dx, bx1 = Math.min(T.x0 + T.W - 1, b.x1) + W.dx, bz0 = Math.max(T.z0, b.z0) + W.dz, bz1 = Math.min(T.z0 + T.D - 1, b.z1) + W.dz;
    const top = Math.max(g(T.y), g(b.water ? b.y + b.water : b.y)) + 1;
    // clear the column over the band's floor to the old top, then the floor, then the water or the grass
    await fillBox(L, [bx0, g(b.y), bz0, bx1, top, bz1], 'minecraft:air');
    if (g(b.y) - 1 >= W.ground + 1) await fillBox(L, [bx0, W.ground + 1, bz0, bx1, g(b.y) - 1, bz1], 'minecraft:dirt');
    if (b.water) {
      await fillBox(L, [bx0, g(b.y), bz0, bx1, g(b.y), bz1], 'minecraft:sand');
      await fillBox(L, [bx0, g(b.y) + 1, bz0, bx1, g(b.y + b.water), bz1], 'minecraft:water');
    } else await fillBox(L, [bx0, g(b.y), bz0, bx1, g(b.y), bz1], 'minecraft:grass_block');
  }
  await L.settle(3000);
  return W;
}

/** A fixture's plan and anchors in the world (Steward's anchors of the world claim, the fixture's own shifted). */
export async function worldPlan(ctx, fx, W) {
  const { stewardAnchors } = await import(pathToFileURL(path.join(ctx.KIT, 'test', 'plan-helpers.mjs')).href);
  const c = { minX: W.claim[0], minZ: W.claim[1], maxX: W.claim[2], maxZ: W.claim[3] };
  const anchors = { ...stewardAnchors(c) };
  for (const [k, a] of Object.entries(fx.anchors ?? {})) anchors[k] = [a[0] + W.dx, a[1] + W.off, a[2] + W.dz];
  return { plan: fx.plan, anchors, protected: (fx.protected ?? []).map((p) => ({ ...p, rect: [p.rect[0] + W.dx, p.rect[1] + W.dz, p.rect[2] + W.dx, p.rect[3] + W.dz] })) };
}

/** Every array `guards` in an object (the artifact's per-body guards), flattened. */
function guardsIn(o, out = []) {
  if (!o || typeof o !== 'object') return out;
  if (Array.isArray(o.guards)) out.push(...o.guards);
  for (const v of Object.values(o)) if (v && typeof v === 'object') guardsIn(v, out);
  return out;
}

/** A fixture by its path under kit/test/fixtures/plan. */
export function fixture(ctx, rel) {
  return JSON.parse(fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'plan', rel), 'utf8'));
}

/**
 * Item 9 for one fixture: fresh flat world, its terrain, Regions.checkPlan (load: generate), realiseApproved; READY, PLACED, every body
 * settled and its census equal to its prediction, guards flat; then (exact rules) Regions.remove and E-flat 0 over the snapshot box.
 * `o.after(r)`: more checks while it stands (villagers, a breach). Returns the evidence.
 */
export async function realiseFixture(ctx, tag, fx, o = {}) {
  const { L, check, json, core } = ctx;
  const out = { tag };
  await L.fresh(`G6B HYb ${tag}`, core.FLAT);
  await L.setRules(o.rules ?? 'exact');
  const T = terrainOf(fx);
  const W = await buildTerrain(ctx, T);
  const wp = await worldPlan(ctx, fx, W);
  const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: core.OWNER, anchors: wp.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(ctx.OUT, `hyb-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const parts = (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]);
  out.check = { overall: ck.check?.overall ?? null, parts, refused: ck.refused ?? null };
  const okParts = parts.every(([, k]) => k === 'fits' || k === 'adjusted');
  check(ck.check?.overall === 'READY' && okParts, `item 9 (${tag}): Regions.checkPlan's two-plan flow on the world: ${ck.check?.overall} ${json(parts)}`);
  if (ck.check?.overall !== 'READY') { await L.leaveWorld(); return out; }
  const sha = ck.check.artifactSha;
  const art = await L.call('dev.region.artifact', { sha, body: true }, 120_000).catch((e) => ({ error: String(e.message ?? e) }));
  const guards = guardsIn(art).filter((g) => g && g.fluids === true);
  out.guards = { n: guards.length, kinds: [...new Set(guards.map((g) => g.kind))] };
  check(guards.length > 0 && guards.every((g) => typeof g.part === 'string' && typeof g.body === 'string' && Array.isArray(g.runs) && g.runs.every((v) => typeof v === 'number')), `item 9 (${tag}): every body's guard is flat ({part, body, kind, fluids, volume, runs: numbers}, H RC3): ${guards.length} guard(s)`, guards.slice(0, 2));
  const box = [W.claim[0] - 8, W.minY - 6, W.claim[1] - 8, W.claim[2] + 8, W.maxY + 20, W.claim[3] + 8];
  const file = await core.snap(ctx, box, `hyb-${tag}`);
  const before = new Map((await L.call('dev.fluid.census', { box }, 900_000)).fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
  const r = await core.realiseApproved(ctx, sha);
  if (r.refused) { check(false, `item 9 (${tag}): realiseApproved refused (${json(r.refused)})`); await L.leaveWorld(); return out; }
  const fl = r.fluids;
  out.realise = { region: r.region, state: r.view.state, rows: fl.map((x) => [x.part, x.body, x.state, x.reason ?? null]) };
  check(r.view.state === 'PLACED' && fl.length === r.bodies.length && fl.every((x) => x.state === 'settled'), `item 9 (${tag}): realised from the approved artifact, PLACED with every body settled, one row per body (${r.view.state}; ${json(out.realise.rows)})`);
  const cs = {};
  for (const b of r.bodies) { const c = await core.censusOf(ctx, b, before, r.bodies); cs[b.id] = { ok: c.ok, sources: c.sources, flowing: c.flowing, mismatch: c.mismatch, outside: c.outside, ticks: c.ticks }; }
  out.census = cs;
  check(Object.values(cs).every((c) => c.ok), `item 9 (${tag}): every body's census equals its prediction (sources, lips, columns, films), 0 fluid outside its cells, spill and joins (${json(Object.entries(cs).map(([k, v]) => [k, v.sources, v.flowing, v.mismatch.length, v.outside.length]))})`, cs);
  if (o.after) out.after = await o.after(r, { W, box, before });
  const rm = await core.removeWait(ctx, r.region);
  await sleep(3000);
  const df = await core.diff(ctx, box, file);
  out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
  check(rm.state === 'REMOVED' && df.mismatches === 0, `item 9 (${tag}): Regions.remove (head first, a settle bound, the solids) restores the box exactly under the exact rules: E-flat ${df.mismatches} (${rm.seconds} s)`, df.sample);
  await L.leaveWorld();
  return out;
}

/** The fixtures item 9 realises in game (HY-c's water gate is its own item). */
export const ITEM9 = Object.freeze([
  ['v50', 'valid/v50_stream.json'],
]);

export const items = {
  ingame: [
    {
      name: 'item 9: every new kind through Regions.checkPlan and realiseApproved',
      async run(ctx) {
        const out = {};
        const only = (process.env.HYB_ONLY ?? '').split(',').filter(Boolean);
        for (const [tag, rel] of ITEM9) {
          if (only.length && !only.includes(tag)) continue;
          try { out[tag] = await realiseFixture(ctx, tag, fixture(ctx, rel)); } catch (e) { ctx.check(false, `item 9 (${tag}): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        }
        return out;
      },
    },
  ],
};

void k3;
