// (fast checks P2) The historical-bug fixtures' region program (tools/lint.mjs hist:*): the fixture's own parts as columns ops and its
// 4e ground roads, verbatim, over a flat claim. Not a catalogue program (it lives with the fixtures).
import { region } from '../../../../lib/region/program.mjs';

export const id = 'lint_hist';
export const params = { spec: { type: 'json', default: null, maxChars: 65536, label: 'Spec' } };

export default function lintHist(ctx) {
  const s = ctx.params.spec ?? {};
  const r = region(ctx);
  r.stages(s.stages ?? ['ground']);
  for (const p of s.parts ?? []) r.part(p.id, { stage: p.stage ?? 'ground' }).columns({ abs: 0 }, { abs: 0 }, p.cols, p.materials, { cond: p.cond ?? 0, walk: !!p.walk });
  for (const rd of s.roads ?? []) r.part(rd.part, { stage: rd.stage ?? 'ground', set: 'path' }).road(rd.points, { width: rd.width ?? 3, lanterns: rd.lanterns ?? true, mode: 'ground', id: rd.id });
  r.anchor('entrance', s.entrance);
  r.anchor('spawn', s.spawn ?? s.entrance);
  return r;
}
