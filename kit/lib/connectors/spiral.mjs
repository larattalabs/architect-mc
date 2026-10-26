// (7a SA) The compile hooks of connector.stairs_around (SPIRAL_KINDS; docs/CONTRACT.md "Phase 7a slice SA" §1-§7; the foundation's §2
// interface, K = the compiler's context). A hosted generator plus an ordinary leg: the spiral is fixed by its host (planned here before
// routing, from the host's written cells), and a T2 path leg joins `from` to the end of its foot's approach. This module never imports
// compile.mjs, program.mjs or connectors/rope.mjs (K1's integration lesson: an import cycle left a kind list uninitialised).
//   resolve(K, p)      R27 (the host a rock_spire, ice_spike, giant_tree or giant_mushroom form part: else NO_FEATURE {why: host}),
//                      params read leniently (width, top; every other key named), movers (the top is a lookout: player-only unless the
//                      part's movers name villagers, S-SA-1; a villager spiral under 2 wide: MOVER), then the spiral planned on the host's
//                      cells (spiralGeom.mjs): SPAN, HEADROOM, UNREACHABLE, PROTECTED, OVERLAP {kind: body} with their evidence
//   legEnd(K, p)       (SA's own hook, compile.mjs's leg ends) the leg's far end: the column past the foot's approach, as a route node
//   leg(K, p)          the leg's options: width 1, the part's movers
//   answer(K, p, legs) geometry.spirals [{host, form, rise, turns, top, foot, end, width, treads, landings, crossing}], notes
//   emit(K)            the links stage after the catwalks: each spiral's cells under a checkpoint (a lamp in a body's watch cell
//                      skipped), its record in meta.spirals, the lookout node and the stairs_around graph edge, cost.bom
//   bom, survival      the part's bill and its survival row (§6: nothing free; targets, bottom up)
import { VILLAGER } from '../region/passes/route.mjs';
import { SPIRAL_KINDS, UNSAFE_EXT_7A } from './kinds7a.mjs';
import { HOST_KINDS, SPIRAL, TOP_DEFAULT, spiralBom, spiralCells, spiralPlan, spiralRoles } from './spiralGeom.mjs';
import { climbLand } from './climbGeom.mjs';
import { keptBy, watchedBy } from '../fluids/keep.mjs';
import { decodeVoxels, voxelAt } from '../region/voxels.mjs';
import { formCells } from '../forms/rules.mjs';
import { isCube } from '../blocks.mjs';

