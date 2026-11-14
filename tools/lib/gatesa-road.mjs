// (slice SA, A3) A survival growth's new street: `sa-road` (registered on tools/gate6dgr.mjs as `saroad`; headless, survival; strict:
// survival accounting). IG made RegionTargets.roi read a revision's lot from its revision's IR; SA does the same for its roads: a plan/0
// revision's extension road is not in the base IR, so before SA it found no box, never waited, and in survival was put down over its
// stage's unbuilt tiles. The step: a survival V town fed until built; an extension growth (prefer extend, its lots pads) planned and
// quoted (its road's piece in the quote); realised with nothing fed: the road's item waits for its earlier stage's targets (ITEM_WAITING
// with waitsFor) before its put-down; fed until PLACED: what the stockpile consumed equals the quote item for item; undone: the world
// before the growth cell for cell, and what came back equals what was consumed. $0.
const TOWN_LOTS = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }, { id: 'cottage_2', type: 'cottage', size: [9, 9] }];
const ROW = Array.from({ length: 3 }, (_, i) => ({ id: `sa_row_${i + 1}`, type: 'house', size: [9, 9], villager: 'dwelling' }));

export async function registerSAroad(steps, h) {
  const { L, call, check, cmd, json, G, ensure, spendZero, groundY, BOXOF, CX, CZ, CLAIM, growPlan, rvWait, rvIr, cellsOf, diff } = h;
  const ctx = { L, OUT: h.OUT };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The ITEM_WAITING events of one item key in this region, with their waitsFor. */
  async function waitsOf(region, key) {
    const r = await L.cmd('/apitest events 0');
    const line = (r?.messages ?? []).find((m) => m.startsWith('[') || m.startsWith('{'));
    const ev = line ? JSON.parse(line) : [];
    return ev.filter((e) => e.event === 'ITEM_WAITING' && (e.key ?? e.itemKey) === key && (e.ext?.['architect_mc:region'] ?? region) === region)
      .map((e) => e.ext?.['architect_mc:waitsFor'] ?? {}).map((w) => ({ target: w.target, part: w.part, say: w.say }));
  }

  steps.saroad = async () => {
    await ensure();
    const out = {};
    await G.survivalBase(ctx);
    await L.fresh('G6B SA Road Survival', G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
    // the town in survival, fed until built
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN_LOTS }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: {} });
    const f0 = await G.feed(ctx, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    check(f0.last.st.view.state === 'PLACED' && f0.last.rs.build?.done, `the survival V town built: ${f0.last.st.view.state} (${f0.waves} feed waves)`);
    const S0 = await cellsOf(BOX);
    // the extension growth: a new street (not in the base IR) with its lots as pads
    const g = await growPlan(region, { lots: ROW, prefer: 'extend' });
    check(!g.refused, `an extension growth planned (prefer extend): ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    if (g.refused) { await L.leaveWorld(); spendZero(); return out; }
    const rid = g.revisionOf.rid;
    const baseRoads = new Set((p0.ir?.roads ?? (await rvIr(region, 0).catch(() => null))?.roads ?? []).map((x) => `road:${x.id}`));
    const q0 = await call('dev.region.quote', { planId: g.planId, lotEntries: {} }, 300_000);
    const roadParts = Object.keys(q0.bomParts ?? {}).filter((k) => k.startsWith('road:'));
    const newRoads = roadParts.filter((k) => !baseRoads.has(k));
    const roadKey = newRoads[0];
    out.plan = { planId: g.planId, rid, roadKey, roadParts, baseRoads: [...baseRoads], quote: { bom: q0.bom, exact: q0.exact, refused: q0.refused } };
    check(!q0.refused && q0.survival === true && !!roadKey, `the growth quoted in survival with its new street's piece ${roadKey} (${json(q0.bomParts?.[roadKey])}); not a base road (${json([...baseRoads])})`, out.plan);
    if (!roadKey) { await L.leaveWorld(); spendZero(); return out; }
    // realised with nothing fed: the new road's item waits for its stage's unbuilt targets before its put-down (SA: its box from the
    // revision's IR)
    const a0 = await pile();
    const r = await call('dev.region.realise', { planId: g.planId, lots: {} }, 300_000);
    check(!r.refused, `the growth realised: ${r.refused ?? r.region}`);
    const X = (await rvIr(region, rid).catch(() => null))?.revision?.grow?.extension ?? null;
    out.plan.extension = X;
    check(!!X?.road && roadKey === `road:${X.road}`, `the growth is an extension: its new street ${X?.road} is the quoted ${roadKey}`, X);
    let waits = [];
    for (let i = 0; i < 15 && !waits.length; i++) {
      await sleep(2000);
      waits = await waitsOf(region, roadKey);
    }
    out.waits = waits;
    check(waits.length >= 1 && waits.every((w) => w.target), `A3: the new street's item ${roadKey} waited for its earlier stage's targets before its put-down (${waits.length} ITEM_WAITING; ${json(waits[0])})`, waits);
    // fed until placed: consumed equals the quote item for item
    const f = await G.feed(ctx, region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
    const w = await rvWait(region, rid, 1_800_000);
    const a1 = await pile();
    const used = G.minus(a1.ledger?.consumed ?? {}, a0.ledger?.consumed ?? {});
    const rs = await G.rsState(ctx, region);
    const roadT = (rs.targets ?? []).filter((t) => t.part === roadKey || t.part === `road ${X?.road}` || String(t.id).includes(X?.road ?? '\u0000'));
    out.built = { state: w.r.state, waves: f.waves, consumed: used, roadTargets: roadT.map((t) => [t.id, t.part, t.built ?? t.done, t.bom]) };
    check(w.r.state === 'PLACED' && G.same(q0.bom, used), `A3: built (${w.r.state}, ${f.waves} waves); consumed equals the quote item for item: quote ${json(q0.bom)}, consumed ${json(used)}`, out.built);
    // undone: the world before the growth; what came back equals what was consumed
    const u = await call('dev.rv.undo', { region, toPosition: 0 }, 4 * 3_600_000);
    await L.settle(3000);
    const a2 = await pile();
    const back = G.minus(a2.ledger?.returned ?? {}, a1.ledger?.returned ?? {});
    const d = diff(S0, await cellsOf(BOX));
    out.undo = { removed: u.removed, refund: u.refund, returned: back, differ: d.n, first: d.first?.slice?.(0, 8) };
    check(u.removed === true && d.n === 0 && G.same(back, used), `A3: undone: the world before the growth (${d.n} differ); items in equal items out: consumed ${json(used)}, returned ${json(back)}`, out.undo);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
