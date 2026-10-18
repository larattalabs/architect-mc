#!/usr/bin/env node
// Phase 7a slice K1b gate (docs/CONTRACT.md "Phase 7a slice K1" §10: item 5, the rope parts of items 6-15) against a dev client or the
// headless server of the K1b run worktree (`../architect-mc-K1b-run`, a detached worktree at this checkout's HEAD; the sim sidecar,
// no Claude). Ports 8918 (sidecar) / 8919 (DevBridge); the look step's client 8920 / 8921. $0: no Claude call anywhere.
//
//   node tools/gate7ak1b.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit                              items 5-8, 10-12, 15 offline: the kit's K1b tests (the profile over every span and rise, the span
//                                       checks, the rope move, M10:rope and the broken variants, v33/v34, the refusal fixtures, §9's rope
//                                       rows, determinism), P0's tests (item 15), the goldens that must not move (item 12, links_demo's
//                                       own), the whole kit suite
//     unchanged                         item 6: every valid/ fixture without a K1 part answers as on origin/main and plans the same IR
//                                       (but its kitVersion), main's kit read from a detached worktree at origin/main
//     probe                             the villager bar's first look: slab-deck bridges built by commands (spans 8-40, rise -5..5, widths
//                                       1 and 2) and vanilla dev.nav.villager across both ways; a holed deck is the negative control
//     ingame                            items 5 and 9 on a flat world (headless): links_demo (spans 8, 24, 40) planned (its IR sha against
//                                       the golden), realised, re-read from the dumps: the profile per deck cell, steps, rails, head room,
//                                       0 dark deck cells, 4 posts 2 deep on solid ground, M3 0, player and villager across (kit) and
//                                       vanilla dev.nav.villager both ways (the hard bar); Regions.remove exact (E-flat 0)
//     natural                           items 5 and 9 over rift_city on the pinned rift site (a fresh copy of the seed world): the same,
//                                       and the removal's E-normal classified (unclassified at most 0.01% of the box)
//     look                              the look (client, recorded not judged): links_demo over the flat ravine and a rope bridge over a
//                                       water basin (a plan check through Regions.checkPlan), cameras for the gallery
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-k1/k1b/<step>.json in the main checkout (GATE7AK1B_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitReuse } from './lib/kit-reuse.mjs';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-K1b-run');
process.env.GATE6B_OUT = process.env.GATE7AK1B_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-k1', 'k1b');
process.env.GATE6B_SIDECAR_PORT ??= '8918';
process.env.GATE6B_DEV_PORT ??= '8919';
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, state, startClient, stopClient, tp } = L;

refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:k1b';
const FLAT_CLAIM = [6000, 6000, 6191, 6111];
const RIFT_SITE = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'sites', 'rift_site.json'), 'utf8')).fixture.claim;
const GOLD = path.join(root, 'scenarios', 'goldens');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => JSON.stringify(o).replaceAll(' ', '');

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice K1b is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G7A K1b Lobby', { backend: 'sim' });
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

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}
/** The kit suite once per gate run (tools/lib/kit-reuse.mjs): files whose checks are pass/fail only take this run's unit-kit results when exact. */
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.k1b = nodeTest(['kit/test/rope-k1b.test.mjs', 'kit/test/plan-k1b.test.mjs']);
  check(out.k1b.code === 0 && out.k1b.fail === 0 && out.k1b.pass >= 17, `items 5, 6, 7, 10, 11 (kit): the profile over every span 8-40 and rise, the span checks in order, ropeCells and the primitive (M10:rope, rails, head room, M3, both movers on the slab deck), the broken variants (posts 1 deep: M10:rope; no rails: M8; the whole-block deck off the formula; the whole-block deck on a villager edge: MOVER), the rope move (exactly one span, off without spans), links_demo flat (8, 24, 40, soul lanterns), v33 and v34, the refusal fixtures, §9 (treetop's 9 NO_GAP with a path wouldFit that fits alone, swamp_stilts, upside_down), determinism: ${out.k1b.pass} pass, ${out.k1b.fail} fail`, out.k1b.failing);
  out.p0 = kitOnce(['kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/plan-p0-det-1.test.mjs', 'kit/test/plan-p0-det-2.test.mjs', 'kit/test/plan-p0-det-3.test.mjs', 'kit/test/plan-p0-asks.test.mjs', 'kit/test/k1-foundation.test.mjs']);
  check(out.p0.code === 0 && out.p0.fail === 0, `item 15: P0's tests after K1 (the valid/ fixtures with v33 and v34 fit, item 9's catalogue coverage, item 11's asks): ${out.p0.pass} pass, ${out.p0.fail} fail`, out.p0.failing);
  out.goldens = kitOnce(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 12: S1, S7, S2, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo, districts_demo tile goldens and links_demo's own; T2's routes; the lint (lib/connectors on the plan path): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  const gl = ['links_demo.json', 'links_demo_flat.json'].filter((f) => fs.existsSync(path.join(GOLD, f)));
  check(gl.length === 2, `item 10: links_demo's goldens committed (${gl.join(', ') || 'none'})`);
  out.kit = kitOnce(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  // a detached worktree of origin/main beside this one (read-only use: its kit is imported by path)
  const mainDir = path.resolve(root, '..', 'architect-mc-K1b-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', 'valid');
  const names = fs.readdirSync(fixDir).filter((f) => f.endsWith('.json')).sort();
  const out = { mainHead, fixtures: {} };
  let same = 0, k1 = 0;
  for (const f of names) {
    const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
    if ((fx.plan.connectors ?? []).some((c) => ['wall', 'gate', 'rope_bridge', 'auto'].includes(c.kind))) { k1++; continue; }
    // ((6c T3) a bridge or tunnel fixture, on its own terrain: T3's gate judges it (tools/gate6ct3a.mjs unchanged))
    if (fx.terrain || (fx.plan.connectors ?? []).some((c) => ['bridge', 'tunnel'].includes(c.kind))) continue;
    const sv = (h) => (fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : h.goldenSurvey(fx.on));
    const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
    const a = await runOn(hNew), b = await runOn(hOld);
    const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
    const answers = (r) => JSON.stringify(r.check.parts);
    const eq = { answers: answers(a) === answers(b), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall };
    out.fixtures[f] = eq;
    if (eq.answers && eq.ir && eq.overall) same++;
  }
  const n = Object.keys(out.fixtures).length;
  check(n >= 20 && same === n, `item 6: ${same} of ${n} valid/ fixtures without a K1 part answer as on origin/main ${mainHead.slice(0, 10)} and plan the same IR but its kitVersion (${k1} K1 fixtures skipped)`, Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall)));
  return out;
};

// ------------------------------------------------------------------ in game

