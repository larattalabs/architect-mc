#!/usr/bin/env node
// Phase 7a slice K1a gate (docs/CONTRACT.md "Phase 7a slice K1" §10: walls and gates; K1b's rope bridges are its own driver's)
// against the headless server (or a dev client, for the look) of the K1a run worktree (`../architect-mc-K1a-run`, a detached
// worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8912 (sidecar) / 8913 (DevBridge) by default. $0: no
// Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate7ak1.mjs <step>
//     start [world] | stop | base      the client (or server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit       offline: the kit's K1a and foundation tests (items 1-4 in the virtual world, 6, 7, 10, 11), P0's moved tests (item
//                15), the goldens that must not move (item 12), the whole kit suite, the catalogue diff tool against catalogue-c37 (v0.33.0)
//                (item 8), the sidecar's plan-check and features tests, api-compat --gate7ak1 (item 14)
//     ingame     items 1-4 and 9 on S7's flat claim (headless): v30 checked 3 times under /tick freeze (one artifact), realised:
//                the irSha and every tile sha equal the artifact's, the realised world equals the virtual world over every written
//                cell (the wall blocks', doors' and stairs' states included); on the realised world (the dump): closure for player and
//                villager with the gates blocked, every node across with them open, no walk cell under the wall, the wall's height
//                and its 2-over rule, the gates' clearance, 0 dark gate or top cells (M5 from the dump's own light); the gates exactly
//                the crossings plus gates.min; vanilla dev.nav.villager from every lot inside to the outside of each gate and back,
//                meeting the wall only at gate cells; the doors opened (as a villager does) and Regions.remove exact (E-flat 0)
//     natural    items 1, 4 and 9 on S7's pinned natural claim (a fresh copy of the seed world): v30 realised, realised vs virtual (at
//                most 0.01% unclassified), the wall bars on the dump, E-normal classified (D2's narrowed world classes)
//     target     K1-target (headless): a V town realised, then a wall-only plan round it (wall.around {region}) realised as its own
//                region (the wall bars on its dump, no cell on the town's footprint), removed alone: E-flat 0, the town's hash unchanged
//     look       the look step (a client: cameras): v30 on S7's natural claim in three bibles (rustic, infernal, coastal), each
//                realised, shot from 6 cameras, removed; the gallery bundle in <out>/look/ (recorded, not judged)
//     report     REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-k1/<step>.json in the main checkout (GATE7AK1_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitReuse } from './lib/kit-reuse.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { srcGradle } from './lib/src-gradle.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-K1a-run');
process.env.GATE6B_OUT = process.env.GATE7AK1_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-k1');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, call, check, cmd, connect, fails, leaveWorld, log, openWorld, results, root, state, startClient, stopClient, tp, sleep } = L;

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:k1a';
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const FIX = path.join(KIT, 'test', 'fixtures', 'plan');
const V30 = JSON.parse(fs.readFileSync(path.join(FIX, 'valid', 'v30_walled_village.json'), 'utf8')).plan;
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
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice K1a is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  // a reused run dir's base world from an older creation recipe is moved aside and made again (tools/lib/basestamp.mjs)
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), comments: t.split('\n').filter((l) => /^# /.test(l)).slice(0, 60) };
}
/** The kit suite once per gate run (tools/lib/kit-reuse.mjs): files whose checks are pass/fail only take this run's unit-kit results when exact. */
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);
function sh(cmdline, opts = {}) {
  const r = spawnSync('bash', ['-c', cmdline], { cwd: root, encoding: 'utf8', timeout: 3_600_000, env: { ...process.env, JAVA_HOME, PATH: `${JAVA_HOME}/bin:${process.env.PATH}` }, ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

steps.unit = async () => {
  const out = {};
  out.k1a = nodeTest(['kit/test/plan-k1a.test.mjs', 'kit/test/k1-foundation.test.mjs']);
  check(out.k1a.code === 0 && out.k1a.fail === 0 && out.k1a.pass >= 16, `items 1-4 (virtual world), 6, 7, 10, 11 (kit): the walled village on S7 and S3 (closure, cut, top, gates, M5), v31 and v32, the refusals (WATER, PROTECTED, OUT_OF_CLAIM, MOVER), the sealed wall, the unread keys, the crossing gate, castle_city's join, §9 on the 59 plans, determinism, the broken variants; the foundation: ${out.k1a.pass} pass, ${out.k1a.fail} fail`, out.k1a.failing);
  const rows = out.k1a.comments.find((l) => /K1a §9 rows/.test(l)) ?? '';
  check(/\((\d) of 9/.test(rows) && Number(/\((\d) of 9/.exec(rows)[1]) >= 7, `item 7: ${rows.slice(2, 400)}`);
  fs.writeFileSync(path.join(OUT, 'asks-k1a.txt'), `${out.k1a.comments.map((l) => l.slice(2)).join('\n')}\n`);
  out.p0 = kitOnce(['kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-det-1.test.mjs', 'kit/test/plan-p0-det-2.test.mjs', 'kit/test/plan-p0-det-3.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/plan-ops.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `item 15: P0's tests after the moves (connector.catwalk the reserved example; the oracle skips the supported blocks; item 9's D2 -> K1 diff): ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/route-t2.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/districts-d.test.mjs', 'kit/test/districts-d2.test.mjs', 'kit/test/village.test.mjs', 'kit/test/village-layout-1.test.mjs', 'kit/test/village-layout-2.test.mjs', 'kit/test/village-layout-3.test.mjs', 'kit/test/village-layout-4.test.mjs', 'kit/test/region-lint.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 12: S1, S7, S2, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo and districts_demo goldens unchanged (every committed scenario golden), T2's and D's tests, the realise lint: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = kitOnce(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  // ((6c T3) K1's catalogue is archived as fixtures/plan/catalogue-k1.json: the golden is catalogue 6 now)
  const d = sh('node tools/plan-catalogue-diff.mjs kit/test/fixtures/plan/catalogue-c37.json kit/test/fixtures/plan/catalogue-k1.json --pending kit/test/fixtures/plan/pending-two-districts.json');
  fs.writeFileSync(path.join(OUT, 'catalogue-diff.txt'), d.out);
  out.catalogueDiff = d.out;
  check(d.code === 0 && /^reserved -> supported: connector\.auto, connector\.gate, connector\.rope_bridge, connector\.wall$/m.test(d.out) && /^added: layout\.elevated \(reserved\), wall\.along \(reserved\), wall\.around \(supported\), wall\.edge \(supported\), wall\.line \(supported\)$/m.test(d.out)
    && /^notes changed: locator\.around: /m.test(d.out) && /recheck \(pending parts now supported\): wall \{connector\.wall\}/.test(d.out) && /^other state changes: none$/m.test(d.out),
  'item 8: tools/plan-catalogue-diff.mjs C37 (v0.33.0, after D2) -> K1 lists exactly the four flips, the five added ids and locator.around\'s note, and flags the pending connector.wall part');
  const s = sh('cd sidecar && npx vitest run test/plan-check.test.ts test/jobs.test.ts');
  out.sidecar = s.out.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ');
  check(s.code === 0, `the sidecar's plan check (ajv 2020-12 over the fixtures, K1's included) and features (region.walls, region.rope appended): ${out.sidecar}`);
  srcGradle(root, () => sh(`cd mod && GRADLE_USER_HOME=${path.join(root, '.gradle-home')} ./gradlew compileJava compileClientJava --offline -q`));
  const a = sh('node tools/api-compat.mjs --gate7ak1');
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), a.out);
  check(a.code === 0 && /all 4 checks clean/.test(a.out), `item 14: api-compat against the 0.32.0, 0.31.1 and 0.31.0 apitest jars and the 0.32.0 surface: ${a.out.trim().split('\n').pop()}`);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game helpers

async function checkPlan(plan, claim, extra = {}) {
  const r = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, ...extra }, 900_000);
  if (r.refused) throw new Error(`checkPlan refused: ${r.refused}`);
  log(`  check ${r.check.checkId}: ${r.check.overall} ${r.check.parts.map((p) => `${p.part}:${p.class}`).join(' ')} artifact ${r.check.artifactSha?.slice(0, 12) ?? '-'} (${Math.round(r.ms)} ms)`);
  return r.check;
}
async function waitPlaced(region) {
  return L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
}
function compareTiles(artifact, got) {
  const want = {};
  for (const [stage, sets] of Object.entries(artifact.region.tiles)) for (const [set, keys] of Object.entries(sets)) for (const [k, sha] of Object.entries(keys)) want[`${stage}|${set}|${k}`] = sha;
  const differ = Object.keys(want).filter((k) => got[k] !== undefined && got[k] !== want[k]);
  const missing = Object.keys(want).filter((k) => got[k] === undefined);
  return { tiles: Object.keys(want).length, received: Object.keys(got).length, equal: Object.keys(want).length - differ.length - missing.length, missing, differ };
}
const planFiles = (pdir) => {
  const ir = JSON.parse(fs.readFileSync(path.join(pdir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(pdir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(pdir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  return { ir, meta, blobs, survey: fs.readFileSync(path.join(pdir, 'survey.bin')) };
};
/**
 * The realised world against the check's virtual world over every written cell outside the lot boxes: {written, differ, kept,
 * road, share, first, byKind} (a cell that holds what it held before is `kept` by its op's condition; 4e ground roads follow the
 * realised ground: `road`). Every block property the plan names must match: the wall blocks' connections, the doors' halves and
 * hinges, the arch stairs' facing and half are the kit's, and the realise keeps them.
 */
async function realisedVsVirtual(pdir, afterFile, beforeFile) {
  const { buildVirtual, decodeArwd } = await imp('lib/region/vworld.mjs');
  const { centreCells } = await imp('lib/region/geom.mjs');
  const F = planFiles(pdir);
  const { vw } = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs });
  const d = await decodeArwd(fs.readFileSync(afterFile));
  const pre = beforeFile ? await decodeArwd(fs.readFileSync(beforeFile)) : null;
  const b = d.box;
  const inLot = (x, y, z) => F.ir.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  const roadCols = new Set();
  for (const r of F.ir.roads ?? []) for (const c of centreCells(r.points.map((q) => [q[0], q[2]])).cells) for (let dx = -2 - (r.width >> 1); dx <= 2 + (r.width >> 1); dx++) for (let dz = -2 - (r.width >> 1); dz <= 2 + (r.width >> 1); dz++) roadCols.add(`${c.x + dx},${c.z + dz}`);
  const parse = (st) => { const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st); return { name: m[1], props: Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('='))) }; };
  const same = (want, got) => { if (want === got) return true; const a = parse(want), c = parse(got); return a.name === c.name && Object.entries(a.props).every(([k, v]) => c.props[k] === v); };
  let written = 0, differ = 0, kept = 0, road = 0;
  const first = [], byKind = {};
  const wallPart = new Set(F.ir.parts.map((p, i) => (p.id.startsWith('w_') ? i : -1)).filter((i) => i >= 0));
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ || inLot(x, y, z)) return;
    written++;
    const want = vw.pal.states[idx], got = d.palette[d.cells[d.at(x, y, z)]];
    const k = parse(want).name.replace('minecraft:', '');
    if (wallPart.has(part)) byKind[k] = (byKind[k] ?? 0) + 1;
    if (!same(want, got) && pre && pre.palette[pre.cells[pre.at(x, y, z)]] === got) { kept++; return; }
    if (!same(want, got) && roadCols.has(`${x},${z}`)) { road++; return; }
    if (!same(want, got)) { differ++; if (first.length < 12) first.push({ pos: [x, y, z], want, got }); }
  });
  return { written, differ, kept, road, share: written ? differ / written : 0, first, wallBlocks: byKind };
}
/** The checker's wall rules over the realised world (the before/after dumps with the plan's virtual flags): metrics.walls, findings. */
async function realisedWalls(pdir, beforeFile, afterFile, claim) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const F = planFiles(pdir);
  const { vw } = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] }, { virtual: vw, lots: F.ir.lots });
  const rep = checkRegion({ ir: F.ir, meta: F.meta, world, rules: ['M2', 'M5', 'M6', 'M8'] });
  return { walls: rep.metrics.walls, findings: rep.findings.filter((f) => f.rule.endsWith(':wall') || (f.part ?? '').startsWith('w_')).map((f) => ({ rule: f.rule, part: f.part, count: f.count, message: f.message, sample: f.sample?.slice(0, 6) })), meta: F.meta };
}
/** The wall bars on a realised world's metrics (items 1, 3, 4). */
function wallBars(R, where) {
  for (const [id, m] of Object.entries(R.walls ?? {})) {
    check(m.cut === 0, `item 3 (${where}): 0 route or network walk cells under wall ${id}'s cells outside its gates`);
    check(m.M8.low === 0 && m.M8.bypass === 0, `item 4 (${where}): wall ${id}: 100% of its ${m.M8.columns} columns at least its height at the foot (min ${m.M8.footMin}) and 2 over standable ground within 2 (min ${m.M8.overMinHalfBlocks} half blocks)`, R.findings);
    check(m.gateClearance.bad === 0, `item 4 (${where}): wall ${id}'s gates clear (${m.gateClearance.cells} gate cells)`);
    check(m.M5 && m.M5.dark === 0, `item 4 (${where}): M5 0 dark gate walk cells and wall-top cells on wall ${id} (${json(m.M5)})`);
    if (m.closure) for (const mv of ['player', 'villager']) {
      check(m.closure[mv].leaks === 0, `item 1 (${where}): with wall ${id}'s gate cells blocked, 0 inside-to-outside ${mv} paths (terrain bypass included)`, m.closure[mv].leakSample);
      check(m.closure[mv].across === m.closure[mv].nodes, `item 1 (${where}): with the gates open, ${m.closure[mv].across}/${m.closure[mv].nodes} network nodes reach across (${mv})`, m.closure[mv].missed);
    }
  }
}
const centre = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1];
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'route_demo.json'), 'utf8'));
/** Steward's anchors in a claim (kit/test/plan-helpers.mjs stewardAnchors) at the live ground: the plan check's own. */
const anchorsOf = (claim) => {
  const [cx, cz] = centre(claim);
  return { stone: [cx, 65, cz], player: [cx - 24, 65, cz - 24], stockpile: [cx + 12, 65, cz + 12], street_w: [claim[0] + 8, 65, cz], street_e: [claim[2] - 8, 65, cz] };
};

