// (7b AF) Site analysis: the affordances of a frozen volume (docs/CONTRACT.md "Phase 7b" §2 and slice AF; SETTLEMENTS §6). A
// deterministic analysis over the voxel classes of an ARVX volume (kit/lib/region/volume.mjs decodeArvx), run at plan time: a region
// program's r.affordances(box) (plan.json `affordances[]`, read by api.Regions.affordances) and the helper's `site.analyse` (the
// mod's api.Survey.site: the lot box plus 8, frozen, analysed, a frame proposed for the asked fit). One implementation, so the
// standalone path and a region plan give the same ids for the same land.
//
// The ten kinds (api.Affordance.Kind, in its order) and their detectors:
//   cliff_face  vertical runs (at least 2 tall) of bearing cells (ROCK, SOIL, ICE) against open air (AIR, PLANT) on one horizontal
//               side, joined along the face (drift at most 1 per step): at least face.minHeight tall and face.minLength long
//   ledge       a level shelf of standable cells (headroom 3) with a drop of at least 3 on one side and a wall rising at least 3 on
//               the other: depth at least 2, length at least 3
//   overhang    bearing cells with at least 4 open cells under them, at least 3 by 3; normal: the side open to the sky
//   cave        a component of open air with no sky over it, mostly enclosed (open faces to sky air at most 20% of its shell)
//   trunk       LOG columns with a run at least 12 tall, joined horizontally; radius from the logs per layer
//   canopy      a LEAVES component with a layer of at least 16 cells over a log run at least 4 tall
//   spike       a vertical chain of narrow (at most 5 by 5) isolated cross-sections of terrain, at least 12 tall, mostly ICE or ROCK
//   water       surface water (the first cell under the open air and leaves is WATER), at least 4 columns at one level
//   gap         two opposing cliff faces facing each other across at most 48 open cells, overlapping by at least 3 in length and height
//   pad         squares of 8 on the world's 8-grid whose ground range is at most 2 and that hold no water (6a's flatAreas, per volume)
//
// Every affordance: {id, kind, box: {minX..maxZ}, anchors: [[x, y, z]], normal: 'north'|'south'|'east'|'west'|null, metrics, score}.
// `id` = `<kind>_<16 hex>`: the sha-256 of the kind, its box with every coordinate rounded to the nearest multiple of 4, and its
// normal, so a re-analysis of unchanged land (or land changed outside the box, or by less than the quantum inside it) gives the
// same id (6d replanning keys on it). Scores are in [0, 1] (a plan's `prefer` weights may lift them), rounded to 3 decimals; every
// metric is an integer or rounded to 2 decimals, so the output is byte-identical on every platform. Sorted best first (score, then id).
import { VC } from './volume.mjs';
import { sha256Hex, canonicalJson } from './pack.mjs';

export const AFFORDANCE_KINDS = Object.freeze(['cliff_face', 'ledge', 'overhang', 'cave', 'trunk', 'canopy', 'spike', 'water', 'gap', 'pad']);
/** The id quantum: boxes are rounded to multiples of this before hashing. */
export const AFFORDANCE_QUANTUM = 4;

/** The detectors' thresholds (SETTLEMENTS §6's h, w, d, a; est., recorded in the as-built). */
export const AFFORDANCE_DEFAULTS = Object.freeze({
  face: Object.freeze({ minHeight: 6, minLength: 4 }),
  ledge: Object.freeze({ minDepth: 2, minLength: 3, headroom: 3, drop: 3, wall: 3 }),
  overhang: Object.freeze({ clearance: 4, minExtent: 3 }),
  cave: Object.freeze({ minCells: 64, maxOpenShare: 0.2, headroom: 3, minFloor: 4 }),
  trunk: Object.freeze({ minHeight: 12 }),
  canopy: Object.freeze({ minArea: 16, minTrunk: 4 }),
  spike: Object.freeze({ maxWidth: 5, minHeight: 12 }),
  water: Object.freeze({ minArea: 4 }),
  gap: Object.freeze({ maxSpan: 48, minOverlap: 3 }),
  pad: Object.freeze({ size: 8, maxRange: 2 }),
  /** at most this many of each kind (the best), and of all kinds together */
  perKind: 16,
  limit: 128,
});

/** Which kinds a fit's frame is proposed from, in preference order (api.FitMode wire names). */
export const FIT_AFFORDANCES = Object.freeze({
  on_pad: Object.freeze(['pad']),
  carve_into: Object.freeze(['cliff_face', 'cave']),
  attach_to_cliff: Object.freeze(['cliff_face']),
  span: Object.freeze(['gap']),
  wrap_trunk: Object.freeze(['trunk', 'spike']),
  suspend: Object.freeze(['overhang', 'canopy']),
});

const DIRS = Object.freeze([
  Object.freeze({ name: 'north', dx: 0, dz: -1 }),
  Object.freeze({ name: 'east', dx: 1, dz: 0 }),
  Object.freeze({ name: 'south', dx: 0, dz: 1 }),
  Object.freeze({ name: 'west', dx: -1, dz: 0 }),
]);
const OPPOSITE = Object.freeze({ north: 'south', south: 'north', east: 'west', west: 'east' });

