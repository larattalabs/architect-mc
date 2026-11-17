// Slice LCAP gate (docs/CONTRACT.md "Slice LCAP"; Steward's ask S-M5-16): a per-lot bill cap on realiseApproved (maxBillPerLot) beside
// maxBill. Registered into tools/gate6dgr.mjs (GR's survival town helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs lcapsurvival  (lcap-survival)  one survival world: a plan/0 town of 2 lots (la, lb) both bound to rs_hut (they
//                                                         share every item, oak planks the most), checked in survival and quoted
//                                                         (quoteApproved: each lot's bill = its lot:, fill:, mech: pieces); then
//     U    realiseApproved naming an unknown lot: refused BILL_CAP (detail unknown_lot:zz), nothing written or consumed
//     O    realiseApproved with lb's cap one plank under its bill (la at its bill, maxBill the whole quote): refused BILL_CAP (detail
//          lot:lb, the message names oak_planks and the bill against the cap); 0 cells differ, nothing consumed, no region
//     K    realiseApproved under both caps (maxBill = the quote + 64 planks of room, la and lb at their bills), the JVM halted at RG2 (the
//          region record saved, no tile started): after the restart every cap is read back (maxBill, la's, lb's)
//     H    lb's lot cap lowered 20 planks under its bill (dev.bc.cap lot): fed in full, la is built while lb waits bill_cap (its planks
//          drawn stop at the lowered cap; the region's maxBill still has room, so only the lot cap holds it)
//     C    a halt with nothing saved since the flush, the restart: the lowered lot cap kept and still enforced (lb held, drawn no more)
//     R    lb's cap back at its bill: PLACED, every target built, each lot's draws within its own cap, no overshoot
//          items in = items out over the whole case (the audit's identity; inserted = consumed + stock)
//
// Evidence: artifacts/gate6d-gr/lcapsurvival.json (GATE6DGR_OUT), all.log, spend.json ($0.00).

