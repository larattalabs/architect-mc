// (7a RK) The compile hooks of connector.rock_stair (ROCK_KINDS; docs/CONTRACT.md "Phase 7a slice RK" §1, §3, §4, §6, §7; the foundation's
// §2 interface, K = the compiler's context). This module never imports compile.mjs, program.mjs or connectors/rope.mjs (K1's integration
// lesson: an import cycle left a kind list uninitialised).
//   resolve(K, p) -> stop | null            before routing: params read leniently (width read; every other key named in the notes),
//                                           movers inferred as T2 (S-T2-1; villagers walk stairs blocks, a 1-wide flight included),
//                                           R18's self-loop and ends rising under 2 refused NO_CLIMB, rise.min over rise.max SPAN
//   leg(K, p) -> legOptions                 spans ['rock_stair'], once 'rock_stair', approach, width, movers, t7.rock_stair
//   passInput(K) -> object | null           the pass-level `rockStair` input: each explicit part's corridor (§3: T3 §6's box, y from the
//                                           lower end's feet - 16 to the highest ground + 1; caps 4M cells an edge, 16M a plan, the
//                                           tunnels' asked cells counted first) asked through needVolume, the frozen volumes, the
//                                           keep-out classes, the plan bodies' hard cells (KC)
//   failAnswer(K, leg, meta) -> answer|null its typed refusal from the row's `fail`; `incomplete VOLUME` over a corridor not read
//   answer(K, p, legs) -> extra | null      geometry.rockStairs (rise, steps, landings, cover, crossing {type: rock_stair, rise, steps,
//                                           cover}), notes ("read N frozen volume(s)")
//   emit(K)                                 the links stage after the climbs: each routed flight written by rockStairGeom.rockStair under a
//                                           checkpoint (its lining in the routes stage), its graph edge's type and crossing, cost.bom,
//                                           its guard cells for the artifact's stale rule (K.record.guards, `connector: 'rock_stair'`)
//   bom(K, p) -> cost.bom | null            the links record's
//   survival(K, p) -> RS target spec        §6: the carve free and held; treads, lining, seal, portals and lamps paid; as T3b's tunnels
import { ROCK, flightLength, rockStair as rockStairPrimitive, rockStairGeom } from './rockStairGeom.mjs';
import { TUNNEL, corridorBox, tunnelLand } from './tunnelGeom.mjs';
import { inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../region/volume.mjs';
import { ROCK_KINDS, UNSAFE_EXT_7A } from './kinds7a.mjs';

const isInt = Number.isInteger;
const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };
const sameEnd = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const classOfVolume = (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)];

/** An endpoint's lot kind (S-T2-1's inference; repeated here so no import cycle forms). */
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

/** The rock stair state of the compile (per part: movers, width, ...; per explicit part its corridor's status). */
const stateOf = (K) => (K.rockStair ??= { parts: new Map(), corridors: new Map(), asked: 0, emitted: new Set() });

/** A rock stair's `params`, read leniently (S-K1-3): `width` (1..3) when the part has none; every other key noted. */
export function readRockStairParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const k of Object.keys(P).sort()) {
    const v = P[k];
    if (k === 'width' && part.width === undefined && isInt(v) && v >= ROCK.widthMin && v <= ROCK.widthMax) { read.width = v; continue; }
    notes.push(`params.${k} not read${k === 'material' ? ' (style is the bible\'s)' : k === 'width' ? ` (outside ${ROCK.widthMin}..${ROCK.widthMax}, or width given)` : ''}`);
  }
  return { read, notes };
}

/** The leg's two ends (the first leg: from to via[0], else to), resolved; null when either fails (routing answers it). */
function endsOf(K, p) {
  const part = p.part, toEnd = (part.via ?? []).length ? part.via[0] : part.to;
  const a = K.endpointNode(part.from, toEnd, p, 'from'), b = K.endpointNode(toEnd, part.from, p, 'to');
  return a.error || b.error || !a.at || !b.at ? null : { a: a.at, b: b.at };
}

