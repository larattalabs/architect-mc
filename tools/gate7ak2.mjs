#!/usr/bin/env node
// Phase 7a slice K2 gate (docs/CONTRACT.md "Phase 7a slice K2: walls along a boundary, and wall walks" §9, and the coordinator's rulings
// of 2026-10-23) against the headless server (or a dev client, for the look) of the K2 run worktree (`../architect-mc-K2-run`, a
// detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports 8936 (sidecar) / 8937 (DevBridge) by default. $0: no
// Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate7ak2.mjs <step>
//     start [world] | stop | base   the server (or client) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (k2-unit)            offline: item 1 (kit/test/k2.test.mjs: spine, side, per-run offsets, the supercover, open ends, gates.min
//                                    0 and n, the walk's surface, parapet, rail, gate crossings, tower passages, accesses, every refusal with its
//                                    evidence and wouldFit re-checked alone; KC's pond, item 8; the catalogue, item 11; determinism, item 12),
//                                    K1's and T3's batch tests, KC's, D2's boundary tests (item 2: unchanged), the structure lint's k2 cases
//                                    (k2:walk and its broken variants, p0:k2), item 2 (byte identity: every committed plan fixture, the 59
//                                    asks among them, as on the merge base but the named exceptions: tools/lib/gate7ak2-kit.mjs K2_MOVED),
//                                    item 3 (the recorded plans: castle_city the only answer that changes, by its walk), the compact plan/0
//                                    (recorded; bound 96,000), the sidecar's features and plan check
//     ingame    (k2-ingame)          items 4, 5, 6 and 9 (headless) on S7's flat claim: v7a_k2_walk checked 3 times under /tick freeze (one
//                                    artifact), realised (irSha and tile shas the artifact's; realised = virtual over every written cell), on
//                                    the realised dump: closure (both movers, gates blocked) and every node across, no route cell under a wall
//                                    cell, the walk judged (the kit player round the whole walk, up and down every access; M8:walk 0, the
//                                    parapet continuous; M5 0 dark walk cells; M3 0; head room); vanilla villagers through the gates both ways
//                                    from every lot inside (hard bar); the walk shown (the bot teleported along every walk cell in order, each
//                                    a stand); Regions.remove E-flat 0
//     natural   (k2-natural)         items 4, 7 and 9 on S3's pinned claim (a fresh copy of the seed world): v7a_k2_along_shore checked and
//                                    realised, realised vs virtual (at most 0.01% unclassified), every line cell within distance of the spine
//                                    (the runs' offsets in [3, 6]; a cell within one of it), 0 wall cells in water (re-read), the free ends'
//                                    posts, the wall bars on the dump; E-normal 0 unclassified
//     survival  (k2-survival)        item 10: k2/k2_rs_walk (v7a_k2_walk's shape on RS's flat terrain) in a survival world: its INSTANT twin,
//                                    checked in survival, a stockpile, realised and fed: PLACED and built, the bills per part equal to the
//                                    check's cost.survival.bom (BOM exact), the world equal to the twin cell for cell, removed: E-flat 0 and
//                                    the refund once
//     look      (k2-look)            item 13 (a client: cameras): v7a_k2_walk on S7's natural claim in three bibles and the shore wall on S3's
//                                    river, each realised, shot (high, gates, the walk close: an access landing, the rail on its corbels, a
//                                    tower passage), removed; the gallery bundle in <out>/look/ (recorded, not judged: N-K2-1 is Noah's call)
//     report                         REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-k2/<step>.json in the main checkout (GATE7AK2_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitReuse } from './lib/kit-reuse.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-K2-run');
process.env.GATE6B_OUT = process.env.GATE7AK2_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-k2');
process.env.GATE6B_SIDECAR_PORT ??= '8936';
process.env.GATE6B_DEV_PORT ??= '8937';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:k2';
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const FIX = path.join(KIT, 'test', 'fixtures', 'plan');
const readFx = (...p) => JSON.parse(fs.readFileSync(path.join(FIX, ...p), 'utf8'));
const WALK = readFx('valid', 'v7a_k2_walk.json').plan;
const SHORE = readFx('valid', 'v7a_k2_along_shore.json').plan;
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice K2 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ server and worlds

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
  for (const name of [BASE, FLAT]) await L.ensureBase(name);
  spendZero();
  return { worlds: [BASE, FLAT], seed: SEED };
};

