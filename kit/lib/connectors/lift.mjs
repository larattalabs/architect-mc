// (7a LF) The compile hooks of connector.lift (LIFT_KINDS; docs/CONTRACT.md "Phase 7a slice LF" §1, §3, §4, §6, §7; the foundation's §2
// interface, K = the compiler's context). This module never imports compile.mjs, program.mjs or connectors/rope.mjs (K1's integration
// lesson: an import cycle left a kind list uninitialised).
//   resolve(K, p) -> stop | null            before routing: params read leniently (rise, down; every other key named in the notes); movers
//                                           ['player'] by kind (S-7a-8, S-LF-1); R18's self-loop NO_CLIMB; rise.min over rise.max SPAN;
//                                           then the ends routed dry as a plain path (rolled back): an ascent under 4 refused NO_CLIMB
//                                           with that path as the wouldFit (S-7a-2); then a part whose own movers name villagers refused
//                                           MOVER (after NO_CLIMB), with a stair wouldFit where a dry stair route climbs, else the path
//   leg(K, p) -> legOptions                 spans ['lift'], once 'lift', approach, width 1, movers ['player'], type 'lift', t7.lift {down,
//                                           rise}
//   passInput(K) -> object | null           the pass-level `lift` input: the caller's frozen volumes and the plan bodies' hard cells (KC)
//   failAnswer(K, leg, meta) -> answer|null its typed refusal from the row's `fail` (NO_CLIMB gets a `path` wouldFit, re-checked alone)
//   answer(K, p, legs) -> extra | null      geometry.lifts (rise, down, side, dir, move, from, to, crossing {type: lift, rise, down})
//   emit(K)                                 the links stage, last (§4: a lift is placed after every route and wall): each routed tower
//                                           written by liftGeom.writeLift under a checkpoint (its body through r.fluidBody: the bubble cells
//                                           in the fluids stage), registered with KC's registry (hard = shaft, shell, both layers, base;
//                                           watch = the single breach's reach); a tower meeting a body placed before it refused NO_ROOM
//                                           {why: clear}; the graph edge's type and crossing; cost.bom; then the wouldFits
//   bom(K, p) -> cost.bom | null            C26's bomFull over the written cells (the bubble cells are water: free)
//   survival(K, p) -> RS target spec        §6: the bubble cells free (water); soul sand, magma, shell, doors, rails, lights paid; the
//                                           shell bottom up, then the body when every paid cell is built and still ours (RS §7.3)
import { LIFT, checkLift, liftMats, writeLift } from './liftGeom.mjs';
import { inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { VOXEL_CLASSES, VC, classAt as volumeClassAt } from '../region/volume.mjs';
import { LIFT_KINDS, UNSAFE_EXT_7A } from './kinds7a.mjs';
import { keptBy, registerBody } from '../fluids/keep.mjs';

const isInt = Number.isInteger;
const sameEnd = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
/** The lift state of the compile. */
const stateOf = (K) => (K.lift ??= { parts: new Map(), would: [], emitted: new Set() });

/** A lift's params, read leniently (S-K1-3): rise ({min, max} in 4..64) and down (boolean) when no first-class member says otherwise. */
export function readLiftParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  const inRange = (v) => v === undefined || (isInt(v) && v >= LIFT.riseMin && v <= LIFT.riseMax);
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'rise' && part.rise === undefined && v && typeof v === 'object' && !Array.isArray(v) && inRange(v.min) && inRange(v.max)) { read.rise = { ...v }; continue; }
    if (key === 'down' && part.down === undefined && typeof v === 'boolean') { read.down = v; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : ['winch', 'rope', 'elevator'].includes(key) ? ' (a lift is a bubble column, S-LF-1)' : ''}`);
  }
  return { read, notes };
}

/** The part's endpoints as route nodes (K.endpointNode), or null when one doesn't resolve (the main pass answers that). */
function endsOf(K, p) {
  const part = p.part;
  const ends = [part.from, ...(part.via ?? []).slice(0, 1), ...(part.via?.length ? [] : [part.to])];
  const pts = [];
  for (let k = 0; k < ends.length; k++) {
    const other = ends[k === ends.length - 1 ? k - 1 : k + 1];
    const e = K.endpointNode(ends[k], other, p, k === 0 ? 'from' : k === ends.length - 1 ? 'to' : `via[${k - 1}]`);
    if (e.error) return null;
    pts.push(e);
  }
  return pts.length >= 2 ? pts : null;
}

/** The keep-out a dry run sees (as the main pass's: protected areas, other owners' regions, builds). */
const keepOutOf = (K) => [...K.env.protectedAreas.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.regions.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.buildRects.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ])];

/** A dry run of the route pass over the part's ends with `opts` per edge (rolled back): `{ok, edges}`, or null. */
function dryRoute(K, p, pts, opts) {
  const cp = K.checkpoint();
  try {
    const nodes = {};
    for (const e of pts) if (e.node) nodes[e.name] = e.node;
    const edges = pts.slice(1).map((e, k) => ({ id: `lf${K.order.indexOf(p)}d${k}`, from: pts[k].name, to: e.name, ...opts }));
    const ko = keepOutOf(K);
    const out = K.r.pass('route', { nodes, edges, maxGrade: 0.25, stage: K.stageOf('routes'), part: 'lift_dry', maxExpanded: K.env.budget.maxNodes, ...(ko.length ? { keepOut: ko } : {}), ...(K.env.standingHard?.length ? { hard: [...K.env.standingHard] } : {}) });
    const edgesOut = out.data.edges.map((e) => ({ ...e }));
    return { ok: edgesOut.every((e) => e.ok), edges: edgesOut };
  } catch {
    return null;
  } finally {
    K.rollback(cp);
  }
}

/** The ascent of a dry route: the highest point of its surface minus its lowest, over every leg. */
const ascentOf = (edges) => {
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) for (const q of e.path ?? []) { if (q[1] < lo) lo = q[1]; if (q[1] > hi) hi = q[1]; }
  return hi >= lo ? hi - lo : 0;
};

/** A polyline's corners (as compile.mjs's). */
function corners(path) {
  if (path.length <= 2) return path.map((q) => [...q]);
  const out = [path[0]];
  for (let i = 1; i + 1 < path.length; i++) {
    const a = path[i - 1], b = path[i], c = path[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[2] - a[2] !== c[2] - b[2] || b[1] - a[1] !== c[1] - b[1]) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out.map((q) => [...q]);
}

/** A part's routed members, rewritten as `kind` with `extra` (a wouldFit fragment; a lift's own members dropped). */
function fragmentOf(part, kind, extra = {}) {
  const frag = {};
  for (const k of ['id', 'required', 'label', 'notes', 'ext', 'from', 'via', 'to', 'avoid', 'style', 'tolerance']) if (part[k] !== undefined) frag[k] = part[k];
  return { ...frag, kind, ...extra };
}
const wouldFitOf = (p, frag, edges, width) => ({ part: p.id, fragment: frag, geometry: { legs: edges.map((l) => ({ length: l.length, rise: l.rise, path: corners(l.path ?? []) })) }, cost: { cells: edges.reduce((n, l) => n + l.length * width, 0) } });

const nc = (notes, rise, wf, message) => ({ class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'NO_CLIMB', message, evidence: { rise, need: LIFT.riseMin } }], ...(wf ? { wouldFit: [wf] } : {}) });

/** Before routing: an answer that stops the part, or null to route it. */
export function resolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readLiftParams(part);
  const notes = [...pr.notes];
  const unsafe = part.ext?.[UNSAFE_EXT_7A] ?? {};
  // S-7a-8, S-LF-1: a lift is player-only by kind; its own movers naming villagers answer MOVER (after NO_CLIMB)
  const movers = inferMovers(null, null, ['player']);
  const down = part.down ?? pr.read.down ?? false;
  const rise = part.rise ?? pr.read.rise ?? null;
  const o = { movers, down, rise, notes, approach: part.approach ?? LIFT.approach, unsafe, lamps: part.lamps !== 'none' };
  st.parts.set(p.id, o);
  if (sameEnd(part.from, part.to) && !(part.via ?? []).length) return nc(notes, 0, null, 'both ends are one place: nothing to climb (R18)');
  if (rise && isInt(rise.min) && isInt(rise.max) && rise.min > rise.max) return { class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'SPAN', message: `rise.min ${rise.min} is over rise.max ${rise.max}`, evidence: { rise } }] };
  // ---- nothing to climb: the ends routed dry as a plain path
  const pts = endsOf(K, p);
  if (!pts) return null;
  const given = (part.movers ?? []).filter((m) => m === 'player' || m === VILLAGER);
  const dry = dryRoute(K, p, pts, { width: 1, ...(given.length ? { movers: given } : {}) });
  o.dryAscent = dry?.ok ? ascentOf(dry.edges) : null;
  const pathFit = dry?.ok ? wouldFitOf(p, fragmentOf(part, 'path', given.length ? { movers: part.movers } : {}), dry.edges, 1) : null;
  if (dry?.ok && o.dryAscent < LIFT.riseMin) return nc(notes, o.dryAscent, pathFit, `the ends rise ${o.dryAscent}: a lift stands at a face rising at least ${LIFT.riseMin} (a plain path joins them)`);
  // ---- a lift whose own movers name villagers: MOVER, with a stair where one climbs alone, else the path
  if ((part.movers ?? []).includes(VILLAGER)) {
    const sd = dryRoute(K, p, pts, { width: 2, movers: ['player', VILLAGER], profile: 'stair', type: 'stair' });
    const stairOk = sd?.ok && sd.edges.some((e) => e.segments.some((g) => g.kind === 'stair'));
    const wf = stairOk ? wouldFitOf(p, fragmentOf(part, 'stair', { width: 2, movers: part.movers }), sd.edges, 2) : pathFit;
    return { class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'MOVER', message: 'a lift is player-only (villagers don\'t ride bubble columns, S-7a-8): its movers name villager', evidence: { movers: part.movers, kind: 'lift' } }], ...(wf ? { wouldFit: [wf] } : {}) };
  }
  return null;
}

/** A lift leg's route options. */
export function leg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  return { width: 1, movers: o.movers, spans: ['lift'], once: 'lift', approach: o.approach, type: 'lift',
    t7: { lift: { down: !!o.down, ...(o.rise ? { rise: { ...o.rise } } : {}), ...(Object.keys(o.unsafe ?? {}).length ? { _unsafe: { ...o.unsafe } } : {}) } } };
}

/** The pass-level lift input: the caller's frozen volumes and the plan bodies' hard cells; null without a lift part. */
export function passInput(K) {
  const st = stateOf(K);
  if (!K.k1Parts.some((p) => LIFT_KINDS.includes(p.kind))) return null;
  if (st.input !== undefined) return st.input;
  const volumes = (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean);
  const kept = [];
  for (const q of K.keep ?? []) if (q.kind === 'body') for (const k of q.hard.keys()) { const [x, y, z] = k.split(',').map(Number); kept.push([x, y, z, q.body]); }
  st.input = volumes.length || kept.length ? { ...(volumes.length ? { volumes } : {}), ...(kept.length ? { kept } : {}) } : null;
  return st.input;
}

const MESSAGES = {
  NO_CLIMB: `no face rising ${LIFT.riseMin} or more within the approach (a plain path walks it)`,
  SPAN: `the only faces rise outside ${LIFT.riseMin}..${LIFT.riseMax} (or the part's rise)`,
  ANCHOR: 'the face behind the shaft is neither site-solid nor writable (sand or air with no room for a written shell), or the foot stands more than 6 over its ground',
  HEADROOM: 'an overhang, a trunk or land stands within 3 over the shaft\'s top, 2 over the top walk cell, or over the tower\'s roof',
  WATER: 'the tower would stand in water (its footprint, the written face or the approach)',
  PROTECTED: 'the tower would write in keep-out, a protected area, a build, another region, a lot box or apron, a wall, an earlier route, a body or the claim margin',
  UNREACHABLE: 'a lift at the face fits but the walks at its ends do not reach the ends within the approach',
};

