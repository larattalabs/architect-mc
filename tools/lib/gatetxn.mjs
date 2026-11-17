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
//   node tools/gate6dgr.mjs txnholds  (txn-holds)  slice T2a, docs/TXN-DESIGN.md §6.1 (T2's entry criterion): every way a held box's contents,
//     state or block entity can change, one row each (per-type writers, the double chest, pistons, commands, removal by any path, raw writes
//     as another mod would make them). Each row's box is the sink of a test.move from a plain chest under /save-off: the barrier refuses, the
//     move aborts (its take compensated), so the box is held and never written by the txn itself. Then every writer runs at once, and per
//     row: the state, the block entity (type and identity), the slots and the item drops near it are compared before and after. A row is
//     `held` when nothing changed. Rows marked base: 'green' are held on the base too (T1's guards, or vanilla never does it) and are recorded,
//     not asserted red. Then the world is left and opened again with the holds still on disk (the boxes load intact), /save-on, and every
//     txn retires (open 0). Failing first: red on the widened test.move without the T2a holds.
//
// Evidence: <out>/txncore.json, <out>/txnholds.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
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
    check(r0.status === 'DONE' && units(w0.b) === units(ITEMS), `trace: a move A -> B through the txn: ${r0.status} (${r0.txn}); B holds ${json(w0.b)}`, r0);
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

    // ---------------------------------------------------------------- a held txn: every writer honours its hold (T1 review P1-2)
    {
      const w = await where();
      const hop = [w.from[0], w.from[1] - 1, w.from[2]];
      await cmd('/save-off'); // the barrier refuses under save-off: the move aborts, its compensation done, the txn held until a barrier
      const r = await call('dev.txn.run', { from: w.from, to: w.to, items: ITEMS }, 120_000);
      const st = await state();
      await cmd(`/setblock ${hop.join(' ')} minecraft:hopper[facing=down]`);
      await call('dev.wait', { ms: 4000 }, 30_000);
      const src = await chest(w.from);
      const inHopper = await chest(hop);
      await cmd(`/setblock ${hop.join(' ')} minecraft:air`);
      await cmd('/save-on');
      let st2 = await state();
      for (let i = 0; i < 40 && st2.openCount > 0; i++) {
        await call('dev.wait', { ms: 1000 }, 30_000);
        st2 = await state();
      }
      const c = await report(BASE);
      out.held = { run: r, heldWhile: st.heldCount, decision: st.open?.[0]?.decision, src, inHopper, openAfter: st2.openCount, conservation: c };
      check(st.heldCount === 1 && st.open?.[0]?.decision === 'abort', `held: under /save-off the move aborts and stays held (decision ${st.open?.[0]?.decision}, held ${st.heldCount}: ${st.open?.[0]?.held})`, out.held);
      check(units(src) === units(ITEMS) && units(inHopper) === 0, `held: a hopper under the held source pulls nothing (source ${json(src)}, hopper ${json(inHopper)})`, out.held);
      check(st2.openCount === 0 && c.verdict === 'match', `held: after /save-on the abort retires (open ${st2.openCount}); conservation ${c.verdict}`, out.held);
    }

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
        const ans = call('dev.txn.run', { from: w.from, to: w.to, items: ITEMS }, 120_000).catch(() => null); // the halt drops the call
        const first = await Promise.race([ans, new Promise((res) => setTimeout(() => res('halting'), 15_000))]);
        if (first && first !== 'halting' && first.refused) {
          check(false, `${point}: the move was refused before its kill point (${first.refused}): the cases stop here`, first);
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
          break;
        }
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

  // ------------------------------------------------------------------ (slice T2a) txn-holds
  steps.txnholds = async () => {
    await ensure();
    const out = { rows: [] };
    const name = 'G6B TXN holds';
    await freshFlat(name);
    const gy = await groundY();
    const y = gy + 1;
    const X0 = CX + 50, Z0 = CZ + 30;
    const at = [X0 + 1, y, Z0 - 2]; // next to the first row (menu_crafter): an open menu closes beyond reach
    await L.tp(...at);
    const s = (p) => p.join(' ');
    const add = (p, d) => p.map((v, i) => v + d[i]);
    // the rows: [id, block, slots, extra setup, action, opts]; each row gets its own column (6 apart) and line (9 apart)
    const P = 'minecraft:oak_planks';
    const rows = [
      { id: 'menu_crafter', block: 'crafter[orientation=north_up]', slots: ['oak_log 2'], pre: async (X) => call('dev.txn.poke', { pos: X, how: 'menu' }, 30_000),
        act: async (X) => call('dev.txn.poke', { pos: X, how: 'menuMove', slot: 0 }, 30_000) },
      // per-type writers (§6.1 item 2)
      { id: 'furnace', block: 'furnace', slots: ['raw_iron 4', 'coal 2'], ticks: true, late: true },
      { id: 'blast_furnace', block: 'blast_furnace', slots: ['raw_iron 4', 'coal 2'], ticks: true, late: true },
      { id: 'smoker', block: 'smoker', slots: ['beef 4', 'coal 2'], ticks: true, late: true },
      { id: 'brewing_stand', block: 'brewing_stand', slots: [null, null, null, null, 'blaze_powder 2'], ticks: true, late: true },
      { id: 'dropper', block: 'dropper[facing=north]', slots: ['cobblestone 8'], act: async (X) => cmd(`/setblock ${s(add(X, [0, 1, 0]))} minecraft:redstone_block`) },
      { id: 'dispenser', block: 'dispenser[facing=north]', slots: ['cobblestone 8'], act: async (X) => cmd(`/setblock ${s(add(X, [0, 1, 0]))} minecraft:redstone_block`) },
      { id: 'crafter', block: 'crafter[orientation=north_up]', slots: ['oak_log 1'], act: async (X) => cmd(`/setblock ${s(add(X, [0, 1, 0]))} minecraft:redstone_block`) },
      { id: 'hopper_push', block: 'hopper[facing=east]', slots: ['oak_planks 4'], ticks: true, late: true, act: async (X) => cmd(`/setblock ${s(add(X, [1, 0, 0]))} minecraft:chest`) }, // the chest it pushes into placed only once held
      { id: 'hopper_suck', block: 'hopper[facing=down]', slots: [], ignoreDrops: true, ticks: true,
        act: async (X) => cmd(`/summon minecraft:item ${X[0] + 0.5} ${X[1] + 1.2} ${X[2] + 0.5} {Item:{id:"minecraft:cobblestone",count:3}}`), injected: { 'minecraft:cobblestone': 3 } },
      { id: 'copper_golem', block: 'chest', slots: ['oak_planks 2'], slow: true, ticks: true,
        setup: async (X) => { await cmd(`/setblock ${s(add(X, [2, 0, 0]))} minecraft:copper_chest`); await cmd(`/item replace block ${s(add(X, [2, 0, 0]))} container.0 with ${P} 16`); },
        act: async (X) => cmd(`/summon minecraft:copper_golem ${X[0] + 1} ${X[1]} ${X[2] + 1}`) },
      { id: 'barrel', block: 'barrel', slots: ['oak_planks 4'], base: 'green', why: "T1's hopper guard", setup: async (X) => cmd(`/setblock ${s(add(X, [0, -1, 0]))} minecraft:hopper`) },
      { id: 'shulker_box', block: 'shulker_box', slots: ['oak_planks 4'], base: 'green', why: "T1's hopper guard", setup: async (X) => cmd(`/setblock ${s(add(X, [0, -1, 0]))} minecraft:hopper`) },
      { id: 'trapped_chest', block: 'trapped_chest', slots: ['oak_planks 4'], base: 'green', why: "T1's hopper guard", setup: async (X) => cmd(`/setblock ${s(add(X, [0, -1, 0]))} minecraft:hopper`) },
      // (fix round, GPT P1-2..P1-5, P2-6, P2-8) what already exists when the hold begins, and data beyond the slots
      { id: 'golem_retained', block: 'chest', slots: ['oak_planks 2'], slow: true, ticks: true,
        setup: async (X) => { await cmd(`/setblock ${s(add(X, [5, 0, 0]))} minecraft:copper_chest`); for (const k of [0, 1, 2]) await cmd(`/item replace block ${s(add(X, [5, 0, 0]))} container.${k} with ${P} 64`); },
        // held first, the moment the golem has taken from the copper chest: it walks to the box with its target already chosen
        holdFirst: true,
        pre: async (X) => cmd(`/summon minecraft:copper_golem ${X[0] + 4} ${X[1]} ${X[2] + 1}`),
        ready: async (X) => {
          for (let i = 0; i < 120; i++) {
            const c = (await call('dev.txn.cells', { cells: [add(X, [5, 0, 0])] }, 30_000))[add(X, [5, 0, 0]).join(',')];
            const n = Object.values(c?.slots ?? {}).reduce((t, v) => t + Number(String(v).split(' x')[1] ?? 0), 0);
            if (n < 192) return { took: 192 - n, afterMs: i * 500 };
            await call('dev.wait', { ms: 500 }, 30_000);
          }
          return { took: 0 };
        } },
      { id: 'storage_cached', block: 'chest[facing=north,type=left]', slots: ['oak_planks 5'], partner: [1, 0, 0],
        setup: async (X) => cmd(`/setblock ${s(add(X, [1, 0, 0]))} minecraft:chest[facing=north,type=right]`),
        pre: async (X) => call('dev.txn.poke', { pos: add(X, [1, 0, 0]), how: 'cacheStorage' }, 30_000),
        act: async (X) => call('dev.txn.poke', { pos: add(X, [1, 0, 0]), how: 'cachedExtract' }, 30_000) },
      { id: 'chest_swap', block: 'chest', slots: ['oak_planks 4'], setup: async (X) => cmd(`/setblock ${s(add(X, [0, 0, -2]))} minecraft:chest`),
        act: async (X) => call('dev.txn.poke', { pos: X, how: 'swap', with: add(X, [0, 0, -2]) }, 30_000) },
      { id: 'brewing_active', block: 'brewing_stand', ticks: true, late: true,
        slots: ['potion[potion_contents={potion:"minecraft:water"}] 1', 'potion[potion_contents={potion:"minecraft:water"}] 1', null, 'nether_wart 1', 'blaze_powder 1'] },
      // the double chest (item 1): a held half (its partner held with it), and a chest placed beside a held single one
      { id: 'double_partner', block: 'chest[facing=north,type=left]', slots: ['oak_planks 5'], base: 'green', why: 'both halves held (the partner is a txn resource): T1\'s hopper guard',
        setup: async (X) => { await cmd(`/setblock ${s(add(X, [1, 0, 0]))} minecraft:chest[facing=north,type=right]`); await cmd(`/setblock ${s(add(X, [1, -1, 0]))} minecraft:hopper`); },
        partner: [1, 0, 0] },
      { id: 'double_merge', block: 'chest[facing=north]', slots: ['oak_planks 5'],
        act: async (X) => { await cmd(`/setblock ${s(add(X, [1, -1, 0]))} minecraft:hopper`); await cmd(`/setblock ${s(add(X, [1, 0, 0]))} minecraft:chest[facing=north,type=right]`); } },
      // pistons and commands (item 3)
      { id: 'piston', block: 'chest', slots: ['oak_planks 4'], base: 'green', why: 'vanilla never pushes a block entity',
        act: async (X) => { await cmd(`/setblock ${s(add(X, [0, 0, -1]))} minecraft:piston[facing=south]`); await cmd(`/setblock ${s(add(X, [0, 0, -2]))} minecraft:redstone_block`); } },
      { id: 'setblock_air', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/setblock ${s(X)} minecraft:air`) },
      { id: 'setblock_destroy', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/setblock ${s(X)} minecraft:stone destroy`) },
      { id: 'setblock_nbt', block: 'chest[facing=north]', slots: ['oak_planks 4'], act: async (X) => cmd(`/setblock ${s(X)} minecraft:chest[facing=east]{Items:[]}`) },
      { id: 'fill', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/fill ${s(X)} ${s(X)} minecraft:air`) },
      { id: 'clone_onto', block: 'chest', slots: ['oak_planks 4'], setup: async (X) => cmd(`/setblock ${s(add(X, [0, 0, -2]))} minecraft:stone`),
        act: async (X) => cmd(`/clone ${s(add(X, [0, 0, -2]))} ${s(add(X, [0, 0, -2]))} ${s(X)}`) },
      { id: 'clone_move', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/clone ${s(X)} ${s(X)} ${s(add(X, [0, 0, -2]))} replace move`) },
      { id: 'data_merge', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/data merge block ${s(X)} {Items:[]}`) },
      { id: 'data_remove', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/data remove block ${s(X)} Items`) },
      { id: 'item_replace', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/item replace block ${s(X)} container.0 with minecraft:air`) },
      { id: 'loot_insert', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/loot insert ${s(X)} loot minecraft:blocks/oak_planks`) },
      { id: 'loot_replace', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/loot replace block ${s(X)} container.1 loot minecraft:blocks/oak_planks`) },
      { id: 'place_template', block: 'chest', slots: ['oak_planks 4'], act: async (X) => cmd(`/place template minecraft:desert_well/suspicious_sand ${s(X)}`) },
      // removal by any path (item 4): raw writes, as another mod would make them
      ...['setBlock', 'destroyBlock', 'removeBlock', 'removeBlockEntity', 'setItem', 'removeItem', 'clearContent', 'load'].map((how) => (
        { id: `poke_${how}`, block: 'chest', slots: ['oak_planks 4'], act: async (X) => call('dev.txn.poke', { pos: X, how }, 30_000) })),
      { id: 'explosion', block: 'chest', slots: ['oak_planks 4'], base: 'green', why: "T1's explosion guard", far: true, ignoreDrops: true, // the blast drops the ground around it
        act: async (X) => cmd(`/summon minecraft:tnt ${X[0] + 0.5} ${X[1] + 1} ${X[2] + 1.5} {fuse:0}`) },
    ];
    const COLS = 7;
    let k = 0;
    for (const r of rows) {
      const i = r.far ? 0 : k++;
      r.X = r.far ? [X0 + 20, y, Z0 + 80] : [X0 + 7 * (i % COLS), y, Z0 + 10 * Math.floor(i / COLS)];
      r.S = add(r.X, [0, 0, 4]);
    }
    const put = async (p, slots) => {
      for (let j = 0; j < slots.length; j++) if (slots[j]) {
        const [it, n] = slots[j].split(' ');
        await cmd(`/item replace block ${s(p)} container.${j} with minecraft:${it} ${n}`);
      }
    };
    for (const r of rows) {
      await cmd(`/setblock ${s(r.X)} minecraft:${r.block}`);
      if (!r.late) await put(r.X, r.slots);
      await cmd(`/setblock ${s(r.S)} minecraft:chest`);
      await cmd(`/item replace block ${s(r.S)} container.0 with ${P} 1`);
      if (r.setup) await r.setup(r.X);
    }
    // things that exist before the hold: an open menu, a cached storage handle, a golem with its target
    for (const r of rows) {
      if (r.pre) r.preAnswer = await r.pre(r.X);
    }
    // the furnaces and brewing stands are loaded last, so they are still working when their holds begin
    for (const r of rows) if (r.late) await put(r.X, r.slots);
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 2000 }, 60_000);
    const box = { min: [X0 - 4, gy - 2, Z0 - 4], max: [X0 + 7 * COLS + 4, y + 4, Z0 + 60] }; // the explosion row (z + 80) outside: its blast drops ground blocks
    const report = async (baseline) => call('dev.txn.conservation', { min: box.min, max: box.max, ...(baseline ? { baseline } : {}) }, 60_000);
    // ---------------------------------------------------------------- hold every row: a refused barrier keeps each aborted move held
    await cmd('/save-off');
    for (const r of [...rows.filter((x) => x.holdFirst), ...rows.filter((x) => !x.holdFirst)]) {
      if (r.ready) r.readyAnswer = await r.ready(r.X);
      r.run = await call('dev.txn.run', { from: r.S, to: r.X, items: { [P]: 1 } }, 120_000);
    }
    const st0 = await call('dev.txn.state', {}, 30_000);
    const heldRes = new Set(st0.holds ?? []);
    const key = (p) => `box:minecraft:overworld@${p.join(',')}`;
    for (const r of rows) {
      r.heldOk = r.run.decision === 'abort' && !!r.run.held && heldRes.has(key(r.X)) && (!r.partner || heldRes.has(key(add(r.X, r.partner))));
    }
    const bad = rows.filter((r) => !r.heldOk);
    check(bad.length === 0, `holds: ${rows.length - bad.length}/${rows.length} boxes held by an aborted test.move under /save-off (the take compensated, the barrier refused)${bad.length ? `; not held: ${bad.map((r) => `${r.id} ${json(r.run)}`).join('; ')}` : ''}`, bad.map((r) => r.run));
    const cells = async () => call('dev.txn.cells', { cells: rows.map((r) => r.X) }, 60_000);
    const before = await cells();
    const base0 = await report();
    out.baseline = base0.total;
    // ---------------------------------------------------------------- every writer at once
    for (const r of rows) {
      if (!r.act) continue;
      try {
        r.answer = await r.act(r.X);
      } catch (e) {
        r.answer = { error: String(e?.message ?? e).slice(0, 300) };
      }
    }
    await call('dev.wait', { ms: 15_000 }, 60_000);
    if (rows.some((r) => r.slow)) await call('dev.wait', { ms: 30_000 }, 60_000);
    const after = await cells();
    const cmp = (r, a, b) => {
      const d = [];
      if (a?.state !== b?.state) d.push(`state ${a?.state} -> ${b?.state}`);
      if (a?.be !== b?.be || a?.beId !== b?.beId) d.push(`block entity ${a?.be}#${a?.beId} -> ${b?.be}#${b?.beId}`);
      if (json(a?.slots ?? {}) !== json(b?.slots ?? {})) d.push(`slots ${json(a?.slots)} -> ${json(b?.slots)}`);
      else if ((a?.nbt ?? '') !== (b?.nbt ?? '')) d.push(`data ${a?.nbt} -> ${b?.nbt}`); // the persisted data: components, timers, triggers
      if (!r.ignoreDrops && (a?.drops ?? 0) !== (b?.drops ?? 0)) d.push(`drops ${a?.drops} -> ${b?.drops}`);
      return d;
    };
    for (const r of rows) {
      const k2 = r.X.join(',');
      r.diff = cmp(r, before[k2], after[k2]);
      r.held = r.diff.length === 0;
      out.rows.push({ id: r.id, held: r.held, diff: r.diff, base: r.base ?? 'red', why: r.why, answer: r.answer, before: before[k2], after: after[k2] });
      log(`  ${r.id}: ${r.held ? 'held' : 'CHANGED ' + r.diff.join('; ')}${r.answer?.error ? ` (answer: ${r.answer.error})` : ''}`);
      check(r.held, `${r.id}: the held box unchanged by its writer${r.base === 'green' ? ` (held on the base too: ${r.why})` : ''}${r.held ? '' : `: ${r.diff.join('; ')}`}`, out.rows.at(-1));
    }
    const st1 = await call('dev.txn.state', {}, 30_000);
    out.backstops = st1.backstops;
    // conservation while every box is still held (once released, the furnaces smelt again: a conversion, not a loss)
    const injected = {};
    for (const r of rows) for (const [it, n] of Object.entries(r.injected ?? {})) injected[it] = (injected[it] ?? 0) + n;
    const expect = { ...out.baseline };
    for (const [it, n] of Object.entries(injected)) expect[it] = (expect[it] ?? 0) + n;
    const c = await report(expect);
    out.conservation = { verdict: c.verdict, diff: c.diff, unread: c.unread, injected };
    check(c.verdict === 'match', `conservation (still held): the box against the baseline plus the injected drop: ${c.verdict} (diff ${json(c.diff)})`, out.conservation);
    // ---------------------------------------------------------------- the world closed and opened with the holds on disk
    await L.leaveWorld();
    await L.openWorld(name);
    await L.tp(...at);
    let st2 = await call('dev.txn.state', {}, 30_000);
    for (let i = 0; i < 90 && (st2.openCount > 0 || !st2.recovered); i++) {
      await call('dev.wait', { ms: 1000 }, 30_000);
      st2 = await call('dev.txn.state', {}, 30_000);
    }
    const reopened = await cells();
    // the boxes with no writer of their own load as they were held (a furnace or hopper resumes once its txn retires on the first tick)
    const still = rows.filter((r) => r.held && !r.ticks);
    const lost = still.filter((r) => json(reopened[r.X.join(',')]?.slots ?? {}) !== json(after[r.X.join(',')]?.slots ?? {}));
    check(lost.length === 0, `reopen: the held boxes load intact (${still.length - lost.length}/${still.length} with no ticking writer)${lost.length ? `: ${lost.map((r) => r.id).join(', ')}` : ''}`, lost.map((r) => r.id));
    check(st2.openCount === 0, `reopen: every held txn retired after the world opened again (open ${st2.openCount})`, st2.open);
    out.summary = { rows: rows.length, held: rows.filter((r) => r.held).length, changed: rows.filter((r) => !r.held).map((r) => r.id),
      greenOnBase: rows.filter((r) => r.base === 'green').map((r) => r.id), backstops: out.backstops };
    log(`  txn-holds: ${json(out.summary)}`);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
