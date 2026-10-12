// (6c T2) route_demo's own rows (docs/CONTRACT.md "Phase 6c slice T2" §3): the grade over every walk run (virtual and realised,
// re-surveyed), reachability by the player and the villager mover on the realised world plus vanilla's villager path (dev.nav.villager)
// along every villager edge, no ladder on a villager edge, the keep-out (0 cells written in the protected rect, ARWD diff; the route's
// length against the unconstrained one), hysteresis (one node moved by 4 keeps >= 80% of the other edges' cells), the checker (0
// errors, no M1-M4, M5 under 1% over the routes' walk cells). Offline but for `routeNav` (in game, after the realise).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });
const NAMES = ['gate', 'hall', 'chapel', 'lookout'];

/**
 * In game, after the realise: vanilla's villager path (dev.nav.villager: a no-AI villager, FOLLOW_RANGE over the claim) along every
 * villager edge, both ways, from one end's feet cell to the other's. Writes nav.json.
 */
export async function routeNav(L, meta, ir, out) {
  const range = Math.max(ir.claim.maxX - ir.claim.minX, ir.claim.maxZ - ir.claim.minZ) + 32;
  const edges = {};
  for (const e of meta.route?.edges ?? []) {
    if (!e.ok || !(e.movers ?? []).includes('villager')) continue;
    const a = e.path[0], b = e.path[e.path.length - 1];
    const fa = [a[0], a[1] + 1, a[2]], fb = [b[0], b[1] + 1, b[2]];
    const ab = await L.call('dev.nav.villager', { from: fa, to: fb, range }, 120_000);
    const ba = await L.call('dev.nav.villager', { from: fb, to: fa, range }, 120_000);
    edges[e.id] = { from: fa, to: fb, there: { canReach: !!ab.canReach, nodes: ab.nodes ?? null, end: ab.end ?? null }, back: { canReach: !!ba.canReach, nodes: ba.nodes ?? null, end: ba.end ?? null } };
  }
  const nav = { range, edges };
  fs.writeFileSync(path.join(out, 'nav.json'), `${JSON.stringify(nav, null, 2)}\n`);
  return nav;
}

/** Cells that differ between two ARWD dumps inside the rects [[x0, z0, x1, z1]] (over the dumps' common box). */
export function changedIn(before, after, rects) {
  const bx = before.box;
  let n = 0;
  const sample = [];
  for (const [x0, z0, x1, z1] of rects) {
    for (let x = Math.max(x0, bx.minX); x <= Math.min(x1, bx.maxX); x++) for (let z = Math.max(z0, bx.minZ); z <= Math.min(z1, bx.maxZ); z++) {
      for (let y = bx.minY; y <= bx.maxY; y++) {
        if (before.palette[before.cells[before.at(x, y, z)]] !== after.palette[after.cells[after.at(x, y, z)]]) { n++; if (sample.length < 10) sample.push([x, y, z]); }
      }
    }
  }
  return { cells: n, sample };
}

/**
 * The metrics. `report`: the plan's report.json (virtual), `realised`: the checker on the realised world, `meta`, `nav`, the dumps,
 * `sc` (its `protect` rects), the plan inputs (for the offline re-plans: unconstrained, nodes moved).
 */
export async function routeMetrics({ sc, ir, meta, report, realised, nav, before, after, planDir, flat }) {
  const out = {};
  out.virtual = report?.metrics?.route ?? null;
  out.realised = realised?.metrics?.route ?? null;
  out.M5route = { virtual: report?.metrics?.M5route ?? null, realised: realised?.metrics?.M5route ?? null };
  out.ladderOnVillager = (meta.route?.edges ?? []).filter((e) => e.ok && (e.movers ?? []).includes('villager') && (e.segments ?? []).some((g) => g.kind === 'ladder')).map((e) => e.id);
  out.hairpins = meta.route?.hairpins ?? 0;
  out.nav = nav ? Object.fromEntries(Object.entries(nav.edges).map(([k, v]) => [k, v.there.canReach && v.back.canReach])) : null;
  out.edges = (meta.route?.edges ?? []).map((e) => ({ id: e.id, ok: e.ok, failed: e.failed, movers: e.movers, length: e.length, rise: e.rise, segments: (e.segments ?? []).map((g) => `${g.kind}${g.shared ? '*' : ''}`).join(' '), search: e.search }));
  // keep-out: the protected rects (natural run) against the dumps; the route's length against the same plan without them
  const rects = (!flat && sc.protect?.length) ? sc.protect.map((a) => [a.x0, a.z0, a.x1, a.z1]) : [];
  if (rects.length) {
    out.keepOut = { rects, irKeepOut: ir.keepOut ?? null, ...changedIn(before, after, rects) };
    const { planRegion } = await import('../../kit/lib/region/plan.mjs');
    const survey = fs.readFileSync(path.join(planDir, 'survey.bin'));
    const opts = { programFile: path.join(root, 'kit', 'regions', `${ir.id}.mjs`), params: ir.params, survey, seed: ir.seed, claim: { ...ir.claim }, roles: ir.roles };
    const free = await planRegion(opts);
    const len = (m) => Object.fromEntries((m.route?.edges ?? []).map((e) => [e.id, e.length]));
    out.keepOut.length = len(meta);
    out.keepOut.unconstrained = len(free.meta);
    // hysteresis (item 6): each lot moved by 4 (x), re-planned with the same keep-out: the other edges' cells kept
    const cells = (e) => new Set((e?.path ?? []).map(([x, , z]) => `${x},${z}`));
    out.hysteresis = [];
    for (const n of NAMES) {
      if (ir.params[`${n}X`] === undefined) continue;
      const moved = await planRegion({ ...opts, params: { ...ir.params, [`${n}X`]: ir.params[`${n}X`] + 4 }, keepOut: ir.keepOut ?? [] });
      let kept = 0, total = 0;
      for (const e of meta.route.edges) {
        if (!e.ok || e.from === n || e.to === n) continue;
        const a = cells(e), b = cells(moved.meta.route.edges.find((x) => x.id === e.id));
        total += a.size;
        for (const k of a) if (b.has(k)) kept++;
      }
      out.hysteresis.push({ moved: n, kept, total, share: total ? kept / total : 1 });
    }
  }
  return out;
}

