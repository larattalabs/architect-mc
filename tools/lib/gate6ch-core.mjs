// (6c H) H-core's items of the H gate (tools/gate6ch.mjs; docs/CONTRACT.md "Phase 6c slice H" §14): item 11's byte identity offline,
// and the in-game items on h_core_demo (ingame: 1-3, 5, 6; crash: 7; probe: 13, 14). H-core owns this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FL_MOVED, FL_MOVED_ASKS, normIrJson } from './fl-norm.mjs'; // (6c FL) the street ext normalised, FL's named movers
import * as P3 from './p3-tier.mjs';
import { identicalToBase, skippedLine } from './base-tree.mjs';
import { F7A_MOVED } from './f7a-norm.mjs'; // (7a foundation) the fixtures the foundation's catalogue changes move by name
import { THEME_REST_MOVED } from './theme-rest-norm.mjs'; // (theme rest) the tunnel fixtures' flush lamp
import { PF_MOVED } from './pf-norm.mjs'; // (7c PF) the aqueducts' arches from the archSpan module
import { SP2_MOVED } from './sp2-norm.mjs'; // (SP2) a crater's recorded params read

/**
 * Item 11's named exceptions: the fixtures that may differ from origin/main; every other fixture must not. (The H batch's T3a r06 and
 * r07, which fit on wet piers since H-b's wet fallback, are on main now and plan the same, so they left the list in housekeeping 3.)
 * Housekeeping 3's even-width rule (ropeGeom latOn): v33's and v34's 2-wide villager rope bridges run +z, so their decks moved one
 * column onto the route's side (lo/hi -1..0, not 0..1) and their answers' cell counts and IRs differ; the overall answers are the same.
 */
// ((6c HY) h/r08_course (a course: HY-b's v51) and extension/e15 (channel.course left the reserved list) by name, though this loop reads neither dir)
export const UNCHANGED_EXCEPTIONS = Object.freeze(['valid/v33_rope_bridge.json', 'valid/v34_auto.json', 'h/r08_course.json', 'extension/e15_every_reserved_a.json', ...FL_MOVED.filter((n) => n !== 'extension/e15_every_reserved_a.json'), ...Object.keys(F7A_MOVED).filter((n) => !FL_MOVED.includes(n)), ...Object.keys(THEME_REST_MOVED), ...Object.keys(PF_MOVED), ...Object.keys(SP2_MOVED)]); // ((7a foundation) its named movers)
/** Fixtures the comparison skips by name: refused/k1a_r01 runs the two-plan harness (its `volume`; H-b re-answers it WATER deep). */
export const UNCHANGED_SKIPPED = Object.freeze(['refused/k1a_r01_wall_water.json']);

/**
 * Item 11's byte identity: every committed valid/, K1 and T3 fixture without an H part answers as on origin/main and plans the same IR
 * but its kitVersion (the main checkout's kit in a detached worktree beside this one). `ok`: n >= 40 and only the named exceptions
 * differ (`excepted`: those that do).
 */
/**
 * (gate waits, 2026-10-20) The comparison's per-fixture results by `${root}|${mainHead}`: H-a's item 11 (gate6ch-a.mjs haUnchanged)
 * runs the very same loop over the same fixtures against the same origin/main, so inside one h-unit it reads them from here instead
 * of planning all 61 fixtures twice more. Its own check, exceptions and bar are unchanged.
 */
export const unchangedRuns = new Map();

export async function unchanged(root, { baseDir = null, only = null } = {}) {
  // (baseDir, only: a test's own base tree and fixture filter, kit/test/gate-corpus-plan.test.mjs; a gate run: origin/main's worktree, every fixture)
  let mainHead = 'given';
  let sk = null;
  if (!baseDir) {
    execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
    mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
    // (speed audit D, K1) origin/main's kit and scenarios trees identical to HEAD's: the loop can only agree; each fixture is counted
    // (the same filters) and recorded as equal without planning either side
    sk = identicalToBase(root, { ref: mainHead });
  }
  const mainDir = baseDir ?? (sk ? root : path.resolve(root, '..', 'architect-mc-H-main'));
  if (!baseDir && !sk) {
    if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
    else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  }
  // ((speed audit A) the corpus plan store and pool (corpus-plan.mjs) instead of plan-cache.mjs's planSide: the same call per side
  // (CP.hyRun: this checkout's fixture on both sides), planned on every core first; GATE_PLAN_CACHE=0: the plain helpers, serially)
  const CP = await import('./corpus-plan.mjs');
  const { hNew, hOld } = sk ? { hNew: null, hOld: null } : await CP.corpusHelpers(root, mainDir);
  const out = { mainHead, fixtures: {}, ...(sk ? { identical: skippedLine(sk, 'unchanged vs origin/main') } : {}) };
  let same = 0, skipped = 0;
  const H_KINDS = ['pond', 'fountain', 'waterfall', 'quay', 'channel'];
  const todo = [];
  for (const dir of ['valid', 'k1a', 'rope', 'refused', 't3a', 'tunnel']) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', dir);
    if (!fs.existsSync(fixDir)) continue;
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      if (only && !only.test(`${dir}/${f}`)) continue;
      if (UNCHANGED_SKIPPED.includes(`${dir}/${f}`)) { skipped++; continue; }
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan) continue;
      const parts = [...(fx.plan.forms ?? []), ...(fx.plan.connectors ?? [])];
      // (an H part, a fixture H added, or one H re-answers by name: §14 item 11's list)
      if (parts.some((c) => H_KINDS.includes(c.kind)) || /"farmPond":true/.test(JSON.stringify(fx.plan)) || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      if (fx.volume) continue; // (a frozen volume built by its own test)
      if (sk) { out.fixtures[`${dir}/${f}`] = { answers: true, ir: true, overall: true }; same++; continue; }
      todo.push({ name: `${dir}/${f}`, fx });
    }
  }
  const mod = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus-plan.mjs')).href;
  await CP.prewarm(root, todo.flatMap((t) => [
    { id: `hy:head:${t.name}`, module: mod, export: 'jobHyFixture', args: [root, root, t.name, false, [...CP.HEAD_DERIVE]] },
    { id: `hy:hbase:${t.name}`, module: mod, export: 'jobHyFixture', args: [mainDir, root, t.name, false, [...CP.BASE_DERIVE]] },
  ]));
  // (a result's three comparands, as plan-cache.mjs's planSide made them; kitVersion and FL's street ext normalised)
  const sideOf = (r) => ({ answers: createHash('sha256').update(JSON.stringify(r.check?.parts ?? r.check?.malformed ?? null)).digest('hex'), ir: createHash('sha256').update(normIrJson(r.res?.irJson ?? '')).digest('hex'), overall: r.check?.overall ?? null });
  for (const t of todo) {
    let a, b;
    try {
      a = sideOf(await CP.hyRun(hNew, t.fx, t.fx.plan, t.name));
      b = sideOf(await CP.hyRun(hOld, t.fx, t.fx.plan, t.name)); // (both sides check this checkout's fixture)
    } catch (e) { out.fixtures[t.name] = { error: String(e.message).slice(0, 200) }; continue; }
    const eq = { answers: a.answers === b.answers, ir: a.ir === b.ir, overall: a.overall === b.overall };
    out.fixtures[t.name] = eq;
    if (eq.answers && eq.ir && eq.overall) same++;
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  out.cache = { store: CP.statsLine() };
  unchangedRuns.set(`${root}|${mainHead}`, { fixtures: { ...out.fixtures }, same, skipped });
  const differing = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall));
  out.excepted = differing.map(([k]) => k).filter((k) => UNCHANGED_EXCEPTIONS.includes(k));
  out.differ = differing.filter(([k]) => !UNCHANGED_EXCEPTIONS.includes(k)).map(([k, v]) => [k, v]);
  out.ok = out.n >= 40 && out.differ.length === 0 && out.same + out.excepted.length === out.n;
  return out;
}

// ------------------------------------------------------------------ in game: shared helpers

export const OWNER = 'test:h';
const FLAT = 'G6B Flat Base';
/** h_core_demo's claim on the flat world (96 x 96). */
export const CLAIM = [9000, 9000, 9095, 9095];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bodies of a plan's IR (its fluid ops), cells unpacked: {id, fluid, level, cells, spill, joins, watch, ice, shell, predicted, settleTicks}. */
function bodiesOf(ir) {
  const cellsOf = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };
  const out = [];
  for (const p of ir.parts) for (const o of p.ops) if (o.op === 'fluid') out.push({ id: o.id, fluid: o.fluid, level: o.level, cells: cellsOf(o.cells), spill: cellsOf(o.spill), joins: cellsOf(o.joins), watch: cellsOf(o.watch), ice: cellsOf(o.ice), shell: cellsOf(o.shell), predicted: o.predicted ?? [], settleTicks: o.settleTicks });
  return out;
}
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
/** A box around cells grown by g: [x0, y0, z0, x1, y1, z1]. */
function boxAround(cells, g = 2) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of cells) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
  return [b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g];
}

/**
 * A body's census against its prediction, from dev.fluid.census over its watch box: {ok, sources, flowing, mismatch: [...], outside:
 * [...] (fluid of the body's kind outside its cells, spill and joins that the before-census did not hold), ticks}.
 */
export async function censusOf(ctx, body, before = null, siblings = []) {
  const all = [...body.cells, ...body.shell, ...body.spill, ...body.watch];
  const box = boxAround(all, 2);
  const c = await ctx.L.call('dev.fluid.census', { box }, 120_000);
  const now = new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
  const pred = new Map(body.predicted.map(([x, y, z, lv]) => [`${x},${y},${z}`, lv]));
  // the region's other bodies' sources and predicted flow are theirs (a fountain's spout stands in its basin): never this one's outside
  const others = new Set(siblings.filter((o) => o.id !== body.id).flatMap((o) => [...o.cells.map(k3), ...o.ice.map(k3), ...o.predicted.map(k3)]));
  const own = new Set(body.cells.map(k3)), ice = new Set(body.ice.map(k3)), declared = new Set([...body.cells, ...body.spill, ...body.joins].map(k3));
  const kind = body.fluid === 'lava' ? 'minecraft:lava' : 'minecraft:water';
  const levelOf = (s) => { const m = /level=(\d+)/.exec(s); return m ? Number(m[1]) : 0; };
  const mismatch = [], outside = [];
  let sources = 0, flowing = 0;
  for (const k of own) {
    const s = now.get(k);
    if (ice.has(k)) { if (s !== 'minecraft:ice') mismatch.push([k, s ?? 'none', 'ice']); continue; }
    if (!s || !s.startsWith(kind) || levelOf(s) !== 0) mismatch.push([k, s ?? 'none', 'source']); else sources++;
  }
  for (const [k, lv] of pred) {
    const s = now.get(k);
    if (!s || !s.startsWith(kind) || levelOf(s) !== lv) mismatch.push([k, s ?? 'none', `level ${lv}`]); else flowing++;
  }
  for (const [k, s] of now) {
    if (own.has(k) || pred.has(k) || others.has(k) || !s.startsWith(kind)) continue;
    if (before && before.has(k)) continue;
    if (declared.has(k)) mismatch.push([k, s, 'none']); else outside.push([k, s]);
  }
  return { ok: !mismatch.length && !outside.length, sources, flowing, mismatch: mismatch.slice(0, 20), outside: outside.slice(0, 20), outsideCount: outside.length, ticks: c.ticks.length, box, fluids: now };
}

