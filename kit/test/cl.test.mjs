// (7a CL) Climbs: stairs, switchbacks and ladders (docs/CONTRACT.md "Phase 7a slice CL" §10 item 1, items 7, 12, 13 offline): the
// profiles change only their edges; the climbed post-check (NO_CLIMB with its path, the climb deviation); the fittings (rails beside
// drops, rest landings at every `rest`, the top gate, lamps); the face rule; every refusal fixture's code with evidence and its wouldFit
// re-checked alone; the valid fixtures READY with the checker's climb rules clean (M10:climb, M8:climb, M5:climb) and both kit movers;
// climbs_demo flat and natural; the broken variants caught; the catalogue's three flips; determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, checkPlanLocal, flatSurvey, goldenSurvey, stewardAnchors } from './plan-helpers.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { planRegion } from '../lib/region/plan.mjs';
import { routePass, COST } from '../lib/region/passes/route.mjs';
import { PROFILES } from '../lib/region/passes/moves/profiles.mjs';
import { ladderPlan, CLIMB, joins, splitState } from '../lib/connectors/climbGeom.mjs';
import { BLOCKS, isCube } from '../lib/blocks.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { makeColumns } from '../lib/region/pack.mjs';
import { encodeArvx, decodeArvx, VC } from '../lib/region/volume.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';

const read = (dir, re = /./) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && re.test(f)).sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const surveyOf = (fx) => (fx.on === 's3' ? goldenSurvey('s3') : flatSurvey(fx.terrain ?? {}));

/** A fixture's frozen volume (plan-t3a's form): soil to 3 under the ground, rock below, air above, LOOSE in `loose`. */
function volumeOf(spec, survey, claim) {
  const [x0, y0, z0, x1, y1, z1] = spec.box;
  const box = { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 };
  const W = x1 - x0 + 1, H = y1 - y0 + 1, D = z1 - z0 + 1;
  const S = surveyApi(survey, claim);
  const classes = new Uint8Array(W * H * D);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const g = S.groundAt(x, z);
    for (let y = y0; y <= y1; y++) {
      const L = spec.loose;
      const loose = L && x >= L[0] && x <= L[2] && z >= L[1] && z <= L[3] && y >= L[4] && y <= L[5] && y <= g;
      classes[((x - x0) * D + (z - z0)) * H + (y - y0)] = y > g ? VC.AIR : loose ? VC.LOOSE : y >= g - 3 ? VC.SOIL : VC.ROCK;
    }
  }
  const bytes = encodeArvx(box, classes);
  const decoded = decodeArvx(bytes);
  return { box, bytes, sha: decoded.sha, decoded };
}

async function run(fx, extra = {}) {
  const s = surveyOf(fx);
  const volumes = fx.volume ? [volumeOf(fx.volume, s.bytes, s.claim)] : [];
  const r = await checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], volumes, ...extra });
  return { ...r, survey: s, volumes };
}
const checkOf = (r) => checkRegion({ ir: r.res.ir, survey: r.survey.bytes, blobs: r.res.blobs, meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded) });

