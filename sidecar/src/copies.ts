// Slice 0b (docs/CONTRACT.md "Phase 6c slice 0b" §2, §3, §4): copies in a design group and the small-item rules.
//
//   - expansion: an item with `count` n becomes <key>, <key>#2 ... <key>#n. Every copyCap-th placement starts a new
//     archetype (an original); the others are $0 copies of the archetype before them. A landmark's extra count becomes
//     originals. `copyOf` X makes the item a copy of X's archetype (counting toward its cap). Refusals: COPY_REFUSED with
//     detail landmark | unknown | self | cap.
//   - a copy waits for its archetype to be DONE, then builds in stage COPY on the VariantRunner from the archetype's entry
//     with a recipe (kit/lib/variation.mjs): seconds, no Claude. Up to 3 recipes; when all fail the item becomes a
//     FALLBACK original (under massingFirst a detail pass bound to the archetype's approved massing, no new approval).
//     A dropped, cancelled or failed archetype fails its copies with `source_failed`.
//   - small items (C2, C8): effort SMALL, or with smallBySize an item whose maxSize footprint fits 11 x 9 either way. A
//     small item skips the group-default report critique (its own critique still wins) and runs the bounded detail pass.
import type { CritiqueSpec, DesignRequest, GroupItemInput, GroupRequest } from './protocol.js';
import { MAX_GROUP_ITEMS } from './protocol.js';
import { ClientError, RefusedError } from './errors.js';

/** Steward's S lot minus the approach margin (S-0b-1): a footprint that fits 11 x 9 either way. */
export const SMALL_FOOTPRINT = { a: 11, b: 9 } as const;
export const DEFAULT_COPY_CAP = 3;

/** One placement after expansion. */
export interface ExpandedItem {
  itemKey: string;
  /** the input item (count, copyOf and effort stripped) */
  input: Omit<GroupItemInput, 'count' | 'copyOf' | 'effort'>;
  /** the input item's key (the same for every placement of one input) */
  inputKey: string;
  kind: 'original' | 'copy';
  /** a copy: its archetype's (expanded) key */
  copyOf?: string;
  /** a copy: its place among its archetype's copies (1, 2, ...) */
  ordinal?: number;
  /** a later archetype of a counted item: the note its brief gets */
  note?: string;
  effort: 'standard' | 'small';
}

export function fitsSmall(maxSize: { x: number; z: number } | undefined): boolean {
  if (!maxSize) return false;
  const { a, b } = SMALL_FOOTPRINT;
  return (maxSize.x <= a && maxSize.z <= b) || (maxSize.x <= b && maxSize.z <= a);
}

/** C8: an item's effort (AUTO: small by the size rule when the group has smallBySize). */
export function itemEffort(it: Pick<GroupItemInput, 'effort' | 'maxSize'>, smallBySize: boolean | undefined): 'standard' | 'small' {
  if (it.effort === 'small') return 'small';
  if (it.effort === 'standard') return 'standard';
  return smallBySize && fitsSmall(it.maxSize) ? 'small' : 'standard';
}

/** C2: the critique an item runs: its own wins; a small item drops the group's default report critique. */
export function itemCritique(own: CritiqueSpec | undefined, groupDefault: CritiqueSpec | undefined, effort: 'standard' | 'small'): CritiqueSpec | undefined {
  if (own) return own;
  if (effort === 'small' && groupDefault && (groupDefault.mode ?? 'report') === 'report') return undefined;
  return groupDefault;
}

