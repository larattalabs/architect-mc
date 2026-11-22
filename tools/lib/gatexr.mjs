// (XR, docs/CONTRACT.md "Slice XR") Survival writers over paid cells, registered on tools/gate7agm.mjs by gate7agm-c.mjs:
//   xscan   (xr-scan, recorded)   each fixture of GATE_XR_FX (comma separated; default XR_SCAN) built and removed in survival with
//                                 gm-c-survctl's measure, plus dev.rs.overwrites after the build: which writer-over-victim rows the fixture
//                                 reaches (target, construction road, lot), the cells three or more writers changed, conservation
//   xsurv   (xr-survival, judged) each fixture of GATE_XR_SURV (default XR_SURV): conservation exact after the build and after
//                                 Regions.remove on every item, the stockpile audit's `retaken` = the items of the overwritten paid cells
//                                 (dev.rs.overwrites), E-flat 0, no item dropped; one fixture also removed mid-build after a retake
//   xcrash  (xr-crash, PLR2)      xr_demo in survival, halted twice (GATE_XR_CRASH: XR1, K4; default both): XR1+save, its free pass's first
//                                 take-up of a paid block written and saved with the ledger: the restart's crash rollback is refused (the
//                                 item FAILED with the cause, the cell keeps the free pass's block, the record and entry kept), then
//                                 conservation exact and Regions.remove; K4 (a tile's ACTIVE commit, its record saved placing, the queue
//                                 file not past its job), then PLR2X (the restart's queue save written, its extra targets just settled):
//                                 after the next start no extra target of the halted attempt is live and the region builds
// $0: no Claude call.
import fs from 'node:fs';
import path from 'node:path';

/** The scan's fixtures: survival-capable plans with 4e roads (streets) and lots, and the crossings XL measured. */
export const XR_SCAN = ['rs/rs02_walled', 'rs/survival_village', 'rs/rs03_water', 'valid/v18_districts', 'h/v45b_moat_road'];
/** The scan's kit programs (planned over rs/survival_village's flat claim): `program` or `program:<n lots>`. */
export const XR_SCAN_PROGS = ['flat_village:4', 'xr_demo'];
/** The judged fixtures (chosen from the scan: docs/CONTRACT.md "Slice XR" §3). */
export const XR_SURV = ['prog:xr_demo', 'h/v45b_moat_road'];

/** The lot entries a fixture binds (its lotEntries, else every lot an rs_hut, a farm, a smithy or a barn an rs_shed), as RS's entriesOf. */
export function entriesOf(fx) {
  if (fx.lotEntries) return fx.lotEntries;
  const out = {};
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.lots)) for (const l of o.lots) if (l?.id && l.type) out[l.id] = ['farm', 'smithy', 'barn'].includes(l.type) ? 'rs_shed' : 'rs_hut';
      Object.values(o).forEach(walk);
    }
  };
  walk(fx.plan?.zones ?? []);
  return out;
}

/** The items of the overwritten paid cells a retake should give back: per victim cell, the victim block's items (its plan's block). */
export function expectedBack(rows) {
  const out = {};
  const seen = new Set();
  for (const r of rows ?? []) {
    if (!r.foundVictims) continue; // the writer found another block there (the victim built later): nothing of the victim's was taken up
    const k = `${r.pos.join(',')}|${r.victim}`;
    if (seen.has(k)) continue;
    seen.add(k);
    for (const [i, n] of Object.entries(r.victimItems ?? {})) out[i] = (out[i] ?? 0) + n;
  }
  return out;
}

