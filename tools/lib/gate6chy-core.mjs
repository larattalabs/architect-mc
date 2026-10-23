// (6c HY) HY-core's items of the HY gate (tools/gate6chy.mjs; docs/CONTRACT.md "Phase 6c slice HY" §14, §15 step 1): item 12's byte
// identity offline, and the in-game items on hy_core_demo (ingame: 2-7 and 18 (b); crash: 8; cold: 18 (a)). Every realise here goes
// through Regions.checkPlan (the two-plan flow, the per-body guards) and realiseApproved with the approval artifact (the H RC lesson).
// HY-core owns this file; its helpers are passed to HY-b's and HY-c's items as ctx.core.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { FL_MOVED, FL_MOVED_ASKS, normIrJson } from './fl-norm.mjs'; // (6c FL) the street ext normalised, FL's named movers
import * as P3 from './p3-tier.mjs';
import { F7A_MOVED } from './f7a-norm.mjs'; // (7a foundation) the fixtures the foundation's catalogue changes move by name

/**
 * Item 12's named exceptions: fixtures HY re-answers by name. h/r08_course is a course (now HY-b's v51, the stub's UNREACHABLE until HYb
 * meanwhile) and extension/e15 lost its course part (channel.course is supported).
 */
// ((6c KC) valid/v51_voc_forge: KC's named exception (its wall ran through the fountain; the ring repaired to [4, 17], tools/lib/gate6ckc-kit.mjs))
// ((6c VOC-c) rule.palette is supported: the 7 asks with a palette rule (that rule's answer only), extension/e16 (r_palette left the
// reserved list) and e05 (its reserved rule is rule.shape's draft now); tools/lib/gate6cvoc-c.mjs UNCHANGED_EXCEPTIONS)
export const UNCHANGED_EXCEPTIONS = Object.freeze(['h/r08_course.json', 'extension/e15_every_reserved_a.json', 'valid/v51_voc_forge.json', 'asks/desert_jungle_wall.json',
  'asks/hidden_village.json', 'asks/mage_exiles.json', 'asks/old_new_town.json', 'asks/one_block.json', 'asks/rival_families.json', 'asks/row_houses.json',
  'extension/e05_reserved_rule.json', 'extension/e16_every_reserved_b.json', ...FL_MOVED.filter((n) => n !== 'extension/e15_every_reserved_a.json'),
  ...Object.keys(F7A_MOVED).filter((n) => n !== 'extension/e15_every_reserved_a.json')]); // ((7a foundation) its catalogue changes' named movers)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const hasCourse = (plan) => (plan.connectors ?? []).some((c) => c && c.kind === 'channel' && (c.from !== undefined || c.to !== undefined || c.via !== undefined || c.where?.along !== undefined));

/**
 * Item 12: every committed plan fixture without an HY part (every dir of kit/test/fixtures/plan, the asks too) answers as on origin/main
 * and plans the same IR but its kitVersion, H's included; the exceptions by name. Main's kit in a detached worktree beside this one
 * (../architect-mc-HYcore-main). Fixtures with a frozen volume of their own (`volume`) run the two-plan harness on both sides.
 */
export async function unchanged(root) {
  const mainDir = path.resolve(root, '..', 'architect-mc-HYcore-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { mainHead, fixtures: {} };
  let same = 0, skipped = 0, cached = 0;
  const PC = await import('./plan-cache.mjs');
  const [treesNew, treesOld] = [PC.treesOf(root), PC.treesOf(mainDir)];
  const base = path.join(root, 'kit', 'test', 'fixtures', 'plan');
  for (const dir of fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory()).sort()) {
    for (const f of fs.readdirSync(path.join(base, dir)).filter((x) => x.endsWith('.json')).sort()) {
      const name = `${dir}/${f}`;
      const fx = JSON.parse(fs.readFileSync(path.join(base, dir, f), 'utf8'));
      const plan = fx.plan ?? fx.answer?.plan;
      if (!plan) continue;
      if (hasCourse(plan) && !UNCHANGED_EXCEPTIONS.includes(name)) { skipped++; continue; }
      if (!fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      const old = JSON.parse(fs.readFileSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f), 'utf8'));
      const oldPlan = old.plan ?? old.answer?.plan;
      const on = fx.on ?? (dir === 'asks' ? 'asks' : undefined);
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : on === 'asks' ? h.asksSurvey() : on === 'flat' ? h.flatSurvey() : on ? h.goldenSurvey(on) : h.flatSurvey());
      const runOn = async (h, p) => {
        const s = sv(h);
        const o = { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) };
        return fx.volume !== undefined && h.checkPlanVolumes ? h.checkPlanVolumes(p, { ...o, volume: fx.volume }) : h.checkPlanLocal(p, o);
      };
      let a, b;
      // (gate waits, 2026-10-20) each side keyed by its kit and scenarios trees, the plan and this fixture's options (tools/lib/plan-cache.mjs)
      const opts = { ...fx, plan: undefined, answer: undefined, on };
      try {
        a = await PC.planSide(root, treesNew, ['hy', name, plan, opts], () => runOn(hNew, plan));
        b = await PC.planSide(root, treesOld, ['hy', name, oldPlan, opts], () => runOn(hOld, oldPlan));
      } catch (e) { out.fixtures[name] = { error: String(e.message).slice(0, 200) }; continue; }
      cached += a.cached + b.cached;
      const eq = { answers: a.answers === b.answers, ir: a.ir === b.ir, overall: a.overall === b.overall };
      out.fixtures[name] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  out.cache = { sides: cached, of: 2 * out.n, trees: { new: treesNew, main: treesOld } };
  PC.savePlanCache();
  const differing = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall));
  out.excepted = differing.map(([k]) => k).filter((k) => UNCHANGED_EXCEPTIONS.includes(k));
  out.differ = differing.filter(([k]) => !UNCHANGED_EXCEPTIONS.includes(k)).map(([k, v]) => [k, v]);
  out.ok = out.n >= 150 && out.differ.length === 0 && out.same + out.excepted.length === out.n;
  return out;
}

