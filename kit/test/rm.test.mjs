// (7c RM, docs/CONTRACT.md "Phase 7c" §3 row 8, "Slice RM as built") Region M15 at region scale: cantilever, necks, spans and the port
// links' joints, as warnings, on small hand-made virtual worlds (each rule caught, each exemption held), the limits' frozen names, the
// Style's span limit reaching the check through the plan meta, and checkRegion running it (warnings only, never an error).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Palette, VWorld } from '../lib/region/vworld.mjs';
import { RULES, checkRegion } from '../lib/region/check.mjs';
import { M15_RULES, M15_SPAN_TYPES, REGION_M15_LIMITS, m15LookOf, regionM15, regionM15Limits } from '../lib/region/checkM15.mjs';

const finding = (rule, part, stage, count, sample, message) => ({ rule, severity: 'warning', part: part ?? null, stage: stage ?? null, count, sample: sample.slice(0, 20), message });
const CLAIM = { minX: 0, minZ: 0, maxX: 63, maxZ: 63, minY: -64, maxY: 319 };

/**
 * A world: stone up to y 63 everywhere but the pits (a set of "x,z" columns open down to y 40, so nothing under a deck there), and the
 * parts' written cells ({part: [[x, y, z, state?]...]}).
 */
function world(parts, { pits = () => false, lots = [] } = {}) {
  const pal = new Palette();
  const stone = pal.of('minecraft:stone'), air = pal.of('minecraft:air');
  const base = (x, y, z) => (y <= 63 && !(pits(x, z) && y > 40) ? stone : air);
  const vw = new VWorld({ claim: CLAIM, palette: pal, base, colTop: () => 63 });
  const ids = Object.keys(parts);
  ids.forEach((id, pi) => { for (const [x, y, z, s] of parts[id]) vw.set(x, y, z, pal.of(s ?? 'minecraft:oak_planks'), 0, pi); });
  for (const l of lots) vw.addLot(l);
  const ir = { claim: CLAIM, parts: ids.map((id) => ({ id, stage: 'build', ops: [] })), lots, stages: ['build'] };
  return { vw, ir };
}
const run = (o, extra = {}) => regionM15({ ...o, meta: extra.meta ?? null, finding, ...(extra.limits ? { limits: extra.limits } : {}) });
const rules = (r) => r.findings.map((f) => `${f.rule}|${f.part}`);
const pitX = (x0, x1) => (x, z) => x >= x0 && x <= x1;
const line = (x0, x1, y, z) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y, z]);

test('the interface: the rule before M16, the frozen limit names, the sub-rules, the Style look read', () => {
  assert.deepEqual(RULES.slice(-2), ['M15', 'M16'], 'M15 sits just before M16 (FB keeps M16 last; every other rule\'s order unchanged)');
  assert.deepEqual(M15_RULES, ['M15:cantilever', 'M15:joint', 'M15:span', 'M15:neck']);
  assert.deepEqual({ ...REGION_M15_LIMITS, span: { ...REGION_M15_LIMITS.span } }, { cantilever: 4, neckMass: 200, span: {} });
  assert.ok(Object.isFrozen(REGION_M15_LIMITS) && Object.isFrozen(REGION_M15_LIMITS.span) && Object.isFrozen(M15_SPAN_TYPES));
  assert.deepEqual(M15_SPAN_TYPES, { rope_bridge: 'ropes' });
  assert.deepEqual(regionM15Limits(), { cantilever: 4, neckMass: 200, span: {} }, 'no Style: spans unbounded');
  assert.deepEqual(regionM15Limits({ rope_bridge: { maxSpan: 12, sagRatio: 20 }, ladder: { landingEvery: 10 } }).span, { rope_bridge: 12 });
  assert.equal(m15LookOf(null), null);
  assert.equal(m15LookOf({ ladder: { landingEvery: 10 } }), null, 'a look without a span limit records nothing');
  assert.deepEqual(m15LookOf({ rope_bridge: { maxSpan: 16, light: 'none' } }), { rope_bridge: { maxSpan: 16 } });
});

test('cantilever: a beam 6 out over a pit warns on its cells past 4; 4 out is clean', () => {
  // ground to x 9, the pit from x 10; the beam at y 64 rests on the ground to x 9 and runs out to x 15
  const six = run(world({ beam: line(5, 15, 64, 30) }, { pits: pitX(10, 40) }));
  assert.deepEqual(rules(six), ['M15:cantilever|beam']);
  assert.equal(six.findings[0].count, 2);
  assert.deepEqual(six.findings[0].sample, [[14, 64, 30], [15, 64, 30]]);
  assert.match(six.findings[0].message, /farthest 6/);
  assert.equal(six.metrics.cantileverMax, 6);
  const four = run(world({ beam: line(5, 13, 64, 30) }, { pits: pitX(10, 40) }));
  assert.deepEqual(four.findings, []);
  assert.equal(four.metrics.cantileverMax, 4);
});

