#!/usr/bin/env node
// node tools/sheet-inline.mjs <sheet.html> [--out <file>] [--max-png <bytes>] [--quality <1-100>]
// Rewrites a review sheet as one self-contained HTML file: local <img src> files inlined as data: URIs, large PNGs as JPEG
// (tools/lib/sheet-inline.mjs; docs/GATES.md "Review sheets"). Without --out it writes <name>.inline.html beside the input.
import path from 'node:path';
import fs from 'node:fs';
import { inlineImages } from './lib/sheet-inline.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const outArg = flag('--out');
const maxPngBytes = Number(flag('--max-png') ?? 300_000);
const jpegQuality = Number(flag('--quality') ?? 80);
const input = args[0];
if (!input) { console.error('usage: node tools/sheet-inline.mjs <sheet.html> [--out <file>] [--max-png <bytes>] [--quality <n>]'); process.exit(2); }
const out = outArg ?? input.replace(/\.html?$/i, '') + '.inline.html';
const r = inlineImages(fs.readFileSync(input, 'utf8'), path.dirname(path.resolve(input)), { maxPngBytes, jpegQuality });
fs.writeFileSync(out, r.html);
console.log(`${out}: ${r.inlined} image(s) inlined, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB${r.missing.length ? `; MISSING: ${r.missing.join(', ')}` : ''}`);
if (r.missing.length) process.exit(1);