/** A leg the pass could not route (m.failed === 'LIFT'): its typed refusal; null when it is not this module's. */
export function failAnswer(K, l, m) {
  if (!LIFT_KINDS.includes(l.conn.kind)) return null;
  const why = m?.t7?.lift ?? (m?.failed === 'BUDGET' ? null : { code: 'UNREACHABLE', evidence: { failed: m?.failed ?? null } });
  if (!why) return null;
  const st = stateOf(K);
  const o = st.parts.get(l.conn.id);
  if (why.code === 'NO_CLIMB') st.would.push({ id: l.conn.id, code: why.code, leg: l.k, evidence: why.evidence });
  const reason = { code: why.code, message: `leg ${l.k + 1}: ${MESSAGES[why.code] ?? why.code}`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) } };
  return { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [reason] };
}

/** A lift's crossing (§7): {type: lift, rise, down}. */
const crossingOf = (g) => ({ type: 'lift', rise: g.rise, down: !!g.down });

/** After routing: a lift connector's answer fields (geometry.lifts, notes). */
export function answer(K, p, legs) {
  if (!LIFT_KINDS.includes(p.kind)) return null;
  const o = stateOf(K).parts.get(p.id);
  const lifts = [];
  for (const { meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'lift') continue;
    lifts.push({ rise: g.rise, down: !!g.down, ...(g.down ? { side: g.side } : {}), move: g.move, dir: [...g.dir], from: [...meta.path[g.from]], to: [...meta.path[g.to]], crossing: crossingOf(g) });
  }
  const out = { geometry: { lifts } };
  const n = [...(o?.notes ?? []), 'a lift is player-only: a bubble column against the face, entered through a two-door airlock (S-LF-1)'];
  out.notes = n;
  return out;
}