/** A fresh copy of the flat base, its rules ('exact' or the base's own defaults), the player over the claim. */
export async function freshFlat(ctx, name, rules) {
  const L = ctx.L;
  await L.fresh(name, FLAT);
  if (rules === 'exact') await L.setRules('exact');
  else { await L.cmd('/weather clear'); await L.cmd('/time set 6000'); }
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
}

/** Plan h_core_demo (the two-plan flow: its volumes with the fluid layer), its IR and meta read from the sidecar's plan dir. */
export async function planDemo(ctx, params = {}) {
  const L = ctx.L;
  const p = await L.plan('h_core_demo', CLAIM, { params, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const report = fs.existsSync(path.join(dir, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) : null;
  return { p, dir, ir, meta, report, bodies: bodiesOf(ir) };
}

/** The region's box for snapshots: the claim + 8 around, from 8 under the lowest body cell to 16 over the ground. */
export function demoBox(bodies) {
  const all = bodies.flatMap((b) => [...b.cells, ...b.shell, ...b.spill, ...b.watch]);
  const b = boxAround(all, 0);
  return [CLAIM[0] - 8, b[1] - 8, CLAIM[1] - 8, CLAIM[2] + 8, b[4] + 16, CLAIM[3] + 8];
}

export async function realiseWait(ctx, planId, opts = {}) {
  const L = ctx.L;
  const region = await L.realise(planId, opts);
  const st = await L.waitRegion(region, 3_600_000);
  return { region, st, view: st.view, fluids: st.view.ext?.['architect_mc:fluids'] ?? null };
}

export async function removeWait(ctx, region) {
  const L = ctx.L;
  const t0 = Date.now();
  const r = await L.call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s ?? 'REMOVED' };
    if (s === 'PARTIAL' || s === 'FAILED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s };
    await sleep(500);
  }
  throw new Error(`removal of ${region} did not finish`);
}

export const snap = async (ctx, box, name) => { const file = path.join(ctx.OUT, `${name}.snap.gz`); await ctx.L.call('dev.region.hash', { box, mode: 'snap', file }, 4 * 3_600_000); return file; };
export const diff = async (ctx, box, file) => { const r = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file }, 4 * 3_600_000); return { mismatches: r.mismatches, classes: r.classes ?? {}, sample: (r.list ?? []).slice(0, 12) }; };

/** The shell cell a breach opens (§14 item 6): the deepest side cell of a body (a shell cell beside a body cell, lowest, ties by x, z). */
/**
 * A body and the same-fluid siblings it touches: one whose sources or predicted flow lie in or beside (26 neighbours) this one's cells,
 * predicted flow, spill or watch, or the other way round (a fountain's spout falls onto its basin).
 */
function linkedOf(body, bodies) {
  const grow = (cells) => { const s = new Set(); for (const [x, y, z] of cells) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) s.add(`${x + dx},${y + dy},${z + dz}`); return s; };
  const reachOf = (o) => [...o.cells, ...o.predicted, ...o.spill, ...o.watch];
  const mine = grow(reachOf(body));
  return bodies.filter((o) => o === body || (o.fluid === body.fluid && reachOf(o).some((c) => mine.has(k3(c)))));
}

function breachCell(body) {
  const own = new Set(body.cells.map(k3));
  const side = body.shell.filter(([x, y, z]) => y <= body.level && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => own.has(`${x + dx},${y},${z + dz}`)));
  side.sort((a, b) => a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  return side[0] ?? body.shell.find((c) => c[1] <= body.level) ?? null;
}

// ------------------------------------------------------------------ in game: items 1-3, 5, 6

