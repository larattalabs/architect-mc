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
//                   two-member group's refunds are keyed effects, never queue amounts (halted at GM, bare and +save: the first member written and settled, the second not); (4) a
//                   removal ended before its commit (dev.journal.failNextCommit) never touched the crate (the builder then consumes)
//     MF1, MF2, MF4 the coordinator's must-fix rows: a held crate never funds a placement; an adoption that skips a held crate keeps every
//                   reference to it; the last road over a held crate stays BUILDING. A crate is held by a test.move out of it with
//                   every txn barrier refused (dev.txn.failBarrier: the move aborts, its take compensated, the hold kept until one works)
//     MF3           a completed site's crate leftovers (dev.site.finish over a stocked crate) go through crate.settle: owed, never dropped
//   judged: the units (crate stock + placed + owed + ground + inventory) after = before, item for item; no item entity near the crate
//   (rule R-5: nothing dropped); txn open 0; a gone site's crate cell restored and its owed entry naming the site. On the base (main's
//   take-at-prepare + drop) the TX rows are N/A (no crate.settle kind): the trace finds none.
//
//   GATE_TCC_PARTS=S,G,P1,MF (default all) or a list of row tags limits the rows.
// Evidence: <out>/txncrashcrate.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';

export async function registerTCC(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, cellsOf } = h;
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
  // a halt waited at most 90 s (the shared haltWait's 6 min would trip the runner's 5 min stall guard on a point never reached)
  const haltWait = async () => {
    for (let i = 0; i < 45; i++) {
      await L.sleep(2000);
      const st = await call('dev.state', {}, 10_000).catch(() => null);
      if (st && st.inWorld === false) return true;
    }
    return false;
  };
  const siteState = async (site) => call('dev.site.state', { site }, 60_000).catch(() => null);
  const owedAll = async () => (await call('dev.stockpile.owed', {}, 30_000).catch(() => null)) ?? { owed: [], total: {} };
  const txn = async () => call('dev.txn.state', {}, 30_000).catch(() => ({ openCount: -1 }));
  const cellOf = async (cp) => (await call('dev.txn.cells', { cells: [cp] }, 30_000).catch(() => ({})))[cp.join(',')] ?? {};
  const isCrate = (c) => /crate/.test(String(c?.be ?? '')) || /crate/.test(String(c?.state ?? ''));

  /** The crate's own stock (dev.txn.cells: its ledger, whether a site still reads it or not), item -> units. */
  const crateItems = async (cp) => {
    const out = {};
    for (const v of Object.values((await cellOf(cp)).slots ?? {})) {
      const m = /^(\S+) x(\d+)$/.exec(String(v));
      if (m) out[m[1]] = (out[m[1]] ?? 0) + Number(m[2]);
    }
    return out;
  };
  // (last round) each site's box, read while it stands: its placed items are counted from the blocks in the world, never its ledger (a
  // record that vanished must not hide a block still standing)
  const BOXES = {};
  const boxOf = async (site) => {
    if (!BOXES[site]) {
      const v = ((await api('sites').catch(() => ({ all: [] }))).all ?? []).find((x) => x.id === site);
      const m = v && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(v.box);
      if (m) BOXES[site] = m.slice(1, 7).map(Number);
    }
    return BOXES[site] ?? null;
  };
  /** Blocks of {@code items} standing in {@code site}'s box (a block id counted as its item: cobblestone, glass_pane, copper_block, gravel). */
  async function standing(site, items) {
    const b = await boxOf(site);
    if (!b) return {};
    const out = {};
    for (const st of (await cellsOf(b)).values()) {
      const id = String(st).replace(/\[.*$/, '').replace(/(^|:)wall_torch$/, '$1torch'); // (T4b) a wall torch is its torch item
      const full = id.includes(':') ? id : `minecraft:${id}`;
      if (items.includes(full)) out[full] = (out[full] ?? 0) + 1;
    }
    return out;
  }

  /** The units of {@code items} for {@code sites}: their crate's stock, the blocks standing in their boxes, the owed total, the ground near the crate, the inventory. */
  async function parts(sites, cp, items) {
    let placed = {};
    const st = {};
    for (const s of sites) {
      const v = await siteState(s);
      st[s] = v ? v.state : null;
      placed = G.plus(placed, await standing(s, items));
    }
    const stock = await crateItems(cp);
    const ow = await owedAll();
    const near = await call('dev.items.near', { pos: cp, radius: 8 }, 30_000);
    const cell = await cellOf(cp);
    // (T4b fix round) owed counted from the entries naming these sites (an earlier row's held txn that finishes later is not this row's)
    const own = {};
    for (const e of ow.owed ?? []) if (sites.includes(e.site)) for (const [k2, v] of Object.entries(e.items ?? {})) own[k2] = (own[k2] ?? 0) + v;
    const p = { stock: pick(stock, items), placed: pick(placed, items), owed: pick(own, items), ground: pick(near.items ?? {}, items),
      inventory: pick(near.inventory ?? {}, items), states: st, crate: isCrate(cell), owedEntries: (ow.owed ?? []).filter((e) => sites.includes(e.site)) };
    p.total = [p.stock, p.placed, p.owed, p.ground, p.inventory].reduce((a, b) => G.plus(a, b), {});
    return p;
  }

  /** A site's crate: paused, part of its bill in it ({@code build}: a first part placed first, so it has refunds). Its cell and the items. */
  async function fill(tag, site, build = false, stock = true) {
    for (let i = 0; i < 120; i++) {
      if ((await siteState(site))?.state === 'building') break;
      await L.sleep(1000);
    }
    await boxOf(site);
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
    if (!stock) return null; // (a shared crate's earlier member: its first part placed; the stock goes in once, for the last)
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

  function judge(out, tag, n, before, after, { committedOk = true, standsStock = true } = {}) {
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
    if (!gone && standsStock) check(after.crate && G.same(after.stock, before.stock), `${tag}: not committed: the site stands (${json(after.states)}), its crate holds its stock again ${json(after.stock)}`, n);
  }

  /** One crash row: the baseline, {@code point} armed, {@code remove}, the halt, the world again, the recovery, the judgement. */
  async function crashRow(out, tag, W, sites, point, remove, group = null, build = false) {
    for (const s of sites.slice(0, -1)) await fill(tag, s, build, false);
    const { cp, items } = await fill(tag, sites[sites.length - 1], build);
    await cmd('/save-all flush').catch(() => null);
    await wait(2000);
    const before = await parts(sites, cp, items);
    await call('dev.journal.killAt', { point }, 10_000);
    const m = await remove().catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
    const down = await haltWait();
    // a txn point an effect's probe skips on this path is never reached (the group's shared crate: its CRATE entry is released by the
    // group removal first, so the R effect probes APPLIED): recorded, and the row judged as the removal left it; a removal point must halt
    if (down || !point.startsWith('TX:')) check(down, `${tag}: halted at ${point} (${json(m).slice(0, 160)})`);
    else log(`  ${tag}: ${point} not reached on this path (its effect's probe answered APPLIED); judged without a restart`);
    if (!down) {
      // never reached: the removal ran past it (judged as it stands, no restart), so the row still says where the stock went
      await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
      const r0 = await settleWait(sites, cp, group);
      const pts = await call('dev.txn.points', { kind: 'crate.settle' }, 10_000).catch(() => null);
      judge(out, tag, { tag, point, sites, group, crate: cp, removal: m, txn: r0.txn, groupEnd: r0.group, halted: false, reached: pts }, before, await parts(sites, cp, items));
      return;
    }
    await L.openWorld(path.basename(W.dir));
    await L.tp(...W.at);
    const r = await settleWait(sites, cp, group);
    const after = await parts(sites, cp, items);
    judge(out, tag, { tag, point, sites, group, crate: cp, removal: m, txn: r.txn, groupEnd: r.group }, before, after);
  }

  const P = (process.env.GATE_TCC_PARTS ?? 'S,G,P1,MF,FR,LR').split(',');
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
      for (const point of ['GM', 'GM+save']) {
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
          // the builder consumed the stock after the refused removal: the units are placed now, not in the crate
          judge(R, tag, { tag, sites: [site], removal: rm, mid, txn: r.txn }, before, await parts([site], cp, items), { standsStock: false });
          check(rm.removed === false, `${tag}: the removal ended before its commit (${json(rm).slice(0, 120)})`, rm);
        }
      }
    }
    // ---------------------------------------------------------------- the must-fix rows: a crate held by an aborted test.move out of it
    const hold = async (tag, cp, item) => {
      const chest = [cp[0], cp[1] + 4, cp[2]];
      await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
      // every txn barrier refused (dev.txn.failBarrier), not /save-off: an adoption's own ledger save must still work under the hold
      await call('dev.txn.failBarrier', { n: 1_000_000 }, 10_000);
      const r = await call('dev.txn.run', { from: cp, to: chest, items: { [item]: 1 } }, 120_000).catch((e) => ({ error: String(e) }));
      const t = await txn();
      log(`  ${tag}: the crate held: ${json(r).slice(0, 160)}; txn open ${t.openCount}, held ${t.heldCount}`);
      check(t.openCount >= 1, `${tag}: the crate at ${cp} held by an open txn (open ${t.openCount}: ${r.status ?? r.error ?? ''})`, t);
      return chest;
    };
    const unhold = async () => {
      await call('dev.txn.failBarrier', { n: 0 }, 10_000);
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
        check(G.same(s1?.ledger?.stock, s0?.ledger?.stock) && G.same(s1?.ledger?.placed, s0?.ledger?.placed) && s1?.built === s0?.built,
          `${tag}: a held crate funds nothing (and nothing is placed for free): over 6 s unpaused, stock ${json(s1?.ledger?.stock)} = ${json(s0?.ledger?.stock)}, placed ${sum(s1?.ledger?.placed)} = ${sum(s0?.ledger?.placed)}, cells built ${s1?.built} = ${s0?.built}`, R[tag]);
        await unhold();
        await wait(4000);
        const s2 = await siteState(site);
        R[tag].s2 = { built: s2?.built, stock: s2?.ledger?.stock, placed: s2?.ledger?.placed };
        check(sum(s2?.ledger?.placed) > sum(s0?.ledger?.placed) || s2?.built > s1?.built, `${tag}: released, the site builds from it again (placed ${sum(s2?.ledger?.placed)})`, R[tag]);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000).catch(() => null);
      }
    }
    if (want('MF2')) {
      const tag = 'MF2';
      const owner = 'tcc:mf2'; // a stockpile owner is <modid>:<thing>
      const g = await grouped(tag, 1, owner);
      if (g.sites.length) {
        const site = g.sites[0];
        const { cp, items } = await fill(tag, site);
        const s0 = await siteState(site);
        const c0 = (await cellOf(cp)).slots ?? {};
        await hold(tag, cp, items[0]);
        const sp = slot();
        const cr = await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
        const ad = await call('dev.stockpile.adopt', { owner }, 120_000).catch((e) => ({ refused: String(e) }));
        await wait(1500);
        const s1 = await siteState(site);
        const c1 = (await cellOf(cp)).slots ?? {};
        const grp = await api(`sgroup ${g.group}`).catch(() => null);
        // the crate's own ledger (dev.txn.cells): the site's state reads its owner's pile once one exists
        R[tag] = { create: cr, adopt: ad, s0: s0?.crate, s1: s1?.crate, crate0: c0, crate1: c1, group: grp };
        log(`  ${tag}: adopt with the crate held: ${json(ad).slice(0, 200)}; the site's crate ${json(s1?.crate)}`);
        check(!!s1?.crate?.present && s1.crate.x === cp[0] && s1.crate.z === cp[2] && Object.keys(c0).length > 0 && json(c1) === json(c0),
          `${tag}: an adoption that skips a held crate keeps its references: the site still builds from its crate at ${cp} (${json(s1?.crate)}), the crate's stock unchanged ${json(c1)}`, R[tag]);
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
    // ================================================================ (fix round) FR rows: each red on 2c4c59aa, green after
    const noBarriers = (n) => call('dev.txn.failBarrier', { n }, 10_000);
    const roadGroup = async (tag) => {
      // a hut and a paid construction road (stone under it: a gravel surface) from one shared crate
      const at = slot();
      k += 2;
      const y = gy + 1, X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tcc${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}${Date.now() % 100000}`, proximity: false, sharedCrate: true,
        autoApprove: true, crateAt: [X + 10, y, Z - 8], items: [{ key: 'h1', bp: 'rs_hut', at: [X, y, Z - 24], rot: 0, mode: 'CONSTRUCTION' }, { key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const it = Object.fromEntries((bv?.items ?? []).map((x) => [x.key, x]));
      check(!!it.r1?.site && !!it.h1?.site, `${tag}: a hut and a construction road from one shared crate (${it.h1?.site}, ${it.r1?.site})`, bv);
      return { hut: it.h1?.site, road: it.r1?.site, group: bv?.group };
    };
    const roadState = async (id) => (await api('sites')).all.find((x) => x.id === id) ?? null;
    /** A road's units: the crate's stock, the owed total, the ground near the crate and near the road, the inventory; whether it stands. */
    const roadParts = async (roadId, cp, items, mid) => {
      const ow = await owedAll();
      const near = await call('dev.items.near', { pos: cp, radius: 8 }, 30_000);
      const nearR = await call('dev.items.near', { pos: mid, radius: 16 }, 30_000);
      const rv = await roadState(roadId);
      return { stands: !!rv, state: rv?.state ?? null, crate: isCrate(await cellOf(cp)), stock: pick(await crateItems(cp), items), owed: pick(ow.total, items),
        ground: pick(G.plus(near.items ?? {}, nearR.items ?? {}), items), inventory: pick(near.inventory ?? {}, items) };
    };
    /** The road paid for some cells (part of its bill inserted and built, then paused) and more stock in the crate: what was paid, what is stock. */
    const payRoad = async (tag, g) => {
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      const bill = (await api(`stock ${g.group}`)).outstandingBySite?.[g.road] ?? {};
      const half = {};
      for (const [kk, v] of Object.entries(bill)) half[kk] = Math.max(1, Math.floor(v / 2));
      const a1 = (await call('dev.crate.insert', { site: g.road, items: half, exact: true }, 120_000)).accepted ?? {};
      await call('dev.stockpile.pause', { site: g.road, paused: false }, 60_000);
      const cpos = (await api(`stock ${g.group}`)).crate;
      const cp = typeof cpos === 'string' ? cpos.split(',').map(Number) : Array.isArray(cpos) ? cpos : [cpos?.x, cpos?.y, cpos?.z];
      for (let i = 0; i < 60; i++) { if (sum(await crateItems(cp)) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000);
      const left = await crateItems(cp);
      const a2 = (await call('dev.crate.insert', { site: g.road, items: half, exact: true }, 120_000)).accepted ?? {};
      await wait(1500);
      const items = Object.keys(bill);
      const paid = G.plus(pick(a1, items), Object.fromEntries(Object.entries(pick(left, items)).map(([x, v]) => [x, -v])));
      check(sum(paid) > 0 && sum(await crateItems(cp)) > 0, `${tag}: ${g.road} paid for ${json(paid)} (built from the crate), the crate at ${cp} holds ${json(await crateItems(cp))}`, { a1, a2, left });
      return { cp, items, paid };
    };
    const roadMid = (g) => W.at;
    // ---------------------------------------------------------------- FR-a1 (P1-a): a completing site, both barriers refused
    if (want('FR-a1')) {
      const tag = 'FR-a1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        const before = await parts([site], cp, items);
        await noBarriers(1_000_000); // the settle's prepare barrier and its compensation's barrier: every barrier refused
        const fin = await call('dev.site.finish', { site }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const st = await siteState(site);
        const mid = await parts([site], cp, items);
        R[tag] = { finish: fin, state: st?.state, before, mid };
        // dev.site.finish places the rest free: the blocks it put down are not the crate's units, so this row counts crate + owed + ground + inventory
        const units = (x) => [x.stock, x.owed, x.ground, x.inventory].reduce((a, b) => G.plus(a, b), {});
        before.total = units(before);
        mid.total = units(mid);
        check(st?.state === 'building' && mid.crate && G.same(mid.total, before.total) && sum(mid.ground) === 0,
          `${tag}: a completing site whose settle's barriers are refused stays BUILDING (${st?.state}), its crate kept (${mid.crate ? 'stands' : 'gone'}), nothing lost: ${json(mid.total)} = ${json(before.total)}`, R[tag]);
        await noBarriers(0);
        let s2;
        for (let i = 0; i < 30; i++) { s2 = await siteState(site); if (s2?.state === 'built') break; await L.sleep(1000); }
        const after = await parts([site], cp, items);
        after.total = units(after);
        R[tag].after = after;
        check(s2?.state === 'built' && !after.crate && G.same(after.total, before.total) && sum(after.ground) === 0,
          `${tag}: barriers working again, it completes once: ${s2?.state}, leftovers owed (${json(after.owed)}), ${json(after.total)} = ${json(before.total)}`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- FR-a2 (P1-a): the last road over a crate, both barriers refused
    if (want('FR-a2')) {
      const tag = 'FR-a2';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
        const { cp, items } = await fill(tag, g.hut);
        await call('dev.site.finish', { site: g.hut }, 60_000);
        await wait(1500);
        const b0 = await roadParts(g.road, cp, items, roadMid(g));
        await noBarriers(1_000_000);
        const fin = await call('dev.site.finish', { site: g.road }, 60_000).catch((e) => ({ error: String(e) }));
        await wait(3000);
        const m0 = await roadParts(g.road, cp, items, roadMid(g));
        R[tag] = { finish: fin, before: b0, mid: m0 };
        check(m0.state === 'BUILDING' && m0.crate && G.same(m0.stock, b0.stock) && G.same(m0.owed, b0.owed) && sum(m0.ground) === 0,
          `${tag}: the last road over a crate whose settle's barriers are refused stays BUILDING (${m0.state}), the crate kept with its stock ${json(m0.stock)} (${m0.crate ? 'stands' : 'gone'}), nothing owed or dropped`, R[tag]);
        await noBarriers(0);
        let done;
        for (let i = 0; i < 30; i++) { done = await roadState(g.road); if (done?.state === 'BUILT') break; await L.sleep(1000); }
        const a0 = await roadParts(g.road, cp, items, roadMid(g));
        check(done?.state === 'BUILT' && !a0.crate && G.same(G.plus(a0.owed, a0.stock), G.plus(b0.owed, b0.stock)), `${tag}: barriers working again, the road completes and its crate's stock is owed once (${done?.state}, owed ${json(a0.owed)})`, a0);
      }
    }
    // ---------------------------------------------------------------- FR-b (P1-b): a paid road removal halted at decided; a shared crate's road
    for (const v of ['', '+save']) {
      const tag = `FR-b1${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const g = await roadGroup(tag);
      if (!g.road) continue;
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      await fill(tag, g.hut);
      await call('dev.site.finish', { site: g.hut }, 60_000); // the hut built: the road is the last to build from the crate
      await wait(1500);
      const { cp, items, paid } = await payRoad(tag, g);
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await roadParts(g.road, cp, items, roadMid(g));
      await call('dev.journal.killAt', { point: 'TX:crate.settle:decided' + v }, 10_000);
      const m = await api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at TX:crate.settle:decided${v} in the paid road's removal (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([], cp, null, 30_000);
      for (let i = 0; i < 40 && (await roadState(g.road)); i++) await L.sleep(1000); // the removal job resumes
      await wait(2000);
      const after = await roadParts(g.road, cp, items, roadMid(g));
      const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
      const want2 = G.plus(before.stock, paid); // the crate's stock and the paid cells' refunds, once
      R[tag] = { before, after, paid, owedNew };
      log(`  ${tag}: after the restart: road ${after.stands ? after.state : 'gone'}, owed new ${json(owedNew)} (stock ${json(before.stock)} + paid ${json(paid)}), ground ${json(after.ground)}`);
      check(after.stands ? sum(owedNew) === 0 || G.same(owedNew, before.stock) : G.same(owedNew, want2),
        `${tag}: paid once: ${after.stands ? 'the road stands, so its refunds are not owed' : 'the road is gone'} (owed new ${json(owedNew)}; stock ${json(before.stock)}, paid cells ${json(paid)})`, R[tag]);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, R[tag]);
    }
    if (want('FR-b2')) {
      const tag = 'FR-b2';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.hut, paused: true }, 60_000).catch(() => null); // the hut still builds: the crate is shared
        const { cp, items, paid } = await payRoad(tag, g);
        const before = await roadParts(g.road, cp, items, roadMid(g));
        const m = await later(`remove ${g.road} - noforce`, 120_000).catch((e) => ({ error: String(e) }));
        for (let i = 0; i < 30 && (await roadState(g.road)); i++) await L.sleep(1000);
        await wait(2000);
        const after = await roadParts(g.road, cp, items, roadMid(g));
        const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
        R[tag] = { removal: m, before, after, paid, owedNew };
        log(`  ${tag}: a shared crate's road removed: ${json(m).slice(0, 160)}; ground ${json(after.ground)}, owed new ${json(owedNew)}`);
        check(!after.stands && G.same(owedNew, paid) && sum(after.ground) === 0 && after.crate && G.same(after.stock, before.stock),
          `${tag}: a shared crate's road removed: its refunds ${json(paid)} owed (${json(owedNew)}), none dropped (${json(after.ground)}); the crate stays for the hut with its stock`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- FR-c (P1-c): paid cells' refunds across K6 (commit durable, record not)
    for (const v of ['', '+save']) {
      const tag = `FR-c${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const site = await single(tag);
      if (site) await crashRow(R, tag, W, [site], 'K6' + v, () => call('dev.site.deconstruct', { site }, 60_000), null, true);
    }
    // ---------------------------------------------------------------- FR-d (P2-a): an aborted collect gives nothing and says so
    if (want('FR-d')) {
      const tag = 'FR-d';
      await cmd('/clear @s');
      const key = `test:owed/fr-d-${Date.now() % 100000}`;
      const P0 = 'minecraft:oak_planks';
      const ad = await call('dev.owed.add', { key, items: { [P0]: 6 }, at: W.at }, 30_000);
      for (let i = 0; i < 5; i++) { const b = await call('dev.stockpile.barrier', { run: true }, 120_000).catch(() => null); if (b?.last?.outcome === 'OK') break; await wait(1000); }
      await noBarriers(1); // the collect's first barrier refused: it aborts (nothing given); its abort's barrier works
      const r = await call('dev.owed.collect', { recipient: ad.recipient, key }, 120_000).catch((e) => ({ error: String(e) }));
      const inv = ((await call('dev.items.near', { pos: W.at, radius: 2 }, 30_000)).inventory ?? {})[P0] ?? 0;
      const ow = ((await owedAll()).owed ?? []).find((e) => e.key === key);
      await noBarriers(1);
      const c = await cmd(`/architect collect "${key}"`).catch((e) => ({ messages: [String(e)] }));
      const said = (c.messages ?? []).join(' ');
      const inv2 = ((await call('dev.items.near', { pos: W.at, radius: 2 }, 30_000)).inventory ?? {})[P0] ?? 0;
      R[tag] = { r, inv, owed: ow?.items, said, inv2 };
      check(sum(r.given) === 0 && inv === 0 && (ow?.items?.[P0] ?? 0) === 6, `${tag}: an aborted collect reports nothing given (${json(r.given)}, ${r.status} ${r.why ?? ''}); inventory ${inv}, still owed ${ow?.items?.[P0]}`, R[tag]);
      check(!/Collected [1-9]/.test(said) && inv2 === 0, `${tag}: /architect collect, aborted, does not say it collected: "${said.slice(0, 160)}" (inventory ${inv2})`, R[tag]);
      await noBarriers(0);
      await cmd('/clear @s');
    }
    // ---------------------------------------------------------------- FR-e (P2-b): owed amounts never in the refund totals
    if (want('FR-e')) {
      const tag = 'FR-e';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site);
        const before = await parts([site], cp, items);
        const rm = await later(`remove ${site} - noforce`, 120_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        const after = await parts([site], cp, items);
        const owedNew = sum(after.owed) - sum(before.owed);
        R[tag] = { removal: rm, owedNew };
        check(rm.removed === true && owedNew > 0 && (rm.refundTotal ?? -1) === 0,
          `${tag}: a crate-fed removal with nothing credited: refund total ${rm.refundTotal} (owed ${owedNew} listed apart, never in it)`, R[tag]);
      }
    }
    // ================================================================ (last round) LR rows: each red on 47587b40, green after
    const ps = (o) => call('dev.stockpile.ps', o, 10_000);
    /** A player's site built whole from its crate (its full bill inserted, then built: every cell paid); its crate settled at completion. */
    const builtPaid = async (tag) => {
      const site = await single(tag);
      if (!site) return null;
      await boxOf(site);
      for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
      const st0 = await siteState(site);
      const cp = [st0.crate.x, st0.crate.y, st0.crate.z];
      await call('dev.crate.insert', { site, items: st0.bom ?? {}, exact: false }, 120_000);
      let st;
      for (let i = 0; i < 240; i++) { st = await siteState(site); if (st?.state === 'built') break; await L.sleep(1000); }
      check(st?.state === 'built', `${tag}: ${site} built from its crate, every cell paid (${st?.state}, placed ${sum(st?.ledger?.placed)})`, st);
      return { site, cp, items: Object.keys(st0.bom ?? {}) };
    };
    // ---------------------------------------------------------------- LR-1 (P1 1): the stash save refused: the removal does not commit
    if (want('LR-1')) {
      const tag = 'LR-1';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await fill(tag, site, true); // a first part paid and placed: refunds to stash
        const before = await parts([site], cp, items);
        await ps({ failLedgerWrites: 1000 });
        const rm = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ error: String(e).slice(0, 200) }));
        await ps({ failLedgerWrites: 0 });
        await wait(1500);
        const after = await parts([site], cp, items);
        R[tag] = { removal: rm, before, after };
        log(`  ${tag}: the ledger's writes refused: ${json(rm).slice(0, 200)}; ${json(after.states)}`);
        check(rm.removed === false && after.states[site] && after.crate && G.same(after.total, before.total),
          `${tag}: a removal whose refund stash can't be saved confirmed does not commit: removed ${rm.removed}, the site ${json(after.states)}, crate ${after.crate ? 'stands' : 'gone'}, ${json(after.total)} = ${json(before.total)}`, R[tag]);
      }
    }
    // ---------------------------------------------------------------- LR-2 (P1 2): K6 on a completed paid site, brought back: no refund
    for (const v of ['', '+save']) {
      const tag = `LR-2${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const b = await builtPaid(tag);
      if (!b) continue;
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await parts([b.site], b.cp, b.items);
      await call('dev.journal.killAt', { point: 'K6' + v }, 10_000);
      const m = await call('dev.site.deconstruct', { site: b.site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at K6${v} in the built site's removal (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([b.site], b.cp, null, 30_000);
      await wait(3000);
      const after = await parts([b.site], b.cp, b.items);
      const owedNew = sum(after.owed) - sum(before.owed);
      R[tag] = { before, after, owedNew };
      log(`  ${tag}: after the restart: ${json(after.states)}, standing ${json(after.placed)}, owed new ${owedNew}`);
      check(G.same(after.total, before.total), `${tag}: paid exactly once: ${json(after.total)} = ${json(before.total)} (blocks standing + owed + stock)`, R[tag]);
      check(sum(after.placed) === 0 || owedNew === 0, `${tag}: no refund owed while the building stands (standing ${sum(after.placed)}, owed new ${owedNew})`, R[tag]);
    }
    // ---------------------------------------------------------------- LR-3 (P1 3): a paid road killed after its restore, before its settle's intent, its queue write failing
    for (const v of ['', '+save']) {
      const tag = `LR-3${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const g = await roadGroup(tag);
      if (!g.road) continue;
      await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
      await fill(tag, g.hut);
      await call('dev.site.finish', { site: g.hut }, 60_000);
      await wait(1500);
      const { cp, items, paid } = await payRoad(tag, g);
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await roadParts(g.road, cp, items, roadMid(g));
      // (slice T4a) since the PSVLC3 merge a removal job waits, untouched, for a confirmed queue write before it plans (PSV's preflight): a
      // failing queue file no longer loses the job, it holds the removal back. The row keeps its point with the queue writing.
      await call('dev.journal.killAt', { point: 'R4' + v }, 10_000);
      const m = await api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at R4${v} (the road's restore written, its settle not begun) (${json(m).slice(0, 120)})`);
      if (!down) { await ps({ failQueueWrites: false }); await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); continue; }
      await L.openWorld(name);
      await L.tp(...W.at);
      await settleWait([], cp, null, 30_000);
      for (let i = 0; i < 30 && (await roadState(g.road)); i++) await L.sleep(1000);
      await wait(3000);
      const after = await roadParts(g.road, cp, items, roadMid(g));
      const owedNew = G.plus(after.owed, Object.fromEntries(Object.entries(before.owed).map(([x, n]) => [x, -n])));
      R[tag] = { before, after, paid, owedNew };
      log(`  ${tag}: after the restart: road ${after.stands ? after.state : 'gone'}, crate ${after.crate ? 'stands ' + json(after.stock) : 'settled'}, owed new ${json(owedNew)}, ground ${json(after.ground)}`);
      check(after.stands ? sum(owedNew) === 0 && after.crate && G.same(after.stock, before.stock) : G.same(owedNew, G.plus(before.stock, paid)),
        `${tag}: paid once: ${after.stands ? 'the road stands again, nothing owed, the crate keeps its stock' : 'the road is gone: its stock and its paid cells owed'} (owed new ${json(owedNew)}; stock ${json(before.stock)}, paid ${json(paid)})`, R[tag]);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, R[tag]);
    }
    // ---------------------------------------------------------------- LR-4 (group report P2): a crate-fed group without a pile reports its owed keys
    if (want('LR-4')) {
      const tag = 'LR-4';
      const g = await grouped(tag);
      if (g.sites.length) {
        const { cp, items } = await fill(tag, g.sites[0], true);
        const before = await parts(g.sites, cp, items);
        const rm = await later(`sgremove ${g.group}`, 600_000).catch((e) => ({ error: String(e) }));
        await wait(2000);
        const after = await parts(g.sites, cp, items);
        R[tag] = { removal: rm, before, after };
        log(`  ${tag}: the group removed: refund ${json(rm.refund)}, owed ${json(rm.owed)}; owed now ${json(after.owed)}`);
        check(rm.removed === true && Array.isArray(rm.owed) && rm.owed.length > 0 && (rm.refundTotal ?? 0) === 0 && sum(after.owed) > sum(before.owed),
          `${tag}: a crate-fed group's removal reports its owed keys (${json(rm.owed)}), refund total ${rm.refundTotal} (owed listed apart)`, R[tag]);
      }
    }
    // ================================================================ (slice T4a) T4 rows: removal refunds against blocks still standing.
    // Recorded red at T4a (T2's removal runtime + PSVLC3 + the hooks commit); T4b makes them green. Each judges conservation from the blocks
    // standing in the world (never a record) and "no refund paid while its paid blocks stand".
    const fs = await import('node:fs');
    /** A player's site built to about {@code frac} of its bill from its crate, then paused with more stock in the crate. */
    const partBuilt = async (tag, site, frac) => {
      for (let i = 0; i < 120; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
      await boxOf(site);
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      const st0 = await siteState(site);
      const bom = st0?.bom ?? {};
      const part = {};
      for (const [kk, v] of Object.entries(bom)) { const n = Math.floor(v * frac); if (n > 0) part[kk] = n; }
      await call('dev.crate.insert', { site, items: part, exact: true }, 120_000);
      await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 90; i++) { if (sum((await siteState(site))?.ledger?.stock) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      const extra = {};
      for (const [kk, v] of Object.entries(bom).slice(0, 2)) extra[kk] = Math.max(1, Math.floor(v / 4));
      await call('dev.crate.insert', { site, items: extra, exact: true }, 120_000);
      await wait(1500);
      const st1 = await siteState(site);
      const cp = [st1.crate.x, st1.crate.y, st1.crate.z];
      const items = Object.keys(bom);
      check(sum(st1.ledger?.placed) > 0, `${tag}: ${site} built to about ${Math.round(frac * 100)}% (${sum(st1.ledger?.placed)} placed of ${sum(bom)}), its crate holding ${sum(st1.ledger?.stock)}`, st1);
      return { cp, items };
    };
    /** Judges a T4 row: conservation over the standing blocks, and no refund owed while any paid block of a removed site stands. */
    const judgeT4 = (tag, n, before, after) => {
      const owedNew = sum(after.owed) - sum(before.owed);
      n.before = before; n.after = after; n.owedNew = owedNew;
      R[tag] = n;
      log(`  ${tag}: before ${json(before.total)}; after ${json(after.total)} (placed ${json(after.placed)}, owed new ${owedNew}, stock ${json(after.stock)}, ground ${json(after.ground)}; ${json(after.states)})`);
      check(G.same(after.total, before.total), `${tag}: paid exactly once: ${json(after.total)} = ${json(before.total)} (blocks standing + crate + owed + ground + inventory)`, n);
      check(sum(after.placed) === 0 || owedNew <= sum(before.stock), `${tag}: no refund owed while ${sum(after.placed)} paid block(s) stand (owed new ${owedNew}, the crate's stock ${sum(before.stock)})`, n);
      check(sum(after.ground) === 0, `${tag}: nothing dropped (${json(after.ground)})`, n);
    };
    /** K6 on {@code sites} (removing {@code target}), then optional dev-start.json, the world again (twice when the start itself halts). */
    const k6Row = async (tag, sites, target, cp, items, { point = 'K6', start = null, after = null, expectHeld = false, reopenAfter = null } = {}) => {
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await parts(sites, cp, items);
      await call('dev.journal.killAt', { point }, 10_000);
      const m = await call('dev.site.deconstruct', { site: target }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
      const down = await haltWait();
      check(down, `${tag}: halted at ${point} (${json(m).slice(0, 120)})`);
      if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); return; }
      const arch = path.join(W.dir, 'architect');
      if (start) { fs.mkdirSync(arch, { recursive: true }); fs.writeFileSync(path.join(arch, 'dev-start.json'), JSON.stringify(start)); }
      if (after) after();
      let halts = 0;
      if (start?.killAt?.startsWith('TX:')) {
        // (T4b fix round) a txn point on the first ticks after the start: the world opens, then it halts there; then the world again
        await L.openWorld(name).catch(() => null);
        const again = await haltWait();
        halts += again ? 1 : 0;
        check(again, `${tag}: the start's removal txn halted at ${start.killAt}`);
        await L.sleep(3000);
        await L.openWorld(name);
      } else if (start?.killAt) {
        // the start itself halts (SERVER_STARTED, before the world is ready): the open never completes; raced, then opened again
        const op = L.openWorld(name).then(() => 'open', (e) => `error: ${String(e?.message ?? e).slice(0, 120)}`);
        const r0 = await Promise.race([op, L.sleep(200_000).then(() => 'timeout')]);
        const again = r0 !== 'open';
        halts += again ? 1 : 0;
        check(again, `${tag}: the start halted at ${start.killAt} (the open answered ${r0})`);
        await L.sleep(3000);
        await L.openWorld(name);
      } else {
        await L.openWorld(name);
      }
      await L.tp(...W.at);
      await settleWait(sites, cp, null, 30_000);
      await wait(4000);
      const after1 = await parts(sites, cp, items);
      const t1 = await txn();
      if (expectHeld) {
        // (T4b fix round) the fault fired: nothing paid, its paid blocks still standing; its txn held (a W that failed) or, a txn crashed
        // before its decision (aborted by recovery), the next not begun while the evidence is unknown
        const owedNew = sum(after1.owed) - sum(before.owed);
        const open = expectHeld === 'open' ? t1.openCount > 0 : true;
        const standing = reopenAfter ? true : sum(after1.placed) > 0; // (a held txn after its restore reached the disk: its refunds in transit)
        check(open && owedNew === 0 && standing, `${tag}: the W can't act and holds: txn open ${t1.openCount}, owed new ${owedNew}, ${sum(after1.placed)} paid block(s) standing`, { t1, after1 });
      }
      if (!reopenAfter) judgeT4(tag, { tag, point, start, removal: m, txn: t1, halts }, before, after1); // else judged once it completes
      if (reopenAfter) {
        // the fault cleared (the file put back): the removal completes, paid exactly once
        await L.leaveWorld();
        reopenAfter();
        await L.openWorld(name);
        await L.tp(...W.at);
        await settleWait(sites, cp, null, 30_000);
        await wait(4000);
        judgeT4(`${tag}-after`, { tag: `${tag}-after`, txn: await txn() }, before, await parts(sites, cp, items));
      }
    };
    // T4-keep (finding 1a): about 40% built: K6 reads neither restored nor standing (KEEP), and the KEEP path settles its stash
    for (const v of ['', '+save']) {
      const tag = `T4-keep${v ? 's' : ''}`;
      if (!want(tag)) continue;
      const site = await single(tag);
      if (!site) continue;
      const { cp, items } = await partBuilt(tag, site, 0.4);
      await k6Row(tag, [site], site, cp, items, { point: 'K6' + v });
    }
    // T4-shared (finding 1b): a member of a shared crate (the other still building), about 15% built, removed alone, K6
    if (want('T4-shared')) {
      const tag = 'T4-shared';
      const g = await grouped(tag, 2);
      if (g.sites.length === 2) {
        const [a, b] = g.sites;
        await boxOf(b);
        const { cp, items } = await partBuilt(tag, a, 0.15);
        await k6Row(tag, [a], a, cp, items);
      }
    }
    // T4-2nd (finding 2a): mostly unbuilt (RELEASE: the start writes the committed restore), the start halted at KS1 (its release on disk,
    // the restore's chunks not), then the world again
    if (want('T4-2nd')) {
      const tag = 'T4-2nd';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.1);
        await k6Row(tag, [site], site, cp, items, { start: { killAt: 'KS1' } });
      }
    }
    // T4-wnf (finding 2b): as T4-2nd, the start's write-now failing: the record stays pending, unsettled (and the queued settle must not pay)
    if (want('T4-wnf')) {
      const tag = 'T4-wnf';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.1);
        await k6Row(tag, [site], site, cp, items, { start: { failWriteNow: true }, expectHeld: 'open' });
      }
    }
    // T4-2nd-b (fix round): a second crash between the new W and the credit's publication: at the start, the removal txn halted after its W
    // applied (in memory), then the world again: paid exactly once
    if (want('T4-2nd-b')) {
      const tag = 'T4-2nd-b';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        await k6Row(tag, [site], site, cp, items, { start: { killAt: 'TX:removal.site:apply:0' } });
      }
    }
    // T4-nojournal (fix round, finding 2): a removal txn decided (its W not yet on disk: halted at its decision), then the world opened with
    // its journal unreadable: the W probe must hold (unknown), never read "released": nothing paid; with the journal back it completes once
    if (want('T4-nojournal')) {
      const tag = 'T4-nojournal';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        const jf = path.join(W.dir, 'architect-journal', 'journal.json');
        await k6Row(tag, [site], site, cp, items, { point: 'TX:removal.site:decided', expectHeld: 'open',
          after: () => { fs.copyFileSync(jf, jf + '.t4keep'); fs.writeFileSync(jf, '{ not json'); },
          reopenAfter: () => { fs.copyFileSync(jf + '.t4keep', jf); } });
      }
    }
    // T4-mine (fix round, finding 3): a crate-fed road's removal paused before its first write; a player breaks one of its paid blocks: the
    // box is held from the tally on (refused), so the refund stays true; else (the base) the block drops and its refund is paid too
    if (want('T4-mine')) {
      const tag = 'T4-mine';
      const g = await roadGroup(tag);
      if (g.road) {
        await call('dev.stockpile.pause', { site: g.road, paused: true }, 60_000).catch(() => null);
        await fill(tag, g.hut);
        await call('dev.site.finish', { site: g.hut }, 60_000);
        await wait(1500);
        const { cp, items, paid } = await payRoad(tag, g);
        const rv = await roadState(g.road);
        const m = rv && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(rv.box);
        const rbox = m ? m.slice(1, 7).map(Number) : null;
        const standingRoad = async () => {
          const out = {}, at = [];
          for (const [k2, st] of (await cellsOf(rbox)).entries()) {
            const id = String(st).replace(/\[.*$/, '');
            const full = id.includes(':') ? id : `minecraft:${id}`;
            if (items.includes(full)) { out[full] = (out[full] ?? 0) + 1; at.push(k2); }
          }
          return { out, at };
        };
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const b0 = await roadParts(g.road, cp, items, W.at);
        const s0 = await standingRoad();
        const before = { ...b0, placed: s0.out, total: [b0.stock, s0.out, b0.owed, b0.ground, b0.inventory].reduce((a, c) => G.plus(a, c), {}) };
        await call('dev.removal.pause', { site: g.road, after: 0 }, 10_000);
        const rm = api(`remove ${g.road} - noforce`).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        await wait(3000);
        const cell = s0.at[0];
        const at = typeof cell === 'string' ? cell.split(',').map(Number) : null;
        const br = at ? await call('dev.pt.breaks', { at: [at], placer: 'T4Miner' }, 60_000).catch((e) => ({ error: String(e) })) : { error: 'no paid cell' };
        await wait(1500);
        const drop = at ? (await call('dev.items.near', { pos: at, radius: 3 }, 30_000)).items ?? {} : {};
        await call('dev.removal.pause', { site: g.road, off: true }, 10_000);
        await rm;
        for (let i = 0; i < 60 && (await roadState(g.road)); i++) await L.sleep(1000);
        await wait(4000);
        const a0 = await roadParts(g.road, cp, items, W.at);
        const sa = await standingRoad();
        const nearCell = at ? pick((await call('dev.items.near', { pos: at, radius: 3 }, 30_000)).items ?? {}, items) : {};
        const after = { ...a0, placed: sa.out, ground: G.plus(a0.ground, nearCell), states: { [g.road]: a0.state }, total: [a0.stock, sa.out, a0.owed, a0.ground, nearCell, a0.inventory].reduce((x, c) => G.plus(x, c), {}) };
        log(`  ${tag}: a player broke ${at} while the removal waited: ${json(br)} (dropped ${json(drop)})`);
        check((br.broken ?? 0) === 0, `${tag}: the break in the held removal box is refused (${json(br)})`, br);
        judgeT4(tag, { tag, paid, break: br, txn: await txn() }, before, after);
      }
    }
    // T4-legacy (fix round, finding 4): a pre-T4 stockpile removal (its refund a J2 pending credit, no stash): a stockpile site about 10% built
    // halted at K6, its stash turned offline into the pre-T4 pending credit; at the start it must enter the new protocol (W first, then the
    // credit), never the threshold release with the absence book (the base: paid while its blocks stand)
    if (want('T4-legacy')) {
      const tag = 'T4-legacy';
      const owner = 'tcc:t4legacy';
      const sp = slot();
      await call('dev.stockpile.create', { owner, crates: [[sp[0], sp[1], sp[2]]] }, 120_000).catch((e) => ({ refused: String(e) }));
      const g = await grouped(tag, 1, owner);
      const site = g.sites[0];
      if (site) {
        for (let i = 0; i < 60; i++) { if ((await siteState(site))?.state === 'building') break; await L.sleep(1000); }
        await boxOf(site);
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        const bom = (await siteState(site))?.bom ?? {};
        const part = {};
        for (const [kk, v] of Object.entries(bom)) { const n = Math.floor(v * 0.1); if (n > 0) part[kk] = n; }
        await call('dev.crate.insert', { site: `stockpile:${owner}`, items: part, exact: true }, 120_000).catch(() => null);
        await call('dev.stockpile.pause', { site, paused: false }, 60_000);
        const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
        for (let i = 0; i < 90; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
        await call('dev.stockpile.pause', { site, paused: true }, 60_000);
        const items = Object.keys(bom);
        const pparts = async () => {
          const ps = await pst();
          const placed = await standing(site, items);
          const ow = await owedAll();
          const near = await call('dev.items.near', { pos: (await boxOf(site)).slice(0, 3), radius: 16 }, 30_000);
          const mine = {};
          for (const e of ow.owed ?? []) if (e.site === site) for (const [k2, v] of Object.entries(e.items ?? {})) mine[k2] = (mine[k2] ?? 0) + v;
          const p = { stock: pick(ps.stock ?? {}, items), placed: pick(placed, items), owed: pick(mine, items), ground: pick(near.items ?? {}, items), inventory: {},
            states: { [site]: (await siteState(site))?.state ?? null } };
          p.total = [p.stock, p.placed, p.owed, p.ground].reduce((a, b) => G.plus(a, b), {});
          return p;
        };
        await cmd('/save-all flush').catch(() => null);
        await wait(2000);
        const before = await pparts();
        check(sum(before.placed) > 0, `${tag}: ${site} fed from the stockpile of ${owner}, about 10% built (${sum(before.placed)} placed)`, before);
        await call('dev.journal.killAt', { point: 'K6' }, 10_000);
        const m = await call('dev.site.deconstruct', { site }, 60_000).catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
        const down = await haltWait();
        check(down, `${tag}: halted at K6 (${json(m).slice(0, 120)})`);
        if (down) {
          // the pre-T4 shape: the removal's stash becomes the J2 pending credit (items, at) in its pile's ledger
          const sf = path.join(W.dir, 'architect', 'stockpiles.json');
          const root = JSON.parse(fs.readFileSync(sf, 'utf8'));
          const st = root.crateSettles?.[site];
          let made = false;
          if (st?.pileKey) {
            for (const po of root.stockpiles ?? []) {
              if (po.owner !== owner) continue;
              po.ledger = po.ledger ?? {};
              po.ledger.pendingCredit = po.ledger.pendingCredit ?? {};
              po.ledger.pendingCredit[st.pileKey] = { items: st.refund ?? {}, at: st.pos };
              made = true;
            }
            delete root.crateSettles[site];
            fs.writeFileSync(sf, JSON.stringify(root, null, 2));
          }
          check(made, `${tag}: the removal's stash turned into a pre-T4 pending credit offline (${json(st?.refund ?? null)})`, st);
          await L.openWorld(name);
          await L.tp(...W.at);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(5000);
          const after = await pparts();
          judgeT4(tag, { tag, removal: m, txn: await txn() }, { ...before, stock: {} }, after);
        } else {
          await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
        }
      }
    }
    // A stockpile's construction road, about half paid and built, every target paused (T4-pileroad, T4-lastcrate)
    const pileRoad = async (tag, owner) => {
      const at = slot();
      k += 2;
      const y = gy + 1, X = at[0], Z = at[2] + 20;
      await cmd(`/fill ${X - 3} ${y - 1} ${Z - 3} ${X + 30} ${y - 1} ${Z + 3} minecraft:stone`);
      W.at = [X + 10, y + 1, Z + 6];
      await L.tp(...W.at);
      const crate = [X + 10, y, Z - 8];
      await call('dev.stockpile.create', { owner, crates: [crate] }, 120_000).catch((e) => ({ refused: String(e) }));
      const road = { points: [[X, y, Z], [X + 26, y, Z]], width: 1, mode: 'AUTO' };
      const bid = await later(`bqueue ${json({ id: `tcct4pr${Date.now() % 100000}`, proximity: false, owner, autoApprove: true, items: [{ key: 'r1', road }] })}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site || x.status === 'FAILED')) break; await L.sleep(1000); }
      const rid = bv?.items?.[0]?.site;
      check(!!rid, `${tag}: a construction road fed from the stockpile of ${owner} (${rid})`, bv);
      if (!rid) return null;
      const pst = async () => (await call('dev.stockpile.state', { owner }, 60_000).catch(() => ({}))).stockpile ?? {};
      for (let i = 0; i < 60; i++) { const rv0 = await roadState(rid).catch(() => null); if (rv0 && !/plac/i.test(String(rv0.state))) break; await L.sleep(1000); }
      await call('dev.stockpile.pause', { site: rid, paused: true }, 60_000).catch(() => null);
      const bill = (await api(`stock ${bv.group}`).catch(() => ({}))).outstandingBySite?.[rid] ?? {};
      const half = {};
      for (const [kk, v] of Object.entries(bill)) half[kk] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site: `stockpile:${owner}`, items: half, exact: true }, 120_000).catch(() => null);
      await call('dev.stockpile.pause', { site: rid, paused: false }, 60_000).catch(() => null);
      for (let i = 0; i < 60; i++) { if (sum((await pst()).stock) === 0) break; await L.sleep(500); }
      await call('dev.stockpile.pause', { site: rid, paused: true }, 60_000).catch(() => null);
      const items = Object.keys(bill);
      const rv = await roadState(rid);
      const mm = rv && /minX=(-?\d+), minY=(-?\d+), minZ=(-?\d+), maxX=(-?\d+), maxY=(-?\d+), maxZ=(-?\d+)/.exec(rv.box);
      const rbox = mm ? mm.slice(1, 7).map(Number) : [X - 1, y - 1, Z - 2, X + 27, y + 1, Z + 2];
      const rparts = async () => {
        const placed = {};
        for (const st of (await cellsOf(rbox)).values()) {
          const id = String(st).replace(/\[.*$/, '');
          const full = id.includes(':') ? id : `minecraft:${id}`;
          if (items.includes(full)) placed[full] = (placed[full] ?? 0) + 1;
        }
        const near = await call('dev.items.near', { pos: W.at, radius: 24 }, 30_000);
        const mine = {};
        for (const e of (await owedAll()).owed ?? []) if (e.site === rid) for (const [k2, v] of Object.entries(e.items ?? {})) mine[k2] = (mine[k2] ?? 0) + v;
        const p = { stock: pick((await pst()).stock ?? {}, items), placed, owed: pick(mine, items), ground: pick(near.items ?? {}, items), inventory: {},
          states: { [rid]: (await roadState(rid))?.state ?? null } };
        p.total = [p.stock, p.placed, p.owed, p.ground].reduce((a, b) => G.plus(a, b), {});
        return p;
      };
      await cmd('/save-all flush').catch(() => null);
      await wait(2000);
      const before = await rparts();
      check(sum(before.placed) > 0, `${tag}: ${rid} paid for ${sum(before.placed)} cell(s) from the stockpile`, before);
      return { rid, rparts, before, crate, pst };
    };
    // (T4 final round) the road removed for good: no record, no paid block standing, its refund credited into the stockpile (stock = before's
    // stock + the paid blocks that stood), nothing owed or dropped
    const roadFinished = async (tag, pr, after) => {
      check(!(await roadState(pr.rid).catch(() => null)), `${tag}: ${pr.rid} removed (no record left; the review's green run ended BUILDING)`, after.states);
      check(sum(after.placed) === 0, `${tag}: no paid block of ${pr.rid} stands (${json(after.placed)})`, after);
      check(G.same(after.stock, G.plus(pr.before.stock, pr.before.placed)), `${tag}: its refund credited into the stockpile: ${json(after.stock)} = ${json(G.plus(pr.before.stock, pr.before.placed))}`, after);
    };
    const roadGone = async (rid, s = 120) => { for (let i = 0; i < s && (await roadState(rid).catch(() => null)); i++) await L.sleep(1000); };
    // T4-pileroad (fix round, finding 5): a stockpile's road removed with its credit save refused, then the game halted unsaved: its refund
    // intent is the removal.road stash (durable before the job), paid exactly once after the restart (the base: the refund lost). (T4 final
    // round) judged only once the road is removed for good: REMOVED, no paid block standing, the refund credited
    if (want('T4-pileroad')) {
      const tag = 'T4-pileroad';
      const pr = await pileRoad(tag, 'tcc:t4road');
      if (pr) {
        const { rid, rparts, before } = pr;
        // the job queued and paused before its first write (its stash saved), then every ledger write failing (its chunks flush, its ledger
        // does not: the review's case), then the job runs and the game halts unsaved
        await call('dev.removal.pause', { site: rid, after: 0 }, 10_000);
        const rm = await api(`remove ${rid} - noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await wait(2000);
        await ps({ failLedgerOnly: 1000 }); // the ledger's writes only (the queue file and txn.json still write)
        await call('dev.removal.pause', { site: rid, off: true }, 10_000);
        await wait(5000);
        call('dev.txn.halt', { save: false }, 10_000).catch(() => null);
        const down = await haltWait();
        check(down, `${tag}: halted unsaved after the removal (${json(rm).slice(0, 160)})`);
        if (down) {
          await L.openWorld(name);
          await L.tp(...W.at);
          await roadGone(rid);
          for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
          await wait(5000);
          const after = await rparts();
          judgeT4(tag, { tag, removal: rm, txn: await txn() }, { ...before }, after);
          await roadFinished(tag, pr, after);
        }
      }
    }
    // T4-lastcrate (T4 final round, P1 1): a stockpile road's removal paused after its commit (its refund stash durable, the road pending, so
    // nothing of the pile builds); removing the pile's last crate must be refused while the stash credits into it (the base: the pile ends
    // and its refund has no pile to go to); then the removal finishes, the refund credited into the same pile
    if (want('T4-lastcrate')) {
      const tag = 'T4-lastcrate';
      const owner = 'tcc:t4last';
      const pr = await pileRoad(tag, owner);
      if (pr) {
        const { rid, rparts, before, crate, pst } = pr;
        await call('dev.removal.pause', { site: rid, after: 0 }, 10_000);
        const rm = await api(`remove ${rid} - noforce`).catch((e) => ({ error: String(e?.message ?? e).slice(0, 160) }));
        await wait(3000);
        const rc = await call('dev.stockpile.removecrate', { owner, pos: crate, force: true }, 60_000).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
        const ps1 = await pst();
        R[tag] = { removal: rm, removeCrate: rc, pile: ps1 };
        check(!rc.removed && (ps1.crates ?? []).length === 1, `${tag}: the last crate's removal refused while the removal's stash credits into the pile (${json(rc).slice(0, 200)})`, rc);
        await call('dev.removal.pause', { site: rid, off: true }, 10_000);
        await roadGone(rid);
        for (let i = 0; i < 30 && (await txn()).openCount !== 0; i++) await L.sleep(1000);
        await wait(3000);
        const after = await rparts();
        judgeT4(tag, { tag, removal: rm, removeCrate: rc, txn: await txn() }, { ...before }, after);
        await roadFinished(tag, pr, after);
      }
    }
    // (T4-road, finding 3a, dropped at T4a: its precondition, a road removal's job lost to a failing queue file, can't arise since the
    // PSVLC3 merge, whose preflight confirms the job's queue write before it plans; LR-3/LR-3s cover the road's resumed job. The majority
    // rule is TxnRemovalModelT4Test's 3a; the sweep's absence rule is T4-corrupt's.)
    // T4-corrupt (finding 3b; last: it leaves the world's sites file broken): K6 on a 40% site, its sites file unreadable at the start: the
    // sweep reads the empty registry as "gone" and pays the durable stash
    if (want('T4-corrupt')) {
      const tag = 'T4-corrupt';
      const site = await single(tag);
      if (site) {
        const { cp, items } = await partBuilt(tag, site, 0.4);
        const sf = path.join(W.dir, 'architect-sites.json');
        await k6Row(tag, [site], site, cp, items, { after: () => { fs.copyFileSync(sf, sf + '.t4keep'); fs.writeFileSync(sf, '{ not json'); } });
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
