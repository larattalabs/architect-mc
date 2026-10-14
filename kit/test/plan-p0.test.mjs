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
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asksSurvey, goldenSurvey, stewardAnchors, checkPlanLocal, memoryCache, flatSurvey, FIX, ROOT } from './plan-helpers.mjs';
import { validatePlan, PLAN_SCHEMA } from '../lib/plan/schema.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';

// ((7a K1b) `flat`: a flat claim in rift_city's range, for the rope bridge fixtures; a fixture's `anchors` add to Steward's)
const SV = { s7: goldenSurvey('s7'), s3: goldenSurvey('s3'), asks: asksSurvey(), flat: flatSurvey() };
const read = (dir) => fs.readdirSync(path.join(FIX, dir)).filter((f) => f.endsWith('.json') && f !== 'SOURCE.json').sort().map((f) => ({ name: f, ...JSON.parse(fs.readFileSync(path.join(FIX, dir, f), 'utf8')) }));
const run = (fx, extra = {}) => { const s = SV[fx.on]; return checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}), ...extra }); };
const lots = (n, p = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: 'house', size: [9, 9] }));
const A = SV.asks;
const asks = (plan, o = {}) => checkPlanLocal(plan, { survey: A.bytes, claim: A.claim, anchors: stewardAnchors(A.claim), ...o });
const part = (r, id) => r.check.parts.find((a) => a.part === id);

// ------------------------------------------------------------------ 1

test('item 1: valid/ fixtures (at least 12) validate and every part fits', async () => {
  const fx = read('valid');
  assert.ok(fx.length >= 12, `${fx.length} valid fixtures`);
  for (const f of fx) {
    const v = validatePlan(f.plan, { anchors: Object.keys({ ...stewardAnchors(SV[f.on].claim), ...(f.anchors ?? {}) }) });
    assert.equal(v.malformed, null, `${f.name}: ${JSON.stringify(v.malformed)}`);
    for (const p of v.parts) assert.equal(p.verdict, 'compile', `${f.name} ${p.id}: ${p.verdict} ${JSON.stringify(p.reason)}`);
    const r = await run(f);
    assert.equal(r.check.overall, 'READY', `${f.name}: ${r.check.overall}`);
    for (const a of r.check.parts) assert.equal(a.class, 'fits', `${f.name} ${a.part}: ${a.class} ${JSON.stringify(a.reasons ?? a.deviations)}`);
    assert.match(r.artifactSha, /^[0-9a-f]{64}$/);
  }
});

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

const GROVE = [{ id: 'grove', rect: [130, 130, 190, 190] }];
const NEAR_CENTRE = (tol) => ({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 0 } }, ...(tol ? { tolerance: tol } : {}) }],
  connectors: [{ id: 'up', kind: 'path', from: { part: 'town' }, to: { anchor: 'claim_n' } }] });

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

