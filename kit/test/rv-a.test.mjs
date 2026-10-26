// (6d RV-a, docs/CONTRACT.md "Phase 6d slice RV" §2-§3.4, §5, §9, §14 items 1, 2, 17) Additive revisions, the kit's side: the revise
// program and its IR, the guard and M29:revision (each class, the broken variants), the effective-IR merge, historySha, 300 seeded
// synthetic revisions (nothing standing changed, nothing written where the standing region forbids), plan/0's revision mode and
// artifact, and determinism (the revision IR over 3 plans; tile shas with 1 and 4 workers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { d3Town, reachInputs, KIT } from './d3-helpers.mjs';
import { realiseAll, prng } from './region-helpers.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { asColumns } from '../lib/region/pack.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';
import { classifyRevision } from '../lib/plan/revision.mjs';
import {
  REVISION_LIMITS, columnProblem, dirtyKeys, historySha, mergeEffective, nonAdditive, reviseIR, revisionSeed, revisionStanding, ridPrefix, standingClasses,
} from '../lib/region/revise.mjs';

// ---- the standing town (D3's flat_village fixture) and its ctx.standing, once
let T = null;
async function town() {
  if (T) return T;
  const t = await d3Town();
  const ir = t.p.ir;
  const RI = reachInputs({ ir, world: t.world, claim: t.claim });
  const eff = mergeEffective(ir);
  const standing = revisionStanding({ id: 'rg1', claim: t.claim, effective: eff, held: RI.besideReach.held, lots: { hall_1: { state: 'placed' }, cottage_1: { state: 'removed', siteId: 's9' }, cottage_2: { state: 'pad' }, farm_1: { state: 'removed', irrigated: true } } });
  const survey = RI.besideReach.survey;
  T = { t, ir, irSha: t.p.irSha, eff, standing, survey, RI };
  return T;
}
const ctxOf = (S, extra = {}) => ({ rid: 1, position: 1, parent: { rid: 0, irSha: S.irSha }, base: { irSha: S.irSha }, survey: S.survey, standing: S.standing, ...extra });
const errCode = async (p) => { try { await p; return null; } catch (e) { return /^([A-Z_]+): \[([a-z_]+)\]/.exec(e.message)?.slice(1, 3).join(' ') ?? e.message; } };
const POND = { id: 'pond', call: { fn: 'pond', rect: [88, 88, 96, 96] } };
const SPIRE = { id: 'spire', call: { fn: 'form', generator: 'rockSpire', params: { at: [100, 65, 20], height: [12, 14] } } };

test('reviseIR: only additions, prefixed ids, the base\'s stage names, the seed, the revision member', async () => {
  const S = await town();
  const r = await reviseIR(S.eff, { parts: [POND, SPIRE] }, ctxOf(S));
  const ir = r.ir;
  assert.ok(ir.parts.length >= 2);
  for (const p of ir.parts) assert.ok(p.id.startsWith(ridPrefix(1)), p.id);
  assert.deepEqual(ir.stages, ['ground', 'fluids']);
  assert.equal(ir.seed, revisionSeed(S.ir.seed, 1));
  assert.notEqual(revisionSeed(S.ir.seed, 1), revisionSeed(S.ir.seed, 2));
  assert.equal(ir.revision.rid, 1);
  assert.equal(ir.revision.position, 1);
  assert.deepEqual(ir.revision.parent, { rid: 0, irSha: S.irSha });
  assert.deepEqual(ir.revision.lots, { add: [], refill: [] });
  assert.deepEqual(nonAdditive(ir, S.standing), []);
  assert.ok(ir.stages.length <= REVISION_LIMITS.stagesPerRevision);
  // nothing of the standing region is in the revision IR
  const standingIds = new Set(S.ir.parts.map((p) => p.id));
  assert.ok(ir.parts.every((p) => !standingIds.has(p.id)));
  assert.ok(dirtyKeys(ir).length >= 1);
  // a lot and a refill
  const l = await reviseIR(S.eff, { parts: [{ id: 'shed', call: { fn: 'lot', at: [92, 20], size: [7, 7] } }], refill: ['cottage_1', 'cottage_2'] }, ctxOf(S));
  assert.deepEqual(l.ir.revision.lots, { add: ['rv1_shed'], refill: ['cottage_1', 'cottage_2'] });
  assert.equal(l.ir.lots[0].id, 'rv1_shed');
});

