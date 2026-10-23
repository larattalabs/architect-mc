// (6c FL) Slice FL's kit items (docs/CONTRACT.md "Phase 6c slice FL" §10): item 1's broken variants, item 2 (the fl/ answers with their
// wouldFits re-checked alone), item 3 (KC: the zone placed after the body keeps clear; the backstop refuses the zone, never the body),
// item 5 (catalogue 10), item 8 (Steward's recorded plans: the five free zones), item 9 (Steward's plan v1 shape), the street ext
// (S-FL-5) and the geometry (§6). The layouts' invariants on seeded claims are fl-layouts-1/2.test.mjs; items 4 (byte identity) and
// 10-12 run in tools/gate6cfl.mjs unit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, checkPlanLocal, stewardAnchors } from './plan-helpers.mjs';
import { read, run, svOf, part, A } from './plan-p0-shared.mjs';
import { checkRegion } from '../lib/region/check.mjs';
import { clearRefusals } from '../lib/region/checkFluids.mjs';
import { planCatalogue, diffCatalogues } from '../lib/plan/catalogue.mjs';

const fl = read('fl');
const byName = (n) => fl.find((f) => f.name.startsWith(n));
const checkOf = (f, r) => checkRegion({ ir: r.res.ir, survey: svOf(f).bytes, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta });
/** A plan with one part replaced by `part` merged with a wouldFit's fragment. */
const withFragment = (plan, w) => {
  const p = JSON.parse(JSON.stringify(plan));
  for (const k of ['zones', 'forms', 'connectors']) p[k] = (p[k] ?? []).map((q) => (q.id === w.part ? { ...q, ...w.fragment } : q));
  return p;
};

// ------------------------------------------------------------------ item 2: the fl/ answers, wouldFits re-checked alone

test('item 2: every fl/ fixture answers its code; each wouldFit is re-checked alone (the plan with only that fragment applied: the part fits or is adjusted)', async () => {
  const want = fl.filter((f) => f.expect?.part);
  assert.ok(want.length >= 9, `${want.length} fl/ answer fixtures`);
  for (const f of want) {
    const r = await run(f);
    const a = part(r, f.expect.part);
    assert.equal(a.class, f.expect.class, `${f.name}: ${a.class} ${JSON.stringify(a.reasons ?? a.deviations)}`);
    if (f.expect.code) assert.equal(a.reasons[0].code, f.expect.code, `${f.name}: ${JSON.stringify(a.reasons)}`);
    if (f.expect.what) assert.ok(a.deviations.some((d) => d.what === f.expect.what), `${f.name}: deviation ${f.expect.what}`);
    if (f.expect.why) assert.equal(a.reasons[0].evidence.why, f.expect.why, f.name);
    if (f.expect.sites) assert.equal(a.geometry.sites.length, f.expect.sites, `${f.name}: sites`);
    for (const w of a.wouldFit ?? []) {
      assert.ok(w.rechecked === 'fits' || w.rechecked === 'adjusted', `${f.name}: the compiler re-checked its wouldFit (${w.rechecked})`);
      const again = await run({ ...f, plan: withFragment(f.plan, w) });
      const b = part(again, w.part);
      assert.ok(['fits', 'adjusted'].includes(b.class), `${f.name}: its wouldFit alone answers ${b.class} ${JSON.stringify(b.reasons)}`);
    }
    if (['r01', 'r03', 'r04', 'r06'].some((p) => f.name.startsWith(p))) assert.ok((a.wouldFit ?? []).length >= 1, `${f.name}: a wouldFit`);
  }
});

test('item 2: forms around a feature: 6 rock spires round a zone, evenly by angle (f01)', async () => {
  const f = byName('f01');
  const r = await run(f);
  const a = part(r, 'spires'), keep = part(r, 'keep');
  assert.equal(a.class, 'fits');
  const c = [(keep.geometry.rect[0] + keep.geometry.rect[2]) / 2, (keep.geometry.rect[1] + keep.geometry.rect[3]) / 2];
  const ang = a.geometry.sites.map(([x, z]) => (Math.atan2(z - c[1], x - c[0]) * 180) / Math.PI).sort((p, q) => p - q);
  const gaps = ang.map((v, i) => (i ? v - ang[i - 1] : v + 360 - ang[ang.length - 1]));
  for (const g of gaps) assert.ok(g > 40 && g < 80, `even by angle: gaps ${gaps.map((x) => x.toFixed(0)).join(', ')}`);
});

// ------------------------------------------------------------------ item 1: the broken variants

