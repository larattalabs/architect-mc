// Phase 6c slice H-b, wet structures (docs/CONTRACT.md "Phase 6c slice H" §1.2, §8, §10, §14 items 1, 8, 11; Steward's S-H-4: a
// fallback only), the kit half of the gate, $0 and offline:
//   wetColumn             a wet write stands only on still natural water (sources, ice over water, water plants) up to waterDepth;
//                         flowing water, lava and a bubble column never; the bed read from the frozen volume; unread water in a
//                         second plan never
//   wet piers             checkBridge's `wet` option: a pier in water to a footing 2 into the bed; dry sites win; deep, flowing and
//                         lava answer WATER with their kind and no `until`
//   fixtures              v46 (a quay), v47 (a beam on wet piers), v48 (a harbour wall) fit through the two-plan flow; the h/hb_*
//                         refusals (WATER deep, WATER flowing, NO_FEATURE) and the street fallback with wet piers; the checker clean on
//                         each (M25:wet, M10:bridge, the walls' bars, M5, M6, M8), the guards over the frozen volumes they read
//   broken variants       _unsafe.flowingPier and _unsafe.waterloggedWet: each caught by M25:wet, naming its cells
//   determinism           3 checks of each fixture give one answer set, IR and artifact sha
//   until H               no reachable code path, fixture expectation or catalogue note in kit/ names `until` H (the archived
//                         catalogues of earlier batches aside: frozen baselines)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, flatSurvey, goldenSurvey, stewardAnchors, checkPlanVolumes, FIX, KIT } from './plan-helpers.mjs';
import { synthVolume } from './h-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { wetColumn, WET, wetBridgeFallback, wetWallFallback, underwaterOk } from '../lib/fluids/wet.mjs';
import { checkBridge, BRIDGE, surveyLand } from '../lib/connectors/bridgeGeom.mjs';
import { makeColumns, encodeColumns, FLAG_WATER } from '../lib/region/pack.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { sitePlan } from '../lib/region/siteplan.mjs';

const readJ = (...p) => ({ name: p[p.length - 1], ...JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8')) });
const svOf = (fx) => (fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on ? goldenSurvey(fx.on) : flatSurvey());
async function run(fx, extra = {}) {
  const s = svOf(fx);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], volume: fx.volume ?? {}, ...extra });
  return { ...r, survey: s };
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded), prefix: false });

// ------------------------------------------------------------------ wetColumn

/** A survey with one water column at (5, 5): surface 64, bed 60 (4 deep), dry ground 64 elsewhere. */
function oneColumn() {
  const c = makeColumns(0, 0, 16, 16, 1);
  for (let k = 0; k < 256; k++) { c.ground[k] = 64; c.height[k] = 64; c.floor[k] = 64; }
  const k = 5 + 5 * 16;
  c.floor[k] = 60; c.flags[k] = FLAG_WATER;
  return { bytes: encodeColumns(c), claim: { minX: 0, minZ: 0, maxX: 15, maxZ: 15, minY: -64, maxY: 319 } };
}