test('a bracket under the beam carries it: hanging, resting and a stair step up carry the distance', () => {
  // a post down into the pit floor at x 13 holds the beam above it
  const post = Array.from({ length: 23 }, (_, i) => [13, 41 + i, 30]);
  const r = run(world({ beam: line(5, 17, 64, 30), post }, { pits: pitX(10, 40) }));
  assert.deepEqual(r.findings, [], 'the post is a support column 4 from the tip');
});

test('spans: a deck between two banks is held, not a cantilever; its span is measured and judged only by a Style limit', () => {
  // banks at x <= 9 and x >= 30; the deck from x 9 to x 30 rests on both
  const parts = { deck: line(9, 30, 64, 30) };
  const r = run(world(parts, { pits: pitX(10, 29) }));
  assert.deepEqual(r.findings, [], 'held both ways');
  assert.deepEqual(r.metrics.spans, [{ part: 'deck', type: null, length: 20, limit: null }]);
  assert.ok(r.metrics.heldMax > 4);
  // a rope_bridge part (the meta's ropes name it) under a Style maxSpan of 16: M15:span; of 24: clean
  const meta = { ropes: [{ id: 'deck_rope_1', part: 'deck' }] };
  const tight = run(world(parts, { pits: pitX(10, 29) }), { meta: { ...meta, m15: { look: { rope_bridge: { maxSpan: 16 } } } } });
  assert.deepEqual(rules(tight), ['M15:span|deck']);
  assert.match(tight.findings[0].message, /span of 20 .*rope_bridge\.maxSpan 16/);
  const loose = run(world(parts, { pits: pitX(10, 29) }), { meta: { ...meta, m15: { look: { rope_bridge: { maxSpan: 24 } } } } });
  assert.deepEqual(loose.findings, []);
  assert.deepEqual(loose.metrics.spans, [{ part: 'deck', type: 'rope_bridge', length: 20, limit: 24 }]);
  // a limit set for rope bridges never judges another part's span
  const other = run(world(parts, { pits: pitX(10, 29) }), { meta: { m15: { look: { rope_bridge: { maxSpan: 8 } } } } });
  assert.deepEqual(other.findings, []);
});

test('a sagging deck (one step down or up per cell) held by its posts is a span', () => {
  const deck = [];
  // (each step overlaps the cell before it by a face, as a rope deck's slab and full-block steps do)
  const yAt = (x) => 64 - Math.min(3, Math.floor(Math.min(x - 9, 30 - x) / 3));
  for (let x = 9; x <= 30; x++) { deck.push([x, yAt(x), 30]); if (x > 9 && yAt(x - 1) !== yAt(x)) deck.push([x, Math.max(yAt(x - 1), yAt(x)), 30]); }
  const r = run(world({ deck }, { pits: pitX(10, 29) }));
  assert.deepEqual(r.findings, []);
  assert.equal(r.metrics.spans.length, 1);
});

test('necks: a mass of more than 200 cells hanging on one cell warns; on two it does not', () => {
  // a 7x7x7 block (343 cells) over a pit, hung from a beam that bears on the bank at one cell
  const block = [];
  for (let x = 20; x <= 26; x++) for (let y = 54; y <= 60; y++) for (let z = 20; z <= 26; z++) block.push([x, y, z]);
  const hanger = Array.from({ length: 3 }, (_, i) => [23, 61 + i, 23]);
  const one = run(world({ block, hanger, arm: line(5, 23, 64, 23) }, { pits: pitX(10, 40) }), { limits: { ...regionM15Limits(), cantilever: null } });
  assert.ok(one.findings.some((f) => f.rule === 'M15:neck'), rules(one).join(' '));
  assert.ok(one.metrics.necks >= 1);
  const hanger2 = Array.from({ length: 3 }, (_, i) => [23, 61 + i, 24]);
  const wide = run(world({ block, hanger, hanger2, arm: line(5, 23, 64, 23), arm2: line(5, 23, 64, 24) }, { pits: pitX(10, 40) }), { limits: { ...regionM15Limits(), cantilever: null } });
  assert.ok(!wide.findings.some((f) => f.rule === 'M15:neck'), rules(wide).join(' '));
});

test('a floating group and a generated form are supports, never judged', () => {
  const isle = [];
  for (let x = 30; x <= 44; x++) for (let z = 23; z <= 37; z++) isle.push([x, 100, z]);
  // a deck 6 out from the island's edge (x 24..29): its two outer cells warn; the island's own cells, 7 from its edge, never do
  const o = world({ isle, deck: line(24, 29, 100, 30) }, { pits: pitX(0, 63) });
  o.ir.floating = [{ parts: ['isle'] }];
  const r = run(o);
  assert.deepEqual(rules(r), ['M15:cantilever|deck']);
  assert.equal(r.findings[0].count, 2);
  const f = world({ isle, deck: line(24, 29, 100, 30) }, { pits: pitX(0, 63) });
  f.ir.forms = [{ id: 'isle', generator: 'floatingIsland' }];
  assert.deepEqual(rules(run(f)), ['M15:cantilever|deck']);
  // not declared: the island floats (M3's), so nothing reaches a support and nothing is measured
  const loose = run(world({ isle, deck: line(24, 29, 100, 30) }, { pits: pitX(0, 63) }));
  assert.deepEqual(loose.findings, []);
  assert.equal(loose.metrics.supports, 0);
});

