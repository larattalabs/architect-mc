// rift_city: a settlement in a linear carved rift (docs/CONTRACT.md 6b §7.2, Steward S-6b-2: a linear carved rift, ledge
// terraces on both walls, bridges across, a lit side hall and a floor utility corridor; a cave city or a ravine town are
// other templates). Along the claim's x axis, through its centre:
//   - the rift: a warped trench (a capsule-ended channel, walls bent by a warp of 3) with a `lining ?? rock` lining;
//   - a ledge terrace on each wall at mid depth, railed and lit, with lots on it, joined to the floor by stairs cut into it;
//   - a lit cavern side hall opening off the floor in the north wall;
//   - 2-6 bridges across at rim level, arched between piers on the ledges and the floor;
//   - a spiral tower stair at each end from a rim down to the floor (the west one from the north rim, the east one from
//     the south rim), and a reserved utility corridor along the floor;
//   - `entrance` and `spawn` on the north rim.
// Stages: ground (the rift, ledges, hall, lamps, pads), ways (bridges, towers, stairs), lots.
import { region } from '../lib/region/program.mjs';

export const id = 'rift_city';

export const params = {
  length: { type: 'int', min: 96, max: 320, default: 160, label: 'Rift length' },
  width: { type: 'int', min: 16, max: 48, default: 28, label: 'Rift width' },
  depth: { type: 'int', min: 20, max: 60, default: 32, label: 'Rift depth' },
  bridges: { type: 'int', min: 2, max: 6, default: 3, label: 'Bridges' },
};

export const catalogue = {
  description: 'A rift settlement: a long straight carved canyon (a rift or chasm) with ledge terraces on both walls holding the houses, bridges across at the rim, spiral stairs from the rims to the floor, a lit cavern hall off the floor and a utility corridor along it. For towns built down the walls of a rift, gorge or canyon cut into open ground.',
  needs: { minFlat: 0.5, water: false, relief: 'low' },
  claim: { min: [140, 100], max: [400, 200] },
};

const BRIEFS = ['Ledge house', 'Rope maker', 'Miner lodge', 'Tavern on the ledge', 'Lookout', 'Workshop', 'Store', 'Bath house'];

