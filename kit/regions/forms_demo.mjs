// forms_demo (docs/CONTRACT.md 6c F1 §7): the forms I fixture, not a catalogue program. On S2's pinned claim (or its flat
// variant) it grows up to 6 `iceSpike` clusters and 3 `rockSpire`s on land among the claim's natural ice, keeps that ice
// (`keepNatural('ICE')`: the frozen sea and the natural spikes are never written: a form whose cells meet a kept cell, or come
// within 1 of one, is not placed there), and lights each ice cluster with the bible's lamp fixture (light and rail roles, lampFixture). The first spire is baked to a `voxels` op (`bake`, default on) so the gate sees a baked form realised.
// Two-plan flow: the first plan asks for the claim's volume; the second reads it. Deterministic: candidate sites are a sorted
// scan of a grid, each form grown at plan time and tested cell by cell; no Math.random.
import { region } from '../lib/region/program.mjs';
import { fixtureCells } from '../lib/region/fixtures.mjs';
import { lampFixture } from '../lib/region/props.mjs';
import { fnv64 } from '../lib/noise.mjs';
import { iceSpike } from '../lib/forms/iceSpike.mjs';
import { rockSpire } from '../lib/forms/rockSpire.mjs';
import { formCells } from '../lib/forms/rules.mjs';

export const id = 'forms_demo';
export const catalogue = false;
export const params = {
  spikes: { type: 'int', min: 0, max: 12, default: 6, label: 'Ice-spike clusters' },
  spires: { type: 'int', min: 0, max: 6, default: 3, label: 'Rock spires' },
  bake: { type: 'bool', default: true, label: 'Bake the first spire' },
  lamps: { type: 'bool', default: true, label: 'Lamp posts' },
};

