#!/usr/bin/env node
// Slice HB gate (8a half-built safety; docs/CONTRACT.md "Phase 8a" §4, §6, §7 row 4, "Slice HB as built") against the headless server of the
// HB run worktree (GATE6B_RUN, default `../architect-mc-HB-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude).
// Ports 9018 (sidecar) / 9019 (DevBridge) by default. $0: no Claude call anywhere. Strict tier, targeted scenarios only (speed rule 11).
//
//   node tools/gate8ahb.mjs <step>
//     remove   (hb-remove)  BF x03's hamlet in survival (its lots stand on the staged island), the land held at 0, 50 and 100% of its staged
//                           cells (dev.terrain.rate {hold}, TEST), in both orders: "whole" (Regions.remove at once) and "dependent" (the stages
//                           over the land undone first, newest first, through Sites.undoStage: the half-built land exactly as it stood;
//                           then Regions.remove). Each: what the build consumed refunded (items in = items out, the conservation sum
//                           exact), no staged target billed, Remove E-flat 0 over the box (the crates aside). At 100% (XR): the writers
//                           over staged cells (dev.rs.overwrites: never a staged victim, nothing retaken for one)
//     halt     (hb-halt)    the same hamlet built at 4 per tick: fed, the ledger and the chunks saved mid terrain run (/save-all flush, PS's
//                           periodic save held off), built on, RegionView read (as Steward reads it: view.build, its parts' terrain counts,
//                           the typed wait), then a halt with nothing saved (dev.stockpile.halt). After the restart: the reconcile charged,
//                           owed and gave back nothing for any staged target; every staged target's saved book (RL) marks its cells free (k
//                           every cell, s and o empty) at the case's save and after the restart; RegionView across the restart (terrainCells
//                           unchanged, terrainBuilt what the world holds, terrainPerTick 4, a part building, the typed wait again); no paid
//                           cell stands unpaid; resumed and fed until built: the INSTANT twin cell for cell; standing = the paid records;
//                           Remove E-flat 0
//     growth   (hb-growth)  a survival flat_village town built, then a growth over raised land (its pads' cut and fill staged): its lot
//                           waits typed kind "terrain" with its part; fed in part (a paid target of the growth consumed); undoRevision (RU)
//                           while it waits: the world before the growth (E-flat 0 over the growth's box: the half-built terrain restored),
//                           paid == returned (the refund what the growth consumed; every item put in back)
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate8a-hb/<step>.json in the main checkout (GATE8AHB_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-HB-run');
process.env.GATE6B_OUT = process.env.GATE8AHB_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate8a-hb');
process.env.GATE6B_SIDECAR_PORT ??= '9018';
process.env.GATE6B_DEV_PORT ??= '9019';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, fails, log, results, root, state } = L;
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const core = await import('./lib/gate6chy-core.mjs');

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
const only = process.env.HB_ONLY ? process.env.HB_ONLY.split(',') : null;
const want = (t) => !only || only.includes(t);

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice HB is $0: sim only, no Claude call' }, null, 2)}\n`);
}

