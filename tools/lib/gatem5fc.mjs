// M5 FC gate (docs/CONTRACT.md "M5 support", slice FC; Steward's S-M5-4): a module lot's field cells, registered into tools/gate6dgr.mjs
// (GR's survival town, growth and feed helpers). Headless server, the sim sidecar: $0. Strict (refunds, removal).
//
//   node tools/gate6dgr.mjs fcunit    (fc-unit)    the kit's fc.test (field {cells, crops}: validation, the IR's lots[].field, a growth's),
//                                                  FieldCellsTest (the field rule, the deconstruct's cargo seam), LandCheckTest, api-compat
//   node tools/gate6dgr.mjs fcfield   (fc-field)   a survival flat_village town grown by planRevision with a farm lot carrying `field`, bound to
//                                                  fc_field (a 7x7 wheat field), fed until built; the crops grown by random ticks; the player (a
//                                                  fake ServerPlayer: useItemOn, destroyBlock, never setBlock) harvests 44 of them, replants 30
//                                                  with wheat seeds and 10 with carrots, bone-meals 15 to several ages, and puts a cobblestone on
//                                                  one harvested cell; land check and standing at each turn; a restart; undoRevision: not
//                                                  blocked, each planting item back once as cargo at the site (never credited as construction),
//                                                  our standing crops credited as construction, the cobblestone dropped as PT says; items in =
//                                                  items out; a restart after the undo gives nothing again
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SEEDS = 'minecraft:wheat_seeds', CARROT = 'minecraft:carrot', COBBLE = 'minecraft:cobblestone';
/** fc_field's field: farmland at template (1..7, 0, 1..7) of a 9 x 2 x 11 design, front south: the lot frame's [u, 0, v] (a full-lot design). */
const FIELD_CELLS = [];
for (let v = 1; v <= 7; v++) for (let u = 1; u <= 7; u++) FIELD_CELLS.push([u, 0, v]);

