// relief_demo (6c T1, docs/CONTRACT.md "Phase 6c slice T1" §6): the relief pass's fixture. Pads on `pad.edge: 'blend'` (the
// default of a program that declares passes, N-T1-1) and path corridors between them; the relief pass blends the land around
// them, with the erosion touch-up. On S3's pinned claim (natural) it finds its own sites; on a flat world (the scenario's flat
// variant) it raises a hill through the pass's `base` first, so the exactness check sees cut, fill and blend: two pads on the
// hill, one sunk 2 below the flat ground.
//   ground: the pads (`pads` part), the relief (`relief` part, the pads' stage);  lots-1: the lots.
// `edge: 'slope'` is the same program with 6a's 1:1 batters and no pass (the organic-read comparison, item 4). `pads` up to 64
// (the 1024x1024 plan-time bench). Plan time only uses integer math and the kit's helpers (no trig).
import { region } from '../lib/region/program.mjs';

export const id = 'relief_demo';
export const catalogue = false;
export const passes = ['relief'];

export const params = {
  pads: { type: 'int', min: 1, max: 64, default: 3, label: 'Pads' },
  radius: { type: 'int', min: 4, max: 32, default: 12, label: 'Blend radius' },
  edge: { type: 'enum', options: ['blend', 'slope'], default: 'blend', label: 'Pad edge' },
  erode: { type: 'bool', default: true, label: 'Erosion touch-up' },
};

const SIZES = [[14, 12], [12, 12], [16, 12], [12, 14]];
const HILL = 14; // the flat variant's hill: height and (below) radius

