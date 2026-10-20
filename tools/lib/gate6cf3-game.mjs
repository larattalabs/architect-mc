// (6c F3) The in-game half of slice F3's gate (docs/CONTRACT.md "Phase 6c slice F3" §10 items 3, 4, 5, 6, 8; headless, $0).
//
//   realiseF3(ctx, tag, fx, o)  one fixture through Regions.checkPlan (the two-plan flow where a volume or a body asks for it, load:
//                               generate) and Regions.realiseApproved: READY, PLACED; every grown form's realised cell equal to its
//                               baked cell by state (leaves' distance and persistent, mushroom faces, dripstone thickness, axes);
//                               item 8 on the dump (vanilla's leaf distance, faces and thickness recomputed over the realised world);
//                               M18 and M19 on the dump; the realised M3 (no floating cell); the light-engine share of the realise's
//                               ticks (recorded); then (o.stand) a stand at default random ticks: 0 written leaf changed, M18 0, 0
//                               dripstone grown, 0 coral dead; (o.drift) player-like changes; then Regions.remove: E-flat (or, o.site, a
//                               natural site's E-normal with the narrowed classes and 0 classified cells within 8 of a form's columns).
// ctx: {L, OUT, KIT, imp, json, root, check, log, core} as tools/gate6ckc.mjs builds it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const GROWN = new Set(['giantTree', 'giantMushroom', 'stalactites', 'roots', 'coral']);

/** A fixture by its path under kit/test/fixtures/plan. */
export function fixture(ctx, rel) {
  return JSON.parse(fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'plan', rel), 'utf8'));
}

/** Normalise a block state to `name[k=v,...]` with every property (the kit's defaults filled), so the kit's and the game's spellings compare. */
export async function normalizer(ctx) {
  const { normalize } = await ctx.imp('lib/blocks.mjs');
  const memo = new Map();
  return (s) => {
    if (s == null) return 'minecraft:air';
    let v = memo.get(s);
    if (v !== undefined) return v;
    const m = /^([a-z0-9_:]+)(?:\[([^\]]*)\])?$/.exec(String(s).trim());
    try {
      const props = {};
      if (m?.[2]) for (const kv of m[2].split(',')) { const [k, x] = kv.split('='); props[k] = x; }
      const n = normalize(m[1], props);
      const ks = Object.keys(n.props).sort();
      v = ks.length ? `${n.name}[${ks.map((k) => `${k}=${n.props[k]}`).join(',')}]` : n.name;
    } catch { v = String(s); }
    memo.set(s, v);
    return v;
  };
}

/** The grown forms' baked cells of an IR (decoded from the plan dir's blobs): Map("x,y,z" -> state) plus each form's columns. */
export async function grownCells(ctx, planDir, ir) {
  const { decodeVoxels, voxelAt } = await ctx.imp('lib/region/voxels.mjs');
  const cells = new Map(), byForm = [];
  const opsOf = (pi) => ir.parts[pi]?.ops ?? [];
  // the IR's ops in part order; a form's `ops` are global indexes
  const flat = [];
  ir.parts.forEach((p, pi) => p.ops.forEach((o, oi) => flat.push({ o, pi, oi })));
  void opsOf;
  for (const f of ir.forms ?? []) {
    if (!GROWN.has(f.generator)) continue;
    const mine = new Map();
    for (const gi of f.ops ?? []) {
      const op = flat[gi]?.o;
      if (!op || op.op !== 'voxels') continue;
      const sha = ir.blobs?.[op.blob]?.sha ?? ir.blobs?.[op.blob];
      const file = path.join(planDir, 'blobs', `${typeof sha === 'string' ? sha : op.blob}.bin`);
      const v = decodeVoxels(fs.readFileSync(file));
      for (let i = 0; i < v.count; i++) {
        const [x, y, z] = voxelAt(v, i);
        const k = `${x + op.origin[0]},${y + op.origin[1]},${z + op.origin[2]}`;
        const s = v.palette[v.pal[i]];
        mine.set(k, s);
        cells.set(k, s);
      }
    }
    byForm.push({ id: f.id, generator: f.generator, columns: f.columns ?? [], cells: mine });
  }
  return { cells, byForm };
}

