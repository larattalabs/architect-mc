#!/usr/bin/env node
// Slice RP gate (realised provenance; docs/CONTRACT.md "RP as built") against the headless server of the RP run worktree (GATE6B_RUN,
// default `../architect-mc-rp-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6crp.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (rp-unit)              RealisedTest (every code from TileCheck's decision order, the draft, extras and causes, ARPR round
//                                      trips, layers, RS marks, a drained body's row, the hashes), the kit's rp.test (writers), api-compat
//     ingame    (rp-ingame)            rp_demo on a flat world with a held cell site, a player's cobblestone and torch, an oak, short grass
//                                      and a water source set up first: every code it should record, the extras with their causes, the
//                                      writers and shas against the kit's own evaluation, and an independent re-read of the world: every
//                                      WRITTEN or NOOP cell that is its key's last writer holds its intent, every skipped cell holds what
//                                      stood before; dev.region.realised verify (journal and world); the mod's audit lines
//     crash     (rp-crash)             kill points with a save: RP1+save (the record written, the PLACING commit not), RP2+save (a tile with
//                                      nothing to write: the record written, the item not placed), K2+save, RG4+save, K4+save, and RP1
//                                      without a save: after the restart the region completes and its record verifies (every tile committed,
//                                      none stale or unrecorded, the journal and the world agree)
//     audit                            the audit lines of a gate run's shards (ARCHITECT_RP_AUDIT dir): per step and region, ok or not
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-rp/<step>.json in the main checkout (GATE6CRP_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-rp-run');
process.env.GATE6B_OUT = process.env.GATE6CRP_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-rp');
process.env.GATE6B_SIDECAR_PORT ??= '8936';
process.env.GATE6B_DEV_PORT ??= '8937';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const OWNER = 'test:rp';
const FLAT = 'G6B Flat Base';
const CX = 9600, CZ = 9600;
/** rp_demo's claim (141 x 71): its zones south-west of the centre and its far tile east. */
const CLAIM = [CX - 40, CZ - 40, CX + 100, CZ + 30];
const CODES = ['WRITTEN', 'NOOP', 'HELD', 'BUILD', 'COND', 'FLUID', 'CLIP', 'UNFINISHED', 'KEPT', 'UNKNOWN', 'FLUID_EDGE', 'UNBREAKABLE', 'BUILD_SUPPORT'];

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice RP is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells

/** A dev.box.hash cell line's state as "minecraft:x[k=v,...]" (props sorted). */
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return props.length ? `${n}[${props.join(',')}]` : n;
}
/** A state string with its properties sorted (and minecraft: added). */
function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
/** Every cell of a box: Map "x,y,z" -> state. */
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
const k3 = (x, y, z) => `${x},${y},${z}`;
const posOf = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

async function groundY() {
  const c = await cellsOf([CX, -64, CZ, CX, 0, CZ]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'air' && y > g) g = y; }
  return g;
}

async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(CX, 40, CZ - 10);
}

/** The ARWR v1 writers (kit/lib/realise.mjs encodeWriters). */
function decodeWriters(b) {
  let o = 0;
  const u8 = () => b[o++];
  const varint = () => { let v = 0, s = 0, x; do { x = b[o++]; v += (x & 127) * 2 ** s; s += 7; } while (x & 128); return v; };
  if (b.length < 5 || Buffer.from(b.subarray(0, 4)).toString('latin1') !== 'ARWR') return null;
  o = 4; u8();
  const table = [];
  for (let n = varint(); n > 0; n--) { const len = varint(); const part = Buffer.from(b.subarray(o, o + len)).toString('utf8'); o += len; table.push({ part, ordinal: varint(), op: varint(), cond: u8() }); }
  const nCells = varint();
  const win = [];
  for (let r = varint(); r > 0; r--) { const t = varint(); const len = varint(); for (let i = 0; i < len; i++) win.push(t); }
  const losers = new Map();
  let prev = 0;
  for (let n = varint(); n > 0; n--) { const at = prev + varint(); prev = at; const k = varint(); const l = []; for (let i = 0; i < k; i++) l.push(varint()); losers.set(at, l); }
  return { table, win, losers, nCells };
}

/**
 * The setup the codes need (before the plan, so the plan's survey and the realise see the same land): a cell site over the held
 * zone, a player's cobblestone and torch in the build zone, an oak in the tree zone, short grass over the dep zone and a water source
 * beside the wet zone.
 */
