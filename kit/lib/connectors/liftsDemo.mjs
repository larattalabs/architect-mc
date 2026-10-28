// (7a LF) lifts_demo's sections (docs/CONTRACT.md "Phase 7a slice LF" §9): the flat variant's raised cliffs and the natural variant's pick
// of a face on a pinned site. Each returns the route nodes and edges of its lifts (a lift edge: exactly one column, the walks at its ends),
// which kit/regions/lifts_demo.mjs routes and emits (emitDemoLifts). Pure plan-time code (integer math only).
//   flat:    two plateaus along the claim's north side, raised in stage `ground` through the shared base (the route pass meets them): one
//            `low` high (8) taken by an up column, one `high` high (48) by an up column with a down column beside it; the lifts head
//            north up the faces from approach walks at the foot
//   natural: the claim's best face (pickLift): a tower that passes checkLift over the survey, the foot and the top walkable 6 out
import { LIFT, checkLift, liftMats, surveyLiftLand, writeLift } from './liftGeom.mjs';
import { rightOf } from './ropeGeom.mjs';

/** The flat variant's layout (offsets from the claim's min corner). */
export const FLAT = Object.freeze({ W: 176, D: 96, face: 39, low: 8, high: 48, lows: [8, 71], highs: [88, 167], a: [40, 120], foot: 56, top: 28 });
/** The natural variant: the nodes stand this far out from the foot and the top. */
export const OUT = 6;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

const edgeOf = (id, from, to, down) => ({ id, from, to, width: 1, movers: ['player'], spans: ['lift'], once: 'lift', approach: 16, type: 'lift', t7: { lift: { down: !!down } } });

/** The flat section (stage `ground`): `{nodes, edges, note}`. */
export function flatSection(ctx, r, base, P) {
  const { survey: S, claim } = ctx;
  const x0 = claim.minX, z0 = claim.minZ;
  const low = P.low ?? FLAT.low, high = P.high ?? FLAT.high;
  const rects = [[x0 + FLAT.lows[0], z0, x0 + FLAT.lows[1], z0 + FLAT.face, low], [x0 + FLAT.highs[0], z0, x0 + FLAT.highs[1], z0 + FLAT.face, high]];
  // (each plateau its lift's own part, `lift_<edge>_cliff`: the face is the lift body's shell where it stands, M25:clear's program rule)
  const mats = [r.material('surface', 'cliff'), r.material('subsurface', 'cliff'), r.material('rock', 'cliff')];
  rects.forEach(([ax, az, bx, bz, R], i) => {
    const id = `lift_lift_${i ? 'high' : 'low'}_cliff`;
    const part = r.part(id, { stage: 'ground' });
    const cols = [];
    for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) {
      base.values[(x - base.minX) + (z - base.minZ) * base.width] += R;
      const g = S.groundAt(x, z);
      cols.push(x, z, g + 1, g + R - 4, 2, x, z, g + R - 3, g + R - 1, 1, x, z, g + R, g + R, 0);
    }
    part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 0, walk: false });
    (r.meta.parts[id] ??= {}).kind = 'add';
  });
  const at = (dx, dz, h) => [x0 + dx, S.groundAt(x0 + dx, z0 + dz) + h + 1, z0 + dz];
  const [la, ha] = FLAT.a;
  const nodes = {
    foot_low: { at: at(la, FLAT.foot, 0), kind: 'junction' }, top_low: { at: at(la, FLAT.top, low), kind: 'junction' },
    foot_high: { at: at(ha, FLAT.foot, 0), kind: 'junction' }, top_high: { at: at(ha, FLAT.top, high), kind: 'junction' },
  };
  r.meta.liftsDemo = { variant: 'flat', low, high, face: z0 + FLAT.face, a: FLAT.a.map((v) => x0 + v) };
  return { nodes, edges: [edgeOf('lift_low', 'foot_low', 'top_low', false), edgeOf('lift_high', 'foot_high', 'top_high', true)], note: `flat: faces ${low} and ${high} high (the high one with a down column)` };
}

/**
 * The claim's lift sites over a survey, best first: `{a: [x, y0, z] (the up approach), dir, side, down, rise, foot, top}`: a tower that
 * passes checkLift over the survey (with a down column when `down`), its foot walkable OUT cells back from the approach and its top OUT
 * cells on from the top walk cell (each within 1 of its end's level, dry); the rise nearest `rise` (16) first, then the line. `margin` keeps
 * the tower and its walks off the claim's edge.
 */
