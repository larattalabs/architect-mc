// terraced_monastery (6c S3, docs/CONTRACT.md "Phase 6c slice S3: the mountainside monastery v1, terraced, goes green" §4): S3's
// bundled program (not a catalogue program). A fixed plan/0 (`monasteryPlan`, the same plan the s3-plan gate sends through
// Regions.checkPlan) compiled by the plan compile, the code path Steward's plans take: a districts zone whose three districts are
// terraced (the `terraces` member: each lot on its own level, routes between the entrances), at the claim's three level bands (the gate
// low, the gardens mid, the cloister high), the gardens' fountain (H; KC: the gardens and their paths keep clear of it), 1-3 rock
// spires (F1, preset pinnacle) on the shoulders, the relief around the districts (T1, blend), a path from the gardens to the fountain
// and a player-only path (ladders allowed) from the cloister to a lookout on the highest shoulder. Then the program-only steps the
// catalogue doesn't offer: F2 scatter (cherry and spruce stumps, boulders, moss where HY's `wet` field is high, snow layers where
// M17 allows; no stamps, N-F2-1) and W's light cover in soul lanterns, each lamp's reach planned 2 under its light (S2's fix), a post
// on a natural snow layer sunk into it.
//
// The spring (CONTRACT S3 §0, §4): S3's surface spring stream, x 3664-3672, z -980..-965, is kept. The re-pinned survey (after the 90 s
// settle) holds its water, so lots, routes and the relief keep off it as off any water; the plan also names its columns (with a
// buffer of 3) a protected area, and the program checks the draft world: a written cell over those columns fails the plan
// (`_unsafe.springBuried`: a fill over them, the broken variant the check catches).
//
// Two-plan flow: the fountain's body asks for its volume (H), as every plan with a body; the mod plans again with it.
import { region } from '../lib/region/program.mjs';
import { runCheck } from '../lib/plan/compile.mjs';
import { scatter } from '../lib/region/scatterPlan.mjs';
import { lightCover } from '../lib/region/light.mjs';
import { fixtureFor } from '../lib/region/fixtures.mjs';
import { lampSpots } from '../lib/region/passes/route.mjs';
import { levelBands } from '../lib/region/passes/districts.mjs';
import { draftIR } from '../lib/region/plan.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { walkKinds } from '../lib/realise.mjs';
import { walkGraph } from '../lib/region/check.mjs';
import { classAt, VC } from '../lib/region/volume.mjs';

export const id = 'terraced_monastery';
export const description = 'S3\'s monastery: three terraced districts down the mountainside, a garden fountain, spires and a lookout (6c S3).';
export const catalogue = false;
export const passes = ['relief', 'route', 'districts', 'hydrology'];
/** The monastery's look when no bible is given (S3's fixture bible "mountain monastery" wins). */
export const roles = { surface: 'minecraft:grass_block', path: 'minecraft:stone_bricks', foundation: 'minecraft:stone_bricks', structure: 'minecraft:stone_bricks', light: 'minecraft:soul_lantern', rail: 'minecraft:spruce_fence', frame: 'minecraft:spruce_log', rubble: 'minecraft:cobblestone', rock: 'minecraft:stone' };

export const params = {
  rise: { type: 'int', min: 2, max: 6, default: 3, label: 'Terrace rise' },
  retain: { type: 'enum', options: ['wall', 'blend'], default: 'wall', label: 'Rims over 2' },
  gradePct: { type: 'int', min: 5, max: 25, default: 20, label: 'Route grade limit (%)' },
  fountain: { type: 'bool', default: true, label: 'The gardens fountain' },
  spires: { type: 'int', min: 0, max: 3, default: 2, label: 'Rock spires' },
  scatter: { type: 'bool', default: true, label: 'Ground scatter' },
  scatterPct: { type: 'int', min: 5, max: 90, default: 30, label: 'Scatter density (%)' },
  // (the gate's broken variant: a fill over the spring's columns, which the program's own check catches)
  unsafe: { type: 'enum', options: ['none', 'spring_buried'], default: 'none', omitDefault: true, label: 'Broken variant (gate)' },
};

