// (7b SC, docs/CONTRACT.md "Phase 7b" §3 row 5; SETTLEMENTS §7.4, §11 M15 and M21) The checker with a site: the template composited with
// the site it is bound to, and the site rules that judge it. lib/check.mjs `checkStructure(sidecar, structure, { site })` builds the grid
// here (siteGrid) and runs every rule on it; the site rules (siteFindings) add their findings to its errors and warnings and return the
// structured `result.site` (the frozen interface: docs/CONTRACT.md "Slice SC as built").
//
// The composite (design cells, the template's frame; the window is the site's volume, the lot box plus SITE_MARGIN):
// - a cell the template writes is the written block (its air too);
// - a cell it leaves is the site's: under a keep fit (every fit but on_pad, lib/siteFits.mjs `terrain`) placement leaves it as it stands,
//   so the checker sees a stand-in block of the site's class (SITE_STAND_IN: rock as stone, a log as a log, water as water...; plants and
//   air are air); under on_pad (`terrain: clear`) the template box is today's (cleared above the ground row, filled below it) and the site
//   shows round it;
// - outside the window nothing is known (air).
// `g.cells` stays the template's cells only: the rules that iterate it (palette, parts, survival, metrics, doors, vocabulary) never see the
// site. The rules that read the world round a cell (`at`, `cls`, `free`, `floor`, the outside flood, light, the walker, attach and facing)
// see the composite.
import { collisionOf, normalize, supportOf, BLOCKS, isClimbable, isFloor } from './blocks.mjs';
import { fitOf } from './siteFits.mjs';
import { SITE_SOLID, SITE_STAND_IN } from './site.mjs';

/**
 * The site rules' numbers (opts.siteLimits overrides any of them; siteLimits below adds the fit's own):
 * - cantilever 4: M15's "a solid cell more than 4 horizontally from a support column or a bracket" (SETTLEMENTS §11), for every keep fit
 *   but attach_to_cliff, whose row names the bible's limit;
 * - neckMass 200, neckContact 2: M15's necks ("a mass over 200 cells hanging on fewer than 2 cells of contact");
 * - bearCells 2: attach_to_cliff's "brackets bear on at least 2 rock cells each"; endBearing [2, 2]: span's "2x2 cells each";
 * - portWithin 2: ports_met's "at the hinted cell within 2"; breachWithin 1: site_breach's "WATER or LAVA within 1".
 */
export const SITE_CHECK_LIMITS = Object.freeze({
  cantilever: 4, neckMass: 200, neckContact: 2, bearCells: 2, endBearing: Object.freeze([2, 2]), portWithin: 2, breachWithin: 1,
});

/**
 * The limits a fit is judged by: SITE_CHECK_LIMITS, then the fit row's own (lib/siteFits.mjs `limits`), then `overrides` (opts.siteLimits).
 * A fit row's 'bible' limit (attach_to_cliff's cantilever, span's span, suspend's chain) is the bible's; no bible carries one yet, so
 * without an override it is unbounded (null: measured into the metrics, never a finding).
 */