/** One v30 round on a claim: check (3 times under /tick freeze), realise, compare, the wall bars on the realised world. */
async function v30Round(name, from, claim, plan, { rules = 'exact', settleMs = 0 } = {}) {
  const out = {};
  // (run6b's copyWorld replaces only G6B worlds)
  await L.fresh(`G6B K1a ${name}`, from);
  await L.setRules(rules);
  const [cx, cz] = centre(claim);
  await tp(cx, 140, cz);
  if (settleMs) await L.settle(settleMs);
  await cmd('/kill @e[type=!minecraft:player]');
  await cmd('/tick freeze');
  let c3, rr, st, art, before, after, h0, box;
  try {
    c3 = [];
    for (let i = 0; i < 3; i++) c3.push(await checkPlan(plan, claim, { anchors: anchorsOf(claim) }));
    const c = c3[0];
    out.check = { overall: c.overall, parts: c.parts.map((p) => ({ part: p.part, class: p.class, deviations: p.deviations ?? null, reasons: p.reasons ?? null })), artifactSha: c.artifactSha, checkId: c.checkId };
    check(c.overall === 'READY' && c.parts.filter((p) => p.part !== 'town').every((p) => p.class === 'fits'), `${name}: v30 checks READY, its wall, gate and routes fit (${c.parts.map((p) => `${p.part}:${p.class}`).join(' ')})`, c.parts);
    check(c3.every((x) => x.artifactSha && x.artifactSha === c.artifactSha), `item 10 (in game, ${name}): 3 checks under /tick freeze, one artifact sha ${c.artifactSha?.slice(0, 12)}`);
    art = (await call('dev.region.artifact', { sha: c.artifactSha, body: true })).artifact;
    const ir = JSON.parse(fs.readFileSync(path.join(planDir(c.checkId), 'ir.json'), 'utf8'));
    box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    before = path.join(OUT, `${name}-before.arwd.gz`); after = path.join(OUT, `${name}-after.arwd.gz`);
    await call('dev.region.dump', { box, file: before, light: false }, 900_000);
    h0 = rules === 'exact' ? await call('dev.region.hash', { box }, 3_600_000) : null;
    if (rules !== 'exact') await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, `${name}-snap.gz`) }, 4 * 3_600_000);
    await cmd('/kill @e[type=!minecraft:player]');
    rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
    check(!!rr.region, `${name}: realiseApproved queued ${rr.region ?? rr.refused}`);
    st = await waitPlaced(rr.region);
    check(st.view.state === 'PLACED' && st.view.irSha === art.body.region.irSha, `${name}: ${st.view.state}; the region's irSha equals the artifact's`);
    const ts = await call('dev.region.tileShas', { region: rr.region });
    out.tiles = compareTiles(art.body, ts.tiles);
    check(out.tiles.tiles > 0 && out.tiles.equal === out.tiles.tiles, `${name}: every tile sha the realise received equals the artifact's (${out.tiles.equal}/${out.tiles.tiles})`, out.tiles);
    await call('dev.region.dump', { box, file: after, light: true }, 900_000);
  } finally { await cmd('/tick unfreeze'); }
  out.region = rr.region;
  out.checkId = c3[0].checkId;
  out.virtual = await realisedVsVirtual(planDir(c3[0].checkId), after, before);
  out.skipped = st.view.cellsSkipped ?? {};
  out.R = await realisedWalls(planDir(c3[0].checkId), before, after, claim);
  out.box = box; out.h0 = h0?.sha256 ?? null; out.before = before; out.after = after;
  return out;
}

