// (7b SB, docs/CONTRACT.md "Phase 7b" §3 row 11, "Slice SB as built") The S5/S6 scenario runs' own steps, called by tools/scenarios.mjs:
//   sculpt(L, sc, claim, flat)   the scenario's sculpt (S5's giant trees, S6's cavern) written into the fresh world as natural, unowned
//                                land with vanilla /fill before the plan (the flat variant of S6 raises S3's hill first); the sculpt's
//                                record (its meta.sb) gives the program its params
//   siteEntries(L, sc, ir, tag)  the $0 lots: per fit, one archetype designed by the sim's site-aware stub (a fit example built into the
//                                first site lot of that fit, DS), then Designs.siteVariant of it for every other lot of that fit
//   sbRows(...)                  the Fit and disturbance metrics (SETTLEMENTS §16.3) and the site lots' ports reached on the realised
//                                world
// Each run records what it did in run.json (`sb`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (p) => import(path.join(root, 'kit', p));
const row = (id, label, value, threshold, pass, gated = true) => ({ id, label, value, threshold, pass: gated ? !!pass : null, gated });

/** /fill takes at most 32768 cells: a box over that is cut along its longest axis. */
export function splitBox(r, max = 32768) {
  const n = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * (r.z1 - r.z0 + 1);
  if (n <= max) return [r];
  const ax = [['x', r.x1 - r.x0], ['y', r.y1 - r.y0], ['z', r.z1 - r.z0]].sort((a, b) => b[1] - a[1])[0][0];
  const m = (r[`${ax}0`] + r[`${ax}1`]) >> 1;
  return [...splitBox({ ...r, [`${ax}1`]: m }, max), ...splitBox({ ...r, [`${ax}0`]: m + 1 }, max)];
}

/** The scenario's sculpt into the open world (see the header). Returns {program, planId, irSha, runs, commands, cells, record, ms, hill?}. */
export async function sculpt(L, sc, claim, flat) {
  const t0 = Date.now();
  const S = sc.sculpt;
  let hill = null;
  if (flat && S.flatHill) hill = await (await import('./scenario-s3.mjs')).raiseHill(L, claim, sc);
  await L.cmd(`/forceload add ${claim[0]} ${claim[1]} ${claim[2]} ${claim[3]}`);
  const p = await L.plan(S.program, claim, { params: {}, surveyLoad: 'generated:64', seed: sc.seed });
  const dir = path.join(L.SIDECAR_DATA, 'regions', 'plans', p.planId);
  const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const blobs = (sha) => { const f = path.join(dir, 'blobs', `${sha}.bin`); return fs.existsSync(f) ? fs.readFileSync(f) : null; };
  const { sculptRuns, fillCommand } = await imp('lib/region/sculpt.mjs');
  const runs = sculptRuns(ir, fs.readFileSync(path.join(dir, 'survey.bin')), blobs);
  const list = runs.flatMap((r) => splitBox(r)).map(fillCommand);
  let cells = 0;
  for (const r of runs) cells += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * (r.z1 - r.z0 + 1);
  for (let i = 0; i < list.length; i += 32) {
    const res = await Promise.all(list.slice(i, i + 32).map((c) => L.cmd(c)));
    for (const [j, r] of res.entries()) if (!r?.success && !/No blocks were filled|Could not set/.test((r?.messages ?? []).join(' '))) throw new Error(`sculpt ${S.program}: ${list[i + j]}: ${JSON.stringify(r?.messages ?? [])}`);
  }
  await L.settle(3000);
  const out = { program: S.program, planId: p.planId, irSha: p.irSha, runs: runs.length, commands: list.length, cells, record: meta.sb ?? null, ms: Date.now() - t0, ...(hill ? { hill } : {}) };
  L.log(`  sculpt ${S.program}: ${list.length} /fill over ${cells} cells in ${Math.round(out.ms / 1000)} s; ${JSON.stringify(meta.sb ?? {}).slice(0, 200)}`);
  return out;
}

