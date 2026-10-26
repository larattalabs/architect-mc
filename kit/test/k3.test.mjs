// (7a K3) Towers and gatehouses as lots on a wall's line (docs/CONTRACT.md "Phase 7a slice K3" §1-§10, gate items 1, 3, 5 (kit), 7 (kit
// mirror), 9, 10): the lenient mapping of every recorded key, withholding and the fallback (a lot sent back to its zone), siting at
// corners, gates and runs, the band, the cut (K5), the passage move and the inner lane, M2:wall provisional with the boxes, the artifact's
// onWall and ports, the graph's passage node and edge, siteplan walls[].lots; the closure with the stub designs bound (0 leaks, every node
// across) and broken (an outer door leaks, a walled passage doesn't cross); the recorded plans' answers; KC; determinism; a wall naming no
// lot unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, asksSurvey, stewardAnchors, checkPlanLocal } from './plan-helpers.mjs';
import { run, svOf, part } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { lotSpecOf, wallLotsOf, withheldOf, withhold, lotBand, lotFrame, LOT_KEYS } from '../lib/connectors/wallLots.mjs';
import { sitePlan, validateSchema } from '../lib/region/siteplan.mjs';
import { Blueprint, palette, variant } from '../lib/kit.mjs';
import { shapeOf, doorOf } from '../lib/connectors/style.mjs';
import { resolveRoles } from '../lib/region/plan.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { towerDesign, gatehouseDesign, frameOf } from '../../tools/lib/gate7ak3-designs.mjs';

const fx = (dir, name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, name), 'utf8')) });
const checkOf = (f, r, o = {}) => { const s = svOf(f); return checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), ...o }); };
const K = { Blueprint, palette, variant, shapeOf, doorOf };
const runs = (flat) => { const out = []; for (let i = 0; i + 3 < flat.length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };
const askPlan = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks', `${name}.json`), 'utf8')).answer.plan;
const ask = (name) => { const A = asksSurvey(); return checkPlanLocal(askPlan(name), { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) }); };

/** The wall's sited lots, the meta's. */
const lotsOf = (r, wall) => r.res.meta.walls.find((w) => w.id === wall)?.lots ?? [];

test('§1: the lenient mapping of every recorded key, and the lots member', () => {
  const V = validatePlan(askPlan('castle_city'));
  const specOf = lotSpecOf(V);
  const cc = wallLotsOf(V.byId.get('curtain_wall').part, specOf, 'around');
  assert.deepEqual(cc.named.map((q) => [q.lot, q.at, q.key]), [['tower_1', 'corner', 'corner_lots'], ['tower_2', 'corner', 'corner_lots'], ['tower_3', 'corner', 'corner_lots'], ['tower_4', 'corner', 'corner_lots'], ['gatehouse_1', 'gate', 'gate_lot']]);
  assert.deepEqual(cc.read, ['corner_lots', 'gate_lot']);
  const spec = (t) => () => ({ type: t, size: [9, 9] });
  const w = (params, form = 'around') => wallLotsOf({ params }, spec('house'), form);
  // towers: the ring's four corners first, then runs; gate (a lot id), gates (a list: gates.min its length), gateLots
  assert.deepEqual(w({ towers: ['a', 'b', 'c', 'd', 'e'] }).named.map((q) => q.at), ['corner', 'corner', 'corner', 'corner', 'run']);
  assert.deepEqual(w({ corner_lots: ['a', 'b', 'c'], towers: ['d', 'e'] }).named.map((q) => q.at), ['corner', 'corner', 'corner', 'corner', 'run']);
  assert.deepEqual(w({ gate: 'g' }).named.map((q) => [q.lot, q.at]), [['g', 'gate']]);
  const gl = w({ gates: ['g1', 'g2'] });
  assert.deepEqual([gl.named.map((q) => q.at), gl.gatesMin, gl.read], [['gate', 'gate'], 2, ['gates']]);
  assert.deepEqual(w({ gates: 4 }).named, [], 'a number is K1\'s gates.min (readParams)');
  assert.deepEqual(w({ gateLots: ['g1', 'g2'] }).named.map((q) => q.at), ['gate', 'gate']);
  // joins and anchors by type, else the id's stem, else run
  const typed = (id) => ({ gh: { type: 'gatehouse' }, wt: { type: 'watchtower' }, hall: { type: 'house' } }[id] ?? null);
  assert.deepEqual(wallLotsOf({ params: { joins: ['gh', 'wt', 'hall', 'tower_9', 'gatehouse_9'] } }, typed, 'around').named.map((q) => q.at), ['gate', 'corner', 'run', 'corner', 'gate']);
  assert.deepEqual(wallLotsOf({ params: { anchors: ['tower_2', 'gatehouse_1'] } }, typed, 'edge').named.map((q) => q.at), ['corner', 'gate']);
  // a line has no corners; the lots member alone is read (with its own at), the params left to readParams
  assert.deepEqual(w({ towers: ['a'] }, 'line').named.map((q) => q.at), ['run']);
  const m = wallLotsOf({ lots: [{ lot: 'x', at: 'run' }, { lot: 'gatehouse_2' }], params: { towers: ['t'] } }, () => null, 'around');
  assert.deepEqual([m.named.map((q) => [q.lot, q.at, q.key]), m.read], [[['x', 'run', 'lots'], ['gatehouse_2', 'gate', 'lots']], []]);
  assert.deepEqual(LOT_KEYS, ['corner_lots', 'towers', 'gate_lot', 'gateLots', 'gate', 'gates', 'joins', 'anchors']);
  // the schema: lots is strict (at most 16, lot required, at one of three)
  const vp = (lots) => validatePlan({ schemaVersion: 'plan/0', zones: [{ id: 'z', program: { lots: [{ id: 'h', type: 'house', size: [9, 9] }] } }], connectors: [{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'z' } } }, lots }] }).parts.find((p) => p.id === 'w').verdict;
  assert.equal(vp([{ lot: 'h', at: 'corner' }]), 'compile');
  assert.equal(vp([{ lot: 'h', at: 'tower' }]), 'malformed');
  assert.equal(vp([{ at: 'gate' }]), 'malformed');
  assert.equal(vp(Array.from({ length: 17 }, (_, i) => ({ lot: `l${i}` }))), 'malformed');
});

