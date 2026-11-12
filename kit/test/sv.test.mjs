// 7b SV (docs/CONTRACT.md "Phase 7b" §3 row 2): the site in the kit. lib/site.mjs (frames, rotations, the shapes a design reads), the
// Blueprint's fit, site and keep cells, the terrain-merged helpers, --site on build, render and slices, and the six fit examples: each
// builds over its 7bF fixture, deterministically, into what kit/examples holds; it meets its site on the composite (the invariants below
// stand in for SC's checker until it lands); it is themed (every block traces to a role of its palette under three palettes); and its
// composite and section renders are byte-stable (committed sha goldens that CI's Linux run must reproduce).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Site, compositeStructure, turnFacing } from '../lib/site.mjs';
import { siteFixture } from '../lib/siteFixture.mjs';
import { Blueprint, PALETTES, rolesOfPalette } from '../lib/kit.mjs';
import { encodeArvx, VC } from '../lib/region/volume.mjs';
import { gzipPinned, sha256Hex } from '../lib/region/pack.mjs';
import { SITE_MARGIN } from '../lib/siteFits.mjs';
import { siteSpecProblems } from '../lib/siteSpec.mjs';
import { checkPorts } from '../lib/check.mjs';
import { parse, plain } from '../lib/nbt.mjs';
import { traceRole } from '../lib/connectors/style.mjs';
import { builtinBible } from '../lib/bible.mjs';
import { importDesign, loadDesign, SITE_DESIGNS } from '../build.mjs';
import { buildExample, listSiteDesigns, ruleNames } from '../tools/examples.mjs';
import { renderStructure } from '../render.mjs';
import { slices } from '../tools/slices.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const GOLDENS = path.join(KIT, 'test', 'fixtures', 'sv-renders.json');
const EXAMPLES = { fit_on_pad: 'grove', fit_carve_into: 'tunnel_hill', fit_attach_to_cliff: 'cliff_face', fit_span: 'rift_site', fit_wrap_trunk: 'trunk', fit_suspend: 'overhang' };

// ---------------------------------------------------------------- Site

test('Site: the six fixtures load in their own frame (the lot is the template box; the window reaches the margin)', () => {
  for (const id of Object.values(EXAMPLES)) {
    const s = siteFixture(id);
    const fx = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'site', id, 'site.json'), 'utf8'));
    assert.deepEqual([s.size.x, s.size.y, s.size.z], fx.maxSize, id);
    assert.equal(s.fit, fx.fit);
    assert.deepEqual(s.bounds, { minX: -SITE_MARGIN, minY: -SITE_MARGIN, minZ: -SITE_MARGIN, maxX: s.size.x - 1 + SITE_MARGIN, maxY: s.size.y - 1 + SITE_MARGIN, maxZ: s.size.z - 1 + SITE_MARGIN }, id);
    assert.deepEqual(s.toWorld(0, 0, 0), fx.spec.frame.origin);
    assert.equal(s.at(s.bounds.minX - 1, 0, 0), 'MISSING');
    for (const [x, y, z] of fx.spec.keepCritical) assert.deepEqual(s.toWorld(...s.toDesign(x, y, z)), [x, y, z]);
  }
});

test('Site: refuses a volume that is not the spec\'s, and a frame whose origin is not the lot\'s corner', () => {
  const dir = path.join(KIT, 'test', 'fixtures', 'site');
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'grove', 'site.json'), 'utf8')).spec;
  assert.throws(() => new Site(fs.readFileSync(path.join(dir, 'trunk', 'volume.bin')), spec), /not the spec's volumeSha/);
  const moved = structuredClone(spec);
  moved.frame.origin[0] += 1;
  assert.throws(() => new Site(fs.readFileSync(path.join(dir, 'grove', 'volume.bin')), moved), /minimum corner/);
  assert.throws(() => siteFixture('nope'), /no site fixture/);
});

