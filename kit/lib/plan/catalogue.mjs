// (6c P0) The capability catalogue (docs/CONTRACT.md P0 §4): plan.json's x-catalogue, versioned, returned with every check and
// committed as a golden per release (kit/schemas/plan-catalogue.golden.json). Block ids are never reused or renamed; a retirement
// is a state. diffCatalogues() is what tools/plan-catalogue-diff.mjs prints: added ids, reserved -> supported, retirements,
// schemaVersion bumps, `until` moves, (7a K1) note changes and (6c T3) limits changes, and which recorded pending parts a newer catalogue tells Steward to recheck.
import { PLAN_SCHEMA, SCHEMA_VERSION } from './schema.mjs';
import { KIT_VERSION } from '../region/plan.mjs';

/** The Java API this kit's catalogue belongs to (set at merge by tools/release-version.mjs; a mod test holds it to ArchitectApi.VERSION). */
export const PLAN_API = '1.56.0';

/** The catalogue as checks return it. */
export function planCatalogue({ api = PLAN_API, kitVersion = KIT_VERSION } = {}) {
  const x = PLAN_SCHEMA['x-catalogue'];
  return {
    catalogueVersion: x.catalogueVersion, api, kitVersion, schemaVersion: SCHEMA_VERSION,
    entries: x.entries.map((e) => {
      const o = { id: e.id, sinceApi: e.sinceApi, schemaVersion: e.schemaVersion, state: e.state };
      for (const k of ['until', 'retiredInApi', 'replacedBy', 'aliasOf', 'limits', 'note']) if (e[k] !== undefined) o[k] = e[k];
      return o;
    }),
  };
}

/**
 * (7cF) The catalogue's long text for the named kinds (docs/CONTRACT.md "Phase 7c" §2, "catalogue text on demand";
 * `Regions.planCatalogue(Set<String> kinds)` answers the same from the mod jar). The compact plan/0 a plan writer reads carries one line
 * per kind (sidecar/src/jobs/systemrefs.ts COMPACT); this serves the rest for the kinds a plan uses or a check answers: the envelope of
 * planCatalogue() with `entries` only the named kinds, in catalogue order, each the full entry plus `def`, the kind's plan/0 definition
 * with every description (a supported entry's `def`, a reserved one's `draft`; absent when it has neither), and `unknown`: the named ids
 * the catalogue lacks, sorted. Pure; a fresh object each call.
 */
export function planCatalogueKinds(kinds, opts = {}) {
  const want = new Set(kinds ?? []);
  const all = planCatalogue(opts);
  const src = new Map(PLAN_SCHEMA['x-catalogue'].entries.map((e) => [e.id, e]));
  const entries = all.entries.filter((e) => want.has(e.id)).map((e) => {
    const ref = src.get(e.id).def ?? src.get(e.id).draft;
    const def = typeof ref === 'string' && ref.startsWith('#/$defs/') ? PLAN_SCHEMA.$defs[ref.slice('#/$defs/'.length)] : undefined;
    return def === undefined ? e : { ...e, def: structuredClone(def) };
  });
  const unknown = [...want].filter((k) => !src.has(k)).sort();
  return { catalogueVersion: all.catalogueVersion, api: all.api, kitVersion: all.kitVersion, schemaVersion: all.schemaVersion, entries, unknown };
}

/**
 * Diff two catalogues by id. `pending`: recorded unsupported answers [{part?, block}] (Steward's pending parts); those whose
 * block the new catalogue supports are flagged for a recheck.
 */
export function diffCatalogues(a, b, { pending = [] } = {}) {
  const A = new Map(a.entries.map((e) => [e.id, e])), B = new Map(b.entries.map((e) => [e.id, e]));
  const out = { from: { catalogueVersion: a.catalogueVersion, api: a.api }, to: { catalogueVersion: b.catalogueVersion, api: b.api }, added: [], removed: [], reservedToSupported: [], retired: [], schemaVersionBumps: [], untilChanged: [], otherStateChanges: [], notesChanged: [], limitsChanged: [], recheck: [] };
  for (const [id, e] of B) {
    const o = A.get(id);
    if (!o) { out.added.push({ id, state: e.state }); continue; }
    if (o.state === 'reserved' && e.state === 'supported') out.reservedToSupported.push(id);
    else if (e.state === 'retired' && o.state !== 'retired') out.retired.push({ id, retiredInApi: e.retiredInApi ?? null, replacedBy: e.replacedBy ?? null });
    else if (o.state !== e.state) out.otherStateChanges.push({ id, from: o.state, to: e.state });
    if (o.schemaVersion !== e.schemaVersion) out.schemaVersionBumps.push({ id, from: o.schemaVersion, to: e.schemaVersion });
    if ((o.until ?? null) !== (e.until ?? null) && e.state === 'reserved') out.untilChanged.push({ id, from: o.until ?? null, to: e.until ?? null });
    // (7a K1) a note added, changed or dropped (K1 adds locator.around's "on a wall: wall.around")
    // (6c H) a note that arrives with a flip (connector.channel's) comes with the flip, as a flip's new limits do
    if ((o.note ?? null) !== (e.note ?? null) && !(o.state === 'reserved' && e.state === 'supported' && (o.note ?? null) === null)) out.notesChanged.push({ id, from: o.note ?? null, to: e.note ?? null });
    // (6c T3) an entry's limits changed in the same state (T3 grows connector.auto's moves); a flip's new limits come with the flip
    if (o.state === e.state && JSON.stringify(o.limits ?? null) !== JSON.stringify(e.limits ?? null)) out.limitsChanged.push({ id, from: o.limits ?? null, to: e.limits ?? null });
  }
  // ids are never removed (a breaking change); listed so the tool can refuse it
  for (const id of A.keys()) if (!B.has(id)) out.removed.push(id);
  for (const p of pending) if (B.get(p.block)?.state === 'supported' && A.get(p.block)?.state !== 'supported') out.recheck.push({ ...p });
  for (const k of ['reservedToSupported']) out[k].sort();
  out.added.sort((x, y) => (x.id < y.id ? -1 : 1));
  return out;
}
