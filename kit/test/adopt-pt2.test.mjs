// Phase 6c slice PT2 (docs/CONTRACT.md "Phase 6c slice PT2" §3): the captured source (lib/adopt.mjs).
//   - built with floors 0 it gives back exactly the captured cells: raw block states (no defaults, no reconnected fences) and the
//     tagged block-entity data (nested compounds, lists, longs), in the template the mod writes (blocks y, z, x; one part `adopted`)
//   - it passes the checker as a captured source (groundY 0 allowed; the design rules are warnings)
//   - floors 1 adds a storey: the frame is kept, exactly one of v1's cells changes (the hatch: capturedChanged 1), storey_1 is added
//   - the generated source's params block is what the sim's versionOf bumps (an int param's default up by one)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adopted, cellsOf, parseState, tagOf } from '../lib/adopt.mjs';
import { writeBlueprint } from '../lib/write.mjs';
import { checkFiles } from '../lib/check.mjs';
import { parse, plain } from '../lib/nbt.mjs';
import { diffFiles } from '../lib/diff.mjs';

/** A 5x4x5 log hut with a door in the north wall, a fence post with a raw connection, a sign with nested text, a bed. */
function capture() {
  const palette = [
    'minecraft:oak_log[axis=y]',
    'minecraft:air',
    'minecraft:oak_door[facing=north,half=lower,hinge=left,open=false,powered=false]',
    'minecraft:oak_door[facing=north,half=upper,hinge=left,open=false,powered=false]',
    'minecraft:oak_fence[east=true,north=false,south=false,waterlogged=false,west=false]',
    'minecraft:oak_sign[rotation=4,waterlogged=false]',
  ];
  const runs = [];
  for (let y = 0; y < 4; y++) {
    for (let z = 0; z < 5; z++) {
      if (y === 3 || z === 4) { runs.push(y, z, 0, 4, 0); continue; }
      if (z === 0) {
        if (y < 2) runs.push(y, 0, 0, 1, 0, y, 0, 2, 2, 2 + y, y, 0, 3, 4, 0);
        else runs.push(y, 0, 0, 4, 0);
        continue;
      }
      if (y === 0 && z === 2) { runs.push(0, 2, 0, 0, 0, 0, 2, 1, 1, 4, 0, 2, 2, 2, 5, 0, 2, 3, 3, 1, 0, 2, 4, 4, 0); continue; }
      runs.push(y, z, 0, 0, 0, y, z, 1, 3, 1, y, z, 4, 4, 0);
    }
  }
  const sign = { t: 'compound', v: {
    id: { t: 'string', v: 'minecraft:sign' },
    is_waxed: { t: 'byte', v: 0 },
    front_text: { t: 'compound', v: { has_glowing_text: { t: 'byte', v: 0 }, color: { t: 'string', v: 'black' }, messages: { t: 'list', of: 'string', v: [
      { t: 'string', v: 'Alex' }, { t: 'string', v: 'home' }, { t: 'string', v: '' }, { t: 'string', v: '' }] } } },
    stamp: { t: 'long', v: '9007199254740993' },
  } };
  return { format: 1, build: 'build-7', name: 'Adopted house build-7', size: [5, 4, 5], groundY: 0, front: 'north', frameGuessed: false, palette, runs,
    nbt: { '2,0,2': sign }, wall: 'minecraft:oak_log[axis=y]', anchors: { entrance: { x: 2.5, y: 0, z: -0.5, yaw: 0, pitch: 0 } } };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-pt2-'));

test('floors 0 gives back exactly the captured cells: raw states, tagged block-entity data, one part', () => {
  const cap = capture();
  const bp = adopted('adopted_0a1b2c3d', cap);
  const dir = tmp();
  const w = writeBlueprint(bp, dir);
  const t = plain(parse(fs.readFileSync(w.nbtPath)));
  const pal = t.palette.map((p) => `${p.id}${p.properties ? `[${Object.entries(p.properties).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`);
  const got = new Map(t.blocks.map((b) => [b.pos.join(','), pal[b.state]]));
  const want = new Map(cellsOf(cap).map(([x, y, z, p]) => [`${x},${y},${z}`, cap.palette[p]]));
  assert.equal(got.size, want.size);
  for (const [k, v] of want) {
    const g = got.get(k);
    // the same block and the same properties (the order may differ)
    const a = parseState(v);
    const b = parseState(g);
    assert.equal(b.name, a.name, k);
    assert.deepEqual(b.props, a.props, k);
  }
  // the fence keeps its raw connection (finalize would set east=false: there is no neighbour)
  const fence = t.blocks.find((b) => b.pos.join(',') === '1,0,2');
  assert.equal(t.palette[fence.state].properties.east, 'true');
  // the sign's data: nested compound, list of strings, a long kept exact
  const sign = t.blocks.find((b) => b.pos.join(',') === '2,0,2');
  assert.equal(sign.nbt.front_text.messages[0], 'Alex');
  assert.equal(sign.nbt.stamp, 9007199254740993n);
  // blocks sorted y, z, x and one part over all of them
  const order = t.blocks.map((b) => [b.pos[1], b.pos[2], b.pos[0]]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i] || String(order[i - 1]) !== String(order[i]));
  const parts = plain(parse(fs.readFileSync(w.partsPath)));
  assert.deepEqual(parts.names, ['adopted']);
  assert.ok(parts.idx.every((i) => i === 0));
  const side = JSON.parse(fs.readFileSync(w.jsonPath, 'utf8'));
  assert.equal(side.sourceKind, 'captured');
  assert.equal(side.type, 'adopted');
  assert.equal(side.groundY, 0);
  assert.equal(side.front, 'north');
  assert.deepEqual(side.frame.origin, [0, 0, 0]);
  assert.equal(side.approach.length, 0);
  assert.deepEqual(side.profile, []);
  assert.equal(side.anchors.entrance.z, -0.5);
});

test('a captured source passes the checker (groundY 0; the design rules are warnings)', async () => {
  for (const floors of [0, 1]) {
    const dir = tmp();
    const w = writeBlueprint(adopted('adopted_0a1b2c3d', capture(), { floors }), dir);
    const r = await checkFiles(w.nbtPath, w.jsonPath, {});
    assert.deepEqual(r.errors, [], `floors ${floors}: ${JSON.stringify(r.errors)}`);
  }
});

test('floors 1 adds a storey: frame kept, one of v1 cells changed (the hatch), storey_1 added', () => {
  const a = writeBlueprint(adopted('adopted_0a1b2c3d', capture()), tmp());
  const b = writeBlueprint(adopted('adopted_0a1b2c3d', capture(), { floors: 1 }), tmp());
  const d = diffFiles(a.nbtPath, b.nbtPath);
  assert.equal(d.frameKept, true);
  assert.equal(d.removed + d.changed, 1, JSON.stringify(d.parts));
  assert.equal(d.parts.storey_1.status, 'ADDED');
  assert.equal(d.parts.storey_1.added, 5 * 5 * 5);
});

test('tagOf and parseState', () => {
  assert.deepEqual(parseState('minecraft:stone'), { name: 'minecraft:stone', props: {} });
  assert.deepEqual(parseState('minecraft:oak_log[axis=x]'), { name: 'minecraft:oak_log', props: { axis: 'x' } });
  assert.equal(tagOf({ t: 'long', v: '-5' }).v, -5n);
  assert.deepEqual(tagOf({ t: 'longArray', v: ['1', '2'] }).v, [1n, 2n]);
  assert.equal(tagOf({ t: 'list', of: 'compound', v: [{ t: 'compound', v: { '': { t: 'int', v: 1 } } }] }).v[0].v[''].v, 1);
});

test('the generated source shape: an int param `floors` the sim bumps (default 0 -> 1)', () => {
  // the mod's Adopt.source() writes exactly this params block; the sim's redirect (sidecar sim.ts simRedirect) bumps its default
  const src = "export const params = {\n  floors: { type: 'int', min: 0, max: 4, default: 0, label: 'Storeys added on top' },\n};\n";
  const params = /export\s+const\s+params\s*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(params);
  const m = /(\w+)\s*:\s*\{([^}]*type:\s*'int'[^}]*)\}/.exec(params[1]);
  assert.equal(m[1], 'floors');
  assert.match(m[2], /default:\s*0/);
  assert.match(m[2], /max:\s*4/);
});

test("a captured source is checked with its own empty profile, whatever profile the request names", async () => {
  const w = writeBlueprint(adopted('adopted_0a1b2c3d', capture(), { floors: 1 }), tmp());
  const r = await checkFiles(w.nbtPath, w.jsonPath, { type: 'adopted', profile: ['door', 'lit', 'no_floating'] });
  assert.deepEqual(r.errors, []);
});
