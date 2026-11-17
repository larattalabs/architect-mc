#!/usr/bin/env node
// Slice ST gate (8a staged terrain; docs/CONTRACT.md "Phase 8a" §3, §6, §7 row 3, "Slice ST as built") against the headless server of the ST run
// worktree (GATE6B_RUN, default `../architect-mc-ST-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). Ports
// 9018 (sidecar) / 9019 (DevBridge) by default. $0: no Claude call anywhere. Strict tier, targeted scenarios only (speed rule 11).
//
//   node tools/gate8ast.mjs <step>
//     ingame   (sta-ingame)  per fixture an INSTANT twin (creative, the flat base: checked, realised, no staged target, the box snapshotted),
//                           then the same plan in survival (the RS base, a stockpile): realised and built over time, sampled every ~2 s
//                           through dev.region.terrain: staged targets for its land, intermediate states seen (0 < built < cells), the
//                           region-wide rate never above terrainPerTick (16; rs01 2) cells per game tick, every standing staged cell supported by
//                           the world (TO's rules read live), percent under 100 while terrain is unbuilt and 100 at the end, a terrain
//                           part `building`; rs01 over raised land (relief blending real slopes, a rock spire, pads with two lots, a held
//                           terrace; at 2 per tick); x01 (the hollow mountain); x03's island alone (a floating form from its anchor), its
//                           owner with no stockpile (an all-free plan needs none); x03h, the whole hamlet: a lot on the island waits
//                           SITE_BUSY with architect_mc:waitsFor {kind: "terrain", part, terrainCells, terrainBuilt, say}. Then: every staged target's bill empty, the check's bills per
//                           part equal to the targets' (items in = items out: the conservation sum exact), the final world equal to its
//                           INSTANT twin cell for cell (block entities included; the crates aside), Remove E-flat 0
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate8a-st/<step>.json in the main checkout (GATE8AST_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-ST-run');
process.env.GATE6B_OUT = process.env.GATE8AST_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate8a-st');
process.env.GATE6B_SIDECAR_PORT ??= '9018';
process.env.GATE6B_DEV_PORT ??= '9019';
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice ST is $0: sim only, no Claude call' }, null, 2)}\n`);
}

/** The lot entries a fixture binds: every lot of its plan an rs_hut (a farm, smithy or barn an rs_shed), as gate6crs's entriesOf. */
function entriesOf(fx) {
  const out = {};
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.lots)) for (const l of o.lots) if (l?.id && l.type) out[l.id] = ['farm', 'smithy', 'barn'].includes(l.type) ? 'rs_shed' : 'rs_hut';
      Object.values(o).forEach(walk);
    }
  };
  walk(fx.plan?.zones ?? []);
  return out;
}

/** The snapshot box: the claim and 8 round it, 8 under its lowest ground to `over` above its highest (an island's top). */
const boxOf = (W, over) => [W.claim[0] - 8, W.minY - 8, W.claim[1] - 8, W.claim[2] + 8, W.maxY + over, W.claim[3] + 8];

/** The INSTANT twin: a creative flat world, checked and realised there (no staged target: creative unchanged), the box snapshotted. */
async function twinOf(tag, fx, entries, over) {
  const s = await G.site(ctx, `${tag} twin`, fx, { creative: true });
  if (Object.keys(entries).length) await G.designs(ctx);
  const ck = await G.check(ctx, `${tag}-twin`, s);
  if (!ck.check?.artifactSha) throw new Error(`twin ${tag}: no artifact (${ck.check?.overall})`);
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  const st = await L.waitRegion(region, 3_600_000, (x) => L.boxClear.onState(x, x?.view?.id));
  const tr = await call('dev.region.terrain', { region }, 120_000);
  const box = boxOf(s.W, over);
  await L.settle(3000);
  const file = path.join(OUT, `st-${tag}-twin.snap.gz`);
  await call('dev.region.hash', { box, mode: 'snap', file }, 3_600_000);
  const r = { file, box, state: st.view.state, survival: ck.check?.survival ?? false, terrainTargets: (tr.targets ?? []).length };
  check(st.view.state === 'PLACED' && !ck.check?.survival && r.terrainTargets === 0, `${tag} (INSTANT twin, creative): realised ${st.view.state}, survival ${r.survival}, ${r.terrainTargets} staged terrain target(s) (creative unchanged: written at once)`, r);
  return r;
}

