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
  const jar = path.resolve(opt('jar', path.join(root, 'mod', 'build', 'libs', `architect_mc-${ver}.jar`)));
  const port = Number(opt('port', '8902'));
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
