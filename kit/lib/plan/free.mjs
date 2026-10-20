// (6c FL) The plan compiler's free layouts (docs/CONTRACT.md "Phase 6c slice FL"): a lots zone whose layout is ring, spiral, grid or
// organic, or whose where is `around`, or whose sketch is an outline, resolves here (compile.mjs dispatches it; V's street zones keep
// their own path, byte for byte). A free zone is a mask (kit/lib/region/frontage.mjs Field), its street line(s) and lots on them.
//   isFreeZone(p)                       whether a validated zone part takes this path
//   resolveFreeZone(env, p, geomOf, o)  the answer draft {klass, rect, layout (L), deviations, reasons, wouldFit, notes, free: true}
//   freeGeometry(L, e, z)               the answer's geometry (V's members plus layout, streets, hub, mask)
//   aroundSites(env, p, ...)            a form's sites round a feature (forms `around`, §4.1)
//   bodyKeepRects(keep, ids?)           KC's footprints as row rects (zones depending on a body keep clear of them, §5)
import { zoneLots } from './schema.mjs';
import { validateLots } from '../params.mjs';
import { Field, fieldRuns, cornersOf, stepOf, isqrt, TURN, FL_RULES, polarCell } from '../region/frontage.mjs';
import { ringSearch } from '../region/layouts/ring.mjs';
import { spiralSearch } from '../region/layouts/spiral.mjs';
import { gridSearch } from '../region/layouts/grid.mjs';
import { organicSearch } from '../region/layouts/organic.mjs';
import { outlineMask, polylineLayout } from '../region/layouts/outline.mjs';

export const FREE_LAYOUTS = Object.freeze(['ring', 'spiral', 'grid', 'organic']);
const UNSAFE = 'architect_mc:unsafe';
const MARGIN = 2;

const rectArr = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
const arrRect = (q) => ({ minX: q[0], minZ: q[1], maxX: q[2], maxZ: q[3] });
const centreOf = (a) => [(a.minX + a.maxX) >> 1, (a.minZ + a.maxZ) >> 1];
const meets = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
const inside = (a, b) => a.minX >= b.minX && a.maxX <= b.maxX && a.minZ >= b.minZ && a.maxZ <= b.maxZ;

/** Whether a validated zone part is a free zone: a lots program with a free layout, `where.around` or `sketch.outline`. */
export function isFreeZone(p) {
  if (p.family !== 'zone') return false;
  const pr = p.part?.program;
  if (!pr || pr.template !== undefined || pr.districts !== undefined || !Array.isArray(pr.lots)) return false;
  if (p.part.where?.along || p.kind === 'outpost') return false;
  return FREE_LAYOUTS.includes(pr.layout) || !!p.part.where?.around || p.part.sketch?.outline === true;
}

/** A free zone's lots in the layout's shape (validateLots; `_i`: the plan order). */
function specsOf(zone) {
  const lots = zoneLots(zone).map((l) => l.lot);
  return validateLots(lots.map((l) => { const { label, entry, ...rest } = l; void label; void entry; return rest; }), 'lots').map((s, i) => ({ ...s, _i: i }));
}

/** The hub's space: square (11), well (the 7x7 green) or none (nothing written: FL keeps none, §2.3). */
function sharedOf(zone) {
  const v = zone.program.shared ?? 'square';
  return v === 'well' ? { kind: 'well', size: 7 } : v === 'none' ? { kind: 'none', size: 5 } : { kind: 'square', size: 11 };
}

/** KC's registry as row rects [x0, z, x1, z] (the reserved and registered footprints' columns): `parts` only, when given. */
export function bodyKeepRects(keep, parts = null) {
  const by = new Map();
  for (const r of keep ?? []) {
    if (parts && !parts.includes(r.part)) continue;
    for (const c of r.cols.keys ? r.cols.keys() : r.cols) {
      const [x, z] = c.split(',').map(Number);
      if (!by.has(z)) by.set(z, new Set());
      by.get(z).add(x);
    }
  }
  const out = [];
  for (const z of [...by.keys()].sort((a, b) => a - b)) {
    const xs = [...by.get(z)].sort((a, b) => a - b);
    let s = xs[0], e = xs[0];
    for (let i = 1; i <= xs.length; i++) {
      if (i < xs.length && xs[i] === e + 1) { e = xs[i]; continue; }
      out.push([s, z, e, z]);
      if (i < xs.length) { s = xs[i]; e = xs[i]; }
    }
  }
  return out;
}

