// The program side of scatter and stamps (docs/CONTRACT.md 6c F2 §2-§4; kit/REGIONS.md "Kit 0.22.0"). Plan time: like W's
// lightCover, these are functions a program calls with its region builder (`scatter(r, id, spec)`, `stamp(r, id, at)`), so the
// program API module stays free of the plan module (draftIR, the virtual world).
//
// scatter(r, id, spec, {stage, part}) emits one `scatter` op in part `id`. The spec:
//   area: [x0, z0, x1, z1] (default the claim), grid, jitter, seedLabel (default id), cond (default IF_NATURAL),
//   density: p | {field, scale: [lo, hi]} | {mask, p} | {path: [a, b], p} (by distance to path cells, Chebyshev, a..b),
//   mask?: an MP mask at the anchor cell, y?: [lo, hi] (ceiling and wall anchors look there in the frozen volume),
//   items: [{w, item: <bundled name>, ...params} | {w, stamp: 'oak/1' | ['oak/1', ...], skirt?, fallback?: {item, ...}}
//           | {w, block | patch | cells, anchor, on, ...} (raw IR items)],
//   avoidWalk (default true), avoidWritten (default true).
// It builds, from the plan's draft virtual world so far (the earlier ops, as lightCover does):
//   - `<id>_avoid` (u8): walk cells (paths, roads, stair treads...), the columns other parts wrote, blocks or cuts (a relief's band
//     excepted: decoration follows the relief) and the lots' boxes and aprons: no item cell lands on one (kept natural cells: the
//     evaluator, cell by cell);
//   - `<id>_lit` (u8, when an item melts): the columns a planned light of 12 or more reaches within its snow-melt distance plus 1;
//   - `<id>_pathd` (u8, for a `path` density): the Chebyshev distance to the nearest walk column, capped at 255.
// stamp(r, id, at, {rotation, skirt, stage, part, cond}) places one stamp of the local library with its root at `at`.
// A stamp that is not in the library (stamps are local-only, N-F2-1) is a plan note and returns null; a scatter stamp item falls back
// to its `fallback` bundled item (default a boulder), noted.
import { COND } from './program.mjs';
import { draftIR } from './plan.mjs';
import { buildVirtual, F_WALK, F_WRITTEN } from './vworld.mjs';
import { walkKinds } from '../realise.mjs';
import { decodeVoxels, encodeVoxels, voxelAt } from './voxels.mjs';
import { SKIRT_MAX } from './scatter.mjs';
import { bundledItem } from './scatterItems.mjs';
import { STAMP_ID } from './stamps.mjs';

const isInt = Number.isInteger;

