// (7a K1b) Rope bridges and `connector.auto` in the plan compiler (docs/CONTRACT.md "Phase 7a slice K1" §3, §4, §7, §9): the hooks
// kit/lib/plan/compile.mjs calls for those kinds (K = the compiler's context, compile.mjs `k1Context`).
//   ropeResolve    before routing: params read leniently (every key named in the notes), movers inferred as T2 (S-K1-4), the width
//                  default (1 on a player-only edge, 2 on a villager edge), a self-loop (both ends one place) refused NO_GAP, a
//                  villager rope_bridge that is 1 wide or has no slab deck refused MOVER
//   ropeLeg        the legs' route options: spans ['rope'], spanOnce (a rope_bridge: exactly one), approach, span, width, movers
//   ropePassInput  a whole-claim template's carved ground for the routes (templateLand.mjs: the base; its ways as hard rects)
//   ropeFailAnswer a rope_bridge leg the route pass could not span: its typed refusal with evidence (NO_GAP gets a `path` wouldFit
//                  in emitRopes)
//   ropeAnswer     a routed connector's spans (n, rise, landings, over gap or water, depth) and notes
//   emitRopes      the links stage: each routed connector's spans written (deck, rails, posts, lamps) under a checkpoint each, its
//                  cost.bom; then the wouldFit dry runs
import { ROPE, emitRouteRopes, slabOf, deckY, profile } from './ropeGeom.mjs';
import { readParams } from './params.mjs';
import { footprintOf, inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { WHOLE_CLAIM } from '../plan/compile.mjs';
import { TEMPLATE_LANDS } from './templateLand.mjs';

/** The kinds this module compiles. */
export const ROPE_KINDS = Object.freeze(['rope_bridge', 'auto']);
/** A connector's test-only switches (its `ext`): `{wholeBlockDeck: true}` forces the whole-block profile (the broken variant). */
export const UNSAFE_EXT = 'architect_mc:unsafe';

const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };

/** An endpoint's lot kind (S-T2-1's inference): the region lot's village kind, else the plan lot's type, then role. */
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

/** The rope state of the compile (per part: movers, width, deck, notes). */
const stateOf = (K) => (K.rope ??= { parts: new Map(), would: [] });

/**
 * Before routing: an answer that stops the part (`{class, reasons, ...}`), or null to route it. `p`: the validated part.
 */
export function ropeResolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readParams(p.kind, part);
  const notes = [...pr.notes];
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const villager = movers.includes(VILLAGER);
  const width = part.width ?? (villager ? ROPE.villagerMinWidth : 1);
  // the deck: the bible's rope_bridge deck role (style.mjs's chain: floor, then path), its slab variant, else the whole-block profile
  const deckRole = K.ctx.connectors?.rope_bridge?.deck ?? (K.r.roles.floor ? 'floor' : 'path');
  const deckBlock = K.r.roles[deckRole] ?? null;
  const unsafe = part.ext?.[UNSAFE_EXT] ?? {};
  const slab = unsafe.wholeBlockDeck ? null : slabOf(deckBlock);
  const whole = !slab;
  const o = { movers, villager, width, deckRole, deckBlock, whole, notes, spans: true, approach: part.approach ?? ROPE.approach };
  st.parts.set(p.id, o);
  if (p.kind === 'rope_bridge') {
    // upside_down's chain bridges: both ends one place, nothing to span
    if (sameEnd(part.from, part.to) && !(part.via ?? []).length) return { class: 'refused', notes, reasons: [{ code: 'NO_GAP', message: 'both ends are one place: nothing to span', evidence: { from: part.from, to: part.to } }] };
    // S-K1-4: a villager rope bridge is at least 2 wide on a slab deck (a whole-block deck needs jumps on a narrow rail line)
    if (villager && (width < ROPE.villagerMinWidth || whole)) {
      return { class: 'refused', notes, reasons: [{ code: 'MOVER', message: width < ROPE.villagerMinWidth ? `a villager edge's rope bridge is at least ${ROPE.villagerMinWidth} wide (width ${width})` : `a villager edge's rope bridge needs a slab deck (${deckBlock ?? deckRole} has no slab variant: the whole-block profile is player-only)`,
        evidence: { movers, width, deck: deckBlock, slab: slab ?? null, minWidth: ROPE.villagerMinWidth } }] };
    }
  } else if (villager && (width < ROPE.villagerMinWidth || whole)) {
    // an auto connector on a villager edge never takes a span its villagers can't cross: it walks
    o.spans = false;
    notes.push(`rope spans off: a villager edge's span is at least ${ROPE.villagerMinWidth} wide on a slab deck (width ${width}${whole ? `, ${deckBlock ?? deckRole} has no slab variant` : ''})`);
  }
  return null;
}