/** The bounding box of a cell map grown by `g`: [x0, y0, z0, x1, y1, z1]. */
export function boxOfCells(cells, g = 1) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (const k of cells.keys()) { const c = k.split(',').map(Number); for (let i = 0; i < 3; i++) { if (c[i] < a[i]) a[i] = c[i]; if (c[i] > b[i]) b[i] = c[i]; } }
  return [a[0] - g, Math.max(-64, a[1] - g), a[2] - g, b[0] + g, Math.min(319, b[1] + g), b[2] + g];
}

/** A dump of `box` from the game, decoded: {at(x, y, z) -> state | null, raw}. */
export async function dumpOf(ctx, box, name) {
  const { decodeArwd } = await ctx.imp('lib/region/vworld.mjs');
  const file = path.join(ctx.OUT, `${name}.arwd.gz`);
  await ctx.L.call('dev.region.dump', { box, file }, 1_800_000);
  const d = await decodeArwd(fs.readFileSync(file));
  const inBox = (x, y, z) => x >= d.box.minX && x <= d.box.maxX && y >= d.box.minY && y <= d.box.maxY && z >= d.box.minZ && z <= d.box.maxZ;
  return { d, file, stateAt: (x, y, z) => { if (!inBox(x, y, z)) return null; const s = d.palette[d.cells[d.at(x, y, z)]]; return s === 'minecraft:air' || s === 'minecraft:cave_air' || s === 'minecraft:void_air' ? null : s; } };
}

/** Item 8 and M18/M19 over a dump: vanilla's distance, faces and thickness recomputed over the realised world at every grown cell. */
export async function statesOnDump(ctx, cells, dump) {
  const S = await ctx.imp('lib/forms/states.mjs');
  const { formRules } = await ctx.imp('lib/region/checkForms.mjs');
  const norm = await normalizer(ctx);
  const get = (x, y, z) => dump.stateAt(x, y, z);
  let faceOff = 0, dripOff = 0, faces = 0, drips = 0;
  const sample = [];
  for (const k of cells.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    const s = dump.stateAt(x, y, z);
    if (!s) continue;
    if (S.isMushroomBlock(s)) {
      faces++;
      const n = S.nameOf(s), p = {};
      for (const [f, dx, dy, dz] of [['east', 1, 0, 0], ['west', -1, 0, 0], ['up', 0, 1, 0], ['down', 0, -1, 0], ['south', 0, 0, 1], ['north', 0, 0, -1]]) { const o = get(x + dx, y + dy, z + dz); p[f] = o && S.nameOf(o) === n ? 'false' : 'true'; }
      if (norm(S.withProps(s, p)) !== norm(s)) { faceOff++; if (sample.length < 6) sample.push([k, s]); }
    } else if (S.isDripstone(s)) {
      drips++;
      const t = S.dripstoneThickness(k, s, get);
      if (!new RegExp(`thickness=${t}`).test(s)) { dripOff++; if (sample.length < 6) sample.push([k, s, t]); }
    }
  }
  const isWater = (x, y, z) => { const s = dump.stateAt(x, y, z); return !!s && (/^minecraft:(water|bubble_column)/.test(s) || /waterlogged=true/.test(s)); };
  const rules = formRules({ each: (fn) => { for (const k of cells.keys()) { const [x, y, z] = k.split(',').map(Number); const s = dump.stateAt(x, y, z); if (s) fn(x, y, z, s, 0); } }, stateAt: get, isWater });
  return { faces, faceOff, drips, dripOff, sample, M18: rules.metrics.M18, M19: rules.metrics.M19, m18: [...rules.m18.values()].flat().slice(0, 8), m19: [...rules.m19.values()].flat().slice(0, 8) };
}

