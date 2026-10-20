// (6c S3) Item 4 in game (docs/CONTRACT.md "Phase 6c slice S3" §9 item 4, s3-plan): the monastery's plan/0 as Steward would send it
// (kit/regions/terraced_monastery.mjs monasteryPlan: the districts with `terraces`, the fountain, the spires, the relief, the lookout path;
// no program step) through Regions.checkPlan's two-plan flow (guards, the fountain's volume) and realiseApproved, then Regions.remove:
//   natural  a fresh copy of S3's site (its chunks settled 90 s first, so the spring stream flows and is in the survey; the spring's
//            columns registered as the owner's protected area, as the program names them): READY, PLACED, the fountain settled and
//            census-exact, the realised world equal to the virtual one over every written cell, M25:clear 0; E-normal 0 unclassified
//            under S3's classes (tools/scenarios.mjs s3Classify);
//   flat     the flat variant's hill raised first (s3_hill, kept) on the flat base: the same, and E-flat 0.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const OWNER = 'test:s3';
const BIBLE = 'g6c_s3_monastery';

/** The fixture bible installed as the helper's bible BIBLE v1 (the check's style). */
function installBible(ctx) {
  const { L, root } = ctx;
  const dst = path.join(L.GAME_DIR, 'architect', 'bibles', BIBLE, 'versions', '1');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(root, 'scenarios', 'bibles', `${BIBLE}.json`), path.join(dst, 'bible.json'));
}

/** The realised world against the virtual one over every written cell outside the lot boxes (gate6cvoc-b's rule: a cell that held its
 * state before stays as it was; a property subset is equal). */
function realisedVsVirtual(vw, ir, after, before) {
  const b = after.box;
  const inLot = (x, y, z) => ir.lots.some((l) => x >= l.box.minX && x <= l.box.maxX && y >= l.box.minY && y <= l.box.maxY && z >= l.box.minZ && z <= l.box.maxZ);
  const parse = (st) => { const m = /^([^[]+)(?:\[(.*)\])?$/.exec(st); return { name: m[1], props: Object.fromEntries((m[2] ? m[2].split(',') : []).map((kv) => kv.split('='))) }; };
  const same = (want, got) => { if (want === got) return true; const a = parse(want), q = parse(got); return a.name === q.name && Object.entries(a.props).every(([k, v]) => q.props[k] === v); };
  let written = 0, differ = 0, kept = 0;
  const first = [];
  vw.eachWritten((x, y, z, idx) => {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY || z < b.minZ || z > b.maxZ || inLot(x, y, z)) return;
    written++;
    const want = vw.pal.states[idx], got = after.palette[after.cells[after.at(x, y, z)]];
    if (same(want, got)) return;
    if (before && before.palette[before.cells[before.at(x, y, z)]] === got) { kept++; return; }
    differ++;
    if (first.length < 12) first.push({ pos: [x, y, z], want, got });
  });
  return { written, differ, kept, first };
}