export default function riftCity(ctx) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots']);
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const L = Math.min(P.length, W - 40);
  const half = Math.floor(Math.min(P.width, D - 70) / 2);
  if (L < 80 || half < 8) throw new Error(`rift_city needs a larger claim (got ${W}x${D})`);
  const x0 = cx - Math.floor(L / 2) + half, x1 = cx + Math.floor(L / 2) - half; // the channel's straight part
  // the rim: the 90th percentile of the ground along both edges
  const edge = [];
  for (let x = x0 - half; x <= x1 + half; x += 4) for (const z of [cz - half - 2, cz + half + 2]) edge.push(survey.heightAt(x, z));
  edge.sort((a, b) => a - b);
  const rimY = edge[Math.floor(edge.length * 0.9)];
  const depth = Math.max(16, Math.min(P.depth, rimY - (claim.minY + 8)));
  const floorY = rimY - depth;
  const lining = Object.hasOwn(ctx.roles, 'lining') ? 'lining' : 'rock';

  // ---- ground: the rift
  const channel = { kind: 'union', of: [
    { kind: 'capsulePath', points: [[x0, floorY + half, cz], [x1, floorY + half, cz]], r: half },
    { kind: 'box', min: [x0 - half, floorY + half, cz - half], max: [x1 + half, rimY + 40, cz + half] },
  ] };
  const warpN = r.noise('rift_walls', { kind: 'value', dims: 3, scale: 9, octaves: 1 });
  const rift = { kind: 'clipY', y0: { abs: floorY }, y1: null, of: { kind: 'warp', amp: 3, noise: warpN, of: channel } };
  r.part('rift', { stage: 'ground' }).carve(rift, { lining, liningDepth: 1 });
  // the floor: flat at floorY - 1
  const floor = r.part('floor', { stage: 'ground' });
  floor.fill({ kind: 'box', min: [x0 - half + 4, floorY - 3, cz - half + 3], max: [x1 + half - 4, floorY - 1, cz + half - 3] }, lining, { cond: 0 });
  floor.fill({ kind: 'box', min: [x0 - half + 4, floorY, cz - half + 3], max: [x1 + half - 4, floorY + 8, cz + half - 3] }, null, { cond: 0 }); // the warp's bumps off the floor

  // ---- ledges: mid depth, LW wide, on both walls, the north one broken round the hall
  const yl = floorY + round(depth / 2);
  const LW = 9;
  const hallX = cx;
  const ledges = r.part('ledges', { stage: 'ground' });
  const segs = [];
  for (const side of [-1, 1]) {
    const zo = cz + side * half, zi = cz + side * (half - LW); // outer (in the wall) and inner edges
    const zA = Math.min(zo + side * 3, zi), zB = Math.max(zo + side * 3, zi);
    const zw = zo + side * 2; // the clear space reaches 2 into the wall (room for 9-deep lots behind a walkway)
    const spans = side < 0 ? [[x0 + 12, hallX - 16], [hallX + 16, x1 - 12]] : [[x0 + 12, x1 - 12]];
    for (const [a, b] of spans) {
      if (b - a < 12) continue;
      ledges.fill({ kind: 'box', min: [a, floorY, zA], max: [b, yl - 1, zB] }, 'rock', { cond: 0 });
      ledges.fill({ kind: 'box', min: [a, yl - 1, zA], max: [b, yl - 1, zB] }, 'foundation', { cond: 0 });
      ledges.fill({ kind: 'box', min: [a, yl, Math.min(zw, zi)], max: [b, rimY + 8, Math.max(zw, zi)] }, null, { cond: 3 }); // clear above
      // the rail on the inner edge, a lantern on every 8th post
      ledges.fill({ kind: 'box', min: [a, yl, zi], max: [b, yl, zi] }, 'rail', { cond: 3 });
      for (const xe of [a, b]) ledges.fill({ kind: 'box', min: [xe, yl, Math.min(zw, zi)], max: [xe, yl, Math.max(zw, zi)] }, 'rail', { cond: 3 }); // the ends
      for (let x = a + 2; x <= b - 2; x += 8) ledges.fill({ kind: 'box', min: [x, yl + 1, zi], max: [x, yl + 1, zi] }, 'minecraft:lantern', { cond: 3 });
      segs.push({ side, a, b, zi, zo });
    }
  }
  // the side hall (lit), opening off the floor in the north wall
  r.part('hall', { stage: 'ground' }).cavern({ kind: 'ellipsoid', c: [hallX, { abs: floorY + 4 }, cz - half - 8], r: [12, 6, 10] }, { amp: 2, floorY, light: { every: 4 } });
  // a rail round the rift's rim (on the ground, outside the warped wall), lanterns on it
  const rim = r.part('rim_rail', { stage: 'ground' });
  const zr = half + 5, xr0 = x0 - half - 5, xr1 = x1 + half + 5;
  for (const zz of [cz - zr, cz + zr]) rim.fill({ kind: 'box', min: [xr0, { surface: 1 }, zz], max: [xr1, { surface: 1 }, zz] }, 'rail', { cond: 0 });
  for (const xx of [xr0, xr1]) rim.fill({ kind: 'box', min: [xx, { surface: 1 }, cz - zr], max: [xx, { surface: 1 }, cz + zr] }, 'rail', { cond: 0 });
  for (let x = xr0 + 4; x <= xr1 - 4; x += 10) for (const zz of [cz - zr, cz + zr]) rim.fill({ kind: 'box', min: [x, { surface: 2 }, zz], max: [x, { surface: 2 }, zz] }, 'minecraft:lantern', { cond: 0 });
  // lamps on the floor along both walls
  const lamps = r.part('lamps', { stage: 'ground' });
  for (let x = x0 - half + 6; x <= x1 + half - 6; x += 9) for (const zz of [cz - half + 4, cz + half - 4]) lamps.fill({ kind: 'box', min: [x, floorY, zz], max: [x, floorY, zz] }, 'minecraft:lantern', { cond: 3 });

  // ---- ways
  const ways = r.part('ways', { stage: 'ways', set: 'path' });
  // bridges across at rim level, piers on the ledges and the floor, arched between
  const nb = P.bridges;
  const bx = [];
  for (let i = 0; i < nb; i++) bx.push(round(x0 + 20 + ((x1 - x0 - 40) * (i + 0.5)) / nb));
  const levelAt = (x, z) => {
    for (const s of segs) if (x >= s.a && x <= s.b && z >= Math.min(s.zo, s.zi) && z <= Math.max(s.zo, s.zi)) return yl;
    return Math.abs(z - cz) <= half - 3 ? floorY : null;
  };
  const gnd = (x, z) => survey.heightAt(x, z); // a deck starts on the ground (its top block replaced)
  bx.forEach((x, i) => ways.bridge([[x, gnd(x, cz - half - 8), cz - half - 8], [x, gnd(x, cz + half + 8), cz + half + 8]], { width: 3, supports: { every: 13, style: 'arch', rise: 3, bottom: levelAt }, maxSpan: 13, lights: 8, over: 'ours', id: `bridge_${i + 1}` }));
  // spiral towers at the ends: west from the north rim, east from the south rim
  const A = 6;
  const tw = ways.spiralTower({ center: [x0, cz], half: A, top: rimY, bottom: floorY - 1, start: 0, lights: 8, openTop: false, id: 'west_tower' });
  const te = ways.spiralTower({ center: [x1, cz], half: A, top: rimY, bottom: floorY - 1, start: 2, lights: 8, openTop: false, id: 'east_tower' });
  // a landing deck from the ground out to a tower's top: long enough for the height between them
  const landingFrom = (x, zEnd, dir) => { for (let k = Math.max(8, Math.abs(cz + dir * zr - zEnd) + 3); k < 60; k++) { const z = zEnd + dir * k; if (Math.abs(gnd(x, z) - rimY) <= k - 1) return [x, gnd(x, z), z]; } return [x, rimY, zEnd + dir * 8]; };
  ways.bridge([landingFrom(tw.top.x, tw.top.z - 1, -1), [tw.top.x, rimY, tw.top.z - 1]], { width: 3, supports: { every: 12, bottom: levelAt }, over: 'ours', id: 'west_landing' });
  ways.bridge([landingFrom(te.top.x, te.top.z + 1, 1), [te.top.x, rimY, te.top.z + 1]], { width: 3, supports: { every: 12, bottom: levelAt }, over: 'ours', id: 'east_landing' });
  // stairs cut into each ledge (along it, then out onto the floor), one per ledge segment
  for (const s of segs) {
    const rise = yl - floorY;
    const run = rise + 2 * Math.floor((rise - 1) / 8) + 2;
    const zs = s.zi + s.side * 2; // inside the ledge, 2 in from its edge
    if (s.b - s.a < run + 8) continue;
    const xa = s.b - 2 - run, xb = s.b - 2;
    ways.stair([[xa, yl - 1, zs], [xb, floorY - 1, zs], [xb, floorY - 1, s.zi - s.side * 4]], { width: 3, lights: 6, id: `ledge_stair_${s.side < 0 ? 'n' : 's'}_${s.a}` });
    s.stair = [xa - 2, xb + 2];
  }
  // the utility corridor along the floor
  r.part('services', { stage: 'ways', set: 'path' }).utility([[x0 + 10, floorY, cz], [x1 - 10, floorY, cz]], { width: 3, height: 3, kind: 'water' });

  // ---- lots on the ledges, facing the rift, clear of the bridges and the stairs
  const pads = r.part('pads', { stage: 'ground' });
  let li = 0;
  const S = 9; // the smallest library children (the 6a stubs) need 9x9
  for (const s of segs) {
    for (let x = s.a + 2; x + S <= s.b - 1; x += S + 4) {
      if (bx.some((b) => Math.abs(b - (x + S / 2)) < S / 2 + 4)) continue;
      if (s.stair && x + S >= s.stair[0] && x <= s.stair[1]) continue;
      const zz = s.side < 0 ? s.zo - 1 : s.zo - S + 2; // from 2 inside the wall to a walkway beside the rail
      pads.lot(`lot_${++li}`, { at: [x, zz], size: [S, S], floor: yl, front: s.side < 0 ? 'south' : 'north', max: [S, 12, S], brief: BRIEFS[(li - 1) % BRIEFS.length], stage: 'lots', pad: { maxCut: 64, maxFill: 64, edge: 'wall' } });
    }
  }
  r.clearing('entrance', [cx + 4, cz - half - 16], { stage: 'ground' });
  r.clearing('spawn', [cx + 9, cz - half - 16], { stage: 'ground' });
  r.anchor('cam_rift', [x0 - half - 8, rimY + 12, cz]);
  return r;
}
