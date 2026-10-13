// Slice T2 (docs/CONTRACT.md "Phase 6c slice T2"): the route pass, its moves and costs, the program's emission, the checker's route
// rules, route_demo, determinism and the broken variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { FLAG_TREE, makeColumns, encodeColumns } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { PASS_NAMES } from '../lib/region/passes/index.mjs';
import { DIRS, TREE_REACH, dilate, edgeColumns, footprintOf, inferMovers, polylineOf, routePass, selfClash, windowGrade } from '../lib/region/passes/route.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');

/** A survey from a height function. */
function surveyOf(W, D, g, { flags = () => 0, minX = 0, minZ = 0 } = {}) {
  const c = makeColumns(minX, minZ, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { const i = x + z * W, h = g(x, z); c.ground[i] = h; c.height[i] = h; c.floor[i] = 0; c.flags[i] = flags(x, z); }
  return c;
}
const claimOf = (W, D) => ({ minX: 0, minZ: 0, maxX: W - 1, maxZ: D - 1, minY: -64, maxY: 319 });
/** A one-pass program: `intent` (a function of ctx) for r.pass('route'), anchors at `at`. */
function prog(intent, at, extra = null) {
  return { id: 'rt_test', passes: ['route'], default: (ctx) => {
    const r = region(ctx);
    r.stages(['ground']);
    if (extra) extra(r, ctx);
    r.pass('route', typeof intent === 'function' ? intent(ctx, r) : intent);
    r.anchor('entrance', at); r.anchor('spawn', at);
    return r;
  } };
}
const plan = (program, survey, opts = {}) => planRegion({ program, programSource: opts.src ?? 'x', survey, claim: opts.claim ?? claimOf(survey.width, survey.depth), seed: '7', keepOut: opts.keepOut ?? [] });
const check = (p, survey) => checkRegion({ ir: p.ir, survey: encodeColumns(survey), blobs: p.blobs, meta: p.meta });
const ownWalks = (e) => e.segments.filter((g) => g.kind === 'walk' && !g.shared);

test('the route pass is a kit pass; movers are inferred from the ends\' kinds (S-T2-1), an explicit list wins; the grade window', () => {
  assert.ok(PASS_NAMES.includes('route'));
  assert.deepEqual(inferMovers('dwelling', 'gate'), ['player', 'villager']);
  assert.deepEqual(inferMovers('job', 'lookout'), ['player'], 'a lookout end is player-only');
  assert.deepEqual(inferMovers('watchtower', null), ['player']);
  assert.deepEqual(inferMovers(null, null), ['player', 'villager'], 'unknown ends: villagers walk it (no ladders)');
  assert.deepEqual(inferMovers('lookout', 'gate', ['player', 'villager']), ['player', 'villager'], 'the per-edge override wins');
  assert.deepEqual(windowGrade([0, 0, 0, 1, 1, 1, 1, 2, 2], 0.25), { windows: 1, bad: 0, maxRise: 2, limit: 2 });
  assert.equal(windowGrade([0, 1, 2, 3, 3, 3, 3, 3, 3], 0.25).bad, 1);
  assert.equal(DIRS.length, 8);
  // dilation: Chebyshev
  const m = new Uint8Array(25); m[12] = 1;
  assert.equal(dilate(m, 5, 5, 1).reduce((a, b) => a + b, 0), 9);
  // the primitives' lines: a polyline reproduces its cells exactly
  const cells = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 0, 1], [2, 0, 2], [2, 0, 3], [2, 0, 4]];
  const idx = polylineOf(cells);
  assert.deepEqual(idx, [0, 4, 6]);
  // footprint: each column once, the nearest centre's y
  const fp = footprintOf([[0, 5, 0], [1, 6, 0]], 3);
  assert.equal(fp.length, 12);
  assert.equal(fp.find(([x, z]) => x === 1 && z === 1)[2], 6);
  // a path that comes back over itself clashes; a switchback's legs side by side do not
  const loop = []; for (let x = 0; x < 12; x++) loop.push([x, 0, 0]); for (let z = 1; z < 4; z++) loop.push([11, 0, z]); for (let x = 11; x >= 0; x--) loop.push([x, 0, 3]);
  assert.deepEqual(selfClash(loop, 3), []);
  const back = []; for (let x = 0; x < 12; x++) back.push([x, 0, 0]); for (let z = 1; z < 3; z++) back.push([11, 0, z]); for (let x = 11; x >= 0; x--) back.push([x, 0, 2]);
  assert.ok(selfClash(back, 3).length > 0, 'legs 2 apart overlap');
});