/** The plan's land at emission (the row's reading): the survey's ground and classes, a frozen volume's where the plan holds one. */
function emitLand(K) {
  const st = stateOf(K);
  if (st.land) return st.land;
  const S = K.r.survey;
  const vols = (passInput(K)?.volumes ?? []).filter(Boolean);
  const classAt = (x, y, z) => {
    for (const v of vols) { const c = volumeClassAt(v, x, y, z); if (c !== VC.MISSING) return VOXEL_CLASSES[c]; }
    if (S.missingAt?.(x, z)) return 'MISSING';
    const g = S.groundAt(x, z);
    if (y > g) return 'AIR';
    if (S.waterAt(x, z)) return S.frozenAt?.(x, z) && y === g ? 'ICE' : 'WATER';
    return y >= g - 3 ? 'SOIL' : 'ROCK';
  };
  const c = K.r.claim;
  st.land = { groundAt: S.groundAt, topAt: S.topAt, waterAt: S.waterAt, blocked: () => false, classAt, inClaim: (x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ };
  return st.land;
}

/** The links stage (last): emit every routed lift edge's tower under a checkpoint each; types and crossings; the wouldFits. */
export function emit(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const stage = K.r.stageList.includes('links') ? 'links' : K.stageOf('routes');
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!LIFT_KINDS.includes(p.kind) || !ok(p.id) || !x.meta || st.emitted.has(`${p.id}:${x.meta.id}`)) continue;
    const segs = (x.meta.segments ?? []).filter((g) => g.kind === 'lift');
    if (!segs.length) continue;
    st.emitted.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id);
    const idx = K.order.indexOf(p);
    const land = emitLand(K);
    const store = K.keep ?? [];
    // the towers, checked again and against the registry as it stands at emit (a lift keeps clear of every earlier writer: S-KC-1)
    const geoms = [];
    let refusal = null;
    for (const g of segs) {
      const dir = g.dir;
      const t = checkLift(land, g.approach, dir, { down: !!g.down, side: g.side, move: g.move, rise: o?.rise ?? undefined, _unsafe: o?.unsafe && Object.keys(o.unsafe).length ? o.unsafe : undefined });
      if (!t.ok) { refusal = { code: t.code === 'NO_CLIMB' ? 'UNREACHABLE' : t.code, message: `the lift could not be written: ${t.code}`, evidence: { edge: x.meta.id, ...(t.evidence ?? {}) } }; break; }
      const hit = [];
      if (store.length) {
        for (const c of t.cells) { const k = keptBy(store, c[0], c[1], c[2]); if (k) hit.push({ at: [c[0], c[1], c[2]], body: k.body, part: k.part, set: k.set }); }
        for (const sh of t.shafts) for (const c of sh.cells) { const k = keptBy(store, c[0], c[1], c[2]); if (k) hit.push({ at: [...c], body: k.body, part: k.part, set: k.set }); }
      }
      if (hit.length) { refusal = { code: 'NO_ROOM', message: `the lift would write ${hit.length} cell(s) of body ${hit[0].body} (${hit[0].set}), placed before it: the later part keeps clear (S-KC-1)`, evidence: { why: 'clear', kind: 'clear', body: hit[0].body, writer: hit[0].part, cells: hit.slice(0, 16).map((q) => q.at) } }; break; }
      geoms.push({ g, t });
    }
    if (refusal) { K.ans(p, { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [refusal] }); continue; }
    const cp = K.checkpoint();
    const mats = liftMats(K.r);
    const recs = [];
    geoms.forEach(({ g, t }, si) => {
      const un = { ...(o?.unsafe ?? {}) };
      const bodyId = `lift_${String(p.id)}`.slice(0, 44) + (geoms.length > 1 ? `_${si}` : '');
      const res = writeLift(K.r, t, { part: `links_l${idx}`, stage, bodyId: bodyId.replace(/[^a-z0-9_]/g, '_'), planPart: p.id, mats, id: `lift_l${idx}_${x.meta.id}_${si}`.slice(0, 48), edge: x.meta.id, movers: o?.movers ?? ['player'],
        sturdy: (xx, yy, zz) => ['ROCK', 'SOIL'].includes(land.classAt(xx, yy, zz)), ...(Object.keys(un).length ? { _unsafe: un } : {}) });
      // (KC, §4) the body registered: hard = the shaft, its shell (inner layer, base, rims, the face behind it), the outer layer and the
      // written face; watch = the single breach's reach
      registerBody(store, { ...res.body, shell: [...res.body.shell, ...t.outer, ...t.faceWritten] }, p.id);
      recs.push({ g, rec: res.rec, bom: res.bom });
    });
    K.mark(p.id, K.addedSince(cp));
    const a = K.answers.get(p.id);
    const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
    recs.forEach(({ g, rec }, t) => {
      const cr = crossingOf(g);
      const ac = (a?.geometry?.lifts ?? [])[t];
      if (ac) { ac.crossing = cr; ac.body = rec.body; }
      if (ge && t === 0) { ge.type = 'lift'; ge.crossing = cr; ge.movers = ['player']; }
    });
    const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
    for (const { bom: b } of recs) for (const [item, nn] of Object.entries(b ?? {})) bom[item] = (bom[item] ?? 0) + nn;
    K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
    if (a && recs.some(({ rec }) => !rec.shaftLit)) a.notes = [...(a.notes ?? []), 'the light role is no block a shell can hold (a torch is washed away): the shaft is unlit (drowned may spawn in its water in a river or ocean biome)'];
  }
  wouldFits(K);
}

