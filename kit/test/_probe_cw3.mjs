import fs from 'node:fs';
import { checkPlanVolumes } from './plan-helpers.mjs';
import { decodeColumns } from '../lib/region/pack.mjs';
const bytes = fs.readFileSync(process.argv[2]);
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/plan/cn/cn02_catwalk.json', import.meta.url), 'utf8'));
let c; try { c = decodeColumns(bytes); } catch (e) { console.log('decode', e.message); }
const claim = { minX: 9500, minZ: 9000, maxX: 9571, maxZ: 9032, minY: -64, maxY: 319 };
const anchors = { cx_from: [9516, 74, 9016], cx_to: [9555, 74, 9016] };
const r = await checkPlanVolumes(fx.plan, { survey: bytes, claim, anchors, volume: {} });
console.log(r.check.overall, JSON.stringify(r.check.parts[0]).slice(0, 300));
const w = [9555, 73, 9017];
for (const p of r.res.ir.parts) for (const op of p.ops) {
  const cols = op.cols; if (!cols) continue;
  for (let t = 0; t < cols.length; t += 5) {
    const [x, z, y0, y1, m] = cols.slice(t, t + 5);
    if (Math.abs(x - w[0]) <= 1 && Math.abs(z - w[2]) <= 1) console.log(p.id, p.stage, [x, z, y0, y1], op.materials?.[m], 'cond', JSON.stringify(op.cond), 'walk', op.walk, 'from', JSON.stringify(op.from), 'to', JSON.stringify(op.to));
  }
}
if (c) { const i = (w[0] - c.minX) + (w[2] - c.minZ) * c.width; console.log('survey at cell: ground', c.ground[i], 'height', c.height[i], 'floor', c.floor[i], 'flags', c.flags[i]); }
