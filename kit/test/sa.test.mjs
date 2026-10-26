// (7a SA) Spiral stairs round a form (docs/CONTRACT.md "Phase 7a slice SA" §1-§8, gate item 1): the hug on tapering and stepped
// cross-sections, landings, the three tops, every refusal with its evidence, M10:spiral clean on the valid fixtures and failing on the
// broken variants (floating, noRails), the host never written, the KC row (M25:clear 0), the wire shapes (the lookout node, the graph
// edge's crossing, siteplan spirals[], cost.bom exact), every block themed (S-THEME), survival's row, determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, svOf, part } from './plan-p0-shared.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { SPIRAL, sections, spiralPlan, spiralRoles, spiralCells } from '../lib/connectors/spiralGeom.mjs';
import * as hooks from '../lib/connectors/spiral.mjs';
import { sitePlan } from '../lib/region/siteplan.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';

const fx = (dir, name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, name), 'utf8')) });
const checkOf = (f, r) => { const s = svOf(f); return checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded) }); };
const flat = (g = 64) => ({ groundAt: () => g, open: (x, y) => y > g, waterAt: () => false });

/** A host of discs (radius r(y) round [0, 0]) from y 64 up, as Map "x,y,z" -> state. */
function discs(rOf, top, state = 'minecraft:stone') {
  const m = new Map();
  for (let y = 64; y <= top; y++) { const r = rOf(y); for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) if (x * x + z * z <= r * r + r) m.set(`${x},${y},${z}`, state); }
  return m;
}
/** The walk's steps are face-adjacent and rise 1 or 0; every tread outside the host with 2 clear over it. */
function assertWalk(s, host) {
  let prev = s.foot;
  for (const w of s.walk.filter((q) => q.lane === 1)) {
    assert.equal(Math.abs(w.x - prev[0]) + Math.abs(w.z - prev[2]), 1, `step ${w.x},${w.y},${w.z} beside the one before`);
    assert.equal(w.y - prev[1], w.kind === 'tread' ? 1 : 0, `step ${w.x},${w.y},${w.z} rises ${w.kind === 'tread' ? 1 : 0}`);
    prev = [w.x, w.y, w.z];
  }
  for (const w of s.walk) for (let t = 0; t <= 2; t++) assert.ok(!host.has(`${w.x},${w.y + t},${w.z}`), `walk ${w.x},${w.y},${w.z} clear of the host`);
}

