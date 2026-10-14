// (6c D2, C27) A district that follows a boundary (a biome edge, a river or shore, a ridge): placed along the traced boundary
// (boundary.mjs) instead of on a survey candidate. Its shape is a cell mask (a band along the boundary), its bounding claim the
// mask's rect, its street a T2 route along the band's middle (on the ridge itself for a ridge), its lots slope pads on both sides of
// the street facing it, each with a one-cell lane to it. districtsEmit.mjs places, routes and emits it with the other districts.
import { normalAt, traceBoundary, familyOf, biomeAt } from './boundary.mjs';
import { FLAG_LAVA, FLAG_MISSING, FLAG_WATER } from './pack.mjs';
import { surfaceOps } from './village.mjs';

/** The lot pads' cut and fill along a following street (slope edges). */
export const FOLLOW_PAD = 6;
/** Columns between the street's centre and a lot's front edge. */
export const FOLLOW_SETBACK = 3;
/** How much further out a following district's lot may sit (a longer lane) where a diagonal street runs on across its front. */
export const FOLLOW_PUSH = 4;

const meets = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const grow = (a, n) => [a[0] - n, a[1] - n, a[2] + n, a[3] + n];

/**
 * Place a following district `d` (`{id, follow, size: [length, depth], side?}`) over the claim: trace its boundary (the piece nearest
 * `near` when given), take a window of `length` cells of it (centred on the point nearest `near`, else the middle), the side (a biome
 * edge: the first family's, `side: 'b'` the second's; a shore: the land; a ridge: both), the street line (the band's middle) and the
 * mask. Windows whose street line meets `blocked` (keep-out, protected areas, a standing region, other districts) are skipped, half a
 * length at a time. Returns `{rect, mask: Set<"x,z">, line: [[x, z]], window: [[x, z]], side, kind, ends}` or `{none: 'NO_EDGE: ...' |
 * 'PROTECTED: ...' | 'OVERLAP: ...'}`.
 */
