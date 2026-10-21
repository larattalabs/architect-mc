// (6c RS) The in-game half of slice RS's gate (docs/CONTRACT.md "Phase 6c slice RS" §13): the survival base world, the lot designs, a
// fixture's site (its terrain over the flat base, its sand), Regions.checkPlan and realiseApproved in survival, the stockpile and its
// feeding, the INSTANT twin (the same plan realised in a creative world, its box snapshotted), the conservation sum, removal and the
// survival region's state (dev.rs.*). Used by tools/gate6crs.mjs; every item is a function of `ctx` and runs on a fresh world copy.
import fs from 'node:fs';
import path from 'node:path';

export const OWNER = 'test:rs';
/** The survival base: the flat preset, survival, cheats, exact rules, the survival toggle on (made by the host that runs it). */
export const SURV = 'G6B RS Survival';
/** The creative twin's base (gate6b's flat base). */
export const FLAT = 'G6B Flat Base';

const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
export const same = (a, b) => { for (const x of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) if ((a?.[x] ?? 0) !== (b?.[x] ?? 0)) return false; return true; };
export const minus = (a, b) => { const o = {}; for (const x of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) { const d = (a?.[x] ?? 0) - (b?.[x] ?? 0); if (d) o[x] = d; } return o; };
export const plus = (a, b) => { const o = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b ?? {})) o[k] = (o[k] ?? 0) + v; for (const k of Object.keys(o)) if (!o[k]) delete o[k]; return o; };

/** The survival base world, made once per host (its stamp names the host, as gate6cy's base). */
export async function survivalBase(ctx) {
  const { L } = ctx;
  const mark = path.join(L.SAVES, SURV, 'gate6crs-base.json');
  const host = (await import('./basestamp.mjs')).gateHost();
  let made = null;
  try { made = JSON.parse(fs.readFileSync(mark, 'utf8')); } catch { made = null; }
  if (made?.host === host) return SURV;
  await L.leaveWorld();
  fs.rmSync(path.join(L.SAVES, SURV), { recursive: true, force: true });
  await L.openWorld(SURV, { mode: 'survival', preset: 'flat', seed: '2026102000', cheats: true });
  await L.setRules('exact');
  await L.call('dev.survival.set', { on: true });
  await L.cmd('/kill @e[type=!minecraft:player]');
  await L.cmd('/save-all flush');
  await L.leaveWorld();
  fs.writeFileSync(mark, JSON.stringify({ made: new Date().toISOString(), host }));
  return SURV;
}

// ------------------------------------------------------------------ the lot designs

/** rs_hut (7x5x9: planks, cobblestone floor, a door, glass, a torch, one copper block in its back wall: item 9's weathered cell) and rs_shed (cobblestone, a door, a lantern): small bills. */
export async function designs(ctx) {
  const { Blueprint, palette } = await ctx.imp('lib/kit.mjs');
  const { writeBlueprint } = await ctx.imp('lib/write.mjs');
  const p = palette({});
  const make = (id, wall) => {
    const X = 6, Z = 4, H = 4;
    const bp = new Blueprint({ id, name: id, description: `RS ${id}`, type: 'custom', profile: ['door', 'lit'], size: [X + 1, H + 1, Z + 5], origin: [0, 0, 0], groundY: 1, front: 'south', palette: p, approach: false, interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
    bp.part('main', () => bp.room([0, 0, 0, X, H, Z], { wall, floor: 'minecraft:cobblestone', ceiling: 'minecraft:oak_planks', corners: 'minecraft:oak_log' }));
    bp.part('openings', () => { bp.door(3, 1, Z, 'south'); bp.set(1, 2, Z, 'minecraft:glass_pane'); bp.set(5, 2, Z, 'minecraft:glass_pane'); bp.set(3, 3, 1, 'minecraft:wall_torch', { facing: 'south' }); if (id === 'rs_hut') bp.set(3, 3, 0, 'minecraft:copper_block'); });
    bp.part('approach', () => bp.floor(2, Z + 1, 4, Z + 4, 0, 'minecraft:gravel'));
    bp.spot('entrance', 3, Z + 1, 180);
    bp.spot('spawn', 3, Z + 3, 180);
    return bp;
  };
  for (const [id, wall] of [['rs_hut', 'minecraft:oak_planks'], ['rs_shed', 'minecraft:cobblestone']]) {
    const dir = path.join(ctx.L.LIBRARY, id);
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(make(id, wall), dir);
  }
  await ctx.L.cmd('/architect reload');
  await ctx.L.settle(1500);
}

// ------------------------------------------------------------------ the site of a fixture

/** A fixture by its path under kit/test/fixtures/plan (rs/ by default). */
export function fixture(ctx, name) {
  const rel = name.includes('/') ? name : `rs/${name}`;
  return JSON.parse(fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'plan', rel.endsWith('.json') ? rel : `${rel}.json`), 'utf8'));
}

