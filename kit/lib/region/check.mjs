// The macro checker M1-M14 (docs/CONTRACT.md 6b §3.2, steward-mc A5B §3, SETTLEMENTS §11) on the virtual world
// (vworld.mjs), with M2 as the `player` mover and M2/M3 after every stage prefix. Severities: M1, M13 and M14's
// uniqueness are errors; everything else is a warning (6b promotes nothing). The same rules run on a realised world
// (two ARWD dumps) for the scenario metrics.
import { blockState } from './program.mjs';
import { F_WALK, F_WRITTEN, buildVirtual } from './vworld.mjs';
import { fillMissing } from './plan.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from './geom.mjs';

export const RULES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14'];
const ERRORS = new Set(['M1', 'M13', 'M14']);
// (finding() keeps at most 20 sample positions)
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const WORLD_MIN_Y = -64, WORLD_MAX_Y = 319;

/** A sparse set of cells (per 16^3 section bitsets). */
class CellSet {
  constructor() { this.m = new Map(); this.size = 0; }
  static key(x, y, z) { return (((x >> 4) + 131072) * 262144 + ((z >> 4) + 131072)) * 512 + ((y >> 4) + 256); }
  has(x, y, z) { const s = this.m.get(CellSet.key(x, y, z)); return !!s && (s[(((y & 15) << 8) | ((z & 15) << 4) | (x & 15)) >> 3] & (1 << (x & 7))) !== 0; }
  add(x, y, z) {
    const k = CellSet.key(x, y, z);
    let s = this.m.get(k);
    if (!s) { s = new Uint8Array(512); this.m.set(k, s); }
    const o = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15), b = 1 << (x & 7);
    if (s[o >> 3] & b) return false;
    s[o >> 3] |= b; this.size++;
    return true;
  }
}

/** Sparse per-cell bytes (block light). */
class CellBytes {
  constructor() { this.m = new Map(); }
  get(x, y, z) { const s = this.m.get(CellSet.key(x, y, z)); return s ? s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : 0; }
  set(x, y, z, v) {
    const k = CellSet.key(x, y, z);
    let s = this.m.get(k);
    if (!s) { s = new Uint8Array(4096); this.m.set(k, s); }
    s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = v;
  }
}

function finding(rule, part, stage, count, sample, message) {
  return { rule, severity: ERRORS.has(rule.split(':')[0]) && !(rule === 'M14' && /warning/.test(message)) ? 'error' : 'warning', part: part ?? null, stage: stage ?? null, count, sample: sample.slice(0, 20), message };
}

// ------------------------------------------------------------------ the walk graph (M2, `player` mover)

/**
 * The `player` mover (SETTLEMENTS §11): feet and head cells passable, a floor under the feet (or water to swim on, or a
 * climbable cell); steps of 1 up (with head room for the jump), falls of at most 3, ladders and vines up and down, doors
 * and gates open. Lot boxes are obstacles (their interiors are declared, not known).
 */
