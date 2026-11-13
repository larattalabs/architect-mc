# Designing a structure: the playbook

> From Steward's minecraft-structure-design skill (steward-mc `docs/skills/minecraft-structure-design/SKILL.md`), owned by
> Architect from phase 5a; changes are reported to Steward. Architect's copy drops Steward's §7 (region programs, until A5b; its own §7 is "Building into a site", 7b DS), runs
> slices from `kit/tools/`, and has the attach checks in the kit checker. A plain document the design agent reads (the
> sidecar copies it into the scratch dir and names it in BRIEF.md), never loaded through `settingSources`.

You write a program (`kit/designs/<id>.mjs`) that builds a vanilla structure. The kit CLI checks it, and you judge it by
**looking** at it two ways: layered ASCII slices (exact, cheap, good for logic) and rendered images (good for shape and feel).
BRIEF.md says what to build; this says how to work. It adds to BRIEF.md and CONTRACT.md and never overrides them.

## 0. Conventions (Architect's, do not mix)

- Template-local coordinates: origin = minimum corner, **+x east, +y up, +z south**. `front` is south unless the notes say
  otherwise. `groundY` is the feet row (default 1); row `groundY - 1` is the floor; the foundation fills below it.
- North is the **top** of a slice and a top-down render; west is the left. So the front door (south) is at the **bottom** of the grid.
- A block's `facing` is the direction its front/top points, and for attachables (ladder, wall torch, wall sign) the direction away
  from the wall they hang on: a ladder on a wall that is south of it is `facing: north`.
- Size counts everything: overhangs, porch, chimney, garden. Exceeding `--max` is an error.

## 1. Plan before you write code (5 minutes that save rounds)

Write a short plan as comments at the top of the design file:

1. **Footprint and levels:** width x depth, number of storeys, floor-to-floor height (a comfortable storey is 4 rows: 3 free + 1
   floor/ceiling; 5 for a grand room). Where the stairs/ladder go, so the plan keeps their stairwell clear on every floor.
2. **Massing:** one main volume plus 1 to 3 secondary volumes (a wing, a tower, a porch). Boxy single-volume buildings read as
   "generated". Vary heights and push a volume forward or back by 1 to 2 blocks.
3. **Openings:** where the front door is, then window rhythm per facade (a window every 3rd cell, odd widths so they centre).
4. **Roof:** the form (gable, hip, flat with parapet), its direction, overhang (1 block), and how the chimney/dormers sit on it.
5. **Palette roles:** which palette entries are structure (frame), infill (walls), trim, roof, floor, accent. Three tones read as
   designed: a dark frame, a mid infill, a light or contrasting trim. Never hard-code wood or stone ids; read them from the palette.
6. **Params:** 2 to 4 things a player would vary (floors, width, depth, a porch toggle). Plan how each changes the geometry before
   writing it, or the corners will fail.

## 2. Build in layers, checking as you go

Order: foundation and floor, wall shell, openings (door first, then windows), stairs between floors, roof, interior (furniture),
lighting, exterior detail (path, planters, lanterns). Run the checker after the shell, after the roof, and at the end. A failure
caught on the shell is one line to fix; caught at the end it can mean a replan.

Commands (the kit CLI; `<id>` is your design id):

```sh
node kit/build.mjs <id> --max X,Y,Z --type <type>          # build + check; "check: OK" required
node kit/render.mjs kit/out/<id>.nbt --out previews --cutaway   # iso, top, front (+ cutaway) PNGs, then Read them
node kit/render.mjs kit/out/<id>.nbt --out previews --views iso_back   # the back-right view
node kit/tools/slices.mjs kit/out/<id>.nbt --storeys        # the floor row and eye-height row of each storey
node kit/tools/slices.mjs kit/out/<id>.nbt --y 1-3          # layered ASCII, rows y=1..3 (omit --y for every layer)
node kit/tools/slices.mjs kit/out/<id>.nbt --y 5 --box 0,0,10,12   # one layer, a sub-rectangle
```

