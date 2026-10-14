// (7a K1b) The land a whole-claim template's routes meet (docs/CONTRACT.md "Phase 7a slice K1" §3, §10: v33 and v34 on rift_city):
// a template that carves its ground in an earlier stage gives the plan's route pass a `base` (the carved surface minus the survey's
// ground), so the rope move finds the gap and a walk never crosses it. Only plans with a rope_bridge or auto part read it
// (connectors/rope.mjs ropePassInput), so every other plan's routes stay T2's. The numbers are the template's own (kit/regions/
// rift_city.mjs), computed again here from the same claim, survey and params: the template's file is not touched, so its program sha
// and every golden that names it stay as they are. Plan time, integer math.

/** rift_city's layout (its default export's first lines, verbatim in effect): the channel's straight part, centre line, rim, floor. */
export function riftLayout(claim, survey, P) {
  const round = (v) => Math.floor(v + 0.5);
  const W = claim.maxX - claim.minX + 1, D = claim.maxZ - claim.minZ + 1;
  const cz = claim.minZ + Math.floor(D / 2);
  const half = Math.floor(Math.min(P.width, D - 70) / 2);
  let best = [claim.minX + 20, claim.maxX - 20], run0 = null;
  const bestLen = () => best[1] - best[0] + 1;
  let found = false;
  for (let x = claim.minX + 20; x <= claim.maxX - 19; x++) {
    let wet = x > claim.maxX - 20;
    for (let z = cz - half - 8; !wet && z <= cz + half + 8; z += 2) if (survey.waterAt(x, z)) wet = true;
    if (!wet && run0 === null) run0 = x;
    if ((wet || x === claim.maxX - 20) && run0 !== null) {
      const end = wet ? x - 1 : x;
      if (!found || end - run0 + 1 > bestLen()) { best = [run0, end]; found = true; }
      run0 = null;
    }
  }
  const dry = found ? [best[0] + 10, best[1] - 10] : [claim.minX + 20, claim.maxX - 20];
  const cx = Math.floor((dry[0] + dry[1]) / 2);
  const L = Math.min(P.length, dry[1] - dry[0] + 1);
  if (L < 80 || half < 8) return null;
  const x0 = cx - Math.floor(L / 2) + half, x1 = cx + Math.floor(L / 2) - half;
  const edge = [];
  for (let x = x0 - half; x <= x1 + half; x += 4) for (const z of [cz - half - 2, cz + half + 2]) edge.push(survey.heightAt(x, z));
  edge.sort((a, b) => a - b);
  const rimY = edge[Math.floor(edge.length * 0.9)];
  const depth = Math.max(16, Math.min(P.depth, rimY - (claim.minY + 8)));
  const floorY = rimY - depth;
  return { W, D, cz, half, cx, L, x0, x1, rimY, depth, floorY, yl: floorY + round(depth / 2), LW: 9 };
}

/**
 * rift_city's route land: the rift down to its floor, the ledges at theirs (mid depth, 9 wide on both walls, the north one broken
 * round the hall), over the channel's box widened by the warp: 2 columns either side counted carved (the warp of 3 carves at most 2
 * past the channel at the rim, measured on a flat claim: 15 and 16 from the centre line in part, 17 never), so the lip is the
 * column 17 out and a deck from it cuts through a bulge rather than stopping short of it. `rails`: the rim rail round the rift (5
 * past the channel: a fence on the surface, a lantern over every 10th post), which a K1b route opens where it crosses (the links
 * stage writes air there). `{base: {minX, minZ, width, depth, values}, rails: [[x0, z0, x1, z1]]}` or null.
 */
export function riftLand(claim, survey, P) {
  const g = riftLayout(claim, survey, P);
  if (!g) return null;
  const { cz, half, x0, x1, floorY, yl, LW, cx } = g;
  const minX = x0 - half - 2, maxX = x1 + half + 2, minZ = cz - half - 2, maxZ = cz + half + 2;
  const width = maxX - minX + 1, dep = maxZ - minZ + 1, values = new Array(width * dep).fill(0);
  const ledge = [];
  for (const side of [-1, 1]) {
    const zo = cz + side * half, zi = cz + side * (half - LW);
    const zA = Math.min(zo + side * 3, zi), zB = Math.max(zo + side * 3, zi);
    const spans = side < 0 ? [[x0 + 12, cx - 16], [cx + 16, x1 - 12]] : [[x0 + 12, x1 - 12]];
    for (const [a, b] of spans) if (b - a >= 12) ledge.push([a, zA, b, zB]);
  }
  for (let j = 0; j < dep; j++) for (let i = 0; i < width; i++) {
    const x = minX + i, z = minZ + j;
    const onLedge = ledge.some((q) => x >= q[0] && x <= q[2] && z >= q[1] && z <= q[3]);
    values[i + j * width] = (onLedge ? yl - 1 : floorY - 1) - survey.groundAt(x, z);
  }
  // the rim rail (rift_city's rim_rail part): a ring of fence 5 past the channel, on the surface
  const zr = half + 5, xr0 = x0 - half - 5, xr1 = x1 + half + 5;
  const rails = [[xr0, cz - zr, xr1, cz - zr], [xr0, cz + zr, xr1, cz + zr], [xr0, cz - zr, xr0, cz + zr], [xr1, cz - zr, xr1, cz + zr]];
  return { base: { minX, minZ, width, depth: dep, values }, rails, layout: g };
}

/** The templates whose carved ground the routes must see: name -> (claim, survey, params) -> {base} | null. */
export const TEMPLATE_LANDS = Object.freeze({ rift_city: riftLand });
