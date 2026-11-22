#!/usr/bin/env node
// (RTE5) The second compatibility corpus's worker (kit/tools/rte5-compat-fixture.mjs runs it once per released kit, in that release's tree):
//   node kit/tools/rte5-compat-worker.mjs plan <kit root> <in.json> <out.json>   plan (when a case has no IR yet) and run each case's ops
//   node kit/tools/rte5-compat-worker.mjs read <kit root> <in.json> <out.json>   that root's readers over every case's rounds
// As RTE4's worker (kit/tools/rte-compat-worker.mjs): every kit module comes from <kit root>, so a release's IRs and readings are its own.
// The shapes RTE4's corpus lacked (v0.89.0 fix check): plan_v0 zones (architect_mc:street flags), bandless growth (a V district's street
// extension), boundaries other than a shore (a ridge, a biome edge), districts beside a town (a seam join, a reach join, a gate join
// through a wall), histories with undo and a revision after it (a gap in position, a new rid), histories one release starts and
// another continues, and releases before v0.85.0; land is compared by exact cell runs.
// A case: {id, family, recipe, seed, districts | zones, ops: [['grow', district, lots, prefer, zone?] | ['undo', toPosition]]}.
// Its state: ir, revisions [{rid, position, by, ir}], rounds [{revs: [rid...], revised}] (round 0 the plan), log [[op..., outcome, by]].
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const V = (id) => ({ id, size: [40, 40], lots: 1, shared: 'square' });
const F = (id, follow = { shore: {} }) => ({ id, size: [48, 24], follow, lots: 2 });
const g = (d, lots = 2, prefer = 'extend', zone) => ['grow', d, lots, prefer, ...(zone ? [zone] : [])];
const PV_LOTS = (id) => [{ id: `${id}_h1`, type: 'house', size: [9, 9] }];

