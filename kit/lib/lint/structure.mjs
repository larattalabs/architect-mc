// (fast checks P2, docs/FAST-CHECKS.md "### 2. Structure lint (P2)") The structure lint over one plan's virtual world: the checker
// (region/check.mjs, every M-rule, with the stage prefixes), then the same world with the 4e street lanterns laid as the mod lays them
// (roads.mjs) for the rules a post or its light changes (M2, M5, M6, M8), then the lint's own rules:
//
//   S-KEEP    keep-clear: no written cell (the lanterns included) in a keep-out rect, a protected area, a tracked build's claim box
//             (its door and bed partners included, S-DOOR) or a wall's `around` region; the fluid bodies' sets are M25:clear's
//   S-LOTS    lots off streets: no lot box over a 4e road's walkway, a street/route/path part's written column, or a lane of another lot
//   S-FOOT    a lamp post's foot is never a dirt path the region did not write (lamp-on-path, 52cc9606 / c494ddab): the road lanterns,
//             the apron and square lamps
//   S-LAND    a bridge's deck, a rope bridge's deck, a tunnel's floor and (7a CW) a catwalk's lanes land on their route's walk footprint at both ends (the even
//             width bugs c4f1c8f9, 9ba60b79 passed every checker rule)
//   S-GRAV    the writer's dependents stage never clears a gravity block whose support is solid before and after (sand vanish,
//             70fc0dd0): the tile writer's stage 3 modelled over the virtual world (TileCheck.dependents/keepsGravity)
//   S-FELL    felling stops at protected areas, other builds and the claim (C31, 5cc0d7f1): TileCheck's felling modelled over the
//             frozen volumes' logs (the survey's trunks are columns: no branch reaches anywhere)
//   S-DOOR    a tracked build's claim box holds both halves of every door and bed it cuts (C34, f5204066) and a lifted build's door
//             counts as an entrance from its lowest row (C34b, a0530bc3): over the build records the plan reads (the Java fix is
//             the record; a pre-fix record is the broken variant)
//   S-FARM    a zone that asks for a farm pond with a farm lot (its villager use given or implied by its type) gets a farm pond, and
//             one with no farm lot says so (65d61b0b)
//
// `gate(report, bars)` turns a report into FAIL lines: every error finding, the gated warnings (M2, M2:villager, M3 and its
// sub-rules but overhang, M4, M10*, M2:wall, M8:wall, M6 on a connector), M5 over the walk area at most `bars.m5` (default 1%), and
// every S- rule finding.
//
// `preFix` reproduces a historical bug inside the lint's own models (the reverted-code mutation of a Java-side fix the lint can only
// model): {roads: 'lamp-path', gravity: 'sand-vanish', felling: 'c31'}.
import { checkRegion, blockLight, lotEntrance } from '../region/check.mjs';
import { buildVirtual, F_WRITTEN, F_WALK } from '../region/vworld.mjs';
import { centreCells, crossOffsets, rightOf, segmentAxis } from '../region/geom.mjs';
import { info } from '../blocks.mjs';
import { blockAt } from '../region/volume.mjs';
import { inferVillager } from '../params.mjs';
import { layRoadLanterns } from './roads.mjs';
import { footprintOf } from '../region/passes/route.mjs';

