#!/usr/bin/env node
// Phase 6c slice PT2 gate (docs/CONTRACT.md "Phase 6c slice PT2: adopt a build as a site" §10). Headless steps place every block
// through a fake ServerPlayer's useItemOn (dev.pt.uses: ServerPlayerGameMode, never setBlock, which would skip the recording hook) and
// break through destroyBlock (dev.pt.breaks). Adoption, deltas, reverts and removals go through the public API (apitest). The cabin is
// PT's 9x7x9 log cabin (its door in the north wall) with a chest holding items, a bed and a sign, built by the fake player PTAlex.
// Ports 8928 (sidecar) / 8929 (DevBridge) unless the runner gives others (PT2's range 8924-8929). $0: no Claude call; spend.json $0.00.
//
//   node tools/gate6cpt2.mjs <step>
//     unit        items 3 (kit half) and 13 offline: kit/test/adopt-pt2.test.mjs (the captured source gives back v1 exactly, checks as a
//                 captured source, floors 1 changes one of v1's cells), the Java AdoptTest, JournalAdoptTest (adopt files v4, a 0.27.0
//                 reader refuses them), BuildsAdoptTest (builds.json for an older reader), ApiPT2Test, the pinned PT/P0 tests;
//                 api-compat --gate6cpt2 (0.27.0/0.26.0/0.25.0 jars, the 0.27.0 surface); $0
//     ingame      every in-game step below in turn (each also runs alone):
//       refusals  1  each §5 row: unknown, released, provisional, no consent, a consent not naming it, no actor, a stranger actor, an op
//                    actor (passes), already adopted (the message names the site), an unloaded chunk, an owned tracked cell, 97 wide, a
//                    column fill over 262,144 cells, a bad ext, tracking off; each leaves the world, the index and the library unchanged
//       adopt     2, 3  the cabin adopted: AdoptResult (version 1, front north from the door), world hash equal, 0 blocks written,
//                    ADOPTED with siteId, the tracked set and records unchanged, ext with the caller's keys and architect_mc:adopted; the
//                    entry's structure equals the world's footprint cells and column air, the chest's Items absent from the entry while
//                    the world's chest keeps them, skipped counts the void; the entry's captured source rebuilds v1 exactly (kit);
//                    the journal's adopt entry (before == after, files version 4); apitest apipt2
//       flow      4, 5, 7, 8 (run B), 9  cabins A and C: versionOf (sim) "add a floor" installs v2 by design, outdated lists 1 -> 2,
//                    checkDelta reports the growth with 0 kept and capturedChanged = the v1 cells it rewrites (C, applied clean); A's
//                    hand edits (a broken wall block, a block in the hatch the delta changes, one outside it): KEEP applies the floor,
//                    keeps and reports the hatch edit, leaves the others, the edits stay the player's; revert to v1: the floor gone, the
//                    hash equals the adopted state plus the edits; save and restart, chunks unloaded and reloaded: everything equal,
//                    apply and revert still work, a remove after the reload only un-adopts; run B: A's remove with its delta standing:
//                    the cabin stands with the edits (hash and records equal), the entry stays (two versions)
//       undoA     8  (run A) adopt then undo (remove): hash equal to before the adoption, the tracked set, placers and build ids 0
//                    mismatches, the build ACTIVE with siteId null, the entry trashed
//       survival  6  a survival world with a stockpile: adopt costs 0 and writes 0; the update builds from the stockpile; the ledger
//                    balances (items in = out) across adopt, update, revert and un-adopt; no refund for an adopted block
//       protect   10 a stroke, a road across it, felling at its wall and a region plan keep the adopted cabin; a consent naming the build
//                    lets a PLAYER_BLOCKS stroke clear it; growth over the player's lean-to refuses PLAYER_BUILD unless consent names it
//       states    11 an adopted build never demotes under 20 cells; a merge with an ACTIVE build keeps its id; two adopted builds do not
//                    merge; a split keeps the id on the largest part; releaseBuild refuses (adopted)
//       elsewhere 12 place and check of the adopted entry refuse placed_elsewhere; polish refuses adopted_polish; the entry's library
//                    delete while the site stands refuses
//     old027      13 (recorded) what a 0.27.0 reader does with this world's journal: 0.27.0's own JournalNbt and JournalStore (built in
//                    the v0.27.0 worktree) read every file of a world without adopt entries, refuse an adopt entry's files (version 4)
//                    and keep the entry's index row
//     report      REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-pt2/<step>.json in the main checkout (GATE6CPT2_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= here;
process.env.GATE6B_OUT = process.env.GATE6CPT2_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-pt2');
process.env.GATE6B_SIDECAR_PORT ??= '8928';
process.env.GATE6B_DEV_PORT ??= '8929';
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, GAME_DIR, MAIN, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, state, tp, write, copyWorld } = L;

refuseKeys();
fs.mkdirSync(OUT, { recursive: true });
const FLAT_BASE = 'G6B Flat Base';
const OWNER = 'gate:pt2';
const ALEX = 'PTAlex';
const json = (o) => String(JSON.stringify(o)).replaceAll(' ', '');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const KIT = path.join(root, 'kit');
const imp = (rel) => import(pathToFileURL(path.join(KIT, rel)).href);
const LIBRARY = () => path.join(GAME_DIR, 'architect', 'library');

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
  write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice PT2 is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}
function javaTests(tests) {
  const env = { ...process.env, JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', ...tests.flatMap((t) => ['--tests', `*${t.split('.').pop()}`])], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 3_600_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  return { code: g.status, results: Object.fromEntries(tests.map((t) => [t, xml(t)])) };
}

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/adopt-pt2.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 6, `item 3 (kit): the captured source gives back v1 exactly (raw states, tagged block-entity data, one part), checks as a captured source, and floors 1 changes exactly one of v1's cells (${out.kit.pass} pass, ${out.kit.fail} fail)`, out.kit.failing);
  const tests = ['site.AdoptTest', 'journal.JournalAdoptTest', 'placed.BuildsAdoptTest', 'api.ApiPT2Test', 'api.ApiPTTest', 'journal.JournalPtTest', 'region.ApiP0Test', 'apiimpl.ApiRulesTest'];
  out.java = javaTests(tests);
  const ok = (v) => v && v.tests > 0 && v.failures === 0;
  check(out.java.code === 0 && tests.every((t) => ok(out.java.results[t])), `Java: ${tests.map((t) => `${t.split('.').pop()} ${json(out.java.results[t])}`).join(', ')}`);
  const classes = [['main', 'client'].map((d) => path.join(root, 'mod', 'build', 'classes', 'java', d)).join(path.delimiter)];
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cpt2', ...classes], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 13: api-compat against the 0.27.0, 0.26.0 and 0.25.0 apitest jars and the 0.27.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  check(JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8')).totalUsd === 0, 'item 13: spend $0.00');
  return out;
};

