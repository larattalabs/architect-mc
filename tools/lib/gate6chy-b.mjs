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
import { flAsksFilter } from './fl-norm.mjs'; // (6c FL) FL's five free asks left to FL's own item 8
import * as P3 from './p3-tier.mjs';

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
export async function buildTerrain(ctx, T, at = null) {
  const L = ctx.L;
  // (`at`: the terrain stands where its own coordinates say, on a natural site: it is cleared over the claim first)
  const w0 = at ? { ...worldOf(T), claim: [T.x0, T.z0, T.x0 + T.W - 1, T.z0 + T.D - 1], dx: 0, dz: 0 } : worldOf(T);
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
  const W = at ? { ...worldOf(T, ground), claim: w0.claim, dx: 0, dz: 0 } : worldOf(T, ground);
  if (at) {
    // a natural site: everything over its lowest ground in the claim and 8 round it cleared to air first (trees, snow, hills), the floor filled
    const c = W.claim;
    await fillBox(L, [c[0] - 8, ground + 1, c[1] - 8, c[2] + 8, Math.min(319, ground + 60), c[3] + 8], 'minecraft:air');
    // (and the site's own top under it made ground: a frozen site's ice and the water under it are no ground to build on)
    await fillBox(L, [c[0] - 8, ground - 6, c[1] - 8, c[2] + 8, ground, c[3] + 8], 'minecraft:dirt');
  }
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
  const { L, json, core } = ctx;
  // (`quiet`: a recorded probe: its checks are logged as recorded, never failed)
  const check = o.quiet ? (ok, m, d) => ctx.check(true, `(recorded${ok ? '' : ', not as predicted'}) ${m}`, d) : ctx.check;
  const out = { tag };
  await L.fresh(`G6B HYb ${tag}`, o.base ?? core.FLAT);
  await L.setRules(o.rules ?? 'exact');
  await L.cmd('/weather clear');
  // the site: a terrain built over the flat base (or over a natural site's own ground, `o.at` its corner), or a natural claim as it is
  let T = null, W;
  if (o.site) {
    const c = o.site;
    await L.tp((c[0] + c[2]) / 2, 200, (c[1] + c[3]) / 2);
    await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
    W = { claim: c, dx: 0, dz: 0, off: 0 };
  } else {
    T = terrainOf(fx);
    W = await buildTerrain(ctx, T, o.at ?? null);
  }
  // the box's heights from the site's own survey (the floor under water, the highest ground)
  {
    const sv = path.join(ctx.OUT, `hyb-${tag}-survey.bin`);
    await L.call('dev.region.survey', { claim: W.claim, surveyLoad: 'bounded:256', file: sv }, 600_000);
    const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
    const S = surveyApi(fs.readFileSync(sv), { minX: W.claim[0], minZ: W.claim[1], maxX: W.claim[2], maxZ: W.claim[3], minY: -64, maxY: 319 });
    let y0 = 320, y1 = -64;
    for (let x = W.claim[0]; x <= W.claim[2]; x += 2) for (let z = W.claim[1]; z <= W.claim[3]; z += 2) { y0 = Math.min(y0, S.floorAt(x, z)); y1 = Math.max(y1, S.groundAt(x, z)); }
    W.minY = y0; W.maxY = y1; W.S = S;
  }
  const wp = await worldPlan(ctx, fx, W);
  const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: core.OWNER, anchors: wp.anchors, load: 'generate', ...(o.bible ? { bible: o.bible } : {}) }, 1_800_000);
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
  let box = [W.claim[0] - 8, Math.max(-64, W.minY - 8), W.claim[1] - 8, W.claim[2] + 8, Math.min(319, W.maxY + 20), W.claim[3] + 8];
  if (o.normal) {
    // (E-normal on a natural site: the box round the parts' own rects grown by 12, not the whole claim, whose far side lives its own life)
    const rs = (ck.check.parts ?? []).map((a) => a.geometry?.rect).filter(Array.isArray);
    if (rs.length) box = [Math.min(...rs.map((q) => q[0])) - 12, box[1], Math.min(...rs.map((q) => q[1])) - 12, Math.max(...rs.map((q) => q[2])) + 12, box[4], Math.max(...rs.map((q) => q[3])) + 12];
  }
  if (o.rules !== 'exact' && o.rules) { await L.cmd('/kill @e[type=!minecraft:player]'); }
  const file = await core.snap(ctx, box, `hyb-${tag}`);
  const before = new Map((await L.call('dev.fluid.census', { box }, 900_000)).fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
  // (development: HYB_BYPASS names fixtures realised with the containment check off, so a body that would drain stands for the census)
  const bypass = (process.env.HYB_BYPASS ?? '').split(',').includes(tag);
  if (bypass) await L.call('dev.fluid.bypass', { on: true }, 10_000);
  // (development: HYB_WATCH names fixtures whose spill cells are censused every 2 s while the realise runs, logged)
  let watched = null;
  if ((process.env.HYB_WATCH ?? '').split(',').includes(tag)) {
    const rr = await L.call('dev.region.realiseApproved', { sha }, 300_000);
    await sleep(3000);
    const g = await core.regionOf(ctx, rr.region).catch(() => null);
    const cells = (g?.bodies ?? []).flatMap((b) => b.predicted.map((q) => q.slice(0, 3)));
    if (cells.length) {
      const bx = core.boxAround(cells, 1);
      for (let i = 0; i < 25; i++) {
        const c = await L.call('dev.fluid.census', { box: bx }, 60_000);
        const st = await L.call('dev.fluid.state', { region: rr.region }, 10_000).catch(() => ({}));
        ctx.log(`  watch ${i}: ${json(c.fluids.filter(([x, y, z]) => cells.some((q) => Math.abs(q[0] - x) <= 1 && Math.abs(q[2] - z) <= 1 && Math.abs(q[1] - y) <= 1)))} ticks ${c.ticks.length} bodies ${json((st.bodies ?? []).map((b) => [b.id, b.state, b.writtenAt]))}`);
        await sleep(2000);
      }
    }
    await L.waitRegion(rr.region, 3_600_000);
    watched = await core.regionOf(ctx, rr.region);
  }
  const r = watched ?? await core.realiseApproved(ctx, sha);
  if (bypass) await L.call('dev.fluid.bypass', { on: false }, 10_000);
  if (r.refused) { check(false, `item 9 (${tag}): realiseApproved refused (${json(r.refused)})`); await L.leaveWorld(); return out; }
  const fl = r.fluids;
  out.realise = { region: r.region, state: r.view.state, rows: fl.map((x) => [x.part, x.body, x.state, x.reason ?? null]), at: fl.filter((x) => x.state !== 'settled').map((x) => ({ body: x.body, at: x.at, ...x })), fstate: r.fstate };
  // (a body drained in game: its prediction around the cells it names, for the record)
  for (const x of fl.filter((q) => q.state !== 'settled' && Array.isArray(q.at))) {
    const b = r.bodies.find((q) => q.id === x.body);
    const near = (c) => x.at.some((a) => Math.max(Math.abs(a[0] - c[0]), Math.abs(a[1] - c[1]), Math.abs(a[2] - c[2])) <= 2);
    ctx.log(`  ${x.body} drained (${x.reason}): at ${json(x.at)}; predicted near ${json((b?.predicted ?? []).filter(near))}; lining near ${json((b?.lining ?? []).filter(near))}`);
  }
  check(r.view.state === 'PLACED' && fl.length === r.bodies.length && fl.every((x) => x.state === 'settled'), `item 9 (${tag}): realised from the approved artifact, PLACED with every body settled, one row per body (${r.view.state}; ${json(out.realise.rows)})`);
  const cs = {};
  for (const b of r.bodies) { const c = await core.censusOf(ctx, b, before, r.bodies); cs[b.id] = { ok: c.ok, sources: c.sources, flowing: c.flowing, mismatch: c.mismatch, outside: c.outside, ticks: c.ticks }; }
  out.census = cs;
  for (const [k, v] of Object.entries(cs)) if (!v.ok) ctx.log(`  census ${k}: mismatch ${json(v.mismatch)} outside ${json(v.outside)}`);
  check(Object.values(cs).every((c) => c.ok), `item 9 (${tag}): every body's census equals its prediction (sources, lips, columns, films), 0 fluid outside its cells, spill and joins (${json(Object.entries(cs).map(([k, v]) => [k, v.sources, v.flowing, v.mismatch.length, v.outside.length]))})`, cs);
  if (o.after) out.after = await o.after(r, { W, T, box, before, ck: { ...ck, plan: [...(wp.plan.connectors ?? [])] }, anchors: wp.anchors });
  if (o.noUndo) { await core.removeWait(ctx, r.region).catch(() => null); await L.leaveWorld(); return out; }
  const rm = await core.removeWait(ctx, r.region);
  await sleep(3000);
  if (o.normal) {
    // E-normal (§4.4): 0 unclassified, no classified mismatch within 6 of any body, shell, lining, weir, spill or watched cell, 0 gravity
    const df = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file }, 4 * 3_600_000);
    const cells = r.bodies.flatMap((b) => [...b.cells, ...b.shell, ...b.lining, ...b.spill, ...b.watch]);
    const near = (x, y, z) => cells.some((q) => Math.max(Math.abs(q[0] - x), Math.abs(q[1] - y), Math.abs(q[2] - z)) <= 6);
    const list = df.list ?? [];
    const bad = list.filter((mm) => { const [x, y, z] = String(mm.pos).split(',').map(Number); return near(x, y, z); });
    // T1's flow class as H narrows it (§4.4): a fluid change more than 6 columns from every cell the course writes or watches (the site's
    // own springs running on in the loaded chunks): the world's, not the undo's
    const cols = cells.map((q) => [q[0], q[2]]);
    const farCol = (x, z) => cols.every(([cx, cz]) => Math.max(Math.abs(cx - x), Math.abs(cz - z)) > 6);
    const isFl = (v) => /^minecraft:(water|lava)/.test(String(v ?? ''));
    const classes = { ...(df.classes ?? {}) };
    let flow = 0;
    for (const mm of list) { if (mm.class !== 'none') continue; const [x, , z] = String(mm.pos).split(',').map(Number); if ((isFl(mm.was) || isFl(mm.now)) && farCol(x, z)) { mm.class = 'flow'; flow++; } }
    if (flow) { classes.none = (classes.none ?? 0) - flow; classes.flow = flow; }
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes, near: bad.slice(0, 12), sample: list.filter((mm) => mm.class === 'none').slice(0, 12) };
    check(rm.state === 'REMOVED' && (classes.none ?? 0) === 0 && (classes.gravity ?? 0) === 0 && bad.length === 0, `item 5 (${tag}): Regions.remove under the exact rules, E-normal: ${df.mismatches} mismatch(es) ${json(classes)}, ${classes.none ?? 0} unclassified, ${classes.gravity ?? 0} gravity, ${bad.length} within 6 of a body, shell, lining, weir, spill or watched cell (${rm.seconds} s)`, out.undo);
  } else {
    const df = await core.diff(ctx, box, file);
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
    check(rm.state === 'REMOVED' && df.mismatches === 0, `item 9 (${tag}): Regions.remove (head first, a settle bound, the solids) restores the box exactly under the exact rules: E-flat ${df.mismatches} (${rm.seconds} s)`, df.sample);
  }
  await L.leaveWorld();
  return out;
}

