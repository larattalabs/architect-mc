#!/usr/bin/env node
// Slice C38 gate (docs/CONTRACT.md "C38 as built"): Regions.planCatalogue(), the live capability catalogue, synchronous, from the mod
// jar. Runs against the headless server of the C38 run worktree (the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6c38.mjs <step>
//     unit      the kit's C38 and golden tests (catalogue-c38, plan-p0), the mod's PlanCatalogueTest result (the unit-mod step runs the
//               suite), api-compat against the unchanged 0.33.0, 0.32.0 and 0.31.1 apitest jars and the 0.33.0 surface
//     ingame    headless: the FIRST call after the connection (no region, no claim, no check yet, on the bridge thread, not the server
//               thread) returns the catalogue, equal to the kit's planCatalogue() of this checkout; then a real checkPlan through the
//               sidecar returns a catalogue equal to it, entry for entry; a call after the check is unchanged; copies are defensive
//
// Evidence: artifacts/gate-c38/<step>.json in the main checkout (GATEC38_OUT overrides).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-c38-run');
process.env.GATE6B_OUT = process.env.GATEC38_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-c38');
process.env.GATE6B_SIDECAR_PORT ??= '8930';
process.env.GATE6B_DEV_PORT ??= '8931';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, fails, log, results, root, state, tp } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const OWNER = 'test:c38';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const MAIN_ARTIFACTS = path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts');
const steps = {};
const ensure = async () => { if (!state.dev) await connect(); };

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
  L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
