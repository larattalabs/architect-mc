// Slice OC (Noah, 2026-11-04; docs/PLAN.md "Occupied lots wait forever; harnesses clear the box", docs/GATES.md "Harnesses clear the box").
// A lot realise keeps its unlimited wait on OCCUPIED (a mob or a drop in the box) and PLAYER_IN_BOX. So every harness that realises lots
// clears the box itself, and no run can stall on it. One shared rule, matching Steward's e2e (`clearAnimals` and its whole-run herder):
//  - mobs and drops in the box (plus a margin) are KILLED, not moved: everything except the player and the exempt types/tags
//    (villagers always; a step that tests an entity exempts it), then dropped items and experience orbs (a drop in a lot holds it up too);
//  - the player (the dev bot) is moved just outside the box plus a margin, along the shortest way out and at its own height, so the
//    ground it stands on stays loaded;
//  - all of it is logged ("box-clear: ...") and counted;
//  - a run-wide WATCHER (tools/lib/run6b.mjs starts one on connect) looks at every region's `waiting` and does it on each OCCUPIED or
//    PLAYER_IN_BOX answer; it follows a client or server restart because it re-reads the live connection on every tick.
// The pure parts (box, selectors, targets) are unit-tested in kit/test/clear-box.test.mjs.

export const WAIT_REASONS = Object.freeze(['OCCUPIED', 'PLAYER_IN_BOX']);
/** Never removed by the clearer (a villager's route or job is often what a step tests). Steps add more through `exempt`. */
export const DEFAULT_EXEMPT_TYPES = Object.freeze(['minecraft:villager']);
export const KILL_MARGIN = 2;
export const PLAYER_MARGIN = 12;
const WORLD_Y = [-64, 320];
/** The longest walk out of a claim; farther than this the player goes up instead (playerTarget). */
export const MAX_WALK = 40;

const withNs = (t) => (String(t).includes(':') ? String(t) : `minecraft:${t}`);

/** A box from a claim: [x0,z0,x1,z1], {minX,minY,minZ,maxX,maxY,maxZ} (a vanilla BoundingBox as Gson writes it), {x0,..,z1}, or a box already normalised. Null when unreadable. */
export function normalizeBox(c) {
  if (!c) return null;
  let b = null;
  if (Array.isArray(c) && c.length === 4) b = { x0: c[0], z0: c[1], x1: c[2], z1: c[3] };
  else if (Array.isArray(c) && c.length === 6) b = { x0: c[0], y0: c[1], z0: c[2], x1: c[3], y1: c[4], z1: c[5] };
  else if (typeof c === 'object' && 'minX' in c) b = { x0: c.minX, y0: c.minY, z0: c.minZ, x1: c.maxX, y1: c.maxY, z1: c.maxZ };
  else if (typeof c === 'object' && 'x0' in c) b = { x0: c.x0, y0: c.y0, z0: c.z0, x1: c.x1, y1: c.y1, z1: c.z1 };
  if (!b || ![b.x0, b.z0, b.x1, b.z1].every(Number.isFinite)) return null;
  const y0 = Number.isFinite(b.y0) ? b.y0 : WORLD_Y[0];
  const y1 = Number.isFinite(b.y1) ? b.y1 : WORLD_Y[1];
  return { x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1), z0: Math.min(b.z0, b.z1), z1: Math.max(b.z0, b.z1) };
}

export const expandBox = (b, m) => ({ x0: b.x0 - m, x1: b.x1 + m, y0: b.y0 - m, y1: b.y1 + m, z0: b.z0 - m, z1: b.z1 + m });
export const insideBox = (b, p) => p.x >= b.x0 && p.x <= b.x1 + 1 && p.z >= b.z0 && p.z <= b.z1 + 1 && (p.y == null || (p.y >= b.y0 && p.y <= b.y1 + 2));

/** Exemption options: `types` (ids, `minecraft:` optional) and `tags` that the clear leaves alone, on top of DEFAULT_EXEMPT_TYPES. */
export function exemptions(ex = {}) {
  const types = [...new Set([...DEFAULT_EXEMPT_TYPES, ...(ex.types ?? []).map(withNs)])];
  return { types, tags: [...new Set(ex.tags ?? [])] };
}

/** The selector of everything that may be killed: not the player, not an exempt type or tag; inside `box` (null: the whole world, as Steward's clear does). */
export function mobSelector(box, ex = {}) {
  const e = exemptions(ex);
  const args = ['type=!minecraft:player', ...e.types.map((t) => `type=!${t}`), ...e.tags.map((t) => `tag=!${t}`)];
  return `@e[${[...args, ...volumeArgs(box)].join(',')}]`;
}

