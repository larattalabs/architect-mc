#!/usr/bin/env node
// Style unification U3 in-game step (DEV MODE: the slice's own step), on a CLIENT (the editor, the Style browser and the Style editor are
// client screens; the sim sidecar, no Claude: $0). It opens each screen, drives the main flows through the screens' controls (dev.ui.click,
// dev.u3.*) and shoots every state at GUI scale 2 and 4:
//   1. the unified editor, NEW: a Style picked (medieval), words alongside it (sent in the notes, the palette kept), own words alone (no
//      palette: U2), the sections folded and open;
//   2. the Style browser: cards, the detail pane, a single click selects (Duplicate / Edit act on it), Use this style picks it;
//   3. a custom mix: the Wood row's picker (full screen, swatches by family) -> birch, More roles, a role picker -> soul lantern; the mix bar;
//      Save as style… with a name -> a hand-made Style the editor then picks;
//   4. the Style editor: Edit of the saved Style (Save v2: a new version on disk), Duplicate of a built-in (Edit refused for it), the
//      test-house check refusing a light that gives no light, Save style (a new Style based on the built-in); "+ New style" menu and
//      Describe a style (its cost line; the sim drafts a bible job, $0);
//   5. Generate with the Style: the design is done and built of its materials; the jobs strip shows it while it runs;
//   6. the Library: Place / Edit / ⋯; Edit opens the editor in VARIANT mode (What, Features, Rules locked; Remix…) and a Style re-skins
//      it; the ⋯ menu's Delete arms first (Press again to delete) and deletes on the second press; Place starts the placement;
//   7. massing approval by mouse: a Massing first design's massing is approved with the jobs strip's Approve button.
//
//   node tools/gateu3.mjs start [world] | stop | ingame      (gate-chains.json step u3-ingame)
//
// Evidence: <GATE6B_OUT>/u3-ingame.json, the shots in <out>/shots (and GATEU3_SHOTS when set), spend.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-U3-run');
process.env.GATE6B_OUT ??= process.env.GATEU3_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-u3');
process.env.GATE6B_SIDECAR_PORT ??= '8902';
process.env.GATE6B_DEV_PORT ??= '8903';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, log, results, root, state, startClient, stopClient, cmd } = L;
L.refuseKeys();
const GAME = process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : L.GAME_DIR;
const LIB = path.join(GAME, 'architect', 'library');
const BIBLES = path.join(GAME, 'architect', 'bibles');
const SHOTS = path.join(OUT, 'shots');
const EXTRA = process.env.GATEU3_SHOTS ? path.resolve(process.env.GATEU3_SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entryJson = (id) => JSON.parse(fs.readFileSync(path.join(LIB, id, `${id}.blueprint.json`), 'utf8'));
const materials = (j) => JSON.stringify(j.materials ?? {});
const shots = [];

async function shotOne(name) {
  const r = await call('dev.screenshot', { name: `u3_${name}`, hideHud: false, frames: 4, waitChunks: false }, 120_000);
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
    await sleep(150);
    await shotOne(`${name}_s${s}`);
  }
}
const ui = (control) => call('dev.ui.click', { control });
const u3 = (control) => call('dev.u3.click', { control });
async function until(what, fn, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(800);
  }
  throw new Error(`timed out: ${what}`);
}
async function designDone(designId, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  let s;
  while (Date.now() < end) {
    s = await call('dev.style.designState', { designId });
    if (['DONE', 'FAILED', 'CANCELLED'].includes(s.status)) return s;
    await sleep(1500);
  }
  return { ...s, status: 'TIMEOUT' };
}
/** The editor's folds, set so every run's shots are the same. */
const FOLDS = {
  'architect_mc.editor.what': true, 'architect_mc.editor.style': true, 'architect_mc.editor.materials': true, 'architect_mc.editor.more_roles': false,
  'architect_mc.editor.features': false, 'architect_mc.editor.rules': false, 'architect_mc.editor.parameters': false,
  'architect_mc.variant.what': false, 'architect_mc.variant.style': true, 'architect_mc.variant.materials': true, 'architect_mc.variant.more_roles': false,
  'architect_mc.variant.features': false, 'architect_mc.variant.rules': false, 'architect_mc.variant.parameters': true,
  'architect_mc.style_editor.roles': false, 'architect_mc.style_editor.settlement': false, 'architect_mc.style_editor.slots': false,
};
const folds = (set) => call('dev.u3.sections', { set });
const form = async () => (await call('dev.design.state')).form;

