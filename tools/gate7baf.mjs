#!/usr/bin/env node
// Phase 7b slice AF gate (affordances and Survey.site; docs/CONTRACT.md "Phase 7b" §3 row 4) against the headless server of the AF run
// worktree (GATE6B_RUN, default `../architect-mc-AF-run`; the sim sidecar, no Claude). $0: no Claude call anywhere. Ports 8896/8897.
//
//   node tools/gate7baf.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (af-unit)              offline: kit/test/af-affordances.test.mjs (the detectors over the six site fixtures, stable ids, the
//                                      frames, the goldens, r.affordances in a plan and through the plan CLI, the S4-S6 windows) and the
//                                      foundation's
//     site      (af-site)              Survey.site in game (dev.af.site, the public API): (a) the cliff, overhang and trunk fixtures built
//                                      cell for cell by commands at their own coordinates in a flat world: the frozen volume's sha is the
//                                      fixture's, the affordances are the kit's golden (kit/test/fixtures/af/<id>.json) and the proposed
//                                      frame is the fixture's own; (b) the real cliff (scenarios/sites/cliff_face.json's run, a fresh copy
//                                      of the pinned seed world): a cliff face found at the lot, a frame proposed, the mod's answer equal to
//                                      the kit's CLI over the same frozen file, a second call the same sha and ids
//     nowrite   (af-nowrite)           Survey.site writes nothing (as lc-nowrite): on the real cliff, three rounds of two calls (one another
//                                      fit) between two hashes of the volume box and two listings of the journal and the volumes dir: the
//                                      hash unchanged, the journal unchanged, no new volume file, the answers equal; the land's own drift
//                                      measured first (two hashes with no call)
//     cut                              (by hand, recorded) S4-S6's windows: Survey.volume of a 64x64 window at each scenario claim's
//                                      centre over its y range, on the pinned seed; copied to <out>/cut/<id>.bin with a manifest and the
//                                      kit's kinds; commit them as kit/test/fixtures/af/<id>.bin (af-unit's S4-S6 units)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-af/<step>.json in the main checkout (GATE7BAF_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-AF-run');
process.env.GATE6B_OUT = process.env.GATE7BAF_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-af');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const FIX = path.join(KIT, 'test', 'fixtures', 'site');
const GOLD = path.join(KIT, 'test', 'fixtures', 'af');
const SITE_FILE = path.join(root, 'scenarios', 'sites', 'cliff_face.json');

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice AF is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B AF Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 1_800_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
steps.unit = async () => {
  const out = {};
  out.af = nodeTest(['kit/test/af-affordances.test.mjs']);
  check(out.af.code === 0 && out.af.fail === 0 && out.af.pass >= 13, `the analysis (kit/test/af-affordances.test.mjs): the six fixtures' kinds and frames, ledge, cave and spike with a negative each, stable ids, the turned frames, the goldens, r.affordances in a plan and through the plan CLI, the S4-S6 windows cut from the pinned seed: ${out.af.pass} pass, ${out.af.fail} fail`, out.af.failing);
  out.found = nodeTest(['kit/test/f7b-foundation.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `the foundation's (fixtures byte for byte, the kinds against Affordance.java): ${out.found.pass} pass`, out.found.failing);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ helpers

/** Every file under a dir: relative path -> size and sha256 (missing dir: empty). */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const b = fs.readFileSync(p); out[path.relative(dir, p)] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}`; }
    }
  };
  walk(dir);
  return out;
}
function listDiff(a, b) {
  const d = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(`${k}: ${a[k] ?? '-'} -> ${b[k] ?? '-'}`);
  return d;
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b.minX, b.minY, b.minZ], max: [b.maxX, b.maxY, b.maxZ] }, 300_000)).sha256;
const lot6 = (l) => [l.minX, l.minY, l.minZ, l.maxX, l.maxY, l.maxZ];
const strip = (a) => a && { sha: a.sha, box: a.box, affordances: a.affordances, proposed: a.proposed };
/** The kit's CLI over a frozen volume file: {ok, sha, box, affordances, proposed}. */
function kitCli(file, lot, fit) {
  const r = spawnSync(process.execPath, [path.join(KIT, 'tools', 'affordances.mjs'), file, '--lot', lot6(lot).join(','), '--fit', fit], { encoding: 'utf8', timeout: 300_000 });
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
/** The proposal as SiteFrame.wire writes it ({origin, rotation}). */
const frameOf = (p) => (p ? p.frame ?? p : null);
async function site(lot, fit, load = 'bounded:64') {
  const r = await call('dev.af.site', { lot: lot6(lot), fit, load }, 600_000);
  if (r.refused) throw new Error(`Survey.site refused: ${r.refused}`);
  return r;
}

/** Builds a fixture volume's terrain by /fill (columns with the same runs along x merged): ROCK stone, SOIL dirt, LOG oak_log, LEAVES oak_leaves. */
async function buildFixture(v) {
  const { VOXEL_CLASSES } = await imp('lib/region/volume.mjs');
  const BLOCK = { ROCK: 'stone', SOIL: 'dirt', LOG: 'oak_log', LEAVES: 'oak_leaves[persistent=true]' };
  const b = v.box, W = v.width, H = v.height, D = v.depth;
  const runsOf = (i, k) => {
    const out = [];
    for (let j = 0; j < H;) {
      const c = v.classes[(i * D + k) * H + j];
      let e = j;
      while (e + 1 < H && v.classes[(i * D + k) * H + e + 1] === c) e++;
      const name = VOXEL_CLASSES[c];
      if (name !== 'AIR') {
        if (!BLOCK[name]) throw new Error(`the fixture has ${name} cells (this builder writes ${Object.keys(BLOCK).join(', ')})`);
        out.push([j, e, BLOCK[name]]);
      }
      j = e + 1;
    }
    return out;
  };
  let fills = 0;
  // clear the box first (the flat world is air up there; a re-run's leftovers too)
  for (let y = b.minY; y <= b.maxY; y += 16) { await cmd(`/fill ${b.minX} ${y} ${b.minZ} ${b.maxX} ${Math.min(b.maxY, y + 15)} ${b.maxZ} air`); fills++; }
  for (let k = 0; k < D; k++) {
    let i = 0;
    while (i < W) {
      const r = runsOf(i, k), key = json(r);
      let e = i;
      while (e + 1 < W && json(runsOf(e + 1, k)) === key) e++;
      for (const [j0, j1, blk] of r) { await cmd(`/fill ${b.minX + i} ${b.minY + j0} ${b.minZ + k} ${b.minX + e} ${b.minY + j1} ${b.minZ + k} ${blk}`); fills++; }
      i = e + 1;
    }
  }
  return fills;
}

// ------------------------------------------------------------------ site (af-site)

steps.site = async () => {
  await ensure();
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const { rotationFacing } = await imp('lib/region/affordances.mjs');
  const out = { fixtures: {}, natural: null };
  // (a) the synthesized fixtures, built cell for cell in a flat world at their own coordinates
  await L.fresh('G6B AF Fixtures', FLAT);
  await L.setRules('exact');
  for (const id of ['cliff_face', 'overhang', 'trunk']) {
    const s = JSON.parse(fs.readFileSync(path.join(FIX, id, 'site.json'), 'utf8'));
    const v = decodeArvx(fs.readFileSync(path.join(FIX, id, 'volume.bin')));
    const b = v.box;
    await L.tp((b.minX + b.maxX) >> 1, b.maxY + 20, (b.minZ + b.maxZ) >> 1);
    const fills = await buildFixture(v);
    await call('dev.wait', { ms: 1500 }, 30_000);
    const a = await site(s.lot, s.fit);
    const gold = JSON.parse(fs.readFileSync(path.join(GOLD, `${id}.json`), 'utf8').trim());
    const sameAff = json(a.affordances) === json(gold.affordances);
    check(a.sha === s.spec.volumeSha && json(a.box) === json(s.spec.volume) && a.missingColumns === 0, `(a) ${id}: built by ${fills} fills, Survey.site froze the lot + 8 (${json(a.box)}) to the fixture's own sha ${a.sha.slice(0, 12)} (want ${s.spec.volumeSha.slice(0, 12)}), 0 missing columns`, { counts: a.counts, want: s.counts });
    check(sameAff, `(a) ${id}: the ${a.affordances.length} affordances equal the kit's golden (kit/test/fixtures/af/${id}.json: ids, boxes, anchors, normals, metrics, scores)`, sameAff ? null : { got: a.affordances.map((x) => x.id), want: gold.affordances.map((x) => x.id) });
    check(json(a.proposed) === json(s.spec.frame), `(a) ${id}: the proposed frame is the fixture's own (${json(a.proposed)}) for ${s.fit}`);
    out.fixtures[id] = { fills, sha: a.sha, kinds: [...new Set(a.affordances.map((x) => x.kind))], n: a.affordances.length, proposed: a.proposed, ms: a.ms };
  }
  await L.leaveWorld();
  // (b) the real cliff (the pinned seed world; CW's pinned run)
  const cf = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  await L.fresh('G6B AF Natural', BASE);
  await L.setRules('exact');
  const [ax, ay, az] = cf.fixture.run.a;
  const lot = { minX: ax - 8, minY: ay - 4, minZ: az, maxX: ax + 8, maxY: ay + 11, maxZ: az + 15 };
  await L.tp(ax, ay + 30, az + 8);
  const a1 = await site(lot, 'attach_to_cliff', 'bounded:64');
  const near = (b) => b.minX <= lot.maxX + 1 && lot.minX - 1 <= b.maxX && b.minY <= lot.maxY + 1 && lot.minY - 1 <= b.maxY && b.minZ <= lot.maxZ + 1 && lot.minZ - 1 <= b.maxZ;
  const faces = a1.affordances.filter((x) => x.kind === 'cliff_face' && near(x.box));
  check(a1.missingColumns === 0 && faces.length > 0, `(b) the real cliff (seed ${cf.world.seed}, run at ${json(cf.fixture.run.a)}): Survey.site over the lot ${json(lot6(lot))} finds ${faces.length} cliff face(s) at it (${faces.map((f) => `${f.normal} ${f.metrics.height}x${f.metrics.length}`).join(', ')}); ${a1.affordances.length} affordances in all (${[...new Set(a1.affordances.map((x) => x.kind))].join(', ')}), 0 missing columns`);
  const chosen = a1.affordances.find((x) => x.kind === 'cliff_face' && near(x.box));
  check(!!a1.proposed && !!chosen && a1.proposed.rotation === rotationFacing(chosen.normal) && json(a1.proposed.origin) === json([lot.minX, lot.minY, lot.minZ]), `(b) a frame proposed for attach_to_cliff: ${json(a1.proposed)} (the lot's corner, the front to the best face's normal ${chosen?.normal})`);
  const k = kitCli(a1.file, lot, 'attach_to_cliff');
  check(k.ok && k.sha === a1.sha && json(k.affordances) === json(a1.affordances) && json(frameOf(k.proposed)) === json(a1.proposed), `(b) the mod's answer equals the kit's CLI over the same frozen file (${path.basename(a1.file)}): sha, ${k.affordances?.length} affordances, the frame`);
  const a2 = await site(lot, 'attach_to_cliff', 'bounded:64');
  check(a2.sha === a1.sha && json(a2.affordances.map((x) => x.id)) === json(a1.affordances.map((x) => x.id)), `(b) a second Survey.site: the same sha and the same ${a2.affordances.length} ids (stable on re-analysis of unchanged land)`);
  const vs = (await imp('lib/region/affordances.mjs')).analyseVolume(decodeArvx(fs.readFileSync(a1.file)));
  out.natural = { lot: lot6(lot), sha: a1.sha, box: a1.box, file: a1.file, counts: a1.counts, kinds: [...new Set(vs.map((x) => x.kind))], affordances: a1.affordances, proposed: a1.proposed, ms: [a1.ms, a2.ms] };
  fs.mkdirSync(path.join(OUT, 'site'), { recursive: true });
  fs.copyFileSync(a1.file, path.join(OUT, 'site', `natural-${a1.sha.slice(0, 16)}.bin`));
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ nowrite (af-nowrite)

steps.nowrite = async () => {
  await ensure();
  const cf = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  await L.fresh('G6B AF NoWrite', BASE);
  await L.setRules('exact');
  const [ax, ay, az] = cf.fixture.run.a;
  const lot = { minX: ax - 8, minY: ay - 4, minZ: az, maxX: ax + 8, maxY: ay + 11, maxZ: az + 15 };
  await L.tp(ax, ay + 30, az + 8);
  // the first call generates and loads the chunks (bounded) and freezes the volume: the rounds after it are the proof
  const first = await site(lot, 'attach_to_cliff', 'bounded:64');
  const box = first.box;
  const worldDir = path.resolve(path.dirname(first.file), '..', '..');
  // Architect's whole world state: the journal, every file under <world>/architect (the volumes dir among them) and the regions
  const dirs = [path.join(worldDir, 'architect-journal'), path.join(worldDir, 'architect'), path.join(worldDir, 'architect-regions')];
  await call('dev.wait', { ms: 5000 }, 30_000);
  // the land's own drift with no call (fluids settling after generation, if any)
  const d0 = await hashOf(box);
  await call('dev.wait', { ms: 3000 }, 30_000);
  const d1 = await hashOf(box);
  check(d0 === d1, `the land holds still with no call (two hashes of the volume box 3 s apart equal): ${d0 === d1}`);
  const sites0 = await call('dev.sites.state', {}, 60_000);
  const rounds = [];
  for (let i = 0; i < 3; i++) {
    const h0 = await hashOf(box);
    const l0 = dirs.map(listing);
    const a = await site(lot, 'attach_to_cliff', 'loaded');
    const b = await site(lot, i === 1 ? 'carve_into' : 'attach_to_cliff', 'loaded');
    await call('dev.wait', { ms: 1500 }, 30_000);
    const h1 = await hashOf(box);
    const l1 = dirs.map(listing);
    const diffs = dirs.map((d, n) => listDiff(l0[n], l1[n]));
    const same = json(strip(a)) === json(strip(first)) && json(b.affordances) === json(first.affordances) && b.sha === first.sha;
    check(h0 === h1 && diffs.every((d) => d.length === 0) && same, `round ${i + 1}: two Survey.site calls${i === 1 ? ' (one for carve_into)' : ''} wrote nothing: the volume box's hash ${h0 === h1 ? 'unchanged' : 'MOVED'}; the journal (${Object.keys(l0[0]).length} files), <world>/architect (${Object.keys(l0[1]).length} files, the frozen volume among them: no new file) and the regions dir unchanged (${diffs.flat().length} differ); the answers equal the first's: ${same}`, { diffs, h0, h1 });
    rounds.push({ h0, h1, diffs, proposedB: b.proposed });
  }
  const sites1 = await call('dev.sites.state', {}, 60_000);
  const ids = (st) => json({ sites: (st.sites ?? []).map((x) => [x.id, x.state ?? null]), pending: (st.pending ?? []).length });
  check(ids(sites0) === ids(sites1), `no site was placed or changed (dev.sites.state's site ids and states equal before and after: ${(sites0.sites ?? []).length} sites)`);
  await L.leaveWorld();
  spendZero();
  return { lot: lot6(lot), box, sha: first.sha, worldDir, rounds };
};

// ------------------------------------------------------------------ cut (S4-S6 windows, by hand)

steps.cut = async () => {
  await ensure();
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const { analyseVolume } = await imp('lib/region/affordances.mjs');
  await L.fresh('G6B AF Cut', BASE);
  await L.setRules('exact');
  const dir = path.join(OUT, 'cut');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {};
  for (const id of ['s4_ravine_town', 's5_treehouses', 's6_cave_city']) {
    const sc = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', `${id}.json`), 'utf8'));
    check(sc.world.seed === SEED, `${id}: the pinned seed ${sc.world.seed}`);
    const [x0, z0, x1, z1] = sc.fixture.claim;
    const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
    const [ylo, yhi] = sc.fixture.yRange;
    const box = [cx - 32, ylo, cz - 32, cx + 31, yhi, cz + 31];
    await L.tp(cx, yhi + 10, cz);
    const v = await call('dev.survey.volume', { box, load: 'bounded:64' }, 1_800_000);
    if (v.refused) { check(false, `${id}: Survey.volume refused: ${v.refused}`); continue; }
    const f = path.join(dir, `${id}.bin`);
    fs.copyFileSync(path.resolve(L.GAME_DIR, v.file), f); // (dev.survey.volume's file is relative to the game dir)
    const d = decodeArvx(fs.readFileSync(f));
    const t = Date.now();
    const a = analyseVolume(d);
    const kinds = {};
    for (const x of a) kinds[x.kind] = (kinds[x.kind] ?? 0) + 1;
    manifest[id] = { seed: sc.world.seed, claim: sc.fixture.claim, box, sha: v.sha, bytes: fs.statSync(f).size, missingColumns: v.missingColumns, counts: v.counts, kinds, analyseMs: Date.now() - t };
    check(v.missingColumns === 0 && d.sha === v.sha, `${id}: the window ${json(box)} frozen (${v.sha.slice(0, 12)}, ${manifest[id].bytes} bytes, 0 missing columns); the kit finds ${json(kinds)} in ${manifest[id].analyseMs} ms`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  await L.leaveWorld();
  spendZero();
  return manifest;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const lines = ['# Slice 7b AF gate', '', 'Spend: $0.00 (cap $0).', ''];
  for (const s of ['unit', 'site', 'nowrite', 'cut']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { lines.push(`## ${s}: not run`, ''); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    lines.push(`## ${s}: ${res.every(([, r]) => r?.ok) ? 'PASS' : 'FAIL'} (${res.filter(([, r]) => r?.ok).length}/${res.length}, ${j.seconds} s, ${j.head?.slice(0, 10)})`);
    for (const [k, v] of res) lines.push(`- ${v?.ok ? 'ok' : 'FAIL'} ${k}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7baf.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
