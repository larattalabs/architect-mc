// revise (6d RV-a, docs/CONTRACT.md "Phase 6d slice RV" §2.2, §2.4, §2.5): the bundled program of Regions.planRevision. It builds the
// revision IR: only what the revision adds to a standing region, in the base IR's stage names, every part, lot and body id prefixed
// `rv<rid>_`, and the IR's `revision` member {rid, position, base, parent, lots: {add, refill}, roads: {add}, graph: {nodes, edges}, seed}.
// The standing region comes in ctx.revision (the plan's `revision` input: {rid, position, parent, base, effective, standing}); the
// program never re-runs the standing program and never names a standing part (planRegion's guard refuses a non-additive edit, M29).
// Params: spec {parts, refill, unsafe?}:
//   parts   [{id, call}]  each call one region primitive (below); its materials are role names (themed, S-THEME) or air
//   refill  [lotId]       standing lots in state pad or removed that get a building again (no tile; the lot item only, §4.6)
//   unsafe {removePart, underLot, overRoad, overPath, ignoreHeld}  the broken variants: the program writes the forbidden thing and the
//           guard lets it through, so the checker's M29:revision must catch it
// Calls (v1; GR adds streets): {fn: 'columns', cols, materials, from?, to?, cond?, walk?, terrain?, stage?, set?},
//   {fn: 'fill', shape, material, cond?, walk?, terrain?, stage?, set?}, {fn: 'carve', shape, lining?, stage?},
//   {fn: 'terrace', area, levels, opts?, stage?}, {fn: 'pond', rect: [x0, z0, x1, z1], edge?, depth?, shape?, stage?},
//   {fn: 'form', generator: rockSpire | iceSpike | giantTree | giantMushroom, params, stage?},
//   {fn: 'lot', at, size, front?, floor?, max?, pad?, stage?}.
import { region } from '../lib/region/program.mjs';
import { emitPond } from '../lib/fluids/pond.mjs';
import { fluidRolesOf } from '../lib/fluids/place.mjs';
import { columnProblem, ridPrefix, standingClasses } from '../lib/region/revise.mjs';

export const id = 'revise';
export const description = 'An additive revision of a standing region (6d RV): new parts, lots, refills and bodies over it.';
/** Not in Regions.design's pick: revisions come through Regions.planRevision and plan/0's revision mode. */
export const catalogue = false;

export const params = {
  spec: { type: 'json', default: null, maxChars: 262144, label: 'The revision ({parts, refill, unsafe?})' },
};

/** Functional blocks a call may name directly (the shared allowlist; everything else is a role). */
const FUNCTIONAL = new Set(['air', 'minecraft:air', 'minecraft:water', 'minecraft:ladder', 'minecraft:cave_air']);
const PART_FNS = new Set(['columns', 'fill', 'carve', 'terrace']);
const FORMS = new Set(['rockSpire', 'iceSpike', 'giantTree', 'giantMushroom']);
const ID = /^[a-z][a-z0-9_]{0,31}$/;

function themed(r, m, what) {
  if (m === null || m === undefined) return null;
  if (typeof m === 'string' && (FUNCTIONAL.has(m) || Object.prototype.hasOwnProperty.call(r.roles, m))) return m;
  throw new Error(`NOT_ALLOWED: [theme] ${what}: '${typeof m === 'string' ? m : JSON.stringify(m)}' is not a role of the style (${Object.keys(r.roles).join(', ')}) or a functional block`);
}

