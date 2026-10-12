// route_demo (6c T2, docs/CONTRACT.md "Phase 6c slice T2" §3): the route pass's fixture. Four small lots from a valley floor to a
// shoulder about 60 above (a gate, a hall, a chapel and a lookout), routed by the `route` pass: two villager edges (gate - hall,
// hall - chapel: walks, switchbacks, stairs, no ladders) and a player-only edge to the lookout (S-T2-1: inferred from the lookout's
// kind; S-T2-2: ladders allowed). The owner's keep-out (ctx.keepOut; the scenario protects a rect across the direct line) is an
// obstacle. On S3's pinned claim the scenario names the sites (params gateX .. lookoutZ, pinned against the claim's survey); without them the
// program finds its own. On a flat world (the scenario's flat variant) it raises a hill in stage `ground` and routes over it
// through the pass's `base` (the pass reads the frozen survey, which an earlier op can't change: T1's lesson).
//   ground: the hill (flat variant), the pads;  routes: the routes and their lamps;  lots-1: the lots.
// `stairs` / `ladders` / `maxGrade` pass through; `grid` adds a synthetic node grid for the plan-time bench (item 7).
import { region } from '../lib/region/program.mjs';
import { lampFixture } from '../lib/region/props.mjs';
import { lightCover } from '../lib/region/light.mjs';
import { lampSpots } from '../lib/region/passes/route.mjs';

export const id = 'route_demo';
export const catalogue = false;
export const passes = ['route'];

const XZ = { type: 'int', min: -30000000, max: 30000000, default: 0 };
export const params = {
  // the sites (the lots' north-west corners; all 0: found on the claim). The scenario pins them against S3's survey.
  gateX: { ...XZ, label: 'Gate x' }, gateZ: { ...XZ, label: 'Gate z' }, hallX: { ...XZ, label: 'Hall x' }, hallZ: { ...XZ, label: 'Hall z' },
  chapelX: { ...XZ, label: 'Chapel x' }, chapelZ: { ...XZ, label: 'Chapel z' }, lookoutX: { ...XZ, label: 'Lookout x' }, lookoutZ: { ...XZ, label: 'Lookout z' },
  gradePct: { type: 'int', min: 5, max: 100, default: 25, label: 'Grade limit (%)' },
  stairs: { type: 'bool', default: true, label: 'Stairs' },
  ladders: { type: 'bool', default: true, label: 'Ladders on player-only edges' },
  lamps: { type: 'bool', default: true, label: 'Lamps along the routes' },
  edges: { type: 'int', min: 0, max: 64, default: 0, label: 'Bench: extra grid edges' },
};

const LOT = 9; // the lots' size (a g6a_stub_9 fits)
const KINDS = ['gate', 'dwelling', 'job', 'lookout'];
const NAMES = ['gate', 'hall', 'chapel', 'lookout'];