function volumeArgs(box) {
  if (!box) return [];
  return [`x=${Math.floor(box.x0)}`, `y=${Math.floor(box.y0)}`, `z=${Math.floor(box.z0)}`, `dx=${Math.ceil(box.x1 - box.x0) + 1}`, `dy=${Math.ceil(box.y1 - box.y0) + 1}`, `dz=${Math.ceil(box.z1 - box.z0) + 1}`];
}

/** The commands of one clear: the mobs, then what they dropped (a second pass, after the mobs' loot lands, is the caller's). */
export function killCommands(box, ex = {}) {
  const v = volumeArgs(box);
  const drops = (t) => `/kill @e[${[`type=minecraft:${t}`, ...v].join(',')}]`;
  const out = [`/kill ${mobSelector(box, ex)}`];
  if (!ex.keepItems) out.push(drops('item'), drops('experience_orb'));
  return out;
}

/** Where to put the player: null when it is clear of `box` (plus the margin); else just past the nearest edge, same height and the other axis unchanged. */
export function playerTarget(box, pos = null, margin = PLAYER_MARGIN) {
  const big = expandBox(box, 0);
  if (!pos) return { x: (box.x0 + box.x1) / 2, z: box.z1 + 1 + margin, y: null }; // unknown position: past the south edge, as Steward's herder does
  const inside = pos.x >= big.x0 - margin / 2 && pos.x <= big.x1 + 1 + margin / 2 && pos.z >= big.z0 - margin / 2 && pos.z <= big.z1 + 1 + margin / 2;
  if (!inside) return null;
  // above the claim's own height range nothing of it is in the way
  if (pos.y != null && box.y1 < WORLD_Y[1] - 20 && pos.y > box.y1 + 4) return null;
  const d = [
    { x: big.x0 - margin, z: pos.z, away: pos.x - big.x0 },
    { x: big.x1 + 1 + margin, z: pos.z, away: big.x1 + 1 - pos.x },
    { x: pos.x, z: big.z0 - margin, away: pos.z - big.z0 },
    { x: pos.x, z: big.z1 + 1 + margin, away: big.z1 + 1 - pos.z },
  ].sort((a, b) => a.away - b.away)[0];
  // a big claim (a mega region, a scenario) has its edge far away: the way out would unload the ground of the lots still to place. Then the
  // player goes straight up past the claim's top instead (same x and z, so the same chunks stay loaded).
  if (d.away + margin > MAX_WALK && pos.y != null && box.y1 < WORLD_Y[1] - 20) return { x: pos.x, z: pos.z, y: box.y1 + 8 };
  return { x: d.x, z: d.z, y: pos.y ?? null };
}

/** The reason a region view or a dev.region.state answer waits on, among WAIT_REASONS, else null. Reads the three shapes the drivers see. */
export function waitReason(st) {
  const r = st?.view?.waiting?.reason ?? st?.waiting?.reason ?? null;
  if (WAIT_REASONS.includes(r)) return r;
  for (const k of WAIT_REASONS) if (st?.waiting && typeof st.waiting === 'object' && st.waiting[k]) return k;
  return null;
}

