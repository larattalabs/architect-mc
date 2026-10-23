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
import { connectedTo, eachColumn, isLeaves, lintStates, unkey, unsupportedLogs } from '../lib/forms/states.mjs';

const SEEDS = 200;

function props(gen, at) {
  const out = { maxPrim: 0, ops: gen.ops.length, bad: [] };
  for (const o of gen.ops) out.maxPrim = Math.max(out.maxPrim, o.op === 'shape' ? primitiveCount(o.shape) : 1);
  const lint = lintStates(gen.cells);
  if (lint) out.bad.push(lint);
  for (const [k, s] of gen.cells) if (isLeaves(s) && !/persistent=true/.test(s)) { out.bad.push(`${k} not persistent`); break; }
  const floating = connectedTo(gen.cells, (k) => k === `${at[0]},${at[1]},${at[2]}`);
  if (floating.length) out.bad.push(`${floating.length} floating cell(s)`);
  // (fix/survival-off-storm) every log held as the game's dev.region.logs reads it (a log under it, a log beside it, or solid under it)
  const loose = unsupportedLogs(gen.cells, () => at[1]);
  if (loose.length) out.bad.push(`${loose.length} unsupported log(s): ${loose.slice(0, 3).join(' ')}`);
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

// (fix/survival-off-storm) Steward's RC grove (plan grove_pond: a giant oak of height [40, 48], plan pmvkaawte1d0582): one log at
// 8065,97,35973 hung under a branch, held only from above (dev.region.logs floating 1). Before the fix 52 of 1000 oak seeds at
// [40, 48] had one; the generator now turns such a log into a leaf (or drops it).
test('fix: no unsupported log: the RC grove oak (seed 1a27490e33838705) and oak [40, 48] over 300 seeds; the broken variant caught', () => {
  const rc = giantTree({ at: [8068, 64, 35968], preset: 'oak', height: [40, 48], seed: '1a27490e33838705' });
  assert.deepEqual(unsupportedLogs(rc.cells, () => 64), []);
  assert.equal(rc.cells.size, 3258, 'the RC tree: its cell count as baked (vox_f_great_oak_1, 3258 cells)');
  const bad = giantTree({ at: [8068, 64, 35968], preset: 'oak', height: [40, 48], seed: '1a27490e33838705' }, { _unsafe: { unsupportedLogs: true } });
  assert.ok(unsupportedLogs(bad.cells, () => 64).includes('8065,97,35973'), 'the broken variant keeps the RC\'s floating log');
  for (let i = 0; i < 300; i++) {
    const at = [0, 64, 0];
    const g = giantTree({ at, preset: 'oak', height: [40, 48], seed: `s${i}` });
    assert.deepEqual(unsupportedLogs(g.cells, () => 64), [], `oak [40, 48] seed s${i}`);
  }
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

test('item 1, item 8: stalactites and roots, 200 seeds per preset over a synthetic cave and bank: ops at most 32 primitives, thickness as vanilla computes it (no impossible sequence), no root under water, hanging roots only under a solid cell', async () => {
  const { fixtureVolume, flatSurvey } = await import('./plan-helpers.mjs');
  const { STALACTITE_PRESETS, ROOT_PRESETS, ceilingsOf, facesOf, growsAt, roots, stalactites } = await import('../lib/forms/cave.mjs');
  const { surveyApi } = await import('../lib/region/survey.mjs');
  const s = flatSurvey({ bands: [{ x0: 1130, x1: 1239, z0: 2000, z1: 2159, y: 72 }] });
  const S = surveyApi(s.bytes, s.claim);
  const box = { minX: 1100, minY: 30, minZ: 2060, maxX: 1140, maxY: 72, maxZ: 2100 };
  const v = (await fixtureVolume(box, { edits: [{ box: [1104, 44, 2064, 1126, 55, 2096], class: 'AIR' }] }, s.bytes, s.claim)).decoded;
  const rect = { minX: 1102, minZ: 2062, maxX: 1138, maxZ: 2098 };
  const ceilings = ceilingsOf(v, rect, (x, z) => S.groundAt(x, z));
  const faces = facesOf(v, rect, (x, z) => S.groundAt(x, z));
  assert.ok(ceilings.length > 100 && faces.length > 10, `${ceilings.length} ceilings, ${faces.length} faces`);
  for (const preset of Object.keys(STALACTITE_PRESETS)) for (let i = 0; i < SEEDS; i++) {
    const site = ceilings[i % ceilings.length];
    const g = stalactites({ preset, seed: `s${i}` }, { vol: v, site });
    for (const o of g.ops) assert.ok(primitiveCount(o.shape) <= MAX_PRIMITIVES);
    assert.equal(lintStates(g.cells), null, `${preset} s${i}`);
    for (const [k, st] of g.cells) {
      if (st !== 'minecraft:dripstone_block') continue;
      const [x, y, z] = unkey(k);
      assert.ok(!growsAt(v, x, y, z), `${k}: a root under a fluid`);
    }
  }
  for (const preset of Object.keys(ROOT_PRESETS)) for (let i = 0; i < SEEDS; i++) {
    const face = i % 2 === 0;
    const g = roots({ preset, seed: `r${i}` }, face ? { vol: v, site: faces[i % faces.length] } : { vol: v, site: ceilings[i % ceilings.length], ceiling: true });
    for (const o of g.ops) assert.ok(primitiveCount(o.shape) <= MAX_PRIMITIVES);
    for (const [k, st] of g.cells) {
      if (st !== 'minecraft:hanging_roots') continue;
      const [x, y, z] = unkey(k);
      const above = g.cells.get(`${x},${y + 1},${z}`);
      assert.ok(above && above !== 'minecraft:hanging_roots', `${preset} r${i} ${k}: hanging roots under ${above ?? 'nothing the form writes'}`);
    }
  }
});
