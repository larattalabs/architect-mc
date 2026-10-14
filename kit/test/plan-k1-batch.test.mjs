// (7a K1, batch integration) K1a's walls and gates and K1b's rope bridges in one plan: both special-move rows of the route pass's
// table (the gate row with its prune hook, the rope row with its fail hook and approach squares) active in one route pass. A
// flat claim with a dry ravine (x 1041-1060, floor 40): a rope bridge across it, a wall on a line further east, and a path from
// the bridge's far landing across the wall (its auto gate); and a sealed wall round a town, whose path the gate row prunes while
// the bridge beside it fits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stewardAnchors, checkPlanLocal, flatSurvey } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const terrain = { W: 240, D: 160, x0: 1000, z0: 2000, bands: [{ x0: 1041, z0: 2000, x1: 1060, z1: 2159, y: 40 }] };
const ANCHORS = { a: [1040, 65, 2080], b: [1061, 65, 2080], w1: [1150, 65, 2006], w2: [1150, 65, 2153], c: [1210, 65, 2080] };
const planOf = (wall = {}) => ({ schemaVersion: 'plan/0', planId: 'k1_batch', connectors: [
  { id: 'span', kind: 'rope_bridge', from: { anchor: 'a' }, to: { anchor: 'b' } },
  { id: 'divide', kind: 'wall', from: { anchor: 'w1' }, to: { anchor: 'w2' }, ...wall },
  { id: 'walk', kind: 'path', from: { anchor: 'b' }, to: { anchor: 'c' } },
] });

async function run(plan) {
  const s = flatSurvey(terrain);
  const r = await checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...ANCHORS }, volumes: [] });
  return { ...r, survey: s };
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);

test('a wall with an auto gate and a rope bridge in one plan: every part fits, the wall and rope rules clean, both movers across', async () => {
  const r = await run(planOf());
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  const rep = checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: [] });
  assert.deepEqual(rep.findings.map((f) => `${f.rule} ${f.message}`), []);
  // the rope row: one bridge on the profile, railed and clear over every deck cell
  assert.equal(rep.metrics.ropes.bridges, 1);
  for (const q of rep.metrics.ropes.per) {
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal(q.railed, q.n);
    assert.equal(q.headroom, q.n);
  }
  assert.equal(part(r, 'span').geometry.spans[0].crossing.over, 'gap');
  // the gate row: the path opened one gate through the wall, nothing cut, every column tall enough
  const w = rep.metrics.walls.divide;
  assert.ok(w.gates >= 1 && w.cut === 0 && w.M8.low === 0, JSON.stringify(w));
  const gates = r.res.ir.graph.nodes.filter((n) => n.kind === 'gate');
  assert.ok(gates.some((n) => n.ref === 'divide'), JSON.stringify(gates));
  assert.ok(r.res.ir.graph.edges.some((e) => e.type === 'rope_bridge' && e.crossing?.over === 'gap'));
  for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, `${e.id} ${JSON.stringify(e)}`);
  // deterministic: a second check gives the same answers and artifact
  const r2 = await run(planOf());
  assert.deepEqual(r2.check.parts, r.check.parts);
  assert.ok(r.check.irSha);
  assert.equal(r2.check.irSha, r.check.irSha);
});

test('a rope bridge beside a sealed wall (S-K1-1): the gate row prunes the path into the walled town (UNREACHABLE naming the wall) while the bridge fits', async () => {
  const plan = { schemaVersion: 'plan/0', planId: 'k1_batch_sealed',
    zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'cottage', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'c', within: 0 } } }],
    connectors: [
      { id: 'span', kind: 'rope_bridge', from: { anchor: 'a' }, to: { anchor: 'b' } },
      { id: 'w', kind: 'wall', where: { around: { feature: { part: 'town' }, closed: true } } },
      { id: 'in', kind: 'path', from: { anchor: 'b' }, to: { part: 'town' } },
    ] };
  const r = await run(plan);
  for (const [id, c] of [['town', 'fits'], ['span', 'fits'], ['w', 'fits'], ['in', 'refused']]) assert.equal(part(r, id).class, c, `${id}: ${JSON.stringify(part(r, id))}`);
  const why = part(r, 'in').reasons[0];
  assert.equal(why.code, 'UNREACHABLE');
  assert.deepEqual(why.evidence.walls, [{ wall: 'w', sealed: true, gates: 0, max: 0 }]);
  assert.equal(part(r, 'span').geometry.spans.length, 1);
});
