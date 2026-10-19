// Phase 6c slice P0 (docs/CONTRACT.md "Phase 6c slice P0: plan check v0" §8), the kit half of the gate, $0 and offline:
//   1 schema fixtures (valid / malformed / extension; ajv 2020-12 is the sidecar's test, sidecar/test/plan-schema.test.ts)
//   2 per-class answers (all 7 classes, reason codes, blockedBy, until, deviations; REQUIRED_BLOCKED has no artifact; wouldFit
//     re-checked alone fits)
//   3 determinism (3 checks give identical answers and artifact shas; 1 and 4 tile workers give equal tile shas)
//   7 incomplete (maxNodes 1,000 and maxMs 1: INCOMPLETE, no artifact, nothing cached as fits)
//   8 cache (one zone changed: every independent part cached, answers equal to a cold check's)
//   9 catalogue (the committed golden; every supported entry has a valid/ fixture that fits, every reserved one an extension/
//     fixture answering unsupported with its id; the catalogue diff against catalogue-next.json; a pending part flagged)
//  11 Steward's 59 recorded plans: none crashes, none malformed, the parts answer.waits names are unsupported or blocked; the
//     per-block gap table is printed
// (item 10, the op goldens, is plan-ops.test.mjs; item 12 is scenario-goldens.test.mjs.)
// (housekeeping 2: the slow parts run in their own files so no single file sets the kit suite's wall time: plan-p0-valid (item 1's
// valid/ fixtures), plan-p0-det-1..3 (item 3) and plan-p0-asks (item 11); the helpers are plan-p0-shared.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asksSurvey, goldenSurvey, stewardAnchors, checkPlanLocal, checkPlanVolumes, memoryCache, flatSurvey, FIX, ROOT } from './plan-helpers.mjs';
import { validatePlan, PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';
import { SV, read, svOf, run, lots, A, asks, part, GROVE, NEAR_CENTRE, WALL, WALLED } from './plan-p0-shared.mjs';

// ------------------------------------------------------------------ 1

// (the valid/ fixtures: plan-p0-valid.test.mjs)

test('item 1: malformed/ fixtures (at least 12) answer malformed with the expected path and code', async () => {
  const fx = read('malformed');
  assert.ok(fx.length >= 12, `${fx.length} malformed fixtures`);
  for (const f of fx) {
    const r = await run(f);
    if (f.expect.plan) {
      assert.equal(r.check.overall, 'MALFORMED', f.name);
      assert.equal(r.check.malformed.path, f.expect.path, `${f.name}: ${JSON.stringify(r.check.malformed)}`);
      assert.equal(r.check.malformed.code, f.expect.code, f.name);
    } else {
      const a = part(r, f.expect.part);
      assert.equal(a.class, 'malformed', `${f.name}: ${a.class}`);
      assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
      assert.equal(a.reasons[0].path, f.expect.path, `${f.name}: ${JSON.stringify(a.reasons)}`);
    }
    assert.equal(r.artifact?.parts.find((p) => p.part === f.expect.part)?.class ?? 'malformed', 'malformed');
  }
});

test('item 1: extension/ fixtures (at least 6) answer unsupported {block} with the exact id; the oversize envelope is malformed EXTENSION_BOUND', async () => {
  const fx = read('extension');
  assert.ok(fx.length >= 6, `${fx.length} extension fixtures`);
  for (const f of fx) {
    const r = await run(f);
    const want = f.expect.all ?? [f.expect];
    for (const e of want) {
      const a = part(r, e.part);
      if (e.class === 'malformed') { assert.equal(a.class, 'malformed', f.name); assert.equal(a.reasons[0].code, e.code, f.name); continue; }
      assert.equal(a.class, 'unsupported', `${f.name} ${e.part}: ${a.class}`);
      assert.equal(a.block, e.block, `${f.name} ${e.part}`);
      assert.equal(a.reasons[0].block, e.block);
      // a catalogue entry names the slice it waits for; a kind the catalogue does not know has none
      if (PLAN_SCHEMA['x-catalogue'].entries.some((x) => x.id === e.block)) assert.ok(a.reasons[0].until, `${f.name} ${e.part}: until`);
    }
  }
});

// ------------------------------------------------------------------ 2


test('item 2: the seven classes, with their reasons, deviations, blockedBy and until', async () => {
  // fits
  const fit = await run(read('valid').find((f) => f.name.startsWith('v01')));
  assert.equal(part(fit, 'town').class, 'fits');
  // adjusted: the protected grove holds the centre, so the zone moves 31 (past its soft 16, under the ceiling 64)
  const adj = await asks(NEAR_CENTRE(), { protected: GROVE });
  const t = part(adj, 'town');
  assert.equal(t.class, 'adjusted');
  assert.deepEqual(t.deviations, [{ what: 'move', value: 31, max: 16, exceeds: true }]);
  // refused: the same with a hard move of 2; what would fit; the path from it blocked
  const ref = await asks(NEAR_CENTRE({ move: { max: 2, hard: true } }), { protected: GROVE });
  const z = part(ref, 'town');
  assert.equal(z.class, 'refused');
  assert.equal(z.reasons[0].code, 'TOLERANCE');
  assert.ok(z.wouldFit?.length >= 1 && z.wouldFit.length <= 4);
  assert.ok(z.wouldFit.every((w) => Array.isArray(w.geometry?.rect) && Array.isArray(w.cost?.range?.cells)), 'each alternative carries its own geometry and cost');
  const up = part(ref, 'up');
  assert.equal(up.class, 'blocked');
  assert.deepEqual(up.blockedBy, ['town']);
  assert.equal(up.reasons[0].code, 'DEPENDENCY');
  assert.equal(ref.check.overall, 'NEEDS_REPAIR');
  assert.ok(ref.artifactSha, 'NEEDS_REPAIR makes an artifact');
  assert.deepEqual(ref.artifact.dropped.map((d) => [d.part, d.class]), [['town', 'refused'], ['up', 'blocked']]);
  // each wouldFit alternative, re-checked alone (the fragment merged into the part), fits
  for (const w of z.wouldFit) {
    const p2 = NEAR_CENTRE({ move: { max: 2, hard: true } });
    Object.assign(p2.zones[0], w.fragment);
    p2.connectors = [];
    const r2 = await asks(p2, { protected: GROVE });
    assert.equal(part(r2, 'town').class, 'fits', `wouldFit ${JSON.stringify(w.fragment)}: ${JSON.stringify(part(r2, 'town'))}`);
  }
  // unsupported (required): REQUIRED_BLOCKED and no artifact ((7a K1) on connector.catwalk, which stays reserved, since
  // connector.wall ships)
  const req = NEAR_CENTRE();
  req.connectors.push({ id: 'walk', kind: 'catwalk', required: true, from: { part: 'town' }, to: { anchor: 'claim_n' } });
  const rb = await asks(req);
  assert.equal(part(rb, 'walk').class, 'unsupported');
  assert.equal(part(rb, 'walk').block, 'connector.catwalk');
  assert.equal(part(rb, 'walk').reasons[0].until, '7a');
  assert.equal(rb.check.overall, 'REQUIRED_BLOCKED');
  assert.equal(rb.artifactSha, null);
  // malformed (a part): its path; the rest still answers
  const mal = await asks({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(2) } }], connectors: [{ id: 'r', kind: 'road', from: { anchor: 'claim_n' }, to: { part: 'town' }, width: 9 }] });
  assert.equal(part(mal, 'r').class, 'malformed');
  assert.equal(part(mal, 'r').reasons[0].path, '$.connectors[0].width');
  assert.equal(part(mal, 'town').class, 'fits');
  // (C36) a required malformed part blocks like a required unsupported one: REQUIRED_BLOCKED, no artifact; an optional one stays NEEDS_REPAIR
  const malReq = await asks({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(2) } }], connectors: [{ id: 'r', kind: 'road', required: true, from: { anchor: 'claim_n' }, to: { part: 'town' }, width: 9 }] });
  assert.equal(part(malReq, 'r').class, 'malformed');
  assert.equal(part(malReq, 'r').required, true);
  assert.equal(malReq.check.overall, 'REQUIRED_BLOCKED');
  assert.equal(malReq.artifactSha, null);
  assert.equal(mal.check.overall, 'NEEDS_REPAIR');
  assert.ok(mal.artifactSha, 'an optional malformed part still makes the artifact');
  // incomplete: item 7
  const inc = await asks(WALLED, { protected: WALL, budget: { maxNodes: 1000 } });
  assert.equal(part(inc, 'long').class, 'incomplete');
  assert.equal(part(inc, 'long').reasons[0].evidence.cap, 'maxNodes');
  // overlap: two zones on one hard anchor, the second refused OVERLAP
  const two = await asks({ schemaVersion: 'plan/0', zones: [{ id: 'a', program: { lots: lots(3, 'a') }, where: { near: { anchor: 'stone', within: 0 } } },
    { id: 'b', program: { lots: lots(3, 'b') }, where: { near: { anchor: 'stone', within: 0 } }, tolerance: { move: { max: 0, hard: true } } }] });
  assert.equal(part(two, 'a').class, 'fits');
  assert.equal(part(two, 'b').class, 'refused');
  assert.equal(part(two, 'b').reasons[0].code, 'OVERLAP', JSON.stringify(part(two, 'b').reasons));
  assert.deepEqual(part(two, 'b').reasons[0].evidence.zones, ['a']);
  assert.ok(part(two, 'b').wouldFit?.length >= 1 && part(two, 'b').wouldFit.every((w) => w.geometry?.rect && w.cost?.range), 'what would fit, with its geometry and cost');
  // every reason carries evidence (§3)
  for (const r of [fit, adj, ref, rb, mal, inc, two]) for (const a of r.check.parts) for (const x of a.reasons ?? []) assert.ok(x.evidence && typeof x.evidence === 'object', `${a.part} ${x.code}: evidence`);
});

