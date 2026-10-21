// (6c RS-b) The in-game half of RS-b's rows (docs/HANDOFF-RS.md "The split"; docs/CONTRACT.md "Phase 6c slice RS" §13): a fixture built
// in survival with hooks (a freezing biome over its claim, a sample per poll, the conservation sum, a hook before its removal), the tunnel's
// ring evidence (no bore cell open without its paid neighbours, ring by ring rather than course by course), the half-built checks (runs,
// open cuts, the kit's checker over the world as it stands) and the lava rows. Builds on tools/lib/gate6crs-game.mjs (RS-a's).
import fs from 'node:fs';
import path from 'node:path';

const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

/** The lot entries a fixture binds (as tools/gate6crs.mjs entriesOf). */
export function entriesOf(fx) {
  if (fx.lotEntries) return fx.lotEntries;
  const out = {};
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.lots)) for (const l of o.lots) if (l?.id && l.type) out[l.id] = ['farm', 'smithy', 'barn'].includes(l.type) ? 'rs_shed' : 'rs_hut';
      Object.values(o).forEach(walk);
    }
  };
  walk(fx.plan?.zones ?? []);
  return out;
}

/** The fluid bodies' report (the region's ext architect_mc:fluids). */
export const bodiesOf = (st) => (st.view?.ext?.['architect_mc:fluids'] ?? []).map((b) => ({ body: b.body, state: b.state, reason: b.reason ?? null }));

/**
 * A fixture's biome (fx.biomes.palette[0], the kit's grid) over its claim in the world, by /fillbiome in 16x16x64 pieces (under the
 * command's block limit) round its anchors (64 each way) from 32 under the ground to 32 over it.
 */
export async function coldBiome(ctx, s, fx) {
  const biome = fx.biomes?.palette?.[0];
  if (!biome) return null;
  const [cx0, cz0, cx1, cz1] = s.W.claim;
  const as = Object.values(s.wp.anchors ?? {}).filter((a) => Array.isArray(a) && a.length === 3);
  const fxa = Object.keys(fx.anchors ?? {}).map((k) => s.wp.anchors[k]).filter(Boolean);
  const pts = fxa.length ? fxa : as;
  const x0 = Math.max(cx0, Math.min(...pts.map((a) => a[0])) - 64), x1 = Math.min(cx1, Math.max(...pts.map((a) => a[0])) + 64);
  const z0 = Math.max(cz0, Math.min(...pts.map((a) => a[2])) - 64), z1 = Math.min(cz1, Math.max(...pts.map((a) => a[2])) + 64);
  const y0 = Math.min(...pts.map((a) => a[1])) - 32, y1 = y0 + 63;
  let n = 0;
  for (let x = x0; x <= x1; x += 16) for (let z = z0; z <= z1; z += 16) {
    await ctx.L.cmd(`/fillbiome ${x} ${y0} ${z} ${Math.min(x1, x + 15)} ${y1} ${Math.min(z1, z + 15)} ${biome}`);
    n++;
  }
  await ctx.L.settle(1500);
  return { biome, box: [x0, y0, z0, x1, y1, z1], commands: n };
}

/** The INSTANT twin (G.twin's), with the fixture's biome set before the check. */
export async function twin(ctx, G, tag, fx, entries = {}) {
  const s = await G.site(ctx, `${tag} twin`, fx, { creative: true });
  await coldBiome(ctx, s, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const ck = await G.check(ctx, `${tag}-twin`, s);
  if (!ck.check?.artifactSha) throw new Error(`twin ${tag}: no artifact (${ck.check?.overall})`);
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  const st = await ctx.L.waitRegion(region, 3_600_000, async (x) => { if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(x?.view?.waiting?.reason)) await ctx.L.cmd('/kill @e[type=!minecraft:player]'); });
  const box = G.boxOf(s.W);
  const file = await G.snap(ctx, box, `rsb-${tag}-twin`);
  return { file, box, view: st.view, region, check: ck };
}

/**
 * Every target's queued cells now (dev.rs.cells): `at` pos -> flags (1 held, 2 built, 4 a cut). `open`: built cuts; `bad`: an open cut
 * with a paid neighbour (above it or beside it within 1, in any target) unbuilt: a bore open without its lining.
 */
