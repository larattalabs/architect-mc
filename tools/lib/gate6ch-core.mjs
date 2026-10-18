// (6c H) H-core's items of the H gate (tools/gate6ch.mjs; docs/CONTRACT.md "Phase 6c slice H" §14): item 11's byte identity offline,
// and the in-game items on h_core_demo (ingame: 1-3, 5, 6; crash: 7; probe: 13, 14). H-core owns this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Item 11's byte identity: every committed valid/, K1 and T3 fixture without an H part answers as on origin/main and plans the same IR
 * but its kitVersion (the main checkout's kit in a detached worktree beside this one).
 */
export async function unchanged(root) {
  const { createHash } = await import('node:crypto');
  const sha256 = (s) => createHash('sha256').update(s).digest('hex');
  const mainDir = path.resolve(root, '..', 'architect-mc-H-main');
  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', 'main']);
  const mainHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main']).toString().trim();
  if (!fs.existsSync(path.join(mainDir, '.git'))) execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', mainDir, mainHead]);
  else execFileSync('git', ['-C', mainDir, 'checkout', '-q', '--detach', mainHead]);
  const H = (dir) => import(pathToFileURL(path.join(dir, 'kit', 'test', 'plan-helpers.mjs')).href);
  const [hNew, hOld] = [await H(root), await H(mainDir)];
  const out = { mainHead, fixtures: {} };
  let same = 0, skipped = 0;
  const H_KINDS = ['pond', 'fountain', 'waterfall', 'quay', 'channel'];
  for (const dir of ['valid', 'k1a', 'rope', 'refused', 't3a', 'tunnel']) {
    const fixDir = path.join(root, 'kit', 'test', 'fixtures', 'plan', dir);
    if (!fs.existsSync(fixDir)) continue;
    for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.json')).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
      if (!fx.plan) continue;
      const parts = [...(fx.plan.forms ?? []), ...(fx.plan.connectors ?? [])];
      // (an H part, a fixture H added, or one H re-answers by name: §14 item 11's list)
      if (parts.some((c) => H_KINDS.includes(c.kind)) || !fs.existsSync(path.join(mainDir, 'kit', 'test', 'fixtures', 'plan', dir, f))) { skipped++; continue; }
      if (fx.volume) continue; // (a frozen volume built by its own test)
      const sv = (h) => (fx.terrain ? h.flatSurvey(fx.terrain) : fx.on === 'asks' ? h.asksSurvey() : fx.on === 'flat' ? h.flatSurvey() : fx.on ? h.goldenSurvey(fx.on) : h.flatSurvey());
      const runOn = async (h) => { const s = sv(h); return h.checkPlanLocal(fx.plan, { survey: s.bytes, claim: s.claim, anchors: { ...h.stewardAnchors(s.claim), ...(fx.anchors ?? {}) }, protected: fx.protected ?? [], builds: fx.builds ?? [], ...(fx.standing ? { standing: fx.standing } : {}), ...(fx.biomes ? { biomes: fx.biomes } : {}) }); };
      let a, b;
      try { a = await runOn(hNew); b = await runOn(hOld); } catch (e) { out.fixtures[`${dir}/${f}`] = { error: String(e.message).slice(0, 200) }; continue; }
      const norm = (r) => r.res.irJson.replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
      const answers = (r) => JSON.stringify(r.check.parts);
      const eq = { answers: answers(a) === answers(b), ir: sha256(norm(a)) === sha256(norm(b)), overall: a.check.overall === b.check.overall };
      out.fixtures[`${dir}/${f}`] = eq;
      if (eq.answers && eq.ir && eq.overall) same++;
    }
  }
  out.same = same; out.n = Object.keys(out.fixtures).length; out.skipped = skipped;
  out.differ = Object.entries(out.fixtures).filter(([, v]) => !(v.answers && v.ir && v.overall)).map(([k, v]) => [k, v]);
  return out;
}

/** Items 1-3, 5, 6 on h_core_demo (a flat world). */
export async function ingame(ctx) {
  ctx.check(false, 'h-ingame: H-core\'s in-game items are not built yet');
  return null;
}

/** Item 7: the crashes. */
export async function crash(ctx) {
  ctx.check(false, 'h-crash: H-core\'s crash items are not built yet');
  return null;
}

/** Items 13 and 14: the probes. */
export async function probe(ctx) {
  ctx.check(false, 'h-probe: H-core\'s probes are not built yet');
  return null;
}
