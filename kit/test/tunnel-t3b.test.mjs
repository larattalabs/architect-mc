// (6c T3b) Tunnels: the floor profile, the survey-first cover, the corridor box, the geometry's checks in the diagnosis order
// (NO_COVER, SPAN, TOO_STEEP, WATER, PROTECTED, VOLUME) and its cells: bore and cut, the shell's lining, cave sealing, the
// falling-block lining, the 2-cell fluid buffer, portals, lamps and the guard cells (docs/CONTRACT.md "Phase 6c slice T3" §3, §5,
// §6; gate items 2, 4 offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TUNNEL, floorProfile, maxRiseOf, surfaceCover, corridorBox, tunnelLand, tunnelGeom } from '../lib/connectors/tunnelGeom.mjs';
import { deckY } from '../lib/connectors/ropeGeom.mjs';
import { VC, VOXEL_CLASSES, classAt, encodeArvx, decodeArvx } from '../lib/region/volume.mjs';

/**
 * A synthetic ridge world: ground 64, a ridge along z rising to `top` between x `r0` and `r1` (slopes of 1 a cell), soil to 3 under
 * the ground and rock below. `edit(x, y, z)` may return another class name (a sand band, a water pocket, a cave). The volume covers
 * `box` (the corridor).
 */
export function ridge({ r0 = 40, r1 = 90, top = 84, W = 140, D = 64, edit = () => null, box = { minX: 0, minY: 40, minZ: 0, maxX: 139, maxY: 100, maxZ: 63 } } = {}) {
  const groundAt = (x, z) => {
    void z;
    if (x < r0 || x > r1) return 64;
    return Math.min(top, 64 + (x - r0), 64 + (r1 - x));
  };
  const S = { groundAt, missingAt: (x, z) => x < 0 || z < 0 || x >= W || z >= D, waterAt: () => false, frozenAt: () => false };
  const Wb = box.maxX - box.minX + 1, H = box.maxY - box.minY + 1, Db = box.maxZ - box.minZ + 1;
  const cls = new Uint8Array(Wb * H * Db);
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    const g = groundAt(x, z);
    let c = y > g ? 'AIR' : y >= g - 3 ? 'SOIL' : 'ROCK';
    const e = edit(x, y, z, c);
    if (e) c = e;
    cls[((x - box.minX) * Db + (z - box.minZ)) * H + (y - box.minY)] = VC[c];
  }
  const vol = decodeArvx(encodeArvx(box, cls));
  return { S, vol, land: (o = {}) => tunnelLand(S, { volumes: [vol], classOfVolume: (v, x, y, z) => VOXEL_CLASSES[classAt(v, x, y, z)], ...o }) };
}

// a 3x3 tunnel along x through the ridge at z 32: start walk cell (30, 64, 32), landing (101, 64, 32): L = 70 is too long, so the
// tests use a shorter ridge where they need a fit
const A = [30, 64, 32];

test('the floor profile: d = 0, y2(0) = 2 y0, y2(L) = 2 (y0 + rise), steps of at most one half block; the rise limit', () => {
  for (let L = TUNNEL.lengthMin; L <= TUNNEL.lengthMax; L++) for (let rise = -maxRiseOf(L); rise <= maxRiseOf(L); rise++) {
    const ys = floorProfile(L, 64, rise);
    assert.equal(ys[0], 128);
    assert.equal(ys[L], 2 * (64 + rise));
    for (let i = 1; i <= L; i++) assert.ok(Math.abs(ys[i] - ys[i - 1]) <= 1, `L ${L} rise ${rise} i ${i}`);
  }
  assert.equal(maxRiseOf(4), 1);
  assert.equal(maxRiseOf(40), 5);
});

test('surface cover first: a hump with 1 cover over the roof is NO_COVER with no volume read; a ridge has a bore run', () => {
  const low = ridge({ top: 68, r0: 50, r1: 60 });
  const g = tunnelGeom(low.land({ volumes: [] }), A, [1, 0], 40, 0, { width: 3, height: 3 });
  assert.equal(g.code, 'NO_COVER');
  assert.equal(g.evidence.by, 'survey');
  const hi = ridge({ r0: 40, r1: 70, top: 84 });
  const sc = surfaceCover(hi.S.groundAt, A, [1, 0], 50, 0, 3, 3);
  assert.ok(sc.run >= 20, `bore run ${sc.run}`);
  // a hump of exactly height + 1 (1 cover) never makes a bore cell
  const hump = ridge({ top: 68, r0: 30, r1: 90 });
  assert.equal(surfaceCover(hump.S.groundAt, A, [1, 0], 50, 0, 3, 3).run, 0);
});