export async function openCuts(ctx, region) {
  const cells = await ctx.L.call('dev.rs.cells', { region }, 300_000);
  const at = new Map();
  for (const t of cells.targets ?? []) for (const c of t.cells ?? []) at.set(`${c[0]},${c[1]},${c[2]}`, c[3]);
  const bad = [];
  for (const [k, f] of at) {
    if (!((f & 1) && (f & 2) && (f & 4))) continue;
    const [x, y, z] = k.split(',').map(Number);
    for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const g = at.get(`${x + dx},${y + dy},${z + dz}`);
      if (g !== undefined && !(g & 1) && !(g & 2)) bad.push(`${k} (its paid neighbour ${x + dx},${y + dy},${z + dz} unbuilt)`);
    }
  }
  return { at, cells: at.size, open: [...at.values()].filter((f) => (f & 1) && (f & 2) && (f & 4)).length, bad, targets: (cells.targets ?? []).map((t) => ({ target: t.target, part: t.part, n: (t.cells ?? []).length })) };
}

/**
 * The ring picture of a tunnel along `axis` (0: x, 2: z) from the cells' flags: per ring (the axis coordinate) the paid cells built and
 * all, the cuts open and all. `interleaved`: some ring's cut open while a later ring's lining is not yet built (ring by ring); `courses`:
 * every paid cell of the lowest course built while a cut is open nowhere (course by course would show this first).
 */
export function rings(at, axis = 0) {
  const by = new Map();
  for (const [k, f] of at) {
    const c = k.split(',').map(Number);
    const t = c[axis];
    const r = by.get(t) ?? { paid: 0, paidBuilt: 0, cuts: 0, open: 0 };
    if (f & 4 && f & 1) { r.cuts++; if (f & 2) r.open++; } else if (!(f & 1)) { r.paid++; if (f & 2) r.paidBuilt++; }
    by.set(t, r);
  }
  const ks = [...by.keys()].sort((a, b) => a - b);
  const openRings = ks.filter((t) => by.get(t).open > 0);
  const unbuiltRings = ks.filter((t) => by.get(t).paid > by.get(t).paidBuilt);
  const interleaved = openRings.length > 0 && unbuiltRings.length > 0;
  return { rings: ks.length, openRings: openRings.length, firstOpen: openRings[0] ?? null, lastOpen: openRings.at(-1) ?? null, firstUnbuilt: unbuiltRings[0] ?? null, lastUnbuilt: unbuiltRings.at(-1) ?? null, interleaved, paid: sum(Object.fromEntries(ks.map((t) => [t, by.get(t).paid]))), paidBuilt: sum(Object.fromEntries(ks.map((t) => [t, by.get(t).paidBuilt]))) };
}

/** No run started without its whole bill: a started, unfinished run's remaining bill held in stock (tools/gate6crs.mjs runsSafe). */
export async function runsSafe(ctx, G, region) {
  const rs = await G.rsState(ctx, region);
  const ps = await G.pileState(ctx);
  const bad = [];
  let started = 0;
  for (const t of rs.targets ?? []) {
    const cur = (t.runList ?? [])[t.currentRun];
    if (!cur) continue;
    if (cur.started && t.built < t.cells) {
      started++;
      for (const [it, n] of Object.entries(t.reserving ?? {})) if ((ps.stock?.[it] ?? 0) < n) bad.push(`${t.target} run ${t.currentRun} started with ${it} ${ps.stock?.[it] ?? 0} < its ${n}`);
    }
  }
  return { targets: (rs.targets ?? []).length, started, bad, runs: (rs.targets ?? []).map((t) => ({ target: t.target, part: t.part, runs: t.runs, currentRun: t.currentRun, maxRunStacks: t.maxRunStacks, capStacks: t.capStacks, built: t.built, cells: t.cells })) };
}

