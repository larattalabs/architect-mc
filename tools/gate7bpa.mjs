#!/usr/bin/env node
// Phase 7b slice PA (docs/CONTRACT.md "Phase 7b" §3 row 12, §4 Spend plan, §5 Gates): the phase's only paid batch, one driver. Every paid
// job runs on Noah's claude login only (never an API key), guarded by the PA ledger (tools/lib/pa-ledger.mjs): one phase ledger
// artifacts/7b/spend.json (in the main checkout) plus artifacts/7b/<item>/spend.json, costs from each job's own reported usage; before each
// paid job committed + its cap > $90 refuses and > $60 stops for the coordinator (exit 3, artifacts/7b/STOP.json); a job's budgetUsd is its
// share of the item's cap; at most one retry per item, from the reserve; no paid step in the nightly window (01:30-03:30).
//
//   node tools/gate7bpa.mjs plan                  items, estimates (re-stated after P1), caps, the lot maps, the ledger; runs nothing
//   node tools/gate7bpa.mjs status                the ledger
//   node tools/gate7bpa.mjs p0-standalone         P0 ($0): P1's three designs, P4's arms and R's adaptations on the sim designer (own
//                                                 helper, --backend sim); BRIEF.md diffed site vs plain and images on vs off
//   node tools/gate7bpa.mjs p0-scenario s5|s6     P0 ($0), a gate step (the 6b client up, the sim backend): the P2/P3 lot map on the sim
//   node tools/gate7bpa.mjs p1                    P1 (paid): 3 STANDARD site-aware designs on cliff_face, rift_site, overhang (own
//                                                 helper, --use-claude-login), then a $0 site variant of the cliff design onto cliff_east
//                                                 and the re-statement of P2-P5 and R from P1's measured cost
//   node tools/gate7bpa.mjs p2|p3                 P2/P3 (paid): the run dir's client on the claude login, the scenario's natural run with
//                                                 the PA lot map (tools/lib/scenario-sb.mjs paSiteEntries), the §5 bars and the gallery
//   node tools/gate7bpa.mjs p4                    P4 (paid): S5's 2 archetype requests again, site renders off (own helper); the blind
//                                                 A/B sheet (sides randomised, the key in its own file)
//   node tools/gate7bpa.mjs r                     R (paid): 2 adaptations (versionOf + site) of P1's cliff design, each after its $0
//                                                 site variant, to measure `adapted`
//   node tools/gate7bpa.mjs answer --step <step> --yes|--no --text "<the coordinator's words>"   records the answer to a $60 stop
//
// Ports: 8896 (helper / the client's sidecar), 8897 (DevBridge). The helper and the client never run at once. No Discord, ever.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as P from './lib/pa-ledger.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.resolve(root, '..', 'architect-mc');
const ART = process.env.PA_OUT ? path.resolve(process.env.PA_OUT) : path.join(MAIN, 'artifacts', '7b');
const LEDGER = path.join(ART, 'spend.json');
const RUN = process.env.PA_RUN ? path.resolve(process.env.PA_RUN) : path.resolve(root, '..', 'architect-mc-PA-run');
const SIDECAR_PORT = 8896, DEV_PORT = 8897;
const args = process.argv.slice(2);
const sub = args[0];
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r6 = (n) => Math.round(n * 1e6) / 1e6;
fs.mkdirSync(ART, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  fs.appendFileSync(path.join(ART, 'pa.log'), `${line}\n`);
};
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(o, null, 2)}\n`); };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ---- the sites and the lot maps ---------------------------------------------------------------------------------------------

const FIX = (dir, id) => path.join(root, 'kit', 'test', 'fixtures', dir, id);
/** P1's calibration sites (non-scenario, §4) and their requests: a built-in Style with its parts (bibles cost $0). */
export const P1_SITES = Object.freeze([
  { key: 'cliff', fixture: FIX('site', 'cliff_face'), request: { type: 'house', bible: 'rustic', name: 'PA cliff house', notes: 'A house built onto the cliff face.' } },
  { key: 'span', fixture: FIX('site', 'rift_site'), request: { type: 'house', bible: 'rustic', name: 'PA span house', notes: 'A house spanning the rift.' } },
  { key: 'suspend', fixture: FIX('site', 'overhang'), request: { type: 'house', bible: 'rustic', name: 'PA hanging house', notes: 'A house hanging under the rock overhang.' } },
]);
/** R's adaptations: P1's cliff design into DS's two other cliffs (each after its $0 site variant: Steward's adapt-first order, S-7b-1). */
export const R_SITES = Object.freeze([
  { key: 'owned', fixture: FIX('ds', 'cliff_owned'), source: 'cliff', notes: 'The same house, built into this cliff.' },
  { key: 'east', fixture: FIX('ds', 'cliff_east'), source: 'cliff', notes: 'The same house, built into this cliff.' },
]);
/**
 * The P2/P3 lot maps (the coordinator's reading: S5 has wrap_trunk lots only, so P2's second archetype is another wrap_trunk dwelling of
 * another role). Archetypes A (one row) and B (the other), the landmark L on the middle pair / the hall's west end, every other lot a
 * site variant of the archetype of its own row (the same frame rotation).
 */
export const LOT_MAPS = Object.freeze({
  s5: {
    item: 'P2',
    archetypes: [
      { key: 'A', lot: 'tree_1', request: { buildingType: 'house', style: 'rustic', bible: 'rustic', name: 'PA treehouse home', notes: 'A family home round the tree.' } },
      { key: 'B', lot: 'tree_6', request: { buildingType: 'house', style: 'rustic', bible: 'rustic', name: 'PA treehouse lodge', notes: "A woodcutter's lodge round the tree: a workroom and a sleeping loft." } },
      { key: 'L', lot: 'tree_2', landmark: true, request: { buildingType: 'hall', style: 'rustic', bible: 'rustic', name: 'PA grove hall', notes: "The grove's meeting hall, the village's landmark, round the tree." } },
    ],
    variants: { tree_3: 'A', tree_4: 'B', tree_5: 'B' },
  },
  s6: {
    item: 'P3',
    archetypes: [
      { key: 'A', lot: 'hall_n1', request: { buildingType: 'house', style: 'medieval', bible: 'medieval', name: 'PA carved home', notes: 'A family home carved into the rock.' } },
      { key: 'B', lot: 'hall_s1', request: { buildingType: 'house', style: 'medieval', bible: 'medieval', name: 'PA carved workshop home', notes: "A smith's home carved into the rock: the workshop at the front, the rooms behind." } },
      { key: 'L', lot: 'hall_w', landmark: true, request: { buildingType: 'hall', style: 'medieval', bible: 'medieval', name: 'PA great hall', notes: "The city's great hall carved into the end wall, its landmark." } },
    ],
    variants: { hall_n2: 'A', hall_n3: 'A', hall_s2: 'B', hall_s3: 'B' },
  },
});

/** The PA plan file a scenario run reads (PA_PLAN): the lot map, the item's per-job cap, the ledger, reuse of paid archetypes. */
function scenarioPlan(scn, backend, extra = {}) {
  const m = LOT_MAPS[scn];
  return { item: m.item, backend, ledger: backend === 'claude' ? LEDGER : path.join(ART, 'P0', `sim-ledger-${scn}.json`), opPrefix: `pa-${m.item}-${backend}-${extra.attempt ?? 1}`, capUsd: P.jobShare(m.item), timeoutMin: 45, archetypes: m.archetypes, variants: m.variants, ...extra };
}

// ---- the env and the helper ------------------------------------------------------------------------------------------------

/** No key, the claude login only: refuse when a key variable is set; every child env scrubbed (no ANTHROPIC_* / CLAUDE*). */
function envCheck(step) {
  const keys = P.KEY_VARS.filter((k) => process.env[k]?.trim());
  if (keys.length) throw Object.assign(new Error(`refusing ${step}: ${keys.join(', ')} set (claude login only)`), { code: 2 });
  const env = P.scrubbedEnv();
  const names = P.anthropicNames(env);
  if (names.length) throw Object.assign(new Error(`refusing ${step}: the child env still names anthropic: ${names.join(', ')}`), { code: 2 });
  fs.appendFileSync(path.join(ART, 'auth.log'), `${JSON.stringify({ at: new Date().toISOString(), step, envAnthropic: names, keysInEnv: keys })}\n`);
  return env;
}

class Helper {
  /** Our own sidecar (this worktree's source): `sim` or `claude` (the claude login), its dirs under `dir`, config.json from `config`. */
  static async start(dir, backend, config = {}) {
    const h = new Helper();
    h.dir = dir;
    for (const d of ['data', 'library', 'bibles', 'massings']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.rmSync(path.join(dir, 'data', 'client.token'), { force: true });
    writeJson(path.join(dir, 'data', 'config.json'), config);
    const env = envCheck(`helper:${backend}`);
    const out = fs.openSync(path.join(dir, 'sidecar.log'), 'a');
    const a = ['--import', 'tsx', 'src/main.ts', '--port', String(SIDECAR_PORT), '--data', path.join(dir, 'data'), '--library', path.join(dir, 'library'), '--kit', path.join(root, 'kit'), '--bibles', path.join(dir, 'bibles'), '--massings', path.join(dir, 'massings'), '--parent-pid', String(process.pid), ...(backend === 'sim' ? ['--backend', 'sim'] : ['--backend', 'claude', '--use-claude-login'])];
    h.proc = spawn(process.execPath, a, { cwd: path.join(root, 'sidecar'), env, stdio: ['ignore', out, out] });
    fs.writeFileSync(path.join(dir, 'sidecar.pid'), String(h.proc.pid));
    log(`helper pid ${h.proc.pid} (${backend}) on ${SIDECAR_PORT}, data ${dir}`);
    for (let i = 0; i < 300 && !fs.existsSync(path.join(dir, 'data', 'client.token')); i++) await sleep(200);
    await h.open();
    for (let i = 0; i < 180 && (!h.status || h.status.auth === 'checking'); i++) await sleep(1000);
    log(`helper auth ${JSON.stringify(h.auth())}`);
    return h;
  }
  async open() {
    const token = fs.readFileSync(path.join(this.dir, 'data', 'client.token'), 'utf8').trim();
    this.ws = new WebSocket(`ws://127.0.0.1:${SIDECAR_PORT}`);
    this.msgs = []; this.designs = new Map(); this.follows = new Map(); this.status = null; this.n = 0;
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'design.upsert') this.designs.set(m.design.id, m.design);
      else if (m.type === 'follow.upsert' && m.follow) this.follows.set(m.follow.id, m.follow);
      else if (m.type === 'status') this.status = m.status;
      else if (m.type === 'snapshot') { this.status = m.status ?? this.status; for (const d of m.designs ?? []) this.designs.set(d.id, d); } else this.msgs.push(m);
    };
    await new Promise((res, rej) => ((this.ws.onopen = res), (this.ws.onerror = rej)));
    this.ws.send(JSON.stringify({ v: 1, type: 'hello', client: 'gate7bpa', token, protocols: [2] }));
    for (let i = 0; i < 100 && !this.status; i++) await sleep(100);
  }
  auth() { return { auth: this.status?.auth ?? null, authSource: this.status?.authSource ?? null }; }
  async send(o, ms = 120_000) {
    const id = `pa${++this.n}`;
    this.ws.send(JSON.stringify({ v: 1, id, ...o }));
    for (let i = 0; i < ms / 100; i++) {
      const a = this.msgs.find((m) => m.type === 'ack' && m.re === id);
      if (a) { if (!a.ok) throw Object.assign(new Error(`${o.type}: ${a.error}`), { refused: a.error }); return a.result ?? {}; }
      await sleep(100);
    }
    throw new Error(`no ack for ${o.type}`);
  }
  /** Upload a fixture's frozen volume (as the mod does: kind region.volume) and give the spec its blob id. */
  async site(fixtureDir) {
    const fx = readJson(path.join(fixtureDir, 'site.json'));
    const bytes = fs.readFileSync(path.join(fixtureDir, 'volume.bin'));
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 1 << 20) chunks.push(bytes.subarray(i, i + (1 << 20)).toString('base64'));
    const r = await this.send({ type: 'blob.put', kind: 'region.volume', chunks });
    return { fx, spec: { ...fx.spec, volumeBlobId: r.blobId } };
  }
  async waitDesign(id, ms, onPoll) {
    const t0 = Date.now();
    for (;;) {
      const raw = this.designs.get(id);
      // (the protocol names the installed entry blueprintId)
      const d = raw ? { ...raw, entryId: raw.blueprintId ?? raw.entryId } : undefined;
      if (d && onPoll) onPoll(d);
      if (d && ['done', 'failed', 'cancelled'].includes(d.status)) return d;
      if (Date.now() - t0 > ms) return { ...(d ?? {}), status: 'timeout' };
      await sleep(5000);
    }
  }
  async waitFollow(id, ms = 600_000) {
    const t0 = Date.now();
    for (;;) {
      const f = this.follows.get(id);
      if (f && f.status !== 'running') return f;
      if (Date.now() - t0 > ms) return { id, status: 'timeout' };
      await sleep(1000);
    }
  }
  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    try { this.ws?.close(); } catch { /* closed */ }
    const done = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGTERM'); // our own child, by its handle
    await Promise.race([done, sleep(20_000)]);
  }
}