/** route_demo's rows (the 6b safety row is recorded: M8's guards are not a T2 bar; T2's M5 row is the routes' own). */
export function routeBars(m, report, rows, { flat = false, metaFlat = null } = {}) {
  const out = rows.map((r) => (r.id === 'safety' ? { ...r, gated: false, pass: null, label: `${r.label} (recorded: T2 judges M5 over the routes, item 9)` } : r));
  if (flat) out.push(row('t2-flatworld', 'T2 flat variant on a flat world', `route_demo read the survey as ${metaFlat ? 'flat (the hill raised)' : 'NOT flat'}`, 'flat', metaFlat === true));
  const v = m.virtual, r = m.realised;
  const routed = (x) => (x ? `${x.routed}/${x.edges.length} routed` : 'n/a');
  out.push(row('t2-routed', 'T2 Edges routed', `${routed(v)}; ${m.edges.map((e) => `${e.id} ${e.ok ? `${e.length} cells, rise ${e.rise}: ${e.segments}` : e.failed}`).join('; ')}`, 'every edge', v && v.routed === v.edges.length));
  const g = (x) => (x ? `${x.grade.bad} of ${x.grade.windows} windows over (max rise ${x.grade.maxRise})` : 'n/a');
  out.push(row('t2-grade', 'T2 1 Grade, every 8-cell window of every walk run (virtual; realised, re-surveyed)', `${g(v)}; ${g(r)}`, '100% within maxGrade', v && r && v.grade.bad === 0 && r.grade.bad === 0 && r.grade.windows > 0));
  out.push(row('t2-player', 'T2 3 Reachability, player (realised)', r ? `${r.playerReached}/${r.edges.filter((e) => e.ok).length} edges' ends reach each other` : 'n/a', '100%', r && r.playerReached === r.edges.filter((e) => e.ok).length && r.routed > 0));
  const navTxt = m.nav ? `${Object.values(m.nav).filter(Boolean).length}/${Object.keys(m.nav).length} vanilla both ways` : 'n/a (flat run)';
  const navOk = flat || (m.nav && Object.values(m.nav).every(Boolean) && Object.keys(m.nav).length === (r?.villagerEdges ?? -1));
  out.push(row('t2-villager', 'T2 4 Reachability, villager (kit mover realised; vanilla dev.nav.villager); no ladder on a villager edge', r ? `kit ${r.villagerReached}/${r.villagerEdges}; ${navTxt}; ladders on villager edges ${m.ladderOnVillager.length}` : 'n/a',
    'kit 100%, vanilla 100% end to end, 0 ladders', r && r.villagerReached === r.villagerEdges && r.villagerEdges > 0 && navOk && m.ladderOnVillager.length === 0));
  if (m.keepOut) {
    const k = m.keepOut;
    out.push(row('t2-keepout', 'T2 5 Keep-out (ARWD diff in the protected rect; length against the unconstrained route)', `${k.cells} cells written in ${JSON.stringify(k.rects)} (IR keepOut ${JSON.stringify(k.irKeepOut)}); lengths ${Object.entries(k.length).map(([e, n]) => `${e} ${n} vs ${k.unconstrained[e]}`).join(', ')}`,
      '0 cells written in the rect', k.cells === 0 && JSON.stringify(k.irKeepOut) === JSON.stringify(k.rects)));
    const worst = Math.min(...m.hysteresis.map((h) => h.share));
    out.push(row('t2-hysteresis', 'T2 6 Hysteresis (each lot moved by 4: the other edges\' cells kept)', m.hysteresis.map((h) => `${h.moved} ${h.kept}/${h.total}`).join(', '), '>= 80% for every move', m.hysteresis.length > 0 && worst >= 0.8));
  }
  const m14 = (report?.findings ?? []).filter((f) => /^M[1-4]\b/.test(f.rule));
  const m5 = m.M5route.virtual, m5r = m.M5route.realised;
  out.push(row('t2-checker', 'T2 9 Checker (0 errors, no M1-M4, M5 over the routes\' walk cells; hairpins)', `${report?.errors ?? '?'} errors; M1-M4 findings ${m14.length}${m14.length ? ` (${m14.slice(0, 4).map((f) => `${f.rule} ${f.part ?? '-'}: ${f.message.slice(0, 80)}`).join('; ')})` : ''}; M5 routes ${m5 ? `${(100 * m5.share).toFixed(2)}% of ${m5.walkCells}` : 'n/a'} (realised ${m5r ? `${(100 * m5r.share).toFixed(2)}%` : 'n/a'}); hairpins ${m.hairpins}`,
    '0 errors, no M1-M4, M5 < 1%', report?.errors === 0 && m14.length === 0 && m5 && m5.share < 0.01));
  return out;
}
