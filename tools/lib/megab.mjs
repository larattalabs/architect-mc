// (6c close-out B) mega_bench B's pure rows (tools/gate6a.mjs megaB), testable offline (kit/test/megab.test.mjs).

/**
 * The "REGION_PROGRESS events for every stage" row (S9). `items`: per IR stage (in order), its item count (stageItems: what the
 * region queues). A stage with no items never moves (mega_bench's IR has an empty `lots-4`: it stays APPROVED in
 * every event), so it is skipped and named; a stage with items and no PLACING/PLACED event fails the row.
 */
export function stageEvents(items, events, region) {
  const seen = {};
  for (const e of events.filter((x) => x.event === 'REGION_PROGRESS' && x.id === region)) {
    for (const part of String(e.what).split(' ').slice(1)) {
      const [n, state] = part.split(':');
      if (state === 'PLACING' || state === 'PLACED') seen[n] = (seen[n] ?? 0) + 1;
    }
  }
  const stages = Object.keys(items);
  const skipped = stages.filter((n) => !(items[n] > 0));
  const silent = stages.filter((n) => items[n] > 0 && !(seen[n] > 0));
  return { ok: silent.length === 0 && skipped.length < stages.length, seen, skipped, silent };
}

/** A stage's items as the region queues them (RegionsImpl: its terrain and path tiles, its 4e roads and its lots). */
export function stageItems(ir) {
  const out = {};
  for (const stage of ir.stages) {
    out[stage] = (ir.tiles?.[stage]?.terrain ?? []).length + (ir.tiles?.[stage]?.path ?? []).length + (ir.roads ?? []).filter((r) => r.stage === stage).length
      + (ir.lots ?? []).filter((l) => l.stage === stage).length;
  }
  return out;
}
