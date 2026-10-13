// The bundled scatter items (docs/CONTRACT.md 6c F2 §3; SETTLEMENTS §9.3): plan-time generators that turn a bundled item name and
// its params into the scatter op's IR items (blocks, ground-following patches, or small bodies as ARVB side blobs). Deterministic
// in the plan seed and the op's label: a few seeded variants per item, picked per placement by the op's weights.
//
//   boulder       a warped ellipsoid up to radius 3, sunk 1 into the ground, in a seeded rock mix (stone, andesite, cobblestone,
//                 mossy cobblestone), 4 variants
//   stump         a log 1 or 2 tall (the `log` param), 2 variants
//   shrub         a bush on its soil (`block` param, default minecraft:bush)
//   fern_patch    ferns and a large fern around the point, each on its own column's soil, 3 variants
//   moss_carpet   a patch of moss carpet on any solid natural ground, 3 variants
//   snow_layer    a patch of 1-2 snow layers, only where no planned light melts it (M17: the op's `lit` field), 3 variants
//   glow_lichen   on cave walls and ceilings (two items: a wall and a ceiling anchor; the op needs its y range and a frozen volume)
//   path_lantern  W's lamp post (fixtures.mjs: the bible's light on a post of its rail), placed by distance to path cells; it clears
//                 the natural snow layers its light would melt and never stands where ice is within its reach (M17)
//
// Every item is supported (a body's root column rests on its anchor; a patch's cells each stand on their own column), never on a
// walk cell, in a lot box or keep-out (the op's exclusions), and its reach is at most 4 (SCATTER_MAX_RADIUS).
import { fnv64, makeNoise, mix64, hash3 } from '../noise.mjs';
import { encodeVoxels } from './voxels.mjs';
import { fixtureCells, fixtureFor } from './fixtures.mjs';

export const BUNDLED_ITEMS = Object.freeze(['boulder', 'stump', 'shrub', 'fern_patch', 'moss_carpet', 'snow_layer', 'glow_lichen', 'path_lantern']);
const PLANT_ON = ['SOIL'];
const SNOW_ON = ['SOIL', 'ROCK', 'LOOSE', 'SNOW']; // vanilla: a snow layer doesn't survive on ice or packed ice

/** A seeded 32-bit draw for (seed, label, i, j). */
function draw(key, i, j = 0, k = 0) { return hash3(key[0], key[1], i, j, k); }
const keyOf = (seed, ...label) => { const h = fnv64(String(seed), 'scatterItem', ...label); return mix64(h.hi, h.lo); };

/** Cells [[x, y, z, state]] with the root at (0, 0, 0) -> {bytes (ARVB), root} (local box shifted to 0). */
function body(cells) {
  let mx = Infinity, my = Infinity, mz = Infinity, Mx = -Infinity, My = -Infinity, Mz = -Infinity;
  for (const [x, y, z] of cells) { mx = Math.min(mx, x); my = Math.min(my, y); mz = Math.min(mz, z); Mx = Math.max(Mx, x); My = Math.max(My, y); Mz = Math.max(Mz, z); }
  const bytes = encodeVoxels([Mx - mx + 1, My - my + 1, Mz - mz + 1], cells.map(([x, y, z, s]) => [x - mx, y - my, z - mz, s]));
  return { bytes, root: [-mx, -my, -mz] };
}

/**
 * A bundled item's IR items: `{items: [{w, ...IR item}], blobs: [{name, bytes}]}`. `w` is the item's weight, split over its variants;
 * `blobName(i)` names variant i's side blob; `ctx`: `{seed, label, material(role|state), fixture?}`.
 */