/** Expand a group request's items (count, copyOf, copyCap). Throws RefusedError(COPY_REFUSED) or ClientError. */
export function expandItems(req: GroupRequest): ExpandedItem[] {
  const cap = req.copyCap ?? DEFAULT_COPY_CAP;
  const inputs = req.items.map((it, i) => ({ it, key: it.itemKey ?? `item${i + 1}` }));
  const byKey = new Map(inputs.map((x) => [x.key, x]));
  // pass 1: the items that are not copies of another item
  const out: Array<ExpandedItem | { pending: (typeof inputs)[number] }> = [];
  /** archetype key -> placements it covers (itself + its copies) */
  const members = new Map<string, number>();
  /** input key -> its first archetype's key */
  const archetypeOf = new Map<string, string>();
  for (const x of inputs) {
    const { count, copyOf, effort: _e, ...input } = x.it;
    const effort = itemEffort(x.it, req.smallBySize);
    if (copyOf !== undefined) {
      out.push({ pending: x });
      continue;
    }
    const n = count ?? 1;
    const landmark = (x.it.role ?? 'ordinary') === 'landmark';
    let arch: string | undefined;
    for (let i = 1; i <= n; i++) {
      const key = i === 1 ? x.key : `${x.key}#${i}`;
      if (landmark || (i - 1) % cap === 0) {
        out.push({ itemKey: key, input, inputKey: x.key, kind: 'original', effort, ...(i > 1 ? { note: `another design for the same program, not a near-copy of \`${x.key}\`` } : {}) });
        arch = key;
        members.set(key, 1);
        if (i === 1) archetypeOf.set(x.key, key);
      } else {
        const ord = members.get(arch!)!;
        members.set(arch!, ord + 1);
        out.push({ itemKey: key, input, inputKey: x.key, kind: 'copy', copyOf: arch!, ordinal: ord, effort });
      }
    }
  }
  // pass 2: copyOf items (in order; a chain resolves to its archetype)
  const resolving = new Set<string>();
  const resolve = (key: string, from: string): string => {
    if (key === from) throw new RefusedError('COPY_REFUSED', 'self', `item ${from}: copyOf names itself`);
    const target = byKey.get(key);
    if (!target) throw new RefusedError('COPY_REFUSED', 'unknown', `item ${from}: copyOf "${key}" is not an item of this group`);
    if ((target.it.role ?? 'ordinary') === 'landmark') throw new RefusedError('COPY_REFUSED', 'landmark', `item ${from}: copyOf "${key}" is a landmark (landmarks are never copied)`);
    if (target.it.copyOf === undefined) return archetypeOf.get(key)!;
    if (resolving.has(key)) throw new RefusedError('COPY_REFUSED', 'self', `item ${from}: copyOf goes round in a circle through "${key}"`);
    resolving.add(key);
    try {
      return resolve(target.it.copyOf, key);
    } finally {
      resolving.delete(key);
    }
  };
  const final: ExpandedItem[] = [];
  for (const e of out) {
    if (!('pending' in e)) {
      final.push(e);
      continue;
    }
    const x = e.pending;
    const { count, copyOf, effort: _e, ...input } = x.it;
    const arch = resolve(copyOf!, x.key);
    const effort = itemEffort(x.it, req.smallBySize);
    for (let i = 1; i <= (count ?? 1); i++) {
      const key = i === 1 ? x.key : `${x.key}#${i}`;
      const ord = members.get(arch)!;
      if (ord + 1 > cap) throw new RefusedError('COPY_REFUSED', 'cap', `item ${key}: ${arch} already has ${ord} placement${ord === 1 ? '' : 's'} of the copyCap ${cap}`);
      members.set(arch, ord + 1);
      final.push({ itemKey: key, input, inputKey: x.key, kind: 'copy', copyOf: arch, ordinal: ord, effort });
    }
  }
  if (final.length > MAX_GROUP_ITEMS) throw new ClientError(`the group expands to ${final.length} placements, over the ${MAX_GROUP_ITEMS} a group may have`);
  return final;
}

/** The notes a later archetype's request carries. */
export function withNote(req: DesignRequest, note: string | undefined): DesignRequest {
  if (!note) return req;
  const notes = req.notes ? `${req.notes}\n\n${note}` : note;
  return { ...req, notes: notes.slice(0, 2000) };
}

/** Sim faults on a copy (in its request's notes or ext): every recipe fails the check, or the size. */
export const SIM_COPY_FAIL = 'sim:copyfail';
export const SIM_COPY_SIZE = 'sim:copysize';