export async function registerXr(steps, h) {
  const { L, call, check, log, OUT, json, G, ctx, moat, killMobs } = h;
  const ensure = async () => { if (!L.state.dev) await L.connect(); };

  /**
   * One fixture (or a kit program `prog:<program>[:<lots>]`, planned over rs/survival_village's flat claim): built in survival (fed whole),
   * overwrites read, removed: the evidence.
   */
  async function one(name, { midRemove = false, stopWhen = (back) => Object.keys(back).length > 0 } = {}) {
    const prog = name.startsWith('prog:') ? name.slice(5).split(':') : null;
    const fx = G.fixture(ctx, prog ? 'rs/survival_village' : name);
    let entries = entriesOf(fx);
    const tag = `xr-${name.replace(/[^a-z0-9]+/gi, '-')}`.slice(0, 40);
    const c = await moat(tag, { creative: false, realise: false, name: prog ? 'rs/survival_village' : name });
    const out = { name, overall: c.ck.check?.overall, survival: c.ck.check?.survival, entries: Object.keys(entries).length };
    let planId = null;
    if (prog) {
      const n = Number(prog[1] ?? 0);
      const params = n ? { lots: Array.from({ length: n }, (_, k) => ({ id: `h${k + 1}`, type: 'house', size: [9, 9] })) } : {};
      const p = await call('dev.region.plan', { program: prog[0], params, claim: c.s.W.claim, owner: G.OWNER, surveyLoad: 'generated:64', check: false }, 900_000);
      out.overall = p.refused ? `refused: ${JSON.stringify(p.refused).slice(0, 200)}` : 'PLANNED';
      planId = p.planId ?? null;
      entries = Object.fromEntries((p.lots ?? []).map((l) => [l.id ?? l, 'rs_hut']));
      out.entries = Object.keys(entries).length;
      if (!planId) return out;
    } else if (!c.sha) return out;
    c.pre = await G.snap(ctx, c.box, `${tag}-pre`);
    const crates = await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    let region;
    if (planId) {
      const rr = await call('dev.region.realise', { planId, ...(Object.keys(entries).length ? { lots: entries } : {}) }, 300_000);
      if (!rr.region) throw new Error(`realise refused: ${JSON.stringify(rr.refused ?? rr).slice(0, 300)}`);
      region = rr.region;
    } else region = await G.realise(ctx, c.sha, entries);
    out.region = region;
    if (midRemove) {
      // fed until the first retake (or the build), then removed mid-build: the refund of what stands, nothing given back twice
      // one feed wave at a time, the audit read before each: the removal starts as soon as `stopWhen` holds, before the next wave
      let back = {}, st = null;
      const end = Date.now() + 3_600_000;
      while (Date.now() < end) {
        back = (await cons.parts()).retaken ?? {};
        st = await G.regionState(ctx, region);
        // (a survival region is PLACED once every item is put down; built when every target, road and lot is: rs.build.done)
        if (stopWhen(back) || (await G.rsState(ctx, region)).build?.done) break;
        if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await killMobs();
        const ps = await G.pileState(ctx);
        const need = {};
        for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
        if (Object.keys(need).length) await cons.insert(`stockpile:${G.OWNER}`, need);
        await L.sleep(1500);
      }
      const rs = await G.rsState(ctx, region);
      out.mid = { retaken: back, state: st?.view?.state, done: rs.build?.done ?? null, parts: (rs.build?.parts ?? []).map((p) => [p.part, p.state]) };
    } else {
      const f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 3_600_000 });
      out.state = f.last.st.view.state;
    }
    out.built = await cons.point(midRemove ? 'mid-build' : 'built');
    const aud = await cons.parts();
    out.retaken = aud.retaken ?? {};
    // (a build without the dev op, e.g. the base for a before/after: no rows)
    const ow = await call('dev.rs.overwrites', { region }, 120_000).catch((e) => ({ error: String(e?.message ?? e) }));
    out.overwrites = { counts: ow.counts ?? {}, multi: ow.cellsChangedBy3OrMore ?? 0, rows: (ow.rows ?? []).length, writers: (ow.writers ?? []).map((w) => `${w.kind}:${w.id}`) };
    fs.writeFileSync(path.join(OUT, `${tag}-overwrites.json`), `${JSON.stringify(ow, null, 1)}\n`);
    out.owRows = ow.rows ?? [];
    await L.cmd('/kill @e[type=minecraft:item]');
    const rm = await G.remove(ctx, region);
    out.removed = await cons.point('removed');
    out.removedOk = rm.removed;
    const e = await G.diff(ctx, c.box, c.pre);
    const ef = e.list.filter((q) => !crates.some((k2) => k2.join(',') === q.pos));
    out.eflat = ef.length;
    out.eflatList = ef.slice(0, 8);
    const it = await call('dev.items.near', { pos: [Math.round((c.box[0] + c.box[3]) / 2), c.box[4], Math.round((c.box[2] + c.box[5]) / 2)], radius: 200 }, 30_000).catch(() => ({}));
    out.items = it.stacks ?? 0;
    log(`  xr ${name}: ${json({ ...out, owRows: undefined })}`);
    await L.leaveWorld();
    return out;
  }

  steps.xscan = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const fxs = process.env.GATE_XR_FX === 'none' ? [] : (process.env.GATE_XR_FX || XR_SCAN.join(',')).split(',').filter(Boolean);
    const progs = process.env.GATE_XR_PROGS === 'none' ? [] : (process.env.GATE_XR_PROGS || XR_SCAN_PROGS.join(',')).split(',').filter(Boolean).map((p) => `prog:${p}`);
    const names = [...fxs, ...progs];
    const out = {};
    for (const n of names) {
      try {
        const r = await one(n);
        out[n] = { ...r, owRows: r.owRows?.slice(0, 40) };
        // recorded: the scan judges nothing but that each fixture ran
        check(!!r.region || r.overall !== 'READY', `scan ${n}: ${r.overall} ${r.state ?? ''}: overwrites ${json(r.overwrites?.counts)} (3+ writers: ${r.overwrites?.multi}); retaken ${json(r.retaken)}; conservation built ${json(r.built?.diff)} removed ${json(r.removed?.diff)}; E-flat ${r.eflat}`);
      } catch (e) {
        out[n] = { error: String(e?.stack ?? e) };
        log(`  xr scan ${n} failed: ${e?.message}`);
        await L.leaveWorld().catch(() => null);
      }
    }
    return out;
  };

  /** (slice PLR2) xr_demo in survival, planned and realised with `point` armed; fed until the halt: {c, region, world, cons, down}. */
  async function xrHalt(tag, point) {
    const c = await moat(tag, { creative: false, realise: false, name: 'rs/survival_village' });
    const p = await call('dev.region.plan', { program: 'xr_demo', params: {}, claim: c.s.W.claim, owner: G.OWNER, surveyLoad: 'generated:64', check: false }, 900_000);
    if (!p.planId) throw new Error(`xr_demo refused: ${JSON.stringify(p.refused).slice(0, 200)}`);
    const entries = Object.fromEntries((p.lots ?? []).map((l) => [l.id ?? l, 'rs_hut']));
    c.pre = await G.snap(ctx, c.box, `${tag}-pre`);
    const crates = await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    await call('dev.journal.killAt', { point }, 10_000);
    const rr = await call('dev.region.realise', { planId: p.planId, ...(Object.keys(entries).length ? { lots: entries } : {}) }, 300_000);
    if (!rr.region) throw new Error(`realise refused: ${JSON.stringify(rr.refused ?? rr).slice(0, 300)}`);
    let down = false;
    for (const end = Date.now() + 2_400_000; Date.now() < end && !down; ) {
      const s = await call('dev.state', {}, 10_000).catch(() => null);
      if (s && s.inWorld === false) { down = true; break; }
      try {
        const ps = await G.pileState(ctx);
        const need = {};
        for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
        if (Object.keys(need).length) await cons.insert(`stockpile:${G.OWNER}`, need);
        const st = await G.regionState(ctx, rr.region);
        if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await killMobs();
      } catch { /* the halt */ }
      await L.sleep(1500);
    }
    if (!down) await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null);
    return { c, region: rr.region, world: c.s.world, cons, crates, down };
  }

  const saveFile = (world, f) => { const q = path.join(L.SAVES, world, f); return fs.existsSync(q) ? JSON.parse(fs.readFileSync(q, 'utf8')) : null; };
  const stateAt = async (pos) => {
    const h = await call('dev.box.hash', { min: pos, max: pos, cells: true }, 60_000);
    const l = (h.cells ?? [])[0] ?? '';
    return l.slice(l.indexOf(' ') + 1).split(' be=')[0];
  };
  const blockId = (s) => (/(minecraft:[a-z0-9_]+)/.exec(String(s)) ?? /Block\{([a-z0-9_:]+)\}/.exec(String(s)) ?? [])[1] ?? String(s);
  const itemOf = (world, key) => (saveFile(world, 'architect-queue.json')?.batches ?? []).flatMap((b) => b.items ?? []).find((i) => i.key === key) ?? null;
  /** Feeds until the region's build is done (or `ms` passes), the conservation sum's inserts counted. */
  async function feedOn(region, cons, ms) {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      const rs = await G.rsState(ctx, region);
      const st = await G.regionState(ctx, region);
      if (rs.build?.done && !['REALISING', 'RUNNING'].includes(st?.view?.state)) return { st, rs };
      if (['OCCUPIED', 'PLAYER_IN_BOX'].includes(st?.view?.waiting?.reason)) await killMobs();
      const ps = await G.pileState(ctx);
      const need = {};
      for (const [it, n] of Object.entries(ps.outstanding ?? {})) { const lack = n - (ps.stock?.[it] ?? 0); if (lack > 0) need[it] = lack; }
      if (Object.keys(need).length) await cons.insert(`stockpile:${G.OWNER}`, need);
      await L.sleep(2000);
    }
    return { st: await G.regionState(ctx, region), rs: await G.rsState(ctx, region) };
  }

  steps.xcrash = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const want = (process.env.GATE_XR_CRASH || 'XR1,K4').split(',');
    const out = {};
    if (want.includes('XR1')) {
      // P1 3: a crash rollback of a free pass that took up a paid block, its chunks and credits saved
      const H = await xrHalt('xr-crash-xr1', 'XR1+save');
      check(H.down, 'XR1+save: a free pass took up a paid block and the server halted, its chunks and ledger saved');
      const x = H.down ? saveFile(H.world, 'architect-dev-xr1.json') : null;
      out.xr1 = { region: H.region, at: x };
      if (x) {
        await L.openWorld(H.world);
        await L.tp(x.pos[0], x.pos[1] + 20, x.pos[2]);
        await L.settle(8000);
        for (let i = 0; i < 60; i++) { const j = await call('dev.placement.jobs', {}, 10_000).catch(() => []); if (!(j ?? []).some((q) => q.site === x.site)) break; await L.sleep(1000); }
        const now = await stateAt(x.pos);
        const p0 = await H.cons.point('after the restart');
        await L.leaveWorld();
        const item = itemOf(H.world, x.item);
        const rec = (saveFile(H.world, 'architect-sites.json')?.infra ?? []).find((r) => r.id === x.site);
        out.xr1.after = { now, item, record: rec ? { placing: rec.placing, pending: rec.pendingSince != null } : null, conservation: p0 };
        check(item?.status === 'FAILED' && /given back|paid/.test(item?.message ?? '') && blockId(now) !== blockId(x.was) && rec?.placing === true && rec?.pendingSince == null,
          `XR1+save: the restart refused ${x.site}'s crash rollback (${x.item} ${item?.status}: ${item?.message}); ${x.pos.join(',')} keeps the free pass's block (${blockId(now)}, ${blockId(x.was)} was given back: ${json(x.back)}), its record kept placing (${json(out.xr1.after.record)})`, out.xr1.after);
        check(G.exact(p0), `XR1+save: conservation exact after the restart: ${json(p0.diff)} (identity ${p0.identity})`, p0);
        // the region builds on (the parked tile's item failed), then Regions.remove: nothing given back twice
        await L.openWorld(H.world);
        await L.tp(x.pos[0], x.pos[1] + 20, x.pos[2]);
        const f = await feedOn(H.region, H.cons, 1_800_000);
        const p1 = await H.cons.point('built');
        await L.cmd('/kill @e[type=minecraft:item]');
        const rm = await G.remove(ctx, H.region);
        const p2 = await H.cons.point('removed');
        const e = await G.diff(ctx, H.c.box, H.c.pre);
        const ef = e.list.filter((q) => !H.crates.some((k2) => k2.join(',') === q.pos));
        out.xr1.end = { state: f.st?.view?.state, built: f.rs?.build?.done, p1, removed: rm.removed, p2, eflat: ef.length, eflatList: ef.slice(0, 8) };
        check(G.exact(p1), `XR1+save: conservation exact once the region built on (${f.st?.view?.state}, done ${f.rs?.build?.done}): ${json(p1.diff)}`, p1);
        check(rm.removed && G.exact(p2) && ef.length === 0, `XR1+save: Regions.remove with the parked tile: conservation exact ${json(p2.diff)}, E-flat ${ef.length}`, out.xr1.end);
        await L.leaveWorld();
      }
    }
    if (want.includes('K4')) {
      // P1 2: a tile's ACTIVE commit with extra targets, its record saved placing, the queue file not past its job; the restart settles its
      // extras, its queue save is written, and the server halts again (PLR2X)
      const H = await xrHalt('xr-crash-k4', 'K4');
      check(H.down, 'K4: the kill point halted the server');
      const q = H.down ? saveFile(H.world, 'architect-queue.json') : null;
      const infra0 = saveFile(H.world, 'architect-sites.json')?.infra ?? [];
      const job = (q?.jobs ?? []).find((j) => j.kind === 'infra' && j.beforeRecord && infra0.some((r) => r.id === j.siteId && r.placing));
      const extras = (job?.extras ?? []).map((e) => e.record.id);
      out.k4 = { region: H.region, job: job ? { site: job.siteId, item: job.itemKey, extras } : null };
      check(!!job && extras.length > 0, `K4: the halted tile's job is older than its record (stale, ${job?.siteId}) and has extra targets (${extras.join(', ')})`, out.k4);
      if (job && extras.length) {
        fs.writeFileSync(path.join(L.SAVES, H.world, 'architect-dev-arm.json'), JSON.stringify({ killAt: 'PLR2X' }));
        let second = false;
        await call('dev.world.open', { name: H.world }, 150_000).catch(() => null);
        for (let i = 0; i < 90 && !second; i++) { const s = await call('dev.state', {}, 10_000).catch(() => null); second = !!s && s.inWorld === false; if (!second) await L.sleep(2000); }
        check(second, 'K4 then PLR2X: the restart settled the extra targets, wrote its queue save and halted again');
        await L.openWorld(H.world);
        const xs = H.c.box;
        await L.tp(Math.round((xs[0] + xs[3]) / 2), xs[4], Math.round((xs[2] + xs[5]) / 2));
        const f = await feedOn(H.region, H.cons, 1_800_000);
        const p1 = await H.cons.point('built');
        await L.leaveWorld();
        const infra = saveFile(H.world, 'architect-sites.json')?.infra ?? [];
        const liveExtra = infra.filter((r) => extras.includes(r.id) && r.pendingSince == null).map((r) => r.id);
        const item = itemOf(H.world, job.itemKey);
        out.k4.after = { liveExtra, item: item?.status, itemSite: item?.siteId, state: f.st?.view?.state, built: f.rs?.build?.done, p1 };
        check(liveExtra.length === 0 && item?.status === 'PLACED' && item?.siteId !== job.siteId,
          `K4 then PLR2X: no extra target of the halted attempt is live after the second crash (${liveExtra.join(', ') || 'none'}; never rebuilt from the journal untracked), its item placed again as ${item?.siteId} (${item?.status})`, out.k4.after);
        check(f.rs?.build?.done && G.exact(p1), `K4 then PLR2X: the region built (${f.st?.view?.state}, done ${f.rs?.build?.done}), conservation exact ${json(p1.diff)}`, p1);
      }
    }
    return out;
  };

  steps.xsurv = async () => {
    await ensure();
    await L.leaveWorld().catch(() => null);
    const names = (process.env.GATE_XR_SURV || XR_SURV.join(',')).split(',').filter(Boolean);
    const out = {};
    for (const n of names) {
      const r = await one(n);
      out[n] = { ...r, owRows: r.owRows?.slice(0, 40) };
      const want = expectedBack(r.owRows);
      out[n].want = want;
      check(r.state === 'PLACED', `${n}: built in survival (${r.state})`);
      check(Object.keys(r.overwrites?.counts ?? {}).length > 0, `${n}: reaches writer-over-paid-cell rows ${json(r.overwrites?.counts)} (3+ writers on one cell: ${r.overwrites?.multi})`);
      check(G.exact(r.built), `${n}: conservation exact after the build, every item: ${json(r.built.diff)} (identity ${r.built.identity})`);
      check(G.same(r.retaken, want), `${n}: the audit's retaken = the overwritten paid cells' items (dev.rs.overwrites): ${json(r.retaken)} vs ${json(want)} (${json(G.minus(r.retaken, want))})`);
      check(r.removedOk && G.exact(r.removed), `${n}: Regions.remove, conservation exact after the removal, every item: ${json(r.removed.diff)}`);
      check(r.eflat === 0, `${n}: E-flat ${r.eflat} after the removal (the crates aside)`, r.eflatList);
      check(!r.items, `${n}: no item dropped (${r.items})`);
    }
    // mid-build removals on xr_demo: after its first take-up (a target over a target, the street stage), and after its lots were put
    // down (their placement's take-ups credited, the pavement's 81 + 47 + 3 stone bricks back), the lots starved, not built
    const mid = process.env.GATE_XR_MID ?? 'prog:xr_demo';
    const mids = [['first take-up', (b) => Object.keys(b).length > 0], ['lots put down', (b) => (b['minecraft:stone_bricks'] ?? 0) >= 131]];
    out.mids = {};
    if (mid !== 'none') for (const [label, stopWhen] of mids) {
      const r = await one(mid, { midRemove: true, stopWhen });
      out.mids[label] = { ...r, owRows: r.owRows?.slice(0, 40) };
      check(stopWhen(r.mid?.retaken ?? {}) && r.mid?.done === false, `mid-build (${mid}, ${label}): removed with retaken ${json(r.mid?.retaken)}, not built (${r.mid?.state}, done ${r.mid?.done}; ${json(r.mid?.parts)})`);
      check(G.exact(r.built), `mid-build (${mid}, ${label}): conservation exact before the removal: ${json(r.built.diff)}`);
      check(r.removedOk && G.exact(r.removed), `mid-build (${mid}, ${label}): Regions.remove mid-build, conservation exact: ${json(r.removed.diff)}`);
      check(r.eflat === 0, `mid-build (${mid}, ${label}): E-flat ${r.eflat}`, r.eflatList);
      check(!r.items, `mid-build (${mid}, ${label}): no item dropped (${r.items})`);
    }
    return out;
  };
}