/**
 * One fixture staged in survival: realised over a stockpile, fed what its lots lack (G.feed), sampled through dev.region.terrain until built
 * and done; the checks of the file's header; removed (E-flat 0).
 */
async function staged(tag, fx, { over = 40, crates = 3, lotWait = false, rate = 16 } = {}) {
  const entries = entriesOf(fx);
  const T = await twinOf(tag, fx, entries, over);
  const s = await G.site(ctx, tag, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = boxOf(s.W, over);
  const pre = await G.snap(ctx, box, `st-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  const out = { tag, overall: ck.check?.overall, survival: ck.check?.survival, entries, twin: T };
  check(ck.check?.survival === true && ['READY', 'NEEDS_REPAIR'].includes(ck.check?.overall) && !!ck.check?.artifactSha, `${tag}: Regions.checkPlan in survival: ${ck.check?.overall}, ${json((ck.check?.parts ?? []).map((a) => [a.part, a.class, a.cost?.survival?.free, a.cost?.survival?.held, sum(a.cost?.survival?.bom)]))}`);
  if (!ck.check?.artifactSha) return out;
  const set = await call('dev.terrain.rate', { n: rate }, 30_000); // (16, the default; rs01's small relief slower, so its half-built states are seen)
  out.rateSet = set.terrainPerTick;
  const crateAt = crates > 0 ? await G.pile(ctx, s, crates) : []; // (crates 0: no stockpile, an all-free plan needs none)
  // the survival quote (Regions.quoteApproved): the check's bill less the paid terrain cells the land already holds (SA/BC A11: a realise
  // skips them, so they are neither billed nor consumed; the check's cost.survival.bom is their upper bound)
  const quote = await call('dev.region.quote', { sha: ck.check.artifactSha, lotEntries: entries }, 300_000);
  out.quote = { bom: quote.bom, exact: quote.exact, terrain: quote.terrain, notes: quote.notes, refused: quote.refused };
  const C = new G.Conservation(ctx, box);
  await C.start();
  const ps0 = crates > 0 ? await G.pileState(ctx) : {};
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  const samples = [];
  let lotWaits = [], n = 0, lastSample = 0;
  const sample = async () => {
    if (Date.now() - lastSample < 1500) return;
    lastSample = Date.now();
    const deep = n++ % 3 === 0;
    const tr = await call('dev.region.terrain', { region, ...(deep ? { check: true } : {}) }, 300_000);
    const rs = await G.rsState(ctx, region);
    const b = rs.build ?? {};
    const tc = (b.parts ?? []).reduce((a, p) => a + (p.terrainCells ?? 0), 0), tb = (b.parts ?? []).reduce((a, p) => a + (p.terrainBuilt ?? 0), 0);
    samples.push({ t: tr.gameTime, cells: tr.cells, built: tr.built, targets: (tr.targets ?? []).length, percent: b.percent, rate: tr.terrainPerTick, partsTerrain: [tc, tb],
      building: (b.parts ?? []).filter((p) => p.state === 'building' && p.terrainCells > 0).map((p) => p.part),
      unsupported: deep ? (tr.targets ?? []).reduce((a, t) => a + (t.unsupported ?? 0), 0) : null,
      firstUnsupported: deep ? (tr.targets ?? []).flatMap((t) => t.firstUnsupported ?? []).slice(0, 4) : null, released: (tr.targets ?? []).filter((t) => t.released).map((t) => t.target) });
    for (const w of tr.waits ?? []) if (w.waitsFor?.kind === 'terrain' && w.status === 'WAITING') lotWaits.push(w);
  };
  const f = await G.feed(ctx, region, { cons: C, fraction: 1, timeoutMs: 3_000_000, every: 1000, extra: async () => { await sample(); return {}; },
    until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done });
  await sample();
  const final = await call('dev.region.terrain', { region, check: true }, 300_000);
  const rs = await G.rsState(ctx, region);
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.samples = samples;
  out.final = { cells: final.cells, built: final.built, targets: (final.targets ?? []).map((t) => [t.target, t.part, t.cells, t.built, t.connected, t.released, t.unsupported]) };
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, terrainPerTick: rs.build.terrainPerTick, parts: (rs.build.parts ?? []).map((p) => [p.part, p.state, p.cells, p.built, p.terrainCells, p.terrainBuilt]) };
  // staged targets for the land, built over time
  const mid = samples.filter((x) => x.built > 0 && x.built < x.cells);
  check((final.targets ?? []).length > 0 && final.cells > 0 && mid.length >= 2, `${tag}: its land is ${(final.targets ?? []).length} staged terrain target(s), ${final.cells} cells, built over time: ${mid.length} of ${samples.length} samples between 0 and all (${json(mid.slice(0, 4).map((x) => [x.t, x.built]))})`);
  // the rate: never above terrainPerTick per game tick, region-wide
  let maxRate = 0;
  const over16 = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t, db = samples[i].built - samples[i - 1].built;
    if (dt > 0 && db > 0) { maxRate = Math.max(maxRate, db / dt); if (db > samples[i].rate * dt + samples[i].rate) over16.push([samples[i - 1].t, samples[i].t, db]); }
  }
  out.rate = { max: Math.round(maxRate * 100) / 100, terrainPerTick: final.terrainPerTick, over: over16 };
  check(final.terrainPerTick === rate && rs.build?.terrainPerTick === rate && over16.length === 0 && maxRate > 0, `${tag}: built at most terrainPerTick (${final.terrainPerTick}, RegionBuild.terrainPerTick ${rs.build?.terrainPerTick}) cells per game tick region-wide: the fastest stretch ${out.rate.max}/tick, ${over16.length} stretch(es) over`, over16.slice(0, 4));
  // support order: every standing staged cell supported, at every deep sample and at the end
  const deep = samples.filter((x) => x.unsupported !== null);
  const bad = deep.filter((x) => x.unsupported > 0);
  const finalBad = (final.targets ?? []).reduce((a, t) => a + (t.unsupported ?? 0) + (t.missing ?? 0), 0); // (GPT review) BUILT targets checked too
  const released = (final.targets ?? []).filter((t) => t.released).map((t) => t.target);
  out.support = { deep: deep.length, bad: bad.slice(0, 4), finalBad, released };
  check(deep.length >= 1 && bad.length === 0 && finalBad === 0, `${tag}: in support order: every standing staged cell supported by the world at ${deep.length} half-built sample(s) and at the end (${finalBad} unsupported; ${released.length} target(s) released: ${released.join(' ')})`, out.support);
  // percent counts the terrain; a terrain part reads building while it builds
  const early100 = samples.filter((x) => x.partsTerrain[1] < x.partsTerrain[0] && x.percent >= 100);
  const sawBuilding = samples.some((x) => x.building.length > 0);
  check(early100.length === 0 && rs.build?.percent === 100 && rs.build?.built && rs.build?.done && sawBuilding, `${tag}: RegionBuild.percent reaches 100 only with the terrain built (${early100.length} sample(s) at 100 before it; end ${rs.build?.percent}, built ${rs.build?.built}, done ${rs.build?.done}); a terrain part read building while it built (${sawBuilding})`, early100.slice(0, 3));
  if (lotWait) {
    // (a lot first; the fixtures' lots stand clear of staged land, so another item of the region that stands on it shows the typed wait)
    const w = lotWaits.find((x) => x.key.startsWith('lot:')) ?? lotWaits[0];
    out.lotWait = { n: lotWaits.length, first: w ?? null };
    check(!!w && w.reason === 'SITE_BUSY' && typeof w.waitsFor.part === 'string' && w.waitsFor.terrainCells > 0 && Number.isInteger(w.waitsFor.terrainBuilt) && typeof w.waitsFor.say === 'string',
      `${tag}: an item over staged land (${w?.key}) waits ${w?.reason} with architect_mc:waitsFor ${json(w?.waitsFor)} (${lotWaits.length} sample(s))`);
  }
  // nothing billed for staged cells; the bills per part as checked; items in = items out
  const stagedIds = new Set((final.targets ?? []).map((t) => t.target));
  const stagedBills = (rs.targets ?? []).filter((t) => stagedIds.has(t.target)).filter((t) => sum(t.bom) !== 0);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  const p = await C.point('built');
  // what the build consumed from the stockpile against the quote: equal when the quote is exact, within it otherwise
  // (what was fed and is no longer in the stock went into the build: the conservation sum below shows nothing else left or appeared)
  const ps1 = crates > 0 ? await G.pileState(ctx) : {};
  const consumed = G.minus(G.minus(f.inserted, ps1.stock ?? {}), G.minus({}, ps0.stock ?? {}));
  const targetsBill = (rs.targets ?? []).reduce((a, t) => G.plus(a, t.bom), {});
  const qb = quote.bom ?? {};
  const within = Object.entries(consumed).every(([k, v]) => v <= (qb[k] ?? 0));
  const quoteOk = !quote.refused && (quote.exact ? G.same(qb, consumed) : within);
  out.bills = { stagedBilled: stagedBills.map((t) => [t.target, t.bom]), consumed, targetsBill, quote: qb, quoteExact: quote.exact, checkDiffer: differ,
    checkWant: Object.fromEntries(differ.map((k) => [k, bills.want[k]])), checkGot: Object.fromEntries(differ.map((k) => [k, bills.got[k]])), conservation: p,
    targets: (rs.targets ?? []).map((t) => [t.target, t.part, t.bom]) };
  check(stagedBills.length === 0 && quoteOk && G.exact(p), `${tag}: nothing billed for staged cells (${stagedBills.length} staged target(s) with a bill); the build consumed what Regions.quoteApproved quoted (${quote.exact ? 'exact' : 'an upper bound'}: quote ${json(qb)}, consumed ${json(consumed)}; the check's per-part bills, an upper bound that counts paid terrain the land already holds, differ in ${differ.length ? differ.join(' ') : 'none'}); items in = items out (conservation ${json(p.diff)}, identity ${p.identity}; ${sum(f.inserted)} items fed)`, out.bills);
  // the final world: its INSTANT twin's, cell for cell
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twinDiff = d;
  check(d.mismatches === 0, `${tag}: the built world equals its INSTANT twin cell for cell (block entities included; the crates aside): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(ef.length === 0, `${tag}: Regions.remove: E-flat ${ef.length} over the box (the crates aside)`, out.eflat);
  if (rate !== 16) await call('dev.terrain.rate', { n: 16 }, 30_000);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function haltWait() {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const st = await call('dev.state', {}, 10_000).catch(() => null);
    if (st && st.inWorld === false) return true;
  }
  return false;
}

/**
 * (GPT review P1 2 and 3) x01's hollow mountain with no stockpile: one staged target BUILT while the other builds, then a halt with nothing saved
 * (dev.stockpile.halt) and a restart: every BUILT target still holds every cell (its chunks were saved before it was marked BUILT); then,
 * half built again, Regions.remove: no staged write after the removal starts (the road tick's path leaves it as the feed does), E-flat 0.
 */
async function crashAndRemove(tag, fx) {
  const out = { tag };
  const s = await G.site(ctx, tag, fx);
  const box = boxOf(s.W, 96);
  const pre = await G.snap(ctx, box, `st-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  if (!ck.check?.artifactSha) { check(false, `${tag}: no artifact (${ck.check?.overall})`); return out; }
  await call('dev.terrain.rate', { n: 16 }, 30_000);
  const region = await G.realise(ctx, ck.check.artifactSha, {});
  let tr = null;
  for (let i = 0; i < 600; i++) {
    tr = await call('dev.region.terrain', { region }, 120_000);
    const ts = tr.targets ?? [];
    if (ts.some((t) => !t.building) && ts.some((t) => t.building)) break;
    await sleep(250);
  }
  const ts0 = (tr?.targets ?? []).map((t) => [t.target, t.building, t.built, t.cells]);
  out.beforeHalt = ts0;
  const ready = (tr?.targets ?? []).some((t) => !t.building) && (tr?.targets ?? []).some((t) => t.building);
  check(ready, `${tag}: one staged target BUILT while another builds before the halt (${json(ts0)})`);
  await call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
  const down = await haltWait();
  check(down, `${tag}: dev.stockpile.halt halted the server (nothing saved since)`);
  await L.openWorld(s.world);
  await L.settle(4000);
  await call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  const tr1 = await call('dev.region.terrain', { region, check: true }, 300_000);
  const built = (tr1.targets ?? []).filter((t) => !t.building);
  const holes = built.reduce((a, t) => a + (t.missing ?? 0), 0);
  out.afterRestart = (tr1.targets ?? []).map((t) => [t.target, t.building, t.built, t.cells, t.missing, t.unsupported]);
  check(built.length > 0 && holes === 0, `${tag}: after the unclean restart every BUILT staged target holds every planned cell (${built.length} BUILT, ${holes} missing: ${json(out.afterRestart)})`);
  // half built again, then removed while it builds
  let tr2 = null;
  for (let i = 0; i < 300; i++) {
    tr2 = await call('dev.region.terrain', { region }, 120_000);
    if (tr2.built > tr1.built + 500 && tr2.built < tr2.cells) break;
    await sleep(500);
  }
  out.atRemove = { built: tr2?.built, cells: tr2?.cells };
  await G.remove(ctx, region);
  await L.settle(3000);
  const e = await G.diff(ctx, box, pre);
  out.eflat = { mismatches: e.mismatches, list: e.list.slice(0, 8) };
  check(tr2 && tr2.built < tr2.cells && e.mismatches === 0, `${tag}: removed half built (${tr2?.built} of ${tr2?.cells} staged cells): E-flat ${e.mismatches} over the box (no staged write after the removal started)`, out.eflat);
  return out;
}

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  const only = process.env.ST_ONLY ? process.env.ST_ONLY.split(',') : null;
  const want = (t) => !only || only.includes(t);
  const rate = await call('dev.terrain.rate', {}, 30_000).catch((e) => ({ error: String(e.message ?? e) }));
  out.rateHook = rate;
  if (want('rs01')) {
    // rs01 over raised land: the claim 2 up, a block 5 up under the town (its lots stand on it), so its relief blends real slopes (on rs01's
    // flat claim the relief and the pads write nothing: no staged cell); built at 2 per tick so its half-built states are seen. (Its lots
    // can't wait on the relief: the ground stage's path tile waits for the relief's targets, so the lots stage starts after them.)
    const fx = JSON.parse(JSON.stringify(G.fixture(ctx, 'rs01_land')));
    fx.terrain.bands = [...fx.terrain.bands, { x0: 1000, z0: 2000, x1: 1239, z1: 2159, y: 66 }, { x0: 1100, z0: 2060, x1: 1159, z1: 2120, y: 69 }];
    try { out.rs01 = await staged('rs01', fx, { rate: 2 }); } catch (e) { check(false, `rs01: ${String(e.message).slice(0, 300)}`); out.rs01 = { error: String(e.stack ?? e) }; }
  }
  if (want('x01')) {
    try { out.x01 = await staged('x01', G.fixture(ctx, 'bf/x01_hollow_mountain'), { over: 96, crates: 1 }); } catch (e) { check(false, `x01: ${String(e.message).slice(0, 300)}`); out.x01 = { error: String(e.stack ?? e) }; }
  }
  if (want('x03')) {
    const isle = JSON.parse(JSON.stringify(G.fixture(ctx, 'bf/x03_island_hamlet')));
    delete isle.plan.zones;
    try { out.x03 = await staged('x03', isle, { over: 96, crates: 0 }); } catch (e) { check(false, `x03: ${String(e.message).slice(0, 300)}`); out.x03 = { error: String(e.stack ?? e) }; }
  }
  if (want('x01crash')) {
    // (x01's mountain: four targets over 32,078 cells at 16 per tick, so one stands BUILT while others build, and half built after the restart)
    try { out.x01crash = await crashAndRemove('x01crash', G.fixture(ctx, 'bf/x01_hollow_mountain')); } catch (e) { check(false, `x01crash: ${String(e.message).slice(0, 300)}`); out.x01crash = { error: String(e.stack ?? e) }; }
  }
  if (want('x03h')) {
    // the whole hamlet: its lots stand on the island (a stage after the island's): each waits for the island's staged targets, typed
    try { out.x03h = await staged('x03h', G.fixture(ctx, 'bf/x03_island_hamlet'), { over: 96, crates: 3, lotWait: true }); } catch (e) { check(false, `x03h: ${String(e.message).slice(0, 300)}`); out.x03h = { error: String(e.stack ?? e) }; }
  }
  return out;
};

steps.report = async () => {
  const rows = [];
  for (const s of ['ingame']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 8a-ST (staged terrain)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate8ast.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
