// M5 IG gate (docs/CONTRACT.md "M5 support", slice IG; Steward's S-M5-2): irrigated growth, registered into tools/gate6dgr.mjs (GR's town,
// growth, survival and kill-point helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs igunit      (ig-unit)      kit ig.test (an irrigated grow lot: sources, record, stages, M25/M29, refusals, byte
//                                                      identity, the survival bill) and irr.test (plan/0's IRR unchanged by the shared
//                                                      helper); IgLotDrainTest, ApiIrrTest; api-compat
//   node tools/gate6dgr.mjs iginstant   (ig-instant)   a V town (flat_village, no irrigation) grows by an irrigated farm lot (crop_farm
//                                                      20 x 21, `irrigate: true`) with IRR's field entry bound: the plan's lot reports
//                                                      architect_mc:lotIrrigation; PLACED, every source settled, water only on the sources,
//                                                      the mask held, irrigationDropped as the kit fits it; the lot's site removed alone
//                                                      drains its sources (the revision's own record); undoRevision: the world before the
//                                                      growth. A second growth's undo killed at RVU1, resumed after the restart: the world
//                                                      before it, no water. A third world: hydration at default rules (recorded bound 300 s)
//   node tools/gate6dgr.mjs igsurvival  (ig-survival)  a survival V town, fed until built; a plain grown lot (RS hut): it waits for
//                                                      its earlier stage, consumed = quote, undo returns it all; the irrigated growth quoted (the shells' pieces
//                                                      in the bill), realised with the field entry, fed partly (the sources wait: no water),
//                                                      the server restarted, fed the rest: PLACED, every source settled, consumed equals the
//                                                      quote item for item; undoRevision killed at RVU2 (drained, nothing removed), resumed
//                                                      after the restart: the world before the growth, no water, what it consumed refunded
//                                                      exactly once
//   node tools/gate6dgr.mjs igbunit     (igb-unit)     IG-b offline: kit igb.test, ig.test, ad.test, the parity fixtures; RevisionsTest; api-compat
//   node tools/gate6dgr.mjs igbadopted  (igb-adopted)  IG-b (S-M5-8) in game: AD's Steward-shaped settlement adopted (one stage, adopted) grows
//                                                      an irrigated farm lot instantly: the revision's own stages adopted, street, lots, fluids;
//                                                      the report, the sources, the mask; the lot removed alone drains; undoRevision exact; a
//                                                      second growth's undo killed at RVU1, resumed after the restart: exact, no water; then
//                                                      Regions.remove E-flat 0 against the world before the settlement. (An adopted region
//                                                      builds in creative only: RegionAdopt sets no survival record)
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const k3 = (c) => `${c[0]},${c[1]},${c[2]}`;
const runsCells = (runs) => { const out = []; for (const [x, z, y0, y1] of runs ?? []) for (let y = y0; y <= y1; y++) out.push([x, y, z]); return out; };
/** The irrigated farm lot Steward's crop farm asks for: field 18 x 18 (W = F + 2, D = F + 3), 2 x 2 sources. */
const FARM = { id: 'farm_m', type: 'crop_farm', size: [20, 21], irrigate: true };
const FIELD = 'ig_field_20x21';
/** The town's lots: V's flat_village, no irrigation anywhere (pads; no entries, so the town is quick to build). */
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];