export function siteLimits(fit, overrides = {}) {
  const row = fitOf(fit);
  const out = { ...SITE_CHECK_LIMITS, span: null, chain: null };
  for (const [k, v] of Object.entries(row.limits)) if (k in out || v === 'bible') out[k] = v === 'bible' ? null : v;
  for (const [k, v] of Object.entries(overrides ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * The site rules' ids, in report order (each finding's `rule`; SITE_UNFIT's detail names one). `fit:<mode>` is one id per fit. Errors:
 * site_bound, site_keep. Every other rule is a warning (SETTLEMENTS §7.4: "all starting as warnings except the first").
 */
export const SITE_RULE_IDS = Object.freeze(['site_bound', 'site_keep', 'fit:on_pad', 'fit:carve_into', 'fit:attach_to_cliff', 'fit:span', 'fit:wrap_trunk', 'fit:suspend', 'ports_met', 'floors_reachable', 'site_breach', 'cut_volume', 'cantilever', 'neck']);
/** The SETTLEMENTS rule each id reports under: the fit rules are M21 (site fit), the building-scale structure rules M15. */
export const SITE_RULE_M = Object.freeze({ cantilever: 'M15', neck: 'M15', ...Object.fromEntries(SITE_RULE_IDS.filter((r) => r.startsWith('fit:')).map((r) => [r, 'M21'])) });
/** The finding a site-bound sidecar gets when it is checked without its site (template only): a warning. */
export const SITE_UNCHECKED = 'site_unchecked';

const fmt = (x, y, z) => `${x},${y},${z}`;
const unfmt = (k) => k.split(',').map(Number);
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const SOLID = new Set(SITE_SOLID);
/** Site classes a written cell may never replace (site_keep): a player's block, a block entity, another owner's cell. */
export const SITE_UNTOUCHABLE = Object.freeze(['PLAYER', 'BLOCK_ENTITY', 'OWNED']);
const UNTOUCHABLE = new Set(SITE_UNTOUCHABLE);
const byCell = (a, b) => { const p = unfmt(a); const q = unfmt(b); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; };
const sample = (list, n = 5) => list.slice(0, n).join('; ') + (list.length > n ? '; ...' : '');

/** The checker's stand-in cell per site class (null: air to the checker: air, plants, nothing known). */
const STAND = Object.fromEntries(Object.entries(SITE_STAND_IN).filter(([c]) => c !== 'PLANT').map(([cls, name]) => {
  const st = normalize(name, cls === 'LOG' ? { axis: 'y' } : {});
  return [cls, Object.freeze({ name: st.name ?? name, props: Object.freeze({ ...st.props }), site: cls })];
}));

/**
 * The composite grid (lib/check.mjs makeGrid's shape and cell rules, plus `site`, `fit`, `fitRow`, `window`, `keep`, `written`,
 * `siteAt`). `cells`: the template's written cells (key -> state).
 */
export function siteGrid(cells, size, groundY, site) {
  const [sx, sy, sz] = size;
  const fitRow = fitOf(site.fit);
  const clear = fitRow.terrain === 'clear';
  const inBox = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz;
  /** the site's own class at a cell (MISSING outside the window) */
  const siteAt = (x, y, z) => site.at(x, y, z);
  /** what the composite holds where the template writes nothing (null: air) */
  const standIn = (x, y, z) => (clear && inBox(x, y, z) ? null : STAND[siteAt(x, y, z)] ?? null);
  const at = (x, y, z) => cells.get(fmt(x, y, z)) ?? standIn(x, y, z);
  // on_pad keeps today's box: unwritten cells under the ground row are filled (terrain); a keep fit has no such terrain (the site is there)
  const terrain = (x, y, z) => clear && inBox(x, y, z) && y < groundY && !cells.has(fmt(x, y, z));
  const cls = (x, y, z) => {
    const c = at(x, y, z);
    if (c) return collisionOf(c);
    return terrain(x, y, z) ? 'full' : 'none';
  };
  const free = (x, y, z) => { const k = cls(x, y, z); return k === 'none' || k === 'low'; };
  const floor = (x, y, z) => (terrain(x, y, z) ? true : isFloorCell(at(x, y, z)));
  const standable = (x, y, z) => floor(x, y - 1, z) && free(x, y, z) && free(x, y + 1, z);
  // keep cells: the sidecar's (filled in by siteFindings), the site's keep-critical cells and, for a host fit, the lot's logs
  const keep = new Set(site.keepCritical.map((c) => fmt(...c)));
  if (fitRow.keepCritical === 'host') for (const c of site.cellsOf('LOG')) keep.add(fmt(...c));
  return {
    cells, size, groundY, at, inBox, cls, free, floor, standable, terrain,
    site, fit: site.fit, fitRow, window: site.bounds, keep, siteAt,
    written: (x, y, z) => cells.has(fmt(x, y, z)),
    inWindow: (x, y, z) => site.inWindow(x, y, z),
  };
}

const isFloorCell = (c) => !!c && isFloor(c);

/** Is the written cell part of the building's mass (not air, a liquid or fire)? */
const massOf = (c) => { const f = BLOCKS[c.name]?.family; return f !== 'air' && f !== 'liquid' && f !== 'fire'; };

/**
 * The site rules over a composite grid. ctx: {g, sidecar, structureSize, interior, outside (the composite's outside flood), walker (a
 * lib/check.mjs walker over g), light (lightLevels(g)), limits}. Returns {findings: [{rule, severity, m?, count, cells, message}],
 * metrics}. Messages start with the rule id (`<rule>: ...`), as every checker line does.
 */
export function siteFindings(ctx) {
  const { g, sidecar, structureSize, interior: w, outside, walker: wk, light } = ctx;
  const site = g.site;
  const L = siteLimits(site.fit, ctx.limits);
  const findings = [];
  const add = (rule, severity, count, cells, message) => {
    findings.push({ rule, severity, ...(SITE_RULE_M[rule] ? { m: SITE_RULE_M[rule] } : {}), count, cells: cells.slice(0, 8).map((c) => (typeof c === 'string' ? unfmt(c) : [...c])), message: `${rule}: ${message}` });
  };
  const metrics = { fit: site.fit, volumeSha: site.sha, lotId: site.lotId };
  const row = g.fitRow;
  const keepFit = row.terrain === 'keep';

  // ---- site_bound (error): the template is the lot box, of this volume, with this fit (SV reading 3; the SV verifier's note)
  {
    const bad = [];
    const want = [site.size.x, site.size.y, site.size.z];
    if (structureSize.some((v, i) => v !== want[i])) bad.push(`the template is ${structureSize.join('x')}, but its site's lot box is ${want.join('x')} (a site-bound template is exactly the lot box)`);
    if (!sidecar.site) bad.push('the sidecar records no site (build it with the site: new Blueprint({ site }))');
    else {
      if (sidecar.site.volumeSha !== site.sha) bad.push(`the sidecar's site is volume ${String(sidecar.site.volumeSha).slice(0, 12)}, not this site's ${site.sha.slice(0, 12)}`);
      if (sidecar.site.lotId !== undefined && (sidecar.site.lotId ?? null) !== (site.lotId ?? null)) bad.push(`the sidecar's site is lot ${sidecar.site.lotId}, not ${site.lotId}`);
    }
    if (sidecar.fit !== undefined && sidecar.fit !== site.fit) bad.push(`the design's fit is ${sidecar.fit}, but the site is a ${site.fit} lot`);
    if (bad.length) add('site_bound', 'error', bad.length, [], bad.join('; '));
  }

  // ---- keep cells from the sidecar
  for (const c of sidecar.keep?.critical ?? []) if (Array.isArray(c) && c.length === 3) g.keep.add(fmt(...c));

  // ---- site_keep (error): no write into a keep cell, a PLAYER, BLOCK_ENTITY or OWNED cell (written air counts)
  {
    const hits = [];
    const kinds = new Map();
    for (const k of g.cells.keys()) {
      const [x, y, z] = unfmt(k);
      const sc = g.siteAt(x, y, z);
      const why = g.keep.has(k) ? (sc === 'LOG' && row.keepCritical === 'host' ? 'the host trunk' : 'a keep-critical cell') : UNTOUCHABLE.has(sc) ? { PLAYER: "a player's block", BLOCK_ENTITY: 'a block entity', OWNED: "another owner's cell" }[sc] : null;
      if (!why) continue;
      hits.push(k);
      kinds.set(why, (kinds.get(why) ?? 0) + 1);
    }
    if (hits.length) add('site_keep', 'error', hits.length, hits, `the template writes ${hits.length} cell(s) the site keeps (${[...kinds].map(([w, n]) => `${n} ${w}`).join(', ')}): leave them out of the template (bp.keep), e.g. ${sample(hits)}`);
  }

  // ---- the mass and what it bears on
  const nodes = new Map();
  for (const [k, c] of g.cells) if (massOf(c)) nodes.set(k, c);
  const structural = new Set([...nodes].filter(([, c]) => supportOf(c) === null).map(([k]) => k));
  const solidLeft = (x, y, z) => !g.written(x, y, z) && SOLID.has(g.siteAt(x, y, z)) && !(row.terrain === 'clear' && g.inBox(x, y, z));
  /** structural cells touching the site's solid (6 sides), and which solid cells they touch */
  const bearing = new Map();
  for (const k of structural) {
    const [x, y, z] = unfmt(k);
    const touch = [];
    for (const [dx, dy, dz] of N6) if (solidLeft(x + dx, y + dy, z + dz)) touch.push(fmt(x + dx, y + dy, z + dz));
    if (touch.length) bearing.set(k, touch);
  }
  metrics.bearing = bearing.size;

  // ---- fit:<mode> (M21): every cell connects to what the fit bears on
  if (keepFit) {
    const seeds = [];
    for (const k of structural) {
      const [x, y, z] = unfmt(k);
      const ok = row.bears === 'up' ? solidLeft(x, y + 1, z) : bearing.has(k);
      if (ok) seeds.push(k);
    }
    const connected = connect(seeds, structural, nodes, solidLeft);
    const loose = [...nodes.keys()].filter((k) => !connected.has(k));
    metrics.connected = connected.size;
    metrics.loose = loose.length;
    const to = { site_solid: "the site's solid (rock, soil, ice, a log)", trunk_or_site_solid: "the trunk or the site's solid", up: "the site's solid above it (through chains or posts)" }[row.bears];
    const fitRule = `fit:${site.fit}`;
    const extra = [];
    if (loose.length) extra.push({ n: loose.length, cells: loose, text: `${loose.length} block(s) not connected to ${to}, e.g. ${sample(loose.map((k) => `${nodes.get(k).name.replace('minecraft:', '')} at ${k}`))}` });
    if (!seeds.length) extra.push({ n: 1, cells: [], text: `nothing bears on ${to}` });
    if (site.fit === 'attach_to_cliff') {
      // brackets bear on at least bearCells rock cells each: every bearing (a 6-connected group of cells touching the face) touches enough
      const groups = components([...bearing.keys()]);
      const weak = groups.filter((gr) => new Set(gr.flatMap((k) => bearing.get(k))).size < L.bearCells);
      metrics.bearings = groups.length;
      if (weak.length) extra.push({ n: weak.length, cells: weak.map((gr) => gr[0]), text: `${weak.length} bearing(s) touch fewer than ${L.bearCells} rock cells (a bracket or beam bears on at least ${L.bearCells}), at ${sample(weak.map((gr) => gr[0]))}` });
    }
    if (site.fit === 'span') {
      const s = spanOf(g, structural, solidLeft, L);
      metrics.span = s.span;
      metrics.spanEnds = s.ends;
      if (s.ends.length < 2) extra.push({ n: 1, cells: [], text: `the span bears on ${s.ends.length} end(s): both ends bear on the site's solid` });
      else {
        const thin = s.ends.filter((e) => !e.square);
        if (thin.length) extra.push({ n: thin.length, cells: thin.map((e) => e.cell), text: `${thin.length} end(s) bear on no ${L.endBearing[0]}x${L.endBearing[1]} of the site's solid (end at ${thin.map((e) => `${s.axis}=${e.u0}..${e.u1}`).join(', ')})` });
      }
      if (L.span !== null && s.span > L.span) extra.push({ n: 1, cells: [], text: `an unsupported span of ${s.span} (at most ${L.span})` });
    }
    if (site.fit === 'suspend') {
      const runs = chainRuns(g);
      metrics.chainMax = runs.max;
      const over = L.chain === null ? [] : runs.tops.filter(([, n]) => n > L.chain).map(([k]) => k);
      if (over.length) extra.push({ n: over.length, cells: over, text: `${over.length} chain run(s) longer than ${L.chain} (longest ${runs.max})` });
    }
    if (extra.length) add(fitRule, 'warning', extra.reduce((a, e) => a + e.n, 0), extra.flatMap((e) => e.cells), extra.map((e) => e.text).join('; '));
  }

  // ---- ports_met: every port the site asks for, on the design, facing out, standable, within portWithin of the hint
  const designPorts = Array.isArray(sidecar.ports) ? sidecar.ports : [];
  const starts = [];
  {
    const bad = [];
    const met = [];
    for (const p of site.ports) {
      const d = designPorts.find((q) => q.name === p.name);
      if (!d) { bad.push(`no port '${p.name}' (${p.kind}, facing ${p.facing}, at ${p.at.join(',')})`); continue; }
      const why = [];
      if (d.kind !== p.kind) why.push(`kind ${d.kind}, not ${p.kind}`);
      if (d.facing !== p.facing) why.push(`facing ${d.facing}, not ${p.facing}`);
      const off = Math.max(Math.abs(d.x - p.at[0]), Math.abs(d.y - p.at[1]), Math.abs(d.z - p.at[2]));
      if (off > L.portWithin) why.push(`${off} from the hinted cell ${p.at.join(',')} (at most ${L.portWithin})`);
      const v = VEC[d.facing] ?? [0, 0, 0];
      const out = [d.x + v[0], d.y + v[1], d.z + v[2]];
      const outside = !g.inWindow(...out) || ctx.outside.has(fmt(...out)) || (VEC[d.facing] && v[1] === 0 && ctx.outside.has(fmt(out[0], out[1] + 1, out[2])));
      if (!outside) why.push(`it does not face out (${out.join(',')} is not outside the building)`);
      const feet = [[d.x, d.y, d.z], out, [d.x - v[0], d.y - v[1], d.z - v[2]]].find((c) => wk.feet(...c));
      const vertical = d.facing === 'up' || d.facing === 'down';
      if (!feet || (vertical && !isClimbable(g.at(d.x, d.y, d.z)) && !wk.feet(d.x, d.y, d.z))) why.push(`nobody can stand or climb at it`);
      if (why.length) bad.push(`port '${p.name}': ${why.join(', ')}`);
      else met.push(p.name);
      if (feet) starts.push(feet);
    }
    const kinds = designPorts.filter((q) => q.kind === 'architect:walk' || q.kind === 'door');
    if (kinds.length < row.ports) bad.push(`${kinds.length} walk or door port(s); a ${site.fit} design has at least ${row.ports}`);
    metrics.portsMet = met;
    if (bad.length) add('ports_met', 'warning', bad.length, [], bad.join('; '));
  }

  // ---- floors_reachable from the port (a port fit: no ground entrance); on_pad keeps the entrance rule (check.mjs reachability)
  if (row.approach === 'port' && w) {
    const reached = new Set();
    for (const s of starts) for (const k of wk.reach(s)) reached.add(k);
    const levels = ctx.floorLevels(g, w, wk);
    const bad = [];
    if (!levels.length) bad.push('the interior has no floor level (no row with enough standing room)');
    for (const lv of levels) {
      const n = lv.cells.filter((k) => reached.has(k)).length;
      if (n === 0) bad.push(`floor level y=${lv.y} (${lv.cells.length} cells) cannot be reached from the port${starts.length === 1 ? '' : 's'} (walking, max step 1: stairs, ladders, slabs)`);
      else if (n < lv.cells.length / 2) bad.push(`only ${n} of ${lv.cells.length} cells of floor level y=${lv.y} can be reached from the port${starts.length === 1 ? '' : 's'}`);
    }
    if (!starts.length && site.ports.length) bad.push('no port to start from');
    metrics.reached = reached.size;
    if (bad.length) add('floors_reachable', 'warning', bad.length, [], bad.join('; '));
  }

  // ---- site_breach: a cell the design opens beside the site's water or lava; a dark cave the room opens into, bigger than the room
  if (keepFit) {
    const wet = [];
    for (const [k, c] of g.cells) {
      const [x, y, z] = unfmt(k);
      if (!g.free(x, y, z) || BLOCKS[c.name]?.family === 'liquid') continue;
      for (let d = 1; d <= L.breachWithin; d++) {
        const hit = N6.find(([dx, dy, dz]) => { const s = g.siteAt(x + dx * d, y + dy * d, z + dz * d); return (s === 'WATER' || s === 'LAVA') && !g.written(x + dx * d, y + dy * d, z + dz * d); });
        if (hit) { wet.push(k); break; }
      }
    }
    const cave = w ? caveOf(g, w, outside, light) : { cells: [], room: 0 };
    metrics.breach = wet.length;
    metrics.cave = cave.cells.length;
    const msgs = [];
    if (wet.length) msgs.push(`${wet.length} open cell(s) of the design beside the site's water or lava (it floods in), e.g. ${sample(wet)}`);
    if (cave.cells.length > cave.room) msgs.push(`the room opens into ${cave.cells.length} dark cave cell(s), more than its own ${cave.room} (mobs spawn there), e.g. ${sample(cave.cells.map((c) => fmt(...c)))}`);
    if (msgs.length) add('site_breach', 'warning', wet.length + (cave.cells.length > cave.room ? 1 : 0), [...wet, ...cave.cells.slice(0, 4)], msgs.join('; '));
  }

  // ---- cut_volume: the site's solid the template replaces, against the fit's allowance
  if (keepFit) {
    let rock = 0;
    let logs = 0;
    const logCells = [];
    for (const k of g.cells.keys()) {
      const sc = g.siteAt(...unfmt(k));
      if (sc === 'LOG') { logs++; logCells.push(k); } else if (SOLID.has(sc)) rock++;
    }
    const allowance = site.fit === 'carve_into' && w ? (w.maxX - w.minX + 3) * (w.maxY - w.minY + 3) * (w.maxZ - w.minZ + 3) : null;
    metrics.cut = { rock, logs, allowance };
    const msgs = [];
    if (allowance !== null && rock > allowance) msgs.push(`the template replaces ${rock} cells of the site's solid, more than its interior plus walls (${allowance})`);
    if (site.fit === 'wrap_trunk' && logs) msgs.push(`the template replaces ${logs} log(s) (a wrap_trunk house removes none), e.g. ${sample(logCells)}`);
    if (msgs.length) add('cut_volume', 'warning', (allowance !== null && rock > allowance ? 1 : 0) + logs * (site.fit === 'wrap_trunk' ? 1 : 0), logCells, msgs.join('; '));
  }

  // ---- M15 building scale (site-aware designs only): cantilever and necks
  if (keepFit) {
    const seeds = [...structural].filter((k) => { const [x, y, z] = unfmt(k); return row.bears === 'up' ? solidLeft(x, y + 1, z) || bearing.has(k) : bearing.has(k); });
    const cant = cantilever(structural, seeds, new Set([...structural].filter((k) => BLOCKS[g.cells.get(k).name]?.family === 'stairs')));
    metrics.cantileverMax = cant.max;
    const limit = L.cantilever;
    metrics.cantileverLimit = limit;
    // a cell held on both sides along x or z (its row's run of the mass reaches a cell within the limit each way) is a span, not a cantilever
    const near = (k) => (cant.dist.get(k) ?? Infinity) <= limit;
    const held = (k) => {
      const [x, y, z] = unfmt(k);
      return [[1, 0], [0, 1]].some(([dx, dz]) => [1, -1].every((sgn) => {
        for (let i = 1; ; i++) {
          const n = fmt(x + sgn * i * dx, y, z + sgn * i * dz);
          if (!structural.has(n)) return false;
          if (near(n)) return true;
        }
      }));
    };
    // a horizontal walk port's own column (its width, the floor row under its feet through its height) may stand one step past a supported
    // cell: the connector lands on the cell outside the lot box (§8.4) and region M15 judges that joint (7c). Only that one column.
    const portCol = new Map();
    for (const sp of site.ports) {
      const d = designPorts.find((q) => q.name === sp.name && q.kind === 'architect:walk');
      const v = d && VEC[d.facing];
      if (!v || v[1] !== 0) continue;
      const along = v[0] ? [0, 0, 1] : [1, 0, 0];
      for (let i = 0; i < (sp.width ?? 1); i++) for (let dy = -1; dy < (sp.height ?? 2); dy++) {
        const c = [d.x + along[0] * i, d.y + dy, d.z + along[2] * i];
        portCol.set(fmt(...c), fmt(c[0] - v[0], c[1], c[2] - v[2]));
      }
    }
    const portExempt = (k) => portCol.has(k) && near(portCol.get(k));
    metrics.cantileverPortCells = [...portCol.keys()].filter((k) => cant.dist.has(k)).sort(byCell).map((k) => ({ cell: unfmt(k), dist: cant.dist.get(k) }));
    const heldCells = limit === null ? [] : [...cant.dist].filter(([k, d]) => d > limit && held(k));
    metrics.cantileverHeld = heldCells.length ? Math.max(...heldCells.map(([, d]) => d)) : 0;
    const over = limit === null ? [] : [...cant.dist].filter(([k, d]) => d > limit && !held(k) && !portExempt(k)).map(([k]) => k).sort(byCell);
    if (over.length) add('cantilever', 'warning', over.length, over, `${over.length} block(s) more than ${limit} horizontally from a support column or a bracket, held on one side only (farthest ${Math.max(...over.map((k) => cant.dist.get(k)))}), e.g. ${sample(over)}`);
    const nk = necks(structural, seeds, L.neckMass);
    metrics.necks = nk.length;
    if (nk.length) add('neck', 'warning', nk.length, nk.map((n) => n.at), nk.map((n) => `a mass of ${n.mass} cells hangs on the one cell ${n.at}`).join('; ') + ` (more than ${L.neckMass} cells need at least ${L.neckContact} cells of contact)`);
  }

  findings.sort((a, b) => SITE_RULE_IDS.indexOf(a.rule) - SITE_RULE_IDS.indexOf(b.rule));
  return { findings, metrics };
}

/** Flood the mass from `seeds` through structural cells (6 sides); an attachable joins when its support is reached or is the site's solid. */
function connect(seeds, structural, nodes, solidLeft) {
  const connected = new Set(seeds);
  const q = [...seeds];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = unfmt(q[i]);
    for (const [dx, dy, dz] of N6) {
      const k = fmt(x + dx, y + dy, z + dz);
      if (structural.has(k) && !connected.has(k)) { connected.add(k); q.push(k); }
    }
  }
  const attach = [...nodes].filter(([k]) => !structural.has(k));
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, c] of attach) {
      if (connected.has(k)) continue;
      const [x, y, z] = unfmt(k);
      if (supportOf(c).some(([dx, dy, dz]) => connected.has(fmt(x + dx, y + dy, z + dz)) || solidLeft(x + dx, y + dy, z + dz))) { connected.add(k); changed = true; }
    }
  }
  return connected;
}

