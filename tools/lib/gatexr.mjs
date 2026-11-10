// (XR, docs/CONTRACT.md "Slice XR") Survival writers over paid cells, registered on tools/gate7agm.mjs by gate7agm-c.mjs:
//   xscan   (xr-scan, recorded)   each fixture of GATE_XR_FX (comma separated; default XR_SCAN) built and removed in survival with
//                                 gm-c-survctl's measure, plus dev.rs.overwrites after the build: which writer-over-victim rows the fixture
//                                 reaches (target, construction road, lot), the cells three or more writers changed, conservation
//   xsurv   (xr-survival, judged) each fixture of GATE_XR_SURV (default XR_SURV): conservation exact after the build and after
//                                 Regions.remove on every item, the stockpile audit's `retaken` = the items of the overwritten paid cells
//                                 (dev.rs.overwrites), E-flat 0, no item dropped; one fixture also removed mid-build after a retake
// $0: no Claude call.
import fs from 'node:fs';
import path from 'node:path';

/** The scan's fixtures: survival-capable plans with 4e roads (streets) and lots, and the crossings XL measured. */
export const XR_SCAN = ['rs/rs02_walled', 'rs/survival_village', 'rs/rs03_water', 'valid/v30_walled_village', 'valid/v7a_k3_castle', 'valid/v18_districts',
  'valid/v16_near_build_road_to_door', 'h/v45b_moat_road'];
/** The judged fixtures (chosen from the scan: docs/CONTRACT.md "Slice XR" §3). */
export const XR_SURV = ['h/v45b_moat_road'];

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

  /** One fixture: built in survival (fed whole), overwrites read, removed: the evidence. */
  async function one(name, { midRemove = false } = {}) {
    const fx = G.fixture(ctx, name);
    const entries = entriesOf(fx);
    const tag = `xr-${name.replace(/[^a-z0-9]+/gi, '-')}`.slice(0, 40);
    const c = await moat(tag, { creative: false, realise: false, name });
    const out = { name, overall: c.ck.check?.overall, survival: c.ck.check?.survival, entries: Object.keys(entries).length };
    if (!c.sha) return out;
    c.pre = await G.snap(ctx, c.box, `${tag}-pre`);
    const crates = await G.pile(ctx, c.s, 8);
    await killMobs();
    const cons = new G.Conservation(ctx, c.box);
    await cons.start();
    const region = await G.realise(ctx, c.sha, entries);
    out.region = region;
    if (midRemove) {
      // fed until the first retake (or the build), then removed mid-build: the refund of what stands, nothing given back twice
      let back = {}, f = null;
      const end = Date.now() + 3_600_000;
      while (Date.now() < end) {
        f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 12_000 });
        back = (await cons.parts()).retaken ?? {};
        if (Object.keys(back).length || f.last?.st?.view?.state === 'PLACED') break;
      }
      out.mid = { retaken: back, state: f?.last?.st?.view?.state };
    } else {
      const f = await G.feed(ctx, region, { cons, fraction: 1, timeoutMs: 3_600_000 });
      out.state = f.last.st.view.state;
    }
    out.built = await cons.point(midRemove ? 'mid-build' : 'built');
    const aud = await cons.parts();
    out.retaken = aud.retaken ?? {};
    const ow = await call('dev.rs.overwrites', { region }, 120_000);
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
    const names = (process.env.GATE_XR_FX || XR_SCAN.join(',')).split(',').filter(Boolean);
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
    const mid = process.env.GATE_XR_MID ?? names[0];
    if (mid) {
      const r = await one(mid, { midRemove: true });
      out.mid = { ...r, owRows: r.owRows?.slice(0, 40) };
      check(Object.keys(r.mid?.retaken ?? {}).length > 0, `mid-build (${mid}): removed after a retake (retaken ${json(r.mid?.retaken)}, ${r.mid?.state})`);
      check(G.exact(r.built), `mid-build (${mid}): conservation exact before the removal: ${json(r.built.diff)}`);
      check(r.removedOk && G.exact(r.removed), `mid-build (${mid}): Regions.remove mid-build, conservation exact: ${json(r.removed.diff)}`);
      check(r.eflat === 0, `mid-build (${mid}): E-flat ${r.eflat}`, r.eflatList);
      check(!r.items, `mid-build (${mid}): no item dropped (${r.items})`);
    }
    return out;
  };
}
