// (7b AF) The affordance analysis (kit/lib/region/affordances.mjs; docs/CONTRACT.md "Phase 7b" §3 row 4): the six site fixtures
// find their kinds and propose their own frames; synthesized volumes for the kinds no fixture holds (ledge, cave, spike) and a
// negative per kind; ids stable on re-analysis (the same land in another window, land changed outside the box); the output is
// platform-independent (rounded numbers, sorted).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArvx, encodeArvx, VC } from '../lib/region/volume.mjs';
import { AFFORDANCE_KINDS, FIT_AFFORDANCES, analyseVolume, analyseSite, proposeFrame, affordanceId, rotationFacing } from '../lib/region/affordances.mjs';
import { FIT_IDS } from '../lib/siteFits.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(HERE, 'fixtures', 'site');

const fixture = (id) => ({ site: JSON.parse(fs.readFileSync(path.join(FIX, id, 'site.json'), 'utf8')), vol: decodeArvx(fs.readFileSync(path.join(FIX, id, 'volume.bin'))) });
const kinds = (list) => new Set(list.map((a) => a.kind));

/** A volume from a class function over local coordinates (i, j, k), its minimum corner at `min`. */
function vol([W, H, D], cls, min = [0, 0, 0]) {
  const c = new Uint8Array(W * H * D);
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) c[(i * D + k) * H + j] = cls(i, j, k);
  const box = { minX: min[0], minY: min[1], minZ: min[2], maxX: min[0] + W - 1, maxY: min[1] + H - 1, maxZ: min[2] + D - 1 };
  return decodeArvx(encodeArvx(box, c));
}
/** A window of a decoded volume (world box), as Survey.volume over that box would freeze it. */
function crop(v, b) {
  const W = b.maxX - b.minX + 1, H = b.maxY - b.minY + 1, D = b.maxZ - b.minZ + 1;
  return vol([W, H, D], (i, j, k) => v.classes[((b.minX + i - v.box.minX) * v.depth + (b.minZ + k - v.box.minZ)) * v.height + (b.minY + j - v.box.minY)], [b.minX, b.minY, b.minZ]);
}
const ground = (j, g = 6) => (j < g - 2 ? VC.ROCK : j < g ? VC.SOIL : VC.AIR);

