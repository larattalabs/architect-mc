#!/usr/bin/env node
// Slice CH gate (a compose never hangs on a design from another world; docs/CONTRACT.md "Slice CH as built") against the headless server
// of the CH run worktree (GATE6B_RUN, default `../architect-mc-CH-run`; the sim sidecar, no Claude). Ports 8922 (sidecar) / 8923
// (DevBridge) by default. $0: no Claude call anywhere (the sim stand-in pick and scripted rounds).
//
//   node tools/gate7cch.mjs <step>
//     compose  (ch-compose)  in game (headless, the flat base): Regions.compose (dev.region.compose) with FIXED opKeys (a reused run dir's
//                            sidecar data adopts the last run's designs, which this process never heard of: the case CP's gate hit), in
//                            world A: (a) a brief a template fits, PICKED and planned; (b) a scripted brief, COMPOSED. Then a fresh world B
//                            from the same base: the same keys adopt the same designs (no new design, $0), each answered within a bounded
//                            wait (never the 30 min the old hang took): (a') PICKED, planned again in world B (a new planId); (b') COMPOSED,
//                            the same artifact
//     report                 REPORT.md over the step JSON
//
// Evidence: the runner's out dir (GATE7CCH_OUT), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CH-run');
process.env.GATE6B_OUT = process.env.GATE7CCH_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-ch');
process.env.GATE6B_SIDECAR_PORT ??= '8922';
process.env.GATE6B_DEV_PORT ??= '8923';
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CH is $0: sim only, no Claude call (the sim stand-in pick and scripted rounds)' }, null, 2)}\n`);
}

const CLAIM = [0, 0, 159, 159];
const lots = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, type: 'house', size: [9, 9] }));
/** One scripted round, READY at once (CO's repaired plan): the path from the claim's south edge. */
const GOOD = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 8 } } }], connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }] };
const SCRIPT = { 'architect:simCompose': [{ plan: GOOD, reason: 'round 1 (scripted)' }] };
/** A compose in world B answers within this (the adopted record's own bound is 30 s; the old hang ran to the hook's 30 min). */
const BOUND_MS = 180_000;

async function compose(tag, b, over = {}, timeout = 1_800_000) {
  const t0 = Date.now();
  const d = await call('dev.region.compose', { brief: b, claim: CLAIM, wait: true, ...over }, timeout);
  const r = d.result ?? {};
  const ms = Date.now() - t0;
  log(`  ${tag}: ${d.designId ?? d.id} ${d.status} ${d.kind} ${r.outcome} rounds ${r.rounds} plan ${r.planId ?? r.planError ?? '-'} ${d.error ?? d.refused ?? ''} $${(d.costUsd ?? 0).toFixed(4)} in ${(ms / 1000).toFixed(1)} s`);
  return { d, r, ms, id: d.designId ?? d.id };
}
async function world(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await cmd(`/forceload add ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`);
  await L.tp(80, 0, 80);
  await L.settle(3000);
}

steps.compose = async () => {
  await ensure();
  spendZero();
  const out = {};
  // world A: fixed keys (a reused run dir adopts the last run's: answered as any adoption must be)
  await world('G6B CH World A');
  const a = await compose('a (world A)', 'a flat village with a well', { opKey: 'gate.ch.pick' });
  const b = await compose('b (world A)', 'a few homes beside a winding lane', { images: false, opKey: 'gate.ch.composed', ext: SCRIPT });
  out.a = { id: a.id, status: a.d.status, outcome: a.r.outcome, planId: a.r.planId, planError: a.r.planError, ms: a.ms };
  out.b = { id: b.id, status: b.d.status, outcome: b.r.outcome, artifactSha: b.r.check?.artifactSha, ms: b.ms };
  check(a.d.status === 'DONE' && a.r.outcome === 'PICKED' && !!a.r.planId, `(a) world A: "a flat village with a well" ${a.d.status} ${a.r.outcome}, planned ${a.r.planId ?? a.r.planError}`);
  check(b.d.status === 'DONE' && b.r.outcome === 'COMPOSED', `(b) world A: the scripted brief ${b.d.status} ${b.r.outcome} ${b.d.error ?? ''}`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  // world B, a fresh copy of the same base: the same keys and bodies adopt the designs that ended in world A
  await world('G6B CH World B');
  const a2 = await compose("a' (world B)", 'a flat village with a well', { opKey: 'gate.ch.pick' }, BOUND_MS + 60_000).catch((e) => ({ d: { error: String(e?.message ?? e) }, r: {}, ms: BOUND_MS + 60_000 }));
  const b2 = await compose("b' (world B)", 'a few homes beside a winding lane', { images: false, opKey: 'gate.ch.composed', ext: SCRIPT }, BOUND_MS + 60_000)
    .catch((e) => ({ d: { error: String(e?.message ?? e) }, r: {}, ms: BOUND_MS + 60_000 }));
  out.a2 = { id: a2.id, status: a2.d.status, outcome: a2.r.outcome, planId: a2.r.planId, planError: a2.r.planError, ms: a2.ms, error: a2.d.error };
  out.b2 = { id: b2.id, status: b2.d.status, outcome: b2.r.outcome, artifactSha: b2.r.check?.artifactSha, ms: b2.ms, error: b2.d.error };
  check(a2.id === a.id && b2.id === b.id, `world B adopts the same designs (no new design, $0): ${a2.id} = ${a.id}, ${b2.id} = ${b.id}`);
  check(a2.ms < BOUND_MS && b2.ms < BOUND_MS, `world B answers within ${BOUND_MS / 1000} s (the old hang ran to 30 min): (a') ${(a2.ms / 1000).toFixed(1)} s, (b') ${(b2.ms / 1000).toFixed(1)} s`);
  check(a2.d.status === 'DONE' && a2.r.outcome === 'PICKED' && !!a2.r.planId && a2.r.planId !== a.r.planId,
    `(a') world B: PICKED, planned again in this world (plan ${a2.r.planId ?? a2.r.planError ?? a2.d.error}, world A's ${a.r.planId})`);
  check(b2.d.status === 'DONE' && b2.r.outcome === 'COMPOSED' && !!b2.r.check?.artifactSha && b2.r.check.artifactSha === b.r.check?.artifactSha,
    `(b') world B: COMPOSED, the same artifact (${b2.r.check?.artifactSha?.slice(0, 12) ?? b2.d.error})`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  return out;
};

steps.report = async () => {
  const lines = ['# Slice CH gate', ''];
  const f = path.join(OUT, 'compose.json');
  if (!fs.existsSync(f)) lines.push('- compose: not run');
  else {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    lines.push(`## compose (${j.seconds.toFixed(0)} s, head ${j.head.slice(0, 8)})`, '', ...Object.entries(j.results ?? {}).map(([m, r]) => `- ${r.ok ? 'PASS' : 'FAIL'} ${m}`), '', `\`${json(j.data)}\``);
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { lines: lines.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7cch.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