/** The plan parts a zone's locator names (its implicit dependencies: KC's "a zone that depends on a body"). */
export function whereParts(where) {
  if (!where || typeof where !== 'object') return [];
  const out = [];
  const lk = Object.keys(where)[0], b = where[lk] ?? {};
  if (lk === 'inside' && typeof b.part === 'string') out.push(b.part);
  if (lk === 'adjacent' && typeof b.to?.part === 'string') out.push(b.to.part);
  if ((lk === 'near' || lk === 'around' || lk === 'along') && typeof b.feature?.part === 'string') out.push(b.feature.part);
  return out;
}

/** The zone's field: the claim less its margin, the hard columns, the earlier zones and forms, every H footprint, natural water. */
function fieldOf(env, p, taken, keep) {
  const F = new Field(env.S, env.claim, MARGIN);
  for (const q of env.hard) F.cut(rectArr(q));
  for (const q of taken) F.cut(rectArr(q));
  // ((6c KC, §5) every registered H footprint is hard to a free zone; the broken variant zoneIgnoresBody leaves them in)
  if (!p.part.ext?.[UNSAFE]?.zoneIgnoresBody) for (const q of bodyKeepRects(keep)) F.cut(q);
  return F;
}

/**
 * The feature's footprint for `around` (§4.1): `{cells: [[x, z]], rect, centre, what, body?}` or `{error}`. A part: its resolved rect (an
 * H part: its registered footprint's columns); water: the picked body's columns; a build: its rect and door aprons; protected: the area.
 */
function footprintOf(env, f, geomOf, keep) {
  const rectCells = (q) => { const out = []; for (let z = q.minZ; z <= q.maxZ; z++) for (let x = q.minX; x <= q.maxX; x++) out.push([x, z]); return out; };
  if (f.part !== undefined) {
    const g = geomOf(f.part);
    if (!g) return { error: { code: 'DEPENDENCY', message: `${f.part} has no geometry` } };
    // the ring's offsets are measured from the part's resolved rect; an H part's registered footprint (its shell, coping, apron) stays
    // hard to the zone (KC: the zone, placed after the body, keeps clear of it)
    const kept = (keep ?? []).filter((r) => r.part === f.part);
    return { cells: rectCells(g.rect), rect: g.rect, centre: centreOf(g.rect), what: `part ${f.part}`, ...(kept.length ? { body: kept[0].body ?? f.part, bodyPart: f.part } : {}) };
  }
  if (f.protected !== undefined) {
    const a = env.protectedAreas.find((q) => q.id === f.protected);
    if (!a) return { error: { code: 'NO_FEATURE', message: `no protected area "${f.protected}" meets the claim` } };
    return { cells: rectCells(a.rect), rect: a.rect, centre: centreOf(a.rect), what: `protected ${a.id}` };
  }
  if (f.build !== undefined) {
    const sel = typeof f.build === 'string' ? { id: f.build } : f.build;
    const b = env.builds.find((x) => (sel.id ? x.id === sel.id : String(x.kind).toLowerCase() === String(sel.kind ?? '').toLowerCase()));
    if (!b) return { error: { code: 'NO_FEATURE', message: `no build ${sel.id ?? sel.kind} in the claim` } };
    const rect = env.buildRects.find((x) => x.id === b.id).rect;
    // the build and its door aprons (buildKeepOut's rects for it)
    const cells = rectCells({ minX: rect.minX - 1, minZ: rect.minZ - 1, maxX: rect.maxX + 1, maxZ: rect.maxZ + 1 });
    for (const e of b.entrances ?? []) {
      const s = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[e.facing];
      if (!s) continue;
      for (let t = 1; t <= 3; t++) cells.push([e.pos[0] + s[0] * t, e.pos[2] + s[1] * t]);
    }
    return { cells, rect, centre: centreOf(rect), what: `build ${b.id}` };
  }
  if (f.water !== undefined) {
    const w = f.water ?? {};
    const body = w.body ?? 'any', minArea = w.minArea ?? 1;
    const cands = env.water.bodies.filter((q) => (body === 'any' || q.kind === body) && q.area >= minArea);
    if (!cands.length) return { error: { code: 'NO_FEATURE', message: `no ${body === 'any' ? '' : `${body} `}water of at least ${minArea} columns in the claim` } };
    cands.sort((a, b) => b.area - a.area || a.bbox.minX - b.bbox.minX || a.bbox.minZ - b.bbox.minZ);
    const q = cands[0], { cols, r: rr, W } = env;
    const cells = [];
    for (const k of q.cells) { const i = k % W, j = (k - i) / W; for (let dz = 0; dz < rr; dz++) for (let dx = 0; dx < rr; dx++) cells.push([cols.minX + i * rr + dx, cols.minZ + j * rr + dz]); }
    return { cells, rect: q.bbox, centre: centreOf(q.bbox), what: `${q.kind} (${q.area} columns)` };
  }
  return { error: { code: 'NO_FEATURE', message: `feature ${Object.keys(f)[0]} is not one around can follow` } };
}

