#!/usr/bin/env node
// Phase 6c slice B gate (docs/CONTRACT.md "Phase 6c slice B: terrain brushes as journal-backed region ops" §6). The offline items
// need no game; the in-game ones run on a headless server (gate-chains "host": "server") or a dev client of the run worktree
// (tools/run-gate6b-client.sh: the sim sidecar, no Claude, apitest on the classpath). Ports 8930 (sidecar) / 8931 (DevBridge) unless
// the runner gives others. $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cb.mjs <step>
//     unit        items 1, 6 (kit half), 8 (kit half) and 11 offline: kit/test/brush-b.test.mjs (the kernels' properties over 100 seeds,
//                 every kind plans, IR and tile shas over two plans, ARVX version 2 and the block mask), the goldens that must not
//                 move (S1, S7, mega_bench, the 6b families), the Java ApiBTest, BrushesTest, ArvxBlocksTest and ArvxTest
//     stale       the v0.23.1 kit and the 0.23.0 mod jar refuse a brush plan PLAN_STALE (its kit version; with a block volume, the
//                 volume:blocks kind); this build accepts it
//     apicompat   item 12: tools/api-compat.mjs --gate6cb (the 0.23.0, 0.22.0 and 0.21.0 apitest jars, the 0.23.0 surface)
//     ingame      items 2-5 and 7-10 on the flat world (a bump field, a player wall with a chest, another owner's road), item 12's
//                 apitest apib and the command path; each part also runs alone: flat-owned (2, 3), flat-undo (5), flat-permission (4),
//                 flat-misc (7, 8, 10, 12, commands)
//     natural     items 5 (E-normal) and 6 on a corner of S3's pinned claim (6b's seed world): five overlapping strokes, a cave carve
//                 (M3 0 floating, M4 0 breaches, judged on the realised dumps) and a melt, all undone; item 9 (own CPU, BAR)
//     report      REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-b/<step>.json in the main checkout (GATE6CB_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-B-run');
process.env.GATE6B_OUT = process.env.GATE6CB_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-b');
process.env.GATE6B_SIDECAR_PORT ??= '8930';
process.env.GATE6B_DEV_PORT ??= '8931';
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, MAIN, SAVES, bar, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, state, tp, write, copyWorld } = L;

refuseKeys();
fs.mkdirSync(OUT, { recursive: true });
const FLAT_BASE = 'G6B Flat Base';
const SEED_BASE = 'G6B Seed Base';
const FLAT = 'G6B Brush Flat';
const NAT = 'G6B Brush S3';
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const JAVA_HOME = process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25';
const KIT = path.join(root, 'kit');
const imp = (rel) => import(pathToFileURL(path.join(KIT, rel)).href);
const OWNER = 'gate:b';
const OTHER = 'gate:other';

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice B is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ offline

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 3_600_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)), notes: t.split('\n').filter((l) => l.startsWith('# ')) };
}

