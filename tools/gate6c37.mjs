#!/usr/bin/env node
// Slice C37 gate (docs/CONTRACT.md "C37 as built"; C37b rides along) against the headless server of the C37 run worktree
// (`../architect-mc-c37-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8924 (sidecar) / 8925
// (DevBridge) by default. $0: no Claude call anywhere.
//
//   node tools/gate6c37.mjs <step>
//     unit      the kit's C37 and golden suites (the whole suite and the sidecar and mod builds are the unit-kit, unit-sidecar and unit-mod steps) (the C37 fixtures: Steward's 13x14 with "ew" gives ew, 9x9 with "ns" gives ns, a forced orientation that
//               places nothing refuses NO_ROOM with wouldFit, "auto" = omitted byte for byte; every committed golden re-plans unchanged), api-compat against the 0.32.0, 0.31.1 and 0.31.0 apitest jars and the 0.32.0 surface
//     ingame    on the flat world: 4 cottages of 13x14 checked auto (ns) and with orientation "ew" (an ew street, roads along x), realised
//               (realiseApproved) and removed: the world hash restored exactly (the undo item); C37b: Library.Entry.cells() equals
//               PlanChecks.cells for every library entry (at least two, one hollow whose Part cells sum differs)
//
// Evidence: artifacts/gate-c37/<step>.json in the main checkout (GATEC37_OUT overrides).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs'; // (speed audit A) the kit files unit-kit already ran in this run
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-c37-run');
process.env.GATE6B_OUT = process.env.GATEC37_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-c37');
process.env.GATE6B_SIDECAR_PORT ??= '8924';
process.env.GATE6B_DEV_PORT ??= '8925';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state, tp } = L;

L.refuseKeys();
const FLAT = 'G6B Flat Base';
const OWNER = 'test:c37';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const ARTIFACTS = process.env.C37_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'architect-mc', 'artifacts', 'gate7a-k1');
const steps = {};
const planDir = (planId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
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
  const kitFiles = 'kit/test/orientation-c37.test.mjs kit/test/plan-p0.test.mjs kit/test/plan-p0-valid.test.mjs kit/test/plan-p0-det-1.test.mjs kit/test/plan-p0-det-2.test.mjs kit/test/plan-p0-det-3.test.mjs kit/test/plan-p0-asks.test.mjs kit/test/plan-ops.test.mjs kit/test/scenario-goldens.test.mjs kit/test/village.test.mjs kit/test/village-layout-1.test.mjs kit/test/village-layout-2.test.mjs kit/test/village-layout-3.test.mjs kit/test/village-layout-4.test.mjs'.split(' ');
  // (speed audit A) the pass/fail counts are all this reads: unit-kit's report when it ran these exact files in this run
  const re = kitReuse(root, kitFiles);
  const k = re ? { code: 0, out: `kit: ${re.reused}\nℹ pass ${re.pass}\nℹ fail 0\n` } : sh(`node --test ${testConcurrencyArgs().join(' ')} ${kitFiles.join(' ')}`);
  fs.writeFileSync(path.join(OUT, 'unit-kit.log'), k.out);
  const pass = Number(/^ℹ pass (\d+)/m.exec(k.out)?.[1] ?? 0), fail = Number(/^ℹ fail (\d+)/m.exec(k.out)?.[1] ?? 1);
  out.kit = { pass, fail };
  check(k.code === 0 && fail === 0 && pass > 0, `kit: the C37 fixtures, plan-p0 (catalogue golden), plan-ops and scenario-goldens (every committed golden re-planned unchanged), village: ${pass} pass, ${fail} fail`);
  out.apicompat = {};
  for (const [api, dir, ver] of [['1.29.0', 'v0320', '0.32.0'], ['1.28.0', 'v0311', '0.31.1'], ['1.28.0', 'v0310', '0.31.0']]) {
    const jar = path.join(ARTIFACTS, dir, `architect_apitest-${ver}.jar`);
    const r = sh(`node tools/api-compat.mjs ${jar}`);
    out.apicompat[ver] = r.out.trim().split('\n').pop();
    check(r.code === 0 && fs.existsSync(jar), `api-compat: the unchanged ${ver} apitest jar against this build: ${out.apicompat[ver]}`);
  }
  const sj = path.join(ARTIFACTS, 'v0320', 'architect_mc-0.32.0.jar');
  const sr = sh(`node tools/api-compat.mjs --surface ${sj}`);
  out.apicompat.surface = sr.out.trim().split('\n').pop();
  check(sr.code === 0 && fs.existsSync(sj), `api-compat: the 0.32.0 mod jar's whole 1.29.0 surface still exists: ${out.apicompat.surface}`);
  return out;
};

