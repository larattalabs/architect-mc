// Slice T2b part 2b gate (docs/CONTRACT.md "Slice T2b part 2b as built"): a removed crate-fed construction site's crate settles once
// through the crate.settle txn (its stock and its refunds owed, or credited to a pile; its cell restored; never an item entity), after the
// removal's own commit. Ported from slice CXD's cxd-crash (origin/slice/CXD tools/lib/gatemcxd.mjs: fill, playerSite, the sharedCrate
// batch); the owed model is T2b's owed collectibles (dev.stockpile.owed), not CXD's records. Registered into tools/gate6dgr.mjs.
// Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs txncrashcrate   (txn-crash-crate)   one survival world; per row a crate-fed construction site (rs_hut), paused,
//   part of its bill in its crate (/save-all flush: the baseline), then:
//     S-<point>[s]  a player's site (/architect place) deconstructed alone, halted at K5, K6, R4 (the restore written, nothing settled) and
//                   every traced TX:crate.settle:* point, bare and +save (s); the world opened again, the recovery waited out
//     G-<point>[s]  the same for a group's shared crate (an actorless batch, sharedCrate) removed with its group (sgremove)
//     P1-1..P1-4    one row per P1 of CXD's last GPT review: (1) the evidence of a pickup is the owed ledger (collected, then a halt +save:
//                   paid once); (2) a settle whose barrier fails after its decision is held, never discarded (then a halt +save); (3) a
//                   two-member group's refunds are keyed effects, never queue amounts (halted at GW +save between the members); (4) a
//                   removal ended before its commit (dev.journal.failNextCommit) never touched the crate (the builder then consumes)
//     MF1, MF2, MF4 the coordinator's must-fix rows: a held crate never funds a placement; an adoption that skips a held crate keeps every
//                   reference to it; the last road over a held crate stays BUILDING. A crate is held by a test.move out of it under
//                   /save-off (its barrier refused: the move aborts, its take compensated, the hold kept until a save works)
//     MF3           a completed site's crate leftovers (dev.site.finish over a stocked crate) go through crate.settle: owed, never dropped
//   judged: the units (crate stock + placed + owed + ground + inventory) after = before, item for item; no item entity near the crate
//   (rule R-5: nothing dropped); txn open 0; a gone site's crate cell restored and its owed entry naming the site. On the base (main's
//   take-at-prepare + drop) the TX rows are N/A (no crate.settle kind): the trace finds none.
//
//   GATE_TCC_PARTS=S,G,P1,MF (default all) or a list of row tags limits the rows.
// Evidence: <out>/txncrashcrate.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';

