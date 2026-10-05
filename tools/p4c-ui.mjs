#!/usr/bin/env node
// Phase 4c UI walk-through (docs/CONTRACT.md "Phase 4c contract", "UI") against a running dev client with the sim sidecar
// (tools/run-apitest-client.sh --sim, a flat world is best): the Design tab's Massing first, the massing review bar in the
// world (its keys, Redirect..., Approve), the Designs tab (massing, detail and conformance), the set dialog's massing fields,
// a set's massings in a row with per-item Approve / Redirect / Cancel, and a set approved by its owner. Every screen and
// ghost is screenshotted (P4C_SHOTS prefix, default mod-p4c-ui) into the client's ARCHITECT_SHOTS_DIR; evidence goes to
// artifacts/mod-p4c/p4c-ui.json.
//
//   ARCHITECT_DEV_PORT=8791 node tools/p4c-ui.mjs [step...]    steps: design plot set owner (default: all)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.P4C_OUT ? path.resolve(process.env.P4C_OUT) : path.join(root, 'artifacts', 'mod-p4c');
fs.mkdirSync(OUT, { recursive: true });
const PREFIX = process.env.P4C_SHOTS ?? 'mod-p4c-ui';
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ['design', 'plot', 'set', 'owner'];
const dev = await DevClient.connect({ timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { shots: [] };
let failures = 0;
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const shot = async (name, hideHud = false) => {
  const s = await call('dev.screenshot', { name: `${PREFIX}-${name}`, hideHud }, 120_000);
  results.shots.push(s.path);
  console.log(`     shot ${s.path}`);
  return s.path;
};
const until = async (what, fn, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out: ${what}`);
};
const sidecar = () => call('dev.sidecar.state');
const massing = () => call('dev.massing.state');
const cmd = (c) => call('dev.command', { cmd: c });

// a clean spot: the player on the flat ground, looking north, daytime, nothing open
await call('dev.release', { mode: 'creative' }).catch(() => null);
await call('dev.screen', { open: null }).catch(() => null);
await call('dev.time', { ticks: 6000 }).catch(() => null);
await call('dev.weather', { clear: true }).catch(() => null);
const st0 = await call('dev.state');
const P = { x: Math.floor(st0.player.x), y: Math.floor(st0.player.y), z: Math.floor(st0.player.z) };
await cmd(`/tp @s ${P.x} ${P.y} ${P.z} 180 25`);
await sleep(500);
const look = async (x, y, z, at) => {
  await call('dev.camera', { x, y, z, lookAt: at, mode: 'spectator', closePause: true });
  await call('dev.hud', { hidden: false });
  await sleep(1200);
};

if (steps.includes('design')) {
  // ---- the Design tab with Massing first (on by default for L)
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'gatehouse', style: 'rustic', size: 'L', name: 'The Ford Gate', notes: 'a gatehouse over the ford road' });
  const ds = await call('dev.design.state');
  check(ds.form.massingFirst === true && ds.form.massingFirstSet === null, `Design tab: Massing first on by default for size L`, ds.form);
  await shot('design-tab');
  await call('dev.design.fill', { size: 'M' });
  const dm = await call('dev.design.state');
  check(dm.form.massingFirst === false, 'Massing first off by default for size M');
  await call('dev.ui.click', { control: 'design:massing_first' });
  const dt = await call('dev.design.state');
  check(dt.form.massingFirst === true && dt.form.massingFirstSet === true, 'the toggle turns it on for M');
  await call('dev.design.fill', { size: 'L', massingFirst: null });
  // ---- submit: a massing job; its massing opens the review bar in the world
  await cmd(`/tp @s ${P.x} ${P.y} ${P.z} 180 25`);
  const sent = await call('dev.design.submit', {}, 30_000);
  const designId = sent.sent?.designId;
  check(!!designId, `Design it -> ${designId} (a massing job)`, sent.sent);
  await call('dev.screen', { open: null });
  const rv = await until('the massing review', async () => (await massing()).review);
  check(/^mas_/.test(rv.massing) && rv.version === 1, `the review opened: ${rv.massing} v${rv.version} at ${rv.origin} (turns ${rv.turns})`, rv);
  const [ox, oy, oz] = rv.origin.split(',').map(Number);
  await look(ox + 8, oy + 14, oz + 34, { x: ox + 8, y: oy + 6, z: oz + 6 });
  await call('dev.hud', { hidden: false });
  const ms1 = await massing();
  check(!!ms1.barRect && ms1.composite.keys['architect:massing']?.layers?.[0]?.style === 'MASSING', `the massing ghost and the bar (${ms1.barRect})`, ms1.composite.keys);
  await shot('review-bar');
  // ---- R: Redirect…
  const kr = await call('dev.massing.key', { key: 'r' });
  check(kr.consumed && kr.screen === 'RedirectScreen', 'R opens Redirect…');
  await call('dev.massing.redirect', { notes: 'make it L-shaped with a tower at the corner', submit: false });
  await sleep(500);
  await shot('redirect-dialog');
  await call('dev.massing.redirect', { notes: 'make it L-shaped with a tower at the corner', submit: true });
  const rv2 = await until('the redirected massing', async () => {
    const s = await massing();
    return s.review?.version === 2 ? s.review : null;
  });
  check(rv2.massing === rv.massing, `the redirect replaced the ghost: ${rv2.massing} v${rv2.version}`, rv2);
  await sleep(800);
  await shot('review-bar-v2');
  // ---- Backspace cancels, Review massing (Designs tab) brings it back, Enter approves
  const kc = await call('dev.massing.key', { key: 'backspace' });
  check(kc.consumed && !kc.review && !kc.composite.keys['architect:massing'], 'Backspace cancels: the ghost goes');
  await call('dev.ui.open', { tab: 'designs' });
  const sc = await sidecar();
  const redirectDesign = sc.designs.find((d) => d.id !== designId && d.title && sc.massings.some((m) => m.id === rv.massing && m.designId === d.id));
  await call('dev.ui.click', { control: `design:${redirectDesign?.id ?? designId}` });
  await sleep(400);
  await shot('designs-massing');
  await call('dev.ui.click', { control: 'design:review_massing' });
  await sleep(500);
  const back = await massing();
  check(back.review?.version === 2 && back.screen === null, 'Review massing shows it again (and closes the screen)', back.review);
  const before = new Set((await sidecar()).designs.map((d) => d.id));
  const ka = await call('dev.massing.key', { key: 'enter' });
  check(ka.consumed, 'Enter approves');
  const detail = await until('the detail design', async () => {
    const s = await sidecar();
    return s.designs.find((d) => !before.has(d.id) && d.status === 'done' && d.blueprintId) ?? null;
  }, 180_000);
  check(!!detail.blueprintId, `the detail pass ${detail.id} -> ${detail.blueprintId}`, detail);
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${detail.id}` });
  await sleep(400);
  const ui = await call('dev.ui.state');
  check(ui.controls.some((c) => c.id === 'show_library'), 'the detail design in the Designs tab (Show in Library)');
  await shot('designs-detail-conformance');
  await call('dev.screen', { open: null });
}

