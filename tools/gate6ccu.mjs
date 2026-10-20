#!/usr/bin/env node
// Phase 6c slice CU gate (docs/CONTRACT.md "Phase 6c slice CU: copper weathering and undo" §8) against the headless server of the CU run
// worktree (GATE6B_RUN, default `../architect-mc-CU-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0: no
// Claude call anywhere.
//
//   node tools/gate6ccu.mjs <step>
//     start [world] | stop | base      the headless server (or client) and the flat base world
//     unit      (cu-unit)              item 2 (CopperTest: the canonical form over vanilla's maps against kit/lib/blocks.mjs's wx; still ours
//                                      for copper and farmland; the builder's and the refund's block test), item 9's journal and survival
//                                      units, the API feature; item 10's api-compat
//     measure   (cu-measure)           item 1 (recorded, never judged): cu_demo realised on a flat world, its unwaxed copper ticked until each
//                                      cell weathered, Regions.remove, the cells that stood listed by class and block (cu-measure.json); run
//                                      before the fix and after it
//     ingame    (cu-ingame)            items 3-7 on a flat world (exact rules): 3 cu_demo's copper through every stage, half waxed, a
//                                      quarter scraped, removed: E-flat 0, kept 0; 4 a copper site's weathered, waxed and scraped chests and
//                                      statues: no removal blocker, the box back exactly; 5 the field corner's other drift kinds (recorded);
//                                      6 a player's own oxidized copper in one of our cells: kept 1, its record kept
//     survival  (cu-survival)          items 7 and 8 on the Y1 survival base, a stockpile: (a) weathering while the build waits: nothing
//                                      re-queued or charged twice; (c, and 7) a version delta over weathered cells: no PLAYER_EDITS, the
//                                      removed cells refunded at the standing block; (b) the deconstruct after weathering, waxing and
//                                      scraping: every copper cell a REFUND of the standing block's items to the stockpile, 0 copper dropped
//     report                            REPORT.md over the step JSONs
//
// Evidence: artifacts/gate6c-cu/<step>.json in the main checkout (GATE6CCU_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-CU-run');
process.env.GATE6B_OUT = process.env.GATE6CCU_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate6c-cu');
process.env.GATE6B_SIDECAR_PORT ??= '8960';
process.env.GATE6B_DEV_PORT ??= '8961';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, startClient, stopClient, call, cmd, settle, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
/** Two item maps equal per item (zero counts ignored). */
const same = (a, b) => { for (const x of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) if ((a?.[x] ?? 0) !== (b?.[x] ?? 0)) return false; return true; };
/** a - b per item, zero counts dropped. */
const minus = (a, b) => { const o = {}; for (const x of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) { const d = (a?.[x] ?? 0) - (b?.[x] ?? 0); if (d) o[x] = d; } return o; };

const OWNER = 'test:cu';
const FLAT = 'G6B Flat Base';
const SURV = 'G6B Y Survival';
/** cu_demo's claim on the flat world (96 x 96). */
const CLAIM = [9200, 9200, 9295, 9295];

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (!['stop', 'start'].includes(name)) L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice CU is $0: sim and stub only, no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ the apitest mod (public API only)

const api = async (args) => {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
  return JSON.parse(line);
};
const result = async (pending, timeoutMs = 180_000) => {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r && r.value !== undefined && r.value !== null) return r.value;
    await sleep(500);
  }
  throw new Error(`no result for ${key}`);
};
const later = async (args, t) => result(await api(args), t);

// ------------------------------------------------------------------ cells and copper

