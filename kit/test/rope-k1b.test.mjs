// (7a K1b) Rope bridges: the half-block profile (every span and rise), the span checks, the primitive's cells, the kit movers on
// half slabs, M10:rope and the broken variants (docs/CONTRACT.md "Phase 7a slice K1" §3, §5, §10 items 5 and 11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { profile, maxStep, maxRiseOf, sagOf, deckY, isSlab, checkSpan, ropeCells, slabOf, ROPE, surveyLand } from '../lib/connectors/ropeGeom.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { makeColumns, encodeColumns, FLAG_WATER } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { ropeBridge, emitRouteRopes } from '../lib/connectors/ropeGeom.mjs';

test('the profile: y2(0) = 2 y0 and y2(n) = 2 (y0 + rise) exactly, adjacent cells within one half block, for every span 8-40 and every allowed rise', () => {
  let cases = 0;
  for (const y0 of [-60, -1, 0, 64, 201]) for (let n = ROPE.spanMin; n <= ROPE.spanMax; n++) for (let rise = -maxRiseOf(n); rise <= maxRiseOf(n); rise++) {
    const ys = profile(n, y0, rise);
    assert.equal(ys.length, n + 1);
    assert.equal(ys[0], 2 * y0);
    assert.equal(ys[n], 2 * (y0 + rise));
    assert.ok(maxStep(ys) <= 1, `n ${n} rise ${rise} y0 ${y0}: step ${maxStep(ys)}`);
    cases++;
  }
  assert.equal(cases, 5 * 203);
  // spans 8-11 are flat (d = 0); the sag at mid span is about d blocks
  assert.deepEqual(profile(10, 64, 0), new Array(11).fill(128));
  assert.equal(sagOf(40), 3);
  assert.equal(Math.min(...profile(40, 64, 0)), 128 - 6);
  // the deck cell: even y2 a full block at y2/2, odd a bottom slab one above floor(y2/2)
  assert.deepEqual([deckY(128), isSlab(128), deckY(127), isSlab(127), deckY(-3), isSlab(-3)], [64, false, 64, true, -1, true]);
});

test('slab variants of deck roles; the whole-block fallback when there is none', () => {
  assert.equal(slabOf('minecraft:oak_planks'), 'minecraft:oak_slab');
  assert.equal(slabOf('minecraft:stone_bricks'), 'minecraft:stone_brick_slab');
  assert.equal(slabOf('minecraft:cobblestone'), 'minecraft:cobblestone_slab');
  assert.equal(slabOf('minecraft:spruce_log'), 'minecraft:spruce_slab');
  assert.equal(slabOf('minecraft:dirt_path'), null);
});

/** A flat survey (ground 64) with a ravine band x0..x1 at `deep` (or water over it). */
function ravine({ W = 96, D = 64, x0 = 40, x1 = 59, deep = 40, water = false, hump = null } = {}) {
  const c = makeColumns(0, 0, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const k = x + z * W;
    let g = x >= x0 && x <= x1 ? deep : 64;
    if (hump && x >= hump[0] && x <= hump[1]) g = hump[2];
    c.ground[k] = g; c.height[k] = g; c.floor[k] = water && x >= x0 && x <= x1 ? deep - 6 : g;
    if (water && x >= x0 && x <= x1) c.flags[k] = FLAG_WATER;
  }
  return c;
}
const surveyOf = (c) => ({
  groundAt: (x, z) => c.ground[x + z * c.width], topAt: (x, z) => Math.max(c.ground[x + z * c.width], c.height[x + z * c.width]), floorAt: (x, z) => c.floor[x + z * c.width],
  waterAt: (x, z) => (c.flags[x + z * c.width] & FLAG_WATER) !== 0, frozenAt: () => false, missingAt: () => false,
});