async function setup(gy, Z) {
  const y0 = gy + 1;
  const z = (name) => { const [a, b, c, d] = Z[name]; return [CX + a, CZ + b, CX + c, CZ + d]; };
  const out = {};
  const [hx0, hz0, hx1, hz1] = z('held');
  const cells = [];
  for (let x = hx0; x <= hx1; x++) for (let zz = hz0; zz <= hz1; zz++) cells.push([x, y0, zz, 'minecraft:oak_planks']);
  out.held = await call('dev.cells.place', { kind: 'test:rp_held', cells, naturalOnly: false }, 300_000);
  const [bx0, bz0] = z('build');
  out.build = await call('dev.pt.uses', { ops: [
    { item: 'minecraft:cobblestone', at: [bx0, y0, bz0], on: [bx0, gy, bz0], face: 'up', placer: 'RPPlayer' },
    { item: 'minecraft:torch', at: [bx0 + 2, y0, bz0 + 2], on: [bx0 + 2, gy, bz0 + 2], face: 'up', placer: 'RPPlayer' },
  ] }, 120_000);
  // the two blocks a kept build (a lone block may be classed incidental, which writes may take as natural)
  out.claim = await call('dev.pt.claim', { box: [bx0, y0, bz0, bx0 + 2, y0, bz0 + 2], actor: 'RPPlayer' }, 120_000);
  const [tx0, tz0, tx1, tz1] = z('tree');
  const tc = [(tx0 + tx1) >> 1, (tz0 + tz1) >> 1];
  out.tree = await cmd(`/place feature minecraft:oak ${tc[0]} ${y0} ${tc[1]}`);
  const [dx0, dz0, dx1, dz1] = z('dep');
  out.dep = await cmd(`/fill ${dx0} ${y0} ${dz0} ${dx1} ${y0} ${dz1} minecraft:short_grass`);
  const [, wz0, wx1, wz1] = z('wet');
  out.wet = await cmd(`/setblock ${wx1 + 1} ${gy} ${(wz0 + wz1) >> 1} minecraft:water`);
  out.trunk = tc;
  await L.settle(2000);
  return out;
}

async function planDemo() {
  const p = await L.plan('rp_demo', CLAIM, { params: { cx: CX, cz: CZ }, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const ir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId, 'ir.json'), 'utf8'));
  return { ...p, ir };
}

async function realised(region, opts = {}) {
  return call('dev.region.realised', { region, ...opts }, 1_800_000);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B RP Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

// ------------------------------------------------------------------ offline

async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}
function nodeTest(files, timeout = 3_600_000) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20) };
}

