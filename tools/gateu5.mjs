#!/usr/bin/env node
// Style unification U5 in-game step (DEV MODE: the slice's own step), on a CLIENT (the editor, the Style browser, the Style editor
// and Add parts are client screens; the sim sidecar, no Claude: $0):
//   1. Medieval's new wall: white_concrete (white_terracotta rendered salmon), wall_alt still calcite; its own parts (since the
//      built-in parts, 2026-10-24: the kit ships kit/bibles/medieval/components.mjs);
//   2. a built-in on the Design tab: "Use this style's parts" is offered and ON by default (Noah, 2026-10-24: set mode with the
//      Style's own parts, {bible: medieval, bibleVersion}, no palette); switched off it is the hybrid: materials only (palette, no
//      bible); the
//      sidecar's BRIEF.md carries the Style's look as guidance ("lean toward steep gables…") and no set-mode text; no bible/ folder;
//   3. "Add parts…" through the sim ($0): the Style browser says "Parts: 5" for medieval, the + New style menu opens Add parts
//      (Redraft) with the helper's estimate first, Draft parts runs a sim bible job that puts the parts on a hand-made copy of the
//      built-in (basedOn medieval, its roles, tags and hints); the built-in itself stays the kit's; the copy says "Parts: 5";
//      the Style editor of a hand-made Style shows "No parts · Add parts…" and its button adds parts as v2 (v1 byte-unchanged);
//      a mod's Style is refused through the API (Bibles.addParts) unless the caller is its owner;
//   4. "Use this style's parts": offered only for a Style with its own parts, off by default for the copy; on, the request is set mode
//      ({bible, bibleVersion}, no palette) and the design's brief has the components; off again, the palette;
//   5. Medieval's wall in built cells: the parts job's test frame (the kit's buildFrame, the house the component check builds) in the
//      copy's roles is built of white_concrete, no white_terracotta; the copy's sheet.png was rendered by the job.
//
//   node tools/gateu5.mjs start [world] | stop | ingame      (gate-chains.json step u5-ingame)
//
// Evidence: <GATE6B_OUT>/u5-ingame.json, the shots in <out>/shots (and GATEU5_SHOTS when set), spend.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-U5-run');
process.env.GATE6B_OUT ??= process.env.GATEU5_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate-u5');
process.env.GATE6B_SIDECAR_PORT ??= '8900';
process.env.GATE6B_DEV_PORT ??= '8901';
const L = await import('./lib/run6b.mjs');
const { OUT, call, check, connect, log, results, root, state, startClient, stopClient, cmd } = L;
L.refuseKeys();
const GAME = process.env.ARCHITECT_GAME_DIR ? path.resolve(process.env.ARCHITECT_GAME_DIR) : L.GAME_DIR;
const LIB = path.join(GAME, 'architect', 'library');
const BIBLES = path.join(GAME, 'architect', 'bibles');
const DATA = path.join(GAME, 'architect', 'sidecar-data');
const SHOTS = path.join(OUT, 'shots');
const EXTRA = process.env.GATEU5_SHOTS ? path.resolve(process.env.GATEU5_SHOTS) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function tree(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = sha(f); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const brief = (designId) => {
  const f = path.join(DATA, 'designs', designId, 'BRIEF.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const SET_MODE = [/Follow it over your own taste/, /Use the components/, /bible\/components\.mjs/];
const shots = [];

async function shotOne(name) {
  const r = await call('dev.screenshot', { name: `u5_${name}`, hideHud: false, frames: 4, waitChunks: false }, 120_000);
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
/** A sim bible job to its end (dev.sidecar.state's bibleJobs). */
async function bibleJobDone(jobId) {
  return until(`bible job ${jobId}`, async () => {
    const j = ((await call('dev.sidecar.state')).bibleJobs ?? []).find((x) => (x.id ?? x.jobId) === jobId);
    return j && ['done', 'failed', 'cancelled', 'DONE', 'FAILED', 'CANCELLED'].includes(j.status) ? j : null;
  }, 300_000);
}
const FOLDS = {
  'architect_mc.editor.what': false, 'architect_mc.editor.style': true, 'architect_mc.editor.materials': true, 'architect_mc.editor.more_roles': false,
  'architect_mc.editor.features': false, 'architect_mc.editor.rules': false, 'architect_mc.editor.parameters': false,
};
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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice U5 is $0: sim sidecar, no Claude call' }, null, 2)}\n`);
  await cmd('/gamemode creative').catch(() => null);
  await cmd('/time set 6000').catch(() => null);
  await call('dev.u3.sections', { set: FOLDS });
  await call('dev.u3.park', { on: true });
  await call('dev.gui.scale', { scale: 2 });
  const tag = Date.now().toString(36).slice(-4);

  // ---- 1. Medieval's new wall
  const med = await call('dev.style.get', { style: 'medieval' });
  data.medieval = med;
  check(med.roles?.wall === 'minecraft:white_concrete' && med.roles?.wall_alt === 'minecraft:calcite' && med.roles.wall !== med.roles.wall_alt,
    '1: medieval\'s wall is white_concrete (off white_terracotta), wall_alt calcite', { wall: med.roles?.wall, wall_alt: med.roles?.wall_alt });
  check(Array.isArray(med.parts) && med.parts.length === 5 && med.builtin === true, '1: the built-in medieval has its own parts (the kit ships them)', med.parts);
  const rustic = await call('dev.style.get', { style: 'rustic' });
  check(rustic.parts?.length === 5, '1: rustic has its own parts (the kit ships them)', rustic.parts);

  // ---- 2. the hybrid default
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'medieval', size: 'M', name: `U5 Hybrid ${tag}`, massingFirst: false });
  let f = await form();
  check(f.partsOffered === true && f.useParts === true && f.request?.bible === 'medieval' && !f.request?.palette,
    '2: medieval on the Design tab: the parts toggle offered and ON (set mode with its own parts, no palette)', { partsOffered: f.partsOffered, useParts: f.useParts, bible: f.request?.bible });
  await shotOne('editor_builtin_parts_on');
  await call('dev.design.fill', { parts: false });
  f = await form();
  check(f.partsOffered === true && f.useParts === false && !f.request?.bible && f.request?.palette?.bible?.roles?.wall === 'minecraft:white_concrete',
    '2: switched off: materials only (palette, new wall), no bible (the hybrid)', { partsOffered: f.partsOffered, useParts: f.useParts, bible: f.request?.bible });
  await shotOne('editor_hybrid');
  const s1 = await call('dev.design.submit', {}, 30_000);
  const d1 = s1.sent?.designId ? await designDone(s1.sent.designId) : { status: 'NONE' };
  check(d1.status === 'DONE' && !!d1.entryId, '2: the hybrid design is done', { status: d1.status, error: d1.error });
  const b1 = d1.designId ? brief(d1.designId) : '';
  data.hybridBrief = b1.split('\n').filter((l) => /Style's look|lean toward|in short:/.test(l));
  check(/## The Style's look: Medieval \(guidance\)/.test(b1) && /lean toward steep gables, jettied upper floors/.test(b1) && /Dark oak timber framing/.test(b1),
    '2: the brief carries the Style\'s look as guidance (the blurb, roof language, proportions)', data.hybridBrief);
  check(SET_MODE.every((re) => !re.test(b1)) && !/\*\*Restraint\*\*/.test(b1), '2: no set-mode text in the brief (no components, no "follow it", no restraint)');
  if (d1.entryId) check(!fs.existsSync(path.join(LIB, d1.entryId, 'bible')), '2: the entry has no bible/ folder');

  // ---- 3. Add parts…
  await call('dev.u3.browser.open', { for: 'design' });
  await call('dev.u3.browser', { select: 'medieval' });
  let b = await call('dev.u3.state');
  check(b.details?.includes('Parts: 5'), '3: the browser: medieval has its own parts ("Parts: 5")', b.details);
  await shotOne('browser_builtin_parts');
  await call('dev.u3.browser', { menu: 'new' });
  await shotOne('browser_menu_parts');
  await call('dev.u3.browser', { item: 'parts' });
  let ap = await call('dev.u3.state');
  check(ap.screen === 'add_parts' && ap.style === 'medieval' && /\$/.test(ap.cost) && /copy/.test(ap.outcome) && !ap.refusal,
    `3: Add parts shows the estimate first ("${ap.cost}") and that a built-in's parts go on a copy`, ap);
  data.estimateLine = ap.cost;
  const est = await call('dev.style.parts', { estimate: true });
  data.estimate = est;
  check(est.usdHigh > 0 && /Add parts: at most a bible job/.test(est.basis ?? ''), `3: Bibles.estimateParts: $${est.usdLow}-${est.usdHigh} (${est.basis})`);
  await shotOne('add_parts');
  const jobsBefore = new Set(((await call('dev.sidecar.state')).bibleJobs ?? []).map((j) => j.id ?? j.jobId));
  await u3('draft');
  await until('back in the browser', async () => ((await call('dev.u3.state')).screen === 'style_browser' ? true : null), 30_000);
  const job = await until('the parts job', async () => ((await call('dev.sidecar.state')).bibleJobs ?? []).find((j) => !jobsBefore.has(j.id ?? j.jobId)), 30_000);
  const jd = await bibleJobDone(job.id ?? job.jobId);
  const copyId = jd.bibleId;
  data.copy = { job: jd.id ?? jd.jobId, bibleId: copyId, status: jd.status };
  check(/done/i.test(jd.status) && /^bib_medieval_parts/.test(copyId ?? ''), `3: Draft parts runs a sim bible job (${copyId}), done`, { status: jd.status, error: jd.error });
  const cdir = path.join(BIBLES, copyId ?? 'none', 'versions', '1');
  const cj = readJson(path.join(cdir, 'bible.json'));
  check(cj?.origin === 'hand' && cj?.basedOn?.id === 'medieval' && cj?.parts?.length === 5 && cj?.partsOf?.id === 'medieval' && cj?.roles?.wall === 'minecraft:white_concrete'
    && cj?.roofLanguage === 'steep gables, jettied upper floors' && JSON.stringify(cj?.tags) === JSON.stringify(med.tags),
    '3: the copy keeps medieval\'s roles, hints and tags, based on it, with 5 parts', cj ? { origin: cj.origin, basedOn: cj.basedOn, parts: cj.parts } : cdir);
  check(fs.existsSync(path.join(cdir, 'components.mjs')) && fs.existsSync(path.join(cdir, 'sheet.png')), '3: the copy has its components.mjs and the job\'s sheet.png');
  check(!fs.existsSync(path.join(BIBLES, 'medieval')) && ((await call('dev.style.get', { style: 'medieval' })).parts ?? []).length === 5, '3: the built-in medieval stays the kit\'s (its kit parts, no installed version)');
  await call('dev.u3.browser.open', { for: 'design' });
  await until('the copy in the browser', async () => ((await call('dev.u3.browser', { select: copyId }).catch(() => null))?.selected === copyId ? true : null), 30_000);
  b = await call('dev.u3.state');
  check(b.details?.includes('Parts: 5'), '3: the browser: the copy has "Parts: 5"', b.details);
  await shotOne('browser_parts');
  // a hand-made Style: the editor's Add parts… -> v2, v1 unchanged
  const hand = await call('dev.style.save', { style: { name: `U5 Hand ${tag}`, roles: med.roles, basedOn: { id: 'medieval', version: 1 }, roofLanguage: 'tall gables' } });
  check(!!hand.styleId && hand.parts?.length === 0, `3: a hand-made Style (${hand.styleId}) has no parts`, hand);
  const v1 = tree(path.join(BIBLES, hand.styleId, 'versions', '1'));
  await call('dev.u3.browser.open', { for: 'design' });
  await until('the hand Style in the browser', async () => ((await call('dev.u3.browser', { select: hand.styleId }).catch(() => null))?.selected === hand.styleId ? true : null), 30_000);
  await u3('edit');
  let e = await call('dev.u3.state');
  check(e.screen === 'style_editor' && e.parts === 0 && /No parts · Add parts/.test(e.partsLine) && e.controls?.some((c) => c.id === 'parts' && c.enabled),
    '3: the Style editor says "No parts · Add parts…" with its button', { partsLine: e.partsLine });
  await shotOne('style_editor_no_parts');
  await u3('parts');
  ap = await call('dev.u3.state');
  check(ap.screen === 'add_parts' && ap.style === hand.styleId && /v2, with parts/.test(ap.outcome), '3: Add parts… from the editor: the next version', ap.outcome);
  const before2 = new Set(((await call('dev.sidecar.state')).bibleJobs ?? []).map((j) => j.id ?? j.jobId));
  await u3('draft');
  const job2 = await until('the second parts job', async () => ((await call('dev.sidecar.state')).bibleJobs ?? []).find((j) => !before2.has(j.id ?? j.jobId)), 30_000);
  const jd2 = await bibleJobDone(job2.id ?? job2.jobId);
  const h2 = await call('dev.style.get', { style: hand.styleId });
  check(/done/i.test(jd2.status) && h2.version === 2 && h2.parts?.length === 5 && h2.origin === 'hand' && h2.roles?.wall === 'minecraft:white_concrete',
    `3: ${hand.styleId} v2 has parts, the same roles, still hand-made`, { version: h2.version, parts: h2.parts });
  check(JSON.stringify(tree(path.join(BIBLES, hand.styleId, 'versions', '1'))) === JSON.stringify(v1), '3: v1\'s folder is byte-unchanged');
  await call('dev.u3.back').catch(() => null);
  // a mod's Style: only its owner
  const town = await call('dev.style.save', { owner: 'steward_mc:settlement/u5', style: { name: `U5 Town ${tag}`, roles: med.roles } });
  const r1 = await call('dev.style.parts', { style: town.styleId });
  check(/belongs to steward_mc:settlement\/u5/.test(r1.refused ?? ''), '3: Bibles.addParts on a mod\'s Style without its owner is refused', r1);
  const r2 = await call('dev.style.parts', { style: town.styleId, owner: 'steward_mc:settlement/u5' });
  check(!!r2.jobId && r2.bibleId === town.styleId && r2.version === 2, '3: its owner adds parts (the next version)', r2);
  if (r2.jobId) await bibleJobDone(r2.jobId);

  // ---- 4. "Use this style's parts"
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', bible: copyId, size: 'M', name: `U5 Parts ${tag}`, massingFirst: false });
  f = await form();
  check(f.partsOffered === true && f.useParts === false && !f.request?.bible && !!f.request?.palette, '4: the copy with parts: the toggle offered, off by default (the hybrid)', { partsOffered: f.partsOffered, useParts: f.useParts });
  await shotOne('editor_parts_off');
  await ui('style:parts');
  f = await form();
  check(f.useParts === true && f.request?.bible === copyId && f.request?.bibleVersion === 1 && !f.request?.palette, '4: on: set mode with the Style\'s parts ({bible, bibleVersion}, no palette)', { bible: f.request?.bible, v: f.request?.bibleVersion });
  await shotOne('editor_parts_on');
  const s2 = await call('dev.design.submit', {}, 30_000);
  const d2 = s2.sent?.designId ? await designDone(s2.sent.designId) : { status: 'NONE' };
  check(d2.status === 'DONE' && d2.request?.bible === copyId, '4: the set-mode design is done', { status: d2.status, error: d2.error });
  const b2 = d2.designId ? brief(d2.designId) : '';
  check(SET_MODE.every((re) => re.test(b2)), '4: its brief has the components and "follow it" (set mode)');
  if (d2.entryId) check(fs.existsSync(path.join(LIB, d2.entryId, 'bible', 'components.mjs')), '4: the entry keeps the copy\'s components');
  await call('dev.design.fill', { parts: false });
  f = await form();
  check(f.useParts === false && !f.request?.bible && f.request?.palette?.bible?.id === copyId, '4: off again: the palette (materials only)');
  // (every built-in has parts now) a hand-made Style without parts
  const plainStyle = await call('dev.style.save', { style: { name: `U5 Plain ${tag}`, roles: med.roles } });
  await call('dev.design.fill', { bible: plainStyle.styleId });
  f = await form();
  check(f.partsOffered === false, '4: a Style without parts: no toggle', { style: plainStyle.styleId, partsOffered: f.partsOffered });

  // ---- 5. Medieval's wall in built cells: the parts job's test frame in the copy's roles
  const kitUrl = (rel) => pathToFileURL(path.join(L.RUN, 'kit', rel)).href;
  const { palette } = await import(kitUrl('lib/kit.mjs'));
  const { buildFrame } = await import(kitUrl('lib/components.mjs'));
  const frame = buildFrame(palette({ bible: cj ?? { roles: med.roles } }));
  const mats = JSON.stringify(frame.materials());
  data.frameMaterials = frame.materials();
  check(/white_concrete/.test(mats) && !/white_terracotta/.test(mats), '5: the test frame (the component check\'s house) is built of white_concrete, no white_terracotta', data.frameMaterials);

  data.shots = shots.map((s) => path.relative(OUT, s));
  return data;
};

async function run(name) {
  const t0 = Date.now();
  let data, error;
  log(`== u5 ${name}`);
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
  L.write?.(`u5-${name}.json`, { step: `u5-${name}`, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}

const name = process.argv[2];
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!steps[name]) {
    console.error(`usage: node tools/gateu5.mjs <${Object.keys(steps).join(' | ')}>`);
    process.exit(2);
  }
  await run(name);
  const fails = L.fails();
  log(fails ? `${fails} FAILURE(S)` : 'all checks passed');
  if (state.dev) await state.dev.close?.();
  process.exit(fails ? 1 : 0);
}