/** The kit's checker over the world as it stands (a dump of the box against the pre-realise dump): M3, M4, M8 and gravity. */
export async function standing(ctx, tag, ck, box, beforeFile) {
  const { decodeArwd, dumpWorld } = await ctx.imp('lib/region/vworld.mjs');
  const { checkRegion } = await ctx.imp('lib/region/check.mjs');
  const planDir = path.join(ctx.L.SIDECAR_DATA, 'regions', 'plans', ck.check.checkId);
  const ir = JSON.parse(fs.readFileSync(path.join(planDir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const afterFile = path.join(ctx.OUT, `rsb-${tag}-half.arwd.gz`);
  await ctx.L.call('dev.region.dump', { box, file: afterFile }, 1_800_000);
  const before = await decodeArwd(fs.readFileSync(beforeFile));
  const after = await decodeArwd(fs.readFileSync(afterFile));
  const world = dumpWorld(before, after, ir.claim, { lots: ir.lots });
  const rep = checkRegion({ ir, meta, world, prefix: false, blobs });
  const m = rep.metrics ?? {};
  const find = (re) => (rep.findings ?? []).filter((f) => re.test(f.rule)).reduce((a, f) => a + (f.count ?? 1), 0);
  return { M3: m.M3?.floatingCells ?? null, M4: m.M4?.breaches ?? null, M8: m.M8 ? m.M8.unguarded : null, gravity: find(/^M3:gravity/), spurs: find(/^M3:floating_spur/), tunnel: find(/^M[34]:tunnel/) };
}

/**
 * Feeds the owner's stockpile what its targets still lack (G.feed's rule), `fraction` of it a wave, calling `poll(st, rs)` (async) after
 * every poll; stops when `until(st, rs)` holds, the region fails, or `timeoutMs` passes. Returns {waves, inserted, last, polls}.
 */
export async function feed(ctx, G, region, { cons = null, fraction = 1, until = (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs = 2_400_000, every = 3000, poll = null, onWave = null } = {}) {
  const { L } = ctx;
  const end = Date.now() + timeoutMs;
  let waves = 0, inserted = {}, polls = 0;
  let st, rs;
  while (Date.now() < end) {
    st = await G.regionState(ctx, region);
    rs = await G.rsState(ctx, region);
    if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await L.cmd('/kill @e[type=!minecraft:player]');
    polls++;
    if (poll) await poll(st, rs);
    if (until(st, rs)) break;
    if (['FAILED', 'PARTIAL'].includes(st.view.state)) break;
    const ps = await G.pileState(ctx);
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = fraction >= 1 ? lack : Math.max(1, Math.floor(lack * fraction));
    }
    if (Object.keys(need).length) {
      const acc = cons ? await cons.insert(`stockpile:${G.OWNER}`, need) : (await L.call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
      inserted = G.plus(inserted, acc);
      waves++;
      if (onWave) await onWave(waves, need, acc);
    }
    await L.sleep(every);
  }
  return { waves, inserted, last: { st, rs }, polls };
}

/**
 * One fixture in survival (item 5's shape, tools/gate6crs.mjs buildOne) with RS-b's hooks: its INSTANT twin (the biome set), a survival
 * world (the biome set), checked, a stockpile of `crates`, realised, fed in waves of `fraction`, `poll` after every poll, every target and
 * lot BUILT and every body settled, the world equal to the twin cell for cell, the bills per part; `beforeRemove(ctx)` then
 * Regions.remove and E-flat. `cons`: the conservation sum at the realise, every other wave, built, before removal and removed.
 */
export async function buildFx(ctx, G, tag, name, { crates = 4, fraction = 0.5, cons = false, poll = null, beforeRemove = null, remove = true, every = 3000 } = {}) {
  const { check, json } = ctx;
  const fx = G.fixture(ctx, name);
  const entries = entriesOf(fx);
  const T = await twin(ctx, G, tag, fx, entries);
  const s = await G.site(ctx, tag, fx);
  const biome = await coldBiome(ctx, s, fx);
  if (Object.keys(entries).length) await G.designs(ctx);
  const box = G.boxOf(s.W);
  const pre = await G.snap(ctx, box, `rsb-${tag}-pre`);
  const beforeFile = path.join(ctx.OUT, `rsb-${tag}-before.arwd.gz`);
  await ctx.L.call('dev.region.dump', { box, file: beforeFile }, 1_800_000);
  const ck = await G.check(ctx, `b-${tag}`, s);
  const out = { tag, fixture: name, overall: ck.check?.overall, survival: ck.check?.survival, entries, biome };
  check(ck.check?.survival === true && ['READY', 'NEEDS_REPAIR'].includes(ck.check?.overall) && !!ck.check?.artifactSha, `(${tag}): Regions.checkPlan in survival: ${ck.check?.overall}, ${json((ck.check?.parts ?? []).map((a) => [a.part, a.class]))}`);
  const crateAt = await G.pile(ctx, s, crates);
  const C = cons ? new G.Conservation(ctx, box) : null;
  if (C) await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  if (C) await C.point('realised');
  const f = await feed(ctx, G, region, { cons: C, fraction, every, poll: poll ? (st, rs) => poll(st, rs, { region, C }) : null, onWave: async (w) => { if (C && w % 2 === 0) await C.point(`wave ${w}`); } });
  const st = f.last.st, rs = f.last.rs;
  out.feed = { waves: f.waves, inserted: f.inserted, polls: f.polls };
  out.state = st.view.state;
  out.build = rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent, parts: (rs.build.parts ?? []).map((p) => [p.part, p.state, p.targets.length, p.built, p.cells]) };
  out.bodies = bodiesOf(st);
  check(st.view.state === 'PLACED' && rs.build?.built && rs.build?.done && rs.build?.percent === 100, `(${tag}): realiseApproved and fed in ${f.waves} waves (${sum(f.inserted)} items): ${st.view.state}, build ${json(rs.build && { built: rs.build.built, done: rs.build.done, percent: rs.build.percent })}, every part built ${json((rs.build?.parts ?? []).map((p) => [p.part, p.state, p.targets.length]))}`);
  if (out.bodies.length) check(out.bodies.every((b) => b.state === 'settled'), `(${tag}): every body settled with its census after its barrier (${json(out.bodies)})`);
  if (C) await C.point('built');
  const bills = G.billsOf(ck, rs);
  // (the region whole: the targets' bills plus what the bodies charge when they are written, a lava bucket per source and a grate's
  // iron bars (RegionFluids' charges, not a target's bill): the check's cost.bom counts both)
  const charged = {};
  for (const a of ck.check?.parts ?? []) for (const [it, n] of Object.entries(a.cost?.survival?.charged ?? {})) charged[it] = (charged[it] ?? 0) + n;
  bills.got.__region__ = G.plus(bills.got.__region__, charged);
  bills.charged = charged;
  const differ = Object.keys({ ...bills.want, ...bills.got }).filter((p) => p in bills.want && !G.same(bills.want[p], bills.got[p]));
  out.bills = { ...bills, differ };
  check(differ.length === 0, `item 3 (${tag}): the check's cost.survival.bom against the targets' bills put down: ${differ.length ? `${differ.length} part(s) differ: ${differ.map((p) => `${p} ${json(G.minus(bills.want[p], bills.got[p]))}`).join('; ')}` : 'equal, item for item, for every part and the region whole'}`, bills);
  const d = await G.twinDiff(ctx, T.box, T.file, crateAt);
  out.twin = d;
  check(d.mismatches === 0, `(${tag}): the realised world equals its INSTANT twin cell for cell (the stockpile's crates aside): ${d.mismatches} differ`, d.list);
  const keep = { region, s, box, pre, crateAt, ck, rs, C, T, fx, beforeFile };
  if (beforeRemove) out.beforeRemove = await beforeRemove(keep);
  if (remove) {
    if (C) await C.point('before removal');
    const rm = await G.remove(ctx, region);
    out.removed = { removed: rm.removed, refund: rm.refund, kept: rm.kept };
    const e = await G.diff(ctx, box, pre);
    const ef = e.list.filter((m) => !crateAt.some((c) => c.join(',') === m.pos));
    out.eflat = { mismatches: ef.length, list: ef.slice(0, 8) };
    check(rm.removed && ef.length === 0, `(${tag}): Regions.remove: E-flat ${ef.length} (the crates aside)`, ef.slice(0, 8));
    if (C) await C.point('removed');
  }
  if (C) out.conservation = C.points;
  out.keep = keep;
  return out;
}
