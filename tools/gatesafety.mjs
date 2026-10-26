#!/usr/bin/env node
// Slice SAFETY gate (docs/CONTRACT.md "SAFETY (as built)"), DEV MODE: the slice's own in-game check, against a client of the run
// worktree (GATE6B_RUN, default `../architect-mc-SAFETY-run`, a detached worktree at this checkout's HEAD; the sim sidecar). $0: no
// Claude call anywhere.
//
//   node tools/gatesafety.mjs <step>
//     start [world] | stop             the client of the run worktree
//     ingame    (safety-ingame)        a small clean placement places on one Enter; a big one (the threshold, or one replacing a
//                                      block that isn't terrain) arms on the first Enter (the HUD's countdown, shot at GUI scale 2
//                                      and 4) and places on the second; a held Enter, Esc and moving the ghost disarm; terrain in
//                                      the box is not "replaced"; force (Shift+Enter) and Place on top stay one confirm;
//                                      /architect remove answers with a summary and a one-time [Confirm] that works, is single
//                                      use and expires after 30 s; confirm (typed) and the [Undo] link go ahead (a stale [Undo]
//                                      asks); the Undo last placement key removes the player's newest own site on the second press
//                                      within 5 s and never a site another mod owns; the Status tab's safety line
//     report                           REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-safety/<step>.json in the main checkout (GATESAFETY_OUT overrides), all.log, the shots in <out>/shots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-SAFETY-run');
process.env.GATE6B_OUT = process.env.GATESAFETY_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-safety');
process.env.GATE6B_SIDECAR_PORT ??= '8902';
process.env.GATE6B_DEV_PORT ??= '8903';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;
L.refuseKeys();
const SHOTS = path.join(OUT, 'shots');
const FLAT = 'G6B Flat Base';
const ORIGIN = [4, 64, 12];
const UNDO_MAPPING = 'key.architect_mc.undo_last';
const boxOf = (st) => { const [a, b] = String(st.box).split(' .. ').map((t) => t.split(',').map(Number)); return { min: a, max: b }; };

