// (7c HR, docs/CONTRACT.md "Phase 7c" §3 row 3, "Slice HR as built") `form.hidden_room {host, size, entrance}`: a room carved behind a
// concealed entrance in its host part. compile.mjs resolves it after its host (`host` is a dependency: schema.mjs refsOf) and emits it
// after the H parts (so a waterfall host stands), placed against the host's own rock as the region holds it then (a local virtual world).
//
// Hosts and their entrances (the first is the default):
//   form.hollow_mountain  a room in the rock off the cavern's wall, through a doorway 1 wide and 2 high in that wall: `wall` (the doorway
//                         walled with the very rock it is cut from: invisible from the cavern) or `bookshelf` (two bookshelves)
//   form.waterfall        the hollow behind the curtain: a room in the face under the header pool, its doorway open behind the falling
//                         water (`waterfall`: the curtain is the concealment, nothing is written there)
//   a lot (a zone's lot)  a cellar under the building's box (two layers of ground left under its floor), reached by a shaft beside the
//                         box on its back side: `trapdoor` (a hatch flush with the ground, a ladder down)
// The room is lit (a shroomlight set into its floor every 6, 6b's cavern rule) and every cell round it is the host's (a shell of 1, a roof
// of ROOF): a room that does not fit at its size is shrunk (a size deviation by its floor's area: adjusted, past the size ceiling refused
// TOLERANCE), down to 3x3 and 2 high; none fits: refused NO_ROOM.
//
// Survival (Noah's rule): the hollow is free (its carve and lights are a terrain kind's writes: the free pass); the entrance (the walled
// doorway, the bookshelves, the hatch and its ladder) is its own construction target, group `<part>:entrance` (finish.mjs counts it in
// the part's cost). A waterfall entrance writes nothing (the curtain is H's), so that room is free whole.
//
// Secrets (S-7c-4, Steward's change 2): the entrance cell and the room's box go to the artifact's `$.secrets[]` only. The answer carries
// no geometry; the room's IR parts are marked `secret` in the plan meta, so the previews, the class map and siteplan.json leave them out
// (the caller's PlanRequest ext `architect_mc:secrets: true` adds the secrets back as data).
import { localWorld } from '../fluids/body.mjs';
import { frameOf } from '../fluids/waterfall.mjs';
import { shapeOf } from '../connectors/style.mjs';
import { F_WRITTEN } from '../region/vworld.mjs';
import { HALL, hallSides, LEDGE } from './hollowMountain.mjs';

