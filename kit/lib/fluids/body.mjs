// (6c H) The fluid body (docs/CONTRACT.md "Phase 6c slice H" §1, §3, §7, §12): the one primitive every water generator ends in,
// `r.fluidBody(cells, opts)`, the IR's `fluid` op, its shell, and the lint FLUID_STATE. Plan time; integer math, no random number.
//
// A body is still water (or lava) that Architect writes as sources only, at or under its surface `level`, in a shell its own part
// writes in an earlier stage. Its `spill` (the cells flowing fluid fills: a fountain's spout sides, a waterfall's lip run and falling
// column) is computed here by M25's flow over the body's own local world (sim.mjs), never written; its `joins` are natural sources a
// spill lands in. The op carries what the mod needs to write, wait for and undo the body:
//
//   {op: 'fluid', id, part, fluid, level, cond: 2 (IF_AIR_OR_FLUID), walk: false,
//    cells, ice, shell, spill, joins, watch: column runs [[x, z, y0, y1], ...] sorted by (x, z, y0),
//    predicted: [[x, y, z, level], ...] (vanilla's steady state: every non-source cell the body's flow holds; level 1..7 flowing,
//               8 falling), settleTicks}
//
// `watch` is the single breach's reach (§2.5) outside the cells and the spill: journaled with the spill as watched cells (§4.2). The
// realise evaluates `cells` as sources and `ice` (surface cells capped, §1.3) as ice; every other member is the mod's.
import { simulate, settleBound } from './sim.mjs';
import { FLUIDS, FLUIDS_STAGE } from './kinds.mjs';
import { kindOf } from './world.mjs';
import { _bindFluidBody } from '../region/program.mjs';
import { draftIR } from '../region/plan.mjs';
import { buildVirtual } from '../region/vworld.mjs';
import { walkKinds } from '../realise.mjs';

export const FLUID_OP = 'fluid';
/** The block states a body writes (canonical: the default state of each block, a source). */
export const SOURCE_STATE = Object.freeze({ water: 'minecraft:water', lava: 'minecraft:lava' });
export const ICE_STATE = 'minecraft:ice';
/** The write condition of a body's sources and ice: only into air (the basin its shell's stage carved) or a fluid. */
export const BODY_COND = 2;
/** A body's cell count limit (a moat round a large feature is a few thousand cells). */
export const MAX_BODY_CELLS = 262144;