/**
 * A fresh world (a copy of the survival base, or with `creative` of the flat creative base), exact rules, the fixture's terrain built over
 * the flat base, its sand bands (`fx.sand`: kit boxes, the volume's LOOSE edits) placed: {W, wp, world}.
 */
export async function site(ctx, tag, fx, { creative = false, rules = 'exact' } = {}) {
  const { L, B } = ctx;
  const world = `G6B RS ${creative ? 'T' : 'S'} ${tag}`.slice(0, 60);
  if (creative) await L.ensureBase(FLAT);
  else await survivalBase(ctx);
  await L.fresh(world, creative ? FLAT : SURV);
  await L.setRules(rules);
  await L.cmd('/weather clear');
  const T = B.terrainOf(fx);
  const W = await B.buildTerrain(ctx, T);
  for (const b of fx.sand ?? []) {
    const box = [b[0] + W.dx, b[1] + W.off, b[2] + W.dz, b[3] + W.dx, b[4] + W.off, b[5] + W.dz];
    await L.cmd(`/fill ${box.join(' ')} minecraft:sand`);
  }
  const wp = await B.worldPlan(ctx, fx, W);
  if (fx.game && ctx.subst) wp.plan = JSON.parse(JSON.stringify(wp.plan).replaceAll('${region}', ctx.subst.region ?? ''));
  await L.settle(1500);
  return { W, wp, world, T };
}

/** The snapshot box of a site: the claim and 8 round it, 8 under its lowest ground to 40 over its highest. */
export const boxOf = (W) => [W.claim[0] - 8, W.minY - 8, W.claim[1] - 8, W.claim[2] + 8, W.maxY + 40, W.claim[3] + 8];

export async function snap(ctx, box, name) {
  const file = path.join(ctx.OUT, `${name}.snap.gz`);
  await ctx.L.call('dev.region.hash', { box, mode: 'snap', file }, 3_600_000);
  return file;
}
export async function diff(ctx, box, file, limit = 20000) {
  const r = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file, limit }, 3_600_000);
  return { mismatches: r.mismatches, classes: r.classes ?? {}, list: r.list ?? [] };
}

