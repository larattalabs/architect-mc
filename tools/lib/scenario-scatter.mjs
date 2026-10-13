// (6c F2) The scatter_demo scenarios' own measures and bar rows (docs/CONTRACT.md 6c F2 §5): supports on the realised world (no
// floating cell, plants on their vanilla soils by the exact 26.3 tag, nothing on walk cells, lot boxes or keep-out), melt across the
// stand, the stamps realised exactly (with their skirts) and the scatter placements as planned. Pure functions over the plan's virtual
// world and the decoded ARWD dumps; tools/scenarios.mjs gathers the inputs.
import { hasTag } from '../../kit/lib/blocks.mjs';
import { F_WALK, F_WRITTEN } from '../../kit/lib/region/vworld.mjs';

const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);
const name = (s) => String(s).replace(/\[.*$/, '');
/** The plants the bundled items place, each on `#minecraft:supports_vegetation` (the lower half of a large fern). */
const PLANTS = new Set(['minecraft:fern', 'minecraft:large_fern', 'minecraft:bush', 'minecraft:short_grass', 'minecraft:tall_grass']);
const isSnowLayer = (s) => s === 'minecraft:snow' || String(s).startsWith('minecraft:snow[');

/** A planned state with only some properties (`glow_lichen[up=true]`: the rest are the block's defaults) against the dump's full one. */
function sameState(want, got) {
  const p = (x) => { const i = x.indexOf('['); return [i < 0 ? x : x.slice(0, i), i < 0 ? [] : x.slice(i + 1, -1).split(',')]; };
  const [wn, wp] = p(want), [gn, gp] = p(got);
  return wn === gn && wp.every((kv) => gp.includes(kv));
}

/** The parts that hold scatter and stamp ops (by IR part index) and their kinds. */
export function f2Parts(ir) {
  const scatter = new Set(), stamp = new Set();
  ir.parts.forEach((p, i) => {
    if (p.ops.some((o) => o.op === 'scatter')) scatter.add(i);
    if (p.ops.some((o) => o.op === 'stamp')) stamp.add(i);
  });
  return { scatter, stamp, all: new Set([...scatter, ...stamp]) };
}

/**
 * Item 3 on the realised world: every cell a scatter or stamp part wrote (the plan's virtual world: what it planned to write; the
 * after-dump: what is there) checked against the walk columns, the lots' boxes and aprons and keep-out, and every plant against the
 * block under it (the exact tag over the dump). `realised` is the realised checker report (its M3 findings per part).
 */
export function supports({ ir, vw, after, realised }) {
  const P = f2Parts(ir);
  const walk = new Set();
  vw.eachWritten((x, y, z) => { if (vw.flags(x, y, z) & F_WALK) walk.add(`${x},${z}`); });
  const lots = (ir.lots ?? []).map((l) => l.box);
  const keepOut = ir.keepOut ?? [];
  let cells = 0, onWalk = 0, inLot = 0, inKeepOut = 0, plants = 0, wrongSoil = 0;
  const sample = [];
  vw.eachWritten((x, y, z, idx) => {
    if (!P.all.has(vw.partAt(x, y, z)) || vw.pal.air[idx]) return;
    const got = stateAt(after, x, y, z);
    if (got === null || name(got) === 'minecraft:air') return;
    cells++;
    if (walk.has(`${x},${z}`)) { onWalk++; if (sample.length < 20) sample.push(['walk', x, y, z, got]); }
    if (lots.some((b) => x >= b.minX - 1 && x <= b.maxX + 1 && z >= b.minZ - 1 && z <= b.maxZ + 1)) { inLot++; if (sample.length < 20) sample.push(['lot', x, y, z, got]); }
    if (keepOut.some((k) => x >= k[0] && x <= k[2] && z >= k[1] && z <= k[3])) inKeepOut++;
    if (PLANTS.has(name(got)) && !/half=upper/.test(got)) {
      plants++;
      const below = stateAt(after, x, y - 1, z);
      if (!below || !hasTag(name(below), 'minecraft:supports_vegetation')) { wrongSoil++; if (sample.length < 20) sample.push(['soil', x, y, z, got, below]); }
    }
  });
  const m3 = (realised?.findings ?? []).filter((f) => /^M3/.test(f.rule) && f.part !== null && ir.parts.findIndex((p) => p.id === f.part) >= 0 && P.all.has(ir.parts.findIndex((p) => p.id === f.part)));
  const floating = m3.filter((f) => f.rule === 'M3' || f.rule === 'M3:floating_spur' || f.rule === 'M3:gravity').reduce((a, f) => a + f.count, 0);
  return { cells, onWalk, inLot, inKeepOut, plants, wrongSoil, floating, m3: m3.map((f) => `${f.rule} ${f.part} x${f.count}: ${f.message}`), sample };
}

/**
 * Item 5 (and the scatter placements): every cell the plan's virtual world says a stamp (or scatter) part wrote, against the
 * after-dump. A stamp's cells include its skirt (the evaluator's own). Returns per part `{part, kind, cells, equal, differ, outside,
 * sample}`.
 */
export function asPlanned({ ir, vw, after }) {
  const P = f2Parts(ir);
  const out = new Map();
  vw.eachWritten((x, y, z, idx) => {
    const pi = vw.partAt(x, y, z);
    if (!P.all.has(pi)) return;
    const p = ir.parts[pi];
    let e = out.get(p.id);
    if (!e) { e = { part: p.id, kind: P.stamp.has(pi) ? 'stamp' : 'scatter', cells: 0, equal: 0, differ: 0, outside: 0, sample: [] }; out.set(p.id, e); }
    e.cells++;
    const want = vw.pal.states[idx], got = stateAt(after, x, y, z);
    if (got === null) e.outside++;
    else if (got === want || sameState(want, got)) e.equal++;
    else { e.differ++; if (e.sample.length < 10) e.sample.push([x, y, z, want, got]); }
  });
  return [...out.values()];
}

/** Snow layers the scatter wrote (the plan's virtual world) that the stand turned into something else (melt or a fall). */
export function snowAcrossStand({ ir, vw, after, stand }) {
  if (!stand) return null;
  const P = f2Parts(ir);
  let written = 0, kept = 0;
  const lost = [];
  vw.eachWritten((x, y, z, idx) => {
    if (!P.scatter.has(vw.partAt(x, y, z)) || !isSnowLayer(vw.pal.states[idx])) return;
    const a = stateAt(after, x, y, z), s = stateAt(stand, x, y, z);
    if (!isSnowLayer(a)) return;
    written++;
    if (isSnowLayer(s)) kept++;
    else if (lost.length < 20) lost.push([x, y, z, a, s]);
  });
  return { written, kept, lost: written - kept, sample: lost };
}

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });
const f17 = (rep) => (rep?.findings ?? []).filter((f) => f.rule === 'M17');

