// Test fixture: `node kit/render.mjs <file.nbt> --out <dir> [--views a,b] [--width N]` writes tiny PNG files
// (a real 1x1 PNG, so jobs can send them as images). Default views: iso, top, front.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const nbt = args[0];
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const out = opt('--out');
if (!nbt || !out || !fs.existsSync(nbt)) {
  console.error('usage: node kit/render.mjs <file.nbt> --out <dir> [--views a,b] [--width N]');
  process.exit(2);
}
const views = opt('--views') ? opt('--views').split(',') : ['iso', 'top', 'front'];
for (const v of views) if (!['iso', 'iso_back', 'front', 'top', 'cutaway'].includes(v)) { console.error(`unknown view ${v}`); process.exit(2); }
const id = path.basename(nbt, '.nbt');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
fs.mkdirSync(out, { recursive: true });
for (const v of views) fs.writeFileSync(path.join(out, `${id}.preview-${v}.png`), Buffer.concat([PNG, Buffer.from(`png ${v} ${id}`)]));
