#!/usr/bin/env node
// Phase 5a UI submit paths end to end (docs/CONTRACT.md "Phase 5a contract", "UI") against a running dev client with the
// sim sidecar (tools/run-apitest-client.sh --sim): the Design tab with "Critique and revise" (rounds in the Designs tab, the
// entry's scores in the Library), the set dialog with critique, and Massing first plus critique (no critique on the
// massing, critique on the detail pass). Sim verdicts are scripted in the notes (`sim:critique=5/8`). Screenshots go to the
// client's ARCHITECT_SHOTS_DIR (prefix P5A_SHOTS, default mod-p5a-ui); evidence to artifacts/gate5a/p5a-ui.json.
//
//   ARCHITECT_DEV_PORT=8893 node tools/p5a-ui.mjs [step...]    steps: design set massing setmassing (default: all)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevClient } from './lib/devclient.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.P5A_OUT ? path.resolve(process.env.P5A_OUT) : path.join(root, 'artifacts', 'gate5a');
fs.mkdirSync(OUT, { recursive: true });
const PREFIX = process.env.P5A_SHOTS ?? 'mod-p5a-ui';
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ['design', 'set', 'massing', 'setmassing'];
const dev = await DevClient.connect({ timeoutMs: 120_000 });
const call = (type, payload = {}, timeoutMs) => dev.call(type, payload, timeoutMs ? { timeoutMs } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { shots: [] };
let failures = 0;
const check = (ok, m, data) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${m}`);
  if (!ok) failures++;
  results[m] = { ok, ...(data === undefined ? {} : { data }) };
  return ok;
};
const shot = async (name) => {
  const s = await call('dev.screenshot', { name: `${PREFIX}-${name}` }, 120_000);
  results.shots.push(s.path);
  console.log(`     shot ${s.path}`);
};
const until = async (what, fn, ms = 180_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timed out: ${what}`);
};
const sidecar = () => call('dev.sidecar.state');
/** the sidecar's own records (requests with their critique), from its state.json */
const STATE = process.env.P5A_SIDECAR_STATE ?? path.join(root, 'mod', 'run', 'architect', 'sidecar-data', 'state.json');
const record = (id) => JSON.parse(fs.readFileSync(STATE, 'utf8')).designs.find((d) => d.id === id);
const designDone = (id) => until(`design ${id} done`, async () => {
  await sleep(300);
  const d = record(id);
  return d && ['done', 'failed', 'cancelled'].includes(d.status) ? d : null;
});
const designOf = async (id) => (await sidecar()).designs.find((d) => d.id === id);

await call('dev.screen', { open: null }).catch(() => null);

if (steps.includes('design')) {
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'rustic', size: 'M', name: 'Critic Cabin', notes: 'sim:critique=5/8', critique: true, maxRevisions: 2 });
  await sleep(1500);
  const st = await call('dev.design.state');
  check(st.form?.critique === true && st.form?.critiqueSpec?.mode === 'loop' && st.form?.critiqueSpec?.maxRevisions === 2, 'Design tab: the toggle on, critique loop with 2 revisions', st.form?.critiqueSpec);
  check(/with critique \$/.test(st.form?.estimate ?? ''), `Design tab: the estimate with critique ("${st.form?.estimate}")`);
  await shot('design-tab-critique');
  const sent = await call('dev.design.submit', {}, 30_000);
  const id = sent.sent?.designId;
  check(!!id, `Design it -> ${id}`, sent.sent);
  const d = await designDone(id);
  check(d.request?.critique?.mode === 'loop', 'the sent request carries the critique', d.request?.critique);
  check(d.status === 'done' && d.critique?.end === 'ship' && d.critique?.best === 1 && d.critique?.rounds?.length === 2, `the loop ran: ${d.critique?.rounds?.length} rounds, end ${d.critique?.end}, best ${d.critique?.best}`, d.critique);
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${id}` }).catch(() => null);
  await sleep(600);
  const ui = await call('dev.ui.state');
  results.designsTab = { controls: (ui.controls ?? []).length, note: 'the rounds are drawn text: see the designs-tab-rounds screenshot' };
  await shot('designs-tab-rounds');
  await call('dev.ui.open', { tab: 'library' });
  await sleep(600);
  await shot('library-tab');
  results.design = { id, entry: d.blueprintId };
}

if (steps.includes('set')) {
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.set.open');
  await call('dev.set.fill', { name: 'Critic hamlet', bible: 'oak', items: [{ type: 'cabin', name: 'Hut A', notes: 'sim:critique=5/8' }, { type: 'tower', name: 'Tower B', notes: 'sim:critique=8' }], concurrency: 2, critique: true, maxRevisions: 1, massingFirst: false });
  await sleep(1500);
  const ss = await call('dev.set.state');
  check(ss.request?.critique?.mode === 'loop' && ss.request?.critique?.maxRevisions === 1, 'set dialog: the group request carries critique loop with 1 revision', ss.request?.critique);
  await shot('set-dialog-critique');
  const sub = await call('dev.set.submit', {}, 30_000);
  const gid = sub.groupId;
  check(/^g\d+$/.test(gid ?? ''), `Design the set -> ${gid}`, sub);
  const g = await until('the set done', async () => {
    const x = (await sidecar()).groups.find((q) => q.id === gid);
    return x && ['done', 'failed'].includes(x.status) ? x : null;
  });
  const sc = await sidecar();
  const items = g.items.map((it) => ({ key: it.itemKey, critique: it.critique, request: record(it.designId)?.request?.critique }));
  check(g.status === 'done' && items.every((i) => i.request?.mode === 'loop' && i.critique?.end), `both items looped (${items.map((i) => `${i.key}: ${i.critique?.rounds} rounds, ${i.critique?.end}`).join('; ')})`, items);
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${gid}` }).catch(() => null);
  await sleep(600);
  await shot('designs-set-critique');
  results.set = { gid, items };
}