function sh(cmdline, opts = {}) {
  const r = spawnSync('bash', ['-c', cmdline], { cwd: root, encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(root, '.gradle-home') }, ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

steps.unit = async () => {
  const out = {};
  const k = sh('node --test kit/test/catalogue-c38.test.mjs kit/test/plan-p0.test.mjs');
  fs.writeFileSync(path.join(OUT, 'unit-kit.log'), k.out);
  const pass = Number(/^ℹ pass (\d+)/m.exec(k.out)?.[1] ?? 0), fail = Number(/^ℹ fail (\d+)/m.exec(k.out)?.[1] ?? 1);
  out.kit = { pass, fail };
  check(k.code === 0 && fail === 0 && pass > 0, `kit: catalogue-c38 (a check answer's catalogue = planCatalogue() = the golden) and plan-p0 (the catalogue golden): ${pass} pass, ${fail} fail`);
  const jars = process.env.C38_JARS ?? MAIN_ARTIFACTS;
  out.apicompat = {};
  for (const [dir, ver] of [['gate-c38/v0330', '0.33.0'], ['gate7a-k1/v0320', '0.32.0'], ['gate7a-k1/v0311', '0.31.1']]) {
    const jar = path.join(jars, dir, `architect_apitest-${ver}.jar`);
    const r = sh(`node tools/api-compat.mjs ${jar}`);
    out.apicompat[ver] = r.out.trim().split('\n').pop();
    check(r.code === 0 && fs.existsSync(jar), `api-compat: the unchanged ${ver} apitest jar against this build: ${out.apicompat[ver]}`);
  }
  const sj = path.join(jars, 'gate-c38', 'v0330', 'architect_mc-0.33.0.jar');
  const sr = sh(`node tools/api-compat.mjs --surface ${sj}`);
  out.apicompat.surface = sr.out.trim().split('\n').pop();
  check(sr.code === 0 && fs.existsSync(sj), `api-compat: the 0.33.0 mod jar's whole 1.30.0 surface still exists: ${out.apicompat.surface}`);
  return out;
};

steps.ingame = async () => {
  await ensure();
  const out = {};
  const { planCatalogue } = await import(pathToFileURL(path.join(root, 'kit', 'lib', 'plan', 'catalogue.mjs')).href);
  const kitCat = planCatalogue();
  // 1. the first call after the connection: nothing has been planned, checked or claimed in this run; no player teleport, no chunk wait
  const first = await call('dev.plan.catalogue', {}, 30_000);
  out.first = { ms: first.ms, thread: first.thread, regions: first.regions, hasFeature: first.hasFeature, entries: first.catalogue?.entries?.length };
  check(first.regions === 0, `at world start no region exists (Regions.list: ${first.regions})`);
  check(first.hasFeature === true, 'features() contains "planCatalogueView"');
  check(first.copy === true, 'a second call is equal and a different object; changing the first leaves the next call unchanged (defensive copy)');
  check(first.thread && first.thread !== 'Server thread', `read off the server thread (no tick needed): ${first.thread}`);
  check(first.ms < 1000, `synchronous and cheap: ${first.ms?.toFixed?.(2)} ms for the first read (the jar's schema parsed once)`);
  assert.ok(first.catalogue, 'a catalogue');
  const sameAsKit = (() => { try { assert.deepEqual(first.catalogue, kitCat); return true; } catch { return false; } })();
  check(sameAsKit && first.catalogue.api === kitCat.api && first.catalogue.kitVersion === kitCat.kitVersion, `the mod's catalogue equals this checkout's kit planCatalogue(): ${first.catalogue.entries.length} entries, catalogueVersion ${first.catalogue.catalogueVersion}, api ${first.catalogue.api}, kit ${first.catalogue.kitVersion}`);
  const ids = new Set(first.catalogue.entries.map((e) => e.id));
  check(ids.has('connector.wall') && first.catalogue.entries.every((e) => e.id && e.state && e.sinceApi !== undefined && e.schemaVersion !== undefined), 'every entry has id, state, sinceApi, schemaVersion; connector.wall is listed');
  // 2. a real plan check through the sidecar returns the same catalogue, entry for entry
  await L.fresh('G6B C38 Ingame', FLAT);
  await L.setRules('exact');
  const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8')).fixture.claim;
  const claim = [...S7];
  const cx = (claim[0] + claim[2]) >> 1, cz = (claim[1] + claim[3]) >> 1;
  await tp(cx, 0, cz);
  const plan = { schemaVersion: 'plan/0', planId: 'gate_c38', zones: [{ id: 'town', required: true, program: { lots: [{ id: 'c1', type: 'cottage', size: [9, 9] }, { id: 'c2', type: 'cottage', size: [9, 9] }] } }] };
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors: { stone: [cx, -60, cz] }, withCatalogue: true }, 900_000);
  check(!r.refused && r.check?.overall === 'READY', `a plan check through the sidecar answers READY (${r.refused ?? r.check?.overall})`);
  const ans = r.check?.catalogue;
  let entryDiff = [];
  if (ans) {
    const n = Math.max(ans.entries.length, first.catalogue.entries.length);
    for (let i = 0; i < n; i++) { try { assert.deepEqual(first.catalogue.entries[i], ans.entries[i]); } catch { entryDiff.push(i); } }
  }
  const metaEq = ans && ['catalogueVersion', 'api', 'kitVersion', 'schemaVersion'].every((k) => ans[k] === first.catalogue[k]);
  out.check = { overall: r.check?.overall, entries: ans?.entries?.length, entryDiff, kitVersion: r.check?.kitVersion };
  check(!!ans && entryDiff.length === 0 && ans.entries.length === first.catalogue.entries.length && metaEq, `planCatalogue() = the catalogue of the PlanCheck answer, entry for entry (${ans?.entries?.length} entries, ${entryDiff.length} differ; catalogueVersion/api/kitVersion/schemaVersion ${metaEq ? 'equal' : 'DIFFER'})`, entryDiff.slice(0, 5));
  // 3. after the check (a claim, a region plan and an artifact now exist) the call is unchanged
  const after = await call('dev.plan.catalogue', {}, 30_000);
  let afterEq = true;
  try { assert.deepEqual(after.catalogue, first.catalogue); } catch { afterEq = false; }
  check(afterEq, `a later call, after a check and with the world loaded, is unchanged (regions ${after.regions}, thread ${after.thread})`);
  return out;
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6c38.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
