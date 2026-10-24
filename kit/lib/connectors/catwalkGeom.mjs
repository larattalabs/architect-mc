// (7a CW) Catwalks along a face (docs/CONTRACT.md "Phase 7a slice CW" §2; SETTLEMENTS §8.2's face form): the run's checks (gap, face,
// head room, span, water, protection), the cells a catwalk writes (deck, brackets, struts, rail beds and rails, lamps), the
// `catwalkRun` writer and the links stage's emission of the runs a route pass found. Plan time only, pure, integer math
// (Math.floor/abs/min/max): no clock, no random draw. This module never imports the compiler, the region program or rope.mjs (K1's
// integration lesson: no import cycle).
//
// Reading of §2 (recorded in "CW as built"):
// - A run of n deck cells (3..32) runs on a cardinal heading from the start walk cell (index 0) over the deck cells (1..n) to the
//   landing walk cell (n + 1), all at one surface y (feet on y + 1). Its lanes are the walk's footprint (route.mjs footprintOf at the
//   width: ropeGeom.mjs latOn, so an even width's extra lane lies where the walk's does on every heading). The face lies on one side:
//   `right` (the heading's right hand, lateral offset hi + 1) or `left` (lo - 1). The inner lane is the one against the face, the
//   outer lane the farthest from it: 1..width cells from the face (the deck's outer edge, never more than 2: M15's 4 with room).
// - The face: every deck cell's face cell is site-solid (ROCK or SOIL in the pre-region classes, or a cell the plan writes and M3
//   grounds: `land.written`) at y, y + 1 and y + 2 (it stands at least to y + 2). Else ANCHOR {why: face}.
// - The drop: at least one deck cell's outer lane stands over ground 2 or more below y. Else NO_GAP (nothing to shelf).
// - The deck: full blocks of the deck role across the lanes at y. The rail: a bed of the deck role one lateral cell past the outer
//   lane at y (the open edge) with the rail role's fence on it at y + 1 (M8's 1.5 over the feet), for every deck cell, and across
//   each end where the bed's column meets a drop (the start's and the landing's bed column with ground 2 or more under y).
// - Brackets: under the outer lane at deck cells 1, n and every 4 between (1, 5, 9, ...): an upside-down stair of the bracket role at
//   y - 1 facing the face; a cell the land already fills there carries the deck itself (no bracket written). A strut (the bracket
//   role's wall block) runs down from y - 2 to the land under the bracket when that land is site-solid within 2 (y - 3 or y - 4).
// - Head room: every lane and bed cell is air (or a plant) in the pre-region classes at y, y + 1 and y + 2: the deck never meets the
//   land (a catwalk cuts nothing), and an overhang lower than 2 over the deck or its rail answers HEADROOM. A tree column (the survey
//   has no trunk heights: 64 high) under a lane or the bed is HEADROOM too.
// - Lamps: W's fixture light on the rail every floor(12 * level / 15) deck cells from the first (cells 1, 1 + L, ...).
// - Never written: the face (nothing is carved), water or ice under any written column (WATER: no catwalk over water), keep-out,
//   builds, other regions, lot boxes and aprons (PROTECTED, `land.blocked`), and a plan body's hard cells (OVERLAP {kind: body},
//   KC's registry through `land.kept`).
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor } from '../region/fixtures.mjs';
import { rightOf, latOn, SITE_SOLID } from './ropeGeom.mjs';
import { deckChoice, railOf } from './bridgeGeom.mjs';

/** The limits (catalogue: `connector.catwalk`), costs in T2's units (a straight walk cell is 10). */
export const CATWALK = Object.freeze({
  runMin: 3, runMax: 32, widthMin: 1, widthMax: 2, villagerMinWidth: 2, bracketEvery: 4, strutReach: 2, drop: 2, approach: 16, approachMax: 32,
  // §3's cost: 200 + 25 a deck cell + 20 a bracket (a walk round that is not much longer wins)
  cost: 200, costPer: 25, costBracket: 20,
  // the diagnosis scans this far for a run that would land (a run outside the limits answers SPAN)
  diagMax: 48,
});

/** §2's checks in the route row's `fail` order: a failure later in it got further. */
export const CATWALK_ORDER = Object.freeze(['NO_GAP', 'ANCHOR', 'HEADROOM', 'SPAN', 'WATER', 'PROTECTED', 'OVERLAP']);