steps.unit = async () => {
  const out = {};
  out.java = await javaTests(['*RealisedTest*', '*TileGravityTest*'], 18);
  check(out.java.ok, `RealisedTest (each code from TileCheck's decision order: a held cell, a player build, an unbreakable block, a failed condition, a no-op, a write; the fluids gate's FLUID cells and the causes over the tile as evaluated; a felled tree's TREE extras and their LEAF with their cause, dependents; ARPR v1 round trips, its CRC, layers as separate files, RS's UNFINISHED marks; a drained body's row in sites.json; the chain and composed hashes) and TileGravityTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  out.kit = nodeTest(['kit/test/rp.test.mjs']);
  check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 2, `kit rp.test: evalTile's writers leave the payload and its sha unchanged, the winners are cellOps', every op that wrote a cell alone is its winner or among its losers (oldest first), encodings byte-identical: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs'], { cwd: root, encoding: 'utf8', timeout: 900_000, env: { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` } });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
  check(ac.status === 0, 'api-compat: the API unchanged against the archived apitest jars', out.apicompat.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game: every code, re-read independently

steps.ingame = async () => {
  await ensure();
  const out = {};
  const R = await imp('lib/realise.mjs');
  const { unpack } = await imp('lib/region/pack.mjs');
  const { synthColumns } = await imp('lib/region/synth.mjs');
  const { ZONES } = await imp('regions/rp_demo.mjs');
  await freshFlat('G6B RP Codes');
  const gy = await groundY();
  const y0 = gy + 1;
  out.gy = gy;
  const auditDir = path.join(OUT, 'audit-ingame');
  fs.rmSync(auditDir, { recursive: true, force: true });
  await call('dev.region.realised.audit', { dir: auditDir }, 10_000);
  out.setup = await setup(gy, ZONES);
  check(out.setup.held?.placed && out.setup.build?.results?.every((r) => r.tracked) && out.setup.claim?.state === 'CLAIMED' && out.setup.tree?.success !== false, `the setup: a cell site over the held zone (${out.setup.held?.siteId}), a player's cobblestone and torch (PT tracked: ${json(out.setup.build?.results?.map((r) => r.tracked))}, claimed ${out.setup.claim?.buildId} ${out.setup.claim?.state}), an oak (${json(out.setup.tree?.messages)}), short grass, a water source`, out.setup);
  const box = [CX - 32, gy - 2, CZ - 32, CLAIM[2], gy + 14, CZ + 2];
  const pre = await cellsOf(box);
  const p = await planDemo();
  await cmd('/kill @e[type=!minecraft:player]');
  const region = await L.realise(p.planId);
  const st = await L.waitRegion(region, 3_600_000);
  out.state = st.view.state;
  check(st.view.state === 'PLACED', `rp_demo realised: ${st.view.state}, ${st.view.cellsWritten} cells`);
  const rv = await realised(region, { cells: true, verify: true });
  const world = await cellsOf(box);
  out.verify = rv.verify;
  check(rv.verify.ok && rv.verify.unrecorded === 0 && rv.verify.notHeld === 0, `dev.region.realised verify: ${rv.verify.files} records, status ${json(rv.verify.status)}, ${rv.verify.cellsChecked} entry cells (${rv.verify.held} hold their write, ${rv.verify.coveredLater} covered later, ${rv.verify.notHeld} not), unrecorded ${rv.verify.unrecorded}`, rv.verify.problems);
  // the kit's own evaluation of each tile, against the record (sha and writers byte for byte), then the world, cell by cell
  const order = (t) => p.ir.stages.indexOf(t.stage) * 2 + (t.set === 'path' ? 1 : 0);
  const tiles = [...rv.tiles].sort((a, b) => order(a) - order(b));
  const evals = [];
  let shaOk = 0, wrOk = 0;
  for (const t of tiles) {
    const [tx, tz] = t.key.split(',').map(Number);
    const win = synthColumns({ minX: tx * 64 - 8, minZ: tz * 64 - 8, width: 80, depth: 80, world: () => ({ g: gy, h: gy, f: gy, flags: 0 }) });
    const e = R.evalTile(p.ir, t.key, win, { stage: t.stage, set: t.set, writers: true });
    const wr = Buffer.from(R.encodeWriters(p.ir, e)).toString('base64');
    if (e.sha === t.tileSha) shaOk++;
    if (wr === t.writersB64) wrOk++;
    evals.push({ t, cells: unpack(e.payload).cells, writers: decodeWriters(Buffer.from(t.writersB64, 'base64')) });
  }
  check(shaOk === tiles.length && wrOk === tiles.length, `every record's tile sha and writers equal the kit's own evaluation of its tile (sha ${shaOk}/${tiles.length}, writers ${wrOk}/${tiles.length})`);
  // the last writer of each position (WRITTEN or NOOP), in write order; every extra
  const last = new Map();
  const extras = new Map();
  for (const ev of evals) {
    ev.cells.forEach((c, i) => { const code = ev.t.codeList[i]; if (code === 0 || code === 1) last.set(k3(c.x, c.y, c.z), { ev, i, state: c.state }); });
    for (const x of ev.t.extraList) extras.set(k3(...x.pos), x);
  }
  let checked = 0, bad = 0, coincide = 0;
  const badList = [];
  const byZone = {};
  const zoneOf = (x, z) => { for (const [n, [a, b, c, d]] of Object.entries(ZONES)) if (x >= CX + a && x <= CX + c && z >= CZ + b && z <= CZ + d) return n; return x > CX + 40 ? 'far' : 'other'; };
  for (const ev of evals) {
    ev.cells.forEach((c, i) => {
      const code = ev.t.codeList[i];
      const k = k3(c.x, c.y, c.z);
      const now = world.get(k);
      if (now === undefined) return;
      const zn = zoneOf(c.x, c.z);
      byZone[zn] ??= {};
      byZone[zn][CODES[code]] = (byZone[zn][CODES[code]] ?? 0) + 1;
      let ok;
      if (code === 0 || code === 1) {
        const top = last.get(k);
        if (top.ev !== ev || top.i !== i) return; // a later writer's cell
        ok = norm(now) === norm(c.state);
      } else {
        if (last.has(k) || extras.has(k)) return; // written by another writer, or by this tile as an extra
        ok = norm(now) === norm(pre.get(k));
        if (norm(now) === norm(c.state)) coincide++;
      }
      checked++;
      if (!ok) { bad++; if (badList.length < 16) badList.push(`${ev.t.stage}/${ev.t.set}/${ev.t.key} ${CODES[code]} ${k} now ${now} intent ${c.state} before ${pre.get(k)}`); }
    });
  }
  let exBad = 0;
  for (const [k, x] of extras) {
    const now = world.get(k);
    const ok = x.kind === 'LEAF' ? /leaves\[.*persistent=true/.test(now) : x.kind === 'DEPENDENT_WET' ? /water/.test(now) : idOf(now) === 'air';
    if (!ok) { exBad++; if (badList.length < 24) badList.push(`extra ${x.kind} ${k} now ${now}`); }
  }
  out.reread = { checked, bad, coincide, extras: extras.size, exBad, byZone };
  check(bad === 0 && exBad === 0 && checked > 500, `the independent re-read: ${checked} cells (every WRITTEN or NOOP cell that is its position's last writer holds its intent; every skipped cell no writer took holds what stood before), ${bad} wrong; ${extras.size} extras hold what the tile wrote, ${exBad} wrong; ${coincide} skipped cells happened to hold their intent already (recorded)`, badList);
  // every code this fixture should record, where it should record it
  const has = (zn, code, min = 1) => (byZone[zn]?.[code] ?? 0) >= min;
  const all = tiles.reduce((a, t) => { for (const [c, n] of Object.entries(t.codes)) a[c] = (a[c] ?? 0) + n; return a; }, {});
  out.codes = all;
  check(has('noop', 'NOOP', 25) && Object.keys(byZone.noop).length === 1, `NOOP: the noop zone's 25 cells (grass over grass) ${json(byZone.noop)}`);
  check(has('cond', 'COND', 25) && Object.keys(byZone.cond).length === 1, `COND: the cond zone's 25 cells (IF_AIR_OR_FLUID over grass) ${json(byZone.cond)}`);
  check(has('held', 'HELD', 25), `HELD: the held zone's 25 cells (a cell site's planks there first) ${json(byZone.held)}`);
  check(has('build', 'BUILD', 2) && has('build', 'BUILD_SUPPORT', 1), `BUILD and BUILD_SUPPORT: the player's cobblestone and torch cells, and the grass holding the torch up ${json(byZone.build)}`);
  check(has('wet', 'FLUID_EDGE', 1), `FLUID_EDGE: the wet zone's cell beside the water source ${json(byZone.wet)}`);
  check(has('pad', 'WRITTEN', 121), `WRITTEN: the pad's 121 cells ${json(byZone.pad)}`);
  const exk = {};
  for (const x of extras.values()) exk[x.kind] = (exk[x.kind] ?? 0) + 1;
  out.extras = exk;
  // causes: every TREE and LEAF extra caused by a trunk cell the tile wrote; every DEPENDENT by a dep zone cell
  let causeBad = 0;
  for (const ev of evals) for (const x of ev.t.extraList) {
    const c = x.cause >= 0 ? ev.cells[x.cause] : null;
    const zn = c ? zoneOf(c.x, c.z) : null;
    if ((x.kind === 'TREE' || x.kind === 'LEAF') && !(zn === 'tree' && ev.t.codeList[x.cause] === 0 && idOf(pre.get(k3(c.x, c.y, c.z))).endsWith('_log'))) causeBad++;
    if (x.kind === 'DEPENDENT' && !(zn === 'dep' && ev.t.codeList[x.cause] === 0)) causeBad++;
  }
  check((exk.TREE ?? 0) >= 1 && (exk.LEAF ?? 0) >= 1 && (exk.DEPENDENT ?? 0) >= 25 && causeBad === 0, `extras with their cause: the felled trunk (TREE ${exk.TREE ?? 0}) and its held leaves (LEAF ${exk.LEAF ?? 0}) caused by the trunk cells the tree zone wrote; the short grass (DEPENDENT ${exk.DEPENDENT ?? 0}) by the dep zone's cells; ${causeBad} wrong causes`, exk);
  // the writers: the pad's west 5 columns' bricks lost to the andesite (55 loser cells)
  const padTile = evals.filter((ev) => ev.t.stage === 'ground' && ev.t.set === 'terrain');
  let losers = 0, loserOk = 0;
  for (const ev of padTile) for (const [i, l] of ev.writers.losers) { losers++; const w = ev.writers.table[ev.writers.win[i]]; const lo = l.map((t) => ev.writers.table[t]); if (w.part === 'rp_base' && lo.length === 1 && lo[0].part === 'rp_base' && lo[0].ordinal < w.ordinal && /polished_andesite/.test(ev.cells[i].state)) loserOk++; }
  out.writers = { losers, loserOk };
  check(losers === 55 && loserOk === 55, `writers: the pad's west 5 x 11 cells name the andesite op as winner and the brick op (earlier in rp_base) as their loser: ${loserOk}/${losers}`);
  // a tile with nothing to write (the far zone): a record without an entry, every cell NOOP
  const far = tiles.find((t) => t.site === '');
  check(!!far && far.status === 'committed' && far.codes.NOOP === 25 && Object.keys(far.codes).length === 1, `a tile with nothing to write: ${far ? `${far.key} no entry, ${json(far.codes)}, ${far.status}` : 'none'}`);
  // the hashes: each record's chain over its key's writers; the composed hash of a key is its last writer's chain
  const crypto = await import('node:crypto');
  let chainOk = 0;
  for (const t of tiles) {
    const lines = [];
    for (const s of p.ir.stages) for (const set of ['terrain', 'path']) {
      if (!(p.ir.tiles[s][set] ?? []).includes(t.key)) continue;
      const w = tiles.find((x) => x.stage === s && x.set === set && x.key === t.key);
      lines.push(`${s}\t${set}\t${w ? w.tileSha : '-'}\n`);
      if (s === t.stage && set === t.set) break;
    }
    if (crypto.createHash('sha256').update(lines.join('')).digest('hex') === t.chainSha) chainOk++;
  }
  const multi = Object.entries(rv.composedSha).filter(([k]) => tiles.filter((t) => t.key === k).length > 1);
  check(chainOk === tiles.length && multi.length >= 1 && multi.every(([k, c]) => c === tiles.filter((t) => t.key === k).sort((a, b) => order(b) - order(a))[0].chainSha), `hashes: every record's chain sha over its key's writers in write order (${chainOk}/${tiles.length}); ${multi.length} key(s) with several writers, each composed sha its last writer's chain`);
  // sizes
  out.sizes = tiles.map((t) => ({ tile: `${t.stage}/${t.set}/${t.key}`, cells: t.cells, bytes: t.bytes, diskBytes: t.diskBytes, writersBytes: t.writersBytes }));
  // the mod's audit lines for this region
  const lines = fs.existsSync(auditDir) ? fs.readdirSync(auditDir).flatMap((f) => fs.readFileSync(path.join(auditDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [];
  const mine = lines.filter((l) => l.region === region);
  out.audit = mine;
  check(mine.length >= tiles.length && mine.every((l) => l.ok), `the mod's audit (each tile re-read right after its commit, then the region at its batch's end): ${mine.length} lines, ${mine.filter((l) => !l.ok).length} not ok`, mine.filter((l) => !l.ok).slice(0, 4));
  await call('dev.region.realised.audit', { on: false }, 10_000);
  // invisible to the plan and the view: the view and the IR carry no realised member
  check(!JSON.stringify(st.view).includes('realised') && !JSON.stringify(p.ir).includes('realised'), 'the record stays out of the region view and the IR');
  await L.leaveWorld();
  return out;
};

// ------------------------------------------------------------------ crash: the record against the journal after a halt

steps.crash = async () => {
  await ensure();
  const out = {};
  for (const point of ['RP1+save', 'RP2+save', 'K2+save', 'RG4+save', 'K4+save', 'RP1']) {
    const tag = point.replace('+', '_');
    const world = `G6B RP Crash ${tag}`;
    await freshFlat(world);
    const p = await planDemo();
    await call('dev.journal.killAt', { point }, 10_000);
    let region = null;
    L.realise(p.planId).then((r) => { region = r; }).catch(() => null);
    let down = false;
    for (let i = 0; i < 180 && !down; i++) {
      await sleep(2000);
      const s = await call('dev.state', {}, 10_000).catch(() => null);
      down = !!s && s.inWorld === false;
    }
    check(down, `${point}: the kill point halted the server`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
    // the record on disk right after the halt (before the restart touches it): read from the world's files
    const regionsDir = path.join(L.SAVES, world, 'architect-regions');
    const rid = region ?? fs.readdirSync(regionsDir).filter((d) => fs.existsSync(path.join(regionsDir, d, 'region.json'))).sort().at(-1);
    const recDir = path.join(regionsDir, rid, 'realised', 'L0');
    const atHalt = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.bin')) : [];
    await L.openWorld(world);
    await L.tp(CX, 40, CZ - 10);
    const st = await L.waitRegion(rid, 3_600_000);
    const rv = await realised(rid, { verify: true });
    const v = rv.verify;
    out[tag] = { region: rid, atHalt, state: st.view.state, status: v.status, unrecorded: v.unrecorded, notHeld: v.notHeld, cellsChecked: v.cellsChecked, problems: v.problems.slice(0, 8), tiles: rv.tiles.map((t) => [t.stage, t.set, t.key, t.site, t.status]) };
    const allCommitted = Object.keys(v.status).every((s) => s === 'committed');
    check(st.view.state === 'PLACED' && v.ok && allCommitted && rv.tiles.length === 5, `${point}: ${atHalt.length} record(s) on disk at the halt; after the restart the region ${st.view.state}, ${rv.tiles.length} records all committed (${json(v.status)}), unrecorded ${v.unrecorded}, the journal and the world agree over ${v.cellsChecked} cells (${v.notHeld} not held)`, v.problems);
    if (point === 'RP1+save') {
      // the record of the tile that halted was written for a site whose commit never happened: rewritten for the site that did
      check(atHalt.length >= 1, `${point}: the halted tile's record was on disk before its PLACING commit (${atHalt.join(', ')})`);
    }
    await L.leaveWorld();
  }
  return out;
};

// ------------------------------------------------------------------ the audit of a gate run (ARCHITECT_RP_AUDIT)

steps.audit = async () => {
  const dir = process.argv[3] ?? process.env.ARCHITECT_RP_AUDIT;
  if (!dir || !fs.existsSync(dir)) throw new Error(`no audit dir (${dir})`);
  const lines = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => ({ file: f, ...JSON.parse(l) })));
  const tiles = lines.filter((l) => l.tile);
  const regions = lines.filter((l) => l.kind === 'region');
  const codes = {}, extras = {};
  let bytes = 0, cells = 0, wbytes = 0, fluidMoved = 0, coincide = 0;
  for (const t of tiles) {
    for (const [c, n] of Object.entries(t.codes ?? {})) codes[c] = (codes[c] ?? 0) + n;
    for (const [c, n] of Object.entries(t.extras ?? {})) extras[c] = (extras[c] ?? 0) + n;
    bytes += t.bytes; cells += t.cells; wbytes += t.writers; fluidMoved += t.fluidMoved; coincide += t.coincide;
  }
  const sizes = tiles.map((t) => t.bytes).sort((a, b) => a - b);
  const q = (f) => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(f * sizes.length))] : 0;
  const out = { tiles: tiles.length, tilesOk: tiles.filter((t) => t.ok).length, regions: regions.length, regionsOk: regions.filter((r) => r.ok).length, codes, extras, cells, bytes, writersBytes: wbytes, fluidMoved, coincide,
    perTile: { mean: tiles.length ? Math.round(bytes / tiles.length) : 0, p50: q(0.5), p90: q(0.9), max: sizes.at(-1) ?? 0 }, per1000Tiles: tiles.length ? Math.round(1000 * bytes / tiles.length) : 0,
    notOk: [...tiles.filter((t) => !t.ok), ...regions.filter((r) => !r.ok)].slice(0, 12), regionLines: regions.map((r) => ({ region: r.region, state: r.state, ok: r.ok, files: r.files, bytes: r.bytes, status: r.status, unrecorded: r.unrecorded, cellsChecked: r.cellsChecked, notHeld: r.notHeld, coveredLater: r.coveredLater, bodies: r.bodies, lots: r.lots, roads: r.roads, problems: (r.problems ?? []).slice(0, 4) })) };
  check(out.tiles > 0 && out.tilesOk === out.tiles, `the audit: ${out.tilesOk}/${out.tiles} tiles re-read right after their commit match their record (codes ${json(codes)}, extras ${json(extras)}; ${fluidMoved} skipped fluid cells moved, ${coincide} skipped cells already held their intent)`, out.notOk);
  check(out.regions > 0 && out.regionsOk === out.regions, `the audit: ${out.regionsOk}/${out.regions} regions verified at their batch's end (journal and world)`, out.regionLines.filter((r) => !r.ok));
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|ingame|crash|audit)\.json$/.test(f));
  const lines = ['# Gate slice RP', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6crp.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
