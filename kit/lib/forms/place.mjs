// (6c F3 §3.1, §3.2, §5) Where a grown form (a giant tree or a giant mushroom) stands in a plan. Plan time only; pure given its inputs.
//
// Placed at emit, after the zones have emitted their layouts (so `inside {part: <zone>}` reads the zone's open land: its rect less
// what its layout wrote, lot boxes + 1, each grown by 2) and before walls and routes (which then keep off the form's column mask).
// A site holds the form's whole 2.5D column mask (trunk, roots and canopy projected), each column:
//   - inside the claim less its margin and the locator's area, on no hard column (keep-out, protected areas, other regions, builds
//     grown by 1 with the canopy off the build's rect + 1: S-F3-6);
//   - 8 or more (Chebyshev) from every natural tree column of the survey (FLAG_TREE) and, with a frozen volume, every natural LOG or
//     LEAVES cell (§3.1: no natural leaf's distance or decay ever changes because of us);
//   - 2 or more from every registered body footprint, its hard and watch cells (KC §5: the later part keeps clear), from every zone
//     rect the form is not inside, every form placed before it (F1's bounds, F3's masks) and the part's own other sites;
//   - its foot (the trunk or stem and its roots: the columns it writes at or under the ground + 1) on dry land, the ground's roughness
//     there at most 3.
// Best first by the locator's move, then the distance from its aim (ties: scan order, x then z). Returns the sites with their grown
// forms (regenerated on the real ground at the chosen site).
import { FLAG_LAVA, FLAG_TREE, FLAG_WATER } from '../region/pack.mjs';
import { sampleIndex } from '../region/survey.mjs';
import { eachColumn, runsRect, shiftRuns } from './states.mjs';

/** A natural tree keeps this far (Chebyshev, columns) from every column of a grown form (§3.1). */
export const TREE_CLEAR = 8;
/** Bodies, zones, forms and the form's own other sites keep this far (F1's gap). */
export const FORM_GAP = 2;
const STEP = 2;
/** Other seeds a site tries when its own shape fits nowhere (§3.1: fewer, moved; a smaller crown first). */
export const RETRIES = 3;

/** A bitmap over the claim (one byte a column). */
function grid(claim) {
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const a = new Uint8Array(W * D);
  const inC = (x, z) => x >= claim.minX && x <= claim.maxX && z >= claim.minZ && z <= claim.maxZ;
  return {
    W, D, a,
    set(x, z) { if (inC(x, z)) a[(z - claim.minZ) * W + (x - claim.minX)] = 1; },
    rect(q, g = 0) { for (let z = Math.max(claim.minZ, q.minZ - g); z <= Math.min(claim.maxZ, q.maxZ + g); z++) for (let x = Math.max(claim.minX, q.minX - g); x <= Math.min(claim.maxX, q.maxX + g); x++) a[(z - claim.minZ) * W + (x - claim.minX)] = 1; },
    has(x, z) { return !inC(x, z) || a[(z - claim.minZ) * W + (x - claim.minX)] === 1; },
  };
}

/** Dilate a bitmap by `g` (Chebyshev), separably. */
function dilate(G, g) {
  if (g <= 0) return;
  const { W, D, a } = G;
  const t = new Uint8Array(W * D);
  for (let z = 0; z < D; z++) {
    let last = -Infinity;
    for (let x = 0; x < W; x++) { if (a[z * W + x]) last = x; if (x - last <= g) t[z * W + x] = 1; }
    last = Infinity;
    for (let x = W - 1; x >= 0; x--) { if (a[z * W + x]) last = x; if (last - x <= g) t[z * W + x] = 1; }
  }
  a.fill(0);
  for (let x = 0; x < W; x++) {
    let last = -Infinity;
    for (let z = 0; z < D; z++) { if (t[z * W + x]) last = z; if (z - last <= g) a[z * W + x] = 1; }
    last = Infinity;
    for (let z = D - 1; z >= 0; z--) { if (t[z * W + x]) last = z; if (last - z <= g) a[z * W + x] = 1; }
  }
}