const OPEN = new Set(['AIR', 'PLANT']);

/**
 * A run's lateral layout: the lanes `lo..hi` (route.mjs's footprint at `width`), the face's offset, the inner and outer lanes, the bed
 * (one past the outer lane), `toward` the unit step from the deck to the face, and `lanes` from the face outward (distance 1..width).
 */
export function catwalkLanes(width, dir, side) {
  const { lo, hi } = latOn(width, dir), [rx, rz] = rightOf(dir);
  const right = side === 'right';
  const face = right ? hi + 1 : lo - 1, inner = right ? hi : lo, outer = right ? lo : hi, bed = right ? lo - 1 : hi + 1, s = right ? 1 : -1;
  const lanes = [];
  for (let d = 1; d <= width; d++) lanes.push(face - s * d);
  return { lo, hi, face, inner, outer, bed, toward: [rx * s + 0, rz * s + 0], step: s, lanes };
}

/** The deck cells that carry a bracket: 1, n and every `every` between (1, 1 + every, ...). */
export function bracketIndices(n, every = CATWALK.bracketEvery) {
  const out = [];
  for (let i = 1; i <= n; i += every) out.push(i);
  if (out[out.length - 1] !== n) out.push(n);
  return out;
}

/** The run's cost in pass units (§3). */
export const runCost = (n) => CATWALK.cost + CATWALK.costPer * n + CATWALK.costBracket * bracketIndices(n).length;

/**
 * §2's checks for a run (in CATWALK_ORDER): `land` {groundAt, topAt, waterAt, blocked(x, z), classAt(x, y, z), written?(x, y, z),
 * kept?(x, y, z)}, `a` the start walk cell [x, y, z] (y the surface), `dir` [dx, dz] cardinal, `n` deck cells, `side` left | right,
 * `width` 1..2, `opts` {len: {min, max}}. Returns {ok, code?, evidence?, n, side, width, y, gap: [deck indices over a drop], brackets:
 * [{i, x, z, land}], struts: [[x, y0, y1, z, i]], ends: [i of each end whose bed column meets a drop]}.
 */