/** A footprint's polar extent about c: the farthest cell per step (+1), widened by its neighbours (the ring rounds the shape). */
function polarBase(cells, c, widen = 12) {
  const ext = new Int32Array(TURN);
  for (const [x, z] of cells) {
    const dx = x - c[0], dz = z - c[1];
    const k = stepOf(dx, dz), d = isqrt(dx * dx + dz * dz) + 1;
    if (d > ext[k]) ext[k] = d;
  }
  const out = new Array(TURN).fill(0);
  for (let k = 0; k < TURN; k++) { let m = 0; for (let t = -widen; t <= widen; t++) m = Math.max(m, ext[(k + t + TURN) % TURN]); out[k] = m; }
  return out;
}

/** The step from c toward the claim's centre (`closed: false` leaves out the arc there; south when c is the centre). */
function stepToward(env, c) {
  const cc = centreOf(env.claim);
  return cc[0] === c[0] && cc[1] === c[1] ? 64 : stepOf(cc[0] - c[0], cc[1] - c[1]);
}

/** Candidate centres about `aim`: aim first, then rings of `step` out to `reach` (Chebyshev; then z, then x). */
function centres(aim, reach, step = 8) {
  const out = [[aim[0], aim[1]]];
  for (let d = step; d <= reach; d += step) for (let dz = -d; dz <= d; dz += step) for (let dx = -d; dx <= d; dx += step) if (Math.max(Math.abs(dx), Math.abs(dz)) === d) out.push([aim[0] + dx, aim[1] + dz]);
  return out;
}

/**
 * Resolve a free zone. `o`: {taken (earlier zones' and forms' rects), keep (KC's registry), tolOf, judge, locatorOf, sketchPoint, rng}.
 * Returns the answer draft with `free: true` and `layout` (the L emitFree writes).
 */
