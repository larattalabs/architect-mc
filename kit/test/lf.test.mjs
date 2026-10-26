// (7a LF) Lifts (docs/CONTRACT.md "Phase 7a slice LF" §2-§9, items 2, 3, 4's and 5's kit halves, 6's checker half, 7, 11, 12's theme):
// the tower's geometry (two layers on every open side, the airlock's two doors, the rim's rails, a light every 6, the down column beside
// the up one, the single breach reaching nothing outside), v7a_lf_cliff (fits: the crossing, the graph edge, the body's bubble set and IR
// kind, the BOM, the siteplan row; the checker clean; the kit player up the column and back down the down column, the villager refused),
// every refusal with its evidence (NO_CLIMB with a path, SPAN 65, ANCHOR, HEADROOM, MOVER with a stair), KC (a pond at the foot: kept
// clear, M25:clear 0), the broken variants caught (one layer, one door, no light), Steward's two recorded lifts (NO_CLIMB with a path that
// fits alone; the gap tables), the catalogue flip, determinism, and lifts_demo flat (the checker clean, the movers, the rails joined and
// on something, every block themed in three bibles).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPlanLocal, checkPlanVolumes, flatSurvey, stewardAnchors, FIX, ROOT } from './plan-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { LIFT, BUBBLE, checkLift, liftLanes, liftLights, surveyLiftLand } from '../lib/connectors/liftGeom.mjs';
import { joins, splitState } from '../lib/connectors/climbGeom.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';
import { simulate, mapWorld } from '../lib/fluids/sim.mjs';
import { BLOCKS, isCube } from '../lib/blocks.mjs';
import { sitePlan } from '../lib/region/siteplan.mjs';
import { surveyApi } from '../lib/region/survey.mjs';

const read = (dir, re = /./) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && re.test(f)).sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const cliffFx = () => read('valid', /^v7a_lf_cliff/)[0];
const part = (r, id) => r.check.parts.find((a) => a.part === id);
async function run(fx, extra = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], volume: fx.volume ?? {}, ...extra });
  return { ...r, survey: s };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });
const worldOf = (r) => buildVirtual({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded) }).vw;
const fluidOps = (ir) => ir.parts.flatMap((p) => (p.ops ?? []).filter((o) => o.op === 'fluid').map((o) => ({ ...o, irPart: p.id })));

/** A land over a flat survey with a cliff: the foot at 64, the face's top at `top` for z <= 2029. */
function cliffLand(top = 94, more = {}) {
  const s = flatSurvey({ W: 160, D: 112, bands: [{ x0: 1000, z0: 2000, x1: 1159, z1: 2029, y: top }] });
  return { s, land: { ...surveyLiftLand(surveyApi(s.bytes, s.claim), { claim: s.claim }), ...more } };
}

