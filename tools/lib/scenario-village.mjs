// Scenario S7's flat-village bars (docs/CONTRACT.md "Phase 6c slice V" §7, bars 1-14) on the realised world: the door-to-street
// walk (bar 4), the lot fronts (bar 5), the props (bar 7), plus the rows the 6b metrics already have, in S7's order. Pure functions;
// tools/scenarios.mjs gathers the inputs (two ARWD dumps, the plan's IR and meta, the realised report, nav.json).
import { stem } from './scenario-metrics.mjs';

const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const VILLAGER_LOTS = ['dwelling', 'job', 'trading_hall', 'farm'];
const key = (x, z) => `${x},${z}`;

/** The street and square walk columns: the shared space's rect, the verges and the road items' cross-sections (meta, IR). */
export function streetColumns(ir, meta) {
  const v = meta.village;
  const out = new Set();
  const [x0, z0, x1, z1] = v.shared.rect;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.add(key(x, z));
  for (const r of ir.roads ?? []) {
    const [a, b] = [r.points[0], r.points[r.points.length - 1]];
    const half = Math.floor((r.width + 2) / 2); // the road and its verges (street 5)
    const ns = a[0] === b[0];
    for (let x = Math.min(a[0], b[0]) - (ns ? half : 0); x <= Math.max(a[0], b[0]) + (ns ? half : 0); x++) {
      for (let z = Math.min(a[2], b[2]) - (ns ? 0 : half); z <= Math.max(a[2], b[2]) + (ns ? 0 : half); z++) out.add(key(x, z));
    }
  }
  return out;
}

/**
 * Bar 4 (door to street): for every placed lot, a walk from its door cell (the placed site's entrance anchor) to a street or
 * square walk column, over cells whose floor block is a role block, one of its shape variants, or the street surface (the road's
 * surface is the `path` role). 4-connected, steps of at most 1, feet and head passable. Returns per lot {ok, steps, path}.
 */
