// The macro checker M1-M14 (docs/CONTRACT.md 6b §3.2, steward-mc A5B §3, SETTLEMENTS §11) on the virtual world
// (vworld.mjs), with M2 as the `player` mover and M2/M3 after every stage prefix. Severities: M1, M13 and M14's
// uniqueness are errors; everything else is a warning (6b promotes nothing). The same rules run on a realised world
// (two ARWD dumps) for the scenario metrics.
import { blockState } from './program.mjs';
import { F_WALK, F_WRITTEN, buildVirtual } from './vworld.mjs';
import { fillMissing } from './plan.mjs';
import { parseReachInput, reachFor, unionColumns } from './reach.mjs';
import { besideRules } from './checkBeside.mjs';
import { reviseRules } from './revise.mjs';
import { asColumns } from './pack.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from './geom.mjs';
import { decodeVoxels } from './voxels.mjs';
import { VC, classAt, decodeArvx } from './volume.mjs';
import { windowGrade } from './passes/route.mjs';
import { wallRules } from './checkWalls.mjs';
import { ropeRules } from './checkRopes.mjs';
// (6c T3) bridges (M10:bridge, T3a) and tunnels (M3:tunnel, M4:tunnel, T3b)
import { bridgeRules } from './checkBridges.mjs';
import { tunnelRules } from './checkTunnels.mjs';
// (7a CW) catwalks (M10:catwalk)
import { catwalkRules } from './checkCatwalks.mjs';
import { climbRules } from './checkClimbs.mjs'; // (7a CL)
import { rockStairRules } from './checkRockStairs.mjs'; // (7a RK)
import { spiralRules } from './checkSpirals.mjs'; // (7a SA)
import { liftRules } from './checkLifts.mjs'; // (7a LF)
// (6c H) the fluid rules: M25 containment per body and wet write, M20 fire for lava bodies (checkFluids.mjs, H-core)
import { fluidRules, floodRule, floodMessage, bodiesOf } from './checkFluids.mjs';
// (7a FB) M16 flood behaviour (a warning): floodRule over the walk graph's cells, the walk-marked floors and the lot boxes
import { FLUID_OP, fromRuns } from '../fluids/body.mjs';
// (6c VOC-b) the vocabulary rules: M26 rarity, M27 vocabulary misuse, M20 widened (checkVocab.mjs)
import { vocabRules } from './checkVocab.mjs';
import { formRulesVw } from './checkForms.mjs';


export const RULES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12', 'M13', 'M14', 'M22', 'M23', 'M24', 'M17', 'M20', 'M25', 'M26', 'M27', 'M18', 'M19', 'M28', 'M29', 'M16'];
/** (6c V) The parts a flat village's components emit (the M1 lot-box rule applies to them only). */
const VILLAGE_PARTS = /^(square|green|verges|lanes|props_[a-z]+)$/;
// (6c H) M25 (containment) and M20 (fire, run for lava bodies only) are errors
// ((6c D3) M28:beside, a districts plan's writes into a standing town's claim, is an error)
// ((6d RV) M29:revision, a revision's write over what it must keep off, or a non-additive edit, is an error)
const ERRORS = new Set(['M1', 'M13', 'M14', 'M20', 'M25', 'M28', 'M29']);
// (6c VOC-b) per sub-rule severities over the rule's own: M27's state and convert are errors (the rest of M27 and M26 warnings); M20 (b),
// natural lava near a plan-written flammable, is a warning
const SUB_SEVERITY = Object.freeze({ 'M27:state': 'error', 'M27:convert': 'error', 'M20:natural': 'warning' });
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

/** (M4 on a realised world) "x,y,z" -> fluid of every plan fluid body's own cells: its sources, spill and predicted flowing cells. */
function ownFluidCells(ir) {
  const own = new Map();
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) {
    if (o.op !== FLUID_OP) continue;
    for (const [x, y, z] of [...fromRuns(o.cells), ...fromRuns(o.spill)]) own.set(`${x},${y},${z}`, o.fluid);
    for (const [x, y, z] of o.predicted ?? []) own.set(`${x},${y},${z}`, o.fluid);
  }
  return own;
}
function finding(rule, part, stage, count, sample, message) {
  return { rule, severity: SUB_SEVERITY[rule] ?? (ERRORS.has(rule.split(':')[0]) && !(rule === 'M14' && /warning/.test(message)) ? 'error' : 'warning'), part: part ?? null, stage: stage ?? null, count, sample: sample.slice(0, 20), message };
}

// ------------------------------------------------------------------ the walk graph (M2, `player` mover)

/**
 * The `player` mover (SETTLEMENTS §11): feet and head cells passable, a floor under the feet (or water to swim on, or a
 * climbable cell); steps of 1 up (with head room for the jump), falls of at most 3, ladders and vines up and down, doors
 * and gates open. Lot boxes are obstacles (their interiors are declared, not known).
 */
