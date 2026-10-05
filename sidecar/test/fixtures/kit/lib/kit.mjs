// Test fixture: a tiny stand-in for the real kit (docs/CONTRACT.md "Kit CLI"). A "Blueprint" here is
// a plain object; build.mjs turns it into a fake .nbt and the sidecar JSON.
export function blueprint(o) {
  return {
    groundY: 1,
    front: 'south',
    foundationBlock: 'minecraft:cobblestone',
    approach: { length: 3, width: 3, block: 'minecraft:dirt_path' },
    anchors: {
      entrance: { x: Math.floor(o.size.x / 2) + 0.5, y: 1, z: o.size.z - 1.5, yaw: 0, pitch: 0 },
      spawn: { x: Math.floor(o.size.x / 2) + 0.5, y: 1, z: o.size.z + 1.5, yaw: 180, pitch: 0 },
    },
    tags: [],
    materials: ['minecraft:spruce_log'],
    ...o,
  };
}
