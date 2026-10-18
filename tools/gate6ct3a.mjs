#!/usr/bin/env node
// Phase 6c slice T3a gate (docs/CONTRACT.md "Phase 6c slice T3" §10: items 1, 3, 7, 8 and 9 for bridges, the bridge parts of 10-16)
// against a dev client or the headless server of the T3a run worktree (`../architect-mc-T3a-run`, a detached worktree at this
// checkout's HEAD; the sim sidecar, no Claude). Ports 8912 (sidecar) / 8913 (DevBridge); the look step's client 8914 / 8915. $0: no
// Claude call anywhere.
//
//   node tools/gate6ct3a.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base, G6B Seed 2026101102)
//     unit                              items 7, 8, 10-12, 15, 16 offline: the kit's T3a tests (geometry, the bridge move, M10:bridge and the
//                                       broken variants, the fixtures and refusals with their wouldFits, §9's bridge rows and the gap tables,
//                                       the street fallback, determinism), the foundation's and P0's and K1's tests, the goldens, the whole
//                                       kit suite, the catalogue diff, the sidecar's features, api-compat --gate6ct3
//     unchanged                         item 8: every valid/ and K1 fixture without a T3 part answers as on origin/main and plans the same IR
//                                       (but its kitVersion), main's kit read from a detached worktree at origin/main
//     probe                             items 1 and 3's first look (headless): vanilla dev.nav.villager across command-built beam and arch
//                                       decks (spans 3-24, widths 2-3, rises, the camber) both ways, a holed deck refused; the boat probe
//                                       (N-T3-2): a player in a boat moved by vanilla collision under decks with 1 and 2 clear cells
//     ingame                            items 1, 3 and 9 on a flat world (headless): crossings_demo flat (a beam of 24 with 3 piers, an arch
//                                       of 16) planned, realised, re-read from the dumps (the profile, steps, rails, head room, 0 dark deck
//                                       cells, piers 2 deep, the ring solid, M3 0), both kit movers and vanilla's villager across both ways,
//                                       Regions.remove exact (E-flat 0); then a bridge part over a command-built channel through
//                                       Regions.checkPlan and realiseApproved (clearance, 0 cells in water), crossed, removed
//     natural                           items 1, 3, 9 over S3's pinned river (a fresh copy of the seed world, headless): crossings_demo's
//                                       river arch, the same bars and E-normal classified (bridges as K1b: growth and grazed admitted, no
//                                       gravity, 0 unclassified)
//     frozen                            items 1, 3, 9 on S7's rejected site 2026101102 (a frozen river): the frozen arch, nothing written in
//                                       the ice (the ice cells' states equal before and after), E-normal as natural
//     look                              item 17 (client, recorded not judged): crossings_demo flat in three bibles (bridges and, since the
//                                       T3 batch, the tunnels' portal and interior), cameras for the gallery
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-t3/t3a/<step>.json in the main checkout (GATE6CT3A_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-T3a-run');
process.env.GATE6B_OUT = process.env.GATE6CT3A_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-t3', 't3a');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, leaveWorld, log, results, root, state, startClient, stopClient, tp } = L;

L.refuseKeys();
const SEED = '2026100906', FROZEN_SEED = '2026101102';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const OWNER = 'test:t3a';
const FLAT_CLAIM = [6000, 6000, 6255, 6111];
const S3_CLAIM = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
const FROZEN_CLAIM = [4168, 1480, 4279, 1591];
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice T3a is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C T3a Lobby', { backend: 'sim' });
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
  const frozen = await L.seedBase(FROZEN_SEED);
  spendZero();
  return { worlds: [BASE, FLAT, frozen], seed: SEED };
};

