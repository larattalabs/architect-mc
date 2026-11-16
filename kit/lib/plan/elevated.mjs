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
import { VC } from '../region/volume.mjs';
import { stateClass } from '../region/sculpt.mjs';
// (slice CAVE) an elevated zone whose locator is a cave (`near: {feature: {cave}}`): its lots carved into the cave's walls (cave.mjs)
import { caveSpecOf, resolveCaveZone } from './cave.mjs';

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

/**
 * (slice R2, forms as land) The form part an elevated zone stands on: its locator `inside: {part}` or `near: {feature: {part}}` naming a
 * form part of the plan. Such a zone's lots are found on the land as it stands after that form (and every op before it) is written, not on
 * the frozen survey's: an island's underside (suspend), a giant tree's trunk or canopy (wrap_trunk), a ledge or pad on a raised form
 * (on_pad). Null for every other zone (resolved as before, byte for byte).
 */
export function formHostOf(p, byId) {
  const w = p?.part?.where;
  const id = w?.inside?.part ?? w?.near?.feature?.part ?? null;
  if (typeof id !== 'string') return null;
  const q = byId?.get(id);
  return q && q.family === 'form' ? { id, kind: q.kind } : null;
}
/** How far over the survey's highest top a form-hosted zone's volume reaches (an island stands up to 96 over the land, a tree's crown). */
export const FORM_ABOVE = 120;

/**
 * (slice R2) The land after the forms: the frozen volume `vol` (decoded) with every cell the plan's draft virtual world `lw` (fluids/body.mjs
 * localWorld: every op so far over the survey and the volumes) has written classed by its block (sculpt.mjs stateClass, the game's
 * survey classes as the kit models them: a written log is LOG, not OWNED, as the live world reads it after the realise; the drift check
 * leaves the region's own cells out). Returns a decoded-volume-shaped object (box, sizes, classes, owners) and the count of cells changed.
 */
export function landAfterForms(vol, lw) {
  const b = vol.box, W = vol.width, H = vol.height, D = vol.depth;
  const classes = new Uint8Array(vol.classes);
  const P = lw.vw.pal;
  let changed = 0;
  const memo = new Map();
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) for (let y = 0; y < H; y++) {
    const wx = b.minX + x, wy = b.minY + y, wz = b.minZ + z;
    if (!(lw.vw.flags(wx, wy, wz) & 1)) continue; // (F_WRITTEN)
    const idx = lw.vw.get(wx, wy, wz);
    let c = memo.get(idx);
    if (c === undefined) { c = VC[stateClass(P.states[idx])]; memo.set(idx, c); }
    const i = (x * D + z) * H + y;
    if (classes[i] !== c) { classes[i] = c; changed++; }
  }
  return { land: { box: { ...b }, width: W, height: H, depth: D, classes, owners: vol.owners, ownerOf: vol.ownerOf }, changed };
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
export function elevatedVolumeBox(env, rect, { above = ELEVATED_ABOVE } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (let z = rect.minZ; z <= rect.maxZ; z++) for (let x = rect.minX; x <= rect.maxX; x++) {
    lo = Math.min(lo, env.S.floorAt(x, z));
    hi = Math.max(hi, env.S.topAt(x, z));
  }
  const c = env.claim;
  return {
    minX: Math.max(c.minX, rect.minX - SITE_MARGIN), minY: Math.max(c.minY, lo - ELEVATED_BELOW), minZ: Math.max(c.minZ, rect.minZ - SITE_MARGIN),
    maxX: Math.min(c.maxX, rect.maxX + SITE_MARGIN), maxY: Math.min(c.maxY, hi + above), maxZ: Math.min(c.maxZ, rect.maxZ + SITE_MARGIN),
  };
}

/**
 * Resolve an elevated zone (step 2). `loc` is the zone's locator (compile's locatorOf), `taken` the rects placed before it, `tol` its count
 * tolerance ({max}). Returns `{klass, rect, volBox, picks: [{spec, a, fit, max}], unplaced, reasons, deviations, notes, wouldFit}`.
 */