test('flat: a straight edge is one walk on the ground, laid as a 4e ground road; the graph edge carries movers and segments', async () => {
  const s = surveyOf(64, 64, () => 64);
  const p = await plan(prog({ nodes: { a: { at: [10, 65, 32], kind: 'dwelling' }, b: { at: [50, 65, 32], kind: 'gate' } }, edges: [{ id: 'ab', from: 'a', to: 'b' }] }, [10, 32]), s);
  const e = p.meta.route.edges[0];
  assert.ok(e.ok);
  assert.deepEqual(e.movers, ['player', 'villager']);
  assert.equal(e.ladders, false);
  assert.deepEqual(e.segments.map((g) => g.kind), ['walk']);
  assert.ok(e.path.every(([, y]) => y === 64));
  assert.ok(p.ir.roads.length >= 1 && p.ir.roads[0].id.startsWith('route_ab'), 'a 4e ground road');
  const ge = p.ir.graph.edges.find((x) => x.id === 'route_ab');
  assert.deepEqual(ge.movers, ['player', 'villager']);
  assert.equal(ge.segments[0].kind, 'walk');
  assert.equal(ge.stage, 'ground');
  assert.ok(p.notes.some((n) => /^pass route: \d+\.\d s, \d+ MB; 1\/1 edges routed/.test(n)), p.notes.join('; '));
  assert.equal(p.stats.passes[0].name, 'route');
});

test('a 1:2 slope (stairs off): switchbacks emerge, at least one hairpin per 16 rise, each on its flat landing; every walk window within the grade; both movers reach', async () => {
  const W = 96, D = 160;
  const s = surveyOf(W, D, (x, z) => 64 + Math.floor((D - 1 - z) / 2));
  const gy = (z) => 64 + Math.floor((D - 1 - z) / 2) + 1;
  const p = await plan(prog({ nodes: { a: { at: [48, gy(150), 150] }, b: { at: [48, gy(10), 10] } }, edges: [{ id: 'up', from: 'a', to: 'b' }], stairs: false }, [48, 150]), s);
  const e = p.meta.route.edges[0];
  assert.ok(e.ok, e.failed);
  assert.ok(e.rise >= 60);
  assert.ok(e.landings.length >= Math.ceil(e.rise / 16), `${e.landings.length} hairpins for ${e.rise} rise`);
  for (const g of ownWalks(e)) assert.equal(windowGrade(e.path.slice(g.from, g.to + 1).map((q) => q[1]), 0.25).bad, 0);
  const rep = check(p, s);
  const vw = rep._world;
  // every landing flat at its y in the virtual world (the surface block at y, air above)
  for (const l of e.landings) for (const [x, z] of l.cells) { assert.ok(vw.pal.solid[vw.get(x, l.y, z)], `landing ${x},${z}`); assert.ok(vw.pal.passable[vw.get(x, l.y + 1, z)] && vw.pal.passable[vw.get(x, l.y + 2, z)]); }
  const m = rep.metrics.route.edges[0];
  assert.equal(m.player, true);
  assert.equal(m.villager, true);
  assert.equal(m.grade.bad, 0);
  assert.equal(rep.errors, 0);
  assert.ok(!rep.findings.some((f) => /^M[1-4]\b/.test(f.rule)), rep.findings.map((f) => f.rule).join(', '));
});