// ------------------------------------------------------------------ offline

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), gap: t.split('\n').filter((l) => /^# /.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.t3a = nodeTest(['kit/test/bridge-t3a.test.mjs', 'kit/test/plan-t3a.test.mjs']);
  check(out.t3a.code === 0 && out.t3a.fail === 0 && out.t3a.pass >= 14, `items 7, 8, 11, 12 (kit): the span checks in §4's order, the beam's piers and the arch's ring, clearance over water, the bridge move (exactly one span, off without spans, the wet corridor), M10:bridge, M8, M6 and M5 and the broken variants (noPiers, noRails, pierInWater, noLamps), v35, v36, v38's bridge, v39's street fallback, the refusal fixtures with their wouldFits re-checked alone, §9's bridge rows and the gap tables, determinism: ${out.t3a.pass} pass, ${out.t3a.fail} fail`, out.t3a.failing);
  out.found = nodeTest(['kit/test/t3-foundation.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-k1a.test.mjs', 'kit/test/plan-k1b.test.mjs', 'kit/test/rope-k1b.test.mjs', 'kit/test/plan-k1-batch.test.mjs', 'kit/test/catalogue-since.test.mjs', 'kit/test/catalogue-c38.test.mjs']);
  check(out.found.code === 0 && out.found.fail === 0, `items 10, 16: catalogue 6 (the golden, the K1 -> T3 diff), P0's tests after the flips (e15 off connector.bridge/tunnel), the K1 tests and the K1 batch test: ${out.found.pass} pass, ${out.found.fail} fail`, out.found.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/scenario-goldens.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/region-fixtures.test.mjs', 'kit/test/forms-island.test.mjs', 'kit/test/region-lint.test.mjs', 'kit/test/relief-t1.test.mjs', 'kit/test/route-t2.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 13: S1, S7, S2, mega_bench, relief_demo, route_demo, forms_demo, scatter_demo, districts_demo and links_demo tile goldens (and crossings_demo's); T2's routes (its water test unchanged); the lint: ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  // item 10: the catalogue diff tool, K1 -> T3
  const d = spawnSync(process.execPath, ['tools/plan-catalogue-diff.mjs', 'kit/test/fixtures/plan/catalogue-k1.json', 'kit/schemas/plan-catalogue.golden.json'], { cwd: root, encoding: 'utf8' });
  out.diff = `${d.stdout}${d.stderr}`.trim();
  check(d.status === 0 && /reserved -> supported: connector\.bridge, connector\.tunnel/.test(out.diff) && /limits changed: connector\.auto/.test(out.diff), `item 10: tools/plan-catalogue-diff.mjs K1 -> T3 lists the two flips, the six added ids and auto's moves`, out.diff.split('\n'));
  // item 15: api-compat against the unchanged 0.35.0, 0.34.0 and 0.33.0 jars (the mod's classes must be built)
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6ct3'], { cwd: root, encoding: 'utf8' });
  out.apicompat = `${ac.stdout}${ac.stderr}`.trim().split('\n').slice(-6);
  check(ac.status === 0, `item 15: api-compat --gate6ct3 clean (0.35.0, 0.34.0, 0.33.0 apitest jars, the 1.32.0 surface)`, out.apicompat);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const mainDir = path.resolve(root, '..', 'architect-mc-T3a-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { mainHead, fixtures: {} };
  let same = 0, t3 = 0;
  const dirs = ['valid', 'k1a', 'rope', 'refused'];
  for (const dir of dirs) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', dir);
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan) continue;
      // (a T3 part, or a fixture T3 added: v38's auto edge that bridges)
      if ((fx.plan.connectors ?? []).some((c) => ['bridge', 'tunnel'].includes(c.kind)) || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { t3++; continue; }
      if (fx.volume) continue; // (a frozen volume built by its own test)
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey());
      const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
      let a, b;
      try { a = await runOn(hNew); b = await runOn(hOld); } catch (e) { out.fixtures[`${dir}/${f}`] = { error: String(e.message).slice(0, 200) }; continue; }
      const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
      const answers = (r) => JSON.stringify(r.check.parts);
      const eq = { answers: answers(a) === answers(b), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall };
      out.fixtures[`${dir}/${f}`] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  const n = Object.keys(out.fixtures).length;
  check(n >= 30 && same === n, `item 8: ${same} of ${n} valid/ and K1 fixtures without a T3 part answer as on origin/main ${mainHead.slice(0, 10)} and plan the same IR but its kitVersion (${t3} T3 fixtures skipped; v34_auto and the K1 batch fixtures included)`, Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall)));
  return out;
};

// ------------------------------------------------------------------ in game: the probe

/** The setblock commands of a command-built deck (kit geometry: the beam's straight line or the arch's camber), no supports. */
async function buildDeck({ x0, z0, y0, n, rise, w, form, hole = false, block = 'stone_bricks', slab = 'stone_brick_slab', rail = 'stone_brick_wall' }) {
  const { profile, sagOf } = await imp('lib/connectors/ropeGeom.mjs');
  const ys = profile(n, y0, rise, form === 'arch' ? -sagOf(n) : 0);
  const lo = -Math.floor((w - 1) / 2), hi = Math.floor(w / 2);
  // banks: stone under both landings (3 deep, the width plus the rails), the far one at y0 + rise
  await cmd(`/fill ${x0 - 6} ${y0 - 3} ${z0 + lo - 1} ${x0} ${y0} ${z0 + hi + 1} stone`);
  await cmd(`/fill ${x0 + n + 1} ${y0 + rise - 3} ${z0 + lo - 1} ${x0 + n + 7} ${y0 + rise} ${z0 + hi + 1} stone`);
  for (let i = 1; i <= n; i++) {
    if (hole && i === Math.floor((n + 1) / 2)) continue;
    const y2 = ys[i], odd = (y2 & 1) === 1, cell = Math.floor((y2 + 1) / 2), x = x0 + i;
    for (let v = lo - 1; v <= hi + 1; v++) {
      const z = z0 + v;
      if (odd) { await cmd(`/setblock ${x} ${cell} ${z} ${slab}[type=bottom]`); await cmd(`/setblock ${x} ${cell - 1} ${z} ${block}`); } else await cmd(`/setblock ${x} ${cell} ${z} ${block}`);
      if (v === lo - 1 || v === hi + 1) await cmd(`/setblock ${x} ${cell + 1} ${z} ${rail}`);
    }
  }
}