/** Regions.checkPlan (load generate) over the site; the answer saved as <tag>-check.json. */
export async function check(ctx, tag, s) {
  const ck = await ctx.L.call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
  fs.writeFileSync(path.join(ctx.OUT, `rs-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  return ck;
}

/** The owner's stockpile: `n` crates in a row west of the claim's north-west corner, on the ground. */
export async function pile(ctx, s, n = 3) {
  const y = s.W.off + (s.T?.y ?? 64) + 1; // over the base's grass (terrainOf's y), outside the claim's bands
  if (s.T?.bands?.some((b) => b.x0 <= s.W.claim[0] - s.W.dx - 6 && s.W.claim[0] - s.W.dx - 6 + 2 * n <= b.x1 && b.z0 <= s.W.claim[1] - s.W.dz - 6 && s.W.claim[1] - s.W.dz - 6 <= b.z1)) throw new Error('pile: a band under the crates');
  const crates = Array.from({ length: n }, (_, k) => [s.W.claim[0] - 6 + 2 * k, y, s.W.claim[1] - 6]);
  const c = await ctx.L.call('dev.stockpile.create', { owner: OWNER, crates }, 120_000);
  if (c.refused) throw new Error(`createStockpile refused: ${JSON.stringify(c.refused)}`);
  return crates;
}

export const pileState = async (ctx) => (await ctx.L.call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile ?? {};
export const rsState = async (ctx, region) => ctx.L.call('dev.rs.state', { region }, 120_000);
export const regionState = async (ctx, region) => ctx.L.call('dev.region.state', { region }, 60_000);

/** realiseApproved with the lot entries; returns the region id (or throws with the refusal). */
export async function realise(ctx, sha, entries = {}) {
  const rr = await ctx.L.call('dev.region.realiseApproved', { sha, ...(Object.keys(entries).length ? { lotEntries: entries } : {}) }, 300_000);
  if (!rr.region) {
    const e = new Error(`realiseApproved refused: ${JSON.stringify(rr.refused ?? rr)}`);
    e.refused = rr.refused ?? rr;
    throw e;
  }
  return rr.region;
}

/** Kills mobs that wait in a body's box or a lot (scenarios' rule). */
async function shoo(ctx, st) {
  if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await ctx.L.cmd('/kill @e[type=!minecraft:player]');
}

/**
 * Feeds the owner's stockpile what its targets still lack (outstanding less stock), `fraction` of it each wave (at least one of each item),
 * until `until(st, rs)` holds or `timeoutMs` passes; each wave's insert goes through `cons` when given (the conservation sum).
 * Returns {waves, inserted, last: {st, rs}}.
 */
export async function feed(ctx, region, { cons = null, fraction = 1, until = (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs = 1_800_000, every = 3000, onWave = null, extra = null } = {}) {
  const { L } = ctx;
  const end = Date.now() + timeoutMs;
  let waves = 0, inserted = {};
  let st, rs;
  while (Date.now() < end) {
    st = await regionState(ctx, region);
    rs = await rsState(ctx, region);
    await shoo(ctx, st);
    if (until(st, rs)) break;
    if (['FAILED', 'PARTIAL'].includes(st.view.state)) break;
    const ps = await pileState(ctx);
    const need = {};
    for (const [it, n] of Object.entries(plus(ps.outstanding, extra ? await extra() : {}))) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = fraction >= 1 ? lack : Math.max(1, Math.floor(lack * fraction));
    }
    if (Object.keys(need).length) {
      const acc = cons ? await cons.insert(`stockpile:${OWNER}`, need) : (await L.call('dev.crate.insert', { site: `stockpile:${OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
      inserted = plus(inserted, acc);
      waves++;
      if (onWave) await onWave(waves, need, acc);
    }
    await L.sleep(every);
  }
  return { waves, inserted, last: { st, rs } };
}

/** Waits for a predicate over the region's state and rs state (polls every `every` ms). */
export async function waitFor(ctx, region, pred, { timeoutMs = 600_000, every = 2000 } = {}) {
  const end = Date.now() + timeoutMs;
  let st, rs;
  while (Date.now() < end) {
    st = await regionState(ctx, region);
    rs = await rsState(ctx, region);
    await shoo(ctx, st);
    if (pred(st, rs)) return { st, rs, ok: true };
    await ctx.L.sleep(every);
  }
  return { st, rs, ok: false };
}

/** Regions.remove, waited for (REMOVED, PARTIAL or FAILED, or the record gone). */
export async function remove(ctx, region) {
  const { L } = ctx;
  const r = await L.call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 1800; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || ['REMOVED', 'PARTIAL', 'FAILED'].includes(s)) break;
    await L.sleep(1000);
  }
  await L.settle(2000);
  return r;
}

// ------------------------------------------------------------------ the INSTANT twin

/**
 * The fixture's INSTANT twin: a creative flat world, the same terrain and plan, checked and realised there (INSTANT) with the same lot
 * entries, waited for PLACED, the box snapshotted: {file, box, view}. Kept per fixture for the step (one twin per site).
 */