export function doorToStreet(ir, meta, world, nav) {
  const P = world.pal;
  const roles = new Set(Object.values(ir.roles ?? {}).map((s) => stem(s.replace(/\[.*$/, ''))));
  for (const r of ir.roads ?? []) if (r.surface) roles.add(stem(r.surface.replace(/\[.*$/, '')));
  const street = streetColumns(ir, meta);
  const floorOk = (x, y, z) => {
    const s = P.states[world.get(x, y - 1, z)];
    return P.floor[world.get(x, y - 1, z)] && roles.has(stem(s.replace(/\[.*$/, '')));
  };
  const stand = (x, y, z) => P.passable[world.get(x, y, z)] && P.passable[world.get(x, y + 1, z)];
  const out = {};
  for (const [id, l] of Object.entries(nav.lots ?? {})) {
    if (!l.door) { out[id] = { ok: false, why: l.siteId ? 'no entrance anchor' : `not placed (${l.state})` }; continue; }
    const [dx, dy, dz] = l.door;
    const seen = new Set([`${dx},${dy},${dz}`]);
    const q = [[dx, dy, dz, 0, null]];
    let found = null;
    const prev = new Map();
    for (let h = 0; h < q.length && !found; h++) {
      const [x, y, z, d] = q[h];
      if (street.has(key(x, z)) && (h > 0 || floorOk(x, y, z))) { found = [x, y, z, d]; break; }
      if (d > 64) continue;
      for (const [ax, az] of DIRS4) for (const ay of [0, 1, -1]) {
        const nx = x + ax, ny = y + ay, nz = z + az;
        const k = `${nx},${ny},${nz}`;
        if (seen.has(k) || !stand(nx, ny, nz) || !floorOk(nx, ny, nz)) continue;
        if (ay === 1 && !P.passable[world.get(x, y + 2, z)]) continue;
        seen.add(k); prev.set(k, `${x},${y},${z}`);
        q.push([nx, ny, nz, d + 1]);
      }
    }
    const path = [];
    if (found) { let k = `${found[0]},${found[1]},${found[2]}`; while (k) { path.push(k.split(',').map(Number)); k = prev.get(k); } path.reverse(); }
    out[id] = found ? { ok: true, steps: found[3], door: l.door, path } : { ok: false, door: l.door, why: 'no walk over role blocks to the street' };
  }
  return out;
}

/**
 * Bar 5 (lot fronts): written `minecraft:dirt_path` or `minecraft:cobblestone` cells (different from the before dump) in each lot's
 * front zone: its front edge row +-1 (the apron) across the box's width + 2, plus its lane cells and the approach cells (bar 4's
 * path), from floorY - 2 to floorY + 1. Natural cobble is excluded by the before/after difference.
 */
export function villageFronts(ir, meta, before, after, door) {
  const bad = new Set(['minecraft:dirt_path', 'minecraft:cobblestone']);
  const out = { cells: 0, perLot: {}, sample: [] };
  const inBox = (d, x, y, z) => x >= d.box.minX && x <= d.box.maxX && y >= d.box.minY && y <= d.box.maxY && z >= d.box.minZ && z <= d.box.maxZ;
  const id = (d, x, y, z) => d.palette[d.cells[d.at(x, y, z)]].replace(/\[.*$/, '');
  for (const l of ir.lots ?? []) {
    const b = l.box, zone = new Set();
    const f = l.front;
    const rows = { north: [b.minZ - 1, b.minZ, b.minZ + 1], south: [b.maxZ + 1, b.maxZ, b.maxZ - 1], west: [b.minX - 1, b.minX, b.minX + 1], east: [b.maxX + 1, b.maxX, b.maxX - 1] }[f];
    if (f === 'north' || f === 'south') { for (const z of rows) for (let x = b.minX - 1; x <= b.maxX + 1; x++) zone.add(key(x, z)); } else { for (const x of rows) for (let z = b.minZ - 1; z <= b.maxZ + 1; z++) zone.add(key(x, z)); }
    for (const [x, , z] of meta.village?.lanes?.[l.id] ?? []) zone.add(key(x, z));
    for (const [x, , z] of door?.[l.id]?.path ?? []) zone.add(key(x, z));
    let n = 0;
    for (const k of zone) {
      const [x, z] = k.split(',').map(Number);
      for (let y = l.floorY - 2; y <= l.floorY + 1; y++) {
        if (!inBox(after, x, y, z) || !inBox(before, x, y, z)) continue;
        const a = id(after, x, y, z);
        if (!bad.has(a) || a === id(before, x, y, z)) continue;
        n++;
        if (out.sample.length < 20) out.sample.push([x, y, z, a]);
      }
    }
    out.perLot[l.id] = n;
    out.cells += n;
  }
  return out;
}

/**
 * Bar 7 (props): per kind, the props whose every planned cell holds its planned state in the realised world (realised counts
 * equal the plan's); every prop part free of M3 findings in the realised report; 0 prop cells in a lot box, on a walk cell (the
 * plan's virtual world), in the bell area or the golem space.
 */
export function villageProps(ir, meta, world, realised, vw) {
  const v = meta.village;
  const planned = {}, built = {};
  const misplaced = [];
  const area = new Set(v.bellArea.map(([x, z]) => key(x, z))), golem = new Set(v.golem.map(([x, z]) => key(x, z)));
  for (const p of v.props ?? []) {
    planned[p.kind] = (planned[p.kind] ?? 0) + 1;
    // the block, not its connection properties (a fence's sides, a waterlogged flag): the world fills those in
    const blk = (s) => s.replace(/\[.*$/, '');
    const ok = p.cells.every(([x, y, z, s]) => blk(world.pal.states[world.get(x, y, z)]) === blk(s));
    if (ok) built[p.kind] = (built[p.kind] ?? 0) + 1;
    for (const [x, y, z] of p.cells) {
      const inLot = (ir.lots ?? []).some((l) => x >= l.box.minX && x <= l.box.maxX && z >= l.box.minZ && z <= l.box.maxZ);
      const onWalk = vw && (vw.flags(x, v.shared.y, z) & 2) !== 0;
      if (inLot || onWalk || area.has(key(x, z)) || golem.has(key(x, z))) misplaced.push([x, y, z, p.id]);
    }
  }
  const m3 = (realised.findings ?? []).filter((f) => f.rule.startsWith('M3') && /^props_/.test(f.part ?? ''));
  return { planned, built, equal: JSON.stringify(Object.entries(planned).sort()) === JSON.stringify(Object.entries(built).sort()), unsupported: m3.reduce((a, f) => a + f.count, 0), misplaced };
}

/**
 * Bar 8's walk area for a village: the village's walk cells (the street, its verges, the lanes and the square, walk-flagged in
 * the plan's virtual world, roads included), standing on the realised block, block light 0 and spawnable = dark. The checker's
 * M5 counts every reached floor the region wrote, so the lot pads' aprons and batters too (recorded beside it).
 */
export function walkDark(world, vw) {
  const P = world.pal;
  let n = 0, dark = 0;
  const sample = [];
  const seen = new Set();
  vw.eachWritten((x, y, z, idx, f) => {
    if (!(f & 2)) return;
    const k = `${x},${z}`;
    if (seen.has(k)) return;
    seen.add(k);
    const fl = world.get(x, y, z), a = world.get(x, y + 1, z), b = world.get(x, y + 2, z);
    if (!P.passable[a] || !P.passable[b]) return; // a prop or a post stands on it: not a walk cell now
    n++;
    if (P.spawn[fl] && world.lightAt && world.lightAt(x, y + 1, z) === 0) { dark++; if (sample.length < 20) sample.push([x, y + 1, z]); }
  });
  return { walkCells: n, dark, share: n ? dark / n : 0, sample, light: !!world.lightAt };
}

const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });

/** S7's bar rows (CONTRACT V §7's table, 1-14), from the gathered inputs and 6b's rows (`base`: palette, mspt, exactness, ...). */
export function villageBars(x, base) {
  const out = [];
  const by = Object.fromEntries(base.map((r) => [r.id, r]));
  const pr = x.plan?.report;
  const bad1 = (pr?.findings ?? []).filter((f) => /^M[1-4](\b|:)/.test(f.rule) || /^M2:villager/.test(f.rule) || /^M2[2-4]$/.test(f.rule));
  out.push(row('checker', '1 Plan report', pr ? `${pr.errors} errors; M1-M4, M2:villager, M22-M24 findings ${bad1.length}${bad1.length ? ` (${bad1.map((f) => f.rule).join(', ')})` : ''}` : 'no report',
    '0 errors; no M1-M4; M2:villager and M22-M24 clean', pr && pr.errors === 0 && bad1.length === 0));
  const R = x.realised?.metrics ?? {};
  const M2 = R.M2;
  const lotUn = (M2?.unreachable ?? []).filter((n) => n.startsWith('lot:'));
  out.push(row('reachability', '2 Reachability, player', M2 ? `${M2.reached}/${M2.nodes} nodes; unreachable lot entrances ${lotUn.length}` : 'n/a', '100% of nodes; 0 unreachable lot entrances', M2 && M2.reached === M2.nodes && lotUn.length === 0));
  const MV = R.M2villager;
  out.push(row('villager', '3 Reachability, villager (kit)', MV ? `${MV.reached}/${MV.lots} villager lots reach the bell${MV.unreachable.length ? ` (not: ${MV.unreachable.join(', ')})` : ''}` : 'n/a', '100% of dwelling, job, trading-hall and farm lots', MV && MV.lots > 0 && MV.reached === MV.lots));
  const nv = x.nav ? navSummary(x.nav) : null;
  out.push(row('vanilla', '3b Villager paths (vanilla, item 4)', nv ? `${nv.reached}/${nv.lots} villager lots: dev.nav.villager reaches the bell from the door cell${nv.not.length ? ` (not: ${nv.not.join(', ')})` : ''}` : 'n/a',
    '100% of bar 3\'s lots', nv && nv.lots > 0 && nv.reached === nv.lots));
  const dts = Object.values(x.door ?? {});
  const dOk = dts.filter((d) => d.ok).length;
  out.push(row('door', '4 Door to street', `${dOk}/${dts.length} placed lots walk from the door cell to the street over role blocks${dts.some((d) => !d.ok) ? ` (not: ${Object.entries(x.door).filter(([, d]) => !d.ok).map(([k, d]) => `${k}: ${d.why}`).join('; ')})` : ''}`, '100%', dts.length > 0 && dOk === dts.length));
  out.push(row('fronts', '5 Lot fronts', x.fronts ? `${x.fronts.cells} written dirt_path/cobblestone cell(s) in the front zones` : 'n/a', '0', x.fronts && x.fronts.cells === 0));
  const vr = (x.realised?.findings ?? []).filter((f) => /^M2[2-4]$/.test(f.rule));
  out.push(row('rules', '6 Villager rules (realised)', `M22 ${R.M22 ? `${R.M22.bad} bell-area cells bad, golem ${R.M22.golemBad} bad at ${R.M22.golemDistance}` : 'n/a'}; M23 ${JSON.stringify(R.M23 ?? {})}; M24 ${JSON.stringify(R.M24?.farms ?? {})}${R.M24?.waterInClaim === false ? ' (no water: a note)' : ''}; findings ${vr.length}`,
    'M22, M23 and M24 hold', R.M22 && vr.length === 0));
  const pp = x.props;
  out.push(row('props', '7 Props', pp ? `planned ${JSON.stringify(pp.planned)}, built ${JSON.stringify(pp.built)}; unsupported ${pp.unsupported}; misplaced ${pp.misplaced.length}` : 'n/a',
    "realised counts = the plan's; every cell supported; 0 in lot boxes, walk cells, bell area or golem space", pp && pp.equal && pp.unsupported === 0 && pp.misplaced.length === 0));
  const M4 = R.M4?.breaches ?? null, M5 = R.M5, wd = x.walkDark;
  out.push(row('safety', '8 Safety', `M4 ${M4}; M5 ${wd ? `${(100 * wd.share).toFixed(2)}% dark spawnable of ${wd.walkCells} walk cells (street, verges, lanes, square)` : 'n/a'}; recorded: the checker's M5 ${M5 ? (100 * M5.share).toFixed(2) : '?'}% of ${M5?.walkArea ?? '?'} reached region-written floors (lot aprons and batters included)`,
    'M4 0; M5 < 1% of walk area', M4 === 0 && wd && wd.light && wd.share < 0.01));
  for (const [id, label] of [['palette', '9 Palette'], ['exactness', '10 Exactness'], ['determinism', '11 Determinism'], ['mspt', '12 MSPT'], ['spend', '13 Spend'], ['gallery', '14 Gallery']]) {
    const r = by[id];
    if (r) out.push({ ...r, label, ...(id === 'determinism' ? { threshold: 'IR sha identical over 3 plans; tiles for 1 and 4 workers = scenarios/goldens/s7.json' } : {}) });
  }
  return out;
}

/** Bar 3 behavioural side (item 4): vanilla's villager reaches the bell from every villager lot's door cell. */
export function navSummary(nav) {
  const vl = Object.entries(nav?.lots ?? {}).filter(([, l]) => VILLAGER_LOTS.includes(l.villager));
  const ok = vl.filter(([, l]) => l.canReach);
  return { lots: vl.length, reached: ok.length, not: vl.filter(([, l]) => !l.canReach).map(([k]) => k) };
}
