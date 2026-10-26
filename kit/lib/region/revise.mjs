// (6d RV-a, docs/CONTRACT.md "Phase 6d slice RV" §2-§3.4, §5, §9) Additive revisions of a standing region, the kit's side:
//   revisionStanding  ctx.standing (§5.3): what a revision must keep off, built from the effective IR, the held set, the beside regions'
//                     reach and hold columns, the owner's areas, the unfinished tiles and the lots' states. The mod sends the same shape.
//   standingClasses   the column sets the rules read (lots + 1, roads + 1, paths, path-set ways, bodies' hard and watch, held, beside)
//   mergeEffective    the effective IR (§2.3): the base IR merged with every accepted revision's additions in position order (data for
//                     readers, never evaluated as one IR)
//   historySha        §3.4's history hash of one tile key (the region's entries there, in layer order)
//   revisionSeed      fnv64(base seed, rid), keyed by part id through ctx.rng
//   reviseRules       M29:revision over a built virtual world of a revision IR (the checker's rule: independent of the program's guard)
//   reviseGuard       the plan-time refusal (planRegion runs it for a revision program; a broken variant turns it off)
//   reviseIR          the one call: the revision IR of a request against an effective IR and ctx.standing (planRegion + the guard)
// Pure, deterministic. The revision IR is a valid region IR holding only what the revision adds; its stage names are the base IR's own
// (the mod names the journal's stages `rv<rid>:<stage>`, §2.1; the kit's STAGE_NAME keeps `:` out of an IR).
import { fnv64, toDecimal64, fromDecimal64 } from '../noise.mjs';
import { canonicalJson, sha256Hex } from './pack.mjs';
import { besideStanding, keyRuns, runKeys } from './beside.mjs';

export const REVISION_FORMAT = 'revision/1';
export const STANDING_FORMAT = 'standing/1';
/** §12's product limits. */
export const REVISION_LIMITS = Object.freeze({ accepted: 64, rid: 9999, stagesPerRevision: 64, depth: 8 });
/** The part, lot and body id prefix of revision `rid` (§2.1). */
export const ridPrefix = (rid) => `rv${rid}_`;
/** The journal stage name of a revision stage (§2.1; the mod's, never an IR's). */
export const revisionStageName = (rid, stage) => `rv${rid}:${stage}`;

const k2 = (x, z) => `${x},${z}`;
const tileOf = (x, z) => `${Math.floor(x / 64)},${Math.floor(z / 64)}`;

/** `fnv64(base seed, rid)` as a u64 decimal (§2.3). */
export function revisionSeed(baseSeed, rid) {
  const [hi, lo] = fromDecimal64(String(baseSeed));
  const h = fnv64(toDecimal64(hi, lo), `rv${rid}`);
  return toDecimal64(h.hi, h.lo);
}

/**
 * §3.4 `historySha(key)`: sha256 of the canonical list, in layer order, of `[layer, stage, set, tileSha, status]` for every entry of the
 * region's group at tile `key` (tiles, revisions, roads). `entries`: [{layer, stage, set, tileSha, status}] (any order: sorted by layer,
 * then stage, set). Compared only with itself (at accept).
 */
export function historySha(entries) {
  const rows = (entries ?? []).map((e) => [e.layer | 0, String(e.stage), String(e.set), String(e.tileSha ?? '-'), String(e.status)]);
  rows.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return sha256Hex(canonicalJson(rows));
}

/**
 * ctx.standing (§5.3) for a revision of region `id` over its effective IR. `held`: D3's held reader over the claim, `{runs, town,
 * terrain}` (row runs: every held column, the region's own, its terrain's alone); `beside`: [{id, reach, hold}] the standing beside regions'
 * reach and hold columns in this claim; `keepOut`: the owner's C17 areas [[x0, z0, x1, z1]]; `unfinished`: tile keys "tx,tz" with no
 * realised record and no written entry; `lots`: {lotId: {state, siteId?, irrigated?}} from RegionRec (pad, placed, removed, failed:...).
 */
