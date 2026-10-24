#!/usr/bin/env node
// Phase 6c close-out A gate (docs/CONTRACT.md "Phase 6c close-out A" §11, with §14 "Changes from Steward's review") against the headless
// server of the run worktree (GATE6B_RUN, default `../architect-mc-coA-run`, a detached worktree at this checkout's HEAD; the sim sidecar,
// no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6ccoa.mjs <step>
//     start [world] | stop | base       the headless server and the base worlds (the flat creative base, RS's survival flat base)
//     unit      (coa-unit)              offline: the kit's close-out A tests (items 4, 5, 7, 9), the asks tables (item 6), byte identity
//                                       (item 10), the mod's PlanRetentionTest and RegionWaitTagsTest (items 2, 3, 8), the sidecar's
//                                       region.plan.discard test (item 3), api-compat (item 11)
//     keys      (items 1, 2)            creative: the same key after ARTIFACT_STALE, keyed pins ending at the key's realise, a restart
//     discard   (item 3)                creative: discardPlan (files, helper dir, artifacts, refusals, the keyed tombstone), the last-use sweep
//     waits     (item 8, S-COA-5)       survival: Steward's RC flow (a stale retry under one key, keyed pins, an abandoned check discarded,
//                                       the waits said from waitsFor.say, tile and road waits matched by region and part)
//     drift     (Steward's RC finding 1) survival: a stale retry under one key, rs02 built through its later stages with no hold
//     palette   (item 5 in game)        creative: an `over: "lots"` plan, READY; realiseApproved with an off-family lot refuses PALETTE
//     ingame    (coa-ingame)            keys, discard, waits, palette
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-coa/<step>.json in the main checkout (GATE6CCOA_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-coA-run');
process.env.GATE6B_OUT = process.env.GATE6CCOA_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-coa');
process.env.GATE6B_SIDECAR_PORT ??= '8898';
process.env.GATE6B_DEV_PORT ??= '8899';
process.env.GATE6B_CLIENT_SCRIPT ??= 'tools/run-headless-server.mjs';
process.env.HEADLESS_SIDECAR ??= 'sim';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, log, results, root, state, startClient, stopClient, sleep, tp } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const OWNER = 'test:coa';
const FLAT = 'G6B Flat Base';
const planDir = (planId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'close-out A is $0: sim only, no Claude call' }, null, 2)}\n`);
}
async function api(args) {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
  return JSON.parse(line);
}

// ------------------------------------------------------------------ the server and the worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  if (!fs.existsSync(L.RUN)) execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', L.RUN, head]);
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B COA Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  await G.survivalBase(ctx);
  spendZero();
  return { worlds: [FLAT, G.SURV] };
};

// ------------------------------------------------------------------ offline: items 2-11's unit halves

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}

steps.unit = async () => {
  const out = {};
  const U = await import('./lib/gate6ccoa-kit.mjs');
  Object.assign(out, await U.unit(root, { check, log, OUT, nodeTest }));
  // items 2, 3, 8 (mod)
  out.java = await javaTests(['*PlanRetentionTest*', '*RegionWaitTagsTest*', '*RealiseKeyTest*', '*ApiRulesTest*'], 13);
  check(out.java.ok, `items 1, 2, 3, 8 (mod): RealiseKeyTest (the key rule: a stale retry under the same key, a standing region holds it, an undo frees it), PlanRetentionTest (the last-use sweep: a keyed plan touched at day 29 survives day 35, an untouched one goes; 7 days unkeyed, 30 keyed; a pinned artifact holds its plan; keyed pins end at the key's realise and 30 days after their last use; an old pins file), RegionWaitTagsTest (a tile's plan parts, the tags, the sentence), ApiRulesTest (the features): ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  // item 3 (sidecar)
  const s = spawnSync('npx', ['vitest', 'run', 'test/regions-discard.test.ts'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 600_000 });
  const st = `${s.stdout}${s.stderr}`;
  out.sidecar = (/Tests\s+[^\n]+/.exec(st) ?? ['?'])[0];
  check(s.status === 0 && /Tests\s+\d+ passed/.test(st), `item 3 (sidecar): region.plan.discard removes a plan's dir, answers existed false after, the feature is advertised: ${out.sidecar}`);
  // item 11: api-compat against the 0.41.0, 0.40.1 and 0.40.0 apitest jars
  const env = { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  const a = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6ccoa'], { cwd: root, encoding: 'utf8', timeout: 1_800_000, env });
  out.apicompat = `${a.stdout}${a.stderr}`.trim().split('\n').slice(-6);
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), `${a.stdout}${a.stderr}`);
  check(a.status === 0, `item 11: api-compat clean (${out.apicompat.at(-1)})`, out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ creative: the plan, its check, a planned tile

const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8')).fixture.claim;
const lots = (n, p = 'h') => Array.from({ length: n }, (_, i) => ({ id: `${p}${i + 1}`, type: i % 2 ? 'house' : 'cottage', size: [9, 9] }));
const PLAN = (planId, n = 4) => ({ schemaVersion: 'plan/0', planId, zones: [{ id: 'town', required: true, label: 'the town', program: { lots: lots(n) }, where: { near: { anchor: 'stone', within: 16 } } }],
  connectors: [{ id: 'lane', kind: 'path', label: 'the lane', from: { anchor: 'claim_s' }, to: { part: 'town' } }] });
const centre = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1];

