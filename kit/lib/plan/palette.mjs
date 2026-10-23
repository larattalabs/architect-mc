// (6c VOC-c) `rule.palette` measured (docs/CONTRACT.md "Phase 6c slice VOC-c"; Steward's review and the coordinator decisions bind):
// the lenient read of a palette rule (§1), the measure over the IR parts and the bound lots in its scope (§2), the plan-time answers
// (§3: fits with `measured`, adjusted after the `paletteExclude` re-plan, refused VOCAB, TOLERANCE, NO_FEATURE), the artifact's
// `palette` rows (§4: what Java needs to measure again at realiseApproved, so Java needs no vocabulary) and the "no X" swap (the
// material chain VOC-c defines: VOC-a has none, plan/0 has no slot chain).
//
// Cells are VOC's measured cells (written, not air, not a fluid source, not a common natural block; kit/lib/region/checkVocab.mjs) by IR
// part, less the exempt parts: `terrain` (parts written only by terrain ops: relief, scatter, stamps; the clearings) and `support` (a
// zone's and a lot's pads). The exemption follows the writer (the IR part), never the block: a bible may use one block for its
// foundation, its paths and its structure. A lot's cells come from its bound entry's block histogram (`lotBlocks`, sent by the mod at
// check time), less the blocks of `unmeasuredBlocks()`. Counts are integers; a share is `family / cells` (IEEE division, the same in
// Java), and a rule with no measured cell fits.
import { BLOCKS, collisionOf, qualify } from '../blocks.mjs';
import { tierOf } from '../vocab.mjs';
import { variant } from '../kit.mjs';
import { blockState } from '../region/program.mjs';
import { mapPatternMats } from '../pattern.mjs';
import { GROUPS, nearestFamily, resolvePalette } from '../vocab/groups.mjs';
import { DEFAULT_FIXTURE, fixtureFor, roadLamp } from '../region/fixtures.mjs';

export const PALETTE_EXEMPT = Object.freeze(['terrain', 'support']);
/** (close-out A, §5) Every exemption a rule may name (the default stays PALETTE_EXEMPT): `ways` and `forms` by writer, as VOC-c's. */
export const PALETTE_EXEMPT_KINDS = Object.freeze(['terrain', 'support', 'ways', 'forms']);
/** (close-out A, §5) What a rule measures: `all` (its scope's parts and their zones' bound lots, the default) or `lots` (the lots alone). */
export const PALETTE_OVER = Object.freeze(['all', 'lots']);
/** §3: the answer's `measured` lists at most this many parts and lots (the worst first). */
export const MEASURED_CAP = 16;
const NATURAL_CLASSES = new Set(['ROCK', 'SOIL', 'LOOSE', 'SNOW', 'ICE']);
const AIRS = ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'];
const FLUIDS = ['minecraft:water', 'minecraft:lava', 'minecraft:bubble_column'];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameOf = (s) => qualify(String(s).replace(/\[.*$/, ''));

let UNMEASURED = null;
/**
 * Every block VOC's measure drops (air, the fluids, the common natural blocks), sorted: the artifact row's `natural`, so Java's filter is
 * "not air, not in natural" and equals the kit's by construction.
 */
export function unmeasuredBlocks() {
  if (UNMEASURED) return UNMEASURED;
  const out = new Set([...AIRS, ...FLUIDS]);
  for (const [id, row] of Object.entries(BLOCKS)) if (NATURAL_CLASSES.has(row.v) && tierOf(id) === 'common') out.add(id);
  UNMEASURED = Object.freeze([...out].sort(cmp));
  return UNMEASURED;
}
let UNMEASURED_SET = null;
const unmeasured = () => (UNMEASURED_SET ??= new Set(unmeasuredBlocks()));

const isShare = (s) => Array.isArray(s) && s.length === 2 && s.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1) && s[0] <= s[1];
const isExempt = (e) => Array.isArray(e) && e.every((x) => PALETTE_EXEMPT_KINDS.includes(x));
const isOver = (v) => PALETTE_OVER.includes(v);

