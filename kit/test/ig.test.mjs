// (M5 IG, docs/CONTRACT.md "M5 support" slice IG, Steward's S-M5-2) Irrigated growth, the kit's side: a `planRevision` grow lot with
// `irrigate: true` gets IRR's sources (bodies prefixed rv<rid>_, kind irrigation), the lot's `irrigation` record in the lot's frame, the
// shells in the stage after the pads' and the water in a fluids stage the revision adds; M25 and M29 hold; a lot that asks and can't be
// irrigated refuses (NOT_ALLOWED [irrigate]); `irrigate: false` and an absent member plan the same IR; a survival revision bills each
// source's shell (its bed and four farmland sides as dirt) in the revision's own tile bill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { d3Town, reachInputs, KIT } from './d3-helpers.mjs';
import { mergeEffective, revisionStanding, reviseIR, revisionSeed } from '../lib/region/revise.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { asColumns } from '../lib/region/pack.mjs';
import { lotFrame, gridOf, irrigationCells } from '../lib/fluids/irrigate.mjs';
import { synthVolume } from './h-helpers.mjs';

let T = null;
async function town() {
  if (T) return T;
  const t = await d3Town();
  const ir = t.p.ir;
  const RI = reachInputs({ ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(ir);
  const standing = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held });
  T = { t, ir, eff, standing, survey: RI.besideReach.survey };
  return T;
}
const ctxOf = (S, rid = 1) => ({ rid, position: rid, parent: { rid: rid - 1, irSha: S.t.p.irSha }, base: { irSha: S.t.p.irSha }, survey: S.survey, standing: S.standing });
/** The two-plan flow (Regions.planRevision's): plan, synthesize the volumes the plan asked, plan again with them. */
async function twice(S, request, ctx = ctxOf(S)) {
  const first = await reviseIR(S.eff, request, ctx);
  const need = first.needVolumes ?? [];
  if (!need.length) return first;
  const c = S.eff.claim;
  const volumes = need.map((b) => synthVolume({ minX: b.minX, minY: b.minY, minZ: b.minZ, maxX: b.maxX, maxY: b.maxY, maxZ: b.maxZ }, S.survey, c, { fluids: !!b.fluids || !!b.blocks }));
  return reviseIR(S.eff, request, { ...ctx, volumes });
}
const errOf = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const FARM = (o = {}) => ({ id: 'farm_m', type: 'crop_farm', size: [20, 21], irrigate: true, ...o });