const k3 = (x, y, z) => `${x},${y},${z}`;
const un3 = (k) => k.split(',').map(Number);
const isInt = Number.isInteger;
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Cells [[x, y, z]] as column runs [[x, z, y0, y1]] sorted by (x, z, y0) (the IR's form). */
export function toRuns(cells) {
  const cols = new Map();
  for (const [x, y, z] of cells) {
    const k = `${x},${z}`;
    let l = cols.get(k);
    if (!l) { l = []; cols.set(k, l); }
    l.push(y);
  }
  const out = [];
  for (const [k, ys] of cols) {
    const [x, z] = k.split(',').map(Number);
    ys.sort((a, b) => a - b);
    let y0 = ys[0], prev = ys[0];
    for (let i = 1; i <= ys.length; i++) {
      const y = ys[i];
      if (i < ys.length && y === prev) continue;
      if (i < ys.length && y === prev + 1) { prev = y; continue; }
      out.push([x, z, y0, prev]);
      y0 = y; prev = y;
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

/** Column runs back to cells, in the write order (y, x, z). */
export function fromRuns(runs) {
  const out = [];
  for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]);
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
}

/** The count of cells in column runs. */
export function runCells(runs) {
  let n = 0;
  for (const r of runs ?? []) n += r[3] - r[2] + 1;
  return n;
}

/**
 * The shell (§1.1): every cell face-adjacent to `cells` that is not itself a cell, and, beside each surface cell (a cell with no cell
 * of the body over it), the cell one over each side wall (the rim stands one over the surface); less the cells directly over a surface
 * cell (the open top stays air) and the declared outlets `open` (where flow leaves the body: a fountain spout's sides, a waterfall's
 * lip). Sorted (y, x, z). `level` is accepted for the record; the rim follows each surface cell's own height.
 */
export function shellOf(cells, { open = [] } = {}) {
  const own = new Set(cells.map((c) => k3(...c)));
  const outlets = new Set(open.map((c) => k3(...c)));
  const top = new Set();
  for (const [x, y, z] of cells) if (!own.has(k3(x, y + 1, z))) top.add(k3(x, y + 1, z));
  const out = new Set();
  const add = (k) => { if (!own.has(k) && !outlets.has(k) && !top.has(k)) { out.add(k); return true; } return false; };
  for (const [x, y, z] of cells) {
    for (const [dx, dy, dz] of N6) add(k3(x + dx, y + dy, z + dz));
    if (own.has(k3(x, y + 1, z))) continue;
    for (const [dx, dz] of N4) {
      const side = k3(x + dx, y, z + dz);
      if (own.has(side) || outlets.has(side)) continue;
      add(k3(x + dx, y + 1, z + dz));
    }
  }
  return [...out].map(un3).sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
}

/** How far past a body's box the draft virtual world is built (a spill runs at most 7 sideways after any fall). */
export const LOCAL_MARGIN = 16;

/**
 * The world a body is planned against (r.fluidBody, before the IR exists): the plan's own draft virtual world so far (every earlier op,
 * the body's shell included, over the plan survey and the frozen volumes the plan read: plan.mjs draftIR, as lightCover reads it),
 * built over the tiles that meet the body's box grown by LOCAL_MARGIN. `world(x, y, z)` may answer first (a generator that knows
 * better). Returns {at, solid, vw}.
 */
export function localWorld(r, box, { world = null } = {}) {
  const { ir, blobs } = draftIR(r);
  const x0 = box.minX - LOCAL_MARGIN, x1 = box.maxX + LOCAL_MARGIN, z0 = box.minZ - LOCAL_MARGIN, z1 = box.maxZ + LOCAL_MARGIN;
  const meets = (key) => { const [tx, tz] = key.split(',').map(Number); return tx * 64 <= x1 && tx * 64 + 63 >= x0 && tz * 64 <= z1 && tz * 64 + 63 >= z0; };
  const tiles = {};
  for (const s of ir.stages) tiles[s] = { terrain: (ir.tiles[s]?.terrain ?? []).filter(meets), path: (ir.tiles[s]?.path ?? []).filter(meets) };
  ir.tiles = tiles;
  let volumes = [];
  // (a draft holding an earlier body's fluid op, or any other format-2 kind, is a format-2 IR)
  const kinds = walkKinds(ir);
  if (kinds.length) { ir.format = 2; ir.requires = kinds; ir.seed = r.ctx.seed; }
  if (ir.blobs && Object.values(ir.blobs).some((b) => b && b.sha !== undefined)) {
    ir.format = 2;
    ir.requires = walkKinds(ir);
    ir.seed = r.ctx.seed;
    if (Array.isArray(r.ctx.keepOut)) ir.keepOut = r.ctx.keepOut;
    volumes = (r.ctx.volumes ?? []).filter((v) => Object.values(r.volumesUsed).some((u) => u.sha === v.sha)).map((v) => v.decoded).filter(Boolean);
  }
  const { vw } = buildVirtual({ ir, survey: r.ctx.survey.columns, blobs, volumes });
  const P = vw.pal;
  return {
    vw,
    at(x, y, z) {
      if (world) { const w = world(x, y, z); if (w) return w; }
      return kindOf(P, vw.get(x, y, z));
    },
    solid: (x, y, z) => P.solid[vw.get(x, y, z)],
  };
}

/** The per-part volume cap (§10, T3b's): past it the body asks for no volume and its part answers incomplete VOLUME. */
export const VOLUME_CAP = 4000000;

/** Whether a body is raised (§2.5): its surface is not at least 1 under the ground of every column around it. */
export function isRaised(survey, cells, own = new Set(cells.map((c) => k3(...c)))) {
  const top = new Map();
  for (const [x, y, z] of cells) { const k = `${x},${z}`; top.set(k, Math.max(top.get(k) ?? -Infinity, y)); }
  for (const [k, y] of top) {
    const [x, z] = k.split(',').map(Number);
    for (const [dx, dz] of N4) {
      const nk = `${x + dx},${z + dz}`;
      if (top.has(nk)) continue;
      if (survey.groundAt(x + dx, z + dz) < y + 1) return true;
    }
  }
  void own;
  return false;
}

/** The cells within `d` (Chebyshev, 3D) of the shell that are not the body's, its spill or joins, nor over its surface. */
export function bufferOf(cells, shell, skip = [], d = 2) {
  const own = new Set([...cells, ...skip].map((c) => k3(...c)));
  const sh = new Set(shell.map((c) => k3(...c)));
  const top = new Map();
  for (const [x, y, z] of cells) { const k = `${x},${z}`; top.set(k, Math.max(top.get(k) ?? -Infinity, y)); }
  const out = new Set();
  for (const [x, y, z] of shell) for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) for (let dz = -d; dz <= d; dz++) {
    const k = k3(x + dx, y + dy, z + dz);
    if (own.has(k) || sh.has(k)) continue;
    const t = top.get(`${x + dx},${z + dz}`);
    if (t !== undefined && y + dy > t) continue; // over the open surface: air the body never meets
    out.add(k);
  }
  return [...out].map(un3);
}

/** The bounding box of cells. */
function boxOf(cells) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const [x, y, z] of cells) {
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

/** Normalise and check a cell list. */
function cellsOf(list, what, claim) {
  if (!Array.isArray(list)) throw new Error(`fluidBody: ${what} must be [[x, y, z], ...]`);
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!Array.isArray(c) || c.length !== 3 || !c.every(isInt)) throw new Error(`fluidBody: ${what} must be [[x, y, z], ...] integers`);
    const k = k3(...c);
    if (seen.has(k)) continue;
    seen.add(k);
    if (claim && (c[0] < claim.minX || c[0] > claim.maxX || c[2] < claim.minZ || c[2] > claim.maxZ || c[1] < claim.minY || c[1] > claim.maxY)) throw new Error(`fluidBody: ${what} cell ${c.join(', ')} is outside the claim`);
    out.push([c[0], c[1], c[2]]);
  }
  return out.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
}