/**
 * §1's lenient read (S-K1-3): `family`, `share` and `exempt` from the top level, else from `params` (Steward writes both). Defaults:
 * share [1, 1] ("only"), exempt both. Other `params` keys are noted, never read. Returns `{family, share, exempt, over?, from: {member:
 * 'top' | 'params' | 'default' | 'scope'}, notes: [strings]}`; `family` null when neither gives a string (a prose rule).
 * (close-out A, §5) `over` ('all' | 'lots'): the top level, else a string `scope` "lots" or "all" (noted "scope read as over": the part
 * scope is then the whole plan), else `params.over`; `over` and `from.over` are present only when one of them gives it (the default,
 * 'all', leaves the read as VOC-c's).
 */
export function readPaletteRule(part) {
  const params = part?.params && typeof part.params === 'object' && !Array.isArray(part.params) ? part.params : {};
  const from = {};
  const notes = [];
  const pick = (k, ok, dflt) => {
    if (part?.[k] !== undefined && ok(part[k])) { from[k] = 'top'; return part[k]; }
    if (params[k] !== undefined && ok(params[k])) { from[k] = 'params'; return params[k]; }
    if (params[k] !== undefined) notes.push(`params.${k}: not a valid ${k}, not read`);
    from[k] = 'default';
    return dflt;
  };
  const family = pick('family', (v) => typeof v === 'string' && v.length > 0, null);
  const share = pick('share', isShare, [1, 1]);
  const exempt = pick('exempt', isExempt, [...PALETTE_EXEMPT]);
  let over = null;
  if (part?.over !== undefined && isOver(part.over)) { over = part.over; from.over = 'top'; }
  if (typeof part?.scope === 'string') {
    if (over === null && isOver(part.scope)) { over = part.scope; from.over = 'scope'; notes.push(`scope "${part.scope}" read as over (the rule binds the whole plan)`); } else notes.push(`scope "${part.scope}": not read (over is given)`);
  }
  if (over === null && params.over !== undefined && isOver(params.over)) { over = params.over; from.over = 'params'; }
  else if (params.over !== undefined && !isOver(params.over)) notes.push('params.over: not a valid over, not read');
  const read = new Set(['family', 'share', 'exempt', 'over']);
  const other = Object.keys(params).filter((k) => !read.has(k)).sort(cmp);
  if (other.length) notes.push(`params ${other.join(', ')}: noted, not read (VOC-c measures family, share and exempt)`);
  return { family, share: [...share], exempt: [...new Set(exempt)].sort(cmp), ...(over !== null ? { over } : {}), from, notes };
}

/**
 * The exempt class of an IR part (§2): 'terrain' (every op a relief, scatter or stamp op, or a clearing), 'support' (a zone's or a
 * lot's pads: `pads`, `<prefix>_pads`, `lot_pads`), else null (it counts). Bridges' piers and walls' footings share their part with the
 * deck or the wall, so they count (recorded in the as-built).
 */
export function irPartExempt(p) {
  if (!p) return null;
  if (/^clear_/.test(p.id) || /^relief_/.test(p.id)) return 'terrain';
  if (p.ops?.length && p.ops.every((o) => o.op === 'relief' || o.op === 'scatter' || o.op === 'stamp')) return 'terrain';
  if (/(^|_)pads$/.test(p.id)) return 'support';
  return null;
}

/**
 * (close-out A, §5) The writer class `ways` or `forms` of an IR part, else null. `owner`: its plan part (partOf); `blocks`: {plan part:
 * block}; `kind`: the region meta's kind of the IR part. ways: a street, road or path connector's parts, every route pass's parts (owner
 * `routes:...`), a zone's own street (and its 4e ground roads), lanes, square paving, verges and its routes between districts (the
 * zone's `path` parts and its `*_street` parts); forms: the parts of every `form.*` part. Walls, gates, bridges, tunnels and channels
 * have other blocks and count. Relief is terrain (irPartExempt, first).
 */
export function irPartWriter(p, owner, blocks = {}, kind = null) {
  if (!p || !owner) return null;
  if (owner.startsWith('routes:')) return 'ways';
  const b = blocks[owner] ?? null;
  if (!b) return null;
  if (b === 'connector.street' || b === 'connector.road' || b === 'connector.path') return 'ways';
  if (b.startsWith('form.')) return 'forms';
  if (b.startsWith('zone.') && (kind === 'path' || /(^|_)street(_[we])?(_\d+)?$/.test(p.id))) return 'ways';
  return null;
}