test('checkSpan: SPAN, TOO_STEEP, NO_GAP, HEADROOM and ANCHOR in that order, with evidence; a span over water is a gap', () => {
  const land = surveyLand(surveyOf(ravine()));
  assert.equal(checkSpan(land, [39, 64, 32], [1, 0], 20, 0, 2).ok, true);
  assert.equal(checkSpan(land, [38, 64, 32], [1, 0], 7, 0, 2).code, 'SPAN');
  assert.equal(checkSpan(land, [38, 64, 32], [1, 0], 41, 0, 2).code, 'SPAN');
  assert.equal(checkSpan(land, [39, 64, 32], [1, 0], 20, 3, 2).code, 'TOO_STEEP');
  const flat = surveyLand(surveyOf(ravine({ deep: 61 })));
  const ng = checkSpan(flat, [39, 64, 32], [1, 0], 20, 0, 2);
  assert.equal(ng.code, 'NO_GAP');
  assert.ok(ng.evidence.from && ng.evidence.to);
  const wet = surveyLand(surveyOf(ravine({ deep: 62, water: true })));
  const w = checkSpan(wet, [39, 64, 32], [1, 0], 20, 0, 2);
  assert.equal(w.ok, true);
  assert.equal(w.gap.over, 'water');
  const hump = surveyLand(surveyOf(ravine({ hump: [48, 50, 63] })));
  const h = checkSpan(hump, [39, 64, 32], [1, 0], 20, 0, 2);
  assert.equal(h.code, 'HEADROOM');
  assert.ok(h.evidence.cells > 0);
  // a lip of sand: the 2 cells under the near landing and its posts are LOOSE (a frozen volume's classes)
  const sand = { ...land, classAt: (x, y, z) => (x <= 39 && y >= 62 ? 'LOOSE' : land.classAt(x, y, z)) };
  const a = checkSpan(sand, [39, 64, 32], [1, 0], 20, 0, 2);
  assert.equal(a.code, 'ANCHOR');
  assert.ok(a.evidence.found.some((f) => f.class === 'LOOSE' && f.post));
  // a plan-written full block under a landing (a pad, a walk's fill) counts as site-solid
  assert.equal(checkSpan({ ...sand, written: (x) => x <= 39 }, [39, 64, 32], [1, 0], 20, 0, 2).ok, true);
  // a span whose first deck cells sag into the lip meets the land: HEADROOM
  assert.equal(checkSpan(land, [38, 64, 32], [1, 0], 22, 0, 2).code, 'HEADROOM');
});

test('ropeCells: the deck, hangers under every slab, rails, chains, four posts 2 deep, lamps every 12 and at each landing', () => {
  const g = ropeCells([38, 64, 32], [1, 0], 24, 0, 2);
  assert.equal(g.deck.filter((c) => c[4]).length, 24 * 2);
  const slabs = g.deck.filter((c) => c[3] === 'slab'), hangers = g.deck.filter((c) => c[3] === 'hanger');
  assert.equal(slabs.length, hangers.length);
  assert.equal(g.posts.length, 4);
  for (const q of g.posts) { assert.equal(q.y0, q.landing - 2); assert.equal(q.y1, q.landing + 2); }
  assert.equal(g.lamps.length, 2 + 2);
  assert.ok(g.ropes.length > 0);
  // every deck cell face-joins the next (through the hangers): M3 grounds the deck through the landings
  const cells = new Set([...g.deck, ...g.beds].map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (let i = 1; i < 24; i++) {
    const a = [...cells].filter((k) => k.startsWith(`${38 + i},`) && k.endsWith(',32')).map((k) => Number(k.split(',')[1]));
    const b = [...cells].filter((k) => k.startsWith(`${39 + i},`) && k.endsWith(',32')).map((k) => Number(k.split(',')[1]));
    assert.ok(a.some((y) => b.includes(y)), `deck cells ${i} and ${i + 1} share a y (${a} / ${b})`);
  }
});

/** An inline program: the ravine survey, one rope bridge, entrance at the near side. */
async function bridgePlan(c, opts = {}, { from = [39, 64, 32], to = [60, 64, 32] } = {}) {
  const program = { id: 'rope_t', default: (ctx) => { const r = region(ctx); r.stages(['ground', 'links']); ropeBridge(r, from, to, { width: 2, stage: 'links', id: 'rb', ...opts }); r.anchor('entrance', [30, 65, 32]); r.anchor('spawn', [30, 65, 32]); return r; } };
  const claim = { minX: 0, minZ: 0, maxX: c.width - 1, maxZ: c.depth - 1, minY: -64, maxY: 319 };
  const survey = encodeColumns(c);
  const p = await planRegion({ program, programSource: 'rope_t', survey, claim, seed: '1' });
  const rep = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta });
  return { p, rep };
}

