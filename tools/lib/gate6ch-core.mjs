// (6c H) H-core's items of the H gate (tools/gate6ch.mjs; docs/CONTRACT.md "Phase 6c slice H" §14): item 11's byte identity offline,
// and the in-game items on h_core_demo (ingame: 1-3, 5, 6; crash: 7; probe: 13, 14). H-core owns this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Item 11's named exceptions: the fixtures that may differ from origin/main; every other fixture must not. (The H batch's T3a r06 and
 * r07, which fit on wet piers since H-b's wet fallback, are on main now and plan the same, so they left the list in housekeeping 3.)
 * Housekeeping 3's even-width rule (ropeGeom latOn): v33's and v34's 2-wide villager rope bridges run +z, so their decks moved one
 * column onto the route's side (lo/hi -1..0, not 0..1) and their answers' cell counts and IRs differ; the overall answers are the same.
 */
export const UNCHANGED_EXCEPTIONS = Object.freeze(['valid/v33_rope_bridge.json', 'valid/v34_auto.json']);
/** Fixtures the comparison skips by name: refused/k1a_r01 runs the two-plan harness (its `volume`; H-b re-answers it WATER deep). */
export const UNCHANGED_SKIPPED = Object.freeze(['refused/k1a_r01_wall_water.json']);

/**
 * Item 11's byte identity: every committed valid/, K1 and T3 fixture without an H part answers as on origin/main and plans the same IR
 * but its kitVersion (the main checkout's kit in a detached worktree beside this one). `ok`: n >= 40 and only the named exceptions
 * differ (`excepted`: those that do).
 */
export async function unchanged(root) {
  const { createHash } = await import('node:crypto');
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const mainDir = path.resolve(root, '..', 'architect-mc-H-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { mainHead, fixtures: {} };
  let same = 0, skipped = 0;
  const H_KINDS = ['pond', 'fountain', 'waterfall', 'quay', 'channel'];
  for (const dir of ['valid', 'k1a', 'rope', 'refused', 't3a', 'tunnel']) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', dir);
    if (!fs.existsSync(fixDir)) continue;
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      if (UNCHANGED_SKIPPED.includes(`${dir}/${f}`)) { skipped++; continue; }
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan) continue;
      const parts = [...(fx.plan.forms ?? []), ...(fx.plan.connectors ?? [])];
      // (an H part, a fixture H added, or one H re-answers by name: §14 item 11's list)
      if (parts.some((c) => H_KINDS.includes(c.kind)) || /"farmPond":true/.test(JSON.stringify(fx.plan)) || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      if (fx.volume) continue; // (a frozen volume built by its own test)
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey());
      const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
      let a, b;
      try { a = await runOn(hNew); b = await runOn(hOld); } catch (e) { out.fixtures[`${dir}/${f}`] = { error: String(e.message).slice(0, 200) }; continue; }
      const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
      const answers = (r) => JSON.stringify(r.check.parts);
      const eq = { answers: answers(a) === answers(b), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall };
      out.fixtures[`${dir}/${f}`] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  const differing = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall));
  out.excepted = differing.map(([k]) => k).filter((k) => UNCHANGED_EXCEPTIONS.includes(k));
  out.differ = differing.filter(([k]) => !UNCHANGED_EXCEPTIONS.includes(k)).map(([k, v]) => [k, v]);
  out.ok = out.n >= 40 && out.differ.length === 0 && out.same + out.excepted.length === out.n;
  return out;
}

// ------------------------------------------------------------------ in game: shared helpers

const OWNER = 'test:h';
const FLAT = 'G6B Flat Base';
/** h_core_demo's claim on the flat world (96 x 96). */
const CLAIM = [9000, 9000, 9095, 9095];
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
async function censusOf(ctx, body, before = null, siblings = []) {
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
async function freshFlat(ctx, name, rules) {
  const L = ctx.L;
  await L.fresh(name, FLAT);
  if (rules === 'exact') await L.setRules('exact');
  else { await L.cmd('/weather clear'); await L.cmd('/time set 6000'); }
  await L.tp((CLAIM[0] + CLAIM[2]) / 2, 120, (CLAIM[1] + CLAIM[3]) / 2);
}

/** Plan h_core_demo (the two-plan flow: its volumes with the fluid layer), its IR and meta read from the sidecar's plan dir. */
async function planDemo(ctx, params = {}) {
  const L = ctx.L;
  const p = await L.plan('h_core_demo', CLAIM, { params, surveyLoad: 'bounded:256', check: true, owner: OWNER });
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const report = fs.existsSync(path.join(dir, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) : null;
  return { p, dir, ir, meta, report, bodies: bodiesOf(ir) };
}

/** The region's box for snapshots: the claim + 8 around, from 8 under the lowest body cell to 16 over the ground. */
function demoBox(bodies) {
  const all = bodies.flatMap((b) => [...b.cells, ...b.shell, ...b.spill, ...b.watch]);
  const b = boxAround(all, 0);
  return [CLAIM[0] - 8, b[1] - 8, CLAIM[1] - 8, CLAIM[2] + 8, b[4] + 16, CLAIM[3] + 8];
}

async function realiseWait(ctx, planId, opts = {}) {
  const L = ctx.L;
  const region = await L.realise(planId, opts);
  const st = await L.waitRegion(region, 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED') await L.cmd('/kill @e[type=!minecraft:player]'); });
  return { region, st, view: st.view, fluids: st.view.ext?.['architect_mc:fluids'] ?? null };
}

async function removeWait(ctx, region) {
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

const snap = async (ctx, box, name) => { const file = path.join(ctx.OUT, `${name}.snap.gz`); await ctx.L.call('dev.region.hash', { box, mode: 'snap', file }, 4 * 3_600_000); return file; };
const diff = async (ctx, box, file) => { const r = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file }, 4 * 3_600_000); return { mismatches: r.mismatches, classes: r.classes ?? {}, sample: (r.list ?? []).slice(0, 12) }; };

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
    // the stand: 2 minutes at default rules (random ticks, fire, spawns): the census unchanged
    await sleep(120_000);
    const c2 = {};
    for (const b of d.bodies) c2[b.id] = await censusOf(ctx, b, before, d.bodies);
    out.stand = Object.fromEntries(Object.entries(c2).map(([k, v]) => [k, { ok: v.ok, mismatch: v.mismatch, outside: v.outside }]));
    check(Object.values(c2).every((c) => c.ok), `item 2: a 2-minute stand at default rules adds nothing (${json(Object.entries(c2).map(([k, v]) => [k, v.mismatch.length, v.outsideCount]))})`, out.stand);
    // item 6: one shell cell of each body opened (a player's pickaxe); after a settle bound the water reaches only its declared and
    // watched cells (the breach reach as predicted, re-surveyed), never a lot, a build, a protected area or keep-out (none here: the claim)
    const opened = {};
    for (const b of d.bodies) { const c = breachCell(b); opened[b.id] = c; if (c) await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`); }
    await sleep(Math.max(...d.bodies.map((b) => b.settleTicks)) * 50 * 2 + 3000);
    const c3 = {};
    for (const b of d.bodies) {
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
  {
    await freshFlat(ctx, 'G6B H Exact', 'exact');
    const d = await planDemo(ctx, { lava: true });
    const box = demoBox(d.bodies);
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
    await sleep(spout.settleTicks * 50 + 2000);
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
async function crashAt(ctx, world, point, action) {
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
  {
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
      await sleep(5000);
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