// ------------------------------------------------------------------ in game: helpers

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null' || m.startsWith('"'));
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const apiResult = async (pending, timeoutMs = 300_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const later = async (args, t) => apiResult(await api(args), t);
const uses = async (ops) => (await call('dev.pt.uses', { ops }, 900_000)).results;
const breaks = async (at, placer = ALEX) => call('dev.pt.breaks', { at, placer }, 600_000);
const cellsOf = async (box, list = false) => call('dev.pt.cells', { box, list }, 900_000);
const buildsIn = async (box, drain = true) => call('dev.pt.builds', { box, drain }, 600_000);
const ptAt = (at) => call('dev.pt.at', { at });
const uuidOf = async (name) => (await call('dev.pt.uuid', { name })).uuid;
const rule = (name, value) => call('dev.pt.rule', { name, value: String(value) });
const boxHash = async (b) => (await call('dev.box.hash', { min: b.slice(0, 3), max: b.slice(3) }, 300_000)).sha256;
const khash = async (b) => call('dev.pt.keptHash', { box: b }, 120_000);
const writes = async (b) => (await call('dev.writes.count', { box: b }, 60_000)).count;
const entryOf = (id) => call('dev.pt2.entry', { entry: id }, 30_000);
const compare = (site, version = 1) => call('dev.pt2.compare', { site, version }, 60_000);
const journalOf = (site) => call('dev.pt2.journal', { site }, 30_000);
const siteView = async (id) => (await api('sites')).all.find((s) => s.id === id);
const buildOf = async (id) => api(`ptbuild ${id}`);
const libraryDirs = () => (fs.existsSync(LIBRARY()) ? fs.readdirSync(LIBRARY()).filter((f) => !f.startsWith('.')).sort() : []);

/** The tracked cells of a box as "x,y,z" -> {placer, build}. */
async function cellMap(box) {
  const c = await cellsOf(box, true);
  const m = new Map();
  for (const [x, y, z, placer, build] of c.cells ?? []) m.set(`${x},${y},${z}`, { placer, build });
  return { map: m, sha256: c.sha256, tracked: c.tracked };
}
const diffMaps = (a, b) => {
  const out = [];
  for (const [k, v] of a) { const w = b.get(k); if (!w || w.placer !== v.placer || w.build !== v.build) out.push(`${k}: ${json(v)} -> ${json(w ?? null)}`); }
  for (const [k, w] of b) if (!a.has(k)) out.push(`${k}: none -> ${json(w)}`);
  return out;
};

/** The ground y at (x, z) from the region plan survey of a small claim around it. */
async function groundAt(x, z) {
  const f = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: f }, 300_000);
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(f));
  return c.ground[1 + 3 * 1];
}
/** A fresh copy of the flat base world, the exact rules, the player over (x, z), mobs cleared; returns the ground y there. */
async function flatWorld(name, x, z, { survival = false } = {}) {
  await ensure();
  await leaveWorld();
  copyWorld(FLAT_BASE, name);
  await openWorld(name);
  await L.setRules('exact');
  await cmd('/op @s');
  for (const r of ['spawn_mobs false', 'spawn_monsters false', 'mob_griefing false', 'random_tick_speed 0']) await cmd(`/gamerule ${r}`).catch(() => {});
  await rule('graceMs', 600000);
  await tp(x + 0.5, 0, z + 0.5);
  const gy = await groundAt(x, z);
  await tp(x + 0.5, gy + 25, z + 0.5);
  await cmd('/kill @e[type=!minecraft:player]');
  if (survival) await call('dev.survival.set', { on: true });
  return gy;
}

/** PT's log cabin 9 x 7 x 9 at (X, Y, Z) (Y: the floor row), its door in the north wall's middle (X+4, Z), the roof at Y+6. */
function cabinOps(X, Y, Z, { item = 'minecraft:oak_log', placer = ALEX, door = true } = {}) {
  const ops = [];
  for (let y = Y; y < Y + 6; y++) for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) {
    const edge = x === X || x === X + 8 || z === Z || z === Z + 8;
    if (!edge) continue;
    if (door && x === X + 4 && z === Z && (y === Y || y === Y + 1)) continue;
    ops.push({ item, at: [x, y, z], placer });
  }
  for (let x = X; x <= X + 8; x++) for (let z = Z; z <= Z + 8; z++) ops.push({ item, at: [x, Y + 6, z], placer });
  if (door) ops.push({ item: 'minecraft:oak_door', at: [X + 4, Y, Z], placer, yaw: 0 });
  return ops;
}
const cabinBox = (X, Y, Z) => [X, Y, Z, X + 8, Y + 6, Z + 8];
/** The cabin's contents: a chest (items put in by a command), a bed, a sign (its text by a command), each within 2 of a wall. */
const CHEST = (X, Y, Z) => [X + 2, Y, Z + 2];
const BED = (X, Y, Z) => [X + 6, Y, Z + 5];
const SIGN = (X, Y, Z) => [X + 2, Y, Z + 6];
/** The hatch kit/lib/adopt.mjs cuts into the old top layer for the first added storey: the inner column nearest the centre. */
const HATCH = (X, Y, Z) => [X + 4, Y + 6, Z + 4];
async function buildCabin(X, Y, Z, { placer = ALEX, contents = true } = {}) {
  await uses(cabinOps(X, Y, Z, { placer }));
  if (contents) {
    await uses([{ item: 'minecraft:chest', at: CHEST(X, Y, Z), placer, yaw: 180 }, { item: 'minecraft:red_bed', at: BED(X, Y, Z), placer, yaw: 0 },
      { item: 'minecraft:oak_sign', at: SIGN(X, Y, Z), placer, yaw: 180 }]);
    const c = CHEST(X, Y, Z);
    await cmd(`/item replace block ${c.join(' ')} container.0 with minecraft:diamond 5`);
    await cmd(`/item replace block ${c.join(' ')} container.1 with minecraft:bread 3`);
    const s = SIGN(X, Y, Z);
    await cmd(`/data merge block ${s.join(' ')} {front_text:{messages:["Alex","home","",""]}}`).catch(() => null);
  }
  await settle(6000);
  const b = (await buildsIn(cabinBox(X, Y, Z))).builds.filter((x) => x.kind === 'HOUSE' || x.cells > 200);
  return b[0];
}
/** apitest adopt -> the AdoptResult JSON or {refused, detail, message}. */
async function adopt(key, buildId, { owner = OWNER, consent = 'alex', ext = { 'steward_mc:role': 'house', 'steward_mc:name': 'Alex' } } = {}) {
  let c = '-';
  if (consent === 'alex') c = b64({ builds: [buildId], actor: await uuidOf(ALEX) });
  else if (consent && typeof consent === 'object') c = b64(consent);
  return later(`adopt ${key} ${buildId} ${owner ?? '-'} ${c}${ext ? ` ${b64(ext)}` : ''}`);
}
async function remove(site, force = false) {
  return later(`remove ${site} ${OWNER} ${force ? 'force' : 'noforce'}`);
}
/** versionOf (sim) of an adopted entry for its site: "add a floor" (the sim bumps the captured source's floors 0 -> 1). */
async function addFloor(key, entry, site) {
  const id = await later(`versionof ${key} ${b64({ type: 'adopted', notes: 'add a floor', size: [16, 20, 16], owner: OWNER })} ${entry} ${site}`, 300_000);
  if (typeof id !== 'string') return { requested: id };
  const end = Date.now() + 600_000;
  while (Date.now() < end) {
    const d = await api(`designget ${id}`);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(d?.status)) return { id, design: d };
    await sleep(1500);
  }
  return { id, timedOut: true };
}

// ------------------------------------------------------------------ item 1: refusals

