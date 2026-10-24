// (Noah, 2026-10-24: "everything should be themed / fit") The theme rule over a plan's virtual world: every block a generator or
// connector writes traces to one of the plan's roles (the role's block, or its slab, stairs, wall, fence, fence gate, door, ... from
// the 26.3 shape tables: connectors/style.mjs traceRole), to the light role's W fixture, or to the short shared allowlist of
// functional blocks (UNTHEMED_OK: ladders, air, fluids, chains). Lot interiors (a design's own palette) and natural material (vworld's natural flag: a form's trees, rock, ice, snow, flowers,
// sand: the land's own look) are not judged here.
import { traceRole } from '../connectors/style.mjs';
import { fixtureFor } from '../region/fixtures.mjs';

const nameOf = (s) => String(s).replace(/\[.*$/, '');
/** Natural decor the forms place that vworld's natural flag misses (a carpet, a root block): the land's look too. */
const NATURAL_DECOR = new Set(['minecraft:moss_carpet', 'minecraft:mangrove_roots', 'minecraft:muddy_mangrove_roots']);

/**
 * Known exceptions (recorded, not gated): the writer, the block, why. Empty since "Theme rest" (docs/CONTRACT.md); the functional ones live in style.mjs UNTHEMED_OK.
 */
export const THEME_KNOWN = Object.freeze([]);
export const knownTheme = (o) => THEME_KNOWN.find((k) => k.part.test(o.part) && k.block === o.block) ?? null;

/**
 * `{offenders: [{part, block, count, sample}], cells}` over `vw`'s written cells outside the lots: a block no role of `ir.roles` (or a
 * role pattern's mats) traces to. `part` is the writing part's id with its trailing ordinal dropped (links_climbs, routes, ...).
 */
export function themeOffenders(ir, vw) {
  const roles = { ...(ir.roles ?? {}) };
  for (const [r, pat] of Object.entries(ir.patterns ?? {})) for (const m of JSON.stringify(pat).match(/minecraft:[a-z0-9_]+/g) ?? []) roles[`${r}~${m}`] = m;
  const light = roles.light ? fixtureFor(roles.light, roles.rail).light : null;
  const memo = new Map();
  const by = new Map();
  let cells = 0;
  const lotPart = new Set((ir.parts ?? []).map((p, i) => (p.set === 'lot' || /^lot[_:]/.test(p.id ?? '') ? i : -1)).filter((i) => i >= 0));
  vw.eachWritten((x, y, z, idx, f, part) => {
    if (lotPart.has(part) || (vw.lotAt && vw.lotAt(x, y, z))) return;
    // (natural material, a form's trees, rock, ice, snow, flowers, sand: the land's own look, not the bible's; vworld's natural flag)
    if (vw.pal.natural[idx] || NATURAL_DECOR.has(nameOf(vw.pal.states[idx]))) return;
    cells++;
    const b = nameOf(vw.pal.states[idx]);
    if (!memo.has(b)) memo.set(b, traceRole(b, roles, { lightFixture: light }));
    if (memo.get(b)) return;
    const pid = String(ir.parts?.[part]?.id ?? '?').replace(/_\d+$/, '');
    const k = `${pid}|${b}`;
    const o = by.get(k) ?? { part: pid, block: b, count: 0, sample: [] };
    o.count++;
    if (o.sample.length < 3) o.sample.push([x, y, z]);
    by.set(k, o);
  });
  return { offenders: [...by.values()].sort((a, b) => a.part.localeCompare(b.part) || a.block.localeCompare(b.block)), cells };
}
