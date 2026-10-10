#!/usr/bin/env node
// Phase 6c slice 0b §6: the C7 benchmark (PAID, Noah's claude login only, hard cap $35). Which stage to cut, and how far copies
// and SMALL get toward Steward's targets (a starter settlement under $5, the first usable result within 15 min).
//
//   node tools/bench6c0b.mjs run [--arms U,R,C13] [--port 8908]
//   node tools/bench6c0b.mjs plan            prints the arms, caps and the spend so far; runs nothing
//
// It starts its own sidecar (this worktree's, `--use-claude-login`, port 8908, data in artifacts/gate6c0b/bench/) and drives it
// over the protocol as a consumer does: per arm a NEW bible (capped), then the group (its budget = the arm's cap minus the
// bible's actual cost), auto-approving massings and auto-resuming soft pauses, so only the hard cap stops a group. C13: one
// versionOf on R's first archetype (no site: the bench runs without a game; see HANDOFF-0b deviations).
//
// Safety: refuses to start with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN / AWS_BEARER_TOKEN_BEDROCK set,
// scrubs ANTHROPIC_* from the sidecar's env, logs the auth mode at each paid step and stops unless it is the claude login.
// Before each paid step: spent (spend.json, actual) + the step's cap must stay <= $35. A usage-limit hold is waited out; a
// hold over 30 minutes stops the run (state kept, exit 4) so the builder can commit, push and report.
//
// Evidence: artifacts/gate6c0b/bench-<arm>.json (the 0a Breakdown per stage, totalUsd, wallMs, firstDetailedMs, usd per
// placement, each item's kind and effort, repair rounds, fallbacks, previews), spend.json, bench.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const OUT = process.env.GATE6C0B_OUT ? path.resolve(process.env.GATE6C0B_OUT) : path.join(MAIN, 'artifacts', 'gate6c0b');
const BENCH = path.join(OUT, 'bench');
fs.mkdirSync(BENCH, { recursive: true });
const CAP = 35;
const HOLD_MAX_MS = 30 * 60_000;
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const PORT = Number(opt('port', 8908));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'bench.log'), `${line}\n`);
};
const r6 = (n) => Math.round(n * 1e6) / 1e6;

// ---- the arms (§6) --------------------------------------------------------------------------------

const M = { x: 17, y: 18, z: 15 };
const S = { x: 11, y: 12, z: 9 };
const item = (itemKey, type, size, o = {}) => ({ itemKey, type, style: 'weathered coastal', features: [], maxSize: size, ...o });
const ARMS = {
  U: {
    title: 'unique (Greywater-like)',
    capUsd: 18,
    bible: { prompt: 'Greywater: a weathered fishing hamlet of grey fieldstone, tarred dark timber and slate roofs on a cold northern shore', name: 'Greywater U' },
    group: (bible) => ({ name: 'Bench U', bible, massingFirst: true, approvalUi: 'owner', owner: 'bench:6c0b', critique: { mode: 'report' }, items: [item('tavern', 'tavern', M, { role: 'landmark', anchor: true }), item('house', 'house', M), item('smithy', 'smithy', M)] }),
  },
  R: {
    title: 'repeat-heavy',
    capUsd: 14,
    bible: { prompt: 'Saltmere: a weathered fishing village of grey fieldstone, tarred dark timber and slate roofs on a cold northern shore', name: 'Saltmere R' },
    group: (bible) => ({
      name: 'Bench R',
      bible,
      massingFirst: true,
      approvalUi: 'owner',
      owner: 'bench:6c0b',
      critique: { mode: 'report' },
      smallBySize: true,
      items: [item('house', 'house', M, { count: 3 }), item('workshop', 'shop', M, { count: 3 }), item('shed', 'custom', S, { name: 'Net shed', notes: 'a fisherman\'s net shed', profile: ['door', 'lit', 'no_floating'] }), item('well', 'custom', S, { name: 'Village well', notes: 'the village well, roofed', profile: ['no_floating'] })],
    }),
  },
  C13: { title: 'C13 smoke: versionOf on R\'s first archetype', capUsd: 3 },
};
const BIBLE_CAP = 2.5;

// ---- spend.json ----------------------------------------------------------------------------------

