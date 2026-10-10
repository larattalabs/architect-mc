#!/usr/bin/env node
// Phase 6c slice 0b gate driver (docs/CONTRACT.md "Phase 6c slice 0b", §7). $0 except `bench` (§6, paid, claude login only).
//
//   node tools/gate6c0b.mjs unit        items 1, 2, 3, 4, 6 and the $0 half of 7: the kit tests (mirror oracle, smalls,
//                                       variation over every example x built-in bible), the sidecar suites (copies,
//                                       versionOf, the 0b polish case) and the mod tests (MirrorOracleTest, Wire0bTest)
//   node tools/gate6c0b.mjs ingame      items 5 and 7 in game (sim, simCosts measured): the Steward-style copies flow (a
//                                       massingFirst group with an x3 item and a SMALL item, approve, COPY stages, a batch
//                                       of 4, undo one copy) and C13 (a site with 3 player edits, versionOf, outdated,
//                                       checkDelta, applyDelta KEEP, undo), plus the versionOf refusals and base_moved
//   node tools/gate6c0b.mjs apicompat   item 8: tools/api-compat.mjs against the archived apitest jars
//   node tools/gate6c0b.mjs bench ...   §6 (see tools/bench6c0b.mjs)
//   node tools/gate6c0b.mjs report      REPORT.md from the item JSONs
//
// The in-game client runs from its own worktree (../architect-mc-0b-run, detached at this HEAD; GATE6C0B_RUN overrides) with
// the bundled sim helper (tools/run-gate6c0a-client.sh) on ports 8906/8907 (ARCHITECT_PORT / ARCHITECT_DEV_PORT override).
// It is started and stopped by this script, by PID. Evidence: artifacts/gate6c0b/<item>.json in the MAIN checkout
// (GATE6C0B_OUT overrides), spend.json ($0.00 for every step but bench).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE6C0B_OUT ? path.resolve(process.env.GATE6C0B_OUT) : path.join(MAIN, 'artifacts', 'gate6c0b');
fs.mkdirSync(OUT, { recursive: true });
const RUN = process.env.GATE6C0B_RUN ? path.resolve(process.env.GATE6C0B_RUN) : path.resolve(root, '..', 'architect-mc-0b-run');
const SEED = path.resolve(root, '..', 'architect-mc-6a-run');
const SIDECAR_PORT = Number(process.env.ARCHITECT_PORT || 8906);
const DEV_PORT = Number(process.env.ARCHITECT_DEV_PORT || 8907);
const GAME_DIR = path.join(RUN, 'mod', 'run');

const step = process.argv[2];
if (step !== 'bench') {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) {
    if (process.env[k]) {
      console.error(`refusing: ${k} is set (this step is $0, sim only)`);
      process.exit(3);
    }
  }
}
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE)/.test(k)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, `${step}.log`), `${line}\n`);
};
let results = {};
let failures = 0;
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  fs.appendFileSync(path.join(OUT, `${step}.log`), `${ok ? 'ok  ' : 'FAIL'} ${m}\n`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), `${JSON.stringify(data, null, 2)}\n`);
const flush = (item) => {
  write(`${item}.json`, { item, at: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), failures: Object.values(results).filter((r) => !r.ok).length, results });
  results = {};
};
const spend0 = () => {
  const f = path.join(OUT, 'spend.json');
  if (!fs.existsSync(f)) write('spend.json', { totalUsd: 0, steps: [], note: '$0 through item 8 (sim / stub only)' });
};

// ------------------------------------------------------------------ unit (items 1, 2, 3, 4, 6, 7 offline)

function run(cmd, args, cwd, env = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...childEnv(), ...env }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 3_600_000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function tapCases(out) {
  const cases = [];
  for (const m of out.matchAll(/^(✔|✖) (.+?) \([\d.]+m?s\)$/gm)) cases.push({ ok: m[1] === '✔', name: m[2] });
  return cases;
}