export async function twin(ctx, tag, fx, entries = {}) {
  const s = await site(ctx, `${tag} twin`, fx, { creative: true });
  if (Object.keys(entries).length) await designs(ctx);
  const ck = await check(ctx, `${tag}-twin`, s);
  if (!ck.check?.artifactSha) throw new Error(`twin ${tag}: no artifact (${ck.check?.overall})`);
  const region = await realise(ctx, ck.check.artifactSha, entries);
  const st = await ctx.L.waitRegion(region, 3_600_000, (x) => shoo(ctx, x));
  const box = boxOf(s.W);
  const file = await snap(ctx, box, `rs-${tag}-twin`);
  return { file, box, view: st.view, region, check: ck };
}

/** A survival world's diff from its twin's snapshot, the stockpile's crates (and items lying about) set aside. */
export async function twinDiff(ctx, box, file, crates) {
  const d = await diff(ctx, box, file);
  const crateCells = new Set(crates.map((c) => c.join(',')));
  const rest = d.list.filter((m) => !crateCells.has(m.pos) && !String(m.now).startsWith('architect_mc:construction_crate'));
  fs.writeFileSync(`${file}.diff.json`, `${JSON.stringify(rest)}\n`); // the whole list, for the evidence
  return { mismatches: d.mismatches - (d.list.length - rest.length), list: rest.slice(0, 16), all: d.mismatches };
}

// ------------------------------------------------------------------ the conservation sum (Y1's, gate6cy's Conservation)

export class Conservation {
  constructor(ctx, box) {
    this.ctx = ctx;
    this.area = { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] };
    this.injected = {};
    this.cleared = {};
    this.base = null;
    this.points = [];
  }
  add(m, into) { for (const [k, v] of Object.entries(m ?? {})) into[k] = (into[k] ?? 0) + v; }
  async parts() { return this.ctx.L.call('dev.stockpile.audit', { owner: OWNER, min: this.area.min, max: this.area.max }, 120_000); }
  total(a) {
    const t = {};
    for (const m of [a.inventory, a.containers, a.entities, a.stock, a.paidStanding, a.legacyCrateStock, this.cleared]) this.add(m, t);
    for (const [k, v] of Object.entries(this.injected)) t[k] = (t[k] ?? 0) - v;
    for (const k of Object.keys(t)) if (t[k] === 0) delete t[k];
    return t;
  }
  async start() { const a = await this.parts(); this.base = this.total(a); return a; }
  async point(label) {
    const a = await this.parts();
    const t = this.total(a);
    const d = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(this.base)])) { const x = (t[k] ?? 0) - (this.base[k] ?? 0); if (x) d[k] = x; }
    const p = { label, diff: d, identity: a.identity !== false, stock: sum(a.stock), paid: sum(a.paidStanding), entities: sum(a.entities), injected: sum(this.injected), fluid: a.fluidStanding ?? null, t: a.gameTime };
    this.points.push(p);
    return p;
  }
  async insert(target, items) {
    const r = await this.ctx.L.call('dev.crate.insert', { site: target, items, exact: true }, 120_000);
    this.add(r.accepted ?? {}, this.injected);
    return r.accepted ?? {};
  }
}
export const exact = (p) => Object.keys(p.diff).length === 0 && p.identity;

// ------------------------------------------------------------------ a fixture's bills (item 3)

/** Per part: the check's cost.survival.bom and the targets' bills at put-down (dev.rs.state targets[].bom), summed per part. */
export function billsOf(ck, rs) {
  const want = {};
  for (const a of ck.check?.parts ?? []) if (a.cost?.survival) want[a.part] = a.cost.survival.bom;
  const got = {};
  for (const t of rs.targets ?? []) got[t.part] = plus(got[t.part], t.bom);
  // the region's own cells whole (a helper group such as __lamps__ has no part answer): the plan's cost.bom less the game's road and lot
  // bills (bomParts), against every target's bill
  let region = { ...(ck.check?.cost?.bom ?? {}) };
  for (const b of Object.values(ck.check?.cost?.bomParts ?? {})) region = minus(region, b);
  for (const k of Object.keys(region)) if (!region[k]) delete region[k];
  let all = {};
  for (const t of rs.targets ?? []) all = plus(all, t.bom);
  all = plus(all, rs.record?.charged); // what the fluids gate charged (a lava bucket per lava source, a grate's iron bars)
  want.__region__ = region;
  got.__region__ = all;
  return { want, got };
}