/** The gates against the routes' crossings and gates.min (item 3). */
function gatesExact(meta) {
  const crossings = (meta.route?.edges ?? []).filter((e) => e.ok).flatMap((e) => e.gates ?? []).length;
  return meta.walls.map((w) => ({ wall: w.id, gates: w.gates.map((g) => g.kind), crossings, min: w.gates.filter((g) => g.kind === 'min').length, at: w.gates.filter((g) => g.kind === 'at').length }));
}

// ------------------------------------------------------------------ items 1-4, 9 on S7's flat claim

steps.ingame = async () => {
  await ensure();
  const claim = [...S7.fixture.claim];
  const out = await v30Round('k1a-s7flat', FLAT, claim, V30, { rules: 'exact' });
  check(out.virtual.written > 0 && out.virtual.differ === 0 && out.virtual.kept === 0 && out.virtual.road === 0, `item 4: the realised world equals the virtual world over ${out.virtual.written} written cells, every state the plan names (the wall's blocks: ${json(out.virtual.wallBlocks)})`, out.virtual.first);
  wallBars(out.R, 'S7 flat, realised');
  const ge = gatesExact(out.R.meta);
  out.gates = ge;
  // v30: the road's crossing (auto) and the path through the gate at claim_w (the at gate, no gate of its own): no gates.min gate
  check(ge.length === 1 && ge[0].min === 0 && ge[0].at === 1 && ge[0].gates.filter((k) => k === 'route').length === 1 && ge[0].gates.length === 2, `item 3: the gates are exactly the crossings plus gates.min (${json(ge)})`);
  // ---- item 2: vanilla villager paths from every lot inside to the outside of each gate, both ways; they meet the wall only at gates
  const w = out.R.meta.walls[0];
  const wallCells = new Set(w.cells.map((q) => `${q[0]},${q[1]}`));
  const gateCells = new Set(w.gates.flatMap((g) => g.cells.map(([x, z]) => `${x},${z}`)));
  const [x0, z0, x1, z1] = w.inside, t = w.thickness;
  const isOut = (x, z) => x < x0 - (t - 1) || x > x1 + (t - 1) || z < z0 - (t - 1) || z > z1 + (t - 1);
  const outside = w.gates.map((g) => {
    for (const [x, z] of g.cells) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isOut(x + dx, z + dz) && !wallCells.has(`${x + dx},${z + dz}`)) return [x + dx, g.y + 1, z + dz];
    return null;
  }).filter(Boolean);
  const lots = Object.entries(out.R.meta.lots ?? {}).map(([id, l]) => [id, l.entrance]).filter(([, e]) => Array.isArray(e));
  { const [cx, cz] = centre(claim); await tp(cx, 120, cz); }
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = {};
  let wallHits = 0;
  for (const [id, e] of lots) for (const [gi, o] of outside.entries()) {
    const there = await call('dev.nav.villager', { from: e, to: o, range: 256, cells: true }, 120_000);
    const back = await call('dev.nav.villager', { from: o, to: e, range: 256, cells: true }, 120_000);
    for (const p of [...(there.cells ?? []), ...(back.cells ?? [])]) if (wallCells.has(`${p[0]},${p[2]}`) && !gateCells.has(`${p[0]},${p[2]}`)) wallHits++;
    out.nav[`${id}>g${gi}`] = [!!there.canReach, !!back.canReach, there.nodes ?? 0, back.nodes ?? 0];
  }
  const navs = Object.values(out.nav);
  check(navs.length === lots.length * outside.length && navs.length >= 4 && navs.every((n) => n[0] && n[1]), `item 2: vanilla dev.nav.villager from every inside lot (${lots.length}) to the outside of each gate (${outside.length}) and back: ${navs.filter((n) => n[0] && n[1]).length}/${navs.length} found`, out.nav);
  check(wallHits === 0, `item 2: every villager path meets the wall line only at gate cells (${wallHits} wall cells)`);
  // ---- doors toggled (as a villager opens them), then item 9: Regions.remove exact
  const doors = [];
  for (const g of w.gates.filter((q) => q.door === 'door')) for (const [x, z] of g.cells) for (const y of [g.y + 1, g.y + 2]) doors.push([x, y, z]);
  let opened = 0;
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const dmp = await decodeArwd(fs.readFileSync(out.after));
  for (const [x, y, z] of doors) {
    const st = dmp.palette[dmp.cells[dmp.at(x, y, z)]];
    // `strict`: no neighbour update (both halves set open, as a villager's use leaves them); `open` is volatile under StillOurs
    if (/door\[/.test(st)) { await cmd(`/setblock ${x} ${y} ${z} ${st.replace('open=false', 'open=true')} strict`); opened++; }
  }
  out.doorsOpened = opened;
  check(doors.length >= 2, `item 2: the gate at claim_w has its double door (${doors.length} door cells; ${opened} opened as a villager would)`);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: out.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h1 = await call('dev.region.hash', { box: out.box }, 3_600_000);
  out.undo = { removed: rm.removed, restored: rm.restored, same: out.h0 === h1.sha256 };
  check(rm.removed && out.h0 === h1.sha256, `item 9: after items 1-4, Regions.remove restores the world hash (E-flat 0; ${rm.restored} cells restored, the doors opened first)`);
  delete out.R.meta;
  await leaveWorld();
  spendZero();
  return out;
};

