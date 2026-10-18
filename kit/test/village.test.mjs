// Phase 6c slice V (docs/CONTRACT.md "Phase 6c slice V: flat village (C10)", §7 gate items 1 and 2): the flat_village layout's
// properties over 500 seeded synthetic flat claims, VillageLayout parity on Steward's own cases, the props, the villager mover,
// the `lots` param type, the widened siteplan schema, and the broken variants each caught on its named part.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { layoutStreet, lane, surfaceOps, STREET_RULES } from '../lib/region/village.mjs';
import { LOTS_MAX, LOT_EXT_MAX, cornerValues, validateLots, validateParams } from '../lib/params.mjs';
import { Palette, VWorld } from '../lib/region/vworld.mjs';
import { walkGraph, nodeReached } from '../lib/region/check.mjs';
import { build } from '../regions/flat_village.mjs';
import * as flatVillage from '../regions/flat_village.mjs';
import { flatSurvey, rng } from './village-layout.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROGRAM = path.join(KIT, 'regions', 'flat_village.mjs');

/** S7's program (CONTRACT V §7): a landmark hall (L), a trading hall (M), 4 cottages (S), a smithy and a bakery, an inn (M), a farm (M). */
export const S7_LOTS = [
  { id: 'hall_1', type: 'hall', role: 'landmark hall', size: [18, 20], landmark: true, villager: 'job' },
  { id: 'trading_hall_1', type: 'trading_hall', role: 'trading hall', size: [14, 17], villager: 'trading_hall' },
  { id: 'cottage_1', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling' },
  { id: 'cottage_2', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling' },
  { id: 'cottage_3', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling' },
  { id: 'cottage_4', type: 'cottage', role: 'cottage', size: [11, 14], villager: 'dwelling' },
  { id: 'smithy_1', type: 'smithy', role: 'smithy', size: [11, 14], villager: 'job' },
  { id: 'bakery_1', type: 'bakery', role: 'bakery', size: [11, 14], villager: 'job' },
  { id: 'inn_1', type: 'tavern', role: 'inn', size: [14, 17], villager: 'job' },
  { id: 'farm_1', type: 'farm', role: 'farm', size: [14, 17], villager: 'farm', placement: 'near_water' },
];
const CLAIM112 = { minX: 0, minZ: 0, maxX: 111, maxZ: 111, minY: -64, maxY: 319 };
const POND = [[90, 4, 99, 13]];

const plan = (o) => planRegion({ programFile: PROGRAM, node: 'test', ...o });
const box = (l) => l.box;
const meet = (a, b, g = 0) => a.minX - g <= b.maxX && b.minX - g <= a.maxX && a.minZ - g <= b.maxZ && b.minZ - g <= a.maxZ;

// ------------------------------------------------------------------ item 1: the layout's properties

// (the 500 seeded claims run in village-layout-1..4.test.mjs, 125 each, so no single file sets the kit suite's wall time)

test('layout: VillageLayout parity on Steward\'s cases (street places at least as many lots)', () => {
  const j = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'village', 'villagelayout-parity.json'), 'utf8'));
  const unrle = (s) => s.split(',').flatMap((t) => { const [v, n] = t.split('x').map(Number); return Array(n).fill(v); });
  assert.ok(j.cases.length >= 3);
  for (const c of j.cases) {
    const g = c.grid, h = unrle(g.height), w = unrle(g.water);
    const col = makeColumns(g.x0, g.z0, g.width, g.depth, 1);
    for (let i = 0; i < g.width * g.depth; i++) { col.ground[i] = h[i]; col.height[i] = h[i]; col.floor[i] = w[i] ? h[i] - 3 : h[i]; col.flags[i] = w[i] ? 1 : 0; }
    const claim = { minX: c.claim.centerX - c.claim.radius, minZ: c.claim.centerZ - c.claim.radius, maxX: c.claim.centerX + c.claim.radius, maxZ: c.claim.centerZ + c.claim.radius, minY: -64, maxY: 320 };
    const L = layoutStreet({ claim, survey: surveyApi(col, claim), specs: validateLots(c.specs) });
    assert.ok(!L.fail, `${c.name}: ${L.fail}`);
    assert.ok(L.lots.length >= c.steward.placed, `${c.name}: street places ${L.lots.length}, VillageLayout ${c.steward.placed}`);
  }
});

