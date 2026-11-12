#!/usr/bin/env node
// Slice PL gate (7b placement with a site; docs/CONTRACT.md "Phase 7b" slice PL, "Slice PL as built") against the headless server of the PL
// run worktree (GATE6B_RUN, default `../architect-mc-pl-run`, a detached worktree at this checkout's HEAD; the sim sidecar, no Claude). $0.
//
//   node tools/gate7bpl.mjs <step>
//     ingame   (pl-ingame)  on a flat world (exact rules), one hand-built site per non-pad fit (a log trunk, a cliff face, a rock hill, a
//                           ceiling slab, two pillars), frozen by Survey.volume, and a stub design bound to it: Sites.fitToSite (the frame,
//                           no rotation search, a clean verdict with the port note), Sites.place with the site (TerrainFit KEEP: every cell the
//                           template does not write unchanged, nothing written outside the box: no fill, no approach), the binding in the
//                           record's ext, move refused, Remove exact (E-flat 0 over the site volume); KEEP_LOST (a trunk log cut),
//                           SITE_DRIFTED (a block set in the margin), SITE_MISMATCH (another sha) and SITE_UNSUPPORTED (a floating design)
//                           provoked once each, alone; on_pad byte identity: a pad design placed with an on_pad site writes exactly what its
//                           plain placement writes (fill, clearing and approach included)
//     undo     (pl-undo)    keep cells under BOX (strict): a host trunk written by a cell site (the journal kind a region's ops write), the
//                           trunk house LAYERed over it with the trunk keep-critical; removed region first (hand-down: the trunk stays while the
//                           house stands) and house first: E-flat 0 both ways, the stack at most 8 (2 at a trunk cell); a player-cut keep cell
//                           (a natural trunk mined inside the house's box) is put back by Remove
//     crash    (pl-crash)   kill points K1, K2, K4, K2+save, K4+save during a site placement (KEEP over a natural trunk); after the restart the
//                           volume is either exactly as before (no site) or the site stands, verifies, keeps the trunk and its Remove is exact
//     report                REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-pl/<step>.json in the main checkout (GATE7BPL_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-pl-run');
process.env.GATE6B_OUT = process.env.GATE7BPL_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-pl');
process.env.GATE6B_SIDECAR_PORT ??= '8902';
process.env.GATE6B_DEV_PORT ??= '8903';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const FLAT = 'G6B Flat Base';
const CX = 9800, CZ = 9800;

const steps = {};
async function run(name) {
  for (const k of Object.keys(results)) delete results[k];
  const t0 = Date.now();
  let data, error;
  log(`== ${name}`);
  try {
    data = await steps[name]();
  } catch (e) {
    log(String(e?.stack ?? e));
    error = String(e?.stack ?? e);
    check(false, `${name}: ${String(e?.message ?? e).slice(0, 300)}`);
  }
  if (name !== 'report') L.write(`${name}.json`, { step: name, seconds: (Date.now() - t0) / 1000, head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), load1: os.loadavg()[0], error, results: { ...results }, data });
}
const ensure = async () => { if (!state.dev) await connect(); };
function spendZero() {
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice PL is $0: no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
/** A dev.box.hash cell line's state as "minecraft:x[k=v,...]" (props sorted): its SNBT ({Name|id, Properties|properties}). */
function asState(nbt) {
  const bs = /^Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(\[[^\]]*\])?/.exec(nbt);
  if (bs) return norm(`${bs[1]}${bs[2] ?? ''}`);
  const n = /(?:Name|id)\s*:\s*["']?([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(nbt)?.[1];
  if (!n) return nbt;
  const pm = /properties\s*:\s*\{([^}]*)\}/i.exec(nbt)?.[1];
  const props = pm ? [...pm.matchAll(/["']?([a-z0-9_]+)["']?\s*:\s*["']?([a-z0-9_]+)["']?/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  return props.length ? `${n}[${props.join(',')}]` : n;
}
const idOf = (s) => String(s).replace(/\[.*$/, '').replace(/^minecraft:/, '');
const k3 = (x, y, z) => `${x},${y},${z}`;
/** Every cell of a box [x0,y0,z0,x1,y1,z1]: Map "x,y,z" -> state. */
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
const hashOf = async (b) => (await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] }, 300_000)).sha256;
/** The cells that differ between two maps (skip: a set of keys), the first few. */
function diff(a, b, skip = null) {
  const out = [];
  let n = 0;
  for (const [k, v] of a) {
    if (skip?.has(k)) continue;
    if (b.get(k) !== v) { n++; if (out.length < 6) out.push(`${k} ${v} -> ${b.get(k)}`); }
  }
  return { n, first: out };
}

async function groundY() {
  const h = await call('dev.box.hash', { min: [CX, -64, CZ], max: [CX, 250, CZ], cells: true }, 120_000);
  let g = -64;
  for (const l of h.cells ?? []) { const [k, ...rest] = l.split(' '); const y = Number(k.split(',')[1]); if (idOf(asState(rest.join(' '))) !== 'air' && y > g) g = y; }
  return g;
}

async function freshFlat(name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(CX, 0, CZ - 20);
}

// ------------------------------------------------------------------ sites and designs

const grow = (b, n, minY) => [b[0] - n, Math.max(minY, b[1] - n), b[2] - n, b[3] + n, b[4] + n, b[5] + n];
const boxWire = (b) => ({ minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] });

