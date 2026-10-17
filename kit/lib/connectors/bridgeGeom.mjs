// (6c T3a) Solid bridges (docs/CONTRACT.md "Phase 6c slice T3" §3, §5, §7; SETTLEMENTS §4.3, §8.2): the span checks (gap, span, rise,
// head room, clearance over water, anchors, piers), the cells a beam or an arch writes, the `r.bridgeSpan` primitive and the links
// stage's emission of the spans a route pass found. Plan time only, pure, integer math (Math.floor/abs/min/max): no clock, no random
// draw. This module never imports the compiler or the region program (K1's integration lesson: no import cycle).
//
// Reading of §3 (recorded in "T3a as built"):
// - A span of n deck cells (1..32) runs on a cardinal heading from the near landing (index 0) over the deck cells (1..n) to the far
//   landing (n + 1), both walk cells of the route; y0 is the near landing's surface block (feet on y0 + 1), rise the far landing's
//   minus it. The deck follows K1b's half-block profile (ropeGeom.mjs `profile`) with a signed sag: a beam d = 0 (a straight
//   half-block line), an arch d = -floor(n / 12) (a camber). |rise| <= max(1, floor(n / 8)), and at most floor(n / 2) so every step
//   is one half block (a 1-cell span is level).
// - A deck cell at an even y2 is a full block at y2 / 2; at an odd y2 a bottom slab at floor(y2 / 2) + 1 over a full block (K1b's
//   reading), the whole width plus the rail beds; the rail (the trim role's wall block, else the rail role's fence) stands on the
//   beds at the deck block + 1.
// - The gap: a centre column that is water (frozen included) or whose ground is more than 4 below the deck; or, for n <= 7 (a
//   narrow gap), water or a drop of 2 or more.
// - Head room: every deck column's land (ground, or a tree column's 64 high) lies under the bridge's lowest cell there, across the
//   width plus the rails, and none is blocked (keep-out, other regions, builds); the deck is never written into the land, so the 2
//   cells over the walk surface are the pre-region air.
// - Over water: no bridge cell at or under the water's surface (its top block, an ice top included); a beam's underside (and an
//   arch's intrados over the middle third of the water's run) clears the surface by `clearance` cells.
// - Beam supports: the landings, and piers (the deck's cross-section in the pier role) at most every 8 deck cells, from the deck
//   down to the ground, ending 2 deep in it (the ground block and the one under it replaced, which must be site-solid: ROCK or SOIL
//   in the pre-region classes, or written by the plan); at most 24 tall. The fewest piers, evenly spaced (one spacing, one offset),
//   ties by the lowest total height, then the smallest offset, then the smallest spacing. No pier on water, a tree or a blocked
//   column: a dry run longer than 8 with no pier site is WATER (until H).
// - Arch: 4 <= n <= 24; intrados yi(i) = ys + floor(4 R i (n + 1 - i) / (n + 1)^2), R = max(2, floor(n / 4)); ys the highest
//   springing that keeps one solid course under the deck's lowest cell at every column (the crown binds); the ring and spandrels
//   solid from the intrados to the deck in the arch role. Abutments: the landings' ground, site-solid (or written) from 2 under the
//   springing up to the landing.
// - Lamps: W's fixture light on the rails every floor(12 * level / 15) deck cells (alternate sides), and one on each landing's newel
//   post (the pier role 2 deep under the landing, the rail over it, the lamp on top), as K1b's posts.
import { shapeOf } from './style.mjs';
import { voxelClassOf, isGravity } from '../blocks.mjs';
import { bomOf } from './bom.mjs';
import { fixtureFor } from '../region/fixtures.mjs';
import { profile, sagOf, deckY, isSlab, rightOf, lateral, SITE_SOLID } from './ropeGeom.mjs';

/** The limits (catalogue 6: `connector.bridge`), costs in T2's units (a straight walk cell is 10). */
export const BRIDGE = Object.freeze({
  spanMin: 1, spanMax: 32, widthMin: 1, widthMax: 5, villagerMinWidth: 2, archMin: 4, archMax: 24, pierEvery: 8, pierDepth: 24,
  clearance: 2, clearanceMax: 6, approach: 16, approachMax: 32,
  // the gap: an interior column more than gapDepth below the deck (or water); a narrow gap (n <= narrowMax): a drop of narrowDrop
  gapDepth: 4, narrowMax: 7, narrowDrop: 2,
  // the move's cost: 320 + 30 per deck cell + 40 per pier (rope's 300 + 30 n plus 20, so where both fit, auto keeps K1's rope)
  cost: 320, costPer: 30, costPier: 40,
  // the diagnosis scans this far for a span that would land (a span outside the limits answers SPAN)
  diagMax: 64,
});

