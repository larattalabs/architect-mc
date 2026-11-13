// Slice JR gate (docs/CONTRACT.md "Slice JR, journal vs autosave refunds"): a survival undo after a halt with nothing saved never refunds
// more than the saved ledger says the undone targets consumed, and never less (items in = items out against the saved state).
// Registered into tools/gate6dgr.mjs (GR's survival town, growth and feed helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs jrcrash   (jr-crash)   three survival worlds, each: the stockpile's ledger saved (/save-all flush) after the
//                                                  realise and before any feed, fed until built, 12 s for the chunks' eager saves, then a
//                                                  halt with nothing saved; <world>/architect/stockpiles.json read off the disk before the
//                                                  restart (the saved ledger), the undo resumed after it:
//                                                  K5    a plain survival region removal (no revision): the removal's commit point
//                                                  RVU2  a survival growth's undo: drained, nothing removed
//                                                  RVU2s the same, with the ledger saved just before the kill (a feed-order change): the
//                                                        ledger ahead of the chunks (the opposite risk)
//                                                  each: what came back into the stock (with overflow) equals what the saved ledger says the
//                                                  undone targets consumed, item for item; the ledger's identity holds; the world as before
//
// Evidence: artifacts/gate6d-gr/jrcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerJR(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvState, haltWait, cellsOf, diff } = h;
  const ctx = { L, OUT, imp: h.imp };
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const savedNow = async () => call('dev.stockpile.saved', { owner: G.OWNER }, 60_000);
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];

  /** The owner's ledger in a stockpiles.json root (the file's format 1: stockpiles[].ledger). */
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  /** stock with overflow: what the owner got back (refundOverflow drops as items). */
  const backOf = (l) => G.plus(stockOf(l), l?.refundOverflow ?? {});
  function stockOf(l) {
    const o = {};
    for (const k of new Set([...Object.keys(l?.delivered ?? {}), ...Object.keys(l?.returned ?? {})])) {
      const s = (l.delivered?.[k] ?? 0) + (l.returned?.[k] ?? 0) - (l.consumed?.[k] ?? 0) - (l.withdrawn?.[k] ?? 0) - (l.dropped?.[k] ?? 0);
      if (s) o[k] = s;
    }
    return o;
  }

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
    return { gy, BOX: BOXOF(CLAIM, gy), dir: path.join(L.SAVES, name) };
  }

  /** The saved baseline: /save-all flush, then the ledger as the file holds it and the save count. */
  async function baseline(tag) {
    await cmd('/save-all flush');
    await call('dev.wait', { ms: 2000 }, 30_000);
    const s = await savedNow();
    const live = await pile();
    const l = ledgerOf(s.saved);
    check(l && G.same(l.consumed, live.ledger?.consumed) && G.same(l.delivered, live.ledger?.delivered), `${tag}: the ledger saved by /save-all flush (the baseline) equals the live one (save #${s.saves})`, { saved: l, live: live.ledger });
    return { ledger: l, saves: s.saves };
  }

  /**
   * Fed until built, 12 s for the eager chunk saves (vanilla saves a changed chunk 10 s after its last save), then the halt at `point`
   * by `go()`, nothing saved (unless `saveLedger`: the ledger alone saved just before, by a feed-order change). Returns the numbers.
   */
  async function crash(tag, W, region, b0, point, go, { saveLedger = false } = {}) {
    const f = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: fed until built (${f.waves} waves): ${f.last.st.view.state}`);
    if (!saveLedger) await call('dev.wait', { ms: 12_000 }, 60_000);
    const live = await pile();
    const s1 = await savedNow();
    if (saveLedger) await call('dev.stockpile.order', { owner: G.OWNER, ids: [] }, 60_000);
    const s2 = await savedNow();
    const autosaved = s1.saves !== b0.saves;
    const n = { tag, point, saveLedger, autosaved, savesAtBaseline: b0.saves, savesBeforeKill: s1.saves, savesAtKill: s2.saves };
    await call('dev.journal.killAt', { point }, 10_000);
    go();
    const down = await haltWait();
    check(down, `${tag}: the kill point ${point} halted the server (nothing saved)`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); return null; }
    // the saved state, off the disk before the restart (the restart resumes the undo at once)
    const disk = JSON.parse(fs.readFileSync(path.join(W.dir, 'architect', 'stockpiles.json'), 'utf8'));
    const Ld = ledgerOf(disk);
    await L.openWorld(path.basename(W.dir));
    await L.tp(CX + 80, 60, CZ + 56);
    return { n, live, Ld, b0, f };
  }

  /** The numbers and the judgement: back = what entered the stock (with overflow) after the restart; owed = what the saved ledger consumed. */
  function judge(tag, c, after, extra = {}) {
    const { n, live, Ld, b0 } = c;
    const La = after.ledger ?? {};
    const consumedLive = G.minus(live.ledger?.consumed, b0.ledger.consumed);
    const consumedSaved = G.minus(Ld.consumed, b0.ledger.consumed);
    const back = G.minus(backOf(La), backOf(Ld));
    const refundKeyed = G.minus(G.plus(La.returned, La.refundOverflow), G.plus(Ld.returned, Ld.refundOverflow));
    const mint = G.minus(back, consumedSaved);
    const o = { ...n, consumedLive, consumedSaved, back, refundKeyed, mint, mintUnits: sum(Object.fromEntries(Object.entries(mint).filter(([, v]) => v > 0))),
      lossUnits: -sum(Object.fromEntries(Object.entries(mint).filter(([, v]) => v < 0))), savedLedger: Ld, after: La, identity: after.identity, ...extra };
    log(`  ${tag}: consumed live ${json(consumedLive)}; consumed in the saved ledger ${json(consumedSaved)}; back ${json(back)}; back - saved ${json(mint)}`);
    check(G.same(back, consumedSaved) && after.identity !== false, `${tag}: items in = items out against the saved state: what came back ${json(back)} equals what the saved ledger says the undone targets consumed ${json(consumedSaved)} (minted ${o.mintUnits}, lost ${o.lossUnits}; live before the halt they had consumed ${sum(consumedLive)}; identity ${after.identity})`, o);
    return o;
  }

  steps.jrcrash = async () => {
    await ensure();
    const out = {};

    // K5: a plain survival region removal (no revision), halted at its commit point
    {
      const tag = 'K5';
      const W = await world('G6B JR K5');
      const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
      const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
      const S0 = await cellsOf(W.BOX);
      const b0 = await baseline(tag);
      const c = await crash(tag, W, region, b0, 'K5', () => call('dev.region.remove', { region, requester: G.OWNER }, 3_600_000).catch(() => null));
      if (c) {
        for (let i = 0; i < 900; i++) {
          const st = await call('dev.region.state', { region }, 60_000).catch(() => null);
          if (!st?.view?.state || ['REMOVED', 'PARTIAL', 'FAILED'].includes(st.view.state)) break;
          await L.sleep(2000);
        }
        await L.settle(3000);
        const after = await pile();
        const d = diff(S0, await cellsOf(W.BOX));
        out[tag] = judge(tag, c, after, { worldDiff: d.n });
      }
      await L.leaveWorld();
    }

    // RVU2 (and RVU2s): a survival growth's undo, halted after the drain with nothing removed
    for (const [tag, saveLedger] of [['RVU2', false], ['RVU2s', true]]) {
      const W = await world(`G6B JR ${tag}`);
      const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
      const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
      const f0 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
      check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `${tag}: the town built in survival (${f0.waves} waves)`);
      const S0 = await cellsOf(W.BOX);
      const g = await growPlan(region, { lots: [{ id: 'qa', type: 'house', size: [9, 9], villager: 'dwelling' }] });
      check(!g.refused && g.revisionOf?.rid >= 1, `${tag}: a growth planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
      if (g.refused) { await L.leaveWorld(); continue; }
      const r = await call('dev.region.realise', { planId: g.planId, lots: { qa: 'rs_hut' } }, 300_000);
      check(!r.refused, `${tag}: the growth realised (qa: rs_hut): ${r.refused ?? r.region}`);
      const rid = g.revisionOf.rid;
      const t0 = new Set((f0.last.rs?.targets ?? []).map((x) => x.id));
      for (let i = 0; i < 90; i++) {
        const sv = await rvState(region);
        const rs = await G.rsState(ctx, region);
        if ((rs.targets ?? []).some((x) => !t0.has(x.id)) || sv.revisions?.find((x) => x.rid === rid)?.state !== 'ACCEPTED') break;
        await L.sleep(2000);
      }
      const b0 = await baseline(tag);
      const c = await crash(tag, W, region, b0, 'RVU2', () => call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000).catch(() => null), { saveLedger });
      if (c) {
        let st;
        const t1 = Date.now();
        for (; Date.now() - t1 < 1_800_000;) { st = await rvState(region); if (st.busy === null) break; await L.sleep(L.pollDelayMs(Date.now() - t1)); }
        await L.settle(3000);
        const after = await pile();
        const d = diff(S0, await cellsOf(W.BOX));
        out[tag] = judge(tag, c, after, { worldDiff: d.n, position: st?.position, states: st?.revisions?.map((x) => [x.rid, x.state]) });
        check(st?.busy === null && st.position === 0 && d.n === 0, `${tag}: the undo resumed after the restart and finished: position ${st?.position}; the world before the growth (${d.n} differ)`, d.first);
      }
      await L.leaveWorld();
    }
    spendZero();
    return out;
  };
}
