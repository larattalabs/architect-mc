// (GM-c) The drawbridge's steps of tools/gate7agm.mjs (docs/CONTRACT.md "Slice GM" §2's drawbridge row, §5, §7 item 9, §8, §9, §10 item 5,
// §13 item 6): cprobe (the walk probe: the probe's deck over a moat 5 wide and 3 deep, lowered and raised, judged by vanilla's villager
// navigation and the kit's player and villager walks). $0: no Claude call.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Registers the GM-c steps on `steps`. `h`: the driver's helpers (as registerGmB), plus snap, sb, fill, world, use. */
export async function registerGmC(steps, h) {
  const { L, call, check, cmd, log, root, OUT, json, stateAt, snap, sb, fill, world, use } = h;
  const KIT = path.join(root, 'kit');
  const imp = (p) => import(pathToFileURL(path.join(KIT, p)).href);
  const ensure = async () => { if (!L.state.dev) await L.connect(); };
  const wait = (ms, label) => L.gameWait(ms, { real: L.settle, label });

  /** Vanilla villager navigation and the kit's walks between two feet cells over a dump of `box`. */
  async function walks(box, from, to, claimBox, tag) {
    const v = await call('dev.nav.villager', { from, to, range: 32, cells: true }, 120_000);
    const v2 = await call('dev.nav.villager', { from: to, to: from, range: 32 }, 120_000);
    const { decodeArwd, dumpWorld } = await imp('lib/region/vworld.mjs');
    const { walkGraph, nodeReached } = await imp('lib/region/check.mjs');
    const f = path.join(OUT, `gmc-${tag}.arwd.gz`);
    await call('dev.region.dump', { box, file: f }, 600_000);
    const d = await decodeArwd(fs.readFileSync(f));
    const world = dumpWorld(d, d, claimBox);
    const out = { villager: [!!v.canReach, !!v2.canReach], path: (v.cells ?? []).map((c) => c.join(',')) };
    for (const mover of ['player', 'villager']) out[`kit_${mover}`] = nodeReached(walkGraph(world, [from], { mover }), to);
    return out;
  }

  /**
   * The walk probe (GM-c, before any GM-c build work, as GM-a's gm-probe): the probe's drawbridge (gmCircuit.drawbridgeCells, 5 cells
   * over a moat 5 wide and 3 deep, the bank buses and two levers) with the side lanes capped by fences one over the deck row, lowered
   * and raised: vanilla's villager navigation (range 32: the moat runs 80 either way, so no way round) and the kit's player and
   * villager walks from 3 before the near bank to 3 past the far one.
   */
  steps.cprobe = async () => {
    await ensure();
    const GMC = await imp('lib/connectors/gmCircuit.mjs');
    const out = {};
    const X = 7500, Z = 7000;
    const g = await world(X, Z), y = g;
    await call('dev.tp', { x: X + 2, y: g + 8, z: Z + 12 }, 30_000).catch(() => L.tp(X + 2, g + 8, Z + 12));
    const ZA = Z - 80, ZB = Z + 81;
    await fill([X, g - 4, ZA], [X + 4, g - 4, ZB], 'minecraft:stone');
    await fill([X, g - 3, ZA], [X + 4, g - 1, ZB], 'minecraft:water');
    await fill([X, g, ZA], [X + 4, g + 3, ZB], 'minecraft:air');
    for (const [i, dy, z, st] of GMC.drawbridgeCells(5, {})) await sb(X + i, y + dy, Z + z, st);
    for (const bx of [X - 2, X + 6]) {
      for (let z = -3; z <= 4; z++) await sb(bx, y + 1, Z + z, 'minecraft:redstone_wire');
      for (const z of [-3, 4]) await sb(bx === X - 2 ? X - 1 : X + 5, y + 1, Z + z, 'minecraft:redstone_wire');
    }
    // the caps: a fence over every side-lane cell (no walk along the repeaters)
    for (let i = 0; i < 5; i++) for (const z of [-3, -2, -1, 2, 3, 4]) await sb(X + i, y + 1, Z + z, 'minecraft:oak_fence');
    await sb(X - 3, y + 1, Z + 6, 'minecraft:lever[face=floor,facing=east,powered=false]');
    await sb(X - 3, y + 1, Z + 5, 'minecraft:redstone_wire');
    await sb(X - 2, y + 1, Z + 5, 'minecraft:redstone_wire');
    await wait(2000, 'gmc settles');
    const box = [X - 8, g - 5, Z - 10, X + 12, g + 4, Z + 11];
    const claimBox = { minX: box[0], minZ: box[2], maxX: box[3], maxZ: box[5], minY: box[1], maxY: box[4] };
    const from = [X - 4, y + 1, Z], to = [X + 8, y + 1, Z];
    const deck = async () => { const b = await snap(X, y, Z, X + 4, y, Z + 1); return Object.values(b).filter((v) => v.startsWith('iron_trapdoor')).map((v) => (/open=true/.test(v) ? 1 : 0)); };
    out.lowered = await walks(box, from, to, claimBox, 'lowered');
    out.deckLowered = await deck();
    log(`  cprobe lowered: ${json(out.lowered)} deck ${json(out.deckLowered)}`);
    await use([X - 3, y + 1, Z + 6]);
    await wait(1500, 'gmc raised');
    out.deckRaised = await deck();
    out.raised = await walks(box, from, to, claimBox, 'raised');
    log(`  cprobe raised: ${json(out.raised)} deck ${json(out.deckRaised)}`);
    check(out.deckLowered.length === 10 && out.deckLowered.every((v) => v === 0) && out.deckRaised.every((v) => v === 1), `cprobe: the lever (real use) raises all 10 trapdoors (${json(out.deckRaised)})`);
    check(out.lowered.villager[0] && out.lowered.villager[1] && out.lowered.kit_villager && out.lowered.kit_player, `cprobe: lowered, vanilla's villager both ways and the kit's walks cross (${json(out.lowered)})`);
    check(!out.raised.villager[0] && !out.raised.villager[1] && !out.raised.kit_villager, `cprobe: raised, vanilla's villager and the kit's villager walk do not cross (${json(out.raised)})`);
    out.kitPlayerRaised = out.raised.kit_player;
    await L.leaveWorld();
    return out;
  };
}
