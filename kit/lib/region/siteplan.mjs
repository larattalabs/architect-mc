// `siteplan.json` (schema `siteplan/1`, kit/schemas/siteplan-1.json; docs/CONTRACT.md 6b §3.4): the plan's geometry as
// data for Steward (A6 S10): lots, paths, utility corridors, anchors, parts, and the `graph` block, topology only and
// marked `derived: true` (S-6b-1), derived from the paths and roads: a node per lot entrance, per anchor and per path
// endpoint or junction; an edge per path segment between nodes.
import { centreCells } from './geom.mjs';
import { lotEntrance } from './check.mjs';

const near = (a, b, d = 3) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[2] - b[2])) <= d && Math.abs(a[1] - b[1]) <= 2;

/** A polyline's corner points (where the direction or the height changes), first and last kept. */
export function corners(cells) {
  if (cells.length <= 2) return cells.map((c) => [...c]);
  const out = [cells[0]];
  for (let i = 1; i + 1 < cells.length; i++) {
    const a = cells[i - 1], b = cells[i], c = cells[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[2] - a[2] !== c[2] - b[2] || b[1] - a[1] !== c[1] - b[1]) out.push(b);
  }
  out.push(cells[cells.length - 1]);
  return out.map((c) => [...c]);
}

/** The part kinds: from the plan meta, else derived from the IR. */
export function partKinds(ir, meta) {
  const lotParts = new Set((ir.lots ?? []).map((l) => l.part));
  const formParts = new Set((ir.forms ?? []).map((f) => f.id));
  const floating = new Set((ir.floating ?? []).flatMap((f) => f.parts));
  return ir.parts.map((p) => {
    let kind = meta?.parts?.[p.id]?.kind;
    if (!kind) {
      if (p.set === 'path') kind = 'path';
      else if (lotParts.has(p.id)) kind = 'pad';
      else if (formParts.has(p.id)) kind = 'form';
      else kind = p.ops.every((o) => (o.op === 'shape' ? o.material === null : (o.materials ?? []).every((m) => m === null))) ? 'carve' : 'add';
    }
    return { id: p.id, stage: p.stage, kind: kind === 'path' || kind === 'pad' || kind === 'form' || kind === 'carve' ? kind : 'add', floating: floating.has(p.id) };
  });
}

/** Build siteplan.json for a plan. */
export function sitePlan({ ir, meta, planId = null, irSha = null }) {
  const lots = (ir.lots ?? []).map((l) => {
    const o = { id: l.id, stage: l.stage, rect: [l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ], floorY: l.floorY, front: l.front, entrance: meta?.lots?.[l.id]?.entrance ?? lotEntrance(l) };
    if (l.brief) o.brief = l.brief;
    return o;
  });
  const paths = [];
  for (const [id, m] of Object.entries(meta?.paths ?? {})) paths.push({ id, kind: m.kind, stage: m.stage, width: m.width ?? 3, points: corners(m.cells ?? []), _cells: m.cells ?? [] });
  for (const r of ir.roads ?? []) {
    const { cells } = centreCells(r.points.map((p) => [p[0], p[2]]));
    const ys = r.points.map((p) => p[1]);
    const c3 = cells.map((c) => [c.x, ys[Math.min(c.seg, ys.length - 1)], c.z]);
    paths.push({ id: r.id, kind: 'road', stage: r.stage, width: r.width, points: r.points.map((p) => [...p]), _cells: c3 });
  }
  paths.sort((a, b) => a.id.localeCompare(b.id));
  const utility = (ir.utility ?? []).map((u) => ({ id: u.id, kind: u.kind, width: u.width, height: u.height, points: u.points }));
  const anchors = Object.fromEntries(Object.entries(ir.anchors ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  // ---- the derived graph
  const nodes = [];
  const nodeNear = (at) => nodes.find((n) => near(n.at, at));
  for (const l of lots) nodes.push({ id: `lot:${l.id}`, kind: 'lot', ref: l.id, at: l.entrance, level: l.entrance[1] });
  for (const [name, at] of Object.entries(anchors)) if (!name.startsWith('cam_')) nodes.push({ id: `anchor:${name}`, kind: 'anchor', ref: name, at, level: at[1] });
  let jn = 0;
  const nodeFor = (at) => {
    const n = nodeNear(at);
    if (n) return n.id;
    const id = `j${++jn}`;
    nodes.push({ id, kind: 'junction', ref: null, at: [...at], level: at[1] });
    return id;
  };
  // split points: each path's endpoints, plus where another path's endpoint lies on it
  const splits = paths.map((p) => new Set([0, p._cells.length - 1]));
  paths.forEach((p, i) => {
    for (const end of [p._cells[0], p._cells[p._cells.length - 1]]) {
      if (!end) continue;
      paths.forEach((q, j) => {
        if (i === j) return;
        let best = -1, bd = Infinity;
        q._cells.forEach((c, k) => { if (near(c, end, 2)) { const d = Math.abs(c[0] - end[0]) + Math.abs(c[2] - end[2]); if (d < bd) { bd = d; best = k; } } });
        if (best > 0 && best < q._cells.length - 1) splits[j].add(best);
      });
    }
  });
  const edges = [];
  paths.forEach((p, i) => {
    if (!p._cells.length) return;
    const ks = [...splits[i]].sort((a, b) => a - b);
    for (let s = 0; s + 1 < ks.length; s++) {
      const a = nodeFor(p._cells[ks[s]]), b = nodeFor(p._cells[ks[s + 1]]);
      if (a === b) continue;
      edges.push({ id: `${p.id}#${s + 1}`, from: a, to: b, type: p.kind, path: p.id, stage: p.stage, mover: ['player'] });
    }
  });
  for (const p of paths) delete p._cells;
  return {
    format: 1, planId, irSha, claim: { ...ir.claim }, stages: [...ir.stages], lots, paths, utility, anchors,
    parts: partKinds(ir, meta),
    graph: { derived: true, nodes, edges },
  };
}

// ------------------------------------------------------------------ a small JSON Schema validator (the subset siteplan-1 uses)

/** Validate `v` against a JSON Schema subset (type, required, properties, additionalProperties, items, enum, const,
 * minItems, maxItems, minimum, pattern). Returns a list of errors ("path: message"). */
export function validateSchema(schema, v, where = '$', root = schema) {
  if (schema.$ref) return validateSchema(root.$defs[schema.$ref.replace('#/$defs/', '')], v, where, root);
  const errs = [];
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${where}: expected ${types.join('|')}, got ${t}`];
  }
  if (schema.const !== undefined && v !== schema.const) errs.push(`${where}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${where}: must be one of ${schema.enum.join(', ')}`);
  if (schema.pattern && typeof v === 'string' && !new RegExp(schema.pattern).test(v)) errs.push(`${where}: does not match ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof v === 'number' && v < schema.minimum) errs.push(`${where}: under ${schema.minimum}`);
  if (t === 'object') {
    for (const k of schema.required ?? []) if (!(k in v)) errs.push(`${where}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.properties?.[k]) errs.push(...validateSchema(schema.properties[k], x, `${where}.${k}`, root));
      else if (schema.additionalProperties === false) errs.push(`${where}: unexpected ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validateSchema(schema.additionalProperties, x, `${where}.${k}`, root));
    }
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) errs.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) errs.push(`${where}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => errs.push(...validateSchema(schema.items, x, `${where}[${i}]`, root)));
  }
  return errs;
}
