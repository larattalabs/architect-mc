# Designing a structure: the playbook

> From Steward's minecraft-structure-design skill (steward-mc `docs/skills/minecraft-structure-design/SKILL.md`), owned by
> Architect from phase 5a; changes are reported to Steward. Architect's copy drops §7 (region programs, until A5b), runs
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
