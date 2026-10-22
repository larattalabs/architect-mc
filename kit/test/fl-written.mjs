// (6c FL, Noah's look fixes) What a free zone writes on the ground, read back from the IR alone (the parts' column ops, the roads): the
// road walkways as 4e lays them (frontage.mjs groundWalk, RoadPlan's rules), the verges, lanes, spokes and the hub's paved cells, the
// lamps' light cells. Shared by fl-look.test.mjs. Not a test file.
import { groundWalk } from '../lib/region/frontage.mjs';
import { surveyApi } from '../lib/region/survey.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from '../lib/region/geom.mjs';

const K = (x, z) => `${x},${z}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const LIGHT = /(lantern|torch|end_rod|glowstone|shroomlight|sea_lantern|froglight|campfire|jack_o_lantern|redstone_lamp)/;

/** The (x, z) columns a part's column ops write (every op with `cols`), and the light cells among them. */
function partCols(p) {
  const cols = new Set(), lights = [];
  for (const o of p.ops ?? []) {
    if (!Array.isArray(o.cols)) continue;
    for (let i = 0; i < o.cols.length; i += 5) {
      const x = o.cols[i], z = o.cols[i + 1];
      cols.add(K(x, z));
      const m = o.materials?.[o.cols[i + 4]];
      if (typeof m === 'string' && LIGHT.test(m) && !/_fence|_wall/.test(m)) lights.push([x, o.cols[i + 2], z]);
    }
  }
  return { cols, lights };
}

/** 4e's lanterns of a road with `lanterns` (RoadPlan.lanterns: the first 6 out, then every 12, each assumed placed), beside the walkway. */
function roadLanterns(rd) {
  if (!rd.lanterns) return [];
  const pts = rd.points.map((p) => [p[0], p[2]]);
  const { cells } = centreCells(pts);
  const offs = crossOffsets(rd.width);
  const every = rd.lamp ? rd.lamp.every : 12, first = rd.lamp ? rd.lamp.first : 6;
  const walk = new Set();
  for (const c of cells) { const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)]; const rr = rightOf(segmentAxis(a, b)); for (const k of offs) walk.add(K(c.x + rr[0] * k, c.z + rr[1] * k)); }
  const out = [];
  let since = every - first;
  for (let i = 1; i < cells.length - 1; i++) {
    since += 1;
    if (since + 1e-9 < every) continue;
    const c = cells[i], n = cells[i + 1];
    const dx = Math.sign(n.x - c.x), dz = Math.sign(n.z - c.z);
    for (const side of [offs[offs.length - 1] + 1, offs[0] - 1]) { const qx = c.x + side * -dz, qz = c.z + side * dx; if (!walk.has(K(qx, qz))) { out.push([qx, rd.points[0][1] + 1, qz]); break; } }
    since = 0;
  }
  return out;
}

/**
 * A free zone's written ground (`prefix`: the zone's part prefix, '' for the first village): `{walk: Map (every road item's walkway:
 * centre and side columns, `sure`), verge, lanes, landing, square (Sets "x,z"), boxes [{minX..}], village (its meta), lights [[x, y, z]]
 * (the whole region's), written (every column any ground-stage part writes)}`.
 */
export function flWritten(r, sv, prefix = '') {
  const ir = r.res.ir;
  const S = surveyApi(sv.bytes, sv.claim);
  const village = prefix ? r.res.meta.villageZones?.[prefix] : r.res.meta.village;
  const walk = new Map();
  for (const rd of ir.roads) {
    if (!rd.ext?.['architect_mc:street'] || !rd.id.startsWith(`${prefix}street_`)) continue;
    for (const [k, v] of groundWalk(rd.points, rd.width, S)) { const o = walk.get(k); if (!o || (v.sure && !o.sure)) walk.set(k, v); }
  }
  const byId = new Map(ir.parts.map((p) => [p.id, partCols(p)]));
  const get = (id) => byId.get(id)?.cols ?? new Set();
  const lights = [];
  for (const [, v] of byId) lights.push(...v.lights);
  for (const rd of ir.roads) lights.push(...roadLanterns(rd));
  const written = new Set();
  for (const p of ir.parts) if (p.stage !== 'props') for (const k of get(p.id)) written.add(k);
  const square = new Set([...get(`${prefix}square`)]);
  const landing = new Set([...get(`${prefix}landing`), ...square]);
  return { walk, verge: get(`${prefix}verges`), lanes: get(`${prefix}lanes`), landing, square, green: get(`${prefix}green`), boxes: ir.lots.map((l) => l.box), village, lights, written, S };
}

const inBoxes = (boxes, x, z) => boxes.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ);

/**
 * Item L1 (no grass gap): a column neither written nor in a lot box, with a road's walkway column and a verge column both within 1
 * (Chebyshev), is a gap between the road and its verge. Returns the gap columns.
 */
export function vergeGaps(w) {
  const sureWalk = new Set([...w.walk].filter(([, v]) => v.sure).map(([k]) => k));
  const out = [];
  const seen = new Set();
  for (const k of w.verge) {
    const [x, z] = k.split(',').map(Number);
    for (const [dx, dz] of N8) {
      const X = x + dx, Z = z + dz, q = K(X, Z);
      if (seen.has(q) || w.written.has(q) || sureWalk.has(q) || inBoxes(w.boxes, X, Z) || w.S.waterAt(X, Z)) continue;
      if (N8.some(([ex, ez]) => sureWalk.has(K(X + ex, Z + ez)))) { seen.add(q); out.push([X, Z]); }
    }
  }
  return out;
}

/** Item L2 (no strings): verge columns further than 1 (Chebyshev) from every walkway column. */
export function strayVerges(w) {
  const out = [];
  for (const k of w.verge) {
    const [x, z] = k.split(',').map(Number);
    if (w.walk.has(k)) continue;
    if (!N8.some(([dx, dz]) => w.walk.has(K(x + dx, z + dz)))) out.push([x, z]);
  }
  return out;
}

/**
 * Item L2 (no stubs): the zone's paths (walkways, verges, lanes and spokes, the hub's paved cells) as 4-connected pieces; every piece
 * but the largest is a stub that ends nowhere. Returns the pieces' sizes, largest first.
 */
export function pathPieces(w) {
  const all = new Set([...w.walk.keys(), ...w.verge, ...w.lanes, ...w.landing]);
  const seen = new Set(), sizes = [];
  for (const k of all) {
    if (seen.has(k)) continue;
    let n = 0;
    const st = [k];
    seen.add(k);
    while (st.length) {
      const c = st.pop(); n++;
      const [x, z] = c.split(',').map(Number);
      for (const [dx, dz] of N4) { const q = K(x + dx, z + dz); if (all.has(q) && !seen.has(q)) { seen.add(q); st.push(q); } }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}

/** Item L3: the smallest Chebyshev distance between two lamps' light cells (the whole region's), and the pair. */
export function lampSpacing(w) {
  let best = { d: Infinity, a: null, b: null };
  const L = w.lights;
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const d = Math.max(Math.abs(L[i][0] - L[j][0]), Math.abs(L[i][2] - L[j][2]));
    if (d < best.d) best = { d, a: L[i], b: L[j] };
  }
  return best;
}

/**
 * Item L4: each lot's lane, row by row from its entrance towards its street (the rows across the lot's front axis), at least the
 * entrance's width (the village meta's laneWidth), every lane cell written, and the lane's last row meeting a walkway column (4-next).
 * Returns the problems.
 */
export function laneProblems(w) {
  const out = [];
  const width = w.village.laneWidth ?? 2;
  for (const [id, cells] of Object.entries(w.village.lanes ?? {})) {
    const lot = w.village.lots[id];
    if (!lot) continue;
    const front = w.village.lots[id].front ?? null;
    const across = cells.length ? (() => { const e = lot.entrance; const r = lot.rect; return e[2] === r[1] - 1 || e[2] === r[3] + 1 ? 'x' : 'z'; })() : 'x';
    void front;
    // each row: its lane cells and the road's walkway in line with them (a lane's last row may share a cell with the road it joins)
    const rows = new Map();
    for (const [x, , z] of cells) {
      if (!w.lanes.has(K(x, z))) out.push(`${id}: lane cell ${x},${z} not written`);
      const r = across === 'x' ? z : x;
      const row = rows.get(r) ?? new Set();
      row.add(across === 'x' ? x : z);
      rows.set(r, row);
    }
    for (const [r, row] of rows) {
      const lo = Math.min(...row), hi = Math.max(...row);
      let n = 0;
      for (let a = lo - width; a <= hi + width; a++) {
        const k = across === 'x' ? K(a, r) : K(r, a);
        if (row.has(a) || (w.walk.get(k)?.sure && (row.has(a - 1) || row.has(a + 1)))) n++;
      }
      if (n < width) out.push(`${id}: lane row ${across === 'x' ? 'z' : 'x'}=${r} is ${n} wide (< ${width})`);
    }
    const meets = cells.some(([x, , z]) => N4.some(([dx, dz]) => { const v = w.walk.get(K(x + dx, z + dz)); return v && v.sure; }));
    if (!meets) out.push(`${id}: the lane never meets the road`);
  }
  return out;
}

/**
 * Item L5: the hub's paths end on paving. Every spoke's hub end meets the hub's paved cells (4-next: the square, or the landing round a
 * green or over a bare hub); every open street end within 6 (Chebyshev) of the hub's space has its walkway meet them or a spoke; the
 * zone records which landing it laid. Returns the problems.
 */
export function hubProblems(w, ir, prefix = '') {
  const out = [];
  const v = w.village;
  if (!v.shared) return out;
  if (!v.hubLanding) out.push('no hubLanding recorded');
  const paved = new Set([...w.landing, ...w.green.size && v.shared.kind === 'square' ? w.green : []]);
  const touches = (x, z, set) => set.has(K(x, z)) || N4.some(([dx, dz]) => set.has(K(x + dx, z + dz)));
  for (const [k, sp] of (v.spokes ?? []).entries()) {
    if (!sp.length) { out.push(`spoke ${k + 1}: nothing written`); continue; }
    const [x, z] = sp[0];
    if (!touches(x, z, paved)) out.push(`spoke ${k + 1}: its hub end ${x},${z} meets no paved cell`);
  }
  const [u0, v0, u1, v1] = v.shared.rect;
  const toHub = (x, z) => Math.max(Math.max(u0 - x, 0, x - u1), Math.max(v0 - z, 0, z - v1));
  const ends = new Map();
  for (const rd of ir.roads) {
    if (!rd.ext?.['architect_mc:street'] || !rd.id.startsWith(`${prefix}street_`)) continue;
    for (const p of [rd.points[0], rd.points[rd.points.length - 1]]) { const q = K(p[0], p[2]); ends.set(q, (ends.get(q) ?? 0) + 1); }
  }
  const joined = new Set([...paved, ...w.lanes]);
  for (const [q, n] of ends) {
    if (n !== 1) continue;
    const [x, z] = q.split(',').map(Number);
    if (toHub(x, z) > 6) continue;
    let ok = false;
    for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) { const c = w.walk.get(K(x + dx, z + dz)); if (c?.sure && touches(x + dx, z + dz, joined)) ok = true; }
    if (!ok) out.push(`street end ${x},${z} (${toHub(x, z)} from the hub) meets no paving`);
  }
  return out;
}