export function revisionStanding({ id, claim, effective, held = null, beside = [], keepOut = [], unfinished = [], lots = {} }) {
  const base = besideStanding(id, claim, effective);
  const ids = {
    parts: (effective.parts ?? []).map((p) => p.id).sort(),
    lots: (effective.lots ?? []).map((l) => l.id).sort(),
    roads: (effective.roads ?? []).map((r) => r.id).sort(),
    bodies: base.bodies.list.map((b) => b.id).sort(),
    nodes: (effective.graph?.nodes ?? []).map((n) => n.id).sort(),
  };
  const lotState = {};
  for (const l of effective.lots ?? []) {
    const s = lots[l.id] ?? {};
    lotState[l.id] = { state: s.state ?? 'pad', box: [l.box.minX, l.box.minY, l.box.minZ, l.box.maxX, l.box.maxY, l.box.maxZ], ...(s.siteId ? { siteId: s.siteId } : {}), ...(s.irrigated ? { irrigated: true } : {}) };
  }
  return {
    format: STANDING_FORMAT, ...base,
    held: { runs: held?.runs ?? [], town: held?.town ?? [], terrain: held?.terrain ?? [] },
    beside: (beside ?? []).map((b) => ({ id: b.id, reach: b.reach ?? [], hold: b.hold ?? [] })),
    keepOut: (keepOut ?? []).map((q) => [...q]),
    unfinished: [...(unfinished ?? [])].sort(),
    lots: lotState, ids,
  };
}

/**
 * ctx.standing with its `ids` (the effective IR's part, lot, road, body and node ids) filled from `effective` when the sender left them
 * out (the mod sends the standing data without them; the kit derives them from the effective IR it also sends).
 */
export function withStandingIds(st, effective) {
  if (!st || st.ids || !effective) return st;
  const bodies = [];
  for (const p of effective.parts ?? []) for (const o of p.ops ?? []) if (o.op === 'fluid' && o.id) bodies.push(o.id);
  return { ...st, ids: { parts: (effective.parts ?? []).map((p) => p.id).sort(), lots: (effective.lots ?? []).map((l) => l.id).sort(), roads: (effective.roads ?? []).map((r) => r.id).sort(), bodies: bodies.sort(), nodes: (effective.graph?.nodes ?? []).map((n) => n.id).sort() } };
}

/** The column sets of ctx.standing the rules read ("x,z" keys). */
export function standingClasses(st) {
  const lot = new Map();
  for (const q of st.footprint?.lots ?? []) for (const k of runKeys([[q[0] - 1, q[1] - 1, q[2] + 1, q[3] + 1]])) if (!lot.has(k)) lot.set(k, q);
  const road = new Map(), path = new Map();
  for (const p of st.footprint?.keep ?? []) {
    const into = p.kind === 'road' ? road : path; // path: the IR paths' boxes and the path-set parts' columns (ways)
    for (const k of runKeys([p.rect])) if (!into.has(k)) into.set(k, p);
  }
  const body = runKeys(st.bodies?.hard ?? []);
  runKeys(st.bodies?.watch ?? [], body);
  const held = runKeys(st.held?.runs ?? []), terrain = runKeys(st.held?.terrain ?? []);
  const beside = new Map();
  for (const b of st.beside ?? []) for (const k of runKeys([...(b.reach ?? []), ...(b.hold ?? [])])) if (!beside.has(k)) beside.set(k, b.id);
  const keepOut = st.keepOut ?? [];
  const isProtected = (x, z) => keepOut.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
  return { lot, road, path, body, held, terrain, beside, isProtected, unfinished: new Set(st.unfinished ?? []), claim: st.claim };
}

/**
 * Why a column may not take a revision's write (§5.1, §5.2), or null. The order is the refusal's: protected, the lot box plus 1, a road,
 * a path, a body, a beside region's reach or hold, a held column (another site's, or the region's own non-terrain writes).
 * `unsafe` (the broken variants): `underLot`, `overRoad`, `overPath`, `ignoreHeld` each switch one class off.
 */