if (steps.includes('plot')) {
  // ---- a marked plot: Massing first is on by default, the massing ghost stands on the plot, the detail keeps the plot
  await call('dev.screen', { open: null });
  await cmd(`/tp @s ${P.x} ${P.y} ${P.z} 180 25`);
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'gatehouse', style: 'rustic', name: 'The Plot Gate', massingFirst: null });
  await call('dev.plot.start', {});
  const X0 = P.x + 20;
  const Z0 = P.z - 40;
  await call('dev.plot.corner', { x: X0, y: P.y, z: Z0 });
  await call('dev.plot.corner', { x: X0 + 19, y: P.y, z: Z0 + 19, front: 'south' });
  await sleep(500);
  const pf = await call('dev.design.state');
  check(pf.form.size === 'plot' && pf.form.massingFirst === true && pf.form.massingFirstSet === null, `a marked plot (${pf.form.plot}): Massing first on by default`, pf.form);
  const sent = await call('dev.design.submit', {}, 30_000);
  await call('dev.screen', { open: null });
  const rv = await until('the massing review on the plot', async () => (await massing()).review);
  const [ox, oy, oz] = rv.origin.split(',').map(Number);
  check(rv.onPlot === true && ox >= X0 && oz >= Z0 && ox + 11 <= X0 + 20 && oz + 10 <= Z0 + 20,
    `the massing ghost stands on the plot: ${rv.massing} at ${rv.origin} (plot ${X0},${Z0} 20x20)`, { rv, sent: sent.sent });
  await look(X0 + 10, P.y + 16, Z0 + 40, { x: X0 + 10, y: P.y + 4, z: Z0 + 10 });
  await shot('review-on-plot');
  const before = new Set((await sidecar()).designs.map((d) => d.id));
  await call('dev.massing.key', { key: 'enter' });
  const detail = await until('the detail design', async () => {
    const s = await sidecar();
    return s.designs.find((d) => !before.has(d.id) && d.status === 'done' && d.blueprintId) ?? null;
  }, 180_000);
  await sleep(1500);
  const placed = await call('dev.design.place', { blueprint: detail.blueprintId }).then(() => true, (e) => e.message);
  const bs = await call('dev.build.state').catch(() => null);
  check(placed === true && bs?.active === true, `the detail (${detail.blueprintId}) keeps the plot: Place on the plot locks the ghost on it (${placed === true ? bs?.origin : placed})`, bs);
  await shot('detail-place-on-plot');
  await call('dev.build.cancel').catch(() => null);
}

