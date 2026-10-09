#!/usr/bin/env node
// FAKE kit/tools/region.mjs for the sidecar tests (the real one is kit/tools/region.mjs, kit/REGIONS.md):
//   plan <program.mjs> --params p.json --survey s.bin --seed n --claim minX,minZ,maxX,maxZ[,minY,maxY] [--bible b.json]
//        [--blobs-out dir] [--volumes dir] --out dir [--json]
//   check <ir.json> --survey s.bin [--blobs dir] [--volumes dir] --out dir --json            (6b)
//   preview <ir.json> --survey s.bin [--blobs dir] [--volumes dir] [--views a,b] [--axes f] --out dir --json   (6b)
//   catalogue [--json]                                                                       (6b)
// plan: the program's default export gets ctx and returns IR fields; this writes <out>/ir.json (canonical JSON) and prints
// {ok, irSha, notes}. (6b) A program's `sideBlobs: {name: {kind, text}}` become side files <blobs-out>/<sha>.bin and a
// format-2 IR (`blobs: {name: {sha, bytes, kind}}`, requires ['blobs:side']); `needVolumes` goes to plan.json; the
// volumes dir's file names are told to the program as ctx.volumes. A throw prints {ok: false, error} and exits 1; bad
// usage (an unknown flag included) exits 2.
// check: report.json from the IR's `fakeCheck` ({findings, slowMs, fail, hog}); preview: tiny files per view.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const KNOWN = { plan: ['params', 'survey', 'seed', 'claim', 'bible', 'roles', 'out', 'json', 'blobs-out', 'volumes'], check: ['survey', 'blobs', 'volumes', 'out', 'json'], preview: ['survey', 'blobs', 'volumes', 'views', 'axes', 'out', 'json'], catalogue: ['json'] };
const [cmd, ...args] = process.argv.slice(2);
const pos = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const n = args[i + 1];
  if (n === undefined || n.startsWith('--')) flags[a.slice(2)] = true;
  else { flags[a.slice(2)] = n; i++; }
}
const usage = (m) => { console.error(`usage: ${m}`); process.exit(2); };
if (!KNOWN[cmd]) usage('region.mjs plan|check|preview|catalogue ...');
for (const k of Object.keys(flags)) if (!KNOWN[cmd].includes(k)) usage(`unknown flag --${k}`);
const fail = (e) => { console.log(JSON.stringify({ ok: false, error: `${e?.message ?? e}` })); process.exit(1); };

if (cmd === 'catalogue') {
  console.log(JSON.stringify({ programs: [
    { id: 'crater_works', description: 'A carved meteor crater with a rubble rim, terraced work levels, a spiral stair and lots on the terraces.', params: { radius: { type: 'int', min: 40, max: 160, default: 80 }, depth: { type: 'int', min: 12, max: 48, default: 24 }, lots: { type: 'int', min: 4, max: 12, default: 8 } }, needs: { minFlat: 0.5, water: 'none', relief: 'low' }, claim: { min: [96, 96], max: [400, 400] } },
    { id: 'rift_city', description: 'A linear carved rift with ledge terraces on both walls, bridges across, a lit side hall and a floor utility corridor.', params: { length: { type: 'int', min: 96, max: 320, default: 160 }, width: { type: 'int', min: 16, max: 48, default: 24 }, depth: { type: 'int', min: 20, max: 60, default: 32 }, bridges: { type: 'int', min: 2, max: 6, default: 3 }, lit: { type: 'bool', default: true }, lining: { type: 'enum', options: ['rock', 'brick'], default: 'rock' } }, needs: { minFlat: 0.3, water: 'none', relief: 'any' }, claim: { min: [64, 96], max: [400, 400] } },
    { id: 'fake_basic', description: 'The fake test program.', params: {}, needs: {}, claim: { min: [16, 16], max: [2048, 2048] } },
  ] }));
  process.exit(0);
}

