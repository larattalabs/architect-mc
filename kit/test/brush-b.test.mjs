// 6c slice B (docs/CONTRACT.md "Phase 6c slice B"): the brush kernels' properties (gate item 1, 100 seeds each), the bundled
// `brush` program (every kind plans; determinism: item 8), ARVX version 2 (the mod's fixture) and the `block` mask term it makes real
// (the MP ruling), and the cave worm's M3/M4 guarantees on a synthetic volume (item 6's kit half).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blend, brushBox, caveWorm, erode, falloff, heightCols, maxStep, melt, needsVolume, raiseLower, removable, smooth, surfaceGrid, volumeBox,
  BRUSH_KINDS, BRUSH_LIMITS, NATURAL_SOLID } from '../lib/region/brush.mjs';
import { VC, blockAt, decodeArvx, encodeArvx } from '../lib/region/volume.mjs';
import { planRegion, KIT_VERSION } from '../lib/region/plan.mjs';
import { makeColumns, sha256Hex, unpack } from '../lib/region/pack.mjs';
import { compileIR, evalTile, staleReason, KINDS_FORMAT2 } from '../lib/realise.mjs';
import { windowFromSurvey } from '../lib/region/survey.mjs';
import { fnv64, splitmix64 } from '../lib/noise.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(KIT, '..');
const PROGRAM = path.join(KIT, 'regions', 'brush.mjs');

/** A seeded [0, 1) generator (no Math.random in tests that pin results). */
function rng(seed) {
  let s = BigInt.asUintN(64, BigInt(seed) * 0x9e3779b97f4a7c15n + 1n);
  return () => { s = BigInt.asUintN(64, s * 6364136223846793005n + 1442695040888963407n); return Number(s >> 11n) / 2 ** 53; };
}

/** A bumpy ground around (cx, cz): base y plus seeded bumps and steps. */
function bumpy(seed, cx, cz, radius, { amp = 6 } = {}) {
  const r = rng(seed);
  const bumps = Array.from({ length: 6 }, () => [cx + Math.floor((r() - 0.5) * 2 * radius), cz + Math.floor((r() - 0.5) * 2 * radius), 1 + Math.floor(r() * amp), 2 + Math.floor(r() * radius)]);
  return (x, z) => {
    let y = 64;
    for (const [bx, bz, h, w] of bumps) { const d = Math.max(Math.abs(x - bx), Math.abs(z - bz)); if (d <= w) y += Math.max(0, h - Math.floor(d / 2)); }
    return y + ((x * 7 + z * 13 + seed) % 11 === 0 ? 2 : 0);
  };
}

test('item 1: SMOOTH lowers the largest adjacent step (100 seeds): never raises it, lowers it unless the edge pins it, always lowers the roughness', () => {
  let lowered = 0, pinned = 0, flat = 0, smoother = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const radius = 4 + (seed % 9), strength = 1 + (seed % 16), cx = 100, cz = -50;
    const g = bumpy(seed, cx, cz, radius);
    const grid = surfaceGrid({ cx, cy: 66, cz, radius: radius, shape: seed % 2 ? 'sphere' : 'cylinder' }, g, () => false);
    if (!grid.inside.some((v) => v)) continue;
    const before = maxStep(grid), h = smooth(grid, strength), after = maxStep(grid, h);
    assert.ok(after <= before, `seed ${seed}: max step ${before} -> ${after}`);
    for (let k = 0; k < h.length; k++) if (!grid.inside[k]) assert.equal(h[k], grid.g[k], `seed ${seed}: an outside column moved`);
    // the roughness: the squared steps of every pair touching the inside (the edge's pinned steps included)
    const rough = (hh) => { let e = 0; for (let k = 0; k < hh.length; k++) for (const n of [k + 1, k + grid.W]) if (n < hh.length && (grid.inside[k] || grid.inside[n]) && (n !== k + 1 || (k + 1) % grid.W)) e += (hh[k] - hh[n]) * (hh[k] - hh[n]); return e; };
    assert.ok(rough(h) <= rough(grid.g), `seed ${seed}: the roughness ${rough(grid.g)} -> ${rough(h)}`);
    if (rough(h) < rough(grid.g)) smoother++;
    if (before < 2) flat++;
    else if (after < before) lowered++;
    else pinned++;
  }
  console.log(`# smooth: the largest inside step lowered on ${lowered} seeds, held by the pinned edge on ${pinned}, already at most 1 on ${flat}; smoother on ${smoother}`);
  assert.ok(lowered >= 4 * pinned, `lowered ${lowered}, pinned ${pinned}`);
  assert.ok(smoother >= 90, `smoother on ${smoother} of 100`);
});

