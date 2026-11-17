#!/usr/bin/env node
// Gate-run slots for outside callers (Steward): docs/GATES.md "Slot lock", "Outside callers (Steward)". The code is
// tools/lib/slots.mjs over tools/lib/turbo.mjs (the queue gate-run itself uses). Works from any cwd: the slots dir is resolved from
// this file's checkout (<checkout>/../.gate-slots) or GATE_SLOTS_DIR, the config from its tools/gate-chains.json.
//
//   node tools/slot.mjs acquire --who <caller> --label <flow or step> --pid <holder pid> [--worktree <path>]
//                               [--max-wait-min N] [--no-load-wait]
//       Queues a ticket (FIFO with gate runs) and blocks until a slot is free, the load gate passes and no turbo run is queued,
//       reserving or running ahead of it; then writes the slot file held by --pid and prints {"slot","ticket",...} on stdout.
//       Waiting is logged on stderr. --max-wait-min defaults to 15 and is capped at 15 (rule 10). Exit 2 on timeout (reason on
//       stderr, with load and turbo), 3 when the holder pid is or goes dead, 1 on a usage error.
//   node tools/slot.mjs release --ticket <t>     frees only that ticket's slot (exit 4 when it holds none)
//   node tools/slot.mjs status [--json]          holders (who/worktree/label), the queue, load, turbo (queued/reserving/running)

import { acquireSlot, readGateConfig, releaseTicket, resolveSlotsDir, slotStatus } from './lib/slots.mjs';

const [cmd, ...argv] = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const die = (m, code = 1) => {
  console.error(`slot: ${m}`);
  process.exit(code);
};

const dir = resolveSlotsDir();
const cfg = readGateConfig();

if (cmd === 'acquire') {
  const who = opt('--who');
  const label = opt('--label');
  const pidArg = opt('--pid');
  if (!who) die('acquire needs --who <caller>');
  if (!label) die('acquire needs --label <flow or step>');
  if (!pidArg) die('acquire needs --pid <holder pid> (the long-lived process that holds the slot; it frees when that pid dies)');
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) die(`--pid ${pidArg}: not a pid`);
  const mw = opt('--max-wait-min');
  const maxWaitMin = mw === undefined ? undefined : Number(mw);
  if (mw !== undefined && !(maxWaitMin >= 0)) die(`--max-wait-min ${mw}: not a number of minutes`);
  if (maxWaitMin > 15) console.error(`slot: --max-wait-min ${maxWaitMin} is above rule 10's cap; clamped to 15`);
  try {
    const r = await acquireSlot(dir, { who, label, pid, worktree: opt('--worktree') ?? process.cwd(), maxWaitMin, noLoadWait: flag('--no-load-wait'), cfg });
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(0);
  } catch (e) {
    die(e.message, e.code === 'SLOT_TIMEOUT' ? 2 : e.code === 'SLOT_HOLDER_DEAD' ? 3 : 1);
  }
} else if (cmd === 'release') {
  const ticket = opt('--ticket');
  if (!ticket) die('release needs --ticket <t>');
  try {
    const r = await releaseTicket(dir, ticket);
    process.stdout.write(`${JSON.stringify({ ticket, ...r })}\n`);
    process.exit(r.released.length || r.queued ? 0 : 4);
  } catch (e) {
    die(e.message);
  }
} else if (cmd === 'status') {
  const s = slotStatus(dir, { cfg });
  if (flag('--json')) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
  } else {
    const t = s.turbo;
    console.log(`slots ${s.dir}: ${s.holders.length ? s.holders.length : 0} held, ${s.free} of ${s.limit} free`);
    for (const h of s.holders) console.log(`  slot ${h.slot}: ${h.who} ${h.label ?? ''} pid ${h.pid}${h.turbo ? ` TURBO ${h.state}` : ''} ${h.worktree ?? ''}${h.startedAt ? ` since ${h.startedAt}` : ''}`);
    for (const q of s.queue) console.log(`  queued: ${q.who} ${q.label ?? ''} pid ${q.pid}${q.turbo ? ' TURBO' : ''} ${q.ticket}`);
    console.log(`load ${s.load.load1} (gate: max1 ${s.load.max1}, settle ${s.load.settleSec} s, cap ${s.load.maxWaitMin} min)`);
    console.log(`turbo: ${t.running.length ? `running ${t.running.map((h) => h.pid).join(',')}` : ''}${t.reserving.length ? ` reserving ${t.reserving.map((h) => h.pid).join(',')}` : ''}${t.queued.length ? ` queued ${t.queued.map((h) => h.pid).join(',')}` : ''}${t.active ? '' : 'none'}`);
  }
} else {
  die('usage: node tools/slot.mjs acquire --who <caller> --label <text> --pid <pid> [--worktree <path>] [--max-wait-min N] [--no-load-wait] | release --ticket <t> | status [--json]');
}
