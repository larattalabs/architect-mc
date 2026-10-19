// (6c H-b) form.quay in the plan compiler (docs/CONTRACT.md "Phase 6c slice H" §8.3, §10, §12; N-H-2: quays in `path` with lamps).
// Slice H-b owns this file; it must not import compile.mjs or program.mjs (kit/lib/fluids/hooks.mjs dispatches to it by kind).
//   resolve(C, p) -> res          compile step 2 (with the forms): the quay's place. A level deck from a straight bank out over natural
//                                 water: `length` (4..48, default 12) cells along the bank, `reach` (1..6, default 3) cells out, every
//                                 deck column a natural water column (a source to its bed, at most 8 deep: wetColumn; the frozen
//                                 volume's fluid layer where the caller holds one) at one surface level, the bank row dry land within
//                                 one step of the deck (its ground 0..2 over the surface), clear of keep-out, the claim's margin and
//                                 the zones and forms placed before it. The candidate nearest the locator's aim wins (ties by x, z,
//                                 heading); a shorter quay (down to 4), then a shorter reach, answers adjusted. No natural water within
//                                 the locator: NO_FEATURE; no bank: NO_ROOM.
//   emit(K, p, res)               compile step 3: the deck (1 over the water's surface, solid to a footing 2 into the bed, no
//                                 overhang), its walk surface in `path` (the bible's fluids.quay, then path, then structure; under the
//                                 surface a full, non-waterloggable, non-gravity block), mooring posts (the frame role's fence) every 4
//                                 along the water's edge, lamps (W's fixture) every floor(12 * level / 15) on the posts, a 1-cell step
//                                 down to the water every 16 (the exits), and a rail along an edge over water under 2 deep (M8: deeper
//                                 water is the guard). The water under the deck is read from the frozen volume (asked: the first plan
//                                 answers incomplete VOLUME, nothing written); recorded (meta.wet kind quay, meta.quays) and guarded.
//   answer(K, p, res) -> extra    compile step 6: geometry {rect, quays: [{along, length, reach, wetCells, steps, posts, lamps}]},
//                                 or the incomplete VOLUME answer.
import { WET, askWet, fluidVolumes, noteWet, underwaterBlock, underwaterOk, wetColumn, wetRuns } from './wet.mjs';
import { fixtureCells, fixtureFor } from '../region/fixtures.mjs';
import { shapeOf } from '../connectors/style.mjs';
import { bomOf } from '../connectors/bom.mjs';

/** §8.3's numbers. */
export const QUAY = Object.freeze({ length: 12, lengthMin: 4, lengthMax: 48, reach: 3, reachMin: 1, reachMax: 6, waterDepth: WET.quayDepth, postEvery: 4, stepEvery: 16, railUnder: 2, near: 16, margin: 2 });
const H4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const FLAG_WATER = 1, FLAG_TREE = 4, FLAG_LAVA = 8, FLAG_MISSING = 2;
const isInt = Number.isInteger;
const ALWAYS_OURS = 3, IF_AIR_OR_FLUID = 2; // (program.mjs COND: this module may not import it)

