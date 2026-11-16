import fs from 'node:fs';
import { checkPlanVolumes, flatSurvey } from './plan-helpers.mjs';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/plan/cn/cn02_catwalk.json', import.meta.url), 'utf8'));
const s = flatSurvey(fx.terrain);
const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: fx.anchors, volume: {} });
// world offset in game: x +8468 (9516-1048), y +1, z +6980 -> fixture cell of 9555,73,9017 = 1087,72,2037
const want = [1087, 72, 2037];
for (const p of r.res.ir.parts) for (const op of p.ops) {
  const cols = op.cols ?? op.columns; if (!Array.isArray(cols)) { if (op.bounds && op.bounds.minX <= want[0] && op.bounds.maxX >= want[0] && op.bounds.minZ <= want[2] && op.bounds.maxZ >= want[2]) console.log('non-col op', p.id, p.stage, op.op, JSON.stringify(op).slice(0, 300)); continue; }
  for (let t = 0; t < cols.length; t += 5) {
    const [x, z, y0, y1, m] = cols.slice(t, t + 5);
    if (Math.abs(x - want[0]) <= 1 && Math.abs(z - want[2]) <= 1 && y0 <= want[1] + 2 && y1 >= want[1] - 1) console.log(p.id, p.stage, op.op, [x, z, y0, y1], op.materials?.[m], JSON.stringify({ ...op, cols: undefined, materials: undefined }).slice(0, 250));
  }
}
console.log(r.res.ir.stages);