/** Items 1-3, 5, 6 on h_core_demo (a flat world, headless). */
export async function ingame(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  // ---- (A) default rules: item 1 in game, item 2 (census, settle, a 2-minute stand), item 6 (the single breach and its undo)
  {
    await freshFlat(ctx, 'G6B H Default', 'default');
    const d = await planDemo(ctx, { lava: true });
    const f = (d.report?.findings ?? []).filter((x) => /^M(25|20)/.test(x.rule));
    out.plan = { planId: d.p.planId, irSha: d.p.irSha, notes: (d.p.notes ?? []).filter((n) => /volume/.test(n)), bodies: d.bodies.map((b) => [b.id, b.cells.length, b.spill.length, b.watch.length, b.settleTicks]), findings: f };
    check(d.bodies.length === 4 && (d.p.notes ?? []).some((n) => /read 4 frozen volumes/.test(n)), `item 1 (in game): h_core_demo planned 4 bodies over 4 frozen volumes with the fluid layer (two-plan flow: ${json(out.plan.notes)}; ${json(out.plan.bodies)})`);
    check(d.report && f.length === 0, `item 1 (in game): M25 and M20 0 on the plan's own check (${f.map((x) => `${x.rule} ${x.count}`).join(', ') || 'none'})`);
    const before = new Map();
    for (const b of d.bodies) { const c = await censusOf(ctx, b); for (const [k, s] of c.fluids) before.set(k, s); }
    const t0 = Date.now();
    const r = await realiseWait(ctx, d.p.planId);
    out.realise = { region: r.region, state: r.view.state, ms: Date.now() - t0, fluids: r.fluids };
    check(r.view.state === 'PLACED' && (r.fluids ?? []).length === 4 && r.fluids.every((x) => x.state === 'settled'), `item 2: PLACED only when every body settled (${r.view.state}; ${json((r.fluids ?? []).map((x) => [x.body, x.state, x.settledAt]))})`);
    const bound = new Map(d.bodies.map((b) => [b.id, b.settleTicks]));
    check((r.fluids ?? []).every((x) => x.settledAt <= bound.get(x.body)), `item 2: each body settled within its settleTicks (${json((r.fluids ?? []).map((x) => [x.body, x.settledAt, bound.get(x.body)]))})`);
    const c1 = {};
    for (const b of d.bodies) c1[b.id] = await censusOf(ctx, b, before, d.bodies);
    out.census = Object.fromEntries(Object.entries(c1).map(([k, v]) => [k, { ok: v.ok, sources: v.sources, flowing: v.flowing, mismatch: v.mismatch, outside: v.outside, ticks: v.ticks }]));
    check(Object.values(c1).every((c) => c.ok && c.ticks === 0), `item 2: every body's census equals its prediction exactly (sources, flowing levels), 0 fluid outside its cells, spill and joins, no fluid tick scheduled (${json(Object.entries(c1).map(([k, v]) => [k, v.sources, v.flowing, v.mismatch.length, v.outsideCount]))})`);
    // the stand: 2 minutes at default rules (random ticks, fire, spawns): the census unchanged (P3 smoke: 30 s; the physics is the census's)
    await L.gameWait(P3.standMs(120_000), { real: sleep, label: 'h item 2 stand' });
    const c2 = {};
    for (const b of d.bodies) c2[b.id] = await censusOf(ctx, b, before, d.bodies);
    out.stand = Object.fromEntries(Object.entries(c2).map(([k, v]) => [k, { ok: v.ok, mismatch: v.mismatch, outside: v.outside }]));
    check(Object.values(c2).every((c) => c.ok), `item 2: a ${P3.standMs(120_000) / 1000} s stand at default rules adds nothing (${json(Object.entries(c2).map(([k, v]) => [k, v.mismatch.length, v.outsideCount]))})`, out.stand);
    // item 6: one shell cell of each body opened (a player's pickaxe); after a settle bound the water reaches only its declared and
    // watched cells (the breach reach as predicted, re-surveyed), never a lot, a build, a protected area or keep-out (none here: the claim)
    // (P3 smoke: one body's breach, the pond's: the calibration instance; the water lint's W3 sweeps every shell cell of every body offline)
    const breached = P3.smoke ? d.bodies.filter((b) => b.id === 'pond') : d.bodies;
    if (P3.smoke) P3.skipped(log, `item 6: the single breach of ${d.bodies.filter((b) => b.id !== 'pond').map((b) => b.id).join(', ')}`, 'the water lint W3 (kit/lint)');
    const opened = {};
    for (const b of breached) { const c = breachCell(b); opened[b.id] = c; if (c) await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`); }
    await L.gameWait(Math.max(...breached.map((b) => b.settleTicks)) * 50 * 2 + 3000, { real: sleep, label: 'h item 6 breach settle' });
    const c3 = {};
    for (const b of breached) {
      const c = await censusOf(ctx, b, before, d.bodies);
      // every body was breached at once: each one's reach is its own cells, spill and watch plus its siblings' (a spout over its basin)
      const linked = linkedOf(b, d.bodies);
      const allowed = new Set(linked.flatMap((o) => [...o.cells, ...o.spill, ...o.watch, ...o.joins, ...o.predicted]).map(k3));
      const kind = b.fluid === 'lava' ? 'minecraft:lava' : 'minecraft:water';
      const beyond = [...c.fluids].filter(([k, s]) => s.startsWith(kind) && !allowed.has(k) && !before.has(k));
      c3[b.id] = { opened: opened[b.id], beyond: beyond.slice(0, 12), n: beyond.length };
    }
    out.breach = c3;
    check(Object.values(c3).every((x) => x.opened && x.n === 0), `item 6: a single breach of each body (${json(Object.fromEntries(Object.entries(c3).map(([k, v]) => [k, v.opened])))}) reaches nothing past its cells, spill and watched breach reach (${json(Object.fromEntries(Object.entries(c3).map(([k, v]) => [k, v.n])))})`, c3);
    // its undo: the watched cells restored, 0 fluid in the watch boxes the before-census did not hold, 0 new sources anywhere in them
    const rm = await removeWait(ctx, r.region);
    out.breachUndo = { removed: rm.removed, state: rm.state, seconds: rm.seconds };
    let extra = 0, newSources = 0;
    const left = [];
    for (const b of d.bodies) {
      const c = await censusOf(ctx, b, before, d.bodies);
      for (const [k, s] of c.fluids) if (!before.has(k) && s !== 'minecraft:ice') { extra++; if (!/level=[1-9]/.test(s)) newSources++; if (left.length < 12) left.push([k, s]); }
    }
    out.breachUndo.extra = extra;
    out.breachUndo.newSources = newSources;
    check(rm.state === 'REMOVED' && extra === 0 && newSources === 0, `item 6: Regions.remove after the breach: ${rm.state} in ${rm.seconds} s; 0 fluid cells in the watch boxes the before-census did not hold (${extra}), 0 new sources (${newSources})`, left);
    await L.leaveWorld();
  }
  // ---- (B) exact rules: item 5, exact undo (E-flat 0 over the claim, fluid cells compared by state)
  let box = null;
  {
    await freshFlat(ctx, 'G6B H Exact', 'exact');
    const d = await planDemo(ctx, { lava: true });
    box = demoBox(d.bodies);
    const file = await snap(ctx, box, 'h-exact');
    const r = await realiseWait(ctx, d.p.planId);
    check(r.view.state === 'PLACED' && (r.fluids ?? []).every((x) => x.state === 'settled'), `item 5: the exact-rules realise PLACED, every body settled (${r.view.state}; ${json((r.fluids ?? []).map((x) => [x.body, x.state]))})`);
    const ticks = [];
    for (const b of d.bodies) ticks.push((await censusOf(ctx, b)).ticks);
    const rm = await removeWait(ctx, r.region);
    await sleep(3000);
    const df = await diff(ctx, box, file);
    out.exact = { region: r.region, box, removed: rm.removed, state: rm.state, seconds: rm.seconds, restored: rm.restored ?? null, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
    check(rm.state === 'REMOVED' && df.mismatches === 0, `item 5: Regions.remove (drain, a settle bound, then the solids) restores the box exactly under the exact rules: E-flat ${df.mismatches} over ${(box[3] - box[0] + 1) * (box[4] - box[1] + 1) * (box[5] - box[2] + 1)} cells (fluid cells by state; ${rm.seconds} s)`, df.sample);
    // the same, with item 6's breach before the removal (its exactness is item 5's)
    await L.leaveWorld();
  }
  if (P3.smoke) P3.skipped(log, "item 6's exactness after a breach (a second exact-rules world)", "item 5's exact undo here and the breach's removal in (A)");
  else {
    await freshFlat(ctx, 'G6B H ExactBreach', 'exact');
    const d2 = await planDemo(ctx, { lava: true });
    const file2 = await snap(ctx, box, 'h-exact-breach');
    const r2 = await realiseWait(ctx, d2.p.planId);
    for (const b of d2.bodies) { const c = breachCell(b); if (c) await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`); }
    await sleep(Math.max(...d2.bodies.map((b) => b.settleTicks)) * 50 * 2 + 3000);
    const rm2 = await removeWait(ctx, r2.region);
    await sleep(3000);
    const df2 = await diff(ctx, box, file2);
    out.exactBreach = { state: rm2.state, seconds: rm2.seconds, mismatches: df2.mismatches, classes: df2.classes, sample: df2.sample };
    check(rm2.state === 'REMOVED' && df2.mismatches === 0, `item 6 (exactness, item 5's rule): the breached bodies' removal restores the box exactly: E-flat ${df2.mismatches}`, df2.sample);
    await L.leaveWorld();
  }
  // ---- (C) item 2's negative control: no_shell_cell realised with the containment check bypassed leaks; the census names the cell
  {
    await freshFlat(ctx, 'G6B H Leak', 'exact');
    const d = await planDemo(ctx, { variant: 'no_shell_cell' });
    const pond = d.bodies.find((b) => b.id === 'pond');
    const hole = (() => { const own = new Set(pond.cells.map(k3)); const sh = new Set(pond.shell.map(k3)); for (const c of pond.shell) void c; return pond.shell.find(([x, y, z]) => y === pond.level && x === Math.min(...pond.cells.map((q) => q[0])) - 1 && z === Math.round(pond.cells.reduce((a, q) => a + q[2], 0) / pond.cells.length) && own && sh); })();
    await L.call('dev.fluid.bypass', { on: true }, 10_000);
    const r = await realiseWait(ctx, d.p.planId);
    await L.call('dev.fluid.bypass', { on: false }, 10_000);
    const fp = (r.fluids ?? []).find((x) => x.body === 'pond');
    out.negative = { state: r.view.state, pond: fp, hole };
    check(r.view.state === 'PARTIAL' && fp?.state === 'drained' && /^escaped/.test(fp.reason ?? '') && (fp.at ?? []).some((c) => hole && c[0] === hole[0] && c[1] === hole[1] && c[2] === hole[2]), `item 2 (negative control): no_shell_cell with the check bypassed leaks in game within its settle bound: the census names the open rim cell ${json(hole)} (${r.view.state}; ${json(fp)})`);
    const c = await censusOf(ctx, pond);
    check([...c.fluids.values()].filter((s) => s.startsWith('minecraft:water')).length === 0, `item 2 (negative control): the escape guard drained it: 0 water in the pond's watch box (${c.fluids.size} fluid cells)`);
    await L.leaveWorld();
  }
  // ---- (D) item 3: the escape guard (predict_short) and the realise check (a protected area over a shell cell)
  {
    await freshFlat(ctx, 'G6B H Escape', 'exact');
    const d = await planDemo(ctx, { variant: 'predict_short' });
    const spout = d.bodies.find((b) => b.id === 'spout');
    const r = await realiseWait(ctx, d.p.planId);
    const fs1 = (r.fluids ?? []).find((x) => x.body === 'spout');
    out.escape = { state: r.view.state, spout: fs1 };
    check(r.view.state === 'PARTIAL' && fs1?.state === 'drained' && fs1.escaped === true && (fs1.at ?? []).length >= 1, `item 3: predict_short (a spill declared one cell short): the guard drains the spout, escaped names the cell ${json(fs1?.at)}, the region PARTIAL (${r.view.state})`);
    await L.gameWait(spout.settleTicks * 50 + 2000, { real: sleep, label: 'h item 3 the escape guard, the spout settles' });
    const c = await L.call('dev.fluid.census', { box: boxAround([...spout.cells, ...spout.spill], 1) }, 60_000);
    const water = c.fluids.filter(([x, y, z, s]) => s.startsWith('minecraft:water') && !(d.bodies.find((b) => b.id === 'spout_basin').cells.some((q) => q[0] === x && q[1] === y && q[2] === z)));
    out.escape.after = water.length;
    check(water.length === 0, `item 3: after a settle bound, 0 fluid in the spout's cells and spill (the basin's own water aside: ${water.length})`, water.slice(0, 8));
    await L.leaveWorld();
    await freshFlat(ctx, 'G6B H Uncontained', 'exact');
    const d2 = await planDemo(ctx, {});
    const pond = d2.bodies.find((b) => b.id === 'pond');
    const cell = breachCell(pond);
    await L.call('dev.fluid.beforeGate', { protect: [cell[0], cell[2], cell[0], cell[2]], owner: OWNER }, 10_000);
    const r2 = await realiseWait(ctx, d2.p.planId);
    const fp = (r2.fluids ?? []).find((x) => x.body === 'pond');
    const c2 = await censusOf(ctx, pond);
    out.uncontained = { state: r2.view.state, pond: fp, cell, water: c2.sources };
    check(r2.view.state === 'PARTIAL' && fp?.state === 'drained' && /^uncontained/.test(fp.reason ?? '') && (fp.at ?? []).some((c) => c[0] === cell[0] && c[2] === cell[2]), `item 3: a protected area added over one shell cell before the fluids stage: the pond is not written, PARTIAL naming it and the cell (${json(fp)})`);
    check(c2.sources === 0 && [...c2.fluids.values()].every((s) => !s.startsWith('minecraft:water')), `item 3: 0 fluid written for the uncontained pond (${c2.fluids.size} fluid cells in its watch box)`);
    await L.leaveWorld();
  }
  // ---- (E) the H batch's removal review (§4.1, §4.2): a player's water source in the pond's watch set after the realise is kept by the
  // removal (the drain takes only the body's own cells, spill, watch, predicted flow and recorded escapes), and fluid ticking for ever in
  // a watch set (a river's current, here fluid ticks scheduled ahead on the shell every 10 ticks) holds the removal at most 2 x the settle bound after the drain
  {
    await freshFlat(ctx, 'G6B H Keep', 'exact');
    const d = await planDemo(ctx, {});
    const pond = d.bodies.find((b) => b.id === 'pond');
    const r = await realiseWait(ctx, d.p.planId);
    check(r.view.state === 'PLACED' && (r.fluids ?? []).every((x) => x.state === 'settled'), `removal review: h_core_demo PLACED, settled (${r.view.state})`);
    const rim = [...pond.shell].sort((a, b) => b[0] - a[0] || b[1] - a[1] || a[2] - b[2])[0];
    const src = [rim[0] + 2, rim[1] + 1, rim[2]]; // in the watch set (the shell grown by 2), over the bank
    await L.cmd(`/setblock ${src[0]} ${src[1]} ${src[2]} minecraft:water`);
    await sleep(5000);
    const bound = Math.max(...d.bodies.map((b) => b.settleTicks));
    // fluid ticks scheduled ahead over the removal's whole window (the DevBridge serves dev.region.remove until the removal ends, so a
    // loop could not schedule them during it): one per shell cell (all in the watch set), every 10 ticks, past 4 x the bound + 10 s
    const horizon = 4 * bound + 200, cells = pond.shell.slice(0, Math.ceil(horizon / 10));
    for (let i = 0; i < cells.length; i++) await L.call('dev.fluid.tick', { cells: [cells[i]], delay: 10 * (i + 1) }, 10_000);
    const rm = await removeWait(ctx, r.region);
    const st = await L.call('dev.fluid.state', { region: r.region }, 10_000).catch((e) => ({ error: String(e.message ?? e) }));
    const c = await L.call('dev.fluid.census', { box: [src[0] - 1, src[1] - 1, src[2] - 1, src[0] + 1, src[1] + 1, src[2] + 1] }, 60_000);
    const at = c.fluids.find(([x, y, z]) => x === src[0] && y === src[1] && z === src[2]);
    out.keep = { src, bound, state: rm.state, seconds: rm.seconds, note: st, kept: at?.[3] ?? null };
    check(rm.state === 'REMOVED' && /2 x the settle bound/.test(st.removalNote ?? ''), `removal review (defect 1): fluid ticking in the watch set for ever, the removal ends REMOVED in ${rm.seconds} s (the cap: 2 x ${bound} ticks after the drain), its note in the record (${json(st)})`);
    check(!!at && /^minecraft:water/.test(at[3]) && !/level=[1-9]/.test(at[3]), `removal review (defect 2): the player's water source at ${json(src)} in the pond's watch set is kept by the removal (${json(at ?? null)})`);
    await L.leaveWorld();
  }
  // ---- (F) the H batch: the farm pond end to end in game. v49's plan (its only H is `farmPond: true`) through Regions.checkPlan: the
  // two-plan flow runs on the farm pond alone (PlanChecks.hasH), samples the ponds' volumes with their fluid layer, and the second plan
  // places both ponds
  {
    await freshFlat(ctx, 'G6B H FarmPond', 'exact');
    const fx = JSON.parse(fs.readFileSync(path.join(ctx.root, 'kit', 'test', 'fixtures', 'plan', 'valid', 'v49_farm_pond.json'), 'utf8'));
    const claim = [9200, 9000, 9439, 9159];
    const cx = (claim[0] + claim[2]) >> 1, cz = (claim[1] + claim[3]) >> 1;
    const anchors = { stone: [cx, 65, cz], player: [cx - 24, 65, cz - 24], stockpile: [cx + 12, 65, cz + 12], street_w: [claim[0] + 8, 65, cz], street_e: [claim[2] - 8, 65, cz] };
    await L.tp(cx, 120, cz);
    const c = await L.call('dev.region.checkPlan', { plan: fx.plan, claim, owner: OWNER, anchors, load: 'generate' }, 900_000);
    fs.writeFileSync(path.join(ctx.OUT, 'h-farmpond-check.json'), `${JSON.stringify(c, null, 1)}\n`);
    const farms = (c.check?.parts ?? []).find((a) => a.part === 'farms');
    const vp = c.volumePass ?? null;
    out.farmPond = { overall: c.check?.overall ?? null, volumePass: vp, farms: farms ? { class: farms.class, notes: (farms.notes ?? []).filter((n) => /farmPond/.test(n)) } : null };
    check(vp && vp.asked >= 2 && !vp.why && c.check?.overall === 'READY', `farm pond in game: v49 through Regions.checkPlan ran the two-plan flow on farmPond alone (${json(vp)}): ${c.check?.overall}`);
    check(farms?.class === 'fits' && (farms.notes ?? []).filter((n) => /farmPond: f\d gets a 3x3 pond/.test(n)).length === 2, `farm pond in game: both farm lots get their pond in the second plan (${json(out.farmPond.farms)})`);
    await L.leaveWorld();
  }
  log(`  ingame: ${json(Object.keys(out))}`);
  return out;
}

