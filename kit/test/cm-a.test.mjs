// 7c CM-a (docs/CONTRACT.md "Phase 7c" §3 row 5, "Slice CM-a as built"): composites in the kit. lib/composite.mjs (Composite, c.module,
// c.join, joint ports, the findings, the union-grid check, the modules cut from the union), the hand-written castle (121 long) as the
// $0 subject, a broken joint caught (unmatched and each mismatch kind), and the renders and written files byte-stable (sha goldens that
// a Linux run must reproduce: kit/test/fixtures/cm-a.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Blueprint, PALETTES, rolesOfPalette } from '../lib/kit.mjs';
import { COMPOSITE_EXT, Composite, FINDING_CODES, JOINT_KIND, MODULE_CAP, joint, jointCells } from '../lib/composite.mjs';
import { plain } from '../lib/nbt.mjs';
import { traceRole } from '../lib/connectors/style.mjs';
import { renderStructure } from '../render.mjs';
import buildCastle from '../designs/composite/castle.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDENS = path.join(HERE, 'fixtures', 'cm-a.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-a-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const codes = (c) => c.findings().map((f) => f.code);

/** A small test module: a stone box `w` x 5 x 7, floor and walls, a lantern, joint ports as asked. */
function box(id, w, { west, east, westPort = {}, eastPort = {}, lantern = true, door = false } = {}) {
  const p = PALETTES.fortress;
  const bp = new Blueprint({ id, type: 'castle', size: [w, 6, 7], palette: p, interior: [1, 1, 1, w - 2, 3, 5] });
  bp.part('hall', () => {
    bp.floor(0, 0, w - 1, 6, 0, p.stone);
    bp.walls(0, 0, w - 1, 6, 1, 4, { block: p.stone, corners: p.stone });
    bp.floor(0, 0, w - 1, 6, 5, p.stone);
    if (west) bp.carve([0, 1, 2, 0, 2, 4]);
    if (east) bp.carve([w - 1, 1, 2, w - 1, 2, 4]);
  });
  bp.part('openings', () => {
    if (lantern) bp.lantern(Math.floor(w / 2), 4, 3, true);
    if (door) { bp.door(2, 1, 6, 'south'); bp.spot('entrance', 2, 7); bp.spot('spawn', 2, 8); }
  });
  if (west) joint(bp, west, 0, westPort.y ?? 1, westPort.z ?? 2, westPort.facing ?? 'west', { width: westPort.width ?? 3, height: westPort.height ?? 2 });
  if (east) joint(bp, east, w - 1, eastPort.y ?? 1, eastPort.z ?? 2, eastPort.facing ?? 'east', { width: eastPort.width ?? 3, height: eastPort.height ?? 2 });
  return bp;
}

/** Two small modules sharing the seam x = 8 and joined; `a`/`b` override the boxes' options. */
function pair({ a = {}, b = {}, join = true, at = [8, 0, 0], bw = 9 } = {}) {
  const c = new Composite({ id: 'pair', type: 'castle', front: 'south', palette: PALETTES.fortress, profile: ['door', 'lit', 'no_floating', 'floors_reachable'] });
  c.module('a', box('pair_a', 9, { east: 'e', door: true, ...a }), { at: [0, 0, 0] });
  c.module('b', box('pair_b', bw, { west: 'w', ...b }), { at });
  if (join) c.join('a.e', 'b.w');
  return c;
}

test('castle: 121 long past the cap, three modules within the cap, checks clean (no finding, no error, no warning)', () => {
  const c = buildCastle();
  const s = c.size();
  assert.ok(s.x >= 112, `the castle is ${s.x} long`);
  assert.ok(s.x > MODULE_CAP.x, 'past the cap');
  assert.equal(c.modules.length, 3);
  for (const m of c.modules) assert.ok(m.bp.size.x <= MODULE_CAP.x && m.bp.size.y <= MODULE_CAP.y && m.bp.size.z <= MODULE_CAP.z, m.id);
  assert.deepEqual(c.findings(), []);
  const r = c.check();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
  // the union is one template: two joints, both arches open
  const u = c.union();
  for (const m of c.modules) for (const p of m.bp.ports.filter((q) => q.kind === JOINT_KIND)) {
    for (const [x, y, z] of jointCells(p)) assert.equal(u.cells.get(`${x + m.at[0]},${y + m.at[1]},${z + m.at[2]}`)?.state.name, 'minecraft:air', `${m.id}.${p.name}`);
  }
  assert.equal(u.ports.filter((p) => p.kind === JOINT_KIND).length, 0, 'the joints are consumed by the union');
});