/** The cost.bom of a part (the links record's, written at emit). */
export function bom(K, p) {
  return K.record?.bom?.[p.id] ?? null;
}

/** §6: lifts in survival: the bubble cells free (water, N-H-1); every other cell paid; the shell bottom up, then the body. */
export function survival(K, p) {
  if (!LIFT_KINDS.includes(p.kind)) return null;
  return { free: ['bubble_column'], paid: ['soul_sand', 'magma_block', 'shell', 'door', 'rail', 'light'], path: 'targets', order: 'bottom-up: the fill, the plinth and its base, the layers and doors, the cap and rails; then the body when every paid cell is built and still ours (RS §7.3)' };
}

/** NO_CLIMB's repair (§3): a plain `path` of the same ends when it routes alone (a dry run of the route pass, rolled back). */
function wouldFits(K) {
  const st = stateOf(K);
  const seen = new Set();
  for (const w of st.would) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const p = K.byId.get(w.id), a = K.answers.get(w.id);
    if (!p || !a || a.class !== 'refused' || !LIFT_KINDS.includes(p.kind) || a.wouldFit) continue;
    const pts = endsOf(K, p);
    if (!pts || sameEnd(p.part.from, p.part.to)) continue;
    const dry = dryRoute(K, p, pts, { width: 1 });
    if (dry?.ok) a.wouldFit = [wouldFitOf(p, fragmentOf(p.part, 'path'), dry.edges, 1)];
  }
}