export function walkGraph(vw, starts) {
  const P = vw.pal, c = vw.claim;
  const cache = new Map();
  const standAt = (x, y, z) => {
    if (vw.lotAt(x, y, z) || vw.lotAt(x, y + 1, z)) return false;
    const a = vw.get(x, y, z), b = vw.get(x, y + 1, z);
    if (!P.passable[a] || !P.passable[b] || P.lava[a] || P.lava[b]) return false;
    if (P.climb[a]) return true;
    const f = vw.get(x, y - 1, z);
    if (P.floor[f]) return true;
    return P.water[f] && P.air[a]; // swimming on the surface
  };
  const stands = (x, z) => {
    const k = (x - c.minX) + (z - c.minZ) * vw.W;
    let l = cache.get(k);
    if (l) return l;
    const [lo, hi] = vw.colRange(x, z);
    const out = [];
    for (let y = Math.max(c.minY + 1, lo - 1); y <= Math.min(c.maxY - 1, hi + 2); y++) if (standAt(x, y, z)) out.push(y);
    l = Int32Array.from(out);
    cache.set(k, l);
    return l;
  };
  const seen = new CellSet();
  const queue = [];
  const reached = [];
  const push = (x, y, z) => { if (seen.add(x, y, z)) { queue.push(x, y, z); reached.push(x, y, z); } };
  for (const [x, y, z] of starts) {
    if (!vw.inClaim(x, z)) continue;
    for (const yy of stands(x, z)) if (Math.abs(yy - y) <= 2) push(x, yy, z);
  }
  for (let q = 0; q < queue.length; q += 3) {
    const x = queue[q], y = queue[q + 1], z = queue[q + 2];
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx, nz = z + dz;
      if (!vw.inClaim(nx, nz)) continue;
      for (const ny of stands(nx, nz)) {
        if (ny > y + 1 || ny < y - 3) continue;
        // a step up needs head room for the jump, unless it is onto a stairs block (walked up without jumping)
        if (ny === y + 1 && !P.passable[vw.get(x, y + 2, z)] && !P.stairs[vw.get(nx, ny - 1, nz)]) continue;
        if (ny < y) { let ok = true; for (let yy = ny + 2; yy <= y + 1; yy++) if (!P.passable[vw.get(nx, yy, nz)]) { ok = false; break; } if (!ok) continue; }
        push(nx, ny, nz);
      }
    }
    // climbing
    const here = vw.get(x, y, z);
    if (P.climb[here] || P.climb[vw.get(x, y + 1, z)]) {
      if (P.passable[vw.get(x, y + 2, z)] && (P.climb[vw.get(x, y + 1, z)] || standAt(x, y + 1, z))) push(x, y + 1, z);
    }
    if (P.climb[vw.get(x, y - 1, z)] || (P.climb[here] && P.passable[vw.get(x, y - 1, z)])) if (P.passable[vw.get(x, y - 1, z)]) push(x, y - 1, z);
  }
  return { seen, reached, stands, standAt };
}

/** Is a node (feet cell) reached: the cell, or a 4-neighbour, within 1 in y. */
function nodeReached(g, [x, y, z]) {
  for (const [dx, dz] of [[0, 0], ...DIRS4]) for (let dy = -1; dy <= 1; dy++) if (g.seen.has(x + dx, y + dy, z + dz)) return true;
  return false;
}

/** The M2 nodes: lot entrances, anchors (not cam_*), and floating anchors, existing by `stageIdx` (null: all). */
export function walkNodes(ir, meta, stageIdx = null) {
  const si = (s) => ir.stages.indexOf(s);
  const partStage = new Map(ir.parts.map((p) => [p.id, si(p.stage)]));
  const nodes = [];
  for (const l of ir.lots ?? []) {
    const ps = partStage.get(l.part) ?? 0;
    if (stageIdx !== null && ps > stageIdx) continue;
    nodes.push({ id: `lot:${l.id}`, kind: 'lot', ref: l.id, at: meta?.lots?.[l.id]?.entrance ?? lotEntrance(l), part: l.part });
  }
  const floatAnchor = new Map();
  for (const f of ir.floating ?? []) if (f.anchor) floatAnchor.set(f.anchor, f.parts);
  for (const [name, at] of Object.entries(ir.anchors ?? {})) {
    if (name.startsWith('cam_') || name === 'entrance') continue;
    const parts = floatAnchor.get(name);
    if (parts && stageIdx !== null && Math.max(...parts.map((p) => partStage.get(p) ?? 0)) > stageIdx) continue;
    nodes.push({ id: `anchor:${name}`, kind: 'anchor', ref: name, at, floating: !!parts });
  }
  return nodes;
}

/** A lot's entrance when the plan meta has none: in front of the middle of its front edge, on the apron. */
export function lotEntrance(l) {
  const b = l.box, mx = b.minX + Math.floor((b.maxX - b.minX) / 2), mz = b.minZ + Math.floor((b.maxZ - b.minZ) / 2);
  return { north: [mx, b.minY, b.minZ - 1], south: [mx, b.minY, b.maxZ + 1], west: [b.minX - 1, b.minY, mz], east: [b.maxX + 1, b.minY, mz] }[l.front];
}

// ------------------------------------------------------------------ M3 support

