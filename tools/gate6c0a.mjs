#!/usr/bin/env node
// Phase 6c slice 0a gate driver (docs/CONTRACT.md "Phase 6c slice 0a", §13). $0: the sim backend only, no Claude; it refuses to
// start with Claude credentials in the environment and scrubs ANTHROPIC_* / CLAUDE* from every child.
//
//   node tools/gate6c0a.mjs stub [--jar <architect_mc-x.y.z.jar>] [--port 8902]
//       0.12.2's consumer stub (§2, the sim end-to-end run): the helper bundled in the PACKED jar (architect-sidecar/, as the
//       launcher extracts it, with no node_modules: no npm install) runs with --backend sim and ARCHITECT_SIM_COSTS=measured.
//       Over the protocol, as a consumer's mod would: a scripted job.run card (and a mismatching one that fails at once), a
//       bible, a 3-item massingFirst group with approvalUi owner, one redirect, a helper restart while awaiting approval (the
//       group is re-read: same status, same massing versions, nothing re-run), approve, the details; the notional costs sum
//       to the measured figures exactly; sim:fail / sim:repair / sim:usage_limit give FAILED, a repair round and HELD_USAGE;
//       the estimate's basis says sim: true; all of it under 2 minutes at the default simStepMs (400).
//
//   node tools/gate6c0a.mjs flow|fit|batches|keys|cancel|pins|stopped|tiles
//       the in-game items (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11) against GATE6C0A_RUN's client (see "in game" below)
//
// Evidence: artifacts/gate6c0a/<step>.json in the main checkout (GATE6C0A_OUT overrides), spend.json ($0.00).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(path.dirname(root), 'architect-mc');
const OUT = process.env.GATE6C0A_OUT ? path.resolve(process.env.GATE6C0A_OUT) : path.join(MAIN, 'artifacts', 'gate6c0a');
fs.mkdirSync(OUT, { recursive: true });
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) {
  if (process.env[k]) {
    console.error(`refusing: ${k} is set (this gate is $0, sim only)`);
    process.exit(3);
  }
}
const childEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE)/.test(k)));

const args = process.argv.slice(2);
const step = args[0];
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const results = {};
let failures = 0;
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => Math.round(n * 1e6) / 1e6;

/** A protocol-2 client of a sidecar (hello with its client token, acks by id, every message kept). */
class Conn {
  static async open(port, dataDir) {
    const token = fs.readFileSync(path.join(dataDir, 'client.token'), 'utf8').trim();
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.msgs = [];
    c.waiters = [];
    c.n = 0;
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      c.msgs.push(m);
      for (const w of [...c.waiters]) if (w.pred(m)) (c.waiters.splice(c.waiters.indexOf(w), 1), w.res(m));
    };
    await new Promise((res, rej) => ((c.ws.onopen = res), (c.ws.onerror = rej)));
    c.ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'gate6c0a', token, protocols: [2] }));
    c.snapshot = await c.wait((m) => m.type === 'snapshot', 10_000, 'the snapshot');
    return c;
  }
  wait(pred, ms, what) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) (this.waiters.splice(i, 1), rej(new Error(`timed out (${ms} ms) waiting for ${what}`)));
      }, ms).unref?.();
    });
  }
  async send(o, allowFail = false) {
    const id = `g${++this.n}`;
    this.ws.send(JSON.stringify({ v: 1, id, ...o }));
    const a = await this.wait((m) => m.type === 'ack' && m.re === id, 30_000, `the ack of ${o.type}`);
    if (!a.ok && !allowFail) throw new Error(`${o.type}: ${a.error}`);
    return allowFail ? a : a.result;
  }
  close() {
    this.ws.close();
  }
}

/** The bundled helper of a packed jar, extracted as the launcher does (no npm install), started with --backend sim. */
class Helper {
  constructor(dir, port, env) {
    this.dir = dir;
    this.port = port;
    this.env = env;
    this.data = path.join(dir, 'game', 'architect', 'sidecar-data');
    this.library = path.join(dir, 'game', 'architect', 'library');
  }
  async start() {
    fs.mkdirSync(this.data, { recursive: true });
    const tok = path.join(this.data, 'client.token');
    fs.rmSync(tok, { force: true });
    const sc = path.join(this.dir, 'architect-sidecar');
    this.proc = spawn(process.execPath, [path.join(sc, 'dist', 'main.mjs'), '--port', String(this.port), '--data', this.data, '--library', this.library, '--kit', path.join(sc, 'kit'), '--backend', 'sim'], {
      cwd: sc,
      env: { ...childEnv(), ...this.env },
      stdio: ['ignore', fs.openSync(path.join(OUT, 'stub-helper.log'), 'a'), fs.openSync(path.join(OUT, 'stub-helper.log'), 'a')],
    });
    for (let i = 0; i < 100 && !fs.existsSync(tok); i++) await sleep(100);
    if (!fs.existsSync(tok)) throw new Error('the helper did not start (no client.token; see stub-helper.log)');
  }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const done = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGTERM'); // our own child, by its handle
    await Promise.race([done, sleep(10_000)]);
  }
}

const steps = {};