/** S3's spring stream (CONTRACT S3 §0): its columns, and the protected rect (its columns with a buffer of 3) no writer may touch. */
export const SPRING = Object.freeze({ cols: [3664, -980, 3672, -965], rect: [3661, -983, 3675, -962] });

/** The monastery's lots by district: [id, type, along the front, deep, extra]. Sizes fit the S3 entries (scenarios/s3_monastery.json). */
export const LOTS = Object.freeze({
  gate: [['gatehouse', 'gatehouse', 11, 10, { landmark: true, villager: 'none' }], ['guest_house', 'guest_house', 11, 10, { villager: 'dwelling' }], ['stable', 'stable', 11, 12, { villager: 'job' }]],
  gardens: [['infirmary', 'infirmary', 11, 10, { landmark: true, villager: 'job' }], ['herb_garden', 'herb_garden', 9, 9, { villager: 'none' }], ['orchard', 'orchard', 9, 9, { villager: 'none' }]],
  cloister: [['church', 'church', 16, 12, { landmark: true, villager: 'job' }], ['cloister_range', 'cloister_range', 14, 12, { villager: 'none' }], ['refectory', 'refectory', 13, 11, { villager: 'job' }],
    ['cell_1', 'cell', 9, 9, { villager: 'dwelling' }], ['cell_2', 'cell', 9, 9, { villager: 'dwelling' }], ['cell_3', 'cell', 9, 9, { villager: 'dwelling' }], ['cell_4', 'cell', 9, 9, { villager: 'dwelling' }]],
});
const lotsOf = (k) => LOTS[k].map(([lid, type, w, d, extra]) => ({ id: lid, type, size: [w, d], ...extra }));

/**
 * The anchors the plan names, from the survey (`S`: the plan survey's api over `claim`): the fountain's site (the flattest 9x9 dry
 * window in the mid level band, nearest that band's centroid), the spires' shoulders (the steepest 16-cell windows of the high band,
 * 40 apart), the lookout (the highest dry ground) and the claim's centre (the plan's `stone`). Deterministic (scan order on ties).
 */
export function monasteryAnchors(claim, S, { spires = 2, keepOut = [] } = {}) {
  const bands = levelBands(S.columns, claim);
  const inKeep = (x, z, g = 0) => keepOut.some((q) => x >= q[0] - g && x <= q[2] + g && z >= q[1] - g && z <= q[3] + g);
  const cx = (claim.minX + claim.maxX) >> 1, cz = (claim.minZ + claim.maxZ) >> 1;
  const anchors = { stone: [cx, S.groundAt(cx, cz) + 1, cz] };
  // the mid band's centroid
  let mx = 0, mz = 0, mn = 0;
  for (let z = claim.minZ; z <= claim.maxZ; z += 2) for (let x = claim.minX; x <= claim.maxX; x += 2) { const g = S.groundAt(x, z); if (!S.waterAt(x, z) && g > bands.t1 && g <= bands.t2) { mx += x; mz += z; mn++; } }
  const mc = mn ? [Math.round(mx / mn), Math.round(mz / mn)] : [cx, cz];
  let fb = null;
  for (let z = claim.minZ + 12; z <= claim.maxZ - 12; z += 2) for (let x = claim.minX + 12; x <= claim.maxX - 12; x += 2) {
    if (inKeep(x, z, 8)) continue;
    const st = S.stats(x - 4, z - 4, x + 4, z + 4);
    if (st.water || st.median <= bands.t1 || st.median > bands.t2) continue;
    const key = (st.maxGround - st.minGround) * 1000 + Math.abs(x - mc[0]) + Math.abs(z - mc[1]);
    if (!fb || key < fb.key) fb = { key, x, z, y: st.median };
  }
  if (fb) anchors.fountain_at = [fb.x, fb.y + 1, fb.z];
  // the shoulders: the high band's steepest windows (ground range over 16 cells), 40 apart
  const sh = [];
  for (let z = claim.minZ + 16; z <= claim.maxZ - 16; z += 8) for (let x = claim.minX + 16; x <= claim.maxX - 16; x += 8) {
    if (inKeep(x, z, 12)) continue;
    const st = S.stats(x - 8, z - 8, x + 8, z + 8);
    if (st.water || st.median <= bands.t2) continue;
    sh.push({ x, z, y: st.median, steep: st.maxGround - st.minGround });
  }
  sh.sort((a, b) => b.steep - a.steep || a.z - b.z || a.x - b.x);
  const picked = [];
  for (const s of sh) { if (picked.length >= spires) break; if (picked.some((p) => Math.max(Math.abs(p.x - s.x), Math.abs(p.z - s.z)) < 40)) continue; picked.push(s); }
  picked.forEach((s, k) => { anchors[`shoulder_${k + 1}`] = [s.x, s.y + 1, s.z]; });
  // the lookout: the highest dry ground (4 in from the claim's edge)
  let top = null;
  for (let z = claim.minZ + 4; z <= claim.maxZ - 4; z++) for (let x = claim.minX + 4; x <= claim.maxX - 4; x++) {
    if (S.waterAt(x, z) || inKeep(x, z, 4)) continue;
    const g = S.groundAt(x, z);
    if (!top || g > top.y) top = { x, z, y: g };
  }
  if (top) anchors.lookout = [top.x, top.y + 1, top.z];
  return { anchors, bands, fountainSite: fb, shoulders: picked, lookout: top };
}

