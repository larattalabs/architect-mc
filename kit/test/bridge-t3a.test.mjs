// (6c T3a) Solid bridges: the span checks in §4's order (NO_GAP, SPAN, TOO_STEEP, HEADROOM, ANCHOR, WATER), a beam's piers, an arch's
// intrados and ring, the clearance over water, the primitive's cells, M10:bridge, M8, M6 and M5 and the broken variants, the bridge move
// in the route pass (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §5, §10 items 1, 11, 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE, checkBridge, bridgeCells, maxRiseOf, archOffset, archRise, lowestOf, piersFor, deckChoice, railOf, surveyLand } from '../lib/connectors/bridgeGeom.mjs';
import { profile, maxStep, deckY } from '../lib/connectors/ropeGeom.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { makeColumns, encodeColumns, FLAG_WATER, FLAG_FROZEN } from '../lib/region/pack.mjs';
import { region } from '../lib/region/program.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { routePass } from '../lib/region/passes/route.mjs';
import { surveyApi } from '../lib/region/survey.mjs';

/** A flat survey (ground 64) with a band x0..x1 at `deep` (dry: its ground; water: the water's top, the bed 6 under it). */
function ravine({ W = 96, D = 64, x0 = 40, x1 = 59, deep = 52, water = false, frozen = false, bank2 = null } = {}) {
  const c = makeColumns(0, 0, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const k = x + z * W, inB = x >= x0 && x <= x1;
    const g = inB ? deep : bank2 !== null && x > x1 ? bank2 : 64;
    c.ground[k] = g; c.height[k] = g; c.floor[k] = water && inB ? deep - 6 : g;
    if (water && inB) c.flags[k] = FLAG_WATER | (frozen ? FLAG_FROZEN : 0);
  }
  return c;
}
const surveyOf = (c) => ({
  groundAt: (x, z) => c.ground[x + z * c.width], topAt: (x, z) => Math.max(c.ground[x + z * c.width], c.height[x + z * c.width]), floorAt: (x, z) => c.floor[x + z * c.width],
  waterAt: (x, z) => (c.flags[x + z * c.width] & FLAG_WATER) !== 0, frozenAt: (x, z) => (c.flags[x + z * c.width] & FLAG_FROZEN) !== 0, missingAt: () => false,
});
const landOf = (opts) => surveyLand(surveyOf(ravine(opts)));

test('the profiles: a beam straight, an arch cambered, every step one half block, for every span 1-32 and allowed rise', () => {
  let cases = 0;
  for (const y0 of [-61, 0, 64]) for (let n = 1; n <= BRIDGE.spanMax; n++) for (let rise = -maxRiseOf(n); rise <= maxRiseOf(n); rise++) for (const form of ['beam', 'arch']) {
    const ys = profile(n, y0, rise, form === 'arch' ? -Math.floor(n / 12) : 0);
    assert.equal(ys[0], 2 * y0);
    assert.equal(ys[n], 2 * (y0 + rise));
    assert.ok(maxStep([...ys, 2 * (y0 + rise)]) <= 1, `${form} n ${n} rise ${rise}`);
    cases++;
  }
  assert.ok(cases > 300);
  assert.equal(maxRiseOf(1), 0);
  assert.equal(maxRiseOf(2), 1);
  assert.equal(maxRiseOf(24), 3);
  // the arch's intrados: R = max(2, floor(n / 4)), the crown R over the springing, 0 at the landings
  assert.deepEqual([archRise(4), archRise(16), archRise(24)], [2, 4, 6]);
  assert.equal(archOffset(16, 0), 0);
  assert.equal(archOffset(16, 17), 0);
  const top = Math.max(...Array.from({ length: 18 }, (_, i) => archOffset(16, i)));
  assert.ok(top >= archRise(16) - 1 && top <= archRise(16), `the crown ${top}`);
});

