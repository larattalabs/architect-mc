// (6c HY) Water gates (wall.water_gate, docs/CONTRACT.md "Phase 6c slice HY" §8.3, §15): where a course crosses a K1 wall's line or ring,
// the wall stands on a lintel over a still reach and a waterlogged iron grate fills the reach's cells in the wall's thickness. Slice HY-c
// owns this file (and the crossing's use in line.mjs and wall.mjs); it must not import compile.mjs or program.mjs.
//   The crossing record a course registers (hooks.mjs registerCrossing(K, rec)) and a wall reads (crossingsOf(K)):
//     {course: <part id>, body: <reach body id>, wall: <wall part id> | null, cells: [[x, z]] (the still reach's columns the wall's line
//      crosses, at least 2 cells of still reach each side, at most 3 wide), level (the reach's surface), lintel: y (the wall's footing
//      over the open top), grate: [[x, y, z]] (the reach's cells in the wall's thickness: body cells written iron_bars[waterlogged=true]
//      by the course's fluid op `grate`)}
//   waterGates(K, wall) -> [{course, cells, lintel, grate}]   the crossings a wall stands over (counted against gates.max)
//   grateState()                                              the grate block state ('minecraft:iron_bars[waterlogged=true]')
//
// (HY-c, as built) Where the crossing is decided. compile.mjs resolves H parts (step 2) before planWalls, and emits them (step 3) after
// it, before the routes: only a course's emit sees both its reaches and K.walls (registerCrossing takes K for that reason). So:
//   waterGate(K, {course, body, cells, level, outlets?, lining?, spill?})   a course's emit calls it once per reach, BEFORE r.fluidBody: it
//       finds every planned wall whose cells stand over the reach's columns, checks the crossing (below), registers it and returns
//       {grate: [[x, y, z]], crossings: [rec]}: pass `grate` to r.fluidBody's `grate`. It throws `UNREACHABLE: ...` (e.code 'UNREACHABLE',
//       e.evidence {kind: 'wall', wall, why, ...}) when the wall refuses it: the course's emit lets it propagate (compile.mjs answers the
//       part refused UNREACHABLE with the evidence and rolls it back; a rolled-back course's crossing stops counting: waterGates reads
//       only courses that still fit).
//   The checks (§8.3): the wall is not sealed (S-K1-1); a water gate is left under its gates.max (the gates it opened, network, `at`
//   and route gates, plus the standing water gates); the crossing is on a straight run (no corner, no end, no corner tower), at most 3
//   positions wide, the reach under every course of the wall's thickness at each of them, with at least 2 cells of the same reach
//   beyond each face (still water: no outlet, lining or spill of the reach in the wall's columns or those 2 cells: a wall never crosses
//   a step), and clear of the wall's walk gates and their jambs and of another water gate.
//   reachAcross(K, wallId, at, {width, beyond, depth, level?}) -> {cells, columns, level, positions, normal} | {error}: a still reach laid
//       straight across a planned wall at its free straight run nearest `at` (the router's forced still reach for a router that lays the
//       crossing after the walls are planned; HY-c's hand fixture uses it).
// A wall reads the standing crossings (waterGates) when it emits (wall.mjs emitWall: no footing in a crossing's columns, the lintel at
// `lintel` over the grate columns in the gate's frame role, the body above it, never a cell of the course's body, shell or lining).
// (no imports: wall.mjs reads this module, and hooks.mjs -> moat.mjs -> wall.mjs would close a cycle; the store is hooks.mjs's own
// K.courseCrossings, read and written exactly as its crossingsOf and registerCrossing do; the state equals body.mjs GRATE_STATE, a test
// holds them equal)
const GRATE_STATE = 'minecraft:iron_bars[waterlogged=true]';
const crossingsOf = (K) => K?.courseCrossings ?? [];
const registerCrossing = (K, rec) => { (K.courseCrossings ??= []).push(rec); return rec; };

