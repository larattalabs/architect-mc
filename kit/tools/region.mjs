#!/usr/bin/env node
// Region programs CLI (docs/CONTRACT.md §6 "Kit CLI", kit/REGIONS.md "Plan CLI"):
//   node kit/tools/region.mjs plan <program.mjs> --params p.json --survey s.bin [--seed u64] --claim minX,minZ,maxX,maxZ[,minY,maxY]
//        [--bible b.json] [--roles r.json] [--out dir] [--json]
//   node kit/tools/region.mjs eval <ir.json> --tile tx,tz --heights h.bin [--stage s] [--set terrain|path] [--json] [--out file]
//   node kit/tools/region.mjs synth --box minX,minZ,maxX,maxZ [--res 1|4] [--seed s] --out file      (a synthetic ARSV, for tests)
// Exit 0 ok, 1 failure, 2 usage. With --json the last stdout line is one JSON object. `plan` writes only into --out.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { evalTile } from '../lib/realise.mjs';
import { encodeColumns, gzipPinned } from '../lib/region/pack.mjs';
import { decodeArvx } from '../lib/region/volume.mjs';
import { checkRegion, summaryText } from '../lib/region/check.mjs';
import { renderPreviews, VIEWS } from '../lib/region/preview.mjs';
import { synthColumns } from '../lib/region/synth.mjs';

class Usage extends Error {}

function parseArgs(argv, spec) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!(k in spec)) throw new Usage(`unknown option --${k}`);
      if (spec[k] === 'flag') opts[k] = true;
      else { if (i + 1 >= argv.length) throw new Usage(`--${k} needs a value`); opts[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, opts };
}

const readJson = (f, what) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Usage(`${what}: cannot read ${f} (${e.message})`); }
};

async function plan(argv) {
  const { pos, opts } = parseArgs(argv, { params: 1, survey: 1, seed: 1, claim: 1, bible: 1, roles: 1, out: 1, json: 'flag', 'blobs-out': 1, volumes: 1 });
  if (pos.length !== 1) throw new Usage('plan <program.mjs> --survey s.bin --claim minX,minZ,maxX,maxZ[,minY,maxY] [...]');
  if (!opts.survey || !opts.claim) throw new Usage('plan needs --survey and --claim');
  const params = opts.params ? readJson(opts.params, '--params') : {};
  let survey;
  try { survey = fs.readFileSync(opts.survey); } catch (e) { throw new Usage(`--survey: ${e.message}`); }
  let roles = {};
  if (opts.bible) {
    const b = readJson(opts.bible, '--bible');
    if (!b || typeof b.roles !== 'object') throw new Usage('--bible must be {id?, version?, roles: {role: blockState}}');
    roles = { ...b.roles };
  }
  if (opts.roles) roles = { ...roles, ...readJson(opts.roles, '--roles') };
  if (opts.seed !== undefined && !/^\d{1,20}$/.test(opts.seed)) throw new Usage('--seed must be a u64 decimal');
  // (6b) frozen volumes the program may read: <dir>/<sha>.bin (ARVX, gzip)
  const volumes = [];
  if (opts.volumes) {
    let names;
    try { names = fs.readdirSync(opts.volumes).filter((f) => /^[0-9a-f]{64}\.bin$/.test(f)).sort(); } catch (e) { throw new Usage(`--volumes: ${e.message}`); }
    for (const f of names) {
      const bytes = fs.readFileSync(path.join(opts.volumes, f));
      const decoded = decodeArvx(bytes);
      if (decoded.sha !== f.slice(0, 64)) throw new Error(`volume ${f}: its ARVX bytes hash to ${decoded.sha}`);
      volumes.push({ sha: decoded.sha, box: decoded.box, bytes: Uint8Array.from(bytes), decoded });
    }
  }
  const res = await planRegion({ programFile: pos[0], params, survey, seed: opts.seed ?? null, claim: opts.claim, roles, volumes });
  if (opts['blobs-out'] && res.blobs.size) {
    fs.mkdirSync(opts['blobs-out'], { recursive: true });
    for (const [sha, bytes] of res.blobs) fs.writeFileSync(path.join(opts['blobs-out'], `${sha}.bin`), bytes);
  }
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'ir.json'), res.irJson);
    fs.writeFileSync(path.join(opts.out, 'meta.json'), `${JSON.stringify(res.meta)}\n`);
    const ir = res.ir;
    const planJson = { ok: true, irSha: res.irSha, id: ir.id, seed: ir.seed, claim: ir.claim, stages: ir.stages, lots: ir.lots.length, roads: ir.roads.length, paths: ir.paths.length, anchors: ir.anchors, budget: ir.budget, notes: res.notes, stats: res.stats,
      irFormat: ir.format, requires: ir.requires ?? [], needVolumes: res.needVolumes, blobs: Object.entries(ir.blobs ?? {}).filter(([, b]) => b.sha).map(([name, b]) => ({ name, ...b })) };
    fs.writeFileSync(path.join(opts.out, 'plan.json'), `${JSON.stringify(planJson, null, 2)}\n`);
  }
  const ir = res.ir;
  const summary = { ok: true, irSha: res.irSha, irFormat: ir.format, requires: ir.requires ?? [], needVolumes: res.needVolumes, stages: ir.stages, lots: ir.lots.length, anchors: ir.anchors, budget: ir.budget, tiles: res.stats.tiles, notes: res.notes, ms: res.stats.ms };
  if (opts.json) console.log(JSON.stringify(summary));
  else {
    console.log(`plan ${ir.id}: irSha ${res.irSha}`);
    console.log(`  stages ${ir.stages.join(', ')}; ${ir.lots.length} lots, ${ir.roads.length} roads, ${ir.paths.length} paths, ${res.stats.ops} ops, IR ${res.stats.irBytes} bytes`);
    console.log(`  budget ${ir.budget.cells} cells (${ir.budget.removed} removed, ${ir.budget.added} added); ${res.stats.tileEvals} tile evaluations; ${res.stats.ms.total} ms`);
    for (const n of res.notes) console.log(`  note: ${n}`);
  }
  return 0;
}