export function walkGraph(vw, starts, { mover = 'player', reach = false } = {}) {
  const P = vw.pal, c = vw.claim;
  // ((6c D3) `reach`: a reach plan's join walks on into the reach columns (the route metric's graph only))
  const inArea = reach && vw.inWalk ? (x, z) => vw.inWalk(x, z) : (x, z) => vw.inClaim(x, z);
  const cache = new Map();
  // (6c V) the `villager` mover (CONTRACT V §6): the player graph without ladders, scaffolding or bubble columns, without falls
  // over 1, with only wooden doors passable (fence gates and trapdoors closed), and no swimming
  const V = mover === 'villager';
  const pass = V ? P.vpass : P.passable;
  const fallMax = V ? 1 : 3;
  const standAt = (x, y, z) => {
    if (vw.lotAt(x, y, z) || vw.lotAt(x, y + 1, z)) return false;
    const a = vw.get(x, y, z), b = vw.get(x, y + 1, z);
    if (!pass[a] || !pass[b] || P.lava[a] || P.lava[b]) return false;
    if (!V && P.climb[a]) return true;
    const f = vw.get(x, y - 1, z);
    if (P.floor[f] && !(V && (P.bubble[f] || P.barrier[f]))) return true; // a villager can't stand on a 1.5-tall fence, wall or gate
    if (P.half[f]) return true; // (7a K1b) on a bottom slab: its surface is half a block lower
    return !V && P.water[f] && P.air[a]; // swimming on the surface (the player only)
  };
  const stands = (x, z) => {
    // (a reach column outside the claim keys apart; without `reach` the key is main's, so a plan without a reach reads the same)
    const k = reach && !vw.inClaim(x, z) ? `${x},${z}` : (x - c.minX) + (z - c.minZ) * vw.W;
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
    if (!inArea(x, z)) continue;
    for (const yy of stands(x, z)) if (Math.abs(yy - y) <= 2) push(x, yy, z);
  }
  for (let q = 0; q < queue.length; q += 3) {
    const x = queue[q], y = queue[q + 1], z = queue[q + 2];
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx, nz = z + dz;
      if (!inArea(nx, nz)) continue;
      for (const ny of stands(nx, nz)) {
        if (ny > y + 1 || ny < y - fallMax) continue;
        // a step up needs head room for the jump, unless it is onto a stairs block (walked up without jumping)
        // (7a K1b) half-slab steps: the real rise between the surfaces (a bottom slab's is half a block lower) decides: at most
        // 0.5 is a step (no jump, as vanilla's 0.6 step height), over 1.125 no mover makes it (vanilla's jump), between is a jump
        const rise = ny === y + 1 || ny === y ? (ny - y) * 2 + (P.half[vw.get(x, y - 1, z)] ? 1 : 0) - (P.half[vw.get(nx, ny - 1, nz)] ? 1 : 0) : 0; // half blocks
        if (rise > 2) continue;
        if (ny === y + 1 && rise > 1 && !pass[vw.get(x, y + 2, z)] && !P.stairs[vw.get(nx, ny - 1, nz)]) continue;
        if (ny < y) { let ok = true; for (let yy = ny + 2; yy <= y + 1; yy++) if (!pass[vw.get(nx, yy, nz)]) { ok = false; break; } if (!ok) continue; }
        push(nx, ny, nz);
      }
    }
    if (V) continue; // no climbing
    // ((7a LF) bubble columns: an up column (drag=false, over soul sand) carries the player up through it to its surface, a down column
    // (drag=true, over magma) down to its floor; neither the other way)
    const here = vw.get(x, y, z);
    if (P.bubble[here] && /drag=false/.test(P.states[here]) && P.passable[vw.get(x, y + 1, z)]) push(x, y + 1, z);
    const under = vw.get(x, y - 1, z);
    if (P.bubble[under] && !/drag=false/.test(P.states[under]) && (P.bubble[here] || P.air[here])) push(x, y - 1, z);
    // climbing
    if (P.climb[here] || P.climb[vw.get(x, y + 1, z)]) {
      if (P.passable[vw.get(x, y + 2, z)] && (P.climb[vw.get(x, y + 1, z)] || standAt(x, y + 1, z))) push(x, y + 1, z);
    }
    if (P.climb[vw.get(x, y - 1, z)] || (P.climb[here] && P.passable[vw.get(x, y - 1, z)])) if (P.passable[vw.get(x, y - 1, z)]) push(x, y - 1, z);
  }
  return { seen, reached, stands, standAt };
}

/** Is a node (feet cell) reached: the cell, or a 4-neighbour, within 1 in y. */
export function nodeReached(g, [x, y, z]) {
  for (const [dx, dz] of [[0, 0], ...DIRS4]) for (let dy = -1; dy <= 1; dy++) if (g.seen.has(x + dx, y + dy, z + dz)) return true;
  return false;
}

/** The M2 nodes: lot entrances, anchors (not cam_*), and floating anchors, existing by `stageIdx` (null: all). */
export function walkNodes(ir, meta, stageIdx = null) {
  const si = (s) => ir.stages.indexOf(s);
  const partStage = new Map(ir.parts.map((p) => [p.id, si(p.stage)]));
  const nodes = [];
  for (const l of ir.lots ?? []) {
    // a lot's entrance is a node from the lot's own stage on (its building stands from then)
    const ps = Math.max(partStage.get(l.part) ?? 0, si(l.stage));
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

export function supportCheck(vw, ir, stage) {
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
    // ((6c F3) a stalactite hangs: pointed dripstone pointing down is held by the cell above it, a sturdy block or more dripstone pointing
    // down (SpeleothemBlock.isValidSpeleothemPlacement); it falls only when that support goes)
    if (P.gravity[idx] && (/^minecraft:pointed_dripstone\[.*vertical_direction=down/.test(P.states[idx]) ? !solid(vw.get(x, y + 1, z)) : !solid(vw.get(x, y - 1, z)))) gravity.push([x, y, z, pi]);
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
    let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let i = 0; i < cells.length; i += 3) {
      inG.add(cells[i], cells[i + 1], cells[i + 2]);
      bx0 = Math.min(bx0, cells[i]); bx1 = Math.max(bx1, cells[i]); by0 = Math.min(by0, cells[i + 1]); by1 = Math.max(by1, cells[i + 1]); bz0 = Math.min(bz0, cells[i + 2]); bz1 = Math.max(bz1, cells[i + 2]);
    }
    // the group's cells connect through each other or through solid cells other non-floating parts wrote inside the
    // group's box (a lot pad or a deck laid on the island is part of it); only the group's own cells are counted
    const via = (x, y, z) => {
      if (inG.has(x, y, z)) return true;
      if (x < bx0 || x > bx1 || y < by0 || y > by1 || z < bz0 || z > bz1) return false;
      if (!(vw.flags(x, y, z) & F_WRITTEN) || !solid(vw.get(x, y, z))) return false;
      const pi = vw.partAt(x, y, z);
      return pi < 0 || groupOf(pi) < 0;
    };
    const seen = new CellSet();
    const comps = [];
    for (let i = 0; i < cells.length; i += 3) {
      const x0 = cells[i], y0 = cells[i + 1], z0 = cells[i + 2];
      if (seen.has(x0, y0, z0)) continue;
      const comp = [x0, y0, z0];
      seen.add(x0, y0, z0);
      for (let q = 0; q < comp.length; q += 3) {
        const x = comp[q], y = comp[q + 1], z = comp[q + 2];
        for (const [dx, dy, dz] of DIRS6) { const nx = x + dx, ny = y + dy, nz = z + dz; if (via(nx, ny, nz) && seen.add(nx, ny, nz)) comp.push(nx, ny, nz); }
      }
      const own = [];
      for (let q = 0; q < comp.length; q += 3) if (inG.has(comp[q], comp[q + 1], comp[q + 2])) own.push(comp[q], comp[q + 1], comp[q + 2]);
      comps.push(own);
    }
    comps.sort((a, b) => b.length - a.length);
    const spur = comps.slice(1).flatMap((c) => { const o = []; for (let i = 0; i < c.length; i += 3) o.push([c[i], c[i + 1], c[i + 2]]); return o; });
    groupStats.push({ parts: [...g].map(partId), cells: cells.length / 3, components: comps.length });
    if (spur.length) findings.push(finding('M3:floating_spur', partId([...g][0]), stage, spur.length, spur, `${spur.length} cell(s) of floating group [${[...g].map(partId).join(', ')}] are not connected to the group (${comps.length} components)`));
  });
  if (gravity.length) {
    const by = new Map();
    for (const [x, y, z, pi] of gravity) { const l = by.get(pi) ?? []; l.push([x, y, z]); by.set(pi, l); }
    for (const [pi, cells] of by) findings.push(finding('M3:gravity', partId(pi), stage, cells.length, cells, `${cells.length} gravity block(s) without support under them`));
  }
  const floating = [...floatingByPart.values()].reduce((a, l) => a + l.length, 0);
  return { findings, metrics: { floatingCells: floating, groups: groupStats, gravity: gravity.length } };
}