steps.probe = async () => {
  await ensure();
  await L.fresh('G6B K1b Probe', FLAT);
  await L.setRules('exact');
  const { profile } = await imp('lib/connectors/ropeGeom.mjs');
  const GROUND = -61, Y0 = -40;
  const cases = [{ n: 40, rise: 5, w: 2 }, { n: 40, rise: -5, w: 2 }, { n: 40, rise: 0, w: 2 }, { n: 24, rise: 3, w: 2 }, { n: 24, rise: 0, w: 2 }, { n: 8, rise: 1, w: 2 }, { n: 8, rise: 0, w: 2 }, { n: 36, rise: 4, w: 2 }, { n: 40, rise: 5, w: 1 }, { n: 24, rise: 0, w: 2, broken: true }];
  const out = [];
  let z0 = 7040;
  for (const c of cases) {
    const x0 = 7040, { n, rise, w } = c;
    await tp(x0 + n / 2, Y0 + 10, z0);
    await call('dev.waitChunks', { timeoutMs: 30_000 }).catch(() => null);
    await cmd(`/fill ${x0 - 8} ${GROUND + 1} ${z0 - 3} ${x0 + n + 9} ${Y0 + 12} ${z0 + w + 2} air`);
    await cmd(`/fill ${x0 - 7} ${GROUND} ${z0 - 2} ${x0} ${Y0} ${z0 + w + 1} stone`);
    await cmd(`/fill ${x0 + n + 1} ${GROUND} ${z0 - 2} ${x0 + n + 8} ${Y0 + rise} ${z0 + w + 1} stone`);
    const ys = profile(n, Y0, rise);
    for (let i = 1; i <= n; i++) {
      if (c.broken && i === Math.floor(n / 2)) continue;
      const y2 = ys[i], odd = (y2 & 1) === 1, cell = Math.floor((y2 + 1) / 2), x = x0 + i;
      for (let l = -1; l <= w; l++) {
        const z = z0 + l;
        if (odd) { await cmd(`/setblock ${x} ${cell} ${z} oak_slab[type=bottom]`); await cmd(`/setblock ${x} ${cell - 1} ${z} oak_planks`); } else await cmd(`/setblock ${x} ${cell} ${z} oak_planks`);
        if (l === -1 || l === w) await cmd(`/setblock ${x} ${cell + 1} ${z} oak_fence`);
      }
    }
    await cmd('/kill @e[type=!minecraft:player]');
    const a = [x0 - 3, Y0 + 1, z0], b = [x0 + n + 4, Y0 + rise + 1, z0];
    const there = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const back = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out.push({ ...c, there: !!there.canReach, back: !!back.canReach, nodes: [there.nodes, back.nodes] });
    z0 += 12;
  }
  const good = out.filter((c) => !c.broken), bad = out.filter((c) => c.broken);
  check(good.every((c) => c.there && c.back), `the villager bar (probe): vanilla dev.nav.villager crosses every slab-deck bridge both ways (${good.map((c) => `${c.n}/${c.rise}/w${c.w}`).join(', ')})`, good.filter((c) => !(c.there && c.back)));
  check(bad.every((c) => !c.there && !c.back), 'the probe\'s negative control: a deck with a hole is not crossed');
  await leaveWorld();
  return { cases: out };
};

