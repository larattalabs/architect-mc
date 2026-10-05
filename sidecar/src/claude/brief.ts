// What the design agent reads (rewritten from AgentCraft's agents/claude/design.ts for general
// buildings): BRIEF.md from the request, the system prompt, the first / fix / restart prompts, and
// one line of progress per tool call.
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BuildingType, DesignRequest } from '../protocol.js';

/** design agent turns per job (the first + follow-ups after a failed check) */
export const MAX_DESIGN_ROUNDS = 4;

/** One style line per building type: what makes it read as that type. */
export const TYPE_GUIDE: Record<BuildingType, string> = {
  house:
    'House: a family home of one or two storeys. A clear front door with a step or a small porch, a hall or main room, a kitchen corner (furnace, smoker, barrel, cauldron), a bedroom with a bed, windows on every side in a regular rhythm, a pitched roof with an overhang, a chimney if it has a hearth.',
  cabin:
    'Cabin: a small, sturdy single-room (or one room plus a loft) dwelling in the woods. Log walls with posts at the corners (stripped logs for trim), a stone or cobblestone base and chimney, a steep gable roof of stairs with a slab ridge, small paned windows, a covered porch, lanterns and candles, a fireplace, a bed and a table inside. Warm and cosy.',
  cottage:
    'Cottage: a low, charming country home. Whitewashed or plaster walls (white/light terracotta, calcite or birch planks) framed with dark timber, a steep roof that comes down low (thatch-like: hay bales, or dark stairs), small windows with flower boxes (potted flowers, trapdoor shutters), a garden path, a round or arched door. Asymmetric and lived-in.',
  tower:
    'Tower: tall and narrow (the checker wants height >= 2 x the smaller footprint side and at least 3 floor levels reachable by stairs or ladders). Stone or brick walls, slit or arched windows on every floor, a stair or ladder that really connects the floors, a lit landing on each level, and a crown: battlements, a conical / pyramid roof, or a lookout platform with a railing.',
  shop:
    'Shop: a storefront on the ground floor with big display windows and a wide door facing the street, a counter and shelves (barrels, chests, item frames, lecterns) inside, a sign or banner above the door, an awning over the front; optionally the shopkeeper\'s rooms above.',
  tavern:
    'Tavern: a large, welcoming two-storey inn. A big common room with tables and chairs (stairs as seats), a bar counter with barrels and brewing stands, a hearth, warm lighting (lanterns, candles), a hanging sign at the door, guest rooms upstairs with beds. Timber frame over a stone ground floor suits it.',
  barn:
    'Barn: a tall farm building with a wide entrance (at least 3 wide and 3 tall: big doors or an open arch), an open interior with stalls or pens (fences, gates, hay bales), a hay loft reached by a ladder, a gambrel or steep gable roof. Wood planks (often red: crimson/mangrove/red terracotta accents) on a stone base.',
  smithy:
    'Smithy: a forge workshop. A stone or brick building, often with one open side under a roof on posts; a forge (blast furnace, furnace, campfire or lava behind iron bars, with a chimney), anvil, grindstone, smithing table, a quenching cauldron, tool racks; a small storeroom.',
  chapel:
    'Chapel: a small house of worship. A long nave with rows of pews (stairs), an aisle to an altar at the far end, tall arched or lancet windows (stained glass panes), a steep roof, a bell tower or a small steeple with a bell over the entrance, candles. Stone (stone bricks, deepslate, calcite) with a timber or slate roof.',
  gatehouse:
    'Gatehouse: a fortified gate. A passage straight through the building, front to back, at least 3 wide and 3 tall (the checker wants it), towers or thick walls on both sides, a portcullis look (iron bars / fences over the arch, kept open), a guard room with arrow slits, battlements on top reached by stairs or a ladder.',
  custom: 'Custom: no preset; the notes describe the building. Pick the closest familiar form for anything they leave open.',
};

