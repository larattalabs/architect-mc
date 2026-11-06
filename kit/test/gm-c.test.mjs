// (GM-c) The drawbridge (docs/CONTRACT.md "Slice GM" §2's drawbridge row, §5, §7, §8, §9, §10 items 2 and 5, §13 item 6): the catalogue
// flip of connector.drawbridge (against catalogue-gmc.json), both spellings (kind drawbridge; a bridge whose params name a mechanism or
// movable) answering block connector.drawbridge, v7a_gm_drawbridge over a moat 5 wide (the trapdoor deck in the path part, the circuit in
// the IR's gateMechanisms, the bill, the siteplan row, M10:bridge clean), the kit's walks over the lowered and the raised deck, the
// trapdoor deck's checks (TOO_STEEP, SPAN, HEADROOM, WATER {kind: apron}) and its width deviation, the circuit's reach from each lever in
// every heading (gmLint), determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX } from './plan-helpers.mjs';
import { run, part, svOf } from './plan-p0-shared.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { checkBridge, DRAWBRIDGE_DECK } from '../lib/connectors/bridgeGeom.mjs';
import { drawbridgeLayout, drawbridgeState } from '../lib/connectors/gmCircuit.mjs';
import { gmCost } from '../lib/connectors/gmGate.mjs';
import { bomOf } from '../lib/connectors/bom.mjs';
import { lint } from '../lib/connectors/gmLint.mjs';
import { rightOf, latOn } from '../lib/connectors/ropeGeom.mjs';
import { isDrawbridge } from '../lib/connectors/t3kinds.mjs';

const FX = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v7a_gm_drawbridge.json'), 'utf8'));
const runOf = (mut = null) => { const f = JSON.parse(JSON.stringify(FX)); if (mut) mut(f.plan.connectors.find((c) => c.id === 'drawbridge'), f); return run(f); };
const irOf = (r) => r.res.ir;
const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < flat.length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
let R0 = null;
const r0 = async () => (R0 ??= await runOf());

test('catalogue 16: connector.drawbridge flips reserved -> supported (schemaVersion 1, its limits), nothing else against catalogue-gmc.json', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const before = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-gmc.json'), 'utf8'));
  assert.equal(golden.catalogueVersion, before.catalogueVersion + 1);
  const d = diffCatalogues(before, golden);
  assert.deepEqual(d.reservedToSupported, ['connector.drawbridge']);
  assert.deepEqual(d.schemaVersionBumps, [{ id: 'connector.drawbridge', from: 0, to: 1 }]);
  assert.deepEqual([d.added, d.removed, d.retired, d.otherStateChanges], [[], [], [], []]);
  const changed = golden.entries.filter((e) => JSON.stringify(e) !== JSON.stringify(before.entries.find((x) => x.id === e.id))).map((e) => e.id);
  assert.deepEqual(changed, ['connector.drawbridge']);
  const e = golden.entries.find((x) => x.id === 'connector.drawbridge');
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
  assert.deepEqual(e.limits, { span: [1, 7], width: [2, 2], deck: ['trapdoor'], mechanism: ['redstone', 'piston'] });
  assert.equal(e.until, undefined);
});

test('plan/0: kind drawbridge and a bridge whose params name a mechanism or movable both validate as block connector.drawbridge', () => {
  const v = (c) => validatePlan({ schemaVersion: 'plan/0', connectors: [c] }, { anchors: ['a', 'b'] }).parts[0];
  const ends = { from: { anchor: 'a' }, to: { anchor: 'b' } };
  for (const c of [{ id: 'd', kind: 'drawbridge', ...ends }, { id: 'd', kind: 'bridge', params: { mechanism: 'redstone' }, ...ends }, { id: 'd', kind: 'bridge', params: { movable: true }, ...ends }, { id: 'd', kind: 'drawbridge', params: { mechanism: 'piston', movable: true }, ...ends }]) {
    const p = v(c);
    assert.equal(p.verdict, 'compile', JSON.stringify(c));
    assert.equal(p.block, 'connector.drawbridge', JSON.stringify(c));
    assert.ok(isDrawbridge(c));
  }
  // a plain bridge (or one whose mechanism is false or null) stays connector.bridge
  for (const c of [{ id: 'b', kind: 'bridge', ...ends }, { id: 'b', kind: 'bridge', params: { mechanism: false }, ...ends }, { id: 'b', kind: 'bridge', params: { movable: false }, ...ends }]) {
    assert.equal(v(c).block, 'connector.bridge', JSON.stringify(c));
    assert.ok(!isDrawbridge(c));
  }
});

