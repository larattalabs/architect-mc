// (7a GJ) A district joins a walled town through one of its wall's standing gates (docs/CONTRACT.md "Phase 7a slice GJ" §1-§4): the
// third step of the join search, run only where D3's reach step would answer NO_JOIN [wall]. The join routes from a district end to the
// gate's outer cell (leg `out`), crosses the gate's walk without writing it (the traverse), and routes on from its inner cell to D3's
// cheapest street end or side inside the ring (leg `in`). The gates are the standing regions' own (the town's K1 walls and any wall
// region round it: the reach inputs' `gates`, beside.mjs besideGates / the mod's BesideReach.gates). Plan time only, pure, deterministic.
import { FLAG_MISSING } from './pack.mjs';
import { surveyApi } from './survey.mjs';
import { keyRuns, villagerOpens } from './beside.mjs';
import { LEAD, REACH_DRY_MAX, REACH_EXPANDED, hardRects, inRect, reachClasses, unionColumns } from './reach.mjs';

/** (§3) The join's width; a narrower gate is crossed at its own width (noted), the legs stay this wide outside its depth. */
export const GATE_JOIN_WIDTH = 3;
/** (§3) A villager needs 2 clear over the walk; the contract's 3 is the opening K1a builds (a lower one is used, noted). */
export const GATE_MIN_HEIGHT = 2;

/** The reach inputs of the regions round the town (a map's other entries: a wall region round it, §4), sorted by id. */
export function aroundOf(besideReach, townId) {
  if (!besideReach || besideReach.survey) return [];
  return Object.keys(besideReach).filter((id) => id !== townId).sort().map((id) => besideReach[id]);
}

