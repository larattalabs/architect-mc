// Slice BC-d gate (docs/CONTRACT.md "Slice BC-c/BC-d as built"; Steward's ask BC-d, S-BC-d-1/2): a maxBill covers only the realise or
// revision it came with. Registered into tools/gate6dgr.mjs (GR's survival town and growth helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs bcdgrow  (bcd-grow)  one survival world: a flat_village town realised under its quote as maxBill (rid 0's
//                                               cap) and fed until built; then
//                                               G1  a growth (qa: rs_hut) under its own quote as maxBill: fed until built, its draws =
//                                                   its quote, within its own cap (rid 1); the town's cap unchanged
//                                                   a halt with nothing saved since the last flush, the restart: both caps kept
//                                               G2  a plain growth (qb: rs_hut, maxBill null): uncapped (no cap of its rid), fed in full it is
//                                                   built and no target ever waits bill_cap (0.72.0: held to G1's spent cap)
//                                               G3  a capped growth (qc) whose cap is lowered (dev.bc.cap rid 3) below its planks: its target
//                                                   waits bill_cap; a second capped growth realised meanwhile is refused (one survival growth builds
//                                                   at a time: two capped revisions are never in flight); undoRevision to position 2: its
//                                                   refund = what it consumed; G1's and the town's caps unchanged
//                                               G4  a plain growth after the undo: uncapped, built
//                                               items in = items out over the whole case
//
// Evidence: artifacts/gate6d-gr/bcdgrow.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';