export function checkCatwalk(land, a, dir, n, side, width, opts = {}) {
  const [x0, y, z0] = a, [dx, dz] = dir, L = catwalkLanes(width, dir, side), [rx, rz] = rightOf(dir);
  const at = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
  const min = opts.len?.min ?? CATWALK.runMin, max = opts.len?.max ?? CATWALK.runMax;
  const base = { n, side, width, y, lanes: L };
  const fail = (code, evidence) => ({ ok: false, code, evidence: { span: n, side, ...evidence }, ...base });
  const solidAt = (x, yy, z) => SITE_SOLID.includes(land.classAt(x, yy, z)) || !!land.written?.(x, yy, z);
  // NO_GAP: an outer lane over ground 2 or more below the deck
  const gap = [];
  for (let i = 1; i <= n; i++) { const [x, z] = at(i, L.outer); if (land.groundAt(x, z) <= y - CATWALK.drop) gap.push(i); }
  if (!gap.length) return fail('NO_GAP', { message: `no deck cell's outer lane stands ${CATWALK.drop} or more over the ground: nothing to shelf` });
  // ANCHOR: the face site-solid at y .. y + 2 beside every deck cell
  const weak = [];
  for (let i = 1; i <= n; i++) {
    const [x, z] = at(i, L.face);
    for (let yy = y; yy <= y + 2; yy++) if (!solidAt(x, yy, z)) { weak.push({ at: [x, yy, z], class: land.classAt(x, yy, z) }); break; }
  }
  if (weak.length) return fail('ANCHOR', { why: 'face', columns: weak.slice(0, 12), count: weak.length });
  // HEADROOM: every lane and bed cell open at y .. y + 2 (no land, no overhang, no trunk)
  const meets = [];
  for (let i = 1; i <= n; i++) for (const v of [...L.lanes, L.bed]) {
    const [x, z] = at(i, v);
    if (land.topAt(x, z) > land.groundAt(x, z) && land.topAt(x, z) >= y) { meets.push({ at: [x, y, z], why: 'tree' }); continue; }
    for (let yy = y; yy <= y + 2; yy++) {
      const c = land.classAt(x, yy, z);
      if (!OPEN.has(c)) { meets.push({ at: [x, yy, z], class: c, why: yy === y ? 'deck' : 'overhang', clear: yy - y - 1 }); break; }
    }
  }
  if (meets.length) return fail('HEADROOM', { cells: meets.slice(0, 12), count: meets.length, need: 2 });
  // SPAN
  if (n < min || n > max) return fail('SPAN', { min, max });
  // the brackets and struts (the land under the outer lane), the ends' rails
  const brackets = [], struts = [];
  for (const i of bracketIndices(n)) {
    const [x, z] = at(i, L.outer);
    if (!OPEN.has(land.classAt(x, y - 1, z))) { brackets.push({ i, x, z, land: true }); continue; }
    brackets.push({ i, x, z, land: false });
    let foot = null;
    for (let t = 1; t <= CATWALK.strutReach + 1; t++) {
      const yy = y - 1 - t;
      if (OPEN.has(land.classAt(x, yy, z))) continue;
      if (t >= 2 && solidAt(x, yy, z)) foot = yy;
      break;
    }
    if (foot !== null) struts.push([x, foot + 1, y - 2, z, i]);
  }
  const ends = [];
  for (const i of [0, n + 1]) {
    const [x, z] = at(i, L.bed);
    if (land.groundAt(x, z) <= y - CATWALK.drop && [y, y + 1, y + 2].every((yy) => OPEN.has(land.classAt(x, yy, z)))) ends.push(i);
  }
  // the written columns: lanes, bed (and the ends' beds), brackets and struts (the outer lane's column)
  const cols = [];
  for (let i = 1; i <= n; i++) for (const v of [...L.lanes, L.bed]) cols.push([i, v]);
  for (const i of ends) cols.push([i, L.bed]);
  // WATER: no written column over water (a catwalk is not a bridge)
  const wet = cols.map(([i, v]) => at(i, v)).filter(([x, z]) => land.waterAt(x, z));
  if (wet.length) return fail('WATER', { kind: 'under', columns: wet.slice(0, 12), count: wet.length });
  // PROTECTED: keep-out, builds, other regions, lot boxes and aprons, the claim margin
  const prot = cols.map(([i, v]) => at(i, v)).filter(([x, z]) => land.blocked(x, z));
  if (prot.length) return fail('PROTECTED', { columns: prot.slice(0, 12), count: prot.length });
  // OVERLAP: a plan body's hard cells (KC)
  if (land.kept) {
    const hit = [];
    for (const [i, v] of cols) {
      const [x, z] = at(i, v);
      for (const yy of [y, y + 1, y + 2, y - 1]) { const k = land.kept(x, yy, z); if (k) { hit.push({ at: [x, yy, z], body: k.body ?? null }); break; } }
    }
    for (const s of struts) for (let yy = s[1]; yy <= s[2]; yy++) { const k = land.kept(s[0], yy, s[3]); if (k) hit.push({ at: [s[0], yy, s[3]], body: k.body ?? null }); }
    if (hit.length) return fail('OVERLAP', { kind: 'body', cells: hit.slice(0, 12), count: hit.length });
  }
  return { ok: true, ...base, gap, brackets, struts, ends };
}

/**
 * The cells a catwalk writes from a passing check `c`: {deck: [[x, y, z, i, d]] (walk lanes; d the distance from the face), beds:
 * [[x, y, z, i]], rails: [[x, y, z, i]], brackets: [[x, y, z, i]], struts: [[x, y0, y1, z, i]], lamps: [[x, y, z, i]], face: [[x, y,
 * z]] (the face cells beside the deck, y .. y + 2: never written), cells (the walk deck blocks)}. `_unsafe` {noBrackets, noRails,
 * noLamps, wideDeck (one more lane outward: the outer edge 3 from the face)}.
 */