export async function registerFC(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, hashOf, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvState, rvWait, rvIr, cellsOf, root } = h;
  const ctx = { L, OUT, imp: h.imp, KIT: path.join(root, 'kit') };

  /** fc_field: a 9 x 11 lot design, front south: a 7 x 7 field of farmland (as dirt in the bill) with wheat at age 0, a path to the street. */
  async function designs() {
    await G.designs(ctx);
    const { Blueprint, palette } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const bp = new Blueprint({ id: 'fc_field', name: 'fc_field', description: 'FC field (7x7 wheat)', type: 'custom', profile: [], size: [9, 2, 11], origin: [0, 0, 0], groundY: 0, front: 'south', palette: palette({}) });
    bp.part('field', () => {
      for (const [u, , v] of FIELD_CELLS) {
        bp.set(u, 0, v, 'minecraft:farmland', { moisture: '0' });
        bp.set(u, 1, v, 'minecraft:wheat', { age: '0' });
      }
      for (let v = 8; v <= 10; v++) bp.set(4, 0, v, 'minecraft:dirt_path');
    });
    bp.spot('entrance', 4, 11, 180);
    const dir = path.join(L.LIBRARY, 'fc_field');
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    await L.cmd('/architect reload');
    await L.settle(1500);
  }

  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const land = (region) => call('dev.region.landCheck', { region }, 600_000);
  const lotRow = (rep, id) => (rep.lots ?? []).find((l) => l.lot === id) ?? null;
  const partsKey = (rep) => json((rep.parts ?? []).map((p) => [p.part, p.cells, p.changed, p.removed, p.playerPlaced, p.volatileChanged]));
  const k = (c) => `${c[0]},${c[1]},${c[2]}`;
  const up = (c) => [c[0], c[1] + 1, c[2]];
  const stateAt = (cells, c) => String(cells.get(k(c)) ?? 'minecraft:air');
  const idOf = (s) => String(s).replace(/\[.*$/, '');
  const ageOf = (s) => Number(/age=(\d+)/.exec(String(s))?.[1] ?? -1);
  /** The world's field: farmland cells, and per crop cell its block. */
  async function fieldNow(box, farm) {
    const cells = await cellsOf(box);
    return farm.map((c) => ({ c, soil: idOf(stateAt(cells, c)), crop: stateAt(cells, up(c)) }));
  }

  steps.fcunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/fc.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 4, `kit fc.test (field {cells, crops}: validation, frame to world on every front, irrigation cells dropped, plan/0's IR lots[].field, a planRevision growth's): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*FieldCellsTest*', '*LandCheckTest*'], 6);
    check(out.java.ok, `FieldCellsTest (the field rule; a player's field crop is cargo once, a same-kind replant included, never construction), LandCheckTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the apitest jars and the mod surface (FC adds no API)', out.apicompat);
    spendZero();
    return out;
  };

  steps.fcfield = async () => {
    await ensure();
    const out = {};
    const SW = 'G6B FC Field';
    await G.survivalBase(ctx);
    await L.fresh(SW, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await cmd('/gamerule randomTickSpeed 0');
    await designs();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const crates = [0, 1, 2, 3].map((q) => [CLAIM[0] - 6 + 2 * q, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    // the town in survival (pads), realised and fed until built
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }] }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: {} });
    const f0 = await G.feed({ L }, region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 1_800_000, every: 2500 });
    check(f0.last.st.view.state === 'PLACED', `the town built in survival: ${f0.last.st.view.state} (${f0.waves} waves)`);
    const t0 = new Set((f0.last.rs?.targets ?? []).map((x) => x.id));
    // the growth: one farm lot with a field, bound to fc_field
    const spec = { id: 'fc_farm', type: 'farm', size: [9, 11], villager: 'farm', field: { cells: FIELD_CELLS, crops: ['minecraft:wheat', 'minecraft:carrots'] } };
    const g = await growPlan(region, { lots: [spec] });
    check(!g.refused && g.revisionOf?.rid >= 1, `a growth planned (planRevision, a farm lot with field {49 cells, wheat and carrots}): ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    const rid = g.revisionOf.rid;
    const ps0 = await pile();
    const r = await call('dev.region.realise', { planId: g.planId, lots: { fc_farm: 'fc_field' } }, 300_000);
    check(!r.refused, `the growth realised with fc_farm: fc_field: ${r.refused ?? r.region}`);
    const ir = await rvIr(region, rid);
    const irLot = ir?.lots?.find((l) => l.id === 'fc_farm');
    const farm = (irLot?.field?.cells ?? []).flatMap(([x, z, y0, y1]) => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i, z]));
    out.lot = { box: irLot?.box, front: irLot?.front, floorY: irLot?.floorY, field: irLot?.field && { crops: irLot.field.crops, frame: irLot.field.frame, cells: farm.length } };
    check(farm.length === 49 && json(irLot.field.crops) === json(['minecraft:wheat', 'minecraft:carrots']) && farm.every((c) => c[1] === irLot.floorY), `the revision IR (read once the realise accepted it)'s lot fc_farm carries its field: ${farm.length} farmland cells at its floor ${irLot?.floorY} (front ${irLot?.front}), crops ${json(irLot?.field?.crops)}`);
    if (farm.length !== 49) throw new Error(`fc_farm has no field in the revision IR (${farm.length} cells): the rest of the step needs it`);
    for (let i = 0; i < 90; i++) {
      const rs = await G.rsState(ctx, region);
      const sv = await rvState(region);
      if ((rs.targets ?? []).some((x) => !t0.has(x.id)) || sv.revisions?.find((x) => x.rid === rid)?.state !== 'ACCEPTED') break;
      await L.sleep(2000);
    }
    const fg = await G.feed({ L }, region, { fraction: 1, until: (st, rs) => st.view.state === 'PLACED' && rs.build?.done, timeoutMs: 1_800_000, every: 2500 });
    const done = await rvWait(region, rid, 1_800_000);
    const ps1 = await pile();
    const consumed = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    out.consumed = consumed;
    check(String(done.r?.state) === 'PLACED' && fg.last.rs.build?.done, `the growth built from the stockpile: revision ${rid} ${done.r?.state}; consumed ${json(consumed)} (${fg.waves} waves)`);
    const sv = await rvState(region);
    const site = (sv.sites ?? sv.revisions?.find((x) => x.rid === rid)?.sites ?? []).find?.((s) => String(s.id ?? s).includes('fc_farm'));
    out.site = site ?? null;
    let F = await fieldNow(BOX, farm);
    check(F.length === 49 && F.every((q) => q.soil === 'minecraft:farmland' && idOf(q.crop) === 'minecraft:wheat'), `the field stands: ${F.filter((q) => q.soil === 'minecraft:farmland').length} farmland, ${F.filter((q) => idOf(q.crop) === 'minecraft:wheat').length} wheat`);
    const rep0 = await land(region);
    const row0 = lotRow(rep0, 'fc_farm');
    out.land0 = { lot: row0, parts: partsKey(rep0) };
    check(row0 && row0.changed === 0 && row0.playerPlaced === 0 && row0.standing === 1, `land check, built: fc_farm changed ${row0?.changed}, playerPlaced ${row0?.playerPlaced}, standing ${row0?.standing}`, row0);

    // grown by random ticks to several ages (our crops: no PT record), then frozen again
    await cmd('/gamerule randomTickSpeed 400');
    for (let i = 0; i < 60; i++) {
      await L.sleep(2000);
      F = await fieldNow(BOX, farm);
      if (F.filter((q) => ageOf(q.crop) === 7).length >= 46) break;
    }
    await cmd('/gamerule randomTickSpeed 0');
    F = await fieldNow(BOX, farm);
    const ages1 = F.map((q) => ageOf(q.crop));
    out.agesGrown = ages1;
    const rep1 = await land(region);
    const row1 = lotRow(rep1, 'fc_farm');
    check(ages1.filter((a) => a === 7).length >= 46 && row1.changed === 0 && row1.playerPlaced === 0 && row1.standing === 1 && partsKey(rep1) === out.land0.parts,
      `our crops grown (ages ${json(Object.entries(ages1.reduce((m, a) => ({ ...m, [a]: (m[a] ?? 0) + 1 }), {})))}): fc_farm unchanged (changed ${row1.changed}, playerPlaced ${row1.playerPlaced}, standing ${row1.standing}); the parts as built`);

    // the player works the field: 44 harvested (5 of ours stand), 30 replanted with wheat, 10 with carrots, 15 bone-mealed, 3 left as air,
    // one harvested cell given a cobblestone (a player block that is no crop)
    const P = 'FCFarmer';
    const ours = farm.slice(0, 5), harvested = farm.slice(5);
    const wheatAt = harvested.slice(0, 30), carrotAt = harvested.slice(30, 40), airAt = harvested.slice(40, 43), cobbleAt = harvested[43];
    const br = await call('dev.pt.breaks', { at: harvested.map(up), placer: P }, 600_000);
    await cmd('/kill @e[type=item]'); // the harvest is the player's (picked up)
    F = await fieldNow(BOX, farm);
    const rep2 = await land(region);
    const row2 = lotRow(rep2, 'fc_farm');
    check(br.broken === 44 && F.filter((q) => q.crop === 'minecraft:air').length === 44 && row2.changed === 0 && row2.playerPlaced === 0 && row2.standing === 1,
      `44 crops harvested by the player (destroyBlock: ${br.broken}): air over our farmland reads unchanged (changed ${row2.changed}, playerPlaced ${row2.playerPlaced}, standing ${row2.standing})`);
    const use = (item, cells) => call('dev.pt.uses', { ops: cells.map((c) => ({ item, at: up(c), on: c, face: 'up', placer: P })) }, 600_000);
    const u1 = await use(SEEDS, wheatAt), u2 = await use(CARROT, carrotAt);
    const u3 = await use('minecraft:bone_meal', wheatAt.slice(0, 10).concat(carrotAt.slice(0, 5)));
    const u4 = await use(COBBLE, [cobbleAt]);
    await cmd('/kill @e[type=item]');
    const tracked = [...(u1.results ?? []), ...(u2.results ?? []), ...(u4.results ?? [])].filter((x) => x.tracked).length;
    F = await fieldNow(BOX, farm);
    const kinds = (cells) => cells.map((c) => idOf(stateAt(new Map(F.map((q) => [k(up(q.c)), q.crop])), up(c))));
    const ages2 = wheatAt.concat(carrotAt).map((c) => ageOf(F.find((q) => k(q.c) === k(c)).crop));
    out.worked = { tracked, ages: ages2, cobble: F.find((q) => k(q.c) === k(cobbleAt)) };
    check(tracked === 41 && kinds(wheatAt).every((s) => s === 'minecraft:wheat') && kinds(carrotAt).every((s) => s === 'minecraft:carrots') && new Set(ages2).size >= 3 && kinds([cobbleAt])[0] === COBBLE,
      `replanted through useItemOn: 30 wheat, 10 carrots, the cobblestone: ${tracked} of 41 tracked (PT records); bone meal gives ${new Set(ages2).size} ages (${json([...new Set(ages2)].sort())})`, (u1.results ?? []).slice(0, 2));
    const builds = await call('dev.pt.builds', { box: [CLAIM[0], gy - 4, CLAIM[1], CLAIM[2], gy + 8, CLAIM[3]], drain: true }, 120_000).catch((e) => ({ error: String(e) }));
    out.builds = builds.builds ?? builds;
    const rep3 = await land(region);
    const row3 = lotRow(rep3, 'fc_farm');
    // the standing score: matching / total over the template's non-air cells (98 field cells, 3 path cells): the cobblestone's crop cell is
    // the only one that does not match (its farmland, dirt under the block now, reads as farmland)
    out.land3 = { lot: row3, parts: partsKey(rep3) };
    check(row3.changed === 0 && row3.playerPlaced === 1 && row3.standing > 0.98 && row3.standing < 1 && partsKey(rep3) === out.land0.parts,
      `land check, the field worked: crops of any age, ours and the player's, and air read unchanged; only the cobblestone is the player's (changed ${row3.changed}, playerPlaced ${row3.playerPlaced}, standing ${row3.standing}); the town's and the growth's parts as built`);

    // a restart mid-cycle: the records, the field and the report hold
    await L.leaveWorld();
    await L.openWorld(SW);
    await L.tp(CX + 80, 80, CZ + 56);
    await cmd('/gamerule randomTickSpeed 0');
    const F2 = await fieldNow(BOX, farm);
    const rep4 = await land(region);
    const row4 = lotRow(rep4, 'fc_farm');
    const pt = await call('dev.pt.at', { at: up(wheatAt[0]) }, 30_000);
    check(json(F2) === json(F) && json(row4) === json(row3) && pt.tracked === true, `after a restart: the field the same (${F2.length} cells), the land check the same (${json(row4)}), a replanted crop still the player's (${json(pt).slice(0, 120)})`);

    // undoRevision: not blocked; cargo once at the site, construction credited for our 5 standing crops
    const lb = irLot.box;
    const mid = [Math.floor((lb.minX + lb.maxX) / 2), lb.minY + 2, Math.floor((lb.minZ + lb.maxZ) / 2)];
    await L.tp(CLAIM[0] + 2, gy + 2, CLAIM[1] + 2); // out of the growth's boxes (a removal refuses a player in or next to them)
    await L.sleep(2000);
    const site0 = await pile();
    await cmd('/kill @e[type=item]');
    const u = await call('dev.rv.undo', { region, toPosition: (await rvState(region)).position - 1 }, 4 * 3_600_000);
    out.undo = u;
    check(u.removed === true && !(u.blockers ?? []).length, `undoRevision of the growth: removed ${u.removed}, blockers ${json(u.blockers ?? [])}${u.refused ? ` (${u.refused})` : ''}`);
    // the cargo drops above the lot's box and falls: watched from 10 cells away (no pickup), its chunks loaded
    await L.tp(mid[0] + 10, irLot.floorY + 2, mid[2]);
    await L.sleep(6000);
    const near = await call('dev.items.near', { pos: mid, radius: 24 }, 60_000);
    const dropped = near.items ?? {};
    const site1 = await pile();
    const credited = G.minus(site1.ledger?.returned ?? {}, site0.ledger?.returned ?? {});
    const stock = G.minus(site1.stock ?? {}, site0.stock ?? {});
    out.after = { dropped, credited, stock, refund: u.refund };
    const want = { [SEEDS]: 30, [CARROT]: 10, [COBBLE]: 1 };
    check(G.same(dropped, want), `the cargo at the site: each planting item once (30 wheat seeds, 10 carrots) and the player's cobblestone, nothing else: ${json(dropped)}`, { want, near });
    check((credited[SEEDS] ?? 0) === 5 && !credited[CARROT] && !credited[COBBLE], `construction credited to the stockpile: wheat seeds ${credited[SEEDS] ?? 0} (our 5 standing crops; never the player's replants), carrots ${credited[CARROT] ?? 0}`, credited);
    // items in = items out over the cycle (the seeds): consumed by the build = credited back for our standing crops + our 44 harvested by the
    // player (vanilla's drops, the player's); the player's own 30 seeds and 10 carrots in = the cargo out
    check((consumed[SEEDS] ?? 0) === 49 && (credited[SEEDS] ?? 0) + 44 === consumed[SEEDS] && dropped[SEEDS] === 30 && dropped[CARROT] === 10,
      `items in = items out: 49 wheat seeds consumed = ${credited[SEEDS] ?? 0} credited + 44 harvested by the player; the player's 30 seeds and 10 carrots planted = ${dropped[SEEDS] ?? 0} and ${dropped[CARROT] ?? 0} given back`);
    const F3 = await fieldNow(BOX, farm);
    check(F3.every((q) => !['minecraft:wheat', 'minecraft:carrots', COBBLE].includes(idOf(q.crop)) && q.soil !== 'minecraft:farmland'), `the field went with the lot: no crop, cobblestone or farmland left on its cells (${json([...new Set(F3.map((q) => `${q.soil}/${idOf(q.crop)}`))])})`);
    // a restart after the undo gives nothing again
    await L.leaveWorld();
    await L.openWorld(SW);
    await L.tp(mid[0] + 10, irLot.floorY + 2, mid[2]);
    await L.sleep(5000);
    const near2 = await call('dev.items.near', { pos: mid, radius: 24 }, 60_000);
    const site2 = await pile();
    check(G.same(near2.items ?? {}, dropped) && json(site2.ledger) === json(site1.ledger) && json(site2.stock) === json(site1.stock), `after a restart: nothing given twice (the items at the site ${json(near2.items ?? {})}; the stockpile's ledger and stock unchanged)`);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
