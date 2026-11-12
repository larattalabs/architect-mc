// (7b foundation, slice 7bF; docs/CONTRACT.md "Phase 7b" §2 and §3 row 1) The kit half of the frozen interface: the fit table leaf,
// the site-spec schema and check, the catalogue edits (two ids re-reserved for 7c) and the six site fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIT_IDS, FITS, fitOf, SITE_PORT_KINDS, SITE_PORT_FACINGS, SITE_ROTATIONS, SITE_LIMITS, SITE_BINDING_KEY, SITE_MARGIN } from '../lib/siteFits.mjs';
import { SITE_SPEC_SCHEMA, siteSpecProblems } from '../lib/siteSpec.mjs';
import { planCatalogue } from '../lib/plan/catalogue.mjs';
import { decodeArvx, classAt, VC } from '../lib/region/volume.mjs';
import { sha256Hex } from '../lib/region/pack.mjs';
import { arvxBytes } from '../lib/region/volume.mjs';
import { buildSiteFixtures, siteJsonText, SITE_FIXTURES_DIR } from '../tools/site-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const API = path.join(ROOT, 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'api');
const java = (f) => fs.readFileSync(path.join(API, f), 'utf8');

test('the fit table: a leaf, its ids are api.FitMode\'s wire names in order, every row complete', () => {
  const src = fs.readFileSync(path.join(ROOT, 'kit', 'lib', 'siteFits.mjs'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'siteFits.mjs imports nothing');
  const consts = /enum FitMode \{\s*([A-Z_,\s]+);/.exec(java('FitMode.java'))[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  assert.deepEqual(FIT_IDS, consts);
  assert.deepEqual(Object.keys(FITS), FIT_IDS);
  for (const id of FIT_IDS) {
    const f = fitOf(id);
    for (const k of ['terrain', 'foundationFill', 'clearLeaves', 'approach', 'ports', 'support', 'bears', 'keepCritical', 'limits']) assert.ok(k in f, `${id}.${k}`);
    assert.equal(f.terrain === 'clear', id === 'on_pad', `${id}: only on_pad clears`);
    assert.equal(f.approach === 'ground', id === 'on_pad', `${id}: only on_pad keeps the ground approach`);
    assert.equal(f.support, id === 'on_pad' ? 'no_floating' : `fit:${id}`);
  }
  assert.equal(FITS.span.ports, 2);
  assert.equal(FITS.wrap_trunk.keepCritical, 'host');
  assert.equal(FITS.suspend.keepCritical, 'hang');
  assert.throws(() => fitOf('hover'), /unknown fit/);
  assert.equal(SITE_MARGIN, 8);
  assert.equal(SITE_BINDING_KEY, /EXT_KEY = "([^"]+)"/.exec(java('SiteBinding.java'))[1]);
});

test('the site-spec schema and the Java records agree: kinds, facings, rotations, caps, affordance kinds', () => {
  const d = SITE_SPEC_SCHEMA.$defs;
  assert.deepEqual(d.site.properties.fit.enum, FIT_IDS);
  assert.deepEqual(d.port.properties.kind.enum, SITE_PORT_KINDS);
  assert.deepEqual(d.port.properties.facing.enum, SITE_PORT_FACINGS);
  assert.deepEqual(d.frame.properties.rotation.enum, SITE_ROTATIONS);
  const spec = java('SiteSpec.java');
  assert.equal(d.site.properties.keepCritical.maxItems, SITE_LIMITS.keepCritical);
  assert.equal(Number(/MAX_KEEP_CRITICAL = (\d+)/.exec(spec)[1]), SITE_LIMITS.keepCritical);
  assert.equal(d.site.properties.ports.maxItems, SITE_LIMITS.ports);
  assert.equal(Number(/MAX_PORTS = (\d+)/.exec(spec)[1]), SITE_LIMITS.ports);
  assert.equal(d.port.properties.width.maximum, SITE_LIMITS.portSize);
  assert.equal(Number(/MAX_PORT_SIZE = (\d+)/.exec(spec)[1]), SITE_LIMITS.portSize);
  const port = java('SitePort.java');
  assert.equal(/WALK = "([^"]+)"/.exec(port)[1], SITE_PORT_KINDS[0]);
  assert.equal(/DOOR = "([^"]+)"/.exec(port)[1], SITE_PORT_KINDS[1]);
  const kinds = /enum Kind \{\s*([A-Z_,\s]+);/.exec(java('Affordance.java'))[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(kinds, ['CLIFF_FACE', 'LEDGE', 'OVERHANG', 'CAVE', 'TRUNK', 'CANOPY', 'SPIKE', 'WATER', 'GAP', 'PAD']);
  // the six Reasons, appended after NO_ROOM in the contract's order
  assert.match(java('Reason.java'), /NO_ROOM,\s*\/\/[^\n]*\n\s*SITE_DRIFTED, KEEP_LOST, SITE_UNSUPPORTED, SITE_MISMATCH, SITE_UNFIT, NO_LINK\n\}/);
});

test('siteSpecProblems: a valid spec passes; each malformed one names its problem', () => {
  const ok = JSON.parse(fs.readFileSync(path.join(SITE_FIXTURES_DIR, 'trunk', 'site.json'), 'utf8')).spec;
  assert.deepEqual(siteSpecProblems(ok), []);
  const bad = (mut) => { const o = structuredClone(ok); mut(o); return siteSpecProblems(o); };
  assert.match(bad((o) => { o.fit = 'hover'; })[0], /site\.fit/);
  assert.match(bad((o) => { o.ports.push({ ...o.ports[0] }); })[0], /twice/);
  assert.match(bad((o) => { o.ports[0].kind = 'minecraft:ladder'; })[0], /kind/);
  assert.match(bad((o) => { o.keepCritical.push([0, 0, 0]); })[0], /outside the volume/);
  assert.match(bad((o) => { delete o.frame; })[0], /missing frame/);
  assert.match(bad((o) => { o.frame.rotation = '180'; })[0], /rotation/);
  assert.match(bad((o) => { o.volume.minX = o.volume.maxX + 1; })[0], /min passes/);
  assert.match(bad((o) => { o.extra = 1; })[0], /unexpected extra/);
  assert.match(bad((o) => { o.volumeSha = 'abc'; })[0], /volumeSha/);
  assert.deepEqual(bad((o) => { delete o.lotId; o.ports[0].edge = 'e_1'; o.ports[0].facing = 'up'; }), []);
});

test('the six site fixtures: regenerate byte-identical, one per fit, each spec valid and its volume as recorded', () => {
  const built = buildSiteFixtures();
  assert.deepEqual(built.map((f) => f.site.fit).sort(), [...FIT_IDS].sort(), 'one fixture per fit');
  assert.deepEqual(built.map((f) => f.id), ['cliff_face', 'tunnel_hill', 'rift_site', 'grove', 'overhang', 'trunk']);
  assert.deepEqual(fs.readdirSync(SITE_FIXTURES_DIR).sort(), built.map((f) => f.id).sort(), 'no other fixture dir');
  for (const fx of built) {
    const file = fs.readFileSync(path.join(fx.dir, 'volume.bin'));
    assert.equal(Buffer.compare(file, Buffer.from(fx.volume)), 0, `${fx.id}: volume.bin regenerates byte for byte`);
    assert.equal(fs.readFileSync(path.join(fx.dir, 'site.json'), 'utf8'), siteJsonText(fx), `${fx.id}: site.json`);
    assert.equal(file[9], 255, `${fx.id}: the gzip OS byte is pinned`);
    const s = fx.site.spec;
    assert.deepEqual(siteSpecProblems(s), [], fx.id);
    const v = decodeArvx(file);
    assert.equal(v.sha, s.volumeSha, `${fx.id}: the spec names the volume's ARVX sha`);
    assert.equal(sha256Hex(arvxBytes(file)), s.volumeSha);
    assert.deepEqual(v.box, s.volume);
    // the lot is the volume less SITE_MARGIN; the frame's origin is the lot's minimum corner
    const L = fx.site.lot;
    assert.deepEqual([L.minX - v.box.minX, L.minY - v.box.minY, L.minZ - v.box.minZ, v.box.maxX - L.maxX, v.box.maxY - L.maxY, v.box.maxZ - L.maxZ], Array(6).fill(SITE_MARGIN));
    assert.deepEqual(s.frame.origin, [L.minX, L.minY, L.minZ]);
    const [w, h, d] = fx.site.maxSize;
    for (const p of s.ports) assert.ok(p.at[0] >= 0 && p.at[0] < w && p.at[1] >= 0 && p.at[1] < h && p.at[2] >= 0 && p.at[2] < d, `${fx.id}: port ${p.name} in the lot`);
    assert.ok(s.ports.length >= FITS[s.fit].ports, `${fx.id}: at least the fit's ports`);
    for (const c of s.keepCritical) assert.notEqual(classAt(v, ...c), VC.AIR, `${fx.id}: keep cell ${c} is solid`);
  }
  const by = Object.fromEntries(built.map((f) => [f.id, f]));
  const vol = (id) => decodeArvx(fs.readFileSync(path.join(by[id].dir, 'volume.bin')));
  assert.ok(vol('grove').counts.WATER > 0, 'grove has the pond for the stilts example');
  assert.ok(by.trunk.site.spec.keepCritical.length > 0 && by.trunk.site.spec.keepCritical.every((c) => classAt(vol('trunk'), ...c) === VC.LOG), 'trunk: the host logs are keep-critical');
  assert.equal(by.overhang.site.spec.keepCritical.length, 4, 'overhang: four hang points');
  assert.ok(by.overhang.site.spec.ports.some((p) => p.facing === 'down'), 'overhang: a vertical walk port');
  assert.equal(by.rift_site.site.spec.ports.length, 2, 'rift_site: a port at each end');
});

test('catalogue: form.hidden_room and rule.suspended re-reserved until 7c (N-7b-1), nothing else against catalogue-pre7b.json', () => {
  const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'schemas', 'plan-catalogue.golden.json'), 'utf8'));
  assert.deepEqual(planCatalogue(), golden);
  const before = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'plan', 'catalogue-pre7b.json'), 'utf8'));
  assert.equal(golden.catalogueVersion, before.catalogueVersion, 'catalogueVersion is the coordinator\'s at merge');
  assert.deepEqual(golden.entries.map((e) => e.id), before.entries.map((e) => e.id));
  // ((7b SL) layout.elevated flipped to supported by its own slice: sl.test.mjs holds that change)
  const changed = golden.entries.filter((e) => JSON.stringify(e) !== JSON.stringify(before.entries.find((x) => x.id === e.id))).map((e) => e.id).filter((id) => !['layout.elevated', 'connector.branch_walk', 'tunnel.under'].includes(id)); // ((7b LP) its two flips: lp.test.mjs)
  assert.deepEqual(changed, ['form.hidden_room', 'rule.suspended']);
  for (const id of changed) {
    const e = golden.entries.find((x) => x.id === id);
    assert.equal(e.state, 'reserved');
    assert.equal(e.until, '7c');
    assert.ok(e.sinceApi === 'NEXT' || /^\d+\.\d+\.\d+$/.test(e.sinceApi), e.sinceApi);
  }
  // the 7b promises that stay 7b's
  // ((7b LP) connector.branch_walk and tunnel.under, until 7b here, flipped to supported in LP: lp.test.mjs)
});
