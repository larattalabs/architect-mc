// (7c AU, docs/CONTRACT.md "Phase 7c" §3 row 13, "Slice AU as built") Program authoring through the sidecar with the REAL kit (../kit, or
// ARCHITECT_REGION_KIT), on the sim backend: scripted rounds, the checker (lint, a sandboxed plan, the region checker), a round failed on a
// checker finding and fixed, AUTHORED and NOT_SHOWN, opKey and cancel; and the sandbox itself, the security boundary every region program
// runs in (an authored program's plan, the plan check that names it, the link pass): probe programs from the programs dir (never linted)
// try the network (incl. a raw UDP socket), files outside their dir, other processes (incl. process._kill), code from strings and timers,
// and each must be refused at run time. Code from strings is off in every plan child, so the lint-passing route to the Function
// constructor (a computed member) ends in an EvalError.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryLogger } from '../src/context.js';
import type { Outbound } from '../src/protocol.js';
import { FEATURES, RegionPlanMsg } from '../src/protocol.js';
import { Sidecar } from '../src/sidecar.js';
import { SimDesigner } from '../src/sim.js';
import { Store } from '../src/store.js';
import { AUTHOR_ROUNDS, EXT_AUTHOR_ROUNDS, SIM_SOURCE, authorKeyBody, authorPrompt, authorRepairPrompt, authorRounds, authorText, type AuthorRound, type AuthorState } from '../src/author.js';
import { arsv, rmrf, SIDECAR_ROOT, tempDir, until } from './helpers.js';

const KIT = process.env.ARCHITECT_REGION_KIT ? path.resolve(process.env.ARCHITECT_REGION_KIT) : path.join(SIDECAR_ROOT, '..', 'kit');
const FIX = path.join(KIT, 'test', 'fixtures', 'au');
const hasAU = fs.existsSync(path.join(KIT, 'lib', 'plan', 'authored.mjs')) && fs.existsSync(path.join(FIX, 'courtyard.mjs'));
const COURT = hasAU ? fs.readFileSync(path.join(FIX, 'courtyard.mjs'), 'utf8') : SIM_SOURCE;
const FLOATING = hasAU ? fs.readFileSync(path.join(FIX, 'courtyard_floating.mjs'), 'utf8') : SIM_SOURCE;
const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

describe('the author\'s pure parts (7c AU)', () => {
  const claim = { minX: 0, minZ: 0, maxX: 95, maxZ: 95, minY: -64, maxY: 319 };
  it('reads its prompt text from the kit, the round cap from ext (1-4), and keys a request by its body without blob ids', () => {
    const t = authorText(KIT);
    expect(t.system).toContain("'../lib/region/program.mjs'");
    expect(t.system).toContain('floor, ceil, round');
    expect(authorRounds(undefined)).toBe(AUTHOR_ROUNDS);
    expect(authorRounds({ [EXT_AUTHOR_ROUNDS]: 2 })).toBe(2);
    for (const bad of [0, 5, 1.5, '2']) expect(() => authorRounds({ [EXT_AUTHOR_ROUNDS]: bad })).toThrow(/FIELD_LIMIT/);
    expect(authorKeyBody({ type: 'region.author', brief: 'b', surveyBlobId: 'x', opKey: 'k', id: 'q', v: 1 })).toEqual({ type: 'region.author', brief: 'b' });
    const p = authorPrompt({ brief: 'a sea stack monastery', claim, summary: 'flat', roles: ['rock'], partId: 'hall', answer: t.answer });
    expect(p).toContain('a sea stack monastery');
    expect(p).toContain('96 x 96 columns');
    expect(p).toContain('`hall`');
    const prev = { n: 1, jobId: 'j', source: 'SRC', check: { sha: 'a', findings: [{ rule: 'check:M3', message: 'floating' }, { rule: 'lint', message: 'Math.sin', line: 3 }] } } as AuthorRound;
    const r = authorRepairPrompt(p, prev, t.repair);
    expect(r.startsWith(p)).toBe(true);
    expect(r).toContain('```js\nSRC\n```');
    expect(r).toContain('- check:M3: floating');
    expect(r).toContain('- lint (line 3): Math.sin');
  });
  it('the sim stand-in is the kit fixture courtyard.mjs (byte for byte, without its header comment)', () => {
    if (hasAU) expect(SIM_SOURCE).toBe(COURT.replace(/^(\/\/.*\n)+/, ''));
  });
  it('advertises region.author; region.plan carries authored sources (at most 4)', () => {
    expect(FEATURES).toContain('region.author');
    const base = { v: 1, type: 'region.plan', id: 'q', program: 'plan_v0', params: {}, claim, surveyBlobId: 'b1' };
    expect(RegionPlanMsg.safeParse({ ...base, authored: { au_x: { source: 'x' } } }).success).toBe(true);
    expect(RegionPlanMsg.safeParse({ ...base, authored: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`a${n}`, { source: 'x' }])) }).success).toBe(false);
    expect(RegionPlanMsg.safeParse({ ...base, authored: { 'Bad-Id': { source: 'x' } } }).success).toBe(false);
  });
});

