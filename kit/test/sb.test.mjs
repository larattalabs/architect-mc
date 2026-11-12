// (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, "Slice SB as built") The S5/S6 scenario programs offline, on their flat variants' land
// (S5 a flat world, S6 S3's flat hill): each sculpt planned and written into the land as natural land (kit/lib/region/sculpt.mjs, the
// runs the harness /fills), the program planned over it with the two-plan flow, every site lot's fit example built into its site and
// checked clean on the composite (the $0 lots: what Designs.siteVariant installs only with no site finding), the port links replayed with
// those entries' ports (IR v2), and the bars measured on the plan's world: SETTLEMENTS §16.3's Fit (the share of the dwellings with the
// fit called for), disturbance (the composite's cut / the lot's volume; KEEP fills nothing), every port reached from the entrance by the
// player mover, the region checker without errors. Deterministic: the same inputs give the same sculpt runs and IR shas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLand, applySculpt, plan2, buildLots } from './sb-world.mjs';
import { hillAt } from '../regions/s3_hill.mjs';
import { checkRegion, walkGraph, nodeReached } from '../lib/region/check.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { lotPortsWorld } from '../lib/region/links.mjs';
import { sculptRuns, stateClass } from '../lib/region/sculpt.mjs';
import { VC } from '../lib/region/volume.mjs';
import { splitBox } from '../../tools/lib/scenario-sb.mjs';

const S5 = { claim: { minX: 3328, minZ: -1600, maxX: 3519, maxZ: -1409 }, minY: 22, maxY: 156 };
const S6 = { claim: { minX: 3672, minZ: -1780, maxX: 3863, maxZ: -1589 }, minY: 22, maxY: 173 };

/** The scenario offline: sculpt, plan, build the lots, replay the links; the plan's world with the lots as obstacles. */
async function scenario(spec, groundAt, sculptId, programId, paramsOf, edit = null) {
  const land = makeLand({ claim: spec.claim, minY: spec.minY, maxY: spec.maxY, groundAt });
  if (edit) edit(land);
  const sculpt = await plan2(land, sculptId);
  const runs = applySculpt(land, sculpt);
  const params = paramsOf(sculpt.meta.sb);
  const plan = await plan2(land, programId, { params });
  const built = await buildLots(plan, land);
  const portsOf = (b) => b.ports.map((p) => ({ name: p.name, kind: p.kind, at: [p.x, p.y, p.z], facing: p.facing, width: p.width ?? (p.kind === 'door' ? 1 : 2), height: p.height ?? 2 }));
  const linked = plan.ir.portLinks?.length ? await plan2(land, programId, { params, links: { lots: Object.fromEntries(built.map((b) => [b.lot, { entry: b.lot, ports: portsOf(b) }])) } }) : plan;
  const vols = Object.values(linked.ir.volumes ?? {}).map((u) => land.volume(u.box).decoded);
  const { vw } = buildVirtual({ ir: linked.ir, survey: land.survey(), blobs: (s) => linked.blobs.get(s), volumes: vols });
  for (const l of linked.ir.lots) vw.addLot(l);
  const g = walkGraph(vw, [linked.ir.anchors.entrance]);
  const ports = built.flatMap((b) => lotPortsWorld(linked.ir.lots.find((l) => l.id === b.lot), portsOf(b)).map((p) => ({ lot: b.lot, port: p.name, reached: nodeReached(g, p.out) })));
  const check = checkRegion({ ir: linked.ir, survey: land.survey(), blobs: (s) => linked.blobs.get(s), volumes: vols, meta: linked.meta });
  return { land, sculpt, runs, plan, linked, built, ports, check };
}

/** §16.3's Fit and disturbance over a scenario's lots (the composite's cut: SC's metrics.cut). */
function fitBars(S) {
  const sb = S.plan.meta.sb;
  const called = new Set(Object.values(sb.fitCalledFor).flat());
  const ok = sb.dwellings.filter((id) => called.has(id) && S.built.find((b) => b.lot === id)?.ok);
  const dist = S.built.map((b) => { const l = S.plan.ir.lots.find((q) => q.id === b.lot); const v = l.max[0] * l.max[1] * l.max[2]; return (b.siteMetrics.cut.rock + b.siteMetrics.cut.logs) / v; });
  return { share: ok.length / sb.dwellings.length, worst: Math.max(...dist) };
}

const results = {};
const s6 = () => (results.s6 ??= scenario(S6, (x, z) => 64 + hillAt((S6.claim.minX + S6.claim.maxX) >> 1, (S6.claim.minZ + S6.claim.maxZ) >> 1, 88, 60, x, z), 's6_cavern_sculpt', 's6_cave_city', (sb) => ({ floorY: sb.floorY })));
// a natural tree where the middle pair's walk runs (the grove's centre on this land): the sculpt's clearing must take it
const NATURAL = [3424, -1504];
const naturalTree = (land) => {
  const [x, z] = NATURAL;
  for (let y = 65; y <= 69; y++) land.set(x, y, z, VC.LOG);
  for (let u = -2; u <= 2; u++) for (let v = -2; v <= 2; v++) for (let y = 68; y <= 71; y++) if (u || v || y > 69) land.set(x + u, y, z + v, VC.LEAVES);
};
const s5 = () => (results.s5 ??= scenario(S5, () => 64, 's5_grove_sculpt', 's5_treehouses', (sb) => ({ grove: sb }), naturalTree));

