// forms_demo (docs/CONTRACT.md 6c F1 §7): the forms I fixture, not a catalogue program. On S2's pinned claim (or its flat
// variant) it grows 6 `iceSpike` clusters and 3 `rockSpire`s on land, keeps the claim's natural ice (`keepNatural('ICE')`: the
// frozen sea and the natural spikes are never written, and no form stands within 3 of them), and lights each ice cluster with a
// soul-lantern post (block light 10: melt-safe beside ice and snow, M17). One spire is baked to a `voxels` op (`bake`, default
// on) so the gate sees a baked form realised. Two-plan flow: the first plan asks for the claim's volume; the second reads it.
// Deterministic: placement is a sorted scan of a grid, no Math.random.
import { region } from '../lib/region/program.mjs';

export const id = 'forms_demo';
export const catalogue = false;
export const params = {
  spikes: { type: 'int', min: 0, max: 12, default: 6, label: 'Ice-spike clusters' },
  spires: { type: 'int', min: 0, max: 6, default: 3, label: 'Rock spires' },
  bake: { type: 'bool', default: true, label: 'Bake the first spire' },
  lamps: { type: 'bool', default: true, label: 'Soul-lantern posts' },
};

/** The site of a form: footprint radius, and the slope it accepts. */
const SPIKE_R = 9, SPIRE_R = 16, KEEP_GAP = 3;