let gid = null;
if (steps.includes('set')) {
  // ---- the set dialog with the 4c fields
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.set.open');
  await call('dev.set.fill', {
    name: 'Ford hamlet', bible: 'oak', items: [{ type: 'tower', name: 'Watchtower', role: 'landmark' }, { type: 'cabin', name: 'Ferry cabin' }, { type: 'gatehouse', name: 'Ford gate' }],
    concurrency: 3, massingFirst: true, maxRedirects: 2, context: 'a hamlet at a river ford; the road runs north-south, the river east',
  });
  await sleep(1500);
  const ss = await call('dev.set.state');
  check(ss.massingFirst === true && ss.maxRedirects === 2 && ss.request?.massingFirst === true && ss.request?.maxRedirects === 2 && /river ford/.test(ss.request?.context ?? ''),
    `the set dialog: massingFirst, maxRedirects 2, context in the request`, ss.request);
  await shot('set-dialog');
  await cmd(`/tp @s ${P.x} ${P.y} ${P.z} 180 25`);
  const sub = await call('dev.set.submit', {}, 30_000);
  gid = sub.groupId;
  check(/^g\d+$/.test(gid ?? ''), `Design the set -> ${gid}`, sub);
  await call('dev.screen', { open: null });
  await cmd(`/tp @s ${P.x} ${P.y} ${P.z} 180 25`);
  const shown = await until('the set shown in a row', async () => {
    const s = await massing();
    return s.shownSet === gid ? s : null;
  }, 240_000);
  check(shown.shownItems.length === 3, `awaiting approval: the 3 massings in a row (${shown.shownItems.join(', ')})`, shown);
  const lay = shown.composite.keys[`architect:set:${gid}`].layers;
  const xs = lay.map((l) => l.origin.split(',').map(Number));
  const cx = (Math.min(...xs.map((o) => o[0])) + Math.max(...xs.map((o) => o[0]))) / 2 + 8;
  await look(cx, P.y + 20, P.z + 22, { x: cx, y: P.y + 6, z: xs[0][2] + 4 });
  await shot('set-row');
  // ---- the Designs tab: per-item Approve / Redirect… / ×
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${gid}` });
  await sleep(500);
  const ui = await call('dev.ui.state');
  const ids = ui.controls.map((c) => c.id);
  const keys = (await sidecar()).groups.find((g) => g.id === gid).items.map((i) => i.itemKey);
  check(keys.every((k) => ids.includes(`group:item_approve:${k}`) && ids.includes(`group:item_redirect:${k}`) && ids.includes(`group:item_cancel:${k}`))
    && ids.includes('group:approve_all') && ids.includes('group:show_massings'), `per-item Approve / Redirect… / × and Approve all (${keys.join(', ')})`);
  await shot('designs-set-awaiting');
  // redirect the last item through the inline notes field, approve the others
  const last = keys[keys.length - 1];
  await call('dev.ui.click', { control: `group:item_redirect:${last}` });
  await call('dev.ui.focus', { field: 'redirect' });
  await call('dev.type', { text: 'taller gate towers and a wider arch' });
  await sleep(300);
  await shot('designs-set-redirect');
  await call('dev.ui.click', { control: 'group:redirect_send' });
  await sleep(500);
  for (const k of keys.slice(0, -1)) {
    await call('dev.ui.click', { control: `group:item_approve:${k}` });
    await sleep(500);
  }
  const again = await until('the redirected item waits again', async () => {
    const g = (await sidecar()).groups.find((x) => x.id === gid);
    return g?.status === 'awaiting_approval' && g.awaiting?.length === 1 && g.items.find((i) => i.itemKey === last)?.massing?.version === 2 ? g : null;
  }, 240_000);
  check(again.items.filter((i) => i.stage === 'detail').length === 2, `2 approved (detail), ${last} redirected to v2 and waiting again`, again.items.map((i) => `${i.itemKey}:${i.stage}`));
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${gid}` });
  await sleep(500);
  await shot('designs-set-round2');
  await call('dev.ui.click', { control: `group:item_approve:${last}` });
  const done = await until('the set done', async () => {
    const g = (await sidecar()).groups.find((x) => x.id === gid);
    return g?.status === 'done' ? g : null;
  }, 240_000);
  check(done.done === 3, `the set is done: ${done.done} detailed`);
  await sleep(500);
  await shot('designs-set-done');
  await call('dev.screen', { open: null });
}