// ------------------------------------------------------------------ in game: shared helpers (ctx.core for HY-b and HY-c)

export const OWNER = 'test:hy';
export const FLAT = 'G6B Flat Base';
/** hy_core_demo's claim on the flat world (96 x 64). */
export const CLAIM = [9300, 9000, 9395, 9063];

/** A course IR's bodies, cells unpacked (natural joins as cells; plan joins, lining, after, grate; (6c F3-c) decor [[x, y, z, state]]). */
export function bodiesOf(ir) {
  const cellsOf = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };
  const out = [];
  for (const p of ir.parts) for (const o of p.ops) if (o.op === 'fluid') {
    const nat = (o.joins ?? []).filter((j) => Array.isArray(j)), plan = (o.joins ?? []).filter((j) => j && !Array.isArray(j));
    out.push({ id: o.id, part: o.part, fluid: o.fluid, level: o.level, cells: cellsOf(o.cells), spill: cellsOf(o.spill), joins: cellsOf(nat), planJoins: plan.map((q) => ({ body: q.body, cells: cellsOf(q.cells) })), watch: cellsOf(o.watch), ice: cellsOf(o.ice), shell: cellsOf(o.shell), lining: cellsOf(o.lining), grate: cellsOf(o.grate), after: o.after ?? [], predicted: o.predicted ?? [], settleTicks: o.settleTicks,
      decor: (o.decor ?? []).flatMap((d) => cellsOf(d.cells).map((c) => [...c, d.state])) });
  }
  return out;
}

/** A box around cells grown by g: [x0, y0, z0, x1, y1, z1]. */
export function boxAround(cells, g = 2) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of cells) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
  return [b[0] - g, b[1] - g, b[2] - g, b[3] + g, b[4] + g, b[5] + g];
}

/**
 * A body's census against its prediction over its watch box: {ok, sources, flowing, mismatch, outside (fluid of its kind outside its
 * cells, spill and joins that `before` did not hold and no sibling plans), ticks, fluids}. Grate cells hold a waterlogged source.
 * (6c F3-c) A body cell of the decor set holds its own decor, waterlogged: a source (`decor` counts them).
 */
export async function censusOf(ctx, body, before = null, siblings = []) {
  const box = boxAround([...body.cells, ...body.shell, ...body.lining, ...body.spill, ...body.watch], 2);
  const c = await ctx.L.call('dev.fluid.census', { box }, 120_000);
  const now = new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
  const pred = new Map(body.predicted.map(([x, y, z, lv]) => [`${x},${y},${z}`, lv]));
  const others = new Set(siblings.filter((o) => o.id !== body.id).flatMap((o) => [...o.cells.map(k3), ...o.ice.map(k3), ...o.predicted.map(k3)]));
  const own = new Set(body.cells.map(k3)), ice = new Set(body.ice.map(k3)), grate = new Set(body.grate.map(k3));
  const decor = new Map((body.decor ?? []).map((c) => [k3(c), c[3]]));
  let decorSources = 0;
  const declared = new Set([...body.cells, ...body.spill, ...body.joins, ...body.planJoins.flatMap((q) => q.cells)].map(k3));
  const kind = body.fluid === 'lava' ? 'minecraft:lava' : 'minecraft:water';
  const levelOf = (s) => { const m = /level=(\d+)/.exec(s); return m ? Number(m[1]) : 0; };
  const mismatch = [], outside = [];
  let sources = 0, flowing = 0;
  for (const k of own) {
    const s = now.get(k);
    if (ice.has(k)) { if (s !== 'minecraft:ice') mismatch.push([k, s ?? 'none', 'ice']); continue; }
    if (grate.has(k)) { if (!s || !/^minecraft:iron_bars\[.*waterlogged=true/.test(s)) mismatch.push([k, s ?? 'none', 'grate']); else sources++; continue; }
    if (decor.has(k)) { if (s !== decor.get(k)) mismatch.push([k, s ?? 'none', 'decor']); else { sources++; decorSources++; } continue; }
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
  return { ok: !mismatch.length && !outside.length, sources, decor: decorSources, flowing, mismatch: mismatch.slice(0, 20), outside: outside.slice(0, 20), outsideCount: outside.length, ticks: c.ticks.length, box, fluids: now };
}

/** The flat world's ground at the claim (superflat: grass at -61). */
export async function groundOf(ctx, claim = CLAIM) {
  const f = path.join(ctx.OUT, `hy-survey-${claim.join('_')}.bin`);
  await ctx.L.tp((claim[0] + claim[2]) / 2, 120, (claim[1] + claim[3]) / 2);
  await ctx.L.call('dev.region.survey', { claim, surveyLoad: 'loaded', file: f }, 300_000);
  const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
  const S = surveyApi(fs.readFileSync(f), { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3], minY: -64, maxY: 319 });
  return S.groundAt(claim[0] + 2, claim[1] + 2);
}

/** A fresh copy of the flat base, its rules, the player over the claim, and the natural lake beside the course's head (/fill). */
export async function freshCourse(ctx, name, rules, params = {}) {
  const L = ctx.L;
  await L.fresh(name, FLAT);
  if (rules === 'exact') await L.setRules('exact');
  else { await L.cmd('/weather clear'); await L.cmd('/time set 6000'); }
  const g = await groundOf(ctx);
  const demo = await import(pathToFileURL(path.join(ctx.KIT, 'regions', 'hy_core_demo.mjs')).href);
  const c = { minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] };
  const lake = demo.hyCoreLake(demo.hyCoreOrigin(c, params), g);
  await L.cmd(`/fill ${lake.wall.join(' ')} minecraft:stone`);
  await L.cmd(`/fill ${lake.water.join(' ')} minecraft:water`);
  await L.settle(3000);
  return { g, lake, demo };
}