steps.stub = async () => {
  const ver = fs.readFileSync(path.join(root, 'mod', 'gradle.properties'), 'utf8').match(/^mod_version=(.+)$/m)[1].trim();
  // the packed jar: the run worktree's build when GATE6C0A_RUN is set (the gate runner's unit-mod built it), else this checkout's
  const jarRoot = process.env.GATE6C0A_RUN ? path.resolve(process.env.GATE6C0A_RUN) : root;
  let jar = path.resolve(opt('jar', path.join(jarRoot, 'mod', 'build', 'libs', `architect_mc-${ver}.jar`)));
  // a shard that did not run unit-mod has no build: this checkout's (the same HEAD when the runner launched it)
  if (!fs.existsSync(jar) && jarRoot !== root) jar = path.join(root, 'mod', 'build', 'libs', `architect_mc-${ver}.jar`);
  const port = Number(opt('port', process.env.ARCHITECT_PORT ?? '8902'));
  if (!fs.existsSync(jar)) throw new Error(`no ${jar} (cd sidecar && npm run build; cd mod && ./gradlew build)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate6c0a-stub-'));
  fs.rmSync(path.join(OUT, 'stub-helper.log'), { force: true });
  execFileSync('unzip', ['-q', jar, 'architect-sidecar/*', '-d', dir]);
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, 'architect-sidecar', 'BUNDLE.json'), 'utf8'));
  const out = { jar, bundle, port };
  check(bundle.modVersion === ver && !fs.existsSync(path.join(dir, 'architect-sidecar', 'node_modules')), `the packed ${path.basename(jar)} carries the helper bundle (BUNDLE.json modVersion ${bundle.modVersion}); extracted with no node_modules (no npm install)`);
  const h = new Helper(dir, port, { ARCHITECT_SIM_COSTS: 'measured' });
  const t0 = Date.now();
  const T = () => Math.round((Date.now() - t0) / 100) / 10;
  let c;
  try {
    await h.start();
    c = await Conn.open(port, h.data);
    out.status = c.snapshot.status;
    check(c.snapshot.status.backend === 'sim' && c.snapshot.status.auth === 'ok' && c.snapshot.status.sdk === 'missing', `the helper runs the sim with no Agent SDK installed (backend ${c.snapshot.status.backend}, auth ${c.snapshot.status.auth}, sdk ${c.snapshot.status.sdk}): "${c.snapshot.status.message}"`);
    const startLog = fs.readFileSync(path.join(h.data, 'logs', 'sidecar.log'), 'utf8');
    check(/sim costs: sim: true, notional sim costs "measured"/.test(startLog), 'the log labels the notional costs sim: true at start');

    // 1. the scripted card
    const schema = { type: 'object', properties: { title: { type: 'string' }, floors: { type: 'integer', minimum: 1 } }, required: ['title', 'floors'], additionalProperties: false };
    const card = { title: 'The Mill', floors: 2 };
    const j1 = await c.send({ type: 'job.run', job: { kind: 'structured', prompt: 'a card for the mill', schema, owner: 'steward:e2e', ext: { 'architect:simAnswer': card } } });
    const jd = await c.wait((m) => m.type === 'job.upsert' && m.job.id === j1.jobId && ['done', 'failed', 'cancelled'].includes(m.job.status), 30_000, 'the card job');
    check(jd.job.status === 'done' && JSON.stringify(jd.job.result) === JSON.stringify(card), `job.run: the scripted card comes back as the answer (${jd.job.status} at ${T()} s)`, jd.job.result);
    const j2 = await c.send({ type: 'job.run', job: { kind: 'structured', prompt: 'a bad card', schema, ext: { 'architect:simAnswer': { title: 'No floors' } } } });
    const jf = await c.wait((m) => m.type === 'job.upsert' && m.job.id === j2.jobId && ['done', 'failed', 'cancelled'].includes(m.job.status), 30_000, 'the bad card job');
    check(jf.job.status === 'failed' && /does not match the job's schema/.test(jf.job.error ?? ''), `job.run: a scripted card that does not match the schema fails at once ("${(jf.job.error ?? '').slice(0, 120)}")`);

    // 2. the bible
    const b = await c.send({ type: 'bible.request', request: { prompt: 'a riverside mill town', name: 'Mill Town', owner: 'steward:e2e' } });
    const bd = await c.wait((m) => m.type === 'bible.upsert' && m.bible.id === b.jobId && ['done', 'failed', 'cancelled'].includes(m.bible.status), 60_000, 'the bible');
    check(bd.bible.status === 'done' && bd.bible.cost.usd === 1.35, `bible ${bd.bible.bibleId}: done, notional cost $${bd.bible.cost.usd} (measured: $1.35) at ${T()} s`);

    // 3. the estimate, labelled
    const it = (k, type, extra = {}) => ({ itemKey: k, type, style: 'rustic', materials: 'spruce and cobblestone', features: [], maxSize: { x: 32, y: 48, z: 32 }, ...extra });
    const items = [it('mill', 'tavern'), it('house', 'cabin'), it('tower', 'tower')];
    const est = await c.send({ type: 'design.estimate', group: { name: 'Hamlet', bible: bd.bible.bibleId, owner: 'steward:e2e', massingFirst: true, approvalUi: 'owner', items } });
    out.estimate = est;
    check(/sim: true/.test(est.basis), `design.estimate: the basis says sim: true ($${est.usdLow}-${est.usdHigh})`, est.basis);

    // 4. massingFirst, owner approval: a redirect, a helper restart while awaiting, approve, details
    const g = await c.send({ type: 'design.group', group: { name: 'Hamlet', bible: bd.bible.bibleId, owner: 'steward:e2e', massingFirst: true, approvalUi: 'owner', items } });
    const awaiting = (conn, v) => conn.wait((m) => m.type === 'group.upsert' && m.group.id === g.groupId && m.group.status === 'awaiting_approval' && m.group.items.every((x) => x.stage === 'approval') && (v === undefined || m.group.items[0].massing?.version === v), 60_000, `the group awaiting approval${v ? ` (mill v${v})` : ''}`);
    const a1 = await awaiting(c, 1);
    check(a1.group.items.every((x) => x.massing?.version === 1), `group ${g.groupId}: 3 massings, awaiting approval at ${T()} s (${a1.group.items.map((x) => `${x.itemKey} ${x.massing.id}@${x.massing.version}`).join(', ')})`);
    const wrong = await c.send({ type: 'group.approve', groupId: g.groupId, owner: 'someone:else', approve: ['mill'] }, true);
    check(!wrong.ok, `approvalUi owner: another owner's approve is refused ("${wrong.error}")`);
    await c.send({ type: 'group.approve', groupId: g.groupId, owner: 'steward:e2e', redirect: { mill: 'a longer mill hall' } });
    const a2 = await awaiting(c, 2);
    check(a2.group.items[0].massing.version === 2 && a2.group.items[0].rounds === 1, `redirect: mill has massing v2 (round ${a2.group.items[0].rounds}) and the group awaits approval again at ${T()} s`);
    // the helper restarts while the group awaits approval
    const before = { status: a2.group.status, items: a2.group.items.map((x) => [x.itemKey, x.massing.version, x.designIds.length]), cost: a2.group.cost.usd };
    c.close();
    await h.stop();
    await h.start();
    c = await Conn.open(port, h.data);
    await sleep(2000); // anything that would re-run would have started
    const again = c.snapshot.groups.find((x) => x.id === g.groupId);
    const now = c.msgs.filter((m) => m.type === 'group.upsert' && m.group.id === g.groupId).pop()?.group ?? again;
    const after = { status: now.status, items: now.items.map((x) => [x.itemKey, x.massing.version, x.designIds.length]), cost: now.cost.usd };
    check(JSON.stringify(before) === JSON.stringify(after), `a helper restart while awaiting approval: the group is re-read unchanged (status, massing versions, designs, cost $${after.cost}); nothing re-ran`, { before, after });
    await c.send({ type: 'group.approve', groupId: g.groupId, owner: 'steward:e2e', approve: ['mill', 'house', 'tower'] });
    const gd = await c.wait((m) => m.type === 'group.upsert' && m.group.id === g.groupId && ['done', 'failed', 'cancelled'].includes(m.group.status), 120_000, 'the details');
    out.group = gd.group;
    const want = usd(4 * 0.19 + 3 * 3.4);
    check(gd.group.status === 'done' && gd.group.items.every((x) => x.status === 'done' && x.entryId), `details: the group is done at ${T()} s (${gd.group.items.map((x) => x.entryId).join(', ')})`);
    check(gd.group.cost.usd === want, `the group's notional cost is 4 massings + 3 details at the measured figures: $${gd.group.cost.usd} (want $${want})`);
    const secs = T();
    out.flowSeconds = secs;
    check(secs < 120, `the Steward-sized flow (card, bible, 3 massings, a redirect, a restart, approval, 3 details) took ${secs} s (< 120 s at simStepMs 400)`);
    const doneLog = fs.readFileSync(path.join(h.data, 'logs', 'sidecar.log'), 'utf8');
    check(new RegExp(`group ${g.groupId} done: .*\\(sim: true, notional\\)`).test(doneLog), "the log labels the group's final cost sim: true");

    // 5. faults
    const f = await c.send({ type: 'design.group', group: { name: 'Faults', bible: bd.bible.bibleId, owner: 'steward:e2e', items: [it('f', 'cabin', { notes: 'sim:fail' }), it('r', 'cabin', { ext: { 'architect:sim': 'repair' } }), it('u', 'cabin', { notes: 'sim:usage_limit' })] } });
    const fd = await c.wait((m) => m.type === 'group.upsert' && m.group.id === f.groupId && ['done', 'failed', 'cancelled'].includes(m.group.status), 120_000, 'the fault group');
    const [fi, ri, ui] = fd.group.items;
    check(fi.status === 'failed' && /sim:fail/.test(fi.error ?? ''), `sim:fail: the item fails ("${fi.error}")`);
    // (turns count every step run, also those run again after the usage limit the third item hits meanwhile; the cost does not)
    const repairLog = fs.readFileSync(path.join(h.data, 'logs', 'sidecar.log'), 'utf8').split('\n').filter((l) => l.includes(`design ${ri.designId}: round 1's check failed (simulated, sim:repair)`));
    check(ri.status === 'done' && ri.cost.usd === usd(3.4 + 0.5) && repairLog.length === 1, `sim:repair: one repair round (cost $${ri.cost.usd} = detail + repair; ${ri.cost.turns} turns; the log: "${repairLog[0]?.replace(/^.*\] /, '')}")`);
    const held = c.msgs.some((m) => m.type === 'group.upsert' && m.group.id === f.groupId && m.group.status === 'held_usage');
    check(held && ui.status === 'done' && ui.cost.usd === 3.4, `sim:usage_limit: the group went HELD_USAGE, then the item finished at the detail's cost ($${ui.cost.usd})`);
  } catch (e) {
    check(false, `stub: ${e.message}`);
  } finally {
    c?.close();
    await h.stop();
    out.log = fs.existsSync(path.join(h.data, 'logs', 'sidecar.log')) ? fs.readFileSync(path.join(h.data, 'logs', 'sidecar.log'), 'utf8').split('\n').filter((l) => /WARN|ERROR|sim costs|done:|failed/.test(l)).slice(-40) : [];
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
};

/**
 * The consumer path in game (tools/run-gate6c0a-client.sh up, DevBridge on ARCHITECT_DEV_PORT, default 8903): the launcher took
 * the BUNDLED helper with --backend sim and skipped npm ci; the helper runs the sim with the notional costs.
 */
steps.launcher = async () => {
  process.env.ARCHITECT_DEV_PORT ??= '8903';
  const { DevClient } = await import('./lib/devclient.mjs');
  const dev = await DevClient.connect({ timeoutMs: 600_000 });
  const out = {};
  try {
    let st;
    for (let i = 0; i < 300; i++) {
      st = await dev.call('dev.launcher.state');
      if (['running', 'crashed', 'disabled', 'node-missing'].includes(st.state)) break;
      await sleep(1000);
    }
    out.launcher = st;
    check(st.state === 'running' && st.source === 'bundled', `the launcher runs the bundled helper (state ${st.state}, source ${st.source} from ${st.sourceOrigin})`, st);
    const gameDir = process.env.ARCHITECT_GAME_DIR || path.join(root, 'mod', 'run');
    const ver = fs.readFileSync(path.join(root, 'mod', 'gradle.properties'), 'utf8').match(/^mod_version=(.+)$/m)[1].trim();
    const ext = path.join(gameDir, 'architect', 'sidecar', ver);
    out.extracted = fs.existsSync(ext) ? fs.readdirSync(ext) : null;
    check(!!out.extracted && out.extracted.includes('dist') && !out.extracted.includes('node_modules') && !out.extracted.includes('.installed'), `sim: no npm install in ${path.relative(root, ext)} (${(out.extracted ?? []).join(', ')})`);
    const sc = await dev.call('dev.sidecar.state');
    out.status = sc.status;
    check(/^sim /.test(sc.status?.authSource ?? '') && sc.status?.auth === 'ok' && sc.status?.sdk === 'missing', `the helper runs the sim with no Agent SDK: auth ${sc.status?.auth} (${sc.status?.authSource}), sdk ${sc.status?.sdk}`);
    const log = fs.readFileSync(path.join(gameDir, 'architect', 'sidecar-data', 'logs', 'sidecar.log'), 'utf8');
    check(/sim costs: sim: true/.test(log), 'the helper log labels the notional costs sim: true');
    const ml = path.join(gameDir, 'logs', 'latest.log');
    out.launcherLog = fs.existsSync(ml) ? fs.readFileSync(ml, 'utf8').split('\n').filter((l) => /Launcher:/.test(l)).slice(-10) : [];
    check(out.launcherLog.some((l) => /the sim backend needs no npm install/.test(l)), 'the game log: "the sim backend needs no npm install"');
  } finally {
    dev.close();
  }
  return out;
};

// ================================================================== in game (items 1-10): the run worktree's client, by PID
//
//   GATE6C0A_RUN (default ../architect-mc-0a-run, seeded like the gate runner's: worlds, the library, .gradle-home) runs
//   tools/run-gate6c0a-client.sh: the BUNDLED helper with --backend sim, ARCHITECT_SIM_COSTS (default measured), the apitest mod,
//   DevBridge ARCHITECT_DEV_PORT (8903), sidecar ARCHITECT_PORT (8902). Its clients are found by their own launch.cfg path and
//   stopped by PID; a "crash" is SIGKILL to that PID.

const RUN = process.env.GATE6C0A_RUN ? path.resolve(process.env.GATE6C0A_RUN) : path.resolve(root, '..', 'architect-mc-0a-run');
const DEV_PORT = Number(process.env.ARCHITECT_DEV_PORT || 8903);
const SC_PORT = Number(process.env.ARCHITECT_PORT || 8902);
const GAME_DIR = path.join(RUN, 'mod', 'run');
const SAVES = path.join(GAME_DIR, 'saves');
const SC_LOG = path.join(GAME_DIR, 'architect', 'sidecar-data', 'logs', 'sidecar.log');
const OWNER = 'apitest:village/1';
let dev = null;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`);

async function connect(timeoutMs = 600_000) {
  const { DevClient } = await import('./lib/devclient.mjs');
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const token = fs.readFileSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), 'utf8').trim();
      dev = await DevClient.connect({ port: DEV_PORT, token, timeoutMs: 20_000 });
      return dev;
    } catch (e) {
      last = e;
      await sleep(2000);
    }
  }
  throw new Error(`no DevBridge on ${DEV_PORT}: ${last}`);
}
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const cmd = (c) => call('dev.command', { cmd: c }, 120_000);
async function api(args) {
  const r = await cmd(`/apitest ${args}`);
  const line = (r.messages ?? []).find((m) => m.startsWith('{') || m.startsWith('[') || m === 'null' || m.startsWith('"'));
  if (line === undefined) throw new Error(`/apitest ${args.slice(0, 200)}: no JSON answer: ${JSON.stringify(r).slice(0, 500)}`);
  return JSON.parse(line);
}
/** An async step's value (or {error, reason}). */
async function result(pending, timeoutMs = 120_000) {
  const key = pending?.pending;
  if (!key) return pending;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api(`get ${key}`);
    if (r.value !== undefined && r.value !== null) return r.value;
    await sleep(400);
  }
  throw new Error(`timed out (${timeoutMs} ms) waiting for ${key}`);
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const settle = (ms = 3000) => call('dev.wait', { ms }, ms + 20_000);
async function until(f, what, timeoutMs = 120_000, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await f();
    if (last) return last;
    await sleep(stepMs);
  }
  throw new Error(`timed out (${timeoutMs} ms): ${what}`);
}

function clientPids() {
  try {
    return execFileSync('pgrep', ['-f', `${path.basename(RUN)}/mod/.gradle/loom-cache/launch.cfg`]).toString().trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
let clientEnv = {};
async function startClient(world, env = {}) {
  if (clientPids().length) throw new Error(`a client of ${RUN} runs already: ${clientPids()}`);
  clientEnv = env;
  const opts = path.join(GAME_DIR, 'options.txt');
  if (fs.existsSync(opts)) fs.writeFileSync(opts, fs.readFileSync(opts, 'utf8').replace(/^enableVsync:true$/m, 'enableVsync:false'));
  fs.rmSync(path.join(GAME_DIR, 'architect', 'devbridge.token'), { force: true });
  const out = fs.openSync(path.join(OUT, 'client.log'), 'a');
  const p = spawn(path.join(RUN, 'tools', 'run-gate6c0a-client.sh'), [], { cwd: RUN, detached: true, stdio: ['ignore', out, out],
    env: { ...childEnv(), ARCHITECT_PORT: String(SC_PORT), ARCHITECT_DEV_PORT: String(DEV_PORT), ARCHITECT_AUTOWORLD_NAME: world, ARCHITECT_AUTOWORLD_PRESET: 'flat',
      ARCHITECT_AUTOWORLD_MODE: 'creative', ARCHITECT_AUTOWORLD_CHEATS: 'true', ...env } });
  p.unref();
  await connect(900_000);
  await waitInWorld();
  await until(async () => (await call('dev.launcher.state')).state === 'running', 'the helper running', 300_000);
  await until(async () => (await call('dev.sidecar.state')).status?.auth === 'ok', 'the helper linked', 120_000);
  log(`client up (pid ${clientPids()}) in ${world}`);
}
async function waitInWorld(timeoutMs = 900_000) {
  await until(async () => {
    const st = await call('dev.state').catch(() => ({}));
    return st.inWorld && st.ready;
  }, 'in a world', timeoutMs);
  await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
  await sleep(2000);
}
async function stopClient() {
  const pids = clientPids();
  if (!pids.length) return;
  try {
    await dev?.call('dev.quit', {}, { timeoutMs: 30_000 });
  } catch {
    // gone already
  }
  for (let i = 0; i < 120 && clientPids().length; i++) await sleep(1000);
  for (const pid of clientPids()) if (pids.includes(pid)) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60 && clientPids().length; i++) await sleep(1000);
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
}
/** A crash: SIGKILL to this run's client JVM (by its PID). */
async function killClient() {
  const pids = clientPids();
  for (const pid of pids) {
    log(`SIGKILL my client pid ${pid}`);
    process.kill(pid, 'SIGKILL');
  }
  for (let i = 0; i < 60 && clientPids().length; i++) await sleep(500);
  try {
    dev?.close();
  } catch {
    // closed
  }
  dev = null;
  // the helper outlives a killed game (its parent-pid watch stops it within ~5 s)
  await sleep(8000);
}
async function restart(world, env = clientEnv) {
  await stopClient();
  await startClient(world, env);
}
const events = async () => api('events');
async function groundAt(x, z) {
  const s = await result(await api(`survey ${x} ${z} ${x} ${z} 1`));
  const m = /h(-?\d+)/.exec(s.columns?.[0] ?? '');
  return m ? Number(m[1]) : -61;
}
const scLog = () => (fs.existsSync(SC_LOG) ? fs.readFileSync(SC_LOG, 'utf8') : '');
const groupReq = (name, items, o = {}) => ({ name, bible: o.bible ?? 'birch', owner: o.owner ?? OWNER, items, ...o });
const it3 = () => [
  { itemKey: 'a', type: 'cabin', style: 'rustic', size: [32, 48, 32] },
  { itemKey: 'b', type: 'tavern', style: 'rustic', size: [32, 48, 32] },
  { itemKey: 'c', type: 'tower', style: 'rustic', size: [32, 48, 32] },
];
const final = (s) => ['DONE', 'FAILED', 'CANCELLED'].includes(s);
async function waitGroup(id, pred, what, timeoutMs = 180_000) {
  return until(async () => {
    const g = await api(`group0a ${id}`);
    return g && pred(g) ? g : null;
  }, what, timeoutMs);
}
async function waitBible(job, timeoutMs = 120_000) {
  return until(async () => {
    const j = await api(`biblejob ${job}`);
    return j && ['DONE', 'FAILED', 'CANCELLED'].includes(j.status) ? j : null;
  }, `bible job ${job}`, timeoutMs);
}
async function waitBatch(id, timeoutMs = 300_000) {
  return until(async () => {
    const b = await api(`batch ${id}`);
    return b && b.status && b.status !== 'RUNNING' ? b : null;
  }, `batch ${id}`, timeoutMs, 2000);
}
let nKey = 0;
const nk = (p) => `${p}${Date.now().toString(36)}${++nKey}`;

/**
 * Items 1 (in game), 2, 6, 7: the Steward-style flow on this build as a consumer runs it (bundled helper, sim, measured costs):
 * a bible, a 3-item massingFirst group with approvalUi owner, one redirect, a client restart while awaiting approval (re-read, nothing
 * re-fires), approve, the details, a batch of the 3, then undo. The breakdown, seq, GROUP_AWAITING_APPROVAL once per massing round,
 * the log line, the notional cost inside the estimate band. Then the 6b live-run case: a $5 budget, no re-sent awaiting_approval /
 * paused_budget while an action is in flight.
 */
steps.flow = async () => {
  const W = 'G6C0A Flow';
  fs.rmSync(path.join(SAVES, W), { recursive: true, force: true });
  await startClient(W, { ARCHITECT_SIM_COSTS: 'measured' });
  const out = {};
  const v = await api('api110');
  check(v.version === '1.10.0', `ArchitectApi.VERSION ${v.version}; the last Reasons ${v.lastReasons}`);
  const est = await result(await api(`estmix f ${b64({ originals: 3, newBible: true, massingFirst: true })}`));
  out.estimate = est;
  const sumKinds = Object.values(est.byKind ?? {}).reduce((a, l) => a + l.usdLow, 0);
  check(Math.abs(sumKinds - est.usdLow) < 0.02 && est.byKind?.BIBLE && est.byKind?.ORIGINAL, `estimate(EstimateRequest): $${est.usdLow}-${est.usdHigh}, the byKind lines sum to the totals (${JSON.stringify(est.byKind)})`);
  await api('clear');
  const bj = await result(await api(`opbible fb flow:bible:${nk('')} ${b64({ prompt: 'a riverside mill town', name: 'Flow Mill' })}`));
  const bdone = await waitBible(bj.id);
  check(bdone.status === 'DONE' && Math.abs(bdone.cost.usd - 1.35) < 1e-6, `a bible (${bdone.id} ${bdone.bible?.id}): done, notional $${bdone.cost.usd}`);
  const gid = await result(await api(`opgroup fg flow:group:${nk('')} ${b64(groupReq('Flow Hamlet', it3(), { bible: bdone.bible.id, massingFirst: true, approvalUi: 'owner' }))}`));
  let g1 = await waitGroup(gid, (g) => g.status === 'AWAITING_APPROVAL', 'awaiting approval (round 1)');
  const awaitN = async () => (await events()).filter((e) => e.event === 'GROUP_AWAITING_APPROVAL' && e.id === gid).length;
  check((await awaitN()) === 1, `GROUP_AWAITING_APPROVAL once for massing round 1 (${await awaitN()})`);
  const red = await result(await api(`approve fr ${gid} ${b64({ redirect: { a: 'a longer mill hall' }, owner: OWNER })}`));
  check(!red.error, `redirect item a (${JSON.stringify(red).slice(0, 160)})`);
  await waitGroup(gid, (g) => g.status === 'AWAITING_APPROVAL' && g.seq > g1.seq + 1 && g.lastAction !== 'redirected', 'awaiting approval (round 2)', 180_000);
  await settle(2000);
  check((await awaitN()) === 2, `GROUP_AWAITING_APPROVAL once per massing round: 2 after the redirect (${await awaitN()})`);
  const evBefore = (await events()).filter((e) => e.event === 'GROUP_UPDATED' && e.id === gid).map((e) => e.seq);
  // the client restarts while awaiting approval
  const before = await api(`group0a ${gid}`);
  await restart(W);
  await settle(8000);
  const after = await api(`group0a ${gid}`);
  const evAfter = (await events()).filter((e) => (e.event === 'GROUP_UPDATED' || e.event === 'GROUP_AWAITING_APPROVAL') && e.id === gid);
  check(after.status === 'AWAITING_APPROVAL' && after.seq === before.seq && evAfter.length === 0, `a client restart while awaiting approval: the group is re-read (${after.status}, seq ${after.seq} = ${before.seq}) and nothing re-fires (${evAfter.length} GROUP_UPDATED/AWAITING events)`, evAfter);
  await result(await api(`approve fa ${gid} ${b64({ approve: ['a', 'b', 'c'], owner: OWNER })}`));
  const done = await waitGroup(gid, (g) => final(g.status), 'the details', 300_000);
  check(done.status === 'DONE' && done.items.every((i) => i.status === 'DONE' && i.entryId), `the details: the group is DONE (${done.items.map((i) => i.entryId).join(', ')})`);
  const seqs = [...evBefore, ...(await events()).filter((e) => e.event === 'GROUP_UPDATED' && e.id === gid).map((e) => e.seq)];
  const strictly = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  check(strictly && seqs.length > 3, `GROUP_UPDATED: seq strictly increases, no repeats (${seqs.join(',')})`);
  const bd = done.breakdown;
  out.breakdown = bd;
  const st = bd.stages;
  const lines = ['MASSING', 'DETAIL', 'REPAIR', 'CRITIQUE'].reduce((a, k) => a + (st[k]?.usd ?? 0), 0);
  check(['BIBLE', 'MASSING', 'DETAIL', 'REPAIR', 'CRITIQUE', 'QUEUED', 'USAGE_HOLD'].every((k) => st[k]) && Math.abs(bd.totalUsd - (done.cost.usd + st.BIBLE.usd)) < 0.001
    && Math.abs(lines - done.cost.usd) < 0.001 && Math.abs(st.BIBLE.usd - 1.35) < 1e-6 && bd.bibleJobIds.includes(bdone.id),
    `C7: every stage line; totalUsd $${bd.totalUsd} = cost $${done.cost.usd} + bible $${st.BIBLE.usd} (to $0.001); the lines sum to the cost; bible jobs ${bd.bibleJobIds}`);
  check(JSON.stringify(Object.keys(done.costByKind).sort()) === JSON.stringify(['bible', 'critique', 'detail', 'massing']), `costByKind ${JSON.stringify(done.costByKind)}`);
  const logLines = scLog().split('\n').filter((l) => l.includes(`group ${gid} breakdown `));
  check(logLines.length >= 2, `the breakdown log line at awaiting approval and at the end (${logLines.length} lines)`);
  const notional = bd.totalUsd;
  check(notional >= est.usdLow && notional <= est.usdHigh, `the flow's notional cost $${notional} is inside its estimate band $${est.usdLow}-${est.usdHigh}`);
  // a batch of the 3, then undo
  const y = await groundAt(200, 200);
  const items = done.items.map((i, k) => ({ key: i.itemKey, bp: i.entryId, at: [200 + k * 40, y + 1, 200], rot: 0, mode: 'INSTANT', force: true }));
  const bid = await result(await api(`bqueue ${JSON.stringify({ tag: 'flow', proximity: false, owner: OWNER, items })}`));
  await cmd('/tp @s 240 -40 200');
  const bv = await waitBatch(bid);
  check(bv.status === 'DONE' && bv.placed === 3, `a batch of the 3 details: ${bv.status}, ${bv.placed} placed`);
  const un = await result(await api(`sgremove ${bv.group} force`), 300_000);
  check(un.removed === true || (un.removed ?? []).length === 3, `undo: the batch's site group removed (${JSON.stringify(un).slice(0, 160)})`);
  await stopClient();
  return out;
};

