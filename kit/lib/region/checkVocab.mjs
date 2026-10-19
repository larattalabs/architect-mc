// (6c VOC-b) The region checker's vocabulary rules (docs/CONTRACT.md "Phase 6c slice VOC" §5.2) on a virtual or realised world
// (vworld.mjs): M26 (rarity, over the non-terrain written cells), M27 (vocabulary misuse: state, convert, role, drift, creative) and M20
// widened ((a) every fire, soul fire or exposed lava cell the IR writes; (b) natural lava within reach of a plan-written flammable).
// The plan compile runs the same scan over each pass's IR (vocabRefusals): an M27:state or M27:convert error refuses the writing part
// VOCAB, an M20 (a) error FIRE (H's code), and the part is planned again as refused (kit/lib/region/plan.mjs).
//
// "Non-terrain written cells" (the shares' denominator, §4.1): written cells that are not air, not a fluid source, and not a common
// natural block (a natural voxel class at tier common: the stone, dirt, grass and sand that terrain ops write). Lanterns, chains, planks,
// concrete, blackstone (uncommon) and amethyst (rare) count wherever they are written.
import { F_WRITTEN, parseState } from './vworld.mjs';
import { BLOCKS } from '../blocks.mjs';
import { drifts, fitsRole, tierOf } from '../vocab.mjs';
import { CREATIVE_ONLY } from '../vocab/survival.mjs';
import { FIRE_REACH_TABLE, HAZARD, driftsWhere, hazardKindOf, isLogName, isPairOf, measureRarity, pairOffset, waterReachOffsets } from '../vocab/budget.mjs';
import { bodiesOf } from './checkFluids.mjs';
import { FLAG_LAVA } from './pack.mjs';

const NATURAL = new Set(['ROCK', 'SOIL', 'LOOSE', 'SNOW', 'ICE']);
const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const k3 = (x, y, z) => `${x},${y},${z}`;
const MAX_SAMPLE = 16;

/** The block states an IR's text names that could make an M27 or M20 (a) error (the compile pass's pre-filter). */
export const VOCAB_ERROR_STATES = /waterlogged=true|_concrete_powder|minecraft:sponge\b|minecraft:magma_block|minecraft:soul_sand|minecraft:(soul_)?fire\b|minecraft:lava\b|"fluid":"lava"|_door\b|_bed\b|minecraft:(tall_grass|large_fern|lilac|peony|rose_bush|sunflower|pitcher_plant|tall_seagrass|small_dripleaf)\b/;

/** The block names an IR's text holds when a part may gain `cost.rarity` or `cost.creativeOnly` without an opted-in bible (precious or
 * creative-only blocks; finish.mjs's pre-filter). */
export const COST_STATES = new RegExp(`minecraft:(${[...Object.keys(BLOCKS).filter((b) => tierOf(b) === 'precious'), ...CREATIVE_ONLY].map((b) => b.replace('minecraft:', '')).sort().join('|')})(?![a-z0-9_])`);

/** Per palette index: the parsed state and the facts the rules read (cached on the palette). */
function factsOf(P) {
  const c = (P._vocab ??= { n: 0, f: [] });
  for (; c.n < P.states.length; c.n++) {
    const st = parseState(P.states[c.n]);
    const known = !!BLOCKS[st.name];
    const row = BLOCKS[st.name];
    const air = P.air[c.n];
    const fluid = st.name === 'minecraft:water' || st.name === 'minecraft:lava' || st.name === 'minecraft:bubble_column';
    const tier = known ? tierOf(st.name) : null;
    c.f.push({
      st, name: st.name, known,
      measured: known && !air && !fluid && !(NATURAL.has(row.v) && tier === 'common'),
      logged: st.props.waterlogged === 'true',
      pair: known ? pairOffset(st) : null,
      hazard: hazardKindOf(st.name),
      drift: known && !air && drifts(st),
      creative: CREATIVE_ONLY.has(st.name),
    });
  }
  return c.f;
}

/** Natural lava at a cell: the base world's (a frozen volume's lava, a survey LAVA column's fluid cells). */
function natLavaOf(vw) {
  const P = vw.pal;
  const cols = vw.survey ?? null;
  return (x, y, z) => {
    if (P.lava[vw.base(x, y, z)]) return true;
    if (!cols || !vw.inClaim(x, z)) return false;
    const i = Math.min(cols.width - 1, Math.max(0, Math.floor((x - cols.minX) / cols.resolution))) + Math.min(cols.depth - 1, Math.max(0, Math.floor((z - cols.minZ) / cols.resolution))) * cols.width;
    return (cols.flags[i] & FLAG_LAVA) !== 0 && y > cols.floor[i] && y <= cols.ground[i];
  };
}