/** A small synthetic site with a rotated frame: a 5x3x7 lot (world), margin 8, one ROCK marker per lot corner column. */
function rotatedSite(rotation) {
  const lw = 5, lh = 3, ld = 7, M = SITE_MARGIN;
  const box = { minX: 100, minY: 60, minZ: -40, maxX: 100 + lw + 2 * M - 1, maxY: 60 + lh + 2 * M - 1, maxZ: -40 + ld + 2 * M - 1 };
  const W = lw + 2 * M, H = lh + 2 * M, D = ld + 2 * M;
  const classes = new Uint8Array(W * H * D);
  // a marker: world (box.minX + M, box.minY + M, box.minZ + M) (the lot's corner) is ROCK; (lot max x, min y, min z) is SOIL
  classes[((M) * D + M) * H + M] = VC.ROCK;
  classes[((M + lw - 1) * D + M) * H + M] = VC.SOIL;
  const raw = encodeArvx(box, classes);
  const s = sha256Hex(raw);
  const spec = { volumeSha: s, volumeBlobId: `local:${s}`, volume: box, fit: 'carve_into', frame: { origin: [box.minX + M, box.minY + M, box.minZ + M], rotation }, keepCritical: [[box.minX + M, box.minY + M, box.minZ + M]], ports: [{ name: 'door', kind: 'door', at: [0, 0, 0], facing: 'south', width: 1, height: 2 }], lotId: 'lot_rot' };
  assert.deepEqual(siteSpecProblems(spec), []);
  return new Site(gzipPinned(raw), spec);
}

test('Site: rotated frames turn as the template does (size swaps, design and world round-trip, margin cells too)', () => {
  for (const [rot, turns] of [['none', 0], ['clockwise_90', 1], ['clockwise_180', 2], ['counterclockwise_90', 3]]) {
    const s = rotatedSite(rot);
    assert.equal(s.turns, turns);
    assert.deepEqual([s.size.x, s.size.z], turns & 1 ? [7, 5] : [5, 7], rot);
    // the design box maps onto the lot box exactly
    const seen = new Set();
    for (let x = 0; x < s.size.x; x++) for (let z = 0; z < s.size.z; z++) {
      const [wx, , wz] = s.toWorld(x, 0, z);
      assert.ok(wx >= s.lot.minX && wx <= s.lot.maxX && wz >= s.lot.minZ && wz <= s.lot.maxZ, `${rot} ${x},${z}`);
      seen.add(`${wx},${wz}`);
    }
    assert.equal(seen.size, 35);
    for (const c of [[-8, -8, -8], [s.size.x + 7, 2, -3], [-1, 0, s.size.z + 7], [3, 1, 4]]) assert.deepEqual(s.toDesign(...s.toWorld(...c)), c, `${rot} ${c}`);
    // the corner marker is ROCK at the design cell the frame maps it to; the window still covers the margin
    const [mx, my, mz] = s.toDesign(s.lot.minX, s.lot.minY, s.lot.minZ);
    assert.equal(s.at(mx, my, mz), 'ROCK');
    assert.deepEqual(s.keepCritical, [[mx, my, mz]]);
    assert.equal(s.bounds.maxX - s.bounds.minX + 1, s.size.x + 16);
    // facings turn clockwise with the frame: a design south is west after a clockwise quarter turn
    assert.equal(s.worldFacing('south'), turnFacing('south', turns));
    assert.equal(s.worldFacing(s.worldFacing('north'), true), 'north');
  }
  assert.equal(turnFacing('south', 1), 'west');
  assert.equal(turnFacing('up', 3), 'up');
});