/** The hy_core_demo plan for the claim and params, through Regions.checkPlan (the two-plan flow): {c, plan, artifactSha}. */
export async function checkCourse(ctx, tag, params = {}) {
  const { L } = ctx;
  const demo = await import(pathToFileURL(path.join(ctx.KIT, 'regions', 'hy_core_demo.mjs')).href);
  const { plan, anchors } = demo.hyCorePlan({ minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] }, params);
  const c = await L.call('dev.region.checkPlan', { plan, claim: CLAIM, owner: OWNER, anchors, load: 'generate' }, 900_000);
  fs.writeFileSync(path.join(ctx.OUT, `hy-${tag}-check.json`), `${JSON.stringify(c, null, 1)}\n`);
  return { c, plan, artifactSha: c.check?.artifactSha ?? null };
}

/** The snapshot box: the claim + 8, from 6 under the ground to 20 over it. */
export const boxOf = (g) => [CLAIM[0] - 8, g - 6, CLAIM[1] - 8, CLAIM[2] + 8, g + 20, CLAIM[3] + 8];
export const snap = async (ctx, box, name) => { const file = path.join(ctx.OUT, `${name}.snap.gz`); await ctx.L.call('dev.region.hash', { box, mode: 'snap', file }, 4 * 3_600_000); return file; };
export const diff = async (ctx, box, file) => { const r = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file }, 4 * 3_600_000); return { mismatches: r.mismatches, classes: r.classes ?? {}, sample: (r.list ?? []).slice(0, 12) }; };

/** realiseApproved with the artifact; waits for the region: {region, view, fluids (the ext rows), state (dev.fluid.state), ir, bodies}. */
export async function realiseApproved(ctx, sha, { kill = true } = {}) {
  const { L } = ctx;
  const rr = await L.call('dev.region.realiseApproved', { sha }, 300_000);
  if (rr.refused) return { refused: rr.refused };
  const st = await L.waitRegion(rr.region, 3_600_000, async (s) => { if (kill && (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED)) await L.cmd('/kill @e[type=!minecraft:player]'); });
  return { ...(await regionOf(ctx, rr.region)), st };
}

