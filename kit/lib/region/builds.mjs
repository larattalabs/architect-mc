// Player builds in plans (docs/CONTRACT.md "Phase 6c slice PT" §10, plan/0 additive): the pure helpers the plan check (P0's
// compiler) calls to answer feature.build, target {build} and endpoint.build, and the keep-outs a region plan honours (§7, S-PT-4).
//
// A build here is the mod's index record as Sites.builds returns it (BuildViews.planJson):
//   {id, kind: 'HOUSE'|..., bounds: [x0, y0, z0, x1, y1, z1], footprint: [z, x0, x1, ...], cells, revision, state,
//    entrances: [{pos: [x, y, z], facing: 'north'|'south'|'east'|'west'}]}
// Ids in plans are the persisted build ids; the plan artifact records each build it used with its revision (buildsUsed).

const KINDS = ['house', 'barn', 'farm', 'wall', 'tower', 'path', 'other'];
const STEP = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

/** The kept builds of a list (ACTIVE, CLAIMED, PROVISIONAL): RELEASED and gone builds are no features. */
export function keptBuilds(builds) {
  return (builds ?? []).filter((b) => b && b.id && b.state !== 'RELEASED');
}

/** The centre column of a build's bounds [x, z]. */
export function centre(b) {
  return [Math.floor((b.bounds[0] + b.bounds[3]) / 2), Math.floor((b.bounds[2] + b.bounds[5]) / 2)];
}

function idNumber(id) {
  const m = /^build-(\d+)$/.exec(id ?? '');
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * feature.build: the build a selector names. `sel` = {id} or {kind, pick?: 'largest'|'nearest', to?: [x, z]}. Ties follow
 * x-defaults feature.pick: largest (cells), then nearest to `to` (or the claim's centre), then the smallest min x, then min z.
 * Returns {build} or {none: reason}. Pure.
 */
export function pickBuild(builds, sel, { claim, to } = {}) {
  const all = keptBuilds(builds);
  if (sel?.id) {
    const b = all.find((x) => x.id === sel.id);
    return b ? { build: b } : { none: `no build ${sel.id} in the claim` };
  }
  const kind = String(sel?.kind ?? '').toLowerCase();
  if (!KINDS.includes(kind)) return { none: `a build selector needs an id or a kind (${KINDS.join(', ')})` };
  const cands = all.filter((b) => String(b.kind).toLowerCase() === kind);
  if (!cands.length) return { none: `no ${kind} build in the claim` };
  const ref = to ?? (claim ? [Math.floor((claim.minX + claim.maxX) / 2), Math.floor((claim.minZ + claim.maxZ) / 2)] : [0, 0]);
  const dist = (b) => { const c = centre(b); return Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]); };
  const nearestFirst = sel.pick === 'nearest';
  cands.sort((a, b) => (nearestFirst ? dist(a) - dist(b) || b.cells - a.cells : b.cells - a.cells || dist(a) - dist(b))
    || a.bounds[0] - b.bounds[0] || a.bounds[2] - b.bounds[2] || idNumber(a.id) - idNumber(b.id));
  return { build: cands[0] };
}

/** target {build: id}: the build's footprint rect [x0, z0, x1, z1] (inside, adjacent), or null when it is not a kept build. */
export function targetRect(builds, id) {
  const b = keptBuilds(builds).find((x) => x.id === id);
  return b ? [b.bounds[0], b.bounds[2], b.bounds[3], b.bounds[5]] : null;
}

/** Whether (x, z) lies in a build's footprint (its column runs). */
export function inFootprint(b, x, z) {
  const f = b.footprint ?? [];
  for (let i = 0; i + 2 < f.length; i += 3) if (f[i] === z && x >= f[i + 1] && x <= f[i + 2]) return true;
  return false;
}

/**
 * endpoint.build: where a road ends at a build's door. `port` 'door' (the first entrance by position) or 'door_<n>' (the n-th, from
 * 1). The apron is the 3 cells outside the door, on the side away from the build's footprint (a door faces into or out of its room,
 * so both sides are tried); the road ends on the apron's outer cell. Returns {end: [x, y, z], apron: [[x, y, z] x3], door, facing}
 * or {none: reason}. Pure.
 */
export function buildEndpoint(builds, id, port = 'door') {
  const b = keptBuilds(builds).find((x) => x.id === id);
  if (!b) return { none: `no build ${id} in the claim` };
  const doors = [...(b.entrances ?? [])].sort((p, q) => p.pos[0] - q.pos[0] || p.pos[2] - q.pos[2] || p.pos[1] - q.pos[1]);
  const m = /^door(?:_(\d+))?$/.exec(port ?? 'door');
  if (!m) return { none: `port ${port}: door or door_<n>` };
  const n = m[1] ? Number(m[1]) : 1;
  const e = doors[n - 1];
  if (!e) return { none: `${id} has ${doors.length} entrance(s), no ${port}` };
  const s = STEP[e.facing];
  if (!s) return { none: `entrance facing ${e.facing}` };
  for (const sign of [1, -1]) {
    const apron = [1, 2, 3].map((k) => [e.pos[0] + s[0] * k * sign, e.pos[1], e.pos[2] + s[1] * k * sign]);
    if (!apron.some((c) => inFootprint(b, c[0], c[2]))) return { end: apron[apron.length - 1], apron, door: e.pos, facing: e.facing, side: sign };
  }
  const apron = [1, 2, 3].map((k) => [e.pos[0] + s[0] * k, e.pos[1], e.pos[2] + s[1] * k]);
  return { end: apron[2], apron, door: e.pos, facing: e.facing, side: 1 };
}

/**
 * §7 region plan keep-outs: each kept build's bounds grown by 1 and each entrance's apron (both sides), as [x0, z0, x1, z1] rects
 * meeting the claim; the builds a consent names are left out (S-PT-4). The mod sends the same rects as region.plan's keepOut.
 */
export function buildKeepOut(builds, { claim, consented = [] } = {}) {
  const out = [];
  for (const b of keptBuilds(builds)) {
    if (consented.includes(b.id)) continue;
    const r = [b.bounds[0] - 1, b.bounds[2] - 1, b.bounds[3] + 1, b.bounds[5] + 1];
    if (claim && (r[2] < claim.minX - 1 || r[0] > claim.maxX + 1 || r[3] < claim.minZ - 1 || r[1] > claim.maxZ + 1)) continue;
    out.push(r);
    for (const e of b.entrances ?? []) {
      const s = STEP[e.facing];
      if (!s) continue;
      for (const sign of [1, -1]) {
        const a = [e.pos[0] + s[0] * sign, e.pos[2] + s[1] * sign];
        const z = [e.pos[0] + s[0] * 3 * sign, e.pos[2] + s[1] * 3 * sign];
        out.push([Math.min(a[0], z[0]), Math.min(a[1], z[1]), Math.max(a[0], z[0]), Math.max(a[1], z[1])]);
      }
    }
  }
  return out;
}

/** The record a plan artifact keeps per build it used (§10): id and revision, so a later change is reported, never DRIFTED. */
export function buildsUsed(builds, ids) {
  return keptBuilds(builds).filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id, revision: b.revision ?? 0 }))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id));
}