/** The plan parts a rule binds: its scope, or null (the whole plan). */
const scopeSet = (rule) => (Array.isArray(rule.scope) ? new Set(rule.scope) : null);

/** Whether an IR part (by its owner in `partOf`) is in a rule's scope (a shared route part: any of its connectors). */
export function ownedInScope(owner, scope) {
  if (!scope) return true;
  if (!owner) return false;
  if (owner.startsWith('routes:')) return owner.slice(7).split(',').some((id) => scope.has(id));
  return scope.has(owner);
}

/** A lot's block histogram measured: `{cells, family}` over the blocks not in `unmeasuredBlocks()`. */
export function measureLot(hist, familySet) {
  let cells = 0, family = 0;
  for (const [b, n] of Object.entries(hist ?? {})) {
    if (!Number.isInteger(n) || n <= 0) continue;
    const id = nameOf(b);
    if (unmeasured().has(id)) continue;
    cells += n;
    if (familySet.has(id)) family += n;
  }
  return { cells, family };
}

/** Whether a share fits `[min, max]` (no measured cell: fits). */
export const shareFits = (family, cells, share) => cells === 0 || (family / cells >= share[0] && family / cells <= share[1]);

/**
 * The measure of one rule (§2). `ir`: the IR; `hist`: the scan's measured cells per IR part index (Map pi -> {block: n});
 * `pc`: the plan check record (partOf, lotZone, lotEntries); `lotBlocks`: {lot: {block: n}} (the mod's, at check time).
 * Returns `{cells, family, share, parts: {id: [family, cells]}, lots: {id: [family, cells]}, pendingLots, exempted: {terrain, support},
 * byBlock: {block: cells} (the family's blocks written by the parts in scope), byPart: {planPart: {block: cells}}}`.
 */
export function measurePalette(rule, resolved, { ir, hist, pc, lotBlocks = {}, kinds = {} }) {
  const fam = new Set(resolved.blocks);
  const scope = scopeSet(rule);
  const exempt = new Set(rule.exempt);
  const parts = {}, lots = {}, byBlock = {}, byPart = {};
  const exempted = { terrain: 0, support: 0, ...(exempt.has('ways') ? { ways: 0 } : {}), ...(exempt.has('forms') ? { forms: 0 } : {}) };
  // (close-out A, §5) ways and forms by writer: the plan parts' blocks (the check record's, present when a rule names one)
  const byWriter = exempt.has('ways') || exempt.has('forms');
  let cells = 0, family = 0;
  // (close-out A, §5) over: lots measures the bound lots alone: no part's cells count
  for (const [pi, h] of rule.over === 'lots' ? [] : hist) {
    const p = ir.parts[pi];
    if (!p) continue;
    const owner = pc.partOf?.[p.id] ?? null;
    if (!ownedInScope(owner, scope)) continue;
    let c = 0, f = 0;
    for (const [b, n] of Object.entries(h)) { c += n; if (fam.has(b)) f += n; }
    const ex = irPartExempt(p) ?? (byWriter ? irPartWriter(p, owner, pc.paletteBlocks ?? {}, kinds?.[p.id]?.kind ?? null) : null);
    if (ex && exempt.has(ex)) { exempted[ex] += c; continue; }
    cells += c; family += f;
    const key = owner && !owner.startsWith('__') ? owner : p.id;
    const o = (parts[key] ??= [0, 0]);
    o[0] += f; o[1] += c;
    for (const [b, n] of Object.entries(h)) if (fam.has(b)) { byBlock[b] = (byBlock[b] ?? 0) + n; const q = (byPart[key] ??= {}); q[b] = (q[b] ?? 0) + n; }
  }
  // lots: the lots of the zones (and districts) in scope, from their bound entries; a lot without an entry, or whose entry the mod
  // sent no histogram for, is pending (verified at realiseApproved, R11 as amended)
  const pendingLots = [];
  for (const [lot, zone] of Object.entries(pc.lotZone ?? {}).sort(([a], [b]) => cmp(a, b))) {
    if (scope && !scope.has(zone)) continue;
    if (!pc.placedLots?.has(lot)) continue;
    const entry = pc.lotEntries?.[lot] ?? null;
    const h = entry ? lotBlocks?.[lot] : null;
    if (!entry || !h) { pendingLots.push(lot); continue; }
    const m = measureLot(h, fam);
    lots[lot] = [m.family, m.cells];
    cells += m.cells; family += m.family;
  }
  return { cells, family, share: cells ? family / cells : null, parts, lots, pendingLots, exempted, byBlock, byPart };
}

