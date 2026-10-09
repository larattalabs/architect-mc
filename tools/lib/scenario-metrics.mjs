// Scenario metrics (docs/CONTRACT.md 6b §8.3): the bar rows of a run, from the plan's report, the realised report (the
// checker over two ARWD dumps of the claim with the plan's attribution), the palette and organic-read measures, the placed
// entries' kit checks, MSPT, exactness and determinism. Pure functions; tools/scenarios.mjs gathers the inputs.
import { F_WRITTEN } from '../../kit/lib/region/vworld.mjs';

const M14 = /^M[1-4](\b|:)/;

/** Every `minecraft:` block id named anywhere in a JSON value (roles, material rules, form materials). */
export function blockIds(v, out = new Set()) {
  if (typeof v === 'string') { if (v.startsWith('minecraft:')) out.add(v.replace(/\[.*$/, '')); }
  else if (Array.isArray(v)) for (const x of v) blockIds(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) blockIds(x, out);
  return out;
}

/** A block id's family stem: a shape variant (stairs, slab, wall, fence, pane) shares its full block's stem. */
export function stem(id) {
  return id.replace(/^minecraft:/, '').replace(/_(stairs|slab|wall|fence_gate|fence|pane)$/, '').replace(/_(planks|bricks|brick|tiles|tile)$/, '').replace(/s$/, '');
}

/**
 * Palette role adherence (§8.3 "Theme fit: palette"): over the non-air cells the realise wrote outside the lots' boxes, the
 * share whose block is a role block, a shape variant of one, or a form material (a block an op's material rule names).
 * `world` is the realised dump world; `lots` the IR's.
 */
export function paletteAdherence(ir, world) {
  const ruleMats = new Set();
  const formParts = new Set([...(ir.forms ?? []).map((f) => f.part ?? f.id), ...(ir.floating ?? []).flatMap((g) => g.parts)]);
  for (const p of ir.parts ?? []) {
    for (const op of p.ops ?? []) {
      if (op.material?.rule) blockIds(op.material.rule, ruleMats);
      else if (formParts.has(p.id)) blockIds(op.material, ruleMats); // a form's own materials (its generator's roots, rock)
    }
  }
  const allowed = new Set([...blockIds(ir.roles ?? {}), ...ruleMats, ...blockIds(ir.rules ?? {}), ...blockIds(ir.forms ?? [])].map(stem));
  let n = 0, ok = 0;
  const off = new Map();
  world.eachWritten((x, y, z, idx) => {
    if (world.pal.air[idx] || world.lotAt(x, y, z)) return;
    const id = world.pal.states[idx].replace(/\[.*$/, '');
    n++;
    if (allowed.has(stem(id))) ok++;
    else off.set(id, (off.get(id) ?? 0) + 1);
  });
  return { cells: n, adherent: ok, share: n ? ok / n : 1, offPalette: Object.fromEntries([...off].sort((a, b) => b[1] - a[1]).slice(0, 20)) };
}

/**
 * Organic read (§8.3, recorded only in 6b): over the boundary cells of the forms' parts in the virtual world (a written
 * solid cell with a horizontal air neighbour), the share that lie in a straight run of at least `minRun` boundary cells
 * along x or z, all open on the same side.
 */
export function axisRunShare(ir, vw, minRun = 5) {
  const formParts = new Set();
  (ir.forms ?? []).forEach((f) => formParts.add(f.part ?? f.id));
  for (const g of ir.floating ?? []) for (const p of g.parts) formParts.add(p);
  const pIdx = new Set(ir.parts.map((p, i) => (formParts.has(p.id) ? i : -1)).filter((i) => i >= 0));
  const P = vw.pal;
  const open = (x, y, z) => P.air[vw.get(x, y, z)];
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const isB = (x, y, z, s) => {
    const idx = vw.get(x, y, z);
    if (!(vw.flags(x, y, z) & F_WRITTEN) || !P.solid[idx] || !pIdx.has(vw.partAt(x, y, z))) return false;
    return open(x + sides[s][0], y, z + sides[s][1]);
  };
  let boundary = 0, inRun = 0;
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (!pIdx.has(part) || !P.solid[idx]) return;
    let any = false, run = false;
    for (let s = 0; s < 4; s++) {
      if (!open(x + sides[s][0], y, z + sides[s][1])) continue;
      any = true;
      // the run along the face (perpendicular to the open side)
      const ax = sides[s][0] === 0 ? [1, 0] : [0, 1];
      let len = 1;
      for (let k = 1; k < minRun && isB(x + ax[0] * k, y, z + ax[1] * k, s); k++) len++;
      for (let k = 1; k < minRun && isB(x - ax[0] * k, y, z - ax[1] * k, s); k++) len++;
      if (len >= minRun) run = true;
    }
    if (any) { boundary++; if (run) inRun++; }
  });
  return { boundaryCells: boundary, inAxisRuns: inRun, share: boundary ? inRun / boundary : 0, minRun };
}

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });

/**
 * The §8.3 rows. `x` = {plan: {report}, realised: report, palette, organic, buildings: [{entry, errors, metrics, restraint}],
 * mspt, exact: {flat?, normal?, cellsWritten}, determinism: {irShas, workers: {same}, golden}, spendUsd, approval}.
 */
export function bars(x) {
  const out = [];
  const pr = x.plan?.report;
  const m14 = (pr?.findings ?? []).filter((f) => M14.test(f.rule));
  out.push(row('checker', 'Checker', pr ? `${pr.errors} errors; M1-M4 findings ${m14.length}` : 'no report', '0 errors; no M1, M2, M3, M4 findings', pr && pr.errors === 0 && m14.length === 0));
  const R = x.realised?.metrics ?? {};
  const M2 = R.M2;
  const lotUn = (M2?.unreachable ?? []).filter((n) => n.startsWith('lot:'));
  out.push(row('reachability', 'Reachability (M2 player)', M2 ? `${M2.reached}/${M2.nodes} nodes (${(100 * M2.reached / Math.max(1, M2.nodes)).toFixed(1)}%); unreachable lot entrances ${lotUn.length}` : 'n/a',
    '100% of nodes; 0 unreachable lot entrances', M2 && M2.reached === M2.nodes && lotUn.length === 0));
  const M3 = R.M3;
  const spurs = (x.realised?.findings ?? []).filter((f) => f.rule === 'M3:floating_spur').reduce((a, f) => a + f.count, 0);
  const groupsOne = (M3?.groups ?? []).every((g) => g.components === 1);
  out.push(row('structure', 'Structure (M3)', M3 ? `floating cells ${M3.floatingCells}; spurs ${spurs}; groups ${(M3.groups ?? []).map((g) => g.components).join('/')} component(s)` : 'n/a',
    '0 floating cells outside declared groups; 0 M3:floating_spur; every group one component', M3 && M3.floatingCells === 0 && spurs === 0 && groupsOne));
  const M10 = R.M10 ?? [];
  const spanBad = M10.filter((b) => b.longest > b.maxSpan || (b.ends && (b.bearing ?? [0, 0]).some((n) => n < 4)));
  out.push(row('spans', 'Spans (M10)', `${M10.length} bridge(s); ${spanBad.length} over maxSpan or under-bearing${M10.length ? `; longest ${Math.max(...M10.map((b) => b.longest))}` : ''}`,
    "every unsupported span <= maxSpan; 'ends' bridges bear on >= 2x2 at both ends", spanBad.length === 0));
  const M4 = R.M4?.breaches ?? null, M5 = R.M5, M8 = R.M8;
  out.push(row('safety', 'Safety (M4, M5, M8)', `M4 ${M4}; M5 ${M5 ? (100 * M5.share).toFixed(2) : '?'}% dark spawnable; M8 ${M8 ? (100 * M8.share).toFixed(1) : '?'}% guarded (${M8?.unguarded ?? '?'} open of ${M8?.edgeCells ?? '?'})`,
    'M4 0; M5 < 1% of walk area; M8 100%', M4 === 0 && M5 && M5.share < 0.01 && M8 && M8.unguarded === 0));
  out.push(row('palette', 'Theme fit: palette', x.palette ? `${x.palette.share.toFixed(3)} (${x.palette.adherent}/${x.palette.cells})` : 'n/a', '>= 0.9', x.palette && x.palette.share >= 0.9));
  out.push(row('organic', 'Theme fit: organic read', x.organic ? `axis-run share ${x.organic.share.toFixed(3)} of ${x.organic.boundaryCells} boundary cells` : 'n/a', 'recorded (calibrated on held-out seeds for 6c)', null, false));
  const bErr = (x.buildings ?? []).reduce((a, b) => a + b.errors, 0);
  const bRes = (x.buildings ?? []).flatMap((b) => b.restraint ?? []);
  out.push(row('buildings', 'Buildings', `${(x.buildings ?? []).length} entr${(x.buildings ?? []).length === 1 ? 'y' : 'ies'}; ${bErr} errors; restraint warnings ${bRes.length}; ${(x.buildings ?? []).map((b) => `${b.entry} noise ${b.metrics?.detailNoise} accent ${b.metrics?.accentShare}`).join(', ')}`,
    "0 errors; detailNoise and accentShare within the bible's restraint", (x.buildings ?? []).length > 0 && bErr === 0 && bRes.length === 0));
  const ms = x.mspt?.all;
  out.push(row('mspt', 'MSPT and throughput', ms ? `max ${ms.max.toFixed(1)} ms, p99 ${ms.p99.toFixed(1)} ms, ${ms.over50} over 50 ms${x.mspt.lightShare != null ? `; light share ${(100 * x.mspt.lightShare).toFixed(1)}%` : ''}${x.cellsPerSecond ? `; ${Math.round(x.cellsPerSecond)} cells/s` : ''}` : 'n/a',
    '0 ticks over 50 ms; p99 <= 25 ms', ms && ms.over50 === 0 && ms.p99 <= 25));
  const ef = x.exact?.flat, en = x.exact?.normal;
  const cap = 0.0001 * (x.exact?.cellsWritten ?? 0);
  // E-normal (6a's rule): every mismatch classified; the world's own doing during the stand (growth, live blocks, gravity,
  // unsupported plants) is classified and not the undo's; what remains is held to 0.01% of the written cells
  const WORLD = ['growth', 'live', 'gravity', 'unsupported'];
  const undoOwn = en ? en.mismatches - WORLD.reduce((a, k) => a + (en.classes?.[k] ?? 0), 0) : null;
  out.push(row('exactness', 'Exactness', `E-flat ${ef ? ef.mismatches : 'n/a'}; E-normal ${en ? `${en.mismatches} (${JSON.stringify(en.classes ?? {})}; unclassified ${en.classes?.none ?? 0}; the undo's own ${undoOwn}, cap ${cap.toFixed(0)})` : 'n/a'}`,
    'E-flat 0; E-normal all classified, <= 0.01% of written cells', ef && en && ef.mismatches === 0 && (en.classes?.none ?? 0) === 0 && undoOwn <= cap));
  const d = x.determinism;
  out.push(row('determinism', 'Determinism', d ? `IR sha ${d.irShas.length} plans ${new Set(d.irShas).size === 1 ? 'identical' : 'DIFFER'}; tiles 1 vs 4 workers ${d.workersSame ? 'identical' : 'DIFFER'}; golden ${d.golden}` : 'n/a',
    'identical; committed golden scenarios/goldens/s1.json', d && new Set(d.irShas).size === 1 && d.workersSame && d.golden === 'match'));
  out.push(row('spend', 'Spend', `$${(x.spendUsd ?? 0).toFixed(2)}`, '$0.00 (S1 is a $0 run)', (x.spendUsd ?? 0) === 0));
  out.push(row('gallery', 'Gallery', x.approval ?? 'pending', "Noah's approval for this run's evidence.sha", x.approval === 'approved'));
  return out;
}
