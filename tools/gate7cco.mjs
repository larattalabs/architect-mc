#!/usr/bin/env node
// Slice CO gate (7c standalone composer; docs/CONTRACT.md "Phase 7c" §3 row 12, "Slice CO as built") against the headless server of the
// CO run worktree (GATE6B_RUN, default `../architect-mc-CO-run`; the sim sidecar, no Claude). Ports 8918 (sidecar) / 8919 (DevBridge) by
// default. $0: no Claude call anywhere; the composer's rounds are scripted (ext architect:simCompose) or the sim's stand-in, so these
// steps show the mechanism (the pick first, the rounds, the mod's checks, the one repair, the outcomes, the images), not a model's plans.
//
//   node tools/gate7cco.mjs <step>
//     unit     (co-unit)     offline: kit/test/co.test.mjs (the planning images byte-stable and equal to the committed pixel shas, the
//                            affordance ranking, the CLI) and the sidecar's test/compose.test.ts with the real kit (the pure parts, the
//                            system prompt under 120,000, the rounds through the kit's own plan check: COMPOSED after one repair, NO_PLAN,
//                            PICKED, a refused check, images on and off byte-identical, opKey, cancel)
//     compose  (co-compose)  in game (headless, the flat base): Regions.compose through the public API (dev.region.compose) on a 160x160
//                            claim: (a) a brief no template fits, round 1 scripted with a path from an anchor no request has: the mod's
//                            checkPlan answers NEEDS_REPAIR, the repair round's plan READY: COMPOSED; (b) the same with the planning
//                            images on: the same plan bytes, planSha and artifact sha, four image blobs; (c) the composed artifact realised
//                            (realiseApproved), PLACED, removed: the claim's hash restored (E-flat 0); (d) Regions.checkPlan with ext
//                            architect_mc:planImages: four images in preview.planImages, the same pixels twice, the same artifact as
//                            without; (e) a brief a template fits: PICKED flat_village, the mod plans it
//     report                 REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-runs-co/... (the runner's out dir; GATE7CCO_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CO-run');
process.env.GATE6B_OUT = process.env.GATE7CCO_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-co');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FLAT = 'G6B Flat Base';

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
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CO is $0: sim only, no Claude call (the rounds are scripted or the sim stand-in)' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 1_800_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
function vitest(files, timeout = 1_800_000) {
  const r = spawnSync('npx', ['vitest', 'run', ...files], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(t);
  return { code: r.status, pass: m ? Number(m[2]) : -1, fail: m ? Number(m[1] ?? 0) : -1, failing: t.split('\n').filter((l) => /^\s*(×|FAIL)/.test(l)).slice(0, 20) };
}
steps.unit = async () => {
  spendZero();
  const out = {};
  out.kit = nodeTest(['kit/test/co.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 3, `the kit (kit/test/co.test.mjs): the planning images byte-stable and equal to the committed pixel shas, the affordance ranking, the CLI: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.sidecar = vitest(['test/compose.test.ts']);
  check(out.sidecar.code === 0 && out.sidecar.fail === 0 && out.sidecar.pass >= 14, `the sidecar with the real kit (test/compose.test.ts): the rounds through the kit's plan check (COMPOSED after one repair, NO_PLAN, PICKED, a refused check), images on and off byte-identical, the system prompt under 120,000, opKey, cancel: ${out.sidecar.pass} pass, ${out.sidecar.fail} fail`, out.sidecar.failing);
  return out;
};

// ------------------------------------------------------------------ in game

const CLAIM = [0, 0, 159, 159];
const BRIEF = 'a few homes beside a winding lane'; // no catalogue keyword: the sim stand-in pick answers NO_TEMPLATE
const lots = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, type: 'house', size: [9, 9] }));
/** Round 1: the path from an anchor no compose request has (the check answers NEEDS_REPAIR, UNKNOWN_REF). */
const BAD = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 8 } } }], connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'stone' }, to: { part: 'town' } }] };
/** Round 2, the repair: the path from the claim's south edge. */
const GOOD = { ...BAD, connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }] };
const SCRIPT = { 'architect:simCompose': [{ plan: BAD, reason: 'round 1 (scripted)' }, { plan: GOOD, reason: 'round 2 (scripted)' }] };

