// The four region previews (docs/CONTRACT.md phase 6 §4 "The four views", 6b §3.3): `top` (shaded relief, parts tinted
// by kind, lots, paths, anchors, the claim), `section` (vertical cuts along up to 4 axes), `iso` (a low-detail isometric of
// the post-op surface) and `siteplan` (SVG + PNG + siteplan.json). Sidecar renders, no game; the same IR and survey give
// byte-identical pixels.
import fs from 'node:fs';
import path from 'node:path';
import { COLORS } from '../colors.mjs';
import { Canvas, hex } from './raster.mjs';
import { F_WALK, F_WRITTEN, buildVirtual, parseState } from './vworld.mjs';
import { fillMissing } from './plan.mjs';
import { centreCells, line4 } from './geom.mjs';
import { sitePlan, partKinds } from './siteplan.mjs';

export const VIEWS = ['top', 'section', 'iso', 'siteplan'];
const MAX_PX = 2048;

/** A block state's [top, side] colours, from the kit's texture averages (unknown: grey). */
const colourCache = new Map();
export function colourOf(state) {
  let c = colourCache.get(state);
  if (c) return c;
  const name = parseState(state).name.replace(/^minecraft:/, '');
  const e = COLORS[name];
  if (typeof e === 'string') c = [hex(e), hex(e)];
  else if (Array.isArray(e)) c = [hex(e[0]), hex(e[1])];
  else c = [[128, 128, 128], [110, 110, 110]];
  if (name === 'water') c = [[52, 95, 218], [44, 80, 190]];
  colourCache.set(state, c);
  return c;
}

const mix = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const shade = (c, f) => [Math.min(255, Math.round(c[0] * f)), Math.min(255, Math.round(c[1] * f)), Math.min(255, Math.round(c[2] * f))];
const TINT = { carve: [210, 60, 50], add: [60, 110, 220], path: [235, 190, 40], pad: [140, 140, 140], form: [80, 170, 90], floating: [190, 70, 200] };
const STAGE_COLOURS = [[66, 133, 244], [219, 68, 55], [244, 180, 0], [15, 157, 88], [171, 71, 188], [0, 172, 193], [255, 112, 67], [158, 157, 36]];
const INK = [30, 30, 30];

/** The post-op top of a column: [y, palette index] of the highest non-air cell in its changed range. */
function topCell(vw, x, z) {
  const P = vw.pal;
  const [lo, hi] = vw.colRange(x, z);
  for (let y = hi + 2; y >= lo - 2; y--) { const i = vw.get(x, y, z); if (!P.air[i]) return [y, i]; }
  for (let y = lo - 3; y >= vw.claim.minY; y--) { const i = vw.get(x, y, z); if (!P.air[i]) return [y, i]; }
  return [vw.claim.minY, 0];
}

/** Which part kind tints a column: the part that wrote its top, or carved it. */
function columnTint(vw, kinds, x, z, ty) {
  const [lo, hi] = vw.colRange(x, z);
  if (lo > hi || !vw.inClaim(x, z) || vw.wLo[vw.colIndex(x, z)] > vw.wHi[vw.colIndex(x, z)]) return null;
  const f = vw.flags(x, ty, z);
  if (f & F_WALK) return TINT.path;
  let pi = vw.partAt(x, ty, z);
  if (pi < 0) pi = vw.partAt(x, ty + 1, z);
  if (pi < 0) { for (let y = hi; y >= lo; y--) { const p = vw.partAt(x, y, z); if (p >= 0) { pi = p; break; } } }
  if (pi < 0) return null;
  const k = kinds[pi];
  return k.floating ? TINT.floating : TINT[k.kind] ?? null;
}