test('Site: the shapes a design reads (faces, the surface, the ceiling, the trunk, ledges, ports, hang points)', () => {
  const cliff = siteFixture('cliff_face');
  assert.deepEqual([cliff.face('south').at, cliff.face('south').y0, cliff.face('south').y1], [1, 0, 18]);
  assert.equal(cliff.surface(7, 1), 18);
  assert.equal(cliff.surface(7, 6), -4);
  assert.deepEqual(cliff.portHint('n'), [7, 19, 1]);
  assert.deepEqual(cliff.portHint('walk_top'), [7, 19, 1]);
  assert.throws(() => cliff.port('w'), /no port "w"/);
  assert.ok(cliff.ledges()[0].y === 19);
  const rift = siteFixture('rift_site');
  assert.deepEqual([rift.face('east').at, rift.face('west').at], [2, 12]);
  assert.throws(() => rift.trunk(), /no trunk/);
  const tr = siteFixture('trunk').trunk();
  assert.deepEqual([tr.cx, tr.cz, tr.y0, tr.y1, tr.radiusAt(5), tr.radiusAt(40)], [8, 8, 0, 19, 2, -1]);
  const over = siteFixture('overhang');
  assert.deepEqual(over.hangPoints(), [[2, 14, 3], [13, 14, 3], [2, 14, 8], [13, 14, 8]]);
  assert.equal(over.ceiling(5, 5), 14);
  assert.equal(over.port('down').name, 'hatch');
  const hill = siteFixture('tunnel_hill');
  assert.equal(hill.face('south').at, 14);
  assert.equal(hill.cellsOf('ROCK').length + hill.cellsOf(['AIR', 'SOIL']).length, 16 * 12 * 16);
  assert.throws(() => hill.cellsOf('STONE'), /unknown class/);
});

// ---------------------------------------------------------------- Blueprint: fit, site, keep