test('§2: the profiles change only their edges; each kind climbs its own way', () => {
  assert.deepEqual({ ...PROFILES.stair.cost }, { flight: 20, stair: 12, grade: 18 });
  assert.deepEqual([PROFILES.stair.stairs, PROFILES.stair.ladders, PROFILES.switchback.stairs, PROFILES.switchback.ladders, PROFILES.ladder.stairs, PROFILES.ladder.ladders, PROFILES.ladder.ladderMax], [true, false, false, false, true, true, 48]);
  for (const n of Object.keys(PROFILES)) for (const k of Object.keys(PROFILES[n].cost)) assert.ok(k in COST, `${n}.${k}`);
  // a slope rising 1 in 2 and a 30-high cliff: two edges routed together; a profile on one leaves the other's route as T2's
  const W = 96, D = 64, s = makeColumns(0, 0, W, D, 1);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) { const k = x + z * W, g = z < 32 ? 64 + (x >= 60 ? 30 : 0) : 64 + Math.max(0, Math.min(40, (x - 10) >> 1)); s.ground[k] = g; s.height[k] = g; s.floor[k] = g; }
  const plain = [{ id: 'cliff', from: { at: [50, 65, 12] }, to: { at: [70, 95, 12] }, width: 1, movers: ['player'], ladders: true }, { id: 'slope', from: { at: [4, 65, 48] }, to: { at: [80, 100, 48] }, width: 2 }];
  const base = routePass(s, [], { edges: plain }).data.edges;
  const withP = routePass(s, [], { edges: [plain[0], { ...plain[1], profile: 'switchback' }] }).data.edges;
  assert.equal(JSON.stringify(withP[0]), JSON.stringify(base[0]), 'the cliff edge (no profile) routes as T2');
  assert.ok(withP[1].ok && withP[1].segments.every((g) => g.kind !== 'stair') && withP[1].segments.some((g) => g.kind === 'landing'), 'a switchback: hairpins, no flight');
  const st = routePass(s, [], { edges: [{ ...plain[1], profile: 'stair' }] }).data.edges[0];
  assert.ok(st.ok && st.segments.some((g) => g.kind === 'stair'), 'a stair: flights');
  // the ladder profile climbs a face T2's limit (24) can't: 30
  assert.ok(routePass(s, [], { edges: [{ ...plain[0], ladders: true, movers: ['player'] }] }).data.edges[0].ladderCols.every((l) => l.y1 - l.y0 + 1 <= 24), 'T2 alone: no ladder over 24');
  const ld = routePass(s, [], { edges: [{ ...plain[0], profile: 'ladder' }] }).data.edges[0];
  assert.ok(ld.ok && ld.ladderCols.length === 1 && ld.ladderCols[0].y1 - ld.ladderCols[0].y0 + 1 === 30, JSON.stringify(ld.ladderCols));
  // a stair never ladders (its profile's ladders off), a villager edge never ladders whatever its profile
  assert.ok(routePass(s, [], { edges: [{ ...plain[0], profile: 'stair' }] }).data.edges[0].segments.every((g) => g.kind !== 'ladder'));
  assert.ok(routePass(s, [], { edges: [{ ...plain[0], movers: ['player', 'villager'], profile: 'ladder' }] }).data.edges[0].segments.every((g) => g.kind !== 'ladder'));
});

test('§3: rest landings at every `rest` rungs, flights alternating so the last is in the ladder\'s own column', () => {
  for (const rest of [8, 12, 24]) for (const rungs of [8, 9, 24, 25, 30, 48]) {
    const lc = { x: 0, z: 0, y0: 65, y1: 64 + rungs, facing: 'west' };
    const p = ladderPlan(lc, rest, 1);
    assert.equal(p.landings.length, Math.floor((rungs - 1) / rest), `rest ${rest} rungs ${rungs}`);
    assert.ok(p.flights.every((f) => f.y1 - f.y0 + 1 <= rest));
    assert.deepEqual([p.flights.at(-1).x, p.flights.at(-1).z], [0, 0], 'the last flight in A');
    assert.equal(p.flights.reduce((n, f) => n + f.y1 - f.y0 + 1, 0), rungs);
    for (let k = 1; k < p.flights.length; k++) assert.notDeepEqual([p.flights[k].x, p.flights[k].z], [p.flights[k - 1].x, p.flights[k - 1].z], 'alternating');
    // each landing's deck at the previous flight's top rung, in the next flight's column
    p.landings.forEach((l, k) => { assert.equal(l.y, p.flights[k].y1 + 1); assert.deepEqual(l.deck[0], [p.flights[k + 1].x, p.flights[k + 1].z]); });
  }
});