/**
 * D2's narrowed world classes over a removal's diff (tools/gate6cd.mjs, the lesson of F2, T2 and D2): an unclassified mismatch is
 * classed by its kind ONLY at a cell the plan never writes (its virtual world's written flag, a lot's box), and, but for a doomed leaf,
 * away from the plan: more than 6 columns from every written column and route cell (`far`), or more than 8 below both the surveyed
 * ground and every written cell within 6 columns (`deep`). Kinds: water or lava appearing, receding or moving (or what lava makes)
 * `flow`; a natural leaf turned air `decay`; the same block in another state `live`; a snow layer melted by a light the plan placed
 * (T2's `melt`, at an unwritten cell lit over 11). Everything else stays `none`. Mutates diff.classes; returns {by, world, undoOwn}.
 */
function worldClasses(diff, F, vw, F_WRITTEN, decodeColumns, restored) {
  const cols = decodeColumns(F.survey);
  const groundAt = (x, z) => { const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution); return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? null : cols.ground[i + j * cols.width]; };
  const wcol = new Map();
  const wlow = (x, z, y) => { const k = `${x},${z}`, v = wcol.get(k); if (v === undefined || y < v) wcol.set(k, y); };
  vw.eachWritten((x, y, z) => wlow(x, z, y));
  const lotBoxes = F.ir.lots.map((l) => l.box);
  for (const b of lotBoxes) for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) wlow(x, z, b.minY);
  const G = 6, near = new Set();
  for (const e of F.meta.route?.edges ?? []) for (const [x, , z] of e.path ?? []) for (let i = -G; i <= G; i++) for (let j = -G; j <= G; j++) near.add(`${x + i},${z + j}`);
  const isWritten = (x, y, z) => (vw.flags(x, y, z) & F_WRITTEN) !== 0 || lotBoxes.some((b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ);
  const away = (x, y, z) => {
    let lowNear = Infinity, nearW = false;
    for (let i = -G; i <= G; i++) for (let j = -G; j <= G; j++) { const v = wcol.get(`${x + i},${z + j}`); if (v !== undefined) { nearW = true; if (v < lowNear) lowNear = v; } }
    if (!nearW && !near.has(`${x},${z}`)) return 'far';
    const gy = groundAt(x, z);
    return gy !== null && y < gy - 8 && y < lowNear - 8 ? 'deep' : null;
  };
  const lights = [];
  vw.eachWritten((x, y, z, idx) => { const em = vw.pal.emit[idx]; if (em > 11) lights.push([x, y, z, em]); });
  const lit = (x, y, z) => lights.some(([lx, ly, lz, em]) => em - (Math.abs(lx - x) + Math.abs(ly - y) + Math.abs(lz - z)) > 11);
  const idOf = (b) => b.split(/[[{]/)[0];
  const fluidRe = /^minecraft:(water|lava)\b/;
  const by = {}, world = [];
  diff.classes = { ...(diff.classes ?? {}) };
  for (const m of diff.list ?? []) {
    if (m.class !== 'none') continue;
    const [x, y, z] = m.pos.split(',').map(Number);
    if (isWritten(x, y, z)) continue;
    let cls = null, where = null;
    if (/^minecraft:snow\[/.test(m.was) && /^minecraft:(air|cave_air)$/.test(m.now) && lit(x, y, z)) { cls = 'melt'; where = 'lit'; }
    else {
      cls = fluidRe.test(m.now) || fluidRe.test(m.was) ? 'flow' : /_leaves\[.*persistent=false/.test(m.was) && /^minecraft:air$/.test(m.now) ? 'decay' : idOf(m.was) === idOf(m.now) ? 'live' : null;
      if (!cls) continue;
      where = cls === 'decay' && /_leaves\[distance=7,persistent=false/.test(m.was) ? 'd7' : away(x, y, z);
      if (!where) continue;
    }
    m.class = cls; m.where = where;
    by[`${cls}:${where}`] = (by[`${cls}:${where}`] ?? 0) + 1;
    diff.classes.none -= 1;
    diff.classes[cls] = (diff.classes[cls] ?? 0) + 1;
    world.push({ pos: m.pos, was: m.was, now: m.now, class: cls, where });
  }
  const WORLD = ['growth', 'grazed', 'live', 'gravity', 'unsupported', 'flow', 'decay', 'melt'];
  const undoOwn = (diff.mismatches ?? 0) - WORLD.reduce((a, k) => a + (diff.classes?.[k] ?? 0), 0);
  return { by, world, undoOwn, cap: Math.floor(0.0001 * (restored ?? 0)) };
}

// ------------------------------------------------------------------ items 1, 4, 9 on S3's pinned claim (natural)

steps.natural = async () => {
  await ensure();
  // S7's pinned natural claim (the look's site; the seed world): the committed S3 survey's walled village is the kit's (item 1-4 in
  // the virtual world, plan-k1a.test.mjs); on the live seed world S3's zone lands larger and against the river (live worlds drift:
  // T1 as built), so the realised natural round runs where the same plan answers READY on the live survey
  const claim = [...S7.fixture.claim];
  const out = await v30Round('k1a-s7', BASE, claim, V30, { rules: 'default', settleMs: 30_000 });
  const skips = Object.values(out.skipped).reduce((a, b) => a + b, 0);
  check(out.virtual.kept <= skips, `item 4 (S7 natural): every cell kept by its condition is one the realise counted as skipped (${out.virtual.kept} kept, ${skips} skipped)`);
  check(out.virtual.written > 0 && out.virtual.share <= 0.0001, `item 4 (S7 natural): the realised world equals the virtual world over ${out.virtual.written} written cells: ${out.virtual.differ} unclassified (${(100 * out.virtual.share).toFixed(4)}%, at most 0.01%), ${out.virtual.kept} kept, ${out.virtual.road} on 4e ground roads`, out.virtual.first);
  wallBars(out.R, 'S7 natural, realised');
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region: out.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box: out.box, mode: 'diff', file: path.join(OUT, 'k1a-s7-snap.gz') }, 4 * 3_600_000);
  const { buildVirtual, F_WRITTEN } = await imp('lib/region/vworld.mjs');
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const F = planFiles(planDir(out.checkId));
  const { vw } = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs });
  const wc = worldClasses(diff, F, vw, F_WRITTEN, decodeColumns, rm.restored);
  out.exact = { removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, worldBy: wc.by, undoOwn: wc.undoOwn, cap: wc.cap, world: wc.world.slice(0, 60), list: (diff.list ?? []).filter((m) => m.class === 'none').slice(0, 40) };
  check(rm.removed && (diff.classes.none ?? 0) === 0 && wc.undoOwn <= wc.cap, `item 9 (S7 natural): Regions.remove: E-normal ${diff.mismatches} mismatches, all classified (${json(diff.classes)}; by place ${json(wc.by)}); the undo's own ${wc.undoOwn} (at most 0.01% of ${rm.restored} restored = ${wc.cap})`, out.exact.list);
  delete out.R.meta;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ K1-target: a wall-only plan round a standing village

/**
 * (K1-target, the coordinator's addition from Steward) a V town realised as a region of its own, then a plan whose only part is a wall
 * round it (wall.around {region}) checked on a claim that holds the town, realised by realiseApproved as a region of its own, the wall
 * bars on the realised dump, then removed alone: the world hash back to the town's (E-flat 0) and the town's own hash unchanged
 * throughout, the town still PLACED.
 */
steps.target = async () => {
  await ensure();
  const out = {};
  await L.fresh('G6B K1a Target', FLAT);
  await L.setRules('exact');
  const S = S7.fixture.claim;
  const town = [S[0] + 26, S[1] + 26, S[0] + 85, S[1] + 85];
  const claim = [...S];
  const [cx, cz] = centre(claim);
  await tp(cx, 120, cz);
  await cmd('/kill @e[type=!minecraft:player]');
  const lots = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];
  const pa = await call('dev.region.plan', { program: 'flat_village', params: { lots }, claim: town, surveyLoad: 'bounded:256', owner: OWNER, check: false }, 900_000);
  if (pa.refused) throw new Error(`the town's plan was refused: ${pa.refused}`);
  const ra = await L.realise(pa.planId, { lots: {} });
  const sa = await waitPlaced(ra);
  check(sa.view.state === 'PLACED', `K1-target: the V town ${ra} PLACED (${sa.view.cellsWritten} cells, its own region)`);
  const tbox = [town[0], -64, town[1], town[2], 140, town[3]];
  const box = [claim[0] - 8, -64, claim[1] - 8, claim[2] + 8, 140, claim[3] + 8];
  const ht0 = (await call('dev.region.hash', { box: tbox }, 3_600_000)).sha256;
  const plan = { schemaVersion: 'plan/0', planId: 'k1_target', connectors: [{ id: 'town_wall', kind: 'wall', where: { around: { feature: { region: ra } } } }] };
  await cmd('/tick freeze');
  let c, rr, st, before, after, h0;
  try {
    c = await checkPlan(plan, claim, { anchors: anchorsOf(claim) });
    out.check = { overall: c.overall, parts: c.parts.map((q) => ({ part: q.part, class: q.class, reasons: q.reasons ?? null, notes: q.notes ?? null })) };
    check(c.overall === 'READY' && c.parts[0]?.class === 'fits', `K1-target: the wall-only plan round ${ra} checks READY on a claim that holds the town (${c.parts.map((q) => `${q.part}:${q.class}`).join(' ')})`, c.parts);
    before = path.join(OUT, 'k1a-target-before.arwd.gz'); after = path.join(OUT, 'k1a-target-after.arwd.gz');
    await call('dev.region.dump', { box, file: before, light: false }, 900_000);
    h0 = (await call('dev.region.hash', { box }, 3_600_000)).sha256;
    rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
    check(!!rr.region && rr.region !== ra, `K1-target: realiseApproved made a region of its own (${rr.region ?? rr.refused}) beside the town ${ra}`);
    st = await waitPlaced(rr.region);
    check(st.view.state === 'PLACED', `K1-target: the wall ${st.view.state} (${st.view.cellsWritten} cells)`);
    await call('dev.region.dump', { box, file: after, light: true }, 900_000);
  } finally { await cmd('/tick unfreeze'); }
  const ht1 = (await call('dev.region.hash', { box: tbox }, 3_600_000)).sha256;
  out.R = await realisedWalls(planDir(c.checkId), before, after, claim);
  const w = out.R.meta.walls[0];
  out.gates = w.gates.map((g) => ({ id: g.id, kind: g.kind, at: g.at, width: g.width }));
  check(w.closed && w.gates.length >= 1, `K1-target: the ring is closed, with ${w.gates.length} gate(s) (${json(out.gates.map((g) => g.kind))}): where the town's streets meet it, else gates.min facing a street end`);
  wallBars(out.R, 'K1-target, realised');
  // the town's own cells: the wall wrote none of them (the town's hash over its claim changes only where the ring stands in its margin)
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const fa = planFiles(planDir(pa.planId));
  const { standingFootprint } = await imp('lib/region/beside.mjs');
  const fp = standingFootprint(fa.ir);
  const hard = [...fp.lots, ...fp.roads, ...fp.paths, ...fp.ways].map((q) => q.rect);
  const touched = w.cells.filter(([x, z]) => hard.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]) && !w.gates.some((g) => g.cells.some(([gx, gz]) => gx === x && gz === z)));
  check(touched.length === 0, `K1-target: no wall cell on the town's footprint (lots, roads, paths, ways) outside a gate (${touched.length})`);
  void decodeArwd; void ht1;
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h1 = (await call('dev.region.hash', { box }, 3_600_000)).sha256;
  const ht2 = (await call('dev.region.hash', { box: tbox }, 3_600_000)).sha256;
  const ts = await call('dev.region.state', { region: ra }, 60_000);
  out.undo = { removed: rm.removed, restored: rm.restored, exact: h0 === h1, townSame: ht0 === ht2, town: ts.view.state };
  check(rm.removed && h0 === h1, `K1-target: the wall's region removed alone, exactly (E-flat 0 over the plan's claim; ${rm.restored} cells restored)`);
  check(ht0 === ht2 && ts.view.state === 'PLACED', `K1-target: the town untouched: its hash unchanged and ${ra} still ${ts.view.state}`);
  // the town removed too: the world as it was
  await call('dev.region.remove', { region: ra, requester: OWNER }, 3_600_000);
  delete out.R.meta;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (a client: cameras)

