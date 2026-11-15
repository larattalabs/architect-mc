// (7c BR, docs/CONTRACT.md "Phase 7c" §3 row 15) Brief runs: `tools/scenarios.mjs run <s> --brief` takes the scenario's program and
// params from its one-line brief, through Regions.design (the template pick, TC) or Regions.compose (the standalone composer, CO), never
// from the scenario file. Everything after the choice (prepare, the three plans of the IR sha check, the lots, realise, the stand, the
// cameras, the undo and the exactness diff) is the scenario harness's own run, unchanged.
//
// Pure helpers here (the request bodies, the answer's reading, the pick row, the golden key); the DevBridge calls stay in scenarios.mjs.
// PAY's hooks (tools/gate7cpay.mjs, later): `via` (design | compose), `model`, `budgetUsd`, `images`, `ext` (passed to compose as is;
// on the sim backend `architect:simAnswers` / `architect:simCompose` script the pick and the rounds), and brief.json in every run dir.

/** The scenarios whose brief goes the plan path (§5: at least two scenarios through Regions.compose, P2's S3 and S6). */
export const BRIEF_VIA = Object.freeze({ s3_monastery: 'compose', s6_cave_city: 'compose' });

/**
 * The Style a brief run uses (a fixture in scenarios/styles/, beside scenarios/bibles/ so the palette snapshots of the older fixtures hold; installed as the sidecar's Style v1 as `--bible` does): format 3
 * settlement Styles with roleShares bands, the same roles as the scenario's own format 2 fixture (its lot entries re-skin in them at
 * $0, tools/scenarios.mjs prepV). Scenarios not named keep their own Style (or none).
 */
export const BRIEF_STYLE = Object.freeze({ s2_ice_spikes: 'g7cbr_s2_outpost', s3_monastery: 'g7cbr_s3_monastery' });

/**
 * The cached library entries a brief run's site lots use (tools/lib/scenario-sb.mjs librarySiteEntries: $0 site variants; lots of a fit
 * none of them has go SB's way, the sim's archetype). S5: 7b P2's treehouse entries, committed under kit/test/fixtures/br/library (the
 * coordinator, 2026-11-14: 7b's S5/S6 paid entries are gone from disk but these two). S6 has none (its carve_into lots: the sim archetype).
 */
export const BRIEF_LIBRARY = Object.freeze({
  s5_treehouses: Object.freeze({ from: 'kit/test/fixtures/br/library', repo: true, entries: Object.freeze(['gen_pa_treehouse_home', 'gen_pa_treehouse_lodge']) }),
});

/** design | compose: an explicit `--via` wins, else BRIEF_VIA, else the pick (design). */
export function briefVia(sc, over = null) {
  if (over === 'design' || over === 'compose') return over;
  if (over != null && over !== true) throw new Error(`--via is design or compose (got ${over})`);
  return BRIEF_VIA[sc.id] ?? 'design';
}

/**
 * The DevBridge call for a brief: [hook, body]. The body names the brief, the claim and the scenario's Style (a bible id), never its
 * program or params. `o`: {model, budgetUsd, images, ext, opKey} (PAY's hooks; none on BR's $0 runs).
 */
export function briefCall(sc, claim, via, o = {}) {
  if (!sc.brief || typeof sc.brief !== 'string') throw new Error(`${sc.id}: no one-line brief`);
  const brief = briefText(sc);
  const common = { brief, claim, wait: true, ...(o.budgetUsd != null ? { budgetUsd: o.budgetUsd } : {}) };
  if (via === 'compose') {
    return ['dev.region.compose', { ...common, ...(sc.bible ? { style: sc.bible } : {}), images: !!o.images, ...(o.opKey ? { opKey: o.opKey } : {}), ...(o.ext ? { ext: o.ext } : {}) }];
  }
  return ['dev.region.design', { ...common, ...(sc.bible ? { bible: sc.bible } : {}), ...(o.model ? { model: o.model } : {}), requireFit: false }];
}

/**
 * The brief itself: the scenario's one-line brief without its trailing version note (S1's "(S1 v1: stone links; rope is 7a)" is a note
 * for readers, not part of the SETTLEMENTS §16.2 brief).
 */
export function briefText(sc) {
  return String(sc.brief).replace(/\s*\((S\d+ v\d+|[A-Z]\d+)[^)]*\)\s*$/, '').trim();
}