The attach and facing spot checks (support behind ladders, wall torches, signs and banners; door and bed halves; hanging
lanterns; doors opening into a wall; bed heads against a wall; roof stairs facing up-slope) are part of the checker: they
print as `warning: attach: ...` and `warning: facing: ...` from `build.mjs`.

## 3. Look at it: slices first, then renders

**Slices (logic).** For each storey, print the layers and check by eye:
- the **floor row** is closed (no holes, no unintended gaps) and the footprint matches the plan;
- the **wall row at eye height** (`groundY + 1`, `+ 2`): door gap exactly on the front face at `entrance`, windows where planned,
  corners solid;
- the **stairwell** is clear in every layer from floor to ceiling (stairs climb 1 per step: a run needs `rise` cells of length, and
  2 free rows above each step);
- the **ceiling/roof row**: the interior is closed, except declared skylights or courtyards;
- the **directional blocks listing** at the end of the output: stairs on a roof slope face **up-slope** (the direction you would walk to climb them, so on the south slope of an
  east-west ridge they face north, on the north slope south); a bed's head against a wall; every count looks sane.

**Renders (shape).** Read the PNGs in this order:
1. **front** and **top** first: this is the **silhouette**. Does it read as the type (a tower tall and narrow, a barn wide with a big
   door, a chapel with a steeple)? Is it symmetric where it should be and asymmetric where it should feel lived-in? Is the roof
   proportionate (not a hat 3x too tall, not a lid)?
2. **iso**: the front-left view. Check the entrance is visible and inviting, that materials layer well, and there are no flat 8x8 faces.
3. **cutaway** (`--cutaway`): the interior with the near walls lowered. Check rooms are furnished, lit, and the floors connect.

