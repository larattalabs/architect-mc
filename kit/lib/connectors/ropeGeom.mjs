// (7a K1b) Rope bridges (docs/CONTRACT.md "Phase 7a slice K1" §3, §4, §5; SETTLEMENTS §8.2): the half-block sag profile, the
// span checks (gap, span, rise, headroom, anchors), the cells a bridge writes, and the `r.ropeBridge` primitive. Plan time only,
// pure, integer math (Math.floor/abs/min/max): no clock, no random draw.
//
// Reading of §3 (recorded in "K1b as built"): a span of n deck cells (8..40) runs on a cardinal heading from the near landing cell
// (index 0) over the deck cells (index 1..n) to the far landing cell (index n + 1), both landings walk cells of the route. The
// profile is in half blocks, y2(0) = 2 * y0 (the near landing) and y2(n) = 2 * (y0 + rise) (the last deck cell, level with the far
// landing), where y0 is the near landing's surface block (T2's path y: the feet stand on y0 + 1) and rise the far landing's minus
// it. An even y2 = 2m is a full deck block at m; an odd y2 = 2m + 1 is a bottom slab at m + 1 (its walk surface m + 1.5)
// over a full block at m (the hanger that keeps the deck face-connected through each half step, so M3 grounds it through the
// posts and landings). The feet stand at deckY(y2) + 1 whatever the parity.
import { shapeOf } from './style.mjs';
import { itemOf, voxelClassOf } from '../blocks.mjs';
import { fixtureFor } from '../region/fixtures.mjs';

/** The limits (catalogue 4: `connector.rope_bridge` limits; §4's move). Costs are in T2's units (a straight walk cell is 10). */
export const ROPE = Object.freeze({
  spanMin: 8, spanMax: 40, widthMin: 1, widthMax: 3, villagerMinWidth: 2, approach: 16, approachMax: 32,
  // the gap: an interior column whose ground is more than this below the deck (or water)
  gapDepth: 4,
  // the move's cost: (30 + 3 per deck cell) cells, so a short walk round wins (a walk cell is 10): 300 + 30 n
  cost: 300, costPer: 30,
  // diagnostics scan this far for a span that would land (a span out of 8..40 answers SPAN)
  diagMax: 64,
  // chains (rope) on tall posts every this many deck cells
  ropeEvery: 4,
});

/** §3: d = floor(n / 12), the sag in blocks (spans 8-11 are flat). */
export const sagOf = (n) => Math.floor(n / 12);
/** §3: the largest |rise| a span of n takes (else TOO_STEEP). */
export const maxRiseOf = (n) => Math.floor(n / 8);

/** §3's profile: y2(i) for i = 0..n, one floor over the whole expression. `y0`: the near landing's surface block; `rise`: far minus near. */
export function profile(n, y0, rise) {
  const d = sagOf(n), nn = n * n, out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = Math.floor((2 * y0 * nn + 2 * rise * i * n - 8 * d * i * (n - i)) / nn);
  return out;
}

/** The deck block's cell for a half-block surface y2 (even: the full block at y2 / 2; odd: the bottom slab one above floor(y2 / 2)). */
export const deckY = (y2) => Math.floor((y2 + 1) / 2);
/** Is the deck cell at y2 a bottom slab? */
export const isSlab = (y2) => (y2 & 1) === 1;
/** A deck block's measured y2 (the inverse of deckY/isSlab): a bottom slab at y is 2y - 1, a full block 2y. */
export const y2Of = (y, slab) => (slab ? 2 * y - 1 : 2 * y);

/** The largest step between adjacent profile cells (half blocks). */
export function maxStep(ys) {
  let m = 0;
  for (let i = 1; i < ys.length; i++) m = Math.max(m, Math.abs(ys[i] - ys[i - 1]));
  return m;
}

/** A cardinal heading [dx, dz] and its right-hand vector (T2's hairpin convention: right = [-dz, dx]). */
export const rightOf = ([dx, dz]) => [-dz, dx];
/** The lateral offsets of a deck of width w about its centre line (T2's footprint: lo..hi). */
export const lateral = (w) => ({ lo: -Math.floor((w - 1) / 2), hi: Math.floor(w / 2) });

/** Voxel classes a post or a landing may stand in (§3 Anchors: site-solid). */
export const SITE_SOLID = Object.freeze(['ROCK', 'SOIL']);