test('the primitive over a ravine: M10:rope clean, rails (M8), head room (M6), 0 floating (M3), both movers across on the 2-wide slab deck', async () => {
  for (const [rise, to] of [[0, [60, 64, 32]], [2, [60, 66, 32]], [-2, [60, 62, 32]]]) {
    const c = ravine();
    // the far landing's ground at its y
    for (let z = 0; z < c.depth; z++) for (let x = 60; x < c.width; x++) { const k = x + z * c.width; c.ground[k] = to[1]; c.height[k] = to[1]; c.floor[k] = to[1]; }
    const { rep, p } = await bridgePlan(c, {}, { to });
    const m = rep.metrics.ropes?.per?.[0];
    assert.ok(m && m.ok, `rise ${rise}: M10:rope ${JSON.stringify(m)}`);
    assert.equal(m.cells, 20 * 2);
    assert.ok(!rep.findings.some((f) => /^M(3|6|10)/.test(f.rule)), `rise ${rise}: ${rep.findings.map((f) => `${f.rule} ${f.message}`).join('; ')}`);
    assert.equal(rep.metrics.M8.unguarded, 0, `rise ${rise}: M8 ${JSON.stringify(rep.metrics.M8.unguardedSample.slice(0, 4))}`);
    const vw = rep._world;
    for (const mover of ['player', 'villager']) {
      const g = walkGraph(vw, [[30, 65, 32]], { mover });
      assert.ok(nodeReached(g, [70, to[1] + 1, 32]), `rise ${rise}: ${mover} across`);
    }
    assert.equal(p.meta.ropes[0].id, 'rb');
    assert.equal(m.railed, 20);
    assert.equal(m.headroom, 20);
  }
});

test('broken variants: posts 1 deep (M10:rope), no rails (M8)', async () => {
  const shallow = await bridgePlan(ravine(), { _unsafe: { postDepth: 1 } });
  assert.ok(shallow.rep.findings.some((f) => f.rule === 'M10:rope' && /not 2 deep/.test(f.message)), shallow.rep.findings.map((f) => f.message).join('; '));
  const bare = await bridgePlan(ravine(), { _unsafe: { noRails: true } });
  assert.ok(bare.rep.metrics.M8.unguarded > 0);
  assert.ok(bare.rep.findings.some((f) => f.rule === 'M8'));
});

test('the whole-block profile (no slab variant): M10:rope sees the deck off the formula', async () => {
  const { rep } = await bridgePlan(ravine(), { whole: true });
  assert.ok(rep.findings.some((f) => f.rule === 'M10:rope' && /off the profile/.test(f.message)));
});

/** An inline program routing `edges` (one route pass), entrance at `at`. */
function routeProgram(intent, at, stages = ['ground', 'routes', 'links']) {
  return { id: 'rope_route', passes: ['route'], default: (ctx) => { const r = region(ctx); r.stages(stages); r.pass('route', { stage: 'routes', ...intent }); emitRouteRopes(r, { stage: 'links' }); r.anchor('entrance', at); r.anchor('spawn', at); return r; } };
}
async function routePlan(c, intent, at = [26, 65, 32]) {
  const claim = { minX: 0, minZ: 0, maxX: c.width - 1, maxZ: c.depth - 1, minY: -64, maxY: 319 };
  const survey = encodeColumns(c);
  const p = await planRegion({ program: routeProgram(intent, at), programSource: 'rope_route', survey, claim, seed: '1' });
  const rep = checkRegion({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta });
  return { p, rep };
}

test('the rope move: a rope_bridge edge spans the ravine exactly once (spanned bit), walks within its approach, and both movers cross', async () => {
  const nodes = { a: { at: [26, 65, 32] }, b: { at: [74, 65, 32] } };
  const { p, rep } = await routePlan(ravine(), { nodes, edges: [{ id: 'rb', from: 'a', to: 'b', width: 2, spans: ['rope'], spanOnce: true, movers: ['player', 'villager'] }] });
  const e = p.meta.route.edges[0];
  assert.ok(e.ok, JSON.stringify(e).slice(0, 400));
  const ropes = e.segments.filter((g) => g.kind === 'rope');
  assert.equal(ropes.length, 1);
  assert.ok(ropes[0].n >= 8 && ropes[0].n <= 40);
  const m = rep.metrics.ropes.per;
  assert.equal(m.length, 1);
  assert.ok(m[0].ok, JSON.stringify(m[0]));
  assert.ok(rep.metrics.route.edges[0].player && rep.metrics.route.edges[0].villager, JSON.stringify(rep.metrics.route.edges[0]));
  assert.ok(!rep.findings.some((f) => /^M(1|3|6|10)(:|$)/.test(f.rule)), rep.findings.map((f) => `${f.rule} ${f.message}`).join('; '));
});