async function unit() {
  spend0();
  // the kit: the mirror oracle, smalls under every built-in bible, variation for every example x bible
  const varDir = path.join(OUT, 'variation');
  fs.mkdirSync(varDir, { recursive: true });
  const kit = run('node', ['--test', 'kit/test/mirror.test.mjs', 'kit/test/smalls.test.mjs', 'kit/test/copies.test.mjs'], root, { COPIES_REPORT: path.join(varDir, '%s.txt') });
  const kc = tapCases(kit.out);
  fs.writeFileSync(path.join(OUT, 'unit-kit.log'), kit.out);
  // the sidecar suites
  const sc = run('npx', ['vitest', 'run', 'test/copies.test.ts', 'test/versionof.test.ts', 'test/polish.test.ts', '--reporter=json', `--outputFile=${path.join(OUT, 'unit-sidecar.json')}`], path.join(root, 'sidecar'));
  fs.writeFileSync(path.join(OUT, 'unit-sidecar.log'), sc.out);
  let tests = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, 'unit-sidecar.json'), 'utf8'));
    tests = j.testResults.flatMap((f) => f.assertionResults.map((a) => ({ file: path.basename(f.name), name: a.fullName ?? a.title, ok: a.status === 'passed', status: a.status })));
  } catch (e) {
    check(false, `sidecar suites ran (${e.message})`);
  }
  // the mod
  const gradle = run(path.join(root, 'mod', 'gradlew'), ['test', '--offline', '--tests', '*MirrorOracleTest', '--tests', '*Wire0bTest'], path.join(root, 'mod'), { JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') });
  fs.writeFileSync(path.join(OUT, 'unit-mod.log'), gradle.out);
  const kitCase = (re) => kc.filter((c) => re.test(c.name));
  const scCase = (re, file) => tests.filter((t) => (!file || t.file === file) && re.test(t.name) && t.status !== 'skipped');
  const all = (list) => list.length > 0 && list.every((c) => c.ok);

  // item 1: expansion
  check(all(scCase(/x6 at cap 3|cap 1 gives 6 originals|copyOf: a copy of the archetype, counted/, 'copies.test.ts')), 'item 1: x6 at cap 3 = 2 archetypes + 4 copies with the right keys; cap 1 = 6 originals; a landmark x2 = 2 originals; every COPY_REFUSED detail (landmark, unknown, self, cap)', scCase(/expansion|x6|cap 1|copyOf/, 'copies.test.ts'));
  flush('expansion');
  // item 2: variation and the mirror oracle
  check(all(kitCase(/copies #2 and #3 meet 2 levers and 10%/)), 'item 2: for every kit example with params under every built-in bible, copies #2 and #3 meet "2 effective levers and 10%" (kit/test/copies.test.mjs; per-pair numbers in variation/)', kitCase(/copies #2|recipe helpers/));
  check(all(kitCase(/mirror table equals vanilla|oracle covers|vanilla never changes/)) && gradle.code === 0, 'item 2: the mirror oracle: the mod dumps vanilla BlockState.mirror for every block (MirrorOracleTest, fixture equal), the kit table equals it for every state, both mirrors', kitCase(/mirror|oracle/));
  check(all(kitCase(/front kept|east front flips z/)), 'item 2: a mirrored copy keeps front (cells, anchors, ports and the interior mapped)', kitCase(/front/));
  check(all(scCase(/x3 item: one design, two \$0 copies/, 'copies.test.ts')), 'item 2: the first copy is mirrored, the second not; the recipe meets the bar (sidecar, real kit)');
  flush('variation');
  // item 3: fallback
  check(all(scCase(/sim:copyfail and sim:copysize/, 'copies.test.ts')), 'item 3: sim:copyfail and sim:copysize reach FALLBACK with the reason (check / size)');
  check(all(scCase(/massingFirst: the archetype's approval covers its copies/, 'copies.test.ts')), "item 3: under massingFirst a fallback binds the archetype's approved massing with no new approval; a dropped archetype fails its copies with source_failed");
  check(all(scCase(/promoteCopy/, 'copies.test.ts')), 'item 3: promoteCopy works and refuses (not_copy, final)');
  check(all(scCase(/copies run while the group is paused_budget/, 'copies.test.ts')), 'item 3: copies run while the group is paused_budget');
  flush('fallback');
  // item 4: derivation
  check(all(scCase(/derivation COPY rebuilds byte-identically/, 'copies.test.ts')), "item 4: a copy's recipe rebuilds it byte-identically from sourceVersion; a COPY entry refuses polish (VERSION_REFUSED copy)");
  check(all(scCase(/\(0b\) a player variant records derivation VARIANT/, 'polish.test.ts')), 'item 4: a player variant writes derivation VARIANT and variantOfVersion; derivation survives a polish of a VARIANT entry');
  check(all(scCase(/every refusal detail; base_moved/, 'versionof.test.ts')), 'item 4: a COPY entry refuses versionOf (VERSION_REFUSED copy)');
  check(gradle.code === 0, 'item 4: Library.Entry exposes derivation and variantOfVersion (Wire0bTest)');
  flush('derivation');
  // item 6: C2 and C8
  check(all(scCase(/smallBySize: a small item drops the default report critique/, 'copies.test.ts')) && all(scCase(/C2 and C8: the size rule/, 'copies.test.ts')), 'item 6: a smallBySize item skips the report critique; an explicit item critique runs; an explicit effort wins over the size rule');
  check(all(scCase(/estimates: COPY \$0, SMALL with its caps in the basis/, 'copies.test.ts')), 'item 6: a SMALL basis shows 2 rounds, 40 turns and medium');
  check(all(scCase(/C8: two sim:repair fail a SMALL item at round 2/, 'copies.test.ts')), 'item 6: two sim:repair fail a SMALL item at round 2 (rounds); the SMALL brief composes from smalls.mjs');
  check(all(kitCase(/passes the checker under every built-in bible/)), 'item 6: every smalls.mjs builder passes the checker under every built-in bible', kitCase(/smalls|passes the checker/));
  flush('c2c8');
  // item 7 (offline half)
  check(all(scCase(/installs head \+ 1 by design/, 'versionof.test.ts')), 'item 7 (sidecar): versionOf installs head + 1 by design, grown, with the site files as context');
  check(all(scCase(/front-changing result is repaired/, 'versionof.test.ts')), 'item 7 (sidecar): a front-changing result is repaired before install');
  check(all(scCase(/every refusal detail; base_moved/, 'versionof.test.ts')), 'item 7 (sidecar): every refusal detail (bundled, no_entry, no_source, massing, copy, busy) and base_moved');
  flush('c13-sidecar');
  write('unit.json', { kit: { code: kit.code, cases: kc.length, failed: kc.filter((c) => !c.ok).map((c) => c.name) }, sidecar: { code: sc.code, tests: tests.length, failed: tests.filter((t) => !t.ok && t.status !== 'skipped').map((t) => t.name) }, mod: { code: gradle.code } });
}

// ------------------------------------------------------------------ the in-game client

let dev = null;
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});

function clientPids() {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(RUN)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** The run worktree at this HEAD (created once; seeded from the 6a run worktree with APFS clones), its helper bundle built. */
function prepareRun() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  if (!fs.existsSync(RUN)) {
    execFileSync('git', ['worktree', 'add', '--detach', RUN, head], { cwd: root, stdio: 'inherit' });
    for (const rel of ['.gradle-home', 'sidecar/node_modules', 'mod/run']) {
      const src = path.join(SEED, rel);
      if (fs.existsSync(src) && !fs.existsSync(path.join(RUN, rel))) execFileSync('cp', ['-c', '-R', src, path.join(RUN, rel)]);
    }
  } else execFileSync('git', ['checkout', '--detach', head], { cwd: RUN, stdio: 'inherit' });
  const b = spawnSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), env: childEnv(), encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`the helper bundle does not build in ${RUN}: ${b.stdout}${b.stderr}`);
  log(`run worktree ${RUN} at ${head.slice(0, 10)}`);
}

async function connect(timeoutMs = 900_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), 'utf8').trim();
      dev = await DevClient.connect({ port: DEV_PORT, token, timeoutMs: 20_000 });
      return;
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`no DevBridge on ${DEV_PORT}: ${last}`);
}

