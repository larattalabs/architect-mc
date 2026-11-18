// Phase 8c's join slice SV (docs/CONTRACT.md "Phase 8c", "SV as built"): the survival rows of the in-game lane, run by tools/gate8c.mjs
// step `survival` (gate-chains `8c-survival`). Every row runs on a fresh copy of gate6crs's survival base (the stockpile, the feed and the
// conservation sum are gate6crs-game's; the census, the IR's bodies and the snapshot are HY-core's):
//   isle    c05 (kit/test/fixtures/river) in survival: the floating island's ops staged (8a), its fluid ops not; the fluids stage waits for
//           the island with the typed `terrain` wait (SITE_BUSY, waitsFor {kind: "terrain", part: "isle"}), the header's `on` is
//           {part: "isle"}, the bodies are written only once the island is BUILT (the fluids stage last), then settle, census equal;
//           the hidden room behind the fall (form.hidden_room) outside the watch set, built, kept and dry; Remove E-flat 0, conservation
//   wash    river_demo (the hand IR, a meadow of natural flowers in its predicted cells) in survival: the wash clears cost nothing and credit
//           nothing (no flower in the quote, the ledger or the stock; no water billed), 0 item entities, items in == items out after the
//           build and after Remove, E-flat 0
//   nowash  the control: river_demo nowash in survival (no wash list): the flow washes the flowers, the mint the wash rule stops (recorded)
//   town    c03 (a river through a hamlet) in survival: each lot's bill its design's only, the river's banks and lining (and the road's
//           bridge) in the region remainder (tiles:/road: pieces, never a lot: one), no water billed; Remove: refund == consumed, E-flat 0,
//           conservation exact
// The Steward-facing rows (the 8c contract §8 with Steward's review) are read through dev.region.state in isle and town: the fluids rows
// (part, body <part>_r<k>, kind, flow, lip, on, box, settleTicks, flowing, converted, washed; why only when not settled),
// architect_mc:fluidsWatch while the bodies are written or drained, RegionView.fluidsRemoval {phase, until, ticksLeft} while draining.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const sum = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

/** The 8c hand river's claim on the flat survival base (gate8c-game's CLAIM). */
const CLAIM = [9500, 9200, 9595, 9263];

const river = (ctx, name) => JSON.parse(fs.readFileSync(path.join(ctx.KIT, 'test', 'fixtures', 'river', name), 'utf8'));
const imp = (ctx, rel) => import(pathToFileURL(path.join(ctx.KIT, rel)).href);

