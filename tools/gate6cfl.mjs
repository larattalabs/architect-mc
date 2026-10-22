#!/usr/bin/env node
// Phase 6c slice FL gate (docs/CONTRACT.md "Phase 6c slice FL: free layouts" §10, Steward's review S-FL-1..8) against the headless server
// of the FL run worktree (GATE6B_RUN, default `../architect-mc-FL-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no
// Claude). $0: no Claude call anywhere.
//
//   node tools/gate6cfl.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit      (fl-unit)              offline: items 1-3, 5, 8, 9 (kit/test/fl.test.mjs, fl-layouts-1/2.test.mjs, fl-look.test.mjs (Noah's look fixes L1-L5): the mask, the frontage
//                                      engine and each layout on 200 seeded claims, the fl/ answers with their wouldFits re-checked alone,
//                                      KC, catalogue 10, the asks, plan v1's shape, the street ext); item 4 (byte identity against the
//                                      merge base, kitVersion and the street ext normalised; the untouched files); item 8 (the asks before
//                                      and after); item 10 (3 checks of each FL fixture: identical answers and artifact shas); item 11
//                                      (timing, recorded); item 12 (api-compat --gate6cfl, the compact plan/0's size; $0); the mod's
//                                      IrRoadExtTest
//     ingame    (fl-ingame)            item 6 (tools/lib/gate6cfl-game.mjs): v66, v67, v68, v70, v71 and s01 through Regions.checkPlan and
//                                      realiseApproved: READY, PLACED, every lot standing, the street items' ext, the walks, M5, E-flat 0
//     natural   (fl-natural)           item 7: v69's program on S3's lower band: a no-region control, then the round, E-normal
//     look      (fl-look)              item 13 (client, recorded): the five layouts in two bibles, camera shots (Noah's gallery)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-fl/<step>.json in the main checkout (GATE6CFL_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gatePart, sliceSections, slicesOf } from './lib/gate-part.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-FL-run');
process.env.GATE6B_OUT = process.env.GATE6CFL_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-fl');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, check, bar, connect, log, results, root, state, startClient, stopClient } = L;
const CORE = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6cfl-game.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core: CORE, B };

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
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice FL is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B FL Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  for (const name of ['G6B Seed Base', 'G6B Flat Base']) await L.ensureBase(name);
  spendZero();
  return { worlds: ['G6B Seed Base', 'G6B Flat Base'] };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), notes: t.split('\n').filter((l) => /^# (ring|spiral|grid|organic):/.test(l)) };
}