test('valid/v7a_cl_*: READY; the climb rules clean on the virtual world (M10:climb, M8:climb, M5:climb), both kit movers across, the graph edge typed with its crossing', async () => {
  for (const f of read('valid', /^v7a_cl_/)) {
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons, a.deviations]))}`);
    const rep = checkOf(r);
    const bad = rep.findings.filter((x) => /^(M10:climb|M8:climb|M5:climb|M1|M3)$/.test(x.rule) || x.severity === 'error');
    assert.deepEqual(bad.map((x) => [x.rule, x.message]), [], f.name);
    for (const e of rep.metrics.route.edges) {
      assert.ok(e.player, `${f.name} ${e.id}: the player mover across`);
      if (e.villager !== null) assert.ok(e.villager, `${f.name} ${e.id}: the villager mover across`);
    }
    for (const a of r.check.parts) {
      const kind = f.plan.connectors.find((c) => c.id === a.part).kind;
      const c = a.geometry.climbs[0];
      if (kind === 'stair') assert.ok(c.flights > 0, `${f.name}: flights`);
      if (kind === 'switchback') assert.ok(c.hairpins > 0 && c.flights === 0, `${f.name}: hairpins, no flight`);
      if (kind === 'ladder') { assert.equal(c.ladders.length, 1); assert.ok(c.ladders[0].top, 'a top gate'); }
      assert.ok(Object.keys(a.cost.bom).length, `${f.name}: cost.bom`);
      const ge = r.res.ir.graph.edges.find((e) => e.type === kind);
      assert.ok(ge?.crossing?.type === kind, `${f.name}: the graph edge type ${kind} with its crossing`);
    }
    for (const row of rep.metrics.climbs.per) {
      assert.equal(row.flightBad + row.treadBad + row.notLadder + row.faceBad + row.longFlights + row.landingBad, 0, `${f.name} ${row.id}`);
      assert.equal(row.m8Open, 0, `${f.name} ${row.id}: M8 0 on stairs and landings`);
      assert.equal(row.dark, 0, `${f.name} ${row.id}: M5 0`);
      if (row.kind === 'ladder') assert.equal(row.gate, true);
    }
  }
  // v7a_cl_ladder: the 30-high face one rest landing, the 16-high none
  const lr = await run(read('valid', /^v7a_cl_ladder/)[0]);
  assert.deepEqual(['high_ladder', 'low_ladder'].map((id) => part(lr, id).geometry.climbs[0].ladders.map((l) => [l.rungs, l.landings])), [[[30, 1]], [[16, 0]]]);
});

test('the refusal fixtures: each code with its evidence; NO_CLIMB and MOVER wouldFits re-checked alone fit; the walked stair adjusted with the climb deviation', async () => {
  const fx = read('cl', /^[ra]\d/);
  assert.ok(fx.length >= 6);
  for (const f of fx) {
    const r = await run(f);
    const a = part(r, f.expect.part);
    if (f.expect.class) { assert.equal(a.class, f.expect.class, `${f.name}: ${JSON.stringify(a)}`); continue; }
    assert.equal(a.class, 'refused', `${f.name}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    assert.ok(a.reasons[0].evidence && Object.keys(a.reasons[0].evidence).length, `${f.name}: evidence`);
    if (f.expect.wouldFit) {
      assert.equal(a.wouldFit?.[0]?.fragment?.kind, f.expect.wouldFit, `${f.name}: ${JSON.stringify(a.wouldFit)}`);
      const alone = await run({ ...f, plan: { ...f.plan, connectors: [a.wouldFit[0].fragment] } });
      const b = part(alone, f.expect.part);
      assert.ok(['fits', 'adjusted'].includes(b.class) && !(b.deviations ?? []).some((d) => d.what === 'climb'), `${f.name}: the wouldFit alone: ${JSON.stringify(b)}`);
    }
  }
  const nc = part(await run(read('cl', /^r01/)[0]), 'flat_stair');
  assert.deepEqual(nc.reasons[0].evidence, { ascent: 0, need: 2 });
  const an = part(await run(read('cl', /^r03/)[0]), 'sand_ladder');
  assert.ok(an.reasons[0].evidence.cells.length > 0 && an.reasons[0].evidence.classes.every((c) => c === 'LOOSE'), JSON.stringify(an.reasons[0].evidence));
  const sp = part(await run(read('cl', /^r04/)[0]), 'tall_ladder');
  assert.deepEqual([sp.reasons[0].evidence.rise, sp.reasons[0].evidence.max], [49, 48]);
  const wk = part(await run(read('cl', /^a01/)[0]), 'walked');
  assert.deepEqual(wk.deviations, [{ what: 'climb', value: 3, kind: 'walk', rise: 3 }]);
  assert.ok(wk.notes.includes('the land\'s grade needed no stair: the route walks its rise of 3 within the grade'));
  for (const k of ['handrail', 'material', 'steps']) assert.ok(wk.notes.some((n) => n.startsWith(`params.${k} not read`)), k);
});

