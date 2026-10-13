#!/usr/bin/env node
// Phase 6c slice PT gate (docs/CONTRACT.md "Phase 6c slice PT: player-placed tracking (C32)" §11). Headless steps place blocks through a
// fake ServerPlayer's useItemOn / useItem (dev.pt.uses: ServerPlayerGameMode, never setBlock, which would skip the recording hook) and
// break through destroyBlock. Pre-tracking blocks (a "pre-PT" cabin, trees, fixtures) are written with commands, which never record.
// Ports 8916 (sidecar) / 8917 (DevBridge) unless the runner gives others (PT's range 8912-8917). $0: no Claude call; spend.json $0.00.
//
//   node tools/gate6cpt.mjs <step>
//     unit       items 14 (kit half) and 16 offline: kit/test/builds-pt.test.mjs, the Java PT tests, api-compat --gate6cpt
//     ingame     every in-game item below in turn (each also runs alone):
//       record     1  200 placements of blocks, a door, a bed, buckets, seeds, a hoe, a shovel, an axe: exactly the expected cells;
//                     20 bone meal uses and region strokes writing 50k+ cells record 0
//       clear      2  50 breaks, 4 TNT at a wall, water over 10 torches: the records equal the remaining blocks; grass spreading on placed
//                     dirt and copper weathering keep theirs
//       pistons    3  12 tracked blocks pushed and pulled: destinations recorded, sources cleared; a save mid-move keeps them
//       reload     4  the set's hash and the index equal after /save and a restart, and after chunk unload and reload
//       builds     5  an all-log cabin with a door: HOUSE; a cobble wall and a dirt wall 16x3x1: WALL (provisional, N-PT-2); a 9x9 farm:
//                     FARM; 20 torches, a filled 5x5x2 hole, a levelled 7x7 dirt patch: 0 builds; the grace's own check
//       hyst       6  (graceMs 0) a 40-cell build cut to 21 stays; cut to 19 incidental after the debounce and the 60 s gap; regrown to
//                     30 stays incidental; the id survives +50 blocks, a merge (oldest wins) and a reload
//       village    7  S7's flat_village (the village; S3's route_demo plans nothing on a claim holding builds: see the step) on a flat
//                     copy with the cabin and a cobble wall 2 cells beside its lots: the plan keeps them out, the realise loses 0 of
//                     their blocks (hash equal), the findings recorded, the removal exact
//       brush      8  raise, lower, smooth and melt strokes at and over the cabin, NATURAL_ONLY and PLAYER_BLOCKS without consent: 0 lost
//       felling    9  the cabin's wall touching a tree: the flood stops at its logs (tree_kept.build), the cabin unchanged, the rest felled
//       undo      10  with consent a stroke clears 40+ of a build's cells and 20 incidental ones; one undo: blocks E-flat 0, and the
//                     tracked set, placers and build ids 0 mismatches
//       refusals  11  a building placed over the cabin: PLAYER_BUILD naming the build id, kind, count and the first 8 positions with
//                     block ids, all equal to the world; a partial road names its skipped span's build; a road joins a PATH build with
//                     0 path cells changed (Steward's addition)
//       incidental 12 a realise over 20 torches and a dirt patch writes them with no refusal; its undo restores them and their records
//       claim     13  a pre-PT log cabin claimed: a build, kept by a stroke; released: cleared by the next stroke; a torch on natural
//                     ground beside a lowered column stays (player_build.support)
//       plan      14  in game: the live builds through the kit's helpers: near {build kind house}, adjacent {to {build}}, endpoint
//                     {build, port door}: the road ends on the apron; around: locator.around reserved
//       cost      15  (recorded) bytes per tracked block and per section on disk and in heap; the hook's added ns; the classifier's
//                     own CPU per tick max (budget 1 ms)
//       apitest   16  through the public API: /apitest apipt, ptbuilds, ptat, ptbox, ptplace
//     nomod      12 (second half) the chunk NBT keeps architect_mc:placed after a start without the mod: a server of the same game
//                     and Fabric API without Architect loads the chunk, saves and stops; the region file read back
//     report     REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-pt/<step>.json in the main checkout (GATE6CPT_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= here;
process.env.GATE6B_OUT = process.env.GATE6CPT_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-pt');
process.env.GATE6B_SIDECAR_PORT ??= '8916';
process.env.GATE6B_DEV_PORT ??= '8917';
const L = await import('./lib/run6b.mjs');
const { OUT, SAVES, SIDECAR_DATA, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, state, tp, write, copyWorld } = L;