const K = (x, z) => `${x},${z}`;
const inRect = (r, x, z) => x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3];
const inBox = (b, x, y, z) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
const nameOf = (s) => s.replace(/\[.*$/, '');
const propsOf = (s) => (s.includes('[') ? Object.fromEntries(s.slice(s.indexOf('[') + 1, -1).split(',').map((kv) => kv.split('='))) : {});
// ((7a CL) and the climbs' own bars: M10:climb (flights, rungs against a solid face, rest landings, the top gate), M8:climb (rails beside
// a stair's drops), M5:climb (no dark tread, landing or walk cell of a climb))
const GATED = /^(M1|M2|M2:villager|M2:wall|M3|M3:floating_spur|M3:gravity|M3:tunnel|M4|M4:tunnel|M8:wall|M10|M10:bridge|M10:rope|M10:catwalk|M10:climb|M8:climb|M5:climb|M13|M14|M20.*|M25.*|M27:state|M27:convert)$/;

function finding(rule, count, sample, message, part = null) {
  return { rule, severity: 'error', part, stage: null, count, sample: sample.slice(0, 12), message };
}

/** The world a plan's rules read: the virtual world, the 4e lanterns laid (roads.mjs). */
export function lintWorld(c, { preFix = {}, protect = null } = {}) {
  const { vw } = buildVirtual({ ir: c.ir, survey: c.survey, blobs: c.blobs, volumes: c.volumes ?? [] });
  // (a historical fixture's volume names its blocks, a dirt path or a log, which the voxel classes can't: the lint reads them)
  if (c.blockBase) {
    const orig = vw.base;
    const vols = (c.volumes ?? []).filter((v) => v.blocks);
    vw.base = (x, y, z) => { for (const v of vols) { const b = blockAt(v, x, y, z); if (b) return vw.pal.of(b); } return orig(x, y, z); };
  }
  const rects = protectRects(c);
  const lant = layRoadLanterns(vw, c.ir, { protect: protect ?? ((x, z) => rects.some((r) => inRect(r, x, z))), preFix: preFix.roads ?? null });
  return { vw, lant };
}

/** Every protected rect a plan honours: its IR keep-out, the owner's protected areas, the builds' boxes ([x0, z0, x1, z1]). */
function protectRects(c) {
  return [...(c.ir.keepOut ?? []), ...(c.protected ?? []).map((a) => a.rect), ...(c.builds ?? []).map((b) => [b.bounds[0], b.bounds[2], b.bounds[3], b.bounds[5]])];
}

/**
 * Lint one plan `c` = {name, ir, meta, survey (bytes), blobs (sha -> bytes), volumes [decoded], protected [{id, rect}], builds
 * [build records], plan (the plan/0 request, for S-FARM), answers (the check's parts, for S-FARM)}. Returns {findings, metrics,
 * world: {vw, lant}, ms}.
 */
import { themeOffenders, knownTheme } from './theme.mjs';
export function structureLint(c, { preFix = {}, rules = null } = {}) {
  const t0 = performance.now();
  const want = (r) => !rules || rules.includes(r);
  const plan = checkRegion({ ir: c.ir, survey: c.survey, blobs: c.blobs, meta: c.meta, volumes: c.volumes ?? [] });
  const W = lintWorld(c, { preFix });
  const { vw, lant } = W;
  const lit = checkRegion({ ir: c.ir, meta: c.meta, world: vw, prefix: false, blobs: c.blobs, volumes: c.volumes ?? [], rules: ['M2', 'M5', 'M6', 'M8'] });
  const LIT = new Set(['M2', 'M5', 'M6', 'M8']);
  const findings = [...plan.findings.filter((f) => !LIT.has(f.rule)), ...lit.findings];
  const metrics = { ...plan.metrics, M2: lit.metrics.M2, M5: lit.metrics.M5, M5plan: plan.metrics.M5, M6: lit.metrics.M6, M8: lit.metrics.M8, lanterns: { posts: lant.posts.length, skipped: lant.skipped } };
  const P = vw.pal;
  // ---- S-KEEP
  if (want('S-KEEP')) {
    const areas = [...(c.ir.keepOut ?? []).map((r) => ({ id: 'keepOut', rect: r })), ...(c.protected ?? []).map((a) => ({ id: `protected ${a.id}`, rect: a.rect }))];
    const boxes = (c.builds ?? []).map((b) => ({ id: `build ${b.id}`, box: claimBox(b) }));
    for (const w of c.meta?.walls ?? []) if (Array.isArray(w.around)) areas.push({ id: `wall ${w.id ?? w.part} around`, rect: w.around });
    const hit = new Map();
    vw.eachWritten((x, y, z) => {
      for (const a of areas) if (inRect(a.rect, x, z)) { const l = hit.get(a.id) ?? []; l.push([x, y, z]); hit.set(a.id, l); }
      for (const b of boxes) if (inBox(b.box, x, y, z)) { const l = hit.get(b.id) ?? []; l.push([x, y, z]); hit.set(b.id, l); }
    });
    for (const [id, l] of hit) findings.push(finding('S-KEEP', l.length, l, `${l.length} written cell(s) inside ${id}`));
  }
  // ---- S-LOTS
  if (want('S-LOTS')) {
    const walk = new Set();
    for (const r of c.ir.roads ?? []) {
      const pts = r.points.map((p) => [p[0], p[2]]);
      const offs = crossOffsets(r.width);
      for (const q of centreCells(pts).cells) { const a = pts[Math.min(q.seg, pts.length - 1)], b = pts[Math.min(q.seg + 1, pts.length - 1)]; const rr = rightOf(segmentAxis(a, b)); for (const k of offs) walk.add(K(q.x + rr[0] * k, q.z + rr[1] * k)); }
    }
    const streetPart = new Set(c.ir.parts.map((p, i) => (/(^|_)(street|square|verges|routes?|path|ways|links)$/.test(p.id) || p.stage === 'routes' ? i : -1)).filter((i) => i >= 0));
    vw.eachWritten((x, y, z, idx, f, part) => { if ((f & F_WALK) && streetPart.has(part)) walk.add(K(x, z)); });
    for (const l of c.ir.lots ?? []) {
      // (a walk that ends at the lot's entrance may reach into the box's front row: the approach; within 2 of the entrance)
      const b = l.box, bad = [], e = lotEntrance(l);
      for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) if (walk.has(K(x, z)) && !(e && Math.max(Math.abs(e[0] - x), Math.abs(e[2] - z)) <= 2)) bad.push([x, b.minY, z]);
      if (bad.length) findings.push(finding('S-LOTS', bad.length, bad, `lot ${l.id}'s box covers ${bad.length} street/route walk column(s)`, l.part));
    }
  }
  // ---- S-FOOT: every post (a fence or wall block under a light) standing on a dirt path the region did not write
  if (want('S-FOOT')) {
    const bad = [];
    const posts = [];
    vw.eachWritten((x, y, z, idx) => { if (P.emit[idx] > 0) posts.push([x, y, z]); });
    for (const [x, y, z] of posts) {
      let yy = y - 1;
      while (yy > y - 4 && /_(fence|wall)$/.test(nameOf(P.states[vw.get(x, yy, z)]))) yy--;
      if (yy === y - 1) continue; // no post under the light (a hanging lantern, a bollard on the ground)
      const foot = P.states[vw.get(x, yy, z)];
      if (nameOf(foot) === 'minecraft:dirt_path' && !(vw.flags(x, yy, z) & F_WRITTEN)) bad.push([x, yy, z]);
    }
    for (const p of lant.posts) if (nameOf(p.footState) === 'minecraft:dirt_path' && !p.own && !bad.some((q) => q.join() === p.foot.join())) bad.push(p.foot);
    if (bad.length) findings.push(finding('S-FOOT', bad.length, bad, `${bad.length} lamp post(s) stand on a dirt path the region did not write (vanilla turns it to dirt under the post, outside the journal)`));
  }
  // ---- S-LAND
  if (want('S-LAND')) landRule(c, findings);
  // ---- S-GRAV
  if (want('S-GRAV')) gravityRule(c, vw, findings, metrics, preFix.gravity);
  // ---- S-FELL
  if (want('S-FELL')) fellingRule(c, vw, findings, metrics, preFix.felling);
  // ---- S-DOOR
  if (want('S-DOOR')) doorRule(c, findings);
  // ---- S-FARM
  if (want('S-FARM') && c.plan) farmRule(c, findings);
  // ---- S-THEME (Noah, 2026-10-24): every written block outside the lots traces to a role or the functional allowlist
  if (want('S-THEME')) {
    const t = themeOffenders(c.ir, vw);
    metrics.theme = { cells: t.cells, offenders: t.offenders.map((o) => `${o.part} ${o.block} x${o.count}`) };
    for (const o of t.offenders) {
      const k = knownTheme(o);
      if (k) findings.push({ ...finding('T-THEME-KNOWN', o.count, o.sample, `${o.part} writes ${o.block} (x${o.count}): a known exception (${k.why})`), severity: 'info', theme: o });
      else findings.push({ ...finding('S-THEME', o.count, o.sample, `${o.part} writes ${o.block} (x${o.count}), which no role of the plan gives (themes) and is not a functional block`), severity: 'warning', theme: o });
    }
  }
  return { findings, metrics, world: W, ms: Math.round(performance.now() - t0) };
}

