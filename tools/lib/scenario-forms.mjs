// (6c F1) The forms_demo scenario's own measures and bar rows (docs/CONTRACT.md 6c F1 §7): melt across the stand, the kept natural
// cells, the baked voxels against the realised world, tile evaluation time. Pure functions over decoded ARWD dumps and the plan dir;
// tools/scenarios.mjs gathers the inputs.
import fs from 'node:fs';
import path from 'node:path';
import { decodeVoxels, turnState, turnXZ, voxelAt, ROTATIONS } from '../../kit/lib/region/voxels.mjs';
import { VC, classAt, decodeArvx } from '../../kit/lib/region/volume.mjs';

const isIce = (s) => s === 'minecraft:ice' || s.startsWith('minecraft:frosted_ice');
const isSnowLayer = (s) => s === 'minecraft:snow' || s.startsWith('minecraft:snow[');
const stateAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);

/**
 * Melt across the 2-minute stand: ice and snow-layer cells in `after` (the dump right after the realise) and `stand` (after the
 * stand). `lights`: [[x, y, z, level], ...] the plan's light cells; `reach` the cells within (level - 1) of one (Manhattan): the
 * cells a planned light could melt. Returns totals and the cells that stopped being ice or a snow layer within reach.
 */
export function meltAcrossStand(after, stand, lights) {
  const box = after.box;
  let iceA = 0, iceS = 0, snowA = 0, snowS = 0;
  const lost = [];
  const near = (x, y, z) => lights.some(([lx, ly, lz, lv]) => Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z) <= lv - 1);
  for (let x = box.minX; x <= box.maxX; x++) for (let z = box.minZ; z <= box.maxZ; z++) for (let y = box.minY; y <= box.maxY; y++) {
    const a = stateAt(after, x, y, z), s = stateAt(stand, x, y, z);
    const ai = isIce(a), as = isSnowLayer(a);
    if (ai) iceA++; if (as) snowA++;
    if (isIce(s)) iceS++; if (isSnowLayer(s)) snowS++;
    if ((ai && !isIce(s)) || (as && !isSnowLayer(s))) if (near(x, y, z)) lost.push([x, y, z, a, s]);
  }
  return { ice: { after: iceA, stand: iceS }, snowLayers: { after: snowA, stand: snowS }, lostInReach: lost.length, lostSample: lost.slice(0, 20), lights: lights.length };
}

/** The plan's light cells (written emitters) from the virtual world: [[x, y, z, level]]. */
export function plannedLights(vw) {
  const out = [];
  vw.eachWritten((x, y, z, idx) => { const e = vw.pal.emit[idx]; if (e > 0) out.push([x, y, z, e]); });
  return out;
}

/** The decoded volumes of a plan dir's IR (`ir.volumes` -> the side blobs): Map(name -> decoded ARVX). */
export function planVolumes(planDir, ir) {
  const out = new Map();
  for (const [name, v] of Object.entries(ir.volumes ?? {})) {
    const f = path.join(planDir, 'blobs', `${ir.blobs?.[v.blob]?.sha}.bin`);
    if (fs.existsSync(f)) out.set(name, decodeArvx(fs.readFileSync(f)));
  }
  return out;
}

/** Kept natural cells (every part's `keep`) that differ between `before` and `after` (ARWD): bar 4 wants 0. */
export function keptDiff(ir, vols, before, after) {
  let kept = 0, changed = 0;
  const sample = [];
  for (const p of ir.parts) for (const k of p.keep ?? []) {
    const v = vols.get(k.volume);
    if (!v) return { error: `volume ${k.volume} is not in the plan dir` };
    const cls = VC[k.class], b = k.box;
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) {
      if (classAt(v, x, y, z) !== cls) continue;
      kept++;
      const a = stateAt(before, x, y, z), c = stateAt(after, x, y, z);
      if (a !== null && c !== null && a !== c) { changed++; if (sample.length < 20) sample.push([x, y, z, a, c]); }
    }
  }
  return { kept, changed, sample };
}

/** Every voxels op's cells against the realised dump: equal, differing, outside the dump. Bar 7 wants 0 differing. */
export function voxelsExact(ir, planDir, after) {
  const out = [];
  for (const p of ir.parts) for (const o of p.ops) {
    if (o.op !== 'voxels') continue;
    const b = ir.blobs[o.blob];
    const v = decodeVoxels(fs.readFileSync(path.join(planDir, 'blobs', `${b.sha}.bin`)));
    const k = ROTATIONS.indexOf(o.rotation ?? 0);
    let equal = 0, differ = 0, outside = 0;
    const sample = [];
    for (let i = 0; i < v.count; i++) {
      const [lx, ly, lz] = voxelAt(v, i);
      const [dx, dz] = turnXZ(lx, lz, v.size[0], v.size[2], k);
      const x = o.origin[0] + dx, y = o.origin[1] + ly, z = o.origin[2] + dz;
      const want = turnState(v.palette[v.pal[i]], k), got = stateAt(after, x, y, z);
      if (got === null) { outside++; continue; }
      if (got === want) equal++;
      else { differ++; if (sample.length < 20) sample.push([x, y, z, want, got]); }
    }
    out.push({ part: p.id, blob: o.blob, sha: b.sha, cells: v.count, equal, differ, outside, sample });
  }
  return out;
}

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });
const f17 = (rep) => (rep?.findings ?? []).filter((f) => f.rule === 'M17');