/**
 * Check one span (§3, §4): from the near landing `a` = [x, y0, z] (y0 its surface block) on heading `dir` over `n` cells to the far
 * landing at surface y0 + rise. `land`: {groundAt(x, z), topAt(x, z), waterAt(x, z), frozenAt(x, z), blocked(x, z) (an obstacle
 * a deck can't pass over: protected areas, other regions, builds), classAt(x, y, z) -> voxel class of the pre-region world,
 * written(x, y, z) -> true when this plan writes a full block there that M3 grounds (a walk's fill, a pad)}.
 * Returns {ok, code?, evidence?, gap, ys}: the first failing check in order SPAN, TOO_STEEP, NO_GAP, HEADROOM, ANCHOR.
 */
export function checkSpan(land, a, dir, n, rise, width, { gapDepth = ROPE.gapDepth } = {}) {
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = lateral(width);
  if (n < ROPE.spanMin || n > ROPE.spanMax) return { ok: false, code: 'SPAN', evidence: { span: n, min: ROPE.spanMin, max: ROPE.spanMax } };
  if (Math.abs(rise) > maxRiseOf(n)) return { ok: false, code: 'TOO_STEEP', evidence: { span: n, rise, max: maxRiseOf(n) } };
  const ys = profile(n, y0, rise);
  // the gap: a deck column of the centre line whose ground is more than gapDepth below the deck, or water (frozen included)
  let gap = null;
  for (let i = 1; i <= n && !gap; i++) {
    const x = x0 + dx * i, z = z0 + dz * i, y = deckY(ys[i]);
    if (land.waterAt(x, z)) gap = { over: 'water', at: [x, z], depth: y - land.groundAt(x, z) };
    else if (land.groundAt(x, z) < y - gapDepth) gap = { over: 'gap', at: [x, z], depth: y - land.groundAt(x, z) };
  }
  if (!gap) return { ok: false, code: 'NO_GAP', evidence: { span: n, from: [x0, y0, z0], to: [x0 + dx * (n + 1), y0 + rise, z0 + dz * (n + 1)], depthNeeded: gapDepth + 1 } };
  // the clear envelope: the deck (and its hangers), the rails and 2 cells over the surface, across the width plus the rails;
  // the pre-region column's top (ground or trunk) must lie below it, and no keep-out under it
  const hits = [];
  for (let i = 1; i <= n; i++) {
    const lowest = deckY(ys[i]) - (isSlab(ys[i]) ? 1 : 0);
    for (let v = lo - 1; v <= hi + 1; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
      if (land.blocked(x, z)) hits.push({ at: [x, z], why: 'keep-out' });
      else if (Math.max(land.topAt(x, z), land.groundAt(x, z)) >= lowest) hits.push({ at: [x, lowest, z], why: 'terrain', top: Math.max(land.topAt(x, z), land.groundAt(x, z)) });
    }
  }
  if (hits.length) return { ok: false, code: 'HEADROOM', evidence: { span: n, cells: hits.length, sample: hits.slice(0, 8) }, gap, ys };
  // the anchors: the 2 cells under each landing cell and under each post (the posts stand on the rail lines at both landings)
  const bad = [];
  for (const [i, ya] of [[0, y0], [n + 1, y0 + rise]]) {
    for (let v = lo - 1; v <= hi + 1; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
      for (const y of [ya - 1, ya - 2]) {
        if (land.written && land.written(x, y, z)) continue;
        const c = land.classAt(x, y, z);
        if (!SITE_SOLID.includes(c)) bad.push({ at: [x, y, z], class: c, post: v === lo - 1 || v === hi + 1, end: i ? 'far' : 'near' });
      }
    }
  }
  if (bad.length) return { ok: false, code: 'ANCHOR', evidence: { span: n, columns: bad.length, found: bad.slice(0, 12) }, gap, ys };
  return { ok: true, gap, ys };
}

