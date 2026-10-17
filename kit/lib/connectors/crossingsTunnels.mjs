// (6c T3) crossings_demo's tunnel half (docs/CONTRACT.md "Phase 6c slice T3" §10): slice T3b owns this file (kit/regions/crossings_demo.mjs
// calls it; T3a owns the program and its bridge half, lib/connectors/crossingsBridges.mjs).
//   tunnelSection(ctx, r, {rect, variant, base, P}) -> {nodes, edges, input, note}
//       in stage `ground`: the section's own land (the flat variant's ridge raised in `ground`, written into `base.values` so the route
//       pass meets it, T1's lesson), its route nodes and edges (spans ['tunnel'], once 'tunnel', t3.tunnel), and the pass-level `tunnel`
//       input (null: none). `rect` [x0, z0, x1, z1]: the claim's part this section may use (the flat claim's east half; the whole
//       claim on the `hill` variant); `variant`: flat | hill (river and frozen are the bridges'); `base`: {minX, minZ, width, depth,
//       values: Int16Array} the shared base; `P`: the program's params.
//   emitDemoTunnels(r, {stage}) -> [records]   in the links stage, after the bridges
// The tunnel:
//   flat: a ridge raised in `ground` across the section (along z), 12 over the ground with slopes of 1 a cell (stone, 3 of dirt, grass
//         on top), 57 across, so a 3x3 villager bore runs 48 cells under at least 2 cover, with cut approaches and parapets; a sand band
//         2 thick over the roof's middle 24 cells (lined: M3:gravity); a second bore 1 wide, 20 to the south (villagers walk it). Its corridor (the flat ground under the ridge) is asked as a frozen
//         volume (the two-plan flow); the ridge's own cells are the plan's (site-solid but for the band).
//   hill: the pinned natural hill: the straight east-west line through the claim with the longest surface bore (32 to 60 floor cells,
//         ends on low ground at most max(1, L / 8) apart), its corridor asked as a frozen volume.
// Anchors: cam_portal (outside the west portal, looking in) and cam_bore (inside, on the floor's centre line).
import { TUNNEL, corridorBox, maxRiseOf, surfaceCover, tunnel, tunnelLand } from './tunnelGeom.mjs';
import { VOXEL_CLASSES, classAt as volumeClassAt } from '../region/volume.mjs';

/** The flat variant's ridge: its height over the ground, its slope run, its width across (x) and the sand band. */
export const RIDGE = Object.freeze({ height: 12, across: 57, band: 24, bandThick: 2 });

/** Per region (the program's `r`): the section's land for the links stage. */
const STATE = new WeakMap();

const classOfVolume = (v, x, y, z) => VOXEL_CLASSES[volumeClassAt(v, x, y, z)];