/** The program's params from the sculpt's record (S6: the hall's floor; S5: the grove). */
export function paramsFrom(sc, record) {
  if (!record) return { ...(sc.params ?? {}) };
  if (record.scenario === 's6') return { ...(sc.params ?? {}), floorY: record.floorY };
  if (record.scenario === 's5') return { ...(sc.params ?? {}), grove: record };
  return { ...(sc.params ?? {}) };
}

function volumeFile(L, sha) {
  for (const w of fs.existsSync(L.SAVES) ? fs.readdirSync(L.SAVES) : []) {
    const f = path.join(L.SAVES, w, 'architect', 'volumes', `${sha}.bin`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
const arr = (b) => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];

async function waitDesign(L, id, ms = 600_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await L.call('dev.ds.design', { designId: id }, 30_000);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(d.status)) return d;
    if (Date.now() - t0 > ms) throw new Error(`design ${id} still ${d.status} after ${ms / 1000}s: ${d.step}`);
    await L.call('dev.wait', { ms: 1000 }, 30_000);
  }
}

/**
 * The $0 lots of a plan's site lots (see the header): {entries {lot: entryId}, rows [{lot, fit, entry, how, ms, refused?}]}. The site
 * volume of each lot is frozen into the world first (Survey.volume of its volume box: the plan's sha, as LP's gate checks).
 */
export async function siteEntries(L, sc, ir, tag) {
  // (7b PA) the paid batch's lots: PA_PLAN names a plan (tools/gate7bpa.mjs writes it); without it, SB's $0 lots exactly as before
  if (process.env.PA_PLAN) return paSiteEntries(L, sc, ir, JSON.parse(fs.readFileSync(process.env.PA_PLAN, 'utf8')));
  const entries = {}, rows = [];
  const archetype = {};
  for (const lot of ir.lots.filter((l) => l.site)) {
    const t0 = Date.now();
    const s = lot.site;
    if (!volumeFile(L, s.volumeSha)) {
      const sv = await L.call('dev.survey.volume', { box: arr(s.volume), load: 'loaded' }, 600_000);
      if (sv.sha !== s.volumeSha) throw new Error(`${lot.id}: Survey.volume of the site volume has sha ${sv.sha}, the plan's ${s.volumeSha} (the land moved between the plan and the freeze)`);
    }
    if (!archetype[s.fit]) {
      const r = await L.call('dev.ds.request', { site: s, name: `SB ${sc.short ?? sc.id} ${s.fit}`, notes: lot.brief ?? '' }, 60_000);
      if (!r.designId) throw new Error(`${lot.id}: the archetype's design request refused: ${r.refused ?? JSON.stringify(r)}`);
      const d = await waitDesign(L, r.designId);
      if (d.status !== 'DONE' || !d.entryId) throw new Error(`${lot.id}: the archetype's design ended ${d.status}: ${d.error ?? d.step}`);
      archetype[s.fit] = d.entryId;
      entries[lot.id] = d.entryId;
      rows.push({ lot: lot.id, fit: s.fit, entry: d.entryId, how: 'archetype (the sim designer: the fit example built into this site)', ms: Date.now() - t0 });
      continue;
    }
    const v = await L.call('dev.ds.variant', { entryId: archetype[s.fit], site: s, opKey: `sb-${tag}-${lot.id}` }, 600_000);
    if (!v.entryId) { rows.push({ lot: lot.id, fit: s.fit, entry: null, how: 'site variant', refused: v.refused ?? JSON.stringify(v), detail: v.detail ?? null, ms: Date.now() - t0 }); continue; }
    entries[lot.id] = v.entryId;
    rows.push({ lot: lot.id, fit: s.fit, entry: v.entryId, how: `site variant of ${archetype[s.fit]}`, ms: v.ms ?? Date.now() - t0 });
  }
  return { entries, rows, archetypes: archetype };
}

