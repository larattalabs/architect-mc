// (6c HY) connector.channel as channel.ditch (a level irrigation ditch 1 x 1 along the sides of a lot or zone, where.along) in the plan
// compiler (docs/CONTRACT.md "Phase 6c slice HY" §7.6, §15). Slice HY-b owns this file; it must not import compile.mjs or program.mjs
// (hooks.mjs dispatches to it by channelBlock()). The signatures are course.mjs's (resolve, emit, answer).
//
// A ditch is one H body (one level, id w_<part>): along each side asked (default the box's two long sides), a row of sources 1 wide and 1
// deep outside the box, its water DITCH.gap from the box (its shell clear of the box grown by 1, M25:keep), running past the box's corners
// by the same gap so two adjacent sides meet; its ends capped by its shell. Its level is 1 under the lowest ground of its banks (sunk). It
// stands alone (fed by nothing), receives a course (to: {part: <ditch>}, a fall of at least 2 over its rim) or a branch (acceptsOverflow).
// It hydrates nothing in the lot: vanilla hydrates farmland within 4, and the box's own farmland is the lot design's (S-H-2: working farms
// are a later block); its answer says so.
import { bodiesMark, bodiesRollback, featureOf, flagsAt, fluidRolesOf, grow, inside, rectArr, reachMeetsKeep, volumeAnswer, volumeKeep, refusal, leakRefusal, MARGIN } from './place.mjs';
import { bodyAnswer, bodyId, naturalOf, shellCheck, shellStatesOf } from './pond.mjs';
import { overflowsOn } from './hooks.mjs';
import { FLAG_WATER, FLAG_LAVA } from '../region/pack.mjs';
import { VC, classAt } from '../region/volume.mjs';

export const acceptsOverflow = true;
/** The ditch: its water `gap` from the box (the shell gap - 1 clear of it), at most `cut` cells of trench past the sunk 1, length limits. */
export const DITCH = Object.freeze({ gap: 4, cut: 2, length: [3, 64] });
const SIDES = ['n', 'e', 's', 'w'];
const k2 = (x, z) => `${x},${z}`;

/** The sides of a box a ditch runs along: the asked ones, else the two long sides (n and s when the box is wider than deep). */
export function ditchSides(rect, sides, front = null) {
  if (Array.isArray(sides) && sides.length) return SIDES.filter((s) => sides.includes(s));
  const w = rect.maxX - rect.minX + 1, d = rect.maxZ - rect.minZ + 1;
  // (never across a lot's front, where its lane and entrance are)
  const f = { north: 'n', east: 'e', south: 's', west: 'w' }[front] ?? null;
  const long = (w >= d ? ['n', 's'] : ['w', 'e']).filter((s) => s !== f);
  return long;
}

/** A lot's front (north | east | south | west) from its zone's layout, or null. */
function lotFront(C, lotId) {
  const zid = C.V?.lotZone?.get?.(lotId);
  const l = zid ? C.res?.get?.(zid)?.layout?.lots?.find((q) => q.spec?.id === lotId) : null;
  return l?.lot?.front ?? l?.front ?? null;
}

/** The ditch's columns along `sides` of `rect` (its water `gap` outside), each side's run capped at the length limit. */
export function ditchColumns(rect, sides, gap = DITCH.gap) {
  const out = new Map();
  const runs = [];
  for (const s of sides) {
    const cols = [];
    if (s === 'n' || s === 's') { const z = s === 'n' ? rect.minZ - gap : rect.maxZ + gap; for (let x = rect.minX - gap; x <= rect.maxX + gap; x++) cols.push([x, z]); }
    else { const x = s === 'w' ? rect.minX - gap : rect.maxX + gap; for (let z = rect.minZ - gap; z <= rect.maxZ + gap; z++) cols.push([x, z]); }
    // (past the length limit: centred on the side)
    const L = DITCH.length[1];
    const run = cols.length > L ? cols.slice((cols.length - L) >> 1, ((cols.length - L) >> 1) + L) : cols;
    runs.push({ side: s, cols: run });
    for (const c of run) out.set(k2(...c), c);
  }
  return { cols: [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]), runs };
}

