#!/usr/bin/env node
// Slice 6d LC gate (land change in a standing region, the report; docs/CONTRACT.md "Phase 6d slice LC" §4) against the headless server of
// the LC run worktree (GATE6B_RUN, default `../architect-mc-LC-run`; the sim sidecar, no Claude). $0: no Claude call anywhere.
//
//   node tools/gate6dlc.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (lc-unit)              item 1 offline: LandCheckTest (the ARTL order against a real kit tile, part attribution of a synthetic
//                                      record and its writers, extras by cause, legacy and inconsistent records unattributed, every class, a
//                                      gate mechanism's dynamic state), ApiLCTest, RealisedTest; api-compat against the 0.47.0, 0.45.0 and
//                                      0.44.0 apitest jars and the 0.47.0 mod surface
//     ingame    (lc-ingame)            items 2 and 3 in game on rv-ingame's flat town (flat_village, pads): the fresh town reports no change;
//                                      a player breaks 40 square cells, breaks and re-places 12 cells (6 lane, 6 verge: cobblestone), the console removes
//                                      20 verge cells and swaps 6 square cells (sponge); landCheck's removed / playerPlaced / changed / kinds per part
//                                      equal the driver's own diff attributed by the kit's writers; then a revision (a mound and a spire)
//                                      is damaged the same way and its parts report it; every landCheck writes nothing (the claim's hash and
//                                      every file of the region's dir and the journal unchanged; two calls equal)
//     nowrite   (lc-nowrite)           the write-nothing proof alone (the verifier's re-run): a fresh town, damaged, then landCheck x3 with
//                                      the hash and file listings before and after each
//     castle    (lc-castle)            (LCi) items 1 and 2 on gm_castle_13x7: the gate's states, a player's lane block, a mined piston,
//                                      the wall's and a tower's cells (tools/lib/gate6dlc-2.mjs)
//     survival  (lc-survival)          (LCi) item 3 on rs02_walled: mid-build and fully built, a waiting cell, paid blocks, a lot cell
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6d-lc/<step>.json in the main checkout (GATE6DLC_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
// Ports: 8900/8901 (LC's pair).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-LC-run');
process.env.GATE6B_OUT = process.env.GATE6DLC_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6d-lc');
process.env.GATE6B_SIDECAR_PORT ??= '8900';
process.env.GATE6B_DEV_PORT ??= '8901';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const OWNER = 'test:lc';
const FLAT = 'G6B Flat Base';
const CX = 11200, CZ = 11200;
/** rv-ingame's town: 112 x 112 (D3's flat_village fixture shape), its lots pads (no entries). */
const CLAIM = [CX, CZ, CX + 111, CZ + 111];
const LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];
const MOUND = (rid) => ({ id: `mound${rid}`, call: { fn: 'columns', cols: [CX + 96, CZ + 92, 0, 1, 0, CX + 97, CZ + 92, 0, 2, 0, CX + 98, CZ + 93, 0, 0, 0], from: { surface: 1 }, to: { surface: 1 }, materials: ['rock'], cond: 0 } });
const SPIRE = (gy) => ({ id: 'spire', call: { fn: 'form', generator: 'rockSpire', params: { at: [CX + 100, gy, CZ + 20], height: [10, 12] } } });

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice LC is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells (as gate6drv's)

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return norm(props.length ? `${n}[${props.join(',')}]` : n);
}
const idOf = (s) => String(s).replace(/\[.*$/, '');
const AIRS = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava']);
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
const get = (m, k) => m.get(k) ?? 'minecraft:air';

async function groundY() {
  const c = await cellsOf([CX + 100, -64, CZ + 100, CX + 100, 255, CZ + 100]);
  let g = -64;
  for (const [k, s] of c) { const y = Number(k.split(',')[1]); if (idOf(s) !== 'minecraft:air' && y > g) g = y; }
  return g;
}

async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(CX + 56, 60, CZ + 56);
}

async function town() {
  const p = await L.plan('flat_village', CLAIM, { params: { lots: LOTS }, surveyLoad: 'bounded:256', check: false, owner: OWNER });
  const region = await L.realise(p.planId, { load: 'bounded:512' });
  const st = await L.waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `the town ${region}: ${st.view.state}, ${st.view.cellsWritten} cells`);
  return { region, p, st };
}