test('castle: every block from the palette roles (S-THEME), and a re-skin checks clean too', () => {
  for (const palette of [PALETTES.fortress, PALETTES.rustic]) {
    const c = buildCastle({ palette });
    const roles = rolesOfPalette(palette);
    const u = c.union();
    const bad = [...new Set([...u.cells.values()].map((x) => x.state.name))].filter((n) => !traceRole(n, roles, { lightFixture: palette.light }));
    assert.deepEqual(bad, [], 'blocks no role gives');
    assert.deepEqual(c.check().errors, []);
  }
});

test('one entry, one group item: the union is the entry (its id), the modules hidden entries the CompositeInfo wire names', () => {
  const c = buildCastle();
  assert.equal(c.entryId(), 'castle');
  const info = c.info();
  // 7cF's frozen CompositeInfo wire: {modules: [entryId...], joints: [{from: {module, port}, to: {module, port}}], union: {minX..maxZ}}
  assert.deepEqual(Object.keys(info), ['modules', 'joints', 'union']);
  assert.deepEqual(info.modules, ['castle__west', 'castle__centre', 'castle__east']);
  assert.ok(!info.modules.includes(c.entryId()), 'a module is never the entry');
  assert.deepEqual(info.joints, [
    { from: { module: 'castle__west', port: 'arch_e' }, to: { module: 'castle__centre', port: 'arch_w' } },
    { from: { module: 'castle__centre', port: 'arch_e' }, to: { module: 'castle__east', port: 'arch_w' } },
  ]);
  assert.deepEqual(info.union, { minX: 0, minY: 0, minZ: 0, maxX: 120, maxY: 14, maxZ: 26 });
  const sc = c.union().sidecar();
  assert.equal(sc.id, 'castle');
  assert.deepEqual(sc.ext[COMPOSITE_EXT], info);
  const man = c.manifest();
  assert.equal(man.entryId, 'castle');
  assert.deepEqual(man.modules.map((m) => [m.entryId, m.at]), [['castle__west', [0, 0, 0]], ['castle__centre', [40, 0, 0]], ['castle__east', [80, 0, 0]]]);
  // the files: one entry sidecar carries the composite; each module's sidecar is its own hidden entry, no composite ext
  const files = c.write(path.join(tmp, 'entry'));
  const entries = Object.keys(files).filter((f) => f.endsWith('.blueprint.json'));
  const withComposite = entries.filter((f) => JSON.parse(fs.readFileSync(files[f], 'utf8')).ext?.[COMPOSITE_EXT]);
  assert.deepEqual(withComposite, ['castle.blueprint.json']);
  assert.deepEqual(entries.filter((f) => f !== 'castle.blueprint.json').map((f) => f.replace('.blueprint.json', '')), info.modules);
});

test('modules cut from the union: their blocks placed at their offsets are exactly the union (seam cells agree, connections across)', () => {
  const c = buildCastle();
  const u = c.union();
  const want = new Map(u.entries().map((e) => [`${e.x},${e.y},${e.z}`, JSON.stringify(e.state)]));
  const got = new Map();
  for (const m of c.modules) {
    const s = plain(c.moduleOutput(m.id).structure);
    assert.deepEqual(s.size, [m.bp.size.x, m.bp.size.y, m.bp.size.z]);
    for (const b of s.blocks) {
      const st = s.palette[b.state];
      const k = `${b.pos[0] + m.at[0]},${b.pos[1] + m.at[1]},${b.pos[2] + m.at[2]}`;
      const v = JSON.stringify({ name: st.id, props: st.properties ?? {} });
      if (got.has(k)) assert.equal(got.get(k), v, `seam cell ${k}`);
      got.set(k, v);
    }
  }
  assert.equal(got.size, want.size);
  for (const [k, v] of want) assert.equal(got.get(k), v, k);
  // a fence row across a seam: the union connects it, and the module cut keeps the connection a module-only finalize would lose
  const a = box('fa', 9, { east: 'e' });
  const b = box('fb', 9, { west: 'w' });
  for (let x = 5; x <= 8; x++) a.set(x, 1, 5, PALETTES.fortress.fence);
  for (let x = 0; x <= 2; x++) b.set(x, 1, 5, PALETTES.fortress.fence);
  const f = new Composite({ id: 'fences', type: 'castle' }).module('a', a).module('b', b, { at: [8, 0, 0] }).join('a.e', 'b.w');
  assert.deepEqual(f.findings(), []);
  const cut = plain(f.moduleOutput('a').structure);
  const seam = cut.blocks.find((x) => x.pos[0] === 8 && x.pos[1] === 1 && x.pos[2] === 5);
  assert.equal(cut.palette[seam.state].properties.east, 'true', 'the seam fence connects east, into module b');
});