function renderTop(vw, ir, meta, sp) {
  const c = ir.claim;
  const W = c.maxX - c.minX + 1, D = c.maxZ - c.minZ + 1;
  const step = Math.max(1, Math.ceil(Math.max(W, D) / MAX_PX));
  const s = step === 1 ? Math.max(1, Math.min(4, Math.floor(1024 / Math.max(W, D)))) : 1;
  const w = Math.ceil(W / step) * s, h = Math.ceil(D / step) * s;
  const cv = new Canvas(w, h);
  const kinds = partKinds(ir, meta);
  const H = new Float64Array(Math.ceil(W / step) * Math.ceil(D / step));
  const cw = Math.ceil(W / step);
  for (let j = 0; j * step < D; j++) for (let i = 0; i * step < W; i++) {
    const x = c.minX + i * step, z = c.minZ + j * step;
    const [ty, idx] = topCell(vw, x, z);
    H[i + j * cw] = ty;
    let col = colourOf(vw.pal.states[idx])[0];
    const hnw = i > 0 && j > 0 ? H[i - 1 + (j - 1) * cw] : ty;
    col = shade(col, Math.max(0.6, Math.min(1.35, 1 + 0.08 * (ty - hnw))));
    const tint = columnTint(vw, kinds, x, z, ty);
    if (tint) col = mix(col, tint, 0.35);
    cv.rect(i * s, j * s, i * s + s - 1, j * s + s - 1, col);
  }
  const X = (x) => ((x - c.minX) / step) * s, Z = (z) => ((z - c.minZ) / step) * s;
  for (const p of sp.paths) for (let k = 1; k < p.points.length; k++) cv.line(X(p.points[k - 1][0]), Z(p.points[k - 1][2]), X(p.points[k][0]), Z(p.points[k][2]), p.kind === 'bridge' ? [70, 70, 70] : [150, 110, 60], Math.max(1, Math.round((p.width * s) / step / 2)));
  for (const l of sp.lots) {
    cv.frame(Math.round(X(l.rect[0])), Math.round(Z(l.rect[1])), Math.round(X(l.rect[2] + 1)) - 1, Math.round(Z(l.rect[3] + 1)) - 1, INK);
    if ((l.rect[2] - l.rect[0]) * s / step > 30) cv.label(X(l.rect[0]) + 2, Z(l.rect[1]) + 2, l.id, INK);
  }
  for (const [name, a] of Object.entries(sp.anchors)) { cv.disc(X(a[0]), Z(a[2]), Math.max(2, s), [220, 30, 30]); if (!name.startsWith('cam_')) cv.label(X(a[0]) + 4, Z(a[2]) - 3, name, [180, 20, 20]); }
  cv.frame(0, 0, w - 1, h - 1, INK);
  return cv;
}

/** The default section axis: entrance -> the claim's centre -> on to the claim's edge. */
export function defaultAxis(ir) {
  const c = ir.claim;
  const e = ir.anchors?.entrance ?? [c.minX, 0, c.minZ];
  const cx = Math.floor((c.minX + c.maxX) / 2), cz = Math.floor((c.minZ + c.maxZ) / 2);
  let dx = cx - e[0], dz = cz - e[2];
  if (!dx && !dz) dx = 1;
  // continue the direction to the claim edge
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (c.maxX - cx) / dx); else if (dx < 0) t = Math.min(t, (c.minX - cx) / dx);
  if (dz > 0) t = Math.min(t, (c.maxZ - cz) / dz); else if (dz < 0) t = Math.min(t, (c.minZ - cz) / dz);
  const ex = Math.round(cx + dx * t), ez = Math.round(cz + dz * t);
  return [[e[0], e[1], e[2]], [cx, 0, cz], [ex, 0, ez]];
}

function renderSection(vw, ir, axis, survey) {
  const P = vw.pal;
  const pts = axis.map((p) => [Math.round(p[0]), Math.round(p[2])]);
  const cols = [];
  for (let k = 1; k < pts.length; k++) for (const [x, z] of line4(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1])) { const l = cols[cols.length - 1]; if (!l || l[0] !== x || l[1] !== z) cols.push([x, z]); }
  let ylo = Infinity, yhi = -Infinity;
  for (const [x, z] of cols) { const [lo, hi] = vw.colRange(x, z); ylo = Math.min(ylo, lo); yhi = Math.max(yhi, hi); }
  ylo = Math.max(vw.claim.minY, ylo - 12); yhi = Math.min(vw.claim.maxY, yhi + 12);
  const n = cols.length, hh = yhi - ylo + 1;
  const s = Math.max(1, Math.min(4, Math.floor(1600 / Math.max(n, hh))));
  const step = Math.max(1, Math.ceil(n / MAX_PX));
  const w = Math.ceil(n / step) * s, h = hh * s;
  const cv = new Canvas(w, h, [228, 240, 252]);
  for (let y = ylo; y <= yhi; y++) if (y % 8 === 0) { const py = (yhi - y) * s; for (let x = 0; x < w; x += 2) cv.set(x, py, [190, 205, 220]); }
  const floating = new Set((ir.floating ?? []).flatMap((f) => f.parts.map((id) => ir.parts.findIndex((p) => p.id === id))));
  for (let i = 0; i * step < n; i++) {
    const [x, z] = cols[i * step];
    for (let y = ylo; y <= yhi; y++) {
      const idx = vw.get(x, y, z);
      let col;
      if (vw.lotAt(x, y, z)) col = [235, 235, 235];
      else if (P.air[idx]) continue;
      else col = colourOf(P.states[idx])[1];
      if (!P.air[idx] && floating.has(vw.partAt(x, y, z))) col = mix(col, TINT.floating, 0.3);
      cv.rect(i * s, (yhi - y) * s, i * s + s - 1, (yhi - y) * s + s - 1, col);
    }
    // the pre-region surface line
    const gy = vw.colTop(x, z);
    if (gy >= ylo && gy <= yhi) cv.rect(i * s, (yhi - gy) * s, i * s + s - 1, (yhi - gy) * s, INK);
  }
  // lot boxes crossed by the axis
  for (const l of ir.lots ?? []) {
    const b = l.box;
    let i0 = -1, i1 = -1;
    cols.forEach(([x, z], i) => { if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) { if (i0 < 0) i0 = i; i1 = i; } });
    if (i0 < 0) continue;
    cv.frame(Math.floor(i0 / step) * s, (yhi - b.maxY) * s, Math.floor(i1 / step) * s + s - 1, (yhi - b.minY) * s + s - 1, [40, 40, 160]);
  }
  for (let y = ylo; y <= yhi; y++) if (y % 32 === 0) cv.label(2, (yhi - y) * s - 8, `y${y}`, INK);
  cv.frame(0, 0, w - 1, h - 1, INK);
  return cv;
}