/** A site-aware design request over the protocol (the size is the lot's). */
function designRequest(spec, fx, req, extra = {}) {
  const [x, y, z] = fx.maxSize ?? [16, 16, 16];
  return { type: req.type, style: req.bible ?? 'rustic', features: [], maxSize: { x: Math.max(3, x), y: Math.max(6, y), z: Math.max(3, z) }, name: req.name, notes: req.notes, bible: req.bible, owner: 'architect:pa', site: spec, ...extra };
}

/** The scratch dir's BRIEF.md and site/ of a design (the helper's data dir). */
const scratchOf = (h, id) => path.join(h.dir, 'data', 'designs', id);
function briefDiff(a, b) {
  const A = fs.existsSync(a) ? fs.readFileSync(a, 'utf8').split('\n') : [];
  const B = fs.existsSync(b) ? fs.readFileSync(b, 'utf8').split('\n') : [];
  const sa = new Set(A), sb = new Set(B);
  return { plus: B.filter((l) => !sa.has(l)), minus: A.filter((l) => !sb.has(l)) };
}
/** Does an installed entry's program declare a fit (a site-aware program a site variant can re-run)? */
function entryFit(library, entryId) {
  const dir = path.join(library, entryId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.mjs')) : [];
  for (const f of files) { const m = /export\s+const\s+fit\s*=\s*['"]([a-z_]+)['"]/.exec(fs.readFileSync(path.join(dir, String(f)), 'utf8')); if (m) return m[1]; }
  return null;
}

// ---- a paid job on the helper ------------------------------------------------------------------------------------------------

/** Guard, open, run and close one paid design on the helper; returns its record. A stop (> $60) exits 3 with STOP.json. */
async function paidDesign(h, { item, step, capUsd, request, retry = false, timeoutMin = 45 }) {
  envCheck(step);
  const authSource = h.auth().authSource;
  P.withLedger(LEDGER, (L) => {
    const g = P.guard(L, { item, step, capUsd, retry, minutes: timeoutMin, authSource });
    if (!g.ok) {
      if (g.kind === 'stop') writeJson(path.join(ART, 'STOP.json'), { at: new Date().toISOString(), ...g });
      throw Object.assign(new Error(g.message), { code: g.kind === 'stop' ? 3 : 2, pa: g });
    }
    P.openJob(L, { item, step, capUsd, retry, authSource });
  });
  log(`${step}: paid design (cap $${capUsd}, auth ${authSource})`);
  const t0 = Date.now();
  let ack;
  try { ack = await h.send({ type: 'design.request', request: { ...request, budgetUsd: capUsd } }); } catch (e) {
    P.withLedger(LEDGER, (L) => P.updateJob(L, step, { usd: 0, ended: true, status: 'refused', error: e.message }));
    return { step, status: 'refused', error: e.message, usd: 0 };
  }
  const d = await h.waitDesign(ack.designId, timeoutMin * 60_000, (dd) => P.withLedger(LEDGER, (L) => P.updateJob(L, step, { usd: dd.cost?.usd ?? 0, designId: ack.designId })));
  const usd = d.cost?.usd ?? 0;
  const ok = d.status === 'done' && !!d.entryId;
  P.withLedger(LEDGER, (L) => P.updateJob(L, step, { usd, ended: d.status !== 'timeout', status: ok ? 'done' : d.status, designId: ack.designId, entryId: d.entryId, rounds: d.critique?.rounds?.length ?? null, error: ok ? undefined : d.error ?? d.step }));
  log(`${step}: ${d.status} $${usd.toFixed(4)} in ${((Date.now() - t0) / 60000).toFixed(1)} min ${d.entryId ?? d.error ?? ''}`);
  return { step, designId: ack.designId, status: d.status, entryId: d.entryId ?? null, error: d.error ?? null, stepText: d.step ?? null, usd, turns: d.cost?.turns ?? null, cost: d.cost ?? null, ms: Date.now() - t0 };
}

// ---- the items ----------------------------------------------------------------------------------------------------------------

const subs = {};

subs.plan = async () => {
  const L = P.tally(P.readLedger(LEDGER));
  const out = {
    budgetUsd: P.BUDGET_USD, hardCapUsd: P.HARD_CAP_USD,
    items: Object.fromEntries(Object.entries(P.ITEMS).map(([k, it]) => [k, { what: it.what, estUsd: P.estimateOf(L, k), capUsd: it.capUsd, jobs: it.jobs, jobShareUsd: it.jobs ? P.jobShare(k) : 0, spentUsd: L.items[k]?.spentUsd ?? 0 }])),
    restated: L.restated, spentUsd: L.totalUsd, committedUsd: L.committedUsd, p5Eligible: P.p5Eligible(L),
    p1: P1_SITES.map((s) => ({ key: s.key, fixture: path.relative(root, s.fixture), request: s.request })),
    lotMaps: LOT_MAPS, r: R_SITES.map((s) => ({ ...s, fixture: path.relative(root, s.fixture) })),
    p5: 'not run: SB built no S4 program (its as-built: "S4 (the stretch) is not built"); PA builds none (reading)',
    ledger: LEDGER, runDir: RUN, ports: [SIDECAR_PORT, DEV_PORT],
  };
  console.log(JSON.stringify(out, null, 2));
};
subs.status = async () => { const L = P.tally(P.readLedger(LEDGER)); console.log(JSON.stringify({ totalUsd: L.totalUsd, committedUsd: L.committedUsd, items: L.items, restated: L.restated, answers: L.answers, jobs: L.jobs }, null, 2)); };

subs.answer = async () => {
  const step = opt('step');
  if (!step) throw new Error('answer --step <step> --yes|--no --text "..."');
  const yes = args.includes('--yes');
  P.withLedger(LEDGER, (L) => { L.answers.push({ at: new Date().toISOString(), step, yes, text: String(opt('text', '')) }); });
  log(`answer recorded for ${step}: ${yes ? 'yes' : 'no'}`);
};

/** P0, the standalone half ($0, the sim designer): P1's three requests (and each one plain), P4's arms (renders on / off), R's adaptations. */
subs['p0-standalone'] = async () => {
  const out = path.join(ART, 'P0');
  const res = { at: new Date().toISOString(), head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim(), checks: [] };
  const check = (ok, what, data) => { res.checks.push({ ok: !!ok, what, ...(data === undefined ? {} : { data }) }); log(`${ok ? 'ok  ' : 'FAIL'} P0 ${what}`); };
  for (const [arm, renders] of [['on', true], ['off', false]]) {
    const dir = path.join(out, `standalone-${arm}`);
    const h = await Helper.start(dir, 'sim', { siteRenders: renders });
    try {
      check(h.auth().auth !== null, `helper (${arm}) up, auth ${JSON.stringify(h.auth())}`);
      const entries = {};
      for (const s of P1_SITES) {
        const { fx, spec } = await h.site(s.fixture);
        const a = await h.send({ type: 'design.request', request: designRequest(spec, fx, s.request, { budgetUsd: P.jobShare('P1') }) });
        const d = await h.waitDesign(a.designId, 600_000);
        entries[s.key] = d.entryId;
        check(d.status === 'done' && d.entryId, `${arm}: P1 ${s.key} site-aware design (sim) installed ${d.entryId ?? d.error}`);
        const sr = fs.existsSync(path.join(scratchOf(h, a.designId), 'site')) ? fs.readdirSync(path.join(scratchOf(h, a.designId), 'site')).filter((f) => f.endsWith('.png')) : [];
        check(renders ? sr.length === 4 : sr.length === 0, `${arm}: P1 ${s.key} scratch site renders ${sr.length} (images ${arm})`, sr);
        if (arm === 'on') {
          const { site: _s, ...plainReq } = designRequest(spec, fx, s.request);
          const b = await h.send({ type: 'design.request', request: { ...plainReq, name: `${s.request.name} plain` } });
          await h.waitDesign(b.designId, 600_000);
          const df = briefDiff(path.join(scratchOf(h, b.designId), 'BRIEF.md'), path.join(scratchOf(h, a.designId), 'BRIEF.md'));
          writeJson(path.join(out, `brief-diff-${s.key}-site-vs-plain.json`), df);
          check(df.plus.some((l) => /^## Site/.test(l)) && df.plus.length > 5, `${s.key}: BRIEF site vs plain +${df.plus.length}/-${df.minus.length} (the Site section in)`);
        }
        res[`${arm}:${s.key}`] = { designId: a.designId, entryId: d.entryId, fit: entryFit(path.join(dir, 'library'), d.entryId ?? '') };
      }
      // R (sim): the $0 site variant first, then the adaptation (versionOf + site)
      for (const r of R_SITES) {
        const { fx, spec } = await h.site(r.fixture);
        const v = await h.send({ type: 'site.variant', entryId: entries[r.source], site: spec, opKey: `pa-p0-${arm}-v-${r.key}` }).catch((e) => ({ refused: e.message }));
        const vf = v.id ? await h.waitFollow(v.id) : v;
        const a = await h.send({ type: 'design.request', request: designRequest(spec, fx, { ...P1_SITES.find((s) => s.key === r.source).request, notes: r.notes }, { versionOf: { entryId: entries[r.source] }, budgetUsd: P.jobShare('R') }) });
        const d = await h.waitDesign(a.designId, 600_000);
        // the sim makes no change to a design, so an adaptation into a site its variant does not fit (cliff_owned: a player's pillar,
        // SITE_UNFIT site_keep) fails on the composite's check with that rule: the path ran end to end; only a real designer adapts it
        const simNoChange = vf.refused?.detail === 'site_keep' && d.status === 'failed' && /site_keep/.test(d.error ?? '');
        check(d.status === 'done' || simNoChange, `${arm}: R ${r.key}: variant ${vf.status}${vf.refused ? ` refused ${vf.refused.code} ${vf.refused.detail}` : ` ${vf.newEntryId ?? ''}`}, adaptation (sim) ${d.status}${simNoChange ? ' (the sim makes no change: the composite check refuses site_keep, as the variant did)' : ` ${d.entryId ?? d.error ?? ''}`}`);
        res[`${arm}:R:${r.key}`] = { variant: vf, adaptation: { designId: a.designId, status: d.status, entryId: d.entryId ?? null } };
      }
    } finally { await h.stop(); }
  }
  // images on vs off: the same request's BRIEF in each arm
  for (const s of P1_SITES) {
    const on = res[`on:${s.key}`], off = res[`off:${s.key}`];
    const df = briefDiff(path.join(out, 'standalone-on', 'data', 'designs', on.designId, 'BRIEF.md'), path.join(out, 'standalone-off', 'data', 'designs', off.designId, 'BRIEF.md'));
    writeJson(path.join(out, `brief-diff-${s.key}-images-on-vs-off.json`), df);
    check(true, `${s.key}: BRIEF images on vs off +${df.plus.length}/-${df.minus.length} (reading 4 of DS: the brief still names the renders it asks for)`);
  }
  res.ok = res.checks.every((c) => c.ok);
  writeJson(path.join(out, 'standalone.json'), res);
  log(`P0 standalone: ${res.ok ? 'PASS' : 'FAIL'} (${res.checks.filter((c) => c.ok).length}/${res.checks.length})`);
  if (!res.ok) process.exitCode = 1;
};

/** P0, the in-game half (a gate step: the run's client is up on the sim backend): the P2/P3 lot map on the scenario's natural run. */
subs['p0-scenario'] = async () => {
  const scn = args[1];
  if (!LOT_MAPS[scn]) throw new Error('p0-scenario s5|s6');
  const plan = scenarioPlan(scn, 'sim');
  const pf = path.join(ART, 'P0', `plan-${scn}.json`);
  writeJson(pf, plan);
  const art = process.env.SCENARIOS_ART ?? path.join(ART, 'P0', 'scenarios');
  const outDir = path.join(art, `pa-p0-${scn}`);
  const base = spawnSync(process.execPath, [path.join(root, 'tools', 'gate6b.mjs'), 'base'], { stdio: 'inherit', env: process.env });
  if (base.status !== 0) throw new Error('gate6b base failed');
  // the scenario's own output goes to its log (its non-§5 rows print FAIL for a natural-only run: exactness wants a flat sibling, mspt is
  // a timing bar); this step prints P0's verdict on the §5 bars
  fs.mkdirSync(art, { recursive: true });
  const slog = path.join(art, `pa-p0-${scn}.scenario.log`);
  const fd = fs.openSync(slog, 'a');
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'scenarios.mjs'), 'run', scn, '--phase', '7b-pa', '--out', outDir], { stdio: ['ignore', fd, fd], env: { ...process.env, PA_PLAN: pf } });
  fs.closeSync(fd);
  log(`P0 ${scn}: the scenario's log ${slog}`);
  const v = verdict(outDir, scn, 'P0');
  // (the run's own exit is recorded, not judged: a natural-only run's exactness row asks for a flat sibling and its mspt row is a timing
  // bar; P0 judges the §5 bars from metrics.json, and a run that never wrote them fails)
  writeJson(path.join(ART, 'P0', `scenario-${scn}.json`), { exit: r.status, ...v });
  log(`P0 ${scn}: exit ${r.status} (recorded); §5 bars ${v.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(v.bars)}`);
  if (!v.pass) process.exitCode = 1;
};

/** The §5 bars of a scenario run dir (metrics.json): S5/S6 Fit, disturbance, checker errors, reachability, safety; the gallery shots. */
function verdict(outDir, scn, item) {
  const m = readJson(path.join(outDir, 'metrics.json'), {});
  const rows = m.rows ?? m.bars ?? [];
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const se = readJson(path.join(outDir, 'site-entries.json'), {});
  const want = ['sb-fit', 'sb-disturbance', 'sb-ports', 'checker', 'reachability', 'safety', 'structure', 'buildings'];
  const bars = Object.fromEntries(want.filter((k) => by[k]).map((k) => [k, { value: by[k].value, threshold: by[k].threshold, pass: by[k].pass }]));
  const shots = fs.existsSync(path.join(outDir, 'shots')) ? fs.readdirSync(path.join(outDir, 'shots')).filter((f) => f.endsWith('.png')).map((f) => path.join(outDir, 'shots', f)) : [];
  // §5's bars: Fit, disturbance, 0 checker errors, reachability (the player's nodes and every site lot's port), safety; all six present
  // ("0 checker errors" is the plan's checker and every lot entry's: rows checker and buildings)
  const gated = ['sb-fit', 'sb-disturbance', 'sb-ports', 'checker', 'buildings', 'reachability', 'safety'];
  return { item, scenario: scn, outDir, bars, pass: rows.length > 0 && gated.every((k) => by[k] && by[k].pass === true), allRows: rows.map((r) => ({ id: r.id, value: r.value, pass: r.pass, gated: r.gated })), entries: se.rows ?? [], pa: se.pa ?? null, shots };
}

/** P1 (paid): three site-aware designs on the calibration sites; the $0 variant check; the re-statement. */
subs.p1 = async () => {
  needP0();
  const out = path.join(ART, 'P1');
  const h = await Helper.start(path.join(ART, 'standalone'), 'claude', {});
  const res = { at: new Date().toISOString(), head: gitHead(), auth: h.auth(), designs: [], variantCheck: null };
  try {
    if (!/claude login/i.test(res.auth.authSource ?? '') || res.auth.auth !== 'ok') throw Object.assign(new Error(`refusing P1: the helper is not on the claude login (${JSON.stringify(res.auth)})`), { code: 2 });
    const jobs = [];
    for (const s of P1_SITES) {
      const { fx, spec } = await h.site(s.fixture);
      jobs.push(paidDesign(h, { item: 'P1', step: `P1:${s.key}`, capUsd: P.jobShare('P1'), request: designRequest(spec, fx, s.request) }).then((r) => ({ key: s.key, ...r })));
      await sleep(2000);
    }
    for (const r of await Promise.all(jobs)) {
      r.fit = r.entryId ? entryFit(path.join(ART, 'standalone', 'library'), r.entryId) : null;
      res.designs.push(r);
    }
    writeJson(path.join(out, 'p1.json'), res);
    // the $0 check that a Claude design is a site variant's source: the cliff design onto DS's cliff_east
    const cliff = res.designs.find((d) => d.key === 'cliff');
    if (cliff?.entryId) {
      const { spec } = await h.site(R_SITES.find((x) => x.key === 'east').fixture);
      const v = await h.send({ type: 'site.variant', entryId: cliff.entryId, site: spec, opKey: 'pa-p1-variant-cliff-east' }).catch((e) => ({ status: 'refused', refused: e.message }));
      res.variantCheck = v.id ? await h.waitFollow(v.id) : v;
      log(`P1 variant check (cliff -> cliff_east, $0): ${JSON.stringify(res.variantCheck)}`);
    }
  } finally {
    await h.stop();
    writeJson(path.join(out, 'p1.json'), res);
  }
  const usd = res.designs.filter((d) => d.status === 'done').map((d) => d.usd);
  if (usd.length) {
    const rs = P.withLedger(LEDGER, (L) => P.restate(L, usd));
    res.restated = rs;
    writeJson(path.join(out, 'p1.json'), res);
    log(`P1 re-statement: mean $${rs.p1MeanUsd} per design, factor ${rs.factor}, site multiplier ${rs.siteMultiplier}; ${JSON.stringify(Object.fromEntries(Object.entries(rs.items).map(([k, v]) => [k, v.estUsd])))}`);
  }
  report('P1');
};

function needP0() {
  const s = readJson(path.join(ART, 'P0', 'standalone.json'));
  const s5 = readJson(path.join(ART, 'P0', 'scenario-s5.json'));
  const s6 = readJson(path.join(ART, 'P0', 'scenario-s6.json'));
  const ok = s?.ok && s5?.pass && s6?.pass;
  if (!ok && !args.includes('--p0-reviewed')) throw Object.assign(new Error(`refusing: P0 has not passed (standalone ${s?.ok}, s5 ${s5?.pass}, s6 ${s6?.pass}); P0 must pass before P1`), { code: 2 });
}
const gitHead = () => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD']).toString().trim();

/** P2/P3 (paid): the run dir's client on the claude login; the scenario's natural run with the PA lot map; the bars. */
async function scenarioItem(scn) {
  needP0();
  const item = LOT_MAPS[scn].item;
  const L = P.tally(P.readLedger(LEDGER));
  const est = P.estimateOf(L, item), cap = P.ITEMS[item].capUsd;
  // the item as a whole first: its full cap must fit under $60 (else the stop, before anything starts)
  const g = P.guard(L, { item, step: `${item}:item`, capUsd: cap, minutes: 120 });
  if (!g.ok) { if (g.kind === 'stop') writeJson(path.join(ART, 'STOP.json'), { at: new Date().toISOString(), ...g }); throw Object.assign(new Error(g.message), { code: g.kind === 'stop' ? 3 : 2 }); }
  log(`${item} (${scn}): estimate $${est}, cap $${cap} ($${P.jobShare(item)} per job), committed $${L.committedUsd}`);
  const attempt = Number(opt('attempt', 1));
  const reuse = opt('reuse') ? JSON.parse(String(opt('reuse'))) : undefined;
  const plan = scenarioPlan(scn, 'claude', { attempt, ...(reuse ? { reuse } : {}) });
  const pf = path.join(ART, item, `plan-${attempt}.json`);
  writeJson(pf, plan);
  const env = envCheck(`${item}:client`);
  Object.assign(env, { GATE6B_RUN: RUN, GATE6B_DEV_PORT: String(DEV_PORT), GATE6B_SIDECAR_PORT: String(SIDECAR_PORT), GATE6B_OUT: path.join(ART, item, 'gate6b'), SCENARIOS_ART: path.join(ART, item, 'scenarios'), ARCHITECT_SHOTS_DIR: path.join(ART, item, 'shots'), JAVA_HOME: process.env.JAVA_HOME ?? '/opt/homebrew/opt/openjdk@25', PA_PLAN: pf });
  if (!fs.existsSync(RUN)) throw new Error(`no run dir ${RUN} (P0's gate run makes it)`);
  const run = (a, extra = {}) => spawnSync(process.execPath, a, { cwd: root, stdio: 'inherit', env: { ...env, ...extra } });
  const outDir = path.join(ART, item, `run-${attempt}`);
  let rc = 1;
  try {
    // the client: the run dir at this HEAD, the claude login (secrets.json useClaudeLogin; never a key), DevBridge 8897, sidecar 8896
    if (run([path.join(root, 'tools', 'gate6b.mjs'), 'start', 'G6B Flat Base', 'claude']).status !== 0) throw new Error('the client did not start');
    if (run([path.join(root, 'tools', 'gate6b.mjs'), 'base']).status !== 0) throw new Error('gate6b base failed');
    rc = run([path.join(root, 'tools', 'scenarios.mjs'), 'run', scn, '--phase', '7b-pa', '--out', outDir]).status;
  } finally {
    run([path.join(root, 'tools', 'gate6b.mjs'), 'stop']);
  }
  const v = verdict(outDir, scn, item);
  writeJson(path.join(ART, item, `verdict-${attempt}.json`), { exit: rc, ...v });
  log(`${item}: exit ${rc}; bars ${JSON.stringify(v.bars)}; not shown ${JSON.stringify(v.pa?.notShown ?? [])}`);
  report(item);
}
subs.p2 = () => scenarioItem('s5');
subs.p3 = () => scenarioItem('s6');

/** P4 (paid): S5's 2 archetype requests again with the site renders off (own helper, the P2 world's frozen volumes); the A/B sheet. */
subs.p4 = async () => {
  needP0();
  const attempt = Number(opt('attempt', 1));
  const v2 = readJson(path.join(ART, 'P2', `verdict-${opt('p2-attempt', 1)}.json`));
  if (!v2?.pa?.jobs?.length) throw new Error('P4 needs P2\'s archetype jobs (artifacts/7b/P2/verdict-*.json)');
  const arche = v2.pa.jobs.filter((j) => !j.landmark && j.status === 'DONE');
  if (arche.length !== 2) log(`P4: P2 has ${arche.length} archetype(s) shown (2 expected): the A/B runs on those`);
  const out = path.join(ART, 'P4');
  const h = await Helper.start(path.join(ART, 'standalone-off'), 'claude', { siteRenders: false });
  const res = { at: new Date().toISOString(), head: gitHead(), auth: h.auth(), pairs: [] };
  try {
    if (!/claude login/i.test(res.auth.authSource ?? '') || res.auth.auth !== 'ok') throw Object.assign(new Error(`refusing P4: not the claude login (${JSON.stringify(res.auth)})`), { code: 2 });
    const run2 = readJson(path.join(ART, 'P2', `run-${opt('p2-attempt', 1)}`, 'run.json'));
    const ir = readJson(path.join(ART, 'P2', `run-${opt('p2-attempt', 1)}`, 'raw', 'plan', 'ir.json'));
    for (const j of arche) {
      const lot = ir.lots.find((l) => l.id === j.lot);
      const vol = findVolume(lot.site.volumeSha);
      if (!vol) throw new Error(`P4: no frozen volume ${lot.site.volumeSha} for ${j.lot} in the run dir's worlds`);
      const bytes = fs.readFileSync(vol);
      const chunks = [];
      for (let i = 0; i < bytes.length; i += 1 << 20) chunks.push(bytes.subarray(i, i + (1 << 20)).toString('base64'));
      const b = await h.send({ type: 'blob.put', kind: 'region.volume', chunks });
      const spec = { ...lot.site, volumeBlobId: b.blobId };
      // P2's request as sent (dev.ds.request's fields), the same body over the protocol; only siteRenders differs (the helper's config)
      const rq = j.request;
      const request = { type: rq.buildingType, style: rq.style, features: [], maxSize: { x: 20, y: 24, z: 20 }, name: rq.name, notes: rq.notes, bible: rq.bible, site: spec };
      const r = await paidDesign(h, { item: 'P4', step: `P4:${j.key}:${j.lot}`, capUsd: P.jobShare('P4'), request });
      res.pairs.push({ key: j.key, lot: j.lot, on: { entryId: j.entryId, designId: j.designId, usd: j.usd, library: path.join(RUN, 'mod', 'run', 'architect', 'library') }, off: { ...r, library: path.join(ART, 'standalone-off', 'library') } });
    }
    res.run2 = run2?.runId ?? null;
  } finally {
    await h.stop();
    writeJson(path.join(out, `p4-${attempt}.json`), res);
  }
  sheet(res);
  report('P4');
};

function findVolume(sha) {
  const saves = path.join(RUN, 'mod', 'run', 'saves');
  for (const w of fs.existsSync(saves) ? fs.readdirSync(saves) : []) { const f = path.join(saves, w, 'architect', 'volumes', `${sha}.bin`); if (fs.existsSync(f)) return f; }
  return null;
}

/** The kit's composite render of an installed site-bound entry on its own site (iso, the gallery's view), into `png`. */
function composite(library, entryId, png) {
  const dir = path.join(library, entryId);
  const nbt = path.join(dir, `${entryId}.nbt`);
  const site = path.join(dir, 'site', 'site.arvx'), lot = path.join(dir, 'site', 'site.json');
  if (!fs.existsSync(nbt) || !fs.existsSync(site)) return null;
  const tmp = fs.mkdtempSync(path.join(path.dirname(png), '.render-'));
  const r = spawnSync(process.execPath, [path.join(root, 'kit', 'render.mjs'), nbt, '--site', site, '--lot', lot, '--views', 'composite', '--out', tmp], { encoding: 'utf8', env: P.scrubbedEnv() });
  const made = path.join(tmp, `${entryId}.preview-composite.png`);
  if (r.status === 0 && fs.existsSync(made)) fs.copyFileSync(made, png);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (fs.existsSync(png)) return png;
  log(`composite render of ${entryId} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return null;
}

/** The blind A/B sheet (§16.5; N-7b-4): per archetype, the two arms side by side as "A" and "B", sides randomised; the key apart. */
function sheet(res) {
  const out = path.join(ART, 'P4', 'ab');
  fs.mkdirSync(out, { recursive: true });
  const key = P.abSides(res.pairs.map((p) => p.key));
  const items = [];
  for (const p of res.pairs) {
    const img = {};
    for (const arm of ['on', 'off']) {
      const e = p[arm];
      if (!e?.entryId) continue;
      const tmp = path.join(out, `.${p.key}-${arm}.png`);
      const f = composite(e.library, e.entryId, tmp);
      if (f) img[arm] = f;
    }
    const k = key[p.key];
    for (const side of ['A', 'B']) if (img[k[side]]) fs.copyFileSync(img[k[side]], path.join(out, `pair-${p.key}-${side}.png`));
    for (const arm of ['on', 'off']) fs.rmSync(path.join(out, `.${p.key}-${arm}.png`), { force: true });
    items.push({ pair: p.key, A: `pair-${p.key}-${side('A')}.png`, B: `pair-${p.key}-${side('B')}.png` });
    function side(s) { return s; }
  }
  // the key: its own file, never in the sheet (the coordinator keeps it until Noah's picks are recorded)
  writeJson(path.join(ART, 'P4', 'ab-key.json'), { at: new Date().toISOString(), note: 'which arm each side shows (on = site renders on, P2; off = P4). Not for Noah until his picks are recorded.', key, pairs: res.pairs.map((p) => ({ key: p.key, lot: p.lot, on: p.on.entryId, off: p.off.entryId })) });
  const html = ['<!doctype html><meta charset="utf-8"><title>Treehouse pick sheet</title>',
    '<style>body{font:16px system-ui;margin:24px;max-width:1100px}figure{display:inline-block;margin:8px;width:48%}img{width:100%;border:1px solid #888}h2{margin-top:32px}</style>',
    '<h1>Treehouse pick sheet</h1><p>Two treehouse designs per pair, each built into the same tree site from the same request. For each pair, pick the one you prefer (A or B), and say why in a few words if you like.</p>',
    ...items.map((it, i) => `<h2>Pair ${i + 1}</h2><figure><img src="${it.A}"><figcaption>A</figcaption></figure><figure><img src="${it.B}"><figcaption>B</figcaption></figure><p>Pick: A / B</p>`)];
  fs.writeFileSync(path.join(out, 'sheet.html'), `${html.join('\n')}\n`);
  writeJson(path.join(out, 'sheet.json'), { pairs: items.map((it, i) => ({ pair: i + 1, A: it.A, B: it.B, pick: null })) });
  log(`P4 sheet: ${path.join(out, 'sheet.html')}; key ${path.join(ART, 'P4', 'ab-key.json')}`);
}
subs.sheet = async () => sheet(readJson(path.join(ART, 'P4', `p4-${opt('attempt', 1)}.json`)));

/** R (paid): P1's cliff design adapted (versionOf + site) into DS's two other cliffs, each after its $0 site variant. */
subs.r = async () => {
  needP0();
  const p1 = readJson(path.join(ART, 'P1', 'p1.json'));
  const out = path.join(ART, 'R');
  const h = await Helper.start(path.join(ART, 'standalone'), 'claude', {});
  const res = { at: new Date().toISOString(), head: gitHead(), auth: h.auth(), runs: [] };
  try {
    if (!/claude login/i.test(res.auth.authSource ?? '') || res.auth.auth !== 'ok') throw Object.assign(new Error(`refusing R: not the claude login (${JSON.stringify(res.auth)})`), { code: 2 });
    for (const r of R_SITES) {
      const src = p1.designs.find((d) => d.key === r.source);
      if (!src?.entryId) { res.runs.push({ key: r.key, skipped: `P1's ${r.source} design is not shown` }); continue; }
      const { fx, spec } = await h.site(r.fixture);
      const v = await h.send({ type: 'site.variant', entryId: src.entryId, site: spec, opKey: `pa-r-v-${r.key}` }).catch((e) => ({ status: 'refused', refused: e.message }));
      const variant = v.id ? await h.waitFollow(v.id) : v;
      const a = await paidDesign(h, { item: 'R', step: `R:adapt:${r.key}`, capUsd: P.jobShare('R'), request: designRequest(spec, fx, { ...P1_SITES.find((s) => s.key === r.source).request, notes: r.notes }, { versionOf: { entryId: src.entryId } }) });
      res.runs.push({ key: r.key, source: src.entryId, variant, adaptation: a });
    }
  } finally {
    await h.stop();
    writeJson(path.join(out, 'r.json'), res);
  }
  const done = res.runs.filter((x) => x.adaptation?.status === 'done');
  res.adapted = done.length ? { runs: done.length, meanUsd: r6(done.reduce((s, x) => s + x.adaptation.usd, 0) / done.length), turns: done.map((x) => x.adaptation.turns) } : null;
  writeJson(path.join(out, 'r.json'), res);
  log(`R: adapted ${JSON.stringify(res.adapted)}`);
  report('R');
};

/** After an item: the ledger row, the >50% over-estimate flag. */
function report(item) {
  const L = P.tally(P.readLedger(LEDGER));
  const row = L.items[item];
  log(`${item}: spent $${row.spentUsd} of est $${row.estUsd} (cap $${row.capUsd})${row.overEstimate50 ? ' — OVER ITS ESTIMATE BY MORE THAN 50%: report it with the reason; re-state the next estimate' : ''}; ledger $${L.totalUsd} (committed $${L.committedUsd})`);
}

if (!subs[sub]) {
  console.error('usage: node tools/gate7bpa.mjs plan|status|p0-standalone|p0-scenario s5|s6|p1|p2|p3|p4|r|sheet|answer');
  process.exit(64);
}
try {
  await subs[sub]();
} catch (e) {
  log(`stopped: ${e.stack ?? e.message}`);
  process.exitCode = e.code ?? 1;
}
