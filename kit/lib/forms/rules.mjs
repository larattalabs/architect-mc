// Generator rules (docs/CONTRACT.md 6c F1 §2; SETTLEMENTS §9.1), for every natural-form generator now and in F3. Plan time only.
//
// - One bounded op per cluster (a spike cluster, a spire segment with its ledges), at most MAX_PRIMITIVES (32) primitive shapes per
//   op, so the evaluator's per-op bounds cull (it evaluates an op's whole shape tree per cell in its bounds).
// - Bake past a cost threshold: a form whose op count would exceed BAKE_OPS (400, an estimate confirmed by gate item 6) is emitted
//   as one `voxels` op over an ARVB side blob instead. A bake is the ops' cells last-op-wins with air dropped, so a baked form keeps
//   no air writes and no per-op conds: the voxels op carries one cond (IF_NATURAL by default; a form never overwrites built blocks).
// - Absolute y: skeletons are resolved at plan time; bases reach SKIRT (6) below the plan ground, so drift up to 6 is absorbed.
// - Species params: each generator ships presets; a bible may name others within the generator's param schema.
import { evalTile, primitiveCount, walkKinds } from '../realise.mjs';
import { shapeBounds } from '../sdf.mjs';
import { makeColumns, unpack } from '../region/pack.mjs';
import { encodeVoxels } from '../region/voxels.mjs';

export const MAX_PRIMITIVES = 32;
export const BAKE_OPS = 400;
export const SKIRT = 6;
const AIR = 'minecraft:air';

/** Primitive shapes in one op (a columns or voxels op counts 1: it is one bounded list). */
export function opPrimitives(op) {
  return op.op === 'shape' ? primitiveCount(op.shape) : 1;
}

/** The rule violations of a generator result `{ops}`: ops over MAX_PRIMITIVES (as [index, count]). */
export function ruleViolations(gen) {
  const over = [];
  gen.ops.forEach((o, i) => { const n = opPrimitives(o); if (n > MAX_PRIMITIVES) over.push([i, n]); });
  return { over, ops: gen.ops.length, needsBake: gen.ops.length > BAKE_OPS };
}

/** World bounds of ops (shape and columns ops with absolute y only). */
export function opsBounds(ops) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const o of ops) {
    let b;
    if (o.op === 'shape') b = shapeBounds(o.shape);
    else if (o.op === 'columns') {
      const fy = o.from?.abs, ty = o.to?.abs;
      if (!Number.isFinite(fy) || !Number.isFinite(ty)) throw new Error('forms: a columns op needs absolute from/to');
      b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity };
      for (let i = 0; i < o.cols.length; i += 5) {
        b.minX = Math.min(b.minX, o.cols[i]); b.maxX = Math.max(b.maxX, o.cols[i]); b.minZ = Math.min(b.minZ, o.cols[i + 1]); b.maxZ = Math.max(b.maxZ, o.cols[i + 1]);
        b.minY = Math.min(b.minY, fy + o.cols[i + 2]); b.maxY = Math.max(b.maxY, ty + o.cols[i + 3]);
      }
    } else throw new Error(`forms: cannot bound a ${o.op} op`);
    if (b.minY === null || b.maxY === null) throw new Error('forms: a form op needs an absolute y extent');
    minX = Math.min(minX, Math.floor(b.minX)); maxX = Math.max(maxX, Math.ceil(b.maxX)); minZ = Math.min(minZ, Math.floor(b.minZ)); maxZ = Math.max(maxZ, Math.ceil(b.maxZ));
    minY = Math.min(minY, Math.floor(b.minY)); maxY = Math.max(maxY, Math.ceil(b.maxY));
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * The cells of resolved ops (block states or material rules with block states; absolute y), evaluated by the kit's own
 * evaluator over a flat dummy ground: `Map("x,y,z" -> state)` last-op-wins, air included (a carve or trim). Plan time.
 */
export function formCells(ops, { ground = -4096 } = {}) {
  const b = opsBounds(ops);
  const ir = { format: 2, id: 'form_bake', kitVersion: '0.0.0', claim: { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, minY: b.minY, maxY: b.maxY },
    stages: ['s'], parts: [{ id: 'f', stage: 's', set: 'terrain', ops: ops.map((o) => ({ ...o, cond: o.cond ?? 0, walk: !!o.walk })) }] };
  ir.requires = walkKinds(ir);
  const out = new Map();
  for (let tx = Math.floor(b.minX / 64); tx <= Math.floor(b.maxX / 64); tx++) {
    for (let tz = Math.floor(b.minZ / 64); tz <= Math.floor(b.maxZ / 64); tz++) {
      const w = makeColumns(tx * 64 - 8, tz * 64 - 8, 80, 80, 1);
      w.ground.fill(ground); w.height.fill(ground); w.floor.fill(ground);
      const e = evalTile(ir, `${tx},${tz}`, w);
      for (const c of unpack(e.payload).cells) out.set(`${c.x},${c.y},${c.z}`, c.state);
    }
  }
  return { cells: out, bounds: b };
}

/**
 * Bake resolved ops into one `voxels` op: `{op, bytes, cells, bounds}` (op `{op: 'voxels', blob, origin, rotation: 0, cond, walk:
 * false}`; `blob` is the caller's side blob name). Air cells are dropped.
 */
