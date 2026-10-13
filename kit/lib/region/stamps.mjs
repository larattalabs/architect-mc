// Stamps (docs/CONTRACT.md 6c F2 §4, SETTLEMENTS §9.4; kit/REGIONS.md "Kit 0.22.0"): a vanilla feature's cells, captured once per
// Minecraft version by the harvester (DevBridge `dev.feature.stamp`, tools/harvest-stamps.mjs) in the player's own game. Plan time
// only (not under the realise lint: a plan embeds the stamp's ARVB as a side blob, which the evaluator reads).
//
// **Local-only (Noah, N-F2-1):** the library is `<game>/architect/stamps/<feature>/<seed>.bin`, never in the repo or the jar. The
// helper passes its dir to the plan CLI (`--stamps <dir>`); kit tests build synthetic stamps at test time (`syntheticStamp`).
//
// A stamp file is gzip (pinned header) of ARSP bytes:
//   'ARSP' u8 version=1 u8 0 0 0
//   varint len + UTF-8 x 4: the feature id ('minecraft:oak'), the seed (decimal), the game version, the ground template
//   zigzag varint x 3: the root cell (the feature's origin) in the ARVB's local cells
//   varint: block-entity cells left out (a bee nest...: a stamp holds block states only)
//   the ARVB bytes (lib/region/voxels.mjs) to the end
import fs from 'node:fs';
import path from 'node:path';
import { gunzip, gzipPinned } from './pack.mjs';
import { decodeVoxels, encodeVoxels } from './voxels.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
/** A stamp id: '<feature path>/<seed>' ('oak/3', 'huge_brown_mushroom/1'). */
export const STAMP_ID = /^([a-z0-9_.-]+)\/([0-9]+)$/;

/** Decode a stamp file (gzip or raw ARSP): `{feature, seed, minecraft, ground, root, blockEntities, arvb, voxels}`. */
export function decodeStamp(file, what = 'stamp') {
  let b = file instanceof Uint8Array ? file : Uint8Array.from(file);
  if (b[0] === 0x1f && b[1] === 0x8b) b = new Uint8Array(gunzip(b));
  if (b.length < 12 || b[0] !== 0x41 || b[1] !== 0x52 || b[2] !== 0x53 || b[3] !== 0x50) throw new Error(`${what}: not an ARSP stamp`);
  if (b[4] !== 1) throw new Error(`${what}: ARSP version ${b[4]} (this kit reads 1)`);
  let o = 8;
  const varint = () => {
    let v = 0, mul = 1, byte;
    do {
      if (o >= b.length) throw new Error(`${what}: truncated`);
      byte = b[o++]; v += (byte & 127) * mul; mul *= 128;
    } while (byte & 128);
    return v;
  };
  const str = () => { const n = varint(); const s = dec.decode(b.subarray(o, o + n)); o += n; return s; };
  const zz = () => { const v = varint(); return v % 2 ? -(v + 1) / 2 : v / 2; };
  const feature = str(), seed = str(), minecraft = str(), ground = str();
  const root = [zz(), zz(), zz()];
  const blockEntities = varint();
  const arvb = b.slice(o);
  const voxels = decodeVoxels(arvb, `${what} cells`);
  return { feature, seed, minecraft, ground, root, blockEntities, arvb, voxels };
}

/** Encode a stamp (the harvester's format; tests and synthetic stamps): gzip-pinned ARSP bytes. */
export function encodeStamp({ feature, seed, minecraft = 'synthetic', ground = 'grass_block', root, blockEntities = 0 }, arvb) {
  const out = [0x41, 0x52, 0x53, 0x50, 1, 0, 0, 0];
  const varint = (v) => { let n = v; do { let x = n % 128; n = Math.floor(n / 128); if (n) x += 128; out.push(x); } while (n); };
  const str = (s) => { const u = enc.encode(String(s)); varint(u.length); out.push(...u); };
  str(feature); str(seed); str(minecraft); str(ground);
  for (const v of root) varint(v < 0 ? -2 * v - 1 : 2 * v);
  varint(blockEntities);
  const raw = new Uint8Array(out.length + arvb.length);
  raw.set(out); raw.set(arvb, out.length);
  return new Uint8Array(gzipPinned(raw));
}

/**
 * A stamp library over a dir (`<dir>/<feature>/<seed>.bin`), or over an in-memory map (id -> file bytes; tests): `{dir, ids(),
 * has(id), get(id) -> decoded | null}`.
 */