/** The tunnel section (see the header). */
export function tunnelSection(ctx, r, { rect, variant, base }) {
  const { survey: S, claim } = ctx;
  if (variant !== 'flat' && variant !== 'hill') return { nodes: {}, edges: [], input: null, note: null };
  const [x0, z0, x1, z1] = rect;
  const width = 3, height = 3;
  const written = [];
  let a, b, note, narrow = null;
  if (variant === 'flat') {
    // the ridge along z, centred in the section; its slope and plateau raised in `ground`
    const W = x1 - x0 + 1;
    if (W < RIDGE.across + 2 * 24) return { nodes: {}, edges: [], input: null, note: `tunnels: the section is ${W} wide (at least ${RIDGE.across + 48})` };
    const rx0 = x0 + Math.floor((W - RIDGE.across) / 2), rx1 = rx0 + RIDGE.across - 1;
    const rz0 = z0 + 8, rz1 = z1 - 8;
    // (its ends along z slope too: no cliff to fall from at the ridge's ends, M8)
    const hOf = (x, z = (rz0 + rz1) >> 1) => Math.max(0, Math.min(RIDGE.height, x - rx0 + 1, rx1 - x + 1, z - rz0 + 1, rz1 - z + 1));
    const cz = (rz0 + rz1) >> 1;
    const part = r.part('t_ridge', { stage: 'ground' });
    const mats = [r.material('minecraft:grass_block[snowy=false]', 'ridge'), r.material('minecraft:dirt', 'ridge'), r.material('minecraft:stone', 'ridge'), r.material('minecraft:sand', 'ridge band')];
    const g0 = S.groundAt(rx0, cz);
    const floorY = g0, roof = floorY + height + 1;
    const bx0 = ((rx0 + rx1) >> 1) - (RIDGE.band >> 1), bx1 = bx0 + RIDGE.band - 1;
    const cols = [];
    for (let z = rz0; z <= rz1; z++) for (let x = rx0; x <= rx1; x++) {
      const h = hOf(x, z);
      if (!h) continue;
      base.values[(x - base.minX) + (z - base.minZ) * base.width] += h;
      const g = S.groundAt(x, z), top = g + h;
      // stone to 4 under the top, dirt to 1 under it, grass on top; the sand band (over the roof's middle) inside the stone
      const inBand = x >= bx0 && x <= bx1 && z >= cz - 6 && z <= cz + 6;
      for (let y = g + 1; y <= top; y++) {
        const m = y === top ? 0 : y >= top - 3 ? 1 : inBand && y >= roof && y < roof + RIDGE.bandThick ? 3 : 2;
        cols.push(x, z, y, y, m);
      }
    }
    part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: mats, cond: 2, walk: false });
    (r.meta.parts.t_ridge ??= {}).kind = 'add';
    // the ridge's cells by class for the tunnel's land (stone ROCK, dirt and grass SOIL, the band LOOSE)
    written.push({ box: [rx0, -2048, rz0, rx1, 4096, rz1], class: 'ROCK' });
    written.push(...soilBoxes(S, rx0, rx1, rz0, rz1, hOf));
    written.push({ box: [bx0, roof, cz - 6, bx1, roof + RIDGE.bandThick - 1, cz + 6], class: 'LOOSE' });
    a = [rx0 - 1, g0, cz];
    b = [rx1 + 1, S.groundAt(rx1 + 1, cz), cz];
    // a second bore, 1 wide (villagers walk 1-wide corridors: the hard bar's narrow case), 20 to the south
    narrow = { a: [rx0 - 1, S.groundAt(rx0 - 1, cz + 20), cz + 20], b: [rx1 + 1, S.groundAt(rx1 + 1, cz + 20), cz + 20] };
    note = `tunnels: a ridge ${RIDGE.height} high and ${RIDGE.across} across raised in ground, a sand band over the roof`;
  } else {
    const pick = pickLine(S, rect, width, height);
    if (!pick) return { nodes: {}, edges: [], input: null, note: 'tunnels: no east-west line through the hill with a surface bore of 32 to 60 cells' };
    a = pick.a; b = pick.b;
    note = `tunnels: the hill's line at z ${a[2]}, ${pick.L} floor cells, a surface bore of ${pick.run}`;
  }
  // the corridor (§6): asked as a frozen volume (the two-plan flow); without it the section routes nothing (its first plan)
  const far = narrow ? narrow.b : b;
  const { box } = corridorBox([a[0], a[1] + 1, a[2]], [far[0], far[1] + 1, far[2]], { approach: 4, width, groundMax: (gx0, gz0, gx1, gz1) => {
    let m = -32768;
    for (let z = Math.max(claim.minZ, gz0); z <= Math.min(claim.maxZ, gz1); z++) for (let x = Math.max(claim.minX, gx0); x <= Math.min(claim.maxX, gx1); x++) m = Math.max(m, S.groundAt(x, z) + baseAt(base, x, z));
    return m;
  }, minY: claim.minY, maxY: claim.maxY });
  const vol = r.needVolume(box);
  STATE.set(r, { S, base, written, volumes: vol ? [vol] : [], width, height, variant });
  if (!vol) return { nodes: {}, edges: [], input: null, note: `${note}; its corridor asked as a frozen volume (the second plan reads it)` };
  const nodes = { t_w: { at: [a[0], a[1] + 1, a[2]], kind: 'junction' }, t_e: { at: [b[0], b[1] + 1, b[2]], kind: 'junction' } };
  const edges = [{ id: 'bore', from: 't_w', to: 't_e', width, movers: ['player', 'villager'], spans: ['tunnel'], once: 'tunnel', approach: 4, t3: { tunnel: { part: 'demo_tunnel', width, height } } }];
  if (narrow) {
    nodes.n_w = { at: [narrow.a[0], narrow.a[1] + 1, narrow.a[2]], kind: 'junction' };
    nodes.n_e = { at: [narrow.b[0], narrow.b[1] + 1, narrow.b[2]], kind: 'junction' };
    edges.push({ id: 'bore_narrow', from: 'n_w', to: 'n_e', width: 1, movers: ['player', 'villager'], spans: ['tunnel'], once: 'tunnel', approach: 4, t3: { tunnel: { part: 'demo_tunnel_narrow', width: 1, height } } });
  }
  // cameras: outside the west portal looking east, and in the bore
  r.anchor('cam_portal', [a[0] - 10, a[1] + 4, a[2] + 3]);
  r.anchor('cam_bore', [a[0] + 14, a[1] + 2, a[2]]);
  return { nodes, edges, input: { volumes: [vol], written }, note };
}

