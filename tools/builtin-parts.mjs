#!/usr/bin/env node
// Built-in parts (PLAN "After U4" item 3, U5 queued (d)): author a component library (parts) for each built-in Style that lacks one,
// review it, and promote it into the kit (kit/bibles/<id>/components.mjs, where rustic's lives). PAID only in `jobs` (Noah's claude
// login, never an API key; hard cap $25, approved 2026-10-24); everything else is $0.
//
//   node tools/builtin-parts.mjs plan                         the Styles, the per-job cap, the spend so far; runs nothing
//   node tools/builtin-parts.mjs jobs [--backend sim] [--port 8902] [--only japanese,modern]
//        U5's "Add parts…" (sidecar op bible.parts) on each built-in in a dev helper dir (<out>/helper: its own data, bibles and
//        library; not a player's game). Each makes a hand-made copy "<Style> (parts)" (bib_<style>_parts) with a components.mjs.
//        One job at a time; a failed job is retried at most once. Copies the copy's files to <out>/parts/<style>/.
//   node tools/builtin-parts.mjs check [--only ...] [--kit]   the review: the component check with the built-in's roles (errors,
//        warnings, S-THEME), the parts test house (every part at once, all four facings) through the checker, the distance from
//        rustic's reference library, the sheet and the house rendered (<out>/parts/<style>/sheet.png, house.png, check.json).
//        --kit checks the libraries the kit ships instead (kit/bibles/<id>/components.mjs).
//   node tools/builtin-parts.mjs promote <style...|--all> [--from <dir>]
//        copies an approved library into kit/bibles/<style>/components.mjs. Refused unless the copy's roles equal the built-in's
//        roles and the library passes the check with no error and no warning (S-THEME included) and its parts house passes.
//
// Safety (as tools/u4ab.mjs): refuses to start with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN /
// AWS_BEARER_TOKEN_BEDROCK set, scrubs ANTHROPIC_* and CLAUDE* from the sidecar's env, and before each paid job checks that the
// helper is on the claude login and that spent (actual, spend.json part1) + the job's cap + a margin stays within $25.
// <out> is ../architect-mc/artifacts/gate-runs-parts (PARTS_OUT overrides; the sim backend writes to <out>/sim).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BACKEND = opt('backend', 'claude');
const BASE = process.env.PARTS_OUT ? path.resolve(process.env.PARTS_OUT) : path.join(MAIN, 'artifacts', 'gate-runs-parts');
const OUT = BACKEND === 'sim' ? path.join(BASE, 'sim') : BASE;
const WORK = path.join(OUT, 'helper');
const PORT = Number(opt('port', 8902));
export const PART1_CAP = 25;
export const TOTAL_CAP = 40;
const JOB_CAP = Number(opt('job-cap', 1.55)); // the estimate's upper bound ($1.16-1.55); budgetUsd is set to it
const MARGIN = 0.15;
const HOLD_MAX_MS = 30 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
const KIT = path.join(root, 'kit');

const kit = async (m) => import(pathToFileURL(path.join(KIT, 'lib', m)).href);
const { BUILTIN_BIBLES, builtinBible, builtinComponentsFile } = await kit('bible.mjs');

/** The built-ins without parts at f05674a0: every preset except rustic (the 15). */
export const STYLES = BUILTIN_BIBLES.filter((n) => n !== 'rustic');

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.mkdirSync(OUT, { recursive: true });
  fs.appendFileSync(path.join(OUT, 'builtin-parts.log'), `${line}\n`);
};

// ---- spend.json (shared with tools/partsab.mjs: part1 and part2, each with its own cap; the total never above $40) ---------