function evalCmd(argv) {
  const { pos, opts } = parseArgs(argv, { tile: 1, heights: 1, stage: 1, set: 1, json: 'flag', out: 1, blobs: 1 });
  if (pos.length !== 1 || !opts.tile || !opts.heights) throw new Usage('eval <ir.json> --tile tx,tz --heights h.bin [--stage s] [--set terrain|path] [--json] [--out file]');
  if (!/^-?\d+,-?\d+$/.test(opts.tile)) throw new Usage('--tile must be tx,tz');
  if (opts.set && opts.set !== 'terrain' && opts.set !== 'path') throw new Usage('--set must be terrain or path');
  let irText, heights;
  try { irText = fs.readFileSync(pos[0], 'utf8'); } catch (e) { throw new Usage(`ir: ${e.message}`); }
  try { heights = fs.readFileSync(opts.heights); } catch (e) { throw new Usage(`--heights: ${e.message}`); }
  const ir = JSON.parse(irText);
  const t = performance.now();
  const blobs = opts.blobs ? (sha) => { const f = path.join(opts.blobs, `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; } : undefined;
  const r = evalTile(ir, opts.tile, heights, { stage: opts.stage ?? null, set: opts.set ?? null, blobs });
  const ms = performance.now() - t;
  const gz = gzipPinned(r.payload);
  if (opts.out) fs.writeFileSync(opts.out, r.payload);
  const out = { ok: true, key: opts.tile, count: r.count, sha: r.sha, bytes: r.payload.length, gzipBytes: gz.length, removed: r.removed, added: r.added, notes: r.notes, ms: Math.round(ms * 10) / 10 };
  if (opts.json) console.log(JSON.stringify(out));
  else console.log(`tile ${opts.tile}: ${r.count} cells, sha ${r.sha}, ${r.payload.length} bytes (${gz.length} gzip), ${out.ms} ms`);
  return 0;
}

/** (6b) The inputs of check / preview: the IR, survey, side blobs, frozen volumes and the plan meta (beside the IR). */
function loadPlan(pos, opts) {
  let irText, survey;
  try { irText = fs.readFileSync(pos[0], 'utf8'); } catch (e) { throw new Usage(`ir: ${e.message}`); }
  try { survey = fs.readFileSync(opts.survey); } catch (e) { throw new Usage(`--survey: ${e.message}`); }
  const ir = JSON.parse(irText);
  const dir = path.dirname(pos[0]);
  const blobDir = opts.blobs ?? path.join(dir, 'blobs');
  const blobs = (sha) => { const f = path.join(blobDir, `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const volumes = [];
  if (opts.volumes) for (const f of fs.readdirSync(opts.volumes).filter((n) => /^[0-9a-f]{64}\.bin$/.test(n)).sort()) volumes.push(decodeArvx(fs.readFileSync(path.join(opts.volumes, f))));
  let meta = null;
  const mf = opts.meta ?? path.join(dir, 'meta.json');
  if (fs.existsSync(mf)) meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
  return { ir, irText, survey, blobs, volumes, meta, dir };
}

function check(argv) {
  const { pos, opts } = parseArgs(argv, { survey: 1, blobs: 1, volumes: 1, meta: 1, out: 1, json: 'flag', 'no-prefix': 'flag', 'plan-id': 1 });
  if (pos.length !== 1 || !opts.survey) throw new Usage('check <ir.json> --survey s.bin [--blobs dir] [--volumes dir] [--meta meta.json] [--out dir] [--json]');
  const L = loadPlan(pos, opts);
  const report = checkRegion({ ir: L.ir, survey: L.survey, blobs: L.blobs, volumes: L.volumes, meta: L.meta, prefix: !opts['no-prefix'], planId: opts['plan-id'] });
  delete report._world;
  report.irSha = createHash('sha256').update(L.irText).digest('hex');
  const out = opts.out ?? L.dir;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'summary.txt'), summaryText(report));
  const res = { ok: true, report: { ok: report.ok, errors: report.errors, warnings: report.warnings }, ms: report.ms.total };
  if (opts.json) console.log(JSON.stringify(res));
  else process.stdout.write(summaryText(report));
  return 0;
}

