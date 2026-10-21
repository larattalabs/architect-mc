#!/usr/bin/env node
// Phase 6c slice IRR gate (docs/CONTRACT.md "Phase 6c slice IRR: farm irrigation" §10, Steward's review S-IRR-1..5) against the headless
// server of the IRR run worktree (GATE6B_RUN, default `../architect-mc-IRR-run`, a detached worktree at this checkout's HEAD; the sim
// sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6cirr.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit      (irr-unit)             offline: item 1 (kit/test/irr.test.mjs: detection, the grid on 20 field sizes x 20 x 4 fronts, the
//                                      mask, the lot's frame against the mod's placement table, reserved, the notes, M25:keep's own-lot
//                                      exemption, the broken variants caught; the mod's ApiIrrTest, LotMaskTest, PlanChecksHTest); item 8
//                                      (byte identity: every committed plan fixture without irrigate as on the merge base, kitVersion
//                                      normalised; the 59 asks among them); item 10 (api-compat --gate6cirr; $0)
//     ingame    (irr-ingame)           items 2, 3, 4, 5, 7, 9 in game (tools/lib/gate6cirr-game.mjs): v62, v63, Steward's hamlet and a
//                                      district lot through Regions.checkPlan and realiseApproved with a bound field entry; hydration,
//                                      crops, farmer villagers; the breach; every undo path (the region, the lot alone with its sources,
//                                      a versionOf, the entries' ownership); the unmasked variant PARTIAL; the probe and a pad's breach
//                                      recorded
//     holders   (irr-holders)          fix/drain-holders: a separate site's waterlogged stair layered over one of f2's sources; f2's site
//                                      removed alone (drainLot) and then the region: the stair stands, E-flat 0 outside it, 0 after it goes
//     crash     (irr-crash)            item 6: FL1+save and FL2+save on v62's realise, FL6+save on a lot removal's drain
//     look      (irr-look)             a client, recorded: camera shots of v62's irrigated farms (Noah's look, the gallery)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-irr/<step>.json in the main checkout (GATE6CIRR_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-IRR-run');
process.env.GATE6B_OUT = process.env.GATE6CIRR_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-irr');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const CORE = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6cirr-game.mjs');

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice IRR is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B IRR Lobby', { backend: 'sim' });
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
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
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
  // item 1 (kit)
  out.irr = nodeTest(['kit/test/irr.test.mjs']);
  check(out.irr.code === 0 && out.irr.fail === 0 && out.irr.pass >= 9, `item 1 (kit): detection (lot, zone, false over the zone, type-implied farms, template and district lots), the grid (every field column within 4 on 20 x 20 field sizes 3..62, 4 fronts), the mask, the lot's frame against the mod's placement table, reserved, the notes (not a farm, cold, small), M25:keep's own-lot exemption, the broken variants (M25:clear, M25:shell, M25:keep): ${out.irr.pass} pass, ${out.irr.fail} fail`, out.irr.failing);
  // item 1 (mod): the units the mod's own build ran
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--tests', '*ApiIrrTest', '--tests', '*LotMaskTest', '--tests', '*PlanChecksHTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', timeout: 1_800_000, env });
  out.mod = { code: g.status, api: junit('dev.larattalabs.architect.apiimpl.ApiIrrTest'), mask: junit('dev.larattalabs.architect.site.LotMaskTest'), planChecks: junit('dev.larattalabs.architect.region.PlanChecksHTest') };
  check(g.status === 0 && [out.mod.api, out.mod.mask, out.mod.planChecks].every((x) => x && x.tests > 0 && x.failures === 0 && x.errors === 0), `item 1 (mod): kit and Java agree on detection (PlanChecks.hasH over lots, template lots and districts; a string never), the mask (ext, filter, a delta's writes and growth), the placement table, DesignRequest.reserved (the 1.11.0 constructor kept, sent only when set, refused by a helper before IRR, its limits): ${json(out.mod)}`);
  // item 8 (byte identity, the 59 asks among the fixtures)
  const K = await import('./lib/gate6cirr-kit.mjs');
  const u = await K.unchanged(root, { check, log });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, added: u.added };
  fs.writeFileSync(path.join(OUT, 'irr-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // item 10
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6cirr'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 10: api-compat --gate6cirr clean against the 0.39.0, 0.38.0 and 0.37.1 apitest jars and the 0.39.0 jar's 1.36.0 surface (0.39.1 changed no Java) (DesignRequest's 1.11.0 constructor kept); $0.00`, out.apicompat.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

steps.ingame = async () => {
  await ensure();
  const out = await G.ingame(ctx);
  spendZero();
  return out;
};

// (fix/drain-holders) a later site's waterlogged block in an irrigation source through a lot's drain and the region's removal
steps.holders = async () => {
  await ensure();
  const out = await G.holders(ctx);
  spendZero();
  return out;
};

steps.crash = async () => {
  await ensure();
  const out = await G.crash(ctx);
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
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json', 'irr-unchanged.json'].includes(f) && !/check\.json$/.test(f));
  const lines = ['# Gate 6c slice IRR', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
  console.error(`usage: node tools/gate6cirr.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
