// `siteplan.json` (schema `siteplan/1`, kit/schemas/siteplan-1.json; docs/CONTRACT.md 6b §3.4): the plan's geometry as
// data for Steward (A6 S10): lots, paths, utility corridors, anchors, parts, and the `graph` block, topology only and
// marked `derived: true` (S-6b-1), derived from the paths and roads: a node per lot entrance, per anchor and per path
// endpoint or junction; an edge per path segment between nodes.
import { centreCells } from './geom.mjs';
import { lotEntrance, nodeReached, walkGraph } from './check.mjs';

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
      else kind = p.ops.every((o) => (o.op === 'shape' ? o.material === null : o.op === 'relief' ? false : (o.materials ?? []).every((m) => m === null))) ? 'carve' : 'add'; // (6c T1) a relief op fills and cuts
    }
    return { id: p.id, stage: p.stage, kind: kind === 'path' || kind === 'pad' || kind === 'form' || kind === 'carve' ? kind : 'add', floating: floating.has(p.id) };
  });
}

/**
 * (6c V) The IR's own graph (`derived: false`): its nodes and edges as planned, each edge's `mover` the player's plus
 * 'villager' where the kit's villager mover (from the bell anchor, over `vw`) reaches both its ends.
 */
function irGraph(ir, meta, vw) {
  const ports = new Map();
  for (const n of ir.graph.nodes) for (const p of n.ports ?? []) ports.set(`${n.id}.${p.name}`, p.at);
  let vg = null;
  const bell = meta?.village?.bell ?? ir.anchors?.bell;
  if (vw && bell) vg = walkGraph(vw, [bell], { mover: 'villager' });
  const nodes = ir.graph.nodes.map((n) => ({ id: n.id, kind: n.kind, ref: n.ref, at: [...n.at], level: n.level, ports: (n.ports ?? []).map((p) => ({ name: p.name, at: [...p.at], facing: p.facing, width: p.width })) }));
  const edges = ir.graph.edges.map((e) => {
    const a = ports.get(e.from), b = ports.get(e.to);
    const v = vg && a && b && nodeReached(vg, a) && nodeReached(vg, b);
    // (6c D1) an external edge: `to` is another region's port (<region>:<node>.<port>; 7a types it)
    return { id: e.id, from: e.from, to: e.to, type: e.type, width: e.width, path: e.path, stage: e.stage, mover: v ? ['player', 'villager'] : ['player'], ...(e.external ? { external: true } : {}), ...(e.crossing ? { crossing: { ...e.crossing } } : {}) };
  });
  return { derived: false, nodes, edges };
}

