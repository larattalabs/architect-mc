// (6c IRR) The in-game items of slice IRR (docs/CONTRACT.md "Phase 6c slice IRR" §10, Steward's review S-IRR-1..5), headless, $0. Every
// realise goes through Regions.checkPlan (the two-plan flow, the per-body guards) and realiseApproved with the approval artifact and a
// bound field entry (the farm-pond lesson: typed farm lots with no villager member, district lots, nested guard runs, realised in game).
// ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp, json, root, check, log, core (gate6chy-core.mjs), B (gate6chy-b.mjs)}.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const runsCells = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };

/** The gate's field entry, as installed into the run's library: {id: {width, depth}}; v2 swaps the crop (the versionOf stand-in). */
export const FIELDS = Object.freeze({
  g6c_irr_field: { width: 13, depth: 14 }, // irr/s01 (Steward's hamlet: bound in its plan)
  g6c_irr_field_13x11: { width: 13, depth: 11 },
  g6c_irr_field_11x11: { width: 11, depth: 11 },
  g6c_irr_field_40x40: { width: 40, depth: 40 },
});

/** Build the field design at a size (kit/test/fixtures/designs/g6c_irr_field.mjs) into `out` as entry `id`: {dir, bp}. */
export async function buildField(ctx, id, { width, depth }, crop = 'wheat', out) {
  const { buildDesign } = await import(pathToFileURL(path.join(ctx.KIT, 'build.mjs')).href);
  const tmp = `${out}-tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = await buildDesign('g6c_irr_field', { out: tmp, dir: path.join(ctx.KIT, 'test', 'fixtures', 'designs'), values: { width, depth, crop } });
  if (!r.result.ok) throw new Error(`the field design ${width}x${depth} did not pass its check: ${r.result.errors.join('; ')}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(tmp)) {
    if (!f.startsWith('g6c_irr_field.')) continue;
    const target = path.join(out, id + f.slice('g6c_irr_field'.length));
    if (f.endsWith('.blueprint.json')) {
      const j = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
      Object.assign(j, { id, name: id, source: `${id}.mjs` });
      fs.writeFileSync(target, JSON.stringify(j, null, 2));
    } else fs.copyFileSync(path.join(tmp, f), target);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { dir: out, bp: r.bp };
}

/** Install every field entry into the run's library (v1 wheat, v2 carrots): {id: {bp, v2: version}}. */
export async function installFields(ctx) {
  const { L } = ctx;
  const out = {};
  for (const [id, size] of Object.entries(FIELDS)) {
    const v1 = await buildField(ctx, id, size, 'wheat', path.join(ctx.OUT, 'fields', id, 'v1'));
    const v2 = await buildField(ctx, id, size, 'carrots', path.join(ctx.OUT, 'fields', id, 'v2'));
    const lib = path.join(L.LIBRARY, id);
    fs.rmSync(lib, { recursive: true, force: true });
    fs.mkdirSync(lib, { recursive: true });
    for (const f of fs.readdirSync(v1.dir)) fs.copyFileSync(path.join(v1.dir, f), path.join(lib, f));
    out[id] = { bp: v1.bp, bp2: v2.bp, v2dir: v2.dir };
  }
  return out;
}

/** After a world is open: the library reloaded (the entries are v1, wheat: installFields writes them fresh each step). */
export async function loadFields(ctx, F) {
  void F;
  await ctx.L.cmd('/architect reload');
  await ctx.L.settle(2000);
}

/** An entry's v2 (carrots, the versionOf stand-in) installed now, once: the library is the game's, so later realises place v2. */
export async function installV2(ctx, F, id) {
  const r = await ctx.L.call('dev.entry.installVersion', { entry: id, dir: F[id].v2dir, summary: 'v2: carrots (the versionOf stand-in)' }, 60_000);
  F[id].v2 = r.version;
  return r.version;
}

/**
 * The entry's non-air template cells that fall on a lot's irrigation cells, fitted as the realise fits it (the kit's own placement,
 * kit/lib/reserved.mjs, over the artifact lot's frame and lotCells): what the realise must report as irrigationDropped.
 */
