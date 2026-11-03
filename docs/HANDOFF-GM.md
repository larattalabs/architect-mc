# GM handoff

## Step 1b (CONTRACT GM §13, main fec8cd70 merged): not done, stopped to report

The fit of the §2a logic into the hidden volume has not converged. Details are in "Step 1b fit analysis" at the end; the coordinator has the options.

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

## Step 1b fit analysis (2026-11-03)

**Hidden volume.** In an 11 x 5 x 9 box the faces are d = 0 and d = 4 and the side faces u = +-5, so nothing may sit there. What is
left above the lintel is u -4..4, d 1..3, rows 4..7: 108 cells. §13 says planes d = 2..4, but d = 4 is the inner face in a box 5 deep, so I
used d = 1..3. Already taken there:
- the feed entries and cut cells;
- the detectors (two trapdoors and two observers, plus their outputs);
- the G line to both entries.

**Hard rules learned while packing (26.3):**
- Dust next to a strongly powered block reads it. Every block strongly powered by a repeater, comparator or observer must stay off the
  G line, the P line and the entries. Feeding the latch blocks by weak power (dust pointing in) avoids this.
- A comparator's side reads only dust, diodes and redstone blocks. Torches need a dust cell between.
- A repeater lock needs the lock diode along the latch's side axis. With R_G on the d axis, its input and output take d = 1 and d = 3
  and the lock comes along u, so the latch fills all three planes at one u.
- An observer's pulse into a block beside the bus reaches the bus.
- A trapdoor beside any powered block flips, so the detectors' trapdoors need unpowered neighbours.

**Slack rule for the D latch** (what §13 item 5 asks for), derived and checked against the dawn trace:
- The data-valid interval and the unlock interval have the same length L (both come from Q').
- Let a = unlock start minus data-valid start. The latch is safe with 1 tick of slack each side only when 1 <= a <= 2·dRG - 1, where dRG
  is the latch repeater's delay in game ticks/2 (dRG = 2 gives a in [1, 3]).
- Bench values:
  - T1 path: a = 2. Safe.
  - T2/CMP path: a = 4 (B2 -> BC repeater 2, RL 4, minus the comparator's 2). One tick outside the rule, so the dusk case has a 0-slack race
    at the window's end. It passed by tick order.
  - The fix is RL delay 1 with B1 fed 2 ticks after B2. Then both a = 2.

**The two candidate latches, against the volume:**
- D latch (repeater lock): about 14 parts plus wire.
- Torch RS latch with four subtract comparators: about 16 parts.

Each hand attempt in d 1..3 x rows 4..7 ran into the same walls:
- the G line has to leave the latch and reach both entries;
- T5 must not see BC strongly powered next to an entry;
- B1 needs both G and Q' while staying weak;
- the P node, the S/Q column and the latch compete for the centre columns.

I have no layout that passes `gmLint` and the constraints above. A fit may exist, but finding it is a search, not a tweak.