export const SPEND = path.join(OUT, 'spend.json');
export function readSpend() {
  const s = fs.existsSync(SPEND) ? JSON.parse(fs.readFileSync(SPEND, 'utf8')) : {};
  s.capUsd = TOTAL_CAP;
  s.part1 ??= { capUsd: PART1_CAP, totalUsd: 0, jobs: [] };
  s.part2 ??= { capUsd: 15, totalUsd: 0, runs: [] };
  return s;
}
export function writeSpend(s) {
  s.part1.totalUsd = r6(s.part1.jobs.reduce((a, x) => a + (x.usd ?? 0), 0));
  s.part2.totalUsd = r6(s.part2.runs.reduce((a, x) => a + (x.usd ?? 0), 0));
  s.totalUsd = r6(s.part1.totalUsd + s.part2.totalUsd);
  s.backend = BACKEND;
  fs.mkdirSync(path.dirname(SPEND), { recursive: true });
  fs.writeFileSync(SPEND, `${JSON.stringify(s, null, 2)}\n`);
}
function beforePaid(name, estimate, auth) {
  const s = readSpend();
  const spent = s.part1.jobs.reduce((a, x) => a + (x.usd ?? 0), 0);
  log(`job ${name}: cap $${JOB_CAP}, estimate ${estimate?.usdLow !== undefined ? `$${estimate.usdLow}-${estimate.usdHigh}` : JSON.stringify(estimate)}, part 1 spent $${spent.toFixed(4)}, auth ${JSON.stringify(auth)}`);
  if (BACKEND !== 'sim' && (!/claude login/i.test(auth?.authSource ?? '') || /api key|bedrock|vertex/i.test(auth?.authSource ?? '') || auth?.auth !== 'ok')) throw new Error(`refusing ${name}: the helper is not on the claude login (${JSON.stringify(auth)})`);
  if (spent + JOB_CAP + MARGIN > PART1_CAP + 1e-9) throw Object.assign(new Error(`stopping before ${name}: part 1 spent $${spent.toFixed(2)} + its cap $${JOB_CAP} + $${MARGIN} would pass the $${PART1_CAP} cap`), { cap: true });
  if (s.totalUsd + JOB_CAP + MARGIN > TOTAL_CAP + 1e-9) throw Object.assign(new Error(`stopping before ${name}: the total would pass $${TOTAL_CAP}`), { cap: true });
  s.part1.jobs.push({ name, capUsd: JOB_CAP, estimate: estimate ?? null, startedAt: new Date().toISOString(), usd: 0, auth: auth?.authSource ?? BACKEND });
  writeSpend(s);
}
function recordPaid(name, usd, extra = {}) {
  const s = readSpend();
  const st = [...s.part1.jobs].reverse().find((x) => x.name === name);
  st.usd = r6(usd);
  Object.assign(st, extra);
  writeSpend(s);
}

// ---- the sidecar (as tools/u4ab.mjs) -------------------------------------------------------------------

let proc;
export async function startSidecar(work, port, backend, label) {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) if (process.env[k]) throw new Error(`refusing: ${k} is set (paid runs use the claude login only)`);
  const data = path.join(work, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.rmSync(path.join(data, 'client.token'), { force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE)/.test(k)));
  const out = fs.openSync(path.join(work, 'sidecar.log'), 'a');
  const a = ['--import', 'tsx', 'src/main.ts', '--port', String(port), '--data', data, '--library', path.join(work, 'library'), '--kit', KIT, '--bibles', path.join(work, 'bibles'), '--massings', path.join(work, 'massings')];
  if (backend === 'sim') a.push('--backend', 'sim');
  else a.push('--use-claude-login');
  proc = spawn(process.execPath, a, { cwd: path.join(root, 'sidecar'), env, stdio: ['ignore', out, out] });
  (label ?? log)(`sidecar pid ${proc.pid} on ${port} (${backend})`);
  fs.writeFileSync(path.join(work, 'sidecar.pid'), String(proc.pid));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'client.token')); i++) await sleep(200);
  return data;
}
export async function stopSidecar() {
  if (!proc || proc.exitCode !== null) return;
  const done = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM'); // our own child, by its handle
  await Promise.race([done, sleep(20_000)]);
}

