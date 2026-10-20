// (6c VOC-c) Family groups and the names a `rule.palette` measures (docs/CONTRACT.md "Phase 6c slice VOC-c" §1.1, N-VOCc-1).
// A group is a fixed union of vocabulary families (kit/lib/vocab.mjs familyOf), a closed list here, generated into vocab/1's `groups`
// (kit/tools/vocab-derive.mjs). One group in VOC-c: `wood`, the 13 woods of kit.mjs WOODS, every member of their families (leaves
// and saplings are outside those families already). A new group is a later additive change.
import { BLOCKS, qualify } from '../blocks.mjs';
import { familyOf } from '../vocab.mjs';
import { WOODS } from '../kit.mjs';

/** The groups: name -> its families (sorted). */
export const GROUPS = Object.freeze({ wood: Object.freeze([...WOODS].sort()) });

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
let FAMS = null;
/** family -> its block ids (qualified, sorted). */
function families() {
  if (FAMS) return FAMS;
  FAMS = new Map();
  for (const id of Object.keys(BLOCKS).sort(cmp)) {
    const f = familyOf(id);
    if (!f) continue;
    if (!FAMS.has(f)) FAMS.set(f, []);
    FAMS.get(f).push(id);
  }
  return FAMS;
}

/** Whether `name` is a vocabulary family. */
export const isFamily = (name) => typeof name === 'string' && families().has(name);

/**
 * A `rule.palette` family resolved: `{kind: 'family' | 'group', name, families: [names], blocks: [ids, sorted]}`, or null when the name
 * is neither a family nor a group.
 */
export function resolvePalette(name) {
  if (typeof name !== 'string' || !name) return null;
  const fams = Object.prototype.hasOwnProperty.call(GROUPS, name) ? { kind: 'group', families: [...GROUPS[name]] } : isFamily(name) ? { kind: 'family', families: [name] } : null;
  if (!fams) return null;
  const blocks = fams.families.flatMap((f) => families().get(f) ?? []).sort(cmp);
  return { kind: fams.kind, name, families: fams.families, blocks };
}

/**
 * The nearest family (or group) by name (§3's `wouldFit` for an unknown family): the name normalised (lower case, `minecraft:`
 * dropped, spaces and dashes as `_`, a trailing `s`, `_family` or `_blocks` dropped), or a block id whose family it is. Null when
 * none resolves (`moss_stone_spruce_oak`, `family_colours`).
 */
export function nearestFamily(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
  const tries = [n, n.replace(/_(family|blocks?)$/, ''), n.replace(/s$/, '')];
  for (const t of tries) if (t && t !== name && resolvePalette(t)) return t;
  for (const t of tries) {
    if (!t || !BLOCKS[qualify(t)]) continue;
    const f = familyOf(qualify(t));
    if (f && f !== name) return f;
  }
  return null;
}
