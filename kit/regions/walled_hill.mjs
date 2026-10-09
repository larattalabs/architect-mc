// walled_hill: a walled town on a terraced hill (docs/CONTRACT.md 6b §7.4, A5B §6 family fixture; the prefix-check
// fixture of gate item 3). Around the claim's centre:
//   - a hill of 4 terraced levels (flat, retained by walls, 4 apart), each railed at its rim and lit;
//   - a ring wall round the hill's foot with towers, crenels and a south gate; a ground road from the entrance through the
//     gate to the lowest level;
//   - a stair up each riser (on alternating sides), lots on the levels: the outer two levels in stage lots-1, the inner
//     two in lots-2.
// Stages: ground (terraces, rails, wall, lamps, pads), ways (stairs, road), lots-1, lots-2.
import { region } from '../lib/region/program.mjs';
import { compassDir } from '../lib/region/geom.mjs';

export const id = 'walled_hill';

export const params = {
  radius: { type: 'int', min: 40, max: 120, default: 56, label: 'Hill radius' },
  levels: { type: 'int', min: 3, max: 6, default: 4, label: 'Levels' },
  lots: { type: 'int', min: 4, max: 16, default: 10, label: 'Lots' },
};

export const catalogue = {
  description: 'A walled hill town: a hill raised in terraced levels with retaining walls, a ring wall with towers, crenels and a gate round its foot, stairs between the levels and 4-16 lots on the terraces. For a walled town, a fortified hilltop village or a castle town on a hill, on fairly open ground.',
  needs: { minFlat: 0.5, water: false, relief: 'any' },
  claim: { min: [140, 140], max: [320, 320] },
};

const BRIEFS = ['Town hall', 'Market house', 'Inn', 'Smithy', 'Bakery', 'Weaver', 'Chapel', 'Guard house', 'Merchant house', 'Cooper', 'Tannery', 'Granary', 'Mill house', 'Apothecary', 'Stable', 'Watch house'];