test('v7a_gm_drawbridge: READY; the trapdoor deck in the path part, the circuit in gateMechanisms; the bill; the crossing, siteplan row and S-THEME', async () => {
  const r = await r0();
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'drawbridge');
  assert.equal(a.class, 'fits', JSON.stringify(a));
  assert.equal(a.block, 'connector.drawbridge');
  const [b] = a.geometry.bridges;
  assert.equal(a.geometry.bridges.length, 1);
  assert.deepEqual([b.form, b.rise, b.width, b.deck, b.piers], ['beam', 0, 2, 'trapdoor', 0]);
  assert.equal(b.n, b.trapdoors + 2 * DRAWBRIDGE_DECK.apron);
  assert.ok(b.trapdoors >= 1 && b.trapdoors <= 7);
  assert.deepEqual(b.crossing, { type: 'bridge', form: 'beam', over: 'water', depth: b.crossing.depth, clearance: 1, span: b.n, deck: 'trapdoor', movable: true });
  const m = b.mechanism;
  assert.deepEqual([m.gate, m.kind, m.rest, m.who, m.dayDriven, m.trapdoors], ['drawbridge', 'drawbridge', 'lowered', 'player', false, b.trapdoors]);
  assert.deepEqual(m.triggers.map((t) => [t.kind, t.side, t.who]), [['lever', 'near', 'player'], ['lever', 'far', 'player']]);
  // the meta record and the IR's write: the path part writes the aprons and trapdoors; the mechanism's cells are none of the part's
  const rec = r.res.meta.bridges.find((q) => q.gate === 'drawbridge');
  assert.equal(rec.deck, 'trapdoor');
  const ir = irOf(r);
  const gw = ir.gateMechanisms.find((g) => g.gate === 'drawbridge');
  assert.deepEqual([gw.kind, gw.stage, gw.bridge], ['drawbridge', rec.stage, rec.id]);
  assert.equal(gw.wall, undefined);
  const states = [];
  for (let i = 0; i + 3 < gw.base.length; i += 4) states.push(gw.palette[gw.base[i + 3]]);
  assert.equal(states.filter((s) => /lever/.test(s)).length, 2);
  assert.ok(states.every((s) => !/powered=true|power=[1-9]/.test(s)), 'written at rest: levers off, power 0');
  assert.equal(states.filter((s) => /repeater/.test(s)).length, 4 * b.trapdoors + 2);
  // the levers come last (§7 item 2's order)
  assert.ok(states.slice(-2).every((s) => /lever/.test(s)));
  const { vw } = buildVirtual({ ir, survey: svOf(FX).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
  const traps = [];
  for (const [x, y, z] of rec.cells) { const s = vw.pal.states[vw.get(x, y, z)]; if (/iron_trapdoor/.test(s)) traps.push([x, y, z, s]); }
  assert.equal(traps.length, 2 * b.trapdoors);
  assert.ok(traps.every(([, , , s]) => /half=top/.test(s) && /open=false/.test(s) && /waterlogged=false/.test(s) && /powered=false/.test(s)), 'the deck: half top, closed (lowered), not waterlogged');
  for (let i = 0; i + 3 < gw.base.length; i += 4) assert.ok(!(vw.flags(gw.base[i], gw.base[i + 1], gw.base[i + 2]) & 1), `the plan writes no mechanism cell (${gw.base.slice(i, i + 3)})`);
  // the bill: what is written (the path part's cells plus the circuit's), as gmCost reads the circuit
  const mech = [];
  for (let i = 0; i + 3 < gw.base.length; i += 4) mech.push([gw.base[i], gw.base[i + 1], gw.base[i + 2], gw.palette[gw.base[i + 3]]]);
  const mc = gmCost({ base: mech });
  assert.deepEqual(mc.bom.min, mc.bom.max, 'exact at plan time (no rung)');
  assert.deepEqual(mc.cells[0], mc.cells[1]);
  assert.deepEqual(a.cost.bom['minecraft:iron_trapdoor'], 2 * b.trapdoors);
  assert.deepEqual(a.cost.bom['minecraft:lever'], 2);
  assert.deepEqual(a.cost.bom['minecraft:repeater'], 4 * b.trapdoors + 2);
  assert.deepEqual(m.cost, mc);
  const pathStates = [];
  for (const p of ir.parts.filter((q) => q.id === rec.part)) void p;
  const sum = { ...rec.bom };
  for (const [k, n] of Object.entries(mc.bom.max)) sum[k] -= n;
  for (const k of Object.keys(sum)) if (!sum[k]) delete sum[k];
  void pathStates;
  // (the path part's own bill: the aprons and the trapdoors)
  const L = drawbridgeLayout(b.trapdoors, {});
  assert.equal(sum['minecraft:iron_trapdoor'], 2 * b.trapdoors);
  assert.equal(Object.values(sum).reduce((t, n) => t + n, 0), L.path.length);
  // the graph edge's crossing and the siteplan row
  const e = ir.graph.edges.find((q) => q.type === 'bridge');
  assert.deepEqual([e.crossing.deck, e.crossing.movable], ['trapdoor', true]);
  const sp = sitePlan({ ir, meta: r.res.meta });
  assert.deepEqual(validateSchema(sp), [], 'siteplan schema');
  const row = sp.bridges.find((q) => q.id === rec.id);
  assert.deepEqual([row.deck, row.movable, row.span, row.piers], ['trapdoor', true, b.n, []]);
  // S-THEME: the circuit and the deck trace to the roles or the functional set
  assert.deepEqual(themeOffenders(ir, vw).offenders.filter((o) => /^gm_|links/.test(o.part)), []);
  // M10:bridge on the virtual world: the deck on its profile (a closed top trapdoor is the walk's floor), no pier needed; M8 not judged
  const rep = checkRegion({ ir, survey: svOf(FX).bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded) });
  assert.deepEqual(rep.findings.filter((f) => /^M10|^M8|^M6|^M2|^M25/.test(f.rule)).map((f) => `${f.rule} ${f.message}`), []);
  const per = rep.metrics.bridges.per.find((q) => q.path === rec.id);
  assert.deepEqual([per.ok, per.deck, per.rails, per.wrong, per.missing], [true, 'trapdoor', 'mechanism', 0, 0]);
});

