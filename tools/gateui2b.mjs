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
