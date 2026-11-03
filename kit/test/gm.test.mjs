// (7a GM) gm-unit, step 1b part: the static checks of the gate layouts (gmLint), the bench, the latch timing rule (CONTRACT GM §14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../lib/connectors/gmLint.mjs';
import { benchCells } from '../lib/connectors/gmBench.mjs';
import { gateLayout, lintLayout, latchTiming, LAYOUT_DELAYS, LOGIC_HALF } from '../lib/connectors/gmCircuit.mjs';

const benchMap = () => {
  const m = new Map();
  for (const c of benchCells()) m.set(`${c.x},${c.y},${c.z}`, { ...c.lint });
  return m;
};
const floor = (k) => k.split(',')[1] === '-1';

test('gmLint: the proven bench lints clean', () => {
  assert.deepEqual(lint(benchMap(), { solid: floor }).problems, []);
});

test('gmLint: a torch on a comparator side is reported (26.3 reads only dust and diodes there)', () => {
  const m = benchMap();
  // the bench feeds CMP's side through dust (31,0,-2) from torch T2 (32,0,-2); move the torch onto the side cell
  m.delete('31,0,-2'); m.delete('32,0,-2');
  m.set('31,0,-2', { t: 'torch', mount: [32, 0, -2], label: 'nQ', stop: true }); m.set('32,0,-2', { t: 'block' });
  const p = lint(m, { solid: floor }).problems;
  assert.ok(p.some((x) => /^CMP-SIDE: torch 31,0,-2/.test(x)), p.join('\n'));
});

test('gmLint: an observer pulse into a block beside the bus reaches the bus (HANDOFF-GM item 3)', () => {
  // a bus of dust on blocks, an observer firing up into a block beside it
  const m = new Map();
  for (let x = 0; x <= 4; x++) { m.set(`${x},0,0`, { t: 'block' }); m.set(`${x},1,0`, { t: 'dust', expect: ['G'] }); }
  m.set('0,1,-1', { t: 'block' }); m.set('-1,1,0', { t: 'rep', f: 'w', label: 'G', stop: true }); m.set('-2,1,0', { t: 'block' }); m.set('-1,0,0', { t: 'block' }); m.set('-2,0,0', { t: 'block' });
  m.set('2,0,1', { t: 'obs', f: 'd', label: 'P', stop: true }); m.set('2,1,1', { t: 'block' }); // the pulse cell beside the bus at (2,1,0)
  const p = lint(m, { solid: () => false }).problems;
  assert.ok(p.some((x) => /^EXPECT: 2,1,0 .*carries \[G,P\]/.test(x)), p.join('\n'));
  m.set('2,1,1', { t: 'air' });
  assert.deepEqual(lint(m, { solid: () => false }).problems, []);
});

test('gmLint: a trapdoor beside a powered block flips (it must expect only its lever)', () => {
  const m = new Map([['0,0,0', { t: 'block' }], ['0,1,0', { t: 'dust', label: 'G' }], ['1,0,0', { t: 'trap', expect: [] }]]);
  assert.ok(lint(m).problems.some((x) => /^EXPECT: 1,0,0 \(trap\) carries \[G\]/.test(x)));
});

test('gate layouts lint clean in the step 1b boxes, the design walls solid or the hall open', async () => {
  for (const [kind, depth, roof, half] of [['portcullis', 7, 10, 6], ['slide', 7, 10, 6], ['portcullis', 11, 11, 6], ['slide', 11, 11, 6], ['portcullis', 15, 12, 8], ['slide', 15, 14, 8]])
    for (const outside of ['solid', 'air']) assert.deepEqual(await lintLayout(gateLayout(kind, { depth, roof }), { half, outside }), [], `${kind} ${depth}x${roof} ${outside}`);
});

test('gate layouts stay in the logic block and the gate cells (CONTRACT GM §14 item 2)', () => {
  for (const depth of [7, 11, 15]) {
    const lay = gateLayout('portcullis', { depth, roof: 10 });
    for (const c of lay.cells.values()) {
      const gate = Math.abs(c.u) <= 4 && c.d <= 2 && c.r <= 5; // the leaves, feed, lining and front detector
      const inner = c.u === 1 && c.d >= depth - 2 && c.r <= 3; // the inside detector and its mount
      const logic = Math.abs(c.u) <= LOGIC_HALF && c.d >= 1 && c.d <= depth - 2 && c.r >= 4 && c.r <= 8;
      const sensor = c.u === -4 && c.r >= 9;
      assert.ok(gate || inner || logic || sensor || (c.r === 3 && Math.abs(c.u) <= 1 && (c.d === 0 || c.d === depth - 1)), `${depth}: ${c.u},${c.d},${c.r} ${c.state}`);
    }
  }
  assert.throws(() => gateLayout('slide', { depth: 5 }), /under 7/);
  assert.throws(() => gateLayout('slide', { depth: 7, roof: 9 }), /under 10/);
});

test('latch timing: §14 item 3 (a = 2 on both paths, B1 2 ticks after B2); the bench before it raced', () => {
  const t = latchTiming(LAYOUT_DELAYS);
  assert.deepEqual({ aT1: t.aT1, aCMP: t.aCMP, b1MinusB2: t.b1MinusB2, ok: t.ok }, { aT1: 2, aCMP: 2, b1MinusB2: 2, ok: true });
  // the bench: RL delay 2 put the CMP path at a = 4, one tick outside the rule (HANDOFF-GM "Slack rule")
  assert.equal(latchTiming({ rB2: 1, rQd: 3, rBC: 1, RL: 2, RG: 2 }).aCMP, 4);
  assert.equal(latchTiming({ rB2: 1, rQd: 3, rBC: 1, RL: 2, RG: 2 }).ok, false);
});

test('gate layouts own every support cell: no dust or diode stands on a cell the design writes', () => {
  for (const depth of [7, 11, 15]) for (const roof of [10, 12]) {
    const lay = gateLayout('slide', { depth, roof });
    for (const c of lay.cells.values()) if (['dust', 'rep', 'cmp'].includes(c.lint.t)) {
      const f = lay.cells.get(`${c.u},${c.d},${c.r - 1}`);
      assert.ok(f && ['block', 'obs', 'piston'].includes(f.lint.t), `${depth}x${roof}: ${c.u},${c.d},${c.r} stands on ${f?.state ?? 'a design cell'}`);
    }
  }
});
