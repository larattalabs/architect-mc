// Slice BC-c gate helpers (docs/CONTRACT.md "Slice BC-c as built"): the save-path kill cases realise their survival regions under a
// maxBill (the put-down quote), so RL's reconcile and the regions' own charges run inside the running cap; after each restart the cap is
// read back: no overshoot, no target held bill_cap, and the cap's total equals the charges (the group's paid records plus the region's own
// fluids' and gate mechanisms' charges). Used by gatem5rl, gatemps, gatemhf and gatemsad. $0.

/** The cap helpers over one gate's dev bridge. `owner`: the stockpile owner whose reconcile records are read. */
export function bccCaps({ call, check, json, G, owner, log }) {
  const regions = new Set();
  // (fix b5b, the GPT review's P2) the caps each region held before a restart, by its record (createdAt): after the restart every one must
  // still be there (a lost cap is a failure, not a skipped check)
  const expected = new Map();

  /** The quote of `planId` with these lots, as a maxBill (its bom). */
  async function quoteCap(planId, lots = {}) {
    const q = await call('dev.region.quote', { planId, lotEntries: lots }, 300_000);
    if (q.refused || !q.bom) throw new Error(`BC-c: no quote for ${planId}: ${json(q.refused ?? q)}`);
    return q.bom;
  }

  /** L.realise with maxBill = the put-down quote; the region is read back after every restart ({@link afterRestart}). */
  async function realise(L, planId, opts = {}) {
    const maxBill = await quoteCap(planId, opts.lots ?? {});
    const region = await L.realise(planId, { ...opts, maxBill });
    regions.add(region);
    await expect(region);
    check(Object.keys(expected.get(region)?.caps ?? {}).length > 0, `BC-c: region ${region} realised under a maxBill records its cap (${json(expected.get(region)?.caps ?? null)})`);
    return region;
  }

  /** Records `region`'s caps now (its record's createdAt and every rid's maxBill) as what each later restart must find. */
  async function expect(region) {
    const c = await state(region);
    if (c) expected.set(region, { createdAt: c.createdAt, caps: Object.fromEntries(Object.entries(c.caps ?? {}).map(([rid, e]) => [rid, e.maxBill])) });
    return c;
  }

  /** A region realised elsewhere under a cap: read back after every restart too (its caps recorded now; await it). */
  const track = async (region) => {
    if (!region) return;
    regions.add(region);
    await expect(region);
  };

  /** One capped region's state (dev.bc.cap), or null when it is gone (removed). */
  async function state(region, rid) {
    const c = await call('dev.bc.cap', { region, ...(rid === undefined ? {} : { rid }) }, 30_000).catch(() => null);
    return !c || c.refused ? null : c;
  }

  /**
   * After a restart (the reconcile ran): every capped region's draws within the cap, no target held bill_cap, the total equal to the charges
   * (paid records + the region's own); every reconcile record under a cap names no overshoot. Returns the readings.
   */
  async function afterRestart(tag) {
    const a = await call('dev.stockpile.audit', { owner }, 120_000).catch(() => ({}));
    const rc = Object.entries(a.reconciled ?? {}).filter(([, x]) => x.capRegion);
    const out = { reconciledUnderCap: rc.map(([id, x]) => ({ id, region: x.capRegion, capOver: x.capOver, charged: x.charged })), regions: [] };
    check(rc.every(([, x]) => Object.keys(x.capOver ?? {}).length === 0), `${tag} (BC-c): the reconcile under a maxBill (${rc.length} target(s) reconciled under a cap: ${rc.map(([id, x]) => `${id} ${json(x.capOver)}`).join(', ') || 'none'}) charged no standing cell past it`, out.reconciledUnderCap);
    for (const region of regions) {
      const c0 = await state(region);
      const want = expected.get(region);
      const same = !!c0 && !!want && c0.createdAt === want.createdAt;
      if (!c0 && want) log?.(`  ${tag} (BC-c): region ${region} is gone (removed, or another world's): its caps are not read`);
      if (!c0) continue;
      if (same) {
        // every cap recorded before the restart is still there, unchanged
        const now = Object.fromEntries(Object.entries(c0.caps ?? {}).map(([rid, e]) => [rid, e.maxBill]));
        const lost = Object.keys(want.caps).filter((rid) => !now[rid] || !G.same(now[rid], want.caps[rid]));
        check(lost.length === 0, `${tag} (BC-c): region ${region} keeps every cap it held before the restart (rids ${Object.keys(want.caps).join(',') || 'none'}; lost or changed: ${json(lost)})`, { want: want.caps, now });
      }
      const rids = new Set([...Object.keys(c0.caps ?? {}), ...(same ? Object.keys(want.caps) : [])]);
      for (const rid of [...rids].map(Number)) {
        // (BC-d) each rid's own cap: its own targets' draws and the region's charges for it
        const c = await state(region, rid);
        if (!c) continue;
        const total = G.plus(c.paid ?? {}, c.regionCharged ?? {});
        const blocked = (c.targets ?? []).filter((x) => x.blocked === 'bill_cap').map((x) => x.id);
        const r = { region, rid, drawn: c.drawn, paid: c.paid, regionCharged: c.regionCharged, overshoot: c.overshoot, blocked };
        out.regions.push(r);
        if (!c.maxBill) { check(false, `${tag} (BC-c): region ${region} rid ${rid}: no maxBill after the restart`, r); continue; }
        check(c.rid === rid && G.same(c.drawn, total) && Object.keys(c.overshoot ?? {}).length === 0 && blocked.length === 0,
          `${tag} (BC-c): region ${region} rid ${rid} after the restart: within its maxBill (overshoot ${json(c.overshoot)}); the cap's total = the charges (drawn ${sumOf(c.drawn)} = paid ${sumOf(c.paid)} + region ${json(c.regionCharged)}); held bill_cap: ${json(blocked)}`, r);
      }
    }
    for (const region of regions) if (expected.has(region)) await expect(region); // the next restart's expectation: the caps as they are now
    return out;
  }

  return { quoteCap, realise, track, expect, state, afterRestart, regions, expected };
}

const sumOf = (m) => Object.values(m ?? {}).reduce((n, v) => n + v, 0);