refuseKeys();
fs.mkdirSync(OUT, { recursive: true });
const FLAT_BASE = 'G6B Flat Base';
const OWNER = 'gate:pt';
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const KIT = path.join(root, 'kit');
const imp = (rel) => import(pathToFileURL(path.join(KIT, rel)).href);

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice PT is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.kit = nodeTest(['kit/test/builds-pt.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 5, `item 14 (kit): plan/0's feature.build, target {build}, endpoint.build validate and their catalogue entries are supported; the pick, the door apron and the keep-outs (${out.kit.pass} pass, ${out.kit.fail} fail)`, out.kit.failing);
  const env = { ...process.env, JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const tests = ['*PlacedChunkTest', '*JournalPtTest', '*RecordRulesTest', '*PredicatePathsTest', '*ApiPTTest'];
  const g = spawnSync('./gradlew', ['test', '--offline', ...tests.flatMap((t) => ['--tests', t])], { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 3_600_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  out.java = { code: g.status, chunk: xml('placed.PlacedChunkTest'), journal: xml('journal.JournalPtTest'), rules: xml('placed.RecordRulesTest'), paths: xml('placed.PredicatePathsTest'), api: xml('api.ApiPTTest') };
  const jok = (v) => v && v.tests > 0 && v.failures === 0;
  check(g.status === 0 && jok(out.java.chunk) && jok(out.java.journal) && jok(out.java.rules) && jok(out.java.paths) && jok(out.java.api),
    `Java: PlacedChunkTest ${json(out.java.chunk)}, JournalPtTest ${json(out.java.journal)} (pt, v3 only with pt, hand-downs), RecordRulesTest ${json(out.java.rules)}, PredicatePathsTest ${json(out.java.paths)} (one predicate; Placed.set), ApiPTTest ${json(out.java.api)}`);
  const classes = [['main', 'client'].map((d) => path.join(root, 'mod', 'build', 'classes', 'java', d)).join(path.delimiter)];
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cpt', ...classes], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 16: api-compat against the 0.25.0, 0.24.0 and 0.23.0 apitest jars and the 0.25.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  check(JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8')).totalUsd === 0, 'item 16: spend $0.00');
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
const uses = async (ops) => (await call('dev.pt.uses', { ops }, 900_000)).results;
const breaks = async (at, placer = 'PTBreaker') => call('dev.pt.breaks', { at, placer }, 600_000);
const cellsOf = async (box, list = false) => call('dev.pt.cells', { box, list }, 900_000);
const buildsIn = async (box, drain = true) => call('dev.pt.builds', { box, drain }, 600_000);
const ptAt = (at) => call('dev.pt.at', { at });
const uuidOf = async (name) => (await call('dev.pt.uuid', { name })).uuid;
const rule = (name, value) => call('dev.pt.rule', { name, value: String(value) });
const boxHash = async (min, max) => call('dev.box.hash', { min, max }, 120_000);
const bhash = async (b) => boxHash(b.slice(0, 3), b.slice(3));
/** The kept build cells of a box (position, state, record): a lost or changed build cell changes it; the box's air does not count. */
const khash = async (b) => call('dev.pt.keptHash', { box: b }, 120_000);

/** One stroke through dev.brush; returns the region's view (or {refused, reason}). */
async function brush(o) {
  const r = await call('dev.brush', { owner: OWNER, ...o }, 600_000);
  log(`  brush ${o.kind} r${o.radius} s${o.strength} ${o.shape ?? 'sphere'} at ${o.at} ${o.destruction ?? ''} ${o.consent ? `consent ${o.consent}` : ''}: ${r.refused ? `refused ${r.refused}` : `${r.region} ${r.state} ${r.cellsWritten} cells, skipped ${json(r.cellsSkipped)}`}`);
  return r;
}
async function undo(region, requester = OWNER) {
  const r = await call('dev.region.remove', { region, requester }, 3_600_000);
  for (let i = 0; i < 600; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return r;
    if (s === 'PARTIAL' || s === 'FAILED') throw new Error(`undo of ${region} ended ${s}: ${json(r)}`);
    await sleep(250);
  }
  throw new Error(`undo of ${region} did not finish`);
}
/** The ground y at (x, z) from the region plan survey of a small claim around it. */
async function groundAt(x, z) {
  const f = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: f }, 300_000);
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(f));
  return c.ground[1 + 3 * 1];
}
async function snapBox(box, name) {
  const file = path.join(OUT, `${name}.snap.gz`);
  const r = await call('dev.region.hash', { box, mode: 'snap', file }, 4 * 3_600_000);
  return { file, cells: r.cells };
}
async function diffBox(box, snap) {
  const r = await call('dev.region.hash', { box, mode: 'diff', file: snap.file }, 4 * 3_600_000);
  return { mismatches: r.mismatches, classes: r.classes ?? {}, sample: (r.list ?? []).slice(0, 12) };
}
/** A fresh copy of the flat base world, the exact rules, the player over (x, z); returns the ground y there. */
async function flatWorld(name, x, z) {
  await ensure();
  await leaveWorld();
  copyWorld(FLAT_BASE, name);
  await openWorld(name);
  await L.setRules('exact');
  await cmd('/op @s');
  await rule('graceMs', 600000); // the world rules start at their defaults in a fresh world; set again to be sure
  await tp(x + 0.5, 0, z + 0.5);
  const gy = await groundAt(x, z);
  await tp(x + 0.5, gy + 25, z + 0.5);
  return gy;
}
/** The tracked cells of a box as "x,y,z" -> {placer, build, kept}. */
async function cellMap(box) {
  const c = await cellsOf(box, true);
  const m = new Map();
  for (const [x, y, z, placer, build, kept] of c.cells ?? []) m.set(`${x},${y},${z}`, { placer, build, kept });
  return { map: m, sha256: c.sha256, tracked: c.tracked, incidental: c.incidental };
}
const diffMaps = (a, b) => {
  const out = [];
  for (const [k, v] of a) { const w = b.get(k); if (!w || w.placer !== v.placer || w.build !== v.build) out.push(`${k}: ${json(v)} -> ${json(w ?? null)}`); }
  for (const [k, w] of b) if (!a.has(k)) out.push(`${k}: none -> ${json(w)}`);
  return out;
};

/** A log cabin 9 x 7 x 9 at (X, Y, Z) (Y: the floor row), its door in the north wall's middle (X+4, Z), the roof at Y+6. */
function cabinOps(X, Y, Z, { item = 'minecraft:oak_log', placer = 'PTAlex', door = true } = {}) {
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

// ------------------------------------------------------------------ item 1: recording

steps.record = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Record', X, Z);
  const y = gy + 1;
  const out = { gy };
  const ops = [];
  const expect = new Set();
  const add = (x, yy, z) => expect.add(`${x},${yy},${z}`);
  // 155 blocks in rows, two placers
  const blocks = ['minecraft:stone', 'minecraft:oak_planks', 'minecraft:cobblestone', 'minecraft:glass', 'minecraft:dirt', 'minecraft:oak_log'];
  for (let i = 0; i < 155; i++) {
    const x = X + (i % 25), z = Z + Math.floor(i / 25) * 2;
    ops.push({ item: blocks[i % blocks.length], at: [x, y, z], placer: i % 2 ? 'PTAlex' : 'PTSam' });
    add(x, y, z);
  }
  // a door (both halves) and a bed (both parts, facing south)
  ops.push({ item: 'minecraft:oak_door', at: [X, y, Z + 14], placer: 'PTAlex', yaw: 0 }); add(X, y, Z + 14); add(X, y + 1, Z + 14);
  ops.push({ item: 'minecraft:red_bed', at: [X + 3, y, Z + 14], placer: 'PTAlex', yaw: 0 }); add(X + 3, y, Z + 14); add(X + 3, y, Z + 15);
  // buckets: water and lava sources (useItem from above), powder snow (a block item)
  // (the fluids flow: far from the rest and from each other)
  ops.push({ item: 'minecraft:water_bucket', at: [X + 45, y, Z + 45], use: 'item', placer: 'PTAlex' }); add(X + 45, y, Z + 45);
  ops.push({ item: 'minecraft:lava_bucket', at: [X + 60, y, Z + 60], use: 'item', placer: 'PTAlex' }); add(X + 60, y, Z + 60);
  ops.push({ item: 'minecraft:powder_snow_bucket', at: [X + 9, y, Z + 14], placer: 'PTAlex' }); add(X + 9, y, Z + 14);
  // a hoe on 10 grass cells, seeds on them; a shovel on 10 grass cells; an axe on 10 natural logs (placed by command: not tracked)
  for (let i = 0; i < 10; i++) {
    ops.push({ item: 'minecraft:iron_hoe', at: [X + i, gy, Z + 17], placer: 'PTSam' }); add(X + i, gy, Z + 17);
  }
  for (let i = 0; i < 10; i++) {
    ops.push({ item: 'minecraft:wheat_seeds', at: [X + i, gy, Z + 17], placer: 'PTSam' }); add(X + i, gy + 1, Z + 17);
  }
  for (let i = 0; i < 10; i++) {
    ops.push({ item: 'minecraft:iron_shovel', at: [X + i, gy, Z + 20], placer: 'PTSam' }); add(X + i, gy, Z + 20);
  }
  await cmd(`/fill ${X} ${y} ${Z + 23} ${X + 9} ${y} ${Z + 23} minecraft:oak_log`);
  for (let i = 0; i < 10; i++) {
    ops.push({ item: 'minecraft:iron_axe', at: [X + i, y, Z + 23], placer: 'PTSam' }); add(X + i, y, Z + 23);
  }
  const res = await uses(ops);
  const box = [X - 4, gy - 3, Z - 4, X + 70, gy + 8, Z + 70];
  const cm = await cellMap(box);
  const got = new Set(cm.map.keys());
  const missing = [...expect].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !expect.has(k));
  out.placements = ops.length;
  out.expected = expect.size;
  out.tracked = cm.tracked;
  check(ops.length === 200 && missing.length === 0 && extra.length === 0, `item 1: ${ops.length} placements (blocks, a door, a bed, water, lava and powder snow, seeds, a hoe, a shovel, an axe): exactly the expected ${expect.size} cells tracked (missing ${missing.length}, extra ${extra.length})`, { missing: missing.slice(0, 12), extra: extra.slice(0, 12), fails: res.filter((r) => r.result !== 'Success').slice(0, 6) });
  const alex = await uuidOf('PTAlex');
  const sam = await uuidOf('PTSam');
  const wrong = [...cm.map.entries()].filter(([k, v]) => v.placer !== alex && v.placer !== sam);
  check(wrong.length === 0, `item 1: every record holds its placer's UUID (PTAlex ${alex.slice(0, 8)}, PTSam ${sam.slice(0, 8)})`, wrong.slice(0, 5));
  // 20 bone meal uses on grass: the growth records nothing
  const before = cm.tracked;
  const bm = [];
  for (let i = 0; i < 20; i++) bm.push({ item: 'minecraft:bone_meal', at: [X + i, gy, Z + 30], placer: 'PTAlex' });
  await uses(bm);
  const afterBm = await cellsOf(box);
  const grown = await call('dev.box.hash', { min: [X - 2, gy + 1, Z + 26], max: [X + 22, gy + 2, Z + 34], cells: false });
  check(afterBm.tracked === before, `item 1: 20 bone meal uses record 0 (tracked ${before} -> ${afterBm.tracked}; the plants grown there: ${json(grown).slice(0, 120)})`);
  // region strokes writing 50k+ cells (Architect's writes) record 0
  const far = [X + 120, Z];
  await tp(far[0] + 0.5, gy + 40, far[1] + 0.5);
  const wide = [far[0] - 80, gy - 30, far[1] - 80, far[0] + 80, gy + 40, far[1] + 80];
  const t0 = await cellsOf(wide);
  let written = 0;
  const regions = [];
  for (const [dx, dz] of [[-40, -40], [40, -40], [-40, 40], [40, 40]]) {
    const v = await brush({ kind: 'raise', shape: 'cylinder', at: [far[0] + dx, gy, far[1] + dz], radius: 32, strength: 12 });
    written += v.cellsWritten ?? 0;
    if (v.region) regions.push(v.region);
  }
  const t1 = await cellsOf(wide);
  check(written >= 50_000 && t1.tracked === t0.tracked, `item 1: region strokes writing ${written} cells (>= 50k) record 0 (tracked ${t0.tracked} -> ${t1.tracked})`);
  for (const r of regions.reverse()) await undo(r);
  out.written = written;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 2: clearing

steps.clear = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Clear', X, Z);
  const y = gy + 1;
  const out = {};
  // 100 blocks, 50 of them broken
  const ops = [];
  for (let i = 0; i < 100; i++) ops.push({ item: i % 2 ? 'minecraft:stone_bricks' : 'minecraft:oak_planks', at: [X + (i % 20), y, Z + Math.floor(i / 20)] });
  await uses(ops);
  const brk = ops.filter((_, i) => i % 2 === 0).map((o) => o.at);
  const b = await breaks(brk);
  // a cobble wall 12 x 4 and 4 TNT beside it
  const W = [X, y, Z + 10, X + 11, y + 3, Z + 10];
  const wops = [];
  for (let x = W[0]; x <= W[3]; x++) for (let yy = W[1]; yy <= W[4]; yy++) wops.push({ item: 'minecraft:cobblestone', at: [x, yy, W[2]] });
  await uses(wops);
  for (const dx of [2, 5, 8, 10]) await cmd(`/summon minecraft:tnt ${X + dx} ${y + 1} ${Z + 11} {fuse:1}`);
  await settle(4000);
  // 10 torches on the ground, then water over them
  const tops = [];
  for (let i = 0; i < 10; i++) tops.push({ item: 'minecraft:torch', at: [X + i, y, Z + 15] });
  await uses(tops);
  await cmd(`/fill ${X} ${y} ${Z + 14} ${X + 9} ${y} ${Z + 14} minecraft:glass`);
  await cmd(`/fill ${X} ${y} ${Z + 16} ${X + 9} ${y} ${Z + 16} minecraft:glass`);
  await cmd(`/setblock ${X - 1} ${y} ${Z + 15} minecraft:glass`);
  await cmd(`/setblock ${X + 10} ${y} ${Z + 15} minecraft:glass`);
  await cmd(`/gamerule random_tick_speed 3`);
  await cmd(`/setblock ${X} ${y} ${Z + 15} minecraft:water`);
  await cmd(`/setblock ${X + 9} ${y} ${Z + 15} minecraft:water`);
  await settle(8000);
  // the records equal the remaining blocks: every tracked cell holds a block we placed, every placed cell still holding its block is tracked
  const box = [X - 2, gy - 1, Z - 2, X + 22, gy + 8, Z + 18];
  const cm = await cellMap(box);
  const placed = [...ops, ...wops, ...tops].map((o) => o.at);
  let holding = 0, holdingTracked = 0, trackedEmpty = 0;
  const bad = [];
  for (const at of placed) {
    const r = await ptAt(at);
    const isAir = r.state === 'minecraft:air' || r.state === 'minecraft:water' || r.state === 'minecraft:cave_air';
    if (!isAir) { holding++; if (r.tracked) holdingTracked++; else bad.push(`${at} ${r.state} untracked`); } else if (r.tracked) { trackedEmpty++; bad.push(`${at} ${r.state} tracked`); }
  }
  check(b.broken === 50 && holding === holdingTracked && trackedEmpty === 0 && cm.tracked === holding, `item 2: 50 breaks, 4 TNT at the wall, water over 10 torches: the records equal the remaining blocks (${holding} blocks left, ${holdingTracked} tracked; ${cm.tracked} records in the box; 0 records on air or water: ${trackedEmpty})`, bad.slice(0, 12));
  // grass spreading on placed dirt and copper weathering keep their records (random ticks sped up a while)
  const dops = [];
  for (let i = 0; i < 6; i++) dops.push({ item: 'minecraft:dirt', at: [X + 30 + i, gy, Z], on: [X + 30 + i, gy, Z] });
  await cmd(`/fill ${X + 30} ${gy} ${Z} ${X + 35} ${gy} ${Z} minecraft:air`);
  await uses(dops);
  const cops = [];
  for (let i = 0; i < 6; i++) cops.push({ item: 'minecraft:copper_block', at: [X + 30 + i, y, Z + 4] });
  await uses(cops);
  await cmd('/gamerule random_tick_speed 4096');
  let grass = 0, oxidized = 0;
  for (let t = 0; t < 30 && (grass < 6 || oxidized < 1); t++) {
    await settle(2000);
    grass = 0; oxidized = 0;
    for (const o of dops) if ((await ptAt(o.at)).state === 'minecraft:grass_block') grass++;
    for (const o of cops) if ((await ptAt(o.at)).state !== 'minecraft:copper_block') oxidized++;
  }
  await cmd('/gamerule random_tick_speed 0');
  const keptGrass = (await Promise.all(dops.map((o) => ptAt(o.at)))).filter((r) => r.tracked && r.state === 'minecraft:grass_block').length;
  const keptCopper = (await Promise.all(cops.map((o) => ptAt(o.at)))).filter((r) => r.tracked && r.state !== 'minecraft:copper_block').length;
  check(grass > 0 && keptGrass === grass, `item 2: grass spread onto ${grass} placed dirt cells; all ${keptGrass} keep their records`);
  check(oxidized > 0 && keptCopper === oxidized, `item 2: ${oxidized} placed copper blocks weathered; all ${keptCopper} keep their records`);
  out.grass = grass; out.oxidized = oxidized;
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 3: pistons

steps.pistons = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Pistons', X, Z);
  const y = gy + 1;
  const out = {};
  // a sticky piston at (X, y, Z) facing east, 12 tracked blocks east of it, a redstone block to fire it
  await cmd(`/setblock ${X} ${y} ${Z} minecraft:sticky_piston[facing=east]`);
  const row = [];
  for (let i = 1; i <= 12; i++) row.push({ item: 'minecraft:stone_bricks', at: [X + i, y, Z] });
  await uses(row);
  const rowBox = [X, y, Z, X + 14, y, Z];
  const r0 = await cellMap(rowBox);
  check(r0.tracked === 12, `item 3: 12 tracked blocks in front of the piston (${r0.tracked})`);
  await cmd(`/setblock ${X - 1} ${y} ${Z} minecraft:redstone_block`);
  await settle(1500);
  const pushed = await cellMap(rowBox);
  const want = new Set(Array.from({ length: 12 }, (_, i) => `${X + i + 2},${y},${Z}`));
  const okPush = pushed.tracked === 12 && [...want].every((k) => pushed.map.has(k)) && !pushed.map.has(`${X + 1},${y},${Z}`);
  check(okPush, `item 3: pushed: the 12 destinations recorded (x ${X + 2}..${X + 13}), the sources cleared (the head's cell ${X + 1} untracked)`, [...pushed.map.keys()]);
  await cmd(`/setblock ${X - 1} ${y} ${Z} minecraft:air`);
  await settle(1500);
  const pulled = await cellMap(rowBox);
  check(pulled.tracked === 12 && pulled.map.has(`${X + 1},${y},${Z}`) && !pulled.map.has(`${X + 2},${y},${Z}`), `item 3: pulled back: the first block's record moved to x ${X + 1}, x ${X + 2} cleared (${pulled.tracked} records)`, [...pulled.map.keys()]);
  const placers = new Set([...pulled.map.values()].map((v) => v.placer));
  check(placers.size === 1 && [...placers][0] === await uuidOf('PTPlacer'), 'item 3: the moved records keep their placer');
  // a save mid-move: tick frozen, the piston fired, one tick, saved; the world reopened, the move settles
  await cmd('/tick freeze');
  await cmd(`/setblock ${X - 1} ${y} ${Z} minecraft:redstone_block`);
  await cmd('/tick step 1');
  await sleep(1000); // wall time (dev.wait counts server ticks, and they are frozen)
  // (the pull moved only the touching block back to X+1, so this push moves that one block: X+1 -> X+2)
  const mid = await ptAt([X + 2, y, Z]);
  const midRow = [];
  for (let x = X + 1; x <= X + 13; x++) midRow.push((await ptAt([x, y, Z])).state.replace('minecraft:', ''));
  out.mid = { mid, row: midRow };
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G6B PT Pistons');
  await cmd('/tick unfreeze');
  await settle(2000);
  const after = await cellMap(rowBox);
  check(mid.state === 'minecraft:moving_piston' && !mid.tracked && after.tracked === 12 && [...want].every((k) => after.map.has(k)), `item 3: a save mid-move (cell ${X + 2} ${mid.state}, its record on the moving block entity) keeps them: after the reload the 12 destinations are recorded (${after.tracked})`, { mid: midRow, after: [...after.map.keys()] });
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 4: save and reload

steps.reload = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Reload', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  const extra = [];
  for (let i = 0; i < 30; i++) extra.push({ item: 'minecraft:torch', at: [X + 12 + (i % 10) * 3, y, Z + Math.floor(i / 10) * 3], placer: 'PTSam' });
  await uses(extra);
  await settle(6000);
  const box = [X - 4, gy - 2, Z - 4, X + 44, gy + 10, Z + 14];
  const b0 = await buildsIn(box);
  const c0 = await cellsOf(box);
  const idx = (b) => json(b.builds.map((x) => [x.id, x.kind, x.state, x.cells, x.revision, x.bounds, x.placers]));
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G6B PT Reload');
  await tp(X + 0.5, gy + 25, Z + 0.5);
  const c1 = await cellsOf(box);
  const b1 = await buildsIn(box);
  check(c1.sha256 === c0.sha256 && c1.tracked === c0.tracked && idx(b1) === idx(b0), `item 4: after /save and a restart the set's hash (${c1.tracked} cells) and the index (${b1.builds.length} builds) are equal`, { before: idx(b0), after: idx(b1) });
  // chunk unload and reload: the player goes 600 blocks away (beyond the view distance) and back
  await tp(X + 600.5, gy + 25, Z + 600.5);
  await settle(15000);
  // the box's chunks are unloaded now (dev.pt.cells reads loaded chunks only): 0 tracked proves the unload happened
  const away = await cellsOf(box);
  check(away.tracked === 0, `item 4: 600 blocks away the box's chunks are unloaded (${away.tracked} tracked cells readable)`);
  await tp(X + 0.5, gy + 25, Z + 0.5);
  await settle(3000);
  const c2 = await cellsOf(box);
  const b2 = await buildsIn(box);
  check(c2.sha256 === c0.sha256 && idx(b2) === idx(b0), `item 4: after the chunks unload and load again the set's hash and the index are equal`, { after: idx(b2) });
  await leaveWorld();
  spendZero();
  return { builds: b0.builds, tracked: c0.tracked };
};

// ------------------------------------------------------------------ item 5: builds

steps.builds = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Builds', X, Z);
  const y = gy + 1;
  const out = {};
  await rule('graceMs', 600000);
  // the cabin
  await uses(cabinOps(X, y, Z));
  // a cobble wall and a dirt wall, 16 x 3 x 1, 6 apart
  const wall = (x0, z0, item) => { const o = []; for (let x = x0; x < x0 + 16; x++) for (let yy = y; yy < y + 3; yy++) o.push({ item, at: [x, yy, z0] }); return o; };
  await uses(wall(X + 20, Z, 'minecraft:cobblestone'));
  await uses(wall(X + 20, Z + 6, 'minecraft:dirt'));
  // a 9 x 9 farm: tilled, then sown
  const farm = [];
  for (let i = 0; i < 81; i++) farm.push({ item: 'minecraft:iron_hoe', at: [X + (i % 9), gy, Z + 20 + Math.floor(i / 9)] });
  for (let i = 0; i < 81; i++) farm.push({ item: 'minecraft:wheat_seeds', at: [X + (i % 9), gy, Z + 20 + Math.floor(i / 9)] });
  await uses(farm);
  // 20 torches 3 apart; a 5 x 5 x 2 hole dug and filled; a 7 x 7 patch levelled with dirt
  const torches = [];
  for (let i = 0; i < 20; i++) torches.push({ item: 'minecraft:torch', at: [X + 20 + (i % 5) * 3, y, Z + 20 + Math.floor(i / 5) * 3] });
  await uses(torches);
  const H = [X + 40, Z];
  await cmd(`/fill ${H[0]} ${gy - 1} ${H[1]} ${H[0] + 4} ${gy} ${H[1] + 4} minecraft:air`);
  const hole = [];
  for (let yy = gy - 1; yy <= gy; yy++) for (let i = 0; i < 25; i++) hole.push({ item: 'minecraft:dirt', at: [H[0] + (i % 5), yy, H[1] + Math.floor(i / 5)] });
  await uses(hole);
  const P = [X + 40, Z + 12];
  await cmd(`/fill ${P[0]} ${gy} ${P[1]} ${P[0] + 6} ${gy} ${P[1] + 6} minecraft:air`);
  const patch = [];
  for (let i = 0; i < 49; i++) patch.push({ item: 'minecraft:dirt', at: [P[0] + (i % 7), gy, P[1] + Math.floor(i / 7)] });
  await uses(patch);
  await settle(6000);
  const all = await buildsIn([X - 4, gy - 4, Z - 4, X + 60, gy + 10, Z + 40]);
  const at = (b) => all.builds.filter((x) => x.bounds[0] <= b[3] && x.bounds[3] >= b[0] && x.bounds[2] <= b[5] && x.bounds[5] >= b[2] && x.bounds[1] <= b[4] && x.bounds[4] >= b[1]);
  const cabin = at(cabinBox(X, y, Z));
  check(cabin.length === 1 && cabin[0].kind === 'HOUSE' && cabin[0].state === 'ACTIVE' && cabin[0].entrances.length === 1, `item 5: the all-log 9x7x9 cabin with a door: ${cabin.map((b) => `${b.id} ${b.kind} ${b.state} ${b.cells} cells, ${b.entrances.length} entrance`).join('; ')}`);
  const cw = at([X + 20, y, Z, X + 35, y + 2, Z]);
  const dw = at([X + 20, y, Z + 6, X + 35, y + 2, Z + 6]);
  check(cw.length === 1 && cw[0].kind === 'WALL' && dw.length === 1 && dw[0].kind === 'WALL', `item 5: the cobble wall and the dirt wall 16x3x1: ${cw.map((b) => `${b.kind} (${b.state}, N-PT-2)`)} / ${dw.map((b) => `${b.kind} (${b.state}, N-PT-2)`)}`);
  const fm = at([X, gy, Z + 20, X + 8, y, Z + 28]);
  check(fm.length === 1 && fm[0].kind === 'FARM', `item 5: the 9x9 farm: ${fm.map((b) => `${b.id} ${b.kind} ${b.state} ${b.cells} cells`)}`);
  const none = [...at([X + 20, y, Z + 20, X + 32, y, Z + 29]), ...at([H[0], gy - 1, H[1], H[0] + 4, gy, H[1] + 4]), ...at([P[0], gy, P[1], P[0] + 6, gy, P[1] + 6])];
  check(none.length === 0, `item 5: 20 torches, a filled 5x5x2 hole and a levelled 7x7 dirt patch: ${none.length} builds`, none.map((b) => b.id));
  const inc = await cellsOf([H[0], gy - 1, H[1], H[0] + 4, gy, H[1] + 4]);
  check(inc.tracked === 50 && inc.incidental === 50, `item 5: the filled hole's 50 dirt cells are tracked and incidental (fill: natural, at or below the ground)`);
  out.builds = all.builds.map((b) => `${b.id} ${b.kind} ${b.state} ${b.cells}`);
  // the grace itself (N-PT-2): 24+ fresh cells are a provisional build; with the grace shortened they are gone
  const G = [X + 45, Z + 25];
  const g = [];
  for (let i = 0; i < 30; i++) g.push({ item: 'minecraft:oak_log', at: [G[0] + (i % 10), y + Math.floor(i / 10), G[1]] });
  await uses(g);
  await settle(6000);
  const gb = at([G[0], y, G[1], G[0] + 9, y + 2, G[1]]).length ? at([G[0], y, G[1], G[0] + 9, y + 2, G[1]]) : (await buildsIn([G[0], y, G[1], G[0] + 9, y + 2, G[1]])).builds;
  check(gb.length === 1 && gb[0].state === 'PROVISIONAL', `N-PT-2: a component of 30 natural cells (below the 40 bar, no qualifier) just placed is a provisional build (${gb.map((b) => `${b.id} ${b.state}`)})`);
  await rule('graceMs', 2000);
  await settle(5000);
  const gl = await buildsIn([G[0], y, G[1], G[0] + 9, y + 2, G[1]]);
  await settle(3000);
  const gl2 = await buildsIn([G[0], y, G[1], G[0] + 9, y + 2, G[1]]);
  check(gl2.builds.length === 0, `N-PT-2: when the grace ends (graceMs 2 s here) the provisional build is gone (${gl.builds.length} -> ${gl2.builds.length})`);
  await rule('graceMs', 600000);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 6: hysteresis and ids

steps.hyst = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Hyst', X, Z);
  const y = gy + 1;
  const out = {};
  await rule('graceMs', 0); // item 6 tests the promote and demote bars as written (the grace is item 5's)
  // a 40-cell build: an L of oak logs (natural: the 40 bar) 4 high, and a door at its ground
  // the door first (at the L's start, so it stays joined as the far end is cut), then the logs: 8 x 4 along x, 2 x 4 along z, 38 kept
  const logs = [];
  for (let x = X; x < X + 8; x++) for (let yy = y; yy < y + 4; yy++) logs.push([x, yy, Z]);
  for (let z = Z + 1; z < Z + 3; z++) for (let yy = y; yy < y + 4; yy++) logs.push([X + 7, yy, z]);
  logs.splice(38);
  await uses([{ item: 'minecraft:oak_door', at: [X - 1, y, Z], yaw: 0 }]);
  await uses(logs.map((at) => ({ item: 'minecraft:oak_log', at })));
  await settle(6000);
  const box = [X - 4, y - 2, Z - 3, X + 12, y + 6, Z + 6];
  const b0 = (await buildsIn(box)).builds;
  check(b0.length === 1 && b0[0].cells === 40 && b0[0].state === 'ACTIVE', `item 6: a 40-cell build (38 logs, a door): ${b0.map((b) => `${b.id} ${b.state} ${b.cells}`)}`);
  const id = b0[0]?.id;
  // cut to 21 (19 logs and the door's 2 cells): stays
  await breaks(logs.slice(19, 38));
  await settle(6000);
  const b1 = (await buildsIn(box)).builds;
  check(b1.length === 1 && b1[0].id === id && b1[0].cells === 21 && b1[0].state === 'ACTIVE', `item 6: cut to 21: ${id} stays (${b1.map((b) => `${b.id} ${b.state} ${b.cells}`)})`);
  // cut to 19 (17 logs and the door): incidental after the debounce and the two evaluations 60 s apart
  await breaks(logs.slice(17, 19));
  await settle(6000);
  const b2 = (await buildsIn(box)).builds;
  const t0 = Date.now();
  let b3 = b2;
  for (let i = 0; i < 30 && b3.length; i++) { await settle(5000); b3 = (await buildsIn(box, false)).builds; }
  check(b2.length === 1 && b3.length === 0, `item 6: cut to 19: ${id} is incidental after the debounce and the 60 s demotion gap (${((Date.now() - t0) / 1000).toFixed(0)} s after the first look)`, { first: b2, after: b3 });
  const c3 = await cellsOf(box);
  check(c3.tracked === 19 && c3.incidental === 19, `item 6: its 19 cells stay tracked, incidental (${c3.tracked}/${c3.incidental})`);
  // regrown to 30 (28 logs and the door): stays incidental (below the 40 bar; no grace)
  await uses(logs.slice(17, 28).map((at) => ({ item: 'minecraft:oak_log', at })));
  await settle(6000);
  const b4 = (await buildsIn(box)).builds;
  check(b4.length === 0, `item 6: regrown to 30: stays incidental (${b4.length} builds)`);
  // the id: a cabin, +50 blocks, a merge with a newer build (the oldest wins), a reload
  await rule('graceMs', 600000);
  const C = [X + 30, Z];
  await uses(cabinOps(C[0], y, C[1]));
  await settle(6000);
  const cb = (await buildsIn(cabinBox(C[0], y, C[1]))).builds;
  const cid = cb[0]?.id;
  const more = [];
  for (let i = 0; i < 50; i++) more.push({ item: 'minecraft:oak_planks', at: [C[0] + 9, y + (i % 5), C[1] + Math.floor(i / 5)] });
  await uses(more);
  await settle(6000);
  const cb2 = (await buildsIn(cabinBox(C[0], y, C[1]))).builds;
  check(cb2.length === 1 && cb2[0].id === cid && cb2[0].cells === cb[0].cells + 50, `item 6: the id ${cid} survives +50 blocks (${cb[0]?.cells} -> ${cb2[0]?.cells} cells)`);
  // a newer build 6 east, then joined to the cabin by a row of planks
  const D = [C[0] + 16, Z];
  await uses(cabinOps(D[0], y, D[1], { placer: 'PTSam' }));
  await settle(6000);
  const db = (await buildsIn(cabinBox(D[0], y, D[1]))).builds;
  const did = db.find((b) => b.id !== cid)?.id;
  const bridge = [];
  for (let x = C[0] + 10; x < D[0]; x++) bridge.push({ item: 'minecraft:oak_planks', at: [x, y + 3, C[1] + 4] });
  await uses(bridge);
  await settle(6000);
  const merged = (await buildsIn([C[0], y, C[1], D[0] + 8, y + 6, D[1] + 8])).builds;
  const viaAlias = await call('dev.pt.build', { build: did });
  const older = Number(cid.split('-')[1]) < Number(did.split('-')[1]);
  check(merged.length === 1 && merged[0].id === cid && older && viaAlias.found && viaAlias.buildId === cid, `item 6: a merge: one build ${merged[0]?.id} (the oldest of ${cid} and ${did}); ${did} resolves to ${viaAlias.buildId}`);
  const cells0 = await cellsOf([C[0], y, C[1], D[0] + 8, y + 6, D[1] + 8]);
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G6B PT Hyst');
  await tp(C[0] + 0.5, gy + 25, C[1] + 0.5);
  const after = (await buildsIn([C[0], y, C[1], D[0] + 8, y + 6, D[1] + 8])).builds;
  const cells1 = await cellsOf([C[0], y, C[1], D[0] + 8, y + 6, D[1] + 8]);
  const viaAlias2 = await call('dev.pt.build', { build: did });
  check(after.length === 1 && after[0].id === cid && cells1.sha256 === cells0.sha256 && viaAlias2.buildId === cid, `item 6: after a reload ${cid} is still the build (alias ${did} -> ${viaAlias2.buildId}; the set's hash equal)`);
  out.ids = { id, cid, did };
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 7: the village (S7's flat_village on a flat copy)

// The contract names "an S3 copy". S3's program (route_demo) plans its flat variant only while the claim's ground varies by at most 2,
// and any build in the claim (a 7-high cabin) turns it into its natural variant, which writes next to nothing here; the village scenario
// with lots, S7's flat_village, is the one whose lots and street the builds can be kept out of, so item 7 runs on S7 (CONTRACT PT as built).
const S7 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's7_flat_village.json'), 'utf8'));
steps.village = async () => {
  const X = 5000, Z = 5000;
  const gy = await flatWorld('G6B PT Village', X + 56, Z + 56);
  const y = gy + 1;
  const claim = [X, Z, X + 111, Z + 111];
  const params = { lots: S7.params.lots };
  const out = {};
  const lb = (l) => [l.box.minX, l.box.minY, l.box.minZ, l.box.maxX, l.box.maxY, l.box.maxZ];
  // a first plan: where flat_village's lots fall on this flat claim
  const p0 = await L.plan('flat_village', claim, { params, surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const ir0 = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p0.planId, 'ir.json'), 'utf8'));
  out.lots0 = ir0.lots.map((l) => ({ id: l.id, box: lb(l) }));
  // the cabin 3 cells beside the first lot (2 cells between them), a cobble wall 3 cells beside the second
  const b0 = lb(ir0.lots[0]);
  const b1 = lb(ir0.lots[1]);
  const CX = b0[3] + 3, CZ = b0[2];
  await tp(CX + 4.5, gy + 30, CZ + 4.5);
  await uses(cabinOps(CX, y, CZ));
  const WX = b1[0], WZ = b1[2] - 3;
  const wops = [];
  for (let x = WX; x < WX + 12; x++) for (let yy = y; yy < y + 3; yy++) wops.push({ item: 'minecraft:cobblestone', at: [x, yy, WZ] });
  await tp(WX + 6.5, gy + 30, WZ + 0.5);
  await uses(wops);
  await settle(6000);
  const bl = (await buildsIn([X, gy - 2, Z, X + 111, gy + 12, Z + 111])).builds;
  const cab = bl.find((b) => b.bounds[0] === CX && b.bounds[2] === CZ);
  const wl = bl.find((b) => b.bounds[2] === WZ && b.bounds[0] === WX);
  check(cab && wl, `item 7: the cabin ${cab?.id} (${cab?.kind}) and the wall ${wl?.id} (${wl?.kind}, ${wl?.state}) are builds, 2 cells beside lots ${ir0.lots[0].id} and ${ir0.lots[1].id}`);
  const cabBox = cabinBox(CX, y, CZ);
  const wallBox = [WX, y, WZ, WX + 11, y + 2, WZ];
  const hc0 = await khash(cabBox);
  const hw0 = await khash(wallBox);
  await tp(X + 56.5, gy + 40, Z + 56.5);
  const p = await L.plan('flat_village', claim, { params, surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const ir = JSON.parse(fs.readFileSync(path.join(SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  const has = (r) => (ir.keepOut ?? []).some((k) => json(k) === json(r));
  const cabRect = [cab.bounds[0] - 1, cab.bounds[2] - 1, cab.bounds[3] + 1, cab.bounds[5] + 1];
  const wallRect = [wl.bounds[0] - 1, wl.bounds[2] - 1, wl.bounds[3] + 1, wl.bounds[5] + 1];
  const meets = (b, r) => b[0] <= r[2] && b[3] >= r[0] && b[2] <= r[3] && b[5] >= r[1];
  const lotsOut = ir.lots.every((l) => !meets(lb(l), cabRect) && !meets(lb(l), wallRect));
  const roadsOut = (ir.roads ?? []).every((rd) => (rd.points ?? []).every((q) => !(q[0] >= cabRect[0] && q[0] <= cabRect[2] && q[2] >= cabRect[1] && q[2] <= cabRect[3])
    && !(q[0] >= wallRect[0] && q[0] <= wallRect[2] && q[2] >= wallRect[1] && q[2] <= wallRect[3])));
  out.keepOut = ir.keepOut;
  out.lots = ir.lots.map((l) => ({ id: l.id, box: lb(l) }));
  check(has(cabRect) && has(wallRect) && lotsOut && roadsOut, `item 7: the plan keeps them out: the IR's keepOut holds the cabin's and the wall's rects (a 1-cell margin; ${(ir.keepOut ?? []).length - 2} door-apron rects); no lot or street point meets them (lots ${ir.lots.length})`);
  const yr = p.claimY ?? [-64, 64];
  const box = [claim[0] - 8, yr[0], claim[1] - 8, claim[2] + 8, yr[1], claim[3] + 8];
  const h0 = await call('dev.region.hash', { box }, 3_600_000);
  const region = await L.realise(p.planId, { lots: Object.fromEntries(ir.lots.map((l) => [l.id, 'g6a_stub_9'])) });
  const st = await L.waitRegion(region, 3 * 3_600_000);
  const hc1 = await khash(cabBox);
  const hw1 = await khash(wallBox);
  out.realise = { state: st.view.state, cells: st.view.cellsWritten, skipped: st.view.cellsSkipped, buildHits: st.view.buildHits, lots: st.view.lots?.map((l) => `${l.id}:${l.state}`) };
  const placedLots = (st.view.lots ?? []).filter((l) => /placed/i.test(l.state)).length;
  check(['PLACED', 'PARTIAL'].includes(st.view.state) && st.view.cellsWritten > 100 && placedLots >= 8 && hc1.sha256 === hc0.sha256 && hc1.cells === hc0.cells && hw1.sha256 === hw0.sha256,
    `item 7: realised (${st.view.state}, ${st.view.cellsWritten} terrain cells written, ${placedLots} of ${ir.lots.length} lots placed): 0 of the cabin's ${hc0.cells} and the wall's ${hw0.cells} blocks lost (hash equal)`);
  const findings = { keepOut: ir.keepOut ?? [], skipped: Object.fromEntries(Object.entries(st.view.cellsSkipped ?? {}).filter(([k]) => k.startsWith('player_build'))), hits: st.view.buildHits ?? [] };
  out.findings = findings;
  fs.writeFileSync(path.join(OUT, 'village-findings.json'), JSON.stringify(findings, null, 2));
  check(findings.keepOut.length >= 2, `item 7: findings recorded (village-findings.json): the plan's keepOut ${findings.keepOut.length} rects; the realise's cellsSkipped ${json(findings.skipped)}, buildHits ${findings.hits.length}`);
  // the realise removed: the world as before (its group undo is exact), the builds untouched
  await cmd('/kill @e[type=!minecraft:player]');
  await undo(region);
  const h1 = await call('dev.region.hash', { box }, 3_600_000);
  check(h1.sha256 === h0.sha256, 'item 7: the region removed by its owner: the world hash equals the pre-realise one');
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 8: brush strokes over the cabin

steps.brush = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Brush', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  await settle(6000);
  const cb = (await buildsIn(cabinBox(X, y, Z))).builds;
  check(cb.length === 1 && cb[0].kind === 'HOUSE', `item 8: the cabin is a build (${cb.map((b) => `${b.id} ${b.kind}`)})`);
  const h0 = await khash(cabinBox(X, y, Z));
  const c0 = await cellsOf(cabinBox(X, y, Z));
  const box = [X - 12, gy - 12, Z - 12, X + 20, gy + 20, Z + 20];
  const snap = await snapBox(box, 'brush');
  const strokes = [];
  for (const destruction of ['natural_only', 'player_blocks']) {
    for (const s of [{ kind: 'raise', shape: 'cylinder', at: [X + 4, gy, Z + 4], radius: 10, strength: 4 }, { kind: 'lower', shape: 'cylinder', at: [X + 4, gy + 3, Z + 4], radius: 10, strength: 6 },
      { kind: 'smooth', shape: 'sphere', at: [X + 4, gy + 3, Z + 4], radius: 10, strength: 6 }, { kind: 'melt', shape: 'sphere', at: [X + 8, gy + 4, Z + 8], radius: 8, strength: 3 }]) {
      const v = await brush({ ...s, destruction });
      strokes.push({ s: `${s.kind} ${destruction}`, v });
      const h = await khash(cabinBox(X, y, Z));
      check(!v.refused && h.sha256 === h0.sha256 && h.cells === h0.cells, `item 8: ${s.kind} ${destruction.toUpperCase()} without consent at and over the cabin: 0 of its ${h0.cells} blocks lost (${v.state ?? v.refused}; ${v.cellsWritten} cells written, player_build skipped ${v.cellsSkipped?.player_build ?? 0})`);
    }
  }
  const skipped = strokes.reduce((a, x) => a + (x.v.cellsSkipped?.player_build ?? 0), 0);
  check(skipped > 0, `item 8: the strokes met the cabin (${skipped} build cells skipped as player_build, per id ${json(Object.fromEntries(Object.entries(strokes[0].v.cellsSkipped ?? {}).filter(([k]) => k.startsWith('player_build.'))))})`);
  for (const x of strokes.reverse()) if (x.v.region) await undo(x.v.region);
  const d = await diffBox(box, snap);
  const c1 = await cellsOf(cabinBox(X, y, Z));
  check(d.mismatches === 0 && c1.sha256 === c0.sha256, `item 8: every stroke undone: E-flat ${d.mismatches}, the cabin's records unchanged`, d.sample);
  await leaveWorld();
  spendZero();
  return { strokes: strokes.map((x) => ({ s: x.s, cells: x.v.cellsWritten, skipped: x.v.cellsSkipped })) };
};

// ------------------------------------------------------------------ item 9: felling stops at the cabin

steps.felling = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Felling', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  // a tree east of the cabin (commands: natural), its branch resting on the cabin's east wall
  const TX = X + 10, TZ = Z + 4;
  await cmd(`/fill ${TX} ${y} ${TZ} ${TX} ${y + 6} ${TZ} minecraft:oak_log`);
  await cmd(`/fill ${X + 9} ${y + 4} ${TZ} ${TX - 1} ${y + 4} ${TZ} minecraft:oak_log[axis=x]`);
  await cmd(`/setblock ${TX} ${y + 7} ${TZ} minecraft:oak_leaves[persistent=false,distance=1]`);
  await settle(6000);
  const cb = (await buildsIn(cabinBox(X, y, Z))).builds;
  check(cb.length === 1, `item 9: the cabin ${cb[0]?.id} stands, the tree's branch touching its east wall`);
  const h0 = await khash(cabinBox(X, y, Z));
  const box = [X - 8, gy - 4, Z - 8, X + 24, gy + 14, Z + 16];
  const snap = await snapBox(box, 'felling');
  const v = await brush({ kind: 'raise', shape: 'cylinder', at: [TX, gy, TZ], radius: 2, strength: 2 });
  const h1 = await khash(cabinBox(X, y, Z));
  const trunk = await call('dev.region.logs', { box: [TX, y, TZ, TX, y + 6, TZ] }, 300_000);
  const branch = await call('dev.region.logs', { box: [X + 9, y + 4, TZ, TX - 1, y + 4, TZ] }, 300_000);
  const kb = v.cellsSkipped?.['tree_kept.build'] ?? 0;
  check(!v.refused && kb >= 1, `item 9: the felling flood stops at the cabin's logs (tree_kept.build ${kb}; M3:tree_kept ${v.cellsSkipped?.['M3:tree_kept'] ?? 0}; felled ${v.cellsSkipped?.treeCells ?? 0})`);
  check(h1.sha256 === h0.sha256, 'item 9: the cabin\'s hash unchanged');
  check(trunk.logs === 0 && branch.logs === 0, `item 9: the rest felled (trunk ${trunk.logs}, branch ${branch.logs} logs left)`);
  if (v.region) await undo(v.region);
  const d = await diffBox(box, snap);
  check(d.mismatches === 0, `item 9: one undo restores the world exactly (${d.mismatches} mismatches)`, d.sample);
  await leaveWorld();
  spendZero();
  return { stroke: v.cellsSkipped };
};

// ------------------------------------------------------------------ item 10: undo exact (the verifier re-runs it)

steps.undo = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Undo', X, Z);
  const y = gy + 1;
  // a cobblestone hut 9 x 5 x 9 with a door (non-natural: PLAYER_BLOCKS clears it), by two placers
  const hut = cabinOps(X, y, Z, { item: 'minecraft:cobblestone' }).filter((o) => o.at[1] < y + 4 || o.at[1] === y + 6).map((o) => (o.at[1] === y + 6 ? { ...o, at: [o.at[0], y + 4, o.at[2]] } : o));
  hut.forEach((o, i) => { if (i % 3 === 0 && o.item === 'minecraft:cobblestone') o.placer = 'PTSam'; });
  await uses(hut);
  // 20 incidental cells: single cobblestones 3 apart, 3+ from the hut, inside the stroke
  const inc = [];
  for (let i = 0; i < 20; i++) inc.push({ item: 'minecraft:cobblestone', at: [X + 12 + (i % 5) * 3, y, Z - 2 + Math.floor(i / 5) * 3], placer: 'PTOther' });
  await uses(inc);
  await settle(6000);
  const box = [X - 6, gy - 8, Z - 8, X + 30, gy + 12, Z + 16];
  const bl = (await buildsIn(box)).builds;
  const hb = bl.find((b) => b.bounds[0] === X && b.bounds[2] === Z);
  check(hb && bl.length === 1, `item 10: the hut is one build ${hb?.id} (${hb?.kind}, ${hb?.cells} cells, placers ${Object.keys(hb?.placers ?? {}).length}); the 20 singles are incidental`);
  const pre = await cellMap(box);
  const snap = await snapBox(box, 'undo');
  // with consent (the bot: an op), a PLAYER_BLOCKS stroke over the hut's east half and the singles
  const v = await brush({ kind: 'lower', shape: 'cylinder', at: [X + 15, gy + 3, Z + 3], radius: 14, strength: 10, destruction: 'player_blocks', consent: [hb.id] });
  const mid = await cellMap(box);
  const lostBuild = [...pre.map].filter(([k, x]) => x.kept && !mid.map.has(k)).length;
  const lostInc = [...pre.map].filter(([k, x]) => !x.kept && !mid.map.has(k)).length;
  const standing = (await call('dev.pt.build', { build: hb.id }));
  check(!v.refused && lostBuild >= 40 && lostInc >= 20, `item 10: with consent the stroke cleared ${lostBuild} of the build's cells (>= 40) and ${lostInc} incidental ones (>= 20); ${v.cellsWritten} cells written`);
  check(standing.found, `item 10: part of the build stands (${hb.id} is not gone), so its id is the same after the undo`);
  // one undo, before the 60 s demotion gap
  await undo(v.region);
  const d = await diffBox(box, snap);
  await buildsIn(box);
  const post = await cellMap(box);
  const mism = diffMaps(pre.map, post.map);
  check(d.mismatches === 0, `item 10: one undo: blocks E-flat ${d.mismatches}`, d.sample);
  check(mism.length === 0 && post.sha256 === pre.sha256, `item 10: the tracked set, placers and build ids: ${mism.length} mismatches (${pre.tracked} records)`, mism.slice(0, 12));
  await leaveWorld();
  spendZero();
  return { lostBuild, lostInc, stroke: v.cellsSkipped };
};

// ------------------------------------------------------------------ item 11: named refusals, the PATH join

steps.refusals = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Refusals', X, Z);
  const y = gy + 1;
  const out = {};
  await uses(cabinOps(X, y, Z));
  await settle(6000);
  const cb = (await buildsIn(cabinBox(X, y, Z))).builds[0];
  // a building placed over the cabin (through the public API)
  const r = await apiResult(await api(`ptplace g6a_stub_9 ${X} ${y} ${Z} k1`));
  out.place = r;
  const ref = (r.refusals ?? []).find((x) => x.reason === 'PLAYER_BUILD');
  const hit = ref?.builds?.[0];
  check(!r.placed && ref && hit?.buildId === cb.id && hit.kind === cb.kind && hit.blocking > 0 && hit.first === Math.min(8, hit.blocking), `item 11: a building over the cabin is refused PLAYER_BUILD naming ${hit?.buildId} (${hit?.kind}, ${hit?.blocking} blocks, first ${hit?.first}): "${ref?.message?.slice(0, 160)}"`);
  // the message's first 8 positions with block ids, each equal to the world
  const m = /in the way: (.*?)(; and \d+ more)?\)/.exec(ref?.message ?? '');
  const firsts = (m?.[1] ?? '').split('; ').filter(Boolean).map((s) => s.split(' '));
  let equal = 0;
  for (const [x, yy, z, id] of firsts) { const a = await ptAt([+x, +yy, +z]); if (a.state === id && a.kept === cb.id) equal++; }
  check(firsts.length === 8 && equal === 8, `item 11: the refusal's first 8 positions and block ids equal the world (${equal}/${firsts.length})`, firsts);
  // a partial road across the cabin: its skipped span names the build
  const road = await call('dev.road.place', { points: [[X - 10, gy, Z + 4], [X + 4, gy, Z + 4], [X + 20, gy, Z + 4]], width: 3, partial: true, owner: OWNER }, 300_000);
  out.road = road;
  const span = (road.skipped ?? []).find((s) => s.reason === 'PLAYER_BUILD');
  check(span && span.message.includes(cb.id), `item 11: a partial road's skipped span names the build (${span?.from}-${span?.to} ${span?.reason}: ${span?.message})`, road);
  const strict = await call('dev.road.place', { points: [[X - 10, gy, Z + 4], [X + 20, gy, Z + 4]], width: 3, owner: OWNER }, 300_000);
  const sref = (strict.refusals ?? []).find((x) => x.reason === 'PLAYER_BUILD');
  check(!strict.placed && sref?.message?.includes(cb.id), `item 11: the same road without partial is refused PLAYER_BUILD (${sref?.message?.slice(0, 120)})`);
  // Steward's addition: a road routed across a player's path joins it with 0 path cells changed
  const P = [X, Z + 30];
  const path3 = [];
  for (let i = 0; i < 48; i++) path3.push({ item: 'minecraft:iron_shovel', at: [P[0] + (i % 16), gy, P[1] + Math.floor(i / 16)] });
  await uses(path3);
  await settle(6000);
  const pb = (await buildsIn([P[0], gy, P[1], P[0] + 15, gy, P[1] + 2])).builds;
  const pathBox = [P[0], gy - 1, P[1], P[0] + 15, gy + 2, P[1] + 2];
  const ph0 = await bhash(pathBox);
  const join = await call('dev.road.place', { points: [[P[0] + 7, gy, P[1] - 14], [P[0] + 7, gy, P[1] + 16]], width: 3, owner: OWNER }, 300_000);
  const ph1 = await bhash(pathBox);
  check(pb.length === 1 && pb[0].kind === 'PATH' && join.placed && ph1.sha256 === ph0.sha256, `Steward's addition: a road across the player's path ${pb[0]?.id} (${pb[0]?.kind}, ${pb[0]?.state}) joins it (${join.placed ? 'placed' : json(join.refusals)}) with 0 path cells changed`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 12: incidental cells (and the no-mod half: nomod)

steps.incidental = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Incidental', X, Z);
  const y = gy + 1;
  // 20 torches 3 apart, and a levelled 7 x 7 dirt patch (incidental: no build)
  const torches = [];
  for (let i = 0; i < 20; i++) torches.push({ item: 'minecraft:torch', at: [X + (i % 5) * 3, y, Z + Math.floor(i / 5) * 3] });
  await uses(torches);
  const P = [X + 24, Z];
  await cmd(`/fill ${P[0]} ${gy} ${P[1]} ${P[0] + 6} ${gy} ${P[1] + 6} minecraft:air`);
  const patch = [];
  for (let i = 0; i < 49; i++) patch.push({ item: 'minecraft:dirt', at: [P[0] + (i % 7), gy, P[1] + Math.floor(i / 7)] });
  await uses(patch);
  await settle(6000);
  const box = [X - 10, gy - 12, Z - 10, X + 40, gy + 14, Z + 20];
  const bl = (await buildsIn(box)).builds;
  const pre = await cellMap(box);
  check(bl.length === 0 && pre.tracked === 69 && pre.incidental === 69, `item 12: 20 torches and a 7x7 dirt patch: 69 tracked, all incidental (${bl.length} builds)`);
  const snap = await snapBox(box, 'incidental');
  // a realise over them (two strokes, NATURAL_ONLY): a raise over the torches, a lower over the patch
  const a = await brush({ kind: 'raise', shape: 'cylinder', at: [X + 6, gy, Z + 4], radius: 9, strength: 3 });
  const b = await brush({ kind: 'lower', shape: 'cylinder', at: [P[0] + 3, gy + 1, P[1] + 3], radius: 6, strength: 3 });
  const mid = await cellMap(box);
  const refused = [a, b].filter((v) => v.refused || (v.cellsSkipped?.player_build ?? 0) > 0);
  const tw = torches.filter((t) => !mid.map.has(t.at.join(','))).length;
  const pw = patch.filter((t) => !mid.map.has(t.at.join(','))).length;
  check(refused.length === 0 && tw > 0 && pw > 0, `item 12: the realise writes them with no refusal (${tw} torches and ${pw} patch cells written; no player_build skip)`);
  await undo(b.region);
  await undo(a.region);
  const d = await diffBox(box, snap);
  const post = await cellMap(box);
  const mism = diffMaps(pre.map, post.map);
  check(d.mismatches === 0 && mism.length === 0, `item 12: its undo restores them (E-flat ${d.mismatches}) and their records (${mism.length} mismatches of ${pre.tracked})`, mism.slice(0, 8));
  // §5's building path: a building placed (public API) over 4 incidental torches and 4 cobblestones, then removed: its template
  // restore writes them back with their records (Sites.restoreTemplate under the writer scope)
  const S = [X, Z + 40];
  const under = [];
  for (let i = 0; i < 4; i++) under.push({ item: 'minecraft:torch', at: [S[0] + 2 + i * 2, y, S[1] + 2] });
  for (let i = 0; i < 4; i++) under.push({ item: 'minecraft:cobblestone', at: [S[0] + 2 + i * 2, y, S[1] + 6] });
  await uses(under);
  await settle(6000);
  const sbox = [S[0] - 3, gy - 6, S[1] - 3, S[0] + 12, gy + 10, S[1] + 12];
  const spre = await cellMap(sbox);
  const sbl = (await buildsIn(sbox)).builds;
  const ssnap = await snapBox(sbox, 'incidental-site');
  const sp = await apiResult(await api(`ptplace g6a_stub_9 ${S[0]} ${y} ${S[1]} i1`));
  const smid = await cellMap(sbox);
  const covered = under.filter((t) => !smid.map.has(t.at.join(','))).length;
  check(sp.placed && sp.site && sbl.length === 0 && spre.tracked === 8 && spre.incidental === 8 && covered > 0, `item 12: a building (g6a_stub_9, site ${sp.site}) placed over 8 incidental cells with no refusal (${covered} of them written over; ${json(sp.refusals ?? [])})`, sp);
  const rm = sp.site ? await call('dev.sites.remove', { site: sp.site }, 60_000) : { removed: false };
  await settle(3000);
  const sd = await diffBox(sbox, ssnap);
  const spost = await cellMap(sbox);
  const smism = diffMaps(spre.map, spost.map);
  check(rm.removed && sd.mismatches === 0 && smism.length === 0, `item 12: its removal (template restore) restores them (E-flat ${sd.mismatches}) and their records (${smism.length} mismatches of ${spre.tracked})`, { rm, mism: smism.slice(0, 8) });
  await leaveWorld();
  spendZero();
  return { torchesWritten: tw, patchWritten: pw, siteCovered: covered };
};

steps.nomod = async () => {
  const X = 400, Z = 400;
  const gy = await flatWorld('G6B PT NoMod', X, Z);
  const y = gy + 1;
  const ops = [];
  for (let i = 0; i < 16; i++) ops.push({ item: 'minecraft:stone_bricks', at: [X + i, y, Z] });
  await uses(ops);
  const c0 = await cellsOf([X - 1, y - 1, Z - 1, X + 17, y + 1, Z + 1]);
  await cmd('/save-all flush');
  await leaveWorld();
  const { startNoMod, readChunk, attachmentKeys } = await import('./lib/nomod-server.mjs');
  const W = path.join(SAVES, 'G6B PT NoMod');
  const ch0 = await readChunk(W, X >> 4, Z >> 4);
  check(attachmentKeys(ch0).includes('architect_mc:placed'), `item 12: with the mod the chunk's NBT holds fabric:attachments/architect_mc:placed (${c0.tracked} records)`);
  // a server of the same game and Fabric API without Architect: the chunk loaded (forceload), saved, unloaded, the server stopped
  const G = path.join(os.tmpdir(), `gate6cpt-nomod-${process.pid}`);
  fs.rmSync(G, { recursive: true, force: true });
  fs.mkdirSync(path.join(G, 'saves'), { recursive: true });
  execFileSync('cp', ['-c', '-R', W, path.join(G, 'saves', 'NoMod')]);
  const eula = process.env.ARCHITECT_SERVER_EULA ?? path.join(os.homedir(), 'Developer', '_infra', 'minecraft-server', 'eula.txt');
  const out = {};
  for (const mode of ['never loaded', 'loaded']) {
    const w = path.join(G, 'saves', 'NoMod');
    const s = await startNoMod({ root, gameDir: G, world: 'NoMod', port: Number(process.env.GATE6CPT_NOMOD_PORT ?? 0), eula, logFile: path.join(OUT, `nomod-${mode.replace(' ', '-')}.log`) });
    await s.waitFor(/Done \(/, 600_000);
    if (mode === 'loaded') {
      s.send(`forceload add ${X} ${Z}`);
      await sleep(5000);
      s.send(`forceload remove ${X} ${Z}`);
      await sleep(15000);
    }
    const log = await s.stop();
    const ch = await readChunk(w, X >> 4, Z >> 4);
    out[mode] = { keys: attachmentKeys(ch), skipped: /Skipping invalid attachments/.test(log), architectOnClasspath: /architect_mc\.mixins|Architect common init/.test(log) };
  }
  check(!out['loaded'].architectOnClasspath && !out['never loaded'].architectOnClasspath, 'item 12: the second server runs without Architect (no Architect init in its log)');
  check(out['never loaded'].keys.includes('architect_mc:placed'), `item 12: a start without the mod that never loads the chunk leaves architect_mc:placed in its NBT (${json(out['never loaded'].keys)})`);
  check(out['loaded'].keys.includes('architect_mc:placed'), `item 12: the chunk NBT keeps architect_mc:placed after a start without the mod that loads it (measured: ${json(out['loaded'].keys)}; Fabric API logs "Skipping invalid attachments" ${out['loaded'].skipped} and the chunk is saved again without it)`);
  fs.rmSync(G, { recursive: true, force: true });
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 13: claim, release, supports

steps.claim = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Claim', X, Z);
  const y = gy + 1;
  // a pre-PT log cabin (commands: no record)
  await cmd(`/fill ${X} ${y} ${Z} ${X + 8} ${y + 5} ${Z + 8} minecraft:oak_log hollow`);
  await cmd(`/fill ${X} ${y + 6} ${Z} ${X + 8} ${y + 6} ${Z + 8} minecraft:oak_log`);
  const box = cabinBox(X, y, Z);
  const c0 = await cellsOf(box);
  check(c0.tracked === 0, `item 13: the pre-PT cabin is not tracked (${c0.tracked})`);
  const cl = await call('dev.pt.claim', { box, actor: 'bot' });
  check(!cl.refused && cl.state === 'CLAIMED' && cl.cells > 200, `item 13: claimed: ${cl.buildId} ${cl.state} ${cl.cells} cells (${cl.kind})`, cl);
  const h0 = await khash(box);
  // a raise at the west wall's middle: it writes the wall's bottom logs (natural by class), and felling takes every log joined to them
  const st = { kind: 'raise', shape: 'cylinder', at: [X, gy, Z + 4], radius: 2, strength: 2 };
  const v1 = await brush(st);
  const h1 = await khash(box);
  check(!v1.refused && h1.sha256 === h0.sha256 && h0.cells > 200 && (v1.cellsSkipped?.player_build ?? 0) > 0, `item 13: kept by a stroke (a raise at its wall's base): its ${h0.cells} cells unchanged, ${v1.cellsSkipped?.player_build} build cells skipped`);
  if (v1.region) await undo(v1.region);
  const rl = await call('dev.pt.release', { build: cl.buildId, actor: 'bot' });
  check(rl.state === 'RELEASED', `item 13: released: ${rl.buildId} ${rl.state}`);
  const t2a = await cellsOf(box);
  const v2 = await brush(st);
  const t2b = await cellsOf(box);
  check(!v2.refused && t2b.tracked < t2a.tracked && (v2.cellsSkipped?.player_build ?? 0) === 0, `item 13: cleared by the next stroke (${t2a.tracked - t2b.tracked} of its ${t2a.tracked} cells written, felled ${v2.cellsSkipped?.treeCells ?? 0}; ${v2.cellsWritten} cells written, 0 build cells skipped)`);
  if (v2.region) await undo(v2.region);
  // supports: a torch of a build on natural ground beside a lowered column stays
  const H = [X + 30, Z];
  const hut = cabinOps(H[0], y, H[1], { item: 'minecraft:cobblestone' }).filter((o) => o.at[1] < y + 3 || o.at[1] === y + 6).map((o) => (o.at[1] === y + 6 ? { ...o,
    at: [o.at[0], y + 3, o.at[2]] } : o));
  await uses(hut);
  const T = [H[0] + 10, y, H[1] + 4];
  await uses([{ item: 'minecraft:torch', at: T }]);
  await settle(6000);
  const hb = (await buildsIn([H[0], y, H[1], T[0], y + 6, H[1] + 8])).builds;
  const ta = await ptAt(T);
  check(hb.length === 1 && ta.kept === hb[0].id, `item 13: the torch at ${T} is a cell of the build ${hb[0]?.id} (kept ${ta.kept}; builds there ${hb.map((b) => b.id)})`);
  const v3 = await brush({ kind: 'lower', shape: 'cylinder', at: [T[0] + 2, gy, T[2]], radius: 3, strength: 3 });
  const tb = await ptAt(T);
  const ground = await ptAt([T[0], gy, T[2]]);
  check(!v3.refused && (v3.cellsSkipped?.['player_build.support'] ?? 0) >= 1 && tb.state === 'minecraft:torch' && tb.tracked && ground.state !== 'minecraft:air', `item 13: the torch on natural ground beside the lowered column stays (player_build.support ${v3.cellsSkipped?.['player_build.support'] ?? 0}; torch ${tb.state}, its ground ${ground.state})`);
  if (v3.region) await undo(v3.region);
  await leaveWorld();
  spendZero();
  return { claim: cl, release: rl };
};

// ------------------------------------------------------------------ item 14: plan features (the kit's helpers on the live index)

steps.plan = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Plan', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  await settle(6000);
  const live = (await buildsIn([X - 20, gy - 4, Z - 20, X + 40, gy + 12, Z + 40])).builds;
  // the kit's helpers read the mod's index as Sites.builds gives it (BuildViews.planJson's shape)
  const kitBuilds = live.map((b) => ({ id: b.id, kind: b.kind, state: b.state, cells: b.cells, revision: b.revision, bounds: b.bounds, footprint: b.footprint,
    entrances: b.entrances.map((e) => ({ pos: e.pos.split(' ').map(Number), facing: e.facing })) }));
  const { pickBuild, buildEndpoint, targetRect } = await imp('lib/region/builds.mjs');
  const claim = { minX: X - 20, minZ: Z - 20, maxX: X + 40, maxZ: Z + 40 };
  const near = pickBuild(kitBuilds, { kind: 'house' }, { claim });
  const adj = targetRect(kitBuilds, near.build?.id);
  const ep = buildEndpoint(kitBuilds, near.build?.id, 'door');
  check(near.build && adj && ep.end, `item 14: near {build kind house} picks ${near.build?.id}; adjacent {to {build}} answers its rect ${json(adj)}; endpoint {build, port door} ends at ${json(ep.end)} (apron ${json(ep.apron)})`);
  const h0 = await khash(cabinBox(X, y, Z));
  const road = await call('dev.road.place', { points: [[ep.end[0], gy, ep.end[2] - 16], [ep.end[0], gy, ep.end[2]]], width: 1, owner: OWNER }, 300_000);
  const end = await ptAt([ep.end[0], gy, ep.end[2]]);
  const h1 = await khash(cabinBox(X, y, Z));
  check(road.placed && h1.sha256 === h0.sha256, `item 14: a road placed to the door's apron ends on it (its last centre cell ${json([ep.end[0], gy, ep.end[2]])} is now ${end.state}), the cabin untouched`);
  const plan = JSON.parse(fs.readFileSync(path.join(KIT, 'schemas', 'plan.json'), 'utf8'));
  const cat = Object.fromEntries(plan['x-catalogue'].entries.map((e) => [e.id, e]));
  check(cat['feature.build']?.state === 'supported' && cat['endpoint.build']?.state === 'supported' && cat['locator.around']?.state === 'reserved', 'item 14: feature.build and endpoint.build supported in the catalogue; around answers unsupported locator.around (reserved until FL)');
  await leaveWorld();
  spendZero();
  return { near: near.build?.id, endpoint: ep };
};

// ------------------------------------------------------------------ item 15: cost (recorded) and item 16: apitest

steps.cost = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Cost', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  await settle(6000);
  // the cold maxima (the first classification after a start: class loading, the JIT), then the steady state from here on
  const cold = await call('dev.pt.stats', { reset: true }, 600_000);
  // a dense section: 16 x 16 x 2 of planks (512 cells in one section), and a second cabin, classified in ticks
  await uses(cabinOps(X, y, Z + 20));
  const dense = [];
  for (let i = 0; i < 512; i++) dense.push({ item: 'minecraft:oak_planks', at: [X + 32 + (i % 16), y + Math.floor(i / 256), Z + (Math.floor(i / 16) % 16)] });
  await uses(dense);
  await settle(6000);
  await call('dev.pt.builds', { drain: true });
  const sparse = await call('dev.pt.stats', { box: cabinBox(X, y, Z), bench: 1_000_000 }, 600_000);
  const dn = await call('dev.pt.stats', { box: [X + 32, y, Z, X + 47, y + 1, Z + 15] }, 600_000);
  const out = { sparse, dense: dn, cold: { maxTickNs: cold.classifierMaxTickNs, phases: cold.classifierPhaseMaxNs } };
  fs.writeFileSync(path.join(OUT, 'cost-detail.json'), JSON.stringify(out, null, 2));
  check(sparse.tracked > 0 && dn.tracked >= 512, `item 15 (recorded): cost measured (cost-detail.json)`);
  bar(true, `item 15: sparse ${sparse.bytesPerBlock.toFixed(2)} B/block, ${sparse.bytesPerSection.toFixed(0)} B/section on disk (gzip ${sparse.nbtGzipBytes} B for ${sparse.tracked}), heap ${sparse.heapPerBlock.toFixed(1)} B/block; dense ${dn.bytesPerBlock.toFixed(2)} B/block, heap ${dn.heapBytes} B`);
  bar(true, `item 15: setBlockState added ns (median of 1M): tracked chunk ${sparse.hookNs?.tracked}, untracked ${sparse.hookNs?.untracked}`);
  const maxMs = (sparse.classifierMaxTickNs ?? 0) / 1e6;
  bar(maxMs <= 1.0, `item 15: the classifier's own CPU per tick max ${maxMs.toFixed(2)} ms after a warm-up (budget 1 ms; cold, the first classification after the start: ${((cold.classifierMaxTickNs ?? 0) / 1e6).toFixed(2)} ms; recorded)`);
  await leaveWorld();
  spendZero();
  return out;
};