// ------------------------------------------------------------------ item 7: crashes

/**
 * Halt the server at a kill point (dev.journal.killAt), then open the world again: the headless host keeps the DevBridge and starts the
 * server again on the next dev.world.open (docs/GATES.md "Headless gates").
 */
export async function crashAt(ctx, world, point, action) {
  const L = ctx.L;
  await L.call('dev.journal.killAt', { point }, 10_000);
  action().catch(() => null); // the halt drops the call
  let down = false;
  for (let i = 0; i < 180 && !down; i++) {
    await sleep(2000);
    const s = await L.call('dev.state', {}, 10_000).catch(() => null);
    down = !!s && s.inWorld === false;
  }
  if (!down) throw new Error(`the kill point ${point} did not halt the server`);
  ctx.log(`  ${point}: the server halted; opening ${world} again`);
  await L.openWorld(world);
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
  return true;
}

/** Item 7: a crash before the fluids stage (FL1), one mid-stage (FL2: written, settling), one during removal (FL3: drained, before the solids). */
export async function crash(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  const world = 'G6B H Crash';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, 'h-crash');
  // FL1: the gate checked, the before states saved, no source written; the world saved at the halt (the shells stand, as item 7 says)
  let region = null;
  await crashAt(ctx, world, 'FL1+save', async () => { region = await L.realise(d.p.planId); });
  region ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
  let st = await L.waitRegion(region, 3_600_000);
  let fl = st.view.ext?.['architect_mc:fluids'] ?? [];
  out.fl1 = { state: st.view.state, fluids: fl };
  check(st.view.state === 'PLACED' && fl.length === 4 && fl.every((x) => x.state === 'settled'), `item 7 (FL1, after the shells, before any source): settle at start completes the realise: ${st.view.state}, every body settled (${json(fl.map((x) => [x.body, x.state]))})`);
  for (const b of d.bodies) { const c = await censusOf(ctx, b, null, d.bodies); check(c.outsideCount === 0 && c.mismatch.length === 0, `item 7 (FL1): body ${b.id}: the census equals the prediction, 0 fluid outside its declared cells (${c.mismatch.length}, ${c.outsideCount})`); }
  // FL3 during removal: drained (step 2), before the solids (step 3): the removal finishes after the restart, exact
  await crashAt(ctx, world, 'FL3', async () => { await L.call('dev.region.remove', { region, requester: OWNER }, 600_000); });
  const rm = await removeWait(ctx, region).catch((e) => ({ state: `error ${e.message}` }));
  await sleep(3000);
  let df = await diff(ctx, box, file);
  out.fl3 = { removal: rm.state, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
  check(rm.state === 'REMOVED' && df.mismatches === 0, `item 7 (FL3, a stop between the drain and the solids): settle at start finishes the removal: ${rm.state}, E-flat ${df.mismatches}`, df.sample);
  // FL2 mid-stage: the sources written and ticked, settling; then the removal, exact
  await L.leaveWorld();
  await freshFlat(ctx, `${world} 2`, 'exact');
  const d2 = await planDemo(ctx, { lava: true });
  const file2 = await snap(ctx, box, 'h-crash2');
  let region2 = null;
  await crashAt(ctx, `${world} 2`, 'FL2+save', async () => { region2 = await L.realise(d2.p.planId); });
  region2 ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
  st = await L.waitRegion(region2, 3_600_000);
  fl = st.view.ext?.['architect_mc:fluids'] ?? [];
  out.fl2 = { state: st.view.state, fluids: fl };
  check(st.view.state === 'PLACED' && fl.every((x) => x.state === 'settled'), `item 7 (FL2, mid-stage: written, settling): settle at start resumes the census and completes: ${st.view.state} (${json(fl.map((x) => [x.body, x.state]))})`);
  let outside = 0;
  for (const b of d2.bodies) outside += (await censusOf(ctx, b, null, d2.bodies)).outsideCount;
  check(outside === 0, `item 7 (FL2): 0 fluid outside the declared cells (${outside})`);
  const rm2 = await removeWait(ctx, region2);
  await sleep(3000);
  df = await diff(ctx, box, file2);
  out.fl2.removal = rm2.state;
  out.fl2.mismatches = df.mismatches;
  check(rm2.state === 'REMOVED' && df.mismatches === 0, `item 7 (FL2): the undo exact as item 5: E-flat ${df.mismatches}`, df.sample);
  await L.leaveWorld();
  // FL1 without the save: the halt loses the chunks written since the last save (the shells may be gone while the journal has them):
  // the resumed stage checks every body again, so a body is written settled or not written (uncontained), never into a lost shell
  await freshFlat(ctx, `${world} 3`, 'exact');
  const d3 = await planDemo(ctx, { lava: true });
  let region3 = null;
  await crashAt(ctx, `${world} 3`, 'FL1', async () => { region3 = await L.realise(d3.p.planId); });
  region3 ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
  st = await L.waitRegion(region3, 3_600_000);
  fl = st.view.ext?.['architect_mc:fluids'] ?? [];
  out.fl1Lost = { state: st.view.state, fluids: fl };
  check(fl.length === 4 && fl.every((x) => x.state === 'settled' || (x.state === 'drained' && /^uncontained/.test(x.reason ?? ''))), `item 7 (FL1, no save: the shells lost with the chunks): every body settled or not written, uncontained (${json(fl.map((x) => [x.body, x.state, (x.reason ?? '').split(':')[0]]))})`);
  let outside3 = 0;
  for (const b of d3.bodies) outside3 += (await censusOf(ctx, b, null, d3.bodies)).outsideCount;
  out.fl1Lost.outside = outside3;
  check(outside3 === 0, `item 7 (FL1, no save): 0 fluid outside the declared cells (${outside3})`);
  await removeWait(ctx, region3).catch(() => null);
  await L.leaveWorld();
  return out;
}

// ------------------------------------------------------------------ items 13, 14: the probes