const SPEND = path.join(OUT, 'spend.json');
const spend = () => (fs.existsSync(SPEND) ? JSON.parse(fs.readFileSync(SPEND, 'utf8')) : { totalUsd: 0, capUsd: CAP, steps: [] });
const saveSpend = (s) => {
  s.totalUsd = r6(s.steps.reduce((a, x) => a + (x.usd ?? 0), 0));
  s.capUsd = CAP;
  fs.writeFileSync(SPEND, `${JSON.stringify(s, null, 2)}\n`);
};
/** Before a paid step: spent + cap <= $35, and the auth is the claude login. */
function beforePaid(name, capUsd, auth) {
  const s = spend();
  const spent = s.steps.reduce((a, x) => a + (x.usd ?? 0), 0);
  log(`paid step ${name}: cap $${capUsd}, spent $${spent.toFixed(4)}, auth ${JSON.stringify(auth)}`);
  if (!/claude login/i.test(auth?.authSource ?? '') || /api key|bedrock|vertex/i.test(auth?.authSource ?? '') || auth?.auth !== 'ok') throw new Error(`refusing ${name}: the helper is not on the claude login (${JSON.stringify(auth)})`);
  if (spent + capUsd > CAP + 1e-9) throw new Error(`refusing ${name}: spent $${spent.toFixed(2)} + its cap $${capUsd} would pass the $${CAP} cap`);
  s.steps.push({ name, capUsd, startedAt: new Date().toISOString(), usd: 0, auth: auth.authSource });
  saveSpend(s);
}
function recordPaid(name, usd) {
  const s = spend();
  const st = [...s.steps].reverse().find((x) => x.name === name);
  st.usd = r6(usd);
  st.endedAt = new Date().toISOString();
  saveSpend(s);
}

// ---- the sidecar ---------------------------------------------------------------------------------

let proc;
async function startSidecar() {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']) if (process.env[k]) throw new Error(`refusing: ${k} is set (the bench runs on the claude login only)`);
  const data = path.join(BENCH, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.rmSync(path.join(data, 'client.token'), { force: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ANTHROPIC_/.test(k)));
  const out = fs.openSync(path.join(BENCH, 'sidecar.log'), 'a');
  proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', '--port', String(PORT), '--data', data, '--library', path.join(BENCH, 'library'), '--kit', path.join(root, 'kit'), '--bibles', path.join(BENCH, 'bibles'), '--massings', path.join(BENCH, 'massings'), '--use-claude-login'], { cwd: path.join(root, 'sidecar'), env, stdio: ['ignore', out, out] });
  log(`sidecar pid ${proc.pid} on ${PORT}`);
  fs.writeFileSync(path.join(BENCH, 'sidecar.pid'), String(proc.pid));
  for (let i = 0; i < 300 && !fs.existsSync(path.join(data, 'client.token')); i++) await sleep(200);
  return data;
}
async function stopSidecar() {
  if (!proc || proc.exitCode !== null) return;
  const done = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM'); // our own child, by its handle
  await Promise.race([done, sleep(20_000)]);
}

class Conn {
  static async open(port, dataDir) {
    const token = fs.readFileSync(path.join(dataDir, 'client.token'), 'utf8').trim();
    const c = new Conn();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    c.msgs = [];
    c.n = 0;
    c.groups = new Map();
    c.designs = new Map();
    c.bibleJobs = new Map();
    c.status = null;
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'group.upsert') c.groups.set(m.group.id, m.group);
      else if (m.type === 'design.upsert') c.designs.set(m.design.id, m.design);
      else if (m.type === 'bible.upsert' && m.bible) c.bibleJobs.set(m.bible.id, m.bible);
      else if (m.type === 'status') c.status = m.status;
      else if (m.type === 'snapshot') {
        c.status = m.status ?? c.status;
        for (const g of m.groups ?? []) c.groups.set(g.id, g);
        for (const d of m.designs ?? []) c.designs.set(d.id, d);
      } else c.msgs.push(m);
    };
    await new Promise((res, rej) => ((c.ws.onopen = res), (c.ws.onerror = rej)));
    c.ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'bench6c0b', token, protocols: [2] }));
    for (let i = 0; i < 100 && !c.status; i++) await sleep(100);
    return c;
  }
  async send(o) {
    const id = `b${++this.n}`;
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

// ---- one arm -------------------------------------------------------------------------------------

async function waitBible(c, jobId) {
  let heldSince;
  for (;;) {
    const j = c.bibleJobs.get(jobId);
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) return j;
    const limited = c.status?.limitUntil && c.status.limitUntil > Date.now();
    if (limited) {
      heldSince ??= Date.now();
      if (Date.now() - heldSince > HOLD_MAX_MS) throw Object.assign(new Error('usage-limit hold over 30 min (bible)'), { held: true });
    } else heldSince = undefined;
    await sleep(5000);
  }
}