function renderIso(vw, ir, meta) {
  const c = ir.claim;
  const W = c.maxX - c.minX + 1, D = c.maxZ - c.minZ + 1;
  const step = Math.max(1, Math.ceil((W + D) / 900));
  const nx = Math.ceil(W / step), nz = Math.ceil(D / step);
  const t = step > 1 ? 1 : Math.max(1, Math.min(4, Math.floor(1200 / (W + D))));
  const tops = new Float64Array(nx * nz), cols = new Array(nx * nz);
  let ylo = Infinity, yhi = -Infinity;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const [y, idx] = topCell(vw, c.minX + i * step, c.minZ + j * step);
    tops[i + j * nx] = y; cols[i + j * nx] = idx;
    ylo = Math.min(ylo, y); yhi = Math.max(yhi, y);
  }
  const vs = Math.max(1, t) / step; // vertical pixels per block
  const w = (nx + nz) * t + 4, h = Math.ceil((nx + nz) * t / 2 + (yhi - ylo + 8) * vs) + 4;
  const cv = new Canvas(Math.min(w, 4096), Math.min(h, 4096), [240, 244, 248]);
  const ox = nz * t + 2, oy = Math.ceil((yhi - ylo + 4) * vs) + 2;
  const P = (i, j, y) => [ox + (i - j) * t, oy + ((i + j) * t) / 2 - (y - ylo) * vs];
  // back to front
  for (let sum = 0; sum < nx + nz - 1; sum++) for (let i = Math.max(0, sum - nz + 1); i <= Math.min(nx - 1, sum); i++) {
    const j = sum - i;
    const y = tops[i + j * nx];
    const [topC, sideC] = colourOf(vw.pal.states[cols[i + j * nx]]);
    const below = Math.min(i + 1 < nx ? tops[i + 1 + j * nx] : ylo - 4, j + 1 < nz ? tops[i + (j + 1) * nx] : ylo - 4);
    const [px, py] = P(i, j, y);
    const [, pyb] = P(i, j, Math.min(y, below));
    cv.rect(Math.round(px - t), Math.round(py), Math.round(px + t) - 1, Math.round(pyb + t), shade(sideC, 0.8));
    cv.rect(Math.round(px - t), Math.round(py - t / 2), Math.round(px + t) - 1, Math.round(py + t / 2), topC);
  }
  // lots as boxes (outlines), paths on top
  for (const l of ir.lots ?? []) {
    const b = l.box;
    const corners = [[b.minX, b.minZ], [b.maxX + 1, b.minZ], [b.maxX + 1, b.maxZ + 1], [b.minX, b.maxZ + 1]].map(([x, z]) => [(x - c.minX) / step, (z - c.minZ) / step]);
    for (const yy of [b.minY, b.maxY + 1]) for (let k = 0; k < 4; k++) {
      const a = P(corners[k][0], corners[k][1], yy), e = P(corners[(k + 1) % 4][0], corners[(k + 1) % 4][1], yy);
      cv.line(a[0], a[1], e[0], e[1], [40, 40, 160]);
    }
    for (let k = 0; k < 4; k++) { const a = P(corners[k][0], corners[k][1], b.minY), e = P(corners[k][0], corners[k][1], b.maxY + 1); cv.line(a[0], a[1], e[0], e[1], [40, 40, 160]); }
  }
  for (const [, m] of Object.entries(meta?.paths ?? {})) {
    const cs = m.cells ?? [];
    for (let k = 1; k < cs.length; k++) {
      const a = P((cs[k - 1][0] - c.minX) / step, (cs[k - 1][2] - c.minZ) / step, cs[k - 1][1]), e = P((cs[k][0] - c.minX) / step, (cs[k][2] - c.minZ) / step, cs[k][1]);
      cv.line(a[0], a[1], e[0], e[1], m.kind === 'bridge' ? [60, 60, 60] : [200, 150, 40], 2);
    }
  }
  return cv;
}