/** A rope_bridge or auto connector's leg options for the route pass (spans, spanOnce, span, approach, width, movers). */
export function ropeLeg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  const part = p.part;
  return {
    width: o.width, movers: o.movers,
    ...(o.spans ? { spans: ['rope'], spanOnce: p.kind === 'rope_bridge', approach: o.approach, ...(part.span ? { span: { ...part.span } } : {}) } : {}),
  };
}

/**
 * The route pass's pass-level rope input, or null: a whole-claim template that carves its ground (rift_city's rift) gives the routes
 * its land (`base`: the carved surface minus the survey's ground) and its structures as hard rects (`hard`: its bridges, towers and
 * stairs, its rim rail), so a span finds the gap and a walk never crosses it. Only for a plan with a rope_bridge or auto part, so
 * every other plan's routes are T2's.
 */
export function ropePassInput(K) {
  if (!K.k1Parts.some((p) => ROPE_KINDS.includes(p.kind))) return null;
  if (K.rope?.land !== undefined) return K.rope.land;
  // the frozen volumes the caller gave (a lip's real classes: sand is LOOSE, not site-solid): asked for through needVolume, so
  // the IR records each one the anchors read (none in a plan check without volumes: the 2.5D survey's classes)
  const volumes = (K.ctx.volumes ?? []).map((v) => K.r.needVolume(v.box)).filter(Boolean);
  const whole = K.order.find((p) => p.family === 'zone' && K.res.get(p.id)?.whole && K.okClass(p.id));
  if (!whole) { stateOf(K).land = volumes.length ? { volumes } : null; return stateOf(K).land; }
  const name = whole.part.program.template;
  const mod = WHOLE_CLAIM.get(name)?.module;
  let land = null;
  if (mod && TEMPLATE_LANDS[name]) {
    const given = whole.part.program.params ?? {};
    const params = {};
    for (const [k, d] of Object.entries(mod.params ?? {})) params[k] = given[k] !== undefined ? given[k] : d.default;
    const l = TEMPLATE_LANDS[name](K.ctx.claim, K.ctx.survey, params);
    if (l) {
      // the template's own ways (bridges, towers, stairs) are obstacles too
      const ways = K.r.paths.filter((q) => q.box).map((q) => [q.box.minX, q.box.minZ, q.box.maxX, q.box.maxZ]);
      land = { base: l.base, hard: ways };
      stateOf(K).rails = l.rails ?? [];
    }
  }
  if (volumes.length) land = { ...(land ?? {}), volumes };
  stateOf(K).land = land;
  return land;
}

/** A rope_bridge leg that found no route: its typed refusal (the route pass's diagnosis), with the leg's ends. */
export function ropeFailAnswer(K, l, m) {
  const why = m?.rope ?? { code: 'UNREACHABLE', evidence: {} };
  const o = stateOf(K).parts.get(l.conn.id);
  const msg = {
    NO_GAP: 'nothing to span: no gap (ground more than 4 below the deck, or water) between the ends within the approach',
    SPAN: `the only spans that cross the gap are outside ${ROPE.spanMin}..${ROPE.spanMax} deck cells`,
    TOO_STEEP: `the landings differ by more than n / 8 (the deck's rise limit)`,
    HEADROOM: 'the deck\'s clear envelope (deck, rails and 2 cells over them) meets the land',
    ANCHOR: 'no site-solid (rock or soil) 2 deep under a landing or a post',
    UNREACHABLE: 'a span crosses the gap but its far side does not reach the end',
  }[why.code] ?? why.code;
  if (why.code === 'NO_GAP') stateOf(K).would.push(l.conn.id);
  return { class: 'refused', notes: o?.notes, reasons: [{ code: why.code, message: `leg ${l.k + 1}: ${msg}`, evidence: { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) } }] };
}

/** A span's crossing: over water or a gap, and its depth (the deepest column under the deck's centre line). */
function crossing(K, s) {
  const S = K.env.S, ys = profile(s.n, s.from[1], s.rise), base = K.rope?.land?.base ?? null;
  // the land the routes met: the survey's ground plus a template's carved base (rift_city's rift)
  const ground = (x, z) => {
    const g = S.groundAt(x, z);
    if (!base) return g;
    const i = x - base.minX, j = z - base.minZ;
    return i >= 0 && j >= 0 && i < base.width && j < base.depth ? g + base.values[i + j * base.width] : g;
  };
  let water = false, depth = 0;
  for (let t = 1; t <= s.n; t++) {
    const x = s.from[0] + s.dir[0] * t, z = s.from[2] + s.dir[1] * t;
    if (S.waterAt(x, z)) water = true;
    depth = Math.max(depth, deckY(ys[t]) - ground(x, z));
  }
  return { type: 'rope_bridge', over: water ? 'water' : 'gap', depth };
}

