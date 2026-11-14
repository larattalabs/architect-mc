// (7c PF, docs/CONTRACT.md "Phase 7c" §2 and "Slice PF as built") Promoted-shape wiring: plan/0's `form.arch_span` (the promoted archSpan
// module as an ordinary catalogue entry: plan compile, the compact copy, the Java side), the aqueduct's arches drawn with the module's
// round profile (course.mjs archRise), and an aqueduct IR planned before PF still evaluating to its recorded tiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCatalogue, planCatalogueKinds } from '../lib/plan/catalogue.mjs';
import { PLAN_SCHEMA, validatePlan } from '../lib/plan/schema.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { themeOffenders } from '../lib/lint/theme.mjs';
import { evalTile } from '../lib/realise.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { archRise } from '../lib/fluids/course.mjs';
import { soffit, VERSION } from '../lib/forms/archSpan.mjs';
import { checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'plan');
const fixture = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, `${rel}.json`), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

async function planFx(fx, { survival = false } = {}) {
  const s = flatSurvey(fx.terrain ?? {});
  const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, volume: fx.volume ?? {}, ...(survival ? { survival: true } : {}) });
  const blobs = (sha) => r.res?.blobs?.get(sha) ?? null;
  const volumes = (r.volumes ?? []).map((v) => v.decoded);
  return { ...r, s, blobs, report: () => checkRegion({ ir: r.res.ir, survey: s.bytes, blobs, meta: r.res.meta, volumes }), world: () => buildVirtual({ ir: r.res.ir, survey: s.bytes, blobs, volumes }).vw };
}
const partOf = (r, id) => r.check.parts.find((a) => a.part === id);
const errors = (rep) => rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.part}: ${f.message}`);
const name = (vw, x, y, z) => String(vw.pal.states[vw.get(x, y, z)] ?? 'minecraft:air').replace(/\[.*$/, '');
const groundOf = (T) => (x, z) => { let y = T.y; for (const b of T.bands) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) y = b.y; return y; };
const tilesOf = (ir, survey, blobs) => {
  const out = [];
  let cells = 0;
  for (const st of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles[st]?.[set] ?? []) {
    const t = evalTile(ir, key, windowFromSurvey(survey, key), { stage: st, set, blobs });
    out.push(`${st} ${set} ${key} ${t.sha}`);
    cells += t.count;
  }
  return { tiles: out, cells };
};

test('catalogue: form.arch_span supported (schemaVersion 1, sinceApi NEXT or stamped, a def, limits from archSpan\'s ranges); served on demand', () => {
  const e = planCatalogue().entries.find((x) => x.id === 'form.arch_span');
  assert.equal(e.state, 'supported');
  assert.equal(e.schemaVersion, 1);
  assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
  assert.equal(e.until, undefined);
  assert.deepEqual([e.limits.length, e.limits.width, e.limits.height, e.limits.tiers, e.limits.drop], [[12, 128], [3, 9], [6, 48], [1, 2], 32]);
  const src = PLAN_SCHEMA['x-catalogue'].entries.find((x) => x.id === 'form.arch_span');
  assert.equal(src.def, '#/$defs/form.arch_span');
  const def = PLAN_SCHEMA.$defs['form.arch_span'];
  assert.equal(def.additionalProperties, false);
  assert.equal(def.properties.kind.const, 'arch_span');
  const k = planCatalogueKinds(['form.arch_span']);
  assert.equal(k.entries.length, 1);
  assert.ok(k.entries[0].def.properties.length, 'its def served by kind');
  // a part past its limits is malformed for the part (the schema), not refused at compile
  const v = validatePlan({ schemaVersion: 'plan/0', forms: [{ id: 'a', kind: 'arch_span', length: 200 }] });
  assert.notEqual(v.parts.find((p) => p.id === 'a')?.verdict, 'compile', JSON.stringify(v.parts));
});

test('x01_viaduct (the builder-written example): an arch span across a valley 8 deep, fits; ir.forms records archSpan at the module\'s VERSION; checks clean; piers on the valley floor; the same IR twice', async () => {
  const fx = fixture('pf/x01_viaduct');
  const r = await planFx(fx);
  assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
  const a = partOf(r, 'viaduct');
  assert.equal(a.class, 'fits');
  assert.equal(a.block, 'form.arch_span');
  const g = a.geometry.archSpan;
  assert.deepEqual([g.axis, g.length, g.width, g.height, g.tiers, g.profile, g.parapet, g.species, g.version], ['x', 64, 5, 12, 1, 'round', 'wall', 'viaduct', VERSION]);
  assert.equal(g.at[1], 73, 'the springing one over the plateaus (72)');
  const f = r.res.ir.forms.find((x) => x.generator === 'archSpan');
  assert.equal(f.version, VERSION);
  assert.deepEqual(errors(r.report()), []);
  const vw = r.world();
  assert.deepEqual(themeOffenders(r.res.ir, vw, { meta: r.res.meta }).offenders, [], 'S-THEME');
  // along the deck's centre line: every column solid at the deck; over the valley, a pier column stands on the valley floor and an
  // arch column is open under its soffit
  const ground = groundOf(fx.terrain);
  const z = g.at[2], deck = g.deckY;
  let piers = 0, open = 0;
  for (let x = g.at[0]; x < g.at[0] + g.length; x++) {
    assert.equal(name(vw, x, deck, z), 'minecraft:stone_bricks', `the deck at ${x}`);
    if (ground(x, z) >= 72) continue;
    if (name(vw, x, ground(x, z) + 1, z) === 'minecraft:stone_bricks') piers++;
    else open++;
  }
  assert.ok(piers >= 2 && open >= 16, `piers ${piers}, open ${open}`);
  const again = await planFx(fx);
  assert.equal(again.res.irJson, r.res.irJson, 'deterministic');
});

test('survival: the arch span is a built form, a construction target (its masonry billed, nothing free): its bill is its cells', async () => {
  const r = await planFx(fixture('pf/x01_viaduct'), { survival: true });
  assert.equal(r.check.overall, 'READY');
  const a = partOf(r, 'viaduct');
  assert.equal(a.cost.survival.free, 0);
  assert.deepEqual(a.cost.survival.bom, { 'minecraft:stone_bricks': a.cost.added });
  const p = r.res.ir.parts.find((q) => q.id === 'f_viaduct');
  assert.ok(p.ops.length && p.ops.every((o) => !o.free), 'no op of the span is a terrain write');
});

test('refusals and notes: params not read are noted; two tiers under 12 high refused; ground deeper than 32 under the springing refused NO_ROOM', async () => {
  const fx = clone(fixture('pf/x01_viaduct'));
  fx.plan.forms[0].params = { glow: true };
  assert.ok(partOf(await planFx(fx), 'viaduct').notes.some((n) => /^params glow: not read/.test(n)));
  const t2 = clone(fixture('pf/x01_viaduct'));
  Object.assign(t2.plan.forms[0], { tiers: 2, height: 8 });
  const a2 = partOf(await planFx(t2), 'viaduct');
  assert.equal(a2.class, 'refused');
  assert.match(a2.reasons[0].message, /two tiers need height 12/);
  const deep = clone(fixture('pf/x01_viaduct'));
  deep.terrain.bands = [{ x0: 1000, x1: 1079, z0: 2000, z1: 2039, y: 100 }, { x0: 1030, x1: 1049, z0: 2000, z1: 2039, y: 64 }];
  const a3 = partOf(await planFx(deep), 'viaduct');
  assert.equal(a3.class, 'refused', JSON.stringify(a3));
  assert.equal(a3.reasons[0].code, 'NO_ROOM');
  assert.equal(a3.reasons[0].evidence.limit, 32);
});

test('aqueduct arches from the module: archRise is archSpan\'s round soffit, and x01\'s arches stand 1 + crown - soffit under the floor', async () => {
  for (let n = 1; n <= 7; n++) {
    assert.deepEqual(archRise(n), Array.from({ length: n }, (_, t) => Math.floor(soffit('round', n, Math.abs(t + 0.5 - n / 2), 0, 0) + 0.5)), `n ${n}`);
  }
  assert.deepEqual(archRise(7), [2, 3, 3, 4, 3, 3, 2]);
  const fx = fixture('aq/x01_valley_aqueduct');
  const r = await planFx(fx);
  const vw = r.world();
  const ground = groundOf(fx.terrain);
  const z = fx.anchors.a[2], floor = 69;
  // per valley column: the solid run under the floor (a pier: down to the ground; an arch: its thickness)
  const runs = [];
  for (let x = fx.terrain.x0; x < fx.terrain.x0 + fx.terrain.W; x++) {
    if (ground(x, z) >= 72 || name(vw, x, 71, z) !== 'minecraft:water') continue;
    let n = 0;
    for (let y = floor - 1; y > ground(x, z) && name(vw, x, y, z) !== 'minecraft:air'; y--) n++;
    runs.push({ x, n, pier: n === floor - 1 - ground(x, z) });
  }
  // every clear run between two piers is the module's profile: 1 + crown - soffit
  let arches = 0;
  for (let i = 0; i < runs.length; i++) {
    if (!runs[i].pier) continue;
    let j = i + 1;
    while (j < runs.length && !runs[j].pier) j++;
    if (j >= runs.length) break;
    const clear = runs.slice(i + 1, j);
    if (clear.length === 7) {
      const s = archRise(7), crown = Math.max(...s);
      assert.deepEqual(clear.map((c) => c.n), clear.map((c, k) => Math.min(1 + crown - s[k], floor - 2 - ground(c.x, z))), `the arch from ${runs[i].x}`);
      arches++;
    }
    i = j - 1;
  }
  assert.ok(arches >= 2, `${arches} full arches`);
});

test('older aqueduct IRs: x01 planned on main before PF (AQ\'s own soffit) evaluates to its recorded tiles; today\'s plan differs only in the span part', async () => {
  const old = fixture('aq/pre-pf-x01');
  assert.equal(old.base, 'c787a7e5');
  const fx = fixture('aq/x01_valley_aqueduct');
  const s = flatSurvey(fx.terrain);
  const blobs = (sha) => (old.blobs[sha] ? new Uint8Array(Buffer.from(old.blobs[sha], 'base64')) : null);
  const t = tilesOf(old.ir, s.bytes, blobs);
  assert.deepEqual(t.tiles, old.tiles, 'the old IR evaluates as it did');
  assert.equal(t.cells, old.cells);
  const now = await planFx(fx);
  const ir = now.res.ir;
  assert.deepEqual(now.check.parts.find((p) => p.part === 'canal').geometry.aqueduct, old.aqueduct, 'the answer\'s aqueduct row is unchanged');
  const strip = (x) => x.parts.filter((p) => p.id !== 'canal_span').map((p) => JSON.stringify(p));
  assert.deepEqual(strip(ir), strip(old.ir), 'every part but the span is byte-identical');
  const cellsOf = (p) => p.ops.reduce((n, o) => { for (let i = 0; i < o.cols.length; i += 5) n += o.cols[i + 3] - o.cols[i + 2] + 1; return n; }, 0);
  const span = (x) => cellsOf(x.parts.find((p) => p.id === 'canal_span'));
  assert.equal(span(old.ir), old.spanCells);
  assert.equal(span(ir), old.spanCells + 14, 'the module\'s round soffit: 14 more arch cells over x01\'s 4 bays');
});