/** The fixtures item 9 realises in game (HY-c's water gate is its own item): every HY kind (§14 item 9's list). */
export const ITEM9 = Object.freeze([
  ['v50', 'valid/v50_stream.json'], // a spring stream to a terminal pool (pools and falls)
  ['v51', 'valid/v51_canal.json'], // a level canal (built)
  ['v52', 'valid/v52_weir_head.json'], // a weir head (the asks lake)
  ['v53', 'valid/v53_fall_join.json'], // a fall join into a lake
  ['v54', 'valid/v54_race.json'], // a race (a wheel fall by its mill lot)
  ['v55', 'valid/v55_ditch.json'], // a ditch fed by a course
  ['v56', 'valid/v56_fountain_fed.json'], // a fountain fed by a course, a pond overflowing into a course
  ['v57', 'hy/v57_moat_fed.json'], // a moat fed by a course (its road bridged over the moat)
  ['v57b', 'hy/v57b_course_bridged.json'], // a stream crossed by a bridged road
  ['v59', 'valid/v59_riffles.json'], // a riffle
  ['steward', 'hy/s01_steward_farm.json'], // a Steward-shaped plan: a farm zone, a race to its mill lot, ditches along its farm
]);

/** (P3 smoke) item 9's slice-tier remainder: one fixture per course writer kind (docs/FAST-CHECKS.md hy-ingame #16). */
export const SMOKE9 = Object.freeze(['v50', 'v51', 'v54', 'v55', 'v56']);

