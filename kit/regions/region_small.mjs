// region_small: a miniature mega_bench for smoke, crash (RG1-RG6) and forest-rim runs. Works for claims of 128x128 up to
// 320x320 (any claim at least 96 on a side), deterministic, robust to missing survey columns, flat worlds and rough land.
//   ground: a bowl carve (radius about 24, depth 8, rubble lining; `bowl: false` leaves it out), one terraced hill of 3
//           levels, 3 lot pads;
//   ways:   a ground road across the claim (converted to graded, or dropped, where 4e could not build it), a short stair
//           into the bowl (onto the hill's lowest level without a bowl), a bridge about 30 long ramping off the hill;
//   lots-1: the lots.
// `cx` / `cz`: the bowl's centre (default: the claim's north-west quarter); the gate uses them to put the rim through a
// forest. The sentinel -30000000 means "default".
import { region } from '../lib/region/program.mjs';
import { compassDir, line4 } from '../lib/region/geom.mjs';

export const id = 'region_small';

const AUTO = -30000000;
export const params = {
  bowl: { type: 'bool', default: true, label: 'Bowl' },
  cx: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Bowl centre x' },
  cz: { type: 'int', min: AUTO, max: 30000000, default: AUTO, label: 'Bowl centre z' },
};

export default function regionSmall(ctx) {
  const { claim, survey, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 96 || D < 96) throw new Error(`region_small needs a claim of at least 96x96 (got ${W}x${D})`);
  const S = Math.min(W, D);
  const round = (v) => Math.floor(v + 0.5);
  const cx = claim.minX + Math.floor(W / 2), cz = claim.minZ + Math.floor(D / 2);
  const r = region(ctx);
  r.stages(['ground', 'ways', 'lots-1']);

  const occ = new Uint8Array(W * D);
  const mark = (x0, z0, x1, z1) => {
    for (let z = Math.max(z0, claim.minZ); z <= Math.min(z1, claim.maxZ); z++) for (let x = Math.max(x0, claim.minX); x <= Math.min(x1, claim.maxX); x++) occ[(z - claim.minZ) * W + x - claim.minX] = 1;
  };
  const free = (x0, z0, x1, z1) => {
    if (x0 < claim.minX + 2 || z0 < claim.minZ + 2 || x1 > claim.maxX - 2 || z1 > claim.maxZ - 2) return false;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (occ[(z - claim.minZ) * W + x - claim.minX]) return false;
    return true;
  };
  const markLine = (a, b, half) => { for (const [x, z] of line4(round(a[0]), round(a[1]), round(b[0]), round(b[1]))) mark(x - half, z - half, x + half, z + half); };

  // ---- ground: the bowl
  const br = Math.min(24, Math.floor(S / 6));
  let depth = 8;
  const bx = P.cx === AUTO ? claim.minX + Math.floor(W / 4) + 4 : P.cx;
  const bz = P.cz === AUTO ? claim.minZ + Math.floor(D / 4) + 4 : P.cz;
  let rimY = null, bowlBottom = null;
  if (P.bowl) {
    const g = [];
    for (let z = bz - br; z <= bz + br; z += 2) for (let x = bx - br; x <= bx + br; x += 2) if ((x - bx) * (x - bx) + (z - bz) * (z - bz) <= br * br) g.push(survey.heightAt(x, z));
    g.sort((a, b) => a - b);
    rimY = g[g.length >> 1];
    // keep the claim's bottom 2 rows (bedrock on a flat world) out of the carve and its lining
    depth = Math.max(1, Math.min(8, rimY - (claim.minY + 2) - 1));
    const lining = Math.max(1, Math.min(1, rimY - depth - (claim.minY + 2)));
    r.part('crater', { stage: 'ground' }).carve({ kind: 'bowl', c: [bx, { abs: rimY }, bz], r: br, depth, profile: 'parabolic', h: 16 }, { lining: 'rubble', liningDepth: lining });
    bowlBottom = (x, z) => {
      const d = Math.sqrt((x - bx) * (x - bx) + (z - bz) * (z - bz));
      if (d > br) return null;
      const t = d / br;
      return Math.max(claim.minY + 1, Math.ceil(rimY - depth * (1 - t * t)));
    };
    for (let dz = -br - 6; dz <= br + 6; dz++) { const h = Math.floor(Math.sqrt((br + 6) * (br + 6) - dz * dz)); mark(bx - h, bz + dz, bx + h, bz + dz); }
  }

  // ---- ground: one terraced hill (3 levels, retaining walls, stairs between levels)
  const hr = Math.min(28, Math.floor(S / 8));
  const hx = claim.minX + Math.floor((3 * W) / 4) - 4, hz = claim.minZ + Math.floor((3 * D) / 4) - 4;
  const levels = r.part('hill', { stage: 'ground' }).terrace({ center: [hx, hz], radius: hr }, 3, { edge: 'wall', step: 3, stairs: true, startAngle: 315 });
  mark(hx - hr - 6, hz - hr - 6, hx + hr + 6, hz + hr + 6);

  // ---- ways: a ground road across the claim (north-south through the centre)
  const roads = r.part('roads', { stage: 'ways', set: 'path' });
  const ra = [cx, claim.minZ + 4], rb = [cx, claim.maxZ - 4];
  roads.road([ra, rb], { width: 3, optional: true, id: 'main_road' });
  markLine(ra, rb, 5);

  // ---- ways: a short stair into the bowl (or onto the hill), and a bridge ramping off the hill top
  const ways = r.part('ways', { stage: 'ways', set: 'path' });
  if (P.bowl) {
    const a = [bx + br + 2, rimY, bz], b = [bx + 4, bowlBottom(bx + 4, bz) - 1, bz];
    ways.stair([a, b], { width: 3, id: 'bowl_stair' });
  } else {
    const y0 = levels[0].y;
    const a = [hx - hr - 8, survey.heightAt(hx - hr - 8, hz), hz], b = [hx - hr + 1, y0, hz];
    const len = Math.abs(b[0] - a[0]);
    a[1] = Math.max(y0 - Math.floor((len * 8) / 10) + 1, Math.min(y0 + Math.floor((len * 8) / 10) - 1, a[1]));
    ways.stair([a, b], { width: 3, id: 'hill_stair' });
  }
  const top = levels[levels.length - 1];
  const d = compassDir(225);
  const p0 = [hx + d[0] * (top.radius - 2), hz + d[1] * (top.radius - 2)];
  const p1 = [hx + d[0] * (top.radius + 19), hz + d[1] * (top.radius + 19)];
  const len = Math.abs(round(p1[0]) - round(p0[0])) + Math.abs(round(p1[1]) - round(p0[1]));
  const g1 = survey.heightAt(round(p1[0]), round(p1[1]));
  const endY = Math.max(top.y - (len - 2), Math.min(top.y + (len - 2), g1));
  ways.bridge([[p0[0], top.y, p0[1]], [p1[0], endY, p1[1]]], { width: 3, supports: { every: 10, bottom: bowlBottom ?? undefined }, id: 'hill_bridge' });
  markLine(p0, p1, 4);

  // ---- lots: 3 pads, a seeded search (sizes shrink, limits relax)
  const lr = ctx.rng('lots');
  const cand = [];
  for (let z = claim.minZ + 4; z <= claim.maxZ - 16; z += 3) for (let x = claim.minX + 4; x <= claim.maxX - 16; x += 3) cand.push([x, z]);
  lr.shuffle(cand);
  const want = [0, 1, 2].map(() => ({ w: lr.int(9, 12), d: lr.int(9, 12), h: lr.int(6, 10) }));
  const pads = [];
  for (const lim of [4, 8, 16, 32, 64]) {
    for (const [x, z] of cand) {
      if (pads.length >= want.length) break;
      const lw = want[pads.length];
      for (const [w, dd] of [[lw.w, lw.d], [9, 9]]) {
        const ps = survey.padStats(x, z, w, dd);
        if (ps.cut > lim || ps.fill > lim) continue;
        const m = 3 + Math.max(ps.cut, ps.fill);
        if (!free(x - m, z - m, x + w - 1 + m, z + dd - 1 + m)) continue;
        pads.push({ x, z, w, d: dd, h: lw.h, cut: ps.cut, fill: ps.fill });
        mark(x - m, z - m, x + w - 1 + m, z + dd - 1 + m);
        break;
      }
    }
    if (pads.length >= want.length) break;
  }
  if (pads.length < want.length) r.note(`lots: only ${pads.length} of ${want.length} lots found a pad`);

  r.anchor('spawn', [cx, survey.heightAt(cx, cz) + 1, cz]);
  r.anchor('entrance', [cx, survey.heightAt(cx, claim.maxZ - 2) + 1, claim.maxZ - 2]);
  pads.forEach((p, i) => {
    const lid = `lot_${i + 1}`;
    r.part(`pad_${lid}`, { stage: 'ground' }).lot(lid, { at: [p.x, p.z], size: [p.w, p.d], max: [p.w, p.h, p.d], front: 'toward:spawn', stage: 'lots-1', pad: { maxCut: p.cut, maxFill: p.fill } });
  });
  return r;
}