test('the kinds are api.Affordance.Kind in its order; every fit has kinds to propose from', () => {
  const src = fs.readFileSync(path.join(ROOT, 'mod/src/main/java/dev/larattalabs/architect/api/Affordance.java'), 'utf8');
  const k = /enum Kind \{\s*([A-Z_,\s]+);/.exec(src)[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  assert.deepEqual(AFFORDANCE_KINDS, k);
  assert.deepEqual(Object.keys(FIT_AFFORDANCES), FIT_IDS);
  for (const ks of Object.values(FIT_AFFORDANCES)) for (const x of ks) assert.ok(AFFORDANCE_KINDS.includes(x));
  assert.deepEqual(['south', 'west', 'north', 'east'].map(rotationFacing), ['none', 'clockwise_90', 'clockwise_180', 'counterclockwise_90']);
});

const EXPECT = {
  cliff_face: { kinds: ['cliff_face'], normal: { cliff_face: 'south' } },
  tunnel_hill: { kinds: ['cliff_face'], normal: { cliff_face: 'south' } },
  rift_site: { kinds: ['cliff_face', 'gap', 'water'] },
  grove: { kinds: ['pad', 'water', 'canopy'], none: ['trunk', 'cliff_face'] },
  overhang: { kinds: ['overhang', 'cliff_face'], normal: { overhang: 'south' }, none: ['cave'] },
  trunk: { kinds: ['trunk', 'canopy'] },
};

test('the six site fixtures: their kinds found, their own frame proposed, deterministic', () => {
  for (const [id, e] of Object.entries(EXPECT)) {
    const { site, vol: v } = fixture(id);
    const r = analyseSite(v, site.lot, site.fit);
    const ks = kinds(r.affordances);
    for (const k of e.kinds) assert.ok(ks.has(k), `${id}: ${k} found (${[...ks].join(', ')})`);
    for (const k of e.none ?? []) assert.ok(!ks.has(k), `${id}: no ${k}`);
    for (const [k, n] of Object.entries(e.normal ?? {})) assert.ok(r.affordances.some((a) => a.kind === k && a.normal === n), `${id}: a ${k} facing ${n}`);
    assert.ok(r.proposed, `${id}: a frame for ${site.fit}`);
    assert.deepEqual({ origin: r.proposed.frame.origin, rotation: r.proposed.frame.rotation }, { origin: site.spec.frame.origin, rotation: site.spec.frame.rotation }, `${id}: the fixture's frame`);
    const pa = r.affordances.find((a) => a.id === r.proposed.affordance);
    assert.ok(FIT_AFFORDANCES[site.fit].includes(pa.kind));
    // deterministic, sorted best first, ids unique and well formed, numbers rounded
    assert.equal(JSON.stringify(analyseSite(v, site.lot, site.fit)), JSON.stringify(r));
    assert.equal(new Set(r.affordances.map((a) => a.id)).size, r.affordances.length);
    for (let n = 1; n < r.affordances.length; n++) assert.ok(r.affordances[n - 1].score >= r.affordances[n].score);
    for (const a of r.affordances) {
      assert.match(a.id, /^[a-z_]+_[0-9a-f]{16}(_\d+)?$/);
      assert.ok(a.id.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(a.id), 'fits SiteSpec.ID');
      assert.equal(a.score, Math.round(a.score * 1000) / 1000);
      assert.ok(a.anchors.length >= 1 && a.anchors.length <= 16);
    }
  }
});

test('the span and suspend fixtures: the gap is 9 across, bearing on both rims; the hang points are under the ceiling', () => {
  const rift = analyseVolume(fixture('rift_site').vol);
  const gap = rift.find((a) => a.kind === 'gap');
  assert.equal(gap.metrics.span, 9);
  assert.equal(gap.metrics.axis, 'x');
  assert.equal(gap.anchors.length, 2);
  for (const id of gap.metrics.faces) assert.ok(rift.some((a) => a.id === id && a.kind === 'cliff_face'));
  const oh = analyseVolume(fixture('overhang').vol).find((a) => a.kind === 'overhang');
  assert.equal(oh.metrics.clearance, 18);
  assert.equal(oh.metrics.thickness, 8);
  for (const p of oh.anchors) assert.equal(p[1], 134, 'the underside (the fixture\'s keep-critical y)');
  const tr = analyseVolume(fixture('trunk').vol).find((a) => a.kind === 'trunk');
  assert.equal(tr.metrics.height, 30);
  assert.deepEqual(tr.metrics.axis, [3456, -1472]);
  assert.equal(tr.metrics.radius.mid, 2.03);
});

test('stable ids: the same land in another window, and land changed outside the box', () => {
  const t = fixture('trunk').vol;
  const a = analyseVolume(t);
  const trunk = a.find((x) => x.kind === 'trunk');
  const b = t.box;
  const smaller = analyseVolume(crop(t, { minX: b.minX + 3, minY: b.minY, minZ: b.minZ + 3, maxX: b.maxX - 3, maxY: b.maxY, maxZ: b.maxZ - 3 }));
  assert.ok(smaller.some((x) => x.id === trunk.id), 'the trunk keeps its id in a window 6 narrower');
  // a pit dug far from the cliff (in the ground at the volume's south edge) leaves the face's id
  const { vol: cv } = fixture('cliff_face');
  const face = analyseVolume(cv).find((x) => x.kind === 'cliff_face');
  const dug = vol([cv.width, cv.height, cv.depth], (i, j, k) => (k >= cv.depth - 3 && i < 3 && j >= 2 ? VC.AIR : cv.classes[(i * cv.depth + k) * cv.height + j]), [cv.box.minX, cv.box.minY, cv.box.minZ]);
  assert.ok(analyseVolume(dug).some((x) => x.id === face.id));
  // the id hashes the box rounded to 4: a 1-cell move that stays in the quantum keeps it, one that crosses it changes it
  const box = { minX: 1, minY: 64, minZ: 9, maxX: 13, maxY: 70, maxZ: 9 };
  assert.equal(affordanceId('cliff_face', box, 'south'), affordanceId('cliff_face', { ...box, minX: 0, maxX: 12 }, 'south'));
  assert.notEqual(affordanceId('cliff_face', box, 'south'), affordanceId('cliff_face', { ...box, maxX: 15 }, 'south'));
  assert.notEqual(affordanceId('cliff_face', box, 'south'), affordanceId('cliff_face', box, 'north'));
});

test('a ledge: a shelf on a cliff with a drop in front and a wall behind; none on flat land or a clifftop', () => {
  // a cliff (normal south) to y 30 with a shelf 3 deep at y 18 (local), the ground at y 6
  const v = vol([24, 36, 32], (i, j, k) => {
    if (k < 10) return j < 31 ? VC.ROCK : VC.AIR;
    if (k < 13 && j <= 18) return VC.ROCK;
    return ground(j);
  }, [100, 50, 200]);
  const a = analyseVolume(v);
  const l = a.find((x) => x.kind === 'ledge' && x.box.minY === 68);
  assert.ok(l, `a ledge at y 68: ${JSON.stringify(a.filter((x) => x.kind === 'ledge'))}`);
  assert.equal(l.normal, 'south');
  assert.equal(l.metrics.depth, 3);
  assert.equal(l.metrics.length, 24);
  assert.ok(l.metrics.drop >= 12);
  for (const p of l.anchors) assert.equal(p[2], 212, 'the lip');
  assert.ok(!analyseVolume(vol([24, 20, 24], (i, j) => ground(j))).some((x) => x.kind === 'ledge'), 'flat land: no ledge');
  // the cliff without its shelf: a clifftop has a drop but no wall
  const plain = vol([24, 36, 32], (i, j, k) => (k < 10 ? (j < 31 ? VC.ROCK : VC.AIR) : ground(j)));
  assert.ok(!analyseVolume(plain).some((x) => x.kind === 'ledge'));
});

test('a cave: enclosed air with a small mouth; an open-sided overhang is not a cave', () => {
  // a rock hill with a 10x5x10 room, its mouth 2x3 on the south
  const v = vol([28, 30, 28], (i, j, k) => {
    if (j >= 26) return VC.AIR;
    if (i >= 9 && i < 19 && k >= 9 && k < 19 && j >= 8 && j < 13) return VC.AIR;
    if (i >= 13 && i < 15 && k >= 19 && j >= 8 && j < 11) return VC.AIR; // the tunnel to the south side
    return VC.ROCK;
  }, [0, 0, 0]);
  const a = analyseVolume(v, { kinds: ['cave'] });
  // the tunnel reaches the volume's side, so it's clipped there but still enclosed
  assert.equal(a.length, 1, JSON.stringify(a));
  assert.equal(a[0].kind, 'cave');
  assert.ok(a[0].metrics.cells >= 500 && a[0].metrics.floorArea >= 100);
  assert.equal(a[0].metrics.ceiling, 5);
  // a mouth open to the sky: the tunnel climbs out on the south (an opening into sky air)
  const m = vol([28, 30, 28], (i, j, k) => {
    if (k >= 24 && j >= 8) return VC.AIR;
    if (j >= 26) return VC.AIR;
    if (i >= 9 && i < 19 && k >= 9 && k < 19 && j >= 8 && j < 13) return VC.AIR;
    if (i >= 13 && i < 15 && k >= 19 && j >= 8 && j < 11) return VC.AIR;
    return VC.ROCK;
  });
  const c = analyseVolume(m, { kinds: ['cave'] });
  assert.equal(c.length, 1);
  assert.equal(c[0].normal, 'south', 'the mouth');
  assert.ok(c[0].metrics.openFaces > 0);
  assert.ok(!analyseVolume(fixture('overhang').vol).some((x) => x.kind === 'cave'), 'the overhang fixture is no cave');
});

test('a spike: an ice pillar 3 wide and 16 tall; a wide mound is none', () => {
  const v = vol([20, 30, 20], (i, j, k) => (j < 6 ? ground(j) : i >= 8 && i < 11 && k >= 8 && k < 11 && j < 22 ? VC.ICE : VC.AIR), [0, 60, 0]);
  const s = analyseVolume(v, { kinds: ['spike'] });
  assert.equal(s.length, 1);
  assert.equal(s[0].metrics.material, 'ice');
  assert.equal(s[0].metrics.height, 16);
  assert.equal(s[0].metrics.width, 3);
  assert.deepEqual(proposeFrame(s, { minX: 4, minY: 66, minZ: 4, maxX: 15, maxY: 80, maxZ: 15 }, 'wrap_trunk').frame.rotation, 'none');
  const mound = vol([20, 30, 20], (i, j, k) => (j < 6 + Math.max(0, 12 - Math.abs(i - 10) - Math.abs(k - 10)) ? VC.ROCK : VC.AIR));
  assert.ok(!analyseVolume(mound).some((x) => x.kind === 'spike'));
  // a normal tree's trunk (6 logs) is neither a trunk nor a spike
  const tree = vol([12, 20, 12], (i, j, k) => (j < 6 ? ground(j) : i === 6 && k === 6 && j < 12 ? VC.LOG : VC.AIR));
  assert.ok(!kinds(analyseVolume(tree)).has('trunk'));
});

test('negatives: flat land is only pads; a 45-degree slope is no cliff face; dry land has no water', () => {
  const flat = analyseVolume(vol([32, 16, 32], (i, j) => ground(j)));
  assert.deepEqual([...kinds(flat)], ['pad']);
  assert.equal(flat.length, 16);
  const slope = vol([32, 40, 32], (i, j, k) => (j < 4 + Math.max(0, 28 - k) ? VC.ROCK : VC.AIR));
  assert.ok(!kinds(analyseVolume(slope)).has('cliff_face'));
  assert.ok(!kinds(analyseVolume(slope)).has('water'));
});

test('the proposed frame turns with the face: a cliff facing east proposes counterclockwise_90; a gap along z clockwise_90', () => {
  const east = vol([32, 30, 24], (i, j, k) => (i < 10 ? (j < 25 ? VC.ROCK : VC.AIR) : ground(j)), [0, 60, 0]);
  const lot = { minX: 10, minY: 66, minZ: 4, maxX: 20, maxY: 80, maxZ: 19 };
  const r = analyseSite(east, lot, 'attach_to_cliff');
  assert.equal(r.proposed.frame.rotation, 'counterclockwise_90');
  assert.deepEqual(r.proposed.frame.origin, [10, 66, 4]);
  assert.equal(analyseSite(east, lot, 'carve_into').proposed.frame.rotation, 'counterclockwise_90');
  assert.equal(analyseSite(east, lot, 'span').proposed, null, 'no gap: no frame for span');
  // the rift turned a quarter: the gap runs along z
  const { vol: rv } = fixture('rift_site');
  const turned = vol([rv.depth, rv.height, rv.width], (i, j, k) => rv.classes[(k * rv.depth + i) * rv.height + j], [0, 52, 0]);
  const g = analyseSite(turned, { minX: 0, minY: 60, minZ: 8, maxX: 15, maxY: 69, maxZ: 23 }, 'span');
  assert.equal(g.affordances.find((a) => a.kind === 'gap').metrics.axis, 'z');
  assert.equal(g.proposed.frame.rotation, 'clockwise_90');
  // preferences and an entrance weight the scores, never the ids
  const p = analyseVolume(east, { prefer: { pad: 2 }, entrance: [0, 66, 0] });
  assert.deepEqual(new Set(p.map((a) => a.id)), new Set(analyseVolume(east).map((a) => a.id)));
  assert.throws(() => analyseVolume(east, { kinds: ['volcano'] }), /unknown affordance kind/);
  assert.throws(() => proposeFrame([], lot, 'hover'), /unknown fit/);
});

test('a region program\'s r.affordances: [] on the first plan (the volume asked), plan.json\'s affordances[] on the second; IR sha untouched by it', async () => {
  const { region } = await import('../lib/region/program.mjs');
  const { planRegion } = await import('../lib/region/plan.mjs');
  const { makeColumns, encodeColumns } = await import('../lib/region/pack.mjs');
  const { site, vol: v } = fixture('cliff_face');
  const b = v.box;
  const c = makeColumns(b.minX, b.minZ, v.width, v.depth, 1);
  for (let n = 0; n < v.width * v.depth; n++) { c.ground[n] = 116; c.height[n] = 116; c.floor[n] = 116; }
  const survey = encodeColumns(c);
  const claim = { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ, minY: -64, maxY: 319 };
  let seen = null;
  const prog = (ask) => ({ id: 'aff_t', default: (ctx) => {
    const r = region(ctx);
    if (ask) seen = r.affordances(b, { kinds: ['cliff_face', 'pad'] });
    r.anchor('entrance', [site.lot.minX, 117, site.lot.maxZ + 4]);
    r.anchor('spawn', [site.lot.minX, 117, site.lot.maxZ + 4]);
    return r;
  } });
  const first = await planRegion({ program: prog(true), programSource: 'aff_t', survey, claim, seed: '1', roles: {} });
  assert.deepEqual(seen, []);
  assert.equal(first.affordances, undefined);
  assert.deepEqual(first.needVolumes, [{ ...b }]);
  const bytes = fs.readFileSync(path.join(FIX, 'cliff_face', 'volume.bin'));
  const second = await planRegion({ program: prog(true), programSource: 'aff_t', survey, claim, seed: '1', roles: {}, volumes: [{ sha: v.sha, box: v.box, bytes, decoded: v }] });
  assert.ok(second.affordances.length >= 2);
  assert.deepEqual(second.affordances.map((a) => a.id), analyseVolume(v, { kinds: ['cliff_face', 'pad'] }).map((a) => a.id));
  assert.deepEqual(seen.map((a) => a.id), second.affordances.map((a) => a.id));
  assert.ok(second.affordances.some((a) => a.kind === 'cliff_face' && a.normal === 'south'));
  // a program that never asks: no member at all, and the same IR as before AF
  const plain = await planRegion({ program: prog(false), programSource: 'aff_t', survey, claim, seed: '1', roles: {} });
  assert.equal(plain.affordances, undefined);
  assert.ok(!('affordances' in plain.ir));
  assert.ok(!('affordances' in second.ir), 'the IR carries no affordances (plan.json does)');
});

// the goldens (kit/test/fixtures/af/<id>.json, the CLI's answer for the fixture's lot and fit): byte-stable across platforms, and the
// shape the mod's SiteAnalysis reads (ApiAFTest). Re-cut with AF_GOLDEN=write node --test kit/test/af-affordances.test.mjs.
test('the goldens: kit/tools/affordances.mjs on four fixtures, byte for byte', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const id of ['cliff_face', 'overhang', 'rift_site', 'trunk']) {
    const { site } = fixture(id);
    const l = site.lot;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'tools', 'affordances.mjs'), path.join(FIX, id, 'volume.bin'), '--lot', [l.minX, l.minY, l.minZ, l.maxX, l.maxY, l.maxZ].join(','), '--fit', site.fit, '--sha', site.spec.volumeSha], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const f = path.join(HERE, 'fixtures', 'af', `${id}.json`);
    if (process.env.AF_GOLDEN === 'write') fs.writeFileSync(f, r.stdout);
    assert.equal(r.stdout, fs.readFileSync(f, 'utf8'), `${id}: the golden`);
    assert.deepEqual(JSON.parse(r.stdout).proposed.frame, site.spec.frame);
  }
});

