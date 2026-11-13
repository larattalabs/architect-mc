// (7b SL) `layout.elevated` (supported since SL; reserved until 7b, sinceApi 1.32.0): a lots zone whose lots are carried above the ground,
// each a site lot (lib/region/siteLots.mjs) on an affordance (AF) the zone's frozen volume holds: a tree's canopy or trunk (wrap_trunk), an
// overhang (suspend), a ledge or water (on_pad: a stilt or ledge pad, its design's own foundation). Resolved from the volume the plan read
// (the two-plan flow: the first plan asks for it and answers `incomplete VOLUME`), emitted as site lots, answered:
//   fits      every lot found an affordance (in plan order, best score first, each affordance once, boxes apart);
//   adjusted  some lots found none and the zone's count tolerance allows leaving them out (soft: up to its ceiling; hard: its max; the
//             deviation names them);
//   refused   NO_FEATURE: no lot found one, or more were left out than a hard count tolerance allows (wouldFit: the lots that fit).
// (7c US) A zone a `rule.suspended` scopes (`suspended`): its lots stand on overhangs only (suspend site lots on the rock ceilings) and
// each is marked `inverted` (its design is built upside down, bp.invert(): IR lot, artifact lot and record); every other zone as before.
// Joining the lots (rope bridges, branch walks, ladders to their ports) is the link pass's (LP): a connector with an end on an elevated
// zone's lot answers unsupported until LP. Deterministic: integers, the survey and the volume only.
import { analyseVolume } from '../region/affordances.mjs';
import { placeFromAffordance, rotationOf } from '../region/siteLots.mjs';
import { SITE_MARGIN } from '../siteFits.mjs';

/** The affordance kinds an elevated lot stands on, and the fit each gives. */
export const ELEVATED_FITS = Object.freeze({ canopy: 'wrap_trunk', trunk: 'wrap_trunk', overhang: 'suspend', ledge: 'on_pad', water: 'on_pad' });
/** A lot's height (the box's y size) when the plan gives none. */
export const ELEVATED_HEIGHT = 16;
/** The zone's volume: its rect, from the lowest floor less this to the highest top plus ELEVATED_ABOVE (leaves stand over the top). */
export const ELEVATED_BELOW = 8;
export const ELEVATED_ABOVE = 24;
/** The zone volume's cap (cells): past it the zone answers incomplete VOLUME. */
export const ELEVATED_MAX_CELLS = 8_000_000;
const PRESET = { S: 32, M: 48, L: 64, XL: 96 };

export function isElevatedZone(p) {
  const pr = p?.part?.program;
  return p?.family === 'zone' && !!pr && Array.isArray(pr.lots) && pr.layout === 'elevated';
}

const sameBox = (a, b) => a.minX === b.minX && a.minY === b.minY && a.minZ === b.minZ && a.maxX === b.maxX && a.maxY === b.maxY && a.maxZ === b.maxZ;
const meets2 = (a, b, g = 0) => a.minX - g <= b.maxX && b.minX - g <= a.maxX && a.minZ - g <= b.maxZ && b.minZ - g <= a.maxZ;

/** The zone's rect: a square of its preset size (M when none) centred on its locator's aim, inside the claim less 1. */
export function elevatedRect(env, part, aim) {
  const side = PRESET[part.size?.preset] ?? (Number.isInteger(part.size?.side) ? part.size.side : 48);
  const c = env.claim;
  const w = Math.min(side, c.maxX - c.minX - 1), d = Math.min(side, c.maxZ - c.minZ - 1);
  let minX = aim[0] - Math.floor((w - 1) / 2), minZ = aim[1] - Math.floor((d - 1) / 2);
  minX = Math.max(c.minX + 1, Math.min(minX, c.maxX - 1 - w + 1));
  minZ = Math.max(c.minZ + 1, Math.min(minZ, c.maxZ - 1 - d + 1));
  return { minX, minZ, maxX: minX + w - 1, maxZ: minZ + d - 1 };
}

