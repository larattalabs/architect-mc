#!/usr/bin/env node
// Phase 7a slice K3 gate (docs/CONTRACT.md "Phase 7a slice K3: towers and gatehouses as lots on a wall's line" §10) against a dev client
// or the headless server of the K3 run worktree (`../architect-mc-K3-run`, a detached worktree at this checkout's HEAD; the sim sidecar,
// no Claude). Ports 8972 (sidecar) / 8973 (DevBridge) by default (the runner sets its own, in 8970-8979). $0: no Claude call anywhere.
//
//   node tools/gate7ak3.mjs <step>
//     start [world] | stop | base      the client (or headless server) and the base worlds (G6B Seed Base, G6B Flat Base)
//     unit      (k3-unit)               items 1, 3, 5 (kit), 9, 10 offline: kit/test/k3.test.mjs (the mapping of every recorded key, withholding
//                                       and the fallback, siting at corners, gates and runs, the band, the cut, the passage move and the
//                                       inner lane, M2:wall provisional with the boxes, onWall and ports, the graph's passage, siteplan
//                                       walls[].lots; the closure with the stub designs bound and broken; Steward's recorded plans; KC;
//                                       determinism), K1's and K2's wall tests, the foundation's and P0's; the structure lint's p0:k3 and
//                                       p0:valid; the Java (PlanChecksK3Test, ApiK3Test, LotMaskTest); api-compat against the archived jars
//     unchanged (k3-unit)               item 2: every committed plan fixture naming no wall lot plans as on the merge base (answers, IR, the
//                                       first plan), but K3's named movers (tools/lib/k3-norm.mjs K3_MOVED: the recorded walls and their zones)
//     ingame    (k3-ingame)             items 4-8 and 10 on a flat world (headless): k3_castle_flat (v7a_k3_castle in plan v1's shape) on
//                                       its terrain by commands: Regions.checkPlan 3 times (one artifact; READY; the wall fits, provisional,
//                                       its lots onWall); the stub designs written per lot; item 7: realiseApproved with a tower whose door
//                                       is on an outer face, then a gatehouse whose passage floor is a fence row: each refused ARTIFACT_STALE
//                                       naming the lot and the cells, 0 cells changed (hash); item 4: realiseApproved with the stub designs:
//                                       PLACED; item 5: the realised dumps re-read (the closure with the designs bound: 0 leaks for both
//                                       movers, every node across; the passage open, its floor standable); realised == virtual (walls);
//                                       item 6: vanilla dev.nav.villager from every inside lot out through the passage to the front port and
//                                       back (the hard bar); item 8: Regions.remove E-flat 0 (the lots removed with the region)
//     survival  (k3-survival)           undo and survival accounting (the verifier re-runs it): k3_castle_flat in survival with the stub
//                                       designs, the gatehouse's passage walled in its design (the realise drops those blocks): checked in
//                                       survival, fed from a stockpile, built; the bills per part equal the check's cost.survival.bom; the
//                                       gatehouse's site never bills, writes or owns a passage cell; the world equal to its INSTANT twin;
//                                       removed: E-flat 0
//     look      (k3-look)               item 11 (client, recorded not judged: N-K3-1): the castle in three bibles (default, infernal, coastal),
//                                       the stub designs in each bible's roles: from outside (high and at the gate), through the gate
//                                       passage, a tower's top, the wall meeting a tower, at dusk (the lamps)
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7a-k3/<step>.json in the main checkout (GATE7AK3_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testConcurrencyArgs } from './lib/cpu-budget.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kitReuse } from './lib/kit-reuse.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-K3-run');
process.env.GATE6B_OUT = process.env.GATE7AK3_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7a-k3');
process.env.GATE6B_SIDECAR_PORT ??= '8972';
process.env.GATE6B_DEV_PORT ??= '8973';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, cmd, connect, leaveWorld, log, results, root, state, startClient, stopClient } = L;
const core = await import('./lib/gate6chy-core.mjs');
const B = await import('./lib/gate6chy-b.mjs');
const G = await import('./lib/gate6crs-game.mjs');
const D = await import('./lib/gate7ak3-designs.mjs');