/**
 * Item 7's live-run case (6b): measured costs and a $5 budget. The soft pause (80%) comes inside a detail pass; with the sim's step
 * at 2.5 s (config simStepMs, set for this step only) the caller extends and resumes before the hard cap. While extend and resume are
 * in flight nothing re-sends awaiting_approval or paused_budget; seq strictly increases.
 */
steps.budget = async () => {
  const W = 'G6C0A Flow';
  const cfgFile = path.join(GAME_DIR, 'architect', 'sidecar-data', 'config.json');
  const had = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  fs.writeFileSync(cfgFile, JSON.stringify({ ...(had ? JSON.parse(had) : {}), simStepMs: 2500 }));
  const out = {};
  try {
    await startClient(W, { ARCHITECT_SIM_COSTS: 'measured' });
    await api('clear');
    const gid = await result(await api(`opgroup b5 flow:b5:${nk('')} ${b64(groupReq('Budget Five', [it3()[0], it3()[1]], { budgetUsd: 5, concurrency: 1, massingFirst: true, approvalUi: 'owner' }))}`));
    await waitGroup(gid, (g) => g.status === 'AWAITING_APPROVAL', 'the $5 group awaiting approval', 240_000);
    await result(await api(`approve b5a ${gid} ${b64({ approve: ['a', 'b'], owner: OWNER })}`));
    const paused = await until(async () => {
      const g = await api(`group0a ${gid}`);
      return g && (g.status === 'PAUSED_BUDGET' || final(g.status)) ? g : null;
    }, 'paused_budget', 300_000, 250);
    const evs = async () => (await events()).filter((e) => e.id === gid);
    const n0 = (await evs()).length;
    const ex = await result(await api(`groupextend ${gid} 20`));
    const rs = await result(await api(`groupresume ${gid}`));
    const done = await waitGroup(gid, (g) => final(g.status), 'the $5 group', 300_000);
    const e = await evs();
    const resent = e.slice(n0).filter((x) => x.event === 'GROUP_AWAITING_APPROVAL' || (x.event === 'GROUP_UPDATED' && x.status === 'PAUSED_BUDGET'));
    const seqs = e.filter((x) => x.event === 'GROUP_UPDATED').map((x) => x.seq);
    out.paused = paused;
    out.after = { status: done.status, cost: done.cost, lastAction: done.lastAction, seqs, extend: ex, resume: rs };
    check(paused.status === 'PAUSED_BUDGET', `measured costs, a $5 budget: the group pauses (${paused.status}: ${paused.reason})`);
    check(resent.length === 0 && seqs.every((x, k) => k === 0 || x > seqs[k - 1]), `extend and resume in flight: no re-sent awaiting_approval or paused_budget (${resent.length}); seq strictly increasing (${seqs.join(',')})`);
    check(done.status === 'DONE', `extended to $20 and resumed: the group ends ${done.status} at $${done.cost.usd}`);
    await stopClient();
  } finally {
    if (had === null) fs.rmSync(cfgFile, { force: true });
    else fs.writeFileSync(cfgFile, had);
  }
  return out;
};