/**
 * The forbidden columns of a grown form's sites: `{canopy: G, foot: G, trees: G}` bitmaps over the claim. `o`:
 *   env (compile's), r (the region so far), keep (KC's store), zoneOpen ({rect, obstacles: [rects]} when inside a zone, else null),
 *   zones (accepted zone rects, kept off when not inside one), forms (rects: F1 bounds; F3 masks come from r.forms), volumes (frozen
 *   volume readers: {cells(x0, z0, x1, z1, fn)} with classes, optional).
 */
export function forbidden(o) {
  const { env, r, keep = [], zoneOpen = null } = o;
  const claim = env.claim;
  const canopy = grid(claim), foot = grid(claim), trees = grid(claim);
  const cols = env.cols, flagAt = (x, z) => cols.flags[sampleIndex(cols, x, z)];
  // the claim's margin
  const M = 2;
  for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
    if (x < claim.minX + M || x > claim.maxX - M || z < claim.minZ + M || z > claim.maxZ - M) canopy.set(x, z);
    const f = flagAt(x, z);
    if (f & FLAG_TREE) trees.set(x, z);
    if (f & (FLAG_WATER | FLAG_LAVA)) foot.set(x, z);
  }
  // natural tree cells a frozen volume shows (LOG, LEAVES) count as tree columns
  for (const v of o.volumes ?? []) v.eachTreeColumn?.((x, z) => trees.set(x, z));
  dilate(trees, TREE_CLEAR);
  // hard columns: keep-out, protected areas, other regions (grown by 1 in env.hard), builds (their keep-out + 1: S-F3-6)
  for (const q of env.hard) canopy.rect(q);
  for (const b of env.buildRects ?? []) canopy.rect(b.rect, 1);
  // bodies: reserved footprints and registered hard and watch cells, grown by FORM_GAP
  const bodyCols = grid(claim);
  for (const rec of keep ?? []) {
    if (rec.kind === 'reserved') for (const c of rec.cols) { const [x, z] = c.split(',').map(Number); bodyCols.set(x, z); }
    else {
      for (const k of rec.hard.keys()) { const [x, , z] = k.split(',').map(Number); bodyCols.set(x, z); }
      for (const k of rec.watch) { const [x, , z] = k.split(',').map(Number); bodyCols.set(x, z); }
    }
  }
  // the region's own fluid bodies emitted so far (their cells and shells), in case one is not in the store
  if (!o.noBodies) for (const b of r._fluidBodies ?? []) for (const c of [...(b.cells ?? []), ...(b.shell ?? []), ...(b.watch ?? [])]) bodyCols.set(c[0], c[2]);
  dilate(bodyCols, FORM_GAP);
  for (let i = 0; i < canopy.a.length; i++) if (bodyCols.a[i]) canopy.a[i] = 1;
  // zones the form is not inside (F1's rule: accepted zones, gap 2); inside one, its layout's writes and lots
  for (const q of o.zones ?? []) canopy.rect(q, FORM_GAP);
  if (zoneOpen) {
    // only the zone's rect is open, less what its layout wrote (each op's footprint) grown by 2, lot boxes + 1 grown by 2
    for (let z = claim.minZ; z <= claim.maxZ; z++) for (let x = claim.minX; x <= claim.maxX; x++) {
      const q = zoneOpen.rect;
      if (x < q.minX || x > q.maxX || z < q.minZ || z > q.maxZ) canopy.set(x, z);
    }
    for (const q of zoneOpen.obstacles) canopy.rect(q, FORM_GAP);
  }
  // every lot of the region (a canopy over a lot box would be a write in it: K5), lot + 1 grown by 2
  for (const l of r.lots ?? []) canopy.rect(l.box, 1 + FORM_GAP);
  // forms placed before: F1's bounds, F3's masks, grown by 2
  const formCols = grid(claim);
  for (const f of r.forms ?? []) {
    if (f.columns) eachColumn(f.columns, (x, z) => formCols.set(x, z));
    else if (f.bounds) formCols.rect(f.bounds);
  }
  for (const q of o.forms ?? []) formCols.rect(q);
  dilate(formCols, FORM_GAP);
  for (let i = 0; i < canopy.a.length; i++) if (formCols.a[i] || trees.a[i]) canopy.a[i] = 1;
  return { canopy, foot, trees, bodyCols, formCols };
}