/**
 * `r.fluidBody(cells, opts)` (§7): the body's shell in the generator's stage (a part of its own, `${id}_shell`, or `opts.shellPart`), its
 * sources (and ice cap) as a `fluid` op in the `fluids` stage (part `id`), the flow computed, and the body recorded in `r.meta.waters`.
 *
 * opts: {id (part id rule; unique), part (the plan part answering for it, or null), kind ('pond' | 'fountain' | 'waterfall' | 'moat' |
 *   'farm_pond' | 'well' | ...: siteplan's waters[].kind), stage (the shell's stage; default the region's first), shellPart (a Part to
 *   write the shell into instead), fluid = 'water', level (default the highest cell), shellRole = 'structure' (a role, a block state,
 *   or (x, y, z, where: 'floor' | 'side' | 'rim') -> material; null: the generator writes the shell itself, and r.fluidBody only
 *   records it), outlets: [[x, y, z]] (cells flow leaves through: not shell), joins: [[x, y, z]] (natural sources the spill lands in),
 *   ice: [[x, y, z]] (surface cells written as ice; true: every open surface cell), solid: [[x, y, z]] (other cells the plan writes
 *   fluid-stopping, for the flow), world: (x, y, z) -> kind | null (a generator's knowledge of the world), breach = true,
 *   _unsafe: {noShellCell: true | [x, y, z] (that shell cell is left unwritten, still declared), predictShort: true (the spill declared
 *   one cell short), flowingState: true (a source written as a flowing state: lint FLUID_STATE)}}.
 * Returns the body record: {id, part, kind, fluid, level, cells, shell, spill, joins, watch, ice, predicted, settleTicks, path}.
 */