// ------------------------------------------------------------------ S-LAND

function landRule(c, findings) {
  const edges = (c.meta?.route?.edges ?? []).filter((e) => e.ok && Array.isArray(e.path));
  const recs = [...(c.meta?.bridges ?? []).map((r) => ({ r, kind: 'bridge', cols: (r.cells ?? []).map(([x, , z]) => [x, z]) })), ...(c.meta?.ropes ?? []).map((r) => ({ r, kind: 'rope', cols: (r.cells ?? []).map(([x, , z]) => [x, z]) })), ...(c.meta?.tunnels ?? []).map((r) => ({ r, kind: 'tunnel', cols: (r.cells ?? []).map(([x, , z]) => [x, z]) })),
    // ((7a CW) a catwalk's walk lanes: its `deckCells` (its `cells` is siteplan/1's count))
    ...(c.meta?.catwalks ?? []).map((r) => ({ r, kind: 'catwalk', cols: (r.deckCells ?? []).map(([x, , z]) => [x, z]) }))];
  for (const { r, kind, cols } of recs) {
    if (!(r.width > 0) || !r.dir || !r.from) continue;
    // the edge whose path passes the record's near landing
    const e = edges.find((q) => q.path.some((p) => p[0] === r.from[0] && p[2] === r.from[2])) ?? null;
    if (!e) continue;
    // (the walk's footprint at the deck's own width: region/passes/route.mjs footprintOf, an even width's extra column on +x / +z)
    const fp = new Set(footprintOf(e.path, r.width).map(([x, z]) => K(x, z)));
    const [dx, dz] = r.dir;
    const n = r.n ?? r.length ?? null;
    if (!n) continue;
    const bad = [];
    for (const i of [1, n]) {
      const rx = r.from[0] + dx * i, rz = r.from[2] + dz * i;
      const row = cols.filter(([x, z]) => (dx ? x === rx : z === rz));
      const fpRow = [...fp].map((k) => k.split(',').map(Number)).filter(([x, z]) => (dx ? x === rx : z === rz));
      const a = new Set(row.map((q) => K(...q))), b = new Set(fpRow.map((q) => K(...q)));
      const off = [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
      if (fpRow.length && off) bad.push([rx, r.from[1], rz]);
    }
    if (bad.length) findings.push(finding('S-LAND', bad.length, bad, `${kind} ${r.id} (width ${r.width}, dir ${r.dir}): its ${kind === 'tunnel' ? 'floor' : 'deck'} row stands off its walk's footprint at ${bad.length} end(s)`, r.part));
  }
}

// ------------------------------------------------------------------ S-GRAV (TileCheck.dependents, keepsGravity)

const FREE = (s) => /^minecraft:(air|cave_air|void_air|fire|soul_fire|water|lava|bubble_column)$/.test(nameOf(s)) || (info(nameOf(s))?.collision === 'none' && info(nameOf(s))?.v === 'PLANT');
const GRAV = /^minecraft:(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding)$/;

/**
 * Stage 3 of the tile writer (TileCheck.dependents, keepsGravity) over the virtual world, stage by stage: a cell a stage changes (its
 * state before that stage, the base's or an earlier stage's, is not its state after) with a gravity block over it as the stage leaves
 * it (the world's, or the stage's own write: T3b's sand band on its ridge's stone, the anomaly's case). That block stays when its support is not free (FallingBlock.isFree) before and after; `preFix: 'sand-vanish'`
 * clears it as the dependents stage did before 70fc0dd0. A cleared supported gravity block is a finding. (The earlier stages' worlds
 * are built only when a candidate exists.)
 */
function gravityRule(c, vw, findings, metrics, preFix) {
  const P = vw.pal;
  const stageIdx = new Map(c.ir.stages.map((s, i) => [s, i]));
  const sOf = (part) => (part >= 0 ? stageIdx.get(c.ir.parts[part]?.stage) ?? 0 : -1);
  const cands = [];
  vw.eachWritten((x, y, z, idx, f, part) => { if (GRAV.test(nameOf(P.states[vw.get(x, y + 1, z)]))) cands.push([x, y, z, sOf(part)]); });
  let kept = 0;
  const lost = [];
  if (cands.length) {
    const prev = new Map();
    const worldBefore = (s) => {
      if (s <= 0) return (x, y, z) => vw.base(x, y, z);
      if (!prev.has(s)) { const w = buildVirtual({ ir: { ...c.ir, stages: c.ir.stages.slice(0, s) }, survey: c.survey, blobs: c.blobs, volumes: c.volumes ?? [] }).vw; if (c.blockBase) w.base = vw.base; prev.set(s, w); }
      const w = prev.get(s);
      return (x, y, z) => P.of(w.pal.states[w.get(x, y, z)]);
    };
    for (const [x, y, z, s] of cands) {
      const before = worldBefore(s);
      const was = before(x, y, z), now = vw.get(x, y, z);
      if (was === now) continue;
      // the block over it as the stage leaves it: the stage's own write (T3b's sand band over its ridge's stone), else the world's
      const abovePart = vw.partAt(x, y + 1, z);
      const above = abovePart >= 0 && sOf(abovePart) <= s ? vw.get(x, y + 1, z) : before(x, y + 1, z);
      if (!GRAV.test(nameOf(P.states[above]))) continue;
      if (FREE(P.states[was]) || FREE(P.states[now])) continue;
      if (preFix === 'sand-vanish') lost.push([x, y + 1, z]); else kept++;
    }
  }
  metrics.gravityKept = kept;
  if (lost.length) findings.push(finding('S-GRAV', lost.length, lost, `${lost.length} supported gravity block(s) on changed cells cleared by the dependents stage (their support is solid before and after: they would not fall)`));
}

// ------------------------------------------------------------------ S-FELL (TileCheck felling, C31)

const LOGLIKE = /_(log|wood|stem|hyphae)$/;
/**
 * The felling model: a written cell over a log (in the frozen volumes) fells the tree: the logs connected to it (26-neighbours, within
 * 12), and with the fix it stops at a protected column, another build's box and the claim. A felled log in a protected area, a build or
 * outside the claim is a finding (`preFix: 'c31'`: unbounded, as before 5cc0d7f1).
 */
function fellingRule(c, vw, findings, metrics, preFix) {
  const vols = c.volumes ?? [];
  if (!vols.some((v) => (v.counts?.LOG ?? 0) > 0)) { metrics.felling = { trees: 0 }; return; }
  const P = vw.pal;
  const claim = c.ir.claim;
  const rects = protectRects(c);
  const stop = (x, y, z) => preFix !== 'c31' && (!(x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ) || rects.some((r) => inRect(r, x, z)));
  const isLog = (x, y, z) => LOGLIKE.test(nameOf(P.states[vw.base(x, y, z)]));
  const seen = new Set();
  const bad = [];
  let trees = 0;
  vw.eachWritten((x, y, z) => {
    if (!isLog(x, y, z) || seen.has(`${x},${y},${z}`)) return;
    trees++;
    const q = [[x, y, z]];
    seen.add(`${x},${y},${z}`);
    while (q.length) {
      const [a, b, d] = q.pop();
      if (Math.abs(a - x) > 12 || Math.abs(d - z) > 12) continue;
      if (!(a >= claim.minX && a <= claim.maxX && d >= claim.minZ && d <= claim.maxZ) || rects.some((r) => inRect(r, a, d))) bad.push([a, b, d]);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        const nx = a + i, ny = b + j, nz = d + k, key = `${nx},${ny},${nz}`;
        if (seen.has(key) || !isLog(nx, ny, nz) || stop(nx, ny, nz)) continue;
        seen.add(key); q.push([nx, ny, nz]);
      }
    }
  });
  metrics.felling = { trees };
  if (bad.length) findings.push(finding('S-FELL', bad.length, bad, `${bad.length} log(s) felled outside the claim or inside a protected area / build (felling must stop there)`));
}