test('checkBridge: NO_GAP, SPAN, TOO_STEEP, HEADROOM, ANCHOR, WATER in §4\'s order, each with evidence', () => {
  // a dry ravine x 40..59 (20 wide), 12 down: a beam from 39 to 60 (n 20) fits with 2 piers, an arch too
  const land = landOf();
  const beam = checkBridge(land, [39, 64, 32], [1, 0], 20, 0, 3, { form: 'beam' });
  assert.equal(beam.ok, true, JSON.stringify(beam));
  assert.equal(beam.piers.length, piersFor(20));
  assert.equal(beam.piers.length, 2);
  const arch = checkBridge(land, [39, 64, 32], [1, 0], 20, 0, 3, { form: 'arch' });
  assert.equal(arch.ok, true, JSON.stringify(arch));
  assert.equal(checkBridge(land, [39, 64, 32], [1, 0], 20, 0, 3).form, 'arch', 'auto: the arch where it fits (ties to the arch)');
  // NO_GAP: on flat ground; a narrow drop of 1 is no gap
  assert.equal(checkBridge(land, [5, 64, 32], [1, 0], 10, 0, 2).code, 'NO_GAP');
  assert.equal(checkBridge(landOf({ x0: 40, x1: 42, deep: 63 }), [39, 64, 32], [1, 0], 3, 0, 2).code, 'NO_GAP');
  // a narrow gap: 3 wide, a drop of 2 bridges (n <= 7)
  assert.equal(checkBridge(landOf({ x0: 40, x1: 42, deep: 62 }), [39, 64, 32], [1, 0], 3, 0, 2).ok, true);
  // SPAN: an arch of 25; a bridge of 33 (the part's own span too)
  const wide = landOf({ x0: 30, x1: 62 });
  assert.equal(checkBridge(wide, [29, 64, 32], [1, 0], 33, 0, 2, { form: 'beam' }).code, 'SPAN');
  assert.equal(checkBridge(landOf({ x0: 30, x1: 54 }), [29, 64, 32], [1, 0], 25, 0, 2, { form: 'arch' }).code, 'SPAN');
  assert.equal(checkBridge(land, [39, 64, 32], [1, 0], 20, 0, 3, { form: 'beam', span: { max: 16 } }).code, 'SPAN');
  // TOO_STEEP: a far bank 4 higher over 20 (at most 2)
  const steep = landOf({ bank2: 68 });
  assert.equal(checkBridge(steep, [39, 64, 32], [1, 0], 20, 4, 3, { form: 'beam' }).code, 'TOO_STEEP');
  assert.deepEqual(checkBridge(steep, [39, 64, 32], [1, 0], 20, 4, 3, { form: 'beam' }).evidence.max, 2);
  // HEADROOM: the deck in the land (a landing below the far bank's ground)
  assert.equal(checkBridge(steep, [39, 64, 32], [1, 0], 22, 1, 3, { form: 'beam' }).code, 'HEADROOM');
  // ANCHOR: a landing 6 over the bank (more than the walk's fill of 4: nothing holds it)
  const high = checkBridge(land, [39, 70, 32], [1, 0], 20, 0, 3, { form: 'beam' });
  assert.equal(high.code, 'ANCHOR');
  assert.ok(high.evidence.found.some((f) => f.fill === 5 && f.class === 'AIR'), JSON.stringify(high.evidence));
  // ANCHOR: a pier 25 tall (a ravine 26 down: the pier from the deck to 2 under the ground)
  const deep = checkBridge(landOf({ deep: 38 }), [39, 64, 32], [1, 0], 20, 0, 3, { form: 'beam' });
  assert.equal(deep.code, 'ANCHOR');
  assert.ok(deep.evidence.depth > BRIDGE.pierDepth, JSON.stringify(deep.evidence));
  // WATER (until H): a 20-wide river under a beam needs a pier in the water
  const river = landOf({ water: true, deep: 58 });
  const wb = checkBridge(river, [37, 66, 32], [1, 0], 24, 0, 3, { form: 'beam' });
  assert.equal(wb.code, 'WATER', JSON.stringify(wb));
  assert.equal(wb.until, 'H');
  assert.equal(wb.evidence.kind, 'water');
});

test('a beam\'s piers: the fewest, at most 8 deck cells apart, evenly spaced, 2 deep in the ground, none in water', () => {
  const land = landOf({ x0: 40, x1: 63, deep: 50 }); // 24 wide, 14 down
  const c = checkBridge(land, [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam' });
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.piers.length, 3, 'a span of 24 takes 3 piers');
  const idx = [0, ...c.piers.map((p) => p.i), 25];
  for (let t = 1; t < idx.length; t++) assert.ok(idx[t] - idx[t - 1] <= BRIDGE.pierEvery, JSON.stringify(idx));
  for (const p of c.piers) for (const q of p.cols) { assert.equal(q.y0, 49, 'the pier\'s foot 2 deep (the ground 50 and 49 replaced)'); assert.equal(q.y1, 63, 'up to the deck\'s underside'); }
  // a river 6 wide in the middle with dry floor either side: the piers stand on the dry floor
  const c2 = makeColumns(0, 0, 96, 64, 1);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 96; x++) {
    const k = x + z * 96, inB = x >= 40 && x <= 63, wet = x >= 49 && x <= 54;
    c2.ground[k] = inB ? 50 : 64; c2.height[k] = c2.ground[k]; c2.floor[k] = wet ? 46 : c2.ground[k]; c2.flags[k] = wet ? FLAG_WATER : 0;
  }
  const w = checkBridge(surveyLand(surveyOf(c2)), [39, 64, 32], [1, 0], 24, 0, 3, { form: 'beam' });
  assert.ok(w.ok, JSON.stringify(w));
  for (const p of w.piers) assert.ok(p.i < 10 || p.i > 15, `pier ${p.i} off the water`);
  assert.equal(w.over, 'water');
  assert.ok(w.under.have >= 2);
});

