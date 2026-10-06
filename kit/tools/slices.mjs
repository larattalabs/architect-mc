#!/usr/bin/env node
// node kit/tools/slices.mjs <file.nbt> [--sidecar <json>] [--y N|A-B] [--box x0,z0,x1,z1] [--storeys] [--max-chars N]
//
// From Steward's minecraft-structure-design skill (scripts/slices.mjs), owned by Architect from phase 5a; changes are
// reported to Steward. It reads the kit's own lib directly (no --kit).
//
// Prints a structure template as layered ASCII: one block per character, one grid per y layer. North (-z) is the TOP
// of each grid, west (-x) the LEFT, so it reads like a map. Coordinates are template-local (origin = minimum corner,
// +x east, +y up, +z south), the same as the kit's design coordinates.
// Glyphs: '.' air (or nothing written); letters are assigned per block id and listed in the legend, then a listing of
// the directional blocks (stairs, doors, trapdoors, ladders, beds...) with their facing.
//   --sidecar   the blueprint JSON (default: <id>.blueprint.json next to the .nbt, if there is one)
//   --y         one layer or a range (default: every layer)
//   --box       a sub-rectangle x0,z0,x1,z1 (inclusive)
//   --storeys   only the floor row and the eye-height row (feet row + 1) of each storey, at most 6 layers. The storeys are
//               the interior's floor levels (lib/check.mjs floorLevels), or the ground row without an interior. Needs
//               the sidecar (groundY, interior)
//   --max-chars truncate the whole output to N characters, ending with a `... (truncated)` line
// Exit code 0 = printed, 2 = bad usage / unreadable file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, plain } from '../lib/nbt.mjs';
import { floorLevels, makeGrid, fmt } from '../lib/check.mjs';

const USAGE = 'usage: node kit/tools/slices.mjs <file.nbt> [--sidecar <json>] [--y N|A-B] [--box x0,z0,x1,z1] [--storeys] [--max-chars N]';
const FACING = { north: '^', south: 'v', east: '>', west: '<', up: 'u', down: 'd' };
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=@?!~';
const AIR = new Set(['air', 'cave_air', 'void_air']);
const DIRECTIONAL = /stairs|door|trapdoor|ladder|torch|sign|banner|bed|lectern|furnace|smoker|chest|barrel|anvil|grindstone|bell|button|lever/;
export const MAX_STOREY_LAYERS = 6;
export const TRUNCATED = '... (truncated)';

/** The layers --storeys prints: [{ y, label }], at most MAX_STOREY_LAYERS (storeys spread evenly when there are more). */
export function storeyLayers(structure, sidecar) {
  if (!sidecar || !Number.isInteger(sidecar.groundY)) throw new Error('--storeys needs the sidecar (groundY, interior)');
  const pal = structure.palette.map((p) => ({ name: p.id ?? p.Name, props: { ...(p.properties ?? p.Properties ?? {}) } }));
  const cells = new Map();
  for (const b of structure.blocks) cells.set(fmt(...b.pos), pal[b.state]);
  const g = makeGrid(cells, structure.size, sidecar.groundY);
  const w = sidecar.interior;
  let feet = w ? floorLevels(g, w).map((l) => l.y) : [];
  if (!feet.length) feet = [sidecar.groundY];
  const keep = Math.floor(MAX_STOREY_LAYERS / 2);
  if (feet.length > keep) feet = Array.from({ length: keep }, (_, i) => feet[Math.round((i * (feet.length - 1)) / (keep - 1))]);
  const sy = structure.size[1];
  const out = [];
  feet.forEach((y, i) => {
    if (y - 1 >= 0) out.push({ y: y - 1, label: `storey ${i + 1} floor` });
    if (y + 1 < sy) out.push({ y: y + 1, label: `storey ${i + 1} eye height` });
  });
  return out;
}

/** Truncate text to at most `n` characters, ending with a TRUNCATED line. */
export function truncateChars(text, n) {
  if (!(n > 0) || text.length <= n) return text;
  const room = n - TRUNCATED.length - 1;
  if (room <= 0) return TRUNCATED.slice(0, n);
  const cut = text.lastIndexOf('\n', room);
  return `${text.slice(0, cut > 0 ? cut : room)}\n${TRUNCATED}`;
}

/**
 * Layered ASCII of a structure.
 * @param {object} structure plain parsed NBT root ({ size, palette, blocks })
 * @param {object|null} sidecar the blueprint JSON (needed for `storeys`)
 * @param {{ name?: string, y?: [number, number], box?: [number, number, number, number], storeys?: boolean, maxChars?: number }} [opts]
 * @returns {string}
 */