test('Blueprint: a site-bound design is the lot box in the site\'s frame; keep cells are never written; the sidecar records fit, site and keep', () => {
  const site = siteFixture('trunk');
  const bp = new Blueprint({ id: 'sv_t', type: 'custom', site, palette: PALETTES.rustic });
  assert.deepEqual(bp.size, site.size);
  assert.equal(bp.fit, 'wrap_trunk');
  assert.equal(bp.approach.length, 0, 'a port fit has no ground strip');
  assert.equal(bp.keepCritical.size, site.keepCritical.length, 'the site\'s keep-critical cells inside the box are kept from the start');
  assert.throws(() => bp.set(8, 3, 8, 'minecraft:stone'), /writes a keep cell/);
  assert.equal(bp.put(8, 3, 8, 'minecraft:stone'), false, 'the helpers skip keep cells');
  assert.equal(bp.put(0, 0, 0, 'minecraft:stone'), true);
  bp.keep([[0, 0, 0], [99, 0, 0]], { critical: false });
  assert.equal(bp.get(0, 0, 0), null, 'keep drops a cell written before');
  assert.ok(bp.isKeep(0, 0, 0));
  bp.set(1, 0, 0, 'minecraft:stone');
  const sc = JSON.parse(JSON.stringify(bp.sidecar()));
  assert.equal(sc.fit, 'wrap_trunk');
  assert.deepEqual(siteSpecProblems(sc.site), []);
  assert.equal(sc.site.volumeSha, site.sha);
  assert.equal(sc.keep.critical.length, site.keepCritical.length, 'the non-critical keep cell is not recorded');
  assert.deepEqual(sc.frame, { origin: [0, 0, 0] }, 'the sidecar\'s frame stays the design origin (TemplateDelta reads it)');
  assert.throws(() => new Blueprint({ id: 'sv_t', site, fit: 'span' }), /'span' but the site is a 'wrap_trunk' lot/);
  assert.throws(() => new Blueprint({ id: 'sv_t', site, size: [4, 4, 4] }), /not the site's lot/);
  assert.throws(() => new Blueprint({ id: 'sv_t', site, origin: [1, 0, 0] }), /origin \[0, 0, 0\]/);
  assert.throws(() => new Blueprint({ id: 'sv_t', size: [3, 3, 3], fit: 'tilted' }), /unknown fit/);
  // a design without a fit or site writes none of the new keys (the four examples' bytes do not move)
  const plainBp = new Blueprint({ id: 'sv_p', size: [3, 3, 3] });
  plainBp.set(0, 0, 0, 'minecraft:stone');
  const ps = plainBp.sidecar();
  assert.ok(!('fit' in ps) && !('site' in ps) && !('keep' in ps));
  assert.equal(plainBp.approach.length, 4);
  // a fit without a site: recorded, and a port fit drops the strip
  const f = new Blueprint({ id: 'sv_f', size: [3, 3, 3], fit: 'suspend' });
  assert.equal(f.sidecar().fit, 'suspend');
  assert.equal(f.approach.length, 0);
});

test('helpers: beamInto ends 1 cell inside the solid; carveRoom carves only the solid and lines soil; stilts stop on the site', () => {
  const rift = siteFixture('rift_site');
  const bp = new Blueprint({ id: 'sv_h', type: 'custom', site: rift, palette: PALETTES.rustic });
  const b = bp.beamInto(7, 1, 7, 'west');
  assert.deepEqual(b.end, [2, 1, 7]);
  assert.ok(rift.solid(...b.end) && !rift.solid(3, 1, 7));
  assert.equal(bp.get(2, 1, 7).state.props.axis, 'x');
  assert.throws(() => bp.beamInto(7, 8, 7, 'north'), /leaves the template/);
  const br = bp.bracket(3, 0, 5, 'east', { len: 2 });
  assert.equal(br.bears, 2, 'the post bears on two rim cells');
  const cliff = siteFixture('cliff_face');
  const h = new Blueprint({ id: 'sv_c', type: 'custom', site: cliff, palette: PALETTES.rustic });
  // a box cut into the cliff just under its soil cap (rock up to row 16, soil on rows 17-18): carved where solid (and the open cells in
  // front left alone), the soil over it lined, the rock round it left
  const r = h.carveRoom([4, 14, 0, 6, 16, 2]);
  assert.equal(r.carved, 3 * 3 * 2);
  assert.equal(r.lined, 6);
  for (let x = 4; x <= 6; x++) assert.equal(h.nameAt(x, 17, 1), PALETTES.rustic.foundation, 'the soil over the room is lined');
  assert.equal(h.get(5, 15, 2), null, 'an open cell in the box is not written');
  assert.equal(h.get(3, 15, 1), null, 'the rock beside it stays');
  const grove = siteFixture('grove');
  const g = new Blueprint({ id: 'sv_s', type: 'custom', site: grove, palette: PALETTES.rustic });
  const posts = g.stilts([[6, 12], [6, 3]], 4);
  assert.deepEqual(posts.map((p) => [p.y0, p.footing]), [[0, 'box'], [2, 'site']], 'through the pond to the floor row; on the bank to the soil');
  assert.deepEqual(g.hangChain(1, 1, 5, 3).length, 3);
  const deck = g.ringDeck(8, 8, 2, 4, 6, { rail: PALETTES.rustic.fence });
  assert.ok(deck.deck.length > 30 && deck.rail.length > 10);
});

test('checkPorts: a walk port may face up or down; any other port stays horizontal', () => {
  assert.deepEqual(checkPorts([{ name: 'h', kind: 'architect:walk', x: 1, y: 0, z: 1, facing: 'down' }], [3, 3, 3]), []);
  assert.match(checkPorts([{ name: 'd', kind: 'door', x: 1, y: 0, z: 1, facing: 'up' }], [3, 3, 3])[0], /must be horizontal/);
});

// ---------------------------------------------------------------- the six examples

const builds = new Map();
async function built(id) {
  if (!builds.has(id)) builds.set(id, await buildExample(id, { out: path.join(tmp, 'ex', id) }));
  return builds.get(id);
}
const readStructure = (f) => plain(parse(fs.readFileSync(f)));
const cellsOf = (structure) => {
  const m = new Map();
  for (const b of structure.blocks) m.set(b.pos.join(','), structure.palette[b.state].id ?? structure.palette[b.state].Name);
  return m;
};

test('the six fit examples: one per fit, each built into its fixture, clean but for its declared template-only warnings, and current in kit/examples', async () => {
  assert.deepEqual(listSiteDesigns().sort(), Object.keys(EXAMPLES).sort());
  for (const [id, fx] of Object.entries(EXAMPLES)) {
    const mod = await importDesign(id, SITE_DESIGNS);
    assert.equal(mod.exampleSite, fx);
    assert.equal(id, `fit_${mod.fit}`);
    const r = await built(id);
    assert.ok(r.ok, `${id}: ${r.problems.join(' | ')}`);
    assert.deepEqual(r.result.errors, []);
    assert.deepEqual(ruleNames(r.result.warnings), [...mod.templateOnlyWarnings].sort());
    for (const f of [`${id}.nbt`, `${id}.blueprint.json`, `${id}.parts.nbt`, `${id}.mjs`]) {
      assert.deepEqual(fs.readFileSync(path.join(tmp, 'ex', id, f)), fs.readFileSync(path.join(KIT, 'examples', id, f)), `${id}/${f}: kit/examples is out of date (node kit/tools/examples.mjs)`);
    }
    // a second build is byte-identical
    const again = await buildExample(id, { out: path.join(tmp, 'ex2', id) });
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'ex2', id, `${id}.nbt`)), fs.readFileSync(path.join(tmp, 'ex', id, `${id}.nbt`)), id);
    assert.ok(again.ok);
    const sc = JSON.parse(fs.readFileSync(path.join(KIT, 'examples', id, `${id}.blueprint.json`), 'utf8'));
    assert.equal(sc.fit, mod.fit);
    assert.deepEqual(siteSpecProblems(sc.site), []);
    assert.equal(sc.site.volumeSha, siteFixture(fx).sha);
    assert.ok(sc.interior && sc.anchors.entrance && sc.anchors.spawn, `${id}: the bundled library needs an interior, an entrance and a spawn`);
  }
});