test('a cliff: a player-only edge climbs it by ladder; a villager edge never gets one (S-T2-2) and goes round; the broken variant is M2:villager', async () => {
  const W = 96, D = 96;
  const s = surveyOf(W, D, (x, z) => (x < 70 ? (z < 48 ? 74 : 64) : 64 + Math.floor(Math.max(0, Math.min(40, 68 - z)) / 4)));
  const run = (movers, unsafe = {}) => plan(prog({ nodes: { a: { at: [30, 65, 80] }, b: { at: [30, 75, 16] } }, edges: [{ id: 'c', from: 'a', to: 'b', movers }], _unsafe: unsafe }, [30, 80]), s);
  const pl = await run(['player']);
  const e = pl.meta.route.edges[0];
  assert.ok(e.ok);
  assert.equal(e.segments.filter((g) => g.kind === 'ladder').length, 1);
  assert.deepEqual(e.ladderCols[0], { x: 30, z: 48, y0: 65, y1: 74, facing: 'south' });
  const rp = check(pl, s);
  assert.equal(rp.metrics.route.edges[0].player, true, 'the player climbs it');
  assert.ok(rp.findings.every((f) => f.rule !== 'M2:villager'));
  const vg = await run(['player', 'villager']);
  const ev = vg.meta.route.edges[0];
  assert.ok(ev.ok);
  assert.equal(ev.segments.filter((g) => g.kind === 'ladder').length, 0, 'no ladder on a villager edge');
  assert.equal(check(vg, s).metrics.route.edges[0].villager, true);
  const bad = await run(['player', 'villager'], { villagerLadders: true });
  const rb = check(bad, s);
  assert.ok(rb.findings.some((f) => f.rule === 'M2:villager' && /with a ladder/.test(f.message)), 'the broken variant is caught');
});

test('keep-out: the route goes round the owner\'s rect (0 columns in it, retaining and lantern sides included), the IR records it; with the obstacle off the plan is refused KEEP_OUT', async () => {
  const s = surveyOf(96, 64, () => 64);
  const ko = [[44, 10, 52, 54]];
  const intent = (ctx) => ({ nodes: { a: { at: [10, 65, 32] }, b: { at: [86, 65, 32] } }, edges: [{ id: 'k', from: 'a', to: 'b' }], keepOut: [], _unsafe: ctx.params?.unsafe ? { noKeepOut: true } : {} });
  const p = await plan(prog(intent, [10, 32]), s, { keepOut: ko });
  assert.deepEqual(p.ir.keepOut, ko);
  const e = p.meta.route.edges[0];
  assert.ok(e.ok);
  const vw = buildVirtual({ ir: p.ir, survey: encodeColumns(s), blobs: (sha) => p.blobs.get(sha) }).vw;
  let inRect = 0;
  vw.eachWritten((x, y, z) => { if (x >= 44 && x <= 52 && z >= 10 && z <= 54) inRect++; });
  assert.equal(inRect, 0);
  for (const r of p.ir.roads) for (const [x, , z] of r.points) assert.ok(!(x >= 42 && x <= 54 && z >= 8 && z <= 56), 'a 4e road and its lanterns keep clear');
  // the unconstrained route is shorter
  const free = await plan(prog(intent, [10, 32]), s);
  assert.ok(free.meta.route.edges[0].length < e.length);
  // the obstacle off: the route runs through and the emission guard refuses the plan
  const off = { ...prog((ctx) => ({ ...intent(ctx), _unsafe: { noKeepOut: true } }), [10, 32]) };
  await assert.rejects(plan(off, s, { keepOut: ko }), /KEEP_OUT: route k writes into the keep-out rect \[44, 10, 52, 54\]/);
});

test('a tree within 6 of keep-out: no route footprint comes within 6 of it (TREE_REACH); with the guard off the route enters that zone', async () => {
  // keep-out across the north half; a tree 4 south of it; the straight line between the ends runs 6 south of the tree
  const T = [48, 34];
  const s = surveyOf(96, 64, () => 64, { flags: (x, z) => (x === T[0] && z === T[1] ? FLAG_TREE : 0) });
  const ko = [[44, 2, 52, 30]];
  assert.ok(T[1] - ko[0][3] <= TREE_REACH && T[1] > ko[0][3], 'the tree is outside the rect and within TREE_REACH of it');
  const intent = (unsafe) => () => ({ nodes: { a: { at: [10, 65, 40] }, b: { at: [86, 65, 40] } }, edges: [{ id: 't', from: 'a', to: 'b' }], keepOut: [], _unsafe: unsafe });
  const near = (e) => footprintOf(e.path, e.width).filter(([x, z]) => Math.max(Math.abs(x - T[0]), Math.abs(z - T[1])) <= TREE_REACH);
  const p = await plan(prog(intent({}), [10, 40]), s, { keepOut: ko });
  const e = p.meta.route.edges[0];
  assert.ok(e.ok);
  assert.deepEqual(near(e), [], 'no footprint column within 6 of the tree');
  const vw = buildVirtual({ ir: p.ir, survey: encodeColumns(s), blobs: (sha) => p.blobs.get(sha) }).vw;
  let written = 0;
  vw.eachWritten((x, y, z) => { if (Math.max(Math.abs(x - T[0]), Math.abs(z - T[1])) <= TREE_REACH) written++; });
  assert.equal(written, 0, 'nothing written within 6 of the tree (retaining and lantern sides included)');
  // the guard off: the same edge runs straight through the tree's reach (and still not into the rect)
  const off = await plan(prog(intent({ noTreeReach: true }), [10, 40]), s, { keepOut: ko });
  const eo = off.meta.route.edges[0];
  assert.ok(eo.ok);
  assert.ok(near(eo).length > 0, 'with the guard off the footprint enters the zone');
  assert.ok(eo.length < e.length);
});