/** Every gate of the town's walls and of the wall regions round it, each with its region (sorted by region, then gate id). */
export function gatesOf(R, around) {
  const out = [];
  for (const g of R?.gates ?? []) out.push({ ...g, region: g.region ?? R.standing.id });
  for (const a of around) for (const g of a.gates ?? []) out.push({ ...g, region: g.region ?? a.standing.id });
  return out.sort((p, q) => (p.region < q.region ? -1 : p.region > q.region ? 1 : 0) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

/** The reach classes of the town and the regions round it, as one (the union of each class). */
export function mergedClasses(K, around) {
  if (!around.length) return K;
  const M = { ...K };
  for (const k of ['lot', 'body', 'held', 'town', 'terrain', 'others', 'walls', 'lamps', 'props']) M[k] = new Set(K[k]);
  M.keep = new Map(K.keep);
  for (const a of around) {
    const A = reachClasses(a);
    for (const k of ['lot', 'body', 'held', 'lamps', 'props', 'walls']) for (const x of A[k]) M[k].add(x);
    // (a wall region's own cells are another owner's to the town's join: never its terrain's)
    for (const x of A.held) if (!K.town.has(x)) M.others.add(x);
    for (const [x, v] of A.keep) if (!M.keep.has(x)) M.keep.set(x, v);
  }
  return M;
}

/**
 * (§2) A gate's classification for a villager join: null when it may be crossed, else why not (`fence gate`, `iron door`, `not standing:
 * ...`, `too low`). `stands === false` is the mod's world check at plan time (the opening walled up, the door gone).
 */
export function gateProblem(g) {
  if (g.stands === false) return `not standing as built (${g.why ?? 'its opening is not clear'})`;
  if (g.door === 'fence_gate') return 'fence gate (player-only: a villager join skips it)';
  if (g.door === 'door' && !villagerOpens(g.doorBlock)) return `${g.doorBlock} (villagers open wooden doors only)`;
  if (!(g.h >= GATE_MIN_HEIGHT)) return `too low (${g.h} clear)`;
  return null;
}

/**
 * (§2-§4) The third step. `D` is chooseReach's state where it found every candidate enclosed: {planCols, R, around, beside, claimR, town,
 * yRange, districtEnds, candidates, baseHard, clearTrees, keepOut, maxGrade, volumes, unsafe, route, why}. Returns chooseReach's shape
 * with `gate` (the gate crossed and both legs) or throws `NO_JOIN: [wall] ...` listing every gate tried and why it failed.
 */
export function gateStep(D) {
  const { planCols, R, around, beside, claimR, town, yRange, districtEnds, candidates, baseHard, clearTrees, keepOut, maxGrade, volumes, unsafe = {}, route, why } = D;
  const gates = gatesOf(R, around);
  const tried = [];
  const refuse = () => {
    const list = tried.length ? tried.map((t) => `${t.region}:${t.id} ${t.why}`).join('; ') : 'no gate (sealed)';
    throw new Error(`NO_JOIN: [wall] every street end and side of region ${beside.id} is enclosed by ${R.standing.walls?.length || gates.some((g) => g.region === beside.id) ? "a wall (its own, or another owner's held columns)" : "another owner's held columns"}; the gates tried: ${list} (${why})`);
  };
  if (!gates.length) refuse();
  // ---- the frame over the town's claim and the wall regions' (§4): one grid, one set of classes
  const extras = around.map((a) => ({ cols: a.survey, rect: [...a.standing.claim] }));
  const F = [claimR, town, ...extras.map((e) => e.rect)];
  const U = unionColumns(planCols, R.survey, claimR, town, extras);
  const W = U.width, Dp = U.depth;
  const missing = (x, z) => x < U.minX || z < U.minZ || x >= U.minX + W || z >= U.minZ + Dp || (U.flags[(x - U.minX) + (z - U.minZ) * W] & FLAG_MISSING) !== 0;
  const api = { ...surveyApi(U, { minX: U.minX, minZ: U.minZ, maxX: U.minX + W - 1, maxZ: U.minZ + Dp - 1, minY: yRange[0], maxY: yRange[1] }), missingAt: missing };
  const K = mergedClasses(reachClasses(R), around);
  const inF = (x, z) => F.some((q) => inRect(q, x, z));
  // the hard columns: every held, footprint and body column of the standing claims outside the district's (the gates' cells are held)
  const hardKeys = new Set();
  const add = (k) => { const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); if (!inRect(claimR, x, z) && F.slice(1).some((q) => inRect(q, x, z))) hardKeys.add(k); };
  for (const s of [K.lot, K.body, K.held]) for (const k of s) add(k);
  for (const k of K.keep.keys()) add(k);
  for (const g of gates) for (const [x, z] of g.cells) add(`${x},${z}`);
  // ---- the flood (a superset of the route pass: a centre cell within 1 of a hard one carries no 3-wide footprint)
  const blocked = new Uint8Array(W * Dp);
  for (let j = 0; j < Dp; j++) for (let i = 0; i < W; i++) { const x = U.minX + i, z = U.minZ + j; if (!inF(x, z) || missing(x, z)) blocked[i + j * W] = 1; }
  for (const k of hardKeys) { const [x, z] = k.split(',').map(Number); const i = x - U.minX, j = z - U.minZ; if (i >= 0 && j >= 0 && i < W && j < Dp) blocked[i + j * W] = 1; }
  for (const q of baseHard) for (let z = Math.max(q[1], U.minZ); z <= Math.min(q[3], U.minZ + Dp - 1); z++) for (let x = Math.max(q[0], U.minX); x <= Math.min(q[2], U.minX + W - 1); x++) blocked[(x - U.minX) + (z - U.minZ) * W] = 1;
  const wide = new Uint8Array(W * Dp);
  for (let j = 0; j < Dp; j++) for (let i = 0; i < W; i++) {
    let b = 0;
    for (let dj = -1; dj <= 1 && !b; dj++) for (let di = -1; di <= 1; di++) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= Dp || blocked[ni + nj * W]) { b = 1; break; } }
    wide[i + j * W] = b;
  }
  const open = (x, z) => { const i = x - U.minX, j = z - U.minZ; if (i >= 0 && j >= 0 && i < W && j < Dp && !blocked[i + j * W]) wide[i + j * W] = 0; };
  for (const q of districtEnds) if (Array.isArray(q.facing)) for (let t = 0; t <= 4; t++) open(q.x + q.facing[0] * t, q.z + q.facing[1] * t);
  for (const c of candidates) for (let t = 0; t <= LEAD + 1; t++) open(c.at[0] + c.facing[0] * t, c.at[2] + c.facing[1] * t);
  for (const g of gates) for (let t = 0; t <= LEAD + 1; t++) { open(g.outer[0] + g.facing[0] * t, g.outer[1] + g.facing[1] * t); open(g.inner[0] - g.facing[0] * t, g.inner[1] - g.facing[1] * t); }
  const flood = (x0, z0) => {
    const seen = new Uint8Array(W * Dp), st = [];
    const i0 = x0 - U.minX, j0 = z0 - U.minZ;
    if (i0 < 0 || j0 < 0 || i0 >= W || j0 >= Dp) return seen;
    seen[i0 + j0 * W] = 1; st.push(i0 + j0 * W);
    while (st.length) {
      const k = st.pop(), i = k % W, j = (k - i) / W;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= Dp) continue;
        const nk = ni + nj * W;
        if (seen[nk] || wide[nk]) continue;
        seen[nk] = 1; st.push(nk);
      }
    }
    return seen;
  };
  const at = (seen, x, z) => { const i = x - U.minX, j = z - U.minZ; return i >= 0 && j >= 0 && i < W && j < Dp && seen[i + j * W] === 1; };
  const seenEnds = districtEnds.map((q) => flood(q.x, q.z));
  // ---- each gate: classified, its two cells checked, its legs' pairs (§2)
  const cheb = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  const viable = [];
  for (const g of gates) {
    const p = gateProblem(g);
    if (p) { tried.push({ region: g.region, id: g.id, why: p }); continue; }
    const cellWhy = (c, name) => {
      const [x, z] = c, k = `${x},${z}`;
      if (!inF(x, z) || missing(x, z)) return `its ${name} cell (${x}, ${z}) is outside the surveyed frame`;
      if (K.held.has(k) || K.lot.has(k) || K.keep.has(k) || K.body.has(k)) return `its ${name} cell (${x}, ${z}) is held`;
      if (Math.abs(api.groundAt(x, z) - g.y) > 1) return `its ${name} cell (${x}, ${z}) is not within 1 of the gate's walk (${api.groundAt(x, z)} vs ${g.y})`;
      return null;
    };
    const cw = cellWhy(g.outer, 'outer') ?? cellWhy(g.inner, 'inner');
    if (cw) { tried.push({ region: g.region, id: g.id, why: cw }); continue; }
    const ends = districtEnds.map((q, qi) => ({ q, qi })).filter(({ qi }) => at(seenEnds[qi], g.outer[0], g.outer[1]));
    const sIn = flood(g.inner[0], g.inner[1]);
    const cands = candidates.map((c, ci) => ({ c, ci })).filter(({ c }) => at(sIn, c.at[0], c.at[2]));
    if (!ends.length || !cands.length) { tried.push({ region: g.region, id: g.id, why: !ends.length ? 'no walk from a district end reaches its outer cell' : 'no walk from its inner cell reaches a street end or side' }); continue; }
    const b1 = Math.min(...ends.map(({ q }) => 10 * cheb([q.x, q.z], g.outer))), b2 = Math.min(...cands.map(({ c }) => 10 * cheb(g.inner, [c.at[0], c.at[2]])));
    viable.push({ g, ends, cands, b1, b2, bound: b1 + b2 });
  }
  if (!viable.length) refuse();
  // the gate nearest the district first on equal bounds, then its id (§2's ties)
  viable.sort((p, q) => p.bound - q.bound || p.b1 - q.b1 || (p.g.region < q.g.region ? -1 : p.g.region > q.g.region ? 1 : 0) || (p.g.id < q.g.id ? -1 : p.g.id > q.g.id ? 1 : 0));
  // ---- the routes: both legs share D3's 48 dry routes of 2M expansions each (§2)
  let dry = 0, cut = false, best = null;
  const feetOut = (g) => [g.outer[0], g.y + 1, g.outer[1]], feetIn = (g) => [g.inner[0], g.y + 1, g.inner[1]];
  const dryRoute = (from, to, hard, frame) => {
    dry++;
    const out = route(U, volumes, {
      edges: [{ id: 'dry', from, to, width: GATE_JOIN_WIDTH, movers: ['player', 'villager'], ladders: false, frame }],
      maxGrade, hairpinLanding: 3, stairs: true, maxCut: 4, maxFill: 4, margin: 2, hard: [...baseHard, ...hard], keepOut, prefer: [], clearTrees,
      maxExpanded: REACH_EXPANDED, frame: [claimR],
    });
    return out.data.edges[0];
  };
  const hardNone = hardRects(hardKeys, null);
  for (const v of viable) {
    if (best && v.bound >= best.cost) break;
    const g = v.g, fOut = [g.facing[0], g.facing[1]], fIn = [-g.facing[0], -g.facing[1]];
    // the leg out: the cheapest district end to the outer cell (arriving square on, heading in)
    let l1 = null;
    for (const { q, qi } of [...v.ends].sort((p, q2) => cheb([p.q.x, p.q.z], g.outer) - cheb([q2.q.x, q2.q.z], g.outer) || p.qi - q2.qi)) {
      if (l1 && 10 * cheb([q.x, q.z], g.outer) >= l1.cost) break;
      if (dry >= REACH_DRY_MAX) { cut = true; break; }
      const e = dryRoute({ at: q.at, facing: q.facing }, { at: feetOut(g), facing: fOut, lead: LEAD }, hardNone, F);
      if (e.ok && (!l1 || e.cost < l1.cost)) l1 = { cost: e.cost, length: e.length, end: q, qi };
    }
    if (!l1) { tried.push({ region: g.region, id: g.id, why: cut ? 'the dry-route budget ran out' : 'no route from a district end to its outer cell' }); if (cut) break; continue; }
    if (best && l1.cost + v.b2 >= best.cost) continue;
    // the leg in: the inner cell (leaving square on, heading in) to the cheapest D3 candidate
    let l2 = null;
    for (const { c, ci } of [...v.cands].sort((p, q) => cheb(g.inner, [p.c.at[0], p.c.at[2]]) - cheb(g.inner, [q.c.at[0], q.c.at[2]]) || p.ci - q.ci)) {
      if (l2 && 10 * cheb(g.inner, [c.at[0], c.at[2]]) >= l2.cost) break;
      if (best && l1.cost + 10 * cheb(g.inner, [c.at[0], c.at[2]]) >= best.cost) break;
      if (dry >= REACH_DRY_MAX) { cut = true; break; }
      const e = dryRoute({ at: feetIn(g), facing: fIn }, { at: c.at, facing: c.facing, lead: LEAD }, hardRects(hardKeys, c), [claimR, town]);
      if (e.ok && (!l2 || e.cost < l2.cost || (e.cost === l2.cost && ci < l2.ci))) l2 = { cost: e.cost, length: e.length, cand: c, ci };
    }
    if (!l2) { tried.push({ region: g.region, id: g.id, why: cut ? 'the dry-route budget ran out' : 'no route from its inner cell to a street end or side' }); if (cut) break; continue; }
    const cost = l1.cost + l2.cost;
    if (!best || cost < best.cost) best = { cost, g, l1, l2 };
  }
  if (!best) {
    if (cut && !tried.some((t) => !/budget/.test(t.why))) throw new Error(`NO_JOIN: [budget] ${REACH_DRY_MAX} dry routes through the gates of region ${beside.id} found none (${gates.length} gate(s); ${why})`);
    refuse();
  }
  const g = best.g, cand = best.l2.cand;
  const narrowed = g.width < GATE_JOIN_WIDTH ? g.width : null;
  const gate = {
    region: g.region, wall: g.wall, id: g.id, at: [...g.at], y: g.y, h: g.h, width: g.width, facing: [...g.facing], door: g.door, ...(g.doorBlock ? { doorBlock: g.doorBlock } : {}),
    cells: keyRuns(g.cells.map(([x, z]) => `${x},${z}`)), outer: [...g.outer], inner: [...g.inner], ...(narrowed ? { narrowed } : {}),
    legs: { out: { cost: best.l1.cost, length: best.l1.length }, in: { cost: best.l2.cost, length: best.l2.length } },
  };
  const contact = new Set(cand.contact);
  const gateCols = new Set(g.cells.map(([x, z]) => `${x},${z}`));
  // a retaining column outside this claim only where the reach may write (never a held column, the footprint, a body or a gate cell)
  const noRetain = (x, z) => !inRect(claimR, x, z) && (hardKeys.has(`${x},${z}`) || !F.slice(1).some((q) => inRect(q, x, z)) || gateCols.has(`${x},${z}`)) && !contact.has(`${x},${z}`);
  const lamps = [...K.lamps].map((k) => k.split(',').map(Number));
  const nearTownLamp = (x, z) => lamps.some(([lx, lz]) => Math.max(Math.abs(lx - x), Math.abs(lz - z)) <= 6);
  return {
    best: { end: best.l1.end, dry: { cost: best.cost, length: best.l1.length + best.l2.length }, cand, ci: best.l2.ci }, cand, gate,
    api, U, frame: F, innerFrame: [claimR, town], claimR, town, K, hardKeys, hard: hardRects(hardKeys, cand), noRetain, nearTownLamp,
    tried: dry, count: candidates.length, candidates, lights: [...(R.standing.lights ?? []), ...around.flatMap((a) => a.standing.lights ?? [])],
    gatesTried: tried, gateCols, unsafe,
  };
}