async function checkPlan(plan, claim, extra = {}) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, ...extra }, 900_000);
  if (r.refused) throw new Error(`checkPlan refused: ${r.refused}`);
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'}`);
  return r.check;
}
async function groundAt(pdir, x, z) {
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(path.join(pdir, 'survey.bin')));
  return c.ground[Math.floor((x - c.minX) / c.resolution) + Math.floor((z - c.minZ) / c.resolution) * c.width];
}
const waitPlaced = (region) => L.waitRegion(region, 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
const art = (sha) => call('dev.coa.artifact', { sha });

async function creativeWorld(tag) {
  await L.ensureBase(FLAT);
  await L.fresh(`G6B COA ${tag}`, FLAT);
  await L.setRules('exact');
  const [cx, cz] = centre(S7);
  await tp(cx, 0, cz);
  return { claim: [...S7], anchors: { stone: [cx, -60, cz] }, world: `G6B COA ${tag}` };
}

// ------------------------------------------------------------------ items 1 and 2: the same key after ARTIFACT_STALE, keyed pins

steps.keys = async () => {
  await ensure();
  const out = {};
  const W = await creativeWorld('Keys');
  const K = `steward.coa.${Date.now().toString(36)}.vrealise`;
  const a = await checkPlan(PLAN('gate_coa_keys'), W.claim, { anchors: W.anchors });
  check(a.overall === 'READY' && !!a.artifactSha, `items 1, 2: the plan checks READY (${a.overall}, artifact ${a.artifactSha?.slice(0, 12)})`);
  // Steward's pins: keyed under the realise key, plus a plain pin on A so A survives to show the key conflict
  await call('dev.coa.pinKeyed', { sha: a.artifactSha, owner: OWNER, opKey: K });
  await call('dev.region.pinArtifact', { sha: a.artifactSha, owner: OWNER, on: true });
  // the land changes under a planned tile: the realise under K refuses ARTIFACT_STALE and binds nothing
  const town = a.parts.find((p) => p.part === 'town').geometry;
  const [zx, zz] = [(town.rect[0] + town.rect[2]) >> 1, (town.rect[1] + town.rect[3]) >> 1];
  const gy = await groundAt(planDir(a.checkId), zx, zz);
  await cmd(`/setblock ${zx} ${gy + 1} ${zz} minecraft:stone`);
  const s1 = await call('dev.region.realiseApproved', { sha: a.artifactSha, opKey: K }, 300_000);
  const k1 = await call('dev.region.realiseByKey', { owner: OWNER, opKey: K });
  out.stale = { reason: s1.reason, refused: s1.refused?.slice(0, 200), byKey: k1.region ?? null };
  check(s1.reason === 'ARTIFACT_STALE' && !k1.region, `item 1: realiseApproved(A, k) after a block changed in a planned tile: ARTIFACT_STALE; realiseByKey(k) empty (nothing bound) (${s1.refused?.slice(0, 120)})`);
  // re-check (unkeyed, as Steward does): another artifact; pinned under the same key
  const b = await checkPlan(PLAN('gate_coa_keys'), W.claim, { anchors: W.anchors });
  check(!!b.artifactSha && b.artifactSha !== a.artifactSha, `item 1: the re-check answers another artifact B (${b.artifactSha?.slice(0, 12)})`);
  await call('dev.coa.pinKeyed', { sha: b.artifactSha, owner: OWNER, opKey: K });
  const pa = await art(a.artifactSha), pb = await art(b.artifactSha);
  check(pa.pins?.includes(OWNER) && pb.pins?.includes(OWNER), `item 2: A and B pinned (A ${json(pa.pins)}, B ${json(pb.pins)})`);
  const r = await call('dev.region.realiseApproved', { sha: b.artifactSha, opKey: K }, 300_000);
  check(!!r.region, `item 1: realiseApproved(B, k) under the same key realises (${r.region ?? r.refused})`);
  const st = r.region ? await waitPlaced(r.region) : null;
  check(st?.view.state === 'PLACED', `item 1: ${r.region} ${st?.view.state}`);
  // the key's realise ended its keyed pins: B held by its region, A by its plain pin only
  const pa2 = await art(a.artifactSha), pb2 = await art(b.artifactSha);
  out.pins = { a: pa2, b: pb2 };
  check(!pb2.removed && json(pb2.pins) === '[]', `item 2: after the realise under k, B has no pin left and stands (held by its region) (${json(pb2)})`);
  check(!pa2.removed && json(pa2.pins) === json([OWNER]), `item 2: A keeps only its plain pin (${json(pa2)})`);
  const again = await call('dev.region.realiseApproved', { sha: b.artifactSha, opKey: K }, 300_000);
  check(again.region === r.region, `item 1: (B, k) again answers the same region (${again.region ?? again.refused})`);
  const conflict = await call('dev.region.realiseApproved', { sha: a.artifactSha, opKey: K }, 300_000);
  check(conflict.reason === 'OP_KEY_CONFLICT', `item 1: (A, k) after k's realise: OP_KEY_CONFLICT (${conflict.refused?.slice(0, 120)})`);
  await call('dev.region.pinArtifact', { sha: a.artifactSha, owner: OWNER, on: false });
  const pa3 = await art(a.artifactSha);
  check(pa3.removed === true, `item 2: A unpinned with no region goes to its tombstone (${json(pa3)})`);
  // a restart: realiseByKey(k) finds the region
  await L.leaveWorld();
  await L.openWorld(W.world);
  const k2 = await call('dev.region.realiseByKey', { owner: OWNER, opKey: K });
  check(k2.region?.id === r.region, `item 1: after a restart realiseByKey(k) finds ${k2.region?.id ?? 'nothing'}`);
  const rm = await call('dev.region.remove', { region: r.region, requester: OWNER }, 3_600_000);
  check(!!rm.removed, `the region removed (${rm.removed})`);
  // (§14 amendment) an undo frees the key, as since C20: realiseByKey empty, and the same key realises afresh
  const k3 = await call('dev.region.realiseByKey', { owner: OWNER, opKey: K });
  const c = await checkPlan(PLAN('gate_coa_keys'), W.claim, { anchors: W.anchors });
  const r3 = await call('dev.region.realiseApproved', { sha: c.artifactSha, opKey: K }, 300_000);
  out.afterUndo = { byKey: k3.region ?? null, region: r3.region ?? r3.refused };
  check(!k3.region && !!r3.region && r3.region !== r.region, `item 1 (§14): after the undo realiseByKey(k) is empty and the same key realises afresh (${json(out.afterUndo)})`);
  if (r3.region) {
    await waitPlaced(r3.region);
    await call('dev.region.remove', { region: r3.region, requester: OWNER }, 3_600_000);
  }
  return out;
};

// ------------------------------------------------------------------ item 3: discardPlan and the last-use sweep

steps.discard = async () => {
  await ensure();
  const out = {};
  const W = await creativeWorld('Discard');
  const files = (planId) => call('dev.coa.planFiles', { planId });
  // an abandoned check: everything goes
  const c = await checkPlan(PLAN('gate_coa_abandoned', 3), W.claim, { anchors: W.anchors });
  const f0 = await files(c.checkId);
  check(f0.plan && f0.survey && fs.existsSync(planDir(c.checkId)), `item 3: the abandoned check's plan files and helper dir exist (${json(f0)})`);
  const d1 = await call('dev.coa.discardPlan', { planId: c.checkId });
  await sleep(2000);
  const f1 = await files(c.checkId);
  const ac = await art(c.artifactSha);
  out.abandoned = { d1, f1, artifact: ac, helperDir: fs.existsSync(planDir(c.checkId)) };
  check(d1.discarded === true && !f1.plan && !f1.survey && f1.discarded && !f1.pending && !fs.existsSync(planDir(c.checkId)) && ac.removed === true,
    `item 3: discardPlan(${c.checkId}) true: the mod's files gone, its tombstone, the helper's dir gone (sent, nothing pending), its unpinned artifact tombstoned (${json({ files: f1, removed: ac.removed })})`);
  const d2 = await call('dev.coa.discardPlan', { planId: c.checkId });
  check(d2.discarded === false, `item 3: a second discard answers false (${json(d2)})`);
  // refusals: pinned, realised
  const p = await checkPlan(PLAN('gate_coa_pinned', 2), W.claim, { anchors: W.anchors });
  await call('dev.region.pinArtifact', { sha: p.artifactSha, owner: OWNER, on: true });
  const dp = await call('dev.coa.discardPlan', { planId: p.checkId });
  check(dp.reason === 'OVERLAP_BUSY' && dp.detail === 'pinned', `item 3: a plan whose artifact is pinned: OVERLAP_BUSY {pinned} (${json(dp)})`);
  const r = await call('dev.region.realiseApproved', { sha: p.artifactSha }, 300_000);
  if (r.region) await waitPlaced(r.region);
  await call('dev.region.pinArtifact', { sha: p.artifactSha, owner: OWNER, on: false });
  const dr = await call('dev.coa.discardPlan', { planId: p.checkId });
  check(dr.reason === 'OVERLAP_BUSY' && dr.detail === 'realised', `item 3: a realised plan: OVERLAP_BUSY {realised} (${json(dr)})`);
  if (r.region) await call('dev.region.remove', { region: r.region, requester: OWNER }, 3_600_000);
  // a keyed plan discarded: the same key and body refuses PLAN_STALE {discarded}; planByKey empty
  const PK = `steward.coa.${Date.now().toString(36)}.dplan`;
  const params = { lots: lots(2, 'd') };
  const pk = await call('dev.region.plan', { program: 'flat_village', params, claim: W.claim, owner: OWNER, opKey: PK, check: false }, 900_000);
  check(!!pk.planId, `item 3: a keyed plan (${pk.planId ?? pk.refused})`);
  const dk = await call('dev.coa.discardPlan', { planId: pk.planId });
  const again = await call('dev.region.plan', { program: 'flat_village', params, claim: W.claim, owner: OWNER, opKey: PK, check: false }, 900_000);
  const by = await call('dev.coa.planByKey', { owner: OWNER, opKey: PK });
  out.keyed = { dk, again: again.refused ?? again.planId, byKey: by.planId };
  check(dk.discarded === true && /PLAN_STALE/.test(again.refused ?? '') && /discarded/.test(again.refused ?? '') && by.planId === null,
    `item 3: the same key and body after a discard: PLAN_STALE {discarded}, never planned again; planByKey empty (${json(out.keyed)})`);
  // the sweep, from the last use (§14): unkeyed 7 days, keyed 30; a keyed plan touched at day 29 survives day 35
  const KA = `steward.coa.${Date.now().toString(36)}.touched`, KB = `steward.coa.${Date.now().toString(36)}.idle`;
  const u = await checkPlan(PLAN('gate_coa_unkeyed', 2), W.claim, { anchors: W.anchors });
  const ka = await call('dev.region.plan', { program: 'flat_village', params: { lots: lots(2, 'a') }, claim: W.claim, owner: OWNER, opKey: KA, check: false }, 900_000);
  const kb = await call('dev.region.plan', { program: 'flat_village', params: { lots: lots(2, 'b') }, claim: W.claim, owner: OWNER, opKey: KB, check: false }, 900_000);
  const PA = `steward.coa.${Date.now().toString(36)}.pin.touched`, PB = `steward.coa.${Date.now().toString(36)}.pin.idle`;
  const pa = await checkPlan(PLAN('gate_coa_pin_a', 3), W.claim, { anchors: W.anchors });
  const pb = await checkPlan(PLAN('gate_coa_pin_b', 4), W.claim, { anchors: W.anchors });
  await call('dev.coa.pinKeyed', { sha: pa.artifactSha, owner: OWNER, opKey: PA });
  await call('dev.coa.pinKeyed', { sha: pb.artifactSha, owner: OWNER, opKey: PB });
  try {
    await call('dev.coa.clock', { days: 6 });
    const s6 = await call('dev.coa.sweep', {});
    check(!s6.plans.includes(u.checkId), `item 3: day 6: the unkeyed check stays (${json(s6)})`);
    await call('dev.coa.clock', { days: 8 });
    const s8 = await call('dev.coa.sweep', {});
    check(s8.plans.includes(u.checkId) && !s8.plans.includes(ka.planId) && !s8.plans.includes(kb.planId), `item 3: day 8: the unkeyed check is swept, the keyed plans stay (${json(s8.plans)})`);
    await call('dev.coa.clock', { days: 29 });
    const t = await call('dev.coa.planByKey', { owner: OWNER, opKey: KA }); // Steward's world-start lookup
    await call('dev.coa.pinKeyed', { sha: pa.artifactSha, owner: OWNER, opKey: PA }); // and its re-pin
    check(t.planId === ka.planId, `item 3: day 29: the keyed plan looked up by its key (${t.planId})`);
    await call('dev.coa.clock', { days: 35 });
    const s35 = await call('dev.coa.sweep', {});
    const fa = await files(ka.planId), fb = await files(kb.planId);
    const apa = await art(pa.artifactSha), apb = await art(pb.artifactSha);
    out.sweep = { s6, s8, s35, fa, fb, apa, apb };
    check(fa.plan && !fb.plan && fb.discarded, `item 3 (§14): day 35: the keyed plan touched at day 29 survives, the untouched one is swept (${json({ touched: fa.plan, idle: fb.plan })})`);
    check(!apa.removed && apb.removed === true && s35.pinsEnded >= 1, `item 2 (§14): day 35: the keyed pin re-pinned at day 29 holds its artifact, the idle one ended and its artifact tombstoned (${json({ touched: apa, idle: apb, ended: s35.pinsEnded })})`);
  } finally {
    await call('dev.coa.clock', { days: 0 });
  }
  return out;
};

// ------------------------------------------------------------------ item 8 and S-COA-5: Steward's RC flow in survival

steps.waits = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, 'rs06_over_held');
  const s = await G.site(ctx, 'coa_waits', fx);
  // every part labelled, so the waits' sentences show they come from the plan's labels (never an id with underscores)
  for (const fam of ['zones', 'forms', 'connectors', 'rules']) for (const p of s.wp.plan[fam] ?? []) if (p.id && !p.label) p.label = `${p.id.replace(/_/g, ' ')} (plan label)`;
  const VK = `steward.coa.${Date.now().toString(36)}.vrealise`;
  const check1 = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
  const a = check1.check;
  check(!!a?.artifactSha && a.survival === true, `S-COA-5: the plan checks in survival (${a?.overall}, survival ${a?.survival})`);
  await call('dev.coa.pinKeyed', { sha: a.artifactSha, owner: G.OWNER, opKey: VK });
  // an abandoned check of the same build: discarded
  const ab = await call('dev.region.checkPlan', { plan: { ...s.wp.plan, planId: 'coa_abandoned' }, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000);
  const dab = await call('dev.coa.discardPlan', { planId: ab.check.checkId });
  check(dab.discarded === true, `S-COA-5: discardPlan of an abandoned check (${json(dab)})`);
  await G.pile(ctx, s, 4);
  // the land changes under a planned tile while the buildings are designed: stale under VK, re-check, realise under VK again
  const [x0, z0, x1, z1] = s.W.claim;
  const zx = (x0 + x1) >> 1, zz = (z0 + z1) >> 1;
  const gy = await groundAt(planDir(a.checkId), zx, zz);
  await cmd(`/setblock ${zx} ${gy + 1} ${zz} minecraft:cobblestone`);
  const st1 = await call('dev.region.realiseApproved', { sha: a.artifactSha, opKey: VK }, 300_000);
  check(st1.reason === 'ARTIFACT_STALE', `S-COA-5: the realise under k refuses ARTIFACT_STALE (${st1.refused?.slice(0, 120)})`);
  const b = (await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000)).check;
  await call('dev.coa.pinKeyed', { sha: b.artifactSha, owner: G.OWNER, opKey: VK });
  const rr = await call('dev.region.realiseApproved', { sha: b.artifactSha, opKey: VK }, 300_000);
  check(!!rr.region, `S-COA-5: the re-checked artifact realised under the same key (${rr.region ?? rr.refused})`);
  const region = rr.region;
  const pa = await art(a.artifactSha), pb = await art(b.artifactSha);
  check(pa.removed === true && json(pb.pins) === '[]' && !pb.removed, `S-COA-5: the key's realise ended both keyed pins: A tombstoned, B held by its region (${json({ a: pa, b: pb })})`);
  // the waits, fed in full: the road over the held terrace waits SITE_BUSY with waitsFor.say; ITEM_WAITING carries region and part(s)
  await api('events clear').catch(() => null);
  let sawStage = null;
  const f = await G.feed(ctx, region, { timeoutMs: 1_800_000, until: (st) => {
    const w = (st.unfinished ?? []).find((it) => it.reason === 'SITE_BUSY');
    if (w && !sawStage) sawStage = w;
    return st.view.state === 'PLACED';
  } });
  const items = await call('dev.region.items', { region, owner: G.OWNER });
  const tiles = (items.items ?? []).filter((i) => String(i.key).startsWith('t:'));
  const roads = (items.items ?? []).filter((i) => String(i.key).startsWith('road:'));
  const tagged = (i) => i.ext?.['architect_mc:region'] === region && (i.ext?.['architect_mc:part'] || (i.ext?.['architect_mc:parts'] ?? []).length);
  out.items = { tiles: tiles.length, tilesTagged: tiles.filter(tagged).length, roads: roads.length, roadsTagged: roads.filter(tagged).length, sample: tiles.slice(0, 2).map((i) => i.ext) };
  check(tiles.length > 0 && tiles.every((i) => i.ext?.['architect_mc:region'] === region && Array.isArray(i.ext?.['architect_mc:parts'])) && roads.every(tagged),
    `item 8: every tile item carries architect_mc:region and architect_mc:parts, every road item its region and part (${json({ tiles: out.items.tiles, tagged: out.items.tilesTagged, roads: out.items.roads, roadsTagged: out.items.roadsTagged })})`);
  const ev = (await api('events 0')).filter((e) => e.event === 'ITEM_WAITING');
  const mine = ev.filter((e) => e.ext?.['architect_mc:region'] === region);
  const said = mine.filter((e) => e.ext?.['architect_mc:waitsFor']?.say);
  out.events = { itemWaiting: ev.length, region: mine.length, said: said.length, first: said[0] && { key: said[0].key ?? said[0].itemKey, waitsFor: said[0].ext['architect_mc:waitsFor'], message: said[0].message } };
  check(mine.length > 0 && mine.every((e) => e.ext['architect_mc:part'] || (e.ext['architect_mc:parts'] ?? []).length || e.ext['architect_mc:lot']), `item 8: ITEM_WAITING for the region's tiles and roads carries the region and the part(s) (${mine.length} event(s))`);
  check(said.length > 0 && said.every((e) => /waits for .+ to be built/.test(e.ext['architect_mc:waitsFor'].say) && /\(plan label\)/.test(e.ext['architect_mc:waitsFor'].say) && !/_/.test(e.ext['architect_mc:waitsFor'].say) && e.message.startsWith(e.ext['architect_mc:waitsFor'].say)), `item 8: a stage wait says, from the plan's labels and with no id, ${json(out.events.first?.waitsFor?.say)} (waiter ${json(out.events.first?.waitsFor?.waiter)}); the message starts with it`);
  // (Steward's RC finding 5) one sentence per waiting part per wait: no two items of one part say the same wait
  const sayers = new Map();
  for (const e of said) { const w = e.ext['architect_mc:waitsFor']; const k = `${w.waiter}|${w.target}`; if (!sayers.has(k)) sayers.set(k, new Set()); sayers.get(k).add(e.key ?? e.itemKey); }
  const many = [...sayers].filter(([, v]) => v.size > 1).map(([k, v]) => `${k}: ${[...v].join(', ')}`);
  check(said.length > 0 && many.length === 0, `finding 5: one sentence per waiting part per wait (${sayers.size} part/target wait(s); said by more than one item: ${many.join('; ') || 'none'})`);
  check(f.last?.st?.view?.state === 'PLACED', `S-COA-5: fed to PLACED (${f.waves} waves)`);
  await G.remove(ctx, region);
  out.sawStage = sawStage;
  return out;
};

