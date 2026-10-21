// (fast checks P2) The structure lint's mutation evidence (tools/lint.mjs mutations): every historical bug FAST-CHECKS lists for the
// structure lint, reproduced, and the lint must FAIL it on the named rule.
//   kit   the fix's kit hunk reverted in a scratch copy of kit/ (an APFS clone), the lint run with --kit on it
//   model the bug was in the mod (Java): the lint's own model of the Java rule run with the fix reverted (LINT_PREFIX), over a fixture
//         that reproduces the bug's geometry; the model's fidelity is the realised == virtual SMOKE row's (or the KEEP-INGAME probe's)
// The data-shaped broken variants (KC's u01-u04, C34's records) are inside the lint's own cases (p0:kc, hist:door) and FAIL-checked
// there on every run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MUTATIONS = [
  {
    id: 'even-width', bug: 'even-width bridges, rope bridges and tunnels (c4f1c8f9, 9ba60b79): a width-2/4 span running +z or -x stood one column off its walk',
    kind: 'kit', edits: [['lib/connectors/ropeGeom.mjs', 'return rx + rz < 0 ? { lo: -hi, hi: -lo } : { lo, hi };', 'return { lo, hi };']],
    cases: ['even:bridge', 'even:rope', 'even:tunnel'], expect: /S-LAND/,
  },
  {
    id: 'kc-wall-body', bug: 'wall through the fountain (v51; KC f88ec297): the wall grid ignored the bodies\' footprints and the plan check did not refuse the writer (both layers of the fix reverted: the wall\'s body-blind grid, the plan\'s clear scan)',
    kind: 'kit', edits: [['lib/connectors/wall.mjs', "const blind = p.part.ext?.['architect_mc:unsafe']?.wallThroughBody === true;", 'const blind = true;'],
      ['lib/region/plan.mjs', "if (r.meta.planCheck && !r.meta.planCheck.malformed && irJson.includes('\"op\":\"fluid\"')) {", "if (false) {"]],
    cases: ['p0:kc'], expect: /M25:clear/,
  },
  {
    id: 'kc-lamp-body', bug: 'apron lamps on a body\'s rim or in its watch (KC f88ec297)',
    kind: 'kit', edits: [['lib/region/light.mjs', 'if (keep.length && fc.cells.some(([x, yy, z]) => keptBy(keep, x, yy, z))) { keptSkipped++; continue; }', '']],
    cases: ['p0:kc'], expect: /M25:clear/,
  },
  {
    id: 'hy-lamp-spill', bug: 'an apron lamp in a course\'s spill (HY-b e8bc2e57: the race\'s lip held a lamp post; both layers reverted: the spill columns and KC\'s kept-cell skip)',
    kind: 'kit', edits: [['lib/region/light.mjs', " && !spillCols.has(`${x},${z}`);", ';'], ['lib/region/light.mjs', 'if (keep.length && fc.cells.some(([x, yy, z]) => keptBy(keep, x, yy, z))) { keptSkipped++; continue; }', '']],
    cases: ['p0:hy/1', 'p0:hy/2', 'p0:hy/3', 'p0:valid/1', 'p0:valid/2', 'p0:valid/3', 'p0:valid/4', 'p0:valid/5', 'p0:valid/6'], expect: /M25:clear/,
  },
  {
    id: 'farm-typed-lot', bug: 'the farm typed lot (H RC2 65d61b0b): a farm lot whose villager use its type implies got no pond, silently',
    kind: 'kit', edits: [['lib/fluids/pond.mjs', "const lots = all.filter((l) => asked(l) && (l.villager ?? inferVillager(l.type)) === 'farm');", "const lots = all.filter((l) => asked(l) && l.villager === 'farm');"],
      ['lib/fluids/pond.mjs', "else if (z.farmPond === true || all.some((l) => l?.farmPond === true)) out.push({ zone: p, lots: [], noFarm: true });", '']],
    cases: ['hist:farm-hamlet'], expect: /S-FARM/,
  },
  { id: 'lamp-path', bug: 'lamp on dirt path (52cc9606): RoadPlan.lanterns stood a post on a dirt path the road never wrote', kind: 'model', prefix: 'roads:lamp-path', cases: ['hist:lamp-path'], expect: /S-FOOT/ },
  { id: 'sand-vanish', bug: 'sand vanish (70fc0dd0): the tile writer\'s dependents stage cleared every gravity block on a changed cell', kind: 'model', prefix: 'gravity:sand-vanish', cases: ['hist:sand'], expect: /S-GRAV/ },
  { id: 'c31-felling', bug: 'C31 felling into protected areas (5cc0d7f1): felling crossed the owner\'s protected area', kind: 'model', prefix: 'felling:c31', cases: ['hist:felling'], expect: /S-FELL/ },
];