// ------------------------------------------------------------------ block light (M5)

/** Block light from every written emitter (and the dump's own light when the world carries it). */
export function blockLight(vw) {
  if (vw.lightAt) return { at: vw.lightAt, lit: null };
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
  // (6c F1) every cell lit at 11 or more (M17's reach), as x, y, z, level
  const lit = [];
  for (const [k, sec] of L.m) {
    const sy = (k % 512) - 256, rest = Math.floor(k / 512), sz = (rest % 262144) - 131072, sx = Math.floor(rest / 262144) - 131072;
    for (let o = 0; o < 4096; o++) if (sec[o] >= 11) lit.push(sx * 16 + (o & 15), sy * 16 + (o >> 8), sz * 16 + ((o >> 4) & 15), sec[o]);
  }
  return { at: (x, y, z) => L.get(x, y, z), lit };
}

// ------------------------------------------------------------------ (6c F1) M3 overhangs, M17 melt, kept cells

/**
 * (6c F3) The grown forms' generators: a canopy's underside, a cap's rim and a stalactite overhang by design, so M3:overhang (F1's
 * ledge rule) leaves them out; M3's support (no floating cell) still holds them (CONTRACT F3 as built).
 */
export const GROWN_GENERATORS = new Set(['giantTree', 'giantMushroom', 'coral', 'roots', 'stalactites']);
/** The parts of generated forms (not floating groups: an island's underside overhangs by design; not F3's grown forms). */
function formPartIndexes(ir) {
  const floating = new Set((ir.floating ?? []).flatMap((f) => f.parts));
  const ids = new Set((ir.forms ?? []).filter((f) => !GROWN_GENERATORS.has(f.generator)).map((f) => f.part ?? f.id).filter((id) => !floating.has(id)));
  return new Set(ir.parts.map((p, i) => (ids.has(p.id) ? i : -1)).filter((i) => i >= 0));
}

/**
 * M3 overhangs (6c F1 §4): a written solid cell of a form part with no solid cell under it that is more than OVERHANG_LIMIT
 * horizontally (Chebyshev) from every solid cell one layer down: a ledge without a buttress.
 */
export const OVERHANG_LIMIT = 4;
function overhangCheck(vw, ir) {
  const P = vw.pal;
  const forms = formPartIndexes(ir);
  const solid = (x, y, z) => { const i = vw.get(x, y, z); return P.solid[i] && !P.fluid[i]; };
  const byPart = new Map();
  let max = 0, cells = 0;
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (!forms.has(pi) || !P.solid[idx] || P.fluid[idx]) return;
    cells++;
    if (solid(x, y - 1, z)) return;
    let d = OVERHANG_LIMIT + 1;
    for (let r = 1; r <= OVERHANG_LIMIT && d > OVERHANG_LIMIT; r++) {
      for (let dx = -r; dx <= r && d > OVERHANG_LIMIT; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === r && solid(x + dx, y - 1, z + dz)) { d = r; break; }
      }
    }
    if (d > max) max = d;
    if (d > OVERHANG_LIMIT) { const l = byPart.get(pi) ?? []; l.push([x, y, z]); byPart.set(pi, l); }
  });
  const findings = [];
  for (const [pi, l] of byPart) findings.push(finding('M3:overhang', ir.parts[pi]?.id ?? null, ir.parts[pi]?.stage ?? null, l.length, l, `${l.length} cell(s) overhang the layer under them by more than ${OVERHANG_LIMIT} with no buttress`));
  return { findings, metrics: { formCells: cells, maxOverhang: Math.min(max, OVERHANG_LIMIT + 1), overhangCells: [...byPart.values()].reduce((a, l) => a + l.length, 0) } };
}

/** The decoded volumes the IR names (from `volumes`, else decoded from the IR's side blobs): Map(volume name -> decoded ARVX). */
function irVolumes(ir, volumes, blobs) {
  const out = new Map();
  for (const [name, v] of Object.entries(ir.volumes ?? {})) {
    let d = (volumes ?? []).find((x) => x.sha === v.sha) ?? null;
    if (!d && blobs) {
      const b = ir.blobs?.[v.blob];
      const bytes = b ? (typeof blobs === 'function' ? blobs(b.sha) : blobs instanceof Map ? blobs.get(b.sha) : blobs[b.sha]) : null;
      if (bytes) d = decodeArvx(bytes);
    }
    if (d) out.set(name, d);
  }
  return out;
}

/** (6c F1) The melt thresholds of 26.3 (IceBlock / SnowLayerBlock randomTick): ice melts at block light over 11 - its dampening (1). */
export const MELT = Object.freeze({ ice: 10, snow: 11 });

// ------------------------------------------------------------------ the checker

/**
 * Check a region. `ir`, `survey` (ARSV), `blobs` (sha -> bytes), `volumes` (decoded ARVX), `meta` (the plan's
 * meta.json). Or `world` (a realised dump world) with `ir` and `meta` for the rule inputs. Options: `prefix` (M2/M3 after
 * each stage, default true), `rules` (a subset). Returns the report (kit/REGIONS.md "The checker report").
 */
