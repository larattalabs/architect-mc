// (6c D1) A district beside a standing region (docs/CONTRACT.md "Phase 6c slice D" §3): the standing region's footprint from its IR,
// the seam rule (the new claim may overlap the standing one only in a seam of at most SEAM_MAX columns, and never over its lots,
// roads or paths), and the `beside` data a plan reads (ctx.beside). The mod's RegionsImpl applies the same rule in Java
// (BesideCheck); this module is the reference the kit tests and the gate use.

import { centreCells, crossOffsets } from './geom.mjs';

/** The deepest overlap of the two claims (columns, along the narrower side of their intersection). */
export const SEAM_MAX = 16;

const rect = (x0, z0, x1, z1) => [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];
const meets = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const grow = (a, n) => [a[0] - n, a[1] - n, a[2] + n, a[3] + n];

/**
 * A standing region's footprint from its IR: `lots` (its lot boxes, x/z), `roads` (each 4e road segment's rect grown by half its
 * width plus 1: the verge and lanterns), `paths` (the IR paths' boxes: graded runs, stairs, ladders) and `ways` (the columns of
 * its path-set parts: streets' verges, lanes, squares and route runs, as row runs). `[{id, kind, rect: [x0, z0, x1, z1]}]` each.
 */
export function standingFootprint(ir) {
  const lots = (ir.lots ?? []).map((l) => ({ id: l.id, kind: 'lot', rect: [l.box.minX, l.box.minZ, l.box.maxX, l.box.maxZ] }));
  const roads = [];
  for (const r of ir.roads ?? []) {
    const h = Math.floor((r.width ?? 3) / 2) + 1;
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      // across the segment by half its width plus 1 (the verge and lanterns); along it, its own ends (the cell past an end is the join's)
      const q = rect(a[0], a[2], b[0], b[2]);
      const ax = a[2] === b[2], az = a[0] === b[0];
      roads.push({ id: r.id, kind: 'road', rect: [q[0] - (ax ? 0 : h), q[1] - (az ? 0 : h), q[2] + (ax ? 0 : h), q[3] + (az ? 0 : h)] });
    }
  }
  const paths = (ir.paths ?? []).filter((p) => p.box).map((p) => ({ id: p.id, kind: 'path', rect: [p.box.minX, p.box.minZ, p.box.maxX, p.box.maxZ] }));
  const ways = [];
  for (const p of ir.parts ?? []) {
    if (p.set !== 'path') continue;
    const cells = new Set();
    for (const op of p.ops ?? []) {
      if (op.op === 'columns' && Array.isArray(op.cols)) for (let i = 0; i + 4 < op.cols.length; i += 5) cells.add(`${op.cols[i]},${op.cols[i + 1]}`);
      else if (op.bounds) ways.push({ id: p.id, kind: 'way', rect: [op.bounds.minX, op.bounds.minZ, op.bounds.maxX, op.bounds.maxZ] });
    }
    // row runs (z, then x), deterministic
    const byZ = new Map();
    for (const k of cells) { const [x, z] = k.split(',').map(Number); if (!byZ.has(z)) byZ.set(z, []); byZ.get(z).push(x); }
    for (const z of [...byZ.keys()].sort((a, b) => a - b)) {
      const xs = byZ.get(z).sort((a, b) => a - b);
      let s = xs[0], e = xs[0];
      for (let i = 1; i <= xs.length; i++) {
        if (i < xs.length && xs[i] === e + 1) { e = xs[i]; continue; }
        ways.push({ id: p.id, kind: 'way', rect: [s, z, e, z] });
        if (i < xs.length) { s = xs[i]; e = xs[i]; }
      }
    }
  }
  return { lots, roads, paths, ways };
}

/**
 * The seam rule: null when the new claim may stand beside the standing one, else the reason (the existing OVERLAP refusal's message,
 * naming the seam). `standingClaim` and `claim`: [x0, z0, x1, z1].
 */
export function seamProblem(standingClaim, ir, claim, { seamMax = SEAM_MAX } = {}) {
  const ix0 = Math.max(standingClaim[0], claim[0]), iz0 = Math.max(standingClaim[1], claim[1]);
  const ix1 = Math.min(standingClaim[2], claim[2]), iz1 = Math.min(standingClaim[3], claim[3]);
  if (ix0 > ix1 || iz0 > iz1) return null;
  const deep = Math.min(ix1 - ix0 + 1, iz1 - iz0 + 1);
  if (deep > seamMax) return `the claim overlaps the standing region's ${deep} columns deep (the seam [${ix0}, ${iz0}, ${ix1}, ${iz1}]; at most ${seamMax})`;
  const f = standingFootprint(ir);
  for (const x of [...f.lots, ...f.roads, ...f.paths, ...f.ways]) {
    if (meets(x.rect, claim)) return `the seam [${ix0}, ${iz0}, ${ix1}, ${iz1}] meets the standing region's ${x.kind} ${x.id} at [${x.rect.join(', ')}]`;
  }
  return null;
}

