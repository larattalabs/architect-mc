#!/usr/bin/env node
// Slice SO gate (7b support order; docs/CONTRACT.md "Phase 7b" slice SO, §5 "Survival, three fits", "Slice SO as built") against the
// headless server of the SO run worktree (GATE6B_RUN, default `../architect-mc-so-run`, a detached worktree at this checkout's HEAD; the
// sim sidecar, no Claude). $0.
//
//   node tools/gate7bso.mjs <step>
//     survival  (so-survival) the three survival gate houses: slice SV's `fit_attach_to_cliff`, `fit_span` and `fit_suspend` on their fixtures'
//                             land (built in the world from the frozen volumes, as pl-ingame does), each placed by Sites.place with its sidecar
//                             site in construction mode in a survival world, fed from a hopper chain (a chest on a hopper on its crate):
//                             a) a partial build deconstructed with its scaffolding standing: the refund is what went in (no scaffolding item),
//                                the land exact (E-flat 0);
//                             b) the full build: the crate at the first port's landing (outside the box, standable), the scaffolding a CELL
//                                entry `architect:scaffold` in the site's undo group; the built set recorded at every 100 cells (dev.so.watch)
//                                and each record connected to the site by an independent scan (anchors from the fixture volume's classes and
//                                the keep-critical cells, never Architect's predicate); a save, quit and reload half way (the run's gate
//                                rebuilt from its record); built: the scaffolding gone and its entry released; items in = items out (fed =
//                                paid standing + crate leftovers + what the chest and hopper still hold); deconstructed: every item back and
//                                the land exact (E-flat 0);
//                             c) identical to its instant placement: the built house's cells equal the instant placement's (the feed cells
//                                left out); its Remove exact.
//     report                  REPORT.md over the step JSONs
//
// Evidence: artifacts/gate7b-so/<step>.json in the main checkout (GATE7BSO_OUT overrides), all.log, REPORT.md, spend.json ($0.00).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GATE6B_RUN ??= path.resolve(here, '..', 'architect-mc-so-run');
process.env.GATE6B_OUT = process.env.GATE7BSO_OUT ?? process.env.GATE6B_OUT ?? path.join(path.resolve(here, '..', 'architect-mc'), 'artifacts', 'gate7b-so');
process.env.GATE6B_SIDECAR_PORT ??= '8906';
process.env.GATE6B_DEV_PORT ??= '8907';
fs.mkdirSync(process.env.GATE6B_OUT, { recursive: true });
const L = await import('./lib/run6b.mjs');
const { OUT, check, connect, log, results, root, state, call, cmd, sleep } = L;

L.refuseKeys();
const KIT = path.join(root, 'kit');
const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
const json = (o) => String(JSON.stringify(o ?? null)).replaceAll(' ', '');

const FLAT = 'G6B Flat Base';
/** The three survival gate houses (§5) and their fixtures. */
const HOUSES = [['fit_attach_to_cliff', 'cliff_face'], ['fit_span', 'rift_site'], ['fit_suspend', 'overhang']];
const EVERY = 100;
/** How far under the volume the scaffolding may reach (Builder.SCAFFOLD_MAX_HEIGHT plus the row under the box). */
const BELOW = 26;

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
  fs.writeFileSync(path.join(OUT, 'spend.json'), `${JSON.stringify({ capUsd: 0, totalUsd: 0, runs: [], note: 'slice SO is $0: no Claude call' }, null, 2)}\n`);
}

// ------------------------------------------------------------------ cells (as gate7bpl)

function norm(s) {
  const m = /^([^[]+)(?:\[([^\]]*)\])?$/.exec(String(s));
  if (!m) return String(s);
  const id = m[1].includes(':') ? m[1] : `minecraft:${m[1]}`;
  const props = m[2] ? m[2].split(',').filter(Boolean).sort() : [];
  return props.length ? `${id}[${props.join(',')}]` : id;
}
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
/** Every cell of a box [x0,y0,z0,x1,y1,z1]: Map "x,y,z" -> state (block-entity data left out). */
async function cellsOf(b) {
  const h = await call('dev.box.hash', { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]], cells: true }, 300_000);
  return new Map((h.cells ?? []).map((l) => { const sp = l.indexOf(' '); return [l.slice(0, sp), asState(l.slice(sp + 1).split(' be=')[0])]; }));
}
function diff(a, b, skip = null) {
  const out = [];
  let n = 0;
  for (const [k, v] of a) {
    if (skip?.has(k)) continue;
    if (b.get(k) !== v) { n++; if (out.length < 6) out.push(`${k} ${v} -> ${b.get(k)}`); }
  }
  return { n, first: out };
}
const count = (cells, id) => [...cells.values()].filter((v) => idOf(v) === id).length;

