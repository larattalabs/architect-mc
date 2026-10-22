// Split steps (docs/GATES.md "Turbo": "Split steps"). A long step whose driver runs independent sections (fixtures, worlds,
// scenarios, item groups) declares `split` in tools/gate-chains.json:
//
//   "split": { "env": { "GATE6CIRR_OUT": "${OUT}/gate6c-irr/${PART}" },          env every part gets (${PART} = p1, p2, ...)
//              "parts": [ { "env": { "IRR_ONLY": "v62live,v62a" }, "estMin": 8 },  each part's own env (the driver's section filter)
//                         ... ] }
//
// The parent keeps its id everywhere a step is named by id (the impact rules, the tiers, supersededBy, --only); after the
// selection, a run that splits (turbo, or --split) expands each split parent into `<id>/p1..pN`. Every part runs the parent's
// shell with its part's env and GATE_PART=<k>/<N>; the driver runs only the named sections and prints a `part <k>/<N>:` line
// naming them. Steps that `waitFor` the parent wait for every part; the history records each part under its own id. A step that
// is `after` a split parent would need the parts on one shard: not allowed (validateSplits).
//
// Every part runs its share of the exact assertions: the union of the parts' ok/FAIL lines equals the parent's
// (tools/split-proof.mjs compares them, ids and numbers masked).

export const PART_SEP = '/p';
export const isPartId = (id) => /\/p\d+$/.test(id);
export const parentOf = (id) => (isPartId(id) ? id.slice(0, id.lastIndexOf(PART_SEP)) : id);

const subst = (env, part) => Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, String(v).replaceAll('${PART}', part)]));

/** Every part's GATE_PART_SECTIONS together, in part order (tools/lib/gate-part.mjs checks the driver's list against it). */
export const sectionsOf = (split) => (split.parts ?? []).flatMap((p) => String(p.env?.GATE_PART_SECTIONS ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/** The chain entry of part `k` (1-based) of a split step entry. A part may name its own `shell` (a shell chain split by its
 * commands) instead of, or as well as, env. */
export function partEntryOf(entry, k) {
  const n = entry.split.parts.length;
  const p = entry.split.parts[k - 1];
  const tag = `p${k}`;
  const { split, estMin, ...rest } = entry;
  const all = sectionsOf(split);
  return {
    ...rest,
    ...(p.shell ? { shell: p.shell } : {}),
    desc: `${entry.desc ?? ''} [part ${k}/${n}${p.what ? `: ${p.what}` : ''}]`,
    env: { ...(entry.env ?? {}), ...subst(split.env, tag), ...subst(p.env, tag), GATE_PART: `${k}/${n}`, ...(all.length ? { GATE_PART_ALL: all.join(',') } : {}) },
    estMin: p.estMin ?? (estMin ? Math.round((estMin / n) * 10) / 10 : undefined),
    part: { of: n, k },
  };
}

/** A step's chain entry by id, a part id included (`<parent>/p<k>` from its parent's split); null if none. */
export function entryOf(chains, id) {
  const steps = chains?.steps ?? {};
  if (steps[id]) return steps[id];
  if (!isPartId(id)) return null;
  const parent = steps[parentOf(id)];
  const k = Number(id.slice(id.lastIndexOf(PART_SEP) + PART_SEP.length));
  if (!parent?.split?.parts?.[k - 1]) return null;
  return { ...partEntryOf(parent, k), parentId: parentOf(id) };
}

/** Config errors: a split with no parts, a part without env, a step `after` a split parent, a nested split. */
export function validateSplits(steps) {
  const bad = [];
  for (const [id, s] of Object.entries(steps)) {
    if (!s.split) continue;
    if (!Array.isArray(s.split.parts) || s.split.parts.length < 2) bad.push(`${id}: split needs at least 2 parts`);
    for (const [i, p] of (s.split.parts ?? []).entries()) if (!p?.shell && !Object.keys(p?.env ?? {}).length) bad.push(`${id}: split part ${i + 1} names neither env (its section filter) nor a shell`);
    const secs = sectionsOf(s.split);
    const dup = secs.filter((x, i) => secs.indexOf(x) !== i);
    if (dup.length) bad.push(`${id}: split sections in more than one part: ${[...new Set(dup)].join(',')}`);
    if (secs.length && (s.split.parts ?? []).some((p) => !p.env?.GATE_PART_SECTIONS)) bad.push(`${id}: every part of a sectioned split names GATE_PART_SECTIONS`);
    if (s.after) bad.push(`${id}: a split step can't be \`after\` another (its parts would need one shard)`);
    for (const [o, t] of Object.entries(steps)) if (t.after === id) bad.push(`${o} is \`after\` ${id}, a split step: not allowed (use waitFor)`);
  }
  return bad;
}

/**
 * Expands the split parents among `ids` (the selection, in order) into their parts, in place of the parent.
 * -> { ids, parts: { parent: [part ids] }, defs: { partId: entry } }. `waitFor` naming a split parent is rewritten to its parts.
 */
export function expandSplits(steps, ids) {
  const out = [];
  const parts = {};
  const defs = {};
  for (const id of ids) {
    const s = steps[id];
    if (!s?.split) {
      out.push(id);
      continue;
    }
    parts[id] = [];
    for (let k = 1; k <= s.split.parts.length; k++) {
      const pid = `${id}${PART_SEP}${k}`;
      defs[pid] = { ...partEntryOf(s, k), parentId: id };
      parts[id].push(pid);
      out.push(pid);
    }
  }
  const rewrite = (list) => (list ? list.flatMap((w) => parts[w] ?? [w]) : list);
  for (const id of out) {
    const s = defs[id] ?? steps[id];
    if (s?.waitFor?.some((w) => parts[w])) {
      if (defs[id]) defs[id].waitFor = rewrite(s.waitFor);
      else defs[id] = { ...s, waitFor: rewrite(s.waitFor) };
    }
  }
  return { ids: out, parts, defs };
}

/** The parents' results from their parts' rows: the worst status, the summed seconds, the parts' wall span. */
export function parentResults(parts, rows) {
  const rank = ['PASS', 'NOISY', 'SKIPPED', 'FAIL', 'TIMEOUT', 'ERROR', 'PENDING', 'RUNNING'];
  const out = {};
  for (const [parent, ids] of Object.entries(parts)) {
    const rs = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
    const status = rs.reduce((w, r) => (rank.indexOf(r.status) > rank.indexOf(w) ? r.status : w), 'PASS');
    const starts = rs.map((r) => Date.parse(r.startedAt ?? '')).filter(Number.isFinite);
    const ends = rs.map((r) => Date.parse(r.startedAt ?? '') + (r.seconds ?? 0) * 1000).filter(Number.isFinite);
    out[parent] = { parts: ids, status, stepSeconds: Math.round(rs.reduce((a, r) => a + (r.seconds ?? 0), 0)), wallSeconds: starts.length ? Math.round((Math.max(...ends) - Math.min(...starts)) / 1000) : null,
      ok: rs.reduce((a, r) => a + (r.ok ?? 0), 0), fail: rs.reduce((a, r) => a + (r.fail ?? 0), 0) };
  }
  return out;
}