/** Before routing: an answer that stops the part, or null to route it. */
export function resolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readRockStairParams(part);
  const notes = [...pr.notes];
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const width = part.width ?? pr.read.width ?? ROCK.width;
  const unsafe = part.ext?.[UNSAFE_EXT_7A] ?? null;
  const o = { movers, width, height: part.height ?? ROCK.height, landing: part.landing ?? ROCK.landing, rise: part.rise ?? null, lining: part.lining ?? 'exposed', portal: part.portal ?? 'arch', approach: part.approach ?? ROCK.approach, notes, unsafe };
  st.parts.set(p.id, o);
  const toEnd = (part.via ?? []).length ? part.via[0] : part.to;
  if (sameEnd(part.from, toEnd)) return { class: 'refused', notes, reasons: [{ code: 'NO_CLIMB', message: 'both ends are one place: nothing to climb (R18)', evidence: { from: part.from, to: toEnd, rise: 0, need: ROCK.riseMin } }] };
  if (o.rise && isInt(o.rise.min) && isInt(o.rise.max) && o.rise.min > o.rise.max) return { class: 'refused', notes, reasons: [{ code: 'SPAN', message: `rise.min ${o.rise.min} is over rise.max ${o.rise.max}`, evidence: { rise: o.rise } }] };
  // NO_CLIMB (§4): the ends rise less than 2 (a path walks it); not judged over an end the survey could not read (MISSING: the
  // corridor answers incomplete VOLUME, prepare and check again)
  const e = endsOf(K, p);
  const unread = e && [e.a, e.b].some((q) => K.env.S.missingAt(q[0], q[2]));
  if (e && !unread && Math.abs(e.b[1] - e.a[1]) < ROCK.riseMin) return { class: 'refused', notes, reasons: [{ code: 'NO_CLIMB', message: `the ends rise ${Math.abs(e.b[1] - e.a[1])}, under ${ROCK.riseMin}: nothing to climb (a path walks it)`, evidence: { rise: e.b[1] - e.a[1], need: ROCK.riseMin, from: e.a, to: e.b } }] };
  return null;
}

/** A rock stair leg's route options. */
export function leg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  return {
    width: o.width, movers: o.movers, spans: ['rock_stair'], once: 'rock_stair', approach: o.approach,
    t7: { rock_stair: { part: p.id, width: o.width, height: o.height, landing: o.landing, lining: o.lining, portal: o.portal, ...(o.rise ? { rise: { ...o.rise } } : {}), ...(o.unsafe ? { _unsafe: { ...o.unsafe } } : {}) } },
  };
}

/** The highest surveyed ground in a rect (MISSING columns skipped) and whether any column is MISSING. */
function rectGround(S, x0, z0, x1, z1) {
  let top = -32768, missing = 0;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (S.missingAt(x, z)) { missing++; continue; }
    top = Math.max(top, S.groundAt(x, z));
  }
  return { top, missing };
}

/**
 * The corridor of each explicit rock stair part (§3) and its status: `asked` (its volume asked; `volume` the decoded one when the plan
 * holds it), or why not: `missing` (MISSING survey columns), `capEdge` (over 4M cells), `capPlan` (the plan's asked total, the
 * tunnels' first, past 16M). In plan order, so the caps are deterministic.
 */
function corridors(K) {
  const st = stateOf(K);
  if (st.done) return st.corridors;
  st.done = true;
  const S = K.env.S, claim = K.ctx.claim;
  let total = K.tunnel?.asked ?? 0;
  for (const p of K.order) {
    if (p.family !== 'connector' || !ROCK_KINDS.includes(p.kind) || K.answers.has(p.id)) continue;
    const o = st.parts.get(p.id);
    const e = o ? endsOf(K, p) : null;
    if (!e) continue;
    const pad = o.approach + o.width + TUNNEL.corridorPad;
    const rx0 = Math.max(claim.minX, Math.min(e.a[0], e.b[0]) - pad), rz0 = Math.max(claim.minZ, Math.min(e.a[2], e.b[2]) - pad);
    const rx1 = Math.min(claim.maxX, Math.max(e.a[0], e.b[0]) + pad), rz1 = Math.min(claim.maxZ, Math.max(e.a[2], e.b[2]) + pad);
    const g = rectGround(S, rx0, rz0, rx1, rz1);
    const { box, cells } = corridorBox(e.a, e.b, { approach: o.approach, width: o.width, groundMax: () => g.top, minY: claim.minY ?? -64, maxY: claim.maxY ?? 319 });
    const c = { box, cells, from: [...e.a], to: [...e.b], status: null, volume: null };
    if (g.missing) c.status = 'missing';
    else if (cells > TUNNEL.edgeCells) c.status = 'capEdge';
    else if (total + cells > TUNNEL.planCells) c.status = 'capPlan';
    else { total += cells; c.status = 'asked'; c.volume = K.r.needVolume(box); }
    st.corridors.set(p.id, c);
  }
  st.asked = total;
  return st.corridors;
}

