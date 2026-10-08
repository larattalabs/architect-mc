// mega_bench: Steward's scale fixture (docs/CONTRACT.md §8, A5B §6a), phase 6a composition. Deterministic for a given
// survey (seed fixed by the default rule), robust to any terrain: everything sits at analytic heights or adapts to the
// plan survey, lots search for pads within their cut/fill limits (moving, shrinking, then relaxing the limits), and
// roads that cannot be built on this land are converted or dropped with a note, so the plan never fails on rough land.
//
// Claim: 1000x1000 (the centred 1000x1000 of a larger claim). Around the claim centre C:
//   - crater: a parabolic bowl of radius 160, depth 28, rubble lining, centred at C + (-200, -200);
//   - wall: a ring wall of radius 470, thickness 4, height 10, 4 gates (N, E, S, W); towers are phase 6b;
//   - hills: 3 terraced hills of 5 levels (retaining walls, a stair between each pair of levels) in the NE, SE, SW;
//   - plaza: an octagonal platform at C;
//   - ways: ground roads from the 4 gates to the plaza and 4 district streets (4e roads), graded roads to the 3 hills,
//     a spiral stair into the bowl, and 4 bridges with pillar supports (spans 40-120): the rim to the spiral's top and
//     3 ramps from the rim down into the bowl (pillars to the bowl's analytic floor); arches are phase 6b;
//   - lots: 200 lots on pads (9-24 wide, 6-14 tall), 50 per stage lots-1 .. lots-4.
// Stages: ground (carve, wall, terraces, plaza, pads), ways (roads, stairs, bridges), lots-1 .. lots-4 (lots only).
// No trig anywhere: directions come from the kit's polynomial compassDir.
import { region } from '../lib/region/program.mjs';
import { circlePolygon, compassDir, line4 } from '../lib/region/geom.mjs';

export const id = 'mega_bench';

export const params = {
  lots: { type: 'int', min: 0, max: 400, default: 200, label: 'Lots' },
  scale: { type: 'enum', options: ['full', 'light'], default: 'full', label: 'Scale' },
};

/**
 * `full` (default, about 10M plan cells on overworld-like land): a crater rim at the 90th percentile of the ground in
 * the bowl, a 3-deep lining, broad hills of radius 90 with 7-block levels, and the lot districts levelled in 48x48
 * blocks with retaining walls (lots on a block sit flush on it). `light` (about 2M): the bare section-8 composition.
 */
const SCALES = {
  full: { hillR: 130, step: 18, fractions: [1, 0.9, 0.8, 0.7, 0.6], lining: 3, rimPct: 0.9, districts: true, block: 32, raise: 6 },
  light: { hillR: 80, step: 4, fractions: null, lining: 1, rimPct: 0.5, districts: false },
};

const BOWL = { r: 160, depth: 28 };
const WALL = { r0: 468, r1: 471.5, height: 10 };
const LOT_MIN = 9, LOT_MAX = 24;
const LIMIT_STEPS = [6, 10, 16, 24, 40];