function preview(argv) {
  const { pos, opts } = parseArgs(argv, { survey: 1, blobs: 1, volumes: 1, meta: 1, out: 1, json: 'flag', views: 1, axes: 1, 'plan-id': 1 });
  if (pos.length !== 1 || !opts.survey) throw new Usage('preview <ir.json> --survey s.bin [--views top,section,iso,siteplan] [--axes axes.json] [--out dir] [--json]');
  const L = loadPlan(pos, opts);
  const views = opts.views ? opts.views.split(',') : VIEWS;
  for (const v of views) if (!VIEWS.includes(v)) throw new Usage(`--views: unknown view ${v} (${VIEWS.join(', ')})`);
  const axes = opts.axes ? readJson(opts.axes, '--axes') : null;
  const irSha = createHash('sha256').update(L.irText).digest('hex');
  const r = renderPreviews({ ir: L.ir, survey: L.survey, blobs: L.blobs, volumes: L.volumes, meta: L.meta, views, axes, outDir: path.resolve(opts.out ?? L.dir), planId: opts['plan-id'] ?? null, irSha });
  const res = { ok: true, paths: r.paths, sitePlan: r.sitePlanFile, pixels: r.pixels, ms: r.ms };
  if (opts.json) console.log(JSON.stringify(res));
  else for (const [v, l] of Object.entries(r.paths)) console.log(`${v}: ${l.join(', ')}`);
  return 0;
}

async function catalogue(argv) {
  const { opts } = parseArgs(argv, { json: 'flag' });
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'regions');
  const programs = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    if (!m.catalogue || typeof m.catalogue !== 'object') continue;
    const params = {};
    for (const [k, v] of Object.entries(m.params ?? {})) params[k] = { type: v.type, ...(v.min !== undefined ? { min: v.min } : {}), ...(v.max !== undefined ? { max: v.max } : {}), ...(v.default !== undefined ? { default: v.default } : {}), ...(v.values ? { values: v.values } : {}) };
    programs.push({ id: m.id, description: m.catalogue.description, params, needs: m.catalogue.needs, claim: m.catalogue.claim });
  }
  const out = { programs };
  if (opts.json) console.log(JSON.stringify(out));
  else for (const p of programs) console.log(`${p.id}: ${p.description}`);
  return 0;
}

function synth(argv) {
  const { opts } = parseArgs(argv, { box: 1, res: 1, seed: 1, out: 1 });
  if (!opts.box || !opts.out) throw new Usage('synth --box minX,minZ,maxX,maxZ [--res 1|4] [--seed s] --out file');
  const [x0, z0, x1, z1] = opts.box.split(',').map(Number);
  if (![x0, z0, x1, z1].every(Number.isInteger) || x1 < x0 || z1 < z0) throw new Usage('--box must be minX,minZ,maxX,maxZ integers');
  const res = Number(opts.res ?? ((x1 - x0 + 1) <= 256 && (z1 - z0 + 1) <= 256 ? 1 : 4));
  if (res !== 1 && res !== 4) throw new Usage('--res must be 1 or 4');
  const c = synthColumns({ minX: x0, minZ: z0, width: Math.ceil((x1 - x0 + 1) / res), depth: Math.ceil((z1 - z0 + 1) / res), resolution: res, seed: opts.seed ?? 'synth' });
  fs.writeFileSync(opts.out, encodeColumns(c));
  console.log(JSON.stringify({ ok: true, out: opts.out, width: c.width, depth: c.depth, resolution: res }));
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  try {
    if (cmd === 'plan') return await plan(rest);
    if (cmd === 'eval') return evalCmd(rest);
    if (cmd === 'synth') return synth(rest);
    if (cmd === 'check') return check(rest);
    if (cmd === 'preview') return preview(rest);
    if (cmd === 'catalogue') return await catalogue(rest);
    throw new Usage('usage: region.mjs plan|eval|synth ... (see kit/REGIONS.md "CLI")');
  } catch (e) {
    const usage = e instanceof Usage;
    const msg = e?.message ?? String(e);
    if (json) console.log(JSON.stringify({ ok: false, error: usage ? `usage: ${msg}` : msg }));
    else console.error(`${usage ? 'usage' : 'error'}: ${msg}`);
    return usage ? 2 : 1;
  }
}

process.exitCode = await main();
