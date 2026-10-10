// Shared helpers of the broken-variant fixture programs (docs/CONTRACT.md 6b §9): a small claim with an entrance and a
// spawn on open ground, and a lot reached by a short ground path.
export function start(region, ctx, stages = ['ground', 'ways', 'lots']) {
  const r = region(ctx);
  r.stages(stages);
  const c = ctx.claim;
  const cx = Math.floor((c.minX + c.maxX) / 2), cz = Math.floor((c.minZ + c.maxZ) / 2);
  r.clearing('entrance', [cx, c.maxZ - 6], { stage: stages[0] });
  r.clearing('spawn', [cx + 4, c.maxZ - 6], { stage: stages[0] });
  return { r, cx, cz, c };
}