/** Place the part: the lot's or zone's box, the sides, the level; the columns clear of water, keep-out and the claim's margin. */
export function resolve(C, p) {
  const env = C.env, part = p.part;
  const notes = [];
  const al = part.where?.along ?? {};
  const f = al.feature ?? {};
  if (f.part === undefined) return { klass: 'refused', notes, reasons: [{ code: 'NO_FEATURE', message: 'a ditch runs along a lot or a zone (where.along.feature {part})', evidence: { feature: f } }] };
  const F = featureOf(env, f, C.geomOf);
  if (F.error) return { klass: F.error.code === 'DEPENDENCY' ? 'blocked' : 'refused', notes, reasons: [{ code: F.error.code === 'NO_FEATURE' ? 'NO_FEATURE' : F.error.code, message: F.error.message, evidence: F.error.evidence ?? {} }] };
  const byId = C.byId.get(f.part);
  const isLot = !byId && C.V?.lotZone?.has?.(f.part);
  if (!isLot && byId?.family !== 'zone') return { klass: 'refused', notes, reasons: [{ code: 'NO_FEATURE', message: `${f.part} is no lot or zone (a ditch runs along a lot or a zone)`, evidence: { feature: f } }] };
  const rect = F.rect;
  const sides = ditchSides(rect, al.sides, isLot ? lotFront(C, f.part) : null);
  const { cols, runs } = ditchColumns(rect, sides);
  for (const p2 of part.params ? Object.keys(part.params).sort() : []) notes.push(`params.${p2} not read (a ditch is 1 x 1, level)`);
  if (part.width !== undefined && part.width !== 1) notes.push(`width ${part.width}: a ditch is 1 wide (read as 1)`);
  if (part.depth !== undefined && part.depth !== 1) notes.push(`depth ${part.depth}: a ditch is 1 deep (read as 1)`);
  const claimIn = grow(env.claim, -MARGIN - 1);
  const S = env.S;
  const bad = { water: 0, hard: 0, claim: 0 };
  for (const [x, z] of cols) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const a = x + dx, b = z + dz;
    if (a < claimIn.minX || a > claimIn.maxX || b < claimIn.minZ || b > claimIn.maxZ) { bad.claim++; continue; }
    if (flagsAt(env, a, b) & (FLAG_WATER | FLAG_LAVA)) bad.water++;
    if (env.hard.some((h) => a >= h.minX && a <= h.maxX && b >= h.minZ && b <= h.maxZ)) bad.hard++;
  }
  if (bad.claim || bad.water || bad.hard) return { klass: 'refused', notes, reasons: [{ code: 'NO_ROOM', message: `the ditch along ${f.part}'s ${sides.join(', ')} side(s) meets ${bad.water ? 'water' : bad.hard ? 'keep-out, a protected area or a build' : 'the claim\'s margin'}`, evidence: { sides, ...bad } }] };
  let gmin = Infinity, gmax = -Infinity;
  for (const [x, z] of cols) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) gmin = Math.min(gmin, S.groundAt(x + dx, z + dz));
  for (const [x, z] of cols) gmax = Math.max(gmax, S.groundAt(x, z));
  const level = gmin - 1;
  if (gmax - 1 - level > DITCH.cut) return { klass: 'refused', notes, reasons: [{ code: 'NO_ROOM', message: `the ground along ${f.part}'s sides varies by ${gmax - gmin} (a ditch is level: it cuts at most ${DITCH.cut} under the ground)`, evidence: { kind: 'level', min: gmin, max: gmax } }] };
  const cells = cols.map(([x, z]) => [x, level, z]);
  const xs = cols.map((c) => c[0]), zs = cols.map((c) => c[1]);
  const box = { minX: Math.min(...xs) - 1, minZ: Math.min(...zs) - 1, maxX: Math.max(...xs) + 1, maxZ: Math.max(...zs) + 1 };
  notes.push(`a level ditch 1 x 1 along ${f.part}'s ${sides.join(', ')} side(s), outside its box: it hydrates nothing in the lot (working farms with hydrated farmland are a later block, S-H-2)`);
  void inside;
  return { klass: 'fits', rect: box, footprints: runs.map((r0) => { const a = r0.cols; const x0 = Math.min(...a.map((c) => c[0])), x1 = Math.max(...a.map((c) => c[0])), z0 = Math.min(...a.map((c) => c[1])), z1 = Math.max(...a.map((c) => c[1])); return [x0 - 1, z0 - 1, x1 + 1, z1 + 1]; }), notes, reasons: [], ditch: { id: bodyId(p.id), level, cells, sides, of: f.part, lot: isLot }, spec: { block: 'channel.ditch' } };
}