/**
 * The F1 rows (contract §7 items 2-5 and 7-13 that a scenario run shows), replacing the generic ones that do not apply (lots,
 * buildings, the M2/M5/M8 walk rows are recorded only).
 */
export function formsBars(x, generic) {
  const out = [];
  const pr = x.plan?.report, rr = x.realised, rs = x.realisedStand ?? x.realised;
  const keepErr = (pr?.findings ?? []).filter((f) => f.rule === 'M1');
  out.push(row('checker', 'Checker (plan)', pr ? `${pr.errors} errors; M1 ${keepErr.length}; M3 ${(pr.findings ?? []).filter((f) => /^M3/.test(f.rule)).length}; M17 ${f17(pr).length}` : 'no report', '0 errors (M1 kept cells, M13, M14); no M3 or M17 findings', pr && pr.errors === 0));
  const M3 = rr?.metrics?.M3;
  const spurs = (rr?.findings ?? []).filter((f) => f.rule === 'M3:floating_spur').reduce((a, f) => a + f.count, 0);
  const planOver = pr?.metrics?.M3?.overhangCells ?? null;
  out.push(row('structure', 'Structure (M3, item 2)', M3 ? `realised: floating cells ${M3.floatingCells}; spurs ${spurs}; overhangs over 4 ${M3.overhangCells ?? 'n/a'} (max ${M3.maxOverhang ?? 'n/a'}) over ${M3.formCells ?? '?'} form cells; plan overhangs over 4 ${planOver}` : 'n/a',
    '0 floating cells; 0 overhangs over 4 without a buttress (plan and realised)', M3 && M3.floatingCells === 0 && spurs === 0 && (M3.overhangCells ?? 1) === 0 && planOver === 0));
  const m = x.melt;
  const realisedM17 = rs?.metrics?.M17;
  out.push(row('melt', 'Melt (M17, item 3)', `plan M17 ${f17(pr).length} finding(s) (${pr?.metrics?.M17?.melting ?? '?'} cells); realised${x.realisedStand ? ' after the stand' : ''} M17 ${realisedM17?.melting ?? 'n/a'} of ${realisedM17?.checked ?? '?'} ice/snow cells${m ? `; across the stand: ice ${m.ice.after} -> ${m.ice.stand}, snow layers ${m.snowLayers.after} -> ${m.snowLayers.stand}, lost within the lights' reach ${m.lostInReach}` : '; no stand (flat)'}`,
    'M17 0 on the plan and on the realised world after the stand; no ice or snow layer lost within a planned light\'s reach', f17(pr).length === 0 && realisedM17 && realisedM17.melting === 0 && (!m || m.lostInReach === 0)));
  const k = x.kept;
  out.push(row('kept', 'Kept natural cells (item 4)', k ? (k.error ?? `${k.changed} of ${k.kept} kept cells changed (ARWD before/after)`) : 'no keep set', '0 written cells in keep sets', k && !k.error && k.changed === 0));
  out.push(row('organic', 'Organic read (item 5)', x.organic ? `axis-run share ${x.organic.share.toFixed(3)} of ${x.organic.boundaryCells} form boundary cells; per generator ${JSON.stringify(x.organicPer ?? {})}` : 'n/a', 'recorded (gated from S2, N-F1-1)', null, false));
  const vx = x.voxels ?? [];
  out.push(row('voxels', 'Voxels (item 7)', vx.length ? vx.map((v) => `${v.part}: ${v.equal}/${v.cells} equal, ${v.differ} differ, ${v.outside} outside the dump`).join('; ') + `; tiles 1 vs 4 workers ${x.workersSame ? 'identical' : 'DIFFER'}` : 'no voxels op',
    'realised cells equal the baked blob exactly; tile shas equal for 1 and 4 workers, shuffled', vx.length > 0 && vx.every((v) => v.differ === 0 && v.outside === 0) && x.workersSame));
  const t = x.tiles;
  out.push(row('tiles', 'Tile evaluation (item 8)', t ? `p99 ${t.p99Ms.toFixed(0)} ms, max ${t.maxMs.toFixed(0)} ms over ${t.count} tiles; ${Math.round(t.cellsPerSecond)} cells/s (best of ${t.passes ?? 1} passes per tile${x.load1 != null ? `, load ${x.load1}` : ''})` : 'n/a', 'p99 under 2 s per tile; at least 45k cells/s', t && t.p99Ms < 2000 && t.cellsPerSecond >= 45000));
  const g = Object.fromEntries((generic ?? []).map((r) => [r.id, r]));
  for (const id of ['determinism', 'exactness', 'mspt', 'spend']) if (g[id]) out.push({ ...g[id], label: `${g[id].label} (item ${{ determinism: 9, exactness: 10, mspt: 11, spend: 13 }[id]})` });
  const own = x.mspt?.ownCpu;
  if (own) out.push(row('ownP99', 'Own CPU p99 (item 11)', `p99 ${own.p99.toFixed(1)} ms, max ${own.max.toFixed(1)} ms over ${own.ticks} ticks with work`, 'p99 at most 25 ms', own.p99 <= 25));
  for (const id of ['reachability', 'safety', 'palette']) if (g[id]) out.push({ ...g[id], gated: false, pass: null, threshold: `recorded (${g[id].threshold})` });
  out.push(row('gallery', 'Gallery', 'not asked for F1', 'none (F1 has no gallery bar)', null, false));
  return out;
}