if (cmd === 'check' || cmd === 'preview') {
  const [irFile] = pos;
  if (!irFile || !flags.out || !flags.survey) usage(`region.mjs ${cmd} <ir.json> --survey s.bin --out dir`);
  try {
    const ir = JSON.parse(fs.readFileSync(irFile, 'utf8'));
    const survey = fs.readFileSync(flags.survey);
    if (survey.toString('latin1', 0, 4) !== 'ARSV') throw new Error('the survey is not an ARSV buffer');
    const fc = ir.fakeCheck ?? {};
    const blobs = flags.blobs ? fs.readdirSync(flags.blobs).filter((f) => f.endsWith('.bin')) : [];
    const volumes = flags.volumes ? fs.readdirSync(flags.volumes).filter((f) => f.endsWith('.bin')) : [];
    for (const b of Object.values(ir.format === 2 ? ir.blobs ?? {} : {})) if (!blobs.includes(`${b.sha}.bin`)) throw new Error(`blob ${b.sha} is not in --blobs`);
    if (cmd === 'check') {
      if (fc.fail) throw new Error(fc.fail);
      if (fc.slowMs) { const end = Date.now() + fc.slowMs; while (Date.now() < end); }
      if (fc.hog) { const hog = []; for (;;) hog.push(new Array(1e6).fill(hog.length)); }
      const findings = fc.findings ?? [{ rule: 'M8', severity: 'warning', part: null, stage: null, count: 3, sample: [[0, 64, 0]], message: 'fake: 3 edge cells unguarded' }];
      const errors = findings.filter((f) => f.severity === 'error').length;
      const report = { format: 1, irSha: sha(fs.readFileSync(irFile)), mode: 'virtual', resolution: { coarse: 1, fullPasses: 0 }, ok: errors === 0, errors, warnings: findings.length - errors, findings, metrics: { blobs: blobs.length, volumes: volumes.length }, prefix: [], ms: { total: 1 } };
      fs.writeFileSync(path.join(flags.out, 'report.json'), JSON.stringify(report));
      fs.writeFileSync(path.join(flags.out, 'summary.txt'), findings.map((f) => `${f.rule} ${f.severity} ${f.message}`).join('\n') + `\n${errors} errors, ${findings.length - errors} warnings\n`);
      console.log(JSON.stringify({ ok: true, report: { ok: report.ok, errors, warnings: report.warnings }, ms: 1 }));
    } else {
      if (fc.previewFail) throw new Error(fc.previewFail);
      if (fc.previewSlowMs) { const end = Date.now() + fc.previewSlowMs; while (Date.now() < end); }
      const views = String(flags.views ?? 'top,section,iso,siteplan').split(',');
      const axes = flags.axes ? JSON.parse(fs.readFileSync(flags.axes, 'utf8')) : [[[0, 64, 0], [10, 64, 10]]];
      const dir = path.join(flags.out, 'previews');
      fs.mkdirSync(dir, { recursive: true });
      const png = (f, label) => { const p = path.join(dir, f); fs.writeFileSync(p, `fake png ${label} ${sha(fs.readFileSync(irFile)).slice(0, 8)}`); return path.resolve(p); };
      const paths = {};
      if (views.includes('top')) paths.top = [png('top.png', 'top')];
      if (views.includes('section')) paths.section = axes.map((_, i) => png(`section-${i + 1}.png`, `section ${i + 1}`));
      if (views.includes('iso')) paths.iso = [png('iso.png', 'iso')];
      let sitePlan;
      if (views.includes('siteplan')) {
        paths.siteplan = [png('siteplan.svg', 'svg'), png('siteplan.png', 'siteplan')];
        sitePlan = path.resolve(path.join(flags.out, 'siteplan.json'));
        fs.writeFileSync(sitePlan, JSON.stringify({ format: 1, irSha: sha(fs.readFileSync(irFile)), claim: ir.claim, stages: ir.stages, lots: [], paths: [], utility: [], anchors: ir.anchors ?? {}, parts: [], graph: { derived: true, nodes: [], edges: [] } }));
      }
      // a path outside the out dir: the sidecar must not hand it on
      if (fc.leakPath) paths.top = [...(paths.top ?? []), fc.leakPath];
      console.log(JSON.stringify({ ok: true, paths, ...(sitePlan ? { sitePlan } : {}), ms: 1 }));
    }
  } catch (e) {
    fail(e);
  }
  process.exit(0);
}

const program = pos[0];
if (!program || !flags.out || !flags.survey || !flags.claim) usage('region.mjs plan <program> --params p.json --survey s.bin --seed n --claim ... --out dir');
try {
  const params = flags.params ? JSON.parse(fs.readFileSync(flags.params, 'utf8')) : {};
  const survey = fs.readFileSync(flags.survey);
  if (survey.toString('latin1', 0, 4) !== 'ARSV') throw new Error('the survey is not an ARSV buffer');
  const c = String(flags.claim).split(',').map(Number);
  const claim = { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: c[4] ?? -64, maxY: c[5] ?? 319 };
  const bible = flags.bible ? JSON.parse(fs.readFileSync(flags.bible, 'utf8')) : { roles: {} };
  const volumes = flags.volumes ? fs.readdirSync(flags.volumes).filter((f) => f.endsWith('.bin')).sort() : [];
  const mod = await import(pathToFileURL(path.resolve(program)).href);
  const ctx = { claim, survey: { bytes: survey.length }, bible, volumes, blobsOut: flags['blobs-out'] ?? null, seed: flags.seed !== undefined ? String(flags.seed) : String(BigInt('0x' + crypto.createHash('sha256').update(path.basename(program) + JSON.stringify(params) + flags.claim).digest('hex').slice(0, 16))), params, kitVersion: 'fake' };
  const got = await mod.default(ctx);
  const { sideBlobs, needVolumes, ...fields } = got;
  let blobs;
  if (sideBlobs) {
    if (!flags['blobs-out']) throw new Error('side blobs need --blobs-out');
    blobs = {};
    for (const [name, b] of Object.entries(sideBlobs)) {
      const bytes = Buffer.from(b.text);
      const s = sha(bytes);
      fs.writeFileSync(path.join(flags['blobs-out'], `${s}.bin`), b.corrupt ? Buffer.from('corrupted') : bytes);
      blobs[name] = { sha: s, bytes: bytes.length, kind: b.kind ?? 'heightfield' };
    }
  }
  const ir = { format: 1, id: path.basename(program, '.mjs'), programSha: sha(fs.readFileSync(program)), kitVersion: 'fake', node: 'any', params, seed: ctx.seed, claim, roles: bible.roles ?? {}, stages: ['ground'], parts: [], lots: [], roads: [], paths: [], anchors: { entrance: [claim.minX, 64, claim.minZ], spawn: [claim.minX, 64, claim.minZ] }, rules: {}, budget: { cells: 100, removed: 50, added: 50 }, tiles: { ground: { terrain: ['0,0'], path: [] } }, ...fields, ...(blobs ? { format: 2, requires: ['blobs:side'], blobs } : {}) };
  const json = canonical(ir);
  fs.writeFileSync(path.join(flags.out, 'ir.json'), json);
  if (needVolumes) fs.writeFileSync(path.join(flags.out, 'plan.json'), JSON.stringify({ ok: true, needVolumes, irFormat: ir.format, requires: ir.requires ?? [] }));
  const irSha = sha(json);
  console.log(JSON.stringify({ ok: true, irSha, notes: [`fake plan of ${ir.id}`, ...(got.notes ?? [])] }));
} catch (e) {
  fail(e);
}
