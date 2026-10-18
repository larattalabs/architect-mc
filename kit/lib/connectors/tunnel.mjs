// (6c T3b) Tunnels in the plan compiler (docs/CONTRACT.md "Phase 6c slice T3" §3, §4, §6, §8, §9): the hooks kit/lib/plan/compile.mjs
// calls for connector.tunnel (K = the compiler's context). This file imports neither compile.mjs nor program.mjs (K1's cycle).
//   tunnelResolve(K, p) -> answer | null   before routing: params read leniently (width read, every other key noted), movers inferred
//                                          as T2 (S-K1-4; a tunnel carries villagers at any width), R18's self-loop refused NO_GAP,
//                                          the width (3 on a villager edge, 2 player-only) and height (3); null routes it
//   tunnelLeg(K, p) -> {}                  a tunnel leg's route options (spans ['tunnel'], once 'tunnel', approach, width, movers, t3)
//   tunnelAutoLeg(K, p) -> {}              an auto connector's tunnel options: only when the plan holds frozen volumes (an explicit
//                                          tunnel's corridor, or the caller's), silently; {} otherwise, so an auto plan without them
//                                          plans as on v0.35.0
//   tunnelPassInput(K) -> object | null    the route pass's `tunnel` input: the frozen volumes (decoded, each recorded in the IR through
//                                          needVolume), after asking each explicit tunnel's corridor (§6: when the survey shows a hill
//                                          in it, under 4M cells per edge and 16M per plan; MISSING survey columns ask nothing)
//   tunnelFailAnswer(K, l, m) -> answer    a tunnel leg the pass could not bore: `unsupported {tunnel.under, until 7b}` for flat ground
//                                          (S-T3-4), `incomplete VOLUME` past the caps or over a corridor not read, else refused with the
//                                          diagnosis's code and evidence
//   tunnelAnswer(K, p, legs) -> extra|null a routed connector's bores (geometry.tunnels, each with its crossing) and notes; null for
//                                          an auto connector that bored nothing (its answer as before)
//   emitTunnels(K)                         the links stage, after the bridges: each bore written by `tunnel` (tunnelGeom.mjs) under a
//                                          checkpoint, its graph edge typed `tunnel` with its crossing, its cost.bom, and its guard cells
//                                          for the artifact's stale rule (K.record.guards)
import { TUNNEL, corridorBox, tunnel as tunnelPrimitive, tunnelGeom, tunnelLand } from './tunnelGeom.mjs';
import { inferMovers, VILLAGER } from '../region/passes/route.mjs';
import { zoneLots } from '../plan/schema.mjs';
import { canonicalJson } from '../region/pack.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../region/volume.mjs';

/** A connector's test-only switches (its `ext`): `{cover, fluidBuffer, noLining, noLamps, ignorePostern}` (the broken variants). */
export const UNSAFE_EXT = 'architect_mc:unsafe';

const isInt = Number.isInteger;
const lotKind = (l) => { const v = l?.ext?.['architect_mc:village']; return v?.villager ?? v?.type ?? v?.role ?? null; };
const sameEnd = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const classOfVolume = (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)];

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

/** The tunnel state of the compile (per part: movers, width, height, notes; per explicit part its corridor's status). */
const stateOf = (K) => (K.tunnel ??= { parts: new Map(), corridors: new Map(), asked: 0 });

/** §1: a tunnel's `params`, read leniently (S-K1-3): `width` (an integer 1..5) when the part has none; every other key noted. */
export function readTunnelParams(part) {
  const P = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const read = {}, notes = [];
  for (const key of Object.keys(P).sort()) {
    const v = P[key];
    if (key === 'width' && part.width === undefined && isInt(v) && v >= TUNNEL.widthMin && v <= TUNNEL.widthMax) { read.width = v; continue; }
    notes.push(`params.${key} not read${key === 'material' ? ' (style is the bible\'s)' : key === 'width' ? ` (outside ${TUNNEL.widthMin}..${TUNNEL.widthMax})` : ''}`);
  }
  return { read, notes };
}