test('the rope move is off without spans: the same edge walks round or fails as T2 did (no golden moves)', async () => {
  const nodes = { a: { at: [26, 65, 32] }, b: { at: [74, 65, 32] } };
  const { p } = await routePlan(ravine(), { nodes, edges: [{ id: 'w', from: 'a', to: 'b', width: 2 }] });
  assert.ok(!(p.meta.route.edges[0].segments ?? []).some((g) => g.kind === 'rope'));
});

test('a rope_bridge edge on flat ground refuses NO_GAP with evidence; over a short ditch with no approach, SPAN', async () => {
  const flat = ravine({ deep: 64 });
  const nodes = { a: { at: [26, 65, 32] }, b: { at: [74, 65, 32] } };
  const { p } = await routePlan(flat, { nodes, edges: [{ id: 'rb', from: 'a', to: 'b', width: 2, spans: ['rope'], spanOnce: true }] });
  const e = p.meta.route.edges[0];
  assert.equal(e.ok, false);
  assert.equal(e.failed, 'ROPE');
  assert.equal(e.rope.code, 'NO_GAP');
  // a 6-wide ditch between the two ends, approach 0: the only span is 7
  const ditch = ravine({ x0: 41, x1: 46 });
  const short = await routePlan(ditch, { nodes: { a: { at: [40, 65, 32] }, b: { at: [47, 65, 32] } }, edges: [{ id: 'rb', from: 'a', to: 'b', width: 2, spans: ['rope'], spanOnce: true, approach: 0 }] }, [40, 65, 32]);
  assert.equal(short.p.meta.route.edges[0].rope?.code, 'SPAN', JSON.stringify(short.p.meta.route.edges[0]));
  assert.equal(short.p.meta.route.edges[0].rope.evidence.span, 6);
});

test('links_demo (flat): bridges of 8, 24 and 40 deck cells over the raised banks; M10:rope, rails, head room, 0 dark deck cells (also under soul lanterns), both movers across, no M3/M6/M8', async () => {
  const { flatSurvey } = await import('./plan-helpers.mjs');
  const s = flatSurvey({ W: 192, D: 112, x0: 6000, z0: 6000, y: -61 });
  const programFile = new URL('../regions/links_demo.mjs', import.meta.url).pathname;
  for (const roles of [{}, { light: 'minecraft:soul_lantern' }]) {
    const p = await planRegion({ programFile, survey: s.bytes, claim: s.claim, seed: '1', roles });
    const rep = checkRegion({ ir: p.ir, survey: s.bytes, blobs: p.blobs, meta: p.meta });
    const per = rep.metrics.ropes.per;
    assert.deepEqual(per.map((q) => q.n), [8, 24, 40]);
    for (const q of per) { assert.ok(q.ok, JSON.stringify(q)); assert.equal(q.railed, q.n); assert.equal(q.headroom, q.n); }
    assert.equal(rep.metrics.M5rope.darkSpawnable, 0, `${JSON.stringify(roles)}: ${JSON.stringify(rep.metrics.M5rope)}`);
    assert.equal(rep.metrics.M5rope.deckCells, 2 * (8 + 24 + 40));
    assert.ok(!rep.findings.some((f) => /^M(1|3|6|10)(:|$)/.test(f.rule) || f.rule === 'M8'), rep.findings.map((f) => `${f.rule} ${f.message}`).join('; '));
    for (const q of p.meta.ropes) for (const mover of ['player', 'villager']) {
      const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
      assert.ok(nodeReached(walkGraph(rep._world, [a], { mover }), b), `${q.id}: ${mover} across`);
    }
    if (roles.light) assert.ok(p.meta.ropes.every((q) => q.lampEvery === 8 && /soul_lantern/.test(q.light)));
  }
});