/** A region's view, fluid rows, fluids record, IR and bodies. */
export async function regionOf(ctx, region) {
  const { L } = ctx;
  const st = await L.call('dev.region.state', { region }, 60_000);
  const planId = st.view.planId;
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const fstate = await L.call('dev.fluid.state', { region }, 10_000).catch((e) => ({ error: String(e.message ?? e) }));
  return { region, view: st.view, fluids: st.view.ext?.['architect_mc:fluids'] ?? [], fstate, ir, bodies: bodiesOf(ir), planId };
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

/** Every row of the report is exactly {part, body, state, reason, at} plus H's extras (S-HY-6), one per body. */
function rowShape(rows, bodies) {
  const keys = ['part', 'body', 'state', 'at'];
  return rows.length === bodies.length && rows.every((r) => keys.every((k) => r[k] !== undefined) && (r.state === 'settled' || typeof r.reason === 'string') && Array.isArray(r.at)) && bodies.every((b) => rows.some((r) => r.body === b.id && r.part === b.part));
}

/** All fluid of the kind in the watch boxes of `bodies` that `before` did not hold. */
async function strayFluid(ctx, bodies, before) {
  let n = 0;
  const left = [];
  for (const b of bodies) {
    const c = await censusOf(ctx, b, before, []);
    for (const [k, s] of c.fluids) if (!before.has(k) && /^minecraft:water/.test(s) && !/iron_bars/.test(s)) { n++; if (left.length < 12) left.push([k, s]); }
  }
  return { n, left };
}

async function fluidsIn(ctx, box) {
  const c = await ctx.L.call('dev.fluid.census', { box }, 600_000);
  return new Map(c.fluids.map(([x, y, z, s]) => [`${x},${y},${z}`, s]));
}

// ------------------------------------------------------------------ in game: items 2-7, 18 (b)

/** Items 2-7 and 18 (b) on hy_core_demo (a flat world, headless), each realise through checkPlan and realiseApproved. */
export async function ingame(ctx) {
  const { L, check, json, log } = ctx;
  const out = {};
  // ---- (A) default rules: the check, the write order, every census, the stand; item 7 (the single breach) and its undo
  {
    const { g } = await freshCourse(ctx, 'G6B HY Default', 'default');
    const ck = await checkCourse(ctx, 'default');
    const parts = (ck.c.check?.parts ?? []).map((a) => [a.part, a.class]);
    const vp = ck.c.volumePass ?? null;
    out.check = { overall: ck.c.check?.overall ?? null, parts, volumePass: vp, guards: ck.c.check?.guards?.length ?? null };
    check(ck.c.check?.overall === 'READY' && parts.every(([, k]) => k === 'fits') && vp && vp.asked >= 4 && !vp.why, `item 2 (plan, in game): hy_core_demo through Regions.checkPlan's two-plan flow: ${out.check.overall} (${json(parts)}; volumes ${json(vp)})`);
    const box = boxOf(g);
    const before = await fluidsIn(ctx, box);
    const r = await realiseApproved(ctx, ck.artifactSha);
    if (r.refused) { check(false, `item 2: realiseApproved refused (${json(r.refused)})`); return out; }
    const fl = r.fluids;
    out.realise = { region: r.region, state: r.view.state, fluids: fl, fstate: r.fstate };
    check(r.view.state === 'PLACED' && fl.length === 4 && fl.every((x) => x.state === 'settled'), `item 2: realised from the approved artifact, PLACED once every body settled (${r.view.state}; ${json(fl.map((x) => [x.part, x.body, x.state, x.settledAt]))})`);
    check(rowShape(fl, r.bodies), `S-HY-6: one row per reach (and the feed), each {part, body, state, reason, at} (${json(fl.map((x) => Object.keys(x)))})`);
    const order = r.fstate.order ?? [];
    const wt = Object.fromEntries((r.fstate.bodies ?? []).map((b) => [b.id, b.writtenAt]));
    out.order = { order, writtenAt: wt };
    check(json(order) === json(['stream_r3', 'stream_r2', 'stream_r1', 'w_feed']) && wt.stream_r3 < wt.stream_r2 && wt.stream_r2 < wt.stream_r1 && wt.stream_r1 < wt.w_feed, `item 2 (§3.1): written downstream first, each after its landing settled: ${json(order)} at ${json(wt)}`);
    const c1 = {};
    for (const b of r.bodies) c1[b.id] = await censusOf(ctx, b, before, r.bodies);
    out.census = Object.fromEntries(Object.entries(c1).map(([k, v]) => [k, { ok: v.ok, sources: v.sources, flowing: v.flowing, mismatch: v.mismatch, outside: v.outside, ticks: v.ticks }]));
    check(Object.values(c1).every((c) => c.ok && c.ticks === 0), `item 3: every body's census equals its prediction exactly (sources; the fall's lip, column and landing; the spillway's film; the feed's spillway), 0 fluid outside its cells, spill and joins, no fluid tick (${json(Object.entries(c1).map(([k, v]) => [k, v.sources, v.flowing, v.mismatch.length, v.outsideCount]))})`, out.census);
    const bound = new Map(r.bodies.map((b) => [b.id, b.settleTicks]));
    check(fl.every((x) => x.settledAt <= bound.get(x.body)), `item 3: each body settled within its settleTicks (${json(fl.map((x) => [x.body, x.settledAt, bound.get(x.body)]))})`);
    await L.gameWait(P3.standMs(120_000), { real: sleep, label: 'hy item 3 stand' }); // (P3 smoke: 30 s; the physics is the census's: no fluid tick scheduled)
    const c2 = {};
    for (const b of r.bodies) c2[b.id] = await censusOf(ctx, b, before, r.bodies);
    out.stand = Object.fromEntries(Object.entries(c2).map(([k, v]) => [k, { ok: v.ok, mismatch: v.mismatch, outside: v.outside }]));
    check(Object.values(c2).every((c) => c.ok), `item 3: a ${P3.standMs(120_000) / 1000} s stand at default rules adds nothing (${json(Object.entries(c2).map(([k, v]) => [k, v.mismatch.length, v.outsideCount]))})`, out.stand);
    // item 7: one bank cell of a reach (r2's side shell), one weir cell (r1's outer course, the lake's side) and one lining cell (r1's
    // lip side) opened; after a settle bound the water reaches nothing past the bodies' cells, spill, watched breach reach and joins
    const r2 = r.bodies.find((b) => b.id === 'stream_r2'), r1 = r.bodies.find((b) => b.id === 'stream_r1');
    const bank = r2.shell.filter(([x, y, z]) => y === r2.level && !r2.cells.some((q) => q[0] === x && q[2] === z)).sort((a, b) => a[0] - b[0] || a[2] - b[2])[0];
    const minX = Math.min(...r1.cells.map((q) => q[0]));
    const weir = r1.lining.filter(([x, y]) => x === minX - 2 && y === r1.level).sort((a, b) => a[2] - b[2])[1] ?? r1.lining.find(([x]) => x === minX - 2);
    const lining = r1.lining.find(([x]) => x > Math.max(...r1.cells.map((q) => q[0])));
    out.breach = { bank, weir, lining };
    // (P3 smoke: the bank's breach only, the calibration instance; the water lint's W3 sweeps every shell, lining and weir cell offline)
    if (P3.smoke) P3.skipped(ctx.log, 'item 7: the weir and lining breaches', 'the water lint W3 (every shell, lining and weir cell of hy_core_demo and the HY corpus)');
    for (const c of P3.smoke ? [bank] : [bank, weir, lining]) if (c) await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
    await L.gameWait(Math.max(...r.bodies.map((b) => b.settleTicks)) * 50 * 2 + 3000, { real: sleep, label: 'hy item 7 breach settle' });
    const allowed = new Set(r.bodies.flatMap((o) => [...o.cells, ...o.spill, ...o.watch, ...o.joins, ...o.predicted, ...o.planJoins.flatMap((q) => q.cells)]).map(k3));
    const nowF = await fluidsIn(ctx, box);
    const beyond = [...nowF].filter(([k, s]) => /^minecraft:water/.test(s) && !allowed.has(k) && !before.has(k));
    out.breach.beyond = beyond.slice(0, 12);
    out.breach.n = beyond.length;
    // the weir's breach connects nothing: the lake's cells still sources at their level, r1's still its own (no flowing cell between)
    const lake = [...before].filter(([, s]) => /^minecraft:water(\[level=0\])?$/.test(s)).map(([k]) => k);
    const lakeOk = lake.length > 0 && lake.every((k) => nowF.get(k) === before.get(k));
    check(bank && weir && lining && beyond.length === 0 && lakeOk, `item 7: a single breach of a reach's bank ${json(bank)}${P3.smoke ? '' : `, a weir cell ${json(weir)} and a lining cell ${json(lining)}`} reaches nothing past the bodies' cells, spill, watched breach reach and joins (${beyond.length}); the weir's breach connects nothing (the lake's ${lake.length} sources unchanged: ${lakeOk})`, out.breach);
    const rm = await removeWait(ctx, r.region);
    const st = await strayFluid(ctx, r.bodies, before);
    out.breachUndo = { state: rm.state, seconds: rm.seconds, extra: st.n, left: st.left };
    check(rm.state === 'REMOVED' && st.n === 0, `item 7: Regions.remove after the breach: ${rm.state} in ${rm.seconds} s; 0 fluid cells in the watch boxes the before-census did not hold (${st.n})`, st.left);
    await L.leaveWorld();
  }
  // ---- (B) exact rules: item 5 (E-flat by state), and item 7's exactness (the same breach, then the removal)
  if (P3.smoke) P3.skipped(ctx.log, "item 7's exactness after the breach (a second exact-rules world)", "item 5's exact undo and the breach's removal in (A)");
  for (const breach of P3.smoke ? [false] : [false, true]) {
    const tag = breach ? 'exact-breach' : 'exact';
    const { g } = await freshCourse(ctx, `G6B HY ${breach ? 'ExactBreach' : 'Exact'}`, 'exact');
    const ck = await checkCourse(ctx, tag);
    const box = boxOf(g);
    const file = await snap(ctx, box, `hy-${tag}`);
    const r = await realiseApproved(ctx, ck.artifactSha);
    if (r.refused) { check(false, `item 5 (${tag}): realiseApproved refused (${json(r.refused)})`); continue; }
    check(r.view.state === 'PLACED' && r.fluids.every((x) => x.state === 'settled'), `item 5 (${tag}): the exact-rules realise PLACED, every body settled (${r.view.state}; ${json(r.fluids.map((x) => [x.body, x.state]))})`);
    if (breach) {
      const r1 = r.bodies.find((b) => b.id === 'stream_r1'), r2 = r.bodies.find((b) => b.id === 'stream_r2');
      const bank = r2.shell.filter(([x, y, z]) => y === r2.level && !r2.cells.some((q) => q[0] === x && q[2] === z)).sort((a, b) => a[0] - b[0] || a[2] - b[2])[0];
      const lining = r1.lining.find(([x]) => x > Math.max(...r1.cells.map((q) => q[0])));
      const minX = Math.min(...r1.cells.map((q) => q[0]));
      const weir = r1.lining.filter(([x, y]) => x === minX - 2 && y === r1.level).sort((a, b) => a[2] - b[2])[1];
      for (const c of [bank, lining, weir]) await L.cmd(`/setblock ${c[0]} ${c[1]} ${c[2]} minecraft:air`);
      await sleep(Math.max(...r.bodies.map((b) => b.settleTicks)) * 50 * 2 + 3000);
    }
    const rm = await removeWait(ctx, r.region);
    await sleep(3000);
    const df = await diff(ctx, box, file);
    out[tag] = { region: r.region, box, state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, sample: df.sample, removalOrder: r.fstate.order };
    check(rm.state === 'REMOVED' && df.mismatches === 0, `item ${breach ? '7 (exactness, item 5\'s rule)' : '5'}: Regions.remove (the head drained first, then down the course; a settle bound; the solids) restores the box exactly under the exact rules: E-flat ${df.mismatches} (fluid cells by state; ${rm.seconds} s)`, df.sample);
    await L.leaveWorld();
  }
  // ---- (C) item 3's negative controls: no_lining_cell (the check bypassed: the feed's water falls through its unwritten spillway floor,
  // the census names it, the guard drains the feed); wrong_order (the head written first: its fall pours into r2's empty basin, the guard
  // drains it and its closure, PARTIAL)
  {
    await freshCourse(ctx, 'G6B HY Leak', 'exact');
    const ck = await checkCourse(ctx, 'leak', { variant: 'no_lining_cell' });
    const hole = (await import(pathToFileURL(path.join(ctx.KIT, 'lib', 'fluids', 'handcourse.mjs')).href)).hyCoreLayout((await import(pathToFileURL(path.join(ctx.KIT, 'regions', 'hy_core_demo.mjs')).href)).hyCoreOrigin({ minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] }), await groundOf(ctx), 'no_lining_cell').feed.overflow.lining[0];
    await L.call('dev.fluid.bypass', { on: true }, 10_000);
    const r = await realiseApproved(ctx, ck.artifactSha);
    await L.call('dev.fluid.bypass', { on: false }, 10_000);
    const ff = (r.fluids ?? []).find((x) => x.body === 'w_feed');
    out.negativeLining = { state: r.view?.state, feed: ff, hole, rows: (r.fluids ?? []).map((x) => [x.body, x.state, x.reason]) };
    check(r.view?.state === 'PARTIAL' && ff?.state === 'drained' && /^escaped/.test(ff.reason ?? '') && (ff.at ?? []).some((c) => c[0] === hole[0] && c[1] === hole[1] && c[2] === hole[2]), `item 3 (negative control, _unsafe.noLiningCell): the feed's spillway floor left unwritten leaks in game: the census names ${json(hole)} within a settle bound, the guard drains the feed, PARTIAL (${json(out.negativeLining.rows)})`);
    await L.leaveWorld();
    const wo = await freshCourse(ctx, 'G6B HY Order', 'exact');
    const ck2 = await checkCourse(ctx, 'order', { variant: 'wrong_order' });
    const beforeO = await fluidsIn(ctx, boxOf(wo.g));
    const ord = (ck2.c.check?.parts ?? []).length;
    void ord;
    const r2 = await realiseApproved(ctx, ck2.artifactSha);
    const rows = r2.fluids ?? [];
    const head = rows.find((x) => x.body === 'stream_r1');
    out.negativeOrder = { state: r2.view?.state, order: r2.fstate?.order, rows: rows.map((x) => [x.body, x.state, x.reason]) };
    check(r2.view?.state === 'PARTIAL' && head?.state === 'drained' && /^escaped/.test(head.reason ?? '') && (r2.fstate?.order ?? [])[0] === 'stream_r1', `item 3 (negative control, _unsafe.wrongOrder): the head written first (${json(r2.fstate?.order)}): its fall pours into r2's empty basin, the guard drains it (${json(head)}), PARTIAL (${json(out.negativeOrder.rows)})`);
    await L.gameWait(Math.max(...r2.bodies.map((b) => b.settleTicks)) * 50 + 2000, { real: sleep, label: 'hy item 3 negative control settle' });
    const st = await strayFluid(ctx, r2.bodies.filter((b) => rows.find((x) => x.body === b.id)?.state === 'drained'), beforeO);
    check(st.n === 0, `item 3 (wrong order): 0 water left in the drained bodies' watch boxes (${st.n})`, st.left);
    await L.leaveWorld();
  }
  // ---- (D) item 4: the escape guard's upstream closure (predict_short on the middle reach), and a protected area over a weir cell
  {
    const w0 = await freshCourse(ctx, 'G6B HY Escape', 'exact');
    const ck = await checkCourse(ctx, 'escape', { variant: 'predict_short' });
    const before0 = await fluidsIn(ctx, boxOf(w0.g));
    const r = await realiseApproved(ctx, ck.artifactSha);
    const rows = Object.fromEntries((r.fluids ?? []).map((x) => [x.body, x]));
    out.escape = { state: r.view?.state, rows: r.fluids };
    check(r.view?.state === 'PARTIAL' && rows.stream_r2?.state === 'drained' && rows.stream_r2.escaped === true, `item 4: predict_short on the middle reach: the guard drains r2, escaped, naming ${json(rows.stream_r2?.at)}; PARTIAL (${r.view?.state})`);
    check(rows.stream_r1?.state === 'drained' && rows.stream_r1.reason === 'upstream of stream_r2' && rows.w_feed?.state === 'drained' && rows.w_feed.reason === 'upstream of stream_r2', `item 4 (§3.3, S-HY-6): its upstream closure drains with it, across parts: r1 ${json([rows.stream_r1?.state, rows.stream_r1?.reason])}, the feed ${json([rows.w_feed?.state, rows.w_feed?.reason])}`);
    check(rows.stream_r3?.state === 'settled', `item 4: the downstream reach stands (r3 ${rows.stream_r3?.state})`);
    await L.gameWait(Math.max(...r.bodies.map((b) => b.settleTicks)) * 50 + 2000, { real: sleep, label: 'hy item 4 escape guard settle' });
    const drained = r.bodies.filter((b) => b.id !== 'stream_r3');
    const r3 = r.bodies.find((b) => b.id === 'stream_r3');
    const st = await strayFluid(ctx, drained, new Map([...before0, ...r3.cells.map((c) => [k3(c), 'r3']), ...r3.predicted.map((c) => [k3(c), 'r3'])]));
    out.escape.after = st;
    check(st.n === 0, `item 4: after a settle bound, 0 fluid in the drained bodies' watch sets (r3's own sources aside: ${st.n})`, st.left);
    await L.leaveWorld();
    const w = await freshCourse(ctx, 'G6B HY Protected', 'exact');
    const ck2 = await checkCourse(ctx, 'protected');
    const handc = await import(pathToFileURL(path.join(ctx.KIT, 'lib', 'fluids', 'handcourse.mjs')).href);
    const L0 = handc.hyCoreLayout(w.demo.hyCoreOrigin({ minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] }), w.g, 'none');
    const cell = L0.reaches[0].weir[1];
    await L.call('dev.fluid.beforeGate', { protect: [cell[0], cell[2], cell[0], cell[2]], owner: OWNER }, 10_000);
    const r2 = await realiseApproved(ctx, ck2.artifactSha);
    const rows2 = Object.fromEntries((r2.fluids ?? []).map((x) => [x.body, x]));
    out.protected = { cell, state: r2.view?.state, rows: r2.fluids };
    check(r2.view?.state === 'PARTIAL' && rows2.stream_r1?.state === 'drained' && /^uncontained/.test(rows2.stream_r1.reason ?? '') && (rows2.stream_r1.at ?? []).some((c) => c[0] === cell[0] && c[2] === cell[2]), `item 4: a protected area over a weir cell ${json(cell)} before the realise: r1 is not written, PARTIAL naming it and the cell (${json(rows2.stream_r1)})`);
    check(rows2.w_feed?.state === 'drained' && rows2.w_feed.reason === 'upstream of stream_r1' && rows2.stream_r2?.state === 'settled' && rows2.stream_r3?.state === 'settled', `item 4: its upstream closure (the feed) is not written either; the downstream reaches stand (${json((r2.fluids ?? []).map((x) => [x.body, x.state, x.reason]))})`);
    const c1 = await censusOf(ctx, r2.bodies.find((b) => b.id === 'stream_r1'));
    check(c1.sources === 0, `item 4: 0 water written for r1 (${c1.sources})`);
    await L.leaveWorld();
  }
  // ---- (E) item 6: the capped removal, judged: fluid ticks held on a shell cell for the whole removal (h-ingame (E)'s method): the
  // removal reaches the cap and REMOVED, and E-flat 0 after it
  {
    const { g } = await freshCourse(ctx, 'G6B HY Capped', 'exact');
    const ck = await checkCourse(ctx, 'capped');
    const box = boxOf(g);
    const file = await snap(ctx, box, 'hy-capped');
    const r = await realiseApproved(ctx, ck.artifactSha);
    const r3 = r.bodies.find((b) => b.id === 'stream_r3');
    const bound = Math.max(...r.bodies.map((b) => b.settleTicks));
    const horizon = 4 * bound + 200, cells = r3.shell.slice(0, Math.ceil(horizon / 10));
    for (let i = 0; i < cells.length; i++) await L.call('dev.fluid.tick', { cells: [cells[i]], delay: 10 * (i + 1) }, 10_000);
    const rm = await removeWait(ctx, r.region);
    const fs2 = await L.call('dev.fluid.state', { region: r.region }, 10_000).catch((e) => ({ error: String(e.message ?? e) }));
    await sleep(3000);
    const df = await diff(ctx, box, file);
    out.capped = { state: rm.state, seconds: rm.seconds, note: fs2, mismatches: df.mismatches, sample: df.sample };
    check(rm.state === 'REMOVED' && /2 x the settle bound/.test(fs2.removalNote ?? ''), `item 6: fluid ticking in a watch set for the whole removal: it reaches the cap (2 x ${bound} ticks) and ends REMOVED in ${rm.seconds} s (${json(fs2.removalNote ?? fs2)})`);
    check(df.mismatches === 0, `item 6: the capped removal is judged too: E-flat ${df.mismatches} after it`, df.sample);
    await L.leaveWorld();
  }
  // ---- (G) §10, S-HY-6: realiseApproved re-samples each reach's guard: a block set in r2's guard buffer after the check answers
  // ARTIFACT_STALE naming that reach (its body and part), and nothing is written
  {
    const w = await freshCourse(ctx, 'G6B HY Stale', 'exact');
    const ck = await checkCourse(ctx, 'stale');
    const demo = w.demo;
    const o = demo.hyCoreOrigin({ minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] });
    const cell = [o[0] + 17, w.g + 3, o[1] - 4];
    await L.cmd(`/setblock ${cell.join(' ')} minecraft:cobblestone`);
    const rr = await L.call('dev.region.realiseApproved', { sha: ck.artifactSha }, 300_000);
    const why = JSON.stringify(rr.refused ?? null);
    out.stale = { cell, refused: rr.refused ?? null, region: rr.region ?? null };
    check(!!rr.refused && /ARTIFACT_STALE/.test(why) && /stream_r2/.test(why) && !/stream_r1|stream_r3|w_feed/.test(why), `§10 (S-HY-6): a block set in r2's guard buffer ${json(cell)} after the check: realiseApproved answers ARTIFACT_STALE naming the reach (${why.slice(0, 300)})`);
    await L.leaveWorld();
  }
  // ---- (F) item 18 (b), recorded: fall damage landing in 1-deep and 2-deep water from 3 to 8 high (villagers dropped over /fill pools)
  {
    await L.fresh('G6B HY Falls', FLAT);
    await L.setRules('exact');
    const g = await groundOf(ctx);
    const res = [];
    const t0 = Date.now();
    let x = CLAIM[0] + 6;
    for (const depth of [1, 2]) for (let h = 3; h <= 8; h++) {
      const z = CLAIM[1] + 10 + depth * 12;
      // a stone basin with `depth` of water whose surface is at g + 3, the villager dropped h over the water's surface
      const s = g + 3;
      await L.cmd(`/fill ${x - 1} ${g + 1} ${z - 1} ${x + 1} ${s} ${z + 1} minecraft:stone`);
      await L.cmd(`/fill ${x} ${s - depth + 1} ${z} ${x} ${s} ${z} minecraft:water`);
      await L.tp(x, s + 20, z);
      await L.cmd(`/summon minecraft:villager ${x + 0.5} ${s + h + 0.5} ${z + 0.5} {CustomName:'"fall_${depth}_${h}"',PersistenceRequired:1b}`);
      res.push({ depth, h, at: [x, s, z] });
      x += 4;
    }
    await sleep(8000);
    const dmg = await L.call('dev.entity.damage', { since: t0, type: 'fall' }, 10_000);
    for (const q of res) q.fall = dmg.events.filter((e) => Math.abs(e.at[0] - q.at[0]) <= 1 && Math.abs(e.at[2] - q.at[2]) <= 1).reduce((a, e) => a + e.amount, 0);
    out.falls = res;
    log(`  item 18 (b), recorded: fall damage by (depth, height): ${json(res.map((q) => [q.depth, q.h, q.fall]))}`);
    check(true, `item 18 (b) (recorded): fall damage landing in water: ${json(res.map((q) => [q.depth, q.h, q.fall]))} (assumed 0 at every depth: ${res.every((q) => q.fall === 0)})`);
    await L.leaveWorld();
  }
  log(`  ingame: ${json(Object.keys(out))}`);
  return out;
}

