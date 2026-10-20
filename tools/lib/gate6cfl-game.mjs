// (6c FL) The in-game items of slice FL (docs/CONTRACT.md "Phase 6c slice FL" §10 items 6, 7 and 13), headless but the look, $0. Every
// realise goes through Regions.checkPlan and realiseApproved with the approval artifact (never checkPlan alone: HY item 9, the H RC
// lesson), the lots bound to stub entries by the gate (realiseApproved's fill: the first that fits each lot).
// ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp, json, root, check, log, core (gate6chy-core.mjs), B (gate6chy-b.mjs)}.
//   item 6   v66, v67, v68, v70, v71 and s01 on fresh flat claims (their terrain built over the flat base): READY, PLACED, every lot's
//            site standing, every street road's batch item carrying architect_mc:street {zone} (S-FL-5), every entrance reached from
//            the bell and back by dev.nav.villager (100%), M5 under 1% over the walk cells (the realised dump's light), then
//            Regions.remove: E-flat 0
//   item 7   v69's program on S3's pinned claim's lower band: a no-region control first (S3's springs), then READY, PLACED, the walks,
//            removal E-normal 0 unclassified with D2's narrowed world classes (far, deep) and VOC's farfluid, reused exactly
//   item 13  the look (client, recorded): a ring with a hub, a spiral up a hill, a grid with its plaza, an organic hamlet, a ring round a
//            pond, in two bibles; the shots and a gallery manifest (fl-look/look.json)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const OWNER = 'test:fl';
/** The stub entries the gate binds (realiseApproved's fill: the first that fits each lot), largest first. */
export const STUBS = Object.freeze(['g6a_stub_24', 'g6a_stub_19', 'g6a_stub_14', 'g6a_stub_9']);
/** The look's entries: the kit's example buildings first (they read as buildings), the stubs after. */
export const LOOK_ENTRIES = Object.freeze(['tavern', 'gatehouse', 'tower', 'cabin', ...STUBS]);
/** Item 6's fixtures: every layout and around, the outlines, and the Steward-shaped grove. */
export const ITEM6 = Object.freeze([['v66', 'valid/v66_fl_ring.json'], ['v67', 'valid/v67_fl_around_pond.json'], ['v68', 'valid/v68_fl_grid.json'], ['v70', 'valid/v70_fl_spiral.json'], ['v71', 'valid/v71_fl_outline.json'], ['s01', 'fl/s01_steward_grove.json']]);

const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

/** Regions.remove as the gate's owner; waits for the region to finish going: {state, seconds, ...}. */
async function removeWait(ctx, region) {
  const L = ctx.L;
  const t0 = Date.now();
  const r = await L.call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  if (r?.refused) return { ...r, seconds: (Date.now() - t0) / 1000, state: `REFUSED ${r.refused}` };
  for (let i = 0; i < 2400; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s ?? 'REMOVED' };
    if (s === 'PARTIAL' || s === 'FAILED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s };
    await sleep(500);
  }
  throw new Error(`removal of ${region} did not finish`);
}

/** The flat base's own ground (no terrain built: a flat fixture stands on the world as it is, as H-a's ponds do). */
export const FLAT_SITE = Object.freeze({ X0: 9500, Z0: 9000 });

