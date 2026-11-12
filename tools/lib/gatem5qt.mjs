// M5 QT gate (docs/CONTRACT.md "M5 support", slice QT; Steward's S-M5-7 and review change 1): Regions.quote and Regions.quoteApproved,
// registered into tools/gate6dgr.mjs (GR's survival town, growth and feed helpers). Headless server, the sim sidecar: $0.
//
//   node tools/gate6dgr.mjs qtunit      (qt-unit)      the kit's survivalBom units, QuotesTest and ApiQTTest, api-compat
//   node tools/gate6dgr.mjs qtgrowth    (qt-growth)    a survival flat_village town (fed until built), a growth by planRevision with two bound
//                                                      lots: Regions.quote twice between two hashes of the claim box, two listings of the
//                                                      journal, <world>/architect and the regions dir and two stockpile states (nothing
//                                                      written, nothing consumed, the answers equal); realised with those entries and fed:
//                                                      the stockpile's consumed delta equals the quote's bom item for item; qt_hut's piece is not
//                                                      its template's bill (the put-down's bill, not the template's)
//   node tools/gate6dgr.mjs qtapproved  (qt-approved)  a plan/0 town checked in survival: Regions.quoteApproved with two lot entries over the
//                                                      artifact (the same no-write proof; quote of the artifact's plan id with the merged
//                                                      entries equals it), realiseApproved with them, fed: consumed equals the quote
//
// Evidence: artifacts/gate6d-gr/<step>.json (GATE6DGR_OUT), all.log, spend.json ($0.00).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** Every file under dir: relative path -> "bytes:sha16". */
function listing(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const b = fs.readFileSync(p); out[path.relative(dir, p)] = `${b.length}:${crypto.createHash('sha256').update(b).digest('hex').slice(0, 16)}`; }
    }
  };
  walk(dir);
  return out;
}
function listDiff(a, b) {
  const d = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(`${k}: ${a[k] ?? '-'} -> ${b[k] ?? '-'}`);
  return d;
}