/**
 * The zone's volume box: its rect grown by SITE_MARGIN (a lot's site volume is its box + 8, cut from this one) over the survey's floors
 * and tops there, cut to the claim.
 */
export function elevatedVolumeBox(env, rect) {
  let lo = Infinity, hi = -Infinity;
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) {
    lo = Math.min(lo, env.S.floorAt(x, z));
    hi = Math.max(hi, env.S.topAt(x, z));
  }
  const c = env.claim;
  return {
    minX: Math.max(c.minX, rect.minX - SITE_MARGIN), minY: Math.max(c.minY, lo - ELEVATED_BELOW), minZ: Math.max(c.minZ, rect.minZ - SITE_MARGIN),
    maxX: Math.min(c.maxX, rect.maxX + SITE_MARGIN), maxY: Math.min(c.maxY, hi + ELEVATED_ABOVE), maxZ: Math.min(c.maxZ, rect.maxZ + SITE_MARGIN),
  };
}

/**
 * Resolve an elevated zone (step 2). `loc` is the zone's locator (compile's locatorOf), `taken` the rects placed before it, `tol` its count
 * tolerance ({max}). Returns `{klass, rect, volBox, picks: [{spec, a, fit, max}], unplaced, reasons, deviations, notes, wouldFit}`.
 */