const lots13 = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, type: 'cottage', size: [13, 14] }));
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8')).fixture.claim;
const centre = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1];
async function checkPlan(plan, claim, extra = {}) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, ...extra }, 900_000);
  if (r.refused) return r;
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')}`);
  return r.check;
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B C37 Ingame', FLAT);
  await L.setRules('exact');
  const claim = [...S7];
  const [cx, cz] = centre(claim);
  await tp(cx, 0, cz);
  const mk = (orientation) => ({ schemaVersion: 'plan/0', planId: `gate_c37_${orientation ?? 'auto'}`, zones: [{ id: 'town', required: true, program: { lots: lots13(4), ...(orientation ? { orientation } : {}) } }] });
  const auto = await checkPlan(mk(null), claim, { anchors: { stone: [cx, -60, cz] } });
  const ew = await checkPlan(mk('ew'), claim, { anchors: { stone: [cx, -60, cz] } });
  const pa = auto.parts?.[0], pe = ew.parts?.[0];
  out.orientation = { auto: pa?.geometry?.orientation, ew: pe?.geometry?.orientation };
  check(pa?.class === 'fits' && pa.geometry.orientation === 'ns', `13x14 cottages: auto lays an ns street (${pa?.class} ${pa?.geometry?.orientation})`);
  check(ew.overall === 'READY' && pe?.class === 'fits' && pe.geometry.orientation === 'ew' && pe.geometry.lots.length === 4, `13x14 cottages with orientation "ew": an ew street, 4 lots (${pe?.class} ${pe?.geometry?.orientation}, ${pe?.geometry?.lots?.length} lots)`);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir(ew.checkId), 'ir.json'), 'utf8'));
  const spans = ir.roads.map((r) => { const xs = r.points.map((q) => q[0]), zs = r.points.map((q) => q[2]); return [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)]; });
  check(spans.length > 0 && spans.every(([dx, dz]) => dx >= dz), `the IR's street runs along x (east-west): ${JSON.stringify(spans)}`);
  // the realise and the exact undo
  const box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const rr = await call('dev.region.realiseApproved', { sha: ew.artifactSha }, 300_000);
  check(!!rr.region, `realiseApproved queued region ${rr.region ?? rr.refused}`);
  const st = await L.waitRegion(rr.region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  const h1 = await call('dev.region.hash', { box }, 3_600_000);
  check(st.view.state === 'PLACED' && h1.sha256 !== h0.sha256, `the forced-ew plan realised (${st.view.state}); the world changed`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h2 = await call('dev.region.hash', { box }, 3_600_000);
  out.undo = { removed: rm.removed, restored: rm.restored, same: h0.sha256 === h2.sha256 };
  check(rm.removed && h0.sha256 === h2.sha256, `Regions.remove restores the world hash exactly (E-flat 0; ${rm.restored} cells restored)`);
  // C37b
  const cells = await call('dev.library.cells', {}, 30_000);
  const es = cells.entries ?? [];
  out.cells = es;
  check(es.length >= 2 && es.every((e) => e.entryCells === e.planCells), `C37b: Library.Entry.cells() equals PlanChecks.cells for all ${es.length} library entries`, es.filter((e) => e.entryCells !== e.planCells));
  const bySize = (e) => e.size ? e.size[0] * e.size[1] * e.size[2] : 0;
  const hollow = es.filter((e) => e.entryCells > 0 && e.parts > 0 && e.partSum > e.entryCells);
  check(hollow.length >= 1, `C37b: a hollow entry (parts present, the Part cells sum above the non-air count): ${hollow.slice(0, 3).map((e) => `${e.id}: ${e.entryCells} non-air vs parts ${e.partSum} (box ${e.size?.join('x')})`).join('; ')}`, es.slice(0, 5));
  check(es.filter((e) => e.entryCells > 0).length >= 2, `C37b: at least two readable entries count above 0 (${es.filter((e) => e.entryCells > 0).length})`);
  check(es.some((e) => e.entryCells > 0 && e.entryCells < bySize(e)), 'C37b: a count below its bounding volume (the entry is not solid)');
  return out;
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6c37.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
