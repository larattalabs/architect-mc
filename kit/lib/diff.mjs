// Phase 5b: the blueprint delta (docs/CONTRACT.md "The blueprint delta"; the formats are pinned in docs/HANDOFF-5b.md
// "Pinned cross-language formats", which the mod's TemplateDelta implements too: both must give the same cell sets).
//
// Two templates of one entry are compared in DESIGN coordinates (d = t - origin, origin from the blueprint JSON's
// `frame.origin`, missing = [0,0,0]). A cell is a written block (every compound of the .nbt's raw `blocks` list, air
// included); its value is the palette entry's id + properties (a sorted map of strings) + the block-entity compound
// (compared structurally). added = only in B, removed = only in A, changed = both with different values, unchanged =
// both and equal. Each cell carries its part in A and in B: from `<base>.parts.nbt` (exact) or, without a usable one,
// from the blueprint JSON's part boxes (approximate). Part statuses, counts and boxes, the frame check, the frame hint
// and (scope mode) the violations follow the pinned rules.
import fs from 'node:fs';
import { parse } from './nbt.mjs';

/** Packed integer keys for design coordinates (each axis within +-512). */
const OFF = 512;
const S = 1024;
export const packKey = (x, y, z) => ((x + OFF) * S + (y + OFF)) * S + (z + OFF);

/** A canonical string of a tagged NBT value (compound keys sorted; tag types included). */
export function canonTag(t) {
  if (!t) return 'null';
  switch (t.t) {
    case 'compound':
      return `{${Object.keys(t.v).sort().map((k) => `${JSON.stringify(k)}:${canonTag(t.v[k])}`).join(',')}}`;
    case 'list':
      return `${t.of}[${t.v.map(canonTag).join(',')}]`;
    case 'intArray':
    case 'byteArray':
    case 'longArray':
      return `${t.t}[${t.v.map((n) => String(n)).join(',')}]`;
    case 'string':
      return `string:${JSON.stringify(t.v)}`;
    default:
      return `${t.t}:${String(t.v)}`;
  }
}

const tagStr = (t) => (t && t.t === 'string' ? t.v : undefined);

/**
 * Read a structure template: its size and its cells in the raw `blocks` list's file order, each { t: [x,y,z]
 * (template), v: the value key }.
 */
export function readTemplate(file) {
  const root = parse(fs.readFileSync(file));
  if (root.t !== 'compound') throw new Error(`${file}: not a structure template`);
  const pal = root.v.palette?.v ?? [];
  const values = pal.map((p) => {
    const e = p.v ?? {};
    const id = tagStr(e.id) ?? tagStr(e.Name) ?? '?';
    const pr = e.properties ?? e.Properties;
    const props = pr && pr.t === 'compound' ? Object.keys(pr.v).sort().map((k) => `${k}=${tagStr(pr.v[k]) ?? canonTag(pr.v[k])}`).join(',') : '';
    return `${id}[${props}]`;
  });
  const blocks = root.v.blocks?.v ?? [];
  const cells = blocks.map((b) => {
    const pos = b.v.pos.v.map((n) => n.v);
    const st = b.v.state?.v ?? 0;
    const be = b.v.nbt ? canonTag(b.v.nbt) : '';
    return { t: pos, v: `${values[st] ?? `?${st}`}|${be}` };
  });
  const size = root.v.size?.v?.map((n) => n.v) ?? [0, 0, 0];
  return { size, cells };
}

/** Read `<base>.parts.nbt` ({ names, idx }); undefined when missing or unreadable. */
export function readPartMapFile(file) {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const root = parse(fs.readFileSync(file));
    const names = (root.v.names?.v ?? []).map((n) => n.v);
    const idx = root.v.idx?.t === 'intArray' ? root.v.idx.v : undefined;
    if (!idx) return undefined;
    return { names, idx };
  } catch {
    return undefined;
  }
}

/**
 * Labels by box (approximate): the part whose box (template coordinates) contains the cell with the smallest volume;
 * ties go to the first in the JSON's key order; none = null.
 */
