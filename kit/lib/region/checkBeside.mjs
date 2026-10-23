// (6c D3, docs/CONTRACT.md "Phase 6c slice D3" §5.3) The beside rules of a districts plan with a reach into a standing town's claim:
//   M28:beside   an error for any write outside the district's claim that is not a reach cell of `route_join`; a reach cell that is held
//                (outside the contact columns the town's terrain alone holds); a contact column the town's terrain holds that is not in
//                the IR's `reach.hold`; a reach cell in the town's footprint (lots + 1, roads + 1, paths, ways) or a town body's hard or
//                watch columns
//   M25:clear    a write into a town body's hard or watch columns (the town's bodies judged as the plan's own: {body: <town>:<id>})
// The standing data comes from ctx.besideReach (the check's `besideReach`). Pure.
import { keyRuns, runKeys } from './beside.mjs';
import { reachClasses } from './reach.mjs';

const k2 = (x, z) => `${x},${z}`;

/**
 * The beside rules over a built virtual world `vw` of `ir`: pushes findings (M28:beside, M25:clear) and returns the metrics
 * {outside, reachCells, held, footprint, bodies, unheld, wrongWriter}.
 */
export function besideRules({ ir, vw, besideReach, findings, finding, partStage = new Map() }) {
  const c = ir.claim;
  const inClaim = (x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
  const reach = runKeys(ir.reach?.runs ?? []);
  const hold = runKeys(ir.reach?.hold ?? []);
  const K = besideReach ? reachClasses(besideReach) : null;
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
  const m = { outside: outside.size, reachCells: reach.size, wrongWriter: 0, notReach: 0, held: 0, footprint: 0, bodies: 0, unheld: 0 };
  const bad = { writer: [], notReach: [], held: [], footprint: [], body: [], unheld: [] };
  for (const [k, o] of outside) {
    if (!reach.has(k)) { m.notReach++; bad.notReach.push([o.x, o.y, o.z]); continue; }
    if ([...o.parts].some((p) => p !== 'route_join')) { m.wrongWriter++; bad.writer.push([o.x, o.y, o.z]); }
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
  m.reachRuns = keyRuns(reach).length;
  return m;
}