/** A quay's params, read leniently (R21): length and reach where no first-class member says otherwise; every other key noted. */
export function readQuayParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'length' && part.length === undefined && isInt(v) && v >= QUAY.lengthMin && v <= QUAY.lengthMax) { read.length = v; continue; }
    if (key === 'reach' && part.reach === undefined && isInt(v) && v >= QUAY.reachMin && v <= QUAY.reachMax) { read.reach = v; continue; }
    if ((key === 'lamps' || key === 'torches') && (v === true || v === 'every')) { read.lamps = true; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : ''}`);
  }
  return { read, notes };
}

/** The survey's column facts at a world cell (null outside the survey). */
function colOf(env, x, z) {
  const c = env.cols, r = c.resolution;
  const i = Math.floor((x - c.minX) / r), j = Math.floor((z - c.minZ) / r);
  if (i < 0 || j < 0 || i >= c.width || j >= c.depth) return null;
  const k = i + j * c.width;
  return { k, ground: c.ground[k], floor: c.floor[k], flags: c.flags[k] };
}

/** The water bodies the locator names, and the aim the candidates are measured from: {bodies, aim} or {error}. */
function waterOf(C, part) {
  const env = C.env, all = env.water?.bodies ?? [];
  const where = part.where ?? {};
  const cc = [(env.claim.minX + env.claim.maxX) >> 1, (env.claim.minZ + env.claim.maxZ) >> 1];
  const nearest = (b, p) => {
    let best = null;
    const { cols } = env, W = cols.width, r = cols.resolution;
    for (const k of b.cells) {
      const i = k % W, j = (k - i) / W, x = cols.minX + i * r, z = cols.minZ + j * r;
      const d = Math.max(Math.abs(x - p[0]), Math.abs(z - p[1]));
      if (!best || d < best.d) best = { x, z, d };
    }
    return best;
  };
  const pick = (w, from) => {
    const body = w.body ?? 'any', minArea = w.minArea ?? 1;
    const cands = all.filter((b) => (body === 'any' || b.kind === body) && b.area >= minArea);
    if (!cands.length) return { error: { code: 'NO_FEATURE', message: `no ${body === 'any' ? '' : `${body} `}natural water of at least ${minArea} columns in the claim for a quay`, evidence: { feature: { water: w }, bodies: all.map((b) => ({ kind: b.kind, area: b.area })) } } };
    const key = (b) => (w.pick === 'nearest' ? [nearest(b, from).d, 0] : [-b.area, nearest(b, cc).d]);
    cands.sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || a.bbox.minX - b.bbox.minX || a.bbox.minZ - b.bbox.minZ; });
    return { bodies: [cands[0]] };
  };
  const anchorAt = (name) => (name ? env.anchors.get(name) ?? null : null);
  if (where.along) {
    const f = where.along.feature ?? {};
    if (f.water === undefined) return { error: { code: 'NO_FEATURE', message: 'a quay runs along water (where.along.feature.water)', evidence: { feature: f } } };
    const from = anchorAt(where.along.anchor) ?? anchorAt(f.water?.to) ?? cc;
    const p = pick(f.water ?? {}, from);
    if (p.error) return p;
    const n = nearest(p.bodies[0], from);
    return { bodies: p.bodies, aim: [n.x, n.z] };
  }
  if (where.near) {
    const nr = where.near, within = isInt(nr.within) ? nr.within : QUAY.near;
    const a = anchorAt(nr.anchor);
    if (nr.anchor && !a) return { error: { code: 'ANCHOR', message: `anchor ${nr.anchor} is not given`, evidence: { anchor: nr.anchor } } };
    if (nr.feature && nr.feature.water === undefined) return { error: { code: 'NO_FEATURE', message: 'a quay stands near water: where.near names an anchor, or feature.water', evidence: { feature: nr.feature } } };
    const from = a ?? cc;
    let bodies;
    if (nr.feature?.water !== undefined) { const p = pick(nr.feature.water, from); if (p.error) return p; bodies = p.bodies; }
    else bodies = all.filter((b) => nearest(b, from).d <= within);
    // (within the locator: the water's nearest column within `within` of the anchor)
    bodies = bodies.filter((b) => !a || nearest(b, a).d <= within);
    if (!bodies.length) return { error: { code: 'NO_FEATURE', message: `no natural water within ${within} of ${nr.anchor ? `anchor ${nr.anchor}` : 'the claim\'s centre'} for a quay`, evidence: { within, bodies: all.length } } };
    const n = bodies.map((b) => nearest(b, from)).sort((p, q) => p.d - q.d || p.x - q.x || p.z - q.z)[0];
    return { bodies, aim: [n.x, n.z] };
  }
  const p = pick({}, cc);
  if (p.error) return p;
  const n = nearest(p.bodies[0], cc);
  return { bodies: p.bodies, aim: [n.x, n.z] };
}

/** Whether a rect [x0, z0, x1, z1] meets any of `rects` ({minX, minZ, maxX, maxZ}) grown by `g`. */
const meets = (a, rects, g = 0) => rects.some((q) => a[0] <= q.maxX + g && a[2] >= q.minX - g && a[1] <= q.maxZ + g && a[3] >= q.minZ - g);

/**
 * The candidates for one length and reach: every straight bank of `len` cells whose `reach` rows out are natural water of the chosen
 * bodies at one surface. Returns the best (nearest the aim) or null, and the whys seen.
 */
function findQuay(C, bodies, aim, len, reach, vols, whys) {
  const env = C.env, c = env.claim, cols = env.cols, W = cols.width, r = cols.resolution;
  const inBody = new Set();
  const lab = new Map();
  for (const b of bodies) for (const k of b.cells) { inBody.add(k); lab.set(k, b.id); }
  const taken = [...(C.taken ?? []), ...(env.hard ?? [])];
  const okXZ = (x, z) => x >= c.minX + QUAY.margin && x <= c.maxX - QUAY.margin && z >= c.minZ + QUAY.margin && z <= c.maxZ - QUAY.margin;
  let best = null;
  const seen = new Set();
  for (const b of bodies) for (const k0 of b.cells) {
    const i0 = k0 % W, j0 = (k0 - i0) / W, wx = cols.minX + i0 * r, wz = cols.minZ + j0 * r;
    for (let h = 0; h < 4; h++) {
      // the first deck row's cell at (wx, wz), the bank one cell back against `out`; the run along `along` starts at every offset
      // that keeps (wx, wz) inside it
      const [ox, oz] = H4[h], [ax, az] = H4[(h + 1) & 3];
      const bx = wx - ox, bz = wz - oz;
      const bc = colOf(env, bx, bz);
      if (!bc || (bc.flags & (FLAG_WATER | FLAG_LAVA))) continue;
      for (let s0 = -(len - 1); s0 <= 0; s0++) {
        const sx = bx + ax * s0, sz = bz + az * s0;
        const id = `${sx},${sz},${h}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const cand = check(sx, sz, h);
        if (!cand) continue;
        const mid = [sx + ax * (len >> 1), sz + az * (len >> 1)];
        const d = Math.max(Math.abs(mid[0] - aim[0]), Math.abs(mid[1] - aim[1]));
        const keyv = [d, sx, sz, h];
        if (!best || cmp(keyv, best.key) < 0) best = { ...cand, key: keyv };
      }
    }
  }
  return best;

  function check(sx, sz, h) {
    const [ox, oz] = H4[h], [ax, az] = H4[(h + 1) & 3];
    let surface = null;
    const bank = [], deck = [];
    for (let u = 0; u < len; u++) {
      const x = sx + ax * u, z = sz + az * u, q = colOf(env, x, z);
      if (!q || !okXZ(x, z) || (q.flags & (FLAG_WATER | FLAG_LAVA | FLAG_MISSING | FLAG_TREE))) return null;
      bank.push([x, z, q.ground]);
      for (let t = 1; t <= reach; t++) {
        const dx = x + ox * t, dz = z + oz * t, w = colOf(env, dx, dz);
        if (!w || !okXZ(dx, dz) || !inBody.has(w.k) || (w.flags & (FLAG_LAVA | FLAG_MISSING))) return null;
        if (surface === null) surface = w.ground;
        if (w.ground !== surface) { whys.add('level'); return null; }
        const col = wetColumn(vols, dx, dz, w.ground, w.floor, { waterDepth: QUAY.waterDepth });
        if (!col.ok) { whys.add(col.why); return null; }
        deck.push({ x: dx, z: dz, u, t, bed: col.bed, surface: w.ground, depth: col.depth });
      }
    }
    // the bank within one step of the deck's walk surface (its top block at surface + 1)
    if (bank.some(([, , g]) => g < surface || g > surface + 2)) { whys.add('bank'); return null; }
    const xs = [...bank, ...deck.map((q) => [q.x, q.z])].map((q) => q[0]), zs = [...bank, ...deck.map((q) => [q.x, q.z])].map((q) => q[1]);
    const rect = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    if (meets(rect, taken, 1)) { whys.add('taken'); return null; }
    return { sx, sz, h, len, reach, surface, bank, deck, rect };
  }
}
const cmp = (a, b) => { for (let t = 0; t < a.length; t++) if (a[t] !== b[t]) return a[t] - b[t]; return 0; };