steps.apitest = async () => {
  const X = 40, Z = 40;
  const gy = await flatWorld('G6B PT Api', X, Z);
  const y = gy + 1;
  await uses(cabinOps(X, y, Z));
  await settle(6000);
  await call('dev.pt.builds', { drain: true });
  const s = await api('apipt');
  check(s.builds && s.playerPlaced && s.playerBuildAppended && s.kinds === 7 && s.states === 4, `item 16: /apitest apipt through the public API: ${json(s)}`);
  const b = await api(`ptbuilds ${cabinBox(X, y, Z).join(' ')}`);
  check(Array.isArray(b) && b.length === 1 && b[0].kind === 'HOUSE', `item 16: Sites.builds(dim, box): ${json(b)}`);
  const a = await api(`ptat ${X} ${y} ${Z}`);
  check(a.tracked && a.buildId === b[0].id && a.placer === await uuidOf('PTAlex'), `item 16: Sites.playerPlaced(dim, pos): ${json(a)}`);
  const bx = await api(`ptbox ${cabinBox(X, y, Z).join(' ')}`);
  check(bx.tracked === b[0].cells && bx.builds?.[0]?.buildId === b[0].id, `item 16: Sites.playerPlaced(dim, box): ${json(bx)}`);
  const pl = await apiResult(await api(`ptplace g6a_stub_9 ${X} ${y} ${Z} a1`));
  check(!pl.placed && pl.refusals?.[0]?.reason === 'PLAYER_BUILD' && pl.refusals[0].builds?.[0]?.buildId === b[0].id, `item 16: Sites.place over it: ${pl.refusals?.[0]?.reason} with builds ${json(pl.refusals?.[0]?.builds)}`);
  await leaveWorld();
  spendZero();
  return { surface: s, builds: b };
};

steps.ingame = async () => {
  const parts = {};
  for (const s of ['record', 'clear', 'pistons', 'reload', 'builds', 'hyst', 'village', 'brush', 'felling', 'undo', 'refusals', 'incidental', 'claim', 'plan', 'cost', 'apitest']) {
    log(`-- ${s}`);
    try { parts[s] = await steps[s](); } catch (e) { log(String(e?.stack ?? e)); check(false, `${s}: ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  return parts;
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'ingame', 'nomod', 'record', 'clear', 'pistons', 'reload', 'builds', 'hyst', 'village', 'brush', 'felling', 'undo', 'refusals', 'incidental', 'claim', 'plan', 'cost', 'apitest']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([m, r]) => !r.ok && !m.startsWith('BAR'));
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const sp = path.join(OUT, 'spend.json');
  const spend = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : { totalUsd: 0, capUsd: 0 };
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-PT (player-placed tracking and builds)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cpt.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