test('item 1: the broken variants are caught: lotOnStreet (M1), laneThroughLot (the emit refuses), zoneIgnoresBody (M25:clear names the zone; the backstop refuses the zone, never the body)', async () => {
  const u1 = byName('u01'), u2 = byName('u02'), u3 = byName('u03');
  const r1 = await run(u1);
  const m1 = checkOf(u1, r1).findings.filter((x) => x.rule === 'M1');
  assert.ok(m1.some((x) => /road street_ring/.test(x.message) && /lot box/.test(x.message)), `M1 on the ring street: ${JSON.stringify(m1.map((x) => x.message))}`);
  const r2 = await run(u2);
  assert.equal(part(r2, 'ring').class, 'refused');
  assert.match(part(r2, 'ring').reasons[0].message, /lane lane_\w+ enters lot/);
  const r3 = await run(u3);
  const rep = checkOf(u3, r3);
  const clear = rep.findings.filter((x) => x.rule === 'M25:clear');
  assert.ok(clear.length && clear.every((x) => /\(plan part shore\)/.test(x.message)), `M25:clear names the zone: ${JSON.stringify(clear.map((x) => x.message))}`);
  // the backstop over those findings (clearScan's shape: the writer's plan part, the body's), the variant's flag aside: the zone (it
  // depends on the pond) is refused, never the pond
  const plan = JSON.parse(JSON.stringify(u3.plan));
  delete plan.zones[0].ext;
  const raw = clear.map((x) => ({ body: 'w_pond', part: 'pond', set: /of its shell/.test(x.message) ? 'shell' : 'cells', writer: x.part, writerPart: 'shore', why: "a zone's street", cells: x.sample ?? [], count: x.count }));
  const out = clearRefusals({ findings: raw, plan });
  assert.deepEqual(Object.keys(out), ['shore']);
  assert.equal(out.shore.code, 'OVERLAP');
  assert.equal(out.shore.evidence.kind, 'body');
  assert.equal(out.shore.evidence.part, 'pond');
});

// ------------------------------------------------------------------ item 3: KC

test('item 3: KC: a zone around a pond (v67) and around a fountain (r03): 0 M25:clear, the body\'s census unchanged by the zone', async () => {
  const v67 = read('valid').find((f) => f.name.startsWith('v67'));
  const r = await run(v67);
  assert.equal(r.check.overall, 'READY');
  assert.equal(checkOf(v67, r).findings.filter((x) => x.rule === 'M25:clear').length, 0);
  // the pond alone, then with the zone: the same body census (cells, shell, spill, ice, level, settle; the plan's seed places it, so
  // its rect may differ between the two plans)
  const alone = await run({ ...v67, plan: { ...v67.plan, zones: [] } });
  const body = (q) => { const g = q.check.parts.find((a) => a.part === 'pond').geometry; return JSON.stringify({ level: g.level, depth: g.depth, bodies: g.bodies, w: g.rect[2] - g.rect[0], d: g.rect[3] - g.rect[1] }); };
  assert.equal(body(r), body(alone), 'the pond\'s census is the same with the zone round it');
  const r03 = byName('r03');
  const q = await run(r03);
  assert.equal(part(q, 'fount').class, 'fits', 'the fountain keeps its place (the zone is the later part)');
  assert.equal(checkOf(r03, q).findings.filter((x) => x.rule === 'M25:clear').length, 0);
});

// ------------------------------------------------------------------ item 5: catalogue 10

