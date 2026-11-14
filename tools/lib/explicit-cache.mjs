// The step cache for explicit lists (`--only` / `--from`; docs/GATES.md "Slice GX as built"). A tier run with an explicit list
// used to run every step it named. Now it reuses a recorded PASS whose key is unchanged, except:
//   - the slice's own steps always run: those `--own` names, and the steps the range adds or changes (a new step id, a changed
//     chain entry, or a changed file its command names: the driver and the helpers its shell calls);
//   - a strict-tier step (tools/gate-cache.json `explicit.strict`: save data, billing, refunds and stock, undo, crash recovery,
//     anything that can mint or lose items) takes only an exact key hit: never a coverage hit, whose input set moved;
//   - an entry from another platform (or one recorded before the platform was) never serves an explicit list.
// A dirty tree has no key and a different Node or JDK is a different key (tools/lib/step-cache.mjs), so neither ever hits.
// `--no-cache` turns it off. Pure functions: the runner gives them the chain files, the range's files and the lookups.

import { parentOf } from './step-split.mjs';

/** This process's platform as recorded in a cache entry. */
export const platformNow = () => `${process.platform}-${process.arch}`;

const DEF_SKIP = new Set(['desc', 'estMin', 'timeoutMin', 'supersededBy']);
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}
/** A chain entry as it decides a result: desc, estMin, timeoutMin and supersededBy aside (as gate-history's stepDefinition). */
export function entryShape(e) {
  if (!e) return null;
  return JSON.stringify(canon(Object.fromEntries(Object.entries(e).filter(([k]) => !DEF_SKIP.has(k)))));
}

/** The repo paths a step's command names: tools/..., kit/..., scenarios/... tokens of its shell or cmd. */
export function commandPaths(entry) {
  const text = entry?.shell ?? (Array.isArray(entry?.cmd) ? entry.cmd.join(' ') : '');
  const out = new Set();
  for (const m of String(text).matchAll(/(?:^|[\s'"=;(&|])((?:tools|kit|scenarios|sidecar|mod)\/[\w./-]+)/g)) out.add(m[1].replace(/[;,)]+$/, ''));
  return [...out];
}

/**
 * The own steps of an explicit run: -> Map(id -> why). ids: the run's step ids (parts allowed); now/base: the raw chain files'
 * `steps` at HEAD and at the range's base (base null: no range, so only --own and the files decide); files: the range's changed
 * files (or --files); own: the --own list (ids or parents).
 */
export function ownSteps({ ids, now, base, files = [], own = [] }) {
  const out = new Map();
  const changed = new Set(files);
  const ownSet = new Set(own.map(parentOf));
  for (const id of ids) {
    const pid = parentOf(id);
    const why = [];
    if (ownSet.has(pid) || own.includes(id)) why.push('--own names it');
    if (base) {
      if (!base[pid]) why.push('a new step in this range');
      else if (entryShape(base[pid]) !== entryShape(now[pid])) why.push('its chain entry changed in this range');
    }
    const touched = commandPaths(now[pid]).filter((p) => changed.has(p));
    if (touched.length) why.push(`its command's ${touched.join(', ')} changed`);
    if (why.length) out.set(id, why.join('; '));
  }
  return out;
}

/** Whether a step is strict tier: conf = gate-cache.json `explicit` ({ strict: { ids: [], pattern: "regex" } }). */
export function isStrict(conf, id) {
  const pid = parentOf(id);
  const s = conf?.strict ?? {};
  if ((s.ids ?? []).includes(pid)) return true;
  return s.pattern ? new RegExp(s.pattern).test(pid) : false;
}

/**
 * One step's decision in an explicit run. own: why it is own (or null); strict: bool; key: its key now ({ key, why }); exact: the
 * exact-key lookup ({ hit, why }); coverage: () => the coverage lookup ({ hit, why }) or null when the step has no coverage mode.
 * -> { hit: entry | null, why }.
 */
export function explicitDecision({ own, strict, key, exact, coverage = null, platform = platformNow() }) {
  if (own) return { hit: null, why: `own step: always runs (${own})` };
  if (!key?.key) return { hit: null, why: `no key: ${key?.why ?? 'unknown'}` };
  const plat = (e) => (e.platform === platform ? null : e.platform ? `recorded on ${e.platform}, this is ${platform}` : 'recorded before entries carried a platform');
  if (exact?.hit) {
    if (exact.hit.key !== key.key) return { hit: null, why: 'entry mismatch' };
    const p = plat(exact.hit);
    if (p) return { hit: null, why: `cache: ${p}` };
    return { hit: exact.hit, why: exact.why };
  }
  if (strict) return { hit: null, why: `strict tier: exact key only (${exact?.why ?? 'no recorded PASS for this key'})` };
  const c = coverage ? coverage() : null;
  if (c?.hit) {
    const p = plat(c.hit);
    if (p) return { hit: null, why: `cache: ${p}` };
    return c;
  }
  return { hit: null, why: c ? `${exact?.why ?? 'no recorded PASS'}; coverage: ${c.why}` : exact?.why ?? 'no recorded PASS for this key' };
}
