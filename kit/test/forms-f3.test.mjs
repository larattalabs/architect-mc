// Phase 6c slice F3 (docs/CONTRACT.md "Phase 6c slice F3: forms II" §3, §4, §5, §7, §10 items 2, 7, 8, 9): the grown forms in a plan.
// Every valid F3 fixture fits, its region check clean (M18, M19, M25:clear 0; lint STATE clean); every f3/r* answers its code; each broken
// variant (f3/u*) is caught; a form's column mask keeps 8 off natural trees, lot boxes + 1 and every street; catalogue 11 against
// catalogue 9 (archived as catalogue-vocc.json) is exactly F3's diff; M18's rule on a hand-made world.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, checkPlanVolumes, flatSurvey, goldenSurvey, asksSurvey, stewardAnchors } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { diffCatalogues, planCatalogue } from '../lib/plan/catalogue.mjs';
import { eachColumn } from '../lib/forms/states.mjs';
import { formRules, leafDistances } from '../lib/region/checkForms.mjs';
import { asColumns, FLAG_TREE } from '../lib/region/pack.mjs';

const read = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));

/** A fixture through the two-plan flow, then the region check over its IR. */
async function run(fx, plan = fx.plan) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const r = await checkPlanVolumes(plan, { volume: fx.volume ?? {}, survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, keepOut: fx.keepOut ?? [] });
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v), meta: r.res.meta });
  return { r, rep, s, part: (id) => r.check.parts.find((p) => p.part === id) };
}
const cache = new Map();
const of = (rel) => { if (!cache.has(rel)) cache.set(rel, run(read(rel))); return cache.get(rel); };
const ruleOf = (rep, rule) => rep.findings.filter((f) => f.rule === rule);
const F3_VALID = ['valid/v72_f3_grove.json', 'valid/v74_f3_roots_bank.json', 'valid/v75_f3_stalactites.json', 'valid/v77_f3_nether.json'];

test('item 2: every valid F3 fixture fits, its check clean of M18, M19, M25:clear, M3 (no floating cell)', async () => {
  for (const rel of F3_VALID) {
    const { r, rep } = await of(rel);
    assert.equal(r.check.overall, 'READY', rel);
    for (const a of r.check.parts) assert.ok(['fits', 'adjusted'].includes(a.class), `${rel} ${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? [])}`);
    for (const rule of ['M18', 'M19', 'M25:clear', 'M3', 'M1', 'M13']) assert.deepEqual(ruleOf(rep, rule).map((f) => [f.part, f.count]), [], `${rel}: ${rule}`);
    assert.equal(rep.metrics.M18.decaying, 0);
    assert.equal(rep.metrics.M18.distanceOff, 0, `${rel}: every written leaf's distance is vanilla's (item 8)`);
    // every F3 form baked, its column mask in the IR
    const f3 = (r.res.ir.forms ?? []).filter((f) => ['giantTree', 'giantMushroom', 'stalactites', 'roots'].includes(f.generator));
    assert.ok(f3.length > 0, rel);
    for (const f of f3) { assert.ok(f.baked?.cells > 0, `${f.id} baked`); assert.ok(Array.isArray(f.columns) && f.columns.length % 3 === 0 && f.columns.length > 0, `${f.id} columns`); }
  }
});

test('§3.1, §3.2: a grown form keeps 8 off natural trees, its columns off every lot box + 1, every street and path, and every other form', async () => {
  const { r, s } = await of('valid/v72_f3_grove.json');
  const ir = r.res.ir;
  const cols = asColumns(s.bytes);
  const f3 = ir.forms.filter((f) => f.columns);
  const lotCols = new Set();
  for (const l of ir.lots ?? []) { const b = l.box; for (let x = b.minX - 1; x <= b.maxX + 1; x++) for (let z = b.minZ - 1; z <= b.maxZ + 1; z++) lotCols.add(`${x},${z}`); }
  // the plan's paths and roads (path parts' op bounds): no canopy over them
  const pathCols = new Set();
  for (const p of ir.parts.filter((q) => q.set === 'path')) for (const o of p.ops) if (o.op === 'columns') for (let i = 0; i < o.cols.length; i += 5) pathCols.add(`${o.cols[i]},${o.cols[i + 1]}`);
  for (const f of f3) {
    eachColumn(f.columns, (x, z) => {
      assert.ok(!lotCols.has(`${x},${z}`), `${f.id}: column ${x},${z} in a lot box + 1`);
      assert.ok(!pathCols.has(`${x},${z}`), `${f.id}: column ${x},${z} over a path`);
    });
    for (const g of f3) if (g !== f) eachColumn(f.columns, (x, z) => eachColumn(g.columns, (a, b) => assert.ok(Math.max(Math.abs(a - x), Math.abs(b - z)) > 2, `${f.id} and ${g.id} within 2`)));
  }
  // r03: natural trees ring the stone; the oak moved out, every column 8 or more from every tree column
  const r3 = await of('f3/r03_tree_near_natural.json');
  const a3 = r3.part('oak');
  assert.equal(a3.class, 'adjusted');
  assert.ok(a3.deviations.some((d) => d.what === 'move' && d.value > 0), JSON.stringify(a3.deviations));
  const c3 = asColumns(r3.s.bytes);
  const trees = [];
  for (let j = 0; j < c3.depth; j++) for (let i = 0; i < c3.width; i++) if (c3.flags[i + j * c3.width] & FLAG_TREE) trees.push([c3.minX + i, c3.minZ + j]);
  assert.equal(trees.length, 24);
  let near = Infinity;
  for (const f of r3.r.res.ir.forms.filter((q) => q.columns)) eachColumn(f.columns, (x, z) => { for (const [tx, tz] of trees) near = Math.min(near, Math.max(Math.abs(tx - x), Math.abs(tz - z))); });
  assert.ok(near >= 8, `the nearest natural tree column is ${near} from the oak's mask`);
  void cols;
});