/** After routing, a routed rope_bridge or auto connector's answer fields to merge ({geometry, notes}), or null. */
export function ropeAnswer(K, p, legs) {
  const o = stateOf(K).parts.get(p.id);
  const spans = [];
  for (const { meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'rope') continue;
    const s = { n: g.n, rise: g.rise, dir: [...g.dir], from: [...meta.path[g.from]], to: [...meta.path[g.to]], width: meta.width };
    spans.push({ ...s, crossing: crossing(K, s), deck: o?.whole ? 'whole' : 'slab' });
  }
  const notes = [...(o?.notes ?? [])];
  if (p.kind === 'auto' && !spans.length && o?.spans) notes.push('no rope span: walking is cheaper (or nothing to span)');
  const g = K.geom.get(p.id) ?? {};
  K.geom.set(p.id, { ...g, spans });
  return { geometry: { ...(g.legs ? { legs: g.legs } : {}), spans, movers: o?.movers ?? null }, ...(notes.length ? { notes } : {}) };
}

/** The links stage: emit every routed edge's rope spans (deck, rails, posts, lamps) under a checkpoint each; the NO_GAP wouldFits. */
export function emitRopes(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const done = new Set();
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!ROPE_KINDS.includes(p.kind) || !ok(p.id) || !x.meta || done.has(`${p.id}:${x.meta.id}`)) continue;
    done.add(`${p.id}:${x.meta.id}`);
    if (!(x.meta.segments ?? []).some((g) => g.kind === 'rope')) continue;
    const o = st.parts.get(p.id);
    const cp = K.checkpoint();
    try {
      const idx = K.order.indexOf(p);
      const style = p.part.lamps === 'none' ? { light: null } : {};
      const recs = emitRouteRopes(K.r, { only: [x.meta.id], stage: K.stageOf('links'), part: `links_r${idx}`, prefix: `rope_r${idx}_`, style, ...(o?.whole ? { whole: true } : {}) });
      K.mark(p.id, K.addedSince(cp));
      // a rope_bridge connector's graph edge is typed (§8: type rope_bridge, its crossing)
      if (p.kind === 'rope_bridge') {
        const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
        const g = (x.meta.segments ?? []).find((q) => q.kind === 'rope');
        if (ge && g) { ge.type = 'rope_bridge'; ge.crossing = crossing(K, { n: g.n, rise: g.rise, dir: g.dir, from: x.meta.path[g.from] }); }
      }
      // its bill of materials (§7: planCheck.links.bom[part], which finish.mjs puts in the answer's cost)
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const r of recs) for (const [item, nn] of Object.entries(r.bom ?? {})) bom[item] = (bom[item] ?? 0) + nn;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
    } catch (e) {
      K.rollback(cp);
      const code = /SPAN/.test(e.message) ? 'SPAN' : /TOO_STEEP/.test(e.message) ? 'TOO_STEEP' : 'UNREACHABLE';
      K.ans(p, { class: 'refused', reasons: [{ code, message: `the rope span could not be written: ${e.message}`, evidence: { edge: x.meta.id } }] });
    }
  }
  openRails(K);
  wouldFits(K);
}

/**
 * Where a rope_bridge or auto route crosses a whole-claim template's surface rail (rift_city's rim rail round the rift), the rail
 * opens and the approach inside it is fenced: air over the route's footprint at the rail's cells (its post at the surface + 1, a
 * lantern at + 2), and the rail role on both sides of every walk cell inside the rail's ring (so the strip between the rail and the
 * rift stays closed off), in the links stage, as the connector's own cells. A plan without such a template has no rails.
 */
