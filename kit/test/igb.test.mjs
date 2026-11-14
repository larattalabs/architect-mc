// (M5 IG-b, docs/CONTRACT.md "M5 support" slice IG-b, Steward's S-M5-8) Irrigated growth of an adopted street town, the kit's side. An
// adopted region (adopted_village, slice AD's `Regions.adopt`) has one stage, `adopted`. A growth with an irrigated farm lot there adds its
// own stages as V's street town has them: the shells in `street`, the grown lots in `lots`, the water in `fluids`, after the base's
// `adopted` (the pads, lanes and props stay in it). A dry growth there is as before (one stage). A base that names `street` or `lots` in
// another order still refuses NOT_ALLOWED [irrigate].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { columnsOf, worldOf } from './region-helpers.mjs';
import { KIT } from './d3-helpers.mjs';
import { mergeEffective, revisionStanding, reviseIR, revisionSeed } from '../lib/region/revise.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { asColumns } from '../lib/region/pack.mjs';
import { lotFrame, gridOf, irrigationCells } from '../lib/fluids/irrigate.mjs';
import { synthVolume } from './h-helpers.mjs';

const PROGRAM = path.join(KIT, 'regions', 'adopted_village.mjs');

/** A Steward-shaped settlement on a flat ew street (VillageLayout: lots alternating north and south, 15 x 17, lotGap 3), as AD's gate builds. */
function settlement() {
  const cx = 2000, cz = -1500, y = 64, streetZ = cz + 48;
  const lots = [];
  let xn = cx + 12, xs = cx + 12;
  for (let i = 0; i < 4; i++) {
    const north = i % 2 === 0;
    const x = north ? xn : xs;
    const z = north ? streetZ - 3 - 17 + 1 : streetZ + 3;
    const b = [x, y, z, x + 14, y + 7, z + 16];
    if (north) b[2] += 1; else b[5] -= 1;
    lots.push({ id: `house_${i + 1}`, site: `s${100 + i}`, box: b, type: 'house' });
    if (north) xn = x + 18; else xs = x + 18;
  }
  const x0 = Math.min(...lots.map((l) => l.box[0])), x1 = Math.max(...lots.map((l) => l.box[3]));
  const roads = [{ site: 'r10', points: [[x0, y - 1, streetZ], [x1, y - 1, streetZ]], width: 3 }];
  const claim = { minX: cx, minZ: cz, maxX: cx + 160, maxZ: cz + 96, minY: -64, maxY: 319 };
  return { adopt: { zone: 'village', geometry: { streetZ, xLo: x0, xHi: x1 }, roads, lots }, claim };
}

let T = null;
async function town() {
  if (T) return T;
  const s = settlement();
  const c = s.claim;
  const world = worldOf({ flat: 63 });
  const survey = columnsOf(world, c.minX, c.minZ, c.maxX - c.minX + 1, c.maxZ - c.minZ + 1);
  const p = await planRegion({ programFile: PROGRAM, params: { adopt: s.adopt }, survey, claim: c, seed: '1' });
  const eff = mergeEffective(p.ir);
  const standing = revisionStanding({ id: 'rg1', claim: [c.minX, c.minZ, c.maxX, c.maxZ], effective: eff, lots: Object.fromEntries(p.ir.lots.map((l) => [l.id, { state: 'placed', siteId: l.adopted }])) });
  T = { s, p, eff, standing, survey };
  return T;
}
const ctxOf = (S, rid = 1) => ({ rid, position: rid, parent: { rid: rid - 1, irSha: S.p.irSha }, base: { irSha: S.p.irSha }, survey: S.survey, standing: S.standing });
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

test('the adopted base has one stage, adopted', async () => {
  const S = await town();
  assert.deepEqual(S.eff.stages, ['adopted']);
});