async function survey(vol) {
  const v = await call('dev.survey.volume', { box: vol, load: 'loaded' }, 600_000);
  if (v.refused || !v.sha) throw new Error(`survey refused: ${json(v)}`);
  return v;
}

function siteWire({ sha, vol, fit, origin, keep = [], ports = [] }) {
  return { volumeSha: sha, volumeBlobId: `local:${sha}`, volume: boxWire(vol), fit, frame: { origin, rotation: 'none' }, keepCritical: keep, ports };
}

async function writeDesign(bp) {
  const { writeBlueprint } = await imp('lib/write.mjs');
  const dir = path.join(L.LIBRARY, bp.id);
  fs.rmSync(dir, { recursive: true, force: true });
  writeBlueprint(bp, dir);
}

/** The world cells a design writes at `origin` (rotation none): Map key -> block. */
function written(bp, origin) {
  const m = new Map();
  for (const [k, c] of bp.cells) {
    const [x, y, z] = k.split(',').map(Number);
    m.set(k3(origin[0] + x, origin[1] + y, origin[2] + z), c.state?.name ?? c.name ?? String(c));
  }
  return m;
}

/**
 * The five fit sites, each built by commands at (x0, gy+1, z0) and its stub design (front south, no approach). Every design leaves the
 * site's cells it stands against unwritten (keep cells). Returns {fit, id, origin, box, keep, ports, build(), design(K, sha)}.
 */