export function placeFollow({ cols, claim, d, biomes = null, blocked = [], keepOut = [], near = null, exclude = [] }) {
  const [length, depth] = d.size;
  const t = traceBoundary(cols, claim, d.follow, { biomes, near, minLength: Math.min(length, 24) });
  if (t.none) return { none: t.none };
  const spine = t.spine;
  const kind = t.kind;
  const flagsAt = (x, z) => {
    const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution);
    return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? FLAG_MISSING : cols.flags[i + j * cols.width];
  };
  const inClaim = (x, z) => x >= claim.minX + 2 && x <= claim.maxX - 2 && z >= claim.minZ + 2 && z <= claim.maxZ - 2;
  const isBlocked = (x, z) => blocked.some((b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
  const inKeep = (x, z) => keepOut.some((b) => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
  const L = Math.min(length, spine.length);
  // the window's start positions: centred on `near` (or the middle) first, then half a length either way
  const centre = near ? spine.reduce((bi, p, i) => (Math.max(Math.abs(p[0] - near[0]), Math.abs(p[1] - near[1])) < Math.max(Math.abs(spine[bi][0] - near[0]), Math.abs(spine[bi][1] - near[1])) ? i : bi), 0) : spine.length >> 1;
  const starts = [];
  const s0 = Math.max(0, Math.min(spine.length - L, centre - (L >> 1)));
  starts.push(s0);
  for (let k = 1; k <= 8; k++) for (const s of [s0 - k * (L >> 1), s0 + k * (L >> 1)]) if (s >= 0 && s + L <= spine.length && !starts.includes(s)) starts.push(s);
  let why = null;
  for (const s of starts) {
    if (exclude.includes(s)) continue; // (a window whose street did not route: the caller asks for the next)
    const win = spine.slice(s, s + L);
    // the side: the first family's (biome edge), the land (shore), none (ridge)
    let sign = 0;
    if (kind !== 'ridge') {
      let votes = 0;
      win.forEach((p, i) => {
        const [nx, nz] = normalAt(win, i);
        if (kind === 'biome_edge') {
          const want = d.side === 'b' ? d.follow.biome_edge.between[1] : d.follow.biome_edge.between[0];
          const f = familyOf(biomeAt(biomes, Math.round(p[0] + nx * 3), Math.round(p[1] + nz * 3)));
          votes += f === want ? 1 : -1;
        } else votes += flagsAt(Math.round(p[0] + nx * 2), Math.round(p[1] + nz * 2)) & FLAG_WATER ? -1 : 1;
      });
      sign = votes >= 0 ? 1 : -1;
    }
    const off = kind === 'ridge' ? 0 : depth >> 1;
    const lo = kind === 'ridge' ? -(depth >> 1) : 0, hi = kind === 'ridge' ? depth >> 1 : depth;
    const line = [], seen = new Set(), mask = new Set();
    win.forEach((p, i) => {
      const [nx, nz] = normalAt(win, i);
      const q = [Math.round(p[0] + nx * off * sign), Math.round(p[1] + nz * off * sign)];
      const k = `${q[0]},${q[1]}`;
      if (!seen.has(k)) { seen.add(k); line.push(q); }
      for (let tt = lo; tt <= hi; tt++) {
        const x = Math.round(p[0] + nx * tt * (sign || 1)), z = Math.round(p[1] + nz * tt * (sign || 1));
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) mask.add(`${x + dx},${z + dz}`);
      }
    });
    for (const k of [...mask]) {
      const [x, z] = k.split(',').map(Number);
      if (!inClaim(x, z) || flagsAt(x, z) & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING) || isBlocked(x, z) || inKeep(x, z)) mask.delete(k);
    }
    const bad = line.filter(([x, z]) => !inClaim(x, z) || flagsAt(x, z) & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING) || isBlocked(x, z) || inKeep(x, z));
    if (bad.length * 10 > line.length || mask.size < length) {
      why = bad.some(([x, z]) => inKeep(x, z)) ? `PROTECTED: the ${kind.replace('_', ' ')}'s band meets a protected area or keep-out` : bad.some(([x, z]) => isBlocked(x, z)) ? `OVERLAP: the ${kind.replace('_', ' ')}'s band meets another region or district` : `NO_EDGE: the ${kind.replace('_', ' ')}'s band leaves dry land within the claim`;
      continue;
    }
    // the street line, trimmed of its blocked points at the ends; 4-connected gaps are the route's to bridge
    const okAt = ([x, z]) => !(flagsAt(x, z) & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING)) && !isBlocked(x, z) && !inKeep(x, z) && inClaim(x, z);
    const ok = smoothLine(line).filter(okAt);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const k of mask) { const [x, z] = k.split(',').map(Number); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const dirOut = (a, b) => { const dx = a[0] - b[0], dz = a[1] - b[1]; return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1]; };
    const e0 = ok[0], e1 = ok[ok.length - 1];
    const ends = [
      { k: 0, x: e0[0], z: e0[1], street: [e0[0], e0[1]], facing: dirOut(e0, ok[Math.min(4, ok.length - 1)]), follow: true },
      { k: 1, x: e1[0], z: e1[1], street: [e1[0], e1[1]], facing: dirOut(e1, ok[Math.max(0, ok.length - 5)]), follow: true },
    ];
    return { kind, side: kind === 'ridge' ? 'both' : sign > 0 ? '+' : '-', rect: { minX: x0, minZ: z0, maxX: x1, maxZ: z1 }, mask, line: ok, window: win, ends, spineLength: spine.length, start: s };
  }
  return { none: why ?? `NO_EDGE: no window of the ${kind.replace('_', ' ')} fits` };
}

/** A street line made walkable: each point the mean of its 7 neighbours along the line (an offset line folds on a boundary's
 * inner bends), then joined into one 8-connected run of cells (the route's preferred cells, none skipped). */