/** Item 14 (a): the sand anomaly under water and dry; (b) T1's falling water (offline); item 13: the lava fire reach. */
export async function probe(ctx) {
  const { L, check, json, imp, root, log } = ctx;
  const out = {};
  // ---- (b) offline: relief_demo's committed inputs re-planned: no op carries a flowing state; which ops write water at all
  {
    const { planRegion } = await imp('lib/region/plan.mjs');
    const { lintFluidState } = await imp('lib/fluids/body.mjs');
    const gdir = path.join(root, 'scenarios', 'goldens', 'relief_demo');
    const ir0 = JSON.parse(fs.readFileSync(path.join(gdir, 'ir.json'), 'utf8'));
    const prog = await import(pathToFileURL(path.join(root, 'kit', 'regions', 'relief_demo.mjs')).href);
    const survey = fs.readFileSync(path.join(gdir, 'survey.bin'));
    const res = await planRegion({ program: prog, programSource: fs.readFileSync(path.join(root, 'kit', 'regions', 'relief_demo.mjs'), 'utf8'), params: ir0.params, survey, seed: ir0.seed, claim: ir0.claim, roles: ir0.roles, kitVersion: ir0.kitVersion, node: ir0.node });
    const water = [];
    for (const p of res.ir.parts) p.ops.forEach((o, i) => { const s = JSON.stringify(o.material ?? o.materials ?? o.fill ?? null); if (/minecraft:(water|lava)/.test(s)) water.push({ part: p.id, op: i, material: s.slice(0, 120) }); });
    out.t1 = { flowing: lintFluidState(res.ir), waterOps: water, irSha: res.irSha, goldenSha: JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 'goldens', 'relief_demo.json'), 'utf8')).irSha };
    check(out.t1.flowing.length === 0, `item 14 (b): relief_demo's committed inputs re-planned: FLUID_STATE 0 (no op carries a flowing state); ops naming water or lava: ${water.length} (${json(water)})`);
    log(`  item 14 (b): the level-8 cells came from no op (${water.length} ops name a fluid): vanilla flow into cells the plan cleared beside the stream, or dependents (recorded)`);
  }
  // ---- (a) the sand anomaly: a sand cell on a rewritten (solid -> solid) cell, dry and under natural water, re-read with its column's
  // journal entries (chore/housekeeping-2's TileCheck.keepsGravity); and sand on a cell rewritten to air under water: cleared as a
  // dependent, written back as a water source (§4.4), the undo exact
  {
    await freshFlat(ctx, 'G6B H Sand', 'exact');
    out.sand = { cases: {} };
    const brush = async (o) => L.call('dev.brush', { owner: OWNER, ...o }, 600_000);
    const stack = async (x, y, z) => (await L.call('dev.journal.at', { x, y, z }, 60_000));
    const state = async (x, y, z) => (await L.call('dev.fluid.census', { box: [x, y, z, x, y, z] }, 60_000)).fluids[0]?.[3] ?? null;
    const isSand = async (x, y, z) => { const r = await L.call('dev.box.hash', { min: [x, y, z], max: [x, y, z] }, 60_000); return r; };
    void isSand;
    // the dry case is gate step tile-gravity's (housekeeping-2, v0.36.1; H-core's impact rule runs it): here only under natural water
    for (const [tag, X, Z, wet] of [['wet', 40, 100, true]]) {
      const gy = await groundY(ctx, X, Z);
      await L.tp(X + 0.5, gy + 25, Z + 0.5);
      // wet: a pool walled on every side (still water: nothing flows while the box is snapped and compared)
      if (wet) { await L.cmd(`/fill ${X - 5} ${gy + 1} ${Z - 5} ${X + 5} ${gy + 3} ${Z + 5} minecraft:stone`); await L.cmd(`/fill ${X - 4} ${gy + 1} ${Z - 4} ${X + 4} ${gy + 3} ${Z + 4} minecraft:water`); }
      await L.cmd(`/setblock ${X} ${gy + 1} ${Z} minecraft:sand strict`);
      await L.settle(1500);
      const box = [X - 8, gy - 4, Z - 8, X + 8, gy + 8, Z + 8];
      const f = await snap(ctx, box, `h-sand-${tag}`);
      const v = await brush({ kind: 'overlay', shape: 'cylinder', at: [X, gy, Z], radius: 1, strength: 2, mask: { block: ['grass_block'] }, pattern: { mix: [{ w: 1, mat: 'stone' }] } });
      await L.settle(1500);
      const col = [];
      for (let y = gy - 1; y <= gy + 3; y++) col.push({ y, entry: (await stack(X, y, Z))?.stack?.at(-1) ?? null });
      const sandNow = await L.call('dev.region.dump', { box: [X, gy + 1, Z, X, gy + 1, Z], file: path.join(ctx.OUT, `h-sand-${tag}.arwd.gz`) }, 60_000).then(async () => {
        const { decodeArwd } = await imp('lib/region/vworld.mjs');
        const dd = await decodeArwd(fs.readFileSync(path.join(ctx.OUT, `h-sand-${tag}.arwd.gz`)));
        return dd.palette[dd.cells[dd.at(X, gy + 1, Z)]];
      });
      if (v.region) await L.call('dev.region.remove', { region: v.region, requester: OWNER }, 600_000);
      await sleep(3000);
      const df = await diff(ctx, box, f);
      out.sand.cases[tag] = { gy, stroke: { state: v.state, cells: v.cellsWritten, skipped: v.cellsSkipped }, sandNow, column: col, diff: df };
      const entries = json(col.map((c) => [c.y, c.entry ? `${c.entry.before}->${c.entry.after}` : null]));
      if (!wet) check(v.state === 'PLACED' && sandNow === 'minecraft:sand' && (v.cellsSkipped?.gravityKept ?? 0) >= 1, `item 14 (a, dry): a sand cell on a rewritten solid support stays sand (${sandNow}; gravityKept ${v.cellsSkipped?.gravityKept ?? 0}; the column's entries ${entries})`);
      // a brush never takes a water column (brush.mjs: the column is not water, lava or missing), so no stroke rewrites a support under
      // natural water: the sand there is never a dependent of one (recorded; TileCheck's gravity rule runs before the under-water one)
      else check(sandNow === 'minecraft:sand' && col.every((c) => !c.entry), `item 14 (a, wet): under natural water the stroke leaves the column alone: the sand stays, no entry in its column (${sandNow}; ${v.state}, ${v.cellsWritten ?? 0} cells; ${entries})`);
      check(df.mismatches === 0, `item 14 (a, ${tag}): the undo restores the box exactly (${df.mismatches})`, df.sample);
      void state;
    }
    await L.leaveWorld();
  }
  // ---- item 13: the fire reach: a 3x3 lava pool, flammable posts at distances 1-4 sideways and heights -1..3, random ticks 300, fire on
  if (P3.smoke) P3.skipped(log, 'item 13: the lava fire reach probe (posts 1-4, random ticks 300, 2 minutes)', 'p3-probe-water at release (the calibration of M20; the water lint runs M20 on every lava body)');
  else {
    await freshFlat(ctx, 'G6B H Fire', 'default');
    const gy = await groundY(ctx, 200, 200);
    const X = 200, Z = 200;
    await L.tp(X + 0.5, gy + 6, Z - 6.5);
    await L.cmd(`/fill ${X - 1} ${gy} ${Z - 1} ${X + 1} ${gy} ${Z + 1} minecraft:lava`);
    // posts of oak planks: one per (distance, dy) on the four sides, separated so fire on one post can't spread to the next quickly
    const posts = [];
    for (let dist = 1; dist <= 4; dist++) for (const dy of [-1, 0, 1, 2, 3]) {
      for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = X + sx * (1 + dist) + (sz !== 0 ? (dy + 1) * 3 - 6 : 0), z = Z + sz * (1 + dist) + (sx !== 0 ? (dy + 1) * 3 - 6 : 0);
        posts.push({ dist, dy, x, y: gy + dy, z });
      }
    }
    for (const p of posts) await L.cmd(`/setblock ${p.x} ${p.y} ${p.z} minecraft:oak_planks`);
    // the gate's base turns fire off (fire_spread_radius_around_player 0): lava ignites nothing then; -1: fire spreads anywhere
    await L.cmd('/gamerule fire_spread_radius_around_player -1');
    await L.cmd('/gamerule random_tick_speed 300');
    const rules = [];
    for (const r of ['fire_spread_radius_around_player', 'random_tick_speed']) rules.push((await L.cmd(`/gamerule ${r}`))?.messages ?? null);
    // sampled every 5 s for 2 minutes: a post lit by the lava is one that burns while no fire and no burnt post was within 2 cells of it at
    // the sample before (posts on one ray stand side by side, and a burning post sets its neighbour alight: that is fire's spread, not
    // the lava's reach)
    const { decodeArwd } = await imp('lib/region/vworld.mjs');
    const dumpBox = [X - 8, gy - 2, Z - 8, X + 8, gy + 5, Z + 8];
    const sample = async (i) => {
      const f = path.join(ctx.OUT, `h-fire-${i}.arwd.gz`);
      await L.call('dev.region.dump', { box: dumpBox, file: f }, 60_000);
      const dd = await decodeArwd(fs.readFileSync(f));
      fs.rmSync(f);
      const fire = [];
      for (let x = dumpBox[0]; x <= dumpBox[3]; x++) for (let y = dumpBox[1]; y <= dumpBox[4]; y++) for (let z = dumpBox[2]; z <= dumpBox[5]; z++) if (/^minecraft:(soul_)?fire/.test(dd.palette[dd.cells[dd.at(x, y, z)]])) fire.push([x, y, z]);
      return { fire, gone: new Set(posts.filter((p) => dd.palette[dd.cells[dd.at(p.x, p.y, p.z)]] !== 'minecraft:oak_planks').map((p) => k3([p.x, p.y, p.z]))) };
    };
    const near = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= 2;
    let prev = { fire: [], gone: new Set() };
    const direct = [], spread = [];
    for (let i = 0; i < 24; i++) {
      // (speed audit B) 5 s of game time: 100 ticks sprinted on a headless host (GATE_SPRINT=0 / a client: the original sleep(5000))
      await L.gameWait(5000, { real: sleep, label: i === 0 ? 'h-probe lava sample (x24)' : `h-probe lava sample ${i}` });
      const cur = await sample(i);
      for (const p of posts) {
        const k = k3([p.x, p.y, p.z]);
        if (!cur.gone.has(k) || prev.gone.has(k)) continue;
        const c = [p.x, p.y, p.z];
        const byFire = prev.fire.some((f) => near(f, c) && !near([X, gy, Z], f) && Math.max(Math.abs(f[0] - X), Math.abs(f[2] - Z)) > 3) || posts.some((q) => q !== p && prev.gone.has(k3([q.x, q.y, q.z])) && near([q.x, q.y, q.z], c));
        (byFire ? spread : direct).push(p);
      }
      prev = cur;
    }
    await L.cmd('/gamerule random_tick_speed 3');
    await L.cmd('/gamerule fire_spread_radius_around_player 0');
    // Chebyshev sideways from the nearest lava cell (the pool spans X-1..X+1): a post at X + 1 + dist is dist away
    const reachOf = (list) => list.reduce((a, p) => ({ side: Math.max(a.side, p.dist), above: Math.max(a.above, p.dy), below: Math.min(a.below, p.dy) }), { side: 0, above: -9, below: 9 });
    const farthest = reachOf(direct);
    out.fire = { rules, posts: posts.length, direct: direct.length, spread: spread.length, farthest, all: reachOf([...direct, ...spread]), list: direct.slice(0, 30).map((p) => [p.dist, p.dy]) };
    const { FIRE_REACH } = await imp('lib/region/checkFluids.mjs');
    check(direct.length > 0, `item 13 (the probe's control): the lava lit at least one post itself (${direct.length} by the lava, ${spread.length} by spreading fire; rules ${json(rules)})`);
    check(farthest.side <= FIRE_REACH.side && farthest.above <= FIRE_REACH.above && (direct.length === 0 || farthest.below >= -FIRE_REACH.below), `item 13 (the probe): a lava pool with random ticks at 300 for 2 minutes lit ${direct.length} of ${posts.length} flammable posts itself (${spread.length} more by spreading fire, recorded); the farthest at ${farthest.side} sideways (Chebyshev from the nearest lava cell), ${farthest.below}..${farthest.above} in height; M20's reach ${json(FIRE_REACH)} covers it (vanilla's LavaFluid.randomTick: fire at most 2 up and 2 aside, the block it lights one more)`, direct.slice(0, 10));
    await L.leaveWorld();
  }
  return out;
}

/** The flat world's surface y at (x, z) (its plan survey's ground). */
/** The ground's y at (x, z): the survey reads loaded chunks only, so the player stands over the column first. */
async function groundY(ctx, x, z) {
  await ctx.L.tp(x + 0.5, 120, z + 0.5);
  await ctx.L.settle(2000);
  const f = path.join(ctx.OUT, `survey-${x}-${z}.bin`);
  await ctx.L.call('dev.region.survey', { claim: [x - 1, z - 1, x + 1, z + 1], surveyLoad: 'loaded', file: f }, 300_000);
  const { decodeColumns } = await ctx.imp('lib/region/pack.mjs');
  const c = decodeColumns(fs.readFileSync(f));
  const gy = c.ground[1 + 3 * 1];
  if (!(gy > -64 && gy !== 0)) throw new Error(`no ground found at ${x}, ${z} (${gy}): the chunk is not loaded`);
  return gy;
}

