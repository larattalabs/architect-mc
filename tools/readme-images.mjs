#!/usr/bin/env node
// README images: converts the raw DevBridge screenshots (artifacts/readme/raw/*.png, gitignored) into the JPGs the README
// uses (docs/img/readme/*.jpg): resized, metadata stripped, quality 85. Needs ImageMagick (`magick`).
//
//   node tools/readme-images.mjs            convert every image in the table below, then print sizes and the total
//   node tools/readme-images.mjs --check    only check that every <img src> in README.md exists (exit 1 if not)
//
// The shots themselves are taken in a dev client started with tools/run-readme-client.sh (never a real world); the camera
// positions and steps are in tools/scenes/readme.json.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = path.join(repo, 'artifacts', 'readme', 'raw');
const out = path.join(repo, 'docs', 'img', 'readme');

// [output jpg, raw png, width, crop? (WxH+X+Y in raw pixels, before the resize)]
export const IMAGES = [
  ['hero.jpg', 'hero_p3.png', 1600], // retaken: the Log Cabin was hidden in hero5
  ['design-form.jpg', 'design_form.png', 1280],
  ['plot.jpg', 'plot1.png', 1280],
  ['ghost.jpg', 'ghost_slope1.png', 1280],
  ['placed.jpg', 'ext1.png', 1280],
  ['interior.jpg', 'int1.png', 1280],
  ['library.jpg', 'library3.png', 1280, '1280x796+320+140'], // retaken at GUI scale 2: three whole card rows; the panel only
  ['variants.jpg', 'variants.png', 1280],
  ['palettes.jpg', 'palettes3.png', 1600],
  ['remove-before.jpg', 'remove_before2.png', 1280],
  ['remove-after.jpg', 'remove_after2.png', 1280],
  ['designs.jpg', 'designs_progress_stub.png', 1280],
  ['status.jpg', 'status_helper.png', 935, '935x550+960+155'], // the Claude access column; the left one lists local paths
  // phase 3, survival (tools/readme-survival.mjs, a survival world)
  ['site-building.jpg', 'site_mid.png', 1280],
  ['site-before.jpg', 'site_before.png', 1280],
  ['site-after.jpg', 'site_after.png', 1280],
  ['hoppers.jpg', 'hoppers.png', 1280],
  ['crate.jpg', 'crate.png', 1150, '1150x905+385+84'], // the crate screen only
  ['library-survival.jpg', 'library_bom.png', 750, '750x790+1132+148'], // the Library's detail panel only
];

function check() {
  const md = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const srcs = [...md.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  const missing = srcs.filter((s) => !fs.existsSync(path.join(repo, s)));
  for (const s of srcs) console.log(`${missing.includes(s) ? 'MISSING' : 'ok     '} ${s}`);
  console.log(`${srcs.length} images, ${missing.length} missing`);
  return missing.length === 0;
}

if (process.argv.includes('--check')) process.exit(check() ? 0 : 1);

fs.mkdirSync(out, { recursive: true });
let total = 0;
for (const [jpg, png, width, crop] of IMAGES) {
  const src = path.join(raw, png);
  if (!fs.existsSync(src)) {
    console.log(`skip    ${jpg} (no ${png})`);
    continue;
  }
  const dst = path.join(out, jpg);
  execFileSync('magick', [src, ...(crop ? ['-crop', crop, '+repage'] : []), '-resize', `${width}x`, '-strip', '-quality', '85', dst]);
  const kb = fs.statSync(dst).size / 1024;
  total += kb;
  console.log(`${kb > 400 ? 'BIG    ' : 'ok     '} ${jpg} ${kb.toFixed(0)} KB`);
}
console.log(`total ${(total / 1024).toFixed(2)} MB`);
