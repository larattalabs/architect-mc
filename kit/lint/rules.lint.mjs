// The water lint's own rules, each shown to flag its broken input (kit/lint/water.mjs): h_core_demo planned once, then a copy of its IR
// with one thing wrong per rule. (The checker's M25/M20 rules have their broken variants in the corpus: kit/lint/shard.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { planEntry, lintPlanned } from './water.mjs';
import { fromRuns, toRuns } from '../lib/fluids/body.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const fluidOps = (ir) => ir.parts.flatMap((p) => (p.ops ?? []).filter((o) => o.op === 'fluid'));
const rules = (r) => r.findings.map((f) => f.rule);

test('W2/W3: the lint flags a wrong prediction, a short settle bound, an unwatched breach; clean as planned', async () => {
  const p = await planEntry({ name: 'demo/h_core_demo', kind: 'h_core' });
  assert.deepEqual(rules(lintPlanned(p)), [], 'as planned');
  // W2:census: one predicted cell at another level (the census would compare the world with a wrong prediction)
  let q = { ...p, ir: clone(p.ir) };
  const spout = fluidOps(q.ir).find((o) => (o.predicted ?? []).length);
  spout.predicted[0][3] = spout.predicted[0][3] === 1 ? 2 : 1;
  assert.ok(rules(lintPlanned(q)).includes('W2:census'), 'a wrong predicted level');
  // W2:settle: the bound one tick short of settleBound(path)
  q = { ...p, ir: clone(p.ir) };
  fluidOps(q.ir)[0].settleTicks -= 1;
  assert.ok(rules(lintPlanned(q)).includes('W2:settle'), 'a short settle bound');
  // W3:breach and W3:watch: hy_core_demo's recorded breach reach (watch) dropped: a breach's flow reaches cells the census neither records
  // nor watches (h_core_demo's breaches only wet their opened cell)
  const hy = await planEntry({ name: 'demo/hy_core_demo', kind: 'hy_core' });
  assert.deepEqual(rules(lintPlanned(hy)), [], 'hy_core_demo as planned');
  q = { ...hy, ir: clone(hy.ir) };
  assert.ok(fluidOps(q.ir).some((o) => fromRuns(o.watch ?? []).length > 0));
  for (const o of fluidOps(q.ir)) o.watch = toRuns([]);
  const r = rules(lintPlanned(q));
  assert.ok(r.includes('W3:breach') && r.includes('W3:watch'), `an unrecorded breach reach (${[...new Set(r)].join(', ')})`);
});

test('W3: predict_short (a spout\'s spill one cell short) breaches outside what is recorded; IRR\'s broken side leaves its lot', async () => {
  const ps = await planEntry({ name: 'demo/h_core_demo:predict_short', kind: 'h_core', variant: 'predict_short' });
  assert.ok(rules(lintPlanned(ps)).includes('W3:breach'));
  const fs = await import('node:fs');
  const fx = JSON.parse(fs.readFileSync(new URL('../test/fixtures/plan/irr/u03_breach_out.json', import.meta.url), 'utf8'));
  const u03 = await planEntry({ name: 'irr/u03_breach_out.json', kind: 'fixture', fx, dir: 'irr' });
  assert.ok(rules(lintPlanned(u03)).includes('W3:irr'));
});

test('W6/W7 (8c WM): a source conversion outside the body\'s cells and a plant in a predicted cell are flagged; clean as planned', async () => {
  const { VC, classAt } = await import('../lib/region/volume.mjs');
  const p = await planEntry({ name: 'demo/h_core_demo', kind: 'h_core' });
  assert.ok(!rules(lintPlanned(p)).some((r) => /^W[67]/.test(r)), 'as planned');
  // W6: two_source_corner's gap between two sources over stone converts (the checker's M25:convert names it too)
  const tc = await planEntry({ name: 'demo/h_core_demo:two_source_corner', kind: 'h_core', variant: 'two_source_corner' });
  assert.ok(rules(lintPlanned(tc)).includes('W6:convert'), rules(lintPlanned(tc)).join(' '));
  // W7: short grass (natural, a PLANT cell of the frozen volume) in the spout's predicted cells: the flow would wash it away
  const q = { ...p, volumes: p.volumes.map((v) => ({ ...v, classes: Uint8Array.from(v.classes), fluids: v.fluids ? Uint8Array.from(v.fluids) : v.fluids })) };
  let planted = 0;
  for (const o of fluidOps(q.ir)) for (const [x, y, z] of o.predicted ?? []) for (const v of q.volumes) {
    if (classAt(v, x, y, z) !== VC.AIR) continue;
    v.classes[((x - v.box.minX) * v.depth + (z - v.box.minZ)) * v.height + (y - v.box.minY)] = VC.PLANT;
    planted++;
  }
  assert.ok(planted > 0);
  const r = lintPlanned(q);
  assert.ok(rules(r).includes('W7:wash'), rules(r).join(' '));
  assert.match(r.findings.find((f) => f.rule === 'W7:wash').message, /short_grass/);
});
