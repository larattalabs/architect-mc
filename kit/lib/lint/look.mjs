// (fast checks P2, docs/FAST-CHECKS.md "### 3. Look lint (P2)") The look lint: what a camera shows of a settlement's ground, as rules
// over the virtual world with the 4e lanterns laid (structure.mjs lintWorld), settlement-wide (every zone, every street). Noah's look
// complaints on FL's first gallery (L1-L5, 2026-10-20) generalised; hard rules FAIL, taste rules WARN (Noah's default: "hard checks
// fail, taste checks warn").
//
// The settlement's paving: the walk-flagged top cells of every `street`-kind writer (kit/lib/lint/writers.mjs: the 4e roads, a
// village's street, square, verges, lanes, greens' rings and landings, spokes), one per column. Lot boxes, water and the claim's edge
// are destinations; a route, bridge or tunnel walk is a connector.
//
// Hard (FAIL):
//   L-GAP     a grass seam: a column that is no paving, no lot and no water with the road's walkway on one side and other paving on
//             the other, along x or z
//             (the road's verge laid a cell off the road: L1)
//   L-STRING  a loose string: paving in no 2x2 of paving, not at a lot (a verge or path one cell wide on its own: L2)
//   L-LINK    a one-block link: paving in no 2x2 of paving within 2 of a lot box (a lane narrower than its door: L4)
//   L-STUB    a stub: a piece of paving (4-connected) that is not the largest and touches no connector or claim edge (L2; a lane that
//             reaches its lot but never the street is one)
//   L-END     a path's end in grass: a cap of a path at most 5 wide (a street and its verges) whose next cells hold no destination; `grass` when paving lies 2
//             ahead (the path stops one cell short), else a dead end (L5: spokes and streets that reach the hub end on paving)
//   L-LAMP    two lamps' light cells closer than LAMP_GAP (6, Chebyshev) anywhere in the region (L3: every lamp, the 4e lanterns too)
// Taste (WARN):
//   T-ORGANIC the share of axis-aligned runs (scenario-metrics axisRunShare) over 0.6 for a plan that asks an organic layout
//   T-BATTER  paving with no solid cell under it (a slope pad's batter cut under a verge: a floating cell)
//   T-LAMP    a stranded lamp: no paving or lot within 3 of its post
//   T-PALETTE the share of the settlement's paving in the bible's path roles under 0.9 (when the plan names them)
import { F_WALK, F_WRITTEN } from '../region/vworld.mjs';
import { writerKinds } from './writers.mjs';
import { groundWalk } from './roads.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from '../region/geom.mjs';
import { sampleIndex } from '../region/survey.mjs';
import { FLAG_WATER } from '../region/pack.mjs';

