#!/usr/bin/env node
// node kit/tools/gen-colors.mjs [--client-jar <jar>] [--work <dir>]
//
// Generates kit/lib/colors.mjs (the offline renderer's colours) from the vanilla 26.3 client jar: for every block in
// kit/lib/blocks.mjs, its blockstate -> the default state's model (first variant / multipart part) -> the model's
// parent chain; the top colour is the average of the largest `up` face's texture, the side colour the largest `north`
// face's (else `particle`). Averages are alpha-weighted over the first animation frame; faces with a `tintindex`
// get vanilla's default biome tint (grass, foliage, water). Blocks drawn by a block entity renderer (chests, beds,
// signs, banners, skulls) use their `particle` texture. Anything else falls back to name keywords in the renderer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findJar, openZip, parseArgs, workDir } from './mcjar.mjs';
import { decodePng } from '../lib/png.mjs';
import { BLOCKS } from '../lib/blocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../lib/colors.mjs');
const A = 'assets/minecraft/';

// default tints (plains biome / vanilla constants) for faces with a tintindex
const GRASS = [0x91, 0xbd, 0x59];
const FOLIAGE = [0x77, 0xab, 0x2f];
const TINTS = [
  [/^(spruce_leaves)$/, [0x61, 0x99, 0x61]], [/^(birch_leaves)$/, [0x80, 0xa7, 0x55]], [/^mangrove_leaves$/, [0x92, 0xc6, 0x48]],
  [/water|bubble_column/, [0x3f, 0x76, 0xe4]], [/^lily_pad$/, [0x20, 0x80, 0x30]], [/^redstone_wire$/, [0x4b, 0x00, 0x00]],
  [/stem$/, [0xe0, 0xc7, 0x1c]], [/leaves|vine|leaf_litter/, FOLIAGE],
  [/grass|fern|sugar_cane|bush|petals|wildflowers/, GRASS],
];
const tintFor = (name) => (TINTS.find(([re]) => re.test(name))?.[1] ?? GRASS);

const ref = (s) => s.replace(/^minecraft:/, '');

function main0() {
  return parseArgs(process.argv.slice(2));
}