/**
 * The answer read: {via, designId, kind, status, outcome, program, params, fits, reason, costUsd, planId, planError, pick, rounds,
 * artifactSha, error}. A design answers {designId, status, result, costUsd|cost, error?}; compose's result nests the pick.
 */
export function readBrief(via, d, brief = null) {
  const r = d?.result ?? {};
  const cost = d?.costUsd ?? d?.cost?.usd ?? r.cost ?? 0;
  const out = {
    via,
    brief,
    designId: d?.designId ?? null,
    kind: d?.kind ?? (via === 'compose' ? 'SETTLEMENT' : 'REGION'),
    status: d?.status ?? null,
    outcome: r.outcome ?? null,
    program: r.program ?? r.pick?.program ?? null,
    params: r.params && typeof r.params === 'object' ? r.params : {},
    fits: r.fits !== undefined ? !!r.fits : r.pick?.fits !== undefined ? !!r.pick.fits : r.outcome === 'PICKED',
    reason: r.reason ?? null,
    costUsd: typeof cost === 'number' ? cost : Number(cost) || 0,
    planId: r.planId ?? null,
    planError: r.planError ?? null,
    pick: r.pick ? { designId: r.pick.designId ?? null, outcome: r.pick.outcome ?? null, program: r.pick.program ?? null, fits: r.pick.fits ?? null, reason: r.pick.reason ?? null } : null,
    rounds: r.rounds ?? 0,
    artifactSha: r.check?.artifactSha ?? null,
    error: d?.refused ?? d?.error ?? null,
  };
  return out;
}

/**
 * What the run can go on with: {ok, program, params} or {ok: false, why}. A fitting pick (PICKED, fits) that the mod planned goes on:
 * its program and params plan the run. COMPOSED (a plan/0 artifact) is realised through Regions.realiseApproved, which this harness does
 * not drive (PAY's P2 hook: brief.json keeps the artifact sha). NO_TEMPLATE, NO_PLAN, a failed design or a failed plan stop the run.
 */
export function briefPlan(b) {
  if (b.error) return { ok: false, why: `the ${b.via} call refused: ${b.error}` };
  if (b.status !== 'DONE') return { ok: false, why: `the ${b.via} ended ${b.status}${b.error ? `: ${b.error}` : ''}` };
  if (b.outcome === 'COMPOSED') return { ok: false, why: `COMPOSED (artifact ${b.artifactSha ?? '?'}): a plan/0 artifact is realised by Regions.realiseApproved, which this harness does not drive (PAY's plan-path hook)` };
  if (b.outcome !== 'PICKED' || !b.fits) return { ok: false, why: `${b.outcome ?? 'no outcome'}${b.program ? ` (closest ${b.program})` : ''}: ${b.reason ?? ''}`.trim() };
  if (!b.program) return { ok: false, why: 'PICKED without a program' };
  if (b.planError) return { ok: false, why: `the mod's plan of the pick failed: ${b.planError}` };
  if (!b.planId) return { ok: false, why: 'the mod did not plan the pick' };
  return { ok: true, program: b.program, params: b.params };
}

/**
 * The run's `brief` row (gated): the brief reached a plan through the API. The program it landed on is recorded beside the scenario's
 * own (§5: a pick landing on the parametrised scenario program counts; another program is data, judged by every other bar).
 */
export function briefRow(b, scenarioProgram) {
  if (!b) return null;
  const p = briefPlan(b);
  const same = b.program === scenarioProgram;
  const value = `${b.via === 'compose' ? 'Regions.compose' : 'Regions.design'} "${b.brief ?? ''}": ${b.status} ${b.outcome ?? '-'} ${b.program ?? '-'}${b.fits ? ' (fits)' : ''}`
    + `${b.planId ? `, planned ${String(b.planId).slice(0, 12)}` : ''}; the scenario's program ${scenarioProgram}${same ? ' (the same)' : ' (another program)'}; $${(b.costUsd ?? 0).toFixed(4)}${p.ok ? '' : `; ${p.why}`}`;
  return { id: 'brief', label: 'From its brief', value, threshold: 'a fitting pick (or a composed plan) through the API, planned by the mod; the program never named', pass: p.ok, gated: true };
}

/** The golden of a brief run: goldens/<short>-br (its own key, so the program runs' goldens never move). */
export const briefGoldenKey = (shortId) => `${shortId}-br`;