test('SPAN (65 and the part\'s own length), TOO_STEEP, in order after NO_COVER', () => {
  const w = ridge({ r0: 31, r1: 120, top: 95, W: 200, box: { minX: 0, minY: 40, minZ: 0, maxX: 199, maxY: 100, maxZ: 63 } });
  assert.equal(tunnelGeom(w.land(), A, [1, 0], 65, 0).code, 'SPAN');
  assert.equal(tunnelGeom(w.land(), A, [1, 0], 30, 0, { length: { max: 20 } }).code, 'SPAN');
  assert.equal(tunnelGeom(w.land(), A, [1, 0], 30, 4).code, 'TOO_STEEP');
});

test('a fit: bore and cut cells, every bore cell under 2+ site-solid, height clear, the floor on its profile, portals at the bore ends', () => {
  const w = ridge({ r0: 40, r1: 80, top: 80 });
  const L = 52; // landing at x 83
  const g = tunnelGeom(w.land(), A, [1, 0], L, 0, { width: 3, height: 3 });
  assert.equal(g.ok, true, JSON.stringify(g.evidence));
  const bores = g.bore.filter(Boolean).length;
  assert.ok(bores >= 30, `bore cells ${bores}`);
  for (let i = 1; i <= L; i++) if (g.bore[i]) assert.ok(g.cover[i] >= 2);
  // the void holds `height` over every floor cell
  const V = new Set(g.voids.map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (const [x, y, z, kind] of g.floor) if (kind !== 'bed') for (let h = 1; h <= 3; h++) assert.ok(V.has(`${x},${y + h},${z}`), `clear over ${x},${y},${z}`);
  // 2 portals (the bore's two ends), each with jambs, arch stairs and a lintel
  assert.equal(g.portals.length, 2);
  for (const p of g.portals) {
    assert.equal(p.cells.filter((c) => c[3] === 'lintel').length, 5);
    assert.equal(p.cells.filter((c) => c[3] === 'arch').length, 2);
    assert.equal(p.cells.filter((c) => c[3] === 'jamb').length, 4);
  }
  // rock stays raw: the lined cells are the soil near the surface (the cut walls and the hillside face) and the parapets
  assert.ok(g.lined.length > 0);
  assert.ok(g.lined.every((c) => ['lining', 'face', 'parapet', 'seal', 'gravity'].includes(c[3])));
  assert.ok(g.carved > 0);
  assert.ok(g.lamps.length >= 4, `lamps ${g.lamps.length}`);
  // the guard runs cover the void, the floor and the buffer
  const G = new Set();
  for (let t = 0; t < g.guard.length; t += 4) for (let y = g.guard[t + 2]; y <= g.guard[t + 3]; y++) G.add(`${g.guard[t]},${y},${g.guard[t + 1]}`);
  for (const k of V) assert.ok(G.has(k));
  assert.ok(G.has(`${50},${deckY(g.ys[20]) + 3 + 2},32`), 'the buffer 2 over the roof');
});

test('a sand band over the roof is lined (M3:gravity: it rests on lining, never on air); 0 gravity cells over the void', () => {
  const sand = (x, y) => (x >= 50 && x <= 70 && (y === 68 || y === 69) ? 'LOOSE' : null);
  const w = ridge({ r0: 40, r1: 80, top: 80, edit: sand });
  const g = tunnelGeom(w.land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(g.ok, true, JSON.stringify(g.evidence));
  const L = new Set(g.lined.map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (let x = 50; x <= 70; x++) for (let z = 31; z <= 33; z++) assert.ok(L.has(`${x},68,${z}`), `roof sand at ${x},68,${z} lined`);
  // the band over the void's walls (the shell) is lined too; no LOOSE cell stands on the void
  const V = new Set(g.voids.map((c) => `${c[0]},${c[1]},${c[2]}`));
  for (const [x, y, z] of g.voids) assert.ok(!(sand(x, y + 1) && !L.has(`${x},${y + 1},${z}`) && !V.has(`${x},${y + 1},${z}`)));
  // without the lining (the broken variant) the cells are reported but nothing lined
  const bad = tunnelGeom(w.land(), A, [1, 0], 52, 0, { width: 3, height: 3, _unsafe: { noLining: true } });
  assert.equal(bad.lined.length, 0);
});

test('a cave breaching the bore is sealed with lining; caves away from the shell are left', () => {
  const cave = (x, y, z) => (x >= 58 && x <= 61 && z >= 33 && z <= 36 && y >= 65 && y <= 67 ? 'AIR' : null);
  const w = ridge({ r0: 40, r1: 80, top: 80, edit: cave });
  const g = tunnelGeom(w.land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(g.ok, true);
  const seals = g.lined.filter((c) => c[3] === 'seal').map((c) => `${c[0]},${c[1]},${c[2]}`);
  for (let x = 58; x <= 61; x++) for (let y = 65; y <= 67; y++) assert.ok(seals.includes(`${x},${y},34`), `wall cell ${x},${y},34 sealed`);
  assert.ok(!seals.some((k) => k.endsWith(',35') || k.endsWith(',36')), 'only the shell is sealed');
});

test('fluids: a water pocket 2 from the bore and lava 1 from it refuse WATER with the cells; the same pocket at 3 fits', () => {
  const pocket = (d, kind) => (x, y, z) => (x >= 55 && x <= 57 && z === 33 + d && y >= 65 && y <= 66 ? kind : null);
  const two = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: pocket(2, 'WATER') }).land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(two.code, 'WATER');
  assert.equal(two.evidence.kind, 'water');
  assert.ok(two.evidence.sample.some((c) => c.at[2] === 35 && c.class === 'WATER'));
  const lava = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: pocket(1, 'LAVA') }).land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(lava.code, 'WATER');
  assert.equal(lava.evidence.kind, 'lava');
  const three = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: pocket(3, 'WATER') }).land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(three.ok, true, JSON.stringify(three.evidence));
  // ice counts: an ice cell 2 under the floor
  const ice = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: (x, y, z) => (x === 60 && z === 32 && y === 62 ? 'ICE' : null) }).land(), A, [1, 0], 52, 0, { width: 3, height: 3 });
  assert.equal(ice.code, 'WATER');
  assert.equal(ice.evidence.kind, 'ice');
  // the broken variant: fluidBuffer 0 does not see the pocket at 2
  const b0 = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: pocket(2, 'WATER') }).land(), A, [1, 0], 52, 0, { width: 3, height: 3, _unsafe: { fluidBuffer: 0 } });
  assert.equal(b0.ok, true);
});

