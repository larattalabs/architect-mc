// (M5 FC) A lot's `field` member, validated (params.mjs validateLots): no imports, so params.mjs can take it without a cycle (field.mjs
// reaches irrigate.mjs, which imports params.mjs).

/** The crop blocks a field may name: single-block crops on farmland (the mod's FieldCells.CROPS). */
export const FIELD_CROPS = ['minecraft:wheat', 'minecraft:carrots', 'minecraft:potatoes', 'minecraft:beetroots', 'minecraft:torchflower_crop'];
/** At most this many farmland cells per field. */
export const FIELD_CELLS_MAX = 4096;

/** Validates a lot's `field` (validateLots); throws with `where`. Returns `{cells: [[u, y, v]...] (unique, in order), crops: [ids]}`. */
export function parseField(f, where = 'field') {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error(`${where} must be {cells: [[u, y, v], ...], crops: [ids]}`);
  for (const k of Object.keys(f)) if (!['cells', 'crops'].includes(k)) throw new Error(`${where}: unknown member '${k}'`);
  if (!Array.isArray(f.cells) || !f.cells.length || f.cells.length > FIELD_CELLS_MAX) throw new Error(`${where}.cells must be 1..${FIELD_CELLS_MAX} cells [u, y, v]`);
  const seen = new Set(), cells = [];
  for (const c of f.cells) {
    if (!Array.isArray(c) || c.length !== 3 || !c.every(Number.isInteger) || c[0] < 0 || c[2] < 0 || c[0] > 255 || c[2] > 255 || Math.abs(c[1]) > 64) {
      throw new Error(`${where}.cells: each cell is [u, y, v] integers (u, v 0..255, |y| <= 64), got ${JSON.stringify(c)?.slice(0, 40)}`);
    }
    const k = c.join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    cells.push([...c]);
  }
  if (!Array.isArray(f.crops) || !f.crops.length || f.crops.length > FIELD_CROPS.length || !f.crops.every((c) => FIELD_CROPS.includes(c))) {
    throw new Error(`${where}.crops must be 1..${FIELD_CROPS.length} of ${FIELD_CROPS.join(', ')}`);
  }
  return { cells, crops: [...new Set(f.crops)] };
}
