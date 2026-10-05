// Test fixture: a tiny stand-in for the real kit's lib/massing.mjs (docs/CONTRACT.md "Kit: massing designs").
// massing({ id, name, type }) -> m; m.mass(name, [x0,y0,z0,x1,y1,z1], { roof, ridge, storeys }), m.opening(name, face,
// at, size), m.stilts(name, box, spacing); m.build() returns a Blueprint with `massing: true`, its `parts` and the size of
// the masses' bounding box.
import { blueprint } from './kit.mjs';

export function massing(o) {
  const parts = {};
  const openings = {};
  const m = {
    mass(name, box, opts = {}) {
      const [x0, y0, z0, x1, y1, z1] = box;
      parts[name] = { box, cells: (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1), roof: opts.roof ?? 'gable', ...(opts.ridge ? { ridge: opts.ridge } : {}), ...(opts.storeys ? { storeys: opts.storeys } : {}) };
      return m;
    },
    opening(name, face, at, size) {
      openings[name] = { face, at, size };
      return m;
    },
    stilts(name, box, spacing) {
      const [x0, y0, z0, x1, y1, z1] = box;
      parts[name] = { box, cells: Math.ceil(((x1 - x0 + 1) * (z1 - z0 + 1)) / (spacing * spacing)) * (y1 - y0 + 1), roof: 'none', stilts: spacing };
      return m;
    },
    build() {
      const boxes = Object.values(parts).map((p) => p.box);
      const size = { x: Math.max(...boxes.map((b) => b[3])) + 1, y: Math.max(...boxes.map((b) => b[4])) + 1, z: Math.max(...boxes.map((b) => b[5])) + 1 };
      return blueprint({ ...o, massing: true, parts, openings, size });
    },
  };
  return m;
}
