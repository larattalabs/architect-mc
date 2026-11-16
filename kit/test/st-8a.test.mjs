// (8a ST) Phase 8a slice ST, the kit's half (docs/CONTRACT.md "Phase 8a" §1 and its exception "F3 region-made trees stay paid"):
// - F3's s01_steward_glade plans and evaluates in survival (it threw `opMats[i] is not iterable` in compileSurvival: a fluid op's decor
//   bed is a second compiled op of one IR op, and the survival flags were read by IR op index), and its trees stay paid: no log or leaf
//   is a staged cell (class 3), every log is class 2 (Noah, 2026-11-15: "Keep paid");
// - the survival flags follow each compiled op's own IR op: in v73 (a coral pond and a fountain, both with a decor bed) every fluid op's
//   compiled ops, the bed's included, read as fluid, and no other op does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compileIR, evalTile } from '../lib/realise.mjs';
import { unpack } from '../lib/region/pack.mjs';
import { CLASS_PAID, CLASS_STAGED } from '../lib/region/survival.mjs';
import { windowOf } from '../lib/region/vworld.mjs';
import { asksSurvey, checkPlanVolumes, FIX, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';

async function survivalPlan(rel) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? asksSurvey() : fx.on === 'flat' || !fx.on ? flatSurvey() : goldenSurvey(fx.on);
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, survival: true });
  return { ir: r.res.ir, blobs: (sha) => r.res.blobs.get(sha) ?? null, s };
}

test('F3 s01_steward_glade evaluates in survival and its trees stay paid (no staged log or leaf)', async () => {
  const { ir, blobs, s } = await survivalPlan('f3/s01_steward_glade.json');
  assert.ok(ir.survival, 'a survival IR');
  let logs = 0, logsPaid = 0, stagedTree = 0;
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const e = evalTile(ir, key, windowOf(s.bytes, key), { stage, set, blobs });
    for (const c of unpack(e.payload).cells) {
      const name = c.state.split('[')[0];
      const tree = /_(log|wood|stem|hyphae)$/.test(name) || /_leaves$/.test(name);
      if (tree && c.cls === CLASS_STAGED) stagedTree++;
      if (/_(log|wood)$/.test(name)) { logs++; if (c.cls === CLASS_PAID) logsPaid++; }
    }
  }
  assert.ok(logs > 0, 'the glade has trees');
  assert.equal(stagedTree, 0, 'no tree cell is staged terrain');
  assert.equal(logsPaid, logs, `every log is paid (${logsPaid} of ${logs})`);
});

test('survival flags follow each compiled op\'s IR op (a decor bed shifts nothing)', async () => {
  const { ir, blobs } = await survivalPlan('valid/v73_f3_coral_pond.json');
  const irOps = ir.parts.flatMap((p) => p.ops ?? []);
  const c = compileIR(ir, { blobs });
  assert.ok(c.ops.length > irOps.length, 'v73 has a decor bed (an extra compiled op)');
  const fluidIr = irOps.filter((o) => o.op === 'fluid').length;
  const fluidCompiled = [...c.survival.opFluid].filter((x) => x === 1).length;
  assert.equal(fluidCompiled, fluidIr + (c.ops.length - irOps.length), 'every fluid op and its bed read as fluid, nothing else');
  // a fluid op's compiled ops come in order, each bed right after its op
  for (let i = 0; i < c.ops.length; i++) if (c.ops[i].cond === 3 && c.ops[i].kind === 2 && i > 0) assert.equal(c.survival.opFluid[i], c.survival.opFluid[i - 1]);
});