test('an irrigated grow lot in an adopted street town: the revision adds street, lots and fluids; sources, record, M25 and M29 clean', async () => {
  const S = await town();
  const r = await twice(S, { grow: { lots: [FARM()] } });
  const ir = r.ir;
  assert.deepEqual(ir.stages, ['adopted', 'street', 'lots', 'fluids']);
  const lot = ir.lots.find((l) => l.id === 'farm_m');
  assert.ok(lot, 'the lot is placed');
  assert.equal(lot.stage, 'lots', 'the grown lot is in the revision\'s own lots stage');
  const g = lot.irrigation;
  assert.ok(g, 'the lot records its irrigation');
  assert.equal(g.sources, 4);
  assert.deepEqual(g.frame, [20, 21]);
  assert.deepEqual(lotFrame(lot).size, [20, 21]);
  assert.ok(g.bodies.every((b) => b.startsWith('rv1_farm_m_irr_')), JSON.stringify(g.bodies));
  assert.equal(g.cells.reduce((n, q) => n + q[3] - q[2] + 1, 0), irrigationCells(lot, gridOf(lot)).length);
  // the shells in street, the bodies in fluids; the pads, lanes and props in the base's adopted
  const shells = ir.parts.filter((p) => p.id.endsWith('_shell'));
  assert.equal(shells.length, 4);
  assert.ok(shells.every((p) => p.stage === 'street'), JSON.stringify(shells.map((p) => [p.id, p.stage])));
  const fluids = ir.parts.flatMap((p) => (p.ops ?? []).filter((o) => o.op === 'fluid').map((o) => ({ ...o, stage: p.stage })));
  assert.deepEqual(fluids.map((o) => o.id).sort(), [...g.bodies].sort());
  assert.ok(fluids.every((o) => o.stage === 'fluids'));
  const other = ir.parts.filter((p) => !p.id.endsWith('_shell') && !(p.ops ?? []).some((o) => o.op === 'fluid') && !p.id.endsWith('_irr_design'));
  assert.ok(other.length > 0 && other.every((p) => p.stage === 'adopted'), JSON.stringify(other.map((p) => [p.id, p.stage])));
  assert.deepEqual(ir.revision.grow.irrigated, ['farm_m']);
  const chk = checkRegion({ ir, survey: fillMissing(asColumns(S.survey)).columns, blobs: (sha) => r.blobs.get(sha), standing: S.standing });
  const bad = chk.findings.filter((f) => /^M2[59]/.test(f.rule) && f.severity !== 'info');
  assert.deepEqual(bad, []);
  assert.ok(r.notes.some((n) => /irrigate: farm_m gets 4 sources \(2 x 2\)/.test(n)), r.notes.join(' | '));
});

test('a dry growth of an adopted street town is as before: one stage, the lot in adopted', async () => {
  const S = await town();
  const r = await twice(S, { grow: { lots: [FARM({ irrigate: false })] } });
  assert.deepEqual(r.ir.stages, ['adopted']);
  assert.equal(r.ir.lots.find((l) => l.id === 'farm_m').stage, 'adopted');
  const a = await twice(S, { grow: { lots: [{ id: 'farm_m', type: 'crop_farm', size: [20, 21] }] } });
  const strip = (ir) => { const { params, ...rest } = ir; void params; return JSON.parse(JSON.stringify(rest)); };
  assert.deepEqual(strip(a.ir), strip(r.ir), 'irrigate false plans as absent (the echoed params aside)');
});

test('a base naming street or lots out of order still refuses NOT_ALLOWED [irrigate]', async () => {
  const S = await town();
  for (const stages of [['adopted', 'lots'], ['street', 'adopted']]) {
    const eff = { ...S.eff, stages };
    assert.match(await errOf(reviseIR(eff, { grow: { lots: [FARM()] } }, ctxOf(S))), /^NOT_ALLOWED: \[irrigate\] region stages \(.*\) have no stage between/, JSON.stringify(stages));
  }
  assert.match(await errOf(reviseIR(S.eff, { grow: { lots: [FARM({ type: 'house', villager: 'dwelling' })] } }, ctxOf(S))), /^NOT_ALLOWED: \[irrigate\] grow lot farm_m is not a farm lot/);
});

test('survival: the adopted growth\'s bill holds each source\'s bed and four farmland sides (as dirt), once', async () => {
  const S = await town();
  const run = (lots) => {
    const c = S.eff.claim;
    return planRegion({
      programFile: path.join(KIT, 'regions', 'revise.mjs'), params: { spec: { parts: [], refill: [], grow: { lots } } },
      survey: S.survey, claim: { minX: c.minX, minZ: c.minZ, maxX: c.maxX, maxZ: c.maxZ, minY: c.minY, maxY: c.maxY },
      seed: revisionSeed(S.eff.seed ?? '0', 1), roles: S.eff.roles ?? {}, volumes: [], survival: true,
      revision: { rid: 1, position: 1, parent: { rid: 0, irSha: S.p.irSha }, base: { irSha: S.p.irSha }, effective: S.eff, standing: S.standing },
    });
  };
  const dry = await run([{ id: 'farm_m', type: 'crop_farm', size: [20, 21] }]);
  const wet = await run([FARM()]);
  const sum = (bom) => { const o = {}; for (const g of Object.values(bom ?? {})) for (const [i, n] of Object.entries(g)) o[i] = (o[i] ?? 0) + n; return o; };
  const d = sum(dry.survivalBom), w = sum(wet.survivalBom);
  const diff = {};
  for (const k of new Set([...Object.keys(d), ...Object.keys(w)])) if ((w[k] ?? 0) !== (d[k] ?? 0)) diff[k] = (w[k] ?? 0) - (d[k] ?? 0);
  const shells = wet.ir.parts.filter((p) => p.id.endsWith('_shell'));
  assert.equal(shells.length, 4);
  assert.equal(Object.values(diff).reduce((n, v) => n + v, 0), 20, JSON.stringify(diff));
  assert.ok(Object.values(diff).every((v) => v > 0), JSON.stringify(diff));
});