// ------------------------------------------------------------------ 3

// (item 3, determinism: plan-p0-det-1..3.test.mjs, a third of the plans each)

// ------------------------------------------------------------------ 7


test('item 7: a forced maxNodes of 1,000 and a maxMs of 1: the route incomplete, overall INCOMPLETE, no artifact, nothing cached as fits', async () => {
  const n = await asks(WALLED, { protected: WALL, budget: { maxNodes: 1000 } });
  assert.equal(n.check.overall, 'INCOMPLETE');
  assert.equal(n.artifactSha, null);
  assert.equal(part(n, 'long').class, 'incomplete');
  assert.equal(part(n, 'town').class, 'fits', 'parts answered before the cap keep their answers');
  // only the zone (answered) is in the cache; the incomplete route never is
  assert.equal(Object.keys(n.cacheOut).length, 1);
  assert.equal(Object.values(n.cacheOut)[0].klass, 'fits');
  const full = await asks(WALLED, { protected: WALL });
  assert.equal(part(full, 'long').class === 'fits' || part(full, 'long').class === 'adjusted', true, JSON.stringify(part(full, 'long')));
  const m = await asks(WALLED, { protected: WALL, budget: { maxMs: 1 } });
  assert.equal(m.check.overall, 'INCOMPLETE');
  assert.equal(m.artifactSha, null);
  assert.ok(m.check.parts.every((a) => a.class === 'incomplete'));
  assert.equal(m.check.parts[0].reasons[0].evidence.cap, 'maxMs');
  assert.deepEqual(m.cacheOut, {}, 'a check that hit maxMs is never cached');
});