export function boxLabels(cells, parts) {
  const boxes = Object.entries(parts && typeof parts === 'object' ? parts : {})
    .map(([name, p]) => ({ name, b: Array.isArray(p?.box) && p.box.length === 6 ? p.box : null }))
    .filter((x) => x.b)
    .map((x) => ({ ...x, vol: (x.b[3] - x.b[0] + 1) * (x.b[4] - x.b[1] + 1) * (x.b[5] - x.b[2] + 1) }));
  return cells.map(({ t: [x, y, z] }) => {
    let best = null;
    for (const p of boxes) {
      const b = p.b;
      if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) continue;
      if (!best || p.vol < best.vol) best = p;
    }
    return best ? best.name : null;
  });
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Load one side of a delta: `<base>.nbt`, and next to it `<base>.blueprint.json` and `<base>.parts.nbt` (the options
 * override: `parts` a parts.nbt path, `frame` an [x,y,z] origin, `json` a blueprint JSON path).
 */
export function loadVersion(nbtPath, o = {}) {
  const base = nbtPath.replace(/\.nbt$/i, '');
  const json = readJson(o.json ?? `${base}.blueprint.json`);
  const tpl = readTemplate(nbtPath);
  const origin = o.frame ?? (Array.isArray(json?.frame?.origin) && json.frame.origin.length === 3 ? json.frame.origin.map(Number) : [0, 0, 0]);
  const map = readPartMapFile(o.parts ?? `${base}.parts.nbt`);
  let labels;
  let exact = false;
  if (map && map.idx.length === tpl.cells.length) {
    labels = map.idx.map((i) => (i >= 0 && i < map.names.length ? map.names[i] : null));
    exact = true;
  } else labels = boxLabels(tpl.cells, json?.parts);
  // label first (boxes are template coordinates), then design coordinates
  const cells = tpl.cells.map((c, i) => ({ d: [c.t[0] - origin[0], c.t[1] - origin[1], c.t[2] - origin[2]], v: c.v, part: labels[i] }));
  return { file: nbtPath, json: json ?? null, size: tpl.size, origin, cells, exact };
}

const canonJson = (v) => (v === undefined ? 'undefined' : JSON.stringify(sortKeys(v)));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const byYZX = (a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0];

/**
 * delta(A, B). `opts.scope` (array of part names) turns on scope mode (violations); `newParts` (default 2), `maxShare`
 * (default 0.5), `max` ([x,y,z]) apply there. `opts.cells` adds the cell lists.
 */
