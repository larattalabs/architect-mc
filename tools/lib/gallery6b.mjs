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

/** One scenario section of the gallery from its natural run `nat` (and flat run `flat`), its images under img/<key>/. */
function section({ sc, nat, flat, key, img, evidenceSha, extra = {} }) {
  const run = JSON.parse(fs.readFileSync(path.join(nat, 'run.json'), 'utf8'));
  const metrics = JSON.parse(fs.readFileSync(path.join(nat, 'metrics.json'), 'utf8'));
  const exact = JSON.parse(fs.readFileSync(path.join(nat, 'exact.json'), 'utf8'));
  const exactFlat = flat ? JSON.parse(fs.readFileSync(path.join(flat, 'exact.json'), 'utf8')) : null;
  const ev = evidenceSha(nat).sha;
  if (fs.readFileSync(path.join(nat, 'evidence.sha'), 'utf8').trim() !== ev) throw new Error(`${nat}: evidence.sha is stale (recompute with scenarios.mjs metrics)`);
  const dst = path.join(img, key);
  fs.mkdirSync(dst, { recursive: true });
  const cp = (from, name) => { if (!fs.existsSync(from)) return null; fs.copyFileSync(from, path.join(dst, name)); return `img/${key}/${name}`; };
  // (6c W) plus any camera the run added (cam_lamp: the apron lamp close-up)
  const extraCams = fs.existsSync(path.join(nat, 'shots')) ? fs.readdirSync(path.join(nat, 'shots')).filter((n) => n.endsWith('.png')).map((n) => n.slice(0, -4)).filter((n) => !(n in sc.cams)).sort() : [];
  const cams = [...Object.keys(sc.cams), ...extraCams].map((c) => ({ name: c, before: cp(path.join(nat, 'before', `${c}.png`), `before_${c}.png`), after: cp(path.join(nat, 'shots', `${c}.png`), `after_${c}.png`) }));
  const pv = path.join(nat, 'previews');
  const previews = fs.readdirSync(pv).filter((n) => /\.(png|svg)$/.test(n) && n !== 'siteplan.png').sort().map((n) => ({ name: n.replace(/\.(png|svg)$/, ''), src: cp(path.join(pv, n), `preview_${n}`) }));
  return {
    id: sc.id, short: key, version: sc.version, brief: sc.brief, runId: run.runId, evidenceSha: ev, irSha: run.irSha, date: run.runId.slice(0, 8), versions: run.versions,
    claim: run.claim, worldSeed: run.worldSeed, programSeed: run.programSeed, cellsWritten: run.cellsWritten, bible: run.bible ?? null, lamps: metrics.village?.lamps ?? null,
    rows: metrics.rows, summary: fs.existsSync(path.join(nat, 'summary.txt')) ? fs.readFileSync(path.join(nat, 'summary.txt'), 'utf8').trim() : '',
    realisedFindings: metrics.realised?.findings ?? [], cams, previews,
    exact: { normal: { mismatches: exact.mismatches, classes: exact.classes ?? {}, cellsWritten: exact.cellsWritten, sample: exact.sample ?? [] }, flat: exactFlat && { mismatches: exactFlat.mismatches, classes: exactFlat.classes ?? {}, runId: path.basename(flat) } },
    ...extra,
  };
}