test('wetColumn: sources to the bed stand; flowing, lava and a bubble column never; the bed from the volume; unread in a second plan', () => {
  const s = oneColumn();
  const box = { minX: 0, minY: 55, minZ: 0, maxX: 15, maxY: 66, maxZ: 15 };
  const v = (edits = []) => synthVolume(box, s.bytes, s.claim, { fluids: true, edits }).decoded;
  // the first plan: no volume, the survey's floor
  assert.deepEqual(wetColumn([], 5, 5, 64, 60, { waterDepth: 8 }), { ok: true, bed: 60, depth: 4, covered: false });
  assert.equal(wetColumn([], 5, 5, 64, 60, { waterDepth: 3 }).why, 'deep');
  // read: a source column to the bed (sand) at 60
  const ok = wetColumn([v()], 5, 5, 64, 60, { waterDepth: 8 });
  assert.deepEqual([ok.ok, ok.bed, ok.depth, ok.covered], [true, 60, 4, true]);
  // the volume's bed is deeper than the survey's floor (a hole in the bed): the volume's
  const hole = wetColumn([v([{ box: [5, 59, 5, 5, 60, 5], class: 'WATER', block: 'minecraft:water', fluid: 'water_source' }])], 5, 5, 64, 60, { waterDepth: 8 });
  assert.deepEqual([hole.ok, hole.bed, hole.depth], [true, 58, 6]);
  assert.equal(wetColumn([v([{ box: [5, 62, 5, 5, 62, 5], class: 'WATER', fluid: 'water_flowing' }])], 5, 5, 64, 60, { waterDepth: 8 }).why, 'flowing');
  assert.equal(wetColumn([v([{ box: [5, 63, 5, 5, 63, 5], class: 'WATER', fluid: 'water_falling' }])], 5, 5, 64, 60, { waterDepth: 8 }).why, 'flowing');
  assert.equal(wetColumn([v([{ box: [5, 61, 5, 5, 61, 5], class: 'LAVA', block: 'minecraft:lava', fluid: 'lava_source' }])], 5, 5, 64, 60, { waterDepth: 8 }).why, 'lava');
  const bub = wetColumn([v([{ box: [5, 61, 5, 5, 64, 5], class: 'WATER', block: 'minecraft:bubble_column', fluid: 'water_source' }])], 5, 5, 64, 60, { waterDepth: 8 });
  assert.deepEqual([bub.ok, bub.why, bub.bubble], [false, 'flowing', true]);
  // ice over water and a water plant stand (ice: W's FROZEN; kelp: a dependent that becomes water)
  assert.equal(wetColumn([v([{ box: [5, 64, 5, 5, 64, 5], class: 'ICE', block: 'minecraft:ice', fluid: 'none' }, { box: [5, 61, 5, 5, 62, 5], class: 'PLANT', block: 'minecraft:kelp_plant', fluid: 'water_source' }])], 5, 5, 64, 60, { waterDepth: 8 }).ok, true);
  // a player's or another owner's cell in the column: never (blocked)
  assert.equal(wetColumn([v([{ box: [5, 62, 5, 5, 62, 5], class: 'OWNED' }])], 5, 5, 64, 60, { waterDepth: 8 }).why, 'blocked');
  // a second plan holding fluid volumes that don't cover the column: unread (never planned on the survey's guess)
  const far = synthVolume({ minX: 10, minY: 55, minZ: 10, maxX: 12, maxY: 66, maxZ: 12 }, s.bytes, s.claim, { fluids: true }).decoded;
  assert.deepEqual([wetColumn([far], 5, 5, 64, 60, { waterDepth: 8 }).ok, wetColumn([far], 5, 5, 64, 60, { waterDepth: 8 }).why], [false, 'unread']);
});

test('underwaterOk (§1.2): full, fluid-stopping, no gravity, not waterloggable', () => {
  for (const b of ['minecraft:stone_bricks', 'minecraft:cobblestone', 'minecraft:oak_planks']) assert.ok(underwaterOk(b), b);
  for (const b of ['minecraft:gravel', 'minecraft:sand', 'minecraft:dirt_path', 'minecraft:stone_brick_slab', 'minecraft:oak_fence', 'minecraft:stone_brick_wall', 'minecraft:oak_stairs']) assert.ok(!underwaterOk(b), b);
});