/** Build a fixture's world: the terrain over the flat base (core's buildTerrain), its frozen-volume edits carved (AIR, WATER, ...). */
export async function buildWorld(ctx, fx) {
  const B = await import('./gate6chy-b.mjs');
  let T = B.terrainOf(fx);
  const edits = fx.volume?.edits ?? [];
  if (edits.length) {
    // a cave under the ground: the terrain stands high enough over the flat base that the lowest edit has 4 solid layers under it
    const lo = Math.min(...edits.map((e) => e.box[1])) - 4;
    T = { ...T, bands: [...T.bands, { x0: T.x0 + T.W + 100, x1: T.x0 + T.W + 100, z0: T.z0 + T.D + 100, z1: T.z0 + T.D + 100, y: lo }] };
  }
  const W = await B.buildTerrain(ctx, T);
  for (const e of edits) {
    const [x0, y0, z0, x1, y1, z1] = e.box;
    const block = e.class === 'AIR' ? 'minecraft:air' : e.class === 'WATER' ? 'minecraft:water' : e.class === 'LAVA' ? 'minecraft:lava' : e.class === 'ROCK' ? 'minecraft:stone' : 'minecraft:dirt';
    const wb = [x0 + W.dx, y0 + W.off, z0 + W.dz, x1 + W.dx, y1 + W.off, z1 + W.dz];
    for (let y = wb[1]; y <= wb[4]; y++) {
      const per = (wb[3] - wb[0] + 1) * (wb[5] - wb[2] + 1);
      const zs = Math.max(1, Math.floor(32768 / (wb[3] - wb[0] + 1)));
      for (let z = wb[2]; z <= wb[5]; z += zs) await ctx.L.cmd(`/fill ${wb[0]} ${y} ${z} ${wb[3]} ${y} ${Math.min(wb[5], z + zs - 1)} ${block}`);
      void per;
    }
  }
  if (edits.length) await ctx.L.settle(2000);
  return { W, T };
}

/** dev.mspt.trace's stop answer as the light-engine share: the time of ticks with no Architect write over all ticks' time (recorded). */
function lightShare(tr) {
  const all = tr?.all ?? tr?.ticks ?? null, none = tr?.withoutWrites ?? tr?.noWrites ?? tr?.without ?? null;
  const tot = (q) => (q && Number.isFinite(q.mean) && Number.isFinite(q.ticks ?? q.count) ? q.mean * (q.ticks ?? q.count) : null);
  const a = tot(all), n = tot(none);
  return a && n !== null ? Math.round((1000 * n) / a) / 1000 : null;
}

/**
 * One fixture in game (see the header). `o`: {base (the world to clone, default the flat base), rules ('exact' | 'default'), stand
 * (seconds at default random ticks, recorded or judged), drift (async (r, info) => evidence: player-like changes before the removal),
 * expectKept (cells the removal must keep: a player's), site (a natural claim [x0, z0, x1, z1]: no terrain, E-normal), control (a no-region
 * control's classes on a natural site), after (async (r, info) => more checks), quiet}.
 */
