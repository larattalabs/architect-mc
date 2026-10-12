#!/usr/bin/env node
// Phase 6c slice SCH gate (docs/CONTRACT.md "Phase 6c slice SCH" §5): Sponge schematic import and export, against a dev client of
// the sim family (tools/run-gate6a-client.sh: the real sidecar with the sim backend, so the helper's import-schem job runs; no
// Claude; apitest on the classpath). The API is driven through the apitest mod's /apitest steps (public API only); DevBridge hooks
// hash boxes, list cells, press Library buttons and run commands. $0: no Claude call anywhere.
//
//   node tools/gate6csch.mjs <step>
//     unit        (no game) items 1-4 offline: the kit codec tests (kit/test/schem.test.mjs), the mod's SchematicTest and
//                 ApiSchTest (gradle), the sidecar's import-schem test; item 7 (clean room: no WorldEdit code or names in the
//                 slice's diff, the spec cited in the codec files)
//     linux       item 2 on Linux (OrbStack, linux/amd64 as CI): the kit test in node:22, and the mod's export bytes re-gzipped by
//                 tools/lib/SchemGzip.java in eclipse-temurin:25 (needs `roundtrip` first: it gunzips that step's exports)
//     roundtrip   item 1 (every kit example: API export -> API import -> the same cells; the hut fixture's block entities) and
//                 item 2 (two exports byte-identical); the exports are cross-read by the kit codec
//     versions    item 3: the v2 and v3 fixtures import alike; the 1.16.5 fixture upgrades with 0 unknown states
//     refusals    item 4: unknown block, oversize and corrupt refused FORMAT/TOO_LARGE with a message, nothing installed or
//                 left staged; unknownAs replaces
//     placement   item 5: an imported .schem places and removes exactly (dev.region.hash before = after; dev.site.verify)
//     sites       item 6: exportSiteSchematic of a placed and edited site equals the world's cells (dev.box.hash cells)
//     ui          the Library's Export .schem button, Import… of a .schem, /architect export <id> schem, /architect import <file>
//     apicompat   item 8: tools/api-compat.mjs --gate6csch and the apitest apisch check
//     report      REPORT.md over the step JSONs, spend.json ($0)
//
// Evidence: artifacts/gate6c-sch/<step>.json in the main checkout (GATE6CSCH_OUT overrides), REPORT.md, spend.json. The client's
// game dir: GATE6CSCH_RUN/mod/run (the runner's run worktree), else ARCHITECT_GAME_DIR, else this checkout's mod/run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';
import { parse } from '../kit/lib/nbt.mjs';
import { parseSchem, schemToStructure, structureCells, sortedState, canonTag } from '../kit/lib/schem.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE6CSCH_OUT ? path.resolve(process.env.GATE6CSCH_OUT)
  : fs.existsSync(path.join(MAIN, 'artifacts')) ? path.join(MAIN, 'artifacts', 'gate6c-sch') : path.join(root, 'artifacts', 'gate6c-sch');
fs.mkdirSync(OUT, { recursive: true });
const RUN = process.env.GATE6CSCH_RUN ? path.resolve(process.env.GATE6CSCH_RUN) : null;
const GAME_DIR = RUN ? path.join(RUN, 'mod', 'run') : process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : path.join(root, 'mod', 'run');
const ARCH = path.join(GAME_DIR, 'architect');
const LIBRARY = path.join(ARCH, 'library');
const STAGING = path.join(ARCH, 'schem-staging');
const FIX = path.join(root, 'kit', 'test', 'fixtures', 'schem');
const EXAMPLES = path.join(root, 'kit', 'examples');
const WORK = path.join(OUT, 'files');
const PORT = Number(process.env.ARCHITECT_DEV_PORT || 8937);
const which = process.argv[2] ?? 'unit';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failures = 0;
const log = (...a) => console.log(...a);
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const bar = (ok, m, data) => check(ok, `BAR ${m}`, data); // a timing bar: recorded, not blocking in change/slice (docs/GATES.md)
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const b64 = (s) => Buffer.from(String(s)).toString('base64');
const noGame = ['unit', 'linux', 'report'].includes(which);
let dev = null;
if (!noGame) dev = await DevClient.connect({ port: PORT, timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const cmd = async (c) => call('dev.command', { cmd: c }, 60_000);
/** Runs /apitest <args> and parses its JSON answer. */
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 60_000) => {
  const key = pending.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${key}`);
};
let seq = 0;
const key = (s) => `${s}${Date.now().toString(36)}${seq++}`;
/** Library.importSchematic through apitest; the entry or {error, reason}. */
const importSchem = async (file, name = null, ext = null) => {
  const t0 = Date.now();
  const r = await result(await api(`schemimport ${key('i')} ${b64(file)} ${name ? b64(name) : '-'} ${ext ? b64(JSON.stringify(ext)) : '-'}`), 180_000);
  return { ...r, ms: Date.now() - t0 };
};
const exportEntry = async (id, dir, version = null) => {
  const t0 = Date.now();
  const r = await result(await api(`schemexport ${key('e')} ${id} ${version ?? '-'} ${b64(dir)}`), 60_000);
  return { ...r, ms: Date.now() - t0 };
};
/** An installed entry's structure (tagged), from its library folder. */
const entryStructure = (id) => parse(fs.readFileSync(path.join(LIBRARY, id, `${id}.nbt`)));
const exampleStructure = (e) => parse(fs.readFileSync(path.join(EXAMPLES, e, `${e}.nbt`)));
const examples = () => fs.readdirSync(EXAMPLES).filter((e) => fs.existsSync(path.join(EXAMPLES, e, `${e}.nbt`))).sort();
const diffCells = (a, b, max = 5) => {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? '-'} | ${b[k] ?? '-'}`);
    if (out.length >= max) break;
  }
  return out;
};
const libraryIds = () => (fs.existsSync(LIBRARY) ? fs.readdirSync(LIBRARY).sort() : []);
const stagedFiles = () => (fs.existsSync(STAGING) ? fs.readdirSync(STAGING, { recursive: true }).filter((f) => String(f).endsWith('.nbt')) : []);

