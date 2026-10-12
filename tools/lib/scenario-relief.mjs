// (6c T1) relief_demo's own rows (docs/CONTRACT.md "Phase 6c slice T1" §6, items 1-4 and 10): blend smoothness (virtual and
// realised), the pads at their target, the clamps and the erosion's extra, the organic read against the same program with
// `pad.edge: 'slope'`, and the checker. Offline: every input is the plan dir (IR, survey, blobs) and the dumps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeField } from '../../kit/lib/material.mjs';
import { RELIEF_NONE } from '../../kit/lib/realise.mjs';
import { asColumns } from '../../kit/lib/region/pack.mjs';
import { sampleIndex } from '../../kit/lib/region/survey.mjs';
import { F_WRITTEN, buildVirtual } from '../../kit/lib/region/vworld.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const key = (x, z) => `${x},${z}`;

/**
 * The relief columns of an IR over its plan survey (the evaluator's view: each column's frozen ground is the survey's nearest
 * sample, as windowFromSurvey): key -> {x, z, g, dh (clamped), top, mode, part, clampedBy (the clamp's cut), raw}. A later op wins.
 */
export function reliefColumns(ir, survey, blobs) {
  const c = asColumns(survey);
  const out = new Map();
  for (const p of ir.parts) for (const o of p.ops) {
    if (o.op !== 'relief') continue;
    const e = ir.fields[o.field];
    const f = decodeField(e, blobs(ir.blobs[e.blob].sha));
    for (let j = 0; j < f.depth; j++) for (let i = 0; i < f.width; i++) {
      const v = f.values[i + j * f.width];
      if (v === RELIEF_NONE) continue;
      for (let dz = 0; dz < f.res; dz++) for (let dx = 0; dx < f.res; dx++) {
        const x = f.minX + i * f.res + dx, z = f.minZ + j * f.res + dz;
        if (x < ir.claim.minX || x > ir.claim.maxX || z < ir.claim.minZ || z > ir.claim.maxZ) continue;
        const g = c.ground[sampleIndex(c, x, z)];
        const raw = o.mode === 'target' ? v - g : v;
        const dh = Math.max(-o.maxCut, Math.min(o.maxFill, raw));
        if (o.mode !== 'target' && dh === 0) { out.delete(key(x, z)); continue; }
        out.set(key(x, z), { x, z, g, dh, top: g + dh, raw, mode: o.mode, part: p.id, maxCut: o.maxCut, maxFill: o.maxFill });
      }
    }
  }
  return out;
}

/** Adjacent-column steps between columns both in `band` (keys) of the tops map: {pairs, le1, over3, share, max}. */
export function smoothness(tops, band) {
  let pairs = 0, le1 = 0, over3 = 0, max = 0;
  const worst = [];
  for (const k of band) {
    const [x, z] = k.split(',').map(Number);
    const a = tops.get(k);
    if (a === undefined) continue;
    for (const [dx, dz] of [[1, 0], [0, 1]]) {
      const k2 = key(x + dx, z + dz);
      if (!band.has(k2)) continue;
      const b = tops.get(k2);
      if (b === undefined) continue;
      const s = Math.abs(a - b);
      pairs++;
      if (s <= 1) le1++;
      if (s > 3) { over3++; if (worst.length < 20) worst.push([x, z, x + dx, z + dz, s]); }
      if (s > max) max = s;
    }
  }
  return { pairs, le1, over3, share: pairs ? le1 / pairs : 1, max, worst };
}

const NOT_GROUND = /(^minecraft:(air|cave_air|void_air|water|lava|snow|short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|bubble_column)$)|leaves|_log$|_wood$|flower|tulip|poppy|dandelion|orchid|allium|bluet|daisy|cornflower|lily|rose|lilac|peony|sapling|mushroom$|sweet_berry|pink_petals|wildflowers|leaf_litter|bush$|torch|lantern|_fence|_wall$|carpet/;

/**
 * The realised top per column (key -> y): from above the column down, the first cell that is ground (not air, a plant, a tree, a
 * prop). With `allowed` (the relief ops' fill blocks), a column whose top is another block was written over by something else (a
 * lot's approach stair over the band): it is left out and counted in `out.other`.
 */