// the class sets
const OPEN = new Uint8Array(16); OPEN[VC.AIR] = 1; OPEN[VC.PLANT] = 1;
const BEARING = new Uint8Array(16); BEARING[VC.ROCK] = 1; BEARING[VC.SOIL] = 1; BEARING[VC.ICE] = 1;
const TERRAIN = new Uint8Array(16); for (const c of ['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW']) TERRAIN[VC[c]] = 1;
/** passed through when looking down for a column's ground or water (open air, foliage, trunks) */
const OVER = new Uint8Array(16); OVER[VC.AIR] = 1; OVER[VC.PLANT] = 1; OVER[VC.LEAVES] = 1; OVER[VC.LOG] = 1;

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const q = (v) => Math.round(v / AFFORDANCE_QUANTUM) * AFFORDANCE_QUANTUM;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[(s.length - 1) >> 1] : 0; };

/** Evenly spaced picks of at most `m` items (the first and last kept). */
function spread(items, m) {
  if (items.length <= m) return items;
  const out = [];
  for (let k = 0; k < m; k++) out.push(items[Math.floor((k * (items.length - 1)) / (m - 1))]);
  return out;
}

/** The stable id of an affordance: its kind, its box rounded to the quantum and its normal. */
export function affordanceId(kind, box, normal = null) {
  const qb = { minX: q(box.minX), minY: q(box.minY), minZ: q(box.minZ), maxX: q(box.maxX), maxY: q(box.maxY), maxZ: q(box.maxZ) };
  return `${kind}_${sha256Hex(canonicalJson({ kind, box: qb, normal: normal ?? null })).slice(0, 16)}`;
}

/** A grid over a decoded volume in local coordinates (i = x - minX, j = y - minY, k = z - minZ). */
function gridOf(v) {
  const W = v.width, H = v.height, D = v.depth, c = v.classes, b = v.box;
  const idx = (i, j, k) => (i * D + k) * H + j;
  const inside = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < W && j < H && k < D;
  const cls = (i, j, k) => (inside(i, j, k) ? c[idx(i, j, k)] : VC.MISSING);
  const world = (i, j, k) => [b.minX + i, b.minY + j, b.minZ + k];
  return { W, H, D, b, idx, inside, cls, world, c };
}

function boxOf(cells, g) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const [i, j, k] of cells) {
    if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; if (k < z0) z0 = k; if (k > z1) z1 = k;
  }
  return { minX: g.b.minX + x0, minY: g.b.minY + y0, minZ: g.b.minZ + z0, maxX: g.b.minX + x1, maxY: g.b.minY + y1, maxZ: g.b.minZ + z1 };
}

/** Does a local-coordinate box touch the volume's sides (its extent beyond is unknown)? */
function clippedBox(box, g) {
  return box.minX === g.b.minX || box.minZ === g.b.minZ || box.maxX === g.b.maxX || box.maxZ === g.b.maxZ || box.minY === g.b.minY || box.maxY === g.b.maxY;
}

/** Connected components over a list of keys with a neighbour function (keys: integers). Deterministic: seeds in key order. */
function components(keys, neighbours) {
  const set = new Set(keys);
  const seen = new Set();
  const out = [];
  const sorted = [...keys].sort((a, b) => a - b);
  for (const s of sorted) {
    if (seen.has(s)) continue;
    seen.add(s);
    const comp = [s];
    for (let h = 0; h < comp.length; h++) {
      for (const n of neighbours(comp[h])) if (set.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); }
    }
    out.push(comp);
  }
  return out;
}

// ---------------------------------------------------------------- cliff faces

