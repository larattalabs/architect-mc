// (6c S2) The ice-spike outpost's own rows (docs/CONTRACT.md "Phase 6c slice S2" §3, SETTLEMENTS §16.3): the lots realised, the
// routes (grade, player and villager reachability, T2's rows), structure with M3:gravity, melt across the 2-minute stand (M17 on
// the plan and on the realised world, no ice, snow layer or kept spike cell lost), the kept natural spikes (0 written cells), tile
// evaluation. The generic rows (tools/lib/scenario-metrics.mjs) give the checker, safety, palette, buildings, exactness,
// determinism, spend and the gallery. Pure functions over the run's dumps and plan dir; tools/scenarios.mjs gathers the inputs.
import { VC, classAt } from '../../kit/lib/region/volume.mjs';

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });
const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);
const isIce = (s) => !!s && /^minecraft:(ice|packed_ice|blue_ice|frosted_ice)(\[|$)/.test(s);
const isSnowLayer = (s) => s === 'minecraft:snow' || (!!s && s.startsWith('minecraft:snow['));

/**
 * Across the stand (`after`: right after the realise, `stand`: after the 2-minute stand at default random ticks): every ice block
 * (ice, packed, blue, frosted) and snow layer in the dump box, and the kept spikes' cells (the keep sets' ICE cells from the plan's
 * volumes). Counts before and after the stand, and the cells lost (ice or a snow layer that is no longer one; a kept cell whose
 * state changed). Freezing water and falling snow only add cells, so a loss is a melt.
 */
export function standCounts(ir, vols, after, stand) {
  const box = after.box;
  let iceA = 0, iceS = 0, snowA = 0, snowS = 0;
  const lost = [];
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    const a = stateAt(after, x, y, z), s = stateAt(stand, x, y, z);
    if (isIce(a)) iceA++; if (isIce(s)) iceS++;
    if (isSnowLayer(a)) snowA++; if (isSnowLayer(s)) snowS++;
    if ((isIce(a) && !isIce(s)) || (isSnowLayer(a) && !isSnowLayer(s))) lost.push([x, y, z, a, s]);
  }
  let kept = 0, keptChanged = 0;
  const keptSample = [];
  for (const p of ir.parts) for (const k of p.keep ?? []) {
    const v = vols.get(k.volume);
    if (!v) continue;
    const cls = VC[k.class], b = k.box;
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) {
      if (classAt(v, x, y, z) !== cls) continue;
      kept++;
      const a = stateAt(after, x, y, z), s = stateAt(stand, x, y, z);
      if (a !== null && s !== null && a !== s) { keptChanged++; if (keptSample.length < 20) keptSample.push([x, y, z, a, s]); }
    }
  }
  return { ice: { after: iceA, stand: iceS }, snowLayers: { after: snowA, stand: snowS }, lost: lost.length, lostSample: lost.slice(0, 20), kept: { cells: kept, changed: keptChanged, sample: keptSample } };
}

/** The lots: placed by the plan (meta.outpost), realised (the region's lot states). */
export function lotRows(meta, view) {
  const planned = meta.outpost?.lots ?? [];
  const states = Object.fromEntries((view?.lots ?? []).map((l) => [l.id, l.state]));
  return { planned: planned.length, unplaced: meta.outpost?.unplaced ?? [], states, placed: Object.values(states).filter((s) => String(s).toUpperCase() === 'PLACED').length };
}

/**
 * S2's rows, from the generic rows (`generic`), T2's route rows (`routeRows`, tools/lib/scenario-route.mjs routeBars) and S2's own
 * measures `x`: {plan: {report}, realised, realisedStand, stand (standCounts), keptAfter (forms' keptDiff before/after), lots
 * (lotRows), tiles, flat, gravity (realised M3:gravity count), load1}.
 */
