import fs from 'node:fs';
import { checkPlanVolumes, flatSurvey } from './plan-helpers.mjs';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/plan/cn/cn02_catwalk.json', import.meta.url), 'utf8'));
const s = flatSurvey(fx.terrain);
const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: fx.anchors, volume: {} });
const w = [1087, 72, 2037];
for (const p of r.res.ir.parts) for (const op of p.ops) {
  const b = op.bounds;
  const inb = b && b.minX <= w[0] && b.maxX >= w[0] && b.minZ <= w[2] && b.maxZ >= w[2] && b.minY <= w[1] && b.maxY >= w[1];
  console.log(p.id, p.stage, op.op, inb ? 'CONTAINS' : '', JSON.stringify(b), Object.keys(op).join(','));
}
fs.writeFileSync('/private/tmp/claude-501/-Users-noahlaratta/1d97d465-bbde-40ec-9f50-fc586d280846/scratchpad/cw-ir.json', JSON.stringify(r.res.ir));