if (steps.includes('massing')) {
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.design.fill', { reset: true, buildingType: 'cabin', style: 'rustic', size: 'L', name: 'Massed Cabin', notes: 'sim:critique=5/8', critique: true, maxRevisions: 1, massingFirst: true });
  await sleep(1000);
  const st = await call('dev.design.state');
  check(st.form?.massingFirst === true && st.form?.critique === true, 'Design tab: massing first and critique both on', st.form);
  const sent = await call('dev.design.submit', {}, 30_000);
  const mid = sent.sent?.designId;
  const m = await until(`massing ${mid} recorded`, async () => {
    await sleep(300);
    return record(mid);
  });
  check(!!m?.request?.massing && !m.request.critique, `the massing job ${mid} has no critique`, m?.request);
  await call('dev.screen', { open: null });
  await until('the massing review', async () => (await call('dev.massing.state')).review);
  const before = new Set((await sidecar()).designs.map((d) => d.id));
  const ka = await call('dev.massing.key', { key: 'enter' });
  check(ka.consumed, 'Enter approves the massing');
  const det = await until('the detail pass done', async () => {
    await sleep(300);
    const x = JSON.parse(fs.readFileSync(STATE, 'utf8')).designs.find((d) => !before.has(d.id) && d.request?.fromMassing);
    return x && ['done', 'failed'].includes(x.status) ? x : null;
  });
  check(det.request?.critique?.mode === 'loop' && det.critique?.end === 'ship' && det.critique?.rounds?.length === 2, `the detail pass ${det.id} carries the critique and looped (${det.critique?.rounds?.length} rounds, ${det.critique?.end})`, { request: det.request?.critique, critique: det.critique });
  results.massing = { massing: mid, detail: det.id };
}

if (steps.includes('setmassing')) {
  // a set with massing first and critique: the massings carry none, the detail passes do
  await call('dev.ui.open', { tab: 'design' });
  await call('dev.set.open');
  await call('dev.set.fill', { name: 'Massed hamlet', bible: 'oak', items: [{ type: 'cabin', name: 'Hut C', notes: 'sim:critique=5/8' }, { type: 'cabin', name: 'Hut D', notes: 'sim:critique=8' }], concurrency: 2, critique: true, maxRevisions: 1, massingFirst: true });
  await sleep(1200);
  const sub = await call('dev.set.submit', {}, 30_000);
  const gid = sub.groupId;
  const aw = await until('the set awaits approval', async () => {
    const x = (await sidecar()).groups.find((q) => q.id === gid);
    return x?.status === 'awaiting_approval' && x.awaiting?.length === 2 ? x : null;
  });
  check(aw.items.every((it) => !record(it.designId)?.request?.critique), 'the set\'s massings carry no critique', aw.items.map((it) => record(it.designId)?.request?.critique ?? null));
  await call('dev.ui.open', { tab: 'designs' });
  await call('dev.ui.click', { control: `design:${gid}` }).catch(() => null);
  await sleep(500);
  await call('dev.ui.click', { control: 'group:approve_all' });
  const g = await until('the set done', async () => {
    const x = (await sidecar()).groups.find((q) => q.id === gid);
    return x && ['done', 'failed'].includes(x.status) ? x : null;
  });
  const det = g.items.map((it) => ({ key: it.itemKey, stage: it.stage, critique: it.critique, request: record(it.designId)?.request?.critique ?? null }));
  check(g.status === 'done' && det.every((i) => i.stage === 'detail' && i.request?.mode === 'loop' && i.critique?.end), `the detail passes carry the critique and looped (${det.map((i) => `${i.key}: ${i.critique?.rounds} rounds, ${i.critique?.end}`).join('; ')})`, det);
  results.setmassing = { gid, det };
}

fs.writeFileSync(path.join(OUT, 'p5a-ui.json'), JSON.stringify(results, null, 2));
console.log(failures ? `${failures} FAIL` : 'all ok');
process.exit(failures ? 1 : 0);