test('the six fit examples meet their sites on the composite (no keep cell written, every port met, every block connected to the site)', async () => {
  for (const [id, fx] of Object.entries(EXAMPLES)) {
    const site = siteFixture(fx);
    const r = await built(id);
    const s = readStructure(path.join(tmp, 'ex', id, `${id}.nbt`));
    const sc = JSON.parse(fs.readFileSync(path.join(tmp, 'ex', id, `${id}.blueprint.json`), 'utf8'));
    const cells = cellsOf(s);
    const solidWritten = new Set([...cells].filter(([, n]) => n !== 'minecraft:air').map(([k]) => k));
    // keep cells: the site's keep-critical cells (and, round a trunk, every log) are never written
    for (const c of site.keepCritical) assert.ok(!cells.has(c.join(',')), `${id}: writes keep-critical ${c}`);
    for (const c of site.cellsOf('LOG')) assert.ok(!cells.has(c.join(',')), `${id}: writes the host's log ${c}`);
    // the keep-critical cells inside the template are the sidecar's keep.critical (the overhang's hang points lie above its box: none)
    const inside = site.keepCritical.filter((c) => site.inLot(...c));
    assert.deepEqual(sc.keep?.critical ?? [], inside.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]), id);
    // ports: each of the site's ports is a design port of the same name and kind, at its hinted cell within 2, facing as hinted
    for (const p of site.ports) {
      const d = sc.ports.find((q) => q.name === p.name);
      assert.ok(d, `${id}: no port ${p.name}`);
      assert.equal(d.kind, p.kind);
      assert.equal(d.facing, p.facing);
      assert.ok(Math.max(Math.abs(d.x - p.at[0]), Math.abs(d.y - p.at[1]), Math.abs(d.z - p.at[2])) <= 2, `${id}: port ${p.name} is off its hint`);
    }
    // support: every written block reaches the site's solid (or, for on_pad, the ground row) through written blocks
    const seeds = [];
    const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const k of solidWritten) {
      const [x, y, z] = k.split(',').map(Number);
      const onSite = N6.some(([dx, dy, dz]) => !solidWritten.has(`${x + dx},${y + dy},${z + dz}`) && !cells.has(`${x + dx},${y + dy},${z + dz}`) && site.solid(x + dx, y + dy, z + dz));
      if (onSite || (site.fit === 'on_pad' && y <= sc.groundY - 1)) seeds.push(k);
    }
    const reached = new Set(seeds);
    for (let i = 0; i < seeds.length; i++) {
      const [x, y, z] = seeds[i].split(',').map(Number);
      for (const [dx, dy, dz] of N6) {
        const n = `${x + dx},${y + dy},${z + dz}`;
        if (solidWritten.has(n) && !reached.has(n)) { reached.add(n); seeds.push(n); }
      }
    }
    const loose = [...solidWritten].filter((k) => !reached.has(k));
    assert.deepEqual(loose, [], `${id}: blocks not connected to the site`);
    // per fit: what bears
    const byName = (k) => cells.get(k);
    if (site.fit === 'suspend') {
      for (const [x, y, z] of site.hangPoints()) assert.equal(byName(`${x},${y - 1},${z}`), 'minecraft:iron_chain', `${id}: a chain under hang point ${x},${y},${z}`);
    }
    if (site.fit === 'span') {
      const w = site.face('east').at, e = site.face('west').at;
      const bears = (side) => [...solidWritten].filter((k) => { const [x, y, z] = k.split(',').map(Number); return side(x) && site.solid(x, y - 1, z) && !cells.has(`${x},${y - 1},${z}`); }).length;
      assert.ok(bears((x) => x <= w) >= 4 && bears((x) => x >= e) >= 4, `${id}: both ends bear on the rims`);
    }
    if (site.fit === 'carve_into') {
      const carved = [...cells].filter(([, n]) => n === 'minecraft:air').map(([k]) => k.split(',').map(Number));
      assert.ok(carved.length > 100 && carved.every((c) => site.solid(...c)), `${id}: written air only where the site was solid`);
    }
    if (site.fit === 'attach_to_cliff') {
      const f = site.face('south').at;
      const into = [...solidWritten].filter((k) => { const [, , z] = k.split(',').map(Number); return z <= f; });
      assert.ok(into.length >= 3, `${id}: beams end inside the face`);
    }
    if (site.fit === 'wrap_trunk') {
      const t = site.trunk();
      const touching = [...solidWritten].filter((k) => { const [x, y, z] = k.split(',').map(Number); return N6.some(([dx, dy, dz]) => site.at(x + dx, y + dy, z + dz) === 'LOG'); });
      assert.ok(touching.length >= 8, `${id}: the deck bears on the trunk`);
      assert.ok(t.radiusAt(1) === 2);
    }
    if (site.fit === 'on_pad') {
      const water = site.cellsOf('WATER').filter((c) => solidWritten.has(c.join(',')));
      assert.ok(water.length >= 4, `${id}: stilts stand in the pond`);
    }
    assert.ok(r.ok);
  }
});