test('the broken variants: a stair without its rails (M8:climb), a ladder without its gate (M10:climb)', async () => {
  const v = read('valid', /^v7a_cl_stair/)[0];
  const r = await run({ ...v, plan: { ...v.plan, connectors: [{ ...v.plan.connectors[0], ext: { 'architect_mc:unsafe': { noRails: true } } }] } });
  const rep = checkOf(r);
  // (the stair on S3's claim: a fill side over a drop somewhere along it, or the variant shows nothing: the case below is synthetic)
  const steep = { terrain: { W: 160, D: 96, bands: Array.from({ length: 24 }, (_, i) => ({ x0: 1040 + i, z0: 2048, x1: 1159, z1: 2049, y: 65 + i })) }, anchors: { a: [1030, 65, 2048], b: [1090, 89, 2048] } };
  const st = await run({ ...steep, plan: { schemaVersion: 'plan/0', connectors: [{ id: 'ridge_stair', kind: 'stair', from: { anchor: 'a' }, to: { anchor: 'b' } }] } });
  const ok = checkOf(st);
  assert.equal(ok.metrics.climbs.per[0].m8Open, 0, 'railed: M8 0');
  assert.ok(ok.metrics.climbs.per[0].m8Edges > 0, `the ridge's stair has edges over a drop: ${JSON.stringify(ok.metrics.climbs.per[0])}`);
  const br = await run({ ...steep, plan: { schemaVersion: 'plan/0', connectors: [{ id: 'ridge_stair', kind: 'stair', from: { anchor: 'a' }, to: { anchor: 'b' }, ext: { 'architect_mc:unsafe': { noRails: true } } }] } });
  assert.ok(checkOf(br).findings.some((x) => x.rule === 'M8:climb'), 'no rails: M8:climb');
  void rep;
  const l = read('valid', /^v7a_cl_ladder/)[0];
  const ng = await run({ ...l, plan: { ...l.plan, connectors: [{ ...l.plan.connectors[1], ext: { 'architect_mc:unsafe': { noGate: true } } }] } });
  assert.ok(checkOf(ng).findings.some((x) => x.rule === 'M10:climb' && /top gate missing/.test(x.message)), 'no gate: M10:climb');
});