const k2 = (x, z) => `${x},${z}`;

/** The grate's block state (a fixed block, not a role: it must be waterloggable and refuse mobs; the mod joins its bars at write). */
export function grateState() {
  return GRATE_STATE;
}

/** Whether a crossing's course still stands in the plan (fits or adjusted): a course that rolled back keeps no water gate. */
function standing(K, rec) {
  if (typeof K?.okClass === 'function') return K.okClass(rec.course);
  const a = K?.answers?.get?.(rec.course);
  return !a || a.class === 'fits' || a.class === 'adjusted';
}

/** The crossings a wall stands over (its water gates, counted against gates.max): the standing courses' records, in registration order. */
export function waterGates(K, wall) {
  const id = typeof wall === 'string' ? wall : wall?.id;
  return crossingsOf(K).filter((c) => c.wall === id && standing(K, c));
}

/** Every standing water gate of the plan (any wall). */
export function allWaterGates(K) {
  return crossingsOf(K).filter((c) => standing(K, c));
}

/** A wall position's inner (depth 0) and outer (depth t - 1) cells and the unit normal from inside out. */
function across(W, pos) {
  const cs = W.cells.filter((c) => c.pos === pos).sort((a, b) => a.depth - b.depth);
  const inner = cs[0], outer = cs[cs.length - 1];
  let nx = Math.sign(outer.x - inner.x), nz = Math.sign(outer.z - inner.z);
  if (!nx && !nz) { if (W.positions[pos].axis === 1) nz = 1; else nx = 1; }
  return { cs, inner, outer, n: [nx, nz] };
}

/** The positions a walk gate of the wall holds, its jambs included. */
function gatePositions(W) {
  const s = new Set();
  for (const g of W.gates ?? []) for (let i = g.a - 1; i <= g.b + 1; i++) s.add(i);
  return s;
}

/** The corner towers' columns of a closed ring (wall.mjs stubCells' rule). */
function towerColumns(W) {
  if (W.st?.corners !== 'tower' || !W.I || !W.closed) return new Set();
  const t = W.st.thickness, I = W.I, s = Math.max(3, t + 1), out = new Set();
  for (const [cx, cz, sx, sz] of [[I.minX, I.minZ, -1, -1], [I.maxX, I.minZ, 1, -1], [I.maxX, I.maxZ, 1, 1], [I.minX, I.maxZ, -1, 1]]) {
    const ox = sx < 0 ? cx - (s - 1) : cx, oz = sz < 0 ? cz - (s - 1) : cz;
    for (let dz = 0; dz < s; dz++) for (let dx = 0; dx < s; dx++) out.add(k2(ox + dx, oz + dz));
  }
  return out;
}

const refuse = (msg, evidence) => { const e = new Error(`UNREACHABLE: ${msg}`); e.code = 'UNREACHABLE'; e.evidence = { kind: 'wall', ...evidence }; return e; };

/**
 * A course's reach meeting the plan's walls (call from the course's emit, before r.fluidBody). `cells`: the reach's body cells [[x, y, z]];
 * `level`: its surface; `outlets`, `lining`, `spill`: [[x, y, z]] of the reach (none may stand in a crossing's columns or its 2 still cells
 * each side). Returns {grate, crossings}; throws UNREACHABLE {kind: wall} (see the header).
 */