steps.refusals = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 Refusals', X, Z);
  const y = gy + 1;
  const out = {};
  const cab = await buildCabin(X, y, Z);
  check(cab && cab.state === 'ACTIVE', `item 1: the cabin ${cab?.id} (${cab?.kind}, ${cab?.state}, ${cab?.cells} cells)`);
  // a released build, a provisional one
  const rel = await buildCabin(X + 20, y, Z, { contents: false });
  await api(`ptrelease ${rel.id}`);
  const prov = [];
  for (let i = 0; i < 30; i++) prov.push({ item: 'minecraft:cobblestone', at: [X + 40 + (i % 6), y + Math.floor(i / 6) % 5, Z], placer: ALEX });
  await uses(prov);
  await settle(6000);
  const pb = (await buildsIn([X + 38, gy, Z - 2, X + 48, gy + 8, Z + 2])).builds[0];
  check(pb?.state === 'PROVISIONAL', `item 1: a 30-cell component under the grace is ${pb?.id} ${pb?.state}`);
  // the world, the index and the library before
  const area = [X - 4, gy - 2, Z - 4, X + 60, gy + 12, Z + 14];
  const h0 = await boxHash(area);
  const idx = async () => json((await buildsIn(area, false)).builds.map((b) => [b.id, b.state, b.cells, b.revision, b.siteId ?? null]));
  const i0 = await idx();
  const l0 = libraryDirs();
  const stranger = await uuidOf('PTStranger');
  const alex = await uuidOf(ALEX);
  const want = async (label, r, reason, detail, extra = true) => {
    out[label] = r;
    check(r?.refused === reason && (detail == null || r.detail === detail) && extra, `item 1: ${label}: ${r?.refused ?? 'not refused'} ${r?.detail ?? ''} (${String(r?.message ?? json(r)).slice(0, 140)})`, r);
  };
  await want('unknown', await adopt('u', 'build-999', { consent: { builds: ['build-999'], actor: alex } }), 'ADOPT_REFUSED', 'not_a_build', true);
  await want('released', await adopt('r', rel.id, { consent: { builds: [rel.id], actor: alex } }), 'ADOPT_REFUSED', 'not_a_build');
  await want('provisional', await adopt('p', pb.id, { consent: { builds: [pb.id], actor: alex } }), 'ADOPT_REFUSED', 'provisional');
  await want('no consent', await adopt('c0', cab.id, { consent: null }), 'ADOPT_REFUSED', 'consent');
  await want('consent not naming it', await adopt('c1', cab.id, { consent: { builds: [rel.id], actor: alex } }), 'ADOPT_REFUSED', 'consent');
  await want('no actor', await adopt('c2', cab.id, { consent: { builds: [cab.id] } }), 'ADOPT_REFUSED', 'consent');
  await want('a stranger actor', await adopt('c3', cab.id, { consent: { builds: [cab.id], actor: stranger } }), 'ADOPT_REFUSED', 'consent');
  await want('bad ext (no namespace)', await adopt('e1', cab.id, { ext: { role: 'house' } }), 'FIELD_LIMIT', null);
  await want('bad ext (4097+ characters)', await adopt('e2', cab.id, { ext: { 'steward_mc:x': 'y'.repeat(4100) } }), 'FIELD_LIMIT', null);
  await rule('playerTracking', false);
  await want('tracking off', await adopt('t', cab.id), 'ADOPT_REFUSED', 'tracking_off');
  await rule('playerTracking', true);
  check(await boxHash(area) === h0 && await idx() === i0 && json(libraryDirs()) === json(l0), 'item 1: the refusals so far left the world, the index and the library unchanged');
  // an op actor (the bot, permission 2) passes, then already adopted names the site
  const op = await adopt('op', cab.id, { consent: { builds: [cab.id], actor: 'player' } });
  check(op?.siteId && op.version === 1, `item 1: an op actor (permission 2) passes: ${op?.siteId} ${op?.entryId}`, op);
  const again = await adopt('a2', cab.id);
  await want('already adopted', again, 'ADOPT_REFUSED', 'already_adopted', String(again?.message ?? '').includes(op?.siteId));
  const rm = await remove(op.siteId);
  check(rm?.removed, `item 1: the op's adoption un-adopted (remove: ${json(rm?.removed)})`, rm);
  // an owned tracked cell: a stroke lowers a pit beside the cabin's east wall, the player fills it (the build grows into owned cells)
  const ow = await buildCabin(X, y, Z + 30, { contents: false });
  const st = await call('dev.brush', { owner: OWNER, kind: 'lower', shape: 'cylinder', at: [X + 10, gy, Z + 34], radius: 1, strength: 2 }, 600_000);
  const pit = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -2; dy <= 0; dy++) pit.push({ item: 'minecraft:cobblestone', at: [X + 10, gy + dy, Z + 34 + dz], placer: ALEX });
  await uses(pit);
  await uses([{ item: 'minecraft:cobblestone', at: [X + 9, y, Z + 34], placer: ALEX }]);
  await settle(6000);
  const owb = (await buildsIn(cabinBox(X, y, Z + 30))).builds.find((b) => b.id === ow.id);
  out.ownedStroke = st;
  await want('an owned tracked cell', await adopt('o', owb.id), 'OVERLAP', null);
  // an unloaded chunk: a cabin 300 east, the player 900 away
  const far = await buildCabin(X + 300, y, Z, { contents: false });
  await tp(X + 1200.5, gy + 25, Z + 0.5);
  await settle(15000);
  await want('an unloaded chunk', await adopt('n', far.id), 'NOT_LOADED', null);
  await tp(X + 0.5, gy + 25, Z + 0.5);
  await settle(5000);
  // 97 wide: a cobble wall 97 x 3 x 1
  const wall = [];
  for (let x = 0; x < 97; x++) for (let yy = 0; yy < 3; yy++) wall.push({ item: 'minecraft:cobblestone', at: [X - 30 + x, y + yy, Z - 20], placer: ALEX });
  await uses(wall);
  await settle(6000);
  const wb = (await buildsIn([X - 32, gy, Z - 21, X + 68, gy + 5, Z - 19])).builds[0];
  check(wb && ['ACTIVE', 'PROVISIONAL'].includes(wb.state), `item 1: a wall 97 long: ${wb?.id} ${wb?.state} ${wb?.cells}`);
  if (wb?.state === 'PROVISIONAL') {
    await api(`ptclaim ${X - 30} ${y} ${Z - 20} ${X + 66} ${y + 2} ${Z - 20}`);
  }
  const wb2 = (await buildsIn([X - 32, gy, Z - 21, X + 68, gy + 5, Z - 19])).builds.find((b) => b.state !== 'RELEASED');
  await want('97 wide', await adopt('w', wb2.id), 'TOO_LARGE', null);
  // a column fill over 262,144 cells: a 65 x 65 floor and ceiling 63 apart joined by 4 pillars (bounds 65 x 64 x 65)
  const G = [X + 120, Z + 120];
  const big = [];
  for (let x = 0; x < 65; x++) for (let z = 0; z < 65; z++) {
    big.push({ item: 'minecraft:stone_bricks', at: [G[0] + x, y, G[1] + z], placer: ALEX });
    big.push({ item: 'minecraft:stone_bricks', at: [G[0] + x, y + 63, G[1] + z], placer: ALEX });
  }
  for (const [dx, dz] of [[0, 0], [64, 0], [0, 64], [64, 64]]) for (let yy = 1; yy < 63; yy++) big.push({ item: 'minecraft:stone_bricks', at: [G[0] + dx, y + yy, G[1] + dz], placer: ALEX });
  await tp(G[0] + 32.5, y + 30, G[1] + 32.5);
  for (let i = 0; i < big.length; i += 2000) await uses(big.slice(i, i + 2000));
  await settle(8000);
  const bb = (await buildsIn([G[0] - 1, gy, G[1] - 1, G[0] + 65, y + 64, G[1] + 65])).builds[0];
  check(bb && bb.cells > 8000, `item 1: the 65 x 64 x 65 shell: ${bb?.id} ${bb?.state} ${bb?.cells} cells`);
  const fr = await adopt('f', bb.id);
  await want('a column fill over 262,144 cells', fr, 'TOO_LARGE', null, /270400 cells/.test(String(fr?.message)));
  await tp(X + 0.5, gy + 25, Z + 0.5);
  await settle(3000);
  check(json(libraryDirs()) === json(l0), `item 1: the library holds the same entries after every refusal (${libraryDirs().length})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 2 and 3: the adoption and the capture

steps.adopt = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 Adopt', X, Z);
  const y = gy + 1;
  const out = {};
  const ap = await api('apipt2');
  check(ap.adopt === true && ap.adoptRefusedLast && ap.adoptedLast, `item 13: apitest apipt2 through the public API: version ${ap.version}, feature adopt, ADOPT_REFUSED and ADOPTED appended`, ap);
  const cab = await buildCabin(X, y, Z);
  // a natural block inside a column span (void: not the site's)
  await cmd(`/setblock ${X + 2} ${y + 1} ${Z + 2} minecraft:dirt`);
  await settle(2000);
  const box = [X - 2, gy - 2, Z - 2, X + 10, y + 8, Z + 10];
  const h0 = await boxHash(box);
  const c0 = await cellMap(cabinBox(X, y, Z));
  await writes(box); // starts counting
  const r = await adopt('a', cab.id);
  out.result = r;
  const w = await writes(box);
  check(r?.siteId && r.version === 1 && r.front === 'north' && r.frameGuessed === false, `item 2: adopted: ${r?.siteId} entry ${r?.entryId} v${r?.version}, front ${r?.front} from the door (guessed ${r?.frameGuessed}), ${r?.cells} cells (${r?.airCells} air, ${r?.blockEntities} block entities), ${r?.skipped} void`, r);
  check(await boxHash(box) === h0 && w === 0, `item 2: the world hash is equal before and after; ${w} blocks written`);
  const b = await buildOf(cab.id);
  check(b.state === 'ADOPTED' && b.siteId === r.siteId, `item 2: ${cab.id} is ${b.state} with siteId ${b.siteId}`, b);
  const c1 = await cellMap(cabinBox(X, y, Z));
  const dm = diffMaps(c0.map, c1.map);
  check(c1.tracked === c0.tracked && dm.length === 0, `item 2: the tracked set (${c1.tracked}) and each record unchanged (${dm.length} mismatches)`, dm.slice(0, 8));
  const sv = await siteView(r.siteId);
  const ad = sv?.ext?.['architect_mc:adopted'];
  check(sv?.ext?.['steward_mc:role'] === 'house' && sv?.ext?.['steward_mc:name'] === 'Alex' && ad?.build === cab.id && ad?.entry === r.entryId && ad?.at > 0 && sv.owner === OWNER,
    `item 2: the site's ext carries the caller's keys and architect_mc:adopted ${json(ad)}; owner ${sv?.owner}; version ${sv?.version}`, sv);
  check(sv?.kind === 'building' && sv?.state === 'BUILT' && sv?.rotation === 'NONE', `item 2: the site is a building, BUILT, rotation ${sv?.rotation}`);
  check(await api(`adoptedsite ${cab.id}`) === r.siteId, `item 2: adoptedSite(${cab.id}) = ${r.siteId}`);
  // item 3: the capture
  const cmp = await compare(r.siteId, 1);
  out.compare = cmp;
  const chest = (cmp.containers ?? []).find((c) => c.pos.replaceAll(' ', '') === CHEST(X, y, Z).join(','));
  check(cmp.found && cmp.mismatched === 0 && cmp.matched === r.cells, `item 3: the entry's structure equals the world's footprint cells and column air (${cmp.matched} of ${cmp.cells} match, ${cmp.mismatched} differ)`, cmp.sample);
  check(chest && chest.worldItems === 8 && chest.entryItems === 0, `item 3: the chest's Items are absent from the entry (${chest?.entryItems}) while the world's chest keeps them (${chest?.worldItems})`, cmp.containers);
  const en = await entryOf(r.entryId);
  out.entry = { ...en, json: undefined };
  check(en.found && en.blockEntities >= 4 && en.inventoryItems === 0 && en.mjs && en.json.sourceKind === 'captured' && en.json.adopted?.build === cab.id && en.json.source === `${r.entryId}.mjs`,
    `item 3: the entry ${r.entryId}: ${en.cells} cells, ${en.blockEntities} block entities (chest, bed, sign), 0 inventory items, a captured source (${en.json?.source}, sourceKind ${en.json?.sourceKind}), adopted ${json(en.json?.adopted)}`, en);
  const dirt = await ptAt([X + 2, y + 1, Z + 2]);
  check(r.skipped >= 1 && !dirt.tracked, `item 3: skipped counts the void (${r.skipped}: the natural dirt in the chest's column among them)`);
  // the captured source rebuilds v1 exactly (the kit, as versionOf's designer builds it)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt2-src-'));
  fs.mkdirSync(path.join(tmp, 'designs'));
  fs.symlinkSync(path.join(KIT, 'lib'), path.join(tmp, 'lib'));
  fs.copyFileSync(path.join(en.dir, `${r.entryId}.mjs`), path.join(tmp, 'designs', `${r.entryId}.mjs`));
  const mod = await import(pathToFileURL(path.join(tmp, 'designs', `${r.entryId}.mjs`)).href);
  const { writeBlueprint } = await imp('lib/write.mjs');
  const { diffFiles } = await imp('lib/diff.mjs');
  const built = writeBlueprint(mod.default({}), path.join(tmp, 'out'));
  const d = diffFiles(path.join(en.dir, `${r.entryId}.nbt`), built.nbtPath, { cells: true });
  check(d.added === 0 && d.removed === 0 && d.changed === 0 && d.frameKept, `item 3: the entry's captured source (kit/lib/adopt.mjs) rebuilds v1 exactly (added ${d.added}, removed ${d.removed}, changed ${d.changed}, ${d.unchanged} equal)`, d.cells);
  // the journal: one adopt entry, before == after (compare: 0 mismatches), its files version 4
  const j = await journalOf(r.siteId);
  out.journal = j;
  const e = (j.entries ?? []).filter((x) => x.status !== 'UNDONE');
  check(e.length === 1 && e[0].kind === 'adopt' && e[0].policy === 'BOX' && e[0].cells === r.cells && e[0].files.length > 0 && e[0].files.every((f) => f.endsWith('=4')),
    `item 2 / 13: the journal holds one adopt entry (BOX, ${e[0]?.cells} cells), its files version 4 (${json(e[0]?.files)})`, j);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ items 4, 5, 7, 8 (run B), 9: updates, hand edits, revert, reload

steps.flow = async () => {
  const X = 40, Z = 40, CX = 70;
  const world = 'G6B PT2 Flow';
  const gy = await flatWorld(world, X, Z);
  const y = gy + 1;
  const out = {};
  const A = await buildCabin(X, y, Z);
  const C = await buildCabin(CX, y, Z);
  const preC = await boxHash(cabinBox(CX, y, Z));
  const ra = await adopt('A', A.id);
  const rc = await adopt('C', C.id);
  check(ra?.siteId && rc?.siteId, `the cabins A ${A.id} and C ${C.id} adopted as ${ra?.siteId} and ${rc?.siteId}`);
  const v2box = (x) => [x, y, Z, x + 8, y + 11, Z + 8];
  // item 4: versionOf (sim) "add a floor"
  const fa = await addFloor('fa', ra.entryId, ra.siteId);
  out.versionOfA = fa;
  check(fa.design?.status === 'DONE', `item 4: versionOf(${ra.entryId}, ${ra.siteId}) "add a floor": ${fa.design?.status} (${String(fa.design?.step ?? json(fa)).slice(0, 160)})`, fa);
  const ev = await api(`eversions ${ra.entryId}`);
  const v2 = (ev.versions ?? []).find((v) => v.n === 2);
  check(ev.version === 2 && v2 && /design/i.test(v2.by) && v2.capturedChanged === 1 && v2.capturedTotal === ra.cells, `item 4: v2 installed by design (head ${ev.version}); capturedChanged ${v2?.capturedChanged} of capturedTotal ${v2?.capturedTotal}`, ev);
  const od = await api(`outdated ${OWNER}`);
  const oa = od.find((o) => o.site === ra.siteId);
  check(oa?.version === 1 && oa?.head === 2, `item 4: outdated lists ${ra.siteId} 1 -> 2`, od);
  const ca = await api(`checkdelta ${ra.siteId} 2 keep ${OWNER}`);
  out.checkA = ca;
  check(ca.applicable && ca.added >= 100 && ca.kept.length === 0 && ca.capturedChanged === 1 && ca.capturedTotal === ra.cells && !(ca.notes ?? []).some((n) => /frame/.test(n)),
    `item 4: checkDelta reports the growth (added ${ca.added}, removed ${ca.removed}, changed ${ca.changed}), 0 kept, capturedChanged ${ca.capturedChanged} / ${ca.capturedTotal}; the frame guard passes`, ca);
  // C, applied clean: capturedChanged equals the v1 cells the apply actually rewrites
  const fc = await addFloor('fc', rc.entryId, rc.siteId);
  const cc = await api(`checkdelta ${rc.siteId} 2 keep ${OWNER}`);
  const ac = await later(`applydelta ${rc.siteId} 2 keep ${OWNER}`);
  const cmpC = await compare(rc.siteId, 1);
  check(fc.design?.status === 'DONE' && ac.applied && cc.capturedChanged === cmpC.mismatched && cmpC.mismatched === 1, `item 4 (Steward's capturedChanged): C's v2 reports ${cc.capturedChanged}; applied, ${cmpC.mismatched} of v1's ${cmpC.cells} captured cells were rewritten`, cmpC.sample);
  // item 5: A's hand edits: a wall block broken, the hatch (a cell the delta changes) mined and refilled, a block outside the delta
  const wall = [X + 8, y + 2, Z + 4];
  const hatch = HATCH(X, y, Z);
  const inside = [X + 3, y, Z + 3];
  await breaks([wall, hatch]);
  await uses([{ item: 'minecraft:cobblestone', at: hatch, placer: ALEX }, { item: 'minecraft:cobblestone', at: inside, placer: ALEX }]);
  await settle(6000);
  const placers0 = json((await buildOf(A.id)).primaryPlacer);
  const hEdits = await boxHash(v2box(X));
  const ka = await api(`checkdelta ${ra.siteId} 2 keep ${OWNER}`);
  const ap = await later(`applydelta ${ra.siteId} 2 keep ${OWNER}`);
  out.applyA = ap;
  const kept = (ap.kept ?? []).find((k) => k.pos.replaceAll(' ', '') === hatch.join(','));
  check(ka.kept?.length === 1 && ap.applied && ap.kept?.length === 1 && kept && /cobblestone/.test(kept.found) && /air/.test(kept.planned), `item 5: checkDelta/applyDelta (KEEP): the hatch edit is kept and reported (found ${kept?.found}, planned ${kept?.planned})`, ap);
  const top = await call('dev.box.hash', { min: [X, y + 7, Z], max: [X + 8, y + 11, Z + 8], cells: true }, 120_000);
  const storey = (top.cells ?? []).filter((c) => !/air/.test(c.state ?? c[3] ?? JSON.stringify(c))).length;
  check(storey >= 100, `item 5: the floor is built (${storey} non-air cells above the roof)`);
  const sh = await call('dev.site.history', { site: ra.siteId }).catch(() => null);
  const w1 = await ptAt(wall);
  const e1 = await ptAt(hatch);
  const e2 = await ptAt(inside);
  check(!w1.tracked && e1.tracked && e2.tracked && json((await buildOf(A.id)).primaryPlacer) === placers0, `item 5: the broken wall stays broken, the edits stay the player's (records: hatch ${e1.tracked}, inside ${e2.tracked}), the build's placers unchanged`);
  const dev = (await siteView(ra.siteId))?.deviations;
  check(dev === 1, `item 5: deviations count the kept cell (${dev})`, sh);
  // item 7: revert to v1
  const rv = await later(`srevert ${ra.siteId} 1`);
  const hRev = await boxHash(v2box(X));
  const hist = await api(`shistory ${ra.siteId}`);
  check(rv.applied !== false && hRev === hEdits && hist.some((h) => h.kind === 'REVERT' || h.kind === 'PLACED') && (await ptAt(inside)).tracked, `item 7: revert(${ra.siteId}, 1): the floor gone, the hand edits stand, the hash equals the adopted state plus the edits (${hRev === hEdits}); history ${json(hist.map((h) => `${h.version}:${h.kind}`))}`, rv);
  // item 9: save and restart, chunks unloaded and reloaded
  const snap = async () => ({
    a: await siteView(ra.siteId), c: await siteView(rc.siteId), ba: await buildOf(A.id), bc: await buildOf(C.id), ea: await api(`eversions ${ra.entryId}`),
    recA: (await cellsOf(v2box(X))).sha256, recC: (await cellsOf(v2box(CX))).sha256, od: await api(`outdated ${OWNER}`),
    keptA: (await api(`checkdelta ${ra.siteId} 2 keep ${OWNER}`)).kept, hA: await boxHash(v2box(X)), hC: await boxHash(v2box(CX)),
  });
  const pick = (s) => json({ a: [s.a?.version, s.a?.ext, s.a?.owner], c: [s.c?.version, s.c?.ext], ba: [s.ba.state, s.ba.siteId], bc: [s.bc.state, s.bc.siteId], ea: s.ea.versions?.length,
    recA: s.recA, recC: s.recC, od: s.od, keptA: s.keptA, hA: s.hA, hC: s.hC });
  const s0 = await snap();
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld(world);
  await tp(X + 0.5, gy + 25, Z + 0.5);
  await settle(3000);
  const s1 = await snap();
  check(pick(s1) === pick(s0), 'item 9: after /save and a restart: the sites, their versions and ext, the entries, ADOPTED and siteId, the records, the kept cells and outdated are identical', { before: pick(s0), after: pick(s1) });
  await tp(X + 900.5, gy + 25, Z + 0.5);
  await settle(15000);
  const away = await cellsOf(cabinBox(X, y, Z));
  await tp(X + 0.5, gy + 25, Z + 0.5);
  await settle(4000);
  const s2 = await snap();
  check(away.tracked === 0 && pick(s2) === pick(s0), `item 9: after the chunks unload (${away.tracked} records readable 900 away) and load again: identical`);
  const ap2 = await later(`applydelta ${ra.siteId} 2 keep ${OWNER}`);
  const rv2 = await later(`srevert ${rc.siteId} 1`);
  check(ap2.applied && ap2.kept?.length === 1 && rv2.applied !== false, `item 9: applyDelta (A to 2, the hatch still kept) and revert (C to 1) still work after the reload`, { ap2, rv2 });
  const rmC = await remove(rc.siteId);
  const bC = await buildOf(C.id);
  check(rmC?.removed && await boxHash(cabinBox(CX, y, Z)) === preC && bC.state === 'ACTIVE' && !bC.siteId && (await entryOf(rc.entryId)).found,
    `item 9: a remove after the reload only un-adopts: C stands as before its adoption, ${C.id} ${bC.state}, the entry kept (two versions)`, rmC);
  // item 8, run B: A with its delta standing: remove
  const hB = await boxHash(cabinBox(X, y, Z));
  const rB = await cellMap(cabinBox(X, y, Z));
  const rmA = await remove(ra.siteId);
  const hB1 = await boxHash(cabinBox(X, y, Z));
  const rB1 = await cellMap(cabinBox(X, y, Z));
  const above = await call('dev.box.hash', { min: [X, y + 7, Z], max: [X + 8, y + 11, Z + 8], cells: true }, 120_000);
  const left = (above.cells ?? []).filter((c) => !/air/.test(JSON.stringify(c))).length;
  const eA = await entryOf(ra.entryId);
  const bA = await buildOf(A.id);
  check(rmA?.removed && left === 0 && hB1 === hB && diffMaps(rB.map, rB1.map).length === 0, `item 8 (run B): remove of ${ra.siteId} with its delta: the deltas go (${left} storey cells left), the cabin stands with the hand edits (hash equal ${hB1 === hB}), the PT records equal (${diffMaps(rB.map, rB1.map).length} mismatches)`, rmA);
  check(eA.found && eA.versionFolders >= 2 && bA.state === 'ACTIVE' && !bA.siteId, `item 8 (run B): the entry stays (${eA.versionFolders} version folders); ${A.id} ${bA.state}, siteId ${bA.siteId ?? null}`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 8, run A: adopt, undo

steps.undoA = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 UndoA', X, Z);
  const y = gy + 1;
  const cab = await buildCabin(X, y, Z);
  const box = [X - 2, gy - 2, Z - 2, X + 10, y + 8, Z + 10];
  const h0 = await boxHash(box);
  const c0 = await cellMap(box);
  const r = await adopt('a', cab.id);
  await writes(box);
  const rm = await remove(r.siteId);
  const w = await writes(box);
  const h1 = await boxHash(box);
  const c1 = await cellMap(box);
  const dm = diffMaps(c0.map, c1.map);
  const b = await buildOf(cab.id);
  const e = await entryOf(r.entryId);
  const trash = path.join(GAME_DIR, 'architect', 'library-trash');
  const trashed = fs.existsSync(trash) && fs.readdirSync(trash).some((f) => f.startsWith(`${r.entryId}-`));
  check(rm?.removed && h1 === h0 && w === 0, `item 8 (run A): adopt then undo (remove): the cabin's hash equals the pre-adoption hash; ${w} blocks written`, rm);
  check(dm.length === 0 && c1.tracked === c0.tracked, `item 8 (run A): the tracked set (${c1.tracked}), placers and build ids: ${dm.length} mismatches`, dm.slice(0, 8));
  check(b.state === 'ACTIVE' && !b.siteId && await api(`adoptedsite ${cab.id}`) === 'none', `item 8 (run A): ${cab.id} ${b.state}, siteId ${b.siteId ?? null}`);
  check(!e.found && trashed, `item 8 (run A): the entry ${r.entryId} trashed (library-trash ${trashed})`);
  const j = await journalOf(r.siteId);
  check((j.entries ?? []).every((x) => x.status !== 'ACTIVE'), `item 8 (run A): the adopt entry is no longer active (${json((j.entries ?? []).map((x) => x.status))})`);
  await leaveWorld();
  spendZero();
  return { removed: rm, journal: j };
};

// ------------------------------------------------------------------ item 6: survival

const sumOf = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
/** The conservation ledger of an area (gate6cy's): the player's inventory, containers, item entities, stockpile stock, paid cells standing. */
class Ledger {
  constructor(area) { this.area = area; this.injected = {}; this.cleared = {}; this.base = null; this.points = []; }
  add(m, into) { for (const [k, v] of Object.entries(m ?? {})) into[k] = (into[k] ?? 0) + v; }
  async parts() { return call('dev.stockpile.audit', { owner: OWNER, min: this.area.min, max: this.area.max }, 120_000); }
  total(a) {
    const t = {};
    for (const m of [a.inventory, a.containers, a.entities, a.stock, a.paidStanding, a.legacyCrateStock, this.cleared]) this.add(m, t);
    for (const [k, v] of Object.entries(this.injected)) t[k] = (t[k] ?? 0) - v;
    for (const k of Object.keys(t)) if (t[k] === 0) delete t[k];
    return t;
  }
  async start() { this.base = this.total(await this.parts()); }
  async point(label) {
    const a = await this.parts();
    const t = this.total(a);
    const diff = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(this.base)])) { const d = (t[k] ?? 0) - (this.base[k] ?? 0); if (d !== 0) diff[k] = d; }
    const p = { label, diff, identity: a.identity !== false, stock: sumOf(a.stock), paid: sumOf(a.paidStanding), injected: sumOf(this.injected) };
    this.points.push(p);
    return p;
  }
  async insert(items) {
    const r = await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items, exact: true }, 120_000);
    this.add(r.accepted ?? {}, this.injected);
    return r.accepted ?? {};
  }
}
const exact = (p) => Object.keys(p.diff).length === 0 && p.identity;
async function feedAll(ledger, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile;
    const need = {};
    for (const [k, v] of Object.entries(st.outstanding ?? {})) { const n = v - (st.stock?.[k] ?? 0); if (n > 0) need[k] = n; }
    if (!Object.keys(need).length) {
      if (!Object.keys(st.outstanding ?? {}).length) return;
      await sleep(1000);
      continue;
    }
    for (const [k, n] of Object.entries(need)) await ledger.insert({ [k]: n });
    await sleep(500);
  }
  throw new Error('feedAll: the outstanding bill did not reach 0');
}
async function waitBuilt(site, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await siteView(site);
    if (s?.state === 'BUILT') return true;
    await sleep(1000);
  }
  return false;
}