/** Regions.remove by the plan's owner, then its state until REMOVED (PARTIAL or FAILED end it too). */
async function removeWait(L, region) {
  const t0 = Date.now();
  const r = await L.call('dev.region.remove', { region, requester: OWNER }, 3_600_000);
  for (let i = 0; i < 2400; i++) {
    const st = await L.call('dev.region.state', { region }, 60_000).catch(() => null);
    const s = st?.view?.state;
    if (!s || s === 'REMOVED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s ?? 'REMOVED' };
    if (s === 'PARTIAL' || s === 'FAILED') return { ...r, seconds: (Date.now() - t0) / 1000, state: s };
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`removal of ${region} did not finish`);
}

/** One variant of item 4: {check, realise, census, equal, clear, exact}. */
export async function planTwin(ctx, variant) {
  const { L, root, check, log, json, OUT } = ctx;
  const core = await import('./gate6chy-core.mjs');
  const S3 = await import('./scenario-s3.mjs');
  const SC = await import('../scenarios.mjs');
  const imp = (p) => import(pathToFileURL(path.join(root, 'kit', p)).href);
  const { surveyApi, sampleIndex } = await imp('lib/region/survey.mjs');
  const { monasteryPlan } = await imp('regions/terraced_monastery.mjs');
  const { buildVirtual, decodeArwd, F_WRITTEN } = await imp('lib/region/vworld.mjs');
  const { clearScan } = await imp('lib/region/checkFluids.mjs');
  const sc = JSON.parse(fs.readFileSync(path.join(root, 'scenarios', 's3_monastery.json'), 'utf8'));
  const c = sc.fixture.claim;
  const claim = { minX: c[0], minZ: c[1], maxX: c[2], maxZ: c[3], minY: -64, maxY: 319 };
  const tag = `s3plan-${variant}`;
  const out = { variant };
  installBible(ctx);
  // ---- the world: a fresh copy of S3's site (settled), or the flat base with the hill raised and kept
  await L.fresh(`G6B S3 Twin ${variant}`, variant === 'natural' ? await L.seedBase(sc.world.seed) : core.FLAT);
  await L.setRules('exact');
  await L.cmd('/weather clear');
  await L.tp((c[0] + c[2]) / 2, sc.fixture.yRange[1], (c[1] + c[3]) / 2);
  await L.call('dev.waitChunks', { timeoutMs: 180_000 }, 240_000).catch(() => null);
  if (variant === 'flat') out.hill = await S3.raiseHill(L, c, sc);
  await L.tp((c[0] + c[2]) / 2, sc.fixture.yRange[1], (c[1] + c[3]) / 2);
  await L.settle(90_000);
  // ---- the plan from the settled world's own survey (the anchors Steward would compute from what it sees)
  const sv = path.join(OUT, `${tag}-survey.bin`);
  await L.call('dev.region.survey', { claim: c, surveyLoad: 'bounded:256', file: sv }, 900_000);
  const S = surveyApi(fs.readFileSync(sv), claim);
  const { plan, anchors, protected: prot } = monasteryPlan(claim, S, {});
  fs.writeFileSync(path.join(OUT, `${tag}-plan.json`), `${JSON.stringify({ plan, anchors, protected: prot }, null, 1)}\n`);
  for (const a of prot) {
    const area = { owner: OWNER, id: a.id, x0: a.rect[0], z0: a.rect[1], x1: a.rect[2], z1: a.rect[3], label: 'S3 spring stream (kept)' };
    await L.cmd(`/apitest unprotect ${OWNER} ${a.id}`).catch(() => null);
    await L.cmd(`/apitest protect ${JSON.stringify(area).replaceAll(' ', '_')}`);
  }
  out.protected = prot;
  // ---- Regions.checkPlan (the two-plan flow)
  const ck = await L.call('dev.region.checkPlan', { plan, claim: c, owner: OWNER, anchors, load: 'generate', bible: BIBLE }, 1_800_000);
  fs.writeFileSync(path.join(OUT, `${tag}-check.json`), `${JSON.stringify(ck, null, 1)}\n`);
  const parts = (ck.check?.parts ?? []).map((a) => [a.part, a.class, a.reasons?.[0]?.code ?? null]);
  out.check = { overall: ck.check?.overall ?? null, parts, refused: ck.refused ?? null, volumePass: ck.volumePass ?? null };
  const zone = (ck.check?.parts ?? []).find((a) => a.part === 'monastery');
  const lotsPlaced = zone?.geometry?.lots?.length ?? 0;
  // (the spires are required: false; a spire with no level site answers refused NO_ROOM and the plan stays READY)
  check(ck.check?.overall === 'READY' && ['fits', 'adjusted'].includes(zone?.class) && parts.filter(([p]) => p !== 'monastery' && !/^spire_/.test(p)).every(([, k]) => k === 'fits' || k === 'adjusted'),
    `item 4 (${variant}): Regions.checkPlan's two-plan flow on the ${variant === 'natural' ? 'settled copy of S3' : 'flat hill'}: ${ck.check?.overall}; ${json(parts)}; ${lotsPlaced} lots on terraces`);
  if (ck.check?.overall !== 'READY') { await L.leaveWorld(); return out; }
  // ---- the box: the claim + 8, the survey's floor - 8 to its top + 24
  let y0 = 320, y1 = -64;
  for (let x = c[0]; x <= c[2]; x += 2) for (let z = c[1]; z <= c[3]; z += 2) { y0 = Math.min(y0, S.floorAt(x, z)); y1 = Math.max(y1, S.topAt(x, z)); }
  const box = [c[0] - 8, Math.max(-64, y0 - 8), c[1] - 8, c[2] + 8, Math.min(319, y1 + 24), c[3] + 8];
  await L.cmd('/kill @e[type=!minecraft:player]');
  const snapF = await core.snap(ctx, box, tag);
  const d0 = await L.call('dev.region.dump', { box, file: path.join(OUT, `${tag}-before.arwd.gz`) }, 1_800_000);
  const fBefore = new Map((await L.call('dev.fluid.census', { box }, 900_000)).fluids.map(([x, y, z, st]) => [`${x},${y},${z}`, st]));
  void d0;
  // ---- realiseApproved
  const r = await core.realiseApproved(ctx, ck.check.artifactSha);
  if (r.refused) { check(false, `item 4 (${variant}): realiseApproved refused (${json(r.refused)})`); await L.leaveWorld(); return out; }
  const rows = (r.fluids ?? []).map((x) => [x.part, x.body, x.state]);
  out.realise = { region: r.region, state: r.view.state, rows };
  check(r.view.state === 'PLACED' && rows.length === r.bodies.length && rows.length > 0 && rows.every(([, , s]) => s === 'settled'), `item 4 (${variant}): realised from the approved artifact, PLACED, the fountain settled (${r.view.state}; ${json(rows)})`);
  const cs = {};
  for (const b of r.bodies) { const x = await core.censusOf(ctx, b, fBefore, r.bodies); cs[b.id] = { ok: x.ok, sources: x.sources, flowing: x.flowing, mismatch: x.mismatch.length, outside: x.outsideCount }; }
  out.census = cs;
  check(Object.values(cs).length > 0 && Object.values(cs).every((x) => x.ok), `item 4 (${variant}): the fountain's census equals its prediction (${json(cs)})`);
  // ---- the realised world against the virtual one; M25:clear on the approved IR
  const planDir = path.join(L.SIDECAR_DATA, 'regions', 'plans', r.planId);
  const ir = r.ir, meta = JSON.parse(fs.readFileSync(path.join(planDir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(planDir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { vw } = buildVirtual({ ir, survey: fs.readFileSync(path.join(planDir, 'survey.bin')), blobs });
  const dA = path.join(OUT, `${tag}-after.arwd.gz`);
  await L.call('dev.region.dump', { box, file: dA }, 1_800_000);
  const after = await decodeArwd(fs.readFileSync(dA)), before = await decodeArwd(fs.readFileSync(path.join(OUT, `${tag}-before.arwd.gz`)));
  const eq = realisedVsVirtual(vw, ir, after, before);
  out.equal = eq;
  check(eq.written > 0 && eq.differ === 0, `item 4 (${variant}): the realised world equals the virtual one over every written cell outside the lot boxes (${eq.written} cells; ${eq.differ} differ; ${eq.kept} kept as they stood)`, eq.first);
  const clear = clearScan({ ir, vw, meta });
  out.clear = clear.counts;
  check(clear.counts.hard + clear.counts.watch === 0, `item 4 (${variant}): M25:clear 0 on the approved plan (${json(clear.counts)})`);
  // ---- Regions.remove and the box against its snapshot
  await L.cmd('/kill @e[type=!minecraft:player]');
  const rm = await removeWait(L, r.region).catch((e) => ({ error: String(e.message ?? e) }));
  await L.settle(10_000);
  const diff = await L.call('dev.region.hash', { box, mode: 'diff', file: snapF }, 4 * 3_600_000);
  const raw = { mismatches: diff.mismatches, classes: diff.classes ?? {}, list: diff.list ?? [] };
  if (variant === 'flat') {
    out.exact = { kind: 'E-flat', mismatches: raw.mismatches, classes: raw.classes, sample: raw.list.slice(0, 12) };
    check(rm.state === 'REMOVED' && raw.mismatches === 0, `item 4 (flat): Regions.remove (${rm.state ?? rm.error}) leaves the hill world exactly as it was: E-flat ${raw.mismatches} (${json(raw.classes)})`, raw.list.slice(0, 12));
  } else {
    const { sampleIndex: sampleIndexOf } = await imp('lib/region/survey.mjs');
    const e = SC.s3Classify(raw, { vw, ir, F_WRITTEN, sampleIndexOf });
    const written = (r.st?.record?.cellsWritten ?? eq.written) || 1;
    out.exact = { kind: 'E-normal', mismatches: e.mismatches, classes: e.classes, unclassified: e.classes?.none ?? 0, cellsWritten: written, sample: (e.list ?? []).filter((m) => m.class === 'none').slice(0, 12) };
    check(rm.state === 'REMOVED' && (e.classes?.none ?? 0) === 0, `item 4 (natural): Regions.remove (${rm.state ?? rm.error}); E-normal ${e.mismatches} (${json(e.classes)}): 0 unclassified under S3's classes`, out.exact.sample);
  }
  void sampleIndex;
  for (const a of prot) await L.cmd(`/apitest unprotect ${OWNER} ${a.id}`).catch(() => null);
  await L.leaveWorld();
  log(`  ${tag}: ${json({ check: out.check.overall, state: out.realise?.state, census: Object.values(out.census ?? {}).map((x) => x.ok), differ: out.equal?.differ, clear: out.clear, exact: out.exact?.mismatches })}`);
  return out;
}
