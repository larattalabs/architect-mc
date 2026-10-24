// (7a CW) The compile hooks of connector.catwalk (CATWALK_KINDS; docs/CONTRACT.md "Phase 7a slice CW" §1, §3, §5, §6, §7; the
// foundation's §2 interface, K = the compiler's context). This module never imports compile.mjs, program.mjs or connectors/rope.mjs (K1's
// integration lesson: an import cycle left a kind list uninitialised).
//   resolve(K, p) -> stop | null            before routing: params read leniently (width, length; every other key named in the notes),
//                                           movers inferred as T2 (S-T2-1), the width (2 on a villager edge, 1 player-only), R18's
//                                           self-loop refused NO_GAP, a villager catwalk under 2 wide refused MOVER; null routes it
//   leg(K, p) -> legOptions                 spans ['catwalk'], once 'catwalk', approach, width, movers, t7.catwalk {width, length}
//   passInput(K) -> object | null           the pass-level `catwalk` input: the caller's frozen volumes (needVolume, so the IR records
//                                           each one read) and the plan bodies' hard cells (KC's registry: OVERLAP {kind: body})
//   failAnswer(K, leg, meta) -> answer|null its typed refusal from the row's `fail` (NO_GAP gets a `path` wouldFit, re-checked alone)
//   answer(K, p, legs) -> extra | null      geometry.catwalks (n, side, width, brackets, from, to, crossing {type: catwalk, length,
//                                           brackets}), notes
//   emit(K)                                 the links stage after the rock stairs: each routed run written under a checkpoint (KC: no
//                                           cell on a body's hard set; a lamp in a watch cell skipped), its cost.bom, the graph edge's
//                                           type and crossing; then the wouldFits
//   bom(K, p) -> cost.bom | null            C26's bomFull over the emitted cells
//   survival(K, p) -> RS target spec        §6: nothing free; deck, brackets, struts, rails and lamps paid; targets, brackets before the
//                                           deck cells they carry (written bottom up)
import { CATWALK, catwalkRun } from './catwalkGeom.mjs';
import { footprintOf, inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { CATWALK_KINDS, UNSAFE_EXT_7A } from './kinds7a.mjs';
import { keptBy, watchedBy } from '../fluids/keep.mjs';

const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };
/** An endpoint's lot kind (S-T2-1's inference; K1b's reading in rope.mjs, repeated here so no import cycle forms). */
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
const isInt = Number.isInteger;
/** The catwalk state of the compile. */
const stateOf = (K) => (K.catwalk ??= { parts: new Map(), would: [], emitted: new Set() });

/** A catwalk's params, read leniently (S-K1-3): width (1..2) and length ({min, max} in 3..32) when no first-class member says otherwise. */
export function readCatwalkParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'width' && part.width === undefined && isInt(v) && v >= CATWALK.widthMin && v <= CATWALK.widthMax) { read.width = v; continue; }
    if (key === 'length' && part.length === undefined && v && typeof v === 'object' && !Array.isArray(v) && ['min', 'max'].every((k) => v[k] === undefined || (isInt(v[k]) && v[k] >= CATWALK.runMin && v[k] <= CATWALK.runMax))) { read.length = { ...v }; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : key === 'width' ? ` (outside ${CATWALK.widthMin}..${CATWALK.widthMax}, or width given)` : ''}`);
  }
  return { read, notes };
}

/** Before routing: an answer that stops the part, or null to route it. */
export function resolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readCatwalkParams(part);
  const notes = [...pr.notes];
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const villager = movers.includes(VILLAGER);
  const width = part.width ?? pr.read.width ?? (villager ? CATWALK.villagerMinWidth : 1);
  const length = part.length ?? pr.read.length ?? null;
  const unsafe = part.ext?.[UNSAFE_EXT_7A] ?? {};
  const o = { movers, villager, width, length, notes, approach: part.approach ?? CATWALK.approach, unsafe };
  st.parts.set(p.id, o);
  // R18: both ends one place: nothing to shelf
  if (sameEnd(part.from, part.to) && !(part.via ?? []).length) return { class: 'refused', notes, reasons: [{ code: 'NO_GAP', message: 'both ends are one place: nothing to shelf (R18)', evidence: { from: part.from, to: part.to } }] };
  if (length && isInt(length.min) && isInt(length.max) && length.min > length.max) return { class: 'refused', notes, reasons: [{ code: 'SPAN', message: `length.min ${length.min} is over length.max ${length.max}`, evidence: { length } }] };
  // a villager catwalk is at least 2 wide (S-T2-1)
  if (villager && width < CATWALK.villagerMinWidth) return { class: 'refused', notes, reasons: [{ code: 'MOVER', message: `a villager edge's catwalk is at least ${CATWALK.villagerMinWidth} wide (width ${width})`, evidence: { movers, width, minWidth: CATWALK.villagerMinWidth } }] };
  return null;
}

/** A catwalk leg's route options. */
export function leg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  return { width: o.width, movers: o.movers, spans: ['catwalk'], once: 'catwalk', approach: o.approach,
    t7: { catwalk: { width: o.width, ...(o.length ? { length: { ...o.length } } : {}) } } };
}