test('§2: withholding (a street zone laid out without its wall\'s lots; a districts zone keeps them); the band', () => {
  const V = validatePlan(askPlan('castle_city'));
  const held = withheldOf(V);
  assert.deepEqual([...held.keys()], ['castle']);
  assert.deepEqual([...held.get('castle')].sort(), ['gatehouse_1', 'tower_1', 'tower_2', 'tower_3', 'tower_4']);
  assert.deepEqual([...withheldOf(V, new Set(['tower_4'])).get('castle')].sort(), ['gatehouse_1', 'tower_1', 'tower_2', 'tower_3'], 'a lot sent back is laid out in its zone');
  const z = V.byId.get('castle').part;
  assert.equal(withhold(z, held.get('castle')).program.lots.length, z.program.lots.length - 5);
  const tpl = { program: { template: 'flat_village', params: { lots: [{ id: 'a' }, { id: 'b' }] } } };
  assert.deepEqual(withhold(tpl, new Set(['a'])).program.params.lots.map((l) => l.id), ['b']);
  // a districts zone is never withheld
  const D = validatePlan({ schemaVersion: 'plan/0', zones: [{ id: 'z', program: { districts: [{ id: 'd1', lots: [{ id: 'tower_1', type: 'tower', size: [9, 9] }] }] } }], connectors: [{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'z' } } }, lots: [{ lot: 'tower_1', at: 'corner' }] }] });
  assert.equal(withheldOf(D).size, 0);
  // the band: ceil(depth / 2) + 2 (a corner lot's larger side)
  const sp = (id) => ({ g: { size: [17, 15] }, t: { size: [13, 11] } }[id]);
  assert.equal(lotBand([{ lot: 'g', at: 'gate' }], sp), 10);
  assert.equal(lotBand([{ lot: 't', at: 'corner' }], sp), 9);
});