export function resolveElevatedZone(env, p, { loc, taken = [], tol = { max: 0 }, suspended = false }) {
  const part = p.part;
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message }] };
  const aim = Array.isArray(loc.aim) ? [loc.aim[0], loc.aim[loc.aim.length - 1]] : [Math.floor((env.claim.minX + env.claim.maxX) / 2), Math.floor((env.claim.minZ + env.claim.maxZ) / 2)];
  const rect = elevatedRect(env, part, aim);
  const volBox = elevatedVolumeBox(env, rect);
  const cells = (volBox.maxX - volBox.minX + 1) * (volBox.maxY - volBox.minY + 1) * (volBox.maxZ - volBox.minZ + 1);
  const ev = { rect: [rect.minX, rect.minZ, rect.maxX, rect.maxZ], box: [volBox.minX, volBox.minY, volBox.minZ, volBox.maxX, volBox.maxY, volBox.maxZ], cells };
  if (cells > ELEVATED_MAX_CELLS) return { klass: 'incomplete', rect, reasons: [{ code: 'VOLUME', message: `the zone's volume is ${cells} cells, past the cap (${ELEVATED_MAX_CELLS})`, evidence: { ...ev, cap: 'cells', limit: ELEVATED_MAX_CELLS } }] };
  const vol = (env.ctx.volumes ?? []).find((v) => v.decoded && sameBox(v.box, volBox))?.decoded ?? null;
  if (!vol) return { klass: 'incomplete', rect, volBox, reasons: [{ code: 'VOLUME', message: 'the land the lots stand on was not read yet (the two-plan flow reads it): prepare (or check with load: "generate"), then check again', evidence: { ...ev, missing: true } }] };
  const kinds = suspended ? ['overhang'] : Object.keys(ELEVATED_FITS);
  const affs = analyseVolume(vol, { kinds });
  const used = new Set();
  const boxes = [];
  const picks = [], unplaced = [];
  const lots = part.program.lots;
  for (const l of lots) {
    const [along, deep] = Array.isArray(l.size) && l.size.length === 2 ? l.size : [9, 9];
    const max = [along, ELEVATED_HEIGHT, deep];
    let got = null;
    for (const a of affs) {
      if (used.has(a.id)) continue;
      const rot = rotationOf(a);
      const ws = rot === 'clockwise_90' || rot === 'counterclockwise_90' ? [max[2], max[1], max[0]] : max;
      const b = placeFromAffordance(a, ws);
      // inside the zone's rect and volume (the volume holds the box + 8 where the claim allows), apart from the other lots and zones
      if (b.minX < rect.minX || b.maxX > rect.maxX || b.minZ < rect.minZ || b.maxZ > rect.maxZ) continue;
      // (its site volume, the box + 8, inside the zone's volume, so inside the claim)
      if (b.minX - SITE_MARGIN < volBox.minX || b.maxX + SITE_MARGIN > volBox.maxX || b.minZ - SITE_MARGIN < volBox.minZ || b.maxZ + SITE_MARGIN > volBox.maxZ
        || b.minY - SITE_MARGIN < volBox.minY || b.maxY + SITE_MARGIN > volBox.maxY) continue;
      if (boxes.some((q) => meets2(b, q, 1)) || taken.some((q) => meets2(b, q, 1))) continue;
      got = { spec: l, a, fit: ELEVATED_FITS[a.kind], max, box: b };
      break;
    }
    if (got) { used.add(got.a.id); boxes.push(got.box); picks.push(got); } else unplaced.push(l.id);
  }
  const notes = [`${affs.length} affordance(s) in the zone's volume (${kinds.join(', ')}); ${picks.length} of ${lots.length} lot(s) placed`];
  if (suspended) notes.push(`suspended (rule.suspended): the lots hang inverted from overhang ceilings`);
  if (!unplaced.length) return { klass: 'fits', rect, volBox, picks, unplaced, notes, ...(suspended ? { suspended } : {}) };
  const fragment = { program: { ...part.program, lots: lots.filter((l) => !unplaced.includes(l.id)) } };
  // (the count tolerance as every lots zone reads it: a soft one adjusts up to its ceiling; a hard one refuses past its max)
  if (picks.length && unplaced.length <= (tol.hard ? (tol.max ?? 0) : (tol.ceiling ?? Infinity))) {
    return { klass: 'adjusted', rect, volBox, picks, unplaced, ...(suspended ? { suspended } : {}), deviations: [{ what: 'count', value: unplaced.length, max: tol.max ?? 0, ...(unplaced.length > (tol.max ?? 0) ? { exceeds: true } : {}) }], notes: [...notes, `unplaced: ${unplaced.join(', ')} (no affordance left for ${unplaced.length === 1 ? 'it' : 'them'})`] };
  }
  return {
    klass: 'refused', rect, volBox, picks: [], unplaced, notes,
    reasons: [{ code: 'NO_FEATURE', message: suspended ? `${unplaced.length} of ${lots.length} lot(s) found no overhang ceiling to hang from in the zone (rule.suspended; the frozen volume shows ${affs.length} overhang(s))` : `${unplaced.length} of ${lots.length} lot(s) found no canopy, trunk, overhang, ledge or water to stand on in the zone (the frozen volume shows ${affs.length} affordance(s) of those kinds)`, evidence: { ...ev, affordances: affs.length, unplaced } }],
    ...(picks.length ? { wouldFit: [{ part: p.id, fragment, geometry: { rect: ev.rect } }] } : {}),
  };
}

/** Emit a resolved elevated zone (step 3): one site lot per pick. Returns the lots `{id, box, entrance, front, size}` for the geometry. */
export function emitElevatedZone(r, p, z, { stage }) {
  const out = [];
  for (const g of z.picks) {
    const l = g.spec;
    const lot = r.siteLot(l.id, { affordance: g.a, fit: g.fit, max: g.max, stage, ...(l.brief !== undefined ? { brief: l.brief } : {}), ...(l.ext !== undefined ? { ext: l.ext } : {}), ...(z.suspended ? { inverted: true } : {}) });
    if (!lot) throw new Error(`site lot ${l.id}: its volume was not read`);
    const b = lot.box;
    out.push({ id: l.id, box: [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], entrance: null, front: lot.front, size: [b.maxX - b.minX + 1, b.maxZ - b.minZ + 1], site: lot.site, affordance: lot.affordance, ...(lot.inverted ? { inverted: true } : {}) });
  }
  return out;
}