export function bundledItem(name, params, w, ctx) {
  const { seed, label } = ctx;
  const P = params ?? {};
  const split = (n) => { const out = []; const base = Math.max(1, Math.floor(w / n)); for (let i = 0; i < n; i++) out.push(base); return out; };
  const items = [], blobs = [];
  const addBody = (i, cells, extra = {}) => {
    const b = body(cells);
    const nm = ctx.blobName(i);
    blobs.push({ name: nm, bytes: b.bytes });
    items.push({ cells: nm, root: b.root, anchor: 'ground', ...extra });
  };
  if (name === 'boulder') {
    const n = 4, ws = split(n);
    const mix = P.mix ?? [[6, 'minecraft:stone'], [3, 'minecraft:andesite'], [2, 'minecraft:cobblestone'], [1, 'minecraft:mossy_cobblestone']];
    const tot = mix.reduce((a, m) => a + m[0], 0);
    const maxR = Math.min(3, P.maxRadius ?? 3);
    for (let v = 0; v < n; v++) {
      const k = keyOf(seed, label, 'boulder', v);
      const rx = 1.5 + (draw(k, 1) / 4294967296) * (maxR - 1.5), rz = 1.5 + (draw(k, 2) / 4294967296) * (maxR - 1.5), ry = 1 + (draw(k, 3) / 4294967296) * 1.2;
      const noise = makeNoise({ kind: 'value', dims: 3, scale: 2, octaves: 1, seed: fnv64(String(seed), label, 'boulderWarp', v).hex });
      const cells = [];
      const R = Math.ceil(maxR);
      for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) for (let y = -1; y <= 3; y++) {
        const yy = y + 0.5; // sunk: the centre sits half a cell over the ground's top
        const d = (x / rx) * (x / rx) + (yy / ry) * (yy / ry) + (z / rz) * (z / rz);
        if (d * (1 + 0.3 * noise(x, y, z)) > 1 && !(x === 0 && z === 0 && y <= 0)) continue;
        const h = Math.floor((draw(k, 10 + x, 20 + y, 30 + z) * tot) / 4294967296);
        let acc = 0, st = mix[0][1];
        for (const [mw, ms] of mix) { acc += mw; if (h < acc) { st = ms; break; } }
        cells.push([x, y, z, ctx.material(st)]);
      }
      addBody(v, cells, { w: ws[v] });
    }
  } else if (name === 'stump') {
    const log = ctx.material(P.log ?? 'minecraft:spruce_log');
    const st = log.includes('[') ? log : `${log}[axis=y]`;
    for (let v = 0; v < 2; v++) addBody(v, Array.from({ length: v + 1 }, (_, y) => [0, y, 0, st]), { w: split(2)[v] });
  } else if (name === 'shrub') {
    items.push({ w, block: ctx.material(P.block ?? 'minecraft:bush'), anchor: 'ground', on: PLANT_ON });
  } else if (name === 'fern_patch' || name === 'moss_carpet' || name === 'snow_layer') {
    const n = 3, ws = split(n);
    for (let v = 0; v < n; v++) {
      const k = keyOf(seed, label, name, v);
      const patch = [];
      const r = name === 'fern_patch' ? 2 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        const hh = draw(k, dx + 8, dz + 8);
        const centre = dx === 0 && dz === 0;
        const share = name === 'moss_carpet' ? 0.7 : name === 'snow_layer' ? 0.75 : 0.35;
        if (!centre && hh / 4294967296 > share * (1 - (Math.abs(dx) + Math.abs(dz)) / 6)) continue;
        if (name === 'fern_patch') {
          if (!centre && (hh & 7) === 0) patch.push([dx, dz, 'minecraft:large_fern[half=lower]', 'minecraft:large_fern[half=upper]']);
          else patch.push([dx, dz, 'minecraft:fern']);
        } else if (name === 'moss_carpet') patch.push([dx, dz, 'minecraft:moss_carpet']);
        else patch.push([dx, dz, `minecraft:snow[layers=${centre || (hh & 3) === 0 ? 2 : 1}]`]);
      }
      items.push({ w: ws[v], patch, anchor: 'ground', ...(name === 'fern_patch' ? { on: PLANT_ON } : name === 'snow_layer' ? { on: SNOW_ON, melts: true } : {}) });
    }
  } else if (name === 'glow_lichen') {
    const f = (face) => `minecraft:glow_lichen[${face}=true]`;
    const half = Math.max(1, Math.floor(w / 2));
    items.push({ w: half, block: { north: f('north'), east: f('east'), south: f('south'), west: f('west') }, anchor: 'wall' });
    items.push({ w: half, block: { up: f('up') }, anchor: 'ceiling' });
  } else if (name === 'path_lantern') {
    const fx = ctx.fixture ?? fixtureFor(ctx.material(P.light ?? 'light'), ctx.material(P.rail ?? 'rail'));
    if (fx.kind === 'hanging_lantern') throw new Error('path_lantern: a hanging lantern is wider than one column (use a post fixture)');
    const { cells, lightAt } = fixtureCells(fx, [0, 0, 0]);
    addBody(0, cells, { w, light: [lightAt[0], lightAt[1], lightAt[2], fx.level] });
  } else throw new Error(`scatter: '${name}' is not a bundled item (${BUNDLED_ITEMS.join(', ')})`);
  return { items, blobs };
}
