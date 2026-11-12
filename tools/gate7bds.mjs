#!/usr/bin/env node
// Phase 7b slice DS gate (the designer's site inputs; docs/CONTRACT.md "Phase 7b" §3 row 7) against the headless server of the DS run
// worktree (GATE6B_RUN, default `../architect-mc-DS-run`; the sim sidecar, no Claude). $0: no Claude call anywhere. Ports 8904/8905.
//
//   node tools/gate7bds.mjs <step>
//     start [world] | stop | base      the headless server and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (ds-unit)              offline: kit/test/ds.test.mjs (the Site section's words, the empty-site renders, site-brief.mjs, DS's
//                                      two cliffs) and sidecar/test/site-design.test.ts (the sim end to end in the helper alone)
//     sim       (ds-sim)               the sim end to end through the mod (dev.ds.*, the public API): cliff_face and DS's cliff_east and
//                                      cliff_owned built by /fill in a flat world and frozen by Survey.site (their own shas); a site-aware
//                                      design on cliff_face sent with a `local:` blob id (the mod uploads the world's frozen file),
//                                      designed by the sim and installed bound (SiteBinding in ext, the lot's size); its BRIEF.md diffed
//                                      against a plain request's (the Site section, the lot size, the site commands); Designs.siteVariant
//                                      onto cliff_east: installed as a SITE derivation bound to it, the same opKey answering the same entry;
//                                      onto cliff_owned (a player's pillar where the house goes, written by /fill and so PLAYER-classed):
//                                      SITE_UNFIT site_keep; of a plain kit example: SITE_UNSUPPORTED not_site_aware
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-ds/<step>.json in the main checkout (GATE7BDS_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-DS-run');
process.env.GATE6B_OUT = process.env.GATE7BDS_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-ds');
process.env.GATE6B_SIDECAR_PORT ??= '8904';
process.env.GATE6B_DEV_PORT ??= '8905';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice DS is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B DS Lobby', { backend: 'sim' });
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
  return { worlds: [BASE, FLAT] };
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
  out.kit = nodeTest(['kit/test/ds.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 7, `the kit's site inputs (kit/test/ds.test.mjs: the six fixtures' Site sections against their golden, the words in the design frame, site.json, the renders, site-brief.mjs, DS's two cliffs): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const v = spawnSync('npx', ['vitest', 'run', 'test/site-design.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 1_800_000 });
  const t = `${v.stdout}${v.stderr}`;
  out.sidecar = { code: v.status, tests: (/Tests\s+(.*)$/m.exec(t) ?? [])[1] ?? '?' };
  check(v.status === 0, `the helper's site design (sidecar/test/site-design.test.ts: schema, the kept volume, the scratch's site/, the BRIEF diff, the composite check, the binding, site variants and their refusals, SITE follows, a paid adaptation, estimates): ${out.sidecar.tests}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ helpers

/** Builds a fixture volume's terrain by /fill (columns with the same runs along x merged): ROCK stone, SOIL dirt, LOG oak_log, PLAYER cobblestone. */
async function buildFixture(v) {
  const { VOXEL_CLASSES } = await imp('lib/region/volume.mjs');
  const BLOCK = { ROCK: 'stone', SOIL: 'dirt', LOG: 'oak_log', LEAVES: 'oak_leaves[persistent=true]', PLAYER: 'cobblestone' };
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
const lot6 = (l) => [l.minX, l.minY, l.minZ, l.maxX, l.maxY, l.maxZ];
/** A fixture's site spec with a local blob id (the mod resolves it: this world's frozen file uploaded). */
function fixture(dir) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'site.json'), 'utf8'));
  return { s, spec: { ...s.spec, volumeBlobId: `local:${s.spec.volumeSha}` } };
}
async function waitDesign(id, ms = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await call('dev.ds.design', { designId: id }, 30_000);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(d.status)) return d;
    if (Date.now() - t0 > ms) throw new Error(`design ${id} still ${d.status} after ${ms / 1000}s: ${d.step}`);
    await call('dev.wait', { ms: 1000 }, 30_000);
  }
}
const brief = (designId) => {
  const f = path.join(L.SIDECAR_DATA, 'designs', designId, 'BRIEF.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};

// ------------------------------------------------------------------ sim (ds-sim)

steps.sim = async () => {
  await ensure();
  const { decodeArvx } = await imp('lib/region/volume.mjs');
  const out = { sites: {} };
  await L.fresh('G6B DS Sites', FLAT);
  await L.setRules('exact');
  const dirs = { cliff_face: path.join(KIT, 'test', 'fixtures', 'site', 'cliff_face'), cliff_east: path.join(KIT, 'test', 'fixtures', 'ds', 'cliff_east'), cliff_owned: path.join(KIT, 'test', 'fixtures', 'ds', 'cliff_owned') };
  const fx = {};
  for (const [id, dir] of Object.entries(dirs)) {
    const v = decodeArvx(fs.readFileSync(path.join(dir, 'volume.bin')));
    const b = v.box;
    await L.tp((b.minX + b.maxX) >> 1, b.maxY + 20, (b.minZ + b.maxZ) >> 1);
    const fills = await buildFixture(v);
    await call('dev.wait', { ms: 1500 }, 30_000);
    fx[id] = fixture(dir);
    const a = await call('dev.af.site', { lot: lot6(fx[id].s.lot), fit: 'attach_to_cliff', load: 'bounded:64' }, 600_000);
    if (a.refused) throw new Error(`Survey.site refused on ${id}: ${a.refused}`);
    check(a.sha === fx[id].s.spec.volumeSha && a.missingColumns === 0, `${id}: built by ${fills} fills; Survey.site froze the lot + 8 to the fixture's own sha ${a.sha.slice(0, 12)} (want ${fx[id].s.spec.volumeSha.slice(0, 12)}): the world holds the frozen file the mod sends`, { counts: a.counts, want: fx[id].s.counts });
    out.sites[id] = { fills, sha: a.sha, file: a.file };
  }
  // a site-aware design on cliff_face (a local blob id: the mod uploads the world's frozen file), and a plain one for the BRIEF diff
  const r1 = await call('dev.ds.request', { site: fx.cliff_face.spec, name: 'DS Cliff House', notes: 'a lookout over the valley' }, 60_000);
  check(!!r1.designId, `Designs.request with DesignRequest.site (volumeBlobId local:<sha>): accepted, design ${r1.designId}${r1.refused ? ` (refused ${r1.refused})` : ''}`);
  const p1 = await call('dev.ds.request', { site: fx.cliff_face.spec, plain: true, name: 'DS Cliff House', notes: 'a lookout over the valley' }, 60_000);
  const d1 = await waitDesign(r1.designId);
  const dp = await waitDesign(p1.designId);
  check(d1.status === 'DONE' && !!d1.entryId, `the sim designed it into the site and installed ${d1.entryId} (${d1.step})`);
  const e1 = d1.entry ?? {};
  check(e1.binding?.volumeSha === fx.cliff_face.s.spec.volumeSha && e1.binding?.fit === 'attach_to_cliff' && e1.binding?.lotId === 'lot_cliff_face', `the entry carries its SiteBinding in ext (SiteBinding.of: ${json(e1.binding)})`);
  check(json(e1.size) === json({ x: 16, y: 22, z: 12 }), `the entry is exactly the lot box: ${json(e1.size)}`);
  const b1 = brief(r1.designId);
  // the two designs got different ids (the same name: <id> and <id>_2): the plain BRIEF's id is read as the site one's before the diff
  const idOf = (t) => (/^Design id: `([a-z0-9_]+)`/m.exec(t ?? '') ?? [])[1];
  const b0raw = brief(p1.designId);
  const b0 = b0raw && idOf(b0raw) && idOf(b1) ? b0raw.replaceAll(idOf(b0raw), idOf(b1)) : b0raw;
  const lines = (t) => (t ?? '').split('\n');
  const added = lines(b1).filter((l) => !lines(b0).includes(l));
  const removed = lines(b0).filter((l) => !lines(b1).includes(l));
  const siteSec = added.filter((l) => l.startsWith('## Site'));
  const expected = /^$|^- maximum size \(|^- `groundY` is the feet row|^- Build and check: `node kit\/build\.mjs|^- Look at it: `node kit\/render\.mjs/;
  check(!!b1 && !!b0 && dp.status === 'DONE' && siteSec.length === 1 && added.some((l) => /cliff face facing south/.test(l)) && added.some((l) => /--site site\/site\.arvx --lot site\/site\.json/.test(l)) && removed.every((l) => expected.test(l)),
    `the BRIEF diffed against the plain request's (ids aligned): +${added.length} lines (the Site section in words from the analysis, the lot size, the site commands), -${removed.length}, each the maximum size, groundY, the build or the render command (or a blank line); nothing else moved`, { removed, addedHead: added.slice(0, 12) });
  fs.mkdirSync(path.join(OUT, 'sim'), { recursive: true });
  if (b1) fs.writeFileSync(path.join(OUT, 'sim', 'BRIEF-site.md'), b1);
  if (b0) fs.writeFileSync(path.join(OUT, 'sim', 'BRIEF-plain.md'), b0);
  const scratchSite = path.join(L.SIDECAR_DATA, 'designs', r1.designId, 'site');
  const files = fs.existsSync(scratchSite) ? fs.readdirSync(scratchSite).sort() : [];
  check(['site-composite.png', 'site-iso.png', 'site-section.png', 'site-top.png', 'site.arvx', 'site.json'].every((f) => files.includes(f)), `the scratch's site/: ${files.join(', ')}`);
  // site variants
  const v1 = await call('dev.ds.variant', { entryId: d1.entryId, site: fx.cliff_east.spec, opKey: 'ds-gate-east' }, 600_000);
  check(!!v1.entryId && !v1.refused, `Designs.siteVariant onto cliff_east: installed ${v1.entryId} in ${v1.ms} ms ($0)${v1.refused ? ` refused ${v1.refused}` : ''}`);
  const ve = v1.entryId ? await call('dev.ds.entry', { entryId: v1.entryId }, 30_000) : {};
  check(ve.known && ve.derivation?.kind === 'SITE' && ve.derivation?.source === d1.entryId && ve.binding?.volumeSha === fx.cliff_east.s.spec.volumeSha && json(ve.size) === json({ x: 18, y: 24, z: 12 }),
    `the variant is a SITE derivation of ${d1.entryId} bound to cliff_east (${json(ve.derivation && { kind: ve.derivation.kind, source: ve.derivation.source, sourceVersion: ve.derivation.sourceVersion })}, ${json(ve.size)})`);
  const v2 = await call('dev.ds.variant', { entryId: d1.entryId, site: fx.cliff_east.spec, opKey: 'ds-gate-east' }, 600_000);
  check(v2.entryId === v1.entryId, `the same opKey answers the same entry (${v2.entryId})`);
  const v3 = await call('dev.ds.variant', { entryId: d1.entryId, site: fx.cliff_owned.spec, opKey: 'ds-gate-owned' }, 600_000);
  check(/^SITE_UNFIT/.test(v3.refused ?? '') && v3.detail === 'site_keep', `onto cliff_owned (a player's pillar where the house goes): refused ${v3.refused?.split(':')[0]} detail ${v3.detail}`);
  const v4 = await call('dev.ds.variant', { entryId: 'cabin', site: fx.cliff_east.spec, opKey: 'ds-gate-cabin' }, 600_000);
  check(/^SITE_UNSUPPORTED/.test(v4.refused ?? '') && v4.detail === 'not_site_aware', `of the plain kit example cabin: refused ${v4.refused?.split(':')[0]} detail ${v4.detail}`);
  out.design = { designId: r1.designId, entryId: d1.entryId, binding: e1.binding, plainDesignId: p1.designId };
  out.variants = { east: v1, owned: v3, cabin: v4, replay: v2 };
  await L.leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'sim']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rs = Object.values(j.results ?? {});
    rows.push(`| ${s} | ${rs.filter((r) => r.ok).length} ok | ${rs.filter((r) => !r.ok).length} failed | ${j.seconds}s |`);
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# 7b DS gate\n\n| step | ok | failed | time |\n|---|---|---|---|\n${rows.join('\n')}\n`);
  return { rows };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7bds.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
const bad = Object.values(results).filter((r) => !r.ok).length;
process.exit(bad ? 1 : 0);