test('item 7 (KC): r04 refuses the tree NO_ROOM and the pond stands; u01 (the tree in a body, unsafe) is named by M25:clear, the fountain fits', async () => {
  const r4 = await of('f3/r04_tree_in_pond_band.json');
  assert.equal(r4.part('oak').class, 'refused');
  assert.equal(r4.part('oak').reasons[0].code, 'NO_ROOM');
  assert.ok(['fits', 'adjusted'].includes(r4.part('pool').class));
  // alone, on the same claim, the oak fits: the pond's footprint is what holds it off
  const fx = read('f3/r04_tree_in_pond_band.json');
  const alone = await run(fx, { ...fx.plan, forms: fx.plan.forms.filter((f) => f.id === 'oak') });
  assert.equal(alone.part('oak').class, 'fits');
  const u1 = await of('f3/u01_tree_in_body.json');
  assert.equal(u1.part('fount').class, 'fits');
  const clear = ruleOf(u1.rep, 'M25:clear');
  assert.ok(clear.some((f) => f.part === 'f_oak_1' && f.severity === 'error'), JSON.stringify(clear.map((f) => [f.part, f.count])));
  // every valid fixture: M25:clear 0 (above)
});

test('§4, §10.1: the broken variants: leafNotPersistent -> M18, mushroomFaces -> lint STATE', async () => {
  const u2 = await of('f3/u02_leaf_not_persistent.json');
  assert.ok(ruleOf(u2.rep, 'M18').some((f) => f.part === 'f_oak_1' && f.count > 0 && f.severity === 'warning'));
  assert.equal(u2.rep.metrics.M18.persistent, 0);
  const u3 = await of('f3/u03_mushroom_faces.json');
  assert.equal(u3.part('red').class, 'refused');
  assert.match(u3.part('red').reasons[0].message, /STATE: /);
});

test('M18: vanilla\'s distance on a hand-made world (through leaves only, from #logs, capped 7); persistent leaves never decay', () => {
  const w = new Map();
  const put = (x, y, z, s) => w.set(`${x},${y},${z}`, s);
  put(0, 0, 0, 'minecraft:oak_log[axis=y]');
  for (let x = 1; x <= 9; x++) put(x, 0, 0, `minecraft:oak_leaves[distance=7,persistent=${x === 9 ? 'true' : 'false'}]`);
  put(1, 1, 0, 'minecraft:crimson_stem[axis=y]'); // a nether stem is in #logs too
  const stateAt = (x, y, z) => w.get(`${x},${y},${z}`) ?? null;
  const cells = [];
  for (let x = 1; x <= 9; x++) cells.push([x, 0, 0]);
  assert.deepEqual([...leafDistances(cells, stateAt)], [1, 2, 3, 4, 5, 6, 7, 7, 7]);
  const out = formRules({ each: (fn) => { for (let x = 1; x <= 9; x++) fn(x, 0, 0, w.get(`${x},0,0`), 0); }, stateAt, isWater: () => false });
  assert.deepEqual(out.m18.get(0).map((c) => c[0]), [7, 8], 'distance 7, not persistent: decays');
  // a mushroom block is LEAVES-class in the kit but no LeavesBlock: never an M18 cell
  const out2 = formRules({ each: (fn) => fn(0, 5, 0, 'minecraft:red_mushroom_block[down=true,east=true,north=true,south=true,up=true,west=true]', 0), stateAt: () => null, isWater: () => false });
  assert.equal(out2.metrics.M18.leaves, 0);
});