test('the kit\'s walks: lowered, the villager and the player cross the moat on the deck; raised (the trapdoors open), the villager does not', async () => {
  const r = await r0();
  const rec = r.res.meta.bridges.find((q) => q.gate === 'drawbridge');
  const ir = irOf(r);
  const { vw } = buildVirtual({ ir, survey: svOf(FX).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
  const from = [rec.from[0], rec.from[1] + 1, rec.from[2]], to = [rec.to[0], rec.to[1] + 1, rec.to[2]];
  for (const mover of ['villager', 'player']) assert.ok(nodeReached(walkGraph(vw, [from], { mover }), to), `lowered: the ${mover} crosses`);
  // raised: every deck trapdoor open (the circuit is the mod's; the kit flips the deck's cells as the ripple does)
  for (const [x, y, z] of rec.cells) {
    const s = vw.pal.states[vw.get(x, y, z)];
    if (/iron_trapdoor/.test(s)) vw.set(x, y, z, vw.pal.of(s.replace('open=false', 'open=true')), vw.flags(x, y, z) & ~1, vw.partAt(x, y, z));
  }
  assert.ok(!nodeReached(walkGraph(vw, [from], { mover: 'villager' }), to), 'raised: the villager does not cross (0)');
  // (the player swims H's moat: raised or lowered it reaches the far bank by water; recorded, not the drawbridge's)
  assert.ok(nodeReached(walkGraph(vw, [from], { mover: 'player' }), to), 'the player swims the moat (H\'s moat, not a drawbridge failure)');
});

test('the trapdoor deck\'s checks: level (TOO_STEEP), 1..7 trapdoor cells (SPAN), the sleepers over the water (HEADROOM), aprons off open water (WATER apron)', () => {
  // a synthetic land: ground 64, a channel of water (surface 62) at x 3..3+wd-1, every column solid soil
  const landOf = (wd, surface = 62, x0 = 3) => ({
    groundAt: (x) => (x >= x0 && x < x0 + wd ? surface : 64), topAt: (x) => (x >= x0 && x < x0 + wd ? surface : 64), waterAt: (x) => x >= x0 && x < x0 + wd,
    frozenAt: () => false, blocked: () => false, classAt: (x, y) => (y <= 64 ? 'SOIL' : 'AIR'), written: null,
  });
  const ok = checkBridge(landOf(5), [0, 65, 0], [1, 0], 9, 0, 2, { form: 'beam', deck: 'trapdoor', span: { min: 5, max: 11 } });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.deck, ok.trapdoors, ok.piers, ok.over], ['trapdoor', 5, [], 'water']);
  assert.equal(checkBridge(landOf(5), [0, 65, 0], [1, 0], 9, 1, 2, { form: 'beam', deck: 'trapdoor' }).code, 'TOO_STEEP');
  assert.equal(checkBridge(landOf(9), [0, 65, 0], [1, 0], 13, 0, 2, { form: 'beam', deck: 'trapdoor' }).code, 'SPAN');
  // the sleepers' row reaches the water's surface (a channel full to the bank, 64, under a deck at 65): HEADROOM
  const h = checkBridge(landOf(5, 64), [0, 65, 0], [1, 0], 9, 0, 2, { form: 'beam', deck: 'trapdoor' });
  assert.deepEqual([h.code, h.evidence.sample[0].why], ['HEADROOM', 'sleeper']);
  // trapdoors that do not span the whole water: an apron over open water
  const w = checkBridge(landOf(6, 62, 2), [0, 65, 0], [1, 0], 9, 0, 2, { form: 'beam', deck: 'trapdoor' });
  assert.deepEqual([w.code, w.evidence.kind], ['WATER', 'apron']);
  // every heading: the frame's lateral extent is the walk plus 3 side lanes each side
  for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const L = {
      groundAt: (x, z) => { const t = dir[0] ? Math.abs(x) : Math.abs(z); return t >= 3 && t <= 7 ? 62 : 64; },
      topAt: (x, z) => { const t = dir[0] ? Math.abs(x) : Math.abs(z); return t >= 3 && t <= 7 ? 62 : 64; },
      waterAt: (x, z) => { const t = dir[0] ? Math.abs(x) : Math.abs(z); return t >= 3 && t <= 7; },
      frozenAt: () => false, blocked: () => false, classAt: (x, y) => (y <= 64 ? 'SOIL' : 'AIR'), written: null,
    };
    assert.equal(checkBridge(L, [0, 65, 0], dir, 9, 0, 2, { form: 'beam', deck: 'trapdoor' }).ok, true, JSON.stringify(dir));
  }
});

