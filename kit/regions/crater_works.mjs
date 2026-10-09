// crater_works: a repurposed meteor crater mining facility (docs/CONTRACT.md 6b §7.2, steward-mc A5B §2's sketch made
// real). Around the claim's centre:
//   - a carved spherical bowl with a `scorched ?? rock` lining, and a rubble rim ring with a gate on the entrance side;
//   - 3 terraced work levels stepping down into the bowl (flat annuli, the innermost the floor), railed at their inner
//     edges, lit by lanterns on the rails and along the wall;
//   - a bridge from the rim (through the gate) over the terraces to a spiral stair at the centre, which winds down to the
//     floor; straight stairs cut into each riser join the levels;
//   - 4-12 lots on the terrace bands (offices, halls, sheds), facing the centre;
//   - a ground road from the entrance (outside the rim) to the bridge; `entrance` and `spawn` outside the rim.
// Stages: ground (carve, terraces, rim, pads), ways (bridge, spiral, stairs, road), lots.
import { region } from '../lib/region/program.mjs';
import { compassDir } from '../lib/region/geom.mjs';

export const id = 'crater_works';

export const params = {
  radius: { type: 'int', min: 40, max: 160, default: 56, label: 'Crater radius' },
  depth: { type: 'int', min: 12, max: 48, default: 24, label: 'Crater depth' },
  lots: { type: 'int', min: 4, max: 12, default: 8, label: 'Lots' },
};

export const catalogue = {
  description: 'A crater facility: one large carved circular bowl (a meteor crater or a pit mine) lined with scorched rock, a rubble rim, a bridge from the rim to a central spiral stair down to the floor, three terraced work levels stepping down inside the bowl, and 4-12 lots (offices, halls, sheds) on the terraces. For mining camps, pits, quarries and crater lairs on fairly flat open ground.',
  needs: { minFlat: 0.5, water: false, relief: 'low' },
  claim: { min: [120, 120], max: [400, 400] },
};

const BRIEFS = ['Overseer office, windows over the pit', 'Ore sorting hall, crates and conveyors', 'Tool shed', 'Smelter house', 'Crew bunkhouse', 'Assay office', 'Cart repair shed', 'Explosives store', 'Mess hall', 'Lamp room', 'Winch house', 'Pay office'];