export function smoothLine(line, k = 3) {
  const avg = [];
  for (let i = 0; i < line.length; i++) {
    let sx = 0, sz = 0, n = 0;
    for (let t = Math.max(0, i - k); t <= Math.min(line.length - 1, i + k); t++) { sx += line[t][0]; sz += line[t][1]; n++; }
    const q = [Math.round(sx / n), Math.round(sz / n)];
    const l = avg[avg.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) avg.push(q);
  }
  const out = [];
  for (let i = 0; i < avg.length; i++) {
    if (!i) { out.push(avg[0]); continue; }
    const [ax, az] = avg[i - 1], [bx, bz] = avg[i];
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    for (let t = 1; t <= n; t++) out.push([Math.round(ax + ((bx - ax) * t) / n), Math.round(az + ((bz - az) * t) / n)]);
  }
  return out;
}

/** The mask as row runs [[x0, z, x1, z]] (z, then x). */
export function maskRuns(mask) {
  const byZ = new Map();
  for (const k of mask) { const [x, z] = k.split(',').map(Number); if (!byZ.has(z)) byZ.set(z, []); byZ.get(z).push(x); }
  const out = [];
  for (const z of [...byZ.keys()].sort((a, b) => a - b)) {
    const xs = byZ.get(z).sort((a, b) => a - b);
    let s = xs[0], e = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === e + 1) { e = xs[i]; continue; }
      out.push([s, z, e, z]);
      if (i < xs.length) { s = xs[i]; e = xs[i]; }
    }
  }
  return out;
}

/**
 * Lots along a following street's dry path `P` ([[x, y, z]] centre cells): each spec in order, sides alternating, the lot's front
 * edge FOLLOW_SETBACK off the centre and facing it, the floor at the path's y + 1, a slope pad within FOLLOW_PAD, mostly (4/5) in the
 * mask, dry, clear of `blocked`, keep-out, the other lots (+2) and the path's own footprint. `[{spec, rect, front, floorY, entrance,
 * lane: [x, y, z], at: index}]`; the rest unplaced.
 */
export function followLots(S, pf, P, specs, { blocked = [], keepOut = [], taken = [] } = {}) {
  const out = [], unplaced = [];
  const pathCells = new Set(P.map(([x, , z]) => `${x},${z}`));
  const hit = (r) => blocked.some((b) => meets(r, b)) || keepOut.some((b) => meets(grow(r, 1), b)) || [...taken, ...out.map((l) => l.rect)].some((b) => meets(grow(r, 2), b));
  let i = 4, side = 1;
  for (const s of specs) {
    let placed = null;
    for (; i < P.length - 4 && !placed; i += 2) {
      const a = P[Math.max(0, i - 2)], b = P[Math.min(P.length - 1, i + 2)];
      const along = Math.abs(b[0] - a[0]) >= Math.abs(b[2] - a[2]) ? [1, 0] : [0, 1];
      for (const sd of [side, -side]) {
        const n = along[0] ? [0, sd] : [sd, 0];
        const [w, dp] = s.size; // along the street, deep
        const [cx, cy, cz] = P[i];
        const half = Math.floor((w - 1) / 2);
        // the setback: 3 off the street's centre, pushed out (up to FOLLOW_PUSH more, a longer lane) where a diagonal street runs
        // on across the lot's front
        let r = null, near = 0;
        for (let push = 0; push <= FOLLOW_PUSH && !r; push++) {
          near = FOLLOW_SETBACK + push;
          const far = near + dp - 1;
          let q;
          if (along[0]) { const zA = cz + n[1] * near, zB = cz + n[1] * far; q = [cx - half, Math.min(zA, zB), cx - half + w - 1, Math.max(zA, zB)]; } else { const xA = cx + n[0] * near, xB = cx + n[0] * far; q = [Math.min(xA, xB), cz - half, Math.max(xA, xB), cz - half + w - 1]; }
          let onPath = false;
          for (let x = q[0] - 1; x <= q[2] + 1 && !onPath; x++) for (let z = q[1] - 1; z <= q[3] + 1; z++) if (pathCells.has(`${x},${z}`)) { onPath = true; break; }
          // the lane from the street to the front must not cross the street again either
          for (let t = 2; t < near && !onPath; t++) if (pathCells.has(`${cx + n[0] * t},${cz + n[1] * t}`)) onPath = true;
          if (!onPath) r = q;
        }
        if (!r || hit(r)) continue;
        let inMask = 0, total = 0;
        for (let x = r[0]; x <= r[2]; x++) for (let z = r[1]; z <= r[3]; z++) { total++; if (pf.mask.has(`${x},${z}`)) inMask++; }
        if (inMask * 5 < total * 4) continue;
        const floorY = cy + 1;
        const ps = S.padStats(r[0], r[1], r[2] - r[0] + 1, r[3] - r[1] + 1, { floorY });
        if (ps.water || ps.cut > FOLLOW_PAD || ps.fill > FOLLOW_PAD) continue;
        const front = n[0] === 1 ? 'west' : n[0] === -1 ? 'east' : n[1] === 1 ? 'north' : 'south';
        // the entrance is the cell outside the front edge's middle (the lot rule): along the street at the lot's middle; the lane
        // the cells from the street's edge to it, level with the street
        const mid = along[0] ? [r[0] + half, cz + n[1] * (near - 1)] : [cx + n[0] * (near - 1), r[1] + half];
        const lane = [];
        for (let t = 2; t <= near - 1; t++) lane.push([cx + n[0] * t, cy, cz + n[1] * t]);
        placed = { spec: s, rect: r, front, floorY, entrance: [mid[0], floorY, mid[1]], lane: lane[lane.length - 1], laneCells: lane, at: i, street: [along[0] ? mid[0] : cx, cy, along[0] ? cz : mid[1]] };
        side = -sd;
        break;
      }
    }
    if (placed) { out.push(placed); i += placed.spec.size[0] + 3; } else unplaced.push({ id: s.id, reason: 'no_room' });
  }
  return { lots: out, unplaced };
}

