// Slice 0b gate item 6: every lib/smalls.mjs builder passes the checker standalone under every built-in bible (the palette
// presets as roles), in each of its forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blueprint, palette } from '../lib/kit.mjs';
import { BUILTIN_BIBLES, builtinBible } from '../lib/bible.mjs';
import { checkBlueprint } from '../lib/check.mjs';
import { SMALLS, rack, shed, stall, well } from '../lib/smalls.mjs';

/** A standalone frame (`origin` shifts design coordinates so the template is exactly the written extents). */
function frame(name, bible, size, type, profile, origin = [0, 0, 0]) {
  return new Blueprint({ id: `small_${name}`, type, profile, size, origin, groundY: 1, front: 'south', palette: palette({ bible: builtinBible(bible) }), approach: false });
}

/** Build twice: once in a roomy frame to find the extents, then in a frame of exactly those extents. */
function standalone(c, bible, opts) {
  const write = (bp) => {
    const out = SMALLS[c.name](bp, c.box, opts);
    // the anchors: entrance and spawn on the cell in front, on a path row
    const [sx, sy, sz] = out.standAt;
    bp.set(sx, sy - 1, sz, bp.p.path);
    bp.anchor('entrance', sx + 0.5, sy, sz + 0.5, 180);
    bp.anchor('spawn', sx + 0.5, sy, sz + 0.5, 180);
    if (out.interior) bp.interior(out.interior);
    return bp;
  };
  const type = c.name === 'shed' ? 'small_shed' : `small_${c.name}`;
  const big = write(frame(c.name, bible, c.size, type, c.profile));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const k of big.cells.keys()) k.split(',').map(Number).forEach((v, i) => { min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v); });
  return write(frame(c.name, bible, max.map((v, i) => v - min[i] + 1), type, c.profile, min.map((v) => -v)));
}

const CASES = [
  { name: 'rack', opts: [{ levels: 1 }, { levels: 2 }, { levels: 3, length: 4 }], size: [7, 6, 5], box: [1, 0, 1, 5, 4, 3], profile: ['no_floating'] },
  { name: 'stall', opts: [{}, { awning: 'roof' }, { awning: 'wall', counter: 'east' }], size: [7, 7, 7], box: [1, 0, 1, 5, 5, 4], profile: ['no_floating'] },
  { name: 'well', opts: [{ shape: 'round' }, { shape: 'square' }, { shape: 'round', roofed: false }], size: [7, 7, 7], box: [1, 0, 1, 5, 5, 4], profile: ['no_floating'] },
  { name: 'shed', opts: [{ roof: 'gable' }, { roof: 'lean_to' }, { roof: 'gable', door: 'east' }], size: [8, 9, 8], box: [1, 0, 1, 5, 7, 5], profile: ['door', 'lit', 'no_floating', 'interior', 'roof_closed'] },
];

test('the builders are rack, stall, well and shed', () => {
  assert.deepEqual(Object.keys(SMALLS).sort(), ['rack', 'shed', 'stall', 'well']);
  assert.equal(SMALLS.rack, rack);
  assert.equal(SMALLS.stall, stall);
  assert.equal(SMALLS.well, well);
  assert.equal(SMALLS.shed, shed);
});

for (const c of CASES) {
  test(`${c.name} passes the checker under every built-in bible`, () => {
    const bad = [];
    for (const bible of BUILTIN_BIBLES) {
      for (const opts of c.opts) {
        const bp = standalone(c, bible, opts);
        const r = checkBlueprint(bp, {});
        if (!r.ok) bad.push(`${bible} ${JSON.stringify(opts)}: ${r.errors.join('; ')}`);
      }
    }
    assert.deepEqual(bad, []);
  });
}

test('a builder refuses a box too small for it', () => {
  const bp = frame('x', 'rustic', [6, 6, 6], 'small_shed', ['no_floating']);
  assert.throws(() => shed(bp, [0, 0, 0, 2, 3, 2], {}), /under the 4x6x4/);
  assert.throws(() => well(bp, [0, 0, 0, 3, 3, 3], { shape: 'hex' }), /round' or 'square/);
});