// ------------------------------------------------------------------ (slice DF, rule 3) a fluids record that is not durable

/** The fluid sources standing in the bodies' own cells (every body's census summed). */
async function sourcesIn(ctx, bodies) {
  let n = 0;
  for (const b of bodies) n += (await censusOf(ctx, b, null, bodies)).sources;
  return n;
}

/**
 * (slice DF, CONTRACT 8c §4.4) fluids.json on DurableFile: a refused save of it stops the stage before any source. (a) the save refused
 * (dev.region.failNextSave sticky): for 20 s the stage waits SITE_BUSY ("the fluids record is not durable"), 0 sources in the bodies'
 * cells, no fluids.json on disk; on main the stage went on and wrote the sources (the failing-first case). Then the failure is lifted:
 * the record saved, every body settled, the census equal, Regions.remove E-flat 0. (b) the halt at FL1r (the refused save, nothing
 * written), bare and +save: the start takes the stage again from the gate; settled or (bare: the shells lost) not written; 0 fluid
 * outside; the undo exact (+save: the removal halted at FL3d+save, its draining record durable, then resumed).
 */
export async function df(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H DF';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, 'h-df');
  await L.call('dev.region.failNextSave', { file: 'fluids.json', sticky: true }, 10_000);
  let region = null;
  try {
    region = await L.realise(d.p.planId);
    // until the fluids gate ran (the stage checked or waiting on the record): the sources and the record read every 2 s
    const polls = [];
    let owedSince = null, wrote = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 900_000) {
      const fs0 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
      const n = await sourcesIn(ctx, d.bodies);
      polls.push({ t: Math.round((Date.now() - t0) / 1000), phase: fs0?.phase, owed: fs0?.owed ?? null, sources: n });
      if (n > 0) { wrote = n; break; }
      if (fs0?.owed) owedSince ??= Date.now();
      if (owedSince && Date.now() - owedSince >= 20_000) break;
      await sleep(2000);
    }
    const st = await L.call('dev.region.state', { region }, 60_000);
    const rec = path.join(L.SAVES, world, 'architect-regions', region, 'fluids.json');
    const onDisk = fs.existsSync(rec);
    const waits = JSON.stringify(st.items ?? {}) + JSON.stringify(st.view?.stages ?? []);
    out.refused = { wrote, onDisk, polls: polls.slice(-6), last: polls.at(-1), state: st.view?.state };
    log(`  DF (a): ${json(out.refused.last)}, fluids.json on disk ${onDisk}`);
    check(wrote === 0 && !!owedSince && out.refused.last?.phase === 'gate' && !onDisk, `DF (a): fluids.json's save refused: the stage waits (${out.refused.last?.owed ?? 'no owed record'}), phase ${out.refused.last?.phase}, ${wrote} source(s) written in the bodies' cells (0 wanted; main writes them), fluids.json on disk: ${onDisk}`, { polls: out.refused.polls, waits: waits.slice(0, 400) });
  } finally {
    await L.call('dev.region.failNextSave', { off: true }, 10_000).catch(() => null);
  }
  region ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
  let st = await L.waitRegion(region, 3_600_000);
  let fl = st.view.ext?.['architect_mc:fluids'] ?? [];
  out.lifted = { state: st.view.state, fluids: fl.map((x) => [x.body, x.state]) };
  check(st.view.state === 'PLACED' && fl.length === 4 && fl.every((x) => x.state === 'settled'), `DF (a): the failure lifted, the record saved and the stage written: ${st.view.state}, every body settled (${json(out.lifted.fluids)})`);
  let mism = 0, outside = 0;
  for (const b of d.bodies) { const c = await censusOf(ctx, b, null, d.bodies); mism += c.mismatch.length; outside += c.outsideCount; }
  check(mism === 0 && outside === 0, `DF (a): every census equals its prediction, 0 fluid outside the declared cells (${mism}, ${outside})`);
  const rm = await removeWait(ctx, region);
  await sleep(3000);
  const df0 = await diff(ctx, box, file);
  out.lifted.removal = rm.state; out.lifted.mismatches = df0.mismatches;
  check(rm.state === 'REMOVED' && df0.mismatches === 0, `DF (a): Regions.remove exact: ${rm.state}, E-flat ${df0.mismatches}`, df0.sample);
  await L.leaveWorld();
  // (b) the halt at FL1r, +save and bare: the refusal is lost with the JVM (the hook too), the start takes the stage from the gate
  for (const [tag, point] of [['fl1r-save', 'FL1r+save'], ['fl1r', 'FL1r']]) {
    const w = `${world} ${tag}`;
    await freshFlat(ctx, w, 'exact');
    const dd = await planDemo(ctx, { lava: true });
    const f = await snap(ctx, box, `h-df-${tag}`);
    await L.call('dev.region.failNextSave', { file: 'fluids.json', sticky: true }, 10_000);
    let r = null;
    await crashAt(ctx, w, point, async () => { r = await L.realise(dd.p.planId); });
    await L.call('dev.region.failNextSave', { off: true }, 10_000).catch(() => null);
    r ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
    st = await L.waitRegion(r, 3_600_000);
    fl = st.view.ext?.['architect_mc:fluids'] ?? [];
    const bare = !point.endsWith('+save');
    out[tag] = { state: st.view.state, fluids: fl.map((x) => [x.body, x.state, (x.reason ?? '').split(':')[0]]) };
    check(fl.length === 4 && fl.every((x) => x.state === 'settled' || (bare && x.state === 'drained' && /^uncontained/.test(x.reason ?? ''))) && (bare || st.view.state === 'PLACED'), `DF (b, ${point}: the record refused, nothing written, halted): the start takes the stage from its gate: ${st.view.state}, ${bare ? 'every body settled or not written (uncontained)' : 'every body settled'} (${json(out[tag].fluids)})`);
    let o = 0;
    for (const b of dd.bodies) o += (await censusOf(ctx, b, null, dd.bodies)).outsideCount;
    check(o === 0, `DF (b, ${point}): 0 fluid outside the declared cells (${o})`);
    // (+save) the removal halted at FL3d+save: its draining record durable, nothing drained; the start drains it again from the start
    if (!bare) await crashAt(ctx, w, 'FL3d+save', async () => { await L.call('dev.region.remove', { region: r, requester: OWNER }, 600_000); });
    const rr = await removeWait(ctx, r).catch((e) => ({ state: `error ${e.message}` }));
    await sleep(3000);
    const dx = await diff(ctx, box, f);
    out[tag].removal = rr.state; out[tag].mismatches = dx.mismatches;
    check(rr.state === 'REMOVED' && (bare || dx.mismatches === 0), `DF (b, ${point}${bare ? '' : ', then the removal halted at FL3d+save and resumed'}): Regions.remove: ${rr.state}${bare ? ` (E-flat ${dx.mismatches}, recorded: the bare halt loses the shells' chunks)` : `, E-flat ${dx.mismatches}`}`, dx.sample);
    await L.leaveWorld();
  }
  // (c, slice DF round 2, the review's P1 2) a removal halted bare at FL3x (its done record saved, the solids not restored yet): the drain's
  // writes are on disk before done is (T0's chunk barrier), so the start's solids never stand round surviving sources: E-flat 0
  {
    const w = `${world} fl3x`;
    await freshFlat(ctx, w, 'exact');
    const dd = await planDemo(ctx, { lava: true });
    const f = await snap(ctx, box, 'h-df-fl3x');
    const r = await L.realise(dd.p.planId);
    const st0 = await L.waitRegion(r, 3_600_000);
    await crashAt(ctx, w, 'FL3x', async () => { await L.call('dev.region.remove', { region: r, requester: OWNER }, 600_000); });
    const rr = await removeWait(ctx, r).catch((e) => ({ state: `error ${e.message}` }));
    await sleep(3000);
    const dx = await diff(ctx, box, f);
    out.fl3x = { placed: st0.view.state, removal: rr.state, mismatches: dx.mismatches, classes: dx.classes };
    check(st0.view.state === 'PLACED' && rr.state === 'REMOVED' && dx.mismatches === 0, `DF (c, FL3x bare: the done record saved, the world not): the removal resumed: ${rr.state}, E-flat ${dx.mismatches} (no fluid left round the restored solids)`, dx.sample);
    await L.leaveWorld();
  }
  return out;
}

// ------------------------------------------------------------------ (slice 8cTa, failing first) the DF final review's C, E and F

/** Waits until the server halted (an armed kill point), at most 6 min. */
async function waitDownH(ctx, point) {
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    const s = await ctx.L.call('dev.state', {}, 10_000).catch(() => null);
    if (s && s.inWorld === false) return true;
  }
  throw new Error(`the kill point ${point} did not halt the server`);
}

/**
 * (8cT row C, the DF final review's P1 C) h_core_demo placed; a source of a body's fluid set in one of its predicted flowing cells (as a
 * dispenser places one: no Placed record), in no other body's cells, spill or watch; then Regions.remove. Conservation: the dispensed
 * source (one bucket) still stands after the removal (red on a6b14ace: the stray pass takes every predicted cell holding the body's
 * fluid at any level, so the bucket is erased).
 */