test('§2 the tower: rows and lanes, two layers on every open side, the airlock\'s doors, the rim\'s rails, a light every 6, 3 clear over the top; the down column beside the up one', () => {
  const { land } = cliffLand(94);
  const g = checkLift(land, [1060, 64, 2033], [0, -1], {});
  assert.ok(g.ok, JSON.stringify(g.evidence));
  assert.deepEqual([g.y0, g.yT, g.rise], [64, 94, 30]);
  assert.equal(g.cost, LIFT.cost + LIFT.costPer * 30);
  const sh = g.shafts[0];
  assert.deepEqual([sh.col, sh.base, sh.top, sh.approach], [[1060, 2030], [1060, 64, 2030], [1060, 94, 2029], [1060, 64, 2033]]);
  assert.equal(sh.cells.length, 30, 'the column from y0 + 1 to yT (its top level with the face\'s)');
  const at = new Map(g.cells.map((c) => [`${c[0]},${c[1]},${c[2]}`, c]));
  // the base under the column; every cell beside a column cell (the inner layer) and the one beyond (the outer) written
  assert.equal(at.get('1060,64,2030')[3], 'base');
  // the landing walk cell (one past the top walk cell, at yT) is the route's: the tower never writes it (a survival build bills each cell once)
  assert.ok(!at.has('1060,94,2028'), 'the landing cell is not the tower\'s');
  assert.equal(at.get('1060,93,2028')?.[3], 'face', 'the face\'s second layer under it is');
  for (const [x, y, z] of sh.cells) {
    for (const [ax, az, bx, bz] of [[1059, 2030, 1058, 2030], [1061, 2030, 1062, 2030], [1060, 2031, 1060, 2032]]) {
      assert.ok(at.has(`${ax},${y},${az}`) && at.has(`${bx},${y},${bz}`), `two layers beside ${x},${y},${z} toward ${ax},${az}`);
    }
  }
  // the airlock: the inner and outer doors, lower and upper halves, facing the face
  for (const z of [2031, 2032]) {
    assert.deepEqual(at.get(`1060,65,${z}`).slice(3), ['door', 'lower', 'north']);
    assert.deepEqual(at.get(`1060,66,${z}`).slice(3), ['door', 'upper', 'north']);
  }
  // the rim's rails on the shaft's three open sides (not the face side) and the roof's open edges; nothing over the top for 3
  const rails = new Set(g.rails.map((c) => c.join(',')));
  for (const k of ['1060,96,2031', '1059,96,2030', '1061,96,2030']) assert.ok(rails.has(k), `rail ${k}`);
  assert.ok(!rails.has('1060,96,2029'), 'the face side is the exit');
  for (let y = 95; y <= 97; y++) assert.ok(!at.has(`1060,${y},2030`) || at.get(`1060,${y},2030`)[3] === 'clear', `clear over the top at ${y}`);
  // a light every 6 up the inner layer (y0 + 3, + 9, ...), alternating sides; two lamps by the outer door, one on a rail post at the top
  const lights = g.cells.filter((c) => c[3] === 'light').map((c) => c[1]).sort((u, v) => u - v);
  assert.deepEqual(lights, [67, 73, 79, 85, 91]);
  for (const [x, y, z] of sh.cells) assert.ok(lights.some((ly) => Math.abs(ly - y) <= 3), `the light within 3 of ${y}`);
  assert.equal(g.cells.filter((c) => c[3] === 'lamp').length, 3);
  // the down column: beside the up one on the right (east), the shared layer between them, its base magma
  const d = checkLift(land, [1060, 64, 2033], [0, -1], { down: true, side: 'right' });
  assert.ok(d.ok);
  assert.deepEqual(d.shafts.map((q) => [q.kind, q.col]), [['up', [1060, 2030]], ['down', [1062, 2030]]]);
  assert.deepEqual(d.lanes, liftLanes(true, 'right'));
  const dat = new Map(d.cells.map((c) => [`${c[0]},${c[1]},${c[2]}`, c]));
  assert.deepEqual(dat.get('1062,64,2030').slice(3), ['base', 'down']);
  assert.equal(dat.get('1061,80,2030')[3], 'inner', 'the shared layer');
  assert.deepEqual(BUBBLE, { up: 'minecraft:bubble_column[drag=false]', down: 'minecraft:bubble_column[drag=true]' });
});

test('§2 the down column\'s foot: its approach row walkable at y0 (a step over the foot cleared, a dip filled); on level land nothing written', () => {
  const flat = checkLift(cliffLand().land, [1060, 64, 2033], [0, -1], { down: true, side: 'right' });
  assert.ok(flat.ok);
  assert.equal(flat.cells.filter((c) => c[2] === 2033).length, 0, 'level land: the foot written nowhere');
  const step = (y) => { const s = flatSurvey({ W: 160, D: 112, bands: [{ x0: 1000, z0: 2000, x1: 1159, z1: 2029, y: 94 }, { x0: 1061, z0: 2033, x1: 1062, z1: 2033, y }] }); return surveyLiftLand(surveyApi(s.bytes, s.claim), { claim: s.claim }); };
  const up = checkLift(step(66), [1060, 64, 2033], [0, -1], { down: true, side: 'right' });
  assert.ok(up.ok);
  assert.deepEqual(up.cells.filter((c) => c[2] === 2033).map((c) => c.slice(0, 4)).sort(), [[1061, 65, 2033, 'clear'], [1061, 66, 2033, 'clear'], [1062, 65, 2033, 'clear'], [1062, 66, 2033, 'clear']]);
  const dip = checkLift(step(62), [1060, 64, 2033], [0, -1], { down: true, side: 'right' });
  assert.ok(dip.ok);
  assert.deepEqual(dip.cells.filter((c) => c[2] === 2033).map((c) => c.slice(0, 4)).sort(), [[1061, 63, 2033, 'fill'], [1061, 64, 2033, 'plinth'], [1062, 63, 2033, 'fill'], [1062, 64, 2033, 'plinth']]);
});

