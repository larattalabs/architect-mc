// Review sheets for Noah are ONE self-contained HTML file (Noah via the parent session, 2026-11-15): his preview gets only the
// HTML, so every <img src="..."> pointing at a local file is inlined as a data: URI. A PNG larger than `maxPngBytes` is re-encoded
// as JPEG (macOS `sips`, quality `jpegQuality`) before inlining; when sips is missing or fails, the original bytes are kept.
// Remote (http:, https:) and already-inlined (data:) sources are left alone. A missing file is left as is and reported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** The bytes and type to inline for one image file (a large PNG as JPEG when possible). */
export function imageData(file, { maxPngBytes = 300_000, jpegQuality = 80 } = {}) {
  const ext = path.extname(file).toLowerCase();
  let bytes = fs.readFileSync(file);
  let mime = MIME[ext] ?? 'application/octet-stream';
  if (ext === '.png' && bytes.length > maxPngBytes) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-inline-')), 'img.jpg');
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(jpegQuality), file, '--out', tmp], { stdio: 'ignore' });
      const jpg = fs.readFileSync(tmp);
      if (jpg.length < bytes.length) { bytes = jpg; mime = 'image/jpeg'; }
    } catch { /* keep the PNG */ } finally { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); }
  }
  return { mime, bytes };
}

/** `html` with every local <img src> (relative to `baseDir`) inlined. Returns { html, inlined, missing }. */
export function inlineImages(html, baseDir, opts = {}) {
  let inlined = 0;
  const missing = [];
  const cache = new Map();
  const out = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi, (m, pre, q, src) => {
    if (/^(data:|https?:)/i.test(src)) return m;
    const file = path.resolve(baseDir, decodeURI(src.split(/[?#]/)[0]));
    if (!fs.existsSync(file)) { missing.push(src); return m; }
    if (!cache.has(file)) { const { mime, bytes } = imageData(file, opts); cache.set(file, `data:${mime};base64,${bytes.toString('base64')}`); }
    inlined++;
    return `${pre}${q}${cache.get(file)}${q}`;
  });
  return { html: out, inlined, missing };
}

/** Writes `html` to `file` self-contained (images relative to the file's directory inlined). Returns the inlineImages result. */
export function writeSheet(file, html, opts = {}) {
  const r = inlineImages(html, path.dirname(file), opts);
  fs.writeFileSync(file, r.html);
  return r;
}