/**
 * The monastery's plan/0 (the s3-plan gate sends exactly this through Regions.checkPlan): `{plan, anchors, protected}` for a claim
 * and its plan survey. `P`: the program's params (rise, retain, gradePct, fountain, spires).
 */
export function monasteryPlan(claim, S, P = {}) {
  const rise = P.rise ?? 3, retain = P.retain ?? 'wall', grade = (P.gradePct ?? 20) / 100, spires = P.spires ?? 2, fountain = P.fountain ?? true;
  const onClaim = SPRING.rect[0] <= claim.maxX && SPRING.rect[2] >= claim.minX && SPRING.rect[1] <= claim.maxZ && SPRING.rect[3] >= claim.minZ;
  const protectedAreas = onClaim ? [{ id: 's3_spring', rect: [...SPRING.rect] }] : [];
  const A = monasteryAnchors(claim, S, { spires, keepOut: protectedAreas.map((a) => a.rect) });
  const T = { rise, retain, stairs: true };
  const zones = [{
    id: 'monastery', label: 'the mountainside monastery', purpose: 'temple', tolerance: { grade: { max: grade }, count: { max: 4, hard: false } },
    program: { districts: [
      { id: 'gate', label: 'the gate', size: { w: 48, d: 48 }, levelBand: 'low', terraces: T, lots: lotsOf('gate') },
      { id: 'gardens', label: 'the gardens', size: { w: 52, d: 52 }, levelBand: 'mid', terraces: T, lots: lotsOf('gardens') },
      { id: 'cloister', label: 'the cloister', size: { w: 64, d: 64 }, levelBand: 'high', terraces: T, lots: lotsOf('cloister') },
    ] },
  }];
  const forms = [];
  if (fountain && A.anchors.fountain_at) forms.push({ id: 'fountain', kind: 'fountain', label: 'the gardens fountain', basin: 5, spout: 2, where: { near: { anchor: 'fountain_at', within: 12 } } });
  forms.push(...zones.length ? [] : []);
  for (let k = 1; k <= spires; k++) if (A.anchors[`shoulder_${k}`]) forms.push({ id: `spire_${k}`, kind: 'rock_spire', preset: 'pinnacle', where: { near: { anchor: `shoulder_${k}`, within: 24 } }, required: false });
  forms.push({ id: 'relief', kind: 'relief', around: ['monastery'], radius: 6 });
  const connectors = [];
  if (A.anchors.lookout) connectors.push({ id: 'lookout_path', kind: 'path', width: 1, movers: ['player'], from: { part: 'monastery', port: 'cloister' }, to: { anchor: 'lookout' }, required: false });
  // the plan order: the fountain and the spires first (the districts are placed around them; KC: the later part moves), the zone,
  // the relief, the paths
  const order = [...forms.filter((f) => f.kind !== 'relief')];
  const plan = { schemaVersion: 'plan/0', planId: 's3_monastery', zones, forms: [...order, ...forms.filter((f) => f.kind === 'relief')], connectors };
  // (zones before forms in the plan's own order would put the districts first: plan/0 resolves in its parts' listed order within a family
  // and zones, forms, connectors as the compiler orders them; the order the compiler takes is recorded in meta.planCheck.order)
  return { plan, anchors: A.anchors, protected: protectedAreas, info: A };
}