test('the guard: each class refuses with its code, before anything is written (§5.1, §5.2, §4.6, §5.4)', async () => {
  const S = await town();
  const c = ctxOf(S);
  const lot = S.ir.lots.find((q) => q.id === 'hall_1').box;
  const road = S.standing.footprint.keep.filter((k) => k.kind === 'road').map((k) => k.rect).find((q) => columnProblem(standingClasses(S.standing), q[0] + 1, q[1])?.kind === 'road');
  const K0 = standingClasses(S.standing);
  const way = S.standing.footprint.keep.filter((k) => k.kind !== 'road').map((k) => k.rect).find((q) => columnProblem(K0, q[0], q[1])?.kind === 'path');
  const col = (id, x, z) => ({ id, call: { fn: 'columns', cols: [x, z, 65, 66, 0], materials: ['structure'] } });
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', lot.minX + 1, lot.minZ + 1)] }, c)), 'COVERED lot');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', road[0] + 1, road[1])] }, c)), 'OVERLAP road');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', way[0], way[1])] }, c)), 'OVERLAP path');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', 100, 100)] }, ctxOf(S, { standing: { ...S.standing, keepOut: [[98, 98, 102, 102]] } }))), 'PROTECTED protected');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', 100, 100)] }, ctxOf(S, { standing: { ...S.standing, beside: [{ id: 'rg2', reach: [[99, 100, 101, 100]], hold: [] }] } }))), 'OVERLAP beside');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', 100, 100)] }, ctxOf(S, { standing: { ...S.standing, held: { ...S.standing.held, runs: [...S.standing.held.runs, [100, 100, 100, 100]] } } }))), 'OVERLAP held');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [col('a', 100, 100)] }, ctxOf(S, { standing: { ...S.standing, unfinished: ['1,1'] } }))), 'NOT_ALLOWED unfinished');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [], refill: ['farm_1'] }, c)), 'NOT_ALLOWED irrigated');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [], refill: ['hall_1'] }, c)), 'NOT_ALLOWED refill');
  assert.equal(await errCode(reviseIR(S.eff, { parts: [{ id: 'oak', call: { fn: 'columns', cols: [100, 100, 65, 65, 0], materials: ['minecraft:oak_planks'] } }] }, c)), 'NOT_ALLOWED theme');
  // a body's hard cells (the pond added first, then a second revision over it)
  const r1 = await reviseIR(S.eff, { parts: [POND] }, c);
  const eff2 = mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r1.ir }]);
  const st2 = revisionStanding({ id: 'rg1', claim: S.t.claim, effective: eff2, held: S.RI.besideReach.held });
  assert.equal(await errCode(reviseIR(eff2, { parts: [col('b', 92, 92)] }, { ...ctxOf(S), rid: 2, position: 2, standing: st2 })), 'OVERLAP body');
  // over the region's own terrain cells (layered over, §3.5): allowed
  const K = standingClasses(S.standing);
  const withTerrain = { ...S.standing, held: { runs: [...S.standing.held.runs, [100, 100, 100, 100]], town: [...S.standing.held.town, [100, 100, 100, 100]], terrain: [...S.standing.held.terrain, [100, 100, 100, 100]] } };
  assert.equal(columnProblem(standingClasses(withTerrain), 100, 100), null);
  await reviseIR(S.eff, { parts: [col('t', 100, 100)] }, ctxOf(S, { standing: withTerrain }));
});

test('M29:revision catches every broken variant the guard lets through (§2.5)', async () => {
  const S = await town();
  // (another site's block at (100, 100): a held column outside the town's footprint)
  const st = { ...S.standing, held: { ...S.standing.held, runs: [...S.standing.held.runs, [100, 100, 100, 100]] } };
  for (const [v, kind] of [['underLot', 'lot'], ['overRoad', 'road'], ['overPath', 'path'], ['ignoreHeld', 'held'], ['removePart', 'not_additive']]) {
    const r = await reviseIR(S.eff, { parts: [], unsafe: { [v]: true } }, ctxOf(S, { standing: st }));
    const rep = checkRegion({ ir: r.ir, survey: S.survey, standing: st, rules: ['M29'] });
    const m29 = rep.findings.filter((f) => f.rule === 'M29:revision' && f.severity === 'error');
    assert.ok(m29.length >= 1, `${v}: caught (${r.ir.parts.map((p) => p.id).join(',')})`);
    assert.ok(m29.some((f) => (kind === 'not_additive' ? /not additive/ : new RegExp(`kind: ${kind}`)).test(f.message)), `${v}: ${m29.map((f) => f.message).join(' | ')}`);
  }
  // a clean revision: no M29 finding; without the standing data the rule never runs (every other check unchanged)
  const ok = await reviseIR(S.eff, { parts: [POND] }, ctxOf(S));
  assert.equal(checkRegion({ ir: ok.ir, survey: S.survey, standing: S.standing, rules: ['M29'] }).findings.filter((f) => f.rule.startsWith('M29')).length, 0);
  assert.equal(checkRegion({ ir: S.ir, survey: S.survey, standing: S.standing, rules: ['M29'] }).findings.length, 0);
});