/** Item 3, in game: fitMassingToLot and a later fitToLot of its detail agree on one lot (same rotation, origin within 2, y equal). */
steps.fit = async () => {
  const W = 'G6C0A Flow';
  await startClient(W, { ARCHITECT_SIM_COSTS: 'measured' });
  const groups = await api('groups apitest:village/1');
  let pair = null;
  for (const id of groups) {
    const g = await api(`group0a ${id}`);
    const it = (g?.items ?? []).find((i) => i.massing && i.entryId && i.status === 'DONE');
    if (it) {
      pair = { massing: it.massing, entry: it.entryId };
      break;
    }
  }
  if (!check(!!pair, `a massing and its detail from the flow (${JSON.stringify(pair)})`)) return {};
  const [mid, mv] = pair.massing.split('@');
  const y = await groundAt(300, 300);
  const lot = [300, y, 300, 331, y + 40, 331].join(',');
  const out = {};
  for (const side of ['north', 'east', 'south', 'west']) {
    const fm = await api(`fitmassing ${mid} ${mv} ${lot} ${side}`);
    const fd = await api(`fit ${pair.entry} ${lot} ${side}`);
    const dx = Math.abs(fm.at[0] - fd.at[0]);
    const dz = Math.abs(fm.at[2] - fd.at[2]);
    out[side] = { massing: fm, detail: fd };
    check(fm.rotation === fd.rotation && dx <= 2 && dz <= 2 && fm.at[1] === fd.at[1], `C6 in game (${side}): fitMassingToLot ${fm.rotation} ${fm.origin} and fitToLot ${fd.rotation} ${fd.origin}: same rotation, |dx| ${dx}, |dz| ${dz}, y equal`);
  }
  const unknown = await api(`fitmassing mas_nope 1 ${lot} north`);
  check(unknown.ok === false && JSON.stringify(unknown.refusals).includes('UNKNOWN_BLUEPRINT'), 'an unknown massing: UNKNOWN_BLUEPRINT');
  await stopClient();
  return out;
};

