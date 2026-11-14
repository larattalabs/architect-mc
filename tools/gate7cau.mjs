#!/usr/bin/env node
// Slice AU gate (7c program authoring; docs/CONTRACT.md "Phase 7c" §3 row 13, "Slice AU as built") against the headless server of the AU
// run worktree (GATE6B_RUN, default `../architect-mc-AU-run`; the sim sidecar, no Claude). Ports 8918 (sidecar) / 8919 (DevBridge) by
// default. $0: no Claude call anywhere; the authoring rounds are scripted (ext architect:simAuthor: the kit's fixture programs), so these
// steps show the mechanism (the rounds, the sandboxed checker, the install, the plan, the realise, the freeze), not a model's programs.
//
//   node tools/gate7cau.mjs <step>
//     unit    (au-unit)    offline: kit/test/au.test.mjs (the lint and its evasions, sha, staging, the plan dispatch: fits, AUTHORED_STALE,
//                          NO_PROGRAM, the artifact's authored member; the author-check CLI) and the sidecar's test/author.test.ts with the
//                          real kit (the rounds: a checker finding then fixed, AUTHORED, NOT_SHOWN; opKey; the sandbox probes: network,
//                          files outside its dir, child processes, signals, priorities, timers)
//     author  (au-author)  in game (headless, the flat base): Regions.authorProgram (dev.region.author) on a 96x96 claim: (a) round 1 a
//                          court floating 14 above the ground: the checker's M3 finding; round 2 fixed: AUTHORED, installed world-local
//                          (the file's sha the result's); (b) a plan naming it {template: authored, params: {id, sha}} checks READY with
//                          the artifact's authored member; a plan naming another sha answers refused AUTHORED_STALE; (c) the artifact
//                          realised, PLACED, removed: the claim's hash restored (E-flat 0); (d) the installed source edited on disk: the
//                          same artifact's realiseApproved refuses AUTHORED_STALE naming the program and writes nothing
//     report               REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-runs-au/... (the runner's out dir; GATE7CAU_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-AU-run');
process.env.GATE6B_OUT = process.env.GATE7CAU_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-au');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;

L.refuseKeys();
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice AU is $0: sim only, no Claude call (the authoring rounds are scripted)' }, null, 2)}\n`);
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
  out.kit = nodeTest(['kit/test/au.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 6, `the kit (kit/test/au.test.mjs): the lint and its evasions, sha, staging, the plan dispatch (fits, AUTHORED_STALE, NO_PROGRAM, the artifact's authored member), the author-check CLI: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  out.sidecar = vitest(['test/author.test.ts']);
  check(out.sidecar.code === 0 && out.sidecar.fail === 0 && out.sidecar.pass >= 11, `the sidecar with the real kit (test/author.test.ts): the rounds (a checker finding then fixed: AUTHORED; NOT_SHOWN), opKey, the sandbox probes (network, files, processes, signals, priorities, timers): ${out.sidecar.pass} pass, ${out.sidecar.fail} fail`, out.sidecar.failing);
  return out;
};

// ------------------------------------------------------------------ in game

const CLAIM = [0, 0, 95, 95];
const FIX = path.join(root, 'kit', 'test', 'fixtures', 'au');
const COURT = fs.readFileSync(path.join(FIX, 'courtyard.mjs'), 'utf8');
const FLOATING = fs.readFileSync(path.join(FIX, 'courtyard_floating.mjs'), 'utf8');
const SCRIPT = { 'architect:simAuthor': [{ source: FLOATING, reason: 'round 1 (scripted): the court floats' }, { source: COURT, reason: 'round 2 (scripted): the court on the ground' }] };
const planOf = (id, sha) => ({ schemaVersion: 'plan/0', zones: [{ id: 'court', required: true, program: { template: 'authored', params: { id, sha, params: { size: 12 } } } }] });

/** The top ROCK or SOIL cell of column (48, 48), read from a frozen volume of it (Survey.volume). */
async function groundY() {
  const v = await call('dev.survey.volume', { box: [48, -64, 48, 48, 200, 48], load: 'loaded' }, 600_000);
  if (v.refused) throw new Error(`Survey.volume refused: ${v.refused}`);
  const { decodeArvx, VC } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'region', 'volume.mjs')).href);
  const d = decodeArvx(fs.readFileSync(path.resolve(L.GAME_DIR, v.file)));
  for (let j = d.height - 1; j >= 0; j--) if ([VC.ROCK, VC.SOIL].includes(d.classes[j])) return d.box.minY + j;
  throw new Error('no ground in column 48,48');
}