/** One line per well-known feature; unknown ones are passed through as-is. */
export const FEATURE_GUIDE: Record<string, string> = {
  porch: 'a covered porch at the entrance (posts, a roof, a step)',
  chimney: 'a chimney rising above the roof from a fireplace or forge inside',
  balcony: 'a balcony on an upper floor with a railing, reachable from inside',
  garden: 'a small garden on the plot (flower beds, moss, potted plants, a fence), inside the maximum size',
  skylights: 'skylights (glass in the roof) over the main room; declare them so the enclosure check knows',
  courtyard: 'an open-air courtyard inside the footprint',
  big_windows: 'big windows: tall glass on the long walls',
  basement: 'a basement below the ground floor, reached by stairs, lit',
  loft: 'a loft or mezzanine reached by a ladder or stairs',
  bell: 'a bell in a small tower or under the eaves',
  fireplace: 'a fireplace (campfire in a stone surround, with a chimney)',
  well: 'a well near the entrance',
  stable: 'a stable or pen at the side',
  battlements: 'battlements along the top of the walls',
};

export function featureLine(f: string): string {
  const g = FEATURE_GUIDE[f];
  return g ? `${f} (${g})` : f.replace(/_/g, ' ');
}

/** The checker profile line the brief repeats for this type. */
export const PROFILE_LINE: Record<BuildingType, string> = {
  tower: 'height >= 2 x the smaller footprint side; >= 3 floor levels reachable from the entrance',
  barn: 'an entrance opening at least 3 wide and 3 tall (a door or an open arch)',
  gatehouse: 'a passage through the building, front to back, at least 3 wide and 3 tall',
  chapel: 'the common rules plus a minimum interior volume',
  tavern: 'the common rules plus a minimum interior volume',
  shop: 'the common rules plus a minimum interior volume',
  house: 'the common rules plus a minimum interior volume',
  cottage: 'the common rules plus a minimum interior volume',
  cabin: 'the common rules plus a minimum interior volume',
  smithy: 'the common rules plus a minimum interior volume',
  custom: 'the common rules only',
};

/** The example design closest to a type (kit/designs/<example>.mjs), in order of preference. */
export function examplesFor(type: BuildingType, available: string[]): string[] {
  const prefer: Record<BuildingType, string[]> = {
    house: ['house', 'cottage', 'cabin'],
    cabin: ['cabin', 'cottage', 'house'],
    cottage: ['cottage', 'cabin', 'house'],
    tower: ['tower', 'gatehouse', 'chapel'],
    shop: ['shop', 'house', 'tavern'],
    tavern: ['tavern', 'house', 'shop'],
    barn: ['barn', 'smithy', 'cabin'],
    smithy: ['smithy', 'barn', 'cabin'],
    chapel: ['chapel', 'tower', 'house'],
    gatehouse: ['gatehouse', 'tower'],
    custom: [],
  };
  const order = [...prefer[type], 'cabin', 'tower'];
  const out = order.filter((x, i) => available.includes(x) && order.indexOf(x) === i);
  return out.length ? out : available.slice(0, 2);
}

export interface BriefOptions {
  /** the kit has render.mjs */
  renderer: boolean;
  /** example designs in kit/designs (ids) */
  examples: string[];
  /** what the remix source is, if any */
  remix?: string;
}

