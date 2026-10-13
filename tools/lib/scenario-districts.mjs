// (6c D1) districts_demo's scenario metrics and bars (docs/CONTRACT.md "Phase 6c slice D" §4): item 2 (every district in its level
// band), item 3 (every district node reaches every other by the plan's edges; the realised graph's player reach and the villager mover
// along every routed edge, vanilla's villager path both ways), item 4 (the added loop cost within loopiness of the tree's, +-0.02),
// the checker over the routes. tools/scenarios.mjs calls these for phase 6c-d (the timing row t-tiles is its BAR).

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });

/** Connected components of an IR graph (external edges left out): [[nodeId]]. */
export function graphComponents(graph) {
  const adj = new Map((graph?.nodes ?? []).map((n) => [n.id, []]));
  for (const e of graph?.edges ?? []) {
    if (e.external) continue;
    const a = String(e.from).split('.')[0], b = String(e.to).split('.')[0];
    adj.get(a)?.push(b); adj.get(b)?.push(a);
  }
  const seen = new Set(), out = [];
  for (const n of graph?.nodes ?? []) {
    if (seen.has(n.id)) continue;
    const c = [n.id];
    seen.add(n.id);
    for (let i = 0; i < c.length; i++) for (const y of adj.get(c[i]) ?? []) if (!seen.has(y)) { seen.add(y); c.push(y); }
    out.push(c);
  }
  return out;
}

export function districtsMetrics({ ir, meta, report, realised, nav }) {
  const d = meta.districts ?? null;
  const comps = graphComponents(ir.graph);
  return {
    districts: d ? { rects: d.rects, bandOf: d.bandOf, unplaced: d.unplaced, exact: d.exact, method: d.method, edges: d.edges, treeCost: d.treeCost, loopCost: d.loopCost, loopiness: d.loopiness, ms: d.ms } : null,
    components: comps.length, componentSizes: comps.map((c) => c.length),
    virtual: report?.metrics?.route ?? null, realised: realised?.metrics?.route ?? null,
    M5route: { virtual: report?.metrics?.M5route ?? null, realised: realised?.metrics?.M5route ?? null },
    nav: nav ? Object.fromEntries(Object.entries(nav.edges).map(([k, v]) => [k, v.there.canReach && v.back.canReach])) : null,
  };
}

export function districtsBars(m, report, rows, { flat = false } = {}) {
  // the 6b safety row and the 6b checker row are recorded: D's own checker row judges errors and M1, M2, M4 (V's street layout on a
  // slope can leave a verge cell over a slope pad's batter: M3 warnings, recorded there; queued for V)
  const out = rows.map((r) => (r.id === 'safety' || r.id === 'checker' ? { ...r, gated: false, pass: null, label: `${r.label} (recorded: D's checker row below)` } : r));
  const d = m.districts;
  if (!d) { out.push(row('d-pass', 'D The districts pass ran', 'no meta.districts', 'ran', false)); return out; }
  const bands = Object.entries(d.bandOf ?? {});
  // on the flat variant every candidate is one band: the bands row is the natural run's
  out.push(row('d-bands', 'D 2 Level bands (every district in its band)', `${bands.map(([id, b]) => `${id} y ${b.y} ${b.got} (want ${b.want})`).join('; ')}; unplaced ${JSON.stringify(d.unplaced.map((u) => `${u.id} ${u.reason}`))}`,
    'every district placed, in its band', flat || (bands.length > 0 && d.unplaced.length === 0 && bands.every(([, b]) => b.want === 'any' || b.got === b.want))));
  const r = m.realised;
  const okEdges = (d.edges ?? []).filter((e) => e.ok).length;
  const navTxt = m.nav ? `${Object.values(m.nav).filter(Boolean).length}/${Object.keys(m.nav).length} vanilla both ways` : 'n/a (flat run)';
  const navOk = flat || (m.nav && Object.keys(m.nav).length === okEdges && Object.values(m.nav).every(Boolean));
  out.push(row('d-connect', 'D 3 Connectivity (one graph; realised player and villager reach along every edge; vanilla villager paths)',
    `graph components ${m.components} (${m.componentSizes.join('/')}); edges routed ${okEdges}/${(d.edges ?? []).length}; realised player ${r ? `${r.playerReached}/${r.edges.filter((e) => e.ok).length}` : 'n/a'}, villager ${r ? `${r.villagerReached}/${r.villagerEdges}` : 'n/a'}; ${navTxt}`,
    'one component; 100%', m.components === 1 && okEdges === (d.edges ?? []).length && r && r.playerReached === r.edges.filter((e) => e.ok).length && r.villagerReached === r.villagerEdges && navOk));
  out.push(row('d-loop', 'D 4 Loopiness (added loop cost within loopiness of the tree\'s, +-0.02)', `tree ${d.treeCost}, loops ${d.loopCost} (${d.treeCost ? (d.loopCost / d.treeCost).toFixed(3) : '0'}), loopiness ${d.loopiness}; ${(d.edges ?? []).map((e) => `${e.id} ${e.kind}`).join(', ')}`,
    `<= loopiness + 0.02`, d.loopCost <= (d.loopiness + 0.02) * d.treeCost));
  const m124 = (report?.findings ?? []).filter((f) => /^M[124]\b/.test(f.rule));
  const m3 = (report?.findings ?? []).filter((f) => /^M3\b/.test(f.rule));
  const m5 = m.M5route.virtual;
  out.push(row('d-checker', 'D Checker (0 errors, no M1, M2, M4; M3 and M5 over the routes recorded)', `${report?.errors ?? '?'} errors; M1, M2, M4 findings ${m124.length}${m124.length ? ` (${m124.slice(0, 4).map((f) => `${f.rule} ${f.part ?? '-'}: ${f.message.slice(0, 80)}`).join('; ')})` : ''}; M3 (recorded) ${m3.map((f) => `${f.rule} ${f.part ?? '-'} x${f.count}`).join(', ') || 'none'}; M5 routes ${m5 ? `${(100 * m5.share).toFixed(2)}% of ${m5.walkCells}` : 'n/a'}`,
    '0 errors, no M1, M2, M4', report?.errors === 0 && m124.length === 0));
  return out;
}