test('S7-shaped plan: 0 errors, every rule clean, M2 and M2:villager 100%, graph joined, props counted, siteplan valid', async () => {
  const survey = flatSurvey(CLAIM112, { water: POND });
  const p = await plan({ params: { lots: S7_LOTS }, survey, claim: CLAIM112 });
  const rep = checkRegion({ ir: p.ir, survey, meta: p.meta });
  assert.equal(rep.errors, 0, JSON.stringify(rep.findings.map((f) => f.message)));
  for (const f of rep.findings) assert.ok(['M5'].includes(f.rule), `only M5 (the 4e road lanterns light the street at realise): ${f.rule} ${f.message}`);
  assert.equal(rep.metrics.M2.unreachable.length, 0);
  assert.equal(rep.metrics.M2villager.unreachable.length, 0);
  assert.equal(rep.metrics.M2villager.lots, 10);
  assert.ok(rep.metrics.M23.trading_hall_1 <= 12);
  assert.ok(rep.metrics.M24.farms.farm_1 <= 2);
  assert.deepEqual(rep.metrics.graph.cut, []);
  assert.equal(p.ir.format, 1, 'a flat village is a format-1 IR');
  assert.deepEqual(p.ir.keepOut, [], 'the program read keepOut (none given)');
  const c = p.meta.village.propCounts;
  assert.ok(c.well === 1 && c.bench >= 2 && c.bench <= 4 && (c.planter ?? 0) >= 1 && c.planter <= 4 && c.lamp === 4, JSON.stringify(c));
  // no op kind but columns; no carve/add/... primitives: every part is pads, path parts or props
  for (const part of p.ir.parts) for (const op of part.ops) if (part.id !== 'pads') assert.equal(op.op, 'columns', `${part.id}: columns ops only`);
  const sp = sitePlan({ ir: p.ir, meta: p.meta, vw: rep._world });
  const schema = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, sp), []);
  assert.equal(sp.graph.derived, false);
  assert.ok(sp.graph.nodes.some((n) => n.kind === 'plaza' && n.ports.some((q) => q.name === 'bell')));
  assert.ok(sp.graph.edges.every((e) => e.mover.includes('villager')), 'every edge reached by the villager mover');
  assert.ok(sp.paths.some((q) => q.kind === 'path'));
  assert.deepEqual(sp.unplaced, []);
  // LotSpec.ext data in the IR lots
  const t = p.ir.lots.find((l) => l.id === 'trading_hall_1').ext['architect_mc:village'];
  assert.equal(t.villager, 'trading_hall');
  assert.ok(t.bellDistance <= 12 && Array.isArray(t.entrance) && t.lane === 'lane_trading_hall_1');
  // the 6b derived graph is unchanged for a program without one (crater_works stays derived: true)
});

test('the default roles: gravel path, stone-brick foundation, lanterns; a bible\'s roles win', async () => {
  const survey = flatSurvey(CLAIM112, { water: POND });
  const p = await plan({ params: { lots: S7_LOTS.slice(0, 4) }, survey, claim: CLAIM112 });
  assert.equal(p.ir.roles.path, 'minecraft:gravel');
  assert.equal(p.ir.roles.foundation, 'minecraft:stone_bricks');
  assert.equal(p.ir.roles.light, 'minecraft:lantern');
  const b = await plan({ params: { lots: S7_LOTS.slice(0, 4) }, survey, claim: CLAIM112, roles: { path: 'minecraft:packed_mud', foundation: 'minecraft:mud_bricks' } });
  assert.equal(b.ir.roles.path, 'minecraft:packed_mud');
  // no part writes dirt path or cobblestone, and the street's surface is the path role
  for (const part of b.ir.parts) for (const op of part.ops) for (const m of op.materials ?? [op.material]) assert.ok(!/minecraft:(dirt_path|cobblestone)\b/.test(String(m)), `${part.id} writes ${m}`);
  for (const r of b.ir.roads) assert.equal(r.surface, 'minecraft:packed_mud');
});