/** The plan's own files (the helper's plan dir): ir, meta, survey, blobs. */
function planFiles(L, planId) {
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const meta = fs.existsSync(path.join(dir, 'meta.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) : null;
  const survey = fs.readFileSync(path.join(dir, 'survey.bin'));
  const blobs = (s) => { const f = path.join(dir, 'blobs', `${s}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  return { dir, ir, meta, survey, blobs };
}

/** realiseApproved with the stub entries bound; the region waited for (mobs in a lot box killed). */
async function realiseStubbed(ctx, sha, fill = STUBS) {
  const { L } = ctx;
  const rr = await L.call('dev.region.realiseApproved', { sha, fill: [...fill] }, 300_000);
  if (rr.refused) return { refused: rr.refused };
  const st = await L.waitRegion(rr.region, 3_600_000, async (s) => { if (s.view?.waiting?.reason === 'OCCUPIED' || s.waiting?.OCCUPIED) await L.cmd('/kill @e[type=!minecraft:player]'); });
  return { region: rr.region, st, view: st.view };
}

/** Every entrance reached from the bell and back by vanilla's villager navigation (dev.nav.villager): {n, ok, bad}. */
async function walks(ctx, lots, bell) {
  const { L } = ctx;
  const out = { n: 0, ok: 0, bad: [] };
  for (const l of lots) {
    const e = l.entrance;
    const there = await L.call('dev.nav.villager', { from: bell, to: e, range: 512 }, 180_000).catch((x) => ({ error: String(x.message ?? x) }));
    const back = await L.call('dev.nav.villager', { from: e, to: bell, range: 512 }, 180_000).catch((x) => ({ error: String(x.message ?? x) }));
    out.n++;
    if (there.canReach && back.canReach) { out.ok++; continue; }
    // (a miss: what stands round the entrance, for the record: a 5 x 4 x 5 dump's blocks)
    let around = null;
    try {
      const f = path.join(ctx.OUT, `fl-walk-${l.id}.arwd.gz`);
      const box = [e[0] - 2, e[1] - 1, e[2] - 2, e[0] + 2, e[1] + 2, e[2] + 2];
      await L.call('dev.region.dump', { box, light: false, file: f }, 120_000);
      const { decodeArwd } = await ctx.imp('lib/region/vworld.mjs');
      const zlib = await import('node:zlib');
      const raw = fs.readFileSync(f);
      const d = await decodeArwd(raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw);
      around = [];
      for (let x = box[0]; x <= box[3]; x++) for (let y = box[1]; y <= box[4]; y++) for (let z = box[2]; z <= box[5]; z++) { const s = d.palette[d.cells[d.at(x, y, z)]]; if (!/:(air|cave_air)$/.test(s)) around.push([x, y, z, s]); }
    } catch (x) { around = String(x.message ?? x); }
    out.bad.push({ lot: l.id, entrance: e, bell, there: !!there.canReach, back: !!back.canReach, end: there.end ?? null, nodes: there.nodes ?? null, around });
  }
  return out;
}

/** M5 over the walk cells (the plan's walk-flagged cells, roads included) in the realised dump's light: {walkCells, dark, share, sample}. */
async function walkM5(ctx, files, beforeFile, afterFile, claim) {
  const { decodeArwd, dumpWorld, buildVirtual } = await ctx.imp('lib/region/vworld.mjs');
  const { walkDark } = await import(pathToFileURL(path.join(ctx.root, 'tools', 'lib', 'scenario-village.mjs')).href);
  const { vw } = buildVirtual({ ir: files.ir, survey: files.survey, blobs: files.blobs });
  const zlib = await import('node:zlib');
  const rd = (f) => { const b = fs.readFileSync(f); return b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b; };
  const before = await decodeArwd(rd(beforeFile)), after = await decodeArwd(rd(afterFile));
  const world = dumpWorld(before, after, { minX: claim[0], minZ: claim[1], maxX: claim[2], maxZ: claim[3] }, { virtual: vw, lots: files.ir.lots });
  return walkDark(world, vw, {});
}

/**
 * One fixture through the whole round (item 6): a fresh flat world, its terrain, checkPlan (generate), the artifact, realiseApproved with
 * the stubs, the lots, the street items, the walks, M5, then the removal and E-flat (or, `o.normal`, E-normal: item 7). Returns evidence.
 */
export async function realiseFl(ctx, tag, fx, o = {}) {
  const { L, core, B } = ctx;
  // (`quiet`: the look's realises: their checks are recorded, never failed: item 13 is recorded, not judged)
  const check = o.quiet ? (ok, m, d) => ctx.check(true, `(recorded${ok ? '' : ', not as predicted'}) ${m}`, d) : ctx.check;
  const out = { tag };
  await L.fresh(`G6B FL ${tag}`, o.base ?? core.FLAT);
  await L.setRules(o.rules ?? 'exact');
  await L.cmd('/weather clear');
  await L.cmd('/time set 6000');
  let W;
  // a flat fixture (on: flat, no terrain of its own) stands on the flat base as it is: its claim at FLAT_SITE, the fixture's own y moved
  // onto the world's ground (gate-built terrain is /fill'd blocks, which a body's shell may not take, H's LEAK: unwritable)
  const flatSite = !o.site && !fx.terrain && (fx.on === 'flat' || !fx.on);
  if (o.site || flatSite) {
    const T = flatSite ? B.terrainOf(fx) : null;
    const c = o.site ?? [FLAT_SITE.X0, FLAT_SITE.Z0, FLAT_SITE.X0 + T.W - 1, FLAT_SITE.Z0 + T.D - 1];
    await L.tp((c[0] + c[2]) / 2, 200, (c[1] + c[3]) / 2);
    await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
    const g = flatSite ? await core.groundOf(ctx, c) : null;
    W = { claim: c, dx: flatSite ? c[0] - T.x0 : 0, dz: flatSite ? c[1] - T.z0 : 0, off: flatSite ? g - T.y : 0 };
  } else W = await B.buildTerrain(ctx, B.terrainOf(fx));
  // the box's heights from the site's own survey
  const sv = path.join(ctx.OUT, `fl-${tag}-survey.bin`);
  await L.call('dev.region.survey', { claim: W.claim, surveyLoad: 'bounded:256', file: sv }, 600_000);
  const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
  const S = surveyApi(fs.readFileSync(sv), { minX: W.claim[0], minZ: W.claim[1], maxX: W.claim[2], maxZ: W.claim[3], minY: -64, maxY: 319 });
  let y0 = 320, y1 = -64;
  for (let x = W.claim[0]; x <= W.claim[2]; x += 2) for (let z = W.claim[1]; z <= W.claim[3]; z += 2) { y0 = Math.min(y0, S.floorAt(x, z)); y1 = Math.max(y1, S.groundAt(x, z)); }
  W.minY = y0; W.maxY = y1; W.S = S;
  const wp = o.plan ? { plan: o.plan, anchors: o.anchors ?? {} } : await B.worldPlan(ctx, fx, W);
  const anchors = { ...wp.anchors, ...(o.extraAnchors ?? {}) };
  const ck = await L.call('dev.region.checkPlan', { plan: wp.plan, claim: W.claim, owner: OWNER, anchors, load: 'generate', ...(o.bible ? { bible: o.bible } : {}) }, 1_800_000);
  fs.writeFileSync(path.join(ctx.OUT, `fl-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const parts = (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]);
  out.check = { overall: ck.check?.overall ?? null, parts, refused: ck.refused ?? null };
  const zones = (ck.check?.parts ?? []).filter((a) => a.geometry?.layout || a.geometry?.lots);
  check(ck.check?.overall === 'READY' && parts.every(([, k]) => k === 'fits' || k === 'adjusted'), `item ${o.item ?? 6} (${tag}): Regions.checkPlan in game: ${ck.check?.overall} ${json(parts)} (${zones.map((a) => `${a.part} ${a.geometry.layout ?? 'street'}`).join(', ')})`);
  if (ck.check?.overall !== 'READY') { await L.leaveWorld(); return out; }
  const sha = ck.check.artifactSha;
  let box = [W.claim[0] - 8, Math.max(-64, W.minY - 8), W.claim[1] - 8, W.claim[2] + 8, Math.min(319, W.maxY + 24), W.claim[3] + 8];
  if (o.normal) {
    // (E-normal on a natural site: the box round the parts' own rects grown by 12, not the whole claim, whose far side lives its own life)
    const rs = (ck.check.parts ?? []).map((a) => a.geometry?.rect).filter(Array.isArray);
    if (rs.length) box = [Math.max(W.claim[0] - 8, Math.min(...rs.map((q) => q[0])) - 12), box[1], Math.max(W.claim[1] - 8, Math.min(...rs.map((q) => q[1])) - 12), Math.min(W.claim[2] + 8, Math.max(...rs.map((q) => q[2])) + 12), box[4], Math.min(W.claim[3] + 8, Math.max(...rs.map((q) => q[3])) + 12)];
  }
  if (!o.noSnap) {
    await L.cmd('/kill @e[type=!minecraft:player]');
    out.snap = await core.snap(ctx, box, `fl-${tag}`);
  }
  const dumpBox = [W.claim[0], Math.max(-64, W.minY - 4), W.claim[1], W.claim[2], Math.min(319, W.maxY + 16), W.claim[3]];
  const beforeDump = path.join(ctx.OUT, `fl-${tag}-before.arwd.gz`);
  if (!o.noM5) await L.call('dev.region.dump', { box: dumpBox, file: beforeDump }, 1_800_000);
  const r = await realiseStubbed(ctx, sha, o.fill ?? STUBS);
  if (r.refused) { check(false, `item ${o.item ?? 6} (${tag}): realiseApproved refused (${json(r.refused)})`); await L.leaveWorld(); return out; }
  out.region = r.region;
  const lotsView = r.view.lots ?? [];
  const placed = lotsView.filter((l) => l.state === 'placed' || l.state === 'PLACED');
  out.realise = { state: r.view.state, lots: lotsView.length, placed: placed.length, states: [...new Set(lotsView.map((l) => l.state))] };
  check(r.view.state === 'PLACED' && lotsView.length > 0 && placed.length === lotsView.length, `item ${o.item ?? 6} (${tag}): realised from the approved artifact: ${r.view.state}, every lot's site standing (${placed.length} of ${lotsView.length}, stub entries bound)`, lotsView.filter((l) => !placed.includes(l)).slice(0, 6));
  // (S-FL-5) the street roads' batch items carry architect_mc:street {zone}
  const items = await L.call('dev.region.items', { region: r.region, owner: OWNER }, 30_000).catch((e) => ({ error: String(e.message ?? e), items: [] }));
  const streetItems = (items.items ?? []).filter((i) => /^road:(z\d+_)?street_/.test(i.key) || /^road:\w+_street(_[we])?(_\d+)?$/.test(i.key));
  const zoneIds = new Set(zones.map((a) => a.part));
  const marked = streetItems.filter((i) => zoneIds.has(i.ext?.['architect_mc:street']?.zone));
  out.streets = { items: streetItems.length, marked: marked.length, sample: streetItems.slice(0, 3).map((i) => [i.key, i.ext?.['architect_mc:street'] ?? null]) };
  check(streetItems.length > 0 && marked.length === streetItems.length, `item ${o.item ?? 6} (${tag}): every street road's batch item carries architect_mc:street {zone} (S-FL-5): ${marked.length} of ${streetItems.length} (${json(out.streets.sample)})`);
  // the walks: every entrance from the bell and back
  await L.cmd('/kill @e[type=!minecraft:player]');
  const w = { n: 0, ok: 0, bad: [] };
  for (const z of zones) {
    const bell = z.geometry.bell;
    const lots = z.geometry.lots ?? [];
    const c = z.geometry.rect;
    await L.tp((c[0] + c[2]) / 2, (bell?.[1] ?? 70) + 30, (c[1] + c[3]) / 2);
    await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
    const q = await walks(ctx, lots, bell);
    w.n += q.n; w.ok += q.ok; w.bad.push(...q.bad.map((b) => ({ zone: z.part, ...b })));
  }
  out.walks = w;
  check(w.n > 0 && w.ok === w.n, `item ${o.item ?? 6} (${tag}): every street and lane walkable by dev.nav.villager from every entrance to the bell and back: ${w.ok} of ${w.n} (100%)`, w.bad.slice(0, 6));
  // M5 over the walk cells (the realised world's light)
  if (!o.noM5) {
    const files = planFiles(L, r.view.planId);
    const afterDump = path.join(ctx.OUT, `fl-${tag}-after.arwd.gz`);
    await L.call('dev.region.dump', { box: dumpBox, light: true, file: afterDump }, 1_800_000);
    const m5 = await walkM5(ctx, files, beforeDump, afterDump, W.claim);
    out.M5 = { walkCells: m5.walkCells, dark: m5.dark, share: m5.share, sample: m5.sample.slice(0, 8) };
    check(m5.light && m5.walkCells > 0 && m5.share < 0.01, `item ${o.item ?? 6} (${tag}): M5 under 1% on the walk cells (streets, verges, lanes, the hub): ${(100 * m5.share).toFixed(2)}% (${m5.dark} of ${m5.walkCells} dark and spawnable)`, out.M5.sample);
  }
  if (o.after) out.after = await o.after(r, { W, ck, box, anchors });
  if (o.noUndo) { await removeWait(ctx, r.region).catch(() => null); await L.leaveWorld(); return out; }
  await L.cmd('/kill @e[type=!minecraft:player]');
  const rm = await removeWait(ctx, r.region);
  await sleep(3000);
  if (o.normal) {
    const files = planFiles(L, r.view.planId);
    const df = await L.call('dev.region.hash', { box, mode: 'diff', file: out.snap }, 4 * 3_600_000);
    const en = await normalClasses(ctx, df, files);
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: en.classes, worldBy: en.by, sample: en.list.slice(0, 12) };
    check(rm.state === 'REMOVED' && (en.classes.none ?? 0) === 0, `item 7 (${tag}): Regions.remove under the exact rules: E-normal ${df.mismatches} mismatch(es) ${json(en.classes)}, ${en.classes.none ?? 0} unclassified (D2's far and deep, VOC's farfluid; ${rm.seconds} s)`, out.undo.sample);
  } else {
    const df = await core.diff(ctx, box, out.snap);
    out.undo = { state: rm.state, seconds: rm.seconds, mismatches: df.mismatches, classes: df.classes, sample: df.sample };
    check(rm.state === 'REMOVED' && df.mismatches === 0, `item ${o.item ?? 6} (${tag}): Regions.remove restores the box exactly under the exact rules: E-flat ${df.mismatches} (${rm.seconds} s)`, df.sample);
  }
  await L.leaveWorld();
  return out;
}

/**
 * E-normal's world classes, D2's (tools/gate6cd.mjs, its natural removal's classes: copied unchanged) then VOC's farfluid
 * (tools/lib/gate6cvoc-b.mjs farFluidOf, imported): an unclassified mismatch is classed by its kind ONLY at a cell the plan never writes
 * and away from it (`far`: more than 6 columns from every written column and route cell; `deep`: more than 8 below both the surveyed
 * ground and every written cell within 6 columns); there water or lava `flow`, a natural leaf turned air `decay`, the same block in
 * another state `live`; a distance-7 leaf turned air `decay` at any unwritten cell (`d7`).
 */
export async function normalClasses(ctx, diff, files) {
  const { decodeColumns } = await ctx.imp('lib/region/pack.mjs');
  const { buildVirtual, F_WRITTEN } = await ctx.imp('lib/region/vworld.mjs');
  const { farFluidOf } = await import(pathToFileURL(path.join(ctx.root, 'tools', 'lib', 'gate6cvoc-b.mjs')).href);
  const cols = decodeColumns(files.survey);
  const groundAt = (x, z) => { const i = Math.floor((x - cols.minX) / cols.resolution), j = Math.floor((z - cols.minZ) / cols.resolution); return i < 0 || j < 0 || i >= cols.width || j >= cols.depth ? null : cols.ground[i + j * cols.width]; };
  const { vw } = buildVirtual({ ir: files.ir, survey: files.survey, blobs: files.blobs });
  const wcol = new Map();
  const wlow = (x, z, y) => { const k = `${x},${z}`, v = wcol.get(k); if (v === undefined || y < v) wcol.set(k, y); };
  vw.eachWritten((x, y, z) => wlow(x, z, y));
  const lotBoxes = files.ir.lots.map((l) => l.box);
  for (const b of lotBoxes) for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) wlow(x, z, b.minY);
  const G = 6, near = new Set();
  const add = (x0, z0, x1, z1) => { for (let x = x0 - G; x <= x1 + G; x++) for (let z = z0 - G; z <= z1 + G; z++) near.add(`${x},${z}`); };
  for (const e of files.meta?.route?.edges ?? []) for (const [x, , z] of e.path ?? []) add(x, z, x, z);
  // (the free layout's streets are road items, which no op shows: their footprint counts as written columns, as a route's cells do)
  const { centreCells } = await ctx.imp('lib/region/geom.mjs');
  for (const rd of files.ir.roads ?? []) { const { cells } = centreCells(rd.points.map((p) => [p[0], p[2]])); for (const c of cells) add(c.x - 2, c.z - 2, c.x + 2, c.z + 2); }
  const isWritten = (x, y, z) => (vw.flags(x, y, z) & F_WRITTEN) !== 0 || lotBoxes.some((b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ);
  const away = (x, y, z) => {
    let lowNear = Infinity, nearW = false;
    for (let i = -G; i <= G; i++) for (let j = -G; j <= G; j++) { const v = wcol.get(`${x + i},${z + j}`); if (v !== undefined) { nearW = true; if (v < lowNear) lowNear = v; } }
    if (!nearW && !near.has(`${x},${z}`)) return 'far';
    const gy = groundAt(x, z);
    return gy !== null && y < gy - 8 && y < lowNear - 8 ? 'deep' : null;
  };
  const idOf = (b) => b.split(/[[{]/)[0];
  const fluidRe = /^minecraft:(water|lava)\b/;
  const kindOf = (m) => fluidRe.test(m.now) || fluidRe.test(m.was) ? 'flow'
    : /_leaves\[.*persistent=false/.test(m.was) && /^minecraft:air$/.test(m.now) ? 'decay'
      : idOf(m.was) === idOf(m.now) ? 'live' : null;
  const classes = { ...(diff.classes ?? {}) };
  const by = {};
  for (const m of diff.list ?? []) {
    if (m.class !== 'none') continue;
    const cls = kindOf(m);
    if (!cls) continue;
    const [x, y, z] = m.pos.split(',').map(Number);
    if (isWritten(x, y, z)) continue;
    const where = cls === 'decay' && /_leaves\[distance=7,persistent=false/.test(m.was) ? 'd7' : away(x, y, z);
    if (!where) continue;
    m.class = cls; m.where = where;
    by[`${cls}:${where}`] = (by[`${cls}:${where}`] ?? 0) + 1;
    classes.none -= 1;
    classes[cls] = (classes[cls] ?? 0) + 1;
  }
  // VOC's farfluid over what is left
  const written = new Set();
  vw.eachWritten((x, y, z) => written.add(`${x},${y},${z}`));
  const v = farFluidOf({ ...diff, classes }, { written, lots: files.ir.lots });
  return { classes: v.classes, by, list: (v.list ?? []).filter((m) => m.class === 'none') };
}

/** The S3 claim (scenarios/s3_monastery.json, a site only) on the seed base. */
const S3_BASE = 'G6B Seed Base';

/**
 * Item 7: v69's program on S3's pinned claim's lower band: the lowest dry, gentle 33 x 33 window of the claim's own survey (a lattice of
 * 8, inset 40) is the zone's anchor (`near {anchor: low, within: 16}`), as plan v1 would send it. A no-region control first: the box
 * snapshotted, left 90 s, diffed (S3's springs: recorded). Then the round with E-normal.
 */
export async function natural(ctx) {
  const { L, core, B, check, log } = ctx;
  const S3 = JSON.parse(fs.readFileSync(path.join(ctx.root, 'scenarios', 's3_monastery.json'), 'utf8')).fixture.claim;
  const fx = B.fixture(ctx, 'valid/v69_fl_organic.json');
  // the lower band from the site's own survey
  await L.fresh('G6B FL natural-probe', S3_BASE);
  await L.tp((S3[0] + S3[2]) / 2, 200, (S3[1] + S3[3]) / 2);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
  const sv = path.join(ctx.OUT, 'fl-natural-survey.bin');
  await L.call('dev.region.survey', { claim: S3, surveyLoad: 'bounded:256', file: sv }, 600_000);
  const { surveyApi } = await ctx.imp('lib/region/survey.mjs');
  const S = surveyApi(fs.readFileSync(sv), { minX: S3[0], minZ: S3[1], maxX: S3[2], maxZ: S3[3], minY: -64, maxY: 319 });
  // the lower band: the claim's 33 x 33 windows (a lattice of 8, inset 24) with at most 2 wet columns, lowest first; of the 8 lowest,
  // the one where the kit's own check (over this survey, as the game will) places the most lots (ties: the lower)
  const wins = [];
  for (let x = S3[0] + 24; x <= S3[2] - 24; x += 8) for (let z = S3[1] + 24; z <= S3[3] - 24; z += 8) {
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0, wet = 0;
    for (let i = -16; i <= 16; i += 2) for (let j = -16; j <= 16; j += 2) { const g = S.groundAt(x + i, z + j); lo = Math.min(lo, g); hi = Math.max(hi, g); sum += g; n++; if (S.waterAt(x + i, z + j)) wet++; }
    if (wet <= 2) wins.push({ x, z, mean: Math.floor(sum / n), range: hi - lo });
  }
  wins.sort((p, q) => p.mean - q.mean || p.z - q.z || p.x - q.x);
  const { checkPlanLocal, stewardAnchors } = await import(pathToFileURL(path.join(ctx.KIT, 'test', 'plan-helpers.mjs')).href);
  const sc = { minX: S3[0], minZ: S3[1], maxX: S3[2], maxZ: S3[3], minY: -64, maxY: 319 };
  let low = null;
  for (const w of wins.slice(0, 8)) {
    const pl = { ...fx.plan, zones: fx.plan.zones.map((z) => ({ ...z, where: { near: { anchor: 'low', within: 16 } } })) };
    const res = await checkPlanLocal(pl, { survey: fs.readFileSync(sv), claim: sc, anchors: { ...stewardAnchors(sc), low: [w.x, w.mean + 1, w.z] } });
    const lots = res.check.overall === 'READY' ? res.check.parts[0].geometry?.lots?.length ?? 0 : 0;
    log(`  lower band window ${w.x},${w.z} (mean ${w.mean}, range ${w.range}): ${res.check.overall}, ${lots} lot(s)`);
    if (lots && (!low || lots > low.lots)) low = { ...w, lots };
  }
  await L.leaveWorld();
  check(!!low, `item 7: S3's lower band: a dry window round ${json(low)} (mean ground, range)`);
  if (!low) return { low };
  const anchors = { low: [low.x, low.mean + 1, low.z] };
  const plan = { ...fx.plan, planId: 'fl_v69_s3', zones: fx.plan.zones.map((z) => ({ ...z, where: { near: { anchor: 'low', within: 16 } } })) };
  // the control: no region, the same box left as long as a realise takes (S3's springs and settling fluids)
  await L.fresh('G6B FL natural-control', S3_BASE);
  await L.setRules('exact');
  await L.tp(low.x, low.mean + 30, low.z);
  await L.call('dev.waitChunks', { timeoutMs: 120_000 }, 180_000).catch(() => null);
  const cbox = [low.x - 90, low.mean - 40, low.z - 90, low.x + 90, low.mean + 40, low.z + 90].map((v, i) => (i === 0 || i === 3 ? Math.max(S3[0] - 8, Math.min(S3[2] + 8, v)) : i === 2 || i === 5 ? Math.max(S3[1] - 8, Math.min(S3[3] + 8, v)) : Math.max(-64, Math.min(319, v))));
  const cfile = await core.snap(ctx, cbox, 'fl-natural-control');
  await sleep(90_000);
  const cd = await L.call('dev.region.hash', { box: cbox, mode: 'diff', file: cfile }, 4 * 3_600_000);
  const control = { mismatches: cd.mismatches, classes: cd.classes ?? {}, sample: (cd.list ?? []).slice(0, 12) };
  log(`  control (no region, 90 s): ${cd.mismatches} mismatch(es) ${json(cd.classes)}`);
  check(true, `item 7 (recorded): the no-region control over the zone's box: ${cd.mismatches} mismatch(es) ${json(cd.classes)} in 90 s (S3's own fluids and growth)`);
  await L.leaveWorld();
  const r = await realiseFl(ctx, 'natural', fx, { item: 7, base: S3_BASE, site: S3, plan, anchors: { ...(await B.worldPlan(ctx, fx, { claim: S3, dx: 0, dz: 0, off: 0 })).anchors, ...anchors }, normal: true, noM5: true });
  return { low, control, ...r };
}

/** The look's bibles: the default and the coastal one. */
const LOOK_BIBLES = [null, 'g7ak1_coastal'];
/** The look's layouts: a ring with a hub, a spiral up a hill, a grid with its plaza, an organic hamlet, a ring round a pond. */
const LOOK = Object.freeze([['ring', 'valid/v66_fl_ring.json'], ['spiral', 'valid/v70_fl_spiral.json'], ['grid', 'valid/v68_fl_grid.json'], ['organic', 'valid/v69_fl_organic.json'], ['around', 'valid/v67_fl_around_pond.json']]);

/** Item 13 (the look, client, recorded): per layout and bible, an overview from high and an oblique street-level view. */
export async function look(ctx) {
  const { L, OUT, log } = ctx;
  const dir = path.join(OUT, 'fl-look');
  fs.mkdirSync(dir, { recursive: true });
  for (const id of LOOK_BIBLES) if (id) {
    const dst = path.join(L.GAME_DIR, 'architect', 'bibles', id, 'versions', '1');
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(ctx.root, 'scenarios', 'bibles', `${id}.json`), path.join(dst, 'bible.json'));
  }
  const all = [];
  for (const bible of LOOK_BIBLES) for (const [name, rel] of LOOK) {
    const tag = `${bible ? bible.replace(/^g7ak1_/, '') : 'default'}_${name}`;
    try {
      await realiseFl(ctx, `look-${tag}`, ctx.B.fixture(ctx, rel), {
        rules: 'exact', bible, noUndo: true, noSnap: true, noM5: true, fill: LOOK_ENTRIES, quiet: true,
        after: async (r, { ck }) => {
          const z = (ck.check.parts ?? []).find((a) => a.geometry?.layout);
          const g = z.geometry, rc = g.rect;
          const c = [(rc[0] + rc[2]) / 2, g.bell?.[1] ?? 70, (rc[1] + rc[3]) / 2];
          const span = Math.max(rc[2] - rc[0], rc[3] - rc[1]);
          await L.cmd('/time set 6000');
          const shot = async (sn, eye, at, what) => {
            await L.call('dev.camera', { x: eye[0], y: eye[1], z: eye[2], lookAt: { x: at[0], y: at[1], z: at[2] }, mode: 'spectator', fov: 70 }, 60_000);
            await L.call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => null);
            await L.settle(2500);
            const q = await L.call('dev.screenshot', { name: `fl_${tag}_${sn}`, frames: 10, chunkTimeoutMs: 60_000 }, 180_000);
            const file = path.join(dir, `${tag}_${sn}.png`);
            fs.copyFileSync(q.path, file);
            log(`  shot ${tag}_${sn}`);
            all.push({ bible: bible ?? 'default', layout: name, shot: sn, what, file: path.relative(OUT, file), lots: g.lots.length, streets: g.streets.map((s) => s.name) });
          };
          await shot('overview', [c[0] + span * 0.15, c[1] + span * 0.95, c[2] + span * 0.75], c, `${name}: the whole layout from high (its streets, hub and lots)`);
          await shot('street', [c[0] - span * 0.35, c[1] + 14, c[2] + span * 0.45], c, `${name}: an oblique view across the streets towards the hub`);
          if (g.hub) await shot('hub', [g.hub.centre[0] + 14, c[1] + 10, g.hub.centre[1] + 14], [g.hub.centre[0], c[1], g.hub.centre[1]], `${name}: the hub up close`);
          return { shots: all.length };
        },
      });
    } catch (e) { log(`  look ${tag}: ${String(e.message ?? e).slice(0, 200)}`); try { await L.leaveWorld(); } catch { /* left */ } }
    await L.call('dev.release', {}).catch(() => null);
  }
  fs.writeFileSync(path.join(dir, 'look.json'), `${JSON.stringify(all, null, 2)}\n`);
  ctx.check(all.length >= 18, `item 13 (the look, recorded not judged): ${all.length} camera shot(s) of 5 layouts in ${LOOK_BIBLES.length} bibles (${dir})`);
  return { shots: all.length };
}

/** Item 6: every fixture of ITEM6 through the whole round. */
export async function ingame(ctx) {
  const out = {};
  for (const [tag, rel] of ITEM6) {
    try { out[tag] = await realiseFl(ctx, tag, ctx.B.fixture(ctx, rel)); } catch (e) { ctx.check(false, `item 6 (${tag}): ${String(e.message ?? e).slice(0, 300)}`); ctx.log(String(e.stack ?? e)); try { await ctx.L.leaveWorld(); } catch { /* left */ } }
  }
  return out;
}