test('the hug: a tapering cone (summit), a stepped cross-section, landings every 8 rising treads, counter-clockwise', () => {
  const cone = discs((y) => Math.max(1, 6 - Math.floor((y - 64) / 5)), 94);
  const s = spiralPlan(cone, { kind: 'rock_spire', at: [0, 64, 0], from: [0, 40], land: flat(), width: 1, hard: (x, z) => Math.abs(x) <= 8 && Math.abs(z) <= 8 });
  assert.ok(s.ok, JSON.stringify(s));
  assertWalk(s, cone);
  assert.equal(s.topKind, 'summit');
  assert.equal(s.D, 95, 'the deck one over the summit');
  assert.equal(s.rise, 31);
  assert.ok(s.turns > 0.5, `it goes round (${s.turns} turns, counter-clockwise: positive)`);
  // the foot faces `from` (south), the approach runs out of the hard rect
  assert.ok(s.foot[2] > 0 && s.end[2] === 9, JSON.stringify([s.foot, s.end]));
  // landings: after every 8 rising treads, 2 flat cells (top slabs)
  const lane = s.walk.filter((w) => w.lane === 1);
  let rising = 0;
  for (let i = 0; i < lane.length; i++) {
    if (lane[i].kind === 'tread') rising++;
    if (rising === SPIRAL.landingEvery && lane[i].kind === 'tread' && i + 2 < lane.length && lane[i].y < s.D) { assert.ok(lane[i + 1].landing && lane[i + 2].landing, `a landing after 8 treads at ${i}`); rising = 0; }
    else if (lane[i].landing) rising = 0;
  }
  assert.ok(s.landings >= 3);
  // stepped: a section that halves at 76 (a shoulder): the ring steps inward, the walk still face-adjacent step by step
  const stepped = discs((y) => (y < 76 ? 5 : 2), 92);
  const t = spiralPlan(stepped, { kind: 'rock_spire', at: [0, 64, 0], from: [40, 0], land: flat(), hard: (x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 });
  assert.ok(t.ok, JSON.stringify(t));
  assertWalk(t, stepped);
  // integer maths: the same input, the same plan
  assert.deepEqual(spiralPlan(stepped, { kind: 'rock_spire', at: [0, 64, 0], from: [40, 0], land: flat(), hard: (x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 }).walk, t.walk);
});

test('the tops: summit, canopy (3 under the lowest leaf over the trunk), {y}; width 2 keeps its outer lane within 2', () => {
  // a trunk of radius 1 to 100, leaves from 90 within 6
  const tree = discs(() => 1, 100, 'minecraft:oak_log');
  for (let y = 90; y <= 96; y++) for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) if (Math.abs(x) > 1 || Math.abs(z) > 1) tree.set(`${x},${y},${z}`, 'minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]');
  const c = spiralPlan(tree, { kind: 'giant_tree', at: [0, 64, 0], from: [0, 40], land: flat(), hard: (x, z) => Math.abs(x) <= 7 && Math.abs(z) <= 7 });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.topKind, 'canopy');
  assert.equal(c.D, 87, 'a ring deck 3 under the lowest leaf');
  // (the ring deck 1 wide round the 3 x 3 trunk; one more cell where the spiral steps on through the rail ring)
  assert.deepEqual(c.top.deck.map(([x, , z]) => Math.max(Math.abs(x), Math.abs(z))).sort().join(''), `${'2'.repeat(16)}3`, 'the ring deck 1 wide round the trunk');
  const y = spiralPlan(tree, { kind: 'giant_tree', at: [0, 64, 0], from: [0, 40], top: { y: 80 }, land: flat(), hard: (x, z) => Math.abs(x) <= 7 && Math.abs(z) <= 7 });
  assert.ok(y.ok && y.D === 80 && y.topKind === 'ring');
  const w2 = spiralPlan(tree, { kind: 'giant_tree', at: [0, 64, 0], from: [0, 40], width: 2, land: flat(), hard: (x, z) => Math.abs(x) <= 7 && Math.abs(z) <= 7 });
  assert.ok(w2.ok, JSON.stringify(w2));
  assertWalk(w2, tree);
  assert.ok(w2.walk.some((q) => q.lane === 2), 'an outer lane');
  // the sections: a mushroom's is its stem only
  const { S } = sections(new Map([['0,70,0', 'minecraft:mushroom_stem'], ['1,70,0', 'minecraft:brown_mushroom_block']]), 'giant_mushroom', [0, 64, 0], 64);
  assert.deepEqual([...S(70)], ['0,0']);
});