test('an irrigated grow lot: its sources, its record in the lot frame, the stages, M25 and M29 clean', async () => {
  const S = await town();
  const r = await twice(S, { grow: { lots: [FARM()] } });
  const ir = r.ir;
  const lot = ir.lots.find((l) => l.id === 'farm_m');
  assert.ok(lot, 'the lot is placed');
  const g = lot.irrigation;
  assert.ok(g, 'the lot records its irrigation');
  // the field 18 x 18 (W - 2, D - 3): 2 x 2 sources, every field column within 4 of one
  assert.equal(g.sources, 4);
  assert.deepEqual(g.frame, [20, 21], 'the frame is the grow size [along, deep]');
  assert.deepEqual(lotFrame(lot).size, [20, 21]);
  assert.ok(g.bodies.every((b) => b.startsWith('rv1_farm_m_irr_')), JSON.stringify(g.bodies));
  assert.equal(g.cells.reduce((n, q) => n + q[3] - q[2] + 1, 0), irrigationCells(lot, gridOf(lot)).length);
  assert.equal(g.lotCells.reduce((n, q) => n + q[3] - q[2] + 1, 0), 4 * 7, 'per source: itself, the bed, the cell above and four sides');
  // the bodies: kind irrigation, in the fluids stage, the last; the shells in `street`, after the pads' `ground`, before the lots'
  const fluids = ir.parts.flatMap((p) => (p.ops ?? []).filter((o) => o.op === 'fluid').map((o) => ({ ...o, stage: p.stage })));
  assert.deepEqual(fluids.map((o) => o.id).sort(), [...g.bodies].sort());
  assert.ok(fluids.every((o) => o.stage === 'fluids'));
  assert.equal(ir.stages[ir.stages.length - 1], 'fluids');
  assert.ok(ir.stages.indexOf('ground') < ir.stages.indexOf('street') && ir.stages.indexOf('street') < ir.stages.indexOf('lots'), ir.stages.join(','));
  assert.deepEqual(ir.revision.grow.irrigated, ['farm_m']);
  // the checker over the revision: no M25 (containment, keep, clear, shell) and no M29 finding
  const chk = checkRegion({ ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
  const bad = chk.findings.filter((f) => /^M2[59]/.test(f.rule) && f.severity !== 'info');
  assert.deepEqual(bad, []);
  assert.ok(r.notes.some((n) => /irrigate: farm_m gets 4 sources \(2 x 2\)/.test(n)), r.notes.join(' | '));
});

test('every front: the record\'s frame is [W, D] seen from the street, the field W - 2 by D - 3', async () => {
  const S = await town();
  for (const prefer of ['frontage', 'extend']) {
    const r = await reviseIR(S.eff, { grow: { lots: [FARM({ size: [11, 12] })], prefer } }, ctxOf(S));
    const lot = r.ir.lots.find((l) => l.id === 'farm_m');
    assert.deepEqual(lot.irrigation.frame, [11, 12], `${prefer} (${lot.front})`);
    const [x0, z0, x1, z1] = lot.irrigation.field;
    const F = lotFrame(lot);
    const a = F.toFrame(x0, lot.floorY, z0), b = F.toFrame(x1, lot.floorY, z1);
    assert.equal(Math.abs(a[0] - b[0]) + 1, 9, `${prefer}: field across`);
    assert.equal(Math.abs(a[2] - b[2]) + 1, 9, `${prefer}: field deep`);
    assert.equal(lot.irrigation.sources, 1);
  }
});

test('byte identity: irrigate false and an absent member plan the same IR; no irrigation means no fluids stage', async () => {
  const S = await town();
  const a = await reviseIR(S.eff, { grow: { lots: [{ id: 'farm_m', type: 'crop_farm', size: [20, 21] }] } }, ctxOf(S));
  const b = await reviseIR(S.eff, { grow: { lots: [{ id: 'farm_m', type: 'crop_farm', size: [20, 21], irrigate: false }] } }, ctxOf(S));
  const noParams = (r) => JSON.stringify({ ...JSON.parse(r.irJson), params: null });
  assert.equal(noParams(a), noParams(b), 'only the params echo differs');
  assert.ok(!a.ir.stages.includes('fluids'));
  assert.equal(a.ir.lots[0].irrigation, undefined);
  assert.equal(a.ir.revision.grow.irrigated, undefined);
});

test('a lot that asks and can\'t be irrigated refuses NOT_ALLOWED [irrigate]', async () => {
  const S = await town();
  assert.match(await errOf(reviseIR(S.eff, { grow: { lots: [FARM({ type: 'house', villager: 'dwelling' })] } }, ctxOf(S))), /^NOT_ALLOWED: \[irrigate\] grow lot farm_m is not a farm lot/);
  assert.match(await errOf(reviseIR(S.eff, { grow: { lots: [FARM({ size: [4, 9] })] } }, ctxOf(S))), /^NOT_ALLOWED: \[irrigate\] farm_m's field is too small/);
  assert.match(await errOf(reviseIR(S.eff, { grow: { lots: [FARM({ irrigate: 'yes' })] } }, ctxOf(S))), /^NOT_ALLOWED: \[call\] grow lot farm_m: irrigate must be true or false/);
});

test('survival: the revision\'s tile bill holds each source\'s bed and four farmland sides (as dirt), once', async () => {
  const S = await town();
  const run = (lots) => {
    const c = S.eff.claim;
    return planRegion({
      programFile: path.join(KIT, 'regions', 'revise.mjs'), params: { spec: { parts: [], refill: [], grow: { lots } } },
      survey: S.survey, claim: { minX: c.minX, minZ: c.minZ, maxX: c.maxX, maxZ: c.maxZ, minY: c.minY, maxY: c.maxY },
      seed: revisionSeed(S.eff.seed ?? '0', 1), roles: S.eff.roles ?? {}, volumes: [], survival: true,
      revision: { rid: 1, position: 1, parent: { rid: 0, irSha: S.t.p.irSha }, base: { irSha: S.t.p.irSha }, effective: S.eff, standing: S.standing },
    });
  };
  const dry = await run([{ id: 'farm_m', type: 'crop_farm', size: [20, 21] }]);
  const wet = await run([FARM()]);
  const sum = (bom) => { const o = {}; for (const g of Object.values(bom ?? {})) for (const [i, n] of Object.entries(g)) o[i] = (o[i] ?? 0) + n; return o; };
  const d = sum(dry.survivalBom), w = sum(wet.survivalBom);
  const diff = {};
  for (const k of new Set([...Object.keys(d), ...Object.keys(w)])) if ((w[k] ?? 0) !== (d[k] ?? 0)) diff[k] = (w[k] ?? 0) - (d[k] ?? 0);
  // four sources, each a bed and four farmland sides (farmland billed as dirt, the vocab's survival map; water free). This town's style
  // has no fluids.bed, so the bed is the chain's first block that differs from the grass pad top: dirt. 4 x 5 = 20 dirt, and nothing
  // else of the bill moves
  const shells = wet.ir.parts.filter((p) => p.id.endsWith('_shell'));
  assert.equal(shells.length, 4);
  for (const p of shells) assert.deepEqual(p.ops.flatMap((o) => o.materials ?? []), ['minecraft:dirt', 'minecraft:farmland[moisture=7]'], p.id);
  assert.deepEqual(diff, { 'minecraft:dirt': 20 }, JSON.stringify({ d, w }));
});