// ------------------------------------------------------------------ the attribution oracle (independent of LandCheck's code)

/**
 * The region's own written cells and their parts, from the kit alone: every tile of the IR evaluated with its writers (evalTile
 * {writers: true}, the flat world's heights) stage by stage and set by set over the snapshot, each cell's condition tested as the virtual
 * world does, a no-op skipped; a written cell's part is its winning op's IR part (compileIR), the last writer winning.
 */
async function partsOracle(ir, snapshot, gy) {
  const R = await imp('lib/realise.mjs');
  const { unpack } = await imp('lib/region/pack.mjs');
  const { synthColumns } = await imp('lib/region/synth.mjs');
  const { Palette } = await imp('lib/region/vworld.mjs');
  const C = R.compileIR(ir);
  const pal = new Palette();
  // (LCi) `snapshot`: a Map of the box, or a getter (a decoded dump's lookup); `exp` holds the written cells over it
  const base = typeof snapshot === 'function' ? snapshot : (k) => snapshot.get(k);
  const exp = typeof snapshot === 'function' ? new Map() : new Map(snapshot);
  const at = (k) => (exp.has(k) ? exp.get(k) : base(k));
  const ours = new Set();
  const part = new Map();
  const air = 'minecraft:air';
  for (const stage of ir.stages) for (const set of ['terrain', 'path']) for (const key of ir.tiles?.[stage]?.[set] ?? []) {
    const [tx, tz] = key.split(',').map(Number);
    const win = synthColumns({ minX: tx * 64 - 8, minZ: tz * 64 - 8, width: 80, depth: 80, world: () => ({ g: gy, h: gy, f: gy, flags: 0 }) });
    const e = R.evalTile(ir, key, win, { stage, set, writers: true });
    const cells = unpack(e.payload).cells;
    cells.forEach((c, i) => {
      const k = `${c.x},${c.y},${c.z}`;
      const cur = pal.of(at(k) ?? air);
      let ok;
      switch (c.cond) {
        case 1: ok = pal.natural[cur] && !pal.air[cur] && !pal.fluid[cur] && pal.solid[cur]; break;
        case 2: ok = pal.air[cur] || pal.fluid[cur]; break;
        case 3: ok = ours.has(k) || pal.natural[cur]; break;
        default: ok = pal.natural[cur];
      }
      if (!ok || norm(at(k) ?? air) === norm(c.state)) return;
      exp.set(k, norm(c.state));
      ours.add(k);
      part.set(k, String(C.parts[C.ops[e.cellOps[i]].part].id));
    });
  }
  return { part, exp };
}

async function landCheck(region, part = null) {
  const r = await call('dev.region.landCheck', { region, ...(part ? { part } : {}) }, 900_000);
  if (r.refused) throw new Error(`landCheck ${region}: ${r.refused}`);
  log(`  landCheck ${region}${part ? ` part ${part}` : ''}: ${r.parts.length} parts, ${r.cellsChecked} cells, ${r.unloaded} unloaded, ${r.ms} ms; ${json(r.parts.filter((p) => p.changed + p.removed + p.playerPlaced + p.volatileChanged).map((p) => [p.part, p.removed, p.playerPlaced, p.changed, p.volatileChanged]))}`);
  return r;
}
const strip = (r) => { const { id, type, ok, ms, ...rest } = r; void id; void type; void ok; void ms; return rest; };