export function fluidBody(r, cellsIn, opts = {}) {
  const { id, part = null, kind = 'pond', fluid = 'water', shellRole = 'structure', breach = true, _unsafe = null } = opts;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,47}$/.test(id)) throw new Error(`fluidBody: id '${id}' must match ^[a-z][a-z0-9_]{0,47}$`);
  if (!FLUIDS.includes(fluid)) throw new Error(`fluidBody ${id}: fluid must be ${FLUIDS.join(' or ')}`);
  if (!r.stageList.includes(FLUIDS_STAGE)) throw new Error(`fluidBody ${id}: the region has no '${FLUIDS_STAGE}' stage (declare it last: r.stages([..., '${FLUIDS_STAGE}']))`);
  if (r.stageList[r.stageList.length - 1] !== FLUIDS_STAGE) throw new Error(`fluidBody ${id}: the '${FLUIDS_STAGE}' stage must be the last (every solid before any source, §3.1)`);
  const claim = r.claim;
  const cells = cellsOf(cellsIn, 'cells', claim);
  if (!cells.length) throw new Error(`fluidBody ${id}: no cells`);
  if (cells.length > MAX_BODY_CELLS) throw new Error(`fluidBody ${id}: ${cells.length} cells (at most ${MAX_BODY_CELLS})`);
  const level = opts.level ?? Math.max(...cells.map((c) => c[1]));
  if (!isInt(level)) throw new Error(`fluidBody ${id}: level must be an integer`);
  if (cells.some((c) => c[1] > level)) throw new Error(`fluidBody ${id}: a cell stands over the surface level ${level} (sources only, at or under it)`);
  const outlets = cellsOf(opts.outlets ?? [], 'outlets', claim);
  const joins = cellsOf(opts.joins ?? [], 'joins', claim);
  const solid = cellsOf(opts.solid ?? [], 'solid', null);
  const shell = shellOf(cells, { open: outlets });
  const own = new Set(cells.map((c) => k3(...c)));
  // the ice cap: surface cells (the top of their column of the body) written as ice right after the sources
  let ice = [];
  if (opts.ice === true) ice = cells.filter(([x, y, z]) => y === level && !own.has(k3(x, y + 1, z)));
  else if (Array.isArray(opts.ice)) ice = cellsOf(opts.ice, 'ice', claim).filter((c) => own.has(k3(...c)));
  if (ice.length && fluid !== 'water') throw new Error(`fluidBody ${id}: only water is capped with ice`);
  // the shell first (the flow reads the plan's own world, the shell included)
  let shellWritten = shell;
  if (_unsafe?.noShellCell) {
    const skip = Array.isArray(_unsafe.noShellCell) ? k3(..._unsafe.noShellCell) : k3(...(shell.find((c) => c[1] === level) ?? shell[0]));
    shellWritten = shell.filter((c) => k3(...c) !== skip);
  }
  if (shellRole !== null) {
    const sp = opts.shellPart ?? r.part(`${id}_shell`.slice(0, 48), { stage: opts.stage ?? r.stageList[0] });
    // floor: a body cell over it; side: a body cell beside it (or under it); rim: only diagonally under it (the wall's course over the surface)
    const where = (x, y, z) => (own.has(k3(x, y + 1, z)) ? 'floor' : N6.some(([dx, dy, dz]) => own.has(k3(x + dx, y + dy, z + dz))) ? 'side' : 'rim');
    const mats = [];
    const matIdx = new Map();
    const cols = [];
    for (const [x, y, z] of shellWritten) {
      const m = typeof shellRole === 'function' ? shellRole(x, y, z, where(x, y, z)) : shellRole;
      const mk = JSON.stringify(m);
      let mi = matIdx.get(mk);
      if (mi === undefined) { mi = mats.length; mats.push(m); matIdx.set(mk, mi); }
      cols.push(x, z, y, y, mi);
    }
    if (cols.length) sp.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: 3 });
  }
  // the flow over the body's own world (sim.mjs): the spill, vanilla's steady state, the settle bound, the breach reach. The declared
  // shell (not what an _unsafe variant left out) and `solid` stop the flow: the body is planned as intended, the checker judges it as
  // written
  const box = boxOf([...cells, ...shell]);
  // the frozen volume (§10): the body's box grown by 2, by 9 under a raised body (its single breach falls to the ground), with the fluid
  // layer; null on the first plan (the two-plan flow plans again with it); not asked past the per-part cap (the compiler answers
  // incomplete VOLUME)
  const raised = isRaised(r.ctx.survey, cells, own);
  const grow = raised ? 9 : 2;
  const vbox = { minX: box.minX - grow, minY: box.minY - grow, minZ: box.minZ - grow, maxX: box.maxX + grow, maxY: box.maxY + grow, maxZ: box.maxZ + grow };
  const vcells = (vbox.maxX - vbox.minX + 1) * (vbox.maxY - vbox.minY + 1) * (vbox.maxZ - vbox.minZ + 1);
  let volume = null, volumeState = 'off';
  if (opts.volume !== false) {
    if (vcells > VOLUME_CAP) volumeState = 'cap';
    else {
      const v = r.needVolume(vbox, { fluids: true });
      volumeState = v ? 'given' : 'asked';
      if (v) { const u = Object.values(r.volumesUsed).find((q) => q.box.minX === vbox.minX && q.box.minY === vbox.minY && q.box.minZ === vbox.minZ && q.box.maxX === vbox.maxX && q.box.maxY === vbox.maxY && q.box.maxZ === vbox.maxZ); if (u) volume = { sha: u.sha, box: [vbox.minX, vbox.minY, vbox.minZ, vbox.maxX, vbox.maxY, vbox.maxZ] }; }
    }
  }
  const lw = localWorld(r, box, { world: opts.world ?? null });
  const stop = new Set([...shell, ...solid].map((c) => k3(...c)));
  const world = { at: (x, y, z) => (stop.has(k3(x, y, z)) ? 'stop' : lw.at(x, y, z)), solid: (x, y, z) => stop.has(k3(x, y, z)) || lw.solid(x, y, z) };
  const sim = simulate(world, [{ id, part, fluid, level, cells, shell }], { breach });
  const b = sim.bodies[0];
  let spill = b.spill;
  let predicted = b.predicted;
  if (_unsafe?.predictShort && spill.length) {
    // (the broken variant: the spill declared one cell short, its last cell in (y, x, z) order; the escape guard must catch it)
    const drop = spill[spill.length - 1];
    spill = spill.slice(0, -1);
    predicted = predicted.filter((p) => !(p[0] === drop[0] && p[1] === drop[1] && p[2] === drop[2]));
  }
  const spillSet = new Set(spill.map((c) => k3(...c)));
  const watch = (b.breach ?? []).filter((c) => !spillSet.has(k3(...c)));
  // the body, in the fluids stage: sources (and the ice cap) through the evaluator; the rest is the mod's
  const fp = r.part(id, { stage: FLUIDS_STAGE });
  const op = {
    op: FLUID_OP, id, part, fluid, level, cond: BODY_COND, walk: false,
    cells: toRuns(cells), ice: toRuns(ice), shell: toRuns(shell), spill: toRuns(spill), joins: toRuns(joins), watch: toRuns(watch),
    predicted, settleTicks: settleBound(fluid, b.path),
  };
  if (_unsafe?.flowingState) op.state = `${SOURCE_STATE[fluid]}[level=1]`; // (the broken variant: lint FLUID_STATE)
  fp._push(op);
  // the approval guard (§10): the shell and its buffer (the cells within 2 behind it), the joins, as per-column y runs; realiseApproved
  // re-samples them and compares classes and the fluid layer (ARTIFACT_STALE when they changed)
  const guardRuns = volume ? toRuns(bufferOf(cells, shell, [...spill, ...joins], 2).concat(shell, joins)) : null;
  const rec = { id, part, kind, fluid, level, cells, shell, spill, joins, watch, ice, predicted, settleTicks: op.settleTicks, path: b.path, findings: sim.findings, raised, volume, volumeState, volumeCells: vcells, guardRuns };
  (r.meta.waters ??= []).push({ id, part, kind, fluid, level, cells: cells.length, spill: spill.length, ice: ice.length, settleTicks: op.settleTicks, shell: shell.length, watch: watch.length, raised, volume: volumeState });
  (r._fluidBodies ??= []).push(rec);
  return rec;
}

