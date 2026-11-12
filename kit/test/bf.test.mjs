// (7c BF, docs/CONTRACT.md "Phase 7c" §3 row 2 and "Slice BF as built") The big forms: form.hollow_mountain, form.crater and
// form.floating_island supported; their generators (deterministic, natural only), the plan compiler's placement and emit, the
// builder-written examples (fixtures/plan/bf/x01-x03) checked clean, the hollow mountain's affordances, a crater's lake as an H pond
// body, the island floating on its anchor, survival free, and the recorded asks that waited on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalogue, planCatalogueKinds } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA, validatePlan } from '../lib/plan/schema.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { hollowMountain, LEDGE, WALL } from '../lib/forms/hollowMountain.mjs';
import { crater } from '../lib/forms/crater.mjs';
import { floatingIsland } from '../lib/forms/floatingIsland.mjs';
import { FREE_NATURAL } from '../lib/region/survival.mjs';
import { asksSurvey, checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'plan', 'bf');
const ASKS = path.join(HERE, 'fixtures', 'plan', 'asks');
const IDS = ['form.hollow_mountain', 'form.crater', 'form.floating_island'];
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), 'utf8'));

async function planFx(fx, { survival = false } = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: fx.volume ?? {}, ...(survival ? { survival: true } : {}) });
  const blobs = (sha) => r.res.blobs.get(sha) ?? null;
  const volumes = r.volumes.map((v) => v.decoded);
  return { ...r, s, blobs, check: r.check, report: () => checkRegion({ ir: r.res.ir, survey: s.bytes, blobs, meta: r.res.meta, volumes }), world: () => buildVirtual({ ir: r.res.ir, survey: s.bytes, blobs, volumes }).vw };
}
const partOf = (r, id) => r.check.parts.find((a) => a.part === id);
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.part}: ${f.message}`);

test('catalogue: the three ids supported with their defs and limits, sinceApi NEXT (or stamped), no until; served on demand with their defs', () => {
  const cat = planCatalogue();
  for (const id of IDS) {
    const e = cat.entries.find((x) => x.id === id);
    assert.equal(e.state, 'supported', id);
    assert.equal(e.until, undefined, id);
    assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), id);
    assert.ok(Array.isArray(e.limits.size), id);
    const raw = PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === id);
    assert.equal(raw.def, `#/$defs/${id}`);
    assert.equal(raw.draft, undefined);
    assert.equal(PLAN_SCHEMA.$defs[id]['x-state'], undefined);
    assert.equal(PLAN_SCHEMA.$defs[id].additionalProperties, false);
    assert.equal(PLAN_SCHEMA.$defs[id].properties.params.type, 'object', `${id}: params stays loose (Steward's recorded params)`);
  }
  const k = planCatalogueKinds(IDS);
  assert.deepEqual(k.entries.map((e) => e.id).sort(), [...IDS].sort());
  for (const e of k.entries) assert.ok(e.def && !e.def['x-state'], e.id);
});

test('schema: a big form is strict-checked (unknown member, size past its limits: malformed); params loose', () => {
  const mk = (f) => validatePlan({ schemaVersion: 'plan/0', planId: 't', forms: [{ id: 'f', where: { inside: { claim: true } }, ...f }] });
  const v = (f) => mk(f).parts[0];
  assert.equal(v({ kind: 'crater', size: { preset: 'M' }, lake: true, params: { anything: 1 } }).verdict, 'compile');
  assert.equal(v({ kind: 'crater', colour: 'red' }).verdict, 'malformed');
  assert.equal(v({ kind: 'hollow_mountain', size: { w: 120, d: 48 } }).verdict, 'malformed');
  assert.equal(v({ kind: 'hollow_mountain', halls: 4 }).verdict, 'malformed');
  assert.equal(v({ kind: 'floating_island', size: { w: 16, d: 16 }, pads: 2 }).verdict, 'compile');
});