function faces(g, o) {
  const { W, H, D, idx, cls } = g;
  const out = [];
  for (const d of DIRS) {
    const exposed = (i, j, k) => BEARING[cls(i, j, k)] && g.inside(i + d.dx, j, k + d.dz) && OPEN[cls(i + d.dx, j, k + d.dz)];
    const keys = [];
    for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) {
      if (exposed(i, j, k) && (exposed(i, j + 1, k) || exposed(i, j - 1, k))) keys.push(idx(i, j, k));
    }
    if (!keys.length) continue;
    const dec = (key) => { const j = key % H, col = (key - j) / H, k = col % D, i = (col - k) / D; return [i, j, k]; };
    const alongX = d.dz !== 0; // the face runs along x (normal north or south), else along z
    const neighbours = (key) => {
      const [i, j, k] = dec(key);
      const n = [];
      for (const dy of [-1, 0, 1]) for (const du of dy === 0 ? [-1, 1] : [0]) for (const dt of [-1, 0, 1]) {
        const ii = alongX ? i + du : i + dt, kk = alongX ? k + dt : k + du, jj = j + dy;
        if (g.inside(ii, jj, kk)) n.push(idx(ii, jj, kk));
      }
      return n;
    };
    for (const comp of components(keys, neighbours)) {
      const cells = comp.map(dec);
      const ys = cells.map((c) => c[1]), us = cells.map((c) => (alongX ? c[0] : c[2])), ts = cells.map((c) => (alongX ? c[2] : c[0]));
      const height = Math.max(...ys) - Math.min(...ys) + 1, length = Math.max(...us) - Math.min(...us) + 1;
      const drift = Math.max(...ts) - Math.min(...ts);
      if (height < o.face.minHeight || length < o.face.minLength || drift > Math.max(2, Math.ceil(height / 2))) continue;
      // exposure: the share of face cells with at least 4 open cells straight out (or the volume's side)
      let open4 = 0;
      for (const [i, j, k] of cells) {
        let n = 0;
        for (let s = 1; s <= 4; s++) { const c2 = cls(i + d.dx * s, j, k + d.dz * s); if (c2 === VC.MISSING && !g.inside(i + d.dx * s, j, k + d.dz * s)) { n = 4; break; } if (!OPEN[c2]) break; n++; }
        if (n >= 4) open4++;
      }
      const exposure = open4 / cells.length;
      // the bearing row: the row nearest the middle with the most cells; anchors along it, west to east (or north to south)
      const rows = new Map();
      for (const c of cells) rows.set(c[1], (rows.get(c[1]) ?? 0) + 1);
      const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
      const row = [...rows.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - mid) - Math.abs(b[0] - mid) || a[0] - b[0])[0][0];
      const rowCells = cells.filter((c) => c[1] === row).sort((a, b) => (alongX ? a[0] - b[0] || a[2] - b[2] : a[2] - b[2] || a[0] - b[0]));
      const box = boxOf(cells, g);
      out.push({
        kind: 'cliff_face', box, normal: d.name, anchors: spread(rowCells, 16).map((c) => g.world(...c)),
        metrics: { cells: cells.length, height, length, drift, planarity: r2(ts.reduce((s, t) => s + Math.abs(t - median(ts)), 0) / ts.length), exposure: r2(exposure), clipped: clippedBox(box, g) },
        raw: { cells, d, alongX, t: median(ts) },
        score: 0.7 * (cells.length / (cells.length + 64)) + 0.3 * exposure,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- gaps (from the faces)

function gaps(fs, g, o) {
  const out = [];
  for (const a of fs) {
    if (a.normal !== 'south' && a.normal !== 'east') continue; // each pair once: from the face whose normal points +z or +x
    for (const b of fs) {
      if (b.normal !== OPPOSITE[a.normal]) continue;
      const alongX = a.raw.alongX;
      const tA = a.raw.t, tB = b.raw.t;
      const span = tB - tA - 1;
      if (span < 1 || span > o.gap.maxSpan) continue;
      const u0 = alongX ? Math.max(a.box.minX, b.box.minX) : Math.max(a.box.minZ, b.box.minZ);
      const u1 = alongX ? Math.min(a.box.maxX, b.box.maxX) : Math.min(a.box.maxZ, b.box.maxZ);
      const y0 = Math.max(a.box.minY, b.box.minY), y1 = Math.min(a.box.maxY, b.box.maxY);
      if (u1 - u0 + 1 < o.gap.minOverlap || y1 - y0 + 1 < o.gap.minOverlap) continue;
      // the midline between them is open at the overlap's middle
      const um = Math.floor((u0 + u1) / 2), ym = Math.floor((y0 + y1) / 2) - g.b.minY;
      let open = 0;
      for (let t = tA + 1; t < tB; t++) {
        const i = alongX ? um - g.b.minX : t, k = alongX ? t : um - g.b.minZ;
        if (OPEN[g.cls(i, ym, k)]) open++;
      }
      if (open * 5 < span * 4) continue;
      const tw = (t) => (alongX ? g.b.minZ + t : g.b.minX + t);
      const box = alongX ? { minX: u0, minY: y0, minZ: tw(tA), maxX: u1, maxY: y1, maxZ: tw(tB) } : { minX: tw(tA), minY: y0, minZ: u0, maxX: tw(tB), maxY: y1, maxZ: u1 };
      // the rims: each face's top cell at the overlap's middle (or the nearest)
      const rim = (f) => {
        const cells = f.raw.cells.map((c) => g.world(...c));
        const u = (c) => (alongX ? c[0] : c[2]);
        return [...cells].sort((p, r) => Math.abs(u(p) - um) - Math.abs(u(r) - um) || r[1] - p[1] || p[0] - r[0] || p[2] - r[2])[0];
      };
      const length = u1 - u0 + 1, height = y1 - y0 + 1;
      out.push({
        kind: 'gap', box, normal: null, anchors: [rim(a), rim(b)],
        metrics: { span, length, height, axis: alongX ? 'z' : 'x', faces: [a.id, b.id], clipped: clippedBox(box, g) },
        score: (length * height) / (length * height + 64) * (span <= 16 ? 1 : 16 / span),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- ledges

function ledges(g, o) {
  const { W, H, D, idx, cls } = g;
  const L = o.ledge;
  const stand = (i, j, k) => {
    if (!TERRAIN[cls(i, j, k)]) return false;
    for (let h = 1; h <= L.headroom; h++) if (!g.inside(i, j + h, k) || !OPEN[cls(i, j + h, k)]) return false;
    return true;
  };
  const keys = [];
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) if (stand(i, j, k)) keys.push(idx(i, j, k));
  const dec = (key) => { const j = key % H, col = (key - j) / H, k = col % D, i = (col - k) / D; return [i, j, k]; };
  const neighbours = (key) => {
    const [i, j, k] = dec(key);
    return DIRS.filter((d) => g.inside(i + d.dx, j, k + d.dz)).map((d) => idx(i + d.dx, j, k + d.dz));
  };
  const out = [];
  for (const comp of components(keys, neighbours)) {
    const cells = comp.map(dec);
    const set = new Set(comp);
    let best = null;
    for (const d of DIRS) {
      const lips = [];
      let walls = 0;
      for (const [i, j, k] of cells) {
        const ni = i + d.dx, nk = k + d.dz;
        if (g.inside(ni, j, nk) && !set.has(idx(ni, j, nk))) {
          let drop = 0;
          for (let y = j; y >= 0 && OPEN[cls(ni, y, nk)]; y--) drop++;
          if (drop >= L.drop) lips.push([i, j, k, drop]);
        }
        const bi = i - d.dx, bk = k - d.dz;
        let rise = 0;
        for (let h = 1; h <= L.wall && g.inside(bi, j + h, bk) && BEARING[cls(bi, j + h, bk)]; h++) rise++;
        if (rise >= L.wall) walls++;
      }
      if (lips.length && walls && (!best || lips.length > best.lips.length)) best = { d, lips, walls };
    }
    if (!best) continue;
    const alongX = best.d.dz !== 0;
    const is = cells.map((c) => c[0]), ks = cells.map((c) => c[2]);
    const ext = (a) => Math.max(...a) - Math.min(...a) + 1;
    const depth = alongX ? ext(ks) : ext(is), length = alongX ? ext(is) : ext(ks);
    if (depth < L.minDepth || length < L.minLength) continue;
    const box0 = boxOf(cells, g);
    const box = { ...box0, maxY: box0.maxY + L.headroom };
    const lipCells = best.lips.map((l) => [l[0], l[1], l[2]]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const drop = Math.min(...best.lips.map((l) => l[3]));
    out.push({
      kind: 'ledge', box, normal: best.d.name, anchors: spread(lipCells, 16).map((c) => g.world(...c)),
      metrics: { area: cells.length, depth, length, drop, walls: best.walls, clipped: clippedBox(box, g) },
      score: 0.7 * (cells.length / (cells.length + 16)) + 0.3 * (Math.min(drop, 16) / 16),
    });
  }
  return out;
}

// ---------------------------------------------------------------- overhangs

function overhangs(g, o) {
  const { W, H, D, idx, cls } = g;
  const C = o.overhang;
  const under = (i, j, k) => { let n = 0; for (let y = j - 1; y >= 0 && OPEN[cls(i, y, k)]; y--) n++; return n; };
  const keys = [];
  const clear = new Map();
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 1; j < H; j++) {
    if (!BEARING[cls(i, j, k)] || !OPEN[cls(i, j - 1, k)]) continue;
    const n = under(i, j, k);
    if (n >= C.clearance) { const key = idx(i, j, k); keys.push(key); clear.set(key, n); }
  }
  const dec = (key) => { const j = key % H, col = (key - j) / H, k = col % D, i = (col - k) / D; return [i, j, k]; };
  const neighbours = (key) => {
    const [i, j, k] = dec(key);
    const n = [];
    for (const d of DIRS) for (const dy of [-1, 0, 1]) if (g.inside(i + d.dx, j + dy, k + d.dz)) n.push(idx(i + d.dx, j + dy, k + d.dz));
    return n;
  };
  // a column open from this level up to the volume's top: the sky side
  const sky = (i, j, k) => { for (let y = j; y < H; y++) if (!OPEN[cls(i, y, k)]) return false; return g.inside(i, j, k); };
  const out = [];
  for (const comp of components(keys, neighbours)) {
    const cells = comp.map(dec);
    const is = cells.map((c) => c[0]), ks = cells.map((c) => c[2]);
    const ext = Math.min(Math.max(...is) - Math.min(...is) + 1, Math.max(...ks) - Math.min(...ks) + 1);
    if (cells.length < C.minExtent * C.minExtent || ext < C.minExtent) continue;
    const cols = new Set(cells.map(([i, , k]) => i * D + k));
    let best = null;
    for (const d of DIRS) {
      let n = 0;
      for (const [i, j, k] of cells) if (!cols.has((i + d.dx) * D + (k + d.dz)) && sky(i + d.dx, j - 1, k + d.dz)) n++;
      if (n > 0 && (!best || n > best.n)) best = { d, n };
    }
    const clears = comp.map((key) => clear.get(key));
    const thick = cells.map(([i, j, k]) => { let n = 0; for (let y = j; y < H && BEARING[cls(i, y, k)]; y++) n++; return n; });
    const box0 = boxOf(cells, g);
    const box = { ...box0, minY: Math.min(...cells.map(([, j], h) => j - clears[h])) + g.b.minY };
    // hang points: the cells nearest the bbox corners inset by 2 (or less on a small one), then the centre
    const [i0, i1, k0, k1] = [Math.min(...is), Math.max(...is), Math.min(...ks), Math.max(...ks)];
    const ins = Math.min(2, Math.floor((Math.min(i1 - i0, k1 - k0)) / 2));
    const targets = [[i0 + ins, k0 + ins], [i1 - ins, k0 + ins], [i0 + ins, k1 - ins], [i1 - ins, k1 - ins], [Math.floor((i0 + i1) / 2), Math.floor((k0 + k1) / 2)]];
    const anchors = [];
    const taken = new Set();
    for (const [ti, tk] of targets) {
      let pick = null, pd = Infinity;
      for (const c of cells) {
        const dd = (c[0] - ti) ** 2 + (c[2] - tk) ** 2;
        if (dd < pd || (dd === pd && (c[1] < pick[1] || (c[1] === pick[1] && (c[0] < pick[0] || (c[0] === pick[0] && c[2] < pick[2])))))) { pick = c; pd = dd; }
      }
      const key = pick.join(',');
      if (!taken.has(key)) { taken.add(key); anchors.push(g.world(...pick)); }
    }
    const mc = median(clears), mt = median(thick);
    out.push({
      kind: 'overhang', box, normal: best ? best.d.name : null, anchors,
      metrics: { area: cells.length, extent: ext, clearance: mc, thickness: mt, clipped: clippedBox(box, g) },
      score: 0.6 * (cells.length / (cells.length + 64)) + 0.2 * (Math.min(mc, 16) / 16) + 0.2 * (Math.min(mt, 4) / 4),
    });
  }
  return out;
}

// ---------------------------------------------------------------- caves

function caves(g, o) {
  const { W, H, D, idx, cls, c } = g;
  const C = o.cave;
  // sky: open cells with only open cells above them to the volume's top
  const skyCell = new Uint8Array(W * H * D);
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) {
    for (let j = H - 1; j >= 0; j--) { const x = idx(i, j, k); if (!OPEN[c[x]]) break; skyCell[x] = 1; }
  }
  const seen = new Uint8Array(W * H * D);
  const out = [];
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) {
    const s = idx(i, j, k);
    if (seen[s] || skyCell[s] || !OPEN[c[s]]) continue;
    seen[s] = 1;
    const comp = [[i, j, k]];
    let shell = 0, openFaces = 0, clipped = false;
    const dirOpen = { north: 0, south: 0, east: 0, west: 0 };
    for (let h = 0; h < comp.length; h++) {
      const [a, b, e] = comp[h];
      if (a === 0 || e === 0 || a === W - 1 || e === D - 1 || b === 0) clipped = true;
      for (const [dx, dy, dz] of N6) {
        const na = a + dx, nb = b + dy, ne = e + dz;
        if (!g.inside(na, nb, ne)) continue;
        const n = idx(na, nb, ne);
        if (OPEN[c[n]] && !skyCell[n]) { if (!seen[n]) { seen[n] = 1; comp.push([na, nb, ne]); } continue; }
        shell++;
        if (skyCell[n]) {
          openFaces++;
          if (dz === -1) dirOpen.north++; else if (dz === 1) dirOpen.south++; else if (dx === 1) dirOpen.east++; else if (dx === -1) dirOpen.west++;
        }
      }
    }
    if (comp.length < C.minCells) continue;
    const share = shell ? openFaces / shell : 1;
    if (share > C.maxOpenShare) continue;
    const floor = comp.filter(([a, b, e]) => TERRAIN[cls(a, b - 1, e)]);
    if (floor.length < C.minFloor) continue;
    let ceiling = 0;
    for (const [a, b, e] of floor) { let n = 0; for (let y = b; y < H && OPEN[cls(a, y, e)] && !skyCell[idx(a, y, e)]; y++) n++; if (n > ceiling) ceiling = n; }
    if (ceiling < C.headroom) continue;
    const box = boxOf(comp, g);
    const cx = floor.reduce((s, p) => s + p[0], 0) / floor.length, cz = floor.reduce((s, p) => s + p[2], 0) / floor.length;
    const centre = [...floor].sort((p, r) => ((p[0] - cx) ** 2 + (p[2] - cz) ** 2) - ((r[0] - cx) ** 2 + (r[2] - cz) ** 2) || p[1] - r[1] || p[0] - r[0] || p[2] - r[2])[0];
    let normal = null, nb = 0;
    for (const d of DIRS) if (dirOpen[d.name] > nb) { nb = dirOpen[d.name]; normal = d.name; }
    out.push({
      kind: 'cave', box, normal, anchors: [g.world(...centre)],
      metrics: { cells: comp.length, floorArea: floor.length, ceiling, openFaces, openShare: r2(share), clipped },
      score: 0.7 * (comp.length / (comp.length + 512)) + 0.3 * (1 - share),
    });
  }
  return out;
}

// ---------------------------------------------------------------- trunks and canopies

function trunks(g, o) {
  const { W, H, D, cls } = g;
  const runs = new Map(); // col -> [j0, j1] of its longest log run
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) {
    let best = null;
    for (let j = 0; j < H; j++) {
      if (cls(i, j, k) !== VC.LOG) continue;
      let e = j;
      while (e + 1 < H && cls(i, e + 1, k) === VC.LOG) e++;
      if (!best || e - j > best[1] - best[0]) best = [j, e];
      j = e;
    }
    if (best && best[1] - best[0] + 1 >= o.trunk.minHeight) runs.set(i * D + k, best);
  }
  const neighbours = (col) => {
    const i = Math.floor(col / D), k = col % D, n = [];
    for (let di = -1; di <= 1; di++) for (let dk = -1; dk <= 1; dk++) {
      if ((di || dk) && i + di >= 0 && i + di < W && k + dk >= 0 && k + dk < D) {
        const m = (i + di) * D + (k + dk), a = runs.get(col), b = runs.get(m);
        if (b && a[0] <= b[1] && b[0] <= a[1]) n.push(m);
      }
    }
    return n;
  };
  const out = [];
  for (const comp of components([...runs.keys()], neighbours)) {
    const cols = comp.map((col) => [Math.floor(col / D), col % D, runs.get(col)]);
    const j0 = Math.min(...cols.map((c) => c[2][0])), j1 = Math.max(...cols.map((c) => c[2][1]));
    const cx = Math.floor(cols.reduce((s, c) => s + c[0], 0) / cols.length + 0.5), cz = Math.floor(cols.reduce((s, c) => s + c[1], 0) / cols.length + 0.5);
    const radiusAt = (j) => { let n = 0; for (const c of cols) if (cls(c[0], j, c[1]) === VC.LOG) n++; return r2(Math.sqrt(n / Math.PI)); };
    const height = j1 - j0 + 1;
    const cells = cols.flatMap((c) => [[c[0], j0, c[1]], [c[0], j1, c[1]]]);
    const box = boxOf(cells, g);
    const mid = radiusAt(Math.floor((j0 + j1) / 2));
    out.push({
      kind: 'trunk', box, normal: null, anchors: [g.world(cx, j0, cz), g.world(cx, j1, cz)],
      metrics: { height, columns: cols.length, radius: { base: radiusAt(j0), mid, top: radiusAt(j1) }, axis: [g.b.minX + cx, g.b.minZ + cz], clipped: clippedBox(box, g) },
      score: 0.6 * (height / (height + 16)) + 0.4 * (Math.min(mid, 3) / 3),
    });
  }
  return out;
}

function canopies(g, o) {
  const { W, H, D, idx, cls } = g;
  const keys = [];
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) for (let j = 0; j < H; j++) if (cls(i, j, k) === VC.LEAVES) keys.push(idx(i, j, k));
  const dec = (key) => { const j = key % H, col = (key - j) / H, k = col % D, i = (col - k) / D; return [i, j, k]; };
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const neighbours = (key) => { const [i, j, k] = dec(key); return N6.filter(([a, b, e]) => g.inside(i + a, j + b, k + e)).map(([a, b, e]) => idx(i + a, j + b, k + e)); };
  const out = [];
  for (const comp of components(keys, neighbours)) {
    const cells = comp.map(dec);
    const layers = new Map();
    for (const c of cells) layers.set(c[1], (layers.get(c[1]) ?? 0) + 1);
    const [bestY, area] = [...layers.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (area < o.canopy.minArea) continue;
    // a trunk under it: a log run of at least minTrunk straight under one of its cells
    const tops = [];
    for (const [i, j, k] of cells) {
      if (cls(i, j - 1, k) !== VC.LOG) continue;
      let n = 0;
      for (let y = j - 1; y >= 0 && cls(i, y, k) === VC.LOG; y--) n++;
      if (n >= o.canopy.minTrunk) tops.push([i, j - 1, k]);
    }
    if (!tops.length) continue;
    tops.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    const box = boxOf(cells, g);
    out.push({
      kind: 'canopy', box, normal: null, anchors: spread(tops, 4).map((c) => g.world(...c)),
      metrics: { area, layerY: g.b.minY + bestY, layers: [...layers.values()].filter((n) => n >= o.canopy.minArea).length, cells: cells.length, trunks: tops.length, clipped: clippedBox(box, g) },
      score: area / (area + 64),
    });
  }
  return out;
}

// ---------------------------------------------------------------- spikes

function spikes(g, o) {
  const { W, H, D, cls } = g;
  const S = o.spike;
  // per layer: 8-connected components of terrain cells; the narrow ones (at most maxWidth on both axes)
  const narrow = []; // {j, cells: [[i, k]], ice, rock}
  const at = new Map(); // j * W * D + i * D + k -> narrow index
  for (let j = 0; j < H; j++) {
    const seen = new Uint8Array(W * D);
    for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) {
      if (seen[i * D + k] || !TERRAIN[cls(i, j, k)]) continue;
      seen[i * D + k] = 1;
      const comp = [[i, k]];
      let wide = false;
      let i0 = i, i1 = i, k0 = k, k1 = k;
      for (let h = 0; h < comp.length && !wide; h++) {
        const [a, e] = comp[h];
        for (let da = -1; da <= 1; da++) for (let de = -1; de <= 1; de++) {
          const na = a + da, ne = e + de;
          if ((!da && !de) || na < 0 || ne < 0 || na >= W || ne >= D || seen[na * D + ne] || !TERRAIN[cls(na, j, ne)]) continue;
          seen[na * D + ne] = 1; comp.push([na, ne]);
          i0 = Math.min(i0, na); i1 = Math.max(i1, na); k0 = Math.min(k0, ne); k1 = Math.max(k1, ne);
          if (i1 - i0 + 1 > S.maxWidth || k1 - k0 + 1 > S.maxWidth) wide = true;
        }
      }
      if (wide) {
        // finish marking the wide component so its cells don't seed narrow ones
        for (let h = 0; h < comp.length; h++) {
          const [a, e] = comp[h];
          for (let da = -1; da <= 1; da++) for (let de = -1; de <= 1; de++) {
            const na = a + da, ne = e + de;
            if (na < 0 || ne < 0 || na >= W || ne >= D || seen[na * D + ne] || !TERRAIN[cls(na, j, ne)]) continue;
            seen[na * D + ne] = 1; comp.push([na, ne]);
          }
        }
        continue;
      }
      // not touching the volume's sides (its width beyond is unknown)
      if (i0 === 0 || k0 === 0 || i1 === W - 1 || k1 === D - 1) continue;
      let ice = 0, rock = 0;
      for (const [a, e] of comp) { const c2 = cls(a, j, e); if (c2 === VC.ICE) ice++; else if (c2 === VC.ROCK) rock++; }
      const n = narrow.length;
      narrow.push({ j, cells: comp, ice, rock });
      for (const [a, e] of comp) at.set(j * W * D + a * D + e, n);
    }
  }
  // chain narrow sections vertically (one shares a column with one a layer up)
  const parent = narrow.map((_, n) => n);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let n = 0; n < narrow.length; n++) {
    const s = narrow[n];
    for (const [a, e] of s.cells) {
      const m = at.get((s.j + 1) * W * D + a * D + e);
      if (m !== undefined) { const ra = find(n), rb = find(m); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
    }
  }
  const groups = new Map();
  for (let n = 0; n < narrow.length; n++) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(narrow[n]); }
  const out = [];
  for (const secs of groups.values()) {
    const j0 = Math.min(...secs.map((s) => s.j)), j1 = Math.max(...secs.map((s) => s.j));
    const height = j1 - j0 + 1;
    if (height < S.minHeight) continue;
    const ice = secs.reduce((s, x) => s + x.ice, 0), rock = secs.reduce((s, x) => s + x.rock, 0), cells = secs.reduce((s, x) => s + x.cells.length, 0);
    if ((ice + rock) * 2 < cells) continue;
    const all = secs.flatMap((s) => s.cells.map(([a, e]) => [a, s.j, e]));
    const box = boxOf(all, g);
    const width = Math.max(...secs.map((s) => { const a = s.cells.map((c) => c[0]), e = s.cells.map((c) => c[1]); return Math.max(Math.max(...a) - Math.min(...a), Math.max(...e) - Math.min(...e)) + 1; }));
    const bottom = secs.filter((s) => s.j === j0)[0].cells.slice().sort((p, r) => p[0] - r[0] || p[1] - r[1])[0];
    const top = secs.filter((s) => s.j === j1)[0].cells.slice().sort((p, r) => p[0] - r[0] || p[1] - r[1])[0];
    out.push({
      kind: 'spike', box, normal: null, anchors: [g.world(bottom[0], j0, bottom[1]), g.world(top[0], j1, top[1])],
      metrics: { height, width, cells, material: ice >= rock ? 'ice' : 'rock', clipped: clippedBox(box, g) },
      score: height / (height + 16),
    });
  }
  return out;
}

// ---------------------------------------------------------------- surface: water and pads

/** Per column: {y: the ground or water surface (local), water: depth or 0, ok: a terrain or water top} under open air and foliage. */
function surface(g) {
  const { W, H, D, cls } = g;
  const top = new Int32Array(W * D).fill(-1), depth = new Int32Array(W * D), kind = new Uint8Array(W * D); // 0 none, 1 ground, 2 water
  for (let i = 0; i < W; i++) for (let k = 0; k < D; k++) {
    let j = H - 1;
    while (j >= 0 && OVER[cls(i, j, k)]) j--;
    if (j < 0) continue;
    const c = cls(i, j, k);
    const col = i * D + k;
    if (c === VC.WATER) {
      let n = 0;
      for (let y = j; y >= 0 && cls(i, y, k) === VC.WATER; y--) n++;
      top[col] = j; depth[col] = n; kind[col] = 2;
    } else if (TERRAIN[c] && j < H - 1) { top[col] = j; kind[col] = 1; }
  }
  return { top, depth, kind };
}

function waters(g, sf, o) {
  const { W, D } = g;
  const keys = [];
  for (let col = 0; col < W * D; col++) if (sf.kind[col] === 2) keys.push(col);
  const neighbours = (col) => {
    const i = Math.floor(col / D), k = col % D;
    return DIRS.filter((d) => i + d.dx >= 0 && i + d.dx < W && k + d.dz >= 0 && k + d.dz < D).map((d) => (i + d.dx) * D + (k + d.dz)).filter((m) => sf.top[m] === sf.top[col]);
  };
  const out = [];
  for (const comp of components(keys, neighbours)) {
    if (comp.length < o.water.minArea) continue;
    const depths = comp.map((col) => sf.depth[col]);
    const maxDepth = Math.max(...depths);
    const j = sf.top[comp[0]];
    const cells = comp.flatMap((col) => [[Math.floor(col / D), j, col % D], [Math.floor(col / D), j - maxDepth + 1, col % D]]);
    const box = boxOf(cells, g);
    const deepest = [...comp].sort((a, b) => sf.depth[b] - sf.depth[a] || a - b)[0];
    out.push({
      kind: 'water', box, normal: null, anchors: [g.world(Math.floor(deepest / D), j, deepest % D)],
      metrics: { area: comp.length, surfaceY: g.b.minY + j, maxDepth, meanDepth: r2(depths.reduce((s, x) => s + x, 0) / depths.length), clipped: clippedBox(box, g) },
      score: comp.length / (comp.length + 64),
    });
  }
  return out;
}

function pads(g, sf, o) {
  const { D } = g;
  const P = o.pad, n = P.size;
  const out = [];
  const x0 = Math.ceil(g.b.minX / n) * n, z0 = Math.ceil(g.b.minZ / n) * n;
  for (let z = z0; z + n - 1 <= g.b.maxZ; z += n) for (let x = x0; x + n - 1 <= g.b.maxX; x += n) {
    const ys = [];
    let ok = true;
    for (let dz = 0; dz < n && ok; dz++) for (let dx = 0; dx < n; dx++) {
      const col = (x + dx - g.b.minX) * D + (z + dz - g.b.minZ);
      if (sf.kind[col] !== 1) { ok = false; break; }
      ys.push(sf.top[col]);
    }
    if (!ok) continue;
    const range = Math.max(...ys) - Math.min(...ys);
    if (range > P.maxRange) continue;
    const y = g.b.minY + median(ys);
    const box = { minX: x, minY: y, minZ: z, maxX: x + n - 1, maxY: y, maxZ: z + n - 1 };
    out.push({
      kind: 'pad', box, normal: null, anchors: [[x + (n >> 1), y, z + (n >> 1)]],
      metrics: { size: n, range, y },
      score: 0.5 * ((P.maxRange + 1 - range) / (P.maxRange + 1)), // a plain pad ranks under the rarer kinds
    });
  }
  return out;
}

// ---------------------------------------------------------------- the analysis

function merged(o = {}) {
  const out = {};
  for (const [k, v] of Object.entries(AFFORDANCE_DEFAULTS)) out[k] = v && typeof v === 'object' ? { ...v, ...(o[k] ?? {}) } : (o[k] ?? v);
  return out;
}

const boxCentre = (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];

/**
 * The affordances of a decoded ARVX volume (decodeArvx's object). Options: `kinds` (a subset of AFFORDANCE_KINDS; default all),
 * the detectors' thresholds by name (AFFORDANCE_DEFAULTS' shape), `prefer` ({kind: weight}: multiplies a kind's scores; a plan's
 * preferences), `entrance` ([x, y, z]: scores weighted by access, 64 / (64 + distance to the box's centre)), `perKind`, `limit`.
 * Returns the affordances best first (score, then id). Deterministic and platform-independent.
 */
export function analyseVolume(volume, opts = {}) {
  const o = merged(opts);
  const want = new Set(opts.kinds ?? AFFORDANCE_KINDS);
  for (const k of want) if (!AFFORDANCE_KINDS.includes(k)) throw new Error(`unknown affordance kind ${JSON.stringify(k)} (one of ${AFFORDANCE_KINDS.join(', ')})`);
  const g = gridOf(volume);
  let found = [];
  const fs = want.has('cliff_face') || want.has('gap') ? faces(g, o) : [];
  for (const f of fs) f.id = affordanceId('cliff_face', f.box, f.normal);
  if (want.has('cliff_face')) found.push(...fs);
  if (want.has('gap')) found.push(...gaps(fs, g, o));
  if (want.has('ledge')) found.push(...ledges(g, o));
  if (want.has('overhang')) found.push(...overhangs(g, o));
  if (want.has('cave')) found.push(...caves(g, o));
  if (want.has('trunk')) found.push(...trunks(g, o));
  if (want.has('canopy')) found.push(...canopies(g, o));
  if (want.has('spike')) found.push(...spikes(g, o));
  if (want.has('water') || want.has('pad')) {
    const sf = surface(g);
    if (want.has('water')) found.push(...waters(g, sf, o));
    if (want.has('pad')) found.push(...pads(g, sf, o));
  }
  const prefer = opts.prefer ?? {};
  const ent = Array.isArray(opts.entrance) && opts.entrance.length === 3 ? opts.entrance : null;
  found = found.map((a) => {
    let s = a.score * (Number.isFinite(prefer[a.kind]) ? prefer[a.kind] : 1);
    if (ent) {
      const c = boxCentre(a.box);
      const dist = Math.sqrt((c[0] - ent[0]) ** 2 + (c[1] - ent[1]) ** 2 + (c[2] - ent[2]) ** 2);
      s *= 0.5 + 0.5 * (64 / (64 + dist));
    }
    return { id: a.id ?? affordanceId(a.kind, a.box, a.normal), kind: a.kind, box: a.box, anchors: a.anchors, normal: a.normal ?? null, metrics: a.metrics, score: r3(Math.max(0, s)) };
  });
  // two affordances of one kind quantized alike: the later (in box order) gets a suffix
  found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || canonicalJson(a.box).localeCompare(canonicalJson(b.box)) || String(a.normal).localeCompare(String(b.normal)));
  const ids = new Map();
  for (const a of found) {
    const n = ids.get(a.id) ?? 0;
    ids.set(a.id, n + 1);
    if (n) a.id = `${a.id}_${n + 1}`;
  }
  found.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const per = new Map();
  const out = [];
  for (const a of found) {
    const n = per.get(a.kind) ?? 0;
    if (n >= o.perKind) continue;
    per.set(a.kind, n + 1);
    out.push(a);
    if (out.length >= o.limit) break;
  }
  return out;
}

const intersects = (a, b) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY && a.minZ <= b.maxZ && b.minZ <= a.maxZ;

/** The site frame rotation whose design front (south) faces `normal` (api.SiteFrame's lowercase Minecraft names). */
export function rotationFacing(normal) {
  return { south: 'none', west: 'clockwise_90', north: 'clockwise_180', east: 'counterclockwise_90' }[normal] ?? 'none';
}

/**
 * The frame proposed for a lot and a fit (api.Survey.site's `proposed`): the best affordance (by score) of the fit's kinds
 * (FIT_AFFORDANCES) whose box meets the lot box or touches it (a face just outside the lot it fronts). Origin = the lot box's minimum corner (the rotated template box is the lot);
 * rotation: the design's front (south) faces the affordance's normal (a face, a ledge, an overhang, a cave's mouth); a gap along z
 * turns the design a quarter (its ports, west and east in design coordinates, meet the two rims); a trunk, spike, canopy or pad keeps
 * `none`. `{frame: {origin, rotation}, affordance: id}` or null when no affordance of the fit's kinds meets the lot.
 */
export function proposeFrame(affordances, lot, fit) {
  const kinds = FIT_AFFORDANCES[fit];
  if (!kinds) throw new Error(`unknown fit ${JSON.stringify(fit)}`);
  const near = { minX: lot.minX - 1, minY: lot.minY - 1, minZ: lot.minZ - 1, maxX: lot.maxX + 1, maxY: lot.maxY + 1, maxZ: lot.maxZ + 1 };
  const a = affordances.find((x) => kinds.includes(x.kind) && intersects(x.box, near));
  if (!a) return null;
  const rotation = a.kind === 'gap' ? (a.metrics.axis === 'z' ? 'clockwise_90' : 'none') : rotationFacing(a.normal);
  return { frame: { origin: [lot.minX, lot.minY, lot.minZ], rotation }, affordance: a.id };
}

/**
 * Survey.site's analysis (the helper's `site.analyse`): the affordances of the frozen volume (the lot box plus 8), and the frame
 * proposed for `fit`. `{affordances, proposed: {frame, affordance} | null}`.
 */
export function analyseSite(volume, lot, fit, opts = {}) {
  const affordances = analyseVolume(volume, opts);
  return { affordances, proposed: proposeFrame(affordances, lot, fit) };
}
