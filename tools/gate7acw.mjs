#!/usr/bin/env node
// Phase 7a slice CW gate (docs/CONTRACT.md "Phase 7a slice CW: catwalks along a face" §8) against a dev client or the headless server
// of the CW run worktree (`../architect-mc-CW-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 8936 (sidecar) / 8937 (DevBridge) by default (the runner sets its own). $0: no Claude call anywhere.
//
//   node tools/gate7acw.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (cw-unit)               items 1, 2 (kit), 5's lint, 9 offline: kit/test/catwalk-cw.test.mjs (the run search on both faces,
//                                       every refusal with its evidence and NO_GAP's path wouldFit re-checked alone, M10:catwalk on the
//                                       broken variants, the KC row, the wire shapes, survival's order, determinism), the foundation's,
//                                       P0's, K1's, T3's and T2's tests; the structure lint's catwalk cases (even:catwalk both faces both
//                                       axes, p0:cw); the catalogue diff (pre-7a -> the golden: connector.catwalk reserved -> supported)
//     unchanged (cw-unit)               item 2: every committed plan fixture without a catwalk plans as on the merge base (answers, IR,
//                                       the first plan; tools/lib/gate7a-kit.mjs), but the foundation's named movers (F7A_MOVED)
//     ingame    (cw-ingame)             items 3-7 on flat worlds (headless): catwalks_demo flat (a cliff raised in stage ground) planned,
//                                       realised, re-read from the dumps (M10:catwalk 0, M8 0, M6 0, M5 0 dark deck cells, M3 0, 0 face
//                                       cells written; realised == virtual), kit movers and vanilla dev.nav.villager both ways, Regions.remove
//                                       exact (E-flat 0); v7a_cw_cliff (plan v1's shape) on its terrain built by commands through
//                                       Regions.checkPlan then realiseApproved, re-read equal to the virtual world, crossed both ways,
//                                       removed (E-flat 0); the KC row: cw/k01_past_falls (the catwalk past a waterfall's basin) checked,
//                                       realised, M25:clear 0, removed
//     survival  (cw-survival)           item 8 (RS merged): v7a_cw_cliff in survival: checked in survival, fed from a stockpile, built;
//                                       the bills equal the check's cost.survival.bom; the world equal to its INSTANT twin; removed E-flat 0
//     pin                               the natural site (scenarios/sites/cliff_face.json): find-site's spiral over the seed world, each
//                                       candidate's survey through catwalks_demo's pickFace (a run along a face of at least 24 x 8, no water
//                                       within 8); the winner recorded in the site file (commit it)
//     natural   (cw-natural)            items 4, 5, 7 on the pinned site (a fresh copy of the seed world): catwalks_demo natural, the same
//                                       bars, the removal's E-normal classified (0 unclassified)
//     look      (cw-look)               item 10 (client, recorded not judged: N-CW-1): catwalks_demo flat in three bibles, from below, on it, a close-up of the rail on its bed, the lanes and the landing, and from the side
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-cw/<step>.json in the main checkout (GATE7ACW_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CW-run');
process.env.GATE6B_OUT = process.env.GATE7ACW_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-cw');
process.env.GATE6B_SIDECAR_PORT ??= '8936';
process.env.GATE6B_DEV_PORT ??= '8937';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:cw';
const FLAT_CLAIM = [6000, 6000, 6199, 6119];
const SITE_FILE = path.join(root, 'scenarios', 'sites', 'cliff_face.json');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CW is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C CW Lobby', { backend: 'sim' });
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

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
/** (gate waits) the kit suite once per gate run (tools/lib/kit-reuse.mjs): pass/fail-only kit files take this run's unit-kit results when exact. */
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.cw = kitOnce(['kit/test/catwalk-cw.test.mjs']);
  check(out.cw.code === 0 && out.cw.fail === 0 && out.cw.pass >= 9, `item 1 (kit): the lanes on the walk's footprint on every heading and face, §2's checks in order (brackets on land, struts within 2), the run search on both faces (exactly one run, off without spans), v7a_cw_cliff (M10:catwalk, M8, M6, M5, M3 clean; the crossing, the graph edge, the BOM exact, the face never written, the siteplan row), the refusals NO_GAP (its path wouldFit fits alone), ANCHOR on sand, HEADROOM, SPAN 33, MOVER with their evidence, M10:catwalk on noBrackets, noRails and wideDeck, the KC row (M25 0), survival's order, determinism: ${out.cw.pass} pass, ${out.cw.fail} fail`, out.cw.failing);
  out.found = kitOnce(['kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/t3-foundation.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/catalogue-since.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `items 2, 9 (kit): the foundation's tests (the 7a flips left out of its own three), P0 (connector.catwalk supported with v7a_cw_cliff, e15 off it), K1's and T3's foundation tests, T2's routes, the realise lint: ${out.found.pass} pass, ${out.found.fail} fail`, out.found.failing);
  // the structure lint's catwalk cases: the even-width fuzz (widths 1 and 2, both faces, both axes) and the plan/0 corpus of cw/
  const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'even:catwalk,p0:cw,even:bridge,even:rope,even:tunnel'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-16);
  check(lint.status === 0, `item 5 (lint): the structure lint's even:catwalk (lanes on the walk's footprint at both ends, S-LAND; M10:catwalk, M8, M6 clean; widths 1 and 2 both ways on both axes) and p0:cw (the refusal set as expected, the broken variants caught), the other even-width cases unchanged`, out.lint);
  // item 9: the catalogue flip only (the foundation's archive -> the golden: connector.catwalk among the flips)
  const d = spawnSync(process.execPath, ['tools/plan-catalogue-diff.mjs', 'kit/test/fixtures/plan/catalogue-pre7a.json', 'kit/schemas/plan-catalogue.golden.json'], { cwd: root, encoding: 'utf8' });
  out.diff = `${d.stdout}${d.stderr}`.trim();
  const flips = (/reserved -> supported: (.*)/.exec(out.diff) ?? [])[1] ?? '';
  check(d.status === 0 && flips.split(', ').includes('connector.catwalk') && /retired: none/.test(out.diff) && /REMOVED \(never allowed\): none/.test(out.diff), `item 9: tools/plan-catalogue-diff.mjs pre-7a -> the golden flips connector.catwalk reserved -> supported (with the foundation's span_bridge${flips.split(', ').length > 2 ? ' and the other merged 7a slices\'' : ''}): ${flips}; nothing retired or removed`, out.diff.split('\n'));
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const { F7A_MOVED } = await import('./lib/f7a-norm.mjs');
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'CW', except: F7A_MOVED });
  fs.writeFileSync(path.join(OUT, 'cw-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

// ------------------------------------------------------------------ in game: the re-read

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep, before, after };
}