test('the effective IR: the base plus each revision\'s additions in position order; head', async () => {
  const S = await town();
  const r1 = (await reviseIR(S.eff, { parts: [POND] }, ctxOf(S))).ir;
  const eff1 = mergeEffective(S.ir, [{ rid: 1, position: 1, ir: r1 }]);
  const st1 = revisionStanding({ id: 'rg1', claim: S.t.claim, effective: eff1, held: S.RI.besideReach.held });
  const r3 = (await reviseIR(eff1, { parts: [SPIRE] }, { ...ctxOf(S), rid: 3, position: 2, standing: st1 })).ir;
  const e = mergeEffective(S.ir, [{ rid: 3, position: 2, ir: r3 }, { rid: 1, position: 1, ir: r1 }]);
  assert.equal(e.head, 3);
  assert.deepEqual(e.revisions.map((x) => [x.rid, x.position]), [[1, 1], [3, 2]]);
  assert.deepEqual(e.parts.map((p) => p.id), [...S.ir.parts.map((p) => p.id), ...r1.parts.map((p) => p.id), ...r3.parts.map((p) => p.id)]);
  assert.equal(e.parts.length, S.ir.parts.length + r1.parts.length + r3.parts.length);
  assert.deepEqual(e.stages, S.ir.stages);
  assert.equal(mergeEffective(S.ir).head, 0);
  // the base is never changed by a merge
  assert.equal(JSON.stringify(mergeEffective(S.ir).parts), JSON.stringify(S.ir.parts));
});

test('historySha: a canonical, layer-ordered hash of one key\'s entries; any change moves it', () => {
  const a = [{ layer: 0, stage: 'ground', set: 'terrain', tileSha: 'aa', status: 'ACTIVE' }, { layer: 1, stage: 'ground', set: 'terrain', tileSha: 'bb', status: 'ACTIVE' }];
  assert.equal(historySha(a), historySha([a[1], a[0]]));
  assert.notEqual(historySha(a), historySha([a[0]]));
  assert.notEqual(historySha(a), historySha([a[0], { ...a[1], status: 'UNDONE' }]));
  assert.notEqual(historySha(a), historySha([a[0], { ...a[1], tileSha: 'bc' }]));
  assert.equal(historySha([]), historySha(undefined));
  assert.match(historySha(a), /^[0-9a-f]{64}$/);
});

test('300 seeded synthetic additive revisions: deterministic, nothing standing changed, nothing written where the standing region forbids (item 1)', async () => {
  const S = await town();
  const K = standingClasses(S.standing);
  const rnd = prng(6061);
  const standingCells = realiseAll(S.ir, S.t.world);
  const mats = ['structure', 'foundation', 'path', 'rock', 'surface', null];
  let accepted = 0, refused = 0;
  const codes = {};
  for (let n = 0; n < 300; n++) {
    const parts = [];
    const k = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < k; i++) {
      const x = Math.floor(rnd() * 108) + 2, z = Math.floor(rnd() * 108) + 2, w = 1 + Math.floor(rnd() * 4), d = 1 + Math.floor(rnd() * 4);
      const cols = [];
      for (let xx = x; xx < Math.min(x + w, 111); xx++) for (let zz = z; zz < Math.min(z + d, 111); zz++) cols.push(xx, zz, 64 + Math.floor(rnd() * 2), 65 + Math.floor(rnd() * 3), 0);
      parts.push({ id: `p${i}`, call: { fn: 'columns', cols, materials: [mats[Math.floor(rnd() * mats.length)]], cond: Math.floor(rnd() * 4) } });
    }
    const req = { parts };
    let r;
    try { r = await reviseIR(S.eff, req, ctxOf(S, { rid: 1 + (n % 7) })); } catch (e) {
      const c = /^([A-Z_]+): \[([a-z_]+)\]/.exec(e.message);
      assert.ok(c, `#${n}: a named refusal (${e.message.slice(0, 120)})`);
      codes[c[0]] = (codes[c[0]] ?? 0) + 1;
      refused++;
      continue;
    }
    accepted++;
    // nothing standing named or changed
    assert.deepEqual(nonAdditive(r.ir, S.standing), [], `#${n}`);
    // no write in a forbidden column (independent of the guard: the kit's own evaluation of the revision IR)
    for (const c of realiseAll(r.ir, S.t.world).values()) assert.equal(columnProblem(K, c.x, c.z), null, `#${n}: (${c.x}, ${c.z})`);
    // deterministic: every 10th planned again
    if (n % 10 === 0) assert.equal((await reviseIR(S.eff, req, ctxOf(S, { rid: 1 + (n % 7) }))).irSha, r.irSha, `#${n}: deterministic`);
  }
  // the standing IR's own cells are unchanged by any of it (no revision rewrites a standing part)
  assert.equal(realiseAll(S.ir, S.t.world).size, standingCells.size);
  assert.ok(accepted >= 50 && refused >= 50, `accepted ${accepted}, refused ${refused}: ${JSON.stringify(codes)}`);
});