/** A template's cells ("x,y,z" template coordinates -> block id), air included (every cell the template writes). */
async function templateCells(nbtPath) {
  const { parse, plain } = await imp('lib/nbt.mjs');
  const st = plain(parse(fs.readFileSync(nbtPath)));
  const m = new Map();
  for (const b of st.blocks) m.set(b.pos.join(','), st.palette[b.state].Name ?? st.palette[b.state].id);
  return m;
}

// ------------------------------------------------------------------ the independent connectivity scan

const SOLID = new Set(['ROCK', 'SOIL', 'LOOSE', 'ICE', 'SNOW', 'LOG']);

/**
 * The scan of one record: every built cell reaches, through built cells (faces), a built cell that touches the site's solid. The site's
 * solid is the frozen fixture volume's classes (rock, soil, loose, ice, snow, log) at a cell the template does not write, or a keep-critical
 * cell; never what the world shows (scaffolding, the crate). Returns {built, connected, first}.
 */
function scan(cells, ctx) {
  const built = new Set(cells.map((c) => k3(...c)));
  const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const seen = new Set();
  const q = [];
  for (const c of cells) {
    for (const d of D) {
      const n = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      if (ctx.anchor(n)) { const k = k3(...c); if (!seen.has(k)) { seen.add(k); q.push(c); } break; }
    }
  }
  while (q.length) {
    const c = q.pop();
    for (const d of D) {
      const n = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      const k = k3(...n);
      if (built.has(k) && !seen.has(k)) { seen.add(k); q.push(n); }
    }
  }
  const first = cells.find((c) => !seen.has(k3(...c)));
  return { built: built.size, connected: seen.size, first: first ?? null };
}

async function siteCtx(id, fixture) {
  const side = JSON.parse(fs.readFileSync(path.join(KIT, 'examples', id, `${id}.blueprint.json`), 'utf8'));
  const site = side.site;
  const o = site.frame.origin;
  const { decodeArvx, classAt, VOXEL_CLASSES } = await imp('lib/region/volume.mjs');
  const vol = decodeArvx(fs.readFileSync(path.join(KIT, 'test', 'fixtures', 'site', fixture, 'volume.bin')));
  const tc = await templateCells(path.join(KIT, 'examples', id, `${id}.nbt`));
  const written = new Set([...tc.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return k3(o[0] + x, o[1] + y, o[2] + z); }));
  const keep = new Set((site.keepCritical ?? []).map((c) => k3(...c)));
  const anchor = (n) => {
    const k = k3(...n);
    if (written.has(k)) return false;
    return keep.has(k) || SOLID.has(VOXEL_CLASSES[classAt(vol, n[0], n[1], n[2])]);
  };
  const v = site.volume;
  const volBox = [v.minX, v.minY, v.minZ, v.maxX, v.maxY, v.maxZ];
  const area = [v.minX, v.minY - BELOW, v.minZ, v.maxX, v.maxY, v.maxZ];
  // the template box (rotation none in every fixture)
  const size = side.size;
  const box = [o[0], o[1], o[2], o[0] + size.x - 1, o[1] + size.y - 1, o[2] + size.z - 1];
  const port0 = site.ports[0];
  const portWorld = [o[0] + port0.at[0], o[1] + port0.at[1], o[2] + port0.at[2]];
  return { id, fixture, side, site, o, anchor, volBox, area, box, portWorld, port0, written };
}

// ------------------------------------------------------------------ feeding (as gate4e)

const addTo = (m, k, n) => { m[k] = (m[k] ?? 0) + n; };
const siteState = (id) => call('dev.site.state', { site: id }, 60_000);