export function checkRegion({ ir, survey, blobs, volumes = [], meta = null, world = null, prefix = true, rules = RULES, planId, besideReach = null, standing = null, boundLots = false } = {}) {
  const t0 = performance.now();
  const ms = { perRule: {} };
  const findings = [];
  const prefixes = [];
  const time = (rule, fn) => { const t = performance.now(); const r = fn(); ms.perRule[rule] = Math.round((ms.perRule[rule] ?? 0) + performance.now() - t); return r; };
  const want = new Set(rules);
  let vw = world, clipped = {};
  // ((6c D3) a reach plan is built over the reach frame's survey (its reach columns lie in the town's claim); `besideReach`: the plan's
  // reach inputs, parsed, the standing data M28 reads)
  const BR = besideReach && ir.reach ? reachFor(parseReachInput(besideReach), ir.reach.standing) : null;
  if (!vw && ir.reach && BR) survey = unionColumns(fillMissing(survey).columns, asColumns(BR.survey), [ir.claim.minX, ir.claim.minZ, ir.claim.maxX, ir.claim.maxZ], BR.standing.claim);
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
    // ((6c D3) a reach plan's join paths reach into the town's claim: M28:beside judges their cells)
    for (const p of ir.paths ?? []) if ((!inside(p.box.minX, p.box.minZ) || !inside(p.box.maxX, p.box.maxZ)) && !(ir.reach && p.part === 'route_join')) findings.push(finding('M1', p.part, p.stage, 1, [[p.box.minX, p.box.minY, p.box.minZ]], `path ${p.id} leaves the claim`));
    for (const [n, a] of Object.entries(ir.anchors ?? {})) if (!inside(a[0], a[2])) findings.push(finding('M1', null, null, 1, [a], `anchor ${n} is outside the claim`));
    // ((6c FL) K5 for road items, which no op writes: a road's cells (its centre line and width) inside a lot box; a street is laid off
    // every lot box + 1, as V lays it, so this fires only on a broken layout (FL's lotOnStreet))
    if ((ir.lots ?? []).length && (ir.roads ?? []).length) {
      for (const rd of ir.roads) {
        const { cells } = centreCells(rd.points.map((p) => [p[0], p[2]]));
        const offs = crossOffsets(rd.width ?? 3);
        const hit = [];
        for (let i = 0; i < cells.length; i++) {
          const a = cells[Math.max(0, i - 1)], b = cells[Math.min(cells.length - 1, i + 1)];
          const r = rightOf(segmentAxis([a.x, a.z], [b.x, b.z]));
          for (const k of offs) {
            const x = cells[i].x + r[0] * k, z = cells[i].z + r[1] * k;
            for (const l of ir.lots) if (x >= l.box.minX && x <= l.box.maxX && z >= l.box.minZ && z <= l.box.maxZ) { hit.push([x, l.box.minY, z]); break; }
          }
        }
        if (hit.length) findings.push(finding('M1', rd.part ?? null, rd.stage, hit.length, hit, `${hit.length} cell(s) of road ${rd.id} fall inside a lot box (no road crosses a lot)`));
      }
    }
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

  // ---- (6c V) the villager rules and the graph, when the plan is a village (meta.village)
  const village = meta?.village;
  if (village) time('M22', () => villageRules({ ir, vw, village, want, findings, metrics, partStage }));
  // ---- (6c T2) the routed edges: each edge's ends reach each other by its movers, no ladder on a villager edge, the grade
  if (meta?.route) time('M2', () => routeRules({ ir, vw, route: meta.route, want, findings, metrics, partStage, graph }));
  // (7a K1) walls and gates (M2:wall, M8:wall: checkWalls.mjs, K1a) and rope bridges (M10:rope: checkRopes.mjs, K1b); each leaves vw
  // as it found it
  if (Array.isArray(meta?.walls) && meta.walls.length) time('M2', () => wallRules({ ir, vw, walls: meta.walls, meta, want, findings, metrics, partStage, finding, boundLots }));
  if (Array.isArray(meta?.ropes) && meta.ropes.length) time('M10', () => ropeRules({ ir, vw, ropes: meta.ropes, meta, want, findings, metrics, partStage, finding }));
  // (6c T3) bridges (checkBridges.mjs, T3a) and tunnels (checkTunnels.mjs, T3b), each only when the plan meta records some
  if (Array.isArray(meta?.bridges) && meta.bridges.length) time('M10', () => bridgeRules({ ir, vw, bridges: meta.bridges, meta, want, findings, metrics, partStage, finding }));
  if (Array.isArray(meta?.tunnels) && meta.tunnels.length) time('M3', () => tunnelRules({ ir, vw, tunnels: meta.tunnels, meta, want, findings, metrics, partStage, finding }));
  // (7a CW) catwalks (M10:catwalk: checkCatwalks.mjs), only when the plan meta records some
  if (Array.isArray(meta?.catwalks) && meta.catwalks.length) time('M10', () => catwalkRules({ ir, vw, catwalks: meta.catwalks, meta, want, findings, metrics, partStage, finding }));
  // (7a CL) climbs (checkClimbs.mjs): stair flights, ladder faces, rest landings, the top gate, M8 and M5 over the treads and landings
  if (Array.isArray(meta?.climbs) && meta.climbs.length) time('M10', () => climbRules({ vw, climbs: meta.climbs, want, findings, metrics, finding, light: () => blockLight(vw) }));
  // (7a RK) rock stairs (checkRockStairs.mjs): T3b's M3:tunnel, M3:gravity, M4:tunnel and M6 over the flight's void and shell, and M10:rock_stair
  if (Array.isArray(meta?.rockStairs) && meta.rockStairs.length) time('M3', () => rockStairRules({ ir, vw, rockStairs: meta.rockStairs, meta, want, findings, metrics, partStage, finding }));
  // (7a SA) spirals (checkSpirals.mjs): steps, standing and head room, attached, the outer edge, rails (M8), lit (M5)
  if (Array.isArray(meta?.spirals) && meta.spirals.length) time('M10', () => spiralRules({ ir, vw, spirals: meta.spirals, want, findings, metrics, finding, light: () => blockLight(vw) }));
  // (7a LF) lifts (checkLifts.mjs): the base, the column's drag, the shell 2 thick, the airlock, the rim's rails, the head room, the light
  if (Array.isArray(meta?.lifts) && meta.lifts.length) time('M10', () => liftRules({ vw, lifts: meta.lifts, want, findings, metrics, finding, light: () => blockLight(vw) }));
  // (6c H) fluid bodies (the IR's fluid ops) and wet writes (meta.wet): only when the plan has either
  if ((want.has('M25') || want.has('M20')) && (ir.parts.some((p) => (p.ops ?? []).some((o) => o.op === 'fluid')) || (Array.isArray(meta?.wet) && meta.wet.length))) {
    time('M25', () => fluidRules({ ir, vw, meta, vols: irVolumes(ir, volumes, blobs), want, findings, metrics, partStage, finding }));
  }
  // ---- (7a FB) M16 flood behaviour: only on a plan with bodies (every other report is unchanged); the walk cells are the player graph's
  // and the feet over every walk-marked floor (any network's)
  if (want.has('M16') && ir.parts.some((p) => (p.ops ?? []).some((o) => o.op === 'fluid'))) time('M16', () => {
    const walk = [...graph.reached];
    vw.eachWritten((x, y, z, idx, f) => { if ((f & F_WALK) && !P.air[idx]) walk.push(x, y + 1, z); });
    const r = floodRule({ vw, bodies: bodiesOf(ir), walk });
    metrics.M16 = r.metrics;
    for (const f of r.found) findings.push(finding('M16', f.irPart, 'fluids', f.walk + f.lot, f.cells, floodMessage(f)));
  });

  // ---- (6c D3) M28:beside and M25:clear's foreign bodies: a districts plan with a reach into a standing town's claim
  if (ir.reach && (want.has('M28') || want.has('M25'))) time('M28', () => { metrics.M28 = besideRules({ ir, vw, besideReach: BR, findings, finding, partStage, ...(want.has('M5') ? { light: () => blockLight(vw) } : {}) }); });
  // ---- (6d RV) M29:revision: a revision IR against ctx.standing (the standing region it adds to; only with the standing data)
  if (ir.revision && standing && want.has('M29')) time('M29', () => { metrics.M29 = reviseRules({ ir, vw, standing, findings, finding }); });

  // ---- (6c VOC-b) M26, M27 and M20 widened, on every IR (checkVocab.mjs): natural lava is looked for only where the survey or a frozen
  // volume holds some
  if (want.has('M26') || want.has('M27') || want.has('M20')) time('M27', () => {
    const vols = [...(volumes ?? []), ...irVolumes(ir, volumes, blobs).values()];
    const lava = world ? null : (vols.some((v) => (v.counts?.LAVA ?? 0) > 0) ? true : null);
    vocabRules({ ir, vw, meta, want, findings, metrics, finding, lava });
  });

  // ---- M3 support
  if (want.has('M3')) time('M3', () => {
    const sup = supportCheck(vw, ir, null);
    for (const f of sup.findings) { f.stage = f.part ? partStage.get(f.part) ?? null : null; findings.push(f); }
    metrics.M3 = sup.metrics;
    if (ir.forms?.length) { const oh = overhangCheck(vw, ir); findings.push(...oh.findings); Object.assign(metrics.M3, oh.metrics); }
  });
  // ---- (6c F3 §4) M18 leaf decay, M19 dead coral (warnings; checkForms.mjs)
  if (want.has('M18') || want.has('M19')) time('M18', () => formRulesVw({ vw, ir, want, findings, metrics, finding, partStage }));

  // ---- the walk area: reached cells whose floor the region wrote (or walk-marked cells)
  const walkArea = [];
  const reachedArr = graph.reached;
  // ((6c F3) a grown form's cells are landscape, not a walk: a root's or a trunk's top is no path to light (M5, M6))
  const grownParts = new Set();
  for (const f of ir.forms ?? []) if (GROWN_GENERATORS.has(f.generator)) { const i = ir.parts.findIndex((p) => p.id === (f.part ?? f.id)); if (i >= 0) grownParts.add(i); }
  for (let i = 0; i < reachedArr.length; i += 3) {
    const x = reachedArr[i], y = reachedArr[i + 1], z = reachedArr[i + 2];
    if (vw.flags(x, y - 1, z) & F_WRITTEN && !(grownParts.size && grownParts.has(vw.partAt(x, y - 1, z)))) walkArea.push(x, y, z);
  }

  // ---- M4 fluid containment
  if (want.has('M4')) time('M4', () => {
    const byPart = new Map();
    // On a realised world, a plan fluid body's own flow (its cells, spill and predicted flowing cells, of its fluid) is not a fluid
    // the clearing opens onto: the body writes only its sources, so its flow reads as unwritten fluid there (S3's fountain spout
    // beside a felled trunk the fountain room cleared). The body's census and M25 judge that flow; the virtual world holds no flow,
    // so a plan's own report is unchanged.
    const own = world ? ownFluidCells(ir) : null;
    vw.eachWritten((x, y, z, idx, f, pi) => {
      if (!P.air[idx]) return;
      for (const [dx, dy, dz] of DIRS6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (vw.flags(nx, ny, nz) & F_WRITTEN) continue;
        const n = vw.get(nx, ny, nz);
        if (own && P.fluid[n] && own.get(`${nx},${ny},${nz}`) === (P.lava[n] ? 'lava' : 'water')) continue;
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
    // (6c T2) the share over the routes' own walk cells (their floor in the routes part)
    if (meta?.route) {
      let rd = 0, ra = 0;
      for (let i = 0; i < walkArea.length; i += 3) {
        const x = walkArea[i], y = walkArea[i + 1], z = walkArea[i + 2];
        if (ir.parts[vw.partAt(x, y - 1, z)]?.id !== meta.route.part) continue;
        ra++;
        if (P.spawn[vw.get(x, y - 1, z)] && !(light.at(x, y, z) > 0)) rd++;
      }
      metrics.M5route = { darkSpawnable: rd, walkCells: ra, share: ra ? rd / ra : 0 };
    }
    // (7a K1b) the rope bridges' own deck cells (the plan meta's ropes: each walk cell of every deck, reached from the entrance or
    // not): dark and spawnable ones (CONTRACT K1 item 5: 0)
    if (Array.isArray(meta?.ropes) && meta.ropes.length) {
      let rd = 0, ra = 0;
      const rs = [];
      for (const q of meta.ropes) for (const [x, y, z] of q.cells ?? []) {
        ra++;
        if (P.spawn[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)] && !(light.at(x, y + 1, z) > 0)) { rd++; if (rs.length < 20) rs.push([x, y + 1, z]); }
      }
      metrics.M5rope = { darkSpawnable: rd, deckCells: ra, sample: rs };
    }
    // (6c T3) the same over every bridge's deck cells and every tunnel's floor cells (`cells`: the deck or floor blocks; feet one over)
    // ((7a CW) and every catwalk's deck cells: its record's `deckCells` (its `cells` is siteplan/1's count))
    // ((7a RK) and every rock stair's treads: its record's `cells`)
    for (const [key, list, name] of [['M5bridge', meta?.bridges, 'deckCells'], ['M5tunnel', meta?.tunnels, 'floorCells'], ['M5catwalk', meta?.catwalks, 'deckCells'], ['M5rockStair', meta?.rockStairs, 'treads']]) {
      if (!Array.isArray(list) || !list.length) continue;
      let rd = 0, ra = 0;
      const rs = [];
      for (const q of list) for (const [x, y, z] of (key === 'M5catwalk' ? q.deckCells : q.cells) ?? []) {
        ra++;
        if (P.spawn[vw.get(x, y, z)] && P.passable[vw.get(x, y + 1, z)] && !(light.at(x, y + 1, z) > 0)) { rd++; if (rs.length < 20) rs.push([x, y + 1, z]); }
      }
      metrics[key] = { darkSpawnable: rd, [name]: ra, sample: rs };
      if (rd && want.has('M5')) findings.push(finding('M5', null, null, rd, rs, `${rd} of ${ra} ${key === 'M5bridge' ? 'bridge deck' : key === 'M5catwalk' ? 'catwalk deck' : key === 'M5rockStair' ? 'rock stair tread' : 'tunnel floor'} cell(s) are dark (block light 0) and spawnable`));
    }
    if (dark) findings.push(finding('M5', null, null, dark, sample, `${dark} of ${area} walk cell(s) are dark (block light 0) and spawnable (${(100 * dark / Math.max(1, area)).toFixed(1)}%)`));
    // caverns: no dark spawnable floor cell inside
    for (const [pid, m] of Object.entries(meta?.parts ?? {})) for (const cv of m.caverns ?? []) {
      const b = cv.bounds;
      const cells = [];
      for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
        const y = cv.floorY;
        if (!(vw.flags(x, y - 1, z) & F_WRITTEN) && !(vw.flags(x, y, z) & F_WRITTEN)) continue;
        const own = ir.parts[vw.partAt(x, y - 1, z)]?.id === pid || ir.parts[vw.partAt(x, y, z)]?.id === pid;
        if (!own) continue; // only the cavern's own floor (its bounds may overlap other parts)
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

  // ---- (6c F1) M17 melt: no ice or snow layer within reach of block light that melts it (26.3: ice over 10, a snow layer over 11),
  // written or natural (the frozen volume's ICE and SNOW cells count as ice and snow layers when a planned light reaches them)
  const vols = irVolumes(ir, volumes, blobs);
  if (want.has('M17')) time('M17', () => {
    const light = blockLight(vw);
    const isIce = (st) => st === 'minecraft:ice' || st.startsWith('minecraft:frosted_ice');
    const isSnow = (st) => st.startsWith('minecraft:snow[') || st === 'minecraft:snow';
    const natural = (x, y, z) => { for (const v of vols.values()) { const c = classAt(v, x, y, z); if (c !== VC.MISSING) return c; } return VC.MISSING; };
    const byPart = new Map();
    const seen = new CellSet();
    const melt = (x, y, z, v, kind, pi) => {
      if (!seen.add(x, y, z)) return;
      const l = byPart.get(pi) ?? []; l.push([x, y, z, kind, v]); byPart.set(pi, l);
    };
    let checked = 0;
    if (light.lit) {
      // the virtual world: only cells lit at 11 or more can melt (and an unwritten snow cell beside one lit at 13 or more:
      // the virtual world reads natural SNOW as an opaque snow block, a real snow layer is clear)
      const L = light.lit;
      for (let i = 0; i < L.length; i += 4) {
        const x = L[i], y = L[i + 1], z = L[i + 2], v = L[i + 3];
        checked++;
        const written = (vw.flags(x, y, z) & F_WRITTEN) !== 0;
        const st = P.states[vw.get(x, y, z)];
        if (written) {
          if (isIce(st) && v > MELT.ice) melt(x, y, z, v, 'ice', vw.partAt(x, y, z));
          else if (isSnow(st) && v > MELT.snow) melt(x, y, z, v, 'snow', vw.partAt(x, y, z));
        } else {
          const c = natural(x, y, z);
          if ((c === VC.ICE || isIce(st)) && v > MELT.ice) melt(x, y, z, v, 'ice', -1);
        }
        if (v - 1 > MELT.snow) for (const [dx, dy, dz] of DIRS6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (vw.flags(nx, ny, nz) & F_WRITTEN) continue;
          if (natural(nx, ny, nz) === VC.SNOW) melt(nx, ny, nz, v - 1, 'snow', -1);
        }
      }
    } else {
      // a realised world: every ice or snow-layer cell in the dump box against the dump's own block light
      const c = vw.claim;
      for (let x = c.minX; x <= c.maxX; x++) for (let z = c.minZ; z <= c.maxZ; z++) for (let y = c.minY; y <= c.maxY; y++) {
        const st = P.states[vw.get(x, y, z)];
        const ice = isIce(st), snow = !ice && isSnow(st);
        if (!ice && !snow) continue;
        checked++;
        const v = light.at(x, y, z);
        if (ice ? v > MELT.ice : v > MELT.snow) melt(x, y, z, v, ice ? 'ice' : 'snow', vw.partAt(x, y, z));
      }
    }
    let n = 0;
    for (const [pi, l] of byPart) {
      n += l.length;
      const ice = l.filter((c) => c[3] === 'ice').length;
      findings.push(finding('M17', ir.parts[pi]?.id ?? null, ir.parts[pi]?.stage ?? null, l.length, l.map((c) => c.slice(0, 3)), `${l.length} ${pi < 0 ? 'natural ' : ''}cell(s) melt: ${ice} ice at block light over ${MELT.ice}, ${l.length - ice} snow layer(s) over ${MELT.snow} (e.g. light ${l[0][4]} at ${l[0].slice(0, 3).join(' ')})`));
    }
    metrics.M17 = { melting: n, checked, natural: byPart.get(-1)?.length ?? 0 };
  });

  // ---- (6c F1) kept cells: a part's `keep` ({volume, class, box}: the frozen volume's cells of that class in the box) is never
  // written by any op (M1, an error)
  const keeps = [];
  for (const p of ir.parts) for (const k of p.keep ?? []) keeps.push({ part: p.id, ...k });
  if (keeps.length && want.has('M1')) time('M1', () => {
    const byPart = new Map();
    let keptCells = 0;
    for (const k of keeps) {
      const v = vols.get(k.volume);
      if (!v) { findings.push(finding('M1', k.part, partStage.get(k.part), 1, [], `keep: volume '${k.volume}' is not at hand (the checker needs the plan's volumes)`)); continue; }
      const cls = VC[k.class];
      const b = k.box;
      for (let x = Math.max(b.minX, v.box.minX); x <= Math.min(b.maxX, v.box.maxX); x++) for (let z = Math.max(b.minZ, v.box.minZ); z <= Math.min(b.maxZ, v.box.maxZ); z++) for (let y = Math.max(b.minY, v.box.minY); y <= Math.min(b.maxY, v.box.maxY); y++) {
        if (classAt(v, x, y, z) !== cls) continue;
        keptCells++;
        if (!(vw.flags(x, y, z) & F_WRITTEN)) continue;
        const pi = vw.partAt(x, y, z);
        const l = byPart.get(pi) ?? []; l.push([x, y, z]); byPart.set(pi, l);
      }
    }
    for (const [pi, l] of byPart) findings.push(finding('M1', ir.parts[pi]?.id ?? null, ir.parts[pi]?.stage ?? null, l.length, l, `${l.length} kept natural cell(s) written (a keepNatural set: no op writes them)`));
    metrics.keep = { sets: keeps.length, cells: keptCells, written: [...byPart.values()].reduce((a, l) => a + l.length, 0) };
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
    // (6c MP) a material may be a pattern ({pattern: {mix | gradient}}), also inside a rule's clauses and default
    const each = (m, where) => {
      if (m && typeof m === 'object' && m.rule) { for (const c of m.rule.rule) each(c.mat, where); each(m.rule.default, where); }
      else if (m && typeof m === 'object' && m.pattern) for (const x of m.pattern.mix ?? m.pattern.gradient?.stops ?? []) check(x.mat, where);
      else check(m, where);
    };
    for (const p of ir.parts) for (const o of p.ops) {
      if (o.op === 'columns') for (const m of o.materials ?? []) each(m, `part ${p.id}`);
      else if (o.op === 'voxels') { // (6c F1) the baked blob's palette (when the blob is at hand)
        const b = ir.blobs?.[o.blob];
        const bytes = b && blobs ? (typeof blobs === 'function' ? blobs(b.sha) : blobs instanceof Map ? blobs.get(b.sha) : blobs[b.sha]) : null;
        if (bytes) for (const st of decodeVoxels(bytes, `blob ${o.blob}`).palette) if (st !== 'minecraft:air') check(st, `part ${p.id}`);
      }
      else if (o.op === 'relief') each(o.fill, `part ${p.id}`); // (6c T1)
      else if (o.op === 'stamp' || o.op === 'scatter') { // (6c F2) a stamp's blob palette; a scatter's item blocks, patches and bodies
        const pal = (name) => {
          const b = ir.blobs?.[name];
          const bytes = b && blobs ? (typeof blobs === 'function' ? blobs(b.sha) : blobs instanceof Map ? blobs.get(b.sha) : blobs[b.sha]) : null;
          if (bytes) for (const st of decodeVoxels(bytes, `blob ${name}`).palette) if (st !== 'minecraft:air') check(st, `part ${p.id}`);
        };
        if (o.op === 'stamp') pal(o.blob);
        else for (const it of o.items ?? []) {
          if (typeof it.block === 'string') check(it.block, `part ${p.id}`);
          else if (it.block && typeof it.block === 'object') for (const v of Object.values(it.block)) check(v, `part ${p.id}`);
          for (const e of it.patch ?? []) { check(e[2], `part ${p.id}`); if (e[3]) check(e[3], `part ${p.id}`); }
          if (typeof it.cells === 'string') pal(it.cells);
        }
      }
      else each(o.material, `part ${p.id}`);
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

/**
 * (6c V, CONTRACT V §6) The flat-village rules: `M2:villager` (every dwelling, job, trading_hall or farm lot reaches the bell by
 * the kit's villager mover), the graph (every lot node joins the plaza through the IR's edges: M2), M22 (the 5x5 bell area one
 * y, standable, 2 clear; a 3x3x3 golem space within 8 of the bell), M23 (the trading hall's entrance within 12 of the bell,
 * horizontal Euclidean), M24 (a farm's rect within 2 of surveyed water; with no water in the claim a note), and M1 (a village
 * part's cell inside a lot box: an error). Warnings but M1, as every macro rule.
 */
function villageRules({ ir, vw, village, want, findings, metrics, partStage }) {
  const P = vw.pal;
  const bell = village.bell;
  const lots = village.lots ?? {};
  // M2:villager
  const g = walkGraph(vw, [bell], { mover: 'villager' });
  const per = {}, un = [];
  for (const [id, l] of Object.entries(lots)) {
    if (!['dwelling', 'job', 'trading_hall', 'farm'].includes(l.villager)) continue;
    const ok = nodeReached(g, l.entrance);
    per[id] = ok;
    if (!ok) un.push(id);
  }
  metrics.M2villager = { mover: 'villager', lots: Object.keys(per).length, reached: Object.keys(per).length - un.length, unreachable: un, perLot: per, walkCells: g.reached.length / 3 };
  if (want.has('M2') && un.length) findings.push(finding('M2:villager', 'lanes', partStage.get('lanes') ?? null, un.length, un.map((id) => lots[id].entrance), `${un.length} villager lot(s) do not reach the bell by the villager mover: ${un.join(', ')}`));
  // the graph: every lot node joins the plaza through the IR's edges
  if (ir.graph) {
    const adj = new Map();
    for (const e of ir.graph.edges) {
      const a = e.from.split('.')[0], b = e.to.split('.')[0];
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
    const seen = new Set(['plaza']);
    const q = ['plaza'];
    while (q.length) for (const n of adj.get(q.shift()) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    const cut = ir.graph.nodes.filter((n) => n.kind === 'lot' && !seen.has(n.id));
    metrics.graph = { nodes: ir.graph.nodes.length, edges: ir.graph.edges.length, joined: ir.graph.nodes.length - cut.length, cut: cut.map((n) => n.id) };
    if (want.has('M2') && cut.length) findings.push(finding('M2', 'lanes', partStage.get('lanes') ?? null, cut.length, cut.map((n) => n.at), `graph: ${cut.length} lot(s) have no lane or street edge to the plaza: ${cut.map((n) => n.ref).join(', ')}`));
  }
  // M22: the bell area and the golem space
  const y = village.bellY;
  const badArea = [];
  for (const [x, z] of village.bellArea) {
    const f = vw.get(x, y - 1, z), a = vw.get(x, y, z), b = vw.get(x, y + 1, z);
    if (!P.floor[f] || !P.passable[a] || !P.passable[b] || vw.lotAt(x, y, z)) badArea.push([x, y, z]);
  }
  const badGolem = [];
  for (const [x, z] of village.golem) {
    if (!P.floor[vw.get(x, y - 1, z)]) badGolem.push([x, y - 1, z]);
    for (let dy = 0; dy < 3; dy++) if (!P.passable[vw.get(x, y + dy, z)] || P.water[vw.get(x, y + dy, z)]) badGolem.push([x, y + dy, z]);
  }
  const gd = Math.hypot(village.golemCentre[0] - bell[0], village.golemCentre[1] - bell[2]);
  metrics.M22 = { bellArea: village.bellArea.length, bad: badArea.length, golemBad: badGolem.length, golemDistance: Math.round(gd * 10) / 10 };
  if (want.has('M22')) {
    if (badArea.length) findings.push(finding('M22', null, null, badArea.length, badArea, `the 5x5 bell area at y ${y} has ${badArea.length} cell(s) not standable with 2 clear (one y)`));
    if (badGolem.length || gd > 8) findings.push(finding('M22', null, null, Math.max(1, badGolem.length), badGolem, `the 3x3x3 golem space ${badGolem.length ? `has ${badGolem.length} blocked cell(s)` : ''}${gd > 8 ? ` is ${gd.toFixed(1)} from the bell (at most 8)` : ''}`.trim()));
  }
  // M23: the trading hall's entrance within 12 of the bell anchor
  const m23 = {};
  for (const [id, l] of Object.entries(lots)) {
    if (l.villager !== 'trading_hall') continue;
    const d = Math.hypot(l.entrance[0] - bell[0], l.entrance[2] - bell[2]);
    m23[id] = Math.round(d * 10) / 10;
    if (want.has('M23') && d > 12) findings.push(finding('M23', 'pads', partStage.get('pads') ?? null, 1, [l.entrance], `trading hall ${id}: its entrance is ${d.toFixed(1)} from the bell (at most 12)`));
  }
  metrics.M23 = m23;
  // M24: a farm's rect within 2 of surveyed water
  const m24 = {};
  for (const [id, l] of Object.entries(lots)) {
    if (l.villager !== 'farm') continue;
    m24[id] = l.water;
    if (!village.waterAny) continue; // no water in the claim: a note (water: null tells the caller to ask the design for its own)
    if (want.has('M24') && (l.water === null || l.water > 2)) findings.push(finding('M24', 'pads', partStage.get('pads') ?? null, 1, [l.entrance], `farm ${id}: its lot is ${l.water} from surveyed water (at most 2)`));
  }
  metrics.M24 = { farms: m24, waterInClaim: !!village.waterAny, note: village.waterAny ? null : 'no surface water in the claim: water null, the design brings its own' };
  // (6c H, §7.5) M24 counts plan-written, unfrozen water too (a farm pond): each farm's distance (Chebyshev, columns) from its box to the
  // nearest water column of the plan's bodies, outside their ice caps (only when the plan has such water: otherwise as before)
  const planW = [];
  for (const p of ir.parts) for (const o of p.ops ?? []) {
    if (o.op !== 'fluid' || o.fluid !== 'water') continue;
    const iced = new Set((o.ice ?? []).map((q) => `${q[0]},${q[1]}`));
    for (const q of o.cells ?? []) if (!iced.has(`${q[0]},${q[1]}`)) planW.push([q[0], q[1]]);
  }
  if (planW.length) {
    const pw = {};
    for (const [id, l] of Object.entries(lots)) {
      if (l.villager !== 'farm') continue;
      const b = (ir.lots ?? []).find((q) => q.id === id)?.box;
      if (!b) continue;
      let d = Infinity;
      for (const [x, z] of planW) d = Math.min(d, Math.max(Math.max(0, b.minX - x, x - b.maxX), Math.max(0, b.minZ - z, z - b.maxZ)));
      pw[id] = d;
    }
    metrics.M24.planWater = pw;
  }
  // M1: a village part writing into a lot box
  if (want.has('M1')) {
    const byPart = new Map();
    vw.eachWritten((x, yy, z, idx, f, pi) => {
      const pid = ir.parts[pi]?.id;
      if (!pid || !VILLAGE_PARTS.test(pid)) return;
      for (const l of ir.lots ?? []) {
        const b = l.box;
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && yy >= b.minY - 1 && yy <= b.maxY) { const a = byPart.get(pid) ?? []; a.push([x, yy, z]); byPart.set(pid, a); return; }
      }
    });
    for (const [pid, cells] of byPart) findings.push(finding('M1', pid, partStage.get(pid) ?? null, cells.length, cells, `${cells.length} cell(s) of ${pid} fall inside a lot box (no region op writes inside a lot box)`));
  }
}

/**
 * (6c T2, CONTRACT T2 §3) The routed edges (meta.route): `M2` when an edge's ends don't reach each other by the player mover,
 * `M2:villager` when a villager edge's ends don't by the villager mover or it has a ladder, `M2:grade` when a walk run rises or
 * falls more than maxGrade over an 8-cell window (its surface read from the world: the standable feet nearest the plan's).
 */
export function routeRules({ ir, vw, route, want, findings, metrics, partStage, graph = null }) {
  const part = route.part, stage = partStage.get(part) ?? null;
  const graphs = new Map();
  const reach = (start, mover) => {
    const k = `${mover}|${start.join(',')}`;
    let g = graphs.get(k);
    if (!g) { g = walkGraph(vw, [start], { mover, reach: !!ir.reach }); graphs.set(k, g); }
    return g;
  };
  const per = [];
  let unP = [], unV = [], ladV = [], gradeBad = [], windows = 0, bad = 0, maxRise = 0;
  // ((6c D3) a reach plan grades its join over the reach-aware graph's columns; any other plan as before)
  const stands = (ir.reach ? reach(ir.anchors?.entrance ?? [0, 0, 0], 'player') : graph ?? reach(ir.anchors?.entrance ?? [0, 0, 0], 'player')).stands;
  for (const e of route.edges ?? []) {
    if (!e.ok) { per.push({ id: e.id, ok: false, failed: e.failed }); continue; }
    const a = e.path[0], b = e.path[e.path.length - 1];
    const fa = [a[0], a[1] + 1, a[2]], fb = [b[0], b[1] + 1, b[2]];
    const player = nodeReached(reach(fa, 'player'), fb) && nodeReached(reach(fb, 'player'), fa);
    const villagerEdge = (e.movers ?? []).includes('villager');
    const villager = villagerEdge ? nodeReached(reach(fa, 'villager'), fb) && nodeReached(reach(fb, 'villager'), fa) : null;
    const ladders = (e.segments ?? []).filter((g) => g.kind === 'ladder').length;
    if (!player) unP.push(e);
    if (villagerEdge && !villager) unV.push(e);
    if (villagerEdge && ladders) ladV.push(e);
    // the grade over each walk run, on the world's surface
    let eb = 0, ew = 0, er = 0;
    for (const g of e.segments ?? []) {
      if (g.kind !== 'walk' || g.shared) continue; // (a shared run is the earlier edge's: graded there)
      const ys = [];
      for (let i = g.from; i <= g.to; i++) {
        const [x, y, z] = e.path[i];
        const l = stands(x, z);
        let best = null;
        for (const f of l) if (best === null || Math.abs(f - 1 - y) < Math.abs(best - 1 - y)) best = f;
        ys.push(best === null ? y : best - 1);
      }
      const w = windowGrade(ys, route.maxGrade);
      ew += w.windows; eb += w.bad; if (w.maxRise > er) er = w.maxRise;
    }
    windows += ew; bad += eb; if (er > maxRise) maxRise = er;
    if (eb) gradeBad.push({ e, n: eb });
    per.push({ id: e.id, ok: true, movers: e.movers, player, villager, ladders, grade: { windows: ew, bad: eb, maxRise: er } });
  }
  metrics.route = { edges: per, routed: per.filter((x) => x.ok).length, playerReached: per.filter((x) => x.player).length, villagerEdges: per.filter((x) => x.villager !== null && x.villager !== undefined).length,
    villagerReached: per.filter((x) => x.villager === true).length, ladderOnVillager: ladV.length, grade: { windows, bad, maxRise, maxGrade: route.maxGrade }, hairpins: route.hairpins ?? 0 };
  if (!want.has('M2')) return;
  const at = (e) => [e.path[0][0], e.path[0][1] + 1, e.path[0][2]];
  if (unP.length) findings.push(finding('M2', part, stage, unP.length, unP.map(at), `route: ${unP.length} edge(s) whose ends don't reach each other by the player mover: ${unP.map((e) => e.id).join(', ')}`));
  if (unV.length) findings.push(finding('M2:villager', part, stage, unV.length, unV.map(at), `route: ${unV.length} villager edge(s) whose ends don't reach each other by the villager mover: ${unV.map((e) => e.id).join(', ')}`));
  if (ladV.length) findings.push(finding('M2:villager', part, stage, ladV.length, ladV.map(at), `route: ${ladV.length} villager edge(s) with a ladder (villagers don't climb): ${ladV.map((e) => e.id).join(', ')}`));
  if (gradeBad.length) findings.push(finding('M2:grade', part, stage, bad, gradeBad.map((x) => at(x.e)), `route: ${bad} 8-cell window(s) of walk runs steeper than ${route.maxGrade} (max rise ${maxRise}): ${gradeBad.map((x) => `${x.e.id} ${x.n}`).join(', ')}`));
}

/** One line per finding plus the totals (summary.txt). */
export function summaryText(report) {
  const lines = report.findings.map((f) => `${f.severity.toUpperCase()} ${f.rule}${f.part ? ` [${f.part}]` : ''}${f.stage ? ` (${f.stage})` : ''}: ${f.message}`);
  lines.push(`${report.errors} error(s), ${report.warnings} warning(s); ${report.ms.total} ms`);
  return `${lines.join('\n')}\n`;
}