steps.unit = async () => {
  const out = {};
  out.b = nodeTest(['kit/test/brush-b.test.mjs']);
  const item = (re) => out.b.names.filter((l) => re.test(l));
  const okAll = (ls) => ls.length > 0 && ls.every((l) => l.startsWith('✔'));
  check(okAll(item(/item 1:/)) && item(/item 1:/).length === 5, `item 1: SMOOTH, RAISE/LOWER, ERODE (and BLEND's clamp), OVERLAY and MELT properties over 100 seeds each (${out.b.notes.join(' ')})`, item(/item 1:/));
  check(okAll(item(/item 6 \(kit\)/)), 'item 6 (kit): the cave worm never breaches water, lava or an unknown cell and leaves nothing floating (100 seeds)', item(/item 6/));
  check(okAll(item(/item 8:/)), 'item 8 (kit): every kind plans; the same request and seed give the same IR sha and tile shas; another seed another worm', item(/item 8:/));
  check(okAll(item(/ARVX version 2|block mask term/)) && item(/ARVX version 2|block mask term/).length === 2, 'the block mask term is real over an ARVX v2 volume (the mod\'s fixture decodes byte for byte), refused MASK_NEEDS_VOLUME over a v1 volume', item(/ARVX|block mask/));
  check(out.b.code === 0 && out.b.fail === 0, `kit/test/brush-b.test.mjs: ${out.b.pass} pass, ${out.b.fail} fail`, out.b.failing);
  out.goldens = nodeTest(['kit/test/region-golden.test.mjs', 'kit/test/region-6b.test.mjs', 'kit/test/scenario-goldens.test.mjs']);
  check(out.goldens.code === 0 && out.goldens.fail === 0, `item 11: the tile goldens hold (mega_bench, the 6b families, S1, S7): ${out.goldens.pass} pass, ${out.goldens.fail} fail`, out.goldens.failing);
  const env = { ...process.env, JAVA_HOME, GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*ApiBTest', '--tests', '*BrushesTest', '--tests', '*ArvxBlocksTest', '--tests', '*ArvxTest'],
    { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 3_600_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  out.java = { code: g.status, api: xml('api.ApiBTest'), brushes: xml('region.BrushesTest'), arvx2: xml('region.volume.ArvxBlocksTest'), arvx: xml('region.volume.ArvxTest') };
  check(g.status === 0 && Object.values(out.java).filter((v) => v && typeof v === 'object').every((v) => v.tests > 0 && v.failures === 0) && out.java.api && out.java.brushes && out.java.arvx2,
    `Java: ApiBTest ${json(out.java.api)} (1.21.0 surface, defaults, PERMISSION appended), BrushesTest ${json(out.java.brushes)} (fields, permission, boxes = the kit's, command options), ArvxBlocksTest ${json(out.java.arvx2)}`);
  spendZero();
  return out;
};

steps.stale = async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate6cb-'));
  const { planRegion } = await imp('lib/region/plan.mjs');
  const { makeColumns } = await imp('lib/region/pack.mjs');
  const { encodeArvx, decodeArvx, VC } = await imp('lib/region/volume.mjs');
  const { volumeBox } = await imp('lib/region/brush.mjs');
  const claim = { minX: -20, minZ: -20, maxX: 20, maxZ: 20, minY: -64, maxY: 319 };
  const s = makeColumns(-20, -20, 41, 41, 1); s.ground.fill(64); s.height.fill(64); s.floor.fill(64);
  const plain = await planRegion({ programFile: path.join(KIT, 'regions', 'brush.mjs'), survey: s, claim, seed: '3', params: { kind: 'raise', cx: 0, cy: 64, cz: 0, radius: 8, strength: 4 }, node: 'gate' });
  const vb = volumeBox({ cx: 0, cy: 64, cz: 0, radius: 6 }, claim);
  const W = vb.maxX - vb.minX + 1, H = vb.maxY - vb.minY + 1, D = vb.maxZ - vb.minZ + 1;
  const classes = new Uint8Array(W * H * D), index = new Uint16Array(W * H * D);
  for (let i = 0; i < W * D; i++) for (let y = 0; y < H; y++) { const k = i * H + y; const solid = vb.minY + y <= 64; classes[k] = solid ? VC.ROCK : VC.AIR; index[k] = solid ? 1 : 0; }
  const bytes = encodeArvx(vb, classes, [], new Map(), { palette: ['minecraft:air', 'minecraft:stone'], index });
  const dec = decodeArvx(bytes);
  const masked = await planRegion({ programFile: path.join(KIT, 'regions', 'brush.mjs'), survey: s, claim, seed: '3', params: { kind: 'overlay', cx: 0, cy: 64, cz: 0, radius: 6, strength: 1, mask: { block: ['stone'] }, pattern: { mix: [{ w: 1, mat: 'gravel' }] } }, volumes: [{ sha: dec.sha, box: vb, bytes, decoded: dec }], node: 'gate' });
  fs.writeFileSync(path.join(tmp, 'plain.json'), plain.irJson);
  fs.writeFileSync(path.join(tmp, 'masked.json'), masked.irJson);
  const asOld = (ir) => ({ ...ir, kitVersion: '0.20.0' });
  fs.writeFileSync(path.join(tmp, 'masked-kind.json'), JSON.stringify(asOld(masked.ir)));
  execFileSync('sh', ['-c', `git -C '${root}' archive v0.23.1 kit | tar -x -C '${tmp}'`]);
  const old = await import(pathToFileURL(path.join(tmp, 'kit', 'lib', 'realise.mjs')).href);
  const out = { requires: masked.ir.requires, kitVersion: plain.ir.kitVersion, oldKit: { version: old.EVAL_KIT_VERSION, plain: old.staleReason(plain.ir), masked: old.staleReason(masked.ir), kind: old.staleReason(asOld(masked.ir)) } };
  check(/^plan needs kit 0\.\d+\.0; this is kit/.test(out.oldKit.plain ?? '') && /kinds \[volume:blocks\]/.test(out.oldKit.masked ?? '') && /^plan needs kinds \[volume:blocks\]/.test(out.oldKit.kind ?? ''),
    `the v0.23.1 kit (${out.oldKit.version}) refuses a brush plan PLAN_STALE ("${out.oldKit.plain}"), a block-masked one by the kind too ("${out.oldKit.kind}")`);
  const gson = execFileSync('sh', ['-c', `ls '${path.join(root, '.gradle-home')}'/caches/modules-2/files-2.1/com.google.code.gson/gson/*/*/gson-*.jar | grep -v sources | head -1`]).toString().trim();
  const src = path.join(tmp, 'Stale.java');
  fs.writeFileSync(src, 'import com.google.gson.*;\npublic class Stale { public static void main(String[] a) throws Exception { for (String f : a) { JsonObject ir = JsonParser.parseString(java.nio.file.Files.readString(java.nio.file.Path.of(f))).getAsJsonObject(); System.out.println(dev.larattalabs.architect.region.IrStale.reason(ir, null)); } } }\n');
  const runJar = (cp) => execFileSync(path.join(JAVA_HOME, 'bin', 'java'), ['-cp', `${cp}:${gson}`, src, path.join(tmp, 'plain.json'), path.join(tmp, 'masked.json'), path.join(tmp, 'masked-kind.json')]).toString().trim().split('\n');
  const jar = path.join(MAIN, 'artifacts', 'gate6c-b', 'v0230', 'architect_mc-0.23.0.jar');
  out.oldMod = runJar(jar);
  check(/^plan needs kit 0\.\d+\.0; this is kit /.test(out.oldMod[0]) && /kinds \[volume:blocks\]/.test(out.oldMod[1]) && /^plan needs kinds \[volume:blocks\]/.test(out.oldMod[2]), `the 0.23.0 mod's IrStale refuses them PLAN_STALE: ${out.oldMod.join(' | ')}`);
  // this checkout's classes (the unit step's gradle test compiled them at this head)
  const classes2 = path.join(root, 'mod', 'build', 'classes', 'java', 'main');
  out.thisMod = runJar(classes2);
  const { staleReason } = await imp('lib/realise.mjs');
  check(out.thisMod[0] === 'null' && out.thisMod[1] === 'null' && staleReason(masked.ir) === null, `this build accepts them (mod ${out.thisMod.slice(0, 2).join(', ')}; kit ${staleReason(masked.ir)})`);
  spendZero();
  return out;
};

steps.apicompat = async () => {
  // this checkout's classes (the unit step compiled them at this head; run it first)
  const classes = [['main', 'client'].map((d) => path.join(root, 'mod', 'build', 'classes', 'java', d)).join(path.delimiter)];
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cb', ...classes], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 12: api-compat against the 0.23.0, 0.22.0 and 0.21.0 apitest jars and the 0.23.0 surface: ${t.trim().split('\n').pop()}`);
  spendZero();
  return { out: t };
};

// ------------------------------------------------------------------ in game: helpers

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
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

/** One stroke through dev.brush; returns the region's view (or {refused, reason}). */
async function brush(o) {
  const r = await call('dev.brush', { owner: OWNER, ...o }, 600_000);
  log(`  brush ${o.kind} r${o.radius} s${o.strength} ${o.shape ?? 'sphere'} at ${o.at} ${o.destruction ?? ''} ${o.owner ?? OWNER}: ${r.refused ? `refused ${r.refused}` : `${r.region} ${r.state} ${r.cellsWritten} cells, skipped ${json(r.cellsSkipped)}, ${Math.round(r.ms)} ms`}`);
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
const boxHash = async (min, max) => call('dev.box.hash', { min, max }, 120_000);
/** The other owner's road: the cells its journal entries own (state and block-entity data). */
const roadHash = async (site, gy) => call('dev.site.ownedHash', { site, box: [...ROAD(gy).min, ...ROAD(gy).max] }, 120_000);
/** The ground y at (x, z) from the region plan survey of a small claim around it. */
async function groundAt(x, z) {
  const f = path.join(OUT, `survey-${x}-${z}.bin`);
  await call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: f }, 300_000);
  const { decodeColumns } = await imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(f));
  return c.ground[1 + 3 * 1];
}
async function freshWorld(name, base, rules) {
  await ensure();
  await leaveWorld();
  copyWorld(base, name);
  await openWorld(name);
  await L.setRules(rules);
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
const itemsNear = async (x, y, z, r = 40) => {
  const res = await cmd(`/execute positioned ${x} ${y} ${z} if entity @e[type=minecraft:item,distance=..${r}]`);
  const m = /count: (\d+)/.exec((res.messages ?? []).join(' '));
  return m ? Number(m[1]) : 0;
};

// the flat fixture: centre (X0, gy, Z0); mounds, the player's wall with a chest, the other owner's road
const X0 = 40, Z0 = 40;
const WALL = (gy) => ({ min: [X0 + 12, gy + 1, Z0], max: [X0 + 18, gy + 3, Z0] });
const ROAD = (gy) => ({ min: [X0 - 18, gy - 4, Z0 - 12], max: [X0 + 18, gy + 6, Z0 - 4] });
const STROKES = (gy) => [
  { kind: 'raise', shape: 'cylinder', at: [X0, gy, Z0 - 4], radius: 10, strength: 4 },
  { kind: 'smooth', shape: 'sphere', at: [X0 - 2, gy + 2, Z0 - 2], radius: 10, strength: 6 },
  { kind: 'lower', shape: 'cylinder', at: [X0 + 3, gy, Z0 - 6], radius: 8, strength: 3 },
  { kind: 'overlay', shape: 'cylinder', at: [X0 + 1, gy + 2, Z0], radius: 9, strength: 2, pattern: { mix: [{ w: 3, mat: 'stone' }, { w: 1, mat: 'andesite' }] } },
  { kind: 'erode', shape: 'cylinder', at: [X0 - 3, gy + 2, Z0 - 3], radius: 10, strength: 3 },
];

async function flatFixture() {
  await freshWorld(FLAT, FLAT_BASE, 'exact');
  await tp(X0 + 0.5, 0, Z0 + 0.5);
  const gy = await groundAt(X0, Z0);
  await tp(X0 + 0.5, gy + 30, Z0 + 0.5);
  // the bump field: plain dirt mounds (vanilla fill: no journal entry owns them)
  for (const [bx, bz, h] of [[X0 - 4, Z0 - 2, 4], [X0 + 5, Z0 - 7, 3], [X0 - 8, Z0 + 4, 5], [X0 + 2, Z0 + 3, 2]]) {
    for (let k = 1; k <= h; k++) { const w = h - k + 1; await cmd(`/fill ${bx - w} ${gy + k} ${bz - w} ${bx + w} ${gy + k} ${bz + w} minecraft:dirt`); }
  }
  // two stone spikes (natural stone: MELT rounds them off)
  await cmd(`/fill ${X0 - 12} ${gy + 1} ${Z0 + 10} ${X0 - 12} ${gy + 6} ${Z0 + 10} minecraft:stone`);
  await cmd(`/fill ${X0 - 9} ${gy + 1} ${Z0 + 12} ${X0 - 9} ${gy + 4} ${Z0 + 12} minecraft:stone`);
  // the player's wall: stone bricks 7 long, 3 high, a chest with items in it
  const w = WALL(gy);
  await cmd(`/fill ${w.min.join(' ')} ${w.max.join(' ')} minecraft:stone_bricks`);
  await cmd(`/setblock ${X0 + 15} ${gy + 1} ${Z0} minecraft:chest[facing=south]{Items:[{Slot:0b,id:"minecraft:diamond",count:3},{Slot:1b,id:"minecraft:oak_log",count:17}]}`);
  // another owner's road (4e, owner gate:other) across the strokes' south side
  const road = await call('dev.road.place', { points: [[X0 - 14, gy, Z0 - 8], [X0 + 14, gy, Z0 - 8]], width: 3, lanterns: false, owner: OTHER }, 180_000);
  check(!road.refused && (road.cells ?? road.placed ?? 1) > 0, `the other owner's road placed (${json(road).slice(0, 200)})`);
  await settle(3000);
  const roadCells = await roadHash(road.siteId, gy);
  check(roadCells.cells > 0, `the road owns ${roadCells.cells} cells`);
  return { gy, wall: await boxHash(w.min, w.max), road: roadCells, roadSite: road.siteId, roadAnswer: road };
}

// ------------------------------------------------------------------ in game: the flat items

steps['flat-owned'] = async () => {
  await ensure();
  const fx = await flatFixture();
  const { gy } = fx;
  const out = { gy, strokes: [] };
  check(fx.wall.blockEntities === 1 && fx.wall.air === 0, `the wall: ${21 - fx.wall.air} blocks, ${fx.wall.blockEntities} chest`);
  // item 2 and 3: NATURAL_ONLY strokes over the mounds, the road and the wall
  const natural = [...STROKES(gy), { kind: 'lower', shape: 'cylinder', at: [X0 + 15, gy + 3, Z0], radius: 8, strength: 8 }, { kind: 'melt', shape: 'sphere', at: [X0 + 15, gy + 2, Z0], radius: 6, strength: 2 },
    { kind: 'raise', shape: 'cylinder', at: [X0 + 15, gy, Z0 - 6], radius: 6, strength: 3 }, { kind: 'melt', shape: 'sphere', at: [X0 - 10, gy + 3, Z0 + 11], radius: 5, strength: 3 }];
  const done = [];
  for (const s of natural) {
    const v = await brush(s);
    out.strokes.push(v);
    check(!v.refused && v.state === 'PLACED' && v.brush === s.kind.toUpperCase(), `stroke ${s.kind} at ${s.at}: ${v.state ?? v.refused}, brush ${v.brush}, ${v.cellsWritten} cells`);
    if (v.region) done.push(v.region);
    const wh = await boxHash(WALL(gy).min, WALL(gy).max), rh = await roadHash(fx.roadSite, gy);
    check(wh.sha256 === fx.wall.sha256, `item 2: NATURAL_ONLY ${s.kind}: the player's wall unchanged (its blocks and the chest's contents)`);
    check(rh.sha256 === fx.road.sha256 && rh.cells === fx.road.cells, `item 3: ${s.kind}: 0 cells of the other owner's road written (its ${rh.cells} cells unchanged)`);
  }
  const meltSpikes = out.strokes[out.strokes.length - 1];
  check(meltSpikes.cellsWritten > 0, `MELT rounds off the stone spikes (${meltSpikes.cellsWritten} cells removed)`);
  const skippedOwned = out.strokes.reduce((a, v) => a + (v.cellsSkipped?.owned ?? 0), 0);
  const skippedCond = out.strokes.reduce((a, v) => a + (v.cellsSkipped?.condition ?? 0), 0);
  check(skippedOwned > 0 && skippedCond > 0, `the strokes met the road (${skippedOwned} owned cells skipped) and the wall (${skippedCond} cells failed the natural condition)`);
  // item 3 with another owner's stroke over gate:b's strokes: gate:b's cells are owned by another owner, never touched
  const before = await boxHash([X0 - 6, gy - 3, Z0 - 10], [X0 + 6, gy + 10, Z0 + 2]);
  const v = await brush({ kind: 'lower', shape: 'cylinder', at: [X0, gy + 4, Z0 - 4], radius: 6, strength: 4, owner: 'gate:c' });
  check(!v.refused && (v.cellsSkipped?.owned ?? 0) > 0, `item 3: another owner's stroke over gate:b's strokes skips their cells (owned ${v.cellsSkipped?.owned}, wrote ${v.cellsWritten})`);
  if (v.region) { await undo(v.region, 'gate:c'); }
  const after = await boxHash([X0 - 6, gy - 3, Z0 - 10], [X0 + 6, gy + 10, Z0 + 2]);
  check(after.sha256 === before.sha256, 'item 3: undone, gate:b\'s strokes stand as they were');
  // PLAYER_BLOCKS over the road (the bot is an operator): the road is another owner's entry, never touched
  const pb = await brush({ kind: 'lower', shape: 'cylinder', at: [X0 - 10, gy, Z0 - 8], radius: 5, strength: 3, destruction: 'player_blocks', actor: 'me' });
  const rh = await roadHash(fx.roadSite, gy);
  check(!pb.refused && rh.sha256 === fx.road.sha256 && (pb.cellsSkipped?.owned ?? 0) > 0, `item 3: PLAYER_BLOCKS over the road: 0 road cells written (owned skipped ${pb.cellsSkipped?.owned})`);
  if (pb.region) await undo(pb.region);
  for (const r of done.reverse()) await undo(r);
  spendZero();
  return out;
};

/** The five overlapping strokes, then their undo in `order` (stroke indexes); E-flat over the box. */
async function undoOrder(gy, order, box, snap, tag) {
  const regions = [];
  for (const s of STROKES(gy)) {
    const v = await brush(s);
    if (v.refused) throw new Error(`stroke refused: ${v.refused}`);
    regions.push(v.region);
  }
  // layering: cells of the first stroke that later strokes wrote over carry several entries
  let layered = 0, sampled = 0;
  for (let y = gy - 3; y <= gy + 8; y++) {
    for (const [x, z] of [[X0, Z0 - 4], [X0 - 2, Z0 - 2], [X0 + 2, Z0 - 5], [X0 - 4, Z0 - 2]]) {
      const st = await call('dev.journal.at', { x, y, z }).catch(() => null);
      const entries = (st?.stack ?? st?.entries ?? []).filter((e) => e.status === 'ACTIVE' || e.active);
      sampled++;
      if (new Set(entries.map((e) => e.site ?? e.group)).size >= 2) layered++;
    }
  }
  for (const i of order) await undo(regions[i]);
  const d = await diffBox(box, snap);
  check(d.mismatches === 0, `item 5 (${tag}): 5 overlapping strokes undone in the order ${order.map((i) => i + 1).join(', ')}: E-flat ${d.mismatches} (${json(d.classes)})`, d.sample);
  return { regions, layered, sampled, diff: d };
}

steps['flat-undo'] = async () => {
  await ensure();
  const fx = await flatFixture();
  const { gy } = fx;
  const box = [X0 - 30, gy - 6, Z0 - 30, X0 + 30, gy + 20, Z0 + 30];
  const snap = await snapBox(box, 'flat-undo');
  const out = { gy, orders: {} };
  out.orders.reverse = await undoOrder(gy, [4, 3, 2, 1, 0], box, snap, 'reverse');
  out.orders.forward = await undoOrder(gy, [0, 1, 2, 3, 4], box, snap, 'forward');
  out.orders.mixed = await undoOrder(gy, [2, 0, 4, 1, 3], box, snap, 'mixed');
  const lay = Object.values(out.orders).reduce((a, o) => a + o.layered, 0);
  check(lay > 0, `the strokes layered over each other (journal stacks of 2+ strokes on ${lay} sampled cells)`);
  spendZero();
  return out;
};

steps['flat-permission'] = async () => {
  await ensure();
  const fx = await flatFixture();
  const { gy } = fx;
  const w = WALL(gy);
  const at = [X0 + 15, gy + 3, Z0];
  const req = { kind: 'lower', shape: 'cylinder', at, radius: 8, strength: 8, destruction: 'player_blocks' };
  const list0 = (await call('dev.region.list')).regions?.length ?? 0;
  const a = await brush({ ...req, actor: 'none' });
  check(a.reason === 'PERMISSION', `item 4: PLAYER_BLOCKS without an actor refused PERMISSION (${a.refused})`);
  const who = (await call('dev.brush.perm')).name;
  const deop = await cmd(`/deop ${who}`);
  const perm = await call('dev.brush.perm');
  log(`  /deop @s: ${(deop.messages ?? []).join(' ')}; permission2 now ${perm.permission2} (${perm.name})`);
  const b = await brush({ ...req, actor: 'me' });
  if (b.region) await undo(b.region);
  check(b.reason === 'PERMISSION', `item 4: PLAYER_BLOCKS by a player without permission level 2 refused PERMISSION (${b.refused})`);
  await cmd(`/op ${who}`);
  check(perm.permission2 === false && (await call('dev.brush.perm')).permission2 === true, `the player's permission level 2 off (/deop) then on again (/op): ${perm.permission2} -> true`);
  const list1 = (await call('dev.region.list')).regions?.length ?? 0;
  const wh1 = await boxHash(w.min, w.max);
  check(list1 === list0 && wh1.sha256 === fx.wall.sha256, `item 4: the refused strokes wrote nothing (regions ${list0} -> ${list1}; the wall unchanged)`);
  const items0 = await itemsNear(X0 + 15, gy + 2, Z0);
  const c = await brush({ ...req, actor: 'me' });
  const wh2 = await boxHash(w.min, w.max);
  const items1 = await itemsNear(X0 + 15, gy + 2, Z0);
  check(!c.refused && c.state === 'PLACED' && wh2.air === 21 && wh2.blockEntities === 0, `item 4: with permission level 2 the wall is cleared (${wh2.air}/21 air, ${wh2.blockEntities} block entities; ${c.cellsWritten} cells)`);
  check(items1 === items0, `item 4: nothing dropped (item entities near: ${items0} -> ${items1})`);
  if (c.region) await undo(c.region);
  const wh3 = await boxHash(w.min, w.max);
  check(wh3.sha256 === fx.wall.sha256 && wh3.blockEntities === 1, `item 4: one undo restores the wall with its block entities (the chest and its contents: the hash with NBT equals)`);
  // the console's command path (no actor): PLAYER_BLOCKS passes
  const d = await brush({ ...req, actor: 'none', console: true, owner: 'architect:player' });
  check(!d.refused && d.state === 'PLACED', `the console's path reaches PLAYER_BLOCKS (${d.state ?? d.refused})`);
  if (d.region) await undo(d.region, 'architect:player');
  check((await boxHash(w.min, w.max)).sha256 === fx.wall.sha256, 'and its undo restores the wall');
  spendZero();
  return { gy, refused: [a, b], cleared: c, console: d, items: [items0, items1] };
};

steps['flat-misc'] = async () => {
  await ensure();
  await freshWorld(FLAT, FLAT_BASE, 'exact');
  const X = X0 + 80, Z = Z0 + 80;
  await tp(X + 0.5, 0, Z + 0.5);
  const gy = await groundAt(X, Z);
  await tp(X + 0.5, gy + 30, Z + 0.5);
  const out = { gy };
  await call('dev.placement.stats', { reset: true });
  // item 8: the same request and seed, twice (undone between): the same IR sha and cells
  const box = [X - 40, gy - 6, Z - 40, X + 40, gy + 20, Z + 40];
  const snap = await snapBox(box, 'flat-misc');
  const one = { kind: 'raise', shape: 'sphere', at: [X, gy, Z], radius: 10, strength: 4, seed: 7 };
  const a = await brush(one); await undo(a.region);
  const b = await brush(one); await undo(b.region);
  check(a.irSha === b.irSha && a.cellsWritten === b.cellsWritten && a.cellsWritten > 0, `item 8: the same request and seed give the same IR sha (${a.irSha?.slice(0, 12)}, ${b.irSha?.slice(0, 12)}) and ${a.cellsWritten} cells`);
  const c = await brush({ ...one, seed: 8 }); await undo(c.region);
  out.det = { a: a.irSha, b: b.irSha, otherSeed: c.irSha };
  // item 7: 10 radius-16 strokes, command to realised (BAR)
  const ms = [];
  for (let i = 0; i < 10; i++) {
    const v = await brush({ kind: i % 2 ? 'lower' : 'raise', shape: 'sphere', at: [X - 12 + (i % 5) * 6, gy, Z - 6 + Math.floor(i / 5) * 12], radius: 16, strength: 2, seed: i });
    ms.push(v.ms);
    if (v.region) await undo(v.region);
  }
  ms.sort((p, q) => p - q);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  out.latency = { ms, p50: q(0.5), p95: q(0.95), load1: os.loadavg()[0] };
  bar(q(0.5) <= 2000 && q(0.95) <= 5000, `item 7: radius-16 strokes, request to realised: p50 ${Math.round(q(0.5))} ms (<= 2 s), p95 ${Math.round(q(0.95))} ms (<= 5 s) over ${ms.length}; load ${os.loadavg()[0].toFixed(1)}`);
  const d = await diffBox(box, snap);
  check(d.mismatches === 0, `items 7 and 8: every stroke undone, E-flat ${d.mismatches}`, d.sample);
  // item 10: a survival-toggle world and another dimension refuse NOT_ALLOWED
  await call('dev.survival.set', { on: true });
  const s = await brush({ kind: 'raise', at: [X, gy, Z], radius: 4, strength: 2 });
  await call('dev.survival.set', { on: false });
  check(s.reason === 'NOT_ALLOWED', `item 10: refused NOT_ALLOWED in a survival-toggle world (${s.refused})`);
  const n = await brush({ kind: 'raise', at: [X, gy, Z], radius: 4, strength: 2, dimension: 'nether' });
  check(n.reason === 'NOT_ALLOWED', `item 10: refused NOT_ALLOWED outside the Overworld (${n.refused})`);
  const f1 = await brush({ kind: 'raise', at: [X, gy, Z], radius: 33, strength: 2 });
  const f2 = await brush({ kind: 'raise', at: [X, gy, Z], radius: 4, strength: 17 });
  const f3 = await brush({ kind: 'raise', at: [X, gy, Z], radius: 4, strength: 2, owner: null });
  check(f1.reason === 'FIELD_LIMIT' && f2.reason === 'FIELD_LIMIT' && f3.reason === 'FIELD_LIMIT', `radius 33, strength 17 and no owner refused FIELD_LIMIT (${[f1, f2, f3].map((x) => x.refused).join(' | ')})`);
  const far = await brush({ kind: 'raise', at: [X + 4000, gy, Z + 4000], radius: 4, strength: 2 });
  check(far.reason === 'NOT_LOADED', `a stroke over unloaded chunks refused NOT_LOADED (${far.refused})`);
  // the command path: /architect brush ... at x y z, then /architect brush undo
  const h0 = await boxHash([X - 8, gy - 4, Z - 8], [X + 8, gy + 8, Z + 8]);
  const r1 = await cmd(`/architect brush raise 5 3 cylinder at ${X} ${gy} ${Z}`);
  let mine = null;
  for (let i = 0; i < 240 && !mine; i++) {
    await sleep(500);
    const ls = (await call('dev.region.list')).regions ?? [];
    mine = ls.find((v) => v.owner === 'architect:player' && v.brush === 'RAISE' && v.state === 'PLACED');
  }
  const h1 = await boxHash([X - 8, gy - 4, Z - 8], [X + 8, gy + 8, Z + 8]);
  const r2 = await cmd('/architect brush undo');
  for (let i = 0; i < 240; i++) { const st = await call('dev.region.state', { region: mine?.id ?? 'x' }).catch(() => null); if (!st || st.view?.state === 'REMOVED') break; await sleep(500); }
  const h2 = await boxHash([X - 8, gy - 4, Z - 8], [X + 8, gy + 8, Z + 8]);
  check(!!mine && h1.sha256 !== h0.sha256 && h2.sha256 === h0.sha256, `the command: /architect brush raise 5 3 cylinder at ... made ${mine?.id} (owner architect:player), /architect brush undo removed it exactly (${(r1.messages ?? []).join(' ')} | ${(r2.messages ?? []).join(' ')})`);
  // item 12: the apitest apib check and a stroke through the public API
  const v = await api('apib');
  check(/^1\.(2[1-9]|[3-9]\d)\./.test(v.version) && v.brushes === true && v.kinds === 8 && v.shapes === 2 && v.destruction === 2 && v.permissionAppended === true && v.limits === '1-32/1-16',
    `item 12: apitest apib in game (${json(v)})`);
  const p = await apiResult(await api(`brush g1 raise ${X} ${gy} ${Z} 6 2`));
  const u = p.region ? await apiResult(await api(`brushundo g1 ${p.region}`)) : null;
  const h3 = await boxHash([X - 8, gy - 4, Z - 8], [X + 8, gy + 8, Z + 8]);
  check(p.state === 'PLACED' && p.brush === 'RAISE' && p.owner === 'apitest:b' && u?.removed === true && h3.sha256 === h0.sha256, `item 12: Regions.brush and remove through the public API (${json(p)}; ${json(u)})`);
  // item 9 on the flat strokes (BAR)
  const st = await call('dev.placement.stats');
  out.mspt = st;
  const cpu = st.placementCpuMsMax ?? st.cpuMsMax ?? st.maxMs;
  bar(cpu !== undefined && cpu <= 50 && (st.placementCpuMsP99 === undefined || st.placementCpuMsP99 <= 25), `item 9 (flat): Architect's own tick max ${cpu?.toFixed?.(1)} ms CPU <= 50, p99 ${st.placementCpuMsP99?.toFixed?.(1) ?? 'n/a'} <= 25 (load ${os.loadavg()[0].toFixed(1)})`);
  spendZero();
  return out;
};

steps.ingame = async () => {
  const parts = {};
  for (const s of ['flat-owned', 'flat-undo', 'flat-permission', 'flat-misc']) {
    log(`-- ${s}`);
    try { parts[s] = await steps[s](); } catch (e) { log(String(e?.stack ?? e)); check(false, `${s}: ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  return parts;
};

// ------------------------------------------------------------------ in game: S3's corner

/** Cells of an ARWD dump as a lookup: (x, y, z) -> block name (no properties). */
async function dumpOf(box, name) {
  const file = path.join(OUT, `${name}.arwd`);
  await call('dev.region.dump', { box, light: false, file }, 1_800_000);
  const { decodeArwd } = await imp('lib/region/vworld.mjs');
  const d = await decodeArwd(fs.readFileSync(file));
  return d;
}

steps.natural = async () => {
  await ensure();
  await freshWorld(NAT, SEED_BASE, 'exact');
  const S3 = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'relief_demo.json'), 'utf8')).fixture.claim;
  const X = S3[0] + 40, Z = S3[1] + 40;
  await tp(X + 0.5, 200, Z + 0.5);
  await call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  const gy = await groundAt(X, Z);
  await tp(X + 0.5, gy + 30, Z + 0.5);
  await call('dev.waitChunks', { timeoutMs: 120_000 }, 150_000).catch(() => {});
  await call('dev.placement.stats', { reset: true });
  const out = { at: [X, gy, Z] };
  // the strokes' reach plus 4 (the world's own changes further out, a spring flowing on freshly loaded chunks, are not the strokes')
  const box = [X - 24, gy - 34, Z - 24, X + 24, gy + 24, Z + 24];
  await settle(20_000); // pending fluid and block ticks of the freshly loaded chunks run first
  const snap = await snapBox(box, 'natural');
  // item 6: a cave carve under the ground, judged on the realised world
  const cy = gy - 14;
  const cave = { kind: 'cave_carve', shape: 'sphere', at: [X, cy, Z], radius: 14, strength: 8, seed: 11 };
  const vbox = [X - 18, cy - 18, Z - 18, X + 18, cy + 18, Z + 18];
  const d0 = await dumpOf(vbox, 'cave-before');
  const cv = await brush(cave);
  const d1 = await dumpOf(vbox, 'cave-after');
  out.cave = cv;
  check(!cv.refused && cv.state === 'PLACED' && cv.cellsWritten > 0, `item 6: the cave carve realised (${cv.cellsWritten} cells, skipped ${json(cv.cellsSkipped)})`);
  const m = caveJudge(d0, d1, vbox);
  out.caveJudge = m;
  check(m.carved > 0 && m.floating === 0, `item 6: M3 0 floating: ${m.floating} solid cells cut off by the carve (of ${m.carved} carved)`, m.floatingSample);
  check(m.breaches === 0, `item 6: M4 0 breaches: ${m.breaches} carved cells beside water or lava (26-neighbourhood), ${m.wetCarved} carved cells holding a fluid now`, m.breachSample);
  // five overlapping strokes and a melt on the surface, then everything undone in reverse
  const regions = [cv.region];
  for (const s of [...STROKES(gy).map((x) => ({ ...x, at: [x.at[0] - X0 + X, x.at[1], x.at[2] - Z0 + Z] })), { kind: 'melt', shape: 'sphere', at: [X + 6, gy + 2, Z + 6], radius: 8, strength: 2 }]) {
    const v = await brush(s);
    check(!v.refused && (v.state === 'PLACED' || v.state === 'PARTIAL'), `natural ${s.kind}: ${v.state ?? v.refused}, ${v.cellsWritten} cells, skipped ${json(v.cellsSkipped ?? {})}`);
    if (v.region) regions.push(v.region);
  }
  for (const r of regions.reverse()) await undo(r);
  const d = await diffBox(box, snap);
  out.enormal = d;
  const unclassified = d.classes.none ?? 0;
  check(unclassified === 0, `item 5: E-normal on S3's corner after 7 strokes undone: ${d.mismatches} mismatches, every one classified (${json(d.classes)})`, d.sample);
  const st = await call('dev.placement.stats');
  out.mspt = st;
  const cpu = st.placementCpuMsMax ?? st.cpuMsMax ?? st.maxMs;
  bar(cpu !== undefined && cpu <= 50 && (st.placementCpuMsP99 === undefined || st.placementCpuMsP99 <= 25), `item 9 (natural): Architect's own tick max ${cpu?.toFixed?.(1)} ms CPU <= 50, p99 ${st.placementCpuMsP99?.toFixed?.(1) ?? 'n/a'} <= 25 (load ${os.loadavg()[0].toFixed(1)})`);
  spendZero();
  return out;
};

/** M3/M4 on the realised world: the carved cells (solid before, air now), floating solid components beside them, fluids beside them. */
function caveJudge(d0, d1, box) {
  const name = (d, x, y, z) => {
    const b = d.box;
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ) return 'minecraft:void_air';
    return d.palette[d.cells[d.at(x, y, z)]].replace(/\[.*$/, '');
  };
  const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
  const FLUID = new Set(['minecraft:water', 'minecraft:lava', 'minecraft:bubble_column']);
  const solid = (d, x, y, z) => { const n = name(d, x, y, z); return !AIRS.has(n) && !FLUID.has(n); };
  const carved = [];
  for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) {
    if (solid(d0, x, y, z) && AIRS.has(name(d1, x, y, z))) carved.push([x, y, z]);
  }
  let breaches = 0, wetCarved = 0;
  const breachSample = [];
  for (const [x, y, z] of carved) {
    let wet = false;
    for (let a = -1; a <= 1 && !wet; a++) for (let b = -1; b <= 1 && !wet; b++) for (let c = -1; c <= 1 && !wet; c++) if (FLUID.has(name(d1, x + a, y + b, z + c))) wet = true;
    if (wet) { breaches++; if (breachSample.length < 10) breachSample.push([x, y, z]); }
  }
  for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) if (!FLUID.has(name(d0, x, y, z)) && FLUID.has(name(d1, x, y, z))) wetCarved++;
  // floating: solid components (6-connected) beside a carved cell that reach no face of the box
  const seen = new Set();
  let floating = 0;
  const floatingSample = [];
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const [x, y, z] of carved) {
    for (const [a, b, c] of N6) {
      const sx = x + a, sy = y + b, sz = z + c, k0 = `${sx},${sy},${sz}`;
      if (seen.has(k0) || !solid(d1, sx, sy, sz)) continue;
      const comp = [];
      const todo = [[sx, sy, sz]];
      seen.add(k0);
      let anchored = false;
      while (todo.length) {
        const [qx, qy, qz] = todo.pop();
        comp.push([qx, qy, qz]);
        if (qx <= box[0] || qx >= box[3] || qy <= box[1] || qy >= box[4] || qz <= box[2] || qz >= box[5]) anchored = true; // the whole component is walked
        for (const [d, e, f] of N6) {
          const k = `${qx + d},${qy + e},${qz + f}`;
          if (!seen.has(k) && solid(d1, qx + d, qy + e, qz + f)) { seen.add(k); todo.push([qx + d, qy + e, qz + f]); }
        }
      }
      if (!anchored) { floating += comp.length; if (floatingSample.length < 10) floatingSample.push(comp[0]); }
    }
  }
  return { carved: carved.length, breaches, wetCarved, floating, breachSample, floatingSample };
}

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'stale', 'apicompat', 'ingame', 'flat-owned', 'flat-undo', 'flat-permission', 'flat-misc', 'natural']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([m, r]) => !r.ok && !m.startsWith('BAR'));
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-B (terrain brushes)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cb.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