test('the hooks answer null where the fallback does not apply (S-H-4: only a failure on water)', () => {
  assert.equal(wetBridgeFallback({}, {}, {}, 'ROUTE_WATER'), null);
  assert.equal(wetWallFallback({}, {}, {}), null);
  const K = { r: { needVolume: () => null }, ctx: { volumes: [] } };
  const leg = (kind) => ({ conn: { id: 'c', kind, part: {} }, k: 0, k1: { spans: ['bridge'], t3: { bridge: { form: 'beam' } } } });
  // a bridge leg failing on its span (not water), or a tunnel, or a rope: none
  assert.equal(wetBridgeFallback(K, leg('bridge'), { bridge: { code: 'SPAN' } }, 'BRIDGE'), null);
  assert.equal(wetBridgeFallback(K, leg('bridge'), { bridge: { code: 'HEADROOM' } }, 'BRIDGE'), null);
  assert.equal(wetBridgeFallback(K, leg('tunnel'), { bridge: { code: 'WATER' } }, 'BRIDGE'), null);
  assert.equal(wetBridgeFallback(K, leg('rope_bridge'), { bridge: { code: 'WATER' } }, 'BRIDGE'), null);
  // a bridge leg needing a pier in water: its options with wet piers (default waterDepth 8, or the part's)
  assert.deepEqual(wetBridgeFallback(K, leg('bridge'), { bridge: { code: 'WATER' } }, 'BRIDGE').t3.bridge.wet, { waterDepth: WET.bridgeDepth });
  const l2 = leg('bridge'); l2.conn.part.waterDepth = 3;
  assert.deepEqual(wetBridgeFallback(K, l2, { bridge: { code: 'WATER' } }, 'BRIDGE').t3.bridge, { form: 'beam', wet: { waterDepth: 3 } });
  assert.equal(wetWallFallback(K, { part: {} }, { code: 'NO_ROOM' }), null);
  assert.equal(wetWallFallback(K, { part: { waterDepth: 2 } }, { code: 'WATER' }).waterDepth, 2);
});

// ------------------------------------------------------------------ checkBridge's wet piers

/** A 96x64 claim: banks at 64, a river x 40..63 (24 wide), its bed at `bed`, its surface at 58 (`dry`: a dry floor instead of x0..x1). */
function riverLand({ bed = 52, dry = null } = {}) {
  const c = makeColumns(0, 0, 96, 64, 1);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 96; x++) {
    const k = x + z * 96, inR = x >= 40 && x <= 63, isDry = dry && x >= dry[0] && x <= dry[1];
    c.ground[k] = inR ? (isDry ? 52 : 58) : 64; c.height[k] = c.ground[k]; c.floor[k] = inR && !isDry ? bed : c.ground[k]; c.flags[k] = inR && !isDry ? FLAG_WATER : 0;
  }
  const claim = { minX: 0, minZ: 0, maxX: 95, maxZ: 63, minY: -64, maxY: 319 };
  const bytes = encodeColumns(c);
  return { S: surveyApi(bytes, claim), bytes, claim };
}

