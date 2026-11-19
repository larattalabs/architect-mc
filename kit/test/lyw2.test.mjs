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
import { surveyApi } from '../lib/region/survey.mjs';
import { columnCells, compileShape, yrefFn } from '../lib/sdf.mjs';

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
  // sky_isle's wall stands on its mass (baseY): one wall top, its crenels one cell over it (top[1] is the highest cell written)
  const sky = JSON.parse((await plan('sky_isle', 240)).irJson).walls[0];
  assert.equal(sky.top[1], sky.top[0] + 1);
  assert.equal(sky.gates[0].at[1], sky.towers[0].at[1] + 1, 'the gate at its threshold\'s feet');
});

test('a ring without wall: true records nothing (crater_works\'s rim); the member is known to the evaluator', async () => {
  const ir = JSON.parse((await plan('crater_works', 200)).irJson);
  assert.equal(ir.walls, undefined);
  assert.ok(MEMBERS_FORMAT2.includes('walls'));
});

// (v0.84 review P3) the record's bounds cover every cell the wall writes: the ring and towers over their whole footprint (not only the
// line's corners) and the crenels on top. Regions.layout boxes the wall from top[0] - height + 1 to top[1], each tower from at[1] up height.
test('a ring wall\'s record covers every masonry cell it writes: ring, towers and crenels', async () => {
  for (const [id, size] of [['walled_hill', 200], ['sky_isle', 240]]) {
    const ir = JSON.parse((await plan(id, size)).irJson);
    const w = ir.walls[0];
    const sv = surveyApi(synthSurvey(claimOf(size), 'golden'), claimOf(size));
    const colAt = (x, z) => ({ g: sv.heightAt(x, z), h: sv.topAt(x, z), f: sv.floorAt(x, z) });
    const ops = ir.parts.find((p) => p.id === 'wall').ops;
    const span = (shape) => {
      const n = compileShape(shape, {});
      let lo = Infinity, hi = -Infinity;
      for (let z = Math.floor(n.minZ); z <= Math.ceil(n.maxZ); z++) for (let x = Math.floor(n.minX); x <= Math.ceil(n.maxX); x++) {
        columnCells(n, x, z, colAt(x, z), -64, 319, (y) => { lo = Math.min(lo, y); hi = Math.max(hi, y); });
      }
      return [lo, hi];
    };
    const ringOp = ops.find((o) => o.shape?.kind === 'ring');
    const ring = span(ringOp.shape);
    // the crenels: the one columns op on the ring's own base (merlons one cell over the wall and tower tops)
    const crenel = ops.find((o) => o.op === 'columns' && JSON.stringify(o.from) === JSON.stringify(ringOp.shape.c[1]));
    const crenelCells = [];
    if (crenel) {
      const f = yrefFn(crenel.from);
      for (let i = 0; i < crenel.cols.length; i += 5) crenelCells.push([crenel.cols[i], f(colAt(crenel.cols[i], crenel.cols[i + 1])) + crenel.cols[i + 3], crenel.cols[i + 1]]);
    }
    assert.ok(crenel && crenelCells.length > 0, `${id}: has crenels`);
    const foot = w.top[0] - w.height + 1;
    assert.ok(foot <= ring[0], `${id}: the wall's footing ${foot} reaches its lowest cell ${ring[0]}`);
    const wallCrenels = crenelCells.filter(([x, , z]) => !w.towers.some((t) => (x - t.at[0]) ** 2 + (z - t.at[2]) ** 2 <= t.r * t.r));
    const wallTop = Math.max(ring[1], ...wallCrenels.map((c) => c[1]));
    assert.ok(w.top[1] >= wallTop, `${id}: the wall's top ${w.top[1]} reaches its highest cell ${wallTop}`);
    const cyls = ops.filter((o) => o.shape?.kind === 'cylinder');
    assert.equal(cyls.length, w.towers.length);
    w.towers.forEach((t, i) => {
      const c = span(cyls[i].shape);
      const tc = crenelCells.filter(([x, , z]) => (x - t.at[0]) ** 2 + (z - t.at[2]) ** 2 <= t.r * t.r);
      const hi = Math.max(c[1], ...tc.map((q) => q[1]));
      assert.ok(t.at[1] <= c[0], `${id} ${t.id}: its footing ${t.at[1]} reaches its lowest cell ${c[0]}`);
      assert.ok(t.at[1] + t.height - 1 >= hi, `${id} ${t.id}: its top ${t.at[1] + t.height - 1} reaches its highest cell ${hi}`);
    });
  }
});