/** §3's `measured` member: the measure capped at MEASURED_CAP parts and lots, the worst first. */
export function measuredMember(m, share) {
  // worst: for a lower bound above 0 the most cells outside the family, else the most family cells; ties by id
  const bad = share[0] > 0 ? ([f, c]) => c - f : ([f]) => f;
  const top = (o) => Object.fromEntries(Object.entries(o).sort(([a, x], [b, y]) => bad(y) - bad(x) || cmp(a, b)).slice(0, MEASURED_CAP));
  return { cells: m.cells, family: m.family, share: m.share, parts: top(m.parts), lots: top(m.lots), pendingLots: m.pendingLots.slice(0, 64) };
}

/** The worst parts and lots (§3 TOLERANCE's `worst`): up to 4 ids. */
function worstOf(m, share) {
  const bad = share[0] > 0 ? ([f, c]) => c - f : ([f]) => f;
  return [...Object.entries(m.parts).map(([id, v]) => ({ id, kind: 'part', v })), ...Object.entries(m.lots).map(([id, v]) => ({ id, kind: 'lot', v }))]
    .filter((x) => bad(x.v) > 0).sort((a, b) => bad(b.v) - bad(a.v) || cmp(a.id, b.id)).slice(0, 4).map((x) => ({ [x.kind]: x.id, family: x.v[0], cells: x.v[1] }));
}

/**
 * §3's answer for one palette rule part. `p`: the validated part (id, block, required, part); `read`: readPaletteRule's; `m`: the measure
 * (null when the family resolves to nothing); `excluded`: the swaps made for it in the re-plan ({from: {to, cells}}, null when none);
 * `measureWith(rule)`: re-measures a variant of the rule (wouldFit's re-check).
 */
export function paletteAnswer(p, read, m, { excluded = null, measureWith = null } = {}) {
  const notes = [...read.notes];
  if (read.family === null) {
    return { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: 'palette guidance only: give a family to measure it (a vocab/1 family or group)', evidence: { kind: 'family' } }],
      wouldFit: [{ part: p.id, fragment: { required: false }, class: 'fits', note: 'a rule that is not required never blocks' }], notes };
  }
  const resolved = resolvePalette(read.family);
  if (!resolved) {
    const near = nearestFamily(read.family);
    const wf = [];
    if (near && measureWith) {
      const again = measureWith({ ...read, family: near });
      wf.push({ part: p.id, fragment: { family: near }, class: again && shareFits(again.family, again.cells, read.share) ? 'fits' : 'refused', ...(again ? { measured: measuredMember(again, read.share) } : {}) });
    }
    if (!wf.length) wf.push({ part: p.id, fragment: { required: false }, class: 'fits', note: 'a rule that is not required never blocks' });
    return { class: 'refused', reasons: [{ code: 'NO_FEATURE', message: `"${read.family}" is not a vocab/1 family or group (groups: ${Object.keys(GROUPS).join(', ')})`, evidence: { kind: 'family', family: read.family } }], wouldFit: wf, notes };
  }
  const measured = measuredMember(m, read.share);
  if (m.pendingLots.length) notes.push(`lots ${m.pendingLots.slice(0, 8).join(', ')}${m.pendingLots.length > 8 ? ' ...' : ''} have no bound entry yet: measured at realiseApproved${p.required ? ' (a required rule refuses PALETTE there)' : ''}`);
  if (shareFits(m.family, m.cells, read.share)) {
    if (excluded && Object.keys(excluded).length) {
      const deviations = Object.entries(excluded).sort(([a], [b]) => cmp(a, b)).map(([from, x]) => ({ what: 'material', value: x.cells, from, to: x.to }));
      return { class: 'adjusted', deviations, measured, notes: [...notes, `re-planned with ${read.family} excluded: ${deviations.map((d) => `${d.from.replace('minecraft:', '')} -> ${d.to.replace('minecraft:', '')}`).join(', ')}`] };
    }
    return { class: 'fits', measured, notes };
  }
  // an upper bound of 0 the re-plan could not reach: a part still writes the family (a role with no other block)
  if (read.share[1] === 0) {
    const [part, blocks] = Object.entries(m.byPart).sort(([a, x], [b, y]) => Object.values(y).reduce((s, n) => s + n, 0) - Object.values(x).reduce((s, n) => s + n, 0) || cmp(a, b))[0] ?? [null, {}];
    const [block, cells] = Object.entries(blocks).sort(([a, x], [b, y]) => y - x || cmp(a, b))[0] ?? [null, 0];
    if (part) {
      return { class: 'refused', reasons: [{ code: 'VOCAB', message: `part ${part} still writes ${cells} ${block} cell(s) with ${read.family} excluded (no other block in its material chain)`, evidence: { rule: p.id, part, block, cells } }], measured, notes };
    }
  }
  const s = m.share;
  const widened = [Math.min(read.share[0], s), Math.max(read.share[1], s)];
  const again = measureWith ? measureWith({ ...read, share: widened }) : null;
  return {
    class: 'refused',
    reasons: [{ code: 'TOLERANCE', message: `${read.family} is ${m.family} of ${m.cells} measured cells (share ${s}), outside [${read.share.join(', ')}]`, evidence: { kind: 'palette', family: read.family, share: read.share, measured: s, worst: worstOf(m, read.share) } }],
    wouldFit: [{ part: p.id, fragment: { share: widened }, class: again ? (shareFits(again.family, again.cells, widened) ? 'fits' : 'refused') : 'fits' }],
    measured, notes,
  };
}