/**
 * Pick up to `want` sites for a grown form. `shapeOf(k)`: the k-th site's form grown at the origin on flat ground (`{columns,
 * foot: runs of the columns it writes at or under ground + 1, reach}`), `grow(k, at)`: the form grown at `at` on the real ground.
 * `loc`: compile's locator ({valid(rect), move(rect), aim}); `area`: the rect to scan. Returns {sites: [{at, gen, move}], tried}.
 */
export function pickSites({ env, F, loc, area, want, shapeOf, grow, roughAt, maxMove = Infinity }) {
  const claim = env.claim;
  const sites = [];
  const own = grid(claim);
  const a0 = { minX: Math.max(claim.minX, area.minX), minZ: Math.max(claim.minZ, area.minZ), maxX: Math.min(claim.maxX, area.maxX), maxZ: Math.min(claim.maxZ, area.maxZ) };
  let tried = 0;
  // each site k tries its own shape first, then up to RETRIES other seeds of the same species (a smaller crown, another spread) before it
  // gives up: the first shape that fits anywhere within the locator wins (deterministic: the same order every plan)
  for (let k = 0; k < want; k++) {
    let placed = false;
    for (let a = 0; a <= RETRIES && !placed; a++) {
      const sh = shapeOf(k, a);
      const rel = runsRect(sh.columns);
      const cands = [];
      for (let z = a0.minZ; z <= a0.maxZ; z += STEP) for (let x = a0.minX; x <= a0.maxX; x += STEP) {
        const rect = { minX: rel.minX + x, minZ: rel.minZ + z, maxX: rel.maxX + x, maxZ: rel.maxZ + z };
        if (rect.minX < claim.minX || rect.maxX > claim.maxX || rect.minZ < claim.minZ || rect.maxZ > claim.maxZ) continue;
        if (!loc.valid(rect)) continue;
        const mv = loc.move(rect);
        if (mv > maxMove) continue;
        const aim = loc.aim ?? [(claim.minX + claim.maxX) >> 1, (claim.minZ + claim.maxZ) >> 1];
        cands.push([mv * 4096 + Math.max(Math.abs(x - aim[0]), Math.abs(z - aim[1])), x, z, mv]);
      }
      cands.sort((p, q) => p[0] - q[0] || p[2] - q[2] || p[1] - q[1]);
      let got = null;
      for (const [, x, z, mv] of cands) {
        tried++;
        let ok = true;
        eachColumn(sh.columns, (cx, cz) => { if (ok && (F.canopy.has(cx + x, cz + z) || own.has(cx + x, cz + z))) ok = false; });
        if (!ok) continue;
        eachColumn(sh.foot, (cx, cz) => { if (ok && F.foot.has(cx + x, cz + z)) ok = false; });
        if (!ok) continue;
        if (roughAt(x, z, sh.reach) > 3) continue;
        got = { x, z, mv };
        break;
      }
      if (!got) continue;
      const gen = grow(k, [got.x, env.S.groundAt(got.x, got.z), got.z], a);
      // the real form's mask (the same columns as the flat one but for ground-following roots): checked again, then taken
      let ok = true;
      eachColumn(gen.columns, (cx, cz) => { if (ok && (F.canopy.has(cx, cz) || own.has(cx, cz))) ok = false; });
      if (!ok) continue;
      eachColumn(gen.columns, (cx, cz) => { for (let dx = -FORM_GAP; dx <= FORM_GAP; dx++) for (let dz = -FORM_GAP; dz <= FORM_GAP; dz++) own.set(cx + dx, cz + dz); });
      sites.push({ at: [got.x, env.S.groundAt(got.x, got.z), got.z], gen, move: got.mv, k, retry: a });
      placed = true;
    }
  }
  return { sites, tried };
}

export { shiftRuns };