test('an oversized lot comes back unplaced; requireAll fails the plan; the street is never forced', async () => {
  const survey = flatSurvey(CLAIM112, { water: POND });
  const lots = [...S7_LOTS.slice(0, 5), { id: 'keep_1', type: 'keep', size: [96, 60] }];
  const p = await plan({ params: { lots }, survey, claim: CLAIM112 });
  assert.deepEqual(p.meta.village.unplaced.map((u) => u.id), ['keep_1']);
  assert.ok(p.notes.includes('unplaced: keep_1'));
  await assert.rejects(plan({ params: { lots, requireAll: true }, survey, claim: CLAIM112 }), /requireAll, and 1 lot\(s\) are unplaced: keep_1/);
  // a claim that is all water: the street fails the plan, with the reason
  await assert.rejects(plan({ params: { lots: S7_LOTS.slice(0, 2) }, survey: flatSurvey(CLAIM112, { water: [[0, 0, 111, 111]] }), claim: CLAIM112 }), /^Error: flat village: /);
});

test('keep-out: the layout routes around a rect over a third of the claim; the IR records it', async () => {
  const survey = flatSurvey(CLAIM112, { water: POND });
  const ko = [[0, 0, 111, 36]];
  const p = await plan({ params: { lots: S7_LOTS }, survey, claim: CLAIM112, keepOut: ko });
  assert.deepEqual(p.ir.keepOut, ko);
  const rep = checkRegion({ ir: p.ir, survey, meta: p.meta });
  let inside = 0;
  rep._world.eachWritten((x, y, z) => { if (x >= 0 && x <= 111 && z >= 0 && z <= 36) inside++; });
  assert.equal(inside, 0, 'no cell written in the keep-out rect');
  for (const r of p.ir.roads) for (const q of r.points) assert.ok(q[2] > 36 + 2, 'the street stays out of it');
  // programs that don't read keepOut carry none (their IR and tiles are unchanged)
  const other = await planRegion({ programFile: path.join(KIT, 'regions', 'region_small.mjs'), survey: flatSurvey({ minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 }), claim: { minX: 0, minZ: 0, maxX: 191, maxZ: 191, minY: -64, maxY: 319 }, keepOut: ko, node: 'test' });
  assert.equal(other.ir.keepOut, undefined);
});

// ------------------------------------------------------------------ props, the villager mover, the lots type