/** §4's artifact row for a rule with lots in its scope (sorted, deduplicated: what Java measures again). */
export function paletteRow(p, read, resolved, m) {
  const lotIds = [...new Set([...Object.keys(m.lots), ...m.pendingLots])].sort(cmp);
  return {
    rule: p.id, required: !!p.required, family: read.family, share: [...read.share], over: read.over ?? 'all', lots: lotIds, blocks: [...resolved.blocks], natural: [...unmeasuredBlocks()],
    partsCells: m.cells - Object.values(m.lots).reduce((s, [, c]) => s + c, 0), partsFamily: m.family - Object.values(m.lots).reduce((s, [f]) => s + f, 0),
    lotCounts: Object.fromEntries(Object.entries(m.lots).sort(([a], [b]) => cmp(a, b))),
  };
}

// ------------------------------------------------------------------ "no X": the material chain (N-VOCc-2)

/**
 * The material chain VOC-c defines (a deviation, named in the as-built: VOC-a has no chain). The base: the first of the plan's
 * `structure`, `foundation`, `rubble`, `rock` roles, then stone bricks, cobblestone, stone, that is a full cube and outside every
 * excluded family. A block keeps its shape: stairs, slabs and walls by `variant()` of the base (the next base that has one), a fence as
 * the base's wall (its sides `low`, `up`), a door, trapdoor, pressure plate or button as iron's or stone's; every other shape of an
 * excluded block (a fence gate, a sign, a shelf) has no other block and stays (the rule then answers VOCAB naming the part).
 */
export function swapChain(roles = {}, exclude = new Set()) {
  const names = [roles.structure, roles.foundation, roles.rubble, roles.rock, 'minecraft:stone_bricks', 'minecraft:cobblestone', 'minecraft:stone'].filter(Boolean).map(nameOf);
  const bases = [...new Set(names)].filter((n) => BLOCKS[n] && !exclude.has(n) && collisionOf({ name: n, props: {} }) === 'full');
  return bases.length ? bases : [...new Set(names)].filter((n) => BLOCKS[n] && !exclude.has(n));
}

const PROPS = (s) => {
  const m = /\[(.*)\]$/.exec(String(s));
  return m ? Object.fromEntries(m[1].split(',').filter(Boolean).map((kv) => kv.split('='))) : {};
};
const mk = (name, props) => {
  const keys = Object.keys(props);
  try { return blockState(keys.length ? `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]` : name); } catch { return null; }
};

