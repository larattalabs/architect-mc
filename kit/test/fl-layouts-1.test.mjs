// (6c FL, CONTRACT FL §10 item 1) The ring and the spiral on 200 seeded synthetic claims each: the layout invariants (fl-helpers.mjs
// assertLayout), the ring closed, the spiral's pitch and open ends; the counts recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { synthClaim, assertLayout } from './fl-helpers.mjs';
import { ringSearch } from '../lib/region/layouts/ring.mjs';
import { spiralSearch } from '../lib/region/layouts/spiral.mjs';
import { FL_RULES } from '../lib/region/frontage.mjs';

const N = 200;
const adj4 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

test(`ring: ${N} seeded claims hold the layout invariants; the street is one closed 4-connected loop`, () => {
  let laid = 0, lots = 0, unplaced = 0;
  for (let s = 1; s <= N; s++) {
    const k = synthClaim(s);
    const reach = Math.min(k.c[0] - k.claim.minX, k.claim.maxX - k.c[0]) - 8;
    const { best: L } = ringSearch(k.F, { c: k.c, specs: k.specs, shared: k.shared, r0: 10, r1: reach });
    if (!L) continue;
    laid++;
    const r = assertLayout(k.F, L, `ring seed ${s}`);
    lots += r.lots; unplaced += r.unplaced;
    const st = L.streets[0];
    assert.equal(st.closed, true);
    for (let i = 0; i < st.cells.length; i++) assert.ok(adj4(st.cells[i], st.cells[(i + 1) % st.cells.length]), `ring seed ${s}: the loop breaks at ${i}`);
    assert.equal(new Set(st.cells.map((c) => c.join())).size, st.cells.length, `ring seed ${s}: the loop crosses itself`);
    // fronts face the hub (inward) for outer lots: the entrance is nearer the centre than the lot's far edge
    for (const l of L.lots.filter((q) => q.slot === 'street')) {
      const mid = [(l.rect[0] + l.rect[2]) / 2, (l.rect[1] + l.rect[3]) / 2];
      assert.ok(Math.hypot(l.entrance[0] - L.centre[0], l.entrance[2] - L.centre[1]) < Math.hypot(mid[0] - L.centre[0], mid[1] - L.centre[1]), `ring seed ${s}: ${l.spec.id} faces out`);
    }
  }
  console.log(`# ring: ${laid}/${N} claims laid, ${lots} lots placed, ${unplaced} unplaced`);
  assert.ok(laid >= N * 0.9, `${laid} of ${N} claims laid a ring`);
});

test(`spiral: ${N} seeded claims hold the layout invariants; one open street winding out (its pitch), central lots in the hub`, () => {
  let laid = 0, lots = 0, unplaced = 0;
  for (let s = 1; s <= N; s++) {
    const k = synthClaim(s + 1000);
    const { best: L } = spiralSearch(k.F, { c: k.c, specs: k.specs, shared: k.shared });
    if (!L) continue;
    laid++;
    const r = assertLayout(k.F, L, `spiral seed ${s}`);
    lots += r.lots; unplaced += r.unplaced;
    const st = L.streets[0];
    assert.equal(st.closed, false);
    for (let i = 0; i + 1 < st.cells.length; i++) assert.ok(adj4(st.cells[i], st.cells[i + 1]), `spiral seed ${s}: the street breaks at ${i}`);
    const deep = Math.max(...k.specs.filter((q) => !(q.placement === 'central' || q.landmark)).map((q) => q.size[1]), 9);
    assert.equal(L.pitch, 2 * (deep + FL_RULES.setback) + 5, `spiral seed ${s}: the pitch`);
    // winding out: the street's last cell lies farther from the centre than its first
    const d = (c) => Math.hypot(c[0] - L.centre[0], c[1] - L.centre[1]);
    assert.ok(d(st.cells[st.cells.length - 1]) > d(st.cells[0]), `spiral seed ${s}: does not wind out`);
  }
  console.log(`# spiral: ${laid}/${N} claims laid, ${lots} lots placed, ${unplaced} unplaced`);
  assert.ok(laid >= N * 0.9, `${laid} of ${N} claims laid a spiral`);
});