/** The top ROCK or SOIL cell of column (80, 80), read from a frozen volume of it (Survey.volume). */
async function groundY() {
  const v = await call('dev.survey.volume', { box: [80, -64, 80, 80, 200, 80], load: 'loaded' }, 600_000);
  if (v.refused) throw new Error(`Survey.volume refused: ${v.refused}`);
  const { decodeArvx, VC } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'volume.mjs')).href);
  const d = decodeArvx(fs.readFileSync(path.resolve(L.GAME_DIR, v.file)));
  for (let j = d.height - 1; j >= 0; j--) if ([VC.ROCK, VC.SOIL].includes(d.classes[j])) return d.box.minY + j;
  throw new Error('no ground in column 80,80');
}

async function compose(tag, b, over = {}) {
  const d = await call('dev.region.compose', { brief: b, claim: CLAIM, wait: true, ...over }, 1_800_000);
  const r = d.result ?? {};
  log(`  ${tag}: ${d.status} ${d.kind} ${r.outcome} rounds ${r.rounds} ${json(r.history)} ${d.error ?? d.refused ?? ''} $${(d.costUsd ?? 0).toFixed(4)} in ${((d.ms ?? 0) / 1000).toFixed(0)} s`);
  return d;
}

steps.compose = async () => {
  await ensure();
  spendZero();
  const out = {};
  await L.fresh('G6B CO Compose', FLAT);
  await L.setRules('exact');
  await cmd(`/forceload add ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`);
  await L.tp(80, 0, 80);
  await L.settle(3000);
  const g = await groundY();
  out.ground = g;
  // (a) composed, checked NEEDS_REPAIR by the mod, repaired once, READY
  const a = await compose('a', BRIEF, { images: false, opKey: 'gate.co.a', ext: SCRIPT });
  const ra = a.result ?? {};
  out.a = { status: a.status, kind: a.kind, error: a.error, refused: a.refused, outcome: ra.outcome, rounds: ra.rounds, history: ra.history, pick: ra.pick, check: ra.check && { overall: ra.check.overall, planSha: ra.check.planSha, artifactSha: ra.check.artifactSha, parts: (ra.check.parts ?? []).map((p) => `${p.part}:${p.class}`) }, plan: ra.plan };
  check(a.status === 'DONE' && a.kind === 'SETTLEMENT' && ra.pick?.outcome === 'NO_TEMPLATE', `(a) the template pick first: ${ra.pick?.outcome} (closest ${ra.pick?.program}); the design ${a.status} kind ${a.kind}`);
  check(ra.outcome === 'COMPOSED' && ra.rounds === 2 && json((ra.history ?? []).map((h) => h.overall)) === json(['NEEDS_REPAIR', 'READY']),
    `(a) composed, checked by the mod's checkPlan NEEDS_REPAIR (the path from "stone"), repaired once, READY: ${ra.outcome}, ${json(ra.history)}`);
  check(json(ra.plan) === json(GOOD) && typeof ra.check?.artifactSha === 'string', `(a) the result's plan is the repaired one and its check has an artifact (${ra.check?.artifactSha?.slice(0, 12)})`);
  // (b) the same with the images on: the same plan bytes, planSha and artifact; four image blobs
  const b = await compose('b', BRIEF, { images: true, opKey: 'gate.co.b', ext: SCRIPT });
  const rb = b.result ?? {};
  out.b = { status: b.status, outcome: rb.outcome, history: rb.history, images: rb.images, artifactSha: rb.check?.artifactSha };
  check(rb.outcome === 'COMPOSED' && json(rb.plan) === json(ra.plan) && rb.check?.planSha === ra.check?.planSha && rb.check?.artifactSha === ra.check?.artifactSha
    && json((rb.history ?? []).map((h) => h.planSha)) === json((ra.history ?? []).map((h) => h.planSha)),
    `(b) images on and off: the same plans round by round (planShas ${json((rb.history ?? []).map((h) => h.planSha?.slice(0, 8)))}), the same artifact ${rb.check?.artifactSha?.slice(0, 12)}`);
  check(json((rb.images ?? []).map((i) => i.name)) === json(['top', 'section-1', 'section-2', 'iso']) && (rb.images ?? []).every((i) => typeof i.blobId === 'string') && !ra.images,
    `(b) with images on, the four planning images went to the rounds (${json((rb.images ?? []).map((i) => i.name))}); off, none`);
  // (c) the composed artifact realised and removed exactly
  const sha = ra.check?.artifactSha;
  const box = [CLAIM[0] - 8, g - 32, CLAIM[1] - 8, CLAIM[2] + 8, g + 48, CLAIM[3] + 8];
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const rr = await call('dev.region.realiseApproved', { sha }, 300_000);
  check(!!rr.region, `(c) realiseApproved of the composed artifact queued region ${rr.region ?? rr.refused}`);
  if (rr.region) {
    const st = await L.waitRegion(rr.region, 3_600_000);
    const h1 = await call('dev.region.hash', { box }, 3_600_000);
    out.c = { region: rr.region, state: st.view.state, cells: st.view.cellsWritten, changed: h0.sha256 !== h1.sha256 };
    check(st.view.state === 'PLACED' && h0.sha256 !== h1.sha256, `(c) the composed settlement realised: ${st.view.state}, ${st.view.cellsWritten} cells written`);
    await cmd('/kill @e[type=!minecraft:player]');
    const rm = await call('dev.region.remove', { region: rr.region }, 3_600_000);
    await L.settle(3000);
    const h2 = await call('dev.region.hash', { box }, 3_600_000);
    out.c.removed = { removed: rm.removed, restored: rm.restored, same: h0.sha256 === h2.sha256 };
    check(rm.removed && h0.sha256 === h2.sha256, `(c) removed: the claim's hash restored (E-flat 0; ${rm.restored} cells restored)`);
  }
  // (d) checkPlan with the planning images asked for
  const c0 = await call('dev.region.checkPlan', { plan: GOOD, claim: CLAIM }, 900_000);
  const c1 = await call('dev.region.checkPlan', { plan: GOOD, claim: CLAIM, ext: { 'architect_mc:planImages': true } }, 900_000);
  const c2 = await call('dev.region.checkPlan', { plan: GOOD, claim: CLAIM, ext: { 'architect_mc:planImages': true } }, 900_000);
  const pi1 = c1.check?.preview?.planImages, pi2 = c2.check?.preview?.planImages;
  out.d = { without: { overall: c0.check?.overall, artifactSha: c0.check?.artifactSha, planImages: !!c0.check?.preview?.planImages }, with: { overall: c1.check?.overall, artifactSha: c1.check?.artifactSha, images: pi1?.images, error: c1.check?.preview?.planImagesError } };
  check(json((pi1?.images ?? []).map((i) => i.name)) === json(['top', 'section-1', 'section-2', 'iso']) && !c0.check?.preview?.planImages,
    `(d) checkPlan with ext architect_mc:planImages: four images in preview.planImages (${json((pi1?.images ?? []).map((i) => `${i.name} ${i.width}x${i.height}`))}${c1.check?.preview?.planImagesError ? `; error ${c1.check.preview.planImagesError}` : ''}); without the ask, none`);
  check(json((pi1?.images ?? []).map((i) => i.pixelSha)) === json((pi2?.images ?? []).map((i) => i.pixelSha)) && (pi1?.images ?? []).length === 4,
    `(d) the renders byte-stable: the same pixels twice (${json((pi1?.images ?? []).map((i) => i.pixelSha.slice(0, 8)))})`);
  check(c1.check?.artifactSha && c1.check.artifactSha === c0.check?.artifactSha && c1.check.artifactSha === ra.check?.artifactSha,
    `(d) the images change nothing else: the same artifact with and without them, and as compose's (${c1.check?.artifactSha?.slice(0, 12)})`);
  // (e) a brief a template fits: PICKED, the mod plans the pick
  const e = await compose('e', 'a flat village with a well', { opKey: 'gate.co.e' });
  const re = e.result ?? {};
  out.e = { status: e.status, outcome: re.outcome, program: re.program, planId: re.planId, planError: re.planError, rounds: re.rounds };
  check(re.outcome === 'PICKED' && re.program === 'flat_village' && re.rounds === 0 && !!re.planId, `(e) "a flat village with a well": ${re.outcome} ${re.program}, no round; the mod's plan ${re.planId ?? re.planError}`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const lines = ['# Slice CO gate', ''];
  for (const s of ['unit', 'compose']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { lines.push(`- ${s}: not run`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rs = Object.entries(j.results ?? {});
    lines.push(`## ${s} (${j.seconds.toFixed(0)} s, head ${j.head.slice(0, 8)})`, '', ...rs.map(([m, r]) => `- ${r.ok ? 'PASS' : 'FAIL'} ${m}`), '');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { lines: lines.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7cco.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
