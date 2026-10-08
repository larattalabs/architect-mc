#!/usr/bin/env node
// Region engine bench (phase 6a report numbers, no game): plan mega_bench over a synthetic survey, then evaluate every
// tile of every change-set single-threaded against full-resolution synthetic heights.
//   node kit/tools/region-bench.mjs [--seed s] [--scale full|light] [--json]
// Prints plan ms, cells (plan budget and full-resolution), tiles per stage/set, evalTile p50/p99 ms, cells/s, and gzip
// bytes per cell.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile } from '../lib/realise.mjs';
import { gzipPinned } from '../lib/region/pack.mjs';
import { synthSurvey, synthTileWindow } from '../lib/region/synth.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const seed = opt('seed', 'bench'), scale = opt('scale', 'full');
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claim = { minX: -500, minZ: -500, maxX: 499, maxZ: 499, minY: -64, maxY: 319 };

const survey = synthSurvey(claim, seed);
const t0 = performance.now();
const p = await planRegion({ programFile: path.join(KIT, 'regions', 'mega_bench.mjs'), survey, claim, params: { scale } });
const planMs = performance.now() - t0;
const jobs = [];
for (const stage of p.ir.stages) for (const set of ['terrain', 'path']) for (const key of p.ir.tiles[stage][set]) jobs.push({ key, stage, set });
const windows = new Map(jobs.map((j) => [j.key, null]));
for (const k of windows.keys()) windows.set(k, synthTileWindow(k, seed));
const times = [];
let cells = 0, raw = 0, gz = 0, evalMs = 0;
for (const j of jobs) {
  const t = performance.now();
  const r = evalTile(p.ir, j.key, windows.get(j.key), { stage: j.stage, set: j.set });
  const ms = performance.now() - t;
  times.push(ms); evalMs += ms;
  cells += r.count; raw += r.payload.length; gz += gzipPinned(r.payload).length;
}
times.sort((a, b) => a - b);
const q = (f) => times[Math.min(times.length - 1, Math.floor(times.length * f))];
const out = {
  node: process.version, scale, planMs: Math.round(planMs), planStats: p.stats.ms, irBytes: p.stats.irBytes, ops: p.stats.ops, lots: p.ir.lots.length,
  budget: p.ir.budget, cellsFullRes: cells, tiles: p.stats.tiles, tileEvals: jobs.length,
  evalMs: Math.round(evalMs), p50: +q(0.5).toFixed(2), p99: +q(0.99).toFixed(2), max: +times[times.length - 1].toFixed(2),
  cellsPerSecond: Math.round(cells / (evalMs / 1000)), bytesPerCellRaw: +(raw / cells).toFixed(3), bytesPerCellGzip: +(gz / cells).toFixed(3),
};
if (args.includes('--json')) console.log(JSON.stringify(out));
else for (const [k, v] of Object.entries(out)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