if (steps.includes('owner')) {
  // ---- a set approved by its owner: the tab shows the owner and no buttons
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  await cmd('/apitest clear');
  await cmd(`/apitest group uo ${b64({ name: 'Steward plan', bible: 'oak', owner: 'steward_mc:settlement/7', massingFirst: true, approvalUi: 'owner', items: [{ itemKey: 'lot/a', type: 'cabin', style: 'rustic', size: [21, 20, 21], owner: 'steward_mc:settlement/7' }] })}`);
  const og = await until('the owner set waits', async () => (await sidecar()).groups.find((g) => g.name === 'Steward plan' && g.status === 'awaiting_approval') ?? null, 240_000);
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${og.id}` });
  await sleep(500);
  const ui = await call('dev.ui.state');
  const ms = await massing();
  check(!ui.controls.some((c) => c.id.startsWith('group:item_') || c.id === 'group:approve_all') && ms.shownSet !== og.id,
    `approvalUi owner: no approval buttons and no row in the world (shown: ${ms.shownSet})`);
  await shot('designs-set-owner');
  await cmd(`/apitest approve uo1 ${og.id} ${b64({ approve: ['lot/a'], owner: 'steward_mc:settlement/7' })}`);
  await call('dev.screen', { open: null });
}

fs.writeFileSync(path.join(OUT, 'p4c-ui.json'), JSON.stringify(results, null, 1) + '\n');
console.log(`${failures === 0 ? 'ALL OK' : `${failures} FAILED`} -> ${path.join(OUT, 'p4c-ui.json')}`);
process.exitCode = failures ? 1 : 0;
dev.close();
