// (6c T3a) Bridges in the plan compiler (docs/CONTRACT.md "Phase 6c slice T3" §1, §3, §4, §8, §9; Steward's review S-T3-2, S-T3-3,
// S-T3-8): the hooks kit/lib/plan/compile.mjs calls for connector.bridge, for auto connectors' bridge move and for the street fallback
// (K = the compiler's context). This module never imports compile.mjs, program.mjs or connectors/rope.mjs (K1's integration lesson: an
// import cycle left a kind list uninitialised).
//   bridgeResolve(K, p) -> answer | null   before routing: params read leniently (every unread key named in the notes), movers inferred
//                                          as T2 (S-T2-1), the width (2 on a villager edge, 1 player-only), R18's self-loop refused
//                                          NO_GAP, a villager bridge under 2 wide refused MOVER; null routes it
//   bridgeLeg(K, p) -> {}                  a bridge leg's route options: spans ['bridge'], once 'bridge', approach, width, movers, and
//                                          t3.bridge {form, clearance, width, span}
//   bridgeAutoLeg(K, p) -> {}              an auto connector's: spans ['bridge'], t3.bridge {form: auto, clearance 2, width}; {} on a
//                                          villager edge under 2 wide (it walks, as K1b's rope)
//   bridgeFallback(K, l) -> {} | null      S-T3-2: a street, road or path leg whose every route crosses water is searched once more with
//                                          spans ['bridge'] (no once; t3.bridge.diagnose so a failure names a bridge code)
//   bridgePassInput(K) -> object | null    the pass-level `bridge` input ({volumes}: the caller's frozen volumes, K1b's anchor path)
//   bridgeFailAnswer(K, l, m) -> answer    a leg the pass could not span: its typed refusal (WATER with its kind, after H-b's wet
//                                          fallback: deep, flowing or lava; NO_GAP and WATER get wouldFits in emitBridges)
//   bridgeAnswer(K, p, legs) -> extra      geometry.bridges (n, rise, form, piers, landings, crossing {type: bridge, form, over, depth,
//                                          clearance, span, lands?}), notes; a street's fallback bridges make it adjusted with a
//                                          `crossing` deviation
//   emitBridges(K)                         the links stage after K1's walls, gates and ropes: each routed bridge span written under a
//                                          checkpoint, its cost.bom, the graph edge's type and crossing, `lands`; then the wouldFits
import { BRIDGE, deckChoice, emitRouteBridges } from './bridgeGeom.mjs';
import { footprintOf, inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { BRIDGE_KINDS, FALLBACK_KINDS, T3_UNSAFE_EXT } from './t3kinds.mjs';

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
/** The bridge state of the compile. */
const stateOf = (K) => (K.bridge ??= { parts: new Map(), would: [], fallback: new Map(), emitted: new Set() });

/** A bridge's params, read leniently (R18): width (1..5) and form (auto | beam | arch) when no first-class member says otherwise. */
export function readBridgeParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'width' && part.width === undefined && isInt(v) && v >= BRIDGE.widthMin && v <= BRIDGE.widthMax) { read.width = v; continue; }
    if (key === 'form' && part.form === undefined && ['auto', 'beam', 'arch'].includes(v)) { read.form = v; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : key === 'width' ? ` (outside ${BRIDGE.widthMin}..${BRIDGE.widthMax}, or width given)` : ''}`);
  }
  return { read, notes };
}

/** Before routing: an answer that stops the part, or null to route it. */
export function bridgeResolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readBridgeParams(part);
  const notes = [...pr.notes];
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const villager = movers.includes(VILLAGER);
  const width = part.width ?? pr.read.width ?? (villager ? BRIDGE.villagerMinWidth : 1);
  const form = part.form ?? pr.read.form ?? 'auto';
  const clearance = part.clearance ?? BRIDGE.clearance;
  const unsafe = part.ext?.[T3_UNSAFE_EXT] ?? {};
  const o = { movers, villager, width, form, clearance, notes, approach: part.approach ?? BRIDGE.approach, span: part.span ?? null, unsafe, clearanceGiven: part.clearance !== undefined };
  st.parts.set(p.id, o);
  // R18: both ends one place (end_city_ruins' dwelling bridges): nothing to span
  if (sameEnd(part.from, part.to) && !(part.via ?? []).length) return { class: 'refused', notes, reasons: [{ code: 'NO_GAP', message: 'both ends are one place: nothing to span (R18)', evidence: { from: part.from, to: part.to } }] };
  // a villager bridge is at least 2 wide (villagerMinWidth, as rope)
  if (villager && width < BRIDGE.villagerMinWidth) return { class: 'refused', notes, reasons: [{ code: 'MOVER', message: `a villager edge's bridge is at least ${BRIDGE.villagerMinWidth} wide (width ${width})`, evidence: { movers, width, minWidth: BRIDGE.villagerMinWidth } }] };
  return null;
}