test('props: supported (M3 clean), beside walk cells and never on them, never in the bell area, golem space or a lot box', async () => {
  for (const [sq, lamps, bell] of [[9, 'few', true], [11, 'street', false], [15, 'street', true], [13, 'none', false]]) {
    const survey = flatSurvey(CLAIM112, { water: POND });
    const p = await plan({ params: { lots: S7_LOTS, squareSize: sq, lamps, bell }, survey, claim: CLAIM112 });
    const rep = checkRegion({ ir: p.ir, survey, meta: p.meta });
    assert.ok(!rep.findings.some((f) => f.rule.startsWith('M3') || f.rule === 'M22' || f.rule === 'M1'), `square ${sq}: ${rep.findings.map((f) => f.rule + ' ' + f.message).join('; ')}`);
    const v = p.meta.village, vw = rep._world;
    const area = new Set(v.bellArea.map(([x, z]) => `${x},${z}`)), golem = new Set(v.golem.map(([x, z]) => `${x},${z}`));
    for (const pr of v.props) for (const [x, y, z] of pr.cells) {
      assert.ok(!area.has(`${x},${z}`) && !golem.has(`${x},${z}`), `${pr.id} in the bell area or golem space`);
      for (const l of p.ir.lots) assert.ok(!(x >= l.box.minX && x <= l.box.maxX && z >= l.box.minZ && z <= l.box.maxZ), `${pr.id} in lot ${l.id}`);
      // never on a walk cell: the column's paving under a prop has no walk bit
      assert.equal(vw.flags(x, v.shared.y, z) & 2, 0, `${pr.id} stands on a walk cell at ${x},${z}`);
    }
    // beside walk cells: every shared-space prop's footprint touches a walk cell ((6c W) the apron lamps stand beside the lots)
    for (const pr of v.props.filter((q) => q.kind !== 'apron_lamp')) {
      const foot = new Set(pr.cells.map(([x, , z]) => `${x},${z}`));
      const touches = [...foot].some((k) => { const [x, z] = k.split(',').map(Number); return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => vw.flags(x + dx, v.shared.y, z + dz) & 2); });
      assert.ok(touches, `${pr.id} beside a walk cell`);
    }
    const c = v.propCounts;
    assert.ok((c.well ?? 0) <= 1 && (c.bench ?? 0) >= 2 && (c.bench ?? 0) <= 4 && (c.planter ?? 0) <= 4 && (c.bell ?? 0) === (bell ? 1 : 0), `square ${sq}: ${JSON.stringify(c)}`);
    assert.equal(c.lamp ?? 0, { none: 0, few: 2, street: 4 }[lamps]);
    // the dry well: no fluid written anywhere in V
    let fluid = 0;
    vw.eachWritten((x, y, z, idx) => { if (vw.pal.fluid[idx]) fluid++; });
    assert.equal(fluid, 0);
  }
});

/** A small hand-built world: stone floor at y 63, air above, plus `cells` {"x,y,z": state}. */
function tinyWorld(cells, claim = { minX: 0, minZ: 0, maxX: 15, maxZ: 15, minY: 0, maxY: 100 }) {
  const pal = new Palette();
  const stone = pal.of('minecraft:stone'), air = pal.of('minecraft:air');
  const idx = new Map(Object.entries(cells).map(([k, s]) => [k, pal.of(s)]));
  const vw = new VWorld({ claim, palette: pal, base: (x, y, z) => idx.get(`${x},${y},${z}`) ?? (y <= 63 ? stone : air), colTop: () => 63 });
  vw.colRange = () => [60, 72];
  return vw;
}