export function slices(structure, sidecar, opts = {}) {
  const [sx, sy, sz] = structure.size;
  const pal = structure.palette.map((p) => ({ name: (p.id ?? p.Name).replace('minecraft:', ''), props: (p.properties ?? p.Properties ?? {}) }));
  const grid = new Map();
  for (const b of structure.blocks) grid.set(`${b.pos[0]},${b.pos[1]},${b.pos[2]}`, b.state);
  const glyphOf = new Map();
  const legend = [];
  const glyph = (i) => {
    const p = pal[i];
    if (AIR.has(p.name)) return '.';
    if (!glyphOf.has(p.name)) { glyphOf.set(p.name, GLYPHS[glyphOf.size] ?? '?'); legend.push([glyphOf.get(p.name), p.name]); }
    return glyphOf.get(p.name);
  };
  let layers;
  if (opts.storeys) layers = storeyLayers(structure, sidecar);
  else {
    const [y0, y1] = opts.y ?? [0, sy - 1];
    layers = [];
    for (let y = Math.max(0, y0); y <= Math.min(sy - 1, y1); y++) layers.push({ y, label: '' });
  }
  const [x0, z0, x1, z1] = opts.box ? [Math.max(0, opts.box[0]), Math.max(0, opts.box[1]), Math.min(sx - 1, opts.box[2]), Math.min(sz - 1, opts.box[3])] : [0, 0, sx - 1, sz - 1];
  const lines = [];
  lines.push(`# ${opts.name ?? 'structure'}  size x=${sx} y=${sy} z=${sz}${sidecar && Number.isInteger(sidecar.groundY) ? `  groundY=${sidecar.groundY}` : ''}  (north = top, west = left; y 0 is the bottom row)`);
  const hdr = `    ${Array.from({ length: x1 - x0 + 1 }, (_, i) => (x0 + i) % 10).join('')}`;
  for (const { y, label } of layers) {
    const rows = [];
    let any = false;
    for (let z = z0; z <= z1; z++) {
      let row = '';
      for (let x = x0; x <= x1; x++) {
        const st = grid.get(`${x},${y},${z}`);
        const c = st === undefined ? '.' : glyph(st);
        if (c !== '.') any = true;
        row += c;
      }
      rows.push(`${String(z).padStart(3)} ${row}`);
    }
    lines.push('', `-- y=${y}${label ? ` (${label})` : ''}${any ? '' : ' (empty)'} --`);
    if (any) lines.push(hdr, ...rows);
  }
  lines.push('', `legend: ${legend.map(([g, n]) => `${g}=${n}`).join('  ')}`);
  // directional detail for blocks whose facing matters, so a facing mistake shows without a render (within the box)
  const dirs = new Map();
  const ys = new Set(layers.map((l) => l.y));
  for (const b of structure.blocks) {
    const [x, y, z] = b.pos;
    if (x < x0 || x > x1 || z < z0 || z > z1 || !ys.has(y)) continue;
    const p = pal[b.state];
    const f = p.props.facing;
    if (!f || !DIRECTIONAL.test(p.name)) continue;
    const k = `${p.name} facing=${f}${p.props.half ? ` half=${p.props.half}` : ''}${p.props.part ? ` part=${p.props.part}` : ''}${p.props.shape && p.props.shape !== 'straight' ? ` shape=${p.props.shape}` : ''}`;
    dirs.set(k, (dirs.get(k) ?? 0) + 1);
  }
  if (dirs.size) lines.push('', `directional blocks (${Object.entries(FACING).map(([k, v]) => `${v}=${k}`).join(' ')}):`, ...[...dirs].sort().map(([k, n]) => `  ${n} x ${k}`));
  return truncateChars(lines.join('\n'), opts.maxChars);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--sidecar') o.sidecar = path.resolve(val());
    else if (a === '--y') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(val());
      if (!m) throw new Error('--y must be N or A-B');
      o.y = [Number(m[1]), m[2] ? Number(m[2]) : Number(m[1])];
    } else if (a === '--box') {
      const v = val().split(',').map(Number);
      if (v.length !== 4 || !v.every(Number.isInteger)) throw new Error('--box must be x0,z0,x1,z1');
      o.box = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    } else if (a === '--storeys') o.storeys = true;
    else if (a === '--max-chars') {
      o.maxChars = Number(val());
      if (!Number.isInteger(o.maxChars) || o.maxChars < 1) throw new Error('--max-chars must be a positive integer');
    } else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  if (!o.help && o._.length !== 1) throw new Error('one .nbt file');
  if (o.storeys && o.y) throw new Error('--storeys and --y exclude each other');
  return o;
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exitCode = 2; return; }
  if (o.help) { console.log(USAGE); return; }
  const file = path.resolve(o._[0]);
  try {
    const structure = plain(parse(fs.readFileSync(file)));
    const sp = o.sidecar ?? path.join(path.dirname(file), `${path.basename(file, '.nbt')}.blueprint.json`);
    const sidecar = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
    if (o.sidecar && !sidecar) throw new Error(`no such file: ${o.sidecar}`);
    console.log(slices(structure, sidecar, { name: path.basename(file), y: o.y, box: o.box, storeys: o.storeys, maxChars: o.maxChars }));
  } catch (e) {
    console.error(`${o._[0]}: ${e.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