/** Every file under a dir: relative path -> size and sha256 (missing dir: empty). */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const b = fs.readFileSync(p); out[path.relative(dir, p)] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}`; }
    }
  };
  walk(dir);
  return out;
}
function listDiff(a, b) {
  const d = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(`${k}: ${a[k] ?? '-'} -> ${b[k] ?? '-'}`);
  return d;
}

/** landCheck between two hashes of the box and two listings of the region's dir and the journal: nothing written. */
async function noWrite(region, box, worldDir, label) {
  const dirs = [path.join(worldDir, 'architect-regions', region), path.join(worldDir, 'architect-journal')];
  await call('dev.wait', { ms: 1500 }, 30_000);
  const h0 = await hashOf(box);
  const l0 = dirs.map(listing);
  const a = await landCheck(region);
  const b = await landCheck(region);
  const h1 = await hashOf(box);
  const l1 = dirs.map(listing);
  const diffs = dirs.map((d, i) => listDiff(l0[i], l1[i]));
  const files = l0.reduce((n, l) => n + Object.keys(l).length, 0);
  const same = json(strip(a)) === json(strip(b));
  check(h0 === h1 && diffs.every((d) => d.length === 0) && same && files > 0, `${label}: two landChecks wrote nothing: the claim + 8's hash ${h0 === h1 ? 'unchanged' : 'MOVED'}, ${files} files of the region's dir and the journal unchanged (${diffs.flat().length} differ), the two reports equal: ${same}`, { diffs, h0, h1 });
  return a;
}

/** The driver's diff between two snapshots, attributed by the oracle and classified as landCheck must (§2). */
function expectedOf(s1, s2, part, placed) {
  const byPart = {};
  const stray = [];
  for (const k of new Set([...s1.keys(), ...s2.keys()])) {
    const a = norm(get(s1, k)), b = norm(get(s2, k));
    if (a === b) continue;
    const p = part.get(k);
    if (!p) { stray.push(`${k} ${a} -> ${b}`); continue; }
    const e = (byPart[p] ??= { removed: 0, playerPlaced: 0, changed: 0, kinds: {} });
    if (placed.has(k)) e.playerPlaced++;
    else if (AIRS.has(idOf(b))) e.removed++;
    else { e.changed++; e.kinds[idOf(b)] = (e.kinds[idOf(b)] ?? 0) + 1; }
  }
  return { byPart, stray };
}

/** landCheck's numbers per part against the driver's (every other part of `among` unchanged against `base`, or zero). */
function compare(label, rep, exp, among, base = null) {
  const rows = {};
  let bad = 0;
  for (const p of rep.parts) {
    const e = exp.byPart[p.part];
    const b0 = base?.parts.find((q) => q.part === p.part);
    const want = e ? { removed: e.removed + (b0?.removed ?? 0), playerPlaced: e.playerPlaced + (b0?.playerPlaced ?? 0), changed: e.changed + (b0?.changed ?? 0), volatileChanged: b0?.volatileChanged ?? 0 }
      : { removed: b0?.removed ?? 0, playerPlaced: b0?.playerPlaced ?? 0, changed: b0?.changed ?? 0, volatileChanged: b0?.volatileChanged ?? 0 };
    const got = { removed: p.removed, playerPlaced: p.playerPlaced, changed: p.changed, volatileChanged: p.volatileChanged };
    let ok = json(got) === json(want);
    if (e && ok) {
      const wk = { ...(b0?.kinds ?? {}) };
      for (const [k, v] of Object.entries(e.kinds)) wk[k] = (wk[k] ?? 0) + v;
      ok = json(Object.fromEntries(Object.entries(p.kinds).sort())) === json(Object.fromEntries(Object.entries(wk).sort()));
    }
    if (!ok) bad++;
    if (e || !ok) rows[p.part] = { got, want, kinds: p.kinds, ok };
  }
  for (const p of Object.keys(exp.byPart)) if (!rep.parts.some((q) => q.part === p)) { bad++; rows[p] = { missing: true, want: exp.byPart[p] }; }
  check(bad === 0 && exp.stray.length === 0, `${label}: landCheck's removed / playerPlaced / changed / kinds per part equal the driver's diff attributed by the kit's writers (${among}): ${json(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.got ?? v.want])))}; ${bad} part(s) differ; ${exp.stray.length} changed cell(s) the oracle does not attribute`, { rows, stray: exp.stray.slice(0, 20) });
}

