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
  const okFit = dwell.filter((id) => { const l = ir.lots.find((q) => q.id === id); return l?.site && fits.includes(l.site.fit) && called.has(id) && placed.get(id) === 'PLACED'; });
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