/** `/data get entity @p Pos` text -> {x,y,z}, or null. */
export function parsePos(text) {
  const m = String(text ?? '').match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

/**
 * The clearer. `cmd(string)` runs a server command and answers {messages?}; `log(string)` logs. Everything it did is in `stats`.
 * `exempt` (types, tags) and `pause()` let a step that tests an entity, or a wait itself, keep the clearer off it.
 */
export function createClearer({ cmd, log = () => {}, settle = async () => {}, minGapMs = 3_000, now = () => Date.now(), spawnOff = false }) {
  const stats = { clears: 0, playerMoves: 0, killedCmds: 0, byReason: {}, events: [] };
  const state = { paused: 0, types: new Set(), tags: new Set(), last: new Map() };
  const ex = () => ({ types: [...state.types], tags: [...state.tags] });
  const note = (e) => { if (stats.events.length < 40) stats.events.push(e); };

  async function clearMobs(box, why) {
    const e = ex();
    const cmds = killCommands(box, e);
    for (const c of cmds.slice(0, 1)) await cmd(c);
    await settle(1000); // the killed mobs' loot lands a moment later
    for (const c of cmds.slice(1)) await cmd(c);
    stats.clears++;
    stats.killedCmds += cmds.length;
    log(`box-clear: ${why}: killed mobs and drops ${box ? `in the box ${fmt(box)}` : 'everywhere'}${e.types.length > 1 || e.tags.length ? ` (kept ${[...e.types, ...e.tags.map((t) => `#${t}`)].join(', ')})` : ''}`);
  }

  async function movePlayer(box, why) {
    let pos = null;
    try { pos = parsePos(JSON.stringify((await cmd('/data get entity @p Pos'))?.messages ?? '')); } catch { /* unknown */ }
    const t = playerTarget(box, pos);
    if (!t) return false;
    await cmd(`/tp @p ${t.x} ${t.y == null ? '~' : t.y} ${t.z}`);
    stats.playerMoves++;
    log(`box-clear: ${why}: moved the player ${pos ? `from ${Math.round(pos.x)},${Math.round(pos.y ?? 0)},${Math.round(pos.z)} ` : ''}to ${Math.round(t.x)},${t.y == null ? '~' : Math.round(t.y)},${Math.round(t.z)}, outside the box ${fmt(box)}`);
    return true;
  }

  const api = {
    stats,
    /** Leave these types (`minecraft:` optional) and tags alone while `fn` runs (or until the returned function is called). */
    exempt({ types = [], tags = [] } = {}, fn = null) {
      const t = types.map(withNs);
      t.forEach((x) => state.types.add(x));
      tags.forEach((x) => state.tags.add(x));
      const off = () => { t.forEach((x) => state.types.delete(x)); tags.forEach((x) => state.tags.delete(x)); };
      if (!fn) return off;
      return Promise.resolve().then(fn).finally(off);
    },
    /** A step that tests the wait itself (a mob that must hold a lot up): the clearer does nothing while `fn` runs. */
    pause(fn = null) {
      state.paused++;
      const off = () => { state.paused = Math.max(0, state.paused - 1); };
      if (!fn) return off;
      return Promise.resolve().then(fn).finally(off);
    },
    get paused() { return state.paused > 0; },
    /** Before a realise: the claim's box cleared of mobs and drops, the player out of it. */
    async preClear(claim, why = 'before the realise') {
      if (state.paused) return false;
      const box = normalizeBox(claim);
      // natural spawning off, only in the worlds a harness owns (its caller says so with spawnOff): a polar bear that spawned onto a lot stalled a run
      if (spawnOff) await cmd('/gamerule spawn_mobs false');
      await clearMobs(box && expandBox(box, KILL_MARGIN), why);
      if (box) await movePlayer(box, why);
      return true;
    },
    /** On a waiting answer (a dev.region.state answer or a RegionView; `region` names it in the log). Returns the reason it acted on. */
    async onState(st, region = st?.view?.id ?? '?') {
      const reason = waitReason(st);
      if (!reason || state.paused) return null;
      const t = now();
      if (t - (state.last.get(region) ?? -1e9) < minGapMs) return null;
      state.last.set(region, t);
      const raw = st?.view?.claim ?? st?.claim ?? null;
      const box = normalizeBox(raw);
      stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
      note({ region, reason, message: st?.view?.waiting?.message ?? null, at: new Date(t).toISOString() });
      const why = `${region} waits ${reason}`;
      if (reason === 'OCCUPIED') await clearMobs(box && expandBox(box, KILL_MARGIN), why);
      else {
        // PLAYER_IN_BOX; the bot moves out, and an unreadable claim means the player goes up and a mob clear is the old fallback
        if (box) await movePlayer(box, why);
        else {
          await cmd('/tp @p ~ ~48 ~');
          stats.playerMoves++;
          log(`box-clear: ${why}: no claim in the answer: moved the player 48 blocks up`);
        }
      }
      return reason;
    },
  };
  return api;
}

const fmt = (b) => `[${Math.round(b.x0)},${Math.round(b.z0)} .. ${Math.round(b.x1)},${Math.round(b.z1)}]`;

/**
 * The run-wide watcher: every `intervalMs` it lists the regions (`list()` -> RegionView[]) and clears any that wait OCCUPIED or
 * PLAYER_IN_BOX. `list` reads the live connection each time (a restart's new client is picked up, logged as re-armed); a failed
 * tick (the game restarting, a closed socket) is skipped. Timers are unref'd: the watcher never keeps a driver alive.
 */
export function createWatcher({ list, clearer, log = () => {}, intervalMs = 6_000, identity = () => null }) {
  let timer = null;
  let busy = false;
  let lastId;
  const w = {
    ticks: 0,
    rearmed: 0,
    async tick() {
      if (busy || clearer.paused) return;
      busy = true;
      try {
        const id = identity();
        if (id !== lastId) {
          if (lastId !== undefined && id) { w.rearmed++; log('box-clear: watcher re-armed on the new client'); }
          lastId = id;
        }
        const views = await list();
        w.ticks++;
        for (const v of views ?? []) if (waitReason({ view: v })) await clearer.onState({ view: v }, v.id);
      } catch { /* the game is restarting or the socket closed: next tick */ }
      finally { busy = false; }
    },
    start() {
      if (timer) return w;
      timer = setInterval(() => { w.tick(); }, intervalMs);
      timer.unref?.();
      return w;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get running() { return !!timer; },
  };
  return w;
}
