// Slice RU gate (docs/CONTRACT.md "Phase 6d slice RV" §8 and "### Slice RU as built"; Steward's ask A2-1): undoRevision of a survival
// revision whose targets are not all built cancels them (RV §8), instead of refusing survival_building. Registered into
// tools/gate6dgr.mjs (GR's survival town, growth and feed helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs rucancel  (ru-cancel)  one survival world: a flat_village town fed until built; then
//                                                  (a) a growth realised and never fed (its targets put down, its batch still writing):
//                                                      undoRevision cancels it: the world before it (E-flat 0 over the claim), the stock
//                                                      unchanged, no refund, none of its targets left in the feed;
//                                                  (b) a growth realised and fed in part (a fraction of what it lacks, until the build
//                                                      stalls): undoRevision cancels it: E-flat 0; items in = items out (every item put in
//                                                      since before the growth is back in the stock, nothing more); its refund is what it
//                                                      consumed; outstanding and the feed order as before the growth;
//                                                  (c) QT: the same growth planned again, quoted, realised and fed: consumed = the quote
//   node tools/gate6dgr.mjs rucrash   (ru-crash)   three survival worlds, each a growth fed in part (stalled), the ledger and the chunks
//                                                  saved (/save-all flush), then its undo halted with nothing saved at
//                                                  RVU1  the undo's commit point (its batch still running)
//                                                  RVC1  the cancel asked for (the queue file's save in flight)
//                                                  RVC2  the batch cancelled and ended, nothing drained or removed
//                                                  the saved ledger read off the disk, the restart resumes the cancel: it finishes once;
//                                                  E-flat 0; what came back equals what the saved ledger says the growth consumed (no mint,
//                                                  no loss); every item put in is back; a second undo refuses and moves nothing
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerRU(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvState, haltWait, cellsOf, diff } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const GROW = [{ id: 'qa', type: 'house', size: [9, 9], villager: 'dwelling' }];
  const ENTRIES = { qa: 'rs_hut' };

  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  function stockOf(l) {
    const o = {};
    for (const k of new Set([...Object.keys(l?.delivered ?? {}), ...Object.keys(l?.returned ?? {})])) {
      const s = (l.delivered?.[k] ?? 0) + (l.returned?.[k] ?? 0) - (l.consumed?.[k] ?? 0) - (l.withdrawn?.[k] ?? 0) - (l.dropped?.[k] ?? 0);
      if (s) o[k] = s;
    }
    return o;
  }
  /** What the owner holds of the stock with the overflow (refundOverflow drops as items at the crate). */
  const backOf = (l) => G.plus(stockOf(l), l?.refundOverflow ?? {});

  async function world(name) {
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
    return { gy, BOX: BOXOF(CLAIM, gy), dir: path.join(L.SAVES, name), crates };
  }

  /** The survival town, fed until built: its region, its targets. */
  async function town(tag) {
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    const f0 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `${tag}: the town built in survival (${f0.waves} waves)`);
    return { region, t0: new Set((f0.last.rs?.targets ?? []).map((x) => x.id)) };
  }

  /** A growth planned and realised (qa: rs_hut), waited for until its targets are put down. */
  async function grow(tag, region, t0) {
    const g = await growPlan(region, { lots: GROW });
    check(!g.refused && g.revisionOf?.rid >= 1, `${tag}: a growth planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    if (g.refused) return null;
    const r = await call('dev.region.realise', { planId: g.planId, lots: ENTRIES }, 300_000);
    check(!r.refused, `${tag}: the growth realised (qa: rs_hut): ${r.refused ?? r.region}`);
    let rs;
    for (let i = 0; i < 90; i++) {
      rs = await G.rsState(ctx, region);
      if ((rs.targets ?? []).some((x) => !t0.has(x.id))) break;
      await L.sleep(2000);
    }
    const mine = (rs.targets ?? []).filter((x) => !t0.has(x.id));
    check(mine.length > 0, `${tag}: the growth's targets put down (${mine.length}), waiting for their items`);
    return { g, rid: g.revisionOf.rid };
  }

  /** One feed wave of `fraction` of what is lacking, then waits until the consumption stalls (a run starts only with its whole bill). */
  async function feedPart(tag, region, fraction) {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) {
      const lack = n - (ps.stock?.[it] ?? 0);
      if (lack > 0) need[it] = Math.max(1, Math.floor(lack * fraction));
    }
    const acc = (await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000)).accepted ?? {};
    let last = null, still = 0, rs;
    for (let k = 0; k < 120 && still < 4; k++) {
      await L.sleep(2000);
      const p = await pile();
      const c = json(p.ledger?.consumed ?? {});
      still = c === last ? still + 1 : 0;
      last = c;
    }
    rs = await G.rsState(ctx, region);
    const st = await rvState(region);
    log(`  ${tag}: fed ${sum(acc)} item(s) (${fraction} of what it lacked); the build ${rs.build?.percent}% (done ${rs.build?.done}); busy ${st.busy}`);
    return { accepted: acc, build: rs.build, busy: st.busy };
  }

  /** After the undo: no target of the growth left (rs state and the feed order); outstanding as before the growth. */
  async function leftover(tag, region, t0, ps0) {
    const rs = await G.rsState(ctx, region);
    const p = await pile();
    const extra = (rs.targets ?? []).filter((x) => !t0.has(x.id)).map((x) => x.id);
    const feedNew = (p.feedOrder ?? []).filter((id) => !(ps0.feedOrder ?? []).includes(id));
    check(extra.length === 0 && feedNew.length === 0 && G.same(p.outstanding, ps0.outstanding), `${tag}: none of the growth's targets is left (${extra.length} in the region's targets, ${feedNew.length} in the feed order); outstanding ${json(p.outstanding)} as before the growth ${json(ps0.outstanding)}`, { extra, feedNew });
    return { extra, feedNew, outstanding: p.outstanding };
  }

  /** Items in = items out since `ps0` (live ledgers): every item delivered since is in the stock (with overflow) again. */
  function inOut(tag, ps0, ps1, extra = {}) {
    const put = G.minus(ps1.ledger?.delivered, ps0.ledger?.delivered);
    const back = G.minus(backOf(ps1.ledger), backOf(ps0.ledger));
    const net = G.minus(G.minus(ps1.ledger?.consumed, ps0.ledger?.consumed), G.minus(G.plus(ps1.ledger?.returned, ps1.ledger?.refundOverflow), G.plus(ps0.ledger?.returned, ps0.ledger?.refundOverflow)));
    const o = { put, back, net, identity: ps1.identity, ...extra };
    check(G.same(put, back) && ps1.identity !== false, `${tag}: items in = items out: put in ${sum(put)} (${json(put)}), back in the stock ${sum(back)} (${json(back)}); consumed less refunded ${json(net)}; identity ${ps1.identity}`, o);
    return o;
  }

  steps.rucancel = async () => {
    await ensure();
    const out = {};
    const W = await world('G6B RU Cancel');
    const T = await town('ru-cancel');
    const S0 = await cellsOf(W.BOX);
    const notCrates = (d) => d.first.filter((m) => !W.crates.some((c) => m.startsWith(`${c[0]},${c[1]},${c[2]} `)));

    // (a) never fed
    {
      const tag = 'never fed';
      const ps0 = await pile();
      const g = await grow(tag, T.region, T.t0);
      if (g) {
        const st = await rvState(T.region);
        const u = await call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000);
        await L.settle(3000);
        const ps1 = await pile();
        const d = diff(S0, await cellsOf(W.BOX));
        out.neverFed = { busyAtUndo: st.busy, result: u, worldDiff: d.n };
        check(u.removed === true && d.n === 0, `${tag}: undoRevision while the growth ${st.busy ? `is still writing (${st.busy})` : 'stands unbuilt'} cancels it: removed ${u.removed}${u.refused ? ` (refused ${u.refused})` : ''}; the world before it (${d.n} differ)`, d.first);
        check(sum(u.refund) === 0 && G.same(ps1.stock, ps0.stock) && G.same(ps1.ledger?.consumed, ps0.ledger?.consumed), `${tag}: nothing refunded (${json(u.refund)}), nothing consumed; the stock as before`, { refund: u.refund, before: ps0.stock, after: ps1.stock });
        out.neverFed.left = await leftover(tag, T.region, T.t0, ps0);
        const sv = await rvState(T.region);
        check(sv.busy === null && sv.position === 0 && sv.revisions.find((x) => x.rid === g.rid)?.state === 'UNDONE', `${tag}: the region at position ${sv.position}, busy ${sv.busy}; revision ${g.rid} ${sv.revisions.find((x) => x.rid === g.rid)?.state}`);
      }
    }

    // (b) fed in part
    {
      const tag = 'fed in part';
      const ps0 = await pile();
      const g = await grow(tag, T.region, T.t0);
      if (g) {
        const fp = await feedPart(tag, T.region, 0.5);
        const ps1 = await pile();
        const consumed = G.minus(ps1.ledger?.consumed, ps0.ledger?.consumed);
        check(sum(consumed) > 0 && !fp.build?.done, `${tag}: the growth built in part: ${sum(consumed)} unit(s) consumed, the build ${fp.build?.percent}% (not done); ${sum(G.minus(ps1.stock, ps0.stock))} delivered unit(s) not consumed in the stock`, { consumed });
        const u = await call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000);
        await L.settle(3000);
        const ps2 = await pile();
        const d = diff(S0, await cellsOf(W.BOX));
        out.partFed = { busyAtUndo: fp.busy, consumed, result: u, worldDiff: d.n };
        check(u.removed === true && d.n === 0, `${tag}: undoRevision cancels the growth ${fp.busy ? `still writing (${fp.busy})` : 'with unbuilt targets'}: removed ${u.removed}${u.refused ? ` (refused ${u.refused})` : ''}; the world before it (${d.n} differ)`, d.first);
        check(G.same(u.refund, consumed), `${tag}: its refund is what it consumed, once: refund ${json(u.refund)}, consumed ${json(consumed)}`);
        out.partFed.inOut = inOut(tag, ps0, ps2);
        out.partFed.left = await leftover(tag, T.region, T.t0, ps0);
      }
      check(Boolean(out.neverFed?.busyAtUndo || out.partFed?.busyAtUndo), `the cancel of a revision still writing was exercised (busy at the undo: ${json([out.neverFed?.busyAtUndo, out.partFed?.busyAtUndo])})`);
    }

    // (c) QT: the same growth again, quoted; realised and fed: consumed = the quote
    {
      const tag = 'QT after the cancel';
      const g = await growPlan(T.region, { lots: GROW });
      check(!g.refused, `${tag}: the growth planned again: ${g.refused ?? g.planId}`);
      if (!g.refused) {
        const q = await call('dev.region.quote', { planId: g.planId, lotEntries: ENTRIES }, 300_000);
        check(!q.refused && q.survival === true && q.region === T.region && sum(q.bom) > 0, `${tag}: quoted: ${q.refused ?? `bom ${sum(q.bom)} unit(s)`}`);
        const ps0 = await pile();
        const r = await call('dev.region.realise', { planId: g.planId, lots: ENTRIES }, 300_000);
        check(!r.refused, `${tag}: realised: ${r.refused ?? r.region}`);
        for (let i = 0; i < 90; i++) {
          const rs = await G.rsState(ctx, T.region);
          if ((rs.targets ?? []).some((x) => !T.t0.has(x.id))) break;
          await L.sleep(2000);
        }
        const f = await G.feed({ L }, T.region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
        const ps1 = await pile();
        const paid = G.minus(ps1.ledger?.consumed, ps0.ledger?.consumed);
        out.qt = { bom: q.bom, paid, waves: f.waves };
        check(f.last.rs.build?.done && G.same(q.bom, paid), `${tag}: built (${f.waves} waves); consumed equals the quote item for item: quote ${json(q.bom)}, consumed ${json(paid)}`, { diff: G.minus(paid, q.bom ?? {}) });
      }
    }
    const rm = await G.remove(ctx, T.region);
    const df = diff(S0, await cellsOf(W.BOX));
    out.removed = { removed: rm.removed, left: notCrates(df).length };
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.rucrash = async () => {
    await ensure();
    const out = {};
    for (const point of ['RVU1', 'RVC1', 'RVC2']) {
      const tag = point;
      const W = await world(`G6B RU ${point}`);
      const T = await town(tag);
      const S0 = await cellsOf(W.BOX);
      const ps0 = await pile();
      const g = await grow(tag, T.region, T.t0);
      if (!g) { await L.leaveWorld(); continue; }
      const fp = await feedPart(tag, T.region, 0.5);
      check(Boolean(fp.busy) && fp.busy.startsWith('revising'), `${tag}: the growth still writing at the undo (busy ${fp.busy}): the cancel path`);
      // the baseline: the ledger and the chunks saved; nothing consumed since (the build stalled)
      await cmd('/save-all flush');
      await call('dev.wait', { ms: 2000 }, 30_000);
      const live = await pile();
      await call('dev.journal.killAt', { point }, 10_000);
      call('dev.rv.undo', { region: T.region, toPosition: 0 }, 4 * 3_600_000).catch(() => null);
      const down = await haltWait();
      check(down, `${tag}: the kill point ${point} halted the server during the cancel (nothing saved)`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
      const Ld = ledgerOf(JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8')));
      await L.openWorld(path.basename(W.dir));
      await L.tp(CX + 80, 60, CZ + 56);
      let st;
      const t1 = Date.now();
      for (; Date.now() - t1 < 1_800_000;) { st = await rvState(T.region); if (st.busy === null) break; await L.sleep(L.pollDelayMs(Date.now() - t1)); }
      await L.settle(3000);
      const after = await pile();
      const d = diff(S0, await cellsOf(W.BOX));
      const owed = G.minus(Ld?.consumed, ps0.ledger?.consumed); // what the saved ledger says the growth consumed
      const back = G.minus(backOf(after.ledger), backOf(Ld));
      const o = { point, busyAtUndo: fp.busy, consumedLive: G.minus(live.ledger?.consumed, ps0.ledger?.consumed), owed, back, mint: G.minus(back, owed), worldDiff: d.n,
        position: st?.position, states: st?.revisions?.map((x) => [x.rid, x.state]) };
      log(`  ${tag}: consumed (saved ledger) ${json(owed)}; came back ${json(back)}`);
      check(st?.busy === null && st.position === 0 && st.revisions.find((x) => x.rid === g.rid)?.state === 'UNDONE' && d.n === 0, `${tag}: the restart resumed the cancel and it finished: position ${st?.position}, revision ${g.rid} ${st?.revisions?.find((x) => x.rid === g.rid)?.state}; the world before the growth (${d.n} differ)`, d.first);
      check(sum(owed) > 0 && G.same(back, owed) && after.identity !== false, `${tag}: items in = items out against the saved state: what came back ${json(back)} equals what the saved ledger says the growth consumed ${json(owed)} (minted ${sum(Object.fromEntries(Object.entries(o.mint).filter(([, v]) => v > 0)))}, lost ${-sum(Object.fromEntries(Object.entries(o.mint).filter(([, v]) => v < 0)))}; identity ${after.identity})`, o);
      o.inOut = inOut(tag, ps0, after);
      o.left = await leftover(tag, T.region, T.t0, ps0);
      const u2 = await call('dev.rv.undo', { region: T.region, toPosition: 0 }, 60_000);
      const again = await pile();
      check(String(u2.refused ?? '').startsWith('NOT_ALLOWED') && G.same(again.stock, after.stock), `${tag}: exactly once: a second undo refuses (${u2.refused}) and moves nothing`);
      out[tag] = o;
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };
}