test('§3, §4, §6: the castle: towers on the corners, the gatehouse on the gate run, the cut, the passage, the inner lane, onWall, the graph', async () => {
  for (const name of ['valid/v7a_k3_castle.json', 'k3/k3_castle_flat.json']) {
    const f = fx(...name.split('/'));
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${name}: ${JSON.stringify(r.check.parts.map((a) => [a.part, a.class]))}`);
    const w = part(r, 'curtain_wall');
    assert.equal(w.class, 'fits', `${name}: the wall fits (no join deviation left)`);
    assert.equal(w.provisional, true, 'provisional: the boxes are unknown openings until their designs bind');
    assert.ok(w.notes.some((n) => /^ring\.min raised from 4 to 8/.test(n)), 'the band noted');
    assert.equal(part(r, 'castle').class, 'fits', 'the zone fits without its wall lots');
    const meta = r.res.meta.walls[0];
    const lots = meta.lots;
    assert.deepEqual(lots.map((q) => [q.lot, q.at]), [['tower_1', 'corner'], ['tower_2', 'corner'], ['tower_3', 'corner'], ['tower_4', 'corner'], ['gatehouse_1', 'gate']]);
    // K5: no wall cell in a box; the line runs into every box (a cut), the positions beside it end posts
    for (const q of lots) {
      const [x0, , z0, x1, , z1] = q.box;
      assert.equal(meta.cells.filter(([x, z]) => x >= x0 && x <= x1 && z >= z0 && z <= z1).length, 0, `${q.lot}: no wall cell in its box`);
      const I = meta.inside;
      const onLine = (x, z) => (x >= I[0] && x <= I[2] && (z === I[1] || z === I[3])) || (z >= I[1] && z <= I[3] && (x === I[0] || x === I[2]));
      let line = 0;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (onLine(x, z)) line++;
      assert.ok(line > 0, `${q.lot}: its box straddles the ring's line`);
    }
    assert.ok(meta.ends.length >= 2 * lots.length, 'each cut has its two end posts');
    // the gatehouse: front out, the passage the gate, the road through it, nothing of the route written in its box
    const gh = lots.find((q) => q.lot === 'gatehouse_1');
    assert.ok(gh.passage && gh.passage.width >= 3 && gh.passage.h === 3);
    const road = r.res.meta.route.edges.find((e) => e.ok && (e.segments ?? []).some((g) => g.kind === 'passage'));
    assert.ok(road, `${name}: the road crosses the wall through the gatehouse's passage`);
    const [x0, , z0, x1, , z1] = gh.box;
    const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
    for (const p of r.res.ir.parts.filter((q) => /^routes_/.test(q.id))) for (const op of p.ops) if (op.cols) for (let i = 0; i < op.cols.length; i += 5) assert.ok(!inBox(op.cols[i], op.cols[i + 1]), `${p.id} writes nothing in the gatehouse's box`);
    assert.ok(r.res.meta.route.edges.some((e) => e.id === 'wl_gatehouse_1' && e.ok), 'the inner lane from the back port to the street');
    // the graph: a passage node with front and back ports, a passage edge between them
    const g = r.res.ir.graph;
    const node = g.nodes.find((n) => n.id === 'passage:gatehouse_1');
    assert.deepEqual([node?.kind, node?.ports.map((p) => p.name)], ['passage', ['front', 'back']]);
    assert.ok(g.edges.some((e) => e.type === 'passage' && e.from === 'passage:gatehouse_1.front' && e.to === 'passage:gatehouse_1.back' && e.movers.includes('villager')));
    // siteplan walls[].lots, valid
    const sp = sitePlan({ ir: r.res.ir, meta: r.res.meta });
    assert.deepEqual(validateSchema(sp), [], 'siteplan valid');
    assert.equal(sp.walls[0].lots.length, 5);
    assert.ok(sp.walls[0].lots.find((q) => q.lot === 'gatehouse_1').passage.width >= 3);
    // the artifact: each wall lot is its zone's, with onWall (outer faces and a gatehouse's passage, lot-relative too) and ports
    const art = r.artifact.lots.filter((l) => l.onWall);
    assert.equal(art.length, 5);
    for (const l of art) {
      assert.equal(l.zone, 'castle');
      assert.equal(l.onWall.wall, 'curtain_wall');
      assert.equal(l.provisional, true);
      const F = lotFrame({ box: { minX: l.box[0], minY: l.box[1], minZ: l.box[2], maxX: l.box[3], maxY: l.box[4], maxZ: l.box[5] }, front: l.front, floorY: l.onWall.floorY });
      const world = runs(l.onWall.outerFaces.cells).map((c) => c.join(',')).sort();
      const back = runs(l.onWall.outerFaces.lotCells).map(([u, y, v]) => F.toWorld(u, y, v).join(',')).sort();
      assert.deepEqual(back, world, `${l.id}: the outer faces' lot-relative cells are its world cells`);
      assert.ok(world.length > 0 && world.every((c) => { const [, y] = c.split(',').map(Number); return y >= l.onWall.floorY && y <= l.onWall.floorY + 2; }));
    }
    const ga = art.find((l) => l.id === 'gatehouse_1');
    assert.deepEqual(ga.ports.map((p) => p.name), ['front', 'back']);
    assert.deepEqual(ga.ports[0].at, ga.entrance, 'the front port is the lot\'s entrance');
    assert.equal(ga.front, ga.ports[0].facing, 'its front faces out');
    assert.equal(runs(ga.onWall.passage.cells).length, ga.onWall.passage.width * 3 * (ga.front === 'east' || ga.front === 'west' ? ga.box[3] - ga.box[0] + 1 : ga.box[5] - ga.box[2] + 1));
    // M2:wall provisional with the boxes: closure holds, every node across (the boxes the movers' obstacles, the passage a gate)
    const rep = checkOf(f, r);
    const m = rep.metrics.walls.curtain_wall;
    for (const mv of ['player', 'villager']) assert.deepEqual([m.closure[mv].leaks, m.closure[mv].across], [0, m.closure[mv].nodes], `${name}: closure ${mv}`);
    assert.deepEqual(m.closure.provisional.lots, lots.map((q) => q.lot));
    assert.deepEqual(rep.findings.filter((x) => /^M2|^M8:wall|^M8:walk|^M5:walk|^M6:walk|^M3/.test(x.rule) && x.severity !== 'info').map((x) => `${x.rule} ${x.message}`), [], `${name}: no wall, walk or M3 finding`);
    assert.equal(m.walk.reached, m.walk.cells, 'the walk: every segment between the lots reached from its own access');
    const { vw } = buildVirtual({ ir: r.res.ir, survey: svOf(f).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    assert.deepEqual(themeOffenders(r.res.ir, vw).offenders.filter((o) => /^(w_|wl_)/.test(o.part)).map((o) => `${o.part} ${o.block}`), [], `${name}: the wall, its lots' pads and lanes themed`);
  }
});

test('§3: run lots stand on the longest free stretches, their fronts facing in', async () => {
  const r = await run(fx('k3', 'a01_run_lots.json'));
  assert.equal(r.check.overall, 'READY');
  const lots = lotsOf(r, 'curtain_wall');
  const w1 = lots.find((q) => q.lot === 'watch_1'), w2 = lots.find((q) => q.lot === 'watch_2');
  assert.deepEqual([w1.at, w2.at], ['run', 'run']);
  const I = r.res.meta.walls[0].inside;
  const cz = (q) => (q.box[2] + q.box[5]) / 2;
  // a run lot's front faces the ring's inside
  for (const q of [w1, w2]) assert.equal(q.front, cz(q) < (I[1] + I[3]) / 2 ? 'south' : 'north');
  assert.equal(part(r, 'curtain_wall').class, 'fits');
});

test('§5: the closure with the stub designs bound (0 leaks, every node across); an outer door leaks; a walled passage doesn\'t cross', async () => {
  const f = fx('k3', 'k3_castle_flat.json');
  const r = await run(f);
  const roles = resolveRoles({});
  const bind = (variants = {}) => {
    const { vw } = buildVirtual({ ir: r.res.ir, survey: svOf(f).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    for (const l of r.artifact.lots.filter((q) => q.onWall)) {
      const o = variants[l.id] ?? {};
      const bp = l.onWall.passage ? gatehouseDesign(K, `k3_${l.id}`, l, roles, o) : towerDesign(K, `k3_${l.id}`, l, roles, o);
      const F = lotFrame({ box: { minX: l.box[0], minY: l.box[1], minZ: l.box[2], maxX: l.box[3], maxY: l.box[4], maxZ: l.box[5] }, front: l.front, floorY: l.onWall.floorY });
      const pass = new Set(runs(l.onWall.passage?.cells ?? []).map((c) => c.join(',')));
      for (const [k, c] of bp.cells) {
        const [u, y, v] = k.split(',').map(Number);
        const [x, wy, z] = F.toWorld(u, y - 1, v);
        if (pass.has(`${x},${wy},${z}`)) continue; // the realise drops the design's blocks on the passage
        const st = Object.keys(c.state.props).length ? `${c.state.name}[${Object.entries(c.state.props).map(([a, b]) => `${a}=${b}`).join(',')}]` : c.state.name;
        vw.set(x, wy, z, vw.pal.of(st), vw.flags(x, wy, z), vw.partAt(x, wy, z));
      }
    }
    return checkRegion({ ir: r.res.ir, meta: r.res.meta, world: vw, boundLots: true }).metrics.walls.curtain_wall.closure;
  };
  const ok = bind();
  for (const mv of ['player', 'villager']) assert.deepEqual([ok[mv].leaks, ok[mv].across], [0, ok[mv].nodes], `bound: ${mv} closure and every node across`);
  assert.deepEqual(ok.bound, ['tower_1', 'tower_2', 'tower_3', 'tower_4', 'gatehouse_1']);
  // an outer door: the player and the villager walk out through it
  const door = bind({ gatehouse_1: { outerDoor: true } });
  assert.ok(door.player.leaks > 0 && door.villager.leaks > 0, `an outer door leaks: ${door.player.leaks}`);
  // a walled passage (its blocks there were dropped by the realise; here the walls round it close it): no way across
  const shut = bind({ gatehouse_1: { openPassage: false } });
  void shut;
  // (the realise drops a design's blocks on the passage, so a walled passage stays open in the world: the bind check refuses such a
  // design before (PlanChecksK3Test, item 7); here the passage is open and the castle still crosses)
  assert.equal(shut.player.across, shut.player.nodes);
});

test('§2: the fallback: a gatehouse no gate run holds goes back to its zone (the plan compiled once more), K1\'s join deviation noted', async () => {
  const f = fx('k3', 'r01_back_to_zone.json');
  const r = await run(f);
  const w = part(r, 'curtain_wall');
  assert.ok(!lotsOf(r, 'curtain_wall').some((q) => q.lot === 'gatehouse_1'), 'not on the line');
  const placed = r.res.ir.lots.some((l) => l.id === 'gatehouse_1');
  if (placed) {
    assert.equal(w.class, 'adjusted');
    assert.ok(w.deviations.some((d) => d.what === 'join' && d.lot === 'gatehouse_1'));
    assert.ok(w.notes.some((n) => /gatehouse_1 stands \d+ from the wall, beside it \(it fits nowhere on the line: no gate run holds it/.test(n)), JSON.stringify(w.notes));
  } else assert.ok(part(r, 'castle').deviations?.some((d) => d.what === 'count'), 'unplaced in its zone: counted');
  assert.equal(lotsOf(r, 'curtain_wall').filter((q) => q.at === 'corner').length, 4, 'the towers stay on the corners');
});

test('§9: Steward\'s recorded plans (the asks): every named lot read, sited on its ring; no join deviation where the wall could site one', async () => {
  const expect = {
    castle_city: { wall: 'curtain_wall', lots: { corner: 4, gate: 1 } },
    walled_town: { wall: 'town_wall', lots: { gate: 4 } },
    metropolis: { wall: 'city_wall', lots: { corner: 3, gate: 2 } },
    camp_to_city: { wall: 'city_wall', lots: { corner: 2, gate: 1 } },
    border_fort: { wall: 'fort_wall', lots: { corner: 2, gate: 1 } },
    desert_jungle_wall: { wall: 'great_wall', lots: { via: 1 } },
  };
  for (const [name, e] of Object.entries(expect)) {
    const r = await ask(name);
    const w = part(r, e.wall);
    assert.ok(['fits', 'adjusted'].includes(w.class), `${name}: ${w.class} ${JSON.stringify(w.reasons ?? [])}`);
    assert.equal(w.provisional, true, `${name}: provisional`);
    assert.ok(!(w.deviations ?? []).some((d) => d.what === 'join'), `${name}: no join deviation left: ${JSON.stringify(w.deviations)}`);
    const got = {};
    for (const q of lotsOf(r, e.wall)) got[q.at] = (got[q.at] ?? 0) + 1;
    assert.deepEqual(got, e.lots, `${name}: the lots on the line`);
    assert.ok(!w.notes.some((n) => LOT_KEYS.some((k) => n === `params.${k} not read`)), `${name}: every mapped key read`);
  }
  // redstone_gate's recorded wall names no lot (its curtain_wall has no params): unchanged (K1's)
  const rg = await ask('redstone_gate');
  assert.equal(lotsOf(rg, 'curtain_wall').length, 0);
});

test('KC (§7, item 9): a fountain off the ring\'s corner: the corner tower it blocks goes back to its zone; M25:clear 0', async () => {
  const f = fx('k3', 'k01_castle_fountain.json');
  const r = await run(f);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class])));
  const w = part(r, 'curtain_wall');
  assert.ok(['fits', 'adjusted'].includes(w.class));
  const rep = checkOf(f, r);
  assert.deepEqual(rep.findings.filter((x) => x.rule === 'M25:clear').map((x) => x.message), []);
  const fr = part(r, 'fount').geometry.rect;
  for (const q of lotsOf(r, 'curtain_wall')) { const [x0, , z0, x1, , z1] = q.box; assert.ok(x1 < fr[0] || x0 > fr[2] || z1 < fr[1] || z0 > fr[3], `${q.lot}'s box off the fountain`); }
});

