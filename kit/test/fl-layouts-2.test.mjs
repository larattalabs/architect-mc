// (6c FL, CONTRACT FL §10 item 1) The grid and the organic layout on 200 seeded synthetic claims each: the layout invariants
// (fl-helpers.mjs assertLayout), the grid's blocks (every lot faces an avenue, back to back, fronts across the avenues' axis), the
// organic lanes' turn bound and their axis-run share (recorded).
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthClaim, assertLayout } from './fl-helpers.mjs';
import { gridSearch } from '../lib/region/layouts/grid.mjs';
import { organicSearch } from '../lib/region/layouts/organic.mjs';

const N = 200;

test(`grid: ${N} seeded claims hold the layout invariants; every lot faces an avenue, fronts across the avenues' axis`, () => {
  let laid = 0, lots = 0, unplaced = 0;
  for (let s = 1; s <= N; s++) {
    const k = synthClaim(s + 2000, { size: 256 });
    const orientation = ['ew', 'ns', 'auto'][s % 3];
    const { best: L, axis } = gridSearch(k.F, { c: k.c, specs: k.specs, shared: k.shared, orientation });
    if (!L) continue;
    laid++;
    const r = assertLayout(k.F, L, `grid seed ${s}`);
    lots += r.lots; unplaced += r.unplaced;
    if (orientation !== 'auto') assert.equal(axis, orientation, `grid seed ${s}: orientation names the avenues' axis`);
    for (const l of L.lots) {
      assert.match(l.street, /^a\d+$/, `grid seed ${s}: ${l.spec.id} faces ${l.street}, not an avenue`);
      assert.ok(axis === 'ew' ? ['north', 'south'].includes(l.front) : ['east', 'west'].includes(l.front), `grid seed ${s}: ${l.spec.id} front ${l.front} along the avenues`);
    }
    // every crossing is on both its streets
    for (const cr of L.crossings) for (const nm of cr.streets) assert.ok(L.streets.find((q) => q.name === nm).cells.some(([x, z]) => x === cr.x && z === cr.z), `grid seed ${s}: crossing off ${nm}`);
  }
  console.log(`# grid: ${laid}/${N} claims laid, ${lots} lots placed, ${unplaced} unplaced`);
  assert.ok(laid >= N * 0.9, `${laid} of ${N} claims laid a grid`);
});

test(`organic: ${N} seeded claims hold the layout invariants; 2 to 4 lanes, each turning at most 45 degrees a segment of 6..12; the axis-run share recorded`, () => {
  let laid = 0, lots = 0, unplaced = 0, reseeded = 0;
  const shares = [];
  for (let s = 1; s <= N; s++) {
    const k = synthClaim(s + 3000);
    const { best: L } = organicSearch(k.F, { c: k.c, specs: k.specs, shared: k.shared.kind === 'none' ? { kind: 'well', size: 7 } : k.shared, zoneId: `z${s}` });
    if (!L) continue;
    laid++;
    const r = assertLayout(k.F, L, `organic seed ${s}`);
    lots += r.lots; unplaced += r.unplaced;
    assert.ok(L.streets.length >= 2 && L.streets.length <= 4, `organic seed ${s}: ${L.streets.length} lanes`);
    for (const st of L.streets) {
      const w = st.waypoints ?? [];
      for (let i = 2; i < w.length; i++) {
        const h1 = w[i - 1].h, h2 = w[i].h;
        const dh = Math.min((h1 - h2 + 8) % 8, (h2 - h1 + 8) % 8);
        assert.ok(dh <= 1, `organic seed ${s} ${st.name}: a turn of ${dh * 45} degrees`);
      }
      for (let i = 1; i < w.length - 1; i++) assert.ok(w[i].len >= 6 && w[i].len <= 12, `organic seed ${s} ${st.name}: a segment of ${w[i].len}`);
    }
    shares.push(L.axisRun);
    if ((L.notes ?? []).some((n) => /re-seeded/.test(n))) reseeded++;
  }
  shares.sort((a, b) => a - b);
  console.log(`# organic: ${laid}/${N} claims laid, ${lots} lots placed, ${unplaced} unplaced; axis-run share median ${shares[shares.length >> 1]}, max ${shares[shares.length - 1]}; re-seeded ${reseeded}`);
  assert.ok(laid >= N * 0.9, `${laid} of ${N} claims laid an organic layout`);
});