const steps = {};
steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  await startClient(process.argv[3] ?? 'API Sim', { backend: 'sim' });
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};

steps.ingame = async () => {
  const data = {};
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice U3 is $0: sim sidecar, no Claude call' }, null, 2)}\n`);
  await cmd('/gamemode creative').catch(() => null);
  await cmd('/time set 6000').catch(() => null);
  await folds(FOLDS);
  await call('dev.u3.park', { on: true });
  const tag = Date.now().toString(36).slice(-4);

  // ---- 1. the editor, NEW
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'M', name: `U3 Cabin ${tag}`, massingFirst: false });
  let f = await form();
  check(f.styleForm?.style?.id === 'medieval' && f.partsOffered === true && f.useParts === true && f.request?.bible === 'medieval' && !f.request?.palette,
    '1: the editor picks medieval: "Use this style\'s parts" is on by default (set mode with its own parts)', { useParts: f.useParts, bible: f.request?.bible });
  // the rest of this section is about the Style's materials, so the parts go off
  await call('dev.design.fill', { parts: false });
  f = await form();
  check(f.styleForm?.style?.id === 'medieval' && !!f.request?.palette?.bible && f.request.style === 'medieval', '1: parts off: medieval\'s palette and style sent', f.request?.palette?.bible?.id);
  await shot('editor_new');
  await call('dev.design.fill', { styleNote: 'mossy, lived-in', notes: 'two rooms' });
  f = await form();
  check(f.request?.palette?.bible?.id === 'medieval' && f.request.style === 'medieval' && f.request.notes === 'Style: mossy, lived-in\n\ntwo rooms',
    '1: words alongside the Style go first in the notes; the style and palette stay the Style', { style: f.request?.style, notes: f.request?.notes });
  await shot('editor_note');
  await call('dev.design.fill', { style: 'a hobbit hole under a hill' });
  f = await form();
  check(!f.request?.palette && f.request?.style === 'a hobbit hole under a hill' && f.ownWords === true && f.request.notes === 'two rooms',
    '1: own words alone: the words are the style, no palette, no note (U2)', { style: f.request?.style, palette: f.request?.palette ?? null, notes: f.request?.notes });
  await shot('editor_own_words');
  await ui('style:medieval');
  f = await form();
  check(f.ownWords === false && f.request?.palette?.bible?.id === 'medieval', '1: the medieval chip picks the Style again (the same Style: the parts stay as the player left them, off)', f.styleChip);
  await folds({ 'architect_mc.editor.features': true, 'architect_mc.editor.rules': true, 'architect_mc.editor.parameters': true, 'architect_mc.editor.what': false });
  await shot('editor_sections_open');
  await folds(FOLDS);

  // ---- 2. the Style browser
  await ui('style:browse');
  let b = await call('dev.u3.state');
  check(b.screen === 'style_browser' && b.cards?.length >= 16 && b.cards.some((c) => c.rail === 'Built-in'), `2: the Style browser lists ${b.cards?.length} Styles on their rails`, b.debug);
  await shot('browser', async () => { if ((await call('dev.u3.state')).screen !== 'style_browser') await ui('style:browse'); });
  await call('dev.u3.browser', { select: 'nordic' });
  b = await call('dev.u3.state');
  check(b.selected === 'nordic' && b.canEdit === false && b.details?.some((d) => /^Built-in/.test(d)), '2: nordic selected: built-in, Edit refused (duplicate only)', b.details);
  await shot('browser_detail');
  const ed = await u3('edit');
  check(ed.clicked === false && ed.screen === 'style_browser', '2: Edit does nothing for a built-in Style');
  await call('dev.u3.browser', { menu: 'new' });
  await shot('browser_new_menu');
  await call('dev.u3.browser', { menu: null });
  await call('dev.u3.browser', { select: 'nordic', use: true });
  f = await form();
  check(f.styleForm?.style?.id === 'nordic' && (await call('dev.u3.state')).screen === 'architect', '2: Use this style picks nordic and goes back to the editor', f.styleForm?.style);

  // ---- 3. a custom mix, More roles, Save as style…
  await ui('style:medieval');
  await ui('palette:wood');
  let p = await call('dev.u3.state');
  check(p.screen === 'picker' && p.picker === 'architect_mc.material.wood' && p.entries >= 13, `3: the Wood row's picker (${p.entries} woods)`, p.debug);
  await shot('picker_wood', async () => { if ((await call('dev.u3.state')).screen !== 'picker') await ui('palette:wood'); });
  await call('dev.u3.picker', { pick: 'birch' });
  f = await form();
  const pv = f.styleForm?.provenance ?? {};
  check(f.styleForm?.mix === true && f.styleForm.main?.wood === 'birch' && pv.frame === 'follows_wood' && pv.wall === 'style',
    '3: Wood -> birch: a custom mix; the frame follows Wood, the wall stays the Style\'s', { main: f.styleForm?.main, pv });
  await shot('editor_mix');
  await folds({ 'architect_mc.editor.more_roles': true, 'architect_mc.editor.what': false });
  await ui('role:light');
  p = await call('dev.u3.state');
  check(p.screen === 'picker' && p.picker === 'architect_mc.role', '3: a role\'s picker (every block by family)', p.debug);
  await call('dev.u3.picker', { query: 'lantern' });
  await shot('picker_role', async () => { if ((await call('dev.u3.state')).screen !== 'picker') await ui('role:light'); await call('dev.u3.picker', { query: 'lantern' }); });
  await call('dev.u3.picker', { pick: 'minecraft:soul_lantern' });
  f = await form();
  check(f.styleForm?.roles?.light === 'minecraft:soul_lantern' && f.styleForm.provenance?.light === 'hand', '3: More roles: the light set by hand', f.styleForm?.roles?.light);
  await shot('editor_more_roles');
  await ui('style:save');
  await shot('editor_save_name', async () => { const st = await call('dev.u3.state'); if (!st.sections?.saveAsOpen) await ui('style:save'); });
  const saveName = `U3 Birch ${tag}`;
  await call('dev.u3.saveAs', { mode: 'design', name: saveName });
  f = await until('the saved Style picked', async () => { const x = await form(); return x.styleForm?.style?.kind === 'bible' && x.styleForm.style.name === saveName ? x : null; }, 60_000);
  const saved = f.styleForm.style.id;
  data.saved = saved;
  const bj = path.join(BIBLES, saved, 'versions', '1', 'bible.json');
  const b1 = fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : null;
  check(b1?.origin === 'hand' && b1?.basedOn?.id === 'medieval' && b1.roles?.light === 'minecraft:soul_lantern' && f.styleForm.mix === false,
    `3: Save as style… -> ${saved} v1 (hand, basedOn medieval, the mix's roles); the editor picks it`, b1 ? { origin: b1.origin, basedOn: b1.basedOn } : bj);
  await folds(FOLDS);
  await shot('editor_saved_style');

  // ---- 4. the Style editor
  await call('dev.u3.browser.open', { for: 'design' });
  await call('dev.u3.browser', { select: saved });
  b = await call('dev.u3.state');
  check(b.canEdit === true && b.details?.some((d) => /^Yours/.test(d)) && b.details.some((d) => /Based on/.test(d)), '4: the saved Style is Yours and editable', b.details);
  await shot('browser_yours', async () => { if ((await call('dev.u3.state')).screen !== 'style_browser') { await call('dev.u3.browser.open', { for: 'design' }); } await call('dev.u3.browser', { select: saved }); });
  await u3('edit');
  let e = await call('dev.u3.state');
  check(e.screen === 'style_editor' && e.mode === 'edit' && e.saveLabel === 'Save v2', '4: Edit opens the Style editor: Save v2', { mode: e.mode, label: e.saveLabel });
  e = await call('dev.u3.editor.fill', { main: { stone: 'deepslate_bricks' }, addTags: 'cold, mossy', features: ['garden'] });
  e = await until('the test-house check', async () => { const x = await call('dev.u3.state'); return x.checkCurrent ? x : null; }, 60_000);
  check(e.check?.ok === true && e.saveEnabled === true, '4: the test house passes; Save is on', e.check);
  await shot('style_editor_edit');
  await u3('save');
  const b2 = await until('v2 on disk', async () => fs.existsSync(path.join(BIBLES, saved, 'versions', '2', 'bible.json')) ? JSON.parse(fs.readFileSync(path.join(BIBLES, saved, 'versions', '2', 'bible.json'), 'utf8')) : null, 60_000);
  check(b2.roles?.foundation === 'minecraft:deepslate_bricks' && b2.tags?.includes('mossy') && b2.suggestedFeatures?.includes('garden') && fs.existsSync(bj),
    '4: Save v2 writes a new version (v1 kept)', { foundation: b2.roles?.foundation, tags: b2.tags });
  b = await call('dev.u3.state');
  check(b.screen === 'style_browser' && b.selected === saved, '4: back in the browser, the saved Style selected', b.selected);
  // duplicate a built-in; the check refuses a light that gives no light
  await call('dev.u3.browser', { select: 'japanese' });
  await u3('duplicate');
  e = await call('dev.u3.state');
  check(e.screen === 'style_editor' && e.mode === 'new' && e.saveLabel === 'Save style' && e.request?.bible?.basedOn?.id === 'japanese', '4: Duplicate of a built-in: a new Style based on it', e.request?.bible?.basedOn);
  await call('dev.u3.editor.fill', { name: `U3 Japanese ${tag}`, roles: { light: 'minecraft:oak_planks' } });
  e = await until('the failing check', async () => { const x = await call('dev.u3.state'); return x.checkCurrent ? x : null; }, 60_000);
  check(e.check?.ok === false && e.saveEnabled === false, '4: a light that gives no light: the test house fails and Save is refused', e.check?.errors);
  await shot('style_editor_check_fail');
  await call('dev.u3.editor.fill', { roles: { light: 'minecraft:lantern' } });
  e = await until('the passing check', async () => { const x = await call('dev.u3.state'); return x.checkCurrent && x.check?.ok ? x : null; }, 60_000);
  await shot('style_editor_new');
  await u3('save');
  b = await until('back in the browser', async () => { const x = await call('dev.u3.state'); return x.screen === 'style_browser' && x.selected !== 'japanese' ? x : null; }, 60_000);
  const copy = b.selected;
  const cj = path.join(BIBLES, copy, 'versions', '1', 'bible.json');
  const c1 = fs.existsSync(cj) ? JSON.parse(fs.readFileSync(cj, 'utf8')) : null;
  check(c1?.basedOn?.id === 'japanese' && c1.origin === 'hand', `4: Save style -> ${copy} (based on japanese)`, c1?.basedOn);
  // + New style -> Describe it
  await call('dev.u3.browser', { menu: 'new' });
  await call('dev.u3.browser', { item: 'describe' });
  let dsc = await call('dev.u3.describe.fill', { name: `U3 Harbour ${tag}`, prompt: 'weathered harbour stone, teal shutters' });
  check(dsc.screen === 'describe_style' && /\$/.test(dsc.cost), `4: Describe a style shows the cost line ("${dsc.cost}")`);
  await shot('describe_style', async () => { const x = await call('dev.u3.state'); if (x.screen !== 'describe_style') { await call('dev.u3.browser', { menu: 'new' }); await call('dev.u3.browser', { item: 'describe' }); await call('dev.u3.describe.fill', { name: `U3 Harbour ${tag}`, prompt: 'weathered harbour stone, teal shutters' }); } });
  await u3('draft');
  dsc = await until('the bible job', async () => { const x = await call('dev.u3.state'); return x.screen === 'style_browser' ? x : null; }, 30_000);
  const jobs = (await call('dev.sidecar.state')).bibleJobs ?? [];
  check(jobs.length > 0, `4: Draft it starts a bible job (sim, $0): ${jobs.map((j) => j.id ?? j.jobId).slice(-1)}`);
  await call('dev.u3.back');

  // ---- 5. Generate with the Style; the jobs strip while it runs
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'M', name: `U3 Gen ${tag}`, massingFirst: false, styleOps: [['main', 'wood', 'birch']] });
  const s1 = await call('dev.design.submit', {}, 30_000);
  const d1id = s1.sent?.designId;
  check(!!d1id && !s1.sent.error, `5: Generate -> ${d1id}`, s1.sent);
  await call('dev.ui.open', { tab: 'library' });
  await shot('library_job_strip');
  const d1 = d1id ? await designDone(d1id) : { status: 'NONE' };
  check(d1.status === 'DONE' && !!d1.entryId, '5: the design is done', { status: d1.status, error: d1.error });
  if (d1.entryId) {
    const m = materials(entryJson(d1.entryId));
    check(/birch_log/.test(m) && /stone_bricks/.test(m), '5: built of the mix (birch frame on medieval\'s stone bricks)', entryJson(d1.entryId).materials);
  }

  // ---- 6. the Library: Place / Edit / ⋯
  const entry = d1.entryId;
  if (entry) {
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.select', { entry });
    let st = await call('dev.ui.state');
    const ids = new Set((st.controls ?? []).filter((c) => (c.w ?? 1) > 0).map((c) => c.id));
    check(ids.has('place') && ids.has('edit') && ids.has('more') && !(st.controls ?? []).some((c) => c.id === 'delete' && (c.w ?? 0) > 0),
      '6: the detail shows Place, Edit and ⋯; Delete is not beside Place', [...ids].filter((i) => /^(place|edit|more|delete|variants|remix)$/.test(i)));
    await shot('library_detail', async () => { await call('dev.ui.open', { tab: 'library' }); await call('dev.library.select', { entry }); });
    const openMenu = async () => { if (!(await call('dev.ui.state')).libraryMenu) await ui('more'); };
    await openMenu();
    await shot('library_menu', openMenu);
    await ui('delete');
    await shot('library_delete_armed', async () => { await openMenu(); if (!(await call('dev.ui.state')).deleteArmed) await ui('delete'); });
    st = await call('dev.ui.state');
    check(fs.existsSync(path.join(LIB, entry)) && st.deleteArmed === true && st.libraryMenu === true, '6: the first Delete press only arms it (the design is still there, the menu open)', { armed: st.deleteArmed, menu: st.libraryMenu });
    await call('dev.screen', { open: null });
    await call('dev.ui.open', { tab: 'library' });
    st = await call('dev.ui.state');
    check(st.deleteArmed === false || st.deleteArmed === undefined || !st.libraryMenu, '6: closing the screen cancels the armed Delete', { armed: st.deleteArmed });
    // Edit: the variant editor
    await call('dev.screen', { open: null }).catch(() => null);
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.select', { entry });
    await ui('edit');
    st = await call('dev.library.state');
    check(!!st.variants || !!st.variantForm, '6: Edit opens the editor in VARIANT mode', Object.keys(st));
    await shot('editor_variant', async () => { await call('dev.ui.open', { tab: 'library' }); });
    await call('dev.u3.browser.open', { for: 'variant' });
    await call('dev.u3.browser', { select: saved, use: true });
    st = await call('dev.library.state');
    const vr = st.variants?.request ?? st.variantForm?.request;
    check(vr?.bible === saved || vr?.palette?.bible?.id === saved, '6: a Style picked in the browser re-skins the variant', vr);
    await shot('editor_variant_restyled', async () => { await call('dev.ui.open', { tab: 'library' }); });
    const sub = await call('dev.library.variants.submit', {}, 30_000);
    const w = sub.jobId ? await call('dev.library.wait', { jobId: sub.jobId, timeoutMs: 180_000 }, 200_000) : {};
    check(w.status === 'done' && !!w.blueprintId, `6: Make variant -> ${w.blueprintId}`, w);
    if (w.blueprintId) {
      const m = materials(entryJson(w.blueprintId));
      check(/deepslate_bricks/.test(m), '6: the variant wears the saved Style v2 (deepslate bricks)', entryJson(w.blueprintId).materials);
    }
    // Place: the placement starts
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.select', { entry });
    await ui('place');
    const bs = await call('dev.build.state').catch(() => ({}));
    check(bs.active === true || !!bs.blueprint, '6: Place starts the placement', { active: bs.active, blueprint: bs.blueprint });
    await call('dev.build.cancel').catch(() => null);
    // Delete with the confirm: two presses
    await call('dev.ui.open', { tab: 'library' });
    await call('dev.library.select', { entry: w.blueprintId ?? entry });
    await ui('more');
    await ui('delete');
    const target = w.blueprintId ?? entry;
    check(fs.existsSync(path.join(LIB, target)) && (await call('dev.ui.state')).deleteArmed === true, '6: one press: armed, still there');
    await ui('delete');
    await until('the design deleted', async () => !fs.existsSync(path.join(LIB, target)), 30_000);
    check(!fs.existsSync(path.join(LIB, target)), `6: the second press deletes it (${target} moved to the trash)`);
  }

  // ---- 7. massing approval by mouse
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'L', name: `U3 Massed ${tag}`, massingFirst: true });
  const sm = await call('dev.design.submit', {}, 30_000);
  const mid = sm.sent?.designId;
  if (mid) {
    const ms = await designDone(mid);
    check(ms.status === 'DONE', '7: the massing is done', ms.status);
    await until('the massing review', async () => (await call('dev.massing.state')).review);
    await call('dev.ui.open', { tab: 'library' });
    await shot('library_massing_approve', async () => { await call('dev.ui.open', { tab: 'library' }); });
    const before = new Set((await call('dev.sidecar.state')).designs.map((d) => d.id));
    await ui('jobs:approve');
    const det = await until('the detail design', async () => (await call('dev.sidecar.state')).designs.find((d) => !before.has(d.id)) ?? null, 60_000);
    check(!!det, `7: the jobs strip's Approve starts the detail pass (${det?.id})`);
  } else {
    check(false, '7: Massing first was not sent', sm.sent);
  }

  // ---- empty states have actions
  await call('dev.ui.open', { tab: 'library' });
  await call('dev.library.filter', { text: 'zzzz no such design' });
  await sleep(400);
  let st = await call('dev.ui.state');
  check((st.controls ?? []).some((c) => c.id === 'library:empty_action'), '8: an empty Library search offers Clear filters');
  await shot('library_empty', async () => { await call('dev.ui.open', { tab: 'library' }); await call('dev.library.filter', { text: 'zzzz no such design' }); });
  await ui('library:empty_action');
  await call('dev.screen', { open: null });
  data.shots = shots.map((s) => path.basename(s));
  return data;
};

async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== u3 ${name}`);
  try {
    if (!state.dev && name !== 'start' && name !== 'stop') await connect();
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (name === 'ingame') {
    await call('dev.gui.scale', { scale: 2 }).catch(() => null);
    await call('dev.u3.park', { on: false }).catch(() => null);
  }
  L.write?.(`u3-${name}.json`, { step: `u3-${name}`, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

const name = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gateu3.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const fails = L.fails();
  log(fails ? `${fails} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(fails ? 1 : 0);
}
