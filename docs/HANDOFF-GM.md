# GM handoff

## GM-a2 (CONTRACT GM §16 items 1, 3, 4; main 05611639 merged): in progress

**Decisions (recorded in CONTRACT GM "Slice GM-a2 as built"):**
- **Survival (option (a)).** Check: `mechanism.cost {cells, bom {min, max}, rare}` and the gatehouse lot's `costRange` widened by
  `cost.cells` (realiseApproved's `lotProblem` counts the bound mechanism the same way). Bind: `GateMech.Plan.bill`, the report's `bom`.
- **The INSTANT problem: held, then charged at once, then written at once** (`site/MechCharges.java`, the RS fluids charge's model). The
  `mech:<lot>` item waits for its lot's construction site to be built, then for its whole bill in the stockpile (SITE_BUSY, naming what it
  lacks); then `Stockpiles.charge`, `survival.mech.<lot> {bill, cells, charged, chargedAt}` saved, then the no-update write. Outstanding
  (`<region>:mech:<lot>`), the audit's `mechStanding` and the refund at the group removal's rule 7 (keyed, once) follow.
- **Roof fill, read as "holes only".** A rung cell at or above the bound roof that the design left empty and that has a design block beside
  it across the passage gets the structure block (`mechanismWrite.fill`). Cells above a flat roof stay empty (no bumps). Levers-only fills
  nothing. The fill is billed.
- **Crash:** `SiteJournal.isGateMechanism` falls back to the journal head's recorded kind when the record is gone (`GATE_BY_HEAD`,
  `dev.gm.state`). The group removal skips a member with no record at all, so "exact restore with the record wholly gone" is not reachable
  there; the in-game crash item runs the real GW path.

**Gate items added:** `gm-survival` (chain `7agma-surv`; in `7agma` and the slice tier), gm-ingame `p13x7rv` (a design that leaves every
reserved cell empty: the fill), gm-undo `close-logic`, `close-landed`, `open-logic`, `open-first`, `open-landed` and `crash`
(`GM_UNDO_ONLY`, `GM_SURVIVAL_ONLY` narrow them). Ports used: 8896-8903.

## Step 1b (CONTRACT GM §14, main 900db05e merged): PASS (chain 7agm = gm-probe + gm-fit at 2a6e8f14)

`gmCircuit.gateLayout(kind, {depth, roof})` lays out the whole sliding gate: leaves and feed (slideCells), the lever detectors
(detectorCells), the §2a logic in the logic block (u in [-5, 5], d = 1..depth-2, rows 4..8), the roof sensor and its run, and every
unused logic-block cell as the structure block. `lintLayout` checks it (gmLint, below); `gm-fit` (tools/gate7agm.mjs fit) builds it in
real gatehouse boxes and runs the step 1b set. The evidence is the run named in "Step 1b evidence".

**The layout (local frame, roof at row R):**
- r 7: the chain SB -> CMP (subtract, back SB) -> DB -> RG (latch, delay 2) -> GB along d = 4, u -4..0. nQ dust on CMP's north side from
  T2 on B2 (-3,1,7). RL (lock, delay 1) on RG's north side from T5 on BC (-1,1,7). rBC (delay 1) reads B2 into BC: the bench's B2 -> BC.
