// tools/lib/sprint.mjs: the sprinted game-time waits (docs/GATES.md "Sprinted game-time waits"), against a fake host whose game
// time advances only while a /tick sprint runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTicks, gameWait } from '../../tools/lib/sprint.mjs';

/** A fake DevBridge host: `headless`, a game time that a sprint moves `rate` ticks per poll, the commands it was sent. */
function host({ headless = true, rate = 500, frozen = false } = {}) {
  const h = { t: 1000, left: 0, sent: [], logs: [] };
  h.cmd = async (c) => {
    h.sent.push(c);
    if (c === '/time query gametime') {
      if (!frozen && h.left > 0) { const d = Math.min(rate, h.left); h.t += d; h.left -= d; }
      return { success: true, messages: [`The time is ${h.t}`], result: h.t };
    }
    const m = /^\/tick sprint (\d+)$/.exec(c);
    if (m) h.left = Number(m[1]);
    if (c === '/tick sprint stop') h.left = 0;
    return { success: true, messages: [] };
  };
  h.call = async (type) => (type === 'dev.ping' ? { pong: true, ...(headless ? { headless: true } : {}) } : {});
  h.log = (s) => h.logs.push(s);
  return h;
}

test('a sprint advances the asked ticks and never runs the real wait', async () => {
  const h = host();
  let real = 0;
  const w = await gameWait(h, 120_000, async () => { real++; }, { label: 'stand' });
  assert.equal(real, 0);
  assert.equal(w.mode, 'sprint');
  assert.ok(w.ticks >= 2400);
  assert.ok(h.sent.includes('/tick sprint 2400'));
  assert.ok(!h.sent.includes('/tick sprint stop'));
  assert.match(h.logs[0], /^ {2}\(sprint\) stand: 2400 ticks/);
});

test('GATE_SPRINT=0 runs exactly the original wait, with its ms, and sends no tick command', async () => {
  const h = host();
  const was = process.env.GATE_SPRINT;
  process.env.GATE_SPRINT = '0';
  try {
    const got = [];
    const w = await gameWait(h, 30_000, async (ms) => { got.push(ms); });
    assert.deepEqual(got, [30_000]);
    assert.equal(w.mode, 'real');
    assert.ok(!h.sent.some((c) => c.startsWith('/tick')));
  } finally {
    if (was === undefined) delete process.env.GATE_SPRINT; else process.env.GATE_SPRINT = was;
  }
});

test('a client host (not headless) and sprint: false wait in real time', async () => {
  for (const [h, o] of [[host({ headless: false }), {}], [host(), { sprint: false }]]) {
    const got = [];
    await gameWait(h, 5000, async (ms) => { got.push(ms); }, o);
    assert.deepEqual(got, [5000]);
    assert.ok(!h.sent.some((c) => c.startsWith('/tick')));
  }
});

test('a frozen game: the sprint is stopped at the cap and the remaining ticks are waited in real time', async () => {
  const h = host({ frozen: true });
  const got = [];
  const w = await gameWait(h, 5000, async (ms) => { got.push(ms); }, { capMs: 300 });
  assert.equal(w.mode, 'sprint+real');
  assert.deepEqual(got, [5000]);
  assert.ok(h.sent.includes('/tick sprint stop'));
  assert.ok(h.logs.some((l) => /SPRINT INCOMPLETE/.test(l)));
});

test('a slow sprint that gets part way: only the rest is waited in real time', async () => {
  const h = host({ rate: 20 });
  const got = [];
  const w = await gameWait(h, 5000, async (ms) => { got.push(ms); }, { capMs: 200 });
  assert.equal(w.mode, 'sprint+real');
  assert.equal(got.length, 1);
  assert.ok(got[0] < 5000 && got[0] > 0 && got[0] % 50 === 0);
});