export default function reliefDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 96 || D < 96) throw new Error(`relief_demo needs a claim of at least 96x96 (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'lots-1']);
  const c = S.columns, res = c.resolution;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const flat = st.maxGround - st.minGround <= 2;
  const margin = P.radius + 4;
  const cx = claim.minX + (W >> 1), cz = claim.minZ + (D >> 1);

  // ---- the flat variant's hill (a quadratic mound, integer): the land the relief blends into there
  const hillR = Math.min(56, (Math.min(W, D) >> 1) - margin);
  const hillAt = (x, z) => {
    if (!flat) return 0;
    const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    return d2 >= hillR * hillR ? 0 : Math.floor((HILL * (hillR * hillR - d2)) / (hillR * hillR));
  };
  const landAt = (x, z) => S.groundAt(x, z) + hillAt(x, z);

  // ---- sites: pads where a pad's cut and fill (against the land) are small, away from water and the claim's edge
  const water = (x0, z0, x1, z1) => S.stats(x0 - 3, z0 - 3, x1 + 3, z1 + 3).water > 0;
  const padOn = (x0, z0, w, d) => {
    let mx = -Infinity, mn = Infinity;
    for (let z = z0 - 1; z <= z0 + d; z += res) for (let x = x0 - 1; x <= x0 + w; x += res) { const g = landAt(x, z); if (g > mx) mx = g; if (g < mn) mn = g; }
    const top = (mx + mn) >> 1;
    return { top, cut: mx - top, fill: top - mn };
  };
  // gentle land around a site (the band the pass blends): no step between neighbouring samples over `maxStep` (a ravine or a cliff
  // within the radius can't be blended within the clamps)
  const gentle = (x0, z0, x1, z1, maxStep) => {
    const R = P.radius;
    for (let z = z0 - R; z <= z1 + R; z += res) for (let x = x0 - R; x <= x1 + R; x += res) {
      const g = landAt(x, z);
      if (Math.abs(landAt(x + res, z) - g) > maxStep * res || Math.abs(landAt(x, z + res) - g) > maxStep * res) return false;
    }
    return true;
  };
  const step = Math.max(4, res * 2);
  const cands = [];
  let k = 0;
  for (let z = claim.minZ + margin; z + 16 <= claim.maxZ - margin; z += step) {
    for (let x = claim.minX + margin; x + 16 <= claim.maxX - margin; x += step) {
      const [w, d] = SIZES[k++ % SIZES.length];
      if (water(x, z, x + w - 1, z + d - 1)) continue;
      const p = padOn(x, z, w, d);
      if (p.cut > 4 || p.fill > 4 || !gentle(x, z, x + w - 1, z + d - 1, 3)) continue;
      cands.push({ x, z, w, d, top: p.top, score: p.cut + p.fill });
    }
  }
  if (!cands.length) throw new Error('relief_demo: no pad site on this claim (every candidate needs more than 4 of cut or fill, or is by water)');
  cands.sort((a, b) => a.score - b.score || a.z - b.z || a.x - b.x);
  const gap = 8;
  const clash = (a, b) => a.x - gap <= b.x + b.w - 1 && b.x - gap <= a.x + a.w - 1 && a.z - gap <= b.z + b.d - 1 && b.z - gap <= a.z + a.d - 1;
  const centre = (a) => [a.x + (a.w >> 1), a.z + (a.d >> 1)];
  // a corridor from a's centre to b's at the pads' tops, linear; feasible when every cell outside the pads is within 4 of the land
  // (cut and fill), dry and treeless, and its grade at most 1 in 2
  const corridorOf = (a, b) => {
    const [ax, az] = centre(a), [bx, bz] = centre(b);
    const n = Math.max(Math.abs(bx - ax), Math.abs(bz - az));
    if (n < 1 || Math.abs(b.top - a.top) * 2 > n) return null;
    const inPad = (x, z, p) => x >= p.x - 1 && x <= p.x + p.w && z >= p.z - 1 && z <= p.z + p.d;
    for (let s = 0; s <= n; s++) {
      const x = ax + Math.floor((2 * (bx - ax) * s + n) / (2 * n)), z = az + Math.floor((2 * (bz - az) * s + n) / (2 * n));
      const y = a.top + Math.floor((2 * (b.top - a.top) * s + n) / (2 * n));
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Z = z + dz;
        if (inPad(X, Z, a) || inPad(X, Z, b)) continue;
        if (S.waterAt(X, Z) || (c.flags[sIdx(X, Z)] & 4) || Math.abs(y - landAt(X, Z)) > 4) return null;
      }
    }
    return { path: [[ax, a.top, az], [bx, b.top, bz]], width: 3 };
  };
  const sIdx = (x, z) => {
    let i = Math.floor((x - c.minX + (res >> 1)) / res), j = Math.floor((z - c.minZ + (res >> 1)) / res);
    i = Math.max(0, Math.min(c.width - 1, i)); j = Math.max(0, Math.min(c.depth - 1, j));
    return i + j * c.width;
  };
  const chosen = [cands[0]];
  const corridors = [];
  // the flat variant: the first pad on the hill's top, the second on its flank, the third sunk 2 below the flat ground
  if (flat) {
    chosen.length = 0;
    const put = (x, z, w, d, top) => chosen.push({ x, z, w, d, top, score: 0 });
    put(cx - 7, cz - 6, 14, 12, landAt(cx, cz));
    const fx = cx + 22, fz = cz - 6;
    put(fx, fz, 12, 12, padOn(fx, fz, 12, 12).top);
    const sx = cx - hillR - 20, sz = cz - 6;
    put(sx, sz, 12, 12, st.median - 2);
    for (let i = 0; i + 1 < chosen.length; i++) {
      const a = chosen[i], b = chosen[i + 1], [ax, az] = centre(a), [bx, bz] = centre(b);
      corridors.push(corridorOf(a, b) ?? { path: [[ax, a.top, az], [bx, b.top, bz]], width: 3 });
    }
  } else {
    // a chain of pads, each within 56 of a chosen one with a feasible corridor to it: from each start (best sites first, at most 64
    // tried) until a chain has every corridor; else the longest found (then pads without a corridor fill up the count)
    const chainFrom = (first) => {
      const ch = [first], cors = [];
      while (ch.length < P.pads) {
        // the next pad: the best site with a feasible corridor to any pad of the chain (a tree of corridors)
        let pick = null, cor = null;
        for (const q of cands) {
          if (ch.some((p) => clash(p, q))) continue;
          const [qx, qz] = centre(q);
          for (const prev of ch) {
            const [px, pz] = centre(prev);
            if (Math.max(Math.abs(qx - px), Math.abs(qz - pz)) > 56) continue;
            const cr = corridorOf(prev, q);
            if (cr) { pick = q; cor = cr; break; }
          }
          if (pick) break;
        }
        if (!pick) break;
        ch.push(pick); cors.push(cor);
      }
      return { ch, cors };
    };
    let best = null;
    for (const first of cands.slice(0, 64)) {
      const t = chainFrom(first);
      if (!best || t.ch.length > best.ch.length) best = t;
      if (t.ch.length >= P.pads) break;
    }
    chosen.length = 0;
    chosen.push(...best.ch);
    corridors.push(...best.cors);
    for (const q of cands) { if (chosen.length >= P.pads) break; if (!chosen.some((p) => clash(p, q))) chosen.push(q); }
  }

  // ---- the pads and their lots (lots-1)
  const pads = r.part('pads', { stage: 'ground' });
  const lots = chosen.map((p, i) => pads.lot(`lot_${i + 1}`, {
    at: [p.x, p.z], size: [p.w, p.d], floor: p.top + 1, front: 'south', stage: 'lots-1',
    pad: { edge: P.edge, maxCut: flat ? 6 : 6, maxFill: flat ? HILL + 2 : 6 },
  }));
  // ---- the relief pass (blend) or, with edge 'slope', the batters alone
  if (P.edge === 'blend') {
    const base = flat ? (() => {
      const bw = 2 * hillR + 1, values = new Int16Array(bw * bw);
      for (let j = 0; j < bw; j++) for (let i = 0; i < bw; i++) values[i + j * bw] = hillAt(cx - hillR + i, cz - hillR + j);
      return { minX: cx - hillR, minZ: cz - hillR, width: bw, depth: bw, values };
    })() : null;
    r.pass('relief', { around: [...lots, ...corridors], radius: P.radius, maxCut: 6, maxFill: flat ? HILL + 2 : 6, erode: P.erode ? { thermal: 2, stream: 1 } : null, ...(base ? { base } : {}) });
  }
  r.note(`relief_demo: ${chosen.length} pads (of ${cands.length} sites), ${corridors.length} corridor(s)${flat ? ', on a flat world: a hill raised through the pass\'s base' : ''}`);

  // ---- anchors and cameras around the pads' centroid
  const e = lots[0].entrance;
  r.anchor('entrance', [e[0], e[1], e[2]]);
  r.anchor('spawn', [e[0], e[1], e[2]]);
  // the hub (the cameras look at it): the middle pad's entrance
  const [hx, hy, hz] = lots[chosen.length >> 1].entrance; // (on its apron: the lot's box is an obstacle)
  r.anchor('hub', [hx, hy, hz]);
  const clampX = (x) => Math.max(claim.minX, Math.min(claim.maxX, x)), clampZ = (z) => Math.max(claim.minZ, Math.min(claim.maxZ, z));
  const camY = (x, z, up) => Math.min(claim.maxY - 1, Math.max(hy, S.topAt(x, z)) + up);
  const cam = (n, x, z, up) => r.anchor(n, [clampX(x), camY(clampX(x), clampZ(z), up), clampZ(z)]);
  cam('cam_n', hx, hz - 60, 30); cam('cam_s', hx, hz + 60, 30); cam('cam_e', hx + 60, hz, 30); cam('cam_w', hx - 60, hz, 30);
  cam('cam_high', hx + 8, hz + 8, 70); cam('cam_ground', hx + 24, hz + 30, 3);
  r.meta.relief = { flat, pads: chosen.map((p) => ({ at: [p.x, p.z], size: [p.w, p.d], top: p.top })), corridors: corridors.map((x) => x.path), hill: flat ? { at: [cx, cz], r: hillR, h: HILL } : null };
  return r;
}
