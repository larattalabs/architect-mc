// Phase 7a slice K2, walls along a boundary and wall walks (docs/CONTRACT.md "Phase 7a slice K2" §1-§9 and the coordinator's rulings
// of 2026-10-23), the kit half of the gate, $0 and offline:
//   item 1 (unit)   wall.along: the spine, the side, the per-run offsets (every line cell within distance of the spine), the 4-connected
//                   supercover, the open ends (posts), gates.min 0 by default and n evenly; the auto gates where routes cross (the flat
//                   biome edge); the stepped shore's routes answering UNREACHABLE {kind: wall}; walks: the surface within one half block
//                   a cell, the parapet continuous (M8:walk), the inner rail, gate crossings, tower passages, accesses up and down (the
//                   kit player), head room, M5; every refusal with its evidence and its wouldFit re-checked alone
//   item 2 (part)   a wall without along or walk emits as K1a (v30-v34: the walls' meta and the IR without a walk member); the rest is
//                   tools/gate7ak2.mjs's byte identity against the merge base
//   item 3 (part)   castle_city: wall_walk read, the walk round the ring, an access at its gate, adjusted as before
//   item 12         3 checks of each K2 fixture: one answer set, one artifact sha
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { asksSurvey, stewardAnchors, checkPlanLocal, FIX } from './plan-helpers.mjs';
import { run, svOf } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { decodeColumns } from '../lib/region/pack.mjs';
import { traceBoundary } from '../lib/region/boundary.mjs';
import { walkLevels, walkOf } from '../lib/connectors/wallWalk.mjs';
import { PLAN_SCHEMA, validatePlan } from '../lib/plan/schema.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { validateSchema, sitePlan } from '../lib/region/siteplan.mjs';

const readJ = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const checkOf = (fx, r) => checkRegion({ ir: r.res.ir, survey: svOf(fx).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, prefix: false });
const wallFindings = (rep) => rep.findings.filter((f) => f.severity !== 'info' && ((f.part ?? '').startsWith('w_') || /wall|walk/.test(f.rule)));
const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** The wall bars of K1a and K2 over a check report: no cut, the top, the gates clear, no dark cell, closure, the walk's. */
function wallBars(rep, msg) {
  for (const [id, m] of Object.entries(rep.metrics.walls)) {
    assert.equal(m.cut, 0, `${msg} ${id}: no walk cell under the wall outside its gates`);
    assert.equal(m.M8.low, 0, `${msg} ${id}: every column at least its height at its foot`);
    assert.equal(m.M8.bypass, 0, `${msg} ${id}: every column 2 over any standable cell within 2`);
    assert.equal(m.gateClearance.bad, 0, `${msg} ${id}: the gates' openings clear`);
    assert.equal(m.M5.dark, 0, `${msg} ${id}: 0 dark spawnable cells on the gates' walks and the top`);
    if (m.closure) for (const mv of ['player', 'villager']) {
      assert.equal(m.closure[mv].leaks, 0, `${msg} ${id}: with the gates blocked, 0 ${mv} paths from inside to outside`);
      assert.equal(m.closure[mv].across, m.closure[mv].nodes, `${msg} ${id}: with the gates open, every node across by the ${mv} mover`);
    }
    if (m.walk) {
      assert.equal(m.walk.reached, m.walk.cells, `${msg} ${id}: the player round the whole walk from its accesses`);
      assert.equal(m.walk.accessesUp, m.walk.accesses, `${msg} ${id}: up every access`);
      assert.equal(m.walk.accessesDown, m.walk.accesses, `${msg} ${id}: down every access`);
      assert.equal(m.walk.edges.bad, 0, `${msg} ${id}: every walk edge a 1.5 barrier (parapet, rail) or a drop of at most 3`);
      assert.equal(m.walk.headroom.bad, 0, `${msg} ${id}: 2 clear over every walk cell`);
      assert.equal(m.walk.dark, 0, `${msg} ${id}: 0 dark walk cells`);
    }
  }
  assert.deepEqual(wallFindings(rep).map((f) => `${f.rule} ${f.message}`), [], `${msg}: no wall, walk or M3 finding`);
  assert.deepEqual(rep.findings.filter((f) => /^M3/.test(f.rule) && f.severity !== 'info').map((f) => f.message), [], `${msg}: M3 0`);
}

