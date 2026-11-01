// (7a K1a) The gate move of the route pass (docs/CONTRACT.md "Phase 7a slice K1" §4): wall cells are obstacles to every route,
// which crosses a wall only by this move: straight, on a cardinal heading, perpendicular to a straight run of the wall, through
// the wall's whole depth, the route's footprint plus a jamb on each side inside that one run. Through an open gate (an earlier
// edge's, a gate placed `at` an endpoint, or an existing network's crossing) it costs its cells; opening a new one costs
// COST_GATE more while the wall's gates.max allows it (sealed walls: 0). The surface holds the route's y through the gate.
// Under the realise lint (integer math; Math.floor/abs/min/max only).

/** The extra cost of opening a gate: 60 cells (a straight cell is 10), so a short walk round an open wall's end wins. */
export const COST_GATE = 600;
/** The longest gate move (cells): the approach clearances on both sides plus the wall's depth. */
const MAX_MOVE = 16;
const DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
/** (7a K3) A passage move's `arg`: PASSAGE_ARG + the passage's index (a gate move's arg is its depth, at most MAX_MOVE). */
export const PASSAGE_ARG = 200;
const FACING4 = { east: [1, 0], south: [0, 1], west: [-1, 0], north: [0, -1] };

/**
 * The pass-level state from `intent.walls` ([{id, max, cells: [[x, z, axis]], open: [[x, z, y?]], opened}]: `axis` 1 a run along x,
 * 2 along z, 3 a corner or bend; `open` the cells already open (with their walk surface's y when it is set), `opened` the gates
 * already counted against `max`). Null without walls.
 */
export function gateInit(env, intent) {
  const walls = Array.isArray(intent.walls) ? intent.walls.filter((w) => w && Array.isArray(w.cells) && w.cells.length) : [];
  if (!walls.length) return null;
  const { W, D, r, minX, minZ } = env;
  const n = W * D;
  const wid = new Int16Array(n).fill(-1), axis = new Uint8Array(n), open = new Uint8Array(n), openY = new Int16Array(n).fill(-32768);
  const at = (x, z) => {
    const i = Math.floor((x - minX) / r), j = Math.floor((z - minZ) / r);
    return i < 0 || j < 0 || i >= W || j >= D ? -1 : i + j * W;
  };
  walls.forEach((w, wi) => {
    for (const c of w.cells) { const k = at(c[0], c[1]); if (k >= 0) { wid[k] = wi; axis[k] = c[2] ?? 3; } }
    // an open cell's walk surface y (a gate placed at an endpoint, an existing network's crossing): a route through it holds that y
    for (const c of w.open ?? []) { const k = at(c[0], c[1]); if (k >= 0) { open[k] = 1; if (Number.isInteger(c[2])) openY[k] = c[2]; } }
  });
  const mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (wid[k] >= 0) mask[k] = 1;
  // ((7a K3, §4) the walls' passages (a gatehouse's, through its box): each port cell, its entering heading and the other port; only when a
  // wall has one, so every other pass is K1a's byte for byte)
  const passages = [];
  walls.forEach((w, wi) => {
    for (const q of w.passages ?? []) {
      const f = FACING4[q.facing];
      const kf = at(q.front[0], q.front[2]), kb = at(q.back[0], q.back[2]);
      if (!f || kf < 0 || kb < 0) continue;
      passages.push({ wall: wi, lot: q.lot, front: q.front, back: q.back, kf, kb, facing: f, n: Math.abs(q.front[0] - q.back[0]) + Math.abs(q.front[2] - q.back[2]) });
    }
  });
  return { walls: walls.map((w) => ({ id: w.id, max: Number.isInteger(w.max) ? w.max : 16, opened: Number.isInteger(w.opened) ? w.opened : 0, inside: Array.isArray(w.inside) ? w.inside : null, open: (w.open ?? []).length + (w.passages?.length ?? 0) })), wid, axis, open, openY, mask, gates: [], ...(passages.length ? { passages, portAt: new Map(passages.flatMap((p, i) => [[p.kf, i], [p.kb, i]])) } : {}) };
}

/**
 * Before an edge's search: a closed wall between its ends that can never open a gate (sealed, or at its gates.max with none open)
 * leaves no route; the note names it. `from`, `to`: the ends' feet [x, y, z].
 */
export function gatePrune(state, from, to) {
  for (const w of state.walls) {
    if (!w.inside || w.open > 0 || w.opened < w.max) continue;
    const [x0, z0, x1, z1] = w.inside;
    const isIn = (p) => p[0] > x0 && p[0] < x1 && p[2] > z0 && p[2] < z1;
    if (isIn(from) !== isIn(to)) return `wall ${w.id} stands between its ends with no gate (${w.max ? 'at its gates.max' : 'sealed'})`;
  }
  return null;
}

/** Every edge searches with the gate move when the pass has walls. */
export function gateActive(state) {
  return !!state;
}

/**
 * Expand the gate move from a state (S: {i, j, k, h, y, q, W, D, inS, free, dOf, builtY, latLo, latHi, relax}). `free(k)`: the
 * cell is clear of every obstacle but the walls (the corridor included). Relaxes at most one candidate: the cell just past the wall
 * on the current cardinal heading.
 */
