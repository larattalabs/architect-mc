// (6c P0) After plan_v0's plan (docs/CONTRACT.md P0 §3, §4, §6, §7): the per-part cost (each tile of every stage and set evaluated
// over the plan survey, its cells counted per IR part and summed per plan part), maxCells, the provisional ranges (lots with no
// library entry, pending styles), the overall result, the light preview (per-part bounds and a 1:4 class map PNG) and, for READY or
// NEEDS_REPAIR, the resolved artifact: canonical JSON with no ids, timestamps or paths, named by its sha. Pure but for the PNG
// bytes it returns; tools/region.mjs writes the files.
import { evalTile } from '../realise.mjs';
import { canonicalJson, sha256Hex, FLAG_MISSING, FLAG_WATER } from '../region/pack.mjs';
import { windowFromSurvey } from '../region/survey.mjs';
import { encodePng } from '../png.mjs';
import { planCatalogue, PLAN_API } from './catalogue.mjs';
import { PROVISIONAL_BAND } from './compile.mjs';
// (6c VOC-b) the answers' cost.rarity and cost.creativeOnly (docs/CONTRACT.md "Phase 6c slice VOC" §4.4)
import { measureRarity } from '../vocab/budget.mjs';
import { tierOf } from '../vocab.mjs';

export const ARTIFACT_FORMAT = 'plan-artifact/0';
export const CHECK_FORMAT = 'plan-check/0';
const OK = new Set(['fits', 'adjusted']);

/** Every tile's sha and per-IR-part counts: {tiles: {stage: {terrain: {key: sha}, path: {...}}}, parts: {irPart: {removed, placed}}, cells}. */
export function evalAll(ir, survey, blobs) {
  const tiles = {}, parts = {};
  const survival = ir.survival ? {} : null; // (6c RS) per target group: free, held, paid, bom, charged, creativeOnly
  let cells = 0;
  const windows = new Map();
  for (const s of ir.stages) {
    tiles[s] = { terrain: {}, path: {} };
    for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[s]?.[set] ?? []) {
      let w = windows.get(key);
      if (!w) { w = windowFromSurvey(survey, key); w.flags.forEach((f, i) => { w.flags[i] = f & ~FLAG_MISSING; }); windows.set(key, w); }
      const e = evalTile(ir, key, w, { stage: s, set, blobs });
      tiles[s][set][key] = e.sha;
      cells += e.count;
      for (const [pid, c] of Object.entries(e.notes.parts)) { const o = (parts[pid] ??= { removed: 0, placed: 0 }); o.removed += c.removed; o.placed += c.placed; }
      if (survival) for (const [g, x] of Object.entries(e.notes.survival ?? {})) addSurvival((survival[g] ??= { free: 0, held: 0, paid: 0, bom: {}, charged: {}, creativeOnly: {} }), x);
    }
  }
  return { tiles, parts, cells, ...(survival ? { survival } : {}) };
}

/** (6c RS) Adds one tile's group stats into a running total. */
function addSurvival(t, x) {
  t.free += x.free; t.held += x.held; t.paid += x.paid;
  for (const k of ['bom', 'charged', 'creativeOnly']) for (const [i, n] of Object.entries(x[k] ?? {})) t[k][i] = (t[k][i] ?? 0) + n;
}

