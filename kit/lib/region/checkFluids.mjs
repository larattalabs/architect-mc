// (6c H) The checker's fluid rules (docs/CONTRACT.md "Phase 6c slice H" §2, §9) on the virtual world (vworld.mjs), over the frozen
// volumes the IR records: M25 (containment: leak, convert, mix, shell, keep with the single breach, wet, trap, exit) per body, and M20
// (no flammable block within the fire reach of exposed lava, an error for lava bodies). M17 (planned light over planned ice; lava is
// light 15) is check.mjs's own rule: the ice cap and the lava are written cells there.
//
// A body comes from the IR's `fluid` ops (kit/lib/fluids/body.mjs); a wet write from the plan meta's `wet` records ({id, part, kind,
// columns: [[x, z, y0, y1]]}: the columns a pier, a harbour wall section or a quay writes through natural water). Runs only when the
// plan has either, so every other plan's report is unchanged. A body without a frozen volume over its box is a finding (M25:shell
// "no volume"), never a pass (§9).
import { simulate } from '../fluids/sim.mjs';
import { FLUID_OP, decorCellsOf, fromRuns, isCourseOp, splitJoins } from '../fluids/body.mjs';
import { VC, classAt } from './volume.mjs';
import { F_WRITTEN } from './vworld.mjs';
import { kindOf } from '../fluids/world.mjs';
import { irFields } from '../fluids/irrfield.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from './geom.mjs';

export { kindOf } from '../fluids/world.mjs';

/** (6c H, M20) The fire reach of an exposed lava cell, from 26.3's LavaFluid.randomTick (read in its bytecode): nextInt(3) steps, each
 * one up and at most one aside, light an air cell beside a flammable block (so the fire is at most 2 up and 2 aside, the block it lights
 * at most 3 aside and 0..3 up); with no step, three tries one aside at the lava's level light the air over a flammable block there. So a
 * flammable block within 3 sideways (Chebyshev), up to 3 above; 1 below is kept as a margin (vanilla lights nothing under the lava's
 * level). Gate item 13's probe confirms it in game (the posts the lava lit itself; fire's own spread is recorded apart). */
export const FIRE_REACH = Object.freeze({ side: 3, below: 1, above: 3 });

const k3 = (x, y, z) => `${x},${y},${z}`;
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The bodies of an IR (its `fluid` ops), with their IR part index. (6c HY) A course's op adds `lining` (cells), `after` (ids), `planJoins`
 * ([{body, cells}]: joins into other bodies of the plan) and `grate` (cells); `joins` stays the natural joins' cells; `course` is true.
 * (6c F3-c) `decor`: the cells of the op's decor set (the coral grown in the body: body cells and bed cells), empty for any other body.
 */
export function bodiesOf(ir) {
  const out = [];
  ir.parts.forEach((p, pi) => {
    for (const o of p.ops ?? []) {
      if (o.op !== FLUID_OP) continue;
      const j = splitJoins(o.joins);
      out.push({ id: o.id, part: o.part ?? null, irPart: p.id, pi, fluid: o.fluid, level: o.level, cells: fromRuns(o.cells), shell: fromRuns(o.shell), spill: fromRuns(o.spill), joins: fromRuns(j.natural), watch: fromRuns(o.watch), ice: fromRuns(o.ice), predicted: o.predicted ?? [], settleTicks: o.settleTicks,
        lining: fromRuns(o.lining), after: Array.isArray(o.after) ? o.after : [], planJoins: j.plan.map((q) => ({ body: q.body, cells: fromRuns(q.cells) })), grate: fromRuns(o.grate), course: isCourseOp(o),
        decor: decorCellsOf(o.decor).map((c) => [c[0], c[1], c[2]]),
        // ((7a LF) a lift's bubble columns (decor's shape: [{state, cells}]); a lift body is `lift`)
        bubble: decorCellsOf(o.bubble).map((c) => [c[0], c[1], c[2]]), bubbleStates: decorCellsOf(o.bubble), lift: Array.isArray(o.bubble) && o.bubble.length > 0 });
    }
  });
  return out;
}

/**
 * (6c HY, §3.1) The write order of an IR's bodies: each after every body in its `after` (ties: plan order, the IR's op order); a cycle or
 * an unknown id leaves the rest in plan order. Returns {order: [ids], cycle: [ids] | null, unknown: [[body, after]]}. The mod's own
 * order (RegionFluids.writeOrder) is the same rule.
 */
export function writeOrder(bodies) {
  const ids = bodies.map((b) => b.id);
  const known = new Set(ids);
  const unknown = [];
  for (const b of bodies) for (const a of b.after ?? []) if (!known.has(a)) unknown.push([b.id, a]);
  const out = [], done = new Set();
  let cycle = null;
  while (out.length < bodies.length) {
    let pick = bodies.find((b) => !done.has(b.id) && (b.after ?? []).every((a) => done.has(a) || !known.has(a)));
    if (!pick) { cycle ??= bodies.filter((b) => !done.has(b.id)).map((b) => b.id); pick = bodies.find((b) => !done.has(b.id)); }
    done.add(pick.id);
    out.push(pick.id);
  }
  return { order: out, cycle, unknown };
}