test('a written width other than 2 is answered adjusted (deviation width); the bridge spelling answers as kind drawbridge does', async () => {
  const w3 = await runOf((c) => { c.width = 3; });
  const a = part(w3, 'drawbridge');
  assert.equal(a.class, 'adjusted');
  assert.deepEqual(a.deviations, [{ what: 'width', kind: 'width', value: 2, asked: 3 }]);
  const asBridge = await runOf((c) => { c.kind = 'bridge'; });
  const b = part(asBridge, 'drawbridge'), d = part(await r0(), 'drawbridge');
  assert.equal(b.block, 'connector.drawbridge');
  assert.deepEqual({ ...b, cached: undefined }, { ...d, cached: undefined });
});

test('the circuit: each lever alone reaches every repeater and trapdoor of the deck, in every heading (gmLint; levers ORed), and settles clean', () => {
  for (const w of [1, 3, 5, 7]) for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const L = drawbridgeLayout(w, {});
    assert.deepEqual(L.problems, [], `w ${w}`);
    const [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo } = latOn(2, dir);
    const W3 = (i, y, z) => [dx * i + rx * (z + lo), y, dz * i + rz * (z + lo)];
    const F = { north: 'n', south: 's', east: 'e', west: 'w' };
    const cells = new Map();
    const levers = [];
    for (const [i, y, z, s0] of [...L.path, ...L.mech]) {
      const s = drawbridgeState(s0, dir), p = W3(i, y, z), k = p.join(',');
      const fac = /facing=(\w+)/.exec(s)?.[1];
      if (/lever/.test(s)) { const label = levers.length ? 'far' : 'near'; levers.push(k); cells.set(k, { t: 'lever', mount: [p[0], p[1] - 1, p[2]], label }); }
      else if (/repeater/.test(s)) cells.set(k, { t: 'rep', f: F[fac] });
      else if (/redstone_wire/.test(s)) cells.set(k, { t: 'dust' });
      else if (/trapdoor/.test(s)) cells.set(k, { t: 'trap' });
      else if (/bars|fence|_wall/.test(s)) cells.set(k, { t: 'nc-bar' });
      else cells.set(k, { t: 'block' });
    }
    const out = lint(cells, {});
    assert.deepEqual(out.problems, [], `w ${w} ${dir}`);
    // (the deck's repeaters, row 0; each apron's cross-bus repeater is its own lever's)
    for (const [k, c] of cells) if (c.t === 'trap' || (c.t === 'rep' && k.split(',')[1] === '0')) assert.deepEqual([...(out.nets.get(k) ?? [])].sort(), ['far', 'near'], `w ${w} ${dir}: ${c.t} ${k}`);
    // nothing of the circuit reaches the walk's aprons' neighbours outside the frame (no trapdoor at an apron)
    assert.equal([...cells.values()].filter((c) => c.t === 'trap').length, 2 * w);
  }
});