export function resolveFreeZone(env, p, geomOf, o0) {
  const o = { ...o0, geomOf };
  const zone = p.part, program = zone.program;
  let specs;
  try { specs = specsOf(zone); } catch (e) { return { klass: 'malformed', reasons: [{ code: 'SCHEMA', path: `${p.path}.program`, message: e.message }] }; }
  if (!specs.length) return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: 'the zone lists no lots: nothing to lay out', evidence: { lots: 0 } }] };
  const shared = sharedOf(zone);
  const asked = program.layout ?? 'street';
  const around = zone.where?.around ?? null;
  const outline = zone.sketch?.outline === true ? zone.sketch : null;
  const notes = [], extraDevs = [];
  // (S-FL-2) a layout under around is read as the ring round the feature
  let layout = asked;
  if (around) {
    if (['grid', 'spiral', 'organic'].includes(asked)) extraDevs.push({ what: 'layout', asked, got: 'ring' });
    layout = 'ring';
  }
  // (S-FL-1) orientation is read by grid only; noted elsewhere, never refused
  if (program.orientation !== undefined && layout !== 'grid' && layout !== 'street') notes.push(`orientation not read by layout ${layout}`);
  const tMove = o.tolOf(zone, 'move'), tCount = o.tolOf(zone, 'count'), tSketch = o.tolOf(zone, 'sketch');
  const F = fieldOf(env, p, o.taken, o.keep);
  const rng = o.rng ?? null;
  // the outline's mask (a polygon) or line (a polyline), placed as drawn, then moved within `move`
  let draw = null;
  if (outline) {
    draw = outlineMask(env, F, outline, { anchors: env.anchors });
    if (draw.error) {
      const wf = draw.wouldFit && !o.noWouldFit ? recheck(env, p, geomOf, o, { sketch: draw.wouldFit }) : null;
      return { klass: 'refused', reasons: [draw.error], ...(wf ? { wouldFit: [wf] } : {}) };
    }
  }
  const fin = (L, c, extra = {}) => finishFree(env, p, L, { shared, layout, asked, notes, extraDevs, tMove, tCount, tSketch, o, around: extra.around ?? null, draw, mask: extra.mask ?? null, loc: extra.loc ?? null, sketchAt: extra.sketchAt ?? null, specs });

  // ---- around: the ring round the feature's footprint, offset into the band (searched by 2), lots outside facing it (§4.1)
  if (around) {
    const fp = footprintOf(env, around.feature ?? {}, geomOf, o.keep);
    if (fp.error) return { klass: fp.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: fp.error.code, message: fp.error.message, evidence: { locator: 'around', feature: around.feature } }] };
    const [r0, r1] = Array.isArray(around.ring) ? around.ring : Number.isInteger(around.ring) ? [around.ring, around.ring] : [6, 32];
    const c = fp.centre;
    // ((the broken variant zoneIgnoresBody) the ring hugs the footprint: no widening, 3 cells in, so its street and verges meet the body)
    const ignore = !!zone.ext?.[UNSAFE]?.zoneIgnoresBody;
    const base = polarBase(fp.cells, c, ignore ? 0 : 12).map((v) => (ignore ? v - 3 : v));
    // the footprint itself is no zone land (nothing is written in the hub); a body's (KC) is already cut
    if (!zone.ext?.[UNSAFE]?.zoneIgnoresBody) for (const [x, z] of fp.cells) if (F.in(x, z)) F.mask[F.k(x, z)] = 0;
    const open = around.closed === false ? stepToward(env, c) : null;
    const s = ringSearch(F, { c, specs, shared, base, hub: false, open, r0: Math.max(2, r0), r1: Math.max(r0, r1), step: 2 });
    if (!s.best) {
      // a body in the way (KC's later-part row): OVERLAP {kind: body} with the band that clears it, re-checked alone
      const bodyHit = fp.body ? s.fails.find((q) => q.why === 'land' && q.at && bodyKeepRects(o.keep, [fp.bodyPart]).some((rr) => q.at.x >= rr[0] - 1 && q.at.x <= rr[2] + 1 && q.at.z >= rr[1] - 1 && q.at.z <= rr[3] + 1)) : null;
      let clear = null;
      for (let a = r1 + 2; a <= r1 + 48 && !clear; a += 2) { const t = ringSearch(F, { c, specs, shared, base, hub: false, open, r0: a, r1: a }); if (t.best && !t.best.unplaced.length) clear = a; }
      const wfr = clear !== null && !o.noWouldFit ? recheck(env, p, geomOf, o, { where: { around: { ...around, ring: [clear, Math.max(clear, clear + (r1 - r0))] } } }) : null;
      const wf = wfr ? [wfr] : [];
      if (bodyHit || (fp.body && clear !== null && r1 < clear)) return { klass: 'refused', reasons: [{ code: 'OVERLAP', message: `the ring round ${fp.what} meets body ${fp.body}'s footprint in its band [${r0}, ${r1}]: the zone is placed after the body and keeps clear of it (KC)`, evidence: { kind: 'body', body: fp.body, part: fp.bodyPart, ring: [r0, r1], ...(clear !== null ? { clears: clear } : {}) } }], ...(wf.length ? { wouldFit: wf } : {}) };
      const why = s.fails[0];
      return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `no ring round ${fp.what} in the band [${r0}, ${r1}] fits (${why ? why.message : 'no radius tried'})`, evidence: { ring: [r0, r1], tried: s.tried } }], ...(wf.length ? { wouldFit: wf } : {}) };
    }
    return fin(s.best, c, { around: { feature: fp.what, offset: s.best.R, ring: [r0, r1], footprint: fp }, mask: around.closed === false ? 'open' : null });
  }

  // ---- the locator: a rect target (inside), or a point to centre on (near, adjacent, the claim, a sketch)
  const loc = o.locatorOf(env, zone.where, geomOf);
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message, evidence: { locator: Object.keys(zone.where ?? {})[0] ?? null } }] };
  if (zone.where?.inside && !zone.where.inside.claim && loc.areaFor) { const a = loc.areaFor(); F.keepOnly((x, z) => x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ); }
  if (draw?.mask) F.keepOnly((x, z) => draw.mask.has(`${x},${z}`));
  const sk = !outline ? o.sketchPoint(env, zone.sketch) : null;
  const aim = draw?.centre ?? sk ?? loc.aim ?? centreOf(env.claim);
  // the zone's asked size bounds its land (centred on each candidate centre)
  const sz = zone.size ? sizeOf(zone.size) : null;
  // the layouts
  const failsSeen = [];
  const search = (c) => {
    const G = sz ? F.clone() : F;
    if (sz) { const hw = sz[0] >> 1, hd = sz[1] >> 1; G.keepOnly((x, z) => x >= c[0] - hw && x < c[0] - hw + sz[0] && z >= c[1] - hd && z < c[1] - hd + sz[1]); }
    if (draw?.line) return polylineLayout(G, { line: draw.line, specs, shared });
    if (layout === 'ring' || (draw?.mask && layout === 'ring')) {
      const reach = Math.min(c[0] - env.claim.minX, env.claim.maxX - c[0], c[1] - env.claim.minZ, env.claim.maxZ - c[1]);
      return ringSearch(G, { c, specs, shared, r0: 10, r1: Math.max(10, reach - 8) }).best;
    }
    if (layout === 'spiral') { const s = spiralSearch(G, { c, specs, shared, rng, notes }); if (!s.best) failsSeen.push(...s.fails); return s.best; }
    if (layout === 'grid') return gridSearch(G, { c, specs, shared, orientation: program.orientation ?? 'auto' }).best;
    if (layout === 'organic') return organicSearch(G, { c, specs, shared, rng, zoneId: zone.id }).best;
    // a street (polygon outline): one straight street through the mask
    return polylineLayout(G, { c, specs, shared, straight: true, orientation: program.orientation ?? 'auto' });
  };
  const cand = draw ? [aim] : centres(aim, Math.min(64, Number.isFinite(tMove.ceiling) ? tMove.ceiling + 16 : 64));
  let best = null, tries = 0;
  for (const c of cand) {
    if (!F.ok(c[0], c[1]) && !draw) continue;
    if (tries++ >= 12) break;
    const L = search(c);
    if (!L) continue;
    const rect = L.rect;
    if (!loc.valid(rect)) continue;
    const move = loc.move(rect);
    const skd = sk ? Math.max(Math.abs(centreOf(rect)[0] - sk[0]), Math.abs(centreOf(rect)[1] - sk[1])) : 0;
    const cand2 = { L, move, sketch: skd };
    const better = !best || L.unplaced.length < best.L.unplaced.length || (L.unplaced.length === best.L.unplaced.length && move < best.move);
    if (better) best = cand2;
    if (!L.unplaced.length && move <= tMove.max) break;
  }
  if (!best) {
    // (§3.2) a spiral too steep for a ground road from its start: NO_ROOM {why: grade}, wouldFit the ring at the hill's foot (re-checked)
    if (layout === 'spiral' && failsSeen.some((f) => f.why === 'grade')) {
      const wf = o.noWouldFit ? null : recheck(env, p, geomOf, o, { program: { ...program, layout: 'ring' } });
      return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `the spiral is too steep for a ground road (${failsSeen.find((f) => f.why === 'grade').message})`, evidence: { why: 'grade', layout } }], ...(wf ? { wouldFit: [wf] } : {}) };
    }
    return { klass: 'refused', reasons: [{ code: 'NO_ROOM', message: `no ${layout} layout fits the zone here (water, slope, keep-out, the zones before it or the claim)`, evidence: { layout, tried: tries } }] };
  }
  return fin(best.L, null, { loc, sketchAt: sk ? { value: best.sketch } : null, move: best.move });
}