test('the villager mover: no 2-block step, no ladder; a wooden door passes, a fence gate and an iron door block', () => {
  // a wall of 2 across z = 8 (x 0..15): only a gap with a door, gate, ladder or step lets anything through
  const wall = (gap) => {
    const c = {};
    for (let x = 0; x <= 15; x++) for (const y of [64, 65]) c[`${x},${y},8`] = 'minecraft:stone';
    for (const [k, s] of Object.entries(gap)) c[k] = s;
    return c;
  };
  const reach = (cells, mover) => nodeReached(walkGraph(tinyWorld(cells), [[3, 64, 3]], { mover }), [3, 64, 13]);
  const door = wall({ '5,64,8': 'minecraft:oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]', '5,65,8': 'minecraft:oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]' });
  assert.equal(reach(door, 'villager'), true, 'a wooden door passes');
  const iron = wall({ '5,64,8': 'minecraft:iron_door[facing=north,half=lower,hinge=left,open=false,powered=false]', '5,65,8': 'minecraft:iron_door[facing=north,half=upper,hinge=left,open=false,powered=false]' });
  assert.equal(reach(iron, 'villager'), false, 'an iron door blocks a villager');
  const gate = wall({ '5,64,8': 'minecraft:oak_fence_gate[facing=north,in_wall=false,open=false,powered=false]', '5,65,8': 'minecraft:air' });
  assert.equal(reach(gate, 'villager'), false, 'a fence gate counts as closed');
  assert.equal(reach(gate, 'player'), true, 'the player opens it');
  // a raised floor: a 2-block step up onto a platform behind the wall's gap (no wall cells there)
  const step = {};
  for (let x = 0; x <= 15; x++) for (let z = 8; z <= 15; z++) { step[`${x},64,${z}`] = 'minecraft:stone'; step[`${x},65,${z}`] = 'minecraft:stone'; }
  const g2 = walkGraph(tinyWorld(step), [[3, 64, 3]], { mover: 'villager' });
  assert.equal(nodeReached(g2, [3, 66, 13]), false, 'a step of 2 is not climbed');
  const g2p = walkGraph(tinyWorld(step), [[3, 64, 3]], { mover: 'player' });
  assert.equal(nodeReached(g2p, [3, 66, 13]), false, 'nor by the player (a jump is 1)');
  // a ladder up the 2-block step: the player climbs, the villager does not
  const lad = { ...step, '3,64,7': 'minecraft:ladder[facing=north,waterlogged=false]', '3,65,7': 'minecraft:ladder[facing=north,waterlogged=false]', '3,66,7': 'minecraft:ladder[facing=north,waterlogged=false]' };
  assert.equal(nodeReached(walkGraph(tinyWorld(lad), [[3, 64, 3]], { mover: 'player' }), [3, 66, 13]), true, 'the player climbs the ladder');
  assert.equal(nodeReached(walkGraph(tinyWorld(lad), [[3, 64, 3]], { mover: 'villager' }), [3, 66, 13]), false, 'a ladder is not used by a villager');
  // a drop of 2: the player falls (at most 3), the villager does not (at most 1)
  const pit = {};
  for (let x = 0; x <= 15; x++) for (let z = 8; z <= 15; z++) { pit[`${x},63,${z}`] = 'minecraft:air'; pit[`${x},62,${z}`] = 'minecraft:air'; }
  assert.equal(nodeReached(walkGraph(tinyWorld(pit), [[3, 64, 3]], { mover: 'player' }), [3, 62, 13]), true);
  assert.equal(nodeReached(walkGraph(tinyWorld(pit), [[3, 64, 3]], { mover: 'villager' }), [3, 62, 13]), false);
});

test('the lots param type: region programs only; bad id, duplicate, size, over 40 refused; never a variant axis', () => {
  assert.throws(() => validateParams({ lots: { type: 'lots', default: [] } }), /the 'lots' type is allowed in region programs only/);
  assert.doesNotThrow(() => validateParams({ lots: { type: 'lots', default: [] } }, { region: true }));
  const ok = { id: 'cottage_1', type: 'cottage', size: [11, 14] };
  assert.equal(validateLots([ok])[0].villager, 'dwelling', 'villager inferred from the type when absent (S-V-1)');
  assert.equal(validateLots([{ ...ok, villager: 'none' }])[0].villager, 'none', 'the caller\'s villager wins');
  assert.throws(() => validateLots([{ ...ok, id: 'Bad Id' }]), /lots\[0\]\.id must match/);
  assert.throws(() => validateLots([ok, { ...ok }]), /lots\[1\]\.id 'cottage_1' is used twice/);
  assert.throws(() => validateLots([{ ...ok, size: [4, 14] }]), /size must be \[alongStreet, deep\], integers 5\.\.96/);
  assert.throws(() => validateLots([{ ...ok, size: [11] }]), /size must be/);
  assert.throws(() => validateLots(Array.from({ length: LOTS_MAX + 1 }, (_, i) => ({ ...ok, id: `c_${i}` }))), /41 lots \(at most 40\)/);
  assert.throws(() => validateLots([{ ...ok, villager: 'priest' }]), /villager must be one of/);
  assert.throws(() => validateLots([{ ...ok, extra: 1 }]), /unknown member 'extra'/);
  // variant enumeration never walks it
  assert.ok(cornerValues(flatVillage.params).every((v) => !('lots' in v)));
  assert.equal(flatVillage.catalogue, false);
});

// ------------------------------------------------------------------ item 2: the broken variants