const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * (6c HY, §2) The course rules, on the bodies of an IR with a course op (an H-only IR never runs them, so its report is unchanged):
 *   M25:order   a course body's spill lands in a plan body that is not written before it (its plan joins, and any other body a spill
 *               cell of it falls into or lies beside), a cycle of `after`, or an `after` naming no body of the plan
 *   M25:shell   a weir 1 thick: a body cell at or under its surface whose shell (or lining) neighbour has natural water right behind it
 *               (a weir is 2 thick wherever a body faces natural water at its level)
 *   M25:keep    the single breach of a course body's shell, lining or weir reaches a cell beside natural water (the breach would
 *               connect the course to the river); its own natural joins aside
 */
function courseRules({ bodies, sim, world, findings, finding }) {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const cellOf = new Map();
  for (const b of bodies) for (const c of b.cells) cellOf.set(k3(...c), b.id);
  const W = writeOrder(bodies);
  const pos = new Map(W.order.map((id, i) => [id, i]));
  const natural = (x, y, z) => { const w = world.at(x, y, z); return (w === 'water' || w === 'flowing_water') && !cellOf.has(k3(x, y, z)); };
  for (const [b, a] of W.unknown) findings.push(finding('M25:order', byId.get(b)?.irPart ?? null, 'fluids', 1, [], `body ${b}: after names ${a}, no body of the plan`));
  if (W.cycle) findings.push(finding('M25:order', byId.get(W.cycle[0])?.irPart ?? null, 'fluids', W.cycle.length, [], `a join cycle: ${W.cycle.join(', ')} each wait for another (after)`));
  bodies.forEach((b, i) => {
    if (!b.course) return;
    const s = sim.bodies[i];
    // the bodies its spill lands in: its plan joins, and any body a reached spill cell falls into or lies beside
    const lands = new Map();
    for (const q of b.planJoins) lands.set(q.body, q.cells[0] ?? null);
    for (const c of s.spill) for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const o = cellOf.get(k3(c[0] + dx, c[1] + dy, c[2] + dz));
      if (o && o !== b.id && byId.get(o)?.fluid === b.fluid && !lands.has(o)) lands.set(o, c);
    }
    const bad = [...lands].filter(([o]) => byId.has(o) && !(pos.get(o) < pos.get(b.id)));
    if (bad.length) findings.push(finding('M25:order', b.irPart, 'fluids', bad.length, bad.map(([, c]) => c).filter(Boolean), `body ${b.id}: its spill lands in ${bad.map(([o]) => o).join(', ')}, not written before it (after: [${b.after.join(', ')}])`));
    // the weir: 2 thick wherever the body faces natural water at its level
    const wall = new Set([...b.shell, ...b.lining].map((c) => k3(...c)));
    const thin = [];
    for (const [x, y, z] of b.cells) {
      if (y > b.level) continue;
      for (const [dx, dz] of H4) if (wall.has(k3(x + dx, y, z + dz)) && natural(x + 2 * dx, y, z + 2 * dz)) thin.push([x + dx, y, z + dz]);
    }
    if (thin.length) findings.push(finding('M25:shell', b.irPart, 'fluids', thin.length, thin.slice(0, 16), `body ${b.id}: a weir 1 thick: ${thin.length} shell cell(s) with natural water right behind them (a weir is 2 thick wherever a body faces natural water at its level)`));
    // the single breach beside natural water (its own natural joins aside)
    const joinSet = new Set(b.joins.map((c) => k3(...c)));
    const wet = [];
    for (const [x, y, z] of s.breach ?? []) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = [x + dx, y + dy, z + dz];
        if (natural(...q) && !joinSet.has(k3(...q))) { wet.push([x, y, z]); break; }
      }
    }
    if (wet.length) findings.push(finding('M25:keep', b.irPart, 'fluids', wet.length, wet.slice(0, 16), `body ${b.id}: the single breach reaches ${wet.length} cell(s) beside natural water (a breached weir would join the course to it)`));
  });
}

/** (6c KC, §5) The hard sets of a body, in the order a finding names them (the weir rides in `lining`). */
// ((6c F3-c) `decor` too: the coral is the body's own cells (§3.4), each a body or bed cell already; named so a finding says decor)
export const CLEAR_SETS = Object.freeze(['cells', 'ice', 'shell', 'lining', 'grate', 'spill', 'decor']);

/**
 * (6c KC, §5, S-KC-2) The cells exempt from `M25:clear`'s watch clause, by name. One kind only: a registered water gate's lintel and
 * frame (HY-c, meta walls[].waterGates): the cells its wall writes over the crossing's columns (the lintel) and the columns beside them
 * (the frame: the crossing's box grown by 1), from the lintel up, in the watch set of a reach of the crossing's course (the crossing reach,
 * or the reach above it whose breach reaches the frame). Nothing in a hard set is ever exempt. Returns [{wall, course, bodies, cols, lintel}].
 */
export function clearExempt(meta) {
  const out = [];
  const bodiesOf = new Map((meta?.courses ?? []).map((c) => [c.id, new Set(c.bodies ?? [])]));
  for (const w of meta?.walls ?? []) for (const g of w.waterGates ?? []) {
    const xs = (g.cells ?? []).map((c) => c[0]), zs = (g.cells ?? []).map((c) => c[1]);
    if (!xs.length) continue;
    const cols = new Set();
    for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) for (let z = Math.min(...zs) - 1; z <= Math.max(...zs) + 1; z++) cols.add(`${x},${z}`);
    out.push({ wall: w.part ?? w.id, course: g.course, bodies: bodiesOf.get(g.course) ?? new Set([g.body]), cols, lintel: g.lintel });
  }
  return out;
}