steps.survival = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 Survival', X, Z, { survival: true });
  const y = gy + 1;
  const out = {};
  const cab = await buildCabin(X, y, Z);
  const pre = await boxHash(cabinBox(X, y, Z));
  await cmd('/gamemode spectator');
  const crates = [[X - 6, y, Z - 8], [X - 4, y, Z - 8], [X - 2, y, Z - 8]];
  const sp = await call('dev.stockpile.create', { owner: OWNER, crates }, 120_000);
  check(!sp.refused && sp.stockpile?.crates?.length === 3, `item 6: a stockpile of ${OWNER} with 3 crates (${json(sp.refused ?? sp.stockpile?.crates?.length)})`);
  const ledger = new Ledger({ min: [X - 12, gy - 4, Z - 14], max: [X + 14, y + 16, Z + 14] });
  await ledger.start();
  const box = [X - 2, gy - 2, Z - 2, X + 10, y + 12, Z + 10];
  await writes(box);
  const r = await adopt('s', cab.id);
  const w = await writes(box);
  const p1 = await ledger.point('adopted');
  check(r?.siteId && w === 0 && exact(p1) && p1.stock === 0 && p1.paid === 0, `item 6: adopt costs 0 and writes 0 (${w} written; ledger ${json(p1.diff)}, stock ${p1.stock}, paid ${p1.paid})`, r);
  const fl = await addFloor('sf', r.entryId, r.siteId);
  check(fl.design?.status === 'DONE', `item 6: v2 "add a floor" (sim): ${fl.design?.status}`);
  const ap = await later(`applydelta ${r.siteId} 2 keep ${OWNER}`);
  const st0 = (await call('dev.stockpile.state', { owner: OWNER }, 60_000)).stockpile;
  check(ap.applied && sumOf(ap.refund) === 0 && sumOf(st0.outstanding) > 0, `item 6: the update is a construction delta fed by the stockpile (outstanding ${sumOf(st0.outstanding)} items; refund ${json(ap.refund)}: no refund for the adopted roof block the hatch removed)`, ap);
  await feedAll(ledger);
  const built = await waitBuilt(r.siteId);
  const p2 = await ledger.point('updated');
  check(built && exact(p2) && p2.paid > 0, `item 6: the floor built from the stockpile (paid ${p2.paid}); items in = out (${json(p2.diff)})`);
  const rv = await later(`srevert ${r.siteId} 1`);
  await feedAll(ledger);
  const built2 = await waitBuilt(r.siteId);
  const p3 = await ledger.point('reverted');
  check(rv.applied !== false && built2 && exact(p3), `item 6: revert to v1 in survival (a forward delta: the floor's paid blocks refunded into the stockpile, the hatch's log built from it): items in = out (${json(p3.diff)})`, rv);
  const rm = await remove(r.siteId);
  const p4 = await ledger.point('unadopted');
  const post = await boxHash(cabinBox(X, y, Z));
  check(rm?.removed && exact(p4) && sumOf(rm.refund) === 0, `item 6: un-adopt (remove): refund ${json(rm?.refund)}, items in = out (${json(p4.diff)}); the cabin stands (${post === pre ? 'hash equal to before the adoption' : 'hash differs'})`, rm);
  out.points = ledger.points;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 10: protection stays