/** Plan flat_village through build() with a test hook (the broken variants; never a bundled program). */
function variant(hooks, { lots = S7_LOTS, survey = flatSurvey(CLAIM112, { water: POND }), keepOut = [], params = {} } = {}) {
  const program = { id: 'flat_village_broken', params: flatVillage.params, roles: flatVillage.roles, default: (ctx) => build(ctx, hooks) };
  return planRegion({ program, programSource: `broken ${JSON.stringify(Object.keys(hooks))}`, params: { lots, ...params }, survey, claim: CLAIM112, keepOut, node: 'test' }).then((p) => ({ p, survey }));
}
const report = ({ p, survey }) => checkRegion({ ir: p.ir, survey, meta: p.meta });

test('broken variants: each caught on its named part', async () => {
  // a lot with no lane: M2 (the graph has no edge from the lot to the plaza)
  let r = report(await variant({ _unsafe: { noLane: 'cottage_2' } }));
  assert.ok(r.findings.some((f) => f.rule === 'M2' && f.part === 'lanes' && /cottage_2/.test(f.message)), 'no lane: M2');
  // the trading hall at 20: M23
  r = report(await variant({ _unsafe: { notOnSquare: 'trading_hall_1' } }));
  const d = r.metrics.M23.trading_hall_1;
  assert.ok(d > 12, `the trading hall moved off the square (${d})`);
  assert.ok(r.findings.some((f) => f.rule === 'M23' && /trading_hall_1/.test(f.message)), 'trading hall far: M23');
  // a prop in the bell area: M22
  r = report(await variant({ after: (reg, L) => { const [x, y, z] = L.res.bell; const q = reg.part('props_extra', { stage: 'props' }); q._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: [x + 1, z, y, y, 0, x + 1, z, y + 1, y + 1, 1], materials: ['minecraft:oak_fence', 'minecraft:lantern'], cond: 2, walk: false }); } }));
  assert.ok(r.findings.some((f) => f.rule === 'M22'), 'a prop in the bell area: M22');
  // a farm at 10 from water: M24
  r = report(await variant({ _unsafe: { noNearWater: true } }, { survey: flatSurvey(CLAIM112, { water: [[100, 50, 105, 62]] }) }));
  const fw = r.metrics.M24.farms.farm_1;
  assert.ok(fw > 2, `the farm stands ${fw} from water`);
  assert.ok(r.findings.some((f) => f.rule === 'M24' && /farm_1/.test(f.message)), 'farm far from water: M24');
  // a lane into a lot box: M1 error
  r = report(await variant({ after: (reg, L) => { const lanes = reg.parts.find((q) => q.id === 'lanes'); const l = L.lots[0]; const b = l.lot.box; surfaceOps(lanes, [[b.minX + 2, b.minY - 1, b.minZ + 2], [b.minX + 3, b.minY - 1, b.minZ + 2]], 'path'); } }));
  assert.ok(r.findings.some((f) => f.rule === 'M1' && f.severity === 'error' && f.part === 'lanes' && /inside a lot box/.test(f.message)), 'lane into a lot box: M1 error');
  assert.ok(!r.ok);
  // a lane across keep-out: the plan is refused (the lane's builder refuses it; the throw fails the plan)
  await assert.rejects(variant({ after: (reg, L) => { const e = L.lots[0].entrance; lane(reg.parts.find((q) => q.id === 'lanes'), 'lane_x', e, [e[0] + 6, e[1], e[2]], 2, { o: 'ew', keepOut: [[e[0] + 3, e[2] - 2, e[0] + 3, e[2] + 2]] }); } }), /lane lane_x crosses keep-out/);
});

// ------------------------------------------------------------------ 6c X, C19: lot ext from the plan