export default function megaBench(ctx) {
  const { claim, survey, rng } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 1000 || D < 1000) throw new Error(`mega_bench needs a 1000x1000 claim (got ${W}x${D})`);
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots-1', 'lots-2', 'lots-3', 'lots-4']);
  r.budget(30_000_000);
  const P = ctx.params;
  const SC = SCALES[P.scale];
  const round = (v) => Math.floor(v + 0.5);

  // ---- occupancy (plan-time): cells lots must keep clear of
  const occ = new Uint8Array(W * D);
  const mark = (x0, z0, x1, z1) => {
    for (let z = Math.max(z0, claim.minZ); z <= Math.min(z1, claim.maxZ); z++) {
      const row = (z - claim.minZ) * W;
      for (let x = Math.max(x0, claim.minX); x <= Math.min(x1, claim.maxX); x++) occ[row + x - claim.minX] = 1;
    }
  };
  const markDisc = (x, z, rad) => {
    for (let dz = -rad; dz <= rad; dz++) {
      const h = Math.floor(Math.sqrt(rad * rad - dz * dz));
      mark(round(x - h), round(z + dz), round(x + h), round(z + dz));
    }
  };
  const markLine = (pts, half) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const [x, z] of line4(round(pts[i][0]), round(pts[i][1]), round(pts[i + 1][0]), round(pts[i + 1][1]))) mark(x - half, z - half, x + half, z + half);
    }
  };
  const free = (x0, z0, x1, z1) => {
    if (x0 < claim.minX || z0 < claim.minZ || x1 > claim.maxX || z1 > claim.maxZ) return false;
    for (let z = z0; z <= z1; z++) {
      const row = (z - claim.minZ) * W;
      for (let x = x0; x <= x1; x++) if (occ[row + x - claim.minX]) return false;
    }
    return true;
  };
  // only inside the wall (with room for the gates' approaches)
  for (let z = claim.minZ; z <= claim.maxZ; z++) {
    for (let x = claim.minX; x <= claim.maxX; x++) {
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz > 440 * 440) occ[(z - claim.minZ) * W + x - claim.minX] = 1;
    }
  }

  // ---- ground: the crater
  const bx = cx - 200, bz = cz - 200;
  // the rim: a percentile of the ground inside the bowl (full: high, so the crater is cut from the high ground)
  const rimSamples = [];
  for (let z = bz - BOWL.r; z <= bz + BOWL.r; z += 8) for (let x = bx - BOWL.r; x <= bx + BOWL.r; x += 8) {
    if ((x - bx) * (x - bx) + (z - bz) * (z - bz) <= BOWL.r * BOWL.r) rimSamples.push(survey.heightAt(x, z));
  }
  rimSamples.sort((a, b) => a - b);
  const rimY = rimSamples[Math.min(rimSamples.length - 1, Math.floor(rimSamples.length * SC.rimPct))];
  const bowl = { kind: 'bowl', c: [bx, { abs: rimY }, bz], r: BOWL.r, depth: BOWL.depth, profile: 'parabolic', h: 32 };
  r.part('crater', { stage: 'ground' }).carve(bowl, { lining: 'rubble', liningDepth: SC.lining });
  markDisc(bx, bz, BOWL.r + 24);
  /** the first cell above the carved bowl's surface at (x, z), or null outside the bowl */
  const bowlBottom = (x, z) => {
    const d = Math.sqrt((x - bx) * (x - bx) + (z - bz) * (z - bz));
    if (d > BOWL.r) return null;
    const t = d / BOWL.r;
    return Math.ceil(rimY - BOWL.depth * (1 - t * t));
  };

  // ---- ground: the ring wall and its gates
  const gates = r.part('wall', { stage: 'ground' }).ring([cx, cz], WALL.r0, WALL.r1, {
    height: WALL.height, gates: [0, 90, 180, 270].map((angle) => ({ angle, width: 5, height: 5 })),
  });

  // ---- ground: the plaza
  const plazaStats = survey.stats(cx - 18, cz - 18, cx + 18, cz + 18);
  const plazaY = plazaStats.median;
  r.part('plaza', { stage: 'ground' }).platform(circlePolygon(cx, cz, 18, 8, 22.5), plazaY, { thickness: 2, underside: 'fill', clear: true, material: 'structure' });
  markDisc(cx, cz, 34);

  // ---- ground: three terraced hills
  const R = SC.hillR;
  const hillAt = [[cx + 220, cz + 220], [cx + 220, cz - 220], [cx - 220, cz + 220]];
  const hills = hillAt.map(([x, z], i) => {
    const lv = r.part(`hill_${i + 1}`, { stage: 'ground' }).terrace({ center: [x, z], radius: R, ...(SC.fractions ? { fractions: SC.fractions } : {}) }, 5, { edge: 'wall', step: SC.step, retain: 'structure', stairs: true, startAngle: 315 - 90 * i });
    markDisc(x, z, R + 16);
    return { x, z, levels: lv };
  });

  // ---- ways
  const roads = r.part('roads', { stage: 'ways', set: 'path' });
  const dirs = [0, 90, 180, 270].map((a) => compassDir(a));
  dirs.forEach((d, i) => {
    const pts = [[cx + d[0] * 476, cz + d[1] * 476], [cx + d[0] * 22, cz + d[1] * 22]];
    roads.road(pts, { width: 3, optional: true, id: `gate_road_${i + 1}` });
    markLine(pts, 7);
  });
  const streets = [
    [[cx + 8, cz - 60], [cx + 420, cz - 60]], [[cx + 60, cz - 8], [cx + 60, cz - 420]],
    [[cx - 8, cz + 60], [cx - 420, cz + 60]], [[cx - 60, cz + 8], [cx - 60, cz + 420]],
  ];
  streets.forEach((pts, i) => { roads.road(pts, { width: 3, optional: true, id: `street_${i + 1}` }); markLine(pts, 7); });

  const graded = r.part('graded', { stage: 'ways', set: 'path' });
  const gradedRoutes = [
    [[hills[0].x, cz + 8, null], [hills[0].x, hills[0].z - R - 2, hills[0].levels[0].y]],
    [[hills[1].x, cz - 8, null], [hills[1].x, hills[1].z + R + 2, hills[1].levels[0].y]],
    [[cx - 8, hills[2].z, null], [hills[2].x + R + 2, hills[2].z, hills[2].levels[0].y]],
  ];
  gradedRoutes.forEach(([a, b], i) => {
    const pts = [[a[0], ...(a[2] === null ? [] : [a[2]]), a[1]], [b[0], b[2], b[1]]];
    graded.road(pts.map((p) => (p.length === 2 ? [p[0], p[1]] : p)), { mode: 'graded', width: 3, optional: true, id: `hill_road_${i + 1}` });
    markLine([[a[0], a[1]], [b[0], b[1]]], 7);
  });

  // ---- ground: the lot districts levelled in blocks (after the road corridors are known; before the pads)
  const blk = new Int32Array(W * D).fill(-1);
  const blocks = [];
  if (SC.districts) {
    const BLOCK = SC.block;
    for (let z0 = claim.minZ + 4; z0 + BLOCK - 1 <= claim.maxZ - 4; z0 += BLOCK) {
      for (let x0 = claim.minX + 4; x0 + BLOCK - 1 <= claim.maxX - 4; x0 += BLOCK) {
        const x1 = x0 + BLOCK - 1, z1 = z0 + BLOCK - 1;
        if (!free(x0 - 2, z0 - 2, x1 + 2, z1 + 2)) continue;
        const st = survey.stats(x0, z0, x1, z1);
        if (st.maxGround - st.minFloor > 28) continue;
        const y = st.median + SC.raise;
        const bi = blocks.length;
        r.part(`district_${bi + 1}`, { stage: 'ground' }).terrace({ polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] }, [y], { edge: 'wall', stairs: false, retain: 'structure', soil: 1 });
        blocks.push({ x0, z0, x1, z1, y });
        for (let z = z0; z <= z1; z++) blk.fill(bi, (z - claim.minZ) * W + x0 - claim.minX, (z - claim.minZ) * W + x1 - claim.minX + 1);
      }
    }
  }
  const blockAt = (x, z) => blk[(z - claim.minZ) * W + x - claim.minX];
  /** the block whose interior (2 in from its walls) holds the whole rectangle, else -1; -2 when it touches any block */
  const blockOf = (x0, z0, x1, z1) => {
    const b = blockAt(x0, z0);
    if (b >= 0) {
      const k = blocks[b];
      if (x0 >= k.x0 + 2 && z0 >= k.z0 + 2 && x1 <= k.x1 - 2 && z1 <= k.z1 - 2) return b;
      return -2;
    }
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (blockAt(x, z) >= 0) return -2;
    return -1;
  };

  // the spiral stair into the bowl, its top at rim level
  const sx = bx + 40, sz = bz + 40;
  const spiralTop = rimY;
  const spiralBottom = bowlBottom(sx, sz) - 1;
  const spiral = r.part('spiral', { stage: 'ways', set: 'path' });
  spiral.stair({ center: [sx, sz], radius: 4, top: spiralTop, bottom: spiralBottom, start: 135 }, { spiral: true, width: 3, material: 'structure', id: 'bowl_spiral' });

  // four bridges: the rim to the spiral's top, and three ramps from the rim down into the bowl
  const bridges = r.part('bridges', { stage: 'ways', set: 'path' });
  const supports = { every: 12, bottom: bowlBottom };
  const se = compassDir(135);
  const b1a = [bx + se[0] * (BOWL.r + 8), bz + se[1] * (BOWL.r + 8)];
  const b1b = [sx + se[0] * 5, sz + se[1] * 5];
  bridges.bridge([[b1a[0], { surface: 0 }, b1a[1]], [b1b[0], spiralTop, b1b[1]]].map((p) => clampRamp(p, b1b, spiralTop, survey)), { width: 3, supports, id: 'bridge_spiral' });
  [[45, 40], [225, 80], [315, 120]].forEach(([angle, span], i) => {
    const d = compassDir(angle);
    const a = [bx + d[0] * (BOWL.r + 6), bz + d[1] * (BOWL.r + 6)];
    const b = [bx + d[0] * (BOWL.r + 6 - span), bz + d[1] * (BOWL.r + 6 - span)];
    const endY = bowlBottom(round(b[0]), round(b[1])) - 1;
    const ground = survey.heightAt(round(a[0]), round(a[1]));
    const startY = Math.max(endY - (span - 2), Math.min(endY + (span - 2), ground));
    bridges.bridge([[a[0], startY, a[1]], [b[0], endY, b[1]]], { width: 3, supports, id: `bridge_ramp_${i + 1}` });
  });

  // ---- lots: a seeded candidate order over the free land; sizes shrink, then the limits relax, until all are placed
  const pads = [];
  const lr = rng('lots');
  const cand = [];
  for (let z = cz - 440; z <= cz + 440; z += 5) for (let x = cx - 440; x <= cx + 440; x += 5) cand.push([x, z]);
  lr.shuffle(cand);
  const want = Array.from({ length: P.lots }, () => ({ w: lr.int(LOT_MIN, LOT_MAX), d: lr.int(LOT_MIN, LOT_MAX), h: lr.int(6, 14) }));
  let placed = 0;
  for (const lim of LIMIT_STEPS) {
    for (const [x, z] of cand) {
      if (placed >= want.length) break;
      const lw = want[placed];
      for (let s = 0; s <= 15; s += 3) {
        const w = Math.max(LOT_MIN, lw.w - s), d = Math.max(LOT_MIN, lw.d - s);
        const last = w === LOT_MIN && d === LOT_MIN;
        if (!free(x - 3, z - 3, x + w + 2, z + d + 2)) { if (last) break; continue; }
        const inBlock = blockOf(x - 3, z - 3, x + w + 2, z + d + 2);
        if (inBlock === -2) { if (last) break; continue; }
        if (inBlock >= 0) {
          // flush on a levelled block: the pad's top is the block's level, no batter
          const ps = survey.padStats(x, z, w, d, { floorY: blocks[inBlock].y + 1 });
          pads.push({ x, z, w, d, h: lw.h, cut: ps.cut, fill: ps.fill, lim, floorY: ps.floorY, edge: 'wall' });
          mark(x - 3, z - 3, x + w + 2, z + d + 2);
          placed++;
          break;
        }
        const ps = survey.padStats(x, z, w, d);
        if (ps.cut > lim || ps.fill > lim) { if (last) break; continue; }
        // the batter reaches as far as the pad's own cut / fill: keep that (plus 2) clear
        const need = Math.max(ps.cut, ps.fill);
        const m = 1 + need + 2;
        if (!free(x - m, z - m, x + w - 1 + m, z + d - 1 + m)) { if (last) break; continue; }
        pads.push({ x, z, w, d, h: lw.h, cut: ps.cut, fill: ps.fill, lim, floorY: 'auto', edge: 'slope' });
        mark(x - m, z - m, x + w - 1 + m, z + d - 1 + m);
        placed++;
        break;
      }
    }
    if (placed >= want.length) break;
  }
  if (placed < want.length) r.note(`lots: only ${placed} of ${want.length} lots found a pad`);
  const relaxed = pads.filter((p) => p.lim > 6 && p.edge === 'slope').length;
  if (relaxed) r.note(`lots: ${relaxed} pads needed cut/fill limits over 6 (rough land)`);

  // anchors first (lots face the spawn)
  r.anchor('spawn', [cx, plazaY + 1, cz]);
  const south = gates[2];
  r.anchor('entrance', [cx, south.at[1] + 1, cz + 478]);

  pads.forEach((p, i) => {
    const lid = `lot_${String(i + 1).padStart(3, '0')}`;
    const part = r.part(`pad_${lid}`, { stage: 'ground' });
    part.lot(lid, {
      at: [p.x, p.z], size: [p.w, p.d], front: 'toward:spawn', max: [p.w, p.h, p.d], stage: `lots-${Math.min(4, 1 + Math.floor(i / Math.max(1, Math.ceil(want.length / 4))))}`,
      floor: p.floorY, pad: { maxCut: p.cut, maxFill: p.fill, edge: p.edge },
    });
  });
  return r;
}

/** A bridge end at {surface: 0} kept within 1 block per block of the other end (a rough rim never breaks the deck rule). */
function clampRamp(p, other, otherY, survey) {
  if (typeof p[1] !== 'object') return p;
  const len = Math.abs(p[0] - other[0]) + Math.abs(p[2] - other[1]);
  const g = survey.heightAt(Math.floor(p[0] + 0.5), Math.floor(p[2] + 0.5));
  const lim = Math.floor(len * 0.6);
  return [p[0], Math.max(otherY - lim, Math.min(otherY + lim, g)), p[2]];
}