// ------------------------------------------------------------------ 8

test('item 8: a second check with one zone changed: every independent part cached, answers equal to a cold check', async () => {
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'east', program: { lots: lots(3, 'e') }, where: { near: { anchor: 'claim_e', within: 8 } } },
    { id: 'west', program: { lots: lots(3, 'w') }, where: { near: { anchor: 'claim_w', within: 8 } } }],
    forms: [{ id: 'spire', kind: 'rock_spire', preset: 'hoodoo', where: { near: { anchor: 'claim_n', within: 16 } } }],
    connectors: [{ id: 'road', kind: 'road', from: { part: 'east' }, to: { part: 'west' } }] };
  const cache = memoryCache();
  const first = await asks(plan, { planCache: cache.get });
  cache.put(first.cacheOut);
  assert.ok(cache.size() >= 2);
  const changed = structuredClone(plan);
  changed.zones[1].program.lots.push({ id: 'w4', type: 'smithy', size: [11, 9] });
  const warm = await asks(changed, { planCache: cache.get });
  const cold = await asks(changed);
  assert.equal(part(warm, 'east').cached, true, 'the unchanged zone comes from the cache');
  assert.equal(part(warm, 'spire').cached, true, 'the independent form comes from the cache');
  assert.equal(part(warm, 'road').cached, undefined, 'the route (it depends on the changed zone; routes are always re-run) is resolved again');
  assert.equal(part(warm, 'west').cached, undefined, 'the changed zone is resolved again');
  const strip = (r) => JSON.stringify(r.check.parts.map(({ cached, ...a }) => a));
  assert.equal(strip(warm), strip(cold), 'answers equal to a cold check');
  assert.equal(warm.artifactSha, cold.artifactSha, 'the same artifact');
});