const isInt = Number.isInteger;
const stateOf = (K) => (K.spiral ??= { parts: new Map(), emitted: new Set() });
const nameOf = (s) => String(s).replace(/\[.*$/, '');

/** §1's params, read leniently (S-K1-3): width (1..2) and top when no first-class member says otherwise; every other key named. */
export function readSpiralParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'width' && part.width === undefined && isInt(v) && v >= SPIRAL.widthMin && v <= SPIRAL.widthMax) { read.width = v; continue; }
    if (key === 'top' && part.top === undefined && (v === 'summit' || v === 'canopy' || (v && isInt(v.y)))) { read.top = v; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : key === 'width' ? ` (outside ${SPIRAL.widthMin}..${SPIRAL.widthMax}, or width given)` : ''}`);
  }
  return { read, notes };
}

/**
 * The host's written cells (Map "x,y,z" -> state) of the form records `ids` in region `r`: a baked form's voxels blob, else its ops
 * evaluated by the kit's own evaluator (forms/rules.mjs formCells). Plan time.
 */
export function hostCellsOf(r, ids) {
  const out = new Map();
  for (const f of r.forms ?? []) {
    if (!ids.includes(f.id)) continue;
    const p = r.parts.find((q) => q.id === f.part);
    if (!p) continue;
    const plain = [];
    for (const op of p.ops.slice(f.opsFrom, f.opsTo)) {
      if (op.op !== 'voxels') { plain.push(op); continue; }
      const b = r.sideBlobs?.[op.blob];
      if (!b) continue;
      const v = decodeVoxels(b.bytes, op.blob);
      for (let i = 0; i < v.count; i++) { const [x, y, z] = voxelAt(v, i); out.set(`${op.origin[0] + x},${op.origin[1] + y},${op.origin[2] + z}`, v.palette[v.pal[i]]); }
    }
    if (plain.length) for (const [k, s] of formCells(plain).cells) { if (!s || nameOf(s) === 'minecraft:air') out.delete(k); else out.set(k, s); }
  }
  return out;
}

/** The form records of a plan part (its instances: `f_<part>_<n>`), in order. */
const instancesOf = (K, id) => (K.r.forms ?? []).filter((f) => new RegExp(`^f_${id}_\\d+$`).test(f.id));

/** The columns the route pass keeps off for a form record: its column mask (F3), else its bounds (F1). */
function hardOf(f) {
  if (f.columns) {
    const set = new Set();
    for (let i = 0; i < f.columns.length; i += 3) for (let x = f.columns[i + 1]; x <= f.columns[i + 2]; x++) set.add(`${x},${f.columns[i]}`);
    return (x, z) => set.has(`${x},${z}`);
  }
  const b = f.bounds;
  return (x, z) => !!b && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
}

/** The columns a spiral never writes: keep-out, protected areas, builds, other regions, lot boxes and aprons, the claim margin. */
function blockedOf(K) {
  const c = K.env.claim, rects = [...(K.ctx.keepOut ?? []).map((q) => [...q]), ...K.env.protectedAreas.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.regions.map((q) => [q.rect.minX - 1, q.rect.minZ - 1, q.rect.maxX + 1, q.rect.maxZ + 1]), ...K.env.buildRects.map((q) => [q.rect.minX - 1, q.rect.minZ - 1, q.rect.maxX + 1, q.rect.maxZ + 1]), ...K.r.lots.map((l) => [l.box.minX - 1, l.box.minZ - 1, l.box.maxX + 1, l.box.maxZ + 1])];
  return (x, z) => x < c.minX + 2 || x > c.maxX - 2 || z < c.minZ + 2 || z > c.maxZ - 2 || rects.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
}

const refuse = (notes, code, message, evidence) => ({ class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code, message, evidence }] });

/** Before routing: R27, the movers, the spiral planned on its host. An answer that stops the part, or null to route its leg. */
export function resolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readSpiralParams(part);
  const notes = [...pr.notes];
  const hostId = part.around?.feature?.part;
  const hp = K.byId.get(hostId);
  // R27: the host is a form part of a host kind
  if (!hp || hp.family !== 'form' || !HOST_KINDS.includes(hp.kind)) return refuse(notes, 'NO_FEATURE', `the host ${hostId} is not a rock_spire, ice_spike, giant_tree or giant_mushroom form part (R27)`, { why: 'host', part: hostId ?? null, kind: hp?.kind ?? null, family: hp?.family ?? null });
  const given = (part.movers ?? []).filter((m) => m === 'player' || m === VILLAGER);
  // S-SA-1: the top is a lookout: player-only unless the part's movers name villagers
  const movers = given.length ? given : ['player'];
  const width = part.width ?? pr.read.width ?? (movers.includes(VILLAGER) ? SPIRAL.villagerMinWidth : 1);
  if (movers.includes(VILLAGER) && width < SPIRAL.villagerMinWidth) return refuse(notes, 'MOVER', `a villager spiral is at least ${SPIRAL.villagerMinWidth} wide (width ${width}): a 1-wide turning stair is too tight for a villager`, { movers, width, minWidth: SPIRAL.villagerMinWidth });
  const forms = instancesOf(K, hostId);
  if (!forms.length) return refuse(notes, 'NO_FEATURE', `the host ${hostId} placed no form`, { why: 'host', part: hostId, placed: 0 });
  // the instance nearest `from` (a count > 1 host: noted)
  const fromE = K.endpointNode(part.from, { at: [forms[0].params?.at?.[0] ?? 0, 0, forms[0].params?.at?.[2] ?? 0] }, p, 'from');
  if (fromE.error) return null; // (the leg answers it as any route's end)
  const F = [fromE.at[0], fromE.at[2]];
  const dist = (f) => { const a = f.params?.at ?? [0, 0, 0]; return Math.abs(a[0] - F[0]) + Math.abs(a[2] - F[1]); };
  const f = [...forms].sort((a, b) => dist(a) - dist(b) || (a.id < b.id ? -1 : 1))[0];
  if (forms.length > 1) notes.push(`the host has ${forms.length} forms: the spiral climbs ${f.id}, the nearest to from`);
  const at = f.params?.at;
  if (!Array.isArray(at)) return refuse(notes, 'NO_FEATURE', `the host's form ${f.id} has no base point`, { why: 'host', form: f.id });
  const host = hostCellsOf(K.r, [f.id]);
  const unsafe = part.ext?.[UNSAFE_EXT_7A] ?? {};
  const top = part.top ?? pr.read.top ?? TOP_DEFAULT[hp.kind];
  const L = climbLand(K.r.survey, { volumes: (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean) });
  const S = K.r.survey;
  const land = { groundAt: L.groundAt, open: (x, y, z) => { const c = L.classAt(x, y, z); return c === 'AIR' || c === 'PLANT'; }, waterAt: (x, z) => !!S.waterAt?.(x, z) };
  const R = spiralRoles(K.r.roles ?? {}, K.ctx.connectors?.stairs_around ?? {}, { cold: hp.kind === 'ice_spike' });
  const lampEvery = R.light ? Math.max(4, Math.floor((12 * R.level) / 15)) : 12;
  const store = K.keep ?? [];
  const plan = spiralPlan(host, { kind: hp.kind, at, from: F, top, width, land, hard: hardOf(f), blocked: blockedOf(K), kept: store.length ? (x, y, z) => keptBy(store, x, y, z, { watch: false }) : null, lampEvery, lamps: part.lamps !== 'none' && !!R.light, _unsafe: unsafe });
  if (!plan.ok) return refuse(notes, plan.code, plan.message, { ...plan.evidence, host: hostId, form: f.id, ...(plan.code === 'OVERLAP' ? { kind: 'body' } : {}) });
  if (plan.lowered) notes.push(`the canopy deck stands ${plan.lowered} lower than 3 under the lowest leaf or cap cell: a branch or the cap stood over the ring deck there`);
  if (!R.light && part.lamps !== 'none') notes.push('no lamps: the bible has no light role, or (by ice) its light is neither a lantern nor a torch (M17)');
  if (unsafe.floating) notes.push('architect_mc:unsafe floating: the treads\' supports left out (a broken variant: M10:spiral and M3 catch it)');
  if (unsafe.noRails) notes.push('architect_mc:unsafe noRails: the rails left out (a broken variant: M10:spiral and M8 catch it)');
  st.parts.set(p.id, { plan, movers, width, notes, host: hostId, form: f.id, R, hostKind: hp.kind, unsafe });
  return null;
}