test('determinism: 3 checks of v7a_gm_drawbridge give identical answers, IR and artifact', async () => {
  const runs = [await r0(), await runOf(), await runOf()];
  for (const k of [1, 2]) {
    assert.equal(JSON.stringify(runs[k].check.parts), JSON.stringify(runs[0].check.parts), `answers ${k + 1}`);
    assert.equal(runs[k].artifactSha, runs[0].artifactSha, `artifact ${k + 1}`);
    assert.equal(runs[k].res.irSha, runs[0].res.irSha, `IR ${k + 1}`);
  }
  void bomOf;
});

// ---- (GMc-1) far ends: Steward's RC shape (a claim_* anchor to a part across a moat, no bank or berm anchor)
const farFx = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'valid', name), 'utf8'));
const farRun = (name, mut = null) => { const f = farFx(name); if (mut) mut(f.plan.connectors.at(-1), f); return run(f); };
const moatOf = (r) => part(r, 'moat').geometry;
/** A span lies on the moat's east side: its landings either side of the water columns (around's east edge + ring .. + width - 1), close to them. */
const onMoat = (b, mo) => {
  const [x0, x1] = [Math.min(b.from[0], b.to[0]), Math.max(b.from[0], b.to[0])];
  const w0 = mo.around[2] + mo.ring, w1 = w0 + mo.width - 1;
  return b.from[2] === b.to[2] && x0 < w0 && x1 > w1 && x0 >= w0 - 6 && x1 <= w1 + 6;
};

