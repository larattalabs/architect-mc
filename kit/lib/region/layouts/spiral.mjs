// (6c FL-a, CONTRACT FL §3.2) The spiral: an open street winding out from the hub, up to 3 turns, lots on its outer side facing it;
// central and landmark lots in the hub (the first turn's inner side). Pitch = 2 x (deepest lot + setback) + the street, so a turn never
// meets the lots of the turn inside it. On a hill (the ground rising to a summit at least 8 above the land round it) the centre is the
// summit, so the street climbs to it and the landmark lots stand at the top. A turn too steep for a ground road ends the street there
// (fewer turns: lots that miss out are unplaced); a hill too steep for even the first turn answers NO_ROOM {why: grade}.
import { polarArc, frontage, groundRoadProblem, hubSpace, hubAvoid, spokes, FL_RULES, TURN } from '../frontage.mjs';
import { sidesAbout, boundsOf } from './ring.mjs';

export const MAX_TURNS = 3;
/** The rise a centre needs over the land round it to count as a hill's summit. */
export const HILL_RISE = 8;

/** The summit near c: the highest column of the zone's land within `reach` (ties: nearest c, then z, then x), and the lowest. */
export function summitNear(F, c, reach) {
  let top = null, lo = Infinity;
  for (let z = c[1] - reach; z <= c[1] + reach; z += 1) for (let x = c[0] - reach; x <= c[0] + reach; x += 1) {
    if (!F.ok(x, z)) continue;
    const g = F.S.heightAt(x, z);
    lo = Math.min(lo, g);
    const d = Math.max(Math.abs(x - c[0]), Math.abs(z - c[1]));
    if (!top || g > top.g || (g === top.g && (d < top.d || (d === top.d && (z < top.z || (z === top.z && x < top.x)))))) top = { x, z, g, d };
  }
  return top ? { at: [top.x, top.z], top: top.g, low: lo, rise: top.g - lo } : null;
}

/**
 * One spiral about c from radius r0: `{L}` or `{fail}`. The line is cut where it first leaves the land or stops being a ground road
 * (the turns it has), and again after the last lot it holds.
 */