steps.protect = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 Protect', X, Z);
  const y = gy + 1;
  const out = {};
  const cab = await buildCabin(X, y, Z);
  // a tree beside the east wall (natural: commands), its branch on the wall
  const TX = X + 10, TZ = Z + 4;
  await cmd(`/fill ${TX} ${y} ${TZ} ${TX} ${y + 6} ${TZ} minecraft:oak_log`);
  await cmd(`/fill ${X + 9} ${y + 4} ${TZ} ${TX - 1} ${y + 4} ${TZ} minecraft:oak_log[axis=x]`);
  const r = await adopt('p', cab.id);
  check(r?.siteId, `item 10: the cabin adopted as ${r?.siteId}`);
  const cb = cabinBox(X, y, Z);
  const h0 = await khash(cb);
  const hw0 = await boxHash(cb);
  for (const s of [{ kind: 'raise', at: [X + 4, gy, Z + 4], radius: 7, strength: 3 }, { kind: 'lower', at: [X + 4, gy, Z + 4], radius: 7, strength: 3 },
    { kind: 'smooth', at: [X + 4, gy, Z + 4], radius: 7, strength: 3 }, { kind: 'melt', at: [X + 4, gy, Z + 4], radius: 7, strength: 3 }]) {
    const v = await call('dev.brush', { owner: OWNER, shape: 'cylinder', ...s }, 600_000);
    out[s.kind] = v.cellsSkipped;
    check(!v.refused && await boxHash(cb) === hw0, `item 10: a ${s.kind} stroke over the adopted cabin keeps it (hash equal; skipped ${json(v.cellsSkipped ?? v.refused)})`);
    if (v.region) await call('dev.region.remove', { region: v.region, requester: OWNER }, 600_000).catch(() => null);
    await settle(1500);
  }
  const fell = await call('dev.brush', { owner: OWNER, kind: 'raise', shape: 'cylinder', at: [TX, gy, TZ], radius: 2, strength: 2 }, 600_000);
  check(!fell.refused && (fell.cellsSkipped?.['tree_kept.build'] ?? 0) >= 1 && await boxHash(cb) === hw0, `item 10: felling at its wall stops at its logs (tree_kept.build ${fell.cellsSkipped?.['tree_kept.build'] ?? 0}), the cabin unchanged`);
  if (fell.region) await call('dev.region.remove', { region: fell.region, requester: OWNER }, 600_000).catch(() => null);
  const road = await call('dev.road.place', { points: [[X - 10, gy, Z + 4], [X + 20, gy, Z + 4]], width: 3, owner: OWNER }, 300_000);
  const rref = (road.refusals ?? []).find((x) => x.reason === 'PLAYER_BUILD');
  check(!road.placed && rref?.message?.includes(cab.id), `item 10: a road across it is refused PLAYER_BUILD naming ${cab.id}`, road);
  const pc = await call('dev.region.checkPlan', { owner: OWNER, claim: [X - 40, Z - 40, X + 48, Z + 48], plan: { schemaVersion: 'plan/0',
    zones: [{ id: 'town', program: { lots: [{ id: 'h1', type: 'cottage', size: [9, 9] }] }, where: { near: { feature: { build: { id: cab.id } } }, within: 20 } }] } }, 900_000);
  const town = (pc.check?.parts ?? []).find((p) => p.part === 'town');
  const B = cb;
  const rect = town?.geometry?.rect;
  const off = rect && (rect[2] < B[0] - 1 || rect[0] > B[3] + 1 || rect[3] < B[2] - 1 || rect[1] > B[5] + 1);
  check(['fits', 'adjusted'].includes(town?.class) && off, `item 10: a region plan near it keeps it out (${town?.class} ${json(rect)})`, pc.check ?? pc);
  check((await khash(cb)).sha256 === h0.sha256, 'item 10: every kept cell of the adopted build unchanged');
  // growth over the player's lean-to: blocks on the roof edge where the new storey's wall goes join the build (outside the site's cells)
  await uses([0, 1, 2].map((i) => ({ item: 'minecraft:cobblestone', at: [X, y + 7, Z + 2 + i], placer: ALEX })));
  await settle(6000);
  const fl = await addFloor('pf', r.entryId, r.siteId);
  const n0 = await api(`pt2checkdelta ${r.siteId} 2 ${OWNER} -`);
  const n1 = await api(`pt2checkdelta ${r.siteId} 2 ${OWNER} ${b64({ builds: [cab.id], actor: await uuidOf(ALEX) })}`);
  out.leanTo = { n0, n1 };
  const pbr = (n0.refusals ?? []).find((x) => x.reason === 'PLAYER_BUILD');
  check(fl.design?.status === 'DONE' && pbr && pbr.message.includes(cab.id) && n1.applicable, `item 10: growth over the player's lean-to refuses PLAYER_BUILD (${pbr ? 'refused' : json(n0.refusals)}); with consent naming the build: ${n1.applicable ? 'allowed' : json(n1.refusals)}`);
  // a PLAYER_BLOCKS stroke with a consent naming the build clears it (an op's, the site's own owner); then its undo
  const pb = await call('dev.brush', { owner: OWNER, kind: 'lower', shape: 'cylinder', at: [X + 4, gy + 3, Z + 4], radius: 7, strength: 9, destruction: 'player_blocks', consent: [cab.id] }, 600_000);
  const left = await call('dev.pt.cells', { box: cb }, 120_000);
  out.playerBlocks = pb.cellsSkipped ?? pb;
  check(!pb.refused && (pb.cellsWritten ?? 0) > 0, `item 10: a PLAYER_BLOCKS stroke with a consent naming ${cab.id} clears it (${pb.cellsWritten} cells written; ${left.tracked} records left; skipped ${json(pb.cellsSkipped)})`, pb);
  if (pb.region) await call('dev.region.remove', { region: pb.region, requester: OWNER }, 600_000).catch(() => null);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 11: build states