/** Item 4: durable finished batches (clean stop: still DONE, no re-fire; skipSave + SIGKILL: fires once on load; ids not reused). */
steps.batches = async () => {
  const W = 'G6C0A Batches';
  fs.rmSync(path.join(SAVES, W), { recursive: true, force: true });
  await startClient(W, {});
  const y = await groundAt(0, 0);
  await cmd('/tp @s 20 -40 0');
  const q = async (x) => result(await api(`bqueue ${JSON.stringify({ proximity: false, items: [{ key: 'a', bp: 'cabin', at: [x, y + 1, 0], rot: 0, mode: 'INSTANT', force: true }] })}`));
  const b1 = await q(0);
  await waitBatch(b1);
  await settle(1500);
  const fired1 = (await events()).filter((e) => e.event === 'BATCH_DONE' && e.batch === b1).length;
  await restart(W);
  await settle(5000);
  const v1 = await api(`batch ${b1}`);
  const refired = (await events()).filter((e) => e.event === 'BATCH_DONE' && e.batch === b1).length;
  check(fired1 === 1 && v1.status === 'DONE' && refired === 0, `after a clean stop and load, finished batch ${b1} is still DONE (${v1.status}) and BATCH_DONE does not re-fire (${fired1} before, ${refired} after)`);
  await cmd('/tp @s 60 -40 0');
  const b2 = await q(40);
  await call('dev.batch.skipSave', { batchId: b2 });
  await until(async () => (await events()).some((e) => e.event === 'BATCH_DONE' && e.batch === b2), `BATCH_DONE ${b2}`, 300_000, 200);
  await killClient();
  await startClient(W, {});
  await settle(5000);
  const once = (await events()).filter((e) => e.event === 'BATCH_DONE' && e.batch === b2).length;
  check(once === 1, `dev.batch.skipSave, then the client JVM killed: BATCH_DONE fires once on load for ${b2} (${once})`);
  const b3 = await q(80);
  const num = (id) => Number(/^b(\d+)$/.exec(id)?.[1] ?? NaN);
  check(num(b3) > num(b2) && num(b2) > num(b1), `batch ids are never reused: ${b1}, ${b2}, ${b3} (the b<n> counter is persisted)`);
  await waitBatch(b3);
  await stopClient();
  return { b1, b2, b3 };
};

