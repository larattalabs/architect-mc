// Slice CXD gate (docs/CONTRACT.md "Slice CXD, durable crate extraction"): a crate's stock a removal takes is an owed record saved
// confirmed before the take and settled once after the commit; after a crash at any step the next start resolves it against the crate.
// Registered into tools/gate6dgr.mjs (GR's survival world and halt helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs cxdcrash   (cxd-crash)   one survival world; per case a crate-fed construction site (no stockpile: a crate),
//                                                    paused, stock inserted into its crate, /save-all flush (the baseline), the removal
//                                                    halted at a kill point (dev.journal.killAt) with nothing else saved, the world
//                                                    opened again (the first tick resolves the open records):
//     S1..S4  a player's site (/architect place: the placer's UUID, no site owner) deconstructed alone (Sites.removeDetailed):
//             CXD1 captured, the record not saved; CXD2 the record saved, the crate not emptied; CXD3 the stock taken, not committed;
//             CXD4 committed and restored, the stock not settled. The plain halts find the chunk as the record's save flushed it (the
//             crate full: resolved "close"); S3s/S4s halt at CXD3+save / CXD4+save (the chunks saved first): the crate MARKED and not
//             committed (put back), the restore on disk and the site released (ABSENT: dropped at the start)
//     G3, G3s, G4, G4s  a group's shared crate (an actorless batch, sharedCrate) removed with its group (Groups R1, sgremove): the same
//             points; after the restart the group's removal (resumed or planned again) is waited out and judged again
//   each: the crate's stock + the items near the crate + the player's inventory after the restart equal the stock before, item for item
//   (no dupe, no loss); no owed record left open; the site stands with its stock (not committed) or is gone (committed).
//
// Evidence: artifacts/gate6d-gr/cxdcrash.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import path from 'node:path';