/**
 * A wouldFit re-checked alone (§3.1, §4.2): the zone with `fragment` applied resolved again (no wouldFit of its own); the fragment with
 * its geometry when it fits or is adjusted, else null.
 */
export function recheck(env, p, geomOf, o, fragment, { full = false } = {}) {
  const part = { ...p.part, ...fragment };
  const z = resolveFreeZone(env, { ...p, part }, geomOf, { ...o, noWouldFit: true });
  if (z.klass !== 'fits' && z.klass !== 'adjusted') return full ? { fail: z } : null;
  return { part: p.part.id, fragment, geometry: { rect: rectArr(z.rect) }, rechecked: z.klass };
}

/** A size {w, d} (ints or ranges, or a preset) as one [w, d] (a range's largest). */
function sizeOf(size) {
  const P = { S: 32, M: 48, L: 64, XL: 96 };
  if (size.preset) return [P[size.preset], P[size.preset]];
  const one = (v) => (Array.isArray(v) ? v[1] : v);
  return [one(size.w) ?? 64, one(size.d) ?? 64];
}

/** The answer draft for a resolved layout: deviations (move, count, sketch, layout, outline), the judge, notes, wouldFit. */
function finishFree(env, p, L, { shared, layout, asked, notes, extraDevs, tMove, tCount, tSketch, o, around, draw, loc, sketchAt, specs }) {
  const zone = p.part;
  const move = loc ? loc.move(L.rect) : 0;
  const devs = [
    { what: 'move', value: move, ...tMove },
    { what: 'count', value: L.unplaced.length, ...tCount },
    ...(sketchAt ? [{ what: 'sketch', value: sketchAt.value, ...tSketch }] : []),
    ...(draw?.deviation !== undefined ? [{ what: 'outline', value: draw.deviation, max: tSketch.max, hard: tSketch.hard, ceiling: tSketch.ceiling }] : []),
  ];
  const j = o.judge(devs);
  let klass = j.klass;
  const deviations = [...j.deviations, ...extraDevs];
  if (klass === 'fits' && extraDevs.length) klass = 'adjusted';
  const allNotes = [...notes, ...(L.notes ?? [])];
  if (around) allNotes.push(`around ${around.feature}: the ring at offset ${around.offset} (band [${around.ring.join(', ')}])`);
  const res = { klass, rect: L.rect, layout: L, specs, shared, deviations, unplaced: L.unplaced, reasons: [], notes: allNotes, free: true, layoutKind: L.kind, around, draw };
  if (klass === 'refused') {
    const f = j.failed;
    if (f.what === 'count') {
      // more lots than the land holds: NO_ROOM, wouldFit the lots that place (re-checked alone)
      res.reasons.push({ code: 'NO_ROOM', message: `${L.unplaced.length} lot(s) do not fit the ${L.kind} layout here (count ${L.unplaced.length} past its ${f.hard ? 'hard limit' : 'ceiling'})`, evidence: { what: 'count', value: L.unplaced.length, unplaced: L.unplaced.map((u) => u.id) } });
      // the lots that place, re-checked alone; a lot the re-check leaves out is dropped too (at most 3 rounds)
      let keep = zone.program.lots.filter((l) => !L.unplaced.some((u) => u.id === l.id));
      let wf = null;
      for (let round = 0; round < 3 && !o.noWouldFit && keep.length && !wf; round++) {
        const frag = { program: { ...zone.program, lots: keep } };
        const q = recheck(env, p, o.geomOf, o, frag, { full: true });
        if (!q.fail) { wf = q; break; }
        const un = q.fail.unplaced ?? [];
        if (!un.length) break;
        keep = keep.filter((l) => !un.some((u) => u.id === l.id));
      }
      res.wouldFit = wf ? [wf] : [{ part: zone.id, fragment: { program: { ...zone.program, lots: keep } }, geometry: { rect: rectArr(L.rect) } }];
    } else if (f.what === 'outline') {
      res.reasons.push({ code: 'TOLERANCE', message: `the outline is ${f.value} cells from the drawing (sketch at most ${f.ceiling})`, evidence: { what: 'outline', value: f.value } });
      if (draw?.wouldFit) { const wf = o.noWouldFit ? null : recheck(env, p, o.geomOf, o, { sketch: draw.wouldFit }); if (wf) res.wouldFit = [wf]; }
    } else res.reasons.push({ code: 'TOLERANCE', message: `${f.what} ${f.value} is past its ${f.hard ? 'hard limit' : 'ceiling'} (${f.hard ? f.max : f.ceiling})`, evidence: { what: f.what, value: f.value } });
  }
  void shared; void layout; void asked; void env; void specs;
  return res;
}