test('an arch: the springing keeps one course under the deck at the crown, the ring is solid to the deck, the middle third clears the water', () => {
  const land = landOf({ water: true, deep: 58, x0: 42, x1: 57 }); // a 16-wide channel, its water 6 under the banks
  const c = checkBridge(land, [41, 64, 32], [1, 0], 16, 0, 3, { form: 'arch' });
  assert.ok(c.ok, JSON.stringify(c));
  let crown = 1;
  for (let i = 1; i <= 16; i++) if (archOffset(16, i) > archOffset(16, crown)) crown = i;
  assert.ok(c.intrados[crown] <= c.lowest[crown] - 1, 'one solid course under the deck at the crown');
  assert.ok(c.under.have >= 2, JSON.stringify(c.under));
  const g = bridgeCells(c, [41, 64, 32], [1, 0], 16, 0, 3);
  // the ring and spandrels: every column from the intrados (one over the water at a water column) to the deck's underside
  for (const [x, yb, yt] of g.body) {
    assert.ok(yt >= yb);
    if (x >= 42 && x <= 57) assert.ok(yb >= 59, `no write in the water at ${x}: ${yb}`);
  }
  // a clearance of 6 can't be met over that channel: HEADROOM with evidence.under {need, have}
  const h = checkBridge(land, [41, 64, 32], [1, 0], 16, 0, 3, { form: 'arch', clearance: 6 });
  assert.equal(h.code, 'HEADROOM');
  assert.equal(h.evidence.under.need, 6);
  assert.ok(h.evidence.under.have < 6);
});

test('deck and rail choices: a gravity or slab-less role falls through; the rail is the trim\'s wall block, else the rail\'s fence', () => {
  assert.deepEqual(deckChoice(['minecraft:gravel', 'minecraft:dirt_path', 'minecraft:spruce_planks']), { block: 'minecraft:spruce_planks', slab: 'minecraft:spruce_slab' });
  assert.equal(deckChoice(['minecraft:sand']), null);
  assert.equal(railOf('minecraft:stone_bricks'), 'minecraft:stone_brick_wall');
  assert.equal(railOf('minecraft:oak_planks'), 'minecraft:oak_fence');
  assert.equal(railOf('minecraft:spruce_fence'), 'minecraft:spruce_fence');
});

/** A region with a bridge over a survey: the primitive, then the checker. */
async function primitiveCase(c, a, b, opts = {}) {
  const survey = encodeColumns(c);
  const claim = { minX: 0, minZ: 0, maxX: c.width - 1, maxZ: c.depth - 1, minY: -64, maxY: 319 };
  const prog = { id: 'bridge_t', default: (ctx) => {
    const r = region(ctx);
    r.stages(['links']);
    r.bridgeSpan(a, b, { stage: 'links', width: 3, ...opts });
    r.anchor('entrance', [a[0], a[1] + 1, a[2]]);
    r.anchor('spawn', [a[0], a[1] + 1, a[2]]);
    return r;
  } };
  const res = await planRegion({ program: prog, programSource: 'bridge_t', survey, claim, seed: '1', roles: {} });
  const rep = checkRegion({ ir: res.ir, survey, blobs: res.blobs, meta: res.meta });
  return { res, rep, survey };
}