/** Item 5: operation keys for bibles().request, requestGroup and queue: dropAck, kill, restart, adopt; conflicts; owners; helper down. */
steps.keys = async () => {
  const W = 'G6C0A Keys';
  fs.rmSync(path.join(SAVES, W), { recursive: true, force: true });
  await startClient(W, {});
  const out = {};
  const K = nk('k');
  const breq = { prompt: 'a key town', name: 'Key Town' };
  const greq = groupReq('Key Group', [it3()[0]]);
  const y = await groundAt(0, 0);
  const bspec = (x) => ({ proximity: false, owner: OWNER, opKey: `${K}:batch`, items: [{ key: 'a', bp: 'cabin', at: [x, y + 1, 0], rot: 0, mode: 'INSTANT', force: true }] });
  const counts = async () => ({ bibles: (await api('bibles')).length, jobs: (await api(`groups ${OWNER}`)).length, batches: (await api('batches')).length });
  // send all three with keys, their acks dropped
  await call('dev.api.dropAck', { msgType: 'bible.request' });
  await api(`opbible kb ${K}:bible ${b64(breq)}`);
  await call('dev.api.dropAck', { msgType: 'design.group' });
  await api(`opgroup kg ${K}:group ${b64(greq)}`);
  await sleep(3000);
  const qb = await result(await api(`bqueue ${JSON.stringify(bspec(0))}`));
  await sleep(1500);
  const pend = await api('get opbible:kb');
  check(pend.value === undefined || pend.value === null, `dev.api.dropAck: the bible request future stays pending (its ack dropped): ${JSON.stringify(pend).slice(0, 300)}`);
  await killClient();
  await startClient(W, {});
  const jb = await result(await api(`jobbykey kj ${OWNER} ${K}:bible`));
  const gb = await result(await api(`groupbykey kq ${OWNER} ${K}:group`));
  const bb = await api(`batchbykey ${OWNER} ${K}:batch`);
  check(jb?.id && jb.opKey === `${K}:bible`, `jobByKey adopts the bible job sent before the kill (${jb?.id} ${jb?.status})`);
  check(gb?.id && gb.opKey === `${K}:group`, `groupByKey adopts the group sent before the kill (${gb?.id} ${gb?.status})`);
  check(bb?.batch === qb && bb.opKey === `${K}:batch`, `batchByKey finds the batch (${bb?.batch} = ${qb})`);
  const c0 = await counts();
  const jb2 = await result(await api(`opbible kb2 ${K}:bible ${b64(breq)}`));
  const gb2 = await result(await api(`opgroup kg2 ${K}:group ${b64(greq)}`));
  const qb2 = await result(await api(`bqueue ${JSON.stringify(bspec(0))}`));
  check(jb2.id === jb.id && gb2 === gb.id && qb2 === qb, `a re-request with the same key and body returns the same ids (${jb2.id}, ${gb2}, ${qb2})`);
  const c1 = await counts();
  check(JSON.stringify(c0) === JSON.stringify(c1), `the job, group and batch counts are unchanged (${JSON.stringify(c1)})`);
  const cb = await result(await api(`opbible kb3 ${K}:bible ${b64({ ...breq, prompt: 'another town' })}`));
  const cg = await result(await api(`opgroup kg3 ${K}:group ${b64({ ...greq, name: 'Other' })}`));
  const cq = await result(await api(`bqueue ${JSON.stringify(bspec(40))}`));
  check(cb.reason === 'OP_KEY_CONFLICT' && cg.reason === 'OP_KEY_CONFLICT' && cq.reason === 'OP_KEY_CONFLICT', `a different body gives OP_KEY_CONFLICT (bible ${cb.reason}, group ${cg.reason}, batch ${cq.reason})`);
  const ob = await result(await api(`opbible kb4 ${K}:bible ${b64({ ...breq, owner: 'other:mod' })}`));
  const oq = await result(await api(`bqueue ${JSON.stringify({ ...bspec(80), owner: 'other:mod' })}`));
  check(ob.id && ob.id !== jb.id && oq && oq !== qb, `another owner's key is a separate operation (bible ${ob.id}, batch ${oq})`);
  // the helper down: its pid from the launcher, killed (it is this run's own helper)
  const ls = await call('dev.launcher.state');
  out.helperPid = ls.pid;
  if (ls.pid) process.kill(ls.pid, 'SIGKILL');
  await until(async () => (await call('dev.sidecar.state')).connected === false || (await call('dev.launcher.state')).state !== 'running', 'the helper down', 60_000);
  const lj = await result(await api(`jobbykey kd ${OWNER} ${K}:bible`));
  const lg = await result(await api(`groupbykey kd2 ${OWNER} ${K}:group`));
  check(lj.reason === 'SIDECAR_UNAVAILABLE' && lg.reason === 'SIDECAR_UNAVAILABLE', `a lookup with the helper down gives SIDECAR_UNAVAILABLE (${lj.reason}, ${lg.reason})`);
  // item 8 with the helper down: cancelJob fails SIDECAR_UNAVAILABLE
  const cd = await result(await api(`canceljob kc ${jb.id}`));
  check(cd.reason === 'SIDECAR_UNAVAILABLE', `cancelJob with the helper down: ${cd.reason ?? JSON.stringify(cd)}`);
  await call('dev.launcher.restart');
  await until(async () => (await call('dev.launcher.state')).state === 'running', 'the helper back', 300_000);
  await stopClient();
  return out;
};

