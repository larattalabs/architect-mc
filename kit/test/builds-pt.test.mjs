// Phase 6c slice PT §10 (plan/0 additive) and §7 keep-outs: the schema members feature.build, target {build}, endpoint.build and
// their catalogue entries; the kit helpers the plan check calls (pick, endpoint on the door's apron, keep-outs); `around` stays
// reserved (locator.around until FL).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../lib/specschema.mjs';
import { pickBuild, buildEndpoint, buildKeepOut, targetRect, buildsUsed, keptBuilds } from '../lib/region/builds.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plan = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'plan.json'), 'utf8'));
const def = (n) => plan.$defs[n];
const ok = (n, v) => validateSpec(def(n), v, '$', plan);

// a cabin (9x7x9, door at its south wall facing south), a wall and a farm, as Sites.builds gives them
const cabin = { id: 'build-12', kind: 'HOUSE', state: 'ACTIVE', cells: 330, revision: 3, bounds: [0, 64, 0, 8, 70, 8],
  footprint: Array.from({ length: 9 }, (_, z) => [z, 0, 8]).flat(), entrances: [{ pos: [4, 64, 0], facing: 'south' }] };
const big = { id: 'build-20', kind: 'HOUSE', state: 'ACTIVE', cells: 900, revision: 1, bounds: [40, 64, 40, 60, 74, 60],
  footprint: Array.from({ length: 21 }, (_, z) => [40 + z, 40, 60]).flat(), entrances: [{ pos: [50, 64, 60], facing: 'north' }, { pos: [40, 64, 50], facing: 'east' }] };
const wall = { id: 'build-7', kind: 'WALL', state: 'PROVISIONAL', cells: 48, revision: 1, bounds: [20, 64, 0, 35, 66, 0], footprint: [0, 20, 35], entrances: [] };
const gone = { id: 'build-3', kind: 'HOUSE', state: 'RELEASED', cells: 60, revision: 2, bounds: [100, 64, 100, 106, 68, 106], footprint: [], entrances: [] };
const builds = [cabin, big, wall, gone];
const claim = { minX: -10, minZ: -10, maxX: 70, maxZ: 70 };

test('PT §10: feature.build, target {build}, endpoint.build validate; malformed ones do not', () => {
  assert.deepEqual(ok('feature', { build: { kind: 'house', pick: 'nearest' } }), []);
  assert.deepEqual(ok('feature', { build: { id: 'build-12' } }), []);
  assert.ok(ok('feature', { build: {} }).length > 0, 'id or kind is required');
  assert.ok(ok('feature', { build: { kind: 'castle' } }).length > 0, 'kinds are the BuildKind enum');
  assert.ok(ok('feature', { build: { id: 'cabin' } }).length > 0, 'ids are build-<n>');
  assert.deepEqual(ok('target', { build: 'build-12' }), []);
  assert.deepEqual(ok('where', { adjacent: { to: { build: 'build-12' } } }), []);
  assert.deepEqual(ok('where', { near: { feature: { build: { kind: 'house' } } } }), []);
  assert.deepEqual(ok('endpoint', { build: 'build-12', port: 'door' }), []);
  assert.deepEqual(ok('endpoint', { build: 'build-12', port: 'door_2' }), []);
  assert.ok(ok('endpoint', { build: 'build-12', port: 'gate' }).length > 0);
  // around stays the reserved locator (it parses; the check answers unsupported locator.around until FL)
  assert.deepEqual(ok('where', { around: { feature: { build: { id: 'build-12' } } } }), []);
});

test('PT §10: the catalogue has feature.build and endpoint.build supported (additive), locator.around reserved', () => {
  const e = Object.fromEntries(plan['x-catalogue'].entries.map((x) => [x.id, x]));
  for (const id of ['feature.build', 'endpoint.build']) {
    assert.equal(e[id]?.state, 'supported', id);
    assert.match(e[id].sinceApi, /^\d+\.\d+\.\d+$/, `${id}: a version (PT's placeholder)`);
    assert.deepEqual(validateSpec(plan.$defs.catalogueEntry, e[id], '$', plan), [], id);
  }
  assert.equal(e['locator.around'].state, 'reserved');
  assert.equal(new Set(plan['x-catalogue'].entries.map((x) => x.id)).size, plan['x-catalogue'].entries.length, 'ids are unique');
});

test('PT §10: pickBuild by id and by kind with feature.pick ties; released builds are no features', () => {
  assert.equal(pickBuild(builds, { id: 'build-12' }).build.id, 'build-12');
  assert.match(pickBuild(builds, { id: 'build-3' }).none, /no build build-3/);
  assert.equal(pickBuild(builds, { kind: 'house' }, { claim }).build.id, 'build-20', 'largest first');
  assert.equal(pickBuild(builds, { kind: 'house', pick: 'nearest' }, { claim, to: [0, 0] }).build.id, 'build-12', 'nearest to the anchor');
  assert.equal(pickBuild(builds, { kind: 'wall' }, { claim }).build.id, 'build-7', 'a provisional build is a feature (it is kept)');
  assert.match(pickBuild(builds, { kind: 'farm' }, { claim }).none, /no farm/);
  assert.deepEqual(keptBuilds(builds).map((b) => b.id), ['build-12', 'build-20', 'build-7']);
  assert.deepEqual(targetRect(builds, 'build-12'), [0, 0, 8, 8]);
  assert.equal(targetRect(builds, 'build-3'), null);
});

test('PT §10: endpoint.build ends a road on the door apron, outside the footprint', () => {
  const e = buildEndpoint(builds, 'build-12', 'door');
  assert.deepEqual(e.apron, [[4, 64, -1], [4, 64, -2], [4, 64, -3]], 'the door faces south into the room: the apron is north, outside');
  assert.deepEqual(e.end, [4, 64, -3]);
  const e2 = buildEndpoint(builds, 'build-20', 'door_2');
  assert.deepEqual(e2.door, [50, 64, 60], 'door_2: the second entrance by position');
  assert.ok(e2.apron.every((c) => c[2] > 60 || c[2] < 40 || c[0] < 40 || c[0] > 60), 'outside the footprint');
  assert.match(buildEndpoint(builds, 'build-12', 'door_2').none, /1 entrance/);
});

test('PT §7: keep-outs are each build grown by 1 and its door aprons; a consented build is left out (S-PT-4)', () => {
  const k = buildKeepOut(builds, { claim });
  assert.deepEqual(k[0], [-1, -1, 9, 9]);
  assert.ok(k.some((r) => r[0] === 4 && r[2] === 4 && r[1] === -3 && r[3] === -1), 'the cabin door apron');
  assert.ok(!k.some((r) => r[0] === 99), 'a released build keeps nothing out');
  assert.ok(!buildKeepOut(builds, { claim, consented: ['build-12'] }).some((r) => r[0] === -1 && r[1] === -1), 'the consented cabin is no keep-out');
  assert.deepEqual(buildsUsed(builds, ['build-20', 'build-12']), [{ id: 'build-12', revision: 3 }, { id: 'build-20', revision: 1 }]);
});