/** (6c KC) The plan's bodies' hard cells, [[x, y, z]]. */
function keptHard(K) {
  const out = [];
  for (const q of K.keep ?? []) if (q.kind === 'body') for (const k of q.hard.keys()) out.push(k.split(',').map(Number));
  return out;
}

/** The pass-level rock stair input, or null without a rock stair part. */
export function passInput(K) {
  const st = stateOf(K);
  if (st.input !== undefined) return st.input;
  if (!K.k1Parts.some((p) => ROCK_KINDS.includes(p.kind))) { st.input = null; return null; }
  corridors(K);
  const vols = [];
  for (const v of K.ctx.volumes ?? []) { const d = K.r.needVolume(v.box); if (d && !vols.includes(d)) vols.push(d); }
  for (const c of st.corridors.values()) if (c.volume && !vols.includes(c.volume)) vols.push(c.volume);
  const parts = {};
  for (const [id, c] of st.corridors) parts[id] = { status: c.status, volume: !!c.volume };
  const rect = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
  const classes = [...K.env.protectedAreas.map((a) => ({ rect: rect(a.rect), class: 'PROTECTED_AREA', id: a.id })), ...K.env.regions.map((a) => ({ rect: rect(a.rect), class: 'REGION', id: a.id })),
    ...K.env.buildRects.map((a) => ({ rect: rect(a.rect), class: 'BUILD', id: a.id }))];
  const kept = keptHard(K);
  st.input = { volumes: vols, parts, ...(classes.length ? { classes } : {}), ...(kept.length ? { kept } : {}) };
  return st.input;
}

/** The corridor's `incomplete VOLUME` answer (§3), or null when its volume was asked. */
function volumeAnswer(K, id, o) {
  const c = stateOf(K).corridors.get(id);
  if (!c || c.status === 'asked') return null;
  const cap = c.status === 'capEdge' ? { cap: 'edgeCells', limit: TUNNEL.edgeCells } : c.status === 'capPlan' ? { cap: 'planCells', limit: TUNNEL.planCells, asked: stateOf(K).asked } : null;
  const msg = cap ? `the rock stair's corridor is ${c.cells} cells, past the ${cap.cap === 'edgeCells' ? 'per-edge cap' : 'per-plan cap'} (${cap.limit})`
    : 'the rock stair\'s corridor is not loaded (MISSING survey columns): prepare (or check with load: "generate"), then check again';
  return { class: 'incomplete', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: 'VOLUME', message: msg, evidence: { corridor: c.box, cells: c.cells, ...(cap ?? { missing: true }) } }] };
}

const MESSAGES = {
  NO_CLIMB: `the ends rise less than ${ROCK.riseMin} (a path walks it)`,
  SPAN: `the only flights that land rise outside ${ROCK.riseMin}..${ROCK.riseMax} (or the part's rise): a route chains flights with walks`,
  ANCHOR: 'a tread would stand over air or deeper fill (a stair standing on fill is a built stair, connector.stair, not a rock stair)',
  WATER: `water, lava or ice (or a plan body) within ${ROCK.fluidBuffer} of the flight`,
  PROTECTED: 'the flight or its shell meets a protected column or cell (a protected area, a build, a lot, a player\'s or owner\'s cell, a tree over a cut, a route or wall over it)',
  UNREACHABLE: 'a flight fits but the walks at its ends do not reach the ends within the approach',
};

/** A leg the pass could not route: its typed refusal, with the leg's ends; null when it is not this module's. */
export function failAnswer(K, l, m) {
  if (!ROCK_KINDS.includes(l.conn.kind)) return null;
  const o = stateOf(K).parts.get(l.conn.id);
  const vol = volumeAnswer(K, l.conn.id, o);
  if (vol) return vol;
  const why = m?.t7?.rock_stair ?? (m?.failed === 'BUDGET' ? null : { code: 'UNREACHABLE', evidence: { failed: m?.failed ?? null } });
  if (!why) return null;
  const ev = { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) };
  if (why.code === 'VOLUME') {
    const c = stateOf(K).corridors.get(l.conn.id);
    return { class: 'incomplete', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: 'VOLUME', message: `leg ${l.k + 1}: the corridor's rock was not read (its chunks are not loaded or not generated): prepare (or check with load: "generate"), then check again`, evidence: { ...ev, ...(c ? { corridor: c.box, cells: c.cells } : {}) } }] };
  }
  return { class: 'refused', ...(o?.notes?.length ? { notes: o.notes } : {}), reasons: [{ code: why.code, message: `leg ${l.k + 1}: ${MESSAGES[why.code] ?? why.code}`, evidence: { ...ev, ...(why.code === 'WATER' && why.evidence?.kind === 'body' ? { kind: 'body' } : {}) } }] };
}