/** The corpus's cases. */
export function cases() {
  const out = [];
  // ---- plan_v0: a districts zone `town` (each street stamped {zone, district}); with a plain village zone `old` (stamped {zone}) beside it
  for (const ids of [['b', 'b_1'], ['b', 'b_street'], ['b_street'], ['b_street', 'c'], ['quay', 'quayside', 'quay_1']]) {
    const zones = [{ id: 'town', program: { districts: ids.map((id) => ({ id, size: { w: 40, d: 40 }, lots: PV_LOTS(id) })) } }];
    out.push({ id: `pv0_${ids.join('-')}`, family: 'plan_v0', recipe: 'flat224', seed: '7', zones, ops: ids.slice(0, 2).flatMap((d) => [g(d, 1, 'extend', 'town'), g(d, 1, 'frontage', 'town')]) });
  }
  out.push({ id: 'pv0_two_zones', family: 'plan_v0', recipe: 'flat224', seed: '3', zones: [
    { id: 'old', program: { lots: [{ id: 'o1', type: 'house', size: [9, 9] }, { id: 'o2', type: 'house', size: [9, 9] }] } },
    { id: 'town', program: { districts: ['b', 'b_street'].map((id) => ({ id, size: { w: 40, d: 40 }, lots: PV_LOTS(id) })) } },
  ], ops: [g('b', 1, 'extend', 'town'), g('b_street', 1, 'extend', 'town')] });
  // ---- bandless growth: a V district's street extension (architect_mc:street, no band), then a frontage lot on it, then the other's
  for (const ids of [['b', 'b_1'], ['b', 'b_street'], ['b_street'], ['x', 'x_g1']]) for (const seed of ['7', '3']) {
    out.push({ id: `ext_${ids.join('-')}_${seed}`, family: 'districts', recipe: 'flat160', seed, districts: ids.map(V), ops: [g(ids[0], 1), g(ids[0], 1, 'frontage'), g(ids[ids.length - 1], 1)] });
  }
  // ---- boundaries other than a shore: a ridge (a crest across the claim), a biome edge (desert west of x 96, jungle east)
  for (const ids of [['b', 'b_1'], ['b', 'b_street'], ['quay', 'quay_1']]) for (const seed of ['1', '2']) {
    const z = ids[ids.length - 1];
    out.push({ id: `ridge_${ids.join('-')}_${seed}`, family: 'districts', recipe: 'ridge', seed, districts: ids.map((id) => F(id, { ridge: {} })), ops: [g(z), g(ids[0]), g(z)] });
  }
  for (const ids of [['b', 'b_1'], ['b_street']]) {
    out.push({ id: `biome_${ids.join('-')}`, family: 'districts', recipe: 'biome', seed: '1', districts: ids.map((id) => F(id, { biome_edge: { between: ['desert', 'jungle'] } })), ops: [g(ids[ids.length - 1]), g(ids[0])] });
  }
  // ---- beside a town (D3's flat_village, claim 0..111): a seam join (D1's fixture), a reach join (east, the town's reach inputs), a gate
  // join (GJ's walled town: through the ring's gate)
  for (const ids of [['b', 'b_1'], ['b_street']]) {
    out.push({ id: `seam_${ids.join('-')}`, family: 'beside', join: 'seam', recipe: 'flat', claimB: [-60, 13, 11, 93], standingClaim: [0, 0, 111, 111], seed: '1', districts: ids.map((id) => ({ id, size: [40, 40], lots: 1, shared: 'square' })), ops: [g(ids[0], 1), g(ids[ids.length - 1], 1, 'frontage')] });
    out.push({ id: `reach_${ids.join('-')}`, family: 'beside', join: 'reach', recipe: 'flat', claimB: [100, 13, 180, 93], standingClaim: [0, 0, 111, 111], seed: '1', districts: ids.map((id) => ({ id, size: [40, 40], lots: 1, shared: 'square' })), ops: [g(ids[0], 1), g(ids[ids.length - 1], 1, 'frontage')] });
  }
  for (const ids of [['b'], ['b_street']]) {
    out.push({ id: `gate_${ids.join('-')}`, family: 'gate', join: 'gate', recipe: 'flat', claimB: [112, 30, 201, 81], standingClaim: [0, 0, 111, 111], seed: '1', districts: ids.map((id) => ({ id, size: [48, 48], lots: 4 })), ops: [g(ids[0], 1)] });
  }
  // ---- undo: grow twice, undo to 1, grow again (rid 3 at position 2), undo to 0 (land stays v2), grow (rid 4 at position 1)
  for (const [ids, recipe] of [[['b', 'b_1'], 'shore'], [['b', 'b_1', 'b_1_g1'], 'shore'], [['b', 'b_street'], 'flat160']]) {
    const ds = recipe === 'shore' ? ids.map((id) => F(id)) : ids.map(V);
    const a = ids[0], z = ids[ids.length - 1];
    out.push({ id: `undo_${recipe}_${ids.join('-')}`, family: 'districts', recipe, seed: '1', districts: ds, ops: [g(z), g(a), ['undo', 1], g(a), ['undo', 0], g(z)] });
  }
  return out;
}
/** Cases one release starts and later ones continue (rte5-compat-fixture.mjs hands each stretch of ops to the next tree). */
export function mixedCases() {
  const sh = (ids) => ids.map((id) => F(id));
  return [
    { id: 'mix_shore_b-b_1', family: 'districts', recipe: 'shore', seed: '1', districts: sh(['b', 'b_1']), ops: [g('b_1'), g('b'), g('b_1'), g('b')] },
    { id: 'mix_shore_b_1_g1-b', family: 'districts', recipe: 'shore', seed: '2', districts: sh(['b_1_g1', 'b']), ops: [g('b'), g('b_1_g1'), g('b'), g('b_1_g1')] },
    { id: 'mix_shore_quay-quay_1', family: 'districts', recipe: 'shore', seed: '1', districts: sh(['quay', 'quay_1']), ops: [g('quay_1'), g('quay'), ['undo', 1], g('quay'), g('quay_1')] },
    { id: 'mix_flat_b-b_street', family: 'districts', recipe: 'flat160', seed: '7', districts: ['b', 'b_street'].map(V), ops: [g('b', 1), g('b_street', 1), g('b', 1, 'frontage'), g('b_street', 1, 'frontage')] },
  ];
}

