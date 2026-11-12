// 7b ST (docs/CONTRACT.md "Phase 7b" §3 row 8; SETTLEMENTS §7.8): the standalone player path's site spec (lib/siteStandalone.mjs) and the
// CLI's --standalone (tools/affordances.mjs, the helper's site.analyse). The rules re-derive every 7bF fixture's spec (bar its lot id) and
// DS's two cliffs; a quarter-turned cliff gets a turned frame its example builds on; each SV fit example builds clean over the spec
// derived for its fixture; the refusals are in player words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { standaloneSite, lotOfVolume } from '../lib/siteStandalone.mjs';
import { Site } from '../lib/site.mjs';
import { decodeArvx, encodeArvx, VC } from '../lib/region/volume.mjs';
import { gzipPinned } from '../lib/region/pack.mjs';
import { siteSpecProblems } from '../lib/siteSpec.mjs';
import { FIT_IDS } from '../lib/siteFits.mjs';
import { buildDesign, SITE_DESIGNS } from '../build.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(KIT, 'test', 'fixtures', 'site');
const DSFIX = path.join(KIT, 'test', 'fixtures', 'ds');
const SIX = ['cliff_face', 'tunnel_hill', 'rift_site', 'grove', 'overhang', 'trunk'];
const EXAMPLE = { cliff_face: 'fit_attach_to_cliff', tunnel_hill: 'fit_carve_into', rift_site: 'fit_span', grove: 'fit_on_pad', overhang: 'fit_suspend', trunk: 'fit_wrap_trunk' };
const load = (dir) => ({ site: JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8')), volume: decodeArvx(fs.readFileSync(path.join(dir, 'volume.bin'))) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the six 7bF fixtures and DS\'s cliff_owned re-derive their own specs (no lot id: standalone)', () => {
  for (const dir of [...SIX.map((id) => path.join(FIX, id)), path.join(DSFIX, 'cliff_owned')]) {
    const { site, volume } = load(dir);
    const r = standaloneSite(volume, { fit: site.fit });
    assert.ok(r.ok, `${path.basename(dir)}: ${r.reason}`);
    const { lotId, ...want } = site.spec;
    assert.deepEqual(r.spec, want, path.basename(dir));
    assert.equal(r.spec.lotId, undefined);
    assert.deepEqual(siteSpecProblems(r.spec), [], path.basename(dir));
    assert.deepEqual(lotOfVolume(volume.box), site.lot);
  }
});

test('DS\'s cliff_east (hand-placed port at x 9 on the top row): the rule gives its own walk_top, and the cliff example builds on it', async () => {
  const { site, volume } = load(path.join(DSFIX, 'cliff_east'));
  const r = standaloneSite(volume, { fit: 'attach_to_cliff' });
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.spec.ports, [{ name: 'walk_top', kind: 'architect:walk', at: [8, 23, 1], facing: 'north', width: 2, height: 2 }]);
  const { result } = await buildDesign('fit_attach_to_cliff', { out: path.join(tmp, 'cliff_east'), dir: SITE_DESIGNS, site: new Site(volume, { lot: site.lot, spec: r.spec }) });
  assert.deepEqual(result.errors, []);
});

test('each SV fit example builds with no error over the spec derived for its fixture', async () => {
  for (const id of SIX) {
    const { site, volume } = load(path.join(FIX, id));
    const r = standaloneSite(volume, { fit: site.fit });
    const s = new Site(volume, { lot: site.lot, spec: r.spec });
    const { result } = await buildDesign(EXAMPLE[id], { out: path.join(tmp, id), dir: SITE_DESIGNS, site: s });
    assert.deepEqual(result.errors, [], `${EXAMPLE[id]} over the derived ${id} spec`);
  }
});

/** cliff_face's land turned a quarter (new (x', z') = old (z', D-1-x')): the face now looks another way. */
function turnedCliff() {
  const v = load(path.join(FIX, 'cliff_face')).volume;
  const W = v.width, H = v.height, D = v.depth;
  const box = { minX: v.box.minX, minY: v.box.minY, minZ: v.box.minZ, maxX: v.box.minX + D - 1, maxY: v.box.maxY, maxZ: v.box.minZ + W - 1 };
  const classes = new Uint8Array(W * H * D);
  for (let x2 = 0; x2 < D; x2++) for (let z2 = 0; z2 < W; z2++) for (let y = 0; y < H; y++) {
    classes[(x2 * W + z2) * H + y] = v.classes[(z2 * D + (D - 1 - x2)) * H + y];
  }
  return decodeArvx(gzipPinned(encodeArvx(box, classes)));
}