function supportCheck(vw, ir, stage) {
  const P = vw.pal;
  const partId = (i) => ir.parts[i]?.id ?? null;
  const groups = (ir.floating ?? []).map((f) => new Set(f.parts.map((id) => ir.parts.findIndex((p) => p.id === id))));
  const groupOf = (pi) => groups.findIndex((g) => g.has(pi));
  const solid = (idx) => P.solid[idx] && !P.fluid[idx];
  const written = (x, y, z) => (vw.flags(x, y, z) & F_WRITTEN) !== 0;
  // seeds: written solid cells touching unwritten pre-region solid ground, and every cell of a floating group
  const ok = new CellSet();
  const queue = [];
  const groupCells = groups.map(() => []);
  const gravity = [];
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (!solid(idx)) return;
    if (P.gravity[idx] && !solid(vw.get(x, y - 1, z))) gravity.push([x, y, z, pi]);
    const g = pi >= 0 ? groupOf(pi) : -1;
    if (g >= 0) { groupCells[g].push(x, y, z); if (ok.add(x, y, z)) queue.push(x, y, z); return; }
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (!written(nx, ny, nz) && solid(vw.get(nx, ny, nz))) { if (ok.add(x, y, z)) queue.push(x, y, z); return; }
    }
  });
  for (let q = 0; q < queue.length; q += 3) {
    const x = queue[q], y = queue[q + 1], z = queue[q + 2];
    for (const [dx, dy, dz] of DIRS6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (ok.has(nx, ny, nz) || !written(nx, ny, nz) || !solid(vw.get(nx, ny, nz))) continue;
      ok.add(nx, ny, nz); queue.push(nx, ny, nz);
    }
  }
  const floatingByPart = new Map();
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (!solid(idx) || ok.has(x, y, z)) return;
    const l = floatingByPart.get(pi) ?? [];
    l.push([x, y, z]);
    floatingByPart.set(pi, l);
  });
  const findings = [];
  for (const [pi, cells] of floatingByPart) findings.push(finding('M3', partId(pi), stage, cells.length, cells, `${cells.length} cell(s) connect to neither the ground nor a declared floating group`));
  // each floating group: one face-connected component; the rest are spurs
  const groupStats = [];
  groups.forEach((g, gi) => {
    const cells = groupCells[gi];
    const inG = new CellSet();
    for (let i = 0; i < cells.length; i += 3) inG.add(cells[i], cells[i + 1], cells[i + 2]);
    const seen = new CellSet();
    const comps = [];
    for (let i = 0; i < cells.length; i += 3) {
      const x0 = cells[i], y0 = cells[i + 1], z0 = cells[i + 2];
      if (seen.has(x0, y0, z0)) continue;
      const comp = [x0, y0, z0];
      seen.add(x0, y0, z0);
      for (let q = 0; q < comp.length; q += 3) {
        const x = comp[q], y = comp[q + 1], z = comp[q + 2];
        for (const [dx, dy, dz] of DIRS6) { const nx = x + dx, ny = y + dy, nz = z + dz; if (inG.has(nx, ny, nz) && seen.add(nx, ny, nz)) comp.push(nx, ny, nz); }
      }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length);
    const spur = comps.slice(1).flatMap((c) => { const o = []; for (let i = 0; i < c.length; i += 3) o.push([c[i], c[i + 1], c[i + 2]]); return o; });
    groupStats.push({ parts: [...g].map(partId), cells: cells.length / 3, components: comps.length });
    if (spur.length) findings.push(finding('M3:floating_spur', partId([...g][0]), stage, spur.length, spur, `${spur.length} cell(s) of floating group [${[...g].map(partId).join(', ')}] are not connected to the group (${comps.length} components)`));
  });
  if (gravity.length) {
    const by = new Map();
    for (const [x, y, z, pi] of gravity) { const l = by.get(pi) ?? []; l.push([x, y, z]); by.set(pi, l); }
    for (const [pi, cells] of by) findings.push(finding('M3', partId(pi), stage, cells.length, cells, `${cells.length} gravity block(s) without support under them`));
  }
  const floating = [...floatingByPart.values()].reduce((a, l) => a + l.length, 0);
  return { findings, metrics: { floatingCells: floating, groups: groupStats, gravity: gravity.length } };
}

// ------------------------------------------------------------------ block light (M5)