steps.author = async () => {
  await ensure();
  spendZero();
  const out = {};
  await L.fresh('G6B AU Author', FLAT);
  await L.setRules('exact');
  await cmd(`/forceload add ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`);
  await L.tp(48, 0, 48);
  await L.settle(3000);
  const g = await groundY();
  out.ground = g;
  // (a) round 1 refused by the checker (M3), round 2 fixed: AUTHORED and installed
  const a = await call('dev.region.author', { brief: 'a paved court with a gatehouse', claim: CLAIM, opKey: 'gate.au.a', ext: SCRIPT, wait: true }, 1_800_000);
  const ra = a.result ?? {};
  log(`  (a) ${a.status} ${a.kind} ${ra.outcome} rounds ${ra.rounds} ${json(ra.history)} ${a.error ?? a.refused ?? ''}`);
  out.a = { designId: a.designId, status: a.status, kind: a.kind, error: a.error, refused: a.refused, outcome: ra.outcome, rounds: ra.rounds, history: ra.history, sha: ra.sha, programId: ra.programId };
  check(a.status === 'DONE' && a.kind === 'PROGRAM' && ra.outcome === 'AUTHORED' && ra.programId === a.designId, `(a) authorProgram: design ${a.designId} ${a.status} kind ${a.kind}: ${ra.outcome} (program id ${ra.programId})`);
  check(ra.rounds === 2 && json((ra.history ?? []).map((h) => h.findings)) === json([1, 0]) && (ra.history ?? [])[0]?.sha === sha256(FLOATING) && ra.sha === sha256(COURT),
    `(a) round 1 failed on a checker finding (the floating court), round 2 fixed and clean: ${json(ra.history)}`);
  const store = await call('dev.au.store', {}, 30_000);
  const file = path.join(store.dir, `${a.designId}.mjs`);
  const installed = fs.existsSync(file) ? fs.readFileSync(file) : null;
  out.a.store = store.dir;
  check(!!installed && sha256(installed) === ra.sha && fs.existsSync(path.join(store.dir, `${a.designId}.json`)), `(a) installed world-local (${path.relative(L.GAME_DIR, file)}), its bytes hash to the result's sha ${String(ra.sha).slice(0, 12)}`);
  const again = await call('dev.region.author', { brief: 'a paved court with a gatehouse', claim: CLAIM, opKey: 'gate.au.a', ext: SCRIPT, wait: true }, 1_800_000);
  check(again.designId === a.designId, `(a) the same key and body adopt the first design (${again.designId})`);
  // (b) a plan naming it checks READY, its artifact freezing {part, id, sha}; another sha answers AUTHORED_STALE
  const c0 = await call('dev.region.checkPlan', { plan: planOf(a.designId, ra.sha), claim: CLAIM }, 900_000);
  const art = c0.check?.artifactSha ? await call('dev.region.artifact', { sha: c0.check.artifactSha, body: true }, 60_000).catch((e) => ({ error: String(e) })) : null;
  const frozen = art?.body?.authored ?? art?.artifact?.body?.authored ?? null;
  out.b = { overall: c0.check?.overall, artifactSha: c0.check?.artifactSha, parts: (c0.check?.parts ?? []).map((p) => `${p.part}:${p.class}`), authored: frozen, refused: c0.refused };
  check(c0.check?.overall === 'READY' && json(out.b.parts) === json(['court:fits']) && !!c0.check?.artifactSha, `(b) a plan naming {template: authored, params: {id ${a.designId}, sha}} checks ${c0.check?.overall ?? c0.refused} (${json(out.b.parts)}), artifact ${c0.check?.artifactSha?.slice(0, 12)}`);
  check(json(frozen) === json([{ part: 'court', id: a.designId, sha: ra.sha }]), `(b) the artifact freezes the source by sha: ${json(frozen)}`);
  const cs = await call('dev.region.checkPlan', { plan: planOf(a.designId, '0'.repeat(64)), claim: CLAIM }, 900_000);
  const sp = (cs.check?.parts ?? []).find((p) => p.part === 'court');
  out.b.stalePlan = { overall: cs.check?.overall, part: sp && { class: sp.class, code: sp.reasons?.[0]?.code } };
  check(sp?.class === 'refused' && sp.reasons?.[0]?.code === 'AUTHORED_STALE', `(b) a plan naming another sha: the zone ${sp?.class} ${sp?.reasons?.[0]?.code} (${String(sp?.reasons?.[0]?.message ?? '').slice(0, 100)})`);
  // (c) realised and removed exactly
  const sha = c0.check?.artifactSha;
  const box = [CLAIM[0] - 8, g - 32, CLAIM[1] - 8, CLAIM[2] + 8, g + 48, CLAIM[3] + 8];
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const rr = await call('dev.region.realiseApproved', { sha }, 300_000);
  check(!!rr.region, `(c) realiseApproved of the authored plan's artifact queued region ${rr.region ?? rr.refused}`);
  if (rr.region) {
    const st = await L.waitRegion(rr.region, 3_600_000);
    const h1 = await call('dev.region.hash', { box }, 3_600_000);
    out.c = { region: rr.region, state: st.view.state, cells: st.view.cellsWritten, changed: h0.sha256 !== h1.sha256 };
    check(st.view.state === 'PLACED' && h0.sha256 !== h1.sha256, `(c) the authored program's region realised: ${st.view.state}, ${st.view.cellsWritten} cells written`);
    await cmd('/kill @e[type=!minecraft:player]');
    const rm = await call('dev.region.remove', { region: rr.region }, 3_600_000);
    await L.settle(3000);
    const h2 = await call('dev.region.hash', { box }, 3_600_000);
    out.c.removed = { removed: rm.removed, restored: rm.restored, same: h0.sha256 === h2.sha256 };
    check(rm.removed && h0.sha256 === h2.sha256, `(c) removed: the claim's hash restored (E-flat 0; ${rm.restored} cells restored)`);
  }
  // (d) the installed source edited on disk: the same artifact's replay refuses AUTHORED_STALE and writes nothing
  if (installed) fs.appendFileSync(file, '\n// edited after approval\n');
  const h3 = await call('dev.region.hash', { box }, 3_600_000);
  const rs = await call('dev.region.realiseApproved', { sha }, 300_000);
  const h4 = await call('dev.region.hash', { box }, 3_600_000);
  out.d = { refused: rs.refused, region: rs.region, unchanged: h3.sha256 === h4.sha256 };
  check(!rs.region && /AUTHORED_STALE/.test(String(rs.refused)) && String(rs.refused).includes(a.designId) && h3.sha256 === h4.sha256,
    `(d) after the source file was edited, the replay refuses: ${String(rs.refused).slice(0, 160)}; nothing written`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const lines = ['# Slice AU gate', ''];
  for (const s of ['unit', 'author']) {
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
  console.error(`usage: node tools/gate7cau.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