function lint(args, env = {}) {
  const t0 = Date.now();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-mut-')), 'r.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'lint.mjs'), 'structure', ...args, '--json', out], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  let j = null;
  try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none */ }
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return { code: r.status, ms: Date.now() - t0, json: j, tail: (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' / ') };
}

export async function runMutations({ only = null, json = null } = {}) {
  const list = MUTATIONS.filter((m) => !only || only.includes(m.id));
  const res = [];
  let bad = 0;
  for (const m of list) {
    let scratch = null;
    const args = ['--only', m.cases.join(',')];
    const env = {};
    try {
      if (m.kind === 'kit') {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), `lint-mut-${m.id}-`));
        // (kit/ and scenarios/: the kit's test helpers read the scenario goldens from the kit's parent)
        for (const d of ['kit', 'scenarios']) {
          const r = spawnSync('cp', ['-c', '-R', path.join(ROOT, d), path.join(scratch, d)]);
          if (r.status !== 0) spawnSync('cp', ['-R', path.join(ROOT, d), path.join(scratch, d)]);
        }
        for (const [file, find, rep] of m.edits) {
          const f = path.join(scratch, 'kit', file);
          const src = fs.readFileSync(f, 'utf8');
          if (src.split(find).length !== 2) throw new Error(`${file}: the fix's hunk is not there exactly once (${find.slice(0, 60)}...): update the mutation`);
          fs.writeFileSync(f, src.replace(find, rep));
        }
        args.push('--kit', path.join(scratch, 'kit'));
      } else env.LINT_PREFIX = m.prefix;
      const r = lint(args, env);
      const lines = (r.json?.results ?? []).flatMap((q) => (q.fails ?? []).map((l) => `${q.id}: ${l}`));
      const hit = lines.filter((l) => m.expect.test(l));
      const ok = r.code === 1 && hit.length > 0;
      if (!ok) bad++;
      res.push({ id: m.id, kind: m.kind, bug: m.bug, caught: ok, ms: r.ms, rule: String(m.expect), evidence: hit.slice(0, 3), other: lines.filter((l) => !m.expect.test(l)).slice(0, 3), tail: ok ? undefined : r.tail });
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${m.id} (${m.kind}, ${(r.ms / 1000).toFixed(1)} s): ${m.bug}\n       ${ok ? `caught: ${hit[0].slice(0, 260)}` : `NOT caught (exit ${r.code}): ${lines.slice(0, 2).join(' | ').slice(0, 260) || r.tail}`}`);
    } catch (e) {
      bad++;
      res.push({ id: m.id, caught: false, error: e.message });
      console.log(`FAIL ${m.id}: ${e.message}`);
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (json) fs.mkdirSync(path.dirname(path.resolve(json)), { recursive: true });
  if (json) fs.writeFileSync(json, `${JSON.stringify({ mutations: res }, null, 1)}\n`);
  console.log(`== mutations: ${res.length - bad} of ${res.length} historical bugs caught`);
  return bad ? 1 : 0;
}