// ------------------------------------------------------------------ (batch v0.41.0) RP's realised record of a survival region

/**
 * The region's realised record (dev.region.realised, RP) read against its targets (dev.rs.state): UNFINISHED cells in the records, the
 * cells of the targets not BUILT, which targets' sites the records list. With `verify`, RP's verify (journal and world) too.
 * The wiring: a target's cells are UNFINISHED from put-down; when it is BUILT they are WRITTEN and its site is in its tile's record.
 */
export async function rpRecord(ctx, region, { verify = false } = {}) {
  const rp = await ctx.L.call('dev.region.realised', { region, ...(verify ? { verify: true, world: true } : {}) }, 1_800_000);
  const rs = await rsState(ctx, region);
  const tiles = rp.tiles ?? [];
  const count = (k) => tiles.reduce((a, t) => a + (t.codes?.[k] ?? 0), 0);
  const sites = new Set(tiles.flatMap((t) => String(t.site ?? '').split(',').filter(Boolean)));
  const targets = rs.targets ?? [];
  const built = targets.filter((t) => t.done);
  const open = targets.filter((t) => !t.done);
  return {
    tiles: tiles.length, unfinished: count('UNFINISHED'), written: count('WRITTEN'), targets: targets.length, built: built.length, open: open.length,
    openCells: open.reduce((a, t) => a + (t.cells ?? NaN), 0), builtListed: built.filter((t) => sites.has(t.target)).length,
    openListed: open.filter((t) => sites.has(t.target)).map((t) => t.target), statuses: [...new Set(tiles.map((t) => t.status))],
    ...(verify ? { verify: rp.verify && { ok: rp.verify.ok, unrecorded: rp.verify.unrecorded, targetsBuilding: rp.verify.targetsBuilding, notHeld: rp.verify.notHeld, cellsChecked: rp.verify.cellsChecked, placingLeftover: rp.verify.placingLeftover, problems: (rp.verify.problems ?? []).slice(0, 10) } } : {}),
  };
}

/** The half-built check (UNFINISHED on the unbuilt targets, WRITTEN with their site listed on the built ones); returns [ok, message]. */
export function rpHalf(tag, r) {
  const ok = r.tiles > 0 && r.open > 0 && r.unfinished === r.openCells && r.builtListed === r.built && r.openListed.length === 0;
  return [ok, `RP (${tag}, half built): the realised record holds the targets' cells UNFINISHED until built: ${r.unfinished} UNFINISHED = the ${r.openCells} cells of the ${r.open} target(s) not built; ${r.builtListed} of the ${r.built} built target(s) listed as their tile's entries (their cells WRITTEN), ${r.openListed.length} unbuilt listed; ${r.tiles} tile record(s), ${r.written} WRITTEN`];
}

/** The built check (after build.done: nothing UNFINISHED, every target listed, RP's verify agrees); returns [ok, message]. */
export function rpDone(tag, r) {
  const v = r.verify ?? {};
  const ok = r.tiles > 0 && r.unfinished === 0 && r.open === 0 && r.builtListed === r.built && v.ok === true && v.targetsBuilding === 0 && v.unrecorded === 0;
  return [ok, `RP (${tag}, build.done): ${r.unfinished} UNFINISHED, ${r.builtListed} of ${r.built} built target(s) listed; dev.region.realised verify ok ${v.ok} (unrecorded ${v.unrecorded}, targets building ${v.targetsBuilding}, ${v.cellsChecked} cells checked against the world, ${v.notHeld} not held${(v.problems ?? []).length ? `; ${v.problems.join(' | ').slice(0, 400)}` : ''})`];
}