/** Item 8: Bibles.cancelJob: completes CANCELLED, BIBLE_DONE once, a second cancel fails "already cancelled". */
steps.cancel = async () => {
  const W = 'G6C0A Keys';
  await startClient(W, {});
  await api('clear');
  const j = await result(await api(`bible kcb ${b64({ prompt: 'a slow town', name: 'Slow Town' })}`));
  const c = await result(await api(`canceljob kc1 ${j.id}`));
  await settle(3000);
  const done = (await events()).filter((e) => e.event === 'BIBLE_DONE' && e.id === j.id);
  check(c.status === 'CANCELLED' && done.length === 1, `cancelJob completes CANCELLED (${c.status}); BIBLE_DONE fired once (${done.length})`);
  const c2 = await result(await api(`canceljob kc2 ${j.id}`));
  check(/already cancelled/.test(c2.error ?? ''), `a second cancel fails "already cancelled" (${c2.error})`);
  await stopClient();
  return {};
};

/** Item 9: caller pins (a pinned v1 survives a forced-age GC; unpinned it goes; two owners: it stays until both unpin). */
steps.pins = async () => {
  const W = 'G6C0A Flow';
  // an entry with an older version: the seeded library's g5b_cap (v1 and its head v2; no site in this world stands at either)
  const entry = process.env.GATE6C0A_PIN_ENTRY ?? 'g5b_cap';
  const lib = path.join(GAME_DIR, 'architect', 'library', entry);
  if (!check(fs.existsSync(path.join(lib, 'versions', '1')) && fs.existsSync(path.join(lib, 'versions', '2')), `${entry} has v1 and v2 (version folders in ${path.relative(RUN, lib)})`)) return {};
  await startClient(W, {});
  await result(await api(`pin p1 ${entry} 1 steward:s1`));
  await result(await api(`pin p2 ${entry} 1 steward:s2`));
  const owners = await api(`pinowners ${entry} 1`);
  check(JSON.stringify(owners) === JSON.stringify(['steward:s1', 'steward:s2']), `pinOwners ${JSON.stringify(owners)}`);
  const gone = await result(await api(`pin p3 nope_entry 1 steward:s1`));
  check(gone.reason === 'VERSION_GONE', `pinning an unknown version: ${gone.reason}`);
  // a forced-age GC: v1's createdAt in the entry's lineage set to the epoch, then the helper restarts (GC runs at its start)
  const forceAgeAndGc = async () => {
    const lp = await call('dev.launcher.state');
    if (lp.pid) process.kill(lp.pid, 'SIGKILL');
    await sleep(3000);
    const jf = path.join(GAME_DIR, 'architect', 'library', entry, `${entry}.blueprint.json`);
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    for (const l of j.lineage ?? j.versions ?? []) if (l.n === 1 || l.version === 1) l.createdAt = 1;
    fs.writeFileSync(jf, JSON.stringify(j, null, 2));
    await call('dev.launcher.restart');
    await until(async () => (await call('dev.launcher.state')).state === 'running', 'the helper back', 300_000);
    await settle(4000);
    return fs.existsSync(path.join(GAME_DIR, 'architect', 'library', entry, 'versions', '1'));
  };
  check(await forceAgeAndGc(), `pinned by two owners, v1 survives a forced-age GC`);
  await result(await api(`unpin u1 ${entry} 1 steward:s1`));
  check(await forceAgeAndGc(), `one owner unpinned: v1 still survives (the other pin holds it)`);
  await result(await api(`unpin u2 ${entry} 1 steward:s2`));
  await result(await api(`unpin u3 ${entry} 1 steward:s2`));
  check(!(await forceAgeAndGc()), `both unpinned (unpin is idempotent): v1 is collected by the forced-age GC`);
  await stopClient();
  return { entry };
};