- D is a block (DB), powered by CMP beside it or by T1, a wall torch under it hung on B1 (-2,5,6).
- B1 is fed by rG (delay 1, from G dust under GB) and rQd (delay 2, from Q').
- S: the inverted sensor in the roof at (-4, 1 + (R - 10), R), a staircase along d down to raw dust at (-4,1,9) on the block RS reads.
  RS (delay 1) gives the clean S, which runs as dust onto SB's top. OS (under RS, facing up) -> QB -> RQ (delay 4) -> Q' dust.
- Q' -> rB2 (delay 1): B2 = Q' + 2. Q' -> rQd (delay 2): B1 = Q' + 4. BC = B2 + 2. So a = 2 on both paths (latchTiming).
- P: each detector observer powers a block read by its own RP (delay 3). P' climbs to RP' (delay 1), into the block rP (delay 1)
  reads into BC. Inside detector: an east column (4, d, 6) for any depth.
- G: GB -> dust under it and south of it -> the G line at row 5 along d = 3 (u -3..3), which touches both feed entries (+-3,2,5).

**What forced this shape (each is a gmLint rule or test now):**
- every dust or diode stands on a layout cell. A row-4 G line needed row-3 floors, which are the design's lintel course, so the line is at row 5;
- the cell over a torch is air;
- a strongly powered block has no foreign dust beside it, above it or below it;
- a comparator side reads only dust or a diode;
- observer outputs are blocks read by repeaters (RPa, RPb), so a pulse never sits beside a bus;
- the hall around the logic block may be solid or open (both are linted).

**How it was found:** by a small router (dust paths with their floor and cut cells, the full gmLint as the oracle) over hand-placed parts,
in a scratchpad, then hand-finished. The router is not committed (no new tooling); the result is the data in gateLayout.

**First in-game findings (13x7x10, portcullis), now fixed:** the write order must put observers in with the structure, because OS is the floor
of RS. With that, all 13 steps, 20 lever cycles, a = 2 with end slack 2 on both override windows, a storm closing once and reopening once.

**Contract notes (no number changed):**
- The logic stays off u = +-6. These are the 13-wide box's side faces, though §14 item 2 names them.
- The inside detector's trapdoor is at (1, D-2, 3), a lintel cell one plane in from §13's trigger cell (1, D-1, 3); GM-a's envelope must name it.
- The sensor sits at a fixed roof cell, (-4, 1 + (R - 10), R). Its run climbs one plane per row, so a roof more than depth - 3 rows above
  row 10 has no run: such a gate is levers-only with deviation `mechanism.sensor` (§2a "No sky cell"), unless a later slice adds a spiral run.

## Step 1b evidence (chain 7agm at slice/GM 2a6e8f14, run 20261103-071935-7agm: PASS, gm-probe and gm-fit, 74 checks)

The evidence is copied to the main checkout's `artifacts/gate7a-gm/run-20261103-071935-7agm/` (local only, not committed).

All six boxes, 13x7x10, 13x11x11 and 17x15x12, each with portcullis and slide:
- the 13 §2a steps;
- 20 lever cycles through the logic with the leaves checked after each flip, the levers alternating. These are the "20 grate and slide
  cycles" per box, with the portcullis as the grate and the slide as the slide;
- the clock running through a natural dusk and a natural dawn: one edge each, so it closes at dusk and opens at dawn with no flicker;
- a daytime storm, with the weather running: it closes the gate once, and the clearing opens it once, with no flicker. A storm's onset is a
  sensor edge (a Q pulse), so it also clears an override, as a dusk would;
- no item dropped;
- `settleLayout`'s pure rest state equal to the built one: 56, 61 and 66 redstone parts, 0 differ.

**The latch windows, traced tick by tick** (a = unlock start minus data-valid start; end slack = data change + 4 minus relock; the bar is >= 1 each):
- **dusk with a closed override** (D rises through CMP, the CMP path): a = 2, end slack 2.
- **dawn with an open override** (D falls through T1, the T1 path): a = 2, end slack 2.
- **plain dusk, plain dawn and the lever window**: D is constant through the unlock, so there is no data race. End slack 2, 4 and 6.

One window (13x7x10 portcullis, dusk with a closed override; one character per game tick from the time jump):
```
G      1111111111111111111111111111111111111111111111111111111111111
locked 1111111111111111111111111111111111100000000111111111111111111
D      0000000000000000000000000000000001111111100000000000000000000
```

## GM-a (CONTRACT GM §10 items 1-4, 7-8 under §12-§15; main 283b7bd4 merged): slice tier PASS, item 6 (survival) open

**State (2026-11-03):** built and gated; see CONTRACT GM "Slice GM-a as built". Slice run `20261103-093331-slice` (ports 8896/8897),
14/14 PASS at e22d9e98, evidence in the main checkout's `artifacts/gate7a-gm/run-20261103-093331-slice/`. Gallery (private):
https://claude.ai/artifact/JpzbuVYu4argcBroMW6WzU (N-GM-1). **Not built:** gm-survival (§10 item 6) and the survival bill: the bill
depends on the bind-time rung and a region cells site has no construction mode (CONTRACT as built, "Open for the coordinator").

Running it: `node tools/gate-run.mjs 7agma --host server --ports 8896:8897 --run-dir ../architect-mc-GM-run --lock
../architect-mc-GM-run.lock` (gm-unit, gm-ingame with undo); `7agma-look` (client) for the gallery; `GM_INGAME_ONLY=p13x7,...` narrows
gm-ingame. Fixtures `kit/test/fixtures/plan/gm/`; the driver `tools/lib/gate7agm-a.mjs`.

Findings on the way (fixed): the mechanism item must be BOX (CELL kept lever-flipped cells as "changed since"); its restore must not
deliver updates (the dust, repeaters and torches popped and dropped); a site being removed is found among the pending sites.

§15 settled the sensor question (option (b) plus item 6's roof cap). The design GM-a builds, so a restart can resume:

**Kit (plan time)** `kit/lib/connectors/gmGate.mjs`, wired in `wallLots.mjs` finishLot and `wall.mjs`:
- opt-in only: `mech` (and `rest`) on a `connector.wall.lots[]` entry, or the lenient `params.mechanism` / `params.gate_mech` on a wall
  without `lots` (every gate lot). Every recorded plan is unchanged (no recorded wall names one).
- box check `gmBoxFits` (13 along x 7 through x 10 high): short -> the plain K3 passage, deviation `{what: mechanism, kind, lot, need,
  side}`; an explicit `mech` on a `required` wall is refused `NO_ROOM {kind: mechanism, lot, need, side}`. pw is 3 when it fits.
- `mechanismPlan(kind, {depth, mats})`: gateLayout for every roof row R in 10..depth+7, each settled (settleLayout; leaves' connections
  settled assuming the design's cells solid). **base** = the cells equal in every R; **rungs[R]** = R's run (dust, blocks, cut air, the
  inverted sensor) plus the structure block on every unused rung cell below R; rung cells at or above R are not written (the design's).
  Levers-only = base alone (no sensor, no run). Write order = §7 item 2 (`gmRank`; observers with the structure).
- `gmMatsOf(roles)`: structure = first full conductive block of structure, trim, foundation, then the other roles; the slide leaf the first
  movable one; bars = the rail role's fence, else its wall, else iron_bars; button and plate the first role with that shape.
- the record `onWall.passage.mechanism {kind, rest, width 3, dayDriven, cells, lotCells, triggers, states, rungs, brief}` (artifact and IR);
  **the envelope's lotCells are unioned into `onWall.passage.lotCells`**, which is what Steward's `PPlan.reserved` forwards (zero Steward
  change); `passage.cells` (the mask, the open lanes, vworld) is unchanged. The IR lot carries `mechanismWrite {palette, base, rungs:
  [{roof, sensor, cells}]}` (world, flat `x, y, z, paletteIndex`).
- graph `pg_<lot>`: `state`, `closesAtNight` (day-driven), `mechanism {kind, toggle: player}`, movers `[player]` when resting closed;
  answer `geometry.wallLots[].passage.mechanism {kind, rest, who}`; siteplan walls[].lots[].passage.mechanism and the edge's members.
- brief lines (`gmBrief`, five for the sliding kinds): §4's two word for word, §5's jamb line, §15 item 1's staircase, §15 item 6's roof cap.

**Java (bind)**: realiseApproved's lot item reads `mechanismWrite`, picks the rung from the bound design (rule below), writes one region
cells item after the lot (`mech:<lot>`, LAYER, journaled as the region's), masks the written cells from the design (LotMask key
`architect_mc:mechanism`), and reports the sensor rung or the deviation `mechanism.sensor` on the lot site's ext.

**The bind rule (§15 item 2):** for R = 10..depth+7, the candidate sensor cell is (-4, R-9, R) in the gm frame. R is the design's roof
row over the sensor column when the design (fitted as the realise fits it) has a block at (-5, R-9, R) or (-3, R-9, R) (the roof beside
the sensor) and nothing in the sensor's column above R inside the box; the lowest such R wins. The world above the box is the plan's
(K3's pad keeps 40 clear over the floor), so it is not read. No R: levers-only, no sensor block, deviation `mechanism.sensor`.

## K3's orientation of a gatehouse lot (Steward's question, answered from the code)

- **A gate lot** (`wallLots.mjs` siteWallLots, "gates") always puts `size[0]` along the wall. `nearestLotRun(W, pt, w)` takes the first
  number as the run along the ring, and `runBox(..., d)` the second as the depth through it. Nothing swaps them to the longer side.
  - The recorded `redstone_gate` `gatehouse_1` is `[13, 11]`, 13 along the wall, so it gets the mechanism.
  - A gatehouse sent as `[11, 13]` has 11 along the wall and comes out plain, with deviation `mechanism`.
- **A joined (via) lot** (`viaLots`, K1's lots on a `wall.line`) keeps the lot's own placement. Its passage runs across the line
  (`passFacing`), so a via gatehouse can have its short side along the wall too.
- Steward's e2e 17x15 runs its 17 side along, so it is fine. GM-a's gm-ingame gets an `[11, 13]` fixture to show the plain passage.

## State (2026-11-02): step 1 (`gm-probe` under CONTRACT GM §12) has a result; step 2 (GM-a) is not started

Main 6066411e is merged in. The probe (`node tools/gate7agm.mjs probe`, chain step `gm-probe`) runs the §12 item 4 set on the 26.3 server.
The lifting extender row is removed; the `extender` and `outside` steps stay as the record of why §12 happened.

What passed (headless, flat worlds, gatehouses of stone and of the fortress roles):
- **§1 rules**: all 12, as in the first probe.
- **Split grate and slide** (`grate`): 20 cycles each with no misplaced leaf, in three variants: stone with iron bars, stone with slide leaves,
  and fortress roles with polished andesite and spruce-fence leaves. From G at the feed to settled leaves takes 3 ticks to close and 3 to open.
- **Lever detectors at the gate** (`detectors`): 20 flips each lever, one 2-tick observer pulse per flip, 2 ticks after the flip. The
  leaves do not move, and nothing else in the box changes.
- **The §2a day cycle, wired** (`daycycle`), for both the portcullis and the slide. The logic bench drives a real gate (detectors,
  inverted daylight sensor, latch, `kit/lib/connectors/gmBench.mjs`). 13/13 steps passed:
  - dusk closes and dawn opens;
  - either lever toggles;
  - an override holds until the next transition, then is cleared: an open override at night is open at dawn, and the next flip closes the gate;
  - 20 lever cycles through the logic with no misplaced leaf;
  - lever to settled leaves takes 34 ticks, most of it the bench's long bus.
- **Swing** (`swing`): button, inside lever and plate, 20 cycles each. A villager presses the plate; the bot player does not run its
  own physics. After the 60 cycles the box equals its rest state.
- **Drawbridge** (`drawbridge`): a deck 2 wide over a moat 5 wide and 3 deep. The ripple flips cell i at 2(i+2) ticks, both raising
  and lowering. 20 cycles with the two levers alternating; the moat box, water included, equals its rest state afterwards.
- **Settled states** (`settled`): portcullis and slide open (rest) and closed; swing closed (rest) and open. Each was read back, and
  open, closed, open again is a fixed point. These are written to `kit/lib/connectors/gmSettled.mjs`; `gmCircuit.settle(kind, rest)`
  serves them.

## Findings that change the contract's geometry (why step 2 waits)

1. **A 3-high piston stack cannot be fed from the plane d = 1 alone.** The bottom piston needs power from beside it, and the only
   places are the lining planes or the floor. The proven feed uses **6 lining cells a side in the plane d = 2** (u 3s and 4s, rows 0-3):
   (3s,2,0) block, (3s,2,1) wire, (3s,2,2) air, (4s,2,1) block, (4s,2,2) wire, (4s,2,3) air. In a box 3 deep, d = 2 is the inner face,
   so this wire shows from inside. `gmCircuit.slideCells` has the whole layout; the cut cells are listed there.
2. **The levers hang from the lintel over a lane** (outside at u = -1, inside at u = 1), not on the jamb at F+1. A lever's signal can
   leave a box 3 deep only through its mount, and a jamb mount's neighbours are the leaf slot or the faces. The detectors (an iron
   trapdoor in the plane d = 1 at row 3 plus an observer above it) need **the lintel cells (u, 0, 3) and (u, D-1, 3) as trigger cells**.
3. **The §2a logic is proven only on a free bench, not fitted into the box.** The bench is about 46 x 19 cells flat. Fitting it is
   design work, but two constraints are hard:
   - a repeater lock needs a third plane (its lock enters from the side), so the latch needs d = 1..3, which is hidden only in a box at
     least 5 deep;
   - the alternative steering latch (torch RS latch with four subtract comparators) fits two planes in principle but was not built.
   - Comparator side inputs do not read torches (26.3), so every inverted side input needs dust.
   - The row-5 bus in d = 2 must not pass over u = +-1 when the detector pulses come out at (+-1,1,5): a pulse into a block there
     reaches the bus. Found by the settled dump; the probe now keeps those cells clear.
4. **The drawbridge deck is at most 2 wide.** A middle row's trapdoors have nothing beside them to power them. Each cell takes a sleeper
   and two repeaters per side, and the deck sits above the water, since repeaters cannot stand in water.
5. **Timing margins in the logic are thin.** The dawn case with an open override needed RL delay 2 and R_G delay 2: the lock must open
   2 ticks after T1 is off. A tick trace of that case is in `steps.daydebug`.

Contract numbers to decide: the reserved envelope grows by the d = 2 lining (12 cells), the lintel trigger cells and the logic's volume.
The box minimum stays 11 x 3 x 9 for the mechanism, but the logic does not fit plane d = 1 rows 4-7 as written. The coordinator decides
whether step 2 waits on Noah.

## Running it

`node tools/gate-run.mjs 7agm --host server --ports 8896:8897 --run-dir ../architect-mc-GM-run --lock ../architect-mc-GM-run.lock`.
By hand: `GATE_HOST=server GATE6B_CLIENT_SCRIPT=tools/run-headless-server.mjs GATE7AGM_OUT=<dir> node tools/gate7agm.mjs start`, then
`... <step>`, then `stop`. Steps: rules, grate, detectors, daycycle, swing, drawbridge, settled, probe (the set), daydebug.

`kit/lib/connectors/gmLint.mjs` is the static check (rules named in its header; unit tests in kit/test/gm.test.mjs). It no longer believes
torches feed comparator sides.