test('the union check sees across the seams: light and reachability judged on the union grid', () => {
  // a dark module b: its cells are the union's interior, so the light rule names them
  const dark = pair({ b: { lantern: false } });
  assert.deepEqual(dark.findings(), []);
  const r = dark.check();
  assert.ok(r.errors.some((e) => /^light: /.test(e)), r.errors.join('\n'));
  assert.deepEqual(pair().check().errors, []);
  // reachability across the joint: a walled-up arch leaves module b's floor unreachable from the entrance in module a
  const shut = pair({ bw: 17 });
  for (let y = 1; y <= 2; y++) for (let z = 2; z <= 4; z++) { shut.modules[0].bp.set(8, y, z, PALETTES.fortress.stone); shut.modules[1].bp.set(0, y, z, PALETTES.fortress.stone); }
  const open = pair({ bw: 17 });
  const reach = (x) => x.check().warnings.filter((w) => /reachab/.test(w));
  assert.deepEqual(reach(open), []);
  assert.ok(reach(shut).length > 0, 'the shut arch is seen on the union');
});

test('a broken joint is caught: unmatched, and each mismatch kind (cell, facing, width, height), naming the join', () => {
  assert.deepEqual(codes(pair()), []);
  // unmatched: both ports in no join
  const un = pair({ join: false });
  assert.deepEqual(codes(un), ['JOINT_UNMATCHED', 'JOINT_UNMATCHED']);
  assert.match(un.check().errors[0], /^composite: JOINT_UNMATCHED port 'a\.e' is a joint no join names/);
  // cell: b's port one cell north of a's
  const cell = pair({ b: { westPort: { z: 1 } } });
  assert.deepEqual(codes(cell), ['JOINT_CELL']);
  assert.match(cell.findings()[0].message, /union cells 8,1,2 and 8,1,1/);
  // facing: b's port faces east, the same way as a's (not on b's west face either)
  const facing = pair({ b: { westPort: { facing: 'east' } } });
  assert.deepEqual(codes(facing).sort(), ['JOINT_BOUNDARY', 'JOINT_FACING']);
  // width and height
  assert.deepEqual(codes(pair({ b: { westPort: { width: 2 } } })), ['JOINT_WIDTH']);
  assert.deepEqual(codes(pair({ b: { westPort: { height: 3 } } })), ['JOINT_HEIGHT']);
  // every one is a check error, prefixed with its code
  for (const c of [cell, facing]) assert.equal(c.check().ok, false);
});

test('a broken join is caught: unknown module or port, not a joint port, a port joined twice, a port off its face', () => {
  const c1 = pair({ join: false }).join('a.e', 'b.nope');
  assert.deepEqual(codes(c1), ['JOINT_UNKNOWN', 'JOINT_UNMATCHED']);
  const c2 = pair({ join: false }).join('zz.e', 'b.w');
  assert.deepEqual(codes(c2), ['JOINT_UNKNOWN', 'JOINT_UNMATCHED']);
  const c3 = pair();
  c3.modules[1].bp.port('door_w', 'door', 0, 1, 3, 'west');
  c3.join('a.e', 'b.door_w');
  assert.deepEqual(codes(c3), ['JOINT_REUSED', 'JOINT_KIND']);
  const c4 = pair({ join: false });
  c4.modules[1].bp.port('door_w', 'door', 0, 1, 3, 'west');
  c4.join('a.e', 'b.door_w');
  assert.deepEqual(codes(c4), ['JOINT_KIND', 'JOINT_UNMATCHED']);
  // an opening that runs off the face (z 5..7 on a template 7 deep), the same on both sides so only the boundary is wrong
  const c5 = pair({ a: { eastPort: { z: 5 } }, b: { westPort: { z: 5 } } });
  assert.deepEqual(codes(c5), ['JOINT_BOUNDARY', 'JOINT_BOUNDARY']);
  // a joint port inside its module (x = 1 is not the west face)
  const c6 = pair();
  c6.modules[1].bp.ports[0].x = 1;
  assert.deepEqual(codes(c6), ['JOINT_BOUNDARY', 'JOINT_CELL']);
  assert.throws(() => pair().join('nodot', 'b.w'), /'<module>\.<port>'/);
});