/** The lot entries a fixture binds (gate8ast's entriesOf): every lot an rs_hut (a farm, smithy or barn an rs_shed). */
function entriesOf(fx) {
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

/** The fluids rows, the watch and the removal phase of a region, as Steward reads them (dev.region.state). */
async function viewOf(ctx, region) {
  const st = await ctx.L.call('dev.region.state', { region }, 60_000).catch(() => null);
  const v = st?.view ?? null;
  return { st, state: v?.state ?? null, rows: v?.ext?.['architect_mc:fluids'] ?? [], watch: v?.ext?.['architect_mc:fluidsWatch'] ?? null, removal: v?.fluidsRemoval ?? null,
    waiting: v?.waiting ?? null, waitsFor: v?.ext?.['architect_mc:waitsFor'] ?? null };
}

/** §8's row shape, Steward's review folded in: [ok, problems]. */
function rowProblems(rows, bodies) {
  const bad = [];
  for (const r of rows) {
    const b = bodies.find((x) => x.id === r.body);
    if (!b) { bad.push(`${r.body}: no body`); continue; }
    if (!/^.+_r\d+$/.test(r.body) || !r.body.startsWith(`${r.part}_r`)) bad.push(`${r.body}: id not <part>_r<k> (part ${r.part})`);
    if (r.part !== b.part) bad.push(`${r.body}: part ${r.part} != the op's ${b.part}`);
    if (!Array.isArray(r.box) || r.box.length !== 6 || !r.box.every(Number.isInteger)) bad.push(`${r.body}: box ${JSON.stringify(r.box)}`);
    if (typeof r.settleTicks !== 'number') bad.push(`${r.body}: settleTicks ${r.settleTicks}`);
    if (r.state === 'settled' && r.why != null) bad.push(`${r.body}: settled with why ${r.why}`);
    if (b.flowing) {
      for (const k of ['kind', 'flowing', 'converted', 'washed']) if (r[k] === undefined) bad.push(`${r.body}: no ${k}`);
      if (r.flowing !== (b.predicted ?? []).length) bad.push(`${r.body}: flowing ${r.flowing} != predicted ${(b.predicted ?? []).length}`);
    }
  }
  return bad;
}

/** A Remove watched to its end: the fluidsRemoval phases and shapes seen, the watch while draining, the final state. */
async function removeWatched(ctx, G, region) {
  const t0 = Date.now();
  const first = ctx.L.call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch((e) => ({ error: String(e.message ?? e) }));
  const phases = [], shapes = [], watches = [];
  for (let i = 0; i < 2400; i++) {
    const v = await viewOf(ctx, region);
    const fr = v.removal;
    if (fr && phases.at(-1) !== fr.phase) { phases.push(fr.phase); shapes.push(fr); }
    if (Array.isArray(v.watch) && v.watch.length && watches.length < 4) watches.push(v.watch.map((w) => [w.body, w.phase, Array.isArray(w.box) && w.box.length === 6]));
    if (!v.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(v.state)) {
      await ctx.L.settle(2000);
      return { state: v.state ?? 'REMOVED', phases, shapes, watches, after: v.removal, seconds: (Date.now() - t0) / 1000, first: await first };
    }
    await sleep(500);
  }
  throw new Error(`removal of ${region} did not finish`);
}

/** The ledger's consumed less returned (dev.stockpile.state). */
const netOf = (G, ps) => G.minus(ps.ledger?.consumed, ps.ledger?.returned);

// ------------------------------------------------------------------ isle: c05 in survival, the typed terrain wait, the hidden room

/** The grotto's carved cells of an IR (rv-b's rule: a columns op's cell whose material is null). */
function carvedOf(ir) {
  const room = ir.parts.find((q) => q.id === 'f_grotto');
  const out = [];
  for (const o of room?.ops ?? []) if (o.op === 'columns') for (let i = 0; i < o.cols.length; i += 5) if (o.materials[o.cols[i + 4]] === null) for (let y = o.cols[i + 2]; y <= o.cols[i + 3]; y++) out.push([o.cols[i], y, o.cols[i + 1]]);
  return out;
}

/** The fall's watch sets of an IR (cells, shell, spill, watch, predicted), rv-b's. */
async function fallSets(ctx, ir) {
  const { fromRuns } = await imp(ctx, 'lib/fluids/body.mjs');
  const sets = new Set();
  for (const p of ir.parts) for (const o of p.ops) if (o.op === 'fluid' && o.part === 'fall') {
    for (const k of ['cells', 'shell', 'spill', 'watch']) for (const c of fromRuns(o[k] ?? [])) sets.add(k3(c));
    for (const c of o.predicted ?? []) sets.add(k3(c));
  }
  return sets;
}

/**
 * The carved cells that open rock (rv-b's test, over the realised plan's own inputs): the IR without the grotto built on the plan's survey,
 * blobs and frozen volumes (the sidecar's plan dir), the carved cells solid there.
 */
async function openedInGame(ctx, r) {
  const { buildVirtual } = await imp(ctx, 'lib/region/vworld.mjs');
  const { fillMissing } = await imp(ctx, 'lib/region/plan.mjs');
  const { asColumns } = await imp(ctx, 'lib/region/pack.mjs');
  const { decodeArvx } = await imp(ctx, 'lib/region/volume.mjs');
  const dir = path.join(ctx.L.SIDECAR_DATA, 'regions', 'plans', r.planId);
  const survey = fillMissing(asColumns(fs.readFileSync(path.join(dir, 'survey.bin')))).columns;
  const vdir = path.join(dir, 'volumes');
  const volumes = fs.existsSync(vdir) ? fs.readdirSync(vdir).filter((f) => f.endsWith('.bin')).map((f) => decodeArvx(fs.readFileSync(path.join(vdir, f)))) : [];
  const blobs = (sha) => { const f = path.join(dir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const carved = carvedOf(r.ir);
  const pre = JSON.parse(JSON.stringify(r.ir));
  pre.parts = pre.parts.filter((q) => !q.id.startsWith('f_grotto'));
  const { vw } = buildVirtual({ ir: pre, survey, blobs, volumes });
  return { carved, opened: carved.filter((c) => vw.pal.solid[vw.get(c[0], c[1], c[2])]), volumes: volumes.length };
}

async function isle(ctx) {
  const { L, G, core, check, json } = ctx;
  const fx = river(ctx, 'c05_island_fall.json');
  const s = await G.site(ctx, 'sv isle', fx);
  // (the terrain builder lays its grass one over the base's own grass top, which stays grass under it: a natural world's subsurface is
  // dirt there, and the kit's virtual world reads it so, while the frozen volume reads grass; the basin's shell cells at that layer then
  // pick dirt, a no-op in the virtual world, and the check refuses LEAK "unwritable" (run 20261118-085041, recorded as a kit leftover))
  if (s.W.off > 0) await L.cmd(`/fill ${s.W.claim[0] - 8} ${s.W.ground} ${s.W.claim[1] - 8} ${s.W.claim[2] + 8} ${s.W.ground} ${s.W.claim[3] + 8} minecraft:dirt replace minecraft:grass_block`);
  const box = [s.W.claim[0] - 8, s.W.minY - 8, s.W.claim[1] - 8, s.W.claim[2] + 8, s.W.maxY + 96, s.W.claim[3] + 8];
  const pre = await G.snap(ctx, box, 'sv-isle-pre');
  const ck = await G.check(ctx, 'sv-isle', s);
  const parts = Object.fromEntries((ck.check?.parts ?? []).map((a) => [a.part, a.class]));
  const out = { overall: ck.check?.overall, survival: ck.check?.survival, parts };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && parts.isle === 'fits' && parts.fall === 'fits' && parts.grotto === 'fits' && !!ck.check?.artifactSha,
    `isle: c05 through Regions.checkPlan in survival: ${ck.check?.overall} (${json(parts)})`);
  if (!ck.check?.artifactSha) return out;
  await L.call('dev.terrain.rate', { n: 4 }, 30_000); // (slow, so the fluids stage's wait is sampled while the island builds)
  const crates = await G.pile(ctx, s, 2);
  const quote = await L.call('dev.region.quote', { sha: ck.check.artifactSha }, 300_000);
  out.quote = { bom: quote.bom, bomParts: quote.bomParts, exact: quote.exact, notes: quote.notes };
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, {});
  out.region = region;
  const rL = await core.regionOf(ctx, region);
  const bodies = rL.bodies;
  const headB = bodies.find((b) => b.id === 'fall_r1'), basinB = bodies.find((b) => b.id === 'fall_r2');
  const bodyBox = core.boxAround([...(headB?.cells ?? []), ...(basinB?.cells ?? [])], 0);
  const samples = [];
  let last = 0;
  const sample = async () => {
    if (Date.now() - last < 1500) return;
    last = Date.now();
    const tr = await L.call('dev.region.terrain', { region }, 120_000);
    const v = await viewOf(ctx, region);
    const wet = (await L.call('dev.fluid.census', { box: bodyBox }, 60_000)).fluids.length;
    samples.push({ t: tr.gameTime, targets: (tr.targets ?? []).map((t) => [t.target, t.part, t.building, t.built, t.cells]),
      waits: (tr.waits ?? []).map((w) => ({ key: w.key, status: w.status, reason: w.reason, waitsFor: w.waitsFor })),
      rows: v.rows.map((r) => [r.body, r.state, r.on ?? null]), watch: v.watch, waiting: v.waiting, viewWaitsFor: v.waitsFor, wet });
  };
  const f = await G.feed(ctx, region, { cons: C, timeoutMs: 3_000_000, every: 1000, extra: async () => { await sample(); return {}; },
    until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done && (st.view.ext?.['architect_mc:fluids'] ?? []).every((r) => r.state === 'settled') });
  await sample();
  await L.call('dev.terrain.rate', { n: 16 }, 30_000);
  out.feed = { waves: f.waves, inserted: f.inserted };
  out.samples = samples.length;
  // the island's ops staged, the fall's not
  const tr = await L.call('dev.region.terrain', { region, check: true }, 300_000);
  const targets = (tr.targets ?? []).map((t) => [t.target, t.part, t.cells, t.built]);
  out.targets = targets;
  check(targets.some((t) => t[1] === 'isle') && !targets.some((t) => t[1] === 'fall') && targets.every((t) => t[3] === t[2]),
    `isle: the island's land is staged (${targets.filter((t) => t[1] === 'isle').length} target(s) of part isle), no staged cell of the fall, all built (${json(targets)})`);
  // the typed terrain wait: the fall's fluids stage waits for the island, SITE_BUSY with waitsFor {kind terrain, part isle}
  const fallWaits = samples.flatMap((x) => x.waits.filter((w) => w.status === 'WAITING' && /fall/.test(`${w.waitsFor?.waiter ?? ''}`) && /^t:fluids:/.test(w.key)));
  const w0 = fallWaits[0] ?? null;
  out.wait = { n: fallWaits.length, first: w0, keys: [...new Set(samples.flatMap((x) => x.waits.map((w) => `${w.key}<-${w.waitsFor?.waiter ?? ''}`)))].slice(0, 12) };
  check(!!w0 && fallWaits.every((w) => w.waitsFor.kind === 'terrain' && w.waitsFor.part === 'isle') && w0.reason === 'SITE_BUSY' && w0.waitsFor.terrainCells > 0 && Number.isInteger(w0.waitsFor.terrainBuilt),
    `isle: the fall's fluids stage waits for the island (every sample of its wait typed terrain, part isle): ${w0?.key} ${w0?.status} ${w0?.reason} with waitsFor ${json(w0?.waitsFor)} (${fallWaits.length} sample(s))`, out.wait);
  const viewTyped = samples.find((x) => x.viewWaitsFor?.kind === 'terrain');
  out.viewWait = viewTyped ? { waiting: viewTyped.waiting, waitsFor: viewTyped.viewWaitsFor } : null;
  check(true, `isle (recorded): RegionView.waiting with its typed payload on the view's ext while the island built: ${json(out.viewWait)}`);
  // the fluids stage last: no water in the bodies' box while any staged target still builds
  const wetEarly = samples.filter((x) => x.wet > 0 && x.targets.some((t) => t[2]));
  const firstWet = samples.findIndex((x) => x.wet > 0);
  out.order = { wetWhileBuilding: wetEarly.length, firstWet: firstWet < 0 ? null : samples[firstWet].t, lastBuilding: samples.filter((x) => x.targets.some((t) => t[2])).at(-1)?.t ?? null };
  check(wetEarly.length === 0 && firstWet > 0, `isle: no water in the fall's bodies while the island builds (${wetEarly.length} wet sample(s) with a target building; first water at tick ${out.order.firstWet}, the last building sample at ${out.order.lastBuilding}): the fluids stage is last`, out.order);
  // settled; census equal; the header's on; Steward's rows
  const r = await core.regionOf(ctx, region);
  const head = r.fluids.find((x) => x.body === 'fall_r1'), basin = r.fluids.find((x) => x.body === 'fall_r2');
  out.rows = r.fluids;
  check(r.view.state === 'PLACED' && r.fluids.length === 2 && r.fluids.every((x) => x.state === 'settled'), `isle: PLACED, both bodies settled (${r.view.state}; ${json(r.fluids.map((x) => [x.body, x.state, x.why ?? null]))})`);
  check(head?.kind === 'header' && head?.lip === 'form' && head?.on === 'isle' && head?.part === 'fall' && basin?.state === 'settled' && (basin?.kind ?? 'basin') === 'basin',
    `isle: the header's row: kind ${head?.kind}, lip ${head?.lip}, on ${json(head?.on)} (the island's plan part id), part ${head?.part}; the basin a plain HY body (kind ${basin?.kind ?? 'absent: only a flowing body\'s row carries it'})`);
  check(!!w0 && w0.waitsFor.part === head?.on, `isle: the wait's part (${w0?.waitsFor?.part}) is the header's on (${head?.on})`);
  const cs = {};
  for (const b of r.bodies) cs[b.id] = await core.censusOf(ctx, b, null, r.bodies);
  out.census = Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, [v.sources, v.flowing, v.mismatch.length, v.outsideCount, v.ticks]]));
  check(Object.values(cs).every((c) => c.ok && c.ticks === 0), `isle: every census equals its prediction, no tick (${json(out.census)})`, Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, v.mismatch.slice(0, 6)])));
  const probs = rowProblems(r.fluids, r.bodies.map((b) => ({ ...b, flowing: b.id === 'fall_r1' })));
  const sawWatch = samples.some((x) => Array.isArray(x.watch) && x.watch.some((w) => w.phase === 'writing' && Array.isArray(w.box) && w.box.length === 6));
  const vNow = await viewOf(ctx, region);
  check(probs.length === 0 && sawWatch && vNow.watch == null && vNow.removal == null,
    `isle: Steward's rows through dev.region.state: ${probs.length ? probs.join('; ') : 'part, body <part>_r<k>, box, settleTicks, flowing as predicted, no why when settled'}; fluidsWatch writing with a box seen (${sawWatch}), absent once settled (${json(vNow.watch)}); fluidsRemoval null (${json(vNow.removal)})`);
  // the hidden room behind the fall: outside the watch set, built, kept and dry
  const carved = carvedOf(r.ir);
  const sets = await fallSets(ctx, r.ir);
  const { outsideWatch } = await imp(ctx, 'lib/forms/hiddenRoom.mjs');
  const og = await openedInGame(ctx, r).catch((e) => ({ error: String(e.stack ?? e) }));
  const opened = og.opened ?? [];
  const outside = opened.length >= 27 && outsideWatch(opened, sets);
  out.room = { carved: carved.length, opened: opened.length, volumes: og.volumes ?? null, error: og.error ?? null, inWatch: carved.filter((c) => sets.has(k3(c))).length };
  check(carved.length >= 27 && outside, `isle: the grotto (form.hidden_room) behind the fall: ${carved.length} carved cell(s), the ${opened.length} it opens in the island's rock (the realised plan's own world, rv-b's reading) outside the fall's watch set and its face neighbours (${outside})`, out.room);
  await L.settle(30_000); // a stand: the room stays dry
  const rb = core.boxAround(carved, 0);
  const wetRoom = (await L.call('dev.fluid.census', { box: rb }, 60_000)).fluids.filter((q) => carved.some((c) => c[0] === q[0] && c[1] === q[1] && c[2] === q[2]));
  const d = await G.diff(ctx, box, pre);
  const changed = new Map(d.list.map((m) => [m.pos, m.now]));
  const notAir = carved.filter((c) => changed.has(k3(c)) && !/^minecraft:(cave_|void_)?air$/.test(String(changed.get(k3(c)))));
  const walls = new Set();
  const cs3 = new Set(carved.map(k3));
  for (const [x, y, z] of carved) for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const k = k3([x + a, y + b, z + c]); if (!cs3.has(k)) walls.add(k); }
  const solidWalls = [...walls].filter((k) => changed.has(k) && !/air$/.test(String(changed.get(k)))).length;
  const rs = await G.rsState(ctx, region);
  const grottoBuilt = (rs.build?.parts ?? []).filter((p) => /grotto/.test(p.part)).map((p) => [p.part, p.state, p.built, p.cells, p.terrainBuilt, p.terrainCells]);
  out.roomWorld = { wet: wetRoom.length, notAir: notAir.slice(0, 6), walls: walls.size, solidWalls, grottoBuilt };
  check(wetRoom.length === 0 && notAir.length === 0 && solidWalls >= walls.size / 2 && grottoBuilt.length > 0,
    `isle: the room built and kept: its ${carved.length} cells air (${notAir.length} not), ${solidWalls} of ${walls.size} wall cells solid round it, the part ${json(grottoBuilt)}; dry after a 30 s stand (${wetRoom.length} wet)`, out.roomWorld);
  const rv = await ctx.L.call('dev.fluid.river', { region }, 120_000).catch(() => null);
  const items = typeof rv?.items === 'number' ? rv.items + (rv.itemsNow ?? 0) : -1;
  const pB = await C.point('built');
  check(items === 0 && G.exact(pB), `isle: 0 item entities from the bodies' cells (${items}); items in = items out after the build (conservation ${json(pB.diff)}, identity ${pB.identity})`, pB);
  const ps0 = await G.pileState(ctx);
  const rm = await removeWatched(ctx, G, region);
  const ps1 = await G.pileState(ctx);
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  const pE = await C.point('removed');
  const refunded = G.minus(ps1.ledger?.returned, ps0.ledger?.returned);
  out.removal = { state: rm.state, phases: rm.phases, mismatches: ef.length, list: ef.slice(0, 8), refunded, consumed: netOf(G, ps0), conservation: pE };
  check(rm.state === 'REMOVED' && ef.length === 0 && G.exact(pE) && G.same(refunded, netOf(G, ps0)),
    `isle: Remove ${rm.state}: E-flat ${ef.length} over the box (the crates aside); refunded ${json(refunded)} = consumed ${json(netOf(G, ps0))}; items in = items out (conservation ${json(pE.diff)})`, out.removal);
  return out;
}