/** A bridge leg's route options. */
export function bridgeLeg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  return { width: o.width, movers: o.movers, spans: ['bridge'], once: 'bridge', approach: o.approach,
    t3: { bridge: { form: o.form, clearance: o.clearance, width: o.width, ...(o.span ? { span: { ...o.span } } : {}), ...(Object.keys(o.unsafe).length ? { _unsafe: { ...o.unsafe } } : {}) } } };
}

/** An auto connector's bridge options (its width and movers as K1b infers them). */
export function bridgeAutoLeg(K, p) {
  const part = p.part;
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const width = part.width ?? (movers.includes(VILLAGER) ? BRIDGE.villagerMinWidth : 1);
  stateOf(K).parts.set(p.id, { movers, villager: movers.includes(VILLAGER), width, form: 'auto', clearance: BRIDGE.clearance, notes: [], auto: true });
  if (movers.includes(VILLAGER) && width < BRIDGE.villagerMinWidth) return {};
  return { spans: ['bridge'], t3: { bridge: { form: 'auto', clearance: BRIDGE.clearance, width } } };
}

/** S-T3-2: a street, road or path leg that failed ROUTE_WATER: the options to search it once more with bridges. */
export function bridgeFallback(K, l) {
  if (!FALLBACK_KINDS.includes(l.conn.kind)) return null;
  const part = l.conn.part;
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  // the deck is the walk's width, at least 2 on a villager edge (§3: 2 for a path on a villager edge)
  const width = Math.min(BRIDGE.widthMax, movers.includes(VILLAGER) ? Math.max(l.width, BRIDGE.villagerMinWidth) : l.width);
  stateOf(K).fallback.set(`${l.conn.id}:${l.k}`, { width, movers });
  return { spans: ['bridge'], t3: { bridge: { form: 'auto', clearance: BRIDGE.clearance, width, diagnose: true } } };
}

/** The pass-level bridge input: the caller's frozen volumes (asked for through needVolume, so the IR records each one read). */
export function bridgePassInput(K) {
  const st = stateOf(K);
  const any = K.k1Parts.some((p) => BRIDGE_KINDS.includes(p.kind) || p.kind === 'auto') || st.fallback.size > 0;
  if (!any) return null;
  if (st.input !== undefined && st.inputFallback === st.fallback.size) return st.input;
  const volumes = (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean);
  st.input = volumes.length ? { volumes } : null;
  st.inputFallback = st.fallback.size;
  return st.input;
}

const MESSAGES = {
  NO_GAP: 'nothing to span: no gap (ground more than 4 below the deck, a narrow drop of 2, or water) between the ends within the approach',
  SPAN: `the only spans that cross the gap are outside ${BRIDGE.spanMin}..${BRIDGE.spanMax} deck cells (an arch: ${BRIDGE.archMin}..${BRIDGE.archMax})`,
  TOO_STEEP: 'the landings differ by more than max(1, n / 8) (the deck\'s rise limit)',
  HEADROOM: 'the deck meets the land, or the clearance over the water can\'t be met',
  ANCHOR: 'no site-solid (rock or soil) 2 deep under a landing, an abutment or a pier, or a pier over 24 tall',
  WATER: 'a pier is needed in water the wet fallback can\'t stand one in (deeper than waterDepth, flowing water, or lava)',
  UNREACHABLE: 'a span crosses the gap but its far side does not reach the end',
};

