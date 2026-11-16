// Slice DR-S gate (docs/CONTRACT.md "Slice DR", the survival half; strict, speed rule 11.2: targeted scenarios only): survival diagnose and
// repair after a crash that lost world writes the journal recorded. Registered into tools/gate6dgr.mjs (GR's survival town and feed helpers).
// Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs drsurvival  (dr-survival)  one survival flat_village town (a hall and a cottage; stages approved by hand), then in turn:
//     DR5   the lot paused, all delivered, the ledger saved (/save-all flush), the lot built after the save, a halt with nothing saved: RL's
//           reconcile settles it at the start; diagnose all reports no BOOK finding and nothing for the lot (one owner: RL's); its region view
//           builds as its record says
//     DR4a  (J2 2a) the town fed until built, saved; the cottage lot removed on its own with the credit's save off (dev.stockpile.ps
//           noCreditSave): its credit is held pending on disk (saved before the commit); its west half's restore "lost" (dev.repair unwrite:
//           those cells put back as placed, no player record), then an autosave halted after its chunk writes, before the ledger (AS1). After
//           the restart: the auto-diagnose's ops line and suspects() name it stuck; diagnose reports exactly the unwritten cells; the dry run
//           changes no byte and previews the pending credit; repair: written, settled (released), the pending credit booked once = what the
//           saved ledger held pending (items in = items out against the saved state); a second diagnose finds nothing (no PAID_ORPHAN for
//           its key), a second repair changes nothing
//     DR4b  (Groups' decCredit, durable since DR-S) the rest of the town removed as a region with the credit's save off: every member's credit
//           is pending on disk; the hall's west half "lost" as above, then AS1. After the restart the members settled at the start booked
//           theirs; the hall is stuck: repaired, its decCredit booked once from its durable record; what came back since the saved state =
//           every pending credit the saved ledger held, each once; nothing pending, no member's paid record left; second diagnose/repair
//     DR8   a paid record naming no target (dev.repair ledger, TEST): PAID_ORPHAN reported; the repair writes nothing and the ledger is
//           unchanged
//     DR7   an unresolved custody (dev.repair ledger: the key's fill paid and its items in custody, its site gone): CUSTODY reported; the repair
//           credits it under the cap once (custody = credit, item for item); a second diagnose and repair find nothing
//
// Evidence: artifacts/gate6d-gr/drsurvival.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';