/** A kit terrain's ground at a world column (flatSurvey's bands, later bands win), in world y. */
function groundAt(T, W, x, z) {
  if (W.S) return W.S.groundAt(x, z);
  const kx = x - W.dx, kz = z - W.dz;
  let g = T.y;
  for (const b of T.bands) if (kx >= b.x0 && kx <= b.x1 && kz >= b.z0 && kz <= b.z1) g = b.water ? b.y + b.water : b.y;
  return g + W.off;
}

/** Vanilla's villager both ways between two feet cells; with `cells`, every path cell (none may be in a fluid of `wet`). */
async function navBoth(ctx, a, b, wet = null) {
  const ab = await ctx.L.call('dev.nav.villager', { from: a, to: b, range: 256, cells: true }, 120_000);
  const ba = await ctx.L.call('dev.nav.villager', { from: b, to: a, range: 256, cells: true }, 120_000);
  const inWater = wet ? [...(ab.cells ?? []), ...(ba.cells ?? [])].filter((c) => wet.has(k3(c))) : [];
  return { there: !!ab.canReach, back: !!ba.canReach, inWater: inWater.slice(0, 4), n: (ab.cells ?? []).length };
}

/** Item 10 on a realised fixture: over every bridge on a course and round every terminal pool, both ways; no path cell in a fluid. */
async function villagersNav(ctx, tag, r, W, T, ck, anchors = null) {
  const { check, json } = ctx;
  const wet = new Set(r.bodies.flatMap((b) => [...b.cells, ...b.spill]).map(k3));
  const out = {};
  // the bridges the plan's routes took over a course (the answer's legs)
  for (const a of ck.check.parts) for (const q of [...(a.geometry?.bridges ?? []), ...(a.geometry?.legs ?? []).flatMap((l) => l.bridges ?? [])]) {
    if (q.crossing?.over !== 'water') continue;
    const from = [q.from[0] - q.dir[0] * 2, q.from[1] + 1, q.from[2] - q.dir[1] * 2], to = [q.to[0] + q.dir[0] * 2, q.to[1] + 1, q.to[2] + q.dir[1] * 2];
    out[`bridge ${a.part} ${q.from.join(',')}`] = await navBoth(ctx, from, to, wet);
  }
  // round each terminal pool (a course whose `to` is a dry anchor): from a bank 5 to one side of the pool to one 5 to the other, across
  // the course's arrival, so the walk goes round the pool's far end
  for (const a of ck.check.parts) {
    const part = (ck.plan ?? []).find?.((q) => q.id === a.part);
    const anchor = part?.to?.anchor !== undefined ? anchors?.[part.to.anchor] : null;
    if (!anchor || !a.geometry?.ends?.some?.((e) => e.end === 'to' && e.kind === 'pool')) continue;
    // the pool: the reach holding the surface cell nearest the anchor (the IR lists a course's reaches downstream first)
    const dist = (c) => Math.abs(c[0] - anchor[0]) + Math.abs(c[2] - anchor[2]);
    const b = r.bodies.filter((q) => q.part === a.part).reduce((m, q) => { const d = Math.min(...q.cells.map(dist)); return !m || d < m.d ? { q, d } : m; }, null)?.q;
    if (!b) continue;
    // the pool's centre: the reach's surface cell nearest the anchor; the arrival: where its other cells lie
    const surf = b.cells.filter((c) => c[1] === b.level);
    const c0 = surf.reduce((m, c) => (!m || Math.abs(c[0] - anchor[0]) + Math.abs(c[2] - anchor[2]) < Math.abs(m[0] - anchor[0]) + Math.abs(m[2] - anchor[2]) ? c : m), null);
    const far = surf.filter((c) => Math.max(Math.abs(c[0] - c0[0]), Math.abs(c[2] - c0[2])) > 3);
    const ax = far.length ? Math.abs(far.reduce((t, c) => t + c[0] - c0[0], 0)) >= Math.abs(far.reduce((t, c) => t + c[2] - c0[2], 0)) : true;
    const p1 = ax ? [c0[0], 0, c0[2] - 5] : [c0[0] - 5, 0, c0[2]], p2 = ax ? [c0[0], 0, c0[2] + 5] : [c0[0] + 5, 0, c0[2]];
    p1[1] = groundAt(T, W, p1[0], p1[2]) + 1; p2[1] = groundAt(T, W, p2[0], p2[2]) + 1;
    out[`pool ${b.id}`] = await navBoth(ctx, p1, p2, wet);
  }
  const all = Object.values(out);
  check(all.every((v) => v.there && v.back && !v.inWater.length), `item 10 (${tag}, the hard bar): vanilla dev.nav.villager both ways over every bridge on a course and round every terminal pool, no path cell in a fluid (${all.length} walk(s): ${json(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v.there, v.back, v.inWater.length]])))})`, out);
  return out;
}