/** Place the quay (compile step 2). */
export function resolve(C, p) {
  const part = p.part;
  const pr = readQuayParams(part);
  const notes = [...pr.notes];
  const len0 = part.length ?? pr.read.length ?? QUAY.length, reach0 = part.reach ?? pr.read.reach ?? QUAY.reach;
  const w = waterOf(C, part);
  if (w.error) return { klass: 'refused', reasons: [w.error], notes };
  const vols = fluidVolumes(C.ctx?.volumes);
  const whys = new Set();
  // the asked length and reach, then shorter quays (to 4), then a shorter reach (to 1): adjusted
  let got = null;
  for (let reach = reach0; reach >= QUAY.reachMin && !got; reach--) for (let len = len0; len >= QUAY.lengthMin && !got; len--) got = findQuay(C, w.bodies, w.aim, len, reach, vols, whys);
  if (!got && whys.has('unread') && !whys.has('flowing') && !whys.has('lava')) return { klass: 'incomplete', notes, reasons: [{ code: 'VOLUME', message: 'the water a quay would stand in was not read: prepare (or check with load: "generate"), then check again', evidence: { seen: [...whys].sort() } }] };
  if (!got) {
    const flowing = whys.has('flowing') || whys.has('lava');
    const code = flowing || (whys.has('deep') && !whys.has('bank') && !whys.has('taken')) ? 'WATER' : 'NO_ROOM';
    const kind = whys.has('lava') ? 'lava' : whys.has('flowing') ? 'flowing' : 'deep';
    return { klass: 'refused', notes, reasons: [{ code, message: code === 'WATER' ? `no bank where ${QUAY.lengthMin} or more cells of still natural water up to ${QUAY.waterDepth} deep lie ${QUAY.reachMin} or more out (${kind})` : `no straight bank of ${QUAY.lengthMin} or more cells beside the water, within a step of a deck 1 over the surface, clear of the parts placed before it`, evidence: { ...(code === 'WATER' ? { kind } : {}), seen: [...whys].sort(), length: len0, reach: reach0 } }] };
  }
  const deviations = [];
  if (got.len !== len0) deviations.push({ what: 'length', value: got.len, asked: len0 });
  if (got.reach !== reach0) deviations.push({ what: 'reach', value: got.reach, asked: reach0 });
  if (deviations.length) notes.push(`the nearest bank with room holds a quay ${got.len} long, ${got.reach} out (asked ${len0} by ${reach0})`);
  const rect = { minX: got.rect[0], minZ: got.rect[1], maxX: got.rect[2], maxZ: got.rect[3] };
  return { klass: deviations.length ? 'adjusted' : 'fits', rect, footprints: [got.rect], deviations, notes, quay: got };
}

