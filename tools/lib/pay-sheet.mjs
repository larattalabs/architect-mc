// (7c PAY) The blind A/B sheet for Noah (P4's plans, P5's Styles): per pair, the two arms as A and B (sides randomised), the key in its
// own file (never on the sheet). Noah's standing rule (2026-11-15): a sheet is ONE self-contained HTML file, its images inlined as data
// URIs, large PNGs as JPEG (tools/lib/sheet-inline.mjs writeSheet). `rand` returns a byte (crypto by default; a test passes its own).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeSheet } from './sheet-inline.mjs';

export function abSheet(item, out, pairs, title, intro, { rand = () => crypto.randomBytes(1)[0] } = {}) {
  const dir = path.join(out, 'ab');
  fs.mkdirSync(dir, { recursive: true });
  const key = {};
  const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = [`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>`, '<style>body{font:16px system-ui;margin:24px;max-width:1200px}.row{display:flex;gap:12px}figure{flex:1;margin:0}img{width:100%;border:1px solid #888}pre{white-space:pre-wrap;font-size:12px;border:1px solid #888;padding:8px;max-height:600px;overflow:auto}</style>', `<h1>${esc(title)}</h1><p>${esc(intro)}</p>`];
  pairs.forEach((p, i) => {
    key[p.pair] = rand() & 1 ? { A: 'off', B: 'on' } : { A: 'on', B: 'off' };
    const cell = (side) => {
      const arm = p[key[p.pair][side]];
      // several pictures per arm: the same views in the same order on both sides
      const imgs = (arm.imgs ?? (arm.img ? [arm.img] : [])).filter((f) => fs.existsSync(f));
      if (imgs.length) return `<figure>${imgs.map((f, j) => { const n = `pair-${i + 1}-${side}-${j + 1}${path.extname(f)}`; fs.copyFileSync(f, path.join(dir, n)); return `<img src="${n}">`; }).join('')}<figcaption>${side}</figcaption></figure>`;
      return `<figure><pre>${esc(arm.text)}</pre><figcaption>${side}</figcaption></figure>`;
    };
    html.push(`<h2>Pair ${i + 1}</h2><div class="row">${cell('A')}${cell('B')}</div><p>Pick: A / B</p>`);
  });
  const sheet = path.join(dir, 'sheet.html');
  const inl = writeSheet(sheet, `${html.join('\n')}\n`);
  const keyFile = path.join(out, 'ab-key.json');
  fs.writeFileSync(keyFile, `${JSON.stringify({ at: new Date().toISOString(), item, note: 'which arm each side shows (on = the references or images on; off = without). Not for Noah until his picks are recorded.', key }, null, 2)}\n`);
  return { sheet, key: keyFile, inlined: inl.inlined, missing: inl.missing };
}