// ------------------------------------------------------------------ S-DOOR (BuildViews claim box, Builds entrances: C34, C34b)

const TWO = (s) => { const f = info(nameOf(s))?.family; return f === 'door' || f === 'bed' || f === 'double_plant'; };
/** The partner cell of a two-cell block (a door's other half, a bed's other part). */
function partnerOf([x, y, z, s]) {
  const p = propsOf(s), f = info(nameOf(s))?.family;
  if (f === 'door' || f === 'double_plant') return [x, p.half === 'upper' ? y - 1 : y + 1, z];
  if (f === 'bed') { const d = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }[p.facing] ?? [0, 0]; const s2 = p.part === 'head' ? -1 : 1; return [x + d[0] * s2, y, z + d[1] * s2]; }
  return null;
}
/** A build's claim box as the lint keeps it clear: its bounds, grown to hold the partner of every two-cell block it holds. */
export function claimBox(b) {
  const box = { minX: b.bounds[0], minY: b.bounds[1], minZ: b.bounds[2], maxX: b.bounds[3], maxY: b.bounds[4], maxZ: b.bounds[5] };
  for (const c of b.blocks ?? []) {
    if (!TWO(c[3])) continue;
    const q = partnerOf(c);
    if (!q) continue;
    box.minX = Math.min(box.minX, q[0]); box.maxX = Math.max(box.maxX, q[0]);
    box.minY = Math.min(box.minY, q[1]); box.maxY = Math.max(box.maxY, q[1]);
    box.minZ = Math.min(box.minZ, q[2]); box.maxZ = Math.max(box.maxZ, q[2]);
  }
  return box;
}
function doorRule(c, findings) {
  for (const b of c.builds ?? []) {
    // the record's own bounds (Sites.builds' claim box) must hold both halves: BuildViews takes the partner in since C34
    const box = { minX: b.bounds[0], minY: b.bounds[1], minZ: b.bounds[2], maxX: b.bounds[3], maxY: b.bounds[4], maxZ: b.bounds[5] };
    const cut = (b.blocks ?? []).filter((q) => TWO(q[3]) && inBox(box, q[0], q[1], q[2])).map(partnerOf).filter((q) => q && !inBox(box, ...q));
    if (cut.length) findings.push(finding('S-DOOR', cut.length, cut, `build ${b.id}: its claim box cuts ${cut.length} door/bed partner(s) (the other half stays outside the claim)`));
    // a door on the build's lowest row (or one over) counts as an entrance, whatever the ground under it (a lifted build)
    const low = Math.min(...(b.blocks ?? []).map((q) => q[1]));
    const doors = (b.blocks ?? []).filter((q) => info(nameOf(q[3]))?.family === 'door' && propsOf(q[3]).half !== 'upper' && q[1] <= low + 1);
    const ent = b.kind === 'HOUSE' || b.kind === 'house' ? b.entrances ?? [] : null;
    if (ent && doors.length && !doors.some((d) => ent.some((e) => e.pos[0] === d[0] && e.pos[2] === d[2]))) findings.push(finding('S-DOOR', doors.length, doors, `build ${b.id}: ${doors.length} door(s) on its lowest row and no entrance at any (a lifted build's door counts from its lowest row)`));
  }
}