// ------------------------------------------------------------------ worlds

async function groundAt(x, z) {
  let s;
  for (let i = 0; i < 40; i++) {
    s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
    if (s.columns?.length) break;
    await sleep(500);
  }
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  if (!m) throw new Error(`no ground at ${x},${z}: ${JSON.stringify(s)}`);
  return Number(m[1]);
}

async function setRules() {
  for (const r of ['random_tick_speed 0', 'mob_griefing false', 'advance_time false', 'spawn_mobs false', 'spawn_monsters false']) await cmd(`/gamerule ${r}`).catch(() => {});
}

/** A spot 40-60 blocks from the player, its ground y, chunks loaded. */
async function spot(dx, dz) {
  const p = (await call('dev.state')).player;
  const x = Math.floor(p.x) + dx;
  const z = Math.floor(p.z) + dz;
  await cmd(`/tp @s ${x - 6} ${Math.floor(p.y) + 20} ${z - 6}`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(1500);
  return { x, z, y: await groundAt(x, z) };
}

// ------------------------------------------------------------------ unit (no game)

function run(label, file, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(file, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  fs.writeFileSync(path.join(OUT, `${label}.log`), out);
  return { status: r.status, out, s: (Date.now() - t0) / 1000 };
}

async function unit() {
  const k = run('unit-kit', 'node', ['--test', 'kit/test/schem.test.mjs']);
  const kp = /ℹ pass (\d+)/.exec(k.out)?.[1];
  const kf = /ℹ fail (\d+)/.exec(k.out)?.[1];
  check(k.status === 0 && kf === '0', `items 1-4 (kit): kit/test/schem.test.mjs ${kp} pass, ${kf} fail (round trip of every example, determinism + goldens, v2/v3, refusals)`);
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(RUN ?? root, '.gradle-home') };
  const m = run('unit-mod', './gradlew', ['--offline', '--no-daemon', 'test', '--tests', 'dev.larattalabs.architect.library.SchematicTest', '--tests',
    'dev.larattalabs.architect.api.ApiSchTest'], { cwd: path.join(RUN ?? root, 'mod'), env });
  const dirs = path.join(RUN ?? root, 'mod', 'build', 'test-results', 'test');
  const junit = {};
  for (const n of ['dev.larattalabs.architect.library.SchematicTest', 'dev.larattalabs.architect.api.ApiSchTest']) {
    const f = path.join(dirs, `TEST-${n}.xml`);
    const x = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    junit[n] = { tests: Number(/tests="(\d+)"/.exec(x)?.[1] ?? 0), failures: Number(/failures="(\d+)"/.exec(x)?.[1] ?? -1), errors: Number(/errors="(\d+)"/.exec(x)?.[1] ?? -1) };
  }
  check(m.status === 0 && Object.values(junit).every((j) => j.tests > 0 && j.failures === 0 && j.errors === 0),
    `items 1-4 (mod): SchematicTest ${junit['dev.larattalabs.architect.library.SchematicTest'].tests} + ApiSchTest ${junit['dev.larattalabs.architect.api.ApiSchTest'].tests} tests pass (fixers, refusals, export round trip and goldens)`, junit);
  const sc = run('unit-sidecar', 'npx', ['vitest', 'run', 'test/variants.test.ts'], { cwd: path.join(root, 'sidecar') });
  check(sc.status === 0 && /Tests\s+\d+ passed/.test(sc.out) && !/failed/.test(/Tests[^\n]*/.exec(sc.out)?.[0] ?? ''), `the sidecar's import-schem job: ${/Tests[^\n]*/.exec(sc.out)?.[0]?.trim()}`);
  // item 7: clean room
  const diff = execFileSync('git', ['-C', root, 'diff', 'origin/main...HEAD', '--', '.', ':(exclude)docs'], { maxBuffer: 256 << 20 }).toString();
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const we = added.filter((l) => /worldedit|sk89q|enginehub|fastasyncworldedit/i.test(l) && !/no WorldEdit|not WorldEdit|WorldEdit is GPL|without WorldEdit|WorldEdit code|exported by WorldEdit|WorldEdit-made|WorldEdit and other/i.test(l));
  check(we.length === 0, `item 7: no WorldEdit code, package or import in the slice's diff (${added.length} added lines scanned)`, we.slice(0, 5));
  const cites = ['kit/lib/schem.mjs', 'mod/src/main/java/dev/larattalabs/architect/library/Schematic.java'].map((f) => [f, /SpongePowered\/Schematic-Specification/.test(fs.readFileSync(path.join(root, f), 'utf8')) && /8e6be2d/.test(fs.readFileSync(path.join(root, f), 'utf8'))]);
  check(cites.every(([, ok]) => ok), `item 7: the codecs cite the public spec (SpongePowered/Schematic-Specification@8e6be2d): ${cites.map(([f, ok]) => `${path.basename(f)} ${ok}`).join(', ')}`);
  return { junit };
}

// ------------------------------------------------------------------ item 2 on Linux

function docker(args) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
}