/** The site plan as a display list, drawn into SVG and into a canvas from the same primitives. */
function sitePlanDrawing(sp, ir) {
  const c = ir.claim;
  const W = c.maxX - c.minX + 1, D = c.maxZ - c.minZ + 1;
  const s = Math.max(0.5, Math.min(4, 1400 / Math.max(W, D)));
  const pad = 40;
  const w = Math.round(W * s) + 2 * pad, h = Math.round(D * s) + 2 * pad + 30;
  const X = (x) => pad + (x - c.minX) * s, Z = (z) => pad + (z - c.minZ) * s;
  const prims = [];
  prims.push({ t: 'rect', x0: X(c.minX), y0: Z(c.minZ), x1: X(c.maxX + 1), y1: Z(c.maxZ + 1), stroke: [120, 120, 120], fill: [250, 250, 246] });
  const stageCol = (st) => STAGE_COLOURS[Math.max(0, sp.stages.indexOf(st)) % STAGE_COLOURS.length];
  for (const u of sp.utility) for (let k = 1; k < u.points.length; k++) prims.push({ t: 'line', x0: X(u.points[k - 1][0]), y0: Z(u.points[k - 1][2]), x1: X(u.points[k][0]), y1: Z(u.points[k][2]), stroke: [0, 150, 160], w: Math.max(1, u.width * s), dash: true });
  for (const p of sp.paths) {
    const col = p.kind === 'bridge' ? [70, 70, 70] : p.kind === 'stair' ? [160, 90, 30] : p.kind === 'road' ? [150, 120, 70] : [190, 150, 80];
    for (let k = 1; k < p.points.length; k++) prims.push({ t: 'line', x0: X(p.points[k - 1][0]), y0: Z(p.points[k - 1][2]), x1: X(p.points[k][0]), y1: Z(p.points[k][2]), stroke: col, w: Math.max(1, p.width * s) });
  }
  for (const l of sp.lots) {
    const [x0, z0, x1, z1] = l.rect;
    prims.push({ t: 'rect', x0: X(x0), y0: Z(z0), x1: X(x1 + 1), y1: Z(z1 + 1), stroke: INK, fill: mix(stageCol(l.stage), [255, 255, 255], 0.6) });
    prims.push({ t: 'text', x: X(x0) + 2, y: Z(z0) + 2, text: l.id, fill: INK });
    if (l.brief && (x1 - x0) * s > 60) prims.push({ t: 'text', x: X(x0) + 2, y: Z(z0) + 12, text: l.brief.slice(0, Math.floor(((x1 - x0) * s) / 6)), fill: [80, 80, 80] });
    const [ex, , ez] = l.entrance;
    prims.push({ t: 'disc', x: X(ex + 0.5), y: Z(ez + 0.5), r: 3, fill: [20, 120, 40] });
  }
  for (const [name, a] of Object.entries(sp.anchors)) {
    prims.push({ t: 'disc', x: X(a[0] + 0.5), y: Z(a[2] + 0.5), r: 4, fill: [210, 30, 30] });
    if (!name.startsWith('cam_')) prims.push({ t: 'text', x: X(a[0]) + 6, y: Z(a[2]) - 4, text: name, fill: [170, 20, 20] });
  }
  // the stage legend, scale bar and north arrow
  sp.stages.forEach((st, i) => { prims.push({ t: 'rect', x0: pad + i * 110, y0: h - 24, x1: pad + i * 110 + 10, y1: h - 14, stroke: INK, fill: mix(stageCol(st), [255, 255, 255], 0.6) }); prims.push({ t: 'text', x: pad + i * 110 + 14, y: h - 24, text: st, fill: INK }); });
  const bar = 32;
  prims.push({ t: 'line', x0: w - pad - bar * s, y0: 20, x1: w - pad, y1: 20, stroke: INK, w: 2 });
  prims.push({ t: 'text', x: w - pad - bar * s, y: 6, text: `${bar} blocks`, fill: INK });
  prims.push({ t: 'line', x0: 20, y0: 30, x1: 20, y1: 10, stroke: INK, w: 2 });
  prims.push({ t: 'text', x: 17, y: 32, text: 'N', fill: INK });
  return { w, h, prims };
}