/** Before routing: an answer that stops the part (`{class, reasons, ...}`), or null to route it. `p`: the validated part. */
export function tunnelResolve(K, p) {
  const st = stateOf(K), part = p.part;
  const pr = readTunnelParams(part);
  const notes = [...pr.notes];
  const movers = inferMovers(kindOf(K, part.from), kindOf(K, part.to), part.movers?.filter((m) => m === 'player' || m === VILLAGER));
  const villager = movers.includes(VILLAGER);
  const width = part.width ?? pr.read.width ?? (villager ? TUNNEL.widthVillager : TUNNEL.widthPlayer);
  const height = part.height ?? TUNNEL.height;
  const unsafe = part.ext?.[UNSAFE_EXT] ?? null;
  st.parts.set(p.id, { movers, villager, width, height, notes, lining: part.lining ?? 'exposed', portal: part.portal ?? 'arch', approach: part.approach ?? TUNNEL.approach, length: part.length ?? null, unsafe });
  // R18: both ends one place (a self-loop): nothing to bore
  const to = (part.via ?? []).length ? part.via[0] : part.to;
  if (sameEnd(part.from, to)) return { class: 'refused', notes, reasons: [{ code: 'NO_GAP', message: 'both ends are one place: nothing to bore', evidence: { from: part.from, to } }] };
  return null;
}

/** A tunnel leg's options for the route pass (spans, once, approach, width, movers, and the row's own `t3.tunnel`). */
export function tunnelLeg(K, p) {
  const o = stateOf(K).parts.get(p.id);
  if (!o) return {};
  return {
    width: o.width, movers: o.movers, spans: ['tunnel'], once: 'tunnel', approach: o.approach,
    t3: { tunnel: { part: p.id, width: o.width, height: o.height, lining: o.lining, portal: o.portal, ...(o.length ? { length: { ...o.length } } : {}), ...(o.unsafe ? { _unsafe: { ...o.unsafe } } : {}) } },
  };
}

