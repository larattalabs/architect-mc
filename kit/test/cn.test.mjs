// (7c CN, docs/CONTRACT.md "Slice CN as built") Connectors in game, the kit's part: a stepped branch walk between walk ports at
// different feet y (LP's and WL's leftover: ports up to BRANCH_WALK.rise rows apart, one row per straight move, the step's higher cell a
// stair; ports at one y route exactly as before), re-checked by the region checker's M10:branch_walk at each cell's own feet y.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, tree, planWorld } from './lp-world.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { BRANCH_WALK, LinkError, replayDiff } from '../lib/region/links.mjs';
import { asColumns, canonicalJson } from '../lib/region/pack.mjs';
import { LINK_STAGE } from '../lib/region/links.mjs';
import { planRegion, fillMissing } from '../lib/region/plan.mjs';
import { finishCheck } from '../lib/plan/finish.mjs';
import { mergeEffective, revisionStanding } from '../lib/region/revise.mjs';
import { read, run, svOf } from './plan-p0-shared.mjs';
import { PLAN_V0, checkPlanVolumes, flatSurvey, stewardAnchors } from './plan-helpers.mjs';
import fs from 'node:fs';

const G = 64;
const walk = (name, at, facing) => ({ name, kind: 'architect:walk', at, facing, width: 2, height: 2 });
const trees = () => makeWorld({ ground: G, edits: [...tree(1030, 2040, G), ...tree(1050, 2040, G)] });
const canopy = (cx, cz) => [cx - 4, G + 13, cz - 4, cx + 4, G + 20, cz + 4];
const body = (portsA) => (r) => {
  r.siteLot('a', { fit: 'wrap_trunk', box: canopy(1030, 2040), stage: 'lots', ports: portsA });
  r.siteLot('b', { fit: 'wrap_trunk', box: canopy(1050, 2040), stage: 'lots' });
  return r.portLink('ab', { kind: 'branch_walk', from: { lot: 'a' }, to: { lot: 'b' } });
};
const bPorts = [walk('walk_w', [0, 2, 4], 'west')];

async function stepped(row) {
  const w = trees();
  const east = [walk('walk_e', [8, row, 4], 'east')];
  const P = await planWorld(w, body(east));
  const L = await planWorld(w, body(east), { links: { lots: { a: { entry: 'ea', ports: east }, b: { entry: 'eb', ports: bPorts } } } });
  return { w, P, L };
}

for (const row of [3, 5]) {
  test(`branch_walk between ports ${row - 2} row(s) apart: a stepped walk, stairs on the higher cells, M10:branch_walk, M6, M8 clean`, async () => {
    const { w, P, L } = await stepped(row);
    const bw = L.res.meta.branchWalks[0];
    const ys = bw.path.map((p) => p[1]);
    assert.equal(ys[0], G + 13 + row, 'starts at a\'s feet y');
    assert.equal(ys.at(-1), G + 15, 'ends at b\'s feet y');
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] === ys[i - 1] || ys[i] === ys[i - 1] - 1, `monotone, one row a move (${ys[i - 1]} -> ${ys[i]})`);
    assert.equal(bw.steps.length, row - 2, 'one stair per row');
    const ir = L.res.ir;
    const states = new Set(ir.parts.filter((p) => p.id === 'link_ab').flatMap((p) => p.ops.flatMap((o) => o.materials ?? o.palette ?? [])));
    assert.ok([...states].some((s) => /_stairs\[facing=west,half=bottom/.test(String(s))), `a stair faces up the walk (west, towards a): ${[...states].join(' ')}`);
    const c = checkRegion({ ir, survey: w.survey, blobs: (s) => L.res.blobs.get(s), volumes: [w.vol], meta: L.res.meta });
    const bad = c.findings.filter((f) => ['M10:branch_walk', 'M6', 'M8', 'M1:site'].some((r) => f.rule.startsWith(r)));
    assert.deepEqual(bad.map((f) => `${f.rule}: ${f.message}`), []);
    const m = c.metrics.branchWalks.per[0];
    assert.ok(m.ok && m.deck === m.cells && m.headroom === m.cells, JSON.stringify(m));
    assert.equal(replayDiff(P.res.ir, L.res.ir, canonicalJson), null, 'IR v2 = IR v1 plus the links');
    const again = await planWorld(w, body([walk('walk_e', [8, row, 4], 'east')]), { links: { lots: { a: { entry: 'ea', ports: [walk('walk_e', [8, row, 4], 'east')] }, b: { entry: 'eb', ports: bPorts } } } });
    assert.equal(again.res.irSha, L.res.irSha, 'deterministic');
  });
}

test('branch_walk at one feet y: no steps member (the record is as before); ports further apart than BRANCH_WALK.rise refuse LEVEL', async () => {
  const { L } = await stepped(2);
  assert.equal(L.res.meta.branchWalks[0].steps, undefined);
  assert.ok(L.res.meta.branchWalks[0].path.every((p) => p[1] === G + 15));
  assert.equal(BRANCH_WALK.rise, 4);
  // an entry whose port is 5 rows off the other's (a pre-WL entry far off its hint): still LEVEL, typed, nothing written
  await assert.rejects(planWorld(trees(), body([walk('walk_e', [8, 7, 4], 'east')])), (e) => e instanceof LinkError && e.code === 'LEVEL' && /at most 4 rows/.test(e.message));
});

// ------------------------------------------------------------------ LP's leftover: a revision of a region realised from IR v2