const RECIPES = {
  flat160: { W: 160, D: 160 },
  flat224: { W: 224, D: 224 },
  shore: { W: 192, D: 320, water: [90, 100] },
  ridge: { W: 192, D: 320, ridge: 96 },
  biome: { W: 192, D: 320, biome: 96 },
};
/**
 * A case's survey columns and claim. flat: ground 64 (floor 62); shore: water x in [90, 100); ridge: a crest at x 96 (ground 64 + 24 - |x - 96|,
 * at least 64); biome: flat, the biome grid desert west of x 96 and jungle east. A beside case: flat over its claim `claimB`.
 */
export function surveyOf(K, c) {
  if (c.claimB) {
    const [x0, z0, x1, z1] = c.claimB, W = x1 - x0 + 1, D = z1 - z0 + 1;
    const cols = K.pack.makeColumns(x0, z0, W, D, 1);
    cols.ground.fill(64); cols.height.fill(64); cols.floor.fill(62); cols.flags.fill(0);
    return { cols, claim: { minX: x0, minZ: z0, maxX: x1, maxZ: z1, minY: -64, maxY: 319 } };
  }
  const R = RECIPES[c.recipe];
  const cols = K.pack.makeColumns(0, 0, R.W, R.D, 1);
  for (let z = 0; z < R.D; z++) for (let x = 0; x < R.W; x++) {
    const i = x + z * R.W, w = R.water && x >= R.water[0] && x < R.water[1];
    const h = R.ridge ? 64 + Math.max(0, 24 - Math.abs(x - R.ridge)) : 64;
    cols.ground[i] = h; cols.height[i] = h; cols.floor[i] = w ? 61 : (R.water || R.ridge ? h : 62); cols.flags[i] = w ? 1 : 0;
  }
  const out = { cols, claim: { minX: 0, minZ: 0, maxX: R.W - 1, maxZ: R.D - 1, minY: -64, maxY: 319 } };
  if (R.biome) {
    const w = R.W / 4, d = R.D / 4;
    out.biomes = { minX: 0, minZ: 0, res: 4, width: w, depth: d, palette: ['minecraft:desert', 'minecraft:jungle'], ids: Array.from({ length: w * d }, (_, i) => ((i % w) * 4 < R.biome ? 0 : 1)) };
  }
  return out;
}

/** A kit's modules from its root (land, grow and survey as present: a release before 6d has no revise). */
export async function kitAt(root) {
  const m = (p) => import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', p)).href);
  const [plan, pack, revise, grow, land, survey] = await Promise.all(['plan.mjs', 'pack.mjs', 'revise.mjs', 'grow.mjs', 'land.mjs', 'survey.mjs'].map(m));
  const t = (p) => import(pathToFileURL(path.join(root, 'kit', 'test', p)).href);
  return { root, plan, pack, revise, grow, land, survey, growSrc: fs.readFileSync(path.join(root, 'kit', 'lib', 'region', 'grow.mjs'), 'utf8'), test: t };
}

/** The kit's free-end reader for district `d` (as RTE4's worker): its export (RTE4 on), else extendBoundary's inline block. */
function freeEndsOf(K) {
  if (typeof K.grow.streetRouteEnds === 'function') return (eff, d) => K.grow.streetRouteEnds(eff, d);
  const s = K.growSrc, a = s.indexOf('    const endRe ='), b = s.indexOf("    if (!free.length) return why('boundary');");
  if (a < 0 || b < a) throw new Error(`${K.root}: no free-end block in grow.mjs`);
  const adjacency = (graph) => {
    const adj = new Map();
    const add = (n, e, o) => { if (!adj.has(n)) adj.set(n, []); adj.get(n).push({ edge: e, other: o }); };
    for (const e of graph?.edges ?? []) { const x = String(e.from).split('.')[0], y = String(e.to).split('.')[0]; add(x, e, y); add(y, e, x); }
    return adj;
  };
  // eslint-disable-next-line no-new-func
  const f = new Function('eff', 'district', 'adjacency', `${s.slice(a, b)}\nreturn { ends: routeEnds, free };`);
  return (eff, d) => f(eff, d, adjacency);
}

