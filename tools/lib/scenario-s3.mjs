// (6c S3) The terraced monastery's own rows (docs/CONTRACT.md "Phase 6c slice S3" §7, SETTLEMENTS §16.3), its flat variant's hill and
// the fountain's census in game. The generic rows (tools/lib/scenario-metrics.mjs) give the checker, safety, palette, buildings,
// exactness, determinism, spend and the gallery; T2's route rows (tools/lib/scenario-route.mjs) the grade and the player's and villager's
// reachability. Pure functions over the run's dumps and plan dir, but raiseHill and fountainCensus (DevBridge); tools/scenarios.mjs
// gathers the inputs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleIndex } from '../../kit/lib/region/survey.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });
const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);
const k3 = ([x, y, z]) => `${x},${y},${z}`;

/** The flat variant's hill (CONTRACT S3 §9 item 3): its height over the flat ground and its radius from the claim's centre. */
export const HILL = Object.freeze({ height: 60, margin: 8 });

/**
 * The flat variant's hill, raised first (CONTRACT S3 §9 item 3), with vanilla /fill (deviation, recorded in "as built"): the contract's
 * route, `s3_hill` realised as a region of its own, made every hill cell another owner's journal cell (OWNED), so the monastery's writes
 * there failed their natural-cell conditions and its fountain met "what is not the plan's own" (M25:keep). The same quadratic mound
 * (`hillAt`, kit/regions/s3_hill.mjs: `height` over the flat ground, its radius the claim's half less `margin`), grass on top, 3 dirt,
 * stone under, as natural, unowned land. Per level, the rows' spans merged into boxes; the claim's chunks force-loaded meanwhile.
 * Returns {cells, commands, ground, ms}.
 */