export function dumpTops(dump, cols, above = 6, allowed = null) {
  const out = new Map();
  out.other = [];
  const name = (s) => s.replace(/\[.*$/, '');
  for (const [k, c] of cols) {
    const { x, z } = c;
    if (x < dump.box.minX || x > dump.box.maxX || z < dump.box.minZ || z > dump.box.maxZ) continue;
    // from the dump's top (anything a later writer stacked on the column is seen; trees and plants are skipped)
    for (let y = above === null ? dump.box.maxY : Math.min(dump.box.maxY, Math.max(c.top, c.g) + above); y >= dump.box.minY; y--) {
      const st = dump.palette[dump.cells[dump.at(x, y, z)]];
      if (NOT_GROUND.test(name(st))) continue;
      if (allowed && !allowed.has(name(st))) out.other.push([x, y, z, st.slice(0, 40)]); else out.set(k, y);
      break;
    }
  }
  return out;
}

/** The blocks the IR's relief ops fill with (names, without properties). */
export function reliefBlocks(ir) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string') out.add(s.replace(/\[.*$/, '')); };
  for (const p of ir.parts) for (const o of p.ops) {
    if (o.op !== 'relief') continue;
    if (o.fill && typeof o.fill === 'object') { for (const c of o.fill.rule.rule) add(c.mat); add(o.fill.rule.default); } else add(o.fill);
  }
  return out;
}

/** The pads at their target: every pad and apron column's top block at floorY - 1 with air (or the lot's child) above. */
export function padsCheck(ir, getState, { realised = false } = {}) {
  let cols = 0, off = 0;
  const offList = [];
  // a pad's top is any block but air, a fluid, a plant or a snow layer (a stump the apron kept counts: W keeps a natural apron top)
  const solid = (s) => !/^minecraft:(air|cave_air|void_air|water|lava|snow|short_grass|tall_grass|fern|large_fern)$|leaves|flower|sapling|petals|leaf_litter/.test(s.replace(/\[.*$/, ''));
  for (const l of ir.lots) {
    if (l.pad?.edge !== 'blend') continue;
    const t = l.floorY - 1;
    const b = l.box;
    for (let z = b.minZ - 1; z <= b.maxZ + 1; z++) for (let x = b.minX - 1; x <= b.maxX + 1; x++) {
      cols++;
      const apron = x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ;
      const top = solid(getState(x, t, z));
      // above the pad's top: air on the apron (and on the footprint in the plan); the realised footprint holds the lot's child
      const clear = apron || !realised ? !solid(getState(x, t + 1, z)) : true;
      if (!top || !clear) { off++; if (offList.length < 20) offList.push([l.id, x, t, z]); }
    }
  }
  return { cols, off, offList };
}

/** Axis-run share (6b §8.3's organic read) of the boundary cells written by `parts` (ids) in a virtual world. */
export function axisRunShareOf(ir, vw, parts, minRun = 5) {
  const pIdx = new Set(ir.parts.map((p, i) => (parts.includes(p.id) ? i : -1)).filter((i) => i >= 0));
  const P = vw.pal;
  const open = (x, y, z) => P.air[vw.get(x, y, z)];
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const isB = (x, y, z, s) => (vw.flags(x, y, z) & F_WRITTEN) && P.solid[vw.get(x, y, z)] && pIdx.has(vw.partAt(x, y, z)) && open(x + sides[s][0], y, z + sides[s][1]);
  let boundary = 0, inRun = 0;
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (!pIdx.has(part) || !P.solid[idx]) return;
    let any = false, run = false;
    for (let s = 0; s < 4; s++) {
      if (!open(x + sides[s][0], y, z + sides[s][1])) continue;
      any = true;
      const ax = sides[s][0] === 0 ? [1, 0] : [0, 1];
      let len = 1;
      for (let k = 1; k < minRun && isB(x + ax[0] * k, y, z + ax[1] * k, s); k++) len++;
      for (let k = 1; k < minRun && isB(x - ax[0] * k, y, z - ax[1] * k, s); k++) len++;
      if (len >= minRun) run = true;
    }
    if (any) { boundary++; if (run) inRun++; }
  });
  return { boundaryCells: boundary, inAxisRuns: inRun, share: boundary ? inRun / boundary : 0, minRun };
}