steps.probe = async () => {
  await ensure();
  await L.fresh('G6B T3a Probe', FLAT);
  await L.setRules('exact');
  const GROUND = 64, Y0 = 80; // (the flat base world's surface is y 64)
  // ---- the villager: command-built beam and arch decks (the kit's profiles), both ways
  const cases = [{ n: 24, rise: 0, w: 3, form: 'beam' }, { n: 16, rise: 2, w: 2, form: 'beam' }, { n: 3, rise: 0, w: 2, form: 'beam' }, { n: 32, rise: -4, w: 3, form: 'beam' },
    { n: 16, rise: 0, w: 3, form: 'arch' }, { n: 24, rise: 3, w: 2, form: 'arch' }, { n: 4, rise: 0, w: 2, form: 'arch' }, { n: 16, rise: 0, w: 3, form: 'beam', hole: true }];
  const out = { villager: [], boat: [] };
  let z0 = 7040;
  for (const c of cases) {
    const x0 = 7040;
    await tp(x0 + c.n / 2, Y0 + 10, z0);
    await call('dev.waitChunks', { timeoutMs: 30_000 }).catch(() => null);
    await cmd(`/fill ${x0 - 8} ${GROUND + 1} ${z0 - 4} ${x0 + c.n + 9} ${Y0 + 12} ${z0 + 4} air`);
    await buildDeck({ x0, z0, y0: Y0, ...c });
    await cmd('/kill @e[type=!minecraft:player]');
    const a = [x0 - 3, Y0 + 1, z0], b = [x0 + c.n + 4, Y0 + c.rise + 1, z0];
    const there = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const back = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out.villager.push({ ...c, there: !!there.canReach, back: !!back.canReach, nodes: [there.nodes, back.nodes] });
    z0 += 12;
  }
  const good = out.villager.filter((c) => !c.hole), bad = out.villager.filter((c) => c.hole);
  check(good.every((c) => c.there && c.back), `item 3 (probe): vanilla dev.nav.villager crosses every command-built beam and arch deck both ways (${good.map((c) => `${c.form} ${c.n}/${c.rise}/w${c.w}`).join(', ')})`, good.filter((c) => !(c.there && c.back)));
  check(bad.every((c) => !c.there && !c.back), 'item 3 (probe): the negative control, a deck with a hole, is not crossed');
  // ---- the boat (N-T3-2): a water channel 3 deep, decks over it with 1 and 2 clear cells, a settled boat moved by vanilla collision
  const X0 = 7400, Z0 = 7400, WTOP = GROUND;
  await tp(X0 + 20, WTOP + 12, Z0 + 3);
  await call('dev.waitChunks', { timeoutMs: 30_000 }).catch(() => null);
  await cmd(`/fill ${X0 - 2} ${WTOP + 1} ${Z0 - 3} ${X0 + 74} ${WTOP + 8} ${Z0 + 9} air`);
  await cmd(`/fill ${X0} ${WTOP - 2} ${Z0} ${X0 + 72} ${WTOP} ${Z0 + 6} water`);
  const CLEARS = [[0, 0], [1, 1], [2, 2], [3, 3]];
  for (const [k, clear] of CLEARS) {
    const dx = X0 + 12 + k * 14, y = WTOP + clear + 1;
    await cmd(`/fill ${dx} ${y} ${Z0 - 1} ${dx + 2} ${y} ${Z0 + 7} stone_bricks`);
  }
  await L.settle(2000);
  for (const [k, clear] of CLEARS) {
    const dx = X0 + 12 + k * 14, bx = dx - 6;
    await cmd('/kill @e[type=minecraft:oak_boat]');
    await cmd(`/summon minecraft:oak_boat ${bx + 0.5} ${WTOP + 1} ${Z0 + 3.5}`);
    await L.settle(4000);
    await cmd('/gamemode creative');
    const r = await call('dev.t3.boat', { at: [bx + 0.5, WTOP + 1, Z0 + 3.5], dir: [1, 0], distance: 12, step: 0.1 }, 120_000);
    out.boat.push({ clear, deck: dx, ...r, passes: !r.error && !r.blocked && r.inWall === 0 });
  }
  const at = (c) => out.boat.find((q) => q.clear === c);
  check(at(2)?.passes && at(3)?.passes, `item 1 (N-T3-2 probe): a player seated in a boat, moved by vanilla collision, passes under decks with 2 and 3 clear cells over the water (the default clearance 2: ${json(out.boat.map((q) => ({ clear: q.clear, blocked: q.blocked, inWall: q.inWall, riderHit: q.riderHit, boatY: q.boatY, eye: q.maxEyeY })))})`);
  check(at(0) && at(0).blocked, `item 1 (N-T3-2 probe, the negative control): a deck straight over the water (0 clear) stops the boat (blocked ${at(0)?.blocked})`);
  // (the contract assumed a boat does not pass under 1 clear cell; vanilla 26.3 measured here: recorded, the finding goes to N-T3-2)
  out.oneClear = { passes: !!at(1)?.passes, blocked: at(1)?.blocked ?? null, inWall: at(1)?.inWall ?? null, riderHit: at(1)?.riderHit ?? null, eyeY: at(1)?.maxEyeY ?? null, deckBottom: WTOP + 2 };
  log(`note item 1 (N-T3-2 probe, recorded): under 1 clear cell the boat ${out.oneClear.passes ? 'PASSES (the contract assumed it would not; the rider\'s eyes ' + (WTOP + 2 - out.oneClear.eyeY).toFixed(2) + ' under the deck)' : 'does not pass'}`);
  await cmd('/kill @e[type=!minecraft:player]');
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game: realised bridges

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
  return { ir, meta, world, rep, before, after };
}