test('climbs_demo flat: the stair, the switchback and the 36-high ladder with its landing; the bed on the mesa unreached by the villager mover, the stair\'s bed reached; natural: S3\'s stair and switchback', async () => {
  const s = flatSurvey({ W: 240, D: 176 });
  const p = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'climbs_demo.mjs'), survey: s.bytes, claim: s.claim, seed: '1', params: { variant: 'flat' } });
  const rep = checkRegion({ ir: p.ir, survey: s.bytes, blobs: p.blobs, meta: p.meta });
  const routed = (m) => m.route.edges.filter((e) => e.ok).map((e) => e.id);
  assert.deepEqual(routed(p.meta), ['stair', 'switch', 'ladder']);
  const per = Object.fromEntries(rep.metrics.climbs.per.map((x) => [x.part, x]));
  assert.ok(per.stair.flights > 0 && per.ladder.rungs === 36, JSON.stringify(per));
  assert.equal(rep.metrics.climbs.bad, 0, JSON.stringify(rep.metrics.climbs.per));
  assert.equal(rep.metrics.climbs.m8Open + rep.metrics.climbs.dark, 0);
  assert.equal(p.meta.climbs.find((c) => c.edge === 'ladder').ladders[0].landings, 1, '36 rungs: one rest landing');
  for (const e of rep.metrics.route.edges) assert.ok(e.player && e.villager !== false, JSON.stringify(e));
  // the behavioural test, by the kit's movers: the mesa's bed only by the ladder (the villager mover never reaches it; the player does)
  const { vw } = buildVirtual({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs?.get?.(sha) ?? null });
  const foot = p.ir.anchors.foot_ladder, bedL = p.ir.anchors.bed_ladder, bedS = p.ir.anchors.bed_stair;
  const near = (b) => [b[0] + 1, b[1], b[2]];
  assert.equal(nodeReached(walkGraph(vw, [foot], { mover: 'villager' }), near(bedL)), false, 'villager: the mesa unreached');
  assert.equal(nodeReached(walkGraph(vw, [foot], { mover: 'player' }), near(bedL)), true, 'player: up the ladder');
  assert.equal(nodeReached(walkGraph(vw, [p.ir.anchors.foot_stair], { mover: 'villager' }), near(bedS)), true, 'villager: the stair\'s bed');
  assert.equal(nodeReached(walkGraph(vw, [near(bedS)], { mover: 'villager' }), p.ir.anchors.foot_stair), true, 'villager: back down');
  // natural
  const n = goldenSurvey('s3');
  const q = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'climbs_demo.mjs'), survey: n.bytes, claim: n.claim, seed: '1', params: { variant: 'natural' } });
  const nrep = checkRegion({ ir: q.ir, survey: n.bytes, blobs: q.blobs, meta: q.meta });
  assert.deepEqual(routed(q.meta), ['stair', 'switch']);
  assert.equal(nrep.metrics.climbs.bad + nrep.metrics.climbs.m8Open + nrep.metrics.climbs.dark, 0, JSON.stringify(nrep.metrics.climbs.per));
  for (const e of nrep.metrics.route.edges) assert.ok(e.player && e.villager, JSON.stringify(e));
});

test('§10 item 12: the catalogue: the three flips against the foundation\'s archive, nothing else of CL\'s', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const pre = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7a.json'), 'utf8'));
  const d = diffCatalogues(pre, golden);
  // (the foundation's entries are f7a-foundation.test.mjs's, the other 7a slices' flips (CW's catwalk, ...) theirs)
  const F = ['connector.span_bridge', 'connector.rail', 'connector.branch_walk', ...['rock_stair', 'lift', 'catwalk', 'stairs_around'].map((k) => `connector.${k}`)];
  const cl = (xs) => xs.filter((x) => !F.includes(x.id ?? x));
  assert.deepEqual(cl(d.reservedToSupported), ['connector.ladder', 'connector.stair', 'connector.switchback']);
  assert.deepEqual(cl(d.schemaVersionBumps).map((x) => x.id).sort(), ['connector.ladder', 'connector.stair', 'connector.switchback']);
  assert.deepEqual([cl(d.added), d.removed, d.retired, d.otherStateChanges, cl(d.untilChanged), cl(d.notesChanged), cl(d.limitsChanged)], [[], [], [], [], [], [], []]);
  for (const id of ['connector.ladder', 'connector.stair', 'connector.switchback']) { const e = golden.entries.find((x) => x.id === id); assert.ok(e.sinceApi === 'NEXT' || e.sinceApi === golden.api); assert.equal(e.state, 'supported'); }
});

test('§10 item 13: determinism: three checks of each valid climb fixture identical (answers, IR, artifact sha)', async () => {
  for (const f of read('valid', /^v7a_cl_/)) {
    const shas = [];
    for (let i = 0; i < 3; i++) { const r = await run(f); shas.push(JSON.stringify([r.check.parts, r.res.irJson, r.artifactSha])); assert.match(r.artifactSha ?? '', /^[0-9a-f]{64}$/); }
    assert.ok(shas.every((x) => x === shas[0]), f.name);
  }
});

void CLIMB;