export function diffVersions(A, B, opts = {}) {
  // intern the values, so comparisons are integer compares
  const ids = new Map();
  const vid = (v) => {
    let n = ids.get(v);
    if (n === undefined) ids.set(v, (n = ids.size));
    return n;
  };
  const mapA = new Map();
  const mapB = new Map();
  A.cells.forEach((c, i) => mapA.set(packKey(...c.d), i));
  B.cells.forEach((c, i) => mapB.set(packKey(...c.d), i));
  const va = A.cells.map((c) => vid(c.v));
  const vb = B.cells.map((c) => vid(c.v));
  const partsA = new Set(A.cells.map((c) => c.part).filter((p) => p !== null));
  const partsB = new Set(B.cells.map((c) => c.part).filter((p) => p !== null));
  const stats = new Map();
  const st = (n) => {
    let s = stats.get(n);
    if (!s) stats.set(n, (s = { added: 0, removed: 0, changed: 0, touched: false, boxFrom: null, boxTo: null }));
    return s;
  };
  const grow = (box, d) => (box ? [Math.min(box[0], d[0]), Math.min(box[1], d[1]), Math.min(box[2], d[2]), Math.max(box[3], d[0]), Math.max(box[4], d[1]), Math.max(box[5], d[2])] : [d[0], d[1], d[2], d[0], d[1], d[2]]);
  for (const c of A.cells) if (c.part !== null) st(c.part).boxFrom = grow(st(c.part).boxFrom, c.d);
  for (const c of B.cells) if (c.part !== null) st(c.part).boxTo = grow(st(c.part).boxTo, c.d);
  const cells = { added: [], removed: [], changed: [] };
  /** non-unchanged cells with the labels the scope check looks at: [labels...] */
  const touched = [];
  let unchanged = 0;
  A.cells.forEach((c, i) => {
    const j = mapB.get(packKey(...c.d));
    if (j === undefined) {
      cells.removed.push(c.d);
      if (c.part !== null) {
        st(c.part).removed++;
        st(c.part).touched = true;
      }
      touched.push([c.part]);
      return;
    }
    if (va[i] === vb[j]) {
      unchanged++;
      return;
    }
    cells.changed.push(c.d);
    const pb = B.cells[j].part;
    if (c.part !== null) {
      st(c.part).changed++;
      st(c.part).touched = true;
    }
    if (pb !== null && pb !== c.part) {
      st(pb).changed++;
      st(pb).touched = true;
    }
    touched.push(pb === c.part ? [c.part] : [c.part, pb]);
  });
  B.cells.forEach((c) => {
    if (mapA.has(packKey(...c.d))) return;
    cells.added.push(c.d);
    if (c.part !== null) {
      st(c.part).added++;
      st(c.part).touched = true;
    }
    touched.push([c.part]);
  });
  const parts = {};
  for (const name of [...new Set([...partsA, ...partsB])].sort()) {
    const s = st(name);
    const status = !partsA.has(name) ? 'ADDED' : !partsB.has(name) ? 'REMOVED' : s.touched ? 'CHANGED' : 'UNCHANGED';
    parts[name] = { status, added: s.added, removed: s.removed, changed: s.changed, boxFrom: partsA.has(name) ? s.boxFrom : null, boxTo: partsB.has(name) ? s.boxTo : null };
  }
  const notes = [];
  const approximate = !(A.exact && B.exact);
  if (approximate) notes.push(`part labels by box (approximate): no usable parts.nbt for ${[!A.exact ? 'A' : '', !B.exact ? 'B' : ''].filter(Boolean).join(' and ')}`);
  // the frame check: front and the entrance feet row (groundY - origin.y)
  const frontA = A.json?.front ?? 'south';
  const frontB = B.json?.front ?? 'south';
  const feetA = (A.json?.groundY ?? 1) - A.origin[1];
  const feetB = (B.json?.groundY ?? 1) - B.origin[1];
  const frameKept = frontA === frontB && feetA === feetB;
  if (frontA !== frontB) notes.push(`front changed: ${frontA} -> ${frontB}`);
  if (feetA !== feetB) notes.push(`entrance feet row changed: ${feetA} -> ${feetB}`);
  if (A.origin.some((v, i) => v !== B.origin[i])) notes.push(`origin ${A.origin.join(',')} -> ${B.origin.join(',')} (compared in design coordinates)`);
  // the frame hint (a note only)
  let frameHint;
  const shared = A.cells.map((c, i) => [c, i]).filter(([c]) => c.part !== null && partsB.has(c.part));
  if (shared.length) {
    let fails = 0;
    for (const [c, i] of shared) {
      const j = mapB.get(packKey(...c.d));
      if (j === undefined || vb[j] !== va[i]) fails++;
    }
    if (fails * 2 > shared.length) {
      shared.sort((p, q) => byYZX(p[0].d, q[0].d));
      const k = Math.ceil(shared.length / 2000);
      const sample = shared.filter((_x, n) => n % k === 0);
      let best;
      for (let vx = -8; vx <= 8; vx++) {
        for (let vy = -8; vy <= 8; vy++) {
          for (let vz = -8; vz <= 8; vz++) {
            let m = 0;
            for (const [c, i] of sample) {
              const j = mapB.get(packKey(c.d[0] + vx, c.d[1] + vy, c.d[2] + vz));
              if (j !== undefined && vb[j] === va[i]) m++;
            }
            const sum = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
            // ties: the smallest |v| sum, then x, y, z ascending (the loops run ascending, so only a smaller sum wins a tie)
            if (!best || m > best.m || (m === best.m && sum < best.sum)) best = { m, sum, v: [vx, vy, vz] };
          }
        }
      }
      if (best && best.m >= 0.9 * sample.length) {
        frameHint = best.v;
        notes.push(`frame moved by ${best.v.join(',')}: set origin, keep design coordinates`);
      }
    }
  }
  // scope mode
  const violations = [];
  if (opts.scope) {
    const newParts = opts.newParts ?? 2;
    const maxShare = opts.maxShare ?? 0.5;
    const newNames = [...partsB].filter((n) => !partsA.has(n)).sort();
    const allowed = new Set([...opts.scope, ...(newNames.length <= newParts ? newNames : [])]);
    const outside = new Map();
    for (const labels of touched) {
      for (const l of new Set(labels)) if (l === null || !allowed.has(l)) outside.set(l, (outside.get(l) ?? 0) + 1);
    }
    const keys = [...outside.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
    for (const l of keys) {
      const n = outside.get(l);
      violations.push(l === null ? { kind: 'outside_scope', cells: n, message: `${n} changed cell${n === 1 ? '' : 's'} in no part (every changed cell must belong to an allowed part)` } : { kind: 'outside_scope', part: l, cells: n, message: `${n} changed cell${n === 1 ? '' : 's'} in part "${l}", which is outside the allowed parts (${[...allowed].sort().join(', ') || 'none'})` });
    }
    for (const n of [...partsA].filter((x) => !partsB.has(x) && !allowed.has(x)).sort()) violations.push({ kind: 'part_removed', part: n, message: `part "${n}" is missing from the new version and is not in scope` });
    if (newNames.length > newParts) violations.push({ kind: 'too_many_new_parts', message: `${newNames.length} new parts (${newNames.join(', ')}); at most ${newParts}` });
    if (!frameKept) violations.push({ kind: 'frame_changed', message: `the frame changed (${notes.filter((x) => /^front changed|^entrance feet row/.test(x)).join('; ')}); keep front and the entrance feet row` });
    const inputs = ['params', 'palette', 'values'].filter((k) => canonJson(A.json?.[k]) !== canonJson(B.json?.[k]));
    if (inputs.length) violations.push({ kind: 'inputs_changed', message: `${inputs.join(', ')} changed; a polish keeps the params, the palette and the values` });
    if (opts.max) {
      const s = B.size;
      if (s[0] > opts.max[0] || s[1] > opts.max[1] || s[2] > opts.max[2]) violations.push({ kind: 'too_large', message: `size ${s.join('x')} exceeds the maximum ${opts.max.join('x')}` });
    }
    const n = cells.added.length + cells.removed.length + cells.changed.length;
    if (A.cells.length && n / A.cells.length > maxShare) violations.push({ kind: 'too_many_changes', cells: n, message: `${n} of ${A.cells.length} cells changed (${Math.round((100 * n) / A.cells.length)}%), more than ${Math.round(maxShare * 100)}%: an edit, not a rebuild` });
  }
  const out = { ok: violations.length === 0, frameKept, approximate, parts, added: cells.added.length, removed: cells.removed.length, changed: cells.changed.length, unchanged, notes, violations };
  if (frameHint) out.frameHint = frameHint;
  if (opts.cells) out.cells = { added: cells.added.sort(byYZX), removed: cells.removed.sort(byYZX), changed: cells.changed.sort(byYZX) };
  return out;
}

/** Diff two .nbt files (each with its sidecar JSON and parts.nbt next to it, unless overridden). */
export function diffFiles(a, b, opts = {}) {
  // an entry made before 5b has no frame: its origin is unknown, and a delta against a framed version takes the framed side's
  // origin for it (the design coordinates did not move); two unframed versions compare at 0,0,0 (docs/HANDOFF-5b.md)
  const framed = (p, f) => f ?? (() => {
    const j = readJson(p.replace(/\.nbt$/i, '') + '.blueprint.json');
    return Array.isArray(j?.frame?.origin) && j.frame.origin.length === 3 ? j.frame.origin.map(Number) : undefined;
  })();
  let fa = framed(a, opts.frameA);
  let fb = framed(b, opts.frameB);
  if (fa === undefined && fb !== undefined) fa = fb;
  if (fb === undefined && fa !== undefined) fb = fa;
  return diffVersions(loadVersion(a, { parts: opts.partsA, frame: fa }), loadVersion(b, { parts: opts.partsB, frame: fb }), opts);
}