// ------------------------------------------------------------------ offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);
function sh(cmdline, opts = {}) {
  const r = spawnSync('bash', ['-c', cmdline], { cwd: root, encoding: 'utf8', timeout: 3_600_000, ...opts });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

steps.unit = async () => {
  const out = {};
  out.k2 = nodeTest(['kit/test/k2.test.mjs']);
  check(out.k2.code === 0 && out.k2.fail === 0 && out.k2.pass >= 11, `items 1, 3 (castle_city), 8, 11, 12 (kit): along (spine, side, per-run offsets, the supercover, open ends, gates.min 0 and n, the auto gates where routes cross on the flat edge; S3's shore with gates.min 2 and its routes refused UNREACHABLE {kind: wall}), walks (surface, parapet, rail, gate crossings, tower passages, accesses up and down, M5, head room; flights and ladders), the refusals (NO_FEATURE, NO_ROOM {class}, {why: walk} with its wouldFit re-checked alone, {why: access}), KC's pond, the catalogue, determinism: ${out.k2.pass} pass, ${out.k2.fail} fail`, out.k2.failing);
  out.k1 = kitOnce(['kit/test/plan-k1a.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/plan-k1b.test.mjs', 'kit/test/plan-k1-batch.test.mjs', 'kit/test/plan-t3-batch.test.mjs', 'kit/test/kc.test.mjs', 'kit/test/districts-d2.test.mjs', 'kit/test/f7a-foundation.test.mjs']);
  check(out.k1.code === 0 && out.k1.fail === 0, `item 2 (kit): K1's tests (v30-v34, §9 on the 59 plans), the K1 and T3 batch tests, KC's, D2's boundary tests and the foundation's unchanged but where K2 names them: ${out.k1.pass} pass, ${out.k1.fail} fail`, out.k1.failing);
  // the structure lint's K2 cases: the walks' bars gated, the broken variants caught; the k2 corpus
  const lint = sh(`node tools/lint.mjs structure --only k2:walk,p0:k2 --json ${path.join(OUT, 'lint-k2.json')}`);
  out.lint = lint.out.split('\n').filter((l) => /^(PASS|FAIL|ok|  )/.test(l)).slice(0, 40);
  check(lint.code === 0, `item 6 (the walk's structural bars in the virtual world, tools/lint.mjs structure k2:walk and p0:k2: M2:walk, M8:walk, M6:walk, M5:walk, M3, the broken variants noRail, parapetGap and noLamps caught): ${lint.code === 0 ? 'PASS' : 'FAIL'}`, out.lint);
  // item 2: byte identity against the merge base; item 3: of the 59 asks, only castle_city's answer moves
  const K = await import('./lib/gate7a-kit.mjs');
  const { K2_MOVED } = await import('./lib/gate7ak2-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'K2', except: K2_MOVED });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
  fs.writeFileSync(path.join(OUT, 'k2-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  const { F7A_MOVED } = await import('./lib/f7a-norm.mjs');
  const asksMoved = u.moved.filter((f) => f.startsWith('asks/') && (f === 'asks/castle_city.json' || !(f in F7A_MOVED)));
  check(JSON.stringify(asksMoved) === JSON.stringify(['asks/castle_city.json']) && !u.differ.length, `item 3 (§8): of Steward's recorded plans only castle_city's answer changes (by its walk): moved ${json(asksMoved)} (the foundation's own aside: F7A_MOVED)`);
  // the compact plan/0 (recorded; the bound is 96,000)
  out.compact = compactOf(path.join(root, 'kit'));
  check(out.compact !== null && out.compact <= 96_000, `the compact plan/0: ${out.compact} characters (the bound 96,000, the coordinator's 2026-10-23)`);
  const s = sh('cd sidecar && npx vitest run test/plan-check.test.ts test/jobs.test.ts');
  out.sidecar = s.out.split('\n').filter((l) => /Tests|Test Files/.test(l)).join(' | ');
  check(s.code === 0, `item 12 (API): the sidecar's plan check and features (region.walls.along, region.walls.walk appended): ${out.sidecar}`);
  spendZero();
  return out;
};

/** The compact plan/0 (the sidecar's own expansion of plan/0#compact, by tsx) over a kit dir. */
function compactOf(kit) {
  const sc = fs.existsSync(path.join(root, 'sidecar', 'node_modules', '.bin', 'tsx')) ? path.join(root, 'sidecar') : path.join(path.resolve(root, '..', 'architect-mc'), 'sidecar');
  const f = path.join(OUT, 'compact.mts');
  fs.writeFileSync(f, `import { expandSystemRefs } from ${JSON.stringify(path.join(sc, 'src', 'jobs', 'systemrefs.ts'))};\nprocess.stdout.write(String((await expandSystemRefs(${JSON.stringify(kit)}, ['plan/0#compact'])).length));`);
  const r = spawnSync(path.join(sc, 'node_modules', '.bin', 'tsx'), [f], { cwd: sc, encoding: 'utf8', timeout: 300_000 });
  return Number(r.stdout.trim()) || null;
}

// ------------------------------------------------------------------ in game helpers (K1a's, tools/gate7ak1.mjs)

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
/** The realised world against the check's virtual world over every written cell outside the lot boxes (K1a's). */
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
/** The checker's wall and walk rules over the realised world (the dumps with the plan's virtual flags): metrics.walls, findings. */
async function realisedWalls(pdir, beforeFile, afterFile, claim) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const F = planFiles(pdir);
  const { vw } = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] }, { virtual: vw, lots: F.ir.lots });
  const rep = checkRegion({ ir: F.ir, meta: F.meta, world, rules: ['M2', 'M3', 'M5', 'M6', 'M8'] });
  const wallParts = new Set((F.meta.walls ?? []).map((w) => `w_${w.id}`.slice(0, 48)));
  return { walls: rep.metrics.walls, findings: rep.findings.filter((f) => f.rule.endsWith(':wall') || f.rule.endsWith(':walk') || wallParts.has(f.part ?? '')).map((f) => ({ rule: f.rule, part: f.part, count: f.count, message: f.message, sample: f.sample?.slice(0, 6) })), meta: F.meta, after };
}
/** The wall bars (K1a's items 1, 3, 4; K2's items 5, 6) on a realised world's metrics. */
function wallBars(R, where) {
  for (const [id, m] of Object.entries(R.walls ?? {})) {
    check(m.cut === 0, `item 5 (${where}): 0 route or network walk cells under wall ${id}'s cells outside its gates`);
    check(m.M8.low === 0 && m.M8.bypass === 0, `(${where}) wall ${id}: 100% of its ${m.M8.columns} columns at least its height at the foot (min ${m.M8.footMin}) and 2 over standable ground within 2 (min ${m.M8.overMinHalfBlocks} half blocks)`, R.findings);
    check(m.gateClearance.bad === 0, `(${where}) wall ${id}'s gates clear (${m.gateClearance.cells} gate cells)`);
    check(m.M5 && m.M5.dark === 0, `(${where}) M5 0 dark gate walk cells and wall-top cells on wall ${id} (${json(m.M5)})`);
    if (m.closure) for (const mv of ['player', 'villager']) {
      check(m.closure[mv].leaks === 0, `item 5 (${where}): with wall ${id}'s gate cells blocked, 0 inside-to-outside ${mv} paths (the walk and its accesses included)`, m.closure[mv].leakSample);
      check(m.closure[mv].across === m.closure[mv].nodes, `item 5 (${where}): with the gates open, ${m.closure[mv].across}/${m.closure[mv].nodes} network nodes reach across (${mv})`, m.closure[mv].missed);
    }
    if (m.walk) {
      const k = m.walk;
      check(k.reached === k.cells && k.accessesUp === k.accesses && k.accessesDown === k.accesses, `item 6 (${where}, judged): the kit player round the whole walk on the re-read world (${k.reached}/${k.cells} walk cells) and up and down every access (${k.accessesUp} up, ${k.accessesDown} down of ${k.accesses})`, R.findings);
      check(k.edges.bad === 0, `item 6 (${where}): M8 0 on walk cells (every edge the continuous parapet, the rail, or a drop of at most 3; re-read): ${k.edges.bad}`, R.findings);
      check(k.dark === 0, `item 6 (${where}): M5 0 dark walk cells (and flight steps), the dump's own light: ${k.dark}`);
      check(k.headroom.bad === 0, `item 6 (${where}): 2 clear over every walk cell: ${k.headroom.bad}`);
    }
  }
  const m3 = (R.findings ?? []).filter((f) => /^M3/.test(f.rule) && f.rule !== 'M3:overhang');
  check(m3.length === 0, `item 6 (${where}): M3 0 on the wall's part (its walk, rails, corbels, flights, lamps): ${json(m3.map((f) => [f.rule, f.count]))}`, m3);
}
const centre = (c) => [(c[0] + c[2]) >> 1, (c[1] + c[3]) >> 1];
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'route_demo.json'), 'utf8'));
const anchorsOf = (claim) => {
  const [cx, cz] = centre(claim);
  return { stone: [cx, 65, cz], player: [cx - 24, 65, cz - 24], stockpile: [cx + 12, 65, cz + 12], street_w: [claim[0] + 8, 65, cz], street_e: [claim[2] - 8, 65, cz] };
};