export async function registerTCC(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pick = (m, items) => Object.fromEntries(items.filter((k) => m?.[k]).map((k) => [k, m[k]]));
  const api = async (args) => {
    const r = await cmd(`/apitest ${args}`);
    const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null');
    if (line === undefined) throw new Error(`/apitest ${args.slice(0, 120)}: no JSON answer: ${JSON.stringify(r).slice(0, 400)}`);
    return JSON.parse(line);
  };
  const later = async (args, timeoutMs = 600_000) => {
    const pd = await api(args);
    if (!pd?.pending) return pd;
    for (const end = Date.now() + timeoutMs; Date.now() < end; await L.sleep(500)) {
      const r = await api(`get ${pd.pending}`);
      if (r && r.value !== undefined && r.value !== null) return r.value;
    }
    throw new Error(`no result for ${pd.pending}`);
  };
  const wait = (ms) => call('dev.wait', { ms }, 60_000);
  const siteState = async (site) => call('dev.site.state', { site }, 60_000).catch(() => null);
  const owedAll = async () => (await call('dev.stockpile.owed', {}, 30_000).catch(() => null)) ?? { owed: [], total: {} };
  const txn = async () => call('dev.txn.state', {}, 30_000).catch(() => ({ openCount: -1 }));
  const cellOf = async (cp) => (await call('dev.txn.cells', { cells: [cp] }, 30_000).catch(() => ({})))[cp.join(',')] ?? {};
  const isCrate = (c) => /crate/.test(String(c?.be ?? '')) || /crate/.test(String(c?.state ?? ''));

  /** The units of {@code items} for {@code sites}: their crate's stock and placed cells (standing), the owed total, the ground near the crate, the inventory. */
  async function parts(sites, cp, items) {
    let stock = {}, placed = {}, seen = false;
    const st = {};
    for (const s of sites) {
      const v = await siteState(s);
      st[s] = v ? v.state : null;
      if (v) {
        if (v.crate?.present && !seen) stock = G.plus(stock, v.ledger?.stock ?? {}); // a shared crate's stock once
        seen = seen || !!v.crate?.present;
        placed = G.plus(placed, v.ledger?.placed ?? {});
      }
    }
    const ow = await owedAll();
    const near = await call('dev.items.near', { pos: cp, radius: 8 }, 30_000);
    const cell = await cellOf(cp);
    const p = { stock: pick(stock, items), placed: pick(placed, items), owed: pick(ow.total, items), ground: pick(near.items ?? {}, items),
      inventory: pick(near.inventory ?? {}, items), states: st, crate: isCrate(cell), owedEntries: (ow.owed ?? []).filter((e) => sites.includes(e.site)) };
    p.total = [p.stock, p.placed, p.owed, p.ground, p.inventory].reduce((a, b) => G.plus(a, b), {});
    return p;
  }

  /** A site's crate: paused, part of its bill in it ({@code build}: a first part placed first, so it has refunds). Its cell and the items. */
  async function fill(tag, site, build = false) {
    for (let i = 0; i < 120; i++) {
      if ((await siteState(site))?.state === 'building') break;
      await L.sleep(1000);
    }
    await call('dev.stockpile.pause', { site, paused: true }, 60_000);
    const st0 = await siteState(site);
    const give = {};
    for (const [k, v] of Object.entries(st0?.bom ?? {}).slice(0, 3)) give[k] = Math.max(1, Math.floor(v / 2));
    if (build) {
      const first = {};
      for (const [k, v] of Object.entries(give)) first[k] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site, items: first, exact: true }, 120_000);
      await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 30; i++) {
        if (sum((await siteState(site))?.ledger?.stock) === 0) break;
        await L.sleep(500);
      }
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      await wait(1000);
    }
    const ins = await call('dev.crate.insert', { site, items: give, exact: true }, 120_000);
    await wait(1500);
    const st1 = await siteState(site);
    const cp = [st1.crate.x, st1.crate.y, st1.crate.z];
    check(st1.crate.present && sum(st1.ledger?.stock) > 0, `${tag}: ${site}'s crate at ${cp} holds ${sum(st1.ledger?.stock)} item(s) (inserted ${json(ins.accepted ?? give)})${build ? `, ${sum(st1.ledger?.placed)} placed` : ''}`);
    return { cp, items: Object.keys(give) };
  }

  /** A player's construction rs_hut (/architect place: the placer's UUID, no site owner) in front of {@code origin}; its id. */
  async function playerSite(tag, origin) {
    await L.tp(origin[0], origin[1] + 1, origin[2]);
    await cmd(`/tp @s ${origin[0]} ${origin[1] + 1} ${origin[2]} 0 0`).catch(() => null);
    const r = await cmd('/architect place rs_hut');
    const id = /Construction site (\S+) /.exec((r.messages ?? []).join(' '))?.[1] ?? null;
    check(!!id, `${tag}: a player's construction rs_hut at ${origin}: ${id ?? json(r.messages).slice(0, 200)}`);
    return id;
  }

  /** An actorless batch of rs_huts from one shared crate; {@code n} members ({@code owner}: the batch's owner). Its sites and group. */
  async function groupSites(tag, at, n = 1, owner = null) {
    const items = Array.from({ length: n }, (_, i) => ({ key: `h${i + 1}`, bp: 'rs_hut', at: [at[0] + 14 * i, at[1], at[2]], rot: 0, mode: 'CONSTRUCTION' }));
    const spec = { id: `tcc${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now() % 100000}`, proximity: false, sharedCrate: true, items, ...(owner ? { owner } : {}) };
    const bid = await later(`bqueue ${JSON.stringify(spec)}`, 120_000);
    let bv;
    for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site)) break; await L.sleep(1000); }
    const sites = (bv?.items ?? []).map((x) => x.site).filter(Boolean);
    check(sites.length === n, `${tag}: ${n} actorless construction rs_hut(s) from their group's shared crate (${sites.join(',')}, group ${bv?.group})`, bv);
    return { sites, group: bv?.group };
  }

  /** Waits out the recovery after a restart (txn open 0, and the removal settled or the site standing), at most {@code ms}. */
  async function settleWait(sites, cp, group, ms = 40_000) {
    let t, gs = null;
    for (const end = Date.now() + ms; Date.now() < end; await L.sleep(1000)) {
      t = await txn();
      if (group) gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
      const stands = (await Promise.all(sites.map(siteState))).some(Boolean);
      const crate = isCrate(await cellOf(cp));
      if (t.openCount === 0 && t.recovered !== false && (!group || !gs || ['REMOVED', 'PARTIAL', 'FAILED', 'ACTIVE'].includes(gs)) && (stands || !crate)) break;
    }
    if (group && gs === 'ACTIVE') {
      // planned again after the restart (its undo never committed): the group's removal runs to its end, then it is judged
      await later(`sgremove ${group}`, 600_000).catch(() => null);
      for (let i = 0; i < 40 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
      gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
    }
    return { txn: t, group: gs };
  }

  function judge(out, tag, n, before, after, { committedOk = true } = {}) {
    n.before = before;
    n.after = after;
    out[tag] = n;
    const gone = Object.values(after.states).every((s) => s === null);
    log(`  ${tag}: before ${json(before.total)}; after ${json(after.total)} (stock ${json(after.stock)}, placed ${json(after.placed)}, owed ${json(after.owed)}, ground ${json(after.ground)}, inv ${json(after.inventory)}; ${gone ? 'gone' : json(after.states)}; crate ${after.crate ? 'stands' : 'restored'}; txn open ${n.txn?.openCount})`);
    check(G.same(after.total, before.total), `${tag}: paid exactly once: after ${json(after.total)} = before ${json(before.total)} (stock + placed + owed + ground + inventory)`, n);
    check(sum(after.ground) === 0, `${tag}: nothing dropped as an item entity near the crate (${json(after.ground)})`, n);
    check((n.txn?.openCount ?? 0) === 0, `${tag}: no txn left open (${n.txn?.openCount})`, n.txn);
    if (gone && committedOk) {
      const own = after.owedEntries.filter((e) => e.reason === 'crate_settle' || e.reason === 'group_refund');
      check(!after.crate && (sum(after.owed) === sum(before.owed) || own.length > 0 && own.every((e) => !!e.site)),
        `${tag}: committed: the crate's cell restored (${after.crate ? 'a crate still stands' : 'restored'}), its stock owed to the site's recipient (${own.length} entr${own.length === 1 ? 'y' : 'ies'} naming ${json([...new Set(own.map((e) => e.site))])}${own.some((e) => e.region) ? ', region ' + own.find((e) => e.region).region : ''})`, after.owedEntries);
    }
    if (!gone) check(after.crate && G.same(after.stock, before.stock), `${tag}: not committed: the site stands (${json(after.states)}), its crate holds its stock again ${json(after.stock)}`, n);
  }

  /** One crash row: the baseline, {@code point} armed, {@code remove}, the halt, the world again, the recovery, the judgement. */
  async function crashRow(out, tag, W, sites, point, remove, group = null, build = false) {
    const { cp, items } = await fill(tag, sites[0], build);
    for (const s of sites.slice(1)) await fill(tag, s, build);
    await cmd('/save-all flush').catch(() => null);
    await wait(2000);
    const before = await parts(sites, cp, items);
    await call('dev.journal.killAt', { point }, 10_000);
    const m = await remove().catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
    const down = await haltWait();
    check(down, `${tag}: halted at ${point} (${json(m).slice(0, 160)})`);
    if (!down) {
      await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
      out[tag] = { tag, point, before, removal: m, halted: false };
      return;
    }
    await L.openWorld(path.basename(W.dir));
    await L.tp(...W.at);
    const r = await settleWait(sites, cp, group);
    const after = await parts(sites, cp, items);
    judge(out, tag, { tag, point, sites, group, crate: cp, removal: m, txn: r.txn, groupEnd: r.group }, before, after);
  }

  const P = (process.env.GATE_TCC_PARTS ?? 'S,G,P1,MF').split(',');
  const want = (tag) => P.includes(tag) || P.includes(tag.split('-')[0]) || P.includes(tag.replace(/[0-9-].*$/, ''));

  steps.txncrashcrate = async () => {
    await ensure();
    const out = { rows: {} };
    const R = out.rows;
    await G.survivalBase(ctx);
    const name = 'G6B TXN crash crate';
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const W = { dir: path.join(L.SAVES, name), at: [CX + 40, gy + 2, CZ + 60] };
    await L.tp(...W.at);
    let k = 0;
    const slot = () => { const i = k++; return [CX + 24 * (i % 6), gy + 1, CZ + 40 + 40 * Math.floor(i / 6)]; };
    const single = async (tag) => {
      const origin = slot();
      const site = await playerSite(tag, origin);
      W.at = [origin[0], gy + 2, origin[2] - 6];
      await L.tp(...W.at);
      return site;
    };
    const grouped = async (tag, n = 1, owner = null) => {
      const gat = slot();
      if (n > 1) k++; // a wider slot
      W.at = [gat[0] + 3, gy + 2, gat[2] + 24];
      await L.tp(...W.at);
      return groupSites(tag, gat, n, owner);
    };

    // ---------------------------------------------------------------- the trace: a clean single removal's TX:crate.settle points
    let points = [];
    {
      const site = await single('trace');
      if (site) {
        const { cp, items } = await fill('trace', site);
        const before = await parts([site], cp, items);
        await call('dev.txn.trace', { on: true }, 10_000);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        points = ((await call('dev.txn.trace', { on: false }, 10_000).catch(() => ({}))).trace ?? []).filter((p) => p.startsWith('TX:crate.settle:'));
        const after = await parts([site], cp, items);
        out.trace = { points, removal: rm };
        log(`  trace: ${points.length} crate.settle point(s): ${points.join(' ') || '(none: no crate.settle kind on this build)'}`);
        judge(R, 'trace', { tag: 'trace', sites: [site], txn: await txn() }, before, after);
      }
    }
    const removalPoints = ['K5', 'K6', 'R4'];
    const all = [...removalPoints, ...points];
    // ---------------------------------------------------------------- single
    for (const p of all) {
      for (const v of ['', '+save']) {
        const tag = `S-${p.replace(/^TX:crate\.settle:/, 'TX:')}${v ? 's' : ''}`;
        if (!want(tag)) continue;
        const site = await single(tag);
        if (site) await crashRow(R, tag, W, [site], p + v, () => call('dev.site.deconstruct', { site }, 60_000));
      }
    }
    // ---------------------------------------------------------------- group (a shared crate, one member)
    for (const p of all) {
      for (const v of ['', '+save']) {
        const tag = `G-${p.replace(/^TX:crate\.settle:/, 'TX:')}${v ? 's' : ''}`;
        if (!want(tag)) continue;
        const g = await grouped(tag);
        if (g.sites.length) await crashRow(R, tag, W, g.sites, p + v, () => api(`sgremove ${g.group}`), g.group);
      }
    }
    // ---------------------------------------------------------------- P1-1: the pickup's evidence is the owed ledger
    if (want('P1-1')) {
      const tag = 'P1-1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        // a pickup: the player on the crate's cell (any drop there is picked up); the site's owed entries collected (the give's own save)
        await L.tp(cp[0] + 0.5, cp[1] + 1, cp[2] + 0.5);
        await wait(2000);
        const collected = [];
        for (const e of (await owedAll()).owed ?? []) {
          if (e.site === site) collected.push(await call('dev.owed.collect', { recipient: e.recipient, key: e.key }, 120_000).catch((x) => ({ error: String(x) })));
        }
        const mid = await parts([site], cp, items);
        log(`  ${tag}: after the pickup: ${json(mid.total)} (inventory ${json(mid.inventory)}, owed ${json(mid.owed)}, ground ${json(mid.ground)})`);
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null); // the chunks saved (an autosave), the players' files not
        const down = await haltWait();
        check(down, `${tag}: halted (+save) after the pickup`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          const after = await parts([site], cp, items);
          judge(R, tag, { tag, sites: [site], removal: rm, collected, mid, txn: r.txn }, before, after);
          check(G.same(after.inventory, mid.inventory) && G.same(after.owed, mid.owed),
            `${tag}: the pickup survived the crash as it was before it (inventory ${json(after.inventory)} = ${json(mid.inventory)}, owed ${json(after.owed)})`, { mid, after });
        }
      }
    }
    // ---------------------------------------------------------------- P1-2: a settle whose barrier fails after its decision is held
    if (want('P1-2')) {
      const tag = 'P1-2';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        const fb = await call('dev.txn.failBarrier', { skip: 1, n: 200 }, 10_000).catch((e) => ({ error: String(e) }));
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(1500);
        const t1 = await txn();
        const mid = await parts([site], cp, items);
        log(`  ${tag}: barrier refused after the decision (${json(fb)}): txn open ${t1.openCount}, held ${t1.heldCount}; ground ${json(mid.ground)}`);
        check(sum(mid.ground) === 0 && (t1.heldCount ?? 0) >= 1, `${tag}: the settle held, never discarded: held ${t1.heldCount}, nothing dropped (${json(mid.ground)})`, { t1, mid });
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted (+save) while held`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          judge(R, tag, { tag, sites: [site], removal: rm, mid, held: t1, txn: r.txn }, before, await parts([site], cp, items));
        }
      }
    }
    // ---------------------------------------------------------------- P1-3: a two-member group's refunds, halted between the members
    if (want('P1-3')) {
      for (const point of ['GW', 'GW+save']) {
        const tag = `P1-3${point.endsWith('+save') ? 's' : ''}`;
        const g = await grouped(tag, 2);
        if (g.sites.length === 2) await crashRow(R, tag, W, g.sites, point, () => api(`sgremove ${g.group}`), g.group, true);
      }
    }
    // ---------------------------------------------------------------- P1-4: a removal that ends before its commit never touched the crate
    if (want('P1-4')) {
      const tag = 'P1-4';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await parts([site], cp, items);
        await call('dev.journal.failNextCommit', {}, 10_000);
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e).slice(0, 200) }));
        await wait(1500);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000).catch(() => null); // the builder consumes what the crate holds
        for (let i = 0; i < 30; i++) {
          if (sum((await siteState(site))?.ledger?.stock) === 0) break;
          await L.sleep(500);
        }
        const mid = await parts([site], cp, items);
        call('dev.txn.halt', { save: true }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted (+save) after the builder consumed (removal: ${json(rm).slice(0, 160)})`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          const r = await settleWait([site], cp, null);
          judge(R, tag, { tag, sites: [site], removal: rm, mid, txn: r.txn }, before, await parts([site], cp, items));
        }
      }
    }
    // ---------------------------------------------------------------- the must-fix rows: a crate held by an aborted test.move out of it
    const hold = async (tag, cp, item) => {
      const chest = [cp[0], cp[1] + 4, cp[2]];
      await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
      await cmd('/save-off');
      const r = await call('dev.txn.run', { from: cp, to: chest, items: { [item]: 1 } }, 120_000).catch((e) => ({ error: String(e) }));
      const t = await txn();
      log(`  ${tag}: the crate held: ${json(r).slice(0, 160)}; txn open ${t.openCount}, held ${t.heldCount}`);
      check(t.openCount >= 1, `${tag}: the crate at ${cp} held by an open txn (open ${t.openCount}: ${r.status ?? r.error ?? ''})`, t);
      return chest;
    };
    const unhold = async () => {
      await cmd('/save-on');
      await cmd('/save-all').catch(() => null);
      for (let i = 0; i < 60 && (await txn()).openCount > 0; i++) await L.sleep(1000);
    };
    if (want('MF1')) {
      const tag = 'MF1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await hold(tag, cp, items[0]);
        const s0 = await siteState(site);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        await wait(6000);
        const s1 = await siteState(site);
        R[tag] = { s0: { built: s0?.built, stock: s0?.ledger?.stock, placed: s0?.ledger?.placed }, s1: { built: s1?.built, stock: s1?.ledger?.stock, placed: s1?.ledger?.placed } };
        check(G.same(s1?.ledger?.stock, s0?.ledger?.stock) && G.same(s1?.ledger?.placed, s0?.ledger?.placed),
          `${tag}: a held crate funds nothing: over 6 s unpaused, stock ${json(s1?.ledger?.stock)} = ${json(s0?.ledger?.stock)}, placed ${sum(s1?.ledger?.placed)} = ${sum(s0?.ledger?.placed)}`, R[tag]);
        await unhold();
        await wait(4000);
        const s2 = await siteState(site);
        R[tag].s2 = { stock: s2?.ledger?.stock, placed: s2?.ledger?.placed };
        check(sum(s2?.ledger?.placed) > sum(s0?.ledger?.placed), `${tag}: released, the site builds from it again (placed ${sum(s2?.ledger?.placed)})`, R[tag]);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000).catch(() => null);
      }
    }
    if (want('MF2')) {
      const tag = 'MF2';
      const owner = 'tcc-mf2';
      const g = await grouped(tag, 1, owner);
      if (g.sites.length) {
        const site = g.sites[0];
        const { cp, items } = await fill(tag, site);
        const s0 = await siteState(site);
        await hold(tag, cp, items[0]);
        const sp = slot();
        const cr = await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
        const ad = await call('dev.stockpile.adopt', { owner }, 120_000).catch((e) => ({ refused: String(e) }));
        await wait(1500);
        const s1 = await siteState(site);
        const grp = await api(`sgroup ${g.group}`).catch(() => null);
        R[tag] = { create: cr, adopt: ad, s0: s0?.crate, s1: s1?.crate, stock0: s0?.ledger?.stock, stock1: s1?.ledger?.stock, group: grp };
        log(`  ${tag}: adopt with the crate held: ${json(ad).slice(0, 200)}; the site's crate ${json(s1?.crate)}`);
        check(!!s1?.crate?.present && s1.crate.x === cp[0] && s1.crate.z === cp[2] && G.same(s1?.ledger?.stock, s0?.ledger?.stock),
          `${tag}: an adoption that skips a held crate keeps its references: the site still builds from its crate at ${cp} (${json(s1?.crate)}), stock ${json(s1?.ledger?.stock)}`, R[tag]);
        await unhold();
      }
    }
    if (want('MF4')) {
      const tag = 'MF4';
      const at = slot();
      k += 2;
      const y = gy + 1;
      const X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tccmf4${Date.now() % 100000}`, proximity: false, sharedCrate: true, autoApprove: true, crateAt: [X + 10, y, Z - 8],
        items: [{ key: 'h1', bp: 'rs_hut', at: [X, y, Z - 24], rot: 0, mode: 'CONSTRUCTION' }, { key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const it = Object.fromEntries((bv?.items ?? []).map((x) => [x.key, x]));
      const roadId = it.r1?.site, hut = it.h1?.site;
      check(!!roadId && !!hut, `${tag}: a group with a hut and a construction road from one shared crate (${hut}, ${roadId}; ${json(bv?.items?.map((x) => [x.key, x.status, x.reason]))})`, bv);
      if (roadId && hut) {
        await call('dev.stockpile.pause', { site: roadId, paused: true }, 60_000).catch(() => null);
        const { cp, items } = await fill(tag, hut);
        await call('dev.site.finish', { site: hut }, 60_000);
        await wait(1500);
        await hold(tag, cp, items[0]);
        const fin = await call('dev.site.finish', { site: roadId }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const rv = (await api('sites')).all.find((s) => s.id === roadId);
        R[tag] = { finish: fin, held: rv?.state, crate: isCrate(await cellOf(cp)) };
        check(rv?.state === 'BUILDING' && R[tag].crate, `${tag}: the last road over a held crate stays BUILDING (${rv?.state}; the crate ${R[tag].crate ? 'stands' : 'is gone'})`, R[tag]);
        await unhold();
        let done;
        for (let i = 0; i < 30; i++) { done = (await api('sites')).all.find((s) => s.id === roadId); if (done?.state === 'BUILT') break; await L.sleep(1000); }
        R[tag].after = done?.state;
        check(done?.state === 'BUILT' && !isCrate(await cellOf(cp)), `${tag}: released, the road completes: ${done?.state}, its crate settled`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- MF3: a completed site's leftovers through crate.settle
    if (want('MF3')) {
      const tag = 'MF3';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        await cmd('/save-all flush').catch(() => null);
        const before = await parts([site], cp, items);
        const fin = await call('dev.site.finish', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const st = await siteState(site);
        const after = await parts([site], cp, items);
        // built: the site stands BUILT; its placed cells were finished free, so only the crate's stock moves: from the crate to the owed ledger
        const left = G.plus(before.stock, {});
        const owedNow = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([k2, v]) => [k2, -v])));
        R[tag] = { finish: fin, state: st?.state, before, after, owedNew: owedNow };
        log(`  ${tag}: finished ${json(fin)}: ${st?.state}; leftovers ${json(left)}, owed new ${json(owedNow)}, ground ${json(after.ground)}, crate ${after.crate ? 'stands' : 'restored'}`);
        check(st?.state === 'built' || st?.state === 'BUILT', `${tag}: the site is built (${st?.state})`, st);
        check(sum(after.ground) === 0 && G.same(owedNow, left) && !after.crate, `${tag}: the crate's leftovers ${json(left)} owed (new ${json(owedNow)}), none dropped (${json(after.ground)}), its cell restored`, R[tag]);
      }
    }
    await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    await L.leaveWorld();
    const rows = Object.values(R);
    out.summary = { points: points.length, rows: rows.length };
    log(`  txn-crash-crate: ${json(out.summary)}`);
    spendZero();
    return out;
  };
}