test('water: an edge that can\'t avoid it fails with a typed note (bridges are T3); the plan goes on', async () => {
  const s = surveyOf(64, 64, () => 64, { flags: (x) => (x >= 30 && x <= 33 ? 1 : 0) });
  const p = await plan(prog({ nodes: { a: { at: [10, 65, 32] }, b: { at: [54, 65, 32] }, c: { at: [10, 65, 50] } }, edges: [{ id: 'w', from: 'a', to: 'b' }, { id: 'd', from: 'a', to: 'c' }] }, [10, 32]), s);
  const [w, d] = p.meta.route.edges;
  assert.equal(w.ok, false);
  assert.equal(w.failed, 'ROUTE_WATER');
  assert.ok(d.ok);
  assert.ok(p.notes.some((n) => /^route w \(a -> b\): ROUTE_WATER/.test(n)));
});

test('a grade-limit-off straight run on a 0.4 slope is caught as M2:grade (the broken variant)', async () => {
  const s = surveyOf(64, 96, (x, z) => 64 + Math.floor((2 * (95 - z)) / 5));
  const at = (z) => [32, 64 + Math.floor((2 * (95 - z)) / 5) + 1, z];
  const p = await plan(prog({ nodes: { a: { at: at(88) }, b: { at: at(8) } }, edges: [{ id: 'g', from: 'a', to: 'b' }], stairs: false, _unsafe: { noGrade: true } }, [32, 88]), s);
  const rep = check(p, s);
  assert.ok(rep.findings.some((f) => f.rule === 'M2:grade'), rep.findings.map((f) => f.rule).join(', '));
  assert.ok(rep.metrics.route.grade.bad > 0);
});

test('hysteresis and determinism: the same IR twice; one node moved by 4 keeps at least 80% of the other edges\' cells when the earlier routes are preferred', async () => {
  const s = surveyOf(128, 128, (x, z) => 64 + Math.floor((x + 2 * z) / 12) + (((x * 7 + z * 13) % 5) === 0 ? 1 : 0));
  const nodes = (dx) => ({ a: { at: [16, 0, 16] }, b: { at: [100, 0, 24] }, c: { at: [64 + dx, 0, 100] }, d: { at: [20, 0, 104] } });
  const fix = (ns) => Object.fromEntries(Object.entries(ns).map(([k, v]) => [k, { at: [v.at[0], s.ground[v.at[0] + v.at[2] * 128] + 1, v.at[2]] }]));
  const edges = [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }, { id: 'ad', from: 'a', to: 'd' }, { id: 'cd', from: 'c', to: 'd' }];
  const p1 = await plan(prog({ nodes: fix(nodes(0)), edges }, [16, 16]), s);
  const p1b = await plan(prog({ nodes: fix(nodes(0)), edges }, [16, 16]), s);
  assert.equal(p1.irSha, p1b.irSha, 'deterministic');
  const prefer = p1.meta.route.edges.flatMap((e) => e.path.map(([x, , z]) => [x, z]));
  const p2 = await plan(prog({ nodes: fix(nodes(4)), edges, prefer }, [16, 16]), s);
  const cells = (e) => new Set(e.path.map(([x, , z]) => `${x},${z}`));
  let kept = 0, total = 0;
  for (const id of ['ab', 'ad']) {
    const a = cells(p1.meta.route.edges.find((e) => e.id === id)), b = cells(p2.meta.route.edges.find((e) => e.id === id));
    total += a.size;
    for (const k of a) if (b.has(k)) kept++;
  }
  assert.ok(kept / total >= 0.8, `kept ${kept}/${total}`);
});