test('item 3: three checks of each crafted plan give identical answers and artifact shas; 1 and 4 tile workers give equal tile shas', async () => {
  const { tileShas } = await import('../../tools/scenarios.mjs');
  const perClass = [NEAR_CENTRE(), NEAR_CENTRE({ move: { max: 2, hard: true } }), WALLED].map((plan, i) => ({ name: `per-class ${i}`, on: 'asks', plan, protected: i < 2 ? GROVE : WALL }));
  for (const f of [...read('valid'), ...perClass]) {
    const rs = [await run(f), await run(f), await run(f)];
    const j = rs.map((r) => JSON.stringify(r.check));
    assert.equal(j[1], j[0], `${f.name}: answers`);
    assert.equal(j[2], j[0], `${f.name}: answers`);
    assert.ok(rs.every((r) => r.artifactSha === rs[0].artifactSha), `${f.name}: artifact sha`);
    if (!rs[0].artifact) continue;
    // the artifact's tile shas are the plan's own tiles (as scenario goldens compute them), 1 worker = 4 workers
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-det-'));
    try {
      fs.writeFileSync(path.join(dir, 'ir.json'), rs[0].res.irJson);
      fs.writeFileSync(path.join(dir, 'survey.bin'), SV[f.on].bytes);
      fs.mkdirSync(path.join(dir, 'blobs'));
      for (const [sha, b] of rs[0].res.blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
      const ts = await tileShas(dir);
      assert.ok(ts.workersSame, `${f.name}: 1 worker = 4 workers`);
      const art = rs[0].artifact.region.tiles;
      for (const [k, sha] of Object.entries(ts.tiles)) { const [stage, set, key] = k.split('|'); assert.equal(art[stage][set][key], sha, `${f.name} ${k}`); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ------------------------------------------------------------------ 7

const WALL = [{ id: 'wall', rect: [150, 60, 170, 260] }];
const WALLED = { schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: lots(3) }, where: { near: { anchor: 'claim_w', within: 8 } } }],
  connectors: [{ id: 'long', kind: 'road', from: { part: 'town' }, to: { anchor: 'claim_e' } }] };

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
  for (const f of ['k1-pending-a.json', 'k1-pending-b.json']) if (fs.existsSync(path.join(FIX, f))) for (const id of JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')).ids) covered.add(id);
  for (const e of entries.filter((x) => x.state === 'supported')) assert.ok(covered.has(e.id), `supported ${e.id} has a valid/ fixture`);
  const ext = new Set(read('extension').flatMap((f) => (f.expect.all ?? [f.expect]).map((x) => x.block)).filter(Boolean));
  // (D1) an alias whose target is supported follows its target (zone kind district: its program decides), so it has no extension fixture
  const supportedIds = new Set(entries.filter((x) => x.state === 'supported').map((x) => x.id));
  for (const e of entries.filter((x) => x.state === 'reserved' && !(x.aliasOf && supportedIds.has(x.aliasOf)))) assert.ok(ext.has(e.aliasOf ?? e.id), `reserved ${e.id} has an extension/ fixture`);
});

test('item 9: the catalogue diff (D1 flips program.districts and endpoint.region; K1 flips the four connectors) and a pending part flagged for a recheck', () => {
  // (D1) P0's golden is archived as fixtures/plan/catalogue-p0.json; P0's committed catalogue-next.json is what D1 ships
  const p0 = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-p0.json'), 'utf8'));
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
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
  const k1 = diffCatalogues(d2g, golden, { pending });
  assert.equal(golden.catalogueVersion, 4);
  assert.deepEqual(k1.reservedToSupported, ['connector.auto', 'connector.gate', 'connector.rope_bridge', 'connector.wall']);
  assert.deepEqual(k1.added, [{ id: 'layout.elevated', state: 'reserved' }, { id: 'wall.along', state: 'reserved' }, { id: 'wall.around', state: 'supported' }, { id: 'wall.edge', state: 'supported' }, { id: 'wall.line', state: 'supported' }]);
  assert.deepEqual([k1.removed, k1.retired, k1.otherStateChanges, k1.untilChanged], [[], [], [], []]);
  // (C37, v0.33.0, merged under K1: its street orientation notes on program.flat_village, program.lots and layout.street)
  assert.deepEqual(k1.notesChanged.map((x) => x.id).sort(), ['layout.street', 'locator.around', 'program.flat_village', 'program.lots']);
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

test('item 11: Steward\'s 59 recorded plans (whole files, fixtures/plan/asks): no crash, none malformed, answer.waits unsupported or blocked; the gap table', async () => {
  const fx = read('asks');
  assert.equal(fx.length, 59);
  // (7a K1, item 15) the oracle skips a part whose block the current catalogue supports (it was recorded waiting on it); K1's
  // recorded parts table judges those (kit/test/plan-k1.test.mjs)
  const supported = new Set(PLAN_SCHEMA['x-catalogue'].entries.filter((e) => e.state === 'supported').map((e) => e.id));
  const tally = {}, gaps = {}, other = [];
  const anchors = stewardAnchors(A.claim);
  for (const f of fx) {
    const r = await checkPlanLocal(f.answer.plan, { survey: A.bytes, claim: A.claim, anchors });
    assert.notEqual(r.check.overall, 'MALFORMED', f.name);
    const waits = new Set((f.answer.waits ?? []).map((w) => w.part));
    for (const a of r.check.parts) {
      tally[a.class] = (tally[a.class] ?? 0) + 1;
      if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1;
      assert.notEqual(a.class, 'malformed', `${f.name} ${a.part}: ${JSON.stringify(a.reasons)}`);
      if (waits.has(a.part) && !supported.has(a.block)) assert.ok(['unsupported', 'blocked'].includes(a.class), `${f.name} ${a.part} waits but ${a.class}`);
      else if (!['fits', 'adjusted'].includes(a.class)) other.push(`${f.name.replace('.json', '')}/${a.part}: ${a.class} ${a.reasons?.[0]?.code ?? ''}`);
    }
  }
  const rows = Object.entries(gaps).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  console.log(`# 59 asks: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('# gap table (unsupported parts per block id):');
  for (const [k, v] of rows) console.log(`#   ${k.padEnd(24)} ${v}`);
  console.log(`# parts outside answer.waits that did not fit (${other.length}): ${other.join('; ')}`);
  assert.ok(tally.unsupported > 0 && tally.fits > 0);
});

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