/** The F2 rows (contract §5 items 1, 3-5, 7-9 that a scenario run shows), replacing the generic lot rows. */
export function scatterBars(x, generic) {
  const out = [];
  const pr = x.plan?.report, rs = x.realisedStand ?? x.realised;
  out.push(row('checker', 'Checker (plan)', pr ? `${pr.errors} errors; M3 ${(pr.findings ?? []).filter((f) => /^M3/.test(f.rule)).length}; M17 ${f17(pr).length}` : 'no report', '0 errors (M1 kept cells, M13, M14)', pr && pr.errors === 0));
  const s = x.supports;
  out.push(row('supports', 'Supports (item 3)', s ? `realised: ${s.floating} floating cell(s) in scatter and stamp parts${s.m3.length ? ` (${s.m3.join('; ')})` : ''}; ${s.wrongSoil} of ${s.plants} plants off #supports_vegetation; on walk columns ${s.onWalk}, in lot boxes or aprons ${s.inLot}, in keep-out ${s.inKeepOut} (of ${s.cells} item cells)` : 'n/a',
    '0 floating; 0 plants on wrong soil; 0 on walk cells, lot boxes, keep-out', s && s.floating === 0 && s.wrongSoil === 0 && s.onWalk === 0 && s.inLot === 0 && s.inKeepOut === 0));
  const m = x.melt, sn = x.snow;
  const realisedM17 = rs?.metrics?.M17;
  out.push(row('melt', 'Melt (M17, item 4)', `plan M17 ${f17(pr).length} finding(s); realised${x.realisedStand ? ' after the stand' : ''} M17 ${realisedM17?.melting ?? 'n/a'} of ${realisedM17?.checked ?? '?'} ice/snow cells${m ? `; across the stand: snow layers ${m.snowLayers.after} -> ${m.snowLayers.stand}, lost within a planned light's reach ${m.lostInReach}` : ''}${sn ? `; the scatter's snow layers ${sn.written} -> ${sn.kept}` : '; no stand (flat or cave)'}`,
    'M17 0 before and after the 2-minute stand; the snow-layer count unchanged by the stand', f17(pr).length === 0 && realisedM17 && realisedM17.melting === 0 && (!m || m.lostInReach === 0) && (!sn || sn.lost === 0)));
  const st = (x.planned ?? []).filter((e) => e.kind === 'stamp'), sc = (x.planned ?? []).filter((e) => e.kind === 'scatter');
  const stampFloat = s ? s.m3.filter((f) => /^M3 stamp_/.test(f)).length : 0;
  out.push(row('stamps', 'Stamps (item 5)', st.length ? `${st.map((e) => `${e.part}: ${e.equal}/${e.cells} equal, ${e.differ} differ, ${e.outside} outside`).join('; ')}; ${x.stampsMissing?.length ? `not in the library: ${x.stampsMissing.join(', ')}; ` : ''}floating stamp parts ${stampFloat}` : `no stamp op${x.stampsMissing?.length ? ` (not in the library: ${x.stampsMissing.join(', ')})` : ''}`,
    'realised cells equal the stamp\'s cells (turned) plus its skirt; 0 floating cells', st.length > 0 && st.every((e) => e.differ === 0 && e.outside === 0) && stampFloat === 0 && !(x.stampsMissing?.length)));
  const scT = sc.reduce((a, e) => ({ cells: a.cells + e.cells, equal: a.equal + e.equal, differ: a.differ + e.differ }), { cells: 0, equal: 0, differ: 0 });
  out.push(row('placements', 'Scatter as planned', sc.length ? `${scT.equal}/${scT.cells} cells equal the plan's (${sc.map((e) => `${e.part} ${e.equal}/${e.cells}`).join(', ')}); differing ${scT.differ}${sc.flatMap((e) => e.sample).length ? `, e.g. ${JSON.stringify(sc.flatMap((e) => e.sample).slice(0, 3))}` : ''}` : 'no scatter op', 'recorded (the plan over its survey and the realise over its frozen heights agree on an unchanged world)', null, false));
  out.push(row('workers', 'Tile independence (item 1)', x.workersSame ? 'tile shas identical for 1 and 4 workers, forward and shuffled' : 'tile shas DIFFER between 1 and 4 workers', 'identical', !!x.workersSame));
  const t = x.tiles;
  out.push(row('tiles', 'Tile evaluation (item 9)', t ? `p99 ${t.p99Ms.toFixed(0)} ms, max ${t.maxMs.toFixed(0)} ms over ${t.count} tiles; ${Math.round(t.cellsPerSecond)} cells/s (best of ${t.passes ?? 1} passes per tile${x.load1 != null ? `, load ${x.load1}` : ''})` : 'n/a', 'recorded (timing bars never block a slice; judged at release: p99 under 2 s per tile, at least 45k cells/s)', null, false));
  const g = Object.fromEntries((generic ?? []).map((r) => [r.id, r]));
  for (const id of ['determinism', 'exactness', 'spend']) if (g[id]) out.push({ ...g[id], label: `${g[id].label} (item ${{ determinism: 7, exactness: 8, spend: 11 }[id]})` });
  if (g.mspt) out.push({ ...g.mspt, label: `${g.mspt.label} (item 9)`, gated: false, pass: null, threshold: `recorded (judged at release: ${g.mspt.threshold})` });
  const own = x.mspt?.ownCpu;
  if (own) out.push(row('ownP99', 'Own CPU p99 (item 9)', `p99 ${own.p99.toFixed(1)} ms, max ${own.max.toFixed(1)} ms over ${own.ticks} ticks with work`, 'recorded (judged at release: p99 at most 25 ms)', null, false));
  for (const id of ['reachability', 'safety', 'palette']) if (g[id]) out.push({ ...g[id], gated: false, pass: null, threshold: `recorded (${g[id].threshold})` });
  out.push(row('gallery', 'Gallery', 'not asked for F2', 'none (F2 has no gallery bar)', null, false));
  return out;
}