/** A survey-backed land for checkSpan, from a plan survey api (`surveyApi`) and the virtual base's classes (2.5D: lib/region/vworld.mjs surveyBase). */
export function surveyLand(S, { blocked = () => false, written = null, base = null } = {}) {
  // the 2.5D survey's own classes, as the virtual world's base reads them: grass and dirt (SOIL) to 3 below the ground, stone (ROCK)
  // under it, water down to the floor, the bed under water sand (LOOSE), a frozen top ice, trunks logs, air above
  const classAt = (x, y, z) => {
    if (base) return voxelClassOf(base(x, y, z));
    const g = S.groundAt(x, z), f = S.floorAt(x, z);
    if (S.missingAt(x, z)) return 'MISSING';
    if (y > g) return 'AIR';
    if (S.waterAt(x, z) && y > f) return S.frozenAt(x, z) && y === g ? 'ICE' : 'WATER';
    if (S.waterAt(x, z) && y === f) return 'LOOSE';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  return { groundAt: S.groundAt, topAt: S.topAt, waterAt: S.waterAt, frozenAt: S.frozenAt, blocked, classAt, written };
}

/** The deck role's slab variant (minecraft:oak_planks -> minecraft:oak_slab; a log its wood's), or null (the whole-block fallback: player-only). */
export function slabOf(block) {
  if (typeof block !== 'string') return null;
  const name = block.replace(/\[.*$/, '');
  if (/_slab$/.test(name)) return name;
  return shapeOf(name, 'slab');
}

/** A cardinal heading's name for a block axis (`axis=x` along x). */
const axisOf = ([dx]) => (dx !== 0 ? 'x' : 'z');

/**
 * The cells a rope bridge writes (§3): `{deck: [[x, y, z, kind]] (kind 'block' | 'slab' | 'hanger'; walk cells flagged), beds, rails,
 * ropes, posts, lamps, clear}` from the near landing `a` = [x, y0, z] on `dir` over `n` deck cells with `rise`, `width`, the lamp spacing
 * `lampEvery` (W's: floor(12 * level / 15)), `chains` (rope decoration), `whole` (the whole-block profile: every odd y2 rounds up to
 * a full block; the player-only fallback and the `_unsafe.wholeBlockDeck` variant), `postDepth` (2; the broken variant 1).
 */
export function ropeCells(a, dir, n, rise, width, { lampEvery = 12, chains = true, whole = false, postDepth = 2 } = {}) {
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = lateral(width);
  const ys = profile(n, y0, rise).map((y2) => (whole && isSlab(y2) ? y2 + 1 : y2));
  const deck = [], beds = [], rails = [], ropes = [], posts = [], lamps = [], clear = [];
  for (let i = 1; i <= n; i++) {
    const y2 = ys[i], y = deckY(y2), slab = isSlab(y2);
    for (let v = lo - 1; v <= hi + 1; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
      const walk = v >= lo && v <= hi;
      (walk ? deck : beds).push([x, y, z, slab ? 'slab' : 'block', walk ? 1 : 0, i, v]);
      if (slab) (walk ? deck : beds).push([x, y - 1, z, 'hanger', 0, i, v]);
      if (walk) clear.push([x, y + 1, z], [x, y + 2, z]);
      else {
        rails.push([x, y + 1, z, i, v]);
        // a tall post every ropeEvery cells (and every lamp), chains between them
        const tall = i % ROPE.ropeEvery === 0 || i % lampEvery === 0;
        const lampHere = i % lampEvery === 0 && (Math.floor(i / lampEvery) % 2 === 0 ? v === hi + 1 : v === lo - 1);
        if (tall) {
          rails.push([x, y + 2, z, i, v]);
          if (lampHere) lamps.push([x, y + 3, z, i, v]);
        } else if (chains) ropes.push([x, y + 2, z, i, v]);
      }
    }
  }
  // the four posts, on the rail lines at both landings: from postDepth below the landing's surface block to 2 above it
  for (const [i, ya] of [[0, y0], [n + 1, y0 + rise]]) for (const v of [lo - 1, hi + 1]) {
    const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
    posts.push({ x, z, y0: ya - postDepth, y1: ya + 2, landing: ya, end: i ? 'far' : 'near', side: v === lo - 1 ? 'left' : 'right' });
    // a lamp at each landing, on its right-hand post (the far landing's left one, facing the walker)
    if ((i === 0 && v === hi + 1) || (i === n + 1 && v === lo - 1)) lamps.push([x, ya + 3, z, i, v]);
  }
  return { ys, deck, beds, rails, ropes, posts, lamps, clear, axis: axisOf(dir), lo, hi };
}

/**
 * The primitive `r.ropeBridge(a, b, opts)` (§3): a rope bridge from the near landing `a` = [x, y0, z] to the far landing `b`
 * (cardinal, 8..40 apart; y the landings' surface blocks) in part `part` (a path part in `stage`). `opts`: {width = 1, id, stage,
 * part = 'links', deck (a role or block: default the `floor` role, then `path`), rail = 'rail', post = 'frame', rope =
 * 'minecraft:iron_chain' (null: no chains), light = 'light' (W's fixture: the lamp spacing from its level), whole = false,
 * movers, _unsafe: {postDepth, noRails}}. Writes the deck (walk cells), the hangers, the rail beds, the fence rails, the chains,
 * the posts and the lamps, and records `meta.paths[id] = {kind: 'rope', ...}` for M10:rope. Returns the path record.
 */
export function ropeBridge(r, a, b, opts = {}) {
  const what = `ropeBridge ${opts.id ?? ''}`.trim();
  const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[2] - a[2]);
  if ((dx !== 0) === (dz !== 0)) throw new Error(`${what}: the landings must lie on one axis (a straight cardinal span)`);
  const n = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]) - 1, rise = b[1] - a[1], dir = [dx, dz];
  const width = opts.width ?? 1;
  if (!(Number.isInteger(width) && width >= ROPE.widthMin && width <= ROPE.widthMax)) throw new Error(`${what}: width must be ${ROPE.widthMin}..${ROPE.widthMax}`);
  if (n < ROPE.spanMin || n > ROPE.spanMax) throw new Error(`${what}: SPAN ${n} deck cells is outside ${ROPE.spanMin}..${ROPE.spanMax}`);
  if (Math.abs(rise) > maxRiseOf(n)) throw new Error(`${what}: TOO_STEEP: rise ${rise} over ${n} (at most ${maxRiseOf(n)})`);
  const role = (name, fallback) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : fallback);
  // (§6) the bible's connectors member (role names; lib/connectors/style.mjs connectorRoles), else the defaults' chains
  const cr = r.ctx?.connectors?.rope_bridge ?? {};
  const deckBlock = r.material(opts.deck ?? cr.deck ?? role('floor', role('path', 'minecraft:oak_planks')), `${what} deck`);
  const slab = opts.whole ? null : slabOf(deckBlock);
  const whole = !slab;
  const rail = r.material(opts.rail ?? cr.rail ?? role('rail', 'minecraft:oak_fence'), `${what} rail`);
  const post = r.material(opts.post ?? cr.post ?? role('frame', 'minecraft:spruce_log'), `${what} post`);
  // (a part's `lamps: none`: no lamps, light null)
  const noLamps = opts.light === null;
  const lightBlock = r.material(noLamps ? 'minecraft:lantern' : opts.light ?? role('light', 'minecraft:lantern'), `${what} light`);
  const fx = fixtureLight(lightBlock, rail);
  const lampEvery = Math.max(4, Math.floor((12 * fx.level) / 15));
  const ropeRole = opts.rope !== undefined ? opts.rope : cr.rope === 'none' ? null : cr.rope ?? 'minecraft:iron_chain';
  const rope = ropeRole === null ? null : r.material(ropeRole, `${what} rope`);
  const u = opts._unsafe ?? {};
  const g = ropeCells([a[0], a[1], a[2]], dir, n, rise, width, { lampEvery, chains: !!rope, whole, postDepth: u.postDepth ?? 2 });
  const part = opts.part ?? 'links';
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage: opts.stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const axisProp = g.axis;
  const slabState = slab ? `${slab}[type=bottom,waterlogged=false]` : null;
  const chainState = rope ? withAxis(rope, axisProp) : null;
  // the envelope over the walk cells (replaceable plants and snow layers in it): air
  const clr = [];
  for (const [x, y, z] of g.clear) clr.push(x, z, y, y, 0);
  if (clr.length) p.columns({ abs: 0 }, { abs: 0 }, clr, [null]);
  const railState = joinedAlong(rail, dir);
  const mats = [deckBlock, slabState ?? deckBlock, railState, post, chainState ?? railState, fx.light];
  const M = { block: 0, slab: 1, hanger: 0, rail: 2, post: 3, rope: 4, lamp: 5 };
  const walkCols = [], solidCols = [];
  for (const [x, y, z, kind, walk] of g.deck) (walk ? walkCols : solidCols).push(x, z, y, y, M[kind]);
  for (const [x, y, z, kind] of g.beds) solidCols.push(x, z, y, y, M[kind]);
  if (!u.noRails) for (const [x, y, z] of g.rails) solidCols.push(x, z, y, y, M.rail);
  if (!u.noRails) for (const [x, y, z] of g.ropes) solidCols.push(x, z, y, y, M.rope);
  for (const q of g.posts) solidCols.push(q.x, q.z, q.y0, q.y1, M.post);
  if (!noLamps) for (const [x, y, z] of g.lamps) solidCols.push(x, z, y, y, M.lamp);
  p.columns({ abs: 0 }, { abs: 0 }, solidCols, mats);
  p.columns({ abs: 0 }, { abs: 0 }, walkCols, mats, { walk: true });
  // (§7) the bridge's bill of materials: the items of the cells it writes (C26's block-to-item table: blocks.mjs itemOf)
  const bomM = new Map();
  for (const cols of [solidCols, walkCols]) for (let t = 0; t < cols.length; t += 5) {
    const item = itemOf(String(mats[cols[t + 4]]).replace(/\[.*$/, ''));
    if (item) bomM.set(item, (bomM.get(item) ?? 0) + cols[t + 3] - cols[t + 2] + 1);
  }
  const bom = Object.fromEntries([...bomM.entries()].sort(([a1], [b1]) => (a1 < b1 ? -1 : a1 > b1 ? 1 : 0)));
  const id = opts.id ?? `${p.id}_rope_${r.paths.length + 1}`;
  const xs = [...g.deck, ...g.beds].map((c) => c[0]).concat(g.posts.map((q) => q.x)), zs = [...g.deck, ...g.beds].map((c) => c[2]).concat(g.posts.map((q) => q.z));
  const ysAll = [...g.deck, ...g.beds].map((c) => c[1]).concat(g.posts.flatMap((q) => [q.y0, q.y1 + 1]));
  const box = { minX: Math.min(...xs), minY: Math.min(...ysAll), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...ysAll) + 1, maxZ: Math.max(...zs) };
  r.paths.push({ id, stage: p.stage, part: p.id, kind: 'rope', box });
  const rec = {
    kind: 'rope', part: p.id, stage: p.stage, width, n, rise, from: [a[0], a[1], a[2]], to: [b[0], b[1], b[2]], dir, lo: g.lo, hi: g.hi,
    whole, deck: deckBlock, slab: slabState, rail, post, rope: chainState, light: fx.light, lampEvery, y2: g.ys,
    cells: g.deck.filter((c) => c[4]).map((c) => [c[0], c[1], c[2]]),
    posts: g.posts.map((q) => ({ x: q.x, z: q.z, y0: q.y0, y1: q.y1, landing: q.landing, end: q.end, side: q.side })),
    lamps: g.lamps.map((c) => [c[0], c[1], c[2]]), bom,
    ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(u.postDepth !== undefined || u.noRails ? { _unsafe: { ...u } } : {}),
  };
  r.meta.paths[id] = rec;
  return { id, ...rec };
}