/** An auto connector's tunnel options: the tunnel row only where the plan holds frozen volumes (§6: auto edges ask for nothing). */
export function tunnelAutoLeg(K, p) {
  if (!(K.ctx.volumes ?? []).length) return {};
  const unsafe = p.part.ext?.[UNSAFE_EXT] ?? null;
  return { spans: ['tunnel'], t3: { tunnel: { part: p.id, auto: true, ...(unsafe ? { _unsafe: { ...unsafe } } : {}) } } };
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
 * The corridor of each explicit tunnel part (§6) and its status: `asked` (its volume asked; `volume` the decoded one when the plan
 * holds it), or why not: `flat` (no column in it stands height + cover over the lower end: no line can have surface cover, so no
 * volume; the part answers tunnel.under or NO_COVER), `missing` (MISSING survey columns: the claim is not loaded there), `capEdge`
 * (over 4M cells), `capPlan` (the plan's asked total past 16M). In plan order, so the caps are deterministic.
 */
function corridors(K) {
  const st = stateOf(K);
  if (st.done) return st.corridors;
  st.done = true;
  const S = K.env.S, claim = K.ctx.claim;
  let total = 0;
  for (const p of K.order) {
    if (p.family !== 'connector' || p.kind !== 'tunnel' || K.answers.has(p.id)) continue;
    const o = st.parts.get(p.id);
    if (!o) continue;
    const part = p.part, toEnd = (part.via ?? []).length ? part.via[0] : part.to;
    const a = K.endpointNode(part.from, toEnd, p, 'from'), b = K.endpointNode(toEnd, part.from, p, 'to');
    if (a.error || b.error || !a.at || !b.at) continue;
    const pad = o.approach + o.width + TUNNEL.corridorPad;
    const rx0 = Math.max(claim.minX, Math.min(a.at[0], b.at[0]) - pad), rz0 = Math.max(claim.minZ, Math.min(a.at[2], b.at[2]) - pad);
    const rx1 = Math.min(claim.maxX, Math.max(a.at[0], b.at[0]) + pad), rz1 = Math.min(claim.maxZ, Math.max(a.at[2], b.at[2]) + pad);
    const g = rectGround(S, rx0, rz0, rx1, rz1);
    const { box, cells } = corridorBox(a.at, b.at, { approach: o.approach, width: o.width, groundMax: () => g.top, minY: claim.minY ?? -64, maxY: claim.maxY ?? 319 });
    const c = { box, cells, from: [...a.at], to: [...b.at], status: null, volume: null };
    const lowFeet = Math.min(a.at[1], b.at[1]);
    if (g.missing) c.status = 'missing';
    else if (g.top - (lowFeet - 1) < o.height + (Number.isInteger(o.unsafe?.cover) ? o.unsafe.cover : TUNNEL.cover)) c.status = 'flat';
    else if (cells > TUNNEL.edgeCells) c.status = 'capEdge';
    else if (total + cells > TUNNEL.planCells) c.status = 'capPlan';
    else {
      total += cells;
      c.status = 'asked';
      c.volume = K.r.needVolume(box);
    }
    st.corridors.set(p.id, c);
  }
  st.asked = total;
  return st.corridors;
}

/**
 * The route pass's pass-level tunnel input, or null: the frozen volumes (decoded) every tunnel row reads, the explicit tunnels'
 * corridors asked first (§6). Only for a plan with a tunnel part, or an auto part where the plan holds volumes.
 */
export function tunnelPassInput(K) {
  const st = stateOf(K);
  if (st.input !== undefined) return st.input;
  const hasTunnel = K.k1Parts.some((p) => p.kind === 'tunnel');
  const hasAuto = K.k1Parts.some((p) => p.kind === 'auto') && (K.ctx.volumes ?? []).length > 0;
  if (!hasTunnel && !hasAuto) { st.input = null; return null; }
  if (hasTunnel) corridors(K);
  // every volume the plan holds (the corridors, a caller's): asked through needVolume, so the IR records each one the bores read
  const vols = [];
  for (const v of K.ctx.volumes ?? []) { const d = K.r.needVolume(v.box); if (d && !vols.includes(d)) vols.push(d); }
  for (const c of st.corridors.values()) if (c.volume && !vols.includes(c.volume)) vols.push(c.volume);
  // the explicit tunnels' corridors: an edge whose corridor holds no volume searches no bore (the row's `idle`)
  const parts = {};
  for (const [id, c] of st.corridors) parts[id] = { status: c.status, volume: !!c.volume };
  // the keep-out rects by what they are (the route's keepOut merges them): a refusal names the class
  const rect = (a) => [a.minX, a.minZ, a.maxX, a.maxZ];
  const classes = [...K.env.protectedAreas.map((a) => ({ rect: rect(a.rect), class: 'PROTECTED_AREA', id: a.id })), ...K.env.regions.map((a) => ({ rect: rect(a.rect), class: 'REGION', id: a.id })),
    ...K.env.buildRects.map((a) => ({ rect: rect(a.rect), class: 'BUILD', id: a.id }))];
  st.input = { volumes: vols, parts, ...(classes.length ? { classes } : {}) };
  return st.input;
}

/** The corridor's `incomplete VOLUME` answer (§6), or null when its volume was asked. */
function volumeAnswer(K, id, o) {
  const c = stateOf(K).corridors.get(id);
  if (!c || c.status === 'asked' || c.status === 'flat') return null;
  const cap = c.status === 'capEdge' ? { cap: 'edgeCells', limit: TUNNEL.edgeCells } : c.status === 'capPlan' ? { cap: 'planCells', limit: TUNNEL.planCells, asked: stateOf(K).asked } : null;
  const msg = cap ? `the tunnel's corridor is ${c.cells} cells, past the ${cap.cap === 'edgeCells' ? 'per-edge cap' : 'per-plan cap'} (${cap.limit})`
    : 'the tunnel\'s corridor is not loaded (MISSING survey columns): prepare (or check with load: "generate"), then check again';
  return { class: 'incomplete', notes: o?.notes, reasons: [{ code: 'VOLUME', message: msg, evidence: { corridor: c.box, cells: c.cells, ...(cap ?? { missing: true }) } }] };
}

/** A tunnel leg that found no route: its typed answer (the route pass's diagnosis, the corridor's status), with the leg's ends. */
export function tunnelFailAnswer(K, l, m) {
  const o = stateOf(K).parts.get(l.conn.id);
  const vol = volumeAnswer(K, l.conn.id, o);
  if (vol) return vol;
  const why = m?.tunnel ?? { code: 'UNREACHABLE', evidence: {} };
  const ev = { leg: l.k + 1, from: l.from.at, to: l.to.at, ...(why.evidence ?? {}) };
  if (why.under) {
    // S-T3-4: a tunnel under flat ground is the reserved shape `tunnel.under` (until 7b), never a NO_COVER path repair
    l.conn.block = 'tunnel.under';
    return { class: 'unsupported', notes: o?.notes, reasons: [{ code: 'UNSUPPORTED', message: 'a passage under flat ground (stairs down, a covered run, stairs up) is tunnel.under, reserved until 7b: no hill stands between the ends', block: 'tunnel.under', until: '7b', evidence: ev }] };
  }
  if (why.code === 'VOLUME') {
    const c = stateOf(K).corridors.get(l.conn.id);
    return { class: 'incomplete', notes: o?.notes, reasons: [{ code: 'VOLUME', message: `leg ${l.k + 1}: the corridor's rock was not read (its chunks are not loaded or not generated): prepare (or check with load: "generate"), then check again`, evidence: { ...ev, ...(c ? { corridor: c.box, cells: c.cells } : {}) } }] };
  }
  const msg = {
    NO_COVER: `fewer than ${TUNNEL.cover} site-solid cells over the roof for ${TUNNEL.boreMin} consecutive cells on every line within the approach`,
    SPAN: `the only bores with cover are outside ${TUNNEL.lengthMin}..${TUNNEL.lengthMax} floor cells (or the part's length)`,
    TOO_STEEP: 'the walk cells at the bore\'s ends differ by more than max(1, L / 8)',
    WATER: `water, lava or ice within ${TUNNEL.fluidBuffer} of the bore`,
    PROTECTED: 'the bore or its shell meets a protected column or cell (a protected area, a build, a lot, a player\'s or owner\'s cell, a route or wall over it)',
    UNREACHABLE: 'a bore with cover exists but the route does not reach it within the approach',
  }[why.code] ?? why.code;
  return { class: 'refused', notes: o?.notes, reasons: [{ code: why.code, message: `leg ${l.k + 1}: ${msg}`, evidence: ev }] };
}

/** A land for re-checking and writing a routed bore: the survey, the plan's volumes, the K1 walls (posterns) and the keep-out. */
function emitLand(K) {
  const st = stateOf(K);
  if (st.land) return st.land;
  const S = K.env.S;
  const rects = [...K.env.protectedAreas.map((a) => ({ r: a.rect, c: 'PROTECTED_AREA', id: a.id })), ...K.env.regions.map((a) => ({ r: a.rect, c: 'REGION', id: a.id })), ...K.env.buildRects.map((a) => ({ r: a.rect, c: 'BUILD', id: a.id }))];
  const wallCells = new Map();
  for (const W of K.walls ?? []) for (const c of W.cells ?? []) wallCells.set(`${c.x},${c.z}`, W);
  st.land = tunnelLand(S, {
    volumes: tunnelPassInput(K)?.volumes ?? [], classOfVolume,
    blocked: (x, z) => { const q = rects.find((a) => x >= a.r.minX && x <= a.r.maxX && z >= a.r.minZ && z <= a.r.maxZ); return q ? { class: q.c, id: q.id } : null; },
    wallAt: (x, z) => { const W = wallCells.get(`${x},${z}`); return W ? { id: W.id, footing: S.groundAt(x, z) - 2, sealed: (W.st?.gatesMax ?? 16) === 0 } : null; },
  });
  return st.land;
}

/** The bores of a routed connector's legs: [{n, rise, dir, from, to, width}] from the route's `tunnel` segments. */
function boresOf(legs) {
  const out = [];
  for (const { meta } of legs) for (const g of meta?.segments ?? []) {
    if (g.kind !== 'tunnel') continue;
    out.push({ n: g.n, rise: g.rise, dir: [...g.dir], from: [...meta.path[g.from]], to: [...meta.path[g.to]], width: meta.width });
  }
  return out;
}

/** A bore's crossing (S-T3-1, S-T3-8): through rock, its length, the least cover over its bore cells, and the postern it passes. */
function crossingOf(K, o, b) {
  const g = tunnelGeom(emitLand(K), b.from, b.dir, b.n, b.rise, { width: o.width, height: o.height, lining: o.lining, portal: o.portal, _unsafe: o.unsafe ?? undefined });
  const covers = g.ok ? g.cover.filter((c, i) => i >= 1 && g.bore[i]) : [];
  const posterns = g.ok ? g.posterns.map((q) => q.wall) : [];
  return { crossing: { type: 'tunnel', through: 'rock', length: b.n, cover: covers.length ? Math.min(...covers) : null, ...(posterns.length ? { lands: `postern_${posterns[0]}` } : {}) }, g };
}

/** After routing, a routed tunnel's (or an auto connector's) answer fields to merge ({geometry: {tunnels}, notes}), or null. */
export function tunnelAnswer(K, p, legs) {
  const st = stateOf(K);
  const o = st.parts.get(p.id) ?? { width: TUNNEL.widthVillager, height: TUNNEL.height, notes: [] };
  const bores = boresOf(legs);
  if (p.kind !== 'tunnel' && !bores.length) return null;
  const tunnels = bores.map((b) => {
    const { crossing, g } = crossingOf(K, o, b);
    return { from: b.from, to: b.to, length: b.n, rise: b.rise, dir: b.dir, width: o.width, height: o.height, crossing, ...(g.ok ? { carved: g.carved, lined: g.lined.length, bore: g.bore.filter(Boolean).length, cut: g.cuts.filter(Boolean).length } : {}), ...(g.ok && g.posterns.length ? { posterns: g.posterns.map((q) => ({ wall: q.wall, cells: q.cells.length })) } : {}) };
  });
  const notes = [...(o.notes ?? [])];
  if (p.kind === 'tunnel' && bores.length) notes.push(`read ${(tunnelPassInput(K)?.volumes ?? []).length} frozen volume(s) for its rock`);
  return { geometry: { tunnels, movers: o.movers ?? null }, ...(notes.length ? { notes } : {}) };
}

/** The links stage: write every routed connector's bores (carve, floor, lining, portals, lamps) under a checkpoint each. */
export function emitTunnels(K) {
  const st = stateOf(K);
  const ok = (id) => ['fits', 'adjusted'].includes(K.answers.get(id)?.class);
  const done = new Set();
  for (const x of K.routed ?? []) {
    const p = x.conn;
    if (!ok(p.id) || !x.meta || done.has(`${p.id}:${x.meta.id}`)) continue;
    const segs = (x.meta.segments ?? []).filter((g) => g.kind === 'tunnel');
    if (!segs.length) continue;
    done.add(`${p.id}:${x.meta.id}`);
    const o = st.parts.get(p.id) ?? { width: x.meta.width, height: TUNNEL.height, lining: 'exposed', portal: 'arch', unsafe: p.part.ext?.[UNSAFE_EXT] ?? null };
    const idx = K.order.indexOf(p);
    const cp = K.checkpoint();
    try {
      const land = emitLand(K);
      const recs = [];
      segs.forEach((g, si) => {
        const a = x.meta.path[g.from], b = x.meta.path[g.to];
        // the volume its guard cells are kept against: the one holding its corridor (the explicit part's own, else the first that covers it)
        const vols = tunnelPassInput(K)?.volumes ?? [];
        const own = st.corridors.get(p.id)?.volume ?? null;
        const vol = own ?? vols.find((v) => v.box.minX <= Math.min(a[0], b[0]) && v.box.maxX >= Math.max(a[0], b[0]) && v.box.minZ <= Math.min(a[2], b[2]) && v.box.maxZ >= Math.max(a[2], b[2])) ?? null;
        const style = p.part.lamps === 'none' ? { _unsafe: { ...(o.unsafe ?? {}), noLamps: true } } : o.unsafe ? { _unsafe: { ...o.unsafe } } : {};
        const rec = tunnelPrimitive(K.r, a, b, {
          land, width: o.width, height: o.height, lining: o.lining, portal: o.portal, stage: K.stageOf('links'), liningStage: K.stageOf('routes'), part: `links_t${idx}`, id: `tunnel_t${idx}_${x.meta.id}_${si}`.slice(0, 48), movers: o.movers ?? x.meta.movers,
          ...(vol ? { volume: { sha: vol.sha, box: [vol.box.minX, vol.box.minY, vol.box.minZ, vol.box.maxX, vol.box.maxY, vol.box.maxZ] } } : {}), ...style,
        });
        recs.push(rec);
        // the guard cells (§6): those inside the volume the bore was checked against, for realiseApproved's rock check
        if (vol) {
          const runs = [];
          for (let t = 0; t < rec.guard.length; t += 4) {
            const gx = rec.guard[t], gz = rec.guard[t + 1];
            if (gx < vol.box.minX || gx > vol.box.maxX || gz < vol.box.minZ || gz > vol.box.maxZ) continue;
            const y0 = Math.max(vol.box.minY, rec.guard[t + 2]), y1 = Math.min(vol.box.maxY, rec.guard[t + 3]);
            if (y0 <= y1) runs.push(gx, gz, y0, y1);
          }
          (K.record.guards ??= []).push({ part: p.id, tunnel: rec.id, volume: { sha: vol.sha, box: [vol.box.minX, vol.box.minY, vol.box.minZ, vol.box.maxX, vol.box.maxY, vol.box.maxZ] }, runs });
        }
      });
      K.mark(p.id, K.addedSince(cp));
      // a tunnel connector's graph edge is typed (§8: type tunnel, its crossing)
      if (p.kind === 'tunnel') {
        const ge = K.r.graph.edges.find((e) => e.id === `route_${x.meta.id}`);
        if (ge && recs.length) {
          const r0 = recs[0];
          const covers = r0.cover.filter((c, i) => r0.bore[i]);
          ge.type = 'tunnel';
          ge.crossing = { type: 'tunnel', through: 'rock', length: r0.length, cover: covers.length ? Math.min(...covers) : null, ...(r0.posterns.length ? { lands: `postern_${r0.posterns[0].wall}` } : {}) };
        }
      }
      // its bill of materials (§8: planCheck.links.bom[part]) and the carved count
      const bom = { ...((K.record.bom ??= {})[p.id] ?? {}) };
      for (const rr of recs) for (const [item, nn] of Object.entries(rr.bom ?? {})) bom[item] = (bom[item] ?? 0) + nn;
      K.record.bom[p.id] = Object.fromEntries(Object.entries(bom).sort(([u], [v]) => (u < v ? -1 : u > v ? 1 : 0)));
      (K.record.tunnels ??= {})[p.id] = recs.map((rr) => ({ id: rr.id, length: rr.length, carved: rr.carved, lined: rr.lined, written: rr.counts.written }));
    } catch (e) {
      K.rollback(cp);
      if (K.record.guards) K.record.guards = K.record.guards.filter((q) => q.part !== p.id);
      const code = e.tunnel?.code ?? 'UNREACHABLE';
      K.ans(p, { class: code === 'VOLUME' ? 'incomplete' : 'refused', reasons: [{ code, message: `the bore could not be written: ${e.message}`, evidence: { edge: x.meta.id, ...(e.tunnel?.evidence ?? {}) } }] });
    }
  }
}

/** (tests) The corridor statuses of a compile (§6). */
export function corridorStatus(K) {
  return stateOf(K).corridors;
}