/** A JUnit result file's counts (the mod's own test run, `./gradlew test`). */
function junit(name) {
  const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-${name}.xml`);
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  const g = (k) => Number((new RegExp(`${k}="(\\d+)"`).exec(t) ?? [])[1] ?? -1);
  return { tests: g('tests'), failures: g('failures'), errors: g('errors') };
}

steps.unit = async () => {
  const out = {};
  // a split unit step (docs/GATES.md "Turbo"): `items` (every item but the byte identity) and the byte identity's fixture loop in
  // round-robin slices; whole, every section runs exactly as before
  const P = gatePart(['items', ...sliceSections('unchanged', 3)], { log });
  const slice = slicesOf(P, 'unchanged', 3);
  if (P.want('items')) {
  // items 1-3, 5, 8, 9 and the street ext (kit)
  out.kit = nodeTest(['kit/test/fl.test.mjs', 'kit/test/fl-layouts-1.test.mjs', 'kit/test/fl-layouts-2.test.mjs', 'kit/test/fl-look.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 13, `items 1-3, 5, 8, 9: the layouts on 200 seeded claims each (0 lots overlapping or outside the mask, every entrance joined, the ring closed, the spiral's pitch, the grid's blocks, the organic turn bound), the broken variants caught, the fl/ answers and their wouldFits re-checked alone, KC, catalogue 10, the five asks, plan v1's shape, the street ext: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  for (const n of out.kit.notes) log(`  ${n}`);
  // the mod: Ir reads a road's ext (S-FL-5)
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*IrRoadExtTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', timeout: 1_800_000, env });
  out.mod = { code: g.status, ir: junit('dev.larattalabs.architect.region.IrRoadExtTest') };
  check(g.status === 0 && out.mod.ir && out.mod.ir.tests > 0 && out.mod.ir.failures === 0 && out.mod.ir.errors === 0, `S-FL-5 (mod): Ir reads a road's ext (architect_mc:street) and keeps the 6- and 7-argument Road constructors: ${json(out.mod)}`);
  }
  // items 4 and 8: byte identity, the untouched files, the asks
  const K = await import('./lib/gate6cfl-kit.mjs');
  if (!slice || slice.length) {
  const u = await K.unchanged(root, { check, log, slice });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, namedMoved: u.namedMoved, added: u.added.length, streetsMarked: u.streetsMarked };
  fs.writeFileSync(path.join(OUT, 'fl-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  }
  if (P.want('items')) {
  out.untouched = K.untouched(root, { check });
  out.asks = await K.asks(root, { check, write: false });
  // item 10: 3 checks of each FL fixture: identical answers and artifact shas
  const h = await import(pathToFileURL(path.join(KIT, 'test', 'plan-p0-shared.mjs')).href);
  const det = {};
  for (const f of [...h.read('valid').filter((x) => /^v(6[6-9]|7[01])_/.test(x.name)), ...h.read('fl').filter((x) => x.expect?.part)]) {
    const rs = [await h.run(f), await h.run(f), await h.run(f)];
    const j = rs.map((r) => JSON.stringify(r.check));
    det[f.name] = j[1] === j[0] && j[2] === j[0] && rs.every((r) => r.artifactSha === rs[0].artifactSha);
  }
  out.determinism = det;
  check(Object.values(det).every(Boolean), `item 10: 3 checks of each FL fixture: identical answers and artifact shas (${Object.keys(det).length} fixtures; macOS here, Linux in kit CI)`, Object.entries(det).filter(([, v]) => !v));
  // item 11 (recorded): timing
  out.timing = await K.timing(root);
  for (const [k, v] of Object.entries(out.timing)) bar(true, `item 11 (recorded): ${k} on a 256 x 256 claim with 40 lots: median ${v.medianMs} ms of 3 (${v.class}, ${v.lots} lots, ${v.unplaced} unplaced; ${v.notes.join(' | ')})`);
  // item 12: api-compat, the compact plan/0's size, $0
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cfl'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 12: api-compat --gate6cfl clean against the 0.40.0, 0.39.1 and 0.39.0 apitest jars and the 0.40.0 jar's 1.37.0 surface (no Java beyond the version, the feature string, the road ext and the dev hook)`, out.apicompat.tail);
  out.compact = compactSize();
  check(out.compact.compact !== null && out.compact.compact < 84_000, `item 12: the compact plan/0 is ${out.compact.compact} characters (bound 84,000, S-FL-8; the merge base's ${out.compact.before ?? '?'}: FL's delta ${out.compact.before ? out.compact.compact - out.compact.before : '?'}); $0.00`);
  }
  spendZero();
  return out;
};

/**
 * The compact plan/0's size: the sidecar's own rendering (sidecar/test/system-refs.test.ts prints it), here and on the merge base
 * (its sidecar, with this checkout's node_modules: the base worktree has none).
 */
function compactSize() {
  const one = (dir) => {
    const r = spawnSync('npx', ['vitest', 'run', 'test/system-refs.test.ts', '-t', 'compact plan/0 is much shorter', '--silent=false'], { cwd: path.join(dir, 'sidecar'), encoding: 'utf8', timeout: 600_000 });
    const m = /# compact plan\/0: (\d+) characters/.exec(`${r.stdout}${r.stderr}`);
    return m ? Number(m[1]) : null;
  };
  const out = { compact: one(root) };
  // the base's test does not print it: its kit's compact form through this checkout's sidecar test, pointed at the base's kit
  const baseKit = path.resolve(root, '..', 'architect-mc-FL-main', 'kit');
  if (fs.existsSync(baseKit)) {
    const r = spawnSync('npx', ['vitest', 'run', 'test/system-refs.test.ts', '-t', 'compact plan/0 is much shorter', '--silent=false'], { cwd: path.join(root, 'sidecar'), encoding: 'utf8', timeout: 600_000, env: { ...process.env, COMPACT_KIT: baseKit } });
    const m = /# compact plan\/0: (\d+) characters/.exec(`${r.stdout}${r.stderr}`);
    out.before = m ? Number(m[1]) : null;
  }
  return out;
}

// ------------------------------------------------------------------ in game

steps.ingame = async () => {
  await ensure();
  const out = await G.ingame(ctx);
  spendZero();
  return out;
};

steps.natural = async () => {
  await ensure();
  const out = await G.natural(ctx);
  spendZero();
  return out;
};

steps.look = async () => {
  await ensure();
  const out = await G.look(ctx);
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json', 'fl-unchanged.json'].includes(f) && !/check\.json$/.test(f));
  const lines = ['# Gate 6c slice FL', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (!j.results) continue;
    const fails = Object.entries(j.results).filter(([, v]) => v === false || v?.ok === false);
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s): ${fails.length ? `${fails.length} FAIL` : 'PASS'}`, '');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cfl.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