/** Item 5 over the realised world: every catwalk's bars re-read; dark deck cells; M3 in the catwalk parts; the kit movers both ways. */
async function item5(tag, { meta, world, rep }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.catwalks?.per ?? [];
  const recs = meta.catwalks ?? [];
  const out = { catwalks: per, M5catwalk: rep.metrics.M5catwalk ?? null };
  check(per.length === recs.length && per.length >= 1, `item 5 (${tag}): ${per.length} catwalk(s) re-read from the realised world (${per.map((q) => `${q.n} cells, the face ${q.side}`).join(', ')})`);
  const m10 = rep.findings.filter((f) => f.rule === 'M10:catwalk');
  check(!m10.length && per.every((q) => q.ok), `item 5 (${tag}): M10:catwalk 0 (every lane level at y, the face beside every deck cell, the outer edge at most 2 from it, brackets at most 4 apart): ${per.map((q) => `${q.level}/${q.cells} level, ${q.faceOk}/${q.n} face, outer ${q.outerMax}, ${q.supports} supports (gap ${q.maxGap})`).join('; ')}${m10.length ? `; ${m10.map((f) => f.message).join('; ').slice(0, 300)}` : ''}`);
  const own = new Set(recs.map((q) => q.part));
  const m8 = rep.findings.filter((f) => f.rule === 'M8' && own.has(f.part)), m6 = rep.findings.filter((f) => f.rule === 'M6' && own.has(f.part));
  check(!m8.length && per.every((q) => q.railed === q.n), `item 5 (${tag}): M8 0: a rail on the open edge of 100% of deck cells (${per.map((q) => `${q.railed}/${q.n}`).join(', ')})`);
  check(!m6.length && per.every((q) => q.headroom === q.n), `item 5 (${tag}): M6 0: 2 clear over 100% of deck cells (${per.map((q) => `${q.headroom}/${q.n}`).join(', ')})`);
  check(rep.metrics.M5catwalk && rep.metrics.M5catwalk.darkSpawnable === 0 && rep.metrics.M5catwalk.deckCells > 0, `item 5 (${tag}): M5 0 dark spawnable deck cells (the realised light: ${json(rep.metrics.M5catwalk && { dark: rep.metrics.M5catwalk.darkSpawnable, cells: rep.metrics.M5catwalk.deckCells })})`);
  const m3 = rep.findings.filter((f) => /^M3/.test(f.rule) && own.has(f.part));
  check(!m3.length, `item 5 (${tag}): M3 0 floating cells in the catwalk parts (${m3.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  check(per.every((q) => q.faceWritten === 0), `item 5 (${tag}): 0 face cells written (${per.map((q) => q.faceWritten).join(', ')})`);
  out.movers = {};
  for (const q of recs) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    out.movers[q.id] = Object.fromEntries(['player', 'villager'].map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
  }
  check(Object.values(out.movers).every((v) => v.player && v.villager), `item 4 (${tag}): kit player and villager movers along every catwalk both ways (${json(out.movers)})`);
  return out;
}

/** Vanilla's villager path along every catwalk, both ways (the hard bar), from its start walk cell to its landing (feet cells). */
async function nav(meta) {
  const out = {};
  for (const q of meta.catwalks ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out[q.id] = { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
  }
  return out;
}

/** The P2 SMOKE row: realised == virtual per writer kind (catwalks strict on a flat world). */
async function smoke(tag, planDir, after, before, strict) {
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
  check(RV.realisedOk(rv, ['catwalks'], { strict }).pass && (rv.byKind.catwalks?.differ ?? 0) === 0 && (rv.byKind.catwalks?.written ?? 0) > 0, `item 3/P2 SMOKE (${tag}${strict ? ', strict' : ''}): realised == virtual per writer kind, ${rv.differ} of ${rv.written} differ (catwalks ${rv.byKind.catwalks?.differ ?? '?'} of ${rv.byKind.catwalks?.written ?? 0}): ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  return { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
}

/** Plan catwalks_demo, realise, re-read, nav, remove: one run in the open world. `kind`: flat | natural. */
async function demoRun(tag, claim, { kind }) {
  const out = { claim, kind };
  const flat = kind === 'flat';
  const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);
  await tp((claim[0] + claim[2]) / 2, flat ? -20 : 200, (claim[1] + claim[3]) / 2);
  const p = await L.plan('catwalks_demo', claim, { params: { variant: kind }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const planDir = sideDir(p.planId);
  out.plan = { planId: p.planId, irSha: p.irSha, notes: (p.notes ?? []).slice(-2) };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  check((meta.catwalks ?? []).length >= 1, `${tag}: catwalks_demo (${kind}) planned ${(meta.catwalks ?? []).length} catwalk(s) (${(meta.catwalks ?? []).map((q) => `${q.n} cells, the face ${q.side}, ${q.brackets} brackets`).join(', ')}; ${out.plan.notes.join(' / ')})`);
  if (!(meta.catwalks ?? []).length) return out;
  if (flat) check(meta.catwalks.some((q) => q.n === 16 && q.width === 2), `${tag}: a 2-wide villager catwalk of 16 along the face, 8 over the foot (${json(meta.catwalks.map((q) => [q.n, q.width, q.side]))})`);
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const irP = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const blobsP = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw: vP } = buildVirtual({ ir: irP, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs: blobsP });
  let y0 = Infinity, y1 = -Infinity;
  vP.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
  await tp((claim[0] + claim[2]) / 2, Math.min(319, y1 + 20), (claim[1] + claim[3]) / 2);
  await L.settle(flat ? 5000 : 60_000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  check(st.view.state === 'PLACED', `${tag}: realised (${st.view.state}, ${out.realise.cells} cells)`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, planDir, after, before, flat);
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 4 (${tag}, the hard bar): vanilla dev.nav.villager along every catwalk, both ways (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // item 7: the removal by its owner
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 7 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored; journal ${out.realise.cells} cells written)`);
  else {
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    check(rm.removed && none === 0 && (diff.classes?.gravity ?? 0) === 0, `item 7 (${tag}): the removal's E-normal classified (growth and grazed admitted, no gravity, 0 unclassified): ${diff.mismatches} mismatches (${json(diff.classes ?? {})})`);
  }
  return out;
}

/** A fixture's plan, planned here by the kit over the world's survey of its claim (what the mod's check plans): a plan dir for the re-read. */
async function localPlanDir(tag, s) {
  const H = await imp('test/plan-helpers.mjs');
  const file = path.join(OUT, `${tag}-survey.arsv`);
  await call('dev.region.survey', { claim: s.W.claim, surveyLoad: 'bounded:256', file }, 900_000);
  const bytes = fs.readFileSync(file);
  const claim = { minX: s.W.claim[0], minZ: s.W.claim[1], maxX: s.W.claim[2], maxZ: s.W.claim[3], minY: -64, maxY: 319 };
  const r = await H.checkPlanLocal(s.wp.plan, { survey: bytes, claim, anchors: s.wp.anchors, protected: s.wp.protected ?? [] });
  const dir = path.join(OUT, `${tag}-plan`);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ir.json'), r.res.irJson);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(r.res.meta));
  fs.writeFileSync(path.join(dir, 'survey.bin'), bytes);
  for (const [sha, b] of r.res.blobs) fs.writeFileSync(path.join(dir, 'blobs', `${sha}.bin`), b);
  return { dir, check: r.check };
}

/**
 * A plan/0 fixture on its terrain built by commands in a fresh flat world (RS's site helper): Regions.checkPlan (load: generate),
 * realiseApproved, re-read (the kit's plan of the same request over the world's survey as the virtual world), crossed, removed.
 */
async function fixtureRun(tag, name, { kc = false } = {}) {
  const out = { fixture: name };
  const fx = G.fixture(ctx, name);
  const s = await G.site(ctx, tag, fx, { creative: true });
  const ck = await G.check(ctx, tag, s);
  out.check = { overall: ck.check?.overall ?? null, parts: (ck.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, catwalks: a.geometry?.catwalks, reasons: a.reasons })), volumePass: ck.volumePass ?? null };
  check(ck.check?.overall === 'READY' && (ck.check?.parts ?? []).every((a) => a.class === 'fits'), `item ${kc ? 6 : 3} (${tag}): ${name} (plan v1's shape) checks READY through Regions.checkPlan (${json(out.check.parts.map((a) => [a.part, a.class, (a.catwalks ?? []).map((c) => [c.n, c.side])]))})`);
  if (!ck.check?.artifactSha) return out;
  const local = await localPlanDir(tag, s);
  out.local = { overall: local.check.overall, same: JSON.stringify(local.check.parts.map((a) => [a.part, a.class, a.geometry?.catwalks])) === JSON.stringify((ck.check.parts ?? []).map((a) => [a.part, a.class, a.geometry?.catwalks])) };
  check(out.local.same, `item 3 (${tag}): the kit's plan of the same request over the world's survey answers as the mod's check (the virtual world the re-read compares against)`);
  const box = G.boxOf(s.W);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const pre = await G.snap(ctx, box, `cw-${tag}-pre`);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await G.realise(ctx, ck.check.artifactSha);
  const st = await L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
  check(st.view.state === 'PLACED', `item ${kc ? 6 : 3} (${tag}): realised from its approved artifact (${st.view.state})`);
  await L.settle(kc ? 15_000 : 5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(local.dir, before, after);
  out.item5 = await item5(tag, R);
  out.smoke = await smoke(tag, local.dir, after, before, !kc);
  if (kc) {
    const m25 = R.rep.findings.filter((f) => f.rule === 'M25:clear');
    out.m25 = { clear: m25.length, bodies: R.rep.metrics.M25?.bodies?.length ?? 0 };
    check(m25.length === 0 && out.m25.bodies >= 1, `item 6 (${tag}, KC): the catwalk past the waterfall's basin kept clear: M25:clear 0 on the realised world (${out.m25.bodies} bod(ies))`);
  }
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.values(out.nav).every((v) => v.there && v.back), `item 4 (${tag}): vanilla dev.nav.villager along the catwalk both ways (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  const rm = await G.remove(ctx, region);
  const d = await G.diff(ctx, box, pre);
  out.exact = { removed: rm.removed, mismatches: d.mismatches, classes: d.classes, list: d.list.slice(0, 20) };
  if (kc) check(rm.removed && (d.classes?.none ?? d.mismatches) === 0, `item 7 (${tag}): removed (${d.mismatches} mismatches, ${json(d.classes)}: the water settles)`);
  else check(rm.removed && d.mismatches === 0, `item 7 (${tag}): Regions.remove: E-flat ${d.mismatches}`, d.list.slice(0, 8));
  await leaveWorld();
  return out;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.ensureBase(FLAT);
  await L.fresh('G6B CW Flat', FLAT);
  await L.setRules('exact');
  out.flat = await demoRun('flat', FLAT_CLAIM, { kind: 'flat' });
  await leaveWorld();
  out.cliff = await fixtureRun('cliff', 'valid/v7a_cw_cliff.json');
  out.kc = await fixtureRun('kc', 'cw/k01_past_falls.json', { kc: true });
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 8: survival (RS)

steps.survival = async () => {
  await ensure();
  const out = {};
  const name = 'valid/v7a_cw_cliff.json';
  const fx = G.fixture(ctx, name);
  const T = await G.twin(ctx, 'cw', fx);
  const s = await G.site(ctx, 'cw', fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'cw-surv-pre');
  const ck = await G.check(ctx, 'cw', s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === 'cliff_walk');
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, cost: a?.cost ?? null };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!a?.cost?.survival, `item 8: v7a_cw_cliff through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}, cost.survival ${json(a?.cost?.survival && { free: a.cost.survival.free, held: a.cost.survival.held })}`);
  if (!ck.check?.artifactSha) return out;
  // §6: nothing free, every cell paid: the catwalk's survival bill is its cost.bom (deck, brackets, struts, rails, lamps)
  const sb = a?.cost?.survival?.bom ?? null;
  out.bills = { survival: sb, bom: a?.cost?.bom ?? null };
  const crateAt = await G.pile(ctx, s, 4);
  const region = await G.realise(ctx, ck.check.artifactSha);
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted, state: st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent } };
  check(st.view.state === 'PLACED' && rs.build?.done && rs.build?.percent === 100, `item 8: realiseApproved in survival and fed in ${f.waves} waves: ${st.view.state}, build ${json(out.feed.build)}`);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ;
  check(differ.length === 0, `item 8: the check's cost.survival.bom against the targets' bills put down, per part: ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal, item for item (BOM exact)'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 8: the survival build equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ (brackets before the deck cells they carry is by construction, not observed here: BuildOrder builds bottom up and every bracket is at y - 1 under its deck cell at y, kit/test/catwalk-cw.test.mjs)`, d.list);
  const rm = await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `item 8: Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the natural site

steps.pin = async () => {
  await ensure();
  const FS = await import('./find-site.mjs');
  const { surveyApi } = await imp('lib/region/survey.mjs');
  const { pickFace, FACE_BAR } = await imp('lib/connectors/catwalksDemo.mjs');
  const site = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  const needs = site.needs;
  await L.fresh('G6B CW Pin', BASE);
  await L.setRules('default');
  const [w, d] = needs.size;
  const out = { tried: [] };
  let found = null;
  const [c0x, c0z] = needs.center ?? [0, 0];
  for (const [ox0, oz0] of FS.candidates(needs.candidates, needs.step)) {
    const ox = ox0 + c0x, oz = oz0 + c0z;
    const x0 = ox - Math.floor(w / 2), z0 = oz - Math.floor(d / 2), x1 = x0 + w - 1, z1 = z0 + d - 1;
    await tp(ox + 0.5, 220, oz + 0.5);
    const r = await cmd(`/apitest survey ${x0} ${z0} ${x1} ${z1} 4 bounded:64`);
    const key = (r.messages ?? []).find((m) => m.startsWith('{'));
    let sample = key ? JSON.parse(key) : null;
    for (let i = 0; sample?.pending && i < 600; i++) {
      const g = await cmd(`/apitest get ${sample.pending}`);
      const line = (g.messages ?? []).find((m) => m.startsWith('{'));
      const v = line ? JSON.parse(line) : null;
      if (v?.value) { sample = v.value; break; }
      await L.sleep(1000);
    }
    if (!sample?.summary) continue;
    const sm = FS.parseSummary(sample.summary);
    const sc = FS.score(sm, needs);
    const row = { claim: [x0, z0, x1, z1], relief: sm.max - sm.min, water: sm.water, trees: sm.trees, biomes: sm.biomes, score: sc };
    out.tried.push(row);
    log(`  candidate ${x0},${z0}: relief ${row.relief}, water ${sm.water}%, trees ${sm.trees}% -> ${sc}`);
    if (sc === null) continue;
    const sandy = Object.entries(sm.biomes).filter(([b]) => /desert|beach|badlands/.test(b)).reduce((a, [, v]) => a + v, 0);
    if (sandy > 20) continue;
    const file = path.join(OUT, `pin-${x0}_${z0}.arsv`);
    await call('dev.region.survey', { claim: [x0, z0, x1, z1], surveyLoad: 'bounded:256', file }, 900_000);
    const claim = { minX: x0, minZ: z0, maxX: x1, maxZ: z1, minY: -64, maxY: 319 };
    const S = surveyApi(fs.readFileSync(file), claim);
    const picks = pickFace(S, claim);
    // the first run whose face meets §8's bar (24 x 8) and has no water within 8 of its columns
    const ok = picks.find((q) => {
      if (q.face.length < FACE_BAR[0] || q.face.height < FACE_BAR[1]) return false;
      const [x, , z] = q.a;
      for (let t = -8; t <= q.n + 9; t++) for (let v = -11; v <= 11; v++) {
        const cx = x + q.dir[0] * t + (q.dir[0] === 0 ? v : 0), cz = z + q.dir[1] * t + (q.dir[1] === 0 ? v : 0);
        if (cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1 && S.waterAt(cx, cz)) return false;
      }
      return true;
    });
    row.picks = picks.length;
    row.best = picks[0] ? { a: picks[0].a, n: picks[0].n, face: picks[0].face } : null;
    log(`  candidate ${x0},${z0}: ${picks.length} run(s) along a face; best ${json(row.best)}; on the bar ${json(ok && { a: ok.a, n: ok.n, face: ok.face })}`);
    // (the run catwalks_demo's natural variant takes: pickFace's first, which sorts the bar's runs first)
    if (!ok || picks[0] !== ok) continue;
    found = { claim: [x0, z0, x1, z1], run: { a: ok.a, dir: ok.dir, side: ok.side, n: ok.n, gap: ok.gap, face: ok.face }, stats: { relief: row.relief, water: sm.water, trees: sm.trees, biomes: sm.biomes, min: sm.min, max: sm.max }, surveySha: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    break;
  }
  check(!!found, `pin: a run along a face of at least ${needs.face?.[0] ?? 24} x ${needs.face?.[1] ?? 8} with no water within 8 (${found ? `${json(found.claim)}, ${json(found.run)}` : `none of ${out.tried.length}`})`);
  if (found) {
    site.fixture = { ...found, pinned: new Date().toISOString().slice(0, 10) };
    fs.writeFileSync(SITE_FILE, `${JSON.stringify(site, null, 2)}\n`);
  }
  await leaveWorld();
  spendZero();
  return { ...out, found };
};

steps.natural = async () => {
  await ensure();
  const site = JSON.parse(fs.readFileSync(SITE_FILE, 'utf8'));
  if (!site.fixture?.claim) { check(false, 'natural: the cliff site is not pinned yet (node tools/gate7acw.mjs pin)'); return {}; }
  await L.ensureBase(BASE);
  await L.fresh('G6B CW Natural', BASE);
  await L.setRules('default');
  const out = await demoRun('natural', site.fixture.claim, { kind: 'natural' });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `cw_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.ensureBase(FLAT);
    await L.fresh(`G6B CW Look ${tag}`, FLAT);
    await L.setRules('exact');
    await cmd('/time set 13000');
    await cmd('/weather clear');
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 0, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const p = await L.plan('catwalks_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER, ...(bible ? { bible } : {}) });
    const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'meta.json'), 'utf8'));
    const region = await L.realise(p.planId, {});
    const st = await L.waitRegion(region, 3_600_000);
    const q = (meta.catwalks ?? [])[0];
    check(st.view.state === 'PLACED' && !!q, `look (${tag}): catwalks_demo flat realised with its catwalk (${st.view.state}; recorded, not judged: Noah's call, N-CW-1)`);
    out.bibles[tag] = { planId: p.planId, state: st.view.state, catwalk: q && { deck: q.deck, bracket: q.bracket, strut: q.strut, rail: q.rail, light: q.light, from: q.from, to: q.to, side: q.side } };
    if (q) {
      // the run heads along x; the open side is +z (the face north): from below (the bay floor), on the deck, and from the far shelf
      const [x, y, z] = q.from, mid = [x + q.dir[0] * Math.floor(q.n / 2), y, z];
      out.shots.push(await shot(`${tag}_below`, [mid[0] + 0.5, y - 7, mid[2] + 9.5], [mid[0] + 0.5, y, mid[2] + 0.5]));
      out.shots.push(await shot(`${tag}_deck`, [x - 1.5, y + 2.6, z + 1], [q.to[0] + 0.5, y + 1.2, z + 1]));
      // the close-up (the coordinator's ask): the rail on its bed, the two walk lanes and the far landing, from just outside the bed
      out.shots.push(await shot(`${tag}_closeup`, [q.to[0] + 3.5, y + 3.5, z + 5.5], [q.to[0] - 2.5, y + 0.5, z + 1.5]));
      out.shots.push(await shot(`${tag}_side`, [mid[0] + 0.5, y + 4, mid[2] + 22.5], [mid[0] + 0.5, y + 1, mid[2] - 0.5]));
      if (tag === 'default') {
        await cmd('/time set 6000');
        out.shots.push(await shot(`${tag}_day`, [mid[0] + 12.5, y + 6, mid[2] + 16.5], [mid[0] + 0.5, y, mid[2] + 0.5]));
      }
    }
    await call('dev.release', {}).catch(() => null);
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 300, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const rm = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000).catch((e) => ({ error: String(e?.message ?? e) }));
    out.bibles[tag].remove = { removed: rm.removed ?? null, error: rm.error ?? null };
    await leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'ingame', 'survival', 'pin', 'natural', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-CW (catwalks)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7acw.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(L.fails() ? 1 : 0);
