#!/usr/bin/env node
// (RTE4) The compatibility corpus's worker (kit/tools/rte-compat-fixture.mjs runs it once per released kit, in that release's tree):
//   node kit/tools/rte-compat-worker.mjs plan <kit root> <out.json>         plan and grow the corpus's cases with that root's kit
//   node kit/tools/rte-compat-worker.mjs read <kit root> <in.json> <out.json> that root's readers over every case's rounds
// It imports nothing from this tree but its own file: every kit module comes from <kit root>, so a release's IRs and readings are its own.
// `readers` is also what kit/test/rte-compat.test.mjs runs with this tree's kit.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** The corpus's cases: [{id, recipe, seed, districts, grows: [[district, lots, prefer]...]}]. */
export function cases() {
  const V = (id) => ({ id, size: [40, 40], lots: 1, shared: 'square' });
  const F = (id) => ({ id, size: [48, 24], follow: { shore: {} }, lots: 2 });
  const out = [];
  const flat = [['b', 'b_1'], ['b', 'b_1', 'b_1_g1'], ['b', 'b_street'], ['b_street'], ['b_street', 'c'], ['quay', 'quayside', 'quay_1'], ['x', 'x_g1'], ['b_g2']];
  for (const ids of flat) for (const seed of ['7', '3']) out.push({ id: `flat_${ids.join('-')}_${seed}`, recipe: ids.length > 2 ? 'flat224' : 'flat160', seed, districts: ids.map(V), grows: ids.map((d) => [d, 1, 'frontage']).slice(0, 3) });
  const shore = [['b', 'b_1'], ['b_1_g1', 'b'], ['b', 'b_1', 'b_1_g1'], ['quay', 'quayside'], ['quay', 'quay_1'], ['quay_g1'], ['b_street'], ['b', 'b_street']];
  for (const ids of shore) for (const seed of ['1', '2']) {
    // (rounds: the last district grows along its boundary, then the first, then the last again from its new end)
    const a = ids[0], z = ids[ids.length - 1];
    out.push({ id: `shore_${ids.join('-')}_${seed}`, recipe: 'shore', seed, districts: ids.map(F), grows: [[z, 2, 'extend'], [a, 2, 'extend'], [z, 2, 'extend']] });
  }
  out.push({ id: 'mixed_b-b_1_1', recipe: 'shore', seed: '1', districts: [F('b'), V('b_1')], grows: [['b', 2, 'extend'], ['b_1', 1, 'frontage']] });
  return out;
}

const RECIPES = {
  flat160: { W: 160, D: 160, water: null },
  flat224: { W: 224, D: 224, water: null },
  shore: { W: 192, D: 320, water: [90, 100] },
};
/** The case's survey columns and claim (flat ground 64, floor 62; `shore`: water x in [90, 100)). */
export function surveyOf(K, recipe) {
  const R = RECIPES[recipe];
  const c = K.pack.makeColumns(0, 0, R.W, R.D, 1);
  for (let z = 0; z < R.D; z++) for (let x = 0; x < R.W; x++) {
    const i = x + z * R.W, w = R.water && x >= R.water[0] && x < R.water[1];
    c.ground[i] = 64; c.height[i] = 64; c.floor[i] = w ? 61 : (R.water ? 64 : 62); c.flags[i] = w ? 1 : 0;
  }
  return { cols: c, claim: { minX: 0, minZ: 0, maxX: R.W - 1, maxZ: R.D - 1, minY: -64, maxY: 319 } };
}

/** A kit's modules from its root. */
export async function kitAt(root) {
  const m = (p) => import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', p)).href);
  const [plan, pack, revise, grow, land, survey] = await Promise.all(['plan.mjs', 'pack.mjs', 'revise.mjs', 'grow.mjs', 'land.mjs', 'survey.mjs'].map(m));
  return { root, plan, pack, revise, grow, land, survey, growSrc: fs.readFileSync(path.join(root, 'kit', 'lib', 'region', 'grow.mjs'), 'utf8') };
}

/** The kit's free-end reader for district `d`: its export (RTE4 on), else the inline block of extendBoundary, cut from its source. */
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