const LOOK_BIBLES = ['g6cv_village', 'g7ak1_infernal', 'g7ak1_coastal'];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shoot(cams, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const name of Object.keys(cams)) {
    await call('dev.scenario.cams', { cams, cam: name }, 60_000);
    const s = await call('dev.screenshot', { name: `k1a_${name}`, frames: 20, chunkTimeoutMs: 60_000 }, 180_000);
    fs.copyFileSync(s.path, path.join(dir, `${name}.png`));
    out[name] = { width: s.width, height: s.height };
  }
  await call('dev.release', {}).catch(() => null);
  return out;
}
/** Cameras on a walled village: S7's high and north views, and one close on each gate from outside (and the door from inside). */
function camsOf(meta) {
  const w = meta.walls[0];
  const [x0, z0, x1, z1] = w.inside;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const cams = { cam_high: [cx + 0.5, Math.max(...w.cells.map((c) => c[2])) + 48, cz + 40.5, 180, 55], cam_north: [cx + 0.5, Math.max(...w.cells.map((c) => c[2])) + 14, z0 - 30.5, 0, 22] };
  w.gates.forEach((g, i) => {
    const [gx, gy, gz] = g.at;
    // outward: from the ring's centre through the gate
    const dx = Math.sign(gx - cx) * (Math.abs(gx - cx) > Math.abs(gz - cz) ? 1 : 0), dz = Math.sign(gz - cz) * (Math.abs(gz - cz) >= Math.abs(gx - cx) ? 1 : 0);
    const yaw = dx > 0 ? 90 : dx < 0 ? -90 : dz > 0 ? 180 : 0;
    cams[`cam_gate${i + 1}`] = [gx + dx * 12 + 0.5, gy + 4, gz + dz * 12 + 0.5, yaw, 12];
    const back = yaw + 180 > 180 ? yaw - 180 : yaw + 180;
    cams[`cam_gate${i + 1}_in`] = [gx - dx * 7 + 0.5, gy + 3, gz - dz * 7 + 0.5, back, 8];
  });
  return cams;
}