/** `build(ctx, hooks)`: the program with the gate's broken-variant hooks (`hooks.after(r, info)`). */
export function build(ctx, hooks = {}) {
  const { claim, survey, params: P } = ctx;
  const r = region(ctx);
  r.stages(['forms']);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 64 || D < 64) throw new Error(`forms_demo needs a claim of at least 64x64 (got ${W}x${D})`);
  // the claim's frozen volume: from 8 under the lowest floor to 8 over the highest top
  const st = survey.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const box = { minX: claim.minX, minZ: claim.minZ, maxX: claim.maxX, maxZ: claim.maxZ, minY: Math.max(claim.minY, st.minFloor - 8), maxY: Math.min(claim.maxY, st.maxTop + 8) };
  const keep = r.keepNatural('ICE', box, { stage: 'forms' });
  const vol = keep ? r.needVolume(box) : null;
  // land: not water in the survey; with the volume, the column's top solid cell is soil, rock, loose or snow (not ice or water)
  const VC_TOP_OK = new Set([1, 2, 3, 5]); // ROCK, SOIL, LOOSE, SNOW (lib/region/volume.mjs VOXEL_CLASSES)
  const topClass = (x, z) => {
    if (!vol) return null;
    const lx = x - vol.box.minX, lz = z - vol.box.minZ;
    if (lx < 0 || lz < 0 || lx >= vol.width || lz >= vol.depth) return null;
    const base = (lx * vol.depth + lz) * vol.height;
    for (let y = vol.height - 1; y >= 0; y--) {
      const c = vol.classes[base + y];
      if (c === 0 || c === 10 || c === 14) continue; // AIR, PLANT, MISSING
      return c;
    }
    return null;
  };
  const land = (x, z) => !survey.waterAt(x, z) && !survey.missingAt(x, z) && (vol ? VC_TOP_OK.has(topClass(x, z)) : true);
  const used = [];
  const free = (x, z, rad) => used.every(([ux, uz, ur]) => Math.max(Math.abs(ux - x), Math.abs(uz - z)) > ur + rad + 2);
  /** Sites of radius `rad` on a grid: all land, no kept ice within rad + KEEP_GAP, ground range at most `relief`; flattest first. */
  const sites = (rad, relief, step) => {
    const out = [];
    for (let z = claim.minZ + rad + 4; z <= claim.maxZ - rad - 4; z += step) {
      for (let x = claim.minX + rad + 4; x <= claim.maxX - rad - 4; x += step) {
        let ok = true, lo = Infinity, hi = -Infinity;
        for (let dz = -rad; dz <= rad && ok; dz += 2) for (let dx = -rad; dx <= rad; dx += 2) {
          if (!land(x + dx, z + dz)) { ok = false; break; }
          const g = survey.heightAt(x + dx, z + dz);
          lo = Math.min(lo, g); hi = Math.max(hi, g);
        }
        if (!ok || hi - lo > relief) continue;
        if (keep && keep.near(x, z, rad + KEEP_GAP)) continue;
        out.push({ x, z, range: hi - lo, y: survey.heightAt(x, z) });
      }
    }
    out.sort((a, b) => a.range - b.range || a.z - b.z || a.x - b.x);
    return out;
  };
  const presetsSpire = ['pinnacle', 'tower', 'hoodoo'];
  const presetsIce = ['classic', 'needles', 'stubby'];
  const spires = [], spikes = [];
  for (const s of sites(SPIRE_R, 6, 8)) {
    if (spires.length >= P.spires) break;
    if (!free(s.x, s.z, SPIRE_R)) continue;
    used.push([s.x, s.z, SPIRE_R]);
    spires.push(s);
  }
  for (const s of sites(SPIKE_R, 4, 6)) {
    if (spikes.length >= P.spikes) break;
    if (!free(s.x, s.z, SPIKE_R)) continue;
    used.push([s.x, s.z, SPIKE_R]);
    spikes.push(s);
  }
  if (spires.length < P.spires || spikes.length < P.spikes) r.note(`forms_demo: placed ${spires.length}/${P.spires} spires and ${spikes.length}/${P.spikes} ice clusters (not enough land clear of kept ice)`);
  const forms = [];
  spires.forEach((s, i) => {
    const g = r.rockSpire(`spire_${i + 1}`, { at: [s.x, s.y, s.z], preset: presetsSpire[i % 3] }, { stage: 'forms', bake: P.bake && i === 0 });
    forms.push({ id: `spire_${i + 1}`, kind: 'rockSpire', at: [s.x, s.y, s.z], ops: g.ops.length, baked: P.bake && i === 0 });
  });
  const lamps = r.part('lamps', { stage: 'forms' });
  const lampCols = [];
  spikes.forEach((s, i) => {
    const g = r.iceSpike(`ice_${i + 1}`, { at: [s.x, s.y, s.z], preset: presetsIce[i % 3] }, { stage: 'forms' });
    forms.push({ id: `ice_${i + 1}`, kind: 'iceSpike', at: [s.x, s.y, s.z], ops: g.ops.length, spikes: g.spikes.length });
    if (!P.lamps) return;
    // a soul-lantern post just outside the cluster, on land, on the side facing the claim's centre
    const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
    const dx = Math.sign(cx - s.x), dz = Math.sign(cz - s.z);
    const lx = s.x + dx * (SPIKE_R - 1), lz = s.z + dz * (SPIKE_R - 1);
    if (!land(lx, lz)) return;
    const gy = survey.heightAt(lx, lz);
    lampCols.push(lx, lz, gy + 1, gy + 2, 0, lx, lz, gy + 3, gy + 3, 1);
  });
  // IF_NATURAL: the post replaces a natural snow layer or plant, never a built block
  if (lampCols.length) lamps._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: lampCols, materials: [lamps._mat('minecraft:spruce_fence', 'lamp post'), lamps._mat('minecraft:soul_lantern', 'lamp')], cond: 0, walk: false });
  // anchors: the entrance and spawn on the land nearest the claim's centre; a hub; cameras on a ring above the claim
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  let best = null;
  for (let rr = 0; rr < Math.max(W, D) / 2 && !best; rr += 2) {
    for (let dz = -rr; dz <= rr && !best; dz += 2) for (let dx = -rr; dx <= rr; dx += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rr) continue;
      const x = cx + dx, z = cz + dz;
      if (land(x, z) && free(x, z, 2) && !(keep && keep.near(x, z, 2))) { best = [x, z]; break; }
    }
  }
  const [ex, ez] = best ?? [cx, cz];
  r.anchor('entrance', [ex, ez]);
  r.anchor('spawn', [ex, ez]);
  r.anchor('hub', [cx, survey.heightAt(cx, cz) + 1, cz]);
  const camY = Math.min(claim.maxY - 1, st.maxTop + 40);
  r.anchor('cam_n', [cx, camY, claim.minZ]);
  r.anchor('cam_s', [cx, camY, claim.maxZ]);
  r.anchor('cam_e', [claim.maxX, camY, cz]);
  r.anchor('cam_w', [claim.minX, camY, cz]);
  r.anchor('cam_high', [cx, Math.min(claim.maxY - 1, st.maxTop + 80), cz + 20]);
  r.anchor('cam_ground', [ex, survey.heightAt(ex, ez) + 3, ez]);
  const info = { forms, keep: keep ? { volume: keep.volume, cells: keep.cells, columns: keep.columns.size } : null, box, lamps: lampCols.length / 10 };
  r.meta.parts.lamps = { kind: 'add' };
  r.meta.forms = info;
  if (hooks.after) hooks.after(r, info);
  return r;
}

export default function formsDemo(ctx) {
  return build(ctx);
}