export async function registerIG(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvState, rvWait, root, cellsOf, diff, haltWait, removeRegion, OWNER } = h;
  const ctx = { L, OUT, KIT: path.join(root, 'kit'), imp: h.imp };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isBlock = async ([x, y, z], block) => { const r = await L.cmd(`/execute if block ${x} ${y} ${z} ${block}`); return !!(r?.success || Number(r?.result) > 0); };
  const count = async (cells, block) => { let n = 0; for (const c of cells) if (await isBlock(c, block)) n++; return n; };
  const fluidsIn = async (box) => (await call('dev.fluid.census', { box }, 600_000)).fluids ?? [];
  const waterIn = async (box) => (await fluidsIn(box)).filter((f) => /water/.test(String(f[3])));

  /** The apitest event log's ITEM_WAITING events of a lot item (`lot:<id>`) of the region: [{say, target, part}]. */
  async function lotWaits(region, lotId) {
    const r = await L.cmd('/apitest events 0');
    const line = (r?.messages ?? []).find((m) => m.startsWith('[') || m.startsWith('{'));
    const ev = line ? JSON.parse(line) : [];
    return ev.filter((e) => e.event === 'ITEM_WAITING' && (e.key ?? e.itemKey) === `lot:${lotId}` && (e.ext?.['architect_mc:region'] ?? region) === region)
      .map((e) => e.ext?.['architect_mc:waitsFor'] ?? {}).map((w) => ({ target: w.target, part: w.part, say: w.say }));
  }

  /** IRR's field entry (kit/test/fixtures/designs/g6c_irr_field.mjs: farmland, wheat, a fence, a composter) at the lot's size. */
  async function installField() {
    const { buildField } = await import('./gate6cirr-game.mjs');
    const r = await buildField(ctx, FIELD, { width: FARM.size[0], depth: FARM.size[1] }, 'wheat', path.join(OUT, 'fields', FIELD));
    const lib = path.join(L.LIBRARY, FIELD);
    fs.rmSync(lib, { recursive: true, force: true });
    fs.mkdirSync(lib, { recursive: true });
    for (const f of fs.readdirSync(r.dir)) fs.copyFileSync(path.join(r.dir, f), path.join(lib, f));
    await L.cmd('/architect reload');
    await L.settle(1500);
    return r.bp;
  }

  /** The irrigation cells of a lot record by role: sources (with a bed under and the cell over them in the record), sides, beds, over. */
  function roles(irr, floorY) {
    const cells = runsCells(irr.cells);
    const set = new Set(cells.map(k3));
    const sources = cells.filter(([x, y, z]) => y === floorY && set.has(k3([x, y - 1, z])) && set.has(k3([x, y + 1, z])));
    const src = new Set(sources.map(k3));
    return { cells, sources, sides: cells.filter((c) => c[1] === floorY && !src.has(k3(c))), beds: cells.filter((c) => c[1] === floorY - 1), over: cells.filter((c) => c[1] === floorY + 1) };
  }

  /** The growth planned: the plan's lot as the API reports it (LotSpec.ext's architect_mc:lotIrrigation), checked against the IR's. */
  async function planGrowth(region, label) {
    const g = await growPlan(region, { lots: [FARM] });
    check(!g.refused && g.revisionOf?.rid >= 1, `${label}: the irrigated growth planned (planRevision, crop_farm 20 x 21, irrigate): ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}, stages ${json(g.stages)}`}`);
    if (g.refused) return { g };
    const lot = (g.lots ?? []).find((l) => l.id === FARM.id);
    const irr = lot?.ext?.['architect_mc:lotIrrigation'];
    // (the candidate's IR: the plan's own ir.json in the sidecar's data; dev.rv.ir reads accepted revisions only)
    const rvir = JSON.parse(fs.readFileSync(path.join(L.SIDECAR_DATA, 'regions', 'plans', g.planId, 'ir.json'), 'utf8'));
    const irLot = rvir?.lots?.find((l) => l.id === FARM.id);
    check(!!irr && irr.sources === 4 && json(irr.frame) === json(FARM.size) && Array.isArray(irr.lotCells) && Array.isArray(irr.cells) && irr.bodies?.length === 4 && json(irr) === json(irLot?.irrigation)
      && g.stages.includes('fluids') && g.stages.indexOf('street') < g.stages.indexOf('lots'),
    `${label}: S-M5-2's report: the plan's lot ${FARM.id} carries architect_mc:lotIrrigation {sources ${irr?.sources}, bodies ${json(irr?.bodies)}, frame ${json(irr?.frame)}, ${irr?.lotCells?.length} lotCells runs, ${irr?.cells?.length} cells runs}, equal to the revision IR's; stages ${json(g.stages)} (the shells in street, the water in fluids, last)`, { lot, irLot: irLot?.irrigation });
    return { g, lot, irr, rvir, irLot };
  }

  /** The grown lot placed: PLACED, every source row settled, water exactly on the sources, the mask held, irrigationDropped as fitted. */
  async function placedChecks(region, P, bp, label) {
    const rid = P.g.revisionOf.rid;
    const st = await call('dev.region.state', { region }, 60_000);
    const rows = (st.view.ext?.['architect_mc:fluids'] ?? []).filter((r) => r.rid === rid);
    const R = roles(P.irr, P.lot.floorY);
    const b = P.lot.box;
    const water = await waterIn([b[0] - 2, P.lot.floorY - 3, b[2] - 2, b[3] + 2, P.lot.floorY + 3, b[5] + 2]);
    const onSources = water.every((f) => R.sources.some((s) => k3(s) === k3(f)));
    const srcWater = await count(R.sources, 'minecraft:water');
    const sides = (await count(R.sides, 'minecraft:farmland')) + (await count(R.sides, 'minecraft:dirt'));
    const over = await count(R.over, 'minecraft:air');
    const bedsAir = await count(R.beds, 'minecraft:air');
    // (the field entry plants wheat over every field cell; the cell over a farmland side is the design's, not reserved: IRR §6)
    const overSides = await count(R.sides.map(([x, y, z]) => [x, y + 1, z]), 'minecraft:wheat');
    const lv = st.view.lots.find((l) => l.id === FARM.id);
    const sites = await call('dev.sites.state', {}, 30_000);
    const site = [...(sites.sites ?? []), ...(sites.placed ?? [])].find((s) => s.id === lv?.siteId);
    const dropped = site?.ext?.['architect_mc:irrigationDropped'];
    const { expectedDropped } = await import('./gate6cirr-game.mjs');
    const want = await expectedDropped(ctx, bp, { front: P.lot.front, irrigation: P.irr });
    const out = { rows: rows.map((r) => [r.body, r.state, r.reason ?? null]), water: water.length, srcWater, sides: [sides, R.sides.length], over: [over, R.over.length], bedsAir, overSides, lot: lv, dropped, want };
    check(rows.length === 4 && rows.every((r) => r.state === 'settled') && water.length === R.sources.length && onSources && srcWater === R.sources.length,
      `${label}: the growth's 4 irrigation sources settled (rows ${json(out.rows.map((r) => r.slice(0, 2)))}); water on exactly its ${R.sources.length} source cells (${water.length} water cells in the lot's box + 2, all on sources: ${onSources})`, out);
    check(sides === R.sides.length && over === R.over.length && bedsAir === 0 && lv?.state === 'placed' && dropped === want && want > 0,
      `${label}: the mask held: ${sides}/${R.sides.length} sides farmland (or dirt), ${over}/${R.over.length} cells over the sources air, no bed air (${bedsAir}); the lot's site ${lv?.siteId} ${lv?.state}, irrigationDropped ${dropped} (the kit's fit: ${want})`, out);
    check(overSides === R.sides.length, `${label}: IRR's order (mask, shell, lot): the lot's crop over each of the ${R.sides.length} farmland sides stands (${overSides} wheat): the lot was put down over its shells, not before them`, out);
    return out;
  }

  function apiCompat() {
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    return [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
  }

  // (M5 IG-b) igb-unit: kit igb.test (an adopted street town's irrigated growth adds street, lots and fluids; a dry one as before; the
  // refusals; the survival bill), ig.test, ad.test and the parity fixtures re-cut (revise.mjs's programSha); RevisionsTest; api-compat
  steps.igbunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/igb.test.mjs', 'kit/test/ig.test.mjs', 'kit/test/ad.test.mjs', 'kit/test/irr.test.mjs', 'kit/test/gr-parity.test.mjs', 'kit/test/rv-a.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 30, `kit igb.test (an adopted street town's irrigated growth: the revision adds street, lots and fluids after adopted, the shells in street, the lot in lots, M25/M29 clean; a dry growth there as before; a base naming street or lots out of order refuses; the survival bill holds the 4 shells once), ig.test, ad.test, irr.test; gr-parity and rv-a (re-cut: programSha only): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*IgLotDrainTest*', '*RevisionsTest*', '*RegionAdoptTest*'], 9);
    check(out.java.ok, `IgLotDrainTest, RevisionsTest (the re-cut merge fixture), RegionAdoptTest: ${out.java.tests} tests, ${out.java.failures} failures`, out.java.tail);
    out.apicompat = apiCompat();
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the apitest jars and the mod surface (no API change: the kit adds the stages)', out.apicompat);
    spendZero();
    return out;
  };

  steps.igunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/ig.test.mjs', 'kit/test/irr.test.mjs', 'kit/test/gr-parity.test.mjs', 'kit/test/rv-a.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 25, `kit ig.test (an irrigated grow lot's sources, record in the lot frame, stages and M25/M29; the refusals; irrigate false = absent; the survival bill holds the shells once) and irr.test (plan/0's IRR through the shared helper); gr-parity and rv-a (the parity fixtures re-cut: revise.mjs's programSha only): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*IgLotDrainTest*', '*ApiIrrTest*', '*RevisionsTest*'], 10);
    check(out.java.ok, `IgLotDrainTest (a grown lot is its revision's: drainLot drains through that revision's record), ApiIrrTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    out.apicompat = apiCompat();
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the 0.47.0 and 0.45.0 apitest jars and the 0.47.0 mod surface (no API type changed: a grow lot\'s irrigate is JSON, the report a LotSpec.ext member)', out.apicompat);
    spendZero();
    return out;
  };

  /** A V town with no irrigation in a fresh flat world: {region, gy, BOX, S0 (the claim box's cells)}. */
  async function vTown(world) {
    await L.fresh(world, 'G6B Flat Base');
    await L.setRules('exact');
    await cmd('/op @s').catch(() => null);
    await L.tp(CX + 80, 60, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const p = await L.plan('flat_village', CLAIM, { params: { lots: TOWN_LOTS }, surveyLoad: 'bounded:256', check: false, owner: OWNER });
    const region = await L.realise(p.planId, { load: 'bounded:512', lots: {} });
    const st = await L.waitRegion(region, 3_600_000);
    const irrigated = (st.view.lots ?? []).length;
    check(st.view.state === 'PLACED', `${world}: a V town (flat_village, ${irrigated} lots, no irrigation anywhere): ${st.view.state}`);
    return { region, gy, BOX };
  }

  steps.iginstant = async () => {
    await ensure();
    const out = {};
    // ---- 1. a growth by an irrigated farm lot, instantly; its lot removed alone; undone
    {
      const W = 'G6B IG Instant';
      const T = await vTown(W);
      const bp = await installField();
      const S0 = await cellsOf(T.BOX);
      const P = await planGrowth(T.region, 'instant');
      if (!P.g.refused) {
        const r = await call('dev.region.realise', { planId: P.g.planId, lots: { [FARM.id]: FIELD } }, 300_000);
        check(!r.refused, `instant: the growth realised with the field entry bound: ${r.refused ?? r.region}`);
        const w = await rvWait(T.region, P.g.revisionOf.rid);
        check(w.r.state === 'PLACED', `instant: the growth's revision ${w.r.rid} ${w.r.state}`);
        out.placed = await placedChecks(T.region, P, bp, 'instant');
        // S-IRR-4 on a grown lot: its site removed alone drains its sources first (the revision's own fluids record), the shells stay
        const sid = out.placed.lot?.siteId;
        const rm = await call('dev.sites.remove', { site: sid, force: true }, 600_000);
        for (let i = 0; i < 120; i++) { const s = await call('dev.sites.state', {}, 30_000); if (!JSON.stringify(s).includes(`"${sid}"`) || JSON.stringify(s).includes('"removed":true')) break; await sleep(1000); }
        await L.settle(5000);
        const R = roles(P.irr, P.lot.floorY);
        const b = P.lot.box;
        const water = await waterIn([b[0] - 2, P.lot.floorY - 3, b[2] - 2, b[3] + 2, P.lot.floorY + 3, b[5] + 2]);
        const st = await call('dev.region.state', { region: T.region }, 60_000);
        const rows = (st.view.ext?.['architect_mc:fluids'] ?? []).filter((x) => x.rid === P.g.revisionOf.rid);
        const sides = (await count(R.sides, 'minecraft:farmland')) + (await count(R.sides, 'minecraft:dirt'));
        out.lotAlone = { removed: rm.removed ?? rm, water: water.length, rows: rows.map((x) => [x.body, x.state, x.reason]), state: st.view.state, sides };
        check(water.length === 0 && rows.length === 4 && rows.every((x) => x.state === 'drained' && /lot removed/.test(x.reason ?? '')) && st.view.state === 'PLACED' && sides === R.sides.length,
          `instant (S-IRR-4 on a grown lot): its site removed alone: its 4 sources drained first and exactly (0 water in its box + 2: ${water.length}), each row 'drained: lot removed', the region ${st.view.state}, the revision's farmland sides standing (${sides}/${R.sides.length})`, out.lotAlone);
        const u = await call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000);
        const d = diff(S0, await cellsOf(T.BOX));
        const left = await waterIn(T.BOX);
        out.undo = { removed: u.removed, refused: u.refused, diff: d, water: left.length };
        check(u.removed === true && d.n === 0 && left.length === 0, `instant: undoRevision after the lot went: the world before the growth (${d.n} differ), no water in the claim box (${left.length})`, d.first);
        // a second growth, undone with the operation killed at RVU1 (the commit point: nothing drained or removed), resumed after a restart
        const P2 = await planGrowth(T.region, 'instant, again');
        if (!P2.g.refused) {
          await call('dev.region.realise', { planId: P2.g.planId, lots: { [FARM.id]: FIELD } }, 300_000);
          const w2 = await rvWait(T.region, P2.g.revisionOf.rid);
          const water2 = await waterIn(T.BOX);
          check(w2.r.state === 'PLACED' && water2.length === 4, `instant, again: the second growth (rid ${w2.r.rid}) ${w2.r.state}, ${water2.length} water cells (its 4 sources)`);
          await call('dev.journal.killAt', { point: 'RVU1' }, 10_000);
          call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
          const down = await haltWait();
          check(down, 'instant, again: RVU1 halted the server during the irrigated growth\'s undo');
          if (!down) await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
          else {
            await L.openWorld(W);
            await L.tp(CX + 80, 60, CZ + 56);
            let s;
            const t0 = Date.now();
            for (; Date.now() - t0 < 1_800_000;) { s = await rvState(T.region); if (s.busy === null) break; await sleep(L.pollDelayMs(Date.now() - t0)); }
            const d2 = diff(S0, await cellsOf(T.BOX));
            const left2 = await waterIn(T.BOX);
            out.killed = { busy: s.busy, position: s.position, states: s.revisions.map((r) => [r.rid, r.state]), diff: d2, water: left2.length };
            check(s.busy === null && s.position === 0 && s.revisions.every((r) => r.state === 'UNDONE') && d2.n === 0 && left2.length === 0,
              `instant, again: the undo killed at RVU1 resumed after the restart and finished drain-first: position ${s.position}, ${json(s.revisions.map((r) => [r.rid, r.state]))}; the world before the growth (${d2.n} differ), no water (${left2.length})`, out.killed);
          }
        }
      }
      const rmr = await removeRegion(T.region);
      out.removed = rmr?.removed ?? rmr;
      await L.leaveWorld();
    }
    // ---- 2. hydration (its own world: random ticks change the field, so no exact undo is judged here)
    {
      const W = 'G6B IG Hydrate';
      const T = await vTown(W);
      const bp = await installField();
      const P = await planGrowth(T.region, 'hydrate');
      if (!P.g.refused) {
        await call('dev.region.realise', { planId: P.g.planId, lots: { [FARM.id]: FIELD } }, 300_000);
        await rvWait(T.region, P.g.revisionOf.rid);
        await placedChecks(T.region, P, bp, 'hydrate');
        // the field: every farmland cell of the lot's field (W - 2 x D - 3, the irrigation cells aside) at the floor
        const R = roles(P.irr, P.lot.floorY);
        const skip = new Set(R.cells.map(k3));
        const [x0, z0, x1, z1] = P.irr.field;
        const field = [];
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (!skip.has(k3([x, P.lot.floorY, z]))) field.push([x, P.lot.floorY, z]);
        await L.setRules('default');
        await cmd('/gamerule random_tick_speed 3');
        // (recorded) IRR's bound at vanilla's speed: each cell needs one random tick (about 68 s apart on average at speed 3), so over
        // 304 cells a few are still unticked at 240-300 s (run 2: 300/304 at 300 s). Judged: every field cell's reach, with the random
        // ticks sped up (speed 48) until each has had one: a dry cell left then is out of reach.
        const t0 = Date.now();
        let wet = 0;
        while (Date.now() - t0 < 240_000) {
          await sleep(30_000);
          wet = await count(field, 'minecraft:farmland[moisture=7]');
          log(`  hydrate: ${wet}/${field.length} moisture=7 after ${Math.round((Date.now() - t0) / 1000)} s (speed 3)`);
          if (wet === field.length) break;
        }
        const at240 = wet;
        await cmd('/gamerule random_tick_speed 48');
        const t1 = Date.now();
        while (wet < field.length && Date.now() - t1 < 180_000) {
          await sleep(20_000);
          wet = await count(field, 'minecraft:farmland[moisture=7]');
          log(`  hydrate: ${wet}/${field.length} moisture=7 after ${Math.round((Date.now() - t1) / 1000)} s more (speed 48)`);
        }
        const farm = await count(field, 'minecraft:farmland');
        out.hydrate = { field: field.length, at240, wet, farm, seconds: Math.round((Date.now() - t0) / 1000) };
        check(true, `hydrate (recorded): ${at240}/${field.length} field cells moisture=7 within IRR's 240 s at default rules (one random tick each)`);
        check(wet === field.length && farm === field.length, `hydrate: every farmland cell of the grown lot's field (${field.length}) moisture=7, so every one is in a source's reach (${wet}/${field.length}; the random ticks sped up after 240 s)`, out.hydrate);
        await L.setRules('exact');
      }
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };

  // ------------------------------------------------------------------ (M5 IG-b, S-M5-8) an adopted street town grows an irrigated farm lot

  /** AD's cabin entry (kit/build.mjs cabin, v1) in the library under `id`: the settlement's lots' design. */
  async function installCabin(id = 'igb_cabin') {
    const { execFileSync } = await import('node:child_process');
    const tmp = path.join(OUT, 'kitbuild', id);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('node', [path.join(root, 'kit', 'build.mjs'), 'cabin', '--out', tmp], { stdio: 'ignore' });
    const lib = path.join(L.LIBRARY, id);
    fs.rmSync(lib, { recursive: true, force: true });
    fs.mkdirSync(lib, { recursive: true });
    for (const f of fs.readdirSync(tmp)) {
      if (!f.startsWith('cabin.')) continue;
      const target = path.join(lib, id + f.slice('cabin'.length));
      if (f.endsWith('.blueprint.json')) {
        const j = JSON.parse(fs.readFileSync(path.join(tmp, f), 'utf8'));
        Object.assign(j, { id, name: id, source: `${id}.mjs` });
        fs.writeFileSync(target, JSON.stringify(j, null, 2));
      } else fs.copyFileSync(path.join(tmp, f), target);
    }
    await L.cmd('/architect reload');
    await L.settle(2000);
    return id;
  }
  async function adBatchWait(batchId, timeoutMs = 600_000) {
    const t0 = Date.now();
    let b;
    while (Date.now() - t0 < timeoutMs) {
      b = await call('dev.ad.batch', { batchId }, 10_000);
      if (['DONE', 'CANCELLED', 'FAILED'].includes(b.status)) return b;
      await sleep(L.pollDelayMs(Date.now() - t0));
    }
    throw new Error(`batch ${batchId} did not end: ${json(b)}`);
  }
  /**
   * AD's Steward-shaped settlement (tools/gate6dad.mjs `settlement`): a founding build (the street, 4 lots of 15 x 17 alternating north and
   * south, lotGap 3) and an addition (street#2 and one lot) in two groups, then Regions.adopt: one region, one stage `adopted`.
   */
  async function adoptedTown(cx, cz, y, entry) {
    const LOT = { sx: 15, sz: 17 };
    const sz = cz + 48;
    const lots = [];
    let xn = cx + 12, xs = cx + 12;
    for (let i = 0; i < 4; i++) {
      const north = i % 2 === 0;
      const x = north ? xn : xs;
      lots.push({ id: `house_${i + 1}`, x, z: north ? sz - 3 - LOT.sz + 1 : sz + 3, sx: LOT.sx, sz: LOT.sz, north });
      if (north) xn = x + LOT.sx + 3; else xs = x + LOT.sx + 3;
    }
    const x0 = Math.min(...lots.map((l) => l.x)), x1 = Math.max(...lots.map((l) => l.x + l.sx - 1));
    const build = async (bl, spans, b, keys) => {
      const q = await call('dev.ad.settlement', { owner: OWNER, entry, streetZ: sz, y, lots: bl, spans, settlement: 'igb', build: b, ...(keys ? { keys } : {}) }, 120_000);
      if (q.refused) throw new Error(`the build was refused: ${q.refused}`);
      const done = await adBatchWait(q.batchId);
      const bad = done.items.filter((i) => i.status !== 'PLACED');
      check(done.status === 'DONE' && !bad.length, `adopted town: Steward's build ${b}: ${done.items.length} items placed in group ${done.group} (${json(bad)})`);
      return Object.fromEntries(done.items.map((i) => [i.key, i.site]));
    };
    const b1 = await build(lots, [[x0, x1]], 'b1');
    const ax = x1 + 4;
    const add = { id: 'house_5', x: ax, z: sz + 3, sx: LOT.sx, sz: LOT.sz, north: false };
    const b2 = await build([add], [[x1 + 1, ax + LOT.sx - 1]], 'b2', ['street#2']);
    const lotSites = {};
    for (const l of [...lots, add]) lotSites[l.id] = b1[l.id] ?? b2[l.id];
    const claim = [cx, cz, cx + 160, cz + 96];
    const a = await call('dev.ad.adopt', { owner: OWNER, claim, geometry: { streetZ: sz, xLo: x0, xHi: ax + LOT.sx - 1 }, roads: [b1.street, b2['street#2']], lots: lotSites }, 900_000);
    check(!a.refused && a.state === 'PLACED', `adopted town: Regions.adopt of the settlement (5 lots, 2 street pieces): region ${a.region} ${a.state ?? a.refused}`);
    const st = await call('dev.region.state', { region: a.region }, 60_000);
    return { region: a.region, claim, st };
  }

  steps.igbadopted = async () => {
    await ensure();
    const out = {};
    const W = 'G6B IGb Adopted';
    await L.fresh(W, 'G6B Flat Base');
    await L.setRules('exact');
    await cmd('/op @s').catch(() => null);
    await L.tp(CX + 80, 60, CZ + 48);
    const gy = await groundY(CX + 4, CZ + 4);
    const cabin = await installCabin();
    const BOX = BOXOF([CX, CZ, CX + 160, CZ + 96], gy);
    const B0 = await cellsOf(BOX);
    const T = await adoptedTown(CX, CZ, gy + 1, cabin);
    if (!T.region) { await L.leaveWorld(); spendZero(); return out; }
    const region = T.region;
    const rir = JSON.parse(fs.readFileSync(path.join(L.SAVES, W, 'architect-regions', region, 'ir.json'), 'utf8'));
    out.base = { stages: rir.stages, survival: T.st.view?.survival ?? null };
    check(json(rir.stages) === json(['adopted']), `adopted town: its IR has the one stage adopted (${json(rir.stages)}): before IG-b an irrigated growth here refused NOT_ALLOWED [irrigate]`);
    const bp = await installField();
    const S0 = await cellsOf(BOX);
    const P = await planGrowth(region, 'adopted');
    if (!P.g.refused) {
      out.plan = { stages: P.g.stages, lotStage: P.irLot ? P.rvir.lots.find((l) => l.id === FARM.id)?.stage : null };
      const shells = (P.rvir.parts ?? []).filter((p) => /_irr_\d+_\d+_shell$/.test(p.id));
      check(json(P.g.stages) === json(['adopted', 'street', 'lots', 'fluids']) && out.plan.lotStage === 'lots' && shells.length === 4 && shells.every((p) => p.stage === 'street'),
        `adopted: the revision adds its own stages (${json(P.g.stages)}): the 4 shells in street (${json(shells.map((p) => p.stage))}), the farm lot in lots (${out.plan.lotStage}), the water in fluids; the base's adopted unchanged`, out.plan);
      const r = await call('dev.region.realise', { planId: P.g.planId, lots: { [FARM.id]: FIELD } }, 300_000);
      check(!r.refused, `adopted: the growth realised with the field entry bound: ${r.refused ?? r.region}`);
      const w = await rvWait(region, P.g.revisionOf.rid);
      check(w.r.state === 'PLACED', `adopted: the growth's revision ${w.r.rid} ${w.r.state} (stages ${json(w.r.stages ?? null)})`);
      out.placed = await placedChecks(region, P, bp, 'adopted');
      // the adopted sites stand as they were: the growth wrote only its own cells (none of the five lots' or the street's boxes moved)
      const lv = (await call('dev.region.state', { region }, 60_000)).view.lots;
      check(lv.filter((l) => l.id.startsWith('house_')).every((l) => l.state === 'placed') && lv.length === 6, `adopted: the region's lots: ${json(lv.map((l) => [l.id, l.state]))}`);
      // S-IRR-4 on the grown lot: its site removed alone drains its sources first
      const sid = out.placed.lot?.siteId;
      const rm = await call('dev.sites.remove', { site: sid, force: true }, 600_000);
      for (let i = 0; i < 120; i++) { const s = await call('dev.sites.state', {}, 30_000); if (!JSON.stringify(s).includes(`"${sid}"`) || JSON.stringify(s).includes('"removed":true')) break; await sleep(1000); }
      await L.settle(5000);
      const R = roles(P.irr, P.lot.floorY);
      const b = P.lot.box;
      const water = await waterIn([b[0] - 2, P.lot.floorY - 3, b[2] - 2, b[3] + 2, P.lot.floorY + 3, b[5] + 2]);
      const st = await call('dev.region.state', { region }, 60_000);
      const rows = (st.view.ext?.['architect_mc:fluids'] ?? []).filter((x) => x.rid === P.g.revisionOf.rid);
      const sides = (await count(R.sides, 'minecraft:farmland')) + (await count(R.sides, 'minecraft:dirt'));
      out.lotAlone = { removed: rm.removed ?? rm, water: water.length, rows: rows.map((x) => [x.body, x.state, x.reason]), state: st.view.state, sides };
      check(water.length === 0 && rows.length === 4 && rows.every((x) => x.state === 'drained' && /lot removed/.test(x.reason ?? '')) && st.view.state === 'PLACED' && sides === R.sides.length,
        `adopted (S-IRR-4): the grown lot's site removed alone: its 4 sources drained first (${water.length} water in its box + 2), each row 'drained: lot removed', the region ${st.view.state}, the farmland sides standing (${sides}/${R.sides.length})`, out.lotAlone);
      const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
      const d = diff(S0, await cellsOf(BOX));
      const left = await waterIn(BOX);
      out.undo = { removed: u.removed, refused: u.refused, diff: d, water: left.length };
      check(u.removed === true && d.n === 0 && left.length === 0, `adopted: undoRevision after the lot went: the adopted town as before the growth (${d.n} differ), no water in the box (${left.length})`, d.first);
      // a second growth (the lot standing), undone with the operation killed at RVU1, resumed after the restart
      const P2 = await planGrowth(region, 'adopted, again');
      if (!P2.g.refused) {
        await call('dev.region.realise', { planId: P2.g.planId, lots: { [FARM.id]: FIELD } }, 300_000);
        const w2 = await rvWait(region, P2.g.revisionOf.rid);
        out.placed2 = await placedChecks(region, P2, bp, 'adopted, again');
        check(w2.r.state === 'PLACED', `adopted, again: the second growth (rid ${w2.r.rid}) ${w2.r.state}`);
        await call('dev.journal.killAt', { point: 'RVU1' }, 10_000);
        call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
        const down = await haltWait();
        check(down, 'adopted, again: RVU1 halted the server during the irrigated growth\'s undo');
        if (!down) await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        else {
          await L.openWorld(W);
          await L.tp(CX + 80, 60, CZ + 48);
          let s;
          const t0 = Date.now();
          for (; Date.now() - t0 < 1_800_000;) { s = await rvState(region); if (s.busy === null) break; await sleep(L.pollDelayMs(Date.now() - t0)); }
          const d2 = diff(S0, await cellsOf(BOX));
          const left2 = await waterIn(BOX);
          out.killed = { busy: s.busy, position: s.position, states: s.revisions.map((x) => [x.rid, x.state]), diff: d2, water: left2.length };
          check(s.busy === null && s.position === 0 && s.revisions.every((x) => x.state === 'UNDONE') && d2.n === 0 && left2.length === 0,
            `adopted, again: the undo killed at RVU1 resumed after the restart and finished drain-first: position ${s.position}, ${json(out.killed.states)}; the adopted town as before (${d2.n} differ), no water (${left2.length})`, out.killed);
          const u2 = await call('dev.rv.undo', { region, toPosition: 0 }, 60_000);
          check(String(u2.refused ?? '').startsWith('NOT_ALLOWED'), `adopted, again: a second undo has nothing left (refused: ${u2.refused})`);
        }
      }
    }
    // the adopted region removed: E-flat 0 against the world before the settlement (AD's row 5 after the growths)
    const rmr = await removeRegion(region);
    const d5 = diff(B0, await cellsOf(BOX));
    out.removed = { removed: rmr?.removed ?? rmr, diff: d5 };
    check(rmr?.removed === true && d5.n === 0, `adopted: Regions.remove after the growths: removed ${rmr?.removed}; E-flat ${d5.n} against the world before the settlement`, d5.first);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.igsurvival = async () => {
    await ensure();
    const out = {};
    const SW = 'G6B IG Survival';
    await G.survivalBase(ctx);
    await L.fresh(SW, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const bp = await installField();
    const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    // the town in survival (V, no irrigation), fed until built
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN_LOTS }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: {} });
    const f0 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `the survival V town built: ${f0.last.st.view.state} (${f0.waves} feed waves)`);
    const targets0 = new Set((f0.last.rs?.targets ?? []).map((x) => x.id));
    // ---- a plain grown lot (no irrigation) with RS's hut, the coordinator's ask: RegionTargets.roi now reads a revision lot from its
    // revision's IR, so every grown lot in survival waits for its earlier stages' targets (§6.3). It waits; items in equal items out;
    // QT's quote equals what is consumed; undone, the refund equals the consumption.
    {
      await G.designs(ctx);
      const plain = { id: 'hb', type: 'house', size: [9, 9], villager: 'dwelling' };
      const g = await growPlan(region, { lots: [plain] });
      check(!g.refused, `plain: a growth by a plain lot (no irrigation) planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
      if (!g.refused) {
        const q0 = await call('dev.region.quote', { planId: g.planId, lotEntries: { hb: 'rs_hut' } }, 300_000);
        const a0 = await pile();
        await call('dev.region.realise', { planId: g.planId, lots: { hb: 'rs_hut' } }, 300_000);
        await sleep(10_000); // (nothing fed: the lane's target is unbuilt, so the lot's item must wait for it)
        const waits = await lotWaits(region, 'hb');
        const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
        const w = await rvWait(region, g.revisionOf.rid, 1_800_000);
        const a1 = await pile();
        const used = G.minus(a1.ledger?.consumed ?? {}, a0.ledger?.consumed ?? {});
        out.plain = { waits, quote: q0.bom, consumed: used, state: w.r.state, waves: f.waves };
        check(waits.length >= 1 && waits.every((x) => x.target), `plain: the grown lot's item waited for its earlier stage's targets before its put-down (${waits.length} ITEM_WAITING; ${json(waits[0])})`, out.plain);
        check(w.r.state === 'PLACED' && !q0.refused && G.same(q0.bom, used), `plain: built (${w.r.state}, ${f.waves} waves); consumed equals the quote item for item: quote ${json(q0.bom)}, consumed ${json(used)}`, out.plain);
        const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
        await L.settle(3000);
        const a2 = await pile();
        const back = G.minus(a2.ledger?.returned ?? {}, a1.ledger?.returned ?? {});
        out.plain.undo = { removed: u.removed, refund: u.refund, returned: back };
        check(u.removed === true && G.same(back, used), `plain: undone; items in equal items out: consumed ${json(used)}, returned ${json(back)}`, out.plain.undo);
      }
    }
    const S0 = await cellsOf(BOX);
    // the irrigated growth: planned, quoted (its shells among the pieces), realised with the field entry
    const P = await planGrowth(region, 'survival');
    if (P.g.refused) { await L.leaveWorld(); spendZero(); return out; }
    const rid = P.g.revisionOf.rid;
    const entries = { [FARM.id]: FIELD };
    const q = await call('dev.region.quote', { planId: P.g.planId, lotEntries: entries }, 300_000);
    const shellParts = Object.entries(q.bomParts ?? {}).filter(([k]) => /_irr_\d+_\d+_shell$/.test(k));
    out.quote = { bom: q.bom, bomParts: q.bomParts, exact: q.exact, notes: q.notes, refused: q.refused };
    check(!q.refused && q.survival === true && q.region === region && shellParts.length === 4 && shellParts.every(([, b]) => Object.values(b).reduce((n, v) => n + v, 0) === 5) && q.bomParts[`lot:${FARM.id}`],
      `survival: the growth quoted (S-M5-7 over S-M5-2): its 4 sources' shells billed in the revision's tiles, 5 items each (a bed and four farmland sides as dirt): ${json(shellParts)}; the lot's piece ${json(Object.keys(q.bomParts?.[`lot:${FARM.id}`] ?? {}).length)} items; exact ${q.exact}`, out.quote);
    const ps0 = await pile();
    const r = await call('dev.region.realise', { planId: P.g.planId, lots: entries }, 300_000);
    check(!r.refused, `survival: the growth realised with the quoted entry: ${r.refused ?? r.region}`);
    // its targets put down, waiting: fed partly (half of what is outstanding, once); the sources wait (the fluids stage is last)
    for (let i = 0; i < 90; i++) {
      const rs = await G.rsState(ctx, region);
      if ((rs.targets ?? []).some((x) => !targets0.has(x.id))) break;
      await sleep(2000);
    }
    const ps = await pile();
    const half = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 1) half[it] = Math.floor(lack / 2); }
    const acc = Object.keys(half).length ? (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: half, exact: true }, 120_000)).accepted ?? {} : {};
    await sleep(15_000);
    const mid = await rvState(region);
    const midR = mid.revisions.find((x) => x.rid === rid);
    const midWater = await waterIn(BOX);
    const fwaits = await lotWaits(region, FARM.id);
    out.partly = { fed: acc, outstanding: ps.outstanding, revision: midR?.state, water: midWater.length, lotWaits: fwaits };
    check(fwaits.length >= 1, `survival: IRR's order: the farm lot's item waited for its shells (the street stage's targets) before its put-down (${fwaits.length} ITEM_WAITING; ${json(fwaits[0])})`, fwaits);
    check(Object.keys(acc).length > 0 && midR?.state !== 'PLACED' && midWater.length === 0, `survival: fed partly (${json(acc)}): the growth waits (revision ${midR?.state}), no source written yet (${midWater.length} water cells)`, out.partly);
    // a restart while it waits, then the rest
    await L.leaveWorld();
    await L.openWorld(SW);
    await L.tp(CX + 80, 80, CZ + 56);
    await sleep(3000);
    const f1 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    const w = await rvWait(region, rid, 1_800_000);
    check(w.r.state === 'PLACED' && f1.last.rs.build?.done, `survival: after the restart, fed the rest (${f1.waves} waves): the growth ${w.r.state}, build done ${f1.last.rs.build?.done}`);
    out.placed = await placedChecks(region, P, bp, 'survival');
    const ps1 = await pile();
    const paid = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    out.paid = paid;
    check(Object.keys(q.bom ?? {}).length >= 1 && G.same(q.bom, paid), `survival: the materials consumed equal the quote item for item (across the partial feed and the restart): quote ${json(q.bom)}, consumed ${json(paid)}`, { want: q.bom, paid, diff: G.minus(paid, q.bom ?? {}) });
    // undoRevision, killed at RVU2 after a save (drained, nothing removed yet), resumed after the restart: the world before it; the refund
    // once. The world is saved first and the stockpile read after it: a halt with nothing saved rewinds the crates and the ledger to the
    // last autosave (run 1's reading), so only a saved state is a baseline the refund can be judged against.
    await cmd('/save-all flush');
    await L.settle(3000);
    const ps1s = await pile();
    check(G.same(ps1s.stock ?? {}, ps1.stock ?? {}) && G.same(ps1s.ledger?.consumed ?? {}, ps1.ledger?.consumed ?? {}), 'survival: the stockpile unchanged across the save (the baseline for the refund)');
    await call('dev.journal.killAt', { point: 'RVU2+save' }, 10_000);
    call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
    const down = await haltWait();
    check(down, 'survival: RVU2+save halted the server during the irrigated growth\'s undo (drained, saved, nothing removed)');
    if (!down) await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    else {
      await L.openWorld(SW);
      await L.tp(CX + 80, 80, CZ + 56);
      let s;
      const t0 = Date.now();
      for (; Date.now() - t0 < 1_800_000;) { s = await rvState(region); if (s.busy === null) break; await sleep(L.pollDelayMs(Date.now() - t0)); }
      await L.settle(3000);
      const ps2 = await pile();
      const d = diff(S0, await cellsOf(BOX));
      const left = await waterIn(BOX);
      const back = G.minus(G.plus(ps2.stock ?? {}, ps2.ledger?.refundOverflow ?? {}), G.plus(ps1.stock ?? {}, ps1.ledger?.refundOverflow ?? {}));
      out.undo = { busy: s.busy, position: s.position, states: s.revisions.map((x) => [x.rid, x.state]), diff: d, water: left.length, back, consumed: paid, ledger: ps2.ledger };
      check(s.busy === null && s.position === 0 && s.revisions.find((x) => x.rid === rid)?.state === 'UNDONE' && d.n === 0 && left.length === 0,
        `survival: the undo killed at RVU2+save resumed after the restart and finished: position ${s.position}, ${json(s.revisions.map((x) => [x.rid, x.state]))}; the world before the growth (${d.n} differ), no water (${left.length})`, d.first);
      check(G.same(back, paid), `survival: what the growth consumed came back exactly once across the kill and the restart: consumed ${json(paid)}, the stockpile's stock (with overflow) moved by ${json(back)}`, { back, paid, diff: G.minus(back, paid) });
      const u2 = await call('dev.rv.undo', { region, toPosition: 0 }, 60_000);
      check(String(u2.refused ?? '').startsWith('NOT_ALLOWED'), `survival: a second undo has nothing left (refused: ${u2.refused})`);
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