test('§9 (item 3): Steward\'s recorded climbs on the asks claim: the stairs refused NO_CLIMB with a path wouldFit that fits alone; cave_ladders blocked DEPENDENCY (its tower_1 unplaced in the zone); the committed gap tables', async () => {
  const { asksSurvey } = await import('./plan-helpers.mjs');
  const s = asksSurvey();
  const ask = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'asks', `${name}.json`), 'utf8')).answer.plan;
  const anchors = stewardAnchors(s.claim);
  for (const [name, id] of [['old_new_town', 'quarter_stair'], ['sky_monastery', 'long_stair']]) {
    const plan = ask(name);
    const r = await checkPlanLocal(plan, { survey: s.bytes, claim: s.claim, anchors });
    const a = part(r, id);
    assert.equal(a.class, 'refused', `${name}/${id}: ${JSON.stringify(a)}`);
    assert.equal(a.reasons[0].code, 'NO_CLIMB');
    assert.equal(a.wouldFit?.[0]?.fragment?.kind, 'path');
    const alone = await checkPlanLocal({ ...plan, connectors: plan.connectors.map((c) => (c.id === id ? a.wouldFit[0].fragment : c)) }, { survey: s.bytes, claim: s.claim, anchors });
    assert.equal(part(alone, id).class, 'fits', `${name}/${id}: the path alone: ${JSON.stringify(part(alone, id))}`);
  }
  const hv = part(await checkPlanLocal(ask('hidden_village'), { survey: s.bytes, claim: s.claim, anchors }), 'cave_ladders');
  assert.deepEqual([hv.class, hv.reasons[0].code, hv.reasons[0].evidence.lot], ['blocked', 'DEPENDENCY', 'tower_1']);
  const before = fs.readFileSync(path.join(FIX, 'cl', 'asks-gap-before.txt'), 'utf8'), after = fs.readFileSync(path.join(FIX, 'cl', 'asks-gap-after.txt'), 'utf8');
  assert.match(before, /connector\.stair +2\n/);
  assert.match(before, /connector\.ladder +1\n/);
  assert.doesNotMatch(after, /^  connector\.(stair|ladder|switchback) /m);
  const lines = (t) => t.split('\n').filter((l) => /^[a-z_]+\/[a-z_0-9]+ /.test(l));
  const moved = lines(after).filter((l, i) => l !== lines(before)[i]);
  assert.deepEqual(moved.map((l) => l.split(' ')[0]), ['hidden_village/cave_ladders', 'old_new_town/quarter_stair', 'sky_monastery/long_stair']);
  assert.equal(lines(after).filter((l) => / malformed/.test(l)).length, 0);
});

test('§5 (item 9, KC): a stair beside a fountain keeps clear: the stair fits, the fountain fits, 0 cells in its hard or watch sets (M25:clear 0)', async () => {
  const { checkPlanVolumes } = await import('./plan-helpers.mjs');
  const f = read('cl', /^k01_/)[0];
  const s = flatSurvey(f.terrain);
  const r = await checkPlanVolumes(f.plan, { volume: f.volume, survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...f.anchors } });
  assert.deepEqual(r.check.parts.map((a) => [a.part, a.class]).sort(), [['foot_stair', 'fits'], ['fount', 'fits']], JSON.stringify(r.check.parts.map((a) => [a.part, a.class, a.reasons])));
  const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v), meta: r.res.meta });
  assert.deepEqual(rep.findings.filter((x) => x.rule === 'M25:clear').map((x) => x.message), []);
  assert.equal(rep.metrics.climbs.per[0].bad ?? 0, 0);
  // k02: a ladder whose foot stands in the fountain's watched apron: OVERLAP {kind: body} before routing; nothing written; M25:clear 0
  const g = read('cl', /^k02_/)[0];
  const s2 = flatSurvey(g.terrain);
  const r2 = await checkPlanVolumes(g.plan, { volume: g.volume, survey: s2.bytes, claim: s2.claim, anchors: { ...stewardAnchors(s2.claim), ...g.anchors } });
  const lad = part(r2, 'top_ladder');
  assert.equal(lad.class, 'refused');
  assert.deepEqual([lad.reasons[0].code, lad.reasons[0].evidence.kind, lad.reasons[0].evidence.part], ['OVERLAP', 'body', 'fount']);
  assert.equal(part(r2, 'fount').class, 'fits');
  const rep2 = checkRegion({ ir: r2.res.ir, survey: s2.bytes, blobs: (sha) => r2.res.blobs.get(sha) ?? null, volumes: r2.volumes.map((v) => v.decoded ?? v), meta: r2.res.meta });
  assert.deepEqual(rep2.findings.filter((x) => x.rule === 'M25:clear').map((x) => x.message), []);
  assert.equal((r2.res.meta.climbs ?? []).length, 0, 'the refused ladder wrote nothing');
});