async function startClient(world) {
  if (clientPids().length) throw new Error(`a client of ${RUN} runs already: ${clientPids()}`);
  fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  const opts = path.join(GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(RUN, 'tools', 'run-gate6c0a-client.sh'), [], {
    cwd: RUN,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...childEnv(), ARCHITECT_PORT: String(SIDECAR_PORT), ARCHITECT_DEV_PORT: String(DEV_PORT), ARCHITECT_SIM_COSTS: 'measured', ARCHITECT_AUTOWORLD_NAME: world, ARCHITECT_AUTOWORLD_PRESET: 'flat', ARCHITECT_SHOTS_DIR: path.join(OUT, 'shots') },
  });
  p.unref();
  await connect();
  const end = Date.now() + 900_000;
  while (Date.now() < end) {
    const st = await call('dev.state').catch(() => ({}));
    if (st.inWorld && st.ready) break;
    await sleep(1000);
  }
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  log(`client up (pid ${clientPids()}) in ${world}`);
}

async function stopClient() {
  const pids = clientPids();
  if (!pids.length) return;
  try {
    await dev?.call('dev.quit', {}, { timeoutMs: 30_000 });
  } catch {
    // gone already
  }
  for (let i = 0; i < 120 && clientPids().length; i++) await sleep(1000);
  for (const pid of clientPids()) {
    if (pids.includes(pid)) {
      log(`killing my client pid ${pid}`);
      process.kill(pid, 'SIGTERM');
    }
  }
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
}

