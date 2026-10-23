// (7a CL) Climbs in the plan compiler (docs/CONTRACT.md "Phase 7a slice CL"): connector.stair, connector.switchback and connector.ladder,
// each a routed connector whose search is T2's own under a per-edge cost profile (lib/region/passes/moves/profiles.mjs), plus the
// fittings T2 doesn't lay (climbGeom.mjs) and the post-check that it climbed. The hooks of the foundation's table (hooks7a.mjs; K = the
// compiler's context). This module never imports compile.mjs, program.mjs or connectors/rope.mjs (K1's cycle lesson).
//   resolve(K, p)      before routing: params read leniently (S-K1-3), movers (stairs and switchbacks inferred as T2, S-T2-1; a ladder
//                      player-only by kind, S-7a-8), then the climbed check (§3): the ends routed dry as a plain path (rolled back), its
//                      ascent under 2 refused NO_CLIMB with that path as the wouldFit; then a ladder whose own movers name villagers
//                      refused MOVER (a stair wouldFit where one fits alone, else the path); then a ladder's face rule on its dry route
//                      (ANCHOR, naming the cells)
//   leg(K, p)          the legs' route options: profile and type the kind, width, movers, a switchback's landing depth, the tread role
//   failAnswer(K, l, m) a ladder leg whose ends rise more than 48: SPAN; else the default (UNREACHABLE)
//   answer(K, p, legs) geometry.climbs, notes; a route with no flight (stair), hairpin (switchback) or ladder (ladder) is adjusted with
//                      the climb deviation {what: climb, value: rise, kind: walk, rise} (the coordinator's shape, 2026-10-23: the answer
//                      schema's value is a number)
//   emit(K)            the links stage: each routed climb's fittings under a checkpoint, its graph edge's crossing, its cost.bom
//   bom, survival      the part's bill (the fittings and the climb's treads and rungs) and its survival row (§6)
import { inferMovers, VILLAGER, footprintOf } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { CLIMB_KINDS, UNSAFE_EXT_7A } from './kinds7a.mjs';
import { CLIMB, climbCells, climbLand, emitClimbs, walkCols } from './climbGeom.mjs';
import { PROFILES } from '../region/passes/moves/profiles.mjs';
import { shapeOf } from './style.mjs';
import { bomOf } from './bom.mjs';

const isInt = Number.isInteger;
const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };
/** An endpoint's lot kind (S-T2-1's inference; K1b's reading, repeated here so no import cycle forms). */
function kindOf(K, e) {
  if (!e || e.part === undefined) return null;
  const id = e.port && K.lotZone.has(e.port) ? e.port : e.part;
  if (!K.lotZone.has(id)) return null;
  const rl = K.r.lots.find((l) => l.id === id);
  if (rl && lotKind(rl)) return lotKind(rl);
  const z = K.byId.get(K.lotZone.get(id));
  const spec = zoneLots(z?.part).find((l) => l.id === id)?.lot;
  return spec?.type ?? spec?.role ?? null;
}
const sameEnd = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const stateOf = (K) => (K.climb ??= { parts: new Map(), emitted: new Set() });