// ------------------------------------------------------------------ 9

test('item 9: the catalogue golden; every supported entry has a valid/ fixture that fits, every reserved one an extension/ fixture', async () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden, 'the catalogue equals the committed golden (regenerate it with the release)');
  const entries = PLAN_SCHEMA['x-catalogue'].entries;
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'block ids are unique');
  const covered = new Set(read('valid').flatMap((f) => f.covers ?? []));
  // (7a K1) the foundation's placeholders: k1-pending-a.json (K1a's ids) and k1-pending-b.json (K1b's) list the ids whose valid/
  // fixtures land with that half; each half deletes its own file when they do (so the two never touch the same line)
  // (6c T3) likewise t3-pending-a.json (T3a's bridge ids) and t3-pending-b.json (T3b's tunnel ids, and its `reserved` tunnel.under,
  // which only the compiler answers: T3b's fixtures cover it)
  const reservedPending = new Set();
  // (6c H) and h-pending-a.json (H-a's water bodies) and h-pending-b.json (H-b's quay)
  for (const f of ['k1-pending-a.json', 'k1-pending-b.json', 't3-pending-a.json', 't3-pending-b.json', 'h-pending-a.json', 'h-pending-b.json', 'hy-pending-b.json', 'hy-pending-c.json']) if (fs.existsSync(path.join(FIX, f))) {
    const j = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    for (const id of j.ids) covered.add(id);
    for (const id of j.reserved ?? []) reservedPending.add(id);
  }
  for (const e of entries.filter((x) => x.state === 'supported')) assert.ok(covered.has(e.id), `supported ${e.id} has a valid/ fixture`);
  const ext = new Set([...read('extension').flatMap((f) => (f.expect.all ?? [f.expect]).map((x) => x.block)).filter(Boolean), ...reservedPending]);
  // (D1) an alias whose target is supported follows its target (zone kind district: its program decides), so it has no extension fixture
  const supportedIds = new Set(entries.filter((x) => x.state === 'supported').map((x) => x.id));
  for (const e of entries.filter((x) => x.state === 'reserved' && !(x.aliasOf && supportedIds.has(x.aliasOf)))) assert.ok(ext.has(e.aliasOf ?? e.id), `reserved ${e.id} has an extension/ fixture`);
});

