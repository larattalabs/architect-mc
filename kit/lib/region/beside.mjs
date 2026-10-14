// (6c D1) A district beside a standing region (docs/CONTRACT.md "Phase 6c slice D" §3): the standing region's footprint from its IR,
// the seam rule (the new claim may overlap the standing one only in a seam of at most SEAM_MAX columns, and never over its lots,
// roads or paths), and the `beside` data a plan reads (ctx.beside). The mod's RegionsImpl applies the same rule in Java
// (BesideCheck); this module is the reference the kit tests and the gate use.

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