/**
 * The scan. `vw`: the world; `ir`; `meta` (the plan meta: `vocab` {roles, own, rarity?, opted}); `irParts`: limit the scan to these IR
 * part indexes (null: all); `lava`: whether the world may hold natural lava (null: unknown, look). Returns `{errors: [{rule, code, pi, block, cells}], warnings: [...], hist: {pi: {block: n}}, totals, roles,
 * drift, creative}` (raw, by IR part index); the callers make findings or refusals.
 */
export function vocabScan({ ir, vw, meta = null, lava = null }) {
  const P = vw.pal;
  const F = factsOf(P);
  const bodyCells = new Set();
  for (const b of bodiesOf(ir)) for (const q of b.cells) bodyCells.add(k3(q[0], q[1], q[2]));
  const natLava = natLavaOf(vw);
  const isWater = (i) => P.water[i] && !P.lava[i];
  const logs = [];
  const isLog = (i) => { if (logs[i] === undefined) logs[i] = isLogName(parseState(P.states[i]).name); return logs[i]; };
  const out = { state: new Map(), convert: new Map(), fire: new Map(), natLava: new Map(), drift: new Map(), creative: new Map(), hist: new Map(), written: new Set() };
  const push = (m, pi, block, cell) => {
    const key = `${pi}|${block}`;
    let e = m.get(key);
    if (!e) { e = { pi, block, n: 0, cells: [] }; m.set(key, e); }
    e.n++;
    if (e.cells.length < MAX_SAMPLE) e.cells.push(cell);
  };
  const R = FIRE_REACH_TABLE;
  let lavaPossible = lava;
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (idx < 0 || P.air[idx]) return;
    const c = F[idx] ?? factsOf(P)[idx];
    out.written.add(c.name);
    if (c.measured) {
      let h = out.hist.get(pi);
      if (!h) { h = {}; out.hist.set(pi, h); }
      h[c.name] = (h[c.name] ?? 0) + 1;
    }
    if (c.creative) push(out.creative, pi, c.name, [x, y, z]);
    if (c.drift && driftsWhere(c.st, (dx, dy, dz) => isLog(vw.get(x + dx, y + dy, z + dz)))) push(out.drift, pi, c.name, [x, y, z]);
    // ---- M27:state: a waterlogged cell outside an H body's cells and natural water; a pair half alone
    if (c.logged && !bodyCells.has(k3(x, y, z)) && !isWater(vw.base(x, y, z))) push(out.state, pi, P.states[idx], [x, y, z]);
    if (c.pair) {
      const o = vw.get(x + c.pair[0], y + c.pair[1], z + c.pair[2]);
      if (!isPairOf(c.st, F[o] ? F[o].st : parseState(P.states[o]))) push(out.state, pi, P.states[idx], [x, y, z]);
    }
    // ---- M27:convert: a hazards.json block within its reach of water (a plan body, a plan wet write's water, natural water)
    if (c.hazard && HAZARD[c.hazard] && HAZARD[c.hazard].beside === 'water') {
      for (const [dx, dy, dz] of waterReachOffsets(HAZARD[c.hazard].reach)) {
        const q = vw.get(x + dx, y + dy, z + dz);
        if (isWater(q) && !natLava(x + dx, y + dy, z + dz)) { push(out.convert, pi, c.name, [x, y, z]); break; }
      }
    }
    // ---- M20 (a): a written fire, soul fire, or exposed lava cell with a flammable block within the fire reach
    // (an H lava body's cells are H's own M20, checkFluids.mjs: not counted twice)
    if (c.hazard === 'fire' || (c.hazard === 'lava' && !bodyCells.has(k3(x, y, z)) && D6.some(([dx, dy, dz]) => P.air[vw.get(x + dx, y + dy, z + dz)]))) {
      let hit = null;
      for (let dx = -R.side; dx <= R.side && !hit; dx++) for (let dz = -R.side; dz <= R.side && !hit; dz++) for (let dy = -R.below; dy <= R.above; dy++) {
        if (P.flammable[vw.get(x + dx, y + dy, z + dz)]) { hit = [x + dx, y + dy, z + dz]; break; }
      }
      if (hit) push(out.fire, pi, c.name, [x, y, z]);
    }
    // ---- M20 (b): a plan-written flammable block within the fire reach of natural lava (lava below it by 1..3, or level, or 1 above)
    if (P.flammable[idx] && lavaPossible !== false) {
      if (lavaPossible === null) lavaPossible = surveyLava(vw);
      if (lavaPossible) {
        let hit = false;
        for (let dx = -R.side; dx <= R.side && !hit; dx++) for (let dz = -R.side; dz <= R.side && !hit; dz++) for (let dy = -R.above; dy <= R.below; dy++) {
          if ((vw.flags(x + dx, y + dy, z + dz) & F_WRITTEN) === 0 && natLava(x + dx, y + dy, z + dz)) { hit = true; break; }
        }
        if (hit) push(out.natLava, pi, c.name, [x, y, z]);
      }
    }
  });
  // ---- M27:role: a role (or slot) resolved to a block that fails its §2.3 predicate, used by this IR (the block is written)
  const roles = [];
  // (the roles the plan's bible names: the kit's own defaults are frozen and not judged here)
  const resolved = meta?.vocab?.roles ?? {};
  for (const [role, st] of Object.entries(resolved).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const block = String(st).replace(/\[.*$/, '');
    if (!out.written.has(block)) continue;
    const fit = fitsRole(role, block);
    if (!fit.ok) roles.push({ role, block, failed: fit.failed });
  }
  return { ...out, roles };
}

