// Slice RL gate (docs/CONTRACT.md "Slice RL, reconcile at load"): after a halt with nothing saved and no undo, the blocks standing in the
// saved world and the items in the saved ledger never both exist (no dupe), and the builder never charges a cell the saved ledger already
// paid (no double charge). Registered into tools/gate6dgr.mjs (GR's survival town and feed helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs rlcrash   (rl-crash)   four survival towns (a flat_village region of a hall and a cottage; stages approved by
//                                                  hand: ground, street and lots now, props only after the restart, so no target joins
//                                                  the feed between a case's save and its halt). Each: fed until the lot site builds, the
//                                                  lot paused, items delivered, PS's periodic save held off (the crash window: it saves a changed
//                                                  ledger with the world every 10 s), the ledger saved (/save-all flush, as an autosave) with
//                                                  the lot's items in the saved stock, the lot resumed (it builds after the save), then:
//                                                  RL1  half delivered: the lot starves; 12 s for the chunks' eager saves; a halt
//                                                  RL2  all delivered: the lot built (BUILT recorded); 12 s; a halt
//                                                  RL3  all delivered: the lot built; a halt straight after an autosave's chunk save
//                                                       without flush (the ledger on disk, the chunks maybe not)
//                                                  RL4  half delivered before the save, the rest after it: the lot built; 12 s; a halt
//                                                       (the saved stock is short: the lot owes and builds again)
//                                                  each: no ledger save between the case's save and the halt; the saved ledger read off
//                                                  the disk; after the restart the reconcile found the lot's unpaid cells (RL1, RL2, RL4)
//                                                  and no cell stands unpaid; a second halt at once and load change nothing
//                                                  (idempotent); then fed until built: the paid cells standing equal the targets' paid
//                                                  records item for item (no dupe, no double charge), and what the targets took from the
//                                                  stock since the save equals what their records gained
//
// Evidence: artifacts/gate6d-gr/rlcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerRL(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  // (BC-c) RL's crash cases realise under a maxBill (the put-down quote): the reconcile runs inside the running cap
  const caps = (await import('./gatebcc.mjs')).bccCaps({ call, check, json, G, owner: G.OWNER, log });
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const audit = async () => call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
  const savedNow = async () => call('dev.stockpile.saved', { owner: G.OWNER }, 60_000);
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pos = (m) => Object.fromEntries(Object.entries(m ?? {}).filter(([, v]) => v > 0));
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  /** Every target's paid record, summed per item. */
  const paidSum = (l) => Object.values(l?.paid ?? {}).reduce((a, m) => G.plus(a, m), {});
  function stockOf(l) {
    const o = {};
    for (const k of new Set([...Object.keys(l?.delivered ?? {}), ...Object.keys(l?.returned ?? {})])) {
      const s = (l.delivered?.[k] ?? 0) + (l.returned?.[k] ?? 0) - (l.consumed?.[k] ?? 0) - (l.withdrawn?.[k] ?? 0) - (l.dropped?.[k] ?? 0);
      if (s) o[k] = s;
    }
    return o;
  }

  async function world(name, { joinSave = false, cap = false } = {}) {
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `${name}: a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    // no auto approval: ground, street and lots approved now, props only after the restart (no target joins the feed, so nothing saves,
    // between the case's save and its halt)
    const ro = { load: 'bounded:512', lots: { cottage_1: 'rs_hut' }, autoApprove: false };
    const region = cap ? await caps.realise(L, p0.planId, ro) : await L.realise(p0.planId, ro);
    const group = (await call('dev.region.state', { region }, 60_000)).view?.groupId;
    // (RL, joinSave) PS's periodic save off before any target joins: every ledger save until the case's own is RL's save when a target
    // joins the feed (production keeps it; the switch turns both off only from the case's save on)
    let js0 = null;
    if (joinSave) {
      const ps = await call('dev.stockpile.ps', { noPeriodic: true, joinSave: true, resetPeriodic: true }, 30_000);
      check(ps.noPeriodic === true && ps.joinSave === true, `${name}: the periodic save off, the save on join on (${json(ps)})`);
      js0 = await savedNow();
    }
    for (const stage of ['ground', 'street', 'lots']) await cmd(`/apitest sapprove ${group} ${stage}`);
    // the targets joined the feed: what they need is outstanding
    let ps;
    for (let i = 0; i < 60; i++) {
      ps = await G.pileState(ctx);
      if (sum(ps.outstanding) > 0) break;
      await L.sleep(1000);
    }
    check(sum(ps?.outstanding) > 0, `${name}: the town realised in survival; its targets need ${sum(ps?.outstanding)} units`);
    return { gy, BOX: BOXOF(CLAIM, gy), dir: path.join(L.SAVES, name), name, region, group, js0, cap };
  }

  /**
   * (RL, joinSave) The save when a target joins the feed, shown on the disk: with the periodic save off since before the approvals, the
   * file holds the joined lot's book of cells and the paid records of the targets fed before it joined; then the switch is put back on.
   */
  async function joinSaved(tag, W, lot) {
    const s = await savedNow();
    const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
    const books = Object.keys(Ld?.cells ?? {});
    const paid = Object.entries(Ld?.paid ?? {}).filter(([, m]) => sum(m) > 0).map(([k]) => k);
    check(s.periodicSaves === 0 && s.saves > W.js0.saves && books.some((k) => k.startsWith(`site:${lot}@`)) && paid.length > 0,
      `${tag}: the save on join wrote the ledger with the periodic save off (saves #${W.js0.saves} -> #${s.saves}, periodic ${s.periodicSaves}): the joined lot's book (${books.filter((k) => k.startsWith(`site:${lot}@`)).join(',') || 'none'}; ${books.length} books) and ${paid.length} paid records on the disk (${json(paid).slice(0, 200)})`,
      { saves0: W.js0.saves, saves: s.saves, books, paid });
    await call('dev.stockpile.ps', { noPeriodic: false }, 30_000);
  }

  /** Delivers `fraction` of what the targets still lack, in one insert. */
  async function deliver(fraction, skip = null) {
    const ps = await G.pileState(ctx);
    const need = {};
    let want = ps.outstanding ?? {};
    if (skip) {
      // only what the targets other than those `skip` matches lack (a lot that joins meanwhile gets none of it first)
      want = {};
      for (const [k, x] of Object.entries((await pile()).targets ?? {})) if (!skip(k, x)) want = G.plus(want, x.outstanding ?? {});
    }
    for (const [it, n] of Object.entries(want)) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = fraction >= 1 ? lack : Math.max(1, Math.floor(lack * fraction));
    }
    const acc = (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    return { need, acc };
  }

  /** Waits until the ledger's consumption stops moving for `quietMs` (the builder starved or done). */
  async function quiet(quietMs = 4000, timeoutMs = 600_000) {
    const end = Date.now() + timeoutMs;
    let last = null, since = Date.now();
    for (; Date.now() < end;) {
      const c = json((await pile()).ledger?.consumed ?? {});
      if (c !== last) { last = c; since = Date.now(); } else if (Date.now() - since >= quietMs) return true;
      await L.sleep(1000);
    }
    return false;
  }

  /** The conservation numbers of one audit against a ledger: standing paid cells vs the records. */
  function balance(a) {
    const l = a.ledger ?? {};
    const standing = G.plus(a.paidStanding ?? {}, {});
    for (const k of ['fluidStanding', 'mechStanding']) for (const [it, n] of Object.entries(a[k] ?? {})) standing[it] = (standing[it] ?? 0) - n;
    const paid = paidSum(l);
    const d = G.minus(standing, paid);
    return { standing: sum(standing), paid: sum(paid), dupe: pos(d), double: pos(G.minus(paid, standing)), dupeUnits: sum(pos(d)), doubleUnits: sum(pos(G.minus(paid, standing))), stock: a.stock ?? {} };
  }

  async function restart(W) {
    await L.openWorld(W.name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(4000);
  }

  async function halt(tag, mode = 'now') {
    await call('dev.stockpile.halt', { mode }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, `${tag}: dev.stockpile.halt (${mode}) halted the server`);
    return down;
  }

  /** After the restart: the first audit (the reconcile's result), the build finished, the final audit, and a second restart. */
  async function after(tag, W, c, { lot }) {
    const a1 = await audit();
    if (W.cap) c.caps = await caps.afterRestart(tag); // (BC-c) no overshoot; the cap's total = the charges
    const b1 = balance(a1);
    log(`  ${tag}: after the restart (unclean ${a1.uncleanStart}): standing ${b1.standing}, paid records ${b1.paid}; standing unpaid ${json(b1.dupe)}; paid not standing ${json(b1.double)}; stock ${sum(b1.stock)}; reconciled ${json(a1.reconciled ?? null)}`);
    check(a1.uncleanStart === true && b1.dupeUnits === 0, `${tag}: after the unclean restart no cell stands unpaid (standing ${b1.standing}, paid ${b1.paid}; dupe ${b1.dupeUnits}: ${json(b1.dupe)})`, b1);
    // idempotent: halted again at once (nothing saved after the reconcile's own save): the second reconcile charges and gives back nothing
    if (!(await halt(`${tag} (second)`))) return { a1, b1 };
    await restart(W);
    const a1b = await audit();
    const r1 = a1.reconciled?.[lot] ?? {}, r2 = a1b.reconciled?.[lot] ?? {};
    check(G.same(a1b.ledger?.consumed, a1.ledger?.consumed) && G.same(a1b.stock, a1.stock) && sum(r2.charged) === 0 && sum(r2.creditedBack) === 0
      && (r2.owedCells ?? 0) === (r1.owedCells ?? 0), `${tag}: a second unclean load changes nothing (consumed ${sum(a1b.ledger?.consumed)} = ${sum(a1.ledger?.consumed)}, stock ${sum(a1b.stock)} = ${sum(a1.stock)}; charged ${sum(r2.charged)}, given back ${sum(r2.creditedBack)}, still owed ${r2.owedCells ?? 0} = ${r1.owedCells ?? 0})`, { r1, r2 });
    await cmd(`/apitest sapprove ${W.group} props`);
    const f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built after the restart (${f.waves} waves): ${f.last.st.view.state}`);
    await quiet();
    const a2 = await audit();
    const b2 = balance(a2);
    // net: what the targets took from the stock since the baseline (consumed, less what the reconcile gave back for lost cells)
    const consumed = G.minus(G.minus(a2.ledger?.consumed, c.b0.ledger.consumed), G.minus(a2.ledger?.returned, c.b0.ledger.returned));
    const gained = G.minus(paidSum(a2.ledger), paidSum(c.b0.ledger));
    log(`  ${tag}: built: standing ${b2.standing}, paid records ${b2.paid}; standing unpaid ${json(b2.dupe)}; paid not standing ${json(b2.double)}; taken since the baseline ${sum(consumed)}, records gained ${sum(gained)}`);
    check(b2.dupeUnits === 0 && b2.doubleUnits === 0 && a2.identity !== false, `${tag}: built after the restart, the paid cells standing equal the targets' paid records item for item (standing ${b2.standing}, paid ${b2.paid}; dupe ${b2.dupeUnits}: ${json(b2.dupe)}; double charge ${b2.doubleUnits}: ${json(b2.double)}; identity ${a2.identity})`, { b1, b2 });
    check(G.same(consumed, gained), `${tag}: what the targets took from the stock since the baseline (${sum(consumed)}: consumed less given back) is what their records gained (${sum(gained)}), item for item`, { consumed, gained });
    return { a1, b1, r2, b2, consumed, gained, waves: f.waves, caps: c.caps ?? null };
  }

  /** Fed (all it lacks, in waves) until the region's lot site builds; then it is paused and the rest settles. Returns its id. */
  async function lotPaused(tag) {
    let id = null;
    const isLot = (k, x) => /^s\d+$/.test(k) && (x.queued ?? 0) >= 50;
    for (let i = 0; i < 120 && !id; i++) {
      const ps = await pile();
      id = Object.entries(ps.targets ?? {}).find(([k, x]) => isLot(k, x) && (x.built ?? 0) < x.queued)?.[0] ?? null;
      if (!id) { await deliver(1, isLot); await L.sleep(2500); }
    }
    check(!!id, `${tag}: the region's lot site joined the feed (${id})`);
    if (!id) return null;
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${id} paused: ${json(pr.refused ?? 'paused')}`);
    await quiet();
    return id;
  }

  /**
   * (J1) On RL5's built town, before its removal: F10 for roads (a player mines one of a road's paid cells and places the same block back:
   * a PT record) and JR-b's residual case (a player replaces rs_hut's copper block with exposed copper, a CU equivalent with a PT record). Then the
   * region removed: the road cell's block drops at the cell as the player's and is not refunded; the exposed copper stays (the undo's holdsOurs),
   * neither dropped nor refunded; the refund is the paid records less those two cells' cost.
   */
  async function playerCells(tag, W, lot) {
    const out = {};
    await cmd('/item replace entity @s weapon.mainhand with minecraft:diamond_pickaxe');
    const rs = await call('dev.rs.cells', { region: W.region }, 300_000);
    const road = (rs.targets ?? []).find((t) => /^[cr]\d/.test(t.target) && (t.cells ?? []).some((c) => (c[3] & 2) && !(c[3] & 1) && !(c[3] & 4)));
    const rcell = road?.cells.find((c) => (c[3] & 2) && !(c[3] & 1) && !(c[3] & 4))?.slice(0, 3);
    // paused, so neither builder puts its cell back before the player does
    for (const id of [road?.target, lot].filter(Boolean)) await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000).catch(() => null);
    const mineAndPlace = async (at, item, id) => {
      // the player's break of a build's block is guarded (not the owner): the cell is cleared by command (no record, no drop), as a mined one
      const pre = (await call('dev.items.near', { pos: at, radius: 2 }, 10_000)).items ?? {};
      await cmd(`/setblock ${at[0]} ${at[1]} ${at[2]} minecraft:air`);
      await L.sleep(500);
      // what the clearing knocked off its neighbours (rs_hut's wall torch hangs on the copper block): no longer standing, so never refunded
      const popped = pos(G.minus((await call('dev.items.near', { pos: at, radius: 2 }, 10_000)).items ?? {}, pre));
      const m = { mined: (await call('dev.pt.at', { at }, 10_000)).state === 'minecraft:air', popped };
      const u = (await call('dev.pt.uses', { ops: [{ item: item ?? id, at, on: [at[0], at[1] - 1, at[2]], face: 'up', placer: 'J1Placer' }] }, 30_000)).results?.[0];
      return { at, was: id, mined: m.mined, popped: m.popped, placed: u };
    };
    const rid = rcell ? (await call('dev.pt.at', { at: rcell }, 10_000)).state : null; // the road block standing there
    if (rcell) out.road = { target: road.target, ...(await mineAndPlace(rcell, rid, rid)) };
    check(!!out.road?.placed?.tracked && out.road.placed.state === out.road.was, `${tag} F10 roads: a player mined ${road?.target ?? 'no road'}'s paid cell ${json(rcell)} (${out.road?.was}) and placed the same block back (PT record ${out.road?.placed?.tracked})`, out.road);
    // JR-b's residual: rs_hut's one copper block, mined and replaced by the player with another stage (a CU equivalent of the target)
    const cells = await call('dev.site.cells', { site: lot }, 30_000);
    const cu = Object.entries(cells).find(([, b]) => b === 'minecraft:copper_block')?.[0]?.split(',').map(Number);
    if (cu) out.cu = await mineAndPlace(cu, 'minecraft:exposed_copper', 'minecraft:copper_block');
    check(!!out.cu?.placed?.tracked && out.cu.placed.state === 'minecraft:exposed_copper', `${tag} JR-b residual: a player replaced ${lot}'s copper block ${json(cu)} with exposed copper (a CU equivalent; PT record ${out.cu?.placed?.tracked})`, out.cu);
    await cmd('/kill @e[type=minecraft:item]'); // a dropped stack in a lot stops its removal (a blocker)
    const before = await audit();
    const paid = paidSum(before.ledger);
    const back0 = G.plus(before.stock ?? {}, before.ledger?.refundOverflow ?? {});
    const rm = await call('dev.region.remove', { region: W.region, requester: G.OWNER }, 3_600_000).catch((e) => ({ refused: String(e?.message ?? e) }));
    let st;
    for (let i = 0; i < 900; i++) {
      st = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
      if (!st?.view?.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state)) break;
      if (i >= 15 && st.view.state === 'PLACED') break; // the removal stopped before writing anything (a blocker): it stays PLACED
      await L.sleep(2000);
    }
    out.removeCall = rm;
    await L.settle(3000);
    const after = await audit();
    const refund = G.minus(G.plus(after.stock ?? {}, after.ledger?.refundOverflow ?? {}), back0);
    const want = { ...paid };
    if (out.road?.was) want[out.road.was] = (want[out.road.was] ?? 0) - 1;
    if (out.cu?.was) want[out.cu.was] = (want[out.cu.was] ?? 0) - 1;
    for (const c of [out.road, out.cu]) for (const [k, v] of Object.entries(c?.popped ?? {})) want[k] = (want[k] ?? 0) - v; // the harness's side effect
    const near = out.road ? await call('dev.items.near', { pos: out.road.at, radius: 1.5 }, 10_000) : {};
    const cuNow = out.cu ? await call('dev.site.mine', { pos: out.cu.at, pickup: false }, 30_000).catch(() => null) : null; // read by mining it (after the removal)
    out.removed = { state: st?.view?.state ?? 'gone', paid: sum(paid), refund: sum(pos(refund)), want: sum(pos(want)), diff: G.minus(refund, pos(want)), roadDrops: near.items ?? {}, cuAfter: cuNow?.was ?? null };
    log(`  ${tag}: removed ${out.removed.state}; refund ${sum(pos(refund))} vs paid ${sum(paid)} less the two player cells ${sum(pos(want))}; diff ${json(out.removed.diff)}; at the road cell ${json(near.items)}; the tilled cell ${out.removed.cuAfter}`);
    check(!st?.view?.state || st.view.state === 'REMOVED', `${tag}: the town removed: ${out.removed.state}`);
    // (slice T4R-D, re-pointed) the player's block is theirs, owed (player_blocks) by the road's extraction attempt, never dropped
    const pOwed = ((await call('dev.stockpile.owed', {}, 30_000).catch(() => ({}))).owed ?? []).filter((e) => e.reason === 'player_blocks')
      .reduce((n, e) => n + (e.items?.[out.road?.was] ?? 0), 0);
    check(!out.road?.was || pOwed >= 1 && !(near.items?.[out.road.was]), `${tag} F10 roads: the player's block owed to them (player_blocks ${pOwed}), not dropped at the road cell (${json(near.items)})`, out.removed);
    const cuNear = out.cu ? (await call('dev.items.near', { pos: out.cu.at, radius: 2 }, 10_000)).items ?? {} : {};
    out.removed.cuDrops = cuNear;
    // JR-b's fix is the dupe: a CU equivalent with a record is NONE (neither a PLAYER_DROP of it nor a refund of the copper it stands for).
    // Recorded, not judged: what the undo does with the block (JR-b's as-built says it stays; J1 measured it here)
    check(!out.cu || (!(cuNear['minecraft:exposed_copper'] > 0) && !(cuNear['minecraft:copper_block'] > 0)), `${tag} JR-b residual: the player's exposed copper neither dropped nor refunded at the removal (drops near it ${json(cuNear)}; the cell after it: ${out.removed.cuAfter}, recorded)`, out.removed);
    check(G.same(pos(refund), pos(want)), `${tag}: the removal refunded the paid records less the two player cells, item for item (${sum(pos(refund))} = ${sum(pos(want))}; before J1 the road cell came out of the road's record)`, out.removed);
    return out;
  }

  /**
   * One case: the lot paused, `fraction` of what the targets lack delivered, the ledger saved at once (/save-all flush, as an autosave:
   * the lot's items are in the saved stock, not consumed), the lot resumed, it builds after the save until built or starved, 12 s for the
   * chunks' eager saves, then the halt (`mode`); the saved ledger off the disk; restarted.
   */
  async function crashCase(tag, fraction, { mode = 'now', waitMs = 12_000, restAfterSave = false, joinSave = false, playerBlock = false } = {}) {
    const W = await world(`G6B RL ${tag}`, { joinSave, cap: true });
    const lot = await lotPaused(tag);
    if (!lot) { await L.leaveWorld(); return null; }
    if (joinSave) await joinSaved(tag, W, lot);
    const d = await deliver(fraction);
    // (PS) a changed ledger is saved with the world every 10 s while a build feeds: the crash window is the time before the next such save.
    // The case holds that window open (PS's test switch, this JVM only: the restart runs as shipped)
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush').catch(() => null);
    const s0 = await savedNow();
    const b0 = { ledger: ledgerOf(s0.file) };
    const lot0 = (await pile()).targets?.[lot] ?? {};
    check(sum(d.acc) > 0 && G.same(d.acc, d.need) && b0.ledger, `${tag}: ${fraction >= 1 ? 'all' : 'half'} of what the targets lack delivered (${sum(d.acc)} of ${sum(d.need)} units accepted) and the ledger saved (/save-all flush, save #${s0.saves}) with ${lot} paused at ${lot0.built}/${lot0.queued} built`);
    let late = null;
    if (restAfterSave) late = await deliver(1); // delivered after the save: the saved stock is short of it
    let placed = null;
    if (playerBlock) {
      // (J1) a player places one of the lot's unbuilt cells' target blocks after the save (a fake player through useItemOn: a PT record)
      const cells = await call('dev.site.cells', { site: lot }, 30_000);
      const plain = /:(\w+_planks|cobblestone|stone_bricks|bricks|stone|\w+_log|\w+_wool|\w+_terracotta|\w+_concrete)$/;
      const cand = Object.entries(cells).filter(([, id]) => plain.test(id)).map(([k, id]) => [k.split(',').map(Number), id]).sort((a, b) => a[0][1] - b[0][1]);
      for (const [[x, y, z], id] of cand.slice(0, 80)) {
        const r = (await call('dev.pt.uses', { ops: [{ item: id, at: [x, y, z], on: [x, y - 1, z], face: 'up', placer: 'J1Placer' }] }, 30_000)).results?.[0];
        if (r?.tracked && r.state === id) { placed = { at: [x, y, z], id, r }; break; }
      }
      check(!!placed, `${tag}: a player placed ${placed ? `${placed.id} at ${json(placed.at)}` : 'nothing'} in one of ${lot}'s unbuilt cells after the save (a PT record: ${placed?.r?.tracked})`, placed);
    }
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000);
    check(await quiet(), `${tag}: ${lot} resumed and built from that stock until ${fraction >= 1 || restAfterSave ? 'built' : 'starved'}`);
    const lot1 = (await pile()).targets?.[lot] ?? null;
    if (waitMs) await call('dev.wait', { ms: waitMs }, 60_000);
    const live = balance(await audit());
    const s1 = await savedNow();
    check(s1.saves === s0.saves, `${tag}: nothing saved the ledger between the case's save and the halt (save #${s1.saves})`);
    check(!lot1 || (lot1.built ?? 0) > (lot0.built ?? 0), `${tag}: ${lot} built after the save: ${lot0.built} -> ${lot1 ? lot1.built + '/' + lot1.queued : 'BUILT'}`);
    if (!(await halt(tag, mode))) return null;
    const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
    const n = { lot, lotAtSave: lot0, lotAtHalt: lot1 ?? 'built', late: late ? sum(late.acc) : 0, live, savedConsumed: sum(G.minus(Ld.consumed, b0.ledger.consumed)), savedPaid: sum(paidSum(Ld)), savedStock: sum(stockOf(Ld)) };
    log(`  ${tag}: live before the halt: standing ${live.standing}, paid ${live.paid}; saved ledger: consumed since the save ${n.savedConsumed}, paid ${n.savedPaid}, stock ${n.savedStock}`);
    await restart(W);
    const r = await after(tag, W, { b0 }, { lot });
    const rc = r.a1?.reconciled?.[lot] ?? null;
    // what the code before RL would have left free: the cells that stood unpaid at the load (charged now or owed)
    const unpaidAtLoad = rc ? sum(rc.charged) + sum(rc.owes) : null;
    if (mode === 'now') check(rc && rc.aheadCells > 0, `${tag}: the reconcile found ${lot}'s cells built after the save standing unpaid: ${rc ? `${rc.aheadCells} cell(s), charged ${sum(rc.charged)}, owes ${sum(rc.owes)} (${rc.owedCells} cell(s)), reopened ${rc.reopened}` : 'none'} (before RL: ${unpaidAtLoad ?? 0} units free)`, rc);
    if (playerBlock) check(rc && (rc.playerCells ?? 0) >= 1, `${tag}: the player's block in ${lot}'s cell was told apart at the reconcile: ${rc?.playerCells ?? 0} player cell(s) left uncharged (before J1: charged to the stock), charged ${sum(rc?.charged)} for the ${(rc?.aheadCells ?? 0) - (rc?.playerCells ?? 0)} built by Architect`, { rc, placed });
    let pc = null;
    if (playerBlock) pc = await playerCells(tag, W, lot);
    if (restAfterSave) check(rc && rc.owedCells > 0 && rc.reopened, `${tag}: the saved stock was short: ${rc?.owedCells} cell(s) owed and the built lot builds again (reopened ${rc?.reopened})`, rc);
    await L.leaveWorld();
    const { a1, ...rest } = r;
    return { ...n, placed, playerCells: pc, reconciled: rc, unpaidAtLoad, ...rest };
  }

  // ------------------------------------------------------------------ (J2 item 3: J1's deferred gate-only cases)

  /** (J2) rs_hut's next version with spruce walls (G.designs' rs_hut, walls swapped): every wall cell a changed cell (a swap). */
  async function hutV2() {
    const { Blueprint, palette } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const X = 6, Z = 4, H = 4;
    const bp = new Blueprint({ id: 'rs_hut', name: 'rs_hut', description: 'RS rs_hut', type: 'custom', profile: ['door', 'lit'], size: [X + 1, H + 1, Z + 5], origin: [0, 0, 0], groundY: 1, front: 'south', palette: palette({}), approach: false, interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
    bp.part('main', () => bp.room([0, 0, 0, X, H, Z], { wall: 'minecraft:spruce_planks', floor: 'minecraft:cobblestone', ceiling: 'minecraft:oak_planks', corners: 'minecraft:oak_log' }));
    bp.part('openings', () => { bp.door(3, 1, Z, 'south'); bp.set(1, 2, Z, 'minecraft:glass_pane'); bp.set(5, 2, Z, 'minecraft:glass_pane'); bp.set(3, 3, 1, 'minecraft:wall_torch', { facing: 'south' }); bp.set(3, 3, 0, 'minecraft:copper_block'); });
    bp.part('approach', () => bp.floor(2, Z + 1, 4, Z + 4, 0, 'minecraft:gravel'));
    bp.spot('entrance', 3, Z + 1, 180);
    bp.spot('spawn', 3, Z + 3, 180);
    const dir = path.join(h.OUT, 'rs_hut-v2');
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    return call('dev.entry.installVersion', { entry: 'rs_hut', dir, summary: 'J2 spruce walls' }, 60_000);
  }

  /** (J2) The apitest mod's async answer (`/apitest <args>`, then `get <key>` until it has a value). */
  async function apiLater(args, timeoutMs = 120_000) {
    const one = async (a) => {
      const r = await cmd(`/apitest ${a}`);
      const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
      return line === undefined ? null : JSON.parse(line);
    };
    const p = await one(args);
    if (!p?.pending) return p;
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      const r = await one(`get ${p.pending}`);
      if (r && r.value !== undefined && r.value !== null) return r.value;
      await L.sleep(500);
    }
    return { refused: `no answer for ${args}` };
  }

  /** (J2) Delivers `fraction` of what one target lacks (its own outstanding less the stock), in one insert. */
  async function deliverTo(id, fraction) {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.targets?.[id]?.outstanding ?? {})) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = fraction >= 1 ? lack : Math.max(1, Math.floor(lack * fraction));
    }
    const acc = (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    return { need, acc };
  }

  /**
   * (J2 item 3a, RL "Known open") Crash + swap: the lot built, a construction delta to rs_hut v2 (its walls swapped, oak to spruce planks)
   * queued; the lot paused, half of what it lacks delivered, the ledger saved (/save-all flush), the lot resumed: it swaps cells after the
   * save until it starves; 12 s; a halt with nothing saved. After the restart: no cell stands unpaid, a second load changes nothing, fed
   * until built: the paid cells standing equal the paid records and what the targets took equals what their records gained.
   */
  async function swapCase(tag) {
    const W = await world(`G6B RL ${tag}`);
    const lot = await lotPaused(tag);
    if (!lot) { await L.leaveWorld(); return null; }
    await deliver(1);
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000);
    let built = false;
    for (let i = 0; i < 300 && !built; i++) { built = !(await pile()).targets?.[lot] || (await call('dev.site.state', { site: lot }, 30_000).catch(() => ({}))).state === 'BUILT'; if (!built) { await deliver(1); await L.sleep(2000); } }
    check(built, `${tag}: ${lot} built at v1 (rs_hut)`);
    const v = await hutV2();
    check((v?.version ?? 0) >= 2, `${tag}: rs_hut v2 installed (spruce walls): ${json(v)}`);
    const d = await apiLater(`applydelta ${lot} ${v.version} ${G.OWNER}`);
    check(d?.applied === true, `${tag}: the construction delta v1 -> v${v.version} of ${lot} queued (${json(d?.refusals ?? d?.to ?? d)}; refund ${json(d?.refund)})`, d);
    if (!d?.applied) { await L.leaveWorld(); return null; }
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: true }, 60_000);
    await quiet();
    const half = await deliverTo(lot, 0.5);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush').catch(() => null);
    const s0 = await savedNow();
    const b0 = { ledger: ledgerOf(s0.file) };
    const lot0 = (await pile()).targets?.[lot] ?? {};
    check(sum(half.acc) > 0 && b0.ledger, `${tag}: half of the swap's bill delivered (${sum(half.acc)} of ${sum(half.need)}) and the ledger saved (save #${s0.saves}) with ${lot} paused at ${lot0.built}/${lot0.queued}`);
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000);
    check(await quiet(), `${tag}: ${lot} swapped cells after the save until it starved`);
    const lot1 = (await pile()).targets?.[lot] ?? null;
    await call('dev.wait', { ms: 12_000 }, 60_000);
    const s1 = await savedNow();
    check(s1.saves === s0.saves, `${tag}: nothing saved the ledger between the case's save and the halt (save #${s1.saves})`);
    check(!!lot1 && (lot1.built ?? 0) > (lot0.built ?? 0), `${tag}: ${lot} swapped after the save: ${lot0.built} -> ${lot1?.built}/${lot1?.queued} (mid-swap at the halt)`);
    const live = balance(await audit());
    check(live.dupeUnits === 0 && live.doubleUnits === 0, `${tag}: live before the halt, the paid cells standing equal the paid records (standing ${live.standing}, paid ${live.paid}; dupe ${json(live.dupe)}; double ${json(live.double)})`, live);
    if (!(await halt(tag))) return null;
    await restart(W);
    const r = await after(tag, W, { b0 }, { lot });
    await L.leaveWorld();
    const { a1, ...rest } = r;
    return { lot, delta: { to: d.to, refund: d.refund }, lotAtSave: lot0, lotAtHalt: lot1, reconciled: a1?.reconciled?.[lot] ?? null, ...rest };
  }

  /**
   * (J2 item 3c, RL "Known open") A halted terrain target, in GR-RS's rs01_land world (the survival region whose terrain targets are
   * RegionTargets, gate6crs item 4): checked and realised in survival with a stockpile; once its free pass is down, the terrain target with
   * the most paid cells to build is paused while the rest is fed; half of what it lacks delivered, the ledger saved, the target resumed: it
   * builds after the save until it starves; 12 s; a halt with nothing saved. After the restart: the reconcile read its book and charged the
   * cells built after the save; no cell stands unpaid; a second load changes nothing; fed until built: standing = the paid records, and
   * what the targets took equals what their records gained.
   */
  async function terrainCase(tag) {
    const core = await import('./gate6chy-core.mjs');
    const B = await import('./gate6chy-b.mjs');
    const rctx = { ...ctx, KIT: path.join(h.root, 'kit'), json, root: h.root, check, log, core, B };
    const fx = G.fixture(rctx, 'rs01_land');
    const S = await G.site(rctx, tag, fx);
    const ck = await G.check(rctx, tag, S);
    check(ck.check?.survival === true && ck.check?.overall === 'READY', `${tag}: rs01 checked in survival: ${ck.check?.overall}`);
    await G.pile(rctx, S, 3);
    const region = await G.realise(rctx, ck.check.artifactSha);
    const cx = Math.floor((S.W.claim[0] + S.W.claim[2]) / 2), cz = Math.floor((S.W.claim[1] + S.W.claim[3]) / 2);
    const paidLeft = (t) => (t.cells ?? []).filter((c) => !(c[3] & 1) && !(c[3] & 2) && !(c[3] & 4)).length;
    let T = null, seen = [];
    for (let i = 0; i < 60 && !T; i++) {
      await L.sleep(3000);
      const rs = await call('dev.rs.cells', { region }, 300_000).catch(() => ({}));
      seen = (rs.targets ?? []).map((t) => [t.target, t.part, paidLeft(t)]);
      const fed = new Set(Object.keys((await pile()).targets ?? {}));
      T = (rs.targets ?? []).filter((t) => fed.has(t.target) && paidLeft(t) >= 8).sort((a, b) => paidLeft(b) - paidLeft(a))[0] ?? null;
    }
    check(!!T, `${tag}: a terrain target of rs01 in the feed with paid cells to build: ${T ? `${T.target} (part ${T.part}, ${paidLeft(T)} paid cells left)` : `none (${json(seen).slice(0, 300)})`}`);
    if (!T) { await L.leaveWorld(); return null; }
    const id = T.target;
    const pr = await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: true }, 60_000);
    check(!pr.refused, `${tag}: ${id} paused: ${json(pr.refused ?? 'paused')}`);
    await deliver(1, (k) => k === id);
    await quiet();
    const half = await deliverTo(id, 0.5);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush').catch(() => null);
    const s0 = await savedNow();
    const b0 = { ledger: ledgerOf(s0.file) };
    const t0 = (await pile()).targets?.[id] ?? {};
    check(sum(half.acc) > 0 && b0.ledger, `${tag}: half of what ${id} lacks delivered (${sum(half.acc)} of ${sum(half.need)}) and the ledger saved (save #${s0.saves}) with it paused at ${t0.built}/${t0.queued}`);
    await call('dev.stockpile.pause', { owner: G.OWNER, site: id, paused: false }, 60_000);
    check(await quiet(), `${tag}: ${id} built after the save until it starved`);
    const t1 = (await pile()).targets?.[id] ?? null;
    await call('dev.wait', { ms: 12_000 }, 60_000);
    const s1 = await savedNow();
    check(s1.saves === s0.saves, `${tag}: nothing saved the ledger between the case's save and the halt (save #${s1.saves})`);
    check(!!t1 && (t1.built ?? 0) > (t0.built ?? 0), `${tag}: ${id} built after the save: ${t0.built} -> ${t1?.built}/${t1?.queued}`);
    if (!(await halt(tag))) return null;
    const back = async () => { await L.openWorld(S.world); await L.tp(cx, 90, cz); await L.settle(4000); };
    await back();
    const a1 = await audit();
    const b1 = balance(a1);
    const rc = a1.reconciled?.[id] ?? null;
    log(`  ${tag}: after the restart (unclean ${a1.uncleanStart}): standing ${b1.standing}, paid ${b1.paid}; unpaid ${json(b1.dupe)}; paid not standing ${json(b1.double)}; reconciled ${json(rc)}`);
    check(a1.uncleanStart === true && b1.dupeUnits === 0, `${tag}: after the unclean restart no cell stands unpaid (standing ${b1.standing}, paid ${b1.paid}; dupe ${b1.dupeUnits}: ${json(b1.dupe)})`, b1);
    check(rc && rc.aheadCells > 0, `${tag}: the reconcile read ${id}'s book: ${rc ? `${rc.aheadCells} cell(s) built after the save, charged ${sum(rc.charged)}, owes ${sum(rc.owes)}` : 'not reconciled'}`, rc);
    if (!(await halt(`${tag} (second)`))) return { rc, b1 };
    await back();
    const a1b = await audit();
    const r2 = a1b.reconciled?.[id] ?? {};
    check(G.same(a1b.ledger?.consumed, a1.ledger?.consumed) && G.same(a1b.stock, a1.stock) && sum(r2.charged) === 0 && sum(r2.creditedBack) === 0,
      `${tag}: a second unclean load changes nothing (consumed ${sum(a1b.ledger?.consumed)} = ${sum(a1.ledger?.consumed)}; charged ${sum(r2.charged)}, given back ${sum(r2.creditedBack)})`, r2);
    const f = await G.feed(rctx, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built after the restart (${f.waves} waves): ${f.last.st.view.state}`);
    await quiet();
    const a2 = await audit();
    const b2 = balance(a2);
    const consumed = G.minus(G.minus(a2.ledger?.consumed, b0.ledger.consumed), G.minus(a2.ledger?.returned, b0.ledger.returned));
    const gained = G.minus(paidSum(a2.ledger), paidSum(b0.ledger));
    check(b2.dupeUnits === 0 && b2.doubleUnits === 0 && a2.identity !== false, `${tag}: built after the restart, the paid cells standing equal the paid records item for item (standing ${b2.standing}, paid ${b2.paid}; dupe ${json(b2.dupe)}; double charge ${json(b2.double)})`, { b1, b2 });
    check(G.same(consumed, gained), `${tag}: what the targets took since the save (${sum(consumed)}) is what their records gained (${sum(gained)}), item for item`, { consumed, gained });
    await L.leaveWorld();
    return { target: id, part: T.part, atSave: t0, atHalt: t1, reconciled: rc, b1, b2, consumed, gained };
  }

  steps.rlj2 = async () => {
    await ensure();
    const out = {};
    out.RL6 = await swapCase('RL6');
    out.RL7 = await terrainCase('RL7');
    spendZero();
    return out;
  };

  /**
   * (BC-c) The constructed overshoot: RL1's shape under a maxBill (the quote). The lot paused, half of what the targets lack delivered,
   * saved (/save-all flush); the lot resumed and built after the save until it starved; then the cap of the item it drew most of since the save
   * (one it still needs) lowered to its draws at the save (dev.bc.cap, the stand-in for a cap below what the reconcile must charge: region.json
   * only, not the ledger); a halt with nothing saved. After the restart the reconcile charged the standing cells anyway (no cell stands
   * unpaid), named the overshoot (capOver, the WARN), and the lot waits bill_cap with nextNeeded past its need by the overshoot; fed past the
   * cap nothing of the item is drawn; the cap back at the quote: built; items in = items out.
   */
  steps.bccover = async () => {
    await ensure();
    const out = {};
    const tag = 'BCC';
    const W = await world('G6B BCC over', { cap: true });
    const lot = await lotPaused(tag);
    if (!lot) { await L.leaveWorld(); spendZero(); return out; }
    const capAt = async () => call('dev.bc.cap', { region: W.region }, 30_000);
    const c00 = await capAt();
    const quote = c00.maxBill ?? {};
    await deliver(0.5);
    await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
    await cmd('/save-all flush').catch(() => null);
    const s0 = await savedNow();
    const b0 = { ledger: ledgerOf(s0.file) };
    const cSave = await capAt();
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000);
    check(await quiet(), `${tag}: ${lot} resumed and built after the save until it starved`);
    const cLive = await capAt();
    const need = (await pile()).targets?.[lot]?.outstanding ?? {};
    // the item drawn most since the save that the lot still needs
    const cand = Object.keys(need).filter((k) => (need[k] ?? 0) > 0).map((k) => [k, (cLive.drawn?.[k] ?? 0) - (cSave.drawn?.[k] ?? 0)]).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
    check(cand.length > 0, `${tag}: ${lot} drew an item it still needs after the save (${json(cand.slice(0, 3))})`);
    if (!cand.length) { await L.leaveWorld(); spendZero(); return out; }
    const [X, dX] = cand[0];
    const low = { ...quote, [X]: cSave.drawn?.[X] ?? 0 };
    const cl = await call('dev.bc.cap', { region: W.region, set: low }, 30_000);
    const s1 = await savedNow();
    out.set = { item: X, quote: quote[X], atSave: cSave.drawn?.[X], live: cLive.drawn?.[X], cap: cl.maxBill?.[X], need: need[X], saves: [s0.saves, s1.saves] };
    check(cl.maxBill?.[X] === low[X] && s1.saves === s0.saves, `${tag}: ${X} capped at its draws at the save (${low[X]}; live ${cLive.drawn?.[X]}, +${dX} since the save; the lot still needs ${need[X]}); nothing saved the ledger (save #${s0.saves} -> #${s1.saves})`, out.set);
    // the server's log: the runner's client.log (one up from the step's OUT when gate-run starts the client), this OUT's, or the game's
    const logs = [path.join(path.dirname(L.OUT), 'client.log'), path.join(L.OUT, 'client.log'), path.join(L.GAME_DIR, 'logs', 'latest.log')];
    const log0 = Object.fromEntries(logs.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
    await call('dev.wait', { ms: 12_000 }, 60_000); // the chunks' eager saves (RL1's 12 s): the cells built after the save stand on the disk
    if (!(await halt(tag))) { spendZero(); return out; }
    await restart(W);
    const a1 = await audit();
    const b1 = balance(a1);
    const rc = a1.reconciled?.[lot] ?? {};
    out.reconcile = { rc, dupe: b1.dupe, unclean: a1.uncleanStart };
    check(a1.uncleanStart === true && (rc.aheadCells ?? 0) > 0 && b1.dupeUnits === 0 && (rc.owedCells ?? 0) === 0, `${tag}: the reconcile charged ${lot}'s ${rc.aheadCells} standing cell(s) built after the save whatever the cap (charged ${json(rc.charged)}; owed ${rc.owedCells ?? 0}); no cell stands unpaid (dupe ${b1.dupeUnits})`, out.reconcile);
    const over = rc.capOver?.[X] ?? 0;
    check(rc.capRegion === W.region && over > 0 && over <= dX, `${tag}: the reconcile named the overshoot: capOver ${json(rc.capOver)} (${X}: at most +${dX}, the draws since the save), region ${rc.capRegion}`, rc);
    const tail = logs.map((f) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(fs.statSync(f).size >= log0[f] ? log0[f] : 0).toString('utf8') : '')).join('\n');
    const warn = tail.split('\n').find((l) => /WARN/.test(l) && /past its maxBill by/.test(l) && l.includes(X)) ?? null;
    out.warn = warn;
    check(!!warn, `${tag}: the WARN names the overshoot: ${warn ? warn.slice(warn.indexOf('Stockpile')).slice(0, 260) : 'none in the server log'}`);
    await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000); // (as live before the halt)
    // the lot waits bill_cap (all the rest delivered so it builds every cell it can first); nextNeeded: its need of X plus the overshoot
    let capped = null;
    for (let i = 0; i < 100 && !capped; i++) {
      await deliver(1);
      const c = await capAt();
      capped = (c.targets ?? []).find((x) => x.id === lot && x.blocked === 'bill_cap') ?? null;
      if (!capped) await L.sleep(3000);
    }
    const nn = (capped?.nextNeeded ?? []).find((n) => n.item === X)?.count ?? 0;
    const needX = (await pile()).targets?.[lot]?.outstanding?.[X] ?? 0;
    out.wait = { capped, needX, nextNeededX: nn };
    check(!!capped && capped.waiting === true && nn === needX + over && needX > 0, `${tag}: ${lot} waits typed ${capped?.blocked} (waiting ${capped?.waiting}); nextNeeded ${X} ${nn} = its need ${needX} + the overshoot ${over}`, out.wait);
    // fed past the cap: nothing of X drawn for 20 s
    const d0 = (await capAt()).drawn?.[X];
    await L.sleep(20_000);
    const d1 = (await capAt()).drawn?.[X];
    check(d0 === d1, `${tag}: past the cap nothing more of ${X} is drawn over 20 s (${d0} -> ${d1})`);
    // the cap back at the quote: built; items in = items out
    await call('dev.bc.cap', { region: W.region, set: quote }, 30_000);
    await cmd(`/apitest sapprove ${W.group} props`);
    const f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: the cap back at the quote, fed until built (${f.waves} waves): ${f.last.st.view.state}`);
    await quiet();
    const a2 = await audit();
    const b2 = balance(a2);
    const consumed = G.minus(G.minus(a2.ledger?.consumed, b0.ledger.consumed), G.minus(a2.ledger?.returned, b0.ledger.returned));
    const gained = G.minus(paidSum(a2.ledger), paidSum(b0.ledger));
    const cEnd = await capAt();
    out.built = { b2, consumed, gained, drawn: cEnd.drawn, quote, overshoot: cEnd.overshoot };
    check(b2.dupeUnits === 0 && b2.doubleUnits === 0 && a2.identity !== false && G.same(consumed, gained), `${tag}: built: items in = items out (standing = paid records: dupe ${b2.dupeUnits}, double ${b2.doubleUnits}; identity ${a2.identity}; taken since the save ${sum(consumed)} = records gained ${sum(gained)})`, out.built);
    check(Object.keys(cEnd.overshoot ?? {}).length === 0 && G.same(cEnd.drawn, G.plus(cEnd.paid, cEnd.regionCharged)), `${tag}: built within the quote (overshoot ${json(cEnd.overshoot)}); the cap's total = the charges`, cEnd);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.rlcrash = async () => {
    await ensure();
    const out = {};
    // RL1: saved mid-feed: half delivered, the lot builds after the save until it starves (still building at the halt)
    out.RL1 = await crashCase('RL1', 0.5, { joinSave: true });
    // RL2: all delivered, the lot built (BUILT recorded) after the save
    out.RL2 = await crashCase('RL2', 1);
    // RL3: the ledger ahead of the chunks: all delivered, the lot built, then a halt straight after an autosave's chunk save without flush
    out.RL3 = await crashCase('RL3', 1, { mode: 'autosave', waitMs: 0 });
    // RL4: half delivered before the save, the rest after it, the lot built: the saved stock is short, the lot owes and builds again
    out.RL4 = await crashCase('RL4', 0.5, { restAfterSave: true });
    // RL5 (J1): as RL2, and a player places one of the lot's blocks in its unbuilt cell after the save: not charged at the reconcile
    out.RL5 = await crashCase('RL5', 1, { playerBlock: true });
    spendZero();
    return out;
  };
}