export async function realiseF3(ctx, tag, fx, o = {}) {
  const { L, json, core } = ctx;
  const check = o.quiet ? (ok, m, d) => ctx.check(true, `(recorded${ok ? '' : ', not as predicted'}) ${m}`, d) : ctx.check;
  const B = await import('./gate6chy-b.mjs');
  const out = { tag };
  await L.fresh(`G6B F3 ${tag}`, o.base ?? core.FLAT);
  await L.setRules(o.rules ?? 'exact');
  let W;
  if (o.site) {
    const c = o.site;
    await L.tp((c[0] + c[2]) / 2, 200, (c[1] + c[3]) / 2);
    await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
    W = { claim: c, dx: 0, dz: 0, off: 0 };
  } else ({ W } = await buildWorld(ctx, fx));
  const wp = await B.worldPlan(ctx, fx, W);
  // (a natural site: the world's own random ticks stopped while the plan reads it, as F1's forms_demo plans under /tick freeze)
  const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: core.OWNER, anchors: wp.anchors, load: 'generate', ...(o.bible ? { bible: o.bible } : {}) }, 1_800_000);
  fs.writeFileSync(path.join(ctx.OUT, `f3-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const parts = (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]);
  out.check = { overall: ck.check?.overall ?? null, parts, volumePass: ck.volumePass ?? null, notes: (ck.check?.notes ?? []).filter((n) => /volume/.test(n)) };
  check(ck.check?.overall === 'READY' && parts.every(([, k]) => k === 'fits' || k === 'adjusted'), `item 3 (${tag}): Regions.checkPlan${out.check.notes.length ? ' (the two-plan flow: ' + out.check.notes.join('; ') + ')' : ''}: ${ck.check?.overall} ${json(parts)}`);
  if (ck.check?.overall !== 'READY') { await L.leaveWorld(); return out; }
  // the box: the claim (+ 8; a natural site: the parts' rects + 12) from 30 under the lowest ground to 70 over the highest (a 64-high tree,
  // a cave 20 under), for the snapshot, the dumps and the removal's diff
  let gy0 = W.minY ?? null, gy1 = W.maxY ?? null;
  if (gy0 === null || gy1 === null) {
    const sv = path.join(ctx.OUT, `f3-${tag}-survey.bin`);
    await L.call('dev.region.survey', { claim: W.claim, surveyLoad: 'bounded:256', file: sv }, 600_000);
    const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
    const S = surveyApi(fs.readFileSync(sv), { minX: W.claim[0], minZ: W.claim[1], maxX: W.claim[2], maxZ: W.claim[3], minY: -64, maxY: 319 });
    gy0 = 320; gy1 = -64;
    for (let x = W.claim[0]; x <= W.claim[2]; x += 2) for (let z = W.claim[1]; z <= W.claim[3]; z += 2) { gy0 = Math.min(gy0, S.floorAt(x, z)); gy1 = Math.max(gy1, S.groundAt(x, z)); }
  }
  let rect = [W.claim[0] - 8, W.claim[1] - 8, W.claim[2] + 8, W.claim[3] + 8];
  if (o.site) {
    const rs = (ck.check.parts ?? []).map((a) => a.geometry?.rect).filter(Array.isArray);
    if (rs.length) rect = [Math.min(...rs.map((q) => q[0])) - 12, Math.min(...rs.map((q) => q[1])) - 12, Math.max(...rs.map((q) => q[2])) + 12, Math.max(...rs.map((q) => q[3])) + 12];
  }
  const box = [rect[0], Math.max(-64, gy0 - 30), rect[1], rect[2], Math.min(319, gy1 + 70), rect[3]];
  out.box = box;
  if (o.rules !== 'exact' && o.rules) await L.cmd('/kill @e[type=!minecraft:player]');
  const snapF = await core.snap(ctx, box, `f3-${tag}`);
  const before = await dumpOf(ctx, box, `f3-${tag}-before`);
  await L.call('dev.mspt.trace', { start: true }, 30_000).catch(() => null);
  const r = await core.realiseApproved(ctx, ck.check.artifactSha);
  const tr = await L.call('dev.mspt.trace', { stop: true }, 30_000).catch(() => null);
  if (r.refused) { check(false, `item 3 (${tag}): realiseApproved refused (${json(r.refused)})`); await L.leaveWorld(); return out; }
  out.realise = { region: r.region, planId: r.planId, state: r.view.state, fluids: r.fluids.map((x) => [x.part, x.body, x.state]), lightShare: lightShare(tr), trace: tr };
  const g = await grownCells(ctx, path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId), r.ir);
  check(r.view.state === 'PLACED' && r.fluids.every((x) => x.state === 'settled'), `item 3 (${tag}): realised from the approved artifact: ${r.view.state}${r.fluids.length ? `, bodies ${json(out.realise.fluids)}` : ''}; ${g.byForm.length} grown form(s), ${g.cells.size} cells (light-engine share of the realise's ticks: ${out.realise.lightShare ?? 'n/a'}, recorded)`);
  // the realised cells against the baked ones, by state
  const norm = await normalizer(ctx);
  const after = await dumpOf(ctx, box, `f3-${tag}-after`);
  let same = 0;
  const off = [];
  for (const [k, s] of g.cells) { const [x, y, z] = k.split(',').map(Number); const t = after.stateAt(x, y, z) ?? 'minecraft:air'; if (norm(t) === norm(s)) same++; else if (off.length < 12) off.push([k, s, t]); }
  out.states = { cells: g.cells.size, same, off };
  check(same === g.cells.size, `item 3 (${tag}): every grown cell realised as baked, by state (leaves' distance and persistent, mushroom faces, dripstone thickness, axes): ${same}/${g.cells.size}`, off);
  const st = await statesOnDump(ctx, g.cells, after);
  out.item8 = st;
  check(st.faceOff === 0 && st.dripOff === 0 && st.M18.distanceOff === 0 && st.M18.decaying === 0 && st.M19.dead === 0,
    `item 8 (${tag}): on the realised world, vanilla's rule recomputed: ${st.faces} mushroom cells' faces (${st.faceOff} off), ${st.drips} dripstone thicknesses (${st.dripOff} off), ${st.M18.leaves} leaves' distance (${st.M18.distanceOff} off); M18 ${st.M18.decaying}, M19 ${st.M19.dead} (of ${st.M19.corals} coral)`, st.sample);
  // the realised M3: no floating cell of a grown form (the dump-backed world over the plan's virtual world)
  let written = null;
  {
    const { dumpWorld, buildVirtual } = await ctx.imp('lib/region/vworld.mjs');
    const { checkRegion } = await ctx.imp('lib/region/check.mjs');
    const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
    const blobs = (sha) => { const f = path.join(dir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
    const { decodeArvx } = await ctx.imp('lib/region/volume.mjs');
    const vdir = path.join(dir, 'volumes');
    const volumes = fs.existsSync(vdir) ? fs.readdirSync(vdir).map((f) => decodeArvx(fs.readFileSync(path.join(vdir, f)))) : [];
    const { vw: virtual } = buildVirtual({ ir: r.ir, survey: fs.readFileSync(path.join(dir, 'survey.bin')), blobs, volumes });
    // (the region's written cells: after a stand at default random ticks the world's own drift at unwritten cells is classified, never
    // at a written one)
    written = new Set();
    virtual.eachWritten((x, y, z) => written.add(`${x},${y},${z}`));
    const claim = { ...r.ir.claim };
    const world = dumpWorld(before.d, after.d, claim, { virtual, lots: r.ir.lots ?? [] });
    const rep = checkRegion({ ir: r.ir, survey: fs.readFileSync(path.join(dir, 'survey.bin')), blobs, volumes, world, rules: ['M3'] });
    const grownIds = new Set(g.byForm.map((f) => f.id));
    const fl = rep.findings.filter((f) => /^M3(:gravity|:floating_spur)?$/.test(f.rule) && (f.part === null || grownIds.has(f.part)));
    out.m3 = fl.map((f) => [f.rule, f.part, f.count]);
    check(fl.length === 0, `item 4 (${tag}): the realised M3: 0 floating or unsupported grown cells (branches on trunks, stalactites on ceilings): ${json(out.m3)}`);
  }
  if (o.after) out.after = await o.after(r, { g, after, box, W, ck });
  // ---- the stand (item 4): default random ticks
  if (o.stand) {
    await L.cmd('/gamerule random_tick_speed 3');
    await L.cmd('/gamerule advance_time true');
    const drips0 = [...g.cells.values()].filter((s) => /pointed_dripstone/.test(s)).length;
    await sleep(o.stand * 1000);
    await L.cmd('/gamerule random_tick_speed 0');
    await L.cmd('/gamerule advance_time false');
    const stood = await dumpOf(ctx, boxOfCells(g.cells, 3), `f3-${tag}-stood`);
    let leafChanged = 0, changed = 0;
    const ch = [];
    for (const [k, s] of g.cells) {
      const [x, y, z] = k.split(',').map(Number);
      const t = stood.stateAt(x, y, z) ?? 'minecraft:air';
      if (norm(t) !== norm(after.stateAt(x, y, z) ?? 'minecraft:air')) { changed++; if (/_leaves/.test(s)) leafChanged++; if (ch.length < 12) ch.push([k, s, t]); }
    }
    // a pointed dripstone grown: one in the box the realise did not write
    const bx = boxOfCells(g.cells, 3);
    let dripNow = 0;
    for (let x = bx[0]; x <= bx[3]; x++) for (let y = bx[1]; y <= bx[4]; y++) for (let z = bx[2]; z <= bx[5]; z++) { const s = stood.stateAt(x, y, z); if (s && /pointed_dripstone/.test(s)) dripNow++; }
    const st2 = await statesOnDump(ctx, g.cells, stood);
    out.stand = { seconds: o.stand, changed, leafChanged, sample: ch, drips0, dripNow, M18: st2.M18, M19: st2.M19 };
    check(leafChanged === 0 && st2.M18.decaying === 0 && dripNow <= drips0 && st2.M19.dead === 0 && changed === 0,
      `item 4 (${tag}): after a ${o.stand} s stand at default random ticks: ${changed} grown cell(s) changed (${leafChanged} leaves), M18 ${st2.M18.decaying}, pointed dripstone ${drips0} -> ${dripNow} (none grown), M19 ${st2.M19.dead} (0 live coral dead)`, ch);
  }
  if (o.drift) out.drift = await o.drift(r, { g, after, box, W, norm });
  // ---- the removal
  const rm = await core.removeWait(ctx, r.region);
  await sleep(3000);
  const df = await ctx.L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const list = df.list ?? [];
  if (o.site) {
    // E-normal (§10 item 5): the narrowed classes (D2's decay of a natural non-persistent leaf, flow, live, F2's distant, VOC's farfluid),
    // each at an unwritten cell far from the plan; 0 unclassified; 0 classified cells within 8 of a form's columns
    const cols = new Set();
    for (const f of g.byForm) for (let i = 0; i < f.columns.length; i += 3) for (let x = f.columns[i + 1]; x <= f.columns[i + 2]; x++) cols.add(`${x},${f.columns[i]}`);
    const near8 = (x, z) => { for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (cols.has(`${x + dx},${z + dz}`)) return true; return false; };
    const written = g.cells;
    const farFrom = (x, y, z, d) => { for (const k of written.keys()) { const [a, b, c] = k.split(',').map(Number); if (Math.abs(a - x) + Math.abs(b - y) + Math.abs(c - z) < d) return false; } return true; };
    const isFluid = (s) => /^minecraft:(water|lava)\[level=[1-9]/.test(String(s ?? '')) || /^minecraft:(water|lava)\[level=1[0-5]/.test(String(s ?? ''));
    const isAirish = (s) => /^minecraft:(air|cave_air)$/.test(String(s ?? ''));
    const classes = {};
    const bad = [], nearCls = [];
    for (const m of list) {
      const [x, y, z] = String(m.pos).split(',').map(Number);
      let c = m.class;
      if (c === 'none') {
        if ((isAirish(m.was) || isFluid(m.was)) && (isAirish(m.now) || isFluid(m.now)) && (isFluid(m.was) || isFluid(m.now)) && !written.has(m.pos) && farFrom(x, y, z, 8)) c = 'farfluid';
        else if (/_leaves\[/.test(String(m.was)) && /persistent=false/.test(String(m.was)) && isAirish(m.now) && !written.has(m.pos) && farFrom(x, y, z, 8)) c = 'decay';
        else if (/_leaves\[/.test(String(m.was)) && /_leaves\[/.test(String(m.now)) && String(m.was).replace(/distance=\d/, '') === String(m.now).replace(/distance=\d/, '') && !written.has(m.pos) && farFrom(x, y, z, 8)) c = 'distant';
      }
      classes[c] = (classes[c] ?? 0) + 1;
      if (c === 'none') bad.push(m);
      else if (near8(x, z)) nearCls.push({ ...m, class: c });
    }
    out.undo = { state: rm.state, kept: rm.kept, mismatches: df.mismatches, classes, unclassified: bad.slice(0, 12), near: nearCls.slice(0, 12), control: o.control ?? null };
    check(rm.state === 'REMOVED' && bad.length === 0 && nearCls.length === 0, `item 5 (${tag}): Regions.remove on the natural site, E-normal: ${df.mismatches} mismatch(es) ${json(classes)}, ${bad.length} unclassified, ${nearCls.length} classified within 8 of a form's columns (control: ${json(o.control?.classes ?? null)})`, { bad: bad.slice(0, 8), near: nearCls.slice(0, 8) });
  } else {
    const keep = typeof o.expectKept === 'function' ? o.expectKept(out.drift) : o.expectKept ?? [];
    const left = list.map((m) => m.pos);
    if (!o.stand) {
      out.undo = { state: rm.state, kept: rm.kept, mismatches: df.mismatches, classes: df.classes ?? {}, left: left.slice(0, 12) };
      check(rm.state === 'REMOVED' && df.mismatches === keep.length && keep.every((k) => left.includes(k)), `item ${o.drift ? 6 : 3} (${tag}): Regions.remove restores the box exactly under the exact rules: E-flat ${df.mismatches}${keep.length ? ` (the player's ${keep.length} cell(s) kept: ${keep.join(' ')})` : ''}, kept ${rm.kept ?? 'n/a'} (${rm.seconds} s)`, list.slice(0, 8));
    } else {
      // after a stand at default random ticks: every written cell restored exactly (E-flat over the region's cells: 0, but the player's
      // kept ones), and every mismatch at an unwritten cell the world's own (classified: grass spreading, a sapling, a sheep), none unexplained
      const atWritten = list.filter((m) => written?.has(m.pos) && !keep.includes(m.pos));
      const unexplained = list.filter((m) => !written?.has(m.pos) && !keep.includes(m.pos) && !['growth', 'grazed', 'live'].includes(m.class));
      out.undo = { state: rm.state, kept: rm.kept, mismatches: df.mismatches, classes: df.classes ?? {}, atWritten: atWritten.slice(0, 12), nWritten: atWritten.length, unexplained: unexplained.slice(0, 12), keptLeft: keep.filter((k) => left.includes(k)) };
      check(rm.state === 'REMOVED' && atWritten.length === 0 && unexplained.length === 0 && keep.every((k) => left.includes(k)),
        `item ${o.drift ? 6 : 4} (${tag}): Regions.remove after the stand${o.drift ? ' and the drift' : ''}: E-flat over the region's ${written?.size ?? '?'} written cells ${atWritten.length}${keep.length ? ` (the player's ${keep.length} cell(s) kept: ${keep.join(' ')})` : ''}; ${df.mismatches - atWritten.length - keep.length} unwritten cell(s) the world's own drift ${JSON.stringify(df.classes ?? {})}, ${unexplained.length} unexplained; kept ${rm.kept ?? 'n/a'} (${rm.seconds} s)`, { atWritten: atWritten.slice(0, 6), unexplained: unexplained.slice(0, 6) });
    }
  }
  await L.leaveWorld();
  return out;
}

export { pathToFileURL };
