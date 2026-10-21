// (6c F3 §2, §6) The states vanilla would give F3's blocks, computed at write from the form's own cells, so the realised cells keep
// exactly what the kit wrote (Sites.FLAGS skips neighbour updates) and match what vanilla's updateShape would compute anyway:
//   - leaves: `distance` as LeavesBlock.updateDistance (6-neighbour, through any leaves from any `#minecraft:logs` block, capped 7),
//     every written leaf `persistent=true` (M18);
//   - huge mushroom blocks and stems: a face is false where the neighbour is the same block (HugeMushroomBlock.updateShape only ever
//     sets a face false next to its own block, so this is its fixed point);
//   - pointed dripstone: `thickness` as SpeleothemBlock.calculateSpeleothemThickness (tip_merge where two opposing tips meet).
// Plus the form's 2.5D column mask (§3.2) and its connected trim. Plan time only; pure and deterministic.
import { BLOCKS, hasTag, qualify } from '../blocks.mjs';

export const AIR = 'minecraft:air';
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACES = [['east', 1, 0, 0], ['west', -1, 0, 0], ['up', 0, 1, 0], ['down', 0, -1, 0], ['south', 0, 0, 1], ['north', 0, 0, -1]];
export const key = (x, y, z) => `${x},${y},${z}`;
export const unkey = (k) => k.split(',').map(Number);
export const nameOf = (s) => String(s).replace(/\[.*$/, '');

/** Whether a state is in vanilla's `#minecraft:logs` (LeavesBlock's distance source: crimson and warped stems included). */
const logMemo = new Map();
export function isLog(s) {
  const n = nameOf(s);
  let v = logMemo.get(n);
  if (v === undefined) { v = hasTag(n, 'minecraft:logs'); logMemo.set(n, v); }
  return v;
}
/**
 * Whether a state is a LeavesBlock (it has `distance` and `persistent`). A block the vanilla table doesn't list (a mod's, such as
 * Architect's construction crate in a survival stockpile read back from the world) is not leaves: the checker's M18 pass reads every
 * written cell (batch v0.41.0: RS's half-built check met the crates).
 */
const leafMemo = new Map();
export function isLeaves(s) {
  const n = nameOf(s);
  let v = leafMemo.get(n);
  if (v === undefined) { const i = BLOCKS[qualify(n)]; v = !!i && 'distance' in i.props && 'persistent' in i.props; leafMemo.set(n, v); }
  return v;
}
/** The huge mushroom blocks (HugeMushroomBlock: six boolean faces). */
export const MUSHROOM_BLOCKS = Object.freeze(['minecraft:brown_mushroom_block', 'minecraft:red_mushroom_block', 'minecraft:mushroom_stem']);
export const isMushroomBlock = (s) => MUSHROOM_BLOCKS.includes(nameOf(s));
export const isDripstone = (s) => nameOf(s) === 'minecraft:pointed_dripstone';

/**
 * Vanilla's leaf distance over a cell getter: `get(x, y, z)` -> state | null (null: air or unknown). Multi-source BFS from every log
 * face-adjacent to a leaf of `leaves` (keys), through leaves, capped at 7. Returns Map(key -> 1..7).
 */
export function leafDistances(leaves, get) {
  const dist = new Map();
  let frontier = [];
  for (const k of leaves) {
    const [x, y, z] = unkey(k);
    for (const [dx, dy, dz] of DIRS6) {
      const s = get(x + dx, y + dy, z + dz);
      if (s && isLog(s)) { dist.set(k, 1); frontier.push(k); break; }
    }
  }
  for (let d = 2; d <= 6 && frontier.length; d++) {
    const next = [];
    for (const k of frontier) {
      const [x, y, z] = unkey(k);
      for (const [dx, dy, dz] of DIRS6) {
        const n = key(x + dx, y + dy, z + dz);
        if (!leaves.has(n) || dist.has(n)) continue;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  for (const k of leaves) if (!dist.has(k)) dist.set(k, 7);
  return dist;
}

/** A state with its properties replaced (all given explicitly, sorted). */
export function withProps(state, props) {
  const n = nameOf(state);
  const m = /\[([^\]]*)\]/.exec(state);
  const cur = {};
  if (m && m[1]) for (const kv of m[1].split(',')) { const [k, v] = kv.split('='); cur[k] = v; }
  Object.assign(cur, props);
  const ks = Object.keys(cur).sort();
  return ks.length ? `${n}[${ks.map((k) => `${k}=${cur[k]}`).join(',')}]` : n;
}

/**
 * Fix the drift states of a form's cells in place (Map key -> state, air entries allowed): leaves' distance (persistent=true,
 * waterlogged=false), mushroom faces, pointed dripstone thickness. `outside(x, y, z)` gives a state the form does not write (default:
 * none, so the form stands alone; the caller keeps forms 8 off natural trees). Returns counts.
 */
export function fixStates(cells, { outside = () => null } = {}) {
  const get = (x, y, z) => { const s = cells.get(key(x, y, z)); return s && s !== AIR ? s : outside(x, y, z); };
  const leaves = new Set();
  let faces = 0, drip = 0;
  for (const [k, s] of cells) if (s !== AIR && isLeaves(s)) leaves.add(k);
  if (leaves.size) {
    const d = leafDistances(leaves, get);
    for (const k of leaves) cells.set(k, withProps(cells.get(k), { distance: String(d.get(k)), persistent: 'true', waterlogged: 'false' }));
  }
  const updates = [];
  const drips = [];
  for (const [k, s] of cells) {
    if (s === AIR) continue;
    if (isMushroomBlock(s)) {
      const [x, y, z] = unkey(k);
      const n = nameOf(s), p = {};
      for (const [f, dx, dy, dz] of FACES) { const o = get(x + dx, y + dy, z + dz); p[f] = o && nameOf(o) === n ? 'false' : 'true'; }
      updates.push([k, withProps(s, p)]);
      faces++;
    } else if (isDripstone(s)) drips.push(k);
  }
  for (const [k, s] of updates) cells.set(k, s);
  // thickness reads the neighbour's thickness toward the tip: passes until nothing changes (a column of n settles in n passes)
  drip = drips.length;
  for (let pass = 0; pass <= 32 && drips.length; pass++) {
    let changed = 0;
    for (const k of drips) {
      const s = cells.get(k);
      const t = withProps(s, { thickness: dripstoneThickness(k, s, get), waterlogged: 'false' });
      if (t !== s) { cells.set(k, t); changed++; }
    }
    if (!changed) break;
  }
  return { leaves: leaves.size, faces, dripstone: drip };
}

const propOf = (s, p) => (new RegExp(`[\\[,]${p}=([a-z_0-9]+)`).exec(s) ?? [])[1] ?? null;
/** SpeleothemBlock.calculateSpeleothemThickness at `k` (state `s`, its `vertical_direction`), over `get`. */
export function dripstoneThickness(k, s, get) {
  const [x, y, z] = unkey(k);
  const dir = propOf(s, 'vertical_direction') ?? 'up';
  const dy = dir === 'up' ? 1 : -1;
  const isDir = (o, d) => !!o && isDripstone(o) && (propOf(o, 'vertical_direction') ?? 'up') === d;
  const opp = dir === 'up' ? 'down' : 'up';
  const front = get(x, y + dy, z);
  // a tip facing an opposing tip: merged (written as tip_merge on both: the fixed point of updateShape with mergeOpposingTips)
  if (isDir(front, opp)) return 'tip_merge';
  if (!isDir(front, dir)) return 'tip';
  const ft = propOf(front, 'thickness');
  // (the front's thickness is computed first along the column: callers fix tips first, see thicknessColumn)
  if (ft === 'tip' || ft === 'tip_merge') return 'frustum';
  const behind = get(x, y - dy, z);
  return isDir(behind, dir) ? 'middle' : 'base';
}

/**
 * Thickness along a column of pointed dripstone given as a run from root to tip (`n` cells, merged when it meets an opposing run):
 * the same as dripstoneThickness applied tip first. ['base', 'middle', ..., 'frustum', 'tip' | 'tip_merge'].
 */
export function thicknessColumn(n, merged = false) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const fromTip = n - 1 - i;
    if (fromTip === 0) out.push(merged ? 'tip_merge' : 'tip');
    else if (fromTip === 1) out.push('frustum');
    else out.push(i === 0 ? 'base' : 'middle');
  }
  return out;
}

/** The cells face-connected (through non-air cells) to a cell `root(k, s)` accepts; the rest are returned as `dropped` keys. */
export function connectedTo(cells, root) {
  const seen = new Set(), queue = [];
  for (const [k, s] of cells) if (s !== AIR && root(k, s)) { seen.add(k); queue.push(k); }
  for (let i = 0; i < queue.length; i++) {
    const [x, y, z] = unkey(queue[i]);
    for (const [dx, dy, dz] of DIRS6) {
      const n = key(x + dx, y + dy, z + dz);
      if (seen.has(n)) continue;
      const s = cells.get(n);
      if (!s || s === AIR) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  const dropped = [];
  for (const [k, s] of cells) if (s !== AIR && !seen.has(k)) dropped.push(k);
  return dropped.sort();
}

/**
 * (§3.2) The form's 2.5D column mask: its non-air cells projected, as sorted runs `[z, x0, x1, z, x0, x1, ...]` (one flat array: the
 * IR's `forms[].columns`). Cells under `skipBelow(x, z)` (a skirt or root under the ground) still count: they are the form's columns.
 */
export function columnRuns(cells) {
  const cols = new Map();
  for (const [k, s] of cells) {
    if (s === AIR) continue;
    const [x, , z] = unkey(k);
    let row = cols.get(z);
    if (!row) { row = new Set(); cols.set(z, row); }
    row.add(x);
  }
  const out = [];
  for (const z of [...cols.keys()].sort((a, b) => a - b)) {
    const xs = [...cols.get(z)].sort((a, b) => a - b);
    let a = xs[0], b = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === b + 1) { b = xs[i]; continue; }
      out.push(z, a, b);
      if (i < xs.length) { a = xs[i]; b = xs[i]; }
    }
  }
  return out;
}

/** Iterate a column mask's columns: fn(x, z). */
export function eachColumn(runs, fn) {
  for (let i = 0; i < runs.length; i += 3) for (let x = runs[i + 1]; x <= runs[i + 2]; x++) fn(x, runs[i]);
}
/** A column mask's bounding rect {minX, minZ, maxX, maxZ}. */
export function runsRect(runs) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < runs.length; i += 3) { minZ = Math.min(minZ, runs[i]); maxZ = Math.max(maxZ, runs[i]); minX = Math.min(minX, runs[i + 1]); maxX = Math.max(maxX, runs[i + 2]); }
  return { minX, minZ, maxX, maxZ };
}
/** A column mask grown by `g` (Chebyshev), as a Set of "x,z" keys. */
export function grownColumns(runs, g) {
  const out = new Set();
  eachColumn(runs, (x, z) => { for (let dx = -g; dx <= g; dx++) for (let dz = -g; dz <= g; dz++) out.add(`${x + dx},${z + dz}`); });
  return out;
}
/** Shift a column mask by (dx, dz). */
export function shiftRuns(runs, dx, dz) {
  const out = runs.slice();
  for (let i = 0; i < out.length; i += 3) { out[i] += dz; out[i + 1] += dx; out[i + 2] += dx; }
  return out;
}

/**
 * (6c F3 §10.1) Lint STATE: the drift states a form hands over equal the ones vanilla's updateShape would compute from its own cells
 * (mushroom faces, dripstone thickness, leaf distance). Returns null, or the error text (`STATE: ...`, at most 4 cells named).
 */
export function lintStates(cells) {
  const copy = new Map(cells);
  fixStates(copy);
  const bad = [];
  for (const [k, s] of cells) {
    if (s === AIR) continue;
    const t = copy.get(k);
    if (isMushroomBlock(s) && t !== s) bad.push(`${k} ${s} (vanilla: ${t})`);
    else if (isDripstone(s) && propOf(s, 'thickness') !== propOf(t, 'thickness')) bad.push(`${k} thickness ${propOf(s, 'thickness')} (vanilla: ${propOf(t, 'thickness')})`);
    else if (isLeaves(s) && propOf(s, 'distance') !== propOf(t, 'distance')) bad.push(`${k} distance ${propOf(s, 'distance')} (vanilla: ${propOf(t, 'distance')})`);
  }
  return bad.length ? `STATE: ${bad.length} cell(s) hold a state vanilla would change at once: ${bad.slice(0, 4).join('; ')}` : null;
}