export function gateExpand(state, S) {
  const { h } = S;
  if (h & 1) return; // cardinal headings only
  // ((7a K3, §4) the passage move: from a port cell, heading into the box at the port's floor, to the other port (an open gate, its
  // cells' cost; it writes nothing in the box: a `passage` segment)
  if (state.passages && state.portAt.has(S.k)) {
    const pi = state.portAt.get(S.k), p = state.passages[pi];
    const fromFront = S.k === p.kf, port = fromFront ? p.front : p.back, to = fromFront ? p.kb : p.kf;
    const hd = fromFront ? [-p.facing[0], -p.facing[1]] : p.facing;
    const di = DIRS4[h >> 1][0], dj = DIRS4[h >> 1][1];
    if (di === hd[0] && dj === hd[1] && S.y === port[1] - 1 && S.inS(to) && S.free(to) && S.dOf(S.y, to) >= 0) S.relax(to, h, 3, S.y * 16, 10 * p.n, PASSAGE_ARG + pi);
  }
  const hc = h >> 1, di = DIRS4[hc][0], dj = DIRS4[hc][1];
  // the wall's run is perpendicular to the heading: heading along x crosses a run along z (axis 2), and the reverse
  const want = di !== 0 ? 2 : 1;
  const li = -dj, lj = di; // the lateral unit
  const { W, D, i, j, y, latLo, latHi } = S;
  let wall = -1, inWall = false, crossed = false, depth = 0, newCells = 0;
  const opening = [];
  for (let t = 1; t <= MAX_MOVE; t++) {
    const ci = i + di * t, cj = j + dj * t;
    if (ci < 0 || cj < 0 || ci >= W || cj >= D) return;
    const ck = ci + cj * W;
    // the footprint row at t: wall cells, all of one wall's straight run, with a jamb of that run on both sides
    let rowWall = 0;
    for (let v = latLo; v <= latHi; v++) {
      const ai = ci + li * v, aj = cj + lj * v;
      if (ai < 0 || aj < 0 || ai >= W || aj >= D) return;
      const ak = ai + aj * W;
      if (state.wid[ak] < 0) continue;
      if (wall < 0) wall = state.wid[ak];
      if (state.wid[ak] !== wall || state.axis[ak] !== want) return;
      rowWall++;
      opening.push(ak);
      if (!state.open[ak]) newCells++;
      else if (state.openY[ak] !== -32768 && state.openY[ak] !== y) return; // an open gate's surface is at its own y
    }
    if (rowWall) {
      if (crossed || rowWall !== latHi - latLo + 1) return; // a second band, or a footprint half in the wall
      for (const v of [latLo - 1, latHi + 1]) {
        const ai = ci + li * v, aj = cj + lj * v;
        if (ai < 0 || aj < 0 || ai >= W || aj >= D) return;
        const ak = ai + aj * W;
        if (state.wid[ak] !== wall || state.axis[ak] !== want) return;
      }
      inWall = true;
      depth++;
    } else if (inWall) { inWall = false; crossed = true; }
    // the centre's own column: clear of everything but the wall, and the surface within the cut and fill at y (an earlier edge's
    // cell through this gate is at its own y)
    const b = S.builtY[ck];
    if (b !== -32768 && b !== y) return;
    if (!S.free(ck) || S.dOf(y, ck) < 0) return;
    if (crossed && S.inS(ck)) {
      const w = state.walls[wall];
      const isNew = newCells > 0;
      if (isNew && w.opened >= w.max) return; // sealed, or at gates.max
      S.relax(ck, h, 3, y * 16, 10 * t + (isNew ? COST_GATE : 0), depth);
      return;
    }
  }
}

/** The path cells of a gate move (after its start cell): straight at the start's y. */
export function gateCells(state, m) {
  const out = [];
  for (let t = 1; t <= m.n; t++) out.push([m.x0 + m.dx * t, m.y0, m.z0 + m.dz * t]);
  // ((7a K3) a passage move: its segment is the passage's (kind passage, its lot), its cells the box's centre line at the floor)
  if (state.passages && m.arg >= PASSAGE_ARG) { const p = state.passages[m.arg - PASSAGE_ARG]; return { cells: out, data: { kind: 'passage', lot: p.lot, wall: state.walls[p.wall].id } }; }
  return { cells: out, data: { wall: null } };
}

/**
 * After an edge routes: the gates its moves crossed are open for the later edges (a new one counts against its wall's max), and
 * the edge records them (`gates: [{wall, at: [x, y, z], heading: [dx, dz], width, depth, new}]`).
 */
export function gateCommit(state, env, edgeOut, moves, lat) {
  const { W, r, minX, minZ } = env;
  const gates = [];
  const passed = [];
  for (const mv of moves) {
    if (mv.code !== 5) continue;
    // ((7a K3) a passage move: recorded, nothing opened)
    if (state.passages && mv.arg >= PASSAGE_ARG) { const p = state.passages[mv.arg - PASSAGE_ARG]; passed.push({ wall: state.walls[p.wall].id, lot: p.lot }); continue; }
    const di = mv.dx, dj = mv.dz, li = -dj, lj = di;
    let wall = -1, isNew = false, mid = null;
    const cells = [];
    for (let t = 1; t <= mv.n; t++) {
      const ci = mv.i0 + di * t, cj = mv.j0 + dj * t;
      for (let v = lat.lo; v <= lat.hi; v++) {
        const ak = ci + li * v + (cj + lj * v) * W;
        if (state.wid[ak] < 0) continue;
        wall = state.wid[ak];
        if (!state.open[ak]) isNew = true;
        cells.push(ak);
        if (v === 0 && !mid) mid = [minX + (ci) * r, mv.y0, minZ + (cj) * r];
      }
    }
    if (wall < 0) continue;
    for (const ak of cells) { state.open[ak] = 1; if (state.openY[ak] === -32768) state.openY[ak] = mv.y0; }
    if (isNew) state.walls[wall].opened++;
    gates.push({ wall: state.walls[wall].id, at: mid, heading: [di, dj], width: lat.hi - lat.lo + 1, depth: mv.arg, new: isNew, cells: cells.map((ak) => [minX + (ak % W) * r, minZ + Math.floor(ak / W) * r]) });
  }
  edgeOut.gates = gates;
  if (passed.length) edgeOut.passages = passed;
}
