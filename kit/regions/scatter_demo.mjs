// scatter_demo (docs/CONTRACT.md 6c F2 §5): the scatter and stamps fixture, not a catalogue program.
//
// Surface (default; S2's pinned claim, or its flat variant): a boardwalk path (walk cells) and one pad lot, then
//   - a stamp of each surface library feature (oak, birch, spruce, acacia, dark oak, huge brown and red mushrooms) on land, and a
//     fossil buried in the ground with its top at the surface (`stamps`, default on; off: the committed golden's variant, N-F2-1);
//   - path lanterns (light 15, lantern posts in spruce) by distance to the path: they clear the natural snow layers within their melt
//     reach and never stand where ice is within it (M17);
//   - ground decoration: boulders, stumps, shrubs, fern patches, moss carpets and snow layers (never where a planned light melts them),
//     plus small library trees as scatter stamp items (a boulder when the library lacks them).
// Cave (`cave: true`; the 6b volume fixture's cliff-and-cave claim): glow lichen on the frozen volume's cave walls and ceilings (2 or
//   more under the ground), and dripstone-cluster stamps fitted into the cave (each part of the stamp touches the cave's rock).
//
// Two-plan flow: the first plan asks for the claim's volume (the natural ice is kept, `keepNatural('ICE')`); the second reads it.
// Deterministic: candidate sites are sorted scans; no Math.random. Stamps come from the local library (ctx.stamps); a missing one is
// a plan note.
import { region } from '../lib/region/program.mjs';
import { scatter, stamp } from '../lib/region/scatterPlan.mjs';
import { turnXZ, voxelAt, ROTATIONS } from '../lib/region/voxels.mjs';
import { classAt, VC } from '../lib/region/volume.mjs';

export const id = 'scatter_demo';
export const catalogue = false;
export const params = {
  stamps: { type: 'bool', default: true, label: 'Library stamps' },
  cave: { type: 'bool', default: false, label: 'Cave decoration (walls and ceilings)' },
  density: { type: 'int', min: 5, max: 90, default: 60, label: 'Ground decoration density (%)' },
  lanterns: { type: 'bool', default: true, label: 'Path lanterns' },
};

export const SURFACE_STAMPS = ['oak/1', 'birch/1', 'spruce/1', 'acacia/1', 'dark_oak/1', 'huge_brown_mushroom/1', 'huge_red_mushroom/1'];
export const BURIED_STAMPS = ['fossil_coal/1'];
export const CAVE_STAMPS = ['dripstone_cluster/1', 'dripstone_cluster/2'];
const SOLID = new Set([VC.ROCK, VC.SOIL, VC.LOOSE, VC.ICE, VC.SNOW]);