/** §1's params, read leniently: width, lamps or torches; material noted; every other key listed by name. */
export function readClimbParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'width' && part.width === undefined && part.kind !== 'ladder' && isInt(v) && v >= 1 && v <= 5) { read.width = v; continue; }
    if ((key === 'lamps' || key === 'torches') && part.lamps === undefined && (v === true || v === false || ['none', 'few', 'street'].includes(v))) { read.lamps = v === false || v === 'none' ? 'none' : 'few'; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : key === 'width' ? ' (outside 1..5, or width given)' : ''}`);
  }
  return { read, notes };
}

/** A part's routed members, written as `kind` with `extra` (a wouldFit fragment). */
function fragmentOf(part, kind, extra = {}) {
  const frag = {};
  for (const k of ['id', 'required', 'label', 'notes', 'ext', 'from', 'via', 'to', 'avoid', 'width', 'lamps', 'style', 'tolerance']) if (part[k] !== undefined) frag[k] = part[k];
  if (kind !== 'ladder' && part.movers && kind !== part.kind) frag.movers = part.movers;
  return { ...frag, kind, ...extra };
}

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

/**
 * A dry run of the route pass over the part's ends with `opts` per edge (rolled back): `{ok, edges: [route edge records]}`, or null when
 * the ends don't resolve or the pass throws.
 */
function dryRoute(K, p, pts, opts, grade) {
  const cp = K.checkpoint();
  try {
    const nodes = {};
    for (const e of pts) if (e.node) nodes[e.name] = e.node;
    const edges = pts.slice(1).map((e, k) => ({ id: `cl${K.order.indexOf(p)}d${k}`, from: pts[k].name, to: e.name, ...opts }));
    const ko = keepOutOf(K);
    const out = K.r.pass('route', { nodes, edges, maxGrade: grade, stage: K.stageOf('routes'), part: 'climb_dry', maxExpanded: K.env.budget.maxNodes, ...(ko.length ? { keepOut: ko } : {}), ...(K.env.standingHard?.length ? { hard: [...K.env.standingHard] } : {}) });
    const edgesOut = out.data.edges.map((e) => ({ ...e }));
    return { ok: edgesOut.every((e) => e.ok), edges: edgesOut };
  } catch {
    return null;
  } finally {
    K.rollback(cp);
  }
}

/** The ascent of a dry route (§3): the highest point of its surface minus its lowest, over every leg. */
export const ascentOf = (edges) => {
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) for (const q of e.path ?? []) { if (q[1] < lo) lo = q[1]; if (q[1] > hi) hi = q[1]; }
  return hi >= lo ? hi - lo : 0;
};

const wouldFitOf = (K, p, frag, edges, width) => ({ part: p.id, fragment: frag, geometry: { legs: edges.map((l) => ({ length: l.length, rise: l.rise, path: corners(l.path ?? []) })) }, cost: { cells: edges.reduce((n, l) => n + l.length * width, 0) } });

/** The face rule's land (the pre-region classes: the frozen volumes the caller gave, asked through needVolume; else the survey's). */
function landOf(K) {
  const st = stateOf(K);
  if (st.land) return st.land;
  const volumes = (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean);
  st.land = climbLand(K.r.survey, { volumes });
  return st.land;
}

/** Before routing: an answer that stops the part, or null to route it. */
export function resolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readClimbParams(part);
  const notes = [...pr.notes];
  const given = part.movers?.filter((m) => m === 'player' || m === VILLAGER);
  const ladder = p.kind === 'ladder';
  // S-7a-8: a ladder is player-only by kind; its own movers naming villagers answer MOVER (after NO_CLIMB)
  const movers = ladder ? ['player'] : inferMovers(kindOf(K, part.from), kindOf(K, part.to), given);
  const width = ladder ? 1 : part.width ?? pr.read.width ?? 2;
  const unsafe = part.ext?.[UNSAFE_EXT_7A] ?? {};
  const lamps = (part.lamps ?? pr.read.lamps) !== 'none';
  const o = { kind: p.kind, movers, width, notes, lamps, rails: part.rails ?? 'drops', retaining: part.retaining ?? 'plain', rest: part.rest ?? CLIMB.rest, top: part.top ?? 'gate', landing: part.landing ?? null, unsafe };
  st.parts.set(p.id, o);
  if (o.rails === 'none') notes.push('rails: none: no rail beside its drops (M8 warns of them)');
  if (ladder && o.top === 'open') notes.push('top: open: no gate over the ladder\'s top (M8 notes the open edge)');
  if (part.via?.length) {
    // (R26) via read leniently: the first leg; compile.mjs notes the rest
  }
  const grade = Math.max(1 / 64, Math.min(1, Math.round((K.tolOf(part, 'grade').max) * 64) / 64));
  // ---- the climbed check: the ends routed dry as a plain path
  const nc = (ascent, wf) => ({ class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'NO_CLIMB', message: `the ends rise ${ascent}: a ${p.kind} needs a climb of at least ${CLIMB.minAscent} (a plain path joins them)`, evidence: { ascent, need: CLIMB.minAscent } }], ...(wf ? { wouldFit: [wf] } : {}) });
  if (sameEnd(part.from, part.to) && !(part.via ?? []).length) return nc(0, null);
  const pts = endsOf(K, p);
  if (!pts) return null;
  const pathWidth = Math.min(5, part.width ?? 1);
  const dry = dryRoute(K, p, pts, { width: pathWidth, ...(given?.length ? { movers: given } : {}) }, grade);
  o.dryAscent = dry?.ok ? ascentOf(dry.edges) : null;
  const pathFit = dry?.ok ? wouldFitOf(K, p, fragmentOf(part, 'path', part.width === undefined ? {} : { width: pathWidth }), dry.edges, pathWidth) : null;
  if (dry?.ok && o.dryAscent < CLIMB.minAscent) return nc(o.dryAscent, pathFit);
  // ---- a ladder whose own movers name villagers: MOVER, with a stair where one fits alone, else the path
  if (ladder && (part.movers ?? []).includes(VILLAGER)) {
    const sd = dryRoute(K, p, pts, { width: 2, movers: ['player', VILLAGER], profile: 'stair', type: 'stair' }, grade);
    const stairOk = sd?.ok && sd.edges.some((e) => e.segments.some((g) => g.kind === 'stair'));
    const wf = stairOk ? wouldFitOf(K, p, fragmentOf(part, 'stair', { width: 2, movers: part.movers }), sd.edges, 2) : pathFit;
    return { class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'MOVER', message: 'a ladder is player-only (villagers don\'t climb ladders, S-7a-8): its movers name villager', evidence: { movers: part.movers, kind: 'ladder' } }], ...(wf ? { wouldFit: [wf] } : {}) };
  }
  // ---- a ladder's face rule, on its dry route (the main pass routes it alike; the emission re-checks)
  if (ladder) {
    const ld = dryRoute(K, p, pts, { width: 1, movers: ['player'], profile: 'ladder', type: 'ladder' }, grade);
    if (ld?.ok) {
      const land = landOf(K);
      for (const e of ld.edges) {
        try { climbCells(e, { ...o, roles: {} }, land, { taken: takenOf(K, null) }); } catch (err) {
          if (!/^ANCHOR:/.test(err.message)) throw err;
          return { class: 'refused', ...(notes.length ? { notes } : {}), reasons: [{ code: 'ANCHOR', message: err.message.replace(/^ANCHOR: /, ''), evidence: err.evidence ?? {} }] };
        }
      }
    }
  }
  return null;
}

/** The legs' route options. */
export function leg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return null;
  return { width: o.width, movers: o.movers, profile: p.kind, type: p.kind, ...(p.kind === 'switchback' && o.landing ? { hairpinLanding: o.landing } : {}), ...(treadOf(K) ? { stairMaterial: treadOf(K) } : {}) };
}

/** The tread role (N-CL-1: the path role's stairs where it has them, else the structure's: T2's): a role name, or null for T2's. */
function treadOf(K) {
  const role = K.ctx.connectors?.stair?.tread;
  const block = role ? K.r.roles?.[role] : null;
  return block && shapeOf(String(block).replace(/\[.*$/, ''), 'stairs') ? role : null;
}

export function passInput() { return null; }

/** A ladder leg the pass could not route whose ends rise more than 48: SPAN; anything else answers as the default. */
export function failAnswer(K, l, m) {
  if (l.conn.kind !== 'ladder') return null;
  const rise = Math.abs((l.to.at?.[1] ?? 0) - (l.from.at?.[1] ?? 0));
  if (rise <= PROFILES.ladder.ladderMax) return null;
  const o = stateOf(K).parts.get(l.conn.id);
  void m;
  return { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: 'SPAN', message: `leg ${l.k + 1}: the ends rise ${rise}; a ladder climbs at most ${PROFILES.ladder.ladderMax} (with rest landings)`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, rise, max: PROFILES.ladder.ladderMax } }] };
}

/** The legs' climbs: [{leg, rise, flights, hairpins, ladders: [{at, rungs, landings}]}]. */
function climbsOf(legs, rest) {
  return legs.map(({ meta }, i) => {
    const segs = meta?.segments ?? [];
    return { leg: i + 1, rise: ascentOf([meta ?? {}]), flights: segs.filter((g) => g.kind === 'stair').length, hairpins: segs.filter((g) => g.kind === 'landing').length,
      ladders: (meta?.ladderCols ?? []).map((lc) => { const rungs = lc.y1 - lc.y0 + 1; return { at: [lc.x, lc.y0, lc.z], rungs, landings: Math.floor((rungs - 1) / rest) }; }) };
  });
}

/** After routing: the part's answer fields. */
export function answer(K, p, legs) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return null;
  const climbs = climbsOf(legs, o.rest);
  const out = { geometry: { climbs, movers: o.movers } };
  const notes = [...o.notes];
  const climbed = p.kind === 'stair' ? climbs.some((c) => c.flights) : p.kind === 'switchback' ? climbs.some((c) => c.hairpins) : climbs.some((c) => c.ladders.length);
  if (!climbed) {
    const rise = Math.max(0, ...climbs.map((c) => c.rise));
    out.deviations = [{ what: 'climb', value: rise, kind: 'walk', rise }];
    out.class = 'adjusted';
    notes.push(`the land's grade needed no ${p.kind}: the route walks its rise of ${rise} within the grade`);
  }
  if (notes.length) out.notes = notes;
  return out;
}

