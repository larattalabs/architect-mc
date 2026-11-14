// (M5 FK, S-M5-3) Filled containers and lock cells of a given program's entry (docs/CONTRACT.md "### FK contract").
//
// A program declares, from its build, the containers Architect fills once after every core cell stands and the lock cells that keep its
// circuit locked until then:
//
//   bp.fill({ containers: [{ at: [x, y, z], items: [{ slot, id, count }] }], locks: [{ at: [x, y, z], locked: { prop: value } }] })
//
// Coordinates are design coordinates (as bp.set); the sidecar records template coordinates as `fill: {containers, locks}`. The template
// holds each lock cell's final, unlocked state; `locked` overrides properties of that same block. The kit checks the shape and the cells
// (checkFill, rule `fill`); the mod checks what the kit can't know (an item's max stack, a locked state's cost).
import { normalize } from './blocks.mjs';

/** Steward's bound (CONTRACT M5-3): at most this many declared containers per entry (Java `Limits.FILL_CONTAINERS_MAX`). */
export const FILL_CONTAINERS_MAX = 64;
/** At most this many lock cells per entry (Java `Limits.FILL_LOCKS_MAX`). */
export const FILL_LOCKS_MAX = 64;
/** The containers a fill may declare, with their slot counts. Shulker boxes are left out: their item carries what they hold. */
export const FILL_CONTAINERS = Object.freeze({
  'minecraft:hopper': 5,
  'minecraft:chest': 27,
  'minecraft:trapped_chest': 27,
  'minecraft:barrel': 27,
  'minecraft:dropper': 9,
  'minecraft:dispenser': 9,
});
/**
 * (Steward's review A) The lock properties vanilla keeps as written, per block: a lock must hold until the unlock. A hopper's `enabled`
 * (recomputed on a neighbour update), a torch's `lit` (on its tick), a wire's power, a repeater's or comparator's `powered` are not.
 */
export const LOCK_PROPS = Object.freeze({ 'minecraft:lever': Object.freeze(['powered']) });
/** The most of one item a slot may hold (the mod checks the item's own max stack). */
export const FILL_STACK_MAX = 64;
const ITEM_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

function cellOf(at, where) {
  if (!Array.isArray(at) || at.length !== 3 || !at.every(Number.isInteger)) throw new Error(`fill: ${where}.at must be [x, y, z] integers`);
  return at;
}

/**
 * The declaration as the sidecar records it (template coordinates, slots sorted, ids qualified). Throws on a malformed shape; the cell
 * rules (what stands at each cell) are checkFill's, run by the checker on the written files.
 */
export function normalizeFill(spec, origin = [0, 0, 0]) {
  if (!spec || typeof spec !== 'object') throw new Error('fill: must be an object {containers, locks}');
  const containers = spec.containers ?? [];
  const locks = spec.locks ?? [];
  if (!Array.isArray(containers) || !Array.isArray(locks)) throw new Error('fill: containers and locks must be lists');
  const t = (at, where) => { const [x, y, z] = cellOf(at, where); return [x + origin[0], y + origin[1], z + origin[2]]; };
  return {
    containers: containers.map((c, i) => {
      if (!c || typeof c !== 'object' || !Array.isArray(c.items)) throw new Error(`fill: containers[${i}] must be {at, items: [{slot, id, count}]}`);
      return {
        at: t(c.at, `containers[${i}]`),
        items: c.items.map((it, j) => {
          if (!it || typeof it !== 'object') throw new Error(`fill: containers[${i}].items[${j}] must be {slot, id, count}`);
          const id = typeof it.id === 'string' && !it.id.includes(':') ? `minecraft:${it.id}` : it.id;
          return { slot: it.slot, id, count: it.count };
        }).sort((a, b) => a.slot - b.slot),
      };
    }),
    locks: locks.map((l, i) => {
      if (!l || typeof l !== 'object' || !l.locked || typeof l.locked !== 'object') throw new Error(`fill: locks[${i}] must be {at, locked: {prop: value}}`);
      return { at: t(l.at, `locks[${i}]`), locked: Object.fromEntries(Object.entries(l.locked).map(([k, v]) => [k, String(v)])) };
    }),
  };
}

/**
 * The checker's rule `fill`: error lines (each starts `fill:`) for a sidecar's `fill` over the template's cells (`cells`: "x,y,z" ->
 * {name, props}). Empty when there is no fill or it is sound.
 */