export function catwalkCells(c, a, dir, { lampEvery = 12, noLamps = false, _unsafe = {} } = {}) {
  const [x0, y, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { n } = c, L = c.lanes;
  const at = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
  const lanes = [...L.lanes];
  if (_unsafe.wideDeck) lanes.push(L.lanes[L.lanes.length - 1] - L.step);
  const bedV = _unsafe.wideDeck ? lanes[lanes.length - 1] - L.step : L.bed;
  const deck = [], beds = [], rails = [], brackets = [], struts = [], lamps = [], face = [], cells = [];
  for (let i = 1; i <= n; i++) {
    lanes.forEach((v, k) => { const [x, z] = at(i, v); deck.push([x, y, z, i, k + 1]); cells.push([x, y, z]); });
    const [bx, bz] = at(i, bedV);
    beds.push([bx, y, bz, i]);
    if (!_unsafe.noRails) {
      rails.push([bx, y + 1, bz, i]);
      if (!noLamps && !_unsafe.noLamps && (i - 1) % lampEvery === 0) lamps.push([bx, y + 2, bz, i]);
    }
    const [fx, fz] = at(i, L.face);
    for (let yy = y; yy <= y + 2; yy++) face.push([fx, yy, fz]);
  }
  for (const i of c.ends ?? []) {
    const [bx, bz] = at(i, bedV);
    beds.push([bx, y, bz, i]);
    if (!_unsafe.noRails) rails.push([bx, y + 1, bz, i]);
  }
  if (!_unsafe.noBrackets) {
    for (const b of c.brackets ?? []) if (!b.land) brackets.push([b.x, y - 1, b.z, b.i]);
    for (const s of c.struts ?? []) struts.push([...s]);
  }
  return { deck, beds, rails, brackets, struts, lamps, face, cells, lanes, bedV };
}

/** W's fixture light for the bible's light role standing on a fence (a hanging lantern stands here). */
function fixtureLight(light, rail) {
  const f = fixtureFor(light, rail);
  const state = f.kind === 'hanging_lantern' ? f.light.replace('hanging=true', 'hanging=false') : f.light;
  return { light: state, level: f.level };
}
/** A fence or wall state joined along the run (the rail line). */
function joinedAlong(block, [dx]) {
  const name = String(block).replace(/\[.*$/, '');
  if (/_wall$/.test(name)) return dx !== 0 ? `${name}[east=low,north=none,south=none,up=true,waterlogged=false,west=low]` : `${name}[east=none,north=low,south=low,up=true,waterlogged=false,west=none]`;
  if (/_fence$/.test(name)) return dx !== 0 ? `${name}[east=true,north=false,south=false,waterlogged=false,west=true]` : `${name}[east=false,north=true,south=true,waterlogged=false,west=false]`;
  return block;
}
const FACING = (t) => (t[0] > 0 ? 'east' : t[0] < 0 ? 'west' : t[1] > 0 ? 'south' : 'north');

/** The bracket role's upside-down stair facing the face, and its strut (the wall block, else the fence). */
export function bracketStates(block, toward) {
  const stairs = /_stairs$/.test(String(block).replace(/\[.*$/, '')) ? String(block).replace(/\[.*$/, '') : shapeOf(block, 'stairs') ?? 'minecraft:spruce_stairs';
  const strut = /_(wall|fence)$/.test(String(block).replace(/\[.*$/, '')) ? String(block).replace(/\[.*$/, '') : shapeOf(block, 'wall') ?? shapeOf(block, 'fence') ?? 'minecraft:spruce_fence';
  const strutState = /_wall$/.test(strut) ? `${strut}[east=none,north=none,south=none,up=true,waterlogged=false,west=none]` : /_fence$/.test(strut) ? `${strut}[east=false,north=false,south=false,waterlogged=false,west=false]` : strut;
  return { stair: `${stairs}[facing=${FACING(toward)},half=top,shape=straight,waterlogged=false]`, strut: strutState };
}

/**
 * The writer `catwalkRun(r, a, b, opts)` (§2): a catwalk from the start walk cell `a` = [x, y, z] to the landing `b` (on one axis,
 * 3..32 deck cells apart, the same y), the face on `opts.side`, in part `part` (a path part in `stage`). `opts`: {width = 2, side, id,
 * stage, part = 'links', check (the route row's passing check: the run is never re-judged on another land), land (a direct call's),
 * deck, bracket, rail (roles or blocks; default the bible's connectors.catwalk, then N-CW-1's chains), light (null: no lamps), movers,
 * edge, kept, lampOk, _unsafe}. Writes the deck (walk columns), beds, rails, brackets, struts and lamps (never a clear, never a face cell) and records
 * the catwalk in the plan meta's `catwalks` (the checker's M10:catwalk reads it). Returns the record.
 */
export function catwalkRun(r, a, b, opts = {}) {
  const what = `catwalkRun ${opts.id ?? ''}`.trim();
  const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[2] - a[2]);
  if ((dx !== 0) === (dz !== 0)) throw new Error(`${what}: the ends must lie on one axis (a straight cardinal run)`);
  if (a[1] !== b[1]) throw new Error(`${what}: a catwalk is level (the ends' y differ: ${a[1]}, ${b[1]})`);
  const n = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]) - 1, dir = [dx, dz];
  const width = opts.width ?? 2;
  if (!(Number.isInteger(width) && width >= CATWALK.widthMin && width <= CATWALK.widthMax)) throw new Error(`${what}: width must be ${CATWALK.widthMin}..${CATWALK.widthMax}`);
  if (opts.side !== 'left' && opts.side !== 'right') throw new Error(`${what}: side must be left or right`);
  const u = opts._unsafe ?? {};
  let c = opts.check ? { ...opts.check, lanes: catwalkLanes(width, dir, opts.side) } : null;
  if (!c) {
    if (!opts.land) throw new Error(`${what}: no land to check the run against (opts.land or opts.check)`);
    c = checkCatwalk(opts.land, [a[0], a[1], a[2]], dir, n, opts.side, width, opts.len ? { len: opts.len } : {});
  }
  if (!c.ok) throw new Error(`${c.code}: ${what}: ${JSON.stringify(c.evidence).slice(0, 300)}`);
  const role = (name) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : null);
  const cc = r.ctx?.connectors?.catwalk ?? {};
  // the deck: the bible's slot, then floor, path, structure: the first non-gravity block with a slab (gravel and dirt paths fall through)
  const chain = [opts.deck, cc.deck, 'floor', 'path', 'structure', 'minecraft:spruce_planks'].filter((x) => typeof x === 'string');
  const resolved = chain.map((x) => (role(x) || /^minecraft:/.test(x) ? r.material(x, `${what} deck`) : null)).filter(Boolean);
  const deckBlock = (deckChoice(resolved) ?? { block: 'minecraft:spruce_planks' }).block.replace(/\[.*$/, '');
  const railRole = opts.rail ?? cc.rail ?? role('rail');
  const railBlock = railOf(railRole ? r.material(railRole, `${what} rail`) : null) ?? 'minecraft:spruce_fence';
  const bracketRole = opts.bracket ?? cc.bracket ?? role('frame');
  const L = c.lanes;
  const bs = bracketStates(bracketRole ? r.material(bracketRole, `${what} bracket`) : 'minecraft:spruce_planks', L.toward);
  const noLamps = opts.light === null || !!u.noLamps;
  const fx = fixtureLight(r.material(noLamps ? 'minecraft:lantern' : opts.light ?? (role('light') ? 'light' : 'minecraft:lantern'), `${what} light`), railBlock);
  const lampEvery = Math.max(4, Math.floor((12 * fx.level) / 15));
  const g = catwalkCells(c, [a[0], a[1], a[2]], dir, { lampEvery, noLamps, _unsafe: u });
  // (6c KC, §5) `kept(x, y, z)`: a plan body's hard cell refuses the run (OVERLAP {kind: body}); `lampOk(x, y, z)`: a lamp in a body's
  // watch cell is skipped
  if (opts.kept) {
    const cells = [...g.deck, ...g.beds, ...g.rails, ...g.brackets].map((q) => q.slice(0, 3));
    for (const s of g.struts) for (let y = s[1]; y <= s[2]; y++) cells.push([s[0], y, s[3]]);
    for (const [x, y, z] of cells) { const k = opts.kept(x, y, z); if (k) throw new Error(`OVERLAP: ${what}: cell ${x},${y},${z} is body ${k.body ?? '?'}'s ${k.set ?? 'footprint'}`); }
  }
  let lampsSkipped = 0;
  if (opts.lampOk) { const kept = g.lamps.filter(([x, y, z]) => opts.lampOk(x, y, z)); lampsSkipped = g.lamps.length - kept.length; g.lamps = kept; }
  const part = opts.part ?? 'links';
  const id = opts.id ?? `${part}_catwalk_${(r.meta.catwalks?.length ?? 0) + 1}`;
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage: opts.stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const railState = joinedAlong(railBlock, dir);
  const mats = [deckBlock, railState, bs.stair, bs.strut, fx.light];
  const M = { deck: 0, rail: 1, bracket: 2, strut: 3, lamp: 4 };
  // brackets and struts first (bottom up: what carries a deck cell is written before it, RS's order), then beds and rails, then the deck
  const solidCols = [], walkCols = [];
  for (const [x, y0, y1, z] of g.struts) solidCols.push(x, z, y0, y1, M.strut);
  for (const [x, y, z] of g.brackets) solidCols.push(x, z, y, y, M.bracket);
  for (const [x, y, z] of g.beds) solidCols.push(x, z, y, y, M.deck);
  for (const [x, y, z] of g.rails) solidCols.push(x, z, y, y, M.rail);
  for (const [x, y, z] of g.lamps) solidCols.push(x, z, y, y, M.lamp);
  for (const [x, y, z] of g.deck) walkCols.push(x, z, y, y, M.deck);
  p.columns({ abs: 0 }, { abs: 0 }, solidCols, mats);
  p.columns({ abs: 0 }, { abs: 0 }, walkCols, mats, { walk: true });
  const states = [];
  for (const cols of [solidCols, walkCols]) for (let t = 0; t < cols.length; t += 5) for (let y = cols[t + 2]; y <= cols[t + 3]; y++) states.push(mats[cols[t + 4]]);
  const bom = bomOf(states);
  const xs = [], ys = [], zs = [];
  for (const cols of [solidCols, walkCols]) for (let t = 0; t < cols.length; t += 5) { xs.push(cols[t]); zs.push(cols[t + 1]); ys.push(cols[t + 2], cols[t + 3]); }
  const box = { minX: Math.min(...xs), minY: Math.min(...ys), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...ys) + 1, maxZ: Math.max(...zs) };
  const rec = {
    id, kind: 'catwalk', part: p.id, box, stage: p.stage, width, n, side: opts.side, from: [a[0], a[1], a[2]], to: [b[0], b[1], b[2]], dir, y: a[1],
    lo: L.lo, hi: L.hi, face: L.face, bed: g.bedV, lanes: [...g.lanes],
    deck: deckBlock, rail: railState, bracket: bs.stair, strut: bs.strut, light: noLamps ? null : fx.light, lampEvery,
    // (siteplan/1 catwalks[]: cells and brackets are counts; the cell lists ride in deckCells and bracketCells)
    cells: g.cells.length, brackets: g.brackets.length, deckCells: g.cells, bracketCells: g.brackets.map((q) => [q[0], q[1], q[2], q[3]]),
    landBrackets: (c.brackets ?? []).filter((q) => q.land).map((q) => q.i), bracketAt: bracketIndices(n), struts: g.struts.map((q) => [...q]),
    beds: g.beds.map((q) => [q[0], q[1], q[2], q[3]]), rails: g.rails.map((q) => [q[0], q[1], q[2], q[3]]), lamps: g.lamps.map((q) => [q[0], q[1], q[2]]), ends: [...(c.ends ?? [])],
    faceCells: g.face, gap: c.gap?.length ?? 0, bom, ...(lampsSkipped ? { lampsSkipped } : {}),
    ...(opts.edge ? { edge: opts.edge } : {}), ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(Object.keys(u).length ? { _unsafe: { ...u } } : {}),
  };
  (r.meta.catwalks ??= []).push(rec);
  return rec;
}

/**
 * Write the catwalk runs a route pass found (r.meta.route's edges, their `catwalk` segments: the start walk cell just before the
 * segment's first cell, the landing at its last) with catwalkRun: `{only: [edge ids] | null, stage, part = 'links', prefix = 'catwalk_',
 * style: {deck, bracket, rail, light}, _unsafe}`. Returns [{edge, seg, ...record}].
 */
export function emitRouteCatwalks(r, { only = null, stage, part = 'links', prefix = 'catwalk_', style = {}, _unsafe = null } = {}) {
  const out = [];
  for (const e of r.meta.route?.edges ?? []) {
    if (!e.ok || (only && !only.includes(e.id))) continue;
    (e.segments ?? []).forEach((g, si) => {
      if (g.kind !== 'catwalk') return;
      const a = e.path[g.from], b = e.path[g.to];
      const rec = catwalkRun(r, a, b, { ...style, width: g.width ?? e.width, side: g.side, stage, part, ...(g.check ? { check: g.check } : {}), id: `${prefix}${e.id}_${si}`.slice(0, 48), movers: e.movers, edge: e.id, ...(_unsafe ? { _unsafe } : {}) });
      out.push({ edge: e.id, seg: si, ...rec });
    });
  }
  return out;
}