export function bakeOps(ops, blob, { cond = 0 } = {}) {
  const { cells } = formCells(ops);
  const list = [];
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [k, st] of cells) {
    if (st === AIR) continue;
    const [x, y, z] = k.split(',').map(Number);
    list.push([x, y, z, st]);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  if (!list.length) throw new Error('bake: the form has no cells');
  const bytes = encodeVoxels([maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1], list.map(([x, y, z, s]) => [x - minX, y - minY, z - minZ, s]));
  return { op: { op: 'voxels', blob, origin: [minX, minY, minZ], rotation: 0, cond, walk: false }, bytes, cells: list.length, bounds: { minX, maxX, minY, maxY, minZ, maxZ } };
}

/**
 * Face-connected components of a cell set (Map "x,y,z" -> state, non-air only) and which touch the ground (a cell at or below
 * `groundAt(x, z)`). Returns the keys of the cells in no ground-touching component (to trim).
 */
export function unsupported(cells, groundAt) {
  const solid = new Set();
  for (const [k, s] of cells) if (s !== AIR) solid.add(k);
  const seen = new Set();
  const trim = [];
  for (const k0 of [...solid].sort()) {
    if (seen.has(k0)) continue;
    const comp = [k0];
    seen.add(k0);
    let grounded = false;
    for (let i = 0; i < comp.length; i++) {
      const [x, y, z] = comp[i].split(',').map(Number);
      if (y <= groundAt(x, z)) grounded = true;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = `${x + dx},${y + dy},${z + dz}`;
        if (solid.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); }
      }
    }
    if (!grounded) trim.push(...comp);
  }
  return trim.sort();
}

/** A trim op (air, IF_AIR_OR_FLUID: it only cancels the form's own earlier writes in the evaluator's last-op-wins buffer). */
export function trimOp(keys) {
  const cols = [];
  for (const k of keys) { const [x, y, z] = k.split(',').map(Number); cols.push(x, z, y, y, 0); }
  return { op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: [null], cond: 2, walk: false };
}

/**
 * The largest overhang of a cell set: per non-air cell with a non-solid cell below, the horizontal (Chebyshev) distance to the
 * nearest non-air cell of the set (or ground at or under `groundAt`) one layer down, capped at `cap`. Returns
 * `{max, over: [[x, y, z, d], ...] (d > limit)}`.
 */
export function overhangs(cells, groundAt, { limit = 4, cap = 8 } = {}) {
  const solid = new Set();
  for (const [k, s] of cells) if (s !== AIR) solid.add(k);
  const has = (x, y, z) => solid.has(`${x},${y},${z}`) || y <= groundAt(x, z);
  let max = 0;
  const over = [];
  for (const k of [...solid].sort()) {
    const [x, y, z] = k.split(',').map(Number);
    if (has(x, y - 1, z)) continue;
    let d = cap + 1;
    for (let r = 1; r <= cap && d > cap; r++) {
      for (let dx = -r; dx <= r && d > cap; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (has(x + dx, y - 1, z + dz)) { d = r; break; }
      }
    }
    if (d > max) max = d;
    if (d > limit) over.push([x, y, z, d]);
  }
  return { max, over };
}

/**
 * Settle a form at plan time (M3): evaluate its ops, cancel cells in no ground-touching component (a trim op), and give every cell
 * that overhangs the layer under it by more than `limit` a support: a `capsuleChain` at 45 degrees or steeper down to the nearest
 * cell of the form that reaches it (else straight down to the ground), as its own op, in `material`. Up to `rounds` passes.
 * Returns `{ops, trimmed, supports, overhang: {max, over}}` (the final measure).
 */
export function settleForm(ops, groundAt, { material = 'minecraft:stone', limit = 4, rounds = 3, cond = 0 } = {}) {
  let out = [...ops];
  let trimmed = 0, supports = 0, last = null;
  for (let round = 0; round <= rounds; round++) {
    const { cells } = formCells(out);
    const trim = unsupported(cells, groundAt);
    if (trim.length) {
      out.push(trimOp(trim));
      trimmed += trim.length;
      for (const k of trim) cells.set(k, AIR);
    }
    last = overhangs(cells, groundAt, { limit });
    if (!last.over.length || round === rounds) break;
    const solid = [];
    for (const [k, s] of cells) if (s !== AIR) { const [x, y, z] = k.split(',').map(Number); solid.push([x, y, z]); }
    const done = new Set();
    for (const [x, y, z] of last.over) {
      if (done.has(`${x},${z}`)) continue;
      let best = null;
      for (const [qx, qy, qz] of solid) {
        const dy = y - 1 - qy, dh = Math.max(Math.abs(qx - x), Math.abs(qz - z));
        if (dy < 1 || dh > dy) continue;
        if (!best || dy < best[3] || (dy === best[3] && dh < best[4])) best = [qx, qy, qz, dy, dh];
      }
      const to = best ? [best[0], best[1], best[2]] : [x, groundAt(x, z), z];
      out.push({ op: 'shape', shape: { kind: 'capsuleChain', points: [[x, y - 1, z], to], radii: [1, 1.2] }, material, cond, walk: false });
      supports++;
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) done.add(`${x + dx},${z + dz}`);
    }
  }
  return { ops: out, trimmed, supports, overhang: { max: last.max, over: last.over.length } };
}