test('item 9: the catalogue diff (D1 flips program.districts and endpoint.region; K1 flips the four connectors) and a pending part flagged for a recheck', () => {
  // (D1) P0's golden is archived as fixtures/plan/catalogue-p0.json; P0's committed catalogue-next.json is what D1 ships
  const p0 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-p0.json'), 'utf8'));
  // (6c T3) K1's golden (catalogue 5) is archived as fixtures/plan/catalogue-k1.json: the K1 expectations below read it
  const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-k1.json'), 'utf8'));
  const next = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-next.json'), 'utf8'));
  // (D2) D2's golden adds D2's four flips (zone.outpost, locator.along, feature.biome_edge, feature.ridge) over D1's, archived as
  // fixtures/plan/catalogue-d1.json; (7a K1) D2's golden is archived as fixtures/plan/catalogue-d2.json
  const d1 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-d1.json'), 'utf8'));
  const d2g = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-d2.json'), 'utf8'));
  const d2 = diffCatalogues(d1, d2g);
  assert.deepEqual(d2.reservedToSupported.sort(), ['feature.biome_edge', 'feature.ridge', 'locator.along', 'zone.outpost']);
  assert.deepEqual([d2.added, d2.removed, d2.retired, d2.otherStateChanges], [[], [], [], []]);
  // (7a K1, item 8) D2 to K1: exactly the four flips, the five added ids and locator.around's new note; the recorded pending
  // connector.wall part flagged to recheck
  const pending = JSON.parse(fs.readFileSync(path.join(FIX, 'pending-two-districts.json'), 'utf8'));
  // (C37 shipped between D2 and K1: its catalogue, v0.33.0's, is archived as fixtures/plan/catalogue-c37.json and K1 diffs from it;
  // the catalogueVersion is the coordinator's to renumber at merge)
  const c37 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-c37.json'), 'utf8'));
  const k1 = diffCatalogues(c37, golden, { pending });
  assert.deepEqual(diffCatalogues(d2g, c37).reservedToSupported, [], 'C37 flipped nothing');
  assert.deepEqual(k1.reservedToSupported, ['connector.auto', 'connector.gate', 'connector.rope_bridge', 'connector.wall']);
  assert.deepEqual(k1.added, [{ id: 'layout.elevated', state: 'reserved' }, { id: 'wall.along', state: 'reserved' }, { id: 'wall.around', state: 'supported' }, { id: 'wall.edge', state: 'supported' }, { id: 'wall.line', state: 'supported' }]);
  assert.deepEqual([k1.removed, k1.retired, k1.otherStateChanges, k1.untilChanged], [[], [], [], []]);
  // C37 -> K1 (K1a's base): only locator.around's note moved
  assert.deepEqual(k1.notesChanged.map((x) => x.id), ['locator.around']);
  // D2 -> K1 (K1b's base): C37 (v0.33.0, merged under K1) adds its street orientation notes on program.flat_village, program.lots
  // and layout.street
  assert.deepEqual(diffCatalogues(d2g, golden).notesChanged.map((x) => x.id).sort(), ['layout.street', 'locator.around', 'program.flat_village', 'program.lots']);
  assert.deepEqual(k1.recheck, [{ part: 'wall', block: 'connector.wall' }]);
  for (const [to, what, flips] of [[next, 'catalogue-next.json', ['endpoint.region', 'program.districts']], [d1, 'the D1 golden', ['endpoint.region', 'program.districts']]]) {
    const d = diffCatalogues(p0, to, { pending: [{ part: 'craftsmen_district', block: 'program.districts' }, { part: 'wall', block: 'connector.wall' }] });
    assert.deepEqual(d.reservedToSupported, flips, what);
    assert.deepEqual(d.added, [], what);
    assert.deepEqual(d.removed, [], what);
    assert.deepEqual(d.retired, [], what);
    assert.deepEqual(d.otherStateChanges, [], what);
    assert.deepEqual(d.recheck, [{ part: 'craftsmen_district', block: 'program.districts' }], what);
  }
  // the golden D1 shipped is catalogue-next.json, entry for entry (its api and kit versions aside)
  assert.deepEqual(d1.entries, next.entries);
  assert.equal(d1.catalogueVersion, next.catalogueVersion);
});

// ------------------------------------------------------------------ 11

// (item 11, Steward's 59 recorded plans: plan-p0-asks.test.mjs)

test('C36: body.lots[] carries role, label, ext (as given), front and entrance in one hop', async () => {
  const plan = { schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: [
    { id: 'h1', type: 'house', role: 'home', label: 'Ada\'s house', size: [9, 9], ext: { 'st:tag': 7 } },
    { id: 'h2', type: 'house', size: [9, 9] }] } }] };
  const r = await asks(plan);
  assert.ok(r.artifact, 'an artifact');
  const l1 = r.artifact.lots.find((l) => l.id === 'h1'), l2 = r.artifact.lots.find((l) => l.id === 'h2');
  assert.equal(l1.role, 'home');
  assert.equal(l1.label, "Ada's house");
  assert.deepEqual(l1.ext, { 'st:tag': 7 });
  assert.equal(l2.role, null); assert.equal(l2.label, null); assert.equal(l2.ext, null);
  for (const l of [l1, l2]) {
    assert.ok(Array.isArray(l.entrance) && l.entrance.length === 3, `${l.id} entrance`);
    assert.ok(l.front !== null && l.front !== undefined, `${l.id} front`);
    const g = r.artifact.parts.find((x) => x.part === 'town').geometry.lots.find((x) => x.id === l.id);
    assert.deepEqual(l.entrance, g.entrance); assert.deepEqual(l.front, g.front);
  }
});
