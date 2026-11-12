// (7b SB, "Slice SB as built") A scenario's sculpt: a region program's planned cells written into the world as natural, unowned land
// before the scenario's own plan (S5's giant trees, S6's cavern; S3's flat hill is the precedent, raised with vanilla /fill). The plan's
// virtual world (vworld.mjs buildVirtual over its own survey) gives every cell it writes; `sculptRuns` merges them into boxes of one
// block state (vertical runs per column, then equal runs joined along x, then along z), each one vanilla /fill. `stateClass` is the
// class the game's survey gives a block (lib/region/volume.mjs VOXEL_CLASSES), for the kit's own land models (kit/test/sb-world.mjs).
// Pure, deterministic: the runs are sorted by state, then y0, x0, z0.
import { buildVirtual } from './vworld.mjs';
import { decodeArvx } from './volume.mjs';

/**
 * The sculpt's cells as boxes of one state: [{state, x0, y0, z0, x1, y1, z1}] (inclusive). `ir`, `survey` (the plan's survey bytes)
 * and `blobs(sha)` as buildVirtual takes them. Every written cell is covered exactly once.
 */
export function sculptRuns(ir, survey, blobs) {
  // the frozen volumes the sculpt read are its base where they cover (a clearing writes air over the volume's leaves: over the survey
  // alone those cells read air, so the write would be no change and no /fill would clear them)
  const volumes = Object.values(ir.volumes ?? {}).map((u) => { const b = blobs(ir.blobs?.[u.blob]?.sha); return b ? decodeArvx(b) : null; }).filter(Boolean); // (decodeArvx takes gzip or raw)
  const { vw } = buildVirtual({ ir, survey, blobs, volumes });
  const cells = new Map(); // "x,z" -> [[y, state]]
  vw.eachWritten((x, y, z, idx) => {
    const k = `${x},${z}`;
    let c = cells.get(k);
    if (!c) { c = []; cells.set(k, c); }
    c.push([y, vw.pal.states[idx]]);
  });
  // vertical runs per column
  let runs = [];
  for (const [k, list] of cells) {
    const [x, z] = k.split(',').map(Number);
    list.sort((a, b) => a[0] - b[0]);
    let cur = null;
    for (const [y, st] of list) {
      if (cur && cur.state === st && y === cur.y1 + 1) { cur.y1 = y; continue; }
      if (cur) runs.push(cur);
      cur = { state: st, x0: x, x1: x, z0: z, z1: z, y0: y, y1: y };
    }
    if (cur) runs.push(cur);
  }
  // join equal runs along x, then along z
  const join = (list, axis) => {
    const key = (r) => (axis === 'x' ? `${r.state}|${r.y0}|${r.y1}|${r.z0}|${r.z1}` : `${r.state}|${r.y0}|${r.y1}|${r.x0}|${r.x1}`);
    const groups = new Map();
    for (const r of list) { const g = groups.get(key(r)); if (g) g.push(r); else groups.set(key(r), [r]); }
    const out = [];
    for (const g of groups.values()) {
      g.sort((a, b) => (axis === 'x' ? a.x0 - b.x0 : a.z0 - b.z0));
      let cur = null;
      for (const r of g) {
        if (cur && (axis === 'x' ? r.x0 === cur.x1 + 1 : r.z0 === cur.z1 + 1)) { if (axis === 'x') cur.x1 = r.x1; else cur.z1 = r.z1; continue; }
        if (cur) out.push(cur);
        cur = { ...r };
      }
      if (cur) out.push(cur);
    }
    return out;
  };
  runs = join(join(runs, 'x'), 'z');
  runs.sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : a.y0 - b.y0 || a.x0 - b.x0 || a.z0 - b.z0));
  return runs;
}

/** The vanilla /fill command of a run (a state string as vworld holds it: `minecraft:id[props]`). */
export const fillCommand = (r) => `/fill ${r.x0} ${r.y0} ${r.z0} ${r.x1} ${r.y1} ${r.z1} ${r.state}`;

/** The survey class of a block state, as the game's VolumeSurvey gives it (the kit's land models only; the game's table is the truth). */
export function stateClass(state) {
  const id = String(state).replace(/\[.*$/, '').replace(/^minecraft:/, '');
  if (id === 'air' || id === 'cave_air' || id === 'void_air') return 'AIR';
  if (id === 'water') return 'WATER';
  if (id === 'lava') return 'LAVA';
  if (/_log$|_wood$|_stem$|_hyphae$/.test(id)) return 'LOG';
  if (/_leaves$|wart_block$|shroomlight/.test(id)) return 'LEAVES';
  if (/^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mud|mycelium|moss_block|clay|farmland|dirt_path)$/.test(id)) return 'SOIL';
  if (/^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/.test(id)) return 'LOOSE';
  if (/^(lantern|torch|wall_torch|chain|iron_chain|soul_lantern|mangrove_roots|hanging_roots|pointed_dripstone)$/.test(id) || /_roots$/.test(id)) return 'PLANT';
  return 'ROCK';
}
