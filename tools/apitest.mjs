#!/usr/bin/env node
// Phase 4a API checks (docs/CONTRACT.md "Phase 4a gate", the Java half) against a running dev client with the apitest mod
// (tools/run-apitest-client.sh, DevBridge on ARCHITECT_DEV_PORT). Everything goes through the apitest mod's /apitest
// command, which uses only dev.larattalabs.architect.api; DevBridge hooks are used only to feed a crate, aim the camera
// and take screenshots. No Claude: the stub sidecar "designs" by copying a bundled example.
//
//   node tools/apitest.mjs survival     in a survival world (the toggle on): sites, refusals, the actor rule, progress,
//                                       remove rules and refund, survey, designs/variants/library writes, a client preview
//                                       (against the stub sidecar, protocol 1, or the sim sidecar, protocol 2)
//   node tools/apitest.mjs jobs         jobs without Claude (tools/run-apitest-client.sh --sim: the real sidecar's sim
//                                       backend, started by the launcher): structured, an agent job with apitest's tools,
//                                       a tool call across a paused game, cancel, a budget stop, blobs from Java read by a
//                                       job, a resume after the sidecar is killed mid tool call, events on the server thread
//   node tools/apitest.mjs sets         phase 4b without Claude (--sim): a bible, a group of 3 with an anchor wave and a sidecar
//                                       restart mid-group (itemKey + ext round trip), the estimate, a soft-budget pause / extend /
//                                       resume, the group-wide usage hold, a re-skin, an open type with a profile, and
//                                       Sites.survival() / WORLD_MODE_CHANGED in a fresh creative and a fresh survival world
//
// Evidence goes to artifacts/apitest/<step>.json (APITEST_OUT overrides), screenshots to the client's ARCHITECT_SHOTS_DIR.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.APITEST_OUT ? path.resolve(process.env.APITEST_OUT) : path.join(root, 'artifacts', 'apitest');
fs.mkdirSync(OUT, { recursive: true });
const OWNER = 'apitest:village/1';
const API_VERSION = '1.2.0';
// the dev client's game dir (tools/run-apitest-client.sh runs it in mod/)
const GAME_DIR = process.env.APITEST_GAME_DIR ? path.resolve(process.env.APITEST_GAME_DIR) : path.join(root, 'mod', 'run');
const SIDECAR_DATA = path.join(GAME_DIR, 'architect', 'sidecar-data');

const step = process.argv[2];
const dev = await DevClient.connect({ timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failures = 0;
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const cmd = async (c, asPlayer = false) => {
  const r = await call('dev.command', { cmd: c, asPlayer });
  return r;
};
/** Runs /apitest <args> and parses its one JSON line. */
const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args}: no JSON answer: ${JSON.stringify(r)}`);
  return JSON.parse(line);
};
/** An async step: waits until /apitest get <key> has a value. */
const result = async (pending, timeoutMs = 30_000) => {
  const key = pending.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) {
      return typeof r.value === 'object' && !Array.isArray(r.value) ? { ...r.value, _thread: r.thread?.completedOn } : { value: r.value, _thread: r.thread?.completedOn };
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${key}`);
};
const events = async () => api('events');
const waitEvent = async (pred, timeoutMs = 30_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const e = (await events()).find(pred);
    if (e) return e;
    await sleep(300);
  }
  return null;
};

async function groundAt(x, z) {
  let s;
  for (let i = 0; i < 40; i++) {
    s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
    if (s.columns?.length) break;
    await sleep(500); // a chunk the player just reached
  }
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  if (!m) throw new Error(`no ground at ${x},${z}: ${JSON.stringify(s)}`);
  return Number(m[1]);
}

/** A spot whose cabin footprint (13x11, plus approach) is fairly flat: the median of a few columns. */
async function spot(x, z) {
  const s = await result(await api(`survey ${x} ${z} ${x + 12} ${z + 16} 4`));
  const ys = [];
  for (const [dx, dz] of [[0, 0], [12, 0], [0, 16], [12, 16], [6, 8]]) ys.push(await groundAt(x + dx, z + dz));
  ys.sort((a, b) => a - b);
  return { x, y: ys[2], z, ys, coarse: s.resolution };
}

/** A client preview through the API, with a screenshot, then cleared. */
async function preview(px, pz) {
  const P = await spot(px + 24, pz + 20);
  await api(`preview cabin ${P.x} ${P.y} ${P.z}`);
  await sleep(1500);
  const pv = await api('get preview');
  check(pv.value?.previewing === true && pv.value?.thread === 'Render thread', `ArchitectClientApi.preview on the client thread (${JSON.stringify(pv.value)})`, pv);
  await call('dev.camera', { x: P.x + 6, y: P.y + 48, z: P.z + 36, lookAt: { x: P.x + 6, y: P.y + 2, z: P.z + 7 }, mode: 'spectator' }).catch((e) => console.log('camera:', e.message));
  await sleep(1500);
  const shot = await call('dev.screenshot', { name: 'apitest-preview', hideHud: false }, 120_000);
  check(!!shot.path, `screenshot ${shot.path}`, shot);
  await api('preview clear');
  await sleep(500);
  const cleared = await api('get preview');
  check(cleared.value?.previewing === false, 'clearPreview');
}