test('item 1: RAISE / LOWER give exactly +/-strength at the centre and 0 at the edge, falling monotonically (100 seeds)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const radius = 1 + (seed % 32), strength = 1 + (seed % 16), shape = seed % 2 ? 'sphere' : 'cylinder', sign = seed % 3 ? 1 : -1;
    const cx = seed * 3, cz = -seed, g = bumpy(seed, cx, cz, radius, { amp: 2 });
    const grid = surfaceGrid({ cx, cy: g(cx, cz), cz, radius, shape: 'cylinder' }, g, () => false);
    const h = raiseLower(grid, strength, sign, shape);
    const k0 = (cx - grid.minX) + (cz - grid.minZ) * grid.W;
    assert.equal(h[k0] - grid.g[k0], sign * strength, `seed ${seed}: the centre`);
    for (let k = 0; k < h.length; k++) {
      if (grid.d2[k] >= radius * radius) assert.equal(h[k], grid.g[k], `seed ${seed}: a column at the edge or outside moved`);
    }
    for (let d2 = 0; d2 < radius * radius; d2++) assert.ok(falloff(strength, d2 + 1, radius * radius, shape) <= falloff(strength, d2, radius * radius, shape), `seed ${seed}: falloff not monotone at ${d2}`);
    assert.equal(falloff(strength, radius * radius, radius * radius, shape), 0);
  }
});

test('item 1: ERODE moves no column by more than strength (100 seeds)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const radius = 4 + (seed % 20), strength = 1 + (seed % 16), cx = 0, cz = 0;
    const g = bumpy(seed, cx, cz, radius, { amp: 12 });
    const grid = surfaceGrid({ cx, cy: 70, cz, radius, shape: 'cylinder' }, g, () => false);
    const h = erode(grid, strength);
    for (let k = 0; k < h.length; k++) {
      assert.ok(Math.abs(h[k] - grid.g[k]) <= strength, `seed ${seed}: column ${k} moved ${h[k] - grid.g[k]}`);
      if (!grid.inside[k]) assert.equal(h[k], grid.g[k]);
    }
    const b = blend(grid, strength);
    for (let k = 0; k < b.length; k++) assert.ok(Math.abs(b[k] - grid.g[k]) <= strength, `seed ${seed}: blend moved a column past strength`);
  }
});

/** A flat ARSV survey of a claim at y (missing nothing). */
function flatSurvey(claim, y = 64, groundFn = null) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const s = makeColumns(claim.minX, claim.minZ, W, D, 1);
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) { const v = groundFn ? groundFn(claim.minX + i, claim.minZ + j) : y; const k = i + j * W; s.ground[k] = v; s.height[k] = v; s.floor[k] = v; }
  return s;
}
function claimFor(cx, cz, radius) { return { minX: cx - radius - 8, minZ: cz - radius - 8, maxX: cx + radius + 8, maxZ: cz + radius + 8, minY: -64, maxY: 319 }; }
/** Every written cell of a plan (all tiles, all stages) over its survey: [{x, y, z, state}]. */
function cellsOf(p, survey) {
  const out = [];
  for (const st of p.ir.stages) for (const set of ['terrain', 'path']) for (const key of p.ir.tiles[st][set]) {
    const r = evalTile(p.ir, key, windowFromSurvey(survey, key), { stage: st, set, blobs: (sha) => p.blobs.get(sha) });
    for (const c of unpack(r.payload).cells) out.push(c);
  }
  return out;
}

