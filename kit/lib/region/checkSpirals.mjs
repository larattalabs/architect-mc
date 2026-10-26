// (7a SA) The spiral rules of the checker (docs/CONTRACT.md "Phase 7a slice SA" §5): `M10:spiral`, a warning, for every spiral the plan
// meta records (`meta.spirals`, written by lib/connectors/spiral.mjs). The record gives only where the spiral walks (its lane 1 in order
// from the foot, its outer lane, the deck, the host's form); every bar is measured from the world's blocks, so the same rule reads the
// virtual world (plan time) and a realised dump world (the gate):
//   steps      each walk cell is face-adjacent to the one before it (horizontally) and rises 1 (a tread) or 0 (a flat, a landing)
//   standing   every walk cell (both lanes, the deck) is a block one can stand on with 2 passable cells over it (head room 2)
//   attached   every walk cell has a solid face beside or under it (the host, the tread below it, its support): M3 through the chain
//   outer edge the outermost lane at most 2 (width 1) or 3 (width 2) from the host or the lookout's own corbel and deck, at its level or
//              up to 10 over it (an overhang the walk steps out round), wherever a side of it stands over a drop of more than 3
//   rails      a barrier at y + 1 beside every walk cell (the deck's too) whose neighbour is open at y and y + 1 over a drop of more than 3
//              (M8)
//   lit        no dark (block light 0) spawnable walk cell (M5)
// Per spiral `metrics.spirals.per`. Called by checkRegion (check.mjs); leaves `vw` as it found it.
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The spiral rules: findings `M10:spiral` (and M8, M6, M5) and `metrics.spirals`. `light`: blockLight(vw) (lazy). */
export function spiralRules({ ir, vw, spirals, want, findings, metrics, finding, light }) {
  const P = vw.pal, per = [];
  const push = (rule, m, count, sample, message) => { if (want.has(rule.replace(/:.*$/, ''))) findings.push(finding(rule, m.part ?? null, m.stage ?? null, count, sample, message)); };
  const dropBelow = (x, y, z) => { for (let d = 1; d <= 4; d++) { const s = vw.get(x, y - d, z); if (!P.passable[s] || P.water[s]) return d - 1; } return 99; };
  const firm = (s) => P.solid[s] && !P.fluid[s];
  let L = null;
  for (const m of spirals) {
    const hostPi = ir?.parts ? ir.parts.findIndex((q) => q.id === m.form) : -1;
    const walk = m.walk ?? [], outer = m.outer ?? [], deck = m.deck ?? [];
    const all = [...walk, ...outer, ...deck.map(([x, y, z]) => [x, y, z, 'deck'])];
    const own = new Set(all.map(([x, y, z]) => `${x},${y},${z}`));
    const row = { id: m.id, part: m.part, cells: all.length, steps: 0, stepBad: 0, standing: 0, headroom: 0, attached: 0, outerMax: 0, edges: 0, railed: 0, dark: 0 };
    const badStep = [], low = [], loose = [], wide = [], open = [], darkS = [];
    // ---- steps: from the foot, each lane-1 cell beside the one before, rising 1 (tread) or 0 (flat, ground)
    let prev = m.foot ?? null;
    for (const [x, y, z, kind] of walk) {
      row.steps++;
      if (prev) {
        const adj = Math.abs(x - prev[0]) + Math.abs(z - prev[2]) === 1;
        const dy = y - prev[1];
        if (!adj || (kind === 'tread' ? dy !== 1 : dy !== 0)) { row.stepBad++; badStep.push([x, y, z]); }
      }
      prev = [x, y, z];
    }
    // ---- standing, head room, attached
    for (const [x, y, z] of all) {
      const b = vw.get(x, y, z);
      const stand = !P.passable[b] || P.floor[b] || P.stairs[b] || P.half[b];
      if (stand) row.standing++; else low.push([x, y, z]);
      if (P.passable[vw.get(x, y + 1, z)] && P.passable[vw.get(x, y + 2, z)]) row.headroom++; else low.push([x, y + 1, z]);
      const att = firm(vw.get(x, y - 1, z)) || DIRS4.some(([dx, dz]) => firm(vw.get(x + dx, y, z + dz)));
      if (att) row.attached++; else loose.push([x, y, z]);
    }
    // ---- the outer edge: the outermost lane's distance to the host (or the lookout's corbel and deck)
    const hostAt = (x, y, z) => (hostPi >= 0 && vw.partAt(x, y, z) === hostPi && P.solid[vw.get(x, y, z)]) || (m.corbel ?? []).some((q) => q[0] === x && q[1] === y && q[2] === z) || (y === m.topY && deck.some((q) => q[0] === x && q[2] === z));
    const outermost = outer.length ? outer : walk;
    const bar = (m.width ?? 1) >= 2 ? 3 : 2;
    for (const [x, y, z] of outermost) {
      // (near the ground, no side over a drop of more than 3, the edge's distance does not matter: a root, a cluster's hull)
      if (!DIRS4.some(([dx, dz]) => P.passable[vw.get(x + dx, y, z + dz)] && dropBelow(x + dx, y + 1, z + dz) > 3)) continue;
      let d = 99;
      for (let r = 1; r <= 4 && d === 99; r++) {
        for (let i = -r; i <= r && d === 99; i++) for (let j = -r; j <= r && d === 99; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          for (let t = -1; t <= 10; t++) if (hostAt(x + i, y + t, z + j)) { d = r; break; }
        }
      }
      if (d > row.outerMax) row.outerMax = d;
      if (d > bar) wide.push([x, y, z]);
    }
    // ---- rails: an open neighbour over a drop of more than 3 needs a barrier at y + 1
    for (const [x, y, z] of all) for (const [dx, dz] of DIRS4) {
      const nx = x + dx, nz = z + dz;
      if (own.has(`${nx},${y},${nz}`) || own.has(`${nx},${y + 1},${nz}`) || own.has(`${nx},${y - 1},${nz}`)) continue;
      // (a bed with a barrier on it over the drop: a railed edge)
      if (!P.passable[vw.get(nx, y, nz)]) { if (P.barrier[vw.get(nx, y + 1, nz)] && dropBelow(nx, y, nz) > 3) { row.edges++; row.railed++; } continue; }
      if (dropBelow(nx, y + 1, nz) <= 3) continue;
      row.edges++;
      if (P.barrier[vw.get(nx, y + 1, nz)]) row.railed++;
      else if (P.passable[vw.get(nx, y + 1, nz)]) open.push([nx, y + 1, nz]);
      else row.railed++;
    }
    // ---- lit: no dark spawnable walk cell
    for (const [x, y, z] of all) {
      if (!P.spawn[vw.get(x, y, z)] || !P.passable[vw.get(x, y + 1, z)]) continue;
      L ??= light();
      if (!(L.at(x, y + 1, z) > 0)) { row.dark++; darkS.push([x, y + 1, z]); }
    }
    if (badStep.length) push('M10:spiral', m, badStep.length, badStep.slice(0, 8), `spiral ${m.id}: ${badStep.length} of ${row.steps} step(s) not beside the one before, or not rising 1 (a tread) or 0 (a flat)`);
    if (row.standing < all.length || row.headroom < all.length) {
      push('M10:spiral', m, low.length, low.slice(0, 8), `spiral ${m.id}: ${all.length - row.standing} walk cell(s) not standable, ${all.length - row.headroom} without 2 clear over them`);
      if (row.headroom < all.length) push('M6', m, all.length - row.headroom, low.slice(0, 8), `spiral ${m.id}: ${all.length - row.headroom} walk cell(s) without 2 clear over them`);
    }
    if (loose.length) push('M10:spiral', m, loose.length, loose.slice(0, 8), `spiral ${m.id}: ${loose.length} walk cell(s) with no solid face beside or under them (floating)`);
    if (wide.length) push('M10:spiral', m, wide.length, wide.slice(0, 8), `spiral ${m.id}: the outer edge stands ${row.outerMax} from the host (at most ${bar}) at ${wide.length} cell(s)`);
    if (open.length) {
      push('M10:spiral', m, open.length, open.slice(0, 8), `spiral ${m.id}: ${open.length} open edge(s) over a drop of more than 3 without a rail`);
      push('M8', m, open.length, open.slice(0, 8), `spiral ${m.id}: ${open.length} open edge(s) over a drop of more than 3 without a rail`);
    }
    if (darkS.length) {
      push('M10:spiral', m, darkS.length, darkS.slice(0, 8), `spiral ${m.id}: ${darkS.length} dark (block light 0) spawnable walk cell(s)`);
      push('M5', m, darkS.length, darkS.slice(0, 8), `spiral ${m.id}: ${darkS.length} dark (block light 0) spawnable walk cell(s)`);
    }
    row.ok = !badStep.length && row.standing === all.length && row.headroom === all.length && !loose.length && !wide.length && !open.length && !darkS.length;
    per.push(row);
  }
  metrics.spirals = { spirals: per.length, ok: per.filter((r) => r.ok).length, per };
}