/** The plan so far as a format-2 draft with its seed (scatterPlan's draft world: the scatter places as it will) and its virtual world. */
function draftWorld(r, ctx) {
  const { ir, blobs } = draftIR(r);
  ir.seed = ctx.seed;
  if (Array.isArray(ctx.keepOut)) ir.keepOut = ctx.keepOut;
  const kinds = walkKinds(ir);
  if (kinds.length) { ir.format = 2; ir.requires = kinds; }
  const vols = (ctx.volumes ?? []).filter((v) => Object.values(r.volumesUsed).some((u) => u.sha === v.sha)).map((v) => v.decoded).filter(Boolean);
  return { ir, vw: buildVirtual({ ir, survey: ctx.survey.columns, blobs, volumes: vols }).vw };
}

/**
 * The brink rails (M8 on a mountainside): on the draft world, every walk cell (reached from the entrance, over a written floor) beside
 * a drop of more than 3 that nothing guards (the checker's M8 rule) gets a rail in its own feet cell, unless its floor is a route's
 * (the route guard holds those), a lot's entrance or within 1 of one; the cell inward then stands beside the rail. Twice (a rail
 * moves the brink in by one). Returns the rails placed.
 */
function brinkRails(r, ctx, { stage, rounds = 5 }) {
  const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const routeParts = new Set(Object.entries(r.meta.parts).filter(([, m]) => m.kind === 'path').map(([k]) => k));
  const ents = Object.values(r.meta.lots).map((l) => l.entrance);
  const nearEntrance = (x, z) => ents.some((e) => Math.abs(e[0] - x) <= 1 && Math.abs(e[2] - z) <= 1);
  const placed = new Set();
  let total = 0, nPar = 0, lanterns = 0;
  for (let round = 0; round < rounds; round++) {
    const { ir, vw } = draftWorld(r, ctx);
    const P = vw.pal;
    const start = ir.anchors.entrance;
    if (!start) break;
    const g = walkGraph(vw, [start]);
    const drop = (x, y, z) => { for (let d = 1; d <= 4; d++) { const st = vw.get(x, y - d, z); if (!P.passable[st] || P.water[st]) return d - 1; } return 99; };
    const cols = [], wall = [], lit = [];
    for (let i = 0; i < g.reached.length; i += 3) {
      const x = g.reached[i], y = g.reached[i + 1], z = g.reached[i + 2];
      if (!(vw.flags(x, y - 1, z) & 1)) continue; // F_WRITTEN
      const floorPart = ir.parts[vw.partAt(x, y - 1, z)]?.id;
      if (nearEntrance(x, z) || placed.has(`${x},${y},${z}`)) continue;
      let open = false;
      const onRoute = routeParts.has(floorPart);
      for (const [dx, dz] of D4) {
        const nx = x + dx, nz = z + dz;
        if (vw.lotAt(nx, y, nz)) continue;
        if (!(P.passable[vw.get(nx, y, nz)] && drop(nx, y, nz) > 3 && !g.standAt(nx, y + 1, nz))) continue;
        if (onRoute) {
          // a route's walk keeps its width: the parapet stands in the drop beside it (from the land there up to the walk's surface) with
          // the rail on it
          if (placed.has(`${nx},${nz}`)) continue;
          let top = y - 1;
          while (top > y - 64 && P.passable[vw.get(nx, top, nz)]) top--;
          placed.add(`${nx},${nz}`);
          wall.push(nx, nz, top + 1, y - 1, 0);
          cols.push(nx, nz, y, y, 0);
          // every 4th parapet carries a lantern on its rail (a route along a drop has no ground beside it for a lamp post)
          if (nPar++ % 4 === 0) lit.push(nx, nz, y + 1, y + 1, 0);
        } else open = true;
      }
      if (onRoute) continue;
      // (the feet cell may hold a scatter item or a plant: the rail takes its place)
      if (!open || !P.passable[vw.get(x, y, z)]) continue;
      placed.add(`${x},${y},${z}`);
      cols.push(x, z, y, y, 0);
    }
    if (!cols.length && !wall.length) break;
    const part = r.parts.find((q) => q.id === 'mon_brink') ?? r.part('mon_brink', { stage });
    (r.meta.parts['mon_brink'] ??= {}).kind = 'rails';
    if (wall.length) part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: wall, materials: [r.material('structure', 'brink parapet')], cond: 2, walk: false });
    if (cols.length) part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols, materials: [r.material('rail', 'brink rail')], cond: 3, walk: false });
    if (lit.length) part._push({ op: 'columns', from: { abs: 0 }, to: { abs: 0 }, cols: lit, materials: [r.material('light', 'brink lantern')], cond: 2, walk: false });
    lanterns += lit.length / 5;
    total += cols.length / 5;
  }
  return { rails: total, lanterns };
}