export async function registerCXD(steps, h) {
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
  const siteState = async (site) => call('dev.site.state', { site }, 60_000).catch(() => null);
  const owed = async () => (await call('dev.stockpile.owed', {}, 30_000).catch(() => ({})))?.owed ?? {};

  /** The stock's parts: the crate's stock (its site standing), the items near the crate and the player's inventory. */
  async function parts(site, cp, items) {
    const st = await siteState(site);
    const stock = G.plus(st?.crate?.present ? st.ledger?.stock ?? {} : {}, st ? st.ledger?.placed ?? {} : {}); // placed: standing as blocks
    const near = await call('dev.items.near', { pos: cp, radius: 6 }, 30_000);
    const total = G.plus(G.plus(pick(stock, items), pick(near.items ?? {}, items)), pick(near.inventory ?? {}, items));
    return { stands: !!st, state: st?.state ?? null, cratePresent: !!st?.crate?.present, stock: pick(stock, items), ground: pick(near.items ?? {}, items),
      inventory: pick(near.inventory ?? {}, items), total };
  }

  /** A site's crate: paused (its stock stays unused), filled with part of its bill. Returns the crate's cell and the items given. */
  async function fill(tag, site, build = false) {
    for (let i = 0; i < 120; i++) { // a batch's site converts over ticks: wait until it builds
      if ((await siteState(site))?.state === 'building') break;
      await L.sleep(1000);
    }
    const pz = await call('dev.stockpile.pause', { site, paused: true }, 60_000);
    check(!pz?.refused, `${tag}: ${site} paused (${json(pz?.refused ?? 'paused')})`);
    const st0 = await siteState(site);
    const give = {};
    for (const [k, v] of Object.entries(st0?.bom ?? {}).slice(0, 3)) give[k] = Math.max(1, Math.floor(v / 2));
    if (build) {
      // (P1-1) partly built: a first part delivered and placed (refunds standing), paused, then the stock that stays in the crate
      const first = {};
      for (const [k, v] of Object.entries(give)) first[k] = Math.max(1, Math.floor(v / 2));
      await call('dev.crate.insert', { site, items: first, exact: true }, 120_000);
      await call('dev.stockpile.pause', { site, paused: false }, 60_000);
      for (let i = 0; i < 30; i++) {
        if (sum((await siteState(site))?.ledger?.stock) === 0) break;
        await L.sleep(500);
      }
      await call('dev.stockpile.pause', { site, paused: true }, 60_000);
      await call('dev.wait', { ms: 1000 }, 30_000);
    }
    const ins = await call('dev.crate.insert', { site, items: give, exact: true }, 120_000);
    await call('dev.wait', { ms: 2000 }, 30_000);
    const st1 = await siteState(site);
    if (build) check(sum(st1.ledger?.placed) > 0 && sum(st1.ledger?.stock) > 0, `${tag}: partly built: ${sum(st1.ledger?.placed)} placed, ${sum(st1.ledger?.stock)} still in the crate`);
    const cp = [st1.crate.x, st1.crate.y, st1.crate.z];
    check(st1.crate.present && sum(st1.ledger?.stock) > 0, `${tag}: the crate at ${cp} holds ${sum(st1.ledger?.stock)} item(s) (inserted ${json(ins.accepted ?? give)})`);
    return { cp, items: Object.keys(give) };
  }

  /** One case: the baseline flush, the removal halted at {@code point}, the restart, the conservation judged. */
  async function crashCase(out, tag, W, site, point, remove, committed, group = null, build = false) {
    const { cp, items } = await fill(tag, site, build);
    await cmd('/save-all flush').catch(() => null);
    await call('dev.wait', { ms: 2000 }, 30_000);
    const before = await parts(site, cp, items);
    await call('dev.journal.killAt', { point }, 10_000);
    const m = await remove().catch((e) => ({ dropped: String(e?.message ?? e).slice(0, 120) }));
    const down = await haltWait();
    check(down, `${tag}: halted at ${point} inside the removal (${json(m).slice(0, 160)})`);
    if (!down) {
      await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
      out[tag] = { tag, point, before, removal: m, halted: false };
      return;
    }
    await L.openWorld(path.basename(W.dir));
    await L.tp(W.at[0], W.at[1], W.at[2]);
    await call('dev.wait', { ms: 4000 }, 30_000);
    const after = await parts(site, cp, items);
    const ow = await owed();
    const n = { tag, point, site, crate: cp, before, after, owed: ow, resolutions: ow.resolutions ?? [], removal: m };
    log(`  ${tag} (${point}): before ${json(before.total)}; after the restart ${json(after.total)} (stock ${json(after.stock)}, ground ${json(after.ground)}, inventory ${json(after.inventory)}; site ${after.stands ? after.state : 'gone'}); owed open ${(ow.open ?? []).length}, resolved at start ${ow.resolvedAtStart}`);
    check(G.same(after.total, before.total), `${tag} (${point}): the crate's stock paid exactly once: after ${json(after.total)} = before ${json(before.total)} (crate + ground + inventory)`, n);
    check((ow.open ?? []).length === 0, `${tag} (${point}): no owed record left open (${(ow.open ?? []).length}; resolved at the start ${ow.resolvedAtStart})`, ow);
    if (committed === false) check(after.stands && after.cratePresent && G.same(after.stock, before.stock), `${tag} (${point}): not committed: the site stands, its crate holds its stock again ${json(after.stock)} (${json(n.resolutions)})`, n);
    if (committed === true) check(!after.stands || after.state !== 'building', `${tag} (${point}): committed: the site is gone (${after.stands ? after.state : 'gone'}), its stock on the ground ${json(after.ground)} (${json(n.resolutions)})`, n);
    if (group) {
      // the group's removal from the queue (resumed, or planned again: R1 captures again) runs to its end: then judged again
      let gs;
      for (let i = 0; i < 300; i++) {
        gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
        if (!gs || ['REMOVED', 'PARTIAL', 'FAILED', 'ACTIVE'].includes(gs) && i > 5) break;
        await L.sleep(2000);
      }
      if (gs === 'ACTIVE') { await later(`sgremove ${group}`, 600_000).catch(() => null); gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null; }
      await call('dev.wait', { ms: 3000 }, 30_000);
      const end = await parts(site, cp, items);
      const ow2 = await owed();
      n.groupEnd = { state: gs, parts: end, owed: ow2 };
      log(`  ${tag}: the group's removal ended ${gs}: ${json(end.total)} (ground ${json(end.ground)}); owed open ${(ow2.open ?? []).length}`);
      check(G.same(end.total, before.total) && (ow2.open ?? []).length === 0, `${tag} (${point}): after the group's removal ended (${gs}): ${json(end.total)} = before ${json(before.total)}, no record open`, n.groupEnd);
    }
    out[tag] = n;
  }

  /** (P1-2) The settle's drop barrier refused 12 times: the group's removal holds (not REMOVED), nothing dropped, the record open; then once. */
  async function heldCase(out, tag, W, site, group) {
    const { cp, items } = await fill(tag, site);
    const before = await parts(site, cp, items);
    await call('dev.stockpile.owed', { failDrops: 12 }, 30_000);
    api(`sgremove ${group}`).catch(() => null);
    await call('dev.wait', { ms: 6000 }, 30_000);
    const mid = await parts(site, cp, items);
    const ow1 = await owed();
    const gs1 = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
    check(gs1 !== 'REMOVED' && (ow1.open ?? []).length >= 1 && sum(mid.ground) === 0 && (ow1.held ?? 0) > 0,
      `${tag}: the settle refused: the group holds (${gs1}), ${(ow1.open ?? []).length} record(s) owed, ${sum(mid.ground)} on the ground, held ${ow1.held}`, { mid, ow1 });
    let gs;
    for (let i = 0; i < 120; i++) {
      gs = (await api(`sgroup ${group}`).catch(() => null))?.state ?? null;
      if (!gs || ['REMOVED', 'PARTIAL', 'FAILED'].includes(gs)) break;
      await L.sleep(1000);
    }
    await call('dev.wait', { ms: 3000 }, 30_000);
    const end = await parts(site, cp, items);
    const ow2 = await owed();
    out[tag] = { tag, site, group, before, mid, end, state: gs, owed: ow2 };
    log(`  ${tag}: held ${ow1.held}, then ${gs}: ${json(end.total)} (ground ${json(end.ground)}); owed open ${(ow2.open ?? []).length}`);
    check(gs === 'REMOVED' && G.same(end.total, before.total) && (ow2.open ?? []).length === 0,
      `${tag}: after the refusals the group ended ${gs}; paid once: ${json(end.total)} = before ${json(before.total)}, no record open`, out[tag]);
  }

  /** A player's construction site (/architect place: SiteCommands, the placer's UUID, no site owner) in front of {@code origin}; its id. */
  async function playerSite(tag, origin) {
    await L.tp(origin[0], origin[1] + 1, origin[2]);
    await cmd(`/tp @s ${origin[0]} ${origin[1] + 1} ${origin[2]} 0 0`).catch(() => null); // facing south: the site goes in front
    const r = await cmd('/architect place rs_hut');
    const msg = (r.messages ?? []).join(' ');
    const id = /Construction site (\S+) /.exec(msg)?.[1] ?? null;
    check(!!id, `${tag}: a player's construction rs_hut (/architect place) at ${origin}: ${id ?? msg.slice(0, 200)}`);
    return id;
  }

  steps.cxdcrash = async () => {
    await ensure();
    const out = {};
    await G.survivalBase(ctx);
    const name = 'G6B CXD crash';
    await L.fresh(name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await G.designs(ctx);
    const gy = await groundY();
    const at = [CX + 40, gy + 2, CZ + 60];
    await L.tp(...at);
    const W = { dir: path.join(L.SAVES, name), at };
    const parts0 = (process.env.GATE_CXD_PARTS ?? 'S1,S2,S3,S3s,S4,S4s,S7,G3,G3s,G4,G4s,G5,G6,G7').split(',');
    // [point, committed]: true/false judged; null: conservation only (a plain halt: the chunks as the record's save flushed them)
    const single = { S1: ['CXD1', false], S2: ['CXD2', false], S3: ['CXD3', null], S3s: ['CXD3+save', false], S4: ['CXD4', null], S4s: ['CXD4+save', true],
      S7: ['CXDS+save', true] }; // S7 (P1-4): the tagged drop's chunks on disk, its record's close not: found at the start, paid once
    let k = 0;
    const slot = (i) => [CX + 20 * (i % 5), gy + 1, CZ + 40 + 40 * Math.floor(i / 5)]; // two rows of five, apart
    for (const tag of parts0.filter((t) => single[t])) {
      const [point, committed] = single[tag];
      const origin = slot(k++);
      const site = await playerSite(tag, origin);
      W.at = [origin[0], gy + 2, origin[2] - 6]; // behind where the player placed it (the site lies to the south)
      await L.tp(...W.at);
      if (!site) continue;
      await crashCase(out, tag, W, site, point, () => call('dev.site.deconstruct', { site }, 60_000), committed);
    }
    // G5 (P1-1): a partly built member (refunds standing) halted at CXD4+save; G6 (P1-4): CXDS+save; G7 (P1-2): the settle's drop barrier
    // refused (dev.stockpile.owed failDrops): the group holds its finish, nothing dropped, the record owed; then it settles once
    const group = { G3: ['CXD3', null], G3s: ['CXD3+save', null], G4: ['CXD4', null], G4s: ['CXD4+save', null], G5: ['CXD4+save', null, true],
      G6: ['CXDS+save', null], G7: [null, null] };
    for (const tag of parts0.filter((t) => group[t])) {
      const [point, committed, build] = group[tag];
      const gat = slot(k++);
      W.at = [gat[0] + 3, gy + 2, gat[2] + 24];
      await L.tp(...W.at);
      const spec = { id: `cxd${tag.toLowerCase()}`, proximity: false, sharedCrate: true, items: [{ key: 'h1', bp: 'rs_hut', at: gat, rot: 0, mode: 'CONSTRUCTION' }] };
      const bid = await later(`bqueue ${JSON.stringify(spec)}`, 120_000);
      let bv;
      for (let i = 0; i < 120; i++) { bv = await api(`batch ${bid}`); if (bv.items?.every((x) => x.site)) break; await L.sleep(1000); }
      const site = bv?.items?.[0]?.site;
      check(!!site, `${tag}: an actorless construction rs_hut from its group's shared crate (${site}, group ${bv?.group})`, bv);
      if (!site) continue;
      if (tag === 'G7') {
        await heldCase(out, tag, W, site, bv.group);
        continue;
      }
      await crashCase(out, tag, W, site, point, () => api(`sgremove ${bv.group}`), committed, bv.group, !!build);
    }
    await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