export class Conn {
  static async open(port, dataDir, client = 'builtin-parts') {
    const token = fs.readFileSync(path.join(dataDir, 'client.token'), 'utf8').trim();
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.msgs = [];
    c.n = 0;
    c.designs = new Map();
    c.bibles = new Map();
    c.status = null;
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'design.upsert') c.designs.set(m.design.id, m.design);
      else if (m.type === 'bible.upsert') c.bibles.set(m.bible.id, m.bible);
      else if (m.type === 'status') c.status = m.status;
      else if (m.type === 'snapshot') {
        c.status = m.status ?? c.status;
        for (const d of m.designs ?? []) c.designs.set(d.id, d);
        for (const b of m.bibles ?? []) c.bibles.set(b.id, b);
      } else c.msgs.push(m);
    };
    await new Promise((res, rej) => ((c.ws.onopen = res), (c.ws.onerror = rej)));
    c.ws.send(JSON.stringify({ v: 1, type: 'hello', client, token, protocols: [2] }));
    for (let i = 0; i < 100 && !c.status; i++) await sleep(100);
    return c;
  }
  async send(o) {
    const id = `u${++this.n}`;
    this.ws.send(JSON.stringify({ v: 1, id, ...o }));
    for (let i = 0; i < 600; i++) {
      const a = this.msgs.find((m) => m.type === 'ack' && m.re === id);
      if (a) {
        if (!a.ok) throw new Error(`${o.type}: ${a.error}`);
        return a.result ?? {};
      }
      await sleep(100);
    }
    throw new Error(`no ack for ${o.type}`);
  }
  auth() {
    return { auth: this.status?.auth, authSource: this.status?.authSource };
  }
}

// ---- one job ----------------------------------------------------------------------------------------------

async function jobOne(c, data, style, attempt) {
  const name = attempt > 1 ? `${style}#${attempt}` : style;
  const est = await c.send({ type: 'bible.estimate', parts: true }).catch((e) => ({ error: e.message }));
  beforePaid(name, est, c.auth());
  const t0 = Date.now();
  const ack = await c.send({ type: 'bible.parts', bibleId: style, budgetUsd: JOB_CAP });
  log(`${name}: job ${ack.jobId} -> ${ack.bibleId} v${ack.version} (copy ${ack.copy})`);
  let j;
  let heldSince;
  for (;;) {
    j = c.bibles.get(ack.jobId);
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) break;
    if (c.status?.limitUntil && c.status.limitUntil > Date.now()) {
      heldSince ??= Date.now();
      if (Date.now() - heldSince > HOLD_MAX_MS) {
        recordPaid(name, j?.cost?.usd ?? 0, { status: 'held' });
        throw Object.assign(new Error(`${name}: usage-limit hold over 30 min`), { held: true });
      }
    } else heldSince = undefined;
    recordPaid(name, j?.cost?.usd ?? 0, { step: j?.step ?? null });
    await sleep(5000);
  }
  const ms = Date.now() - t0;
  recordPaid(name, j.cost?.usd ?? 0, { status: j.status, endedAt: new Date().toISOString(), ms, jobId: j.id, bibleId: ack.bibleId, version: ack.version, rounds: j.rounds ?? null, error: j.error ?? null, step: j.step ?? null });
  const dir = path.join(OUT, 'parts', style);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `job${attempt > 1 ? `-${attempt}` : ''}.json`), `${JSON.stringify(j, null, 2)}\n`);
  // the component brief the pass got, and the drafted copy's files
  const scratch = path.join(data, 'bibles', j.id);
  for (const f of ['BIBLE.md']) if (fs.existsSync(path.join(scratch, f))) fs.copyFileSync(path.join(scratch, f), path.join(dir, f));
  if (fs.existsSync(path.join(scratch, 'bible', 'bible.md'))) fs.copyFileSync(path.join(scratch, 'bible', 'bible.md'), path.join(dir, 'seed-bible.md'));
  if (j.status === 'done') {
    const vdir = path.join(WORK, 'bibles', ack.bibleId, 'versions', String(ack.version));
    for (const f of ['bible.json', 'bible.md', 'components.mjs', 'sheet.png']) if (fs.existsSync(path.join(vdir, f))) fs.copyFileSync(path.join(vdir, f), path.join(dir, f === 'sheet.png' ? 'job-sheet.png' : f));
  }
  log(`${name}: ${j.status} $${(j.cost?.usd ?? 0).toFixed(4)} in ${(ms / 60000).toFixed(1)} min, ${j.rounds ?? '?'} round(s)${j.error ? ` (${String(j.error).split('\n')[0]})` : ''}`);
  return j;
}

