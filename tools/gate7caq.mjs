#!/usr/bin/env node
// Slice AQ gate (7c aqueducts; docs/CONTRACT.md "Phase 7c" §3 row 9, "Slice AQ as built") against the headless server of the AQ run
// worktree (GATE6B_RUN, default `../architect-mc-AQ-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 8896 (sidecar) / 8897 (DevBridge) by default (GATE6B_SIDECAR_PORT / GATE6B_DEV_PORT override: the verifier's 8904/8905). $0.
//
//   node tools/gate7caq.mjs <step>
//     unit      (aq-unit)      offline: kit/test/aq.test.mjs (the flip; valley crossings at depths 3, 8 and 16 and the example x01 checked
//                              clean, M15 and M25 clean, nothing but the supports under the trough; S-THEME; survival: the span and the
//                              lining the part's target, its bill its cost.bom; the refusal past the rise; HY's movers by name) and the
//                              HY/RM/7c/P0 tests it touches; the Java ApiAQTest, Api7cFTest, PlanCatalogueTest; byte identity: every
//                              committed plan fixture planned here and on the merge base (../architect-mc-AQ-main) identical but the named
//                              ones (AQ_MOVED: HY's r03 and its extension twin e18); the 59 asks here and on the merge base (both tables
//                              equal fixtures/plan/aq/asks-*.txt, no line moves)
//     ingame    (aq-ingame)    creative, on the flat base (exact rules): x01 (a canal on arches over a valley 8 deep) through
//                              Regions.checkPlan then realiseApproved: READY, PLACED, every reach settled and its census equal to its
//                              prediction; every solid cell the plan writes (the span's piers, arches and walls, the trough) as the check's
//                              virtual world says; Remove E-flat 0
//     survival  (aq-survival)  survival (the RS base), strict (the verifier re-runs it): x01 checked in survival (its bill the part's
//                              cost.bom: the piers, arches, walls and lining), an INSTANT twin, realised and fed from the owner's stockpile
//                              in waves: PLACED and built, the part's targets built and their bill equal to the check's, the world equal to
//                              the twin cell for cell, items in = items out (the conservation sum exact once built and once removed: every
//                              item back), Remove E-flat 0
//     report                   REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7c-aq/<step>.json in the main checkout (GATE7CAQ_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-AQ-run');
process.env.GATE6B_OUT = process.env.GATE7CAQ_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7c-aq');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, fails, log, results, root, state } = L;
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const core = await import('./lib/gate6chy-core.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

/** The committed fixtures whose answers move with AQ (byte identity's named movers). */
export const AQ_MOVED = Object.freeze({
  'hy/r03_aqueduct.json': 'AQ: the canal over the valley answers fits as an aqueduct (its span on arches; was unsupported channel.aqueduct until 7c)',
  'extension/e18_aqueduct.json': 'AQ: the same plan as hy/r03: fits as an aqueduct (was unsupported channel.aqueduct until 7c)',
});

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice AQ is $0: sim only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.kit = kitOnce(['kit/test/aq.test.mjs', 'kit/test/hy-b.test.mjs', 'kit/test/hy-core.test.mjs', 'kit/test/rm.test.mjs', 'kit/test/f7c-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/catalogue-c38.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 40, `kit: aq.test.mjs (the flip, the crossings at depths 3, 8 and 16 and x01 clean, nothing but the supports under the trough, S-THEME, survival, the refusal, HY's movers) and the HY/RM/7c/P0/catalogue tests it touches: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '-q', '--no-daemon', '--tests', 'dev.larattalabs.architect.apiimpl.ApiAQTest', '--tests', 'dev.larattalabs.architect.api.Api7cFTest', '--tests', 'dev.larattalabs.architect.region.PlanCatalogueTest'], { cwd: path.join(root, 'mod'), encoding: 'utf8', env, timeout: 1_800_000 });
  out.java = { code: g.status, tail: `${g.stdout}${g.stderr}`.split('\n').filter((l) => /FAIL|error/i.test(l)).slice(0, 10) };
  check(g.status === 0, 'Java: ApiAQTest (aqueduct follows the helper\'s plan.aqueduct; the jar\'s plan.json holds channel.aqueduct supported), Api7cFTest and PlanCatalogueTest', out.java.tail);
  // byte identity against the merge base, the named exceptions aside
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'AQ', except: AQ_MOVED, mergedIf: 'kit/test/aq.test.mjs' });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'aq-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  // the 59 asks on the merge base and here: none has a course past its fill, so no line moves
  const before = await B.asksGap(path.join(path.resolve(root, '..', 'architect-mc-AQ-main'), 'kit'), { current: true }), after = await B.asksGap(KIT, { current: true });
  fs.writeFileSync(path.join(OUT, 'aq-asks-before.txt'), before.text);
  fs.writeFileSync(path.join(OUT, 'aq-asks-after.txt'), after.text);
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'aq');
  out.asks = { same: before.text === after.text, malformed: after.malformed, committedAfter: fs.readFileSync(path.join(F, 'asks-after.txt'), 'utf8') === after.text, committedBefore: fs.readFileSync(path.join(F, 'asks-before.txt'), 'utf8') === before.text };
  check(after.malformed === 0 && out.asks.same && out.asks.committedAfter && out.asks.committedBefore,
    `the 59 asks on the merge base and here: 0 malformed; no line moves (${out.asks.same}); both tables equal fixtures/plan/aq/asks-{before,after}.txt (${out.asks.committedBefore}, ${out.asks.committedAfter})`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game

const planDir = (checkId) => path.join(L.SIDECAR_DATA, 'regions', 'plans', checkId);
const fixture = (n) => G.fixture(ctx, `aq/${n}`);

/** Every solid cell the plan writes (no air, no fluid: the bodies are the census's) against the realised world: {written, differ, byPart, first}. */
async function solidsAgainst(dir, afterFile) {
  const { loadPlanDir, virtualOf } = await imp('lib/lint/vworld-fixtures.mjs');
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const F = loadPlanDir(dir);
  const { vw } = virtualOf(F);
  const d = await decodeArwd(fs.readFileSync(afterFile));
  const b = d.box;
  const out = { written: 0, differ: 0, byPart: {}, first: [] };
  vw.eachWritten((x, y, z, idx, f, pi) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return;
    const want = vw.pal.states[idx];
    if (/^minecraft:(air|cave_air|water|lava)(\[|$)/.test(want)) return;
    const got = d.palette[d.cells[d.at(x, y, z)]];
    const part = F.ir.parts[pi]?.id ?? '?';
    const row = (out.byPart[part] ??= { written: 0, differ: 0 });
    out.written++; row.written++;
    if (got !== want) { out.differ++; row.differ++; if (out.first.length < 8) out.first.push({ at: [x, y, z], want, got, part }); }
  });
  return out;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const fx = fixture('x01_valley_aqueduct');
  out.x01 = await B.realiseFixture(ctx, 'aq-x01', fx, {
    after: async (r, { box, ck }) => {
      const a = (ck.check?.parts ?? []).find((q) => q.part === 'canal');
      const aq = a?.geometry?.aqueduct ?? null;
      check(a?.class === 'fits' && a?.block === 'channel.aqueduct' && aq?.span === 'arches' && aq?.piers >= 3, `x01: the canal is an aqueduct (fits, block ${a?.block}): ${json(aq)}`, a?.geometry?.aqueduct);
      const file = path.join(OUT, 'aq-x01-after.arwd.gz');
      await call('dev.region.dump', { box, file, light: false }, 1_800_000);
      const s = await solidsAgainst(planDir(ck.check.checkId), file);
      const span = s.byPart.canal_span ?? { written: 0, differ: 0 };
      check(s.differ === 0 && span.written > 0, `x01: every solid cell the plan writes stands as the check's virtual world says: ${s.differ} of ${s.written} differ (the span's piers, arches and walls ${span.differ} of ${span.written}; ${json(Object.entries(s.byPart).map(([k, v]) => [k, v.written, v.differ]))})${s.first.length ? ` first ${json(s.first.slice(0, 3))}` : ''}`, s);
      return { aqueduct: aq, solids: s };
    },
  });
  return out;
};

// ------------------------------------------------------------------ survival (strict: the verifier re-runs it)

/**
 * x01 built in survival: its INSTANT twin; a survival world checked in survival (the part's bill its cost.bom: the span and the lining), a
 * stockpile, the conservation sum, realised and fed in waves: PLACED and built, the part's targets built with the check's bill, the world
 * equal to the twin, the sum exact; removed: E-flat 0, every item back (the sum exact again).
 */
async function buildOne(tag, fx, partId) {
  const out = { tag };
  const T = await G.twin(ctx, `aq-${tag}`, fx, {});
  const s = await G.site(ctx, `aq ${tag}`, fx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, `aq-${tag}-pre`);
  const ck = await G.check(ctx, `aq-${tag}`, s);
  const a = (ck.check?.parts ?? []).find((q) => q.part === partId);
  const sv = a?.cost?.survival;
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, part: { class: a?.class, block: a?.block, aqueduct: a?.geometry?.aqueduct, bom: a?.cost?.bom, survival: sv } };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && a?.class === 'fits' && a?.block === 'channel.aqueduct' && sv?.free > 0 && sum(sv?.bom) > 0 && G.same(sv?.bom, a?.cost?.bom) && (sv?.bom?.['minecraft:cobblestone'] ?? 0) > 0,
    `${tag} (survival): Regions.checkPlan in survival: ${ck.check?.overall}; ${partId} ${a?.class} ${a?.block}: free ${sv?.free}, held ${sv?.held}; its bill ${json(sv?.bom)} (${sum(sv?.bom)} items: the piers, arches, walls and lining) equal to its cost.bom`, out.check);
  if (!ck.check?.artifactSha) return out;
  const crateAt = await G.pile(ctx, s, 3);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, {});
  out.region = region;
  const p0 = await C.point('realised');
  const f = await G.feed(ctx, region, { cons: C, fraction: 0.5, timeoutMs: 2_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, parts: (rs.build.parts ?? []).map((q) => [q.part, q.state, q.targets?.length]) };
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100, `${tag} (survival): realiseApproved and fed in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(out.build)}`);
  const targets = (rs.targets ?? []).filter((t) => t.part === partId).map((t) => ({ target: t.target, part: t.part, cells: t.cells, built: t.built, bom: t.bom }));
  out.targets = targets;
  const tb = targets.reduce((m, t) => G.plus(m, t.bom), {});
  check(targets.length > 0 && targets.every((t) => t.built) && G.same(tb, sv?.bom), `${tag} (survival): the piers, arches, walls and lining are ${partId}'s construction targets, built: ${targets.length} target(s), ${sum(tb)} items ${json(tb)} (the check's ${sum(sv?.bom)})`, targets);
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ.map((p) => ({ part: p, diff: G.minus(bills.want[p], bills.got[p]) }));
  check(differ.length === 0 && G.same(bills.want[partId], sv?.bom), `${tag} (survival): every part's cost.survival.bom against its targets' bills put down: ${differ.length ? `differ ${json(out.billsDiffer)}` : `equal, item for item (${partId} ${json(bills.got[partId])})`}`, bills);
  const pb = await C.point('built');
  out.builtPoint = pb;
  check(G.exact(p0) && G.exact(pb), `${tag} (survival): items in = items out once built: every item fed is in the stockpile or standing as a paid block (the conservation sum ${json(pb.diff)}, identity ${pb.identity})`, pb);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `${tag} (survival): the realised world equals its INSTANT twin cell for cell (the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `${tag} (survival): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  const pr = await C.point('removed');
  out.removedPoint = pr;
  check(G.exact(pr), `${tag} (survival): items in = items out once removed: every item back (the conservation sum ${json(pr.diff)}, identity ${pr.identity}; refund ${json(rm.refund)})`, pr);
  out.conservation = C.points;
  return out;
}

steps.survival = async () => {
  await ensure();
  spendZero();
  return { x01: await buildOne('s01', fixture('x01_valley_aqueduct'), 'canal') };
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'survival']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7c-AQ (aqueducts)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7caq.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