/** The dirt and grass over the ridge's stone (SOIL), as boxes per column run along z (the ridge is uniform along z). */
function soilBoxes(S, rx0, rx1, rz0, rz1, hOf) {
  const out = [];
  for (let z = rz0; z <= rz1; z++) for (let x = rx0; x <= rx1; x++) {
    const h = hOf(x, z);
    if (!h) continue;
    const g = S.groundAt(x, z);
    out.push({ box: [x, g + h - 3, z, x, g + h, z], class: 'SOIL' });
  }
  return out;
}

const baseAt = (base, x, z) => {
  const i = x - base.minX, j = z - base.minZ;
  return i >= 0 && j >= 0 && i < base.width && j < base.depth ? base.values[i + j * base.width] : 0;
};

/**
 * The hill variant's line: over every z of the rect (8 in from its edges), the east-west window [xa, xb] whose ends stand on the
 * lowest ground around and whose surface bore (§6's survey test, a level-ish floor from xa to xb) is longest, 32 to 60 floor cells.
 * Deterministic: ties by the shorter L, then the lower z, then x.
 */
export function pickLine(S, [x0, z0, x1, z1], width, height) {
  let best = null;
  for (let z = z0 + 8; z <= z1 - 8; z++) for (let xa = x0 + 4; xa <= x1 - 36; xa++) for (let L = 32; L <= 60; L++) {
    const xb = xa + L + 1;
    if (xb > x1 - 4) break;
    const ya = S.groundAt(xa, z), yb = S.groundAt(xb, z);
    if (Math.abs(yb - ya) > maxRiseOf(L)) continue;
    if (S.waterAt(xa, z) || S.waterAt(xb, z)) continue;
    const sc = surfaceCover((x, zz) => S.groundAt(x, zz), [xa, ya, z], [1, 0], L, yb - ya, width, height);
    if (sc.run < 32 || sc.bore[1] || sc.bore[L]) continue; // the bore starts and ends inside the line: cut approaches at both ends
    const key = [-sc.run, L, z, xa];
    if (!best || cmpKey(key, best.key) < 0) best = { key, a: [xa, ya, z], b: [xb, yb, z], L, run: sc.run };
  }
  return best;
}

/** The tunnels the route pass found, emitted (each bore written by `tunnel`, in the links stage): the records. */
export function emitDemoTunnels(r, { stage }) {
  const st = STATE.get(r);
  if (!st) return [];
  const out = [];
  const land = tunnelLand(r.ctx.survey, { volumes: st.volumes, base: st.base, written: st.written, classOfVolume });
  for (const e of r.meta.route?.edges ?? []) {
    if (!e.ok) continue;
    (e.segments ?? []).forEach((g, si) => {
      if (g.kind !== 'tunnel') return;
      const a = e.path[g.from], b = e.path[g.to];
      const v = st.volumes[0];
      const rec = tunnel(r, a, b, { land, width: e.width ?? st.width, height: st.height, stage, liningStage: 'routes', part: 'links_tunnels', id: `tunnel_${e.id}_${si}`.slice(0, 48), movers: e.movers,
        ...(v ? { volume: { sha: v.sha, box: [v.box.minX, v.box.minY, v.box.minZ, v.box.maxX, v.box.maxY, v.box.maxZ] } } : {}) });
      out.push({ edge: e.id, ...rec });
    });
  }
  r.meta.crossings = { ...(r.meta.crossings ?? {}), tunnels: out.map((t) => ({ id: t.id, length: t.length, from: t.from, to: t.to, carved: t.carved, lined: t.lined })) };
  return out;
}

const cmpKey = (p, q) => { for (let t = 0; t < p.length; t++) if (p[t] !== q[t]) return p[t] - q[t]; return 0; };
void TUNNEL;