/** The swap of one block state (null: no other block; the state stays). */
export function swapState(state, chain, exclude) {
  const name = nameOf(state);
  if (!exclude.has(name)) return state;
  const props = PROPS(state);
  const ok = (n) => n && BLOCKS[qualify(n)] && !exclude.has(qualify(n));
  const firstVariant = (kind) => { for (const b of chain) { const v = variant(b, kind); if (ok(v)) return qualify(v); } return null; };
  const keep = (n, keys) => mk(n, Object.fromEntries(Object.entries(props).filter(([k]) => keys.includes(k))));
  const b = name.replace('minecraft:', '');
  if (/_stairs$/.test(b)) { const v = firstVariant('stairs'); return v ? keep(v, ['facing', 'half', 'shape', 'waterlogged']) : null; }
  if (/_slab$/.test(b)) { const v = firstVariant('slab'); return v ? keep(v, ['type', 'waterlogged']) : null; }
  if (/_fence_gate$/.test(b) || /_sign$/.test(b) || /_shelf$/.test(b)) return null;
  if (/_fence$/.test(b)) {
    const v = firstVariant('wall');
    if (!v) return null;
    if (!Object.keys(props).length) return v;
    const side = (x) => (x === 'true' ? 'low' : 'none');
    return mk(v, { east: side(props.east), north: side(props.north), south: side(props.south), up: 'true', waterlogged: props.waterlogged ?? 'false', west: side(props.west) });
  }
  if (/_trapdoor$/.test(b)) return ok('minecraft:iron_trapdoor') ? keep('minecraft:iron_trapdoor', ['facing', 'half', 'open', 'powered', 'waterlogged']) : null;
  if (/_door$/.test(b)) return ok('minecraft:iron_door') ? keep('minecraft:iron_door', ['facing', 'half', 'hinge', 'open', 'powered']) : null;
  if (/_pressure_plate$/.test(b)) return ok('minecraft:stone_pressure_plate') ? keep('minecraft:stone_pressure_plate', ['powered']) : null;
  if (/_button$/.test(b)) return ok('minecraft:stone_button') ? keep('minecraft:stone_button', ['face', 'facing', 'powered']) : null;
  // a full block (planks, a log, wood, a stripped log, a stem, bamboo's block and mosaic): the base
  if (/(_planks|_log|_wood|_stem|_hyphae|_block|_mosaic)$/.test(b)) return chain[0] ?? null;
  return null;
}

/**
 * The re-plan's swap over the region before its IR is assembled (kit/lib/region/plan.mjs): every op material of the IR parts whose
 * owner is in an excluding rule's scope. `excludes`: [{rule, blocks: [ids], scope: [part ids] | null}]. Returns `{swaps: {from: to}}`
 * (the substitutions made, by block name). Fluid, voxels and stamp ops (their blocks are in side blobs) are not changed.
 */
export function applyPaletteExclude(r, excludes, partOf, roles) {
  const swaps = {};
  for (const ex of excludes) {
    const set = new Set(ex.blocks);
    const chain = swapChain(roles, set);
    const scope = ex.scope ? new Set(ex.scope) : null;
    const memo = new Map();
    const sw = (s) => {
      if (typeof s !== 'string') return s;
      if (memo.has(s)) return memo.get(s);
      const t = swapState(s, chain, set);
      const out = t ?? s;
      if (t && t !== s) swaps[nameOf(s)] ??= nameOf(t);
      memo.set(s, out);
      return out;
    };
    const mat = (m) => {
      if (typeof m === 'string') return sw(m);
      if (m && typeof m === 'object' && m.pattern) return { ...m, pattern: mapPatternMats(m.pattern, mat) };
      if (m && typeof m === 'object' && m.rule) return { ...m, rule: { ...m.rule, rule: m.rule.rule.map((c) => ({ ...c, mat: mat(c.mat) })), default: mat(m.rule.default) } };
      return m;
    };
    for (const p of r.parts) {
      if (!ownedInScope(partOf[p.id] ?? null, scope)) continue;
      for (const op of p.ops) {
        if (op.op === 'fluid' || op.op === 'voxels' || op.op === 'stamp' || op.op === 'scatter') continue;
        if (op.material !== undefined) op.material = mat(op.material);
        if (Array.isArray(op.materials)) op.materials = op.materials.map(mat);
      }
    }
    // 4e ground roads (the mod writes them): the surface, and the lanterns' fixture (4e's own, a lantern on an oak fence, when the
    // road names none: then the swapped fixture is named)
    for (const road of r.roads) {
      if (!ownedInScope(partOf[road.part] ?? null, scope)) continue;
      if (typeof road.surface === 'string') road.surface = sw(road.surface);
      if (!road.lanterns) continue;
      if (road.lamp?.cells) road.lamp = { ...road.lamp, cells: road.lamp.cells.map((c) => [c[0], c[1], sw(c[2])]) };
      else {
        const post = sw(DEFAULT_FIXTURE.post);
        if (post !== DEFAULT_FIXTURE.post) road.lamp = roadLamp(fixtureFor(DEFAULT_FIXTURE.light, post));
      }
    }
  }
  return { swaps };
}