/** A leg the pass could not span (m.failed === 'BRIDGE'): its typed refusal, with the leg's ends. */
export function bridgeFailAnswer(K, l, m) {
  const why = m?.bridge ?? { code: 'UNREACHABLE', evidence: {} };
  const st = stateOf(K);
  const o = st.parts.get(l.conn.id);
  if (why.code === 'NO_GAP' || why.code === 'WATER' || (why.code === 'SPAN' && o?.form === 'arch')) st.would.push({ id: l.conn.id, code: why.code, leg: l.k, evidence: why.evidence });
  // ((6c H-b) the wet fallback's second plan found its crossing only over water it did not read: incomplete VOLUME)
  if (why.code === 'WATER' && why.evidence?.kind === 'unread') return { class: 'incomplete', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: 'VOLUME', message: `leg ${l.k + 1}: the water under the crossing's wet piers was not read: prepare (or check with load: "generate"), then check again`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) } }] };
  const reason = { code: why.code, message: `leg ${l.k + 1}: ${MESSAGES[why.code] ?? why.code}`, ...(why.until ? { until: why.until } : {}), evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) } };
  return { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [reason] };
}

/** A span's crossing (S-T3-1, S-T3-8): {type: bridge, form, over, depth, clearance, span, lands?}. */
const crossingOf = (g, lands) => ({ type: 'bridge', form: g.form, over: g.over, depth: g.depth, clearance: g.over === 'water' ? g.clearance : 0, span: g.n, ...(lands ? { lands } : {}) });

/** After routing: a routed connector's bridge answer fields (merged after K1b's), or null when it took no bridge and asked for none. */
export function bridgeAnswer(K, p, legs) {
  const st = stateOf(K);
  const o = st.parts.get(p.id);
  const bridges = [];
  let fallback = false;
  for (const { leg, meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'bridge') continue;
    if (leg?.fallback) fallback = true;
    // ((6c H-b) a span with wet piers: their cells, and each wet pier's index and cells: piers[].wet)
    const wet = g.wet ? { wet: { cells: g.wet.cells, waterDepth: g.wet.waterDepth, piers: (g.check?.piers ?? []).filter((q) => q.wet).map((q) => ({ i: q.i, wet: q.wet })) } } : {};
    bridges.push({ n: g.n, rise: g.rise, dir: [...g.dir], form: g.form, piers: g.piers, width: g.width, from: [...meta.path[g.from]], to: [...meta.path[g.to]], crossing: crossingOf(g), ...wet });
  }
  const notes = [...(BRIDGE_KINDS.includes(p.kind) ? o?.notes ?? [] : [])];
  if (BRIDGE_KINDS.includes(p.kind) && o?.clearanceGiven && bridges.length && bridges.every((b) => b.crossing.over !== 'water')) notes.push('clearance not read: the span is dry (R20)');
  if (p.kind === 'auto' && !bridges.length) return null;
  if (!bridges.length && !BRIDGE_KINDS.includes(p.kind)) return null;
  const out = { geometry: { bridges } };
  // ((6c H-b) a crossing on wet piers says so)
  const wetN = bridges.reduce((t, b) => t + (b.wet?.cells ?? 0), 0);
  if (wetN) notes.push(`wet piers: ${wetN} cell(s) stand in natural water (the wet fallback: no dry crossing fit)`);
  if (notes.length) out.notes = notes;
  // S-T3-2: a street, road or path that took the fallback is adjusted: it gained bridges it did not ask for
  if (fallback && FALLBACK_KINDS.includes(p.kind)) {
    out.deviations = [{ what: 'crossing', kind: 'crossing', value: bridges.length, bridges: bridges.map((b) => ({ form: b.form, span: b.n, over: b.crossing.over, from: b.from, to: b.to })) }];
    const a = K.answers.get(p.id);
    if (!a || a.class === 'fits' || a.class === undefined) out.class = 'adjusted';
    out.notes = [...(out.notes ?? []), `every route crosses water: crossed on ${bridges.length} bridge(s) (the street fallback, S-T3-2)`];
  }
  return out;
}

/**
 * The gate (K1) a bridge lands at: the route's segment just before or after the span is a gate move (it ends on the walk cell outside
 * the wall, where the span starts), and the gate is the one whose opening that move's cells pass through.
 */