test('the columns each edge writes are each written once, at the y of the segment that owns them', () => {
  const edge = { path: [[0, 5, 0], [1, 5, 0], [2, 6, 0], [3, 7, 0], [4, 7, 0], [5, 7, 0]], segments: [{ kind: 'walk', from: 0, to: 1 }, { kind: 'stair', from: 1, to: 3 }, { kind: 'walk', from: 3, to: 5 }], landings: [], width: 3 };
  const { cols, bySeg } = edgeColumns(edge);
  assert.equal(new Set(cols.map((o) => `${o.x},${o.z}`)).size, cols.length);
  assert.ok(bySeg[1].every((o) => o.x === 2 || o.x === 3), 'the flight owns its treads');
  assert.ok(bySeg[0].every((o) => o.y === 5));
});

test('route_demo on S3\'s claim (the relief golden\'s survey): every edge routed, the villager edges walkable by villagers with no ladder, grade and checker clean, the routes lit; deterministic', async () => {
  const survey = fs.readFileSync(path.join(ROOT, 'scenarios', 'goldens', 'relief_demo', 'survey.bin'));
  const claim = { minX: 3604, minZ: -1036, maxX: 3795, maxZ: -845, minY: 22, maxY: 220 };
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'route_demo.mjs'), survey, claim, seed: '1' });
  const q = await planRegion({ programFile: path.join(KIT, 'regions', 'route_demo.mjs'), survey, claim, seed: '1' });
  assert.equal(p.irSha, q.irSha);
  const edges = p.meta.route.edges;
  assert.deepEqual(edges.map((e) => [e.id, e.ok]), [['gate_hall', true], ['hall_chapel', true], ['chapel_lookout', true]]);
  assert.deepEqual(edges.map((e) => e.movers), [['player', 'villager'], ['player', 'villager'], ['player']]);
  const rep = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta });
  assert.equal(rep.errors, 0);
  assert.ok(!rep.findings.some((f) => /^M[1-4]\b/.test(f.rule)), rep.findings.map((f) => `${f.rule} ${f.message}`).join('; '));
  for (const m of rep.metrics.route.edges) {
    assert.equal(m.player, true, m.id);
    if (m.movers.includes('villager')) { assert.equal(m.villager, true, m.id); assert.equal(m.ladders, 0); }
    assert.equal(m.grade.bad, 0, m.id);
  }
  assert.ok(rep.metrics.M5route.share < 0.01, JSON.stringify(rep.metrics.M5route));
  assert.ok(p.ir.graph.edges.length === 3 && p.ir.graph.edges.every((e) => Array.isArray(e.movers)));
});

test('route_demo flat: a hill raised in stage ground, routed through the pass\'s base; walkable and clean', async () => {
  const W = 192, D = 192;
  const s = surveyOf(W, D, () => -61, { minX: 3604, minZ: -1036 });
  const claim = { minX: 3604, minZ: -1036, maxX: 3795, maxZ: -845, minY: -64, maxY: 100 };
  const p = await planRegion({ programFile: path.join(KIT, 'regions', 'route_demo.mjs'), survey: s, claim, seed: '1' });
  assert.ok(p.meta.route.demo.flat);
  for (const e of p.meta.route.edges) assert.ok(e.ok, `${e.id} ${e.failed}`);
  assert.ok(p.ir.roads.length === 0, 'no ground roads over a raised hill');
  const rep = checkRegion({ ir: p.ir, survey: encodeColumns(s), blobs: p.blobs, meta: p.meta });
  assert.equal(rep.errors, 0);
  for (const m of rep.metrics.route.edges) { assert.equal(m.player, true, m.id); assert.equal(m.grade.bad, 0, m.id); }
});

test('routePass input checks', () => {
  const c = makeColumns(0, 0, 8, 8, 1);
  assert.throws(() => routePass(c, [], { edges: [] }), /edges/);
  assert.throws(() => routePass(c, [], { edges: [{ id: 'a', from: { at: [1, 1, 1] }, to: { at: [2, 1, 2] } }], maxGrade: 0 }), /maxGrade/);
  assert.throws(() => routePass(c, [], { edges: [{ id: 'a', from: { at: [1, 1] }, to: { at: [2, 1, 2] } }] }), /needs at/);
});