test('item 9: catalogue 11 (archived as catalogue-b0410.json by close-out A); against catalogue 9 (catalogue-vocc.json) exactly one flip, four added ids and the tunnel\'s volume flag', () => {
  // ((close-out A) catalogue 11 is archived as fixtures/plan/catalogue-b0410.json; the golden is catalogue 12 now: coa.test.mjs)
  const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-b0410.json'), 'utf8'));
  assert.ok(planCatalogue().catalogueVersion >= 12);
  assert.equal(golden.catalogueVersion, 11);
  assert.equal(golden.api, '1.38.0');
  const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-vocc.json'), 'utf8'));
  assert.equal(prev.catalogueVersion, 9);
  const d = diffCatalogues(prev, golden);
  // ((batch v0.41.0) FL's six flips and locator.around's note are fl.test.mjs item 5's)
  const FL = ['layout.grid', 'layout.organic', 'layout.ring', 'layout.spiral', 'locator.around', 'sketch.outline'];
  const f3 = (xs) => xs.filter((x) => !FL.includes(x.id ?? x));
  assert.deepEqual(f3(d.reservedToSupported), ['form.giant_tree']);
  assert.deepEqual(d.added.map((a) => a.id ?? a).sort(), ['form.coral', 'form.giant_mushroom', 'form.roots', 'form.stalactites']);
  assert.deepEqual(f3(d.schemaVersionBumps), [{ id: 'form.giant_tree', from: 0, to: 1 }]);
  // S-F3-3: the volume flag on every entry whose check needs a frozen volume under the ground (the tunnel's corridor, the cave forms)
  assert.deepEqual(d.limitsChanged.map((x) => x.id ?? x), ['connector.tunnel']);
  assert.deepEqual(golden.entries.filter((e) => e.limits?.volume === true).map((e) => e.id).sort(), ['connector.tunnel', 'form.roots', 'form.stalactites']);
  assert.deepEqual([d.removed, d.retired, d.otherStateChanges, d.untilChanged, f3(d.notesChanged)], [[], [], [], [], []]);
  for (const id of ['form.giant_tree', 'form.giant_mushroom', 'form.coral', 'form.roots', 'form.stalactites']) {
    const e = golden.entries.find((x) => x.id === id);
    assert.equal(e.state, 'supported', id);
    assert.equal(e.sinceApi, '1.38.0', id);
  }
  // no entry waits for F3 any more
  assert.deepEqual(golden.entries.filter((e) => e.until === 'F3').map((e) => e.id), []);
});

test('§3.3: the cave forms take the two-plan flow: the first plan asks one volume per part and answers incomplete VOLUME, the second reads it and fits; r02 NO_FEATURE {why: no ceiling}, r05 past the cap, r06 water over every root, u06 lint GROWS', async () => {
  for (const rel of ['valid/v74_f3_roots_bank.json', 'valid/v75_f3_stalactites.json']) {
    const { r } = await of(rel);
    assert.ok(r.asked.length >= 1, `${rel}: asked ${r.asked.length}`);
    for (const a of r.first.check.parts) assert.equal(a.class, 'incomplete', `${rel} first plan ${a.part}`);
    for (const a of r.first.check.parts) assert.equal(a.reasons[0].code, 'VOLUME');
    assert.equal(r.check.overall, 'READY');
    // every stalactite root's cell over it holds no fluid (vanilla's growth needs a water source there); merged tips are tip_merge pairs
    const ir = r.res.ir;
    assert.ok((ir.forms ?? []).every((f) => !['stalactites', 'roots'].includes(f.generator) || f.baked?.cells > 0));
  }
  const r2 = await of('f3/r02_no_ceiling.json');
  assert.equal(r2.part('drips').class, 'refused');
  assert.equal(r2.part('drips').reasons[0].code, 'NO_FEATURE');
  assert.equal(r2.part('drips').reasons[0].evidence.why, 'no ceiling');
  const r5 = await of('f3/r05_volume_cap.json');
  assert.equal(r5.part('drips').class, 'incomplete');
  assert.equal(r5.part('drips').reasons[0].evidence.cap, 'boxCells');
  assert.equal(r5.r.asked.length, 0, 'past the cap: never asked');
  const r6 = await of('f3/r06_water_over_roots.json');
  assert.equal(r6.part('drips').class, 'refused');
  assert.equal(r6.part('drips').reasons[0].code, 'NO_FEATURE');
  const u6 = await of('f3/u06_stalactite_under_water.json');
  assert.equal(u6.part('drips').class, 'refused');
  assert.match(u6.part('drips').reasons[0].message, /^GROWS: /);
});
