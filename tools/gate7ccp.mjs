#!/usr/bin/env node
// Slice CP gate (7c compose follow-ups for Steward's Composer; docs/CONTRACT.md "Slice CP") against the headless server of the CP run
// worktree (GATE6B_RUN, default `../architect-mc-CP-run`; the sim sidecar, no Claude). Ports 8922 (sidecar) / 8923 (DevBridge) by default.
// $0: no Claude call anywhere; the rounds are scripted (ext architect:simCompose) or the sim's stand-in.
//
//   node tools/gate7ccp.mjs <step>
//     unit     (cp-unit)     offline: the sidecar's test/compose.test.ts "7c CP" cases with the real kit (skipPick counted, the ext keys, the
//                            families block under 120,000 with the largest rules, the street fix ported from Steward's and idempotent, the
//                            player words, the street round, an invented family refused and repaired, owner and dimension in the record)
//     compose  (cp-compose)  in game (headless, the flat base): Regions.compose through the public API (dev.region.compose):
//                            (a) skipPick on a brief a template fits: no REGION pick design (counted), COMPOSED from the rounds; without
//                            the key PICKED flat_village; (b) regions are Overworld only: a Nether compose with an owner
//                            ends NO_PLAN at once ($0, no pick or round) with NOT_ALLOWED and a player-worded summary; an Overworld compose
//                            with an owner records it (the design's, the artifact's check); (c) a grid zone refused
//                            NO_ROOM with a street wouldFit: a free street round, then READY; (d) composeVocab families: an invented family
//                            refused by the check (NO_FEATURE) and repaired; (e) NO_PLAN: the best round's summary, waits[].say, the reason
//                            unchanged
//     report                 REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-runs-cp/... (the runner's out dir; GATE7CCP_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CP-run');
process.env.GATE6B_OUT = process.env.GATE7CCP_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-cp');
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CP is $0: sim only, no Claude call (the rounds are scripted or the sim stand-in)' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

steps.unit = async () => {
  spendZero();
  const r = spawnSync('npx', ['vitest', 'run', 'test/compose.test.ts', '-t', '7c CP'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 1_800_000 });
  const t = `${r.stdout}${r.stderr}`;
  const m = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(t);
  const out = { code: r.status, pass: m ? Number(m[2]) : -1, fail: m ? Number(m[1] ?? 0) : -1, failing: t.split('\n').filter((l) => /^\s*(×|FAIL)/.test(l)).slice(0, 20) };
  check(out.code === 0 && out.fail === 0 && out.pass >= 7, `the sidecar's "7c CP" cases with the real kit (test/compose.test.ts): skipPick, the ext keys, the families under 120,000, the street fix and its idempotence, the player words, the street round, an invented family repaired, owner and dimension: ${out.pass} pass, ${out.fail} fail`, out.failing);
  return out;
};

// ------------------------------------------------------------------ in game

const CLAIM = [0, 0, 159, 159];
/** The Nether claim: a 48x48 platform the step clears (netherrack to y 63, air above to the roof). */
const NCLAIM = [1000, 1000, 1047, 1047];
const NETHER = 'minecraft:the_nether';
const lots = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, type: 'house', size: [9, 9] }));
const BAD = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, program: { lots: lots(3) }, where: { near: { anchor: 'claim_center', within: 8 } } }], connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'stone' }, to: { part: 'town' } }] };
const GOOD = { ...BAD, connectors: [{ id: 'lane', kind: 'path', from: { anchor: 'claim_s' }, to: { part: 'town' } }] };
const GRID = { schemaVersion: 'plan/0', zones: [{ id: 'town', required: true, size: { w: 30, d: 90 }, program: { layout: 'grid', lots: Array.from({ length: 3 }, (_, i) => ({ id: `cottage_${i + 1}`, type: 'cottage', size: [13, 14] })) } }] };
const palette = (family) => ({ ...GOOD, rules: [{ id: 'palette_1', kind: 'palette', family, share: [0, 1] }] });

// (the run dir's sidecar data outlives a run, so a fixed opKey would adopt the last run's finished design, which the new world never hears of)
const NONCE = Date.now().toString(36);
async function compose(tag, b, over = {}) {
  const o = over.opKey ? { ...over, opKey: `${over.opKey}.${NONCE}` } : over;
  const d = await call('dev.region.compose', { brief: b, claim: CLAIM, wait: true, ...o }, 1_800_000);
  const r = d.result ?? {};
  log(`  ${tag}: ${d.status} ${d.kind} ${r.outcome} rounds ${r.rounds} ${json(r.history)} owner ${d.owner ?? '-'} ${d.error ?? d.refused ?? ''} $${(d.costUsd ?? 0).toFixed(4)} in ${((d.ms ?? 0) / 1000).toFixed(0)} s`);
  return d;
}
const kinds = async () => (await call('dev.region.designKinds', {}, 30_000)).kinds ?? {};