// ------------------------------------------------------------------ S-FARM (farm typed lots: 65d61b0b)

function farmRule(c, findings) {
  const waters = c.meta?.waters ?? [];
  for (const z of c.plan.zones ?? []) {
    const lr = z.program?.lots ?? z.program?.params?.lots ?? [];
    const lots = Array.isArray(lr) ? lr : [];
    const asked = lots.filter((l) => l && (l.farmPond === true || (z.farmPond === true && l.farmPond !== false)));
    if (!asked.length && z.farmPond !== true) continue;
    const farms = asked.filter((l) => (l.villager ?? inferVillager(l.type)) === 'farm');
    const ponds = waters.filter((w) => w.kind === 'farm_pond' && (w.zone === z.id || String(w.part ?? '').startsWith(z.id) || String(w.id ?? '').includes(z.id) || waters.length === 1));
    const notes = JSON.stringify((c.answers ?? []).find((p) => p.part === z.id)?.notes ?? []);
    if (farms.length && !ponds.length && !/farmPond:/.test(notes)) findings.push(finding('S-FARM', farms.length, [], `zone ${z.id} asks for a farm pond and has farm lot(s) ${farms.map((l) => l.id).join(', ')} (villager use given or implied by type), but no farm pond and no note says why`));
    if (!farms.length && !/farmPond: no farm lot/.test(notes)) findings.push(finding('S-FARM', 1, [], `zone ${z.id} asks for a farm pond with no farm lot and says nothing (never silent)`));
  }
}