const cmd = async (c) => call('dev.command', { cmd: c }, 120_000);
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null' || m.startsWith('"'));
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 200)}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 300_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${key}`);
};
const groupGet = (id) => api(`groupget ${id}`);
const until = async (fn, what, timeoutMs = 600_000, every = 1000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const parseBox = (s) => (s.match(/-?\d+/g) ?? []).map(Number); // BoundingBox{minX=..} -> [minX,minY,minZ,maxX,maxY,maxZ]

// ------------------------------------------------------------------ item 5: the Steward-style copies flow

async function item5() {
  const design = (o) => ({ type: 'cabin', style: 'rustic', size: [24, 20, 24], ...o });
  const g = {
    name: 'G6C0B Copies',
    bible: 'oak',
    owner: 'apitest:steward',
    massingFirst: true,
    approvalUi: 'owner',
    smallBySize: true,
    items: [design({ itemKey: 'house', count: 3 }), design({ itemKey: 'well', type: 'custom', profile: ['door', 'lit', 'no_floating'], effort: 'small', size: [11, 12, 9] })],
  };
  const est = await result(await api(`estimatemix e5 ${b64({ group: g, newBible: false, massingFirst: true })}`));
  check(!!est.byKind?.COPY && !!est.byKind?.SMALL && !!est.byKind?.ORIGINAL, 'item 5: the byKind estimate has ORIGINAL, SMALL and COPY lines', est);
  const gid = await result(await api(`group g5 ${b64(g)}`));
  check(typeof gid === 'string', `item 5: the massingFirst group with an x3 item and a SMALL item is requested (${gid})`);
  const g0 = await groupGet(gid);
  check(JSON.stringify(g0.items.map((i) => [i.itemKey, i.kind])) === JSON.stringify([['house', 'ORIGINAL'], ['house#2', 'COPY'], ['house#3', 'COPY'], ['well', 'ORIGINAL']]), 'item 5: the items expand to house, house#2 (COPY), house#3 (COPY), well', g0.items.map((i) => [i.itemKey, i.kind, i.stage, i.effort]));
  check(g0.items.find((i) => i.itemKey === 'well')?.effort === 'SMALL', 'item 5: the well is SMALL');
  await until(async () => (await groupGet(gid)).status === 'AWAITING_APPROVAL', 'awaiting approval');
  const aw = (await groupGet(gid)).awaiting;
  check(JSON.stringify(aw) === JSON.stringify(['house', 'well']), `item 5: awaiting approval: ${aw} (the copies wait for their archetype's approval)`);
  const ap = await result(await api(`approve a5 ${gid} ${b64({ approve: ['house', 'well'], owner: 'apitest:steward' })}`));
  check(!ap.error, 'item 5: approve (owner)', ap);
  const fin = await until(async () => {
    const x = await groupGet(gid);
    return ['DONE', 'FAILED', 'CANCELLED'].includes(x.status) ? x : null;
  }, 'the group to end', 900_000, 2000);
  const by = (k) => fin.items.find((i) => i.itemKey === k);
  check(fin.status === 'DONE' && fin.items.every((i) => i.status === 'DONE'), `item 5: the group is DONE with every item DONE (${fin.items.map((i) => `${i.itemKey}:${i.status}`).join(', ')})`, fin.items);
  check(['house#2', 'house#3'].every((k) => by(k)?.kind === 'COPY' && by(k)?.stage === 'copy' && by(k)?.entryId), 'item 5: the copies built in stage COPY, each with its own entry');
  const copyLine = fin.breakdown?.stages?.COPY;
  check(copyLine && copyLine.usd === 0 && copyLine.count === 2, `item 5: the breakdown's COPY line is $0 (count ${copyLine?.count}, ${copyLine?.ms} ms)`, fin.breakdown);
  const notional = fin.breakdown?.totalUsd ?? fin.cost?.usd;
  check(notional >= est.usdLow - 1e-6 && notional <= est.usdHigh + 1e-6, `item 5: the notional cost $${notional} is inside the byKind estimate $${est.usdLow}-${est.usdHigh}`);
  // the batch of 4 on a flat pad, one lot each (32 apart)
  const st = await call('dev.state');
  const p = st.player ?? {};
  const x0 = Math.floor(p.x ?? 0) + 40;
  const z0 = Math.floor(p.z ?? 0);
  const y = await groundY(x0, z0);
  const keys = ['house', 'house#2', 'house#3', 'well'];
  const items = keys.map((k, i) => ({ key: k, bp: by(k).entryId, at: [x0 + i * 32, y, z0], mode: 'INSTANT' }));
  const bid = await result(await api(`bqueue ${JSON.stringify({ tag: 'b5', items })}`));
  check(typeof bid === 'string', `item 5: a batch of 4 queued (${bid})`);
  const bdone = await until(async () => {
    const b = await api(`batch ${bid}`);
    return ['DONE', 'CANCELLED', 'STOPPED'].includes(b.status) ? b : null;
  }, 'the batch', 600_000, 2000);
  const sites = (bdone.items ?? []).map((i) => i.site).filter(Boolean);
  check(bdone.status === 'DONE' && new Set(sites).size === 4, `item 5: the batch is DONE and each copy is its own site (${sites.join(', ')})`, bdone);
  // undo one copy: remove its site, the terrain comes back
  const copySite = (bdone.items ?? []).find((i) => i.key === 'house#2')?.site;
  const sv = await siteView(copySite).catch(() => null);
  const rb = sv?.restoreBox ? parseBox(sv.restoreBox) : null;
  const before = rb ? await call('dev.box.hash', { min: rb.slice(0, 3), max: rb.slice(3, 6) }) : null;
  const rm = await result(await api(`remove ${copySite} - noforce`));
  check(rm?.removed === true, `item 5: undo one copy (${copySite}) removes it`, rm);
  if (rb) {
    // a flat world: the restored box hashes like the same box of untouched flat ground 400 blocks away
    const after = await call('dev.box.hash', { min: rb.slice(0, 3), max: rb.slice(3, 6) });
    const far = await call('dev.box.hash', { min: [rb[0] + 400, rb[1], rb[2]], max: [rb[3] + 400, rb[4], rb[5]] });
    check(after.sha256 !== before.sha256 && after.sha256 === far.sha256, 'item 5: removing the copy restored the terrain (its box hashes as untouched flat ground)', { before: before.sha256, after: after.sha256, flat: far.sha256 });
  }
  write('item5-group.json', fin);
  flush('steward-flow');
}