/** W's fixture for the bible's light and rail roles (lib/region/fixtures.mjs); a hanging lantern stands on the post here. */
function fixtureLight(light, rail) {
  const f = fixtureFor(light, rail);
  const state = f.kind === 'hanging_lantern' ? f.light.replace('hanging=true', 'hanging=false') : f.light;
  return { light: state, level: f.level, post: f.post, kind: f.kind };
}
/** A fence (or wall) state joined along the span (both sides of its axis), so the rail reads as one line; any other block as given. */
function joinedAlong(block, [dx]) {
  const name = String(block).replace(/\[.*$/, '');
  if (!/_(fence|wall)$/.test(name) || /_gate$/.test(name)) return block;
  if (/_wall$/.test(name)) return dx !== 0 ? `${name}[east=low,north=none,south=none,up=true,waterlogged=false,west=low]` : `${name}[east=none,north=low,south=low,up=true,waterlogged=false,west=none]`;
  return dx !== 0 ? `${name}[east=true,north=false,south=false,waterlogged=false,west=true]` : `${name}[east=false,north=true,south=true,waterlogged=false,west=false]`;
}
/** A chain state with its axis set (any other block as given). */
function withAxis(block, axis) {
  const name = String(block).replace(/\[.*$/, '');
  return /_chain$/.test(name) ? `${name}[axis=${axis},waterlogged=false]` : block;
}

/**
 * Write the rope spans a route pass found (r.meta.route's edges, their `rope` segments: near landing at the segment's first cell,
 * far landing at its last) with ropeBridge: `{only: [edge ids] | null, stage, part = 'links', prefix = 'rope_', style: {deck, rail,
 * post, rope, light}, _unsafe}`. Returns [{edge, id, n, rise, from, to, ...}] (the path records). A program that runs the route pass
 * itself calls it after the pass (plan_v0 does it in its links stage, kit/lib/connectors/rope.mjs).
 */
export function emitRouteRopes(r, { only = null, stage, part = 'links', prefix = 'rope_', style = {}, _unsafe = null, whole = false } = {}) {
  const out = [];
  for (const e of r.meta.route?.edges ?? []) {
    if (!e.ok || (only && !only.includes(e.id))) continue;
    (e.segments ?? []).forEach((g, si) => {
      if (g.kind !== 'rope') return;
      const a = e.path[g.from], b = e.path[g.to];
      const rec = ropeBridge(r, a, b, { ...style, width: e.width, stage, part, id: `${prefix}${e.id}_${si}`.slice(0, 48), movers: e.movers, ...(_unsafe ? { _unsafe } : {}), ...(whole ? { whole: true } : {}) });
      out.push({ edge: e.id, ...rec });
    });
  }
  return out;
}
