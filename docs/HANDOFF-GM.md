# GM handoff

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

`kit/lib/connectors/gmLint.mjs` is a static cross-talk check that was used to lay out the bench. It is approximate: it believes torches
feed comparator sides, which they do not.