test('§2 (H §2.5) the single breach of any shell cell reaches nothing outside the tower: the outer layer and the face hold it', () => {
  const { land } = cliffLand(94);
  const g = checkLift(land, [1060, 64, 2033], [0, -1], { down: true, side: 'left' });
  assert.ok(g.ok);
  const stop = new Map();
  const written = new Set(g.cells.filter((c) => c[3] !== 'clear').map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (const k of written) stop.set(k, 'stop');
  const world = mapWorld(stop, (x, y, z) => (SITE_SOLID_AT(land, x, y, z) ? 'stop' : 'open'));
  const cells = g.shafts.flatMap((q) => q.cells);
  const shell = [...g.inner];
  const sim = simulate(world, [{ id: 'l', fluid: 'water', level: g.yT - 1, cells, shell }], { breach: true });
  const tower = new Set([...g.cells.map((c) => `${c[0]},${c[2]}`), ...g.faceNatural.map((c) => `${c[0]},${c[2]}`)]);
  const out = (sim.bodies[0].breach ?? []).filter(([x, , z]) => !tower.has(`${x},${z}`));
  assert.deepEqual(out, [], 'no breach cell outside the tower and its face');
  assert.ok((sim.bodies[0].breach ?? []).length > 0);
  assert.deepEqual(sim.bodies[0].spill, [], 'no spill: the top is open and a source does not rise');
  // one layer: the breach of an inner cell reaches the land outside
  const thin = checkLift(land, [1060, 64, 2033], [0, -1], { _unsafe: { oneLayer: true } });
  const tstop = new Map();
  for (const c of thin.cells) if (c[3] !== 'clear' && c[3] !== 'plinth') tstop.set(`${c[0]},${c[1]},${c[2]}`, 'stop');
  const tsim = simulate(mapWorld(tstop, (x, y, z) => (SITE_SOLID_AT(land, x, y, z) ? 'stop' : 'open')), [{ id: 'l', fluid: 'water', level: thin.yT - 1, cells: thin.shafts[0].cells, shell: thin.inner }], { breach: true });
  const ttower = new Set(thin.cells.filter((c) => c[3] !== 'plinth').map((c) => `${c[0]},${c[2]}`));
  assert.ok(tsim.bodies[0].breach.some(([x, , z]) => !ttower.has(`${x},${z}`)), 'one layer: the breach reaches outside');
});
const SITE_SOLID_AT = (land, x, y, z) => ['ROCK', 'SOIL'].includes(land.classAt(x, y, z));

test('§2 the refusals in checkLift\'s order: NO_CLIMB, SPAN, ANCHOR, HEADROOM, WATER, PROTECTED', () => {
  assert.equal(checkLift(cliffLand(66).land, [1060, 64, 2033], [0, -1]).code, 'NO_CLIMB');
  assert.equal(checkLift(cliffLand(129).land, [1060, 64, 2033], [0, -1]).code, 'SPAN');
  assert.equal(checkLift(cliffLand(94).land, [1060, 64, 2033], [0, -1], { rise: { max: 20 } }).code, 'SPAN');
  const sand = cliffLand(94, { classAt: (x, y, z) => (z >= 2028 && z <= 2029 && y > 64 && y <= 94 ? 'PLAYER' : y > (z <= 2029 ? 94 : 64) ? 'AIR' : 'ROCK') });
  const an = checkLift(sand.land, [1060, 64, 2033], [0, -1]);
  assert.deepEqual([an.code, an.evidence.why], ['ANCHOR', 'face']);
  const roof = cliffLand(94, { classAt: (x, y, z) => (y === 96 && z >= 2030 && z <= 2033 ? 'ROCK' : y > (z <= 2029 ? 94 : 64) ? 'AIR' : 'ROCK') });
  assert.equal(checkLift(roof.land, [1060, 64, 2033], [0, -1]).code, 'HEADROOM');
  const wet = cliffLand(94, { waterAt: (x, z) => x === 1061 && z === 2032 });
  assert.equal(checkLift(wet.land, [1060, 64, 2033], [0, -1]).code, 'WATER');
  const prot = cliffLand(94, { blocked: (x, z) => x === 1062 && z === 2031 });
  assert.equal(checkLift(prot.land, [1060, 64, 2033], [0, -1]).code, 'PROTECTED');
  const kept = cliffLand(94, { kept: (x, y, z) => (x === 1059 && y === 70 && z === 2032 ? { body: 'w_pond' } : null) });
  const kp = checkLift(kept.land, [1060, 64, 2033], [0, -1]);
  assert.deepEqual([kp.code, kp.evidence.kind], ['PROTECTED', 'body']);
  // the lights from the light role: a lantern stands in the niche, a sea lantern is set flush, a torch is no shell (the shaft unlit)
  assert.equal(liftLights('minecraft:lantern').shaft, 'minecraft:lantern[hanging=false,waterlogged=false]');
  assert.equal(liftLights('minecraft:sea_lantern').shaft, 'minecraft:sea_lantern');
  assert.equal(liftLights('minecraft:soul_lantern').level, 10);
  assert.equal(liftLights('minecraft:torch').shaft, null);
});

test('v7a_lf_cliff: fits; the crossing, the graph edge, the body (its bubble set, the IR kind), the BOM, the siteplan row; the checker clean; the kit player up and back down by the down column, the villager not', async () => {
  const fx = cliffFx();
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  const a = part(r, 'cliff_lift');
  assert.equal(a.class, 'fits');
  const g = a.geometry.lifts[0];
  assert.deepEqual([g.rise, g.down, g.move, g.crossing], [30, true, 'up', { type: 'lift', rise: 30, down: true }]);
  assert.equal(r.asked.length, 0, 'a lift asks no frozen volume');
  const ir = r.res.ir;
  assert.ok(ir.requires.includes('bubbleColumns') && ir.requires.includes('fluid'));
  assert.equal(ir.stages[ir.stages.length - 1], 'fluids');
  const op = fluidOps(ir).find((o) => o.part === 'cliff_lift');
  assert.ok(op, 'the lift\'s body');
  assert.deepEqual(op.bubble.map((d) => d.state), [BUBBLE.up, BUBBLE.down]);
  assert.equal(op.bubble.reduce((n, d) => n + d.cells.reduce((m, q) => m + q[3] - q[2] + 1, 0), 0), 60, 'two columns of 30');
  assert.equal(op.spill.length, 0);
  const ge = ir.graph.edges.find((e) => e.type === 'lift');
  assert.ok(ge, 'the graph edge typed lift');
  assert.deepEqual([ge.crossing, ge.movers], [{ type: 'lift', rise: 30, down: true }, ['player']]);
  // cost.bom: exactly the lift's own links part, re-counted from the virtual world (the bubble cells are water: free)
  const vw = worldOf(r);
  const pi = ir.parts.findIndex((p) => /^links_l/.test(p.id));
  const states = [];
  vw.eachWritten((x, y, z, idx, f, p) => { if (p === pi) states.push(vw.pal.states[idx]); });
  assert.deepEqual(a.cost.bom, bomOf(states));
  assert.equal(a.cost.bom['minecraft:soul_sand'], 1);
  assert.equal(a.cost.bom['minecraft:magma_block'], 1);
  const sp = sitePlan({ ir, meta: r.res.meta, planId: 'p', irSha: 'x'.repeat(64) });
  assert.deepEqual(sp.lifts.map((l) => [l.rise, l.down]), [[30, true]]);
  assert.ok(sp.waters.some((w) => w.kind === 'lift'));
  const c = checkOf(r);
  assert.deepEqual(c.findings.filter((f) => f.severity === 'error' || /^(M10|M25|M5:lift|M3)/.test(f.rule)).map((f) => `${f.rule}: ${f.message}`), []);
  const per = c.metrics.lifts.per[0];
  assert.deepEqual([per.columnBad, per.shellBad, per.doorBad, per.railBad, per.headBad, per.darkShaft, per.darkWalk], [0, 0, 0, 0, 0, 0, 0]);
  // the kit movers: the player up the column (foot to top) and back by the down column; the villager never
  const A = fx.anchors;
  assert.ok(nodeReached(walkGraph(vw, [A.foot], { mover: 'player' }), A.top), 'the player rides up');
  assert.ok(nodeReached(walkGraph(vw, [A.top], { mover: 'player' }), A.foot), 'and back down by the down column');
  assert.ok(!nodeReached(walkGraph(vw, [A.foot], { mover: 'villager' }), A.top), 'a villager never rides');
  // every column cell a bubble column of its drag in the virtual world
  for (const d of op.bubble) for (const [x, z, y0, y1] of d.cells) for (let y = y0; y <= y1; y++) assert.equal(vw.pal.states[vw.get(x, y, z)], d.state);
});

test('§3 the refusals with their evidence (lf/): NO_CLIMB with a path that fits alone, SPAN 65, ANCHOR (a player\'s sand face), HEADROOM (an overhang), MOVER (up a slope) with a stair that fits alone', async () => {
  const want = { r01_no_climb: 'NO_CLIMB', r02_span_65: 'SPAN', r03_anchor_sand: 'ANCHOR', r04_headroom: 'HEADROOM', r05_mover: 'MOVER' };
  for (const fx of read('lf', /^r0/)) {
    const r = await run(fx);
    const id = fx.expect.part, a = part(r, id);
    assert.equal(a.class, 'refused', `${fx.name}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, want[fx.name.replace('.json', '')], `${fx.name}: ${JSON.stringify(a.reasons)}`);
    if (a.reasons[0].code === 'SPAN') assert.equal(a.reasons[0].evidence.rise, 65);
    if (a.reasons[0].code === 'ANCHOR') assert.equal(a.reasons[0].evidence.why, 'face');
    if (a.reasons[0].code === 'NO_CLIMB' || a.reasons[0].code === 'MOVER') {
      const wf = a.wouldFit?.[0];
      assert.equal(wf?.fragment?.kind, a.reasons[0].code === 'NO_CLIMB' ? 'path' : 'stair', `${fx.name}: the wouldFit`);
      const alone = await run({ ...fx, plan: { ...fx.plan, connectors: fx.plan.connectors.map((q) => (q.id === id ? wf.fragment : q)) } });
      assert.equal(part(alone, id).class, 'fits', `${fx.name}: the ${wf.fragment.kind} alone: ${JSON.stringify(part(alone, id))}`);
    }
    assert.equal((r.res.meta.lifts ?? []).length, 0, `${fx.name}: a refused lift writes nothing`);
  }
});

test('§6 KC: a pond at the cliff\'s foot, placed first: the lift keeps clear (the tower moves along the face), both fit, M25:clear 0', async () => {
  const fx = read('lf', /^k01_/)[0];
  const r = await run(fx);
  assert.deepEqual(r.check.parts.map((a) => [a.part, a.class]).sort(), [['foot_pond', 'fits'], ['pond_lift', 'fits']], JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  const c = checkOf(r);
  assert.deepEqual(c.findings.filter((f) => f.rule === 'M25:clear' || f.severity === 'error').map((f) => f.message), []);
});

test('the broken variants are caught: one layer (M10:lift: the shell under 2 thick), one door (M10:lift: the airlock), no light (M10:lift: dark shaft cells; M5:lift)', async () => {
  const want = { u01_onelayer: /shell cell\(s\) under 2 thick/, u02_onedoor: /airlock door half/, u03_nolight: /dark shaft cell/ };
  for (const fx of read('lf', /^u0/)) {
    const r = await run(fx);
    assert.equal(part(r, 'cliff_lift').class, 'fits');
    const c = checkOf(r);
    const f = c.findings.filter((x) => x.rule === 'M10:lift');
    assert.equal(f.length, 1, `${fx.name}: ${JSON.stringify(c.findings.map((x) => x.rule))}`);
    const per = c.metrics.lifts.per[0];
    const key = fx.name.replace('.json', '');
    if (key === 'u01_onelayer') assert.ok(per.shellBad > 0);
    if (key === 'u02_onedoor') assert.equal(per.doorBad, 4);
    if (key === 'u03_nolight') { assert.ok(per.darkShaft > 0); assert.ok(c.findings.some((x) => x.rule === 'M5:lift')); }
    assert.ok(f[0].message.length > 0);
  }
});

test('§8 (item 3): Steward\'s recorded lifts on the asks claim: refused NO_CLIMB with a path wouldFit that fits alone; the committed gap tables', async () => {
  const { asksSurvey } = await import('./plan-helpers.mjs');
  const s = asksSurvey();
  const ask = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks-8703dbd', `${name}.json`), 'utf8')).answer.plan;
  const anchors = stewardAnchors(s.claim);
  for (const [name, id] of [['treetop_village', 'storehouse_lift'], ['upside_down', 'winch_lift']]) {
    const plan = ask(name);
    const r = await checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors });
    const a = part(r, id);
    assert.equal(a.class, 'refused', `${name}/${id}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, 'NO_CLIMB');
    assert.equal(a.wouldFit?.[0]?.fragment?.kind, 'path');
    const alone = await checkPlanLocal({ ...plan, connectors: plan.connectors.map((c) => (c.id === id ? a.wouldFit[0].fragment : c)) }, { survey: s.bytes, claim: s.claim, anchors });
    assert.equal(part(alone, id).class, 'fits', `${name}/${id}: the path alone: ${JSON.stringify(part(alone, id))}`);
  }
  const before = fs.readFileSync(path.join(FIX, 'lf', 'asks-gap-before.txt'), 'utf8'), after = fs.readFileSync(path.join(FIX, 'lf', 'asks-gap-after.txt'), 'utf8');
  assert.match(before, /connector\.lift +2\n/);
  assert.doesNotMatch(after, /^ {2}connector\.lift /m);
  const lines = (t) => t.split('\n').filter((l) => /^[a-z_]+\/[a-z_0-9]+ /.test(l));
  const moved = lines(after).filter((l, i) => l !== lines(before)[i]);
  assert.deepEqual(moved.map((l) => l.split(' ')[0]), ['treetop_village/storehouse_lift', 'upside_down/winch_lift']);
  assert.equal(lines(after).filter((l) => / malformed/.test(l)).length, 0);
});

test('item 11: the catalogue flip (connector.lift reserved -> supported, player-only, no volume), e15 off it; three checks identical (determinism)', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const e = golden.entries.find((q) => q.id === 'connector.lift');
  assert.deepEqual([e.state, e.schemaVersion, e.limits.rise, e.limits.movers], ['supported', 1, [4, 64], ['player']]);
  assert.ok(!('volume' in e.limits), 'no frozen volume');
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi));
  const pre = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7a.json'), 'utf8'));
  const d = diffCatalogues(pre, golden, {});
  assert.ok(d.reservedToSupported.includes('connector.lift') || d.reservedToSupported.some((x) => x.id === 'connector.lift'));
  const e15 = JSON.parse(fs.readFileSync(path.join(FIX, 'extension', 'e15_every_reserved_a.json'), 'utf8'));
  assert.ok(!JSON.stringify(e15.plan).includes('"lift"'));
  const shas = [];
  for (let k = 0; k < 3; k++) { const r = await run(cliffFx()); shas.push(r.artifactSha ?? JSON.stringify(r.check.parts)); }
  assert.equal(new Set(shas).size, 1, shas.join(' / '));
});