/** (SA) The leg's far end: the column past the foot's approach, as a route node (feet over its ground), facing out of the approach. */
export function legEnd(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return null;
  const [x, g, z] = o.plan.end;
  const at = [x, g + 1, z];
  return { name: `sa_${K.order.indexOf(p)}_foot`, at, node: { at, kind: 'junction', facing: [...o.plan.normal] } };
}

/** The leg's route options: a path 1 wide with the part's movers. */
export function leg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return null;
  return { width: 1, movers: o.movers };
}

export function passInput() { return null; }
export function failAnswer() { return null; }

/** The spiral's crossing (§7): {type: stairs_around, host, rise, turns}. */
const crossingOf = (o) => ({ type: 'stairs_around', host: o.host, rise: o.plan.rise, turns: o.plan.turns });

/** After routing: the part's answer fields. */
export function answer(K, p, legs) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return null;
  void legs;
  const s = o.plan;
  const out = { geometry: { spirals: [{ host: o.host, form: o.form, top: { kind: s.topKind, y: s.D, at: [...s.top.node] }, foot: [...s.foot], end: [...s.end], rise: s.rise, turns: s.turns, width: o.width, treads: s.treads, landings: s.landings, movers: [...o.movers], crossing: crossingOf(o) }] } };
  if (o.notes.length) out.notes = [...o.notes];
  return out;
}

