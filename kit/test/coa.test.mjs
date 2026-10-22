// (6c close-out A) The kit items (docs/CONTRACT.md "Phase 6c close-out A" §4, §5, §7, §9; §11 items 4, 5, 7, 9): a route ending on a
// piece its zone could not place answers blocked; rule.palette's `over` and `exempt: ways | forms`; ponds choose a lot-clear site;
// district routes keep out of protected areas, other regions and builds. Fixtures in fixtures/plan/coa/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX, ROOT, asksSurvey, checkPlanVolumes, fixtureLotBlocks, fixtureStyle, flatSurvey, stewardAnchors } from './plan-helpers.mjs';
import { validatePlan } from '../lib/plan/schema.mjs';
import { diffCatalogues, planCatalogue, PLAN_API } from '../lib/plan/catalogue.mjs';
import { irPartWriter, readPaletteRule, shareFits } from '../lib/plan/palette.mjs';

const A = asksSurvey();
const readJ = (...p) => ({ name: p.join('/'), ...JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8')) });
/** A fixture checked as the gates check it (its claim, Steward's anchors and its own, its protected areas, the two-plan flow). */
async function run(fx, { plan = fx.plan ?? fx.answer?.plan, lotDesigns = fx.lotDesigns, ...o } = {}) {
  const s = fx.terrain ? flatSurvey(fx.terrain) : fx.on === 'asks' ? A : flatSurvey();
  const lb = await fixtureLotBlocks({ lotDesigns });
  const style = fixtureStyle(fx);
  return checkPlanVolumes(plan, { survey: s.bytes, claim: s.claim, anchors: { ...stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], regions: fx.regions ?? [], builds: fx.builds ?? [], volume: fx.volume ?? {}, ...(style ? { style } : {}), ...(lb ? { lotBlocks: lb } : {}), ...o });
}
const part = (r, id) => r.check.parts.find((a) => a.part === id);
const irOf = (r) => JSON.parse(r.res.irJson);
const meets = (x, z, q, g = 0) => x >= q[0] - g && x <= q[2] + g && z >= q[1] - g && z <= q[3] + g;
/** The cells along a road's polyline (each segment stepped cell by cell). */
function roadCells(road) {
  const out = [];
  for (let i = 1; i < road.points.length; i++) {
    const [a, b] = [road.points[i - 1], road.points[i]];
    const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[2] - a[2]), 1);
    for (let k = 0; k <= n; k++) out.push([Math.round(a[0] + ((b[0] - a[0]) * k) / n), Math.round(a[2] + ((b[2] - a[2]) * k) / n)]);
  }
  return out;
}

// ------------------------------------------------------------------ §9 (item 9): district routes keep out

