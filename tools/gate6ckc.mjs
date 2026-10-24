#!/usr/bin/env node
// Phase 6c slice KC gate (docs/CONTRACT.md "Phase 6c slice KC: parts keep clear of fluid bodies" §10) against the headless server of
// the KC run worktree (GATE6B_RUN, default `../architect-mc-KC-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no
// Claude). $0: no Claude call anywhere.
//
//   node tools/gate6ckc.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds
//     unit      (kc-unit)              offline: item 1 (kit/test/kc.test.mjs: the registry, every §4 row on its fixture, OVERLAP {kind:
//                                      body} with its wouldFit re-checked alone, M25:clear on every broken variant, OB.BODY never WATER,
//                                      the moat's berm); item 2 (byte identity: every committed plan fixture as on the merge base with
//                                      origin/main but v51, the named exception; the watch count recorded; M25:clear 0 on this head but
//                                      the broken variants); item 3 (the 59 asks before and after: 0 malformed, no part moves class);
//                                      item 7 (api-compat --gate6ckc: the 0.39.0, 0.38.0 and 0.37.1 jars and the 0.39.0 surface)
//     ingame    (kc-ingame)            item 4: v51 (its ring repaired) through Regions.checkPlan's two-plan flow and realiseApproved:
//                                      READY, PLACED, every body settled and its census equal to its prediction, Regions.remove E-flat 0;
//                                      k01 (v51 as VOC committed it) answers the wall OVERLAP {kind: body} in game. Item 5: v61 the same
//                                      round, the water gate's grate and lintel as HY-c's. (Item 4's fountain bill, 18 = 18, is judged
//                                      in voc-ingame.)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-kc/<step>.json in the main checkout (GATE6CKC_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flAsksFilter } from './lib/fl-norm.mjs'; // (6c FL) FL's five free asks left to FL's own item 8
import * as P3 from './lib/p3-tier.mjs';
import { gatePart, sliceSections, slicesOf } from './lib/gate-part.mjs';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { kitReuse } from './lib/kit-reuse.mjs'; // ((gate speed 3) its kit files' results from this run's unit-kit, when exact)

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-KC-run');
process.env.GATE6B_OUT = process.env.GATE6CKC_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-kc');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient } = L;
const CORE = await import('./lib/gate6chy-core.mjs');
const KCK = await import('./lib/gate6ckc-kit.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core: CORE };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice KC is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B KC Lobby', { backend: 'sim' });
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
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  // a split unit step (docs/GATES.md "Turbo"): `items` (every item but the byte identity) and the byte identity's fixture loop in
  // round-robin slices; whole, every section runs exactly as before
  const P = gatePart(['items', ...sliceSections('unchanged', 3)], { log });
  const slice = slicesOf(P, 'unchanged', 3);
  if (P.want('items')) {
  // item 1
  out.kc = kitOnce(['kit/test/kc.test.mjs']);
  check(out.kc.code === 0 && out.kc.fail === 0 && out.kc.pass >= 16, `item 1 (kit): the registry (resolve, emit, rollback), OB.BODY never WATER (no harbour fallback), every §4 row on its fixture (k01-k08, v61), OVERLAP {kind: body} with its wouldFit re-checked alone, M25:clear on each broken variant (u01-u04), the moat's berm: ${out.kc.pass} pass, ${out.kc.fail} fail`, out.kc.failing);
  }
  // item 2 (byte identity, the watch count, the head's census)
  if (!slice || slice.length) {
  const u = await KCK.unchanged(root, { check, log, slice });
  out.unchanged = { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, watch: u.watch, hard: u.hard, watchCount: u.watchCount, excepted: KCK.EXCEPT };
  fs.writeFileSync(path.join(OUT, 'kc-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  check(true, `item 2 (recorded): the watch count: ${u.watch.length} committed fixture(s) where another part writes a body's watch cell on the base (${u.watch.map((w) => `${w.fixture}: ${w.cells} cells by ${w.writers.join(', ')}`).join('; ') || 'none'})`);
  }
  if (P.want('items')) {
  // item 3 (the 59 asks before and after)
  const { asksGap } = await import('./lib/gate6chy-b.mjs');
  const baseDir = path.resolve(root, '..', 'architect-mc-KC-main');
  const before = await asksGap(path.join(baseDir, 'kit')), after = await asksGap(KIT);
  const F = path.join(KIT, 'test', 'fixtures', 'plan', 'kc');
  const cb = fs.readFileSync(path.join(F, 'asks-before.md'), 'utf8'), ca = fs.readFileSync(path.join(F, 'asks-after.md'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'kc-asks-before.md'), before.text);
  fs.writeFileSync(path.join(OUT, 'kc-asks-after.md'), after.text);
  // ((the CU/IRR/VOC-c batch) rule.palette is supported: its 7 parts' lines and the tally they move are VOC-c's (its item 3,
  // fixtures/plan/vocc/asks-*.txt), compared without them, as HY-b's asks item does)
  // ((6c FL) and FL's five free asks and the gap table's free-layout rows (tools/lib/fl-norm.mjs flAsksFilter: FL's own item 8 judges them))
  const vocc = (t) => flAsksFilter(t.split('\n').filter((l) => !/rule\.palette/.test(l) && !/^# 59 asks:/.test(l)).join('\n'));
  const lines = (t) => new Map(flAsksFilter(t).split('\n').filter((l) => !l.startsWith('#') && !l.startsWith('  ') && l.includes('/') && !/rule\.palette/.test(l)).map((l) => [l.split(' ')[0], l]));
  const lb = lines(before.text), la = lines(after.text);
  const moved = [...la].filter(([k, v]) => lb.get(k) !== v).map(([k]) => k);
  out.asks = { moved, malformedBefore: before.malformed, malformedAfter: after.malformed, parts: la.size };
  check(vocc(before.text) === vocc(cb) && vocc(after.text) === vocc(ca) && after.malformed === 0 && moved.length === 0 && la.size > 0, `item 3: the 59 asks on the merge base and on this head equal fixtures/plan/kc/asks-before.md and asks-after.md: ${after.malformed} malformed, ${moved.length} part(s) moved class of ${la.size}${moved.length ? ` (${moved.join(', ')})` : ''}`);
  // item 7
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6ckc'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter((l) => /^(ok|FAIL)/.test(l)) };
  check(ac.status === 0, `item 7: api-compat --gate6ckc clean against the 0.39.0, 0.38.0 and 0.37.1 apitest jars and the 0.39.0 jar's 1.36.0 surface (no Java change); $0.00`, out.apicompat.tail);
  }
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game (items 4 and 5)

steps.ingame = async () => {
  await ensure();
  const B = await import('./lib/gate6chy-b.mjs');
  const C = await import('./lib/gate6chy-c.mjs');
  const out = {};
  // the forge bible (v51's style)
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', 'g6cvoc_forge', 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', 'g6cvoc_forge.json'), path.join(dst, 'bible.json'));
  // ---- item 4: v51, its ring repaired (P3 smoke: v61 is the in-game instance; v51's fountain census and M25:clear are the water lint's)
  const v51 = B.fixture(ctx, 'valid/v51_voc_forge.json');
  if (P3.smoke) P3.skipped(log, 'item 4: v51 realised (the fountain census, the wall writing 0 cells of its sets)', 'the water lint (valid/v51_voc_forge.json: M25 incl. M25:clear, census == prediction) and kc.test');
  else out.v51 = await B.realiseFixture(ctx, 'kc-v51', v51, {
    bible: 'g6cvoc_forge',
    after: async (r) => {
      const o = {};
      r.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
      const ir = JSON.parse(fs.readFileSync(path.join(r.planDir, 'ir.json'), 'utf8'));
      const meta = JSON.parse(fs.readFileSync(path.join(r.planDir, 'meta.json'), 'utf8'));
      const { buildVirtual } = await imp('lib/region/vworld.mjs');
      const { clearScan } = await imp('lib/region/checkFluids.mjs');
      const blobs = (s) => { const f = path.join(r.planDir, 'blobs', `${s}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
      const vols = fs.existsSync(path.join(r.planDir, 'volumes')) ? fs.readdirSync(path.join(r.planDir, 'volumes')).length : 0;
      const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(r.planDir, 'survey.bin')), blobs });
      const sc = clearScan({ ir, vw, meta });
      o.clear = sc.counts;
      const fount = r.bodies.filter((b) => b.part === 'fount');
      const wallIdx = ir.parts.findIndex((p) => p.id === 'w_forge_wall');
      let inSets = 0;
      for (const b of fount) for (const c of [...b.cells, ...b.shell, ...b.spill, ...b.watch]) if (vw.partAt(c[0], c[1], c[2]) === wallIdx) inSets++;
      o.wallInFountain = inSets;
      check(fount.length === 2 && inSets === 0 && sc.counts.hard + sc.counts.watch === 0, `item 4 (v51): the approved plan's wall writes 0 cells of the fountain's sets (basin, spout, shell, spill, watch: ${inSets}); M25:clear ${json(sc.counts)} (volumes in the plan dir: ${vols})`);
      return o;
    },
  });
  // ---- item 4: k01 (v51 as VOC committed it) in game: the wall is refused, the fountain untouched
  {
    const k01 = B.fixture(ctx, 'kc/k01_forge.json');
    await L.fresh('G6B KC k01', CORE.FLAT);
    const W = await B.buildTerrain(ctx, B.terrainOf(k01));
    const wp = await B.worldPlan(ctx, k01, W);
    const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: CORE.OWNER, anchors: wp.anchors, load: 'generate', bible: 'g6cvoc_forge' }, 1_800_000);
    fs.writeFileSync(path.join(OUT, 'kc-k01-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
    const a = (ck.check?.parts ?? []).find((p) => p.part === 'forge_wall');
    const f = (ck.check?.parts ?? []).find((p) => p.part === 'fount');
    out.k01 = { overall: ck.check?.overall ?? null, wall: a ? { class: a.class, reason: a.reasons?.[0] ?? null, wouldFit: a.wouldFit?.[0]?.fragment?.where ?? null } : null, fount: f?.class ?? null };
    check(a?.class === 'refused' && a.reasons?.[0]?.code === 'OVERLAP' && a.reasons[0].evidence?.kind === 'body' && a.reasons[0].evidence?.part === 'fount' && f?.class === 'fits'
      && JSON.stringify(a.wouldFit?.[0]?.fragment?.where?.around?.ring) === '[4,17]',
    `item 4 (k01): in game, Regions.checkPlan answers the wall of v51 as VOC committed it refused OVERLAP {kind: body, part: fount}, wouldFit ring [4, 17], the fountain fits (overall ${ck.check?.overall})`, out.k01);
    await L.leaveWorld();
  }
  // ---- item 5: v61
  const v61 = B.fixture(ctx, 'kc/v61_kc_village.json');
  out.v61 = await B.realiseFixture(ctx, 'kc-v61', v61, {
    after: async (r) => {
      const o = {};
      r.planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
      const G = C.gateGeometry(r, 'town_wall');
      check(!!G, `item 5 (v61): the realised plan carries the water gate (meta walls[town_wall].waterGates: ${json(G ? { body: G.body.id, cells: G.wg.cells.length, lintel: G.wg.lintel } : null)})`);
      if (!G) return o;
      const cen = await CORE.censusOf(ctx, G.body, null, r.bodies);
      const grateStates = G.body.grate.map(([x, y, z]) => cen.fluids.get(`${x},${y},${z}`) ?? 'none');
      const joined = grateStates.filter((st) => /^minecraft:iron_bars\[/.test(st) && /waterlogged=true/.test(st) && (st.match(/(east|west|north|south)=true/g) ?? []).length >= 2).length;
      o.grate = { cells: G.body.grate.length, joined, sample: grateStates.slice(0, 3) };
      check(G.body.grate.length > 0 && joined === G.body.grate.length, `item 5 (v61): every grate cell of ${G.body.id} is joined waterlogged bars, as HY-c's (${joined}/${G.body.grate.length})`);
      let lintel = 0;
      for (const [x, z] of G.wg.cells) { const res = await L.cmd(`/execute unless block ${x} ${G.wg.lintel} ${z} minecraft:air`); if (Number(res.result) > 0 || res.success) lintel++; }
      o.lintel = { cells: G.wg.cells.length, solid: lintel, y: G.wg.lintel };
      check(lintel === G.wg.cells.length, `item 5 (v61): the lintel stands over every grate column at y ${G.wg.lintel} (${lintel}/${G.wg.cells.length})`);
      const ids = r.bodies.map((b) => b.id);
      check(['w_fount', 'w_pool', 'w_moat'].every((id) => ids.includes(id)) && ids.some((id) => /^brook_r/.test(id)), `item 5 (v61): the fountain, the pond, the moat and the brook's reaches all realised (${ids.join(', ')})`);
      return o;
    },
  });
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json', 'kc-unchanged.json'].includes(f) && !/check\.json$/.test(f));
  const lines = ['# Gate 6c slice KC', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
  console.error(`usage: node tools/gate6ckc.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