export default function walledHill(ctx) {
  const { claim, survey, params: P, rng } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots-1', 'lots-2']);
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const R = Math.min(P.radius, Math.floor(Math.min(W, D) / 2) - 26);
  if (R < 30) throw new Error(`walled_hill needs a larger claim (got ${W}x${D})`);
  const n = P.levels, step = 4;
  const st = survey.stats(cx - R, cz - R, cx + R, cz + R);
  const base = st.median;
  const fr = Array.from({ length: n }, (_, k) => 1 - (0.75 * k) / n);
  const radii = fr.map((f) => R * f);
  const ys = Array.from({ length: n }, (_, k) => base + k * step);
  // ---- ground: the terraces (own stairs below), their rails and lamps
  const hill = r.part('hill', { stage: 'ground' });
  hill.terrace({ center: [cx, cz], radius: R, fractions: fr }, ys, { edge: 'wall', stairs: false, retain: 'structure', riser: step });
  const rails = r.part('rails', { stage: 'ground' });
  const lamps = [];
  for (let k = 0; k < n; k++) {
    rails.fill({ kind: 'ring', c: [cx, { abs: ys[k] + 1 }, cz], r0: radii[k] - 1, r1: radii[k], h: 1 }, 'rail', { cond: 3 });
    const m = Math.max(8, Math.ceil((2 * 3.141592653589793 * radii[k]) / 10));
    for (let i = 0; i < m; i++) { const d = compassDir((360 * i) / m + 4); lamps.push([round(cx + d[0] * (radii[k] - 0.5)), ys[k] + 2, round(cz + d[1] * (radii[k] - 0.5))]); }
  }
  // ---- the ring wall at the foot, with a south gate
  const gA = 180, gd = compassDir(gA);
  r.part('wall', { stage: 'ground' }).ring([cx, cz], R + 4, R + 7, { height: 6, material: 'structure', towers: { every: 40, radius: 3, extra: 4 }, crenels: true, gates: [{ angle: gA, width: 5, height: 5 }] });
  // ---- lots on the levels (between the level's rim and the next level's wall), outer two levels first
  const placed = [];
  const lr = rng('lots');
  const angles = Array.from({ length: 24 }, (_, i) => i * 15 + 7);
  lr.shuffle(angles);
  const stairAngle = (k) => (k % 2 === 0 ? 0 : 180) + 30;
  const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return Math.min(d, 360 - d); };
  for (let k = 0; k < n && placed.length < P.lots; k++) {
    const outer = radii[k] - 3, inner = k + 1 < n ? radii[k + 1] + 3 : 4;
    for (const a of angles) {
      if (placed.length >= P.lots) break;
      if (angDiff(a, stairAngle(k)) < 25 || (k > 0 && angDiff(a, stairAngle(k - 1)) < 25) || angDiff(a, gA) < 20) continue;
      const d = compassDir(a);
      const mid = (outer + inner) / 2;
      for (let s = 11; s >= 9; s--) { // 9+ wide: the smallest library children (the 6a stubs) need 9x9
        const x0 = round(cx + d[0] * mid - s / 2), z0 = round(cz + d[1] * mid - s / 2);
        const cs = [[x0 - 1, z0 - 1], [x0 + s, z0 - 1], [x0 - 1, z0 + s], [x0 + s, z0 + s]];
        if (cs.some(([x, z]) => { const dd = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz)); return dd > outer || dd < inner; })) continue;
        if (placed.some((p) => x0 - 3 <= p.x + p.s && p.x - 3 <= x0 + s && z0 - 3 <= p.z + p.s && p.z - 3 <= z0 + s)) continue;
        placed.push({ x: x0, z: z0, s, k });
        break;
      }
    }
  }
  const pads = r.part('pads', { stage: 'ground' });
  placed.forEach((p, i) => {
    const dx = cx - (p.x + p.s / 2), dz = cz - (p.z + p.s / 2);
    const front = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    pads.lot(`lot_${i + 1}`, { at: [p.x, p.z], size: [p.s, p.s], floor: ys[p.k] + 1, front, max: [p.s, 12, p.s], brief: BRIEFS[i % BRIEFS.length], stage: p.k < 2 ? 'lots-1' : 'lots-2', pad: { maxCut: 64, maxFill: 64, edge: 'wall' } });
  });
  // and a grid of lamp posts over every level (posts on the level's top, clear of the lots, the rims and the stairs)
  const levelOf = (x, z) => { const dd = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz)); for (let k = n - 1; k >= 0; k--) if (dd <= radii[k] - 3 && (k + 1 >= n || dd >= radii[k + 1] + 2)) return k; return -1; };
  const posts = [];
  for (let z = cz - R; z <= cz + R; z += 9) for (let x = cx - R; x <= cx + R; x += 9) { const k = levelOf(x, z); if (k >= 0) posts.push([x, ys[k] + 1, z]); }
  const lampPart = r.part('lamps', { stage: 'ground' });
  const nearStair = (x, z) => { for (let k = 0; k + 1 < n; k++) { const d = compassDir(stairAngle(k)); const px = cx + d[0] * radii[k + 1], pz = cz + d[1] * radii[k + 1]; if (Math.abs(x - px) + Math.abs(z - pz) < 9) return true; } return false; };
  for (const [x, y, z] of posts) {
    if (placed.some((p) => x >= p.x - 2 && x <= p.x + p.s + 1 && z >= p.z - 2 && z <= p.z + p.s + 1) || nearStair(x, z)) continue;
    lampPart.fill({ kind: 'box', min: [x, y, z], max: [x, y, z] }, 'rail', { cond: 3 });
    lampPart.fill({ kind: 'box', min: [x, y + 1, z], max: [x, y + 1, z] }, 'minecraft:lantern', { cond: 3 });
  }
  for (const [x, y, z] of lamps) {
    if (placed.some((p) => x >= p.x - 1 && x <= p.x + p.s && z >= p.z - 1 && z <= p.z + p.s) || nearStair(x, z)) continue;
    lampPart.fill({ kind: 'box', min: [x, y - 1, z], max: [x, y - 1, z] }, 'rail', { cond: 3 });
    lampPart.fill({ kind: 'box', min: [x, y, z], max: [x, y, z] }, 'minecraft:lantern', { cond: 3 });
  }
  // ---- ways: a stair up each riser, the road from the entrance through the gate
  const ways = r.part('ways', { stage: 'ways', set: 'path' });
  for (let k = 0; k + 1 < n; k++) {
    const d = compassDir(stairAngle(k));
    const ra = radii[k + 1] + 4, rb = radii[k + 1] - 3;
    ways.stair([[cx + d[0] * ra, ys[k], cz + d[1] * ra], [cx + d[0] * rb, ys[k + 1], cz + d[1] * rb]], { width: 3, lights: 4, solid: true, id: `stair_${k + 1}` });
  }
  const ent = [round(cx + gd[0] * (R + 18)), round(cz + gd[1] * (R + 18))];
  r.clearing('entrance', ent, { stage: 'ground' });
  r.clearing('spawn', [ent[0] + 5, ent[1]], { stage: 'ground' });
  ways.road([[ent[0], ent[1]], [round(cx + gd[0] * (radii[0] - 3)), ys[0], round(cz + gd[1] * (radii[0] - 3))]], { width: 3, mode: 'graded', optional: true, id: 'gate_road' });
  r.anchor('cam_gate', [ent[0], ys[0] + 14, ent[1] + 20]);
  return r;
}