// ------------------------------------------------------------------ wash: river_demo's meadow in survival

async function washRow(ctx, variant) {
  const { L, G, core, check, json } = ctx;
  const tag = variant === 'nowash' ? 'nowash' : 'wash';
  await G.survivalBase(ctx);
  await L.fresh(`G6B 8c SV ${tag}`, G.SURV);
  await L.setRules('exact');
  await L.cmd('/weather clear');
  const g = await core.groundOf(ctx, CLAIM);
  const C0 = { minX: CLAIM[0], minZ: CLAIM[1], maxX: CLAIM[2], maxZ: CLAIM[3] };
  const D = await imp(ctx, 'regions/river_demo.mjs');
  const M = D.riverLayout(D.riverOrigin(C0), g, 'none', 'river');
  for (const [x, y, z] of M.meadow) await L.cmd(`/setblock ${x} ${y} ${z} minecraft:dandelion`);
  const { plan, anchors } = D.riverPlan(C0, variant === 'nowash' ? { variant: 'nowash' } : {});
  const ck = await L.call('dev.region.checkPlan', { plan, claim: CLAIM, owner: G.OWNER, anchors, load: 'generate' }, 900_000);
  fs.writeFileSync(path.join(ctx.OUT, `sv-${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const out = { overall: ck.check?.overall, survival: ck.check?.survival, flowers: M.meadow.length };
  check(ck.check?.survival === true && ck.check?.overall === 'READY' && !!ck.check?.artifactSha, `${tag}: river_demo${variant ? ` ${variant}` : ''} through Regions.checkPlan in survival: ${ck.check?.overall}`);
  if (!ck.check?.artifactSha) return out;
  const box = [CLAIM[0] - 8, g - 6, CLAIM[1] - 8, CLAIM[2] + 8, g + 24, CLAIM[3] + 8];
  const pre = await G.snap(ctx, box, `sv-${tag}-pre`);
  const crates = [0, 1].map((k) => [CLAIM[0] - 6 + 2 * k, g + 1, CLAIM[1] - 6]);
  const pc = await L.call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
  if (pc.refused) throw new Error(`createStockpile refused: ${json(pc.refused)}`);
  const quote = await L.call('dev.region.quote', { sha: ck.check.artifactSha }, 300_000);
  const flowerItems = (m) => Object.keys(m ?? {}).filter((k) => /dandelion|water_bucket|minecraft:water$/.test(k));
  out.quote = { bom: quote.bom, bomParts: Object.keys(quote.bomParts ?? {}), exact: quote.exact, notes: quote.notes };
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, {});
  const f = await G.feed(ctx, region, { cons: C, timeoutMs: 1_800_000, every: 1500,
    until: (st, rs) => st.view.state !== 'BUILDING' && rs.build?.done && (st.view.ext?.['architect_mc:fluids'] ?? []).every((r) => ['settled', 'drained'].includes(r.state)) });
  await L.settle(3000);
  const r = await core.regionOf(ctx, region);
  const head = r.fluids.find((x) => x.body === 'river_r1');
  const rv = await L.call('dev.fluid.river', { region }, 120_000).catch(() => null);
  const items = typeof rv?.items === 'number' ? rv.items + (rv.itemsNow ?? 0) : -1;
  const ps0 = await G.pileState(ctx);
  const pB = await C.point('built');
  out.build = { state: r.view.state, rows: r.fluids.map((x) => [x.body, x.state, x.why ?? null, x.washed ?? null]), fed: f.inserted, items, conservation: pB, ledger: ps0.ledger };
  if (variant === 'nowash') {
    check(true, `nowash (recorded, the control): river_demo without the wash list in survival over the meadow's ${M.meadow.length} flowers: ${r.view.state}, rows ${json(out.build.rows)}; ${items} item entit(ies) from the predicted cells, conservation ${json(pB.diff)} (WU's live wash check holds a head whose predicted cells hold a washable block, so no flower is washed: the mint is stopped at the gate)`);
    await G.remove(ctx, region).catch(() => {});
    return out;
  }
  check(r.view.state === 'PLACED' && r.fluids.every((x) => x.state === 'settled') && head?.washed === M.meadow.length,
    `wash: PLACED, both bodies settled (${json(out.build.rows)}); the head's row says washed ${head?.washed} (the meadow's ${M.meadow.length} flowers)`);
  const billed = [...flowerItems(quote.bom), ...flowerItems(ps0.ledger?.consumed), ...flowerItems(ps0.ledger?.returned), ...flowerItems(ps0.stock), ...flowerItems(f.inserted)];
  check(billed.length === 0 && !(quote.bomParts ?? {}).fluids, `wash: the wash clears cost nothing and credit nothing: no flower or water in the quote (${json(quote.bom)}), the fed items, the ledger (consumed ${json(ps0.ledger?.consumed)}, returned ${json(ps0.ledger?.returned)}) or the stock; no fluids piece (${json(Object.keys(quote.bomParts ?? {}))})`, { billed });
  check(items === 0 && G.exact(pB), `wash: 0 item entities from the bodies' own and predicted cells (${items}); items in = items out after the build (conservation ${json(pB.diff)}, identity ${pB.identity})`, pB);
  const rm = await removeWatched(ctx, G, region);
  const ps1 = await G.pileState(ctx);
  const pE = await C.point('removed');
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  const refunded = G.minus(ps1.ledger?.returned, ps0.ledger?.returned);
  const rv2 = await L.call('dev.fluid.river', { region }, 120_000).catch(() => null);
  const items2 = typeof rv2?.items === 'number' ? rv2.items + (rv2.itemsNow ?? 0) : -1;
  out.removal = { state: rm.state, phases: rm.phases, mismatches: ef.length, list: ef.slice(0, 8), refunded, conservation: pE, items: items2 };
  check(rm.state === 'REMOVED' && ef.length === 0 && items2 === 0 && G.exact(pE) && G.same(refunded, netOf(G, ps0)) && flowerItems(ps1.stock).length === 0 && flowerItems(ps1.ledger?.returned).length === 0,
    `wash: Remove ${rm.state}: the flowers back, E-flat ${ef.length} (the crates aside); 0 item entities (${items2}); refunded ${json(refunded)} = consumed ${json(netOf(G, ps0))}, no flower credited; items in = items out (conservation ${json(pE.diff)})`, out.removal);
  return out;
}