function openRails(K) {
  const rails = K.rope?.rails ?? [];
  if (!rails.length) return;
  const S = K.env.S;
  const inRail = (x, z) => rails.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
  const ring = { minX: Math.min(...rails.map((q) => q[0])), minZ: Math.min(...rails.map((q) => q[1])), maxX: Math.max(...rails.map((q) => q[2])), maxZ: Math.max(...rails.map((q) => q[3])) };
  const inside = (x, z) => x > ring.minX && x < ring.maxX && z > ring.minZ && z < ring.maxZ;
  const fence = K.r.material(K.r.roles.rail ? 'rail' : 'minecraft:oak_fence', 'rail opening');
  const done = new Set();
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!ROPE_KINDS.includes(p.kind) || !['fits', 'adjusted'].includes(K.answers.get(p.id)?.class) || !x.meta?.ok) continue;
    const open = [], walls = [];
    const own = new Set();
    for (const g of x.meta.segments ?? []) for (const [cx, cz] of footprintOf(x.meta.path.slice(g.from, g.to + 1), x.meta.width)) own.add(`${cx},${cz}`);
    // the rope posts stand on the rail lines at the landings
    for (const rr of K.r.meta.ropes ?? []) for (const q of rr.posts ?? []) own.add(`${q.x},${q.z}`);
    for (const g of x.meta.segments ?? []) {
      if (g.kind === 'rope') continue;
      const cells = x.meta.path.slice(g.from, g.to + 1);
      for (const [cx, cz] of footprintOf(cells, x.meta.width)) {
        const k = `${cx},${cz}`;
        if (done.has(k) || !inRail(cx, cz)) continue;
        done.add(k);
        const y = S.groundAt(cx, cz) + 1;
        open.push(cx, cz, y, y + 1, 0);
      }
      for (const [cx, cy, cz] of cells) {
        if (!inside(cx, cz) || inRail(cx, cz)) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let t = 1; t <= x.meta.width; t++) {
          const wx = cx + dx * t, wz = cz + dz * t, k = `${wx},${wz}`;
          if (own.has(k)) continue;
          if (done.has(`w${k}`) || !inside(wx, wz) || inRail(wx, wz)) break;
          done.add(`w${k}`);
          walls.push(wx, wz, cy + 1, cy + 1, 1);
          break;
        }
      }
    }
    if (!open.length && !walls.length) continue;
    const cp = K.checkpoint();
    try {
      const part = K.r.parts.find((q) => q.id === `links_r${K.order.indexOf(p)}`) ?? K.r.part(`links_r${K.order.indexOf(p)}`, { stage: K.stageOf('links'), set: 'path' });
      if (open.length) part.columns({ abs: 0 }, { abs: 0 }, open, [null, fence], { cond: 3 });
      if (walls.length) part.columns({ abs: 0 }, { abs: 0 }, walls, [null, fence], { cond: 0 });
      K.mark(p.id, K.addedSince(cp));
    } catch (e) { K.rollback(cp); K.notes.push(`rails: ${e.message}`); }
  }
}

/**
 * treetop's bridges (§9): a rope_bridge refused NO_GAP whose ends a plain `path` connects gets that path as its wouldFit (the part
 * written as a path, with the route's geometry from a dry run of the route pass, rolled back).
 */
function wouldFits(K) {
  const st = stateOf(K);
  for (const id of [...new Set(st.would)]) {
    const p = K.byId.get(id);
    const a = K.answers.get(id);
    if (!p || !a || a.class !== 'refused') continue;
    const part = p.part;
    const ends = [part.from, ...(part.via ?? []), part.to];
    const pts = [];
    let err = false;
    for (let k = 0; k < ends.length && !err; k++) {
      const other = ends[k === ends.length - 1 ? k - 1 : k + 1];
      const e = K.endpointNode(ends[k], other, p, k === 0 ? 'from' : k === ends.length - 1 ? 'to' : `via[${k - 1}]`);
      if (e.error) err = true; else pts.push(e);
    }
    if (err || pts.length < 2 || sameEnd(part.from, part.to)) continue;
    const cp = K.checkpoint();
    try {
      const nodes = {};
      for (const e of pts) if (e.node) nodes[e.name] = e.node;
      const width = Math.min(part.width ?? 1, 5);
      const edges = pts.slice(1).map((e, k) => ({ id: `wf${K.order.indexOf(p)}l${k}`, from: pts[k].name, to: e.name, width }));
      const ko = [...K.env.protectedAreas.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.regions.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ]), ...K.env.buildRects.map((q) => [q.rect.minX, q.rect.minZ, q.rect.maxX, q.rect.maxZ])];
      const out = K.r.pass('route', { nodes, edges, maxGrade: 0.25, stage: K.stageOf('routes'), part: 'wouldfit', maxExpanded: K.env.budget.maxNodes, ...(ko.length ? { keepOut: ko } : {}) });
      const legs = out.data.edges.map((e) => ({ ok: e.ok, length: e.length, rise: e.rise, path: corners(e.path ?? []) }));
      if (legs.every((l) => l.ok)) {
        const frag = {};
        for (const k of ['id', 'required', 'label', 'notes', 'ext', 'from', 'via', 'to', 'avoid', 'width', 'movers', 'lamps', 'style', 'tolerance']) if (part[k] !== undefined) frag[k] = part[k];
        frag.kind = 'path';
        a.wouldFit = [{ part: id, fragment: frag, geometry: { legs: legs.map((l) => ({ length: l.length, rise: l.rise, path: l.path })) }, cost: { cells: legs.reduce((n, l) => n + l.length * width, 0) } }];
      }
    } catch { /* no alternative */ }
    K.rollback(cp);
  }
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