/** A land for re-checking and writing a routed flight: the survey, the plan's volumes, the K1 walls and the keep-out. */
function emitLand(K) {
  const st = stateOf(K);
  if (st.land) return st.land;
  const S = K.env.S;
  const rects = [...K.env.protectedAreas.map((a) => ({ r: a.rect, c: 'PROTECTED_AREA', id: a.id })), ...K.env.regions.map((a) => ({ r: a.rect, c: 'REGION', id: a.id })), ...K.env.buildRects.map((a) => ({ r: a.rect, c: 'BUILD', id: a.id }))];
  const wallCells = new Map();
  for (const W of K.walls ?? []) for (const c of W.cells ?? []) wallCells.set(`${c.x},${c.z}`, W);
  st.land = tunnelLand(S, {
    volumes: passInput(K)?.volumes ?? [], classOfVolume,
    blocked: (x, z) => { const q = rects.find((a) => x >= a.r.minX && x <= a.r.maxX && z >= a.r.minZ && z <= a.r.maxZ); return q ? { class: q.c, id: q.id } : null; },
    wallAt: (x, z) => { const W = wallCells.get(`${x},${z}`); return W ? { id: W.id, footing: S.groundAt(x, z) - 2 } : null; },
    kept: keptHard(K),
  });
  return st.land;
}

/** The flights of a routed connector's legs: [{rise, dir, from, to}] from the route's `rock_stair` segments. */
function flightsOf(legs) {
  const out = [];
  for (const { meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'rock_stair') continue;
    out.push({ rise: g.rise, steps: g.steps, landings: g.landings, dir: [...g.dir], from: [...meta.path[g.from]], to: [...meta.path[g.to]] });
  }
  return out;
}

const geomOpts = (o) => ({ width: o.width, height: o.height, landing: o.landing, lining: o.lining, portal: o.portal, ...(o.rise ? { rise: o.rise } : {}), _unsafe: o.unsafe ?? undefined });

/** A flight's crossing (the foundation's §5): {type: rock_stair, rise, steps, cover}: cover the least over its bore treads (null: all cut). */
function crossingOf(g, f) {
  const covers = g.ok ? g.cover.filter((c, i) => i >= 1 && g.bore[i]) : [];
  return { type: 'rock_stair', rise: f.rise, steps: f.steps, cover: covers.length ? Math.min(...covers) : null };
}

/** After routing: a rock stair connector's answer fields (geometry.rockStairs, notes). */
export function answer(K, p, legs) {
  if (!ROCK_KINDS.includes(p.kind)) return null;
  const o = stateOf(K).parts.get(p.id);
  const rockStairs = flightsOf(legs).map((f) => {
    const g = rockStairGeom(emitLand(K), f.from, f.dir, f.rise, geomOpts(o));
    return { from: f.from, to: f.to, rise: f.rise, steps: f.steps, landings: f.landings, dir: f.dir, width: o.width, height: o.height, crossing: crossingOf(g, f),
      ...(g.ok ? { carved: g.carved, lined: g.lined.length, bore: g.bore.filter(Boolean).length, cut: g.cuts.filter(Boolean).length } : {}) };
  });
  const notes = [...(o?.notes ?? [])];
  if (rockStairs.length) notes.push(`read ${(passInput(K)?.volumes ?? []).length} frozen volume(s) for its rock`);
  return { geometry: { rockStairs, movers: o?.movers ?? null }, ...(notes.length ? { notes } : {}) };
}

