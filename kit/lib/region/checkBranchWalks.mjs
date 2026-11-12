// (7b LP) The branch walk rules of the checker: `M10:branch_walk`, a warning, for every branch walk the plan meta records
// (`meta.branchWalks`, written by lib/region/links.mjs at realise). The record gives the route and what was planned to stand where;
// every bar is measured from the world's blocks, so the same rule reads the virtual world (the IR v2's) and a realised dump:
//   deck        every deck cell a floor at feet - 1 with 2 passable cells over it (M6 head room)
//   rails       a barrier (M8's 1.5) on every recorded rail cell at the feet
//   hangers     the deck carried at most BRANCH_WALK.span cells apart (the ports' landings carry the ends): each hanger a column of
//               chain from feet + 1 to its top, the cell over its top solid (a leaf, log or rock: its anchor)
//   lamps       a light at most BRANCH_WALK.lampEvery deck cells apart
//   lots (K5)   no recorded cell inside any lot's box (a connector never writes in a lot's restore box; it ends on the cell outside)
// It records per walk the counts as metrics (`metrics.branchWalks.per`). Called by checkRegion (check.mjs), which passes `finding`.
import { BRANCH_WALK } from './links.mjs';

const inBox = (b, x, y, z) => b && x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;

/** The branch walk rules: findings `M10:branch_walk` (and M8, M6) and `metrics.branchWalks`. */
export function branchWalkRules({ ir, vw, branchWalks, want, findings, metrics, finding }) {
  const P = vw.pal, out = [];
  const push = (rule, m, count, sample, message) => { if (want.has(rule.replace(/:.*$/, ''))) findings.push(finding(rule, m.part ?? null, m.stage ?? null, count, sample, message)); };
  const boxes = (ir?.lots ?? []).map((l) => ({ id: l.id, b: l.box && !Array.isArray(l.box) ? l.box : null })).filter((q) => q.b);
  for (const m of branchWalks) {
    const fy = m.feetY, id = m.id;
    const row = { walk: id, part: m.part, cells: m.path.length, deck: 0, headroom: 0, railed: 0, rails: m.rails.length, hangers: m.hangers.length, maxSpan: 0, anchored: 0, lamps: m.lamps.length, maxLampGap: 0, inLots: 0 };
    const noDeck = [], low = [], noRail = [], loose = [], inLot = [];
    m.path.forEach(([x, , z]) => {
      if (P.floor[vw.get(x, fy - 1, z)]) row.deck++; else noDeck.push([x, fy - 1, z]);
      if (P.passable[vw.get(x, fy, z)] && P.passable[vw.get(x, fy + 1, z)]) row.headroom++; else low.push([x, fy, z]);
    });
    for (const [x, y, z] of m.rails) if (P.barrier[vw.get(x, y, z)]) row.railed++; else noRail.push([x, y, z]);
    let last = -1;
    for (const h of [...m.hangers].sort((a, b) => a.i - b.i)) {
      row.maxSpan = Math.max(row.maxSpan, h.i - last); last = h.i;
      const [x, , z] = h.at;
      let ok = true;
      for (let y = fy + 1; y <= h.top; y++) if (P.passable[vw.get(x, y, z)] && vw.get(x, y, z) === vw.base(x, y, z)) { ok = false; break; }
      if (ok && !P.solid[vw.get(x, h.top + 1, z)]) ok = false;
      if (ok) row.anchored++; else loose.push([x, h.top, z]);
    }
    row.maxSpan = Math.max(row.maxSpan, m.path.length - last);
    let lastLamp = -1;
    for (const l of [...m.lamps].sort((a, b) => a.i - b.i)) { row.maxLampGap = Math.max(row.maxLampGap, l.i - lastLamp); lastLamp = l.i; }
    row.maxLampGap = Math.max(row.maxLampGap, m.path.length - 1 - lastLamp);
    const cells = [...m.path.map(([x, , z]) => [x, fy - 1, z]), ...m.rails, ...m.lamps.map((l) => l.at), ...m.hangers.flatMap((h) => Array.from({ length: h.top - fy }, (_, k) => [h.at[0], fy + 1 + k, h.at[2]]))];
    for (const c of cells) for (const q of boxes) if (inBox(q.b, ...c)) { row.inLots++; if (inLot.length < 8) inLot.push([...c, q.id]); }
    if (noDeck.length) push('M10:branch_walk', m, noDeck.length, noDeck.slice(0, 8), `branch walk ${id}: ${noDeck.length} of ${row.cells} deck cell(s) not a floor at y ${fy - 1}`);
    if (low.length) { push('M10:branch_walk', m, low.length, low.slice(0, 8), `branch walk ${id}: ${low.length} of ${row.cells} deck cell(s) without 2 clear over the walk`); push('M6', m, low.length, low.slice(0, 8), `branch walk ${id}: ${low.length} deck cell(s) without 2 clear over the walk`); }
    if (noRail.length) { push('M10:branch_walk', m, noRail.length, noRail.slice(0, 8), `branch walk ${id}: ${noRail.length} of ${row.rails} rail cell(s) without a barrier`); push('M8', m, noRail.length, noRail.slice(0, 8), `branch walk ${id}: ${noRail.length} rail cell(s) without a barrier`); }
    if (row.maxSpan > BRANCH_WALK.span) push('M10:branch_walk', m, 1, [m.from], `branch walk ${id}: ${row.maxSpan} deck cells between hangers (at most ${BRANCH_WALK.span})`);
    if (loose.length) push('M10:branch_walk', m, loose.length, loose.slice(0, 8), `branch walk ${id}: ${loose.length} of ${row.hangers} hanger(s) not a chain up to a solid anchor`);
    if (row.maxLampGap > BRANCH_WALK.lampEvery) push('M10:branch_walk', m, 1, [m.from], `branch walk ${id}: ${row.maxLampGap} deck cells between lights (at most ${BRANCH_WALK.lampEvery})`);
    if (row.inLots) push('M10:branch_walk', m, row.inLots, inLot, `branch walk ${id}: ${row.inLots} cell(s) inside a lot's box (K5: a link ends on the cell outside it)`);
    row.ok = !noDeck.length && !low.length && !noRail.length && row.maxSpan <= BRANCH_WALK.span && !loose.length && row.maxLampGap <= BRANCH_WALK.lampEvery && !row.inLots;
    out.push(row);
  }
  metrics.branchWalks = { walks: out.length, ok: out.filter((r) => r.ok).length, per: out };
}