/** Cells of `part` the oracle attributes, standing as expected now, open above (air over them) and held on top by the region's tile. */
async function pick(own, s1, region, re, n, group, roadSites) {
  const cand = [];
  for (const [k, p] of own.part) {
    if (!re.test(p)) continue;
    const [x, y, z] = k.split(',').map(Number);
    if (norm(get(s1, k)) !== own.exp.get(k) || AIRS.has(idOf(get(s1, k))) || !AIRS.has(idOf(get(s1, `${x},${y + 1},${z}`)))) continue;
    cand.push([x, y, z, p]);
  }
  cand.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const out = [];
  for (let i = 0; i < cand.length && out.length < n; i += 64) {
    const chunk = cand.slice(i, i + 64);
    const st = await call('dev.journal.columns', { runs: chunk.map(([x, , z]) => [x, z, x, z]) }, 120_000);
    const top = new Map((st.cells ?? []).map((c) => [`${c.x},${c.y},${c.z}`, c.stack.at(-1)]));
    for (const c of chunk) {
      const t = top.get(`${c[0]},${c[1]},${c[2]}`);
      if (t && t.group === group && !roadSites.has(t.site) && out.length < n) out.push(c);
    }
  }
  check(out.length === n, `${n} ${re} cells of ${region} to change (held on top by its tile entries, open above): ${out.length} found among ${cand.length}`, out.slice(0, 4));
  return out;
}

async function damage(sq, lane, pads, swap) {
  const placed = new Set();
  const br = await call('dev.pt.breaks', { at: [...sq, ...lane].map((c) => c.slice(0, 3)), placer: 'LCAlex' }, 600_000);
  const uses = (await call('dev.pt.uses', { ops: lane.map((c) => ({ item: 'minecraft:cobblestone', at: c.slice(0, 3), placer: 'LCAlex' })) }, 600_000)).results;
  lane.forEach((c, i) => { if (uses[i]?.tracked) placed.add(c.slice(0, 3).join(',')); });
  for (const c of pads) await cmd(`setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
  for (const c of swap) await cmd(`setblock ${c[0]} ${c[1]} ${c[2]} minecraft:sponge`);
  await call('dev.wait', { ms: 2000 }, 30_000);
  check(br.broken === sq.length + lane.length && placed.size === lane.length, `a player (LCAlex) broke ${br.broken} cells and placed ${placed.size} tracked cobblestone (PT records); the console removed ${pads.length} and swapped ${swap.length}`, uses.slice(0, 2));
  return placed;
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B LC Lobby', { backend: 'sim' });
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

// ------------------------------------------------------------------ offline (item 1; api-compat)

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

function apiJars() {
  const A = process.env.GATE6DLC_JARS ?? path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'gate6d-rv', 'jars');
  const R44 = path.join(os.homedir(), 'Developer', 'LarattaLabs', 'Minecraft', 'architect-mc', 'artifacts', 'release-0440', 'v0440');
  return { jars: [path.join(A, 'architect_apitest-0.47.0.jar'), path.join(A, 'architect_apitest-0.45.0.jar'), path.join(R44, 'architect_apitest-0.44.0.jar')], surface: path.join(A, 'architect_mc-0.47.0.jar') };
}

steps.unit = async () => {
  const out = {};
  out.java = await javaTests(['*LandCheckTest*', '*ApiLCTest*', '*RealisedTest*'], 20);
  check(out.java.ok, `item 1: LandCheckTest (the ARTL order equals a real kit tile's payload order; WRITTEN cells by order take their winner's part, extras their cause's; an unknown cause, a record without writers and one whose counts disagree are unattributed; every class; a gate mechanism's dynamic state and volatile cells), ApiLCTest (feature landCheck; the default throws), RealisedTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
  const J = apiJars();
  out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
    const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
    return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
  });
  check(out.apicompat.every((a) => a.code === 0), 'item 4: api-compat: binary compatible with the 0.47.0, 0.45.0 and 0.44.0 apitest jars and the 0.47.0 mod surface', out.apicompat);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ in game (items 2, 3)

async function setup(name) {
  await ensure();
  await freshFlat(name);
  const gy = await groundY();
  check(gy > -64 && gy < 200, `the flat world's ground: y ${gy}`);
  const BOX = [CLAIM[0] - 8, gy - 12, CLAIM[1] - 8, CLAIM[2] + 8, gy + 20, CLAIM[3] + 8];
  const snap0 = await cellsOf(BOX);
  const T = await town();
  const ir0 = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', T.p.planId, 'ir.json'), 'utf8'));
  const own = await partsOracle(ir0, snap0, gy);
  const rr = await call('dev.region.realised', { region: T.region }, 600_000);
  const roadSites = new Set(Object.values(rr.sites?.roads ?? {}).map((r) => r.site));
  return { gy, BOX, T, ir0, own, roadSites, group: T.st.view.groupId };
}