export default function routeDemo(ctx) {
  const { claim, survey: S, params: P } = ctx;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  if (W < 96 || D < 96) throw new Error(`route_demo needs a claim of at least 96x96 (got ${W}x${D})`);
  const r = region(ctx);
  r.stages(['ground', 'routes', 'lots-1']);
  const c = S.columns, res = c.resolution;
  const st = S.stats(claim.minX, claim.minZ, claim.maxX, claim.maxZ);
  const flat = st.maxGround - st.minGround <= 2;
  const keepOut = ctx.keepOut;
  const kept = (x0, z0, x1, z1) => keepOut.some((k) => x0 <= k[2] && x1 >= k[0] && z0 <= k[3] && z1 >= k[1]);
  const cx = claim.minX + (W >> 1), cz = claim.minZ + (D >> 1);

  // ---- the flat variant's hill: a ridge rising 1 in 2 from the south to the north, 40 high, with a flat top
  const HILL = 40;
  const hillAt = (x, z) => {
    if (!flat) return 0;
    const z0 = claim.maxZ - 24, z1 = claim.minZ + 24 + 2 * 0; // rises northwards
    const t = Math.max(0, Math.min(z0 - z1, z0 - z));
    return Math.min(HILL, t >> 1);
  };
  const landAt = (x, z) => S.groundAt(x, z) + hillAt(x, z);
  let base = null;
  if (flat) {
    const values = new Int16Array(W * D);
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) values[i + j * W] = hillAt(claim.minX + i, claim.minZ + j);
    base = { minX: claim.minX, minZ: claim.minZ, width: W, depth: D, values };
    const hill = r.part('hill', { stage: 'ground' });
    const cols = [], mats = [r.material('surface', 'hill'), r.material('subsurface', 'hill'), r.material('rock', 'hill')];
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      const h = values[i + j * W];
      if (h <= 0) continue;
      const x = claim.minX + i, z = claim.minZ + j, g = S.groundAt(x, z);
      if (h > 4) cols.push(x, z, g + 1, g + h - 4, 2);
      cols.push(x, z, Math.max(g + 1, g + h - 3), g + h - 1, 1);
      cols.push(x, z, g + h, g + h, 0);
    }
    hill._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
    (r.meta.parts.hill ??= {}).kind = 'add';
  }

  // ---- the sites: given (params.sites), else found: 9x9 pads with little cut or fill, dry, treeless, off keep-out
  const sIdx = (x, z) => {
    let i = Math.floor((x - c.minX + (res >> 1)) / res), j = Math.floor((z - c.minZ + (res >> 1)) / res);
    i = Math.max(0, Math.min(c.width - 1, i)); j = Math.max(0, Math.min(c.depth - 1, j));
    return i + j * c.width;
  };
  const padOn = (x0, z0) => {
    let mx = -Infinity, mn = Infinity, bad = false;
    for (let z = z0 - 3; z <= z0 + LOT + 2; z += res) for (let x = x0 - 3; x <= x0 + LOT + 2; x += res) {
      const f = c.flags[sIdx(x, z)];
      if (f & 13) bad = true; // water, tree, lava
      if (x < x0 - 1 || x > x0 + LOT || z < z0 - 1 || z > z0 + LOT) continue;
      const g = landAt(x, z); if (g > mx) mx = g; if (g < mn) mn = g;
    }
    const top = (mx + mn) >> 1;
    return { top, cut: mx - top, fill: top - mn, bad };
  };
  const margin = 14;
  let sites;
  const given = NAMES.map((n) => [P[`${n}X`], P[`${n}Z`]]);
  if (!flat && given.some(([x, z]) => x !== 0 || z !== 0)) {
    sites = given.map(([x, z]) => ({ x, z, top: padOn(x, z).top }));
  } else if (flat) {
    // (the flat variant always lays its own sites) on the hill: the gate below its foot, the hall on the slope, the chapel near the top, the lookout on the top
    const at = (x, z) => ({ x, z, top: padOn(x, z).top });
    sites = [at(cx - 4, claim.maxZ - margin - LOT), at(cx + 30, cz + 20), at(cx - 34, cz - 22), at(cx + 4, claim.minZ + margin)];
  } else {
    const cands = [];
    for (let z = claim.minZ + margin; z + LOT <= claim.maxZ - margin; z += 4) for (let x = claim.minX + margin; x + LOT <= claim.maxX - margin; x += 4) {
      if (kept(x - 6, z - 6, x + LOT + 5, z + LOT + 5)) continue;
      const p = padOn(x, z);
      if (p.bad || p.cut > 3 || p.fill > 3) continue;
      cands.push({ x, z, top: p.top, score: p.cut + p.fill });
    }
    if (cands.length < 4) throw new Error('route_demo: fewer than 4 lot sites on this claim');
    cands.sort((a, b) => a.top - b.top || a.score - b.score || a.z - b.z || a.x - b.x);
    const low = cands[0];
    const far = (a, b, d) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) >= d;
    const near = (want, prev) => {
      let best = null, bs = Infinity;
      for (const q of cands) {
        if (!far(q, prev, 24) || ![low, ...picked].every((p) => far(q, p, 20))) continue;
        const sc = Math.abs(q.top - want) * 4 + Math.max(Math.abs(q.x - prev.x), Math.abs(q.z - prev.z)) + q.score;
        if (sc < bs) { bs = sc; best = q; }
      }
      if (!best) throw new Error(`route_demo: no lot site near y ${want}`);
      return best;
    };
    const picked = [];
    for (const dy of [20, 40, 60]) picked.push(near(low.top + dy, picked[picked.length - 1] ?? low));
    sites = [low, ...picked];
  }

  // ---- the pads and the lots (lots-1), each facing the lot below it (the gate faces the hall)
  const pads = r.part('pads', { stage: 'ground' });
  const toward = (a, b) => {
    const dx = (b.x + (LOT >> 1)) - (a.x + (LOT >> 1)), dz = (b.z + (LOT >> 1)) - (a.z + (LOT >> 1));
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  };
  // the front: toward the neighbouring lot when the ground in front is clear (dry, treeless, no keep-out for 10 cells, 7 wide), else the
  // first clear side (N, E, S, W)
  const CARD = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
  const clearFront = (p, f) => {
    const [dx, dz] = CARD[f], mx = p.x + (LOT >> 1), mz = p.z + (LOT >> 1);
    const ex = mx + dx * ((LOT >> 1) + 1), ez = mz + dz * ((LOT >> 1) + 1);
    for (let t = 1; t <= 10; t++) for (let v = -3; v <= 3; v++) {
      const x = ex + dx * t + dz * v, z = ez + dz * t + dx * v;
      if (x < claim.minX + 4 || x > claim.maxX - 4 || z < claim.minZ + 4 || z > claim.maxZ - 4) return false;
      if (c.flags[sIdx(x, z)] & 13 || kept(x, z, x, z)) return false;
    }
    return true;
  };
  const frontOf = (p, q) => { const t = toward(p, q); return [t, 'north', 'east', 'south', 'west'].find((f) => clearFront(p, f)) ?? t; };
  const lots = sites.map((p, i) => pads.lot(NAMES[i], {
    at: [p.x, p.z], size: [LOT, LOT], floor: p.top + 1, front: frontOf(p, i === 0 ? sites[1] : sites[i - 1]), stage: 'lots-1',
    pad: flat ? { edge: 'wall', maxCut: 64, maxFill: 64 } : { edge: 'slope', maxCut: 6, maxFill: 6 },
  }));

  // ---- the routes
  const nodes = Object.fromEntries(NAMES.map((n, i) => [n, { lot: n, kind: KINDS[i] }]));
  const edges = [{ id: 'gate_hall', from: 'gate', to: 'hall' }, { id: 'hall_chapel', from: 'hall', to: 'chapel' }, { id: 'chapel_lookout', from: 'chapel', to: 'lookout' }];
  // the bench: extra nodes on a grid, each joined to its neighbours (plan time only)
  if (P.edges > 0) {
    const g = [];
    const step = Math.max(48, Math.floor(Math.min(W, D) / 6));
    for (let z = claim.minZ + 32; z <= claim.maxZ - 32 && g.length < 64; z += step) for (let x = claim.minX + 32; x <= claim.maxX - 32 && g.length < 64; x += step) {
      if (c.flags[sIdx(x, z)] & 13) continue;
      g.push({ name: `n${g.length}`, x, z });
    }
    for (const q of g) nodes[q.name] = { at: [q.x, landAt(q.x, q.z) + 1, q.z], kind: 'junction' };
    for (let k = 0; k + 1 < g.length && edges.length < 3 + P.edges; k++) edges.push({ id: `b${k}`, from: g[k].name, to: g[k + 1].name });
  }
  const net = r.pass('route', { nodes, edges, maxGrade: P.gradePct / 100, stairs: P.stairs, ladders: P.ladders, stage: 'routes', ...(base ? { base } : {}) });
  // ---- anchors and cameras: the gate's entrance, the hub between the hall and the chapel
  const e0 = lots[0].entrance;
  r.anchor('entrance', [e0[0], e0[1], e0[2]]);
  r.anchor('spawn', [e0[0], e0[1], e0[2]]);
  const [hx, hy, hz] = lots[1].entrance;
  r.anchor('hub', [hx, hy, hz]);
  const clampX = (x) => Math.max(claim.minX, Math.min(claim.maxX, x)), clampZ = (z) => Math.max(claim.minZ, Math.min(claim.maxZ, z));
  const camY = (x, z, up) => Math.min(claim.maxY - 1, Math.max(hy, S.topAt(x, z) + hillAt(x, z)) + up);
  const cam = (n, x, z, up) => r.anchor(n, [clampX(x), camY(clampX(x), clampZ(z), up), clampZ(z)]);
  cam('cam_n', hx, hz - 70, 30); cam('cam_s', hx, hz + 70, 30); cam('cam_e', hx + 70, hz, 30); cam('cam_w', hx - 70, hz, 30);
  cam('cam_high', hx + 8, hz + 8, 80); cam('cam_ground', hx + 20, hz + 24, 3);
  // ---- lamps along the routes (W's lightCover, the bible's fixture; beside the lots too)
  if (P.lamps) {
    const extra = [], extraCap = {};
    for (const e of r.meta.route.edges) { const l = lampSpots(e); extra.push(...l.spots); if (l.spots.length) extraCap[`route:${e.id}`] = l.cap; }
    const cover = lightCover(r, { fixture: lampFixture(r), stage: 'routes', keepOut, extra, extraCap, part: 'route_lamps' });
    r.meta.route.lamps = { perKey: cover.perLot, before: cover.before, after: cover.after, capped: cover.capped, count: cover.lamps.length };
  }
  r.note(`route_demo: ${lots.length} lots ${sites.map((s) => `${s.x},${s.z}@${s.top}`).join(' ')}; ${net.edges.filter((e) => e.ok).length}/${edges.length} edges routed${flat ? ', on a flat world: a hill raised in stage ground' : ''}`);

  r.meta.route.demo = { flat, sites: sites.map((s, i) => ({ name: NAMES[i], kind: KINDS[i], at: [s.x, s.z], top: s.top })), hill: flat ? { height: HILL } : null };
  return r;
}