// ------------------------------------------------------------------ the pass (kit/lib/region/plan.mjs, after the vocabulary scan)

/**
 * Every palette rule of a plan measured and answered. `pc`: meta.planCheck (its `palette` rules, answers, partOf, lotZone, lotEntries);
 * `ir`; `hist`: the scan's measured cells per IR part index; `lotBlocks`: the mod's histograms; `excludes`: the swaps this plan was made
 * with ([{rule, blocks, scope}]); `from`: the family cells by block each excluding rule measured before its re-plan ({rule: {block:
 * cells}}); `swaps`: the substitutions applyPaletteExclude made ({from: to}). Returns `{answers: {part: answer}, rows, want: [{rule,
 * blocks, scope}] (rules asking a re-plan with their family excluded), from: {rule: {block: cells}}, measures: {rule: summary}}`.
 */
export function palettePass({ pc, ir, hist, lotBlocks = {}, excludes = [], from = {}, swaps = {}, kinds = {} }) {
  const out = { answers: {}, rows: [], want: [], from: {}, measures: {} };
  const placed = new Set();
  for (const a of pc.answers ?? []) for (const l of a.geometry?.lots ?? []) placed.add(l.id);
  const ctx = { ir, hist, pc: { ...pc, placedLots: placed }, lotBlocks: lotBlocks ?? {}, kinds: kinds ?? {} };
  for (const r of pc.palette ?? []) {
    const a0 = (pc.answers ?? []).find((a) => a.part === r.part);
    const p = { id: r.part, required: r.required, part: { id: r.part } };
    const rule = { scope: r.scope, exempt: r.read.exempt, over: r.read.over ?? 'all' };
    const resolved = r.read.family ? resolvePalette(r.read.family) : null;
    const m = resolved ? measurePalette(rule, resolved, ctx) : null;
    const measureWith = (read) => { const rv = resolvePalette(read.family); return rv ? measurePalette({ scope: r.scope, exempt: read.exempt, over: read.over ?? 'all' }, rv, ctx) : null; };
    let excluded = null;
    const mine = excludes.find((e) => e.rule === r.part);
    if (mine && from[r.part]) {
      excluded = {};
      for (const [b, cells] of Object.entries(from[r.part])) if (swaps[b]) excluded[b] = { to: swaps[b], cells };
    }
    // "no X" (an upper bound of 0) that a part in scope still writes: ask the re-plan once, with the family excluded
    if (m && r.read.share[1] === 0 && !mine && Object.keys(m.byBlock).length) {
      out.want.push({ rule: r.part, blocks: [...resolved.blocks], scope: r.scope ? [...r.scope] : null });
      out.from[r.part] = { ...m.byBlock };
    }
    const ans = paletteAnswer(p, r.read, m, { excluded, measureWith });
    const a = { part: r.part, block: 'rule.palette', class: ans.class, required: r.required };
    for (const k of ['deviations', 'reasons', 'wouldFit', 'notes']) if (ans[k] !== undefined && !(Array.isArray(ans[k]) && !ans[k].length)) a[k] = k === 'notes' ? ans[k].slice(0, 16) : ans[k];
    if (ans.measured) a.measured = ans.measured;
    if (a0?.ext) a.ext = a0.ext;
    out.answers[r.part] = a;
    if (m) out.measures[r.part] = { cells: m.cells, family: m.family, share: m.share, exempted: m.exempted, pendingLots: m.pendingLots.length };
    // the artifact's row: a rule with lots in its scope whose family resolves (what realiseApproved measures again)
    if (m && resolved && (Object.keys(m.lots).length || m.pendingLots.length)) out.rows.push(paletteRow(p, r.read, resolved, m));
  }
  out.rows.sort((x, y) => cmp(x.rule, y.rule));
  return out;
}
