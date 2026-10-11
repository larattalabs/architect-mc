#!/usr/bin/env node
// Phase 6c slice X gate (docs/CONTRACT.md "Phase 6c slice X: region consumer asks C19 and C20", gate items 1-3 and 5) against a dev
// client of the X run worktree (`../architect-mc-X-run`, a detached worktree at this checkout's HEAD; tools/run-gate6b-client.sh: the
// sim sidecar, no Claude, apitest on the classpath). Ports 8912 (sidecar) / 8913 (DevBridge) unless the runner gives others.
// $0: no Claude call anywhere; spend.json reads $0.00.
//
//   node tools/gate6cx.mjs <step>
//     start [world] | stop | base     the client and the base worlds (G6B Flat Base, as gate6cv base)
//     unit                            item 1 (no game): the kit's C19 tests, the Java API/key/ext tests, the whole village and kit suites
//     lotext                          item 2 (in game, S7 flat): plan with lot ext (4096 characters on one lot, forged architect_mc: keys),
//                                     realise, every lot site carries the plan's ext; 4097 refuses FIELD_LIMIT with the path; save and
//                                     reload: unchanged; undo (Regions.remove) and redo (a new realise of the plan): unchanged
//     keys                            item 3 (in game): plan opKey idempotence, conflict, in-flight dedupe, owner scope, found after a
//                                     restart; realise opKey: stop the world with the future pending (WORLD_STOPPED), realiseByKey finds
//                                     the region after the reload, it completes, a second realise returns it, another body conflicts
//     removal                         C22 (a) a restore failure injected mid-removal, the retry finishes it, world diff 0; (b) remove, reload, remove again: removed=true, nothing written; REMOVED tombstones with their time
//     apicompat                       item 5: tools/api-compat.mjs --gate6cx (needs the mod's classes: gradle build first)
//     report                          REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-x/<step>.json in the main checkout (GATE6CX_OUT overrides), all.log, REPORT.md, spend.json.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-X-run');
// GATE6CX_OUT wins over the runner's GATE6B_OUT (the gate runner gives every step its 6b evidence dir)
process.env.GATE6B_OUT = process.env.GATE6CX_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-x');
process.env.GATE6B_SIDECAR_PORT ??= '8912';
process.env.GATE6B_DEV_PORT ??= '8913';
const L = await import('./lib/run6b.mjs');
const { RUN, OUT, SAVES, LIBRARY, call, check, cmd, connect, fails, leaveWorld, log, openWorld, refuseKeys, results, root, settle, sleep, startClient,
  state, stopClient, tp, write, copyWorld, prepare, waitRegion } = L;

refuseKeys();
const FLAT = 'G6B Flat Base';
const SCEN = path.join(root, 'scenarios');
const S7 = JSON.parse(fs.readFileSync(path.join(SCEN, 's7_flat_village.json'), 'utf8'));
const json = (o) => JSON.stringify(o).replaceAll(' ', '');
const rid = Date.now().toString(36);