function fitSites(gy) {
  const y0 = gy + 1;
  const at = (i) => [CX + i * 40, y0, CZ];
  const S = [];
  { // wrap_trunk: a log trunk through a 7x6x7 box, a dirt heap in a corner (CLEAR would clear it), a ring deck at row 2
    const o = at(0); const box = [o[0], o[1], o[2], o[0] + 6, o[1] + 5, o[2] + 6];
    const keep = []; for (let y = o[1]; y <= o[1] + 5; y++) keep.push([o[0] + 3, y, o[2] + 3]);
    S.push({ fit: 'wrap_trunk', id: 'pl_trunk_ring', origin: o, box, keep, ports: [{ name: 'deck_s', kind: 'architect:walk', at: [3, 3, 6], facing: 'south', width: 1, height: 2 }],
      cmds: [`/fill ${o[0] + 3} ${o[1]} ${o[2] + 3} ${o[0] + 3} ${o[1] + 9} ${o[2] + 3} minecraft:oak_log`, `/fill ${o[0]} ${o[1]} ${o[2]} ${o[0] + 1} ${o[1] + 1} ${o[2] + 1} minecraft:dirt`],
      design: (K, ext) => { const bp = new K.Blueprint({ id: 'pl_trunk_ring', type: 'house', size: [7, 6, 7], approach: false, ext });
        for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) if (!(x === 3 && z === 3)) bp.set(x, 2, z, 'minecraft:spruce_planks');
        for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) if ((x === 0 || z === 0 || x === 6 || z === 6) && !(x === 3 && z === 6)) bp.set(x, 3, z, 'minecraft:spruce_slab');
        return bp; } });
  }
  { // attach_to_cliff: a stone face west of a 5x6x7 box (and a ledge of it inside the box at rows 0-1), a shelf on brackets at row 3
    const o = at(1); const box = [o[0], o[1], o[2], o[0] + 4, o[1] + 5, o[2] + 6];
    S.push({ fit: 'attach_to_cliff', id: 'pl_cliff_shelf', origin: o, box, keep: [], ports: [{ name: 'door_s', kind: 'door', at: [2, 4, 6], facing: 'south', width: 1, height: 2 }],
      cmds: [`/fill ${o[0] - 3} ${o[1]} ${o[2]} ${o[0] - 1} ${o[1] + 11} ${o[2] + 6} minecraft:stone`, `/fill ${o[0]} ${o[1]} ${o[2]} ${o[0]} ${o[1] + 1} ${o[2] + 6} minecraft:stone`],
      design: (K, ext) => { const bp = new K.Blueprint({ id: 'pl_cliff_shelf', type: 'house', size: [5, 6, 7], approach: false, ext });
        for (let x = 0; x < 5; x++) for (let z = 0; z < 7; z++) bp.set(x, 3, z, 'minecraft:oak_planks');
        for (let z = 0; z < 7; z += 3) bp.set(0, 2, z, 'minecraft:oak_planks');
        for (let z = 0; z < 7; z++) bp.set(4, 4, z, 'minecraft:oak_planks');
        return bp; } });
  }
  { // carve_into: a stone hill; the design carves a room (air), lays a floor and hangs a light; the rock it doesn't write stays
    const o = at(2); const box = [o[0], o[1], o[2], o[0] + 6, o[1] + 5, o[2] + 6];
    S.push({ fit: 'carve_into', id: 'pl_carved_room', origin: o, box, keep: [], ports: [{ name: 'door_s', kind: 'door', at: [3, 1, 6], facing: 'south', width: 1, height: 2 }],
      cmds: [`/fill ${o[0] - 2} ${o[1]} ${o[2] - 2} ${o[0] + 8} ${o[1] + 7} ${o[2] + 6} minecraft:stone`],
      design: (K, ext) => { const bp = new K.Blueprint({ id: 'pl_carved_room', type: 'house', size: [7, 6, 7], approach: false, ext });
        for (let x = 1; x <= 5; x++) for (let z = 1; z <= 5; z++) { bp.set(x, 0, z, 'minecraft:oak_planks'); for (let y = 1; y <= 4; y++) bp.air(x, y, z); }
        bp.air(3, 1, 6); bp.air(3, 2, 6);
        bp.set(3, 4, 3, 'minecraft:glowstone');
        return bp; } });
  }
  { // suspend: a stone ceiling slab on pillars outside the box (its lowest row is the box's top row); a hut hung from it on a log post (the hang point keep-critical)
    const o0 = at(3); const o = [o0[0], o0[1] + 3, o0[2]]; const box = [o[0], o[1], o[2], o[0] + 4, o[1] + 7, o[2] + 4];
    const top = o[1] + 7; // the ceiling's lowest row is the box's top row (unwritten: kept), the hang point in it
    S.push({ fit: 'suspend', id: 'pl_hanging_hut', origin: o, box, keep: [[o[0] + 2, top, o[2] + 2]], ports: [{ name: 'hatch', kind: 'architect:walk', at: [2, 0, 2], facing: 'down', width: 1, height: 1 }],
      cmds: [`/fill ${o[0] - 3} ${top} ${o[2] - 3} ${o[0] + 7} ${top + 1} ${o[2] + 7} minecraft:stone`,
        ...[[-3, -3], [7, -3], [-3, 7], [7, 7]].map(([dx, dz]) => `/fill ${o[0] + dx} ${o0[1]} ${o[2] + dz} ${o[0] + dx} ${top - 1} ${o[2] + dz} minecraft:stone`)],
      design: (K, ext) => { const bp = new K.Blueprint({ id: 'pl_hanging_hut', type: 'house', size: [5, 8, 5], approach: false, ext });
        for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) { if (!(x === 2 && z === 2)) bp.set(x, 0, z, 'minecraft:oak_planks'); bp.set(x, 4, z, 'minecraft:oak_planks'); }
        for (let y = 1; y <= 3; y++) for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) bp.set(x, y, z, 'minecraft:oak_log');
        for (let y = 5; y <= 6; y++) bp.set(2, y, 2, 'minecraft:oak_log');
        return bp; } });
  }
  { // span: two stone pillars, a deck between them bearing on both
    const o0 = at(4); const o = [o0[0], o0[1] + 4, o0[2]]; const box = [o[0], o[1], o[2], o[0] + 8, o[1] + 2, o[2] + 4];
    S.push({ fit: 'span', id: 'pl_span_deck', origin: o, box, keep: [],
      ports: [{ name: 'walk_w', kind: 'architect:walk', at: [0, 1, 2], facing: 'west', width: 1, height: 2 }, { name: 'walk_e', kind: 'architect:walk', at: [8, 1, 2], facing: 'east', width: 1, height: 2 }],
      cmds: [`/fill ${o[0] - 3} ${o0[1]} ${o[2]} ${o[0] - 1} ${o[1]} ${o[2] + 4} minecraft:stone`, `/fill ${o[0] + 9} ${o0[1]} ${o[2]} ${o[0] + 11} ${o[1]} ${o[2] + 4} minecraft:stone`,
        `/setblock ${o[0]} ${o[1]} ${o[2]} minecraft:stone`, `/setblock ${o[0]} ${o[1]} ${o[2] + 4} minecraft:stone`], // the west face's lip inside the box (unwritten: kept)
      design: (K, ext) => { const bp = new K.Blueprint({ id: 'pl_span_deck', type: 'bridge', size: [9, 3, 5], approach: false, ext });
        for (let x = 0; x < 9; x++) for (let z = 1; z <= 3; z++) bp.set(x, 0, z, 'minecraft:oak_planks');
        for (let x = 0; x < 9; x++) { bp.set(x, 1, 1, 'minecraft:oak_slab'); bp.set(x, 1, 3, 'minecraft:oak_slab'); }
        return bp; } });
  }
  return S;
}