test('modules: the cap, one seam layer at most, and a seam cell two modules write differently', () => {
  const big = new Composite({ id: 'big', type: 'castle' });
  const bp = new Blueprint({ id: 'big_a', size: [97, 4, 4] });
  bp.floor(0, 0, 96, 3, 0, PALETTES.fortress.stone);
  big.module('a', bp);
  assert.deepEqual(codes(big), ['MODULE_CAP']);
  assert.deepEqual(codes(pair({ at: [7, 0, 0] })).filter((x) => x === 'MODULE_OVERLAP'), ['MODULE_OVERLAP']);
  assert.deepEqual(codes(pair({ at: [9, 0, 0] })), ['JOINT_CELL'], 'apart, no overlap: only the joint is off');
  const clash = pair();
  clash.modules[1].bp.set(0, 3, 0, PALETTES.fortress.planks);
  assert.deepEqual(codes(clash), ['SEAM_CONFLICT']);
  assert.match(clash.findings()[0].message, /8,3,0/);
  assert.deepEqual(codes(new Composite({ id: 'none' })), ['NO_MODULES']);
  for (const f of [...big.findings(), ...clash.findings()]) assert.ok(FINDING_CODES.includes(f.code));
  assert.throws(() => new Composite({ id: 'x' }).module('a', {}), /must be a Blueprint/);
  assert.throws(() => new Composite({ id: 'x' }).module('A', new Blueprint({ id: 'q', size: [1, 1, 1] })), /module id/);
});

test('renders and written files are byte-stable (sha goldens; a Linux run reproduces them)', () => {
  const goldens = JSON.parse(fs.readFileSync(GOLDENS, 'utf8'));
  const a = buildCastle().write(path.join(tmp, 'a'));
  const b = buildCastle().write(path.join(tmp, 'b'));
  const got = { files: {}, renders: {} };
  for (const [name, p] of Object.entries(a)) {
    const x = fs.readFileSync(p);
    assert.deepEqual(x, fs.readFileSync(b[name]), `${name}: two writes differ`);
    got.files[name] = sha(x);
  }
  const ra = renderStructure(a['castle.nbt'], { out: path.join(tmp, 'ra'), views: ['iso', 'iso_back', 'top', 'front', 'cutaway'] });
  const rb = renderStructure(b['castle.nbt'], { out: path.join(tmp, 'rb'), views: ['iso', 'iso_back', 'top', 'front', 'cutaway'] });
  assert.deepEqual(ra.unknown, [], 'every block has a colour');
  for (const v of Object.keys(ra.files)) {
    const x = fs.readFileSync(ra.files[v]);
    assert.deepEqual(x, fs.readFileSync(rb.files[v]), `${v}: two renders differ`);
    got.renders[`castle.${v}`] = sha(x);
  }
  if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDENS, `${JSON.stringify(got, null, 2)}\n`);
  assert.deepEqual(got, goldens, 'the composite output moved (kit/test/fixtures/cm-a.json)');
});

test('CLI: kit/tools/composite.mjs builds, checks, writes and renders the castle; a bad usage exits 2', () => {
  const out = path.join(tmp, 'cli');
  const r = spawnSync(process.execPath, [path.join(HERE, '..', 'tools', 'composite.mjs'), 'castle', '--out', out, '--views', 'iso', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.id, j.ok, j.errors, j.modules, j.renders], ['castle', true, [], 3, ['iso']]);
  assert.ok(fs.existsSync(path.join(out, 'castle.composite.json')) && fs.existsSync(path.join(out, 'castle.preview-iso.png')));
  assert.equal(spawnSync(process.execPath, [path.join(HERE, '..', 'tools', 'composite.mjs')], { encoding: 'utf8' }).status, 2);
});