/** Item 10's swept stand: 4 villagers dropped into the spring head (above two falls and a riffle), 4 by each reach, 2 minutes at default rules. */
async function sweptStand(ctx, r) {
  const { L, check, json } = ctx;
  await L.setRules('default');
  await L.cmd('/gamerule spawn_monsters false');
  await L.cmd('/kill @e[type=!minecraft:player]');
  const since = Date.now();
  const head = r.bodies[0];
  const surf = (b) => b.cells.filter((c) => c[1] === b.level);
  const placed = [];
  for (const c of surf(head).slice(0, 4)) { await L.cmd(`/summon minecraft:villager ${c[0] + 0.5} ${c[1] + 1} ${c[2] + 0.5} {Tags:["hyb_stand"],PersistenceRequired:1b}`); placed.push({ swim: true, at: c }); }
  const { shellOf } = await ctx.imp('lib/fluids/body.mjs');
  for (const b of r.bodies) {
    const sh = new Set(b.shell.map(k3));
    const rim = shellOf(b.cells).filter((c) => c[1] === b.level + 1 && sh.has(k3(c)));
    const step = Math.max(1, Math.floor(rim.length / 4));
    for (const c of rim.filter((_, i) => i % step === 0).slice(0, 4)) { await L.cmd(`/summon minecraft:villager ${c[0] + 0.5} ${c[1] + 1} ${c[2] + 0.5} {Tags:["hyb_stand"],PersistenceRequired:1b}`); placed.push({ swim: false, at: c }); }
  }
  await L.gameWait(120_000, { label: 'hy-b villager stand, 2 minutes' });
  const drown = await L.call('dev.entity.damage', { since, type: 'drown' }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const fall = await L.call('dev.entity.damage', { since, type: 'fall' }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const alive = await L.cmd('/execute if entity @e[type=minecraft:villager,tag=hyb_stand]');
  const n = Number((/(\d+)/.exec(String(alive.messages?.join(' ') ?? '')) ?? [0, 0])[1]);
  // a path from the surface of every reach (where a swept swimmer ends up) to an exit of it (its rim notches)
  const swims = {};
  for (const b of r.bodies) {
    const sh = new Set(b.shell.map(k3));
    const s0 = surf(b);
    const p = s0[s0.length >> 1];
    const exits = shellOf(b.cells).filter((c) => c[1] === b.level + 1 && !sh.has(k3(c))).sort((a, c) => (Math.abs(a[0] - p[0]) + Math.abs(a[2] - p[2])) - (Math.abs(c[0] - p[0]) + Math.abs(c[2] - p[2])));
    let ok = false;
    for (const e of exits.slice(0, 4)) if ((await L.call('dev.nav.villager', { from: p, to: e, range: 64 }, 120_000)).canReach === true) { ok = true; break; }
    swims[b.id] = exits.length ? ok : 'no exit';
  }
  const out = { placed: placed.length, alive: n, drown: drown.damage ?? drown.events?.length ?? null, fall: fall.damage ?? fall.events?.length ?? null, deaths: drown.deaths ?? null, swims };
  const deaths = Array.isArray(out.deaths) ? out.deaths.length : out.deaths;
  check(!drown.error && !fall.error && out.drown === 0 && out.fall === 0 && !deaths && n === placed.length && Object.values(swims).every((v) => v === true), `item 10 (the swept stand): ${placed.length} villagers (4 dropped into the spring head above two falls and a riffle, 4 by each reach), 2 minutes at default rules: drowning ${out.drown}, fall damage ${out.fall}, deaths ${deaths ?? 0}, ${n} alive; a nav path from each reach's surface to an exit (${json(swims)})`, out);
  await L.cmd('/kill @e[type=minecraft:villager,tag=hyb_stand]');
  await L.setRules('exact');
  return out;
}

/**
 * Item 11 (§13): the 59 asks through the two-plan flow on the asks claim with the kit at `kitDir`: the gap table text (the classes, the
 * unsupported blocks, every part's class), the malformed count and the answers naming until HY.
 */
export async function asksGap(kitDir) {
  const H = await import(pathToFileURL(path.join(kitDir, 'test', 'plan-helpers.mjs')).href);
  const dir = path.join(kitDir, 'test', 'fixtures', 'plan', 'asks');
  const s = H.asksSurvey();
  const tally = {}, gaps = {}, classes = [];
  let malformed = 0, untilHY = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    const plan = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).answer.plan;
    const r = await H.checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: H.stewardAnchors(s.claim), volume: {} });
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'malformed') malformed++;
      if (/"until":"HY[a-z]*"/i.test(JSON.stringify(a))) untilHY++;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      classes.push(`${f.replace('.json', '')}/${a.part} ${a.block} ${a.class}${a.reasons?.[0]?.code ? ` ${a.reasons[0].code}` : ''}${a.reasons?.[0]?.until ? ` until ${a.reasons[0].until}` : ''}`);
    }
  }
  const rows = Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const text = `${[`# 59 asks: ${Object.entries(tally).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`, '# gap table (unsupported parts per block id):', ...rows.map(([k, v]) => `  ${k.padEnd(24)} ${v}`), '# every part:', ...classes].join('\n')}\n`;
  return { text, malformed, untilHY, course: gaps['channel.course'] ?? 0 };
}