// ------------------------------------------------------------------ town: c03, a river through a hamlet, in survival

async function town(ctx) {
  const { L, G, core, check, json } = ctx;
  const fx = river(ctx, 'c03_river_town.json');
  const entries = entriesOf(fx);
  const s = await G.site(ctx, 'sv town', fx);
  await G.designs(ctx);
  const box = [s.W.claim[0] - 8, s.W.minY - 8, s.W.claim[1] - 8, s.W.claim[2] + 8, s.W.maxY + 40, s.W.claim[3] + 8];
  const pre = await G.snap(ctx, box, 'sv-town-pre');
  const ck = await G.check(ctx, 'sv-town', s);
  const parts = Object.fromEntries((ck.check?.parts ?? []).map((a) => [a.part, a.class]));
  const out = { overall: ck.check?.overall, parts, entries };
  check(ck.check?.survival === true && ['READY', 'NEEDS_REPAIR'].includes(ck.check?.overall) && parts.river === 'fits' && !!ck.check?.artifactSha,
    `town: c03 through Regions.checkPlan in survival: ${ck.check?.overall} (${json(parts)})`);
  if (!ck.check?.artifactSha) return out;
  const roadA = (ck.check?.parts ?? []).find((a) => a.part === 'road');
  out.road = { class: roadA?.class, bridge: /bridge/i.test(JSON.stringify(roadA ?? {})) };
  const crates = await G.pile(ctx, s, 3);
  const quote = await L.call('dev.region.quote', { sha: ck.check.artifactSha, lotEntries: entries }, 300_000);
  const bp = quote.bomParts ?? {};
  out.quote = { bom: quote.bom, bomParts: bp, exact: quote.exact, notes: quote.notes };
  // each lot's bill is its design's: the rs_hut/rs_shed blocks only; the river's banks and lining never in a lot: piece
  const lotPieces = Object.keys(bp).filter((k) => k.startsWith('lot:'));
  const lots = lotPieces.reduce((a, k) => G.plus(a, bp[k]), {});
  const riverBill = (ck.check?.parts ?? []).find((a) => a.part === 'river')?.cost?.survival?.bom ?? {};
  const remainder = G.minus(quote.bom, lots);
  const DESIGN = /oak_planks|cobblestone$|oak_log|oak_door|glass_pane|torch|copper_block|gravel|lantern|farmland/;
  const foreignInLots = Object.keys(lots).filter((k) => !DESIGN.test(k));
  const riverOutside = Object.entries(riverBill).filter(([k, v]) => (remainder[k] ?? 0) < v);
  out.bills = { lotPieces, lots, riverBill, remainder, foreignInLots, riverOutside, fluids: bp.fluids ?? null };
  check(lotPieces.length === Object.keys(entries).length && foreignInLots.length === 0 && sum(riverBill) > 0 && riverOutside.length === 0 && !bp.fluids && !Object.keys(quote.bom ?? {}).some((k) => /water_bucket/.test(k)),
    `town: the quote: ${lotPieces.length} lot piece(s) (${lotPieces.join(' ')}) hold only their design's blocks (${foreignInLots.length ? `foreign ${foreignInLots.join(' ')}` : 'none foreign'}); the river's ${sum(riverBill)} paid banks and lining (${json(riverBill)}) all in the region remainder (${riverOutside.length} short); no water billed, no fluids piece`, out.bills);
  check(roadA?.class !== 'refused' && out.road.bridge, `town: the road across the river takes T3's bridge (${roadA?.class}; bridge named: ${out.road.bridge})`, roadA?.deviations ?? roadA?.reasons ?? null);
  const C = new G.Conservation(ctx, box);
  await C.start();
  const region = await G.realise(ctx, ck.check.artifactSha, entries);
  out.region = region;
  const samples = [];
  let last = 0;
  const f = await G.feed(ctx, region, { cons: C, timeoutMs: 3_000_000, every: 1500, extra: async () => {
    if (Date.now() - last > 3000) { last = Date.now(); const v = await viewOf(ctx, region); samples.push({ rows: v.rows.map((r) => [r.body, r.state]), watch: v.watch }); }
    return {};
  }, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done && (st.view.ext?.['architect_mc:fluids'] ?? []).every((r) => r.state === 'settled') });
  out.feed = { waves: f.waves, inserted: f.inserted };
  const r = await core.regionOf(ctx, region);
  out.rows = r.fluids;
  check(r.view.state === 'PLACED' && r.fluids.length === r.bodies.length && r.fluids.every((x) => x.state === 'settled'),
    `town: PLACED, every body settled (${r.view.state}; ${json(r.fluids.map((x) => [x.body, x.state, x.why ?? null]))})`);
  const cs = {};
  for (const b of r.bodies) cs[b.id] = await core.censusOf(ctx, b, null, r.bodies);
  out.census = Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, [v.sources, v.flowing, v.mismatch.length, v.outsideCount, v.ticks]]));
  check(Object.values(cs).every((c) => c.ok && c.ticks === 0), `town: every census equals its prediction, no tick (${json(out.census)})`, Object.fromEntries(Object.entries(cs).map(([k, v]) => [k, v.mismatch.slice(0, 6)])));
  const flowing = new Set(r.ir.parts.flatMap((p) => p.ops.filter((o) => o.op === 'fluid' && o.flow === 'current').map((o) => o.id)));
  const probs = rowProblems(r.fluids, r.bodies.map((b) => ({ ...b, flowing: flowing.has(b.id) })));
  const flows = r.fluids.filter((x) => flowing.has(x.body)).map((x) => [x.body, x.kind, x.flow]);
  const sawWatch = samples.some((x) => Array.isArray(x.watch) && x.watch.some((w) => w.phase === 'writing' && Array.isArray(w.box)));
  const vNow = await viewOf(ctx, region);
  check(probs.length === 0 && flows.length >= 1 && flows.every((x) => x[1] === 'river' && x[2] === 'current') && sawWatch && vNow.watch == null,
    `town: Steward's rows: ${probs.length ? probs.join('; ') : 'every row part river, body river_r<k>, box, settleTicks, flowing as predicted, no why'}; the currents ${json(flows)}; fluidsWatch writing seen (${sawWatch}), absent once settled`);
  const rv = await L.call('dev.fluid.river', { region }, 120_000).catch(() => null);
  const items = typeof rv?.items === 'number' ? rv.items + (rv.itemsNow ?? 0) : -1;
  const pB = await C.point('built');
  check(items === 0 && G.exact(pB), `town: 0 item entities from the bodies' cells (${items}); items in = items out after the build (conservation ${json(pB.diff)}, identity ${pB.identity})`, pB);
  const ps0 = await G.pileState(ctx);
  const rm = await removeWatched(ctx, G, region);
  const ps1 = await G.pileState(ctx);
  const pE = await C.point('removed');
  const e = await G.diff(ctx, box, pre);
  const ef = e.list.filter((m) => !crates.some((c) => c.join(',') === m.pos));
  const refunded = G.minus(ps1.ledger?.returned, ps0.ledger?.returned);
  const fr = rm.shapes.find((x) => x.phase === 'draining');
  out.removal = { state: rm.state, phases: rm.phases, shapes: rm.shapes, watches: rm.watches, after: rm.after, mismatches: ef.length, list: ef.slice(0, 8), refunded, consumed: netOf(G, ps0), conservation: pE };
  check(!!fr && Number.isInteger(fr.until) && Number.isInteger(fr.ticksLeft) && rm.watches.some((w) => w.some((x) => x[1] === 'draining' && x[2])) && rm.after == null,
    `town: while the river drains, RegionView.fluidsRemoval ${json(fr)} (phases ${json(rm.phases)}) and fluidsWatch draining with a box (${json(rm.watches[0] ?? null)}); null after (${json(rm.after)})`);
  check(rm.state === 'REMOVED' && ef.length === 0 && G.exact(pE) && G.same(refunded, netOf(G, ps0)),
    `town: Remove ${rm.state}: E-flat ${ef.length} over the box (the crates aside); refunded ${json(refunded)} = consumed ${json(netOf(G, ps0))} (exact); items in = items out (conservation ${json(pE.diff)})`, out.removal);
  return out;
}

export { carvedOf, fallSets, openedInGame };
export const SURVIVAL = [
  { key: 'isle', name: 'c05 in survival: the fall off the staged island waits terrain, then settles; the hidden room outside the watch set, built, kept, dry', run: isle },
  { key: 'wash', name: 'river_demo in survival: the wash clears cost nothing and credit nothing; conservation and 0 item entities', run: (ctx) => washRow(ctx, null) },
  { key: 'nowash', name: 'the control: river_demo nowash in survival washes its meadow (recorded)', run: (ctx) => washRow(ctx, 'nowash') },
  { key: 'town', name: 'c03 in survival: the lots\' bills, the road bridge, the banks and lining in the region remainder; Remove E-flat 0 and exact', run: town },
];
