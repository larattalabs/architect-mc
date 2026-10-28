// (6d RV-a, docs/CONTRACT.md "Phase 6d slice RV" §9) plan/0's revision mode: a plan with `revision.parentArtifact` naming the artifact of
// a standing region is checked as a candidate revision. Its parts are matched against the parent artifact's own `plan`, only against
// the parts the parent built (a part the parent dropped, or answered unsupported or blocked, is checked as added):
//   keep    same id, the same canonical JSON                         fits, standing: true, cost 0      revision.keep (supported)
//   add     a new id, or one the parent didn't build                 checked against the standing region revision.add (supported)
//   refill  a zone equal to the parent's but for lots that gain `refill: true`, each lot removed or pad   fits, refill  revision.refill
//   grow    a zone whose program.lots only gains lots                unsupported until GR               revision.grow (reserved)
//   change  an id gone from the plan, or the same id changed         unsupported until RV2              revision.change (reserved)
// The mod sends the parent and the standing region as ctx.revision (not enumerable): {rid?, region, parentRid, parentArtifact,
// parentIrSha, parent: {plan, built: [ids], geometry?: {id: [x0, z0, x1, z1]}}, standing (§5.3), history?: {key: sha}, heldSha?}.
// A plan without parentArtifact never reaches this module (byte identity, §10).
import { canonicalJson } from '../region/pack.mjs';
import { runKeys, keyRuns } from '../region/beside.mjs';

const FAMS = ['zones', 'connectors', 'forms', 'rules'];

/** The revision input of a check, or null (a plan without parentArtifact, or no input from the mod: today's check). */
export function revisionInput(ctx, plan) {
  if (!plan?.revision?.parentArtifact) return null;
  const rv = ctx?.revision;
  if (!rv || !rv.parent || typeof rv.parent !== 'object') return null;
  return rv;
}

const partsOf = (plan) => {
  const m = new Map();
  for (const f of FAMS) for (const p of plan?.[f] ?? []) if (p && typeof p.id === 'string') m.set(p.id, { fam: f, part: p });
  return m;
};
const lotsOfZone = (z) => (Array.isArray(z?.program?.lots) ? z.program.lots : null);
const withoutRefill = (l) => { const { refill, ...rest } = l; return rest; };

/**
 * The class of every part of `plan` against the parent (`parent.plan`, `parent.built`), and the parts gone from the plan. `lotState`:
 * {lotId: {state}} (the standing region's lots, from ctx.standing.lots). Returns {classOf: Map id -> {klass, refill?, why?}, gone: [{id,
 * fam, block?}]}.
 */
export function classifyRevision(plan, parent, lotState = {}) {
  const P = partsOf(parent.plan ?? {});
  const N = partsOf(plan);
  const built = new Set(parent.built ?? []);
  const classOf = new Map();
  for (const [id, { fam, part }] of N) {
    const o = P.get(id);
    if (!o || !built.has(id)) { classOf.set(id, { klass: 'add' }); continue; }
    if (canonicalJson(o.part) === canonicalJson(part)) { classOf.set(id, { klass: 'keep' }); continue; }
    if (fam === 'zones' && o.fam === 'zones') {
      const a = lotsOfZone(o.part), b = lotsOfZone(part);
      const restA = { ...o.part, program: { ...(o.part.program ?? {}), lots: null } }, restB = { ...part, program: { ...(part.program ?? {}), lots: null } };
      if (a && b && canonicalJson(restA) === canonicalJson(restB)) {
        // refill: the same lots, in order, equal but for `refill: true` on some
        if (a.length === b.length && a.every((l, i) => canonicalJson(l) === canonicalJson(withoutRefill(b[i])))) {
          const refill = b.filter((l) => l.refill === true).map((l) => l.id);
          const bad = refill.filter((id2) => !['removed', 'pad'].includes(lotState[id2]?.state));
          if (refill.length && !bad.length) { classOf.set(id, { klass: 'refill', refill }); continue; }
          if (refill.length) { classOf.set(id, { klass: 'change', why: `refill of ${bad.join(', ')} (not removed or pad)` }); continue; }
        }
        // grow: the parent's lots as a prefix, equal, then new ones
        if (b.length > a.length && a.every((l, i) => canonicalJson(l) === canonicalJson(b[i])) && b.slice(a.length).every((l) => l.refill === undefined)) {
          classOf.set(id, { klass: 'grow', lots: b.slice(a.length).map((l) => l.id) });
          continue;
        }
      }
    }
    classOf.set(id, { klass: 'change' });
  }
  const gone = [];
  for (const [id, { fam, part }] of P) if (built.has(id) && !N.has(id)) gone.push({ id, fam, block: part.kind ? `${fam.replace(/s$/, '')}.${part.kind}` : null });
  return { classOf, gone };
}

/**
 * The standing region as a plan/0 `standing` entry (compile.mjs makeEnv: its lots plus 1, roads, paths, ways, reach are hard): the region
 * the revision adds to, with its bodies' hard and watch columns and the held columns its terrain alone doesn't hold also as hard rects.
 */
export function standingEntry(st) {
  const terrain = runKeys(st.held?.terrain ?? []);
  const held = [...runKeys(st.held?.runs ?? [])].filter((k) => !terrain.has(k));
  const reach = [...(st.bodies?.hard ?? []), ...(st.bodies?.watch ?? []), ...keyRuns(held), ...(st.beside ?? []).flatMap((b) => [...(b.reach ?? []), ...(b.hold ?? [])])];
  return { id: st.id, claim: [...(st.claim ?? [])], lots: (st.footprint?.lots ?? []).map((q) => [...q]), keep: (st.footprint?.keep ?? []).map((p) => [...p.rect]), graph: { nodes: [], edges: [] }, reach };
}

/** The record's `revision` member (meta.planCheck.revision): what the artifact's §9.3 members are built from. */
export function revisionRecord(rv, cls) {
  const by = (k) => [...cls.classOf].filter(([, c]) => c.klass === k).map(([id]) => id).sort();
  return {
    region: rv.region ?? null, parentRid: rv.parentRid ?? 0, parentArtifact: rv.parentArtifact ?? null, parentIrSha: rv.parentIrSha ?? null, ...(rv.rid ? { rid: rv.rid } : {}),
    keep: by('keep'), add: by('add'), refill: [...cls.classOf].filter(([, c]) => c.klass === 'refill').flatMap(([, c]) => c.refill).sort(),
    grow: by('grow'), change: [...by('change'), ...cls.gone.map((g) => g.id)].sort(),
    // (the refilled lots' boxes and entries for the artifact's $.lots[]; the region's history per tile key and its held set's sha, as
    // the mod sent them: historySha is compared at accept over the dirty keys, §3.4)
    refillLots: [...cls.classOf].filter(([, c]) => c.klass === 'refill').flatMap(([zone, c]) => c.refill.map((id) => ({ id, zone, box: rv.standing?.lots?.[id]?.box ?? null }))).sort((a, b) => (a.id < b.id ? -1 : 1)),
    history: rv.history && typeof rv.history === 'object' ? rv.history : {}, heldSha: rv.heldSha ?? null,
  };
}