export async function registerBCD(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, growPlan, rvState, rvWait, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const audit = async () => call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const PL = 'minecraft:oak_planks';
  const cap = async (region, rid, set) => call('dev.bc.cap', { region, rid, ...(set ? { set } : {}) }, 30_000);

  /** Every lacking item fed in waves until `done()` or `ms` pass; returns whether done and any bill_cap target seen. */
  async function feedUntil(region, done, ms = 1_800_000, rid = null) {
    const end = Date.now() + ms;
    const held = new Set();
    let waves = 0;
    while (Date.now() < end) {
      if (await done()) return { done: true, held: [...held], waves };
      const ps = await pile();
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
      if (Object.keys(need).length) { await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000); waves++; }
      if (rid !== null) for (const t of (await cap(region, rid)).targets ?? []) if (t.blocked === 'bill_cap') held.add(`${t.id}@${t.rid}`);
      await L.sleep(3000);
    }
    return { done: false, held: [...held], waves };
  }
  // put down (PLACED) and every target of the region built (its lots and roads build after the batch ends)
  const placed = (region, rid) => async () => {
    const st = await rvState(region);
    return st.busy === null && st.revisions?.find((x) => x.rid === rid)?.state === 'PLACED' && (await G.rsState(ctx, region)).build?.done === true;
  };

  async function growth(tag, region, id, { capped }) {
    const g = await growPlan(region, { lots: [{ id, type: 'house', size: [9, 9], villager: 'dwelling' }] });
    check(!g.refused && g.revisionOf?.rid >= 1, `${tag}: a growth planned: ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    if (g.refused) return null;
    const lots = { [id]: 'rs_hut' };
    const q = await call('dev.region.quote', { planId: g.planId, lotEntries: lots }, 300_000);
    const r = await call('dev.region.realise', { planId: g.planId, lots, ...(capped ? { maxBill: q.bom } : {}) }, 300_000);
    check(!r.refused, `${tag}: realised ${capped ? 'under its quote as maxBill' : 'with no maxBill'} (${sum(q.bom)} units quoted): ${r.refused ?? r.region}`);
    return r.refused ? null : { rid: g.revisionOf.rid, quote: q.bom, planId: g.planId };
  }

  steps.bcdgrow = async () => {
    await ensure();
    const out = {};
    const name = 'G6B BCD grow';
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    check(!(await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000)).refused, `${name}: a stockpile of 4 crates`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const lots0 = { cottage_1: 'rs_hut' };
    const q0 = (await call('dev.region.quote', { planId: p0.planId, lotEntries: lots0 }, 300_000)).bom;
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: lots0, maxBill: q0 });
    const a0 = await audit();
    const f0 = await G.feed({ L }, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    const c0 = await cap(region, 0);
    out.town = { state: f0.last.st.view.state, cap: c0.maxBill, drawn: c0.drawn };
    check(f0.last.st.view.state === 'PLACED' && G.same(c0.maxBill, q0) && Object.keys(c0.overshoot ?? {}).length === 0, `town: built under its quote as rid 0's cap (drawn ${sum(c0.drawn)} of ${sum(q0)}, overshoot ${json(c0.overshoot)})`, out.town);
    // G1: capped, built within its own cap
    const g1 = await growth('G1', region, 'qa', { capped: true });
    if (!g1) { spendZero(); return out; }
    const f1 = await feedUntil(region, placed(region, g1.rid), 1_800_000, g1.rid);
    const c1 = await cap(region, g1.rid);
    out.G1 = { rid: g1.rid, f1, cap: c1.maxBill, drawn: c1.drawn, caps: Object.keys(c1.caps ?? {}) };
    check(f1.done && f1.held.length === 0 && G.same(c1.maxBill, g1.quote) && G.same(c1.drawn, g1.quote) && json(Object.keys(c1.caps ?? {})) === json(['0', String(g1.rid)]),
      `G1: built under its own cap (rid ${g1.rid}): drawn ${sum(c1.drawn)} = its quote ${sum(g1.quote)}${G.same(c1.drawn, g1.quote) ? '' : ` (over ${json(G.minus(c1.drawn, g1.quote))}, under ${json(G.minus(g1.quote, c1.drawn))})`}; caps ${json(Object.keys(c1.caps ?? {}))}; held ${json(f1.held)}`, out.G1);
    // a halt with nothing saved since the flush, the restart: both caps kept
    await cmd('/save-all flush').catch(() => null);
    call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    check(await haltWait(), 'restart: halted');
    await L.openWorld(name);
    await L.tp(CX + 80, 80, CZ + 56);
    await L.settle(4000);
    const r0 = await cap(region, 0), r1 = await cap(region, g1.rid);
    check(G.same(r0.maxBill, q0) && G.same(r1.maxBill, g1.quote) && G.same(r1.drawn, g1.quote), `restart: the town's and G1's caps kept, each its own (rid 0 ${sum(r0.maxBill)}, rid ${g1.rid} ${sum(r1.maxBill)}, drawn ${sum(r1.drawn)})`);
    // G2: plain: uncapped, built, never held
    const g2 = await growth('G2', region, 'qb', { capped: false });
    if (!g2) { spendZero(); return out; }
    const f2 = await feedUntil(region, placed(region, g2.rid), 1_800_000, g2.rid);
    const c2 = await cap(region, g2.rid);
    out.G2 = { rid: g2.rid, f2, cap: c2.maxBill, drawn: c2.drawn, caps: Object.keys(c2.caps ?? {}) };
    check(f2.done && f2.held.length === 0 && c2.maxBill == null && !Object.keys(c2.caps ?? {}).includes(String(g2.rid)) && sum(c2.drawn) > 0,
      `S-BC-d-1: G2 (no maxBill, rid ${g2.rid}) is uncapped: built in ${f2.waves} wave(s), drew ${sum(c2.drawn)} units freely (G1's cap spent: ${json(G.minus(r1.maxBill, r1.drawn))} left); no target held bill_cap (${json(f2.held)}); caps ${json(out.G2.caps)}`, out.G2);
    // G3: capped, its cap lowered: it waits bill_cap; a second growth meanwhile is refused; then undone
    const ps3 = await pile();
    const g3 = await growth('G3', region, 'qc', { capped: true });
    if (!g3) { spendZero(); return out; }
    const low = { ...g3.quote, [PL]: Math.max(0, (g3.quote[PL] ?? 0) - 20) };
    await cap(region, g3.rid, low);
    let held = null;
    const end = Date.now() + 900_000;
    while (Date.now() < end && !held) {
      await feedUntil(region, async () => false, 6000);
      held = ((await cap(region, g3.rid)).targets ?? []).find((t) => t.blocked === 'bill_cap' && t.rid === g3.rid) ?? null;
    }
    const c3 = await cap(region, g3.rid);
    const others = { r0: (await cap(region, 0)).maxBill, r1: (await cap(region, g1.rid)).maxBill };
    out.G3 = { rid: g3.rid, held, drawn: c3.drawn, low };
    check(!!held && (c3.drawn?.[PL] ?? 0) <= low[PL] && G.same(others.r0, q0) && G.same(others.r1, g1.quote) && (c3.targets ?? []).filter((t) => t.blocked === 'bill_cap').every((t) => t.rid === g3.rid),
      `G3 (rid ${g3.rid}): its own cap lowered to ${low[PL]} planks: ${held?.id} waits bill_cap (drawn ${c3.drawn?.[PL] ?? 0}); only its own targets held; the town's and G1's caps unchanged`, out.G3);
    const gx = await growPlan(region, { lots: [{ id: 'qx', type: 'house', size: [9, 9], villager: 'dwelling' }] });
    // a second capped growth while G3 builds: planned, but its realise is refused (survival_unfinished): never two revisions in flight
    let second = gx.refused ?? null;
    if (!gx.refused) {
      const gq = await call('dev.region.quote', { planId: gx.planId, lotEntries: { qx: 'rs_hut' } }, 300_000);
      const gr = await call('dev.region.realise', { planId: gx.planId, lots: { qx: 'rs_hut' }, maxBill: gq.bom }, 300_000);
      second = gr.refused ?? null;
    }
    out.G3.second = second;
    check(!!second && /survival_unfinished|OVERLAP_BUSY/.test(String(second)), `two revisions in flight: a second capped growth while G3 builds is refused (${second ?? 'accepted'}): never two capped revisions at once`);
    const u = await call('dev.rv.undo', { region, toPosition: 2 }, 4 * 3_600_000).catch((e) => ({ refused: String(e) }));
    let st;
    for (let i = 0; i < 300; i++) { st = await rvState(region); if (st.busy === null) break; await L.sleep(2000); }
    await L.settle(3000);
    const ps3b = await pile();
    const used3 = G.minus(ps3b.ledger?.consumed, ps3.ledger?.consumed);
    const back3 = G.minus(ps3b.ledger?.returned, ps3.ledger?.returned);
    out.G3.undo = { u: u?.refused ?? 'ok', state: st?.revisions?.find((x) => x.rid === g3.rid)?.state, used3, back3 };
    check(!u?.refused && st?.position === 2 && G.same(used3, back3), `G3 undone (position ${st?.position}, ${out.G3.undo.state}): its refund = what it consumed (${sum(back3)} = ${sum(used3)})`, out.G3.undo);
    // G4: plain after the undo: uncapped
    const g4 = await growth('G4', region, 'qd', { capped: false });
    if (!g4) { spendZero(); return out; }
    const f4 = await feedUntil(region, placed(region, g4.rid), 1_800_000, g4.rid);
    const c4 = await cap(region, g4.rid);
    out.G4 = { rid: g4.rid, f4, cap: c4.maxBill, drawn: c4.drawn };
    check(f4.done && f4.held.length === 0 && c4.maxBill == null, `G4 (no maxBill, rid ${g4.rid}) after the undo: uncapped, built (${f4.waves} wave(s)), held ${json(f4.held)}`, out.G4);
    const a1 = await audit();
    out.identity = a1.identity;
    check(a1.identity !== false, `items in = items out over the case (identity ${a1.identity}; consumed ${sum(G.minus(a1.ledger?.consumed, a0.ledger?.consumed))}, returned ${sum(G.minus(a1.ledger?.returned, a0.ledger?.returned))})`);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