test('§9: a protected rect across a plain district\'s link: the districts zone\'s routes keep out of it (main routed through it)', async () => {
  const fx = readJ('coa', 'd01_protected_route.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const q = part(r, 'quarters');
  assert.equal(q.class, 'fits');
  assert.ok(q.geometry.edges.every((e) => e.ok), 'every district link routed');
  const orchard = fx.protected[0].rect;
  const links = irOf(r).roads.filter((x) => x.part === 'routes_quarters');
  assert.ok(links.length >= 2, 'the links are written');
  for (const road of links) for (const [x, z] of roadCells(road)) assert.ok(!meets(x, z, orchard, (road.width - 1) >> 1), `${road.id} at ${x} ${z} meets the protected orchard`);
  // the tree goes round it: market joins crafts (main's tree joined market to homes across the orchard)
  assert.deepEqual(q.geometry.edges.map((e) => e.id).sort(), ['d_crafts__homes', 'd_market__crafts']);
});

// ------------------------------------------------------------------ §4 (item 4): a route ending on a piece its zone could not place

/** §4's answer: blocked by the zone, DEPENDENCY with evidence {kind: unplaced, lot | district, zone, blockedBy, classes}. */
function assertUnplaced(r, id, { zone, lot = undefined, district = undefined }) {
  const a = part(r, id);
  assert.equal(a.class, 'blocked', `${id}: ${JSON.stringify(a.reasons)}`);
  assert.deepEqual(a.blockedBy, [zone]);
  assert.equal(a.reasons.length, 1);
  const [why] = a.reasons;
  assert.equal(why.code, 'DEPENDENCY');
  const piece = lot !== undefined ? { lot } : { district };
  assert.equal(why.message, `ends on ${lot !== undefined ? `lot ${lot}` : `district ${district}`}, which zone ${zone} could not place`);
  assert.deepEqual(why.evidence, { kind: 'unplaced', ...piece, zone, blockedBy: [zone], classes: { [zone]: part(r, zone).class } });
  assert.ok(['fits', 'adjusted'].includes(part(r, zone).class), `${zone} is ${part(r, zone).class}: the piece, not the zone, holds the route`);
}

test('§4: a street zone\'s unplaced lot as a lot part and as the zone\'s port: blocked by the zone; a dependant stays blocked by the route', async () => {
  const r = await run(readJ('coa', 'b01_unplaced_street_lot.json'));
  const town = part(r, 'town');
  assert.equal(town.class, 'adjusted');
  assert.ok(town.geometry.unplaced.includes('l8'));
  assertUnplaced(r, 'r_lot', { zone: 'town', lot: 'l8' });
  assertUnplaced(r, 'r_port', { zone: 'town', lot: 'l8' });
  const after = part(r, 'after');
  assert.equal(after.class, 'blocked');
  assert.deepEqual(after.blockedBy, ['r_lot']);
  assert.deepEqual(after.reasons[0].evidence, { blockedBy: ['r_lot'], classes: { r_lot: 'blocked' } });
});

test('§4: a free layout\'s unplaced lot (port), a districts zone\'s unplaced lot (port) and unplaced district (port): blocked by the zone', async () => {
  const r = await run(readJ('coa', 'b02_unplaced_free_districts.json'));
  assert.ok(part(r, 'ring').geometry.unplaced.includes('g40'));
  assert.ok(part(r, 'quarters').geometry.unplaced.includes('huge'));
  assert.ok(part(r, 'quarters').geometry.districts.small.unplaced.includes('q8'));
  assertUnplaced(r, 'r_free', { zone: 'ring', lot: 'g40' });
  assertUnplaced(r, 'r_dlot', { zone: 'quarters', lot: 'q8' });
  assertUnplaced(r, 'r_dist', { zone: 'quarters', district: 'huge' });
  // the answers validate against plan.json's partAnswer (blockedBy, the reason's members)
  for (const id of ['r_free', 'r_dlot', 'r_dist']) assert.deepEqual(Object.keys(part(r, id)).filter((k) => !['part', 'block', 'class', 'required', 'reasons', 'blockedBy'].includes(k)), []);
});

// ------------------------------------------------------------------ §5 (item 5): rule.palette's over and exempt ways | forms

const withRule = (plan, fragment, drop = []) => ({ ...plan, rules: plan.rules.map((x) => { const y = { ...x, ...fragment }; for (const k of drop) delete y[k]; return y; }) });

test('§5: the catalogue is 12 (NEXT); its diff from catalogue 11 (catalogue-b0410.json) is exactly rule.palette\'s bump', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  assert.equal(golden.api, PLAN_API);
  const prev = JSON.parse(fs.readFileSync(path.join(FIX, 'catalogue-b0410.json'), 'utf8'));
  assert.equal(prev.catalogueVersion, 11);
  assert.ok(golden.catalogueVersion > prev.catalogueVersion, `catalogue ${golden.catalogueVersion}`);
  const d = diffCatalogues(prev, golden, { pending: [{ part: 'copper_buildings', block: 'rule.palette' }] });
  assert.deepEqual(d.schemaVersionBumps, [{ id: 'rule.palette', from: 1, to: 2 }]);
  assert.deepEqual(d.limitsChanged, [{ id: 'rule.palette', from: { groups: ['wood'], share: [0, 1], exempt: ['terrain', 'support'], scope: 32 }, to: { groups: ['wood'], share: [0, 1], exempt: ['terrain', 'support', 'ways', 'forms'], over: ['all', 'lots'], scope: 32 } }]);
  assert.deepEqual(d.notesChanged, [{ id: 'rule.palette', from: 'measured over parts and bound lots; required rules are checked again at realise', to: 'measured over parts and bound lots (over: lots: bound lots only); required rules are checked again at realise' }]);
  assert.deepEqual([d.added, d.removed, d.reservedToSupported, d.retired, d.otherStateChanges, d.untilChanged, d.recheck], [[], [], [], [], [], [], []]);
  // nothing else moved: every other entry as catalogue 11 had it
  const rest = (c) => c.entries.filter((e) => e.id !== 'rule.palette');
  assert.deepEqual(rest(golden), rest(prev));
  const e = golden.entries.find((x) => x.id === 'rule.palette');
  assert.ok(e.sinceApi === 'NEXT' || e.sinceApi === PLAN_API, e.sinceApi);
  // vocab/1's compact.palette names over and the two exemptions
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'vocab-1.json'), 'utf8'));
  assert.match(doc.compact.palette, /; over: lots measures the buildings only; exempt ways\/forms leaves the streets and forms out$/);
});

