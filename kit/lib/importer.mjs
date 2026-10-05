// Importing a vanilla structure file (a structure-block save, or any .nbt template) as a library entry
// (docs/CONTRACT.md "Import / export"): type custom, groundY 1, front south, the entrance at the front centre just
// outside the box, spawn 2 further out, `imported: true`, no source (so no variants).
//
// The template is normalised before the check: the first of several `palettes` (a jigsaw-style file) becomes the
// palette and entities are dropped (placement and Remove only restore blocks). Everything else is kept as saved,
// DataVersion included, so the mod's data fixer upgrades an older save on load. The checker (imported mode) reads
// older palette keys (Name/Properties), lets missing properties take their defaults, and reports every unknown or
// non-vanilla block in one error.
import { nbt } from './nbt.mjs';
import { BLOCKS, collisionOf, opticsOf } from './blocks.mjs';

/** "my_old-house v2.nbt" -> "My Old House V2" */
export function nameFromFile(file) {
  const base = String(file).replace(/^.*[\\/]/, '').replace(/\.nbt$/i, '');
  const words = base.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 40).trim();
  return name || 'Imported Structure';
}

const isFull = (name) => !!BLOCKS[name] && collisionOf({ name, props: {} }) === 'full' && opticsOf({ name, props: {} }) === 'opaque';

/**
 * @param {object} root the parsed (tagged) structure NBT
 * @param {{id:string, name?:string, file?:string}} o
 * @returns {{ structure: object, sidecar: object, warnings: string[], errors: string[] }}
 *   `structure` is the tagged root to write; `errors` are format problems that make the file unusable
 */
export function prepareImport(root, { id, name, file = '' }) {
  const warnings = [];
  const errors = [];
  const v = { ...root.v };
  if (v.palette === undefined && v.palettes?.t === 'list' && v.palettes.v.length) {
    v.palette = v.palettes.v[0];
    if (v.palettes.v.length > 1) warnings.push(`the file has ${v.palettes.v.length} palettes: the first one is used`);
  }
  delete v.palettes;
  const size = v.size?.t === 'list' ? v.size.v.map((t) => t.v) : null;
  if (!size || size.length !== 3 || !size.every((n) => Number.isInteger(n) && n > 0)) errors.push('structure: no valid size (is it a structure file?)');
  if (v.palette?.t !== 'list' || v.blocks?.t !== 'list') errors.push('structure: no palette or blocks (is it a structure file?)');
  if (v.DataVersion?.t !== 'int') errors.push('structure: DataVersion missing');
  if (errors.length) return { structure: root, sidecar: null, warnings, errors };

  // entities: dropped (a template carries blocks only)
  const ents = v.entities?.t === 'list' ? v.entities.v : [];
  if (ents.length) {
    const kinds = new Map();
    for (const e of ents) {
      const id = e.v?.nbt?.v?.id?.v ?? 'entity';
      kinds.set(id, (kinds.get(id) ?? 0) + 1);
    }
    warnings.push(`${ents.length} entit${ents.length === 1 ? 'y' : 'ies'} dropped (${[...kinds].map(([k, n]) => `${k.replace('minecraft:', '')} x${n}`).join(', ')}): Architect places blocks only`);
  }
  v.entities = nbt.list('compound', []);

  // what the sidecar lists
  const palette = v.palette.v.map((e) => e.v?.id?.v ?? e.v?.Name?.v);
  const count = new Map();
  const floorCount = new Map();
  for (const b of v.blocks.v) {
    const n = palette[b.v.state?.v];
    if (typeof n !== 'string' || !BLOCKS[n] || BLOCKS[n].family === 'air') continue;
    count.set(n, (count.get(n) ?? 0) + 1);
    if (b.v.pos?.v?.[1]?.v === 0 && isFull(n)) floorCount.set(n, (floorCount.get(n) ?? 0) + 1);
  }
  const byUse = (m) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
  const [sx, sy, sz] = size;
  const cx = Math.floor(sx / 2) + 0.5;
  const sidecar = {
    id,
    name: name || nameFromFile(file),
    description: `Imported from ${String(file).replace(/^.*[\\/]/, '') || 'a structure file'}.`,
    type: 'custom',
    tags: ['imported'],
    size: { x: sx, y: sy, z: sz },
    groundY: 1,
    front: 'south',
    materials: byUse(count),
    foundationBlock: byUse(floorCount)[0] ?? 'minecraft:stone',
    approach: { length: 0, width: 3, block: 'minecraft:dirt_path', slab: 'minecraft:cobblestone_slab' },
    anchors: {
      entrance: { x: cx, y: 1, z: sz + 0.5, yaw: 180, pitch: 0 },
      spawn: { x: cx, y: 1, z: sz + 2.5, yaw: 180, pitch: 0 },
      cam_overview: camera([-6, sy + 4, sz + 8], [sx / 2, sy / 3, sz / 2]),
    },
    imported: true,
  };
  return { structure: nbt.compound(v), sidecar, warnings, errors };
}

function camera([ex, ey, ez], [lx, ly, lz]) {
  const r3 = (n) => Math.round(n * 1000) / 1000 || 0;
  const dx = lx - ex;
  const dy = ly - ey;
  const dz = lz - ez;
  return { x: ex, y: ey, z: ez, yaw: r3((Math.atan2(-dx, dz) * 180) / Math.PI), pitch: r3((-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI) };
}
