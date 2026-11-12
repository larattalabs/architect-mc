// 7b SC (docs/CONTRACT.md "Phase 7b" §3 row 5; SETTLEMENTS §7.4, §11 M15 and M21): the checker with a site. The template composited with
// its site (lib/siteCheck.mjs siteGrid), the site rules (site_bound and site_keep errors; fit:<mode> (M21), ports_met, floors_reachable,
// site_breach, cut_volume, cantilever and neck (M15) warnings) and the structured `result.site` (the frozen interface DS builds on). Each of
// the six fit examples checks clean on its site; each rule catches a broken variant of one of them (the template, the sidecar or the site's
// volume changed, never the example's source).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkStructure, checkFiles } from '../lib/check.mjs';
import { SITE_CHECK_LIMITS, SITE_RULE_IDS, SITE_RULE_M, SITE_UNCHECKED, siteLimits } from '../lib/siteCheck.mjs';
import { Site } from '../lib/site.mjs';
import { siteFixture } from '../lib/siteFixture.mjs';
import { decodeArvx, encodeArvx, VC } from '../lib/region/volume.mjs';
import { gzipPinned, sha256Hex } from '../lib/region/pack.mjs';
import { normalize } from '../lib/blocks.mjs';
import { parse, plain } from '../lib/nbt.mjs';
import { FIT_IDS } from '../lib/siteFits.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(KIT, 'test', 'fixtures', 'site');
const EXAMPLES = { fit_on_pad: 'grove', fit_carve_into: 'tunnel_hill', fit_attach_to_cliff: 'cliff_face', fit_span: 'rift_site', fit_wrap_trunk: 'trunk', fit_suspend: 'overhang' };
const k3 = (x, y, z) => `${x},${y},${z}`;

/** A fit example as kit/examples holds it: {structure, sidecar, site, cells (key -> block id)}. */
function example(id) {
  const structure = plain(parse(fs.readFileSync(path.join(KIT, 'examples', id, `${id}.nbt`))));
  const sidecar = JSON.parse(fs.readFileSync(path.join(KIT, 'examples', id, `${id}.blueprint.json`), 'utf8'));
  return { structure, sidecar, site: siteFixture(EXAMPLES[id]) };
}
const nameAt = (s, pos) => { const b = s.blocks.find((q) => q.pos.join(',') === pos.join(',')); return b ? s.palette[b.state].id : null; };
/** Write a block (replacing what the template has there). */
function put(s, pos, id, props = {}) {
  const st = normalize(id, props);
  let i = s.palette.findIndex((p) => p.id === id && JSON.stringify(p.properties ?? {}) === JSON.stringify(st.props));
  if (i < 0) { s.palette.push({ id, properties: { ...st.props } }); i = s.palette.length - 1; }
  const b = s.blocks.find((q) => q.pos.join(',') === pos.join(','));
  if (b) b.state = i; else s.blocks.push({ pos: [...pos], state: i });
}
/** Drop every block a predicate picks ([x, y, z], id). */
const drop = (s, pred) => { s.blocks = s.blocks.filter((b) => !pred(b.pos, s.palette[b.state].id)); };
const check = (ex, opts = {}) => checkStructure(ex.sidecar, ex.structure, { site: ex.site, ...opts });
const rules = (r) => r.site.findings.map((f) => f.rule);
const finding = (r, rule) => r.site.findings.find((f) => f.rule === rule);

/** The example re-bound to its fixture's volume with classes changed (`edit(set, site)`, set(x, y, z, cls) in design cells). */
function withSite(ex, fixture, edit) {
  const v = decodeArvx(fs.readFileSync(path.join(FIX, fixture, 'volume.bin')));
  const classes = Uint8Array.from(v.classes);
  const set = (x, y, z, cls) => {
    const [wx, wy, wz] = ex.site.toWorld(x, y, z);
    const b = v.box;
    classes[((wx - b.minX) * v.depth + (wz - b.minZ)) * v.height + (wy - b.minY)] = VC[cls];
  };
  edit(set, ex.site);
  const raw = encodeArvx(v.box, classes);
  const sha = sha256Hex(raw);
  const spec = { ...structuredClone(ex.site.spec), volumeSha: sha, volumeBlobId: `local:${sha}` };
  const site = new Site(gzipPinned(raw), spec);
  return { ...ex, site, sidecar: { ...ex.sidecar, site: spec } };
}

