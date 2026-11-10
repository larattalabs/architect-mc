// (7a GJ) A district joins a walled town through one of its wall's standing gates (docs/CONTRACT.md "Phase 7a slice GJ" §1-§4): the
// third step of the join search, run only where D3's reach step would answer NO_JOIN [wall]. The join routes from a district end to the
// gate's outer cell (leg `out`), crosses the gate's walk without writing it (the traverse), and routes on from its inner cell to D3's
// cheapest street end or side inside the ring (leg `in`). The gates are the standing regions' own (the town's K1 walls and any wall
// region round it: the reach inputs' `gates`, beside.mjs besideGates / the mod's BesideReach.gates). Plan time only, pure, deterministic.
import { FLAG_MISSING } from './pack.mjs';
import { surveyApi } from './survey.mjs';
import { keyRuns, villagerOpens } from './beside.mjs';
import { LEAD, REACH_DRY_MAX, REACH_EXPANDED, contactProblem, hardRects, inRect, reachClasses, unionColumns } from './reach.mjs';

/** (§3) The join's width; a narrower gate is crossed at its own width (noted), the legs stay this wide outside its depth. */
export const GATE_JOIN_WIDTH = 3;
/** (§3) A villager needs 2 clear over the walk; the contract's 3 is the opening K1a builds (a lower one is used, noted). */
export const GATE_MIN_HEIGHT = 2;

/**
 * The reach inputs of the wall regions round the town (§4): a map's other entries that have gates and whose claim holds the town claim's
 * centre (the mod's GateJoin.wallRegionRound; a plan check's map may name a second endpoint region, never read here), sorted by id.
 */
export function aroundOf(besideReach, townId) {
  if (!besideReach || besideReach.survey || !besideReach[townId]) return [];
  const t = besideReach[townId].standing.claim, cx = (t[0] + t[2]) >> 1, cz = (t[1] + t[3]) >> 1;
  return Object.keys(besideReach).filter((id) => id !== townId).sort().map((id) => besideReach[id])
    .filter((a) => (a.gates ?? []).length && cx >= a.standing.claim[0] && cx <= a.standing.claim[2] && cz >= a.standing.claim[1] && cz <= a.standing.claim[3]);
}

/** (§3) The gate a join crosses, as the IR's `reach.gate` and the plan meta record it (the traverse: never written, never held). */
export function gateMeta(g) {
  return { region: g.region, wall: g.wall, id: g.id, at: [...g.at], y: g.y, h: g.h, width: g.width, facing: [...g.facing], door: g.door, ...(g.doorBlock ? { doorBlock: g.doorBlock } : {}), cells: g.cells.map((q) => [...q]), outer: [...g.outer], inner: [...g.inner], ...(g.narrowed ? { narrowed: g.narrowed, legs: g.legs.map((q) => [...q]) } : {}),
    ...(g.kind ? { kind: g.kind, lot: g.lot } : {}), ...(g.mechanism ? { mechanism: { kind: g.mechanism.kind, rest: g.mechanism.rest, moving: [...g.mechanism.moving] } } : {}) };
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
  // ((PG; GM §6) a gate mechanism resting closed (swing's iron doors, or a `rest: closed` grate) is player-only, as a fence gate; resting
  // open it is an open gate, a day-driven one included: GM §6's planner can't know the time of day)
  if (g.mechanism?.rest === 'closed') return `a ${g.mechanism.kind} mechanism closed at rest (player-only: a villager join skips it)`;
  if (g.door === 'fence_gate') return 'fence gate (player-only: a villager join skips it)';
  if (g.door === 'door' && !villagerOpens(g.doorBlock)) return `${g.doorBlock} (villagers open wooden doors only)`;
  if (!(g.h >= GATE_MIN_HEIGHT)) return `too low (${g.h} clear)`;
  return null;
}

/**
 * (PG) The "x,z" keys of every passage gate's port strips: each port cell and the cells beside it across the passage's width (the K3
 * box's apron there, which a lot + 1 ring would otherwise make hard). Empty without a passage, so a K1 gate's join is unchanged.
 */
export function passagePorts(gates) {
  const out = new Set();
  for (const g of gates) {
    if (g.kind !== 'passage') continue;
    const half = Math.max(1, g.width >> 1), [fx, fz] = g.facing;
    for (const [px, pz] of [g.outer, g.inner]) for (let v = -half; v <= half; v++) out.add(`${px - fz * v},${pz + fx * v}`);
  }
  return out;
}

