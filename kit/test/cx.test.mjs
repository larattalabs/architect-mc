// (7c CX) Sites.placeConnector's one-part plan (docs/CONTRACT.md "Phase 7c" §3 row 11, "Slice CX as built"): the plan ConnectorPlace.planOf
// makes of a ConnectorRequest (fixtures/plan/cx/cx01_ravine.json, held equal to Java's answer by ApiCXTest) checks over its own claim and
// writes only the connector: one part (the link's), every written cell between the two marked points (the landings and their posts), the
// rope rules clean; in survival the connector is one construction target (group `link`) with its bill and nothing free; the other kinds
// answer typed refusals on ground they can't use (never a throw), and a second check is byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkPlanLocal, flatSurvey } from './plan-helpers.mjs';
import { checkRegion } from '../lib/region/check.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/plan/cx/cx01_ravine.json', import.meta.url), 'utf8'));
const [x0, z0, x1, z1] = fx.claim;
/** The survey of the connector's own claim (Java's: the ends' box plus 16), the fixture's ravine cut into it. */
const survey = () => flatSurvey({ W: x1 - x0 + 1, D: z1 - z0 + 1, x0, z0, y: fx.terrain.y, bands: fx.terrain.bands });
const planWith = (kind, extra = {}) => ({ ...fx.plan, connectors: [{ ...fx.plan.connectors[0], kind, ...extra }] });

async function run(plan, o = {}) {
  const s = survey();
  const r = await checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors: fx.anchors, volumes: [], ...o });
  return { ...r, s };
}
/** Each IR part's written box (the union of its ops' bounds), for the parts that write. */
function written(ir) {
  const out = {};
  for (const p of ir.parts) for (const op of p.ops) {
    const b = op.bounds;
    if (!b) continue;
    const u = out[p.id] ??= { ...b };
    for (const k of ['minX', 'minY', 'minZ']) u[k] = Math.min(u[k], b[k]);
    for (const k of ['maxX', 'maxY', 'maxZ']) u[k] = Math.max(u[k], b[k]);
  }
  return out;
}

test('the claim is the ends\' x/z box plus 16 each side (ConnectorPlace.PAD), as the fixture records it', () => {
  const [a, b] = [fx.anchors.cx_from, fx.anchors.cx_to];
  assert.deepEqual(fx.claim, [Math.min(a[0], b[0]) - 16, Math.min(a[2], b[2]) - 16, Math.max(a[0], b[0]) + 16, Math.max(a[2], b[2]) + 16]);
  assert.deepEqual(fx.plan.connectors.map((c) => [c.id, c.from, c.to]), [['link', { anchor: 'cx_from' }, { anchor: 'cx_to' }]]);
});

test('a rope bridge between two marked points: READY, the link fits over the gap, only the link writes, every cell between the points, rules clean', async () => {
  const r = await run(fx.plan);
  assert.equal(r.check.overall, 'READY');
  const link = r.check.parts.find((p) => p.part === 'link');
  assert.equal(r.check.parts.length, 1);
  assert.equal(link.class, 'fits', JSON.stringify(link));
  assert.equal(link.geometry.spans.length, 1);
  assert.equal(link.geometry.spans[0].crossing.over, 'gap');
  assert.deepEqual([link.geometry.spans[0].from.slice(0, 1), link.geometry.spans[0].to.slice(0, 1)], [[fx.anchors.cx_from[0]], [fx.anchors.cx_to[0]]]);
  const w = written(r.res.ir);
  assert.deepEqual(Object.keys(w).filter((id) => !id.startsWith('links_')), [], `only the link's parts write: ${JSON.stringify(w)}`);
  const [a, b] = [fx.anchors.cx_from, fx.anchors.cx_to];
  for (const [id, u] of Object.entries(w)) {
    assert.ok(u.minX >= Math.min(a[0], b[0]) - 2 && u.maxX <= Math.max(a[0], b[0]) + 2 && u.minZ >= Math.min(a[2], b[2]) - 2 && u.maxZ <= Math.max(a[2], b[2]) + 2,
      `${id}: written ${JSON.stringify(u)} lies between the points (2 cells of landing and posts round them)`);
  }
  assert.equal(r.res.ir.roads?.length ?? 0, 0);
  assert.equal(r.res.ir.lots?.length ?? 0, 0);
  const rep = checkRegion({ ir: r.res.ir, survey: r.s.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: [] });
  assert.deepEqual(rep.findings.map((f) => `${f.rule} ${f.message}`), []);
  assert.equal(rep.metrics.ropes.bridges, 1);
  assert.ok(rep.metrics.ropes.per.every((q) => q.ok && q.railed === q.n && q.headroom === q.n), JSON.stringify(rep.metrics.ropes));
  // a second check: the same answers and artifact
  const r2 = await run(fx.plan);
  assert.deepEqual(r2.check.parts, r.check.parts);
  assert.equal(r2.check.irSha, r.check.irSha);
});

test('in survival the connector is one construction target (group link): nothing free, its bill the part\'s, the creative bill\'s blocks', async () => {
  const c = await run(fx.plan);
  const r = await run(fx.plan, { survival: true });
  assert.equal(r.check.overall, 'READY');
  const sv = r.check.parts.find((p) => p.part === 'link').cost.survival;
  assert.equal(sv.free, 0);
  assert.ok(sv.held > 0);
  assert.deepEqual(sv.bom, c.check.parts.find((p) => p.part === 'link').cost.bom);
  assert.deepEqual(r.res.ir.survival.groups, ['link']);
  assert.deepEqual(Object.keys(r.res.ir.survival.cells), ['link']);
  assert.equal(r.res.ir.survival.cells.link.free, 0);
});

test('the other kinds over the same flat lips: typed answers, never a throw (the plan compiler\'s own refusals)', async () => {
  const want = { catwalk: ['refused', 'NO_GAP'], rock_stair: ['refused', 'NO_CLIMB'], stairs_around: ['malformed', 'SCHEMA'] };
  for (const [kind, [cls, code]] of Object.entries(want)) {
    const r = await run(planWith(kind));
    const p = r.check.parts.find((q) => q.part === 'link');
    assert.equal(p.class, cls, `${kind}: ${JSON.stringify(p)}`);
    assert.equal(p.reasons[0].code, code, kind);
    assert.notEqual(r.check.overall, 'READY', kind);
  }
  // a ladder between two points on one level: the climb compiler answers (adjusted, its notes), it never throws
  const l = await run(planWith('ladder'));
  assert.ok(['fits', 'adjusted', 'refused'].includes(l.check.parts.find((q) => q.part === 'link').class));
});