test('GMc-1: v7a_gm_drawbridge_far (claim_e to the hamlet across the moat, approach 32): fits; the trapdoor deck on the moat, the legs walk', async () => {
  const r = await farRun('v7a_gm_drawbridge_far.json');
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'drawbridge');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.equal(a.block, 'connector.drawbridge');
  const [b] = a.geometry.bridges;
  assert.equal(a.geometry.bridges.length, 1);
  assert.deepEqual([b.form, b.rise, b.width, b.deck, b.piers, b.crossing.over], ['beam', 0, 2, 'trapdoor', 0, 'water']);
  assert.ok(b.trapdoors >= 1 && b.trapdoors <= 7 && b.n === b.trapdoors + 4);
  assert.ok(onMoat(b, moatOf(r)), `${JSON.stringify(b.from)} -> ${JSON.stringify(b.to)} on ${JSON.stringify(moatOf(r))}`);
  // the leg starts at claim_e, about 90 cells from the moat: far past the approach (32), walked on foot
  const [leg] = a.geometry.legs;
  const legFrom = leg.path[0];
  assert.ok(Math.abs(legFrom[0] - b.from[0]) > 32 + b.n, `${JSON.stringify(legFrom)} ${JSON.stringify(b.from)}`);
  assert.ok(leg.length > 2 * 32, `${leg.length}`);
  // the bill holds the walk's leg too, and the circuit's mechanism stays exact
  assert.equal(a.cost.bom['minecraft:iron_trapdoor'], 2 * b.trapdoors);
  assert.deepEqual(b.mechanism.cost.bom.min, b.mechanism.cost.bom.max);
});

test('GMc-1: approach 16 (the default) and the plain beam twin (v7a_gm_bridge_far) fit the same way', async () => {
  const r16 = await farRun('v7a_gm_drawbridge_far.json', (c) => { delete c.approach; });
  const a16 = part(r16, 'drawbridge');
  assert.equal(a16.class, 'fits', JSON.stringify(a16.reasons));
  assert.equal(a16.geometry.bridges[0].deck, 'trapdoor');
  const rb = await farRun('v7a_gm_bridge_far.json');
  assert.equal(rb.check.overall, 'READY');
  const ab = part(rb, 'moat_bridge');
  assert.equal(ab.class, 'fits', JSON.stringify(ab.reasons));
  assert.equal(ab.block, 'connector.bridge');
  const [b] = ab.geometry.bridges;
  assert.equal(ab.geometry.bridges.length, 1);
  assert.deepEqual([b.form, b.crossing.over, b.deck], ['beam', 'water', undefined]);
  assert.ok(onMoat(b, moatOf(rb)), `${JSON.stringify(b.from)} -> ${JSON.stringify(b.to)}`);
});

test('GMc-1: a moat too wide for the trapdoor deck (6 wide) answers SPAN for the crossing (12 > 11), not for the ends\' distance', async () => {
  const r = await farRun('v7a_gm_drawbridge_far.json', (c, f) => { f.plan.connectors.find((q) => q.id === 'moat').width = 6; });
  const a = part(r, 'drawbridge');
  assert.equal(a.class, 'refused');
  const [why] = a.reasons;
  assert.equal(why.code, 'SPAN', JSON.stringify(why));
  assert.deepEqual([why.evidence.min, why.evidence.max], [5, 11]);
  assert.ok(why.evidence.span > 11 && why.evidence.span <= 13, JSON.stringify(why.evidence));
  assert.match(why.message, /a drawbridge: 1\.\.7 trapdoor cells/);
  // its landing stands by the moat, not at claim_e
  assert.ok(Math.abs(why.evidence.from[0] - moatOf(r).rect[2]) <= 8, JSON.stringify(why.evidence));
});

test('GMc-1: no moat (nothing to span on the way) still answers NO_GAP, with a path wouldFit, for both kinds', async () => {
  for (const [name, id] of [['v7a_gm_drawbridge_far.json', 'drawbridge'], ['v7a_gm_bridge_far.json', 'moat_bridge']]) {
    const r = await farRun(name, (c, f) => { f.plan.connectors = f.plan.connectors.filter((q) => q.id !== 'moat'); });
    const a = part(r, id);
    assert.equal(a.class, 'refused', name);
    assert.equal(a.reasons[0].code, 'NO_GAP', JSON.stringify(a.reasons));
    assert.equal(a.wouldFit?.[0]?.fragment?.kind, 'path', name);
  }
});

test('GMc-1: the far search only after the near one: v7a_gm_drawbridge (bank to berm, 21 apart) keeps its near span', async () => {
  const r = await r0();
  const [b] = part(r, 'drawbridge').geometry.bridges;
  assert.deepEqual([b.n, b.trapdoors], [11, 7]);
  assert.deepEqual([b.from[0] <= 1170 && b.from[0] >= 1149, b.to[0] <= 1170 && b.to[0] >= 1149], [true, true]);
});