switch (step) {
  case 'preview': {
    const p = (await call('dev.state')).player;
    await preview(Math.floor(p.x), Math.floor(p.z));
    break;
  }
  case 'survival': {
    // a fixed home (camera moves of an earlier run carry the player away): onto the ground at APITEST_HOME (x,z)
    const [hx, hz] = (process.env.APITEST_HOME ?? '150,60').split(',').map(Number);
    await call('dev.release', { mode: 'keep' }).catch(() => null);
    await cmd('/gamemode spectator @a');
    await cmd(`/tp @a ${hx} 200 ${hz}`);
    await sleep(1000);
    await call('dev.waitChunks', {}, 40_000).catch(() => null);
    await cmd(`/tp @a ${hx} ${(await groundAt(hx, hz)) + 1} ${hz}`);
    const st = await call('dev.state');
    const p = st.player;
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    const pz = Math.floor(p.z);
    for (const c of ['/gamemode survival @a', '/gamerule advance_time false', '/time set 6000', '/gamerule spawn_mobs false', '/kill @e[type=!player]', '/kill @e[type=item]']) await cmd(c);
    await api('clear');
    // a rerun in the same world: take down what an earlier run left
    for (const old of (await api('sites')).all) await cmd(`/architect remove ${old.id} force`);

    // ---- version, features, jobs stub
    const v = await api('version');
    check(v.version === API_VERSION, `ArchitectApi.VERSION ${v.version}`, v);
    const p2 = v.features.includes('protocol2');
    const jobFeatures = ['jobs', 'jobTools', 'blobs'];
    check(['designs', 'events', 'library', 'sites', 'survey'].every((f) => v.features.includes(f))
      && (p2 ? jobFeatures.every((f) => v.features.includes(f)) : !jobFeatures.some((f) => v.features.includes(f))),
      `features() against a protocol-${p2 ? 2 : 1} sidecar: ${v.features.join(', ')}`, v.features);
    const jobs = await result(await api('jobs'));
    if (p2) check(v.jobsAvailable === true && /^j\d+$/.test(jobs.value ?? ''), `jobs: available() true, run() -> ${jobs.value ?? jobs.error}`, jobs);
    else check(v.jobsAvailable === false && /protocol 2/.test(jobs.error ?? ''), `jobs: available() false, run() refused (${jobs.error})`, jobs);

    // ---- place a construction site through the API with an owner and ext (AUTO in a survival world)
    const A = await spot(px + 24, pz - 8);
    const placeA = await result(await api(`place cabin ${A.x} ${A.y} ${A.z} AUTO owned actor`));
    check(placeA.placed === true && /^s\d+$/.test(placeA.siteId), `API place (AUTO, owner, ext): ${JSON.stringify(placeA)}`, placeA);
    const siteA = placeA.siteId;
    const evA = await waitEvent((e) => e.event === 'SITE_PLACED' && e.id === siteA);
    check(!!evA && evA.owner === OWNER && evA.ext?.['apitest:lot'] === 'L1' && evA.ext?.['apitest:data']?.plan === 7 && evA.state === 'BUILDING',
      `SITE_PLACED with owner and ext, state ${evA?.state}, on ${evA?.serverThread}`, evA);
    check(placeA._thread === 'Server thread', `the place future completed on the server thread (${placeA._thread})`);
    const sites = await api('sites');
    check(sites.owned.some((s) => s.id === siteA) && !sites.players.some((s) => s.id === siteA), 'Sites.list(owner) finds it; list(null) does not', sites);

    // ---- typed refusals
    const inBox = await result(await api(`place cabin ${px - 6} ${py - 1} ${pz - 6} AUTO unowned actor`));
    check(!inBox.placed && inBox.refusals.some((r) => r.reason === 'PLAYER_IN_BOX'), `refused PLAYER_IN_BOX: ${inBox.refusals.map((r) => r.reason).join(', ')}`, inBox);
    const over = await result(await api(`place cabin ${A.x + 3} ${A.y} ${A.z + 2} AUTO unowned actor`));
    check(!over.placed && over.refusals.some((r) => r.reason === 'OVERLAP'), `refused OVERLAP: ${over.refusals.map((r) => r.reason).join(', ')}`, over);
    const failed = (await events()).filter((e) => e.event === 'PLACE_FAILED');
    check(failed.length >= 2 && failed.some((e) => e.refusals.some((r) => r.reason === 'OVERLAP')), `PLACE_FAILED fired for both (${failed.length})`, failed);
    // the UI's own refusal (the client sees the player inside the ghost and never asks the server) fires PLACE_FAILED too
    const nFailed = failed.length;
    await call('dev.build.start', { blueprint: 'cabin', origin: [px - 6, py - 1, pz - 5] });
    await sleep(800);
    const uiConfirm = await call('dev.build.confirm', {});
    await call('dev.build.cancel', {});
    let uiFailed = null;
    for (let i = 0; i < 20 && !uiFailed; i++) {
      await sleep(250);
      uiFailed = (await events()).filter((e) => e.event === 'PLACE_FAILED')[nFailed] ?? null;
    }
    check(uiConfirm.lastResult?.placed === false && uiFailed?.mode === 'AUTO' && uiFailed.refusals.some((r) => r.reason === 'PLAYER_IN_BOX'),
      `the placement UI's "player inside" refusal fires PLACE_FAILED (${uiFailed?.serverThread})`, { uiConfirm: uiConfirm.lastResult, uiFailed });
    const chk = await api(`check cabin ${A.x + 3} ${A.y} ${A.z + 2} AUTO unowned actor`);
    check(!chk.ok && chk.refusals.some((r) => r.reason === 'OVERLAP') && chk.construction === true && Object.keys(chk.bom).length > 0,
      `Sites.check (dry run): OVERLAP, construction, BOM of ${Object.keys(chk.bom).length} items`, chk);

    // ---- the actor rule: INSTANT in a survival world
    const B = await spot(px - 40, pz - 8);
    const noActor = await result(await api(`place cabin ${B.x} ${B.y} ${B.z} INSTANT unowned noactor`));
    check(!noActor.placed && noActor.refusals[0]?.reason === 'NOT_ALLOWED', `INSTANT without an actor: ${noActor.refusals.map((r) => r.reason)}`, noActor);
    const withOp = await result(await api(`place cabin ${B.x} ${B.y} ${B.z} INSTANT unowned actor`));
    check(withOp.placed === true, `INSTANT with an op actor: placed ${withOp.siteId}`, withOp);
    const evB = await waitEvent((e) => e.event === 'SITE_PLACED' && e.id === withOp.siteId);
    check(evB?.state === 'BUILT', `an instant site (state ${evB?.state})`, evB);

    // ---- the UI: an owned site shows "owned by", and Remove asks twice (the UI's remove fires SITE_REMOVED too)
    const C = await spot(px - 40, pz + 24);
    const placeC = await result(await api(`place cabin ${C.x} ${C.y} ${C.z} INSTANT owned actor`));
    check(placeC.placed === true, `an owned instant site for the UI check: ${placeC.siteId}`, placeC);
    await call('dev.ui.open', { tab: 'library' });
    await sleep(400);
    await call('dev.ui.click', { control: 'library:placed' });
    await sleep(400);
    await call('dev.ui.click', { control: `site:${placeC.siteId}` }).catch(() => null); // the newest site is selected anyway
    await sleep(500);
    const placedShot = await call('dev.screenshot', { name: 'apitest-placed-owned', waitChunks: false }, 60_000);
    await call('dev.ui.click', { control: 'remove' });
    await sleep(1000);
    const lib1 = await call('dev.library.state');
    const still = (await api('sites')).all.some((s) => s.id === placeC.siteId);
    check(still && /owned by apitest/.test(lib1.message ?? ''), `the first Remove click only asks: "${lib1.message}"`, { message: lib1.message, shot: placedShot.path });
    const askShot = await call('dev.screenshot', { name: 'apitest-placed-confirm', waitChunks: false }, 60_000);
    await call('dev.ui.click', { control: 'remove' });
    const uiRemoved = await waitEvent((e) => e.event === 'SITE_REMOVED' && e.id === placeC.siteId, 20_000);
    check(!!uiRemoved && !(await api('sites')).all.some((s) => s.id === placeC.siteId), `the second click removes it; SITE_REMOVED from the UI (${uiRemoved?.serverThread})`,
      { shots: [placedShot.path, askShot.path] });
    await call('dev.screen', { open: null });

    // ---- SITE_PROGRESS and SITE_BUILT: feed the crate
    const ss = await call('dev.site.state', { site: siteA });
    const ins = await call('dev.crate.insert', { site: siteA, items: ss.bom });
    const built = await waitEvent((e) => e.event === 'SITE_BUILT' && e.id === siteA, 240_000);
    const prog = (await events()).filter((e) => e.event === 'SITE_PROGRESS' && e.id === siteA);
    const gaps = prog.slice(1).map((e, i) => e.t - prog[i].t);
    check(!!built && built.state === 'BUILT', `SITE_BUILT after feeding ${ss.bomTotal} items`, { built, inserted: ins });
    check(prog.length >= 2 && gaps.every((g) => g >= 950) && prog.every((e) => e.built <= e.queued),
      `SITE_PROGRESS ${prog.length}x, at most 1/s (min gap ${Math.min(...gaps)} ms), built ${prog.map((e) => e.built).slice(0, 5).join(',')}...`, prog.slice(0, 5));

    // ---- remove: another requester without force, then the owner (refund in survival)
    const other = await result(await api(`remove ${siteA} other_mod:x noforce`));
    check(!other.removed && /owned by apitest:village\/1/.test(other.blockers[0] ?? ''), `remove from another requester refused: ${other.blockers[0]}`, other);
    const mine = await result(await api(`remove ${siteA} ${OWNER} noforce`), 60_000);
    check(mine.removed === true && mine.refundTotal > 0, `remove by the owner: refund ${mine.refundTotal} items (${Object.keys(mine.refund).length} kinds)`, mine);
    const evR = await waitEvent((e) => e.event === 'SITE_REMOVED' && e.id === siteA);
    check(!!evR && evR.result.refundTotal === mine.refundTotal, 'SITE_REMOVED with the same RemoveResult', evR);
    const rmB = await result(await api(`remove ${withOp.siteId} - noforce`), 60_000);
    check(rmB.removed === true && rmB.refundTotal === 0, `the player's own instant site removes with no requester, no refund (${rmB.refundTotal})`, rmB);

    // ---- survey
    const s1 = await result(await api(`survey ${px - 32} ${pz - 32} ${px + 31} ${pz + 31} 1`), 60_000);
    check(s1.resolution === 1 && s1.width === 64 && s1.depth === 64 && s1.missing === 0, `survey 64x64 at 1: ${s1.ms} ms, ${s1.biomes.join(',')}, natural ${s1.natural}/4096, water ${s1.water}, trees ${s1.tree}`, s1);
    const s2 = await result(await api(`survey ${px - 400} ${pz - 150} ${px + 400} ${pz + 150} 1`), 120_000);
    check(s2.resolution === 4 && s2.missing > 0 && s2.missingChunks > 0 && s2.chunksLoaded === 0,
      `survey 801x301 asked at 1 runs at 4: ${s2.width}x${s2.depth}, ${s2.missingChunks} unloaded chunks reported missing, in ${s2.ms} ms`, { ...s2, summary: undefined });
    const s3 = await result(await api(`survey ${px + 600} ${pz} ${px + 663} ${pz + 63} 4 bounded:2`), 120_000);
    check(s3.chunksLoaded === 2 && s3.missingChunks > 0 && s3.missing > 0, `LOAD_BOUNDED(2): loaded 2, ${s3.missingChunks} missing`, { ...s3, summary: undefined });
    console.log(s1.summary.split('\n').slice(0, 6).join('\n'));

    // ---- designs and the library through the API (stub sidecar)
    const dId = await result(await api('design ApiCabin'));
    check(/^d\d+$/.test(dId.value ?? '') && dId._thread === 'Server thread', `design request acked: ${dId.value} (on ${dId._thread})`, dId);
    const done = await waitEvent((e) => e.event === 'DESIGN_DONE', 60_000);
    check(!!done && done.status === 'DONE' && done.owner === OWNER && !!done.entryId, `DESIGN_DONE ${done?.id} -> ${done?.entryId}, owner ${done?.owner}`, done);
    const entry = done?.entryId ? await api(`entry ${done.entryId}`) : null;
    check(entry?.ext?.['apitest:request'] === 'r1' && entry?.ext?.['apitest:lot'] === 'L2', `the request's ext landed on the entry: ${JSON.stringify(entry?.ext)}`, entry);
    const listed = await api(`designs ${OWNER}`);
    check(listed.some((d) => d.id === done?.id), `Designs.list(owner) has it (${listed.length})`, listed);
    const upd = (await events()).filter((e) => e.event === 'DESIGN_UPDATED' && e.id === done?.id);
    check(upd.length >= 3, `DESIGN_UPDATED ${upd.length}x (${upd.map((e) => e.status).join(' > ')})`);

    const variant = await result(await api(`variant ${done.entryId} birch`), 60_000);
    check(variant.variantOf === done.entryId && variant.ext?.['apitest:request'] === 'r1', `Library.makeVariant -> ${variant.id} (variant of ${variant.variantOf}, ext kept)`, variant);
    const vEv = await waitEvent((e) => e.event === 'VARIANT_DONE' && e.id === variant.id);
    check(!!vEv, 'VARIANT_DONE fired', vEv);
    const setext = await api(`setext ${variant.id} apitest:color "red"`);
    check(setext.ext?.['apitest:color'] === 'red', `setExt: ${JSON.stringify(setext.ext)}`, setext);
    const unset = await api(`setext ${variant.id} apitest:color null`);
    check(unset.ext?.['apitest:color'] === undefined, 'setExt null removes the key');
    const badKey = await api(`setext ${variant.id} color "x"`);
    check(/namespaced/.test(badKey.error ?? ''), `setExt refuses a key without a namespace (${badKey.error})`);
    const bundled = await api('setext cabin apitest:x 1');
    check(/bundled/.test(bundled.error ?? ''), `setExt refuses a bundled entry (${bundled.error})`);
    await api(`settags ${variant.id} api test_tag`);
    await sleep(2000);
    const tagged = await api(`entry ${variant.id}`);
    check(tagged.tags.includes('api') && tagged.tags.includes('test_tag'), `setTags: ${tagged.tags.join(', ')}`, tagged);
    const del = await result(await api(`delete ${variant.id}`), 30_000);
    const gone = await api(`entry ${variant.id}`);
    check(del.value === true, `delete -> ${del.value}`);
    check(gone === null, 'the deleted entry is gone from the library');
    const delBundled = await result(await api('delete cabin'));
    check(delBundled.value === false, `delete of a bundled entry refuses (${delBundled.value})`);

    await preview(px, pz);
    results.events = await events();
    break;
  }
  case 'jobs': {
    // against the real sidecar with its sim backend, started by the game's launcher (tools/run-apitest-client.sh --sim)
    const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const logFile = path.join(GAME_DIR, 'logs', 'latest.log');
    const logSize = () => (fs.existsSync(logFile) ? fs.statSync(logFile).size : 0);
    const logSince = (from) => {
      if (!fs.existsSync(logFile)) return '';
      const b = fs.readFileSync(logFile);
      return b.subarray(Math.min(from, b.length)).toString('utf8');
    };
    const jobDone = async (id, timeoutMs = 60_000) => waitEvent((e) => e.event === 'JOB_DONE' && e.id === id, timeoutMs);
    const toolstats = () => api('toolstats');
    const waitCalled = async (tool, calls, timeoutMs = 30_000) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const s = await toolstats();
        if ((s[tool]?.calls ?? 0) >= calls) return s;
        await sleep(100);
      }
      return null;
    };
    const run = async (spec, blobs) => {
      const r = await result(await api(`jobrun ${spec}${blobs ? ` ${blobs.join(',')}` : ''}`));
      if (!/^j\d+$/.test(r.value ?? '')) throw new Error(`jobrun ${spec}: ${JSON.stringify(r)}`);
      return { id: r.value, thread: r._thread };
    };
    const resultJson = (ev) => {
      try {
        return JSON.parse(ev?.result?.text ?? 'null');
      } catch {
        return null;
      }
    };

    await api('clear');
    const launcher = await call('dev.launcher.state');
    const v = await api('version');
    check(v.version === API_VERSION && v.jobsAvailable === true && ['protocol2', 'jobs', 'jobTools', 'blobs'].every((f) => v.features.includes(f)),
      `VERSION ${v.version}, jobs available, features ${v.features.join(', ')}`, v);
    check(launcher.startedByUs === true && launcher.reused === false && launcher.source === 'dev' && launcher.pid > 0,
      `the launcher started the sidecar (pid ${launcher.pid}, source ${launcher.source}, reused ${launcher.reused})`, launcher);
    const snapshotJobs = (await call('dev.sidecar.state')).jobs ?? [];

    // ---- a structured job
    const st = await run('structured');
    check(st.thread === 'Server thread', `run() completed on the server thread with ${st.id} (${st.thread})`);
    const stDone = await jobDone(st.id);
    const card = stDone?.result;
    check(stDone?.status === 'done' && typeof card?.name === 'string' && card.name.length > 0 && Number.isInteger(card?.floors) && card.floors >= 1,
      `structured job ${st.id} done: ${JSON.stringify(card)}`, stDone);
    check(stDone?.cost?.usd > 0 && stDone.cost.cacheReadTokens > 0, `cost ${JSON.stringify(stDone?.cost)} (sim estimate, cache tokens)`);
    const stUpd = (await events()).filter((e) => e.event === 'JOB_UPDATED' && e.id === st.id);
    check(stUpd.length >= 2, `JOB_UPDATED ${stUpd.length}x (${stUpd.map((e) => e.status).join(' > ')})`);
    const listed = await api('joblist apitest');
    check(listed.some((j) => j.id === st.id) && (await api('joblist nobody')).length === 0, `Jobs.list(owner): ${listed.length} of apitest, none of nobody`);
    const got = await api(`job ${st.id}`);
    check(got?.status === 'done' && got.tag === 'apitest-structured', `Jobs.get(${st.id}): ${got?.status}`, got);

    // ---- an agent job: the survey summary, thread choice, a missing handler, a big answer as a blob
    const ag = await run('agent');
    const agDone = await jobDone(ag.id, 90_000);
    const out = resultJson(agDone);
    const by = Object.fromEntries((out?.results ?? []).map((r) => [r.tool, r]));
    check(agDone?.status === 'done' && out?.results?.length === 5, `agent job ${ag.id} done with ${out?.results?.length} tool results`, agDone);
    check(/height|ascii|grid|\d/i.test(by.survey?.result?.summary ?? '') && by.survey?.result?.ranOn === 'Server thread',
      `survey tool: a ${by.survey?.result?.width}x${by.survey?.result?.depth} summary, handler on ${by.survey?.result?.ranOn}`, by.survey);
    check(by.fast?.result?.ranOn && by.fast.result.ranOn !== 'Server thread', `readOnly + threadSafe tool ran on a worker (${by.fast?.result?.ranOn})`);
    check(by.slowro?.result?.ranOn === 'Server thread', `readOnly but not thread-safe ran on the server thread (${by.slowro?.result?.ranOn})`);
    check(by.missing?.error === 'no handler for missing in this game', `no handler: "${by.missing?.error}"`);
    const bigBlob = by.big?.result?.blob;
    const bigFile = bigBlob ? path.join(SIDECAR_DATA, 'blobs', bigBlob) : null;
    const bigRows = bigFile && fs.existsSync(bigFile) ? JSON.parse(fs.readFileSync(bigFile, 'utf8')).rows?.length : 0;
    check(!!bigBlob && by.big.result.bytes > 256 * 1024 && bigRows === 6000, `a ${by.big?.result?.bytes}-byte answer went as blob ${bigBlob} (${bigRows} rows on disk)`, by.big);

    // ---- a job result over 256 KB: the sidecar puts it in a blob (resultBlob); the mod reads it back before JOB_DONE
    const br = await run('bigresult');
    const brDone = await jobDone(br.id, 60_000);
    const brGot = await api(`job ${br.id}`);
    check(brDone?.status === 'done' && /^b/.test(brDone.resultBlob ?? '') && brDone.resultBytes > 256 * 1024 && brGot?.resultBytes === brDone.resultBytes,
      `job ${br.id}: a ${brDone?.resultBytes}-byte result came as blob ${brDone?.resultBlob} and is in JOB_DONE and Jobs.get().result()`,
      { ...brDone, result: undefined });

    // ---- a tool call across a paused game: tool timeout 10 s, the game paused 15 s while the handler waits for 60 ticks
    const pz = await run('paused');
    const called = await waitCalled('tickwait', 1);
    await call('dev.screen', { open: 'pause' });
    await sleep(500);
    const ps = await call('dev.state');
    const t0 = (await api('ticks')).ticks;
    await sleep(15_000);
    const t1 = (await api('ticks')).ticks;
    const mid = await api(`job ${pz.id}`);
    check(ps.paused === true && t1 === t0 && mid?.status === 'waiting_tool', `paused 15 s: dev.state.paused ${ps.paused}, server ticks ${t0} -> ${t1}, job ${mid?.status}`);
    await call('dev.screen', { open: null });
    const pzDone = await jobDone(pz.id, 60_000);
    const pzOut = resultJson(pzDone);
    const tw = (await toolstats()).tickwait;
    const waited = tw.answeredAt - tw.calledAt;
    check(pzDone?.status === 'done' && pzOut?.results?.[0]?.result?.tickwait === 60 && !pzOut.results[0].error,
      `the job completed after the unpause: ${JSON.stringify(pzOut?.results?.[0])}`, pzDone);
    check(!!called && waited > 10_000, `the call took ${waited} ms of wall time, past its 10 s timeout, and did not time out`);

    // ---- cancel: a job whose tool is held; the late answer is dropped ("no pending tool call")
    const holdsBefore = (await toolstats()).hold?.calls ?? 0;
    const cj = await run('hold');
    await waitCalled('hold', holdsBefore + 1);
    const logMark = logSize();
    await api(`jobcancel ${cj.id}`);
    const cjDone = await jobDone(cj.id, 30_000);
    check(cjDone?.status === 'cancelled', `job ${cj.id} cancelled while its tool was held (${cjDone?.status})`, cjDone);
    await api('release');
    await sleep(1500);
    const dropped = /tool call \S+ of job \S+ is no longer pending; answer dropped/.test(logSince(logMark));
    check(dropped, 'the late answer to the cancelled job was dropped (ok:false "no pending tool call")');

    // ---- a budget stop: $0.01 per sim step, a budget of $0.015
    const bj = await run('budget');
    const bjDone = await jobDone(bj.id, 60_000);
    check(bjDone?.status === 'failed' && bjDone.error === 'budget' && bjDone.cost.usd >= 0.015, `budget stop: ${bjDone?.status}, error ${bjDone?.error}, cost $${bjDone?.cost?.usd}`, bjDone);

    // ---- blobs from Java: a 2.5 MB binary (3 frames of chunks) and a survey sample as JSON, read by a job from its scratch dir
    const bin = await result(await api('blobput bin 2621440'), 60_000);
    const sv = await result(await api('blobput survey'), 60_000);
    check(/^b/.test(bin.blobId ?? '') && bin.thread === 'Server thread' && /^b/.test(sv.blobId ?? ''), `putBlob: binary ${bin.blobId} (${bin.bytes} bytes), survey ${sv.blobId} (${sv.bytes} bytes), on ${bin.thread}`, { bin, sv });
    const blj = await run('structured', [bin.blobId, sv.blobId]);
    const bljDone = await jobDone(blj.id);
    const scratch = path.join(SIDECAR_DATA, 'jobs', blj.id, 'blobs');
    const binCopy = path.join(scratch, `${bin.blobId}.bin`);
    const svCopy = path.join(scratch, `${sv.blobId}.json`);
    const binSha = fs.existsSync(binCopy) ? sha(fs.readFileSync(binCopy)) : null;
    const svJson = fs.existsSync(svCopy) ? JSON.parse(fs.readFileSync(svCopy, 'utf8')) : null;
    check(bljDone?.status === 'done' && binSha === bin.sha256, `job ${blj.id} got the binary blob in its scratch dir, SHA-256 matches (${binSha?.slice(0, 12)})`);
    check(svJson && JSON.stringify(svJson).length > 1000 && (svJson.width === sv.width || svJson.resolution !== undefined),
      `the survey blob is ${svCopy.split('/').slice(-2).join('/')} (width ${svJson?.width}, ${Object.keys(svJson ?? {}).length} keys)`);

    // ---- resume after a sidecar restart mid tool call: kill it, the launcher restarts it, the cached answer is re-sent
    const holds0 = (await toolstats()).hold?.calls ?? 0;
    const rj = await run('hold');
    await waitCalled('hold', holds0 + 1);
    const pid = (await call('dev.launcher.state')).pid;
    process.kill(pid, 'SIGKILL');
    let link = 'synced';
    for (let i = 0; i < 50 && link === 'synced'; i++) {
      await sleep(200);
      link = (await call('dev.sidecar.state')).link;
    }
    const rel = await api('release'); // the handler answers while the helper is down: the answer is cached
    await sleep(1000);
    const logMark2 = logSize();
    await call('dev.launcher.restart');
    const rjDone = await jobDone(rj.id, 90_000);
    const after = await call('dev.launcher.state');
    const rOut = resultJson(rjDone);
    const holds1 = (await toolstats()).hold?.calls ?? 0;
    check(rel.released === true && link !== 'synced', `killed the sidecar (pid ${pid}) mid call; link ${link}; the handler answered while it was down`);
    check(after.pid !== pid && after.startedByUs === true, `the launcher restarted it (pid ${after.pid})`, after);
    check(rjDone?.status === 'done' && rOut?.results?.[0]?.result?.held === true, `job ${rj.id} resumed and finished with the held answer: ${JSON.stringify(rOut?.results?.[0])}`, rjDone);
    check(holds1 === holds0 + 1, `the handler ran once (${holds0} -> ${holds1}); the re-sent call got the cached answer`);
    check(/re-sent tool call \S+ \(hold\): sending the cached answer/.test(logSince(logMark2)), 'the log shows the cached answer re-sent');

    // ---- the same, but the handler still runs when the call comes again: it is not run twice, its answer goes out later
    const holds2 = (await toolstats()).hold?.calls ?? 0;
    const rj2 = await run('hold');
    await waitCalled('hold', holds2 + 1);
    const pid2 = (await call('dev.launcher.state')).pid;
    process.kill(pid2, 'SIGKILL');
    for (let i = 0, l = 'synced'; i < 50 && l === 'synced'; i++) {
      await sleep(200);
      l = (await call('dev.sidecar.state')).link;
    }
    await sleep(500);
    const logMark3 = logSize();
    await call('dev.launcher.restart');
    let resentWhileRunning = false;
    for (let i = 0; i < 100 && !resentWhileRunning; i++) {
      await sleep(200);
      resentWhileRunning = /re-sent tool call \S+ \(hold\): its handler is still running/.test(logSince(logMark3));
    }
    await api('release');
    const rj2Done = await jobDone(rj2.id, 90_000);
    const holds3 = (await toolstats()).hold?.calls ?? 0;
    check(resentWhileRunning && rj2Done?.status === 'done' && resultJson(rj2Done)?.results?.[0]?.result?.held === true && holds3 === holds2 + 1,
      `re-sent while its handler still ran: not run again (${holds2} -> ${holds3}), answered on release, job ${rj2.id} ${rj2Done?.status}`, rj2Done);

    // ---- events: on the server thread, DONE once per job (the reconnect snapshots did not fire it again)
    const all = await events();
    const jobEvents = all.filter((e) => e.event.startsWith('JOB_'));
    const doneCounts = {};
    for (const e of jobEvents.filter((x) => x.event === 'JOB_DONE')) doneCounts[e.id] = (doneCounts[e.id] ?? 0) + 1;
    check(jobEvents.length > 0 && jobEvents.every((e) => e.serverThread === 'Server thread'), `${jobEvents.length} JOB_ events, all on the server thread`);
    check(Object.values(doneCounts).every((n) => n === 1), `JOB_DONE once per job: ${JSON.stringify(doneCounts)}`);
    const preexisting = snapshotJobs.filter((j) => ['done', 'failed', 'cancelled'].includes(j.status)).map((j) => j.id);
    check(!preexisting.some((id) => doneCounts[id]), `no JOB_DONE for the ${preexisting.length} jobs finished before this run`);
    results.events = jobEvents;
    break;
  }
  case 'sets': {
    // phase 4b through the API (docs/CONTRACT.md "Phase 4b gate" and "4b review folded in", the Java half), against the real
    // sidecar's sim backend (tools/run-apitest-client.sh --sim; no Claude): a bible, a group of 3 with an anchor wave surviving a
    // sidecar restart, the estimate, a soft-budget pause / extend / resume, the group-wide usage hold, a re-skin, an open type,
    // and the survival toggle in a creative and a survival world. The sim's steps are slowed and priced through
    // <data>/config.json (restored after).
    const cfgFile = path.join(SIDECAR_DATA, 'config.json');
    const oldCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const restart = async () => {
      await call('dev.launcher.restart');
      for (let i = 0; i < 100; i++) {
        await sleep(300);
        if ((await call('dev.sidecar.state')).link === 'synced' && (await call('dev.launcher.state')).state === 'running') return;
      }
      throw new Error('the helper did not come back');
    };
    const waitWorld = async () => {
      for (let i = 0; i < 300; i++) {
        await sleep(500);
        const s = await call('dev.state').catch(() => null);
        if (s?.inWorld && s.ready) return s;
      }
      throw new Error('the world did not load');
    };
    const groupDone = (id, ms = 180_000) => waitEvent((e) => e.event === 'GROUP_DONE' && e.id === id, ms);
    const SIZE = [21, 30, 21];
    fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 1200, simDesignUsd: 0.1, simLimitMs: 8000, designConcurrency: 3 }));
    try {
      await restart();
      await api('clear');
      const v = await api('version');
      check(v.version === API_VERSION && ['bibles', 'designGroups', 'namedParts', 'openTypes', 'estimates', 'reskin', 'survivalInfo'].every((f) => v.features.includes(f)),
        `VERSION ${v.version}, 4b features: ${v.features.filter((f) => !['sites', 'events', 'designs', 'library', 'survey'].includes(f)).join(', ')}`, v);

      // ---- a bible from a prompt (sim): BIBLE_DONE with its sheet
      const bj = await result(await api(`bible ${tag} ${b64({ prompt: 'ash-grey mining hamlet under a red sky', name: `Ashfall ${tag}` })}`), 30_000);
      check(/^b\d+$/.test(bj.id ?? '') && /^bib_/.test(bj.bibleId ?? '') && bj._thread === 'Server thread',
        `Bibles.request -> job ${bj.id} for ${bj.bibleId} v${bj.version} (${bj.status}, on ${bj._thread})`, bj);
      const bDone = await waitEvent((e) => e.event === 'BIBLE_DONE' && e.id === bj.id, 180_000);
      check(bDone?.status === 'DONE' && bDone.bible?.sheetExists === true && bDone.serverThread === 'Server thread',
        `BIBLE_DONE ${bj.id}: ${bDone?.step}; sheet ${bDone?.bible?.sheetPath}`, bDone);
      const bUpd = (await events()).filter((e) => e.event === 'BIBLE_UPDATED' && e.id === bj.id);
      check(bUpd.length >= 2, `BIBLE_UPDATED ${bUpd.length}x (${[...new Set(bUpd.map((e) => e.status))].join(' > ')})`);
      const bible = await api(`bibleget ${bj.bibleId}`);
      check(bible?.sheetExists && bible.version === 1 && Object.keys(bible.roles ?? {}).length >= 8 && bible.components.length >= 5 && bible.owner === OWNER
        && bible.ext?.['apitest:bible'] === tag && bible.proseChars > 0,
        `Bibles.get(${bj.bibleId}): v${bible?.version}, ${Object.keys(bible?.roles ?? {}).length} roles, ${bible?.components?.length} components, owner ${bible?.owner}, prose ${bible?.proseChars} chars`, bible);
      const mine = await api(`bibles ${OWNER}`);
      const allB = await api('bibles -');
      check(mine.some((b) => b.id === bj.bibleId) && allB.some((b) => b.builtin && b.id === 'oak') && !mine.some((b) => b.builtin),
        `Bibles.list(owner): ${mine.length} of apitest; list(null): ${allB.length} (${allB.filter((b) => b.builtin).length} built in)`);
      const bEst = await result(await api('bibleestimate'), 20_000);
      check(bEst.usdHigh >= bEst.usdLow && bEst.usdLow > 0 && bEst.minutesHigh > 0, `Bibles.estimate: $${bEst.usdLow}-${bEst.usdHigh}, ${bEst.minutesLow}-${bEst.minutesHigh} min (${bEst.basis})`, bEst);

      // ---- a group of 3 (an anchor tower, then a cabin and a tavern) with that bible: the estimate first
      const set3 = {
        name: `Set ${tag}`, bible: bj.bibleId, concurrency: 3, ext: { 'apitest:set': tag },
        items: [
          { itemKey: 'lot/tower', anchor: true, role: 'landmark', type: 'tower', style: 'ashen', name: `Tower ${tag}`, size: SIZE, ext: { 'apitest:lot': 'T' } },
          { itemKey: 'lot/cabin', type: 'cabin', style: 'ashen', name: `Cabin ${tag}`, size: SIZE, ext: { 'apitest:lot': 'C', 'apitest:n': 2 } },
          { itemKey: 'lot/tavern', type: 'tavern', style: 'ashen', name: `Tavern ${tag}`, size: SIZE, ext: { 'apitest:lot': 'V' } },
        ],
      };
      const est = await result(await api(`estimate ${b64(set3)}`), 20_000);
      check(est.usdLow > 0 && est.usdHigh >= est.usdLow && est.minutesLow > 0 && est.minutesHigh >= est.minutesLow && typeof est.basis === 'string' && est._thread === 'Server thread',
        `Designs.estimate(group of 3) before submit: $${est.usdLow}-${est.usdHigh}, ${est.minutesLow}-${est.minutesHigh} min (${est.basis})`, est);
      const est1 = await result(await api(`estimate1 ${b64({ type: 'cabin', style: 'rustic', size: SIZE })}`), 20_000);
      check(est1.usdLow > 0 && est1.usdHigh <= est.usdHigh, `Designs.estimate(one design): $${est1.usdLow}-${est1.usdHigh}`, est1);
      const g1 = await result(await api(`group g1 ${b64(set3)}`), 30_000);
      check(/^g\d+$/.test(g1.value ?? '') && g1._thread === 'Server thread', `requestGroup -> ${g1.value} (on ${g1._thread})`, g1);
      const gid = g1.value;
      // kill the sidecar while wave 1 runs (after the anchor), the launcher restarts it, the group carries on
      let mid = null;
      for (let i = 0; i < 300; i++) {
        mid = await api(`groupget ${gid}`);
        if (mid?.items?.some((it) => it.wave === 1 && ['DESIGNING', 'CHECKING', 'RENDERING'].includes(it.status))) break;
        await sleep(200);
      }
      const anchorBefore = mid?.items?.find((it) => it.itemKey === 'lot/tower');
      const pid = (await call('dev.launcher.state')).pid;
      process.kill(pid, 'SIGKILL');
      for (let i = 0, l = 'synced'; i < 50 && l === 'synced'; i++) {
        await sleep(200);
        l = (await call('dev.sidecar.state')).link;
      }
      await restart();
      const after = await call('dev.launcher.state');
      check(anchorBefore?.status === 'DONE' && after.pid !== pid, `killed the sidecar (pid ${pid}) while wave 1 ran (the anchor ${anchorBefore?.status}); restarted as pid ${after.pid}`, mid);
      const gDone = await groupDone(gid);
      const gv = await api(`groupget ${gid}`);
      const byKey = Object.fromEntries((gv?.items ?? []).map((it) => [it.itemKey, it]));
      check(gDone?.status === 'DONE' && gDone.done === 3 && gDone.serverThread === 'Server thread', `GROUP_DONE ${gid}: ${gDone?.status}, ${gDone?.done} done, $${gDone?.cost?.usd}`, gDone);
      check(byKey['lot/tower']?.ext?.['apitest:lot'] === 'T' && byKey['lot/cabin']?.ext?.['apitest:n'] === 2 && byKey['lot/tavern']?.ext?.['apitest:lot'] === 'V'
        && Object.values(byKey).every((it) => it.entryId && it.status === 'DONE'), `group(${gid}) items by itemKey, ext round trip across the restart: ${Object.keys(byKey).join(', ')}`, gv);
      check(byKey['lot/tower']?.wave === 0 && byKey['lot/cabin']?.wave === 1 && byKey['lot/tower']?.role === 'landmark' && byKey['lot/cabin']?.role === 'ordinary',
        `waves: tower ${byKey['lot/tower']?.wave} (landmark, ${byKey['lot/tower']?.model}), cabin ${byKey['lot/cabin']?.wave}, tavern ${byKey['lot/tavern']?.wave}`);
      check(gDone?.entriesLoaded?.length === 3, `the 3 entries are loaded when GROUP_DONE fires (${gDone?.entriesLoaded?.join(', ')})`);
      const agg = Math.round(gv.items.reduce((s, it) => s + it.cost.usd, 0) * 1e6) / 1e6;
      check(Math.abs(gv.cost.usd - agg) < 1e-6 && gv.cost.usd > 0, `aggregate cost $${gv.cost.usd} = the items' sum`);
      const entries = [];
      for (const it of gv.items) entries.push(await api(`entry ${it.entryId}`));
      check(entries.every((e) => e?.bible === `${bj.bibleId}@1` && e.group === gid && Object.keys(e.parts ?? {}).length >= 2) && entries.map((e) => e.groupItem).sort().join() === 'lot/cabin,lot/tavern,lot/tower',
        `entries carry bible, group, groupItem and parts: ${entries.map((e) => `${e?.id} [${Object.keys(e?.parts ?? {}).join('/')}]`).join(', ')}`, entries);
      const evAll = await events();
      const dd = {};
      for (const e of evAll.filter((x) => x.event === 'DESIGN_DONE')) dd[e.id] = (dd[e.id] ?? 0) + 1;
      check(gv.items.every((it) => dd[it.designId] === 1) && evAll.filter((e) => e.event === 'GROUP_DONE' && e.id === gid).length === 1,
        `DESIGN_DONE once per item (${gv.items.map((it) => `${it.designId}:${dd[it.designId]}`).join(', ')}), GROUP_DONE once`);
      const anchorDoneAt = evAll.find((e) => e.event === 'DESIGN_DONE' && e.id === byKey['lot/tower'].designId)?.t ?? Infinity;
      const wave1Start = Math.min(...evAll.filter((e) => e.event === 'DESIGN_UPDATED' && [byKey['lot/cabin'].designId, byKey['lot/tavern'].designId].includes(e.id) && e.status === 'DESIGNING').map((e) => e.t));
      check(anchorDoneAt <= wave1Start, `anchor first: the tower was done ${wave1Start - anchorDoneAt} ms before wave 1 started designing`);
      const gList = await api(`groups ${OWNER}`);
      check(gList.includes(gid), `Designs.listGroups(owner) has ${gid}`);

      // ---- a soft-budget pause, extend, resume: $0.1 per sim step, 3 steps a design; budget $0.35 -> paused at $0.30 (80% = $0.28)
      const setB = { name: `Budget ${tag}`, bible: 'oak', concurrency: 1, budgetUsd: 0.35, items: [
        { itemKey: 'b1', type: 'cabin', style: 'rustic', size: SIZE }, { itemKey: 'b2', type: 'cabin', style: 'rustic', size: SIZE }] };
      const gb = (await result(await api(`group gb ${b64(setB)}`), 30_000)).value;
      const paused = await waitEvent((e) => e.event === 'GROUP_UPDATED' && e.id === gb && e.status === 'PAUSED_BUDGET', 90_000);
      check(!!paused && /soft budget/.test(paused.reason ?? '') && paused.items.find((i) => i.itemKey === 'b2')?.status === 'QUEUED',
        `soft budget: ${gb} PAUSED_BUDGET at $${paused?.cost?.usd} ("${paused?.reason}"), b2 still queued`, paused);
      const ext = await result(await api(`groupextend ${gb} 1.0`), 20_000);
      await sleep(1500);
      const stillPaused = await api(`groupget ${gb}`);
      check(ext.value === true && stillPaused.status === 'PAUSED_BUDGET' && stillPaused.budgetUsd === 1, `extendGroup to $1.00: still paused (${stillPaused.status}), budget $${stillPaused.budgetUsd}`);
      const res = await result(await api(`groupresume ${gb}`), 20_000);
      const gbDone = await groupDone(gb, 90_000);
      check(res.value === true && gbDone?.status === 'DONE' && gbDone.done === 2, `resumeGroup: ${gb} ${gbDone?.status} with ${gbDone?.done} done, $${gbDone?.cost?.usd}`, gbDone);

      // ---- the group-wide usage hold: one item hits the (sim) usage limit, every item holds, all resume together
      const setH = { name: `Hold ${tag}`, bible: 'oak', concurrency: 3, items: [
        { itemKey: 'h1', type: 'cabin', style: 'rustic', size: SIZE, notes: 'sim:usage_limit' },
        { itemKey: 'h2', type: 'cabin', style: 'rustic', size: SIZE }, { itemKey: 'h3', type: 'cabin', style: 'rustic', size: SIZE }] };
      const gh = (await result(await api(`group gh ${b64(setH)}`), 30_000)).value;
      const held = await waitEvent((e) => e.event === 'GROUP_UPDATED' && e.id === gh && e.status === 'HELD_USAGE', 60_000);
      check(!!held && held.usageLimitUntil > Date.now() - 60_000 && held.items.every((i) => ['QUEUED', 'DESIGNING'].includes(i.status) && i.status !== 'DONE'),
        `usage hold: ${gh} HELD_USAGE until ${held ? new Date(held.usageLimitUntil).toISOString() : '?'}; items ${held?.items?.map((i) => `${i.itemKey}:${i.status}`).join(' ')}`, held);
      const ghDone = await groupDone(gh, 120_000);
      const ghEv = (await events()).filter((e) => e.event === 'DESIGN_DONE' && ghDone?.items?.some((i) => i.designId === e.id));
      const spread = ghEv.length ? Math.max(...ghEv.map((e) => e.t)) - Math.min(...ghEv.map((e) => e.t)) : -1;
      check(ghDone?.status === 'DONE' && ghDone.done === 3 && ghEv.every((e) => e.t >= held.usageLimitUntil - 500),
        `all 3 resumed after the reset and finished (${ghDone?.status}; the DONEs within ${spread} ms, all after the reset)`, ghDone);

      // ---- re-skin the group's collection with a built-in bible: one future, RESKIN_DONE with the new entries
      const rk = await result(await api(`reskin r1 dark group ${gid}`), 120_000);
      const rkEv = await waitEvent((e) => e.event === 'RESKIN_DONE' && e.id === rk.id, 30_000);
      check(rk.status === 'DONE' && rk.entries?.length === 3 && rk.completedOn === 'Server thread' && rk.loaded?.length === 3 && rk.loaded.every((e) => e.bible === 'dark@1' && e.variantOf),
        `reskinCollection(dark, group ${gid}) -> ${rk.id}: ${rk.entries?.join(', ')} (bible ${rk.loaded?.map((e) => e.bible).join('/')})`, rk);
      check(rkEv?.entriesLoaded?.length === 3 && (await events()).filter((e) => e.event === 'RESKIN_DONE' && e.id === rk.id).length === 1,
        `RESKIN_DONE once, entries loaded (${rkEv?.entriesLoaded?.join(', ')})`, rkEv);
      const rv = await result(await api(`reskinvariant ${byKey['lot/cabin'].entryId} cherry`), 60_000);
      check(rv.bible === 'cherry@1' && rv.variantOf === byKey['lot/cabin'].entryId, `makeVariant(..., bible cherry): ${rv.id} (${rv.bible})`, rv);

      // ---- an open type with a profile
      const ot = await result(await api(`opentype o1 ${b64({ type: 'hellish_lair', style: 'spiky', name: `Lair ${tag}`, size: SIZE, profile: ['door', 'lit', 'no_floating'], bible: bj.bibleId })}`), 30_000);
      const otDone = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === ot.value, 120_000);
      const otEntry = otDone?.entryId ? await api(`entry ${otDone.entryId}`) : null;
      check(otDone?.status === 'DONE' && otEntry?.type === 'hellish_lair' && otEntry.bible === `${bj.bibleId}@1`
        && JSON.stringify(otDone?.request?.profile) === JSON.stringify(['door', 'lit', 'no_floating']),
        `open type: ${ot.value} -> ${otEntry?.id} type ${otEntry?.type}, profile ${JSON.stringify(otDone?.request?.profile)}`, { otDone, otEntry });

      // ---- 4b work that finishes while no world is loaded: BIBLE_DONE, GROUP_DONE and RESKIN_DONE fire once the next world has
      // loaded (the reskinCollection future completes then too), once each
      await api('clear');
      const cbj = await result(await api(`bible cu${tag} ${b64({ prompt: 'a quiet mill town', name: `Mill ${tag}` })}`), 30_000);
      const cgid = (await result(await api(`group cg ${b64({ name: `Catch-up ${tag}`, bible: 'oak', concurrency: 2, items: [
        { itemKey: 'c1', type: 'cabin', style: 'rustic', size: SIZE }, { itemKey: 'c2', type: 'cabin', style: 'rustic', size: SIZE }] })}`), 30_000)).value;
      const rkp = await api(`reskin r2 birch group ${gid}`);
      await sleep(300);
      const tLeave = Date.now();
      await call('dev.world.leave');
      let scOut;
      for (let i = 0; i < 300; i++) {
        await sleep(500);
        scOut = await call('dev.sidecar.state');
        const fin = (x) => ['done', 'failed', 'cancelled'].includes(x?.status);
        const g = scOut.groups.find((x) => x.id === cgid);
        const b = scOut.bibleJobs.find((x) => x.id === cbj.id);
        const r = scOut.reskins.filter((x) => x.updatedAt >= tLeave - 60_000).sort((a, z) => z.createdAt - a.createdAt)[0];
        if (fin(g) && fin(b) && r && r.status !== 'building') break;
      }
      const gOut = scOut.groups.find((x) => x.id === cgid);
      const bOut = scOut.bibleJobs.find((x) => x.id === cbj.id);
      const rOut = scOut.reskins.filter((x) => x.updatedAt >= tLeave - 60_000).sort((a, z) => z.createdAt - a.createdAt)[0];
      const outIds = [[gOut, 'GROUP_DONE'], [bOut, 'BIBLE_DONE'], [rOut, 'RESKIN_DONE']].filter(([x]) => x && x.updatedAt > tLeave);
      check((await call('dev.state')).inWorld === false && gOut?.updatedAt > tLeave && outIds.length >= 2,
        `on the title screen: ${outIds.map(([x, e]) => `${x.id} (${e.split('_')[0].toLowerCase()} ${x.status})`).join(', ')} finished while no world was loaded`,
        { gOut, bOut: bOut && { ...bOut, bible: undefined }, rOut });
      const tOpen = Date.now();
      await call('dev.world.open', {});
      await waitWorld();
      await sleep(2500);
      const evCu = await events();
      for (const [x, e] of outIds) {
        const evs = evCu.filter((v) => v.event === e && v.id === x.id);
        check(evs.length === 1 && evs[0].t >= tOpen && evs[0].serverThread === 'Server thread' && (e !== 'GROUP_DONE' || evs[0].entriesLoaded?.length === 2)
          && (e !== 'RESKIN_DONE' || evs[0].entriesLoaded?.length === evs[0].entries?.length),
          `${e} ${x.id} fired once after the world loaded (${evs.length ? evs[0].t - tOpen : '?'} ms after the open, on ${evs[0]?.serverThread}${e === 'GROUP_DONE'
            ? `, ${evs[0]?.entriesLoaded?.length} entries loaded` : ''})`, evs);
      }
      const rkf = await result(rkp, 30_000);
      check(rkf.status === 'DONE' && rkf.id === rOut?.id && rkf.completedOn === 'Server thread', `the reskinCollection future completed (${rkf.id}, ${rkf.entries?.length} entries)`);

      // ---- Sites.survival() and WORLD_MODE_CHANGED: the toggle in this world, then a fresh creative and a fresh survival world
      const s0 = await api('survival');
      const mark = (await events()).length;
      await cmd(`/architect survival ${s0.enabled ? 'off' : 'on'}`);
      await cmd(`/architect survival ${s0.enabled ? 'on' : 'off'}`);
      await sleep(500);
      const wm = (await api(`events ${mark}`)).filter((e) => e.event === 'WORLD_MODE_CHANGED');
      check(wm.length === 2 && wm[0].enabled === !s0.enabled && wm[1].enabled === s0.enabled && wm.every((e) => e.serverThread === 'Server thread') && s0.mayToggleNull === false,
        `toggled twice in ${s0.world} (${s0.gameType}): WORLD_MODE_CHANGED ${wm.map((e) => e.enabled).join(' > ')}; mayToggle(player) ${s0.mayTogglePlayer}, mayToggle(null) ${s0.mayToggleNull}`, { s0, wm });
      for (const [mode, expect] of [['creative', false], ['survival', true]]) {
        const name = `API Sets ${mode} ${tag}`;
        await api('clear');
        await call('dev.world.leave');
        await call('dev.world.open', { name, mode, preset: 'flat', cheats: true });
        await waitWorld();
        await sleep(1000);
        const first = (await events()).filter((e) => e.event === 'WORLD_MODE_CHANGED');
        const s = await api('survival');
        check(s.world === name && s.gameType === mode && s.enabled === expect && first.length >= 1 && first[first.length - 1].enabled === expect,
          `a fresh ${mode} world: Sites.survival() enabled ${s.enabled}, ${s.blocksPerTick} blocks/tick, mayToggle(player) ${s.mayTogglePlayer}; WORLD_MODE_CHANGED at the first load (${first.map((e) => e.enabled).join(',')})`, { s, first });
      }
      await call('dev.world.leave');
      await call('dev.world.open', {});
      await waitWorld();
    } finally {
      if (oldCfg === null) fs.rmSync(cfgFile, { force: true });
      else fs.writeFileSync(cfgFile, oldCfg);
      await restart().catch((e) => console.log('restart:', e.message));
    }
    results.events = (await events()).filter((e) => !e.event.startsWith('SITE_'));
    break;
  }
  case 'catchup': {
    // designs and variants that finish while no world is loaded fire DESIGN_DONE / VARIANT_DONE when one loads (sim sidecar:
    // its steps slowed to 1.5 s through <data>/config.json and a helper restart, so the design outlasts leaving the world)
    const cfgFile = path.join(SIDECAR_DATA, 'config.json');
    const oldCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const restartHelper = async () => {
      await call('dev.launcher.restart');
      for (let i = 0; i < 100; i++) {
        await sleep(300);
        if ((await call('dev.sidecar.state')).link === 'synced' && (await call('dev.launcher.state')).state === 'running') return;
      }
      throw new Error('the helper did not come back');
    };
    const waitInWorld = async () => {
      for (let i = 0; i < 300; i++) {
        await sleep(500);
        const s = await call('dev.state').catch(() => null);
        if (s?.inWorld && s.ready) return s;
      }
      throw new Error('the world did not load');
    };
    fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 1500 }));
    try {
      await restartHelper();
      await api('clear');
      const from = (await api('entries')).find((id) => /^gen_apicabin$/.test(id)) ?? 'cabin';
      const d = await result(await api('design CatchUp'));
      const palettes = ['oak', 'dark', 'cherry', 'fortress'];
      for (const p of palettes) await api(`variant ${from} ${p}`);
      await sleep(300);
      const tLeave = Date.now();
      await call('dev.world.leave');
      check((await call('dev.state')).inWorld === false, `left the world (design ${d.value}, ${palettes.length} variants of ${from} queued)`);
      // wait on the title screen until the helper reports them all finished
      let sc;
      for (let i = 0; i < 200; i++) {
        await sleep(500);
        sc = await call('dev.sidecar.state');
        const dd = sc.designs.find((x) => x.id === d.value);
        const vs = sc.variants.filter((x) => x.from === from && x.createdAt >= tLeave - 60_000);
        if (dd && ['done', 'failed', 'cancelled'].includes(dd.status) && vs.length >= palettes.length && vs.every((x) => ['done', 'failed'].includes(x.status))) break;
      }
      const vs = sc.variants.filter((x) => x.from === from && x.createdAt >= tLeave - 60_000);
      const whileOut = vs.filter((x) => x.updatedAt > tLeave);
      const evOut = await call('dev.state');
      check(evOut.inWorld === false && whileOut.length > 0, `on the title screen: the design and ${whileOut.length} of ${vs.length} variants finished while no world was loaded`, vs.map((x) => ({ id: x.id, status: x.status, blueprintId: x.blueprintId })));
      const tOpen = Date.now();
      await call('dev.world.open');
      await waitInWorld();
      const dDone = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === d.value, 30_000);
      check(!!dDone && dDone.t >= tOpen && dDone.serverThread === 'Server thread' && dDone.status === 'DONE',
        `DESIGN_DONE ${d.value} fired after the world loaded (${dDone ? dDone.t - tOpen : '?'} ms after the open, on ${dDone?.serverThread})`, dDone);
      await sleep(1500);
      const all = await events();
      const vDone = all.filter((e) => e.event === 'VARIANT_DONE');
      const outIds = whileOut.filter((x) => x.status === 'done').map((x) => x.blueprintId);
      check(outIds.length > 0 && outIds.every((id) => vDone.filter((e) => e.id === id).length === 1 && vDone.find((e) => e.id === id).t >= tOpen),
        `VARIANT_DONE once for each variant that finished while out (${outIds.join(', ')}), after the world loaded`, vDone.map((e) => ({ id: e.id, t: e.t - tOpen })));
      const futs = [];
      for (const p of palettes) futs.push(await result({ pending: `variant:${from}:${p}` }, 30_000));
      check(futs.every((f) => !f.error && f.variantOf === from), `the makeVariant futures completed after the reload (${futs.map((f) => f.id ?? f.error).join(', ')})`, futs);
      const dCount = all.filter((e) => e.event === 'DESIGN_DONE' && e.id === d.value).length;
      check(dCount === 1, `DESIGN_DONE once (${dCount})`);
      // tidy: the new entries go to the trash
      for (const f of futs) if (f.id) await result(await api(`delete ${f.id}`), 30_000).catch(() => null);
      if (dDone?.entryId) await result(await api(`delete ${dDone.entryId}`), 30_000).catch(() => null);

      // a tool call that arrives while no world runs gets an error answer (the job goes on); JOB_DONE fires on the next load
      const timerCalls = (await api('toolstats')).timer?.calls ?? 0;
      const nw = await result(await api('jobrun noworld'));
      for (let i = 0; i < 100 && ((await api('toolstats')).timer?.calls ?? 0) <= timerCalls; i++) await sleep(100);
      await call('dev.world.leave');
      let nwJob;
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        nwJob = (await call('dev.sidecar.state')).jobs.find((j) => j.id === nw.value);
        if (['done', 'failed', 'cancelled'].includes(nwJob?.status)) break;
      }
      const tOpen2 = Date.now();
      await call('dev.world.open');
      await waitInWorld();
      const nwDone = await waitEvent((e) => e.event === 'JOB_DONE' && e.id === nw.value, 30_000);
      let nwOut = null;
      try {
        nwOut = JSON.parse(nwDone?.result?.text ?? 'null');
      } catch {
        /* checked below */
      }
      const byTool = Object.fromEntries((nwOut?.results ?? []).map((r) => [r.tool, r]));
      check(nwJob?.status === 'done' && byTool.timer?.result?.timer === 4000 && /no world is running/.test(byTool.fast?.error ?? ''),
        `job ${nw.value} finished on the title screen: timer answered, fast got "${byTool.fast?.error}"`, nwOut);
      check(!!nwDone && nwDone.t >= tOpen2 && nwDone.serverThread === 'Server thread', `its JOB_DONE fired after the world loaded (${nwDone ? nwDone.t - tOpen2 : '?'} ms)`);
    } finally {
      if (oldCfg === null) fs.rmSync(cfgFile, { force: true });
      else fs.writeFileSync(cfgFile, oldCfg);
      await restartHelper().catch((e) => console.log('restart:', e.message));
    }
    break;
  }
  default:
    console.error('usage: node tools/apitest.mjs survival|jobs|catchup|sets|preview');
    process.exit(2);
}

fs.writeFileSync(path.join(OUT, `${step}.json`), JSON.stringify(results, null, 1) + '\n');
console.log(`${failures === 0 ? 'ALL OK' : `${failures} FAILED`} -> ${path.join(OUT, `${step}.json`)}`);
process.exitCode = failures ? 1 : 0;
dev.close();