/** Items in a container block (/data get block). */
async function containerItems(p) {
  const r = await cmd(`/data get block ${p.join(' ')} Items`);
  const text = (r.messages ?? []).join(' ');
  const out = {};
  for (const m of text.matchAll(/id: "([^"]+)"[^}]*?count: (\d+)|count: (\d+)[^}]*?id: "([^"]+)"/g)) addTo(out, m[1] ?? m[4], Number(m[2] ?? m[3]));
  return out;
}
/** A chest on a hopper on the site's crate: the hopper chain. */
async function hopperChain(site) {
  const c = (await siteState(site)).crate;
  const hop = [c.x, c.y + 1, c.z];
  const chest = [c.x, c.y + 2, c.z];
  await cmd(`/setblock ${hop.join(' ')} minecraft:hopper[facing=down]`);
  await cmd(`/setblock ${chest.join(' ')} minecraft:chest`);
  return { crate: [c.x, c.y, c.z], hop, chest };
}
/** Puts what the site still misses into the feed chest, stacks in item-id order (never build order); counts it into `into`. */
async function refill(site, feed, into, cap = Infinity) {
  const st = await siteState(site);
  if (Object.keys(await containerItems(feed.chest)).length) return 0; // still feeding
  const stacks = [];
  let total = Object.values(into).reduce((a, b) => a + b, 0);
  for (const r of [...(st.rows ?? [])].sort((a, b) => String(a.item).localeCompare(String(b.item)))) {
    let left = Math.max(0, (r.missing ?? 0) - (r.stock ?? 0));
    const max = /bed$|banner$/.test(r.item) ? 1 : /_door$|sign$/.test(r.item) ? 16 : 64;
    while (left > 0 && stacks.length < 27 && total < cap) {
      const n = Math.min(max, left, cap - total);
      stacks.push([r.item, n]);
      left -= n;
      total += n;
    }
  }
  for (let i = 0; i < stacks.length; i++) {
    await cmd(`/item replace block ${feed.chest.join(' ')} container.${i} with ${stacks[i][0]} ${stacks[i][1]}`);
    addTo(into, stacks[i][0], stacks[i][1]);
  }
  return stacks.length;
}
/** Item entities near a point (per id). */
async function itemsNear(p, radius = 16) {
  const r = await call('dev.items.near', { pos: p, radius }, 30_000);
  return r.items ?? r.byId ?? {};
}
function sub(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = (a[k] ?? 0) - (b[k] ?? 0); if (d) out[k] = d; }
  return out;
}
function plus(...ms) { const o = {}; for (const m of ms) for (const [k, v] of Object.entries(m ?? {})) addTo(o, k, v); return o; }
const tot = (m) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);

// ------------------------------------------------------------------ survival

async function freshHouse(ctx, name) {
  await L.fresh(name, FLAT);
  await L.setRules('exact');
  await L.tp(ctx.o[0] + 8, ctx.volBox[4] + 10, ctx.o[2] - 16);
  const t = await call('dev.pl.terrain', { file: path.join(KIT, 'test', 'fixtures', 'site', ctx.fixture, 'volume.bin'), blocks: { WATER: 'minecraft:water' } }, 300_000);
  await L.settle(2000);
  check(t.sha === ctx.site.volumeSha, `${ctx.id}: its fixture ${ctx.fixture}'s land built (${t.written} of ${t.cells} cells) and frozen`, t);
  await call('dev.survival.set', { on: true }, 30_000);
}

async function placeConstruction(ctx) {
  const p = await call('dev.pl.place', { blueprint: ctx.id, site: ctx.site, mode: 'construction' }, 300_000);
  check(p.placed, `${ctx.id}: Sites.place with its site in construction mode placed ${p.site}`, p);
  return p.site;
}

/** Waits until the site is built, refilling the chain; `onPoll(state)` may act (the restart). Returns the last state. */
async function feedUntil(site, feed, into, done, { minutes = 25, onPoll = null, cap = Infinity } = {}) {
  const end = Date.now() + minutes * 60_000;
  let st = null;
  while (Date.now() < end) {
    st = await siteState(site).catch(() => null);
    if (st && done(st)) return st;
    if (st && st.state !== 'built') await refill(site, feed, into, cap);
    if (onPoll && st && await onPoll(st)) continue;
    await sleep(2500);
  }
  return st;
}