export function waterGate(K, { course, body, cells, level, outlets = [], lining = [], spill = [] }) {
  const out = { grate: [], crossings: [] };
  if (!K?.walls?.length || !Array.isArray(cells) || !cells.length) return out;
  const cols = new Map();
  for (const [x, y, z] of cells) { const k = k2(x, z); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(y); }
  const stepCols = new Set([...outlets, ...lining, ...spill].map(([x, , z]) => k2(x, z)));
  for (const W of K.walls) {
    if (!['fits', 'adjusted'].includes(K.answers?.get?.(W.id)?.class ?? 'fits')) continue;
    const hit = W.cells.filter((c) => cols.has(k2(c.x, c.z)));
    const towers = towerColumns(W);
    const underTower = [...cols.keys()].filter((k) => towers.has(k) && !W.cellAt?.has(k));
    if (!hit.length && !underTower.length) continue;
    const ev = { wall: W.id, course, body };
    if (W.st.sealed) throw refuse(`wall ${W.id} is sealed (S-K1-1): a course can't pass under it`, { ...ev, why: 'sealed', sealed: true });
    if (underTower.length) throw refuse(`the reach ${body} passes under a corner tower of wall ${W.id}`, { ...ev, why: 'corner' });
    const positions = [...new Set(hit.map((c) => c.pos))].sort((a, b) => a - b);
    if (positions.some((p) => W.positions[p].axis === 3 || (W.ends ?? []).includes(p))) throw refuse(`the reach ${body} meets wall ${W.id} at a corner or an end of the line (a water gate stands on a straight run)`, { ...ev, why: 'corner', positions });
    if (positions.length > 3 || positions[positions.length - 1] - positions[0] !== positions.length - 1) throw refuse(`the reach ${body} meets wall ${W.id} over ${positions.length} positions (a water gate is at most 3 wide, one straight run)`, { ...ev, why: 'width', positions });
    const ax = W.positions[positions[0]].axis;
    if (positions.some((p) => W.positions[p].axis !== ax)) throw refuse(`the reach ${body} meets wall ${W.id} off one straight run`, { ...ev, why: 'corner', positions });
    const gp = gatePositions(W);
    if (positions.some((p) => gp.has(p))) throw refuse(`the reach ${body} meets wall ${W.id} at a walk gate or its jambs`, { ...ev, why: 'gate', positions });
    const others = waterGates(K, W);
    const taken = new Set(others.flatMap((o) => o.cells.map(([x, z]) => k2(x, z))));
    if (hit.some((c) => taken.has(k2(c.x, c.z)))) throw refuse(`another water gate of wall ${W.id} stands there`, { ...ev, why: 'gate', positions });
    // the still reach: under every course of the thickness, and 2 cells of it beyond each face, with no step there
    const still = [];
    for (const p of positions) {
      const a = across(W, p);
      for (const c of a.cs) if (!cols.has(k2(c.x, c.z))) throw refuse(`the reach ${body} ends under wall ${W.id} (a water gate passes the whole thickness)`, { ...ev, why: 'still', at: [c.x, c.z] });
      for (let k = 1; k <= 2; k++) {
        const pin = [a.inner.x - a.n[0] * k, a.inner.z - a.n[1] * k], pout = [a.outer.x + a.n[0] * k, a.outer.z + a.n[1] * k];
        for (const q of [pin, pout]) {
          if (!cols.has(k2(q[0], q[1]))) throw refuse(`the reach ${body} has less than 2 cells of still water beyond wall ${W.id}'s face at ${q.join(', ')}`, { ...ev, why: 'still', at: q });
          still.push(q);
        }
      }
    }
    const crossCols = hit.map((c) => [c.x, c.z]);
    if ([...crossCols, ...still].some(([x, z]) => stepCols.has(k2(x, z)))) throw refuse(`a step of the course stands under wall ${W.id} or within 2 of it (a wall never crosses a step)`, { ...ev, why: 'step' });
    // gates.max: the gates the wall opened so far and its standing water gates
    const max = W.st.gatesMax ?? 16;
    const used = (W.opened ?? 0) + others.length;
    if (used >= max) throw refuse(`wall ${W.id} is at its gates.max ${max} (${W.opened ?? 0} gate(s), ${others.length} water gate(s))`, { ...ev, why: 'max', max, gates: W.opened ?? 0, waterGates: others.length });
    const colSet = new Set(crossCols.map(([x, z]) => k2(x, z)));
    const grate = cells.filter(([x, , z]) => colSet.has(k2(x, z))).map((c) => [...c]).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    const rec = registerCrossing(K, { course, body, wall: W.id, cells: crossCols.sort((a, b) => a[0] - b[0] || a[1] - b[1]), level, lintel: level + 1, grate, positions, normal: across(W, positions[0]).n });
    out.crossings.push(rec);
    out.grate.push(...grate);
  }
  return out;
}