const steps = {};
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice SAFETY is $0: sim sidecar, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await startClient(process.argv[3] ?? 'G6B Safety Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};

const chat = (c) => call('dev.ui2b.command', { cmd: c }, 60_000);
const texts = (r) => r.messages.map((m) => m.text);
const links = (r) => r.messages.flatMap((m) => m.links);
async function shot(name, { frames = 4 } = {}) {
  const r = await call('dev.screenshot', { name: `safety_${name}`, hideHud: false, frames, waitChunks: false }, 120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const dst = path.join(SHOTS, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  return { name, path: dst, width: r.width, height: r.height };
}
const scale = async (s) => { await call('dev.gui.scale', { scale: s }); await sleep(400); };
const buildState = () => call('dev.build.state');
async function waitVerdict(ms = 15_000) {
  const end = Date.now() + ms;
  let st;
  while (Date.now() < end) {
    st = await buildState();
    if (st.serverVerdict) return st;
    await sleep(200);
  }
  return st;
}
const sites = async () => (await call('dev.sites.state')).sites.map((s) => s.id);
const exists = async (id) => (await sites()).includes(id);
const start = async (origin = ORIGIN) => { await call('dev.build.start', { blueprint: 'cabin', origin, ground: true, turns: 0 }); return waitVerdict(); };
const enter = (o = {}) => call('dev.build.enter', o, 60_000);
const setThreshold = (blocks) => call('dev.safety.threshold', { blocks });
async function waitFor(fn, ms = 10_000, every = 250) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(every); }
  return v;
}
const pressUndo = async () => { await call('dev.key', { mapping: UNDO_MAPPING }); await sleep(700); return call('dev.safety.undo'); };

steps.ingame = async () => {
  await ensure();
  const out = { shots: [] };
  await L.fresh('G6B Safety', FLAT);
  await L.setRules('exact');
  await cmd('/time set 6000');
  await L.tp(9.5, 72, 0.5, 0, 25);
  await cmd('/gamemode creative');
  await call('dev.ui2b.siteHud', { mode: 'full' });
  const th0 = await call('dev.safety.threshold');
  out.thresholdAtStart = th0.threshold;
  check(th0.threshold === 1000, `the threshold defaults to 1000 (confirmBlocks: ${th0.threshold})`, th0);

  // ---------------------------------------------------------------- a small clean placement: one Enter
  let st = await start();
  const blocks = st.safety?.blocks;
  out.cabinBlocks = blocks;
  await setThreshold(blocks + 1);
  st = await waitVerdict();
  await sleep(300);
  st = await buildState();
  check(st.safety.big === false && st.safety.replaced === 0 && st.hud.some((r) => /^✔ Ready: Enter places it/.test(r)),
    `small and clean (cabin ${blocks} blocks, threshold ${blocks + 1}): not big, "Ready: Enter places it" (${JSON.stringify(st.hud)})`, st.safety);
  const small = await enter();
  check(small.sent === true && small.placed === true, `one Enter places a small clean placement (${small.message})`, small);
  const siteSmall = small.siteId;
  const undoLink = (small.lastChat?.links ?? []).find((l) => l.text === '[Undo]');
  check(undoLink?.value === `/architect remove ${siteSmall} undo`, `the Placed line's [Undo] runs /architect remove ${siteSmall} undo (${undoLink?.value})`, small.lastChat);
  // the [Undo] link: one click while it is the latest own placement
  const undoClick = await call('dev.ui2b.click', { value: undoLink?.value ?? `/architect remove ${siteSmall} undo` });
  await sleep(1500);
  await call('dev.screen', { open: null });
  check(!(await exists(siteSmall)) && !/Confirm/i.test(String(undoClick.screen)), `clicking [Undo] on the latest placement removes ${siteSmall} at once (screen ${undoClick.screen})`);

  // ---------------------------------------------------------------- big by count: two Enters, the HUD counts down
  await setThreshold(blocks);
  st = await start();
  await sleep(300);
  st = await buildState();
  check(st.safety.big === true && st.hud.some((r) => /^✔ Ready: Enter twice places it \(/.test(r)),
    `big at the threshold (${blocks} >= ${blocks}): "Ready: Enter twice places it" (${JSON.stringify(st.hud)})`, st.safety);
  await scale(2);
  let a1 = await enter();
  let armedRe = new RegExp(`^▲ Press Enter again to place ${Number(blocks).toLocaleString('en-US')} blocks \\([1-5]\\)`);
  check(a1.sent === false && a1.safety.armed === true && a1.hud.some((r) => armedRe.test(r)) && a1.hud.some((r) => /\[! confirm armed: Enter\]/.test(r))
    && a1.hud.some((r) => /Enter confirm/.test(r)), `the first Enter arms: nothing sent, the countdown and the chip in the HUD (${JSON.stringify(a1.hud)})`, a1.safety);
  out.shots.push(await shot('armed_s2'));
  const held = await enter({ repeat: true });
  check(held.sent === false && held.safety.armed === true, 'a held Enter (OS key repeat) never places', held.safety);
  // Esc disarms (the ghost stays)
  const esc = await call('dev.build.escape');
  check(esc.active === true && esc.safety.armed === false && !esc.hud.some((r) => /Press Enter again/.test(r)), `Esc disarms, the ghost stays (active ${esc.active})`, esc.safety);
  // re-arm at GUI scale 4 for the shot
  await scale(4);
  a1 = await enter();
  check(a1.safety.armed === true, 'Enter arms again');
  out.shots.push(await shot('armed_s4'));
  // moving the ghost disarms
  await call('dev.build.nudge', { forward: 1 });
  await sleep(200);
  const moved = await buildState();
  check(moved.safety.armed === false, `moving the ghost disarms (armed ${moved.safety.armed})`, moved.safety);
  await call('dev.build.nudge', { forward: -1 });
  await waitVerdict();
  await sleep(300);
  // the window runs out after 5 s
  await enter();
  await sleep(5600);
  const late = await buildState();
  check(late.safety.armed === false, `the arm runs out after 5 s (armed ${late.safety.armed})`, late.safety);
  // armed then confirmed
  await scale(2);
  a1 = await enter();
  await sleep(450);
  const two = await enter();
  check(a1.safety.armed === true && two.sent === true && two.placed === true, `the second Enter within 5 s places it (${two.message})`, two);
  const siteBig = two.siteId;

  // ---------------------------------------------------------------- Place on top: its own second press is the confirm (one, not stacked)
  st = await start();
  const ontop1 = await enter();
  await sleep(300);
  const ontopSt = await buildState();
  check(ontop1.sent === true && ontop1.placed === false && ontopSt.layerArmed === true && ontopSt.safety.armed === false,
    `over ${siteBig} the first Enter goes to the server (an overlap refusal arms Place on top, not the big confirm): layerArmed ${ontopSt.layerArmed}`, ontopSt.safety);
  const ontop2 = await enter();
  check(ontop2.sent === true, `Enter again sends Place on top at once (no extra confirm): ${ontop2.placed ? `placed ${ontop2.siteId}` : ontop2.message}`, ontop2);
  if (ontop2.placed) await chat(`/architect remove ${ontop2.siteId} confirm`);
  await call('dev.build.cancel').catch(() => null);

  // ---------------------------------------------------------------- big by replacing: a plank wall in the box (not terrain); dirt is terrain
  await setThreshold(1_000_000);
  const O2 = [ORIGIN[0] + 40, ORIGIN[1], ORIGIN[2]];
  st = await start(O2);
  const bx = boxOf(st);
  const cell = [bx.min[0] + 3, bx.min[1] + 2, bx.min[2] + 3];
  await call('dev.build.cancel');
  await cmd(`/setblock ${cell.join(' ')} minecraft:dirt`);
  st = await start(O2);
  await sleep(300);
  st = await buildState();
  check(st.safety.replaced === 0 && st.safety.big === false && st.conflicts.obstructed >= 1,
    `a dirt block in the box is terrain, not "replaced" (obstructed ${st.conflicts.obstructed}, replaced ${st.safety.replaced}, big ${st.safety.big})`, st.safety);
  await call('dev.build.cancel');
  await cmd(`/setblock ${cell.join(' ')} minecraft:oak_planks`);
  st = await start(O2);
  await sleep(300);
  st = await buildState();
  check(st.safety.replaced >= 1 && st.safety.big === true && st.hud.some((r) => /Enter twice places it \(replaces 1 block that isn't terrain\)/.test(r)),
    `a plank in the box makes it big at any threshold (replaced ${st.safety.replaced}; ${JSON.stringify(st.hud)})`, st.safety);
  a1 = await enter();
  check(a1.hud.some((r) => /Press Enter again to place .*, replacing 1 that isn't terrain/.test(r)), `the armed line names what it replaces (${JSON.stringify(a1.hud)})`, a1.hud);
  out.shots.push(await shot('armed_replacing_s2'));
  const e1 = await call('dev.build.escape');
  const e2 = await call('dev.build.escape');
  check(e1.active === true && e2.active === false, `Esc disarms first, a second Esc cancels (active ${e1.active} then ${e2.active})`);
  await cmd(`/setblock ${cell.join(' ')} minecraft:air`);

  // ---------------------------------------------------------------- force: the block-entity refusal and Shift+Enter, one confirm
  await setThreshold(blocks);
  await cmd(`/setblock ${cell.join(' ')} minecraft:chest`);
  st = await start(O2);
  const f1 = await enter();
  await sleep(300);
  const fst = await buildState();
  check(f1.sent === true && f1.placed === false && fst.forceArmedNow === true && fst.safety.armed === false,
    `a big placement over a chest: the first Enter goes to the server and arms force, not the big confirm (forceArmed ${fst.forceArmedNow})`, fst.safety);
  const f2 = await enter({ shift: true });
  check(f2.sent === true && f2.placed === true, `Shift+Enter then places at once, no second confirm (${f2.message})`, f2);
  const siteForce = f2.siteId;

  // ---------------------------------------------------------------- /architect remove: summary, [Confirm] token (once, 30 s), typed confirm
  const ask = await chat(`/architect remove ${siteBig}`);
  const confirmLink = links(ask).find((l) => l.text === '[Confirm]');
  const tokenRe = new RegExp(`^/architect remove ${siteBig} confirm [0-9a-f]{8}$`);
  check(ask.success && /^Remove \S+ \(.*, [\d,]+ blocks; the ground is put back\)\?/.test(ask.messages[0]?.text ?? '') && tokenRe.test(confirmLink?.value ?? '')
    && await exists(siteBig), `/architect remove asks: "${ask.messages[0]?.text}" -> [Confirm] ${confirmLink?.value}; ${siteBig} still stands`, texts(ask));
  out.removeAsk = texts(ask);
  out.shots.push(...await (async () => {
    await call('dev.screen', { open: 'chat' }); await sleep(500);
    const s = await shot('remove_confirm_chat_s2');
    await call('dev.screen', { open: null });
    return [s];
  })());
  const wrong = await chat(`/architect remove ${siteBig} confirm deadbeef`);
  check(wrong.result === 0 && /not valid/.test(texts(wrong).join(' ')) && await exists(siteBig), `a wrong token removes nothing ("${texts(wrong)[0]}")`);
  const clicked = await call('dev.ui2b.click', { value: confirmLink?.value ?? '' });
  await sleep(1500);
  await call('dev.screen', { open: null });
  check(!(await exists(siteBig)) && !/Confirm/i.test(String(clicked.screen)), `clicking [Confirm] removes ${siteBig}`);
  const again = await chat(confirmLink?.value ?? '');
  check(again.result === 0 && /not valid/.test(texts(again).join(' ')), `the same [Confirm] a second time does nothing ("${texts(again)[0]}")`);
  // expiry: a token older than 30 s
  const askF = await chat(`/architect remove ${siteForce} force`);
  const fLink = links(askF).find((l) => l.text === '[Confirm]');
  check(new RegExp(`^/architect remove ${siteForce} force confirm [0-9a-f]{8}$`).test(fLink?.value ?? ''), `remove force asks too, its link keeps force (${fLink?.value})`);
  await sleep(31_000);
  const expired = await chat(fLink?.value ?? '');
  check(expired.result === 0 && /expired/.test(texts(expired).join(' ')) && await exists(siteForce), `after 30 s the [Confirm] has expired, nothing removed ("${texts(expired)[0]}")`);
  const typed = await chat(`/architect remove ${siteForce} force confirm`);
  check(typed.success && !(await exists(siteForce)), `typed confirm removes at once ("${texts(typed)[0]}")`);
  await cmd(`/setblock ${cell.join(' ')} minecraft:air`);
  const unknown = await chat('/architect remove cabn_9');
  check(unknown.result === 0 && !links(unknown).some((l) => l.text === '[Confirm]'), `an unknown id is not asked about ("${texts(unknown)[0]}")`);

  // ---------------------------------------------------------------- a stale [Undo] asks
  await setThreshold(1000);
  await start();
  const x1 = await call('dev.build.confirm', {}, 60_000);
  await start([ORIGIN[0] + 20, ORIGIN[1], ORIGIN[2]]);
  const x2 = await call('dev.build.confirm', {}, 60_000);
  const stale = await chat(`/architect remove ${x1.siteId} undo`);
  check(stale.success && /not your latest placement/.test(texts(stale).join(' ')) && links(stale).some((l) => l.text === '[Confirm]') && await exists(x1.siteId),
    `[Undo] on an older site asks like remove ("${texts(stale)[0]}")`);

  // ---------------------------------------------------------------- the Undo last placement key; another mod's site is never touched
  const owned = await call('dev.safety.placeOwned', { blueprint: 'cabin', origin: [ORIGIN[0] + 60, ORIGIN[1], ORIGIN[2] + 30], owner: 'othermod:test' });
  check(owned.placed === true, `another mod's site placed after them (${owned.siteId}, owner othermod:test)`, owned);
  const u0 = await call('dev.safety.undo');
  check(u0.key === 'Z' && u0.latest === x2.siteId, `the key is Z; it would undo ${x2.siteId}, not ${owned.siteId} (latest ${u0.latest})`, u0);
  await call('dev.build.cancel').catch(() => null);
  await scale(2);
  const u1 = await pressUndo();
  const toasts = await call('dev.ui2b.toasts');
  check(u1.armedSite === x2.siteId && u1.secondsLeft >= 1 && /Undo last placement/.test(JSON.stringify(toasts)) && await exists(x2.siteId),
    `the first Z arms on ${u1.armedSite} with a toast, nothing removed yet (${u1.lastMessage})`, u1);
  out.shots.push(await shot('undo_armed_s2'));
  await sleep(5600);
  const u2 = await pressUndo();
  check(u2.armedSite === x2.siteId && await exists(x2.siteId), 'after 5 s the window ran out: Z arms again instead of removing', u2);
  await sleep(400);
  await call('dev.key', { mapping: UNDO_MAPPING });
  const goneX2 = await waitFor(async () => !(await exists(x2.siteId)));
  const u3 = await call('dev.safety.undo');
  check(goneX2 && await exists(owned.siteId), `the second Z within 5 s removes ${x2.siteId} ("${u3.lastMessage}"); ${owned.siteId} stays`, u3);
  check(u3.latest === x1.siteId, `next it would undo ${x1.siteId}, never ${owned.siteId} (latest ${u3.latest})`, u3);
  await sleep(400);
  await pressUndo();
  await sleep(400);
  await call('dev.key', { mapping: UNDO_MAPPING });
  const goneX1 = await waitFor(async () => !(await exists(x1.siteId)));
  const u4 = await pressUndo();
  check(goneX1 && await exists(owned.siteId) && u4.armedSite == null && /Nothing to undo|No site you placed/.test(String(u4.lastMessage)),
    `then ${x1.siteId}; with only another mod's site left Z has nothing to undo ("${u4.lastMessage}"), ${owned.siteId} stands`, u4);
  out.ownedStands = await exists(owned.siteId);
  await call('dev.sites.remove', { site: owned.siteId, force: true });

  // ---------------------------------------------------------------- the Status tab (threshold and key) and the "?" legend
  for (const s of [2, 4]) {
    await scale(s);
    await call('dev.ui.open', { tab: 'status' });
    await sleep(800);
    out.shots.push(await shot(`status_s${s}`));
    await call('dev.screen', { open: null });
  }
  await scale(2);
  await start();
  await call('dev.build.legend', { on: true });
  await sleep(300);
  const leg = await buildState();
  const legKeys = leg.hud.filter((r) => r.startsWith('keys:')).join(' ');
  check(/Z undo last placement/.test(legKeys) && /1,000\+ blocks: Enter twice/.test(legKeys), `the "?" legend names Z and the threshold (${legKeys})`, leg.hud);
  out.shots.push(await shot('legend_s2'));
  await call('dev.build.legend', { on: false });
  await call('dev.build.cancel');
  await setThreshold(1000);
  spendZero();
  return out;
};

steps.report = async () => {
  const rows = fs.readdirSync(OUT).filter((f) => /^(ingame)\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
  const md = ['# SAFETY gate', '', ...rows.flatMap((r) => [`## ${r.step} (${r.seconds.toFixed(0)} s, head ${r.head.slice(0, 8)})`, '',
    ...Object.entries(r.results).map(([m, x]) => `- ${x.ok ? 'ok' : 'FAIL'} ${m}`), '', ...(r.data?.shots ?? []).map((s) => `- shot ${s.name}: ${s.path}`), ''])];
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${md.join('\n')}\n`);
};

const name = process.argv[2];
if (!steps[name]) { console.error(`usage: node tools/gatesafety.mjs ${Object.keys(steps).join('|')}`); process.exit(2); }
const t0 = Date.now();
let data, error;
log(`== ${name}`);
try { data = await steps[name](); } catch (e) { error = String(e?.stack ?? e); log(error); check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
if (!['start', 'stop', 'report'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
const nFail = Object.values(results).filter((x) => !x.ok).length;
log(nFail ? `${nFail} FAILURE(S)` : `ALL ${Object.keys(results).length} PASS`);
process.exit(nFail ? 1 : 0);