/** Block light from every written emitter (and the dump's own light when the world carries it). */
function blockLight(vw) {
  if (vw.lightAt) return { at: vw.lightAt };
  const P = vw.pal;
  const L = new CellBytes();
  const buckets = Array.from({ length: 16 }, () => []);
  vw.eachWritten((x, y, z, idx) => { const e = P.emit[idx]; if (e > 0 && e > L.get(x, y, z)) { L.set(x, y, z, e); buckets[e].push(x, y, z); } });
  for (let lv = 15; lv >= 2; lv--) {
    const b = buckets[lv];
    for (let i = 0; i < b.length; i += 3) {
      const x = b[i], y = b[i + 1], z = b[i + 2];
      if (L.get(x, y, z) !== lv) continue;
      for (const [dx, dy, dz] of DIRS6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const n = vw.get(nx, ny, nz);
        if (P.opaque[n]) continue;
        const v = lv - P.cost[n];
        if (v > L.get(nx, ny, nz)) { L.set(nx, ny, nz, v); if (v >= 2) buckets[v].push(nx, ny, nz); }
      }
    }
  }
  return { at: (x, y, z) => L.get(x, y, z) };
}

// ------------------------------------------------------------------ the checker

/**
 * Check a region. `ir`, `survey` (ARSV), `blobs` (sha -> bytes), `volumes` (decoded ARVX), `meta` (the plan's
 * meta.json). Or `world` (a realised dump world) with `ir` and `meta` for the rule inputs. Options: `prefix` (M2/M3 after
 * each stage, default true), `rules` (a subset). Returns the report (kit/REGIONS.md "The checker report").
 */
