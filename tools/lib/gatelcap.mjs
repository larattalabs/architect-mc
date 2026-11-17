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
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, BOXOF, cellsOf, diff, haltWait, rvState, rvWait } = h;
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
  const cap = async (region, lot, set, rid = 0) => call('dev.bc.cap', { region, rid, ...(lot ? { lot } : {}), ...(set ? { set } : {}) }, 30_000);
  /** Quote.lotBill: a lot's lot:, fill: and mech: pieces summed. */
  const lotBill = (parts, lot) => {
    const out = {};
    for (const p of ['lot:', 'fill:', 'mech:']) for (const [k, v] of Object.entries(parts?.[p + lot] ?? {})) out[k] = (out[k] ?? 0) + v;
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  const approve = (sha, extra, entries = ENTRIES) => call('dev.region.realiseApproved', { sha, lotEntries: entries, ...extra }, 300_000);
  const GROWN = (parent) => ({ ...PLAN, zones: [{ ...PLAN.zones[0], program: { lots: [LOT('la'), LOT('lb'), LOT('lc'), LOT('ld')] } }], revision: { n: 1, parentArtifact: parent } });
  const ENTRIES2 = { lc: ENTRY, ld: ENTRY };
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
  /** The region's targets (dev.bc.cap's rows); a lot's site with its construction state (dev.site.state: 'built' when done). */
  async function targets(region, rid = 0) {
    const c = await cap(region, null, null, rid);
    const out = [];
    for (const t of c.targets ?? []) {
      const st = t.lot ? await call('dev.site.state', { site: t.id }, 60_000).catch(() => null) : null;
      out.push({ ...t, state: st?.state ?? null, done: st?.state === 'built' });
    }
    return out;
  }
  async function feedUntil(region, until, ms, rid = 0) {
    const end = Date.now() + ms;
    let waves = 0;
    while (Date.now() < end) {
      const ts = await targets(region, rid);
      if (await until(ts)) return { done: true, waves, ts };
      waves += await wave();
      await L.sleep(3000);
    }
    return { done: false, waves, ts: await targets(region, rid) };
  }
  const scopeOf = (ts, lot) => ts.find((t) => t.lot === lot && t.blocked === 'bill_cap')?.capScope ?? null;
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
    if (!u.refused) { spendZero(); return out; } // accepted (no lot caps): the rest would realise over this region
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
    // F1 (rule 17, the review's P1): the region record's save fails: refused before any write, nothing queued
    await call('dev.region.failNextSave', { file: 'region.json' }, 10_000);
    const f1r = await approve(sha, { maxBill: q.bom, maxBillPerLot: { la: bA, lb: bB } });
    await call('dev.region.failNextSave', { off: true }, 10_000).catch(() => null);
    const dF = diff(B0, await cellsOf(BOX));
    const cF = (await pile()).ledger?.consumed ?? {};
    const regionsF = (await call('dev.region.list')).regions ?? [];
    out.F1 = { r: f1r, differ: dF.n, consumed: G.minus(cF, c0), regions: regionsF.length };
    check(f1r.reason === 'JOURNAL_UNAVAILABLE' && f1r.detail === 'region_record' && dF.n === 0 && sum(G.minus(cF, c0)) === 0 && regionsF.length === 0,
      `F1: the record's save failed (injected): refused ${f1r.reason ?? 'accepted'} (detail ${f1r.detail}); ${dF.n} cells differ, ${sum(G.minus(cF, c0))} consumed, ${regionsF.length} region(s)`, out.F1);
    if (!f1r.refused) { spendZero(); return out; }
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
    out.H = { f1: { done: f1.done, waves: f1.waves }, laDrawn: hA.lotCap?.drawn, lbDrawn: hB.lotCap?.drawn, regionDrawn: hA.drawn, lots: f1.ts.filter((t) => t.lot), capScope: scopeOf(f1.ts, 'lb') };
    check(f1.done && (hB.lotCap?.drawn?.[PL] ?? 0) <= low[PL] && (hA.drawn?.[PL] ?? 0) < room[PL] && Object.keys(hA.overshoot ?? {}).length === 0 && out.H.capScope === 'lot:lb',
      `H: lb's lot cap lowered to ${low[PL]} planks: la built (drew ${hA.lotCap?.drawn?.[PL]} planks), lb waits bill_cap (drew ${hB.lotCap?.drawn?.[PL]}; capScope ${out.H.capScope}); the region's maxBill still has room (${hA.drawn?.[PL]} of ${room[PL]} planks)`, out.H);
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
    // V: a revision (rid > 0) adding lc and ld (both rs_hut) with lot caps, through checkPlan and realiseApproved (Steward's LCAP-Q2)
    const ck2 = (await call('dev.region.checkPlan', { plan: GROWN(sha), claim: CLAIM, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
    check(ck2?.survival === true && ck2.overall === 'READY' && !!ck2.artifactSha, `V: the growth (lc, ld) checked in survival: ${ck2?.overall}`);
    if (!ck2?.artifactSha) { spendZero(); return out; }
    const sha2 = ck2.artifactSha;
    const q2 = await call('dev.region.quote', { sha: sha2, lotEntries: ENTRIES2 }, 300_000);
    const bC = lotBill(q2.bomParts, 'lc'), bD = lotBill(q2.bomParts, 'ld');
    const room2 = { ...q2.bom, [PL]: (q2.bom[PL] ?? 0) + 64 };
    const head0 = (await rvState(region)).headRid;
    const S1 = await cellsOf(BOX);
    const p1 = await pile();
    // V1: a town lot (la, rid 0's) named on the revision: unknown to it
    const v1 = await approve(sha2, { maxBill: room2, maxBillPerLot: { la: bA, lc: bC } }, ENTRIES2);
    check(v1.reason === 'BILL_CAP' && v1.detail === 'unknown_lot:la', `V1: a revision's lot caps cover its own lots: la refused BILL_CAP, detail ${v1.detail} (${v1.refused ?? 'accepted'})`, v1);
    // V2 (rule 17): the revision's publication save fails: refused, the head unchanged, nothing written or consumed
    await call('dev.region.failNextSave', { file: 'region.json' }, 10_000);
    const v2 = await approve(sha2, { maxBill: room2, maxBillPerLot: { lc: bC, ld: bD } }, ENTRIES2);
    await call('dev.region.failNextSave', { off: true }, 10_000).catch(() => null);
    const sv2 = await rvState(region);
    const dV = diff(S1, await cellsOf(BOX));
    const cV = G.minus((await pile()).ledger?.consumed ?? {}, p1.ledger?.consumed ?? {});
    out.V2 = { r: v2, head: sv2.headRid, busy: sv2.busy, differ: dV.n, consumed: cV };
    check(v2.reason === 'JOURNAL_UNAVAILABLE' && v2.detail === 'region_record' && sv2.headRid === head0 && sv2.busy === null && dV.n === 0 && sum(cV) === 0,
      `V2: the revision's record save failed (injected): refused ${v2.reason ?? 'accepted'} (detail ${v2.detail}); head ${sv2.headRid} (was ${head0}), busy ${sv2.busy}, ${dV.n} cells differ, ${sum(cV)} consumed`, out.V2);
    if (!v2.refused) { spendZero(); return out; }
    // V3: accepted under both caps, the JVM halted at RV3 (the record published, nothing installed); after the restart its caps read back
    await cmd('/save-all flush').catch(() => null);
    await call('dev.journal.killAt', { point: 'RV3' });
    const v3 = await approve(sha2, { maxBill: room2, maxBillPerLot: { lc: bC, ld: bD } }, ENTRIES2).catch((e) => ({ refused: String(e) }));
    log(`V3: the growth realised under both caps, armed RV3: ${json(v3).slice(0, 300)}`);
    await restart(name);
    const sv3 = await rvState(region);
    const rid = sv3.headRid;
    const vC = await cap(region, 'lc', null, rid), vD = await cap(region, 'ld', null, rid);
    out.V3 = { rid, head0, maxBill: vC.maxBill, lc: vC.lotCap?.maxBill, ld: vD.lotCap?.maxBill };
    check(rid > head0 && rid >= 1 && G.same(vC.maxBill, room2) && G.same(vC.lotCap?.maxBill, bC) && G.same(vD.lotCap?.maxBill, bD) && (await cap(region, 'la')).lotCap?.maxBill != null,
      `V3: after the RV3 halt and restart revision ${rid}'s caps are read back (maxBill ${sum(vC.maxBill)}, lc ${sum(vC.lotCap?.maxBill)}, ld ${sum(vD.lotCap?.maxBill)}); rid 0's la cap kept`, out.V3);
    // V4: ld's cap lowered: lc built, ld held by its own lot cap (capScope lot:ld)
    const lowD = { ...bD, [PL]: bD[PL] - 20 };
    await cap(region, 'ld', lowD, rid);
    const fv = await feedUntil(region, async (ts) => lotDone(ts, 'lc') && lotHeld(ts, 'ld'), 1_800_000, rid);
    const wD = await cap(region, 'ld', null, rid);
    out.V4 = { done: fv.done, ldDrawn: wD.lotCap?.drawn, capScope: scopeOf(fv.ts, 'ld') };
    check(fv.done && (wD.lotCap?.drawn?.[PL] ?? 0) <= lowD[PL] && out.V4.capScope === 'lot:ld',
      `V4: revision ${rid}: ld's cap lowered to ${lowD[PL]} planks: lc built, ld waits bill_cap (drew ${wD.lotCap?.drawn?.[PL]}, capScope ${out.V4.capScope})`, out.V4);
    // V5: a halt with nothing saved: the revision's lowered lot cap kept and enforced
    await cmd('/save-all flush').catch(() => null);
    call('dev.stockpile.halt', { mode: 'now' }, 10_000).catch(() => null);
    await restart(name);
    const fv2 = await feedUntil(region, async () => false, 60_000, rid);
    const wD2 = await cap(region, 'ld', null, rid);
    out.V5 = { cap: wD2.lotCap?.maxBill, drawn: wD2.lotCap?.drawn, held: lotHeld(fv2.ts, 'ld') };
    check(G.same(wD2.lotCap?.maxBill, lowD) && out.V5.held && (wD2.lotCap?.drawn?.[PL] ?? 0) <= lowD[PL],
      `V5: after the halt and restart revision ${rid}'s lowered ld cap is kept (${wD2.lotCap?.maxBill?.[PL]} planks) and enforced: ld still waits, drew ${wD2.lotCap?.drawn?.[PL]}`, out.V5);
    // V6: restored: the revision PLACED, no overshoot
    await cap(region, 'ld', bD, rid);
    const fv3 = await feedUntil(region, async (ts) => !ts.some((t) => t.blocked === 'bill_cap') && (await rvState(region)).revisions?.find((x) => x.rid === rid)?.state === 'PLACED'
      && (await G.rsState(ctx, region)).build?.done === true, 1_800_000, rid);
    const eC = await cap(region, 'lc', null, rid), eD = await cap(region, 'ld', null, rid);
    out.V6 = { done: fv3.done, lc: eC.lotCap, ld: eD.lotCap };
    check(fv3.done && Object.keys(eC.lotCap?.overshoot ?? {}).length === 0 && Object.keys(eD.lotCap?.overshoot ?? {}).length === 0 && Object.keys(eC.overshoot ?? {}).length === 0,
      `V6: ld's cap back at its bill: revision ${rid} PLACED, build done; lc drew ${sum(eC.lotCap?.drawn)} of ${sum(bC)}, ld ${sum(eD.lotCap?.drawn)} of ${sum(bD)}; no overshoot`, out.V6);
    // items in = items out
    const a1 = await audit();
    const ps = await pile();
    const used = G.minus(ps.ledger?.consumed ?? {}, c0);
    const back = G.minus(ps.ledger?.returned ?? {}, r0);
    const left = G.minus(G.minus(inserted, used), G.minus(ps.stock ?? {}, back));
    out.identity = { audit: a1.identity, inserted: sum(inserted), consumed: sum(used), returned: sum(back), stock: sum(ps.stock), unaccounted: left };
    check(a1.identity !== false && Object.values(left).every((v) => v === 0),
      `items in = items out: inserted ${sum(inserted)} + returned ${sum(back)} = consumed ${sum(used)} + stock ${sum(ps.stock)} (audit identity ${a1.identity}; unaccounted ${json(left)})`, out.identity);
    // Z (RG2a, the fix round's P1): a crash between the record save and the queue save; a restart; another build; then the orphan record
    // removed: the other build is untouched (its ids are its own, and the removal cancels only the orphan's own work) and builds
    await L.leaveWorld();
    out.Z = await rg2a();
    await L.leaveWorld();
    spendZero();
    return out;
  };

  async function rg2a() {
    const nameZ = 'G6B LCAP RG2a';
    const o = {};
    inserted = {};
    await L.fresh(nameZ, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    check(!(await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000)).refused, `Z: a stockpile of 4 crates in ${nameZ}`);
    const ckA = (await call('dev.region.checkPlan', { plan: PLAN, claim: CLAIM, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
    check(!!ckA?.artifactSha, `Z: town A checked (${ckA?.overall})`);
    if (!ckA?.artifactSha) return o;
    await cmd('/save-all flush').catch(() => null);
    await call('dev.journal.killAt', { point: 'RG2a' });
    const ka = await approve(ckA.artifactSha, {}).catch((e) => ({ refused: String(e) }));
    log(`Z: town A realised, armed RG2a: ${json(ka).slice(0, 200)}`);
    await restart(nameZ);
    const orphan = ((await call('dev.region.list')).regions ?? [])[0]?.id;
    const recO = orphan ? (await call('dev.region.state', { region: orphan }, 60_000)).record : null;
    o.orphan = { id: orphan, batchId: recO?.batchId, groupId: recO?.groupId, state: recO?.state };
    check(!!orphan && !!recO?.batchId, `Z: after the RG2a halt the record stands with no batch queued: ${orphan} (batch ${recO?.batchId}, group ${recO?.groupId})`, o.orphan);
    if (!orphan) return o;
    // town B, beside A's claim, a plain survival realise
    const CLAIM2 = [CX + 200, CZ, CX + 359, CZ + 111];
    const ckB = (await call('dev.region.checkPlan', { plan: { ...PLAN, planId: 'lcap_town_b' }, claim: CLAIM2, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
    const rB = ckB?.artifactSha ? await approve(ckB.artifactSha, {}) : { refused: `no artifact (${ckB?.overall})` };
    const regionB = rB.region;
    const recB = regionB ? (await call('dev.region.state', { region: regionB }, 60_000)).record : null;
    o.B = { region: regionB, refused: rB.refused, batchId: recB?.batchId, groupId: recB?.groupId };
    check(!!regionB && recB?.batchId !== recO.batchId && recB?.groupId !== recO.groupId,
      `Z: town B realised (${regionB ?? rB.refused}) with ids of its own: batch ${recB?.batchId} (orphan ${recO.batchId}), group ${recB?.groupId} (orphan ${recO.groupId})`, o.B);
    if (!regionB) return o;
    // the orphan removed
    const rm = await call('dev.region.remove', { region: orphan }, 600_000).catch((e) => ({ refused: String(e) }));
    let gone = false;
    for (let i = 0; i < 60 && !gone; i++) { gone = !((await call('dev.region.list')).regions ?? []).some((r) => r.id === orphan); if (!gone) await L.sleep(2000); }
    const stB = await call('dev.region.state', { region: regionB }, 60_000);
    o.remove = { rm, gone, bMissing: stB.missing === true, bState: stB.record?.state, bQueue: stB.queue ?? null };
    check(gone && stB.missing !== true && stB.record?.state === 'PLACING', `Z: the orphan ${orphan} removed (${gone}); town B untouched: ${stB.missing ? 'missing' : stB.record?.state}`, o.remove);
    // town B builds to the end
    await L.tp(CX + 280, 80, CZ + 56);
    let st = null;
    const end = Date.now() + 1_800_000;
    while (Date.now() < end) {
      st = await call('dev.region.state', { region: regionB }, 60_000);
      if (st.view?.state === 'PLACED' && (await G.rsState(ctx, regionB)).build?.done === true) break;
      await wave();
      await L.sleep(3000);
    }
    o.B.end = st?.view?.state;
    check(st?.view?.state === 'PLACED', `Z: town B built after the orphan's removal: ${st?.view?.state}`, o.B);
    const az = await audit();
    const pz = await pile();
    const left = G.minus(G.minus(G.plus(inserted, pz.ledger?.returned ?? {}), pz.ledger?.consumed ?? {}), pz.stock ?? {});
    o.identity = { audit: az.identity, inserted: sum(inserted), consumed: sum(pz.ledger?.consumed), stock: sum(pz.stock), unaccounted: left };
    check(az.identity !== false && Object.keys(left).length === 0, `Z: items in = items out: inserted ${sum(inserted)} = consumed ${sum(pz.ledger?.consumed)} + stock ${sum(pz.stock)} (audit identity ${az.identity}; unaccounted ${json(left)})`, o.identity);
    return o;
  }
}
