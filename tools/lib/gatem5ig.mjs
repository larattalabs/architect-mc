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
//   node tools/gate6dgr.mjs igsurvival  (ig-survival)  a survival V town, fed until built; the irrigated growth quoted (the shells' pieces
//                                                      in the bill), realised with the field entry, fed partly (the sources wait: no water),
//                                                      the server restarted, fed the rest: PLACED, every source settled, consumed equals the
//                                                      quote item for item; undoRevision killed at RVU2 (drained, nothing removed), resumed
//                                                      after the restart: the world before the growth, no water, what it consumed refunded
//                                                      exactly once
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
    const rvir = (await call('dev.rv.ir', { region, rid: g.revisionOf.rid }, 60_000)).ir;
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
    const lv = st.view.lots.find((l) => l.id === FARM.id);
    const sites = await call('dev.sites.state', {}, 30_000);
    const site = [...(sites.sites ?? []), ...(sites.placed ?? [])].find((s) => s.id === lv?.siteId);
    const dropped = site?.ext?.['architect_mc:irrigationDropped'];
    const { expectedDropped } = await import('./gate6cirr-game.mjs');
    const want = await expectedDropped(ctx, bp, { front: P.lot.front, irrigation: P.irr });
    const out = { rows: rows.map((r) => [r.body, r.state, r.reason ?? null]), water: water.length, srcWater, sides: [sides, R.sides.length], over: [over, R.over.length], bedsAir, lot: lv, dropped, want };
    check(rows.length === 4 && rows.every((r) => r.state === 'settled') && water.length === R.sources.length && onSources && srcWater === R.sources.length,
      `${label}: the growth's 4 irrigation sources settled (rows ${json(out.rows.map((r) => r.slice(0, 2)))}); water on exactly its ${R.sources.length} source cells (${water.length} water cells in the lot's box + 2, all on sources: ${onSources})`, out);
    check(sides === R.sides.length && over === R.over.length && bedsAir === 0 && lv?.state === 'placed' && dropped === want && want > 0,
      `${label}: the mask held: ${sides}/${R.sides.length} sides farmland (or dirt), ${over}/${R.over.length} cells over the sources air, no bed air (${bedsAir}); the lot's site ${lv?.siteId} ${lv?.state}, irrigationDropped ${dropped} (the kit's fit: ${want})`, out);
    return out;
  }

  steps.igunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/ig.test.mjs', 'kit/test/irr.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 14, `kit ig.test (an irrigated grow lot's sources, record in the lot frame, stages and M25/M29; the refusals; irrigate false = absent; the survival bill holds the shells once) and irr.test (plan/0's IRR through the shared helper): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*IgLotDrainTest*', '*ApiIrrTest*'], 5);
    check(out.java.ok, `IgLotDrainTest (a grown lot is its revision's: drainLot drains through that revision's record), ApiIrrTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
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
        const t0 = Date.now();
        let wet = 0;
        while (Date.now() - t0 < 300_000) {
          await sleep(30_000);
          wet = await count(field, 'minecraft:farmland[moisture=7]');
          if (wet === field.length) break;
        }
        const farm = await count(field, 'minecraft:farmland');
        out.hydrate = { field: field.length, wet, farm, seconds: Math.round((Date.now() - t0) / 1000) };
        check(wet === field.length && farm === field.length, `hydrate: every farmland cell of the grown lot's field moisture=7 at default rules (${wet}/${field.length} after ${out.hydrate.seconds} s; IRR's bound 240 s, one random tick each)`, out.hydrate);
        await L.setRules('exact');
      }
      await L.leaveWorld();
    }
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
    out.partly = { fed: acc, outstanding: ps.outstanding, revision: midR?.state, water: midWater.length };
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
    // undoRevision, killed at RVU2 (drained, nothing removed yet), resumed after the restart: the world before it; the refund once
    await call('dev.journal.killAt', { point: 'RVU2' }, 10_000);
    call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
    const down = await haltWait();
    check(down, 'survival: RVU2 halted the server during the irrigated growth\'s undo (drained, nothing removed)');
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
        `survival: the undo killed at RVU2 resumed after the restart and finished: position ${s.position}, ${json(s.revisions.map((x) => [x.rid, x.state]))}; the world before the growth (${d.n} differ), no water (${left.length})`, d.first);
      check(G.same(back, paid), `survival: what the growth consumed came back exactly once across the kill and the restart: consumed ${json(paid)}, the stockpile's stock (with overflow) moved by ${json(back)}`, { back, paid, diff: G.minus(back, paid) });
      const u2 = await call('dev.rv.undo', { region, toPosition: 0 }, 60_000);
      check(String(u2.refused ?? '').startsWith('NOT_ALLOWED'), `survival: a second undo has nothing left (refused: ${u2.refused})`);
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