Critique in writing before you edit: list at most 5 concrete problems, worst first, each with the fix ("front facade is a flat
11x6 wall: bring the porch forward 2, add a second window rhythm"). Fix them all, rebuild, look again. Stop when you have no
problem left that a player would notice, not when you run out of ideas.

## 4. Self-check before you finish

- [ ] `check: OK` with the defaults, no warnings left, size within `--max`.
- [ ] Corners built: every `param` at min and max, each bool both ways, two palette presets (`--palette cherry`, `--palette fortress`).
- [ ] No `attach:` warnings: ladders, wall torches and signs have support; doors have both halves and are written closed; beds have
  both halves; hanging lanterns have something above.
- [ ] No `facing:` warnings, and: roof stairs face up-slope on every slope; chests, furnaces and beds face into the room; the directional listing from `slices.mjs` matches what you intended.
- [ ] Light: the checker's lit rule passes, and you also see lanterns/candles at doors and stair landings, not just in the middle of rooms.
- [ ] Reachability: from `entrance` you can walk to every floor with no step above 1 and no head bump (2 free rows above every step).
- [ ] No floating pieces: eaves, balconies and chimneys sit on supports; the roof has a lining under each course.
- [ ] Palette: no literal wood/stone ids; all structure blocks come from `p.*`.
- [ ] Final summary is one line.

## 5. Common failures and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Roof stairs look inside-out | `facing` reversed on one slope | a stair's `facing` points **up-slope** (the direction you walk to climb it): south slope of an east-west ridge = `north`, north slope = `south`; fix per side and check the slice listing |
| Dark corners flagged | one emitter per room | add lanterns by the stairs, in corners, under balconies; use `ceilingLights` with a smaller spacing |
| "unreachable floor" | stairwell blocked by a floor slab or furniture | carve the stairwell on every level (`stairRun` carves), keep furniture off the landing |
| Door opens into a wall (`facing:` warning) | door `facing`/`hinge` | write it closed, then confirm in the render that the door leaf sits in the wall plane and the hinge side is the one you want; compare with an example design's door call |
| Floating pieces | overhang with no lining or support | add a lining course or a post; for porches add posts at the outer corners |
| Boxy | single volume, flat faces | add a wing, a porch, a bay, a stepped roof, a chimney; offset a facade 1 to 2 blocks |
| Variants break at a corner | geometry assumes the default | sweep the corners early; derive positions from the params (centre = floor(width/2)), not constants |
| Palette swap looks wrong | literal blocks | read from the palette; check a second preset |
| Size error | forgot overhang/chimney/garden | budget them in the plan; trim the footprint, not the quality |

## 6. Style and proportion rules of thumb

- Walls 4 to 5 rows per storey; ceilings 3 free rows minimum; doorways 3 rows with a lintel or arch.
- Window rhythm: every 3 cells with 1-wide or 3-wide panes; align windows between floors.
- Roof pitch 1:1 (stairs) reads classic, 1:2 (stair+slab) reads gentle; overhang 1 block; a ridge slab line sells it.
- Corners and bases: use a heavier material at the base and corners (stone base, log posts), lighter infill between.
- Details that sell a style: sign or banner at the door, lantern posts, flower boxes (trapdoor + plants), cobweb-free interiors, a rug,
  a table with chairs, a chimney with campfire smoke, a path to the entrance.
- Make style choices **from the request and the style bible** if one is present (`bibles/<id>.json`): its palette roles, roof language
  and motifs win over your defaults, so a set of buildings reads as one place.

## 7. Building into a site (7b: when BRIEF.md has a "Site" section)

A site-aware design is built INTO one piece of land: `site/site.arvx` (the frozen volume) and `site/site.json` (the lot, its
fit, its ports and the site analysis). The template is exactly the lot box; the mod keeps every cell you do not write.

- **Plan in the site's frame.** Your default export gets `site` (a `Site`, `kit/lib/site.mjs`): `new Blueprint({ ..., fit, site,
  size: site.size })`. Read the geometry from it, never from constants: `site.face(normal)`, `site.surface(x, z)`,
  `site.ceiling(x, z)`, `site.trunk()`, `site.ledges()`, `site.hangPoints()`, `site.port(name)`, `site.cellsOf(cls)`,
  `site.at(x, y, z)`. A program that reads the land re-runs on another site of the same kind (a site variant, $0).
- **Stay inside `site.size` on any land.** A site variant re-runs your program on land of the same fit that is taller, shorter,
  wider or shaped a little differently. Size storeys and the roof from the lot's height, and clamp every coordinate you derive from
  the land to the lot (`0 .. site.size.x/y/z - 1`). When the land asks for more than fits, build fewer storeys or a lower roof; never
  write outside the lot.
- **Look at the land first:** the empty-site renders (`site/site-*.png`), then slices with the land shown
  (`node kit/tools/slices.mjs <nbt> --site site/site.arvx --lot site/site.json --y A-B`: `#` rock, `:` soil, `~` water,
  `T` log, `%` leaves). Sketch where each mass goes against the face, the rim, the trunk or the overhang before writing code.
- **Keep what you don't need to change.** Write only what the building needs; never write a keep-critical cell (`bp.keep(...)`,
  the trunk's logs, the hang points) or a player's block, not even as air. Carve only the rooms you need (`carveRoom`).
- **Bear on rock.** Every block must connect, through your blocks, to the site's solid: beams end inside the rock (`beamInto`),
  braces bear on the face (`bracket`), a span's ends sit on both rims, chains hang from the solid above (`hangChain`), a deck
  rests on the trunk (`ringDeck`). The checker's `fit:<mode>` names the cells that float.
- **Put the door where the port is.** Each site port wants a design port of the same name, kind and facing within 2 of its hint,
  facing out and standable (`bp.port(name, kind, ...site.portHint(name), facing)`); every floor is reached from a port. The approach
  is a port, not a ground strip: no foundation fill, no approach path.
- **A walk port sits at its hint's height exactly.** A walk port that faces a side (`architect:walk`, not a hatch) is where a
  walkway between lots arrives, and a walkway is level: the other lot's port and the land's ramps are at the hint's y. Put the port's
  feet at the hint's y (x and z may move within 2), and build the deck or floor under it to that height; never move the port to
  your floor. One row off is a check error (`ports_met: walk port ...`).
