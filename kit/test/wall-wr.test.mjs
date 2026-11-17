// Slice WR: a ring wall written `where.around {closed: false}` leaves out the side nearest the claim's centre only when it has one.
// A ring whose box holds the claim's centre (it surrounds the town's middle) stays closed, its gates from the routes, with a note;
// an edge-zone ring still opens its town-facing side as before. $0, offline (v30's walled village on S7's flat claim).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { goldenSurvey, stewardAnchors, checkPlanLocal, FIX } from './plan-helpers.mjs';

const S7 = goldenSurvey('s7');
const V30 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v30_walled_village.json'), 'utf8'));
const [CX, CZ] = [(S7.claim.minX + S7.claim.maxX) >> 1, (S7.claim.minZ + S7.claim.maxZ) >> 1];

/** v30 with its ring written closed: false (closed unwritten when `open` is false), the town near (CX + dx, CZ + dz) when given. */
async function ringWall({ open = true, at = null } = {}) {
  const plan = structuredClone(V30.plan);
  if (at) plan.zones[0].where = { near: { anchor: 'wr_town', within: 4 } };
  for (const c of plan.connectors) if (c.kind === 'wall' && c.where?.around && open) c.where.around.closed = false;
  const anchors = { ...stewardAnchors(S7.claim), ...(at ? { wr_town: [CX + at[0], 65, CZ + at[1]] } : {}) };
  const r = await checkPlanLocal(plan, { survey: S7.bytes, claim: S7.claim, anchors });
  return r.check.parts.find((p) => p.part === 'town_wall');
}

test('WR 1: a ring enclosing the claim\'s centre stays closed with closed: false, noted; its cells and gates as the closed ring\'s', async () => {
  const w = await ringWall(), closed = await ringWall({ open: false });
  const [x0, z0, x1, z1] = w.geometry.ring;
  assert.ok(x0 < CX && CX < x1 && z0 < CZ && CZ < z1, `the ring ${w.geometry.ring} holds the claim's centre ${CX}, ${CZ}`);
  assert.equal(w.geometry.closed, true, 'closed: false ignored');
  assert.ok(w.notes.some((n) => /^closed: false ignored: the ring encloses the claim's centre/.test(n)), JSON.stringify(w.notes));
  assert.ok(!w.notes.some((n) => /is left out/.test(n)), 'no side left out');
  assert.deepEqual(w.geometry.ring, closed.geometry.ring);
  assert.equal(w.geometry.cells, closed.geometry.cells, 'all four sides: the closed ring\'s cells');
  assert.deepEqual(w.geometry.gates, closed.geometry.gates, 'the gates the routes give the closed ring');
  assert.ok(w.geometry.gates.length >= 1, 'the routes still cross it through gates');
});

test('WR 2: an edge-zone ring (the claim\'s centre outside it) still leaves out its town-facing side', async () => {
  for (const [at, side] of [[[-28, 0], 'east'], [[0, -30], 'south']]) {
    const w = await ringWall({ at });
    const [x0, z0, x1, z1] = w.geometry.ring;
    assert.ok(!(x0 < CX && CX < x1 && z0 < CZ && CZ < z1), `the ring ${w.geometry.ring} is off the centre`);
    assert.equal(w.geometry.closed, false, `${at}: open`);
    assert.ok(w.notes.includes(`closed: false: its ${side} side (nearest the claim's centre) is left out`), JSON.stringify(w.notes));
    assert.ok(!w.notes.some((n) => /closed: false ignored/.test(n)));
  }
});