function landsAt(K, e, si) {
  for (const sj of [si - 1, si + 1]) {
    const g = e.segments[sj];
    if (!g || g.kind !== 'gate') continue;
    const cells = new Set(e.path.slice(g.from, g.to + 1).map((q) => `${q[0]},${q[2]}`));
    for (const W of K.walls ?? []) for (const gate of W.gates ?? []) if ((gate.cells ?? []).some(([x, z]) => cells.has(`${x},${z}`))) return gate.id;
  }
  return null;
}

/** The links stage: emit every routed edge's bridge spans under a checkpoint each; types and crossings; the wouldFits. */
export function emitBridges(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const stage = K.r.stageList.includes('links') ? 'links' : K.stageOf('routes');
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!ok(p.id) || !x.meta || st.emitted.has(`${p.id}:${x.meta.id}`)) continue;
    if (!(x.meta.segments ?? []).some((g) => g.kind === 'bridge')) continue;
    st.emitted.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id);
    const cp = K.checkpoint();
    try {
      const idx = K.order.indexOf(p);
      const style = p.part.lamps === 'none' ? { light: null } : {};
      const lands = (e, si) => landsAt(K, e, si);
      const recs = emitRouteBridges(K.r, { only: [x.meta.id], stage, part: `links_b${idx}`, prefix: `bridge_b${idx}_`, style, lands, ...(o?.unsafe && Object.keys(o.unsafe).length ? { _unsafe: o.unsafe } : {}) });
      K.mark(p.id, K.addedSince(cp));
      // the answer's crossings gain `lands`; the graph edge: a bridge connector's is typed bridge with its crossing (§8), an auto or a
      // fallback street's carries the crossing on its bridged segments
      const a = K.answers.get(p.id);
      const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
      for (const rec of recs) {
        const g = x.meta.segments[rec.seg];
        const cr = crossingOf(g, rec.lands);
        const ab = (a?.geometry?.bridges ?? []).find((b) => b.from[0] === rec.from[0] && b.from[2] === rec.from[2] && b.n === rec.n);
        if (ab) ab.crossing = cr;
        if (ge && BRIDGE_KINDS.includes(p.kind)) { ge.type = 'bridge'; ge.crossing = cr; }
        else if (ge?.segments?.[rec.seg]) ge.segments[rec.seg].crossing = cr;
      }
      // ((6c H-b, §10) each wet pier set's columns, over the frozen volume it was planned on: the approval guards)
      for (const rec of recs) if (rec.wet?.volume) (K.record.guards ??= []).push({ part: p.id, body: rec.wet.record, kind: 'wet', fluids: true, volume: rec.wet.volume, runs: ((K.r.meta.wet ?? []).find((w) => w.id === rec.wet.record)?.columns ?? []).flat() });
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const r of recs) for (const [item, nn] of Object.entries(r.bom ?? {})) bom[item] = (bom[item] ?? 0) + nn;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
    } catch (e) {
      K.rollback(cp);
      const code = (/^([A-Z_]+):/.exec(e.message) ?? [])[1];
      // ((6c H-b) wet piers over water not read yet: incomplete VOLUME, the volume asked; the two-plan flow plans again with it)
      if (code === 'VOLUME') K.ans(p, { class: 'incomplete', reasons: [{ code: 'VOLUME', message: `the water under the bridge's wet piers was not read: ${e.message.replace(/^VOLUME: /, '')}; prepare (or check with load: "generate"), then check again`, evidence: { edge: x.meta.id } }] });
      else K.ans(p, { class: 'refused', reasons: [{ code: ['NO_GAP', 'SPAN', 'TOO_STEEP', 'HEADROOM', 'ANCHOR', 'WATER'].includes(code) ? code : 'UNREACHABLE', message: `the bridge span could not be written: ${e.message}`, evidence: { edge: x.meta.id } }] });
    }
  }
  wouldFits(K);
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

/** A part's routed members, rewritten as `kind` with `extra` (the wouldFit fragment). */
function fragmentOf(part, kind, extra = {}, drop = []) {
  const frag = {};
  for (const k of ['id', 'required', 'label', 'notes', 'ext', 'from', 'via', 'to', 'avoid', 'width', 'movers', 'lamps', 'style', 'tolerance', 'approach', 'form', 'clearance', 'span']) if (part[k] !== undefined && !drop.includes(k)) frag[k] = part[k];
  return { ...frag, kind, ...extra };
}