// ---------------------------------------------------------------- the interface

test('the interface: rule ids, limits, the structured result (frozen for DS)', () => {
  assert.deepEqual(SITE_RULE_IDS, ['site_bound', 'site_keep', ...FIT_IDS.map((f) => `fit:${f}`), 'ports_met', 'floors_reachable', 'site_breach', 'cut_volume', 'cantilever', 'neck']);
  assert.equal(SITE_UNCHECKED, 'site_unchecked');
  for (const f of FIT_IDS) assert.equal(SITE_RULE_M[`fit:${f}`], 'M21');
  assert.equal(SITE_RULE_M.cantilever, 'M15');
  assert.equal(SITE_RULE_M.neck, 'M15');
  assert.equal(SITE_CHECK_LIMITS.cantilever, 4);
  // a 'bible' limit with no bible is unbounded; the fit's own numbers and an override win
  assert.equal(siteLimits('attach_to_cliff').cantilever, null);
  assert.equal(siteLimits('attach_to_cliff').bearCells, 2);
  assert.equal(siteLimits('span').span, null);
  assert.deepEqual(siteLimits('span').endBearing, [2, 2]);
  assert.equal(siteLimits('suspend').chain, null);
  assert.equal(siteLimits('carve_into').cantilever, 4);
  assert.equal(siteLimits('attach_to_cliff', { cantilever: 6 }).cantilever, 6);
  const r = check(example('fit_span'));
  assert.deepEqual(Object.keys(r.site).sort(), ['findings', 'fit', 'metrics', 'ok']);
  assert.equal(r.site.fit, 'span');
  assert.equal(r.site.ok, true);
  for (const k of ['volumeSha', 'lotId', 'bearing', 'portsMet', 'cut', 'cantileverMax', 'necks', 'span', 'spanEnds']) assert.ok(k in r.site.metrics, k);
  const bad = check(example('fit_span'), { siteLimits: { span: 5 } });
  const f = finding(bad, 'fit:span');
  assert.deepEqual(Object.keys(f).sort(), ['cells', 'count', 'm', 'message', 'rule', 'severity']);
  assert.equal(f.severity, 'warning');
  assert.equal(f.m, 'M21');
  assert.ok(f.message.startsWith('fit:span: '));
  assert.ok(bad.warnings.includes(f.message), 'every finding is also a checker line');
  assert.equal(bad.site.ok, false);
  assert.equal(bad.ok, true, 'a warning leaves the check ok');
});

test('the six fit examples check clean on their sites (no warning, no site finding)', () => {
  for (const id of Object.keys(EXAMPLES)) {
    const ex = example(id);
    const r = check(ex);
    assert.deepEqual(r.errors, [], id);
    assert.deepEqual(r.warnings, [], id);
    assert.deepEqual(r.site.findings, [], id);
    assert.deepEqual(r.site.metrics.portsMet, ex.site.ports.map((p) => p.name), id);
    if (ex.site.fit !== 'on_pad') {
      assert.equal(r.site.metrics.loose, 0, id);
      assert.equal(r.site.metrics.cut.logs, 0, id);
      assert.ok(r.site.metrics.reached > 0, id);
    }
  }
});

test('without its site a site-bound design gets site_unchecked; a design without a site gets nothing new', () => {
  const ex = example('fit_carve_into');
  const r = checkStructure(ex.sidecar, ex.structure, {});
  assert.ok(r.warnings.some((w) => w.startsWith(`${SITE_UNCHECKED}: `)));
  assert.equal(r.site, undefined);
  const plainR = checkFiles(path.join(KIT, 'examples', 'cottage', 'cottage.nbt'), path.join(KIT, 'examples', 'cottage', 'cottage.blueprint.json'));
  assert.deepEqual(plainR.warnings, []);
  assert.equal(plainR.site, undefined);
});

// ---------------------------------------------------------------- one broken variant per rule