const AIR = 'minecraft:air';
const SPIRES = [
  { preset: 'pinnacle', radius: [4, 5], ledge: [3, 4] },
  { preset: 'hoodoo' },
  { preset: 'tower', radius: [4, 6], ledge: [3, 4] },
];
const SPIKES = ['classic', 'needles', 'stubby'];
/** Tries per form before giving it up (each try grows the form and tests its cells). */
const TRIES = { rockSpire: 80, iceSpike: 200 };

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
  // land: not water in the survey; with the volume, the column's top solid cell is rock, soil, loose or snow (not ice or water)
  const TOP_OK = new Set([1, 2, 3, 5]); // ROCK, SOIL, LOOSE, SNOW (lib/region/volume.mjs VOXEL_CLASSES)
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
  const inClaim = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  const land = (x, z) => inClaim(x, z) && !survey.waterAt(x, z) && !survey.missingAt(x, z) && (vol ? TOP_OK.has(topClass(x, z)) : true);
  // candidate sites: a land core of radius `core` with a ground range of at most `relief`; flattest first, then north-west first
  const sites = (core, relief, margin) => {
    const out = [];
    for (let z = claim.minZ + margin; z <= claim.maxZ - margin; z += 2) {
      for (let x = claim.minX + margin; x <= claim.maxX - margin; x += 2) {
        let ok = true, lo = Infinity, hi = -Infinity;
        for (let dz = -core; dz <= core && ok; dz++) for (let dx = -core; dx <= core; dx++) {
          if (!land(x + dx, z + dz)) { ok = false; break; }
          const g = survey.heightAt(x + dx, z + dz);
          lo = Math.min(lo, g); hi = Math.max(hi, g);
        }
        if (ok && hi - lo <= relief) out.push({ x, z, range: hi - lo, y: survey.heightAt(x, z) });
      }
    }
    out.sort((a, b) => a.range - b.range || a.z - b.z || a.x - b.x);
    return out;
  };
  // the cells taken so far (forms and lamps), and the test: inside the claim, off every kept cell and its 1-neighbourhood, and
  // 2 cells clear of every placed form's column
  const takenCols = new Set();
  const keptNear = (x, y, z) => !!keep && keep.has(x, y, z);
  const fits = (gen) => {
    const { cells } = formCells(gen.ops);
    const cols = new Set();
    for (const [k, s] of cells) {
      if (s === AIR) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (!inClaim(x, z) || keptNear(x, y, z)) return null;
      cols.add(`${x},${z}`);
    }
    for (const k of cols) {
      const [x, z] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (takenCols.has(`${x + dx},${z + dz}`)) return null;
    }
    return cols;
  };
  const groundAt = (x, z) => survey.heightAt(x, z);
  const forms = [];
  const clearOf = { rockSpire: 3, iceSpike: 2 };
  const place = (kind, idx, cands, grow) => {
    let tries = 0;
    for (const s of cands) {
      if (tries >= TRIES[kind]) break;
      // a quick pre-test: no kept column and no taken column within `clear` of the site
      if ((keep && keep.near(s.x, s.z, clearOf[kind])) || [...Array(2 * clearOf[kind] + 1).keys()].some((a) => [...Array(2 * clearOf[kind] + 1).keys()].some((b) => takenCols.has(`${s.x + a - clearOf[kind]},${s.z + b - clearOf[kind]}`)))) continue;
      const fid = `${kind === 'rockSpire' ? 'spire' : 'ice'}_${idx + 1}`;
      tries++;
      const gen = grow(fid, s);
      const cols = fits(gen);
      if (!cols) continue;
      for (const k of cols) takenCols.add(k);
      return { fid, gen, site: s };
    }
    return null;
  };
  const spireSites = sites(3, 5, 12), spikeSites = sites(1, 4, 8);
  let nSpires = 0, nSpikes = 0;
  for (let i = 0; i < P.spires; i++) {
    const spec = SPIRES[i % SPIRES.length];
    const got = place('rockSpire', nSpires, spireSites, (fid, s) => rockSpire({ ...spec, at: [s.x, s.y, s.z], seed: fnv64(ctx.seed, 'rockSpire', fid).hex }, { groundAt }));
    if (!got) continue;
    const bake = P.bake && nSpires === 0;
    r.form(got.fid, got.gen, { stage: 'forms', bake });
    forms.push({ id: got.fid, kind: 'rockSpire', preset: spec.preset, at: [got.site.x, got.site.y, got.site.z], ops: got.gen.ops.length, baked: bake, supports: got.gen.supports, trimmed: got.gen.trimmed });
    nSpires++;
  }
  const lamps = r.part('lamps', { stage: 'forms' });
  const lampCols = [];
  const lampFx = lampFixture(r), lampStates = [];
  const lampMat = (st) => { let i = lampStates.indexOf(st); if (i < 0) i = lampStates.push(st) - 1; return i; };
  for (let i = 0; i < P.spikes; i++) {
    const preset = SPIKES[i % SPIKES.length];
    const got = place('iceSpike', nSpikes, spikeSites, (fid, s) => iceSpike({ preset, at: [s.x, s.y, s.z], seed: fnv64(ctx.seed, 'iceSpike', fid).hex }, { groundAt }));
    if (!got) continue;
    r.form(got.fid, got.gen, { stage: 'forms' });
    nSpikes++;
    const f = { id: got.fid, kind: 'iceSpike', preset, at: [got.site.x, got.site.y, got.site.z], ops: got.gen.ops.length, spikes: got.gen.spikes.length, lamp: null };
    forms.push(f);
    if (!P.lamps) continue;
    // a lamp post on land 2 to 4 cells off the cluster's footprint, on the side nearest the claim's centre first
    const b = got.gen.bounds;
    const cands = [];
    for (let d = 2; d <= 4; d++) cands.push([b.maxX + d, got.site.z], [b.minX - d, got.site.z], [got.site.x, b.maxZ + d], [got.site.x, b.minZ - d]);
    for (const [lx, lz] of cands) {
      if (!land(lx, lz) || takenCols.has(`${lx},${lz}`)) continue;
      const gy = survey.heightAt(lx, lz);
      if ([1, 2, 3].some((dy) => keptNear(lx, gy + dy, lz))) continue;
      // (theme rest) the bible's lamp fixture (light and rail roles: lampFixture), whatever its kind
      const fc = fixtureCells(lampFx, [lx, gy + 1, lz]);
      if (fc.foot.some(([fx, fz]) => (fx !== lx || fz !== lz) && (!land(fx, fz) || takenCols.has(`${fx},${fz}`)))) continue;
      for (const [cx2, cy2, cz2, st] of fc.cells) lampCols.push(cx2, cz2, cy2, cy2, lampMat(st));
      for (const [fx, fz] of fc.foot) takenCols.add(`${fx},${fz}`);
      f.lamp = fc.lightAt;
      break;
    }
  }
  if (nSpires < P.spires || nSpikes < P.spikes) r.note(`forms_demo: placed ${nSpires}/${P.spires} spires and ${nSpikes}/${P.spikes} ice clusters (not enough land clear of kept ice)`);
  // IF_NATURAL: the post replaces a natural snow layer or plant, never a built block
  if (lampCols.length) lamps._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: lampCols, materials: lampStates.map((st) => lamps._mat(st, 'lamp')), cond: 0, walk: false });
  // anchors: the entrance and spawn on the land nearest the claim's centre; a hub; cameras on a ring above the claim
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  let best = null;
  for (let rr = 0; rr < Math.max(W, D) / 2 && !best; rr += 2) {
    for (let dz = -rr; dz <= rr && !best; dz += 2) for (let dx = -rr; dx <= rr; dx += 2) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rr) continue;
      const x = cx + dx, z = cz + dz;
      if (land(x, z) && !takenCols.has(`${x},${z}`) && !(keep && keep.near(x, z, 2))) { best = [x, z]; break; }
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