L.refuseKeys();
const SEED = '2026100906';
const BASE = 'G6B Seed Base', FLAT = 'G6B Flat Base';
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const ctx = { L, OUT, KIT, imp, json, root, check, log, core, B };
const CASTLE = 'k3/k3_castle_flat.json';
const runsOf = (flat) => { const out = []; for (let i = 0; i + 3 < (flat ?? []).length; i += 4) for (let y = flat[i + 2]; y <= flat[i + 3]; y++) out.push([flat[i], y, flat[i + 1]]); return out; };

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice K3 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6C K3 Lobby', { backend: 'sim' });
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

function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...testConcurrencyArgs(), ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
const kitOnce = (files) => kitReuse(root, files) ?? nodeTest(files);

steps.unit = async () => {
  const out = {};
  out.k3 = kitOnce(['kit/test/k3.test.mjs']);
  check(out.k3.code === 0 && out.k3.fail === 0 && out.k3.pass >= 11, `items 1, 3, 5 (kit), 9, 10 (kit): the mapping of every recorded key, withholding and the fallback (a lot back to its zone, K1's join noted), siting at corners, gates and runs, the band, the cut (K5), the passage move and the inner lane, M2:wall provisional with the boxes, onWall and ports, the passage node and edge, siteplan walls[].lots; the closure with the stub designs bound (0 leaks, every node across) and an outer door leaking; Steward's recorded plans; KC (M25:clear 0); determinism; the stub designs in three bibles: ${out.k3.pass} pass, ${out.k3.fail} fail`, out.k3.failing);
  out.walls = kitOnce(['kit/test/plan-k1a.test.mjs', 'kit/test/k2.test.mjs', 'kit/test/f7a-foundation.test.mjs', 'kit/test/plan-p0.test.mjs', 'kit/test/plan-p0-valid.test.mjs', 'kit/test/k1-foundation.test.mjs', 'kit/test/region-lint.test.mjs']);
  check(out.walls.code === 0 && out.walls.fail === 0, `items 1, 2 (kit): K1a's and K2's wall tests (castle_city's lots on its line; a lot the wall can't site keeps K1's join), the foundation's, P0's and the realise lint: ${out.walls.pass} pass, ${out.walls.fail} fail`, out.walls.failing);
  const lint = spawnSync(process.execPath, ['tools/lint.mjs', 'structure', '--only', 'p0:k3,p0:valid/1,p0:valid/2,p0:valid/3,p0:valid/4,p0:valid/5,p0:valid/6'], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  out.lint = `${lint.stdout}${lint.stderr}`.trim().split('\n').slice(-16);
  check(lint.status === 0, 'item 1 (lint): the structure lint\'s p0:k3 (the castle, its run lots, the KC row, the line: M2:wall, M8:wall, the walk\'s rules, S-THEME clean) and p0:valid (the K3 fixtures among them)', out.lint);
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const j = spawnSync(path.join(root, 'mod', 'gradlew'), ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.region.PlanChecksK3Test', '--tests', 'dev.larattalabs.architect.api.ApiK3Test', '--tests', 'dev.larattalabs.architect.site.LotMaskTest'], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  out.java = `${j.stdout}${j.stderr}`.trim().split('\n').slice(-6);
  check(j.status === 0, 'items 7, 10 (Java): PlanChecksK3Test (the bind check: outer faces closed, the passage floor standable, rotations, a design smaller than its box refused, malformed onWall ignored), ApiK3Test (the feature wallLots), LotMaskTest (the passage key unions with irrigation; the drain stays irrigation\'s)', out.java);
  // api-compat against the archived apitest jars (the 0.47.0 and 0.45.0 tags': every member they call still there) and the 0.47.0 mod
  // jar's whole API surface (no record, method or enum value changed)
  const jars = [path.join(root, 'artifacts', 'gate6d-rv', 'jars'), path.join(root, '..', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars')].find((d) => fs.existsSync(path.join(d, 'architect_apitest-0.47.0.jar')));
  out.compat = {};
  if (jars) for (const [name, args] of [['apitest 0.47.0', [path.join(jars, 'architect_apitest-0.47.0.jar')]], ['apitest 0.45.0', [path.join(jars, 'architect_apitest-0.45.0.jar')]], ['surface 0.47.0', ['--surface', path.join(jars, 'architect_mc-0.47.0.jar')]]]) {
    const c = spawnSync(process.execPath, ['tools/api-compat.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
    out.compat[name] = { status: c.status, tail: `${c.stdout}${c.stderr}`.trim().split('\n').slice(-4) };
  }
  check(!!jars && Object.values(out.compat).length === 3 && Object.values(out.compat).every((c) => c.status === 0), `item 10: api-compat clean against the archived 0.47.0 and 0.45.0 apitest jars and the 0.47.0 API surface (${jars ? json(Object.fromEntries(Object.entries(out.compat).map(([k, v]) => [k, v.status]))) : 'no archived jars'})`, out.compat);
  spendZero();
  return out;
};

steps.unchanged = async () => {
  const { K3_MOVED } = await import('./lib/k3-norm.mjs');
  const K = await import('./lib/gate7a-kit.mjs');
  const u = await K.unchanged(root, { check, log, base: 'K3', except: K3_MOVED, mergedIf: 'kit/lib/connectors/wallLots.mjs' });
  fs.writeFileSync(path.join(OUT, 'k3-unchanged.json'), `${JSON.stringify(u, null, 1)}\n`);
  return { base: u.base, head: u.head, n: u.n, same: u.same, differ: u.differ, moved: u.moved };
};

// ------------------------------------------------------------------ the designs

/** The kit's design toolbox for the stub designs (tools/lib/gate7ak3-designs.mjs). */
async function kitK() {
  const kit = await imp('lib/kit.mjs');
  const style = await imp('lib/connectors/style.mjs');
  return { Blueprint: kit.Blueprint, palette: kit.palette, variant: kit.variant, shapeOf: style.shapeOf, doorOf: style.doorOf };
}

/**
 * Write a stub design for each wall lot of an artifact (k3_<lot><suffix>) in a bible's roles into the run's library, then reload it.
 * `variants`: {lotId: {suffix, opts}} (a broken variant under its own id). Returns {lotId: entry id}.
 */
async function writeDesigns(lots, { bible = null, variants = {}, roofed = !bible } = {}) {
  const K = await kitK();
  const { resolveRoles } = await imp('lib/region/plan.mjs');
  const { writeBlueprint } = await imp('lib/write.mjs');
  const roles = resolveRoles(bible ? JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'bibles', `${bible}.json`), 'utf8')).roles : {});
  const ids = {};
  for (const l of lots.filter((q) => q.onWall)) {
    for (const [suffix, opts] of [['', {}], ...Object.entries(variants[l.id] ?? {})]) {
      const id = `k3_${l.id}${suffix}${bible ? `_${bible.replace(/^g7ak1_/, '')}` : ''}`;
      const bp = l.onWall.passage ? D.gatehouseDesign(K, id, l, roles, opts) : D.towerDesign(K, id, l, roles, { roof: roofed, ...opts });
      const dir = path.join(L.LIBRARY, id);
      fs.rmSync(dir, { recursive: true, force: true });
      writeBlueprint(bp, dir);
      if (!suffix) ids[l.id] = id; else ids[`${l.id}${suffix}`] = id;
    }
  }
  await cmd('/architect reload');
  await L.settle(1500);
  return ids;
}

/** The artifact's lots (dev.region.artifact). */
async function artifactLots(sha) {
  const a = await call('dev.region.artifact', { sha, body: true }, 120_000);
  const find = (o) => (o && typeof o === 'object' ? (Array.isArray(o.lots) && o.lots.some((l) => l?.onWall)) ? o.lots : Object.values(o).map(find).find(Boolean) : null);
  return find(a) ?? [];
}

// ------------------------------------------------------------------ in game: the re-read

/** The realised world from two dumps (the plan's virtual world marks its cells), the checker on it (the wall lots bound), and the plan. */
async function realisedOf(planDir, beforeFile, afterFile) {
  const { buildVirtual, decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
  const { checkRegion } = await imp('lib/region/check.mjs');
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const before = await decodeArwd(fs.readFileSync(beforeFile)), after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { virtual: vw, lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false, boundLots: true });
  return { ir, meta, world, rep, vw };
}

/** Item 5 over the realised world: the closure with the designs bound, the passage open and standable, the wall's bars. */
function item5(tag, { ir, meta, world, rep }) {
  const out = {};
  const w = meta.walls[0];
  const m = rep.metrics.walls?.[w.id] ?? {};
  out.closure = m.closure ? Object.fromEntries(['player', 'villager'].map((mv) => [mv, { leaks: m.closure[mv].leaks, across: m.closure[mv].across, nodes: m.closure[mv].nodes, sample: m.closure[mv].leakSample?.slice(0, 6) }])) : null;
  check(!!m.closure && m.closure.bound?.length === w.lots.length, `item 5 (${tag}): the closure judged with the ${w.lots.length} wall lots' designs bound (their boxes no obstacle: the designs' own blocks)`);
  for (const mv of ['player', 'villager']) {
    const c = m.closure?.[mv];
    check(!!c && c.leaks === 0, `item 5 (${tag}): with the passage blocked, 0 inside-to-outside cells for the ${mv} (${c?.leaks})`, c?.leakSample);
    check(!!c && c.across === c.nodes, `item 5 (${tag}): with it open, ${c?.across} of ${c?.nodes} walk nodes across for the ${mv}`, c?.missed);
  }
  // the passage: its cells open (the realise dropped the design's blocks there), its floor standable
  const P = world.pal;
  out.passage = {};
  for (const l of ir.lots.filter((q) => q.onWall?.passage)) {
    const cells = runsOf(l.onWall.passage.cells);
    const shut = cells.filter(([x, y, z]) => !P.passable[world.get(x, y, z)]);
    const fl = l.onWall.passage.floor ?? [];
    let bad = 0;
    for (let i = 0; i + 2 < fl.length; i += 3) if (!P.floor[world.get(fl[i], fl[i + 2], fl[i + 1])]) bad++;
    out.passage[l.id] = { cells: cells.length, shut: shut.length, floor: fl.length / 3, unstandable: bad };
  }
  check(Object.keys(out.passage).length >= 1 && Object.values(out.passage).every((q) => q.shut === 0 && q.unstandable === 0), `item 5 (${tag}): the passage open through its gatehouse, its floor standable (${json(out.passage)})`);
  const bad = rep.findings.filter((f) => /^(M2:wall|M8:wall|M2:walk|M8:walk|M6:walk|M5:walk)$/.test(f.rule));
  out.wallFindings = bad.map((f) => `${f.rule} ${f.count}`);
  check(!bad.length, `item 5 (${tag}): the wall's and walk's rules on the realised world: ${bad.map((f) => `${f.rule}: ${f.message}`).join('; ').slice(0, 300) || 'none'}`);
  return out;
}

/** Vanilla's villager path from every lot inside the ring out through the gatehouse's passage (to its front port) and back. */
async function nav(meta, ir) {
  const out = {};
  const w = meta.walls[0], I = w.inside;
  const gh = w.lots.find((q) => q.passage);
  if (!gh) return out;
  const front = gh.passage.front;
  for (const l of ir.lots) {
    if (w.lots.some((q) => q.lot === l.id)) continue;
    const e = meta.lots?.[l.id]?.entrance;
    if (!e || !(e[0] > I[0] && e[0] < I[2] && e[2] > I[1] && e[2] < I[3])) continue;
    const ab = await call('dev.nav.villager', { from: e, to: front, range: 256 }, 120_000);
    const ba = await call('dev.nav.villager', { from: front, to: e, range: 256 }, 120_000);
    out[l.id] = { out: !!ab.canReach, back: !!ba.canReach, nodes: [ab.nodes ?? null, ba.nodes ?? null] };
  }
  return out;
}

/** The P2 SMOKE row: realised == virtual for the walls (the lots' own blocks are their designs'). */
async function smoke(tag, planDir, after, before) {
  const RV = await import('./lib/realised-virtual.mjs');
  const rv = await RV.realisedVsVirtual(planDir, after, before, { lots: false });
  check(RV.realisedOk(rv, ['walls'], { strict: true }).pass && (rv.byKind.walls?.differ ?? 0) === 0 && (rv.byKind.walls?.written ?? 0) > 0, `item 4/P2 SMOKE (${tag}): realised == virtual per writer kind, ${rv.differ} of ${rv.written} differ (walls ${rv.byKind.walls?.differ ?? '?'} of ${rv.byKind.walls?.written ?? 0}): ${RV.describeRealised(rv)}${rv.first.length ? ` first ${json(rv.first.slice(0, 3))}` : ''}`);
  return { written: rv.written, differ: rv.differ, byKind: rv.byKind, first: rv.first };
}

/** realiseApproved, expecting a refusal: {refused, message}. */
async function realiseRefused(sha, entries) {
  const rr = await call('dev.region.realiseApproved', { sha, lotEntries: entries }, 300_000);
  return { region: rr.region ?? null, refused: rr.refused ?? null };
}

steps.ingame = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, CASTLE);
  const s = await G.site(ctx, 'k3 castle', fx, { creative: true });
  await G.designs(ctx); // the houses' RS designs (rs_hut, rs_shed)
  // item 10: three checks under a frozen tick, one artifact
  await cmd('/tick freeze');
  const cks = [];
  for (let i = 0; i < 3; i++) cks.push(await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate' }, 1_800_000));
  await cmd('/tick unfreeze');
  const ck = cks[0];
  fs.writeFileSync(path.join(OUT, 'k3-castle-check.json'), `${JSON.stringify(ck, null, 1)}\n`);
  check(cks.every((c) => c.check?.artifactSha && c.check.artifactSha === ck.check.artifactSha), `item 10: 3 checks give one artifact (${cks.map((c) => c.check?.artifactSha?.slice(0, 12)).join(', ')})`);
  const w = (ck.check?.parts ?? []).find((a) => a.part === 'curtain_wall');
  out.check = { overall: ck.check?.overall, parts: (ck.check?.parts ?? []).map((a) => [a.part, a.class]), wall: w && { class: w.class, provisional: w.provisional, lots: w.geometry?.lots?.map((q) => [q.lot, q.at]) } };
  check(ck.check?.overall === 'READY' && w?.class === 'fits' && w?.provisional === true && (w.geometry?.lots?.length ?? 0) === 5, `item 4: k3_castle_flat (plan v1's shape) checks READY through Regions.checkPlan; the wall fits, provisional, its 5 lots on the line (${json(out.check.wall)})`);
  if (!ck.check?.artifactSha) { await leaveWorld(); return out; }
  const sha = ck.check.artifactSha;
  const lots = await artifactLots(sha);
  check(lots.filter((l) => l.onWall).length === 5 && lots.find((l) => l.id === 'gatehouse_1')?.ports?.length === 2, `item 4: the artifact's lots carry onWall (5) and the gatehouse its ports (front, back)`);
  const ids = await writeDesigns(lots, { variants: { tower_1: { _door: { outerDoor: true } }, gatehouse_1: { _floor: { badFloor: true } } } });
  const entries = { ...fx.lotEntries, ...Object.fromEntries(Object.entries(ids).filter(([k]) => !k.includes('_door') && !k.includes('_floor'))) };
  const box = G.boxOf(s.W);
  box[4] = Math.max(box[4], s.W.maxY + 48); // the towers' height
  // item 7: the bind refusals, nothing written
  const pre = await G.snap(ctx, box, 'k3-pre');
  out.refusals = {};
  for (const [lot, bad, want] of [['tower_1', ids.tower_1_door, /lot tower_1 on wall curtain_wall: the design leaves the wall open at .* \(\d+ cells\)/], ['gatehouse_1', ids.gatehouse_1_floor, /lot gatehouse_1 on wall curtain_wall: the passage floor is not standable at .* \(\d+ cells\)/]]) {
    const r = await realiseRefused(sha, { ...entries, [lot]: bad });
    const msg = String(r.refused?.message ?? r.refused?.reason ?? JSON.stringify(r.refused ?? null));
    const d = await G.diff(ctx, box, pre);
    out.refusals[lot] = { refused: r.refused, region: r.region, changed: d.mismatches };
    check(!r.region && /ARTIFACT_STALE/.test(JSON.stringify(r.refused)) && want.test(msg), `item 7: ${lot} bound to ${bad} is refused through realiseApproved naming the lot and the cells: ${msg.slice(0, 220)}`);
    check(d.mismatches === 0, `item 7: ${lot}'s refusal wrote nothing: ${d.mismatches} cells changed (hash)`, d.list.slice(0, 6));
  }
  // item 4: realised with the stub designs
  const before = path.join(OUT, 'k3-castle-before.arwd.gz'), after = path.join(OUT, 'k3-castle-after.arwd.gz');
  await call('dev.region.dump', { box, file: before, light: true }, 1_800_000);
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await G.realise(ctx, sha, entries);
  const st = await L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
  check(st.view.state === 'PLACED', `item 4: realiseApproved with the stub designs bound (${Object.keys(entries).length} lots): ${st.view.state}`);
  await L.settle(5000);
  await call('dev.region.dump', { box, file: after, light: true }, 1_800_000);
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId ?? st.view.planId);
  check(fs.existsSync(path.join(planDir, 'ir.json')), `item 5: the check's plan dir (${path.basename(planDir)})`);
  if (fs.existsSync(path.join(planDir, 'ir.json'))) {
    const R = await realisedOf(planDir, before, after);
    out.item5 = item5('castle', R);
    out.smoke = await smoke('castle', planDir, after, before);
    await cmd('/kill @e[type=!minecraft:player]');
    out.nav = await nav(R.meta, R.ir);
    check(Object.keys(out.nav).length >= 3 && Object.values(out.nav).every((v) => v.out && v.back), `item 6 (the hard bar): vanilla dev.nav.villager from every lot inside out through the gatehouse's passage to its front port and back (${json(Object.fromEntries(Object.entries(out.nav).map(([k, v]) => [k, [v.out, v.back]])))})`);
  }
  // item 8: the region removed, the lots with it
  const rm = await G.remove(ctx, region);
  const d = await G.diff(ctx, box, pre);
  out.exact = { removed: rm.removed, mismatches: d.mismatches, classes: d.classes, list: d.list.slice(0, 20) };
  check(rm.removed && d.mismatches === 0, `item 8: Regions.remove: E-flat ${d.mismatches} over the claim (the wall, its lots and their designs gone, the land as it was)`, d.list.slice(0, 8));
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ survival: undo and accounting (RS)

steps.survival = async () => {
  await ensure();
  const out = {};
  const fx = G.fixture(ctx, CASTLE);
  // the designs: written from a creative check of the same plan (the artifact's lots), the gatehouse's passage walled (dropped at realise)
  const s0 = await G.site(ctx, 'k3 designs', fx, { creative: true });
  const ck0 = await call('dev.region.checkPlan', { plan: s0.wp.plan, claim: s0.W.claim, owner: G.OWNER, anchors: s0.wp.anchors, load: 'generate' }, 1_800_000);
  const lots0 = await artifactLots(ck0.check.artifactSha);
  const ids = await writeDesigns(lots0, { variants: { gatehouse_1: { _walled: { openPassage: false } } } });
  await leaveWorld();
  const entries = { ...fx.lotEntries, ...Object.fromEntries(Object.entries(ids).filter(([k]) => !k.includes('_walled'))), gatehouse_1: ids.gatehouse_1_walled };
  const T = await G.twin(ctx, 'k3', fx, entries);
  const s = await G.site(ctx, 'k3', fx);
  const box = G.boxOf(s.W);
  box[4] = Math.max(box[4], s.W.maxY + 48);
  const pre = await G.snap(ctx, box, 'k3-surv-pre');
  const ck = await G.check(ctx, 'k3', s);
  const w = (ck.check?.parts ?? []).find((q) => q.part === 'curtain_wall');
  out.check = { overall: ck.check?.overall, survival: ck.check?.survival, cost: w?.cost?.survival ? { free: w.cost.survival.free, held: w.cost.survival.held } : null };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!w?.cost?.survival, `survival: k3_castle_flat through Regions.checkPlan in survival: ${ck.check?.overall}, survival ${ck.check?.survival}`);
  if (!ck.check?.artifactSha) return out;
  const crateAt = await G.pile(ctx, s, 8);
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  const f = await G.feed(ctx, region, { fraction: 0.5, timeoutMs: 5_400_000 });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, state: st.view.state, build: rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent } };
  check(st.view.state === 'PLACED' && rs.build?.done && rs.build?.percent === 100, `survival: realiseApproved in survival and fed in ${f.waves} waves: ${st.view.state}, build ${json(out.feed.build)}`);
  const bills = G.billsOf(ck, rs);
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.billsDiffer = differ;
  check(differ.length === 0, `survival: the check's cost.survival.bom against the targets' bills put down, per part: ${differ.length ? differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ') : 'equal, item for item (BOM exact)'}`, bills);
  // the gatehouse's site never bills a passage cell: its target's bill is its design's blocks less the ones its passage drops (the walled
  // design's blocks there)
  const gl = lots0.find((l) => l.id === 'gatehouse_1');
  const tgt = (rs.targets ?? []).find((t) => t.part === 'lot:gatehouse_1' || t.lot === 'gatehouse_1');
  const { bomOf } = await imp('lib/connectors/bom.mjs');
  const K = await kitK();
  const { resolveRoles } = await imp('lib/region/plan.mjs');
  const bp = D.gatehouseDesign(K, 'probe', gl, resolveRoles({}), { openPassage: false });
  const pass = new Set(D.frameOf(gl).passage.map(([u, y, v]) => `${u},${y + 1},${v}`));
  const stateOf = (c) => (Object.keys(c.state.props).length ? `${c.state.name}[${Object.entries(c.state.props).map(([a, b]) => `${a}=${b}`).join(',')}]` : c.state.name);
  const kept = [...bp.cells].filter(([k, c]) => !pass.has(k) && c.state.name !== 'minecraft:air').map(([, c]) => stateOf(c));
  const dropped = [...bp.cells].filter(([k, c]) => pass.has(k) && c.state.name !== 'minecraft:air').length;
  out.gatehouse = { target: tgt ? { part: tgt.part, bom: tgt.bom } : null, dropped, want: bomOf(kept) };
  check(!!tgt && dropped > 0 && G.same(tgt.bom, out.gatehouse.want), `survival: the gatehouse's site bills its design less the ${dropped} blocks its passage drops (never billed, written or owned): ${tgt ? json(G.minus(tgt.bom, out.gatehouse.want)) : 'no target'} off`, out.gatehouse);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `survival: the build equals its INSTANT twin cell for cell (the crates aside; the passage open in both): ${d.mismatches} differ`, d.list);
  const rm = await G.remove(ctx, region);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
  out.eflat = { removed: rm.removed, mismatches: ef.length, list: ef.slice(0, 8) };
  check(rm.removed && ef.length === 0, `survival: Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
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
  const r = await call('dev.screenshot', { name: `k3_${name}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
  const dir = path.join(OUT, 'look');
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, eye, at, file: dst, width: r.width, height: r.height };
}