test('site_bound (error): a template that is not the lot box, or bound to another volume or fit', () => {
  const ex = example('fit_span');
  ex.structure.size = [ex.structure.size[0] + 1, ex.structure.size[1], ex.structure.size[2]];
  ex.sidecar.size = { ...ex.sidecar.size, x: ex.sidecar.size.x + 1 };
  const r = check(ex);
  assert.ok(rules(r).includes('site_bound'));
  assert.match(finding(r, 'site_bound').message, /is 17x10x16, but its site's lot box is 16x10x16/);
  assert.equal(r.ok, false);
  const other = example('fit_span');
  other.sidecar.site = { ...other.sidecar.site, volumeSha: '0'.repeat(64) };
  other.sidecar.fit = 'carve_into';
  const o = check(other);
  assert.match(finding(o, 'site_bound').message, /not this site's .*fit is carve_into, but the site is a span lot/);
  assert.equal(o.ok, false);
});

test('site_keep (error): a write into the host trunk, and into a player\'s block', () => {
  const ex = example('fit_wrap_trunk');
  const log = ex.site.cellsOf('LOG').find(([, y]) => y === 3);
  put(ex.structure, log, 'minecraft:spruce_planks');
  const r = check(ex);
  assert.equal(r.ok, false);
  assert.match(finding(r, 'site_keep').message, /1 cell\(s\) the site keeps \(1 the host trunk\)/);
  assert.deepEqual(finding(r, 'site_keep').cells, [log]);
  assert.ok(rules(r).includes('cut_volume'), 'a wrap_trunk house removes no logs');
  // written air counts as a write; a PLAYER cell under a written cell is another's
  const cliff = withSite(example('fit_attach_to_cliff'), 'cliff_face', (set) => set(5, 15, 4, 'PLAYER'));
  const c = check(cliff);
  assert.match(finding(c, 'site_keep').message, /1 a player's block/);
  assert.equal(c.ok, false);
});

test('fit:<mode> (M21): a block connected to nothing the fit bears on, per fit', () => {
  // carve_into: a block hung in the middle of the room
  const carve = example('fit_carve_into');
  put(carve.structure, [7, 2, 8], 'minecraft:stone');
  assert.match(finding(check(carve), 'fit:carve_into').message, /1 block\(s\) not connected to the site's solid.*stone at 7,2,8/);
  // attach_to_cliff: a lone block touching the face at one cell bears on fewer than 2 rock cells (and the loose block in the air)
  const cliff = example('fit_attach_to_cliff');
  const site = cliff.site;
  const face = site.face('south');
  let lone = null;
  for (let x = 0; x < site.size.x && !lone; x++) for (let y = 0; y < 12 && !lone; y++) {
    const z = face.at + 1;
    const nb = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    if (site.at(x, y, z) !== 'AIR' || nameAt(cliff.structure, [x, y, z])) continue;
    if (nb.filter(([dx, dy, dz]) => site.solid(x + dx, y + dy, z + dz)).length === 1 && nb.every(([dx, dy, dz]) => !nameAt(cliff.structure, [x + dx, y + dy, z + dz]))) lone = [x, y, z];
  }
  assert.ok(lone, 'a cell against the face');
  put(cliff.structure, lone, 'minecraft:spruce_planks');
  put(cliff.structure, [14, 3, 10], 'minecraft:spruce_planks');
  const cr = check(cliff);
  assert.match(finding(cr, 'fit:attach_to_cliff').message, /1 block\(s\) not connected.*1 bearing\(s\) touch fewer than 2 rock cells/);
  // span: one end lifted off its rim (every cell bearing on the west rim dropped) and, on the example, a span limit
  const span = example('fit_span');
  const rim = span.site.face('east').at;
  drop(span.structure, ([x, y, z]) => x <= rim && span.site.solid(x, y - 1, z));
  const sr = check(span);
  assert.match(finding(sr, 'fit:span').message, /the span bears on 1 end\(s\)/);
  assert.match(finding(check(example('fit_span'), { siteLimits: { span: 5 } }), 'fit:span').message, /an unsupported span of 9 \(at most 5\)/);
  // wrap_trunk: the deck cut off the trunk (every cell touching a log dropped)
  const trunk = example('fit_wrap_trunk');
  const nearLog = ([x, y, z]) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => trunk.site.at(x + dx, y + dy, z + dz) === 'LOG');
  drop(trunk.structure, (p) => nearLog(p));
  assert.match(finding(check(trunk), 'fit:wrap_trunk').message, /not connected to the trunk or the site's solid/);
  // suspend: the chains gone; and, on the example, a chain limit
  const hang = example('fit_suspend');
  drop(hang.structure, (p, id) => id === 'minecraft:iron_chain');
  assert.match(finding(check(hang), 'fit:suspend').message, /not connected to the site's solid above it \(through chains or posts\)/);
  assert.match(finding(check(example('fit_suspend'), { siteLimits: { chain: 4 } }), 'fit:suspend').message, /chain run\(s\) longer than 4 \(longest 8\)/);
  // on_pad: today's no_floating, reported as fit:on_pad (the `floating:` line, not repeated)
  const pad = example('fit_on_pad');
  put(pad.structure, [8, 14, 1], 'minecraft:spruce_planks');
  const pr = check(pad);
  assert.ok(finding(pr, 'fit:on_pad').message.startsWith('floating: 1 block(s)'));
  assert.equal(pr.warnings.filter((w) => w.startsWith('floating:')).length, 1);
});

test('ports_met and floors_reachable: a port renamed, moved off its hint, or walled up', () => {
  const ex = example('fit_carve_into');
  ex.sidecar.ports = [{ ...ex.sidecar.ports[0], name: 'front' }];
  const r = check(ex);
  assert.match(finding(r, 'ports_met').message, /no port 'door_s'/);
  assert.match(finding(r, 'floors_reachable').message, /no port to start from/);
  const off = example('fit_span');
  off.sidecar.ports = off.sidecar.ports.map((p) => (p.name === 'walk_e' ? { ...p, z: p.z + 3 } : p));
  assert.match(finding(check(off), 'ports_met').message, /port 'walk_e': 3 from the hinted cell/);
  // the door replaced by wall: the port faces no way in, the floor cannot be reached from it
  const walled = example('fit_carve_into');
  const [dx, dy, dz] = [walled.sidecar.ports[0].x, walled.sidecar.ports[0].y, walled.sidecar.ports[0].z];
  for (const y of [dy, dy + 1]) put(walled.structure, [dx, y, dz], 'minecraft:stone_bricks');
  const w = check(walled);
  assert.match(finding(w, 'floors_reachable').message, /floor level y=1 .* cannot be reached from the port/);
  // a walk port facing down needs a ladder or a floor at it
  const hatch = example('fit_suspend');
  drop(hatch.structure, ([x, y, z], id) => id === 'minecraft:ladder');
  assert.match(finding(check(hatch), 'ports_met').message, /port 'hatch': nobody can stand or climb at it/);
});

test('site_breach: the room opened beside the site\'s water, or into a dark cave bigger than itself', () => {
  const ex = example('fit_carve_into');
  const w = ex.sidecar.interior;
  // water in the rock just west of the room's carved air
  const wet = withSite(ex, 'tunnel_hill', (set) => set(w.minX - 1, w.minY + 1, w.minZ + 3, 'WATER'));
  const r = check(wet);
  assert.match(finding(r, 'site_breach').message, /1 open cell\(s\) of the design beside the site's water or lava/);
  // a cave: the rock west of the room hollowed out into the margin (closed to the outside; the room's lanterns light the lot's part of it)
  const cave = withSite(ex, 'tunnel_hill', (set, site) => {
    for (let x = -7; x < w.minX; x++) for (let y = w.minY; y <= w.maxY; y++) for (let z = -7; z <= w.maxZ; z++) if (site.solid(x, y, z)) set(x, y, z, 'AIR');
  });
  assert.equal(finding(check(withSite(ex, 'tunnel_hill', () => {})), 'site_breach'), undefined, 'the fixture re-encoded unchanged is clean');
  const c = check(cave);
  assert.match(finding(c, 'site_breach').message, /the room opens into \d+ dark cave cell\(s\), more than its own \d+/);
});

test('cut_volume: a carve past its interior plus walls', () => {
  const ex = example('fit_carve_into');
  for (let x = 0; x < ex.site.size.x; x++) for (let y = 6; y < ex.site.size.y; y++) for (let z = 0; z < ex.site.size.z; z++) {
    if (ex.site.solid(x, y, z)) put(ex.structure, [x, y, z], 'minecraft:air');
  }
  const r = check(ex);
  assert.match(finding(r, 'cut_volume').message, /replaces \d+ cells of the site's solid, more than its interior plus walls \(660\)/);
});

test('cantilever (M15): a beam six out of the span house warns; the wrap_trunk walk port\'s one column is let through, never two', () => {
  const ex = example('fit_span');
  const iz = ex.sidecar.interior.maxZ + 1; // the south wall's row
  for (let z = iz + 1; z <= iz + 6 && z < ex.site.size.z; z++) put(ex.structure, [7, 3, z], 'minecraft:spruce_planks');
  const r = check(ex);
  const f = finding(r, 'cantilever');
  assert.equal(f.m, 'M15');
  assert.match(f.message, /more than 4 horizontally from a support column or a bracket, held on one side only/);
  // the cliff house is a real cantilever off its face (about 6 cells, Chebyshev); attach_to_cliff's limit is the bible's: unbounded without
  const cliff = check(example('fit_attach_to_cliff'));
  assert.equal(cliff.site.metrics.cantileverLimit, null);
  assert.ok(cliff.site.metrics.cantileverMax >= 6);
  assert.ok(finding(check(example('fit_attach_to_cliff'), { siteLimits: { cantilever: 4 } }), 'cantilever'));
  // wrap_trunk: the walkway's last column (the walk port's, 5 from the trunk) passes at 4 because the column inside it is within 4
  const t = check(example('fit_wrap_trunk'));
  assert.deepEqual(t.site.metrics.cantileverPortCells.map((c) => c.dist), [5, 5]);
  assert.equal(finding(t, 'cantilever'), undefined);
  // at 3 the column inside is over too, so the port column is not let through: two columns past a support always warn
  const t3 = finding(check(example('fit_wrap_trunk'), { siteLimits: { cantilever: 3 } }), 'cantilever');
  assert.ok(t3 && t3.cells.some(([x, y, z]) => k3(x, y, z) === '0,1,7'), 'the port column warns once the column inside it is over');
});

test('neck (M15): the hanging house on one chain hangs a mass of hundreds of cells on one cell', () => {
  const ex = example('fit_suspend');
  const keep = ex.site.hangPoints()[0];
  drop(ex.structure, ([x, , z], id) => id === 'minecraft:iron_chain' && !(x === keep[0] && z === keep[2]));
  const r = check(ex);
  const f = finding(r, 'neck');
  assert.equal(f.m, 'M15');
  assert.match(f.message, /a mass of \d{3,} cells hangs on the one cell/);
  assert.ok(!rules(r).includes('fit:suspend'), 'still connected upward');
});

test('the site rules on the composite: rock is the carved hall\'s walls and ceiling, the trunk stands in the trunk house (SV\'s template-only warnings gone)', () => {
  for (const id of ['fit_carve_into', 'fit_wrap_trunk']) {
    const ex = example(id);
    const alone = checkStructure(ex.sidecar, ex.structure, {});
    assert.ok(alone.warnings.some((w) => w.startsWith('enclosure:')), `${id}: the template alone is open`);
    assert.deepEqual(check(ex).warnings, [], id);
  }
});

test('CLI: check.mjs --site and build.mjs --json report the site', () => {
  const ex = path.join(KIT, 'examples', 'fit_suspend');
  const r = spawnSync(process.execPath, [path.join(KIT, 'check.mjs'), path.join(ex, 'fit_suspend.nbt'), path.join(ex, 'fit_suspend.blueprint.json'), '--site', path.join(FIX, 'overhang', 'volume.bin'), '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.site.fit, 'suspend');
  assert.equal(j.site.ok, true);
  const wrong = spawnSync(process.execPath, [path.join(KIT, 'check.mjs'), path.join(ex, 'fit_suspend.nbt'), path.join(ex, 'fit_suspend.blueprint.json'), '--site', path.join(FIX, 'grove', 'volume.bin'), '--json'], { encoding: 'utf8' });
  assert.equal(wrong.status, 2);
  assert.match(JSON.parse(wrong.stdout).errors[0], /not the spec's volumeSha/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  try {
    const b = spawnSync(process.execPath, [path.join(KIT, 'build.mjs'), 'fit_span', '--site', path.join(FIX, 'rift_site', 'volume.bin'), '--lot', path.join(FIX, 'rift_site', 'site.json'), '--out', out, '--json'], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(JSON.parse(b.stdout).site.findings, []);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