/** Write the part: the trench, the body (its shell in the course look's natural materials), its overflows. */
export function emit(K, p, res) {
  const r = K.r, env = K.env, S = r.ctx.survey;
  const D = res.ditch;
  const m = bodiesMark(r);
  try {
    // the lot must stand where the zone placed it (its box from the region's lots), the ditch's shell clear of it grown by 1
    const lot = D.lot ? r.lots.find((l) => l.id === D.of || l.id.endsWith(`_${D.of}`)) : null;
    if (lot) for (const [x, , z] of D.cells) if (x >= lot.box.minX - DITCH.gap + 1 && x <= lot.box.maxX + DITCH.gap - 1 && z >= lot.box.minZ - DITCH.gap + 1 && z <= lot.box.maxZ + DITCH.gap - 1) throw refusal('NO_ROOM', `the ditch at ${x} ${z} is within ${DITCH.gap - 1} of lot ${lot.id}'s box`, { lot: lot.id });
    const carve = [];
    for (const [x, y, z] of D.cells) carve.push(x, z, y, Math.max(y, S.topAt(x, z)), 0);
    const cp = r.part(`${D.id}_trench`.slice(0, 48), { stage: K.stageOf('forms') });
    cp.columns({ abs: 0 }, { abs: 0 }, carve, [null], { cond: 0 });
    (r.meta.parts[cp.id] ??= {}).kind = 'carve';
    const fr = fluidRolesOf(r.ctx);
    const xs = D.cells.map((c) => c[0]), zs = D.cells.map((c) => c[2]);
    const natural = naturalOf(r, { minX: Math.min(...xs) - 1, maxX: Math.max(...xs) + 1, minZ: Math.min(...zs) - 1, maxZ: Math.max(...zs) + 1 }, D.level - 3, D.level + 3);
    const nameOf = (b) => String(b).replace(/\[.*$/, '');
    const pick = (x, y, z, chain) => chain.find((b) => b && nameOf(b) !== natural(x, y, z)) ?? chain[chain.length - 1];
    const shellRole = (x, y, z, where) => (where === 'rim' ? pick(x, y, z, y >= S.groundAt(x, z) ? ['minecraft:moss_block', fr.rim.block, 'minecraft:coarse_dirt'] : ['minecraft:dirt', 'minecraft:clay', 'minecraft:mud']) : pick(x, y, z, ['minecraft:clay', 'minecraft:mud', 'minecraft:packed_mud']));
    const ov = overflowsOn(K, p.id);
    const rec = r.fluidBody(D.cells, { id: D.id, part: p.id, kind: 'ditch', stage: K.stageOf('forms'), level: D.level, shellRole, ...(ov.length ? { overflow: ov } : {}) });
    rec.shellStates = shellStatesOf(rec, shellRole);
    const hit = reachMeetsKeep(r, env, rec, { volClass: volumeKeep(r, VC, classAt) });
    if (hit) throw leakRefusal(rec, hit);
    shellCheck(r, rec);
    res.emitted = { bodies: [rec], notes: [] };
    (r.meta.courses ??= []).push({ id: p.id, part: p.id, kind: 'ditch', look: 'natural', flow: 'level', bodies: [rec.id], steps: [], ends: [{ end: 'from', kind: ov.length ? 'overflow' : 'spring', ref: D.of }, { end: 'to', kind: 'pool', ref: D.of }] });
  } catch (e) {
    bodiesRollback(r, m);
    if (r.meta.courses) { r.meta.courses = r.meta.courses.filter((c) => c.part !== p.id); if (!r.meta.courses.length) delete r.meta.courses; }
    throw e;
  }
}

/** The part's answer fields. */
export function answer(K, p, res) {
  const e = res.emitted;
  if (!e) return null;
  const vol = volumeAnswer(K.r, e.bodies);
  if (vol) return vol;
  return bodyAnswer(K, p, e.bodies, { rect: res.rect, notes: [...(res.notes ?? []), ...e.notes], extra: { block: 'channel.ditch', along: res.ditch.of, sides: res.ditch.sides, width: 1, depth: 1, length: res.ditch.cells.length } });
}

void rectArr; void k2;