export function checkFill(fill, cells, size) {
  if (fill === undefined) return [];
  const out = [];
  const e = (m) => out.push(`fill: ${m}`);
  if (!fill || typeof fill !== 'object' || !Array.isArray(fill.containers) || !Array.isArray(fill.locks)) return ['fill: must be {containers: [...], locks: [...]}'];
  if (fill.containers.length === 0) e('declares no container (a fill needs at least one)');
  if (fill.containers.length > FILL_CONTAINERS_MAX) e(`declares ${fill.containers.length} containers (at most ${FILL_CONTAINERS_MAX})`);
  if (fill.locks.length > FILL_LOCKS_MAX) e(`declares ${fill.locks.length} lock cells (at most ${FILL_LOCKS_MAX})`);
  const seen = new Set();
  const inBox = (a) => a.every((v, i) => v >= 0 && v < size[i]);
  const at = (a, where) => {
    if (!Array.isArray(a) || a.length !== 3 || !a.every(Number.isInteger)) { e(`${where}: at must be [x, y, z] integers`); return null; }
    const k = a.join(',');
    if (!inBox(a)) { e(`${where}: cell ${k} is outside the template (${size.join('x')})`); return null; }
    if (seen.has(k)) { e(`${where}: cell ${k} is declared twice`); return null; }
    seen.add(k);
    return k;
  };
  for (const [i, c] of fill.containers.entries()) {
    const where = `containers[${i}]`;
    const k = at(c?.at, where);
    if (k === null) continue;
    const st = cells.get(k);
    const slots = st ? FILL_CONTAINERS[st.name] : undefined;
    if (!st) { e(`${where}: cell ${k} holds no block (a declared container must be one of ${Object.keys(FILL_CONTAINERS).join(', ')})`); continue; }
    if (slots === undefined) { e(`${where}: ${st.name} at ${k} is not a container a fill may declare (${Object.keys(FILL_CONTAINERS).join(', ')})`); continue; }
    if (!Array.isArray(c.items) || c.items.length === 0) { e(`${where}: items must list 1..${slots} stacks`); continue; }
    if (c.items.length > slots) e(`${where}: ${c.items.length} stacks for a ${st.name} of ${slots} slots`);
    const used = new Set();
    for (const [j, it] of c.items.entries()) {
      const w = `${where}.items[${j}]`;
      if (!Number.isInteger(it?.slot) || it.slot < 0 || it.slot >= slots) e(`${w}: slot ${it?.slot} must be 0..${slots - 1}`);
      else if (used.has(it.slot)) e(`${w}: slot ${it.slot} is filled twice`);
      else used.add(it.slot);
      if (typeof it?.id !== 'string' || !ITEM_ID.test(it.id) || it.id === 'minecraft:air') e(`${w}: id '${it?.id}' must be a plain item id (no components)`);
      if (it && ('components' in it || 'nbt' in it || 'tag' in it)) e(`${w}: a fill stack is plain (no components)`);
      if (!Number.isInteger(it?.count) || it.count < 1 || it.count > FILL_STACK_MAX) e(`${w}: count ${it?.count} must be 1..${FILL_STACK_MAX}`);
    }
  }
  for (const [i, l] of fill.locks.entries()) {
    const where = `locks[${i}]`;
    const k = at(l?.at, where);
    if (k === null) continue;
    const st = cells.get(k);
    if (!st) { e(`${where}: cell ${k} holds no block (a lock is a state of the block the template holds there)`); continue; }
    const locked = l.locked;
    if (!locked || typeof locked !== 'object' || Object.keys(locked).length === 0) { e(`${where}: locked must set at least one property of ${st.name}`); continue; }
    const kept = LOCK_PROPS[st.name] ?? [];
    const notKept = Object.keys(locked).filter((p) => !kept.includes(p));
    if (notKept.length) { e(`${where}: ${st.name}'s ${notKept.join(', ')} at ${k} is not a lock vanilla keeps (a lock is a lever's powered)`); continue; }
    let full;
    try {
      full = normalize(st.name, { ...st.props, ...locked });
    } catch (err) {
      e(`${where}: locked ${JSON.stringify(locked)} is not a state of ${st.name} at ${k} (${err.message})`);
      continue;
    }
    const same = Object.keys(full.props).every((p) => full.props[p] === String(st.props?.[p] ?? full.props[p]));
    if (same) e(`${where}: locked ${JSON.stringify(locked)} is the template's own state at ${k} (the template holds the unlocked state)`);
  }
  return out;
}