/** The pass-level catwalk input: the caller's frozen volumes and the plan bodies' hard cells; null without a catwalk part. */
export function passInput(K) {
  const st = stateOf(K);
  if (!K.k1Parts.some((p) => CATWALK_KINDS.includes(p.kind))) return null;
  if (st.input !== undefined) return st.input;
  const volumes = (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean);
  const kept = [];
  for (const q of K.keep ?? []) if (q.kind === 'body') for (const k of q.hard.keys()) { const [x, y, z] = k.split(',').map(Number); kept.push([x, y, z, q.body]); }
  st.input = volumes.length || kept.length ? { ...(volumes.length ? { volumes } : {}), ...(kept.length ? { kept } : {}) } : null;
  return st.input;
}

const MESSAGES = {
  NO_GAP: `nothing to shelf: no run along a face has a drop of ${CATWALK.drop} or more under its open side within the approach (a path walks it)`,
  ANCHOR: 'the face beside the deck is not site-solid (rock or soil) from the deck to 2 over it (a face of sand, gravel or air)',
  HEADROOM: 'the deck meets the land, or an overhang (or a trunk) stands less than 2 over the deck or its rail',
  SPAN: `the only runs along the face are outside ${CATWALK.runMin}..${CATWALK.runMax} deck cells (or the part's length)`,
  WATER: 'a run would stand over water (a catwalk is not a bridge: decks over water are not in scope)',
  PROTECTED: 'a run would write in keep-out, a protected area, a build, another region, a lot box or apron, or the claim margin',
  OVERLAP: "a run would write in a plan body's footprint (KC)",
  UNREACHABLE: 'a run along the face fits but the walks at its ends do not reach the ends within the approach',
};

/** A leg the pass could not route (m.failed === 'CATWALK'): its typed refusal, with the leg's ends; null when it is not this module's. */
export function failAnswer(K, l, m) {
  if (!CATWALK_KINDS.includes(l.conn.kind)) return null;
  const why = m?.t7?.catwalk ?? (m?.failed === 'BUDGET' ? null : { code: 'UNREACHABLE', evidence: { failed: m?.failed ?? null } });
  if (!why) return null;
  const st = stateOf(K);
  const o = st.parts.get(l.conn.id);
  if (why.code === 'NO_GAP') st.would.push({ id: l.conn.id, code: why.code, leg: l.k, evidence: why.evidence });
  const reason = { code: why.code, message: `leg ${l.k + 1}: ${MESSAGES[why.code] ?? why.code}`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.code === 'OVERLAP' ? { kind: 'body' } : {}), ...(why.evidence ?? {}) } };
  return { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [reason] };
}

/** A run's crossing (§7): {type: catwalk, length, brackets}. */
const crossingOf = (g) => ({ type: 'catwalk', length: g.n, brackets: g.brackets });

/** After routing: a catwalk connector's answer fields (geometry.catwalks, notes). */
export function answer(K, p, legs) {
  if (!CATWALK_KINDS.includes(p.kind)) return null;
  const o = stateOf(K).parts.get(p.id);
  const catwalks = [];
  for (const { meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'catwalk') continue;
    catwalks.push({ n: g.n, side: g.side, dir: [...g.dir], width: g.width, brackets: g.brackets, from: [...meta.path[g.from]], to: [...meta.path[g.to]], crossing: crossingOf(g) });
  }
  const out = { geometry: { catwalks } };
  if (o?.notes?.length) out.notes = [...o.notes];
  return out;
}