steps.ingame = async () => {
  const out = {};
  const S = await setup('G6B LC Town');
  const { gy, BOX, T, own, roadSites, group } = S;
  const region = T.region;
  out.parts = [...new Set(own.part.values())].sort();
  out.pt = await call('dev.pt.rule', {}, 30_000);
  log(`  the town's parts (the kit's writers): ${json(out.parts)}; PT ${json(out.pt).slice(0, 200)}`);

  // ---- the fresh town: nothing changed, every part counted, nothing unloaded
  const lc0 = await landCheck(region);
  out.lc0 = lc0;
  const ch0 = lc0.parts.filter((p) => p.changed + p.removed + p.playerPlaced + p.volatileChanged);
  check(ch0.length === 0 && lc0.unloaded === 0 && lc0.cellsChecked > 0 && lc0.position === 0, `the fresh town reports no change: ${lc0.parts.length} parts (${json(lc0.parts.map((p) => [p.part, p.cells]))}), ${lc0.cellsChecked} cells checked, ${lc0.unloaded} unloaded, position ${lc0.position}`, ch0);
  const roadParts = lc0.parts.filter((p) => !out.parts.includes(p.part)).map((p) => p.part);
  const roadIds = (S.ir0.roads ?? []).map((r) => r.id);
  check(roadParts.every((p) => roadIds.includes(p)) && !lc0.parts.some((p) => p.part === 'unattributed'), `every reported part is a part the kit's writers name or an IR road (${json(roadParts)} of roads ${json(roadIds)}); no cell unattributed (a region realised with RP's record)`, lc0.parts.map((p) => p.part));
  const tileCells = lc0.parts.filter((p) => out.parts.includes(p.part)).reduce((n, p) => n + p.cells, 0);
  out.tileCells = { reported: tileCells, cellsWritten: T.st.view.cellsWritten };
  check(tileCells === T.st.view.cellsWritten, `the tile parts' cells: ${tileCells} reported = the region's cellsWritten ${T.st.view.cellsWritten} (no road or later entry covers a tile cell in this town)`);

  // ---- item 2: a player breaks 40 square cells and swaps 12 lane cells; the console removes 20 pad cells and swaps 6
  const s1 = await cellsOf(BOX);
  // (flat ground: the lanes write 6 cells and the pads none, so the 12 placements are the 6 lane cells and 6 verge cells, and the console's
  // 20 removals verge cells; its 6 swaps square cells)
  const sqAll = await pick(own, s1, region, /^square$/, 46, group, roadSites);
  const sq = sqAll.slice(0, 40), swap = sqAll.slice(40);
  const lanes = await pick(own, s1, region, /^lanes$/, 6, group, roadSites);
  const verges = await pick(own, s1, region, /^verges$/, 26, group, roadSites);
  const lane = [...lanes, ...verges.slice(0, 6)], pads = verges.slice(6);
  const placed = await damage(sq, lane, pads, swap);
  const s2 = await cellsOf(BOX);
  const exp = expectedOf(s1, s2, own.part, placed);
  out.expected = exp.byPart;
  const lc1 = await noWrite(region, BOX, (await call('dev.region.landCheck', { region }, 900_000)).worldDir, 'item 2');
  out.lc1 = lc1;
  compare('item 2 (rv-ingame\'s flat town)', lc1, exp, 'square, lanes, verges', null);
  const sqPart = sq[0]?.[3];
  if (sqPart) {
    const one = await landCheck(region, sqPart);
    check(one.parts.length === 1 && one.parts[0].part === sqPart && one.lots.length === 0 && json({ ...one.parts[0] }) === json(lc1.parts.find((p) => p.part === sqPart)), `landCheck of one part (${sqPart}) answers that part alone, equal to the whole call's row, no lots`, one.parts);
  }
  check(lc1.lots.length === 0 || lc1.lots.every((l) => l.standing <= 1), `lots: ${json(lc1.lots)} (rv-ingame's town has pads only)`);

  // ---- item 3: the same after an RV revision: its cells attributed to the revision's parts
  const sR = s2;
  const p1 = await call('dev.rv.plan', { region, spec: { parts: [MOUND(1), SPIRE(gy)] } }, 900_000);
  check(!p1.refused && p1.revisionOf?.rid, `revision planned: ${p1.planId ?? p1.refused}`);
  const rir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', p1.planId, 'ir.json'), 'utf8'));
  await L.realise(p1.planId);
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < 1_800_000) {
    st = await call('dev.rv.state', { region }, 60_000);
    const r = st.revisions.find((x) => x.rid === p1.revisionOf.rid);
    if (st.busy === null && r && !['ACCEPTED', 'PLACING'].includes(r.state)) break;
    await sleep(L.pollDelayMs(Date.now() - t0));
  }
  const ownR = await partsOracle(rir, sR, gy);
  out.revisionParts = [...new Set(ownR.part.values())].sort();
  const s3 = await cellsOf(BOX);
  const lc2 = await landCheck(region);
  const base = lc1;
  compare('item 3, the revision realised (no new change)', lc2, { byPart: {}, stray: [] }, 'every part as before the revision', base);
  check(lc2.position === 1 && out.revisionParts.every((p) => lc2.parts.some((q) => q.part === p && q.cells > 0)), `position ${lc2.position}; the revision's parts reported (${json(out.revisionParts)}: ${json(lc2.parts.filter((q) => out.revisionParts.includes(q.part)).map((q) => [q.part, q.cells]))})`);
  const any = (re) => ({ test: (p) => out.revisionParts.includes(p) && re.test(p), toString: () => `revision ${re}` });
  const spire = await pick(ownR, s3, region, any(/spire/), 15, group, roadSites);
  const mound = await pick(ownR, s3, region, any(/mound/), 2, group, roadSites);
  const placedR = new Set();
  const br = await call('dev.pt.breaks', { at: spire.map((c) => c.slice(0, 3)), placer: 'LCAlex' }, 600_000);
  for (const c of mound) await cmd(`setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
  await call('dev.wait', { ms: 2000 }, 30_000);
  check(br.broken === spire.length, `the player broke ${br.broken} spire cells; the console removed ${mound.length} mound cells`);
  const s4 = await cellsOf(BOX);
  const expR = expectedOf(s3, s4, ownR.part, placedR);
  out.expectedR = expR.byPart;
  const lc3 = await noWrite(region, BOX, lc1.worldDir ?? (await call('dev.region.landCheck', { region }, 900_000)).worldDir, 'item 3');
  out.lc3 = lc3;
  compare('item 3 (the revision\'s cells)', lc3, expR, 'the spire and the mound; the town\'s parts as before', lc2);
  spendZero();
  return out;
};

/** The verifier's re-run: landCheck writes nothing (a damaged town, three calls, the hash and the files before and after each). */
steps.nowrite = async () => {
  const S = await setup('G6B LC NoWrite');
  const region = S.T.region;
  const s1 = await cellsOf(S.BOX);
  const sq = await pick(S.own, s1, region, /^square$/, 10, S.group, S.roadSites);
  const lane = await pick(S.own, s1, region, /^lanes$/, 4, S.group, S.roadSites);
  await damage(sq, lane, [], []);
  const wd = (await call('dev.region.landCheck', { region }, 900_000)).worldDir;
  const r = [];
  for (let i = 0; i < 3; i++) r.push(await noWrite(region, S.BOX, wd, `nowrite round ${i + 1}`));
  check(r.every((x) => json(strip(x)) === json(strip(r[0]))), 'the three rounds report the same');
  spendZero();
  return { reports: r.map(strip) };
};

// ------------------------------------------------------------------ (LCi) castle (lc-castle) and survival (lc-survival): tools/lib/gate6dlc-2.mjs

{
  const { registerLC2 } = await import('./lib/gate6dlc-2.mjs');
  await registerLC2(steps, { L, call, check, cmd, log, OUT, json, imp, norm, idOf, AIRS, partsOracle, landCheck, noWrite, strip, listing, listDiff, spendZero, ensure });
}

steps.report = async () => {
  const lines = ['# Slice 6d LC gate', ''];
  for (const s of ['unit', 'ingame', 'nowrite', 'castle', 'survival']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    lines.push(`## ${s} (${j.head?.slice(0, 8)}, ${Math.round(j.seconds)} s)`, '');
    for (const [k, v] of Object.entries(j.results ?? {})) lines.push(`- ${v?.ok ? 'ok' : 'FAIL'} ${k}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6dlc.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