test('generators: deterministic, natural materials only (roles or free natural blocks), sane params refused', () => {
  const g = () => 64;
  const rect = { minX: 0, minZ: 0, maxX: 47, maxZ: 47 };
  const a = hollowMountain({ rect, groundAt: g, seed: 's' }), b = hollowMountain({ rect, groundAt: g, seed: 's' });
  assert.equal(JSON.stringify(a.ops), JSON.stringify(b.ops));
  const c1 = crater({ rect, groundAt: g, lake: true }), c2 = crater({ rect, groundAt: g, lake: true });
  assert.equal(JSON.stringify(c1.ops), JSON.stringify(c2.ops));
  const roles = new Set(['rock', 'subsurface', 'surface']);
  for (const op of [...a.ops, ...c1.ops]) for (const m of op.materials ?? [op.material]) assert.ok(m === null || roles.has(m) || FREE_NATURAL.has(m), String(m));
  assert.throws(() => hollowMountain({ rect, groundAt: g, halls: 5 }), /halls/);
  assert.throws(() => hollowMountain({ rect: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, groundAt: g }), /at least 24/);
  assert.throws(() => crater({ rect, groundAt: g, depth: 30 }), /depth/);
  // the cavern: its floor at base + 1, a vertical wall of WALL cells, the ledge LEDGE.rise over the floor on the back wall
  assert.equal(a.floorY, 65);
  assert.ok(a.cavern.ledge.cells > 0 && a.cavern.ledge.y === 65 + LEDGE.rise && a.cavern.box.maxY - a.cavern.box.minY + 1 >= WALL);
  assert.equal(a.cavern.ledge.side, 'north', 'the back wall is opposite the (default south) entrance');
  // 6b's island: an explicit `edge: null` writes no rail (it read 'rail' before BF)
  const isl = floatingIsland({ at: [0, 100, 0], r: [12, 12], top: { edge: null } });
  assert.ok(!JSON.stringify(isl.ops).includes('"rail"'));
  assert.ok(JSON.stringify(floatingIsland({ at: [0, 100, 0], r: [12, 12] }).ops).includes('"rail"'), 'absent: the rail, as before');
});

test('x01 hollow mountain with carved halls: fits; cavern, ledge, 3 halls, the entrance; checks clean (no error, M5 cavern lit); its affordances recorded', async () => {
  const r = await planFx(fixture('x01_hollow_mountain'));
  const a = partOf(r, 'hold');
  assert.equal(r.check.overall, 'READY');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.equal(a.geometry.halls.length, 3);
  assert.equal(a.geometry.floorY, 65);
  const rep = r.report();
  assert.deepEqual(errors(rep), []);
  assert.deepEqual(rep.findings.filter((f) => f.rule === 'M5' && f.part).map((f) => f.message), [], 'the cavern floor is lit');
  assert.deepEqual(rep.findings.filter((f) => /^M3/.test(f.rule)).map((f) => f.message), []);
  // the plan's affordances (Regions.affordances): cliff faces, a cave and the ledge, inside the mountain
  const ids = a.geometry.affordances;
  assert.ok(ids.some((x) => x.startsWith('cave_')) && ids.some((x) => x.startsWith('cliff_face_')) && ids.some((x) => x.startsWith('ledge_')), ids.join(' '));
  // ... and in plan.json's affordances[] (api.Regions.affordances), each inside the mountain's rect
  const rec = new Map((r.res.affordances ?? []).map((x) => [x.id, x]));
  const [rx0, rz0, rx1, rz1] = a.geometry.rect;
  for (const id of ids) {
    assert.ok(rec.has(id), `${id} in plan.json's affordances[]`);
    const b = rec.get(id).box;
    assert.ok(b.minX >= rx0 - 2 && b.maxX <= rx1 + 2 && b.minZ >= rz0 - 2 && b.maxZ <= rz1 + 2, `${id} inside the mountain`);
  }
  // the cavern is air in the plan's world and lit (a shroomlight in the floor every few cells)
  const vw = r.world();
  const [x0, y0, z0, x1, , z1] = a.geometry.cavern;
  const mx = (x0 + x1) >> 1, mz = (z0 + z1) >> 1;
  assert.equal(vw.pal.states[vw.get(mx, y0 + 2, mz)], 'minecraft:air');
  let lights = 0;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (vw.pal.states[vw.get(x, y0 - 1, z)] === 'minecraft:shroomlight') lights++;
  assert.ok(lights >= 4, `${lights} floor lights`);
  // the mountain stands over the claim's ground (a mountain raised on flat land, noted)
  assert.ok(vw.pal.states[vw.get(mx, y0 + 30, mz)] !== 'minecraft:air' || vw.pal.states[vw.get(mx, y0 + 20, mz)] !== 'minecraft:air');
  assert.ok(a.notes.some((n) => /no mountain stands here/.test(n)));
});