export function pickLift(S, claim, { down = true, rise = 16, margin = 12, step = 1 } = {}) {
  const land = surveyLiftLand(S, { claim });
  const out = [];
  const inside = (x, z) => x >= claim.minX + margin && x <= claim.maxX - margin && z >= claim.minZ + margin && z <= claim.maxZ - margin;
  for (let z = claim.minZ + margin; z <= claim.maxZ - margin; z += step) for (let x = claim.minX + margin; x <= claim.maxX - margin; x += step) {
    if (S.waterAt(x, z)) continue;
    const y0 = S.groundAt(x, z);
    for (const dir of DIRS) {
      const [dx, dz] = dir;
      const fx = x + 4 * dx, fz = z + 4 * dz;
      if (!inside(fx, fz) || S.groundAt(fx, fz) - y0 < LIFT.riseMin) continue;
      for (const side of down ? ['right', 'left'] : ['right']) {
        const g = checkLift(land, [x, y0, z], dir, { down, side });
        if (!g.ok || g.rise > 40) continue;
        // the walks: the foot OUT back, the top OUT on, each cell within 1 of its end's level and dry
        let ok = true;
        const [rx, rz] = rightOf(dir);
        const lanes = down ? [0, side === 'left' ? -2 : 2] : [0];
        for (const v of lanes) for (let t = 1; t <= OUT && ok; t++) {
          const bx = x - dx * t + rx * v, bz = z - dz * t + rz * v, tx = fx + dx * t + rx * v, tz = fz + dz * t + rz * v;
          if (!inside(bx, bz) || !inside(tx, tz) || S.waterAt(bx, bz) || S.waterAt(tx, tz) || Math.abs(S.groundAt(bx, bz) - y0) > 1 || Math.abs(S.groundAt(tx, tz) - g.yT) > 1) ok = false;
          if (S.topAt(bx, bz) > S.groundAt(bx, bz) || S.topAt(tx, tz) > S.groundAt(tx, tz)) ok = false;
        }
        if (!ok) continue;
        out.push({ a: [x, y0, z], dir, side, down, rise: g.rise, yT: g.yT, foot: [x - dx * OUT, y0 + 1, z - dz * OUT], top: [fx + dx * OUT, g.yT + 1, fz + dz * OUT] });
      }
    }
  }
  out.sort((p, q) => Math.abs(p.rise - rise) - Math.abs(q.rise - rise) || p.a[0] - q.a[0] || p.a[2] - q.a[2] || DIRS.indexOf(p.dir) - DIRS.indexOf(q.dir) || (p.side < q.side ? -1 : p.side > q.side ? 1 : 0));
  return out;
}

/** The natural section: the best site's nodes and edge (a down column where one fits, else up only); `{nodes, edges, note}`. */
export function naturalSection(ctx, r, base, P) {
  void base; void P;
  const { survey: S, claim } = ctx;
  let picks = pickLift(S, claim, { down: true });
  if (!picks.length) picks = pickLift(S, claim, { down: false });
  const c = picks[0];
  if (!c) return { nodes: {}, edges: [], note: 'natural: no face takes a lift' };
  const nodes = { foot: { at: c.foot, kind: 'junction' }, top: { at: c.top, kind: 'junction' } };
  r.meta.liftsDemo = { variant: 'natural', site: { a: c.a, dir: c.dir, side: c.side, down: c.down, rise: c.rise }, candidates: picks.length };
  return { nodes, edges: [edgeOf('lift_natural', 'foot', 'top', c.down)], note: `natural: a lift of rise ${c.rise} at ${c.a.join(',')} heading ${c.dir.join(',')}${c.down ? ` with a down column on the ${c.side}` : ''}` };
}

/**
 * The lifts the route pass found (`edges`: its edge records), written in `stage` (parts `links_lift_<edge>`, bodies `lift_<edge>`) over a
 * land of the survey and the program's base. Returns [{edge, rec, body, bom}].
 */
export function emitDemoLifts(r, ctx, edges, { stage = 'links', base = null } = {}) {
  const land = surveyLiftLand(ctx.survey, { base, claim: ctx.claim });
  const mats = liftMats(r);
  const out = [];
  for (const e of edges) {
    if (!e.ok) continue;
    for (const g of e.segments ?? []) {
      if (g.kind !== 'lift') continue;
      const t = checkLift(land, g.approach, g.dir, { down: g.down, side: g.side, move: g.move });
      if (!t.ok) throw new Error(`lifts_demo: edge ${e.id}'s lift no longer checks: ${t.code} ${JSON.stringify(t.evidence).slice(0, 200)}`);
      const res = writeLift(r, t, { part: `lift_${e.id}_tower`.slice(0, 48), stage, bodyId: `lift_${e.id}`.slice(0, 48), planPart: null, mats, id: `lift_${e.id}`.slice(0, 48), edge: e.id, movers: ['player'],
        sturdy: (x, y, z) => ['ROCK', 'SOIL'].includes(land.classAt(x, y, z)) });
      out.push({ edge: e.id, rec: res.rec, body: res.body, bom: res.bom });
    }
  }
  return out;
}