/** Item 10: WORLD_STOPPED (a pending removeGroup / queue cancel, a realise, a Survey.volume and an unacked requestGroup). */
steps.stopped = async () => {
  const W = 'G6C0A Stop';
  fs.rmSync(path.join(SAVES, W), { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', path.join(SAVES, 'G6A Flat Base Prepared'), path.join(SAVES, W)]);
  fs.rmSync(path.join(SAVES, W, 'session.lock'), { force: true });
  await startClient(W, {});
  const K = nk('ws');
  await cmd('/tp @s 0.5 120 0.5');
  const p = await call('dev.region.plan', { program: 'region_small', claim: [-96, -96, 95, 95], surveyLoad: 'generated:64', check: false }, 600_000);
  const pend = {};
  pend.realise = await api(`rrealise ${JSON.stringify({ planId: p.planId, tag: K, lots: {} })}`).catch((e) => ({ error: String(e) }));
  pend.volume = await api(`volume vs -300 -64 -300 300 120 300`).catch((e) => ({ error: String(e) }));
  const y = await groundAt(300, 300);
  const many = Array.from({ length: 40 }, (_, k) => ({ key: `i${k}`, bp: 'tower', at: [300 + (k % 8) * 30, y + 1, 300 + Math.floor(k / 8) * 30], rot: 0, mode: 'CONSTRUCTION', force: true }));
  const qb = await result(await api(`bqueue ${JSON.stringify({ proximity: false, items: many })}`));
  pend.cancelBatch = await api(`bcancel ${qb}`);
  await call('dev.api.dropAck', { msgType: 'design.group' });
  pend.group = await api(`opgroup wg ${K} ${b64(groupReq('Stop Group', [it3()[0]]))}`);
  const n = await call('dev.api.pending');
  log(`  pending API futures before the stop: ${n.pending}; ${JSON.stringify(pend).slice(0, 400)}`);
  await call('dev.world.leave', {}, 300_000);
  await until(async () => !(await call('dev.state')).inWorld, 'out of the world', 120_000);
  await call('dev.world.open', { name: W }, 30_000);
  await waitInWorld();
  const res = {};
  for (const k of ['realise', 'volume', 'cancelBatch', 'group']) {
    const key = pend[k]?.pending;
    res[k] = key ? (await api(`get ${key}`)).value : pend[k];
  }
  log(`  after the stop: ${JSON.stringify(res).slice(0, 600)}`);
  // a future that completed before the stop (the realise answers its region id at once) is not pending; every other failed WORLD_STOPPED
  const stopped = Object.entries(res).filter(([, v]) => v?.reason === 'WORLD_STOPPED').map(([k]) => k);
  const otherFail = Object.entries(res).filter(([, v]) => v?.error && v?.reason !== 'WORLD_STOPPED').map(([k]) => k);
  const stillPending = Object.entries(res).filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  check(res.group?.reason === 'WORLD_STOPPED', `the unacked requestGroup failed WORLD_STOPPED (${JSON.stringify(res.group)})`);
  check(otherFail.length === 0 && stillPending.length === 0 && stopped.length >= 2, `every future pending at the stop failed with reason() == WORLD_STOPPED (${stopped.join(', ')}; completed before the stop: ${Object.keys(res).filter((k) => !stopped.includes(k)).join(', ') || '-'})`, res);
  const g = await result(await api(`groupbykey wk ${OWNER} ${K}`));
  check(g?.id && g.opKey === K, `after the next load the group is found by its key (${g?.id})`);
  await stopClient();
  return res;
};

/** Item 11 in game: a small region with SLOW_TILES=4 ends PLACED with the unhooked run's sha, shows TILE_SLOW, RETRY works; =2 passes inside the retries. */
steps.tiles = async () => {
  const out = {};
  const runOnce = async (n) => {
    const W = `G6C0A Tiles ${n}`;
    fs.rmSync(path.join(SAVES, W), { recursive: true, force: true });
    execFileSync('cp', ['-c', '-R', path.join(SAVES, 'G6A Flat Base Prepared'), path.join(SAVES, W)]);
    fs.rmSync(path.join(SAVES, W, 'session.lock'), { force: true });
    await startClient(W, n ? { ARCHITECT_TEST_SLOW_TILES: String(n) } : {});
    await cmd('/gamemode spectator');
    await cmd('/tp @s 0.5 120 0.5 0 30');
    await call('dev.waitChunks', { timeoutMs: 60_000 }, 90_000).catch(() => {});
    const p = await call('dev.region.plan', { program: 'region_small', claim: [-96, -96, 95, 95], surveyLoad: 'generated:64', check: false }, 600_000);
    const y = p.claimY ?? [-64, 319];
    const box = [-104, y[0] - 8, -104, 103, y[1] + 8, 103];
    const r = await call('dev.region.realise', { planId: p.planId, lotEntries: ['cabin', 'gatehouse', 'tavern', 'tower'], fitLots: true }, 300_000);
    let sawSlow = false;
    let nudged = null;
    const end = Date.now() + 3_600_000;
    let st;
    while (Date.now() < end) {
      st = await call('dev.region.state', { region: r.region }, 60_000);
      const waits = JSON.stringify(st.waiting ?? st.unfinished ?? '');
      if (/TILE_SLOW/.test(waits) || (st.actions ?? []).some((a) => a.kind === 'RETRY')) {
        sawSlow = true;
        if (!nudged) nudged = await call('dev.region.nudge', { region: r.region, action: 'RETRY' }, 60_000);
      }
      if (['PLACED', 'PARTIAL', 'FAILED'].includes(st.view.state)) break;
      await sleep(3000);
    }
    const h = await call('dev.region.hash', { box }, 3_600_000);
    await stopClient();
    return { state: st.view.state, sha: h.sha256, sawSlow, nudged };
  };
  out.unhooked = await runOnce(0);
  out.slow4 = await runOnce(4);
  out.slow2 = await runOnce(2);
  check(out.unhooked.state === 'PLACED', `the unhooked run: ${out.unhooked.state} (sha ${out.unhooked.sha?.slice(0, 12)})`);
  check(out.slow4.state === 'PLACED' && out.slow4.sha === out.unhooked.sha, `SLOW_TILES=4: ${out.slow4.state} with the unhooked run's sha (${out.slow4.sha?.slice(0, 12)})`);
  check(out.slow4.sawSlow && out.slow4.nudged?.done === true, `SLOW_TILES=4: TILE_SLOW shown with RETRY, and RETRY works (${JSON.stringify(out.slow4.nudged)})`);
  check(out.slow2.state === 'PLACED' && out.slow2.sha === out.unhooked.sha && !out.slow2.sawSlow, `SLOW_TILES=2: passes inside the helper's retries (${out.slow2.state}, no TILE_SLOW)`);
  return out;
};

if (!steps[step]) {
  console.error(`usage: node tools/gate6c0a.mjs ${Object.keys(steps).join('|')} [...]`);
  process.exit(2);
}
const t0 = Date.now();
const data = await steps[step]().catch((e) => (check(false, `${step}: ${e.stack ?? e}`), {}));
fs.writeFileSync(path.join(OUT, `${step}.json`), JSON.stringify({ step, at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), failures, results, data }, null, 2));
fs.writeFileSync(path.join(OUT, 'spend.json'), JSON.stringify({ usd: 0, note: 'sim/stub only, no Claude calls' }, null, 2));
console.log(`${failures ? 'FAIL' : 'PASS'} gate6c0a ${step}: ${Object.keys(results).length - failures}/${Object.keys(results).length} ok (evidence ${path.join(OUT, `${step}.json`)})`);
process.exit(failures ? 1 : 0);