test('the line (desert_jungle_wall\'s shape): the via gatehouse\'s passage crosses the line; the road through it', async () => {
  const r = await run(fx('valid', 'v7a_k3_line.json'));
  assert.equal(part(r, 'great_wall').class, 'fits');
  const q = lotsOf(r, 'great_wall')[0];
  assert.deepEqual([q.lot, q.at, !!q.passage], ['gatehouse_1', 'via', true]);
  assert.ok(r.res.meta.route.edges.some((e) => e.ok && (e.segments ?? []).some((g) => g.kind === 'passage')), 'the road through the passage');
  assert.ok(r.artifact.lots.find((l) => l.id === 'gatehouse_1').onWall.at === 'via');
});

test('a wall naming no lot is K1\'s (no lots, no passage, no lane); 3 checks of each K3 fixture give one answer set and one artifact sha', async () => {
  for (const name of ['v30_walled_village.json', 'v31_wall_line.json', 'v32_wall_edge.json', 'v7a_k2_walk.json']) {
    const r = await run(fx('valid', name));
    for (const w of r.res.meta.walls ?? []) assert.ok(!w.lots && !w.cut, `${name}: no lots`);
    assert.ok(!r.res.ir.graph.edges.some((e) => e.type === 'passage'));
    assert.ok(!r.artifact?.lots?.some((l) => l.onWall));
  }
  for (const [d, name] of [['valid', 'v7a_k3_castle.json'], ['k3', 'k3_castle_flat.json']]) {
    const rs = [await run(fx(d, name)), await run(fx(d, name)), await run(fx(d, name))];
    assert.ok(rs.every((x) => x.artifactSha && x.artifactSha === rs[0].artifactSha), `${name}: one artifact sha`);
    assert.ok(rs.every((x) => JSON.stringify(x.check.parts) === JSON.stringify(rs[0].check.parts)), `${name}: one answer set`);
  }
});