test('C19: a lot\'s ext is validated (object, namespace:name keys, 4096 characters), architect_mc: keys dropped', () => {
  const ok = { id: 'cottage_1', type: 'cottage', size: [11, 14] };
  const e = { 'steward_mc:lot': 'cottage_1', 'steward_mc:role': 'dwelling', 'steward_mc:build': { id: 'b7', n: [1, 2] } };
  assert.deepEqual(validateLots([{ ...ok, ext: e }])[0].ext, e);
  assert.ok(!('ext' in validateLots([ok])[0]), 'no ext given, none in the normalised lot (other IRs unchanged)');
  assert.ok(!('ext' in validateLots([{ ...ok, ext: {} }])[0]), 'an empty ext is no ext');
  // the namespace guard: Architect\'s keys are dropped, the caller\'s stay
  const g = validateLots([{ ...ok, ext: { 'architect_mc:lot': 'forged', 'architect_mc:village': { role: 'forged' }, 'steward_mc:lot': 'x' } }])[0].ext;
  assert.deepEqual(g, { 'steward_mc:lot': 'x' });
  assert.ok(!('ext' in validateLots([{ ...ok, ext: { 'architect_mc:lot': 'forged' } }])[0]), 'only Architect\'s keys: no ext left');
  // bounds: exactly 4096 characters passes, 4097 fails, with the path
  const pad = (n) => { const o = { 'steward_mc:x': '' }; o['steward_mc:x'] = 'a'.repeat(n - JSON.stringify(o).length); return o; };
  assert.equal(JSON.stringify(pad(LOT_EXT_MAX)).length, LOT_EXT_MAX);
  assert.doesNotThrow(() => validateLots([{ ...ok, ext: pad(LOT_EXT_MAX) }]));
  assert.throws(() => validateLots([{ ...ok, ext: pad(LOT_EXT_MAX + 1) }]), /lots\[0\]\.ext: 4097 characters as JSON, at most 4096/);
  assert.throws(() => validateLots([{ ...ok, ext: [1] }]), /lots\[0\]\.ext must be an object/);
  assert.throws(() => validateLots([{ ...ok, ext: 'x' }]), /lots\[0\]\.ext must be an object/);
  assert.throws(() => validateLots([{ ...ok, ext: { nonamespace: 1 } }]), /lots\[0\]\.ext: key 'nonamespace' is not namespace:name/);
  // the input is not aliased
  const src = { 'steward_mc:b': { a: 1 } };
  const out = validateLots([{ ...ok, ext: src }])[0].ext;
  out['steward_mc:b'].a = 2;
  assert.equal(src['steward_mc:b'].a, 1);
});

test('C19: the plan copies the caller\'s ext onto the lot, the program\'s own architect_mc:village wins', async () => {
  const survey = flatSurvey(CLAIM112, { water: POND });
  const ext = { 'steward_mc:lot': 'trading_hall_1', 'steward_mc:role': 'trade', 'steward_mc:build': 'b7', 'architect_mc:village': { role: 'forged' } };
  const lots = S7_LOTS.map((l) => (l.id === 'trading_hall_1' ? { ...l, ext } : l));
  const p = await plan({ params: { lots }, survey, claim: CLAIM112 });
  const l = p.ir.lots.find((q) => q.id === 'trading_hall_1');
  assert.equal(l.ext['steward_mc:lot'], 'trading_hall_1');
  assert.equal(l.ext['steward_mc:role'], 'trade');
  assert.equal(l.ext['steward_mc:build'], 'b7');
  assert.equal(l.ext['architect_mc:village'].villager, 'trading_hall', 'the caller\'s architect_mc: value is ignored');
  assert.ok(p.ir.lots.filter((q) => q.id !== 'trading_hall_1').every((q) => Object.keys(q.ext).join() === 'architect_mc:village'), 'other lots: Architect\'s key only');
  // the same plan without ext: only the lot\'s ext differs (the seed comes from the params, so props may differ; every other lot is the same)
  const base = await plan({ params: { lots: S7_LOTS }, survey, claim: CLAIM112 });
  assert.deepEqual(p.ir.lots.filter((q) => q.id !== 'trading_hall_1'), base.ir.lots.filter((q) => q.id !== 'trading_hall_1'));
  // a plan is deterministic with ext
  const again = await plan({ params: { lots }, survey, claim: CLAIM112 });
  assert.equal(again.irSha, p.irSha);
});