/** Builds a site, freezes its volume (the box grown by 8; down to the ground row), writes its design bound to it; reloads the library. */
async function prepare(s, gy, K) {
  for (const c of s.cmds) await cmd(c);
  await L.settle(1000);
  s.vol = grow(s.box, 8, gy - 2);
  const v = await survey(s.vol);
  check(v.missingColumns === 0, `${s.fit}: the site volume frozen (${v.sha.slice(0, 12)}, ${v.blobId.startsWith('local:') ? 'local' : 'helper blob'}, no missing columns)`, { counts: v.counts });
  s.sha = v.sha;
  s.wire = siteWire({ sha: v.sha, vol: s.vol, fit: s.fit, origin: s.origin, keep: s.keep, ports: s.ports });
  const binding = { volumeSha: v.sha, fit: s.fit, volume: boxWire(s.vol) };
  s.bp = s.design(K, { 'architect_mc:site': binding });
  await writeDesign(s.bp);
  return s;
}

const reasons = (r) => (r.refusals ?? []).map((x) => x.reason);

// ------------------------------------------------------------------ ingame

steps.ingame = async () => {
  await ensure();
  spendZero();
  const out = {};
  await freshFlat('G6B PL Ingame');
  const gy = await groundY();
  out.groundY = gy;
  const K = await imp('lib/kit.mjs');
  const S = fitSites(gy);
  for (const s of S) { await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12); await prepare(s, gy, K); }
  await call('dev.pl.reload', {}, 60_000);
  out.fits = {};
  for (const s of S) {
    await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12);
    const r = { fit: s.fit, design: s.id, sha: s.sha };
    // fitToSite: the frame, no rotation search, the site checks pass, the port note
    const f = await call('dev.pl.fit', { blueprint: s.id, site: s.wire }, 120_000);
    r.fit = { clean: f.clean, origin: f.origin, rotation: f.rotation, refusals: f.refusals, notes: f.notes };
    check(f.clean && json(f.origin) === json(s.origin) && f.rotation === 'none' && json(f.box) === json(s.box), `${s.fit}: fitToSite answers the site's frame ${json(s.origin)} none, the template box ${json(s.box)}, a clean verdict`, f);
    check(f.notes.some((n) => n.includes(`site fit ${s.fit}: approach by port`)) && json(f.restoreBox) === json([s.box[0], s.box[1] - 1, s.box[2], s.box[3], s.box[4], s.box[5]]),
      `${s.fit}: the verdict notes the port approach; the restore box is the template box and the row under it (no fill, no approach strip)`, { notes: f.notes, restoreBox: f.restoreBox });
    // a request off the frame is refused (no rotation search, no other origin)
    const off = await call('dev.pl.place', { blueprint: s.id, site: s.wire, origin: [s.origin[0] + 1, s.origin[1], s.origin[2]], check: true }, 120_000);
    check(!off.clean && reasons(off).includes('OTHER'), `${s.fit}: a placement off the site's frame is refused`, off.refusals);
    // place with the site: KEEP (every unwritten cell as it was, nothing outside the box)
    const before = await cellsOf(s.vol);
    const p = await call('dev.pl.place', { blueprint: s.id, site: s.wire }, 300_000);
    check(p.placed, `${s.fit}: Sites.place with the site placed ${p.site}`, p);
    if (!p.placed) { out.fits[s.fit] = r; continue; }
    const after = await cellsOf(s.vol);
    const w = written(s.bp, s.origin);
    let wrongWrite = 0;
    for (const [k, b] of w) if (idOf(after.get(k)) !== idOf(b)) wrongWrite++;
    const keepDiff = diff(before, after, new Set(w.keys()));
    const absentInBox = [...before.keys()].filter((k) => { const [x, y, z] = k.split(',').map(Number); return !w.has(k) && x >= s.box[0] && x <= s.box[3] && y >= s.box[1] && y <= s.box[4] && z >= s.box[2] && z <= s.box[5]; });
    const solidKept = absentInBox.filter((k) => idOf(before.get(k)) !== 'air').length;
    r.place = { site: p.site, written: w.size, wrongWrite, changedUnwritten: keepDiff.n, absentInBox: absentInBox.length, solidKeepCells: solidKept, notes: p.notes };
    check(wrongWrite === 0 && keepDiff.n === 0 && solidKept > 0, `${s.fit}: KEEP: the ${w.size} written cells hold the template, the ${absentInBox.length} unwritten cells of the box (${solidKept} of them the site's terrain) and the rest of the volume are unchanged`, { first: keepDiff.first });
    const rec = await call('dev.pl.record', { site: p.site });
    check(rec.bound && rec.ext?.['architect_mc:site']?.volumeSha === s.sha && rec.ext['architect_mc:site'].fit === s.fit, `${s.fit}: the record carries its binding (ext architect_mc:site)`, rec.ext);
    const mv = await call('dev.pl.move', { site: p.site, by: [0, 0, 3] });
    check(!mv.moved && /site-bound/.test(mv.refused ?? ''), `${s.fit}: a move of the site-bound placement is refused`, mv);
    const v = await call('dev.site.verify', { site: p.site }, 120_000);
    check(v.mismatches === 0, `${s.fit}: dev.site.verify: ${v.owned} owned cells, 0 mismatches`, v);
    const rm = await call('dev.pl.remove', { site: p.site }, 600_000);
    await L.settle(1500);
    const back = await cellsOf(s.vol);
    const e = diff(before, back);
    r.remove = { removed: rm.removed, restored: rm.restored, eflat: e.n };
    check(rm.removed && e.n === 0, `${s.fit}: Remove is exact: E-flat 0 over the ${before.size}-cell volume`, e.first);
    out.fits[s.fit] = r;
  }
  // the four Reasons, each provoked alone (the trunk site)
  const t = S[0];
  await L.tp(t.origin[0] + 3, gy + 20, t.origin[2] - 12);
  const cut = t.keep[2];
  await cmd(`/setblock ${cut[0]} ${cut[1]} ${cut[2]} minecraft:air`);
  const kl = await call('dev.pl.fit', { blueprint: t.id, site: t.wire }, 120_000);
  check(json(reasons(kl)) === json(['KEEP_LOST']) && kl.refusals[0].message.startsWith(`${cut.join(',')}:`), `KEEP_LOST alone when a trunk log (keep-critical) is cut; the message starts with the cell`, kl.refusals);
  await cmd(`/setblock ${cut[0]} ${cut[1]} ${cut[2]} minecraft:oak_log`);
  const mg = [t.vol[0] + 1, t.box[1] + 2, t.vol[2] + 1];
  const mgWas = (await cellsOf([...mg, ...mg])).get(k3(...mg));
  await cmd(`/setblock ${mg[0]} ${mg[1]} ${mg[2]} minecraft:cobblestone`);
  const dr = await call('dev.pl.fit', { blueprint: t.id, site: t.wire }, 120_000);
  check(json(reasons(dr)) === json(['SITE_DRIFTED']), 'SITE_DRIFTED alone when a block is set in the site margin', dr.refusals);
  await cmd(`/setblock ${mg[0]} ${mg[1]} ${mg[2]} ${mgWas}`);
  const ok = await call('dev.pl.fit', { blueprint: t.id, site: t.wire }, 120_000);
  check(ok.clean, 'the site restored: the fit is clean again', ok.refusals);
  const vol2 = grow(t.vol, 1, gy - 2);
  const v2 = await survey(vol2);
  const other = { ...t.wire, volumeSha: v2.sha, volumeBlobId: `local:${v2.sha}` };
  const mm = await call('dev.pl.fit', { blueprint: t.id, site: other }, 120_000);
  check(json(reasons(mm)) === json(['SITE_MISMATCH']) && mm.refusals[0].message.startsWith(`${t.sha}:`), 'SITE_MISMATCH alone for a design bound to another volume sha; the message starts with the bound sha', mm.refusals);
  // SITE_UNSUPPORTED: a block floating in a site of air
  const fo = [CX + 240, gy + 10, CZ];
  const fbox = [fo[0], fo[1], fo[2], fo[0] + 2, fo[1] + 2, fo[2] + 2];
  await L.tp(fo[0], gy + 20, fo[2] - 12);
  const fvol = grow(fbox, 8, gy - 2);
  const fv = await survey(fvol);
  const fbp = new K.Blueprint({ id: 'pl_floater', type: 'house', size: [3, 3, 3], approach: false, ext: { 'architect_mc:site': { volumeSha: fv.sha, fit: 'attach_to_cliff', volume: boxWire(fvol) } } });
  fbp.set(1, 1, 1, 'minecraft:oak_planks');
  await writeDesign(fbp);
  await call('dev.pl.reload', {}, 60_000);
  const fwire = siteWire({ sha: fv.sha, vol: fvol, fit: 'attach_to_cliff', origin: fo });
  const un = await call('dev.pl.fit', { blueprint: 'pl_floater', site: fwire }, 120_000);
  check(json(reasons(un)) === json(['SITE_UNSUPPORTED']), 'SITE_UNSUPPORTED alone for a design connected to nothing of its site', un.refusals);
  const fh = await hashOf(fvol);
  const unp = await call('dev.pl.place', { blueprint: 'pl_floater', site: fwire }, 120_000);
  check(!unp.placed && reasons(unp).includes('SITE_UNSUPPORTED') && (await hashOf(fvol)) === fh, 'and Sites.place refuses it the same (nothing written)', unp.refusals);
  out.reasons = { keepLost: kl.refusals, drifted: dr.refusals, mismatch: mm.refusals, unsupported: un.refusals };
  // on_pad byte identity: a pad design placed plainly and with an on_pad site writes the same bytes (fill, clearing, approach)
  const po = [CX + 280, gy + 1, CZ];
  const pbox = [po[0], po[1], po[2], po[0] + 6, po[1] + 4, po[2] + 6];
  await L.tp(po[0] + 3, gy + 20, po[2] - 12);
  await cmd(`/fill ${po[0] + 4} ${po[1]} ${po[2] + 1} ${po[0] + 6} ${po[1] + 1} ${po[2] + 3} minecraft:dirt`); // a mound: cleared
  await cmd(`/fill ${po[0]} ${gy - 1} ${po[2]} ${po[0] + 2} ${gy} ${po[2] + 2} minecraft:air`); // a dip: filled
  const area = [pbox[0] - 8, gy - 4, pbox[2] - 8, pbox[3] + 8, pbox[4] + 8, pbox[5] + 16];
  const h0 = await hashOf(area);
  const pad = new K.Blueprint({ id: 'pl_pad_cottage', type: 'house', size: [7, 5, 7] });
  pad.fill([0, 0, 0, 6, 0, 6], 'minecraft:cobblestone');
  for (let y = 1; y <= 3; y++) for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) { const edge = x === 0 || z === 0 || x === 6 || z === 6; if (edge) pad.set(x, y, z, 'minecraft:oak_planks'); }
  pad.fill([0, 4, 0, 6, 4, 6], 'minecraft:oak_planks');
  pad.air(3, 1, 6); pad.air(3, 2, 6);
  pad.anchor('entrance', 3.5, 1, 6.5, 0, 0);
  await writeDesign(pad);
  await call('dev.pl.reload', {}, 60_000);
  const plain = await call('dev.pl.place', { blueprint: 'pl_pad_cottage', origin: po }, 300_000);
  check(plain.placed, `on_pad: the plain placement placed ${plain.site} (${(plain.notes ?? []).join('; ')})`, plain);
  const h1 = await hashOf(area);
  const c1 = await cellsOf(area);
  await call('dev.pl.remove', { site: plain.site }, 600_000);
  await L.settle(1500);
  check((await hashOf(area)) === h0, 'on_pad: the plain placement removed exactly');
  const pvol = grow(pbox, 8, gy - 4);
  const pv = await survey(pvol);
  const pw = siteWire({ sha: pv.sha, vol: pvol, fit: 'on_pad', origin: po });
  const viaSite = await call('dev.pl.place', { blueprint: 'pl_pad_cottage', site: pw }, 300_000);
  check(viaSite.placed, `on_pad: the placement with an on_pad site placed ${viaSite.site}`, viaSite);
  const h2 = await hashOf(area);
  const c2 = await cellsOf(area);
  const pd = diff(c1, c2);
  const notesPlain = (plain.notes ?? []).filter((n) => /foundation|cleared|approach/.test(n));
  check(h1 === h2 && pd.n === 0 && notesPlain.length >= 2, `on_pad: byte-identical to the plain placement over ${c1.size} cells (sha ${h1.slice(0, 12)}; plain notes: ${notesPlain.join('; ')})`, pd.first);
  out.onPad = { h0, h1, h2, notesPlain: plain.notes, notesSite: viaSite.notes };
  await call('dev.pl.remove', { site: viaSite.site }, 600_000);
  await L.settle(1500);
  check((await hashOf(area)) === h0, 'on_pad: its Remove is exact too');
  await L.leaveWorld();
  return out;
};