test('S6 flat: the cavern sculpt (6b cavern, edge rows, the ramp) gives seven carve_into lots that each build their fit example clean', async () => {
  const S = await s6();
  assert.equal(S.sculpt.meta.sb.voidCost, 0, 'the hill holds no void');
  assert.ok(S.runs.length > 0 && S.runs.every((r) => ['AIR', 'ROCK', 'PLANT'].includes(stateClass(r.state))), 'the sculpt writes air, the cavern floor and its lights');
  assert.equal(S.plan.ir.lots.length, 7);
  assert.ok(S.plan.ir.lots.every((l) => l.site?.fit === 'carve_into'));
  for (const b of S.built) assert.deepEqual([b.lot, b.ok, b.errors, b.siteFindings.map((f) => f.rule)], [b.lot, true, [], []], `${b.lot}: the carved hall builds into its site with no finding`);
});

test('S6 flat: §16.3 Fit 100% carve_into, disturbance at most 0.3, every door reached from the entrance, no checker error', async () => {
  const S = await s6();
  const f = fitBars(S);
  assert.equal(f.share, 1);
  assert.ok(f.worst <= 0.3, `disturbance ${f.worst}`);
  assert.deepEqual(S.ports.filter((p) => !p.reached), []);
  assert.equal(S.ports.length, 7);
  assert.deepEqual(S.check.findings.filter((x) => x.severity === 'error').map((x) => x.rule), []);
  assert.deepEqual(S.check.metrics.M2.unreachable, []);
});

test('S5 flat: the grove sculpt (six straight-trunk giant oaks, the ramps) gives six wrap_trunk lots that each build their fit example clean', async () => {
  const S = await s5();
  const sb = S.sculpt.meta.sb;
  assert.equal(sb.trees.length, 6);
  assert.ok(sb.trees.every((t) => t.straight), 'every trunk straight through its house');
  assert.equal(sb.ramps.length, 3);
  const [nx, nz] = NATURAL;
  for (let y = 65; y <= 71; y++) assert.equal(S.land.cls(nx, y, nz), VC.AIR, `the natural tree's cell ${nx},${y},${nz} cleared`);
  assert.equal(S.plan.ir.lots.length, 6);
  assert.ok(S.plan.ir.lots.every((l) => l.site?.fit === 'wrap_trunk' && l.site.keepCritical.length > 0), 'each lot wraps its tree (its logs keep-critical)');
  for (const b of S.built) assert.deepEqual([b.lot, b.ok, b.errors, b.siteFindings.map((f) => f.rule)], [b.lot, true, [], []], `${b.lot}: the trunk house builds into its site with no finding`);
});

test('S5 flat: the branch walks link at realise (IR v2), §16.3 Fit 100% wrap_trunk, disturbance 0, every port reached up the ramps, no checker error', async () => {
  const S = await s5();
  assert.equal(S.linked.meta.links.length, 3);
  assert.ok(S.check.metrics.branchWalks.per.every((p) => p.ok), JSON.stringify(S.check.metrics.branchWalks.per));
  const f = fitBars(S);
  assert.equal(f.share, 1);
  assert.equal(f.worst, 0, 'a trunk house cuts no log');
  assert.deepEqual(S.ports.filter((p) => !p.reached), []);
  assert.equal(S.ports.length, 6);
  assert.deepEqual(S.check.findings.filter((x) => x.severity === 'error').map((x) => x.rule), []);
  assert.deepEqual(S.check.metrics.M2.unreachable, []);
});

test('the sculpt runs are deterministic, cover every written cell once and fit /fill', async () => {
  const S = await s6();
  const again = sculptRuns(S.sculpt.ir, makeLand({ claim: S6.claim, minY: S6.minY, maxY: S6.maxY, groundAt: (x, z) => 64 + hillAt((S6.claim.minX + S6.claim.maxX) >> 1, (S6.claim.minZ + S6.claim.maxZ) >> 1, 88, 60, x, z) }).survey(), (s) => S.sculpt.blobs.get(s));
  assert.deepEqual(again, S.runs);
  const seen = new Set();
  for (const r of S.runs) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) for (let z = r.z0; z <= r.z1; z++) { const k = `${x},${y},${z}`; assert.ok(!seen.has(k), `${k} twice`); seen.add(k); }
  const s5r = (await s5()).sculpt;
  const L5 = makeLand({ claim: S5.claim, minY: S5.minY, maxY: S5.maxY, groundAt: () => 64 });
  naturalTree(L5);
  const p = await plan2(L5, 's5_grove_sculpt');
  assert.equal(p.irSha, s5r.irSha, 'the grove sculpt plans the same twice');
  // /fill's 32768-cell limit: a box over it splits into boxes under it covering it exactly
  const big = { state: 'minecraft:air', x0: 0, y0: 0, z0: 0, x1: 99, y1: 9, z1: 49 };
  const parts = splitBox(big);
  assert.ok(parts.every((q) => (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) * (q.z1 - q.z0 + 1) <= 32768));
  assert.equal(parts.reduce((a, q) => a + (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) * (q.z1 - q.z0 + 1), 0), 100 * 10 * 50);
});