test('the six fit examples are themed: every block traces to a role of the palette they are built with (three palettes)', async () => {
  const palettes = [undefined, { bible: builtinBible('fortress') }, { bible: builtinBible('cherry') }];
  for (const [id, fx] of Object.entries(EXAMPLES)) {
    for (const palette of palettes) {
      const bp = await loadDesign(id, { palette, dir: SITE_DESIGNS, site: siteFixture(fx) });
      const roles = rolesOfPalette(bp.p);
      const bad = [...new Set([...bp.cells.values()].map((c) => c.state.name))].filter((n) => !traceRole(n, roles, { lightFixture: bp.p.light }));
      assert.deepEqual(bad, [], `${id} (${palette ? palette.bible.id : 'default'}): blocks no role gives`);
    }
  }
});

// ---------------------------------------------------------------- renders, slices, the CLI

test('composite and section renders of the six examples are byte-stable (sha goldens; CI reproduces them on Linux)', async () => {
  const goldens = JSON.parse(fs.readFileSync(GOLDENS, 'utf8'));
  const got = {};
  for (const [id, fx] of Object.entries(EXAMPLES)) {
    await built(id);
    const nbt = path.join(tmp, 'ex', id, `${id}.nbt`);
    const a = renderStructure(nbt, { out: path.join(tmp, 'ra', id), site: siteFixture(fx), views: ['composite', 'section'] });
    const b = renderStructure(nbt, { out: path.join(tmp, 'rb', id), sitePath: path.join(KIT, 'test', 'fixtures', 'site', fx, 'volume.bin'), views: ['composite', 'section'] });
    for (const v of ['composite', 'section']) {
      const x = fs.readFileSync(a.files[v]);
      assert.deepEqual(x, fs.readFileSync(b.files[v]), `${id} ${v}: two renders differ`);
      got[`${id}.${v}`] = sha(x);
    }
    assert.deepEqual(a.unknown, [], `${id}: every block has a colour`);
  }
  assert.deepEqual(got, goldens.renders, 'the renders moved (kit/test/fixtures/sv-renders.json)');
});