/**
 * (6c KC, §1, §5) `M25:clear`: a body's cells are its own. Over the final virtual world, for every body of the IR:
 *   hard   a cell of its cells, ice, shell, lining (the weir), grate or spill whose last writer is a part other than the body's own; a
 *          water or ice cell holding any written block that is not its fluid or ice, whoever wrote it
 *   watch  (strict, S-KC-2) a cell of its watch set (computed at emit, over the draft world) written by any other part, whatever the
 *          block; the registered water gate's lintel and frame are the one named exception (clearExempt)
 * Ownership: in a plan's IR (meta.planCheck.partOf) the writer's plan part against the body's `part`; a body with no `part`, or a
 * writer the plan does not map, is "owner unknown" (a finding, never a pass). In a program's IR (no planCheck) the writer's IR part
 * against the body's own: its op's part, or a part named `<part>_...` (`<part>` the op's `part`, else its IR part).
 * Returns {findings: [{body, part, irPart, set, writer, writerPart, why, cells (<= 16), count}], counts: {hard, watch, exempt}}.
 */
export function clearScan({ ir, vw, meta, bodies = bodiesOf(ir) }) {
  const P = vw.pal;
  const partOf = meta?.planCheck && !meta.planCheck.malformed ? (meta.planCheck.partOf ?? {}) : null;
  const exempt = clearExempt(meta);
  const counts = { hard: 0, watch: 0, exempt: 0 };
  const findings = [];
  // ((HY) joined bodies share their meeting cells: a course's spill lands in the body it joins (that body's own parts write there), an
  // overflow's outlet is the feeding body's: the parts of every body linked to this one by a plan join or `after`, either way, are its
  // partners)
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const links = new Map(bodies.map((b) => [b.id, new Set()]));
  const link = (a, c) => { if (byId.has(a) && byId.has(c) && a !== c) { links.get(a).add(c); links.get(c).add(a); } };
  for (const b of bodies) { for (const q of b.planJoins ?? []) link(b.id, q.body); for (const a of b.after ?? []) link(b.id, a); }
  // (and a body whose spill falls into or lies beside another body's cells: a spout over its basin)
  const cellBody = new Map();
  for (const b of bodies) for (const c of b.cells) cellBody.set(k3(...c), b.id);
  for (const b of bodies) for (const [x, y, z] of b.spill ?? []) for (const [dx, dy, dz] of [[0, 0, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const o = cellBody.get(k3(x + dx, y + dy, z + dz));
    if (o && o !== b.id) link(b.id, o);
  }
  // (a program's IR: a body's root is its op's part, else its course's (meta.courses), else the shortest IR part of the bodies its own IR
  // part is named under (a fountain's `w_x` for its spout `w_x_spout`); a part named `<root>_...` is the body's)
  const courseOf = new Map();
  for (const c of meta?.courses ?? []) for (const id of c.bodies ?? []) courseOf.set(id, c.part ?? c.id);
  const rootOf = (b) => b.part ?? courseOf.get(b.id) ?? bodies.filter((q) => b.irPart === q.irPart || String(b.irPart).startsWith(`${q.irPart}_`)).map((q) => q.irPart).sort((a, c) => a.length - c.length)[0] ?? b.irPart;
  for (const b of bodies) {
    const partners = [b, ...[...links.get(b.id)].map((id) => byId.get(id))];
    const own = (wid) => {
      if (partners.some((q) => wid === q.irPart)) return { own: true };
      if (partOf) {
        if (!b.part) return { own: false, why: 'owner unknown' };
        const wp = partOf[wid];
        if (wp === undefined || wp === null) return { own: false, why: 'owner unknown', writerPart: null };
        return partners.some((q) => q.part && wp === q.part) ? { own: true } : { own: false, why: "another part's", writerPart: wp };
      }
      return partners.some((q) => wid === rootOf(q) || String(wid).startsWith(`${rootOf(q)}_`)) ? { own: true } : { own: false, why: "another part's", writerPart: null };
    };
    const groups = new Map();
    const hit = (set, c, wid, why, writerPart) => {
      const k = `${set}|${wid}|${why}`;
      let g = groups.get(k);
      if (!g) { g = { body: b.id, part: b.part, irPart: b.irPart, set, writer: wid, writerPart: writerPart ?? null, why, cells: [], count: 0 }; groups.set(k, g); }
      g.count++;
      if (g.cells.length < 16) g.cells.push(c);
    };
    const hard = new Set();
    const fluidCells = new Set([...b.cells, ...b.ice].map((c) => k3(...c)));
    const grate = new Set(b.grate.map((c) => k3(...c)));
    for (const set of CLEAR_SETS) {
      for (const c of b[set] ?? []) {
        const kk = k3(...c);
        if (hard.has(kk)) continue;
        hard.add(kk);
        const [x, y, z] = c;
        if (!(vw.flags(x, y, z) & F_WRITTEN)) continue;
        const pi = vw.partAt(x, y, z);
        const wid = pi >= 0 ? ir.parts[pi]?.id ?? null : null;
        const o = own(wid);
        if (!o.own) { hit(set, c, wid, o.why, o.writerPart); counts.hard++; continue; }
        // a water or ice cell holding a written block that is not its fluid or ice (whoever wrote it); a grate cell holds its bars
        if (fluidCells.has(kk) && !grate.has(kk)) {
          const i = vw.get(x, y, z), st = P.states[i] ?? '';
          const ok = b.fluid === 'lava' ? P.lava[i] : (P.water[i] || P.fluid[i] || /^minecraft:(ice|packed_ice|blue_ice)$/.test(st));
          if (!ok) { hit(set, c, wid, `holds ${st}`, null); counts.hard++; }
        }
      }
    }
    for (const c of b.watch) {
      const kk = k3(...c);
      if (hard.has(kk)) continue;
      const [x, y, z] = c;
      if (!(vw.flags(x, y, z) & F_WRITTEN)) continue;
      const pi = vw.partAt(x, y, z);
      const wid = pi >= 0 ? ir.parts[pi]?.id ?? null : null;
      const o = own(wid);
      if (o.own) continue;
      const ex = exempt.find((e) => e.bodies.has(b.id) && e.cols.has(`${x},${z}`) && y >= e.lintel && (partOf ? partOf[wid] === e.wall : String(wid).startsWith(`w_${e.wall}`) || wid === e.wall));
      if (ex) { counts.exempt++; continue; }
      hit('watch', c, wid, o.why, o.writerPart);
      counts.watch++;
    }
    // ((6c FL, §5) a zone's street (a road item, which no op shows: its ext names it, S-FL-5) over a body's hard columns: the street's
    // writer is the zone; only streets so marked are read, so a plan without one is as before)
    const hardCols = new Map();
    for (const set of CLEAR_SETS) for (const c of b[set] ?? []) { const kk = `${c[0]},${c[2]}`; if (!hardCols.has(kk)) hardCols.set(kk, [set, c]); }
    for (const rd of ir.roads ?? []) {
      const zone = rd.ext?.['architect_mc:street']?.zone;
      if (!zone || partners.some((q) => q.part && q.part === zone)) continue;
      const pts = rd.points.map((q) => [q[0], q[2]]);
      const { cells } = centreCells(pts);
      const offs = crossOffsets(rd.width ?? 3);
      const seen = new Set();
      for (const cc of cells) {
        const a2 = pts[Math.min(cc.seg, pts.length - 1)], b2 = pts[Math.min(cc.seg + 1, pts.length - 1)];
        const rr = rightOf(segmentAxis(a2, b2));
        for (const k of offs) {
          const kk = `${cc.x + rr[0] * k},${cc.z + rr[1] * k}`;
          if (seen.has(kk) || !hardCols.has(kk)) continue;
          seen.add(kk);
          const [set, c] = hardCols.get(kk);
          hit(set, c, rd.part ?? `road:${rd.id}`, "a zone's street", zone);
          counts.hard++;
        }
      }
    }
    findings.push(...groups.values());
  }
  return { findings, counts };
}

/** (6c KC, §3) The forms placed before the H bodies (compile step 3: relief, terraces and spikes; zones, their lots and props too). */
const EARLY_FORMS = Object.freeze(['relief', 'terrace', 'rock_spire', 'ice_spike']);

/**
 * (6c KC, §3, §5, S-KC-1) The plan check's backstop refusals from M25:clear findings ({part: reason}): the part placed later is refused.
 *   a wall or gate in a course's sets      the course (routed and emitted after the walls): UNREACHABLE {kind: wall, why: clear}
 *   a zone (its lots, pads, streets, props) or a relief, terrace or spike in an H body's sets
 *                                          the body's part (resolved after them): NO_ROOM {kind: clear}; a farm pond (its zone's) is
 *                                          never refused here (its zone is the writer's too: the region check names it)
 *   (6c FL, §5) a zone whose locator names the body's part (around, near, adjacent, inside: placed after the body's reservation)
 *                                          the zone, the later part: OVERLAP {kind: body}
 *   any other writer                       the writer (placed after the body's footprint): OVERLAP {kind: body}
 * Never a part asked `architect_mc:unsafe` (a broken variant the checker must catch), never a writer the plan does not name, never a
 * part `already` refused. Pure.
 */
export function clearRefusals({ findings, plan, courses = new Set(), already = {} }) {
  const parts = ['zones', 'forms', 'connectors', 'links'].flatMap((k) => (Array.isArray(plan?.[k]) ? plan[k].map((q) => ({ q, k })) : [])).filter(({ q }) => q && typeof q.id === 'string');
  const byId = new Map(parts.map(({ q, k }) => [q.id, { ...q, _family: k }]));
  const unsafe = (id) => !!byId.get(id)?.ext?.['architect_mc:unsafe'];
  const early = (id) => { const q = byId.get(id); return !!q && (q._family === 'zones' || (q._family === 'forms' && EARLY_FORMS.includes(q.kind))); };
  const wall = (id) => { const q = byId.get(id); return !!q && (q.kind === 'wall' || q.kind === 'gate'); };
  // ((6c FL, §5) the plan parts a zone's locator names: a zone depending on a body is placed after it)
  const dependsOn = (zid, pid) => { const q = byId.get(zid); return !!q && q._family === 'zones' && whereNames(q.where).includes(pid); };
  const fresh = {};
  for (const q of findings ?? []) {
    const w = q.writerPart;
    if (!w || !byId.has(w) || w === q.part) continue;
    let target, reason;
    if (courses.has(q.body) && wall(w) && q.part) {
      target = q.part;
      reason = { code: 'UNREACHABLE', message: `wall ${w}, planned before it, stands in ${q.count} cell(s) of its reach ${q.body}'s ${q.set === 'watch' ? 'watched reach' : q.set} (a course crosses a wall only under a water gate)`, evidence: { kind: 'wall', wall: w, why: 'clear', body: q.body, set: q.set, cells: q.cells.slice(0, 16) } };
    } else if (early(w) && !(q.part && dependsOn(w, q.part))) {
      if (!q.part || !byId.has(q.part) || byId.get(q.part)._family === 'zones') continue;
      target = q.part;
      reason = { code: 'NO_ROOM', message: `its body ${q.body} is placed after ${w}, which writes ${q.count} cell(s) of its ${q.set === 'watch' ? 'watched reach' : q.set}: the body keeps clear of what was placed before it`, evidence: { kind: 'clear', body: q.body, writer: w, set: q.set, cells: q.cells.slice(0, 16) } };
    } else {
      target = w;
      reason = { code: 'OVERLAP', message: `it writes ${q.count} cell(s) of ${q.set === 'watch' ? 'the watched reach' : `the ${q.set}`} of body ${q.body}${q.part ? ` (part ${q.part})` : ''}, placed before it: a body's cells are its own (M25:clear)`, evidence: { kind: 'body', body: q.body, part: q.part, set: q.set, cells: q.cells.slice(0, 16) } };
    }
    if (unsafe(target) || unsafe(w) || already[target] || fresh[target]) continue;
    fresh[target] = reason;
  }
  return fresh;
}

/** (6c FL) The plan parts a locator names (inside.part, adjacent.to.part, near/around/along feature.part). */
function whereNames(where) {
  if (!where || typeof where !== 'object') return [];
  const lk = Object.keys(where)[0], b = where[lk] ?? {};
  return [b.part, b.to?.part, b.feature?.part].filter((x) => typeof x === 'string');
}

/**
 * The fluid rules. `args`: check.mjs's ({ir, vw, meta, volumes (decoded, by name), want, findings, metrics, partStage, finding}).
 * Adds findings; fills metrics.M25 ({bodies: [{id, cells, shell, spill, joins, watch, settleTicks, predicted}], wet}) and metrics.M20.
 */
export function fluidRules({ ir, vw, meta, vols, want, findings, metrics, finding }) {
  const P = vw.pal;
  const bodies = bodiesOf(ir);
  const wet = Array.isArray(meta?.wet) ? meta.wet : [];
  if (!bodies.length && !wet.length) return;
  const volumeList = [...(vols?.values?.() ?? [])];
  const volClass = (x, y, z) => { for (const v of volumeList) { const c = classAt(v, x, y, z); if (c !== VC.MISSING) return c; } return VC.MISSING; };
  const covered = (x, y, z) => volClass(x, y, z) !== VC.MISSING;
  const c = ir.claim;
  // what is never the plan's own: keep-out (the owner's areas the plan honoured, the protected rects), lot boxes and their aprons, kept
  // columns, another owner's cells and players' blocks in the frozen volumes, and the claim's outer ring
  const keepRects = [...(ir.keepOut ?? []), ...(meta?.planCheck?.protectedRects ?? [])];
  const keptCols = new Set();
  for (const p of ir.parts) for (const kp of p.keep ?? []) for (let x = kp.box.minX; x <= kp.box.maxX; x++) for (let z = kp.box.minZ; z <= kp.box.maxZ; z++) keptCols.add(`${x},${z}`);
  const lots = ir.lots ?? [];
  // ((6c IRR) the irrigated fields: an irrigation body's own lot box is its own (K5's one exception, §4), and nothing outside it is;
  // the flow reads a field's floorY as the design's farmland, and its feet cells over the field as exits (irrigate.mjs's field model))
  const fields = irFields(ir);
  const ownField = new Map();
  for (const f of fields) for (const id of f.bodies) ownField.set(id, f);
  const keep = (x, y, z, body = null) => {
    const own = body ? ownField.get(body.id) : null;
    if (own) {
      const b = own.box;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return 'outside its lot (irrigation)';
    }
    if (x <= c.minX || x >= c.maxX || z <= c.minZ || z >= c.maxZ) return 'claim ring';
    for (const r of keepRects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return 'keep-out';
    for (const l of lots) { if (own && l.id === own.lot) continue; const b = l.box; if (x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1 && y >= b.minY - 1 && y <= b.maxY + 1) return 'lot'; }
    if (keptCols.has(`${x},${z}`)) return 'kept';
    const vc = volClass(x, y, z);
    if (vc === VC.OWNED) return 'owned';
    if (vc === VC.PLAYER) return 'player';
    if (vc === VC.BLOCK_ENTITY) return 'block entity';
    return null;
  };
  const fluidsStage = ir.stages.indexOf('fluids');
  const stageOfPart = (pi) => (pi < 0 ? -1 : ir.stages.indexOf(ir.parts[pi]?.stage));
  const planPartOf = (pi) => (pi < 0 ? null : meta?.planCheck?.partOf?.[ir.parts[pi]?.id] ?? null);
  const planned = !!(meta?.planCheck && !meta.planCheck.malformed && meta.planCheck.partOf);
  // ((6c F3-c, §3.4) a bed cell of the body's own decor (a coral block over its shell) is written by the body's own op in the fluids
  // stage, after its shell's stage: still a shell cell, judged by its block)
  const decorOf = new Map();
  const ownDecor = (b0, x, y, z, pi) => {
    const b = bodies.find((q) => q.id === b0.id);
    if (!b?.decor?.length) return false;
    let s = decorOf.get(b.id);
    if (!s) { s = new Set(b.decor.map((c) => k3(...c))); decorOf.set(b.id, s); }
    return s.has(k3(x, y, z)) && ir.parts[pi]?.id === b.irPart;
  };
  // ((7a LF, §2) a lift's face is the land itself where it is site-solid: an unwritten shell cell of a lift body holds when the land there
  // is fluid-stopping and no gravity block (its natural face); every other shell cell is written, as any body's)
  const liftBody = new Set(bodies.filter((b) => b.lift).map((b) => b.id));
  const shellCheck = (x, y, z, b) => {
    if (!(vw.flags(x, y, z) & F_WRITTEN)) {
      if (liftBody.has(b.id)) { const i = vw.get(x, y, z); return !P.fs[i] ? 'not fluid-stopping (the natural face)' : P.gravity[i] ? 'a gravity block (the natural face)' : null; }
      return 'not written';
    }
    const pi = vw.partAt(x, y, z);
    if (fluidsStage >= 0 && stageOfPart(pi) >= fluidsStage && !ownDecor(b, x, y, z, pi)) return 'not written before the fluids stage';
    const i = vw.get(x, y, z);
    if (!P.fs[i]) return 'not fluid-stopping';
    if (P.gravity[i]) return 'a gravity block';
    const own = b.part ? planPartOf(pi) : null;
    if (b.part && own && own !== b.part) return "another part's";
    // ((6c KC, §5) in a plan's IR a missing part id is a finding, never a pass: a body with no part, or a writer the plan does not map
    // (its own fluid op aside))
    if (planned && (!b.part || (!own && ir.parts[pi]?.id !== b.irPart))) return 'owner unknown';
    return null;
  };
  const surface = (x, y, z) => { const a = vw.get(x, y + 1, z); return !P.fs[a] && !P.fluid[a] && !P.water[a]; };
  const exit = (x, y, z) => {
    // ((6c IRR) a feet cell over an irrigated field's farmland (the design's): the field is walked; the reserved cells are not feet)
    for (const f of fields) if (y === f.floorY + 1 && x >= f.field.x0 && x <= f.field.x1 && z >= f.field.z0 && z <= f.field.z1) return !f.cells.has(k3(x, y - 1, z)) && !f.cells.has(k3(x, y, z));
    if (vw.lotAt(x, y, z)) return false;
    const a = vw.get(x, y, z), h = vw.get(x, y + 1, z), f = vw.get(x, y - 1, z);
    return P.vpass[a] && P.vpass[h] && !P.fluid[a] && !P.water[a] && P.floor[f] && !P.fluid[f];
  };
  const fieldAt = (x, y, z) => { for (const f of fields) if (y === f.floorY && x >= f.field.x0 && x <= f.field.x1 && z >= f.field.z0 && z <= f.field.z1 && !f.cells.has(k3(x, y, z))) return true; return false; };
  const world = fields.length
    ? { at: (x, y, z) => (fieldAt(x, y, z) ? 'stop' : kindOf(P, vw.get(x, y, z))), keep, shell: shellCheck, surface, exit, solid: (x, y, z) => fieldAt(x, y, z) || P.solid[vw.get(x, y, z)] }
    : { at: (x, y, z) => kindOf(P, vw.get(x, y, z)), keep, shell: shellCheck, surface, exit, solid: (x, y, z) => P.solid[vw.get(x, y, z)] };
  // ((6c HY) a course's lining and weir stand with its shell: M25:shell and the single breach cover them; its plan joins are declared)
  const sim = simulate(world, bodies.map((b) => (b.course
    ? { id: b.id, part: b.part, irPart: b.irPart, fluid: b.fluid, level: b.level, cells: b.cells, shell: [...b.shell, ...b.lining], spill: b.spill, joins: [...b.joins, ...b.planJoins.flatMap((q) => q.cells)], spillLands: b.planJoins.length > 0 }
    : { id: b.id, part: b.part, irPart: b.irPart, fluid: b.fluid, level: b.level, cells: b.cells, shell: b.shell, spill: b.spill, joins: b.joins, ...(b.lift ? { carried: b.bubble } : {}) })), { breach: true });
  const per = [];
  if (want.has('M25')) {
    for (const f of sim.findings) findings.push(finding(f.rule, bodies.find((b) => b.id === f.body)?.irPart ?? null, 'fluids', f.count, f.sample, `body ${f.body}: ${f.message}`));
    // no frozen volume over a body's box (its cells, shell and the 2-cell buffer): a finding, never a pass (§9)
    for (const b of bodies) {
      // ((7a LF, §4) a lift asks no frozen volume: its shell is the plan's own, its natural face read 2.5D (the shell check above))
      if (b.lift) continue;
      const miss = [];
      for (const q of [...b.cells, ...b.shell, ...b.lining]) if (!covered(q[0], q[1], q[2])) { miss.push(q); if (miss.length >= 16) break; }
      if (miss.length) findings.push(finding('M25:shell', b.irPart, 'fluids', miss.length, miss, `body ${b.id}: no volume: ${miss.length}+ cell(s) of its cells and shell outside every frozen volume the plan read (a body is checked against the frozen world, never a 2.5D guess)`));
    }
    if (bodies.some((b) => b.course)) courseRules({ bodies, sim, world, P, vw, findings, finding });
  }
  // ((6c KC, §5) M25:clear: a body's cells are its own (an error); counts in metrics.M25.clear)
  const clear = clearScan({ ir, vw, meta, bodies });
  if (want.has('M25')) for (const q of clear.findings) {
    findings.push(finding('M25:clear', q.writer, 'fluids', q.count, q.cells, `body ${q.body}${q.part ? ` (part ${q.part})` : ''}: ${q.count} cell(s) of its ${q.set} written by ${q.writer ?? 'an unknown part'}${q.writerPart ? ` (plan part ${q.writerPart})` : ''}: ${q.why}`));
  }
  bodies.forEach((b, i) => {
    const s = sim.bodies[i];
    per.push({ id: b.id, part: b.part, fluid: b.fluid, cells: b.cells.length, shell: b.shell.length, spill: b.spill.length, joins: b.joins.length, watch: b.watch.length, reached: s.reached.length, breach: s.breach?.length ?? 0, settleTicks: b.settleTicks, predicted: b.predicted.length, predictedNow: s.predicted.length, ...(b.decor.length ? { decor: b.decor.length } : {}), ...(b.lift ? { bubble: b.bubble.length } : {}) });
  });
  // ---- M25:wet: the plan meta's wet writes (piers, harbour walls, quays) through natural water
  const wetBad = [];
  const wetWhy = new Map();
  let wetCells = 0;
  if (wet.length) {
    for (const w of wet) {
      for (const [x, z, y0, y1] of w.columns ?? []) {
        for (let y = y0; y <= y1; y++) {
          const before = vw.base(x, y, z);
          const bk = kindOf(P, before);
          const was = bk === 'water' || bk === 'flowing_water' || bk === 'lava' || bk === 'flowing_lava' || P.states[before] === 'minecraft:ice' || P.states[before].startsWith('minecraft:bubble_column');
          if (!was) continue;
          const written = (vw.flags(x, y, z) & F_WRITTEN) !== 0;
          if (!written) continue;
          wetCells++;
          const now = vw.get(x, y, z);
          const why = bk === 'flowing_water' ? 'flowing' : bk === 'lava' || bk === 'flowing_lava' ? 'lava' : P.states[before].startsWith('minecraft:bubble_column') ? 'bubble column'
            : P.air[now] ? 'air under the surface' : P.water[now] && !P.fluid[now] ? 'waterlogged' : !P.fs[now] || P.states[now].includes('waterlogged=') ? 'not a full, non-waterloggable block' : null;
          if (why) { wetBad.push([x, y, z]); wetWhy.set(why, (wetWhy.get(why) ?? 0) + 1); }
        }
      }
    }
    if (want.has('M25') && wetBad.length) findings.push(finding('M25:wet', null, null, wetBad.length, wetBad, `${wetBad.length} wet write cell(s): ${[...wetWhy].map(([k, n]) => `${k} ${n}`).join(', ')}`));
  }
  metrics.M25 = { bodies: per, wet: { records: wet.length, cells: wetCells, bad: wetBad.length }, ...(bodies.length ? { clear: clear.counts } : {}) };
  // ---- M20 fire: no flammable block within the fire reach of exposed lava (an error for lava bodies)
  const lavaBodies = bodies.filter((b) => b.fluid === 'lava');
  if (lavaBodies.length) {
    const bad = [];
    const seen = new Set();
    let exposed = 0;
    for (const b of lavaBodies) for (const [x, y, z] of b.cells) {
      if (!D6.some(([dx, dy, dz]) => P.air[vw.get(x + dx, y + dy, z + dz)])) continue;
      exposed++;
      for (let dx = -FIRE_REACH.side; dx <= FIRE_REACH.side; dx++) for (let dz = -FIRE_REACH.side; dz <= FIRE_REACH.side; dz++) for (let dy = -FIRE_REACH.below; dy <= FIRE_REACH.above; dy++) {
        const kk = k3(x + dx, y + dy, z + dz);
        if (seen.has(kk)) continue;
        seen.add(kk);
        if (P.flammable[vw.get(x + dx, y + dy, z + dz)]) bad.push([x + dx, y + dy, z + dz]);
      }
    }
    metrics.M20 = { exposed, flammable: bad.length, reach: FIRE_REACH };
    if (want.has('M20') && bad.length) findings.push(finding('M20', lavaBodies[0].irPart, 'fluids', bad.length, bad, `${bad.length} flammable block(s) within the fire reach of exposed lava (${FIRE_REACH.side} sideways, ${FIRE_REACH.below} below to ${FIRE_REACH.above} above)`));
  }
}

/** (7a FB) M16's numbers: a barrier thinner than `thick` is a finding; a walk or lot cell counts within `reach` steps of the body's water
 * (6-connected: the cells within 2 of its shell, §1's "within 2 of its shell", so a far house behind an open plaza is no finding of a
 * body's); a finding names at most `sample` walk or lot cells and `sample` barrier cells. */
export const FLOOD = Object.freeze({ thick: 2, reach: 3, sample: 16 });

/**
 * (7a FB, docs/CONTRACT.md "Phase 7a slice FB" §1) M16, flood behaviour (a warning): for each plan body with surface `level`, every walk
 * cell (`walk`: feet cells, flat [x, y, z, ...]) or lot box cell at a y below `level`, within FLOOD.reach steps of a water cell of the
 * body, whose shortest such path through non-fluid cells at or under the surface crosses fewer than FLOOD.thick fluid-stopping cells.
 * A fluid-stopping cell (P.fs: a block, a door, a pane, bars, a grate, a fence) counts 1; air and anything water flows through (a torch,
 * grass, a carpet) 0; a fluid cell (natural water, another body, a bubble column, lava) is never crossed. A walk cell that is itself
 * fluid-stopping (a doorway the player stands in) counts its own block, as the water would meet it. Lot box cells are reached, never
 * crossed (their interior is declared, not known). The water cells are the body's own (its cells, a lift's bubble set); a cell of any
 * body's sets is no target. A sunk body (H §2.5) passes when nothing walkable lies under its surface within 2 of its shell: the search
 * finds nothing. Pure over `vw` (vworld.mjs's get, inClaim, lotAt). Returns {found: [{body, irPart, level, walk, lot, lots, cells,
 * barrier, barrierCount}], metrics}.
 */
export function floodRule({ vw, bodies, walk = [] }) {
  const P = vw.pal;
  const own = new Set();
  for (const b of bodies) for (const s of [b.cells, b.shell, b.lining ?? [], b.grate ?? [], b.spill ?? [], b.bubble ?? []]) for (const c of s) own.add(k3(c[0], c[1], c[2]));
  const walkSet = new Set();
  for (let i = 0; i < walk.length; i += 3) walkSet.add(k3(walk[i], walk[i + 1], walk[i + 2]));
  const found = [], per = [];
  for (const b of bodies) {
    const level = b.level;
    if (!Number.isFinite(level)) continue;
    // a search by steps over states (cell, crossed): each state once, at its fewest steps; `via` the barrier cell a state crossed
    const seen = new Set();
    let front = [];
    for (const c of [...b.cells, ...(b.bubble ?? [])]) { const k = `${k3(c[0], c[1], c[2])}/0`; if (!seen.has(k)) { seen.add(k); front.push({ c, d: 0, via: null }); } }
    const hits = new Map(); // cell key -> {cell, kind, d, barrier}
    let visited = 0;
    for (let step = 1; step <= FLOOD.reach && front.length; step++) {
      const nextFront = [];
      for (const { c: [x, y, z], d, via } of front) {
        for (const [dx, dy, dz] of D6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (ny > level || !vw.inClaim(nx, nz)) continue;
          const idx = vw.get(nx, ny, nz);
          if (P.fluid[idx]) continue;
          const nd = d + (!P.air[idx] && P.fs[idx] ? 1 : 0);
          if (nd >= FLOOD.thick) continue;
          const nk = k3(nx, ny, nz);
          if (seen.has(`${nk}/${nd}`) || (nd === 1 && seen.has(`${nk}/0`))) continue;
          seen.add(`${nk}/${nd}`);
          visited++;
          const bar = nd > d ? [nx, ny, nz] : via;
          const lot = vw.lotAt(nx, ny, nz);
          const kind = ny < level && !own.has(nk) ? (lot ? `lot ${lot.id}` : walkSet.has(nk) ? 'walk' : null) : null;
          if (kind) { const h = hits.get(nk); if (!h || nd < h.d) hits.set(nk, { cell: [nx, ny, nz], kind, d: nd, barrier: bar }); }
          if (!lot) nextFront.push({ c: [nx, ny, nz], d: nd, via: bar }); // a lot box is reached, never crossed
        }
      }
      front = nextFront;
    }
    const list = [...hits.values()].sort((a, c) => a.cell[1] - c.cell[1] || a.cell[0] - c.cell[0] || a.cell[2] - c.cell[2]);
    const nWalk = list.filter((h) => h.kind === 'walk').length;
    const lots = [...new Set(list.filter((h) => h.kind !== 'walk').map((h) => h.kind.slice(4)))];
    const barrier = [];
    const seenBar = new Set();
    for (const h of list) if (h.barrier) { const kk = k3(...h.barrier); if (!seenBar.has(kk)) { seenBar.add(kk); barrier.push(h.barrier); } }
    const open = list.filter((h) => h.d === 0).length;
    per.push({ id: b.id, level, walk: nWalk, lot: list.length - nWalk, ...(lots.length ? { lots } : {}), open, barrier: barrier.length, visited });
    if (list.length) found.push({ body: b.id, irPart: b.irPart, level, walk: nWalk, lot: list.length - nWalk, lots, open, cells: list.slice(0, FLOOD.sample).map((h) => h.cell), barrier: barrier.slice(0, FLOOD.sample), barrierCount: barrier.length });
  }
  return { found, metrics: { thick: FLOOD.thick, reach: FLOOD.reach, bodies: per, cells: found.reduce((a, f) => a + f.walk + f.lot, 0), findings: found.length } };
}

/** (7a FB) M16's message for one body's record. */
export function floodMessage(f) {
  const n = f.walk + f.lot;
  const what = [f.walk ? `${f.walk} walk` : null, f.lot ? `${f.lot} lot (${f.lots.join(', ')})` : null].filter(Boolean).join(', ');
  return `body ${f.body}: ${n} cell(s) below its surface (y ${f.level}) within ${FLOOD.reach} of its water behind a barrier thinner than ${FLOOD.thick} (${what}${f.open ? `; ${f.open} with no barrier` : ''}); barrier cell(s): ${f.barrierCount ? f.barrier.map((c) => c.join(' ')).join('; ') : 'none (open to the water)'}`;
}