/**
 * Record a wet write (§1.2, §8): the columns a pier, a harbour wall section or a quay writes through natural water, as column runs from
 * the bed - 3 to the surface + 1 ({id, part, kind: 'pier' | 'wall' | 'quay', columns: [[x, z, y0, y1]], volume: {sha, box} | null}). The
 * checker's M25:wet reads them (meta.wet), the compiler turns them into approval guards, the mod's exactness rule keeps them in view.
 */
export function recordWet(r, { id, part = null, kind, columns, volume = null }) {
  if (!['pier', 'wall', 'quay'].includes(kind)) throw new Error(`recordWet ${id}: kind must be pier, wall or quay`);
  if (!Array.isArray(columns) || !columns.every((q) => Array.isArray(q) && q.length === 4 && q.every(isInt) && q[2] <= q[3])) throw new Error(`recordWet ${id}: columns must be [[x, z, y0, y1], ...]`);
  const rec = { id, part, kind, columns: columns.map((q) => [...q]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]), volume };
  (r.meta.wet ??= []).push(rec);
  return rec;
}

/**
 * Lint FLUID_STATE (§1.1): no op of an IR carries a water or lava state with `level` over 0 (a flowing or falling state). Returns
 * [{part, op, state}] (empty when clean). Reads every material an op names: a shape's or columns op's materials, a fluid op's `state`.
 */
export function lintFluidState(ir) {
  const bad = [];
  const flowing = (s) => typeof s === 'string' && /^minecraft:(water|lava)\[(?:[^\]]*,)?level=(\d+)/.exec(s) && Number(/level=(\d+)/.exec(s)[1]) > 0;
  const visit = (pid, i, m) => {
    if (m === null || m === undefined) return;
    if (typeof m === 'string') { if (flowing(m)) bad.push({ part: pid, op: i, state: m }); return; }
    if (Array.isArray(m)) { for (const x of m) visit(pid, i, x); return; }
    if (typeof m === 'object') for (const v of Object.values(m)) visit(pid, i, v);
  };
  for (const p of ir.parts ?? []) (p.ops ?? []).forEach((o, i) => {
    if (o.op === 'shape') visit(p.id, i, o.material);
    else if (o.op === 'columns') visit(p.id, i, o.materials);
    else if (o.op === FLUID_OP) visit(p.id, i, o.state);
    else if (o.op === 'relief') visit(p.id, i, o.fill);
  });
  return bad;
}

// r.fluidBody (program.mjs binds it late: this module reads the plan module's draft virtual world)
_bindFluidBody(fluidBody);