async function runGroupArm(c, name, arm) {
  const t0 = Date.now();
  // the bible (capped), counted in the arm
  beforePaid(`${name}:bible`, BIBLE_CAP, c.auth());
  const bj = await c.send({ type: 'bible.request', request: { ...arm.bible, owner: 'bench:6c0b', budgetUsd: BIBLE_CAP } });
  const bible = await waitBible(c, bj.jobId);
  recordPaid(`${name}:bible`, bible.cost?.usd ?? 0);
  log(`${name}: bible ${bj.bibleId} v${bj.version} ${bible.status} $${(bible.cost?.usd ?? 0).toFixed(4)} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (bible.status !== 'done') throw new Error(`${name}: the bible ${bible.status}: ${bible.error ?? ''}`);
  // the group: its budget is the arm's cap minus the bible's actual cost
  const budget = r6(Math.max(0.5, arm.capUsd - (bible.cost?.usd ?? 0)));
  beforePaid(`${name}:group`, budget, c.auth());
  const req = { ...arm.group({ id: bj.bibleId, version: bj.version }), budgetUsd: budget };
  const est = await c.send({ type: 'design.estimate', mix: { group: req, newBible: false, massingFirst: true, reportCritique: true } }).catch((e) => ({ error: e.message }));
  const gr = await c.send({ type: 'design.group', group: req });
  const gid = gr.groupId;
  log(`${name}: group ${gid} (${gr.itemKeys.length} placements), budget $${budget}`);
  const tg = Date.now();
  let heldSince;
  let holdMs = 0;
  let g;
  for (;;) {
    g = c.groups.get(gid);
    if (g && ['done', 'failed', 'cancelled'].includes(g.status)) break;
    if (g?.status === 'awaiting_approval' && g.awaiting?.length) {
      log(`${name}: auto-approve ${g.awaiting.join(', ')}`);
      await c.send({ type: 'group.approve', groupId: gid, approve: g.awaiting, owner: 'bench:6c0b' }).catch((e) => log(`approve: ${e.message}`));
    } else if (g?.status === 'paused_budget') {
      log(`${name}: auto-resume (${g.reason})`);
      await c.send({ type: 'group.resume', groupId: gid }).catch((e) => log(`resume: ${e.message}`));
    } else if (g?.status === 'held_usage') {
      heldSince ??= Date.now();
      if (Date.now() - heldSince > HOLD_MAX_MS) {
        recordPaid(`${name}:group`, g.cost?.usd ?? 0);
        throw Object.assign(new Error(`${name}: usage-limit hold over 30 min`), { held: true });
      }
    } else if (heldSince) {
      holdMs += Date.now() - heldSince;
      heldSince = undefined;
    }
    recordPaid(`${name}:group`, g?.cost?.usd ?? 0);
    await sleep(5000);
  }
  recordPaid(`${name}:group`, g.cost.usd);
  const placements = g.items.length;
  const totalUsd = r6((bible.cost?.usd ?? 0) + g.cost.usd);
  const entries = g.items.filter((i) => i.entryId).map((i) => i.entryId);
  const out = {
    arm: name,
    title: arm.title,
    capUsd: arm.capUsd,
    bible: { id: bj.bibleId, version: bj.version, usd: bible.cost?.usd ?? 0, ms: (bible.updatedAt ?? 0) - (bible.createdAt ?? 0), status: bible.status },
    group: { id: gid, status: g.status, reason: g.reason ?? null, budgetUsd: budget, costUsd: g.cost.usd },
    breakdown: g.breakdown ?? null,
    totalUsd,
    usdPerPlacement: r6(totalUsd / placements),
    wallMs: Date.now() - t0,
    groupWallMs: Date.now() - tg,
    firstDetailedMs: g.breakdown?.firstDetailedMs ?? null,
    firstDetailedFromStartMs: g.breakdown?.firstDetailedMs ? g.breakdown.firstDetailedMs + (tg - t0) : null,
    usageHoldMs: holdMs,
    placements,
    items: g.items.map((i) => ({ itemKey: i.itemKey, kind: i.kind ?? 'original', effort: i.effort ?? 'standard', status: i.status, entryId: i.entryId ?? null, costUsd: i.cost?.usd ?? 0, rounds: i.rounds ?? 0, critique: i.critique ?? null, fallbackReason: i.fallbackReason ?? null, error: i.error ?? null })),
    repairRounds: g.breakdown?.stages?.repair?.count ?? null,
    fallbacks: g.items.filter((i) => i.kind === 'fallback').length,
    previews: entries.map((e) => path.join(BENCH, 'library', e, `${e}.preview-iso.png`)).filter((f) => fs.existsSync(f)),
    estimate: est,
    targets: { usdUnder5: totalUsd < 5, firstUsableUnder15min: g.breakdown?.firstDetailedMs ? g.breakdown.firstDetailedMs + (tg - t0) < 15 * 60_000 : false },
  };
  fs.writeFileSync(path.join(OUT, `bench-${name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  log(`${name}: ${g.status} $${totalUsd} ($${out.usdPerPlacement}/placement), wall ${(out.wallMs / 60000).toFixed(1)} min, first detailed ${out.firstDetailedFromStartMs ? (out.firstDetailedFromStartMs / 60000).toFixed(1) : '-'} min`);
  return out;
}

async function runC13(c) {
  const r = JSON.parse(fs.readFileSync(path.join(OUT, 'bench-R.json'), 'utf8'));
  const arch = r.items.find((i) => i.itemKey === 'house' && i.entryId);
  if (!arch) throw new Error('C13: R has no first archetype entry');
  beforePaid('C13:versionOf', ARMS.C13.capUsd, c.auth());
  const t0 = Date.now();
  const d = await c.send({ type: 'design.request', request: { type: 'house', style: 'weathered coastal', features: [], maxSize: { x: 19, y: 20, z: 17 }, notes: 'weathered, add a lean-to', budgetUsd: ARMS.C13.capUsd, versionOf: { entryId: arch.entryId } } });
  let x;
  for (;;) {
    x = c.designs.get(d.designId);
    if (x && ['done', 'failed', 'cancelled'].includes(x.status)) break;
    recordPaid('C13:versionOf', x?.cost?.usd ?? 0);
    await sleep(5000);
  }
  recordPaid('C13:versionOf', x.cost?.usd ?? 0);
  const out = { arm: 'C13', entryId: arch.entryId, designId: d.designId, status: x.status, step: x.step, error: x.error ?? null, usd: x.cost?.usd ?? 0, ms: Date.now() - t0, rounds: null, note: 'no site (the bench runs without a game)' };
  fs.writeFileSync(path.join(OUT, 'bench-C13.json'), `${JSON.stringify(out, null, 2)}\n`);
  log(`C13: ${x.status} $${out.usd} in ${(out.ms / 60000).toFixed(1)} min`);
}

async function main() {
  const cmd = args[0];
  if (cmd === 'plan') {
    console.log(JSON.stringify({ arms: Object.fromEntries(Object.entries(ARMS).map(([k, a]) => [k, { title: a.title, capUsd: a.capUsd }])), bibleCapInArm: BIBLE_CAP, capUsd: CAP, spent: spend().totalUsd }, null, 2));
    return;
  }
  if (cmd !== 'run') throw new Error('usage: node tools/bench6c0b.mjs run|plan [--arms U,R,C13]');
  const arms = (opt('arms', 'U,R,C13')).split(',');
  const data = await startSidecar();
  try {
    const c = await Conn.open(PORT, data);
    for (let i = 0; i < 120 && c.status?.auth === 'checking'; i++) await sleep(1000);
    log(`auth: ${JSON.stringify(c.auth())}`);
    for (const a of arms) {
      if (a === 'C13') await runC13(c);
      else await runGroupArm(c, a, ARMS[a]);
    }
    log(`done: spent $${spend().totalUsd}`);
  } catch (e) {
    log(`stopped: ${e.message}`);
    process.exitCode = e.held ? 4 : 1;
  } finally {
    await stopSidecar();
  }
}

await main();