export function checkRegion({ ir, survey, blobs, volumes = [], meta = null, world = null, prefix = true, rules = RULES, planId } = {}) {
  const t0 = performance.now();
  const ms = { perRule: {} };
  const findings = [];
  const prefixes = [];
  const time = (rule, fn) => { const t = performance.now(); const r = fn(); ms.perRule[rule] = Math.round((ms.perRule[rule] ?? 0) + performance.now() - t); return r; };
  const want = new Set(rules);
  let vw = world, clipped = {};
  if (!vw) {
    const filled = fillMissing(survey).columns;
    let tPrefix = 0, lastWritten = -1, lastSup = null;
    const built = buildVirtual({ ir, survey, filled, blobs, volumes, onStage: prefix ? (stage, w) => {
      if (stage === ir.stages[ir.stages.length - 1]) return;
      const t = performance.now();
      const si = ir.stages.indexOf(stage);
      const nodes = walkNodes(ir, meta, si);
      const start = ir.anchors?.entrance;
      const g = walkGraph(w, start ? [start] : []);
      const un = nodes.filter((n) => !nodeReached(g, n.at));
      // the support scan is extended only when the stage wrote cells (a lots-only stage adds boxes, not cells)
      const sup = w.written === lastWritten && lastSup ? lastSup : supportCheck(w, ir, stage);
      lastWritten = w.written; lastSup = sup;
      prefixes.push({ stage, M2: { nodes: nodes.length, reached: nodes.length - un.length, unreachable: un.map((n) => n.id) }, M3: { floatingCells: sup.metrics.floatingCells, spurs: sup.findings.filter((f) => f.rule === 'M3:floating_spur').reduce((a, f) => a + f.count, 0) } });
      for (const f of sup.findings) f.stage = stage;
      tPrefix += performance.now() - t;
    } : null });
    vw = built.vw; clipped = built.clipped;
    ms.build = Math.round(built.ms - tPrefix);
    ms.prefix = Math.round(tPrefix);
  }
  const P = vw.pal;
  const metrics = {};
  const lastStage = ir.stages[ir.stages.length - 1];
  const partStage = new Map(ir.parts.map((p) => [p.id, p.stage]));

  // ---- M1 claim containment (error)
  if (want.has('M1')) time('M1', () => {
    for (const [pid, n] of Object.entries(clipped)) findings.push(finding('M1', pid, partStage.get(pid), n, [], `${n} cell(s) of part ${pid} fall outside the claim (dropped by the evaluator, refused by the mod)`));
    const c = ir.claim;
    const inside = (x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
    for (const l of ir.lots ?? []) if (!inside(l.box.minX, l.box.minZ) || !inside(l.box.maxX, l.box.maxZ)) findings.push(finding('M1', l.part, l.stage, 1, [[l.box.minX, l.box.minY, l.box.minZ]], `lot ${l.id} leaves the claim`));
    for (const p of ir.paths ?? []) if (!inside(p.box.minX, p.box.minZ) || !inside(p.box.maxX, p.box.maxZ)) findings.push(finding('M1', p.part, p.stage, 1, [[p.box.minX, p.box.minY, p.box.minZ]], `path ${p.id} leaves the claim`));
    for (const [n, a] of Object.entries(ir.anchors ?? {})) if (!inside(a[0], a[2])) findings.push(finding('M1', null, null, 1, [a], `anchor ${n} is outside the claim`));
  });

  // ---- M2 reachability (player mover)
  let graph = null;
  const nodes = walkNodes(ir, meta, null);
  time('M2', () => {
    const start = ir.anchors?.entrance;
    graph = walkGraph(vw, start ? [start] : []);
    const perNode = {};
    const un = [];
    for (const n of nodes) { const r = nodeReached(graph, n.at); perNode[n.id] = r; if (!r) un.push(n); }
    metrics.M2 = { mover: 'player', nodes: nodes.length, reached: nodes.length - un.length, unreachable: un.map((n) => n.id), perNode, walkCells: graph.reached.length / 3 };
    if (want.has('M2')) {
      const byPart = new Map();
      for (const n of un) { const k = n.part ?? null; const l = byPart.get(k) ?? []; l.push(n); byPart.set(k, l); }
      for (const [part, l] of byPart) findings.push(finding('M2', part, part ? partStage.get(part) : lastStage, l.length, l.map((n) => n.at), `${l.length} node(s) not reachable from the entrance by the player mover: ${l.map((n) => n.id).slice(0, 8).join(', ')}`));
      if (!start) findings.push(finding('M2', null, null, 1, [], 'the region has no entrance anchor'));
    }
  });

  // ---- M3 support
  if (want.has('M3')) time('M3', () => {
    const sup = supportCheck(vw, ir, null);
    for (const f of sup.findings) { f.stage = f.part ? partStage.get(f.part) ?? null : null; findings.push(f); }
    metrics.M3 = sup.metrics;
  });

  // ---- the walk area: reached cells whose floor the region wrote (or walk-marked cells)
  const walkArea = [];
  const reachedArr = graph.reached;
  for (let i = 0; i < reachedArr.length; i += 3) {
    const x = reachedArr[i], y = reachedArr[i + 1], z = reachedArr[i + 2];
    if (vw.flags(x, y - 1, z) & F_WRITTEN) walkArea.push(x, y, z);
  }

  // ---- M4 fluid containment
  if (want.has('M4')) time('M4', () => {
    const byPart = new Map();
    vw.eachWritten((x, y, z, idx, f, pi) => {
      if (!P.air[idx]) return;
      for (const [dx, dy, dz] of DIRS6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (vw.flags(nx, ny, nz) & F_WRITTEN) continue;
        const n = vw.get(nx, ny, nz);
        if (P.fluid[n]) { const l = byPart.get(pi) ?? []; l.push([x, y, z]); byPart.set(pi, l); return; }
      }
    });
    let n = 0;
    for (const [pi, cells] of byPart) { n += cells.length; findings.push(finding('M4', ir.parts[pi]?.id ?? null, ir.parts[pi]?.stage ?? null, cells.length, cells, `${cells.length} cleared cell(s) open onto water or lava (the fluid would flow in)`)); }
    metrics.M4 = { breaches: n };
  });

  // ---- M5 spawn safety
  if (want.has('M5')) time('M5', () => {
    const light = blockLight(vw);
    let dark = 0;
    const sample = [];
    for (let i = 0; i < walkArea.length; i += 3) {
      const x = walkArea[i], y = walkArea[i + 1], z = walkArea[i + 2];
      if (!P.spawn[vw.get(x, y - 1, z)]) continue;
      if (light.at(x, y, z) > 0) continue;
      dark++;
      if (sample.length < 20) sample.push([x, y, z]);
    }
    const area = walkArea.length / 3;
    metrics.M5 = { darkSpawnable: dark, walkArea: area, share: area ? dark / area : 0 };
    if (dark) findings.push(finding('M5', null, null, dark, sample, `${dark} of ${area} walk cell(s) are dark (block light 0) and spawnable (${(100 * dark / Math.max(1, area)).toFixed(1)}%)`));
    // caverns: no dark spawnable floor cell inside
    for (const [pid, m] of Object.entries(meta?.parts ?? {})) for (const cv of m.caverns ?? []) {
      const b = cv.bounds;
      const cells = [];
      for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
        const y = cv.floorY;
        if (!(vw.flags(x, y - 1, z) & F_WRITTEN) && !(vw.flags(x, y, z) & F_WRITTEN)) continue;
        if (P.passable[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)] && P.spawn[vw.get(x, y - 1, z)] && light.at(x, y, z) === 0) cells.push([x, y, z]);
      }
      if (cells.length) findings.push(finding('M5', pid, partStage.get(pid), cells.length, cells, `cavern ${pid}: ${cells.length} dark spawnable floor cell(s) (its lights do not cover it)`));
    }
  });

  // ---- M6 path clearance (and utility corridors)
  if (want.has('M6')) time('M6', () => {
    const byPart = new Map();
    vw.eachWritten((x, y, z, idx, f, pi) => {
      if (!(f & F_WALK) || P.air[idx]) return;
      if (P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)]) return;
      if (vw.lotAt(x, y + 1, z)) return;
      const l = byPart.get(pi) ?? []; l.push([x, y + 1, z]); byPart.set(pi, l);
    });
    for (const [pi, cells] of byPart) findings.push(finding('M6', ir.parts[pi]?.id ?? null, ir.parts[pi]?.stage ?? null, cells.length, cells, `${cells.length} walk cell(s) without 2 cells of head room`));
    for (const u of ir.utility ?? []) {
      const blocked = [];
      const pts2 = u.points.map((p) => [p[0], p[2]]);
      const { cells } = centreCells(pts2);
      const offs = crossOffsets(u.width);
      for (const c of cells) {
        const a = pts2[Math.min(c.seg, pts2.length - 1)], b = pts2[Math.min(c.seg + 1, pts2.length - 1)];
        const r = rightOf(segmentAxis(a, b));
        const t = c.seg < u.points.length - 1 ? u.points[c.seg][1] : u.points[u.points.length - 1][1];
        for (const k of offs) for (let h = 0; h < u.height; h++) {
          const x = c.x + r[0] * k, z = c.z + r[1] * k, y = t + h;
          if ((vw.flags(x, y, z) & F_WRITTEN) && P.solid[vw.get(x, y, z)]) blocked.push([x, y, z]);
        }
      }
      if (blocked.length) findings.push(finding('M6', u.part, u.stage, blocked.length, blocked, `utility corridor ${u.id}: ${blocked.length} cell(s) written solid inside it`));
    }
  });

  // ---- M7 slope and rise
  if (want.has('M7')) time('M7', () => {
    for (const [pid, m] of Object.entries(meta?.paths ?? {})) {
      const cells = m.cells ?? [];
      const bad = [];
      if (m.kind === 'stair') {
        let flight = 0, flat = 0;
        for (let i = 1; i < cells.length; i++) {
          const dy = cells[i][1] - cells[i - 1][1];
          if (Math.abs(dy) > 1) bad.push(cells[i]);
          if (dy !== 0) { flight++; flat = 0; } else { flat++; if (flat >= 2) flight = 0; }
          if (flight > (m.landingEvery ?? 8)) { bad.push(cells[i]); flight = 0; }
        }
      } else if (m.kind === 'graded') {
        for (let i = 4; i < cells.length; i++) if (Math.abs(cells[i][1] - cells[i - 4][1]) > 1) bad.push(cells[i]);
      } else if (m.kind === 'bridge') {
        for (let i = 1; i < cells.length; i++) if (Math.abs(cells[i][1] - cells[i - 1][1]) > 1) bad.push(cells[i]);
      }
      if (bad.length) findings.push(finding('M7', m.part, m.stage, bad.length, bad, `${m.kind} ${pid}: ${bad.length} step(s) over the rise limit (rise <= 1 per step, a landing every ${m.landingEvery ?? 8}; grade <= 1 in 4)`));
    }
  });

  // ---- M8 edge protection
  if (want.has('M8')) time('M8', () => {
    let guarded = 0, open = 0;
    const sample = [];
    const dropBelow = (x, y, z) => { // cells of fall from feet level y in column (x, z)
      for (let d = 1; d <= 4; d++) { const s = vw.get(x, y - d, z); if (!P.passable[s] || P.water[s]) return d - 1; }
      return 99;
    };
    for (let i = 0; i < walkArea.length; i += 3) {
      const x = walkArea[i], y = walkArea[i + 1], z = walkArea[i + 2];
      let isEdge = false, isOpen = false;
      for (const [dx, dz] of DIRS4) {
        const nx = x + dx, nz = z + dz;
        const n = vw.get(nx, y, nz);
        if (vw.lotAt(nx, y, nz)) continue;
        if (P.passable[n]) {
          if (dropBelow(nx, y, nz) > 3 && !graph.standAt(nx, y + 1, nz)) { isEdge = true; isOpen = true; }
        } else if (P.barrier[n] || (P.solid[n] && !P.passable[vw.get(nx, y + 1, nz)])) {
          // a rail or wall: is there a drop behind it (beyond it, or under it)?
          const bx = nx + dx, bz = nz + dz;
          if (dropBelow(nx, y - 1, nz) > 3 || (P.passable[vw.get(bx, y, bz)] && dropBelow(bx, y, bz) > 3)) isEdge = true;
        }
      }
      if (!isEdge) continue;
      if (isOpen) { open++; if (sample.length < 200) sample.push([x, y, z]); } else guarded++;
    }
    const edges = guarded + open;
    metrics.M8 = { edgeCells: edges, guarded, unguarded: open, share: edges ? guarded / edges : 1, unguardedSample: sample.slice(0, 200) };
    if (open) findings.push(finding('M8', null, null, open, sample, `${open} of ${edges} walk cell(s) beside a drop over 3 have no barrier of at least 1.5 (${(100 * guarded / Math.max(1, edges)).toFixed(1)}% guarded)`));
  });

  // ---- M9 lot pads
  if (want.has('M9')) time('M9', () => {
    for (const l of ir.lots ?? []) {
      const b = l.box;
      const bad = [];
      for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
        if (!P.floor[vw.get(x, b.minY - 1, z)]) bad.push([x, b.minY - 1, z]);
      }
      if (bad.length) findings.push(finding('M9', l.part, partStage.get(l.part), bad.length, bad, `lot ${l.id}: ${bad.length} pad column(s) without a solid top at floorY - 1 = ${b.minY - 1}${l.pad?.fill === 'none' ? ' (pad fill none: the mass under it must be solid)' : ''}`));
      if (l.max && (l.max[0] > 96 || l.max[1] > 64 || l.max[2] > 96)) findings.push(finding('M9', l.part, l.stage, 1, [], `lot ${l.id}: max ${l.max.join('x')} is over the 96x64x96 child cap`));
    }
  });

  // ---- M10 bridge supports
  if (want.has('M10')) time('M10', () => {
    const per = [];
    for (const [pid, m] of Object.entries(meta?.paths ?? {})) {
      if (m.kind !== 'bridge') continue;
      const sup = m.supports ?? [];
      let longest = 0;
      for (let i = 1; i < sup.length; i++) longest = Math.max(longest, sup[i] - sup[i - 1]);
      const row = { path: pid, maxSpan: m.maxSpan, longest, style: m.style, ends: !!m.ends };
      if (longest > m.maxSpan) findings.push(finding('M10', m.part, m.stage, 1, [m.cells[0]], `bridge ${pid}: an unsupported span of ${longest} (maxSpan ${m.maxSpan})`));
      if (m.ends) {
        const cells = m.cells, offs = crossOffsets(m.width);
        const bearing = (from, to) => {
          let n = 0;
          for (let i = from; i <= to; i++) {
            const [x, y, z] = cells[i], r = m.right?.[i] ?? [1, 0];
            for (const k of offs) {
              const bx = x + r[0] * k, bz = z + r[1] * k;
              const below = vw.get(bx, y - 1, bz);
              const pi = vw.partAt(bx, y - 1, bz);
              if (P.solid[below] && !(pi >= 0 && ir.parts[pi]?.id === m.part)) n++;
            }
          }
          return n;
        };
        const a = bearing(0, Math.min(1, cells.length - 1)), b = bearing(Math.max(0, cells.length - 2), cells.length - 1);
        row.bearing = [a, b];
        if (a < 4 || b < 4) findings.push(finding('M10', m.part, m.stage, (a < 4) + (b < 4), [a < 4 ? cells[0] : cells[cells.length - 1]], `bridge ${pid} ('ends'): its ends bear on ${a} and ${b} solid cell(s) of other parts (at least 2x2 = 4 each)`));
        if (cells.length - 1 > m.maxSpan) findings.push(finding('M10', m.part, m.stage, 1, [cells[0]], `bridge ${pid} ('ends'): it spans ${cells.length - 1}, more than maxSpan ${m.maxSpan}`));
      }
      per.push(row);
    }
    metrics.M10 = per;
  });

  // ---- M11 terrain-op sanity, M12 budget (metrics; findings near the world's limits)
  if (want.has('M11') || want.has('M12')) time('M11', () => {
    let removed = 0, added = 0, low = [], high = [];
    vw.eachWritten((x, y, z, idx) => {
      if (P.air[idx]) removed++; else added++;
      if (y < WORLD_MIN_Y + 8 && low.length < 20) low.push([x, y, z]);
      if (y > WORLD_MAX_Y - 8 && high.length < 20) high.push([x, y, z]);
    });
    metrics.M11 = { removed, added };
    metrics.M12 = { cells: removed + added, budget: ir.budget, estSeconds: Math.round((removed + added) / 15000) };
    if (want.has('M11') && low.length) findings.push(finding('M11', null, null, low.length, low, 'cells within 8 of the world bottom'));
    if (want.has('M11') && high.length) findings.push(finding('M11', null, null, high.length, high, 'cells within 8 of the build limit'));
    if (want.has('M12') && ir.budget && removed + added > (ir.budget.cells ?? Infinity) * 1.5 + 1000) findings.push(finding('M12', null, null, removed + added, [], `the virtual world writes ${removed + added} cells, over 1.5x the plan's budget ${ir.budget.cells}`));
  });

  // ---- M13 palette validity (error)
  if (want.has('M13')) time('M13', () => {
    const bad = new Map();
    const check = (s, where) => {
      if (s === null || s === undefined) return;
      let ok = false;
      try { ok = blockState(s) === s; } catch { ok = false; }
      if (!ok) bad.set(where, s);
    };
    for (const [r, s] of Object.entries(ir.roles ?? {})) check(s, `role ${r}`);
    for (const p of ir.parts) for (const o of p.ops) {
      if (o.op === 'columns') for (const m of o.materials ?? []) check(m, `part ${p.id}`);
      else if (o.material && typeof o.material === 'object') { for (const c of o.material.rule.rule) check(c.mat, `part ${p.id}`); check(o.material.rule.default, `part ${p.id}`); }
      else check(o.material, `part ${p.id}`);
    }
    for (const [where, s] of bad) findings.push(finding('M13', where.startsWith('part ') ? where.slice(5) : null, null, 1, [], `${where}: '${s}' is not a vanilla block state`));
  });

  // ---- M14 parts (uniqueness: error)
  if (want.has('M14')) time('M14', () => {
    const seen = new Map();
    for (const p of ir.parts) seen.set(p.id, (seen.get(p.id) ?? 0) + 1);
    for (const [id, n] of seen) if (n > 1) findings.push(finding('M14', id, null, n, [], `part id '${id}' is used ${n} times (part ids are unique)`));
    for (const p of ir.parts) if (!p.id || !Array.isArray(p.ops)) findings.push(finding('M14', p.id ?? null, null, 1, [], 'an op outside a part (every op belongs to a part)'));
  });

  findings.sort((a, b) => (RULES.indexOf(a.rule.split(':')[0]) - RULES.indexOf(b.rule.split(':')[0])) || a.rule.localeCompare(b.rule) || String(a.part).localeCompare(String(b.part)) || String(a.stage).localeCompare(String(b.stage)));
  const errors = findings.filter((f) => f.severity === 'error').length;
  ms.total = Math.round(performance.now() - t0);
  return {
    format: 1, ...(planId ? { planId } : {}), irSha: null, mode: world ? 'realised' : 'virtual', resolution: { coarse: 1, fullPasses: 0 },
    ok: errors === 0, errors, warnings: findings.length - errors, findings, metrics, prefix: prefixes, ms, nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, ref: n.ref, at: n.at })),
    _world: vw,
  };
}

/** One line per finding plus the totals (summary.txt). */
export function summaryText(report) {
  const lines = report.findings.map((f) => `${f.severity.toUpperCase()} ${f.rule}${f.part ? ` [${f.part}]` : ''}${f.stage ? ` (${f.stage})` : ''}: ${f.message}`);
  lines.push(`${report.errors} error(s), ${report.warnings} warning(s); ${report.ms.total} ms`);
  return `${lines.join('\n')}\n`;
}