- **Look at the composite, not the floating template.** Render with `--site site/site.arvx --lot site/site.json --views
  iso,top,composite,section`: judge the composite (the design in its land) and the section (the lot cut through its middle).
- **Mind the site rules** in the check: `site_keep` (an error), `fit:<mode>`, `ports_met`, `floors_reachable`, `site_breach`
  (never open into water, lava or a dark cave), `cut_volume` (carve at most the interior plus its walls; never cut the trunk),
  `cantilever` and `neck` (how far the mass reaches past what bears it).

| Symptom | Likely cause | Fix |
|---|---|---|
| `site_keep: the template writes ... cell(s) the site keeps` | a wall, floor or air box over a log, hang point or player block | `bp.keep(...)` those cells, or move the mass |
| `fit:attach_to_cliff` / `fit:span` floating cells | a part that only touches air | run a beam into the rock, add a bracket, extend the end onto the rim |
| `ports_met: no design port ...` | the door moved, renamed or turned | put the port at `site.portHint(name)` with the site's facing |
| `ports_met: walk port '...' has its feet at y A, not the hint's y B` | the walk port follows a floor one or two rows off the hint | raise or lower that floor (or a landing at the port) to y B and put the port there |
| `site_breach: ... beside the site's water` | a carved room next to water | keep a wall of rock (1 cell) between the room and the water |
| the build exits 2: "declares fit ..., but the site is ..." | the design's `fit` is not the site's | set `fit` to the site's fit (BRIEF.md) |
| a site variant refuses `site_bound`: the design threw "set(...) outside size" | a height or position derived from the land, unclamped | clamp derived coordinates to `site.size`; fewer storeys or a lower roof on taller land |

## 8. Past the cap: composites (7c)

A template is at most 96x64x96. Something larger (a castle wall 120 long, a tower over 64) is a **composite**
(`kit/lib/composite.mjs`, kit/README "Composites"): modules, each an ordinary `Blueprint` within the cap, joined at
`architect:joint` ports. The default export returns the `Composite` instead of a Blueprint; it installs as ONE entry (the union,
what the player and Steward see) with hidden module entries, and the mod places the modules as one site group, the module that
others rest on first. Use it only when the brief's size does not fit one template: one Blueprint is always simpler.

- **Plan the cut first.** Split along walls, never through a room's middle: neighbouring modules **share one seam layer** (the
  wall between them), and every cell both write must be the same block, so lay every pattern out in union coordinates
  (`ox` = the module's union x) and let both modules write the seam wall identically. Each module must stand checked on its own
  box (`MODULE_CAP`, its ports) and the union must check clean across the seams (light, doors, reachability, floating).
- **Openings across a seam are joints:** `joint(bp, name, x, y, z, facing, { width, height })` on each side, on the module's boundary
  face, at the same union cell with opposite facings and the same size; then `c.module(id, bp, { at: [x, y, z] })` for each and
  `c.join('<a>.<port>', '<b>.<port>')`. Module ids: `[a-z][a-z0-9_]{0,15}`.
- **Stack by support:** a module on top of another starts at the lower one's top layer (that layer is their seam); it is placed after it.
- **Check it:** `node kit/tools/composite.mjs <file.mjs> --views iso,top` prints CM-a's findings (`JOINT_*`, `MODULE_OVERLAP`,
  `SEAM_CONFLICT`, `MODULE_CAP`) and the union check; `kit/designs/composite/castle.mjs` is the worked example (three 41-wide halls,
  two arches).

| Symptom | Likely cause | Fix |
|---|---|---|
| `composite: SEAM_CONFLICT ...` | the two modules write the seam wall differently | build the seam from union coordinates in both |
| `composite: JOINT_CELL` / `JOINT_FACING` / `JOINT_WIDTH` | the arch's two sides disagree | the same union min corner, opposite facings, the same width and height |
| `composite: MODULE_OVERLAP` | boxes overlap more than one layer | move `at` so neighbours share exactly one layer |
| `composite: module 'x' ... over the max` | a module larger than the cap or the job's max | split it again |