export function s2Bars(x, generic, routeRows) {
  const g = Object.fromEntries(generic.map((r) => [r.id, r]));
  const rr = Object.fromEntries((routeRows ?? []).map((r) => [r.id, r]));
  const out = [];
  const L = x.lots;
  out.push(row('s2-lots', 'S2 Lots (6-8 on the land band, every one realised)', `${L.planned} planned (${L.unplaced.map((u) => u.id).join(', ') || 'none'} unplaced); realised ${L.placed}/${L.planned} PLACED (${Object.entries(L.states).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    'at least 6 lots; every planned lot PLACED', L.planned >= 6 && L.placed === L.planned));
  out.push({ ...g.checker, label: 'S2 1 Checker (plan)' });
  // 2: the realised M2 (every node from the gate) and every route's ends by the player mover
  const reach = g.reachability, pl = rr['t2-player'];
  out.push(row('reachability', 'S2 2 Reachability, player (realised: every node; every route\'s ends)', `${reach?.value ?? 'n/a'}; ${pl?.value ?? 'n/a'}`, '100% of nodes; 0 unreachable lot entrances', reach?.pass && pl?.pass));
  if (rr['t2-grade']) out.push({ ...rr['t2-grade'], id: 's2-grade', label: 'S2 Route grade (every 8-cell window, maxGrade 0.2; virtual and realised)' });
  if (rr['t2-routed']) out.push({ ...rr['t2-routed'], id: 's2-routed', label: 'S2 Routes from the gate to every lot entrance' });
  // 3: recorded (SETTLEMENTS gates villager reachability from 7a)
  if (rr['t2-villager']) out.push({ ...rr['t2-villager'], id: 's2-villager', label: 'S2 3 Reachability, villager (the hut, farm and job edges: kit mover and vanilla dev.nav.villager)', gated: false, pass: null, threshold: `recorded (${rr['t2-villager'].threshold}; SETTLEMENTS gates it from 7a)` });
  // 4: structure, and M3:gravity 0
  out.push(row('structure', 'S2 4 Structure (M3; M3:gravity)', `${g.structure?.value ?? 'n/a'}; M3:gravity ${x.gravity}`, `${g.structure?.threshold ?? ''}; 0 M3:gravity`, g.structure?.pass && x.gravity === 0));
  out.push({ ...g.safety, label: 'S2 5 Safety (M4; full M5; M8)' });
  // 6: melt
  const pr = x.plan?.report, rs = x.realisedStand ?? x.realised;
  const f17 = (rep) => (rep?.findings ?? []).filter((f) => f.rule === 'M17');
  const st = x.stand;
  out.push(row('melt', 'S2 6 Melt (M17 plan and realised after the stand; ice, snow layers and kept spikes across the stand)',
    `plan M17 ${f17(pr).length} finding(s); realised${x.realisedStand ? ' after the stand' : ''} M17 ${rs?.metrics?.M17?.melting ?? 'n/a'} of ${rs?.metrics?.M17?.checked ?? '?'}${st ? `; ice ${st.ice.after} -> ${st.ice.stand}, snow layers ${st.snowLayers.after} -> ${st.snowLayers.stand}, lost ${st.lost}; kept spike cells changed ${st.kept.changed} of ${st.kept.cells}` : '; no stand (flat)'}`,
    'M17 0 on the plan and after the stand; no ice, snow-layer or kept-spike cell lost across the stand', f17(pr).length === 0 && (x.flat || (rs?.metrics?.M17 && rs.metrics.M17.melting === 0 && st && st.lost === 0 && st.kept.changed === 0))));
  // 7: kept spikes untouched by the region
  const k = x.keptAfter;
  out.push(row('kept', 'S2 7 Kept natural spikes (ARWD before/after the realise)', k ? (k.error ?? `${k.changed} of ${k.kept} kept cells changed`) : 'no keep set', '0 written cells in the keep sets', x.flat || (k && !k.error && k.changed === 0)));
  out.push({ ...g.palette, label: 'S2 8 Palette (role adherence; form materials count)' });
  out.push({ ...g.organic, label: 'S2 9 Organic read (axis-run share of the form boundary cells)', threshold: 'recorded (N-F1-1: recorded through 6c)' });
  out.push({ ...g.buildings, label: 'S2 10 Buildings (kit checker over the placed entries)' });
  // 11 and 12: timing bars, recorded in a slice (GATES.md "Policy update"), judged at release
  if (g.mspt) out.push({ ...g.mspt, label: 'S2 11 MSPT', gated: false, pass: null, threshold: `recorded (judged at release: ${g.mspt.threshold})` });
  const t = x.tiles;
  out.push(row('s2-tiles', 'S2 12 Tile evaluation (best of 3 per tile)', t ? `p50 ${t.p50Ms.toFixed(1)} ms, p99 ${t.p99Ms.toFixed(1)} ms, max ${t.maxMs.toFixed(1)} ms over ${t.count} tiles; ${Math.round(t.cellsPerSecond)} cells/s${x.load1 != null ? ` (load ${x.load1})` : ''}` : 'n/a', 'p99 < 2 s', t && t.p99Ms < 2000));
  out.push({ ...g.exactness, label: 'S2 13 Exactness' });
  out.push({ ...g.determinism, label: 'S2 14 Determinism', threshold: 'IR sha identical over 3 plans; tiles 1 = 4 workers; the committed golden scenarios/goldens/s2.json holds' });
  out.push({ ...g.spend, label: 'S2 15 Spend', threshold: '$0.00' });
  out.push({ ...g.gallery, label: 'S2 16 Gallery' });
  // the flat variant shows bar 13 (E-flat) and its own determinism (CONTRACT S2 §4 item 2); its other rows are recorded
  if (x.flat) return out.map((r) => (['exactness', 'determinism', 'spend', 'gallery'].includes(r.id) || !r.gated ? r : { ...r, gated: false, pass: null, threshold: `recorded on the flat variant (${r.threshold})` }));
  return out;
}
