// (6c D3, docs/CONTRACT.md "Phase 6c slice D3" §5.3) The beside rules of a districts plan with a reach into a standing town's claim:
//   M28:beside   an error for any write outside the district's claim that is not a reach cell of `route_join`; a reach cell that is held
//                (outside the contact columns the town's terrain alone holds); a contact column the town's terrain holds that is not in
//                the IR's `reach.hold`; a reach cell in the town's footprint (lots + 1, roads + 1, paths, ways) or a town body's hard or
//                watch columns
//   M25:clear    a write into a town body's hard or watch columns (the town's bodies judged as the plan's own: {body: <town>:<id>})
// The standing data comes from ctx.besideReach (the check's `besideReach`). Pure.
import { keyRuns, runKeys } from './beside.mjs';
import { reachClasses } from './reach.mjs';
import { mergedClasses } from './gateJoin.mjs';

const k2 = (x, z) => `${x},${z}`;

/**
 * The beside rules over a built virtual world `vw` of `ir`: pushes findings (M28:beside, M25:clear) and returns the metrics
 * {outside, reachCells, held, footprint, bodies, unheld, wrongWriter}.
 */
export function besideRules({ ir, vw, besideReach, around = [], findings, finding, partStage = new Map(), light = null }) {
  const c = ir.claim;
  const inClaim = (x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
  const reach = runKeys(ir.reach?.runs ?? []);
  const hold = runKeys(ir.reach?.hold ?? []);
  // ((6c D3, ruling B) the join's lamps on reach columns: written by the lamps' part)
  const lampCols = runKeys(ir.reach?.lamps ?? []);
  // ((7a GJ, §4) a gate join's: the town's classes and the wall regions' round it)
  const K = besideReach ? mergedClasses(reachClasses(besideReach), around) : null;
  // ((7a GJ, §3) the gate a join crosses: none of its cells is written (the traverse is the wall's)
  const gateCols = runKeys(ir.reach?.gate?.cells ?? []);
  const town = besideReach?.standing?.id ?? ir.reach?.standing ?? ir.beside?.id ?? '?';
  // the written cells outside the claim, per column, with their writer parts
  const outside = new Map();
  vw.eachWritten((x, y, z, idx, flags, part) => {
    if (inClaim(x, z)) return;
    const k = k2(x, z);
    let o = outside.get(k);
    if (!o) { o = { x, z, y, parts: new Set() }; outside.set(k, o); }
    o.parts.add(part >= 0 ? ir.parts[part]?.id ?? null : null);
  });
  const m = { outside: outside.size, reachCells: reach.size, wrongWriter: 0, notReach: 0, held: 0, footprint: 0, bodies: 0, unheld: 0, ...(ir.reach?.gate ? { gate: 0 } : {}) };
  const bad = { writer: [], notReach: [], held: [], footprint: [], body: [], unheld: [], gate: [] };
  if (gateCols.size) vw.eachWritten((x, y, z) => { if (gateCols.has(k2(x, z))) { m.gate++; bad.gate.push([x, y, z]); } });
  for (const [k, o] of outside) {
    if (!reach.has(k)) { m.notReach++; bad.notReach.push([o.x, o.y, o.z]); continue; }
    if ([...o.parts].some((p) => p !== 'route_join' && !(lampCols.has(k) && /^props(_|$)/.test(String(p))))) { m.wrongWriter++; bad.writer.push([o.x, o.y, o.z]); }
  }
  if (K) {
    for (const k of reach) {
      const [x, z] = k.split(',').map(Number);
      const y = outside.get(k)?.y ?? 0;
      if (K.held.has(k) && !(K.terrain.has(k) && hold.has(k))) { m.held++; bad.held.push([x, y, z]); }
      if (K.lot.has(k) || K.keep.has(k)) { m.footprint++; bad.footprint.push([x, y, z]); }
      if (K.body.has(k)) { m.bodies++; bad.body.push([x, y, z]); }
    }
    // a contact column the town's terrain holds: every one must be held (reach.hold)
    for (const k of runKeys(ir.reach?.contact ?? [])) if (K.terrain.has(k) && !hold.has(k)) { const [x, z] = k.split(',').map(Number); m.unheld++; bad.unheld.push([x, 0, z]); }
    // the reach's columns this plan holds or writes in the town: never a column held but not the town's terrain's alone
    for (const k of hold) if (!K.terrain.has(k)) { const [x, z] = k.split(',').map(Number); m.held++; bad.held.push([x, 0, z]); }
  }
  const stage = partStage.get('route_join') ?? null;
  if (bad.gate.length) findings.push(finding('M28:beside', 'route_join', stage, bad.gate.length, bad.gate, `${bad.gate.length} cell(s) written in gate ${ir.reach.gate.region}:${ir.reach.gate.id}'s columns (a join crosses a gate, never writes it)`));
  if (bad.notReach.length) findings.push(finding('M28:beside', null, null, bad.notReach.length, bad.notReach, `${bad.notReach.length} column(s) written outside the district's claim are not reach cells (only the join's reach may write there)`));
  if (bad.writer.length) findings.push(finding('M28:beside', null, null, bad.writer.length, bad.writer, `${bad.writer.length} reach column(s) are written by a part other than route_join (only the join and its lamps write outside the claim)`));
  if (bad.held.length) findings.push(finding('M28:beside', 'route_join', stage, bad.held.length, bad.held, `${bad.held.length} reach column(s) are held (by region ${town} or another site) outside the contact columns its terrain alone holds`));
  if (bad.footprint.length) findings.push(finding('M28:beside', 'route_join', stage, bad.footprint.length, bad.footprint, `${bad.footprint.length} reach column(s) lie in region ${town}'s footprint (its lots + 1, roads + 1, paths, ways)`));
  if (bad.body.length) findings.push(finding('M28:beside', 'route_join', stage, bad.body.length, bad.body, `${bad.body.length} reach column(s) lie in a body of region ${town} (its hard or watch columns)`));
  if (bad.unheld.length) findings.push(finding('M28:beside', 'route_join', stage, bad.unheld.length, bad.unheld, `${bad.unheld.length} contact column(s) region ${town}'s terrain holds are not hold-written (reach.hold)`));
  // M25:clear, the town's bodies as the plan's own: a write into one's hard or watch columns
  if (besideReach) {
    for (const b of besideReach.standing?.bodies?.list ?? []) {
      const cols = runKeys([...(b.hard ?? []), ...(b.watch ?? [])]);
      const hit = [];
      vw.eachWritten((x, y, z, idx, flags, part) => { if (cols.has(k2(x, z))) hit.push([x, y, z]); });
      if (hit.length) { m.bodies += hit.length; findings.push(finding('M25:clear', 'route_join', null, hit.length, hit, `body ${town}:${b.id}: ${hit.length} cell(s) written in its hard or watch columns ({body: ${town}:${b.id}})`)); }
    }
  }
  // M5 over the join's walk cells in the town's claim (ruling B: the dark-walk bar holds over the whole join): each reach column's top
  // route_join cell is its floor; dark when no block light reaches the feet (the plan's lamps, and the town's own lights within their
  // light's Manhattan reach: besideReach.standing.lights) and the floor is spawnable
  if (light) {
    const L = light();
    const P = vw.pal;
    const top = new Map();
    vw.eachWritten((x, y, z, idx, flags, part) => {
      if (inClaim(x, z) || ir.parts[part]?.id !== 'route_join') return;
      const k = k2(x, z), t = top.get(k);
      if (t === undefined || y > t) top.set(k, y);
    });
    const town = besideReach?.standing?.lights ?? [];
    let dark = 0, cells = 0;
    const sample = [];
    for (const [k, y] of top) {
      const [x, z] = k.split(',').map(Number);
      if (!P.spawn[vw.get(x, y, z)] || !P.passable[vw.get(x, y + 1, z)]) continue;
      cells++;
      if (L.at(x, y + 1, z) > 0) continue;
      if (town.some(([lx, ly, lz, lv]) => Math.abs(lx - x) + Math.abs(ly - y - 1) + Math.abs(lz - z) < lv)) continue;
      dark++;
      if (sample.length < 20) sample.push([x, y + 1, z]);
    }
    m.M5reach = { walkCells: cells, darkSpawnable: dark, share: cells ? dark / cells : 0 };
    if (dark) findings.push(finding('M5', 'route_join', stage, dark, sample, `${dark} of ${cells} walk cell(s) of the join in region ${besideReach?.standing?.id ?? ir.reach?.standing ?? '?'}'s claim are dark (block light 0) and spawnable`));
  }
  m.reachRuns = keyRuns(reach).length;
  return m;
}
