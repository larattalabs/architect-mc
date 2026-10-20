// (6c F3 §4) M18 (leaf decay) and M19 (dead coral), warnings, over the virtual world (or a realised world's dump, the same reader).
//
// M18: every leaf cell a plan part writes is persistent=true, or lies within 6 of a log by vanilla's rule (LeavesBlock.updateDistance:
// 6-neighbour, through any leaves, from any `#minecraft:logs` block). Findings per part: the cells, each with its distance. F2's stamps
// (harvested persistent=false leaves) are judged by the same rule. Also measured: written leaves whose `distance` differs from vanilla's
// (item 8's rule; a metric, `M18.distanceOff`).
// M19: no live coral block without a water cell beside it (CoralBlock.scanForWater: any face neighbour holding water, a waterlogged block
// included), and no live coral plant, fan or wall fan that is not waterlogged. Findings per part.
import { isLeaves, isLog } from '../forms/states.mjs';

const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const propOf = (s, p) => (new RegExp(`[\\[,]${p}=([a-z_0-9]+)`).exec(s) ?? [])[1] ?? null;
const nameOf = (s) => String(s).replace(/\[.*$/, '');
/** A live coral block (not dead). */
export const isLiveCoralBlock = (s) => /^minecraft:(tube|brain|bubble|fire|horn)_coral_block$/.test(nameOf(s));
/** A live coral plant, fan or wall fan (not dead). */
export const isLiveCoralPlant = (s) => /^minecraft:(tube|brain|bubble|fire|horn)_coral(_fan|_wall_fan)?$/.test(nameOf(s));

/**
 * Vanilla's distance of the leaf at (x, y, z) over `stateAt(x, y, z)` (a state string or null): the BFS through leaves to the nearest log,
 * 1..7 (7: none within 6).
 */
export function leafDistanceAt(stateAt, x, y, z) {
  let frontier = [[x, y, z]];
  const seen = new Set([`${x},${y},${z}`]);
  for (let d = 1; d <= 6; d++) {
    const next = [];
    for (const [a, b, c] of frontier) {
      for (const [dx, dy, dz] of DIRS6) {
        const nx = a + dx, ny = b + dy, nz = c + dz, k = `${nx},${ny},${nz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const s = stateAt(nx, ny, nz);
        if (!s) continue;
        if (isLog(s)) return d;
        if (isLeaves(s)) next.push([nx, ny, nz]);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return 7;
}

/**
 * Vanilla's distance of many leaves at once: `cells` [[x, y, z]] (leaves), over `stateAt`. Explores every leaf within 6 (through leaves)
 * of a given cell (every path a distance of at most 6 can take), then one BFS from the leaves touching a log. Returns an Int8Array of the
 * cells' distances (1..7), in order.
 */
export function leafDistances(cells, stateAt) {
  if (!cells.length) return new Int8Array(0);
  let x0 = Infinity, z0 = Infinity;
  for (const [x, , z] of cells) { if (x < x0) x0 = x; if (z < z0) z0 = z; }
  x0 -= 8; z0 -= 8;
  const K = (x, y, z) => ((x - x0) * 65536 + (z - z0)) * 1024 + (y + 128);
  const leaf = new Map(); // key -> [x, y, z, touchesLog]
  let frontier = [];
  const look = (x, y, z) => {
    const k = K(x, y, z);
    if (leaf.has(k)) return null;
    const s = stateAt(x, y, z);
    if (!s || !isLeaves(s)) { leaf.set(k, null); return null; }
    let log = false;
    for (const [dx, dy, dz] of DIRS6) { const o = stateAt(x + dx, y + dy, z + dz); if (o && isLog(o)) { log = true; break; } }
    const v = [x, y, z, log];
    leaf.set(k, v);
    return v;
  };
  for (const [x, y, z] of cells) { const v = look(x, y, z); if (v) frontier.push(v); }
  for (let d = 1; d <= 6 && frontier.length; d++) {
    const next = [];
    for (const [x, y, z] of frontier) for (const [dx, dy, dz] of DIRS6) { const v = look(x + dx, y + dy, z + dz); if (v) next.push(v); }
    frontier = next;
  }
  const dist = new Map();
  let q = [];
  for (const [k, v] of leaf) if (v && v[3]) { dist.set(k, 1); q.push(v); }
  for (let d = 2; d <= 6 && q.length; d++) {
    const next = [];
    for (const [x, y, z] of q) for (const [dx, dy, dz] of DIRS6) {
      const k = K(x + dx, y + dy, z + dz);
      const v = leaf.get(k);
      if (!v || dist.has(k)) continue;
      dist.set(k, d);
      next.push(v);
    }
    q = next;
  }
  return Int8Array.from(cells, ([x, y, z]) => dist.get(K(x, y, z)) ?? 7);
}

/**
 * M18 and M19 over a world: `each(fn)` calls fn(x, y, z, state, partIndex) for every written leaf or coral cell; `stateAt(x, y, z)` reads
 * any cell (written or not; null for air). Returns {m18: Map(part -> [[x, y, z, distance]]), m19: Map(part -> [[x, y, z, why]]), metrics}.
 */
export function formRules({ each, stateAt, isWater }) {
  const m18 = new Map(), m19 = new Map();
  let persistent = 0, distanceOff = 0, corals = 0;
  const push = (m, pi, v) => { const l = m.get(pi) ?? []; l.push(v); m.set(pi, l); };
  const leaves = [];
  each((x, y, z, s, pi) => {
    if (isLeaves(s)) { leaves.push([x, y, z, s, pi]); return; }
    if (isLiveCoralBlock(s)) {
      corals++;
      if (!DIRS6.some(([dx, dy, dz]) => isWater(x + dx, y + dy, z + dz))) push(m19, pi, [x, y, z, 'no water beside it']);
    } else if (isLiveCoralPlant(s)) {
      corals++;
      if (propOf(s, 'waterlogged') !== 'true') push(m19, pi, [x, y, z, 'not waterlogged']);
    }
  });
  const ds = leafDistances(leaves, stateAt);
  leaves.forEach(([x, y, z, s, pi], i) => {
    const pers = propOf(s, 'persistent') === 'true';
    if (pers) persistent++;
    const d = ds[i];
    if (Number(propOf(s, 'distance') ?? 7) !== d) distanceOff++;
    if (!pers && d > 6) push(m18, pi, [x, y, z, d]);
  });
  return { m18, m19, metrics: { M18: { leaves: leaves.length, persistent, decaying: [...m18.values()].reduce((a, l) => a + l.length, 0), distanceOff }, M19: { corals, dead: [...m19.values()].reduce((a, l) => a + l.length, 0) } } };
}

/** M18 and M19 over the checker's virtual world: findings via `finding`, metrics into `metrics`. */
export function formRulesVw({ vw, ir, want, findings, metrics, finding, partStage }) {
  const P = vw.pal;
  const each = (fn) => vw.eachWritten((x, y, z, idx, f, pi) => {
    const s = P.states[idx];
    if (isLeaves(s) || isLiveCoralBlock(s) || isLiveCoralPlant(s)) fn(x, y, z, s, pi);
  });
  const stateAt = (x, y, z) => { const i = vw.get(x, y, z); return P.air[i] ? null : P.states[i]; };
  const isWater = (x, y, z) => P.water[vw.get(x, y, z)];
  const out = formRules({ each, stateAt, isWater });
  if (want.has('M18')) for (const [pi, l] of out.m18) {
    const id = ir.parts[pi]?.id ?? null;
    findings.push(finding('M18', id, partStage.get(id) ?? null, l.length, l, `${l.length} leaf cell(s) neither persistent nor within 6 of a log (vanilla decays them)`));
  }
  if (want.has('M19')) for (const [pi, l] of out.m19) {
    const id = ir.parts[pi]?.id ?? null;
    findings.push(finding('M19', id, partStage.get(id) ?? null, l.length, l, `${l.length} live coral cell(s) that die (a block with no water beside it, a plant or fan not waterlogged)`));
  }
  metrics.M18 = out.metrics.M18;
  metrics.M19 = out.metrics.M19;
}