/** The artifact's meta file (`<sha>.meta.json`, PlanChecks) under the run's saves: the newest (a reused run dir keeps earlier worlds). */
function artifactMeta(sha) {
  const want = `${sha}.meta.json`;
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 8) return;
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === want) hits.push(p);
      else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(path.join(L.GAME_DIR, 'saves'), 0);
  const f = hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

steps.compose = async () => {
  await ensure();
  spendZero();
  const out = {};
  await L.fresh('G6B CP Compose', FLAT);
  await L.setRules('exact');
  await cmd(`/forceload add ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`);
  await L.tp(80, 0, 80);
  await L.settle(3000);

  // (a) skipPick: no pick at all; without it, PICKED
  const k0 = await kinds();
  const a = await compose('a', 'a flat village with a well', { opKey: 'gate.cp.a', ext: { 'architect_mc:skipPick': true } });
  const k1 = await kinds();
  const ra = a.result ?? {};
  out.a = { kinds: [k0, k1], outcome: ra.outcome, pick: ra.pick, history: ra.history };
  check((k1.REGION ?? 0) === (k0.REGION ?? 0) && (k1.SETTLEMENT ?? 0) === (k0.SETTLEMENT ?? 0) + 1,
    `(a) skipPick: no REGION pick design asked (REGION ${k0.REGION ?? 0} -> ${k1.REGION ?? 0}; SETTLEMENT ${k0.SETTLEMENT ?? 0} -> ${k1.SETTLEMENT ?? 0})`);
  check(ra.outcome === 'COMPOSED' && json(ra.pick) === json({ outcome: 'SKIPPED', program: null, fits: false }) && ra.rounds >= 1,
    `(a) skipPick on a brief a template fits: ${ra.outcome} from ${ra.rounds} round(s), pick ${json(ra.pick)}`);
  const a2 = await compose('a2', 'a flat village with a well', { opKey: 'gate.cp.a2' });
  const k2 = await kinds();
  out.a.without = { outcome: a2.result?.outcome, program: a2.result?.program, kinds: k2 };
  check(a2.result?.outcome === 'PICKED' && a2.result?.program === 'flat_village' && (k2.REGION ?? 0) === (k1.REGION ?? 0) + 1,
    `(a) without the key: the pick first, ${a2.result?.outcome} ${a2.result?.program} (REGION ${k1.REGION ?? 0} -> ${k2.REGION ?? 0})`);

  // (b) regions are Overworld only: a Nether compose with an owner ends NO_PLAN at once ($0, no round), in player words; the owner is
  // recorded on an Overworld compose (the design's, the composed artifact's check)
  const [x0, z0, x1, z1] = NCLAIM;
  const inN = (c) => cmd(`/execute in ${NETHER} run ${c}`);
  await inN(`forceload add ${x0} ${z0} ${x1} ${z1}`);
  await L.settle(3000);
  const k3 = await kinds();
  const b = await compose('b', 'a few homes beside a winding lane', { claim: NCLAIM, dimension: NETHER, owner: 'gate:cp', opKey: 'gate.cp.b' });
  const k4 = await kinds();
  const rb = b.result ?? {};
  out.b = { status: b.status, outcome: rb.outcome, refused: rb.refused, summary: rb.summary, rounds: rb.rounds, owner: b.owner, kinds: [k3, k4] };
  check(b.status === 'DONE' && rb.outcome === 'NO_PLAN' && rb.refused === 'NOT_ALLOWED: regions are Overworld only in this version' && rb.rounds === 0
    && (k4.REGION ?? 0) === (k3.REGION ?? 0) && b.owner === 'gate:cp',
    `(b) a Nether compose with an owner: ${b.status} ${rb.outcome}, refused "${rb.refused}", ${rb.rounds} round(s), no pick (REGION ${k3.REGION ?? 0} -> ${k4.REGION ?? 0}); the design's owner ${b.owner}`);
  check(rb.summary === 'regions can only be built in the Overworld for now', `(b) its summary in player words: "${rb.summary}"`);
  await inN(`forceload remove ${x0} ${z0} ${x1} ${z1}`).catch(() => {});
  const b2 = await compose('b2', 'a few homes beside a winding lane', { owner: 'gate:cp', opKey: 'gate.cp.b2', ext: { 'architect_mc:skipPick': true } });
  const rb2 = b2.result ?? {};
  const sha = rb2.check?.artifactSha;
  const meta = sha ? artifactMeta(sha) : null;
  out.b.overworld = { status: b2.status, outcome: rb2.outcome, owner: b2.owner, artifactSha: sha, meta };
  check(b2.status === 'DONE' && rb2.outcome === 'COMPOSED' && b2.owner === 'gate:cp' && meta?.owner === 'gate:cp'
    && (meta?.dimension ?? 'minecraft:overworld') === 'minecraft:overworld',
    `(b) an Overworld compose with an owner: ${b2.status} ${rb2.outcome}; the design's owner ${b2.owner}, the artifact (${sha?.slice(0, 12)}) checked in ${meta?.dimension} with owner ${meta?.owner}`);

  // (c) the $0 street round
  const c = await compose('c', 'three cottages', { opKey: 'gate.cp.c', ext: { 'architect_mc:skipPick': true, 'architect:simCompose': [{ plan: GRID, reason: 'three cottages in a grid' }] } });
  const rc = c.result ?? {};
  out.c = { outcome: rc.outcome, history: rc.history, layout: rc.plan?.zones?.[0]?.program?.layout, summary: rc.summary, leftOut: rc.leftOut };
  check(rc.outcome === 'COMPOSED' && rc.rounds === 2 && rc.history?.[0]?.free === undefined && rc.history?.[1]?.free === 'street' && rc.history?.[1]?.overall === 'READY'
    && rc.history?.[0]?.overall !== 'READY', `(c) the grid zone refused, then a free street round checked READY: ${json(rc.history)}`);
  check(out.c.layout === 'street' && rc.summary === 'three cottages in a grid' && json(rc.leftOut) === '[]', `(c) the plan's zone is street; summary "${rc.summary}"; leftOut ${json(rc.leftOut)}`);

  // (d) composeVocab families: an invented family refused by the check and repaired
  const dk = await call('dev.region.checkPlan', { plan: palette('glitterwood'), claim: CLAIM }, 900_000);
  const pp = (dk.check?.parts ?? []).find((p) => p.part === 'palette_1');
  check(pp?.class === 'refused' && pp?.reasons?.[0]?.code === 'NO_FEATURE', `(d) the check refuses an invented family: palette_1 ${pp?.class} ${pp?.reasons?.[0]?.code}`);
  const d = await compose('d', 'a few homes beside a winding lane', { opKey: 'gate.cp.d', ext: { 'architect_mc:skipPick': true, 'architect_mc:composeVocab': 'families', 'architect:simCompose': [{ plan: palette('glitterwood'), reason: 'r1' }, { plan: palette('oak'), reason: 'r2' }] } });
  const rd = d.result ?? {};
  out.d = { outcome: rd.outcome, history: rd.history, family: rd.plan?.rules?.[0]?.family, summary: rd.summary };
  check(rd.outcome === 'COMPOSED' && json((rd.history ?? []).map((h) => h.overall)) === json(['NEEDS_REPAIR', 'READY']) && out.d.family === 'oak',
    `(d) composeVocab families: round 1's invented family repaired, ${rd.outcome} ${json(rd.history)}, family ${out.d.family}`);

  // (e) NO_PLAN in player words
  const e = await compose('e', 'a few homes beside a winding lane', { opKey: 'gate.cp.e', ext: { 'architect_mc:skipPick': true, 'architect:simCompose': [{ plan: BAD, reason: 'three homes and a lane from the stone' }] } });
  const re = e.result ?? {};
  out.e = { outcome: re.outcome, reason: re.reason, summary: re.summary, waits: re.waits };
  check(re.outcome === 'NO_PLAN' && re.summary === 'three homes and a lane from the stone' && /^no round's plan checked READY; the best is round /.test(String(re.reason))
    && json((re.waits ?? []).map((w) => w.say)) === json(["lane couldn't be read"]), `(e) NO_PLAN: summary "${re.summary}", waits ${json((re.waits ?? []).map((w) => w.say))}, reason unchanged "${re.reason}"`);
  await cmd(`/forceload remove ${CLAIM[0]} ${CLAIM[1]} ${CLAIM[2]} ${CLAIM[3]}`).catch(() => {});
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const lines = ['# Slice CP gate', ''];
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
  console.error(`usage: node tools/gate7ccp.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