export async function registerQT(steps, h) {
  const { L, call, check, cmd, log, OUT, json, G, ensure, spendZero, hashOf, groundY, BOXOF, CX, CZ, CLAIM, P0_TOWN, P0_LOT, P0_CLAIM, growPlan, rvState, rvWait, root } = h;
  const ctx = { L, OUT, imp: h.imp, KIT: path.join(root, 'kit') };
  const strip = (q) => { const o = { ...q }; for (const k of ['id', 'type', 'ok', 'ms', 'thread']) delete o[k]; return o; };

  /**
   * The quote designs: rs_hut and rs_shed (RS's), and qt_hut: a room whose floor (its ground row, y 0 under groundY 1) is grass, as the flat
   * land's own ground there: the builder finds those cells built and pays nothing, so the lot's bill is not its template's.
   */
  async function designs() {
    await G.designs(ctx);
    const { Blueprint, palette } = await h.imp('lib/kit.mjs');
    const { writeBlueprint } = await h.imp('lib/write.mjs');
    const X = 6, Z = 4, H = 4;
    const bp = new Blueprint({ id: 'qt_hut', name: 'qt_hut', description: 'QT hut (a generated approach)', type: 'custom', profile: ['door', 'lit'], size: [X + 1, H + 1, Z + 1], origin: [0, 0, 0], groundY: 1, front: 'south', palette: palette({}), interior: [1, 1, 1, X - 1, H - 1, Z - 1] });
    bp.part('main', () => bp.room([0, 0, 0, X, H, Z], { wall: 'minecraft:spruce_planks', floor: 'minecraft:grass_block', ceiling: 'minecraft:oak_planks', corners: 'minecraft:oak_log' }));
    bp.part('openings', () => { bp.door(3, 1, Z, 'south'); bp.set(3, 3, 1, 'minecraft:wall_torch', { facing: 'south' }); });
    bp.spot('entrance', 3, Z + 1, 180);
    const dir = path.join(L.LIBRARY, 'qt_hut');
    fs.rmSync(dir, { recursive: true, force: true });
    writeBlueprint(bp, dir);
    await L.cmd('/architect reload');
    await L.settle(1500);
  }

  const pile = async () => (await call('dev.stockpile.state', { owner: G.OWNER }, 60_000)).stockpile ?? {};
  const quote = (o) => call('dev.region.quote', o, 300_000);
  const tmplBom = async (entry) => (await call('dev.qt.templateBom', { entry }, 30_000)).bom ?? {};

  /**
   * The no-write proof (LC's and AF's): two quotes between two hashes of the box, two listings of Architect's world dirs and two stockpile
   * states; the land's and the files' own drift measured first with no call. Three rounds; the answers equal.
   */
  async function noWrite(worldDir, box, req, label) {
    const dirs = [path.join(worldDir, 'architect-journal'), path.join(worldDir, 'architect'), path.join(worldDir, 'architect-regions')];
    await call('dev.wait', { ms: 3000 }, 30_000);
    const d0 = await hashOf(box), f0 = dirs.map(listing);
    await call('dev.wait', { ms: 3000 }, 30_000);
    const d1 = await hashOf(box), f1 = dirs.map(listing);
    const drift = dirs.map((d, i) => listDiff(f0[i], f1[i])).flat();
    check(d0 === d1 && drift.length === 0, `${label}: the land and Architect's files hold still with no call (3 s apart): hash ${d0 === d1 ? 'same' : 'MOVED'}, ${drift.length} files moved`, drift.slice(0, 8));
    const rounds = [];
    let first = null;
    for (let i = 0; i < 3; i++) {
      const h0 = await hashOf(box), l0 = dirs.map(listing), p0 = await pile();
      const a = await quote(req);
      const b = await quote(req);
      await call('dev.wait', { ms: 1500 }, 30_000);
      const h1 = await hashOf(box), l1 = dirs.map(listing), p1 = await pile();
      const diffs = dirs.map((d, n) => listDiff(l0[n], l1[n]));
      first ??= a;
      const same = json(strip(a)) === json(strip(b)) && json(strip(a)) === json(strip(first));
      const pileSame = json({ s: p0.stock, l: p0.ledger, o: p0.outstanding }) === json({ s: p1.stock, l: p1.ledger, o: p1.outstanding });
      const files = l0.reduce((n, l) => n + Object.keys(l).length, 0);
      check(!a.refused && h0 === h1 && diffs.every((d) => d.length === 0) && files > 0 && pileSame && same, `${label} round ${i + 1}: two quotes wrote nothing and took nothing: the box's hash ${h0 === h1 ? 'unchanged' : 'MOVED'}; ${files} files of the journal, <world>/architect and the regions dir unchanged (${diffs.flat().length} differ); the stockpile's stock, ledger and outstanding unchanged: ${pileSame}; the answers equal: ${same} (${a.ms?.toFixed?.(1)} ms on ${a.thread})`, { diffs, refused: a.refused });
      rounds.push({ h0, h1, diffs, ms: [a.ms, b.ms] });
    }
    return { quote: first, rounds };
  }

  /** Fed until built; the stockpile's consumed delta against the quote's bom (and each piece against its source). */
  async function consumedEquals(region, q, ps0, label, until) {
    const f = await G.feed({ L }, region, { fraction: 1, until, timeoutMs: 1_800_000, every: 2500 });
    const ps1 = await pile();
    const paid = G.minus(ps1.ledger?.consumed ?? {}, ps0.ledger?.consumed ?? {});
    const want = q.bom ?? {};
    check(Object.keys(want).length >= 1 && G.same(want, paid), `${label}: the materials consumed equal the quote item for item: quote ${json(want)}, consumed ${json(paid)} (${f.waves} feed waves)`, { want, paid, diff: G.minus(paid, want), parts: q.bomParts });
    return { paid, want, waves: f.waves, last: f.last };
  }

  steps.qtunit = async () => {
    const out = {};
    out.kit = h.nodeTest(['kit/test/qt.test.mjs']);
    check(out.kit.code === 0 && out.kit.fail === 0 && out.kit.pass >= 3, `kit qt.test (a survival plan's survivalBom per group equals the plan check's cells bill; a creative plan has none; the IR and its sha unchanged): ${out.kit.pass} pass, ${out.kit.fail} fail`, out.kit.failing);
    out.java = await h.javaTests(['*QuotesTest*', '*ApiQTTest*'], 5);
    check(out.java.ok, `QuotesTest, ApiQTTest: ${out.java.tests} tests, ${out.java.failures} failures (${out.java.names.join('; ')})`, out.java.tail);
    const env = { ...process.env, JAVA_HOME: '/opt/homebrew/opt/openjdk@25', PATH: `/opt/homebrew/opt/openjdk@25/bin:${process.env.PATH}` };
    const J = h.apiJars();
    out.apicompat = [...J.jars.map((j) => ['tools/api-compat.mjs', j]), ['tools/api-compat.mjs', '--surface', J.surface]].map((args) => {
      const ac = fs.existsSync(args.at(-1)) ? spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 900_000, env }) : { status: -1, stdout: `missing ${args.at(-1)}`, stderr: '' };
      return { args: args.slice(1).map((a) => path.basename(a)), code: ac.status, tail: `${ac.stdout}${ac.stderr}`.split('\n').filter(Boolean).slice(-3) };
    });
    check(out.apicompat.every((a) => a.code === 0), 'api-compat: binary compatible with the 0.47.0 and 0.45.0 apitest jars and the 0.47.0 mod surface (Regions gains two default methods, a new record Quote)', out.apicompat);
    spendZero();
    return out;
  };

  steps.qtgrowth = async () => {
    await ensure();
    const out = {};
    const SW = 'G6B QT Growth';
    await G.survivalBase(ctx);
    await L.fresh(SW, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await designs();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const BOX = BOXOF(CLAIM, gy);
    const worldDir = path.join(L.SAVES, SW);
    const crates = [0, 1, 2, 3].map((k) => [CLAIM[0] - 6 + 2 * k, gy + 1, CLAIM[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    // the town in survival: flat_village, its lots pads, realised and fed until built
    const p0 = await L.plan('flat_village', CLAIM, { params: { lots: [{ id: 'hall_1', type: 'hall', size: [13, 11], landmark: true }, { id: 'cottage_1', type: 'cottage', size: [9, 9] }] }, surveyLoad: 'bounded:256', check: false, owner: G.OWNER });
    const q0 = await quote({ planId: p0.planId, lotEntries: { cottage_1: 'rs_hut' } });
    out.town = { planId: p0.planId, quote: strip(q0) };
    check(!q0.refused && q0.survival === true && q0.region === null, `the town's plan quoted (a first realise, survival): ${q0.refused ?? `bom ${json(q0.bom)}`}`);
    const ps00 = await pile();
    const region = await L.realise(p0.planId, { load: 'bounded:512', lots: { cottage_1: 'rs_hut' } });
    const t = await consumedEquals(region, q0, ps00, 'the town (a first realise, quote(planId) with a bound lot)', (st, rs) => st.view.state === 'PLACED' && rs.build?.done);
    out.town.paid = t.paid;
    // a growth by planRevision with two bound lots: quoted, nothing written; realised with those entries, fed; consumed = quote
    const g = await growPlan(region, { lots: [{ id: 'qa', type: 'house', size: [9, 9], villager: 'dwelling' }, { id: 'qb', type: 'house', size: [9, 9], villager: 'dwelling' }] });
    check(!g.refused && g.revisionOf?.rid >= 1, `a growth planned (planRevision, two lots): ${g.refused ?? `${g.planId} rid ${g.revisionOf?.rid}`}`);
    const entries = { qa: 'qt_hut', qb: 'rs_shed' };
    const nw = await noWrite(worldDir, BOX, { planId: g.planId, lotEntries: entries }, 'the growth');
    const q = nw.quote;
    out.growth = { planId: g.planId, quote: strip(q), rounds: nw.rounds };
    check(q.survival === true && q.region === region && json(q.lotEntries) === json(entries) && Object.keys(q.bomParts).some((k) => k.startsWith('tiles:')) && q.bomParts['lot:qa'] && q.bomParts['lot:qb'],
      `the growth's quote: region ${q.region}, entries ${json(q.lotEntries)}, parts ${json(Object.keys(q.bomParts ?? {}))}, exact ${q.exact}${q.notes?.length ? `; notes ${json(q.notes)}` : ''}`);
    // the put-down's bill, not the template's (the plan check's lot bill): qt_hut's grass floor stands already, so its piece is less
    const tq = await tmplBom('qt_hut');
    const d1 = G.minus(q.bomParts['lot:qa'] ?? {}, tq);
    out.growth.template = { qt_hut: tq, diff: d1 };
    check(Object.keys(d1).length > 0, `lot qa (qt_hut)'s piece is not its template's bill (the cells the land holds already, C26's full bill): piece - template = ${json(d1)}`);
    // the quote of an over-bound bill takes nothing (Steward's 4.2 step 5): the stockpile unchanged across the quotes (above), the realise now
    const ps0 = await pile();
    const r = await call('dev.region.realise', { planId: g.planId, lots: entries }, 300_000);
    check(!r.refused, `the growth realised with the quoted entries: ${r.refused ?? r.region}`);
    const rid = g.revisionOf.rid;
    // the growth's items queued (its revision PLACING, or its targets put down) before the feed judges "built"
    const t0 = new Set((t.last.rs?.targets ?? []).map((x) => x.id));
    for (let i = 0; i < 90; i++) {
      const sv = await rvState(region);
      const rs = await G.rsState(ctx, region);
      if ((rs.targets ?? []).some((x) => !t0.has(x.id)) || sv.revisions?.find((x) => x.rid === rid)?.state !== 'ACCEPTED') break;
      await L.sleep(2000);
    }
    const c = await consumedEquals(region, q, ps0, 'the growth (quote(planId) of a planRevision growth with two bound lots)', (st, rs) => st.view.state === 'PLACED' && rs.build?.done);
    const done = await rvWait(region, rid, 1_800_000);
    out.growth.paid = c.paid;
    out.growth.rev = done.r?.state;
    check(['PLACED', 'DONE', 'BUILT'].includes(String(done.r?.state)) || done.st?.busy === null, `the growth's revision ${rid} ended: ${done.r?.state}`);
    await L.leaveWorld();
    spendZero();
    return out;
  };

  steps.qtapproved = async () => {
    await ensure();
    const out = {};
    const SW = 'G6B QT Approved';
    await G.survivalBase(ctx);
    await L.fresh(SW, G.SURV);
    await L.setRules('exact');
    await cmd('/weather clear');
    await designs();
    await L.tp(CX + 80, 80, CZ + 56);
    const gy = await groundY();
    const claim = P0_CLAIM;
    const BOX = BOXOF(claim, gy);
    const worldDir = path.join(L.SAVES, SW);
    const crates = [0, 1, 2, 3].map((k) => [claim[0] - 6 + 2 * k, gy + 1, claim[1] - 6]);
    const cr = await call('dev.stockpile.create', { owner: G.OWNER, crates }, 120_000);
    check(!cr.refused, `a stockpile of 4 crates for ${G.OWNER}: ${json(cr.refused ?? 'made')}`);
    const c0 = (await call('dev.region.checkPlan', { plan: P0_TOWN, claim, owner: G.OWNER, load: 'generate' }, 1_800_000)).check;
    check(c0?.survival === true && c0.overall === 'READY' && c0.artifactSha, `the town checked in survival: ${c0?.overall}, artifact ${c0?.artifactSha?.slice(0, 12)}`);
    const entries = { h1: 'qt_hut', h2: 'rs_hut' };
    const nw = await noWrite(worldDir, BOX, { sha: c0.artifactSha, lotEntries: entries }, 'the approved artifact');
    const q = nw.quote;
    out.quote = strip(q);
    out.rounds = nw.rounds;
    check(q.survival === true && q.artifactSha === c0.artifactSha && q.region === null && q.bomParts['lot:h1'] && q.bomParts['lot:h2'], `quoteApproved: artifact ${q.artifactSha?.slice(0, 12)}, entries ${json(q.lotEntries)}, parts ${json(Object.keys(q.bomParts ?? {}))}, exact ${q.exact}`);
    // the twin: quote of the artifact's plan with the merged entries answers the same bill
    const qp = await quote({ planId: q.planId, lotEntries: q.lotEntries });
    check(!qp.refused && json(qp.bom) === json(q.bom) && json(qp.bomParts) === json(q.bomParts), `quote(planId) of the artifact's plan with the same entries equals quoteApproved's bill: ${qp.refused ?? json(qp.bom)}`);
    // the plan check's own bill (lots as template bills) is not the quote: the quote's lot pieces carry C26's full bill
    out.check = { bom: c0.cost?.bom, bomParts: c0.cost?.bomParts };
    const tq = await tmplBom('qt_hut');
    const d2 = G.minus(q.bomParts['lot:h1'] ?? {}, tq);
    out.template = { qt_hut: tq, diff: d2 };
    check(Object.keys(d2).length > 0, `lot h1 (qt_hut)'s piece is not its template's bill: piece - template = ${json(d2)}`);
    const ps0 = await pile();
    const region = await G.realise(ctx, c0.artifactSha, entries);
    const c = await consumedEquals(region, q, ps0, 'the approved artifact (quoteApproved with two lot entries, then realiseApproved)', (st, rs) => st.view.state === 'PLACED' && rs.build?.done);
    out.paid = c.paid;
    const u = await call('dev.region.quote', { sha: 'f'.repeat(64), lotEntries: {} }, 60_000);
    check(String(u.refused ?? '').startsWith('ARTIFACT_UNAPPROVED'), `an unknown artifact refuses ARTIFACT_UNAPPROVED: ${u.refused}`);
    const v = await call('dev.region.quote', { planId: 'no-such-plan', lotEntries: {} }, 60_000);
    check(String(v.refused ?? '').startsWith('PLAN_STALE'), `an unknown plan refuses PLAN_STALE: ${v.refused}`);
    await L.leaveWorld();
    spendZero();
    return out;
  };
}