/** Does the plan survey hold a LAVA column? (no survey: a realised world, so look everywhere) */
export function surveyLava(vw) {
  const c = vw.survey;
  if (!c) return true;
  for (let i = 0; i < c.width * c.depth; i++) if (c.flags[i] & FLAG_LAVA) return true;
  return false;
}

/** The style the plan meta records (meta.vocab), as vocab/budget.mjs styleOf returns it. */
export function metaStyle(meta) {
  const v = meta?.vocab;
  if (!v) return null;
  return { opted: !!v.opted, rarity: v.rarity, own: new Set(v.own ?? []) };
}

/**
 * The checker's rules (check.mjs calls this: `want`, `findings`, `metrics`, `finding`). M26 only with an opted-in style or for precious
 * cells; M27 on every IR; M20 (a) and (b).
 */
export function vocabRules({ ir, vw, meta, want, findings, metrics, finding, lava = null }) {
  const s = vocabScan({ ir, vw, meta, lava });
  const part = (pi) => ir.parts[pi]?.id ?? null;
  const stage = (pi) => ir.parts[pi]?.stage ?? null;
  const list = (m) => [...m.values()].sort((a, b) => a.pi - b.pi || (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  if (want.has('M27')) {
    for (const e of list(s.state)) findings.push(finding('M27:state', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} cell(s) of ${e.block}: ${/waterlogged=true/.test(e.block) ? 'waterlogged outside a plan body and natural water (it makes a source and floods)' : 'a two-part block without its other half (it pops off)'}`));
    for (const e of list(s.convert)) findings.push(finding('M27:convert', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} ${e.block} cell(s) within their reach of water (kit/vocab/hazards.json: it converts)`));
    for (const r of s.roles) findings.push(finding('M27:role', null, null, 1, [], `role ${r.role} is ${r.block}, which fails ${r.failed.join(', ')} (kit/vocab/roles.json)`));
    for (const e of list(s.drift)) findings.push(finding('M27:drift', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} ${e.block} cell(s) random-tick into another block (an undo keeps a changed cell)`));
    for (const e of list(s.creative)) findings.push(finding('M27:creative', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} ${e.block} cell(s): creative-only (survival can't build it)`));
  }
  if (want.has('M20')) {
    for (const e of list(s.fire)) findings.push(finding('M20', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} written ${e.block} cell(s) with a flammable block within the fire reach (${FIRE_REACH_TABLE.side} sideways, ${FIRE_REACH_TABLE.below} below to ${FIRE_REACH_TABLE.above} above)`));
    for (const e of list(s.natLava)) findings.push(finding('M20:natural', part(e.pi), stage(e.pi), e.n, e.cells, `${e.n} plan-written flammable ${e.block} cell(s) within the fire reach of natural lava`));
  }
  // ---- M26: over the non-terrain written cells, per region (the plan's style); only opted in, or for precious cells
  const style = metaStyle(meta) ?? { opted: false, rarity: undefined, own: new Set() };
  const total = {};
  for (const h of s.hist.values()) for (const [b, n] of Object.entries(h)) total[b] = (total[b] ?? 0) + n;
  const m = measureRarity(total, style, 'region');
  metrics.M26 = { opted: style.opted, ...m };
  metrics.M27 = { state: [...s.state.values()].reduce((a, e) => a + e.n, 0), convert: [...s.convert.values()].reduce((a, e) => a + e.n, 0), roles: s.roles.length,
    drift: Object.fromEntries(list(s.drift).reduce((acc, e) => { acc.set(e.block, (acc.get(e.block) ?? 0) + e.n); return acc; }, new Map())),
    creative: Object.fromEntries(list(s.creative).reduce((acc, e) => { acc.set(e.block, (acc.get(e.block) ?? 0) + e.n); return acc; }, new Map())) };
  if (want.has('M26')) {
    for (const o of m.over) {
      if (!style.opted && o.what !== 'preciousRegion') continue;
      findings.push(finding('M26', null, null, typeof o.value === 'number' && Number.isInteger(o.value) ? o.value : 1, [], `${o.rule}: ${o.what} ${o.value} is over the ${style.opted ? "bible's" : 'default'} ${o.max}`));
    }
  }
  return s;
}

/**
 * The compile pass (§5.2 "New in VOC"): the scan's M27:state, M27:convert and M20 (a) errors per plan part. `partOf`: the plan check's
 * IR part (or lot, road) id -> plan part id. Returns {refuse: {planPart: reason}, found: [{planPart, rule, block, cells}], ms}; a part
 * written by no plan part (`__lamps__`) is listed in `found` only.
 */
export function vocabRefusals({ ir, vw, meta, partOf, roles = {}, scan = null, skip = new Set() }) {
  const t0 = performance.now();
  const s = scan ?? vocabScan({ ir, vw, meta, lava: false });
  const refuse = {};
  const found = [];
  const roleOf = (block) => Object.entries(roles).filter(([, st]) => String(st).replace(/\[.*$/, '') === block.replace(/\[.*$/, '')).map(([r]) => r).sort()[0] ?? null;
  const add = (rule, code, e) => {
    const irPart = ir.parts[e.pi]?.id ?? null;
    const owner = irPart ? partOf[irPart] ?? null : null;
    const ids = (!owner ? [] : owner.startsWith('routes:') ? owner.slice(7).split(',') : owner.startsWith('__') ? [] : [owner]).filter((id) => !skip.has(id));
    const block = e.block;
    const role = roleOf(block);
    found.push({ rule, code, irPart, planParts: ids, block, cells: e.n });
    for (const id of ids) {
      if (refuse[id]) continue;
      const msg = rule === 'M20' ? `${e.n} written ${block} cell(s) with a flammable block within the fire reach` : rule === 'M27:convert' ? `${e.n} ${block} cell(s) within their reach of water: it converts (kit/vocab/hazards.json)` : /waterlogged=true/.test(block) ? `${e.n} cell(s) of ${block} waterlogged outside a plan body and natural water: it makes a source and floods` : `${e.n} cell(s) of ${block} without the other half of the block: it pops off`;
      refuse[id] = { code, message: msg, evidence: { rule, block, cells: e.cells.slice(0, 16), ...(role ? { role } : {}) } };
    }
  };
  const sorted = (m) => [...m.values()].sort((a, b) => a.pi - b.pi || (a.block < b.block ? -1 : 1));
  for (const e of sorted(s.state)) add('M27:state', 'VOCAB', e);
  for (const e of sorted(s.convert)) add('M27:convert', 'VOCAB', e);
  for (const e of sorted(s.fire)) add('M20', 'FIRE', e);
  return { refuse, found, ms: Math.round(performance.now() - t0) };
}

/**
 * The per-IR-part cells the plan answers' cost members read (finish.mjs): {irPartId: {hist: {block: n} (non-terrain cells), creative:
 * {block: n}}}, from a scan.
 */
export function vocabCells(ir, scan) {
  const out = {};
  for (const [pi, h] of [...scan.hist].sort(([a], [b]) => a - b)) {
    const id = ir.parts[pi]?.id;
    if (id) (out[id] ??= { hist: {}, creative: {} }).hist = Object.fromEntries(Object.entries(h).sort());
  }
  for (const e of [...scan.creative.values()].sort((a, b) => a.pi - b.pi || (a.block < b.block ? -1 : 1))) {
    const id = ir.parts[e.pi]?.id;
    if (id) { const o = (out[id] ??= { hist: {}, creative: {} }); o.creative[e.block] = (o.creative[e.block] ?? 0) + e.n; }
  }
  return out;
}