/** Write the quay (compile step 3). */
export function emit(K, p, res) {
  const q = res.quay, r = K.r;
  if (!q) return;
  const [ox, oz] = H4[q.h], [ax, az] = H4[(q.h + 1) & 3];
  const s = q.surface;
  // the frozen volume over the deck's water: re-read first from the caller's volumes (before asking, so a refusal leaves no volume
  // read under the part's checkpoint), then asked
  const cols = q.deck.map((d) => [d.x, d.z, d.bed, d.surface]);
  const vols = fluidVolumes(K.ctx.volumes);
  for (const d of q.deck) { const w = wetColumn(vols, d.x, d.z, d.surface, d.bed, { waterDepth: QUAY.waterDepth }); if (!w.ok) throw new Error(`WATER: the quay's column at ${d.x},${d.z} stands in ${w.why === 'deep' ? `water ${w.depth} deep` : w.why} (the frozen volume)`); }
  const asked = askWet(r, cols);
  const rec = noteWet(r, { id: `${p.id}_wet`.slice(0, 48), part: p.id, kind: 'quay', columns: wetRuns(cols), volume: asked.ref });
  if (!asked.volume) { res.pending = { box: asked.box, columns: cols.length }; return; }
  // the bed under each column from the volume (wetColumn with it)
  for (const d of q.deck) { const w = wetColumn([asked.volume], d.x, d.z, d.surface, d.bed, { waterDepth: QUAY.waterDepth }); if (w.ok && w.bed !== d.bed) d.bed = w.bed; }
  const roles = K.ctx.roles ?? {};
  const role = (name) => (Object.prototype.hasOwnProperty.call(r.roles, name) ? r.material(name, `quay ${p.id}`) : null);
  const fl = K.ctx.fluids ?? {};
  const top = [fl.quay && role(fl.quay), role('path'), role('structure'), 'minecraft:stone_bricks'].find((b) => typeof b === 'string');
  const under = underwaterOk(top) ? top : underwaterBlock([role('structure'), role('foundation'), 'minecraft:stone_bricks']);
  const frame = (fl.mooring && role(fl.mooring)) ?? role('frame') ?? roles.frame ?? 'minecraft:oak_planks';
  const fence = shapeOf(frame, 'fence') ?? (/_fence$/.test(String(frame)) ? frame : null) ?? 'minecraft:oak_fence';
  const railRole = role('rail');
  const rail = (railRole && (/_(fence|wall)$/.test(railRole.replace(/\[.*$/, '')) ? railRole.replace(/\[.*$/, '') : shapeOf(railRole, 'fence') ?? shapeOf(railRole, 'wall'))) ?? fence;
  const fx = fixtureFor(role('light') ?? 'minecraft:lantern', fence);
  const lampEvery = Math.max(QUAY.postEvery, Math.floor((12 * fx.level) / 15));
  const S = K.env.S;
  // the steps (exits): every 16 along the water's edge, evenly, at least one
  const nSteps = Math.max(1, Math.floor((q.len + QUAY.stepEvery - 1) / QUAY.stepEvery));
  const steps = new Set();
  for (let j = 0; j < nSteps; j++) steps.add(Math.min(q.len - 1, Math.floor(((2 * j + 1) * q.len) / (2 * nSteps))));
  const ops = new Map(); // "x,y,z" -> state | null
  const walk = new Map(); // "x,y,z" -> state (walk cells)
  const put = (x, y, z, st) => ops.set(`${x},${y},${z}`, st);
  let wetCells = 0;
  for (const d of q.deck) {
    const step = d.t === q.reach && steps.has(d.u);
    const yTop = step ? s : s + 1;
    for (let y = d.bed - 1; y < yTop; y++) put(d.x, y, d.z, under);
    walk.set(`${d.x},${yTop},${d.z}`, step ? under : top);
    wetCells += s - d.bed;
  }
  // the edges over water: the outer row's outside, the two ends' outsides; a rail where that water is under 2 deep, else open (the
  // water is the guard, M8), mooring posts every 4 on the outer edge (lamps every lampEvery), never on a step
  const posts = [], lamps = [], rails = [];
  const shallowAt = (x, z) => { const c = colOf(K.env, x, z); return !c || !(c.flags & FLAG_WATER) || c.ground - c.floor < QUAY.railUnder; };
  for (const d of q.deck) {
    if (d.t === q.reach && steps.has(d.u)) continue;
    const outer = d.t === q.reach, end0 = d.u === 0, end1 = d.u === q.len - 1;
    const sides = [];
    if (outer) sides.push([d.x + ox, d.z + oz]);
    if (end0) sides.push([d.x - ax, d.z - az]);
    if (end1) sides.push([d.x + ax, d.z + az]);
    const shallow = sides.some(([x, z]) => { const c = colOf(K.env, x, z); return c && (c.flags & FLAG_WATER) && shallowAt(x, z); });
    if (outer && d.u % QUAY.postEvery === 0) {
      if (d.u % lampEvery === 0) { for (const c of fixtureCells(fx, [d.x, s + 2, d.z]).cells) lamps.push(c); }
      else posts.push([d.x, s + 2, d.z, fenceState(fence)]);
      // (a post's cell is no walk: its deck block is a plain solid)
      const k = `${d.x},${s + 1},${d.z}`;
      ops.set(k, walk.get(k));
      walk.delete(k);
      continue;
    }
    if (shallow) {
      rails.push([d.x, s + 2, d.z, fenceState(rail)]);
      // (a rail's cell is no walk either)
      const k = `${d.x},${s + 1},${d.z}`;
      ops.set(k, walk.get(k));
      walk.delete(k);
    }
  }
  // the region part: the forms stage, absolute y; the deck's walk surface a walk (the route pass may end on it)
  const pid = `q_${p.id}`.slice(0, 48);
  const part = r.part(pid, { stage: K.stageOf('forms') });
  (r.meta.parts[part.id] ??= {}).kind = 'add';
  const colsOf = (entries) => {
    const out = [], mats = [], mi = new Map();
    const sorted = [...entries].map(([k, st]) => { const [x, y, z] = k.split(',').map(Number); return [x, y, z, st]; }).sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
    for (const [x, y, z, st] of sorted) { let i = mi.get(st); if (i === undefined) { i = mats.length; mats.push(st); mi.set(st, i); } out.push(x, z, y, y, i); }
    return { out, mats };
  };
  const solid = colsOf(ops), walkC = colsOf(walk);
  if (solid.out.length) part.columns({ abs: 0 }, { abs: 0 }, solid.out, solid.mats, { cond: ALWAYS_OURS });
  if (walkC.out.length) part.columns({ abs: 0 }, { abs: 0 }, walkC.out, walkC.mats, { cond: ALWAYS_OURS, walk: true });
  const extras = new Map();
  for (const [x, y, z, st] of [...posts, ...rails, ...lamps]) extras.set(`${x},${y},${z}`, st);
  const ex = colsOf(extras);
  if (ex.out.length) part.columns({ abs: 0 }, { abs: 0 }, ex.out, ex.mats, { cond: IF_AIR_OR_FLUID });
  // the record (siteplan quays), the bill, the guard, the entrance (a route ending at the quay ends on its bank's middle cell)
  const first = [q.sx + ox, s + 1, q.sz + oz], last = [q.sx + ax * (q.len - 1) + ox, s + 1, q.sz + az * (q.len - 1) + oz];
  (r.meta.quays ??= []).push({ id: p.id, part: pid, along: [first, last], length: q.len, reach: q.reach, wetCells, surface: s, steps: [...steps].sort((a, b) => a - b).map((u) => [q.sx + ax * u + ox * q.reach, s, q.sz + az * u + oz * q.reach]), heading: H4[q.h], record: rec.id });
  const states = [];
  for (const [, st] of ops) states.push(st);
  for (const [, st] of walk) states.push(st);
  for (const [, st] of extras) states.push(st);
  (K.record.bom ??= {})[p.id] = bomOf(states);
  const mid = (q.len >> 1);
  const g = K.geom.get(p.id);
  if (g) g.entrance = [q.sx + ax * mid, S.groundAt(q.sx + ax * mid, q.sz + az * mid) + 1, q.sz + az * mid];
  res.out = { along: [first, last], length: q.len, reach: q.reach, wetCells, steps: steps.size, posts: posts.length, lamps: lamps.filter((c) => c[3] === fx.light).length, rails: rails.length, surface: s };
}

/** A fence or wall rail state standing alone (no connections; vanilla joins them on the next update). */
function fenceState(b) {
  const name = String(b).replace(/\[.*$/, '');
  if (/_wall$/.test(name)) return `${name}[east=none,north=none,south=none,up=true,waterlogged=false,west=none]`;
  if (/_fence$/.test(name)) return `${name}[east=false,north=false,south=false,waterlogged=false,west=false]`;
  return name;
}

/** The quay's answer fields (compile step 6). */
export function answer(K, p, res) {
  if (res?.pending) return { class: 'incomplete', geometry: { rect: [res.rect.minX, res.rect.minZ, res.rect.maxX, res.rect.maxZ] }, reasons: [{ code: 'VOLUME', message: 'the water under the quay was not read: prepare (or check with load: "generate"), then check again', evidence: { box: [res.pending.box.minX, res.pending.box.minY, res.pending.box.minZ, res.pending.box.maxX, res.pending.box.maxY, res.pending.box.maxZ], columns: res.pending.columns } }] };
  if (!res?.out) return null;
  return { geometry: { rect: [res.rect.minX, res.rect.minZ, res.rect.maxX, res.rect.maxZ], quays: [res.out] } };
}
