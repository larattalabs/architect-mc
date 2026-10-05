#!/usr/bin/env node
// node kit/render.mjs <file.nbt> [--out <dir>] [--sidecar <path>] [--cutaway] [--width N] [--transparent]
// Renders a vanilla structure template to PNG previews without the game:
//   <id>.preview-iso.png      isometric, from the front-left (the entrance side visible)
//   <id>.preview-top.png      top-down
//   <id>.preview-front.png    front elevation
//   <id>.preview-cutaway.png  (--cutaway) the iso view without the rows above the interior and the two near walls
// The sidecar (<id>.blueprint.json next to the .nbt, or --sidecar) supplies `front` and `interior`; without one the
// front is south. --out defaults to the .nbt's directory. Exit code 0 = written, 1 = render failed, 2 = bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, plain } from './lib/nbt.mjs';
import { encodePng } from './lib/png.mjs';
import { buildScene, renderIso, renderTop, renderFront } from './lib/render.mjs';

const USAGE = 'usage: node kit/render.mjs <file.nbt> [--out <dir>] [--sidecar <path>] [--cutaway] [--width N] [--transparent]';

/**
 * Render every view of one structure.
 * @returns {{id:string, files:Record<string,string>, ms:number, blocks:number, unknown:string[]}}
 */
export function renderStructure(nbtPath, { out, sidecar: sidecarPath, cutaway = false, width, bg } = {}) {
  const t0 = performance.now();
  if (!fs.existsSync(nbtPath)) throw new Error(`no such file: ${nbtPath}`);
  const id = path.basename(nbtPath, '.nbt');
  const sp = sidecarPath ?? path.join(path.dirname(nbtPath), `${id}.blueprint.json`);
  const sidecar = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
  const structure = plain(parse(fs.readFileSync(nbtPath)));
  const unknown = new Set();
  const scene = buildScene(structure, { front: sidecar?.front ?? 'south', unknown });
  const dir = out ?? path.dirname(nbtPath);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  const write = (k, img) => {
    const p = path.join(dir, `${id}.preview-${k}.png`);
    fs.writeFileSync(p, encodePng(img.width, img.height, img.data));
    files[k] = p;
  };
  write('iso', renderIso(scene, { width, bg }));
  write('top', renderTop(scene, { bg }));
  write('front', renderFront(scene, { bg }));
  if (cutaway) {
    const w = sidecar?.interior;
    const maxY = w ? w.maxY : Math.ceil(structure.size[1] / 2);
    write('cutaway', renderIso(scene, { width, bg, maxY, hide: nearWallHider(scene, w) }));
  }
  return { id, files, ms: performance.now() - t0, blocks: structure.blocks.length, unknown: [...unknown].sort() };
}

/** Cutaway helper: lowers the two walls nearest the camera (south = front, west = left) to sill height. */
export function nearWallHider(scene, w) {
  if (!w) return undefined;
  const [ax, az] = scene.rot(w.minX, w.minZ);
  const [bx, bz] = scene.rot(w.maxX, w.maxZ);
  const x0 = Math.min(ax, bx); const x1 = Math.max(ax, bx); const z0 = Math.min(az, bz); const z1 = Math.max(az, bz);
  const sill = w.minY + 1;
  return (x, y, z) => y >= sill && ((z > z1 && z <= z1 + 3 && x >= x0 - 3 && x <= x1 + 3) || (x < x0 && x >= x0 - 3 && z >= z0 - 3 && z <= z1 + 3));
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = path.resolve(val());
    else if (a === '--sidecar') o.sidecar = path.resolve(val());
    else if (a === '--cutaway') o.cutaway = true;
    else if (a === '--width') o.width = Number(val());
    else if (a === '--transparent') o.bg = 'transparent';
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  if (o._.length !== 1) throw new Error('one .nbt file');
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  try {
    const r = renderStructure(path.resolve(o._[0]), o);
    console.log(`${r.id}: ${r.blocks} blocks, ${r.ms.toFixed(0)} ms`);
    for (const f of Object.values(r.files)) console.log(`  ${path.relative(process.cwd(), f)}`);
    if (r.unknown.length) console.log(`  colour guessed from the name for: ${r.unknown.join(', ')}`);
  } catch (e) {
    console.error(`${o._[0]}: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