test('item 11: the catalogue: wall.along reserved -> supported, nothing else of the walls\' (against catalogue-pre7a.json)', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const pre = readJ('catalogue-pre7a.json');
  const d = diffCatalogues(pre, golden, { pending: [{ part: 'w', block: 'wall.along' }] });
  // (K2's own: every change to a wall id; the foundation's three and what main changed since catalogue-pre7a (v0.42.0's close-out A)
  // are theirs)
  const mine = (xs) => xs.filter((x) => /^(wall\.|connector\.(wall|gate)$)/.test(typeof x === 'string' ? x : x.id));
  assert.deepEqual(mine(d.reservedToSupported), ['wall.along']);
  assert.deepEqual(mine(d.schemaVersionBumps), [{ id: 'wall.along', from: 0, to: 1 }]);
  assert.deepEqual([mine(d.untilChanged), mine(d.otherStateChanges), mine(d.limitsChanged), d.added, d.removed, d.retired], [[], [], [], [], [], []]);
  assert.deepEqual(d.recheck, [{ part: 'w', block: 'wall.along' }]);
  const e = golden.entries.find((x) => x.id === 'wall.along');
  assert.ok(e.sinceApi === 'NEXT' || e.sinceApi === golden.api, e.sinceApi);
  // the walk member: strict, R15 unchanged in shape
  const def = PLAN_SCHEMA.$defs['connector.wall'].properties.walk;
  assert.ok(def.oneOf.length === 2);
  const v = (walk) => validatePlan({ schemaVersion: 'plan/0', zones: [{ id: 'z', program: { lots: [{ id: 'h', type: 'house', size: [9, 9] }] } }], connectors: [{ id: 'w', kind: 'wall', where: { around: { feature: { part: 'z' } } }, walk }] }).parts.find((p) => p.id === 'w').verdict;
  assert.equal(v(true), 'compile');
  assert.equal(v({ width: 2, access: 'ladder', every: 32, lamps: 'none' }), 'compile');
  assert.equal(v({ width: 3 }), 'malformed');
  assert.equal(v({ every: 8 }), 'malformed');
  assert.equal(v({ stairs: true }), 'malformed');
  assert.deepEqual(walkOf({ walk: true }), { width: 1, access: 'auto', every: 64, lamps: 'every' });
  assert.deepEqual(walkOf({}, { walk: true }), { width: 1, access: 'auto', every: 64, lamps: 'every' });
  assert.equal(walkOf({ walk: false }, { walk: true }), null);
});

test('item 1: the walk level: neighbouring cells within one half block, never under K1a\'s top, a ring round', () => {
  const T = [70, 70, 70, 75, 75, 75, 70, 70, 70, 70, 70, 70];
  for (const closed of [false, true]) {
    const { S2, top } = walkLevels([...T], closed);
    const n = T.length;
    for (let i = 0; i < n; i++) {
      assert.ok(S2[i] >= 2 * T[i] + 2, `${i}: never under the top`);
      assert.equal(top[i], Math.floor((S2[i] - 1) / 2));
      if (i + 1 < n || closed) assert.ok(Math.abs(S2[i] - S2[(i + 1) % n]) <= 1, `${closed} ${i}: within one half block`);
    }
  }
});