/** 6-connected components of a list of cell keys (each sorted as given). */
function components(keys) {
  const set = new Set(keys);
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    if (seen.has(k)) continue;
    const comp = [k];
    seen.add(k);
    for (let i = 0; i < comp.length; i++) {
      const [x, y, z] = unfmt(comp[i]);
      for (const [dx, dy, dz] of N6) {
        const n = fmt(x + dx, y + dy, z + dz);
        if (set.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * A span's ends and its unsupported length. The axis: the site's two opposite faces (lib/site.mjs faces), else the site's two ports'
 * facings, else x. The ends bear on the site's solid below them: the bearing columns' positions along the axis fall into runs; the first
 * and the last run are the ends, and an end bears when it holds an endBearing[0] x endBearing[1] square of bearing cells on one row. The
 * span is the longest gap between runs (no cell bearing on the site anywhere across it).
 */
function spanOf(g, structural, solidLeft, L) {
  const site = g.site;
  let axis = 'x';
  const faces = site.faces();
  const pairX = faces.some((f) => f.normal === 'east') && faces.some((f) => f.normal === 'west');
  const pairZ = faces.some((f) => f.normal === 'north') && faces.some((f) => f.normal === 'south');
  if (pairX && !pairZ) axis = 'x';
  else if (pairZ && !pairX) axis = 'z';
  else {
    const f = site.ports.map((p) => p.facing);
    if (f.includes('north') && f.includes('south') && !(f.includes('east') && f.includes('west'))) axis = 'z';
  }
  const below = [];
  for (const k of structural) {
    const [x, y, z] = unfmt(k);
    if (solidLeft(x, y - 1, z)) below.push([x, y, z]);
  }
  const us = [...new Set(below.map((c) => (axis === 'x' ? c[0] : c[2])))].sort((a, b) => a - b);
  const runs = [];
  for (const u of us) {
    const last = runs[runs.length - 1];
    if (last && u === last.u1 + 1) last.u1 = u; else runs.push({ u0: u, u1: u });
  }
  let span = 0;
  for (let i = 1; i < runs.length; i++) span = Math.max(span, runs[i].u0 - runs[i - 1].u1 - 1);
  const ends = (runs.length >= 2 ? [runs[0], runs[runs.length - 1]] : runs).map((r) => {
    const cells = below.filter((c) => { const u = axis === 'x' ? c[0] : c[2]; return u >= r.u0 && u <= r.u1; });
    const set = new Set(cells.map((c) => fmt(...c)));
    const [a, b] = L.endBearing;
    const square = cells.some(([x, y, z]) => {
      for (const [w, d] of [[a, b], [b, a]]) {
        let ok = true;
        for (let i = 0; i < w && ok; i++) for (let j = 0; j < d && ok; j++) ok = set.has(fmt(x + i, y, z + j));
        if (ok) return true;
      }
      return false;
    });
    return { u0: r.u0, u1: r.u1, cells: cells.length, square, cell: cells[0] ?? [0, 0, 0] };
  });
  return { axis, span, ends: ends.map((e) => ({ ...e })) };
}

/** Vertical runs of chain cells: the longest, and [top cell, length] of every run. */
function chainRuns(g) {
  const chains = [...g.cells].filter(([, c]) => BLOCKS[c.name]?.family === 'chain').map(([k]) => k);
  const set = new Set(chains);
  let max = 0;
  const tops = [];
  for (const k of chains) {
    const [x, y, z] = unfmt(k);
    if (set.has(fmt(x, y + 1, z))) continue;
    let n = 0;
    while (set.has(fmt(x, y - n, z))) n++;
    tops.push([k, n]);
    max = Math.max(max, n);
  }
  return { max, tops };
}

/**
 * The cave a room opens into: from the interior's free cells, through the composite's free cells (closed doors, glass and walls stop it),
 * the site's own air cells reached that the outside flood does not reach and that get no block light. `room`: the interior's free cells.
 */
function caveOf(g, w, outside, light) {
  const start = [];
  for (let y = w.minY; y <= w.maxY; y++) for (let z = w.minZ; z <= w.maxZ; z++) for (let x = w.minX; x <= w.maxX; x++) if (g.free(x, y, z)) start.push(fmt(x, y, z));
  const seen = new Set(start);
  const q = [...start];
  const cave = [];
  for (let i = 0; i < q.length; i++) {
    const [x, y, z] = unfmt(q[i]);
    if (!g.written(x, y, z) && g.siteAt(x, y, z) === 'AIR' && !outside.has(q[i]) && !(g.inBox(x, y, z) && light(x, y, z) > 0)) cave.push([x, y, z]);
    for (const [dx, dy, dz] of N6) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz;
      const k = fmt(nx, ny, nz);
      if (seen.has(k) || !g.inWindow(nx, ny, nz) || !g.free(nx, ny, nz)) continue;
      seen.add(k);
      q.push(k);
    }
  }
  return { cells: cave, room: start.length };
}

/**
 * M15 cantilever: each structural cell's horizontal distance through the mass to a support. Supports (distance 0) are the cells that bear
 * on the site; a cell resting on a cell (the one below it), hanging from one (the one above) or a stair stepping up diagonally from one (a
 * bracket's brace, a roof slope) carries that cell's distance; a horizontal step through the mass (8 ways: a diagonal step counts one, as
 * "4 horizontally" reads) adds 1. A 0-1 flood from the supports.
 */
/** horizontal steps (Chebyshev: "4 horizontally" counts a diagonal step as one) */
const H8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const ZERO = [[0, 1, 0], [0, -1, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
function cantilever(structural, seeds, stairs) {
  const dist = new Map();
  const dq = [];
  for (const k of seeds) { dist.set(k, 0); dq.push(k); }
  // a deque by two lists: cost-0 moves go on `now`, cost-1 moves on `next`
  let now = dq;
  let level = 0;
  let max = 0;
  while (now.length) {
    const next = [];
    for (let i = 0; i < now.length; i++) {
      const k = now[i];
      if (dist.get(k) !== level) continue;
      const [x, y, z] = unfmt(k);
      for (const [dx, dy, dz] of ZERO) {
        const n = fmt(x + dx, y + dy, z + dz);
        if (!structural.has(n) || (dist.has(n) && dist.get(n) <= level)) continue;
        // a diagonal step carries only into a stair (a bracket's brace, a roof slope's step): a block beside a lower one does not rest on it
        if (dy === 1 && (dx || dz) && !stairs.has(n)) continue;
        dist.set(n, level);
        now.push(n);
      }
      for (const [dx, dz] of H8) {
        const n = fmt(x + dx, y, z + dz);
        if (!structural.has(n) || (dist.has(n) && dist.get(n) <= level + 1)) continue;
        dist.set(n, level + 1);
        next.push(n);
      }
      max = Math.max(max, level);
    }
    now = next;
    level++;
  }
  return { dist, max };
}

/**
 * M15 necks: a mass of more than `mass` structural cells that reaches every support through one cell only (an articulation point of the
 * mass, with a virtual ground joined to every support). Iterative Tarjan. Returns [{at, mass}] by cell.
 */
function necks(structural, seeds, mass) {
  const GROUND = 'ground';
  const adj = (k) => {
    if (k === GROUND) return seeds;
    const [x, y, z] = unfmt(k);
    const out = [];
    for (const [dx, dy, dz] of N6) { const n = fmt(x + dx, y + dy, z + dz); if (structural.has(n)) out.push(n); }
    if (seedSet.has(k)) out.push(GROUND);
    return out;
  };
  const seedSet = new Set(seeds);
  const disc = new Map();
  const low = new Map();
  const size = new Map();
  const found = new Map();
  let t = 0;
  const stack = [[GROUND, null, adj(GROUND), 0]];
  disc.set(GROUND, t); low.set(GROUND, t); size.set(GROUND, 1); t++;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [v, parent, nbrs] = top;
    if (top[3] < nbrs.length) {
      const u = nbrs[top[3]++];
      if (u === parent) continue;
      if (disc.has(u)) { low.set(v, Math.min(low.get(v), disc.get(u))); continue; }
      disc.set(u, t); low.set(u, t); size.set(u, 1); t++;
      stack.push([u, v, adj(u), 0]);
      continue;
    }
    stack.pop();
    if (parent === null) continue;
    low.set(parent, Math.min(low.get(parent), low.get(v)));
    size.set(parent, size.get(parent) + size.get(v));
    // v's subtree reaches the ground only through parent: parent is a neck for it (the ground itself is never a neck)
    if (parent !== GROUND && low.get(v) >= disc.get(parent) && size.get(v) > mass) found.set(parent, Math.max(found.get(parent) ?? 0, size.get(v)));
  }
  return [...found].map(([at, m]) => ({ at, mass: m })).sort((a, b) => b.mass - a.mass || (a.at < b.at ? -1 : 1));
}