export async function generate(o = {}) {
  const work = workDir(o.work);
  const jar = await findJar('client', o['client-jar'], work);
  console.error(`textures: ${jar}`);
  const zip = openZip(jar);
  const json = (p) => { const b = zip.read(p); return b ? JSON.parse(b.toString('utf8')) : null; };
  const modelCache = new Map();

  /** Resolve a model with its parent chain: { textures, elements }. */
  function model(name) {
    const key = ref(name);
    if (modelCache.has(key)) return modelCache.get(key);
    const m = json(`${A}models/${key}.json`);
    let out = { textures: {}, elements: null };
    if (m) {
      if (m.parent && !m.parent.startsWith('builtin/')) out = { ...model(m.parent) };
      out = { textures: { ...out.textures, ...(m.textures ?? {}) }, elements: m.elements ?? out.elements };
    }
    modelCache.set(key, out);
    return out;
  }
  const resolveTex = (textures, t) => {
    const str = (q) => (q && typeof q === 'object' ? q.sprite : q);
    let v = str(t);
    for (let i = 0; i < 10 && v && v.startsWith('#'); i++) v = str(textures[v.slice(1)]);
    return v && !v.startsWith('#') ? ref(v) : null;
  };

  const texCache = new Map();
  /** Average colour [r,g,b] and mean alpha of a texture's first frame. */
  function texAvg(tex) {
    if (texCache.has(tex)) return texCache.get(tex);
    let res = null;
    const buf = zip.read(`${A}textures/${tex}.png`);
    if (buf) {
      const img = decodePng(buf);
      const h = Math.min(img.height, img.width); // animated strips: first frame
      let r = 0; let g = 0; let b = 0; let wsum = 0; let asum = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const a = img.data[i + 3] / 255;
        r += img.data[i] * a; g += img.data[i + 1] * a; b += img.data[i + 2] * a; wsum += a; asum += a;
      }
      const n = img.width * h;
      res = wsum > 0 ? { c: [r / wsum, g / wsum, b / wsum], a: asum / n } : null;
    }
    texCache.set(tex, res);
    return res;
  }

  /** The largest face of `dir` among the elements: { tex, tint }. */
  function face(m, dir) {
    let best = null;
    let bestArea = -1;
    for (const e of m.elements ?? []) {
      const f = e.faces?.[dir];
      if (!f) continue;
      const [x0, y0, z0] = e.from;
      const [x1, y1, z1] = e.to;
      const area = dir === 'up' || dir === 'down' ? (x1 - x0) * (z1 - z0) : dir === 'north' || dir === 'south' ? (x1 - x0) * (y1 - y0) : (z1 - z0) * (y1 - y0);
      if (area > bestArea) { bestArea = area; best = { tex: resolveTex(m.textures, f.texture), tint: f.tintindex !== undefined }; }
    }
    return best;
  }

  function modelOfBlock(name) {
    const bs = json(`${A}blockstates/${name}.json`);
    if (!bs) return null;
    if (bs.variants) {
      const info = BLOCKS[`minecraft:${name}`];
      const keys = Object.keys(bs.variants);
      const match = keys.find((k) => k === '' || k.split(',').every((kv) => { const [p, v] = kv.split('='); return info.defaults[p] === v; })) ?? keys[0];
      const v = bs.variants[match];
      return (Array.isArray(v) ? v[0] : v).model;
    }
    if (bs.multipart) {
      const part = bs.multipart.find((p) => !p.when) ?? bs.multipart[0];
      const a = part.apply;
      return (Array.isArray(a) ? a[0] : a).model;
    }
    return null;
  }

  const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  const out = {};
  const missing = [];
  for (const id of Object.keys(BLOCKS).sort()) {
    const name = ref(id);
    const info = BLOCKS[id];
    if (info.family === 'air') continue;
    const mname = modelOfBlock(name);
    const m = mname ? model(mname) : null;
    const pick = (dir) => {
      const f = m ? face(m, dir) : null;
      const tex = f?.tex ?? (m ? resolveTex(m.textures, '#particle') : null);
      const avg = tex ? texAvg(tex) : null;
      if (!avg) return null;
      const tint = f?.tint || (!f && /water|bubble/.test(name));
      const c = tint ? avg.c.map((v, i) => (v * tintFor(name)[i]) / 255) : avg.c;
      return { c, a: avg.a };
    };
    const top = pick('up');
    const side = pick('north') ?? pick('south') ?? pick('east') ?? top;
    const t = top ?? side;
    if (!t) { missing.push(name); continue; }
    // alpha: how see-through the block reads (glass, leaves); only meaningful for full cubes
    let alpha = info.collision === 'full' || info.family === 'liquid' ? Math.round(Math.min(t.a, side.a) * 100) / 100 : 1;
    if (info.family === 'liquid') alpha = Math.min(alpha, 0.6);
    if (alpha > 0.9) alpha = 1;
    const th = hex(t.c);
    const sh = hex(side.c);
    out[name] = th === sh && alpha === 1 ? th : alpha === 1 ? [th, sh] : [th, sh, alpha];
  }
  const lines = Object.entries(out).map(([k, v]) => `  ${/^[a-z_][a-z0-9_]*$/.test(k) ? k : `'${k}'`}: ${JSON.stringify(v).replace(/"/g, "'")},`);
  const src = `// GENERATED by kit/tools/gen-colors.mjs from the vanilla 26.3 client jar's textures. Do not edit.
// Block (bare id) -> colour for the offline renderer: '#hex' (all faces), [top, side] or [top, side, alpha]
// (alpha < 1: glass, leaves, water). Average of the face textures (first animation frame, alpha-weighted), with the
// default biome tint on tinted faces. ${missing.length} blocks have no simple texture and use name keywords instead:
// ${missing.join(', ') || 'none'}.
export const COLORS = {
${lines.join('\n')}
};
`;
  fs.writeFileSync(OUT, src);
  console.error(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(out).length} blocks, ${missing.length} without a texture`);
  return { out, missing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate(main0());
