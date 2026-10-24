#!/usr/bin/env node
// Slice UI-2b gate (docs/HANDOFF-UI2b.md; docs/PLAN.md "UI track"), DEV MODE: the slice's own in-game check, against a client of the
// run worktree (GATE6B_RUN, default `../architect-mc-UI2b-run`, a detached worktree at this checkout's HEAD; the sim sidecar). $0: no
// Claude call anywhere.
//
//   node tools/gateui2b.mjs <step>
//     start [world] | stop             the client of the run worktree
//     ingame    (ui2b-ingame)          every changed command's chat output with its links (the pagers' [‹ prev] / [next ›], reload's
//                                      count and problems, did-you-mean); a design placed and the "Placed" line's [Undo] and
//                                      [Open in Library] links run; the placement HUD's states (ready, checking, the legend, force
//                                      armed, place on top with the grouped refusals), the construction HUD full / one line / hidden,
//                                      the crate's two-press Deconstruct, the helper's progress strip, shot at GUI scale 2 and 4; the
//                                      launcher's plain summary and its one ready toast
//     gallery                          the nightly UI gallery (docs/GATES.md "UI gallery"): every screen / HUD / in-world piece at GUI scale 2 and 4
//     report                           REPORT.md over the step JSONs
//
// Evidence: artifacts/gate-ui2b/<step>.json in the main checkout (GATEUI2B_OUT overrides), all.log, the shots in <out>/shots (and
// GATEUI2B_SHOTS when set), spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-UI2b-run');
process.env.GATE6B_OUT = process.env.GATEUI2B_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-ui2b');
process.env.GATE6B_SIDECAR_PORT ??= '8896';
process.env.GATE6B_DEV_PORT ??= '8897';
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, sleep } = L;
L.refuseKeys();
const SHOTS = path.join(OUT, 'shots');
const EXTRA_SHOTS = process.env.GATEUI2B_SHOTS ? path.resolve(process.env.GATEUI2B_SHOTS) : null;
const FLAT = 'G6B Flat Base';
const ORIGIN = [4, 64, 12]; // the ghost's rotated box minimum (the flat base's ground row snaps with ground: true)
/** The ghost's box from dev.build.state ("x,y,z .. x,y,z"). */
const boxOf = (st) => { const [a, b] = String(st.box).split(' .. ').map((t) => t.split(',').map(Number)); return { min: a, max: b }; };