test('cost.bom: exactly the climb\'s own links part, by C26\'s rules (the cells re-counted from the virtual world)', async () => {
  const { bomOf } = await import('../lib/connectors/bom.mjs');
  for (const f of read('valid', /^v7a_cl_/)) {
    const r = await run(f);
    const { vw } = buildVirtual({ ir: r.res.ir, survey: r.survey.bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null });
    for (const a of r.check.parts) {
      const idx = f.plan.connectors.findIndex((c) => c.id === a.part);
      const pi = r.res.ir.parts.findIndex((q) => q.id === `links_c${idx}`);
      assert.ok(pi >= 0, `${f.name} ${a.part}: its links part`);
      const states = [];
      vw.eachWritten((x, y, z) => { if (vw.partAt(x, y, z) === pi) { const st = vw.pal.states[vw.get(x, y, z)]; if (!/^minecraft:air$/.test(st)) states.push(st); } });
      assert.deepEqual(a.cost.bom, Object.fromEntries(Object.entries(bomOf(states)).sort(([u], [v]) => (u < v ? -1 : 1))), `${f.name} ${a.part}`);
    }
  }
});

test('the coordinator\'s ruling (2026-10-23): a switchback\'s detour is judged against its grade-limited minimum length: v7a_cl_switch fits at the default detour.max; one forced round a strip wanders past it: adjusted', async () => {
  const v = read('valid', /^v7a_cl_switch/)[0];
  assert.equal(v.plan.connectors[0].tolerance, undefined, 'the default tolerance');
  const a = part(await run(v), 'slope_switch');
  assert.equal(a.class, 'fits', JSON.stringify(a.deviations));
  const leg = a.geometry.legs[0], straight = Math.abs(leg.from[0] - leg.to[0]) + Math.abs(leg.from[2] - leg.to[2]);
  assert.ok((leg.length - 1) / straight > 2, `it is longer than twice the straight line (${leg.length - 1} / ${straight}): only the grade-limited minimum lets it fit`);
  const w = part(await run(read('cl', /^a02_/)[0]), 'slope_switch');
  assert.equal(w.class, 'adjusted');
  assert.deepEqual(w.deviations.map((d) => [d.what, d.exceeds]), [['detour', true]]);
});

/**
 * (Noah's look, 2026-10-24) Over a plan's virtual world, every fence, wall or pane its climb parts wrote: its sides agree with its
 * neighbours (kit.mjs finalize's rule), and it stands on something (a cube, slab, stairs, fence or wall below) or hangs from the wall
 * or deck (a cube or slab over it, or a side joined to a cube). Returns the bad cells.
 */
function connectableFaults(ir, vw) {
  const parts = new Set((ir.parts ?? []).map((q, i) => (/^links/.test(q.id) ? i : -1)).filter((i) => i >= 0));
  const st = (x, y, z) => { const s = vw.pal.states[vw.get(x, y, z)]; return s && !/^minecraft:(cave_|void_)?air$/.test(splitState(s).name) ? splitState(s) : null; };
  const bad = { sides: [], floating: [], n: 0 };
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (!parts.has(part)) return;
    const s = splitState(vw.pal.states[idx]), fam = BLOCKS[s.name]?.family;
    if (fam !== 'fence' && fam !== 'wall' && fam !== 'pane') return;
    bad.n++;
    const D = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
    let joinedCube = false;
    for (const [d, [dx, dz]] of Object.entries(D)) {
      const n = st(x + dx, y, z + dz), want = joins(fam, n, d), got = fam === 'wall' ? s.props[d] !== 'none' : s.props[d] === 'true';
      if (want !== got) bad.sides.push([x, y, z, d, s.name, n?.name ?? 'air']);
      if (want && n && isCube(n)) joinedCube = true;
    }
    const below = st(x, y - 1, z), above = st(x, y + 1, z);
    const holds = (b) => b && (isCube(b) || ['slab', 'stairs', 'fence', 'wall'].includes(BLOCKS[b.name]?.family));
    const hangs = above && (isCube(above) || BLOCKS[above.name]?.family === 'slab');
    if (!holds(below) && !hangs && !joinedCube) bad.floating.push([x, y, z, s.name]);
  });
  return bad;
}