/** The copper chain's ids (kit/lib/blocks.mjs's wx: the 15 forms x 4 stages, and their waxed twins). */
let CHAIN = null;
async function chain() {
  if (CHAIN) return CHAIN;
  const B = await imp('lib/blocks.mjs');
  const all = B.BLOCKS ?? B.default ?? B.blocks;
  const ids = new Set();
  const rows = all instanceof Map ? [...all.entries()] : Object.entries(all);
  for (const [id, v] of rows) if (v?.wx) { ids.add(id.replace(/^minecraft:/, '')); if (v.wx.waxed) ids.add(v.wx.waxed.replace(/^minecraft:/, '')); if (v.wx.next) ids.add(v.wx.next.replace(/^minecraft:/, '')); }
  CHAIN = ids;
  return ids;
}
/** A dev.box.hash cell line's state as "minecraft:x[k=v,...]" (the NBT of 26.3: {id:"minecraft:x",properties:{k:"v"}}). */
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return `${bs[1]}${bs[2] ?? ''}`;
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return props.length ? `${n}[${props.join(',')}]` : n;
}
/** Every cell of a box: Map "x,y,z" -> state. */
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
/** A dev.region.hash diff value (BlockStateParser's "minecraft:x[k=v]" then the block entity's NBT) as its state. */
const hashState = (v) => String(v ?? '').replace(/\{.*$/s, '');
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
const propOf = (s, k) => new RegExp(`[\\[,]${k}=([a-z0-9_]+)`).exec(String(s))?.[1];
/** The copper cells of a cell map (a door's upper half left out: its lower half drives it), sorted by position. */
async function copperCells(cells) {
  const C = await chain();
  const out = [];
  for (const [k, s] of cells) if (C.has(idOf(s)) && !(/_door$/.test(idOf(s)) && propOf(s, 'half') === 'upper')) out.push({ at: k.split(',').map(Number), state: s });
  out.sort((a, b) => a.at[0] - b.at[0] || a.at[2] - b.at[2] || a.at[1] - b.at[1]);
  return out;
}
const oxidized = (s) => /^(waxed_)?oxidized_/.test(idOf(s));
const waxed = (s) => /^waxed_/.test(idOf(s));

/**
 * Ticks every unwaxed copper cell (vanilla's randomTick, dev.vocab.tick, 50 per call) until each has reached its last stage, at most
 * `rounds` rounds; a cell random ticks left short is moved on one stage at a time with dev.copper.use weather (counted: `forced`).
 * Returns {ticked, forced, cells}.
 */
async function weatherAll(cells, { rounds = 12 } = {}) {
  const at = cells.filter((c) => !waxed(c.state)).map((c) => c.at);
  const now = new Map(at.map((a) => [a.join(','), null]));
  for (let r = 0; r < rounds; r++) {
    const left = at.filter((a) => !oxidized(now.get(a.join(',')) ?? ''));
    if (!left.length) break;
    for (let i = 0; i < left.length; i += 64) {
      const t = await call('dev.vocab.tick', { cells: left.slice(i, i + 64), n: 50 }, 120_000);
      for (const c of t.cells ?? []) now.set(c.at.join(','), c.after.replace(/^Block\{([^}]+)\}/, '$1'));
    }
  }
  let forced = 0;
  for (let k = 0; k < 3; k++) {
    const left = at.filter((a) => !oxidized(now.get(a.join(',')) ?? ''));
    if (!left.length) break;
    const u = await call('dev.copper.use', { cells: left, item: 'weather' }, 120_000);
    for (const c of u.cells ?? []) { if (c.changed) forced++; now.set(c.at.join(','), c.after.replace(/^Block\{([^}]+)\}/, '$1')); }
  }
  const ticked = at.length - at.filter((a) => !oxidized(now.get(a.join(',')) ?? '')).length;
  return { cells: at.length, oxidized: ticked, forced };
}
/** Waxes every other copper cell (honeycomb) and scrapes every fourth from the second (axe): what each did, per cell. */
async function waxAndScrape(cells) {
  const wax = cells.filter((c, i) => i % 2 === 0).map((c) => c.at);
  const scrape = cells.filter((c, i) => i % 4 === 1).map((c) => c.at);
  const w = await call('dev.copper.use', { cells: wax, item: 'honeycomb' }, 120_000);
  const s = await call('dev.copper.use', { cells: scrape, item: 'axe' }, 120_000);
  const st = (x) => x.replace(/^Block\{([^}]+)\}/, '$1');
  return { waxed: (w.cells ?? []).filter((c) => c.changed).map((c) => ({ at: c.at, from: st(c.before), to: st(c.after) })), scraped: (s.cells ?? []).filter((c) => c.changed).map((c) => ({ at: c.at, from: st(c.before), to: st(c.after) })) };
}

// ------------------------------------------------------------------ regions

