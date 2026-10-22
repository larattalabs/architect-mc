// (6c FL) What slice FL changes for the earlier slices' byte-identity checks (their unchanged() over the committed plan fixtures):
//   normIrJson(json)   an IR's JSON with kitVersion normalised and the street roads' S-FL-5 ext (`roads[].ext["architect_mc:street"]`,
//                      on every V, D1, D2 and FL street since FL) dropped, so a street zone's IR compares as before
//   FL_MOVED           the fixtures FL moves by name (docs/CONTRACT.md "Phase 6c slice FL" §8): the five asks with a free layout and
//                      extension/e07, e14 and e15 (their reserved blocks shipped); `FL_MOVED_ASKS` the asks by file name alone
//   (6c close-out A) COA_MOVED_FIXTURES: the committed plan fixtures close-out A moves by name (docs/CONTRACT.md "Phase 6c close-out A" as
//   built), folded into FL_MOVED so every earlier slice's byte-identity item leaves them to close-out A's own item 10 (the name stays:
//   "moved by name by FL or a later slice"): the 12 asks Steward re-recorded (their input changed; earlier slices' asks tables read
//   Steward's first recordings: kit/test/fixtures/plan/asks-8703dbd, plan-helpers.mjs asksFirstPath, asks-first.mjs) and the fixtures
//   close-out A's items 4, 5, 7 and 9 move.
export const COA_REREC_ASKS = Object.freeze(['arcology', 'end_city_ruins', 'one_block', 'redstone_gate', 'rival_families', 'spiral_town', 'swamp_stilts',
  'terraced_hill', 'treetop_village', 'two_districts', 'underwater_domes', 'upside_down'].map((a) => `asks/${a}.json`));
export const COA_MOVED_FIXTURES = Object.freeze([...COA_REREC_ASKS]);
export const FL_MOVED_ASKS = Object.freeze(['around_my_tree.json', 'nomad_camp.json', 'ring_city.json', 'grid_city.json', 'organic_hamlet.json']);
export const FL_MOVED = Object.freeze([...FL_MOVED_ASKS.map((f) => `asks/${f}`), 'extension/e07_ring_layout.json', 'extension/e14_sketch_outline.json', 'extension/e15_every_reserved_a.json', ...COA_MOVED_FIXTURES]);

export function normIrJson(json) {
  const s = String(json ?? '').replace(/"kitVersion":"[0-9.]+"/g, '"kitVersion":"*"');
  if (!s.includes('architect_mc:street')) return s;
  const ir = JSON.parse(s);
  for (const r of ir.roads ?? []) {
    if (!r.ext) continue;
    delete r.ext['architect_mc:street'];
    if (!Object.keys(r.ext).length) delete r.ext;
  }
  return JSON.stringify(ir);
}

/**
 * A committed asks report (KC's `ask/part block class` lines, HY's gap table, VOC-c's per-ask blocks) without what FL moves by name: the
 * five free asks' lines (VOC-c's whole block for each), the gap table's free-layout rows and the tally line. The earlier slices' asks
 * items compare their tables through it.
 */
export function flAsksFilter(text) {
  const asks = FL_MOVED_ASKS.map((f) => f.replace(/\.json$/, ''));
  const out = [];
  let inBlock = false;
  for (const l of String(text).split('\n')) {
    if (/^# 59 asks/.test(l)) continue;
    if (/^\s+(layout\.(ring|grid|organic|spiral)|locator\.around|sketch\.outline)\s+\d+$/.test(l)) continue;
    const head = /^([a-z0-9_]+)(\/| )/.exec(l);
    if (head && !l.startsWith(' ')) inBlock = asks.includes(head[1]) && head[2] === ' ';
    if (head && asks.includes(head[1])) continue;
    if (inBlock && l.startsWith('  ')) continue;
    out.push(l);
  }
  return out.join('\n');
}