/** Columns another writer holds: another routed connector's walk (its surface y), a lot and its apron (true); the fittings keep off them. */
function takenOf(K, self) {
  const cols = new Map();
  for (const x of K.routed ?? []) {
    if (!x.meta?.ok || x.meta.id === self) continue;
    for (const [k, y] of walkCols(x.meta)) if (!cols.has(k)) cols.set(k, y);
  }
  const lots = K.r.lots.map((l) => l.box);
  return (x, z) => (lots.some((b) => x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1) ? true : cols.get(`${x},${z}`) ?? false);
}

/** The links stage: each routed climb's fittings under a checkpoint; the graph edge's crossing; cost.bom. */
export function emit(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const stage = K.r.stageList.includes('links') ? 'links' : K.stageOf('routes');
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!CLIMB_KINDS.includes(p.kind) || !ok(p.id) || !x.meta?.ok || st.emitted.has(`${p.id}:${x.meta.id}`)) continue;
    st.emitted.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id);
    const cp = K.checkpoint();
    try {
      const idx = K.order.indexOf(p);
      const land = landOf(K);
      const res = emitClimbs(K.r, [x.meta], { opts: { [x.meta.id]: { kind: p.kind, rails: o.rails, retaining: o.retaining, rest: o.rest, top: o.top, lamps: o.lamps, ...(Object.keys(o.unsafe).length ? { unsafe: o.unsafe } : {}) } }, stage, part: `links_c${idx}`, land, taken: takenOf(K, x.meta.id), recPart: p.id });
      K.mark(p.id, K.addedSince(cp));
      const rec = res[0];
      const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
      if (ge && rec) {
        const c = climbsOf([{ meta: x.meta }], o.rest)[0];
        ge.type = p.kind;
        ge.crossing = p.kind === 'ladder' ? { type: 'ladder', rise: c.rise, landings: c.ladders.reduce((n, l) => n + l.landings, 0) }
          : p.kind === 'switchback' ? { type: 'switchback', rise: c.rise, hairpins: c.hairpins } : { type: 'stair', rise: c.rise, flights: c.flights };
      }
      // the bill: the fittings, plus the climb's treads and rungs (the route's own stair and ladder cells)
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const [item, n] of Object.entries(rec?.bom ?? {})) bom[item] = (bom[item] ?? 0) + n;
      for (const [item, n] of Object.entries(routeBom(K, x.meta))) bom[item] = (bom[item] ?? 0) + n;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
      // the answer's ladders gain their flights and rest landings (the emitter's)
      const a = K.answers.get(p.id);
      if (a?.geometry?.climbs && rec) for (const c of a.geometry.climbs) for (const l of c.ladders) { const d = rec.meta.ladders.find((q) => q.at[0] === l.at[0] && q.at[2] === l.at[2]); if (d) { l.landings = d.landings; l.top = d.top; } }
    } catch (e) {
      K.rollback(cp);
      const code = (/^([A-Z_]+):/.exec(e.message) ?? [])[1];
      K.ans(p, { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: code === 'ANCHOR' ? 'ANCHOR' : 'UNREACHABLE', message: `the ${p.kind}'s fittings could not be written: ${e.message.replace(/^[A-Z_]+: /, '')}`, evidence: { edge: x.meta.id, ...(e.evidence ?? {}) } }] });
    }
  }
}