/** §3's rise bound, and at most n / 2 (one half block a step). */
export const maxRiseOf = (n) => Math.min(Math.max(1, Math.floor(n / 8)), Math.floor(n / 2));
/** The signed sag of a form (beam 0, arch the camber -floor(n / 12)). */
export const sagFor = (form, n) => (form === 'arch' ? -sagOf(n) : 0);
/** The arch's rise R. */
export const archRise = (n) => Math.max(2, Math.floor(n / 4));
/** The arch's intrados offset over the springing at deck index i (0..n + 1). */
export const archOffset = (n, i) => Math.floor((4 * archRise(n) * i * (n + 1 - i)) / ((n + 1) * (n + 1)));
/** The lowest cell a deck cell at y2 writes (a slab's full block under it). */
export const lowestOf = (y2) => deckY(y2) - (isSlab(y2) ? 1 : 0);

/** The evenly spaced pier sets with k piers over n deck cells (supports at 0 and n + 1 at most pierEvery apart): [[i...]]. */
function pierSets(n, k, every = BRIDGE.pierEvery) {
  if (k === 0) return n + 1 <= every ? [[]] : [];
  const out = [];
  for (let s = 1; s <= every; s++) for (let a = 1; a <= Math.min(every, n); a++) {
    const last = a + (k - 1) * s;
    if (last > n || n + 1 - last > every) continue;
    const set = [];
    for (let j = 0; j < k; j++) set.push(a + j * s);
    out.push(set);
  }
  return out;
}
const cmpKeys = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };
/** The fewest piers a span of n deck cells needs. */
export const piersFor = (n, every = BRIDGE.pierEvery) => Math.max(0, Math.floor((n + 1 + every - 1) / every) - 1);

/**
 * Check one span (§3, §4's order: NO_GAP, SPAN, TOO_STEEP, HEADROOM, ANCHOR, WATER). `land`: {groundAt, topAt, waterAt, frozenAt,
 * blocked, classAt, written} (ropeGeom.mjs checkSpan's). `a` = [x, y0, z] the near landing, `dir` cardinal, `n` deck cells, `rise`,
 * `width`. Options: `form` beam | arch | auto, `clearance` (default 2), `span` {min, max} (the part's own), `every`/`depth` (the
 * broken variants' pier spacing and pier depth). Returns {ok, form, code?, evidence?, until?, ys, lowest, piers, springing, intrados,
 * over, depth, under} (auto: the arch when it holds, else the beam; failing both, the beam's failure with the arch's in evidence.arch).
 */