/** The answer's geometry for a free zone: V's members (rect, bell, shared, unplaced, lots) plus layout, streets, hub and (around, outline) mask. */
export function freeGeometry(z, e, lots) {
  const L = z.layout, out = e.L;
  const g = { rect: rectArr(z.rect), bell: out.res.bell, shared: out.shared?.kind ?? 'none', ...(L.kind === 'grid' ? { orientation: L.orientation } : {}), unplaced: out.unplaced.map((u) => u.id), lots, layout: L.kind,
    streets: L.streets.map((st) => ({ name: `${e.prefix}street_${st.name}`, points: cornersOf(st.cells), closed: !!st.closed })) };
  if (L.hub) g.hub = { rect: [...L.hub.sh.rect], centre: [(L.hub.sh.u0 + L.hub.sh.u1) >> 1, (L.hub.sh.v0 + L.hub.sh.v1) >> 1] };
  if (z.around || z.draw) g.mask = fieldRuns(L.F);
  return g;
}

/**
 * (§4.1) A form's sites round a feature: `count` sites in the band [r0, r1] off the footprint (+2), evenly by angle when count >= 3
 * (closed false leaves the gap), each site's foot rect clear of `taken` (+2), dry and rough at most 3. `{sites: [{rect, centre}], ...}`
 * or `{error}`. `fit(rect)`: the caller's site check (dry, level, off obstacles) -> true.
 */
