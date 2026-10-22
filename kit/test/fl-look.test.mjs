// (6c FL) Noah's look fixes (the gallery review, 2026-10-20), each a check over what the free zones write (fl-written.mjs reads it back
// from the IR): L1 the verge lies against the road 4e lays (no grass gap between them); L2 no strings (no verge further than 1 from a
// walkway) and no stubs (the zone's paths are one 4-connected piece); L3 lamps at least LAMP_GAP (6, D3's rule) apart over the whole
// region; L4 lanes at the entrance's width all the way to the road; L5 spokes and streets that reach the hub end on paving. Over the FL
// fixtures v66-v71 and fl/w01-w04 (the spiral up the hill in the infernal bible, bare hubs in a ring and an organic hamlet, a grid's
// green). Before the fixes, each of v66-v71 failed L1, L2 and L4, and v66 and v68-v70 failed L3 and L5 (CONTRACT.md FL as built).
import test from 'node:test';
import assert from 'node:assert/strict';
import { read, run, svOf } from './plan-p0-shared.mjs';
import { flWritten, vergeGaps, strayVerges, pathPieces, lampSpacing, laneProblems, hubProblems } from './fl-written.mjs';
import { LAMP_GAP } from '../lib/region/frontage.mjs';

const FIXTURES = [...read('valid').filter((f) => /^v(6[6-9]|7[01])_fl_/.test(f.name)), ...read('fl').filter((f) => f.name.startsWith('w'))];

test('the look fixes L1-L5 hold on every FL fixture (v66-v71, fl/w01-w04)', async () => {
  assert.equal(FIXTURES.length, 10);
  for (const f of FIXTURES) {
    const r = await run(f);
    const sv = svOf(f);
    const zones = ['', ...Object.keys(r.res.meta.villageZones ?? {})].filter((pf) => (pf ? r.res.meta.villageZones[pf] : r.res.meta.village)?.layout);
    assert.ok(zones.length >= 1, `${f.name}: a free zone`);
    for (const pf of zones) {
      const tag = `${f.name}${pf ? ` (${pf})` : ''}`;
      const w = flWritten(r, sv, pf);
      const gaps = vergeGaps(w);
      assert.equal(gaps.length, 0, `${tag}: L1 grass between the road and its verge at ${JSON.stringify(gaps.slice(0, 5))}`);
      const stray = strayVerges(w);
      assert.equal(stray.length, 0, `${tag}: L2 verge more than 1 from the road at ${JSON.stringify(stray.slice(0, 5))}`);
      const pieces = pathPieces(w);
      assert.equal(pieces.length, 1, `${tag}: L2 the paths are ${pieces.length} pieces ${JSON.stringify(pieces.slice(0, 6))} (a stub ends nowhere)`);
      const lanes = laneProblems(w);
      assert.deepEqual(lanes, [], `${tag}: L4`);
      const hub = hubProblems(w, r.res.ir, pf);
      assert.deepEqual(hub, [], `${tag}: L5`);
      assert.equal(r.res.ir.roads.filter((rd) => rd.id.startsWith(`${pf}street_`) && rd.lanterns).length, 0, `${tag}: the zone's streets carry no 4e lanterns (the zone lights them)`);
    }
    const ls = lampSpacing(flWritten(r, sv, zones[0]));
    assert.ok(ls.d >= LAMP_GAP, `${f.name}: L3 two lamps ${ls.d} apart: ${JSON.stringify([ls.a, ls.b])}`);
  }
});

test('L5: each hub kind records its landing (square: the square; a green: a paved ring; a bare hub: a pad when a spoke reaches it, else nothing)', async () => {
  const want = { v66: 'square', v69: 'ring', w02: 'none', w03: 'pad', w04: 'ring' };
  for (const [n, kind] of Object.entries(want)) {
    const f = FIXTURES.find((x) => x.name.startsWith(n));
    const r = await run(f);
    assert.equal(r.res.meta.village.hubLanding, kind, n);
  }
});