steps.states = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 States', X, Z);
  const y = gy + 1;
  await rule('graceMs', 0);
  const out = {};
  // never demotes: an adopted cabin cut below 20 structural cells
  const A = await buildCabin(X, y, Z, { contents: false });
  const ra = await adopt('d', A.id);
  const cut = cabinOps(X, y, Z).map((o) => o.at).filter((p, i) => i >= 15 && !(p[0] === X + 4 && p[2] === Z));
  await breaks(cut);
  await settle(7000);
  await call('dev.pt.builds', { drain: true });
  await sleep(1000);
  const a1 = await buildOf(A.id);
  check(a1.state === 'ADOPTED' && a1.siteId === ra.siteId && a1.cells < 20, `item 11: the adopted ${A.id} cut to ${a1.cells} structural cells stays ${a1.state} (${a1.siteId})`);
  // a merge with an ACTIVE build keeps the adopted id (even when the other is older)
  const old = await buildCabin(X + 30, y, Z, { contents: false });
  const B = await buildCabin(X + 42, y, Z, { contents: false });
  const rb = await adopt('m', B.id);
  await uses([X + 39, X + 40, X + 41].map((x) => ({ item: 'minecraft:oak_planks', at: [x, y, Z + 4], placer: ALEX })));
  await settle(7000);
  const bb = await buildOf(B.id);
  const ob = await buildOf(old.id);
  check(bb.state === 'ADOPTED' && bb.siteId === rb.siteId && (ob === 'none' || ob.id === B.id), `item 11: a merge of the adopted ${B.id} with the older ACTIVE ${old.id} keeps ${bb.id} (${bb.state}, ${bb.cells} cells); ${old.id} resolves to ${ob?.id ?? ob}`);
  // two adopted builds 3 apart (cells within 2 of each other) do not merge
  const C = await buildCabin(X, y, Z + 30, { contents: false });
  const D = await buildCabin(X + 12, y, Z + 30, { contents: false });
  const rc = await adopt('c', C.id);
  const rd = await adopt('e', D.id);
  await uses([X + 9, X + 10].map((x) => ({ item: 'minecraft:oak_planks', at: [x, y, Z + 34], placer: ALEX })));
  await settle(7000);
  const cb = await buildOf(C.id);
  const db = await buildOf(D.id);
  check(cb.id === C.id && db.id === D.id && cb.state === 'ADOPTED' && db.state === 'ADOPTED' && cb.siteId === rc.siteId && db.siteId === rd.siteId, `item 11: two adopted builds bridged within 2 do not merge (${cb.id} ${cb.state} ${cb.siteId}; ${db.id} ${db.state} ${db.siteId})`);
  // a split keeps the id on the largest part: an adopted cabin with a 3-block annex joined by one plank, the plank broken
  const E = await buildCabin(X, y, Z + 60, { contents: false });
  const annex = [];
  for (let i = 0; i < 40; i++) annex.push({ item: 'minecraft:oak_planks', at: [X + 12 + (i % 5), y + Math.floor(i / 10), Z + 60 + Math.floor(i / 5) % 2], placer: ALEX });
  await uses([...annex, { item: 'minecraft:oak_planks', at: [X + 10, y, Z + 60], placer: ALEX }]);
  await settle(7000);
  const re = await adopt('s', (await buildsIn(cabinBox(X, y, Z + 60))).builds[0].id);
  await breaks([[X + 10, y, Z + 60]]);
  await settle(7000);
  const eb = await buildOf(re.buildId);
  const parts = (await buildsIn([X - 2, gy, Z + 58, X + 20, y + 8, Z + 70])).builds;
  check(eb.state === 'ADOPTED' && eb.siteId === re.siteId && eb.cells > 200, `item 11: a split keeps ${eb.id} (${eb.state}, ${eb.cells} cells) on the largest part; parts ${json(parts.map((p) => [p.id, p.state, p.cells]))}`);
  const rel = await api(`ptrelease ${ra.buildId}`);
  check(rel.refused === 'ADOPT_REFUSED' && /remove/.test(rel.message ?? ''), `item 11: releaseBuild of an adopted build refuses ADOPT_REFUSED (adopted): ${rel.message}`, rel);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 12: elsewhere