test('§5: the strict def and the lenient reads: over, exempt ways and forms, a string scope "lots" or "all" (never malformed), params.over', () => {
  const v = (r) => validatePlan({ schemaVersion: 'plan/0', zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'house', size: [9, 9] }] } }], rules: [{ id: 'r', kind: 'palette', family: 'copper', ...r }] }).parts.find((p) => p.id === 'r');
  for (const ok of [{ over: 'lots' }, { over: 'all' }, { exempt: ['ways', 'forms', 'terrain', 'support'] }, { scope: 'lots' }, { scope: 'all' }, { scope: ['town'], over: 'lots' }, { params: { over: 'lots' } }, { params: { over: 'most' } }]) assert.equal(v(ok).verdict, 'compile', JSON.stringify(ok));
  for (const bad of [{ over: 'buildings' }, { scope: 'buildings' }, { exempt: ['walls'] }, { scope: 'town' }]) assert.equal(v(bad).verdict, 'malformed', JSON.stringify(bad));
  // the read: the top level, then a string scope (noted), then params; absent: no over member (VOC-c's read, byte for byte)
  assert.deepEqual(readPaletteRule({ family: 'copper' }), { family: 'copper', share: [1, 1], exempt: ['support', 'terrain'], from: { family: 'top', share: 'default', exempt: 'default' }, notes: [] });
  const top = readPaletteRule({ family: 'copper', over: 'lots', scope: 'all', params: { over: 'all' } });
  assert.deepEqual([top.over, top.from.over, top.notes], ['lots', 'top', ['scope "all": not read (over is given)']]);
  const sc = readPaletteRule({ family: 'copper', scope: 'lots', params: { over: 'all' } });
  assert.deepEqual([sc.over, sc.from.over, sc.notes], ['lots', 'scope', ['scope "lots" read as over (the rule binds the whole plan)']]);
  const pr = readPaletteRule({ params: { family: 'copper', over: 'lots', exempt: ['ways'] } });
  assert.deepEqual([pr.over, pr.from.over, pr.exempt, pr.notes], ['lots', 'params', ['ways'], []]);
  assert.deepEqual(readPaletteRule({ family: 'copper', params: { over: 'most' } }).notes, ['params.over: not a valid over, not read']);
  // the writer classes (by the IR part's owner and the owner's block)
  const blocks = { town: 'zone.standard', road1: 'connector.road', wall1: 'connector.wall', br: 'connector.bridge', pond: 'form.pond', oak: 'form.giant_tree' };
  assert.deepEqual([
    irPartWriter({ id: 'routes_0' }, 'routes:road1,br', blocks), irPartWriter({ id: 'links_b0' }, 'br', blocks), irPartWriter({ id: 'w1' }, 'wall1', blocks),
    irPartWriter({ id: 'town_street' }, 'town', blocks), irPartWriter({ id: 'town_lanes' }, 'town', blocks, 'path'), irPartWriter({ id: 'town_props_lamp' }, 'town', blocks, 'add'),
    irPartWriter({ id: 'w_pond_basin' }, 'pond', blocks), irPartWriter({ id: 'oak_1' }, 'oak', blocks), irPartWriter({ id: 'r' }, 'road1', blocks),
  ], ['ways', null, null, 'ways', 'ways', null, 'forms', 'forms', 'ways']);
});