/** The links stage: each spiral's cells under a checkpoint, its record, the lookout node and the stairs_around edge, cost.bom. */
export function emit(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const stage = K.r.stageList.includes('links') ? 'links' : K.stageOf('routes');
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!SPIRAL_KINDS.includes(p.kind) || !ok(p.id) || !x.meta?.ok || st.emitted.has(p.id)) continue;
    st.emitted.add(p.id);
    const o = st.parts.get(p.id);
    const cp = K.checkpoint();
    try {
      const idx = K.order.indexOf(p);
      const r = K.r, s = o.plan;
      const path = (() => { const b = r.roles?.path; return b && isCube({ name: nameOf(b) }) ? nameOf(b) : null; })();
      const host = hostCellsOf(r, [o.form]);
      const S = r.survey;
      const solidAt = (xx, yy, zz) => host.has(`${xx},${yy},${zz}`) || yy <= S.groundAt(xx, zz);
      let cells = spiralCells(s, o.R, { path, solidAt });
      // ((6c KC) a lamp in a body's watch cell skipped)
      const store = K.keep ?? [];
      let lampsSkipped = 0;
      if (store.length) cells = cells.filter((c) => { if (c[4] !== 'lamp' || !watchedBy(store, c[0], c[1], c[2])) return true; lampsSkipped++; return false; });
      const part = r.parts.find((q) => q.id === `links_s${idx}`) ?? r.part(`links_s${idx}`, { stage, set: 'path' });
      (r.meta.parts[part.id] ??= {}).kind ??= 'path';
      const mats = [], mi = new Map();
      const m = (state) => { if (!mi.has(state)) { mi.set(state, mats.length); mats.push(state); } return mi.get(state); };
      // bottom up (RS's order: what carries a cell is written first): the corbel, supports, beds, then the rest by level
      const order = { approach: 0, corbel: 1, support: 2, bed: 3, tread: 4, flat: 4, ground: 4, deck: 4, rail: 5, lamp: 6 };
      const sorted = [...cells].sort((a, b) => a[1] - b[1] || order[a[4]] - order[b[4]] || a[0] - b[0] || a[2] - b[2]);
      const solidCols = [], walkCols = [];
      for (const c of sorted) (['tread', 'flat', 'ground', 'deck', 'approach'].includes(c[4]) ? walkCols : solidCols).push(c[0], c[2], c[1], c[1], m(c[3]));
      if (solidCols.length) part.columns({ abs: 0 }, { abs: 0 }, solidCols, mats);
      if (walkCols.length) part.columns({ abs: 0 }, { abs: 0 }, walkCols, mats, { walk: true });
      K.mark(p.id, K.addedSince(cp));
      // the lookout node and the stairs_around edge from the foot's route node
      const [nx, ny, nz] = s.top.node;
      const lookout = `sa_${idx}_lookout`;
      r.graphNode({ id: lookout, kind: 'lookout', ref: p.id, at: [nx, ny + 1, nz], ports: [{ name: 'top', at: [nx, ny + 1, nz], facing: 'up', width: o.width }] });
      const foot = `sa_${idx}_foot`;
      const fn = r.graph.nodes.find((q) => q.id === foot);
      const crossing = crossingOf(o);
      if (fn) r.graphEdge({ id: `sa_${idx}_spiral`, from: `${foot}.${fn.ports[0].name}`, to: `${lookout}.top`, type: 'stairs_around', width: o.width, path: part.id, stage, movers: o.movers, crossing });
      const bom = spiralBom(cells);
      const walk = cells.filter((c) => ['tread', 'flat', 'ground', 'deck'].includes(c[4])).map((c) => [c[0], c[1], c[2]]);
      const rec = {
        id: `spiral_${p.id}`.slice(0, 48), kind: 'stairs_around', part: part.id, recPart: p.id, stage, host: o.host, form: o.form, hostKind: o.hostKind, rise: s.rise, turns: s.turns, width: o.width, movers: [...o.movers],
        top: [nx, ny, nz], topKind: s.topKind, topY: s.D, foot: [...s.foot], end: [...s.end], entry: [...s.entry], axis: [...s.axis],
        walk: s.walk.filter((w) => w.lane === 1).map((w) => [w.x, w.y, w.z, w.kind]), outer: s.walk.filter((w) => w.lane === 2).map((w) => [w.x, w.y, w.z, w.kind]),
        deckCells: walk, deck: s.top.deck.map((q) => [...q]), corbel: s.top.corbel.map((q) => q.slice(0, 3)), topBeds: s.top.beds.map((q) => [...q]), rails: cells.filter((c) => c[4] === 'rail').map((c) => [c[0], c[1], c[2]]), lamps: cells.filter((c) => c[4] === 'lamp').map((c) => [c[0], c[1], c[2]]),
        supports: s.supports.map((q) => q.slice(0, 3)), approach: s.approach.map((q) => [...q]), treads: s.treads, landings: s.landings, railsSkipped: s.railsSkipped, ...(lampsSkipped ? { lampsSkipped } : {}),
        light: o.R.light, bom, ...(Object.keys(o.unsafe).length ? { _unsafe: { ...o.unsafe } } : {}),
      };
      (r.meta.spirals ??= []).push(rec);
      const a = K.answers.get(p.id);
      if (a?.geometry?.spirals?.[0]) a.geometry.spirals[0].crossing = crossing;
      const ge = r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
      void ge;
      const b = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const [item, n] of Object.entries(bom)) b[item] = (b[item] ?? 0) + n;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(b).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
    } catch (e) {
      K.rollback(cp);
      const code = (/^([A-Z_]+):/.exec(e.message) ?? [])[1];
      K.ans(p, { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: code === 'OVERLAP' ? code : 'UNREACHABLE', message: `the spiral could not be written: ${e.message}`, evidence: { edge: x.meta.id } }] });
    }
  }
}

export function bom(K, p) { return K.record?.bom?.[p.id] ?? null; }

/** §6: nothing free; the treads, landings, supports, rails, deck, corbel and lamps paid; targets, bottom up. */
export function survival(K, p) {
  void K;
  if (!SPIRAL_KINDS.includes(p.kind)) return null;
  return { free: [], paid: ['approach', 'tread', 'landing', 'support', 'bed', 'rail', 'deck', 'corbel', 'lamp'], path: 'targets', order: 'bottom-up: each tread on the one below or the host' };
}