/** The realised world from two dumps (the plan's virtual world marks its cells) and the checker on it. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false });
  return { ir, meta, world, rep };
}

/** Item 5 over the realised world: every bridge's profile, steps, rails, head room, posts; dark deck cells; M3; both kit movers across. */
async function item5(tag, { ir, meta, world, rep }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.ropes?.per ?? [];
  const out = { bridges: per.map((q) => ({ n: q.n, rise: q.rise, cells: q.cells, wrong: q.wrong, missing: q.missing, maxStep: q.maxStep, railed: q.railed, headroom: q.headroom, postsOk: q.postsOk, posts: q.posts })), M5rope: rep.metrics.M5rope, M3: rep.metrics.M3 ?? null };
  check(per.length === (meta.ropes ?? []).length && per.length >= 1, `item 5 (${tag}): ${per.length} rope bridge(s) re-read from the realised world (${per.map((q) => q.n).join(', ')} deck cells)`);
  check(per.every((q) => q.wrong === 0 && q.missing === 0), `item 5 (${tag}): every deck cell's half-block surface equals the formula (${per.map((q) => `${q.cells - q.wrong - q.missing}/${q.cells}`).join(', ')})`);
  check(per.every((q) => q.maxStep <= 1), `item 5 (${tag}): adjacent steps at most one half block, landings included (max ${Math.max(...per.map((q) => q.maxStep))})`);
  check(per.every((q) => q.railed === q.n), `item 5 (${tag}): rails both sides on 100% of deck cells (${per.map((q) => `${q.railed}/${q.n}`).join(', ')})`);
  check(per.every((q) => q.headroom === q.n), `item 5 (${tag}): 2 head room over 100% of deck cells (${per.map((q) => `${q.headroom}/${q.n}`).join(', ')})`);
  check(rep.metrics.M5rope && rep.metrics.M5rope.darkSpawnable === 0 && rep.metrics.M5rope.deckCells > 0, `item 5 (${tag}): 0 dark spawnable deck cells (M5 over the realised light: ${json(rep.metrics.M5rope)})`);
  check(per.every((q) => q.postsOk === 4), `item 5 (${tag}): 4 posts per bridge, each 2 deep on solid ground in the realised world (${per.map((q) => q.postsOk).join(', ')})`);
  const m3 = rep.findings.filter((f) => /^M3/.test(f.rule) && (meta.ropes ?? []).some((q) => q.part === f.part));
  check(!m3.length, `item 5 (${tag}): M3 0 floating cells in the rope parts (${m3.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  out.movers = {};
  for (const q of meta.ropes ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    out.movers[q.id] = Object.fromEntries(['player', 'villager'].map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
  }
  check(Object.values(out.movers).every((v) => v.player), `item 5 (${tag}): player across 100% (kit mover, both ways)`);
  check(Object.values(out.movers).every((v) => v.villager), `item 5 (${tag}): villager across 100% on the width-2 slab bridges (kit mover, both ways)`);
  void ir;
  return out;
}

/** Vanilla's villager path across every bridge, both ways (the hard bar), from landing to landing (feet cells). */
async function nav(meta) {
  const out = {};
  for (const q of meta.ropes ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out[q.id] = { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null], end: [ab.end ?? null, ba.end ?? null] };
  }
  return out;
}

/** Plan, realise, re-read, nav, remove: one links_demo run in the open world. */
async function linksRun(tag, claim, { flat, golden }) {
  const out = { claim };
  const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);
  await tp((claim[0] + claim[2]) / 2, flat ? -20 : 160, (claim[1] + claim[3]) / 2);
  let p = await L.plan('links_demo', claim, { surveyLoad: 'bounded:256', check: flat, owner: OWNER });
  if (!flat) {
    // as the scenarios do: the chunks generated (prepare), then the plan again over the generated survey with ticks frozen
    await L.prepare(p.planId);
    await cmd('/tick freeze');
    try { p = await L.plan('links_demo', claim, { surveyLoad: 'generated:64', check: true, owner: OWNER }); } finally { await cmd('/tick unfreeze'); }
  }
  const planDir = sideDir(p.planId);
  out.plan = { planId: p.planId, irSha: p.irSha, notes: p.notes ?? null };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  check((meta.ropes ?? []).length >= 1, `${tag}: links_demo planned ${(meta.ropes ?? []).length} rope bridge(s) (${(meta.ropes ?? []).map((q) => q.n).join(', ')} deck cells; ${(meta.links?.picks ?? meta.links?.sections ?? []).length} sites)`);
  // the golden: its committed inputs (written once by `golden`), compared by IR sha and every tile sha
  const { tileShas } = await import('./scenarios.mjs');
  const ts = await tileShas(planDir);
  out.tiles = { irSha: ts.irSha, workersSame: ts.workersSame, count: Object.keys(ts.tiles).length };
  const gFile = path.join(GOLD, `${golden}.json`);
  if (process.env.K1B_WRITE_GOLDEN === '1') {
    const gDir = path.join(GOLD, golden);
    fs.mkdirSync(path.join(gDir, 'blobs'), { recursive: true });
    for (const f of ['ir.json', 'survey.bin']) fs.copyFileSync(path.join(planDir, f), path.join(gDir, f));
    if (fs.existsSync(path.join(planDir, 'blobs'))) for (const f of fs.readdirSync(path.join(planDir, 'blobs'))) fs.copyFileSync(path.join(planDir, 'blobs', f), path.join(gDir, 'blobs', f));
    fs.writeFileSync(gFile, `${JSON.stringify({ scenario: golden, version: 0, note: `tile shas of the IR over its own plan survey, 1 worker = 4 workers shuffled; inputs in goldens/${golden}/ (written by tools/gate7ak1b.mjs ${tag})`, irSha: ts.irSha, kitVersion: JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8')).kitVersion, cells: ts.cells, tiles: ts.tiles }, null, 1)}\n`);
    out.golden = 'written';
  } else if (fs.existsSync(gFile)) {
    const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
    out.golden = { match: g.irSha === ts.irSha && JSON.stringify(g.tiles) === JSON.stringify(ts.tiles) };
    check(out.golden.match && ts.workersSame, `item 10 (${tag}): the plan's IR sha and every tile sha equal the golden ${golden} (1 = 4 workers)`);
  }
  // the box: the claim + 8 over the plan's written y span +- 8 (its virtual world), as the scenarios' exactness box
  const { buildVirtual } = await imp('lib/region/vworld.mjs');
  const irP = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const blobsP = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw: vP } = buildVirtual({ ir: irP, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs: blobsP });
  let y0 = Infinity, y1 = -Infinity;
  vP.eachWritten((x, y) => { if (y < y0) y0 = y; if (y > y1) y1 = y; });
  const box = [claim[0] - 8, Math.max(-64, y0 - 8), claim[1] - 8, claim[2] + 8, Math.min(319, y1 + 8), claim[3] + 8];
  await tp((claim[0] + claim[2]) / 2, Math.min(319, y1 + 20), (claim[1] + claim[3]) / 2);
  await L.settle(flat ? 5000 : 60_000);
  const before = path.join(OUT, `${tag}-before.arwd.gz`), after = path.join(OUT, `${tag}-after.arwd.gz`), snapF = path.join(OUT, `${tag}-snap.gz`);
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  const snap = await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 4 * 3_600_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3 * 3_600_000, async (s) => { if (s.waiting?.OCCUPIED) await cmd('/kill @e[type=!minecraft:player]'); });
  out.realise = { state: st.view.state, cells: st.record?.cellsWritten ?? st.view.cellsWritten };
  check(st.view.state === 'PLACED', `${tag}: realised (${st.view.state}, ${out.realise.cells} cells)`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const R = await realisedOf(planDir, before, after);
  out.item5 = await item5(tag, R);
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 5 (${tag}, the hard bar): vanilla dev.nav.villager across every width-2 slab bridge, both ways (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // item 9: the removal by its owner
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const cells = (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, cells, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 9 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored)`);
  else {
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    check(rm.removed && none <= Math.floor(cells * 0.0001), `item 9 (${tag}): the removal's E-normal classified: ${diff.mismatches} mismatches (${json(diff.classes ?? {})}), unclassified ${none} <= 0.01% of ${cells}`);
  }
  return out;
}

steps.ingame = async () => {
  await ensure();
  await L.fresh('G6B K1b Links Flat', FLAT);
  await L.setRules('exact');
  const out = await linksRun('flat', FLAT_CLAIM, { flat: true, golden: 'links_demo_flat' });
  await leaveWorld();
  spendZero();
  return out;
};

steps.natural = async () => {
  await ensure();
  await L.fresh('G6B K1b Links Rift', BASE);
  await L.setRules('default');
  const out = await linksRun('natural', RIFT_SITE, { flat: false, golden: 'links_demo' });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

/** A camera shot from `eye` looking at `at` (the client's own camera), saved into OUT/look. */
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `k1b_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [] };
  await L.fresh('G6B K1b Look', FLAT);
  await L.setRules('exact');
  await cmd('/time set 6000');
  await cmd('/weather clear');
  // the ravine: links_demo on the flat claim
  await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 100, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
  const p = await L.plan('links_demo', FLAT_CLAIM, { surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'meta.json'), 'utf8'));
  const region = await L.realise(p.planId, {});
  const st = await L.waitRegion(region, 3_600_000);
  out.ravine = { planId: p.planId, state: st.view.state, ropes: (meta.ropes ?? []).map((q) => ({ id: q.id, n: q.n, from: q.from, to: q.to })) };
  const longest = (meta.ropes ?? []).reduce((a, q) => (!a || q.n > a.n ? q : a), null);
  if (longest) {
    const mid = [longest.from[0], longest.from[1], Math.floor((longest.from[2] + longest.to[2]) / 2)];
    out.shots.push(await shot('ravine_side', [mid[0] + 26.5, mid[1] + 3, mid[2] + 0.5], [mid[0] - 0.5, mid[1] - 1, mid[2] + 0.5]));
    out.shots.push(await shot('ravine_deck', [longest.from[0] - 0.5, longest.from[1] + 2.6, longest.from[2] - 2.5], [longest.to[0] - 0.5, longest.to[1] + 1, longest.to[2] + 0.5]));
    out.shots.push(await shot('ravine_high', [mid[0] + 40.5, mid[1] + 34, mid[2] + 30.5], [mid[0] - 30, mid[1] - 8, mid[2]]));
    out.shots.push(await shot('ravine_under', [mid[0] + 10.5, mid[1] - 12, mid[2] + 0.5], [mid[0] - 0.5, mid[1], mid[2] + 0.5]));
  }
  // over water: a stone basin with a water channel (built by commands: the world's own), and a rope bridge checked through
  // Regions.checkPlan between anchors on its banks, then realised from the approved artifact
  // (the flat base's surface is y 64: the basin's banks rise 15 over it, the water stands 4 under their rim)
  const W0 = [6400, 6000], G = 64, top = G + 15;
  await tp(W0[0] + 32, top + 20, W0[1] + 32);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await cmd(`/fill ${W0[0]} ${G + 1} ${W0[1]} ${W0[0] + 63} ${top} ${W0[1] + 63} minecraft:stone`);
  await cmd(`/fill ${W0[0]} ${top} ${W0[1]} ${W0[0] + 63} ${top} ${W0[1] + 63} minecraft:grass_block`);
  await cmd(`/fill ${W0[0] + 2} ${G + 1} ${W0[1] + 22} ${W0[0] + 61} ${top} ${W0[1] + 41} minecraft:air`);
  await cmd(`/fill ${W0[0] + 2} ${G + 1} ${W0[1] + 22} ${W0[0] + 61} ${top - 4} ${W0[1] + 41} minecraft:water`);
  await L.settle(5000);
  const anchors = { w_n: [W0[0] + 32, top + 1, W0[1] + 21], w_s: [W0[0] + 32, top + 1, W0[1] + 42] };
  const plan = { schemaVersion: 'plan/0', planId: 'k1b_water', connectors: [{ id: 'over_water', kind: 'rope_bridge', from: { anchor: 'w_n' }, to: { anchor: 'w_s' } }] };
  const claim = [W0[0] - 8, W0[1] - 8, W0[0] + 71, W0[1] + 71];
  const c = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors }, 900_000);
  out.water = { overall: c.check?.overall ?? null, parts: c.check?.parts ?? null, refused: c.refused ?? null };
  if (c.check?.artifactSha) {
    const rr = await call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
    const st2 = await L.waitRegion(rr.region, 3_600_000);
    out.water.state = st2.view.state;
    const g = c.check.parts.find((a) => a.part === 'over_water')?.geometry?.spans?.[0];
    if (g) {
      const mid = [g.from[0], g.from[1], Math.floor((g.from[2] + g.to[2]) / 2)];
      out.shots.push(await shot('water_side', [mid[0] + 20.5, mid[1] + 2, mid[2] + 0.5], [mid[0] - 0.5, mid[1] - 2, mid[2] + 0.5]));
      out.shots.push(await shot('water_deck', [g.from[0] - 0.5, g.from[1] + 2.6, g.from[2] - 2.5], [g.to[0] - 0.5, g.to[1] + 1, g.to[2] + 0.5]));
    }
  }
  await call('dev.release', {}).catch(() => null);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'probe', 'ingame', 'natural', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-K1b (rope bridges and connector.auto)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ak1b.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