test('x02 free crater with a lake: fits; the bowl carved and lined, the rim raised, the lake an H pond body (sources, shell), checks clean', async () => {
  const r = await planFx(fixture('x02_crater_lake'));
  const a = partOf(r, 'crater');
  assert.equal(r.check.overall, 'READY');
  assert.equal(a.class, 'fits', JSON.stringify(a.reasons));
  assert.ok(a.geometry.lake && a.geometry.lake.body === 'w_crater', JSON.stringify(a.geometry));
  const fluid = r.res.ir.parts.flatMap((p) => p.ops).filter((o) => o.op === 'fluid');
  assert.equal(fluid.length, 1);
  assert.ok(fluid[0].cells.length > 0 && fluid[0].shell.length > 0);
  assert.ok(r.res.ir.stages.at(-1) === 'fluids');
  const rep = r.report();
  assert.deepEqual(errors(rep), []);
  const vw = r.world();
  const [cx, , cz] = a.geometry.centre;
  assert.equal(vw.pal.states[vw.get(cx, a.geometry.lake.level, cz)], 'minecraft:water');
  assert.equal(vw.pal.states[vw.get(cx, a.geometry.lake.level + 1, cz)], 'minecraft:air');
  // without the lake: no body, no fluids stage
  const dry = JSON.parse(JSON.stringify(fixture('x02_crater_lake')));
  dry.plan.forms[0].lake = false;
  const d = await planFx(dry);
  assert.equal(partOf(d, 'crater').class, 'fits');
  assert.equal(d.res.ir.parts.flatMap((p) => p.ops).filter((o) => o.op === 'fluid').length, 0);
});

test('x03 floating-island hamlet: the island floats on its anchor (M3 clean), its 3 pads flat, natural only; the hamlet beside it', async () => {
  const r = await planFx(fixture('x03_island_hamlet'));
  const a = partOf(r, 'isle');
  assert.ok(['fits', 'adjusted'].includes(a.class), JSON.stringify(a.reasons));
  assert.equal(partOf(r, 'hamlet').class, 'fits');
  assert.equal(a.geometry.pads.length, 3);
  assert.ok((r.res.ir.floating ?? []).some((f) => f.parts.includes('f_isle')));
  const rep = r.report();
  assert.deepEqual(errors(rep), []);
  assert.deepEqual(rep.findings.filter((f) => /^M3/.test(f.rule)).map((f) => f.message), []);
  const vw = r.world();
  const seen = new Set();
  const pid = r.res.ir.parts.findIndex((p) => p.id === 'f_isle');
  vw.eachWritten((x, y, z, idx, f, part) => { if (part === pid) seen.add(vw.pal.states[idx].replace(/\[.*$/, '')); });
  for (const b of seen) assert.ok(FREE_NATURAL.has(b), `${b} is a free natural block`);
});

test('survival: the three forms bill nothing (natural cut and fill, free); a lake\'s shell is its pond\'s (H)', async () => {
  for (const [n, id] of [['x01_hollow_mountain', 'hold'], ['x03_island_hamlet', 'isle']]) {
    const r = await planFx(fixture(n), { survival: true });
    const a = partOf(r, id);
    assert.equal(r.check.survival, true);
    assert.deepEqual(a.cost.survival.bom, {}, `${id}: ${JSON.stringify(a.cost.survival)}`);
    assert.ok(a.cost.survival.free > 0 && a.cost.survival.held === 0, id);
  }
  const dry = JSON.parse(JSON.stringify(fixture('x02_crater_lake')));
  dry.plan.forms[0].lake = false;
  const d = await planFx(dry, { survival: true });
  assert.deepEqual(partOf(d, 'crater').cost.survival.bom, {});
  const wet = await planFx(fixture('x02_crater_lake'), { survival: true });
  const bom = partOf(wet, 'crater').cost.survival.bom;
  assert.deepEqual(Object.keys(bom), ['minecraft:dirt'], 'the lake\'s shell: its pond\'s bill (H)');
});

test('the recorded asks that waited on the three forms (dwarven_hold, ring_city, sky_monastery, crater_mine) answer fits or adjusted', async () => {
  const s = asksSurvey();
  for (const [f, id] of [['dwarven_hold', 'mountain_hollow'], ['ring_city', 'crater_lake'], ['sky_monastery', 'sky_island'], ['crater_mine', 'crater']]) {
    const plan = JSON.parse(fs.readFileSync(path.join(ASKS, `${f}.json`), 'utf8')).answer.plan;
    const r = await checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: stewardAnchors(s.claim), volume: {} });
    const a = partOf(r, id);
    assert.ok(['fits', 'adjusted'].includes(a.class), `${f}/${id}: ${a.class} ${JSON.stringify(a.reasons)}`);
  }
});