export default function craterWorks(ctx) {
  const { claim, survey, params: P, rng } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots']);
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const half = Math.floor(Math.min(W, D) / 2);
  const R = Math.min(P.radius, half - 26);
  if (R < 30) throw new Error(`crater_works needs a claim of at least ${2 * (30 + 26)} blocks (got ${W}x${D})`);
  if (R < P.radius) r.note(`crater: radius ${R} (the claim holds no more)`);
  // the rim at the 90th percentile of the ground around it, so the bowl's edge meets the land on a slope (no cliff)
  const ringG = [];
  for (let i = 0; i < 72; i++) { const d = compassDir(i * 5); for (const rr of [R - 2, R + 1, R + 4]) ringG.push(survey.heightAt(round(cx + d[0] * rr), round(cz + d[1] * rr))); }
  ringG.sort((a, b) => a - b);
  const rimY = ringG[Math.floor(ringG.length * 0.9)];
  const depth = Math.max(12, Math.min(P.depth, rimY - (claim.minY + 8)));
  const floorY = rimY - depth;
  const lining = Object.hasOwn(ctx.roles, 'scorched') ? 'scorched' : 'rock';

  // ---- ground: the bowl, the terraces, the rim
  r.part('crater', { stage: 'ground' }).carve({ kind: 'bowl', c: [cx, { abs: rimY }, cz], r: R, depth, profile: 'spherical', h: 40 }, { lining, liningDepth: 2 });
  const L = 3;
  const radii = [0.9, 0.66, 0.42].map((f) => R * f);
  const ys = [0, 1, 2].map((k) => rimY - round((depth * (k + 1)) / (L + 1)));
  const base = floorY - 3;
  const ter = r.part('terraces', { stage: 'ground' });
  ter.fill({ kind: 'cylinder', c: [cx, { abs: ys[0] }, cz], r: radii[0], h: rimY + 40 - ys[0] }, null, { cond: 0 }); // level 0 clear above
  for (let k = 0; k < L; k++) {
    if (k > 0) ter.fill({ kind: 'cylinder', c: [cx, { abs: ys[k] }, cz], r: radii[k], h: ys[k - 1] - ys[k] }, null, { cond: 0 });
    ter.fill({ kind: 'cylinder', c: [cx, { abs: base }, cz], r: radii[k], h: ys[k] - 1 - base }, 'rock', { cond: 0 });
    ter.fill({ kind: 'cylinder', c: [cx, { abs: ys[k] - 1 }, cz], r: radii[k], h: 1 }, lining, { cond: 0 });
  }
  // rails on each level's inner edge (the riser below it), lanterns on them and along the wall
  const rails = r.part('rails', { stage: 'ground' });
  for (let k = 0; k + 1 < L; k++) rails.fill({ kind: 'ring', c: [cx, { abs: ys[k] }, cz], r0: radii[k + 1], r1: radii[k + 1] + 1, h: 1 }, 'rail', { cond: 0 });
  // and round the top level's outer edge (where the land outside lies lower than the terraces)
  rails.fill({ kind: 'ring', c: [cx, { abs: ys[0] }, cz], r0: radii[0] - 1, r1: radii[0], h: 1 }, 'rail', { cond: 0 });
  const lamps = [];
  const lampRing = (rad, y, every) => {
    const n = Math.max(6, Math.ceil((2 * 3.141592653589793 * rad) / every));
    for (let i = 0; i < n; i++) { const d = compassDir((360 * i) / n + 7); lamps.push([round(cx + d[0] * rad), y, round(cz + d[1] * rad)]); }
  };
  for (let k = 0; k + 1 < L; k++) lampRing(radii[k + 1] + 0.5, ys[k] + 1, 10);
  for (let k = 0; k < L; k++) lampRing(radii[k] - 1.5, ys[k], 10);
  lampRing(radii[2] * 0.5, ys[2], 10);
  const gA = 180; // the gate, the bridge and the entrance face south
  const gd = compassDir(gA);
  const rim = r.part('rim', { stage: 'ground' });
  rim.ring([cx, cz], R + 1, R + 4, { height: 2, material: 'rubble', gates: [{ angle: gA, width: 5, height: 4 }] });
  // lanterns on the rim wall's top, every 10 cells or so
  {
    const rm = R + 2.5, n = Math.max(8, Math.ceil((2 * 3.141592653589793 * rm) / 10));
    for (let i = 0; i < n; i++) {
      const d = compassDir((360 * i) / n + 3);
      if (Math.abs(((360 * i) / n + 3) - gA) < 8) continue;
      const x = round(cx + d[0] * rm), z = round(cz + d[1] * rm);
      rim.fill({ kind: 'box', min: [x, { surface: 3 }, z], max: [x, { surface: 3 }, z] }, 'minecraft:lantern', { cond: 0 });
    }
  }

  // ---- ways: the bridge from the rim to the spiral, the spiral down to the floor, stairs between the levels, the road
  const levelAt = (x, z) => {
    const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
    for (let k = L - 1; k >= 0; k--) if (d <= radii[k] - 0.5) return ys[k];
    return null;
  };
  // the spiral: a square spiral stair around a solid core at the centre, from the rim's height down to the floor (straight
  // flights of width 3 with a landing at every corner; each tread bears on the core or the step below it)
  const A = 7; // the flights run on a square of half-size A
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]]; // south-east first (the bridge arrives from the south)
  const pts = [];
  let y = rimY, k = 0;
  const bottom = ys[2] - 1;
  while (true) {
    const [sx, sz] = corners[k % 4];
    pts.push([cx + sx * A, y, cz + sz * A]);
    if (y === bottom) break;
    y = Math.max(bottom, y - 9);
    k++;
  }
  const spiralTop = pts[0];
  const ways = r.part('ways', { stage: 'ways', set: 'path' });
  ways.fill({ kind: 'box', min: [cx - A + 2, { min: [{ floor: 1 }, { abs: bottom }] }, cz - A + 2], max: [cx + A - 2, { abs: rimY }, cz + A - 2] }, 'structure', { cond: 0 });
  ways.stair(pts, { width: 3, railing: 'rail', lights: 8, solid: true, id: 'spiral' });
  const spiralR = A + 2;
  // the bridge: from the rim (through the gate) to the spiral's top corner
  const b0 = [spiralTop[0], cz + gd[1] * (R - 2)], b1 = [spiralTop[0], spiralTop[2] + 2];
  const g0 = survey.heightAt(round(cx + gd[0] * (R + 2.5)), round(cz + gd[1] * (R + 2.5))); // the gate threshold's y
  const startY = Math.max(rimY - 20, Math.min(rimY + 20, g0));
  ways.bridge([[b0[0], startY, b0[1]], [b1[0], rimY, b1[1]]], { width: 3, supports: { every: 12, bottom: (x, z) => levelAt(x, z) }, lights: 8, id: 'rim_bridge' });
  // stairs cut into each riser (k -> k + 1), on the side away from the bridge
  const sA = gA + 180, sd = compassDir(sA);
  for (let k = 0; k + 1 < L; k++) {
    const rise = ys[k] - ys[k + 1];
    const run = rise + 2 * Math.floor((rise - 1) / 8) + 2;
    const rOut = radii[k + 1] + run, rIn = radii[k + 1] - 1;
    ways.stair([[cx + sd[0] * rOut, ys[k] - 1, cz + sd[1] * rOut], [cx + sd[0] * rIn, ys[k + 1] - 1, cz + sd[1] * rIn]], { width: 3, lights: 6, id: `riser_stair_${k + 1}` });
  }
  const ent = [round(cx + gd[0] * (R + 16)), round(cz + gd[1] * (R + 16))];
  r.anchor('entrance', ent);
  r.anchor('spawn', [ent[0] + 3, ent[1]]);
  ways.road([[ent[0], ent[1]], [round(cx + gd[0] * (R + 7)), round(cz + gd[1] * (R + 7))]], { width: 3, optional: true, id: 'rim_road' });

  // ---- lots on the terrace bands, facing the centre, clear of the bridge, the spiral and the stairs
  const placed = [];
  const lr = rng('lots');
  const segDist = (x, z, a, b) => { const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez; let t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2; t = Math.max(0, Math.min(1, t)); return Math.sqrt((x - a[0] - ex * t) * (x - a[0] - ex * t) + (z - a[1] - ez * t) * (z - a[1] - ez * t)); };
  const stairA = [cx + sd[0] * radii[0], cz + sd[1] * radii[0]], stairB = [cx + sd[0] * (radii[2] - 2), cz + sd[1] * (radii[2] - 2)];
  const okBox = (k, x0, z0, s) => {
    const inner = k === L - 1 ? spiralR + 6 : radii[k + 1] + 3, outer = radii[k] - 3;
    for (const [x, z] of [[x0, z0], [x0 + s, z0], [x0, z0 + s], [x0 + s, z0 + s]]) { const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz)); if (d < inner || d > outer) return false; }
    for (const [x, z] of [[x0, z0], [x0 + s, z0], [x0, z0 + s], [x0 + s, z0 + s], [x0 + s / 2, z0 + s / 2]]) {
      if (segDist(x, z, b0, b1) < 6 || segDist(x, z, stairA, stairB) < 5) return false;
    }
    for (const p of placed) if (x0 - 3 <= p.x + p.s && p.x - 3 <= x0 + s && z0 - 3 <= p.z + p.s && p.z - 3 <= z0 + s) return false;
    return true;
  };
  const angles = Array.from({ length: 36 }, (_, i) => i * 10 + 5);
  lr.shuffle(angles);
  outer: for (const k of [1, 0, 2]) {
    for (const a of angles) {
      if (placed.length >= P.lots) break outer;
      const d = compassDir(a);
      const mid = k === L - 1 ? (spiralR + 6 + radii[k] - 3) / 2 : (radii[k + 1] + radii[k]) / 2;
      for (let s = 11; s >= 6; s--) {
        const x0 = round(cx + d[0] * mid - s / 2), z0 = round(cz + d[1] * mid - s / 2);
        if (!okBox(k, x0, z0, s - 1)) continue;
        placed.push({ x: x0, z: z0, s: s - 1, k });
        break;
      }
    }
  }
  if (placed.length < P.lots) r.note(`lots: ${placed.length} of ${P.lots} fit on the terraces`);
  const pads = r.part('pads', { stage: 'ground' });
  placed.forEach((p, i) => {
    const s = p.s + 1;
    const dx = cx - (p.x + s / 2), dz = cz - (p.z + s / 2);
    const front = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    pads.lot(`lot_${i + 1}`, { at: [p.x, p.z], size: [s, s], floor: ys[p.k], front, max: [s, 8, s], brief: BRIEFS[i % BRIEFS.length], stage: 'lots', pad: { maxCut: 64, maxFill: 64, edge: 'wall' } });
  });
  // the lamps last (clear of the lots' boxes)
  const lampCols = [];
  for (const [x, y, z] of lamps) {
    if (placed.some((p) => x >= p.x - 1 && x <= p.x + p.s + 1 && z >= p.z - 1 && z <= p.z + p.s + 1)) continue;
    if (segDist(x, z, stairA, stairB) < 3) continue;
    lampCols.push([x, y, z]);
  }
  const lampPart = r.part('lamps', { stage: 'ground' });
  for (const [x, y, z] of lampCols) lampPart.fill({ kind: 'box', min: [x, y, z], max: [x, y, z] }, 'minecraft:lantern', { cond: 3 });
  r.anchor('cam_rim', [round(cx + gd[0] * (R + 10)), rimY + 12, round(cz + gd[1] * (R + 10))]);
  return r;
}
