// (gate speed 3) The extras some drivers read from a plan's whole result, computed where the plan runs (corpus-plan.mjs helpers'
// `derive`) and stored next to it, keyed by the head's kit tree and this file. Each is the driver's own code, moved, unchanged:
//   kcCensus   (gate6ckc-kit unchanged) the M25:clear census of an IR with bodies: this checkout's clearScan over that tree's IR and
//              virtual world; null when the IR has no body. A throw is returned as { threw }.
//   f3M18M19   (gate6cf3-kit unchanged) M18 and M19 on an IR (this checkout's checkRegion), or { err }.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const K = (root, f) => import(pathToFileURL(path.join(root, 'kit', 'lib', ...f.split('/'))).href);

export const DERIVE = {
  async kcCensus(r, opts, { headRoot }) {
    try {
      const { clearScan, bodiesOf } = await K(headRoot, 'region/checkFluids.mjs');
      const { buildVirtual } = await K(headRoot, 'region/vworld.mjs');
      const { fillMissing } = await K(headRoot, 'region/plan.mjs');
      const { asColumns } = await K(headRoot, 'region/pack.mjs');
      const ir = JSON.parse(r.res.irJson);
      if (!bodiesOf(ir).length) return { census: null };
      const cols = fillMissing(asColumns(opts.survey)).columns;
      const { vw } = buildVirtual({ ir, survey: cols, filled: cols, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: r.volumes.map((v) => v.decoded ?? v) });
      const sc = clearScan({ ir, vw, meta: r.res.meta });
      return { census: { counts: sc.counts, findings: sc.findings.map((q) => ({ body: q.body, part: q.part, set: q.set, writer: q.writer, writerPart: q.writerPart, why: q.why, count: q.count })) } };
    } catch (e) {
      return { threw: String(e.message) };
    }
  },
  async f3M18M19(r, opts, { headRoot }) {
    try {
      const { checkRegion } = await K(headRoot, 'region/check.mjs');
      const rep = checkRegion({ ir: r.res.ir, survey: opts.survey, blobs: (sha) => r.res.blobs.get(sha) ?? null, volumes: (r.volumes ?? []).map((v) => v.decoded ?? v), meta: r.res.meta, rules: ['M18', 'M19'] });
      const f18 = rep.findings.filter((f) => f.rule === 'M18'), f19 = rep.findings.filter((f) => f.rule === 'M19');
      return { m18: { count: f18.reduce((x, f) => x + f.count, 0), parts: f18.map((f) => f.part), leaves: rep.metrics.M18?.leaves ?? 0 }, m19: { count: f19.reduce((x, f) => x + f.count, 0), parts: f19.map((f) => f.part) } };
    } catch (e) {
      return { err: String(e.message).slice(0, 160) };
    }
  },
};