async function jobs() {
  const only = opt('only', null)?.split(',');
  const data = await startSidecar(WORK, PORT, BACKEND);
  try {
    const c = await Conn.open(PORT, data);
    for (let i = 0; i < 120 && c.status?.auth === 'checking'; i++) await sleep(1000);
    log(`auth: ${JSON.stringify(c.auth())}`);
    // the Styles with shape hints first (a stop at the cap leaves the plain palettes), or the --only order
    const order = only ?? [...STYLES.filter((s) => builtinBible(s).roofLanguage), ...STYLES.filter((s) => !builtinBible(s).roofLanguage)];
    for (const s of order) {
      if (!STYLES.includes(s)) throw new Error(`${s} is not a built-in without parts`);
      if (fs.existsSync(path.join(OUT, 'parts', s, 'components.mjs'))) {
        log(`${s}: already done, skipped`);
        continue;
      }
      let j = await jobOne(c, data, s, 1);
      if (j.status !== 'done') {
        log(`${s}: ${j.status}, one retry`);
        j = await jobOne(c, data, s, 2);
      }
    }
    log(`done: part 1 spent $${readSpend().part1.totalUsd}`);
  } catch (e) {
    log(`stopped: ${e.message}`);
    process.exitCode = e.held ? 4 : e.cap ? 3 : 1;
  } finally {
    await stopSidecar();
  }
}

// ---- the review ($0) ---------------------------------------------------------------------------------------

/** Normalised source lines (comments and blank lines dropped). */
const codeLines = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
/** Share of a library's code lines that also appear in rustic's reference library (1 = a copy). */
function rusticOverlap(src) {
  const ref = new Set(codeLines(fs.readFileSync(builtinComponentsFile('rustic'), 'utf8')));
  const l = codeLines(src);
  return l.length ? r6(l.filter((x) => ref.has(x)).length / l.length) : 1;
}

/** Check one library against a built-in's roles: { ok, strictOk, errors, warnings, theme, house, overlap, components, cells }. */
export async function reviewLibrary(file, style, outDir) {
  const { palette } = await kit('kit.mjs');
  const C = await kit('components.mjs');
  const { checkBlueprint } = await kit('check.mjs');
  const { plain } = await kit('nbt.mjs');
  const { buildScene, renderFront } = await kit('render.mjs');
  const { encodePng } = await kit('png.mjs');
  const b = builtinBible(style);
  const p = palette({ bible: { id: b.id, version: b.version ?? 1, roles: b.roles } });
  const r = await C.checkComponents(path.resolve(file), p);
  const L = await C.loadComponents(path.resolve(file));
  let house;
  let houseBp;
  try {
    houseBp = C.buildPartsHouse(p, L.components, L.meta);
    const h = checkBlueprint(houseBp);
    house = { ok: h.ok, errors: h.errors, warnings: h.warnings };
  } catch (e) {
    house = { ok: false, errors: [`threw: ${e.message}`], warnings: [] };
  }
  const src = fs.readFileSync(file, 'utf8');
  const theme = r.warnings.filter((w) => /S-THEME/.test(w));
  const out = {
    style,
    ok: r.ok && house.ok,
    strictOk: r.ok && house.ok && r.warnings.length === 0 && house.warnings.length === 0,
    errors: r.errors,
    warnings: r.warnings,
    theme,
    house,
    components: r.components.map((c) => c.name),
    overlapWithRustic: rusticOverlap(src),
    sourceLines: codeLines(src).length,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'sheet.png'), C.renderSheet([C.buildSwatch(p), ...r.frames.map((f) => f.bp)]));
    if (houseBp) {
      fs.writeFileSync(path.join(outDir, 'house.png'), C.renderSheet([houseBp], { columns: 1, tileWidth: 640 }));
      const front = renderFront(buildScene(plain(houseBp.toStructure()), { front: houseBp.front }), { width: 520, bg: [236, 232, 224] });
      fs.writeFileSync(path.join(outDir, 'house-front.png'), encodePng(front.width, front.height, front.data));
    }
    fs.writeFileSync(path.join(outDir, 'check.json'), `${JSON.stringify(out, null, 2)}\n`);
  }
  return out;
}

