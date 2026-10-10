// Slice 0b gate item 2: the kit's mirror table equals vanilla's BlockState.mirror (the oracle fixture written by the mod's
// MirrorOracleTest), for every state of every block, both mirrors; and mirrorBlueprint keeps `front` and maps the cells,
// anchors, ports and interior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS } from '../lib/blocks.mjs';
import { mirrorAxisOf, mirrorBlueprint, mirrorProps } from '../lib/mirror.mjs';
import { Blueprint } from '../lib/kit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORACLE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'mirror-oracle.json'), 'utf8'));

function stateAt(props, i) {
  const out = {};
  for (let k = props.length - 1; k >= 0; k--) {
    const [name, vals] = props[k];
    out[name] = vals[i % vals.length];
    i = Math.floor(i / vals.length);
  }
  return out;
}

function indexOf(props, state) {
  let idx = 0;
  for (const [name, vals] of props) {
    const j = vals.indexOf(state[name]);
    if (j < 0) return -1;
    idx = idx * vals.length + j;
  }
  return idx;
}

const count = (props) => props.reduce((n, [, v]) => n * v.length, 1);

test('the oracle covers every kit block', () => {
  const listed = new Set([...ORACLE.identity, ...ORACLE.classes.flatMap((c) => c.blocks)]);
  const missing = Object.keys(BLOCKS).filter((b) => !listed.has(b));
  assert.deepEqual(missing, []);
});

test('the kit mirror table equals vanilla for every state (FRONT_BACK and LEFT_RIGHT)', () => {
  const bad = [];
  for (const c of ORACLE.classes) {
    const n = count(c.props);
    for (const block of c.blocks) {
      const dom = BLOCKS[block]?.props ?? {};
      // the kit's domains are vanilla's
      assert.deepEqual(Object.keys(dom).sort(), c.props.map(([k]) => k), block);
      for (const [k, vals] of c.props) assert.deepEqual([...dom[k]].sort(), [...vals].sort(), `${block} ${k}`);
      for (let i = 0; i < n; i++) {
        const s = stateAt(c.props, i);
        for (const [axis, want] of [['x', c.fb], ['z', c.lr]]) {
          const got = indexOf(c.props, mirrorProps(block, s, axis));
          if (got !== want[i]) bad.push(`${block}[${Object.entries(s).map(([k, v]) => `${k}=${v}`).join(',')}] ${axis === 'x' ? 'FRONT_BACK' : 'LEFT_RIGHT'}: kit ${JSON.stringify(stateAt(c.props, got))} vanilla ${JSON.stringify(stateAt(c.props, want[i]))}`);
        }
      }
    }
  }
  assert.equal(bad.length, 0, `${bad.length} state(s) differ, e.g.\n${bad.slice(0, 12).join('\n')}`);
});

test('blocks vanilla never changes stay unchanged', () => {
  const bad = [];
  for (const block of ORACLE.identity) {
    const dom = Object.entries(BLOCKS[block]?.props ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    const n = count(dom);
    for (let i = 0; i < n; i++) {
      const s = stateAt(dom, i);
      for (const axis of ['x', 'z']) if (JSON.stringify(mirrorProps(block, s, axis)) !== JSON.stringify(s) && indexOf(dom, mirrorProps(block, s, axis)) !== i) bad.push(`${block} ${JSON.stringify(s)} ${axis}`);
    }
  }
  assert.deepEqual(bad.slice(0, 10), []);
});

test('mirrorBlueprint: front kept, cells, anchors, ports and the interior mapped', () => {
  const bp = new Blueprint({ id: 'm', size: [5, 3, 4], front: 'south', interior: [1, 1, 1, 2, 2, 2] });
  bp.part('main', (b) => b.set(0, 1, 1, 'minecraft:oak_stairs', { facing: 'east', shape: 'outer_left' }));
  bp.spot('entrance', 1, 3, 0);
  bp.anchor('cam_x', 0.5, 2, 0.5, 45, 10);
  bp.port('out', 'item_out', 0, 1, 2, 'west');
  mirrorBlueprint(bp);
  assert.equal(bp.front, 'south');
  assert.equal(mirrorAxisOf('south'), 'x');
  assert.equal(mirrorAxisOf('east'), 'z');
  const c = bp.get(4, 1, 1);
  assert.equal(c.state.props.facing, 'west');
  assert.equal(c.state.props.shape, 'outer_right');
  assert.equal(bp.cellPart.get('4,1,1'), 'main');
  assert.equal(bp.anchors.entrance.x, 3.5);
  assert.equal(bp.anchors.cam_x.yaw, -45);
  assert.deepEqual([bp.ports[0].x, bp.ports[0].facing], [4, 'east']);
  assert.deepEqual([bp.interiorBox.minX, bp.interiorBox.maxX], [2, 3]);
  // twice is the identity
  mirrorBlueprint(bp);
  assert.equal(bp.get(0, 1, 1).state.props.shape, 'outer_left');
  assert.equal(bp.anchors.cam_x.yaw, 45);
});

test('mirrorBlueprint on an east front flips z', () => {
  const bp = new Blueprint({ id: 'm', size: [3, 3, 6], front: 'east' });
  bp.set(1, 1, 0, 'minecraft:oak_door', { facing: 'north', half: 'lower', hinge: 'left' });
  bp.anchor('a', 1.5, 1, 0.5, 30);
  mirrorBlueprint(bp);
  const c = bp.get(1, 1, 5);
  assert.equal(c.state.props.facing, 'south');
  assert.equal(c.state.props.hinge, 'right');
  assert.equal(bp.anchors.a.z, 5.5);
  assert.equal(bp.anchors.a.yaw, 150);
});