async function linux() {
  const v = docker(['version', '--format', '{{.Server.Version}}']);
  if (v.status !== 0) {
    check(false, `item 2 (Linux): docker (OrbStack) is not available: ${v.stderr?.trim()}`);
    return {};
  }
  const kitDir = path.join(root, 'kit');
  const k = docker(['run', '--rm', '--platform', 'linux/amd64', '-v', `${kitDir}:/w/kit:ro`, '-w', '/w', 'node:22', 'node', '--test', 'kit/test/schem.test.mjs']);
  fs.writeFileSync(path.join(OUT, 'linux-kit.log'), `${k.stdout}${k.stderr}`);
  const kp = /# pass (\d+)/.exec(k.stdout)?.[1] ?? /ℹ pass (\d+)/.exec(k.stdout)?.[1];
  const kf = /# fail (\d+)/.exec(k.stdout)?.[1] ?? /ℹ fail (\d+)/.exec(k.stdout)?.[1];
  check(k.status === 0 && kf === '0', `item 2 (Linux, node:22 amd64): the kit's export goldens and round trips hold (${kp} pass, ${kf} fail)`);
  const rt = path.join(OUT, 'roundtrip.json');
  if (!fs.existsSync(rt)) {
    check(false, 'item 2 (Linux, mod): run the roundtrip step first (its exports are re-gzipped here)');
    return {};
  }
  const exportsMac = JSON.parse(fs.readFileSync(rt, 'utf8')).data?.exports ?? {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-linux-'));
  fs.copyFileSync(path.join(root, 'tools', 'lib', 'SchemGzip.java'), path.join(tmp, 'SchemGzip.java'));
  fs.mkdirSync(path.join(tmp, 'raw'));
  for (const [e, x] of Object.entries(exportsMac)) fs.writeFileSync(path.join(tmp, 'raw', `${e}.raw`), zlib.gunzipSync(fs.readFileSync(x.file)));
  const j = docker(['run', '--rm', '--platform', 'linux/amd64', '-v', `${tmp}:/w`, 'eclipse-temurin:25', 'java', '/w/SchemGzip.java', '/w/raw']);
  fs.writeFileSync(path.join(OUT, 'linux-mod.log'), `${j.stdout}${j.stderr}`);
  const got = Object.fromEntries(j.stdout.split('\n').filter((l) => / [0-9a-f]{64} /.test(l)).map((l) => l.split(' ')).map(([n, h, b]) => [n, { sha: h, bytes: Number(b) }]));
  const rows = Object.entries(exportsMac).map(([e, x]) => [e, x.sha256, got[e]?.sha]);
  check(j.status === 0 && rows.length >= 4 && rows.every(([, a, b]) => a === b), `item 2 (Linux, eclipse-temurin:25 amd64): the mod's ${rows.length} exports re-gzipped on Linux are byte-identical to macOS's (${/jvm .*/.exec(j.stdout)?.[0] ?? '?'})`, rows);
  return { rows };
}

// ------------------------------------------------------------------ item 1 and 2: round trip

async function roundtrip() {
  fs.mkdirSync(WORK, { recursive: true });
  const dirA = path.join(WORK, 'export-a');
  const dirB = path.join(WORK, 'export-b');
  const exportsOut = {};
  for (const e of examples()) {
    const a = await exportEntry(e, dirA);
    const b = await exportEntry(e, dirB);
    if (!check(!a.error && !b.error, `export ${e}: ${a.file ?? a.error}`, { a, b })) continue;
    exportsOut[e] = { file: a.file, sha256: a.sha256, bytes: a.bytes };
    check(a.sha256 === b.sha256 && fs.readFileSync(a.file).equals(fs.readFileSync(b.file)), `item 2: two exports of ${e} are byte-identical (${a.sha256.slice(0, 12)}, ${a.bytes} bytes)`);
    bar(a.ms < 5000, `export ${e} took ${a.ms} ms (at most 5 s)`, { ms: a.ms });
    // the kit codec reads the mod's file: version 3, Offset, Author, the same cells as the example
    const p = parseSchem(fs.readFileSync(a.file));
    const gy = JSON.parse(fs.readFileSync(path.join(EXAMPLES, e, `${e}.blueprint.json`), 'utf8')).groundY;
    const want = structureCells(exampleStructure(e));
    const viaKit = structureCells(schemToStructure(p));
    check(p.version === 3 && p.offset[1] === -gy && p.author === 'Architect' && JSON.stringify(viaKit) === JSON.stringify(want),
      `${e}: the kit reads the mod's v3 export (Offset y ${p.offset[1]}, ${Object.keys(viaKit).length} cells as the example)`, diffCells(want, viaKit));
    // item 1: the file imported back through the API gives the same cells
    const imp = await importSchem(a.file, `RT ${e}`);
    if (!check(!imp.error && !!imp.id, `item 1: ${e}.schem imports through the API as ${imp.id ?? imp.error} (${imp.ms} ms)`, imp)) continue;
    const got = structureCells(entryStructure(imp.id));
    check(JSON.stringify(got) === JSON.stringify(want), `item 1: ${e} -> .schem -> ${imp.id}: the same ${Object.keys(want).length} cells`, diffCells(want, got));
    check(imp.groundY === gy && imp.tags.includes('schem') && imp.tags.includes('imported') && imp.ext?.['architect_mc:schem']?.version === 3,
      `${imp.id}: groundY ${imp.groundY} (the example's ${gy}), tags ${imp.tags.join(',')}, ext architect_mc:schem`, imp);
    bar(imp.ms < 60_000, `import ${e} took ${imp.ms} ms (at most 60 s)`, { ms: imp.ms });
  }
  // block entities: the hut fixture (a chest with items, a sign) -> entry -> .schem -> entry
  const hut = await importSchem(path.join(FIX, 'v3_hut.schem'));
  if (check(!hut.error && !!hut.id, `the v3 hut fixture imports as ${hut.id ?? hut.error}`, hut)) {
    const want = structureCells(entryStructure(hut.id));
    const bes = Object.values(want).filter((v) => v.includes(' {'));
    check(bes.length === 2, `the hut entry keeps its 2 block entities (${bes.map((v) => v.split('[')[0]).join(', ')})`, bes);
    const ex = await exportEntry(hut.id, dirA);
    const back = await importSchem(ex.file, 'RT hut');
    const got = !back.error ? structureCells(entryStructure(back.id)) : {};
    check(!back.error && JSON.stringify(got) === JSON.stringify(want), `item 1 (block entities): ${hut.id} -> .schem -> ${back.id ?? back.error}: the same cells and block-entity NBT`, diffCells(want, got));
  }
  return { exports: exportsOut };
}

// ------------------------------------------------------------------ item 3: versions

async function versions() {
  const v3 = await importSchem(path.join(FIX, 'v3_hut.schem'));
  const v2 = await importSchem(path.join(FIX, 'v2_hut.schem'));
  check(!v3.error && v3.ext?.['architect_mc:schem']?.version === 3 && v3.name === 'Spec Hut v3' && v3.ext['architect_mc:schem'].author === 'spec fixture',
    `item 3: the v3 fixture imports (${v3.id ?? v3.error}, "${v3.name}", Metadata in ext)`, v3);
  check(!v2.error && v2.ext?.['architect_mc:schem']?.version === 2, `item 3: the v2 fixture imports (${v2.id ?? v2.error})`, v2);
  if (!v3.error && !v2.error) {
    const a = structureCells(entryStructure(v3.id));
    const b = structureCells(entryStructure(v2.id));
    check(JSON.stringify(a) === JSON.stringify(b) && Object.keys(a).length === 96, `item 3: v2 and v3 give the same ${Object.keys(a).length} cells (the structure_void column not written)`, diffCells(a, b));
    check(v3.ext['architect_mc:schem'].entitiesSkipped === 1, 'the v3 fixture\'s entity is skipped and counted', v3.ext);
  }
  const old = await importSchem(path.join(FIX, 'old_dataversion.schem'));
  if (check(!old.error, `item 3: the DataVersion 2586 (1.16.5) fixture imports (${old.id ?? old.error})`, old)) {
    const cells = structureCells(entryStructure(old.id));
    const names = [...new Set(Object.values(cells).map((v) => v.split(/[[ ]/)[0]))].sort();
    const stale = names.filter((n) => ['minecraft:grass_path', 'minecraft:grass'].includes(n));
    check(stale.length === 0 && names.includes('minecraft:dirt_path') && names.includes('minecraft:short_grass'),
      `item 3: upgraded with 0 unknown states (grass_path -> dirt_path, grass -> short_grass): ${names.join(', ')}`, names);
    const sign = Object.values(cells).find((v) => v.startsWith('minecraft:oak_sign'));
    check(!!sign && sign.includes('front_text') && !sign.includes('Text1'), 'item 3: the sign\'s Text1..4 became front_text', sign);
    check(old.ext?.['architect_mc:schem']?.dataVersion === 2586, `ext keeps the file's DataVersion ${old.ext?.['architect_mc:schem']?.dataVersion}`);
  }
  return {};
}

// ------------------------------------------------------------------ item 4: refusals

async function refusals() {
  const before = libraryIds();
  for (const [f, reason, re] of [['unknown_block.schem', 'FORMAT', /othermod:gizmo.*othermod:widget/], ['oversize.schem', 'TOO_LARGE', /97x4x5 is past the template cap/],
    ['corrupt.schem', 'FORMAT', /97 cells, not the 100/]]) {
    const r = await importSchem(path.join(FIX, f));
    check(r.reason === reason && re.test(r.error ?? ''), `item 4: ${f} refused ${r.reason}: ${String(r.error).replace(/^.*ArchitectRefused: /, '')}`, r);
  }
  // a file that is not a schematic at all (a structure .nbt renamed)
  fs.mkdirSync(WORK, { recursive: true });
  const fake = path.join(WORK, 'not_a_schematic.schem');
  fs.copyFileSync(path.join(EXAMPLES, 'cabin', 'cabin.nbt'), fake);
  const nf = await importSchem(fake);
  check(nf.reason === 'FORMAT' && /not a Sponge schematic/.test(nf.error ?? ''), `item 4: a structure .nbt named .schem refused ${nf.reason}`, nf);
  const after = libraryIds();
  check(JSON.stringify(after) === JSON.stringify(before), `item 4: nothing installed (${before.length} library entries before and after)`, { before: before.length, after: after.length });
  check(stagedFiles().length === 0, `item 4: nothing left staged in schem-staging (${stagedFiles().length})`);
  // unknownAs
  const ua = await importSchem(path.join(FIX, 'unknown_block.schem'), 'Modded Hut', { 'architect_mc:unknownAs': 'minecraft:stone' });
  check(!ua.error && ua.ext?.['architect_mc:schem']?.replaced?.length === 2, `unknownAs minecraft:stone: imported as ${ua.id ?? ua.error}, replaced ${ua.ext?.['architect_mc:schem']?.replaced?.join(', ')}`, ua);
  await sleep(1000);
  check(stagedFiles().length === 0, `the staging folder is empty once the imports end (${stagedFiles().length})`);
  return {};
}

// ------------------------------------------------------------------ item 5: placement

async function placement() {
  await setRules();
  const hut = await importSchem(path.join(FIX, 'v3_hut.schem'), 'Placed Hut');
  if (!check(!hut.error, `the hut imports for placement (${hut.id ?? hut.error})`, hut)) return {};
  const s = await spot(48, 0);
  const box = [s.x - 8, s.y - 12, s.z - 8, s.x + 16, s.y + 16, s.z + 16];
  const pre = await call('dev.region.hash', { box });
  const pl = await result(await api(`place ${hut.id} ${s.x} ${s.y + 1} ${s.z} INSTANT unowned noactor 0`), 120_000);
  if (!check(pl.placed, `item 5: ${hut.id} placed as ${pl.siteId}`, pl)) return {};
  let v;
  for (let i = 0; i < 40; i++) {
    v = await call('dev.site.verify', { site: pl.siteId }, 120_000);
    if ((v.owned ?? 0) > 0 && v.mismatches === 0) break;
    await sleep(500);
  }
  check(v.owned > 0 && v.mismatches === 0, `item 5: every placed cell is the template's (${v.owned} owned, ${v.mismatches} mismatches)`, v);
  const mid = await call('dev.region.hash', { box });
  check(mid.sha256 !== pre.sha256 || mid.hash !== pre.hash, 'item 5: the box changed when placed');
  const rm = await result(await api(`remove ${pl.siteId} - noforce`), 120_000);
  check(rm.removed === true, `item 5: removed ${pl.siteId}`, rm);
  await sleep(2000);
  const post = await call('dev.region.hash', { box });
  const h = (x) => x.sha256 ?? x.hash;
  check(h(post) === h(pre), `item 5: Remove-exact: the box hash after removal equals the one before placing (${String(h(pre)).slice(0, 12)})`, { pre: h(pre), post: h(post) });
  return { site: pl.siteId };
}

// ------------------------------------------------------------------ item 6: sites

/** A small SNBT reader (Minecraft's own printing of tags), to the kit codec's canonTag form. */
function snbt(src) {
  let i = 0;
  const ws = () => { while (/\s/.test(src[i])) i++; };
  const str = () => {
    const q = src[i++];
    let s = '';
    while (src[i] !== q) {
      if (src[i] === '\\') i++;
      s += src[i++];
    }
    i++;
    return s;
  };
  const word = () => {
    const m = /^[A-Za-z0-9._+\-]+/.exec(src.slice(i));
    i += m[0].length;
    return m[0];
  };
  const scalar = (w) => {
    let m;
    if ((m = /^(-?\d+)b$/i.exec(w))) return ['byte', Number(m[1])];
    if ((m = /^(-?\d+)s$/i.exec(w))) return ['short', Number(m[1])];
    if ((m = /^(-?\d+)L$/i.exec(w))) return `${m[1]}L`;
    if ((m = /^(-?\d*\.?\d+(?:e-?\d+)?)f$/i.exec(w))) return ['float', Math.fround(Number(m[1]))];
    if ((m = /^(-?\d*\.?\d+(?:e-?\d+)?)d$/i.exec(w))) return ['double', Number(m[1])];
    if (/^-?\d+$/.test(w)) return ['int', Number(w)];
    if (/^-?\d*\.\d+(?:e-?\d+)?$/i.test(w)) return ['double', Number(w)];
    if (w === 'true') return ['byte', 1];
    if (w === 'false') return ['byte', 0];
    return ['string', w];
  };
  const value = () => {
    ws();
    if (src[i] === '{') {
      i++;
      const o = {};
      ws();
      while (src[i] !== '}') {
        ws();
        const k = src[i] === '"' || src[i] === "'" ? str() : word();
        ws();
        i++; // :
        o[k] = value();
        ws();
        if (src[i] === ',') i++;
        ws();
      }
      i++;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    if (src[i] === '[') {
      i++;
      ws();
      const typed = /^[BIL];/.exec(src.slice(i));
      if (typed) i += 2;
      const items = [];
      ws();
      while (src[i] !== ']') {
        items.push(value());
        ws();
        if (src[i] === ',') i++;
        ws();
      }
      i++;
      if (typed) {
        const t = { B: 'byteArray', I: 'intArray', L: 'longArray' }[typed[0][0]];
        return t === 'longArray' ? items.map((x) => (typeof x === 'string' ? x : `${x[1]}L`)) : [t, items.map((x) => (Array.isArray(x) ? x[1] : Number(x)))];
      }
      return items;
    }
    if (src[i] === '"' || src[i] === "'") return ['string', str()];
    return scalar(word());
  };
  return value();
}

/** A state SNBT ({id:"..",properties:{..}} or {Name:..,Properties:..}) as "ns:name[k=v,...]" sorted. */
function stateOf(s) {
  const o = snbt(s);
  const name = (o.id ?? o.Name)[1];
  const props = o.properties ?? o.Properties;
  const kv = props ? Object.entries(props).map(([k, v]) => `${k}=${v[1]}`).sort() : [];
  return kv.length ? `${name}[${kv.join(',')}]` : name;
}

async function sites() {
  await setRules();
  const s = await spot(0, 52);
  const pl = await result(await api(`place cabin ${s.x} ${s.y + 1} ${s.z} INSTANT unowned noactor 0`), 120_000);
  if (!check(pl.placed, `item 6: cabin placed as ${pl.siteId}`, pl)) return {};
  await sleep(2000);
  const sv = await api('sites');
  const site = (sv.all ?? []).find((x) => x.id === pl.siteId);
  const b = String(site?.box ?? '').match(/-?\d+/g)?.map(Number); // BoundingBox{minX=.., minY=.., minZ=.., maxX=.., maxY=.., maxZ=..}
  if (!check(Array.isArray(b) && b.length === 6, `the site's box ${site?.box}`, site)) return {};
  // edits: a block added inside the box, one removed, a chest with items
  const [x0, y0, z0, x1, y1, z1] = b;
  const cx = Math.floor((x0 + x1) / 2);
  const cz = Math.floor((z0 + z1) / 2);
  await cmd(`/setblock ${cx} ${y0 + 2} ${cz} minecraft:gold_block`);
  await cmd(`/setblock ${x0} ${y0 + 1} ${z0} minecraft:air`);
  await cmd(`/setblock ${cx + 1} ${y0 + 2} ${cz} minecraft:chest[facing=east]{Items:[{Slot:0b,id:"minecraft:apple",count:2}]}`);
  await sleep(1500);
  const dir = path.join(WORK, 'sites');
  const t0 = Date.now();
  const ex = await result(await api(`schemsite ${key('s')} ${pl.siteId} ${b64(dir)}`), 60_000);
  const ms = Date.now() - t0;
  if (!check(!ex.error && !!ex.file, `item 6: exportSiteSchematic(${pl.siteId}) -> ${ex.file ?? ex.error}`, ex)) return {};
  bar(ms < 5000, `site export took ${ms} ms (at most 5 s)`, { ms });
  const p = parseSchem(fs.readFileSync(ex.file));
  const dims = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
  check(p.version === 3 && p.width === dims[0] && p.height === dims[1] && p.length === dims[2], `item 6: a v3 file of the site's box ${dims.join('x')} (${p.width}x${p.height}x${p.length})`);
  const fromFile = structureCells(schemToStructure(p));
  // the world's cells from DevBridge (its own reader): state + block-entity NBT minus x/y/z
  const w = await call('dev.box.hash', { min: [x0, y0, z0], max: [x1, y1, z1], cells: true }, 120_000);
  const world = {};
  for (const line of w.cells ?? []) {
    const m = /^(-?\d+),(-?\d+),(-?\d+) (\{.*?\})(?: be=(\{.*\}))?$/.exec(line);
    if (!m) continue;
    const k = `${m[1] - x0},${m[2] - y0},${m[3] - z0}`;
    const st = sortedState(stateOf(m[4]));
    if (m[5]) {
      const be = snbt(m[5]);
      delete be.x; delete be.y; delete be.z;
      world[k] = `${st} ${JSON.stringify(be)}`;
    } else {
      world[k] = st;
    }
  }
  check(Object.keys(world).length === dims[0] * dims[1] * dims[2], `the world's ${Object.keys(world).length} cells read (dev.box.hash)`, { lines: (w.cells ?? []).length, first: (w.cells ?? [])[0] });
  const d = diffCells(world, fromFile, 8);
  check(d.length === 0 && Object.keys(fromFile).length === Object.keys(world).length, `item 6: the export equals the edited site's current ${Object.keys(world).length} cells (states and block-entity NBT)`, d);
  const k = (dx, dy, dz) => `${dx},${dy},${dz}`;
  check(fromFile[k(cx - x0, 2, cz - z0)] === 'minecraft:gold_block' && fromFile[k(0, 1, 0)] === 'minecraft:air' && /apple/.test(fromFile[k(cx + 1 - x0, 2, cz - z0)] ?? ''),
    'item 6: the three edits are in the file (gold block, removed block, chest with apples)', { gold: fromFile[k(cx - x0, 2, cz - z0)], air: fromFile[k(0, 1, 0)], chest: fromFile[k(cx + 1 - x0, 2, cz - z0)] });
  const rm = await result(await api(`remove ${pl.siteId} - force`), 120_000);
  log('removed', JSON.stringify(rm).slice(0, 200));
  return { site: pl.siteId, file: ex.file };
}

// ------------------------------------------------------------------ UI and commands

async function ui() {
  // Export .schem (the Library's button)
  const e = await call('dev.library.export.schem', { entry: 'tower' }, 60_000);
  check(e.file?.endsWith(path.join('exports', 'tower', 'tower.schem')) && e.bytes > 0, `the Library's Export .schem: ${e.file} (${e.bytes} bytes)`, e);
  // /architect export <entry> schem
  const c = await cmd('/architect export gatehouse schem');
  await sleep(3000);
  const gf = path.join(ARCH, 'exports', 'gatehouse', 'gatehouse.schem');
  check(fs.existsSync(gf) && parseSchem(fs.readFileSync(gf)).version === 3, `/architect export gatehouse schem -> ${gf}`, c.messages);
  // Import… of a .schem (the list offers it) and /architect import <file>
  const imports = path.join(ARCH, 'imports', 'sch');
  fs.mkdirSync(imports, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'v2_hut.schem'), path.join(imports, 'ui_hut.schem'));
  fs.copyFileSync(path.join(FIX, 'v3_hut.schem'), path.join(imports, 'cmd hut.schem'));
  const list = await call('dev.library.import.list', {}, 20_000);
  const before = libraryIds();
  const pick = await call('dev.library.import.pick', { path: path.join(imports, 'ui_hut.schem') }, 60_000);
  check(!!pick.jobId, `Import… lists and imports ui_hut.schem: job ${pick.jobId}`, { pick: pick.jobId, list: JSON.stringify(list).includes('ui_hut.schem') });
  let made = [];
  for (let i = 0; i < 120 && !made.length; i++) {
    await sleep(1000);
    made = libraryIds().filter((x) => !before.includes(x) && x.startsWith('imp_ui_hut'));
  }
  check(made.length === 1, `the UI import installed ${made.join(',') || 'nothing'}`);
  const before2 = libraryIds();
  const ci = await cmd('/architect import sch/cmd hut.schem');
  let made2 = [];
  for (let i = 0; i < 120 && !made2.length; i++) {
    await sleep(1000);
    made2 = libraryIds().filter((x) => !before2.includes(x) && x.startsWith('imp_cmd_hut'));
  }
  check(made2.length === 1, `/architect import "sch/cmd hut.schem" installed ${made2.join(',') || 'nothing'}`, ci.messages);
  const bad = await cmd('/architect import ../../options.txt');
  check((bad.messages ?? []).some((m) => /Name a \.schem file/.test(m)) || JSON.stringify(bad).includes('Name a .schem'), '/architect import refuses a path outside imports/', bad);
  return {};
}

// ------------------------------------------------------------------ item 8: api-compat

async function apicompat() {
  const v = await api('apisch');
  check(v.version === '1.20.0' && v.schematics === true && v.formatLast === true, `apitest apisch: VERSION ${v.version} (placeholder), feature schematics, Reason FORMAT appended last`, v);
  const base = RUN ?? root;
  const classes = ['main', 'client'].map((s) => path.join(base, 'mod', 'build', 'classes', 'java', s)).join(path.delimiter);
  const r = spawnSync('node', [path.join(root, 'tools', 'api-compat.mjs'), '--gate6csch', classes], { encoding: 'utf8', env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  fs.writeFileSync(path.join(OUT, 'apicompat.log'), `${r.stdout}${r.stderr}`);
  check(r.status === 0, `item 8: api-compat --gate6csch (0.18.0/0.17.0/0.16.0 apitest jars, the 0.18.0 surface): exit ${r.status}`, (r.stdout + r.stderr).split('\n').filter((l) => /FAIL|ok|missing/i.test(l)).slice(0, 12));
  return {};
}

// ------------------------------------------------------------------ report

async function report() {
  const rows = [];
  for (const s of ['unit', 'linux', 'roundtrip', 'versions', 'refusals', 'placement', 'sites', 'ui', 'apicompat']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  fs.writeFileSync(path.join(OUT, 'spend.json'), JSON.stringify({ totalUsd: 0, capUsd: 0 }, null, 2));
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Gate 6c-SCH (Sponge .schem import and export)\n\nSpend: $0.00.\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`);
  return { lines: rows.length };
}

const steps = { unit, linux, roundtrip, versions, refusals, placement, sites, ui, apicompat, report };
let data;
let error;
const t0 = Date.now();
try {
  if (!steps[which]) throw new Error(`unknown step ${which}`);
  data = await steps[which]();
} catch (e) {
  console.error(e);
  error = String(e?.stack ?? e);
  failures++;
}
if (which !== 'report') {
  write(`${which}.json`, { step: which, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), gameDir: GAME_DIR, error, results: { ...results }, data });
}
console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
dev?.close();
process.exit(failures === 0 ? 0 : 1);