export function stampLibrary(src) {
  const cache = new Map();
  const files = src instanceof Map ? src : null;
  const dir = files ? null : src;
  const fileOf = (id) => { const m = STAMP_ID.exec(id); return m && dir ? path.join(dir, m[1], `${m[2]}.bin`) : null; };
  const lib = {
    dir,
    ids() {
      if (files) return [...files.keys()].sort();
      if (!dir || !fs.existsSync(dir)) return [];
      const out = [];
      for (const f of fs.readdirSync(dir).sort()) {
        const d = path.join(dir, f);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const s of fs.readdirSync(d)) { const m = /^([0-9]+)\.bin$/.exec(s); if (m) out.push(`${f}/${m[1]}`); }
      }
      return out.sort((a, b) => { const [fa, sa] = a.split('/'), [fb, sb] = b.split('/'); return fa < fb ? -1 : fa > fb ? 1 : Number(sa) - Number(sb); });
    },
    has(id) { return files ? files.has(id) : !!fileOf(id) && fs.existsSync(fileOf(id)); },
    get(id) {
      if (!STAMP_ID.test(id)) throw new Error(`stamp id '${id}' must be '<feature>/<seed>'`);
      if (cache.has(id)) return cache.get(id);
      let bytes = null;
      if (files) bytes = files.get(id) ?? null;
      else { const f = fileOf(id); if (f && fs.existsSync(f)) bytes = fs.readFileSync(f); }
      const v = bytes ? decodeStamp(bytes, `stamp ${id}`) : null;
      cache.set(id, v);
      return v;
    },
  };
  return lib;
}

/**
 * A synthetic stamp for tests (not vanilla data): `tree` (a log trunk of 4-6 on a dirt cell, a leaf blob), `mushroom` (a stem and a
 * flat cap) or `cluster` (a floor and a ceiling part, like a cave feature). Deterministic in `seed` (an integer).
 */
export function syntheticStamp(kind, seed = 1) {
  const cells = [];
  let root;
  if (kind === 'tree') {
    const h = 4 + (seed % 3);
    // local x/z 0..4, the trunk at (2, 2); y 0 is the dirt under it, the root (origin) at y 1
    cells.push([2, 0, 2, 'minecraft:dirt']);
    for (let y = 1; y <= h; y++) cells.push([2, y, 2, 'minecraft:oak_log[axis=y]']);
    for (let y = h - 1; y <= h + 1; y++) for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
      if (x === 2 && z === 2 && y <= h) continue;
      const r = y === h + 1 ? 1 : 2;
      if (Math.abs(x - 2) > r || Math.abs(z - 2) > r || (Math.abs(x - 2) === 2 && Math.abs(z - 2) === 2 && (seed + x + z) % 2)) continue;
      cells.push([x, y, z, 'minecraft:oak_leaves[distance=1,persistent=false,waterlogged=false]']);
    }
    root = [2, 1, 2];
  } else if (kind === 'mushroom') {
    const h = 4 + (seed % 2);
    for (let y = 0; y < h; y++) cells.push([2, y, 2, 'minecraft:mushroom_stem[down=true,east=true,north=true,south=true,up=false,west=true]']);
    for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) cells.push([x, h, z, 'minecraft:brown_mushroom_block[down=false,east=true,north=true,south=true,up=true,west=true]']);
    root = [2, 0, 2];
  } else if (kind === 'cluster') {
    for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { cells.push([x, 0, z, 'minecraft:dripstone_block']); cells.push([x, 8, z, 'minecraft:dripstone_block']); }
    cells.push([1, 1, 1, 'minecraft:pointed_dripstone[thickness=tip,vertical_direction=up,waterlogged=false]']);
    cells.push([1, 7, 1, 'minecraft:pointed_dripstone[thickness=tip,vertical_direction=down,waterlogged=false]']);
    root = [1, 1, 1];
  } else throw new Error(`syntheticStamp: kind ${kind}`);
  let sx = 0, sy = 0, sz = 0;
  for (const [x, y, z] of cells) { sx = Math.max(sx, x + 1); sy = Math.max(sy, y + 1); sz = Math.max(sz, z + 1); }
  const arvb = encodeVoxels([sx, sy, sz], cells);
  return encodeStamp({ feature: `synthetic:${kind}`, seed, root }, arvb);
}