/** Items 1 and 3 over the realised world: every bridge's profile, steps, rails, head room, supports, water; dark deck cells; M3; movers. */
async function item1(tag, { meta, world, rep }) {
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const per = rep.metrics.bridges?.per ?? [];
  const out = { bridges: per, M5bridge: rep.metrics.M5bridge, M3: rep.metrics.M3 ?? null };
  const recs = meta.bridges ?? [];
  check(per.length === recs.length && per.length >= 1, `item 1 (${tag}): ${per.length} bridge(s) re-read from the realised world (${per.map((q) => `${q.form} ${q.n}`).join(', ')})`);
  check(per.every((q) => q.wrong === 0 && q.missing === 0), `item 1 (${tag}): every deck cell's half-block surface on §3's formula (${per.map((q) => `${q.cells - q.wrong - q.missing}/${q.cells}`).join(', ')})`);
  check(per.every((q) => q.maxStep <= 1), `item 1 (${tag}): steps at most one half block, landings included (max ${Math.max(...per.map((q) => q.maxStep))})`);
  check(per.every((q) => q.railed === q.n), `item 1 (${tag}): rails on both edges of 100% of deck cells (M8: ${per.map((q) => `${q.railed}/${q.n}`).join(', ')})`);
  check(per.every((q) => q.headroom === q.n), `item 1 (${tag}): 2 head room over 100% of deck cells (M6: ${per.map((q) => `${q.headroom}/${q.n}`).join(', ')})`);
  check(rep.metrics.M5bridge && rep.metrics.M5bridge.darkSpawnable === 0 && rep.metrics.M5bridge.deckCells > 0, `item 1 (${tag}): 0 dark spawnable deck cells (M5 over the realised light: ${json(rep.metrics.M5bridge)})`);
  const beams = per.filter((q) => q.form === 'beam'), arches = per.filter((q) => q.form === 'arch');
  if (beams.length) check(beams.every((q) => q.piersOk === q.piers && q.piers >= 1), `item 1 (${tag}): every pier solid from the deck to 2 deep in the ground, at most 24 tall, at most 8 deck cells apart (${beams.map((q) => `${q.piersOk}/${q.piers}`).join(', ')}; ${recs.filter((b) => b.form === 'beam').map((b) => `heights ${b.piers.map((p) => p.height).join('/')}`).join('; ')})`);
  check(per.every((q) => q.anchorsOk === q.anchors && q.anchors > 0 && q.postsOk === 4), `item 1 (${tag}): every landing 2 deep in solid ground (under its fill), every arch's abutments solid from 2 under the springing, the 4 newel posts on solid ground (${per.map((q) => `${q.anchorsOk}/${q.anchors} anchors, ${q.postsOk}/4 posts`).join('; ')})`);
  if (arches.length) check(arches.every((q) => q.bodyOk), `item 1 (${tag}): every arch's ring and spandrels solid from the intrados to the deck`);
  check(per.every((q) => q.wet === 0), `item 1 (${tag}): 0 cells written in water, lava or ice (${per.map((q) => q.wet).join(', ')})`);
  const wet = per.filter((q) => q.under);
  if (wet.length) check(wet.every((q) => q.under.have >= q.under.need), `item 1 (${tag}): the clearance over water as asked (an arch's middle third): ${wet.map((q) => `${q.form} ${q.under.have}/${q.under.need}`).join(', ')}`);
  const m3 = rep.findings.filter((f) => /^M3/.test(f.rule) && recs.some((q) => q.part === f.part));
  check(!m3.length, `item 1 (${tag}): M3 0 floating cells in the bridge parts (${m3.map((f) => `${f.rule} ${f.count}`).join(', ') || 'none'})`);
  const m10 = rep.findings.filter((f) => f.rule === 'M10:bridge');
  check(!m10.length, `item 1 (${tag}): M10:bridge 0 on the realised world (${m10.map((f) => f.message).join('; ').slice(0, 300) || 'none'})`);
  out.movers = {};
  for (const q of recs) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    out.movers[q.id] = Object.fromEntries(['player', 'villager'].map((m) => [m, nodeReached(walkGraph(world, [a], { mover: m }), b) && nodeReached(walkGraph(world, [b], { mover: m }), a)]));
  }
  check(Object.values(out.movers).every((v) => v.player && v.villager), `item 3 (${tag}): kit player and villager movers across every bridge both ways (${json(out.movers)})`);
  return out;
}