// ---- the apitest mod (public API only)
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 120_000) => {
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
  if (!['stop', 'start'].includes(name)) write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
async function fresh(name, from) {
  await leaveWorld();
  copyWorld(from, name);
  await openWorld(name);
}
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice X is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? FLAT, { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  if (!fs.existsSync(path.join(SAVES, FLAT, 'level.dat'))) {
    await leaveWorld();
    await openWorld(FLAT, { mode: 'creative', preset: 'flat', seed: '2026100906', cheats: true });
    await L.setRules('exact');
    await tp(0.5, 200, 0.5);
    await cmd('/save-all flush');
    await leaveWorld();
  }
  spendZero();
  return { worlds: [FLAT] };
};

// ------------------------------------------------------------------ item 1: unit tests (no game)

function nodeTest(files) {
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8', timeout: 1_800_000 });
  const t = `${r.stdout}${r.stderr}`;
  const n = (k) => Number((new RegExp(`^ℹ ${k} (\\d+)`, 'm').exec(t) ?? [])[1] ?? -1);
  return { code: r.status, pass: n('pass'), fail: n('fail'), failing: t.split('\n').filter((l) => l.startsWith('✖')).slice(0, 20), names: t.split('\n').filter((l) => /^✔|^✖/.test(l)) };
}

steps.unit = async () => {
  const out = {};
  out.c19 = nodeTest(['kit/test/village.test.mjs']);
  const c19 = out.c19.names.filter((l) => /C19/.test(l));
  check(out.c19.code === 0 && out.c19.fail === 0 && c19.length === 2 && c19.every((l) => l.startsWith('✔')), `item 1: the kit's C19 tests (ext validated, 4096/4097, namespace guard, plan -> LotSpec) and the rest of the village suite: ${out.c19.pass} pass, ${out.c19.fail} fail`, out.c19.failing);
  const env = { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? path.join(root, '.gradle-home') };
  const g = spawnSync('./gradlew', ['test', '--offline', '--tests', '*Api115Test', '--tests', '*RegionKeysTest', '--tests', '*Api113Test', '--tests', '*PlanStaleTest'],
    { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 });
  const xml = (n) => {
    const f = path.join(root, 'mod', 'build', 'test-results', 'test', `TEST-dev.larattalabs.architect.${n}.xml`);
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const m = /tests="(\d+)" skipped="(\d+)" failures="(\d+)" errors="(\d+)"/.exec(t);
    return m ? { tests: +m[1], failures: +m[3] + +m[4] } : null;
  };
  out.java = { code: g.status, api115: xml('api.Api115Test'), keys: xml('region.RegionKeysTest') };
  check(g.status === 0 && out.java.api115?.tests >= 6 && out.java.api115.failures === 0 && out.java.keys?.tests >= 5 && out.java.keys.failures === 0,
    `item 1: Api115Test (old constructors, trailing components, default methods, no new Reason, ext bounds at 4096/4097) ${JSON.stringify(out.java.api115)} and RegionKeysTest (body hashes, scopes, plan ext -> site ext, region record) ${JSON.stringify(out.java.keys)}`);
  out.kit = nodeTest(fs.readdirSync(path.join(root, 'kit', 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `kit/test/${f}`));
  check(out.kit.code === 0 && out.kit.fail === 0, `item 1: the whole kit suite: ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ S7 fixture: the bible and the entries (scenarios.mjs prepV)

async function prepS7() {
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', S7.bible, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(SCEN, S7.bibleFixture), path.join(dst, 'bible.json'));
  const { loadDesign } = await import(path.join(root, 'kit', 'build.mjs'));
  const { writeBlueprint } = await import(path.join(root, 'kit', 'lib', 'write.mjs'));
  const { PALETTES, rolesOfPalette } = await import(path.join(root, 'kit', 'lib', 'kit.mjs'));
  const bible = JSON.parse(fs.readFileSync(path.join(SCEN, S7.bibleFixture), 'utf8'));
  for (const [id, e] of Object.entries(S7.entries)) {
    const dir = path.join(LIBRARY, id);
    const spec = JSON.stringify({ ...e, bible: bible.roles });
    if (fs.existsSync(path.join(dir, `${id}.nbt`)) && fs.existsSync(path.join(dir, 'g6cv.spec.json')) && fs.readFileSync(path.join(dir, 'g6cv.spec.json'), 'utf8') === spec) continue;
    const roles = { ...rolesOfPalette(PALETTES.rustic), ...bible.roles };
    const bp = await loadDesign(e.design, { values: e.values ?? {}, palette: { bible: { id: S7.bible, version: 1, roles } } });
    bp.id = id;
    bp.name = `${e.design} ${JSON.stringify(e.values ?? {})}`;
    writeBlueprint(bp, dir);
    fs.writeFileSync(path.join(dir, 'g6cv.spec.json'), spec);
    log(`  entry ${id}: ${e.design}`);
  }
}

const CLAIM = S7.fixture.claim; // flat variant: claimOffset [0, 0]
const CENTRE = [(CLAIM[0] + CLAIM[2]) / 2, (CLAIM[1] + CLAIM[3]) / 2];

/** The steward-style ext of a lot, with Architect's own keys forged (they must not win). */
const lotExt = (l) => ({ 'steward_mc:lot': l.id, 'steward_mc:role': l.role, 'steward_mc:build': `xbuild.${rid}`, 'architect_mc:lot': 'forged', 'architect_mc:village': { role: 'forged' } });
/** An ext of exactly `n` characters as JSON (ASCII, so Gson and JSON.stringify agree). */
function extOfLength(base, n) {
  const e = { ...base, 'steward_mc:pad': '' };
  e['steward_mc:pad'] = 'a'.repeat(n - JSON.stringify(e).length);
  if (JSON.stringify(e).length !== n) throw new Error('extOfLength');
  return e;
}
const stewardOnly = (ext) => Object.fromEntries(Object.entries(ext ?? {}).filter(([k]) => !k.startsWith('architect_mc:')));

// ------------------------------------------------------------------ item 2: lot ext from the plan onto the lot sites

async function sitesByLot() {
  const all = (await api('sites')).all;
  const m = {};
  for (const s of all) {
    const lot = s.ext?.['architect_mc:lot'];
    if (lot) m[lot] = { id: s.id, ext: s.ext, state: s.state };
  }
  return m;
}

steps.lotext = async () => {
  await ensure();
  await prepS7();
  const out = {};
  await fresh('G6B X LotExt', FLAT);
  await L.setRules('exact');
  await tp(CENTRE[0], 120, CENTRE[1]);
  const specs = S7.params.lots.map((l, i) => ({ ...l, ext: i === 0 ? extOfLength(lotExt(l), 4096) : lotExt(l) }));
  check(JSON.stringify(specs[0].ext).length === 4096, 'lotext: lot 0 carries exactly 4096 characters of ext');
  // the bound: 4097 refuses FIELD_LIMIT with the path, before anything is planned
  const over = specs.map((l, i) => (i === 1 ? { ...l, ext: extOfLength(lotExt(l), 4097) } : l));
  const r1 = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params: { ...S7.params, lots: over }, surveyLoad: 'bounded:256', check: false, bible: S7.bible }, 600_000);
  out.over = r1.refused;
  check(/^FIELD_LIMIT: params\.lots\[1\]\.ext: 4097 characters as JSON, at most 4096$/.test(String(r1.refused)), `lotext: 4097 characters refuse FIELD_LIMIT with the field path (${r1.refused})`);
  const r2 = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params: { ...S7.params, lots: specs.map((l, i) => (i === 2 ? { ...l, ext: ['x'] } : l)) }, surveyLoad: 'bounded:256', check: false }, 600_000);
  check(/^FIELD_LIMIT: params\.lots\[2\]\.ext: must be an object$/.test(String(r2.refused)), `lotext: a non-object ext refuses FIELD_LIMIT with the path (${r2.refused})`);
  const r3 = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params: { ...S7.params, lots: specs.map((l, i) => (i === 3 ? { ...l, ext: { nonamespace: 1 } } : l)) }, surveyLoad: 'bounded:256', check: false }, 600_000);
  check(/^FIELD_LIMIT: params\.lots\[3\]\.ext: key "nonamespace" is not namespace:name$/.test(String(r3.refused)), `lotext: a key without a namespace refuses FIELD_LIMIT with the path (${r3.refused})`);
  // plan (kept), prepare, the realised plan with the ext
  const p1 = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params: { ...S7.params, lots: specs }, surveyLoad: 'bounded:256', check: false, bible: S7.bible, seed: S7.seed }, 900_000);
  if (p1.refused) throw new Error(`plan refused: ${p1.refused}`);
  await prepare(p1.planId);
  const p = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params: { ...S7.params, lots: specs }, surveyLoad: 'generated:64', bible: S7.bible, seed: S7.seed }, 900_000);
  if (p.refused) throw new Error(`plan refused: ${p.refused}`);
  // the plan: LotSpec.ext = the caller's keys + the program's own architect_mc:village (the forged one dropped)
  const planOk = specs.every((s) => {
    const ls = p.lots.find((l) => l.id === s.id);
    const want = stewardOnly(s.ext);
    return ls && Object.entries(want).every(([k, v]) => JSON.stringify(ls.ext[k]) === JSON.stringify(v)) && ls.ext['architect_mc:village']?.role !== 'forged' && !('architect_mc:lot' in ls.ext);
  });
  check(planOk && p.lots.length === specs.length, `lotext: every LotSpec.ext carries the caller's keys, the program's architect_mc:village stands and the forged architect_mc: values are dropped (${p.lots.length} lots)`);
  const region = await L.realise(p.planId, { lots: S7.lotEntries });
  const st = await waitRegion(region, 3_600_000);
  out.realise = { region, state: st.view.state, lots: st.view.lots.map((l) => `${l.id}:${l.state}`) };
  check(st.view.state === 'PLACED' && st.view.lots.every((l) => l.state === 'placed'), `lotext: the realise places every lot (${st.view.state}; ${out.realise.lots.join(', ')})`);
  const verify = (by, label) => {
    const bad = [];
    for (const s of specs) {
      const site = by[s.id];
      const want = stewardOnly(s.ext);
      if (!site) { bad.push(`${s.id}: no site`); continue; }
      for (const [k, v] of Object.entries(want)) if (JSON.stringify(site.ext[k]) !== JSON.stringify(v)) bad.push(`${s.id}: ${k}`);
      if (site.ext['architect_mc:lot'] !== s.id) bad.push(`${s.id}: architect_mc:lot ${site.ext['architect_mc:lot']}`);
      if ('architect_mc:village' in site.ext) bad.push(`${s.id}: architect_mc:village on the site`);
    }
    check(bad.length === 0 && Object.keys(by).length === specs.length, `lotext: ${label}: every lot site carries the plan's ext, architect_mc:lot is Architect's own (${Object.keys(by).length}/${specs.length} sites; ${bad.join('; ') || 'no mismatch'})`, bad);
  };
  const by1 = await sitesByLot();
  verify(by1, 'after the realise');
  const snapshot = (by) => JSON.stringify(Object.keys(by).sort().map((k) => [k, by[k].ext]));
  const e1 = snapshot(by1);
  // save and reload
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G6B X LotExt');
  const by2 = await sitesByLot();
  verify(by2, 'after save and reload');
  check(snapshot(by2) === e1, 'lotext: save and reload leave every site ext unchanged (byte equal)');
  // undo: Regions.remove; redo: a new realise of the same plan
  await tp(CENTRE[0], 120, CENTRE[1]);
  await cmd('/kill @e[type=!minecraft:player]');
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  await settle(5000);
  const gone = await sitesByLot();
  check(rm.removed && Object.keys(gone).length === 0, `lotext: undo (Regions.remove) removes the lot sites (${Object.keys(gone).length} left)`);
  const region2 = await L.realise(p.planId, { lots: S7.lotEntries });
  const st2 = await waitRegion(region2, 3_600_000);
  check(st2.view.state === 'PLACED', `lotext: redo (a new realise of the same plan) places the region again (${st2.view.state})`);
  const by3 = await sitesByLot();
  verify(by3, 'after undo and redo');
  check(snapshot(by3) === e1, 'lotext: undo and redo leave every site ext unchanged (byte equal)');
  out.sample = by3[specs[1].id];
  const rm2 = await call('dev.region.remove', { region: region2 }, 3_600_000);
  check(rm2.removed, 'lotext: the redone region is removed again');
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 3: operation keys on region plans and realises

steps.keys = async () => {
  await ensure();
  await prepS7();
  const out = {};
  await fresh('G6B X Keys', FLAT);
  await L.setRules('exact');
  await tp(CENTRE[0], 120, CENTRE[1]);
  const lots = S7.params.lots;
  const params = { ...S7.params, lots };
  const P = (extra = {}) => call('dev.region.plan', { program: S7.program, claim: CLAIM, params, surveyLoad: 'generated:64', check: false, bible: S7.bible, seed: S7.seed, ...extra }, 900_000);
  const p0 = await call('dev.region.plan', { program: S7.program, claim: CLAIM, params, surveyLoad: 'bounded:256', check: false, bible: S7.bible, seed: S7.seed }, 900_000);
  await prepare(p0.planId);
  // ---- plans
  const K = `steward.x${rid}.vplan`;
  const a = await P({ opKey: K });
  const b = await P({ opKey: K });
  check(!a.refused && a.planId && b.planId === a.planId && b.irSha === a.irSha, `keys: the same plan key and body returns the existing plan (${a.planId} / ${b.planId})`);
  const c = await P({ opKey: K, seed: '12345' });
  check(/^OP_KEY_CONFLICT: /.test(String(c.refused)), `keys: the same plan key with another body refuses OP_KEY_CONFLICT (${c.refused})`);
  const K2 = `steward.x${rid}.vplan2`;
  const [d1, d2] = await Promise.all([P({ opKey: K2 }), P({ opKey: K2 })]);
  check(!d1.refused && d1.planId === d2.planId, `keys: two calls with one key while the first still plans share one plan (${d1.planId} / ${d2.planId})`);
  const e = await P({ opKey: K, owner: 'test:other' });
  check(!e.refused && e.planId !== a.planId, `keys: the same key under another owner is another plan (${e.planId} vs ${a.planId})`);
  const f = await P();
  check(!f.refused && f.planId !== a.planId, `keys: a plan with no key is a new plan (${f.planId})`);
  const bad = await P({ opKey: 'has space' }).catch((x) => ({ refused: String(x.message ?? x) }));
  check(/opKey/.test(String(bad.refused)), `keys: a malformed key is refused (${String(bad.refused).slice(0, 100)})`);
  const pk = await api(`rplanbykey - ${K}`);
  check(pk?.planId === a.planId, `keys: Regions.planByKey finds it (${pk?.planId})`);
  check((await api(`rplanbykey - nokey.${rid}`)) === null, 'keys: planByKey of an unknown key is empty');
  out.plans = { a: a.planId, d: d1.planId, e: e.planId };
  // ---- realise: the future pending at a stop, the region found by key after the reload
  const R = `steward.x${rid}.vrealise`;
  const body = { planId: a.planId, lots: S7.lotEntries, opKey: R };
  await call('dev.region.holdRealise', { on: true });
  const pend = await api(`rrealise ${json({ ...body, tag: `x${rid}` })}`);
  let region = null;
  for (let i = 0; i < 120 && !region; i++) {
    region = (await api('rlist')).find((v) => v.planId === a.planId)?.id ?? null;
    if (!region) await sleep(500);
  }
  check(!!region, `keys: the realise wrote its region record (${region}) while its future is held`);
  const held = await api(`get ${pend.pending}`);
  check(held?.value === undefined || held.value === null, 'keys: the held realise future is still pending before the stop');
  const mid = await call('dev.region.state', { region }, 60_000);
  out.beforeStop = { state: mid.view.state, cells: mid.view.cellsWritten };
  await call('dev.world.leave', {}, 300_000);
  for (let i = 0; i < 600 && (await call('dev.state')).inWorld; i++) await sleep(500);
  await call('dev.world.open', { name: 'G6B X Keys' }, 30_000);
  await L.waitInWorld();
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  const after = await api(`get ${pend.pending}`);
  check(after?.value?.reason === 'WORLD_STOPPED', `keys: the pending realise future failed WORLD_STOPPED at the stop (${json(after?.value).slice(0, 160)})`);
  const found = await api(`rrealisebykey - ${R}`);
  check(found?.id === region, `keys: after the reload Regions.realiseByKey finds the interrupted realise (${found?.id}, ${found?.state})`);
  const pk2 = await api(`rplanbykey - ${K}`);
  check(pk2?.planId === a.planId, `keys: after the reload Regions.planByKey still finds the plan (${pk2?.planId})`);
  const done = await waitRegion(region, 3_600_000);
  check(done.view.state === 'PLACED' && done.view.lots.every((l) => l.state === 'placed'), `keys: the interrupted realise resumes and completes (${done.view.state}; ${done.view.lots.map((l) => l.state).join(',')})`);
  out.found = { id: found?.id, state: found?.state, done: done.view.state };
  // ---- a second realise with the same key
  const same = await result(await api(`rrealise ${json({ ...body, tag: `y${rid}` })}`));
  check(same?.region === region, `keys: a second realise with the same key and body returns the region (${same?.region})`);
  const regs = (await api('rlist')).filter((v) => v.planId === a.planId);
  check(regs.length === 1, `keys: and queued nothing (${regs.length} region of the plan)`);
  const other = await result(await api(`rrealise ${json({ ...body, force: true, tag: `z${rid}` })}`));
  check(other?.reason === 'OP_KEY_CONFLICT', `keys: the same key with another body refuses OP_KEY_CONFLICT (${json(other).slice(0, 200)})`);
  check((await api(`rrealisebykey - nokey.${rid}`)) === null, 'keys: realiseByKey of an unknown key is empty');
  // ---- the key ends with the region
  const rm = await call('dev.region.remove', { region }, 3_600_000);
  check(rm.removed && (await api(`rrealisebykey - ${R}`)) === null, 'keys: removing the region ends its key');
  const again = await result(await api(`rrealise ${json({ ...body, tag: `w${rid}` })}`));
  check(!!again?.region && again.region !== region, `keys: the key can be used again for a new region (${again?.region})`);
  const st3 = await waitRegion(again.region, 3_600_000);
  check(st3.view.state === 'PLACED', `keys: and it completes (${st3.view.state})`);
  await call('dev.region.remove', { region: again.region }, 3_600_000);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ C22: removal correctness

const hashBox = async (min, max) => (await call('dev.region.hash', { box: [...min, ...max] }, 3_600_000)).sha256;

steps.removal = async () => {
  await ensure();
  await prepS7();
  const out = {};
  await fresh('G6B X Removal', FLAT);
  await L.setRules('exact');
  await tp(CENTRE[0], 120, CENTRE[1]);
  const params = { ...S7.params };
  const P = (surveyLoad) => call('dev.region.plan', { program: S7.program, claim: CLAIM, params, surveyLoad, check: false, bible: S7.bible, seed: S7.seed }, 900_000);
  const p0 = await P('bounded:256');
  await prepare(p0.planId);
  const p = await P('generated:64');
  const yr = p.claimY ?? [-64, 64];
  const min = [CLAIM[0] - 8, yr[0] - 8, CLAIM[1] - 8], max = [CLAIM[2] + 8, yr[1] + 8, CLAIM[3] + 8];
  const h0 = await hashBox(min, max);
  // ---- (a) a restore breaks mid-removal; the retry finishes the pending restoration (or refuses); never removed over a diff
  const region = await L.realise(p.planId, { lots: S7.lotEntries });
  const st = await waitRegion(region, 3_600_000);
  check(st.view.state === 'PLACED', `removal: the region is placed (${st.view.state})`);
  await cmd('/kill @e[type=!minecraft:player]');
  await call('dev.undo.failRestore', { skip: 3 });
  const r1 = await call('dev.region.remove', { region }, 3_600_000);
  await call('dev.undo.failRestore', { skip: -1 });
  out.first = { removed: r1.removed, blockers: r1.blockers };
  check(r1.removed === false && /injected restore failure/.test(JSON.stringify(r1.blockers)), `removal (a): the removal with an injected restore failure answers removed=false (${JSON.stringify(r1.blockers).slice(0, 160)})`);
  const mid = await api(`rget ${region}`);
  check(mid?.state === 'PARTIAL', `removal (a): the region is not REMOVED after a failed removal (${mid?.state})`);
  await settle(3000);
  const hMid = await hashBox(min, max);
  check(hMid !== h0, 'removal (a): the world differs from the pre-placement snapshot after the failed removal (the control)');
  let r2 = await call('dev.region.remove', { region }, 3_600_000);
  out.retry = { removed: r2.removed, blockers: r2.blockers };
  await settle(5000);
  const h1 = await hashBox(min, max);
  out.diff = { h0: h0.slice(0, 12), h1: h1.slice(0, 12) };
  check(!(r2.removed && h1 !== h0), 'removal (a): never removed=true over a world diff');
  check((r2.removed && h1 === h0) || r2.removed === false, `removal (a): the retry finished the pending restoration and the diff is 0 (removed=${r2.removed}; hash ${h1 === h0 ? 'equal' : 'DIFFERS'})`);
  check(r2.removed === true && h1 === h0, 'removal (a): and it answered removed=true (the retry resumed, it did not refuse)');
  // ---- (b) a finished removal is recognisable: removed again, nothing written; REMOVED with its time, across a reload
  const reg2 = await L.realise(p.planId, { lots: S7.lotEntries });
  const st2 = await waitRegion(reg2, 3_600_000);
  check(st2.view.state === 'PLACED', `removal (b): the region is placed again (${st2.view.state})`);
  const g = (await api(`rget ${reg2}`)).groupId;
  await cmd('/kill @e[type=!minecraft:player]');
  const t0 = Date.now();
  const d1 = await call('dev.region.remove', { region: reg2 }, 3_600_000); // the answer is dropped
  await settle(5000);
  check(d1.removed === true, 'removal (b): the first removal answers removed=true');
  const hA = await hashBox(min, max);
  const tomb = await api(`rget ${reg2}`);
  check(tomb?.state === 'REMOVED' && tomb.removedAt >= t0 - 1000 && tomb.removedAt <= Date.now(), `removal (b): Regions.get shows REMOVED with its time (${tomb?.state}, ${tomb?.removedAt})`);
  const grp = await api(`sgroup ${g}`);
  check(grp?.state === 'REMOVED' && grp.removedAt > 0, `removal (b): the group lookup shows REMOVED with its time (${grp?.state}, ${grp?.removedAt})`);
  await cmd('/save-all flush');
  await leaveWorld();
  await openWorld('G6B X Removal');
  const tomb2 = await api(`rget ${reg2}`);
  const grp2 = await api(`sgroup ${g}`);
  check(tomb2?.state === 'REMOVED' && tomb2.removedAt === tomb.removedAt, `removal (b): the region tombstone survives save and reload with the same time (${tomb2?.state}, ${tomb2?.removedAt})`);
  check(grp2?.state === 'REMOVED' && grp2.removedAt === grp.removedAt, `removal (b): the group tombstone survives save and reload with the same time (${grp2?.removedAt})`);
  const again = await call('dev.region.remove', { region: reg2 }, 600_000);
  await settle(3000);
  const hB = await hashBox(min, max);
  check(again.removed === true && hB === hA && hA === h0, `removal (b): remove again after the reload answers removed=true and writes nothing (world hash ${hB === hA ? 'unchanged' : 'CHANGED'}, equals the pre-placement ${hA === h0})`);
  const gAgain = await result(await api(`sgremove ${g} noforce`), 120_000);
  check(gAgain?.removed === true, `removal (b): removing the removed group again answers removed=true (${json(gAgain).slice(0, 120)})`);
  const unknown = await call('dev.region.remove', { region: 'rg99999' }, 60_000).catch((e) => ({ error: String(e.message ?? e) }));
  check(!!unknown.error || unknown.refused, `removal (b): an unknown region id still refuses (${json(unknown).slice(0, 120)})`);
  await leaveWorld();
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 5: API compatibility

steps.apicompat = async () => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'api-compat.mjs'), '--gate6cx'], { cwd: root, encoding: 'utf8', env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25' } });
  const t = `${r.stdout}${r.stderr}`;
  fs.writeFileSync(path.join(OUT, 'api-compat.txt'), t);
  check(r.status === 0 && /all 4 checks clean/.test(t), `item 5: api-compat against the 0.16.0, 0.15.0 and 0.14.0 apitest jars and the 0.16.0 surface: ${t.trim().split('\n').pop()}`);
  // the apitest mod's own reflection check, in game, when a client is up
  if (state.dev || (await connect(5_000).then(() => true).catch(() => false))) {
    if (!(await call('dev.state')).inWorld) await openWorld(FLAT);
    const v = await api('api115');
    check(v.oldCtors === true && /^opKey opKey$/.test(v.trailing) && v.byKeyDefaults === true && v.features115?.length === 2 && v.lastReasons === 'PROTECTED FIELD_LIMIT',
      `item 5: apitest api115: old constructors kept, trailing opKey, default methods, no new Reason (${json(v)})`);
  }
  return { out: t };
};

steps.report = async () => {
  const rows = [];
  for (const s of ['unit', 'lotext', 'keys', 'removal', 'apicompat']) {
    const f = path.join(OUT, `${s}.json`);
    if (!fs.existsSync(f)) { rows.push(`| ${s} | not run | |`); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const res = Object.entries(j.results ?? {});
    const bad = res.filter(([, r]) => !r.ok);
    rows.push(`| ${s} | ${bad.length ? `**FAIL** ${bad.length}` : 'PASS'} (${res.length - bad.length}/${res.length}) | ${j.head?.slice(0, 10) ?? ''} |`);
    for (const [m, r] of res) rows.push(`| | ${r.ok ? 'ok' : 'FAIL'} | ${m.replaceAll('|', '/')} |`);
  }
  const spend = JSON.parse(fs.readFileSync(path.join(OUT, 'spend.json'), 'utf8'));
  const md = `# Gate 6c-X (region consumer asks C19 and C20)\n\nSpend: $${spend.totalUsd.toFixed(2)} (cap $${spend.capUsd}).\n\n| step | result | |\n|---|---|---|\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), md);
  return { lines: rows.length };
};

// ------------------------------------------------------------------ the main
const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6cx.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(2);
}
await run(name);
log(`== ${name}: ${fails()} failure(s)`);
try { state.dev?.close(); } catch { /* closed */ }
process.exit(fails() ? 1 : 0);