export function columnProblem(K, x, z, unsafe = {}) {
  const k = k2(x, z);
  const c = K.claim;
  if (c && (x < c[0] || x > c[2] || z < c[1] || z > c[3])) return { kind: 'claim' };
  if (K.isProtected(x, z)) return { kind: 'protected' };
  if (!unsafe.underLot && K.lot.has(k)) return { kind: 'lot' };
  if (!unsafe.overRoad && K.road.has(k)) return { kind: 'road', id: K.road.get(k).id };
  // (overRoad lets a road's verge through too: a 4e road's columns are its path-set verges' as well)
  if (!unsafe.overPath && !unsafe.overRoad && K.path.has(k)) return { kind: 'path', id: K.path.get(k).id };
  if (K.body.has(k)) return { kind: 'body' };
  if (K.beside.has(k)) return { kind: 'beside', region: K.beside.get(k) };
  // (every broken variant lets the held class through: a lot's, road's or path's columns are held by its own site)
  if (!(unsafe.ignoreHeld || unsafe.overRoad || unsafe.overPath || unsafe.underLot) && K.held.has(k) && !K.terrain.has(k)) return { kind: 'held' };
  return null;
}

/** A refusal's code for a column problem's kind (§5.1, §5.2; the mod's Reason names). */
export const PROBLEM_CODE = Object.freeze({ claim: 'NOT_ALLOWED', protected: 'PROTECTED', lot: 'COVERED', road: 'OVERLAP', path: 'OVERLAP', body: 'OVERLAP', beside: 'OVERLAP', held: 'OVERLAP' });

/**
 * The non-additive edits of a revision IR (§2.2): a part, lot, road or body id the standing region already has, a part or lot id without
 * the revision's prefix, and any removal or change the IR's revision member names. [{what, id}].
 */
export function nonAdditive(ir, st) {
  const rv = ir.revision;
  if (!rv) return [];
  // (a plan/0 revision keeps the plan's own part ids, §9: `naming: plan`; a planRevision's are prefixed rv<rid>_)
  const pre = rv.naming === 'plan' ? '' : ridPrefix(rv.rid);
  const out = [];
  const has = (list, id) => (list ?? []).includes(id);
  for (const p of ir.parts ?? []) if (has(st.ids?.parts, p.id) || !p.id.startsWith(pre)) out.push({ what: 'part', id: p.id });
  for (const l of ir.lots ?? []) if (has(st.ids?.lots, l.id) || !l.id.startsWith(pre)) out.push({ what: 'lot', id: l.id });
  for (const r of ir.roads ?? []) if (has(st.ids?.roads, r.id)) out.push({ what: 'road', id: r.id });
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) if (o.op === 'fluid' && has(st.ids?.bodies, o.id)) out.push({ what: 'body', id: o.id });
  for (const n of ir.graph?.nodes ?? []) if (has(st.ids?.nodes, n.id)) out.push({ what: 'node', id: n.id });
  for (const k of ['remove', 'change']) for (const id of rv[k] ?? []) out.push({ what: k, id });
  return out;
}

/** The refill problems (§4.6): a lot not standing, not `pad` or `removed`, or irrigated (S-RV-14). [{lot, why}]. */
export function refillProblems(ids, st) {
  const out = [];
  for (const id of ids ?? []) {
    const l = st.lots?.[id];
    if (!l) out.push({ lot: id, why: 'no_lot' });
    else if (l.irrigated) out.push({ lot: id, why: 'irrigated' });
    else if (!(l.state === 'pad' || l.state === 'removed')) out.push({ lot: id, why: `state_${String(l.state).replace(/[^a-z_]/g, '_').slice(0, 24)}` });
  }
  return out;
}