// ------------------------------------------------------------------ undo (strict): keep cells under BOX, both removal orders

steps.undo = async () => {
  await ensure();
  spendZero();
  const out = {};
  const K = await imp('lib/kit.mjs');
  for (const order of ['region-first', 'house-first']) {
    await freshFlat(`G6B PL Undo ${order}`);
    const gy = await groundY();
    const s = fitSites(gy)[0];
    await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12);
    await cmd(s.cmds[1]); // the dirt heap (the test's ground, before the baseline); the trunk comes from the cell site
    s.cmds = [];
    await L.settle(1000);
    const area = grow(s.box, 10, gy - 3);
    const h0 = await hashOf(area);
    const c0 = await cellsOf(area);
    // the "region": a cell site writing the host trunk (the CELL entry kind a region's ops write)
    const trunk = []; for (let y = s.origin[1]; y <= s.origin[1] + 9; y++) trunk.push([s.origin[0] + 3, y, s.origin[2] + 3, 'minecraft:oak_log[axis=y]']);
    const cs = await call('dev.cells.place', { kind: 'test:pl_host', cells: trunk, naturalOnly: false }, 600_000);
    check(cs.placed, `${order}: the host trunk written by cell site ${cs.siteId}`, cs);
    await prepare(s, gy, K);
    await call('dev.pl.reload', {}, 60_000);
    const hHost = await hashOf(area);
    const p = await call('dev.pl.place', { blueprint: s.id, site: s.wire, overlap: 'layer' }, 300_000);
    check(p.placed, `${order}: the trunk house LAYERed over the cell site (${p.site}; ${(p.notes ?? []).filter((n) => /on top of/.test(n)).join('; ')})`, p);
    const stTrunk = await call('dev.journal.at', { x: s.keep[2][0], y: s.keep[2][1], z: s.keep[2][2] });
    const stDeck = await call('dev.journal.at', { x: s.origin[0], y: s.origin[1] + 2, z: s.origin[2] });
    const depth = (st) => (st.stack ?? []).length;
    const sites = (st) => (st.stack ?? []).map((e) => e.site);
    check(depth(stTrunk) === 2 && sites(stTrunk)[0] === cs.siteId && sites(stTrunk)[1] === p.site && depth(stDeck) <= 8, `${order}: a trunk cell's stack is the cell site under the house (2 layers; at most 8), a deck cell's ${depth(stDeck)}`, { trunk: stTrunk, deck: depth(stDeck) });
    const trunkLogs = async () => { const c = await cellsOf([s.origin[0] + 3, s.origin[1], s.origin[2] + 3, s.origin[0] + 3, s.origin[1] + 9, s.origin[2] + 3]); return [...c.values()].filter((v) => idOf(v) === 'oak_log').length; };
    let rFirst, rSecond;
    if (order === 'region-first') {
      rFirst = await call('dev.pl.remove', { site: cs.siteId, covered: 'keep' }, 600_000);
      await L.settle(1500);
      // hand-down: the 6 trunk cells inside the house's box stay (the house owns them now, with the pre-region state as its before); the
      // 4 above the box are the cell site's alone and go
      const logs = await trunkLogs();
      check(rFirst.removed && logs === 6, `${order}: the cell site removed under the standing house (handed down ${json(rFirst.handedDown)}): the trunk inside the house's box stands (${logs} logs: the 6 keep cells), the 4 above it are gone`, { rFirst, logs });
      rSecond = await call('dev.pl.remove', { site: p.site }, 600_000);
    } else {
      rFirst = await call('dev.pl.remove', { site: p.site }, 600_000);
      await L.settle(1500);
      check(rFirst.removed && (await trunkLogs()) === 10 && (await hashOf(area)) === hHost, `${order}: the house removed first: back to the cell site's world exactly (the trunk's 10 logs)`, rFirst);
      rSecond = await call('dev.pl.remove', { site: cs.siteId }, 600_000);
    }
    await L.settle(1500);
    const c1 = await cellsOf(area);
    const e = diff(c0, c1);
    check(rSecond.removed && e.n === 0, `${order}: after both removals E-flat 0 over the ${c0.size}-cell area (both removed: ${rFirst.removed}, ${rSecond.removed})`, e.first);
    out[order] = { cellSite: cs.siteId, house: p.site, trunkStack: sites(stTrunk), first: rFirst, second: rSecond, eflat: e.n };
    await L.leaveWorld();
  }
  // the player cuts a keep cell (a natural trunk log inside the house's box): Remove puts it back
  {
    await freshFlat('G6B PL Undo cut');
    const gy = await groundY();
    const s = fitSites(gy)[0];
    await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12);
    const area = grow(s.box, 10, gy - 3);
    const c0 = await cellsOf(area);
    await prepare(s, gy, K);
    await call('dev.pl.reload', {}, 60_000);
    const cHere = await cellsOf(area);
    const p = await call('dev.pl.place', { blueprint: s.id, site: s.wire }, 300_000);
    check(p.placed, `cut: the trunk house placed over a natural trunk (${p.site})`, p);
    const cut = s.keep[4];
    let how = 'dev.site.mine';
    const mined = await call('dev.site.mine', { pos: cut, pickup: false }).catch((err) => ({ error: String(err?.message ?? err) }));
    if (mined.error) { how = `/setblock (dev.site.mine: ${mined.error.slice(0, 80)})`; await cmd(`/setblock ${cut[0]} ${cut[1]} ${cut[2]} minecraft:air`); }
    const gone = await cellsOf([cut[0], cut[1], cut[2], cut[0], cut[1], cut[2]]);
    check(idOf(gone.get(k3(...cut))) === 'air', `cut: the player cut the keep cell ${cut.join(',')} (${how})`);
    const rm = await call('dev.pl.remove', { site: p.site }, 600_000);
    await L.settle(1500);
    const c1 = await cellsOf(area);
    const e = diff(cHere, c1);
    check(rm.removed && e.n === 0 && idOf(c1.get(k3(...cut))) === 'oak_log', `cut: Remove put the trunk log back: E-flat 0 against the site before the house over ${cHere.size} cells`, { rm, first: e.first });
    out.cut = { site: p.site, how, remove: rm, eflat: e.n, natural: diff(c0, c1).n };
    await L.leaveWorld();
  }
  return out;
};