test('item 1: wall.along on a biome edge: the spine, the side, the runs\' offsets, the supercover, the open ends, the auto gates where routes cross', async () => {
  const fx = readJ('valid', 'v7a_k2_along_edge.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  for (const a of r.check.parts) assert.equal(a.class, 'fits', `${a.part}: ${JSON.stringify(a.reasons ?? a.deviations)}`);
  const w = part(r, 'edge_wall'), g = w.geometry;
  assert.equal(g.form, 'along');
  assert.equal(g.closed, false);
  assert.equal(g.along.kind, 'biome_edge');
  assert.deepEqual(g.along.distance, [2, 8]);
  assert.ok(g.along.runs.length >= 8 && g.along.runs.every((q) => q.offset >= 2 && q.offset <= 8), JSON.stringify(g.along.runs));
  // two paths across: an auto gate each (the gate move), gates.min 2 met by them
  assert.deepEqual(g.gates.map((x) => [x.kind, x.auto]), [['route', true], ['route', true]]);
  for (const id of ['cross_a', 'cross_b']) assert.equal(part(r, id).class, 'fits');
  const m = r.res.meta.walls[0];
  // the spine: the desert's border row against the plains (x 1079)
  assert.ok(m.along.spine.every(([x]) => x === 1079), 'the spine is the desert\'s border row');
  // every line cell (the inner course) within distance of the spine; the line 4-connected; no cell in water
  const inner = m.cells.filter((c) => c[4] === 0);
  for (const c of inner) assert.ok(Math.min(...m.along.spine.map((q) => cheb(q, c))) <= 8 && Math.min(...m.along.spine.map((q) => cheb(q, c))) >= 2, `${c}: within [2, 8] of the spine`);
  const cells = new Set(m.cells.map((c) => `${c[0]},${c[1]}`));
  for (const c of m.cells) assert.ok([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => cells.has(`${c[0] + dx},${c[1] + dz}`)), 'every wall cell has a 4-neighbour in the wall');
  // its ends: two posts, clipped at the claim margin
  assert.equal(m.ends.length, 2);
  const zs = m.cells.map((c) => c[1]);
  assert.ok(Math.min(...zs) >= 2002 && Math.max(...zs) <= 2157, 'inside the claim margin');
  const rep = checkOf(fx, r);
  wallBars(rep, 'along_edge');
  // the siteplan's spine
  const S = sitePlan({ ir: r.res.ir, meta: r.res.meta });
  assert.ok(S.walls[0].spine.length >= 16);
});

test('item 1: wall.along: gates.min 0 by default (an open wall: people walk round its ends), n placed evenly; side left/right/toward the anchor', async () => {
  const fx = readJ('valid', 'v7a_k2_along_edge.json');
  const plan = (o, routes = false) => ({ schemaVersion: 'plan/0', connectors: [{ id: 'edge_wall', kind: 'wall', where: { along: { feature: { biome_edge: { between: ['desert', 'plains'] } }, ...o.along } }, ...(o.gates !== undefined ? { gates: o.gates } : {}) }, ...(routes ? fx.plan.connectors.slice(1) : [])] });
  const g0 = part(await run({ ...fx, plan: plan({}) }), 'edge_wall').geometry;
  assert.equal(g0.gates.length, 0, 'no gate by default');
  const r3 = await run({ ...fx, plan: plan({ gates: { min: 3 } }) });
  const g3 = part(r3, 'edge_wall').geometry;
  assert.deepEqual(g3.gates.map((x) => x.kind), ['min', 'min', 'min']);
  const zs = g3.gates.map((x) => x.at[2]).sort((a, b) => a - b);
  // evenly: at about 1/6, 3/6 and 5/6 of the line's length (2002..2157)
  assert.ok(Math.abs(zs[0] - 2028) <= 3 && Math.abs(zs[1] - 2080) <= 3 && Math.abs(zs[2] - 2132) <= 3, JSON.stringify(zs));
  wallBars(checkOf(fx, r3), 'gates.min 3');
  // the side: either (the more clear cells: on a flat claim, ties left), left, right, toward an anchor
  const sideOf = async (along, anchors = {}) => part(await run({ ...fx, anchors: { ...fx.anchors, ...anchors }, plan: plan({ along }) }), 'edge_wall').geometry.along.side;
  const xs = async (along, anchors = {}) => (await run({ ...fx, anchors: { ...fx.anchors, ...anchors }, plan: plan({ along }) })).res.meta.walls[0].cells.filter((c) => c[4] === 0).map((c) => c[0]);
  assert.equal(await sideOf({}), 'left');
  assert.equal(await sideOf({ side: 'right' }), 'right');
  const east = await xs({ side: 'toward_anchor', anchor: 'east_a' }), west = await xs({ side: 'away_from_anchor', anchor: 'east_a' });
  assert.ok(east.every((x) => x > 1079) && west.every((x) => x < 1079), 'toward the anchor east of the edge, away west of it');
  // distance: a given range read, its smallest clear offset taken
  const far = part(await run({ ...fx, plan: plan({ along: { distance: [5, 7] } }) }), 'edge_wall').geometry.along;
  assert.ok(far.runs.every((q) => q.offset === 5), JSON.stringify(far.runs));
});

test('item 1: wall.along on S3\'s pinned river (the shore: the land side), gates.min 2 on landings, walkable both ways; its routes refused UNREACHABLE {kind: wall} (the K2 finding)', async () => {
  const fx = readJ('valid', 'v7a_k2_along_shore.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const w = part(r, 'river_wall');
  assert.equal(w.class, 'fits');
  assert.equal(w.geometry.along.kind, 'shore');
  assert.deepEqual(w.geometry.gates.map((g) => g.kind), ['min', 'min']);
  const m = r.res.meta.walls[0];
  // 0 cells in water; every line cell within [3, 6] of the spine
  const cols = decodeColumns(svOf(fx).bytes);
  const wet = (x, z) => cols.flags[(x - cols.minX) + (z - cols.minZ) * cols.width] & 1;
  assert.equal(m.cells.filter((c) => wet(c[0], c[1])).length, 0, '0 cells in water');
  // (each run's offset is in [3, 6] along its spine cells' normals, D2's Chebyshev measure; a cell's nearest spine cell on a 45-degree
  // staircase shore can be one nearer than its own: the bar is the runs' offsets, and every cell within one of the range)
  assert.ok(w.geometry.along.runs.every((q) => q.offset >= 3 && q.offset <= 6), JSON.stringify(w.geometry.along.runs));
  for (const c of m.cells.filter((q) => q[4] === 0)) { const d = Math.min(...m.along.spine.map((q) => cheb(q, c))); assert.ok(d >= 2 && d <= 7, `${c}: ${d} from the spine`); }
  // the spine is D2's own (traceBoundary over the survey)
  const tb = traceBoundary(cols, svOf(fx).claim, { shore: { minArea: 64 } });
  assert.ok(m.along.spine.every((q) => tb.spine.some((s) => s[0] === q[0] && s[1] === q[1])));
  wallBars(checkOf(fx, r), 'S3 shore');
  // (the coordinator's ruling (b), 2026-10-23) each gate stands on a landing: its floor 2 cells each side, the flight along the inner
  // face to the bank; the kit's player and villager through each gate both ways, from beyond the flight's top to the shore outside
  const { buildVirtual } = await import('../lib/region/vworld.mjs');
  const { walkGraph, nodeReached } = await import('../lib/region/check.mjs');
  const { vw } = buildVirtual({ ir: r.res.ir, survey: svOf(fx).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
  const gAt = (x, z) => cols.ground[(x - cols.minX) + (z - cols.minZ) * cols.width];
  const cellAt = new Map(m.cells.map((c) => [`${c[0]},${c[1]}`, c]));
  for (const g of m.gates) {
    assert.ok(g.landing && g.landing.steps > 0, `${g.id}: a landing with its flight`);
    assert.ok(w.notes.some((n) => n.startsWith(`gate ${g.id}:`) && /a landing levels it/.test(n)), `${g.id}: noted`);
    const fl = g.landing.cells.filter((c) => c[1] !== g.y);
    const top = fl.reduce((a, c) => (c[1] > a[1] ? c : a), fl[0]), low = fl.reduce((a, c) => (c[1] < a[1] ? c : a), fl[0]);
    const xs = fl.map((c) => c[0]), zs = fl.map((c) => c[2]);
    const alongX = Math.max(...xs) - Math.min(...xs) > Math.max(...zs) - Math.min(...zs);
    const sx = alongX ? Math.sign(top[0] - low[0]) : 0, sz = alongX ? 0 : Math.sign(top[2] - low[2]);
    const tops = fl.filter((c) => c[1] === top[1]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const mid = tops[tops.length >> 1];
    const inland = [mid[0] + 2 * sx, gAt(mid[0] + 2 * sx, mid[2] + 2 * sz) + 1, mid[2] + 2 * sz];
    const cs = g.cells.map(([x, z]) => cellAt.get(`${x},${z}`)), inner = cs.find((c) => c[4] === 0);
    const outer = cs.find((c) => c[4] === m.thickness - 1 && Math.abs(c[0] - inner[0]) + Math.abs(c[1] - inner[1]) === m.thickness - 1);
    const outP = [outer[0] + Math.sign(outer[0] - inner[0]), g.y + 1, outer[1] + Math.sign(outer[1] - inner[1])];
    for (const mover of ['player', 'villager']) {
      assert.ok(nodeReached(walkGraph(vw, [inland], { mover }), outP), `${g.id}: the ${mover} from the bank (beyond the flight) through the gate to the shore`);
      assert.ok(nodeReached(walkGraph(vw, [outP], { mover }), inland), `${g.id}: the ${mover} from the shore through the gate up to the bank`);
    }
    // no trench inland: the landing keeps within 6 of the wall's inner course
    const depth = Math.max(...g.landing.cells.map((c) => Math.min(...m.cells.filter((q) => q[4] === 0).map((q) => cheb(q, [c[0], c[2]])))));
    assert.ok(depth <= 6, `${g.id}: the landing keeps beside the wall (${depth} at most from its inner course: its flight 3 wide, straight on where the shore veers)`);
  }
  // the routes across the stepped bank: refused UNREACHABLE {kind: wall}, naming the wall (never a bare BUDGET)
  const rf = readJ('k2', 'k2_shore_routes.json');
  const rr = await run(rf);
  for (const id of ['stair_w', 'stair_e']) {
    const a = part(rr, id);
    assert.equal(a.class, 'refused', `${id}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, 'UNREACHABLE');
    assert.equal(a.reasons[0].evidence.kind, 'wall');
    assert.deepEqual(a.reasons[0].evidence.walls.map((x) => x.wall), ['river_wall']);
  }
  assert.equal(part(rr, 'river_wall').class, 'fits');
});

test('item 1: the walk on v30\'s walled village with corner towers: surface, parapet, rail, gate crossings, tower passages, accesses, lamps', async () => {
  const fx = readJ('valid', 'v7a_k2_walk.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  for (const a of r.check.parts) assert.equal(a.class, 'fits', `${a.part}: ${JSON.stringify(a.reasons ?? a.deviations)}`);
  const w = part(r, 'town_wall'), m = r.res.meta.walls[0], wk = m.walk;
  assert.equal(w.geometry.walk.width, 1);
  assert.equal(w.geometry.thickness, 2, 'thickness walk.width + 1');
  // the accesses: a flight each side of both gates (4), and `every` 64 adds more along the longer runs
  const byGate = wk.accesses.filter((a) => /^gate /.test(a.why));
  assert.equal(byGate.length, 4, JSON.stringify(wk.accesses.map((a) => a.why)));
  assert.ok(wk.accesses.every((a) => a.kind === 'stair'));
  // the runs between accesses are graph edges (wall_walk, player only), the accesses nodes (kind access)
  const edges = r.res.ir.graph.edges.filter((e) => e.type === 'wall_walk'), nodes = r.res.ir.graph.nodes.filter((n) => n.kind === 'access');
  assert.equal(nodes.length, wk.accesses.length);
  assert.equal(edges.length, wk.accesses.length, 'a closed ring: as many runs as accesses');
  assert.ok(edges.every((e) => JSON.stringify(e.movers) === '["player"]'));
  // the walk over the gates (the lintel carries it), and through every corner stub (4 passages)
  const gateCols = new Set(m.gates.flatMap((g) => g.cells.map(([x, z]) => `${x},${z}`)));
  assert.ok(wk.cells.filter((c) => gateCols.has(`${c[0]},${c[2]}`)).length >= 2, 'the walk runs over the gates');
  const I = m.inside;
  const corners = [[I[0], I[1]], [I[2], I[1]], [I[2], I[3]], [I[0], I[3]]];
  for (const [x, z] of corners) assert.ok(wk.cells.some((c) => c[0] === x && c[2] === z), `a passage through the stub at ${x}, ${z}`);
  // lamps on the parapet, the rail on its corbels
  assert.ok(wk.lamps.length >= 8 && wk.rails.length > 100 && wk.corbels.length > 100);
  // the siteplan's walls[].walk
  const S = sitePlan({ ir: r.res.ir, meta: r.res.meta });
  const sw = S.walls[0];
  assert.equal(sw.walk.width, 1);
  assert.equal(sw.walk.accesses.length, wk.accesses.length);
  const schema = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'schemas', 'siteplan-1.json'), 'utf8'));
  assert.deepEqual(validateSchema(schema, S, '$', schema), []);
  wallBars(checkOf(fx, r), 'walk');
  // cost.bom carries the walk (its stairs, the rail's wall blocks, the lamps)
  assert.ok(Object.keys(w.cost?.bom ?? {}).some((k) => /stairs$/.test(k)), JSON.stringify(w.cost?.bom));
});

test('item 1: the walk on an open wall (along) ends in a rail across it; a ladder where a flight has no room (access: ladder)', async () => {
  const fx = readJ('valid', 'v7a_k2_along_edge.json');
  const plan = JSON.parse(JSON.stringify(fx.plan));
  plan.connectors[0].walk = { access: 'ladder' };
  const r = await run({ ...fx, plan });
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  const wk = r.res.meta.walls[0].walk;
  assert.ok(wk.accesses.length >= 4 && wk.accesses.every((a) => a.kind === 'ladder'), JSON.stringify(wk.accesses.map((a) => a.kind)));
  assert.ok(part(r, 'edge_wall').notes.some((n) => /closed by a rail across the walk/.test(n)));
  wallBars(checkOf(fx, r), 'along walk, ladders');
  // the same with stairs
  plan.connectors[0].walk = true;
  const r2 = await run({ ...fx, plan });
  assert.ok(r2.res.meta.walls[0].walk.accesses.every((a) => a.kind === 'stair'));
  wallBars(checkOf(fx, r2), 'along walk, flights');
});

test('item 1: the refusals: no boundary, every offset blocked (naming the class), a thin walk wall (its wouldFit re-checked alone), an access with no room', async () => {
  const rows = fs.readdirSync(path.join(FIX, 'k2')).filter((f) => /^k2_r\d/.test(f)).sort();
  assert.equal(rows.length, 4);
  for (const f of rows) {
    const fx = readJ('k2', f);
    const r = await run(fx);
    const a = part(r, fx.expect.part);
    assert.equal(a.class, 'refused', `${f}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, fx.expect.code, f);
    assert.ok(a.reasons[0].evidence, `${f}: evidence`);
    if (fx.expect.why) assert.equal(a.reasons[0].evidence.why, fx.expect.why, f);
    if (fx.expect.class) assert.equal(a.reasons[0].evidence.class, fx.expect.class, f);
    if (fx.expect.wouldFit) {
      assert.ok(a.wouldFit?.length, `${f}: a wouldFit`);
      const plan = JSON.parse(JSON.stringify(fx.plan));
      plan.connectors = plan.connectors.map((c) => (c.id === a.wouldFit[0].part ? a.wouldFit[0].fragment : c));
      const again = await run({ ...fx, plan });
      assert.equal(part(again, fx.expect.part).class, 'fits', `${f}: its wouldFit fits re-checked alone`);
    }
  }
});

test('items 2, 3: a wall without along or walk is K1a\'s; castle_city reads its wall_walk: the walk round the ring, an access at its gate', async () => {
  for (const name of ['v30_walled_village.json', 'v31_wall_line.json', 'v32_wall_edge.json']) {
    const fx = readJ('valid', name);
    const r = await run(fx);
    for (const w of r.res.meta.walls ?? []) assert.ok(!w.walk && !w.along, `${name}: no walk, no along`);
    assert.ok(!r.res.ir.graph?.edges?.some((e) => e.type === 'wall_walk'));
  }
  const f = readJ('asks', 'castle_city.json');
  const A = asksSurvey();
  const r = await checkPlanLocal(f.answer.plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim) });
  const w = part(r, 'curtain_wall');
  assert.equal(w.class, 'adjusted', 'adjusted as today (its gate_lot join, K3 changes it)');
  assert.ok(w.notes.includes('params.wall_walk read as walk: true'));
  assert.ok(!w.notes.includes('params.wall_walk not read'));
  const wk = r.res.meta.walls.find((x) => x.id === 'curtain_wall').walk;
  assert.ok(wk.cells.length > 300, 'the walk round the ring');
  assert.ok(wk.accesses.filter((a) => /^gate /.test(a.why)).length >= 1, 'an access at its gate');
  const rep = checkRegion({ ir: r.res.ir, survey: A.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, meta: r.res.meta, prefix: false });
  const m = rep.metrics.walls.curtain_wall.walk;
  assert.deepEqual([m.reached, m.accessesUp, m.accessesDown, m.edges.bad, m.headroom.bad, m.dark], [m.cells, m.accesses, m.accesses, 0, 0, 0]);
});

test('item 12: 3 checks of each K2 fixture give one answer set and one artifact sha', async () => {
  for (const name of ['v7a_k2_along_edge.json', 'v7a_k2_along_shore.json', 'v7a_k2_walk.json']) {
    const fx = readJ('valid', name);
    const rs = [await run(fx), await run(fx), await run(fx)];
    assert.ok(rs.every((r) => r.artifactSha && r.artifactSha === rs[0].artifactSha), `${name}: one artifact sha`);
    assert.ok(rs.every((r) => JSON.stringify(r.check.parts) === JSON.stringify(rs[0].check.parts)), `${name}: one answer set`);
  }
  void validateSchema;
});

test('item 8 (KC): an along wall past a pond keeps clear of its body (the runs step past it: adjusted), M25:clear 0', async () => {
  const fx = readJ('k2', 'k2_kc_pond.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  const w = part(r, 'edge_wall');
  assert.equal(w.class, fx.expect.class, JSON.stringify(w));
  assert.ok(w.deviations.some((d) => d.what === 'move'));
  const rep = checkRegion({ ir: r.res.ir, survey: svOf(fx).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta });
  assert.deepEqual(rep.findings.filter((f) => f.rule === 'M25:clear').map((f) => f.message), []);
  // no wall cell on the pond's rect
  const pr = part(r, 'pond').geometry.rect;
  assert.equal(r.res.meta.walls[0].cells.filter(([x, z]) => x >= pr[0] && x <= pr[2] && z >= pr[1] && z <= pr[3]).length, 0);
});