// ------------------------------------------------------------------ item 8: crashes

async function crashAt(ctx, world, point, action) {
  const L = ctx.L;
  await L.call('dev.journal.killAt', { point }, 10_000);
  action().catch(() => null);
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

/** The last region of the world (a realise the halt cut off before it answered). */
async function lastRegion(ctx) {
  return (await ctx.L.call('dev.region.list', {}, 60_000)).regions?.at(-1)?.id;
}

/**
 * Item 8: HY's kill points: after the shells and lining, before the fluids stage (FL1+save); between reaches (FL4+save: downstream written,
 * upstream not); during the removal between draining the head and the tail (FL5+save); between the drain and the solids (FL3). Settle at
 * start completes or undoes; 0 fluid outside the declared cells; the undo exact (E-flat).
 */
export async function crash(ctx) {
  const { L, check, json } = ctx;
  const out = {};
  // (P3 smoke: FL4 and FL5, the course's own stages; FL1 and FL3 repeat h-crash's on a course: at release)
  if (P3.smoke) P3.skipped(ctx.log, 'item 8: FL1+save and FL3 on a course', "h-crash's FL1 and FL3 (every slice that touches fluids)");
  for (const [tag, point, during] of [['fl1', 'FL1+save', 'realise'], ['fl4', 'FL4+save', 'realise'], ['fl5', 'FL5+save', 'removal'], ['fl3', 'FL3', 'removal']].filter(([tag]) => !P3.smoke || tag === 'fl4' || tag === 'fl5')) {
    const world = `G6B HY Crash ${tag}`;
    const { g } = await freshCourse(ctx, world, 'exact');
    const ck = await checkCourse(ctx, `crash-${tag}`);
    const box = boxOf(g);
    const file = await snap(ctx, box, `hy-crash-${tag}`);
    const before = await fluidsIn(ctx, box); // (the natural lake beside the head)
    let region = null;
    if (during === 'realise') {
      await crashAt(ctx, world, point, async () => { region = (await L.call('dev.region.realiseApproved', { sha: ck.artifactSha }, 300_000)).region; });
      region ??= await lastRegion(ctx);
      const st = await L.waitRegion(region, 3_600_000);
      const r = await regionOf(ctx, region);
      const fl = r.fluids;
      out[tag] = { state: st.view.state, fluids: fl.map((x) => [x.body, x.state, x.reason ?? null]), writtenAt: (r.fstate.bodies ?? []).map((b) => [b.id, b.writtenAt]) };
      check(st.view.state === 'PLACED' && fl.length === 4 && fl.every((x) => x.state === 'settled'), `item 8 (${point}${tag === 'fl4' ? ', between reaches: downstream written, upstream not' : ', after the shells and lining, before any source'}): settle at start completes the realise: ${st.view.state} (${json(out[tag].fluids)})`);
      let outside = 0, mism = 0;
      for (const b of r.bodies) { const c = await censusOf(ctx, b, before, r.bodies); outside += c.outsideCount; mism += c.mismatch.length; }
      out[tag].outside = outside;
      check(outside === 0 && mism === 0, `item 8 (${point}): every census equals its prediction, 0 fluid outside the declared cells (${mism}, ${outside})`);
      const rm = await removeWait(ctx, region);
      await sleep(3000);
      const df = await diff(ctx, box, file);
      out[tag].removal = rm.state; out[tag].mismatches = df.mismatches;
      check(rm.state === 'REMOVED' && df.mismatches === 0, `item 8 (${point}): the undo exact as item 5: E-flat ${df.mismatches}`, df.sample);
    } else {
      const r = await realiseApproved(ctx, ck.artifactSha);
      region = r.region;
      check(r.view.state === 'PLACED', `item 8 (${point}): realised and settled before the removal (${r.view.state})`);
      await crashAt(ctx, world, point, async () => { await L.call('dev.region.remove', { region, requester: OWNER }, 600_000); });
      const rm = await removeWait(ctx, region).catch((e) => ({ state: `error ${e.message}` }));
      await sleep(3000);
      const df = await diff(ctx, box, file);
      out[tag] = { removal: rm.state, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
      check(rm.state === 'REMOVED' && df.mismatches === 0, `item 8 (${point}${tag === 'fl5' ? ': the head drained, the tail not yet' : ': between the drain and the solids'}): settle at start finishes the removal: ${rm.state}, E-flat ${df.mismatches}`, df.sample);
    }
    await L.leaveWorld();
  }
  return out;
}

// ------------------------------------------------------------------ item 18 (a): the freezing probe on the cold site (recorded)

/**
 * Item 18 (a), recorded: on the frozen site 2026101102, a /fill-built course over the site's own ground: a source pool, a 3-high fall and
 * a 1-cell spillway into a lower pool, all open (unlit), and the same with a slab-roofed (capped) upper pool; 2 minutes at random ticks
 * 300: which cells froze (sources only, or flowing and falling cells too). Decides §1.7 (recorded, not judged).
 */
export async function cold(ctx) {
  const { L, check, json, log } = ctx;
  const base = await L.seedBase('2026101102');
  await L.fresh('G6B HY Cold', base);
  await L.setRules('exact');
  // the frozen claim H-a used (its pond froze at its surface): the probe stands near its centre, on the site's ground
  const X = 4200, Z = 1520;
  const g = await groundOf(ctx, [X - 8, Z - 8, X + 24, Z + 8]);
  const s = g + 8;
  await L.cmd(`/fill ${X - 1} ${g + 1} ${Z - 2} ${X + 20} ${s} ${Z + 2} minecraft:stone`);
  // upper pool x X..X+4 at s, the lip at X+5, the column at X+6 down into the lower pool (surface s-3) x X+6..X+11; a spillway lip at
  // X+12 onto a third pool (surface s-4) X+13..X+18
  await L.cmd(`/fill ${X} ${s} ${Z - 1} ${X + 4} ${s} ${Z + 1} minecraft:water`);
  await L.cmd(`/fill ${X + 5} ${s} ${Z - 1} ${X + 5} ${s} ${Z + 1} minecraft:air`);
  await L.cmd(`/fill ${X + 6} ${s - 3} ${Z - 1} ${X + 11} ${s} ${Z + 1} minecraft:air`);
  await L.cmd(`/fill ${X + 6} ${s - 4} ${Z - 1} ${X + 11} ${s - 3} ${Z + 1} minecraft:water`);
  await L.cmd(`/fill ${X + 12} ${s - 3} ${Z - 1} ${X + 12} ${s - 3} ${Z + 1} minecraft:air`);
  await L.cmd(`/fill ${X + 13} ${s - 5} ${Z - 1} ${X + 18} ${s - 3} ${Z + 1} minecraft:air`);
  await L.cmd(`/fill ${X + 13} ${s - 5} ${Z - 1} ${X + 18} ${s - 4} ${Z + 1} minecraft:water`);
  await L.call('dev.fluid.tick', { cells: [[X + 4, s, Z], [X + 11, s - 3, Z]] }, 10_000);
  await sleep(10_000);
  const box = [X - 2, g, Z - 3, X + 21, s + 2, Z + 3];
  const before = await fluidsIn(ctx, box);
  await L.cmd('/gamerule random_tick_speed 300');
  await L.gameWait(120_000, { real: sleep, label: 'hy item 18 (a) freezing probe, 2 minutes' });
  await L.cmd('/gamerule random_tick_speed 0');
  const after = await fluidsIn(ctx, box);
  const froze = { source: 0, flowing: 0, falling: 0, sourceCells: 0, flowingCells: 0 };
  for (const [k, st] of before) {
    const lv = /level=(\d+)/.exec(st);
    const kind = !lv || lv[1] === '0' ? 'source' : Number(lv[1]) >= 8 ? 'falling' : 'flowing';
    if (kind === 'source') froze.sourceCells++; else froze.flowingCells++;
    if (after.get(k) === 'minecraft:ice') froze[kind]++;
  }
  log(`  item 18 (a), recorded: after 2 minutes at random ticks 300 on 2026101102: ${json(froze)}`);
  check(true, `item 18 (a) (recorded): freezing on the cold site: ${froze.source} of ${froze.sourceCells} source cells froze, ${froze.flowing + froze.falling} of ${froze.flowingCells} flowing or falling cells (§1.7's assumption: sources only: ${froze.flowing + froze.falling === 0})`);
  await L.leaveWorld();
  return { froze };
}
