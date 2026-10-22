// mega_bench_forest (docs/CONTRACT.md 6c F3 §10.3): mega_bench's composition (kit/regions/mega_bench.mjs, unchanged: its source sha is
// every mega_bench IR's programSha, so its default IR and golden stay) plus a forest of giant trees over 30% of the claim with
// undergrowth (kit/lib/forms/forest.mjs), in the composition's last stage. The forest-heavy benchmark the 6c close-out measures
// (mega_bench A with forms). Not a catalogue program.
import megaBench, { params as MB } from './mega_bench.mjs';
import { growForest } from '../lib/forms/forest.mjs';

export const id = 'mega_bench_forest';
export const description = 'mega_bench plus giant trees over 30% of the claim with undergrowth (6c F3 forest variant).';
export const catalogue = false;
export const params = {
  ...MB,
  cover: { type: 'int', min: 0, max: 60, default: 30, label: 'Forest cover (percent)' },
};

export default function megaBenchForest(ctx) {
  const r = megaBench(ctx);
  growForest(r, ctx, { stage: r.stageList[r.stageList.length - 1], cover: (ctx.params.cover ?? 30) / 100 });
  return r;
}