test('the primitive and the checker: beam and arch clean (M10:bridge, M8, M6, M5, M3), both movers across; the broken variants caught', async () => {
  const dry = ravine({ x0: 40, x1: 63, deep: 50 });
  for (const form of ['beam', 'arch']) {
    const { res, rep } = await primitiveCase(dry, [39, 64, 32], [64, 64, 32], { form });
    const per = rep.metrics.bridges.per[0];
    assert.ok(per.ok, `${form}: ${JSON.stringify(per)}`);
    assert.equal(per.railed, 24);
    assert.equal(per.headroom, 24);
    assert.equal(rep.metrics.M5bridge.darkSpawnable, 0, JSON.stringify(rep.metrics.M5bridge));
    assert.ok(!rep.findings.some((f) => /^(M3|M10|M8|M6|M1)/.test(f.rule)), `${form}: ${rep.findings.map((f) => `${f.rule} ${f.message}`).join('; ')}`);
    const rec = res.meta.bridges[0];
    assert.equal(rec.form, form);
    const { buildVirtual } = await import('../lib/region/vworld.mjs');
    const { vw } = buildVirtual({ ir: res.ir, survey: encodeColumns(dry), blobs: (sha) => res.blobs.get(sha) ?? null });
    for (const m of ['player', 'villager']) {
      const A = [39, 65, 32], B = [64, 65, 32];
      assert.ok(nodeReached(walkGraph(vw, [A], { mover: m }), B) && nodeReached(walkGraph(vw, [B], { mover: m }), A), `${form}: ${m} across`);
    }
  }
  // _unsafe.noPiers: M10:bridge (unsupported more than 8); noRails: M8; noLamps: M5
  const np = await primitiveCase(dry, [39, 64, 32], [64, 64, 32], { form: 'beam', _unsafe: { noPiers: true } });
  assert.ok(np.rep.findings.some((f) => f.rule === 'M10:bridge' && /support/.test(f.message)), np.rep.findings.map((f) => f.rule).join(','));
  const nr = await primitiveCase(dry, [39, 64, 32], [64, 64, 32], { form: 'beam', _unsafe: { noRails: true } });
  assert.ok(nr.rep.findings.some((f) => f.rule === 'M8'), nr.rep.findings.map((f) => f.rule).join(','));
  const nl = await primitiveCase(dry, [39, 64, 32], [64, 64, 32], { form: 'beam', _unsafe: { noLamps: true } });
  assert.ok(nl.rep.metrics.M5bridge.darkSpawnable > 0 && nl.rep.findings.some((f) => f.rule === 'M5'), JSON.stringify(nl.rep.metrics.M5bridge));
  // _unsafe.pierInWater: a beam over a 20-wide river with a pier in the water: M10:bridge (a write in water)
  const river = ravine({ water: true, deep: 58, x0: 42, x1: 61 });
  const pw = await primitiveCase(river, [39, 66, 32], [64, 66, 32], { form: 'beam', clearance: 0, _unsafe: { pierInWater: true }, floorAt: (x, z) => river.floor[x + z * river.width] });
  assert.ok(pw.rep.findings.some((f) => f.rule === 'M10:bridge' && /water/.test(f.message)), pw.rep.findings.map((f) => `${f.rule} ${f.message}`).join('; '));
  // without the variant the same beam refuses WATER (until H)
  await assert.rejects(() => primitiveCase(river, [39, 66, 32], [64, 66, 32], { form: 'beam', clearance: 0 }), /WATER/);
});

test('the bridge move: a bridge edge takes exactly one span within its approach; off without `spans`; the corridor crosses water', () => {
  const c = ravine({ water: true, deep: 58, x0: 42, x1: 57, W: 120, D: 80 });
  const edge = (extra) => ({ id: 'e', from: { at: [30, 65, 40] }, to: { at: [70, 65, 40] }, width: 3, ...extra });
  const base = { maxGrade: 0.25, edges: [] };
  // without spans: every route crosses water (T2's ROUTE_WATER)
  const t2 = routePass(c, [], { ...base, edges: [edge({})] });
  assert.equal(t2.data.edges[0].failed, 'ROUTE_WATER');
  // with a bridge: one span, its form auto
  const b = routePass(c, [], { ...base, edges: [edge({ spans: ['bridge'], once: 'bridge', approach: 16, t3: { bridge: { form: 'auto', clearance: 2, width: 3 } } })] });
  const e = b.data.edges[0];
  assert.ok(e.ok, JSON.stringify(e).slice(0, 400));
  const spans = e.segments.filter((g) => g.kind === 'bridge');
  assert.equal(spans.length, 1);
  assert.ok(spans[0].n >= 16 && spans[0].n <= 32);
  assert.equal(spans[0].over, 'water');
  assert.equal(e.bridges.length, 1);
  // the street fallback's shape (no once): spans the river too
  const f = routePass(c, [], { ...base, edges: [edge({ spans: ['bridge'], t3: { bridge: { form: 'auto', clearance: 2, width: 3, diagnose: true } } })] });
  assert.ok(f.data.edges[0].ok);
  // a bridge edge with nothing to span names it (NO_GAP)
  const flat = ravine({ x0: 200, x1: 201, W: 120, D: 80 });
  const ng = routePass(flat, [], { ...base, edges: [edge({ spans: ['bridge'], once: 'bridge', approach: 16, t3: { bridge: {} } })] });
  assert.equal(ng.data.edges[0].failed, 'BRIDGE');
  assert.equal(ng.data.edges[0].bridge.code, 'NO_GAP');
});

test('the survey api reads as the land the primitive checks against', () => {
  const c = ravine();
  const S = surveyApi(encodeColumns(c), { minX: 0, minZ: 0, maxX: 95, maxZ: 63 });
  assert.equal(S.groundAt(45, 10), 52);
  assert.equal(lowestOf(128), 64);
  assert.equal(lowestOf(127), 63);
  assert.equal(deckY(127), 64);
});