export async function t8c(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T8C';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const r = await realiseWait(ctx, d.p.planId);
  const own = new Set(d.bodies.flatMap((b) => [...b.cells, ...b.ice].map(k3)));
  let pick = null;
  for (const b of [...d.bodies].sort((a, c) => c.predicted.length - a.predicted.length)) {
    const others = new Set(d.bodies.filter((o) => o !== b).flatMap((o) => [...o.cells, ...o.ice, ...o.predicted, ...o.spill, ...o.watch, ...o.shell].map(k3)));
    const at = b.predicted.find((p) => p[3] > 0 && !own.has(k3(p)) && !others.has(k3(p)));
    if (at) { pick = { body: b, at }; break; }
  }
  out.placed = { state: r.view.state, pick: pick ? { body: pick.body.id, at: pick.at, fluid: pick.body.fluid } : null };
  check(r.view.state === 'PLACED' && !!pick, `C: h_core_demo placed (${r.view.state}) and a predicted flowing cell to dispense into (${json(out.placed.pick)})`);
  if (!pick) { await L.leaveWorld(); return out; }
  const [x, y, z] = pick.at;
  const kind = pick.body.fluid === 'lava' ? 'minecraft:lava' : 'minecraft:water';
  await L.cmd(`/setblock ${x} ${y} ${z} ${kind}`);
  await sleep(4000);
  const at = async () => (await L.call('dev.fluid.census', { box: [x, y, z, x, y, z] }, 60_000)).fluids.find(([a, b, c]) => a === x && b === y && c === z)?.[3] ?? 'none';
  const before = await at();
  // the cell read while the fluids drain and its settle wait run (the record drained, the solids not restored yet): that is the drain's
  // own judgement (the stray pass), apart from the group undo that follows
  const rmP = L.call('dev.region.remove', { region: r.region, requester: OWNER }, 3_600_000).catch((e) => ({ error: String(e.message ?? e) }));
  const during = [];
  for (let i = 0; i < 600; i++) {
    const fs0 = await L.call('dev.fluid.state', { region: r.region }, 10_000).catch(() => null);
    if (fs0?.removal === 'drained') during.push(await at());
    else if (during.length || !fs0 || fs0.removed || fs0.removal === 'done') break;
    await sleep(200);
  }
  await rmP;
  const rm = await removeWait(ctx, r.region).catch((e) => ({ state: `error ${e.message}` }));
  await sleep(3000);
  const after = await at();
  out.removed = { state: rm.state, before, during: [...new Set(during)], reads: during.length, after };
  log(`  C: ${json(out.removed)}`);
  const src = (s) => s === kind || s === `${kind}[level=0]`;
  check(src(before) && during.length > 0 && during.every(src), `C conservation (the drain's stray and spill passes): the dispensed ${pick.body.fluid} source at ${x},${y},${z} (a bucket; in ${pick.body.id}'s predicted flow at level ${pick.at[3]}) before the removal ${before}, through the drain's settle wait ${json(out.removed.during)} (${during.length} read(s); a source wanted: the bucket stands)`);
  check(true, `(recorded) C: after the group undo the cell reads ${after} (${rm.state}); a cell a stage cleared is restored by its journal entry (StillOurs 6a: fluid in a cleared cell is the entry's), outside 8cT's scope`);
  await L.leaveWorld();
  return out;
}

/**
 * (8cT row E, the DF final review's P1 E) h_core_demo with its census held (dev.fluid.hold settle): every body written and forced; a
 * water body's deepest side shell cell opened, its water out for 5 s, then the chunks saved (dev.stockpile.save); the census released
 * with FLe armed (bare): the escape drain records the body drained and the JVM halts before its writes are saved. Conservation at the
 * start: a body the record calls drained holds 0 sources and 0 fluid runs outside (red on a6b14ace: no barrier and no replay, the
 * sources and the escaped flow come back with the chunks and nothing drains them).
 */
export async function t8e(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T8E';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  await L.call('dev.fluid.hold', { settle: true }, 10_000);
  let region = null;
  try {
    region = await L.realise(d.p.planId);
    let fs0 = null;
    for (let i = 0; i < 450; i++) {
      fs0 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
      if (fs0?.phase === 'settling' && (fs0.bodies ?? []).every((b) => b.state !== 'pending')) break;
      await sleep(2000);
    }
    const b = d.bodies.find((x) => x.fluid === 'water' && breachCell(x) && (fs0?.bodies ?? []).find((y) => y.id === x.id)?.state === 'written');
    out.written = { phase: fs0?.phase, bodies: (fs0?.bodies ?? []).map((x) => [x.id, x.state]), body: b?.id ?? null };
    check(fs0?.phase === 'settling' && !!b, `E: the bodies written and forced, the census held (${json(out.written)})`);
    if (!b) return out;
    const c = breachCell(b);
    await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
    await sleep(5000);
    await L.call('dev.stockpile.save', {}, 300_000);
    const pre = await censusOf(ctx, b, null, d.bodies);
    await L.call('dev.journal.killAt', { point: 'FLe' }, 10_000);
    await L.call('dev.fluid.hold', { settle: false }, 10_000);
    await waitDownH(ctx, 'FLe');
    await L.openWorld(world);
    await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
    await sleep(10_000);
    const fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
    const post = await censusOf(ctx, b, null, d.bodies);
    const state = (fs1?.bodies ?? []).find((y) => y.id === b.id)?.state ?? null;
    out.restarted = { breach: c, saved: { sources: pre.sources, outside: pre.outsideCount }, state, sources: post.sources, outside: post.outsideCount };
    log(`  E: ${json(out.restarted)}`);
    check(pre.sources > 0 && pre.outsideCount > 0, `E: the precondition: on disk before the escape, ${pre.sources} source(s) and ${pre.outsideCount} escaped fluid cell(s)`);
    check(state === 'drained' && post.sources === 0 && post.outsideCount === 0, `E conservation (FLe bare: the escape drain's record saved, its writes not): ${b.id} reads ${state}; the start leaves ${post.sources} source(s) in its cells and ${post.outsideCount} fluid cell(s) outside (0 and 0 wanted: the drain replayed)`);
  } finally {
    await L.call('dev.fluid.hold', { settle: false }, 10_000).catch(() => null);
  }
  await L.leaveWorld().catch(() => null);
  return out;
}

/**
 * (8cT row F, the DF final review's P2 F) h_core_demo placed, removed, halted at FL3x+save (its done record saved, the solids not
 * restored); the record's `barrierDone` stripped offline (a done written before round 3); the start: the removal re-drains, then must wait
 * a fresh settle bound before the solids. Judged in game ticks: from the halt (the last game time read before it) to REMOVED at least the
 * largest body's settle bound (red on a6b14ace: until -1, no wait). Conservation: E-flat 0 after the removal.
 */