export function aroundSites(env, part, geomOf, keep, { foot, count, fit }) {
  const around = part.where.around;
  const fp = footprintOf(env, around.feature ?? {}, geomOf, keep);
  if (fp.error) return { error: fp.error };
  const [r0, r1] = Array.isArray(around.ring) ? around.ring : [6, 32];
  const c = fp.centre;
  const base = polarBase(fp.cells, c);
  const half = foot >> 1;
  const fpSet = new Set(fp.cells.map(([x, z]) => `${x},${z}`));
  const clearOfFoot = (q) => { for (let z = q.minZ - 2; z <= q.maxZ + 2; z++) for (let x = q.minX - 2; x <= q.maxX + 2; x++) if (fpSet.has(`${x},${z}`)) return false; return true; };
  const at = (k, off) => { const [x, z] = polarCell(c, k, base[k] + off + half); return { minX: x - half, minZ: z - half, maxX: x - half + foot - 1, maxZ: z - half + foot - 1 }; };
  const sites = [];
  const okSite = (q) => q.minX >= env.claim.minX + MARGIN && q.maxX <= env.claim.maxX - MARGIN && q.minZ >= env.claim.minZ + MARGIN && q.maxZ <= env.claim.maxZ - MARGIN && clearOfFoot(q) && !sites.some((s) => meets({ minX: s.rect.minX - 8, minZ: s.rect.minZ - 8, maxX: s.rect.maxX + 8, maxZ: s.rect.maxZ + 8 }, q)) && fit(q);
  const gap = around.closed === false ? stepToward(env, c) : null;
  const inGap = (k) => gap !== null && (((k - gap) % TURN) + TURN) % TURN <= 21 || (gap !== null && (((gap - k) % TURN) + TURN) % TURN <= 21);
  if (count >= 3) {
    const span = gap !== null ? TURN - 43 : TURN;
    const k0 = gap !== null ? gap + 22 : 0;
    for (let n = 0; n < count; n++) {
      const kc = k0 + Math.floor(((2 * n + 1) * span) / (2 * count));
      let got = null;
      for (let dk = 0; dk <= 8 && !got; dk++) for (const k of dk ? [kc + dk, kc - dk] : [kc]) {
        if (inGap(((k % TURN) + TURN) % TURN)) continue;
        for (let off = r0; off <= r1 && !got; off += 2) { const q = at(k, off); if (okSite(q)) got = { rect: q, centre: centreOf(q), step: k, off }; }
        if (got) break;
      }
      if (got) sites.push(got);
    }
  } else {
    for (let k = 0; k < TURN && sites.length < count; k += 8) {
      if (inGap(k)) continue;
      for (let off = r0; off <= r1; off += 2) { const q = at(k, off); if (okSite(q)) { sites.push({ rect: q, centre: centreOf(q), step: k, off }); break; } }
    }
  }
  return { sites, footprint: fp, ring: [r0, r1] };
}

void arrRect; void inside; void FL_RULES;