/** The library stamp `id` as a side blob (fluids dropped, waterlogged cleared: F2 places no fluid, H's M25): `{name, root, cells, ...}`. */
function stampBlob(r, id) {
  r._stampBlobs ??= new Map();
  if (r._stampBlobs.has(id)) return r._stampBlobs.get(id);
  const lib = r.ctx.stamps ?? null;
  const s = lib && lib.has(id) ? lib.get(id) : null;
  if (!s) { r._stampBlobs.set(id, null); return null; }
  const v = s.voxels;
  const cells = [];
  let fluids = 0, unlogged = 0;
  for (let i = 0; i < v.count; i++) {
    let st = v.palette[v.pal[i]];
    if (/^minecraft:(water|lava|bubble_column)(\[|$)/.test(st)) { fluids++; continue; }
    if (st.includes('waterlogged=true')) { st = st.replace('waterlogged=true', 'waterlogged=false'); unlogged++; }
    cells.push([...voxelAt(v, i), st]);
  }
  const bytes = fluids || unlogged ? encodeVoxels(v.size, cells) : s.arvb;
  const name = `stamp_${id.replace('/', '_')}`.replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  r._sideBlob(name, 'voxels', bytes);
  const e = { name, root: [...s.root], cells: cells.length, feature: s.feature, seed: s.seed, minecraft: s.minecraft, ground: s.ground, fluids, unlogged, size: v.size };
  if (fluids || unlogged) r.note(`stamp ${id}: ${fluids} fluid cell(s) dropped, ${unlogged} waterlogged cell(s) dry (F2 places no fluid)`);
  r._stampBlobs.set(id, e);
  return e;
}

function partFor(r, id, stage, kind) {
  let p = r.parts.find((q) => q.id === id);
  if (!p) p = r.part(id, { stage });
  (r.meta.parts[id] ??= {}).kind = kind;
  return p;
}

/** Place one library stamp with its root cell at `at` ([x, y, z]); null (and a plan note) when the library lacks it. */
export function stamp(r, id, at, { rotation = 0, skirt = SKIRT_MAX, stage, part, cond = COND.IF_NATURAL } = {}) {
  if (!STAMP_ID.test(id)) throw new Error(`stamp: id '${id}' must be '<feature>/<seed>'`);
  if (!Array.isArray(at) || at.length !== 3 || !at.every(isInt)) throw new Error(`stamp ${id}: at must be [x, y, z] integers`);
  const b = stampBlob(r, id);
  r.meta.stamps ??= [];
  if (!b) {
    r.note(`stamp ${id}: not in the local stamp library (stamps are local-only: harvest them with tools/harvest-stamps.mjs)`);
    r.meta.stamps.push({ id, missing: true, at: [...at] });
    return null;
  }
  const pid = part ?? `stamp_${id.replace('/', '_')}`.replace(/[^a-z0-9_]/g, '_').slice(0, 48);
  const p = partFor(r, pid, stage, 'add');
  p._push({ op: 'stamp', id, blob: b.name, root: b.root, at: [...at], rotation, skirt, cond, walk: false });
  r.meta.stamps.push({ id, part: pid, at: [...at], rotation, skirt, cells: b.cells, feature: b.feature, seed: b.seed, minecraft: b.minecraft, size: b.size });
  return { part: pid, blob: b.name, root: b.root, cells: b.cells };
}

/** The plan so far as a format-2 draft (its seed, so earlier scatter ops place as they will) and its virtual world. */
function draftWorld(r) {
  const { ir, blobs } = draftIR(r);
  ir.seed = r.ctx.seed;
  // the owner's protected rects (reading them records them in the IR: the evaluator keeps every item off them)
  const ko = r.ctx.keepOut;
  if (Array.isArray(ko)) ir.keepOut = ko;
  const kinds = walkKinds(ir);
  if (kinds.length) { ir.format = 2; ir.requires = kinds; }
  const volumes = (r.ctx.volumes ?? []).filter((v) => Object.values(r.volumesUsed).some((u) => u.sha === v.sha)).map((v) => v.decoded).filter(Boolean);
  return { ir, vw: buildVirtual({ ir, survey: r.ctx.survey.columns, blobs, volumes }).vw };
}

/** A u8 field over the box from a column predicate. */
function fieldOf(box, f) {
  const width = box[2] - box[0] + 1, depth = box[3] - box[1] + 1;
  const values = new Uint8Array(width * depth);
  for (let j = 0; j < depth; j++) for (let i = 0; i < width; i++) values[i + j * width] = f(box[0] + i, box[1] + j);
  return { type: 'u8', minX: box[0], minZ: box[1], width, depth, res: 1, values };
}

/** Scatter (the op, its items and fields); returns `{part, items, fields, notes}`. */
export function scatter(r, id, spec, { stage, part } = {}) {
  const c = r.claim;
  const area = spec.area ?? [c.minX, c.minZ, c.maxX, c.maxZ];
  const label = spec.seedLabel ?? id;
  const items = [];
  const notes = [];
  let blobN = 0;
  const blobName = () => `sc_${id}_${blobN++}`.slice(0, 32);
  const material = (v) => r.material(v, `scatter ${id} item`);
  for (const [i, e] of (spec.items ?? []).entries()) {
    const w = e.w ?? 1;
    if (e.item !== undefined) {
      const { item, w: _w, ...params } = e;
      const b = bundledItem(item, params, w, { seed: r.ctx.seed, label: `${label}/${i}`, material, blobName });
      for (const bl of b.blobs) r._sideBlob(bl.name, 'voxels', bl.bytes);
      items.push(...b.items.map((x) => ({ ...x, bundled: item })));
    } else if (e.stamp !== undefined) {
      const ids = Array.isArray(e.stamp) ? e.stamp : [e.stamp];
      const got = ids.map((sid) => [sid, stampBlob(r, sid)]).filter(([, b]) => b);
      const miss = ids.filter((sid) => !got.some(([g]) => g === sid));
      if (miss.length) { const n = `scatter ${id}: stamp(s) ${miss.join(', ')} not in the local library (local-only); ${got.length ? 'the others carry the weight' : `falling back to ${e.fallback?.item ?? 'boulder'}`}`; notes.push(n); r.note(n); }
      if (got.length) {
        const ws = Math.max(1, Math.floor(w / got.length));
        for (const [sid, b] of got) items.push({ w: ws, cells: b.name, root: b.root, skirt: e.skirt ?? 2, anchor: 'ground', stamp: sid, ...(e.on ? { on: e.on } : {}) });
      } else {
        const fb = e.fallback ?? { item: 'boulder' };
        const { item, ...params } = fb;
        const b = bundledItem(item, params, w, { seed: r.ctx.seed, label: `${label}/${i}`, material, blobName });
        for (const bl of b.blobs) r._sideBlob(bl.name, 'voxels', bl.bytes);
        items.push(...b.items.map((x) => ({ ...x, bundled: item, fallbackFor: ids })));
      }
    } else {
      const it = { ...e, w };
      if (typeof it.block === 'string') it.block = material(it.block);
      else if (it.block && typeof it.block === 'object') it.block = Object.fromEntries(Object.entries(it.block).map(([k, v]) => [k, material(v)]));
      if (Array.isArray(it.patch)) it.patch = it.patch.map((p) => [p[0], p[1], material(p[2]), ...(p[3] ? [material(p[3])] : [])]);
      items.push(it);
    }
  }
  if (!items.length) { r.note(`scatter ${id}: no items`); return null; }
  // ---- the fields from the draft world (the plan so far)
  const { ir, vw } = draftWorld(r);
  const M = 4; // SCATTER_MAX_RADIUS
  const box = [Math.max(c.minX, area[0] - M), Math.max(c.minZ, area[1] - M), Math.min(c.maxX, area[2] + M), Math.min(c.maxZ, area[3] + M)];
  const reliefParts = new Set(ir.parts.map((p, i) => (p.ops.some((o) => o.op === 'relief') ? i : -1)).filter((i) => i >= 0));
  const W = box[2] - box[0] + 1, D = box[3] - box[1] + 1;
  const walk = new Uint8Array(W * D), written = new Uint8Array(W * D), lit = new Uint8Array(W * D);
  const inBox = (x, z) => x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3];
  const at = (x, z) => (x - box[0]) + (z - box[1]) * W;
  const emitters = [];
  vw.eachWritten((x, y, z, idx) => {
    const p = vw.partAt(x, y, z);
    if (vw.pal.emit[idx] >= 12) emitters.push([x, y, z, vw.pal.emit[idx]]);
    if (!inBox(x, z)) return;
    if (vw.flags(x, y, z) & F_WALK) walk[at(x, z)] = 1;
    if (!reliefParts.has(p)) written[at(x, z)] = 1; // a block or a cut (a pad's batter, a carve): the frozen ground there is not the ground
  });
  for (const l of ir.lots ?? []) for (let x = l.box.minX - 1; x <= l.box.maxX + 1; x++) for (let z = l.box.minZ - 1; z <= l.box.maxZ + 1; z++) if (inBox(x, z)) written[at(x, z)] = 1;
  // (the parts' kept natural cells: the evaluator keeps every placement off them, cell by cell, with the frozen volume)
  const melts = items.some((it) => it.melts);
  if (melts) for (const [ex, , ez, L] of emitters) {
    const rr = L - 12 + 1;
    for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) if (Math.abs(dx) + Math.abs(dz) <= rr && inBox(ex + dx, ez + dz)) lit[at(ex + dx, ez + dz)] = 1;
  }
  const op = { op: 'scatter', area: [...area], grid: spec.grid, jitter: spec.jitter ?? 0, seedLabel: label, items: items.map(({ bundled, stamp: s, fallbackFor, ...x }) => x), cond: spec.cond ?? COND.IF_NATURAL, walk: false };
  const fields = {};
  if (spec.avoidWalk !== false || spec.avoidWritten !== false) {
    const nm = `${id}_avoid`.slice(0, 32);
    r.field(nm, fieldOf(box, (x, z) => ((spec.avoidWalk !== false && walk[at(x, z)]) || (spec.avoidWritten !== false && written[at(x, z)]) ? 1 : 0)));
    op.avoid = nm; fields.avoid = nm;
  }
  if (melts) { const nm = `${id}_lit`.slice(0, 32); r.field(nm, fieldOf(box, (x, z) => lit[at(x, z)])); op.lit = nm; fields.lit = nm; }
  let density = spec.density;
  if (density && typeof density === 'object' && Array.isArray(density.path)) {
    // Chebyshev distance to the nearest walk column (a 2-pass chamfer over the box), capped at 255
    const dist = new Uint16Array(W * D).fill(65535);
    for (let i = 0; i < W * D; i++) if (walk[i]) dist[i] = 0;
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      let d = dist[x + z * W];
      for (const [dx, dz] of [[-1, 0], [-1, -1], [0, -1], [1, -1]]) { const X = x + dx, Z = z + dz; if (X >= 0 && Z >= 0 && X < W) d = Math.min(d, dist[X + Z * W] + 1); }
      dist[x + z * W] = d;
    }
    for (let z = D - 1; z >= 0; z--) for (let x = W - 1; x >= 0; x--) {
      let d = dist[x + z * W];
      for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1]]) { const X = x + dx, Z = z + dz; if (Z < D && X >= 0 && X < W) d = Math.min(d, dist[X + Z * W] + 1); }
      dist[x + z * W] = d;
    }
    const nm = `${id}_pathd`.slice(0, 32);
    r.field(nm, fieldOf(box, (x, z) => Math.min(255, dist[at(x, z)])));
    fields.pathd = nm;
    density = { mask: { field: nm, gte: density.path[0], lt: density.path[1] + 1 }, p: density.p ?? 1 };
  }
  if (density && typeof density === 'object' && density.mask !== undefined) density = { ...density, mask: r.mask(density.mask, `scatter ${id} density mask`) };
  op.density = density;
  if (spec.mask !== undefined) op.mask = r.mask(spec.mask, `scatter ${id} mask`);
  if (spec.y !== undefined) op.y = [...spec.y];
  const p = partFor(r, part ?? id, stage, 'add');
  p._push(op);
  r.meta.scatter ??= [];
  r.meta.scatter.push({ id, part: p.id, area: [...area], grid: op.grid, items: items.map((it) => ({ w: it.w, anchor: it.anchor ?? 'ground', kind: it.block ? 'block' : it.patch ? 'patch' : 'cells', bundled: it.bundled ?? null, stamp: it.stamp ?? null, fallbackFor: it.fallbackFor ?? null })), fields, emitters: emitters.length, notes });
  return { part: p.id, items: items.length, fields, notes };
}