const steps = {};
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice UI-2b is $0: sim sidecar, no Claude call' }, null, 2)}\n`);
}

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await startClient(process.argv[3] ?? 'G6B UI2b Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};

/** dev.ui2b.command: the chat output as components ({text, links}). */
const chat = (c) => call('dev.ui2b.command', { cmd: c }, 60_000);
const texts = (r) => r.messages.map((m) => m.text);
const links = (r) => r.messages.flatMap((m) => m.links);

async function shot(name, { frames = 4 } = {}) {
  const r = await call('dev.screenshot', { name: `ui2b_${name}`, hideHud: false, frames, waitChunks: false }, 120_000);
  fs.mkdirSync(SHOTS, { recursive: true });
  const dst = path.join(SHOTS, `${name}.png`);
  fs.copyFileSync(r.path, dst);
  if (EXTRA_SHOTS) {
    fs.mkdirSync(EXTRA_SHOTS, { recursive: true });
    fs.copyFileSync(r.path, path.join(EXTRA_SHOTS, `${name}.png`));
  }
  return { name, path: dst, width: r.width, height: r.height };
}
async function atScales(name, fn, scales = [2, 4]) {
  const out = [];
  for (const s of scales) {
    await call('dev.gui.scale', { scale: s });
    await sleep(400);
    if (fn) await fn(s);
    out.push(await shot(`${name}_s${s}`));
  }
  return out;
}
async function buildState() { return call('dev.build.state'); }
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

steps.ingame = async () => {
  await ensure();
  const out = { shots: [] };
  await L.fresh('G6B UI2b', FLAT);
  await L.setRules('exact');
  await cmd('/time set 6000');
  await L.tp(9.5, 72, 0.5, 0, 25);
  await cmd('/gamemode creative');
  await call('dev.ui2b.siteHud', { mode: 'full' });

  // ---------------------------------------------------------------- item 1: the paged chat lists
  // more lines than a page: 6 sites in a row (the run's library holds only the bundled designs) besides the designs
  const row = [];
  for (let i = 0; i < 6; i++) {
    await call('dev.build.start', { blueprint: 'cabin', origin: [40 + i * 16, 64, 40], ground: true, turns: 0 });
    await waitVerdict();
    const r = await call('dev.build.confirm', {}, 60_000);
    if (r.placed) row.push(r.siteId);
  }
  check(row.length === 6, `6 sites placed for the list (${row.join(' ')})`);
  const list1 = await chat('/architect list');
  const nDesigns = Number(/^(\d+) designs? in the library/.exec(list1.messages[0]?.text ?? '')?.[1] ?? -1);
  const footer = list1.messages.at(-1);
  const nSites = Number(/, (\d+) sites? in this world/.exec(list1.messages[0]?.text ?? '')?.[1] ?? -1);
  check(list1.success && nDesigns + nSites > 8 && list1.messages.length === 10 && /page 1\/\d+/.test(footer.text)
    && footer.links.some((l) => l.text === '[next ›]' && l.click === 'run_command' && l.value === '/architect list 2'),
    `/architect list: the count line, 8 lines and the footer with [next ›] -> /architect list 2 (${nDesigns} designs, ${nSites} sites; ${list1.messages.length} lines; "${footer?.text}")`, texts(list1));
  const list2 = await chat('/architect list 2');
  check(list2.success && links(list2).some((l) => l.text === '[‹ prev]' && l.value === '/architect list 1'), `/architect list 2: [‹ prev] -> /architect list 1 ("${list2.messages.at(-1)?.text}")`, texts(list2));
  const listF = await chat('/architect list cabin');
  check(listF.success && listF.messages.slice(1).every((m) => /cabin/i.test(m.text) || /page|Nothing/.test(m.text)) && listF.messages.length >= 2,
    `/architect list cabin filters (${listF.messages.length - 1} lines)`, texts(listF));
  // a pager link clicked as a player clicks it (vanilla's chat click handler: no confirm screen for an unrestricted command)
  const nextLink = footer.links.find((l) => l.text === '[next ›]');
  const pageClick = await call('dev.ui2b.click', { value: nextLink?.value ?? '/architect list 2' });
  check(!/Confirm/i.test(String(pageClick.screen)), `clicking [next ›] runs ${nextLink?.value} with no confirm screen (screen after: ${pageClick.screen})`, pageClick);
  await call('dev.screen', { open: null });
  const designLink = links(list1).find((l) => l.click === 'suggest_command' && /^\/architect place /.test(l.value));
  check(!!designLink, `a design line is a click that puts its place command in the chat box (${designLink?.value})`);
  const rel = await chat('/architect reload');
  check(rel.success && rel.messages.length === 1 && /^Reloaded \d+ designs?/.test(rel.messages[0].text) && !/\[/.test(rel.messages[0].text.replace('[show]', '')),
    `/architect reload: one count line, no id list ("${rel.messages[0]?.text}")`, texts(rel));
  const relP = await chat('/architect reload problems');
  check(relP.success && relP.messages.length >= 1, `/architect reload problems: "${relP.messages[0]?.text}" (${relP.messages.length} lines)`, texts(relP));
  const bad = await chat('/architect place cabn');
  const badText = bad.messages[0]?.text ?? '';
  const mean = /Did you mean (.*)\?/.exec(badText)?.[1]?.split(', ') ?? [];
  check(bad.result === 0 && /^Unknown design 'cabn'\./.test(badText) && mean.includes('cabin') && mean.length <= 5 && !/known:/.test(badText)
    && /See \/architect list/.test(badText) && links(bad).some((l) => l.value === '/architect place cabin'),
    `unknown design: did-you-mean ${mean.length} (${mean.join(', ')}), each a click, see /architect list ("${badText}")`, bad.messages);
  for (const c of ['/architect batches', '/architect groups', '/architect stockpile list', '/architect build list', '/architect build list 1 x']) {
    const r = await chat(c);
    check(r.success !== undefined && r.messages.length >= 1 && r.messages.length <= 10, `${c}: ${r.messages.length} line(s) ("${r.messages[0]?.text}")`, texts(r));
    out[c] = texts(r);
  }
  out.list = { page1: texts(list1), page2: texts(list2), filter: texts(listF), reload: texts(rel), problems: texts(relP), unknown: bad.messages };

  // ---------------------------------------------------------------- item 3: the placement HUD
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
  const early = await buildState();
  out.checking = early.hud;
  out.shots.push(await shot('hud_checking_s4'));
  const st = await waitVerdict();
  check(st.ready === true && st.hud.some((r) => /^\[rotation .*\] \[entrance .*\] \[■ locked\]/.test(r)) && st.hud.some((r) => /^✔ Ready/.test(r))
    && st.hud.some((r) => /^keys: \? keys/.test(r)) && !st.hud.some((r) => /\((orange|red|grey|pale|tan|amber)\)/.test(r)),
    `HUD ready: the state chips, "✔ Ready", the one "? keys" hint, no colour words (${JSON.stringify(st.hud)})`, st.hud);
  check(early.hud.some((r) => /^~ Checking the site with the server/.test(r)) || early.serverVerdict != null,
    `HUD checking: the progress strip "~ Checking the site with the server…" before the verdict (${JSON.stringify(early.hud)})`);
  out.shots.push(...await atScales('hud_ready'));
  const leg = await call('dev.build.legend', { on: true });
  await sleep(200);
  const legSt = await buildState();
  check(legSt.legend === true && legSt.hud.filter((r) => r.startsWith('keys:')).join(' ').includes('rotate') && legSt.hud.some((r) => /Esc cancel/.test(r)),
    `"?" shows the full key legend (${legSt.hud.filter((r) => r.startsWith('keys:')).join(' | ')})`, leg.hud);
  out.shots.push(...await atScales('hud_legend'));
  await call('dev.build.legend', { on: false });
  // a chest in the box: the server refuses over a block entity, Shift+Enter arms force
  const bx = boxOf(st);
  const chest = [bx.min[0] + 3, bx.min[1] + 2, bx.min[2] + 3];
  await call('dev.build.cancel');
  await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
  await waitVerdict();
  const refused = await call('dev.build.confirm', {}, 60_000);
  await sleep(300);
  const fst = await buildState();
  check(refused.placed === false && fst.forceArmedNow === true && fst.hud.some((r) => /\[! force armed: Shift\+Enter\]/.test(r))
    && fst.hud.some((r) => /^keys: .*Shift\+Enter force/.test(r)),
    `a refusal over a block entity arms force, shown as a chip and a key ("${refused.message}"; ${JSON.stringify(fst.hud)})`, fst.hud);
  out.shots.push(...await atScales('hud_force'));
  await call('dev.build.cancel');
  await cmd(`/setblock ${chest.join(' ')} minecraft:air`);

  // ---------------------------------------------------------------- item 2: Placed, [Undo], [Open in Library]
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
  await waitVerdict();
  const placed = await call('dev.build.confirm', {}, 60_000);
  const siteA = placed.siteId;
  const pst = await buildState();
  const lc = pst.lastChat;
  const undo = lc?.links?.find((l) => l.text === '[Undo]');
  const lib = lc?.links?.find((l) => l.text === '[Open in Library]');
  check(placed.placed === true && undo?.click === 'run_command' && undo.value === `/architect remove ${siteA}` && lib?.value === `/architect library ${siteA}`,
    `"Placed" chat line: [Undo] -> ${undo?.value}, [Open in Library] -> ${lib?.value} ("${lc?.text}")`, lc);
  const toasts = await call('dev.ui2b.toasts');
  out.toasts = toasts;
  const placedToast = JSON.stringify(toasts);
  check(/Undo: \[Undo\] in chat/.test(placedToast) && !/Library > Placed > Remove, or/.test(placedToast), `the Placed toast is short and keeps the undo hint (${String(toasts.last).slice(0, 160)})`, toasts);
  out.shots.push(...await atScales('placed_toast_chat', null, [2]));
  await call('dev.screen', { open: 'chat' });
  await sleep(500);
  out.shots.push(...await atScales('placed_chat_open', null, [2, 4]));
  await call('dev.screen', { open: null });
  // place on top: the same design over site A is refused for the overlap and arms LAYER; the legend shows the grouped detail
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
  await waitVerdict();
  await call('dev.build.confirm', {}, 60_000);
  await sleep(300);
  await call('dev.build.legend', { on: true });
  const lst = await buildState();
  check(lst.layerArmed === true && lst.hud.some((r) => /\[▲ place on top: Enter\]/.test(r)) && lst.hud.some((r) => /^✖ (Would be refused|The server would refuse)/.test(r)),
    `an overlap arms Place on top (a chip), the refusal grouped (${JSON.stringify(lst.hud)})`, lst.hud);
  out.shots.push(...await atScales('hud_ontop_legend'));
  await call('dev.build.legend', { on: false });
  await call('dev.build.cancel');
  // [Open in Library] then [Undo], clicked as a player clicks them (vanilla's chat click handler from the chat screen)
  const opened = await call('dev.ui2b.click', { value: lib?.value ?? `/architect library ${siteA}` });
  await sleep(800);
  const ui = await call('dev.ui.state').catch((e) => ({ error: String(e) }));
  check(!/Confirm/i.test(String(opened.screen)) && ui.tab === 'library' && ui.showPlaced === true && ui.selectedSite === siteA,
    `clicking [Open in Library] opens Library > Placed with ${siteA} selected (tab ${ui.tab}, showPlaced ${ui.showPlaced}, selected ${ui.selectedSite}; screen ${opened.screen})`, ui.error);
  out.shots.push(...await atScales('library_placed', null, [2]));
  await call('dev.screen', { open: null });
  const undone = await call('dev.ui2b.click', { value: undo?.value ?? `/architect remove ${siteA}` });
  await sleep(1500);
  await call('dev.screen', { open: null });
  const sites = await call('dev.sites.state');
  check(!/Confirm/i.test(String(undone.screen)) && !sites.sites.some((s) => s.id === siteA), `clicking [Undo] removes ${siteA} (screen after: ${undone.screen})`, undone);
  const hist = await chat('/architect list site');
  out.listSites = texts(hist);

  for (const id of row) await chat(`/architect remove ${id}`);

  // ---------------------------------------------------------------- item 6: the construction HUD; item 5: the crate's Confirm
  await call('dev.survival.set', { on: true });
  await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
  await waitVerdict();
  const cs = await call('dev.build.confirm', {}, 60_000);
  const siteB = cs.siteId;
  check(cs.placed === true && /^Construction site/.test(cs.message) && (await buildState()).lastChat?.links?.some((l) => l.value === `/architect remove ${siteB}`),
    `a construction site's line also carries [Undo] ("${cs.message}")`);
  // the placement HUD's last status line stays 8 s; the construction HUD keeps to one line while it shows
  for (let i = 0; i < 40 && (await buildState()).hudRect; i++) await sleep(300);
  const whilePlacing = await call('dev.ghosts.state');
  out.siteHudWhilePlacingStatus = whilePlacing.siteHudMode;
  for (const mode of ['full', 'line', 'hidden']) {
    await call('dev.ui2b.siteHud', { mode });
    await sleep(300);
    const g = await call('dev.ghosts.state');
    const mine = g.ghosts.find((x) => x.site === siteB);
    check(g.siteHudMode === mode && !!mine?.hud, `construction HUD ${mode} ("${mode === 'line' ? mine?.hudShort : mine?.hud}")`, { mode: g.siteHudMode });
    out.shots.push(...await atScales(`sitehud_${mode}`));
  }
  await call('dev.ui2b.siteHud', { mode: 'full' });
  await call('dev.crate.open', { site: siteB });
  await sleep(800);
  await call('dev.crate.press', { control: 'deconstruct' });
  await sleep(200);
  const armed = await call('dev.crate.state');
  const dc = armed.controls.find((c) => c.id === 'deconstruct');
  check(armed.confirmDeconstruct === true && /^Press again to deconstruct \(\d\)$/.test(dc?.label ?? '') && armed.confirmSecondsLeft > 0,
    `crate Deconstruct is lab-ui's Confirm: armed "${dc?.label}" (${armed.confirmSecondsLeft} s left), "${armed.flash}"`, armed.controls);
  out.shots.push(...await atScales('crate_confirm'));
  await call('dev.key', { key: 'escape' });
  await sleep(200);
  const esc = await call('dev.crate.state').catch(() => null);
  check(esc && esc.confirmDeconstruct === false, `Esc disarms it and keeps the screen open (${esc?.flash})`);
  await call('dev.crate.press', { control: 'deconstruct' });
  await call('dev.crate.press', { control: 'deconstruct' });
  await sleep(2500);
  const after = await call('dev.sites.state');
  check(!after.sites.some((s) => s.id === siteB), `two presses deconstruct ${siteB} (as gate3's crate path)`);
  await call('dev.screen', { open: null });
  await call('dev.survival.set', { on: false });

  // ---------------------------------------------------------------- item 4: the launcher
  const ls = await call('dev.launcher.state');
  check(ls.state === 'running' && ls.readyToasted === true && /^The design helper is running\.$/.test(ls.summary) && typeof ls.detail === 'string',
    `launcher: plain summary "${ls.summary}", detail kept "${ls.detail}", ready toasted once (${ls.readyToasted})`, ls);
  await call('dev.ui2b.helperPreview', { label: 'Installing the design helper (about 200 MB, first run only)…', npm: 'added 212 packages in 41s' });
  await sleep(300);
  out.shots.push(...await atScales('helper_strip'));
  await call('dev.ui2b.helperPreview', { label: null });
  await call('dev.ui.open', { tab: 'status' });
  await sleep(500);
  out.shots.push(...await atScales('status_tab', null, [2]));
  await call('dev.screen', { open: null });
  await call('dev.gui.scale', { scale: 0 });
  spendZero();
  return out;
};

// ---------------------------------------------------------------- the nightly UI gallery (docs/GATES.md "UI gallery")
// Every Architect screen, HUD state and in-world piece at GUI scale 2 and 4, as stable-named PNGs plus index.json, for the
// morning design-critic review. $0 (sim sidecar), a fixed world (the pinned-seed flat base), fixed camera positions, fixed
// form contents. Non-blocking by design: each state is captured on its own; a failure is listed in index.json "failed", the rest
// carry on. GATEUIG_BUDGET_MIN (default 9): states not started by then are listed under "skipped". GATEUIG_DEST: also copy the
// shots and index.json there (the nightly's artifacts/nightly/<date>/ui).
const GAL_DIR = path.join(OUT, 'ui');
const GAL = { shots: [], failed: [], skipped: [], notes: [] };
let galT0 = 0;
const galBudgetMs = Number(process.env.GATEUIG_BUDGET_MIN ?? 9) * 60_000;
// GATEUIG_ONLY=screen/state,...: capture just those states (plus what they depend on), for re-shooting a few
const ONLY = process.env.GATEUIG_ONLY ? new Set(process.env.GATEUIG_ONLY.split(',').map((x) => x.trim())) : null;
const galOver = () => Date.now() - galT0 > galBudgetMs;
const tryc = (control) => call('dev.ui.click', { control }).then(() => true, () => false);
const errMsg = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300);

async function galCap(kind, screen, state, scale) {
  const r = await call('dev.screenshot', { name: `uig_${screen}_${state}_s${scale}`, hideHud: false, frames: 4, waitChunks: false }, 120_000);
  fs.mkdirSync(GAL_DIR, { recursive: true });
  const file = `${screen}__${state}__s${scale}.png`;
  fs.copyFileSync(r.path, path.join(GAL_DIR, file));
  GAL.shots.push({ kind, screen, state, scale, file, width: r.width, height: r.height });
  log(`  shot ${file} (${r.width}x${r.height})`);
}
/** One state at each scale. `setup(scale)` runs after the scale is set (once, at the first scale, with `once`; a GUI screen re-lays
 * out on a scale change and drops its popups, so screens set up per scale). */
async function sec(kind, screen, state, setup, { scales = [2, 4], once = false, closeScreen = true } = {}) {
  let first = true;
  if (ONLY && !ONLY.has(`${screen}/${state}`)) return;
  for (const s of scales) {
    if (galOver()) { GAL.skipped.push({ kind, screen, state, scale: s, why: 'time budget' }); continue; }
    try {
      if (closeScreen) await call('dev.screen', { open: null });
      await call('dev.gui.scale', { scale: s });
      await sleep(350);
      if (!once || first) await setup(s);
      first = false;
      await sleep(450);
      if (closeScreen === false || kind === 'ui') {
        const ui = await call('dev.ui.state').catch(() => null);
        if (ui?.controls) log(`  ${screen}/${state} s${s} controls: ${ui.controls.map((c) => c.id).join(' ').slice(0, 400)}`);
      }
      await galCap(kind, screen, state, s);
    } catch (e) {
      GAL.failed.push({ kind, screen, state, scale: s, error: errMsg(e) });
      log(`  FAILED ${screen}/${state} s${s}: ${errMsg(e)}`);
    }
  }
}
const openTab = async (tab) => {
  await call('dev.ui.open', { tab });
  await sleep(350);
  await tryc('variant:cancel');
  if (tab === 'library') await call('dev.library.filter', { reset: true }).catch(() => null);
};

steps.gallery = async () => {
  await ensure();
  galT0 = Date.now();
  GAL.shots = []; GAL.failed = []; GAL.skipped = [];
  fs.rmSync(GAL_DIR, { recursive: true, force: true });
  const SEED = '2026100906';
  const CAM = ORIGIN; // every world camera is an offset from the ghost box minimum: the same view each night
  const cam = async (dx, dy, dz, ax = 6, ay = 4, az = 6) => {
    await call('dev.camera', { x: CAM[0] + dx, y: CAM[1] + dy, z: CAM[2] + dz, lookAt: { x: CAM[0] + ax, y: CAM[1] + ay, z: CAM[2] + az }, mode: 'spectator', closePause: true }, 30_000);
    await call('dev.hud', { hidden: false });
    await sleep(1200);
  };
  // the flat base is dirt (to y 63) under one grass layer at y 64 (the ORIGIN row): put a box of it back after blocks were set or sites removed
  const flatten = async (x0, z0, x1, z1) => {
    await cmd(`/fill ${x0} ${ORIGIN[1] + 1} ${z0} ${x1} ${ORIGIN[1] + 8} ${z1} minecraft:air`);
    await cmd(`/fill ${x0} ${ORIGIN[1]} ${z0} ${x1} ${ORIGIN[1]} ${z1} minecraft:grass_block`);
    await cmd(`/fill ${x0} ${ORIGIN[1] - 3} ${z0} ${x1} ${ORIGIN[1] - 1} ${z1} minecraft:dirt`);
  };
  await L.fresh('G6B UIG', FLAT);
  await L.setRules('exact');
  await cmd('/time set 6000');
  await cmd('/weather clear');
  await L.tp(9.5, 72, 0.5, 0, 25);
  await cmd('/gamemode creative');
  await call('dev.ui2b.siteHud', { mode: 'full' });
  spendZero();

  // library identity, so a changed grid is explained (the run's library can differ night to night)
  const lib0 = await call('dev.library.state').catch(() => ({}));
  const cards0 = lib0.cards ?? lib0.visible ?? [];
  const ids0 = cards0.map((c) => c.id ?? c).sort();
  GAL.library = { count: ids0.length, ids: ids0.slice(0, 80) };
  const pick = ids0.includes('cabin') ? 'cabin' : ids0[0];
  const designs0 = (await call('dev.sidecar.state').catch(() => ({}))).designs?.length ?? null;

  // ================================================================ Library
  await sec('ui', 'library', 'grid', async () => openTab('library'));
  await sec('ui', 'library', 'filter_type', async () => { await openTab('library'); await call('dev.ui.click', { control: 'filter:type' }); });
  {
    // the Tag pop-up is enabled only when the library has user tags; without any, say so instead of failing
    await openTab('library');
    const ui = await call('dev.ui.state').catch(() => ({ controls: [] }));
    if (ui.controls?.some((c) => c.id === 'filter:tag' && c.enabled !== false && c.state !== 'disabled')) await sec('ui', 'library', 'filter_tag', async () => { await openTab('library'); await call('dev.ui.click', { control: 'filter:tag' }); });
    else GAL.skipped.push({ kind: 'ui', screen: 'library', state: 'filter_tag', scale: null, why: 'no user tags in this library: the Tag pop-up is disabled' });
  }
  await sec('ui', 'library', 'filter_collection', async () => { await openTab('library'); await call('dev.ui.click', { control: 'filter:collection' }); });
  await sec('ui', 'library', 'sort', async () => { await openTab('library'); if (!(await tryc('sort'))) GAL.notes.push('library/sort: sort chips are not folded at this scale; the chips are in the grid shot'); });
  await sec('ui', 'library', 'starred_empty', async () => { await openTab('library'); await call('dev.library.filter', { favorites: true }); });
  await sec('ui', 'library', 'search', async () => { await openTab('library'); await call('dev.library.filter', { text: 'tower' }); });
  await sec('ui', 'library', 'detail', async () => { await openTab('library'); await call('dev.library.select', { entry: pick }); });
  await sec('ui', 'library', 'detail_rename', async () => { await openTab('library'); await call('dev.library.select', { entry: pick }); await call('dev.ui.click', { control: 'rename' }); });
  await sec('ui', 'library', 'detail_tags', async () => { await openTab('library'); await call('dev.library.select', { entry: pick }); await call('dev.ui.click', { control: 'tags' }); });
  await sec('ui', 'library', 'variants_form', async () => { await openTab('library'); await call('dev.library.select', { entry: pick }); await call('dev.library.variants.open', { entry: pick }); });
  for (const f of ['wood', 'stone', 'roof', 'accent']) {
    await sec('ui', 'library', `variants_palette_${f}`, async () => {
      await openTab('library'); await call('dev.library.select', { entry: pick }); await call('dev.library.variants.open', { entry: pick });
      await call('dev.ui.click', { control: `palette:${f}` });
    });
  }
  await sec('ui', 'library', 'variants_changed', async () => {
    await openTab('library'); await call('dev.library.select', { entry: pick }); await call('dev.library.variants.open', { entry: pick });
    const vs = await call('dev.library.state').catch(() => ({}));
    const presets = vs.variants?.presets ?? vs.variantForm?.presets ?? [];
    const p = typeof presets[1] === 'string' ? presets[1] : presets[1]?.name ?? presets[1]?.id;
    if (p) await call('dev.library.variants.set', { preset: p }); else await call('dev.library.variants.set', { steps: {} });
  });
  await tryc('variant:cancel');
  await sec('ui', 'library', 'import_dialog', async () => { await openTab('library'); await call('dev.library.import.list'); });
  await tryc('import:cancel');

  // ================================================================ Design tab
  const FORM = { reset: true, buildingType: 'cabin', style: 'rustic', materials: 'oak and stone', size: 'M', name: 'Gallery Cabin', notes: 'a small cabin by the road' };
  await sec('ui', 'design', 'default', async () => { await openTab('design'); await call('dev.design.fill', { reset: true }); });
  await sec('ui', 'design', 'filled', async () => { await openTab('design'); await call('dev.design.fill', FORM); });
  await sec('ui', 'design', 'size_custom', async () => { await openTab('design'); await call('dev.design.fill', { ...FORM, size: 'custom', custom: [11, 7, 9] }); });
  await sec('ui', 'design', 'size_large_options', async () => { await openTab('design'); await call('dev.design.fill', { ...FORM, size: 'L' }); });
  await sec('ui', 'design', 'type_other', async () => { await openTab('design'); await call('dev.design.fill', { ...FORM, openType: 'windmill' }); await tryc('type:other'); });
  await sec('ui', 'design', 'profile_popup', async () => { await openTab('design'); await call('dev.design.fill', { ...FORM, openType: 'windmill' }); await tryc('type:other'); await call('dev.ui.click', { control: 'design:profile' }); });
  await sec('ui', 'design', 'bible_popup', async () => { await openTab('design'); await call('dev.design.fill', FORM); await call('dev.ui.click', { control: 'design:bible' }); });
  await sec('ui', 'design', 'remix', async () => { await openTab('library'); await call('dev.library.remix', { entry: pick }); });
  await sec('ui', 'design', 'set_dialog', async () => { await openTab('design'); await call('dev.set.open'); });
  await sec('ui', 'design', 'set_dialog_filled', async () => {
    await openTab('design'); await call('dev.set.open');
    await call('dev.set.fill', { name: 'Gallery hamlet', prompt: 'a quiet hamlet by a river', items: [{ type: 'tower', name: 'Watchtower', role: 'landmark' }, { type: 'cabin', name: 'Ferry cabin' }, { type: 'gatehouse', name: 'Ford gate' }], concurrency: 2 });
    await sleep(1200);
  });
  await call('dev.set.close').catch(() => null);

  // ================================================================ Designs tab (a sim design: $0)
  await sec('ui', 'designs', 'before', async () => openTab('designs'));
  let madeEntry = null;
  if (!ONLY) try {
    await openTab('design');
    await call('dev.design.fill', FORM);
    const sent = await call('dev.design.submit', {}, 30_000);
    const id = sent.sent?.designId;
    const end = Date.now() + 90_000;
    let d;
    while (Date.now() < end) {
      d = (await call('dev.sidecar.state')).designs?.find((x) => x.id === id);
      if (d && ['done', 'failed', 'error'].includes(d.status)) break;
      await sleep(1000);
    }
    madeEntry = d?.blueprintId ?? null;
    GAL.notes.push(`designs: sim design ${id} ended ${d?.status}`);
    await sec('ui', 'designs', 'detail', async () => { await openTab('designs'); if (id) await call('dev.ui.click', { control: `design:${id}` }); });
  } catch (e) { GAL.failed.push({ kind: 'ui', screen: 'designs', state: 'detail', scale: null, error: errMsg(e) }); }
  if (madeEntry) await call('dev.library.delete', { entry: madeEntry }).catch(() => null);
  GAL.library.designsBefore = designs0;

  // ================================================================ Status tab
  await sec('ui', 'status', 'tab', async () => openTab('status'));
  await sec('ui', 'status', 'helper_strip', async () => {
    await call('dev.ui2b.helperPreview', { label: 'Installing the design helper (about 200 MB, first run only)…', npm: 'added 212 packages in 41s' });
    await openTab('status');
  });
  await call('dev.ui2b.helperPreview', { label: null }).catch(() => null);

  // ================================================================ placement HUD and the placement ghost's colour categories
  await call('dev.screen', { open: null });
  const start = async (o = ORIGIN) => { await call('dev.build.cancel').catch(() => null); await call('dev.build.start', { blueprint: 'cabin', origin: o, ground: true, turns: 0 }); };
  const chestAt = async (on) => {
    const st0 = await buildState();
    const b = boxOf(st0);
    await cmd(`/setblock ${b.min[0] + 3} ${b.min[1] + 2} ${b.min[2] + 3} minecraft:${on ? 'chest' : 'air'}`);
    return b;
  };
  await sec('world', 'ghost', 'checking', async () => { await start(); }, { scales: [4], closeScreen: false });
  await sec('world', 'ghost', 'normal', async () => { await start(); await cam(6, 16, 34); await waitVerdict(); }, { once: true, closeScreen: false });
  await sec('ui', 'placement_hud', 'legend', async () => { await call('dev.build.legend', { on: true }); await sleep(200); }, { closeScreen: false });
  await call('dev.build.legend', { on: false }).catch(() => null);
  // replaced: the ghost over blocks that will be replaced (a stone slab laid in its box)
  await sec('world', 'ghost', 'replaced', async () => {
    // real blocks inside the footprint, above the ground row (the cabin's walls and interior replace them): the HUD must read "N blocks replaced"
    await start(); await waitVerdict();
    const b = boxOf(await buildState());
    await cmd(`/fill ${b.min[0] + 2} ${b.min[1] + 1} ${b.min[2] + 2} ${b.max[0] - 2} ${b.min[1] + 4} ${b.max[2] - 2} minecraft:stone`);
    await start(); await cam(6, 16, 34); const st = await waitVerdict(); await sleep(500);
    const hud = (await buildState()).hud ?? st?.hud ?? [];
    if (!hud.some((r) => /\d+ blocks? replaced/.test(r))) throw new Error(`replaced not reached: HUD ${JSON.stringify(hud)}`);
    GAL.notes.push(`ghost/replaced HUD: ${hud.filter((r) => /replaced/.test(r)).join(' | ')}`);
  }, { once: true, closeScreen: false });
  await call('dev.build.cancel').catch(() => null);
  await flatten(ORIGIN[0] - 4, ORIGIN[2] - 4, ORIGIN[0] + 18, ORIGIN[2] + 16);
  // a block entity in the way (a chest): the refusal and the force chip
  await sec('world', 'ghost', 'block_entity', async () => {
    await start(); await waitVerdict(); await chestAt(true);
    await start(); await waitVerdict();
    await call('dev.build.confirm', {}, 60_000).catch(() => null);
    await sleep(300); await cam(6, 16, 34);
  }, { once: true, closeScreen: false });
  await sec('ui', 'placement_hud', 'force_armed', async () => { await call('dev.hud', { hidden: false }); }, { closeScreen: false });
  await chestAt(false).catch(() => null);
  // refused: below the world's floor, where no placement can stand
  await sec('world', 'ghost', 'refused', async () => {
    await call('dev.build.cancel').catch(() => null);
    await call('dev.build.start', { blueprint: 'cabin', origin: [ORIGIN[0], -70, ORIGIN[2]], ground: false, turns: 0 });
    await waitVerdict(); await cam(6, 16, 34, 6, 4, 6);
  }, { once: true, closeScreen: false });
  await call('dev.build.cancel').catch(() => null);

  // ================================================================ toasts, the paged chat list, Library > Placed
  const row = [];
  const place = async (o, scale) => {
    await call('dev.build.start', { blueprint: 'cabin', origin: o, ground: true, turns: 0 });
    await waitVerdict();
    const r = await call('dev.build.confirm', {}, 60_000);
    if (r.placed) row.push(r.siteId);
    return r;
  };
  await sec('ui', 'toast', 'placed', async (s) => { await place([ORIGIN[0], 64, ORIGIN[2]], s); await call('dev.screen', { open: null }); }, { closeScreen: false });
  await call('dev.ui2b.toasts').then((t) => { GAL.toasts = t; }, () => null);
  // place on top: the same design over the site just placed (refused for the overlap; Place on top armed)
  await sec('world', 'ghost', 'place_on_top', async () => {
    await start(); await waitVerdict();
    // the first Enter over the placed site is refused for the overlap and arms Place on top (the chip)
    await call('dev.build.confirm', {}, 60_000).catch(() => null);
    await sleep(400);
    const st = await buildState();
    if (!(st.layerArmed === true && (st.hud ?? []).some((r) => /place on top/.test(r)))) throw new Error(`place-on-top not armed: ${JSON.stringify(st.hud)}`);
    await cam(6, 16, 34);
  }, { once: true, closeScreen: false });
  await call('dev.build.cancel').catch(() => null);
  // the first site is needed above; a row of 6 more makes the list longer than one page
  for (let i = 1; i < 7 && !ONLY && !galOver(); i++) {
    await call('dev.build.cancel').catch(() => null);
    await place([40 + i * 16, 64, 40]).catch(() => null);
  }
  await call('dev.build.cancel').catch(() => null);
  // a clicked link runs the command as a player: its output lands in the real chat (dev.command's does not)
  const listChat = async (page) => { await call('dev.ui2b.click', { value: `/architect list${page > 1 ? ` ${page}` : ''}` }); await call('dev.screen', { open: 'chat' }); await sleep(500); };
  await sec('ui', 'chat', 'list_page1', () => listChat(1), { closeScreen: false });
  await sec('ui', 'chat', 'list_page2', () => listChat(2), { closeScreen: false });
  await call('dev.screen', { open: null });
  await sec('ui', 'library', 'placed', async () => {
    await openTab('library'); await call('dev.ui.click', { control: 'library:placed' });
    if (row[0]) await call('dev.ui.click', { control: `site:${row[0]}` }).catch(() => null);
  });
  for (const id of row) await chat(`/architect remove ${id}`).catch(() => null);
  await sleep(2000);

  // ================================================================ plot markers and the region ghost (world)
  await call('dev.screen', { open: null });
  await L.tp(9.5, 72, 0.5, 0, 25); await cmd('/gamemode creative');
  // the removed sites leave their dug footprints (a trench that reads like the plot marker): level and re-grass the ground first
  for (const r of [[-6, -6, 24, 26], [30, 30, 110, 70]]) await flatten(...r);
  // the plot box: corners A and B on the surface (y 63), height 16; the camera is centred on the box, south of it (its front), high enough to take both corners
  const PA = [20, 64, 10]; const PB = [38, 64, 24]; const PH = 16;
  const plotCam = async () => {
    const cx = (PA[0] + PB[0]) / 2 + 0.5; const cz = (PA[2] + PB[2]) / 2 + 0.5;
    await call('dev.camera', { x: cx, y: 80, z: PB[2] + 24, lookAt: { x: cx, y: PA[1] + 4, z: cz }, mode: 'spectator', closePause: true }, 30_000);
    await call('dev.hud', { hidden: false }); await sleep(1500);
  };
  // first corner confirmed, the second pinned as the hover: the translucent rectangle with its size and height limit, as the mod draws it while marking
  await sec('world', 'plot', 'marking', async () => {
    await openTab('design'); await call('dev.design.fill', FORM);
    await call('dev.plot.start', { height: PH });
    await call('dev.plot.corner', { x: PA[0], y: PA[1], z: PA[2], confirm: true });
    await call('dev.plot.corner', { x: PB[0], y: PB[1], z: PB[2], front: 'south', confirm: false }); // confirm defaults to true: false pins the hover only
    await plotCam();
    const ps = await call('dev.plot.state').catch(() => ({}));
    GAL.notes.push(`plot/marking state: ${JSON.stringify(ps).slice(0, 200)}`);
  }, { once: true, closeScreen: false });
  // the second corner confirmed: the Design tab gets the size; the plot as it stays in the world
  await sec('world', 'plot', 'marked', async () => {
    await call('dev.plot.corner', { x: PB[0], y: PB[1], z: PB[2], front: 'south', confirm: true });
    await call('dev.screen', { open: null });
    await plotCam();
    const ps = await call('dev.plot.state').catch(() => ({}));
    GAL.notes.push(`plot/marked state: ${JSON.stringify(ps).slice(0, 200)}`);
  }, { once: true, closeScreen: false });
  await sec('ui', 'plot', 'marked_form', async () => { await openTab('design'); }, { closeScreen: true });
  await call('dev.plot.cancel', {}).catch(() => null);
  await call('dev.design.fill', { reset: true }).catch(() => null);
  if (!ONLY) try {
    const claim = [-60, -60, 59, 59];
    const p = await L.plan('crater_works', claim, { surveyLoad: 'bounded:256' });
    await call('dev.region.ghost', { planId: p.planId }, 120_000);
    await sleep(6000);
    const rc = async () => call('dev.camera', { x: -40, y: 90, z: 20, yaw: 180, pitch: 35, mode: 'spectator', closePause: true }, 30_000).then(() => sleep(2500));
    await sec('world', 'region_ghost', 'plan', rc, { once: true, closeScreen: false });
    await call('dev.region.ghost', { off: true }, 30_000);
  } catch (e) { GAL.failed.push({ kind: 'world', screen: 'region_ghost', state: 'plan', scale: null, error: errMsg(e) }); }
  await call('dev.release', {}).catch(() => null);

  // ================================================================ the survival crate in the world, SiteHud, CrateScreen
  let siteB = null;
  if (!ONLY) try {
    await L.tp(9.5, 72, 0.5, 0, 25); await cmd('/gamemode creative');
    await call('dev.survival.set', { on: true });
    await call('dev.build.start', { blueprint: 'cabin', origin: ORIGIN, ground: true, turns: 0 });
    await waitVerdict();
    siteB = (await call('dev.build.confirm', {}, 60_000)).siteId;
    for (let i = 0; i < 40 && (await buildState()).hudRect; i++) await sleep(300);
  } catch (e) { GAL.failed.push({ kind: 'world', screen: 'sitehud', state: 'setup', scale: null, error: errMsg(e) }); }
  if (siteB) {
    for (const mode of ['full', 'line', 'hidden']) {
      await sec('world', 'sitehud', mode, async () => { await call('dev.ui2b.siteHud', { mode }); await cam(6, 12, 30); }, { closeScreen: false });
    }
    await call('dev.ui2b.siteHud', { mode: 'full' });
    await sec('ui', 'crate', 'screen', async () => { await call('dev.crate.open', { site: siteB }); await sleep(600); });
    await sec('ui', 'crate', 'confirm_armed', async () => {
      await call('dev.crate.open', { site: siteB }); await sleep(600);
      await call('dev.crate.press', { control: 'deconstruct' }); await sleep(200);
    });
    await call('dev.screen', { open: null });
    await call('dev.site.deconstruct', { site: siteB, force: true }).catch(() => null);
  }
  await call('dev.survival.set', { on: false }).catch(() => null);
  await call('dev.release', {}).catch(() => null);
  await call('dev.gui.scale', { scale: 0 }).catch(() => null);

  const index = {
    schema: 1, date: new Date().toISOString().slice(0, 10), head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(),
    world: { name: 'G6B UIG', base: FLAT, seed: SEED, time: 6000, weather: 'clear', camera: 'offsets from the ghost box minimum', sidecar: 'sim ($0)' },
    scales: [2, 4], seconds: Math.round((Date.now() - galT0) / 1000), budgetMin: galBudgetMs / 60_000,
    counts: { shots: GAL.shots.length, failed: GAL.failed.length, skipped: GAL.skipped.length },
    library: GAL.library, notes: GAL.notes,
    shots: GAL.shots, failed: GAL.failed, skipped: GAL.skipped,
  };
  fs.mkdirSync(GAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(GAL_DIR, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  if (process.env.GATEUIG_DEST) {
    const dest = path.resolve(process.env.GATEUIG_DEST);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(GAL_DIR)) fs.copyFileSync(path.join(GAL_DIR, f), path.join(dest, f));
    log(`copied ${fs.readdirSync(GAL_DIR).length} files to ${dest}`);
  }
  // non-blocking: failures are in index.json; only "nothing captured" fails the step
  check(GAL.shots.length > 0, `UI gallery: ${GAL.shots.length} shots, ${GAL.failed.length} failed, ${GAL.skipped.length} skipped, ${index.seconds} s`, index.counts);
  spendZero();
  return index.counts;
};

steps.report = async () => {
  const rows = fs.readdirSync(OUT).filter((f) => /^(ingame)\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
  const md = ['# UI-2b gate', '', ...rows.flatMap((r) => [`## ${r.step} (${r.seconds.toFixed(0)} s, head ${r.head.slice(0, 8)})`, '',
    ...Object.entries(r.results).map(([m, x]) => `- ${x.ok ? 'ok' : 'FAIL'} ${m}`), '', ...(r.data?.shots ?? []).map((s) => `- shot ${s.name}: ${s.path}`), ''])];
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${md.join('\n')}\n`);
};

const name = process.argv[2];
if (!steps[name]) { console.error(`usage: node tools/gateui2b.mjs ${Object.keys(steps).join('|')}`); process.exit(2); }
const t0 = Date.now();
let data, error;
log(`== ${name}`);
try { data = await steps[name](); } catch (e) { error = String(e?.stack ?? e); log(error); check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`); }
if (!['start', 'stop', 'report'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
const nFail = Object.values(results).filter((x) => !x.ok).length;
log(nFail ? `${nFail} FAILURE(S)` : `ALL ${Object.keys(results).length} PASS`);
process.exit(nFail ? 1 : 0);