test('KC in the geometry: a body\'s hard cell in the spiral\'s way refuses OVERLAP {kind: body}; a lamp alone is never refused', () => {
  const cone = discs((y) => Math.max(1, 5 - Math.floor((y - 64) / 5)), 84);
  const base = { kind: 'rock_spire', at: [0, 64, 0], from: [0, 40], land: flat(), hard: (x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 };
  const s = spiralPlan(cone, base);
  assert.ok(s.ok);
  // a body whose hard cells are the spiral's third tread
  const t = s.walk.filter((w) => w.kind === 'tread')[2];
  const ov = spiralPlan(cone, { ...base, kept: (x, y, z) => (x === t.x && y === t.y && z === t.z ? { body: 'w_pond', part: 'pond', set: 'hard' } : null) });
  assert.equal(ov.code, 'OVERLAP');
  assert.equal(ov.evidence.kind, 'body');
  assert.deepEqual(ov.evidence.cells[0].at, [t.x, t.y, t.z]);
  // a lamp cell is the emit's (skipped in a watch cell), never a refusal
  const lamp = s.lampSpots[0];
  if (lamp) assert.ok(spiralPlan(cone, { ...base, kept: (x, y, z) => (x === lamp[0] && y === lamp[1] && z === lamp[2] ? { body: 'w_pond', set: 'hard' } : null) }).ok);
});

test('the geometry\'s refusals: SPAN under 4 and over 64, HEADROOM under a cap, with their evidence', () => {
  const low = discs(() => 2, 66);
  const sp = spiralPlan(low, { kind: 'rock_spire', at: [0, 64, 0], from: [0, 40], land: flat() });
  assert.equal(sp.code, 'SPAN');
  assert.deepEqual([sp.evidence.rise, sp.evidence.min, sp.evidence.max], [3, 4, 64]);
  const tall = discs(() => 2, 140);
  assert.equal(spiralPlan(tall, { kind: 'rock_spire', at: [0, 64, 0], from: [0, 40], land: flat() }).code, 'SPAN');
  // a cap 1 over a ring deck asked at 80
  const shroom = discs(() => 1, 90, 'minecraft:mushroom_stem');
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) shroom.set(`${x},81,${z}`, 'minecraft:brown_mushroom_block');
  const hr = spiralPlan(shroom, { kind: 'giant_mushroom', at: [0, 64, 0], from: [0, 40], top: { y: 80 }, land: flat() });
  assert.equal(hr.code, 'HEADROOM');
  assert.ok(hr.evidence.cells.some((q) => q.why === 'host' && q.at[1] === 81), JSON.stringify(hr.evidence));
});

const VALID = ['v7a_sa_spire.json', 'v7a_sa_spike.json', 'v7a_sa_tree.json', 'v7a_sa_mushroom.json', 'v7a_sa_villager.json'];