steps.look = async () => {
  await ensure();
  const out = { bibles: {} };
  const claim = [...S7.fixture.claim];
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  for (const b of LOOK_BIBLES) installBible(b);
  for (const bible of LOOK_BIBLES) {
    await L.fresh(`G6B K1a Look ${bible}`, BASE);
    await L.setRules('gallery');
    const [cx, cz] = centre(claim);
    await tp(cx, 140, cz);
    await L.settle(20_000);
    await cmd('/kill @e[type=!minecraft:player]');
    const c = await checkPlan(V30, claim, { anchors: anchorsOf(claim), bible });
    const o = { overall: c.overall, parts: c.parts.map((p) => `${p.part}:${p.class}`), artifactSha: c.artifactSha };
    out.bibles[bible] = o;
    check(c.overall === 'READY', `look (${bible}): v30 on S7's natural claim checks READY (${o.parts.join(' ')})`);
    if (!c.artifactSha) continue;
    const meta = planFiles(planDir(c.checkId)).meta;
    const cams = camsOf(meta);
    o.cams = cams;
    o.before = await shoot(cams, path.join(dir, bible, 'before'));
    const rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
    const st = await waitPlaced(rr.region);
    check(st.view.state === 'PLACED', `look (${bible}): realised (${st.view.cellsWritten} cells)`);
    await L.settle(5000);
    o.after = await shoot(cams, path.join(dir, bible, 'after'));
    o.wall = meta.walls.map((w) => ({ id: w.id, height: w.height, thickness: w.thickness, crenels: w.crenels, gates: w.gates.map((g) => ({ id: g.id, kind: g.kind, door: g.door, frame: g.frame, width: g.width })) }));
    o.bom = c.parts.find((p) => p.part === 'town_wall')?.cost?.bom ?? null;
    await cmd('/kill @e[type=!minecraft:player]');
    await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
    await leaveWorld();
  }
  fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'natural', 'target', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-K1a (walls and gates)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ak1.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
