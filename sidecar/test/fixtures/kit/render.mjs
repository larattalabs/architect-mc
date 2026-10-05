// Test fixture: `node kit/render.mjs <file.nbt> --out <dir>` writes three tiny "PNGs".
import fs from 'node:fs';
import path from 'node:path';

const [nbt, flag, out] = process.argv.slice(2);
if (!nbt || flag !== '--out' || !out || !fs.existsSync(nbt)) {
  console.error('usage: node kit/render.mjs <file.nbt> --out <dir>');
  process.exit(2);
}
const id = path.basename(nbt, '.nbt');
fs.mkdirSync(out, { recursive: true });
for (const v of ['iso', 'top', 'front']) fs.writeFileSync(path.join(out, `${id}.preview-${v}.png`), `png ${v} ${id}`);
