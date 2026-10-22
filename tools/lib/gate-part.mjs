// A driver's side of a split step (tools/lib/step-split.mjs, docs/GATES.md "Turbo": "Split steps").
//
// A driver whose step is split names its independent sections (worlds, fixtures, scenarios, item groups) and asks `want(name)`
// before each. The runner sets, per part:
//   GATE_PART           k/N
//   GATE_PART_SECTIONS  this part's sections
//   GATE_PART_ALL       every part's sections together (the union the split config names)
// Unset (a whole step, a named chain, by hand): every section runs, exactly as before. Set: the driver checks that its own section
// list equals GATE_PART_ALL (a section the split leaves out, or one it names that the driver lacks, throws before anything runs:
// a split can never silently drop assertions), then runs only GATE_PART_SECTIONS and prints one `part k/N: ...` line (neither ok
// nor FAIL).

/** -> { want(name), sections: [names this process runs], part: 'k/N' | null }. `all`: the driver's sections in its order. */
export function gatePart(all, { env = process.env, log = console.log, legacy = null } = {}) {
  const mine = (env.GATE_PART_SECTIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!mine.length) {
    // a development filter the driver had before (e.g. IRR_ONLY): kept as it was
    if (legacy?.length) return { want: (s) => legacy.includes(s), sections: all.filter((s) => legacy.includes(s)), part: null };
    return { want: () => true, sections: [...all], part: null };
  }
  const union = (env.GATE_PART_ALL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = [...mine, ...union].filter((s) => !all.includes(s));
  if (unknown.length) throw new Error(`split part ${env.GATE_PART ?? '?'}: unknown section(s) ${[...new Set(unknown)].join(',')} (the driver's: ${all.join(',')})`);
  if (!union.length) throw new Error(`split part ${env.GATE_PART ?? '?'}: GATE_PART_ALL unset (the runner sets every part's sections together)`);
  const left = all.filter((s) => !union.includes(s));
  if (left.length) throw new Error(`split part ${env.GATE_PART ?? '?'}: the split's parts leave out section(s) ${left.join(',')}: every section must be in exactly one part`);
  log(`part ${env.GATE_PART ?? '?'}: sections ${mine.join(',')} (of ${all.join(',')})`);
  return { want: (s) => mine.includes(s), sections: all.filter((s) => mine.includes(s)), part: env.GATE_PART ?? null };
}

/**
 * A fixture loop split into `n` round-robin slices (sections `<name>-1` .. `<name>-n`, a split unit step's parts each taking some):
 * -> null when this process runs every slice (the loop runs whole, exactly as before), else the slices it runs ([{k, n}]).
 * `inSlice(i, sl)`: whether the loop's i-th fixture (0-based, in its full order) is in them. A sliced loop still walks every
 * fixture's cheap eligibility and counts the ones another part plans, so its totals (the "at least N fixtures" checks) are the
 * whole loop's.
 */
export function slicesOf(P, name, n) {
  const ks = Array.from({ length: n }, (_, i) => i + 1).filter((k) => P.want(`${name}-${k}`));
  return ks.length === n ? null : ks.map((k) => ({ k, n }));
}
export const sliceSections = (name, n) => Array.from({ length: n }, (_, i) => `${name}-${i + 1}`);
export const inSlice = (i, sl) => !sl || sl.some((s) => i % s.n === s.k - 1);