/** The links stage: emit every routed catwalk edge's run under a checkpoint each; types and crossings; the wouldFits. */
export function emit(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const stage = K.r.stageList.includes('links') ? 'links' : K.stageOf('routes');
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!CATWALK_KINDS.includes(p.kind) || !ok(p.id) || !x.meta || st.emitted.has(`${p.id}:${x.meta.id}`)) continue;
    if (!(x.meta.segments ?? []).some((g) => g.kind === 'catwalk')) continue;
    st.emitted.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id);
    const cp = K.checkpoint();
    try {
      const idx = K.order.indexOf(p);
      const style = p.part.lamps === 'none' ? { light: null } : {};
      const recs = [];
      x.meta.segments.forEach((g, si) => {
        if (g.kind !== 'catwalk') return;
        const a = x.meta.path[g.from], b = x.meta.path[g.to];
        // (KC, §5) never on a body's hard cells (the row avoided them; re-read here against the registry as it stands at emit); a lamp
        // in a watch cell skipped
        const store = K.keep ?? [];
        const kc = store.length ? { kept: (xx, yy, zz) => keptBy(store, xx, yy, zz, { watch: false }), lampOk: (xx, yy, zz) => !watchedBy(store, xx, yy, zz) } : {};
        const rec = catwalkRun(K.r, a, b, { ...style, ...kc, width: g.width, side: g.side, stage, part: `links_c${idx}`, check: g.check, id: `catwalk_c${idx}_${x.meta.id}_${si}`.slice(0, 48), movers: x.meta.movers, edge: x.meta.id, ...(o?.unsafe && Object.keys(o.unsafe).length ? { _unsafe: o.unsafe } : {}) });
        recs.push({ seg: si, rec });
      });
      K.mark(p.id, K.addedSince(cp));
      const a = K.answers.get(p.id);
      const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
      for (const { seg, rec } of recs) {
        const g = x.meta.segments[seg];
        const cr = crossingOf(g);
        const ac = (a?.geometry?.catwalks ?? []).find((q) => q.n === rec.n && q.to[0] === rec.to[0] && q.to[2] === rec.to[2]);
        if (ac) ac.crossing = cr;
        if (ge) { ge.type = 'catwalk'; ge.crossing = cr; }
      }
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const { rec } of recs) for (const [item, nn] of Object.entries(rec.bom ?? {})) bom[item] = (bom[item] ?? 0) + nn;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
    } catch (e) {
      K.rollback(cp);
      const code = (/^([A-Z_]+):/.exec(e.message) ?? [])[1];
      K.ans(p, { class: 'refused', reasons: [{ code: ['NO_GAP', 'ANCHOR', 'HEADROOM', 'SPAN', 'WATER', 'PROTECTED', 'OVERLAP'].includes(code) ? code : 'UNREACHABLE', message: `the catwalk could not be written: ${e.message}`, evidence: { edge: x.meta.id, ...(code === 'OVERLAP' ? { kind: 'body' } : {}) } }] });
    }
  }
  wouldFits(K);
}

/** The cost.bom of a part (the links record's, written at emit). */
export function bom(K, p) {
  return K.record?.bom?.[p.id] ?? null;
}

/** §6: catwalks in survival: nothing free; every cell paid; targets, brackets before the deck cells they carry (written bottom up). */
export function survival(K, p) {
  if (!CATWALK_KINDS.includes(p.kind)) return null;
  return { free: [], paid: ['deck', 'bracket', 'strut', 'rail', 'lamp'], path: 'targets', order: 'bottom-up: struts, brackets, beds and rails, then the deck' };
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

/** A part's routed members, rewritten as `kind` (the wouldFit fragment). */
function fragmentOf(part, kind, drop = []) {
  const frag = {};
  for (const k of ['id', 'required', 'label', 'notes', 'ext', 'from', 'via', 'to', 'avoid', 'width', 'movers', 'lamps', 'style', 'tolerance']) if (part[k] !== undefined && !drop.includes(k)) frag[k] = part[k];
  return { ...frag, kind };
}

/** NO_GAP's repair (§3): a plain `path` of the same ends when it routes alone (a dry run of the route pass, rolled back). */
function wouldFits(K) {
  const st = stateOf(K);
  const seen = new Set();
  for (const w of st.would) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const p = K.byId.get(w.id), a = K.answers.get(w.id);
    if (!p || !a || a.class !== 'refused' || !CATWALK_KINDS.includes(p.kind)) continue;
    const part = p.part, o = st.parts.get(w.id);
    const ends = [part.from, ...(part.via ?? []).slice(0, 1), ...(part.via?.length ? [] : [part.to])];
    const pts = [];
    let err = false;
    for (let k = 0; k < ends.length && !err; k++) {
      const other = ends[k === ends.length - 1 ? k - 1 : k + 1];
      const e = K.endpointNode(ends[k], other, p, k === 0 ? 'from' : k === ends.length - 1 ? 'to' : `via[${k - 1}]`);
      if (e.error) err = true; else pts.push(e);
    }
    if (err || pts.length < 2 || sameEnd(part.from, part.to)) continue;
    const width = o?.width ?? 2;
    const cp = K.checkpoint();
    let fit = null;
    try {
      const nodes = {};
      for (const e of pts) if (e.node) nodes[e.name] = e.node;
      const edges = pts.slice(1).map((e, k) => ({ id: `wf${K.order.indexOf(p)}l${k}`, from: pts[k].name, to: e.name, width, ...(o?.movers ? { movers: o.movers } : {}) }));
      const ko = [...K.env.protectedAreas.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.regions.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.buildRects.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ])];
      const out = K.r.pass('route', { nodes, edges, maxGrade: 0.25, stage: K.stageOf('routes'), part: 'wouldfit', maxExpanded: K.env.budget.maxNodes, ...(ko.length ? { keepOut: ko } : {}) });
      const legs = out.data.edges.map((e) => ({ ok: e.ok, length: e.length, rise: e.rise, path: corners(e.path ?? []) }));
      if (legs.every((l) => l.ok)) fit = { part: w.id, fragment: fragmentOf(part, 'path', ['approach']), geometry: { legs: legs.map((l) => ({ length: l.length, rise: l.rise, path: l.path })) }, cost: { cells: legs.reduce((n, l) => n + l.length * width, 0) } };
    } catch { /* no alternative */ }
    K.rollback(cp);
    if (fit) a.wouldFit = [fit];
  }
}

/** (for the tests) The footprint helper, re-exported so tests need not reach into the route pass. */
export { footprintOf };