test('§5 over: lots: a copper-only town with a cobblestone street fits on its copper lots; over all refuses on the street; an oak lot refuses', async () => {
  const fx = readJ('coa', 'p01_over_lots.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'copper_buildings');
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.measured, { cells: 288, family: 288, share: 1, parts: {}, lots: { h1: [144, 144], h2: [144, 144] }, pendingLots: [] });
  // the artifact's row: over lots, no part cells (Java's measure is then the lots alone)
  const [row] = r.artifact.palette;
  assert.deepEqual([row.rule, row.over, row.partsCells, row.partsFamily, row.lots], ['copper_buildings', 'lots', 0, 0, ['h1', 'h2']]);
  // the same rule over everything: the street's cobblestone and the lamps count, refused TOLERANCE
  const all = await run(fx, { plan: withRule(fx.plan, { over: 'all' }) });
  assert.equal(part(all, 'copper_buildings').class, 'refused');
  assert.equal(part(all, 'copper_buildings').reasons[0].code, 'TOLERANCE');
  assert.ok(part(all, 'copper_buildings').measured.parts.town[1] > 0);
  // an oak lot bound at check: refused TOLERANCE naming the lot
  const oak = await run(fx, { lotDesigns: { h1: 'vocc_copper_cabin', h2: 'vocc_oak_cabin' } });
  const o = part(oak, 'copper_buildings');
  assert.equal(o.class, 'refused');
  assert.deepEqual(o.reasons[0].evidence.worst.map((w) => w.lot), ['h2']);
});

test('§5 over: lots with the lots pending: fits with pendingLots; the row measures the realise-time lots alone (copper passes, oak fails)', async () => {
  const fx = readJ('coa', 'p01_over_lots.json');
  const r = await run(fx, { lotDesigns: null });
  const a = part(r, 'copper_buildings');
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.measured.pendingLots, ['h1', 'h2']);
  assert.equal(a.measured.cells, 0);
  const [row] = r.artifact.palette;
  assert.deepEqual([row.over, row.partsCells, row.partsFamily, row.lots, row.lotCounts], ['lots', 0, 0, ['h1', 'h2'], {}]);
  // PaletteRules.measure's arithmetic over the row (VOC-c item 8's model): the parts' counts plus each bound lot's histogram
  const lb = await fixtureLotBlocks({ lotDesigns: { cu: 'vocc_copper_cabin', oak: 'vocc_oak_cabin' } });
  const realise = (hists) => { const nat = new Set(row.natural), fam = new Set(row.blocks); let c = row.partsCells, f = row.partsFamily; for (const h of hists) for (const [b, n] of Object.entries(h)) { const id = b.replace(/\[.*$/, ''); if (nat.has(id)) continue; c += n; if (fam.has(id)) f += n; } return shareFits(f, c, row.share); };
  assert.equal(realise([lb.cu, lb.cu]), true, 'copper lots realise');
  assert.equal(realise([lb.cu, lb.oak]), false, 'an oak lot is refused PALETTE at realise');
  // over all (the default): the street's cells are measured at check already (refused TOLERANCE, the lots pending)
  const all = await run(fx, { lotDesigns: null, plan: withRule(fx.plan, { over: 'all' }) });
  assert.equal(part(all, 'copper_buildings').class, 'refused');
  assert.deepEqual(part(all, 'copper_buildings').measured.pendingLots, ['h1', 'h2']);
});