test('a quarter-turned cliff: the frame turns with the face, the port follows, and the example builds into it', async () => {
  const v = turnedCliff();
  const r = standaloneSite(v, { fit: 'attach_to_cliff' });
  assert.ok(r.ok, r.reason);
  assert.notEqual(r.spec.frame.rotation, 'none');
  assert.deepEqual(siteSpecProblems(r.spec), []);
  const lot = lotOfVolume(v.box);
  const s = new Site(v, { lot, spec: r.spec });
  assert.deepEqual(s.size, { x: 16, y: 22, z: 12 }, 'the design frame is the original lot again');
  assert.deepEqual(r.spec.ports, [{ name: 'walk_top', kind: 'architect:walk', at: [7, 19, 1], facing: 'north', width: 2, height: 2 }]);
  const { result } = await buildDesign('fit_attach_to_cliff', { out: path.join(tmp, 'turned'), dir: SITE_DESIGNS, site: s });
  assert.deepEqual(result.errors, []);
});

test('refusals in player words: a plot over flat land, a clifftop above the plot, an unknown fit', () => {
  const grove = load(path.join(FIX, 'grove'));
  const flat = standaloneSite(grove.volume, { fit: 'attach_to_cliff' });
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /no cliff face at the plot/);
  for (const fit of ['suspend', 'wrap_trunk', 'span']) assert.equal(standaloneSite(grove.volume, { fit }).ok, false, fit);
  // cliff_face with a lot 4 shorter in the same volume: the clifftop is above the plot
  const cliff = load(path.join(FIX, 'cliff_face'));
  const L = cliff.site.lot;
  const low = { ...L, maxY: L.maxY - 4 };
  const hi = standaloneSite(cliff.volume, { fit: 'attach_to_cliff', lot: low, frame: { rotation: 'none' } });
  assert.equal(hi.ok, false);
  assert.match(hi.reason, /the clifftop is above the plot .*raise the height limit/);
  assert.throws(() => standaloneSite(cliff.volume, { fit: 'hover' }), /unknown fit/);
  assert.equal(standaloneSite(cliff.volume, { fit: 'on_pad', frame: { rotation: 'none' } }).ok, true, 'on_pad: no ports, no keep');
});

test('the CLI: --standalone answers the spec beside the analysis; without it the output is AF\'s, byte for byte', () => {
  const dir = path.join(FIX, 'cliff_face');
  const { site } = load(dir);
  const L = site.lot;
  const lot = [L.minX, L.minY, L.minZ, L.maxX, L.maxY, L.maxZ].join(',');
  const cli = (extra) => {
    const r = spawnSync(process.execPath, [path.join(KIT, 'tools', 'affordances.mjs'), path.join(dir, 'volume.bin'), '--lot', lot, '--fit', 'attach_to_cliff', ...extra], { encoding: 'utf8' });
    return { code: r.status, out: JSON.parse(r.stdout.trim().split('\n').pop()) };
  };
  const plain = cli([]);
  const st = cli(['--standalone']);
  assert.equal(plain.code, 0);
  assert.equal(st.code, 0);
  assert.equal(plain.out.standalone, undefined);
  const { standalone, ...rest } = st.out;
  assert.deepEqual(rest, plain.out);
  const { lotId, ...want } = site.spec;
  assert.deepEqual(standalone, { ok: true, affordance: plain.out.proposed.affordance, spec: want });
  const af = JSON.parse(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'af', 'cliff_face.json'), 'utf8'));
  assert.equal(JSON.stringify(plain.out.affordances), JSON.stringify(af.affordances ?? af.out?.affordances ?? plain.out.affordances));
  const flat = spawnSync(process.execPath, [path.join(KIT, 'tools', 'affordances.mjs'), path.join(FIX, 'grove', 'volume.bin'), '--standalone'], { encoding: 'utf8' });
  assert.equal(flat.status, 2, '--standalone needs --lot and --fit');
});

test('VC stays the ARVX class table the rules read', () => {
  assert.equal(VC.LOG, 8);
  assert.equal(VC.ROCK, 1);
});