steps.look = async () => {
  await ensure();
  const out = { shots: [], runs: {} };
  for (const b of LOOK_BIBLES) if (b) installBible(b);
  const only = process.env.K3_LOOK_ONLY ? new Set(process.env.K3_LOOK_ONLY.split(',')) : null;
  for (const bible of LOOK_BIBLES) {
    const tag = bible ? bible.replace(/^g7ak1_/, '') : 'default';
    if (only && !only.has(tag)) continue;
    const fx = G.fixture(ctx, CASTLE);
    const s = await G.site(ctx, `k3 look ${tag}`, fx, { creative: true });
    await G.designs(ctx);
    await cmd('/time set 6000');
    const ck = await call('dev.region.checkPlan', { plan: s.wp.plan, claim: s.W.claim, owner: G.OWNER, anchors: s.wp.anchors, load: 'generate', ...(bible ? { bible } : {}) }, 1_800_000);
    const w = (ck.check?.parts ?? []).find((q) => q.part === 'curtain_wall');
    check(ck.check?.overall === 'READY' && (w?.geometry?.lots?.length ?? 0) === 5, `look (${tag}): the castle checks READY in ${bible ?? 'the default bible'} with its 5 wall lots (recorded, not judged: Noah's call, N-K3-1)`);
    if (!ck.check?.artifactSha) { await leaveWorld(); continue; }
    const lots = await artifactLots(ck.check.artifactSha);
    const ids = await writeDesigns(lots, { bible });
    const entries = { ...fx.lotEntries, ...ids };
    const region = await G.realise(ctx, ck.check.artifactSha, entries);
    const st = await L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.waiting?.reason)) await cmd('/kill @e[type=!minecraft:player]'); });
    out.runs[tag] = { state: st.view.state };
    const gh = w.geometry.lots.find((q) => q.passage), t2 = w.geometry.lots.find((q) => q.lot === 'tower_2');
    const ring = w.geometry.ring;
    const cx = (ring[0] + ring[2]) / 2, cz = (ring[1] + ring[3]) / 2, top = Math.max(...lots.filter((l) => l.onWall).map((l) => l.box[1])) + 8;
    const [fx0, fy, fz] = gh.passage.front, [bx, , bz] = gh.passage.back;
    const ox = Math.sign(fx0 - bx), oz = Math.sign(fz - bz);
    // outside: the castle high from beyond the gatehouse; the gatehouse at eye level from the road
    out.shots.push(await shot(`${tag}_outside_high`, [fx0 + ox * 46 + (oz ? 30 : 0), top + 26, fz + oz * 46 + (ox ? 30 : 0)], [cx, top - 4, cz]));
    out.shots.push(await shot(`${tag}_gatehouse`, [fx0 + ox * 16 + 0.5, fy + 3, fz + oz * 16 + 0.5], [fx0 + 0.5, fy + 3, fz + 0.5]));
    // the gate passage: from just outside the front port looking through to the back
    out.shots.push(await shot(`${tag}_passage`, [fx0 + ox * 3 + 0.5, fy + 1.6, fz + oz * 3 + 0.5], [bx + 0.5, fy + 1.4, bz + 0.5]));
    // a tower's top (tower_2's deck, from over it) and the wall meeting the tower (the walk's dead end against its face)
    const [x0, y0, z0, x1, , z1] = t2.box;
    const tcx = (x0 + x1) / 2, tcz = (z0 + z1) / 2;
    out.shots.push(await shot(`${tag}_tower_top`, [tcx + Math.sign(cx - tcx) * 7, y0 + 30, tcz + Math.sign(cz - tcz) * 7], [tcx, y0 + 21, tcz]));
    out.shots.push(await shot(`${tag}_junction`, [tcx + Math.sign(cx - tcx) * 14, y0 + 11, tcz + Math.sign(cz - tcz) * 4], [tcx, y0 + 7, tcz + Math.sign(cz - tcz) * 6]));
    if (!bible) {
      await cmd('/time set 13000');
      out.shots.push(await shot(`${tag}_dusk`, [fx0 + ox * 30 + (oz ? 20 : 0), top + 14, fz + oz * 30 + (ox ? 20 : 0)], [cx, top - 6, cz]));
    }
    await call('dev.release', {}).catch(() => null);
    await leaveWorld();
  }
  fs.writeFileSync(path.join(OUT, 'look', 'look.json'), JSON.stringify(out, null, 2));
  spendZero();
  return out;
};

// ------------------------------------------------------------------ the report

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'unchanged', 'ingame', 'survival', 'look']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  spendZero();
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 7a-K3 (towers and gatehouses on a wall's line)\n\nSpend: $0.00 (cap $0).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7ak3.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${L.fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(L.fails() ? 1 : 0);