test('§5 exempt [ways, forms]: the street, the road and the fountain left out by writer (copper [0.95, 1] fits); the default exempt refuses', async () => {
  const fx = readJ('coa', 'p02_exempt_ways_forms.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'copper_ways_free');
  assert.equal(a.class, 'fits');
  assert.deepEqual(Object.keys(a.measured.parts).sort(), ['props_apron', 'town'], 'the road and the fountain are not measured');
  const m = r.res.meta.planCheck.paletteMeasures.copper_ways_free;
  assert.ok(m.exempted.ways > 0 && m.exempted.forms > 0, JSON.stringify(m.exempted));
  const d = await run(fx, { plan: withRule(fx.plan, { exempt: ['terrain', 'support'] }) });
  const b = part(d, 'copper_ways_free');
  assert.equal(b.class, 'refused');
  assert.equal(b.reasons[0].code, 'TOLERANCE');
  assert.ok(b.measured.parts.fount && b.measured.parts.town[1] > a.measured.parts.town[1], JSON.stringify(b.measured.parts));
  assert.deepEqual(Object.keys(d.res.meta.planCheck.paletteMeasures.copper_ways_free.exempted), ['terrain', 'support'], 'a rule without ways or forms measures as VOC-c did');
});

test('§5 lenient: a string scope "lots" plans (never malformed) as over: lots, noted; params.over likewise', async () => {
  const fx = readJ('coa', 'p03_scope_string.json');
  const r = await run(fx);
  assert.equal(r.check.overall, 'READY');
  const a = part(r, 'copper_buildings');
  assert.equal(a.class, 'fits');
  assert.deepEqual(a.notes, ['scope "lots" read as over (the rule binds the whole plan)']);
  assert.deepEqual(a.measured.parts, {});
  assert.equal(r.artifact.palette[0].over, 'lots');
  const p = await run(fx, { plan: withRule(fx.plan, { params: { over: 'lots' } }, ['scope']) });
  const b = part(p, 'copper_buildings');
  assert.equal(b.class, 'fits');
  assert.equal(b.notes, undefined);
  assert.deepEqual(b.measured, a.measured);
  assert.equal(p.artifact.palette[0].over, 'lots');
});

// ------------------------------------------------------------------ §7 (item 7): ponds choose a lot-clear site

const leaks = (r) => r.check.parts.flatMap((a) => (a.reasons ?? []).filter((x) => x.code === 'LEAK').map((x) => `${a.part}: ${x.message}`));

test('§7: Steward\'s grove_pond with its pond near the stone (beside the town\'s lots) places: adjusted (move), 0 LEAK, the reef in it', async () => {
  const fx = readJ('coa', 'n01_grove_pond_stone.json');
  const r = await run(fx);
  assert.deepEqual(leaks(r), []);
  assert.equal(r.check.overall, 'READY');
  const pond = part(r, 'pond');
  assert.equal(pond.class, 'adjusted');
  assert.equal(pond.deviations[0].what, 'move');
  assert.ok(pond.deviations[0].value > 0);
  assert.match(pond.notes.at(-1), /^the first site \(154, 154, 164, 162\) reaches lot cottage_1 \(LEAK\): moved to the next ranked site/);
  // the answer's geometry is the site written: the body, its rect, and the reef grown inside it
  const [x0, z0, x1, z1] = pond.geometry.water;
  assert.deepEqual(pond.geometry.rect, [x0 - 1, z0 - 1, x1 + 1, z1 + 1]);
  const ir = irOf(r);
  const body = ir.parts.find((p) => p.id === 'w_pond_basin');
  assert.ok(body, 'the basin is written once');
  assert.equal(ir.parts.filter((p) => p.id === 'w_pond_basin').length, 1);
  const reef = part(r, 'reef');
  assert.equal(reef.class, 'fits');
  const [rx0, rz0, rx1, rz1] = reef.geometry.rect;
  assert.ok(rx0 >= x0 && rz0 >= z0 && rx1 <= x1 && rz1 <= z1, `the reef ${reef.geometry.rect} inside the pond ${pond.geometry.water}`);
  // clear of the town's lots (box + 1) by its footprint (water + 2)
  for (const l of part(r, 'town').geometry.lots) {
    const [bx0, , bz0, bx1, , bz1] = l.box;
    assert.ok(x1 + 2 < bx0 - 1 || x0 - 2 > bx1 + 1 || z1 + 2 < bz0 - 1 || z0 - 2 > bz1 + 1, `lot ${l.id}`);
  }
});

test('§7 (unit): the only lot-clear site, ranked below the first (its locator move 6), is written; with it taken too, LEAK with tried', async () => {
  const fx = readJ('coa', 'n02_pond_only_clear_site.json');
  const r = await run(fx);
  assert.deepEqual(leaks(r), []);
  const pond = part(r, 'pond');
  assert.equal(pond.class, 'adjusted');
  assert.deepEqual(pond.deviations, [{ what: 'move', value: 6, max: 6 }]);
  assert.deepEqual(pond.geometry.water, [1087, 2049, 1097, 2057]);
  assert.match(pond.notes.at(-1), /reaches lot cottage_1, lot farm_1 \(LEAK\): moved .* \(0 more tried, /);
  // that site's place taken by a third protected area: no clear site is left: the first site's LEAK, as main answers, with evidence.tried
  const r2 = await run({ ...fx, protected: [...fx.protected, { id: 'barn', rect: [1084, 2046, 1099, 2052] }] });
  const p2 = part(r2, 'pond');
  assert.equal(p2.class, 'refused');
  assert.equal(p2.reasons[0].code, 'LEAK');
  assert.deepEqual(p2.reasons[0].evidence.meets, ['lot cottage_1', 'lot farm_1']);
  assert.deepEqual(p2.reasons[0].evidence.tried, [{ water: [1114, 2075, 1124, 2083], skipped: 'LEAK', meets: ['lot cottage_1', 'lot farm_1'] }]);
});