/**
 * Re-plan the run's IR inputs (program, params, seed, claim, survey) with param overrides, in this process: the organic-read
 * comparison (`edge: 'slope'`) and the erosion check (`erode: false`). `{ir, blobs, vw}`.
 */
export async function replan(ir, survey, overrides) {
  const { planRegion } = await import('../../kit/lib/region/plan.mjs');
  const programFile = path.join(root, 'kit', 'regions', `${ir.id}.mjs`);
  const p = await planRegion({ programFile, params: { ...ir.params, ...overrides }, survey, seed: ir.seed, claim: { ...ir.claim, minY: -64, maxY: 319 }, roles: ir.roles });
  const blobs = (sha) => p.blobs.get(sha);
  const { vw } = buildVirtual({ ir: p.ir, survey, blobs });
  return { ir: p.ir, blobs, vw, meta: p.meta };
}

/** Items 1-4 offline over a plan dir (and the realised dump when given). */
export async function reliefMetrics({ planDir, ir, survey, blobs, vw, after = null, before = null }) {
  const cols = reliefColumns(ir, survey, blobs);
  const delta = new Set([...cols].filter(([, c]) => c.mode === 'delta').map(([k]) => k));
  const virtualTops = new Map([...cols].map(([k, c]) => [k, c.top]));
  const sVirtual = smoothness(virtualTops, delta);
  let sRealised = null, clampsRealised = null;
  let other = null;
  if (after) {
    const rt = dumpTops(after, cols, null, reliefBlocks(ir));
    other = rt.other;
    sRealised = smoothness(rt, delta);
    if (before) {
      const bt = dumpTops(before, new Map([...cols].map(([k, c]) => [k, { ...c, top: c.g }])), null);
      let n = 0, within = 0;
      const out = [];
      for (const [k, c] of cols) {
        if (!rt.has(k) || !bt.has(k)) continue;
        n++;
        const d = rt.get(k) - bt.get(k);
        if (d >= -c.maxCut && d <= c.maxFill) within++; else if (out.length < 20) out.push([c.x, c.z, d]);
      }
      clampsRealised = { columns: n, within, share: n ? within / n : 1, out };
    }
  }
  // clamps in the plan: every relief column's raw dh within its clamp (the evaluator clamps anyway; this counts the pass's own)
  let within = 0;
  for (const c of cols.values()) if (c.raw >= -c.maxCut && c.raw <= c.maxFill) within++;
  const pads = padsCheck(ir, (x, y, z) => vw.pal.states[vw.get(x, y, z)]);
  // and on the realised world (a plant left on an apron is a step at the entrance)
  const padsRealised = after ? padsCheck(ir, (x, y, z) => (x < after.box.minX || x > after.box.maxX || z < after.box.minZ || z > after.box.maxZ || y < after.box.minY || y > after.box.maxY ? 'minecraft:air' : after.palette[after.cells[after.at(x, y, z)]]), { realised: true }) : null;
  // erosion: the same plan without the touch-up; the extra |dh| per column and the pins
  const noErode = await replan(ir, survey, { erode: false });
  const c0 = reliefColumns(noErode.ir, survey, noErode.blobs);
  let maxExtra = 0, erodedCols = 0, pinMoved = 0;
  for (const [k, c] of cols) {
    const b = c0.get(k);
    const e = Math.abs(c.top - (b ? b.top : c.g));
    if (e) { erodedCols++; if (e > maxExtra) maxExtra = e; }
    if (c.mode === 'target' && b && b.top !== c.top) pinMoved++;
  }
  const lotIds = new Set(ir.lots.map((l) => l.part));
  const reliefParts = ir.parts.filter((p) => p.ops.some((o) => o.op === 'relief')).map((p) => p.id);
  const organic = axisRunShareOf(ir, vw, [...lotIds, ...reliefParts]);
  const slope = await replan(ir, survey, { edge: 'slope' });
  const organicSlope = axisRunShareOf(slope.ir, slope.vw, [...new Set(slope.ir.lots.map((l) => l.part))]);
  return {
    columns: cols.size, band: delta.size, target: cols.size - delta.size,
    smoothVirtual: sVirtual, smoothRealised: sRealised,
    clamps: { columns: cols.size, within, share: cols.size ? within / cols.size : 1 }, clampsRealised,
    erosion: { maxExtra, erodedCols, pinMoved },
    pads, padsRealised,
    organic, organicSlope,
    otherWriters: other ? { columns: other.length, sample: other.slice(0, 10) } : null,
  };
}

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });

/** The T1 rows (appended to the scenario's rows); `check` = the plan report (item 10). */
export function reliefBars(m, report, rows, { flat = false, metaFlat = null } = {}) {
  // relief_demo is a terrain fixture with no lights or rails: the 6b safety row (M5 dark, M8 guards) is recorded, as F1's forms rows
  const out = rows.map((r) => (r.id === 'safety' ? { ...r, gated: false, pass: null, label: `${r.label} (recorded: a terrain fixture)` } : r));
  // the flat variant must have run on a flat world (MP's lesson: an autoworld base is a normal world)
  if (flat) out.push(row('t1-flatworld', 'T1 flat variant on a flat world', `relief_demo read the survey as ${metaFlat ? 'flat (the hill raised)' : 'NOT flat'}`, 'flat', metaFlat === true));
  const s = (x) => (x ? `${(100 * x.share).toFixed(1)}% of ${x.pairs} steps <= 1, ${x.over3} over 3 (max ${x.max})` : 'n/a');
  const smooth = (x) => !x || (x.share >= 0.95 && x.over3 === 0);
  out.push(row('t1-smooth', 'T1 1 Blend smoothness (virtual; realised)', `${s(m.smoothVirtual)}; ${s(m.smoothRealised)}${m.otherWriters?.columns ? ` (${m.otherWriters.columns} band columns topped by another writer, left out)` : ''}`, '>= 95% of steps <= 1; 0 over 3', smooth(m.smoothVirtual) && smooth(m.smoothRealised)));
  out.push(row('t1-pads', 'T1 2 Pads at their target (virtual; realised)', `${m.pads.off} of ${m.pads.cols} pad and apron columns off${m.padsRealised ? `; realised ${m.padsRealised.off} of ${m.padsRealised.cols}${m.padsRealised.off ? ` (${m.padsRealised.offList.slice(0, 4).map((x) => x.join(' ')).join(', ')})` : ''}` : ''}`, '0 off', m.pads.off === 0 && (!m.padsRealised || m.padsRealised.off === 0)));
  const cr = m.clampsRealised;
  out.push(row('t1-clamps', 'T1 3 Clamps; erosion extra', `plan ${m.clamps.within}/${m.clamps.columns}${cr ? `, realised ${cr.within}/${cr.columns}` : ''} within maxCut/maxFill; erosion extra max ${m.erosion.maxExtra} over ${m.erosion.erodedCols} columns, pins moved ${m.erosion.pinMoved}`,
    '100% within; erosion extra <= 4; no pin moved', m.clamps.within === m.clamps.columns && (!cr || cr.within === cr.columns) && m.erosion.maxExtra <= 4 && m.erosion.pinMoved === 0));
  out.push(row('t1-organic', 'T1 4 Organic read (axis-run share of the relief boundary)', `blend ${m.organic.share.toFixed(3)} of ${m.organic.boundaryCells}; slope ${m.organicSlope.share.toFixed(3)} of ${m.organicSlope.boundaryCells}`,
    'recorded; lower than slope', m.organic.share < m.organicSlope.share, false));
  const m14 = (report?.findings ?? []).filter((f) => /^M[1-4]\b/.test(f.rule));
  out.push(row('t1-checker', 'T1 10 Checker', `${report?.errors ?? '?'} errors; M1-M4 findings ${m14.length}${m14.length ? ` (${m14.slice(0, 4).map((f) => `${f.rule} ${f.part ?? '-'}`).join(', ')})` : ''}`, '0 errors, no M1-M4', report?.errors === 0 && m14.length === 0));
  return out;
}

/** Read a plan dir's inputs. */
export function planInputs(planDir) {
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  return { ir, survey, blobs };
}