export const HOSTS = Object.freeze({
  hollow_mountain: Object.freeze(['wall', 'bookshelf']),
  waterfall: Object.freeze(['waterfall']),
  lot: Object.freeze(['trapdoor']),
});
/** The room presets (inside: across, deep, high), the least side, the roof over it, the light spacing. */
export const ROOM = Object.freeze({ S: [5, 5, 3], M: [7, 7, 3], L: [9, 9, 4], XL: [11, 11, 4], min: 3, minHigh: 2, max: 15, roof: 2, lightEvery: 6 });
const SIDES = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] });
const FACING = (d) => (d[0] === 1 ? 'east' : d[0] === -1 ? 'west' : d[1] === 1 ? 'south' : 'north');
const OPEN = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava']);
const nameOf = (s) => String(s).replace(/\[.*$/, '');
/** Wooden trapdoors a role may give (a role's block with a trapdoor shape; iron's needs redstone, so never). */
const TRAP_ROLES = Object.freeze(['trim', 'frame', 'floor', 'wall_alt', 'wall', 'accent', 'roof', 'structure']);

/** The room's inside [across, deep, high]: its preset, else the larger end of w and d (high by the larger side), else S. */
export function roomSize(part) {
  if (part.size?.preset) return [...ROOM[part.size.preset]];
  if (part.size?.w !== undefined || part.size?.d !== undefined) {
    const one = (v, dflt) => (v === undefined ? dflt : Array.isArray(v) ? v[1] : v);
    const w = one(part.size.w, ROOM.S[0]), d = one(part.size.d, w);
    return [w, d, Math.max(w, d) >= 9 ? 4 : 3];
  }
  return [...ROOM.S];
}

/** The host's kind for a hidden room: hollow_mountain, waterfall, lot, or the plan kind it names (unsupported as a host). */
export function hostKind(V, byId, host) {
  if (typeof host !== 'string' || host.includes('#')) return { kind: 'external' };
  if (byId.has(host)) { const q = byId.get(host); return { kind: q.family === 'form' && HOSTS[q.kind] ? q.kind : q.block, id: host }; }
  if (V.lotZone?.has(host)) return { kind: 'lot', id: host, zone: V.lotZone.get(host) };
  return { kind: 'unknown', id: host };
}

/**
 * Resolve a hidden room (compile step 2; its host already answered): the host supported and the entrance one the host gives. The room
 * is placed at emit. Returns {klass, reasons?, wouldFit?, notes, host, entrance, size}.
 */
export function resolveHidden(C, p) {
  const part = p.part;
  const h = hostKind(C.V, C.byId, part.host);
  const notes = [];
  if (part.params && Object.keys(part.params).length) notes.push(`params ${Object.keys(part.params).sort().join(', ')}: not read (a hidden room's own members are host, size and entrance)`);
  if (h.kind === 'external') return { klass: 'refused', notes, reasons: [{ code: 'NO_FEATURE', message: 'a hidden room in a part outside this plan (a standing building or form) waits: its host is written by this plan (S-7c-8)', evidence: { host: part.host } }] };
  const offered = HOSTS[h.kind];
  if (!offered) return { klass: 'refused', notes, reasons: [{ code: 'NO_FEATURE', message: `a hidden room's host is a form.hollow_mountain, a form.waterfall or a lot of this plan (${part.host} is ${h.kind})`, evidence: { host: part.host, kind: h.kind, hosts: Object.keys(HOSTS) } }] };
  const entrance = part.entrance ?? offered[0];
  if (!offered.includes(entrance)) {
    const fragment = { ...part, entrance: offered[0] };
    return { klass: 'refused', notes, wouldFit: [{ part: p.id, fragment, cost: { cells: 0 } }], reasons: [{ code: 'NO_FEATURE', message: `a ${entrance} entrance is not one a ${h.kind === 'lot' ? 'lot' : `form.${h.kind}`} host gives (${offered.join(', ')})`, evidence: { entrance, host: part.host, entrances: [...offered] } }] };
  }
  return { klass: 'fits', notes, host: h, entrance, size: roomSize(part) };
}

/** A room frame: the doorway's cells, the room's first cell row (s = 0) at `o` going `dir`, lanes along `lat`, its floor y0. */
function roomCells(f, W, D, H) {
  const lo = -((W - 1) >> 1), hi = lo + W - 1;
  const cells = [];
  for (let s = 0; s < D; s++) for (let q = lo; q <= hi; q++) for (let y = f.y0; y < f.y0 + H; y++) cells.push([f.o[0] + f.dir[0] * s + f.lat[0] * q, y, f.o[1] + f.dir[1] * s + f.lat[1] * q]);
  return { cells, lo, hi };
}

/** Whether the room fits at frame `f`: every room cell and every shell cell (1 round, ROOM.roof over) the host's solid, but `open`. */
function fits(solid, f, W, D, H, open) {
  const { lo, hi } = roomCells(f, W, D, H);
  for (let s = -1; s <= D; s++) for (let q = lo - 1; q <= hi + 1; q++) for (let y = f.y0 - 1; y <= f.y0 + H - 1 + ROOM.roof; y++) {
    const x = f.o[0] + f.dir[0] * s + f.lat[0] * q, z = f.o[1] + f.dir[1] * s + f.lat[1] * q;
    if (open.has(`${x},${y},${z}`)) continue;
    if (!solid(x, y, z)) return false;
  }
  return true;
}

/** The sizes to try, largest floor first (then the taller): the asked one, then shrinking deep, across and high, down to ROOM.min and 2 high. */
function sizesFrom([W, D, H]) {
  const out = [];
  for (let w = W; w >= ROOM.min; w--) for (let d = D; d >= ROOM.min; d--) for (let h = H; h >= ROOM.minHigh; h--) out.push([w, d, h]);
  return out.sort((a, b) => b[0] * b[1] - a[0] * a[1] || b[1] - a[1] || b[2] - a[2]);
}

/**
 * The host's candidate frames, in preference order: {o: [x, z], y0, dir, lat, door: [[x, y, z], ...] (the entrance's cells, solid now),
 * open: extra cells allowed open (a shaft), hatch?}. K: {env, r, res, f (this part's resolution)}.
 */
function framesOf(K, p, f) {
  const h = f.host;
  if (h.kind === 'hollow_mountain') {
    const gen = K.res.get(h.id)?.big?.gen;
    if (!gen) return [];
    const used = new Set([gen.entrance.side, ...gen.halls.filter((x) => !x.skipped).map((x) => x.side)]);
    const cx = Math.floor((gen.params.rect.minX + gen.params.rect.maxX) / 2), cz = Math.floor((gen.params.rect.minZ + gen.params.rect.maxZ) / 2);
    const probe = gen.floorY + LEDGE.rise + 1;
    const out = [];
    for (const side of hallSides(gen.entrance.side)) {
      if (used.has(side)) continue;
      const [sx, sz] = SIDES[side];
      let ox = cx, oz = cz;
      while (gen.void(ox + sx, probe, oz + sz)) { ox += sx; oz += sz; }
      let y0 = gen.floorY;
      while (y0 < probe && !gen.void(ox, y0, oz)) y0++;
      const door = [[ox + sx, y0, oz + sz], [ox + sx, y0 + 1, oz + sz]];
      out.push({ o: [ox + 2 * sx, oz + 2 * sz], y0, dir: [sx, sz], lat: [-sz, sx], door, open: door, side });
    }
    // then off a carved hall's side walls at its middle (a mountain whose every free side has a hall), then off its far end
    const half = (HALL.width - 1) / 2;
    for (const hall of gen.halls) {
      if (hall.skipped) continue;
      const [sx, sz] = SIDES[hall.side];
      for (const [lx, lz] of [[-sz, sx], [sz, -sx]]) {
        const [mx, , mz] = hall.mid;
        const door = [[mx + lx * (half + 1), gen.floorY, mz + lz * (half + 1)], [mx + lx * (half + 1), gen.floorY + 1, mz + lz * (half + 1)]];
        out.push({ o: [mx + lx * (half + 2), mz + lz * (half + 2)], y0: gen.floorY, dir: [lx, lz], lat: [-lz, lx], door, open: door, side: `${hall.side} hall's ${FACING([lx, lz])} wall` });
      }
    }
    for (const hall of gen.halls) {
      if (hall.skipped) continue;
      const [sx, sz] = SIDES[hall.side];
      const fx = hall.from[0] + sx * (hall.depth - 1), fz = hall.from[2] + sz * (hall.depth - 1);
      const door = [[fx + sx, gen.floorY, fz + sz], [fx + sx, gen.floorY + 1, fz + sz]];
      out.push({ o: [fx + 2 * sx, fz + 2 * sz], y0: gen.floorY, dir: [sx, sz], lat: [-sz, sx], door, open: door, side: `${hall.side} hall` });
    }
    return out;
  }
  if (h.kind === 'waterfall') {
    const w = K.res.get(h.id);
    if (!w?.site || !w.frame) return [];
    const F = frameOf(w.frame.O, w.frame.facing);
    const c = (w.spec.width - 1) >> 1;
    // (the doorway one over the basin's rim: the pond's shell holds the cell over its surface at row 0)
    const y0 = w.site.Lb + 2;
    const [dx, dz] = F.col(0, c);
    const door = [[dx, y0, dz], [dx, y0 + 1, dz]];
    const o = F.col(-1, c);
    return [{ o, y0, dir: [-F.f[0], -F.f[1]], lat: F.a, door, open: door, side: w.frame.facing }];
  }
  // a lot: the cellar under its box, its shaft beside the box's back edge (then its sides), never in another lot's box
  const lot = K.r.lots.find((l) => l.id === h.id);
  if (!lot) return [];
  const b = lot.box;
  const fr = SIDES[lot.front];
  const out = [];
  for (const back of [[-fr[0], -fr[1]], [fr[1], -fr[0]], [-fr[1], fr[0]]]) {
    const [bx, bz] = back;
    // the shaft column: one past the box's edge on that side, at its middle; the room runs from under it inward
    const mx = (b.minX + b.maxX) >> 1, mz = (b.minZ + b.maxZ) >> 1;
    const sx = bx === 1 ? b.maxX + 1 : bx === -1 ? b.minX - 1 : mx, sz = bz === 1 ? b.maxZ + 1 : bz === -1 ? b.minZ - 1 : mz;
    out.push({ o: [sx, sz], y0: null, top: b.minY - 1 - ROOM.roof, dir: [-bx, -bz], lat: [bz, -bx], hatch: [sx, sz], lot, side: FACING(back) });
  }
  return out;
}

/**
 * Emit a resolved hidden room `p` (its resolution `f`) as form parts `f_<id>` (the hollow) and `f_<id>_door` (the entrance). K: {env,
 * r, ctx, res, stageOf, judge, tolOf, partOf}. Returns {secret, cells, klass, deviations, notes}; throws 'CODE: message' to refuse.
 */
export function emitHidden(K, p, f) {
  const { r } = K;
  const frames = framesOf(K, p, f);
  if (!frames.length) throw new Error(`NO_ROOM: ${f.host.id} gives no place for a hidden room`);
  // the host's rock as the region holds it now (the forms, the H parts and the pads written so far), over a box round every frame
  let box = null;
  const grow = (x, y, z) => { box = box ? { minX: Math.min(box.minX, x), maxX: Math.max(box.maxX, x), minY: Math.min(box.minY, y), maxY: Math.max(box.maxY, y), minZ: Math.min(box.minZ, z), maxZ: Math.max(box.maxZ, z) } : { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z }; };
  const [W0, D0, H0] = f.size;
  const reach = Math.max(W0, D0) + 2;
  for (const fr of frames) {
    const y = fr.y0 ?? fr.top - H0;
    grow(fr.o[0] - reach, y - 2, fr.o[1] - reach); grow(fr.o[0] + reach, (fr.top ?? y + H0) + ROOM.roof + 8, fr.o[1] + reach);
  }
  const lw = localWorld(r, box);
  const P = lw.vw.pal;
  const stateAt = (x, y, z) => P.states[lw.vw.get(x, y, z)];
  const solid = (x, y, z) => !OPEN.has(nameOf(stateAt(x, y, z)));
  const inLot = (x, z) => r.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && z >= l.box.minZ && z <= l.box.maxZ);
  let pick = null;
  for (const size of sizesFrom(f.size)) {
    const [W, D, H] = size;
    for (const fr0 of frames) {
      let fr = fr0;
      if (fr0.hatch) {
        // the lot's frame: the room's top under the floor's two layers, the hatch at the ground's top beside the box (natural ground, not
        // a lot's, not written by the region: no street, path or apron), a shaft from the room up to it
        const [hx, hz] = fr0.hatch;
        if (inLot(hx, hz)) continue;
        let g = fr0.top + H + ROOM.roof + 8;
        while (g > fr0.top && !solid(hx, g, hz)) g--;
        if (g <= fr0.top || (lw.vw.flags(hx, g, hz) & F_WRITTEN)) continue;
        const y0 = fr0.top - H + 1;
        const open = new Set();
        for (let y = y0 + H; y <= g; y++) open.add(`${hx},${y},${hz}`);
        // the shaft's sides the host's (the ladder's wall behind it)
        let ok = true;
        for (let y = y0 + H; y < g && ok; y++) for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!solid(hx + ax, y, hz + az)) { ok = false; break; }
        if (!ok) continue;
        fr = { ...fr0, y0, g, open, door: [[hx, g, hz]] };
      }
      const open = new Set([...(fr.open instanceof Set ? fr.open : (fr.open ?? []).map((c) => c.join(',')))]);
      if (!fr.door.every(([x, y, z]) => solid(x, y, z))) continue;
      if (fits(solid, fr, W, D, H, open)) { pick = { fr, size }; break; }
    }
    if (pick) break;
  }
  if (!pick) throw new Error(`NO_ROOM: no ${ROOM.min}x${ROOM.min} room fits in ${f.host.id}'s rock with a shell of 1 and a roof of ${ROOM.roof} (its ${frames.map((q) => q.side).join(', ')} side${frames.length > 1 ? 's' : ''} tried)${f.host.kind === 'waterfall' ? `: a waterfall holds a room ${ROOM.minHigh} high under its header pool from a drop of ${ROOM.minHigh + 4} (${H0} high: ${H0 + 4})` : ''}`);
  const { fr, size } = pick;
  const [W, D, H] = size;
  const id = `f_${p.id}`.slice(0, 44);
  const stage = K.stageOf('forms');
  // the hollow: the room (and a lot's shaft) carved, ALWAYS_OURS over the host's rock (its own form's cells or the land's); lights set
  // into its floor (shroomlight: free natural); a terrain kind's writes (free in survival)
  const { cells, lo, hi } = roomCells(fr, W, D, H);
  const carve = [];
  const byCol = new Map();
  for (const [x, y, z] of cells) { const k = `${x},${z}`; const c = byCol.get(k) ?? [x, z, y, y]; c[2] = Math.min(c[2], y); c[3] = Math.max(c[3], y); byCol.set(k, c); }
  if (fr.hatch) { const k = `${fr.hatch[0]},${fr.hatch[1]}`; const c = byCol.get(k); c[3] = Math.max(c[3], fr.g - 1); }
  if (f.entrance === 'waterfall') for (const [x, y, z] of fr.door) { const k = `${x},${z}`; const c = byCol.get(k) ?? [x, z, y, y]; c[2] = Math.min(c[2], y); c[3] = Math.max(c[3], y); byCol.set(k, c); }
  for (const c of [...byCol.values()].sort((a, b) => a[1] - b[1] || a[0] - b[0])) carve.push(c[0], c[1], c[2], c[3], 0);
  const lights = [];
  // (the middle of a side of at most lightEvery; else every lightEvery from half of it: no floor cell more than 3 from a light along a side)
  const ls = (n) => { const out = []; for (let k = n <= ROOM.lightEvery ? n >> 1 : ROOM.lightEvery >> 1; k < n; k += ROOM.lightEvery) out.push(k); return out; };
  for (const s of ls(D)) for (const qq of ls(W)) {
    const q = lo + qq;
    if (fr.hatch && s === 0 && q === 0) continue; // (not under the ladder)
    lights.push(fr.o[0] + fr.dir[0] * s + fr.lat[0] * q, fr.o[1] + fr.dir[1] * s + fr.lat[1] * q, fr.y0 - 1, fr.y0 - 1, 1);
  }
  const room = r.part(id, { stage });
  room.columns({ abs: 0 }, { abs: 0 }, carve, [null, 'minecraft:shroomlight'], { cond: 3, terrain: true });
  room.columns({ abs: 0 }, { abs: 0 }, lights, [null, 'minecraft:shroomlight'], { cond: 3, terrain: true });
  const m = (r.meta.parts[room.id] ??= {});
  m.kind = 'carve';
  m.secret = true;
  const rb = cells.reduce((a, [x, y, z]) => [Math.min(a[0], x), Math.min(a[1], y), Math.min(a[2], z), Math.max(a[3], x), Math.max(a[4], y), Math.max(a[5], z)], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  (m.caverns ??= []).push({ floorY: fr.y0, lights: lights.length / 5, every: ROOM.lightEvery, bounds: { minX: rb[0], maxX: rb[3], minZ: rb[2], maxZ: rb[5], minY: rb[1], maxY: rb[4] } });
  // the entrance: its own part (its own survival target, group <part>:entrance)
  let door = null, cell;
  if (f.entrance === 'waterfall') cell = fr.door[0];
  else {
    door = r.part(`${id}_door`.slice(0, 48), { stage });
    if (f.entrance === 'trapdoor') {
      const [hx, hz] = fr.hatch;
      const tb = trapdoorOf(r.roles);
      const face = FACING(fr.dir);
      cell = [hx, fr.g, hz];
      // the ladder up the shaft (on its outer wall, facing in), the hatch over it flush with the ground (top half, shut)
      door.columns({ abs: 0 }, { abs: 0 }, [hx, hz, fr.y0, fr.g - 1, 0, hx, hz, fr.g, fr.g, 1], [`minecraft:ladder[facing=${face}]`, `${tb}[facing=${face},half=top,open=false]`], { cond: 3 });
    } else {
      // the doorway walled with the rock it is cut from (wall), or two bookshelves
      const mats = f.entrance === 'bookshelf' ? ['minecraft:bookshelf'] : [stateAt(...fr.door[0])];
      const cols = [];
      const [x, y, z] = fr.door[0];
      cols.push(x, z, y, y + 1, 0);
      door.columns({ abs: 0 }, { abs: 0 }, cols, mats, { cond: 3 });
      cell = fr.door[0];
      // (S-THEME: the bookshelves are the concealment itself, no role gives them: these two cells only are exempt, the lint reads them here)
      if (f.entrance === 'bookshelf') (r.meta.parts[door.id] ??= {}).entranceCells = [[x, y, z], [x, y + 1, z]];
    }
    const dm = (r.meta.parts[door.id] ??= {});
    dm.kind = 'add';
    dm.secret = true;
  }
  const asked = f.size;
  const lost = Math.round(100 - (100 * W * D) / (asked[0] * asked[1]));
  const devs = lost > 0 ? [{ what: 'size', value: lost, ...K.tolOf(p.part, 'size') }] : [];
  const j = K.judge(devs);
  const notes = [`a ${W}x${D} room ${H} high in ${f.host.id}${f.host.kind === 'lot' ? ' (a cellar under the building)' : ''}, behind a ${f.entrance} entrance: where it is goes to the artifact's secrets only`];
  if (lost > 0 || H < asked[2]) notes.push(`the room is ${W}x${D}, ${H} high (asked ${asked[0]}x${asked[1]}, ${asked[2]} high): the most the host's rock holds with a shell of 1 and a roof of ${ROOM.roof}`);
  return {
    klass: j.klass, deviations: j.deviations, reasons: j.klass === 'refused' ? [{ code: 'TOLERANCE', message: `${j.failed.what} ${j.failed.value} past its limit`, evidence: { what: j.failed.what, value: j.failed.value } }] : [], notes,
    roomPart: room.id, doorPart: door?.id ?? null,
    secret: { part: p.id, host: f.host.id, entrance: { cell: [...cell], kind: f.entrance }, room: rb },
  };
}

/** A wooden trapdoor from the Style's roles (the first role whose block has one), else spruce's. */
export function trapdoorOf(roles) {
  for (const k of TRAP_ROLES) {
    const v = roles?.[k] ? shapeOf(roles[k], 'trapdoor') : null;
    if (v && !/iron_trapdoor/.test(v)) return nameOf(v);
  }
  for (const v0 of Object.values(roles ?? {})) {
    const v = shapeOf(v0, 'trapdoor');
    if (v && !/iron_trapdoor/.test(v)) return nameOf(v);
  }
  return 'minecraft:spruce_trapdoor';
}