/** The lot entries a fixture binds (gate8ast's entriesOf). */
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
const boxOf = (W, over) => [W.claim[0] - 8, W.minY - 8, W.claim[1] - 8, W.claim[2] + 8, W.maxY + over, W.claim[3] + 8];
const terr = (region, deep = false) => call('dev.region.terrain', { region, ...(deep ? { check: true } : {}) }, 300_000);
const hold = (on) => call('dev.terrain.rate', { hold: on }, 30_000);
const audit = () => call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
const savedNow = () => call('dev.stockpile.saved', {}, 60_000);
const ledgerOf = (file) => (file?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
/** Set bits in a CellBits base64 string (java.util.BitSet.toByteArray, little-endian). */
const bitsOf = (b64) => { if (!b64) return 0; let n = 0; for (const byte of Buffer.from(b64, 'base64')) for (let v = byte; v; v &= v - 1) n++; return n; };
/** The staged targets' books in a saved ledger: per credit key of a staged target id, [n, k, s, o] bit counts. */
function stagedBooks(file, ids) {
  const cells = ledgerOf(file)?.cells ?? {};
  const out = {};
  for (const [k, b] of Object.entries(cells)) if (ids.some((id) => k.startsWith(`road:${id}@`) || k.startsWith(`${id}@`) || k === id || k.includes(`:${id}@`))) out[k] = [b.n, bitsOf(b.k), bitsOf(b.s), bitsOf(b.o)];
  return out;
}
/** The paid cells standing against the paid records (RL's balance): the dupe and the double charge, per item. */
function balance(a) {
  const standing = G.plus(a.paidStanding ?? {}, {});
  for (const k of ['fluidStanding', 'mechStanding']) for (const [it, n] of Object.entries(a[k] ?? {})) standing[it] = (standing[it] ?? 0) - n;
  const paid = Object.values(a.ledger?.paid ?? {}).reduce((x, m) => G.plus(x, m), {});
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  return { standing: sum(standing), paid: sum(paid), dupe: pos(G.minus(standing, paid)), double: pos(G.minus(paid, standing)) };
}
/** What a RegionView shows Steward of the build: view.build (its parts' terrain counts, percent, the rate), its state and typed wait. */
function viewOf(st) {
  const v = st?.view ?? {}, b = v.build ?? {};
  return { state: v.state, percent: b.percent, built: b.built, done: b.done, terrainPerTick: b.terrainPerTick, waiting: v.waiting ?? null,
    waitsFor: v.ext?.['architect_mc:waitsFor'] ?? null,
    parts: (b.parts ?? []).map((p) => ({ part: p.part, state: p.state, cells: p.cells, built: p.built, terrainCells: p.terrainCells, terrainBuilt: p.terrainBuilt })) };
}

/** The INSTANT twin (gate8ast's twinOf): a creative flat world, checked and realised there, the box snapshotted. */
async function twinOf(tag, fx, entries, over) {
  const s = await G.site(ctx, `${tag} twin`, fx, { creative: true });
  if (Object.keys(entries).length) await G.designs(ctx);
  const ck = await G.check(ctx, `${tag}-twin`, s);
  if (!ck.check?.artifactSha) throw new Error(`twin ${tag}: no artifact (${ck.check?.overall})`);
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  const st = await L.waitRegion(region, 3_600_000, (x) => L.boxClear.onState(x, x?.view?.id));
  const box = boxOf(s.W, over);
  await L.settle(3000);
  const file = path.join(OUT, `hb-${tag}-twin.snap.gz`);
  await call('dev.region.hash', { box, mode: 'snap', file }, 3_600_000);
  check(st.view.state === 'PLACED', `${tag} (INSTANT twin, creative): realised ${st.view.state}`);
  return { file, box };
}

/**
 * A fixture put down in survival: a fresh world, its stockpile, the land held (`held`) or not before the realise, the rate set: {s, box,
 * pre, ck, region, crateAt, C (the conservation sum), entries}.
 */
async function survival(tag, fx, { over = 96, crates = 3, rate = 16, held = false } = {}) {
  const entries = entriesOf(fx);
  const s = await G.site(ctx, tag, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = boxOf(s.W, over);
  const pre = await G.snap(ctx, box, `hb-${tag}-pre`);
  const ck = await G.check(ctx, tag, s);
  if (!ck.check?.artifactSha) throw new Error(`${tag}: no artifact (${ck.check?.overall})`);
  await call('dev.terrain.rate', { n: rate }, 30_000);
  await hold(held);
  const crateAt = crates > 0 ? await G.pile(ctx, s, crates) : [];
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  return { s, box, pre, ck, region, crateAt, C, entries };
}

/** Waits until the region's staged targets are put down and `pred(terrain)` holds. */
async function untilTerrain(region, pred, timeoutMs = 1_800_000) {
  const end = Date.now() + timeoutMs;
  let t;
  for (; Date.now() < end;) {
    t = await terr(region);
    if ((t.targets ?? []).length && pred(t)) return t;
    const st = await G.regionState(ctx, region);
    await L.boxClear.onState(st, st?.view?.id);
    await L.sleep(700);
  }
  return t;
}

/** One feed wave: what the targets lack (outstanding less stock), through the conservation sum; then waits `ms`. */
async function feedOnce(C, ms = 8000) {
  const ps = await G.pileState(ctx);
  const need = {};
  for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
  const acc = Object.keys(need).length ? await C.insert(`stockpile:${G.OWNER}`, need) : {};
  if (ms) await L.settle(ms);
  return acc;
}

/** The region's stage names in order and the staged targets' stage (dev.region.state's view.stages; the land's stage holds a staged target). */
function stagesOf(st) {
  return (st?.view?.stages ?? []).map((x) => x.name ?? x.stage ?? x.id).filter(Boolean);
}

// ------------------------------------------------------------------ hb-remove

/** The stage that puts down x03's island (its staged land). */
const LAND_STAGE = 'forms';
/** An /apitest command whose answer is pending: its result, waited for (gatemsad's later). */
async function later2(args, timeoutMs = 900_000) {
  const ask = async (a) => {
    const r = await cmd(`/apitest ${a}`);
    const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
    if (line === undefined) throw new Error(`/apitest ${a.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 300)}`);
    return JSON.parse(line);
  };
  const pd = await ask(args);
  if (!pd?.pending) return pd;
  for (const end = Date.now() + timeoutMs; Date.now() < end; await L.sleep(500)) {
    const r = await ask(`get ${pd.pending}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
  }
  throw new Error(`no result for ${pd.pending}`);
}

async function removeCase(tag, fx, frac, order, { xr = false, over = 96 } = {}) {
  const S = await survival(tag, fx, { rate: frac === 50 ? 2 : 16, held: frac < 100, over });
  const { region, box, pre, crateAt, C } = S;
  const out = { tag, frac, order, region };
  let t;
  if (frac === 0) {
    t = await untilTerrain(region, () => true, 600_000);
    await feedOnce(C); // what can build without the land builds (the rest waits for it)
    t = await terr(region);
  } else if (frac === 50) {
    t = await untilTerrain(region, () => true, 600_000);
    await feedOnce(C, 0);
    await hold(false);
    t = await untilTerrain(region, (x) => x.built * 2 >= x.cells, 1_800_000);
    await hold(true);
    await L.settle(1500);
    t = await terr(region);
  } else {
    const f = await G.feed(ctx, region, { cons: C, fraction: 1, timeoutMs: 3_000_000, every: 1500 });
    out.feedWaves = f.waves;
    t = await terr(region);
  }
  const st = await G.regionState(ctx, region);
  const rs = await G.rsState(ctx, region);
  out.terrain = { cells: t.cells, built: t.built, targets: (t.targets ?? []).map((x) => [x.target, x.part, x.cells, x.built]) };
  out.view = viewOf(st);
  const ok = frac === 0 ? t.built === 0 && t.cells > 0 : frac === 50 ? t.built > 0 && t.built < t.cells : t.built === t.cells && st.view.state === 'PLACED' && rs.build?.done;
  check(ok, `${tag}: the land at ${frac}%: ${t.built} of ${t.cells} staged cells built in ${(t.targets ?? []).length} target(s) (region ${st.view.state}, percent ${rs.build?.percent})`, out.terrain);
  const stagedIds = new Set((t.targets ?? []).map((x) => x.target));
  const billed = (rs.targets ?? []).filter((x) => stagedIds.has(x.target) && sum(x.bom) !== 0).map((x) => [x.target, x.bom]);
  const ps0 = await G.pileState(ctx);
  out.consumed = G.minus(ps0.ledger?.consumed, ps0.ledger?.returned);
  if (frac === 100) {
    // (XR) the writers over staged cells: a staged cell is free, so it is never a paid victim and nothing is retaken for it
    const ow = await call('dev.rs.overwrites', { region }, 300_000);
    const rows = ow.rows ?? ow.cells ?? [];
    const stagedVictims = rows.filter((r) => stagedIds.has(r.victim));
    // the staged cells a later writer (a lot, a road, a props tile) took up: queued, BUILT, and no longer the staged block (XR: one owner)
    const rc = await call('dev.rs.cells', { region }, 300_000);
    const taken = [];
    for (const x of rc.targets ?? []) if (stagedIds.has(x.target)) for (const c of x.cells ?? []) if (!(c[3] & 2)) taken.push(c.slice(0, 3).join(','));
    const a = await audit();
    out.xr = { rows: rows.length, counts: ow.counts ?? null, stagedVictims: stagedVictims.slice(0, 4), takenUp: taken.length, takenFirst: taken.slice(0, 6), retaken: a.retaken ?? {}, balance: balance(a) };
    check((!xr || taken.length > 0) && stagedVictims.length === 0 && sum(a.retaken) === 0 && sum(balance(a).dupe) === 0 && sum(balance(a).double) === 0,
      `${tag}: (XR) ${taken.length} staged cell(s) taken up by later writers (one owner: the writer); ${rows.length} take-up row(s) of paid cells (${json(ow.counts ?? {})}), ${stagedVictims.length} with a staged victim; retaken ${json(a.retaken ?? {})} (nothing was paid); the paid cells standing equal the paid records (standing ${balance(a).standing}, paid ${balance(a).paid})`, out.xr);
  }
  if (order === 'dependent') {
    // the lots standing on the land removed first (Sites.remove of each placed lot site), the land then exactly as it stood; then
    // Regions.remove. (A survival region's stage is never undone on its own: Groups refuses it; its undo is undoRevision, hb-growth.)
    const before = await G.snap(ctx, box, `hb-${tag}-held`);
    const sites = (st.view.lots ?? []).filter((l) => l.siteId).map((l) => [l.id, l.siteId]);
    out.lotFirst = [];
    for (const [lot, site] of sites) {
      const u = await later2(`remove ${site} ${G.OWNER} noforce`);
      out.lotFirst.push([lot, site, json(u).slice(0, 200)]);
      check(u?.removed === true, `${tag}: Sites.remove(${site}) of lot ${lot} on the staged land: removed ${u?.removed} (${json(u?.blockers ?? u?.refused ?? u?.error ?? null).slice(0, 200)})`, u);
    }
    await L.settle(4000);
    const standing = async () => { let n = 0; for (const x of (await call('dev.rs.cells', { region }, 300_000)).targets ?? []) if (stagedIds.has(x.target)) for (const c of x.cells ?? []) if (c[3] & 2) n++; return n; };
    const builtAfter = await standing();
    const d = await G.diff(ctx, box, before);
    out.dependent = { sites, builtAfter, cells: t.cells, restored: d.mismatches };
    check(sites.length > 0 && builtAfter === t.cells && d.mismatches > 0, `${tag}: ${sites.length} lot(s) on the staged land removed first: every staged cell still stands (${builtAfter} of ${t.cells}); ${d.mismatches} cell(s) of the lots restored`, out.dependent);
  }
  const rm = await G.remove(ctx, region);
  await hold(false);
  const p = await C.point('removed');
  const ps1 = await G.pileState(ctx);
  const net = G.minus(G.minus(ps1.ledger?.consumed, ps1.ledger?.returned), G.minus(ps0.ledger?.consumed, ps0.ledger?.returned));
  const refunded = G.minus(G.minus(ps1.ledger?.returned, ps0.ledger?.returned), {});
  out.refund = { consumedBefore: out.consumed, refunded, net, conservation: p, billed };
  check(billed.length === 0 && G.same(refunded, out.consumed) && G.exact(p), `${tag}: no staged target billed (${billed.length}); the Remove refunded what the build consumed (consumed ${json(out.consumed)}, refunded ${json(refunded)}); items in = items out (conservation ${json(p.diff)}, identity ${p.identity})`, out.refund);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed ?? rm, mismatches: ef.length, list: ef.slice(0, 8) };
  check(ef.length === 0, `${tag}: ${order === 'whole' ? 'Regions.remove' : 'then Regions.remove'} at ${frac}%: E-flat ${ef.length} over the box (the crates aside)`, out.eflat);
  return out;
}

/**
 * (The GPT review's P1s) A staged target recorded BUILT whose book survives in the saved ledger (it was building at the last save), its
 * cells since taken up by later writers (XR: the path and the lots over rs01's relief), then a halt with nothing saved: after the restart
 * RL leaves it BUILT (free: nothing charged, owed or given back; nothing refilled or cleared), the world as before the halt; Remove E-flat 0.
 */
async function builtCrash(tag, fx) {
  const S = await survival(tag, fx, { rate: 16, held: true, over: 40 });
  const { region, box, pre, crateAt } = S;
  const out = { region };
  const t0 = await untilTerrain(region, (x) => (x.targets ?? []).length > 0, 600_000);
  await L.settle(3000);
  // the books written while every staged target still builds (held), then nothing saved until the halt
  await cmd('/save-all flush');
  const s0 = await savedNow();
  const ids = (t0.targets ?? []).map((x) => x.target);
  const books0 = stagedBooks(s0.file, ids);
  await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
  await hold(false);
  const f = await G.feed(ctx, region, { fraction: 1, timeoutMs: 3_000_000, every: 1500 });
  const rc = await call('dev.rs.cells', { region }, 300_000);
  let taken = 0;
  for (const x of rc.targets ?? []) if (ids.includes(x.target)) for (const c of x.cells ?? []) if (!(c[3] & 2)) taken++;
  const s1 = await savedNow();
  await L.settle(3000);
  const snap = await G.snap(ctx, box, `hb-${tag}-built`);
  out.before = { books: books0, saves: [s0.saves, s1.saves], state: f.last.st.view.state, taken };
  check(f.last.st.view.state === 'PLACED' && Object.keys(books0).length === ids.length && s1.saves === s0.saves && taken > 0,
    `${tag}: built (${f.last.st.view.state}) after the save that holds every staged book (${Object.keys(books0).length} of ${ids.length}; saves #${s0.saves} -> #${s1.saves}), ${taken} staged cell(s) since taken up by later writers`, out.before);
  await call('dev.stockpile.halt', {}, 10_000).catch(() => null);
  const down = await haltWait();
  check(down, `${tag}: dev.stockpile.halt halted the server (nothing saved)`);
  if (!down) return out;
  await L.openWorld(S.s.world);
  await L.tp(Math.floor((S.s.W.claim[0] + S.s.W.claim[2]) / 2), 100, Math.floor((S.s.W.claim[1] + S.s.W.claim[3]) / 2));
  await L.settle(10_000);
  const a1 = await audit();
  const rec = Object.fromEntries(Object.entries(a1.reconciled ?? {}).filter(([k]) => ids.includes(k)));
  const builtRec = Object.values(rec).filter((r) => r.built);
  const bad = Object.values(rec).filter((r) => r.reopened || sum(r.charged) || sum(r.owes) || sum(r.creditedBack));
  const tR = await terr(region);
  const d = await G.diff(ctx, box, snap);
  const dl = d.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.after = { uncleanStart: a1.uncleanStart, reconciled: rec, building: (tR.targets ?? []).filter((x) => x.building).map((x) => x.target), worldDiff: dl.length, list: dl.slice(0, 6) };
  check(a1.uncleanStart === true && builtRec.length > 0 && builtRec.some((r) => r.missingCells > 0) && bad.length === 0 && out.after.building.length === 0 && dl.length === 0,
    `${tag}: after the unclean restart RL read ${builtRec.length} BUILT staged target(s) with a book (cells not their block: ${json(builtRec.map((r) => r.missingCells))}): left BUILT, none reopened, nothing charged, owed or given back (${bad.length} not); none building; the world as before the halt (${dl.length} differ: the later writers' cells kept)`, out.after);
  await call('dev.stockpile.ps', { noPeriodic: false }, 30_000);
  // (rule 18) items in == items out after the restart: what stands paid comes back through the Remove, nothing more, nothing less
  const b1 = balance(a1);
  const C2 = new G.Conservation(ctx, box);
  await C2.start();
  await G.remove(ctx, region);
  const p2 = await C2.point('removed');
  out.conservation = { balance: b1, removed: p2 };
  check(sum(b1.dupe) === 0 && sum(b1.double) === 0 && G.exact(p2), `${tag}: after the restart the paid cells standing equal the paid records (standing ${b1.standing}, paid ${b1.paid}); through the Remove items in = items out (conservation ${json(p2.diff)}, identity ${p2.identity})`, out.conservation);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  check(ef.length === 0, `${tag}: Regions.remove: E-flat ${ef.length} over the box (the crates aside)`, ef.slice(0, 8));
  out.eflat = ef.length;
  return out;
}

steps.remove = async () => {
  await ensure();
  spendZero();
  const fx = G.fixture(ctx, 'bf/x03_island_hamlet');
  const out = {};
  for (const frac of [0, 50, 100]) {
    // (at 0 and 50% the hamlet's lots wait typed for the land: nothing stands over it, so the lot-first order is the whole one)
    for (const order of frac === 100 ? ['whole', 'dependent'] : ['whole']) {
      const tag = `rm${frac}${order[0]}`;
      if (!want(tag)) continue;
      try { out[tag] = await removeCase(tag, fx, frac, order); } catch (e) { check(false, `${tag}: ${String(e.message).slice(0, 300)}`); out[tag] = { error: String(e.stack ?? e) }; await hold(false).catch(() => null); }
    }
  }
  if (want('xr01')) {
    // (XR) rs01 over raised land (ST's): its ground stage's path and the lots' pads written over the staged relief once it stands
    const r01 = JSON.parse(JSON.stringify(G.fixture(ctx, 'rs01_land')));
    r01.terrain.bands = [...r01.terrain.bands, { x0: 1000, z0: 2000, x1: 1239, z1: 2159, y: 66 }, { x0: 1100, z0: 2060, x1: 1159, z1: 2120, y: 69 }];
    try { out.xr01 = await removeCase('xr01', r01, 100, 'whole', { xr: true, over: 40 }); } catch (e) { check(false, `xr01: ${String(e.message).slice(0, 300)}`); out.xr01 = { error: String(e.stack ?? e) }; }
    if (want('xr01crash')) {
      try { out.xr01crash = await builtCrash('xr01crash', r01); } catch (e) { check(false, `xr01crash: ${String(e.message).slice(0, 300)}`); out.xr01crash = { error: String(e.stack ?? e) }; }
    }
  }
  return out;
};

// ------------------------------------------------------------------ hb-halt

async function haltWait() {
  for (let i = 0; i < 180; i++) {
    await L.sleep(2000);
    const st = await call('dev.state', {}, 10_000).catch(() => null);
    if (st && st.inWorld === false) return true;
  }
  return false;
}

function serverLogSince(mark) {
  const f = path.join(L.GAME_DIR, 'logs', 'latest.log');
  try { const t = fs.readFileSync(f, 'utf8'); return t.slice(Math.min(mark, t.length)); } catch { return ''; }
}

steps.halt = async () => {
  await ensure();
  spendZero();
  const tag = 'halt';
  const fx = G.fixture(ctx, 'bf/x03_island_hamlet');
  const entries = entriesOf(fx);
  const T = await twinOf(tag, fx, entries, 96);
  const S = await survival(tag, fx, { rate: 4 });
  const { region, box, pre, crateAt, C } = S;
  const out = { region };
  await untilTerrain(region, (x) => x.built > 0, 600_000);
  await feedOnce(C, 0); // the paid targets fed in full: they build as the land allows
  // the case's save: mid terrain run, PS's periodic save held off (and RL's save on join) so nothing saves between it and the halt
  // (every staged target of the hamlet put down first: the island's c4 joins after the street's small one)
  await untilTerrain(region, (x) => (x.targets ?? []).length >= 2 && x.built * 10 >= x.cells * 3, 1_800_000);
  await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
  await cmd('/save-all flush');
  const s0 = await savedNow();
  const tS = await terr(region);
  const ids = (tS.targets ?? []).map((x) => x.target);
  const books0 = stagedBooks(s0.file, ids);
  out.atSave = { saves: s0.saves, built: tS.built, cells: tS.cells, books: books0 };
  const free0 = Object.values(books0);
  check(free0.length === ids.length && free0.every(([n, k, s, o]) => k === n && s === 0 && o === 0), `${tag}: at the case's save (#${s0.saves}, ${tS.built} of ${tS.cells} staged cells built) every staged target's book marks its cells free (k every cell, s and o empty): ${json(books0)}`, books0);
  // built on after the save, then RegionView as Steward reads it, then the halt with nothing saved
  await untilTerrain(region, (x) => x.built * 10 >= x.cells * 6, 1_800_000);
  const s1 = await savedNow();
  const tH = await terr(region);
  const v1 = viewOf(await G.regionState(ctx, region));
  const w1 = (tH.waits ?? []).filter((w) => w.waitsFor?.kind === 'terrain' && w.status === 'WAITING');
  out.atHalt = { saves: s1.saves, built: tH.built, targets: (tH.targets ?? []).map((x) => [x.target, x.cells, x.built]), view: v1, waits: w1.slice(0, 3) };
  check(s1.saves === s0.saves && tH.built > tS.built, `${tag}: built on after the save (${tS.built} -> ${tH.built} staged cells), nothing saved the ledger since (save #${s1.saves})`, out.atHalt);
  const logMark = serverLogSince(0).length;
  await call('dev.stockpile.halt', {}, 10_000).catch(() => null);
  const down = await haltWait();
  check(down, `${tag}: dev.stockpile.halt halted the server (nothing saved)`);
  if (!down) return out;
  await L.openWorld(S.s.world);
  await L.tp(Math.floor((S.s.W.claim[0] + S.s.W.claim[2]) / 2), 110, Math.floor((S.s.W.claim[1] + S.s.W.claim[3]) / 2));
  await L.settle(4000);
  // the reconcile: nothing charged, owed or given back for a staged target; no book of another queue
  const a1 = await audit();
  const rc = Object.fromEntries(Object.entries(a1.reconciled ?? {}).filter(([k]) => ids.includes(k)));
  const rcBad = Object.entries(rc).filter(([, r]) => sum(r.charged) || sum(r.owes) || sum(r.creditedBack) || r.owedCells || r.aheadCells || r.lostCells);
  const logText = serverLogSince(0);
  const otherQueue = ids.filter((id) => logText.includes(`${id}'s cell book indexes another queue`));
  const b1 = balance(a1);
  out.reconcile = { uncleanStart: a1.uncleanStart, staged: rc, otherQueue, balance: b1 };
  check(a1.uncleanStart === true && Object.keys(rc).length > 0 && rcBad.length === 0 && otherQueue.length === 0,
    `${tag}: after the unclean restart RL reconciled ${Object.keys(rc).length} staged target(s): nothing charged, owed or given back (${rcBad.length} not; ${json(Object.values(rc).map((r) => [r.missingCells ?? null, r.reopened]))}); ${otherQueue.length} book(s) of another queue`, out.reconcile);
  check(sum(b1.dupe) === 0 && sum(b1.double) === 0, `${tag}: after the restart no paid cell stands unpaid and none is paid twice (standing ${b1.standing}, paid ${b1.paid}; dupe ${json(b1.dupe)}, double ${json(b1.double)})`, b1);
  const s2 = await savedNow();
  const books2 = stagedBooks(s2.file, ids);
  check(Object.values(books2).every(([n, k, s, o]) => k === n && s === 0 && o === 0), `${tag}: after the restart (save #${s2.saves}) the staged books still mark every cell free: ${json(books2)}`, books2);
  // RegionView across the restart, as Steward reads it
  const tR = await terr(region);
  const v2 = viewOf(await G.regionState(ctx, region));
  const tc = (v) => Object.fromEntries(v.parts.filter((p) => p.terrainCells > 0).map((p) => [p.part, p.terrainCells]));
  const tbSum = (v) => v.parts.reduce((a, p) => a + (p.terrainBuilt ?? 0), 0);
  out.restart = { built: tR.built, cells: tR.cells, view: v2 };
  check(json(tc(v2)) === json(tc(v1)) && tbSum(v2) === tR.built && tR.built >= tS.built && v2.terrainPerTick === 4 && v2.parts.some((p) => p.state === 'building' && p.terrainCells > 0) && !v2.built && v2.percent < 100,
    `${tag}: RegionView across the restart: terrainCells per part unchanged (${json(tc(v2))}), terrainBuilt ${tbSum(v2)} = the world's ${tR.built} read with it (at the save ${tS.built}, at the halt ${tH.built}; it builds on from the world at once), terrainPerTick ${v2.terrainPerTick}, percent ${v1.percent} -> ${v2.percent}, a terrain part building (${v2.parts.filter((p) => p.state === 'building').map((p) => p.part).join(' ')})`, { before: v1, after: v2 });
  let w2 = [];
  for (let i = 0; i < 20 && w1.length && !w2.length; i++) {
    w2 = ((await terr(region)).waits ?? []).filter((w) => w.waitsFor?.kind === 'terrain' && w.status === 'WAITING');
    if (!w2.length) await L.sleep(1000);
  }
  check(!w1.length || w2.some((w) => w.reason === 'SITE_BUSY' && typeof w.waitsFor.part === 'string' && Number.isInteger(w.waitsFor.terrainBuilt)), `${tag}: the typed terrain wait again after the restart (${w1.length} before: ${json(w1[0]?.waitsFor ?? null)}; after: ${json(w2[0]?.waitsFor ?? null)})`);
  // RegionView.waiting with its payload (§6 "the region's waiting the same"): the waiting item's typed wait on the view's ext
  const vw = [v1, v2].filter((v) => v.waiting);
  check(vw.length > 0 && vw.every((v) => v.waitsFor && (v.waitsFor.kind !== 'terrain' || (typeof v.waitsFor.part === 'string' && v.waitsFor.terrainCells > 0))) && vw.some((v) => v.waitsFor?.kind === 'terrain'),
    `${tag}: RegionView.waiting carries the typed wait (view.ext architect_mc:waitsFor) before the halt and after the restart: ${json(vw.map((v) => [v.waiting?.reason, v.waitsFor?.kind ?? null, v.waitsFor?.part ?? null]))}`, vw.map((v) => ({ waiting: v.waiting, waitsFor: v.waitsFor })));
  await call('dev.stockpile.ps', { noPeriodic: false }, 30_000);
  // resumed: fed until built; the INSTANT twin; standing = the paid records; Remove E-flat 0
  // (rule 18) the conservation sum over the restarted world: every item fed from here on is in the build, the stock, or back after the Remove
  const C2 = new G.Conservation(ctx, box);
  await C2.start();
  const f = await G.feed(ctx, region, { cons: C2, fraction: 1, timeoutMs: 3_000_000, every: 1500 });
  const tF = await terr(region, true);
  check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done && tF.built === tF.cells, `${tag}: resumed and fed until built: ${f.last.st.view.state}, ${tF.built} of ${tF.cells} staged cells, percent ${f.last.rs.build?.percent}`);
  const a2 = await audit();
  const b2 = balance(a2);
  check(sum(b2.dupe) === 0 && sum(b2.double) === 0 && a2.identity !== false, `${tag}: built after the restart, the paid cells standing equal the paid records (standing ${b2.standing}, paid ${b2.paid}; dupe ${json(b2.dupe)}, double ${json(b2.double)}; identity ${a2.identity})`, b2);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twinDiff = d;
  check(d.mismatches === 0, `${tag}: the world resumed after the halt equals its INSTANT twin cell for cell (block entities included; the crates aside): ${d.mismatches} differ`, d.list);
  const pb = await C2.point('built');
  await G.remove(ctx, region);
  const pr = await C2.point('removed');
  out.conservation = { built: pb, removed: pr };
  check(G.exact(pb) && G.exact(pr), `${tag}: items in = items out after the restart, built and removed (conservation ${json(pb.diff)} / ${json(pr.diff)}, identity ${pb.identity}/${pr.identity})`, out.conservation);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  check(ef.length === 0, `${tag}: Regions.remove: E-flat ${ef.length} over the box (the crates aside)`, ef.slice(0, 8));
  out.eflat = ef.length;
  void C;
  return out;
};

// ------------------------------------------------------------------ hb-growth

// (GR's survival town on RS's survival base: gate6dgr's claim; its east strip raised 3 so a growth's pads cut and fill it, staged)
const GX = 11200, GZ = 11200;
const GCLAIM = [GX, GZ, GX + 159, GZ + 111];
const GTOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
const GGROW = Array.from({ length: 4 }, (_, i) => ({ id: `row_${i + 1}`, type: 'house', size: [9, 9], villager: 'dwelling' }));
const GENTRIES = Object.fromEntries(GGROW.map((l) => [l.id, 'rs_hut']));

async function groundAt(x, z) {
  const h = await call('dev.box.hash', { min: [x, -64, z], max: [x, 255, z], cells: true }, 300_000);
  let g = -64;
  for (const l of h.cells ?? []) { const [k, st] = [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]; if (!/air/.test(st.split(' be=')[0])) g = Math.max(g, Number(k.split(',')[1])); }
  return g;
}

steps.growth = async () => {
  await ensure();
  spendZero();
  const tag = 'growth';
  const out = {};
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  await G.survivalBase(ctx);
  await L.fresh('G6B HB Growth', G.SURV);
  await L.setRules('exact');
  await cmd('/weather clear');
  await G.designs(ctx);
  await L.tp(GX + 80, 80, GZ + 56);
  const gy = await groundAt(GX + 150, GZ + 100);
  // the east of the claim stepped (8-wide strips raised 1, 2, 3, 2 over the flat land, dirt under a grass top): uneven land where the town
  // grows, so a growth's pads cut and fill it (staged); a uniform raise is flat again and stages nothing
  const H = [1, 2, 3, 2];
  for (let k = 0, x = GX + 40; x <= GX + 167; k++, x += 8) {
    const h = H[k % H.length];
    for (let z = GZ - 8; z <= GZ + 119; z += 32) {
      const z1 = Math.min(GZ + 119, z + 31);
      if (h > 1) await cmd(`/fill ${x} ${gy} ${z} ${x + 7} ${gy + h - 1} ${z1} minecraft:dirt`);
      await cmd(`/fill ${x} ${gy + h} ${z} ${x + 7} ${gy + h} ${z1} minecraft:grass_block`);
    }
  }
  const crates = [0, 1, 2, 3].map((k) => [GCLAIM[0] - 6 + 2 * k, gy + 1, GCLAIM[1] - 6]);
  const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
  check(!cr.refused, `${tag}: a stockpile of 4 crates: ${json(cr.refused ?? 'made')}`);
  const p0 = await L.plan('flat_village', GCLAIM, { params: { lots: GTOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
  const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
  const f0 = await G.feed(ctx, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
  const tTown = await terr(region);
  out.town = { region, state: f0.last.st.view.state, terrain: [tTown.cells, tTown.built, (tTown.targets ?? []).length] };
  check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `${tag}: the town built in survival (${f0.waves} waves; ${(tTown.targets ?? []).length} staged target(s) of its own, ${tTown.built}/${tTown.cells})`);
  const town0 = new Set((tTown.targets ?? []).map((x) => x.target));
  const box = [GCLAIM[0] - 8, gy - 12, GCLAIM[1] - 8, GCLAIM[2] + 8, gy + 28, GCLAIM[3] + 8];
  for (const frac of [0, 50, 100]) {
    const t = `growth${frac}`;
    if (!want(t)) continue;
    try { out[t] = await growthCase(t, frac, region, town0, box, crates, pile); } catch (e) { check(false, `${t}: ${String(e.message).slice(0, 300)}`); out[t] = { error: String(e.stack ?? e) }; await hold(false).catch(() => null); }
  }
  await call('dev.terrain.rate', { n: 16 }, 30_000);
  return out;
};

/**
 * One growth undone by RU at `frac` of its staged land: planned and realised with the land held (so its items wait typed on it), fed
 * (a paid target consumes), the land let build to `frac` (100: the growth built); undoRevision; the world before it, paid == returned.
 */
async function growthCase(tag, frac, region, town0, box, crates, pile) {
  const out = {};
  await L.settle(3000);
  const before = await G.snap(ctx, box, `hb-${tag}-before`);
  const ps0 = await pile();
  await call('dev.terrain.rate', { n: frac === 50 ? 1 : 16 }, 30_000);
  await hold(frac < 100);
  const g = await call('dev.rv.plan', { region, program: 'flat_village', params: { grow: { lots: GGROW } } }, 900_000);
  check(!g.refused && g.revisionOf?.rid >= 1, `${tag}: a growth of ${GGROW.length} houses planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
  if (g.refused) return out;
  const r = await call('dev.region.realise', { planId: g.planId, lots: GENTRIES }, 300_000);
  check(!r.refused, `${tag}: the growth realised: ${r.refused ?? 'accepted'}`);
  // its staged targets put down, and (the land held) an item of it waiting typed kind "terrain"
  let tg, waits = [];
  for (let i = 0; i < 90; i++) {
    tg = await terr(region);
    waits = (tg.waits ?? []).filter((w) => w.waitsFor?.kind === 'terrain' && w.status === 'WAITING' && !town0.has(w.waitsFor?.target));
    if ((tg.targets ?? []).some((x) => !town0.has(x.target)) && (frac === 100 || waits.length)) break;
    await L.sleep(2000);
  }
  const mine0 = (tg.targets ?? []).filter((x) => !town0.has(x.target));
  out.staged = mine0.map((x) => [x.target, x.part, x.cells, x.built]);
  out.waits = waits.slice(0, 3);
  check(mine0.length > 0, `${tag}: the growth's land is ${mine0.length} staged target(s) (${json(out.staged)})`, out.staged);
  if (frac < 100) {
    // the public view (as Steward reads it): RegionView.waiting with its typed payload, from the growth's own batch
    let vv = null;
    for (let i = 0; i < 20; i++) { vv = viewOf(await G.regionState(ctx, region)); if (vv.waiting && vv.waitsFor) break; await L.sleep(1000); }
    out.view = { waiting: vv?.waiting ?? null, waitsFor: vv?.waitsFor ?? null };
    check(vv?.waiting?.reason === 'SITE_BUSY' && vv?.waitsFor?.kind === 'terrain' && typeof vv.waitsFor.part === 'string' && vv.waitsFor.terrainCells > 0,
      `${tag}: RegionView.waiting while the growth waits on its land: ${vv?.waiting?.reason} with view.ext architect_mc:waitsFor ${json(vv?.waitsFor ?? null)}`, out.view);
    const lw = waits.find((w) => w.key?.startsWith('lot:')) ?? waits[0];
    check(!!lw && lw.reason === 'SITE_BUSY' && typeof lw.waitsFor.part === 'string' && lw.waitsFor.terrainCells > 0, `${tag}: an item of the growth (${lw?.key}) waits ${lw?.reason} with architect_mc:waitsFor ${json(lw?.waitsFor ?? null)}`);
  }
  // fed what its paid targets lack (what does not stand on the land builds), then the land to `frac`
  const fed = await feedOnce({ insert: async (tt, items) => (await call('dev.crate.insert', { site: tt, items, exact: true }, 120_000)).accepted ?? {} }, 15_000);
  const growthLand = (x) => (x.targets ?? []).filter((y) => !town0.has(y.target));
  if (frac === 50) {
    await hold(false);
    for (let i = 0; i < 600; i++) {
      const x = await terr(region);
      const ml = growthLand(x);
      if (ml.reduce((a, y) => a + y.built, 0) * 2 >= ml.reduce((a, y) => a + y.cells, 0)) break;
      await L.sleep(100);
    }
    await hold(true);
  } else if (frac === 100) {
    const f = await G.feed(ctx, region, { fraction: 1, timeoutMs: 1_800_000, every: 2000, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done && !st.view.busy });
    out.feedWaves = f.waves;
  }
  await L.settle(1500);
  const tH = await terr(region);
  const mineH = growthLand(tH);
  const ps1 = await pile();
  const consumed = G.minus(G.minus(ps1.ledger?.consumed, ps0.ledger?.consumed), G.minus(ps1.ledger?.returned, ps0.ledger?.returned));
  const rv = await call('dev.rv.state', { region }, 60_000);
  const half = mineH.reduce((a, x) => a + x.built, 0), all = mineH.reduce((a, x) => a + x.cells, 0);
  out.atUndo = { fed, consumed, staged: mineH.map((x) => [x.target, x.cells, x.built]), busy: rv.busy };
  const atFrac = frac === 0 ? half === 0 : frac === 50 ? half > 0 && half < all : half === all;
  check(all > 0 && atFrac, `${tag}: at the undo the growth's land is at ${frac}%: ${half} of ${all} staged cells (busy ${rv.busy})`, out.atUndo);
  // (every paid target of this growth stands on or beside its pads: while the land is held none starts, so paid == returned is 0 == 0 there;
  // at 100% it is the whole growth's bill)
  check(frac < 100 || sum(consumed) > 0, `${tag}: what the growth's paid targets consumed before the undo: ${sum(consumed)} (${json(consumed)})`, consumed);
  // RU: undoRevision (while it waits, at 0 and 50%)
  const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
  await hold(false);
  await L.settle(3000);
  const ps2 = await pile();
  const d = await G.diff(ctx, box, before);
  const ef = d.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  out.undo = { result: u, eflat: ef.length, list: ef.slice(0, 8) };
  check(u.removed === true && ef.length === 0, `${tag}: undoRevision ${frac < 100 ? 'while the growth waits on its land' : 'of the built growth'}: removed ${u.removed}${u.refused ? ` (refused ${u.refused})` : ''}; the ${frac === 50 ? 'half-built ' : ''}terrain restored, the world before the growth (${ef.length} differ)`, out.undo);
  const put = G.minus(ps2.ledger?.delivered, ps0.ledger?.delivered);
  const back = G.minus(ps2.stock, ps0.stock);
  check(G.same(u.refund, consumed) && G.same(put, back) && ps2.identity !== false, `${tag}: paid == returned: the refund ${json(u.refund)} is what the growth consumed ${json(consumed)}; every item put in (${sum(put)}) is back in the stock (${sum(back)}); identity ${ps2.identity}`, { refund: u.refund, consumed, put, back });
  const left = growthLand(await terr(region));
  const sv = await call('dev.rv.state', { region }, 60_000);
  check(left.length === 0 && sv.busy === null && sv.position === 0, `${tag}: none of the growth's staged targets is left (${left.length}); the region at position ${sv.position}, busy ${sv.busy}`);
  return out;
}

steps.report = async () => {
  const rows = [];
  for (const s of ['remove', 'halt', 'growth']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 8a-HB (half-built safety)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate8ahb.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