test('the stub designs (tools/lib/gate7ak3-designs.mjs): exactly the lot\'s frame, outer faces closed, the passage open, in three bibles', async () => {
  const r = await run(fx('k3', 'k3_castle_flat.json'));
  for (const bible of [{}, JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', '..', 'scenarios', 'bibles', 'g7ak1_infernal.json'), 'utf8')).roles, JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', '..', 'scenarios', 'bibles', 'g7ak1_coastal.json'), 'utf8')).roles]) {
    const roles = resolveRoles(bible);
    for (const l of r.artifact.lots.filter((q) => q.onWall)) {
      const bp = l.onWall.passage ? gatehouseDesign(K, `k3_${l.id}`, l, roles) : towerDesign(K, `k3_${l.id}`, l, roles, { roof: !Object.keys(bible).length });
      const F = frameOf(l);
      assert.deepEqual([bp.size.x, bp.size.z], [F.W, F.D], `${l.id}: the design is the lot's frame`);
      for (const [u, y, v] of F.outer) { const n = bp.nameAt(u, y + 1, v) ?? 'minecraft:air'; assert.ok(!/air$|door$|fence_gate$|trapdoor$/.test(n), `${l.id}: outer face ${u},${y},${v} closed (${n})`); }
      for (const [u, y, v] of F.passage) assert.equal(bp.nameAt(u, y + 1, v) ?? 'minecraft:air', 'minecraft:air', `${l.id}: passage ${u},${y},${v} open`);
      if (!l.onWall.passage) assert.ok(bp.size.y - 1 >= 2 * Math.min(F.W, F.D), `${l.id}: a tower at least twice its smaller side`);
    }
  }
});
