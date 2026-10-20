// (6c KC) The footprint registry (docs/CONTRACT.md "Phase 6c slice KC" §2, §3): a body's cells are its own. One record per body (or,
// before it emits, per H part), filled in two steps:
//   at resolve (compile step 2)  each level H part (pond, fountain, waterfall, moat, quay, ditch) reserves its footprint: the columns
//                                its generator's `footprint(res)` names (its resolved rect grown by its shell, a fountain's apron, a
//                                waterfall's pool, curtain and basin, a moat's ring, a quay's basin) over a y-span round its ground
//   at emit                      the part's bodies replace the reservation with their exact sets: `hard` = cells, ice, shell, lining
//                                (the weir rides in it), grate, spill and plan joins; `watch` = the op's watch. Courses (routed at
//                                emit, after the walls: HY-c's crossings) and farm ponds (sited after the walls) register here only.
// Read through keptBy(store, x, y, z) (3D) and keptColumns(store) (the 2.5D grids). The store rides the region's checkpoint/rollback
// (compile.mjs), and compile.mjs releases a part's records when it rolls back or is refused, so a body that fails frees its footprint.
// Pure; no module here imports compile.mjs or program.mjs.

const k3 = (x, y, z) => `${x},${y},${z}`;
const k2 = (x, z) => `${x},${z}`;

/** The registry (compile.mjs makes one per check: K.keep and r._keep are the same array of records). */
export function keepStore(X) {
  if (!X) return [];
  if (!Array.isArray(X.keep)) X.keep = [];
  return X.keep;
}

/**
 * Reserve a part's footprint at resolve: `rects` [[x0, z0, x1, z1]] (inclusive), over y0..y1; `body` the id its (first) body will
 * take, for a refusal's evidence. Replaces any earlier reservation of the part. Returns the record.
 */
export function reserve(store, { part, body = null, rects, y0, y1 }) {
  release(store, part, 'reserved');
  const cols = new Set();
  for (const [x0, z0, x1, z1] of rects ?? []) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cols.add(k2(x, z));
  if (!cols.size) return null;
  const rec = Object.freeze({ kind: 'reserved', part, body, cols, y0, y1 });
  store.push(rec);
  return rec;
}

/**
 * Register an emitted body (r.fluidBody's record, or the IR op's sets): its exact hard and watch sets replace its part's reservation.
 * `b`: {id, part, cells, ice, shell, lining, weir, grate, spill, watch, planJoins | joins, decor ((6c F3-c) the coral: body and bed
 * cells, already in cells and shell)}. Returns the record.
 */
export function registerBody(store, b, part = b.part ?? null) {
  release(store, part, 'reserved');
  const hard = new Map();
  const add = (set, list) => { for (const c of list ?? []) { if (!Array.isArray(c) || c.length < 3) continue; const k = k3(c[0], c[1], c[2]); if (!hard.has(k)) hard.set(k, set); } };
  for (const s of ['cells', 'ice', 'shell', 'lining', 'weir', 'grate', 'spill', 'decor']) add(s, b[s]);
  for (const j of b.joins ?? []) if (j && !Array.isArray(j) && Array.isArray(j.cells)) add('joins', j.cells);
  for (const j of b.planJoins ?? []) add('joins', j.cells);
  const watch = new Set();
  for (const c of b.watch ?? []) { const k = k3(c[0], c[1], c[2]); if (!hard.has(k)) watch.add(k); }
  const cols = new Map();
  for (const k of hard.keys()) { const [x, , z] = k.split(','); cols.set(`${x},${z}`, 'hard'); }
  const rec = Object.freeze({ kind: 'body', part, body: b.id, hard, watch, cols });
  store.push(rec);
  return rec;
}

/** Drop every record of `part` (of `kind` only, when given). Returns how many. */
export function release(store, part, kind = null) {
  if (!Array.isArray(store) || part === undefined) return 0;
  const before = store.length;
  for (let i = store.length - 1; i >= 0; i--) if (store[i].part === part && (!kind || store[i].kind === kind)) store.splice(i, 1);
  return before - store.length;
}

/**
 * Who keeps cell (x, y, z): {body, part, set} (set: a hard set's name, 'watch', or 'reserved'), or null. `watch: false` leaves the
 * watch sets out (a writer that may stand there: none today; the checker is strict, S-KC-2).
 */
export function keptBy(store, x, y, z, { watch = true } = {}) {
  if (!Array.isArray(store) || !store.length) return null;
  const k = k3(x, y, z), c = k2(x, z);
  for (const r of store) {
    if (r.kind === 'reserved') { if (r.cols.has(c) && y >= r.y0 && y <= r.y1) return { body: r.body, part: r.part, set: 'reserved' }; continue; }
    const s = r.hard.get(k);
    if (s) return { body: r.body, part: r.part, set: s };
    if (watch && r.watch.has(k)) return { body: r.body, part: r.part, set: 'watch' };
  }
  return null;
}

/** Every kept column [[x, z, body | part]] (reservations and bodies' hard sets; the 2.5D grids: walls, routes, rope landings). */
export function keptColumns(store) {
  const out = [];
  const seen = new Set();
  for (const r of store ?? []) for (const c of r.cols.keys ? r.cols.keys() : r.cols) {
    if (seen.has(c)) continue;
    seen.add(c);
    const [x, z] = c.split(',').map(Number);
    out.push([x, z, r.body ?? r.part]);
  }
  return out;
}

/** Whether column (x, z) is kept (a 2.5D read): {body, part} or null. */
export function keptColumn(store, x, z) {
  const c = k2(x, z);
  for (const r of store ?? []) if (r.kind === 'reserved' ? r.cols.has(c) : r.cols.has(c)) return { body: r.body, part: r.part };
  return null;
}

/** Whether a body's watch holds cell (x, y, z) (any record): {body, part} or null. */
export function watchedBy(store, x, y, z) {
  const k = k3(x, y, z);
  for (const r of store ?? []) if (r.kind === 'body' && r.watch.has(k)) return { body: r.body, part: r.part };
  return null;
}

/** The y-span a reservation covers over `rects` (the ground under them, 6 below to 12 above: a raised fountain's spout, a waterfall's pool). */
export function spanOf(S, rects) {
  let lo = Infinity, hi = -Infinity;
  for (const [x0, z0, x1, z1] of rects ?? []) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const g = S.groundAt(x, z); if (g < lo) lo = g; if (g > hi) hi = g; }
  return Number.isFinite(lo) ? { y0: lo - 6, y1: hi + 12 } : { y0: 0, y1: -1 };
}