export default function revise(ctx) {
  const RV = ctx.revision;
  if (!RV || !Number.isInteger(RV.rid) || RV.rid < 1) throw new Error('revise: the plan has no revision input (Regions.planRevision sends it)');
  const P = ctx.params.spec ?? {};
  const unsafe = P.unsafe && typeof P.unsafe === 'object' ? P.unsafe : {};
  const parts = Array.isArray(P.parts) ? P.parts : [];
  const refill = Array.isArray(P.refill) ? P.refill.map(String) : [];
  if (!parts.length && !refill.length && !Object.keys(unsafe).length) throw new Error('NOT_ALLOWED: [empty] a revision adds at least one part or refill');
  const eff = RV.effective;
  const st = RV.standing;
  const pre = ridPrefix(RV.rid);
  const baseStages = Array.isArray(eff?.stages) && eff.stages.length ? eff.stages : ['ground'];
  // the revision's stages: the base's names the calls use, in the base's order, then new names (§12: most revisions add no stage name)
  const used = new Set();
  for (const p of parts) used.add(p?.call?.stage ?? baseStages[0]);
  if (unsafe.removePart || unsafe.underLot || unsafe.overRoad || unsafe.overPath || unsafe.ignoreHeld) used.add(baseStages[0]);
  if (!used.size) used.add(baseStages[0]);
  // (a body needs the region's `fluids` stage, last: H's settle and census run in it, §7)
  if (parts.some((p) => p?.call?.fn === 'pond')) used.add('fluids');
  const stages = [...baseStages.filter((s) => used.has(s) && s !== 'fluids'), ...[...used].filter((s) => !baseStages.includes(s) && s !== 'fluids').sort(), ...(used.has('fluids') ? ['fluids'] : [])];
  const r = region(ctx);
  r.stages(stages);
  // the base's anchors (§2.3: the claim, roles, anchors and budget rules are the base IR's)
  for (const a of ['entrance', 'spawn']) {
    const at = eff?.anchors?.[a] ?? [ctx.claim.minX + ((ctx.claim.maxX - ctx.claim.minX) >> 1), ctx.claim.minZ + ((ctx.claim.maxZ - ctx.claim.minZ) >> 1)];
    r.anchor(a, at);
  }
  const seen = new Set();
  for (const q of parts) {
    if (!q || typeof q.id !== 'string' || !ID.test(q.id)) throw new Error(`NOT_ALLOWED: [call] a part id must match ${ID} (got ${JSON.stringify(q?.id)})`);
    if (seen.has(q.id)) throw new Error(`NOT_ALLOWED: [call] part ${q.id} is named twice`);
    seen.add(q.id);
    const c = q.call ?? {};
    const pid = `${pre}${q.id}`;
    const stage = c.stage ?? baseStages[0];
    if (PART_FNS.has(c.fn)) {
      const part = r.part(pid, { stage, set: c.set === 'path' ? 'path' : 'terrain' });
      if (c.fn === 'columns') part.columns(c.from ?? { abs: 0 }, c.to ?? { abs: 0 }, c.cols, (c.materials ?? []).map((m, i) => themed(r, m, `part ${q.id} material ${i}`)), { cond: c.cond ?? 0, walk: !!c.walk, terrain: !!c.terrain });
      else if (c.fn === 'fill') part.fill(c.shape, themed(r, c.material, `part ${q.id} material`), { cond: c.cond ?? 0, walk: !!c.walk, terrain: !!c.terrain });
      else if (c.fn === 'carve') part.carve(c.shape, { lining: themed(r, c.lining ?? null, `part ${q.id} lining`) });
      else part.terrace(c.area, c.levels, c.opts ?? {});
    } else if (c.fn === 'pond') {
      const [x0, z0, x1, z1] = c.rect ?? [];
      if (![x0, z0, x1, z1].every(Number.isInteger)) throw new Error(`NOT_ALLOWED: [call] pond ${q.id}: rect must be [x0, z0, x1, z1]`);
      emitPond(r, { id: pid, rect: { minX: Math.min(x0, x1), minZ: Math.min(z0, z1), maxX: Math.max(x0, x1), maxZ: Math.max(z0, z1) }, stage, roles: fluidRolesOf(ctx), edge: c.edge ?? 'natural', depth: c.depth, shape: c.shape, exits: c.exits });
    } else if (c.fn === 'form') {
      if (!FORMS.has(c.generator)) throw new Error(`NOT_ALLOWED: [call] form ${q.id}: generator must be one of ${[...FORMS].join(', ')}`);
      // (the seed: the generator's own default, fnv64(the revision's seed, generator, part id): keyed by part id, §2.3)
      r[c.generator](pid, { ...(c.params ?? {}) }, { stage });
    } else if (c.fn === 'lot') {
      r.part(`${pid}_pad`.slice(0, 48), { stage }).lot(pid, { at: c.at, size: c.size, front: c.front ?? 'south', floor: c.floor ?? 'auto', ...(c.max ? { max: c.max } : {}), pad: { edge: 'slope', ...(c.pad ?? {}) }, stage });
    } else {
      throw new Error(`NOT_ALLOWED: [call] part ${q.id}: fn ${JSON.stringify(c.fn)} is not a revision primitive (columns, fill, carve, terrace, pond, form, lot)`);
    }
  }
  // the broken variants (the checker's tests): each writes the forbidden thing the guard then lets through
  const y = (x, z) => ctx.survey.groundAt(x, z) + 1;
  const one = (name, at, mat = 'structure') => {
    if (!at) return;
    r.part(`${pre}unsafe_${name}`, { stage: baseStages[0] }).columns({ abs: 0 }, { abs: 0 }, [at[0], at[1], y(at[0], at[1]), y(at[0], at[1]), 0], [themed(r, mat, name)], { cond: 0 });
  };
  // (each variant's column: one where only that class forbids the write, so the guard lets it through and only M29 can catch it)
  const K = st ? standingClasses(st) : null;
  const OFF = { underLot: 'lot', overRoad: 'road', overPath: 'path', ignoreHeld: 'held' };
  const onlyKind = (v) => {
    if (!K) return null;
    const c = ctx.claim;
    for (let z = c.minZ; z <= c.maxZ; z++) for (let x = c.minX; x <= c.maxX; x++) {
      if (columnProblem(K, x, z)?.kind === OFF[v] && columnProblem(K, x, z, { [v]: true }) === null) return [x, z];
    }
    return null;
  };
  if (unsafe.removePart && eff?.parts?.length) r.part(eff.parts[0].id.slice(0, 48), { stage: baseStages[0] }).columns({ abs: 0 }, { abs: 0 }, [], ['structure']);
  for (const v of ['underLot', 'overRoad', 'overPath', 'ignoreHeld']) if (unsafe[v]) one(v.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), onlyKind(v));
  // the revision member (§2.3); lots added are the IR's, refills only named; the graph's additions
  r.meta.revision = {
    format: 'revision/1', rid: RV.rid, position: RV.position ?? 0, base: RV.base ?? null, parent: RV.parent ?? null,
    lots: { add: r.lots.map((l) => l.id), refill: [...refill] }, roads: { add: r.roads.map((x) => x.id) },
    graph: { nodes: r.graph.nodes.map((n) => n.id), edges: r.graph.edges.map((e) => e.id) }, seed: ctx.seed,
    ...(Object.keys(unsafe).length ? { _unsafe: Object.keys(unsafe).filter((k) => unsafe[k]).sort() } : {}),
    ...(unsafe.removePart && eff?.parts?.length ? { remove: [eff.parts[0].id] } : {}),
  };
  return r;
}