export function spiralAt(F0, { c, r0, k0 = 0, specs, shared, pitch }) {
  const F = F0.clone();
  const rad = (k) => r0 + Math.floor((pitch * (k - k0)) / TURN);
  let cells = polarArc(c, k0, k0 + MAX_TURNS * TURN, rad);
  // cut where the street leaves the land or the ground road fails (the turns it has)
  let cut = cells.length;
  for (let i = 0; i < cells.length; i++) {
    const [x, z] = cells[i];
    let bad = false;
    for (let dz = -1; dz <= 1 && !bad; dz++) for (let dx = -1; dx <= 1; dx++) if (!F.ok(x + dx, z + dz)) { bad = true; break; }
    if (bad) { cut = i; break; }
  }
  cells = cells.slice(0, cut);
  // the grade: the longest prefix that is a ground road
  let lo = 0, hi = cells.length;
  if (groundRoadProblem(F.S, cells)) {
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (groundRoadProblem(F.S, cells.slice(0, m))) hi = m; else lo = m; }
    cells = cells.slice(0, lo);
  }
  if (cells.length < 24) return { fail: { why: cut < 24 ? 'land' : 'grade', message: cut < 24 ? `the spiral (from radius ${r0}) leaves the zone's land at once` : `the spiral (from radius ${r0}) is too steep for a ground road from its start` } };
  const full = cells;
  F.markBand(full);
  const st = { name: 'spiral', cells: full, closed: false };
  const h = hubSpace(F, c, shared.kind === 'none' ? { kind: 'none' } : shared);
  if (h.fail) return { fail: { why: 'hub', message: h.fail } };
  const avoid = hubAvoid(h);
  for (const a of avoid) F.occupy(a, 2);
  // the hub's lots on the first turn's inner side; the rest on the outer side, packed from the inner end
  const firstTurn = Math.min(full.length, Math.floor(full.length / MAX_TURNS) + 1);
  const hubSpecs = specs.filter((s) => s.placement === 'central' || s.landmark);
  const innerSides = sidesAbout(st, c, 'inner');
  const inner = hubSpecs.length ? frontage(F, st, hubSpecs, { sides: (i) => (i < firstTurn ? innerSides(i) : []), avoid, spread: false }) : { lots: [], unplaced: [] };
  for (const l of inner.lots) l.slot = 'hub';
  const rest = [...specs.filter((s) => !hubSpecs.includes(s)), ...hubSpecs.filter((s) => inner.unplaced.some((u) => u.id === s.id))].sort((a, b) => a._i - b._i);
  const outer = frontage(F, st, rest, { sides: sidesAbout(st, c, 'outer'), avoid, placed: inner.lots, spread: false, centre: c });
  for (const l of outer.lots) l.slot = 'street';
  const lots = [...inner.lots, ...outer.lots];
  // the street ends a little past its last lot (and past the hub's spokes)
  const last = Math.max(firstTurn >> 1, ...lots.map((l) => l.at));
  const end = Math.min(full.length, last + 12);
  const cellsUsed = full.slice(0, end);
  const G = F0.clone();
  G.markBand(cellsUsed);
  for (const a of avoid) G.occupy(a, 2);
  for (const l of lots) { G.occupy(l.rect, 1); for (const [x, z] of l.lane) G.occ[G.k(x, z)] = 3; }
  const st2 = { name: 'spiral', cells: cellsUsed, closed: false };
  const sp = h.sh.kind !== 'none' ? spokes(G, h, 2) : [];
  const turns = Math.round((cellsUsed.length * 100) / Math.max(1, full.length) * (full.length / Math.max(1, firstTurn))) / 100;
  return { L: { kind: 'spiral', streets: [st2], lots, unplaced: outer.unplaced, hub: h, spokes: sp, F: G, centre: c, R: r0, pitch, turns, rect: boundsOf(G, [st2], lots, h) } };
}

/**
 * The spiral's search about c (or, on a hill, its summit): the inner radius by 2 from the hub's own up; the one placing the most lots
 * (then the smaller radius). `{best, tried, fails, hill}`.
 */
export function spiralSearch(F, { c, specs, shared, rng = null, notes = [] }) {
  const deep = Math.max(...specs.filter((s) => !(s.placement === 'central' || s.landmark)).map((s) => s.size[1]), 9);
  const pitch = 2 * (deep + FL_RULES.setback) + 5;
  const reach = Math.min(96, c[0] - F.claim.minX, F.claim.maxX - c[0], c[1] - F.claim.minZ, F.claim.maxZ - c[1]);
  const sm = summitNear(F, c, Math.max(8, reach));
  const hill = sm && sm.rise >= HILL_RISE ? sm : null;
  const cc = hill ? hill.at : c;
  const k0 = rng ? rng.int(0, 7) * 32 : 0;
  let best = null;
  const fails = [];
  const hubMin = shared.kind === 'square' ? 12 : 9;
  for (let r0 = hubMin; r0 <= hubMin + 12; r0 += 2) {
    const g = spiralAt(F, { c: cc, r0, k0, specs, shared, pitch });
    if (g.fail) { fails.push({ r0, ...g.fail }); continue; }
    if (!best || g.L.unplaced.length < best.unplaced.length) best = g.L;
    if (!g.L.unplaced.length) break;
  }
  if (best && hill) { best.hill = { summit: [...hill.at], rise: hill.rise }; best.notes = [`on a hill: the spiral climbs ${hill.rise} to the summit at ${hill.at.join(',')}`]; }
  if (best) best.notes = [...(best.notes ?? []), `pitch ${pitch}, inner radius ${best.R}`];
  void notes;
  return { best, fails, hill };
}