export async function expectedDropped(ctx, bp, artLot) {
  const { templateToFrame } = await ctx.imp('lib/reserved.mjs');
  // (lotCells: runs [u, v, y0, y1] in the lot's frame; runsCells gives [u, y, v])
  const want = new Set(runsCells(artLot.irrigation.lotCells).map(([u, y, v]) => `${u},${y},${v}`));
  const t = { size: [bp.size.x, bp.size.y, bp.size.z], groundY: bp.groundY, front: bp.front };
  const r = { front: artLot.front, size: artLot.irrigation.frame };
  let n = 0;
  for (const [k, c] of bp.cells) {
    if (/(^|:)(air|cave_air|void_air|structure_void)$/.test(c.state.name)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (want.has(templateToFrame(x, y, z, t, r).join(','))) n++;
  }
  return n;
}

/** The block at a cell (its state as /data or the census sees it): via a one-cell hash snapshot is heavy, so /execute if block. */
export async function isBlock(ctx, [x, y, z], block) {
  const r = await ctx.L.cmd(`/execute if block ${x} ${y} ${z} ${block}`);
  return !!(r?.success || Number(r?.result) > 0);
}

/** Count the cells holding `block` among `cells`. */
async function countBlock(ctx, cells, block) {
  let n = 0;
  for (const c of cells) if (await isBlock(ctx, c, block)) n++;
  return n;
}

/** The artifact's lots (dev.region.artifact {sha, body: true}). */
export async function artifactLots(ctx, sha) {
  const a = await ctx.L.call('dev.region.artifact', { sha, body: true }, 120_000);
  const find = (o) => (o && typeof o === 'object' ? (Array.isArray(o.lots) && o.lots.some((l) => l && l.fitBox !== undefined || l?.irrigation) ? o.lots : Object.values(o).map(find).find(Boolean)) : null);
  return { art: a, lots: find(a) ?? [] };
}

/**
 * One fixture through the whole round: a fresh flat world, its terrain, checkPlan (generate), the artifact, realiseApproved with
 * `entries`, the region waited for. Returns {W, T, box, file, before, ck, sha, lots (artifact), r (core.regionOf), parts}.
 */
export async function realiseIrr(ctx, tag, fx, { entries = {}, rules = 'exact', snapshot = true, fields = null, noRealise = false, lotSnap = null } = {}) {
  const { L, core, B, json } = ctx;
  await L.fresh(`G6B IRR ${tag}`, core.FLAT);
  if (fields) await loadFields(ctx, fields);
  await L.setRules(rules);
  await L.cmd('/weather clear');
  const T = B.terrainOf(fx);
  const W = await B.buildTerrain(ctx, T);
  W.minY = W.ground; W.maxY = W.ground + 8;
  const wp = await B.worldPlan(ctx, fx, W);
  const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: core.OWNER, anchors: wp.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(ctx.OUT, `irr-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const parts = (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]);
  const out = { W, T, ck, parts, overall: ck.check?.overall ?? null };
  if (ck.check?.overall !== 'READY') return out;
  out.sha = ck.check.artifactSha;
  out.lots = (await artifactLots(ctx, out.sha)).lots;
  out.box = [W.claim[0] - 8, W.ground - 8, W.claim[1] - 8, W.claim[2] + 8, W.ground + 24, W.claim[3] + 8];
  if (snapshot) out.file = await core.snap(ctx, out.box, `irr-${tag}`);
  // (the batch's breach fix) one lot's own box snapshotted too: its E-flat is judged alone where the world round it is changed on purpose
  const sl = lotSnap ? out.lots.find((l) => l.id === lotSnap) : null;
  if (sl) {
    const bx = Array.isArray(sl.box) ? { minX: sl.box[0], minZ: sl.box[2], maxX: sl.box[3], maxZ: sl.box[5] } : sl.box;
    out.lotBox = [bx.minX, W.ground - 8, bx.minZ, bx.maxX, W.ground + 24, bx.maxZ];
    out.lotFile = await core.snap(ctx, out.lotBox, `irr-${tag}-${lotSnap}`);
  }
  if (noRealise) return out;
  const rr = await L.call('dev.region.realiseApproved', { sha: out.sha, ...(Object.keys(entries).length ? { lotEntries: entries } : {}) }, 300_000);
  out.realiseCall = rr;
  if (rr.refused || !rr.region) { out.refused = rr.refused ?? rr; return out; }
  await L.waitRegion(rr.region, 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  out.r = await core.regionOf(ctx, rr.region);
  // (development: IRR_PROBE="x,y,z;..." logs the journal stack and the block at those cells after the realise)
  for (const q of (process.env.IRR_PROBE ?? '').split(';').filter(Boolean)) {
    const c = q.split(',').map(Number);
    const st = await L.call('dev.journal.at', { x: c[0], y: c[1], z: c[2] }, 30_000).catch(() => null);
    const cands = ['air', 'dirt', 'dirt_path', 'grass_block', 'farmland', 'composter', 'oak_fence', 'oak_fence_gate', 'lantern', 'torch', 'cobblestone', 'coarse_dirt', 'wheat', 'water', 'spruce_fence', 'stone_bricks', 'oak_planks', 'spruce_planks'];
    const is = [];
    for (const b of cands) if (await isBlock(ctx, c, `minecraft:${b}`)) is.push(b);
    ctx.log(`  probe ${q}: ${json(is)} stack ${json((st?.stack ?? st?.entries ?? []).map((e) => [e.site ?? e.entry, e.kind, e.before, e.after]))}`);
  }
  ctx.log(`  ${tag}: ${out.r.view.state} ${json(out.r.fluids.map((x) => [x.body, x.state, x.reason ?? null]))}`);
  return out;
}

/** The lot sites of a realised region by lot id: {lot: {siteId, state, ext}} (the region's view, then the site records). */
export async function lotSites(ctx, view) {
  const all = await ctx.L.call('dev.sites.state', {}, 30_000);
  const sites = [...(all.sites ?? []), ...(all.placed ?? [])];
  const out = {};
  for (const l of view.lots ?? []) {
    const s = sites.find((q) => q.id === l.siteId);
    out[l.id] = { siteId: l.siteId, state: l.state, ext: s?.ext ?? null };
  }
  return out;
}

/** Every census of the region's irrigation bodies (and the others): {ok, per: {id: [sources, mismatch, outside]}}. */
async function censusAll(ctx, r, before) {
  const per = {};
  let ok = true;
  for (const b of r.bodies) {
    const c = await ctx.core.censusOf(ctx, b, before, r.bodies);
    per[b.id] = [c.sources, c.mismatch.length, c.outside.length];
    if (!c.ok) { ok = false; ctx.log(`  census ${b.id}: ${ctx.json({ mismatch: c.mismatch, outside: c.outside })}`); }
  }
  return { ok, per };
}

async function fluidsIn(ctx, box) {
  const c = await ctx.L.call('dev.fluid.census', { box }, 600_000);
  return new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
}

/** The world cells of an IR lot's sources, sides, beds and the cell over each: {sources, sides, beds, over}. */
function lotCellsOf(irLot, bodies) {
  const own = bodies.filter((b) => (irLot.irrigation?.bodies ?? []).includes(b.id));
  const sources = own.flatMap((b) => b.cells);
  const sides = own.flatMap((b) => b.shell.filter((c) => c[1] === b.level));
  const beds = own.flatMap((b) => b.shell.filter((c) => c[1] === b.level - 1));
  const over = sources.map(([x, y, z]) => [x, y + 1, z]);
  return { own, sources, sides, beds, over };
}

/** The block an IR's columns op writes at a cell (the last op of the last part that writes it), or null. */
function bedBlock(ir, [x, y, z]) {
  let found = null;
  for (const p of ir.parts) for (const o of p.ops ?? []) {
    if (o.op !== 'columns') continue;
    for (let i = 0; i + 4 < o.cols.length; i += 5) if (o.cols[i] === x && o.cols[i + 1] === z && o.cols[i + 2] <= y && y <= o.cols[i + 3]) found = o.materials[o.cols[i + 4]];
  }
  return typeof found === 'string' ? found.replace(/\[.*$/, '') : null;
}

/** The field's farmland cells (the lot's field at floorY, the irrigation cells aside). */
function fieldCells(irLot) {
  const [x0, z0, x1, z1] = irLot.irrigation.field;
  const mask = new Set(runsCells(irLot.irrigation.cells).map(k3));
  const out = [];
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (!mask.has(k3([x, irLot.floorY, z]))) out.push([x, irLot.floorY, z]);
  return out;
}

/** Items 2 and 9 of one realised fixture: READY, PLACED, every body settled and census-exact, the dropped counts, the masked cells. */
async function placedChecks(ctx, tag, o, F, entries) {
  const { check, json } = ctx;
  const r = o.r;
  const irr = r.bodies.filter((b) => /_irr_\d+_\d+$/.test(b.id));
  check(o.overall === 'READY' && o.parts.every(([, k]) => k === 'fits' || k === 'adjusted'), `item 2 (${tag}): Regions.checkPlan's two-plan flow on the world: ${o.overall} ${json(o.parts)}`);
  check(r.view.state === 'PLACED' && r.fluids.length === r.bodies.length && r.fluids.every((x) => x.state === 'settled'), `item 2 (${tag}): realiseApproved with the bound field entr${Object.keys(entries).length === 1 ? 'y' : 'ies'} ${json(entries)}: ${r.view.state}, every body settled, one row per body (${irr.length} irrigation source(s); ${json(r.fluids.map((x) => [x.body, x.state]))})`);
  const before = new Map();
  const cs = await censusAll(ctx, r, before);
  check(cs.ok, `item 2 (${tag}): every body's census equals its prediction, 0 fluid outside its cells (${json(cs.per)})`);
  const sites = await lotSites(ctx, r.view);
  const out = { sources: irr.length, census: cs.per, lots: {} };
  for (const irLot of r.ir.lots.filter((l) => l.irrigation)) {
    const aLot = o.lots.find((l) => l.id === irLot.id);
    const entry = entries[irLot.id] ?? aLot?.entry ?? null;
    const site = sites[irLot.id] ?? {};
    const reported = site.ext?.['architect_mc:irrigationDropped'];
    const want = entry && aLot ? await expectedDropped(ctx, F[entry.replace(/@\d+$/, '')].bp, aLot) : null;
    const L = lotCellsOf(irLot, r.bodies);
    const sideFarm = await countBlock(ctx, L.sides, 'minecraft:farmland');
    // the bed: the block the IR's shell op writes there (the bible's bed, differing from the pad's top), standing
    let bedOk = 0;
    for (const c of L.beds) if (await isBlock(ctx, c, bedBlock(r.ir, c) ?? 'minecraft:air')) bedOk++;
    const overAir = await countBlock(ctx, L.over, 'minecraft:air');
    out.lots[irLot.id] = { entry, site: site.siteId, dropped: reported, expected: want, sides: [sideFarm, L.sides.length], beds: [bedOk, L.beds.length], over: [overAir, L.over.length], artifact: !!aLot?.irrigation };
    check(!!aLot?.irrigation && aLot.irrigation.sources === L.own.length, `item 2 (${tag}, ${irLot.id}): the artifact's lots[].irrigation (S-IRR-2): ${aLot?.irrigation?.sources} source(s), its cells in the world and in the lot's frame`);
    if (entry) check(typeof reported === 'number' && reported === want && reported > 0, `item 2 (${tag}, ${irLot.id}): the lot site's ext reports irrigationDropped ${reported}, equal to the entry's blocks on its irrigation cells (${want}, the kit's own fit)`);
    check(sideFarm === L.sides.length && bedOk === L.beds.length && overAir === L.over.length, `item 2 (${tag}, ${irLot.id}): the mask held: every side farmland (${sideFarm}/${L.sides.length}), every bed the bible's bed (${bedOk}/${L.beds.length}), the cell over every source air (${overAir}/${L.over.length})`);
  }
  return out;
}

/** Items 3, 7 and the crops on v62's f1 (default rules): hydration counted, the control dry, the design's crops, 3 farmers 5 minutes. */
async function liveChecks(ctx, o) {
  const { L, check, json } = ctx;
  const r = o.r;
  const f1 = r.ir.lots.find((l) => l.id === 'f1');
  const field = fieldCells(f1);
  await L.setRules('default');
  // (default rules: run6b's setRules('default') leaves the exact set's gamerules; these are vanilla's defaults, hostile mobs off)
  for (const g of ['random_tick_speed 3', 'mob_griefing true', 'advance_time true', 'spawn_mobs true', 'spawn_monsters false']) await L.cmd(`/gamerule ${g}`);
  await L.cmd('/time set 1000');
  // (random ticks only reach chunks within the simulation distance of a player: the bot stands over the field)
  await L.tp(field[0][0], field[0][1] + 6, field[0][2]);
  // the control: the same 11 x 8 farmland (with wheat) outside the claim, no water within 4
  const cx = o.W.claim[2] + 20, cz = o.W.claim[1] + 10, cy = f1.floorY;
  await L.cmd(`/fill ${cx} ${cy - 1} ${cz} ${cx + 10} ${cy - 1} ${cz + 7} minecraft:dirt`);
  await L.cmd(`/fill ${cx} ${cy} ${cz} ${cx + 10} ${cy} ${cz + 7} minecraft:farmland[moisture=0]`);
  await L.cmd(`/fill ${cx} ${cy + 1} ${cz} ${cx + 10} ${cy + 1} ${cz + 7} minecraft:wheat`);
  const control = []; for (let x = cx; x <= cx + 10; x++) for (let z = cz; z <= cz + 7; z++) control.push([x, cy, z]);
  // (hydration is a random tick's doing: each cell's first comes after 68 s on average at the default speed 3, so after 2 minutes
  // about 1 in 6 cells has had none yet; counted at 2 minutes (recorded), then every minute until all are moist (at most 10 minutes))
  const t0 = Date.now();
  await L.settle(120_000);
  const moist2 = await countBlock(ctx, field, 'minecraft:farmland[moisture=7]');
  let wet = moist2;
  while (wet < field.length && Date.now() - t0 < 600_000) { await L.settle(60_000); wet = await countBlock(ctx, field, 'minecraft:farmland[moisture=7]'); }
  const farm = await countBlock(ctx, field, 'minecraft:farmland');
  const cWet = await countBlock(ctx, control, 'minecraft:farmland[moisture=7]');
  const out = { hydration: { field: field.length, farmland: farm, moist7At2min: moist2, moist7: wet, control: control.length, controlMoist7: cWet, seconds: (Date.now() - t0) / 1000 } };
  check(true, `item 3 (recorded): after 2 minutes at default rules ${moist2} of ${field.length} field cells moisture=7 (a random tick each; vanilla)`);
  check(farm === field.length && wet === field.length, `item 3 (v62 f1): every farmland cell of the field moisture=7 at default rules (${wet}/${field.length} after ${Math.round((Date.now() - t0) / 1000)} s, farmland ${farm})`);
  check(cWet === 0, `item 3 (the control): the same field without irrigation is dry (${cWet} of ${control.length} moisture=7)`);
  // crops on the moist farmland (the design's wheat, on the field and on the sources' farmland sides)
  const crops = await countBlock(ctx, field.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat');
  const sideCrops = await countBlock(ctx, lotCellsOf(f1, r.bodies).sides.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat');
  out.crops = { field: crops, onSides: sideCrops };
  check(crops >= field.length - 2 && sideCrops > 0, `item 2/3 (v62 f1): crops planted on the moist farmland: wheat over ${crops} of ${field.length} field cells, ${sideCrops} over the sources' farmland sides (the design's, not reserved)`);
  // item 7: 3 farmer villagers on the field for 5 minutes
  const since = Date.now();
  const mid = field[Math.floor(field.length / 2)];
  for (let i = 0; i < 3; i++) await L.cmd(`/summon minecraft:villager ${mid[0] + 0.5 + i} ${mid[1] + 1} ${mid[2] + 0.5} {Tags:["irr_farmer"],PersistenceRequired:1b,VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"}}`);
  const ripe0 = await countBlock(ctx, field.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat[age=7]');
  await L.settle(300_000);
  const drown = await L.call('dev.entity.damage', { since, type: 'drown' }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  const alive = await L.cmd('/execute if entity @e[type=minecraft:villager,tag=irr_farmer]');
  const n = Number((/(\d+)/.exec(String(alive.messages?.join(' ') ?? alive.result ?? '')) ?? [0, 0])[1]);
  let stuck = 0;
  for (const [x, y, z] of lotCellsOf(f1, r.bodies).sources) {
    const s = await L.cmd(`/execute if entity @e[type=minecraft:villager,tag=irr_farmer,x=${x},y=${y},z=${z},dx=0,dy=0,dz=0]`);
    if (s?.success || Number(s?.result) > 0) stuck++;
  }
  const ripe1 = await countBlock(ctx, field.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat[age=7]');
  const crops1 = await countBlock(ctx, field.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat');
  const drowned = drown.damage ?? drown.events?.length ?? null;
  out.villagers = { placed: 3, alive: n, drown: drowned, deaths: drown.deaths ?? null, stuck, ripeBefore: ripe0, ripeAfter: ripe1, cropsAfter: crops1 };
  check(!drown.error && drowned === 0 && n === 3 && stuck === 0, `item 7: 3 farmer villagers on v62's field 5 minutes at default rules: drowning ${drowned}, ${n} alive, ${stuck} in a source`);
  check(true, `item 7 (recorded): harvest and replant: ripe wheat ${ripe0} -> ${ripe1}, wheat cells ${crops} -> ${crops1}`);
  // dev.nav.villager round every source: from one side's far cell to the opposite one, no path cell in water
  const wet2 = new Set(r.bodies.flatMap((b) => [...b.cells, ...b.spill]).map(k3));
  const nav = {};
  for (const b of lotCellsOf(f1, r.bodies).own) {
    const [x, y, z] = b.cells[0];
    const a = [x - 2, y + 1, z], c = [x + 2, y + 1, z];
    const ab = await L.call('dev.nav.villager', { from: a, to: c, range: 64, cells: true }, 120_000);
    const ba = await L.call('dev.nav.villager', { from: c, to: a, range: 64, cells: true }, 120_000);
    const inWater = [...(ab.cells ?? []), ...(ba.cells ?? [])].filter((q) => wet2.has(k3(q)) || wet2.has(k3([q[0], q[1] - 1, q[2]])) && false);
    nav[b.id] = { there: !!ab.canReach, back: !!ba.canReach, inWater: inWater.length };
  }
  out.nav = nav;
  check(Object.values(nav).every((v) => v.there && v.back && v.inWater === 0), `item 7: dev.nav.villager round every source both ways, no path cell in a source (${json(nav)})`);
  await L.cmd('/kill @e[type=minecraft:villager,tag=irr_farmer]');
  await L.setRules('exact');
  return out;
}

/** Item 4 on f2: one side shell broken: the water stays in its own lot's box and reaches no other lot, build or keep-out. */
async function breach(ctx, o, lotId = 'f2') {
  const { L, check, json } = ctx;
  const r = o.r;
  const lot = r.ir.lots.find((l) => l.id === lotId);
  const C = lotCellsOf(lot, r.bodies);
  const side = C.sides[0];
  const b = lot.box;
  const box = [b.minX - 10, lot.floorY - 3, b.minZ - 10, b.maxX + 10, lot.floorY + 3, b.maxZ + 10];
  const before = await fluidsIn(ctx, box);
  await L.cmd(`/setblock ${side.join(' ')} minecraft:air destroy`);
  await L.settle(30_000);
  const now = await fluidsIn(ctx, box);
  const added = [...now.keys()].filter((k) => !before.has(k)).map((k) => k.split(',').map(Number));
  const outside = added.filter(([x, , z]) => x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ);
  const st = await L.call('dev.region.state', { region: r.region }, 60_000);
  const row = (st.view.ext?.['architect_mc:fluids'] ?? []).find((x) => C.own.some((q) => q.id === x.body) && x.body === C.own.find((q) => q.shell.some((c) => k3(c) === k3(side)))?.id);
  const out = { side, added: added.length, outside: outside.length, sample: added.slice(0, 6), row };
  check(added.length >= 1 && outside.length === 0, `item 4 (${lotId}): one farmland side of a source broken (${side.join(' ')}): the water stays in its own lot's box (${added.length} new fluid cell(s), ${outside.length} outside it), no other lot, build or keep-out reached`, out);
  check(true, `item 4 (recorded, S-IRR-3): that body's architect_mc:fluids row after the breach: ${json(row ?? null)}`);
  return out;
}

/** Item 5 (c): a versionOf replacement of f1's entry (v2, carrots): applied, the mask holds, the sources unchanged. */
async function versionOf(ctx, o, F) {
  const { L, check, json } = ctx;
  const r = o.r;
  const sites = await lotSites(ctx, r.view);
  const f1 = r.ir.lots.find((l) => l.id === 'f1');
  const C = lotCellsOf(f1, r.bodies);
  const v2 = await installV2(ctx, F, 'g6c_irr_field_13x11');
  const d = await L.call('dev.site.delta.apply', { site: sites.f1.siteId, version: v2, owner: ctx.core.OWNER, force: true }, 300_000);
  await L.settle(5000);
  const sideFarm = await countBlock(ctx, C.sides, 'minecraft:farmland');
  const overAir = await countBlock(ctx, C.over, 'minecraft:air');
  const src = await countBlock(ctx, C.sources, 'minecraft:water');
  const carrots = await countBlock(ctx, fieldCells(f1).map(([x, y, z]) => [x, y + 1, z]), 'minecraft:carrots');
  const cs = await censusAll(ctx, { ...r, bodies: C.own }, new Map());
  ctx.log(`  versionOf: dev.site.delta.apply answered ${json(d).slice(0, 1500)}`);
  const out = { response: d, applied: d.applied ?? null, written: d.written ?? null, refusals: d.refusals ?? null, sides: [sideFarm, C.sides.length], over: [overAir, C.over.length], sources: [src, C.sources.length], carrots };
  check(d.applied === true && carrots > 0 && sideFarm === C.sides.length && overAir === C.over.length && src === C.sources.length && cs.ok, `item 5 (c): a versionOf replacement of f1's entry (v2, carrots: ${carrots} planted): the mask holds (sides ${sideFarm}/${C.sides.length}, over ${overAir}/${C.over.length}), the sources unchanged and census-exact (${src}/${C.sources.length})`, out);
  return out;
}

/** Item 5 (d): the lot site owns none of its irrigation cells (the stack at each: no entry of the lot's site): adopt and claim leave them. */
async function ownership(ctx, o) {
  const { L, check } = ctx;
  const r = o.r;
  const sites = await lotSites(ctx, r.view);
  const out = {};
  for (const lot of r.ir.lots.filter((l) => l.irrigation && sites[l.id]?.siteId)) {
    const sid = sites[lot.id].siteId;
    let owned = 0, n = 0;
    for (const c of runsCells(lot.irrigation.cells)) {
      const s = await L.call('dev.journal.at', { x: c[0], y: c[1], z: c[2] }, 30_000);
      n++;
      if ((s.stack ?? s.entries ?? []).some((e) => e.site === sid)) owned++;
    }
    out[lot.id] = { cells: n, ownedBySite: owned };
  }
  check(Object.values(out).length > 0 && Object.values(out).every((v) => v.ownedBySite === 0), `item 5 (d): no irrigation cell is in its lot site's entries (PT2's adopt and Steward's claim and release read the entries: they never touch them): ${ctx.json(out)}`);
  return out;
}

/** Item 5 (b), S-IRR-4: f2's site removed alone: its sources drained first and exactly, no orphan water; the region not PARTIAL. */
async function removeLot(ctx, o, lotId = 'f2') {
  const { L, check, json } = ctx;
  const r = o.r;
  const sites = await lotSites(ctx, r.view);
  const lot = r.ir.lots.find((l) => l.id === lotId);
  const C = lotCellsOf(lot, r.bodies);
  const rm = await L.call('dev.sites.remove', { site: sites[lotId].siteId, force: true }, 600_000);
  for (let i = 0; i < 120; i++) { const s = (await L.call('dev.sites.state', {}, 30_000)); if (!JSON.stringify(s).includes(`"${sites[lotId].siteId}"`) || JSON.stringify(s).includes('"removed":true')) break; await sleep(1000); }
  await L.settle(5000);
  const b = lot.box;
  const water = [...(await fluidsIn(ctx, [b.minX - 1, lot.floorY - 2, b.minZ - 1, b.maxX + 1, lot.floorY + 2, b.maxZ + 1])).keys()];
  const st = await L.call('dev.region.state', { region: r.region }, 60_000);
  const rows = (st.view.ext?.['architect_mc:fluids'] ?? []).filter((x) => C.own.some((q) => q.id === x.body));
  const shells = (await countBlock(ctx, C.sides, 'minecraft:farmland')) + (await countBlock(ctx, C.sides, 'minecraft:dirt'));
  const out = { removed: rm.removed ?? rm, water: water.length, rows: rows.map((x) => [x.body, x.state, x.reason]), state: st.view.state, shells: [shells, C.sides.length] };
  check(water.length === 0 && rows.length === C.own.length && rows.every((x) => x.state === 'drained' && /lot removed/.test(x.reason ?? '')) && st.view.state === 'PLACED' && shells === C.sides.length,
    `item 5 (b, S-IRR-4): ${lotId}'s site removed alone: its ${C.own.length} source(s) drained first and exactly, 0 water left in its box (${water.length}), each row 'drained: lot removed', the region still ${st.view.state} (not PARTIAL), the region's farmland sides standing (${shells}/${C.sides.length})`, out);
  return out;
}

/**
 * (The CU/IRR/VOC-c batch, the verifier's breach finding) A breach whose flow joins a pond and a player's water beside the lot: neither is
 * taken by the drain. On v62's f2 with its field entry: a player's well (a source in a 1 x 1 hole) and a 2 x 2 pond, both sunk one under
 * the ground just outside the box on the side nearest f2's source, placed after the realise; then the player breaks the source's side
 * there and digs a trench through the field to the box edge, so the flow runs out of the lot and over both. Judged: the flow leaves the
 * box and touches the pond and the well (before anything is removed); f2's site removed (the drain judged from the fluid levels):
 * the well and every pond cell still sources, 0 water in the lot's box, the flow outside taken back; then the region removed: the well
 * and the pond still there, E-flat exact over f2's own box (its snapshot alone: the world round it was changed on purpose).
 */
async function spareForeign(ctx, o) {
  const { L, check, json, core } = ctx;
  const r = o.r;
  const lot = r.ir.lots.find((l) => l.id === 'f2');
  const C = lotCellsOf(lot, r.bodies);
  const b = lot.box;
  const S = C.sources[0];
  const y = S[1];
  // the exit: the box edge nearest the source (dir d along x or z), the lateral axis l
  // (the strip outside the edge, where the pond and the well go, must hold no cell of another body: the farm ponds stand outside the boxes)
  const bodyCells = new Set(r.bodies.filter((q) => !C.own.includes(q)).flatMap((q) => [...q.cells, ...q.shell, ...q.spill, ...q.watch, ...(q.lining ?? [])]).map(k3));
  const cand = [[[-1, 0], S[0] - b.minX], [[1, 0], b.maxX - S[0]], [[0, -1], S[2] - b.minZ], [[0, 1], b.maxZ - S[2]]].sort((p, q) => p[1] - q[1]);
  const free = ([[cx, cz], ce]) => {
    for (let a = ce + 1; a <= ce + 3; a++) for (let l = -2; l <= 3; l++) for (let dy = -1; dy <= 2; dy++) if (bodyCells.has(k3([S[0] + a * cx + l * cz, y + dy, S[2] + a * cz + l * cx]))) return false;
    return true;
  };
  const pick = cand.find((c) => c[1] <= 5 && free(c)) ?? cand[0];
  const [[dx, dz], e] = pick;
  const [lx, lz] = [dz, dx]; // lateral (perpendicular)
  const at = (a, l, dy = 0) => [S[0] + a * dx + l * lx, y + dy, S[2] + a * dz + l * lz];
  const side = at(1, 0);
  const out = { source: S, exit: [dx, dz], edge: e, side };
  check(C.sides.some((c) => k3(c) === k3(side)) && e <= 5 && free(pick), `(breach fix) f2's source ${k3(S)} is ${e} from the box edge (at most 5, so a breach's flow leaves the box), its side ${k3(side)} toward it is a farmland side, no other body in the strip outside`, out);
  // the ground outside the box where the flow runs: a 3 x 5 strip made plain (dirt under, air over), then the pond and the well sunk in it
  for (let a = e + 1; a <= e + 3; a++) for (let l = -2; l <= 3; l++) {
    const [x, , z] = at(a, l);
    await L.cmd(`/fill ${x} ${y} ${z} ${x} ${y + 2} ${z} minecraft:air`);
    await L.cmd(`/setblock ${x} ${y - 1} ${z} minecraft:dirt`);
  }
  const pond = [at(e + 1, 1, -1), at(e + 1, 2, -1), at(e + 2, 1, -1), at(e + 2, 2, -1)];
  const well = at(e + 1, -1, -1); // (apart from the pond: the cell between them stays dirt)
  for (const c of [...pond, well]) await L.cmd(`/setblock ${c.join(' ')} minecraft:water`);
  await L.settle(5000);
  const B = [b.minX - 12, y - 4, b.minZ - 12, b.maxX + 12, y + 2, b.maxZ + 12];
  const isSource = (m, c) => /^minecraft:water(\[level=0\])?$/.test(m.get(k3(c)) ?? '');
  const before = await fluidsIn(ctx, B);
  out.placed = { pond: pond.filter((c) => isSource(before, c)).length, well: isSource(before, well) };
  // the player's breach: the side, then a trench through the field to the box edge (the crop and the fence over it too)
  for (let a = e; a >= 1; a--) {
    const [x, , z] = at(a, 0);
    await L.cmd(`/fill ${x} ${y + 2} ${z} ${x} ${y + 1} ${z} minecraft:air`);
    await L.cmd(`/setblock ${x} ${y} ${z} minecraft:air`);
  }
  await L.settle(30_000);
  await L.cmd('/kill @e[type=minecraft:item]');
  const now = await fluidsIn(ctx, B);
  const foreign = new Set([...pond, well].map(k3));
  const flow = [...now.keys()].filter((k) => !before.has(k) && !foreign.has(k)).map((k) => k.split(',').map(Number));
  const inBox = ([x, , z]) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  const adj = (c, set) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([u, v, w]) => set.has(k3([c[0] + u, c[1] + v, c[2] + w])));
  const pondSet = new Set(pond.map(k3)), wellSet = new Set([k3(well)]);
  out.flow = { cells: flow.length, outside: flow.filter((c) => !inBox(c)).length, touchesPond: flow.some((c) => adj(c, pondSet)), touchesWell: flow.some((c) => adj(c, wellSet)) };
  check(out.placed.pond === 4 && out.placed.well && out.flow.outside > 0 && out.flow.touchesPond && out.flow.touchesWell,
    `(breach fix) a pond (2 x 2 sources) and a player's well beside f2, then f2's side broken with a trench to the box edge: the breach's flow (${out.flow.cells} cells, ${out.flow.outside} outside the box) touches the pond and the well`, out);
  // f2's site removed: the drain takes the flow back and leaves the pond and the well
  const sites = await lotSites(ctx, r.view);
  const rm = await L.call('dev.sites.remove', { site: sites.f2.siteId, force: true }, 600_000);
  for (let i = 0; i < 120; i++) { const st = await L.call('dev.sites.state', {}, 30_000); if (!JSON.stringify(st).includes(`"${sites.f2.siteId}"`) || JSON.stringify(st).includes('"removed":true')) break; await sleep(1000); }
  await L.settle(5000);
  const after = await fluidsIn(ctx, B);
  const st = await L.call('dev.region.state', { region: r.region }, 60_000);
  const rows = (st.view.ext?.['architect_mc:fluids'] ?? []).filter((x) => C.own.some((q) => q.id === x.body));
  const left = [...after.keys()].filter((k) => !before.has(k) && !foreign.has(k)).map((k) => k.split(',').map(Number));
  out.lotRemoved = { removed: rm.removed ?? rm, pond: pond.filter((c) => isSource(after, c)).length, well: isSource(after, well), leftInBox: left.filter(inBox).length, leftOutside: left.filter((c) => !inBox(c)).length,
    leftSample: left.slice(0, 8), rows: rows.map((x) => [x.body, x.state, x.reason, x.breach ?? null]) };
  check(out.lotRemoved.pond === 4 && out.lotRemoved.well && out.lotRemoved.leftInBox === 0 && rows.every((x) => x.state === 'drained'),
    `(breach fix) f2's site removed: the drain took the breach's flow back and spared what is not the body's: the pond ${out.lotRemoved.pond}/4 sources, the player's well ${out.lotRemoved.well ? 'a source' : 'TAKEN'}, 0 water in f2's box (${out.lotRemoved.leftInBox}); outside it ${out.lotRemoved.leftOutside} cell(s) left (joint water is spared: recorded)`, out.lotRemoved);
  // the region removed: the pond and the well still there, f2's own box exactly as before the realise
  await L.setRules('exact');
  const rr = await core.removeWait(ctx, r.region);
  await sleep(3000);
  const fin = await fluidsIn(ctx, B);
  const df = o.lotFile ? await core.diff(ctx, o.lotBox, o.lotFile) : { mismatches: -1 };
  out.removal = { state: rr.state, pond: pond.filter((c) => isSource(fin, c)).length, well: isSource(fin, well), lotEflat: df.mismatches, sample: df.sample ?? null, lotBox: o.lotBox, irBox: [b.minX, b.minZ, b.maxX, b.maxZ] };
  check(rr.state === 'REMOVED' && out.removal.pond === 4 && out.removal.well && df.mismatches === 0,
    `(breach fix) then Regions.remove: ${rr.state}, the pond ${out.removal.pond}/4 and the well ${out.removal.well ? 'standing' : 'TAKEN'}, E-flat over f2's own box ${df.mismatches}`, out.removal);
  return out;
}

/** The region removed (exact rules): E-flat 0 over the snapshot (items 4, 5 (a) and (e)). */
async function removeRegion(ctx, o, item, { judged = true } = {}) {
  const { L, core, check } = ctx;
  await L.setRules('exact');
  // (diagnosis: the journal stacks round each irrigated lot's box at its pad's top, the apron, kept for a mismatch there)
  const stacks = {};
  for (const lot of (o.r?.ir?.lots ?? []).filter((l) => l.irrigation)) {
    const b = lot.box, y = lot.floorY - 1;
    for (let x = b.minX - 1; x <= b.maxX + 1; x++) for (let z = b.minZ - 1; z <= b.maxZ + 1; z++) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) continue;
      const st = await L.call('dev.journal.at', { x, y, z }, 30_000).catch(() => null);
      if (st && (st.stack ?? st.entries ?? []).length) stacks[`${x},${y},${z}`] = (st.stack ?? st.entries).map((e) => [e.site ?? e.entry, e.kind, e.before, e.after]);
    }
  }
  const rm = await core.removeWait(ctx, o.r.region);
  await sleep(3000);
  const df = await core.diff(ctx, o.box, o.file);
  const at = Object.fromEntries((df.sample ?? []).map((m) => [m.pos, stacks[m.pos] ?? null]).filter(([, v]) => v));
  if (df.mismatches) ctx.log(`  ${item}: the journal stacks at the mismatched apron cells before the removal: ${ctx.json(at)}`);
  (judged ? check : (ok, m, d) => check(true, `(recorded${ok ? '' : ', not as hoped'}) ${m}`, d))(rm.state === 'REMOVED' && df.mismatches === 0, `${item}: Regions.remove (the sources drained first, then the shells and the lots) restores the box exactly: E-flat ${df.mismatches} (${rm.seconds} s)`, df.sample);
  return { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, sample: df.sample, stacks: at };
}

/** (fix/lamp-path) The lanes' journaled dirt paths: no road post on one; each turned to dirt by a block over it, then the removal. */
async function lampPath(ctx, o) {
  const { L, check, json } = ctx;
  const lanes = (o.r.ir.paths ?? []).filter((p) => /^lane_/.test(p.id));
  const seen = new Set(), paths = [];
  for (const ln of lanes) for (const [px, py, pz] of ln.points) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const c = [px + dx, py, pz + dz], k = k3(c);
    if (seen.has(k)) continue;
    seen.add(k);
    const st = await L.call('dev.journal.at', { x: c[0], y: c[1], z: c[2] }, 30_000).catch(() => null);
    const top = (st?.stack ?? st?.entries ?? []).at(-1);
    if (top && /^minecraft:dirt_path/.test(top.after ?? '') && await isBlock(ctx, c, 'minecraft:dirt_path')) paths.push({ c, kind: top.kind });
  }
  const posts = [];
  for (const p of paths) {
    const up = [p.c[0], p.c[1] + 1, p.c[2]];
    if (await isBlock(ctx, up, '#minecraft:fences') || await isBlock(ctx, up, '#minecraft:walls')) posts.push({ ...p, up });
  }
  const res = { lanes: lanes.map((l) => l.id), paths: paths.length, kinds: [...new Set(paths.map((p) => p.kind))], posts: posts.map((p) => k3(p.c)) };
  check(lanes.length > 0 && paths.length > 0 && posts.length === 0, `(lamp-path) farm_hamlet: no road lantern post on a lane's dirt path (${paths.length} journaled path cell(s) round ${lanes.length} lane(s), ${posts.length} under a post${posts.length ? `: ${posts.map((p) => k3(p.c)).join(' ')}` : ''})`, res);
  // a post on a path: a block set beside it and taken away, as the field's composter path did (the fence reconnects, the path ticks)
  for (const p of posts) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [p.up[0] + dx, p.up[1], p.up[2] + dz];
      if (!(await isBlock(ctx, n, 'minecraft:air'))) continue;
      await L.cmd(`/setblock ${n.join(' ')} minecraft:stone`);
      await L.settle(500);
      await L.cmd(`/setblock ${n.join(' ')} minecraft:air`);
      break;
    }
  }
  // every other path cell: a block over it and taken away (vanilla turns the path to dirt; the journal still says dirt_path)
  let poked = 0;
  for (const p of paths) {
    const up = [p.c[0], p.c[1] + 1, p.c[2]];
    if (!(await isBlock(ctx, up, 'minecraft:air'))) continue;
    await L.cmd(`/setblock ${up.join(' ')} minecraft:stone`);
    poked++;
  }
  await L.settle(1500);
  for (const p of paths) {
    const up = [p.c[0], p.c[1] + 1, p.c[2]];
    if (await isBlock(ctx, up, 'minecraft:stone')) await L.cmd(`/setblock ${up.join(' ')} minecraft:air`);
  }
  await L.settle(1500);
  let turned = 0;
  for (const p of paths) if (await isBlock(ctx, p.c, 'minecraft:dirt')) turned++;
  res.poked = poked; res.turned = turned;
  check(poked > 0 && turned >= poked, `(lamp-path) a block set over each of ${poked} lane path cell(s) and taken away: vanilla turned ${turned} to dirt (outside the journal)`, res);
  res.removal = await removeRegion(ctx, o, `(lamp-path) farm_hamlet, the lanes' paths turned to dirt: the region`);
  return res;
}

/** The whole irr-ingame step. */
export async function ingame(ctx) {
  const { L, check, json, B } = ctx;
  const out = {};
  // (development: IRR_ONLY=v62a,v62b,spare,lp,v63,s01,d01,u01b,pad,probe runs those sections only)
  const only = (process.env.IRR_ONLY ?? '').split(',').filter(Boolean);
  const want = (k) => !only.length || only.includes(k);
  const F = await installFields(ctx);
  const fx = (rel) => B.fixture(ctx, rel);
  const E62 = { f1: 'g6c_irr_field_13x11', f2: 'g6c_irr_field_11x11' };
  // ---- v62, the live world (default rules: random ticks, villagers, time; its removal is recorded, not judged: 10 minutes of random
  // ticks change the terrain round it): items 3 and 7, the crops
  if (want('v62live')) {
    const o = await realiseIrr(ctx, 'v62live', fx('valid/v62_irr_farm.json'), { entries: E62, fields: F });
    if (o.r) {
      out.v62live = { placed: await placedChecks(ctx, 'v62live', o, F, E62), live: await liveChecks(ctx, o) };
      await L.cmd('/kill @e[type=minecraft:item]');
      out.v62live.removal = await removeRegion(ctx, o, '(recorded: the live world) the region', { judged: false });
    } else check(false, `v62 (live): not realised (${json(o.parts)} ${json(o.refused ?? null)})`);
    await L.leaveWorld();
  }
  // ---- v62 world A (exact rules): items 2, 4, 5 (c) (d) (b) (e)
  if (want('v62a')) {
    const o = await realiseIrr(ctx, 'v62a', fx('valid/v62_irr_farm.json'), { entries: E62, fields: F });
    if (o.r) {
      out.v62 = await placedChecks(ctx, 'v62', o, F, E62);
      out.v62.breach = await breach(ctx, o, 'f2');
      out.v62.versionOf = await versionOf(ctx, o, F);
      out.v62.ownership = await ownership(ctx, o);
      out.v62.removeLot = await removeLot(ctx, o, 'f2');
      out.v62.removal = await removeRegion(ctx, o, 'items 4 and 5 (e): after the breach, the versionOf and f2 removed alone, the region');
    } else check(false, `v62: not realised (${json(o.parts)} ${json(o.refused ?? null)})`);
    await L.leaveWorld();
  }
  // ---- (the batch's breach fix) v62 world C: a breach's flow over a pond and a player's well beside f2; the lot removed, then the region
  if (want('spare')) {
    const o = await realiseIrr(ctx, 'spare', fx('valid/v62_irr_farm.json'), { entries: E62, fields: F, lotSnap: 'f2' });
    if (o.r) out.spare = await spareForeign(ctx, o);
    else check(false, `(breach fix) v62: not realised (${json(o.parts)} ${json(o.refused ?? null)})`);
    await L.leaveWorld();
  }
  // ---- v62 world B: item 5 (a): the region removed with its lots standing
  if (want('v62b')) {
    const o = await realiseIrr(ctx, 'v62b', fx('valid/v62_irr_farm.json'), { entries: E62, fields: F });
    if (o.r) {
      check(o.r.view.state === 'PLACED', `item 5 (a): v62 realised again (${o.r.view.state})`);
      out.v62b = await removeRegion(ctx, o, 'item 5 (a): Regions.remove with every lot standing');
    } else check(false, 'item 5 (a): v62 not realised');
    await L.leaveWorld();
  }
  // ---- v63 (a 40 x 40 farm), Steward's hamlet (type-implied, bound in its plan), a district lot: every new path in game
  // ---- the control for Steward's hamlet: H's farm_hamlet without irrigate, the same field entry bound (h0; h0p as pads, development
  // only). Main's own E-flat with a bound entry: a road's lantern post stands on the lane's dirt_path at the entrance and turns it to
  // dirt, which the removal leaves (dirt_path and dirt are not interchangeable in StillOurs). s01 is judged against it.
  for (const [tag, rel, entries] of [['h0', 'h/farm_hamlet.json', { farm_1: 'g6c_irr_field' }], ['h0p', 'h/farm_hamlet.json', {}]]) {
    if (tag === 'h0' ? !want('s01') && !only.includes('h0') : !only.includes(tag)) continue;
    const o = await realiseIrr(ctx, tag, fx(rel), { entries, fields: F });
    if (o.r) out[tag] = await removeRegion(ctx, o, `(control ${tag}) farm_hamlet without irrigate`, { judged: false });
    await L.leaveWorld();
  }
  // ---- (fix/lamp-path) the farm hamlet without an entry: (1) no road lantern post stands on a lane's dirt path (main's post at the
  // farm's entrance did: a block written beside it reconnected the fence, vanilla turned the path under it to dirt outside the journal and
  // the removal kept the dirt); a post found there is poked as the field's composter did (a block set beside it, then air), the chain
  // shown. (2) Every journaled dirt path round the lanes gets a block set over it and taken away (vanilla turns it to dirt, as under a
  // lot's composter or a player's block): the removal still restores every one (E-flat 0, judged).
  if (want('lp')) {
    const o = await realiseIrr(ctx, 'lp', fx('h/farm_hamlet.json'), { entries: {}, fields: F });
    if (o.r) out.lp = await lampPath(ctx, o);
    else check(false, `(lamp-path) farm_hamlet: not realised (${json(o.parts)} ${json(o.refused ?? null)})`);
    await L.leaveWorld();
  }
  for (const [tag, rel, entries] of [['v63', 'valid/v63_irr_large.json', { big: 'g6c_irr_field_40x40' }], ['s01', 'irr/s01_hamlet.json', {}], ['d01', 'irr/d01_district.json', { field_1: 'g6c_irr_field_13x11' }]]) {
    if (!want(tag)) continue;
    const o = await realiseIrr(ctx, tag, fx(rel), { entries, fields: F });
    if (o.r) {
      out[tag] = await placedChecks(ctx, tag, o, F, entries);
      if (tag === 's01' && out.h0) {
        // (judged against the control: the same cells as main's own mismatch without irrigate, by position and states; nothing else)
        const rm = await removeRegion(ctx, o, `item 2 (${tag}, recorded)`, { judged: false });
        const key = (m) => `${m.pos} ${m.was} ${m.now}`;
        const a = new Set((rm.sample ?? []).map(key)), b = new Set((out.h0.sample ?? []).map(key));
        const same = rm.mismatches === out.h0.mismatches && [...a].every((k) => b.has(k));
        check(rm.state === 'REMOVED' && same, `item 2 (${tag}): Regions.remove: E-flat ${rm.mismatches}, exactly the control's (farm_hamlet without irrigate, the same entry: ${out.h0.mismatches}, main's road lantern on the lane's path, ${[...b].join('; ') || 'none'}): nothing of irrigation's`, { s01: rm.sample, control: out.h0.sample });
        out[tag].removal = rm;
      } else out[tag].removal = await removeRegion(ctx, o, `item 2 (${tag})`);
    } else check(false, `item 2 (${tag}): not realised (${o.overall} ${json(o.parts)} ${json(o.refused ?? null)})`);
    await L.leaveWorld();
  }
  // ---- the broken variant in game: irrUnmasked (the lot's design placed over the sides): the live check refuses the source, PARTIAL
  if (want('u01b')) {
    const o = await realiseIrr(ctx, 'u01b', fx('irr/u01b_unmasked_game.json'), { entries: { f1: 'g6c_irr_field_13x11' }, fields: F });
    if (o.r) {
      const rows = o.r.fluids.filter((x) => /_irr_/.test(x.body));
      out.u01b = { state: o.r.view.state, rows: rows.map((x) => [x.body, x.state, x.reason ?? null]) };
      check(o.r.view.state === 'PARTIAL' && rows.length > 0 && rows.every((x) => x.state === 'drained' && /uncontained/.test(x.reason ?? '')), `broken variant irrUnmasked (no mask): the lot's design writes over the sides, the live check refuses every source (uncontained), PARTIAL (${json(out.u01b)})`);
      out.u01b.removal = await removeRegion(ctx, o, 'broken variant irrUnmasked: the region');
    } else check(false, `irrUnmasked: not realised (${json(o.parts)})`);
    await L.leaveWorld();
  }
  // ---- a breach on a bare pad (no entry: air over the pad where the field model assumes farmland): its reach recorded, the removal
  // judged (the drain follows the breach's flow: no orphan water)
  if (want('pad')) {
    const o = await realiseIrr(ctx, 'pad', fx('valid/v62_irr_farm.json'), { entries: {}, fields: F });
    if (o.r) {
      const lot = o.r.ir.lots.find((l) => l.id === 'f2');
      const C = lotCellsOf(lot, o.r.bodies);
      const b = lot.box;
      const box = [b.minX - 12, lot.floorY - 4, b.minZ - 12, b.maxX + 12, lot.floorY + 2, b.maxZ + 12];
      const before = await fluidsIn(ctx, box);
      await L.cmd(`/setblock ${C.sides[0].join(' ')} minecraft:air destroy`);
      await L.settle(30_000);
      const now = await fluidsIn(ctx, box);
      const added = [...now.keys()].filter((k) => !before.has(k)).map((k) => k.split(',').map(Number));
      const outside = added.filter(([x, , z]) => x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ);
      out.padBreach = { added: added.length, outside: outside.length, sample: outside.slice(0, 6) };
      check(true, `(recorded, the field model's limit) a breach on a bare pad (no lot entry): ${added.length} new fluid cell(s), ${outside.length} outside the lot's box`, out.padBreach);
      out.padBreach.removal = await removeRegion(ctx, o, 'item 4 (a breach on a bare pad): the region, the breach\'s flow taken back with its source');
    }
    await L.leaveWorld();
  }
  if (want('probe')) out.probe = await probe(ctx);
  return out;
}

/** Item 9 (recorded): vanilla 26.3's hydration reach: a source at the centre of 9x9 and 11x11, at a corner, farmland 1 over and 1 under. */
export async function probe(ctx) {
  const { L, check, core } = ctx;
  await L.fresh('G6B IRR probe', core.FLAT);
  await L.setRules('default');
  for (const r of ['random_tick_speed 3', 'advance_time true', 'spawn_monsters false']) await L.cmd(`/gamerule ${r}`);
  const g = await core.groundOf(ctx, [9800, 9000, 9900, 9100]);
  const y = g + 1;
  const out = {};
  const plots = [['c9', 9800, 9000, 9, 'centre', 0], ['c11', 9820, 9000, 11, 'centre', 0], ['corner', 9840, 9000, 9, 'corner', 0], ['over', 9860, 9000, 9, 'centre', 1], ['under', 9880, 9000, 9, 'centre', -1]];
  for (const [tag, x0, z0, n, at, dy] of plots) {
    // (a stone ring round the plot at its level and under it: the water stays a single source, nothing flows off the plot)
    await L.cmd(`/fill ${x0 - 1} ${y - 2} ${z0 - 1} ${x0 + n} ${y + 1} ${z0 + n} minecraft:stone`);
    await L.cmd(`/fill ${x0} ${y + 1} ${z0} ${x0 + n - 1} ${y + 1} ${z0 + n - 1} minecraft:air`);
    await L.cmd(`/fill ${x0} ${y - 1} ${z0} ${x0 + n - 1} ${y - 1} ${z0 + n - 1} minecraft:dirt`);
    await L.cmd(`/fill ${x0} ${y} ${z0} ${x0 + n - 1} ${y} ${z0 + n - 1} minecraft:farmland[moisture=0]`);
    const wx = at === 'corner' ? x0 : x0 + (n >> 1), wz = at === 'corner' ? z0 : z0 + (n >> 1);
    await L.cmd(`/setblock ${wx} ${y + dy} ${wz} minecraft:water`);
    if (dy > 0) await L.cmd(`/setblock ${wx} ${y} ${wz} minecraft:dirt`);
    if (dy < 0) await L.cmd(`/setblock ${wx} ${y} ${wz} minecraft:air`);
    out[tag] = { x0, z0, n, water: [wx, y + dy, wz] };
  }
  await L.settle(300_000); // (5 minutes: about 1 cell in 80 has had no random tick yet)
  for (const [tag, x0, z0, n] of plots) {
    let wet = 0, cells = 0, far = [];
    for (let x = x0; x < x0 + n; x++) for (let z = z0; z < z0 + n; z++) {
      if (x === out[tag].water[0] && z === out[tag].water[2]) continue;
      cells++;
      if (await isBlock(ctx, [x, y, z], 'minecraft:farmland[moisture=7]')) wet++; else if (far.length < 8) far.push([x, z]);
    }
    Object.assign(out[tag], { cells, wet, dry: far });
  }
  check(true, `item 9 (recorded): vanilla's hydration reach on 26.3 after 5 minutes at default rules: ${ctx.json(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.wet}/${v.cells}`])))}`, out);
  await L.leaveWorld();
  return out;
}

/** Item 6: H's FL1 and FL2 kill points (+save) on v62's realise, and FL6 (+save: a lot removal's drain, before its site is restored). */
export async function crash(ctx) {
  const { L, check, json, B, core } = ctx;
  const out = {};
  const F = await installFields(ctx);
  const E62 = { f1: 'g6c_irr_field_13x11', f2: 'g6c_irr_field_11x11' };
  const fx = B.fixture(ctx, 'valid/v62_irr_farm.json');
  for (const [tag, point] of [['fl1', 'FL1+save'], ['fl2', 'FL2+save'], ['fl6', 'FL6+save']]) {
    const world = `G6B IRR ${tag}`;
    // the world and its plan, as realiseIrr, but the realise (or the lot removal) cut by the kill point
    // the world and its plan as realiseIrr's; FL1 and FL2 cut the realise itself, FL6 the lot removal after it
    const o = await realiseIrr(ctx, tag, fx, { entries: E62, fields: F, noRealise: tag !== 'fl6' });
    if (!o.sha) { check(false, `item 6 (${point}): v62 not READY (${json(o.parts)})`); await L.leaveWorld(); continue; }
    if (tag !== 'fl6') {
      await L.call('dev.journal.killAt', { point }, 10_000);
      L.call('dev.region.realiseApproved', { sha: o.sha, lotEntries: E62 }, 300_000).catch(() => null);
      await waitDown(ctx, point);
      await L.openWorld(world);
      await L.tp((o.W.claim[0] + o.W.claim[2]) / 2, 120, (o.W.claim[1] + o.W.claim[3]) / 2);
      const region = (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
      const st = await L.waitRegion(region, 3_600_000);
      const r = await core.regionOf(ctx, region);
      const cs = await censusAll(ctx, r, new Map());
      out[tag] = { state: st.view.state, rows: r.fluids.map((x) => [x.body, x.state, x.reason ?? null]), census: cs.per };
      check(st.view.state === 'PLACED' && r.fluids.every((x) => x.state === 'settled') && cs.ok, `item 6 (${point}): settle at start completes the realise: ${st.view.state}, every body settled, 0 fluid outside the declared cells (${json(out[tag].rows)})`);
      o.r = r;
    } else {
      await L.call('dev.journal.killAt', { point }, 10_000);
      const sites = await lotSites(ctx, o.r.view);
      L.call('dev.sites.remove', { site: sites.f2.siteId, force: true }, 600_000).catch(() => null);
      await waitDown(ctx, point);
      await L.openWorld(world);
      await L.tp((o.W.claim[0] + o.W.claim[2]) / 2, 120, (o.W.claim[1] + o.W.claim[3]) / 2);
      const r = await core.regionOf(ctx, o.r.region);
      const rows = r.fluids.filter((x) => /^f2_irr_/.test(x.body));
      // the removal asked again (the stop lost it): the drain is idempotent, then the site is restored
      const again = await L.call('dev.sites.remove', { site: sites.f2.siteId, force: true }, 600_000).catch((e) => ({ error: String(e.message ?? e) }));
      await L.settle(5000);
      const lot = r.ir.lots.find((l) => l.id === 'f2');
      const b = lot.box;
      const water = [...(await fluidsIn(ctx, [b.minX - 1, lot.floorY - 2, b.minZ - 1, b.maxX + 1, lot.floorY + 2, b.maxZ + 1])).keys()];
      out[tag] = { rowsAfterStop: rows.map((x) => [x.body, x.state, x.reason ?? null]), again: again.error ?? again.removed ?? 'ok', water: water.length };
      check(rows.length > 0 && rows.every((x) => x.state === 'drained' && /lot removed/.test(x.reason ?? '')) && water.length === 0, `item 6 (${point}, a lot removal's drain then a stop before its site is restored): the drain was saved (${json(out[tag].rowsAfterStop)}), the removal asked again finishes (${out[tag].again}), 0 water in the lot's box`);
      o.r = r;
    }
    out[tag].removal = await removeRegion(ctx, o, `item 6 (${point}): the region afterwards`);
    await L.leaveWorld();
  }
  return out;
}

async function waitDown(ctx, point) {
  let down = false;
  for (let i = 0; i < 180 && !down; i++) {
    await sleep(2000);
    const s = await ctx.L.call('dev.state', {}, 10_000).catch(() => null);
    down = !!s && s.inWorld === false;
  }
  if (!down) throw new Error(`the kill point ${point} did not halt the server`);
  ctx.log(`  ${point}: the server halted`);
}

/** The look step (a client, recorded, not judged): v62's two irrigated farms with their field entries, at noon, from the camera. */
export async function look(ctx) {
  const { L, OUT, log, B } = ctx;
  const F = await installFields(ctx);
  const o = await realiseIrr(ctx, 'look', B.fixture(ctx, 'valid/v62_irr_farm.json'), { entries: { f1: 'g6c_irr_field_13x11', f2: 'g6c_irr_field_11x11' }, fields: F, snapshot: false });
  const dir = path.join(OUT, 'irr-look');
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  if (!o.r) { ctx.check(false, `look: v62 not realised (${ctx.json(o.parts)})`); return { shots }; }
  // (default rules for 5 minutes, the camera over the farms: every field cell has its random tick, so the whole field shows moist)
  for (const g of ['random_tick_speed 3', 'spawn_monsters false']) await L.cmd(`/gamerule ${g}`);
  {
    const l0 = o.r.ir.lots.find((l) => l.irrigation);
    await L.tp(l0.box.minX, l0.floorY + 8, l0.box.maxZ);
    await L.settle(300_000);
    await L.cmd('/gamerule random_tick_speed 0');
  }
  await L.cmd('/time set 6000');
  const shot = async (name, eye, at, what) => {
    await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
    await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
    await L.settle(3000);
    const q = await L.call('dev.screenshot', { name: `irr_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
    const file = path.join(dir, `${name}.png`);
    fs.copyFileSync(q.path, file);
    log(`  shot ${name}`);
    shots.push({ name, what, eye, at, file: path.relative(OUT, file) });
  };
  const lots = o.r.ir.lots.filter((l) => l.irrigation);
  const xs = lots.flatMap((l) => [l.box.minX, l.box.maxX]), zs = lots.flatMap((l) => [l.box.minZ, l.box.maxZ]);
  const fy = lots[0].floorY;
  const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, fy, (Math.min(...zs) + Math.max(...zs)) / 2];
  await shot('both_farms', [mid[0] + 4, fy + 22, Math.max(...zs) + 18], mid, 'v62: both farms (f2 left, f1 right) after 5 minutes at default rules: every field moist; each source a 1x1 hole flush with the wheat, its four sides farmland; the farm ponds (farmPond) outside the boxes');
  for (const l of lots) {
    const b = l.box, c = [(b.minX + b.maxX) / 2, fy, (b.minZ + b.maxZ) / 2];
    await shot(`${l.id}_field`, [c[0] - 3, fy + 10, b.maxZ + 7], c, `${l.id}: its field from the street side (${l.irrigation.sources} source(s))`);
    const s = o.r.bodies.find((q) => q.id === l.irrigation.bodies[0]).cells[0];
    await shot(`${l.id}_source`, [s[0] + 2.5, fy + 2.6, s[2] + 3.5], [s[0] + 0.5, fy, s[2] + 0.5], `${l.id}: a source up close: water on the bed, moist farmland on four sides, wheat round it`);
  }
  fs.writeFileSync(path.join(dir, 'look.json'), `${JSON.stringify({ head: o.r.planId, shots }, null, 1)}\n`);
  ctx.check(shots.length >= 3, `look (recorded): ${shots.length} shots of v62's irrigated farms in ${path.relative(OUT, dir)}`);
  await L.leaveWorld();
  return { shots };
}