/**
 * (7b PA, docs/CONTRACT.md "Phase 7b" §4 P2/P3) The paid batch's lots of a scenario run: per the plan, archetypes and a landmark designed
 * by the run's designer (the claude login, or the sim for P0) into their own site lots, each paid job guarded by the PA ledger
 * (tools/lib/pa-ledger.mjs: $60 stop, $90 refusal, the nightly window, budgetUsd = the job's share of the item's cap), then
 * Designs.siteVariant of its archetype for every other lot ($0). A plan's `reuse` maps an archetype key to an entry already paid for
 * (a re-run after a harness failure): its own lot then gets a $0 site variant of that entry, never a second paid design.
 * plan = {item, opPrefix, ledger, backend, capUsd, timeoutMin, archetypes: [{key, lot, landmark?, request {buildingType, bible, name,
 * notes}}], variants {lot: key}, reuse? {key: entryId}}. Returns siteEntries' shape plus {pa: {item, jobs, spendUsd, notShown}}.
 */
async function paSiteEntries(L, sc, ir, plan) {
  const P = await import('./pa-ledger.mjs');
  const entries = {}, rows = [], archetype = {}, jobs = [];
  const lots = new Map(ir.lots.filter((l) => l.site).map((l) => [l.id, l]));
  for (const lot of lots.values()) {
    const s = lot.site;
    if (volumeFile(L, s.volumeSha)) continue;
    const sv = await L.call('dev.survey.volume', { box: arr(s.volume), load: 'loaded' }, 600_000);
    if (sv.sha !== s.volumeSha) throw new Error(`${lot.id}: Survey.volume of the site volume has sha ${sv.sha}, the plan's ${s.volumeSha} (the land moved between the plan and the freeze)`);
  }
  const paid = plan.backend === 'claude';
  // the archetypes and the landmark: each guarded and opened at its full cap, then all started, then awaited
  const started = [];
  for (const a of plan.archetypes) {
    const lot = lots.get(a.lot);
    if (!lot) throw new Error(`PA plan: no site lot ${a.lot}`);
    const t0 = Date.now();
    if (plan.reuse?.[a.key]) {
      const src = plan.reuse[a.key];
      const v = await variantCall(L, { entryId: src, site: lot.site, opKey: `${plan.opPrefix}-reuse-${a.lot}` });
      if (v.entryId) { archetype[a.key] = v.entryId; entries[a.lot] = v.entryId; }
      rows.push({ lot: a.lot, fit: lot.site.fit, entry: v.entryId ?? null, how: `site variant of the paid ${a.key} ${src} (reused: a re-run pays nothing twice)`, ...(v.entryId ? {} : { refused: v.refused, detail: v.detail ?? null }), ms: Date.now() - t0 });
      continue;
    }
    const step = `${plan.item}:${a.key}:${a.lot}`;
    const cap = plan.capUsd;
    if (paid) {
      const st = await L.call('dev.sidecar.state', {}, 30_000).catch(() => ({}));
      const authSource = st.status?.authSource ?? 'unknown';
      const envKeys = P.KEY_VARS.filter((k) => process.env[k]?.trim());
      P.withLedger(plan.ledger, (Lg) => {
        const g = P.guard(Lg, { item: plan.item, step, capUsd: cap, minutes: plan.timeoutMin ?? 45, authSource, envKeys });
        if (!g.ok) throw Object.assign(new Error(g.message), { pa: g });
        P.openJob(Lg, { item: plan.item, step, capUsd: cap, authSource });
      });
      L.log(`  PA ${step}: paid design opened (cap $${cap}, auth ${authSource})`);
    }
    const body = { site: lot.site, ...a.request, notes: [a.request.notes, lot.brief].filter(Boolean).join(' '), opKey: `${plan.opPrefix}-${a.lot}`, ...(paid ? { budgetUsd: cap } : {}) };
    const r = await L.call('dev.ds.request', body, 60_000);
    if (!r.designId) {
      if (paid) P.withLedger(plan.ledger, (Lg) => P.updateJob(Lg, step, { usd: 0, ended: true, status: 'refused', error: r.refused ?? JSON.stringify(r) }));
      rows.push({ lot: a.lot, fit: lot.site.fit, entry: null, how: a.landmark ? 'landmark' : `archetype ${a.key}`, refused: r.refused ?? JSON.stringify(r), detail: r.detail ?? null, ms: Date.now() - t0 });
      continue;
    }
    started.push({ a, lot, step, t0, designId: r.designId, body });
  }
  for (const x of started) {
    const d = await waitPaid(L, x.designId, (plan.timeoutMin ?? 45) * 60_000, (dd) => { if (paid) P.withLedger(plan.ledger, (Lg) => P.updateJob(Lg, x.step, { usd: dd.cost?.usd ?? 0, designId: x.designId })); });
    const usd = d.cost?.usd ?? 0;
    const ok = d.status === 'DONE' && !!d.entryId;
    // (a TIMEOUT leaves the job open: it may still spend up to its budget, so the ledger keeps it at its cap)
    if (paid) P.withLedger(plan.ledger, (Lg) => P.updateJob(Lg, x.step, { usd, ended: d.status !== 'TIMEOUT', status: ok ? 'done' : String(d.status).toLowerCase(), designId: x.designId, entryId: d.entryId ?? undefined, error: ok ? undefined : d.error ?? d.step }));
    const job = { key: x.a.key, lot: x.a.lot, landmark: !!x.a.landmark, designId: x.designId, status: d.status, step: d.step, error: d.error ?? null, entryId: d.entryId ?? null, usd, turns: d.cost?.turns ?? null, ms: Date.now() - x.t0, request: { ...x.body, site: { volumeSha: x.body.site.volumeSha, fit: x.body.site.fit, lotId: x.body.site.lotId ?? x.a.lot } }, binding: d.entry?.binding ?? null };
    jobs.push(job);
    if (ok) { archetype[x.a.key] = d.entryId; entries[x.a.lot] = d.entryId; }
    rows.push({ lot: x.a.lot, fit: x.lot.site.fit, entry: d.entryId ?? null, how: `${x.a.landmark ? 'landmark' : `archetype ${x.a.key}`} (${paid ? 'paid: the claude login' : 'P0: the sim designer'})`, ...(ok ? {} : { refused: `not shown: ${d.status} ${d.error ?? d.step}` }), usd, ms: job.ms });
    L.log(`  PA ${x.step}: ${d.status} $${usd.toFixed(4)} in ${Math.round(job.ms / 1000)} s ${d.entryId ?? d.error ?? ''}`);
  }
  // the other lots: Designs.siteVariant of their archetype ($0)
  for (const [lotId, key] of Object.entries(plan.variants ?? {})) {
    const lot = lots.get(lotId);
    if (!lot) throw new Error(`PA plan: no site lot ${lotId}`);
    const t0 = Date.now();
    if (!archetype[key]) { rows.push({ lot: lotId, fit: lot.site.fit, entry: null, how: `site variant of ${key}`, refused: `no ${key} (its design is not shown)`, ms: 0 }); continue; }
    const v = await variantCall(L, { entryId: archetype[key], site: lot.site, opKey: `${plan.opPrefix}-v-${lotId}` });
    if (!v.entryId) { rows.push({ lot: lotId, fit: lot.site.fit, entry: null, how: `site variant of ${archetype[key]} (${key})`, refused: v.refused ?? JSON.stringify(v), detail: v.detail ?? null, ms: Date.now() - t0 }); continue; }
    entries[lotId] = v.entryId;
    rows.push({ lot: lotId, fit: lot.site.fit, entry: v.entryId, how: `site variant of ${archetype[key]} (${key})${v.replays ? ` (${v.replays} opKey replay(s): the ack passed the mod's 20 s timeout)` : ''}`, ms: v.ms ?? Date.now() - t0 });
  }
  const spendUsd = Math.round(jobs.reduce((a, j) => a + (j.usd ?? 0), 0) * 1e6) / 1e6;
  return { entries, rows, archetypes: archetype, pa: { item: plan.item, backend: plan.backend, jobs, spendUsd, notShown: rows.filter((r) => !r.entry).map((r) => r.lot) } };
}

/**
 * Designs.siteVariant through the DevBridge, replaying the same opKey when the answer is an untyped refusal. Under load the helper can ack
 * `site.variant` after the mod's 20 s ack timeout (SidecarLink.ACK_TIMEOUT_MS): the mod then answers a refusal with no reason ("null")
 * while the helper finishes and installs the variant; DS's opKey replay returns that entry ($0, no second build). A typed refusal
 * (SITE_UNFIT, SITE_UNSUPPORTED, ...) is final.
 */
async function variantCall(L, body, tries = 4) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await L.call('dev.ds.variant', body, 600_000);
    if (v.entryId || (v.refused && v.refused !== 'null' && /^[A-Z_]+/.test(v.refused))) return { ...v, replays: i };
    L.log(`  PA variant ${body.opKey}: untyped refusal ${JSON.stringify(v.refused ?? v)} (the helper's ack past the mod's 20 s timeout): replaying the opKey`);
    await L.call('dev.wait', { ms: 15_000 }, 40_000);
  }
  return { ...v, replays: tries };
}

/** A design's state until it ends, `onPoll` with each answer (the ledger's running cost). */
async function waitPaid(L, id, ms, onPoll) {
  const t0 = Date.now();
  for (;;) {
    const d = await L.call('dev.ds.design', { designId: id }, 30_000);
    if (onPoll) onPoll(d);
    if (['DONE', 'FAILED', 'CANCELLED'].includes(d.status)) return d;
    if (Date.now() - t0 > ms) return { ...d, status: 'TIMEOUT', error: `still ${d.status} after ${Math.round(ms / 60000)} min: ${d.step}` };
    await L.call('dev.wait', { ms: 10_000 }, 40_000);
  }
}

/** The kit's model of the game's survey classes, for a state string. */
async function classer() {
  const { stateClass } = await imp('lib/region/sculpt.mjs');
  const memo = new Map();
  return (st) => { let c = memo.get(st); if (c === undefined) { c = stateClass(st); memo.set(st, c); } return c; };
}
const SOLID = new Set(['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG']);

/** A placed entry's template cells in the world (its nbt's blocks, air included, turned by the site's frame). */
async function templateCells(L, entry, lot) {
  const { parse, plain } = await imp('lib/nbt.mjs');
  const zlib = await import('node:zlib');
  const dir = path.join(L.LIBRARY, entry);
  const f = path.join(dir, `${entry}.nbt`);
  if (!fs.existsSync(f)) return null;
  const s = plain(parse(zlib.gunzipSync(fs.readFileSync(f))));
  const { Site } = await imp('lib/site.mjs');
  const vf = volumeFile(L, lot.site.volumeSha);
  if (!vf) return null;
  const site = new Site(fs.readFileSync(vf), lot.site);
  const out = new Set();
  for (const b of s.blocks ?? []) { const [x, y, z] = site.toWorld(...b.pos); out.add(`${x},${y},${z}`); }
  return out;
}

/**
 * The Fit and disturbance rows (SETTLEMENTS §16.3) and the ports' reach, over the run's dumps (`before`, `after`: decoded arwd), the
 * realised world (`world`, dumpWorld's), the plan's meta.sb (dwellings, the fit called for), the lot states and the lots' entries.
 * Disturbance per site lot = (cut + fill) / the lot box's volume: cut = box cells the site held solid (rock, soil, loose, ice, snow, a
 * log) that the realise changed; fill = cells of the box and its columns down to 16 under it that changed but the entry's template does
 * not write (placement's own terrain work: TerrainFit's foundation fill and clearing; KEEP, every fit but on_pad, does none). Building
 * cells are neither (the house in the air is not fill).
 */
export async function sbRows({ L, ir, meta, before, after, world, lotStates, entries }) {
  const sb = meta.sb ?? {};
  const cls = await classer();
  const stAt = (d, x, y, z) => (x < d.box.minX || x > d.box.maxX || y < d.box.minY || y > d.box.maxY || z < d.box.minZ || z > d.box.maxZ ? null : d.palette[d.cells[d.at(x, y, z)]]);
  const placed = new Map((lotStates ?? []).map((l) => [l.id, l.state]));
  const site = ir.lots.filter((l) => l.site);
  // ---- Fit: the share of the dwellings with the fit the scenario calls for, placed
  const dwell = sb.dwellings ?? site.map((l) => l.id);
  const called = new Set(Object.values(sb.fitCalledFor ?? {}).flat());
  const fits = Object.keys(sb.fitCalledFor ?? {});
  const okFit = dwell.filter((id) => { const l = ir.lots.find((q) => q.id === id); return l?.site && fits.includes(l.site.fit) && called.has(id) && String(placed.get(id)).toUpperCase() === 'PLACED'; });
  const share = dwell.length ? okFit.length / dwell.length : 0;
  // ---- disturbance per site lot
  const per = [];
  for (const l of site) {
    const b = l.box, vol = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1) * (b.maxZ - b.minZ + 1);
    const T = entries[l.id] ? await templateCells(L, entries[l.id], l) : null;
    let cut = 0, fill = 0, cutLogs = 0;
    for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) for (let y = b.minY - 16; y <= b.maxY; y++) {
      const s0 = stAt(before, x, y, z), s1 = stAt(after, x, y, z);
      if (s0 === null || s1 === null || s0 === s1) continue;
      const inBox = y >= b.minY;
      if (inBox && SOLID.has(cls(s0))) { cut++; if (cls(s0) === 'LOG') cutLogs++; continue; }
      if (!T || !T.has(`${x},${y},${z}`)) fill++;
    }
    per.push({ lot: l.id, fit: l.site.fit, volume: vol, cut, cutLogs, fill, template: T ? T.size : null, disturbance: Math.round(((cut + fill) / vol) * 1e4) / 1e4 });
  }
  const dmax = per.length ? Math.max(...per.map((p) => p.disturbance)) : 0;
  // ---- the ports, reached on the realised world from the entrance (the player mover; the houses' real blocks, no box obstacles)
  const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
  const { lotPortsWorld } = await imp('lib/region/links.mjs');
  const g = walkGraph(world, ir.anchors?.entrance ? [ir.anchors.entrance] : []);
  const ports = [];
  for (const l of site) {
    const sidecar = entries[l.id] ? (() => { try { return JSON.parse(fs.readFileSync(path.join(L.LIBRARY, entries[l.id], `${entries[l.id]}.blueprint.json`), 'utf8')); } catch { return null; } })() : null;
    const list = sidecar?.ports?.length ? sidecar.ports.map((p) => ({ name: p.name, kind: p.kind, at: [p.x, p.y, p.z], facing: p.facing, width: p.width ?? 1, height: p.height ?? 2 })) : null;
    for (const p of lotPortsWorld(l, list)) ports.push({ lot: l.id, port: p.name, out: p.out, reached: nodeReached(g, p.out) });
  }
  const un = ports.filter((p) => !p.reached);
  const pad = ir.lots.filter((l) => !l.site).reduce((a, l) => a + (l.box.maxX - l.box.minX + 1) * (l.box.maxZ - l.box.minZ + 1), 0);
  const claimArea = (ir.claim.maxX - ir.claim.minX + 1) * (ir.claim.maxZ - ir.claim.minZ + 1);
  const rows = [
    row('sb-fit', `Fit: dwellings with the fit called for (${fits.join('/')}), placed`, `${okFit.length}/${dwell.length} (${(share * 100).toFixed(0)}%)`, '>= 75%', share >= 0.75),
    row('sb-disturbance', 'Fit: disturbance (cut + fill) / lot volume, the worst site lot', dmax.toFixed(3), '<= 0.3', per.length > 0 && dmax <= 0.3),
    row('sb-ports', 'Reachability: site lots\' ports reached from the entrance (realised world)', `${ports.length - un.length}/${ports.length}${un.length ? ` (unreached ${un.map((p) => `${p.lot}.${p.port}`).join(', ')})` : ''}`, '0 unreachable', ports.length > 0 && un.length === 0),
    row('sb-pad', 'Fit: pad area as a share of the claim', `${((pad / claimArea) * 100).toFixed(2)}%`, 'recorded', null, false),
  ];
  return { rows, fit: { dwellings: dwell, ok: okFit, share }, disturbance: per, ports, padShare: pad / claimArea };
}