export async function raiseHill(L, claim, sc) {
  void sc;
  const t0 = Date.now();
  const { hillAt } = await import('../../kit/regions/s3_hill.mjs');
  const [x0, z0, x1, z1] = claim;
  const W = x1 - x0 + 1, D = z1 - z0 + 1;
  const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
  const R = Math.max(8, (Math.min(W, D) >> 1) - HILL.margin), H = HILL.height;
  const G = 64; // the flat base's grass (checked below)
  const ok = await L.cmd(`/execute if block ${cx} ${G} ${cz} minecraft:grass_block`);
  if (!ok?.success) throw new Error(`the flat variant's hill: no grass at ${cx} ${G} ${cz} (${JSON.stringify(ok?.messages ?? [])})`);
  await L.cmd(`/forceload add ${x0} ${z0} ${x1} ${z1}`);
  const hAt = (x, z) => hillAt(cx, cz, R, H, x, z);
  // the span of columns at least k high in row z (the mound is convex: one span per row)
  const span = (z, k) => { let a = null, b = null; for (let x = cx - R; x <= cx + R; x++) if (hAt(x, z) >= k) { if (a === null) a = x; b = x; } return a === null ? null : [a, b]; };
  const boxes = (k, y, block) => {
    const out = [];
    let cur = null;
    for (let z = cz - R; z <= cz + R + 1; z++) {
      const s = z <= cz + R ? span(z, k) : null;
      if (cur && s && s[0] === cur.a && s[1] === cur.b) { cur.z1 = z; continue; }
      if (cur) out.push(`/fill ${cur.a} ${y} ${cur.z0} ${cur.b} ${y} ${cur.z1} ${block}`);
      cur = s ? { a: s[0], b: s[1], z0: z, z1: z } : null;
    }
    return out;
  };
  let commands = 0, cells = 0;
  for (let h = 1; h <= H; h++) {
    const y = G + h;
    const list = [...boxes(h, y, 'minecraft:grass_block'), ...boxes(h + 1, y, 'minecraft:dirt'), ...boxes(h + 4, y, 'minecraft:stone')];
    for (let i = 0; i < list.length; i += 32) {
      const res = await Promise.all(list.slice(i, i + 32).map((c) => L.cmd(c)));
      for (const [j, r] of res.entries()) if (!r?.success && !/No blocks were filled|Could not set/.test((r?.messages ?? []).join(' '))) throw new Error(`the flat variant's hill: ${list[i + j]}: ${JSON.stringify(r?.messages ?? [])}`);
    }
    commands += list.length;
  }
  for (let x = cx - R; x <= cx + R; x++) for (let z = cz - R; z <= cz + R; z++) cells += hAt(x, z);
  await L.cmd(`/forceload remove ${x0} ${z0} ${x1} ${z1}`);
  L.log(`  s3 flat: the hill raised by /fill (${commands} commands, ${cells} cells, R ${R}, H ${H}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { cells, commands, ground: G, ms: Date.now() - t0 };
}

/** A fluid op's sets as cells (the IR's runs [x, z, y0, y1]). */
function cellsOf(runs) { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; }
/** The IR's bodies: {id, part, fluid, cells, shell, spill, watch, ice, predicted}. */
export function bodiesIn(ir) {
  const out = [];
  for (const p of ir.parts ?? []) for (const o of p.ops ?? []) if (o.op === 'fluid') {
    out.push({ id: o.id, part: o.part, fluid: o.fluid, cells: cellsOf(o.cells), shell: cellsOf(o.shell), spill: cellsOf(o.spill), watch: cellsOf(o.watch), ice: cellsOf(o.ice), lining: cellsOf(o.lining), grate: cellsOf(o.grate), joins: [], planJoins: [], predicted: o.predicted ?? [] });
  }
  return out;
}
const boxAround = (cells, g = 2) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of cells) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
  return [b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g];
};

/** The fluid census of every body's box (dev.fluid.census): Map body id -> Map "x,y,z" -> state. */
export async function fluidsBefore(L, ir) {
  const out = new Map();
  for (const b of bodiesIn(ir)) {
    const c = await L.call('dev.fluid.census', { box: boxAround([...b.cells, ...b.shell, ...b.spill, ...b.watch], 2) }, 120_000);
    out.set(b.id, new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s])));
  }
  return out;
}

/**
 * Bar 11 in game: each body's census after the realise against its prediction (gate6chy-core's census: its own cells sources, the
 * predicted flowing levels, no fluid of its kind outside its cells, spill and joins that the world did not hold before), and the fluid
 * rows of the region's report ({part, body, state}). Returns {rows, bodies: {id: {ok, sources, flowing, mismatch, outside}}}.
 */
export async function fountainCensus(L, region, ir, before) {
  const st = await L.call('dev.region.state', { region }, 60_000);
  const rows = st.view?.ext?.['architect_mc:fluids'] ?? [];
  const { censusOf } = await import('./gate6chy-core.mjs');
  const bodies = {};
  const all = bodiesIn(ir);
  for (const b of all) {
    const c = await censusOf({ L }, b, before.get(b.id) ?? null, all);
    bodies[b.id] = { ok: c.ok, sources: c.sources, flowing: c.flowing, mismatch: c.mismatch, outside: c.outside, outsideCount: c.outsideCount };
  }
  return { rows: rows.map((r) => ({ part: r.part, body: r.body, state: r.state, reason: r.reason ?? null })), bodies };
}

/**
 * Bar 5's rims (CONTRACT S3 §7): every terraced lot's rim, the column just outside its apron (Chebyshev 2 from its footprint) outside its
 * approach, in the realised world: retained when the land there stands within 2 of the pad's top (the relief's blend, or the ring's
 * wall at the top), else a drop over 2 nothing holds. `terraces`: the plan's meta (answers' geometry) {districtId: {lots: [{id, y}]}};
 * returns {rims, retained, open, sample}.
 */
export function rimsRetained(ir, terraces, after, front) {
  const lots = new Map((ir.lots ?? []).map((l) => [l.id, l]));
  let rims = 0, retained = 0;
  const sample = [];
  const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  const solid = (s) => !!s && !/^minecraft:(air|cave_air|water|lava|short_grass|tall_grass|fern|large_fern|snow|.*_flower|.*_sapling|.*_carpet|dead_bush|poppy|dandelion|torch|lantern|soul_lantern)(\[|$)/.test(s);
  for (const d of Object.values(terraces ?? {})) for (const t of d.lots ?? []) {
    const l = lots.get(t.id);
    if (!l) continue;
    const b = l.box, top = b.minY - 1;
    const e = front?.[t.id]?.entrance ?? null, f = CARD[l.front ?? front?.[t.id]?.front] ?? [0, 0];
    const inApproach = (x, z) => e && [...Array(8).keys()].some((k) => [-2, -1, 0, 1, 2].some((v) => e[0] + f[0] * k + f[1] * v === x && e[2] + f[1] * k + f[0] * v === z));
    for (let z = b.minZ - 2; z <= b.maxZ + 2; z++) for (let x = b.minX - 2; x <= b.maxX + 2; x++) {
      if (Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ) !== 2 || inApproach(x, z)) continue;
      // the land's top at or under the pad's top in that column
      let y = top;
      while (y > top - 12 && !solid(stateAt(after, x, y, z))) y--;
      if (top - y <= 2) { retained++; rims++; continue; }
      rims++;
      if (sample.length < 12) sample.push([x, y, z, t.id, top]);
    }
  }
  return { rims, retained, open: rims - retained, sample };
}

/**
 * Bar 9, earthworks (recorded): cut and fill cells per district and per terrace level against the plan survey, from the virtual world:
 * fill = a written solid cell over the survey's ground, cut = a written air cell at or under it. `geometry`: the monastery's answer
 * geometry ({districts: {id: {rect}}, terraces: {id: {lots: [{id, level, y}]}}}).
 */
export function earthworks(vw, ir, geometry) {
  const P = vw.pal, S = vw.survey;
  const groundAt = (x, z) => S.ground[sampleIndex(S, x, z)];
  const rects = Object.entries(geometry?.districts ?? {}).map(([id, d]) => [id, d.rect]);
  const lotsBy = new Map();
  for (const [did, t] of Object.entries(geometry?.terraces ?? {})) for (const l of t.lots ?? []) { const L = (ir.lots ?? []).find((q) => q.id === l.id); if (L) lotsBy.set(l.id, { did, level: l.level, box: L.box }); }
  const per = {}, perLevel = {};
  vw.eachWritten((x, y, z, idx) => {
    const g = groundAt(x, z);
    const fill = P.solid[idx] && y > g, cut = P.air[idx] && y <= g;
    if (!fill && !cut) return;
    const d = rects.find(([, q]) => x >= q[0] - 12 && x <= q[2] + 12 && z >= q[1] - 12 && z <= q[3] + 12);
    const key = d ? d[0] : 'outside';
    (per[key] ??= { cut: 0, fill: 0 })[cut ? 'cut' : 'fill']++;
    for (const [lid, m] of lotsBy) if (x >= m.box.minX - 2 && x <= m.box.maxX + 2 && z >= m.box.minZ - 2 && z <= m.box.maxZ + 2) { const lk = `${m.did}:${m.level}`; (perLevel[lk] ??= { cut: 0, fill: 0, lots: new Set() })[cut ? 'cut' : 'fill']++; perLevel[lk].lots.add(lid); break; }
  });
  return { perDistrict: per, perLevel: Object.fromEntries(Object.entries(perLevel).map(([k, v]) => [k, { cut: v.cut, fill: v.fill, lots: [...v.lots].sort() }])) };
}

/**
 * S3's rows (CONTRACT S3 §7, bars 1-16), from the generic rows, T2's route rows and S3's measures `x`: {plan: {report}, realised,
 * realisedStand, meta, rims, earth, census, tiles, flat, gravity, load1, lots: {planned, placed, states}}.
 */
export function s3Bars(x, generic, routeRows) {
  const g = Object.fromEntries(generic.map((r) => [r.id, r]));
  const rr = Object.fromEntries((routeRows ?? []).map((r) => [r.id, r]));
  const out = [];
  const pr = x.plan?.report;
  const L = x.lots;
  out.push(row('s3-lots', 'S3 Lots (at least 9 on terrace levels, every one realised)', `${L.planned} planned (${(L.unplaced ?? []).join(', ') || 'none'} unplaced); realised ${L.placed}/${L.planned} PLACED`, 'at least 9 lots; every planned lot PLACED', L.planned >= 9 && L.placed === L.planned));
  // 1: the checker, no M1-M4, M25 0 and M25:clear 0
  const f = (rule) => (pr?.findings ?? []).filter((q) => q.rule === rule).reduce((a, q) => a + q.count, 0);
  out.push(row('checker', 'S3 1 Checker (plan: 0 errors, no M1-M4, M25 0, M25:clear 0)', `${g.checker?.value ?? 'n/a'}; M25 ${f('M25')}; M25:clear ${f('M25:clear')}`, '0 errors; no M1-M4; M25 0; M25:clear 0', g.checker?.pass && f('M25') === 0 && f('M25:clear') === 0));
  const reach = g.reachability, pl = rr['t2-player'];
  out.push(row('reachability', 'S3 2 Reachability, player (realised: every node, the lookout included; every route\'s ends)', `${reach?.value ?? 'n/a'}; ${pl?.value ?? 'n/a'}`, '100% of nodes; 0 unreachable lot entrances', reach?.pass && (pl ? pl.pass : true)));
  if (rr['t2-villager']) out.push({ ...rr['t2-villager'], id: 's3-villager', label: 'S3 3 Reachability, villager (the dwellings: kit mover and vanilla routeNav both ways)', gated: false, pass: null, threshold: `recorded (${rr['t2-villager'].threshold}; judged from 7a)` });
  if (rr['t2-grade']) out.push({ ...rr['t2-grade'], id: 's3-grade', label: 'S3 4 Grade (every 8-cell window within maxGrade 0.2; virtual and realised)' });
  // 5: structure, M3:gravity and the rims
  const rim = x.rims;
  out.push(row('structure', 'S3 5 Structure (M3; M3:gravity; every rim over 2 retained)', `${g.structure?.value ?? 'n/a'}; M3:gravity ${x.gravity}; rims ${rim ? `${rim.retained}/${rim.rims} retained (${rim.open} open)` : 'n/a'}`,
    `${g.structure?.threshold ?? ''}; 0 M3:gravity; 0 open rims`, g.structure?.pass && x.gravity === 0 && (x.flat || (rim && rim.open === 0))));
  // 6: safety and M17 before and after the stand
  const rs = x.realisedStand ?? x.realised;
  const m17p = (pr?.findings ?? []).filter((q) => q.rule === 'M17').length;
  out.push(row('safety', 'S3 6 Safety (M4; full M5 < 1%; M8 100%; M17 0 on the plan and after the 2-minute stand)', `${g.safety?.value ?? 'n/a'}; M17 plan ${m17p}, realised${x.realisedStand ? ' after the stand' : ''} ${rs?.metrics?.M17?.melting ?? 'n/a'}`,
    'M4 0; M5 < 1% of walk area; M8 100%; M17 0', g.safety?.pass && m17p === 0 && (x.flat || (rs?.metrics?.M17 && rs.metrics.M17.melting === 0))));
  const m2627 = (pr?.findings ?? []).filter((q) => /^M2[67]/.test(q.rule)).map((q) => `${q.rule} x${q.count}`);
  out.push({ ...g.palette, label: 'S3 7 Palette (role adherence; M26 and M27 listed)', value: `${g.palette?.value ?? 'n/a'}; M26/M27: ${m2627.join(', ') || 'none'}` });
  out.push({ ...g.organic, label: 'S3 8 Organic read (axis-run share of form and relief boundary cells; risers and walls are structure)', threshold: 'recorded (N-F1-1: recorded through 6c)' });
  const e = x.earth;
  out.push(row('s3-earth', 'S3 9 Earthworks (cut + fill cells per district and per terrace level)', e ? `${Object.entries(e.perDistrict).map(([k, v]) => `${k} cut ${v.cut} fill ${v.fill}`).join('; ')} | levels ${Object.entries(e.perLevel).map(([k, v]) => `${k} ${v.cut}/${v.fill}`).join(', ')}` : 'n/a', 'recorded', null, false));
  out.push({ ...g.buildings, label: 'S3 10 Buildings (kit checker over the placed entries; restraint as 5a)' });
  // 11: the fountain settled, census-exact, and no other part's cells in its sets (M25:clear on the plan)
  const c = x.census;
  const cOk = c && c.rows.length > 0 && c.rows.every((q) => q.state === 'settled') && Object.values(c.bodies).every((b) => b.ok);
  out.push(row('s3-fountain', 'S3 11 The fountain (settled; census equal to its prediction; 0 other parts\' cells in its sets)', c ? `${c.rows.map((q) => `${q.body} ${q.state}`).join(', ') || 'no body'}; census ${Object.entries(c.bodies).map(([k, b]) => `${k} ${b.ok ? 'ok' : `mismatch ${b.mismatch.length} outside ${b.outsideCount}`} (sources ${b.sources}, flowing ${b.flowing})`).join(', ')}; M25:clear ${f('M25:clear')}` : 'n/a (flat variant or no body)',
    'settled; census equal; M25:clear 0', x.flat ? null : cOk && f('M25:clear') === 0, !x.flat));
  if (g.mspt) out.push({ ...g.mspt, label: 'S3 12 MSPT', gated: false, pass: null, threshold: `recorded (judged at release: ${g.mspt.threshold})` });
  const t = x.tiles;
  out.push(row('s3-tiles', 'S3 13 Tile evaluation (best of 3 per tile)', t ? `p50 ${t.p50Ms.toFixed(1)} ms, p99 ${t.p99Ms.toFixed(1)} ms, max ${t.maxMs.toFixed(1)} ms over ${t.count} tiles; ${Math.round(t.cellsPerSecond)} cells/s${x.load1 != null ? ` (load ${x.load1})` : ''}` : 'n/a', 'p99 < 2 s (recorded; judged at the close-out)', null, false));
  out.push({ ...g.exactness, label: 'S3 14 Exactness (E-flat 0; E-normal 0 unclassified under S3\'s classes, the undo\'s own at most 0.01%)' });
  out.push({ ...g.determinism, label: 'S3 15 Determinism', threshold: 'IR sha identical over 3 plans; tiles 1 = 4 workers; the committed golden scenarios/goldens/s3.json holds' });
  out.push({ ...g.spend, label: 'S3 16 Spend', threshold: '$0.00' });
  out.push({ ...g.gallery, label: 'S3 16 Gallery (Noah approves this run\'s evidence.sha, section S3 v1)' });
  // the flat variant judges bar 14 (E-flat) and bars 1-6 (CONTRACT S3 §9 item 3); its other rows are recorded
  if (x.flat) {
    const keep = new Set(['s3-lots', 'checker', 'reachability', 's3-grade', 'structure', 'safety', 'exactness', 'determinism', 'spend', 'gallery']);
    return out.map((r) => (keep.has(r.id) || !r.gated ? r : { ...r, gated: false, pass: null, threshold: `recorded on the flat variant (${r.threshold})` }));
  }
  return out;
}

export { root, k3 };
