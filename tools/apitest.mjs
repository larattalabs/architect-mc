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
//   node tools/apitest.mjs massing      phase 4c without Claude (--sim): a massing -> MASSING_DONE, a redirect -> v2, the detail
//                                       pass with conformance, deleteMassing, MASSING_DONE caught up after a world load, a
//                                       massingFirst set of 3 through GROUP_AWAITING_APPROVAL (a sidecar restart while awaiting),
//                                       approve 2 / redirect 1 / all detailed, approvalUi owner from the API, and the composite
//                                       preview (5 styles at once with a screenshot, the cell cap and outline fallback, clear on
//                                       world leave)
//   node tools/apitest.mjs critique     phase 5a without Claude (--sim): CritiqueSpec's builder, the estimate's critique figures
//                                       (one design, a group per item), a loop design with two rounds (DESIGN_CRITIQUED per round,
//                                       CRITIQUING, the critique on DESIGN_DONE and on the entry), a report critique of the entry
//                                       (critique.json, stale once the .nbt changes), a group with the loop on one item and off on
//                                       another, a bible with the sheet critique and its restraint, archive, delete refused (owner,
//                                       pinned) and allowed, a structured job with two images
//   node tools/apitest.mjs critique-real   REAL (the real sidecar under the claude login, ~$1-5): one design with the loop
//                                       requested through the Java API; prints its critique (APITEST_MODEL, APITEST_REVISIONS)
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
// the apitest jar's compiled-in ArchitectApi.VERSION (the unchanged 1.5.0 jar of a regression run: APITEST_API_VERSION=1.5.0)
const API_VERSION = process.env.APITEST_API_VERSION ?? '1.10.0';
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

/**
 * The composite preview (phase 4c, ArchitectClientApi.previewComposite) through apitest's client half: 5 styles at once (a
 * massing, a ghost, and a delta's added / changed / removed cells) with a screenshot, two keys at once, an unknown id refused,
 * the 200,000-cell cap and the outline fallback (cap and distance), the frame time, clear, and clear on world leave.
 */