/** The S3 claim (scenarios/s3_monastery.json, N-HY-1: a site only) and the frozen site (2026101102) of the gate. */
const S3_BASE = 'G6B Seed Base', FROZEN_SEED = '2026101102';

/** The look's bibles (H-a's three): the default, infernal, coastal. */
const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
/** The look's fixtures: every kind in the default bible; the stream and the canal in the other two (their materials are the bible's). */
const LOOK = Object.freeze([
  ['stream', 'valid/v60_falls_riffle.json', true], ['canal', 'valid/v51_canal.json', true], ['weir', 'valid/v52_weir_head.json', false],
  ['race', 'valid/v54_race.json', false], ['ditch', 'valid/v55_ditch.json', false], ['fountain', 'valid/v56_fountain_fed.json', false],
]);

/** Item 20 (the look, client, recorded): camera shots of each course: an overview, each step (falls, riffles), its weir, its ends. */
async function lookShots(ctx, tag, r) {
  const { L, OUT, log } = ctx;
  const dir = path.join(OUT, 'hyb-look');
  fs.mkdirSync(dir, { recursive: true });
  await L.cmd('/time set 6000');
  const shots = [];
  const shot = async (name, eye, at, what) => {
    await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
    await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
    await L.settle(2000);
    const q = await L.call('dev.screenshot', { name: `hyb_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
    const file = path.join(dir, `${name}.png`);
    fs.copyFileSync(q.path, file);
    log(`  shot ${name}`);
    shots.push({ name, what, eye, at, file: path.relative(OUT, file) });
  };
  const box = (cells) => { const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]), zs = cells.map((c) => c[2]); return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0: Math.min(...zs), z1: Math.max(...zs) }; };
  // per part: an overview over its middle (a long course: its first 80 cells), then each step and its weir, from close by
  const parts = [...new Set(r.bodies.map((b) => b.part))];
  for (const part of parts) {
    const bs = r.bodies.filter((b) => b.part === part);
    const B = box(bs.flatMap((b) => [...b.cells, ...b.shell]));
    const at = [(B.x0 + B.x1) / 2, B.y1, (B.z0 + B.z1) / 2];
    const span = Math.min(70, Math.max(B.x1 - B.x0, B.z1 - B.z0, 12));
    await shot(`${tag}_${part}`, [at[0] + span * 0.45, B.y1 + span * 0.4, at[2] + span * 0.45], at, `${part}: the whole`);
    // each step (a body's spill: a lip, a fall's column, a riffle), from downstream, looking back up at it
    let k = 0;
    for (const b of bs) {
      if (!b.spill.length || k >= 3) continue;
      const S = box(b.spill);
      const top = b.spill.filter((c) => c[1] === S.y1), low = b.spill.filter((c) => c[1] === S.y0);
      const mean = (a, i) => a.reduce((t, c) => t + c[i], 0) / a.length;
      let dx = mean(low, 0) - mean(top, 0), dz = mean(low, 2) - mean(top, 2);
      if (Math.abs(dx) + Math.abs(dz) < 0.5) { dx = (S.x1 - S.x0) >= (S.z1 - S.z0) ? 1 : 0; dz = dx ? 0 : 1; }
      const n = Math.hypot(dx, dz) || 1;
      dx /= n; dz /= n;
      const sa = [mean(b.spill, 0) + 0.5, (S.y0 + S.y1) / 2, mean(b.spill, 2) + 0.5];
      await shot(`${tag}_${part}_step${++k}`, [sa[0] + dx * 9 - dz * 4, S.y1 + 4, sa[2] + dz * 9 + dx * 4], sa, `${part}: ${b.id}'s step (its lip, fall or riffle), from downstream`);
    }
    // a weir (a lining course facing natural water, on a body with no spill of its own)
    const weirB = bs.find((b) => b.lining.length && !b.spill.length && b.joins.length === 0);
    if (weirB) { const Wb = box(weirB.lining); const wa = [(Wb.x0 + Wb.x1) / 2 + 0.5, Wb.y1, (Wb.z0 + Wb.z1) / 2 + 0.5]; await shot(`${tag}_${part}_weir`, [wa[0] - 7, Wb.y1 + 5, wa[2] + 7], wa, `${part}: the weir head`); }
  }
  return shots;
}

export const items = {
  look: [
    {
      name: 'item 20: the look (client, recorded): a stream, a canal, falls, a riffle, a weir head, a race and its wheel fall, a ditch by a farm, a fountain fed by a course, in three bibles',
      async run(ctx) {
        const { L } = ctx;
        for (const id of LOOK_BIBLES) if (id) {
          const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
          fs.mkdirSync(dst, { recursive: true });
          fs.copyFileSync(path.join(ctx.root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
        }
        const all = [];
        for (const bible of LOOK_BIBLES) for (const [name, rel, every] of LOOK) {
          if (bible && !every) continue;
          const tag = `${bible ? bible.replace(/^g7ak1_/, '') : 'default'}_${name}`;
          try {
            const res = await realiseFixture(ctx, `look-${tag}`, fixture(ctx, rel), { rules: 'exact', bible, noUndo: true, after: async (r) => lookShots(ctx, tag, r) });
            for (const q of res.after ?? []) all.push({ bible: bible ?? 'default', kind: name, ...q });
          } catch (e) { ctx.log(`  look ${tag}: ${String(e.message ?? e).slice(0, 200)}`); try { await L.leaveWorld(); } catch { /* left */ } }
          await L.call('dev.release', {}).catch(() => null);
        }
        fs.writeFileSync(path.join(ctx.OUT, 'hyb-look', 'look.json'), `${JSON.stringify(all, null, 2)}\n`);
        ctx.check(all.length >= 20, `item 20 (the look, recorded not judged): ${all.length} camera shot(s) in ${LOOK_BIBLES.length} bibles (${path.join(ctx.OUT, 'hyb-look')})`);
        return { shots: all.length };
      },
    },
  ],
  unit: [
    {
      name: 'item 11: the 59 recorded asks (§13): as on v0.37.0, 0 malformed, no until HY, channel.course 0',
      async run(ctx) {
        const after = await asksGap(ctx.KIT);
        const F = path.join(ctx.KIT, 'test', 'fixtures', 'plan', 'hy');
        const before = fs.readFileSync(path.join(F, 'asks-gap-before.txt'), 'utf8'), committed = fs.readFileSync(path.join(F, 'asks-gap-after.txt'), 'utf8');
        fs.writeFileSync(path.join(ctx.OUT, 'hyb-asks-gap.txt'), after.text);
        // ((6c VOC-c) rule.palette is supported: its 7 parts' lines and the tally they move are VOC-c's (its item 3, fixtures/plan/vocc/
        // asks-before.txt and asks-after.txt); every other line is HY's as committed)
        // ((6c FL) and FL's five free asks and the gap table's free-layout rows: tools/lib/fl-norm.mjs flAsksFilter)
        const vocc = (t) => flAsksFilter(t.split('\n').filter((l) => !/rule\.palette/.test(l) && !/^# 59 asks:/.test(l)).join('\n'));
        const lines = (t) => new Map(flAsksFilter(t).split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('  ') && l.includes('/') && !/rule\.palette/.test(l)).map((l) => [l.split(' ')[0], l]));
        const lb = lines(before), la = lines(after.text);
        const moved = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k);
        ctx.check(vocc(after.text) === vocc(committed) && after.malformed === 0 && after.untilHY === 0 && after.course === 0 && moved.length === 0, `item 11: the 59 asks' gap table equals fixtures/plan/hy/asks-gap-after.txt and the before table (v0.37.0's): ${after.malformed} malformed, ${after.untilHY} answers naming until HY, channel.course ${after.course}, ${moved.length} part(s) moved class${moved.length ? ` (${moved.join(', ')})` : ''}`);
        return { moved, malformed: after.malformed, untilHY: after.untilHY };
      },
    },
  ],
  natural: [
    {
      name: 'natural (S3): a spring falling by pools into the river, a weir head feeding a level canal: census, villagers, E-normal undo',
      async run(ctx) {
        const fx = fixture(ctx, 'hy/n01_s3_natural.json');
        const S3 = JSON.parse(fs.readFileSync(path.join(ctx.root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
        const out = {};
        // round 1 (default rules): the census and the villagers round the course's pools; round 2 (exact rules): E-normal
        try { out.live = await realiseFixture(ctx, 'natural', fx, { base: S3_BASE, site: S3, rules: 'default', noUndo: true, after: async (r, w) => villagersNav(ctx, 'natural', r, w.W, null, w.ck, w.anchors) }); } catch (e) { ctx.check(false, `natural: ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        try { out.exact = await realiseFixture(ctx, 'natural-exact', fx, { base: S3_BASE, site: S3, rules: 'exact', normal: true }); } catch (e) { ctx.check(false, `natural exact: ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        return out;
      },
    },
  ],
  cold: [
    {
      name: 'cold (2026101102): a capped brook with a submerged outlet and a fall, its unlit uncapped twin (recorded); census; E-normal undo',
      async run(ctx) {
        const { L, check, json } = ctx;
        const fx = fixture(ctx, 'hy/c01_cold.json');
        const base = await L.seedBase(FROZEN_SEED);
        const out = {};
        try {
          out.live = await realiseFixture(ctx, 'cold', fx, { base, at: true, rules: 'exact', noUndo: true, after: async (r) => {
            // the probe, recorded (§1.7, probe (a)): 2 minutes at random ticks 300; which cells froze, on the capped brook and the twin
            const cells = r.bodies.flatMap((b) => [...b.cells.map((c) => [b.id, 'source', c]), ...b.predicted.map((q) => [b.id, q[3] >= 8 ? 'falling' : 'flowing', q.slice(0, 3)])]);
            const box = ctx.core.boxAround(r.bodies.flatMap((b) => [...b.cells, ...b.spill]), 1);
            const at0 = new Map((await L.call('dev.fluid.census', { box }, 600_000)).fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
            await L.cmd('/gamerule random_tick_speed 300');
            await L.gameWait(120_000, { real: sleep, label: 'hy-b cold probe, 2 minutes' });
            await L.cmd('/gamerule random_tick_speed 0');
            const at1 = new Map((await L.call('dev.fluid.census', { box }, 600_000)).fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
            const froze = {};
            for (const [id, kind, c] of cells) { const k = k3(c); if (at0.get(k) !== 'minecraft:ice' && at1.get(k) === 'minecraft:ice') { const f = (froze[`${id.startsWith('twin') ? 'twin' : 'brook'} ${kind}`] ??= { n: 0 }); f.n++; } }
            check(true, `probe (a) on the course (recorded): after 2 minutes at random ticks 300, cells that froze: ${json(froze)} (the brook's caps hold; §1.7's reading: sources only)`);
            return { froze };
          } });
        } catch (e) { check(false, `cold: ${String(e.message ?? e).slice(0, 300)}`); try { await L.leaveWorld(); } catch { /* left */ } }
        if (P3.smoke) P3.skipped(ctx.log, 'cold-exact (the capped brook again, E-normal)', 'the frozen-river write and the cold census above; its exactness at release');
        else try { out.exact = await realiseFixture(ctx, 'cold-exact', fx, { base, at: true, rules: 'exact', normal: true }); } catch (e) { check(false, `cold exact: ${String(e.message ?? e).slice(0, 300)}`); try { await L.leaveWorld(); } catch { /* left */ } }
        return out;
      },
    },
  ],
  ingame: [
    {
      key: 'probe',
      name: 'item 18 (c), recorded: the census against the prediction on riffles of 2, 4 and 6 per drop and 1 to 3 drops, and one long run past the cap',
      async run(ctx) {
        const only = (process.env.HYB_ONLY ?? '').split(',').filter(Boolean);
        if (only.length && !only.includes('probe')) return { skipped: true };
        // (P3: the riffle table is the release tier's calibration probe, p3-probe-water; offline the water lint's W2 holds every course)
        if (P3.smoke) { P3.skipped(ctx.log, 'item 18 (c): the riffle table p01/p01b/p02', 'p3-probe-water at release; the water lint W2 (census == prediction over the corpus, p01/p01b/p02 included)'); return { skipped: 'P3 smoke' }; }
        const out = {};
        for (const [tag, rel] of [['p01', 'hy/p01_riffle_probe.json'], ['p01b', 'hy/p01b_riffle_probe.json'], ['p02', 'hy/p02_long_riffle.json']]) {
          try {
            const res = await realiseFixture(ctx, `probe-${tag}`, fixture(ctx, rel), { rules: 'exact', noUndo: true, quiet: true });
            out[tag] = Object.fromEntries(Object.entries(res.census ?? {}).map(([k, v]) => [k, { ok: v.ok, flowing: v.flowing, mismatch: v.mismatch.length, outside: v.outside.length }]));
          } catch (e) { out[tag] = { error: String(e.message ?? e).slice(0, 300) }; try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        }
        ctx.check(true, `item 18 (c) (recorded): the census on riffles, per body: ${ctx.json(out)}`);
        return out;
      },
    },
    {
      key: 'item10',
      name: 'item 10: villagers over the bridges and round the pools; the swept stand',
      async run(ctx) {
        const only = (process.env.HYB_ONLY ?? '').split(',').filter(Boolean);
        if (only.length && !only.includes('item10')) return { skipped: true };
        const out = {};
        for (const [tag, rel] of [['v57b', 'hy/v57b_course_bridged.json'], ['v50', 'valid/v50_stream.json']]) {
          try { out[tag] = await realiseFixture(ctx, `nav-${tag}`, fixture(ctx, rel), { rules: 'default', noUndo: true, after: async (r, w) => villagersNav(ctx, tag, r, w.W, w.T, w.ck, w.anchors) }); } catch (e) { ctx.check(false, `item 10 (${tag}): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        }
        try { out.swept = await realiseFixture(ctx, 'swept', fixture(ctx, 'valid/v60_falls_riffle.json'), { rules: 'default', noUndo: true, after: async (r) => sweptStand(ctx, r) }); } catch (e) { ctx.check(false, `item 10 (swept): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        return out;
      },
    },
    {
      key: 'item9',
      name: 'item 9: every new kind through Regions.checkPlan and realiseApproved',
      async run(ctx) {
        const out = {};
        const only = (process.env.HYB_ONLY ?? '').split(',').filter(Boolean);
        // (P3 smoke: one per course writer kind: stream, canal, race, ditch, fountain-fed; all of them at release; every kind's census,
        // containment and breach sweep are the water lint's, offline)
        if (P3.smoke) P3.skipped(ctx.log, `item 9: ${ITEM9.map(([t]) => t).filter((t) => !SMOKE9.includes(t)).join(', ')}`, 'the water lint (W1-W3 over every kind)');
        for (const [tag, rel] of ITEM9) {
          if (only.length && !only.includes(tag)) continue;
          if (P3.smoke && !SMOKE9.includes(tag)) continue;
          try { out[tag] = await realiseFixture(ctx, tag, fixture(ctx, rel)); } catch (e) { ctx.check(false, `item 9 (${tag}): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        }
        return out;
      },
    },
  ],
};

void k3;
