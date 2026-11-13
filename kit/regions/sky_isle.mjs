// sky_isle: a stone citadel on one great sky rock (docs/CONTRACT.md 6b §7.4, A5B §6 family fixture). Over the claim's
// centre:
//   - one large mass (a thick disc of rock with a grass top) at `altitude`, held up by pillars (`support: 'pillars'`) or
//     floating on a tapered rock underside (`support: 'taper'`, then declared floating with an anchor);
//   - a citadel wall round its edge on the mass (towers, crenels, one gate);
//   - a spiral tower stair from the ground south of the isle up to its height, and an arched bridge with towers from the
//     tower's top to the gate;
//   - 4-8 lots on the isle inside the wall (pads with no fill: the mass is under them), lamp posts on a grid.
// Stages: mass, ways, lots.
import { region } from '../lib/region/program.mjs';
import { compassDir } from '../lib/region/geom.mjs';

export const id = 'sky_isle';

export const params = {
  radius: { type: 'int', min: 24, max: 60, default: 34, label: 'Isle radius' },
  altitude: { type: 'int', min: 110, max: 200, default: 140, label: 'Altitude' },
  support: { type: 'enum', options: ['pillars', 'taper'], default: 'pillars', label: 'Support' },
  lots: { type: 'int', min: 4, max: 8, default: 6, label: 'Lots' },
};

export const catalogue = {
  description: 'A sky citadel: ONE large rock mass high in the air (radius 24-60), held up by stone pillars or a tapered rock underside, with a walled citadel on top (towers, crenels, a gate), an arched bridge with towers from a spiral stair tower to the gate, and 4-8 lots inside the walls. For a single great floating rock, a castle in the sky, an aerie or a sky fortress.',
  needs: { minFlat: 0.4, water: 'ok', relief: 'any' },
  claim: { min: [160, 200], max: [320, 320] },
};

const BRIEFS = ['Keep', 'Great hall', 'Barracks', 'Armoury', 'Chapel', 'Stables', 'Granary', 'Guard house'];