/**
 * (PG) Each passage's front contact columns (gate key -> keys): its front strip (the port's width) from the port out LEAD cells, where
 * the town's terrain alone holds it (the K3 lot's pad, K3 §3) and no footprint or body, outside every lot + 1 but the passage's own port
 * strip. The leg out may write them, holding them as D3 holds a junction's contact columns. Only passages with any are keyed.
 */
export function passageFronts(gates, K, portFree) {
  const out = new Map();
  for (const g of gates) {
    if (g.kind !== 'passage') continue;
    const half = Math.max(1, g.width >> 1), [fx, fz] = g.facing, keys = [];
    for (let t = 0; t <= LEAD; t++) for (let v = -half; v <= half; v++) {
      const k = `${g.outer[0] + fx * t - fz * v},${g.outer[1] + fz * t + fx * v}`;
      if (K.held.has(k) && K.terrain.has(k) && !K.keep.has(k) && !K.body.has(k) && (!K.lot.has(k) || portFree.has(k))) keys.push(k);
    }
    if (keys.length) out.set(`${g.region}:${g.id}`, keys);
  }
  return out;
}

/**
 * (PG) A passage whose back port is the end of the town's own lane (K3 §4: a lane from the back port to the zone's street, a road of the
 * town's footprint with a graph node at the port) opens on that junction: an end candidate at the back port, offered to that passage
 * only, `run` 0 (no leg in, nothing written: GJ §13's one-cell join_in), `lane` its road. The lane carries the walk on to the street.
 */
export function passageLaneEnds(gates, K, beside) {
  const out = [];
  for (const g of gates) {
    if (g.kind !== 'passage') continue;
    const [ix, iz] = g.inner, k = `${ix},${iz}`;
    const road = (K.keep.get(k) ?? []).find((q) => q.kind === 'road');
    const node = (beside.graph?.nodes ?? []).find((n) => Array.isArray(n.at) && n.at[0] === ix && n.at[2] === iz && n.kind === 'junction');
    if (!road || !node) continue;
    const at = [ix, g.y + 1, iz];
    out.push({ kind: 'end', road: road.id, node: node.id, port: node.ports?.[0]?.name ?? 'route', at, facing: [-g.facing[0], -g.facing[1]], contact: [], hold: [], junction: { kind: 'end', at: [...at] }, gate: `${g.region}:${g.id}`, run: 0, lane: road.id });
  }
  return out;
}

/** Where a leg stops inside the wall: the inner cell, or one further in on a gate narrower than the join (§3). */
const legEndIn = (g) => (g.width < GATE_JOIN_WIDTH ? [g.inner[0] - g.facing[0], g.inner[1] - g.facing[1]] : g.inner);

/**
 * (RC, default ring) D3's end candidate asks for clear land LEAD cells past the street end, so a wall nearer than that drops it, gate or
 * no gate. A gate of `gates` square on a dropped end's line takes it back: the contact stops at the gate. Each `{...an end candidate, gate:
 * "<region>:<id>", run}` is offered to that gate only; `run` is the cells the leg in walks past the junction: 0 or less, none (the gate
 * opens on the junction: no leg, nothing written; -1, its inner cell is the street's own end). Contact rows are D3's rule (§3.4), so a
 * lamp or lot in them refuses: `blocked` maps the gate's key to why.
 */
export function inLineEnds({ gates, net, candidates, K, api, frame, unsafe = {} }) {
  const out = [], blocked = new Map();
  const dropped = net.ends.filter((q) => !candidates.some((c) => c.kind === 'end' && c.node === q.node));
  for (const g of gates) for (const q of dropped) {
    const [dx, dz] = q.dir, [ix, iz] = legEndIn(g);
    if (g.facing[0] !== dx || g.facing[1] !== dz || (ix - q.end[0]) * dz !== (iz - q.end[1]) * dx) continue;
    const run = (ix - q.end[0]) * dx + (iz - q.end[1]) * dz;
    if (run < -1 || run >= LEAD) continue;
    const key = `${g.region}:${g.id}`, keys = [];
    for (let t = 0; t <= run; t++) for (let v = -1; v <= 1; v++) keys.push(`${q.end[0] + dx * t - dz * v},${q.end[1] + dz * t + dx * v}`);
    const p = keys.map((k) => contactProblem(K, api, frame, k, { unsafe })).find((w) => w);
    if (p) { blocked.set(key, `its inner run to street end ${q.node}, ${run + 1} cell(s), is blocked: ${p}`); continue; }
    const surface = api.groundAt(q.at[0], q.at[2]);
    if (run <= 0 && Math.abs(surface - g.y) > 1) { blocked.set(key, `it opens on street end ${q.node} with no room for a step (the street at ${surface}, its walk at ${g.y})`); continue; }
    const at = run < 0 ? [q.at[0], surface + 1, q.at[2]] : [q.end[0], surface + 1, q.end[1]];
    out.push({ kind: 'end', road: q.road, node: q.node, port: q.port, at, facing: [dx, dz], contact: keys, hold: keys.filter((k) => K.terrain.has(k)), junction: { kind: 'end', at: [...at] }, gate: key, run });
  }
  return { ends: out, blocked };
}

