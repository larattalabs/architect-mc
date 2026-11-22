// Slice T4R-M gate (docs/CONTRACT.md "Slice T4R-M as built"; the final check of eca131b6's P1-3): a group removal never goes past a held
// cargo step. Registered into tools/gate6dgr.mjs (GR's survival town helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs t4rmcargo  (t4rm-cargo)  one survival flat_village town (its ground and street stages approved and fed until a
//     region target has a built cell), then:
//     T4RM-cargo  a player's chest in a built region-target cell holding a named sword (data cargo: owed whole by removal.cargo) and 5
//                 feathers (plain cargo: credited into the stock). The region removed with every removal.cargo barrier after its first
//                 refused (dev.txn.failBarrier {kind: removal.cargo, skip: 1}): its prepare barrier passes, its effects barrier refuses, the
//                 cargo txn answers held(decided) with its hold on the chest. While it is held the removal must not go on: the chest stands,
//                 no chest item drops, the region's undo is not planned. Once the barriers work again the removal finishes: exactly one
//                 chest (standing, dropped or in the stock), the sword owed once, the feathers credited once. eca131b6 went on past the held
//                 answer: dropPlayerBlocks dropped the chest's item although its replacement was refused, and the undo kept the chest: two.
//
// Evidence: <out>/t4rmcargo.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
export async function registerT4RM(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const txn = async () => call('dev.txn.state', {}, 30_000).catch(() => ({ openCount: -1, open: [] }));
  const owedSwords = async () => ((await call('dev.stockpile.owed', {}, 30_000).catch(() => null))?.owed ?? [])
    .filter((e) => e.reason === 'cargo' || /^cargo:/.test(e.key ?? '')).filter((e) => (e.items?.['minecraft:diamond_sword'] ?? 0) > 0);

  steps.t4rmcargo = async () => {
    await ensure();
    spendZero();
    const out = {};
    await G.survivalBase(ctx);
    const W = { name: 'G6B T4RM Cargo' };
    await L.fresh(W.name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await cmd('/op @a').catch(() => null);
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 2 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    W.region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' }, autoApprove: false });
    W.group = (await call('dev.region.state', { region: W.region }, 60_000)).view?.groupId;
    for (const stage of ['ground', 'street']) await cmd(`/apitest sapprove ${W.group} ${stage}`);
    // fed until a region target has a built cell (a cell of the plan's own block, not a cut)
    let cell = null;
    for (let i = 0; i < 180 && !cell; i++) {
      const ps = await G.pileState(ctx);
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
      if (Object.keys(need).length && i % 10 === 0) await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000).catch(() => null);
      const rc = await call('dev.rs.cells', { region: W.region }, 120_000).catch(() => ({}));
      for (const t of rc.targets ?? []) { for (const c of t.cells ?? []) if ((c[3] & 2) && !(c[3] & 4) && !(c[3] & 1)) { cell = c; break; } if (cell) break; }
      if (!cell) await L.sleep(2000);
    }
    check(!!cell, `T4RM-cargo: a built cell of a region target (${json(cell)})`);
    if (!cell) return out;
    const tag = 'T4RM-cargo';
    const at = cell.slice(0, 3);
    // the town's feed paused (no item moves but the removal's), the player's chest set in the target cell
    for (const t of Object.keys((await pile()).targets ?? {})) await call('dev.stockpile.pause', { owner: G.OWNER, site: t, paused: true }, 60_000).catch(() => null);
    await cmd(`/setblock ${at.join(' ')} minecraft:chest`);
    await cmd(`/item replace block ${at.join(' ')} container.0 with minecraft:diamond_sword[custom_name="Tizona"]`);
    await cmd(`/item replace block ${at.join(' ')} container.1 with minecraft:feather 5`);
    await cmd('/kill @e[type=item]');
    await cmd('/save-all flush');
    await L.settle(2000);
    const near = async () => (await call('dev.items.near', { pos: at, radius: 48 }, 60_000).catch(() => ({}))).items ?? {};
    const chestAt = async () => /chest/.test(json((await call('dev.box.hash', { min: at, max: at, cells: true }, 60_000).catch(() => ({}))).cells ?? []));
    // (slice T4R-D, re-pointed) a foreign (non-PT) block in the settlement's target is owed to its owner id (player_blocks), never dropped
    const owedChests = async () => ((await call('dev.stockpile.owed', { recipient: G.OWNER }, 30_000).catch(() => ({}))).owed ?? []).filter((e) => e.reason === 'player_blocks')
      .reduce((n, e) => n + (e.items?.['minecraft:chest'] ?? 0), 0);
    const chests = async () => ((await chestAt()) ? 1 : 0) + ((await near())['minecraft:chest'] ?? 0) + ((await pile()).stock?.['minecraft:chest'] ?? 0) + (await owedChests());
    const feathers0 = (await pile()).stock?.['minecraft:feather'] ?? 0;
    const c0 = await chests();
    check(c0 === 1 && (await owedSwords()).length === 0, `${tag}: one chest at ${at} (sword and 5 feathers in it), nothing owed (${c0})`);
    await call('dev.txn.failBarrier', { kind: 'removal.cargo', skip: 1, n: 1_000_000 }, 10_000);
    const rr = call('dev.region.remove', { region: W.region, requester: G.OWNER }, 1_200_000).catch((e) => ({ error: String(e) }));
    let held = null;
    for (let i = 0; i < 90 && !held; i++) {
      await L.sleep(1000);
      held = ((await txn()).open ?? []).find((x) => x.kind === 'removal.cargo' && x.held) ?? null;
    }
    check(!!held, `${tag}: the cargo txn answers held(decided), its effects barrier refused (${json(held)})`);
    await L.sleep(15_000);
    const mid = { chestStands: await chestAt(), near: await near(), cargo: held, region: (await call('dev.region.state', { region: W.region }, 60_000).catch(() => null))?.view?.state ?? null };
    log(`  ROW ${tag}: while the cargo is held: ${json(mid)}`);
    check(mid.chestStands && (mid.near['minecraft:chest'] ?? 0) === 0, `${tag}: while the cargo is held the removal does not go on: the chest stands, no chest item dropped (${json(mid.near)})`, mid);
    await call('dev.txn.failBarrier', { n: 0 }, 10_000);
    let v = null;
    for (let i = 0; i < 600; i++) {
      await L.sleep(2000);
      v = (await call('dev.region.state', { region: W.region }, 60_000).catch(() => null))?.view;
      if ((!v || v.state === 'REMOVED' || v.state === 'ACTIVE' && v.removalStop) && (await txn()).openCount === 0) break;
    }
    const res = await Promise.race([rr, L.sleep(5000).then(() => 'pending')]);
    const after = { chests: await chests(), swords: await owedSwords(), feathers: ((await pile()).stock?.['minecraft:feather'] ?? 0) - feathers0, near: await near(), region: v?.state ?? 'gone', res };
    log(`  ROW ${tag}: after: ${json(after).slice(0, 600)}`);
    check(!v || v.state === 'REMOVED', `${tag}: the region removed (${v?.state ?? 'gone'}: ${v?.removalStopReason ?? ''})`, after);
    check(after.chests === 1, `${tag}: exactly one chest (standing, dropped, in the stock or owed): ${after.chests}`, after);
    // T4RD-settlement-nonpt (Steward P2-5): the settlement's non-PT block is owed to the owner id as player_blocks, not dropped, not credited
    const oc = await owedChests();
    check(oc === 1 && (after.near['minecraft:chest'] ?? 0) === 0 && !((await pile()).stock?.['minecraft:chest']), `T4RD-settlement-nonpt: the foreign chest owed to ${G.OWNER} (player_blocks ${oc}), not dropped, not credited`, after);
    check(after.swords.length === 1 && (after.swords[0].items?.['minecraft:diamond_sword'] ?? 0) === 1, `${tag}: the named sword owed once (${json(after.swords.map((e) => e.key))})`, after);
    check(after.feathers === 5 && (after.near['minecraft:feather'] ?? 0) === 0, `${tag}: the 5 feathers credited once, none dropped (stock +${after.feathers})`, after);
    out[tag] = { cell, mid, after };
    return out;
  };
}
