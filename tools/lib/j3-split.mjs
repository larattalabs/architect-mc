// (GI2) j3-ingame's "the split" check (tools/gatej3.mjs): today's spend per mod, as the Jobs panel's ledger counts it (lab-ui JobCost.ownerMod:
// the owner's namespace before ':', a colon-less owner as is, no owner the publishing mod). The check used to assume only Steward and
// Architect spend today; in a run dir where sim-sets ran first an `apitest:` owner appears and Architect's part was off by it. Now every mod
// the expected entries or the panel name is compared on its own.

/** The mod a ledger owner counts under. */
export function ownerMod(owner, publisher = 'architect_mc') {
  const o = owner ?? '';
  const c = o.indexOf(':');
  return c > 0 ? o.slice(0, c) : o || publisher;
}

/** entries [{ usd, owner }] -> { mod: usd }. */
export function expectedByMod(entries, publisher = 'architect_mc') {
  const out = {};
  for (const e of entries) {
    const m = ownerMod(e.owner, publisher);
    out[m] = (out[m] ?? 0) + Number(e.usd ?? 0);
  }
  return out;
}

/** byMod: the panel's todayByMod; expected: expectedByMod's. -> { ok, diffs: [{ mod, panel, expected }] } (eps: the tolerance). */
export function splitDiffs(byMod, expected, eps = 1e-6) {
  const mods = new Set([...Object.keys(byMod ?? {}), ...Object.keys(expected)]);
  const diffs = [];
  for (const m of [...mods].sort()) {
    const a = Number(byMod?.[m] ?? 0);
    const b = Number(expected[m] ?? 0);
    if (Math.abs(a - b) >= eps) diffs.push({ mod: m, panel: a, expected: b });
  }
  return { ok: diffs.length === 0, diffs };
}