/**
 * (§2-§4) The third step. `D` is chooseReach's state where it found every candidate enclosed: {planCols, R, around, beside, claimR, town,
 * yRange, districtEnds, candidates, net, dropped, baseHard, clearTrees, keepOut, maxGrade, volumes, unsafe, route, why}. Returns chooseReach's shape
 * with `gate` (the gate crossed and both legs) or throws `NO_JOIN: [wall] ...` listing every gate tried and why it failed.
 */
export function gateStep(D) {
  const { planCols, R, around, beside, claimR, town, yRange, districtEnds, candidates: standing, net, dropped = {}, baseHard, clearTrees, keepOut, maxGrade, volumes, unsafe = {}, route, why } = D;
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
  // ((RC, default ring) the street ends D3 dropped for a wall nearer than its lead, where a gate is square on their line)
  const inLine = inLineEnds({ gates, net, candidates: standing, K, api, frame: [claimR, town], unsafe });
  // ((PG) a passage: its port strips are free of its own apron; its front's lead, where only the town's terrain holds it (the K3 pad), is
  // a contact column the join holds; a back port on the town's own lane (K3 §4's inner lane) is the junction: the lane walks on)
  const portFree = passagePorts(gates);
  const fronts = passageFronts(gates, K, portFree);
  const laneEnds = passageLaneEnds(gates, K, beside);
  const candidates = [...standing, ...inLine.ends, ...laneEnds];
  const runContact = new Set([...inLine.ends.flatMap((c) => c.contact), ...[...fronts.values()].flat()]);
  const noJunction = Object.entries(dropped).map(([k, v]) => `${v} ${k}`).join(', ');
  // the hard columns: every held, footprint and body column of the standing claims outside the district's (the gates' cells are held)
  const hardKeys = new Set();
  const add = (k) => { const i = k.indexOf(','); const x = Number(k.slice(0, i)), z = Number(k.slice(i + 1)); if (!inRect(claimR, x, z) && F.slice(1).some((q) => inRect(q, x, z))) hardKeys.add(k); };
  // ((PG) a passage's port strips are not its own apron's: the legs end there, as at a K1 gate's outer and inner cells)
  for (const k of K.lot) if (!portFree.has(k)) add(k);
  for (const s of [K.body, K.held]) for (const k of s) add(k);
  for (const k of K.keep.keys()) add(k);
  for (const g of gates) for (const [x, z] of g.cells) add(`${x},${z}`);
  // ---- the flood (a superset of the route pass: a centre cell within 1 of a hard one carries no 3-wide footprint)
  const blocked = new Uint8Array(W * Dp);
  for (let j = 0; j < Dp; j++) for (let i = 0; i < W; i++) { const x = U.minX + i, z = U.minZ + j; if (!inF(x, z) || missing(x, z)) blocked[i + j * W] = 1; }
  for (const k of hardKeys) { if (runContact.has(k)) continue; const [x, z] = k.split(',').map(Number); const i = x - U.minX, j = z - U.minZ; if (i >= 0 && j >= 0 && i < W && j < Dp) blocked[i + j * W] = 1; }
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
  for (const g of gates) for (let t = 0; t <= LEAD + 2; t++) { open(g.outer[0] + g.facing[0] * t, g.outer[1] + g.facing[1] * t); open(g.inner[0] - g.facing[0] * t, g.inner[1] - g.facing[1] * t); }
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
  const narrowOf = (g) => g.width < GATE_JOIN_WIDTH;
  const endOut = (g) => (narrowOf(g) ? [g.outer[0] + g.facing[0], g.outer[1] + g.facing[1]] : g.outer);
  const endIn = legEndIn;
  const cheb = (p, q) => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]));
  const viable = [];
  const inLineOf = (g) => [...inLine.ends, ...laneEnds].filter((c) => c.gate === `${g.region}:${g.id}`);
  for (const g of gates) {
    const gk = `${g.region}:${g.id}`, mine = inLineOf(g);
    const p = gateProblem(g);
    if (p) { tried.push({ region: g.region, id: g.id, why: p }); continue; }
    const cellWhy = (c, name) => {
      const [x, z] = c, k = `${x},${z}`;
      if (!inF(x, z) || missing(x, z)) return `its ${name} cell (${x}, ${z}) is outside the surveyed frame`;
      // (a cell of an in-line run is D3's contact column, passed by its own rule; a street end the gate opens on is the street's)
      if (mine.some((c) => c.contact.includes(k) || (c.run < 0 && x === legEndIn(g)[0] && z === legEndIn(g)[1]))) return null;
      // ((PG) a passage's front port held by the town's terrain alone is a contact column; its back port on the town's lane, the junction)
      if ((fronts.get(gk) ?? []).includes(k) || mine.some((c) => c.lane)) return null;
      if (K.held.has(k) || (K.lot.has(k) && !portFree.has(k)) || K.keep.has(k) || K.body.has(k)) return `its ${name} cell (${x}, ${z}) is held`;
      if (Math.abs(api.groundAt(x, z) - g.y) > 1) return `its ${name} cell (${x}, ${z}) is not within 1 of the gate's walk (${api.groundAt(x, z)} vs ${g.y})`;
      return null;
    };
    const cw = cellWhy(g.outer, 'outer') ?? cellWhy(g.inner, 'inner') ?? (narrowOf(g) ? cellWhy(endOut(g), 'outer leg\'s end') ?? cellWhy(endIn(g), 'inner leg\'s end') : null);
    if (cw) { tried.push({ region: g.region, id: g.id, why: cw }); continue; }
    const ends = districtEnds.map((q, qi) => ({ q, qi })).filter(({ qi }) => at(seenEnds[qi], endOut(g)[0], endOut(g)[1]));
    const sIn = flood(endIn(g)[0], endIn(g)[1]);
    const cands = candidates.map((c, ci) => ({ c, ci })).filter(({ c }) => (!c.gate || c.gate === gk) && at(sIn, c.at[0], c.at[2]));
    if (!ends.length || !cands.length) { tried.push({ region: g.region, id: g.id, why: !ends.length ? 'no walk from a district end reaches its outer cell' : inLine.blocked.get(gk) ?? `no walk from its inner cell reaches a street end or side${noJunction ? ` (none offered: ${noJunction})` : ''}` }); continue; }
    const b1 = Math.min(...ends.map(({ q }) => 10 * cheb([q.x, q.z], endOut(g)))), b2 = Math.min(...cands.map(({ c }) => 10 * cheb(endIn(g), [c.at[0], c.at[2]])));
    viable.push({ g, ends, cands, b1, b2, bound: b1 + b2 });
  }
  if (!viable.length) refuse();
  // the gate nearest the district first on equal bounds, then its id (§2's ties)
  viable.sort((p, q) => p.bound - q.bound || p.b1 - q.b1 || (p.g.region < q.g.region ? -1 : p.g.region > q.g.region ? 1 : 0) || (p.g.id < q.g.id ? -1 : p.g.id > q.g.id ? 1 : 0));
  // ---- the routes: both legs share D3's 48 dry routes of 2M expansions each (§2)
  let dry = 0, cut = false, best = null;
  // (§3) a gate narrower than the join: the legs stop one cell further out each side, and the cell each side of the traverse is walked
  // at the gate's width on its own ground (checked within 1 of the walk, never written: the join narrowed there)
  const legOut = (g) => (g.width < GATE_JOIN_WIDTH ? [g.outer[0] + g.facing[0], g.outer[1] + g.facing[1]] : g.outer);
  const legIn = legEndIn;
  const feetOut = (g) => [legOut(g)[0], g.y + 1, legOut(g)[1]], feetIn = (g) => [legIn(g)[0], g.y + 1, legIn(g)[1]];
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
    // (a gate whose bound ties the best is still costed: equal totals go to the gate nearest the district, then its id)
    if (best && v.bound > best.cost) break;
    const g = v.g, fOut = [g.facing[0], g.facing[1]], fIn = [-g.facing[0], -g.facing[1]], mine = inLineOf(g);
    // the leg out: the cheapest district end to the outer cell (arriving square on, heading in)
    let l1 = null;
    for (const { q, qi } of [...v.ends].sort((p, q2) => cheb([p.q.x, p.q.z], endOut(g)) - cheb([q2.q.x, q2.q.z], endOut(g)) || p.qi - q2.qi)) {
      if (l1 && 10 * cheb([q.x, q.z], endOut(g)) >= l1.cost) break;
      if (dry >= REACH_DRY_MAX) { cut = true; break; }
      const e = dryRoute({ at: q.at, facing: q.facing }, { at: feetOut(g), facing: fOut, lead: LEAD }, fronts.has(`${g.region}:${g.id}`) ? hardRects(hardKeys, { contact: fronts.get(`${g.region}:${g.id}`) }) : hardNone, F);
      if (e.ok && (!l1 || e.cost < l1.cost)) l1 = { cost: e.cost, length: e.length, end: q, qi };
    }
    if (!l1) { tried.push({ region: g.region, id: g.id, why: cut ? 'the dry-route budget ran out' : 'no route from a district end to its outer cell' }); if (cut) break; continue; }
    if (best && l1.cost + v.b2 > best.cost) continue;
    // the leg in: the inner cell (leaving square on, heading in) to the cheapest D3 candidate
    let l2 = null;
    for (const { c, ci } of [...v.cands].sort((p, q) => cheb(endIn(g), [p.c.at[0], p.c.at[2]]) - cheb(endIn(g), [q.c.at[0], q.c.at[2]]) || p.ci - q.ci)) {
      if (l2 && 10 * cheb(endIn(g), [c.at[0], c.at[2]]) >= l2.cost) break;
      if (best && l1.cost + 10 * cheb(endIn(g), [c.at[0], c.at[2]]) > best.cost) break;
      // ((RC, default ring) the gate opens on the junction: no leg in, nothing to route)
      if (c.run <= 0) { l2 = { cost: 0, length: 0, cand: c, ci }; break; }
      if (dry >= REACH_DRY_MAX) { cut = true; break; }
      const e = dryRoute({ at: feetIn(g), facing: fIn }, { at: c.at, facing: c.facing, lead: LEAD }, hardRects(hardKeys, c), [claimR, town]);
      if (e.ok && (!l2 || e.cost < l2.cost || (e.cost === l2.cost && ci < l2.ci))) l2 = { cost: e.cost, length: e.length, cand: c, ci };
    }
    if (!l2) {
      const c = mine.find((x) => x.run > 0), rise = c ? c.at[1] - 1 - g.y : 0;
      tried.push({ region: g.region, id: g.id, why: cut ? 'the dry-route budget ran out' : rise ? `its ${c.run + 1}-cell run to street end ${c.node} is too short for the grade (the street at ${c.at[1] - 1}, its walk at ${g.y})` : 'no route from its inner cell to a street end or side' });
      if (cut) break;
      continue;
    }
    const cost = l1.cost + l2.cost;
    const key = (b) => [b.b1, b.g.region, b.g.id];
    const before = (a, b) => { const p = key(a), q = key(b); return p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0) || (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0); };
    const cand = { cost, g, l1, l2, b1: v.b1 };
    if (!best || cost < best.cost || (cost === best.cost && before(cand, best) < 0)) best = cand;
  }
  if (!best) {
    if (cut && !tried.some((t) => !/budget/.test(t.why))) throw new Error(`NO_JOIN: [budget] ${REACH_DRY_MAX} dry routes through the gates of region ${beside.id} found none (${gates.length} gate(s); ${why})`);
    refuse();
  }
  const g = best.g, front = fronts.get(`${g.region}:${g.id}`) ?? [];
  // ((PG) a passage's front contact columns join the candidate's: the join holds them, the re-check reads them as D3's contact)
  const cand = front.length ? { ...best.l2.cand, contact: [...best.l2.cand.contact, ...front], hold: [...best.l2.cand.hold, ...front.filter((k) => K.held.has(k))] } : best.l2.cand;
  const narrowed = g.width < GATE_JOIN_WIDTH ? g.width : null;
  const gate = {
    region: g.region, wall: g.wall, id: g.id, at: [...g.at], y: g.y, h: g.h, width: g.width, facing: [...g.facing], door: g.door, ...(g.doorBlock ? { doorBlock: g.doorBlock } : {}),
    cells: keyRuns(g.cells.map(([x, z]) => `${x},${z}`)), outer: [...g.outer], inner: [...g.inner], ...(narrowed ? { narrowed, legs: [endOut(g), endIn(g)] } : {}),
    ...(g.kind ? { kind: g.kind, lot: g.lot } : {}), ...(g.mechanism ? { mechanism: { kind: g.mechanism.kind, rest: g.mechanism.rest, moving: [...g.mechanism.moving] } } : {}),
    ...(cand.run <= 0 ? { opensOnJunction: true } : {}), // (the leg in's edge is the one cell: its node at the junction, nothing written)
    costs: { out: { cost: best.l1.cost, length: best.l1.length }, in: { cost: best.l2.cost, length: best.l2.length } },
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
