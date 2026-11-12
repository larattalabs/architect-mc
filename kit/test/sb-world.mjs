// (7b SB) Land for the scenario programs' units (kit/test/sb.test.mjs) and the gate's offline step: a claim's classes (a frozen volume
// over the claim's y range) and its survey from a ground function; a sculpt program's cells written into it as natural land (what the
// harness's vanilla /fill does in game); the two-plan flow over it; the fit examples built into a plan's site lots ($0, as
// Designs.siteVariant re-runs them) and checked on the composite. Deterministic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { planRegion } from '../lib/region/plan.mjs';
import { buildVirtual } from '../lib/region/vworld.mjs';
import { makeColumns, encodeColumns } from '../lib/region/pack.mjs';
import { decodeArvx, encodeArvx, VC } from '../lib/region/volume.mjs';
import { Site } from '../lib/site.mjs';
import { buildDesign } from '../build.mjs';
import { sculptRuns, stateClass } from '../lib/region/sculpt.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const regionFile = (id) => path.join(KIT, 'regions', `${id}.mjs`);

/** The land: classes over `box` (x/z the claim, y its range) from `groundAt(x, z)`: SOIL 3 deep, ROCK under it, AIR over it. */
export function makeLand({ claim, minY, maxY, groundAt }) {
  const box = { minX: claim.minX, maxX: claim.maxX, minZ: claim.minZ, maxZ: claim.maxZ, minY, maxY };
  const W = box.maxX - box.minX + 1, H = maxY - minY + 1, D = box.maxZ - box.minZ + 1;
  const classes = new Uint8Array(W * H * D);
  const ground = new Int16Array(W * D);
  for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
    const g = groundAt(box.minX + x, box.minZ + z);
    ground[x + z * W] = g;
    for (let y = 0; y < H; y++) {
      const wy = minY + y;
      classes[(x * D + z) * H + y] = wy > g ? VC.AIR : wy >= g - 3 ? VC.SOIL : VC.ROCK;
    }
  }
  const idx = (x, y, z) => ((x - box.minX) * D + (z - box.minZ)) * H + (y - minY);
  const inside = (x, y, z) => x >= box.minX && x <= box.maxX && y >= minY && y <= maxY && z >= box.minZ && z <= box.maxZ;
  const land = {
    box, W, H, D, classes, ground, claim: { ...box },
    cls: (x, y, z) => (inside(x, y, z) ? classes[idx(x, y, z)] : VC.MISSING),
    set: (x, y, z, c) => { if (inside(x, y, z)) classes[idx(x, y, z)] = c; },
    /** The survey: each column's top solid (SOIL, ROCK, LOG) cell from the classes (a written tree raises its columns, as the game's). */
    survey() {
      const c = makeColumns(box.minX, box.minZ, W, D, 1);
      for (let x = 0; x < W; x++) for (let z = 0; z < D; z++) {
        let g = ground[x + z * W];
        for (let y = H - 1; y >= 0; y--) {
          const k = classes[(x * D + z) * H + y];
          if (k === VC.ROCK || k === VC.SOIL || k === VC.LOG || k === VC.LOOSE) { g = minY + y; break; }
        }
        const n = x + z * W;
        c.ground[n] = ground[x + z * W]; c.height[n] = g; c.floor[n] = ground[x + z * W];
      }
      return encodeColumns(c);
    },
    /** A frozen volume of `b` (inside the land) as the plan reads it: {sha, box, bytes, decoded}. */
    volume(b) {
      const w = b.maxX - b.minX + 1, h = b.maxY - b.minY + 1, d = b.maxZ - b.minZ + 1;
      const out = new Uint8Array(w * h * d);
      for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) out[(x * d + z) * h + y] = land.cls(b.minX + x, b.minY + y, b.minZ + z);
      const bytes = encodeArvx(b, out);
      const decoded = decodeArvx(bytes);
      return { sha: decoded.sha, box: { ...b }, bytes, decoded };
    },
  };
  return land;
}

/** Write a planned sculpt's cells into the land as natural land (the classes the game's survey gives them). Returns the runs. */
export function applySculpt(land, res) {
  const runs = sculptRuns(res.ir, land.survey(), (sha) => res.blobs.get(sha));
  for (const r of runs) for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) for (let y = r.y0; y <= r.y1; y++) land.set(x, y, z, VC[stateClass(r.state)]);
  return runs;
}

/** The two-plan flow over the land: plan, answer every asked volume from the land, plan again. Returns planRegion's result. */
export async function plan2(land, id, { params = {}, seed = '7', links = null } = {}) {
  const claim = { ...land.claim };
  const survey = land.survey();
  const base = { programFile: regionFile(id), params, survey, claim, seed, roles: {}, ...(links ? { links } : {}) };
  const first = await planRegion(base);
  const volumes = (first.needVolumes ?? []).map((b) => land.volume(b));
  return volumes.length ? planRegion({ ...base, volumes }) : first;
}

const EX = { carve_into: 'fit_carve_into', wrap_trunk: 'fit_wrap_trunk', suspend: 'fit_suspend', span: 'fit_span', attach_to_cliff: 'fit_attach_to_cliff', on_pad: 'fit_on_pad' };
export const exampleFor = (fit) => EX[fit];

/**
 * The fit example of each site lot of a plan, built into the lot's Site (the site volume cut from the plan's side blob or the land) and
 * checked on the composite, as Designs.siteVariant does ($0). Returns [{lot, entry, ok, errors, siteFindings, ports, sidecar, dir}].
 */
export async function buildLots(res, land) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lots-'));
  const out = [];
  for (const lot of res.ir.lots.filter((l) => l.site)) {
    const b = res.ir.blobs?.[`site_${lot.id}`];
    const raw = b ? zlib.gunzipSync(res.blobs.get(b.sha)) : land.volume(lot.site.volume).bytes;
    const site = new Site(raw, lot.site);
    const id = exampleFor(lot.site.fit);
    const dir = path.join(tmp, lot.id);
    let r;
    try {
      r = await buildDesign(id, { out: dir, site, max: lot.max });
    } catch (e) {
      out.push({ lot: lot.id, entry: id, ok: false, errors: [`build: ${e.message}`], siteFindings: [], ports: [] });
      continue;
    }
    const sidecar = JSON.parse(fs.readFileSync(r.written.jsonPath, 'utf8'));
    out.push({ lot: lot.id, entry: id, ok: r.result.ok, errors: r.result.errors, warnings: r.result.warnings, siteFindings: r.result.site?.findings ?? [], siteMetrics: r.result.site?.metrics ?? null, ports: sidecar.ports ?? [], sidecar, dir, site, nbt: r.written.nbtPath });
  }
  return out;
}