/** BRIEF.md for a request: what the design agent reads first. */
export function designBrief(req: DesignRequest, bp: string, opts: BriefOptions): string {
  const m = req.maxSize;
  const ex = examplesFor(req.type, opts.examples);
  const plot = req.plot
    ? `- plot: a marked plot of ${req.plot.dx} x ${req.plot.dz} blocks${req.plot.height ? `, up to ${req.plot.height} high` : ''}${req.plot.front ? `, its front facing ${req.plot.front}` : ''}. The mod turns the design so its \`front\` faces the plot's front; design it with \`front: 'south'\` as usual.`
    : '';
  const lines = [
    `# Design brief: ${req.name ?? `a ${req.style} ${req.type}`}`,
    '',
    `Design id: \`${bp}\`. Write it as \`kit/designs/${bp}.mjs\` (\`export const id = '${bp}'\` and a default export that returns the Blueprint; the file name must match the id).`,
    '',
    '## Request',
    '',
    `- type: \`${req.type}\` (set \`type: '${req.type}'\` on the Blueprint). ${TYPE_GUIDE[req.type]}`,
    `- checker profile for ${req.type}: ${PROFILE_LINE[req.type]}.`,
    `- style: "${req.style}". Interpret it with vanilla blocks; let it shape the materials, the roof form, the windows and the details.`,
    req.materials ? `- materials: "${req.materials}". Use these as the main palette (the closest vanilla blocks if a name is loose).` : '- materials: your choice, fitting the type and the style.',
    `- features: ${req.features.length ? req.features.map(featureLine).join('; ') : 'none requested'}`,
    `- maximum size (the whole template, including roof overhangs, porch, chimney and garden): x <= ${m.x}, y <= ${m.y}, z <= ${m.z}. Use the space well, but never exceed it.`,
    plot,
    req.name ? `- name: "${req.name}" (the sidecar's \`name\`)` : '- name: pick a short, fitting display name for the sidecar\'s `name`',
    '- description: one sentence for the sidecar\'s `description`; tags: a few words (style, size) for `tags`.',
    req.notes ? `- notes from the player: ${req.notes}` : '',
    req.remix ? `- remix: start from the library design \`${req.remix}\`. ${opts.remix ?? 'Its source was not found; design from scratch in its spirit.'}` : '',
    '',
    '## The contract (CONTRACT.md has the full text: read it)',
    '',
    '- Coordinates are relative to the template origin (minimum corner); +x east, +y up, +z south. `front` is the side the entrance faces: keep `south` unless the notes say otherwise. Every door is written closed.',
    '- `groundY` is the feet row; row groundY-1 is the floor. Set `foundationBlock` (a vanilla block the mod fills below the floor down to the ground) and `approach` to match the style.',
    '- Required anchors: `entrance` (just inside or at the front door) and `spawn` (outside, in front of the entrance), both on a standable cell; add `cam_overview` for a nice first view.',
    '- Declare `interior` (the inside box). Every standable interior cell must be lit by vanilla light sources (lanterns, torches, candles, glowstone, sea lanterns, froglights, shroomlights, lit campfires): mind the corners, each floor and the stairwells. Every floor must be reachable from the entrance by walking (stairs, ladders; max step 1). The roof must close the interior (no sky straight down into it except declared skylights / courtyards). Nothing may float.',
    '- An outside door on the front face, reachable from the entrance. Wooden doors are fine; an iron door needs a button on both sides.',
    '- Only blocks listed in `kit/lib/blocks.mjs` can be used, with every property explicit and valid (the checker refuses anything else). When the style wants a block that is not there, use the closest one and say so in your summary.',
    '',
    '## How you work',
    '',
    `- Only \`kit/designs/${bp}.mjs\` is yours: you cannot write anywhere else, and the sidecar re-checks your design with a fresh copy of the kit, so changes to the kit would not count anyway.`,
    `- Build it semantically with the kit helpers in \`kit/lib/kit.mjs\` (walls with openings, floors, doors, roofs with overhang, stairs and ladders, windows, chimney, porch, lighting, \`anchor()\`), not as a dump of raw coordinates. ${ex.length ? `Start by reading the closest example${ex.length > 1 ? 's' : ''}: ${ex.map((e) => `\`kit/designs/${e}.mjs\``).join(', ')}.` : 'Look at the examples in `kit/designs/`.'}`,
    `- Build and check: \`node kit/build.mjs ${bp} --max ${m.x},${m.y},${m.z} --type ${req.type}\` (writes kit/out/${bp}.nbt and the sidecar, then runs the checker). "check: OK" is required; fix the warnings too.`,
    opts.renderer
      ? `- Look at it: \`node kit/render.mjs kit/out/${bp}.nbt --out previews\` writes ${bp}.preview-iso.png / -top.png / -front.png into previews/; Read the PNGs and fix what looks wrong (holes, floating blocks, a missing roof, the entrance not on the front, dark rooms, a flat or boxy look). Iterate until it looks like a ${req.type} a player would be proud of.`
      : '- There is no renderer in this kit: check the layout by reasoning about the code and the checker output.',
    '- Report progress with the `design_status` tool (one short line, e.g. "roof done, checking").',
    '- No network, no installs, no git, no subagents; nobody can answer questions or permission prompts during the job. Decide yourself and mention assumptions in your summary.',
    '- Finish with ONE line: a summary of the design (type, style, footprint, highlights).',
    '',
  ];
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

export function designSystemPrompt(): string {
  return [
    "# You are Architect's building designer",
    'You design Minecraft buildings (houses, cabins, towers, shops, taverns, barns, chapels, gatehouses, ...) as parametric code with the Architect blueprint kit. The player placing your design will walk through it: it must be well built, lit, reachable and beautiful.',
    "Your working directory is a scratch folder, not a git repository and not anyone's project. Everything you need is in it: BRIEF.md (the request: read it first), CONTRACT.md (the blueprint contract and the checker rules), kit/ (the kit: lib/kit.mjs helpers, lib/blocks.mjs, the checker lib/check.mjs, build.mjs, render.mjs and example designs in designs/).",
    'Work only inside this folder and write only your own design file. Your turn ends when the design passes the checker, fits the size limit and looks right.',
  ].join('\n');
}

export function designPrompt(bp: string): string {
  return `Design the building described in BRIEF.md as kit/designs/${bp}.mjs. Read BRIEF.md and CONTRACT.md, look at kit/lib/kit.mjs and the closest example design, write the design, then build, check, look at the renders and iterate as BRIEF.md says until the checker passes and it looks right. End with a one-line summary.`;
}

export function designFixPrompt(bp: string, problem: string, round: number): string {
  return `The sidecar re-checked your design with a fresh copy of the kit and it did not pass (round ${round} of ${MAX_DESIGN_ROUNDS}):\n${problem}\n\nFix kit/designs/${bp}.mjs (only that file counts), run the build command from BRIEF.md until the check is OK and the size fits, look at the renders again if there is a renderer, then end with a one-line summary.`;
}

export const RESTART_PROMPT =
  'The sidecar restarted while you were working on this design. Re-check where you were (kit/designs/, BRIEF.md) and continue until the checker passes and it looks right, then end with a one-line summary.';

export const LIMIT_RESUME_PROMPT =
  'A usage limit stopped your last turn; it has reset now. Re-check where you were (kit/designs/, BRIEF.md) and continue until the checker passes and it looks right, then end with a one-line summary.';

/** One line of progress from a design turn's tool calls. */
export function designStepFor(msg: SDKMessage, bp: string): string | undefined {
  if (msg.type !== 'assistant' || msg.parent_tool_use_id) return undefined;
  let step: string | undefined;
  for (const b of (msg.message?.content ?? []) as Array<{ type: string; name?: string; input?: Record<string, unknown> }>) {
    if (b.type !== 'tool_use' || !b.name) continue;
    const input = b.input ?? {};
    const cmd = typeof input.command === 'string' ? input.command : '';
    const file = typeof input.file_path === 'string' ? input.file_path : '';
    if (b.name === 'Bash' && /build\.mjs/.test(cmd)) step = 'running the checker';
    else if (b.name === 'Bash' && /render\.mjs/.test(cmd)) step = 'rendering previews';
    else if (b.name === 'Read' && /\.png$/i.test(file)) step = 'looking at the renders';
    else if ((b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit') && file.includes(`${bp}.mjs`)) step = 'writing the design';
    else if (b.name === 'Read' && /BRIEF\.md|CONTRACT\.md/.test(file)) step = 'reading the brief';
    else if (b.name === 'Read' || b.name === 'Grep' || b.name === 'Glob') step ??= 'studying the kit';
  }
  return step;
}