/** The surface y at (x, z): Survey.sample (heights is the first air row above the ground). */
async function groundY(x, z) {
  try {
    const h = await result(await api(`heights ${x} ${z} ${x} ${z} 1`), 60_000);
    const v = Array.isArray(h) && h[0] ? h[0][2] : undefined;
    if (Number.isFinite(v)) return v;
  } catch {
    // the flat world's default
  }
  return -60;
}

const siteView = async (id) => ((await api('sites')).sites ?? (await api('sites')).all ?? []).find((v) => v.id === id) ?? null;

// ------------------------------------------------------------------ item 7: C13 in game

async function item7() {
  // an entry (a sim tavern) and a site of it
  const d = await result(await api(`detail d7 ${b64({ type: 'tavern', style: 'rustic', name: 'Gate Inn', size: [40, 30, 40] })}`));
  const entryId = await until(async () => {
    const x = await api(`designget ${d}`);
    return x?.status === 'DONE' ? x.entryId : x?.status === 'FAILED' ? 'FAILED' : null;
  }, 'the tavern design', 300_000);
  check(entryId && entryId !== 'FAILED', `item 7: an entry to change (${entryId})`);
  const st = await call('dev.state');
  const x0 = Math.floor(st.player?.x ?? 0) - 60;
  const z0 = Math.floor(st.player?.z ?? 0) + 40;
  const y = await groundY(x0, z0);
  const pl = await result(await api(`place ${entryId} ${x0} ${y} ${z0} INSTANT owned noactor 0`));
  const site = pl.siteId;
  check(pl.placed && site, `item 7: placed ${entryId} as ${site}`, pl);
  const sv = await siteView(site);
  const box = parseBox(sv.box);
  // 3 player edits: cells the site wrote, on its lowest rows near the middle
  const edits = [];
  const cx = Math.floor((box[0] + box[3]) / 2);
  const cz = Math.floor((box[2] + box[5]) / 2);
  outer: for (let dy = 0; dy < 6; dy++)
    for (let dx = -4; dx <= 4; dx++)
      for (let dz = -4; dz <= 4; dz++) {
        const p = [cx + dx, box[1] + dy, cz + dz];
        const at = await call('dev.journal.at', { x: p[0], y: p[1], z: p[2] }).catch(() => null);
        const s = JSON.stringify(at ?? {});
        if (s.includes(site) && !/"after":"minecraft:air/.test(s) && !edits.some((e) => Math.abs(e[0] - p[0]) + Math.abs(e[2] - p[2]) < 2)) {
          edits.push(p);
          if (edits.length === 3) break outer;
        }
      }
  for (const p of edits) await cmd(`/setblock ${p.join(' ')} minecraft:gold_block`);
  check(edits.length === 3, `item 7: 3 player edits at ${edits.map((p) => p.join(',')).join('; ')}`);
  // versionOf(entry, site)
  const vd = await result(await api(`versionof v7 ${b64({ type: 'tavern', style: 'rustic', notes: 'weathered, add a lean-to', size: [48, 34, 48] })} ${entryId} ${site}`));
  check(typeof vd === 'string', `item 7: versionOf(${entryId}, ${site}) requested (${vd})`, vd);
  const vdone = await until(async () => {
    const x = await api(`designget ${vd}`);
    return ['DONE', 'FAILED', 'CANCELLED'].includes(x?.status) ? x : null;
  }, 'the versionOf design', 300_000);
  check(vdone.status === 'DONE', `item 7: the versionOf design is DONE (${vdone.step})`, vdone);
  const ev = await api(`eversions ${entryId}`);
  check(ev.version === 2, `item 7: installs head + 1 (head ${ev.version})`, ev);
  const last = (ev.versions ?? []).at(-1);
  check(!last || last.by === 'design' || last.by === 'DESIGN', `item 7: the new version is by design (${last?.by})`, last);
  const od = await api('outdated -');
  check(JSON.stringify(od).includes(site), `item 7: outdated lists ${site}`, od);
  const chk = await api(`checkdelta ${site} 2 keep`);
  const kept = Array.isArray(chk.kept) ? chk.kept.length : chk.kept;
  check(kept === 3, `item 7: checkDelta reports 3 kept cells (got ${kept})`, chk);
  const ap = await result(await api(`applydelta ${site} 2 keep`));
  check(ap.applied === true && (Array.isArray(ap.kept) ? ap.kept.length : ap.kept) === 3, `item 7: applyDelta(KEEP) applied, the 3 edits kept`, ap);
  let goldLeft = 0;
  for (const p of edits) {
    const at = await call('dev.journal.at', { x: p[0], y: p[1], z: p[2] }).catch(() => null);
    const hash = await call('dev.box.hash', { min: p, max: p, cells: true }).catch(() => null);
    if (JSON.stringify(hash ?? at ?? {}).includes('gold_block')) goldLeft++;
  }
  check(goldLeft === 3, `item 7: the 3 player edits are still there (${goldLeft})`);
  const rv = await result(await api(`srevert ${site} 1`));
  const hist = await api(`shistory ${site}`);
  check(rv.applied !== false && JSON.stringify(hist).includes('"version":1'), 'item 7: undo (revert to v1) restores the site', { rv, hist });
  // refusals in game: bundled, copy, site_mismatch, busy; base_moved
  const refused = async (key, args) => result(await api(`versionof ${key} ${args}`));
  const r1 = await refused('r1', `${b64({ type: 'cabin', notes: 'x' })} cabin -`);
  check(r1.reason === 'VERSION_REFUSED' && r1.detail === 'bundled', `item 7: a bundled entry is refused (${r1.reason} ${r1.detail})`, r1);
  const r2 = await refused('r2', `${b64({ type: 'tavern', notes: 'x' })} nope_${Date.now() % 1000} -`);
  check(r2.reason === 'UNKNOWN_BLUEPRINT', `item 7: an unknown entry is UNKNOWN_BLUEPRINT (${r2.reason})`, r2);
  const ctx5 = fs.existsSync(path.join(OUT, 'item5-group.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'item5-group.json'), 'utf8')) : null;
  const copyEntry = ctx5?.items?.find((i) => i.kind === 'COPY')?.entryId;
  if (copyEntry) {
    const r3 = await refused('r3', `${b64({ type: 'cabin', notes: 'x' })} ${copyEntry} -`);
    check(r3.reason === 'VERSION_REFUSED' && r3.detail === 'copy', `item 7: a COPY entry is refused (${r3.detail})`, r3);
    const r4 = await refused('r4', `${b64({ type: 'tavern', notes: 'x' })} ${copyEntry} ${site}`);
    check(r4.reason === 'VERSION_REFUSED' && r4.detail === 'site_mismatch', `item 7: a site of another entry is refused (${r4.detail})`, r4);
  } else check(false, 'item 7: the copy refusals need item 5 first');
  const busyA = await refused('r5', `${b64({ type: 'tavern', notes: 'first change' })} ${entryId} -`);
  const r6 = await refused('r6', `${b64({ type: 'tavern', notes: 'second change' })} ${entryId} -`);
  check(typeof busyA === 'string' && r6.reason === 'VERSION_REFUSED' && r6.detail === 'busy', `item 7: a second versionOf while one runs is refused busy (${r6.detail})`, { busyA, r6 });
  // base_moved: the head moves (an entry revert) while that versionOf runs
  const er = await result(await api(`erevert ${entryId} 1`));
  const moved = await until(async () => {
    const x = await api(`designget ${busyA}`);
    return ['DONE', 'FAILED', 'CANCELLED'].includes(x?.status) ? x : null;
  }, 'the moved versionOf', 300_000);
  check(moved.status === 'FAILED' && /base_moved/.test(moved.error ?? ''), `item 7: the head moved meanwhile: base_moved (${moved.error})`, { er, moved });
  flush('c13-ingame');
}

async function ingame() {
  spend0();
  prepareRun();
  try {
    await startClient(`G6C0B Flat ${Date.now() % 100000}`);
    const v = await api('api111');
    check(v.copies && v.smallEffort && v.versionOf, `in game: the helper has copies, smallEffort and versionOf (API ${v.version})`, v);
    flush('ingame-setup');
    for (const [name, fn] of [['item 5', item5], ['item 7', item7]]) {
      try {
        await fn();
      } catch (e) {
        check(false, `${name} threw: ${e.message}`);
        flush(name.replace(' ', ''));
      }
    }
  } finally {
    await stopClient();
  }
}

// ------------------------------------------------------------------ report

function report() {
  const items = fs.readdirSync(OUT).filter((f) => f.endsWith('.json') && !['spend.json', 'unit.json', 'unit-sidecar.json', 'item5-group.json'].includes(f) && !f.startsWith('bench'));
  const lines = ['# Gate 6c 0b', '', `Generated ${new Date().toISOString()}.`, ''];
  for (const f of items.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    if (!j.results) continue;
    lines.push(`## ${j.item} (${j.failures ? `${j.failures} FAIL` : 'PASS'}, ${j.head?.slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results)) lines.push(`- ${r.ok ? 'ok' : '**FAIL**'} ${m}`);
    lines.push('');
  }
  const spend = fs.existsSync(path.join(OUT, 'spend.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8')) : { totalUsd: 0 };
  lines.push(`Spend: $${(spend.totalUsd ?? 0).toFixed(2)}.`, '');
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), lines.join('\n'));
  console.log(lines.join('\n'));
}

const steps = { unit, ingame, report };
if (step === 'bench') {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'bench6c0b.mjs'), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (!steps[step]) {
  console.error('usage: node tools/gate6c0b.mjs unit|ingame|apicompat|bench|report');
  process.exit(2);
}
await steps[step]();
if (step !== 'report') console.log(failures ? `\n${failures} FAIL` : '\nall ok');
process.exitCode = failures ? 1 : 0;