/** A case's districts: [[district, zone | null]] (a plan_v0 IR's from its zones). */
function districtsOf(eff) {
  const spec = eff.params?.spec?.districts ?? eff.params?.districts;
  if (Array.isArray(spec)) return spec.map((d) => [d?.id, null]).filter(([d]) => typeof d === 'string');
  return (eff.params?.plan?.zones ?? []).flatMap((z) => (Array.isArray(z?.program?.districts) ? z.program.districts.map((d) => [d?.id, z.id]) : [])).filter(([d]) => typeof d === 'string');
}
const runsRec = (r) => (r ? [r.cells, JSON.stringify(r.runs), r.rect] : null);

/**
 * The readers' outputs over one effective IR (RTE4's, with land by exact runs): per district its route ends and free ends and a growth's
 * plan; streetRuns (with each run's zone flag); architect_mc:land (each part's runs; union, outside and inside), the town's claim given.
 */
export function readers(K, eff, c, revised) {
  const S = surveyOf(K, c);
  const ds = districtsOf(eff);
  const fe = freeEndsOf(K);
  const out = { districts: ds, ends: {}, grow: {} };
  for (const [d] of ds) { const r = fe(eff, d); out.ends[d] = { ends: r.ends.map((n) => n.id), free: r.free.map((n) => n.id) }; }
  out.streetRuns = K.grow.streetRuns(eff).map((r) => [r.road, r.seg, r.district, r.follow, r.ext?.['architect_mc:street']?.zone ?? null]);
  const land = K.land.districtLand(eff, c.standingClaim ?? null, { revised });
  out.land = land ? { v: land.v, union: runsRec(land.union), outside: runsRec(land.outside), inside: runsRec(land.inside), parts: land.parts.map((p) => [p.kind, p.id, p.cells, p.district ?? null, p.revision ?? null, p.rect, JSON.stringify(p.runs)]) } : null;
  const standing = K.revise.revisionStanding({ id: 'rc', claim: [S.claim.minX, S.claim.minZ, S.claim.maxX, S.claim.maxZ], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const rid = Math.max(0, ...(eff.revisions ?? []).map((r) => r.rid)) + 1;
  for (const [d, zone] of ds) {
    try {
      const p = K.grow.growPlan({ eff, standing, survey: K.survey.surveyApi(S.cols, S.claim), grow: { district: d, lots: 2, prefer: 'extend', ...(zone ? { zone } : {}) }, rid });
      const x = p.extension;
      out.grow[d] = { extension: x ? [x.kind, x.from, x.road, x.newRoad] : null, lots: p.lots.map((l) => [l.spec.id, l.slot.kind, l.slot.street ?? null, l.slot.u ?? null]) };
    } catch (e) { out.grow[d] = { error: String(e.message).split(':').slice(0, 2).join(':') }; }
  }
  return out;
}

/** A case's effective IR of round `k` (its revisions by rid, merged by position). */
export function effectiveOf(K, c, k) {
  const byRid = new Map(c.revisions.map((r) => [r.rid, r]));
  return K.revise.mergeEffective(c.ir, c.rounds[k].revs.map((rid) => { const r = byRid.get(rid); return { rid: r.rid, position: r.position, ir: r.ir }; }));
}

async function planBase(K, c) {
  const S = surveyOf(K, c);
  if (c.family === 'plan_v0') {
    const params = { plan: { schemaVersion: 'plan/0', planId: c.id.slice(0, 40), zones: c.zones }, anchors: { anchors: {} }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
    return (await K.plan.planRegion({ programFile: path.join(K.root, 'kit', 'regions', 'plan_v0.mjs'), params, survey: K.pack.encodeColumns(S.cols), claim: S.claim, roles: {}, seed: c.seed })).ir;
  }
  if (c.family === 'beside') {
    const H = await K.test('d3-helpers.mjs');
    const town = await H.d3Town();
    const R = c.join === 'reach' ? H.reachInputs({ ir: town.p.ir, world: town.world, claim: town.claim }) : null;
    return (await H.planBeside({ town, districts: c.districts, claimB: c.claimB, seed: c.seed, ...(R ? { besideReach: R.besideReach } : {}) })).ir;
  }
  if (c.family === 'gate') {
    const H = await K.test('gj-helpers.mjs');
    const W = await H.walledTown();
    return (await H.planBesideWalled({ W, districts: c.districts, claimB: c.claimB, seed: c.seed })).ir;
  }
  return (await K.plan.planRegion({ programFile: path.join(K.root, 'kit', 'regions', 'districts.mjs'), params: { spec: { districts: c.districts }, lamps: false }, survey: S.cols, claim: S.claim, seed: c.seed, ...(S.biomes ? { biomes: S.biomes } : {}) })).ir;
}

/** Plan a case (unless it has its IR) and run its ops `from..to` with this kit, recording each outcome. */
export async function runCase(K, c, by, from = 0, to = c.ops.length) {
  if (!c.ir) { c.ir = await planBase(K, c); c.revisions = []; c.rounds = [{ revs: [], revised: false }]; c.log = []; c.by = by; }
  const S = surveyOf(K, c);
  for (const op of c.ops.slice(from, to)) {
    const cur = c.rounds[c.rounds.length - 1];
    if (op[0] === 'undo') {
      const keep = cur.revs.filter((rid) => c.revisions.find((r) => r.rid === rid).position <= op[1]);
      c.rounds.push({ revs: keep, revised: true });
      c.log.push([...op, 'ok', by]);
      continue;
    }
    const [, d, lots, prefer, zone] = op;
    const rid = Math.max(0, ...c.revisions.map((r) => r.rid)) + 1, position = cur.revs.length + 1;
    const eff = effectiveOf(K, c, c.rounds.length - 1);
    const parent = cur.revs.length ? cur.revs[cur.revs.length - 1] : 0;
    const standing = K.revise.revisionStanding({ id: 'rc', claim: [S.claim.minX, S.claim.minZ, S.claim.maxX, S.claim.maxZ], effective: eff, held: { runs: [], town: [], terrain: [] } });
    try {
      const r = await K.revise.reviseIR(eff, { grow: { district: d, lots, prefer, ...(zone ? { zone } : {}) } }, { rid, position, parent: { rid: parent, irSha: null }, base: { irSha: null }, survey: S.cols, standing });
      c.revisions.push({ rid, position, by, ir: r.ir });
      c.rounds.push({ revs: [...cur.revs, rid], revised: true });
      c.log.push([...op, 'ok', by, r.ir.revision?.grow?.extension?.kind ?? null]);
    } catch (e) { c.log.push([...op, String(e.message).split(':').slice(0, 2).join(':'), by]); }
  }
  return c;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, a, b, by = path.basename(path.resolve(root))] = process.argv.slice(2);
  const K = await kitAt(path.resolve(root));
  const all = JSON.parse(fs.readFileSync(a, 'utf8'));
  if (mode === 'plan') {
    const out = [];
    for (const c of all) {
      try { out.push(await runCase(K, c, by, c.from ?? 0, c.to ?? c.ops.length)); } catch (e) { out.push({ ...c, error: String(e.message).split('\n')[0].slice(0, 160) }); }
    }
    fs.writeFileSync(b, JSON.stringify(out));
  } else if (mode === 'read') {
    const reads = all.map((c) => c.rounds.map((rd, k) => { try { return readers(K, effectiveOf(K, c, k), c, rd.revised); } catch (e) { return { error: String(e.message).slice(0, 160) }; } }));
    fs.writeFileSync(b, JSON.stringify(reads));
  } else throw new Error('usage: plan|read <root> <in> <out> [by]');
}