test('the valid fixtures fit; M10:spiral, M3, M6, M8 and M5 clean on the spiral; the host never written; the wire shapes; the BOM exact; themed', async () => {
  for (const name of VALID) {
    const f = fx('valid', name);
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${name}: ${JSON.stringify(r.check.parts)}`);
    const a = part(r, 'stair');
    assert.equal(a.class, 'fits', name);
    const g = a.geometry.spirals[0];
    assert.ok(g.rise >= 4 && g.rise <= 64 && g.turns > 0, `${name}: ${JSON.stringify(g)}`);
    assert.deepEqual(g.crossing, { type: 'stairs_around', host: g.host, rise: g.rise, turns: g.turns });
    if (name === 'v7a_sa_villager.json') { assert.equal(g.width, 2); assert.deepEqual(g.movers, ['player', 'villager']); } else assert.deepEqual(g.movers, ['player'], 'a lookout: player-only (S-SA-1)');
    // the graph: a lookout node and the stairs_around edge from the foot's route node
    const ir = r.res.ir;
    const e = ir.graph.edges.find((q) => q.type === 'stairs_around');
    assert.ok(e && e.crossing.rise === g.rise && /\.route$/.test(e.from) && /_lookout\.top$/.test(e.to), `${name}: ${JSON.stringify(e)}`);
    assert.ok(ir.graph.nodes.some((n) => n.kind === 'lookout' && n.ref === 'stair'));
    assert.ok(ir.graph.edges.some((q) => q.to === e.from || q.from === e.from), `${name}: the leg's route edge meets the foot node`);
    // the checker
    const rep = checkOf(f, r);
    const per = rep.metrics.spirals.per;
    assert.equal(per.length, 1);
    assert.ok(per[0].ok, `${name}: ${JSON.stringify(per[0])}`);
    assert.ok(per[0].railed === per[0].edges && per[0].edges > 0, `${name}: rails on every open edge`);
    const m = r.res.meta.spirals[0];
    assert.ok(!rep.findings.some((x) => x.part === m.part && /^M(3|5|6|8|10)(:|$)/.test(x.rule)), `${name}: ${rep.findings.filter((x) => x.part === m.part).map((x) => `${x.rule} ${x.message}`).join('; ')}`);
    // the host never written: no cell of the spiral's part on a host cell
    const { vw } = buildVirtual({ ir, survey: svOf(f).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    const pi = ir.parts.findIndex((q) => q.id === m.part), hi = ir.parts.findIndex((q) => q.id === m.form);
    const host = new Set();
    for (const op of ir.parts[hi].ops) void op;
    const states = [];
    vw.eachWritten((x, y, z, idx, fl, p) => { if (p === pi) states.push(vw.pal.states[idx]); if (p === hi) host.add(`${x},${y},${z}`); });
    for (const k of [...m.deckCells, ...m.rails, ...m.supports, ...m.corbel, ...m.approach, ...m.lamps].map((q) => q.slice(0, 3).join(','))) assert.ok(!host.has(k), `${name}: ${k} is a host cell the spiral wrote`);
    // the kit's movers foot <-> lookout both ways (the villager on a villager spiral)
    for (const mover of name === 'v7a_sa_villager.json' ? ['player', 'villager'] : ['player']) {
      const a = [m.foot[0], m.foot[1] + 1, m.foot[2]], b = [m.top[0], m.top[1] + 1, m.top[2]];
      assert.ok(nodeReached(walkGraph(vw, [a], { mover }), b), `${name}: ${mover} up`);
      assert.ok(nodeReached(walkGraph(vw, [b], { mover }), a), `${name}: ${mover} down`);
    }
    // cost.bom: exactly the states the spiral's part wrote
    assert.deepEqual(a.cost.bom, bomOf(states), name);
    assert.deepEqual(m.bom, a.cost.bom, name);
    // siteplan/1 spirals[]
    const sp = sitePlan({ ir, meta: r.res.meta });
    assert.deepEqual(sp.spirals, [{ id: m.id, part: m.part, host: m.host, rise: m.rise, turns: m.turns, top: m.top }]);
    // S-THEME: every block the spiral writes traces to a role (the light role's fixture, its soul variant by ice)
    const t = themeOffenders(ir, vw).offenders.filter((o) => o.part.startsWith('links_s'));
    assert.deepEqual(t, [], `${name}: ${JSON.stringify(t)}`);
    if (name === 'v7a_sa_spike.json') assert.ok(Object.keys(m.bom).some((k) => /soul_lantern/.test(k)) && !Object.keys(m.bom).some((k) => /:lantern$/.test(k)), `by ice the light is the soul lantern (M17): ${JSON.stringify(m.bom)}`);
  }
});

test('the refusals: NO_FEATURE {why: host}, SPAN, HEADROOM, MOVER; each with its evidence; a refused spiral writes nothing', async () => {
  const want = { 'r01_host_zone.json': 'NO_FEATURE', 'r02_span.json': 'SPAN', 'r03_headroom.json': 'HEADROOM', 'r04_mover.json': 'MOVER' };
  for (const [name, code] of Object.entries(want)) {
    const r = await run(fx('sa', name));
    const a = part(r, 'stair');
    assert.equal(a.class, 'refused', name);
    assert.equal(a.reasons[0].code, code, `${name}: ${JSON.stringify(a.reasons)}`);
    const ev = a.reasons[0].evidence;
    if (code === 'NO_FEATURE') assert.equal(ev.why, 'host');
    if (code === 'SPAN') assert.deepEqual([ev.rise, ev.min, ev.max], [3, 4, 64]);
    if (code === 'HEADROOM') assert.ok(ev.cells.some((q) => q.why === 'host'), JSON.stringify(ev));
    if (code === 'MOVER') assert.equal(ev.minWidth, 2);
    assert.equal((r.res.meta.spirals ?? []).length, 0, `${name}: nothing written`);
  }
});

test('M10:spiral on the broken variants (floating: M3 too; noRails: M8 too)', async () => {
  const want = { 'u01_floating.json': [/no solid face beside or under them/, 'M3'], 'u02_no_rails.json': [/without a rail/, 'M8'] };
  for (const [name, [re, also]] of Object.entries(want)) {
    const f = fx('sa', name);
    const r = await run(f);
    assert.equal(part(r, 'stair').class, 'fits', `${name}: the plan check never refuses an unsafe part`);
    const rep = checkOf(f, r);
    const m10 = rep.findings.filter((x) => x.rule === 'M10:spiral');
    assert.ok(m10.some((x) => re.test(x.message)), `${name}: ${m10.map((x) => x.message).join('; ')}`);
    assert.ok(rep.findings.some((x) => x.rule === also && x.part === r.res.meta.spirals[0].part), `${name}: ${also}`);
    assert.ok(!rep.metrics.spirals.per[0].ok);
  }
});

test('KC (§6, item 6): a spiral whose foot passes a fountain fits, kept clear: M25:clear 0', async () => {
  const f = fx('sa', 'k01_spiral_fountain.json');
  const r = await run(f);
  assert.equal(part(r, 'stair').class, 'fits', JSON.stringify(part(r, 'stair')));
  assert.equal(part(r, 'fount').class, 'fits', JSON.stringify(part(r, 'fount')));
  const rep = checkOf(f, r);
  assert.ok(!rep.findings.some((x) => /^M25/.test(x.rule)), rep.findings.filter((x) => /^M25/.test(x.rule)).map((x) => x.message).join('; '));
  assert.ok(rep.metrics.spirals.per[0].ok, JSON.stringify(rep.metrics.spirals.per[0]));
});

test('the roles (N-SA-1, themed): stairs of the tread role, fence rails, the deck\'s slab, the light\'s fixture (its soul variant by ice)', () => {
  const roles = { structure: 'minecraft:stone_bricks', floor: 'minecraft:spruce_planks', rail: 'minecraft:oak_fence', light: 'minecraft:lantern[hanging=false,waterlogged=false]' };
  const R = spiralRoles(roles, {});
  assert.equal(R.stairs, 'minecraft:stone_brick_stairs');
  assert.equal(R.deckSlab, 'minecraft:spruce_slab');
  assert.equal(R.rail, 'minecraft:oak_fence');
  assert.match(R.light, /^minecraft:lantern/);
  assert.match(spiralRoles(roles, {}, { cold: true }).light, /^minecraft:soul_lantern/);
  // a slot the bible names wins
  assert.equal(spiralRoles({ ...roles, path: 'minecraft:cobblestone' }, { tread: 'path' }).stairs, 'minecraft:cobblestone_stairs');
  // the cells of a plan carry those blocks, the rails joined
  const cone = discs((y) => Math.max(1, 5 - Math.floor((y - 64) / 5)), 84);
  const s = spiralPlan(cone, { kind: 'rock_spire', at: [0, 64, 0], from: [0, 40], land: flat(), hard: (x, z) => Math.abs(x) <= 6 && Math.abs(z) <= 6 });
  const cells = spiralCells(s, R, { solidAt: (x, y, z) => cone.has(`${x},${y},${z}`) || y <= 64 });
  assert.ok(cells.some((c) => c[4] === 'rail' && /north=true|south=true|east=true|west=true/.test(c[3])), 'a rail joined to a neighbour');
});

test('survival (§6): nothing free; every cell paid; targets, bottom up', () => {
  const s = hooks.survival({}, { kind: 'stairs_around' });
  assert.deepEqual(s.free, []);
  assert.equal(s.path, 'targets');
  assert.match(s.order, /bottom-up/);
});

test('determinism: three checks give identical answers and artifact shas', async () => {
  const f = fx('valid', 'v7a_sa_spire.json');
  const rs = [await run(f), await run(f), await run(f)];
  assert.ok(rs.every((r) => JSON.stringify(r.check) === JSON.stringify(rs[0].check)));
  assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha));
});