/** `build(ctx, hooks)`: the program with the gate's broken-variant hooks (`hooks.after(r, info)`). */
export function build(ctx, hooks = {}) {
  const { claim, survey: S, params: P } = ctx;
  const r = region(ctx);
  r.stages(['ground', 'decor', 'lots-1']);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 64 || D < 64) throw new Error(`scatter_demo needs a claim of at least 64x64 (got ${W}x${D})`);
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  const info = { cave: P.cave, stamps: [], missing: [], path: null, lot: null, scatter: [] };
  const box = P.cave
    ? { minX: claim.minX, minZ: claim.minZ, maxX: claim.maxX, maxZ: claim.maxZ, minY: Math.max(claim.minY, st.minFloor - 40), maxY: Math.min(claim.maxY, st.minFloor + 87) }
    : { minX: claim.minX, minZ: claim.minZ, maxX: claim.maxX, maxZ: claim.maxZ, minY: Math.max(claim.minY, st.minFloor - 8), maxY: Math.min(claim.maxY, st.maxTop + 8) };
  const keep = P.cave ? null : r.keepNatural('ICE', box, { stage: 'ground' });
  const vol = r.needVolume(box);
  const cls = (x, y, z) => (vol ? classAt(vol, x, y, z) : null);
  const inClaim = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  // land: dry, known, not a tree column, and (with the volume) its ground cell is rock, soil, loose or snow
  const land = (x, z) => {
    if (!inClaim(x, z) || S.waterAt(x, z) || S.missingAt(x, z)) return false;
    if (!vol) return true;
    const c = cls(x, S.groundAt(x, z), z);
    return c === VC.ROCK || c === VC.SOIL || c === VC.LOOSE || c === VC.SNOW;
  };
  const taken = new Set(); // "x,z" columns a path, the lot or a stamp holds (and their 1-ring)
  const take = (x, z, ring = 1) => { for (let dx = -ring; dx <= ring; dx++) for (let dz = -ring; dz <= ring; dz++) taken.add(`${x + dx},${z + dz}`); };
  const nearKeep = (x, z, rr) => !!keep && keep.near(x, z, rr);

  if (!P.cave) {
    // ---- the path: the longest run of land along a row near the centre (2 wide, at most 64 long), boardwalk planks at the ground
    let best = null;
    for (let dz = 0; dz <= 48; dz += 3) for (const z of dz ? [cz - dz, cz + dz] : [cz]) {
      let run = null;
      for (let x = claim.minX + 8; x <= claim.maxX - 8; x++) {
        const ok = land(x, z) && land(x, z + 1) && !nearKeep(x, z, 2) && !nearKeep(x, z + 1, 2) && Math.abs(S.groundAt(x, z) - S.groundAt(x, z + 1)) <= 1
          && (!run || Math.abs(S.groundAt(x, z) - S.groundAt(x - 1, z)) <= 1);
        if (ok) { run = run ?? { z, x0: x }; run.x1 = x; } else run = null;
        if (run && (!best || run.x1 - run.x0 > best.x1 - best.x0)) best = { ...run };
      }
    }
    if (best && best.x1 - best.x0 >= 15) {
      const x1 = Math.min(best.x1, best.x0 + 63);
      const cols = [];
      for (let x = best.x0; x <= x1; x++) for (const z of [best.z, best.z + 1]) { cols.push(x, z, 0, 0, 0); take(x, z, 1); }
      r.part('path', { stage: 'ground', set: 'path' })._push({ op: 'columns', from: { surface: 0 }, to: { surface: 0 }, cols, materials: [r.material('minecraft:spruce_planks')], cond: 0, walk: true });
      r.meta.parts.path = { kind: 'path' };
      info.path = { z: best.z, x0: best.x0, x1, cells: cols.length / 5 };
    } else r.note('scatter_demo: no land run of 16 for the path');
    // ---- one lot: the flattest 10x10 pad site clear of the path, the kept ice and the claim's edge
    let lot = null;
    for (let z = claim.minZ + 12; z <= claim.maxZ - 22 && !lot; z += 4) {
      for (let x = claim.minX + 12; x <= claim.maxX - 22; x += 4) {
        const s2 = S.stats(x - 1, z - 1, x + 10, z + 10);
        if (s2.water || s2.maxGround - s2.minGround > 2 || nearKeep(x + 5, z + 5, 9)) continue;
        let clear = true;
        for (let dx = -3; dx <= 12 && clear; dx++) for (let dz = -3; dz <= 12; dz++) if (taken.has(`${x + dx},${z + dz}`) || !land(x + dx, z + dz)) { clear = false; break; }
        if (!clear) continue;
        lot = { x, z, range: s2.maxGround - s2.minGround };
        break;
      }
    }
    if (lot) {
      r.part('pads', { stage: 'ground' }).lot('lot_1', { at: [lot.x, lot.z], size: [10, 10], max: [10, 8, 10], pad: { maxCut: 3, maxFill: 3 }, stage: 'lots-1' });
      for (let dx = -2; dx <= 11; dx++) for (let dz = -2; dz <= 11; dz++) take(lot.x + dx, lot.z + dz, 0);
      info.lot = lot;
    } else r.note('scatter_demo: no flat site for the lot');
  }

  // ---- stamps: each fitted where every part of it touches solid natural ground (the frozen volume, else the survey)
  // solid as the checker's M3 reads it: a snow-class cell counts only at or under the column's ground (a snow block: the survey's
  // ground skips a snow layer, which is not solid)
  const solidAt = (x, y, z) => {
    if (vol) { const c = cls(x, y, z); return c !== null && SOLID.has(c) && (c !== VC.SNOW || (inClaim(x, z) && y <= S.groundAt(x, z))); }
    return inClaim(x, z) && y <= S.groundAt(x, z);
  };
  const stampCells = (s, k) => {
    const v = s.voxels, [sx, , sz] = v.size, [rx, ry, rz] = s.root;
    const [trx, trz] = turnXZ(rx, rz, sx, sz, k);
    const out = [];
    for (let i = 0; i < v.count; i++) {
      const st2 = v.palette[v.pal[i]];
      if (/^minecraft:(water|lava)/.test(st2)) continue;
      const [lx, ly, lz] = voxelAt(v, i);
      const [tx, tz] = turnXZ(lx, lz, sx, sz, k);
      out.push([tx - trx, ly - ry, tz - trz]);
    }
    return out;
  };
  /** Every face-connected group of the placed cells touches a solid natural cell outside the stamp (no floating part). */
  const grounded = (cells, at) => {
    const set = new Set(cells.map(([dx, dy, dz]) => `${at[0] + dx},${at[1] + dy},${at[2] + dz}`));
    const seen = new Set();
    for (const k0 of set) {
      if (seen.has(k0)) continue;
      const comp = [k0];
      seen.add(k0);
      let touches = false;
      for (let i = 0; i < comp.length; i++) {
        const [x, y, z] = comp[i].split(',').map(Number);
        for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const k = `${x + a},${y + b},${z + c}`;
          if (set.has(k)) { if (!seen.has(k)) { seen.add(k); comp.push(k); } } else if (!touches && solidAt(x + a, y + b, z + c)) touches = true;
        }
      }
      if (!touches) return false;
    }
    return true;
  };
  const lib = ctx.stamps ?? null;
  const placeStamp = (sid, mode) => {
    const s = lib && lib.has(sid) ? lib.get(sid) : null;
    if (!s || !P.stamps) { if (P.stamps) info.missing.push(sid); stamp(r, sid, [cx, S.groundAt(cx, cz) + 1, cz], { stage: 'decor' }); return null; }
    for (let k = 0; k < 4; k++) {
      const cells = stampCells(s, k);
      let mnX = 0, mxX = 0, mnZ = 0, mxZ = 0, mnY = 0, mxY = 0;
      for (const [dx, dy, dz] of cells) { mnX = Math.min(mnX, dx); mxX = Math.max(mxX, dx); mnZ = Math.min(mnZ, dz); mxZ = Math.max(mxZ, dz); mnY = Math.min(mnY, dy); mxY = Math.max(mxY, dy); }
      const cand = [];
      if (mode === 'cave') {
        // cave floors in the volume: an air cell over rock, with at least 3 of air above it, deep under the ground
        for (let x = claim.minX - mnX + 2; x <= claim.maxX - mxX - 2; x += 3) for (let z = claim.minZ - mnZ + 2; z <= claim.maxZ - mxZ - 2; z += 3) {
          const g = S.groundAt(x, z);
          for (let y = box.minY + 1 - mnY; y < Math.min(g - 6, box.maxY - mxY); y++) {
            if (cls(x, y, z) === VC.AIR && SOLID.has(cls(x, y - 1, z)) && cls(x, y + 1, z) === VC.AIR && cls(x, y + 2, z) === VC.AIR) cand.push([x, y, z]);
          }
        }
      } else {
        for (let x = claim.minX - mnX + 3; x <= claim.maxX - mxX - 3; x += 2) for (let z = claim.minZ - mnZ + 3; z <= claim.maxZ - mxZ - 3; z += 2) {
          if (!land(x, z)) continue;
          const g = S.groundAt(x, z);
          if (mode === 'buried') cand.push([x, g - mxY, z]);
          // on the ground, or sunk 1 (the base replaces the ground cell: a cap whose rim meets the stem only at an edge rests its rim)
          else cand.push([x, g + 1, z], [x, g, z]);
        }
      }
      // the sites nearest the claim's centre first (then north-west first): the stamps stand around the path and the lot
      if (mode !== 'cave') cand.sort((a2, b2) => Math.abs(a2[0] - cx) + Math.abs(a2[2] - cz) - (Math.abs(b2[0] - cx) + Math.abs(b2[2] - cz)) || a2[2] - b2[2] || a2[0] - b2[0]);
      for (const at of cand) {
        let ok = true;
        const cols = new Set();
        for (const [dx, dy, dz] of cells) {
          const x = at[0] + dx, z = at[2] + dz;
          const key = `${x},${z}`;
          if (cols.has(key)) continue;
          cols.add(key);
          if (!inClaim(x, z) || taken.has(key) || nearKeep(x, z, 1)) { ok = false; break; }
          if (mode === 'surface' && (!land(x, z) || S.groundAt(x, z) > at[1] || S.groundAt(x, z) < at[1] - 3)) { ok = false; break; }
          if (mode === 'buried' && (!land(x, z) || S.groundAt(x, z) < at[1] + mxY)) { ok = false; break; }
        }
        if (!ok || !grounded(cells, at)) continue;
        for (const key of cols) { const [x, z] = key.split(',').map(Number); take(x, z, 1); }
        const got = stamp(r, sid, at, { rotation: ROTATIONS[k], stage: 'decor' });
        info.stamps.push({ id: sid, at, rotation: ROTATIONS[k], mode, cells: cells.length });
        return got;
      }
    }
    r.note(`scatter_demo: no fit for stamp ${sid}`);
    info.missing.push(`${sid} (no fit)`);
    return null;
  };

  if (!P.cave) {
    if (P.stamps) {
      for (const sid of SURFACE_STAMPS) placeStamp(sid, 'surface');
      for (const sid of BURIED_STAMPS) placeStamp(sid, 'buried');
    }
    // ---- path lanterns (light 15) beside the path; then the ground decoration (snow layers never where a planned light melts them)
    if (P.lanterns && info.path) {
      const res = scatter(r, 'lanterns', { grid: 5, jitter: 2, density: { path: [2, 4], p: 0.9 }, items: [{ w: 1, item: 'path_lantern', light: 'minecraft:lantern', rail: 'minecraft:spruce_fence' }] }, { stage: 'decor' });
      info.scatter.push(res);
    }
    const items = [
      { w: 6, item: 'boulder' }, { w: 3, item: 'stump' }, { w: 3, item: 'shrub' }, { w: 4, item: 'fern_patch' }, { w: 4, item: 'moss_carpet' }, { w: 8, item: 'snow_layer' },
      ...(P.stamps ? [{ w: 2, stamp: ['spruce/2', 'oak/2'], skirt: 2 }] : []),
    ];
    info.scatter.push(scatter(r, 'ground_decor', { grid: 7, jitter: 2, density: P.density / 100, items }, { stage: 'decor' }));
  } else {
    // ---- the cave: glow lichen on walls and ceilings at least 2 under the ground; dripstone clusters fitted into the cave
    if (P.stamps) for (const sid of CAVE_STAMPS) placeStamp(sid, 'cave');
    info.scatter.push(scatter(r, 'cave_lichen', { grid: 3, jitter: 1, density: 0.6, y: [box.minY + 1, box.maxY - 1], mask: { depth: [2, 400] }, items: [{ w: 2, item: 'glow_lichen' }] }, { stage: 'decor' }));
  }

  // anchors: the entrance and spawn on the land nearest the centre; a hub; cameras on a ring above the claim
  let bestA = null;
  for (let rr = 0; rr < Math.max(W, D) / 2 && !bestA; rr += 2) {
    for (let dz = -rr; dz <= rr && !bestA; dz += 2) for (let dx = -rr; dx <= rr; dx += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rr) continue;
      const x = cx + dx, z = cz + dz;
      if (land(x, z) && !taken.has(`${x},${z}`) && !nearKeep(x, z, 2)) { bestA = [x, z]; break; }
    }
  }
  const [ex, ez] = bestA ?? [cx, cz];
  r.anchor('entrance', [ex, ez]);
  r.anchor('spawn', [ex, ez]);
  r.anchor('hub', [cx, S.groundAt(cx, cz) + 1, cz]);
  const camY = Math.min(claim.maxY - 1, st.maxTop + 40);
  r.anchor('cam_n', [cx, camY, claim.minZ]);
  r.anchor('cam_s', [cx, camY, claim.maxZ]);
  r.anchor('cam_e', [claim.maxX, camY, cz]);
  r.anchor('cam_w', [claim.minX, camY, cz]);
  r.anchor('cam_high', [cx, Math.min(claim.maxY - 1, st.maxTop + 80), cz + 20]);
  r.anchor('cam_ground', [ex, S.groundAt(ex, ez) + 3, ez]);
  r.meta.scatterDemo = info;
  if (hooks.after) hooks.after(r, info);
  return r;
}

export default function scatterDemo(ctx) {
  return build(ctx);
}