test('determinism (item 17): the revision IR over 3 plans; its tile shas with 1 and 4 workers', async () => {
  const S = await town();
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await reviseIR(S.eff, { parts: [POND, SPIRE] }, ctxOf(S)));
  assert.ok(rs.every((r) => r.irSha === rs[0].irSha));
  const { tileShas } = await import('../../tools/scenarios.mjs');
  const { encodeColumns } = await import('../lib/region/pack.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-det-'));
  try {
    fs.writeFileSync(path.join(dir, 'ir.json'), rs[0].irJson);
    fs.writeFileSync(path.join(dir, 'survey.bin'), Buffer.from(S.survey instanceof Uint8Array ? S.survey : encodeColumns(S.survey)));
    fs.mkdirSync(path.join(dir, 'blobs'));
    for (const [sha, b] of rs[0].blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
    const ts = await tileShas(dir);
    assert.ok(ts.workersSame, '1 worker = 4 workers');
    assert.ok(Object.keys(ts.tiles).length >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- plan/0's revision mode (§9)
const PV0 = path.join(KIT, 'regions', 'plan_v0.mjs');
const P0_TOWN = { schemaVersion: 'plan/0', planId: 'rv_town', zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }, { id: 'h2', type: 'house', size: [9, 9] }, { id: 'h3', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
async function p0(plan, survey, claim, revision = null) {
  const params = { plan, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await planRegion({ programFile: PV0, params, survey, claim, roles: {}, ...(revision ? { revision } : {}) });
  const f = finishCheck({ res, survey: fillMissing(asColumns(survey)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  return { res, ...f };
}

test('plan/0 revision mode: keep, add, refill, grow, change; the artifact\'s revisionOf, dirty, historySha; no parentArtifact is today\'s check (§9, item 4)', async () => {
  const { flatSurvey } = await import('./plan-helpers.mjs');
  const sv = flatSurvey({ W: 160, D: 160, x0: 0, z0: 0 });
  const parent = await p0(P0_TOWN, sv.bytes, sv.claim);
  assert.equal(parent.check.overall, 'READY');
  const built = parent.check.parts.filter((a) => a.class === 'fits' || a.class === 'adjusted').map((a) => a.part);
  const eff = mergeEffective(parent.res.ir);
  const lotsState = Object.fromEntries(parent.res.ir.lots.map((l) => [l.id, { state: l.id === 'h2' ? 'removed' : 'placed' }]));
  const standing = revisionStanding({ id: 'rg7', claim: [0, 0, 159, 159], effective: eff, lots: lotsState });
  const rv = (extra = {}) => ({ rid: 1, position: 1, region: 'rg7', parentRid: 0, parentArtifact: parent.artifactSha, parentIrSha: parent.res.irSha, base: { irSha: parent.res.irSha },
    parent: { plan: P0_TOWN, built, geometry: Object.fromEntries(parent.check.parts.filter((a) => a.geometry?.rect).map((a) => [a.part, a.geometry.rect])) }, standing, history: { '0,0': 'h00', '1,1': 'h11' }, heldSha: 'held', ...extra });
  const rev = (body) => ({ ...P0_TOWN, ...body, revision: { n: 1, parentArtifact: parent.artifactSha } });
  // keep + add: the town stands, a pond is added
  const pond = { id: 'pond', kind: 'pond', where: { near: { anchor: 'claim_center', within: 64 } }, size: { w: 7, d: 7 }, depth: 2 };
  const add = await p0(rev({ forms: [pond] }), sv.bytes, sv.claim, rv());
  const town = add.check.parts.find((a) => a.part === 'town');
  assert.equal(town.class, 'fits');
  assert.equal(town.standing, true);
  assert.ok(!town.cost?.cells, 'cost 0');
  assert.ok(['fits', 'adjusted'].includes(add.check.parts.find((a) => a.part === 'pond').class), JSON.stringify(add.check.parts.find((a) => a.part === 'pond')));
  // the IR holds only the pond (nothing of the town's), and the pond keeps off the town
  assert.ok(add.res.ir.parts.every((p) => !parent.res.ir.parts.some((q) => q.id === p.id && !/^(clear_|cam_)/.test(q.id))), add.res.ir.parts.map((p) => p.id).join(','));
  assert.equal(add.res.ir.revision.naming, 'plan');
  assert.equal(add.artifact.region.revisionOf.parentArtifact, parent.artifactSha);
  assert.deepEqual(add.artifact.dirty, dirtyKeys(add.res.ir));
  assert.deepEqual(Object.keys(add.artifact.historySha), add.artifact.dirty);
  assert.equal(add.artifact.inputs.held, 'held');
  assert.deepEqual(add.artifact.revision.keep, ['town']);
  assert.deepEqual(add.artifact.revision.add, ['pond']);
  // change: the same zone with another lot size
  const z2 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z2.program.lots[0].size = [11, 9];
  const ch = await p0(rev({ zones: [z2] }), sv.bytes, sv.claim, rv());
  const cz = ch.check.parts.find((a) => a.part === 'town');
  assert.equal(cz.class, 'unsupported');
  assert.equal(cz.reasons[0].block, 'revision.change');
  // grow: lots appended
  const z3 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z3.program.lots.push({ id: 'h4', type: 'house', size: [9, 9] });
  assert.equal((await p0(rev({ zones: [z3] }), sv.bytes, sv.claim, rv())).check.parts.find((a) => a.part === 'town').reasons[0].block, 'revision.grow');
  // refill: h2 (removed) gets refill: true and an entry
  const z4 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z4.program.lots[1] = { ...z4.program.lots[1], refill: true };
  const rf = await p0(rev({ zones: [z4] }), sv.bytes, sv.claim, rv());
  const rz = rf.check.parts.find((a) => a.part === 'town');
  assert.equal(rz.class, 'fits');
  assert.deepEqual(rz.refill, ['h2']);
  assert.ok(rf.artifact.lots.some((l) => l.id === 'h2' && l.refill === true));
  // refill of a placed lot answers change
  const z5 = JSON.parse(JSON.stringify(P0_TOWN.zones[0]));
  z5.program.lots[0] = { ...z5.program.lots[0], refill: true };
  assert.equal((await p0(rev({ zones: [z5] }), sv.bytes, sv.claim, rv())).check.parts.find((a) => a.part === 'town').reasons[0].block, 'revision.change');
  // gone: a plan without the town notes it
  const gone = await p0(rev({ zones: [], forms: [pond] }), sv.bytes, sv.claim, rv());
  assert.ok(gone.check.notes.some((n) => /town gone from the plan/.test(n)));
  // the same plan without the revision input (no parentArtifact's input from the mod): today's check, byte for byte with a plain plan
  const plain = await p0({ ...P0_TOWN, forms: [pond] }, sv.bytes, sv.claim);
  assert.equal(plain.res.ir.revision, undefined);
  assert.equal(plain.artifact.dirty, undefined);
  // classify: the parent's dropped parts are added
  const cls = classifyRevision({ ...P0_TOWN, forms: [pond] }, { plan: { ...P0_TOWN, forms: [pond] }, built: ['town'] });
  assert.equal(cls.classOf.get('pond').klass, 'add');
  assert.equal(cls.classOf.get('town').klass, 'keep');
});

test('the catalogue: revision.keep, add and refill supported, grow (until GR) and change (until RV2) reserved, each NEXT', async () => {
  const { planCatalogue } = await import('../lib/plan/catalogue.mjs');
  const e = Object.fromEntries(planCatalogue().entries.filter((x) => x.id.startsWith('revision.')).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(e).sort(), ['revision.add', 'revision.change', 'revision.grow', 'revision.keep', 'revision.refill']);
  for (const id of ['revision.keep', 'revision.add', 'revision.refill']) assert.equal(e[id].state, 'supported');
  assert.equal(e['revision.grow'].until, 'GR');
  assert.equal(e['revision.change'].until, 'RV2');
});