export async function build({ phase, local, ART, SCEN, evidenceSha }) {
  const out = path.join(ART, phase, 'gallery');
  const img = path.join(out, 'img');
  fs.mkdirSync(img, { recursive: true });
  const scenarios = [];
  if (phase === '6c') {
    // (6c S2) the 6c gallery: S2 (bar 16: Noah's approval of its evidence sha), then the page's earlier sections as published (W's S7
    // and its looks, V's S7), their images already on the page (jpg) and their decisions keyed to their own phases
    // (6c S3) S3 v1 first (bar 16: Noah's approval of its evidence sha); S2 after it, approved (2026-10-14, 932dafe971f1: PLAN.md)
    const sc3 = JSON.parse(fs.readFileSync(path.join(SCEN, 's3_monastery.json'), 'utf8'));
    const dir3 = path.join(ART, '6c', 's3');
    const nat3 = latest(dir3, false);
    if (nat3) scenarios.push(section({ sc: sc3, nat: nat3, flat: latest(dir3, true), key: 's3', img, evidenceSha, extra: { phase: '6c', section: 'S3 v1', note: 'S3 v1, terraced (N-S3-1): the monastery laid down its mountainside in three districts at the claim\'s level bands (the gate low, the gardens mid in the cherry grove, the cloister high), every lot on its own terrace level 3 apart, rims over 2 held by stone-brick retaining rings with spruce rails, the levels joined by stone paths with switchbacks and stair flights (grade 0.2), the gardens\' fountain (a copper coping, a sea-lantern spout), a rock spire on a shoulder, a player-only path to the lookout on the highest ground, the relief blended round the districts, boulders, stumps, moss and snow, and soul lanterns (light 10). The spring stream (x 3664-3672) is untouched.' } }));
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN, 's2_ice_spikes.json'), 'utf8'));
    const dir = path.join(ART, '6c', 's2');
    const nat = latest(dir, false);
    if (nat) scenarios.push(section({ sc, nat, flat: latest(dir, true), key: 's2', img, evidenceSha, extra: { phase: '6c', ...(nat3 ? { earlier: true, approved: { by: 'Noah', at: '2026-10-14', evidence: '932dafe971f1' } } : {}), note: 'The outpost stands on the land only (N-S2-1): 7 lots on the ice-free band between the natural spikes (a longhouse, the watch tower, a smithy, a store, the farm Steward asked for, and 2 huts; a third hut has no site), each pad blended into the snow, 1-wide plank boardwalks from the gate to every door, 6 generated spike clusters in the gaps, boulders, spruce stumps and snow layers, and soul lanterns (light 10: no ice or snow melts). The frozen sea and every natural spike are untouched.' } }));
    const wData = path.join(ART, '6c-w', 'gallery', 'data.json');
    if (fs.existsSync(wData)) {
      const jpg = (src) => (src && /\.png$/.test(src) ? src.replace(/\.png$/, '.jpg') : src);
      for (const v of JSON.parse(fs.readFileSync(wData, 'utf8')).scenarios) {
        scenarios.push({ ...v, earlier: v.earlier ?? false, cams: v.cams.map((c) => ({ ...c, before: jpg(c.before), after: jpg(c.after) })), previews: v.previews.map((q) => ({ ...q, src: jpg(q.src) })) });
      }
    }
  } else if (phase === '6c-w') {
    // (6c W) S7 with W (Noah's decision), its looks in two more bibles (recorded), then V's approved section as it was
    const sc = JSON.parse(fs.readFileSync(path.join(SCEN, 's7_flat_village.json'), 'utf8'));
    const base = path.join(ART, '6c-w');
    const nat = latest(path.join(base, 's7'), false);
    if (nat) scenarios.push(section({ sc, nat, flat: latest(path.join(base, 's7'), true), key: 's7w', img, evidenceSha, extra: { phase: '6c-w', look: 'rustic' } }));
    for (const [b, look] of [['g6cw_infernal', 'infernal'], ['g6cw_coastal', 'coastal']]) {
      const n = latest(path.join(base, `s7-${b}`), false);
      if (n) scenarios.push(section({ sc, nat: n, flat: null, key: `s7_${look}`, img, evidenceSha, extra: { phase: '6c-w', look, lookOnly: true } }));
    }
    const vData = path.join(ART, '6c-v', 'gallery', 'data.json');
    if (fs.existsSync(vData)) {
      for (const v of JSON.parse(fs.readFileSync(vData, 'utf8')).scenarios) {
        const vk = `${v.short}v`;
        const vImg = path.join(img, vk);
        fs.mkdirSync(vImg, { recursive: true });
        const re = (src) => { if (!src) return src; const f = path.join(ART, '6c-v', 'gallery', src); const name = path.basename(src); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(vImg, name)); return `img/${vk}/${name}`; };
        scenarios.push({ ...v, short: vk, phase: '6c-v', earlier: true, cams: v.cams.map((c) => ({ ...c, before: re(c.before), after: re(c.after) })), previews: v.previews.map((q) => ({ ...q, src: re(q.src) })) });
      }
    }
  } else {
    for (const f of fs.readdirSync(SCEN).filter((n) => n.endsWith('.json')).sort()) {
      const sc = JSON.parse(fs.readFileSync(path.join(SCEN, f), 'utf8'));
      if (sc.phase !== phase) continue;
      const short = sc.id.split('_')[0];
      const nat = latest(path.join(ART, phase, short), false);
      if (!nat) continue;
      scenarios.push(section({ sc, nat, flat: latest(path.join(ART, phase, short), true), key: short, img, evidenceSha }));
    }
  }
  let calibration = [];
  const calFile = path.join(out, 'calibration', 'calibration.json');
  if (fs.existsSync(calFile)) calibration = JSON.parse(fs.readFileSync(calFile, 'utf8')).renders;
  // (6c V, W) the slice's own page title and bar reference; W republishes V's page (the same title, a new section)
  const title = phase === '6c-v' || phase === '6c-w' || phase === '6c' ? 'Architect 6c-V gallery' : `Architect ${phase} gallery`; // (6c S2: 'Architect 6c gallery', the same page)
  const barsTitle = phase === '6c' ? 'Bars (CONTRACT 6c slice S3 §7 and S2 §3; earlier sections: V §7 and W §7), on the realised world' : phase === '6c-w' ? 'Bars (CONTRACT 6c slice V §7 and W §7), on the realised world' : phase === '6c-v' ? 'Bars (CONTRACT 6c slice V §7), on the realised world' : 'Bars (CONTRACT 6b §8.3), on the realised world';
  const data = { phase, title, barsTitle, built: new Date().toISOString(), local: !!local, scenarios, calibration };
  if (!local) fs.writeFileSync(path.join(out, 'data.json'), `${JSON.stringify(data, null, 1)}\n`);
  const tpl = fs.readFileSync(path.join(HERE, 'gallery6b.html'), 'utf8');
  const html = tpl.replace('<title>Architect 6b Gallery</title>', `<title>${title}</title>`).replace('/*__GALLERY_DATA__*/null', JSON.stringify(data).replace(/</g, '\\u003c'));
  fs.writeFileSync(path.join(out, local ? 'local.html' : 'index.html'), html);
  return { out, scenarios: scenarios.map((s) => ({ id: s.id, key: s.short, runId: s.runId, evidence: s.evidenceSha.slice(0, 12), failing: s.rows.filter((r) => r.gated && r.pass === false && r.id !== 'gallery').map((r) => r.id) })), calibration: calibration.length };
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