test('through the plan CLI (kit/tools/region.mjs plan, as the helper runs it): plan.json carries affordances[] only for a program that asks', async () => {
  const os = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const { makeColumns, encodeColumns } = await import('../lib/region/pack.mjs');
  const { site, vol: v } = fixture('cliff_face');
  const b = v.box;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cli-'));
  try {
    const c = makeColumns(b.minX, b.minZ, v.width, v.depth, 1);
    for (let n = 0; n < v.width * v.depth; n++) { c.ground[n] = 116; c.height[n] = 116; c.floor[n] = 116; }
    fs.writeFileSync(path.join(tmp, 'survey.bin'), encodeColumns(c));
    fs.mkdirSync(path.join(tmp, 'volumes'));
    fs.copyFileSync(path.join(FIX, 'cliff_face', 'volume.bin'), path.join(tmp, 'volumes', `${v.sha}.bin`));
    const prog = (ask) => `import { region } from ${JSON.stringify(path.join(ROOT, 'kit', 'lib', 'region', 'program.mjs'))};
export const id = 'aff_cli';
export default (ctx) => { const r = region(ctx); ${ask ? `r.affordances(${JSON.stringify(b)}, { kinds: ['cliff_face'] });` : ''}
  r.anchor('entrance', [${site.lot.minX}, 117, ${site.lot.maxZ + 4}]); r.anchor('spawn', [${site.lot.minX}, 117, ${site.lot.maxZ + 4}]); return r; };\n`;
    const planned = (ask, out) => {
      fs.writeFileSync(path.join(tmp, `p${ask ? 1 : 0}.mjs`), prog(ask));
      const r = spawnSync(process.execPath, [path.join(ROOT, 'kit', 'tools', 'region.mjs'), 'plan', path.join(tmp, `p${ask ? 1 : 0}.mjs`), '--survey', path.join(tmp, 'survey.bin'), '--seed', '1', '--claim', [b.minX, b.minZ, b.maxX, b.maxZ].join(','), '--volumes', path.join(tmp, 'volumes'), '--out', path.join(tmp, out), '--json'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(fs.readFileSync(path.join(tmp, out, 'plan.json'), 'utf8'));
    };
    const asked = planned(true, 'a');
    assert.deepEqual(asked.affordances.map((a) => a.id), analyseVolume(v, { kinds: ['cliff_face'] }).map((a) => a.id));
    assert.ok(asked.affordances.length >= 1);
    const plain = planned(false, 'b');
    assert.ok(!('affordances' in plain));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
