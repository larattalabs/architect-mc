#!/usr/bin/env node
// Phase 4a API checks (docs/CONTRACT.md "Phase 4a gate", the Java half) against a running dev client with the apitest mod
// (tools/run-apitest-client.sh, DevBridge on ARCHITECT_DEV_PORT). Everything goes through the apitest mod's /apitest
// command, which uses only dev.larattalabs.architect.api; DevBridge hooks are used only to feed a crate, aim the camera
// and take screenshots. No Claude: the stub sidecar "designs" by copying a bundled example.
//
//   node tools/apitest.mjs survival     in a survival world (the toggle on): sites, refusals, the actor rule, progress,
//                                       remove rules and refund, survey, designs/variants/library writes, a client preview
//
// Evidence goes to artifacts/apitest/<step>.json (APITEST_OUT overrides), screenshots to the client's ARCHITECT_SHOTS_DIR.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.APITEST_OUT ? path.resolve(process.env.APITEST_OUT) : path.join(root, 'artifacts', 'apitest');
fs.mkdirSync(OUT, { recursive: true });
const OWNER = 'apitest:village/1';

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
    check(v.version === '1.0.0', `ArchitectApi.VERSION ${v.version}`, v);
    const p2 = v.features.includes('protocol2');
    const jobFeatures = ['jobs', 'jobTools', 'blobs'];
    check(['designs', 'events', 'library', 'sites', 'survey'].every((f) => v.features.includes(f))
      && (p2 ? jobFeatures.every((f) => v.features.includes(f)) : !jobFeatures.some((f) => v.features.includes(f))),
      `features() against a protocol-${p2 ? 2 : 1} sidecar: ${v.features.join(', ')}`, v.features);
    const jobs = await result(await api('jobs'));
    check(v.jobsAvailable === false && /jobs arrive with protocol 2/.test(jobs.error ?? ''), `jobs: available() false, run() refused (${jobs.error})`, jobs);

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
  default:
    console.error('usage: node tools/apitest.mjs survival|preview');
    process.exit(2);
}

fs.writeFileSync(path.join(OUT, `${step}.json`), JSON.stringify(results, null, 1) + '\n');
console.log(`${failures === 0 ? 'ALL OK' : `${failures} FAILED`} -> ${path.join(OUT, `${step}.json`)}`);
process.exitCode = failures ? 1 : 0;
dev.close();