steps.survival = async () => {
  await ensure();
  spendZero();
  const out = {};
  for (const [id, fixture] of HOUSES) {
    const ctx = await siteCtx(id, fixture);
    const r = { id };
    out[id] = r;

    // a) a partial build deconstructed with its scaffolding standing
    await freshHouse(ctx, `G6B SO ${id} a`);
    const pre = await cellsOf(ctx.area);
    const sa = await placeConstruction(ctx);
    if (!sa) continue;
    const scafA = count(await cellsOf(ctx.area), 'scaffolding');
    const feedA = await hopperChain(sa);
    const intoA = {};
    const stA = await feedUntil(sa, feedA, intoA, (s) => s.state === 'built' || (s.built ?? 0) * 100 >= (s.queue ?? 1) * 30, { minutes: 15 });
    const scafMid = count(await cellsOf(ctx.area), 'scaffolding');
    const dA = await call('dev.site.deconstruct', { site: sa }, 120_000);
    await L.settle(3000);
    const backA = plus(await itemsNear(feedA.crate), await containerItems(feedA.chest), await containerItems(feedA.hop));
    const lostA = sub(intoA, backA);
    const feedKeys = new Set([feedA.hop, feedA.chest].map((c) => k3(...c)));
    const eA = diff(pre, await cellsOf(ctx.area), feedKeys);
    check(dA.removed && Object.keys(lostA).length === 0 && !backA['minecraft:scaffolding'] && eA.n === 0,
      `${id} a: deconstructed at ${stA?.built}/${stA?.queue} with ${scafMid} scaffolding cells standing: every item fed (${tot(intoA)}) back (refunds + the crate's stock), no scaffolding item, the land exact (E-flat 0)`,
      { lost: lostA, back: tot(backA), eflat: eA.first, tally: dA.tally });
    r.partial = { built: stA?.built, queue: stA?.queue, scaffold: scafA, fed: tot(intoA), eflat: eA.n, lost: lostA };
    await L.leaveWorld();

    // b) the full build from the hopper chain, a restart half way
    const world = `G6B SO ${id} b`;
    await freshHouse(ctx, world);
    const pre2 = await cellsOf(ctx.area);
    await call('dev.so.watch', { every: EVERY }, 30_000);
    const s = await placeConstruction(ctx);
    if (!s) continue;
    const st0 = await siteState(s);
    const c = st0.crate;
    const cr = [c.x, c.y, c.z];
    const inBox = cr[0] >= ctx.box[0] && cr[0] <= ctx.box[3] && cr[1] >= ctx.box[1] - 1 && cr[1] <= ctx.box[4] && cr[2] >= ctx.box[2] && cr[2] <= ctx.box[5];
    const pd = Math.max(Math.abs(cr[0] - ctx.portWorld[0]), Math.abs(cr[2] - ctx.portWorld[2]));
    const cells0 = await cellsOf(ctx.area);
    const under = cells0.get(k3(cr[0], cr[1] - 1, cr[2]));
    check(!inBox && pd <= 4 && idOf(under) !== 'air' && idOf(under) !== 'scaffolding',
      `${id}: the crate ${json(cr)} at the first port's (${ctx.port0.name}, ${ctx.port0.facing}) landing: outside the box, ${pd} from the port, on ${idOf(under)}`, { crate: cr, port: ctx.portWorld });
    const scaf = await call('dev.so.scaffold', { site: s }, 30_000);
    const scafCells = count(cells0, 'scaffolding');
    const e0 = scaf.entries ?? [];
    const okScaf = scafCells === 0 ? e0.length === 0 : e0.length === 1 && e0[0].policy === 'CELL' && e0[0].status === 'ACTIVE' && e0[0].cells === scafCells;
    check(okScaf, `${id}: scaffolding ${scafCells} cells, ${scafCells ? 'one architect:scaffold CELL entry of as many cells in the site\'s group' : 'none (no column finds ground within reach)'}`, e0);
    r.crate = cr; r.scaffold = scafCells; r.queue = st0.queue;
    const feed = await hopperChain(s);
    const feedSet = new Set([feed.hop, feed.chest].map((x) => k3(...x)));
    const into = {};
    const records = [];
    let restarted = false;
    const st = await feedUntil(s, feed, into, (x) => x.state === 'built', {
      minutes: 30,
      onPoll: async (x) => {
        if (restarted || (x.built ?? 0) * 2 < (x.queue ?? 1)) return false;
        restarted = true;
        records.push(...((await call('dev.so.snapshots', { site: s }, 60_000)).snapshots ?? []));
        const atStop = x.built;
        await cmd('/save-all flush');
        await L.leaveWorld();
        await L.openWorld(world);
        await L.tp(ctx.o[0] + 8, ctx.volBox[4] + 10, ctx.o[2] - 16);
        await call('dev.so.watch', { every: EVERY }, 30_000);
        const after = await siteState(s);
        const snap = await call('dev.so.snapshots', { site: s }, 60_000);
        check(after.state === 'building' && after.built >= atStop - 2 && snap.bySupport === true,
          `${id}: saved, quit and reloaded at ${atStop}/${x.queue}: the site resumes building with its support gate rebuilt from its record`, { after: after.built, bySupport: snap.bySupport });
        return true;
      },
    });
    check(st?.state === 'built', `${id}: built from its hopper chain (${st?.built}/${st?.queue}; ${tot(into)} items fed)`, { state: st?.state });
    records.push(...((await call('dev.so.snapshots', { site: s }, 60_000)).snapshots ?? []));
    // every record connected (independent scan)
    let bad = null;
    for (const rec of records) {
      const sc = scan(rec.cells, ctx);
      if (sc.connected !== sc.built) { bad = { at: rec.built, ...sc }; break; }
    }
    const want = Math.floor((st?.queue ?? 0) / EVERY);
    check(!bad && records.length >= want, `${id}: ${records.length} built prefixes recorded (at least one per ${EVERY} cells: ${want}), each connected to the site by the independent scan`, { bad, at: records.map((x) => x.built) });
    r.records = records.map((x) => x.built);
    // built: scaffolding down, entry released; items in = items out
    await L.settle(2000);
    const built = await cellsOf(ctx.area);
    const scafAfter = (await call('dev.so.scaffold', { site: s }, 30_000)).entries ?? [];
    check(count(built, 'scaffolding') === 0 && !scafAfter.some((x) => x.status === 'ACTIVE'),
      `${id}: built: the scaffolding came down (${count(built, 'scaffolding')} cells left) and its entry is released (${scafAfter.length} left)`, scafAfter);
    const bom = st0.bom ?? {};
    const left = plus(await itemsNear(feed.crate), await containerItems(feed.chest), await containerItems(feed.hop));
    const book = sub(into, plus(bom, left));
    check(Object.keys(book).length === 0 && !left['minecraft:scaffolding'], `${id}: items in = items out: fed ${tot(into)} = paid standing ${tot(bom)} + crate leftovers and the chain's ${tot(left)}`, { book });
    // c) identical to its instant placement, after the deconstruct (all back, land exact)
    const d = await call('dev.site.deconstruct', { site: s }, 120_000);
    await L.settle(3000);
    const back = plus(await itemsNear(feed.crate), await containerItems(feed.chest), await containerItems(feed.hop));
    const lost = sub(into, back);
    const e = diff(pre2, await cellsOf(ctx.area), feedSet);
    check(d.removed && Object.keys(lost).length === 0 && e.n === 0, `${id}: deconstructed: every item fed (${tot(into)}) back, the land exact (E-flat 0)`, { lost, eflat: e.first });
    await cmd(`/kill @e[type=minecraft:item]`);
    await call('dev.survival.set', { on: false }, 30_000);
    const ip = await call('dev.pl.place', { blueprint: id, site: ctx.site, mode: 'instant' }, 300_000);
    await L.settle(2000);
    const inst = await cellsOf(ctx.area);
    const same = diff(built, inst, feedSet);
    const sameB = diff(inst, built, feedSet);
    check(ip.placed && same.n === 0 && sameB.n === 0, `${id}: the survival build is identical to its instant placement over ${built.size} cells (the hopper chain's two cells left out)`, { first: same.first, firstB: sameB.first });
    const rm = await call('dev.pl.remove', { site: ip.site }, 600_000);
    await L.settle(1500);
    const e2 = diff(pre2, await cellsOf(ctx.area), feedSet);
    check(rm.removed && e2.n === 0, `${id}: the instant placement's Remove is exact (E-flat 0)`, e2.first);
    Object.assign(r, { fed: tot(into), bom: tot(bom), leftovers: tot(left), eflat: e.n, identical: same.n + sameB.n, restarted });
    await call('dev.so.watch', { every: 0 }, 30_000);
    await L.leaveWorld();
  }
  return out;
};

steps.report = async () => {
  const files = fs.readdirSync(OUT).filter((f) => /^survival\.json$/.test(f));
  const lines = ['# Gate slice SO', '', `head ${execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim()}`, ''];
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
  console.error(`usage: node tools/gate7bso.mjs <${Object.keys(steps).join(' | ')}>`);
  process.exit(2);
}
await run(name);
const f = L.fails();
log(f ? `${f} FAILURE(S)` : 'all checks passed');
if (state.dev) await state.dev.close?.();
process.exit(f ? 1 : 0);