test('item 5: the golden equals catalogue 11 (the batch: FL and F3); its diff from catalogue-vocc.json (9), F3\'s entries aside, is exactly the six flips (locator.around\'s note kept and extended); no until FL left', () => {
  assert.deepEqual(planCatalogue(), JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8')));
  // ((7a foundation) catalogue 11 as v0.41.0 shipped it is archived as catalogue-pre7a.json; 7a's changes are its own tests')
  const golden = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-pre7a.json'), 'utf8'));
  assert.equal(golden.catalogueVersion, 11); // ((batch v0.41.0) FL's 10 and F3's 11 together: 11)
  const nine = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-vocc.json'), 'utf8'));
  const d = diffCatalogues(nine, golden, { pending: [{ part: 'grove', block: 'layout.ring' }] });
  const six = ['layout.grid', 'layout.organic', 'layout.ring', 'layout.spiral', 'locator.around', 'sketch.outline'];
  // ((batch v0.41.0) F3's flip, its four added forms and the tunnel's volume flag are forms-f3.test.mjs item 9's)
  const fl = (xs) => xs.filter((x) => { const id = x.id ?? x; return !/^form\./.test(id) && id !== 'connector.tunnel'; });
  assert.deepEqual(fl(d.reservedToSupported), six);
  assert.deepEqual(fl(d.schemaVersionBumps).map((x) => x.id).sort(), six);
  assert.deepEqual([fl(d.added), d.removed, d.retired, d.otherStateChanges, d.untilChanged, fl(d.limitsChanged)], [[], [], [], [], [], []]);
  assert.deepEqual(d.notesChanged.map((x) => x.id), ['locator.around']);
  assert.match(golden.entries.find((e) => e.id === 'locator.around').note, /^On a wall: wall\.around.*Zones: a ring street round the feature; forms: sites in the band\./);
  assert.deepEqual(d.recheck, [{ part: 'grove', block: 'layout.ring' }]);
  for (const id of six) { const e = golden.entries.find((x) => x.id === id); assert.equal(e.state, 'supported'); assert.ok(e.sinceApi === 'NEXT' || e.sinceApi === golden.api, `${id}: sinceApi ${e.sinceApi}`); assert.equal(e.schemaVersion, 1); assert.ok(e.note, id); }
  // no until FL anywhere in the kit's schemas and code (the archived catalogues aside)
  const scan = [path.join(ROOT, 'kit', 'schemas'), path.join(ROOT, 'kit', 'lib')];
  const files = scan.flatMap((d0) => fs.readdirSync(d0, { recursive: true }).map((f) => path.join(d0, f)).filter((f) => /\.(json|mjs)$/.test(f)));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /"until"\s*:\s*"FL\b|until:\s*'FL\b/, f);
});

// ------------------------------------------------------------------ item 8: Steward's recorded plans

test('item 8 (§9): the five free zones of the asks answer; none malformed; no layout.* left in the gap table', async () => {
  const anchors = stewardAnchors(A.claim);
  const asks = read('asks');
  const gaps = {};
  for (const f of asks) {
    const r = await checkPlanLocal(f.answer.plan, { survey: A.bytes, claim: A.claim, anchors });
    assert.notEqual(r.check.overall, 'MALFORMED', f.name);
    for (const a of r.check.parts) { assert.notEqual(a.class, 'malformed', f.name); if (a.class === 'unsupported') gaps[a.block] = (gaps[a.block] ?? 0) + 1; }
    const want = { 'around_my_tree.json': ['grove', 'fits', 'READY'], 'nomad_camp.json': ['camp', 'fits', 'READY'], 'grid_city.json': ['grid_city', 'fits', 'READY'], 'organic_hamlet.json': ['hamlet', 'fits', 'READY'],
      // (measured: the plan's explicit dependency on crater_lake, form.crater reserved until 7c, holds the ring; §9 predicted fits or adjusted)
      'ring_city.json': ['ring_town', 'blocked', 'REQUIRED_BLOCKED'] }[f.name];
    if (!want) continue;
    assert.equal(part(r, want[0]).class, want[1], `${f.name} ${want[0]}: ${part(r, want[0]).class} ${JSON.stringify(part(r, want[0]).reasons)}`);
    assert.equal(r.check.overall, want[2], f.name);
    if (want[1] === 'fits') assert.ok(part(r, want[0]).geometry.layout, `${f.name}: a free layout's geometry`);
  }
  for (const k of Object.keys(gaps)) assert.ok(!['layout.ring', 'layout.grid', 'layout.organic', 'layout.spiral', 'locator.around', 'sketch.outline'].includes(k), `gap table still lists ${k}`);
});

// ------------------------------------------------------------------ item 9: Steward's plan v1 shape

test('item 9: a ring zone re-checked as Steward\'s Start does (pending parts required false, orientation ew, rotate off, lot ext): the same answer with the orientation note; a grid\'s avenues east-west', async () => {
  const v66 = read('valid').find((f) => f.name.startsWith('v66'));
  const base = await run(v66);
  const p = JSON.parse(JSON.stringify(v66.plan));
  const z = p.zones[0];
  z.required = false;
  z.program.orientation = 'ew';
  z.tolerance = { rotate: { allowed: false, hard: true } };
  z.program.lots = z.program.lots.map((l) => ({ ...l, ext: { 'steward_mc:lot': l.id } }));
  const again = await run({ ...v66, plan: p });
  const a = part(again, 'camp'), b = part(base, 'camp');
  assert.equal(a.class, b.class);
  assert.deepEqual(a.geometry.lots.map((l) => [l.id, l.box, l.front]), b.geometry.lots.map((l) => [l.id, l.box, l.front]));
  assert.ok((a.notes ?? []).includes('orientation not read by layout ring'), JSON.stringify(a.notes));
  const v68 = read('valid').find((f) => f.name.startsWith('v68'));
  const g = JSON.parse(JSON.stringify(v68.plan));
  g.zones[0].program.orientation = 'ew';
  const rg = await run({ ...v68, plan: g });
  const cg = part(rg, 'city');
  assert.equal(cg.geometry.orientation, 'ew');
  for (const l of cg.geometry.lots) assert.ok(['north', 'south'].includes(l.front), `${l.id} faces ${l.front} on an east-west avenue`);
});

// ------------------------------------------------------------------ S-FL-5 and §6

test('S-FL-5: every street road a plan region writes carries architect_mc:street {zone, district?}: V, D1, D2 and FL; the routes between them none', async () => {
  const want = { v01: [['street_w', { zone: 'town' }], ['street_e', { zone: 'town' }]], v18: [['market_street_w', { zone: 'quarters', district: 'market' }], ['homes_street', { zone: 'quarters', district: 'homes' }], ['route_d_market__homes_1', null]],
    v20: [['route_st_quay_1', { zone: 'quay', district: 'quay' }]], v66: [['street_ring', { zone: 'camp' }], ['street_ring_b', { zone: 'camp' }]], v68: [['street_a1', { zone: 'city' }], ['street_c1', { zone: 'city' }]] };
  for (const [n, rows] of Object.entries(want)) {
    const f = read('valid').find((x) => x.name.startsWith(n));
    const r = await run(f);
    for (const [id, ext] of rows) {
      const rd = r.res.ir.roads.find((x) => x.id === id || x.id.startsWith(`${id}_`));
      assert.ok(rd, `${n}: road ${id}`);
      assert.deepEqual(rd.ext?.['architect_mc:street'] ?? null, ext, `${n} ${id}`);
    }
    // a connector's route is never marked
    for (const rd of r.res.ir.roads) if (rd.id.startsWith('route_c')) assert.equal(rd.ext, undefined, `${n} ${rd.id}`);
  }
});

test('§6: a free zone\'s geometry adds layout, streets, hub (and around/outline: mask); a street zone\'s keeps V\'s members only', async () => {
  const v = read('valid');
  const g66 = part(await run(v.find((f) => f.name.startsWith('v66'))), 'camp').geometry;
  assert.equal(g66.layout, 'ring');
  assert.deepEqual(g66.streets.map((s) => [s.name, s.closed]), [['street_ring', true]]);
  assert.ok(g66.hub.rect && g66.hub.centre);
  assert.equal(g66.mask, undefined);
  assert.ok(new Set(g66.lots.map((l) => l.front)).size === 4, 'a ring mixes all four fronts');
  const g67 = part(await run(v.find((f) => f.name.startsWith('v67'))), 'shore').geometry;
  assert.ok(Array.isArray(g67.mask) && g67.mask.length > 10);
  const g01 = part(await run(v.find((f) => f.name.startsWith('v01'))), 'town').geometry;
  for (const k of ['layout', 'streets', 'hub', 'mask']) assert.equal(g01[k], undefined, `a street zone has no ${k}`);
});

// ------------------------------------------------------------------ item 1: the masks

test('item 1: the masks: a polygon is the cells whose centre lies inside it; a polyline outline keeps the land near its line; around\'s mask leaves the feature out', async () => {
  const { polygonCells, sketchCells } = await import('../lib/region/layouts/outline.mjs');
  // a 10 x 6 rectangle drawn on cell corners holds exactly its 60 cells; a right triangle half of a 10 x 10 square holds 45 (the diagonal's
  // centres on the inside count half: (x + 0.5) + (z + 0.5) < 10)
  assert.equal(polygonCells([[0, 0], [10, 0], [10, 6], [0, 6]]).length, 60);
  assert.equal(polygonCells([[0, 0], [10, 0], [0, 10]]).length, 45);
  const claim = { minX: 100, minZ: 200, maxX: 163, maxZ: 263 };
  assert.deepEqual(sketchCells(claim, { frame: 'claim', unit: 'q64', points: [[0, 0], [32, 64]] }, new Map()), [[100, 200], [132, 264]]);
  assert.deepEqual(sketchCells(claim, { frame: 'anchor', anchor: 'a', unit: 'block', points: [[-3, 4]] }, new Map([['a', [140, 230]]])), [[137, 234]]);
  // v71's polyline zone: every lot within the deepest lot + setback + 2 (+ the push) of its line
  const v71 = read('valid').find((f) => f.name.startsWith('v71'));
  const r = await run(v71);
  const g = part(r, 'lane').geometry;
  assert.ok(g.mask.length > 0 && g.streets[0].name === 'street_line');
  // v67: the annulus' mask holds no cell of the pond's rect
  const v67 = read('valid').find((f) => f.name.startsWith('v67'));
  const q = await run(v67);
  const pond = part(q, 'pond').geometry.rect, m = part(q, 'shore').geometry.mask;
  for (const [x0, z, x1] of m) assert.ok(z < pond[1] || z > pond[3] || x1 < pond[0] || x0 > pond[2], `mask row ${x0}..${x1} at ${z} meets the pond ${pond}`);
});
