// (6c T3, batch integration; docs/CONTRACT.md "Phase 6c slice T3" §11 item 4) K1b's rope bridge, T3a's stone bridge and T3b's
// tunnel as a postern under K1a's wall, in one plan: the rope, bridge, tunnel and gate rows of the route pass's table active in one
// pass, T3b's two-plan flow (the postern's corridor asked, then read), the links stage emitting ropes, bridges and tunnels together.
// The claim is v40's (a ridge whose east face stands under a walled village's west side) with a dry ravine (x 1041-1060, 15 deep)
// west of it: the rope crosses it at z 2030, the stone bridge (an explicit `bridge` part: where both fit auto keeps the rope, N-T3-5)
// at z 2130. The negative: the wall sealed, the gate row prunes the postern (UNREACHABLE naming the wall) while both bridges fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stewardAnchors, checkPlanVolumes, flatSurvey, FIX } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const v40 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v40_postern.json'), 'utf8'));
const terrain = { bands: [{ x0: 1041, z0: 2000, x1: 1060, z1: 2159, y: 50 }, ...v40.terrain.bands] };
const ANCHORS = { ...v40.anchors, ra: [1040, 65, 2030], rb: [1061, 65, 2030], sa: [1040, 65, 2130], sb: [1061, 65, 2130] };
const planOf = (around = {}) => ({ schemaVersion: 'plan/0', planId: 't3_batch', zones: v40.plan.zones, connectors: [
  { id: 'rope', kind: 'rope_bridge', from: { anchor: 'ra' }, to: { anchor: 'rb' } },
  { id: 'stone', kind: 'bridge', from: { anchor: 'sa' }, to: { anchor: 'sb' } },
  ...v40.plan.connectors.map((c) => (c.kind === 'wall' ? { ...c, where: { around: { ...c.where.around, ...around } } } : c)),
] });

async function run(plan) {
  const s = flatSurvey(terrain);
  const r = await checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...ANCHORS }, volume: v40.volume });
  return { ...r, survey: s };
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });

test('a rope bridge, a stone bridge and a postern tunnel under a wall in one plan: READY, every rule clean, a second check identical', async () => {
  const r = await run(planOf());
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  for (const id of ['town', 'rope', 'stone', 'town_wall', 'postern']) assert.equal(part(r, id).class, 'fits', id);
  // the postern's corridor was asked by the first plan and read by the second (T3b's two-plan flow)
  assert.equal(r.asked.length, 1, JSON.stringify(r.asked));
  assert.equal(r.volumes.length, 1);
  const rep = checkOf(r);
  assert.deepEqual(rep.findings.map((f) => `${f.rule} ${f.message}`), []);
  // K1b: the rope over the ravine
  assert.equal(part(r, 'rope').geometry.spans.length, 1);
  assert.equal(rep.metrics.ropes.bridges, 1);
  for (const q of rep.metrics.ropes.per) assert.ok(q.ok && q.railed === q.n && q.headroom === q.n, JSON.stringify(q));
  // T3a: the stone bridge over the same ravine (20 wide: the arch)
  assert.deepEqual(part(r, 'stone').geometry.bridges.map((b) => [b.form, b.n, b.crossing.type, b.crossing.over]), [['arch', 20, 'bridge', 'gap']]);
  const per = rep.metrics.bridges.per;
  assert.equal(per.length, 1);
  for (const q of per) assert.ok(q.ok && q.railed === q.n && q.headroom === q.n, JSON.stringify(q));
  // T3b + K1a: the postern lands at the wall, counted as its gate; closure holds with it blocked
  const t = part(r, 'postern').geometry.tunnels;
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].crossing.type, t[0].crossing.through, t[0].crossing.lands], ['tunnel', 'rock', 'postern_town_wall']);
  assert.ok(t[0].crossing.cover >= 2, JSON.stringify(t[0].crossing));
  assert.equal(rep.metrics.tunnels.count, 1);
  // the IR graph types each crossing
  const types = r.res.ir.graph.edges.map((e) => e.type);
  for (const ty of ['rope_bridge', 'bridge', 'tunnel']) assert.ok(types.includes(ty), `${ty} in ${types}`);
  for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, `${e.id} ${JSON.stringify(e)}`);
  // deterministic: a second check gives the same answers, IR and artifact
  const r2 = await run(planOf());
  assert.deepEqual(r2.check.parts, r.check.parts);
  assert.ok(r.check.irSha && r.artifactSha);
  assert.equal(r2.check.irSha, r.check.irSha);
  assert.equal(r2.artifactSha, r.artifactSha);
});

test('the same plan with the wall sealed: the gate row prunes the postern (UNREACHABLE naming the wall) while both bridges fit', async () => {
  const r = await run(planOf({ closed: true }));
  for (const [id, c] of [['town', 'fits'], ['rope', 'fits'], ['stone', 'fits'], ['town_wall', 'fits'], ['postern', 'refused']]) assert.equal(part(r, id).class, c, `${id}: ${JSON.stringify(part(r, id))}`);
  const why = part(r, 'postern').reasons[0];
  assert.equal(why.code, 'UNREACHABLE');
  assert.deepEqual(why.evidence.walls, [{ wall: 'town_wall', sealed: true, gates: 0, max: 0 }]);
  assert.equal(part(r, 'rope').geometry.spans.length, 1);
  assert.equal(part(r, 'stone').geometry.bridges.length, 1);
});