test('render: the site views need a site; slices --site shows the land the design leaves', async () => {
  await built('fit_carve_into');
  const nbt = path.join(tmp, 'ex', 'fit_carve_into', 'fit_carve_into.nbt');
  assert.throws(() => renderStructure(nbt, { out: path.join(tmp, 'rx'), views: ['section'] }), /need.? a site/);
  const s = readStructure(nbt);
  const sc = JSON.parse(fs.readFileSync(path.join(tmp, 'ex', 'fit_carve_into', 'fit_carve_into.blueprint.json'), 'utf8'));
  const txt = slices(s, sc, { y: [2, 2], site: siteFixture('tunnel_hill') });
  assert.match(txt, /site \(carve_into, [0-9a-f]{12}; cells the design leaves\): #=rock/);
  const row = txt.split('\n').find((l) => /^ {2}8 /.test(l));
  assert.ok(row.startsWith('  8 ###'), row);
  assert.ok(!/[#:~T%]=minecraft/.test(txt), 'no block letter takes a site glyph');
  const comp = compositeStructure(s, siteFixture('tunnel_hill'));
  assert.deepEqual(comp.structure.size, [32, 28, 32]);
  assert.deepEqual(comp.offset, [8, 8, 8]);
});

test('CLI: build --site --lot builds a site design; without them it is refused; render and slices take --site', () => {
  const fx = path.join(KIT, 'test', 'fixtures', 'site', 'rift_site');
  const out = path.join(tmp, 'cli');
  const r = spawnSync(process.execPath, [path.join(KIT, 'build.mjs'), 'fit_span', '--site', path.join(fx, 'volume.bin'), '--lot', path.join(fx, 'site.json'), '--out', out, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(j.sidecar, 'utf8')).fit, 'span');
  const bare = spawnSync(process.execPath, [path.join(KIT, 'build.mjs'), 'fit_span', '--out', out, '--json'], { encoding: 'utf8' });
  assert.equal(bare.status, 2);
  assert.match(JSON.parse(bare.stdout).errors[0], /site-aware design \(fit span\): give its site/);
  const half = spawnSync(process.execPath, [path.join(KIT, 'build.mjs'), 'fit_span', '--site', path.join(fx, 'volume.bin')], { encoding: 'utf8' });
  assert.equal(half.status, 2);
  const wrong = spawnSync(process.execPath, [path.join(KIT, 'build.mjs'), 'fit_span', '--site', path.join(KIT, 'test', 'fixtures', 'site', 'grove', 'volume.bin'), '--lot', path.join(KIT, 'test', 'fixtures', 'site', 'grove', 'site.json'), '--json'], { encoding: 'utf8' });
  assert.equal(wrong.status, 2);
  assert.match(JSON.parse(wrong.stdout).errors[0], /declares fit span, but the site is a on_pad lot/);
  const rr = spawnSync(process.execPath, [path.join(KIT, 'render.mjs'), j.nbt, '--site', path.join(fx, 'volume.bin'), '--out', path.join(out, 'r')], { encoding: 'utf8' });
  assert.equal(rr.status, 0, rr.stderr);
  for (const v of ['iso', 'top', 'front', 'composite', 'section']) assert.ok(fs.existsSync(path.join(out, 'r', `fit_span.preview-${v}.png`)), v);
  const sl = spawnSync(process.execPath, [path.join(KIT, 'tools', 'slices.mjs'), j.nbt, '--site', path.join(fx, 'volume.bin'), '--y', '0'], { encoding: 'utf8' });
  assert.equal(sl.status, 0, sl.stderr);
  assert.match(sl.stdout, /#=rock/);
});