// ------------------------------------------------------------------ the gate

/**
 * FAIL lines of a lint report: every error finding; the gated warning rules; M5 over the walk area above `bars.m5` (default 0.01);
 * `bars.allow`: rule ids recorded, not gated, for this case (with the reason in the case).
 */
export function gate(rep, bars = {}) {
  const fails = [];
  const allow = new Set(bars.allow ?? []);
  for (const f of rep.findings) {
    if (allow.has(f.rule)) continue;
    // (the corpus: the plan check's own verdict, plus the lint's rules and, for a connector fixture, the connector re-reads)
    if (bars.corpus && f.severity !== 'error' && !f.rule.startsWith('S-') && !(bars.connectors && /^(M10|M10:bridge|M10:rope|M10:catwalk|M10:climb|M8:climb|M5:climb|M3:tunnel|M4:tunnel|M2:wall|M8:wall)$/.test(f.rule))) continue;
    if (f.rule === 'M5' || f.rule === 'M6' || f.rule === 'M8' || f.rule === 'M3:overhang' || f.rule === 'M26' || f.rule.startsWith('M27:') && f.severity !== 'error') continue;
    if (f.severity === 'error' || GATED.test(f.rule) || f.rule.startsWith('S-')) fails.push(`${f.rule} ${f.part ?? '-'} x${f.count}: ${f.message}`);
  }
  const m5 = rep.metrics.M5;
  if (!bars.corpus && bars.m5 !== null && !allow.has('M5') && m5 && m5.share > (bars.m5 ?? 0.01)) fails.push(`M5 ${(100 * m5.share).toFixed(2)}% of ${m5.walkArea} walk cells dark and spawnable (> ${(100 * (bars.m5 ?? 0.01)).toFixed(0)}%)`);
  return fails;
}

export { blockLight, lotEntrance };