async function compositeChecks(tag) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
  const SHOTS = process.env.APITEST_SHOT_PREFIX ?? 'mod-p4c';
  const composite = async (key, layers) => {
    const r = await result(await api(`composite ${key} ${b64(layers)}`), 20_000);
    return r;
  };
  const state = async (reset = false) => call('dev.composite.state', { reset });
  const built = async (key, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = await state();
      if (s.keys[key]?.built && s.keys[key].layers.every((l) => l.mode !== 'not drawn yet' && l.mode !== 'building')) return s;
      await sleep(250);
    }
    return state();
  };
  const range = (x0, x1, y0, y1, z0, z1) => {
    const out = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push([x, y, z]);
    return out;
  };
  await call('dev.release', { mode: 'keep' }).catch(() => null);
  // a massing to show (sim)
  const mreq = await result(await api(`massingreq cmp ${b64({ type: 'tower', style: 'rustic', name: `Plan tower ${tag}`, size: [31, 30, 31] })}`), 30_000);
  const md = await waitEvent((e) => e.event === 'MASSING_DONE' && e.designId === mreq.value, 120_000);
  const p = (await call('dev.state')).player;
  const P = await spot(Math.floor(p.x) + 30, Math.floor(p.z) + 10);
  const at = (dx, dz = 0) => [P.x + dx, P.y, P.z + dz];
  // 5 styles at once: a massing, a ghost, and on one tavern a delta (its lower rows added, middle changed, upper removed)
  const five = [
    { blueprintId: md.id, origin: at(0), style: 'MASSING' },
    { blueprintId: 'cabin', origin: at(22), style: 'GHOST' },
    { blueprintId: 'tavern', origin: at(42), style: 'ADDED', onlyCells: range(0, 15, 0, 4, 0, 11) },
    { blueprintId: 'tavern', origin: at(42), style: 'CHANGED', onlyCells: range(0, 15, 5, 8, 0, 11) },
    { blueprintId: 'tavern', origin: at(42), style: 'REMOVED', onlyCells: range(0, 15, 9, 17, 0, 11) },
  ];
  const r5 = await composite('apitest:plan', five);
  const s5 = await built('apitest:plan');
  const k5 = s5.keys['apitest:plan'];
  check(!r5.error && r5.thread === 'Render thread' && k5?.layers?.length === 5 && k5.layers.every((l) => l.mode === 'cells' && l.cells > 0 && l.quads > 0)
    && k5.layers.map((l) => l.style).join() === 'MASSING,GHOST,ADDED,CHANGED,REMOVED',
    `previewComposite(apitest:plan, 5 layers) on the ${r5.thread}: ${k5?.layers?.map((l) => `${l.style} ${l.source} ${l.cells} cells/${l.quads} quads`).join('; ')} (built in ${k5?.buildMs} ms)`, k5);
  const rem = k5?.layers?.[4];
  const tavernAll = k5?.layers?.slice(2).reduce((s, l) => s + l.cells, 0);
  check(rem && rem.onlyCells > 0 && rem.cells > 0 && rem.quads % 5 === 0 && k5.layers[2].cells > 0 && k5.layers[3].cells > 0,
    `onlyCells in template coordinates: rows 0-4 / 5-8 / 9-17 of the tavern give ${k5?.layers?.slice(2).map((l) => l.cells).join(' / ')} cells (${tavernAll} in all); the removed ones as red frames (${rem?.quads} quads = 5 per face)`, rem);
  await call('dev.camera', { x: P.x + 30, y: P.y + 34, z: P.z + 52, lookAt: { x: P.x + 30, y: P.y + 6, z: P.z + 6 }, mode: 'spectator' }).catch((e) => console.log('camera:', e.message));
  await sleep(1500);
  await state(true);
  await sleep(1500);
  const f5 = (await state()).lastFrame;
  const shot5 = await call('dev.screenshot', { name: `${SHOTS}-composite-5styles`, hideHud: true }, 120_000);
  check(!!shot5.path, `screenshot of the 5 styles at once: ${shot5.path} (frame: ${f5.quads} quads in ${f5.ms.toFixed(3)} ms, max ${f5.maxMs.toFixed(3)} ms)`, { shot5, f5 });
  // a second key at once; an unknown id is refused and leaves the key as it was
  const r2 = await composite('apitest:second', [{ blueprintId: 'tower', origin: at(-22), style: 'GHOST' }]);
  const bad = await composite('apitest:second', [{ blueprintId: `nope_${tag}`, origin: at(0), style: 'GHOST' }]);
  check(JSON.stringify(r2.keys) === '["apitest:plan","apitest:second"]' && /IllegalArgumentException/.test(bad.error ?? '') && (await state()).keys['apitest:second']?.layers?.[0]?.source === 'tower',
    `two keys at once (${r2.keys?.join(', ')}); an unknown id is refused ("${bad.error}") and the key keeps its layers`, { r2, bad });
  // the cell cap: taverns side by side until the key passes 200,000 cells; the layers past the cap draw as box outlines
  const perTavern = (await (async () => {
    await composite('apitest:cap', [{ blueprintId: 'tavern', origin: at(0, -40), style: 'GHOST' }]);
    return (await built('apitest:cap')).keys['apitest:cap'].layers[0].cells;
  })());
  const n = Math.ceil(230_000 / perTavern);
  const cols = Math.ceil(Math.sqrt(n));
  const capLayers = [];
  for (let i = 0; i < n; i++) capLayers.push({ blueprintId: 'tavern', origin: at(-60 + (i % cols) * 18, -60 - Math.floor(i / cols) * 14), style: i % 2 ? 'GHOST' : 'MASSING' });
  const cx = P.x - 60 + (cols * 18) / 2;
  const cz = P.z - 60 - (Math.ceil(n / cols) * 14) / 2;
  await call('dev.camera', { x: cx, y: P.y + 70, z: cz + 40, lookAt: { x: cx, y: P.y, z: cz }, mode: 'spectator' }).catch((e) => console.log('camera:', e.message));
  await composite('apitest:cap', capLayers);
  const sc = await built('apitest:cap', 120_000);
  const kc = sc.keys['apitest:cap'];
  const drawn = kc.layers.filter((l) => !l.overCap).reduce((s, l) => s + l.cells, 0);
  const capped = kc.layers.filter((l) => l.overCap);
  check(n * perTavern > 200_000 && drawn <= 200_000 && capped.length >= 1 && capped.every((l) => l.mode === 'outline:cap') && kc.cells === drawn,
    `the cap: ${n} taverns (${perTavern} cells each, ${n * perTavern} in all): ${drawn} cells drawn, ${capped.length} layer(s) past the cap as outlines (built in ${kc.buildMs} ms)`, { n, perTavern, drawn, capped: capped.length });
  await sleep(1000);
  await state(true);
  await sleep(2000);
  const fc = (await state()).lastFrame;
  const shotC = await call('dev.screenshot', { name: `${SHOTS}-composite-cap`, hideHud: true }, 120_000);
  check(!!shotC.path && fc.frames > 0, `screenshot of the capped key: ${shotC.path}; frame at the cap: ${fc.quads} quads in ${fc.ms.toFixed(2)} ms (max ${fc.maxMs.toFixed(2)} ms over 2 s)`, { shotC, fc });
  results.frameAtCap = fc;
  // the distance fallback: a layer 300 blocks away draws as its outline
  await composite('apitest:far', [{ blueprintId: 'tavern', origin: at(300, 0), style: 'CHANGED' }, { blueprintId: 'cabin', origin: at(0, 0), style: 'ADDED' }]);
  await call('dev.camera', { x: P.x + 30, y: P.y + 34, z: P.z + 52, lookAt: { x: P.x + 30, y: P.y + 6, z: P.z + 6 }, mode: 'spectator' }).catch(() => null);
  const sf = await built('apitest:far');
  await sleep(500);
  const kf = (await state()).keys['apitest:far'];
  check(kf?.layers?.[0]?.mode === 'outline:distance' && kf.layers[1].mode === 'cells', `beyond 160 blocks: ${kf?.layers?.map((l) => `${l.source} ${l.mode}`).join(', ')}`, kf);
  // clear one key, then leave the world: every composite clears
  await result(await api('compositeclear apitest:far'), 20_000);
  const afterClear = await state();
  check(!afterClear.keys['apitest:far'] && !!afterClear.keys['apitest:plan'], `clearComposite(apitest:far): ${Object.keys(afterClear.keys).join(', ')} remain`);
  await call('dev.world.leave');
  await call('dev.world.open', {});
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    const s = await call('dev.state').catch(() => null);
    if (s?.inWorld && s.ready) break;
  }
  const afterLeave = await state();
  check(Object.keys(afterLeave.keys).length === 0, `world leave cleared every composite (keys now: ${Object.keys(afterLeave.keys).length})`, afterLeave);
  await result(await api(`massingdelete ${md.id}`), 20_000).catch(() => null);
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
  case 'massing': {
    // phase 4c through the API (docs/CONTRACT.md "Phase 4c gate" and "4c review folded in", the Java half) against the real
    // sidecar's sim backend (tools/run-apitest-client.sh --sim; no Claude). The sim installs the kit's example massings (tavern,
    // tower, gatehouse, cabin have conforming detail pairs) and its steps are slowed and priced through <data>/config.json.
    const cfgFile = path.join(SIDECAR_DATA, 'config.json');
    const oldCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const SIZE = [31, 30, 31];
    const MASSINGS = path.join(GAME_DIR, 'architect', 'massings');
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
    const evs = async (pred) => (await events()).filter(pred);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 500, simDesignUsd: 0.02, designConcurrency: 3 }));
    try {
      await restart();
      await api('clear');
      const v = await api('version');
      check(v.version === API_VERSION && v.features.includes('massing') && v.features.includes('compositePreview'),
        `VERSION ${v.version}, features massing + compositePreview (${v.features.join(', ')})`, v);

      // ---- 1. a massing request -> MASSING_DONE (DESIGN_DONE with no library entry)
      const req1 = { type: 'tavern', style: 'rustic', name: `Tankard ${tag}`, size: SIZE, ext: { 'apitest:m': tag }, context: 'on a river bend; the street runs south' };
      const m1 = await result(await api(`massingreq m1 ${b64(req1)}`), 30_000);
      check(/^d\d+$/.test(m1.value ?? '') && m1._thread === 'Server thread', `request(massing) -> ${m1.value} (on ${m1._thread})`, m1);
      const md1 = await waitEvent((e) => e.event === 'MASSING_DONE' && e.designId === m1.value, 120_000);
      const mid = md1?.id;
      check(md1?.version === 1 && /^mas_/.test(mid ?? '') && Object.keys(md1.parts ?? {}).length >= 2 && md1.nbtExists && md1.owner === OWNER
        && md1.ext?.['apitest:m'] === tag && md1.serverThread === 'Server thread' && md1.type === 'tavern',
        `MASSING_DONE ${mid} v${md1?.version}: ${Object.keys(md1?.parts ?? {}).join('/')} ${md1?.size}, model ${md1?.model}, $${md1?.cost?.usd}, ext and owner kept`, md1);
      const dd1 = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === m1.value, 10_000);
      check(dd1?.status === 'DONE' && dd1.entryId === null && dd1.massing === `${mid}@1`, `DESIGN_DONE ${m1.value}: no library entry, massing ${dd1?.massing}`, dd1);
      check(!(await api('entries')).includes(mid), `the massing is not in the library`);
      const g1 = await api(`massingget ${mid}`);
      const mine = await api(`massings ${OWNER}`);
      check(g1?.version === 1 && mine.some((m) => m.id === mid) && fs.existsSync(path.join(MASSINGS, mid, `${mid}.nbt`)),
        `Designs.massing(${mid}) v${g1?.version}; listMassings(owner) has it; ${mid}/${mid}.nbt on disk`, g1);

      // ---- 2. a redirect -> a new version
      const rd = await result(await api(`redirect r1 ${mid} ${b64('make it L-shaped with a tower at the corner')}`), 30_000);
      check(rd.version === 2 && /^d\d+$/.test(rd.designId ?? ''), `redirectMassing(${mid}) -> ${rd.designId} making v${rd.version}`, rd);
      const md2 = await waitEvent((e) => e.event === 'MASSING_DONE' && e.id === mid && e.version === 2, 120_000);
      const v1 = await api(`massingget ${mid} 1`);
      check(md2?.redirect?.fromVersion === 1 && /L-shaped/.test(md2.redirect.notes) && JSON.stringify(md2.versions) === '[1,2]' && md2.latest && v1?.version === 1
        && !v1.latest && fs.existsSync(path.join(MASSINGS, mid, 'versions', '2', `${mid}.nbt`)),
        `MASSING_DONE ${mid} v2 (redirect of v1: "${md2?.redirect?.notes}"), ${md2?.size} vs v1 ${v1?.size}; massing(id, 1) still known`, { md2, v1 });
      check((await evs((e) => e.event === 'MASSING_DONE' && e.id === mid)).length === 2, 'MASSING_DONE once per version');

      // ---- 3. the detail pass from the massing -> conformance ok. Pinned to v1: the sim's tavern redirect turns the gable into a
      // hip and its detail is the gable example, which the sidecar then fails (reported; the set below details a redirected v2)
      const dt = await result(await api(`detail d1 ${b64({ type: 'tavern', style: 'rustic', name: `Tankard ${tag}`, size: SIZE, fromMassing: mid, massingVersion: 1 })}`), 30_000);
      const dd = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === dt.value, 120_000);
      const dEntry = dd?.entryId ? await api(`entry ${dd.entryId}`) : null;
      check(dd?.status === 'DONE' && dd.fromMassing === `${mid}@1` && dd.conformance?.ok === true && !!dEntry,
        `detail ${dt.value} from ${dd?.fromMassing}: ${dd?.entryId}, conformance ok ${dd?.conformance?.ok} (${(dd?.conformance?.errors ?? []).length} errors, ${(dd?.conformance?.issues ?? []).length} warnings)`, dd);
      await sleep(500);
      const afterDetail = await api(`massingget ${mid} 1`);
      check(afterDetail?.detail?.designId === dt.value && afterDetail.detail.status === 'DONE' && afterDetail.detail.entryId === dd?.entryId,
        `massing ${mid} v1 .detail (recorded on the version it details) -> ${afterDetail?.detail?.designId} ${afterDetail?.detail?.status} (${afterDetail?.detail?.entryId})`, afterDetail);

      // ---- 4. deleteMassing
      const del = await result(await api(`massingdelete ${mid}`), 20_000);
      await sleep(500);
      check(del.value === 2 && (await api(`massingget ${mid}`)) === null && (await api(`massingget ${mid} 1`)) === null
        && !(await api(`massings ${OWNER}`)).some((m) => m.id === mid) && !fs.existsSync(path.join(MASSINGS, mid)),
        `deleteMassing(${mid}) -> ${del.value} versions; gone from the API (every version) and the disk`, del);

      // ---- 5. MASSING_DONE caught up after a world load (the massing finishes on the title screen)
      await api('clear');
      const mc = await result(await api(`massingreq mc ${b64({ type: 'cabin', style: 'rustic', name: `Catch ${tag}`, size: SIZE })}`), 30_000);
      await call('dev.world.leave');
      let mcOut = null;
      for (let i = 0; i < 200 && !mcOut; i++) {
        await sleep(500);
        const sc = await call('dev.sidecar.state');
        mcOut = sc.massings.find((m) => m.designId === mc.value) ?? null;
      }
      const tOpen = Date.now();
      await call('dev.world.open', {});
      await waitWorld();
      await sleep(2500);
      const mcEv = await evs((e) => e.event === 'MASSING_DONE' && e.designId === mc.value);
      check(!!mcOut && mcEv.length === 1 && mcEv[0].t >= tOpen && mcEv[0].serverThread === 'Server thread',
        `massing ${mcOut?.id} installed on the title screen; MASSING_DONE once after the world loaded (${mcEv.length ? mcEv[0].t - tOpen : '?'} ms)`, mcEv);
      if (mcOut) await result(await api(`massingdelete ${mcOut.id}`), 20_000).catch(() => null);

      // ---- 6. a massingFirst set of 3 through approval
      await api('clear');
      const set = {
        name: `Massing set ${tag}`, bible: 'oak', concurrency: 3, massingFirst: true, maxRedirects: 2, ext: { 'apitest:set': tag },
        context: { site: 'a river bend', street: 'south', purpose: 'a crossing village' },
        items: [
          { itemKey: 's/tower', anchor: true, role: 'landmark', type: 'tower', style: 'rustic', name: `Tower ${tag}`, size: SIZE, ext: { 'apitest:lot': 'T' } },
          { itemKey: 's/tavern', type: 'tavern', style: 'rustic', name: `Tavern ${tag}`, size: SIZE, ext: { 'apitest:lot': 'V' } },
          { itemKey: 's/gate', type: 'gatehouse', style: 'rustic', name: `Gate ${tag}`, size: SIZE, ext: { 'apitest:lot': 'G' } },
        ],
      };
      const est = await result(await api(`estimate ${b64(set)}`), 20_000);
      const { massingFirst: _mf, ...plainSet } = set;
      const estPlain = await result(await api(`estimate ${b64(plainSet)}`), 20_000);
      check(est.usdHigh > estPlain.usdHigh && est.minutesHigh > estPlain.minutesHigh,
        `Designs.estimate(massingFirst set) includes the massing pass: $${est.usdLow}-${est.usdHigh}, ${est.minutesLow}-${est.minutesHigh} min vs $${estPlain.usdLow}-${estPlain.usdHigh} without (${est.basis})`, { est, estPlain });
      const gid = (await result(await api(`group gm ${b64(set)}`), 30_000)).value;
      const aw1 = await waitEvent((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gid, 240_000);
      check(aw1?.status === 'AWAITING_APPROVAL' && aw1.awaiting.length === 3 && aw1.items.every((i) => i.stage === 'approval' && i.awaitingApproval && /^mas_/.test(i.massing ?? ''))
        && aw1.done === 0 && aw1.massingFirst && aw1.approvalUi === 'architect' && aw1.maxRedirects === 2 && aw1.context?.site === 'a river bend' && aw1.serverThread === 'Server thread',
        `GROUP_AWAITING_APPROVAL ${gid}: awaiting ${aw1?.awaiting?.join(', ')}; items ${aw1?.items?.map((i) => `${i.itemKey} ${i.stage} ${i.massing}`).join(', ')}; done ${aw1?.done}`, aw1);
      const setMassings = await evs((e) => e.event === 'MASSING_DONE' && e.group === gid);
      check(setMassings.length === 3 && setMassings.every((m) => m.itemKey && m.ext?.['apitest:lot']),
        `MASSING_DONE for the 3 items (${setMassings.map((m) => `${m.itemKey}:${m.id}@${m.version}`).join(', ')}), item ext kept`, setMassings);
      // a sidecar restart while awaiting: the group comes back awaiting, and the event does not fire again
      const pid = (await call('dev.launcher.state')).pid;
      process.kill(pid, 'SIGKILL');
      for (let i = 0, l = 'synced'; i < 50 && l === 'synced'; i++) {
        await sleep(200);
        l = (await call('dev.sidecar.state')).link;
      }
      await restart();
      await sleep(2000);
      const back = await api(`groupget ${gid}`);
      check(back?.status === 'AWAITING_APPROVAL' && back.awaiting.length === 3 && (await evs((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gid)).length === 1
        && (await call('dev.launcher.state')).pid !== pid,
        `killed the sidecar (pid ${pid}) while awaiting; back: ${back?.status}, awaiting ${back?.awaiting?.length}; GROUP_AWAITING_APPROVAL still once`, back);
      // approve 2, redirect 1
      const tAp = Date.now();
      const ap = await result(await api(`approve a1 ${gid} ${b64({ approve: ['s/tower', 's/tavern'], redirect: { 's/gate': 'taller gate towers, a wider arch' } })}`), 30_000);
      check(Object.keys(ap.approved ?? {}).sort().join() === 's/tavern,s/tower' && ap.redirected?.['s/gate']?.version === 2 && ap._thread === 'Server thread',
        `approveGroup: approved ${Object.entries(ap.approved ?? {}).map(([k, d]) => `${k}->${d}`).join(', ')}; redirected s/gate -> v${ap.redirected?.['s/gate']?.version}`, ap);
      const aw2 = await waitEvent((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gid && e.t > tAp, 240_000);
      const gate2 = aw2?.items?.find((i) => i.itemKey === 's/gate');
      check(JSON.stringify(aw2?.awaiting) === '["s/gate"]' && gate2?.rounds === 1 && /@2$/.test(gate2?.massing ?? '') && (await evs((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gid)).length === 2,
        `the redirect finished: GROUP_AWAITING_APPROVAL again, awaiting ${aw2?.awaiting}; s/gate ${gate2?.massing}, ${gate2?.rounds} round`, aw2);
      const ap2 = await result(await api(`approve a2 ${gid} ${b64({ approve: ['s/gate'] })}`), 30_000);
      const gDone = await waitEvent((e) => e.event === 'GROUP_DONE' && e.id === gid, 240_000);
      const byKey = Object.fromEntries((gDone?.items ?? []).map((i) => [i.itemKey, i]));
      check(!!ap2.approved?.['s/gate'] && gDone?.status === 'DONE' && gDone.done === 3 && gDone.items.every((i) => i.detailed && i.stage === 'detail' && i.entryId)
        && byKey['s/gate']?.designIds?.length === 3 && byKey['s/tower']?.designIds?.length === 2 && gDone.entriesLoaded?.length === 3,
        `GROUP_DONE ${gid}: ${gDone?.done} detailed (${gDone?.items?.map((i) => `${i.itemKey}: ${i.designIds.join('>')} -> ${i.entryId}`).join('; ')}), $${gDone?.cost?.usd}`, gDone);
      const details = [];
      for (const it of gDone?.items ?? []) details.push(await api(`designget ${it.designId}`));
      check(details.every((d) => d?.conformance?.ok === true && d.fromMassing), `every detail pass conforms (${details.map((d) => `${d?.id} ${d?.fromMassing} ok=${d?.conformance?.ok}`).join(', ')})`, details);
      const massCost = (await evs((e) => e.event === 'MASSING_DONE' && e.group === gid)).reduce((s, m) => s + m.cost.usd, 0);
      check(gDone?.cost?.usd > massCost && massCost > 0, `the group's cost $${gDone?.cost?.usd} includes its 4 massings ($${massCost.toFixed(2)})`);

      // ---- 7. approvalUi owner: only the group's owner approves (from the API)
      const OWNER2 = 'apitest:owner/1';
      const setO = { name: `Owner set ${tag}`, bible: 'oak', owner: OWNER2, massingFirst: true, approvalUi: 'owner', maxRedirects: 0,
        items: [{ itemKey: 'o/cabin', type: 'cabin', style: 'rustic', size: SIZE, owner: OWNER2 }] };
      const gido = (await result(await api(`group go ${b64(setO)}`), 30_000)).value;
      const awo = await waitEvent((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gido, 240_000);
      check(awo?.owner === OWNER2 && awo.approvalUi === 'owner', `GROUP_AWAITING_APPROVAL ${gido} names its owner ${awo?.owner} (approvalUi ${awo?.approvalUi})`, awo);
      const noOwner = await result(await api(`approve o1 ${gido} ${b64({ approve: ['o/cabin'] })}`), 20_000);
      const wrong = await result(await api(`approve o2 ${gido} ${b64({ approve: ['o/cabin'], owner: 'apitest:someone_else' })}`), 20_000);
      const cabinMassing = awo?.items?.[0]?.massing?.split('@')[0];
      const redirNoOwner = await result(await api(`redirect o3 ${cabinMassing} ${b64('bigger')}`), 20_000);
      const redirOwner = await result(await api(`redirect o4 ${cabinMassing} ${b64('bigger')} ${OWNER2}`), 20_000);
      check(/owner/.test(noOwner.error ?? '') && /owner/.test(wrong.error ?? '') && /owner/.test(redirNoOwner.error ?? '') && /redirect round/.test(redirOwner.error ?? ''),
        `refused: approveGroup without owner ("${noOwner.error}"), with another owner, redirectMassing without owner; with the owner the redirect cap applies ("${redirOwner.error}")`,
        { noOwner, wrong, redirNoOwner, redirOwner });
      const okO = await result(await api(`approve o5 ${gido} ${b64({ approve: ['o/cabin'], owner: OWNER2 })}`), 20_000);
      const goDone = await waitEvent((e) => e.event === 'GROUP_DONE' && e.id === gido, 180_000);
      check(okO.approved?.['o/cabin'] && goDone?.status === 'DONE' && goDone.done === 1, `approveGroup as ${OWNER2}: ${goDone?.status}, ${goDone?.done} detailed`, goDone);

      // ---- 8. GROUP_AWAITING_APPROVAL caught up after a world load: a set's massing finishes while no world is loaded (the sim's
      // steps slowed so the massing outlasts leaving the world)
      fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 2500, simDesignUsd: 0.02, designConcurrency: 3 }));
      await restart();
      await api('clear');
      const gcu = (await result(await api(`group gcu ${b64({ name: `Catch-up set ${tag}`, bible: 'oak', massingFirst: true,
        items: [{ itemKey: 'c/gate', type: 'gatehouse', style: 'rustic', size: SIZE }] })}`), 30_000)).value;
      await call('dev.world.leave');
      const tLeft = Date.now();
      let gOut = null;
      for (let i = 0; i < 240 && !gOut; i++) {
        await sleep(500);
        gOut = (await call('dev.sidecar.state')).groups.find((g) => g.id === gcu && g.status === 'awaiting_approval') ?? null;
      }
      const tOpenG = Date.now();
      await call('dev.world.open', {});
      await waitWorld();
      await sleep(2500);
      const awc = await evs((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gcu);
      check(!!gOut && gOut.updatedAt > tLeft - 5000 && awc.length === 1 && awc[0].t >= tOpenG && awc[0].serverThread === 'Server thread'
        && JSON.stringify(awc[0].awaiting) === '["c/gate"]',
        `set ${gcu} began waiting on the title screen; GROUP_AWAITING_APPROVAL fired once after the world loaded (${awc.length ? awc[0].t - tOpenG : '?'} ms after the open)`, { gOut, awc });
      await result(await api(`groupcancel ${gcu}`), 20_000).catch(() => null);
      fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 500, simDesignUsd: 0.02, designConcurrency: 3 }));
      await restart();

      // ---- 9. the composite preview (client side)
      await compositeChecks(tag);
    } finally {
      if (oldCfg === null) fs.rmSync(cfgFile, { force: true });
      else fs.writeFileSync(cfgFile, oldCfg);
      await restart().catch((e) => console.log('restart:', e.message));
    }
    results.events = (await events()).filter((e) => !e.event.startsWith('SITE_'));
    break;
  }
  case 'composite': {
    await compositeChecks(Date.now().toString(36));
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
  case 'critique': {
    // phase 5a through the API (docs/CONTRACT.md "Phase 5a contract", "Java API (1.6.0)", the Java half) against the real
    // sidecar's sim backend (tools/run-apitest-client.sh --sim; no Claude). The sim critic scores each round from the request's
    // notes (`sim:critique=5/8`: round 0 scores 5 and iterates, round 1 scores 8 and ships).
    const cfgFile = path.join(SIDECAR_DATA, 'config.json');
    const oldCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const SIZE = [21, 30, 21];
    const LIBRARY = path.join(GAME_DIR, 'architect', 'library');
    const restart = async () => {
      await call('dev.launcher.restart');
      for (let i = 0; i < 100; i++) {
        await sleep(300);
        if ((await call('dev.sidecar.state')).link === 'synced' && (await call('dev.launcher.state')).state === 'running') return;
      }
      throw new Error('the helper did not come back');
    };
    const designDone = (id, ms = 180_000) => waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === id, ms);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...(oldCfg ? JSON.parse(oldCfg) : {}), simStepMs: 400, simDesignUsd: 0.05, designConcurrency: 3 }));
    try {
      await restart();
      await api('clear');
      const v = await api('version');
      const want = ['critique', 'critiqueReport', 'jobImages', 'bibleAdmin', 'bibleRestraint'];
      check(v.version === API_VERSION && want.every((f) => v.features.includes(f)), `VERSION ${v.version}, 5a features: ${want.filter((f) => v.features.includes(f)).join(', ')}`, v);

      // ---- 1. the spec's builder refuses out-of-range fields
      const bad = await api(`critspec ${b64({ mode: 'loop', maxRevisions: 5 })}`);
      const okSpec = await api(`critspec ${b64({ mode: 'loop', maxRevisions: 2, budgetUsd: 5, views: ['iso', 'front'], extraCriteria: ['reads as a mill'] })}`);
      check(/maxRevisions/.test(bad.refused ?? '') && okSpec.mode === 'LOOP', `CritiqueSpec.builder: maxRevisions 5 refused ("${bad.refused}"), a full loop spec builds`, { bad, okSpec });

      // ---- 2. the estimate: separate critique figures, absent without critique
      const plainD = { type: 'cabin', style: 'rustic', size: SIZE };
      const e0 = await result(await api(`critestimate e0 ${b64(plainD)}`), 20_000);
      const e1 = await result(await api(`critestimate e1 ${b64({ ...plainD, critique: { mode: 'loop', maxRevisions: 2 } })}`), 20_000);
      const er = await result(await api(`critestimate er ${b64({ ...plainD, critique: { mode: 'report' } })}`), 20_000);
      check(!e0.critique && e0.critiqueUsdHigh === 0 && e1.critique && e1.critiqueUsdLow > 0 && e1.critiqueUsdHigh >= e1.critiqueUsdLow
        && e1.usdHigh === e0.usdHigh && er.critique && er.critiqueUsdHigh <= e1.critiqueUsdHigh,
        `Designs.estimate: design $${e0.usdLow}-${e0.usdHigh}; loop adds $${e1.critiqueUsdLow}-${e1.critiqueUsdHigh} (${e1.critiqueMinutesLow}-${e1.critiqueMinutesHigh} min); report adds $${er.critiqueUsdLow}-${er.critiqueUsdHigh}`, { e0, e1, er });
      const ge = await result(await api(`critgroupestimate ge ${b64({ name: `Est ${tag}`, bible: 'oak', items: [{ itemKey: 'a', ...plainD, itemCritique: { mode: 'loop', maxRevisions: 1 } }, { itemKey: 'b', ...plainD }] })}`), 20_000);
      check(ge.critique && ge.items?.length === 2 && ge.items[0].critique && !ge.items[1].critique && ge.critiqueUsdHigh >= ge.items[0].critiqueUsdHigh,
        `Designs.estimate(group): critique $${ge.critiqueUsdLow}-${ge.critiqueUsdHigh} in total; per item ${ge.items?.map((i) => `${i.itemKey}:${i.critique ? `$${i.critiqueUsdHigh}` : 'off'}`).join(' ')}`, ge);

      // ---- 3. a loop design: two rounds (5 then 8), DESIGN_CRITIQUED per round, the critique on DESIGN_DONE and on the entry
      const d1 = await result(await api(`critreq d1 ${b64({ type: 'cabin', style: 'rustic', name: `Critic ${tag}`, size: SIZE, notes: 'sim:critique=5/8', ext: { 'apitest:c': tag }, critique: { mode: 'loop', budgetUsd: 5 } })}`), 30_000);
      check(/^d\d+$/.test(d1.value ?? '') && d1._thread === 'Server thread', `request(critique loop) -> ${d1.value}`, d1);
      const dd1 = await designDone(d1.value);
      const c1 = dd1?.critique;
      check(dd1?.status === 'DONE' && c1?.rounds?.length === 2 && c1.best === 1 && c1.end === 'SHIP' && c1.overall === 8 && c1.rounds[0].overall === 5
        && c1.rounds[0].issues >= 1 && c1.rounds[1].ship && c1.criticUsd > 0,
        `DESIGN_DONE ${d1.value}: ${c1?.rounds?.length} rounds (${c1?.rounds?.map((r) => r.overall).join(' -> ')}), best ${c1?.best}, ${c1?.end}; critic $${c1?.criticUsd}, revise $${c1?.reviseUsd}`, dd1);
      const evs = await events();
      const crit = evs.filter((e) => e.event === 'DESIGN_CRITIQUED' && e.id === d1.value);
      const doneT = evs.find((e) => e.event === 'DESIGN_DONE' && e.id === d1.value)?.t ?? 0;
      check(crit.length === 2 && crit[0].n === 0 && crit[1].n === 1 && crit.every((e) => e.t <= doneT && e.serverThread === 'Server thread'),
        `DESIGN_CRITIQUED once per round (${crit.map((e) => `#${e.n} ${e.overall}`).join(', ')}), before DESIGN_DONE, on the server thread`, crit);
      const sawCritiquing = evs.some((e) => e.event === 'DESIGN_UPDATED' && e.id === d1.value && e.status === 'CRITIQUING');
      check(sawCritiquing, `DESIGN_UPDATED showed Design.Status.CRITIQUING (${[...new Set(evs.filter((e) => e.event === 'DESIGN_UPDATED' && e.id === d1.value).map((e) => e.status))].join(' > ')})`);
      const entryId = dd1?.entryId;
      const ec1 = entryId ? await api(`critentry ${entryId}`) : null;
      check(ec1?.overall === 8 && ec1.end === 'SHIP' && ec1.stale === false && Object.keys(ec1.scores ?? {}).length >= 5,
        `Library.Entry(${entryId}).critique(): ${ec1?.mode} ${ec1?.overall} ${ec1?.end}, ${Object.keys(ec1?.scores ?? {}).length} scores, stale ${ec1?.stale}`, ec1);

      // ---- 4. a report critique of the entry: completes with the critique; critique.json; stale once the .nbt changes
      const rep = await result(await api(`critreport r1 ${entryId}`), 120_000);
      check(rep.mode === 'REPORT' && rep.rounds?.length === 1 && typeof rep.overall === 'number' && rep._thread === 'Server thread',
        `Designs.critique(${entryId}) -> report ${rep.overall} (${rep.openIssues?.length} open issues, ${rep.end}), on ${rep._thread}`, rep);
      const repDone = (await events()).find((e) => e.event === 'DESIGN_DONE' && e.critiqueOf === entryId);
      check(!!repDone && repDone.entryId === entryId, `its design ${repDone?.id}: critiqueOf ${repDone?.critiqueOf}, no new entry`, repDone);
      const ec2 = await api(`critentry ${entryId}`);
      const cjson = path.join(LIBRARY, entryId, 'critique.json');
      check(ec2?.mode === 'REPORT' && ec2.stale === false && fs.existsSync(cjson), `the entry's critique is now the report's (critique.json), not stale`, ec2);
      const nbt = path.join(LIBRARY, entryId, `${entryId}.nbt`);
      const orig = fs.readFileSync(nbt);
      fs.writeFileSync(nbt, Buffer.concat([orig, Buffer.from([0])]));
      const ec3 = await api(`critentry ${entryId}`);
      fs.writeFileSync(nbt, orig);
      const ec4 = await api(`critentry ${entryId}`);
      check(ec3?.stale === true && ec3.overall === ec2.overall && ec4?.stale === false, `a changed .nbt makes it stale (${ec3?.stale}); restored, fresh again (${ec4?.stale})`, { ec3, ec4 });
      const noEntry = await result(await api(`critreport r2 no_such_entry_${tag}`), 20_000);
      const loopOnEntry = await result(await api(`critreport r3 ${entryId} ${b64({ mode: 'loop' })}`), 20_000);
      check(/no library entry/.test(noEntry.error ?? '') && /report/.test(loopOnEntry.error ?? ''), `refused: an unknown entry ("${noEntry.error}"), a loop on an entry ("${loopOnEntry.error}")`, { noEntry, loopOnEntry });

      // ---- 5. a group: the group's loop for one item, an item turned off
      const gr = await result(await api(`critgroup g1 ${b64({ name: `Crit set ${tag}`, bible: 'oak', critique: { mode: 'loop', budgetUsd: 5 }, items: [
        { itemKey: 'a', type: 'house', style: 'rustic', name: `House ${tag}`, size: SIZE, notes: 'sim:critique=6/8' },
        { itemKey: 'b', type: 'cabin', style: 'rustic', name: `Hut ${tag}`, size: SIZE, itemCritique: { mode: 'off' } }] })}`), 30_000);
      const gDone = await waitEvent((e) => e.event === 'GROUP_DONE' && e.id === gr.value, 240_000);
      const gget = await api(`critgroupget ${gr.value}`);
      const ga = gget?.critiques?.a;
      check(gDone?.status === 'DONE' && ga?.rounds?.length === 2 && ga.end === 'SHIP' && gget.critiques.b === null,
        `group ${gr.value}: item a critiqued (${ga?.rounds?.map((r) => r.overall).join(' -> ')}, ${ga?.end}; rounds from its design record), item b off`, gget);

      // ---- 6. bibles: the sheet critique, restraint, archive, delete refused while pinned and for another owner, then deleted
      const sb = await result(await api(`sheetbible s1 ${b64({ prompt: 'mossy riverside mill town', name: `Moss ${tag}` })}`), 30_000);
      const sbDone = await waitEvent((e) => e.event === 'BIBLE_DONE' && e.id === sb.id, 180_000);
      const adm = await api(`bibleadmin ${sb.bibleId}`);
      check(sbDone?.status === 'DONE' && adm?.restraint?.heroMotifs?.length <= 3 && adm.restraint.accentShareMax >= 0.04 && adm.archived === false,
        `bible ${sb.bibleId}: format ${adm?.format}, restraint heroes [${adm?.restraint?.heroMotifs?.join(', ')}] accent <= ${adm?.restraint?.accentShareMax} ${adm?.restraint?.detailDensity}; sheet critique ${adm?.critique ? JSON.stringify(adm.critique).slice(0, 80) : 'none'}`, adm);
      const pinD = await result(await api(`critreq pin ${b64({ type: 'cabin', style: 'rustic', name: `Pinned ${tag}`, size: SIZE, bible: sb.bibleId })}`), 30_000);
      await designDone(pinD.value);
      const delOther = await result(await api(`bibledelete d1 ${sb.bibleId} -`), 20_000);
      const delPinned = await result(await api(`bibledelete d2 ${sb.bibleId} ${OWNER}`), 20_000);
      check(/belongs to/.test(delOther.error ?? '') && /in use/.test(delPinned.error ?? '') && (await api(`bibleget ${sb.bibleId}`)) !== null,
        `Bibles.delete refused: without the owner ("${delOther.error}"), while an entry pins it ("${(delPinned.error ?? '').slice(0, 90)}")`, { delOther, delPinned });
      await result(await api(`biblearchive a1 ${sb.bibleId} true`), 20_000);
      await sleep(1200);
      const arch = await api(`bibleadmin ${sb.bibleId}`);
      await result(await api(`biblearchive a2 ${sb.bibleId} false`), 20_000);
      await sleep(1200);
      const unarch = await api(`bibleadmin ${sb.bibleId}`);
      check(arch?.archived === true && unarch?.archived === false, `Bibles.archive: archived ${arch?.archived}, then back ${unarch?.archived}`, { arch, unarch });
      const fb = await result(await api(`bible free ${b64({ prompt: 'a short-lived test bible', name: `Gone ${tag}` })}`), 30_000);
      await waitEvent((e) => e.event === 'BIBLE_DONE' && e.id === fb.id, 180_000);
      const del = await result(await api(`bibledelete d3 ${fb.bibleId} ${OWNER}`), 20_000);
      await sleep(1200);
      check(Array.isArray(del.value ?? del) && JSON.stringify(del.value ?? del) === '[1]' && (await api(`bibleget ${fb.bibleId}`)) === null,
        `Bibles.delete(${fb.bibleId}, owner) -> versions ${JSON.stringify(del.value ?? del)}; gone`, del);

      // ---- 7. a structured job with two images
      const ij = await result(await api('imagejob i1'), 30_000);
      const ijDone = await waitEvent((e) => e.event === 'JOB_DONE' && e.id === ij.value, 120_000);
      const refused9 = await api('imagejobrefused');
      check(/^done$/i.test(ijDone?.status ?? '') && /at most 8/.test(refused9.refused ?? ''), `JobSpec.images: job ${ij.value} with 2 PNG blobs ${ijDone?.status}; 9 images refused ("${refused9.refused}")`, { ijDone, refused9 });
    } finally {
      if (oldCfg === null) fs.rmSync(cfgFile, { force: true });
      else fs.writeFileSync(cfgFile, oldCfg);
      await restart().catch((e) => console.log('restart:', e.message));
    }
    break;
  }
  case 'critique-real': {
    // ONE REAL design with the critique loop requested through the Java API (docs/CONTRACT.md "Phase 5a gate" step 6, the first
    // real Java-path check of a design): the client must run with the real sidecar under the claude login (not --sim). It costs
    // a design plus its loop (about $1-5, 5-30 min). It prints the critique: rounds, scores, issues, the end reason.
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const v = await api('version');
    check(v.version === API_VERSION && v.features.includes('critique'), `VERSION ${v.version}, critique ${v.features.includes('critique')}`, v);
    const req = { type: 'cabin', style: 'rustic', name: `Critique ${tag}`, size: [15, 14, 15], model: process.env.APITEST_MODEL ?? 'claude-sonnet-5-5',
      critique: { mode: 'loop', maxRevisions: Number(process.env.APITEST_REVISIONS ?? 2) } };
    const d = await result(await api(`critreq real ${b64(req)}`), 60_000);
    check(/^d\d+$/.test(d.value ?? ''), `request(loop) through the API -> ${d.value ?? d.error}`, d);
    const done = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === d.value, Number(process.env.APITEST_REAL_MS ?? 45 * 60_000));
    const c = done?.critique;
    console.log(JSON.stringify(c, null, 1));
    const crit = (await events()).filter((e) => e.event === 'DESIGN_CRITIQUED' && e.id === d.value);
    check(done?.status === 'DONE' && !!c?.end && c.rounds?.length >= 1 && crit.length === c.rounds.filter((r) => r.overall !== null || (r.kept && r.error)).length,
      `DESIGN_DONE ${d.value} ${done?.status}: ${c?.rounds?.length} rounds (${c?.rounds?.map((r) => r.overall).join(' -> ')}), best ${c?.best}, ${c?.end}; critic $${c?.criticUsd}, revise $${c?.reviseUsd}; ${crit.length} DESIGN_CRITIQUED`, done);
    const e = done?.entryId ? await api(`critentry ${done.entryId}`) : null;
    check(e?.stale === false && e.overall === c?.overall, `Library.Entry(${done?.entryId}).critique(): ${e?.overall}, ${e?.openIssues?.length} open issues`, e);
    break;
  }
  case 'polish':
  case 'polish-real': {
    // phase 5b through the API (docs/CONTRACT.md "Phase 5b gate" 7): an entry placed in a dev world, polished with a preview
    // (Designs.polish, PolishApply preview), the site reported outdated, its delta checked, applied and reverted
    // (Sites.checkDelta / applyDelta / revert / history), then removed exactly. `polish` runs on the sim sidecar
    // (tools/run-apitest-client.sh --sim, $0); `polish-real` on the real sidecar under the claude login (a design ~$1 plus a
    // polish ~$1-2). APITEST_NOTES="..." adds a notes-scoped polish (its scoping call) on the same entry afterwards.
    const real = step === 'polish-real';
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const waitMs = real ? Number(process.env.APITEST_REAL_MS ?? 45 * 60_000) : 180_000;
    const v = await api('api17');
    const want = ['entryVersions', 'blueprintDelta', 'deltaApply', 'siteRevert', 'deltaPreview', 'polish'];
    check(v.version === API_VERSION && want.every((f) => v.features.includes(f)), `VERSION ${v.version}, 5b features: ${want.filter((f) => v.features.includes(f)).join(', ')}`, v);
    // 1. a design -> an entry (v1)
    const req = { type: 'cabin', style: 'rustic', name: `Polish ${tag}`, size: [15, 14, 15], ...(real ? { model: process.env.APITEST_MODEL ?? 'claude-sonnet-5-5' } : {}) };
    const d = await result(await api(`critreq p0 ${b64(req)}`), 60_000);
    const dd = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === d.value, waitMs);
    const entryId = dd?.entryId;
    check(dd?.status === 'DONE' && !!entryId, `the base design ${d.value} -> entry ${entryId}`, dd);
    // 2. placed in the dev world
    await cmd(`/tp @a -20.5 ${(await groundAt(-20, -20)) + 30} -20.5`);
    const gy = await groundAt(30, 30);
    const HB = [10, gy - 16, 10, 64, gy + 40, 64];
    const pre = await call('dev.region.hash', { box: HB });
    const pl = await result(await api(`place ${entryId} 30 ${gy + 1} 30 INSTANT unowned noactor 0`), 120_000);
    check(pl.placed, `placed ${entryId} as ${pl.siteId}`, pl);
    const site = pl.siteId;
    // 3. the estimate, then the polish with a preview
    const est = await result(await api(`polishest ${entryId} 2`), 60_000);
    check(est.polish === true && est.usdHigh > 0 && est.usdHigh >= est.usdLow, `Designs.estimatePolish: $${est.usdLow}-${est.usdHigh}, ${est.minutesLow}-${est.minutesHigh} min`, est);
    const p = await result(await api(`polish ${entryId} 2 preview`), 60_000);
    check(/^d\d+$/.test(p.designId ?? ''), `Designs.polish(${entryId}, preview) -> ${p.designId}`, p);
    const pd = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === p.designId, waitMs);
    const pg = await api(`polishget ${p.designId}`);
    console.log(JSON.stringify(pg));
    const installed = pg?.polish?.installed ?? 0;
    check(pd?.status === 'DONE' && pg?.kind === 'POLISH' && !!pg?.polish?.end, `the polish ended ${pg?.polish?.end}: ${pg?.polish?.accepted}/${pg?.polish?.steps} steps accepted, v${installed || '-'}, $${pg?.polish?.usd}`, pg);
    const ev = await api(`eversions ${entryId}`);
    check(installed ? ev.version === installed && ev.versions.length >= 2 && ev.atVersion1 : ev.version === 1, `Library.versions(${entryId}): head v${ev.version}, ${ev.versions?.length} versions`, ev);
    if (installed) {
      const vev = (await events()).find((e) => e.event === 'ENTRY_VERSIONED' && e.entry === entryId);
      check(!!vev && vev.version === installed, `ENTRY_VERSIONED ${entryId} v${vev?.version}`, vev);
      // 4. the site is outdated; the preview's verdict; apply; history; revert; Remove exact
      const od = await api('outdated -');
      check(Array.isArray(od) && od.some((x) => x.site === site && x.version === 1 && x.head === installed), `Sites.outdated lists ${site} (v1, head v${installed})`, od);
      const c = await api(`checkdelta ${site} 0`);
      check(c.applicable && c.added + c.removed + c.changed > 0, `Sites.checkDelta(${site}): +${c.added} -${c.removed} ~${c.changed}, parts ${JSON.stringify(c.parts)}`, c);
      const a = await result(await api(`applydelta ${site} 0`), 120_000);
      check(a.applied && a.to === installed, `Sites.applyDelta: v${a.from} -> v${a.to}, ${a.written} cells`, a);
      const h = await api(`shistory ${site}`);
      check(h.length === 2 && h[1].version === installed, `Sites.history: ${h.map((x) => `v${x.version} ${x.kind}`).join(', ')}`, h);
      const r = await result(await api(`srevert ${site} 1`), 120_000);
      check(r.applied && r.to === 1, `Sites.revert(${site}, 1): back to v${r.to}`, r);
    }
    const rm = await result(await api(`remove ${site} - force keep`), 300_000);
    await call('dev.wait', { ms: 2000 }).catch(() => null);
    const post = await call('dev.region.hash', { box: HB });
    check(rm.removed && post.sha256 === pre.sha256, `Remove ${site} is exact`, rm);
    if (process.env.APITEST_NOTES) {
      const n = await result(await api(`polish ${entryId} 1 none ${process.env.APITEST_NOTES}`), 60_000);
      const nd = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === n.designId, waitMs);
      const ng = await api(`polishget ${n.designId}`);
      console.log(JSON.stringify(ng));
      check(nd?.status === 'DONE' && !!ng?.polish?.end, `a notes-scoped polish ("${process.env.APITEST_NOTES}") ended ${ng?.polish?.end}: ${ng?.polish?.accepted}/${ng?.polish?.steps} accepted, $${ng?.polish?.usd}`, ng);
    }
    break;
  }
  case 'critique-polish-real': {
    // ONE REAL new design with critique.mode "polish" through the Java API (docs/CONTRACT.md "Phase 5b gate" 7): round 0,
    // a report, then the polish steps as a separate polish design. Claude login; about $2-4.
    const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
    const tag = Date.now().toString(36);
    const req = { type: 'cabin', style: 'rustic', name: `CritPolish ${tag}`, size: [15, 14, 15], model: process.env.APITEST_MODEL ?? 'claude-sonnet-5-5',
      critique: { mode: 'polish', maxRevisions: 2 } };
    const d = await result(await api(`critreq cp ${b64(req)}`), 60_000);
    check(/^d\d+$/.test(d.value ?? ''), `request(critique polish) through the API -> ${d.value ?? d.error}`, d);
    const done = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id === d.value, Number(process.env.APITEST_REAL_MS ?? 45 * 60_000));
    console.log(JSON.stringify(done?.critique ?? null));
    check(done?.status === 'DONE' && !!done.entryId, `DESIGN_DONE ${d.value} ${done?.status}: entry ${done?.entryId}, critique ${done?.critique?.mode} ${done?.critique?.end ?? ''}`, done);
    const pol = await waitEvent((e) => e.event === 'DESIGN_DONE' && e.id !== d.value && (e.kind === 'POLISH' || e.polishOf === done?.entryId || e.entryId === done?.entryId), Number(process.env.APITEST_REAL_MS ?? 45 * 60_000)).catch(() => null);
    const pg = pol ? await api(`polishget ${pol.id}`) : null;
    console.log(JSON.stringify(pg));
    check(!!pg?.polish?.end && pg.kind === 'POLISH', `its polish design ${pol?.id}: ${pg?.polish?.end}, ${pg?.polish?.accepted}/${pg?.polish?.steps} accepted, $${pg?.polish?.usd}`, { pol, pg });
    break;
  }
  default:
    console.error('usage: node tools/apitest.mjs survival|jobs|catchup|sets|massing|composite|preview|critique|critique-real|polish|polish-real');
    process.exit(2);
}

fs.writeFileSync(path.join(OUT, `${step}.json`), JSON.stringify(results, null, 1) + '\n');
console.log(`${failures === 0 ? 'ALL OK' : `${failures} FAILED`} -> ${path.join(OUT, `${step}.json`)}`);
process.exitCode = failures ? 1 : 0;
dev.close();
