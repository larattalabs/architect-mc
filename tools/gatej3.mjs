#!/usr/bin/env node
// Slice J3 in-game step (DEV MODE: the slice's own check), on a CLIENT it starts itself (the sim sidecar with ARCHITECT_SIM_COSTS=measured:
// notional sim costs so the ledger total means something; no Claude call, $0). Architect's jobs in lab-ui's Jobs & spend panel:
//   1. a design, a Massing first design (its review put aside), a set of 2 (the player's) and a Steward-owned set (/apitest group, owner
//      steward_mc:settlement/7) run;
//   2. the panel's rows: kinds, states, the massing waiting (needs you, Approve), the Steward set under its parent with no actions; the
//      ledger total (JobBoard.json todayUsd) equals the sum of the sidecar's spending objects, the Steward part in todayByMod.steward_mc;
//   3. the header's "Jobs (K)" opens the panel; shots of the header and the panel at GUI scale 2 and 4;
//   4. the massing approved from the panel (row selected, A): the detail pass starts and the row stops waiting;
//   5. the detail's "Design ready" toast carries its row ref; K opens the panel on that row.
//
//   node tools/gatej3.mjs session [world]    (gate-chains.json step j3-ingame: start, ingame, stop)
//   node tools/gatej3.mjs start [world] | ingame | stop
//
// Evidence: <GATE6B_OUT>/j3-*.json, the shots in <out>/shots (and GATEJ3_SHOTS when set), spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-J3-run');
process.env.GATE6B_OUT = process.env.GATEJ3_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-j3');
process.env.GATE6B_SIDECAR_PORT ??= '8902';
process.env.GATE6B_DEV_PORT ??= '8903';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, log, results, root, state, startClient, stopClient, cmd } = L;
L.refuseKeys();
const SHOTS = path.join(OUT, 'shots');
const EXTRA = process.env.GATEJ3_SHOTS ? path.resolve(process.env.GATEJ3_SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const OWNER = 'steward_mc:settlement/7';

async function shotOne(name) {
  const r = await call('dev.screenshot', { name: `j3_${name}`, hideHud: false, frames: 4, waitChunks: false }, 120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const dst = path.join(SHOTS, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  if (EXTRA) {
    fs.mkdirSync(EXTRA, { recursive: true });
    fs.copyFileSync(r.path, path.join(EXTRA, `${name}.png`));
  }
  shots.push(dst);
  return dst;
}
/** The state at GUI scale 2 and 4 (`fn` sets it up again after each scale change when given). */
async function shot(name, fn) {
  for (const s of [2, 4]) {
    await call('dev.gui.scale', { scale: s });
    await sleep(350);
    if (fn) await fn(s);
    await sleep(250);
    await shotOne(`${name}_s${s}`);
  }
}
async function until(what, fn, ms = 300_000, every = 800) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  throw new Error(`timed out: ${what}`);
}
async function designDone(designId, timeoutMs = 600_000) {
  return until(`design ${designId} ended`, async () => {
    const s = await call('dev.style.designState', { designId });
    return ['DONE', 'FAILED', 'CANCELLED'].includes(s.status) ? s : null;
  }, timeoutMs, 1500);
}
const j3 = () => call('dev.j3.state');
const rowOf = (st, id) => (st.architectRows ?? []).find((r) => r.id === id);
const usd = (o) => Number(o?.cost?.usd ?? 0);
const near = (a, b) => Math.abs(a - b) < 1e-6;

/** What the ledger should hold, from the sidecar's own records: sets, designs outside a set, bible jobs, protocol-2 jobs (one each). */
function expectedLedger(st) {
  const out = new Map();
  for (const o of st.sidecarObjects ?? []) {
    if (o.kind === 'design' && o.inGroup) continue; // its set counts it
    out.set(o.id, { usd: Number(o.usd ?? 0), owner: o.owner ?? '', at: Number(o.updatedAt || o.createdAt || 0) });
  }
  return out;
}
/** Today (the local day, as the panel counts it): from local midnight. */
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

const steps = {};
steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await startClient(process.argv[3] ?? 'API Sim', { backend: 'sim', env: { ARCHITECT_SIM_COSTS: 'measured' } });
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};

steps.ingame = async () => {
  const data = {};
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice J3 is $0: sim sidecar (notional measured sim costs), no Claude call' }, null, 2)}\n`);
  await cmd('/gamemode creative').catch(() => null);
  await cmd('/time set 6000').catch(() => null);
  await call('dev.screen', { open: null }).catch(() => null);
  const tag = Date.now().toString(36).slice(-4);
  let st = await j3();
  check(st.hostOnly === false && st.key === 'K', `0: the panel key is ${st.key}; singleplayer with a helper: not host-only`, { hostOnly: st.hostOnly, key: st.key });

  // ---- 1. the work: a design, a massing, a set of 2, a Steward-owned set
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'M', name: `J3 Cabin ${tag}`, massingFirst: false, parts: false });
  const s1 = await call('dev.design.submit', {}, 30_000);
  const did = s1.sent?.designId;
  check(!!did && !s1.sent.error, `1: a design -> ${did}`, s1.sent);
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'L', name: `J3 Massed ${tag}`, massingFirst: true });
  const s2 = await call('dev.design.submit', {}, 30_000);
  const mid = s2.sent?.designId;
  check(!!mid && !s2.sent.error, `1: a Massing first design -> ${mid}`, s2.sent);
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.set.open');
  await call('dev.set.fill', { name: `J3 Hamlet ${tag}`, bible: 'oak', items: [{ type: 'cabin', name: 'Ferry cabin' }, { type: 'tower', name: 'Watchtower' }], concurrency: 2, massingFirst: false });
  const s3 = await call('dev.set.submit', {}, 30_000);
  const gid = s3.groupId;
  check(/^g\d+$/.test(gid ?? ''), `1: a set of 2 -> ${gid}`, s3);
  await call('dev.screen', { open: null });
  await cmd(`/apitest group j3o ${b64({ name: `J3 Steward plan ${tag}`, bible: 'oak', owner: OWNER, items: [{ itemKey: 'lot/a', type: 'cabin', style: 'rustic', size: [15, 12, 15], owner: OWNER }] })}`);
  const og = await until('the Steward set', async () => (await call('dev.sidecar.state')).groups.find((g) => g.name === `J3 Steward plan ${tag}`) ?? null, 60_000);
  data.ids = { design: did, massing: mid, set: gid, stewardSet: og.id };

  // a running row, while it runs
  st = await j3();
  const runningSet = rowOf(st, `architect_mc:set/${gid}`);
  check(!!runningSet && ['running', 'queued', 'done'].includes(runningSet.state) && runningSet.kind === 'set', `1: the set's row while it runs (${runningSet?.state}: ${runningSet?.step})`, runningSet);

  const d1 = await designDone(did);
  check(d1.status === 'DONE', `1: the design is done (${d1.entryId})`, d1.status);
  const dm = await designDone(mid);
  check(dm.status === 'DONE', '1: the massing is done', dm.status);
  await until('the massing review', async () => (await call('dev.massing.state')).review, 60_000);
  await call('dev.massing.key', { key: 'backspace' });
  check(!(await call('dev.massing.state')).review, '1: the massing review put aside (the panel must approve it without the review open)');
  const doneSets = await until('both sets done', async () => {
    const gs = (await call('dev.sidecar.state')).groups;
    const a = gs.find((g) => g.id === gid);
    const b = gs.find((g) => g.id === og.id);
    return a?.status === 'done' && ['done', 'failed'].includes(b?.status) ? { a, b } : null;
  }, 600_000, 1500);
  check(doneSets.a.done === 2, `1: the set is done (${doneSets.a.done}/2)`, doneSets.a.status);

  // ---- 2. the rows and the ledger
  await sleep(1500);
  st = await j3();
  const mrow = rowOf(st, `architect_mc:design/${mid}`);
  const drow = rowOf(st, `architect_mc:design/${did}`);
  const srow = rowOf(st, `architect_mc:set/${gid}`);
  const orow = rowOf(st, `architect_mc:set/${og.id}`);
  check(drow?.kind === 'design' && drow.state === 'done' && /Library/.test(drow.link ?? '') && drow.spent > 0, `2: the design row: done, ${drow?.link}, $${drow?.spent}`, drow);
  check(mrow?.kind === 'massing' && mrow.state === 'needs_you' && mrow.needsYou === true && mrow.actions.includes('approve'), `2: the massing row waits for you with Approve (${mrow?.step})`, mrow);
  check(srow?.kind === 'set' && srow.state === 'done' && srow.spent > 0 && !srow.parent, `2: the set row: done, $${srow?.spent}`, srow);
  check(orow?.parent === OWNER && orow.actions.length === 0 && orow.needsYou === false, `2: the Steward set folds under ${OWNER}, no actions here`, orow);
  check(st.needsYou >= 1 && /need/.test(st.pill ?? ''), `2: the needs-you count ${st.needsYou}, pill "${st.pill}"`);
  check(!(st.architectRows ?? []).some((r) => /^architect_mc:design\//.test(r.id) && doneSets.a.items.some((i) => `architect_mc:design/${i.designId}` === r.id)), '2: the set\'s designs are in the set, not rows of their own');
  const sc = await call('dev.sidecar.state');
  const exp = expectedLedger(st);
  const today = [...exp.values()].filter((e) => e.at >= midnight());
  const expTotal = today.reduce((a, e) => a + e.usd, 0);
  const expSteward = today.filter((e) => e.owner.startsWith('steward_mc:')).reduce((a, e) => a + e.usd, 0);
  const ids = (st.architectLedger ?? []).map((c) => c.jobId);
  check(ids.length === new Set(ids).size && ids.length === exp.size && ids.every((i) => exp.has(i)), `2: the ledger has one entry per spending sidecar object (${ids.length})`, { ids, expected: [...exp.keys()] });
  check(expTotal > 0 && near(st.todayUsd, expTotal), `2: today's total $${st.todayUsd?.toFixed(4)} = the sidecar's objects $${expTotal.toFixed(4)} (estimate)`, { todayUsd: st.todayUsd, expTotal, byMod: st.todayByMod });
  check(expSteward > 0 && near(st.todayByMod?.steward_mc ?? 0, expSteward) && near((st.todayByMod?.architect_mc ?? 0) + expSteward, expTotal),
    `2: the split: Steward $${(st.todayByMod?.steward_mc ?? 0).toFixed(4)}, Architect $${(st.todayByMod?.architect_mc ?? 0).toFixed(4)}`, st.todayByMod);
  data.ledger = { todayUsd: st.todayUsd, byMod: st.todayByMod, entries: st.architectLedger };

  // ---- 3. the header's Jobs button; the panel
  await call('dev.ui.open', { tab: 'designs' });
  let ui = await call('dev.ui.state');
  const hb = (ui.controls ?? []).find((c) => c.id === 'header:jobs');
  check(!!hb && /^Jobs/.test(hb.label) && /\(K\)$/.test(hb.label), `3: the header button "${hb?.label}"`, hb);
  await shot('header', async () => { await call('dev.ui.open', { tab: 'designs' }); });
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: 'header:jobs' });
  st = await j3();
  check(st.panel === true, '3: the header button opens the panel', { screen: st.screen });
  const openOn = async (row) => { await call('dev.screen', { open: null }); await call('dev.j3.open', { row }); };
  await shot('panel_massing', async () => openOn(`architect_mc:design/${mid}`));
  st = await j3();
  check(st.selectedRow === `architect_mc:design/${mid}`, `3: the panel opens on the massing row (${st.selectedRow})`, st.debug);
  await shot('panel_steward_set', async () => openOn(`architect_mc:set/${og.id}`));

  // ---- 4. approve the massing from the panel
  await call('dev.gui.scale', { scale: 2 });
  await openOn(`architect_mc:design/${mid}`);
  const before = new Set(sc.designs.map((d) => d.id));
  const k = await call('dev.key', { key: 'a' });
  check(k.screenHandled === true, '4: A in the panel (the massing row selected)', k);
  await call('dev.screen', { open: null }); // the detail's toast shows only with no screen open
  const det = await until('the detail design', async () => (await j3()).sidecarObjects.find((d) => d.kind === 'design' && !before.has(d.id) && d.fromMassing) ?? null, 60_000);
  check(!!det, `4: the panel's Approve starts the detail pass (${det?.id}) with the review closed`);
  const after = await until('the massing row stops waiting', async () => { const x = await j3(); const r = rowOf(x, `architect_mc:design/${mid}`); return r && !r.needsYou ? { x, r } : null; }, 60_000);
  check(after.r.state === 'done' && /Approved/.test(after.r.step) && !after.r.actions.includes('approve'), `4: the massing row: ${after.r.step}`, after.r);
  data.detail = det?.id;

  // ---- 5. the toast's ref; K opens the panel on its row
  const want = `architect_mc:design/${det.id}`;
  const shown = await until('the detail\'s toast with its ref', async () => { const x = await j3(); return x.refShown === want ? x : null; }, 300_000, 250);
  check(shown.refShown === want, `5: the "Design ready" toast carries ${want}`);
  await shotOne('toast_ref_s2');
  const kk = await call('dev.key', { key: 'k' });
  st = await until('the panel from K', async () => { const x = await j3(); return x.panel ? x : null; }, 10_000, 200);
  check(st.panel === true && st.selectedRow === want, `5: K opens the panel on the toast's row (${st.selectedRow})`, { kk, debug: st.debug });
  await shotOne('panel_from_toast_s2');
  await call('dev.gui.scale', { scale: 4 });
  await sleep(400);
  await shotOne('panel_from_toast_s4');
  await shot('panel_approved', async () => openOn(`architect_mc:design/${mid}`));

  // nothing left waiting for later steps
  await call('dev.gui.scale', { scale: 2 });
  await call('dev.screen', { open: null });
  st = await j3();
  check(st.needsYou === 0, `6: nothing waits at the end (needsYou ${st.needsYou})`, st.pill);
  data.shots = shots.map((s) => path.basename(s));
  return data;
};
steps.session = async () => {
  await steps.start();
  try {
    return await steps.ingame();
  } finally {
    await call('dev.gui.scale', { scale: 2 }).catch(() => null);
    await steps.stop();
  }
};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== j3 ${name}`);
  try {
    if (!state.dev && name === 'ingame') await connect();
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  L.write?.(`j3-${name}.json`, { step: `j3-${name}`, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

const name = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gatej3.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const fails = L.fails();
  log(fails ? `${fails} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(fails ? 1 : 0);
}
