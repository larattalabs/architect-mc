// Slice WR2: (1) an open ring's left-out side holds no gate (a gate there had no cells and crashed the wall's emission: "Cannot read
// properties of undefined (reading 'pos')", e.g. a gate at the claim's centre lying on the ring's own line); (2) WR's rule for the
// other "side nearest the claim's centre" choices: a moat's open side (kit/lib/fluids/moat.mjs openSide) and a free ring's or a
// form ring's gap (kit/lib/plan/free.mjs stepToward) stay closed, noted, when the ring encloses the claim's centre. $0, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { goldenSurvey, flatSurvey, stewardAnchors, checkPlanLocal, checkPlanVolumes, FIX } from './plan-helpers.mjs';
import { read, run } from './plan-p0-shared.mjs';

const S7 = goldenSurvey('s7');
const V30 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v30_walled_village.json'), 'utf8'));
const V45 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v45_moat.json'), 'utf8'));
const centreOf = (c) => [(c.minX + c.maxX) >> 1, (c.minZ + c.maxZ) >> 1];
const [CX, CZ] = centreOf(S7.claim);
const part = (r, id) => r.check.parts.find((p) => p.part === id);
const ENCLOSES = /^closed: false ignored: the ring encloses the claim's centre/;

/** v30's ring written closed: false round the town placed near (CX + dx, CZ + dz), with a gate part at the claim's centre (`stone`). */
async function openRingGate(dx, dz) {
  const plan = structuredClone(V30.plan);
  plan.zones[0].where = { near: { anchor: 'wr_town', within: 4 } };
  for (const c of plan.connectors) if (c.kind === 'wall') c.where.around.closed = false;
  plan.connectors.push({ id: 'stone_gate', kind: 'gate', at: { anchor: 'stone' } });
  return checkPlanLocal(plan, { survey: S7.bytes, claim: S7.claim, anchors: { ...stewardAnchors(S7.claim), wr_town: [CX + dx, 65, CZ + dz] } });
}

test('WR2 1: a gate nearest an open ring\'s left-out side stands on a side with cells (was: the emission crashed reading pos)', async () => {
  // (-24, 0): the ring's east line is x = CX, the claim's centre ON it (distance 0); (-28, 0) and (0, -20): the centre off the ring
  for (const [dx, dz, side, onLine] of [[-24, 0, 'east', true], [-28, 0, 'east', false], [0, -20, 'south', true]]) {
    const r = await openRingGate(dx, dz);
    const w = part(r, 'town_wall'), g = part(r, 'stone_gate');
    assert.ok(!/Cannot read properties/.test(JSON.stringify(r.check)), `${dx},${dz}: no crash: ${JSON.stringify(w.reasons ?? [])}`);
    assert.ok(['fits', 'adjusted'].includes(w.class), `${dx},${dz}: the wall ${w.class} ${JSON.stringify(w.reasons ?? [])}`);
    assert.ok(w.notes.includes(`closed: false: its ${side} side (nearest the claim's centre) is left out`), JSON.stringify(w.notes));
    const [x0, z0, x1, z1] = w.geometry.ring;
    const on = side === 'east' ? x1 === CX : z1 === CZ;
    assert.equal(on, onLine, `${dx},${dz}: the centre on the ring's line: ${on} (ring ${w.geometry.ring})`);
    assert.ok(['fits', 'adjusted', 'refused'].includes(g.class), `${dx},${dz}: the gate answers (${g.class})`);
    // no gate (the named one, the routes', gates.min's) on the left-out side: every one has an opening
    for (const q of w.geometry.gates) {
      const [x, , z] = q.at;
      const offSide = side === 'east' ? !(x === x1 && z > z0 && z < z1) : !(z === z1 && x > x0 && x < x1);
      assert.ok(offSide, `${dx},${dz}: gate ${q.id} at ${q.at} is not on the open ${side} side`);
    }
  }
});

test('WR2 2: a moat written closed: false round a ring holding the claim\'s centre stays closed, noted; off the centre it still opens', async () => {
  const sv = flatSurvey();
  const at = async (dx) => {
    const plan = structuredClone(V45.plan);
    for (const c of plan.connectors) if (c.kind === 'channel') c.where.around.closed = false;
    const [cx, cz] = centreOf(sv.claim);
    if (dx) plan.zones[0].where = { near: { anchor: 'wr_town', within: 4 } };
    const r = await checkPlanVolumes(plan, { survey: sv.bytes, claim: sv.claim, anchors: { ...stewardAnchors(sv.claim), wr_town: [cx + dx, 65, cz] }, volume: {} });
    return part(r, 'moat');
  };
  const m = await at(0);
  assert.ok(['fits', 'adjusted'].includes(m.class), JSON.stringify(m.reasons ?? []));
  assert.equal(m.geometry.closed, true, 'closed: false ignored');
  assert.equal(m.geometry.open, undefined);
  assert.ok(m.notes.some((n) => ENCLOSES.test(n)), JSON.stringify(m.notes));
  assert.ok(!m.notes.some((n) => /is left out/.test(n)));
  const off = await at(-60);
  assert.ok(['fits', 'adjusted'].includes(off.class), JSON.stringify(off.reasons ?? []));
  assert.equal(off.geometry.closed, false);
  assert.ok(off.notes.includes(`closed: false: its ${{ n: 'north', e: 'east', s: 'south', w: 'west' }[off.geometry.open]} side (nearest the claim's centre) is left out, the ends capped`), JSON.stringify(off.notes));
  assert.ok(!off.notes.some((n) => ENCLOSES.test(n)), JSON.stringify(off.notes));
});

test('WR2 3: a free ring and a form ring written closed: false round the claim\'s centre stay closed, noted; off the centre the gap stays', async () => {
  const fl = read('fl'), f01 = fl.find((f) => f.name.startsWith('f01'));
  const spires = async (anchor) => {
    const plan = structuredClone(f01.plan);
    plan.forms[0].where.around.closed = false;
    plan.zones[0].where.near.anchor = anchor;
    return part(await run({ ...f01, plan }), 'spires');
  };
  const s = await spires('stone');
  assert.equal(s.class, 'fits');
  assert.equal(s.geometry.sites.length, 6, 'six sites evenly round: no gap');
  assert.ok(s.notes.some((n) => ENCLOSES.test(n)), JSON.stringify(s.notes));
  const s2 = await spires('player');
  assert.ok(!s2.notes.some((n) => ENCLOSES.test(n)), JSON.stringify(s2.notes));
  const v67 = read('valid').find((f) => f.name.startsWith('v67'));
  const plan = structuredClone(v67.plan);
  plan.zones[0].where.around.closed = false;
  const shore = part(await run({ ...v67, plan }), 'shore');
  assert.ok(['fits', 'adjusted'].includes(shore.class), JSON.stringify(shore.reasons ?? []));
  assert.ok(shore.notes.some((n) => ENCLOSES.test(n)), JSON.stringify(shore.notes));
  assert.ok(shore.geometry.streets.every((q) => q.closed), 'the ring street stays closed');
});