async function check() {
  const only = opt('only', null)?.split(',');
  const fromKit = args.includes('--kit');
  const rows = [];
  for (const s of fromKit ? BUILTIN_BIBLES : STYLES) {
    if (only && !only.includes(s)) continue;
    const file = fromKit ? builtinComponentsFile(s) : path.join(OUT, 'parts', s, 'components.mjs');
    if (!file || !fs.existsSync(file)) {
      rows.push({ style: s, missing: true });
      continue;
    }
    const r = await reviewLibrary(file, s, fromKit ? path.join(OUT, 'kit-check', s) : path.join(OUT, 'parts', s));
    rows.push(r);
    console.log(`${s.padEnd(9)} ${r.ok ? 'ok ' : 'BAD'} strict ${r.strictOk ? 'ok ' : 'no '} parts ${r.components.join(',')}; rustic overlap ${r.overlapWithRustic}; ${r.errors.length} error(s), ${r.warnings.length} warning(s) (${r.theme.length} S-THEME), house ${r.house.ok ? 'ok' : 'BAD'} ${r.house.errors.length}/${r.house.warnings.length}`);
    for (const e of [...r.errors, ...r.house.errors.map((x) => `house: ${x}`)]) console.log(`    error: ${e}`);
    for (const w of [...r.warnings, ...r.house.warnings.map((x) => `house: ${x}`)]) console.log(`    warning: ${w}`);
  }
  fs.writeFileSync(path.join(OUT, fromKit ? 'kit-check.json' : 'check.json'), `${JSON.stringify(rows, null, 2)}\n`);
  if (rows.some((r) => !r.missing && !r.ok)) process.exitCode = 1;
}

// ---- promotion ($0) -------------------------------------------------------------------------------------

const sameRoles = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

async function promote() {
  const list = args.includes('--all') ? STYLES : args.slice(1).filter((a) => !a.startsWith('--') && a !== opt('from', null));
  const from = opt('from', path.join(OUT, 'parts'));
  let bad = 0;
  for (const s of list) {
    if (!BUILTIN_BIBLES.includes(s)) throw new Error(`no built-in Style ${s}`);
    const dir = path.join(from, s);
    const file = path.join(dir, 'components.mjs');
    if (!fs.existsSync(file)) {
      console.log(`${s}: no components.mjs in ${dir}: skipped`);
      bad++;
      continue;
    }
    // the copy was drafted with the built-in's roles (a later kit change to them would make the parts read other blocks)
    const copy = fs.existsSync(path.join(dir, 'bible.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'bible.json'), 'utf8')) : null;
    if (copy && !sameRoles(copy.roles, builtinBible(s).roles)) {
      console.log(`${s}: refused: the copy's roles differ from the built-in's (${JSON.stringify(copy.roles)})`);
      bad++;
      continue;
    }
    const r = await reviewLibrary(file, s);
    if (!r.strictOk) {
      console.log(`${s}: refused: ${[...r.errors, ...r.warnings, ...r.house.errors.map((x) => `house: ${x}`), ...r.house.warnings.map((x) => `house: ${x}`)].join(' | ')}`);
      bad++;
      continue;
    }
    const dest = path.join(KIT, 'bibles', s, 'components.mjs');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const src = fs.readFileSync(file, 'utf8');
    const head = `// Component library (parts) of the built-in Style \`${s}\`: drafted by U5's "Add parts…" (bible.parts) on ${copy?.id ?? 'a copy'}${copy?.partsOf ? ` (from ${copy.partsOf.id} v${copy.partsOf.version})` : ''},\n// reviewed and promoted with tools/builtin-parts.mjs (2026-10-24). lib/components.mjs has the rules.\n`;
    fs.writeFileSync(dest, src.startsWith('// Component library (parts) of the built-in Style') ? src : `${head}${src}`);
    console.log(`${s}: promoted -> ${path.relative(root, dest)} (${r.components.length} parts: ${r.components.join(', ')})`);
  }
  if (bad) process.exitCode = 1;
}

// ---- main -------------------------------------------------------------------------------------------

const cmd = args[0];
if (cmd === 'plan') {
  console.log(JSON.stringify({ capUsd: PART1_CAP, jobCapUsd: JOB_CAP, marginUsd: MARGIN, spent: readSpend().part1.totalUsd, styles: STYLES.map((s) => ({ style: s, hasKitParts: !!builtinComponentsFile(s) })) }, null, 2));
} else if (cmd === 'jobs') await jobs();
else if (cmd === 'check') await check();
else if (cmd === 'promote') await promote();
else if (cmd) {
  console.error('usage: node tools/builtin-parts.mjs plan|jobs|check|promote [--backend sim] [--port N] [--only a,b] [--kit] [--all] [--from dir]');
  process.exitCode = 2;
}
// (imported by tools/partsab.mjs for the shared spend file and the sidecar helpers)
export { spawnSync };