// ------------------------------------------------------------------ crash (strict): kill points during a site placement

steps.crash = async () => {
  await ensure();
  spendZero();
  const out = {};
  const K = await imp('lib/kit.mjs');
  for (const point of ['K1', 'K2', 'K4', 'K2+save', 'K4+save']) {
    const world = `G6B PL Crash ${point.replace('+', '_')}`;
    await freshFlat(world);
    const gy = await groundY();
    const s = fitSites(gy)[0];
    await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12);
    await prepare(s, gy, K);
    await call('dev.pl.reload', {}, 60_000);
    const area = grow(s.box, 10, gy - 3);
    const c0 = await cellsOf(area);
    await cmd('/save-all flush');
    await L.settle(1000);
    await call('dev.journal.killAt', { point }, 10_000);
    call('dev.pl.place', { blueprint: s.id, site: s.wire }, 120_000).catch(() => null);
    let down = false;
    for (let i = 0; i < 90 && !down; i++) {
      await sleep(2000);
      const st = await call('dev.state', {}, 10_000).catch(() => null);
      down = !!st && st.inWorld === false;
    }
    check(down, `${point}: the kill point halted the server`);
    if (!down) { await call('dev.journal.killAt', { point: null }, 10_000).catch(() => null); await L.leaveWorld(); continue; }
    await L.openWorld(world);
    await L.tp(s.origin[0] + 3, gy + 20, s.origin[2] - 12);
    await L.settle(3000);
    const st = await call('dev.sites.state', {}, 60_000);
    const standing = (st.sites ?? []).filter((x) => x.blueprint === s.id);
    const c1 = await cellsOf(area);
    const r = { point, standing: standing.map((x) => [x.id, x.placing ? 'placing' : 'placed']) };
    if (standing.length === 0) {
      const e = diff(c0, c1);
      r.outcome = 'rolled back'; r.eflat = e.n;
      check(e.n === 0, `${point}: after the restart no site stands and the area is exactly as before (E-flat 0 over ${c0.size} cells)`, e.first);
    } else {
      const id = standing[0].id;
      const w = written(s.bp, s.origin);
      const keepDiff = diff(c0, c1, new Set(w.keys()));
      const v = await call('dev.site.verify', { site: id }, 120_000);
      const rec = await call('dev.pl.record', { site: id });
      // K4 without a save: the journal wins (CONTRACT 4e "K4, P7 to P8"): the record is placed though the halted world never saved the
      // blocks written after the last autosave, so its cells may read as before (verify is recorded, not judged: main's rule, gate4e's
      // K4 judges the record and the final exact removal); with +save the blocks are on disk and must verify
      const saved = point.endsWith('+save');
      check(standing.length === 1 && (!saved || v.mismatches === 0) && keepDiff.n === 0 && rec.bound, `${point}: after the restart the site ${id} stands (the journal wins), `
        + `carries its binding, every unwritten cell (the trunk) is unchanged; verify ${v.mismatches} mismatch(es) of ${v.owned}${saved ? '' : ' (recorded: the blocks were not saved before the halt)'}`, { v: { owned: v.owned, mismatches: v.mismatches, first: (v.first ?? []).slice(0, 2) }, first: keepDiff.first });
      r.verify = { owned: v.owned, mismatches: v.mismatches };
      const rm = await call('dev.pl.remove', { site: id }, 600_000);
      await L.settle(1500);
      const e = diff(c0, await cellsOf(area));
      r.outcome = 'placed'; r.eflat = e.n;
      check(rm.removed && e.n === 0, `${point}: its Remove is exact (E-flat 0)`, e.first);
    }
    out[point] = r;
    await L.leaveWorld();
  }
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^(ingame|undo|crash)\.json$/.test(f));
  const lines = ['# Gate slice PL', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
  for (const f of files.sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    lines.push(`## ${j.step} (${Math.round(j.seconds)} s, head ${String(j.head).slice(0, 10)})`, '');
    for (const [m, r] of Object.entries(j.results ?? {})) lines.push(`- ${r?.ok ? 'ok  ' : 'FAIL'} ${m}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'REPORT.md'), `${lines.join('\n')}\n`);
  return { files };
};

const name = process.argv[2];
if (!steps[name]) {
  console.error(`usage: node tools/gate7bpl.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