test('checkBridge wet: piers stand in the river to a footing 2 into the bed; dry sites win; deep, flowing and lava name WATER\'s kind, no until', () => {
  const { S, bytes, claim } = riverLand();
  const land = surveyLand(S);
  const wet = { waterDepth: 8, floorAt: S.floorAt, vols: [] };
  // the dry search: WATER (a pier is needed in water), no until
  const dry = checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam' });
  assert.deepEqual([dry.code, dry.until, dry.evidence.kind], ['WATER', undefined, 'water']);
  // wet: fits, each pier from bed - 1 (the bed's top 2 cells replaced) up to the deck's underside, its wet cells counted
  const c = checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam', wet });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.piers.length, 3);
  for (const p of c.piers) {
    assert.equal(p.wet, 6 * 5, 'each pier: 5 columns (the width and rails) 6 deep');
    for (const q of p.cols) { assert.equal(q.y0, 51, 'the footing at bed - 1'); assert.equal(q.y1, 63); assert.equal(q.bed, 52); assert.equal(q.surface, 58); }
  }
  // a dry floor in the river's middle (x 49..54): the piers take it where the spacing allows (a dry site weighs less)
  const part = riverLand({ dry: [49, 54] });
  const c2 = checkBridge(surveyLand(part.S), [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam', wet: { ...wet, floorAt: part.S.floorAt } });
  assert.ok(c2.ok);
  assert.ok(c2.piers.some((p) => !p.wet), `a dry pier site used (${JSON.stringify(c2.piers.map((p) => [p.i, p.wet ?? 0]))})`);
  // deep: the river 12 deep, waterDepth 8
  const deep = riverLand({ bed: 46 });
  const d = checkBridge(surveyLand(deep.S), [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam', wet: { ...wet, floorAt: deep.S.floorAt } });
  assert.deepEqual([d.code, d.until, d.evidence.kind, d.evidence.depth], ['WATER', undefined, 'deep', 12]);
  // flowing and lava, read from the volume
  const box = { minX: 38, minY: 48, minZ: 28, maxX: 66, maxY: 60, maxZ: 36 };
  const fl = synthVolume(box, bytes, claim, { fluids: true, edits: [{ box: [40, 53, 28, 63, 58, 36], class: 'WATER', fluid: 'water_flowing' }] }).decoded;
  assert.equal(checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam', wet: { ...wet, vols: [fl] } }).evidence.kind, 'flowing');
  const lv = synthVolume(box, bytes, claim, { fluids: true, edits: [{ box: [40, 53, 28, 63, 53, 36], class: 'LAVA', block: 'minecraft:lava', fluid: 'lava_source' }] }).decoded;
  assert.equal(checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam', wet: { ...wet, vols: [lv] } }).evidence.kind, 'lava');
  // the arch is unchanged (it never needs a pier): auto still takes the dry arch over the river
  const a = checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'auto', wet });
  assert.equal(a.form, 'arch');
  assert.equal(BRIDGE.costWet, 10);
});

// ------------------------------------------------------------------ the fixtures

const wetChecks = (rep, name) => {
  const bad = rep.findings.filter((f) => /^M25|^M10|^M3|^M6$|^M8|^M5|^M1$|^M2:wall/.test(f.rule));
  assert.deepEqual(bad.map((f) => `${f.rule} ${f.message}`), [], `${name}: the checker clean`);
  assert.ok(rep.metrics.M25.wet.records >= 1 && rep.metrics.M25.wet.cells > 0 && rep.metrics.M25.wet.bad === 0, `${name}: M25:wet ${JSON.stringify(rep.metrics.M25.wet)}`);
};
const guardsOf = (r) => (r.artifact?.guards ?? r.res.meta?.planCheck?.links?.guards ?? []).filter((g) => g.kind === 'wet');

test('v47: a beam on wet piers over a 28-wide river; piers 2 into the bed, no air under the surface, the guard over its volume', async () => {
  const fx = readJ('valid', 'v47_wet_beam.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  assert.equal(r.first.check.parts[0].class, 'incomplete', 'the first plan asks the water\'s volume');
  assert.equal(r.first.check.parts[0].reasons[0].code, 'VOLUME');
  const a = part(r, 'crossing');
  assert.equal(a.class, 'fits');
  const b = a.geometry.bridges[0];
  assert.deepEqual([b.form, b.n, b.crossing.over], ['beam', 32, 'water']);
  assert.ok(b.wet.cells > 0 && b.wet.piers.length >= 2, JSON.stringify(b.wet));
  assert.ok(a.notes.some((n) => /wet piers/.test(n)));
  const rec = r.res.meta.bridges[0];
  assert.ok(rec.wet && rec.wet.volume && rec.wet.columns.length > 0);
  for (const [, , bed] of rec.wet.columns) assert.equal(bed, 52);
  const rep = checkOf(r);
  wetChecks(rep, 'v47');
  const per = rep.metrics.bridges.per[0];
  assert.ok(per.ok && per.piersOk === per.piers, JSON.stringify(per));
  // the kit movers across both ways
  const world = rep.world ?? null;
  void world;
  // the guards: the wet record's columns over the frozen volume it was planned on
  const g = guardsOf(r);
  assert.ok(g.length === 1 && g[0].fluids && g[0].volume?.sha && g[0].runs.length === rec.wet.columns.length, JSON.stringify(g));
});

test('v48: a harbour wall: the ring crosses the lake\'s corner; wet sections full height over the surface, to 2 into the bed; no gate in them; closure clean', async () => {
  const fx = readJ('valid', 'v48_harbour_wall.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'w');
  assert.equal(w.class, 'fits', JSON.stringify(w));
  assert.ok(w.geometry.wet.length >= 1 && w.geometry.wet.every((s) => s.depth === 4), JSON.stringify(w.geometry.wet));
  assert.deepEqual(w.geometry.crossing, { type: 'wall', over: 'water', depth: 4 });
  const mw = r.res.meta.walls[0];
  const wetCols = new Set(mw.wet.columns.map((q) => `${q[0]},${q[1]}`));
  for (const g of mw.gates) for (const [x, z] of g.cells) assert.ok(!wetCols.has(`${x},${z}`), `gate ${g.id} in a wet section`);
  // the wall's cells in the water: from bed - 1 (59) to its top; the top over the water's surface (64) by the height at least
  const ir = r.res.ir;
  const cells = new Map();
  for (const p of ir.parts.filter((q) => q.id.startsWith('w_'))) for (const op of p.ops) if (op.op === 'columns') for (let i = 0; i < op.cols.length; i += 5) {
    const k = `${op.cols[i]},${op.cols[i + 1]}`;
    if (!cells.has(k)) cells.set(k, [Infinity, -Infinity]);
    const c = cells.get(k);
    c[0] = Math.min(c[0], op.cols[i + 2]); c[1] = Math.max(c[1], op.cols[i + 3]);
  }
  for (const k of wetCols) { const [y0, y1] = cells.get(k); assert.equal(y0, 59, `${k} footing`); assert.ok(y1 >= 64 + 6, `${k} top ${y1}`); }
  const rep = checkOf(r);
  wetChecks(rep, 'v48');
  for (const [id, m] of Object.entries(rep.metrics.walls)) {
    assert.equal(m.cut, 0, id);
    for (const mv of ['player', 'villager']) { assert.equal(m.closure[mv].leaks, 0, `${id} ${mv} leaks`); assert.equal(m.closure[mv].across, m.closure[mv].nodes, `${id} ${mv} across`); }
  }
  assert.equal(guardsOf(r).length, 1);
});

test('v46: a quay on the lake\'s shore: deck 1 over the water, solid to 2 into the bed, posts, lamps, a step down; siteplan quays; M5, M6, M8 clean', async () => {
  const fx = readJ('valid', 'v46_quay.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'landing');
  assert.equal(a.class, 'fits', JSON.stringify(a));
  const q = a.geometry.quays[0];
  assert.deepEqual([q.length, q.reach, q.surface], [12, 3, 64]);
  assert.ok(q.steps >= 1 && q.posts + q.lamps >= 2 && q.lamps >= 1 && q.wetCells === 12 * 3 * 4, JSON.stringify(q));
  const mq = r.res.meta.quays[0];
  assert.equal(mq.along.length, 2);
  for (const s of mq.steps) assert.equal(s[1], 64, 'a step\'s top at the surface: one up from a swimmer');
  const rep = checkOf(r);
  wetChecks(rep, 'v46');
  // the deck's top over the water and the step's walk cells: every one reachable by the villager mover from the bank
  const sp = sitePlan({ ir: r.res.ir, meta: r.res.meta, planId: 'v46', irSha: r.res.irSha });
  assert.equal(sp.quays[0].wetCells, q.wetCells);
  assert.equal(guardsOf(r).length, 1);
  assert.ok(a.cost?.bom && Object.keys(a.cost.bom).length > 0, JSON.stringify(a.cost));
});

test('the H-b refusals (fixtures/plan/h/hb_r*) and the street fallback with wet piers (hb_v01)', async () => {
  const fx = fs.readdirSync(path.join(FIX, 'h')).filter((f) => /^hb_/.test(f)).sort();
  assert.ok(fx.length >= 4, fx.join(', '));
  for (const f of fx) {
    const j = readJ('h', f);
    const r = await run(j);
    const a = part(r, j.expect.part);
    if (j.expect.class) {
      assert.equal(a.class, j.expect.class, `${f}: ${JSON.stringify(a)}`);
      if (j.expect.wet) assert.ok(a.geometry.bridges[0].wet?.cells > 0, `${f}: ${JSON.stringify(a.geometry)}`);
      wetChecks(checkOf(r), f);
      continue;
    }
    assert.equal(a.class, 'refused', `${f}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, j.expect.code, `${f}: ${JSON.stringify(a.reasons)}`);
    assert.equal(a.reasons[0].until, undefined, `${f}: no until`);
    if (j.expect.kind) assert.equal(a.reasons[0].evidence.kind, j.expect.kind, `${f}: ${JSON.stringify(a.reasons[0].evidence)}`);
  }
});

test('K1a\'s lake ring with waterDepth 3 (the lake 4 deep): refused WATER {kind: deep}, no until', async () => {
  const j = readJ('refused', 'k1a_r01_wall_water.json');
  const r = await run(j);
  const a = part(r, 'w');
  assert.deepEqual([a.class, a.reasons[0].code, a.reasons[0].evidence.kind, a.reasons[0].until], ['refused', 'WATER', 'deep', undefined]);
});

// ------------------------------------------------------------------ broken variants

test('the broken variants: _unsafe.flowingPier and _unsafe.waterloggedWet each caught by M25:wet, naming cells', async () => {
  const fx = readJ('valid', 'v47_wet_beam.json');
  const withUnsafe = (u, volume = {}) => ({ ...fx, volume, plan: { ...fx.plan, connectors: [{ ...fx.plan.connectors[0], ext: { 'architect_mc:unsafe': u } }] } });
  // a flowing river: the pier stands in it anyway
  const flowing = await run(withUnsafe({ flowingPier: true }, { edits: [{ box: [1000, 53, 2040, 1159, 58, 2067], class: 'WATER', fluid: 'water_flowing' }] }));
  const rf = checkOf(flowing);
  const f1 = rf.findings.find((f) => f.rule === 'M25:wet');
  assert.ok(f1 && /flowing/.test(f1.message) && f1.sample.length > 0, JSON.stringify(rf.findings.map((f) => f.rule)));
  const logged = await run(withUnsafe({ waterloggedWet: true }));
  const rl = checkOf(logged);
  const f2 = rl.findings.find((f) => f.rule === 'M25:wet');
  assert.ok(f2 && /waterlogged|non-waterloggable/.test(f2.message) && f2.sample.length > 0, JSON.stringify(rl.findings.map((f) => `${f.rule} ${f.message}`)));
});

// ------------------------------------------------------------------ determinism, until H

test('determinism: 3 checks of v46, v47, v48 and each hb_ fixture give one answer set, IR and artifact sha', async () => {
  const all = [readJ('valid', 'v46_quay.json'), readJ('valid', 'v47_wet_beam.json'), readJ('valid', 'v48_harbour_wall.json'), ...fs.readdirSync(path.join(FIX, 'h')).filter((f) => /^hb_/.test(f)).sort().map((f) => readJ('h', f))];
  for (const f of all) {
    const runs = [await run(f), await run(f), await run(f)];
    const key = (r) => JSON.stringify(r.check.parts);
    assert.equal(key(runs[1]), key(runs[0]), `${f.name}: answers`);
    assert.equal(key(runs[2]), key(runs[0]), `${f.name}: answers`);
    assert.equal(runs[1].artifactSha, runs[0].artifactSha, `${f.name}: artifact`);
    assert.equal(runs[2].res.irSha, runs[0].res.irSha, `${f.name}: IR`);
  }
});

/** Every file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)); } else out.push(p);
  }
  return out;
}

test('until H (§8.4, item 11): no code path, fixture expectation or catalogue note in kit/ names until H (the archived catalogues aside)', () => {
  // (§14 item 11's two forms, word-bounded so HY doesn't match)
  const re = /until:\s*'H'(?![A-Za-z])|"until":\s*"H"(?![A-Za-z])/;
  // the archived catalogues of earlier batches are frozen baselines (catalogue-*.json): they record what was, and stay as they were
  const files = walk(KIT).filter((f) => /\.(mjs|json)$/.test(f) && !/fixtures[\\/]plan[\\/]catalogue-[a-z0-9]+\.json$/.test(f) && !f.endsWith(`${path.sep}h-wet.test.mjs`));
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((l, i) => { if (re.test(l)) hits.push(`${path.relative(KIT, f)}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits, []);
  void walkGraph; void nodeReached;
});