/** The readers' outputs over one effective IR: per district its route ends and free ends and a growth's plan; streetRuns; land. */
export function readers(K, eff, { cols, claim }) {
  const ids = (eff.params?.spec?.districts ?? eff.params?.districts ?? []).map((d) => d?.id).filter((d) => typeof d === 'string');
  const fe = freeEndsOf(K);
  const out = { districts: ids, ends: {}, grow: {} };
  for (const d of ids) { const r = fe(eff, d); out.ends[d] = { ends: r.ends.map((n) => n.id), free: r.free.map((n) => n.id) }; }
  out.streetRuns = K.grow.streetRuns(eff).map((r) => [r.road, r.seg, r.district, r.follow]);
  const revised = Array.isArray(eff.revisions) && eff.revisions.length > 0;
  const land = K.land.districtLand(eff, null, { revised });
  out.land = land ? land.parts.map((p) => [p.kind, p.id, p.cells, p.district ?? null, p.revision ?? null, p.rect]) : null;
  const standing = K.revise.revisionStanding({ id: 'rc', claim: [claim.minX, claim.minZ, claim.maxX, claim.maxZ], effective: eff, held: { runs: [], town: [], terrain: [] } });
  const rid = (eff.head ?? 0) + 1;
  for (const d of ids) {
    try {
      const p = K.grow.growPlan({ eff, standing, survey: K.survey.surveyApi(cols, claim), grow: { district: d, lots: 2, prefer: 'extend' }, rid });
      const x = p.extension;
      out.grow[d] = { extension: x ? [x.kind, x.from, x.road, x.newRoad] : null, lots: p.lots.map((l) => [l.spec.id, l.slot.kind, l.slot.street ?? null, l.slot.u ?? null]) };
    } catch (e) { out.grow[d] = { error: String(e.message).split(':').slice(0, 2).join(':') }; }
  }
  return out;
}

/** The case's effective IRs: round 0 (the plan) then after each revision. */
export function rounds(K, c) {
  const effs = [K.revise.mergeEffective(c.ir)];
  for (let k = 1; k <= c.revisions.length; k++) effs.push(K.revise.mergeEffective(c.ir, c.revisions.slice(0, k).map((ir, i) => ({ rid: i + 1, position: i + 1, ir }))));
  return effs;
}

async function plan(K) {
  const out = [];
  for (const cs of cases()) {
    const S = surveyOf(K, cs.recipe);
    let q;
    try {
      q = await K.plan.planRegion({ programFile: path.join(K.root, 'kit', 'regions', 'districts.mjs'), params: { spec: { districts: cs.districts }, lamps: false }, survey: S.cols, claim: S.claim, seed: cs.seed });
    } catch (e) { out.push({ ...cs, error: String(e.message).slice(0, 120) }); continue; }
    const revisions = [], log = [];
    for (const [d, lots, prefer] of cs.grows) {
      const k = revisions.length;
      const eff = K.revise.mergeEffective(q.ir, revisions.map((ir, i) => ({ rid: i + 1, position: i + 1, ir })));
      const standing = K.revise.revisionStanding({ id: 'rc', claim: [S.claim.minX, S.claim.minZ, S.claim.maxX, S.claim.maxZ], effective: eff, held: { runs: [], town: [], terrain: [] } });
      try {
        const r = await K.revise.reviseIR(eff, { grow: { district: d, lots, prefer } }, { rid: k + 1, position: k + 1, parent: { rid: k, irSha: null }, base: { irSha: q.irSha }, survey: S.cols, standing });
        revisions.push(r.ir);
        log.push([d, 'ok', r.ir.revision?.grow?.extension?.kind ?? null]);
      } catch (e) { log.push([d, String(e.message).split(':').slice(0, 2).join(':')]); }
    }
    out.push({ ...cs, ir: q.ir, revisions, log });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, a, b] = process.argv.slice(2);
  const K = await kitAt(path.resolve(root));
  if (mode === 'plan') fs.writeFileSync(a, JSON.stringify(await plan(K)));
  else if (mode === 'read') {
    const all = JSON.parse(fs.readFileSync(a, 'utf8'));
    const reads = all.map((c) => (c.error ? null : rounds(K, c).map((eff) => readers(K, eff, surveyOf(K, c.recipe)))));
    fs.writeFileSync(b, JSON.stringify(reads));
  } else throw new Error('usage: plan <root> <out> | read <root> <in> <out>');
}