export default function skyIsle(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['mass', 'ways', 'lots']);
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2) - 16;
  const R = Math.min(P.radius, Math.floor(W / 2) - 12, Math.floor(D / 2) - 40);
  if (R < 20) throw new Error(`sky_isle needs a larger claim (got ${W}x${D})`);
  const g = survey.stats(cx - R, cz - R, cx + R, cz + R);
  const alt = Math.max(P.altitude, g.maxTop + 30);
  if (alt + 30 > claim.maxY) throw new Error(`sky_isle: the claim's y range ends at ${claim.maxY}, under the isle (${alt + 30})`);
  // ---- the mass
  const mass = r.part('mass', { stage: 'mass' });
  const disc = { kind: 'cylinder', c: [cx, { abs: alt - 7 }, cz], r: R, h: 7 };
  mass.add(disc, 'rock', P.support === 'pillars' ? { underside: 'pillars', supportEvery: 12, pillarMaterial: 'structure' } : { underside: 'rock', taper: 0.9 });
  mass.fill({ kind: 'cylinder', c: [cx, { abs: alt }, cz], r: R, h: 1 }, 'surface', { cond: 2 });
  if (P.support === 'taper') { r.anchor('isle', [cx + 4, alt + 1, cz + 4]); r.floating(['mass'], { anchor: 'isle' }); }
  // ---- the citadel wall on the mass, its gate to the south
  const gA = 180;
  const wall = r.part('wall', { stage: 'mass' });
  wall.ring([cx, cz], R - 4, R - 1, { height: 5, baseY: alt + 1, material: 'structure', towers: { every: 36, radius: 3, extra: 4 }, crenels: true, gates: [{ angle: gA, width: 5, height: 5 }] });
  // ---- the spiral tower south of the isle and the arched bridge to the gate
  const gd = compassDir(gA);
  const A = 6;
  const tx = round(cx + gd[0] * (R + 26)) + A, tz = round(cz + gd[1] * (R + 26)); // its NW corner (the top) in line with the gate
  const gY = Math.max(...[[0, 0], [-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => survey.heightAt(tx + sx * A, tz + sz * A)));
  const ways = r.part('ways', { stage: 'ways', set: 'path' });
  const st = ways.spiralTower({ center: [tx, tz], half: A, top: alt + 1, bottom: gY - 12, ground: (x, z) => survey.heightAt(x, z), start: 0, lights: 8, openTop: false, id: 'tower_stair' });
  const b0 = [tx - A, tz - A - 1], b1 = [cx, cz + R - 2];
  ways.bridge([[b0[0], alt + 1, b0[1]], [b1[0], alt + 1, b1[1]]], { width: 3, supports: { every: 8, style: 'arch', rise: 3 }, maxSpan: 12, towers: { at: 'end', height: 6 }, lights: 8, over: 'ours', id: 'gate_bridge' });
  const b = st.bottom;
  const ex = b.x + b.out[0] * 4, ez = b.z + b.out[1] * 4;
  r.anchor('entrance', [ex, ez]);
  r.anchor('spawn', [ex + 2, ez]);
  // ---- lots inside the wall, lamp posts between them
  const lots = r.part('lots', { stage: 'mass' });
  const inner = R - 8;
  const placed = [];
  const S = 9;
  for (const a of [0, 60, 120, 240, 300, 30, 90, 270, 330, 150, 210]) {
    if (placed.length >= P.lots) break;
    const d = compassDir(a);
    const mx = round(cx + d[0] * (inner - 7)), mz = round(cz + d[1] * (inner - 7));
    const x0 = mx - (S >> 1), z0 = mz - (S >> 1);
    const corners = [[x0 - 1, z0 - 1], [x0 + S, z0 - 1], [x0 - 1, z0 + S], [x0 + S, z0 + S]];
    if (corners.some(([x, z]) => (x - cx) * (x - cx) + (z - cz) * (z - cz) > (inner - 1) * (inner - 1))) continue;
    if (placed.some((p) => x0 - 3 <= p[0] + S && p[0] - 3 <= x0 + S && z0 - 3 <= p[1] + S && p[1] - 3 <= z0 + S)) continue;
    if (Math.abs(mx - cx) <= 5 && mz > cz) continue; // the way in from the gate
    placed.push([x0, z0]);
  }
  placed.forEach(([x0, z0], i) => {
    const dx = cx - (x0 + S / 2), dz = cz - (z0 + S / 2);
    const front = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    lots.lot(`lot_${i + 1}`, { at: [x0, z0], size: [S, S], floor: alt + 1, front, max: [S, 12, S], brief: BRIEFS[i % BRIEFS.length], stage: 'lots', pad: { fill: 'none', edge: 'wall', maxCut: 64, maxFill: 64 } });
  });
  const lamps = r.part('lamps', { stage: 'mass' });
  for (let z = cz - inner; z <= cz + inner; z += 8) for (let x = cx - inner; x <= cx + inner; x += 8) {
    if ((x - cx) * (x - cx) + (z - cz) * (z - cz) > (inner - 1) * (inner - 1)) continue;
    if (placed.some(([x0, z0]) => x >= x0 - 2 && x <= x0 + S + 1 && z >= z0 - 2 && z <= z0 + S + 1)) continue;
    lamps.fill({ kind: 'box', min: [x, { abs: alt + 1 }, z], max: [x, { abs: alt + 1 }, z] }, 'rail', { cond: 3 });
    lamps.fill({ kind: 'box', min: [x, { abs: alt + 2 }, z], max: [x, { abs: alt + 2 }, z] }, 'minecraft:lantern', { cond: 3 });
  }
  // a ring of lamps inside the wall
  for (let i = 0; i < 24; i++) {
    const d = compassDir(i * 15 + 7);
    const x = round(cx + d[0] * (R - 6)), z = round(cz + d[1] * (R - 6));
    if (placed.some(([x0, z0]) => x >= x0 - 1 && x <= x0 + S && z >= z0 - 1 && z <= z0 + S)) continue;
    lamps.fill({ kind: 'box', min: [x, { abs: alt + 1 }, z], max: [x, { abs: alt + 1 }, z] }, 'minecraft:lantern', { cond: 3 });
  }
  r.anchor('cam_south', [cx, alt + 20, cz + R + 60]);
  return r;
}