/** Noah's look: every fence or wall the lift wrote joins its neighbours and stands on something. */
function connectableFaults(ir, vw, re = /_tower$|^links_l/) {
  const parts = new Set((ir.parts ?? []).map((q, i) => (re.test(q.id) ? i : -1)).filter((i) => i >= 0));
  const st = (x, y, z) => { const s = vw.pal.states[vw.get(x, y, z)]; return s && !/^minecraft:(cave_|void_)?air$/.test(splitState(s).name) ? splitState(s) : null; };
  const bad = { sides: [], floating: [], n: 0 };
  vw.eachWritten((x, y, z, idx, f, p) => {
    if (!parts.has(p)) return;
    const s = splitState(vw.pal.states[idx]), fam = BLOCKS[s.name]?.family;
    if (fam !== 'fence' && fam !== 'wall' && fam !== 'pane') return;
    bad.n++;
    for (const [d, [dx, dz]] of Object.entries({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] })) {
      const n = st(x + dx, y, z + dz), want = joins(fam, n, d), got = fam === 'wall' ? s.props[d] !== 'none' : s.props[d] === 'true';
      if (want !== got) bad.sides.push([x, y, z, d, s.name, n?.name ?? 'air']);
    }
    const below = st(x, y - 1, z);
    if (!(below && (isCube(below) || ['slab', 'stairs', 'fence', 'wall'].includes(BLOCKS[below.name]?.family)))) bad.floating.push([x, y, z, s.name]);
  });
  return bad;
}

