// (LYW2) A bundled program's ring wall in the IR: ring(..., {wall: true}) records `walls` (its line, thickness, height, top, gates and
// towers) for Regions.layout, writes no other block; walled_hill and sky_isle opt in, crater_works's rim does not; the evaluator knows
// the member in format 2.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { synthSurvey } from '../lib/region/synth.mjs';
import { MEMBERS_FORMAT2 } from '../lib/realise.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claimOf = (size) => { const h = size / 2; return { minX: -h, minZ: -h, maxX: h - 1, maxZ: h - 1, minY: -64, maxY: 319 }; };
const plan = (id, size) => planRegion({ programFile: path.join(KIT, 'regions', `${id}.mjs`), survey: synthSurvey(claimOf(size), 'golden'), claim: claimOf(size), node: 'golden', kitVersion: '0.12.0' });

test('walled_hill and sky_isle record their ring wall in the IR: a closed line, its gate and towers', async () => {
  for (const [id, size] of [['walled_hill', 200], ['sky_isle', 240]]) {
    const ir = JSON.parse((await plan(id, size)).irJson);
    assert.equal(ir.walls?.length, 1, id);
    const w = ir.walls[0];
    assert.equal(w.part, 'wall');
    assert.ok(ir.parts.some((p) => p.id === w.part), `${id}: its part is in the IR`);
    assert.equal(w.closed, true);
    assert.equal(w.thickness, 3);
    assert.ok(w.line.length >= 12 && w.line.length <= 63, `${id}: at most 63 corners (Regions.layout's 64 ends with the closing point)`);
    assert.ok(w.line.every((q) => q.length === 2 && q.every(Number.isInteger)));
    assert.equal(new Set(w.line.map((q) => q.join(','))).size, w.line.length, 'no repeated corner');
    assert.ok(Number.isInteger(w.top[0]) && w.top[0] <= w.top[1]);
    assert.deepEqual(w.gates.map((g) => [g.id, g.width, g.height]), [['wall_g1', 5, 5]]);
    assert.ok(w.towers.length >= 3 && w.towers.every((t, i) => t.id === `wall_tower_${i + 1}` && t.r === 3 && t.height > w.height && t.at.length === 3));
    // the ring op's own shape: its height in cells is the record's
    const ring = ir.parts.find((p) => p.id === 'wall').ops.find((o) => o.shape?.kind === 'ring');
    assert.equal(ring.shape.h, w.height, `${id}: height in cells, footing included`);
  }
  // sky_isle's wall stands on its mass (baseY): one top
  const sky = JSON.parse((await plan('sky_isle', 240)).irJson).walls[0];
  assert.equal(sky.top[0], sky.top[1]);
  assert.equal(sky.gates[0].at[1], sky.towers[0].at[1] + 1, 'the gate at its threshold\'s feet');
});

test('a ring without wall: true records nothing (crater_works\'s rim); the member is known to the evaluator', async () => {
  const ir = JSON.parse((await plan('crater_works', 200)).irJson);
  assert.equal(ir.walls, undefined);
  assert.ok(MEMBERS_FORMAT2.includes('walls'));
});