/** One round on a claim: check (3 times under /tick freeze), realise, compare, the wall and walk bars on the realised world. */
async function round(name, from, claim, plan, { rules = 'exact', settleMs = 0, isReady = (c) => c.overall === 'READY' } = {}) {
  const out = {};
  await L.fresh(`G6B K2 ${name}`, from);
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
    out.check = { overall: c.overall, parts: c.parts.map((p) => ({ part: p.part, class: p.class, deviations: p.deviations ?? null, reasons: p.reasons ?? null, notes: p.notes ?? null })), artifactSha: c.artifactSha, checkId: c.checkId };
    check(isReady(c), `item 4 (${name}): Steward-shaped: checkPlan ${c.overall} (${c.parts.map((p) => `${p.part}:${p.class}`).join(' ')})`, c.parts);
    check(c3.every((x) => x.artifactSha && x.artifactSha === c.artifactSha), `item 12 (in game, ${name}): 3 checks under /tick freeze, one artifact sha ${c.artifactSha?.slice(0, 12)}`);
    art = (await call('dev.region.artifact', { sha: c.artifactSha, body: true })).artifact;
    const ir = JSON.parse(fs.readFileSync(path.join(planDir(c.checkId), 'ir.json'), 'utf8'));
    box = [claim[0] - 8, ir.claim.minY, claim[1] - 8, claim[2] + 8, ir.claim.maxY, claim[3] + 8];
    before = path.join(OUT, `${name}-before.arwd.gz`); after = path.join(OUT, `${name}-after.arwd.gz`);
    await call('dev.region.dump', { box, file: before, light: false }, 900_000);
    h0 = rules === 'exact' ? await call('dev.region.hash', { box }, 3_600_000) : null;
    if (rules !== 'exact') await call('dev.region.hash', { box, mode: 'snap', file: path.join(OUT, `${name}-snap.gz`) }, 4 * 3_600_000);
    await cmd('/kill @e[type=!minecraft:player]');
    rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
    check(!!rr.region, `item 4 (${name}): realiseApproved queued ${rr.region ?? rr.refused}`);
    st = await waitPlaced(rr.region);
    check(st.view.state === 'PLACED' && st.view.irSha === art.body.region.irSha, `item 4 (${name}): ${st.view.state}; the region's irSha equals the artifact's`);
    const ts = await call('dev.region.tileShas', { region: rr.region });
    out.tiles = compareTiles(art.body, ts.tiles);
    check(out.tiles.tiles > 0 && out.tiles.equal === out.tiles.tiles, `item 12 (${name}): every tile sha the realise received equals the artifact's (${out.tiles.equal}/${out.tiles.tiles})`, out.tiles);
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

// ------------------------------------------------------------------ items 4, 5, 6, 9 on S7's flat claim

steps.ingame = async () => {
  await ensure();
  const claim = [...S7.fixture.claim];
  const out = await round('k2-walk-s7flat', FLAT, claim, WALK, { isReady: (c) => c.overall === 'READY' && c.parts.filter((p) => p.part !== 'town').every((p) => p.class === 'fits') });
  check(out.virtual.written > 0 && out.virtual.differ === 0 && out.virtual.kept === 0 && out.virtual.road === 0, `item 4: the realised world equals the virtual world over ${out.virtual.written} written cells, every state the plan names (the wall's blocks: ${json(out.virtual.wallBlocks)})`, out.virtual.first);
  wallBars(out.R, 'S7 flat, realised');
  const w = out.R.meta.walls[0];
  out.walk = { cells: w.walk.cells.length, accesses: w.walk.accesses.map((a) => ({ kind: a.kind, why: a.why, foot: a.foot, at: a.at })), lamps: w.walk.lamps.length };
  check(w.walk.accesses.filter((a) => /^gate /.test(a.why)).length === 2 * w.gates.length, `item 4: an access each side of every gate (${w.walk.accesses.length} accesses for ${w.gates.length} gates, ${json(w.walk.accesses.map((a) => a.kind))})`);
  // ---- item 5: vanilla villagers through the gates both ways, from every lot inside to each gate's outside; the paths meet the wall
  // only at gate cells (the hard bar)
  const wallCells = new Set(w.cells.map((q) => `${q[0]},${q[1]}`));
  const topAt = new Map(w.cells.map((q) => [`${q[0]},${q[1]}`, q[2]]));
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
    // (a path cell through the wall's body: a wall column, not a gate's, under its top; one on the walk itself is not a crossing)
    for (const p of [...(there.cells ?? []), ...(back.cells ?? [])]) if (wallCells.has(`${p[0]},${p[2]}`) && !gateCells.has(`${p[0]},${p[2]}`) && p[1] < topAt.get(`${p[0]},${p[2]}`)) wallHits++;
    out.nav[`${id}>g${gi}`] = [!!there.canReach, !!back.canReach, there.nodes ?? 0, back.nodes ?? 0];
  }
  const navs = Object.values(out.nav);
  check(navs.length === lots.length * outside.length && navs.length >= 4 && navs.every((n) => n[0] && n[1]), `item 5 (hard bar): vanilla dev.nav.villager from every inside lot (${lots.length}) to the outside of each gate (${outside.length}) and back: ${navs.filter((n) => n[0] && n[1]).length}/${navs.length} found`, out.nav);
  check(wallHits === 0, `item 5: every villager path meets the wall line only at gate cells (${wallHits} wall cells; none on the walk or its flights)`);
  // ---- item 6, shown: the bot along the walk (teleported cell by cell in walk order: every one a stand, from the re-read world)
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const dmp = await decodeArwd(fs.readFileSync(out.after));
  const air = (x, y, z) => /^minecraft:(air|cave_air|lantern|torch|soul_lantern)/.test(dmp.palette[dmp.cells[dmp.at(x, y, z)]]);
  const ordered = [...w.walk.cells].sort((a, b) => a[3] - b[3]);
  let stands = 0;
  for (const [x, y, z] of ordered) if (air(x, y, z) && air(x, y + 1, z) && !air(x, y - 1, z)) stands++;
  const step = Math.max(1, Math.floor(ordered.length / 48));
  for (let i = 0; i < ordered.length; i += step) { const [x, y, z] = ordered[i]; await tp(x + 0.5, y, z + 0.5); }
  out.shown = { cells: ordered.length, stands, teleports: Math.ceil(ordered.length / step) };
  check(stands === ordered.length, `item 6 (shown, recorded): the bot taken along the walk in order (${out.shown.teleports} stops); every walk cell a stand in the re-read world (${stands}/${ordered.length}: 2 clear over a floor). The judged walk is the kit player's above`);
  // ---- item 9: Regions.remove exact
  await cmd('/kill @e[type=!minecraft:player]');
  { const [cx, cz] = centre(claim); await tp(cx, 300, cz); }
  const rm = await call('dev.region.remove', { region: out.region, requester: OWNER }, 3_600_000);
  await L.settle(3000);
  const h1 = await call('dev.region.hash', { box: out.box }, 3_600_000);
  out.undo = { removed: rm.removed, restored: rm.restored, same: out.h0 === h1.sha256 };
  check(rm.removed && out.h0 === h1.sha256, `item 9: Regions.remove restores the world hash (E-flat 0; ${rm.restored} cells restored)`);
  delete out.R.meta; delete out.R.after;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 4, 7, 9 on S3's pinned claim (natural)

/** D2's narrowed world classes over a removal's diff (K1a's worldClasses, tools/gate7ak1.mjs): mutates diff.classes; {by, world, undoOwn, cap}. */
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

steps.natural = async () => {
  await ensure();
  const claim = [...S3.fixture.claim];
  const out = await round('k2-shore-s3', BASE, claim, SHORE, { rules: 'default', settleMs: 30_000, isReady: (c) => c.overall === 'READY' && ['fits', 'adjusted'].includes(c.parts.find((p) => p.part === 'river_wall')?.class) });
  const skips = Object.values(out.skipped).reduce((a, b) => a + b, 0);
  check(out.virtual.kept <= skips, `item 4 (S3 natural): every cell kept by its condition is one the realise counted as skipped (${out.virtual.kept} kept, ${skips} skipped)`);
  check(out.virtual.written > 0 && out.virtual.share <= 0.0001, `item 4 (S3 natural): the realised world equals the virtual world over ${out.virtual.written} written cells: ${out.virtual.differ} unclassified (${(100 * out.virtual.share).toFixed(4)}%, at most 0.01%), ${out.virtual.kept} kept, ${out.virtual.road} on 4e ground roads`, out.virtual.first);
  wallBars(out.R, 'S3 shore, realised');
  // ---- item 7: along, realised
  const w = out.R.meta.walls[0];
  const ans = out.check.parts.find((p) => p.part === 'river_wall');
  const dist = w.along.distance;
  const cheb = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  const lineCells = w.cells.filter((c) => c[4] === 0);
  const far = lineCells.filter((c) => { const d = Math.min(...w.along.spine.map((q) => cheb(q, c))); return d < dist[0] - 1 || d > dist[1] + 1; });
  const moved = (ans.deviations ?? []).filter((d) => d.what === 'move');
  check(far.length === 0 || moved.length > 0, `item 7: every line cell within distance [${dist}] of the spine (each run's offset in range along its normals: D2's Chebyshev measure; a cell within one of it on the staircase shore), or the recorded move deviation (${far.length} cells outside; deviations ${json(moved)})`, far.slice(0, 8));
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const dmp = out.R.after; void decodeArwd; // (realisedWalls's decoded after-dump)
  const at = (x, y, z) => dmp.palette[dmp.cells[dmp.at(x, y, z)]] ?? '';
  // 0 cells in water: no wall column stands over water in the re-read world (its foot to its top)
  let wet = 0;
  for (const [x, z, T] of w.cells) for (let y = T - 24; y <= T + 3; y++) if (/^minecraft:water/.test(at(x, y, z))) { wet++; break; }
  check(wet === 0, `item 7: 0 wall cells in water (re-read: no water in a wall column, its foot to its top; ${w.cells.length} columns)`);
  // the free ends' posts: an end position stands 1 over its neighbour position
  const topOf = (pos) => Math.max(...w.cells.filter((c) => c[3] === pos).map((c) => { for (let y = c[2] + 4; y >= c[2] - 4; y--) if (!/^minecraft:(air|cave_air)$/.test(at(c[0], y, c[1]))) return y; return -Infinity; }));
  const posts = w.ends.map((e) => ({ end: e, top: topOf(e), beside: topOf(e === 0 ? 1 : e - 1) }));
  out.posts = posts;
  check(posts.length === 2 && posts.every((p) => p.top >= p.beside + 1), `item 7: both free ends end in a post 1 higher (${json(posts)})`);
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region: out.region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box: out.box, mode: 'diff', file: path.join(OUT, 'k2-shore-s3-snap.gz') }, 4 * 3_600_000);
  const { buildVirtual, F_WRITTEN } = await imp('lib/region/vworld.mjs');
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const F = planFiles(planDir(out.checkId));
  const { vw } = buildVirtual({ ir: F.ir, survey: F.survey, blobs: F.blobs });
  const wc = worldClasses(diff, F, vw, F_WRITTEN, decodeColumns, rm.restored);
  out.exact = { removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, worldBy: wc.by, undoOwn: wc.undoOwn, cap: wc.cap, list: (diff.list ?? []).filter((m) => m.class === 'none').slice(0, 40) };
  check(rm.removed && (diff.classes.none ?? 0) === 0, `item 9 (S3 natural): Regions.remove: E-normal ${diff.mismatches} mismatches, 0 unclassified (${json(diff.classes)}; by place ${json(wc.by)}; the undo's own ${wc.undoOwn})`, out.exact.list);
  delete out.R.meta; delete out.R.after;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 10: the walk in survival (RS's helpers)

steps.survival = async () => {
  await ensure();
  const G = await import('./lib/gate6crs-game.mjs');
  const core = await import('./lib/gate6chy-core.mjs');
  const B = await import('./lib/gate6chy-b.mjs');
  const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
  const name = 'k2/k2_rs_walk';
  const fx = G.fixture(ctx, name);
  const entries = fx.lotEntries ?? {};
  const out = { fixture: name, entries };
  const T = await G.twin(ctx, 'k2walk', fx, entries);
  const s = await G.site(ctx, 'k2walk', fx);
  await G.designs(ctx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, 'k2-rs-walk-pre');
  const ck = await G.check(ctx, 'k2walk', s);
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class]) };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!ck.check?.artifactSha, `item 10: Regions.checkPlan in survival: ${ck.check?.overall}, ${json(out.check.parts)}`);
  const wallAns = (ck.check?.parts ?? []).find((a) => a.part === 'town_wall');
  out.wallSurvival = wallAns?.cost?.survival ?? null;
  check(!!wallAns?.cost?.survival?.bom && Object.keys(wallAns.cost.survival.bom).some((k) => /stairs$|_wall$|fence$/.test(k)), `item 10: the wall's cost.survival carries its walk (paid: the walk surface, the parapet, the rail, the flights, the lamps): ${json(wallAns?.cost?.survival?.bom)}`);
  const crateAt = await G.pile(ctx, s, 6);
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 3_600_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.build = rs.build;
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100, `item 10: realiseApproved and fed in ${f.waves} waves: ${st.view.state}, build ${json(rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent })}; the walk is cells of the wall's own part (w_town_wall), so its targets build it with the wall, BuildOrder bottom up: the walk after the body under it`);
  const bills = G.billsOf(ck, rs);
  out.bills = bills;
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  check(differ.length === 0, `item 10: BOM exact: the check's cost.survival.bom against the targets' bills put down, per part: ${differ.length ? `${differ.length} differ: ${differ.join(', ')}` : 'equal, item for item'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `item 10: the realised world equals its INSTANT twin cell for cell (the walk, its flights and rails among them; the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `item 10: Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
  // the refund once: what stood went back to the stockpile once (a second remove refunds nothing)
  const again = await L.call('dev.region.remove', { region, requester: G.OWNER }, 600_000).catch((x) => ({ error: String(x.message ?? x) }));
  out.again = again;
  const twice = again?.refund && Object.values(again.refund).some((n) => n > 0);
  check(!!rm.refund && !twice, `item 10: the refund once (${json(rm.refund)}; a second remove refunds ${json(again?.refund ?? again?.error ?? null)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 13: the look (a client: cameras)

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
    const s = await call('dev.screenshot', { name: `k2_${name}`, frames: 20, chunkTimeoutMs: 60_000 }, 180_000);
    fs.copyFileSync(s.path, path.join(dir, `${name}.png`));
    out[name] = { width: s.width, height: s.height };
  }
  await call('dev.release', {}).catch(() => null);
  return out;
}
const yawOf = (dx, dz) => (dx > 0 ? -90 : dx < 0 ? 90 : dz > 0 ? 0 : 180);
/**
 * Cameras on a wall with a walk: high over it, each gate from outside, and the walk close (N-K2-1, the coordinator's ask): an access
 * landing from inside and above, the rail on its corbels from inside below, along the walk at a tower passage.
 */
function camsOf(meta) {
  const w = meta.walls[0];
  const xs = w.cells.map((c) => c[0]), zs = w.cells.map((c) => c[1]), top = Math.max(...w.cells.map((c) => c[2]));
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const cams = { cam_high: [cx + 0.5, top + 48, Math.max(...zs) + 40.5, 180, 55] };
  w.gates.slice(0, 2).forEach((g, i) => {
    const [gx, gy, gz] = g.at;
    const dx = Math.sign(gx - cx) * (Math.abs(gx - cx) > Math.abs(gz - cz) ? 1 : 0), dz = Math.sign(gz - cz) * (Math.abs(gz - cz) >= Math.abs(gx - cx) ? 1 : 0);
    cams[`cam_gate${i + 1}`] = [gx + dx * 12 + 0.5, gy + 4, gz + dz * 12 + 0.5, yawOf(-dx, -dz), 12];
  });
  // (the coordinator's ask) a shore gate's landing: from above its flight's top, looking down it to the gate
  const lg = w.gates.find((g) => g.landing);
  if (lg) {
    const top = lg.landing.cells.reduce((a, c) => (c[1] > a[1] ? c : a), lg.landing.cells[0]);
    const [gx, , gz] = lg.at, dx = gx - top[0], dz = gz - top[2];
    cams.cam_landing = [top[0] - Math.sign(dx) * 4 + 0.5, top[1] + 6, top[2] - Math.sign(dz) * 4 + 0.5, Math.abs(dx) >= Math.abs(dz) ? yawOf(Math.sign(dx), 0) : yawOf(0, Math.sign(dz)), 30];
  }
  const wk = w.walk;
  if (wk) {
    const a = wk.accesses.find((q) => q.kind === 'stair') ?? wk.accesses[0];
    if (a) {
      // the landing: from inside, above the flight's foot, looking at the wall
      const [fx, fy, fz] = a.foot, [ax, ay, az] = a.at;
      const dx = Math.sign(fx - ax), dz = Math.sign(fz - az);
      cams.cam_access = [fx + dx * 6 + 0.5, ay + 3, fz + dz * 6 + 0.5, yawOf(-dx || 0, -dz || 0), 18];
      // the rail on its corbels from inside, below the walk
      cams.cam_rail = [ax + dx * 9 + 0.5, ay - 2, az + dz * 9 + 0.5, yawOf(-dx || 0, -dz || 0), -12];
      // along the walk, on it (a player's view)
      const along = wk.cells.filter((c) => Math.abs(c[3] - wk.cells[0][3]) < 1e9).sort((p, q) => p[3] - q[3]);
      const i0 = along.findIndex((c) => c[0] === ax && c[2] === az);
      const ahead = along[Math.min(along.length - 1, Math.max(0, i0) + 8)];
      if (ahead) cams.cam_walk = [ax + 0.5, ay + 1.6, az + 0.5, yawOf(Math.sign(ahead[0] - ax), Math.sign(ahead[2] - az)), 5];
    }
    if (w.inside) {
      const [x0, z0] = w.inside;
      cams.cam_tower = [x0 + 6.5, (wk.cells.find((c) => c[0] === x0 && c[2] === z0)?.[1] ?? top) + 1.6, z0 + 0.5, 90, 5];
    }
  }
  return cams;
}
async function lookRound(out, dir, tag, plan, claim, bible, from = BASE, site = null) {
  if (!site) {
    await L.fresh(`G6B K2 Look ${tag}`, from);
    await L.setRules('gallery');
  }
  const [cx, cz] = centre(claim);
  await tp(cx, 140, cz);
  await L.settle(site ? 3000 : 20_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const c = await checkPlan(plan, claim, { anchors: site?.anchors ?? anchorsOf(claim), bible });
  const o = { overall: c.overall, parts: c.parts.map((p) => `${p.part}:${p.class}`), artifactSha: c.artifactSha, bible };
  out[tag] = o;
  check(['READY'].includes(c.overall), `look (${tag}): checks ${c.overall} (${o.parts.join(' ')})`);
  if (!c.artifactSha) return;
  const meta = planFiles(planDir(c.checkId)).meta;
  const cams = camsOf(meta);
  o.cams = cams;
  o.before = await shoot(cams, path.join(dir, tag, 'before'));
  const rr = await call('dev.region.realiseApproved', { sha: c.artifactSha }, 300_000);
  const st = await waitPlaced(rr.region);
  check(st.view.state === 'PLACED', `look (${tag}): realised (${st.view.cellsWritten} cells)`);
  await L.settle(5000);
  o.after = await shoot(cams, path.join(dir, tag, 'after'));
  // (the coordinator's ask) the walk at dusk: its lamps lit
  if (cams.cam_walk || cams.cam_access) {
    await cmd('/time set 13000');
    await L.settle(3000);
    o.dusk = await shoot(Object.fromEntries(Object.entries(cams).filter(([k]) => ['cam_walk', 'cam_access', 'cam_high'].includes(k))), path.join(dir, tag, 'dusk'));
    await cmd('/time set 6000');
  }
  o.wall = meta.walls.map((w) => ({ id: w.id, height: w.height, thickness: w.thickness, crenels: w.crenels, walk: w.walk ? { cells: w.walk.cells.length, accesses: w.walk.accesses.map((a) => a.kind), lamps: w.walk.lamps.length, parapetWall: w.walk.parapetWall } : null, along: w.along ? { kind: w.along.kind, side: w.along.side } : null }));
  await cmd('/kill @e[type=!minecraft:player]');
  await tp(cx, 300, cz);
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
  o.remove = { removed: rm.removed ?? null, restored: rm.restored ?? null };
  await leaveWorld();
}

steps.look = async () => {
  await ensure();
  const out = {};
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  for (const b of LOOK_BIBLES) installBible(b);
  for (const bible of LOOK_BIBLES) await lookRound(out, dir, `walk_${bible}`, WALK, [...S7.fixture.claim], bible);
  await lookRound(out, dir, 'shore_g6cv_village', { ...SHORE, connectors: SHORE.connectors.map((c) => ({ ...c, walk: true })) }, [...S3.fixture.claim], 'g6cv_village');
  // (the coordinator's ask) a shore gate on its landing: k2/k2_look_bank's stepped bank built over the flat base (RS's terrain builder)
  {
    const G = await import('./lib/gate6crs-game.mjs');
    const core = await import('./lib/gate6chy-core.mjs');
    const B = await import('./lib/gate6chy-b.mjs');
    const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
    const fx = readFx('k2', 'k2_look_bank.json');
    const site = await G.site(ctx, 'k2 look bank', fx, { creative: true, rules: 'gallery' });
    await lookRound(out, dir, 'bank_landing_g6cv_village', site.wp.plan, site.W.claim, 'g6cv_village', FLAT, { anchors: site.wp.anchors });
  }
  fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'natural', 'survival', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-K2 (walls along a boundary, wall walks)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ak2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