test('lifts_demo flat: faces 8 and 48 (the high one with a down column); the checker clean; the kit movers; the rails joined and on something; every block themed in three bibles', async () => {
  const { themeOffenders } = await import('../lib/lint/theme.mjs');
  const seen = {};
  for (const b of [null, 'g7ak1_coastal', 'g7ak1_infernal']) {
    const bib = b ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${b}.json`), 'utf8')) : {};
    const s = flatSurvey({ W: 200, D: 112 });
    const p = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'lifts_demo.mjs'), survey: s.bytes, claim: s.claim, seed: '1', params: { variant: 'flat' }, roles: bib.roles ?? {}, connectors: bib.connectors ?? undefined });
    const tag = b ?? 'default';
    const lifts = p.meta.lifts ?? [];
    assert.deepEqual(lifts.map((l) => [l.rise, l.down]), [[8, false], [48, true]], `${tag}: ${p.notes.slice(-1)}`);
    const c = checkRegion({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs.get(sha) ?? null, meta: p.meta });
    assert.deepEqual(c.findings.filter((f) => f.severity === 'error' || /^(M10|M25|M5:lift|M3)/.test(f.rule)).map((f) => `${f.rule}: ${f.message}`), [], tag);
    const { vw } = buildVirtual({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs.get(sha) ?? null });
    const A = p.ir.anchors;
    for (const t of ['low', 'high']) {
      assert.ok(nodeReached(walkGraph(vw, [A[`foot_${t}`]], { mover: 'player' }), A[`top_${t}`]), `${tag}: the player up the ${t} lift`);
      assert.ok(!nodeReached(walkGraph(vw, [A[`foot_${t}`]], { mover: 'villager' }), A[`top_${t}`]), `${tag}: no villager up the ${t} lift`);
    }
    assert.ok(nodeReached(walkGraph(vw, [A.down_high], { mover: 'player' }), A.downfoot_high), `${tag}: the player down the down column`);
    assert.ok(!nodeReached(walkGraph(vw, [A.top_low], { mover: 'player' }), A.foot_low), `${tag}: no way down the low lift (up only)`);
    assert.deepEqual(themeOffenders(p.ir, vw).offenders, [], `${tag}: unthemed blocks`);
    const bad = connectableFaults(p.ir, vw);
    assert.ok(bad.n > 10, `${tag}: rails checked: ${bad.n}`);
    assert.deepEqual(bad.sides, [], `${tag}: rail sides that disagree with their neighbours`);
    assert.deepEqual(bad.floating, [], `${tag}: rails on nothing`);
    seen[tag] = [...new Set(lifts.map((l) => `${l.shell}|${l.light}`))].join(',');
  }
  assert.equal(new Set(Object.values(seen)).size, 3, `three bibles, three shells and lights: ${JSON.stringify(seen)}`);
});