/** Build siteplan.json for a plan. (6c V) `vw`: the virtual world (the villager mover's reach on the IR's graph). */
export function sitePlan({ ir, meta, planId = null, irSha = null, vw = null }) {
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
  // (6c V) a village's lanes are paths of kind 'path'; its unplaced lots; the IR's graph when it carries one
  const lanes = meta?.village?.lanes ?? {};
  for (const [lotId, cells] of Object.entries(lanes)) if (cells.length) paths.push({ id: `lane_${lotId}`, kind: 'path', stage: ir.parts.find((p) => p.id === 'lanes')?.stage ?? ir.stages[0], width: meta.village.laneWidth ?? 2, points: corners(cells) });
  paths.sort((a, b) => a.id.localeCompare(b.id));
  const out = {
    format: 1, planId, irSha, claim: { ...ir.claim }, stages: [...ir.stages], lots, paths, utility, anchors,
    parts: partKinds(ir, meta),
    graph: ir.graph ? irGraph(ir, meta, vw) : { derived: true, nodes, edges },
  };
  // (6c P0) a plan check's site plan: each lot, path, node and edge names the plan part it came from (`part`), and the parts' rects
  const pc = meta?.planCheck;
  if (pc && !pc.malformed) {
    const of = (k) => pc.partOf?.[k] ?? null;
    for (const l of out.lots) { const z = pc.lotZone?.[l.id] ?? of(`lot:${l.id}`); if (z) l.part = z; }
    for (const p of out.paths) { const z = of(`road:${p.id}`) ?? of(`path:${p.id}`) ?? (p.id.startsWith('lane_') ? pc.lotZone?.[p.id.slice(5)] ?? null : null); if (z && !z.startsWith('__') && !z.startsWith('routes:')) p.part = z; }
    for (const n of out.graph.nodes) { const z = of(`node:${n.id}`) ?? (n.kind === 'lot' ? pc.lotZone?.[n.ref] ?? null : null); if (z && !z.startsWith('__')) n.part = z; }
    for (const e of out.graph.edges) { const z = of(`edge:${e.id}`) ?? of(`road:${e.path}`) ?? of(`path:${e.path}`); if (z && !z.startsWith('__') && !z.startsWith('routes:')) e.part = z; }
    out.planParts = (pc.answers ?? []).filter((a) => a.geometry?.rect).map((a) => ({ part: a.part, class: a.class, rect: [...a.geometry.rect] }));
  }
  if (meta?.village) out.unplaced = (meta.village.unplaced ?? []).map((u) => ({ id: u.id, reason: u.reason }));
  // (6c W) a village's props (the shared space's and the apron lamps, each apron lamp with its lot) and each lot's lamp count
  if (meta?.village?.apronLamps) {
    out.props = (meta.village.props ?? []).map((p) => ({ kind: p.kind, id: p.id, ...(p.lot ? { lot: p.lot } : {}), at: [...p.cells[0].slice(0, 3)] }));
    for (const l of out.lots) l.lamps = meta.village.apronLamps.perLot?.[l.id] ?? 0;
  }
  // (6c T1) the plan-time passes the program ran, with their wall time and the plan's peak memory after each (the plan meta)
  if (meta?.passes?.length) out.passes = meta.passes.map((p) => ({ name: p.name, ms: p.ms, heapMb: p.heapMb }));
  // (7a K1) the plan's walls and their gates (the plan meta's walls: K1a's emission)
  if (Array.isArray(meta?.walls) && meta.walls.length) out.walls = meta.walls.map((w) => ({ id: w.id, part: w.part, line: w.line.map((q) => [...q]), closed: !!w.closed, gates: (w.gates ?? []).map((g) => ({ id: g.id, at: [...g.at], width: g.width, door: g.door, auto: !!g.auto })),
    // ((7a K2, §7) a walk: its width, its runs between accesses and the accesses; an along wall: its spine (the window used))
    ...(w.walk ? { walk: { width: w.walk.width, runs: Math.max(0, ...(w.walk.accesses.length > 1 ? [w.closed ? w.walk.accesses.length : w.walk.accesses.length - 1] : [0])), accesses: w.walk.accesses.map((a) => ({ kind: a.kind, at: [...a.at], foot: [...a.foot] })) } } : {}),
    ...(w.along ? { spine: w.along.spine.map((q) => [...q]) } : {}) }));
  // (6c T3) the plan's bridges (span: deck cells; piers: each pier's centre column [x, z]; landings: the near and far landing cells) and
  // tunnels (portals: the first and last bore cells' floor; length: floor cells; carved: cells cleared), from the plan meta (§8)
  if (Array.isArray(meta?.bridges) && meta.bridges.length) out.bridges = meta.bridges.map((b) => ({ id: b.id, part: b.part, form: b.form, span: b.n, piers: (b.piers ?? []).map((q) => [q.x, q.z]), landings: [[...b.from], [...b.to]] }));
  // (7a foundation, §5) the 7a connectors' rows, from the plan meta each slice's emission records (absent: none)
  if (Array.isArray(meta?.climbs) && meta.climbs.length) out.climbs = meta.climbs.map((c) => ({ id: c.id, part: c.part, kind: c.kind, flights: c.flights ?? 0, hairpins: c.hairpins ?? 0, ladders: (c.ladders ?? []).map((l) => ({ at: [...l.at], rungs: l.rungs, landings: l.landings ?? 0 })) }));
  if (Array.isArray(meta?.rockStairs) && meta.rockStairs.length) out.rockStairs = meta.rockStairs.map((c) => ({ id: c.id, part: c.part, steps: c.steps, landings: c.landings ?? 0, carved: c.carved ?? 0, lined: c.lined ?? 0 }));
  if (Array.isArray(meta?.lifts) && meta.lifts.length) out.lifts = meta.lifts.map((c) => ({ id: c.id, part: c.part, foot: [...c.foot], top: [...c.top], rise: c.rise, down: !!c.down }));
  if (Array.isArray(meta?.catwalks) && meta.catwalks.length) out.catwalks = meta.catwalks.map((c) => ({ id: c.id, part: c.part, cells: c.cells, brackets: c.brackets ?? 0 }));
  if (Array.isArray(meta?.spirals) && meta.spirals.length) out.spirals = meta.spirals.map((c) => ({ id: c.id, part: c.part, host: c.host, rise: c.rise, turns: c.turns, top: [...c.top] }));
  if (Array.isArray(meta?.tunnels) && meta.tunnels.length) out.tunnels = meta.tunnels.map((t) => ({ id: t.id, part: t.part, portals: (t.portals ?? []).map((q) => [...q]), length: t.length, carved: t.carved ?? 0 }));
  // (6c H) the plan's fluid bodies (r.fluidBody's records: counts of sources, declared spill and ice) and quays (H-b's records), from
  // the plan meta (§12)
  if (Array.isArray(meta?.waters) && meta.waters.length) out.waters = meta.waters.map((w) => ({ id: w.id, part: w.part ?? w.id, kind: w.kind, fluid: w.fluid, level: w.level, cells: w.cells, spill: w.spill, ice: w.ice }));
  if (Array.isArray(meta?.quays) && meta.quays.length) out.quays = meta.quays.map((q) => ({ id: q.id, part: q.part, along: q.along.map((c) => [...c]), length: q.length, reach: q.reach, wetCells: q.wetCells }));
  // (6c HY, §12) the plan's courses (one row per course, race or ditch part: its reach bodies, steps and ends; a race's serves, the water
  // gates it passes), from the plan meta's courses records (HY-b's generators; HY-core's hand course)
  if (Array.isArray(meta?.courses) && meta.courses.length) out.courses = meta.courses.map((c) => ({ id: c.id, part: c.part, kind: c.kind, look: c.look, flow: c.flow, bodies: [...c.bodies], steps: (c.steps ?? []).map((q) => ({ kind: q.kind, from: q.from, to: q.to, drop: q.drop })), ends: (c.ends ?? []).map((e) => ({ end: e.end, kind: e.kind, ref: e.ref })), ...(c.serves ? { serves: c.serves } : {}), ...(c.waterGates ? { waterGates: c.waterGates } : {}) }));
  return out;
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