/**
 * The `beside` data for a plan over `claim` next to a standing region (`id`, its claim, its IR): its lot boxes and footprint rects
 * within SEAM_MAX + 8 of the claim (obstacles), and its graph (the join's ports).
 */
export function besideData(id, standingClaim, ir, claim) {
  const f = standingFootprint(ir);
  const near = grow(claim, SEAM_MAX + 8);
  const lots = f.lots.filter((x) => meets(x.rect, near)).map((x) => x.rect);
  const keep = [...f.roads, ...f.paths, ...f.ways].filter((x) => meets(x.rect, near)).map((x) => x.rect);
  return { id, claim: [...standingClaim], lots, keep, graph: { nodes: ir.graph?.nodes ?? [], edges: ir.graph?.edges ?? [] } };
}

// ------------------------------------------------------------------ (6c D3) the standing data the reach step reads

/** (6c D3) A block state's light level as the lamps write them (lantern 15, soul lantern 10, torch 14, soul torch 10, glowstone and the like 15), else 0. */
export function lightLevelOf(state) {
  const id = String(state ?? '').replace(/\[.*$/, '');
  if (/soul_(lantern|torch|campfire)$/.test(id)) return 10;
  if (/(^|:)(lantern|glowstone|sea_lantern|shroomlight|jack_o_lantern|beacon|ochre_froglight|verdant_froglight|pearlescent_froglight|campfire|redstone_lamp)$/.test(id)) return 15;
  if (/(^|:)(torch|wall_torch|end_rod)$/.test(id)) return id.endsWith('end_rod') ? 14 : 14;
  return 0;
}

/** (6c D3) A road id or graph edge path that names a street (§3.1): the `street_` stem after any prefix, or a following street (`st_<d>`). */
export const isStreetId = (id) => typeof id === 'string' && (/(^|_)street_/.test(id) || /^(route_)?st_/.test(id));

/** Row runs [x0, z, x1, z] of a set of "x,z" keys (z, then x), deterministic. */
export function keyRuns(keys) {
  const byZ = new Map();
  for (const k of keys) { const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); if (!byZ.has(z)) byZ.set(z, []); byZ.get(z).push(x); }
  const out = [];
  for (const z of [...byZ.keys()].sort((a, b) => a - b)) {
    const xs = byZ.get(z).sort((a, b) => a - b);
    let s = xs[0], e = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === e) continue;
      if (i < xs.length && xs[i] === e + 1) { e = xs[i]; continue; }
      out.push([s, z, e, z]);
      if (i < xs.length) { s = xs[i]; e = xs[i]; }
    }
  }
  return out;
}

/** The "x,z" keys of row runs [x0, z, x1, z] (rects too: every row of [x0, z0, x1, z1]). */
export function runKeys(runs, into = new Set()) {
  for (const q of runs ?? []) for (let z = q[1]; z <= q[3]; z++) for (let x = q[0]; x <= q[2]; x++) into.add(`${x},${z}`);
  return into;
}

/**
 * (6c D3, §2.4, the coordinator's deviation of 2026-10-23) `besideReach.standing`: what the reach step reads of a standing region beyond
 * ctx.beside (which stays clipped to SEAM_MAX + 8 and byte-identical): its whole-claim footprint (standingFootprint's lots and keep
 * rects, unclipped), its streets (road items whose ext carries `architect_mc:street` or whose id has the `street_` stem: id, width,
 * points, flagged), its bodies' hard and watch columns (KC §2: cells, ice, shell, lining, grate, spill, decor; watch) as row runs, its
 * lamp spots (the props' lamp parts' columns, the apron lamps, and every spot the 4e lanterns of its roads may take, both sides: N-D3-2
 * and the verge contact), its props' columns (a T's verge contact is never one), and its own walls' columns (`walls`, only when it has a
 * wall). The mod's BesideReach.standing is the same.
 */