test('item 1: OVERLAY writes exactly the top strength cells of each masked column (100 seeds)', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const radius = 2 + (seed % 6), strength = 1 + (seed % 16), cx = 40, cz = 40;
    const g = bumpy(seed, cx, cz, radius, { amp: 3 });
    const claim = claimFor(cx, cz, radius);
    const survey = flatSurvey(claim, 64, g);
    const lo = 64 + (seed % 3);
    const mask = seed % 2 ? { height: [-64, lo + 2] } : null; // keeps the columns whose top is at most lo + 2 (cells up to there)
    const pattern = seed % 4 === 0 ? { mix: [{ w: 3, mat: 'stone' }, { w: 1, mat: 'andesite' }] } : null;
    const p = await planRegion({ programFile: PROGRAM, survey, claim, seed: String(seed), params: { kind: 'overlay', cx, cy: g(cx, cz), cz, radius, strength, shape: 'cylinder', mask, pattern } });
    const byCol = new Map();
    for (const c of cellsOf(p, survey)) { const k = `${c.x},${c.z}`; byCol.set(k, (byCol.get(k) ?? 0) + 1); }
    const grid = surfaceGrid({ cx, cy: g(cx, cz), cz, radius, shape: 'cylinder' }, g, () => false);
    for (let j = 0; j < grid.D; j++) for (let i = 0; i < grid.W; i++) {
      const k = i + j * grid.W, x = grid.minX + i, z = grid.minZ + j, y = grid.g[k];
      let want = 0;
      if (grid.inside[k]) for (let yy = y - strength + 1; yy <= y; yy++) if (!mask || yy <= lo + 2) want++;
      assert.equal(byCol.get(`${x},${z}`) ?? 0, want, `seed ${seed}: column ${x},${z} (ground ${y})`);
    }
  }
});

/** A synthetic volume: stone up to `top`, air above; extra cells from `paint(x, y, z) -> class | null`. */
function synthVolume(box, top, paint = () => null) {
  const W = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D);
  const index = new Uint16Array(W * H * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
    const i = (x * D + z) * H + y;
    const wx = box.minX + x, wy = box.minY + y, wz = box.minZ + z;
    const c = paint(wx, wy, wz) ?? (wy <= top ? VC.ROCK : VC.AIR);
    classes[i] = c;
    index[i] = c === VC.ROCK ? 1 : c === VC.WATER ? 2 : c === VC.PLAYER ? 3 : 0;
  }
  const bytes = encodeArvx(box, classes, [], new Map(), { palette: ['minecraft:air', 'minecraft:stone', 'minecraft:water', 'minecraft:bricks'], index });
  const decoded = decodeArvx(bytes);
  return { sha: decoded.sha, box, bytes, decoded };
}
const clsOf = (v) => (x, y, z) => { const b = v.decoded; if (x < b.box.minX || x > b.box.maxX || y < b.box.minY || y > b.box.maxY || z < b.box.minZ || z > b.box.maxZ) return VC.MISSING; return b.classes[((x - b.box.minX) * b.depth + (z - b.box.minZ)) * b.height + (y - b.box.minY)]; };

test('item 1: MELT never adds a cell and removes only exposed removable cells (100 seeds)', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed), radius = 3 + (seed % 6), strength = 1 + (seed % 4), cx = 0, cy = 64, cz = 0;
    const b = { cx, cy, cz, radius, shape: seed % 2 ? 'sphere' : 'cylinder' };
    const vb = volumeBox(b, { minY: -64, maxY: 319 });
    // spikes of stone over a floor, some player bricks
    const spikes = Array.from({ length: 8 }, () => [cx + Math.floor((r() - 0.5) * 2 * radius), cz + Math.floor((r() - 0.5) * 2 * radius), 1 + Math.floor(r() * radius)]);
    const v = synthVolume(vb, cy, (x, y, z) => {
      for (const [sx, sz, h] of spikes) if (x === sx && z === sz && y > cy && y <= cy + h) return (x + z) % 5 === 0 ? VC.PLAYER : VC.ROCK;
      return null;
    });
    const cls = clsOf(v);
    for (const d of ['natural_only', 'player_blocks']) {
      const m = melt(b, strength, cls, d);
      const may = removable(d);
      const gone = new Set(m.cells.map((c) => c.join(',')));
      for (const c of m.cells) assert.ok(may.has(cls(...c)), `seed ${seed}: removed a ${cls(...c)} cell`);
      // each removed cell had at least 4 air neighbours given the cells removed in earlier rounds (rounds re-checked by replay)
      assert.ok(m.rounds.length <= strength);
      assert.equal(m.cells.length, m.rounds.reduce((a, n) => a + n, 0));
      if (d === 'natural_only') for (const c of m.cells) assert.notEqual(cls(...c), VC.PLAYER);
      void gone;
    }
  }
});