/**
 * The repairs (§3, §9, S-T3-3): a bridge refused WATER (a pier in water the wet fallback can't stand: deep, flowing or lava) gets the arch when its span fits, else a rope_bridge of
 * the same ends when that fits alone; an arch refused SPAN gets the beam, else a rope; NO_GAP gets a plain `path` when one routes. Each is a dry run of the route pass (rolled back);
 * the first that routes is the part's `wouldFit` (its fragment, the legs' geometry, the cost).
 */
function wouldFits(K) {
  const st = stateOf(K);
  const seen = new Set();
  for (const w of st.would) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const p = K.byId.get(w.id), a = K.answers.get(w.id);
    if (!p || !a || a.class !== 'refused' || !BRIDGE_KINDS.includes(p.kind)) continue;
    const part = p.part, o = st.parts.get(w.id);
    const ends = [part.from, ...(part.via ?? []), part.to];
    const pts = [];
    let err = false;
    for (let k = 0; k < ends.length && !err; k++) {
      const other = ends[k === ends.length - 1 ? k - 1 : k + 1];
      const e = K.endpointNode(ends[k], other, p, k === 0 ? 'from' : k === ends.length - 1 ? 'to' : `via[${k - 1}]`);
      if (e.error) err = true; else pts.push(e);
    }
    if (err || pts.length < 2 || sameEnd(part.from, part.to)) continue;
    const width = o?.width ?? 2;
    const asForm = (form) => ({ frag: fragmentOf(part, 'bridge', { form }), opts: { spans: ['bridge'], once: 'bridge', approach: o?.approach ?? BRIDGE.approach, t3: { bridge: { form, clearance: o?.clearance ?? BRIDGE.clearance, width } } } });
    const asRope = { frag: fragmentOf(part, 'rope_bridge', width > 3 ? { width: 3 } : {}, ['form', 'clearance', 'span']), opts: { spans: ['rope'], spanOnce: true, approach: o?.approach ?? BRIDGE.approach, width: Math.min(3, width) } };
    // WATER: the arch (unless it was the arch), else a rope; an arch's SPAN: the beam, else a rope; NO_GAP: a plain path
    const cands = w.code === 'WATER' ? [...(o?.form !== 'arch' ? [asForm('arch')] : []), asRope]
      : w.code === 'SPAN' ? [asForm('beam'), asRope]
        : [{ frag: fragmentOf(part, 'path', {}, ['form', 'clearance', 'span', 'approach']), opts: {} }];
    for (const c of cands) {
      const cp = K.checkpoint();
      let fit = null;
      try {
        const nodes = {};
        for (const e of pts) if (e.node) nodes[e.name] = e.node;
        const edges = pts.slice(1).map((e, k) => ({ id: `wf${K.order.indexOf(p)}l${k}`, from: pts[k].name, to: e.name, width: c.opts.width ?? width, ...(o?.movers ? { movers: o.movers } : {}), ...c.opts }));
        const ko = [...K.env.protectedAreas.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.regions.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.buildRects.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ])];
        const input = bridgePassInput(K);
        const out = K.r.pass('route', { nodes, edges, maxGrade: 0.25, stage: K.stageOf('routes'), part: 'wouldfit', maxExpanded: K.env.budget.maxNodes, ...(ko.length ? { keepOut: ko } : {}), ...(input ? { bridge: input } : {}), ...(K.rope?.land ? { rope: K.rope.land } : {}) });
        const legs = out.data.edges.map((e) => ({ ok: e.ok, length: e.length, rise: e.rise, path: corners(e.path ?? []) }));
        if (legs.every((l) => l.ok)) fit = { part: w.id, fragment: c.frag, geometry: { legs: legs.map((l) => ({ length: l.length, rise: l.rise, path: l.path })) }, cost: { cells: legs.reduce((n, l) => n + l.length * width, 0) } };
      } catch { /* no alternative */ }
      K.rollback(cp);
      if (fit) { a.wouldFit = [fit]; break; }
    }
  }
}

/** (for the tests) The footprint helper, re-exported so tests need not reach into the route pass. */
export { footprintOf, deckChoice };