steps.elsewhere = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT2 Elsewhere', X, Z);
  const y = gy + 1;
  const cab = await buildCabin(X, y, Z);
  const r = await adopt('x', cab.id);
  const pl = await apiResult(await api(`ptplace ${r.entryId} ${X + 30} ${y} ${Z} k1`));
  const pr = (pl.refusals ?? []).find((x) => x.reason === 'ADOPT_REFUSED');
  check(!pl.placed && pr && pr.message.startsWith('placed_elsewhere'), `item 12: place of the adopted entry refuses ADOPT_REFUSED placed_elsewhere (${pr?.message?.slice(0, 100) ?? json(pl)})`, pl);
  const ck = await api(`ptcheck ${r.entryId} ${X + 30} ${y} ${Z}`);
  const cr = (ck.refusals ?? []).find((x) => x.reason === 'ADOPT_REFUSED');
  check(cr && cr.message.startsWith('placed_elsewhere'), `item 12: check of it refuses the same (${cr?.message?.slice(0, 80)})`, ck);
  const po = await apiResult(await api(`polish ${r.entryId} 1 none`));
  check(/adopted_polish/.test(JSON.stringify(po)), `item 12: polish refuses VERSION_REFUSED adopted_polish (${JSON.stringify(po).slice(0, 160)})`, po);
  const del = await later(`delete ${r.entryId}`);
  const en = await entryOf(r.entryId);
  check(del === false && en.found, `item 12: the entry's library delete while the site stands refuses (Library.delete -> ${json(del)}); the entry is there`);
  await leaveWorld();
  spendZero();
  return { place: pl, check: ck, polish: po, delete: del };
};