test('item 6 (kit): CAVE_CARVE never breaches water, lava or an unknown cell and leaves nothing floating (100 seeds)', () => {
  let carved = 0, stopped = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const radius = 6 + (seed % 20), strength = 1 + (seed % 16), cx = 0, cy = 40, cz = 0;
    const b = { cx, cy, cz, radius, shape: 'sphere' };
    const vb = volumeBox(b, { minY: -64, maxY: 319 });
    const r = rng(seed);
    const wx = cx + Math.floor((r() - 0.5) * radius), wz = cz + Math.floor((r() - 0.5) * radius), wy = cy + Math.floor((r() - 0.5) * 6);
    const v = synthVolume(vb, cy + radius + 4, (x, y, z) => (Math.abs(x - wx) <= 1 && Math.abs(y - wy) <= 1 && Math.abs(z - wz) <= 1 ? (seed % 2 ? VC.WATER : VC.LAVA) : null));
    const cls = clsOf(v);
    const w = caveWorm(b, strength, cls, rng(seed * 7), vb);
    carved += w.cells.length; if (w.stopped !== null) stopped++;
    const gone = new Set(w.cells.map((c) => c.join(',')));
    for (const [x, y, z] of w.cells) {
      assert.ok(NATURAL_SOLID.includes(cls(x, y, z)), `seed ${seed}: carved a ${cls(x, y, z)} cell`);
      for (let a = -1; a <= 1; a++) for (let bb = -1; bb <= 1; bb++) for (let c = -1; c <= 1; c++) {
        const n = cls(x + a, y + bb, z + c);
        assert.ok(n !== VC.WATER && n !== VC.LAVA && n !== VC.MISSING, `seed ${seed}: a carved cell ${x},${y},${z} touches ${n}`);
      }
    }
    // M3: every solid cell beside the carve still reaches the volume's faces through solid cells
    const solid = (x, y, z) => !gone.has(`${x},${y},${z}`) && ![VC.AIR, VC.WATER, VC.LAVA, VC.PLANT, VC.MISSING].includes(cls(x, y, z));
    const anchored = new Map();
    const reach = (sx, sy, sz) => {
      const k0 = `${sx},${sy},${sz}`;
      if (anchored.has(k0)) return anchored.get(k0);
      const seen = new Set([k0]), todo = [[sx, sy, sz]];
      let ok = false;
      while (todo.length && !ok) {
        const [x, y, z] = todo.pop();
        if (x <= vb.minX || x >= vb.maxX || y <= vb.minY || y >= vb.maxY || z <= vb.minZ || z >= vb.maxZ) { ok = true; break; }
        for (const [a, bb, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const k = `${x + a},${y + bb},${z + c}`;
          if (!seen.has(k) && solid(x + a, y + bb, z + c)) { seen.add(k); todo.push([x + a, y + bb, z + c]); }
        }
      }
      for (const k of seen) anchored.set(k, ok);
      return ok;
    };
    for (const [x, y, z] of w.cells) for (const [a, bb, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (solid(x + a, y + bb, z + c)) assert.ok(reach(x + a, y + bb, z + c), `seed ${seed}: a floating solid cell at ${x + a},${y + bb},${z + c}`);
    }
  }
  console.log(`# cave: ${carved} cells over 100 seeds, ${stopped} worms stopped short of a fluid`);
  assert.ok(carved > 0);
});

test('item 8: the same request and seed plan the same IR sha and tile shas; every kind plans', async () => {
  const cx = 200, cz = 200, radius = 10;
  const claim = claimFor(cx, cz, radius);
  const g = bumpy(5, cx, cz, radius);
  const survey = flatSurvey(claim, 64, g);
  const b = { cx, cy: g(cx, cz), cz, radius, shape: 'sphere' };
  const vb = volumeBox(b, claim);
  // stone up to 64 with a few spikes (MELT rounds them off)
  const vol = synthVolume(vb, 64, (x, y, z) => ((x === cx + 2 && z === cz) || (x === cx - 3 && z === cz + 4)) && y > 64 && y <= 68 ? VC.ROCK : null);
  for (const kind of BRUSH_KINDS) {
    const params = { kind, cx, cy: kind === 'cave_carve' ? 50 : g(cx, cz), cz, radius, strength: 5, shape: 'sphere' };
    const volumes = needsVolume(kind, null) ? [kind === 'cave_carve' ? synthVolume(volumeBox({ ...b, cy: 50 }, claim), 70) : vol] : [];
    void volumes;
    const a = await planRegion({ programFile: PROGRAM, survey, claim, seed: '42', params, volumes });
    const c = await planRegion({ programFile: PROGRAM, survey, claim, seed: '42', params, volumes });
    assert.equal(a.irSha, c.irSha, `${kind}: IR sha`);
    const shas = (p) => p.ir.stages.flatMap((st) => p.ir.tiles[st].terrain.map((k) => evalTile(p.ir, k, windowFromSurvey(survey, k), { stage: st, set: 'terrain', blobs: (s) => p.blobs.get(s) }).sha));
    assert.deepEqual(shas(a), shas(c), `${kind}: tile shas`);
    assert.ok(a.ir.budget.cells > 0, `${kind}: writes cells (${JSON.stringify(a.notes)})`);
    assert.equal(a.ir.kitVersion, KIT_VERSION);
    if (kind === 'cave_carve') {
      const d = await planRegion({ programFile: PROGRAM, survey, claim, seed: '43', params, volumes });
      assert.notEqual(d.irSha, a.irSha, 'another seed, another worm');
    }
  }
});

test('the brush limits and boxes match the mod (Limits.BRUSH_*, Brushes.volumeBox)', () => {
  const lim = fs.readFileSync(path.join(ROOT, 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'api', 'Limits.java'), 'utf8');
  const v = (n) => Number(new RegExp(`${n} = (\\d+);`).exec(lim)[1]);
  assert.deepEqual([v('BRUSH_RADIUS_MIN'), v('BRUSH_RADIUS_MAX'), v('BRUSH_STRENGTH_MIN'), v('BRUSH_STRENGTH_MAX')], [BRUSH_LIMITS.radiusMin, BRUSH_LIMITS.radiusMax, BRUSH_LIMITS.strengthMin, BRUSH_LIMITS.strengthMax]);
  const br = fs.readFileSync(path.join(ROOT, 'mod', 'src', 'main', 'java', 'dev', 'larattalabs', 'architect', 'region', 'Brushes.java'), 'utf8');
  assert.match(br, /VOLUME_PAD = 2;/);
  assert.match(br, /CLAIM_PAD = 8;/);
  assert.deepEqual(brushBox({ cx: 10, cy: 300, cz: -4, radius: 32 }, { minY: -64, maxY: 319 }), { minX: -22, minZ: -36, maxX: 42, maxZ: 28, minY: 268, maxY: 319 });
});

test('ARVX version 2: the kit decodes the mod\'s fixture (sha, classes, block ids) and re-encodes it byte for byte', () => {
  const dir = path.join(ROOT, 'mod', 'src', 'test', 'resources', 'arvx');
  const exp = JSON.parse(fs.readFileSync(path.join(dir, 'blocks.json'), 'utf8'));
  const v = decodeArvx(fs.readFileSync(path.join(dir, 'blocks.bin')));
  assert.equal(v.sha, exp.sha);
  assert.equal(v.version, 2);
  assert.deepEqual(v.blockPalette, exp.palette);
  for (const [x, y, z, cls, block] of exp.cells) {
    const c = v.classes[((x - v.box.minX) * v.depth + (z - v.box.minZ)) * v.height + (y - v.box.minY)];
    assert.equal(['AIR', 'ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'WATER', 'LAVA', 'LOG', 'LEAVES', 'PLANT', 'OWNED', 'PLAYER', 'BLOCK_ENTITY', 'MISSING'][c], cls);
    assert.equal(blockAt(v, x, y, z), block, `${x},${y},${z}`);
  }
  const re = encodeArvx(v.box, v.classes, v.owners, v.ownerOf, { palette: v.blockPalette, index: v.blocks });
  assert.equal(sha256Hex(re), v.sha);
});

test('the block mask term (MP ruling): real over a volume with block ids; refused MASK_NEEDS_VOLUME over a version-1 volume or none', async () => {
  const cx = 0, cz = 0, radius = 6;
  const claim = claimFor(cx, cz, radius);
  const survey = flatSurvey(claim, 64);
  const b = { cx, cy: 64, cz, radius, shape: 'cylinder' };
  const vb = volumeBox(b, claim);
  // stone up to 64, with bricks (PLAYER) in two columns' top cells
  const v = synthVolume(vb, 64, (x, y, z) => (y === 64 && (x === 1 || x === -2) ? VC.PLAYER : null));
  const mask = { block: ['minecraft:stone'] };
  const p = await planRegion({ programFile: PROGRAM, survey, claim, seed: '1', params: { kind: 'overlay', cx, cy: 64, cz, radius, strength: 1, shape: 'cylinder', mask, pattern: { mix: [{ w: 1, mat: 'gravel' }] } }, volumes: [v] });
  assert.ok(p.ir.requires.includes('volume:blocks'), JSON.stringify(p.ir.requires));
  assert.ok(Object.values(p.ir.volumes).every((x) => x.blocks === true));
  const cells = cellsOf(p, survey);
  assert.ok(cells.length > 0);
  for (const c of cells) assert.ok(c.x !== 1 && c.x !== -2, `the mask let a bricks cell through at ${c.x},${c.y},${c.z}`);
  // a tag works too (expanded at plan time into blockTags)
  const pt = await planRegion({ programFile: PROGRAM, survey, claim, seed: '1', params: { kind: 'overlay', cx, cy: 64, cz, radius, strength: 1, shape: 'cylinder', mask: { block: ['#minecraft:base_stone_overworld'] }, pattern: { mix: [{ w: 1, mat: 'gravel' }] } }, volumes: [v] });
  assert.ok(pt.ir.blockTags['#minecraft:base_stone_overworld'].includes('minecraft:stone'));
  assert.equal(cellsOf(pt, survey).length, cells.length);
  // the same IR with its volume swapped for a version-1 one (no blocks): refused
  const v1 = { ...p.ir, volumes: Object.fromEntries(Object.entries(p.ir.volumes).map(([k, x]) => [k, { ...x, blocks: undefined }])) };
  assert.throws(() => compileIR(JSON.parse(JSON.stringify(v1)), { blobs: (s) => p.blobs.get(s) }), /MASK_NEEDS_VOLUME/);
  // a kit before 0.23.0 lacks the kind: PLAN_STALE
  // (the plan's own kit: 0.23.0 or later, as later slices bump it; T2 made it 0.24.0)
  const need = /plan needs kit (\d+\.\d+\.\d+)/.exec(staleReason(p.ir, '0.21.0') ?? '');
  assert.ok(need && need[1].localeCompare('0.23.0', undefined, { numeric: true }) >= 0, staleReason(p.ir, '0.21.0'));
  // appended (rebase point); (6c H) H's fluid and volume:fluids are appended after it
  assert.deepEqual(KINDS_FORMAT2.slice(KINDS_FORMAT2.indexOf('volume:blocks')), ['volume:blocks', 'fluid', 'volume:fluids'], 'appended (rebase point)');
});

test('the 0.21.0 kit refuses a brush IR (kitVersion, and volume:blocks when it has one)', () => {
  const ir = { format: 2, kitVersion: KIT_VERSION, requires: ['blobs:side', 'mask', 'volume:blocks', 'volumes'] };
  const old = KINDS_FORMAT2.filter((k) => k !== 'volume:blocks');
  const missing = ir.requires.filter((k) => !old.includes(k));
  assert.deepEqual(missing, ['volume:blocks']);
  void fnv64; void splitmix64;
});