test('the joint: a link ending on a lot\'s port leans on the landing for a span, never for a cantilever', () => {
  // a site lot box x 40..48, its west walk port at design [0, 1, 4] -> world (40, 65, 34), out (39, 65, 34); the link's floor row at y 64
  const lot = { id: 'hut', box: { minX: 40, minY: 64, minZ: 30, maxX: 48, maxY: 72, maxZ: 38 }, site: { frame: { origin: [40, 64, 30], rotation: 'none' }, ports: [{ name: 'w', kind: 'architect:walk', at: [0, 1, 4], facing: 'west', width: 1, height: 2 }] } };
  const link = { id: 'l1', kind: 'branch_walk', from: { lot: 'hut', port: 'w', facing: 'west' }, to: { lot: 'hut2', port: 'e', facing: 'east' } };
  const pits = (x, z) => x >= 10 && x <= 39;
  // a straight deck from the bank (x 9) to the end cell (x 39): the landing holds its end, so it is a span
  const straight = world({ link_l1: line(9, 39, 64, 34) }, { pits, lots: [lot] });
  straight.ir.portLinks = [link];
  const s = run(straight);
  assert.deepEqual(s.findings, []);
  assert.equal(s.metrics.joints.length, 1, 'one end on a known lot (hut2 is not in the IR)');
  assert.deepEqual({ ...s.metrics.joints[0], dist: undefined }, { link: 'l1', lot: 'hut', port: 'w', end: [39, 65, 34], cells: 3, written: 1, dist: undefined, held: true });
  // an L: the deck comes from a post 6 south and turns at the end cell: the end hangs 6 off its post, held on no side but the landing's
  // axis, which the L leaves: a joint finding, not a plain cantilever
  const post = Array.from({ length: 24 }, (_, i) => [39, 41 + i, 40]);
  const ell = world({ link_l1: Array.from({ length: 6 }, (_, i) => [39, 64, 34 + i]), post }, { pits, lots: [lot] });
  ell.ir.portLinks = [link];
  const e = run(ell);
  assert.ok(e.findings.some((f) => f.rule === 'M15:joint' && f.part === 'link_l1'), rules(e).join(' '));
  assert.equal(e.metrics.joints[0].held, false);
  // without the port link the same cells are a plain cantilever
  const plain = run(world({ link_l1: Array.from({ length: 6 }, (_, i) => [39, 64, 34 + i]), post }, { pits, lots: [lot] }));
  assert.ok(!plain.findings.some((f) => f.rule === 'M15:joint'));
});

test('a cell with no part (a design on a realised world) holds but is never judged', () => {
  const o = world({ beam: line(5, 15, 64, 30) }, { pits: pitX(10, 40) });
  o.ir.parts = []; // every written cell reads part index 0 -> no part entry; make them part-less
  const pal = o.vw.pal;
  const vw = new VWorld({ claim: CLAIM, palette: pal, base: o.vw.base, colTop: () => 63 });
  for (const [x, y, z] of line(5, 15, 64, 30)) vw.set(x, y, z, pal.of('minecraft:oak_planks'), 0, -1);
  assert.deepEqual(run({ ir: o.ir, vw }).findings, []);
});

test('the index: a mass box too big for the dense grid falls back to a map with the same answer', () => {
  const big = { minX: 0, minZ: 0, maxX: 6000, maxZ: 6000, minY: -64, maxY: 319 };
  const mk = (stray) => {
    const pal = new Palette();
    const stone = pal.of('minecraft:stone');
    const vw = new VWorld({ claim: big, palette: pal, base: (x, y, z) => (y <= 63 && !(x >= 10 && x <= 40) ? stone : pal.of('minecraft:air')), colTop: () => 63 });
    for (const [x, y, z] of line(5, 15, 64, 30)) vw.set(x, y, z, pal.of('minecraft:oak_planks'), 0, 0);
    if (stray) vw.set(5990, 64, 5990, pal.of('minecraft:oak_planks'), 0, 1); // a far cell: the mass box is 5986 x 1 x 5961, past the grid
    return { vw, ir: { claim: big, parts: [{ id: 'beam', stage: 'build' }, { id: 'stray', stage: 'build' }], lots: [] } };
  };
  const a = run(mk(false)), b = run(mk(true));
  assert.deepEqual(a.findings, b.findings);
  assert.equal(b.metrics.mass, a.metrics.mass + 1);
});