/**
 * The still reach a router lays across a planned wall (the forced still reach, §8.3): at the wall's free straight run of `width`
 * positions nearest `at` ([x, z]), straight through the thickness and `beyond` (at least 2) cells past each face, `depth` deep under
 * `level` (default: the lowest survey ground along it, less 1: sunk 1 under the lower bank). Returns {cells: [[x, y, z]], columns: [[x, z]],
 * level, positions: [a, b], normal: [nx, nz], wall} or {error: {code, message, evidence}}.
 */
export function reachAcross(K, wallId, at, { width = 3, beyond = 3, depth = 2, level = null } = {}) {
  const W = (K.walls ?? []).find((w) => w.id === wallId);
  if (!W) return { error: { code: 'NO_FEATURE', message: `wall ${wallId} has no line`, evidence: { wall: wallId } } };
  if (W.st.sealed) return { error: { code: 'UNREACHABLE', message: `wall ${wallId} is sealed`, evidence: { kind: 'wall', wall: wallId, why: 'sealed', sealed: true } } };
  const n = W.positions.length, gp = gatePositions(W), towers = towerColumns(W);
  const taken = new Set(waterGates(K, W).flatMap((o) => o.positions ?? []));
  const free = (a, b) => {
    if (a - 1 < 0 || b + 1 >= n) return false;
    const ax = W.positions[a].axis;
    if (ax === 3) return false;
    for (let i = a - 1; i <= b + 1; i++) if (W.positions[i].axis !== ax || (W.ends ?? []).includes(i) || gp.has(i) || taken.has(i)) return false;
    return true;
  };
  let proj = 0, pd = Infinity;
  W.positions.forEach((q, i) => { const dx = q.x - at[0], dz = q.z - at[1], d = dx * dx + dz * dz; if (d < pd) { pd = d; proj = i; } });
  let best = null;
  for (let a = 1; a + width - 1 < n - 1; a++) {
    const b = a + width - 1;
    if (!free(a, b)) continue;
    const m = (a + b) >> 1, d = W.closed ? Math.min(Math.abs(m - proj), n - Math.abs(m - proj)) : Math.abs(m - proj);
    if (!best || d < best.d) best = { a, b, d };
  }
  if (!best) return { error: { code: 'NO_ROOM', message: `wall ${wallId} has no straight run of ${width} free for a water gate`, evidence: { wall: wallId, width } } };
  const columns = [];
  let normal = null;
  for (let p = best.a; p <= best.b; p++) {
    const a = across(W, p);
    normal = a.n;
    for (let k = beyond; k >= 1; k--) columns.push([a.inner.x - a.n[0] * k, a.inner.z - a.n[1] * k]);
    for (const c of a.cs) columns.push([c.x, c.z]);
    for (let k = 1; k <= beyond; k++) columns.push([a.outer.x + a.n[0] * k, a.outer.z + a.n[1] * k]);
  }
  if (columns.some(([x, z]) => towers.has(k2(x, z)))) return { error: { code: 'NO_ROOM', message: `the reach across wall ${wallId} meets a corner tower`, evidence: { wall: wallId } } };
  const S = K.env.S;
  const lv = level ?? Math.min(...columns.map(([x, z]) => S.groundAt(x, z))) - 1;
  const cells = [];
  for (const [x, z] of columns) for (let y = lv - depth + 1; y <= lv; y++) cells.push([x, y, z]);
  return { cells, columns, level: lv, positions: [best.a, best.b], normal, wall: wallId };
}
