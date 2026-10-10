// The 6b gallery bundle (docs/CONTRACT.md 6b §8.4): artifacts/scenarios/<phase>/gallery/{index.html, data.json, img/...}.
// index.html is tools/lib/gallery6b.html with the data inlined; the images sit beside it under img/ (published with the
// page as supporting files, or uploaded as assets with their paths rewritten in data.json). Decisions live in the page's
// db (approvals/<phase>__<scenario>, calibration/<phase>__<seed>); `--local` writes a local page whose Submit saves
// approvals.json instead. calibrate(): the calibration card's 10 held-out floatingIsland renders (seeds unrelated to S1's).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..', '..');

function latest(dir, flat) {
  if (!fs.existsSync(dir)) return null;
  const runs = fs.readdirSync(dir).filter((d) => d.endsWith('-flat') === flat && fs.existsSync(path.join(dir, d, 'metrics.json'))).sort();
  return runs.length ? path.join(dir, runs[runs.length - 1]) : null;
}

export async function build({ phase, local, ART, SCEN, evidenceSha }) {
  const out = path.join(ART, phase, 'gallery');
  const img = path.join(out, 'img');
  fs.mkdirSync(img, { recursive: true });
  const scenarios = [];
  for (const f of fs.readdirSync(SCEN).filter((n) => n.endsWith('.json')).sort()) {
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
    if (sc.phase !== phase) continue;
    const short = sc.id.split('_')[0];
    const nat = latest(path.join(ART, phase, short), false);
    if (!nat) continue;
    const flat = latest(path.join(ART, phase, short), true);
    const run = JSON.parse(fs.readFileSync(path.join(nat, 'run.json'), 'utf8'));
    const metrics = JSON.parse(fs.readFileSync(path.join(nat, 'metrics.json'), 'utf8'));
    const exact = JSON.parse(fs.readFileSync(path.join(nat, 'exact.json'), 'utf8'));
    const exactFlat = flat ? JSON.parse(fs.readFileSync(path.join(flat, 'exact.json'), 'utf8')) : null;
    const ev = evidenceSha(nat).sha;
    if (fs.readFileSync(path.join(nat, 'evidence.sha'), 'utf8').trim() !== ev) throw new Error(`${nat}: evidence.sha is stale (recompute with scenarios.mjs metrics)`);
    const dst = path.join(img, short);
    fs.mkdirSync(dst, { recursive: true });
    const cp = (from, name) => { if (!fs.existsSync(from)) return null; fs.copyFileSync(from, path.join(dst, name)); return `img/${short}/${name}`; };
    const cams = Object.keys(sc.cams).map((c) => ({ name: c, before: cp(path.join(nat, 'before', `${c}.png`), `before_${c}.png`), after: cp(path.join(nat, 'shots', `${c}.png`), `after_${c}.png`) }));
    const pv = path.join(nat, 'previews');
    const previews = fs.readdirSync(pv).filter((n) => /\.(png|svg)$/.test(n) && n !== 'siteplan.png').sort().map((n) => ({ name: n.replace(/\.(png|svg)$/, ''), src: cp(path.join(pv, n), `preview_${n}`) }));
    scenarios.push({
      id: sc.id, short, version: sc.version, brief: sc.brief, runId: run.runId, evidenceSha: ev, irSha: run.irSha, date: run.runId.slice(0, 8), versions: run.versions,
      claim: run.claim, worldSeed: run.worldSeed, programSeed: run.programSeed, cellsWritten: run.cellsWritten,
      rows: metrics.rows, summary: fs.existsSync(path.join(nat, 'summary.txt')) ? fs.readFileSync(path.join(nat, 'summary.txt'), 'utf8').trim() : '',
      realisedFindings: metrics.realised?.findings ?? [], cams, previews,
      exact: { normal: { mismatches: exact.mismatches, classes: exact.classes ?? {}, cellsWritten: exact.cellsWritten, sample: exact.sample ?? [] }, flat: exactFlat && { mismatches: exactFlat.mismatches, classes: exactFlat.classes ?? {}, runId: path.basename(flat) } },
    });
  }
  let calibration = [];
  const calFile = path.join(out, 'calibration', 'calibration.json');
  if (fs.existsSync(calFile)) calibration = JSON.parse(fs.readFileSync(calFile, 'utf8')).renders;
  const data = { phase, title: `Architect ${phase} gallery`, built: new Date().toISOString(), local: !!local, scenarios, calibration };
  if (!local) fs.writeFileSync(path.join(out, 'data.json'), `${JSON.stringify(data, null, 1)}\n`);
  const tpl = fs.readFileSync(path.join(HERE, 'gallery6b.html'), 'utf8');
  const html = tpl.replace('/*__GALLERY_DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
  fs.writeFileSync(path.join(out, local ? 'local.html' : 'index.html'), html);
  return { out, scenarios: scenarios.map((s) => ({ id: s.id, runId: s.runId, evidence: s.evidenceSha.slice(0, 12), failing: s.rows.filter((r) => r.gated && r.pass === false && r.id !== 'gallery').map((r) => r.id) })), calibration: calibration.length };
}

/** 10 held-out island seeds (not S1's): a lone floatingIsland each, rendered iso by the kit's preview. */
export async function calibrate({ phase, ART }) {
  const K = (p) => pathToFileURL(path.join(root, 'kit', 'lib', ...p.split('/'))).href;
  const { planRegion } = await import(K('region/plan.mjs'));
  const { region } = await import(K('region/program.mjs'));
  const { synthSurvey } = await import(K('region/synth.mjs'));
  const { renderPreviews } = await import(K('region/preview.mjs'));
  const out = path.join(ART, phase, 'gallery', 'calibration');
  fs.mkdirSync(out, { recursive: true });
  const claim = { minX: -48, minZ: -48, maxX: 47, maxZ: 47, minY: -64, maxY: 319 };
  const survey = synthSurvey(claim, 'calibration');
  const renders = [];
  for (let i = 0; i < 10; i++) {
    const seed = String(9_000_000_001n + BigInt(i) * 7_919n);
    const r = (i % 3) === 0 ? [30, 26] : (i % 3) === 1 ? [22, 22] : [36, 20];
    const prog = { id: 'calibration', default: (ctx) => { const g = region(ctx); g.stages(['ground']); g.floatingIsland('isle', { at: [0, 170, 0], r, thickness: 12 + (i % 4) * 3, underside: { taper: 0.75, roots: i % 2 ? 4 : 0 } }, { stage: 'ground' }); g.anchor('entrance', [0, 40]); g.anchor('spawn', [3, 40]); return g; } };
    const p = await planRegion({ program: prog, programSource: `calibration_${i}`, survey, claim, seed, node: 'golden' });
    const dir = path.join(out, `seed_${seed}`);
    renderPreviews({ ir: p.ir, survey, blobs: p.blobs, meta: p.meta, outDir: dir, irSha: p.irSha, views: ['iso'] });
    fs.copyFileSync(path.join(dir, 'previews', 'iso.png'), path.join(out, `island_${seed}.png`));
    fs.rmSync(dir, { recursive: true, force: true });
    renders.push({ seed, r, src: `calibration/island_${seed}.png` });
  }
  fs.writeFileSync(path.join(out, 'calibration.json'), `${JSON.stringify({ note: 'held-out floatingIsland seeds for the axis-run calibration (CONTRACT 6b §8.3); not S1\'s seed', renders }, null, 1)}\n`);
  return { renders: renders.length, out };
}