test('a revision of a region realised from IR v2 (a linked canopy): keep + add a zone, the revision IR has no site_links, no portLinks, no linked (change 4)', async () => {
  const V7B = read('valid').find((f) => f.name === 'v7b_sl_canopy.json');
  const plan = { ...V7B.plan, connectors: [{ id: 'walk', kind: 'branch_walk', from: { part: 'hut_a' }, to: { part: 'hut_b' } }] };
  const fx = { ...V7B, plan };
  const P = await run(fx);
  assert.equal(P.check.overall, 'READY');
  const links = { lots: Object.fromEntries(['hut_a', 'hut_b'].map((id) => [id, { entry: `e_${id}`, ports: P.res.ir.lots.find((l) => l.id === id).site.ports }])) };
  const L = await run(fx, { volumes: P.volumes, links });
  assert.ok(L.res.ir.linked && L.res.ir.stages.includes(LINK_STAGE), 'the parent is IR v2');
  // the revision inputs as Regions.planRevision sends them, the parent the region's IR (IR v2) and the check's built parts
  const built = P.check.parts.filter((a) => a.class === 'fits' || a.class === 'adjusted').map((a) => a.part);
  const eff = mergeEffective(L.res.ir);
  const s = svOf(V7B);
  const c = s.claim;
  const standing = revisionStanding({ id: 'rg1', claim: [c.minX, c.minZ, c.maxX, c.maxZ], effective: eff, lots: Object.fromEntries(L.res.ir.lots.map((l) => [l.id, { state: 'placed' }])) });
  const revision = { rid: 1, position: 1, region: 'rg1', parentRid: 0, parentArtifact: P.artifactSha, parentIrSha: L.res.irSha, base: { irSha: L.res.irSha },
    parent: { plan, built, geometry: Object.fromEntries(P.check.parts.filter((a) => a.geometry?.rect).map((a) => [a.part, a.geometry.rect])) }, standing, history: {}, heldSha: 'held' };
  const yard = { id: 'yard', kind: 'standard', program: { lots: [{ id: 'y1', type: 'house', size: [9, 9] }] }, where: { near: { anchor: 'claim_center', within: 80 } } };
  const rplan = { ...plan, zones: [...plan.zones, yard], revision: { n: 1, parentArtifact: P.artifactSha } };
  const params = { plan: rplan, anchors: { anchors: { ...stewardAnchors(c), ...(V7B.anchors ?? {}) } }, protected: { areas: [] }, regions: { regions: [] }, builds: { builds: [] }, budget: {}, bible: null, fingerprint: null };
  const res = await planRegion({ programFile: PLAN_V0, params, survey: s.bytes, claim: c, roles: {}, volumes: P.volumes, revision });
  const f = finishCheck({ res, survey: fillMissing(asColumns(s.bytes)).columns, blobs: (sha) => res.blobs.get(sha) ?? null, inputs: { surveyRes: 1 } });
  const ans = (id) => f.check.parts.find((a) => a.part === id);
  assert.equal(ans('canopy').standing, true, JSON.stringify(ans('canopy')));
  assert.equal(ans('walk').standing, true, `the link stands: ${JSON.stringify(ans('walk'))}`);
  assert.ok(['fits', 'adjusted'].includes(ans('yard').class), JSON.stringify(ans('yard')));
  assert.ok(!res.ir.stages.includes(LINK_STAGE), `no site_links stage: ${res.ir.stages.join(',')}`);
  assert.equal(res.ir.portLinks, undefined);
  assert.equal(res.ir.linked, undefined);
  assert.ok(res.ir.parts.every((p) => p.stage !== LINK_STAGE && !/^link_/.test(p.id)), 'nothing of the standing link is written again');
  assert.deepEqual(f.artifact.revision.keep.sort(), ['canopy', 'walk']);
});

// ------------------------------------------------------------------ CX's leftover: ladder, catwalk and rock stair on land they fit

for (const name of ['cn01_ladder', 'cn02_catwalk', 'cn03_rock_stair']) {
  test(`${name}: the connector's one-part plan (ConnectorPlace.planOf's shape) READY, the link fits, only the link writes, its rules clean`, async () => {
    const fx = JSON.parse(fs.readFileSync(new URL(`./fixtures/plan/cn/${name}.json`, import.meta.url), 'utf8'));
    const [a, b] = [fx.anchors.cx_from, fx.anchors.cx_to];
    assert.deepEqual(fx.claim, [Math.min(a[0], b[0]) - 16, Math.min(a[2], b[2]) - 16, Math.max(a[0], b[0]) + 16, Math.max(a[2], b[2]) + 16], 'the claim is the ends\' box plus 16');
    const s = flatSurvey(fx.terrain);
    const r = await checkPlanVolumes(fx.plan, { survey: s.bytes, claim: s.claim, anchors: fx.anchors, volume: {} });
    assert.equal(r.check.overall, 'READY', JSON.stringify(r.check.parts));
    const link = r.check.parts.find((p) => p.part === 'link');
    assert.equal(link.class, 'fits', JSON.stringify(link));
    assert.ok(r.res.ir.parts.filter((p) => p.ops.some((o) => o.bounds)).length > 0);
    assert.equal(r.res.ir.lots?.length ?? 0, 0);
    const rep = checkRegion({ ir: r.res.ir, survey: s.bytes, blobs: (sha) => r.res.blobs.get(sha), meta: r.res.meta, volumes: r.volumes.map((v) => v.decoded ?? v) });
    assert.deepEqual(rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} ${f.message}`), []);
  });
}