/** A probe region program (the programs dir: no lint): runs `body` and throws its outcome, which the plan's failure message carries. */
const probe = (body: string) => `export const id = 'probe';
export const params = {};
export default function (ctx) {
  let out = 'none';
  try { out = 'ALLOWED ' + String((() => { ${body} })()); } catch (e) { out = 'REFUSED ' + String(e && (e.code || e.name || e.message)); }
  throw new Error('PROBE ' + out);
}
`;
/** The lint-passing route to the Function constructor (a computed member): an authored program the lint takes. */
const VIA_FUNCTION = `import { region } from '../lib/region/program.mjs';
export const id = 'probe_fn';
export const params = {};
const c = 'constr' + 'uctor';
export default function (ctx) {
  const F = ({})[c][c];
  F('return 1')();
  return region(ctx);
}
`;

describe.skipIf(!hasAU)('program authoring with the real kit (7c AU)', () => {
  let root: string;
  let sc: Sidecar;
  const events: Outbound[] = [];
  const SIDE = 96;
  const claim = { minX: 0, minZ: 0, maxX: SIDE - 1, maxZ: SIDE - 1, minY: -64, maxY: 319 };
  const survey = arsv(0, 0, SIDE, SIDE, () => 64);
  const ask = async (msg: Record<string, unknown>) => {
    let ack: { ok: boolean; error?: string; result?: Record<string, unknown> } | undefined;
    await sc.handle({ v: 1, id: 'q', ...msg } as never, (m) => {
      if (m.type === 'ack') ack = m as typeof ack;
    });
    return ack!;
  };
  const author = async (brief: string, over: Record<string, unknown> = {}) => {
    const a = await ask({ type: 'region.author', brief, claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), ...over });
    expect(a.ok, a.error).toBe(true);
    return a.result as { designId: string; adopted?: boolean };
  };
  const final = (id: string) => ['done', 'failed', 'cancelled'].includes(sc.designs.get(id)?.status ?? '');
  const st = (id: string) => sc.designs.get(id)!.program as unknown as AuthorState;
  const queries = (jobId: string) =>
    fs.readFileSync(path.join(sc.config.dataDir, 'jobs', jobId, 'sim-queries.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { system: string; prompt: string });
  const check = (source: string) => sc.regions.authorCheck(path.join(root, 'probe', crypto.randomBytes(4).toString('hex')), { source, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), claim });
  let probes = 0;
  /** Plans a probe program from the programs dir in the plan sandbox (region.plan): its failure message, `{message}`. */
  const probeOut = async (body: string) => {
    const file = `probe_${++probes}.mjs`;
    fs.writeFileSync(path.join(sc.config.regions.programsDir, file), probe(body));
    const a = await ask({ type: 'region.plan', program: file, params: {}, claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), check: false });
    expect(a.ok, a.error).toBe(true);
    const planId = a.result!.planId as string;
    await until(() => events.some((e) => (e.type === 'region.planned' || e.type === 'region.failed') && (e as { planId?: string }).planId === planId), 120_000, 25);
    const f = events.find((e) => e.type === 'region.failed' && (e as { planId?: string }).planId === planId) as { message?: string } | undefined;
    return { message: String(f?.message ?? 'planned (no PROBE outcome)') };
  };

  beforeAll(async () => {
    root = tempDir('arch-author-');
    const cfg = loadConfig(['--data', path.join(root, 'data'), '--library', path.join(root, 'library'), '--kit', KIT, '--backend', 'sim'], {});
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    cfg.simStepMs = 10;
    cfg.regions.planMs = 8000; // the timers probe ends on the plan's wall clock
    sc = new Sidecar(cfg, new Store(cfg.dataDir, { debounceMs: 5 }), memoryLogger());
    fs.mkdirSync(cfg.regions.programsDir, { recursive: true });
    sc.subscribe((m: Outbound) => events.push(m));
    await sc.start(new SimDesigner(sc, 5));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET');
  });
  afterAll(async () => {
    await sc.regions.idle();
    await sc.close();
    rmrf(root);
  });

  it('round 1 fails on a checker finding (M3: a floating court), round 2 is fixed: AUTHORED with the source and its sha', async () => {
    const { designId } = await author('a paved court with a gatehouse', { ext: { 'architect:simAuthor': [{ source: FLOATING, reason: 'r1' }, { source: COURT, reason: 'r2' }] } });
    await until(() => final(designId), 120_000);
    const d = sc.designs.get(designId)!;
    expect(d.status, d.error).toBe('done');
    expect(d.kind).toBe('program');
    const res = d.result as Record<string, unknown>;
    expect(res.outcome).toBe('AUTHORED');
    expect(res.programId).toBe(designId);
    expect(res.sha).toBe(sha(COURT));
    expect(res.source).toBe(COURT);
    expect(res.rounds).toBe(2);
    expect(res.history).toEqual([{ round: 1, sha: sha(FLOATING), findings: 1 }, { round: 2, sha: sha(COURT), findings: 0 }]);
    expect(res.cost).toBeGreaterThan(0);
    const s = st(designId);
    expect((s.rounds[0]!.check!.findings as Array<{ rule: string }>).map((f) => f.rule)).toEqual(['check:M3']);
    const q2 = queries(s.rounds[1]!.jobId)[0]!;
    expect(q2.prompt).toContain(FLOATING);
    expect(q2.prompt).toMatch(/- check:M3: \[court\] \d+ cell\(s\) connect to neither the ground/);
    expect(q2.system).toBe(authorText(KIT).system);
  }, 180_000);

  it('every round dirty: NOT_SHOWN with the last findings after the caller\'s round cap; the lint never runs the program', async () => {
    const dirty = COURT.replace('Math.floor(P.size / 2)', 'Math.floor(Math.sin(1) * P.size)');
    const { designId } = await author('a court', { ext: { [EXT_AUTHOR_ROUNDS]: 2, 'architect:simAuthor': [{ source: dirty, reason: 'r' }] } });
    await until(() => final(designId), 120_000);
    const res = sc.designs.get(designId)!.result as Record<string, unknown>;
    expect(res.outcome).toBe('NOT_SHOWN');
    expect(res.rounds).toBe(2);
    expect((res.findings as Array<{ rule: string; message: string }>)[0]!.message).toMatch(/^Math\.sin/);
    expect(st(designId).rounds[1]!.check!.irSha).toBeUndefined();
  }, 180_000);

  it('the sim stand-in authors at once (one round)', async () => {
    const { designId } = await author('anything');
    await until(() => final(designId), 120_000);
    const res = sc.designs.get(designId)!.result as Record<string, unknown>;
    expect([res.outcome, res.rounds, res.sha]).toEqual(['AUTHORED', 1, sha(SIM_SOURCE)]);
  }, 120_000);

  it('opKey: the same key and body adopt the first design; another body conflicts; cancel stops it', async () => {
    const a = await author('keyed court', { opKey: 'au.k1' });
    const b = await author('keyed court', { opKey: 'au.k1' });
    expect(b).toEqual({ designId: a.designId, adopted: true });
    const c = await ask({ type: 'region.author', brief: 'another court', claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), opKey: 'au.k1' });
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/op_key_conflict/);
    await until(() => final(a.designId), 120_000);
    const bad = await ask({ type: 'region.author', brief: 'x', claim, surveyBlobId: sc.blobs.putBytes(survey, 'survey', 'bin'), ext: { [EXT_AUTHOR_ROUNDS]: 9 } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/FIELD_LIMIT/);
  }, 180_000);

  // ---- the sandbox (every plan child: each probe is refused at run time)
  it('sandbox: a probe runs (the harness), code from strings is off: the lint-passing Function-constructor route ends in an EvalError', async () => {
    expect((await probeOut('return 1')).message).toContain('PROBE ALLOWED 1');
    expect((await probeOut("return new Function('return 1')()")).message).toMatch(/PROBE REFUSED (EvalError|ERR_)/);
    expect((await probeOut("return (0, eval)('1')")).message).toMatch(/PROBE REFUSED (EvalError|ERR_)/);
    const { lintAuthored } = (await import(path.join(KIT, 'lib', 'plan', 'authored.mjs'))) as { lintAuthored: (s: string) => unknown[] };
    expect(lintAuthored(VIA_FUNCTION)).toEqual([]);
    const r = await check(VIA_FUNCTION);
    expect(r.findings.map((f) => f.rule)).toEqual(['program']);
    expect(r.findings[0]!.message).toMatch(/[Cc]ode generation from strings disallowed|EvalError/);
  }, 120_000);

  it('sandbox: no network (fetch, net, http, dns, http2, a server)', async () => {
    const tries = {
      fetch: 'return typeof fetch',
      net: "return process.getBuiltinModule('node:net').connect(80, '127.0.0.1')",
      http: "return process.getBuiltinModule('node:http').get('http://127.0.0.1:1/')",
      dns: "return process.getBuiltinModule('node:dns').lookup('localhost', () => 0)",
      resolve4: "return process.getBuiltinModule('node:dns').resolve4('localhost', () => 0)",
      resolver: "return new (process.getBuiltinModule('node:dns').Resolver)().resolve4('localhost', () => 0)",
      http2: "return process.getBuiltinModule('node:http2').connect('http://127.0.0.1:1')",
      server: "return process.getBuiltinModule('node:net').createServer().listen(0)",
      dgram: "return process.getBuiltinModule('node:dgram').createSocket('udp4')",
      udpSocket: "return new (process.getBuiltinModule('node:dgram').Socket)('udp4').send('x', 9, '127.0.0.1')",
      udpBind: "return new (process.getBuiltinModule('node:dgram').Socket)('udp4').bind(0)",
      // (the verifier's re-review) a raw handle send needs no patched method, only an instance: none can be made
      udpHandle: "const s = new (process.getBuiltinModule('node:dgram').Socket)('udp4'); s.bindSync({ port: 0, address: '127.0.0.1' }); return s._handle.send({}, [Buffer.from('x')], 1, 9, '127.0.0.1', false)",
    };
    for (const [k, body] of Object.entries(tries)) {
      const f = await probeOut(body);
      if (k === 'fetch') expect(f.message, k).toContain('PROBE ALLOWED undefined');
      else expect(f.message, k).toMatch(/PROBE REFUSED|ERR_ACCESS_DENIED/);
    }
  }, 180_000);

  it('sandbox: no files outside its dir (read or write), no child processes or workers, no signals, no inspector', async () => {
    const secret = path.join(root, 'secret.txt');
    const tries = {
      read: `return process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8')`,
      hosts: "return process.getBuiltinModule('node:fs').readFileSync('/etc/hosts', 'utf8')",
      write: `return process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'pwned.txt'))}, 'x')`,
      dataDir: `return process.getBuiltinModule('node:fs').readdirSync(${JSON.stringify(sc.config.dataDir)}).join()`,
      spawn: "return process.getBuiltinModule('node:child_process').spawnSync('echo', ['x']).status",
      exec: "return process.getBuiltinModule('node:child_process').execSync('echo x')",
      worker: "return new (process.getBuiltinModule('node:worker_threads').Worker)('1', { eval: true })",
      kill: 'return process.kill(process.ppid, 0)',
      rawKill: 'return process._kill(process.ppid, 0)',
      debugProcess: 'return process._debugProcess(process.ppid)',
      inspector: "return process.getBuiltinModule('node:inspector').open(0)",
      priority: "return process.getBuiltinModule('node:os').setPriority(process.ppid, 19)",
      addon: "return process.dlopen({ exports: {} }, '/usr/lib/libz.dylib')",
    };
    for (const [k, body] of Object.entries(tries)) expect((await probeOut(body)).message, k).toMatch(/PROBE REFUSED/);
    expect(fs.existsSync(path.join(root, 'pwned.txt'))).toBe(false);
    // its own dir is writable (the checker's output), and that is all
    expect((await probeOut("return typeof process.getBuiltinModule('node:fs').writeFileSync")).message).toContain('ALLOWED function');
  }, 240_000);

  it('sandbox: a live timer or a busy loop ends on the plan\'s wall clock (timeout), never hangs the session', async () => {
    const t0 = Date.now();
    expect((await probeOut('for (;;) {}')).message).toMatch(/longer than/);
    const busy = await check(COURT.replace('return r;\n}', 'for (;;) {}\n  return r;\n}'));
    expect(busy.findings.map((f) => f.rule)).toEqual(['timeout']);
    const timer = await check(`${COURT.replace('return r;\n}', "setTimeout(() => 0, 1);\n  return r;\n}")}`);
    expect(timer.findings[0]!.rule).toBe('lint');
    // a live interval keeps the child alive after its answer: the wall clock stops it, or the plan fails first; either way it ends
    expect((await probeOut("const g = process.getBuiltinModule('node:timers'); g.setInterval(() => 0, 5); return 'started'")).message).toMatch(/PROBE|longer than/);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);
});