/**
 * M29:revision over a built virtual world `vw` of revision IR `ir` (the checker's rule, check.mjs): pushes error findings and returns the
 * metrics {cells, columns, byKind, nonAdditive, unfinished, lots}. Reads only ctx.standing and the written cells; independent of the
 * program's guard.
 */
export function reviseRules({ ir, vw, standing, findings, finding }) {
  const K = standingClasses(standing);
  const m = { cells: 0, columns: 0, byKind: {}, nonAdditive: 0, unfinished: 0, lots: 0 };
  const bad = new Map(); // kind -> [[x, y, z]]
  const cols = new Set();
  const tiles = new Set();
  vw.eachWritten((x, y, z) => {
    m.cells++;
    const k = k2(x, z);
    tiles.add(tileOf(x, z));
    if (cols.has(k)) return;
    cols.add(k);
    const p = columnProblem(K, x, z);
    if (!p) return;
    if (!bad.has(p.kind)) bad.set(p.kind, []);
    bad.get(p.kind).push([x, y, z]);
  });
  m.columns = cols.size;
  // the added lots: their boxes plus 1 against the standing classes (a lot is a box, never a written cell in the virtual world)
  for (const l of ir.lots ?? []) {
    let hit = null;
    for (let x = l.box.minX - 1; x <= l.box.maxX + 1 && !hit; x++) for (let z = l.box.minZ - 1; z <= l.box.maxZ + 1 && !hit; z++) {
      tiles.add(tileOf(x, z));
      const p = columnProblem(K, x, z);
      if (p) hit = [p.kind, [x, l.box.minY, z]];
    }
    if (hit) { m.lots++; if (!bad.has(hit[0])) bad.set(hit[0], []); bad.get(hit[0]).push(hit[1]); }
  }
  for (const [kind, list] of [...bad].sort(([a], [b]) => (a < b ? -1 : 1))) {
    m.byKind[kind] = list.length;
    findings.push(finding('M29:revision', null, null, list.length, list.slice(0, 32), `${list.length} column(s) of the revision write where ${kindText(kind)} (${PROBLEM_CODE[kind]} {kind: ${kind}})`));
  }
  const na = nonAdditive(ir, standing);
  if (na.length) { m.nonAdditive = na.length; findings.push(finding('M29:revision', null, null, na.length, [], `not additive: ${na.slice(0, 8).map((q) => `${q.what} ${q.id}`).join(', ')} (NOT_ALLOWED {why: not_additive})`)); }
  const unf = [...tiles].filter((t) => K.unfinished.has(t)).sort();
  if (unf.length) { m.unfinished = unf.length; findings.push(finding('M29:revision', null, null, unf.length, [], `the revision meets ${unf.length} unfinished tile(s) of the region: ${unf.slice(0, 8).join(' ')} (NOT_ALLOWED {why: unfinished})`)); }
  const rf = refillProblems(ir.revision?.lots?.refill ?? [], standing);
  if (rf.length) findings.push(finding('M29:revision', null, null, rf.length, [], `refill: ${rf.map((q) => `${q.lot} (${q.why})`).join(', ')} (NOT_ALLOWED)`));
  return m;
}

function kindText(kind) {
  return ({
    claim: 'the region\'s claim ends', protected: 'the owner\'s protected area is', lot: 'a standing lot box (plus 1) is', road: 'a standing road (plus 1) is',
    path: 'a standing path or path-set cell is', body: 'a standing body\'s hard or watch cells are', beside: 'a beside region\'s reach or hold column is',
    held: 'another site, or the region\'s own non-terrain write, holds the column',
  })[kind] ?? kind;
}

/**
 * The plan-time guard (planRegion runs it for an IR with a `revision` member): the first refusal, as `Error('<CODE>: [<kind>] message')`
 * (the mod reads the code and the bracketed kind), or nothing. `unsafe` (the program's `_unsafe`, a broken variant): the matching class
 * is let through, so the checker's M29 must catch it.
 */