export const LAMP_GAP = 6;
const GREENISH = /^minecraft:(grass_block|moss_block|podzol|mycelium|short_grass|tall_grass|fern|[a-z_]*flower|dandelion|poppy|moss_carpet)(\[|$)/;
const K = (x, z) => `${x},${z}`;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const AXES = [[1, 0], [0, 1]]; // (orthogonal only: a diagonal pair is an inner corner of a verge, not a seam)

function finding(rule, severity, count, sample, message) {
  return { rule, severity, count, sample: sample.slice(0, 12), message };
}

/** The settlement's paving: Map "x,z" -> y (the top walk cell), and the connectors' walk columns. */
export function paving(vw, ir, meta) {
  const kindOf = writerKinds(ir, meta);
  const pave = new Map(), conn = new Set(), maybe = new Set(), road = new Set(), green = new Set(), zone = new Map();
  const zoneOfPart = (id) => String(id ?? '').replace(/(street|square|verges|lanes|green|landing|spokes?|ring|path)(_.*)?$/, '');
  // the 4e roads as RoadPlan lays them (roads.mjs groundWalk), not vworld's per-segment model: vworld's road cells are left out here
  const S = vw.survey;
  const heightAt = (x, z) => S.ground[sampleIndex(S, x, z)];
  const waterAt = (x, z) => (S.flags[sampleIndex(S, x, z)] & FLAG_WATER) !== 0;
  const roadModel = new Set();
  for (const r of ir.roads ?? []) {
    const pts = r.points.map((p) => [p[0], p[2]]);
    const offs = crossOffsets(r.width);
    for (const c of centreCells(pts).cells) { const a = pts[Math.min(c.seg, pts.length - 1)], b = pts[Math.min(c.seg + 1, pts.length - 1)]; const rr = rightOf(segmentAxis(a, b)); for (const k of offs) roadModel.add(K(c.x + rr[0] * k, c.z + rr[1] * k)); }
  }
  const ops = new Set();
  vw.eachWritten((x, y, z, idx, f, part) => {
    const k = kindOf(x, y, z, part).kind;
    // a street's surface under street furniture (a planter or bench on the square) is no walk cell but is paving to the eye
    const under = k === 'street' && !(f & F_WALK) && (vw.flags(x, y + 1, z) & F_WRITTEN) && kindOf(x, y + 1, z, vw.partAt(x, y + 1, z)).kind === 'props';
    if (!(f & F_WALK) && !under) return;
    const key = K(x, z);
    const isRoad = roadModel.has(key) && (ir.roads ?? []).some((r) => r.part === ir.parts[part]?.id) && !(ir.parts[part]?.ops ?? []).length;
    if (isRoad) return;
    // (a green's grass is no paving: only a built or path surface is)
    if (k === 'street' && GREENISH.test(vw.pal.states[idx])) { green.add(key); return; }
    if (k === 'street') { ops.add(key); zone.set(key, zoneOfPart(ir.parts[part]?.id)); if (!pave.has(key) || pave.get(key) < y) pave.set(key, y); } else if (k === 'route' || k === 'bridges' || k === 'tunnels' || k === 'rope') conn.add(key);
  });
  for (const r of ir.roads ?? []) {
    const routeRoad = /^route_/.test(r.id ?? '') || ir.parts.find((p) => p.id === r.part)?.stage === 'routes';
    for (const [key, v] of groundWalk(r.points, r.width, heightAt, waterAt)) {
      if (routeRoad) { if (!pave.has(key)) conn.add(key); continue; }
      if (!v.sure) { if (!pave.has(key)) maybe.add(key); continue; }
      road.add(key);
      if (!zone.has(key)) zone.set(key, String(r.id ?? '').replace(/street.*$/, ''));
      if (!pave.has(key)) pave.set(key, heightAt(v.x, v.z));
    }
  }
  // street furniture standing in the paving (a lamp's post in the verge, a bench, a planter): a prop's column beside paving counts as
  // paving (the path runs round it; it is no gap, no string's end)
  const furniture = new Map();
  vw.eachWritten((x, y, z, idx, f, part) => { if (!(f & F_WALK) && kindOf(x, y, z, part).kind === 'props') { const key = K(x, z); if (!pave.has(key) && N4.some(([dx, dz]) => pave.has(K(x + dx, z + dz)))) furniture.set(key, y - 1); } });
  for (const [key, y] of furniture) if (!pave.has(key)) pave.set(key, y);
  for (const key of conn) if (pave.has(key)) conn.delete(key);
  for (const key of maybe) if (pave.has(key)) maybe.delete(key);
  for (const key of green) if (pave.has(key)) green.delete(key);
  return { pave, conn, maybe, furniture, road, green, zone };
}

/**
 * Lint the look of one plan: `w` = structure.mjs lintWorld's {vw, lant}; `c` the case ({ir, meta, survey, plan?}). -> {findings,
 * metrics}.
 */
export function lookLint(c, w, { lampGap = LAMP_GAP, axisShare = null } = {}) {
  const { vw } = w;
  const P = vw.pal;
  const { ir, meta } = c;
  const findings = [];
  const { pave, conn, maybe, road, green, zone } = paving(vw, ir, meta);
  const claim = ir.claim;
  const lots = (ir.lots ?? []).map((l) => l.box);
  const inLot = (x, z, g = 0) => lots.some((b) => x >= b.minX - g && x <= b.maxX + g && z >= b.minZ - g && z <= b.maxZ + g);
  const atEdge = (x, z, g) => x - claim.minX < g || claim.maxX - x < g || z - claim.minZ < g || claim.maxZ - z < g;
  const P2 = (x, z) => pave.has(K(x, z));
  const water = (x, z) => { const y = vw.colTop(x, z); return P.water[vw.get(x, y, z)] || P.water[vw.get(x, y + 1, z)]; };
  const written = (x, z) => { const y = pave.get(K(x, z)) ?? vw.colTop(x, z); for (let dy = -1; dy <= 2; dy++) if (vw.flags(x, y + dy, z) & F_WRITTEN) return true; return false; };
  const metrics = { paving: pave.size, connectors: conn.size };
  if (!pave.size) return { findings, metrics };

  // ---- L-GAP
  {
    const gaps = [];
    const seen = new Set();
    for (const key of pave.keys()) {
      const [x, z] = key.split(',').map(Number);
      for (const [dx, dz] of N8) {
        const gx = x + dx, gz = z + dz, g = K(gx, gz);
        if (seen.has(g) || P2(gx, gz) || maybe.has(g) || inLot(gx, gz) || water(gx, gz) || conn.has(g) || !vw.inClaim(gx, gz)) continue;
        // a column the plan writes something solid on (a prop, a post, a pad's edge) is no grass seam
        if (written(gx, gz)) continue;
        // (the road's walkway on one side, other paving on the other: the road and its verge, L1)
        if (AXES.some(([ax, az]) => (road.has(K(gx + ax, gz + az)) && P2(gx - ax, gz - az) && !road.has(K(gx - ax, gz - az))) || (road.has(K(gx - ax, gz - az)) && P2(gx + ax, gz + az) && !road.has(K(gx + ax, gz + az))))) { seen.add(g); gaps.push([gx, vw.colTop(gx, gz), gz]); }
      }
    }
    metrics.gaps = gaps.length;
    if (gaps.length) findings.push(finding('L-GAP', 'error', gaps.length, gaps, `${gaps.length} grass column(s) between two pavings (a verge or path laid one cell off the road)`));
  }
  // ---- L-STRING / L-LINK (thin paving): a cell in no 2x2 of paving is thin; a thin cell hugging a thick one (within 1: a verge along a
  // road, a staircase verge on a diagonal) is a verge; a thin cell with no thick neighbour is a string, or a one-block link by a lot
  {
    const thick = new Set(), thin = [];
    for (const key of pave.keys()) {
      const [x, z] = key.split(',').map(Number);
      // (a green's grass counts here: a paved ring round a green, one cell wide, is its edging)
      const G = (a, b) => P2(a, b) || green.has(K(a, b));
      const sq = [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([ox, oz]) => G(x + ox, z + oz) && G(x + ox + 1, z + oz) && G(x + ox, z + oz + 1) && G(x + ox + 1, z + oz + 1));
      if (sq) thick.add(key); else thin.push([x, pave.get(key), z]);
    }
    const loose = thin.filter(([x, , z]) => !N8.some(([dx, dz]) => thick.has(K(x + dx, z + dz))) && !N8.some(([dx, dz]) => conn.has(K(x + dx, z + dz))));
    const link = loose.filter(([x, , z]) => inLot(x, z, 2));
    const str = loose.filter(([x, , z]) => !inLot(x, z, 2));
    metrics.thin = thin.length;
    if (str.length) findings.push(finding('L-STRING', 'error', str.length, str, `${str.length} paving cell(s) one cell wide and off any wider paving (a loose verge or path string)`));
    if (link.length) findings.push(finding('L-LINK', 'error', link.length, link, `${link.length} paving cell(s) one cell wide by a lot (a link to the house narrower than 2)`));
  }
  // ---- L-LINK (by the door): each lot's entrance and the rows out from it to the street, across the lot's front, at least 2 wide
  {
    const narrow = [];
    for (const l of ir.lots ?? []) {
      const b = l.box;
      const e = { north: [Math.floor((b.minX + b.maxX) / 2), b.minZ - 1, 0, -1], south: [Math.floor((b.minX + b.maxX) / 2), b.maxZ + 1, 0, 1], west: [b.minX - 1, Math.floor((b.minZ + b.maxZ) / 2), -1, 0], east: [b.maxX + 1, Math.floor((b.minZ + b.maxZ) / 2), 1, 0] }[l.front];
      if (!e) continue;
      const [ex, ez, ox, oz] = e;
      if (!P2(ex, ez)) continue; // no path at the door (a lot without a lane): not judged here
      const [ax, az] = [Math.abs(oz), Math.abs(ox)]; // across the front
      for (let s = 0; s <= 6; s++) {
        const x = ex + ox * s, z = ez + oz * s;
        if (!P2(x, z)) break;
        if (road.has(K(x, z))) break; // the lane reached the street
        let n = 1;
        for (const sg of [1, -1]) for (let k = 1; k <= 3 && P2(x + ax * k * sg, z + az * k * sg); k++) n++;
        if (n >= 4) break; // a verge or the street's paving: the lane is through
        if (n < 2) { narrow.push([x, pave.get(K(x, z)), z]); break; }
      }
    }
    if (narrow.length) findings.push(finding('L-LINK', 'error', narrow.length, narrow, `${narrow.length} lot(s) whose link from the door is one cell wide (a one-block house link)`));
  }
  // ---- L-STUB
  {
    const seen = new Set(), pieces = [];
    for (const key of pave.keys()) {
      if (seen.has(key)) continue;
      const cells = [], st = [key];
      seen.add(key);
      while (st.length) {
        const q = st.pop(); cells.push(q);
        const [x, z] = q.split(',').map(Number);
        for (const [dx, dz] of N4) { const n = K(x + dx, z + dz); if (pave.has(n) && !seen.has(n)) { seen.add(n); st.push(n); } }
      }
      pieces.push(cells);
    }
    pieces.sort((a, b) => b.length - a.length);
    // per zone (a plan's villages are separate settlements: each zone's largest piece is its network); a piece that reaches only a
    // lot is a stub too (a lane that never meets the street)
    const zoneOfPiece = (cells) => { const n = new Map(); for (const q of cells) { const z = zone.get(q) ?? ''; n.set(z, (n.get(z) ?? 0) + 1); } return [...n].sort((a, b) => b[1] - a[1])[0][0]; };
    const largest = new Set();
    const firstOf = new Map();
    for (const cells of pieces) { const z = zoneOfPiece(cells); if (!firstOf.has(z)) { firstOf.set(z, cells); largest.add(cells); } }
    const stubs = pieces.filter((c) => !largest.has(c)).filter((cells) => !cells.some((q) => { const [x, z] = q.split(',').map(Number); return atEdge(x, z, 2) || N8.some(([dx, dz]) => conn.has(K(x + dx, z + dz)) || maybe.has(K(x + dx, z + dz))); }));
    metrics.pieces = pieces.length;
    if (stubs.length) findings.push(finding('L-STUB', 'error', stubs.length, stubs.map((s) => { const [x, z] = s[0].split(',').map(Number); return [x, pave.get(s[0]), z, s.length]; }), `${stubs.length} piece(s) of paving that join nothing (sizes ${stubs.map((s) => s.length).join(', ')})`));
  }
  // ---- L-END
  {
    const ends = [], grass = [];
    const seen = new Set();
    for (const key of pave.keys()) {
      const [x, z] = key.split(',').map(Number);
      for (const [dx, dz] of N4) {
        if (P2(x + dx, z + dz) || maybe.has(K(x + dx, z + dz)) || !P2(x - dx, z - dz) || !P2(x - 2 * dx, z - 2 * dz)) continue;
        // the cross-section through it, perpendicular to d: at most 3 cells, every one of them ending here too
        const [px, pz] = [-dz, dx];
        let lo = 0, hi = 0;
        while (lo > -5 && P2(x + px * (lo - 1), z + pz * (lo - 1))) lo--;
        while (hi < 5 && P2(x + px * (hi + 1), z + pz * (hi + 1))) hi++;
        if (hi - lo + 1 > 5) continue;
        // a path runs behind it, as narrow (2 and 3 cells back the cross-section is at most 6 too): else it is the side of a wider
        // paving that jogs out (a verge's step beside a street)
        const runAt = (bx, bz) => { let a = 0, b = 0; while (a > -6 && P2(bx + px * (a - 1), bz + pz * (a - 1))) a--; while (b < 6 && P2(bx + px * (b + 1), bz + pz * (b + 1))) b++; return b - a + 1; };
        if (runAt(x - 2 * dx, z - 2 * dz) > hi - lo + 2 || (P2(x - 3 * dx, z - 3 * dz) && runAt(x - 3 * dx, z - 3 * dz) > hi - lo + 2)) continue;
        let cap = true;
        // (and none diagonally ahead: a path on a diagonal runs on as a staircase)
        for (let k = lo - 1; k <= hi + 1 && cap; k++) if (P2(x + px * k + dx, z + pz * k + dz)) cap = false;
        if (!cap) continue;
        const capKey = `${x + px * lo},${z + pz * lo},${dx},${dz}`;
        if (seen.has(capKey)) continue;
        seen.add(capKey);
        // what lies ahead of the cap, in its corridor (its width + 1 either side), up to 6 cells on: a destination next to it (a lot, a
        // connector, water, the claim's edge, a road side the mod may lay) ends it well; other paving, a lot or a prop further on is
        // where it should have reached (it stops in grass short of it); nothing at all is a dead end for a path up to 3 wide (a lane
        // or a spoke to nowhere), an open end for a street (4-5 wide with its verges: a street running out of the settlement)
        let near = false, far = 0;
        for (let s = 1; s <= 6 && !near && !far; s++) for (let k = lo - 1; k <= hi + 1; k++) {
          const ax = x + px * k + dx * s, az = z + pz * k + dz * s, ak = K(ax, az);
          if (!vw.inClaim(ax, az) || water(ax, az) || conn.has(ak) || maybe.has(ak) || (s <= 2 && inLot(ax, az))) { if (s <= 2) near = true; else far = s; break; }
          if (s >= 2 && (P2(ax, az) || inLot(ax, az) || (written(ax, az) && s <= 3))) { far = s; break; }
        }
        if (near || atEdge(x, z, 3)) continue;
        if (far) grass.push([x, pave.get(key), z, dx, dz, far]);
        else if (hi - lo + 1 <= 3) ends.push([x, pave.get(key), z, dx, dz, hi - lo + 1]);
      }
    }
    metrics.ends = ends.length + grass.length;
    if (grass.length) findings.push(finding('L-END', 'error', grass.length, grass, `${grass.length} path end(s) stop one cell of grass short of other paving (a path that ends in grass)`));
    if (ends.length) findings.push(finding('L-END', 'error', ends.length, ends, `${ends.length} path end(s) in grass leading nowhere (a dead end: no lot, connector, water or claim edge ahead)`));
  }
  // ---- L-END (hub): a street that ends at the settlement's shared space (its hub: a square, a green, a bare hub; the plan meta's
  // village shared rects) ends on paving: its walkway at the end meets a paved cell of the hub (or a lane) that is not the road itself
  {
    const hubs = [meta?.village?.shared, ...Object.values(meta?.villageZones ?? {}).map((v) => v?.shared)].filter((h) => h && Array.isArray(h.rect));
    const ends = new Map();
    for (const r of ir.roads ?? []) for (const p of [r.points[0], r.points[r.points.length - 1]]) { const q = K(p[0], p[2]); ends.set(q, (ends.get(q) ?? 0) + 1); }
    const bad = [];
    for (const h of hubs) {
      const [u0, v0, u1, v1] = h.rect;
      const toHub = (x, z) => Math.max(Math.max(u0 - x, 0, x - u1), Math.max(v0 - z, 0, z - v1));
      // (the hub's own paving: the paving that is not road, 4-connected to a paved cell inside the hub's space: its square, its
      // landing or ring, the spokes that reach it)
      const hubSet = new Set();
      const st = [];
      for (let x = u0; x <= u1; x++) for (let z = v0; z <= v1; z++) { const q = K(x, z); if (P2(x, z) && !road.has(q)) { hubSet.add(q); st.push(q); } }
      while (st.length) { const q = st.pop(); const [x, z] = q.split(',').map(Number); for (const [dx, dz] of N4) { const n = K(x + dx, z + dz); if (!hubSet.has(n) && pave.has(n) && !road.has(n)) { hubSet.add(n); st.push(n); } } }
      const hubPaved = (x, z) => hubSet.has(K(x, z));
      for (const [q, n] of ends) {
        if (n !== 1) continue;
        const [x, z] = q.split(',').map(Number);
        if (toHub(x, z) > 6) continue;
        let ok = false;
        for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1 && !ok; dx++) {
          const cx = x + dx, cz = z + dz;
          if (!road.has(K(cx, cz))) continue;
          if (hubPaved(cx, cz) || N4.some(([ex, ez]) => hubPaved(cx + ex, cz + ez))) ok = true;
        }
        if (!ok) bad.push([x, vw.colTop(x, z), z, toHub(x, z)]);
      }
    }
    if (bad.length) findings.push(finding('L-END', 'error', bad.length, bad, `${bad.length} street end(s) at the hub (within 6 of its space) meet no paving (the street ends in the hub's grass)`));
  }
  // ---- L-LAMP (every light the region and the 4e lanterns place)
  {
    // (the settlement's lamps: every light but scattered decor, which its own scatter rules space)
    const kindOf = writerKinds(ir, meta);
    const L = [];
    vw.eachWritten((x, y, z, idx, f, part) => { if (P.emit[idx] > 0 && kindOf(x, y, z, part).kind !== 'scatter') L.push([x, y, z]); });
    const close = [];
    let best = Infinity;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const d = Math.max(Math.abs(L[i][0] - L[j][0]), Math.abs(L[i][2] - L[j][2]));
      if (d < best) best = d;
      if (d < lampGap && Math.abs(L[i][1] - L[j][1]) < 8) close.push([L[i][0], L[i][1], L[i][2], d]);
    }
    metrics.lamps = { count: L.length, closest: Number.isFinite(best) ? best : null };
    if (close.length) findings.push(finding('L-LAMP', 'error', close.length, close, `${close.length} lamp pair(s) closer than ${lampGap} (closest ${best})`));
    // T-LAMP: stranded (no paving or lot within 3 of the light)
    const stranded = L.filter(([x, , z]) => { for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (P2(x + dx, z + dz) || conn.has(K(x + dx, z + dz)) || inLot(x + dx, z + dz)) return false; return true; });
    if (stranded.length) findings.push(finding('T-LAMP', 'warning', stranded.length, stranded, `${stranded.length} lamp(s) with no path or lot within 3 (stranded)`));
  }
  // ---- T-BATTER: paving with nothing solid under it
  {
    const under = [];
    for (const [key, y] of pave) { const [x, z] = key.split(',').map(Number); if (!P.solid[vw.get(x, y - 1, z)] && !P.water[vw.get(x, y - 1, z)]) under.push([x, y, z]); }
    if (under.length) findings.push(finding('T-BATTER', 'warning', under.length, under, `${under.length} paving cell(s) over air (a batter cut under a verge)`));
  }
  // ---- T-ORGANIC
  if (axisShare !== null) {
    metrics.axisShare = axisShare;
    if (axisShare > 0.6) findings.push(finding('T-ORGANIC', 'warning', 1, [], `axis-run share ${axisShare.toFixed(3)} over 0.6 (the layout reads gridded)`));
  }
  // ---- T-PALETTE
  const roles = ir.roles ?? {};
  const want = new Set(['path', 'path_alt', 'verge', 'lane'].map((r) => roles[r]).filter(Boolean).map((s) => s.replace(/\[.*$/, '')));
  if (want.size) {
    let n = 0, ok = 0;
    for (const [key, y] of pave) { const [x, z] = key.split(',').map(Number); n++; if (want.has(P.states[vw.get(x, y, z)].replace(/\[.*$/, '')) || /dirt_path/.test(P.states[vw.get(x, y, z)])) ok++; }
    metrics.paletteShare = n ? ok / n : 1;
    if (n && ok / n < 0.9) findings.push(finding('T-PALETTE', 'warning', n - ok, [], `${n - ok} of ${n} paving cell(s) not in the bible's path roles (${(100 * ok / n).toFixed(0)}%)`));
  }
  return { findings, metrics };
}

/** FAIL lines (errors) and WARN lines (warnings) of a look report. */
export function lookGate(rep) {
  return {
    fails: rep.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule} x${f.count}: ${f.message} ${JSON.stringify(f.sample.slice(0, 4))}`),
    warn: rep.findings.filter((f) => f.severity !== 'error').map((f) => `${f.rule} x${f.count}: ${f.message}`),
  };
}