export function besideStanding(id, standingClaim, ir) {
  const f = standingFootprint(ir);
  const streets = [];
  for (const r of ir.roads ?? []) {
    const flagged = !!r.ext?.['architect_mc:street'];
    if (!flagged && !isStreetId(r.id)) continue;
    streets.push({ id: r.id, width: r.width ?? 3, points: r.points.map((p) => [p[0], p[1], p[2]]), flagged });
  }
  // the bodies: every fluid op's hard sets and watch set, as columns
  const hard = new Set(), watch = new Set();
  // (a fluid op's sets are column runs [x, z, y0, y1]: fluids/body.mjs toRuns; a plan join is {body, cells})
  const runCells = (runs, into) => { for (const q of runs ?? []) if (Array.isArray(q) && q.length === 4) into.add(`${q[0]},${q[1]}`); };
  const list = [];
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) {
    if (o.op !== 'fluid') continue;
    const bh = new Set(), bw = new Set();
    for (const k of ['cells', 'ice', 'shell', 'lining', 'grate', 'spill', 'decor']) runCells(o[k], bh);
    runCells((o.joins ?? []).filter((j) => Array.isArray(j)), bh);
    runCells(o.watch, bw);
    for (const k of bh) hard.add(k);
    for (const k of bw) watch.add(k);
    list.push({ id: o.id, hard: keyRuns(bh), watch: keyRuns(bw) });
  }
  // the lamps and props: a props part's columns (the lamp, the bench, the well), the apron lamps (props_apron), the 4e lanterns' spots
  const lamps = new Set(), props = new Set();
  const opCols = (op, into) => {
    if (op.op === 'columns' && Array.isArray(op.cols)) for (let i = 0; i + 4 < op.cols.length; i += 5) into.add(`${op.cols[i]},${op.cols[i + 1]}`);
    else if (op.bounds) for (let z = op.bounds.minZ; z <= op.bounds.maxZ; z++) for (let x = op.bounds.minX; x <= op.bounds.maxX; x++) into.add(`${x},${z}`);
  };
  // (the lights of its lamp parts: every light block they write, [x, y, z, level], for the join's lamps to count; the kit's light levels)
  const lights = new Map();
  for (const p of ir.parts ?? []) {
    if (!/^props(_|$)/.test(p.id)) continue;
    for (const op of p.ops ?? []) {
      opCols(op, props);
      if (!/lamp|apron/.test(p.id)) continue;
      opCols(op, lamps);
      if (op.op !== 'columns' || !Array.isArray(op.cols) || !Array.isArray(op.materials)) continue;
      for (let i = 0; i + 4 < op.cols.length; i += 5) {
        const lv = lightLevelOf(op.materials[op.cols[i + 4]]);
        if (lv > 0) lights.set(`${op.cols[i]},${op.cols[i + 3]},${op.cols[i + 1]}`, [op.cols[i], op.cols[i + 3], op.cols[i + 1], lv]);
      }
    }
  }
  // ((the RC's finding 2) its own walls: the columns of its K1 wall parts (wall.mjs's `w_<id>` parts, gates included), for NO_JOIN [wall]
  // as another owner's wall answers it)
  const walls = new Set();
  for (const p of ir.parts ?? []) if (/^w_/.test(p.id)) for (const op of p.ops ?? []) opCols(op, walls);
  for (const r of ir.roads ?? []) {
    if (!r.lanterns) continue;
    // RoadPlan's lanterns (light.mjs roadLights, the model the light cover uses): the first `first` out, then every `every`, beside the
    // walkway (|v| = half + 1), the right of travel first; both sides are listed (the world decides which one holds it)
    const pts = r.points.map((q) => [q[0], q[2]]);
    const { cells } = centreCells(pts);
    const offs = crossOffsets(r.width ?? 3);
    const hi = offs[offs.length - 1], lo = offs[0];
    const every = r.lamp ? r.lamp.every : 12, first = r.lamp ? r.lamp.first : 6;
    let since = every - first;
    for (let i = 1; i < cells.length - 1; i++) {
      since += 1;
      if (since + 1e-9 < every) continue;
      const c = cells[i], n = cells[i + 1];
      const dx = Math.sign(n.x - c.x), dz = Math.sign(n.z - c.z);
      for (const side of [hi + 1, lo - 1]) lamps.add(`${c.x - side * dz},${c.z + side * dx}`);
      since = 0;
    }
  }
  return {
    id, claim: [...standingClaim],
    footprint: { lots: f.lots.map((x) => [...x.rect]), keep: [...f.roads, ...f.paths, ...f.ways].map((x) => ({ kind: x.kind, id: x.id, rect: [...x.rect] })) },
    streets, bodies: { hard: keyRuns(hard), watch: keyRuns(watch), list }, lamps: keyRuns(lamps), props: keyRuns(props),
    lights: [...lights.values()].sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]),
    ...(walls.size ? { walls: keyRuns(walls) } : {}), // (only a walled region carries it: an unwalled region's standing data is unchanged)
  };
}