export async function registerDRS(steps, h) {
  const { L, call, check, cmd, log, json, G, ensure, spendZero, groundY, CX, CZ, CLAIM, haltWait } = h;
  const ctx = { L, OUT: h.OUT, imp: h.imp };
  const sum = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const TOWN = [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }];
  const ledgerOf = (root) => (root?.stockpiles ?? []).find((p) => p.owner === G.OWNER)?.ledger ?? null;
  const rep = (op, extra = {}) => call('dev.repair', { op, ...extra }, 300_000);
  const st = () => rep('state');
  const diag = (scope) => rep('diagnose', { scope });
  const repair = (planId, apply, actor = 'player') => rep('repair', { planId, apply, actor });
  const box = (s) => { const [a, b] = s.split('..').map((x) => x.trim().split(',').map(Number)); return [...a, ...b]; };
  const hash = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
  const back = (l) => G.plus(l?.returned ?? {}, l?.refundOverflow ?? {});
  const pendSum = (l, keys = null) => Object.entries(l?.pendingCredit ?? {}).filter(([k]) => !keys || keys.includes(k)).reduce((a, [, e]) => G.plus(a, e.items ?? {}), {});

  let W;
  const saved = () => ledgerOf(JSON.parse(fs.readFileSync(path.join(L.SAVES, W.name, 'architect', 'stockpiles.json'), 'utf8')));

  async function started(tag) {
    let s;
    for (let i = 0; i < 180; i++) {
      s = await st().catch(() => null);
      if (s?.startDone && !s.pending) break;
      await L.sleep(1000);
    }
    check(!!s?.startDone && !s.pending, `${tag}: the start's settles done and the auto-diagnose finished (${json(s)})`);
    return s;
  }
  async function restart(tag) {
    await L.openWorld(W.name);
    await L.tp(CX + 80, 60, CZ + 56);
    await L.settle(3000);
    await cmd('/op @a').catch(() => null);
    return started(tag);
  }
  async function halt(tag, mode = 'now') {
    await call('dev.stockpile.halt', { mode }, 10_000).catch(() => null);
    const down = await haltWait();
    check(down, `${tag}: halted (${mode})`);
    return down;
  }
  /** AS1: an unflushed world save halts after its chunk writes, before the ledger's (the restore's chunks on disk, the credit not). */
  async function haltAS1(tag) {
    await call('dev.stockpile.ps', { haltBeforeAutosaveLedger: true }, 30_000);
    cmd('/save-all').catch(() => null);
    const down = await haltWait();
    check(down, `${tag}: AS1 halted the save after its chunk writes, before the ledger`);
    return down;
  }
  async function quiet(quietMs = 4000, timeoutMs = 600_000) {
    const end = Date.now() + timeoutMs;
    let last = null, since = Date.now();
    for (; Date.now() < end;) {
      const c = json((await pile()).ledger?.consumed ?? {});
      if (c !== last) { last = c; since = Date.now(); } else if (Date.now() - since >= quietMs) return true;
      await L.sleep(1000);
    }
    return false;
  }
  async function deliver(skip = null) {
    const ps = await G.pileState(ctx);
    let want = ps.outstanding ?? {};
    if (skip) {
      want = {};
      for (const [k, x] of Object.entries((await pile()).targets ?? {})) if (!skip(k, x)) want = G.plus(want, x.outstanding ?? {});
    }
    const need = {};
    for (const [it, n] of Object.entries(want)) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
    if (Object.keys(need).length) await call('dev.crate.insert', { site: `stockpile:${G.OWNER}`, items: need, exact: true }, 120_000);
    return need;
  }
  /**
   * The west half of a box (x below its middle) above the ground (the ground stage's levelled cells under a lot are that target's): the
   * cells whose restore the fault loses, all the lot's own.
   */
  const westOf = (b, gy) => [b[0], Math.max(b[1], gy + 1), b[2], Math.floor((b[0] + b[3]) / 2), b[4], b[5]];

  /**
   * One stuck survival removal's checks after its restart: suspects and the ops line name it; diagnose reports STUCK at exactly the lost
   * cells; the dry run changes no byte and previews the pending credit; repair writes them, settles it and books its pending credit once;
   * a second diagnose finds nothing (no PAID_ORPHAN for its key) and a second repair changes nothing.
   */
  async function stuckCase(tag, s1, site, b, lost, key, S) {
    const sus = Object.fromEntries((s1.suspects ?? []).map((x) => [x.site, x.reason]));
    check(sus[site] === 'stuck' && typeof s1.opsLine === 'string' && /unclean stop/.test(s1.opsLine), `${tag}: suspects() names ${site} stuck and the ops line was posted (${json(sus)}; ${s1.opsLine})`);
    const d1 = await diag({ kind: 'site', id: site });
    const f = (d1.findings ?? []).find((x) => x.code === 'STUCK' && x.site === site);
    check(!!f && f.lagging === lost && f.foreign === 0, `${tag}: diagnose reports STUCK ${site} with exactly the ${lost} lost cell(s) lagging, none foreign (${json(f && { cells: f.cells, lagging: f.lagging, foreign: f.foreign, diffs: f.diffs?.slice(0, 3) })})`, d1);
    const pendItems = S.pendingCredit?.[key]?.items ?? {};
    const h0 = await hash(b);
    const pre = await pile();
    const dry = await repair(d1.planId, false);
    check(dry.applied === false && dry.written === lost && G.same(dry.credited, G.plus(pendItems, S.custody?.[key] ?? {})), `${tag}: the dry run would write ${dry.written} and credit ${sum(dry.credited)} (the saved pending credit ${sum(pendItems)}) (${dry.message})`, dry);
    check(await hash(b) === h0 && G.same(back((await pile()).ledger), back(pre.ledger)), `${tag}: the dry run changed no byte and moved nothing in the ledger`);
    const r = await repair(d1.planId, true);
    const post = await pile();
    const moved = G.minus(back(post.ledger), back(pre.ledger));
    check(r.applied === true && r.written === lost && /settled/.test(r.message), `${tag}: repaired: wrote ${r.written}, settled (${r.message})`, r);
    check(G.same(r.credited, moved) && sum(moved) > 0 && G.same(moved, G.plus(pendItems, S.custody?.[key] ?? {})),
      `${tag}: its pending credit booked once: ${sum(moved)} units came back = what the saved ledger held pending for ${key} (${sum(pendItems)}), item for item (items in = items out)`, { moved, pendItems, credited: r.credited });
    check((post.ledger?.credited ?? []).includes?.(key) !== false && !post.ledger?.pendingCredit?.[key] && !post.ledger?.paid?.[key], `${tag}: ${key} credited, nothing pending, its paid record spent`);
    const recPath = r.record ? path.resolve(L.GAME_DIR, r.record) : null;
    const rec = recPath && fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, 'utf8')) : null;
    check(rec?.state === 'final' && rec.cells?.length === lost && (rec.settled ?? []).includes(site), `${tag}: the record is final (${rec?.state}, ${rec?.cells?.length} cells, settled ${json(rec?.settled)})`);
    const d2 = await diag({ kind: 'all' });
    const left = (d2.findings ?? []).filter((x) => x.site === site || x.key === key);
    check(left.length === 0, `${tag}: a second diagnose finds nothing for ${site} or ${key} (${json(left.map((x) => [x.code, x.site, x.key]))})`);
    const r2 = await repair(d2.planId, true);
    const post2 = await pile();
    check(r2.written === 0 && sum(r2.credited) === 0 && G.same(back(post2.ledger), back(post.ledger)) && !r2.record, `${tag}: a second repair changes nothing (wrote ${r2.written}, credited ${sum(r2.credited)}, no record: ${r2.message})`);
    return { finding: { cells: f?.cells, lagging: f?.lagging }, dry: dry.written, written: r.written, moved, pending: pendItems, record: rec && { state: rec.state, cells: rec.cells.length } };
  }

  steps.drsurvival = async () => {
    await ensure();
    spendZero();
    const out = {};
    // the town
    await G.survivalBase(ctx);
    W = { name: 'G6B DR Survival' };
    await L.fresh(W.name, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await cmd('/op @a').catch(() => null);
    await G.designs(ctx);
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: TOWN }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    W.region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' }, autoApprove: false });
    W.group = (await call('dev.region.state', { region: W.region }, 60_000)).view?.groupId;
    for (const stage of ['ground', 'street', 'lots']) await cmd(`/apitest sapprove ${W.group} ${stage}`);

    // DR5: a fed lot built after the save; RL settles it at the start; no BOOK, nothing for the lot (one owner)
    {
      const tag = 'DR5';
      const isLot = (k, x) => /^s\d+$/.test(k) && (x.queued ?? 0) >= 50;
      let lot = null;
      for (let i = 0; i < 120 && !lot; i++) {
        lot = Object.entries((await pile()).targets ?? {}).find(([k, x]) => isLot(k, x) && (x.built ?? 0) < x.queued)?.[0] ?? null;
        if (!lot) { await deliver(isLot); await L.sleep(2500); }
      }
      check(!!lot, `${tag}: a lot site joined the feed (${lot})`);
      await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: true }, 60_000);
      await quiet();
      await deliver();
      await quiet();
      await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
      await cmd('/save-all flush');
      await L.settle(2000);
      await call('dev.stockpile.pause', { owner: G.OWNER, site: lot, paused: false }, 60_000);
      let t;
      for (let i = 0; i < 240; i++) { t = (await pile()).targets?.[lot]; if (t && t.built >= t.queued) break; await L.sleep(1000); }
      check(!!t && t.built >= t.queued, `${tag}: ${lot} built after the save (${t?.built}/${t?.queued})`);
      await L.settle(12_000);
      if (!(await halt(tag))) return out;
      const s5 = await restart(tag);
      const a = await call('dev.stockpile.audit', { owner: G.OWNER }, 120_000);
      const rec = a.reconciled?.[lot] ?? null;
      const d5 = await diag({ kind: 'all' });
      const book = (d5.findings ?? []).filter((x) => x.code === 'BOOK');
      const forLot = (d5.findings ?? []).filter((x) => x.site === lot);
      const rs = await call('dev.region.state', { region: W.region }, 60_000);
      const t2 = (await pile()).targets?.[lot];
      check(a.uncleanStart === true && !!rec && sum(rec.charged) > 0, `${tag}: RL's reconcile at the unclean start charged ${lot}'s cells built after the save (${json(rec && { ahead: rec.aheadCells, charged: sum(rec.charged), owed: rec.owedCells })})`, rec);
      check(book.length === 0 && forLot.length === 0, `${tag}: diagnose all: no BOOK finding and nothing for ${lot} (RL owns it) (${json(d5.findings?.map((x) => [x.code, x.site]))})`);
      check(!(s5.suspects ?? []).some((x) => x.site === lot), `${tag}: suspects() does not name the fed lot (${json(s5.suspects)})`);
      out.DR5 = { lot, reconciled: rec, findings: (d5.findings ?? []).map((x) => [x.code, x.site]), lotState: t2?.state ?? null, build: rs?.rs?.build ?? rs?.view?.build ?? null };
      log(`  ${tag}: ${json(out.DR5).slice(0, 400)}`);
      await cmd(`/apitest sapprove ${W.group} props`);
      const f = await G.feed({ L }, W.region, { fraction: 1, timeoutMs: 1_800_000, every: 2500 });
      check(f.last.st.view.state === 'PLACED' && f.last.rs.build?.done, `${tag}: the town fed until built (${f.waves} waves): ${f.last.st.view.state}; the region view's build done`);
      await quiet();
    }

    // DR4a: a single survival site's removal (J2 2a): stuck, its pending credit booked by the repair
    {
      const tag = 'DR4a';
      const targets = (await pile()).targets ?? {};
      const sites = Object.keys(targets).filter((k) => /^s\d+$/.test(k));
      const recs = [];
      for (const s of sites) { const r = await call('dev.pl.record', { site: s }, 30_000).catch(() => null); if (r) recs.push({ s, ...r, b: box(r.restoreBox) }); }
      recs.sort((a, b) => (a.b[3] - a.b[0]) * (a.b[5] - a.b[2]) - (b.b[3] - b.b[0]) * (b.b[5] - b.b[2]));
      const A = recs[0]; // the cottage (the smaller lot); the hall stays for DR4b
      W.hall = recs[recs.length - 1];
      check(!!A && !!W.hall && A.s !== W.hall.s, `${tag}: the cottage ${A?.s} (${A?.restoreBox}) and the hall ${W.hall?.s} (${W.hall?.restoreBox})`);
      await call('dev.stockpile.ps', { noPeriodic: true, noCreditSave: true }, 30_000);
      await cmd('/kill @e[type=item]');
      await cmd('/save-all flush');
      await L.settle(2000);
      const B = saved();
      const key = Object.keys(B.paid ?? {}).find((k) => k.startsWith(`site:${A.s}@`));
      check(!!key && sum(B.paid[key]) > 0, `${tag}: ${A.s}'s paid record on disk: ${key} (${sum(B.paid?.[key])} units)`);
      await rep('snap', { id: 'A', min: A.b.slice(0, 3), max: A.b.slice(3) });
      const rm = await call('dev.pl.remove', { site: A.s, requester: G.OWNER, force: false }, 600_000);
      check(rm.removed === true, `${tag}: ${A.s} removed on its own (${json(rm.blockers ?? [])})`);
      await L.settle(1500);
      const restored = await hash(A.b);
      const wb = westOf(A.b, gy);
      const lost = (await rep('unwrite', { id: 'A', min: wb.slice(0, 3), max: wb.slice(3) })).cells;
      check(lost > 0, `${tag}: the fault: ${lost} restored cell(s) of its west half put back as placed (their writes lost)`);
      if (!(await haltAS1(tag))) return out;
      const S = saved();
      check(!!S.pendingCredit?.[key] && !(S.credited ?? []).includes(key), `${tag}: on disk ${key}'s credit is pending (${sum(S.pendingCredit?.[key]?.items)} units), not credited`, { pend: S.pendingCredit?.[key] });
      const s1 = await restart(tag);
      out.DR4a = await stuckCase(tag, s1, A.s, A.b, lost, key, S);
      check(await hash(A.b) === restored, `${tag}: the box is as its removal committed it`);
      out.DR4a.site = A.s;
    }

    // DR4b: the rest removed as a region; its decCredit held pending on disk (DR-S); the hall stuck, repaired, credited once
    {
      const tag = 'DR4b';
      const H = W.hall;
      await call('dev.stockpile.ps', { noPeriodic: true, noCreditSave: true }, 30_000);
      await cmd('/kill @e[type=item]');
      await cmd('/save-all flush');
      await L.settle(2000);
      const B = saved();
      const keys = Object.keys(B.paid ?? {}).filter((k) => sum(B.paid[k]) > 0);
      const hkey = keys.find((k) => k.startsWith(`site:${H.s}@`));
      check(!!hkey && keys.length >= 2, `${tag}: the town's paid records on disk: ${keys.length} (${json(keys)})`);
      await rep('snap', { id: 'H', min: H.b.slice(0, 3), max: H.b.slice(3) });
      await G.remove(ctx, W.region);
      const sv = await call('dev.region.state', { region: W.region }, 60_000).catch(() => null);
      check(!sv?.view?.state || sv.view.state === 'REMOVED', `${tag}: the region removed (${sv?.view?.state ?? 'gone'})`);
      const restored = await hash(H.b);
      const wb = westOf(H.b, gy);
      const lost = (await rep('unwrite', { id: 'H', min: wb.slice(0, 3), max: wb.slice(3) })).cells;
      check(lost > 0, `${tag}: the fault: ${lost} restored cell(s) of the hall's west half put back as placed`);
      if (!(await haltAS1(tag))) return out;
      const S = saved();
      const missing = keys.filter((k) => !S.pendingCredit?.[k] && !(S.credited ?? []).includes(k));
      check(missing.length === 0 && !!S.pendingCredit?.[hkey], `${tag}: on disk every member's credit is pending or credited (decCredit's durable record; missing ${json(missing)}); the hall's ${hkey} pending (${sum(S.pendingCredit?.[hkey]?.items)})`, { pend: Object.keys(S.pendingCredit ?? {}), credited: S.credited });
      const s1 = await restart(tag);
      const atStart = await pile();
      const others = keys.filter((k) => k !== hkey && S.pendingCredit?.[k]);
      const bookedAtStart = G.minus(back(atStart.ledger), back(S));
      check(others.every((k) => !atStart.ledger?.pendingCredit?.[k]) && G.same(bookedAtStart, pendSum(S, others)), `${tag}: the members settled at the start booked their pending credits (${others.length} keys, ${sum(bookedAtStart)} units = ${sum(pendSum(S, others))} pending on disk)`, { bookedAtStart, others });
      out.DR4b = await stuckCase(tag, s1, H.s, H.b, lost, hkey, S);
      check(await hash(H.b) === restored, `${tag}: the hall's box is as its removal committed it`);
      const end = await pile();
      const all = G.minus(back(end.ledger), back(S));
      check(G.same(all, pendSum(S)) && Object.keys(end.ledger?.pendingCredit ?? {}).length === 0 && keys.every((k) => !end.ledger?.paid?.[k]),
        `${tag}: items in = items out against the saved state: ${sum(all)} units came back = every pending credit on disk (${sum(pendSum(S))}), each once; nothing pending; no member's paid record left`, { all, pend: pendSum(S) });
      out.DR4b.site = H.s;
      out.DR4b.atStart = { keys: others.length, units: sum(bookedAtStart) };
    }

    // DR8: PAID_ORPHAN: reported only
    {
      const tag = 'DR8';
      await call('dev.stockpile.ps', { noPeriodic: true }, 30_000);
      const key = 'site:sorphan@1';
      const inj = await rep('ledger', { owner: G.OWNER, key, paid: { 'minecraft:oak_planks': 5 } });
      check(inj.ok === true, `${tag}: a paid record ${key} naming no target (TEST injection, saved)`);
      const before = saved();
      const d = await diag({ kind: 'all' });
      const f = (d.findings ?? []).find((x) => x.code === 'PAID_ORPHAN' && x.key === key);
      check(!!f && f.cells === 5, `${tag}: PAID_ORPHAN ${key} reported (${f?.message})`);
      const r = await repair(d.planId, true);
      await L.settle(1000);
      const after = saved();
      const live = (await pile()).ledger;
      check(r.written === 0 && sum(r.credited) === 0 && !r.record && json(after) === json(before) && G.same(live?.paid?.[key], { 'minecraft:oak_planks': 5 }),
        `${tag}: the repair wrote and credited nothing, no record; the saved ledger is unchanged and the record stays (report only) (${r.message})`);
      out.DR8 = { key, finding: f?.message, repair: r.message };
    }

    // DR7: unresolved CUSTODY: credited under the cap once (FK's rule: the site is gone)
    {
      const tag = 'DR7';
      const key = 'site:scust@2';
      const items = { 'minecraft:flint': 4 };
      const inj = await rep('ledger', { owner: G.OWNER, key, paid: items, custody: items });
      check(inj.ok === true, `${tag}: custody ${json(items)} under ${key} with its fill paid, its site gone (TEST injection, saved)`);
      const d = await diag({ kind: 'all' });
      const f = (d.findings ?? []).find((x) => x.code === 'CUSTODY' && x.key === key);
      check(!!f && f.cells === 4, `${tag}: CUSTODY ${key} reported (${f?.message})`);
      const pre = await pile();
      const dry = await repair(d.planId, false);
      check(dry.applied === false && G.same(dry.credited, items), `${tag}: the dry run would credit ${json(dry.credited)} and writes nothing`);
      const r = await repair(d.planId, true);
      const post = await pile();
      const moved = G.minus(back(post.ledger), back(pre.ledger));
      check(r.applied === true && G.same(moved, items) && G.same(r.credited, items) && !post.ledger?.custody?.[key] && !post.ledger?.paid?.[key],
        `${tag}: credited once under the cap: ${json(moved)} = the custody, item for item; no custody and no paid record left (${r.message})`, { moved, credited: r.credited });
      const d2 = await diag({ kind: 'all' });
      const left = (d2.findings ?? []).filter((x) => x.key === key);
      const r2 = await repair(d2.planId, true);
      const post2 = await pile();
      check(left.length === 0 && r2.written === 0 && sum(r2.credited) === 0 && G.same(back(post2.ledger), back(post.ledger)), `${tag}: a second diagnose finds nothing for ${key} and a second repair credits nothing (${r2.message})`);
      out.DR7 = { key, moved, record: r.record };
    }
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