export function reviseGuard({ ir, vw = null, cells = null, standing, unsafe = {} }) {
  // (the intended cells, conditions aside: a write the plan's world skips by condition may still land at the realise; `vw`, the virtual
  // world's writes, when no cell list is given)
  const each = cells ? (cb) => { for (const c of cells) cb(c[0], c[1], c[2]); } : (cb) => vw.eachWritten(cb);
  const na = unsafe.removePart ? [] : nonAdditive(ir, standing);
  if (na.length) throw new Error(`NOT_ALLOWED: [not_additive] the revision names standing or unprefixed ${na.slice(0, 4).map((q) => `${q.what} ${q.id}`).join(', ')} (a revision only adds)`);
  const rf = refillProblems(ir.revision?.lots?.refill ?? [], standing);
  if (rf.length) throw new Error(`NOT_ALLOWED: [${rf[0].why === 'irrigated' ? 'irrigated' : 'refill'}] refill ${rf.map((q) => `${q.lot} (${q.why})`).join(', ')}`);
  const K = standingClasses(standing);
  let first = null, n = 0;
  const tiles = new Set();
  const seen = new Set();
  each((x, y, z) => {
    tiles.add(tileOf(x, z));
    const k = k2(x, z);
    if (seen.has(k)) return;
    seen.add(k);
    const p = columnProblem(K, x, z, unsafe);
    if (!p) return;
    n++;
    if (!first) first = { ...p, at: [x, y, z] };
  });
  for (const l of ir.lots ?? []) for (let x = l.box.minX - 1; x <= l.box.maxX + 1; x++) for (let z = l.box.minZ - 1; z <= l.box.maxZ + 1; z++) {
    tiles.add(tileOf(x, z));
    const p = columnProblem(K, x, z, unsafe);
    if (p) { n++; if (!first) first = { ...p, at: [x, l.box.minY, z], lot: l.id }; }
  }
  if (first) {
    const who = first.id ? ` ${first.id}` : first.region ? ` ${first.region}` : '';
    throw new Error(`${PROBLEM_CODE[first.kind]}: [${first.kind}] ${n} column(s) of the revision write where ${kindText(first.kind)}${who}; first at (${first.at.join(', ')})`);
  }
  const unf = [...tiles].filter((t) => K.unfinished.has(t)).sort();
  if (unf.length) throw new Error(`NOT_ALLOWED: [unfinished] the revision meets unfinished tile(s) ${unf.slice(0, 8).join(' ')} of the region`);
}

/**
 * The effective IR (§2.3): `base` (the realised plan's IR) merged with `revisions` ([{rid, position, ir, irSha?}], accepted, any order:
 * merged by position) — parts, lots, roads and the graph appended, the base's stages and tiles kept, plus `revisions` (each one's rid,
 * position, irSha, stages and what it added) and `head`. Data for readers; never evaluated as one IR.
 */
export function mergeEffective(base, revisions = []) {
  const revs = [...revisions].sort((a, b) => a.position - b.position);
  const out = JSON.parse(JSON.stringify(base));
  out.parts = [...(out.parts ?? [])];
  out.lots = [...(out.lots ?? [])];
  out.roads = [...(out.roads ?? [])];
  const nodes = [...(out.graph?.nodes ?? [])], edges = [...(out.graph?.edges ?? [])];
  const list = [];
  for (const r of revs) {
    const ir = r.ir;
    for (const p of ir.parts ?? []) out.parts.push({ ...JSON.parse(JSON.stringify(p)), rid: r.rid });
    for (const l of ir.lots ?? []) out.lots.push({ ...JSON.parse(JSON.stringify(l)), rid: r.rid });
    for (const x of ir.roads ?? []) out.roads.push({ ...JSON.parse(JSON.stringify(x)), rid: r.rid });
    for (const n of ir.revision?.graph?.nodes ?? ir.graph?.nodes ?? []) nodes.push(JSON.parse(JSON.stringify(n)));
    for (const e of ir.revision?.graph?.edges ?? ir.graph?.edges ?? []) edges.push(JSON.parse(JSON.stringify(e)));
    list.push({ rid: r.rid, position: r.position, irSha: r.irSha ?? sha256Hex(canonicalJson(ir)), stages: [...(ir.stages ?? [])],
      parts: (ir.parts ?? []).map((p) => p.id), lots: { add: (ir.lots ?? []).map((l) => l.id), refill: [...(ir.revision?.lots?.refill ?? [])] }, roads: (ir.roads ?? []).map((x) => x.id) });
  }
  if (nodes.length || edges.length) out.graph = { nodes, edges };
  out.revisions = list;
  out.head = revs.length ? revs[revs.length - 1].rid : 0;
  return out;
}