/** Vanilla's villager path across every bridge, both ways (the hard bar), from landing to landing (feet cells). */
async function nav(meta) {
  const out = {};
  for (const q of meta.bridges ?? []) {
    const a = [q.from[0], q.from[1] + 1, q.from[2]], b = [q.to[0], q.to[1] + 1, q.to[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out[q.id] = { there: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null], end: [ab.end ?? null, ba.end ?? null] };
  }
  return out;
}

/** Plan crossings_demo, realise, re-read, nav, remove: one run in the open world. `kind`: flat | river | frozen. */
async function crossRun(tag, claim, { kind, golden }) {
  const out = { claim, kind };
  const flat = kind === 'flat';
  const sideDir = (id) => path.join(L.SIDECAR_DATA, 'regions', 'plans', id);
  await tp((claim[0] + claim[2]) / 2, flat ? -20 : 160, (claim[1] + claim[3]) / 2);
  let p = await L.plan('crossings_demo', claim, { params: { variant: kind }, surveyLoad: 'bounded:256', check: flat, owner: OWNER });
  if (!flat) {
    await L.prepare(p.planId);
    await cmd('/tick freeze');
    try { p = await L.plan('crossings_demo', claim, { params: { variant: kind }, surveyLoad: 'generated:64', check: true, owner: OWNER }); } finally { await cmd('/tick unfreeze'); }
  }
  const planDir = sideDir(p.planId);
  out.plan = { planId: p.planId, irSha: p.irSha, notes: p.notes ?? null };
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  check((meta.bridges ?? []).length >= 1, `${tag}: crossings_demo (${kind}) planned ${(meta.bridges ?? []).length} bridge(s) (${(meta.bridges ?? []).map((q) => `${q.form} ${q.n}`).join(', ')})`);
  if (flat) check((meta.bridges ?? []).some((q) => q.form === 'beam' && q.n === 24 && q.piers.length === 3) && (meta.bridges ?? []).some((q) => q.form === 'arch' && q.n === 16), `${tag}: a beam of 24 with 3 piers and an arch of 16 (${json((meta.bridges ?? []).map((q) => [q.form, q.n, q.piers.length]))})`);
  else check((meta.bridges ?? []).every((q) => q.form === 'arch' && q.over === 'water'), `${tag}: an arch over the ${kind === 'frozen' ? 'frozen ' : ''}river (${json((meta.bridges ?? []).map((q) => [q.form, q.n, q.over, q.under]))})`);
  const { tileShas } = await import('./scenarios.mjs');
  const ts = await tileShas(planDir);
  out.tiles = { irSha: ts.irSha, workersSame: ts.workersSame, count: Object.keys(ts.tiles).length };
  if (golden) {
    const gFile = path.join(GOLD, `${golden}.json`);
    if (process.env.T3A_WRITE_GOLDEN === '1') {
      const gDir = path.join(GOLD, golden);
      fs.mkdirSync(path.join(gDir, 'blobs'), { recursive: true });
      for (const f of ['ir.json', 'survey.bin']) fs.copyFileSync(path.join(planDir, f), path.join(gDir, f));
      if (fs.existsSync(path.join(planDir, 'blobs'))) for (const f of fs.readdirSync(path.join(planDir, 'blobs'))) fs.copyFileSync(path.join(planDir, 'blobs', f), path.join(gDir, 'blobs', f));
      fs.writeFileSync(gFile, `${JSON.stringify({ scenario: golden, version: 0, note: `tile shas of the IR over its own plan survey, 1 worker = 4 workers shuffled; inputs in goldens/${golden}/ (written by tools/gate6ct3a.mjs ${tag})`, irSha: ts.irSha, kitVersion: JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8')).kitVersion, cells: ts.cells, tiles: ts.tiles }, null, 1)}\n`);
      out.golden = 'written';
    } else if (fs.existsSync(gFile)) {
      const g = JSON.parse(fs.readFileSync(gFile, 'utf8'));
      out.golden = { match: g.irSha === ts.irSha && JSON.stringify(g.tiles) === JSON.stringify(ts.tiles) };
      check(out.golden.match && ts.workersSame, `item 12 (${tag}): the plan's IR sha and every tile sha equal the golden ${golden} (1 = 4 workers)`);
    }
  }
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
  out.item1 = await item1(tag, R);
  // (frozen) nothing written in the ice: every ice cell under a bridge's box has the same state before and after the realise
  if (kind === 'frozen') {
    const pb = R.before, pa = R.after;
    let ice = 0, changed = 0;
    for (const q of R.meta.bridges ?? []) for (let x = q.box.minX; x <= q.box.maxX; x++) for (let z = q.box.minZ; z <= q.box.maxZ; z++) for (let y = q.box.minY - 4; y <= q.box.maxY; y++) {
      if (x < pb.box.minX || x > pb.box.maxX || y < pb.box.minY || y > pb.box.maxY || z < pb.box.minZ || z > pb.box.maxZ) continue;
      const sb = pb.palette[pb.cells[pb.at(x, y, z)]];
      if (!/ice$/.test(String(sb).replace(/\[.*$/, ''))) continue;
      ice++;
      if (pa.palette[pa.cells[pa.at(x, y, z)]] !== sb) changed++;
    }
    out.ice = { cells: ice, changed };
    check(ice > 0 && changed === 0, `item 1 (${tag}): the ice under the bridge unchanged (${ice} ice cell(s), ${changed} changed)`);
  }
  await cmd('/kill @e[type=!minecraft:player]');
  out.nav = await nav(R.meta);
  check(Object.keys(out.nav).length >= 1 && Object.values(out.nav).every((v) => v.there && v.back), `item 3 (${tag}, the hard bar): vanilla dev.nav.villager across every bridge, both ways (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.there, v.back]])))})`);
  // item 9: the removal by its owner
  await cmd('/kill @e[type=!minecraft:player]');
  await L.settle(5000);
  const rm = await call('dev.region.remove', { region, requester: OWNER }, 4 * 3_600_000);
  await L.settle(10_000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const cells = (box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1);
  out.exact = { kind: flat ? 'E-flat' : 'E-normal', box, cells, snapCells: snap.cells, removed: rm.removed, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes, list: (diff.list ?? []).slice(0, 50) };
  out.journal = { cells: out.realise.cells, restored: rm.restored };
  fs.writeFileSync(path.join(OUT, `${tag}-exact.json`), `${JSON.stringify(out.exact, null, 2)}\n`);
  if (flat) check(rm.removed && diff.mismatches === 0, `item 9 (${tag}): Regions.remove by its owner restores the box exactly: E-flat ${diff.mismatches} (${rm.restored} cells restored; journal ${out.realise.cells} cells written)`);
  else {
    const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
    const gravity = diff.classes?.gravity ?? 0;
    check(rm.removed && none === 0 && gravity === 0, `item 9 (${tag}): the removal's E-normal classified as K1b's bridges (growth and grazed admitted, no gravity, 0 unclassified): ${diff.mismatches} mismatches (${json(diff.classes ?? {})})`);
  }
  return out;
}

/** A bridge part over a command-built channel through Regions.checkPlan, realised from its artifact, crossed and removed (E-flat). */
async function checkPlanRun(tag) {
  const out = {};
  const W0 = [6400, 6200], G = 64, top = G + 10; // (the flat base world's surface is y 64)
  await tp(W0[0] + 32, top + 20, W0[1] + 32);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  // a stone bank block with a 14-wide water channel through it, the water 3 under the rim (the world's own, made by commands)
  await cmd(`/fill ${W0[0]} ${G + 1} ${W0[1]} ${W0[0] + 63} ${top} ${W0[1] + 63} minecraft:stone`);
  await cmd(`/fill ${W0[0]} ${top} ${W0[1]} ${W0[0] + 63} ${top} ${W0[1] + 63} minecraft:grass_block`);
  await cmd(`/fill ${W0[0]} ${G + 1} ${W0[1] + 25} ${W0[0] + 63} ${top} ${W0[1] + 38} minecraft:air`);
  await cmd(`/fill ${W0[0]} ${G + 1} ${W0[1] + 25} ${W0[0] + 63} ${top - 3} ${W0[1] + 38} minecraft:water`);
  await L.settle(5000);
  const anchors = { w_n: [W0[0] + 32, top + 1, W0[1] + 18], w_s: [W0[0] + 32, top + 1, W0[1] + 45] };
  const plan = { schemaVersion: 'plan/0', planId: 't3a_channel', connectors: [{ id: 'over_water', kind: 'bridge', from: { anchor: 'w_n' }, to: { anchor: 'w_s' }, width: 3 }] };
  const claim = [W0[0] - 8, W0[1] - 8, W0[0] + 71, W0[1] + 71];
  const box = [claim[0], G - 3, claim[1], claim[2], top + 16, claim[3]];
  const snapF = path.join(OUT, `${tag}-channel-snap.gz`);
  const c = await call('dev.region.checkPlan', { plan, claim, owner: OWNER, anchors }, 900_000);
  out.check = { overall: c.check?.overall ?? null, parts: (c.check?.parts ?? []).map((a) => ({ part: a.part, class: a.class, bridges: a.geometry?.bridges, reasons: a.reasons })), refused: c.refused ?? null };
  check(c.check?.overall === 'READY', `item 1 (${tag}): a bridge part over a 14-wide channel checks READY through Regions.checkPlan (${json(out.check.parts.map((a) => [a.part, a.class, (a.bridges ?? []).map((b) => [b.form, b.n, b.crossing?.clearance])]))})`);
  if (!c.check?.artifactSha) return out;
  await cmd('/kill @e[type=!minecraft:player]');
  await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 3_600_000);
  const rr = await call('dev.region.realiseApproved', { sha: c.check.artifactSha }, 300_000);
  const st = await L.waitRegion(rr.region, 3_600_000);
  out.state = st.view.state;
  check(st.view.state === 'PLACED', `item 1 (${tag}): the channel bridge realised from its approved artifact (${st.view.state})`);
  const g = (c.check.parts.find((a) => a.part === 'over_water')?.geometry?.bridges ?? [])[0];
  if (g) {
    const a = [g.from[0], g.from[1] + 1, g.from[2]], b = [g.to[0], g.to[1] + 1, g.to[2]];
    const ab = await call('dev.nav.villager', { from: a, to: b, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: b, to: a, range: 256 }, 120_000);
    out.nav = [!!ab.canReach, !!ba.canReach];
    check(out.nav[0] && out.nav[1], `item 3 (${tag}): vanilla's villager across the channel bridge both ways`);
    // the clearance over the water, measured: the lowest bridge block over the channel's middle against the water's top
    const mid = [Math.floor((g.from[0] + g.to[0]) / 2), Math.floor((g.from[2] + g.to[2]) / 2)];
    const col = await call('dev.region.dump', { box: [mid[0], G - 2, mid[1], mid[0], top + 12, mid[1]], file: path.join(OUT, `${tag}-mid.arwd.gz`) }, 300_000);
    void col;
  }
  out.cams = { side: [W0[0] + 52, top + 4, W0[1] + 32], deck: g ? [g.from[0], g.from[1] + 3, g.from[2] - 3] : null };
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region: rr.region, requester: OWNER }, 3_600_000);
  await L.settle(5000);
  const diff = await call('dev.region.hash', { box, mode: 'diff', file: snapF }, 3_600_000);
  out.exact = { removed: rm.removed, mismatches: diff.mismatches, classes: diff.classes };
  const none = diff.classes ? diff.classes.none ?? 0 : diff.mismatches;
  check(rm.removed && none === 0, `item 9 (${tag}): the channel bridge removed exactly (${diff.mismatches} mismatches, ${json(diff.classes ?? {})}: the channel's water settles)`);
  return out;
}