export default function terracedMonastery(ctx) {
  const P = ctx.params;
  const { claim, survey: S } = ctx;
  const { plan, anchors, protected: prot, info } = monasteryPlan(claim, S, P);
  const { region: r, record } = runCheck(ctx, { plan, anchors, protected: prot, regions: [], builds: [], standing: [], budget: {}, bible: null, fingerprint: null }, { makeRegion: () => region(ctx) });
  r.meta.planCheck = record;
  const bad = record.answers.filter((a) => !['fits', 'adjusted'].includes(a.class));
  if (bad.length) r.note(`terraced_monastery: ${bad.map((a) => `${a.part} ${a.class} ${a.reasons?.[0]?.code ?? ''}`).join('; ')}`);
  const mon = record.answers.find((a) => a.part === 'monastery');
  const info2 = { anchors, bands: info.bands, answers: record.answers.map((a) => ({ part: a.part, class: a.class, reason: a.reasons?.[0]?.code ?? null, notes: a.notes ?? [] })), districts: mon?.geometry?.districts ?? null, terraces: mon?.geometry?.terraces ?? null };
  const keepOut = prot.map((a) => a.rect);
  const stages = r.stageList;
  const decor = stages.includes('props') ? 'props' : stages[stages.length - 1] === 'fluids' ? stages[stages.length - 2] : stages[stages.length - 1];

  // ---- (the broken variant) a fill over the spring's columns
  if (P.unsafe === 'spring_buried') {
    const [x0, z0, x1, z1] = SPRING.cols;
    r.part('unsafe_spring_fill', { stage: stages[0] })._shapeOp({ kind: 'box', min: [x0, { floor: 1 }, z0], max: [x1, { height: 1 }, z1] }, r.material('subsurface', 'unsafe fill'), 0);
  }

  // ---- HY's wet field (a read of the survey: no water written), for the moss
  const hy = r.hydrology ? null : r.pass('hydrology', { planWater: false });
  void hy;
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;

  // ---- F2 scatter: boulders, cherry and spruce stumps, moss where wet, snow layers (the op keeps them off walk and written cells and
  // off what a planned light melts); none on the spring's protected columns
  if (P.scatter) {
    const free = new Uint8Array(W * D);
    for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
      if (keepOut.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3])) continue;
      let ok = true;
      for (let dz = -2; dz <= 2 && ok; dz++) for (let dx = -2; dx <= 2; dx++) if (S.waterAt(x + dx, z + dz)) { ok = false; break; }
      free[(x - claim.minX) + (z - claim.minZ) * W] = ok ? 1 : 0;
    }
    r.field('mon_free', { type: 'u8', minX: claim.minX, minZ: claim.minZ, width: W, depth: D, res: 1, values: free });
    const res = scatter(r, 'mon_scatter', {
      grid: 7, jitter: 2, density: { path: [2, 6], p: P.scatterPct / 100 }, mask: { field: 'mon_free', gte: 1 },
      items: [{ w: 3, item: 'boulder', maxRadius: 2, mix: [[6, 'rock'], [3, 'rubble']] }, { w: 2, item: 'stump', log: 'frame' }, { w: 2, item: 'moss_carpet' }, { w: 3, item: 'snow_layer' }],
    }, { stage: decor });
    info2.scatter = { placements: res?.placements ?? null };
  }

  // ---- the brink rails (M8): the walk's written floors beside a drop over 3 (the relief's band at a cliff, a spire's foot)
  info2.brinkRails = brinkRails(r, ctx, { stage: decor });

  // ---- W's light cover: soul lanterns on the rail, each lamp's reach planned 2 under its light (S2's fix); candidates around every
  // lot (rings 2-4), along the routes (every 2 cells) and on the open land near the walk
  const fixture = fixtureFor('minecraft:soul_lantern', r.material('rail', 'lamp post'));
  const extra = [], extraCap = {};
  for (const e of r.meta.route?.edges ?? []) { const l = lampSpots(e, { every: 2 }); extra.push(...l.spots); if (l.spots.length) extraCap[`route:${e.id}`] = 16 * l.cap; }
  for (const l of r.lots) {
    const b = l.box, key = `ring:${l.id}`;
    for (let x = b.minX - 4; x <= b.maxX + 4; x++) for (let z = b.minZ - 4; z <= b.maxZ + 4; z++) if (Math.max(b.minX - x, x - b.maxX, b.minZ - z, z - b.maxZ) >= 2) extra.push({ lot: key, x, z });
    extraCap[key] = 6;
  }
  // and the open land near the walk (the relief's band, boulder tops and the bodies' surrounds are written floors a mob spawns on): a
  // 4-cell grid over the districts' rects grown by 12, last
  for (const d of Object.values(info2.districts ?? {})) {
    const [a0, b0, a1, b1] = d.rect;
    for (let z = Math.max(claim.minZ + 2, b0 - 12); z <= Math.min(claim.maxZ - 2, b1 + 12); z += 4) for (let x = Math.max(claim.minX + 2, a0 - 12); x <= Math.min(claim.maxX - 2, a1 + 12); x += 4) extra.push({ lot: 'field', x, z });
  }
  extraCap.field = 320;
  // and around the forms (a spire's ledges and foot are written floors) and beside every route (2 to 4 out of its path, every 3 cells)
  for (const f of r.forms) {
    const b = f.bounds, key = `form:${f.id}`;
    if (!b) continue;
    for (let x = b.minX - 4; x <= b.maxX + 4; x += 2) for (let z = b.minZ - 4; z <= b.maxZ + 4; z += 2) extra.push({ lot: key, x, z });
    extraCap[key] = 16;
  }
  // (every route pass's walks: meta.route holds only the last pass, the connectors'; meta.paths holds every run and flight)
  for (const [pid, m] of Object.entries(r.meta.paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const cells = m.cells ?? [];
    if (!cells.length || !(m.route || m.kind === 'stair')) continue;
    const key = `side:${pid}`;
    for (let i = 0; i < cells.length; i += 3) for (const d of [2, 3, 4]) for (const [dx, dz] of [[d, 0], [-d, 0], [0, d], [0, -d]]) extra.push({ lot: key, x: cells[i][0] + dx, z: cells[i][2] + dz });
    extraCap[key] = 2 + (cells.length >> 2);
  }
  const reserved = new Set();
  for (const q of keepOut) for (let x = q[0]; x <= q[2]; x++) for (let z = q[1]; z <= q[3]; z++) reserved.add(`${x},${z}`);
  const cover = lightCover(r, { fixture: { ...fixture, level: fixture.level - 2 }, stage: decor, reserved, keepOut, extra, extraCap, maxPerLot: 40, share: 0.001, part: 'mon_lamps' });
  cover.fixture.level = fixture.level;
  // a post on a natural snow layer (the frozen volume reads SNOW over the survey's ground) goes down into it (S2)
  const vol = (ctx.volumes ?? []).find((v) => v.decoded) ?? null;
  const sunk = new Set();
  if (vol) for (const l of cover.lamps) {
    const [x, y, z] = l.at;
    if (classAt(vol.decoded, x, y - 1, z) === VC.SNOW && y - 1 > S.groundAt(x, z)) { for (const [cx2, , cz2] of l.cells) sunk.add(`${cx2},${cz2}`); l.at = [x, y - 1, z]; }
  }
  if (sunk.size) {
    const lp = r.parts.find((q) => q.id === 'mon_lamps');
    for (const op of lp.ops) for (let i = 0; i < op.cols.length; i += 5) if (sunk.has(`${op.cols[i]},${op.cols[i + 1]}`)) { op.cols[i + 2]--; op.cols[i + 3]--; }
  }
  info2.lamps = { fixture: cover.fixture, count: cover.lamps.length, before: cover.before, after: cover.after, capped: cover.capped, sunk: sunk.size };

  // ---- the spring's columns: nothing of the plan is written there (the program's own check; the broken variant is caught here)
  if (keepOut.length) {
    const { vw, ir: dIr } = draftWorld(r, ctx);
    const draftParts = dIr.parts;
    let n = 0;
    const [x0, z0, x1, z1] = SPRING.cols;
    const by = {};
    vw.eachWritten((x, y, z) => { if (x >= x0 && x <= x1 && z >= z0 && z <= z1) { n++; const pid = draftParts[vw.partAt(x, y, z)]?.id ?? '?'; by[pid] = (by[pid] ?? 0) + 1; } });
    info2.springWritten = n;
    if (n) throw new Error(`SPRING: ${n} cell(s) written over the spring's columns (x ${x0}-${x1}, z ${z0}..${z1}) by ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}: the realise would bury its feeder`);
  }

  // ---- the gallery's cameras: the hub over the districts' bells
  const bells = Object.values(info2.districts ?? {}).map((d) => d.bell).filter(Boolean);
  const hx = bells.length ? Math.round(bells.reduce((a, b) => a + b[0], 0) / bells.length) : (claim.minX + claim.maxX) >> 1;
  const hz = bells.length ? Math.round(bells.reduce((a, b) => a + b[2], 0) / bells.length) : (claim.minZ + claim.maxZ) >> 1;
  r.anchor('hub', [hx, S.groundAt(hx, hz) + 1, hz]);
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const camY = (x, z, up) => Math.min(claim.maxY - 1, S.topAt(cl(x, claim.minX, claim.maxX), cl(z, claim.minZ, claim.maxZ)) + up);
  const cam = (n, x, z, up) => { const X = cl(x, claim.minX, claim.maxX), Z = cl(z, claim.minZ, claim.maxZ); r.anchor(n, [X, camY(X, Z, up), Z]); };
  cam('cam_n', hx, hz - 80, 40); cam('cam_s', hx, hz + 80, 40); cam('cam_e', hx + 80, hz, 40); cam('cam_w', hx - 80, hz, 40);
  cam('cam_high', hx + 8, hz + 8, 100);
  const g0 = bells[0] ?? [hx, 0, hz];
  cam('cam_ground', g0[0] + 6, g0[2] + 6, 3);
  r.meta.monastery = info2;
  return r;
}
