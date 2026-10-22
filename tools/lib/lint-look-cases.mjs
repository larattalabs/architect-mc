// (fast checks P2) The look lint's cases (tools/lint.mjs look): its calibration against Noah's judged FL gallery (fl:calibration: every
// complaint flagged on FL's v1 plans, none on v2) and the scenario plans' looks (their goldens re-planned by this kit). Hard rules FAIL
// (less the recorded baseline), taste rules WARN.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// which look rule stands for which of Noah's FL complaints (kit/test/fixtures/lint/fl/labels.json)
const COMPLAINT = { L1: 'L-GAP', L2s: 'L-STRING', L2p: 'L-STUB', L3: 'L-LAMP', L4: 'L-LINK', L5: 'L-END' };

export async function lookCases({ goldenCase, kimp, LINTFIX, applyBaseline }) {
  const look = async (c) => {
    const S = await kimp('lib/lint/structure.mjs');
    const L = await kimp('lib/lint/look.mjs');
    const w = S.lintWorld(c);
    let axisShare = null;
    const layout = c.meta?.village?.layout ?? null;
    if (layout === 'organic') { const M = await import(pathToFileURL(path.join(ROOT, 'tools', 'lib', 'scenario-metrics.mjs')).href); axisShare = M.axisRunShare(c.ir, w.vw); }
    const rep = L.lookLint(c, w, { axisShare });
    return { rep, ...L.lookGate(rep) };
  };
  const by = (rep) => { const o = {}; for (const f of rep.findings) o[f.rule] = (o[f.rule] ?? 0) + f.count; return o; };

  const out = [];
  out.push({
    id: 'fl:calibration', covers: ['FL gallery v1 vs v2 (Noah\'s look complaints L1-L5)'],
    run: async () => {
      const res = { ok: [], fails: [], recorded: [], warn: [] };
      const labels = JSON.parse(fs.readFileSync(path.join(LINTFIX, 'fl', 'labels.json'), 'utf8')).labels;
      const S = await kimp('test/plan-p0-shared.mjs');
      const { decodeArvx } = await kimp('lib/region/volume.mjs');
      const { staleReason, EVAL_KIT_VERSION } = await kimp('lib/realise.mjs');
      const matrix = {};
      for (const ver of ['v1', 'v2']) for (const name of fs.readdirSync(path.join(LINTFIX, 'fl', ver)).sort()) {
        const d = path.join(LINTFIX, 'fl', ver, name);
        const fx = JSON.parse(fs.readFileSync(path.join(d, 'fixture.json'), 'utf8'));
        const ir = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(d, 'ir.json.gz'))).toString());
        const meta = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(d, 'meta.json.gz'))).toString());
        // (FL's plans record kit 0.39.0; a kit before FL reads them re-stamped: format 1, no op it lacks)
        if (staleReason(ir)) ir.kitVersion = EVAL_KIT_VERSION;
        const blobs = (sha) => { const f = path.join(d, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
        const vd = path.join(d, 'volumes');
        const volumes = fs.existsSync(vd) ? fs.readdirSync(vd).map((f) => decodeArvx(fs.readFileSync(path.join(vd, f)))) : [];
        const r = await look({ name: `fl/${ver}/${name}`, ir, meta, survey: S.svOf(fx).bytes, blobs, volumes });
        const got = by(r.rep);
        const lab = labels[`${ver}/${name}`];
        const row = [];
        for (const [k, rule] of Object.entries(COMPLAINT)) {
          // (L5 counts FL's own meta line 'no hubLanding recorded' on every v1 plan: the visual complaints are the rest)
          const n = k === 'L5' ? Math.max(0, (lab[k] ?? 0) - (ver === 'v1' ? 1 : 0)) : (lab[k] ?? 0);
          const flagged = (got[rule] ?? 0) > 0;
          if (ver === 'v1' && n > 0 && !flagged) res.fails.push(`v1 ${name}: Noah's ${k} (${n} in FL's encoding) not flagged by ${rule}`);
          if (ver === 'v1' && n > 0 && flagged) row.push(`${k}->${rule} ${got[rule]}`);
          if (ver === 'v1' && n === 0 && flagged) res.recorded.push(`v1 ${name}: ${rule} ${got[rule]} beyond FL's own ${k} (v1 is the plan Noah rejected)`);
        }
        if (ver === 'v2') {
          if (r.fails.length) res.fails.push(...r.fails.map((l) => `v2 ${name} (Noah's accepted look): ${l}`));
          res.warn.push(...r.warn.map((l) => `v2 ${name}: ${l}`));
        }
        matrix[`${ver}/${name}`] = got;
        if (ver === 'v1') res.recorded.push(`v1 ${name}: ${row.join(', ')}`);
      }
      if (!res.fails.length) res.ok.push(`every complaint of Noah's on FL's v1 plans flagged (L1 L-GAP, L2 L-STRING/L-STUB, L3 L-LAMP, L4 L-LINK, L5 L-END) on all ${Object.keys(matrix).length / 2} plans that had it; the v2 plans clean of every hard rule`);
      return res;
    },
  });
  // the scenarios' plans (their goldens' inputs re-planned by this kit): settlement looks
  for (const [name, flat] of [['s7', false], ['s7', true], ['districts_demo', false], ['districts_demo', true], ['s1', false], ['s2', false], ['route_demo', false], ['relief_demo', false], ['scatter_demo', false], ['links_demo', false]]) {
    const id = `g:${name}${flat ? '-flat' : ''}`;
    out.push({
      id, covers: name === 's1' ? ['6b-scenario-s1 #7 (organic read)'] : name === 's7' && !flat ? ['6cv-scenario-s7 (the look lint at the slice: the camera steps stay)'] : [],
      run: async () => {
        const c = await goldenCase(name, { flat });
        const r = await look(c);
        const v = applyBaseline('look', c.name, r.rep, r.fails);
        return { ok: [`${JSON.stringify(by(r.rep))}; ${JSON.stringify(r.rep.metrics.lamps ?? {})}`], fails: v.fails, recorded: v.recorded, warn: r.warn };
      },
    });
  }
  return out;
}