/**
 * Emit a following district's lots (part `<id>_pads`, slope pads, each lot in `stages.lots`) and their one-cell lanes (part
 * `<id>_lanes`, path), with a lot node per lot and a junction on the street in front of it (the graph's street chain is added after
 * the route). Returns `{laneCells, lots, junctions: [{id, at}]}`.
 */
export function emitFollowLots(r, d, lots, stages) {
  const pads = r.part(`${d.id}_pads`, { stage: stages.ground });
  const lanes = r.part(`${d.id}_lanes`, { stage: stages.ground, set: 'path' });
  (r.meta.parts[lanes.id] ??= {}).kind = 'path';
  const laneCells = [], junctions = [];
  lots.forEach((l, k) => {
    const s = l.spec;
    pads.lot(s.id, {
      at: [l.rect[0], l.rect[1]], size: [l.rect[2] - l.rect[0] + 1, l.rect[3] - l.rect[1] + 1], floor: l.floorY, front: l.front, max: [l.rect[2] - l.rect[0] + 1, 32, l.rect[3] - l.rect[1] + 1],
      brief: s.brief, pad: { edge: 'slope', maxCut: FOLLOW_PAD, maxFill: FOLLOW_PAD }, stage: stages.lots,
      ext: { ...s.ext, 'architect_mc:village': { role: s.role, type: s.type, villager: s.villager, entrance: l.entrance, district: d.id, follow: true } },
    });
    const lc = (l.laneCells ?? [l.lane]).map((c) => [c[0], c[1], c[2]]);
    surfaceOps(lanes, lc, 'path');
    laneCells.push(...lc);
    const e = l.entrance;
    r.graphNode({ id: `lot:${s.id}`, kind: 'lot', ref: s.id, at: e, ports: [{ name: 'entrance', at: e, facing: l.front, width: 1 }] });
    const j = r.graphNode({ id: `${d.id}_j${k + 1}`, kind: 'junction', ref: `${d.id}_street`, at: [l.street[0], l.street[1] + 1, l.street[2]], ports: [{ name: 'street', at: [l.street[0], l.street[1] + 1, l.street[2]], facing: 'up', width: 3 }, { name: `lane_${s.id}`, at: [l.street[0], l.street[1] + 1, l.street[2]], facing: 'up', width: 1 }] });
    r.graphEdge({ id: `lane_${s.id}`, from: `lot:${s.id}.entrance`, to: `${j.id}.lane_${s.id}`, type: 'path', width: 1, path: lanes.id, stage: stages.ground });
    junctions.push({ id: j.id, at: l.at });
  });
  return { laneCells, junctions };
}
