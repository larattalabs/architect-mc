// Phase 6c slice F3 (docs/CONTRACT.md "Phase 6c slice F3: forms II" §10 item 1, item 8): the grown generators' properties over 200 seeds
// per generator and preset: every op at most 32 primitives (F1's rule), every form baked (its drift states are a function of its final
// cells), lint STATE clean (mushroom faces, leaf distance as vanilla computes them over the form's own cells), every leaf persistent,
// nothing floating (every cell face-connected to the foot), the column mask holding every cell, canopies at most 32 across, the same
// seed the same cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { primitiveCount } from '../lib/realise.mjs';
import { MAX_PRIMITIVES } from '../lib/forms/rules.mjs';
import { PRESETS as TREE_PRESETS, giantTree } from '../lib/forms/giantTree.mjs';
import { PRESETS as MUSH_PRESETS, giantMushroom } from '../lib/forms/giantMushroom.mjs';
import { connectedTo, eachColumn, isLeaves, lintStates, unkey } from '../lib/forms/states.mjs';

const SEEDS = 200;

function props(gen, at) {
  const out = { maxPrim: 0, ops: gen.ops.length, bad: [] };
  for (const o of gen.ops) out.maxPrim = Math.max(out.maxPrim, o.op === 'shape' ? primitiveCount(o.shape) : 1);
  const lint = lintStates(gen.cells);
  if (lint) out.bad.push(lint);
  for (const [k, s] of gen.cells) if (isLeaves(s) && !/persistent=true/.test(s)) { out.bad.push(`${k} not persistent`); break; }
  const floating = connectedTo(gen.cells, (k) => k === `${at[0]},${at[1]},${at[2]}`);
  if (floating.length) out.bad.push(`${floating.length} floating cell(s)`);
  const cols = new Set();
  eachColumn(gen.columns, (x, z) => cols.add(`${x},${z}`));
  for (const k of gen.cells.keys()) { const [x, , z] = unkey(k); if (!cols.has(`${x},${z}`)) { out.bad.push(`${k} outside the mask`); break; } }
  return out;
}

test('item 1: giantTree, 200 seeds per preset: ops at most 32 primitives, lint STATE clean, persistent leaves, nothing floating, the mask holds every cell, at most 32 across', () => {
  const seen = {};
  for (const preset of Object.keys(TREE_PRESETS)) {
    let maxPrim = 0, maxAcross = 0, maxOps = 0;
    for (let i = 0; i < SEEDS; i++) {
      const at = [0, 64, 0];
      const g = giantTree({ at, preset, seed: `p${i}` });
      const p = props(g, at);
      assert.deepEqual(p.bad, [], `${preset} seed p${i}`);
      maxPrim = Math.max(maxPrim, p.maxPrim); maxOps = Math.max(maxOps, p.ops);
      // the canopy: the crown's columns over the trunk's top (roots spread under the ground)
      const crown = [...g.cells].filter(([k]) => unkey(k)[1] > 64 + 4).map(([k]) => unkey(k));
      const across = Math.max(Math.max(...crown.map((c) => c[0])) - Math.min(...crown.map((c) => c[0])), Math.max(...crown.map((c) => c[2])) - Math.min(...crown.map((c) => c[2]))) + 1;
      maxAcross = Math.max(maxAcross, across);
      assert.ok(g.stats.height >= 16 && g.stats.height <= 64, `${preset}: height ${g.stats.height}`);
    }
    assert.ok(maxPrim <= MAX_PRIMITIVES, `${preset}: ${maxPrim} primitives in an op`);
    assert.ok(maxAcross <= 32, `${preset}: a crown ${maxAcross} across`);
    seen[preset] = { maxPrim, maxAcross, maxOps };
  }
  // determinism: the same seed, the same cells
  const a = giantTree({ at: [5, 70, -3], preset: 'jungle', seed: 'x' }), b = giantTree({ at: [5, 70, -3], preset: 'jungle', seed: 'x' });
  assert.deepEqual([...a.cells], [...b.cells]);
  assert.deepEqual(a.columns, b.columns);
});

test('item 1: giantMushroom, 200 seeds per preset: ops at most 32 primitives, every face as vanilla sets it, nothing floating, the mask holds every cell', () => {
  for (const preset of Object.keys(MUSH_PRESETS)) {
    for (let i = 0; i < SEEDS; i++) {
      const at = [0, 64, 0];
      const g = giantMushroom({ at, preset, seed: `m${i}` });
      const p = props(g, at);
      assert.deepEqual(p.bad, [], `${preset} seed m${i}`);
      assert.ok(p.maxPrim <= MAX_PRIMITIVES);
      assert.ok(g.stats.height >= 8 && g.stats.height <= 32);
    }
  }
  // the broken variant: every face true is caught by lint STATE
  const bad = giantMushroom({ at: [0, 64, 0], preset: 'red', seed: 'm0' }, { _unsafe: { mushroomFaces: true } });
  assert.match(lintStates(bad.cells) ?? '', /^STATE: /);
});
