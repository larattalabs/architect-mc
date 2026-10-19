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
  const { L, check, json, core } = ctx;
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
  const box = [W.claim[0] - 8, Math.max(-64, W.minY - 8), W.claim[1] - 8, W.claim[2] + 8, Math.min(319, W.maxY + 20), W.claim[3] + 8];
  if (o.rules !== 'exact' && o.rules) { await L.cmd('/kill @e[type=!minecraft:player]'); }
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
  if (o.after) out.after = await o.after(r, { W, T, box, before, ck });
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
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, near: bad.slice(0, 12), sample: list.slice(0, 12) };
    check(rm.state === 'REMOVED' && (df.classes?.none ?? 0) === 0 && (df.classes?.gravity ?? 0) === 0 && bad.length === 0, `item 5 (${tag}): Regions.remove under the exact rules, E-normal: ${df.mismatches} mismatch(es) ${json(df.classes ?? {})}, 0 unclassified, 0 gravity, ${bad.length} within 6 of a body, shell, lining, weir, spill or watched cell (${rm.seconds} s)`, out.undo);
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
async function villagersNav(ctx, tag, r, W, T, ck) {
  const { check, json } = ctx;
  const wet = new Set(r.bodies.flatMap((b) => [...b.cells, ...b.spill]).map(k3));
  const out = {};
  // the bridges the plan's routes took over a course (the answer's legs)
  for (const a of ck.check.parts) for (const leg of a.geometry?.legs ?? []) for (const q of leg.bridges ?? []) {
    if (q.crossing?.over !== 'water') continue;
    const from = [q.from[0] - q.dir[0] * 2, q.from[1] + 1, q.from[2] - q.dir[1] * 2], to = [q.to[0] + q.dir[0] * 2, q.to[1] + 1, q.to[2] + q.dir[1] * 2];
    out[`bridge ${a.part} ${q.from.join(',')}`] = await navBoth(ctx, from, to, wet);
  }
  // round each terminal pool (the last reach of a course ending in one): a bank 4 west of it to one 4 east of it, at the ground
  const rows = (ck.check.parts ?? []).filter((a) => a.geometry?.ends?.some?.((e) => e.end === 'to' && e.kind === 'pool'));
  for (const a of rows) {
    const b = r.bodies.filter((q) => q.part === a.part).at(-1);
    if (!b) continue;
    const xs = b.cells.map((c) => c[0]), zs = b.cells.map((c) => c[2]);
    const zc = Math.round((Math.min(...zs) + Math.max(...zs)) / 2);
    const w = [Math.min(...xs) - 4, 0, zc], e = [Math.max(...xs) + 4, 0, zc];
    w[1] = groundAt(T, W, w[0], w[2]) + 1; e[1] = groundAt(T, W, e[0], e[2]) + 1;
    out[`pool ${b.id}`] = await navBoth(ctx, w, e, wet);
  }
  const all = Object.values(out);
  check(all.length > 0 && all.every((v) => v.there && v.back && !v.inWater.length), `item 10 (${tag}, the hard bar): vanilla dev.nav.villager both ways over every bridge on a course and round every terminal pool, no path cell in a fluid (${json(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v.there, v.back, v.inWater.length]])))})`, out);
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
  await L.settle(120_000);
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

/** The S3 claim (scenarios/s3_monastery.json, N-HY-1: a site only) and the frozen site (2026101102) of the gate. */
const S3_BASE = 'G6B Seed Base', FROZEN_SEED = '2026101102';

export const items = {
  natural: [
    {
      name: 'natural (S3): a spring falling by pools into the river, a weir head feeding a level canal: census, villagers, E-normal undo',
      async run(ctx) {
        const fx = fixture(ctx, 'hy/n01_s3_natural.json');
        const S3 = JSON.parse(fs.readFileSync(path.join(ctx.root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
        const out = {};
        // round 1 (default rules): the census and the villagers round the course's pools; round 2 (exact rules): E-normal
        try { out.live = await realiseFixture(ctx, 'natural', fx, { base: S3_BASE, site: S3, rules: 'default', noUndo: true, after: async (r, w) => villagersNav(ctx, 'natural', r, w.W, null, w.ck) }); } catch (e) { ctx.check(false, `natural: ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
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
            await sleep(120_000);
            await L.cmd('/gamerule random_tick_speed 0');
            const at1 = new Map((await L.call('dev.fluid.census', { box }, 600_000)).fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
            const froze = {};
            for (const [id, kind, c] of cells) { const k = k3(c); if (at0.get(k) !== 'minecraft:ice' && at1.get(k) === 'minecraft:ice') { const f = (froze[`${id.startsWith('twin') ? 'twin' : 'brook'} ${kind}`] ??= { n: 0 }); f.n++; } }
            check(true, `probe (a) on the course (recorded): after 2 minutes at random ticks 300, cells that froze: ${json(froze)} (the brook's caps hold; §1.7's reading: sources only)`);
            return { froze };
          } });
        } catch (e) { check(false, `cold: ${String(e.message ?? e).slice(0, 300)}`); try { await L.leaveWorld(); } catch { /* left */ } }
        try { out.exact = await realiseFixture(ctx, 'cold-exact', fx, { base, at: true, rules: 'exact', normal: true }); } catch (e) { check(false, `cold exact: ${String(e.message ?? e).slice(0, 300)}`); try { await L.leaveWorld(); } catch { /* left */ } }
        return out;
      },
    },
  ],
  ingame: [
    {
      name: 'item 10: villagers over the bridges and round the pools; the swept stand',
      async run(ctx) {
        const only = (process.env.HYB_ONLY ?? '').split(',').filter(Boolean);
        if (only.length && !only.includes('item10')) return { skipped: true };
        const out = {};
        for (const [tag, rel] of [['v57b', 'hy/v57b_course_bridged.json'], ['v50', 'valid/v50_stream.json']]) {
          try { out[tag] = await realiseFixture(ctx, `nav-${tag}`, fixture(ctx, rel), { rules: 'default', noUndo: true, after: async (r, w) => villagersNav(ctx, tag, r, w.W, w.T, w.ck) }); } catch (e) { ctx.check(false, `item 10 (${tag}): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        }
        try { out.swept = await realiseFixture(ctx, 'swept', fixture(ctx, 'valid/v60_falls_riffle.json'), { rules: 'default', noUndo: true, after: async (r) => sweptStand(ctx, r) }); } catch (e) { ctx.check(false, `item 10 (swept): ${String(e.message ?? e).slice(0, 300)}`); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
        return out;
      },
    },
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
