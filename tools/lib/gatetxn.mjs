// Slice T1 gate (docs/TXN-DESIGN.md §4.2, GATES rules 17-18): the txn core in game through its TEST kind test.move (dev.txn.run), a kill
// point at each of its steps (every txn.json write and both barriers), bare and +save, and the conservation report (report-only, §5.3).
// Registered into tools/gate6dgr.mjs (its flat base, groundY and halt helpers). Headless server, no sidecar call: $0.
//
//   node tools/gate6dgr.mjs txncore   (txn-core)   one flat world, two chests in different chunks, 12 oak planks + 5 cobblestone in the first:
//     trace    /save-all flush, the baseline conservation report (the box around both chests), a traced move A -> B (dev.txn.trace): the
//              ordered kill points of the forward path; the move done (B holds the items), open 0, conservation match
//     refused  dev.txn.failPersist 1, a move: the intent refused (persist REFUSED), nothing moved, open 0, conservation match
//     kill     per traced point P, bare and P+save: dev.journal.killAt P, a move from wherever the items are, the halt, the world opened
//              again, recovery on the first tick: open 0 (finished or rolled back, exactly once), the items wholly in one chest, the
//              conservation report against the baseline (judged: verdict match; the report itself never fails a step)
//
// Evidence: <out>/txncore.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
export async function registerTXN(steps, h) {
  const { L, call, check, cmd, log, json, ensure, spendZero, groundY, CX, CZ, haltWait, freshFlat } = h;
  const ITEMS = { 'minecraft:oak_planks': 12, 'minecraft:cobblestone': 5 };
  const units = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);

  steps.txncore = async () => {
    await ensure();
    const out = { cases: [] };
    const name = 'G6B TXN core';
    await freshFlat(name);
    const gy = await groundY();
    const at = [CX + 80, gy + 3, CZ + 56];
    const A = [CX + 70, gy + 1, CZ + 50];
    const B = [CX + 90, gy + 1, CZ + 50]; // 20 blocks east: another chunk, saved on its own
    const box = { min: [CX + 60, gy - 2, CZ + 40], max: [CX + 100, gy + 4, CZ + 60] };
    await cmd(`/setblock ${A.join(' ')} minecraft:chest`);
    await cmd(`/setblock ${B.join(' ')} minecraft:chest`);
    await cmd(`/item replace block ${A.join(' ')} container.0 with minecraft:oak_planks 12`);
    await cmd(`/item replace block ${A.join(' ')} container.1 with minecraft:cobblestone 5`);
    await L.tp(...at);
    const chest = async (p) => (await call('dev.txn.conservation', { min: p, max: p }, 60_000)).parts?.containers ?? {};
    const report = async (baseline) => call('dev.txn.conservation', { min: box.min, max: box.max, ...(baseline ? { baseline } : {}) }, 60_000);
    const state = async () => call('dev.txn.state', {}, 30_000);
    const where = async () => {
      const a = await chest(A), b = await chest(B);
      return { a, b, from: units(a) >= units(ITEMS) ? A : B, to: units(a) >= units(ITEMS) ? B : A };
    };

    // ---------------------------------------------------------------- the baseline, then a traced move
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 2000 }, 30_000);
    const base = await report();
    out.baseline = base;
    const BASE = base.total;
    log(`  baseline ${json(BASE)} (mode ${base.mode})`);
    check(base.mode === 'report' && units(BASE) === units(ITEMS), `baseline: the conservation report (report-only) counts ${units(BASE)} units in the box`, base);
    await call('dev.txn.trace', { on: true }, 10_000);
    const r0 = await call('dev.txn.run', { from: A, to: B, items: ITEMS }, 120_000);
    const points = (await call('dev.txn.trace', { on: false }, 10_000)).trace ?? [];
    out.trace = { run: r0, points };
    const w0 = await where();
    const c0 = await report(BASE);
    check(r0.status === 'DONE' && units(w0.b) === units(ITEMS), `trace: a move A -> B through the txn: ${r0.status} (${r0.id}); B holds ${json(w0.b)}`, r0);
    check(points.length >= 8 && points.every((p) => p.startsWith('TX:test.move:')), `trace: ${points.length} kill points of the forward path: ${points.join(' ')}`, points);
    check(c0.verdict === 'match', `trace: conservation ${c0.verdict} (diff ${json(c0.diff)})`, c0);

    // ---------------------------------------------------------------- an intent write refused: nothing touched
    await call('dev.txn.failPersist', { n: 1 }, 10_000);
    const w1 = await where();
    const r1 = await call('dev.txn.run', { from: w1.from, to: w1.to, items: ITEMS }, 120_000);
    const st1 = await state();
    const c1 = await report(BASE);
    const w1b = await where();
    out.refused = { run: r1, state: st1.openCount, conservation: c1 };
    check(r1.persist === 'REFUSED' && st1.openCount === 0 && json(w1b.a) === json(w1.a), `refused: the intent's write refused: persist ${r1.persist}, open ${st1.openCount}, nothing moved`, r1);
    check(c1.verdict === 'match', `refused: conservation ${c1.verdict}`, c1);

    // ---------------------------------------------------------------- a kill point at each step, bare and +save
    const only = (process.env.GATE_TXN_POINTS ?? '').split(',').filter(Boolean);
    for (const p of points) {
      for (const v of ['', '+save']) {
        const point = p + v;
        if (only.length && !only.includes(point)) continue;
        const w = await where();
        await cmd('/save-all flush').catch(() => null);
        await call('dev.txn.state', {}, 10_000);
        await call('dev.journal.killAt', { point }, 10_000);
        call('dev.txn.run', { from: w.from, to: w.to, items: ITEMS }, 120_000).catch(() => null); // the halt drops the call
        const down = await haltWait();
        check(down, `${point}: halted at the kill point`);
        if (!down) {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
          continue;
        }
        await L.openWorld(name);
        await L.tp(...at);
        let st = await state();
        for (let i = 0; i < 20 && (st.openCount > 0 || !st.recovered); i++) {
          await call('dev.wait', { ms: 1000 }, 30_000);
          st = await state();
        }
        const w2 = await where();
        const c = await report(BASE);
        const moved = units(w2.a) === units(ITEMS) ? (w.from === A ? 'stayed' : 'moved') : units(w2.b) === units(ITEMS) ? (w.from === B ? 'stayed' : 'moved') : 'split';
        const n = { point, open: st.openCount, held: st.heldCount, quarantined: (st.quarantined ?? []).length, events: st.events, outcome: moved, a: w2.a, b: w2.b,
          verdict: c.verdict, diff: c.diff, unread: c.unread, inTransit: c.parts?.inTransit };
        out.cases.push(n);
        log(`  ${point}: open ${n.open}, ${moved}; conservation ${c.verdict} ${json(c.diff)}`);
        check(st.openCount === 0 && moved !== 'split', `${point}: recovered exactly once (open ${st.openCount}, the items ${moved}: A ${json(w2.a)}, B ${json(w2.b)})`, n);
        check(c.verdict === 'match', `${point}: conservation against the baseline: ${c.verdict} (diff ${json(c.diff)}, unread ${json(c.unread)})`, n);
      }
    }
    out.summary = { points: points.length, cases: out.cases.length, match: out.cases.filter((c) => c.verdict === 'match').length,
      moved: out.cases.filter((c) => c.outcome === 'moved').length, stayed: out.cases.filter((c) => c.outcome === 'stayed').length };
    log(`  txn-core: ${json(out.summary)}`);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