export async function registerLCAP(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, BOXOF, cellsOf, diff, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const PL = 'minecraft:oak_planks';
  const ENTRY = 'rs_hut';
  const CLAIM = [CX, CZ, CX + 159, CZ + 111];
  const LOT = (id) => ({ id, type: 'house', size: [9, 9] });
  const PLAN = { schemaVersion: 'plan/0', planId: 'lcap_town', zones: [{ id: 'town', program: { lots: [LOT('la'), LOT('lb')] }, where: { near: { anchor: 'claim_center', within: 8 } } }] };
  const ENTRIES = { la: ENTRY, lb: ENTRY };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const audit = async () => call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
  const cap = async (region, lot, set) => call('dev.bc.cap', { region, rid: 0, ...(lot ? { lot } : {}), ...(set ? { set } : {}) }, 30_000);
  /** Quote.lotBill: a lot's lot:, fill: and mech: pieces summed. */
  const lotBill = (parts, lot) => {
    const out = {};
    for (const p of ['lot:', 'fill:', 'mech:']) for (const [k, v] of Object.entries(parts?.[p + lot] ?? {})) out[k] = (out[k] ?? 0) + v;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  const approve = (sha, extra) => call('dev.region.realiseApproved', { sha, lotEntries: ENTRIES, ...extra }, 300_000);
  let inserted = {};
  const addIn = (m) => { for (const [k, v] of Object.entries(m ?? {})) inserted[k] = (inserted[k] ?? 0) + v; };

  /** One feed wave: what the owner's targets lack, less stock. */
  async function wave() {
    const ps = await pile();
    const need = {};
    for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
    if (!Object.keys(need).length) return 0;
    const r = await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000);
    addIn(r.accepted ?? need);
    return 1;
  }
  /** The region's targets by lot (dev.bc.cap's rows) with their done flag (dev.rs.state). */
  async function targets(region) {
    const c = await cap(region);
    const rs = await G.rsState(ctx, region);
    const done = new Map((rs.targets ?? []).map((t) => [t.id, t.done === true]));
    return (c.targets ?? []).map((t) => ({ ...t, done: done.get(t.id) }));
  }
  async function feedUntil(region, until, ms) {
    const end = Date.now() + ms;
    let waves = 0;
    while (Date.now() < end) {
      const ts = await targets(region);
      if (await until(ts)) return { done: true, waves, ts };
      waves += await wave();
      await L.sleep(3000);
    }
    return { done: false, waves, ts: await targets(region) };
  }
  const lotHeld = (ts, lot) => ts.some((t) => t.lot === lot && t.blocked === 'bill_cap');
  const lotDone = (ts, lot) => ts.some((t) => t.lot === lot) && ts.filter((t) => t.lot === lot).every((t) => t.done === true);
  async function restart(name) {
    check(await haltWait(), `${name}: halted`);
    await L.openWorld(name);
    await L.tp(CX + 80, 80, CZ + 56);
    await L.settle(4000);
  }

  steps.lcapsurvival = async () => {
    await ensure();
    const out = {};
    const name = 'G6B LCAP survival';
    await G.survivalBase(ctx);
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    check(!(await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000)).refused, `${name}: a stockpile of 4 crates`);
    const vf = (await call('dev.api.versions', {}, 30_000)).features ?? [];
    check(vf.includes('maxBillPerLot'), `the feature maxBillPerLot is advertised (${json(vf)})`);
    const ck = (await call('dev.region.checkPlan', { plan: PLAN, claim: CLAIM, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
    check(ck?.survival === true && ck.overall === 'READY' && !!ck.artifactSha, `the town of 2 lots checked in survival: ${ck?.overall}`);
    if (!ck?.artifactSha) { spendZero(); return out; }
    const sha = ck.artifactSha;
    const q = await call('dev.region.quote', { sha, lotEntries: ENTRIES }, 300_000);
    const bA = lotBill(q.bomParts, 'la'), bB = lotBill(q.bomParts, 'lb');
    out.quote = { bom: q.bom, exact: q.exact, la: bA, lb: bB };
    check((bA[PL] ?? 0) >= 21 && (bB[PL] ?? 0) >= 21 && sum(q.bom) > sum(bA) + sum(bB) - 1,
      `quoteApproved: la's bill ${sum(bA)} (${bA[PL]} planks), lb's ${sum(bB)} (${bB[PL]} planks): the two lots share oak planks; the whole bill ${sum(q.bom)} (exact ${q.exact})`, out.quote);
    const B0 = await cellsOf(BOX);
    const p0 = await pile();
    const c0 = p0.ledger?.consumed ?? {}, r0 = p0.ledger?.returned ?? {};
    // U: an unknown lot
    const u = await approve(sha, { maxBill: q.bom, maxBillPerLot: { la: bA, zz: {} } });
    out.U = u;
    check(u.reason === 'BILL_CAP' && u.detail === 'unknown_lot:zz', `U: a lot cap naming an unknown lot is refused BILL_CAP, detail ${u.detail} (${u.refused ?? 'accepted'})`, u);
    // O: lb one plank under its own bill: refused before any write
    const under = { ...bB, [PL]: bB[PL] - 1 };
    const o = await approve(sha, { maxBill: q.bom, maxBillPerLot: { la: bA, lb: under } });
    const d0 = diff(B0, await cellsOf(BOX));
    const c1 = (await pile()).ledger?.consumed ?? {};
    const regions0 = (await call('dev.region.list')).regions ?? [];
    out.O = { o, differ: d0.n, consumed: G.minus(c1, c0), regions: regions0.length };
    check(o.reason === 'BILL_CAP' && o.detail === 'lot:lb' && /lot lb/.test(String(o.refused)) && new RegExp(`oak_planks ${bB[PL]} > ${bB[PL] - 1}`).test(String(o.refused)),
      `O: lb's cap one plank under its bill: refused BILL_CAP, detail ${o.detail}: ${o.refused ?? 'accepted'}`, o);
    check(d0.n === 0 && sum(G.minus(c1, c0)) === 0 && regions0.length === 0, `O: before any write: ${d0.n} cells differ, ${sum(G.minus(c1, c0))} consumed, ${regions0.length} region(s)`, out.O);
    if (!o.refused) { spendZero(); return out; }
    // K: accepted under both caps; the JVM halted at RG2 (the record saved, no tile started)
    const room = { ...q.bom, [PL]: (q.bom[PL] ?? 0) + 64 };
    const lots = { la: bA, lb: bB };
    await cmd('/save-all flush').catch(() => null);
    await call('dev.journal.killAt', { point: 'RG2' });
    const k = await approve(sha, { maxBill: room, maxBillPerLot: lots }).catch((e) => ({ refused: String(e) }));
    log(`K: realiseApproved under both caps, armed RG2: ${json(k).slice(0, 300)}`);
    await restart(name);
    const region = ((await call('dev.region.list')).regions ?? [])[0]?.id;
    check(!!region, `K: the region stands after the RG2 halt (${region})`);
    if (!region) { spendZero(); return out; }
    const kA = await cap(region, 'la'), kB = await cap(region, 'lb');
    out.K = { region, maxBill: kA.maxBill, la: kA.lotCap?.maxBill, lb: kB.lotCap?.maxBill, caps: kA.caps };
    check(G.same(kA.maxBill, room) && G.same(kA.lotCap?.maxBill, bA) && G.same(kB.lotCap?.maxBill, bB),
      `K: after the RG2 halt and restart the caps are read back: maxBill ${sum(kA.maxBill)}, la ${sum(kA.lotCap?.maxBill)}, lb ${sum(kB.lotCap?.maxBill)}`, out.K);
    // H: lb's lot cap lowered 20 planks under its bill: la builds, lb waits bill_cap; the region cap has room
    const low = { ...bB, [PL]: bB[PL] - 20 };
    await cap(region, 'lb', low);
    const f1 = await feedUntil(region, async (ts) => lotDone(ts, 'la') && lotHeld(ts, 'lb'), 1_800_000);
    const hA = await cap(region, 'la'), hB = await cap(region, 'lb');
    out.H = { f1: { done: f1.done, waves: f1.waves }, laDrawn: hA.lotCap?.drawn, lbDrawn: hB.lotCap?.drawn, regionDrawn: hA.drawn, lbRow: f1.ts.filter((t) => t.lot === 'lb') };
    check(f1.done && (hB.lotCap?.drawn?.[PL] ?? 0) <= low[PL] && (hA.drawn?.[PL] ?? 0) < room[PL] && Object.keys(hA.overshoot ?? {}).length === 0,
      `H: lb's lot cap lowered to ${low[PL]} planks: la built (drew ${hA.lotCap?.drawn?.[PL]} planks), lb waits bill_cap (drew ${hB.lotCap?.drawn?.[PL]}); the region's maxBill still has room (${hA.drawn?.[PL]} of ${room[PL]} planks)`, out.H);
    // C: a halt with nothing saved since the flush; the lowered lot cap kept and enforced
    await cmd('/save-all flush').catch(() => null);
    call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    await restart(name);
    const r1 = await cap(region, 'lb');
    const f2 = await feedUntil(region, async () => false, 60_000);
    const r2 = await cap(region, 'lb');
    out.C = { cap: r1.lotCap?.maxBill, drawn: r2.lotCap?.drawn, held: lotHeld(f2.ts, 'lb') };
    check(G.same(r1.lotCap?.maxBill, low) && lotHeld(f2.ts, 'lb') && (r2.lotCap?.drawn?.[PL] ?? 0) <= low[PL],
      `C: after the halt and restart lb's lowered cap is kept (${r1.lotCap?.maxBill?.[PL]} planks) and enforced: lb still waits bill_cap, drew ${r2.lotCap?.drawn?.[PL]} planks after a minute of feeding`, out.C);
    // R: lb's cap back at its bill: built
    await cap(region, 'lb', bB);
    const f3 = await feedUntil(region, async (ts) => !ts.some((t) => t.blocked === 'bill_cap') && (await call('dev.region.state', { region }, 60_000)).view?.state === 'PLACED'
      && (await G.rsState(ctx, region)).build?.done === true, 1_800_000);
    const st = await call('dev.region.state', { region }, 60_000);
    const eA = await cap(region, 'la'), eB = await cap(region, 'lb');
    out.R = { done: f3.done, state: st.view?.state, la: eA.lotCap, lb: eB.lotCap, overshoot: eA.overshoot };
    check(f3.done && st.view?.state === 'PLACED' && Object.keys(eA.lotCap?.overshoot ?? {}).length === 0 && Object.keys(eB.lotCap?.overshoot ?? {}).length === 0
      && Object.keys(eA.overshoot ?? {}).length === 0,
      `R: lb's cap back at its bill: ${st.view?.state}, build done; la drew ${sum(eA.lotCap?.drawn)} of ${sum(bA)}, lb ${sum(eB.lotCap?.drawn)} of ${sum(bB)}; no overshoot`, out.R);
    // items in = items out
    const a1 = await audit();
    const ps = await pile();
    const used = G.minus(ps.ledger?.consumed ?? {}, c0);
    const back = G.minus(ps.ledger?.returned ?? {}, r0);
    const left = G.minus(G.minus(inserted, used), G.minus(ps.stock ?? {}, back));
    out.identity = { audit: a1.identity, inserted: sum(inserted), consumed: sum(used), returned: sum(back), stock: sum(ps.stock), unaccounted: left };
    check(a1.identity !== false && Object.values(left).every((v) => v === 0),
      `items in = items out: inserted ${sum(inserted)} + returned ${sum(back)} = consumed ${sum(used)} + stock ${sum(ps.stock)} (audit identity ${a1.identity}; unaccounted ${json(left)})`, out.identity);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