export async function t8f(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T8F';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, 'h-t8f');
  const r = await realiseWait(ctx, d.p.planId);
  const bound = Math.max(...d.bodies.map((b) => b.settleTicks ?? 0));
  const gt = async () => (await L.call('dev.ticks.pending', {}, 30_000)).gameTime;
  await L.call('dev.journal.killAt', { point: 'FL3x+save' }, 10_000);
  L.call('dev.region.remove', { region: r.region, requester: OWNER }, 600_000).catch(() => null);
  let gHalt = null;
  for (let i = 0; i < 900; i++) {
    const g = await gt().catch(() => null);
    if (g == null) { const s = await L.call('dev.state', {}, 10_000).catch(() => null); if (s && s.inWorld === false) break; } else gHalt = g;
    await sleep(250);
  }
  const rec = path.join(L.SAVES, world, 'architect-regions', r.region, 'fluids.json');
  const j = JSON.parse(fs.readFileSync(rec, 'utf8'));
  out.halted = { gHalt, removal: j.removal, barrierDone: j.barrierDone ?? null, bound };
  delete j.barrierDone;
  fs.writeFileSync(rec, JSON.stringify(j));
  await L.openWorld(world);
  let g1 = null, st = null;
  for (let i = 0; i < 4800; i++) {
    st = await L.call('dev.region.state', { region: r.region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED' || s === 'PARTIAL' || s === 'FAILED') { g1 = await gt().catch(() => null); break; }
    await sleep(250);
  }
  await sleep(3000);
  const dx = await diff(ctx, box, file);
  // the record the removal finished with (kept on disk after REMOVED): the settle bound it waited, written after the start's re-drain
  const fin = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : {};
  out.resumed = { g1, elapsed: g1 != null && gHalt != null ? g1 - gHalt : null, state: st?.view?.state ?? 'REMOVED', mismatches: dx.mismatches, final: { removal: fin.removal ?? null, until: fin.until ?? null } };
  log(`  F: ${json(out)}`);
  check(out.halted.removal === 'done' && out.halted.barrierDone === true && gHalt != null, `F: the precondition: halted at FL3x+save with done and barrierDone on disk (${json(out.halted)}), barrierDone stripped`);
  check(fin.removal === 'done' && typeof fin.until === 'number' && fin.until >= gHalt + bound, `F: the re-drained removal waits a fresh settle bound before the solids: its done record's wait ended at tick ${fin.until} (at least the halt ${gHalt} + the bound ${bound} wanted: a bound started after the start's re-drain; -1: no wait); ${out.resumed.elapsed} tick(s) from the halt to the end (recorded: the world's open is inside it)`);
  check(dx.mismatches === 0, `F conservation: Regions.remove resumed: E-flat ${dx.mismatches}`, dx.sample);
  await L.leaveWorld();
  return out;
}

/**
 * (8cTb, E's removal half and Steward's S3 drain row) h_core_demo placed, its chunks saved; Regions.remove halted at the drain txn's
 * `TX:fluid.drain:drain` (the drain written, no receipt yet), bare (the writes lost with the JVM) and +save (the writes on disk without
 * their receipts). The start replays the drain from the txn (never trusts a record without its writes): the removal resumes and the box is
 * E-flat 0 (conservation: no fluid left round the restored solids, nothing else changed).
 */
export async function t8rd(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  for (const point of ['TX:fluid.drain:drain', 'TX:fluid.drain:drain+save']) {
    const tag = point.endsWith('+save') ? 'save' : 'bare';
    const world = `G6B H T8RD ${tag}`;
    await freshFlat(ctx, world, 'exact');
    const d = await planDemo(ctx, { lava: true });
    const box = demoBox(d.bodies);
    const file = await snap(ctx, box, `h-t8rd-${tag}`);
    const r = await realiseWait(ctx, d.p.planId);
    await L.call('dev.stockpile.save', {}, 300_000);
    await crashAt(ctx, world, point, async () => { await L.call('dev.region.remove', { region: r.region, requester: OWNER }, 600_000); });
    const fs1 = await L.call('dev.fluid.state', { region: r.region }, 10_000).catch(() => null);
    const rm = await removeWait(ctx, r.region).catch((e) => ({ state: `error ${e.message}` }));
    await sleep(3000);
    const dx = await diff(ctx, box, file);
    out[tag] = { placed: r.view.state, atStart: fs1 ? { removal: fs1.removal ?? null, until: fs1.until ?? null } : null, removal: rm.state, mismatches: dx.mismatches };
    check(r.view.state === 'PLACED' && rm.state === 'REMOVED' && dx.mismatches === 0, `RD (${point}: the drain written, no receipt): the start replays the drain txn; the removal resumed: ${rm.state}, E-flat ${dx.mismatches} (${json(out[tag].atStart)})`, dx.sample);
    await L.leaveWorld();
  }
  return out;
}

/**
 * (8cTc, Steward's S3 write row) h_core_demo realised and halted at the write txn's `TX:fluid.write:place`, +save (the bodies written,
 * their receipts not) and bare: the start replays the write from the txn: PLACED, every body settled, every census equal, 0 fluid
 * outside; Regions.remove E-flat 0 (conservation).
 */
export async function t8wr(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  for (const point of ['TX:fluid.write:place+save', 'TX:fluid.write:place']) {
    const tag = point.endsWith('+save') ? 'save' : 'bare';
    const world = `G6B H T8WR ${tag}`;
    await freshFlat(ctx, world, 'exact');
    const d = await planDemo(ctx, { lava: true });
    const box = demoBox(d.bodies);
    const file = await snap(ctx, box, `h-t8wr-${tag}`);
    let r = null;
    await crashAt(ctx, world, point, async () => { r = await L.realise(d.p.planId); });
    r ??= (await L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
    const st = await L.waitRegion(r, 3_600_000);
    const fl = st.view.ext?.['architect_mc:fluids'] ?? [];
    let mism = 0, outside = 0;
    for (const b of d.bodies) { const c = await censusOf(ctx, b, null, d.bodies); mism += c.mismatch.length; outside += c.outsideCount; }
    const rm = await removeWait(ctx, r).catch((e) => ({ state: `error ${e.message}` }));
    await sleep(3000);
    const dx = await diff(ctx, box, file);
    out[tag] = { state: st.view.state, fluids: fl.map((x) => [x.body, x.state]), mism, outside, removal: rm.state, mismatches: dx.mismatches };
    const bare = tag === 'bare';
    check((bare || st.view.state === 'PLACED') && fl.length === 4 && fl.every((x) => x.state === 'settled' || (bare && x.state === 'drained')) && mism === 0 && outside === 0, `WR (${point}): the start replays the write txn: ${st.view.state}, bodies ${json(out[tag].fluids)}, census mismatches ${mism}, fluid outside ${outside}`);
    check(rm.state === 'REMOVED' && (bare || dx.mismatches === 0), `WR (${point}) conservation: Regions.remove: ${rm.state}, E-flat ${dx.mismatches}${bare ? ' (recorded: a bare halt may lose the earlier stages chunks)' : ''}`, dx.sample);
    await L.leaveWorld();
  }
  return out;
}

/**
 * (8cTb review P2-7, receipt-present recovery) h_core_demo removed and halted at `TX:fluid.drain:apply:0+save`: the drain's writes and its
 * receipts on disk, the record not (still its old deadline). The start finds the W effect applied and records drained: the wait must be a
 * fresh bound from the start (the done record's until at least the halt + the bound), and the removal exact (E-flat 0).
 */
export async function t8rr(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  const world = 'G6B H T8RR';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, 'h-t8rr');
  const r = await realiseWait(ctx, d.p.planId);
  const bound = Math.max(...d.bodies.map((b) => b.settleTicks ?? 0));
  const gt = async () => (await L.call('dev.ticks.pending', {}, 30_000)).gameTime;
  const gHalt = await gt();
  await crashAt(ctx, world, 'TX:fluid.drain:apply:0+save', async () => { await L.call('dev.region.remove', { region: r.region, requester: OWNER }, 600_000); });
  const rm = await removeWait(ctx, r.region).catch((e) => ({ state: `error ${e.message}` }));
  await sleep(3000);
  const dx = await diff(ctx, box, file);
  const rec = path.join(L.SAVES, world, 'architect-regions', r.region, 'fluids.json');
  const fin = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : {};
  out.removed = { gHalt, bound, removal: rm.state, final: { removal: fin.removal ?? null, until: fin.until ?? null }, mismatches: dx.mismatches };
  check(fin.removal === 'done' && typeof fin.until === 'number' && fin.until >= gHalt + bound, `RR (TX:fluid.drain:apply:0+save: the receipts on disk, the record not): the wait after the start is a fresh bound: until ${fin.until} (at least ${gHalt} + ${bound} wanted; ${json(out.removed.final)})`);
  check(rm.state === 'REMOVED' && dx.mismatches === 0, `RR conservation: Regions.remove resumed: ${rm.state}, E-flat ${dx.mismatches}`, dx.sample);
  await L.leaveWorld();
  return out;
}

// ------------------------------------------------------------------ (8cT last round) failing-first rows, red on e29d8783

/** A body's own-cell sources standing now. */
async function ownSources(ctx, b) {
  const c = await censusOf(ctx, b, null, []);
  return c.sources;
}

/**
 * (8cT last round #4) The recheck after a stop: h_core_demo's tiles written (the forced tick held), the pond's side shell cell opened and
 * the chunks saved, a halt; the start rechecks the pond (uncontained) and drains it; the moment its record reads drained, a bare halt
 * (dev.stockpile.halt now). The next start: no source stands in a body its record calls drained (red on e29d8783: the recheck drained in
 * memory and saved the record, no txn, no barrier: the sources come back beside the drained record).
 */
export async function t9rc(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T9RC';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const pond = d.bodies.find((b) => b.id === 'pond');
  await L.call('dev.fluid.hold', { write: true }, 10_000);
  let region = null;
  try {
    region = await L.realise(d.p.planId);
    for (let i = 0; i < 300; i++) { const n = await ownSources(ctx, pond); if (n >= pond.cells.length) break; await sleep(2000); }
    const c = breachCell(pond);
    await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
    await sleep(1000);
    await L.call('dev.stockpile.save', {}, 300_000);
    out.pre = { sources: await ownSources(ctx, pond), breach: c };
    L.call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    await waitDownH(ctx, 'halt');
    await L.openWorld(world);
    await L.cmd('/save-off'); // (no chunk save after the recheck's drain: the halt finds what a crash finds)
    let drained = false;
    for (let i = 0; i < 600 && !drained; i++) {
      const fs0 = await L.call('dev.fluid.state', { region }, 5_000).catch(() => null);
      drained = (fs0?.bodies ?? []).find((b) => b.id === 'pond')?.state === 'drained';
      if (!drained) await sleep(100);
    }
    out.recheckDrained = drained;
    L.call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    await waitDownH(ctx, 'halt');
    await L.openWorld(world);
    await L.call('dev.fluid.hold', { write: true }, 10_000).catch(() => null);
    await sleep(5000);
    const fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
    out.after = { state: (fs1?.bodies ?? []).find((b) => b.id === 'pond')?.state, sources: await ownSources(ctx, pond) };
    log(`  RC: ${json(out)}`);
    check(out.pre.sources > 0 && drained, `RC: the precondition: the pond's tile water on disk (${out.pre.sources}), the recheck drained it (${drained})`);
    check(out.after.state !== 'drained' || out.after.sources === 0, `RC conservation (a bare halt right after the recheck's drain was recorded): the pond reads ${out.after.state} with ${out.after.sources} source(s) in its cells (none beside a drained record)`);
  } finally {
    await L.call('dev.fluid.hold', { write: false }, 10_000).catch(() => null);
  }
  await L.leaveWorld().catch(() => null);
  return out;
}

/**
 * (8cT last round, P2) Receipt-present escape recovery: as row E, but halted at TX:fluid.drain:apply:0+save (the escape's drain and its
 * receipts on disk, the record not). The start finds the W applied and must rebuild the outcome from the entry: the pond drained, its reason
 * and typed why (red on e29d8783: the R only set drainTxn, the pond stayed written).
 */
export async function t9er(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T9ER';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  await L.call('dev.fluid.hold', { settle: true }, 10_000);
  let region = null;
  try {
    region = await L.realise(d.p.planId);
    for (let i = 0; i < 450; i++) { const f = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null); if (f?.phase === 'settling') break; await sleep(2000); }
    const b = d.bodies.find((x) => x.id === 'pond');
    const c = breachCell(b);
    await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
    await sleep(4000);
    await L.call('dev.journal.killAt', { point: 'TX:fluid.drain:apply:0+save' }, 10_000);
    await L.call('dev.fluid.hold', { settle: false }, 10_000);
    await waitDownH(ctx, 'TX:fluid.drain:apply:0+save');
    await L.openWorld(world);
    await L.call('dev.fluid.hold', { settle: true }, 10_000).catch(() => null);
    await sleep(8000);
    const fs1 = await L.call('dev.fluid.state', { region }, 10_000).catch(() => null);
    const p = (fs1?.bodies ?? []).find((x) => x.id === 'pond');
    const row = ((await L.call('dev.region.state', { region }, 60_000)).view?.ext?.['architect_mc:fluids'] ?? []).find((x) => x.body === 'pond');
    out.after = { state: p?.state ?? null, reason: p?.reason ?? null, why: row?.why ?? null, sources: await ownSources(ctx, b) };
    log(`  ER: ${json(out)}`);
    check(p?.state === 'drained' && /^escaped/.test(p?.reason ?? '') && out.after.sources === 0, `ER: the escape's outcome rebuilt at the start (receipts present, the record not): pond ${p?.state}, reason ${p?.reason}, why ${row?.why}, ${out.after.sources} source(s)`);
  } finally {
    await L.call('dev.fluid.hold', { settle: false }, 10_000).catch(() => null);
  }
  await L.leaveWorld().catch(() => null);
  return out;
}

/**
 * (8cT last round, P2) A held drain answers at once: h_core_demo placed; the removal's drain held (dev.fluid.hold drain); a second Remove is
 * refused SITE_BUSY with detail held(other) naming chunk x,z within 10 s (red on e29d8783: it joined and waited). Then released: REMOVED,
 * E-flat 0 (conservation).
 */
export async function t9hd(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  const world = 'G6B H T9HD';
  await freshFlat(ctx, world, 'exact');
  const d = await planDemo(ctx, { lava: true });
  const box = demoBox(d.bodies);
  const file = await snap(ctx, box, 'h-t9hd');
  const r = await realiseWait(ctx, d.p.planId);
  try {
    await L.call('dev.fluid.hold', { drain: true }, 10_000);
    L.call('dev.region.remove', { region: r.region, requester: OWNER }, 3_600_000).catch(() => null);
    await sleep(5000);
    const t0 = Date.now();
    const second = await Promise.race([
      L.call('dev.region.remove', { region: r.region, requester: OWNER }, 3_600_000).then((x) => ({ answer: x })).catch((e) => ({ error: String(e.message ?? e) })),
      sleep(10_000).then(() => ({ waiting: true }))]);
    out.second = { ...second, ms: Date.now() - t0 };
    log(`  HD: ${json(out)}`);
    check(!!second.error && /held\(other\)/.test(second.error) && /chunk -?\d+,-?\d+/.test(second.error), `HD: a Remove asked while the drain is held is answered at once, typed (${json(out.second).slice(0, 300)})`);
  } finally {
    await L.call('dev.fluid.hold', { drain: false }, 10_000).catch(() => null);
  }
  const rm = await removeWait(ctx, r.region).catch((e) => ({ state: `error ${e.message}` }));
  await sleep(3000);
  const dx = await diff(ctx, box, file);
  out.removed = { state: rm.state, mismatches: dx.mismatches };
  check(rm.state === 'REMOVED' && dx.mismatches === 0, `HD conservation: released, the removal finished: ${rm.state}, E-flat ${dx.mismatches}`, dx.sample);
  await L.leaveWorld();
  return out;
}