// ------------------------------------------------------------------ Steward's RC finding 1: no stage hold after a survival build

/** The lots' bound entries of a fixture's plan (as RS's gate reads them). */
function entriesOf(fx) {
  const out = {};
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (o.id && typeof o.entry === 'string') out[o.id] = o.entry; Object.values(o).forEach(walk); } };
  walk(fx.plan);
  return out;
}

/**
 * Steward's walled town in survival (rs02: a wall, a gate, cottages as construction sites, then the street's props): a player's pillar
 * makes the artifact stale, the re-check is realised under the same key, and the build is fed to done. No stage holds DRIFTED, and every
 * later stage's drift check run once the build is done compares the region's own built walls and houses as the baseline (all within 2).
 */
steps.drift = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, 'rs02_walled');
  const entries = entriesOf(fx);
  const s = await G.site(ctx, 'coa_drift', fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const VK = `steward.coa.${Date.now().toString(36)}.vrealise`;
  const chk = async () => (await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000)).check;
  const a = await chk();
  await call('dev.coa.pinKeyed', { sha: a.artifactSha, owner: G.OWNER, opKey: VK });
  await G.pile(ctx, s, 6);
  // the player's 3-block pillar on a planned tile (outside the lots), as in Steward's RC
  // (in the town zone's rect, on its street: a planned tile, outside the lots)
  const town = (a.parts ?? []).find((p) => p.part === 'town')?.geometry;
  const [px, pz] = town?.rect ? [(town.rect[0] + town.rect[2]) >> 1, (town.rect[1] + town.rect[3]) >> 1] : [(s.W.claim[0] + s.W.claim[2]) >> 1, (s.W.claim[1] + s.W.claim[3]) >> 1];
  const gy = await groundAt(planDir(a.checkId), px, pz);
  await cmd(`/fill ${px} ${gy + 1} ${pz} ${px} ${gy + 3} ${pz} minecraft:cobblestone`);
  const st1 = await call('dev.region.realiseApproved', { sha: a.artifactSha, opKey: VK, ...(Object.keys(entries).length ? { lotEntries: entries } : {}) }, 300_000);
  check(st1.reason === 'ARTIFACT_STALE', `finding 1: the pillar at ${px} ${gy + 1}..${gy + 3} ${pz} makes the artifact stale (${(st1.refused ?? `realised ${st1.region}`).slice(0, 120)})`);
  if (st1.region) { await G.remove(ctx, st1.region); return out; }
  const b = await chk();
  await call('dev.coa.pinKeyed', { sha: b.artifactSha, owner: G.OWNER, opKey: VK });
  const rr = await call('dev.region.realiseApproved', { sha: b.artifactSha, opKey: VK, ...(Object.keys(entries).length ? { lotEntries: entries } : {}) }, 300_000);
  check(!!rr.region, `finding 1: the re-check realised under the same key (${rr.region ?? rr.refused})`);
  if (!rr.region) return out;
  let held = null;
  const f = await G.feed(ctx, rr.region, { fraction: 0.5, timeoutMs: 2_400_000, until: (st, rs) => {
    if (!held && (st.view?.waiting?.reason === 'DRIFTED' || /DRIFTED/.test(JSON.stringify(st.view?.waiting ?? {})))) held = st.view.waiting;
    return st.view.state === 'PLACED' && rs.build?.done;
  } });
  out.feed = { waves: f.waves, state: f.last?.st?.view?.state, done: f.last?.rs?.build?.done };
  check(!held && out.feed.state === 'PLACED' && out.feed.done, `finding 1: fed to done (${f.waves} waves) with no stage held for land change (${json(held)}; ${out.feed.state}, done ${out.feed.done})`);
  const first = await call('dev.coa.stageDrift', { region: rr.region, stage: 'ground' });
  out.recordDrift = first.drift;
  check(Object.values(first.drift ?? {}).every((v) => !String(v).startsWith('held')), `finding 1: no stage's drift entry reads held (${json(first.drift)})`);
  out.stages = {};
  for (const stage of (first.stages ?? []).slice(1)) {
    const d = await call('dev.coa.stageDrift', { region: rr.region, stage });
    out.stages[stage] = { ok: d.ok, message: d.message };
  }
  const bad = Object.entries(out.stages).filter(([, d]) => !d.ok || !/^(\d+) of \1 sampled|no sampled column/.test(d.message));
  check(Object.keys(out.stages).length > 0 && bad.length === 0, `finding 1: with the build done, every later stage's drift check finds the land as the region built it (every sampled column within 2): ${json(out.stages)}`);
  await G.remove(ctx, rr.region);
  return out;
};

// ------------------------------------------------------------------ item 5 in game: rule.palette over lots

steps.palette = async () => {
  await ensure();
  const P = await import('./lib/gate6ccoa-kit.mjs');
  return P.paletteInGame(ctx, { OWNER });
};

steps.ingame = async () => {
  const out = {};
  for (const s of ['keys', 'discard', 'waits', 'drift', 'palette']) {
    try { out[s] = await steps[s](); } catch (e) { check(false, `${s}: ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = [];
  for (const f of fs.readdirSync(OUT).filter((x) => x.endsWith('.json') && !['spend.json'].includes(x))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
      if (!j.results) continue;
      for (const [m, ok] of Object.entries(j.results)) rows.push(`- ${ok ? 'PASS' : 'FAIL'} [${j.step}] ${m}`);
    } catch { /* not a step file */ }
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# 6c close-out A gate\n\n${rows.join('\n')}\n`);
  return { rows: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ccoa.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
if (state.dev && !['start'].includes(name)) state.dev.close?.();
process.exit(L.fails() ? 1 : 0);