function drawCanvas(d) {
  const cv = new Canvas(d.w, d.h);
  for (const p of d.prims) {
    if (p.t === 'rect') { if (p.fill) cv.rect(Math.round(p.x0), Math.round(p.y0), Math.round(p.x1) - 1, Math.round(p.y1) - 1, p.fill); if (p.stroke) cv.frame(Math.round(p.x0), Math.round(p.y0), Math.round(p.x1) - 1, Math.round(p.y1) - 1, p.stroke); }
    else if (p.t === 'line') cv.line(p.x0, p.y0, p.x1, p.y1, p.stroke, Math.max(1, Math.round(p.w ?? 1)));
    else if (p.t === 'disc') cv.disc(p.x, p.y, p.r, p.fill);
    else if (p.t === 'text') cv.label(p.x, p.y, p.text, p.fill);
  }
  return cv;
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const n2 = (v) => Math.round(v * 100) / 100;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function drawSvg(d) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}" font-family="monospace" font-size="9">`, `<rect width="${d.w}" height="${d.h}" fill="white"/>`];
  for (const p of d.prims) {
    if (p.t === 'rect') out.push(`<rect x="${n2(p.x0)}" y="${n2(p.y0)}" width="${n2(p.x1 - p.x0)}" height="${n2(p.y1 - p.y0)}" fill="${p.fill ? rgb(p.fill) : 'none'}" stroke="${p.stroke ? rgb(p.stroke) : 'none'}"/>`);
    else if (p.t === 'line') out.push(`<line x1="${n2(p.x0)}" y1="${n2(p.y0)}" x2="${n2(p.x1)}" y2="${n2(p.y1)}" stroke="${rgb(p.stroke)}" stroke-width="${n2(p.w ?? 1)}"${p.dash ? ' stroke-dasharray="4 3"' : ''} stroke-linecap="round"/>`);
    else if (p.t === 'disc') out.push(`<circle cx="${n2(p.x)}" cy="${n2(p.y)}" r="${p.r}" fill="${rgb(p.fill)}"/>`);
    else if (p.t === 'text') out.push(`<text x="${n2(p.x)}" y="${n2(p.y + 8)}" fill="${rgb(p.fill)}">${esc(p.text)}</text>`);
  }
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

/**
 * Render the previews into `outDir/previews/` (and `outDir/siteplan.json`). `views` defaults to all four; `axes` are
 * section polylines ([[x, y, z]...], at most 4; default one from the entrance through the centre). `world`: a virtual
 * world already built (the checker's), else one is built here. Returns {paths: {view: [file]}, sitePlan, sitePlanFile,
 * pixels: {file: sha256 of the RGBA pixels}, ms}.
 */
export function renderPreviews({ ir, survey, blobs, volumes = [], meta = null, world = null, views = VIEWS, axes = null, outDir, planId = null, irSha = null }) {
  const t0 = performance.now();
  const vw = world ?? buildVirtual({ ir, survey, filled: fillMissing(survey).columns, blobs, volumes }).vw;
  const dir = path.join(outDir, 'previews');
  fs.mkdirSync(dir, { recursive: true });
  const sp = sitePlan({ ir, meta, planId, irSha });
  const paths = {};
  const pixels = {};
  const put = (view, name, cv) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, cv.png());
    (paths[view] ??= []).push(f);
    pixels[name] = cv.pixelSha();
  };
  if (views.includes('top')) put('top', 'top.png', renderTop(vw, ir, meta, sp));
  if (views.includes('section')) {
    const list = (axes && axes.length ? axes : [defaultAxis(ir)]).slice(0, 4);
    list.forEach((a, i) => put('section', `section-${i + 1}.png`, renderSection(vw, ir, a, survey)));
  }
  if (views.includes('iso')) put('iso', 'iso.png', renderIso(vw, ir, meta));
  let sitePlanFile = null;
  if (views.includes('siteplan')) {
    const d = sitePlanDrawing(sp, ir);
    const svg = path.join(dir, 'siteplan.svg');
    fs.writeFileSync(svg, drawSvg(d));
    paths.siteplan = [svg];
    put('siteplan', 'siteplan.png', drawCanvas(d));
    sitePlanFile = path.join(outDir, 'siteplan.json');
    fs.writeFileSync(sitePlanFile, `${JSON.stringify(sp, null, 1)}\n`);
  }
  return { paths, sitePlan: sp, sitePlanFile, pixels, ms: Math.round(performance.now() - t0) };
}

export { centreCells };