export function checkBridge(land, a, dir, n, rise, width, opts = {}) {
  const form = opts.form ?? 'auto';
  if (form === 'auto') {
    const arch = n >= BRIDGE.archMin && n <= BRIDGE.archMax ? checkBridge(land, a, dir, n, rise, width, { ...opts, form: 'arch' }) : null;
    if (arch?.ok) return arch;
    const beam = checkBridge(land, a, dir, n, rise, width, { ...opts, form: 'beam' });
    if (beam.ok || !arch) return beam;
    return { ...beam, evidence: { ...(beam.evidence ?? {}), arch: { code: arch.code, ...(arch.evidence?.under ? { under: arch.evidence.under } : {}) } } };
  }
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = lateral(width);
  const clearance = opts.clearance ?? BRIDGE.clearance;
  const sMin = Math.max(BRIDGE.spanMin, opts.span?.min ?? BRIDGE.spanMin), sMax = Math.min(BRIDGE.spanMax, opts.span?.max ?? BRIDGE.spanMax);
  const fail = (code, evidence, extra = {}) => ({ ok: false, form, code, evidence: { span: n, form, ...evidence }, ...extra });
  const col = (i, v) => [x0 + dx * i + rx * v, z0 + dz * i + rz * v];
  // the gap, on the straight deck line (the form's camber never makes a gap)
  const line = profile(n, y0, rise, 0);
  let gap = null;
  for (let i = 1; i <= n && !gap; i++) {
    const [x, z] = col(i, 0), y = deckY(line[i]), g = land.groundAt(x, z);
    if (land.waterAt(x, z)) gap = { over: 'water', at: [x, z], depth: y - g };
    else if (g < y - BRIDGE.gapDepth || (n <= BRIDGE.narrowMax && g <= y - BRIDGE.narrowDrop)) gap = { over: 'gap', at: [x, z], depth: y - g };
  }
  if (!gap) return fail('NO_GAP', { from: [x0, y0, z0], to: [x0 + dx * (n + 1), y0 + rise, z0 + dz * (n + 1)], depthNeeded: n <= BRIDGE.narrowMax ? BRIDGE.narrowDrop : BRIDGE.gapDepth + 1 });
  if (n < sMin || n > sMax) return fail('SPAN', { min: sMin, max: sMax });
  if (form === 'arch' && (n < BRIDGE.archMin || n > BRIDGE.archMax)) return fail('SPAN', { min: BRIDGE.archMin, max: BRIDGE.archMax, archSpan: [BRIDGE.archMin, BRIDGE.archMax] });
  if (Math.abs(rise) > maxRiseOf(n)) return fail('TOO_STEEP', { rise, max: maxRiseOf(n) });
  const ys = profile(n, y0, rise, sagFor(form, n));
  const lowest = [0];
  for (let i = 1; i <= n; i++) lowest.push(lowestOf(ys[i]));
  // the arch: the springing (the highest that keeps one solid course under the deck's lowest cell at every column) and the intrados
  let springing = null, intrados = null;
  if (form === 'arch') {
    springing = Infinity;
    for (let i = 1; i <= n; i++) springing = Math.min(springing, lowest[i] - 1 - archOffset(n, i));
    intrados = [];
    for (let i = 0; i <= n + 1; i++) intrados.push(springing + archOffset(n, i));
  }
  // the bridge's lowest written cell per deck index (a beam's underside; an arch's intrados)
  const bottom = (i) => (form === 'arch' ? intrados[i] : lowest[i]);
  // head room: the land under the deck everywhere across the width plus the rails, nothing blocked
  const hits = [];
  for (let i = 1; i <= n; i++) for (let v = lo - 1; v <= hi + 1; v++) {
    const [x, z] = col(i, v);
    const top = Math.max(land.topAt(x, z), land.groundAt(x, z));
    if (land.blocked(x, z)) hits.push({ at: [x, z], why: 'keep-out' });
    else if (top >= lowest[i]) hits.push({ at: [x, lowest[i], z], why: 'terrain', top });
  }
  if (hits.length) return fail('HEADROOM', { cells: hits.length, sample: hits.slice(0, 8) });
  // over water: never at or under the surface; the clearance (a beam everywhere, an arch over the middle third of the water's run)
  const wet = [];
  for (let i = 1; i <= n; i++) if (land.waterAt(...col(i, 0))) wet.push(i);
  let under = null;
  // (an arch's ring over a water column starts one over the surface: no write in water; `wetTop` keys those columns' surface)
  const wetTop = {};
  if (wet.length) {
    const first = wet[0], last = wet[wet.length - 1], third = Math.floor((last - first + 1) / 3);
    let have = Infinity;
    const low = [];
    for (let i = 1; i <= n; i++) for (let v = lo - 1; v <= hi + 1; v++) {
      const [x, z] = col(i, v);
      if (!land.waterAt(x, z)) continue;
      const g = land.groundAt(x, z), b = form === 'arch' ? Math.max(bottom(i), land.groundAt(x, z) + 1) : bottom(i);
      wetTop[`${x},${z}`] = g;
      if (bottom(i) <= g) low.push([x, bottom(i), z]);
      const judged = form === 'beam' || (i >= first + third && i <= last - third);
      if (judged) have = Math.min(have, b - g - 1);
    }
    if (low.length && form === 'beam') return fail('HEADROOM', { under: { need: clearance, have: Math.min(...low.map((q) => q[1])) - 1 }, sample: low.slice(0, 8) });
    under = { need: clearance, have: have === Infinity ? clearance : have };
    if (under.have < clearance) return fail('HEADROOM', { under, middleThird: form === 'arch' ? [first + third, last - third] : null });
  }
  // anchors: the 2 cells under each landing across the width plus the rails (the newel posts stand there), in the natural ground: a
  // landing on the walk's fill (the route fills under its surface; the posts reach down to the ground) anchors in the 2 cells under
  // the fill
  const bad = [];
  const solidAt = (x, y, z) => (land.written && land.written(x, y, z)) || SITE_SOLID.includes(land.classAt(x, y, z));
  const anchorTop = (x, z, ya) => Math.min(ya - 1, land.groundAt(x, z));
  for (const [i, ya] of [[0, y0], [n + 1, y0 + rise]]) for (let v = lo - 1; v <= hi + 1; v++) {
    const [x, z] = col(i, v), t = anchorTop(x, z, ya);
    if (land.waterAt(x, z)) { bad.push({ at: [x, t, z], class: 'WATER', end: i ? 'far' : 'near' }); continue; }
    for (const y of [t, t - 1]) if (!solidAt(x, y, z)) bad.push({ at: [x, y, z], class: land.classAt(x, y, z), end: i ? 'far' : 'near' });
  }
  // an arch's abutments: the landings' ground solid from 2 under the springing up to the landing (the fill over the ground counts)
  if (form === 'arch') {
    for (const [i, ya] of [[0, y0], [n + 1, y0 + rise]]) for (let v = lo - 1; v <= hi + 1; v++) {
      const [x, z] = col(i, v), t = anchorTop(x, z, ya);
      for (let y = springing - 2; y <= Math.min(t, ya - 3); y++) if (!solidAt(x, y, z)) bad.push({ at: [x, y, z], class: land.classAt(x, y, z), end: i ? 'far' : 'near', abutment: true });
    }
  }
  if (bad.length) return fail('ANCHOR', { columns: bad.length, found: bad.slice(0, 12) });
  // a beam's piers
  let piers = [];
  if (form === 'beam') {
    const every = opts.every ?? BRIDGE.pierEvery, depth = opts.depth ?? 2;
    // each deck index's pier site: dry, not a tree, not blocked, 2 deep in site-solid, at most pierDepth tall
    const site = [null];
    let waterRun = 0, worstRun = 0;
    for (let i = 1; i <= n; i++) {
      let s = { ok: true, height: 0, cols: [] };
      for (let v = lo - 1; v <= hi + 1 && s.ok; v++) {
        const [x, z] = col(i, v), g = land.groundAt(x, z);
        if (land.waterAt(x, z)) { s = { ok: false, water: true, at: [x, z] }; break; }
        if (land.topAt(x, z) > g || land.blocked(x, z)) { s = { ok: false, why: land.blocked(x, z) ? 'blocked' : 'tree', at: [x, z] }; break; }
        for (let d = 0; d < depth; d++) if (!solidAt(x, g - d, z)) { s = { ok: false, why: 'class', at: [x, g - d, z], class: land.classAt(x, g - d, z) }; break; }
        if (!s.ok) break;
        const h = lowest[i] - 1 - (g - depth + 1) + 1;
        if (h > BRIDGE.pierDepth) { s = { ok: false, why: 'depth', at: [x, z], depth: h }; break; }
        s.height += h;
        s.cols.push({ x, z, y0: g - depth + 1, y1: lowest[i] - 1 });
      }
      site.push(s);
      waterRun = s.water ? waterRun + 1 : 0;
      worstRun = Math.max(worstRun, waterRun);
    }
    // the fewest evenly spaced piers on usable sites (one spacing, one offset); ties by the lowest total height, then the most even
    // (the smallest longest unsupported run, then the end runs nearest equal), then the smallest offset, then the smallest spacing;
    // with no evenly spaced set within two piers of the fewest, the greedy set (each pier the farthest usable site within `every`
    // of the last support)
    let best = null;
    const kMin = piersFor(n, every);
    const keyOf = (set, h) => {
      if (!set.length) return [h, n + 1, 0, 0, 0];
      const first = set[0], last = n + 1 - set[set.length - 1], sp = set.length > 1 ? set[1] - set[0] : 0;
      return [h, Math.max(first, last, sp), Math.abs(first - last), first, sp];
    };
    for (let k = kMin; k <= Math.min(n, kMin + 2) && !best; k++) {
      for (const set of pierSets(n, k, every)) {
        if (!set.every((i) => site[i].ok)) continue;
        const key = keyOf(set, set.reduce((t, i) => t + site[i].height, 0));
        if (!best || cmpKeys(key, best.key) < 0) best = { set, key };
      }
    }
    if (!best) {
      const set = [];
      let last = 0, stuck = false;
      while (!stuck && n + 1 - last > every) {
        let next = -1;
        for (let i = Math.min(n, last + every); i > last; i--) if (site[i].ok) { next = i; break; }
        if (next < 0) stuck = true; else { set.push(next); last = next; }
      }
      if (!stuck) best = { set, greedy: true };
    }
    if (!best) {
      // why: a stretch of more than `every` deck cells with no usable site, holding water, is a pier needed in water (until H)
      let prev = 0, wetGap = null;
      for (let i = 1; i <= n + 1; i++) {
        if (i <= n && !site[i].ok) continue;
        if (i - prev > every) {
          const water = [];
          for (let t = prev + 1; t < i; t++) if (site[t].water) water.push(col(t, 0));
          if (water.length && !wetGap) wetGap = { from: prev, to: i, water: water.length, sample: water.slice(0, 6) };
        }
        prev = i;
      }
      if (wetGap) return fail('WATER', { kind: 'water', pierNeeded: true, run: wetGap, message: `a pier is needed in water (deck cells ${wetGap.from + 1}..${wetGap.to - 1}): writes in water wait for H` }, { until: 'H' });
      const why = site.slice(1).filter((s) => !s.ok);
      return fail('ANCHOR', { piers: 'no pier set', found: why.slice(0, 12).map((s) => ({ at: s.at, why: s.why ?? 'water', ...(s.class ? { class: s.class } : {}), ...(s.depth ? { depth: s.depth } : {}) })), ...(why.some((s) => s.depth) ? { depth: Math.max(...why.filter((s) => s.depth).map((s) => s.depth)) } : {}) });
    }
    piers = best.set.map((i) => ({ i, cols: site[i].cols, height: Math.max(...site[i].cols.map((c) => c.y1 - c.y0 + 1)) }));
    void worstRun;
  }
  let depth = 0;
  for (let i = 1; i <= n; i++) { const [x, z] = col(i, 0); depth = Math.max(depth, deckY(ys[i]) - land.groundAt(x, z)); }
  const ground = {};
  for (const [i] of [[0], [n + 1]]) for (const v of [lo - 1, hi + 1]) { const [x, z] = col(i, v); ground[`${x},${z}`] = land.groundAt(x, z); }
  return { ok: true, form, ys, lowest, piers, springing, intrados, wetTop, ground, over: wet.length ? 'water' : 'gap', depth, under, gap };
}

