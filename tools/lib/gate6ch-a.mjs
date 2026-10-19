// (6c H) Slice H-a's items of the H gate (tools/gate6ch.mjs): water bodies: ponds (water and lava), fountains, waterfalls, moats, ice caps, the farm pond, the wet well (items 4, 9 for bodies, 10, 13 for bodies, 19). H-a owns this file.
// Each step name (unit, ingame, crash, probe, natural, cold, look) maps to a list of items {name, run(ctx)}, run after H-core's in that
// step; ctx = {L (tools/lib/run6b.mjs), OUT, KIT, imp (a kit module), json, root, check, log}. The foundation's lists are empty.

export const items = {
  unit: [],
  ingame: [],
  crash: [],
  probe: [],
  natural: [],
  cold: [],
  look: [],
};