const sortedItems = (m) => Object.fromEntries(Object.entries(m).filter(([, n]) => n).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * (6c RS, §3) A part's `cost.survival` from its group's stats: `{free, held, bom, charged?, creativeOnly?}` (free: the free pass's cells,
 * held: the free cells it builds with its paid ones, bom: the paid cells' bill, which the mod puts on its targets; charged: what its bodies'
 * writes take, a lava bucket per lava source and the grates' iron bars).
 */
export function survivalCostOf(st) {
  const o = { free: st?.free ?? 0, held: st?.held ?? 0, bom: sortedItems(st?.bom ?? {}) };
  if (st && Object.keys(sortedItems(st.charged)).length) o.charged = sortedItems(st.charged);
  if (st && Object.keys(st.creativeOnly).length) o.creativeOnly = sortedItems(st.creativeOnly);
  return o;
}

/** The overall result (§3). */
export function overallOf(answers, { malformed = false } = {}) {
  if (malformed) return 'MALFORMED';
  if (answers.some((a) => a.class === 'incomplete')) return 'INCOMPLETE';
  if (answers.some((a) => a.required && ['unsupported', 'refused', 'blocked', 'malformed'].includes(a.class))) return 'REQUIRED_BLOCKED';
  if (answers.some((a) => !OK.has(a.class))) return 'NEEDS_REPAIR';
  return 'READY';
}

/**
 * Finish a check. `res`: planRegion's result for plan_v0; `survey`: the plan survey (bytes); `blobs`: sha -> bytes. Returns
 * `{check, artifact, artifactSha, classMap: png bytes, cacheOut}`.
 */
export function finishCheck({ res, survey, blobs = null, surveyBytesSha = null, inputs = {} }) {
  const pc = res.meta.planCheck;
  const ir = res.ir;
  const catalogue = planCatalogue();
  const answers = pc.answers.map((a) => JSON.parse(JSON.stringify(a)));
  const notes = [...(pc.notes ?? [])];
  const surveySha = surveyBytesSha ?? pc.surveySha;
  const base = { format: CHECK_FORMAT, schemaVersion: 'plan/0', kitVersion: ir.kitVersion, api: PLAN_API, catalogueVersion: catalogue.catalogueVersion, surveySha, irSha: res.irSha,
    planSha: sha256Hex(canonicalJson(inputs.plan ?? ir.params.plan ?? {})), budget: pc.budget ?? null };
  if (pc.malformed) {
    return { check: { ...base, overall: 'MALFORMED', malformed: pc.malformed, parts: [], cost: null, catalogue, preview: null, artifactSha: null, notes }, artifact: null, artifactSha: null, classMap: null, cacheOut: {} };
  }
  // ---- cost: cells per IR part, then per plan part
  // ((6c D3) a reach plan's tiles over the reach frame's survey: its reach columns lie in a standing town's claim)
  const ev = evalAll(ir, res.evalSurvey ?? survey, (sha) => (blobs ? blobs(sha) : null));
  const byPlan = new Map();
  const add = (pid, c) => { if (!pid) return; const o = byPlan.get(pid) ?? { removed: 0, placed: 0 }; o.removed += c.removed; o.placed += c.placed; byPlan.set(pid, o); };
  for (const [irPart, c] of Object.entries(ev.parts)) {
    const owner = pc.partOf[irPart] ?? null;
    if (owner && owner.startsWith('routes:')) {
      // a route pass's part is shared: its cells go to its connectors by the length of their legs
      const ids = owner.slice(7).split(',');
      const len = ids.map((id) => (answers.find((a) => a.part === id)?.geometry?.legs ?? []).reduce((n, l) => n + l.length, 0));
      const tot = len.reduce((a, b) => a + b, 0) || 1;
      let gr = 0, gp = 0;
      ids.forEach((id, i) => {
        const last = i === ids.length - 1;
        const rr = last ? c.removed - gr : Math.floor((c.removed * len[i]) / tot), pp = last ? c.placed - gp : Math.floor((c.placed * len[i]) / tot);
        gr += rr; gp += pp;
        add(id, { removed: rr, placed: pp });
      });
    } else if (owner && !owner.startsWith('__')) add(owner, c);
  }
  const tilesOf = (pid) => {
    // tiles a plan part's IR parts touch: the tiles whose evaluation named them (approximated per IR part from the IR's ops bounds)
    const mine = new Set(Object.entries(pc.partOf).filter(([, o]) => o === pid || (o && o.startsWith('routes:') && o.slice(7).split(',').includes(pid))).map(([k]) => k));
    const keys = new Set();
    for (const p of ir.parts) if (mine.has(p.id)) for (const op of p.ops) {
      const b = op.bounds;
      for (let tx = Math.floor(Math.max(b.minX, ir.claim.minX) / 64); tx <= Math.floor(Math.min(b.maxX, ir.claim.maxX) / 64); tx++) for (let tz = Math.floor(Math.max(b.minZ, ir.claim.minZ) / 64); tz <= Math.floor(Math.min(b.maxZ, ir.claim.maxZ) / 64); tz++) keys.add(`${tx},${tz}`);
    }
    return keys.size;
  };
  // ---- maxCells (a count cap: deterministic)
  const cellCap = pc.budget?.maxCells ?? 20_000_000;
  const overCells = ir.budget.cells > cellCap;
  for (const a of answers) {
    if (!OK.has(a.class)) continue;
    const c = byPlan.get(a.part) ?? { removed: 0, placed: 0 };
    if (overCells && (c.removed || c.placed)) {
      a.class = 'incomplete';
      a.reasons = [{ code: 'BUDGET', message: `the plan writes ${ir.budget.cells} cells, over the check's maxCells ${cellCap}`, evidence: { cap: 'maxCells', cells: ir.budget.cells } }];
      delete a.deviations; delete a.wouldFit;
      continue;
    }
    a.cost = { cells: c.removed + c.placed, removed: c.removed, added: c.placed, tiles: tilesOf(a.part) };
    // (7a K1) a wall's, gate's or rope bridge's exact bill of materials (its emitted cells by C26's block-to-item rules: kit/lib/connectors/bom.mjs)
    if (pc.links?.bom?.[a.part]) a.cost.bom = { ...pc.links.bom[a.part] };
    // (6c RS, §3) a survival check: the part's free, held and paid cells, and the paid cells' bill (what the mod puts on its targets)
    if (ev.survival) a.cost.survival = survivalCostOf(ev.survival[a.part]);
    // (6c VOC) cost.rarity: present only when the plan's bible carries `rarity`, or the part writes a precious block that isn't the style's
    // own; cost.creativeOnly: only when the part writes a creative-only block (regions stay INSTANT: information for the caller)
    if (pc.vocabCells) {
      const v = vocabCostOf(a.part, pc, res.meta?.vocab);
      if (v.rarity) a.cost.rarity = v.rarity;
      if (v.creativeOnly) a.cost.creativeOnly = v.creativeOnly;
    }
  }
  // ---- provisional parts: a lot with no library entry, a pending style (R13): the lot's cost band and fit box
  const lots = [];
  for (const a of answers) {
    if (!OK.has(a.class) || !a.geometry?.lots) continue;
    const style = pc.styles?.[a.part] ?? null;
    const pending = !!style?.pending;
    let lo = 0, hi = 0;
    // ((7a K3) a wall's geometry.lots names its lots on the line ({lot, at, box}): they are its zone's lots (listed by the zone), not more)
    for (const l of a.geometry.lots) {
      if (typeof l.id !== 'string') continue;
      const entry = pc.lotEntries?.[l.id] ?? null;
      const prov = pending || !entry;
      const [x0, y0, z0, x1, y1, z1] = l.box;
      const cols = (x1 - x0 + 1) * (z1 - z0 + 1);
      const band = [cols * PROVISIONAL_BAND[0], cols * PROVISIONAL_BAND[1]];
      const m = pc.lotMeta?.[l.id] ?? {};
      lots.push({ id: l.id, zone: a.part, box: l.box, role: m.role ?? null, label: m.label ?? null, ext: m.ext ?? null, front: l.front ?? null, entrance: l.entrance ?? null, entry, provisional: prov, ...(prov ? { costRange: band, fitBox: l.box } : {}), ...(pending ? { pendingStyle: style.pending } : {}), ...(pc.irrigation?.[l.id] ? { irrigation: pc.irrigation[l.id] } : {}), ...(pc.wallLots?.[l.id] ? pc.wallLots[l.id] : {}) });
      if (prov) { lo += band[0]; hi += band[1]; }
    }
    if (a.provisional) a.cost = { ...(a.cost ?? {}), range: { cells: [(a.cost?.cells ?? 0) + lo, (a.cost?.cells ?? 0) + hi] } };
  }
  const overall = overallOf(answers);
  const totals = answers.reduce((t, a) => {
    if (!a.cost) return t;
    t.cells += a.cost.cells ?? 0; t.removed += a.cost.removed ?? 0; t.added += a.cost.added ?? 0;
    const r = a.cost.range?.cells ?? [a.cost.cells ?? 0, a.cost.cells ?? 0];
    t.range[0] += r[0]; t.range[1] += r[1];
    return t;
  }, { cells: 0, removed: 0, added: 0, range: [0, 0] });
  const cost = { cells: ir.budget.cells, removed: ir.budget.removed, added: ir.budget.added, tiles: Object.values(ev.tiles).reduce((n, s) => n + Object.keys(s.terrain).length + Object.keys(s.path).length, 0),
    parts: { cells: totals.cells, removed: totals.removed, added: totals.added }, ...(lots.some((l) => l.provisional) ? { range: { cells: [ir.budget.cells + totals.range[0] - totals.cells, ir.budget.cells + totals.range[1] - totals.cells] } } : {}),
    ...(ev.survival ? survivalBomOf(ev.survival) : { bom: null, bomNote: 'regions are INSTANT only: no BOM' }) };
  // ---- the light preview: per-part bounds and the class map
  const bounds = {};
  for (const a of answers) if (a.geometry?.rect) bounds[a.part] = a.geometry.rect;
  const classMap = classMapPng(ir.claim, survey, answers, pc);
  const preview = { bounds, classMap: { file: 'classmap.png', scale: 4, width: classMap.width, height: classMap.height, legend: LEGEND } };
  // ---- the artifact (READY or NEEDS_REPAIR, and never after the time or memory cap)
  let artifact = null, artifactSha = null;
  // ((6c S3) a bundled program that compiles a fixed plan/0 itself (terraced_monastery) has no plan param: its check is recorded, but it
  // makes no artifact (an artifact names the plan it approves; every plan_v0 check has one, as before))
  if ((overall === 'READY' || overall === 'NEEDS_REPAIR') && !pc.hit && (inputs.plan ?? ir.params.plan) !== undefined) {
    artifact = {
      format: ARTIFACT_FORMAT, schemaVersion: 'plan/0', catalogueVersion: catalogue.catalogueVersion, kitVersion: ir.kitVersion, api: PLAN_API,
      plan: inputs.plan ?? ir.params.plan, planSha: sha256Hex(canonicalJson(inputs.plan ?? ir.params.plan)),
      inputs: {
        claim: { minX: ir.claim.minX, minZ: ir.claim.minZ, maxX: ir.claim.maxX, maxZ: ir.claim.maxZ }, anchors: pc.anchors, surveySha, surveyRes: inputs.surveyRes ?? 1,
        protection: ir.params.fingerprint?.sha ?? null, bible: ir.params.bible ?? null, seed: ir.seed, kitVersion: ir.kitVersion, budget: pc.budget,
      },
      region: { program: ir.id, irSha: res.irSha, irFormat: ir.format, requires: ir.requires ?? [], blobs: Object.fromEntries(Object.entries(ir.blobs ?? {}).filter(([, b]) => b.sha).map(([n, b]) => [n, b.sha])), stages: ir.stages, tiles: ev.tiles },
      // (6c RS, §3) checked in survival: realiseApproved in the other mode refuses it ARTIFACT_STALE
      ...(ir.survival ? { survival: true } : {}),
      parts: answers.map((a) => ({ part: a.part, class: a.class, block: a.block, ...(a.geometry ? { geometry: a.geometry } : {}), ...(a.cost ? { cost: a.cost } : {}), ...(a.provisional ? { provisional: true } : {}), ...(a.ext ? { ext: a.ext } : {}) })),
      lots, dropped: answers.filter((a) => !OK.has(a.class)).map((a) => ({ part: a.part, class: a.class, block: a.block })), overall,
      // (6c T3b, §6) the tunnels' guard cells (void, shell, 2-cell buffer) and the frozen volume each was checked against:
      // realiseApproved compares their classes with the world now (ARTIFACT_STALE on a change). Only in a plan with a tunnel
      ...(pc.links?.guards?.length ? { guards: pc.links.guards.filter((g) => answers.some((a) => a.part === g.part && OK.has(a.class))) } : {}),
      // (6c VOC-c, §4) each palette rule with lots in scope: what realiseApproved measures again (the family's blocks, the unmeasured
      // blocks, the parts' counts, the bound lots' counts at check time). Only in a plan with one
      ...(pc.paletteRows?.length ? { palette: pc.paletteRows } : {}),
    };
    artifactSha = sha256Hex(canonicalJson(artifact));
  }
  // (6c H §10) a part took the wet fallback (the plan meta's wet records, or a wet write that asked a volume and rolled back:
  // meta.wetAsked): the game's check plans twice for its water columns
  const check = { ...base, overall, parts: answers, cost, catalogue, preview, artifactSha, notes, ...((res.meta?.wet ?? []).length || res.meta?.wetAsked ? { wetAsked: true } : {}), ...(ir.survival ? { survival: true } : {}) };
  return { check, artifact, artifactSha, classMap: classMap.png, cacheOut: pc.hit || overall === 'INCOMPLETE' ? cacheOnlyAnswered(pc.cacheOut, answers) : pc.cacheOut };
}

/**
 * (6c RS, §3) The whole plan's bill in survival: every group's paid cells and charged items (the parts', a shared route's, the route lamps'
 * and the plan's own helper parts'); the bound lots' design bills (C26's bomFull) and the 4e roads' bills are the game's (it adds them).
 */
export function survivalBomOf(sv) {
  const bom = {};
  for (const st of Object.values(sv)) for (const k of ['bom', 'charged']) for (const [i, n] of Object.entries(st[k] ?? {})) bom[i] = (bom[i] ?? 0) + n;
  return { bom: sortedItems(bom), bomNote: 'the regions\' cells only: the bound lots\' design bills (bomFull) and the 4e roads\' bills are added by the game' };
}

/**
 * (6c VOC) A plan part's cost members from the compile pass's per-IR-part cells (meta.planCheck.vocabCells): the IR parts it owns (a shared
 * route part counts for each of its connectors). Returns {rarity?, creativeOnly?}.
 */
export function vocabCostOf(pid, pc, vocab) {
  const hist = {}, creative = {};
  for (const [irPart, owner] of Object.entries(pc.partOf ?? {})) {
    if (!(owner === pid || (owner && owner.startsWith('routes:') && owner.slice(7).split(',').includes(pid)))) continue;
    const c = pc.vocabCells[irPart];
    if (!c) continue;
    for (const [b, n] of Object.entries(c.hist)) hist[b] = (hist[b] ?? 0) + n;
    for (const [b, n] of Object.entries(c.creative)) creative[b] = (creative[b] ?? 0) + n;
  }
  const style = { opted: !!vocab?.opted, rarity: vocab?.rarity, own: new Set(vocab?.own ?? []) };
  const out = {};
  const foreignPrecious = Object.keys(hist).some((b) => tierOf(b) === 'precious' && !style.own.has(b));
  if (style.opted || foreignPrecious) out.rarity = measureRarity(hist, style, 'region');
  if (Object.keys(creative).length) out.creativeOnly = Object.fromEntries(Object.entries(creative).sort());
  return out;
}

/** An INCOMPLETE check keeps only what its answered parts produced (nothing cached as fits for a part that has no answer). */
function cacheOnlyAnswered(cacheOut, answers) {
  void answers;
  return cacheOut ?? {};
}

export const LEGEND = Object.freeze({ terrain: [96, 120, 72], water: [48, 96, 200], protected: [200, 60, 60], zone: [220, 200, 140], lot: [150, 90, 50], route: [80, 80, 80], form: [170, 170, 190], refused: [255, 120, 0] });

/** The 1:4 top-down class map (at most 256x256): water, protected areas, zone rects, forms, lots, routes. */
export function classMapPng(claim, survey, answers, pc) {
  const W = Math.ceil((claim.maxX - claim.minX + 1) / 4), D = Math.ceil((claim.maxZ - claim.minZ + 1) / 4);
  const px = new Uint8Array(W * D * 4);
  const set = (x, z, c) => { const i = Math.floor((x - claim.minX) / 4), j = Math.floor((z - claim.minZ) / 4); if (i < 0 || j < 0 || i >= W || j >= D) return; const k = (i + j * W) * 4; px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255; };
  const s = survey && typeof survey === 'object' && 'flags' in survey ? survey : null;
  for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) set(claim.minX + i * 4, claim.minZ + j * 4, LEGEND.terrain);
  if (s) for (let j = 0; j < s.depth; j++) for (let i = 0; i < s.width; i++) if (s.flags[i + j * s.width] & FLAG_WATER) set(s.minX + i * s.resolution, s.minZ + j * s.resolution, LEGEND.water);
  const rect = (q, c) => { for (let z = q[1]; z <= q[3]; z += 2) for (let x = q[0]; x <= q[2]; x += 2) set(x, z, c); };
  for (const a of pc.protectedRects ?? []) rect(a, LEGEND.protected);
  for (const a of answers) {
    const g = a.geometry;
    if (!g) continue;
    if (g.rect) rect(g.rect, OK.has(a.class) ? (a.block?.startsWith('zone') ? LEGEND.zone : LEGEND.form) : LEGEND.refused);
    for (const l of g.lots ?? []) rect([l.box[0], l.box[2], l.box[3], l.box[5]], LEGEND.lot);
    for (const leg of g.legs ?? []) for (let k = 0; k + 1 < leg.path.length; k++) {
      const [x0, , z0] = leg.path[k], [x1, , z1] = leg.path[k + 1];
      const n = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), 1);
      for (let t = 0; t <= n; t++) set(x0 + Math.floor(((x1 - x0) * t) / n), z0 + Math.floor(((z1 - z0) * t) / n), LEGEND.route);
    }
  }
  return { png: encodePng(W, D, px), width: W, height: D };
}