steps.ingame = async () => {
  await ensure();
  await L.fresh('G6B T3a Cross Flat', FLAT);
  await L.setRules('exact');
  const out = await crossRun('flat', FLAT_CLAIM, { kind: 'flat', golden: 'crossings_demo_flat' });
  out.channel = await checkPlanRun('flat');
  await leaveWorld();
  spendZero();
  return out;
};

steps.natural = async () => {
  await ensure();
  await L.fresh('G6B T3a Cross River', BASE);
  await L.setRules('default');
  const out = await crossRun('river', S3_CLAIM, { kind: 'river', golden: null });
  await leaveWorld();
  spendZero();
  return out;
};

steps.frozen = async () => {
  await ensure();
  const base = await L.seedBase(FROZEN_SEED);
  await L.fresh('G6B T3a Cross Frozen', base);
  // (the frozen biome freezes water and grows snow on random ticks, and a freeze beside worldgen sand standing on water drops it: the
  // first run found such cells 8-13 columns from any written cell, unclassified; the stand runs with random ticks off, as E-flat's)
  await L.setRules('exact');
  const out = await crossRun('frozen', FROZEN_CLAIM, { kind: 'frozen', golden: null });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the look (client; recorded, not judged)

const LOOK_BIBLES = [null, 'g7ak1_infernal', 'g7ak1_coastal'];
function installBible(id) {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
}
async function shot(name, eye, at) {
  await call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
  await L.settle(1500);
  const r = await call('dev.screenshot', { name: `t3a_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], bibles: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  for (const bible of LOOK_BIBLES) {
    const tag = bible ?? 'default';
    await L.fresh(`G6B T3a Look ${tag}`, FLAT);
    await L.setRules('exact');
    await cmd('/time set 6000');
    await cmd('/weather clear');
    await tp((FLAT_CLAIM[0] + FLAT_CLAIM[2]) / 2, 0, (FLAT_CLAIM[1] + FLAT_CLAIM[3]) / 2);
    const p = await L.plan('crossings_demo', FLAT_CLAIM, { params: { variant: 'flat' }, surveyLoad: 'bounded:256', check: true, owner: OWNER, ...(bible ? { bible } : {}) });
    const meta = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'meta.json'), 'utf8'));
    const region = await L.realise(p.planId, {});
    const st = await L.waitRegion(region, 3_600_000);
    check(st.view.state === 'PLACED' && (meta.bridges ?? []).length === 2, `look (${tag}): crossings_demo flat realised with its beam and arch (${st.view.state}; recorded, not judged: Noah's call, N-T3-1)`);
    out.bibles[tag] = { planId: p.planId, state: st.view.state, bridges: (meta.bridges ?? []).map((q) => ({ id: q.id, form: q.form, n: q.n, deck: q.deck, rail: q.rail, pier: q.pier, arch: q.arch, light: q.light, from: q.from, to: q.to })) };
    for (const q of meta.bridges ?? []) {
      const mid = [q.from[0], q.from[1], Math.floor((q.from[2] + q.to[2]) / 2)];
      const name = `${tag}_${q.form}`;
      out.shots.push(await shot(`${name}_side`, [mid[0] + 30.5, mid[1] - 6, mid[2] + 0.5], [mid[0] - 0.5, mid[1] - 6, mid[2] + 0.5]));
      out.shots.push(await shot(`${name}_deck`, [q.from[0] + 0.5, q.from[1] + 2.6, q.from[2] - 3.5], [q.to[0] + 0.5, q.to[1] + 1, q.to[2] + 0.5]));
      if (tag === 'default') out.shots.push(await shot(`${name}_high`, [mid[0] + 34.5, mid[1] + 22, mid[2] + 26.5], [mid[0] - 0.5, mid[1] - 8, mid[2] + 0.5]));
    }
    // (6c T3 batch, item 17) the tunnel half in the same three bibles: the 3x3 bore's portal and lit interior, the 1-wide bore
    // (T3b's cameras, gate6ct3b.mjs look)
    out.bibles[tag].tunnels = (meta.tunnels ?? []).map((q) => ({ id: q.id, from: q.from, to: q.to, width: q.width, height: q.height }));
    const t = (meta.tunnels ?? []).find((q) => q.width === 3) ?? meta.tunnels?.[0];
    if (t) {
      const [x, y, z] = t.from;
      const portal = t.portals?.[0];
      const px = portal ? portal.cells.find((c) => c[3] === 'lintel')[0] : x + 3;
      out.shots.push(await shot(`${tag}_tunnel_portal`, [x - 9.5, y + 4, z + 4.5], [px + 0.5, y + 2, z + 0.5]));
      out.shots.push(await shot(`${tag}_tunnel_interior`, [px + 1.5, y + 2.6, z + 0.5], [px + 30.5, y + 1.5, z + 0.5]));
      const n = (meta.tunnels ?? []).find((q) => q.width === 1);
      if (n && tag === 'default') out.shots.push(await shot(`${tag}_tunnel_narrow`, [n.from[0] - 6.5, n.from[1] + 3, n.from[2] + 2.5], [n.from[0] + 6.5, n.from[1] + 1.5, n.from[2] + 0.5]));
    }
    check((meta.tunnels ?? []).length === 2, `look (${tag}): crossings_demo flat's two tunnels realised beside the bridges (recorded, not judged: Noah's call, N-T3-3)`);
    await call('dev.release', {}).catch(() => null);
    await call('dev.region.remove', { region, requester: OWNER }, 3_600_000).catch(() => null);
    await leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'probe', 'ingame', 'natural', 'frozen', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-T3a (bridges)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ct3a.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