test('PROTECTED: under a keep-out column, through an OWNED cell, a route over the roof with under 2 cells between', () => {
  const w = ridge({ r0: 40, r1: 80, top: 80 });
  const ko = tunnelGeom(w.land({ blocked: (x, z) => (x === 60 && z === 32 ? { class: 'PROTECTED_AREA', id: 'area_1' } : null) }), A, [1, 0], 52, 0);
  assert.equal(ko.code, 'PROTECTED');
  assert.equal(ko.evidence.class, 'PROTECTED_AREA');
  const owned = tunnelGeom(ridge({ r0: 40, r1: 80, top: 80, edit: (x, y, z) => (x === 60 && z === 33 && y === 66 ? 'OWNED' : null) }).land(), A, [1, 0], 52, 0);
  assert.equal(owned.code, 'PROTECTED');
  assert.equal(owned.evidence.class, 'OWNED');
  const route = tunnelGeom(w.land({ routeLow: (x) => (x === 60 ? 69 : null) }), A, [1, 0], 52, 0);
  assert.equal(route.code, 'PROTECTED');
  assert.equal(route.evidence.class, 'ROUTE');
  assert.equal(tunnelGeom(w.land({ routeLow: (x) => (x === 60 ? 72 : null) }), A, [1, 0], 52, 0).ok, true, 'a route 3 over the roof shell passes');
});

test('VOLUME: a corridor with no frozen volume (or MISSING cells) is VOLUME after the survey says it has cover', () => {
  const w = ridge({ r0: 40, r1: 80, top: 80 });
  const g = tunnelGeom(w.land({ volumes: [] }), A, [1, 0], 52, 0);
  assert.equal(g.code, 'VOLUME');
  assert.ok(g.evidence.cells > 0);
});

test('the corridor box: the ends dilated by approach + width + 3, from the lower feet - 16 to the highest ground + 1', () => {
  const { box, cells } = corridorBox([30, 65, 32], [83, 65, 32], { approach: 16, width: 3, groundMax: () => 80 });
  assert.deepEqual(box, { minX: 30 - 22, minY: 49, minZ: 32 - 22, maxX: 83 + 22, maxY: 81, maxZ: 32 + 22 });
  assert.equal(cells, (box.maxX - box.minX + 1) * 33 * 45);
});

test('determinism: the same land gives the same cells and guard', () => {
  const w = ridge({ r0: 40, r1: 80, top: 80 });
  const a = tunnelGeom(w.land(), A, [1, 0], 52, 0), b = tunnelGeom(w.land(), A, [1, 0], 52, 0);
  assert.deepEqual(a, b);
});