/** A survey-backed land (ropeGeom.mjs surveyLand's shape), for the primitive and the tests. */
export { surveyLand } from './ropeGeom.mjs';

/** The deck role's block for a bridge: the first of the chain that is not a gravity block and has a slab variant, else null. */
export function deckChoice(blocks) {
  for (const b of blocks) {
    if (typeof b !== 'string') continue;
    const name = b.replace(/\[.*$/, '');
    if (isGravity(name)) continue;
    const slab = /_slab$/.test(name) ? name : shapeOf(name, 'slab');
    if (slab) return { block: b, slab };
  }
  return null;
}
/** The rail: a block's wall variant, else its fence, else the block itself when it is a fence or wall. */
export function railOf(block) {
  if (typeof block !== 'string') return null;
  const name = block.replace(/\[.*$/, '');
  if (/_(wall|fence)$/.test(name) && !/_gate$/.test(name)) return name;
  return shapeOf(name, 'wall') ?? shapeOf(name, 'fence');
}

/**
 * The cells a bridge writes (§3): `{deck: [[x, y, z, kind, walk, i, v]] (kind block | slab | hanger), rails, piers: [[x, y0, y1, z]],
 * body: [[x, y0, y1, z]] (an arch's ring and spandrels), posts, lamps, clear, cells (the walk deck blocks)}` from a passing check `c`
 * (checkBridge), the near landing `a`, `dir`, `n`, `rise`, `width`, the lamp spacing.
 */
export function bridgeCells(c, a, dir, n, rise, width, { lampEvery = 12, noRails = false, noPiers = false, noLamps = false } = {}) {
  const [x0, y0, z0] = a, [dx, dz] = dir, [rx, rz] = rightOf(dir), { lo, hi } = lateral(width);
  const deck = [], rails = [], piers = [], body = [], posts = [], lamps = [], clear = [], cells = [];
  for (let i = 1; i <= n; i++) {
    const y2 = c.ys[i], y = deckY(y2), slab = isSlab(y2);
    for (let v = lo - 1; v <= hi + 1; v++) {
      const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
      const walk = v >= lo && v <= hi;
      deck.push([x, y, z, slab ? 'slab' : 'block', walk ? 1 : 0, i, v]);
      if (slab) deck.push([x, y - 1, z, 'hanger', 0, i, v]);
      if (walk) { clear.push([x, y + 1, z], [x, y + 2, z]); cells.push([x, y, z]); }
      else if (!noRails) {
        rails.push([x, y + 1, z, i, v]);
        if (!noLamps && i % lampEvery === 0 && (Math.floor(i / lampEvery) % 2 === 0 ? v === hi + 1 : v === lo - 1)) lamps.push([x, y + 2, z, i, v]);
      }
      if (c.form === 'arch') {
        const wt = c.wetTop?.[`${x},${z}`];
        const yb = wt === undefined ? c.intrados[i] : Math.max(c.intrados[i], wt + 1), yt = lowestOf(y2) - 1;
        if (yt >= yb) body.push([x, yb, yt, z]);
      }
    }
  }
  if (c.form === 'beam' && !noPiers) for (const p of c.piers) for (const q of p.cols) piers.push([q.x, q.y0, q.y1, q.z, p.i]);
  // the newel posts on the rail lines at both landings: the pier role 2 deep under the landing up to it, the rail over it, a lamp on the
  // near landing's right-hand post and the far landing's left-hand one
  for (const [i, ya] of [[0, y0], [n + 1, y0 + rise]]) for (const v of [lo - 1, hi + 1]) {
    const x = x0 + dx * i + rx * v, z = z0 + dz * i + rz * v;
    const g = c.ground?.[`${x},${z}`];
    const bottom = g === undefined ? ya - 2 : Math.min(ya - 2, g + 1);
    posts.push({ x, z, y0: bottom, y1: ya, landing: ya, end: i ? 'far' : 'near', side: v === lo - 1 ? 'left' : 'right' });
    if (!noRails) rails.push([x, ya + 1, z, i, v]);
    if (!noRails && !noLamps && ((i === 0 && v === hi + 1) || (i === n + 1 && v === lo - 1))) lamps.push([x, ya + 2, z, i, v]);
  }
  return { deck, rails, piers, body, posts, lamps, clear, cells, lo, hi, axis: dx !== 0 ? 'x' : 'z' };
}

/** W's fixture light for the bible's light role standing on a rail (a hanging lantern stands here). */
function fixtureLight(light, rail) {
  const f = fixtureFor(light, rail);
  const state = f.kind === 'hanging_lantern' ? f.light.replace('hanging=true', 'hanging=false') : f.light;
  return { light: state, level: f.level };
}
/** A fence or wall rail state joined along the span. */
function joinedAlong(block, [dx]) {
  const name = String(block).replace(/\[.*$/, '');
  if (/_wall$/.test(name)) return dx !== 0 ? `${name}[east=low,north=none,south=none,up=true,waterlogged=false,west=low]` : `${name}[east=none,north=low,south=low,up=true,waterlogged=false,west=none]`;
  if (/_fence$/.test(name)) return dx !== 0 ? `${name}[east=true,north=false,south=false,waterlogged=false,west=true]` : `${name}[east=false,north=true,south=true,waterlogged=false,west=false]`;
  return block;
}

/**
 * The primitive `r.bridgeSpan(a, b, opts)` (§3): a beam or an arch from the near landing `a` = [x, y0, z] to the far landing `b` (on one
 * axis, 1..32 deck cells apart; y the landings' surface blocks), in part `part` (a path part in `stage`). `opts`: {width = 2, form =
 * 'auto', clearance = 2, id, stage, part = 'links', land (checkBridge's; default the plan survey's), deck, rail, pier, arch (roles or
 * blocks; default the bible's connectors.bridge, then §7's chains), light (null: no lamps), movers, edge, lands, _unsafe: {noPiers,
 * noRails, noLamps, pierInWater, every, depth}}. Checks the span first (a refusal throws `<CODE>: ...`), then writes the deck, the rail
 * beds and rails, the piers or the arch, the newel posts and the lamps, and records the bridge in the plan meta's `bridges` (the
 * checker's M10:bridge reads it). Returns the record.
 */
export function bridgeSpan(r, a, b, opts = {}) {
  const what = `bridgeSpan ${opts.id ?? ''}`.trim();
  const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[2] - a[2]);
  if ((dx !== 0) === (dz !== 0)) throw new Error(`${what}: the landings must lie on one axis (a straight cardinal span)`);
  const n = Math.abs(b[0] - a[0]) + Math.abs(b[2] - a[2]) - 1, rise = b[1] - a[1], dir = [dx, dz];
  const width = opts.width ?? 2;
  if (!(Number.isInteger(width) && width >= BRIDGE.widthMin && width <= BRIDGE.widthMax)) throw new Error(`${what}: width must be ${BRIDGE.widthMin}..${BRIDGE.widthMax}`);
  const u = opts._unsafe ?? {};
  // a route's span carries the pass's own check (the same land the search judged it on); a direct call checks against `land`
  let c = opts.check ? { ...opts.check } : null;
  const land = opts.land ?? null;
  if (!c) {
    if (!land) throw new Error(`${what}: no land to check the span against (opts.land or opts.check)`);
    c = checkBridge(land, [a[0], a[1], a[2]], dir, n, rise, width, { form: opts.form ?? 'auto', clearance: opts.clearance ?? BRIDGE.clearance, ...(u.every ? { every: u.every } : {}), ...(u.depth ? { depth: u.depth } : {}) });
  }
  if (!c.ok && !(u.pierInWater && c.code === 'WATER')) throw new Error(`${c.code}: ${what}: ${JSON.stringify(c.evidence).slice(0, 300)}`);
  const role = (name) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? name : null);
  const firstRole = (...names) => names.map(role).find((x) => x) ?? null;
  const cb = r.ctx?.connectors?.bridge ?? {};
  // the deck: the bible's slot, then path, floor, structure: the first non-gravity block with a slab (gravel and dirt paths fall through)
  const chain = [opts.deck, cb.deck, 'path', 'floor', 'structure', 'minecraft:stone_bricks'].filter((x) => typeof x === 'string');
  const resolved = chain.map((x) => (role(x) ? r.material(x, `${what} deck`) : /^minecraft:/.test(x) ? r.material(x, `${what} deck`) : null)).filter(Boolean);
  const dc = deckChoice(resolved) ?? { block: 'minecraft:stone_bricks', slab: 'minecraft:stone_brick_slab' };
  const railRole = opts.rail ?? cb.rail ?? firstRole('trim', 'rail');
  const railBlock = railOf(railRole ? r.material(railRole, `${what} rail`) : null) ?? railOf(role('rail') ? r.material('rail', `${what} rail`) : null) ?? 'minecraft:stone_brick_wall';
  const pierBlock = r.material(opts.pier ?? cb.pier ?? firstRole('structure', 'foundation', 'wall') ?? 'minecraft:stone_bricks', `${what} pier`);
  const archBlock = r.material(opts.arch ?? cb.arch ?? firstRole('structure', 'foundation', 'wall') ?? 'minecraft:stone_bricks', `${what} arch`);
  const noLamps = opts.light === null || !!u.noLamps;
  const fx = fixtureLight(r.material(noLamps ? 'minecraft:lantern' : opts.light ?? (role('light') ? 'light' : 'minecraft:lantern'), `${what} light`), railBlock);
  const lampEvery = Math.max(4, Math.floor((12 * fx.level) / 15));
  // the broken variant pierInWater: a pier at the middle deck index down to the water's floor
  if (u.pierInWater && c.code === 'WATER') {
    Object.assign(c, { ok: true, form: 'beam', ys: profile(n, a[1], rise, 0) });
    c.lowest = [0, ...c.ys.slice(1).map(lowestOf)];
    const mid = Math.max(1, Math.floor((n + 1) / 2)), { lo, hi } = lateral(width), [rx, rz] = rightOf(dir), cols = [];
    for (let v = lo - 1; v <= hi + 1; v++) { const x = a[0] + dx * mid + rx * v, z = a[2] + dz * mid + rz * v; cols.push({ x, z, y0: (opts.floorAt ? opts.floorAt(x, z) : land.groundAt(x, z) - 4) - 1, y1: c.lowest[mid] - 1 }); }
    c.piers = [{ i: mid, cols, height: c.lowest[mid] - cols[0].y0 }];
  }
  const g = bridgeCells(c, [a[0], a[1], a[2]], dir, n, rise, width, { lampEvery, noRails: !!u.noRails, noPiers: !!u.noPiers, noLamps });
  const part = opts.part ?? 'links';
  const p = r.parts.find((q) => q.id === part) ?? r.part(part, { stage: opts.stage, set: 'path' });
  (r.meta.parts[p.id] ??= {}).kind ??= 'path';
  const slabState = `${dc.slab}[type=bottom,waterlogged=false]`;
  const railState = joinedAlong(railBlock, dir);
  const mats = [dc.block, slabState, railState, pierBlock, archBlock, fx.light];
  const M = { block: 0, slab: 1, hanger: 0, rail: 2, pier: 3, arch: 4, lamp: 5 };
  const clr = [];
  for (const [x, y, z] of g.clear) clr.push(x, z, y, y, 0);
  if (clr.length) p.columns({ abs: 0 }, { abs: 0 }, clr, [null]);
  const walkCols = [], solidCols = [];
  for (const [x, y, z, kind, walk] of g.deck) (walk && kind !== 'hanger' ? walkCols : solidCols).push(x, z, y, y, M[kind]);
  for (const [x, y, z] of g.rails) solidCols.push(x, z, y, y, M.rail);
  for (const [x, y0, y1, z] of g.piers) solidCols.push(x, z, y0, y1, M.pier);
  for (const [x, y0, y1, z] of g.body) solidCols.push(x, z, y0, y1, M.arch);
  for (const q of g.posts) solidCols.push(q.x, q.z, q.y0, q.y1, M.pier);
  for (const [x, y, z] of g.lamps) solidCols.push(x, z, y, y, M.lamp);
  p.columns({ abs: 0 }, { abs: 0 }, solidCols, mats);
  p.columns({ abs: 0 }, { abs: 0 }, walkCols, mats, { walk: true });
  const states = [];
  for (const cols of [solidCols, walkCols]) for (let t = 0; t < cols.length; t += 5) for (let y = cols[t + 2]; y <= cols[t + 3]; y++) states.push(mats[cols[t + 4]]);
  const bom = bomOf(states);
  const id = opts.id ?? `${p.id}_bridge_${(r.meta.bridges?.length ?? 0) + 1}`;
  const xs = [], ys = [], zs = [];
  for (const cols of [solidCols, walkCols]) for (let t = 0; t < cols.length; t += 5) { xs.push(cols[t]); zs.push(cols[t + 1]); ys.push(cols[t + 2], cols[t + 3]); }
  const box = { minX: Math.min(...xs), minY: Math.min(...ys), minZ: Math.min(...zs), maxX: Math.max(...xs), maxY: Math.max(...ys) + 1, maxZ: Math.max(...zs) };
  const centre = c.form === 'beam' ? c.piers.map((q) => { const m = q.cols[Math.floor(q.cols.length / 2)]; return { i: q.i, x: m.x, z: m.z, y0: m.y0, y1: m.y1, height: q.height }; }) : [];
  const rec = {
    id, kind: 'bridge', part: p.id, box, stage: p.stage, form: c.form, width, n, rise, from: [a[0], a[1], a[2]], to: [b[0], b[1], b[2]], dir, lo: g.lo, hi: g.hi,
    deck: dc.block, slab: slabState, rail: railState, pier: pierBlock, arch: archBlock, light: noLamps ? null : fx.light, lampEvery, y2: c.ys,
    clearance: opts.clearance ?? BRIDGE.clearance, over: c.over, depth: c.depth, under: c.under ?? null, springing: c.springing, intrados: c.intrados,
    cells: g.cells, piers: centre, pierCols: g.piers.map(([x, y0, y1, z, i]) => [x, y0, y1, z, i]), body: g.body.map((q) => [...q]),
    posts: g.posts.map((q) => ({ ...q })), lamps: g.lamps.map((q) => [q[0], q[1], q[2]]), bom,
    ...(opts.edge ? { edge: opts.edge } : {}), ...(opts.lands ? { lands: opts.lands } : {}), ...(opts.movers ? { movers: [...opts.movers] } : {}),
    ...(Object.keys(u).length ? { _unsafe: { ...u } } : {}),
  };
  (r.meta.bridges ??= []).push(rec);
  return rec;
}

/** The pre-region voxel class of a block state (for a land built over a virtual world's base). */
export const classOfState = (s) => voxelClassOf(String(s ?? 'minecraft:air').replace(/\[.*$/, ''));

/**
 * Write the bridge spans a route pass found (r.meta.route's edges, their `bridge` segments: near landing at the segment's first cell,
 * far landing at its last) with bridgeSpan: `{only: [edge ids] | null, stage, part = 'links', prefix = 'bridge_', style: {deck, rail,
 * pier, arch, light}, land, _unsafe}`. Each segment's form and options are its own (the row's data). Returns [{edge, ...record}].
 */
export function emitRouteBridges(r, { only = null, stage, part = 'links', prefix = 'bridge_', style = {}, land = null, _unsafe = null, lands = null } = {}) {
  const out = [];
  for (const e of r.meta.route?.edges ?? []) {
    if (!e.ok || (only && !only.includes(e.id))) continue;
    (e.segments ?? []).forEach((g, si) => {
      if (g.kind !== 'bridge') return;
      const a = e.path[g.from], b = e.path[g.to];
      const rec = bridgeSpan(r, a, b, { ...style, width: g.width ?? e.width, form: g.form, clearance: g.clearance, stage, part, land, ...(g.check ? { check: g.check } : {}), id: `${prefix}${e.id}_${si}`.slice(0, 48), movers: e.movers, edge: e.id,
        ...(lands ? { lands: lands(e, si) ?? undefined } : {}), ...(_unsafe ? { _unsafe } : {}) });
      out.push({ edge: e.id, seg: si, ...rec });
    });
  }
  return out;
}