// ------------------------------------------------------------------ item 13 (recorded): a 0.27.0 reader

steps.old027 = async () => {
  // the journal of the adopt step's world (an adopt entry) and of the refusals step's world before any adoption is not kept; the
  // undoA world after its un-adoption is read too (released files gone). 0.27.0's own classes, built in its worktree, read them.
  const wt = process.env.PT2_V0270 ?? path.resolve(root, '..', 'architect-mc-PT2-v0270');
  const worlds = ['G6B PT2 Adopt', 'G6B PT2 UndoA', 'G6B PT2 Flow'].map((w) => path.join(SAVES, w, 'architect-journal')).filter((d) => fs.existsSync(d));
  check(fs.existsSync(path.join(wt, 'mod')) && worlds.length > 0, `item 13: the v0.27.0 worktree ${wt} and ${worlds.length} journals to read`);
  const test = path.join(wt, 'mod', 'src', 'test', 'java', 'dev', 'larattalabs', 'architect', 'journal', 'Pt2Old027ReadTest.java');
  fs.copyFileSync(path.join(root, 'tools', 'pt2', 'Pt2Old027ReadTest.java'), test);
  const report = path.join(OUT, 'old027.txt');
  const env = { ...process.env, JAVA_HOME, GRADLE_USER_HOME: path.join(wt, '.gradle-home'), PT2_JOURNALS: worlds.join(path.delimiter), PT2_REPORT: report };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*Pt2Old027ReadTest', '--rerun'], { cwd: path.join(wt, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  fs.rmSync(test, { force: true });
  const t = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : `${g.stdout}${g.stderr}`.slice(-3000);
  const n = (k) => Number((new RegExp(`^${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  check(g.status === 0 && n('adoptRefused') > 0 && n('otherRead') > 0 && n('otherRefused') === 0 && n('indexKeptAdopt') > 0, `item 13 (recorded): 0.27.0's reader refuses every adopt entry file (${n('adoptRefused')}), reads every other file (${n('otherRead')} read, ${n('otherRefused')} refused) and keeps the adopt rows of the index (${n('indexKeptAdopt')})`, t.split('\n').slice(0, 30));
  return { report: t };
};

// ------------------------------------------------------------------ report

steps.report = async () => {
  const lines = ['# Gate 6c PT2 (adopt a build as a site)', '', `Head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}, ${new Date().toISOString()}. $0 (sim only).`, ''];
  for (const s of ['unit', 'refusals', 'adopt', 'flow', 'undoA', 'survival', 'protect', 'states', 'elsewhere', 'old027']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = Object.entries(j.results ?? {});
    lines.push(`## ${s} (${j.seconds?.toFixed?.(0)} s, head ${String(j.head).slice(0, 7)})`, '');
    for (const [m, v] of r) lines.push(`- ${v.ok ? 'ok' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), lines.join('\n'));
  return { lines: lines.length };
};

steps.ingame = async () => {
  // GATE6CPT2_STEPS: a subset while iterating (comma-separated)
  const pick = process.env.GATE6CPT2_STEPS ? process.env.GATE6CPT2_STEPS.split(',') : ['adopt', 'refusals', 'flow', 'undoA', 'protect', 'states', 'elsewhere'];
  for (const s of pick) await run(s);
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cpt2.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
if (name === 'ingame') await steps.ingame();
else await run(name);
const n = fails();
console.log(n ? `${n} FAILURE(S)` : 'ok: all checks passed');
if (state.dev) state.dev.close?.();
process.exit(n ? 1 : 0);