test('Noah\'s look: every climb fence joins its neighbours and stands on something (or hangs from the wall or deck)', async () => {
  const s = flatSurvey({ W: 240, D: 176 });
  const p = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'climbs_demo.mjs'), survey: s.bytes, claim: s.claim, seed: '1', params: { variant: 'flat' } });
  const n = goldenSurvey('s3');
  const q = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'climbs_demo.mjs'), survey: n.bytes, claim: n.claim, seed: '1', params: { variant: 'natural' } });
  const runs = [['flat', p, s], ['natural', q, n]];
  for (const f of read('valid', /^v7a_cl_/)) { const r = await run(f); runs.push([f.name, { ir: r.res.ir, blobs: r.res.blobs }, r.survey]); }
  let total = 0;
  for (const [name, plan, sv] of runs) {
    const { vw } = buildVirtual({ ir: plan.ir, survey: sv.bytes, blobs: (sha) => plan.blobs?.get?.(sha) ?? null });
    const b = connectableFaults(plan.ir, vw);
    total += b.n;
    assert.deepEqual(b.sides, [], `${name}: sides that disagree with their neighbours`);
    assert.deepEqual(b.floating, [], `${name}: posts on nothing`);
  }
  assert.ok(total > 40, `fences checked: ${total}`);
});

test('Noah\'s theme rule: every block the climbs write traces to a bible role (or a functional block), in the three gallery bibles, and the half-steps match the treads', async () => {
  const { themeOffenders } = await import('../lib/lint/theme.mjs');
  const { resolveRoles } = await import('../lib/region/plan.mjs');
  const s = flatSurvey({ W: 240, D: 176 });
  const seen = {};
  for (const b of [null, 'g7ak1_coastal', 'g7ak1_infernal']) {
    const bib = b ? JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'bibles', `${b}.json`), 'utf8')) : {};
    const p = await planRegion({ programFile: path.join(ROOT, 'kit', 'regions', 'climbs_demo.mjs'), survey: s.bytes, claim: s.claim, seed: '1', params: { variant: 'flat' }, roles: bib.roles ?? {}, connectors: bib.connectors ?? undefined });
    const { vw } = buildVirtual({ ir: p.ir, survey: s.bytes, blobs: (sha) => p.blobs?.get?.(sha) ?? null });
    assert.deepEqual(themeOffenders(p.ir, vw).offenders, [], `${b ?? 'default'}: unthemed blocks`);
    const roles = resolveRoles(bib.roles ?? {}, {});
    const slabs = new Set(), treads = new Set();
    vw.eachWritten((x, y, z, idx, f, part) => {
      const id = p.ir.parts[part]?.id ?? '', n = vw.pal.states[idx].replace(/\[.*$/, '');
      if (/^links/.test(id) && /_slab$/.test(n)) slabs.add(n);
      if (/^route/.test(id) && /_stairs$/.test(n)) treads.add(n.replace(/_stairs$/, ''));
    });
    // the half-step: the path role's slab where it has one, else the treads' block's slab (one block family with the flight)
    const pathSlab = `${roles.path.replace(/\[.*$/, '').replace(/s$/, '')}_slab`;
    assert.ok([...slabs].some((q) => q === pathSlab || [...treads].some((t) => q === `${t}_slab`)), `${b ?? 'default'}: half-steps ${[...slabs]} vs treads ${[...treads]}`);
    seen[b ?? 'default'] = [...slabs].sort().join(',');
  }
  assert.equal(new Set(Object.values(seen)).size, 3, `the three bibles' slabs differ: ${JSON.stringify(seen)}`);
});