/** The links stage: write every routed rock stair's flights under a checkpoint each; types, crossings, bills and guards. */
export function emit(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!ROCK_KINDS.includes(p.kind) || !ok(p.id) || !x.meta || st.emitted.has(`${p.id}:${x.meta.id}`)) continue;
    const segs = (x.meta.segments ?? []).filter((g) => g.kind === 'rock_stair');
    if (!segs.length) continue;
    st.emitted.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id);
    const idx = K.order.indexOf(p);
    const cp = K.checkpoint();
    try {
      const land = emitLand(K);
      const recs = [];
      segs.forEach((g, si) => {
        const a = x.meta.path[g.from], b = x.meta.path[g.to];
        const vols = passInput(K)?.volumes ?? [];
        const vol = st.corridors.get(p.id)?.volume ?? vols.find((v) => v.box.minX <= Math.min(a[0], b[0]) && v.box.maxX >= Math.max(a[0], b[0]) && v.box.minZ <= Math.min(a[2], b[2]) && v.box.maxZ >= Math.max(a[2], b[2])) ?? null;
        const un = p.part.lamps === 'none' ? { ...(o.unsafe ?? {}), noLamps: true } : o.unsafe;
        const rec = rockStairPrimitive(K.r, a, b, {
          land, width: o.width, height: o.height, landing: o.landing, lining: o.lining, portal: o.portal, stage: K.stageOf('links'), liningStage: K.stageOf('routes'), part: `links_r${idx}`, id: `rock_stair_r${idx}_${x.meta.id}_${si}`.slice(0, 48), movers: o.movers ?? x.meta.movers,
          ...(vol ? { volume: { sha: vol.sha, box: [vol.box.minX, vol.box.minY, vol.box.minZ, vol.box.maxX, vol.box.maxY, vol.box.maxZ] } } : {}), ...(un ? { _unsafe: { ...un } } : {}),
        });
        recs.push(rec);
        // the guard cells (T3 §6's stale rule): those inside the volume the flight was checked against, named as a rock stair's
        if (vol) {
          const runs = [];
          for (let t = 0; t < rec.guard.length; t += 4) {
            const gx = rec.guard[t], gz = rec.guard[t + 1];
            if (gx < vol.box.minX || gx > vol.box.maxX || gz < vol.box.minZ || gz > vol.box.maxZ) continue;
            const y0 = Math.max(vol.box.minY, rec.guard[t + 2]), y1 = Math.min(vol.box.maxY, rec.guard[t + 3]);
            if (y0 <= y1) runs.push(gx, gz, y0, y1);
          }
          (K.record.guards ??= []).push({ part: p.id, connector: 'rock_stair', rockStair: rec.id, volume: { sha: vol.sha, box: [vol.box.minX, vol.box.minY, vol.box.minZ, vol.box.maxX, vol.box.maxY, vol.box.maxZ] }, runs });
        }
      });
      K.mark(p.id, K.addedSince(cp));
      const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
      const a = K.answers.get(p.id);
      recs.forEach((rec, t) => {
        const covers = rec.cover.filter((c, i) => rec.bore[i]);
        const cr = { type: 'rock_stair', rise: rec.rise, steps: rec.steps, cover: covers.length ? Math.min(...covers) : null };
        const ac = (a?.geometry?.rockStairs ?? [])[t];
        if (ac) ac.crossing = cr;
        if (ge && t === 0) { ge.type = 'rock_stair'; ge.crossing = cr; }
      });
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const rr of recs) for (const [item, nn] of Object.entries(rr.bom ?? {})) bom[item] = (bom[item] ?? 0) + nn;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
      (K.record.rockStairs ??= {})[p.id] = recs.map((rr) => ({ id: rr.id, steps: rr.steps, landings: rr.landings, carved: rr.carved, lined: rr.lined, written: rr.counts.written }));
    } catch (e) {
      K.rollback(cp);
      if (K.record.guards) K.record.guards = K.record.guards.filter((q) => q.part !== p.id);
      const code = e.rockStair?.code ?? 'UNREACHABLE';
      K.ans(p, { class: code === 'VOLUME' ? 'incomplete' : 'refused', reasons: [{ code, message: `the flight could not be written: ${e.message}`, evidence: { edge: x.meta.id, ...(e.rockStair?.evidence ?? {}) } }] });
    }
  }
}

/** The cost.bom of a part (the links record's, written at emit). */
export function bom(K, p) {
  return K.record?.bom?.[p.id] ?? null;
}

/** §6: rock stairs in survival, as T3b's tunnels: the carve free and held; the treads, lining, seal, portals and lamps paid. */
export function survival(K, p) {
  if (!ROCK_KINDS.includes(p.kind)) return null;
  return { free: ['carved'], paid: ['tread', 'lining', 'seal', 'portal', 'lamp'], path: 'targets', order: 'as tunnels: the part held, carved flight by flight behind its lining (RS §6.3)' };
}

/** (tests) The corridor statuses of a compile (§3). */
export function corridorStatus(K) {
  return stateOf(K).corridors;
}

export { flightLength };