/** The climb's treads and rungs, counted from the route edge (each tread column once: the stair block of T2's stair material). */
function routeBom(K, e) {
  const out = {};
  const add = (item, n) => { if (n > 0) out[item] = (out[item] ?? 0) + n; };
  let treads = 0;
  for (const g of e.segments ?? []) if (g.kind === 'stair' && !g.shared) treads += footprintOf(e.path.slice(g.from + 1, g.to + 1), e.width).length;
  // (T2's _stair: the material's stairs block where it has one, else the full block)
  const mat = String(K.r.roles?.[treadOf(K) ?? 'structure'] ?? 'minecraft:cobblestone').replace(/\[.*$/, '');
  const tread = shapeOf(mat, 'stairs') ?? mat;
  for (const [item, n] of Object.entries(bomOf(Array.from({ length: treads }, () => tread)))) add(item, n);
  // (the rungs are the fittings' own: climbGeom writes every one)
  return out;
}

export function bom(K, p) { return K.record?.bom?.[p.id] ?? null; }

/** §6's survival row: stairs and switchbacks a target per tile with paid cells (the walk's cut and its dirt path free); ladders paid. */
export function survival(K, p) {
  void K;
  return p.kind === 'ladder' ? { free: [], paid: ['ladder', 'landing', 'bracket', 'rail', 'gate'], path: 'targets; the rungs bottom up (each needs its face)' }
    : { free: ['cut', 'freeCell dirt path'], paid: ['tread', 'rail', 'retaining', 'lamp'], path: 'a target per tile with paid cells (as streets)' };
}