/** The tile keys "tx,tz" a revision IR writes in (every stage and set), sorted: the candidate's dirty keys (§3.4, §9.3). */
export function dirtyKeys(ir) {
  const keys = new Set();
  for (const s of ir.stages ?? []) for (const set of ['terrain', 'path']) for (const k of ir.tiles?.[s]?.[set] ?? []) keys.add(k);
  return [...keys].sort();
}

/**
 * The revision IR of `request` ({parts: [{id, call}], refill: [lotId], _unsafe?}) against `effective` (the effective IR) and `standing`
 * (ctx.standing): plans the bundled `revise` program over `survey` with the base's claim and roles, `seed = revisionSeed(base seed, rid)`.
 * `ctx`: {rid, position, parent: {rid, irSha}, base: {irSha}, survey, standing, roles?, fluids?, volumes?}. Throws the guard's refusal.
 */
export async function reviseIR(effective, request, ctx) {
  const { planRegion } = await import('./plan.mjs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const c = effective.claim;
  return planRegion({
    programFile: path.join(here, '..', '..', 'regions', 'revise.mjs'),
    params: { spec: { parts: request.parts ?? [], refill: request.refill ?? [], ...(request.unsafe ? { unsafe: request.unsafe } : {}) } },
    survey: ctx.survey, claim: { minX: c.minX, minZ: c.minZ, maxX: c.maxX, maxZ: c.maxZ, minY: ctx.claimY?.[0] ?? c.minY, maxY: ctx.claimY?.[1] ?? c.maxY },
    seed: revisionSeed(effective.seed ?? '0', ctx.rid), roles: ctx.roles ?? effective.roles ?? {}, ...(ctx.fluids ? { fluids: ctx.fluids } : {}),
    volumes: ctx.volumes ?? [], node: ctx.node ?? undefined, kitVersion: ctx.kitVersion ?? undefined,
    revision: { rid: ctx.rid, position: ctx.position, parent: ctx.parent ?? { rid: 0, irSha: effective.revisions?.length ? null : null }, base: ctx.base ?? null, effective, standing: ctx.standing },
  });
}

/**
 * Every cell a revision IR intends to write (every stage and set, conditions aside), `[[x, y, z]]`, from the kit's own evaluation over
 * `survey` (columns). `blobs`: sha -> bytes.
 */
export async function intendedCells(ir, survey, blobs) {
  const { evalTile } = await import('../realise.mjs');
  const { unpack, FLAG_MISSING } = await import('./pack.mjs');
  const { windowFromSurvey } = await import('./survey.mjs');
  const out = [];
  const wins = new Map();
  for (const s of ir.stages ?? []) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[s]?.[set] ?? []) {
    let w = wins.get(key);
    if (!w) { w = windowFromSurvey(survey, key); w.flags.forEach((f, i) => { w.flags[i] = f & ~FLAG_MISSING; }); wins.set(key, w); }
    const e = evalTile(ir, key, w, { stage: s, set, blobs });
    for (const c of unpack(e.payload).cells) out.push([c.x, c.y, c.z]);
  }
  return out;
}

/** Row runs of a column set (re-exported for the mod's parity tests). */
export { keyRuns };