async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
}
/** Plans and realises cu_demo; returns {region, planId, ir, box (the snapshot box), gy}. */
async function realiseDemo(params = {}) {
  const p = await L.plan('cu_demo', CLAIM, { params, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  let lo = Infinity, hi = -Infinity;
  for (const part of ir.parts) for (const o of part.ops) if (o.op === 'columns') for (let i = 0; i < o.cols.length; i += 5) { lo = Math.min(lo, o.cols[i + 2]); hi = Math.max(hi, o.cols[i + 3]); }
  const cx = (CLAIM[0] + CLAIM[2] + 1) >> 1, cz = (CLAIM[1] + CLAIM[3] + 1) >> 1;
  const box = [cx - 24, lo - 3, cz - 12, cx + 24, hi + 4, cz + 14];
  await cmd('/kill @e[type=!minecraft:player]');
  const snapF = path.join(OUT, `cu-${p.planId}.snap.gz`);
  await call('dev.region.hash', { box, mode: 'snap', file: snapF }, 3_600_000);
  const region = await L.realise(p.planId);
  const st = await L.waitRegion(region, 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED') await cmd('/kill @e[type=!minecraft:player]'); });
  return { region, planId: p.planId, ir, box, snapF, state: st.view.state, cellsWritten: st.view.cellsWritten };
}
async function removeRegion(region) {
  const r = await call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 1200; i++) {
    const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED' || s === 'PARTIAL' || s === 'FAILED') break;
    await sleep(500);
  }
  await settle(2000);
  return r;
}
const diffOf = async (box, file) => call('dev.region.hash', { box, mode: 'diff', file }, 3_600_000);
const asBox = (b) => [b[0], b[1], b[2], b[3], b[4], b[5]];

// ------------------------------------------------------------------ client and worlds

steps.start = async () => {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();
  execFileSync('git', ['-C', L.RUN, 'checkout', '-q', '--detach', head]);
  execFileSync('npm', ['run', 'build'], { cwd: path.join(L.RUN, 'sidecar'), stdio: 'ignore' });
  await startClient(process.argv[3] ?? 'G6B CU Lobby', { backend: 'sim' });
  spendZero();
  return { head };
};
steps.stop = async () => {
  try { await connect(10_000); } catch { /* by PID below */ }
  await stopClient();
};
steps.base = async () => {
  await ensure();
  await L.ensureBase(FLAT);
  spendZero();
  return { worlds: [FLAT] };
};

// ------------------------------------------------------------------ offline: items 2, 9, 10

/** Java tests by class pattern (the source checkout's gradle, under the cross-process lock). */
async function javaTests(patterns, minTests) {
  const { srcGradle } = await import('./lib/src-gradle.mjs');
  const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', GRADLE_USER_HOME: path.join(root, '.gradle-home') };
  const args = ['test', '--offline', '-q', ...patterns.flatMap((p) => ['--tests', p])];
  const g = srcGradle(root, () => spawnSync('./gradlew', args, { cwd: path.join(root, 'mod'), env, encoding: 'utf8', timeout: 1_800_000 }));
  const dir = path.join(root, 'mod', 'build', 'test-results', 'test');
  let tests = 0, failures = 0;
  const names = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.xml') || !patterns.some((p) => f.includes(p.replaceAll('*', '')))) continue;
    const x = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /tests="(\d+)" skipped="\d+" failures="(\d+)" errors="(\d+)"/.exec(x);
    if (m) { tests += +m[1]; failures += +m[2] + +m[3]; names.push(`${f.replace(/^TEST-|\.xml$/g, '')}: ${m[1]}/${+m[2] + +m[3]}`); }
  }
  return { code: g.status, tests, failures, names, tail: `${g.stdout ?? ''}${g.stderr ?? ''}`.split('\n').slice(-12), ok: g.status === 0 && tests >= minTests && failures === 0 };
}

steps.unit = async () => {
  const out = {};
  out.copper = await javaTests(['*CopperTest*'], 8);
  check(out.copper.ok, `item 2 (CopperTest): the canonical form over vanilla's maps equal to kit/lib/blocks.mjs's wx (60 rows, 120 blocks), every stage, waxed and scraped state holds against the written one, another form never does, facing and half still compare, the copper chest's empty-container rule, farmland and dirt; WorldJournal.same and holds, the builder's and the refund's block test: ${out.copper.tests} tests, ${out.copper.failures} failures (${out.copper.names.join('; ')})`, out.copper.tail);
  out.regression = await javaTests(['*StillOursFluidsTest*', '*JournalTest*', '*JournalPropertyTest*', '*RefundsAndBitsTest*', '*DeltaPropertyTest*', '*ApiCuTest*'], 10);
  check(out.regression.ok, `items 9, 10 (Java): StillOursFluidsTest, JournalTest, JournalPropertyTest, RefundsAndBitsTest, DeltaPropertyTest unchanged; ApiCuTest (the version and weatheringOurs): ${out.regression.tests} tests, ${out.regression.failures} failures (${out.regression.names.join('; ')})`, out.regression.tail);
  const ac = spawnSync(process.execPath, ['tools/api-compat.mjs', '--gate6ccu'], { cwd: root, encoding: 'utf8', timeout: 900_000 });
  out.apicompat = { code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').slice(-8) };
  check(ac.status === 0, 'item 10: api-compat --gate6ccu clean against the latest three releases\' apitest jars and the newest one\'s surface', out.apicompat.tail);
  spendZero();
  return out;
};

// ------------------------------------------------------------------ item 1: the measure (recorded)

steps.measure = async () => {
  await ensure();
  const out = {};
  await freshFlat('G6B CU Measure');
  // default random ticks off (the exact rules): the copper weathers only where dev.vocab.tick ticks it
  const d = await realiseDemo({ field: false });
  out.realise = { state: d.state, cellsWritten: d.cellsWritten, box: d.box };
  const cells = await copperCells(await cellsOf(d.box));
  out.weather = await weatherAll(cells);
  const before = await cellsOf(d.box);
  const rm = await removeRegion(d.region);
  const diff = await diffOf(d.box, d.snapF);
  const list = (diff.list ?? []).map((m) => ({ pos: m.pos, class: m.class, was: m.was, now: hashState(m.now), raw: m.now, weathered: before.get(m.pos) ?? null }));
  const byBlock = {};
  for (const m of list) byBlock[idOf(m.now)] = (byBlock[idOf(m.now)] ?? 0) + 1;
  out.remove = { removed: rm.removed, kept: rm.kept, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes ?? {}, byBlock };
  fs.writeFileSync(path.join(OUT, 'cu-measure-list.json'), `${JSON.stringify({ head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), ...out, copper: cells.map((c) => c.at.join(',')), list }, null, 1)}\n`);
  check(true, `item 1 (recorded): cu_demo's ${cells.length} copper cells (${out.weather.cells} unwaxed: ${out.weather.oxidized} reached oxidized, ${out.weather.forced} stage(s) moved by dev.copper.use weather); after Regions.remove: kept ${rm.kept}, E-flat ${diff.mismatches} mismatches ${json(diff.classes ?? {})}, standing by block ${json(byBlock)} (the list: cu-measure-list.json)`, out.remove);
  return out;
};

// ------------------------------------------------------------------ items 3-6 (flat world, exact rules)

steps.ingame = async () => {
  await ensure();
  const out = {};
  // ---- item 3: every copper cell through every stage, half waxed, a quarter scraped, then Regions.remove: E-flat 0, kept 0
  {
    await freshFlat('G6B CU Undo');
    const d = await realiseDemo({ field: false });
    check(d.state === 'PLACED', `item 3: cu_demo realised (${d.state}, ${d.cellsWritten} cells)`);
    const cells = await copperCells(await cellsOf(d.box));
    const forms = new Set(cells.map((c) => idOf(c.state).replace(/^waxed_/, '')));
    const w = await weatherAll(cells);
    const ws = await waxAndScrape(await copperCells(await cellsOf(d.box)));
    const standing = await copperCells(await cellsOf(d.box));
    const stages = {};
    for (const c of standing) { const k = idOf(c.state).replace(/_?(copper_block|copper|cut_copper.*|chiseled_copper|copper_.*|lightning_rod)$/, '') || 'none'; stages[k] = (stages[k] ?? 0) + 1; }
    out.item3 = { forms: forms.size, cells: cells.length, weather: w, waxed: ws.waxed.length, scraped: ws.scraped.length, stages };
    check(forms.size === 15 && w.oxidized === w.cells && ws.waxed.length >= Math.floor(cells.length / 2) - 16 && ws.scraped.length >= Math.floor(cells.length / 4) - 1,
      `item 3: ${cells.length} copper cells in ${forms.size} forms; ${w.oxidized} of ${w.cells} unwaxed reached oxidized (${w.forced} stage(s) by dev.copper.use weather); ${ws.waxed.length} waxed, ${ws.scraped.length} scraped (stages now ${json(stages)})`, out.item3);
    const rm = await removeRegion(d.region);
    const diff = await diffOf(d.box, d.snapF);
    out.item3.remove = { removed: rm.removed, kept: rm.kept, restored: rm.restored, mismatches: diff.mismatches, classes: diff.classes ?? {}, sample: (diff.list ?? []).slice(0, 12) };
    check(rm.removed && rm.kept === 0 && diff.mismatches === 0, `item 3: Regions.remove after the weathering, waxing and scraping: E-flat ${diff.mismatches} mismatches ${json(diff.classes ?? {})}, kept ${rm.kept} (restored ${rm.restored})`, out.item3.remove);
  }
  // ---- item 6: a player mines one of our copper cells and places their own oxidized_copper there: kept 1, the record survives
  {
    await freshFlat('G6B CU Player');
    const d = await realiseDemo({ field: false });
    const cells = await copperCells(await cellsOf(d.box));
    const target = cells.find((c) => idOf(c.state) === 'copper_block');
    const at = target.at;
    const br = await call('dev.pt.breaks', { at: [at], placer: 'CUPlayer' }, 120_000);
    const pu = await call('dev.pt.uses', { ops: [{ item: 'minecraft:oxidized_copper', at, on: [at[0], at[1] - 1, at[2]], face: 'up', placer: 'CUPlayer' }] }, 120_000);
    const rec0 = await call('dev.pt.at', { at });
    // and the rest of the copper weathered (ours: restored)
    const w = await weatherAll(cells.filter((c) => c !== target));
    const rm = await removeRegion(d.region);
    const diff = await diffOf(d.box, d.snapF);
    const rec1 = await call('dev.pt.at', { at });
    const left = (diff.list ?? []).map((m) => m.pos);
    out.item6 = { at, broken: br.broken, placed: pu.results?.[0], record: { before: rec0, after: rec1 }, weather: w, remove: { removed: rm.removed, kept: rm.kept, mismatches: diff.mismatches, left } };
    check(br.broken === 1 && pu.results?.[0]?.state === 'minecraft:oxidized_copper' && !!rec0.placer, `item 6: the player mined our copper_block at ${at.join(' ')} and placed their own oxidized_copper (PT recorded ${rec0.placer ?? 'nothing'})`, out.item6.placed);
    check(rm.removed && rm.kept === 1 && diff.mismatches === 1 && left[0] === at.join(',') && rec1.state === 'minecraft:oxidized_copper' && rec1.placer === rec0.placer,
      `item 6: Regions.remove left the player's block standing (kept ${rm.kept}; ${diff.mismatches} cell(s) differ: ${json(left)}) and PT's record survives (${rec1.placer ?? 'none'}, ${rec1.state}); the ${w.cells} other copper cells weathered and restored`, out.item6.remove);
  }
  // ---- item 5 (recorded): the field corner's other drift kinds (farmland, leaves, a sapling, snow), ticked, then removed
  {
    await freshFlat('G6B CU Field');
    const d = await realiseDemo({ field: true });
    const all = await cellsOf(d.box);
    const field = [...all].filter(([, s]) => /^(farmland|oak_leaves|oak_sapling|snow)$/.test(idOf(s))).map(([k, s]) => ({ at: k.split(',').map(Number), state: s }));
    const t = await call('dev.vocab.tick', { cells: field.map((c) => c.at), n: 400 }, 300_000);
    // (leaves decay on their scheduled tick once their distance is 7: a few ticks of the world let it run)
    await cmd('/gamerule random_tick_speed 0');
    await settle(3000);
    const after = await cellsOf(d.box);
    const drifted = field.map((c) => ({ at: c.at.join(','), was: c.state, now: after.get(c.at.join(',')) }));
    const cells = await copperCells(after);
    await weatherAll(cells);
    const rm = await removeRegion(d.region);
    const diff = await diffOf(d.box, d.snapF);
    const stood = (diff.list ?? []).map((m) => ({ pos: m.pos, class: m.class, now: idOf(hashState(m.now)), drifted: drifted.find((x) => x.at === m.pos) ?? null }));
    out.item5 = { ticks: (t.cells ?? []).map((c) => ({ at: c.at.join(','), before: c.before, after: c.after })), drifted, remove: { removed: rm.removed, kept: rm.kept, mismatches: diff.mismatches, classes: diff.classes ?? {}, stood } };
    const kinds = {};
    for (const s of stood) kinds[s.drifted ? `${idOf(s.drifted.was)}->${s.now}` : s.now] = (kinds[s.drifted ? `${idOf(s.drifted.was)}->${s.now}` : s.now] ?? 0) + 1;
    check(true, `item 5 (recorded): the field corner's drift (${drifted.filter((x) => x.was !== x.now).length} of ${drifted.length} cells changed: ${json(drifted.filter((x) => x.was !== x.now).map((x) => `${idOf(x.was)}->${idOf(x.now)}`))}); after Regions.remove ${diff.mismatches} cell(s) stood, kept ${rm.kept}: ${json(kinds)} (§5: farmland->dirt ours and restored; leaves, saplings, snow not ours)`, out.item5.remove);
  }
  // ---- item 4 (creative): a copper site's weathered, waxed and scraped chests and statues don't block its removal; the box comes back
  {
    await freshFlat('G6B CU Site');
    await installShed();
    const [x, z] = [CLAIM[0] + 20, CLAIM[1] + 20];
    const y = await groundY(x, z);
    const pre = await cellsOf([x - 2, y - 1, z - 2, x + 12, y + 8, z + 14]);
    const p = await later(`place cu_shed ${x} ${y} ${z} INSTANT owned noactor 0 owner=${OWNER}`);
    const site = p?.siteId;
    check(!!site && p.placed, `item 4: cu_shed placed INSTANT as an owned site (${json(p?.refusals ?? site)})`);
    if (site) {
      const sb = box6((await api('sites')).all.find((s) => s.id === site)?.restoreBox ?? '');
      const cells = await copperCells(await cellsOf(sb));
      const be = cells.filter((c) => /(chest|golem_statue)$/.test(idOf(c.state)));
      const w = await weatherAll(cells);
      const ws = await waxAndScrape(await copperCells(await cellsOf(sb)));
      // the block entities: one more honeycomb and one more axe each, so a weathered, a waxed and a scraped chest and statue all stand
      const beNow = (await copperCells(await cellsOf(sb))).filter((c) => /(chest|golem_statue)$/.test(idOf(c.state)));
      const rm = await later(`remove ${site} ${OWNER} noforce`, 300_000);
      const post = await cellsOf([x - 2, y - 1, z - 2, x + 12, y + 8, z + 14]);
      const differ = [...pre].filter(([k, s]) => post.get(k) !== s).map(([k, s]) => `${k} ${s} -> ${post.get(k)}`);
      out.item4 = { site, blockEntities: beNow.map((c) => `${c.at.join(',')} ${idOf(c.state)}`), weather: w, waxed: ws.waxed.length, scraped: ws.scraped.length, remove: { removed: rm.removed, blockers: rm.blockers, kept: rm.kept }, differ: differ.slice(0, 12) };
      check(be.length === 4 && beNow.some((c) => oxidized(c.state)) && beNow.some((c) => waxed(c.state)) && beNow.some((c, i) => idOf(c.state) !== idOf(be[i]?.state)), `item 4: the site's ${be.length} copper chests and golem statues now ${json(beNow.map((c) => idOf(c.state)))}`, out.item4.blockEntities);
      check(rm.removed && (rm.blockers ?? []).length === 0 && differ.length === 0, `item 4: the site's removal is not blocked by its weathered, waxed or scraped copper block entities (blockers ${json(rm.blockers)}), and its box comes back exactly (${differ.length} cells differ)`, out.item4.remove);
    }
  }
  spendZero();
  return out;
};

// ------------------------------------------------------------------ cu_shed: a copper design with block entities (items 4 and 8)

const box6 = (s) => String(s).replace(/[^-0-9,]/g, ' ').trim().split(/[\s,]+/).map(Number);
async function groundY(x, z) {
  const h = await later(`heights ${x} ${z} ${x} ${z} 1`);
  return h[0][2] + 1;
}
/** cu_shed v1 (and v2: its rail stairs and one wall block taken out): copper walls, a cut copper ceiling, four copper block entities. */
async function shed(version = 1) {
  const D = await imp('test/fixtures/vocab/voc-designs.mjs');
  const { Blueprint, palette } = await imp('lib/kit.mjs');
  const p = palette({ bible: D.vocBible('g6cvoc_copper') });
  const X = 8, Z = 6, H = 5;
  const bp = new Blueprint({ id: 'cu_shed', name: 'CU Shed', description: 'CU Shed', type: 'custom', profile: ['door', 'lit'], size: [X + 1, H + 1, Z + 5], origin: [0, 0, 0], groundY: 1, front: 'south', palette: p, approach: false, interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
  bp.part('main', () => bp.room([0, 0, 0, X, H, Z], { wall: 'minecraft:copper_block', floor: p.floor, ceiling: 'minecraft:cut_copper', corners: 'minecraft:waxed_cut_copper' }));
  bp.part('openings', () => { bp.door(4, 1, Z, 'south'); bp.ceilingLights(1, 1, X - 1, Z - 1, H - 1, { spacing: 5 }); });
  bp.part('approach', () => bp.floor(3, Z + 1, 5, Z + 4, 0, p.path));
  bp.spot('entrance', 4, Z + 1, 180);
  bp.spot('spawn', 4, Z + 3, 180);
  bp.part('copper', () => {
    bp.set(1, 1, 1, 'minecraft:copper_chest', { facing: 'south', type: 'single', waterlogged: 'false' });
    bp.set(3, 1, 1, 'minecraft:waxed_copper_chest', { facing: 'south', type: 'single', waterlogged: 'false' });
    bp.set(5, 1, 1, 'minecraft:copper_golem_statue', { copper_golem_pose: 'standing', facing: 'south', waterlogged: 'false' });
    bp.set(7, 1, 1, 'minecraft:waxed_copper_golem_statue', { copper_golem_pose: 'standing', facing: 'south', waterlogged: 'false' });
    bp.set(1, 1, 5, 'minecraft:lightning_rod', { facing: 'up', powered: 'false', waterlogged: 'false' });
    if (version === 1) for (const x of [5, 6, 7]) bp.set(x, 1, 5, 'minecraft:cut_copper_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' });
    if (version === 2) bp.set(8, 2, 3, 'minecraft:air');
  });
  return bp;
}
async function installShed() {
  const { writeBlueprint } = await imp('lib/write.mjs');
  const dir = path.join(L.LIBRARY, 'cu_shed');
  fs.rmSync(dir, { recursive: true, force: true });
  writeBlueprint(await shed(1), dir);
  await cmd('/architect reload');
}

// ------------------------------------------------------------------ items 7, 8 (survival, a stockpile)

const pile = async (op, payload = {}) => call(`dev.stockpile.${op}`, { owner: OWNER, ...payload }, 120_000);
const pstate = async () => (await pile('state')).stockpile;
const siteState = async (id) => call('dev.site.state', { site: id }, 60_000);
/** Inserts into the stockpile (a hopper's rule). */
const insert = async (items) => (await call('dev.crate.insert', { site: `stockpile:${OWNER}`, items, exact: true }, 120_000)).accepted ?? {};
async function waitState(site, want, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  let st;
  while (Date.now() < end) { st = await siteState(site); if (st.state === want) return st; await sleep(1500); }
  return st;
}

steps.survival = async () => {
  await ensure();
  const out = {};
  await L.leaveWorld();
  L.copyWorld(SURV, 'G6B CU Survival');
  await L.openWorld('G6B CU Survival');
  await call('dev.survival.set', { on: true });
  const X = 200, Z = 200;
  await cmd('/gamemode spectator');
  await cmd(`/tp @s ${X + 4} 0 ${Z - 20} 0 60`);
  const y = await groundY(X, Z);
  await cmd(`/tp @s ${X + 4} ${y + 24} ${Z - 20} 0 60`);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  const c = await pile('create', { crates: [[X - 10, y, Z - 20], [X - 8, y, Z - 20], [X - 6, y, Z - 20]] });
  if (c?.refused) throw new Error(`createStockpile refused: ${json(c.refused)}`);
  await installShed();
  const area = [X - 4, y - 2, Z - 4, X + 14, y + 10, Z + 16];
  const pre = await cellsOf(area);
  const p = await later(`place cu_shed ${X} ${y} ${Z} CONSTRUCTION owned noactor 0 owner=${OWNER}`);
  const site = p?.siteId;
  check(!!site && p.placed, `item 8: cu_shed placed as a construction site drawing from ${OWNER}'s stockpile (${json(p?.refusals ?? site)})`);
  if (!site) return out;
  const st0 = await siteState(site);
  const bill = st0.bom ?? {};
  out.bill = bill;
  // ---- (a) fed all but the lightning rod: the build waits on it; its copper weathers while it waits
  const L0 = (await pstate()).ledger;
  const hold = 'minecraft:lightning_rod';
  await insert(Object.fromEntries(Object.entries(bill).filter(([k]) => k !== hold)));
  const end = Date.now() + 300_000;
  let st;
  while (Date.now() < end) { st = await siteState(site); if (st.built >= st.queue - (bill[hold] ?? 0)) break; await sleep(1500); }
  await settle(3000);
  st = await siteState(site);
  const ps1 = await pstate();
  const sb = box6((await api('sites')).all.find((s) => s.id === site)?.restoreBox ?? '');
  // the plan's cells (dev.site.cells answers while the site builds: here, waiting on the rod)
  const targets1 = Object.fromEntries(Object.entries(await call('dev.site.cells', { site })).filter(([k]) => /^-?\d+,-?\d+,-?\d+$/.test(k)));
  const built = await copperCells(await cellsOf(sb));
  const w = await weatherAll(built);
  await settle(10_000); // the builder's rescans
  const st2 = await siteState(site);
  const ps2 = await pstate();
  out.a = { waiting: { built: st.built, queue: st.queue, outstanding: ps1.outstanding }, weather: w, after: { built: st2.built, queue: st2.queue, outstanding: ps2.outstanding, state: st2.state }, consumed: minus(ps2.ledger.consumed, L0.consumed) };
  check(st.built === st.queue - 1 && same(ps1.outstanding, { [hold]: 1 }), `item 8a: fed all but the ${hold}: ${st.built}/${st.queue} built, outstanding ${json(ps1.outstanding)}`, out.a.waiting);
  check(w.oxidized === w.cells && st2.built === st.built && same(ps2.outstanding, ps1.outstanding) && same(ps2.ledger.consumed, ps1.ledger.consumed),
    `item 8a: ${w.cells} built copper cells weathered to oxidized while the build waited (${w.forced} stage(s) forced): still ${st2.built}/${st2.queue} built, outstanding ${json(ps2.outstanding)}, consumed unchanged (nothing re-queued, nothing charged again)`, out.a.after);
  await insert({ [hold]: 1 });
  const st3 = await waitState(site, 'built');
  const ps3 = await pstate();
  const charged = minus(ps3.ledger.consumed, L0.consumed);
  out.a.built = { state: st3?.state, charged };
  check(st3?.state === 'built' && same(charged, bill), `item 8a: the ${hold} fed, the site BUILT; charged exactly the bill once (${sum(charged)} items, ${json(minus(charged, bill))} over)`, out.a.built);
  /** Every cell refunded a block other than its plan's: {pos, target (the plan's state: the standing state's properties), standing}. */
  const perCell = [];
  const withId = (state, id) => String(state).replace(/^minecraft:[a-z0-9_]+/, `minecraft:${id}`);
  let deltaRefund = {};
  // ---- (c) and item 7: a version delta over weathered cells: v2 takes the three rail stairs and one wall block out
  {
    const { writeBlueprint } = await imp('lib/write.mjs');
    const dir = path.join(OUT, 'cu_shed-v2');
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(await shed(2), dir);
    const v2 = await call('dev.entry.installVersion', { entry: 'cu_shed', dir, summary: 'v2: no rail, a hole in the east wall' }, 60_000);
    const gone = [[X + 5, y + 1, Z + 5], [X + 6, y + 1, Z + 5], [X + 7, y + 1, Z + 5], [X + 8, y + 2, Z + 3]];
    const standing = await cellsOf([X, y, Z, X + 8, y + 5, Z + 6]);
    const was = gone.map((g) => standing.get(g.join(',')));
    const chk = await api(`checkdelta ${site} ${v2.version} refuse ${OWNER}`);
    const Ld0 = (await pstate()).ledger;
    const dl = await later(`applydelta ${site} ${v2.version} refuse ${OWNER}`, 120_000);
    await settle(2000);
    const Ld1 = (await pstate()).ledger;
    const { bomOf } = await imp('lib/connectors/bom.mjs');
    const expect = bomOf(was);
    const returned = minus(Ld1.returned, Ld0.returned);
    deltaRefund = dl.refund ?? {};
    gone.forEach((g, i) => { const t = targets1?.[g.join(',')]; if (t && was[i] && idOf(t) !== idOf(was[i])) perCell.push({ pos: g.join(','), by: 'delta', target: withId(was[i], idOf(t)), standing: was[i] }); });
    out.c = { cells: gone.map((g, i) => ({ at: g, standing: was[i] })), check: { ok: chk.ok ?? chk.allowed, refusals: chk.refusals, kept: chk.kept, edited: chk.edited }, delta: { applied: dl.applied, refund: dl.refund, refusals: dl.refusals }, returned, expect };
    check(was.every((s) => s && oxidized(s)) && (chk.refusals ?? []).length === 0, `item 7: Sites.checkDelta (PlayerEdits REFUSE) over the weathered cells ${json(was.map(idOf))}: no PLAYER_EDITS, no refusal (${json(chk.refusals ?? [])}; kept ${json(chk.kept ?? null)})`, out.c.check);
    check(dl.applied && same(dl.refund, expect) && same(returned, expect), `item 8c: the delta removed them and refunded the standing blocks' items ${json(expect)} into the stockpile (refund ${json(dl.refund)}, returned ${json(returned)})`, out.c.delta);
  }
  // ---- (b) everything weathered, half waxed, a quarter scraped; deconstructed: every copper cell a REFUND of the standing block, to the
  // stockpile; no copper dropped
  {
    const cells = await copperCells(await cellsOf(sb));
    const w2 = await weatherAll(cells);
    const ws = await waxAndScrape(await copperCells(await cellsOf(sb)));
    const now = await cellsOf(sb);
    const targets = Object.fromEntries(Object.entries(await call('dev.site.cells', { site })).filter(([k]) => /^-?\d+,-?\d+,-?\d+$/.test(k)));
    // (diagnostics) the plan's cells before the delta that the site no longer queues after it, and what stands there
    const goneKeys = new Set([[X + 5, y + 1, Z + 5], [X + 6, y + 1, Z + 5], [X + 7, y + 1, Z + 5], [X + 8, y + 2, Z + 3]].map((g) => g.join(',')));
    out.unqueued = Object.entries(targets1).filter(([k]) => !(k in targets) && !goneKeys.has(k)).map(([k, t]) => ({ pos: k, target: t, standing: now.get(k) ?? null }));
    const standing = [];
    const perCell = [];
    for (const [pos, tid] of Object.entries(targets ?? {})) {
      const s = now.get(pos);
      if (!s || /^minecraft:(air|cave_air)/.test(s)) continue;
      standing.push(s);
      if (idOf(s) !== idOf(tid)) perCell.push({ pos, by: 'deconstruct', target: withId(s, idOf(tid)), standing: s, steps: ['weathered', ...ws.waxed.filter((q) => q.at.join(',') === pos).map(() => 'waxed'), ...ws.scraped.filter((q) => q.at.join(',') === pos).map(() => 'scraped')] });
    }
    // the door's upper half is not queued apart; bomOf counts a door once (its lower half)
    const { bomOf } = await imp('lib/connectors/bom.mjs');
    const expect = bomOf(standing);
    const Lb0 = (await pstate()).ledger;
    const rm = await later(`remove ${site} ${OWNER} noforce`, 300_000);
    await settle(3000);
    const Lb1 = (await pstate()).ledger;
    const returned = minus(Lb1.returned, Lb0.returned);
    const near = await call('dev.items.near', { pos: [X + 4, y + 2, Z + 3], radius: 16 }, 30_000);
    const dropped = Object.fromEntries(Object.entries(near.items ?? {}).filter(([k]) => /copper|lightning_rod/.test(k)));
    const post = await cellsOf(area);
    const differ = [...pre].filter(([k, s]) => post.get(k) !== s && !/grass_block|dirt/.test(`${s}${post.get(k)}`));
    out.b = { weather: w2, waxed: ws.waxed.length, scraped: ws.scraped.length, perCell, expect, remove: { removed: rm.removed, refund: rm.refund, blockers: rm.blockers }, returned, dropped, differ: differ.length };
    check(perCell.length > 0 && rm.removed && same(returned, expect) && same(rm.refund ?? returned, expect), `item 8b: deconstructed after weathering (${w2.cells} cells), waxing (${ws.waxed.length}) and scraping (${ws.scraped.length}): the stockpile was credited the items of the blocks standing (${sum(expect)} items; returned ${json(minus(returned, expect))} off); ${perCell.length} cells refunded a block other than their plan's, named per cell`, { expect, returned, perCell: perCell.slice(0, 20) });
    check(Object.keys(dropped).length === 0, `item 8b: 0 copper dropped at the site as a player's block (${json(near.items ?? {})})`, dropped);
    // the ledger: charged (consumed over the whole build) minus everything refunded (the delta's and the deconstruct's) equals, per item,
    // what the named cells' weathering, waxing and scraping changed (each cell's plan state against the state standing, full states)
    const Lend = (await pstate()).ledger;
    const chargedAll = minus(Lend.consumed, L0.consumed);
    const refundedAll = minus(Lend.returned, L0.returned);
    const stepDiff = minus(bomOf(perCell.map((q) => q.target)), bomOf(perCell.map((q) => q.standing)));
    out.ledger = { charged: chargedAll, refunded: refundedAll, deltaRefund, perCell };
    check(same(minus(chargedAll, refundedAll), stepDiff) && same(chargedAll, bill), `item 8b: one charge and one refund per cell: charged ${sum(chargedAll)} (the bill), refunded ${sum(refundedAll)}; they differ exactly by the ${perCell.length} named cells' steps (${json(stepDiff).slice(0, 300)})`, { charged: chargedAll, refunded: refundedAll, stepDiff, perCell });
    check(differ.length === 0, `item 8b: the terrain came back (${differ.length} cells differ outside soil)`, differ.slice(0, 8));
  }
  await L.leaveWorld();
  spendZero();
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(unit|measure|ingame|survival)\.json$/.test(f));
  const lines = ['# Gate 6c slice CU', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate6ccu.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