export function resolveElevatedZone(env, p, { loc, taken = [], tol = { max: 0 }, suspended = false, host = null, land = null, rect: given = null }) {
  const part = p.part;
  if (caveSpecOf(part)) {
    if (suspended) return { klass: 'refused', reasons: [{ code: 'NO_FEATURE', message: 'a zone carved into a cave has no overhang ceilings to hang from (rule.suspended)' }] };
    return resolveCaveZone(env, p, { taken, tol, sizedRect: part.size ? (aim) => elevatedRect(env, part, aim) : null });
  }
  if (loc.error) return { klass: loc.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', reasons: [{ code: loc.error.code, message: loc.error.message }] };
  const aim = Array.isArray(loc.aim) ? [loc.aim[0], loc.aim[loc.aim.length - 1]] : [Math.floor((env.claim.minX + env.claim.maxX) / 2), Math.floor((env.claim.minZ + env.claim.maxZ) / 2)];
  const rect = given ?? elevatedRect(env, part, aim);
  // ((R2) a form-hosted zone: its volume reaches FORM_ABOVE over the land, for the form's own height)
  const volBox = elevatedVolumeBox(env, rect, host ? { above: FORM_ABOVE } : {});
  const cells = (volBox.maxX - volBox.minX + 1) * (volBox.maxY - volBox.minY + 1) * (volBox.maxZ - volBox.minZ + 1);
  const ev = { rect: [rect.minX, rect.minZ, rect.maxX, rect.maxZ], box: [volBox.minX, volBox.minY, volBox.minZ, volBox.maxX, volBox.maxY, volBox.maxZ], cells };
  if (cells > ELEVATED_MAX_CELLS) return { klass: 'incomplete', rect, reasons: [{ code: 'VOLUME', message: `the zone's volume is ${cells} cells, past the cap (${ELEVATED_MAX_CELLS})`, evidence: { ...ev, cap: 'cells', limit: ELEVATED_MAX_CELLS } }] };
  const vol = (env.ctx.volumes ?? []).find((v) => v.decoded && sameBox(v.box, volBox))?.decoded ?? null;
  if (!vol) return { klass: 'incomplete', rect, volBox, reasons: [{ code: 'VOLUME', message: 'the land the lots stand on was not read yet (the two-plan flow reads it): prepare (or check with load: "generate"), then check again', evidence: { ...ev, missing: true } }] };
  // ((R2) a form-hosted zone resolves twice: at step 2 provisionally (the form not yet written: `deferred`), then after the forms emit
  // over `land`, the frozen volume with the plan's writes so far (landAfterForms))
  if (host && !land) return { klass: 'fits', rect, volBox, picks: [], unplaced: [], deferred: true, host, notes: [`on ${host.kind} ${host.id}: the lots are found on the land after the forms`] };
  const kinds = suspended ? ['overhang'] : Object.keys(ELEVATED_FITS);
  const affs = analyseVolume(land ?? vol, { kinds });
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
  if (host) notes.push(`on ${host.kind} ${host.id}: the lots stand on the land after the forms`);
  if (suspended) notes.push(`suspended (rule.suspended): the lots hang inverted from overhang ceilings`);
  const hl = host ? { host, land } : {};
  if (!unplaced.length) return { klass: 'fits', rect, volBox, picks, unplaced, notes, ...(suspended ? { suspended } : {}), ...hl };
  const fragment = { program: { ...part.program, lots: lots.filter((l) => !unplaced.includes(l.id)) } };
  // (the count tolerance as every lots zone reads it: a soft one adjusts up to its ceiling; a hard one refuses past its max)
  if (picks.length && unplaced.length <= (tol.hard ? (tol.max ?? 0) : (tol.ceiling ?? Infinity))) {
    return { klass: 'adjusted', rect, volBox, picks, unplaced, ...(suspended ? { suspended } : {}), ...hl, deviations: [{ what: 'count', value: unplaced.length, max: tol.max ?? 0, ...(unplaced.length > (tol.max ?? 0) ? { exceeds: true } : {}) }], notes: [...notes, `unplaced: ${unplaced.join(', ')} (no affordance left for ${unplaced.length === 1 ? 'it' : 'them'})`] };
  }
  return {
    klass: 'refused', rect, volBox, picks: [], unplaced, notes,
    reasons: [{ code: 'NO_FEATURE', message: suspended ? `${unplaced.length} of ${lots.length} lot(s) found no overhang ceiling to hang from in the zone (rule.suspended; the ${land ? 'land after the forms' : 'frozen volume'} shows ${affs.length} overhang(s))` : `${unplaced.length} of ${lots.length} lot(s) found no canopy, trunk, overhang, ledge or water to stand on in the zone (the ${land ? 'land after the forms' : 'frozen volume'} shows ${affs.length} affordance(s) of those kinds)`, evidence: { ...ev, affordances: affs.length, unplaced } }],
    ...(picks.length ? { wouldFit: [{ part: p.id, fragment, geometry: { rect: ev.rect } }] } : {}),
  };
}

/** Emit a resolved elevated zone (step 3): one site lot per pick. Returns the lots `{id, box, entrance, front, size}` for the geometry. */
export function emitElevatedZone(r, p, z, { stage }) {
  const out = [];
  for (const g of z.picks) {
    const l = g.spec;
    // ((slice CAVE) a carved lot: its box and rotation as placed against the cave's wall, no affordance (its frame faces the wall, not the mouth))
    const lot = r.siteLot(l.id, { ...(z.land ? { land: z.land } : {}), ...(z.hostPart ? { host: z.hostPart } : {}), ...(z.carved ? { box: g.box, rotation: g.rotation } : { affordance: g.a, max: g.max }), fit: g.fit, stage, ...(l.brief !== undefined ? { brief: l.brief } : {}), ...(l.ext !== undefined ? { ext: l.ext } : {}), ...(z.suspended ? { inverted: true } : {}) });
    if (!lot) throw new Error(`site lot ${l.id}: its volume was not read`);
    const b = lot.box;
    out.push({ id: l.id, box: [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ], entrance: null, front: lot.front, size: [b.maxX - b.minX + 1, b.maxZ - b.minZ + 1], site: lot.site, affordance: lot.affordance, ...(lot.inverted ? { inverted: true } : {}) });
  }
  return out;
}
