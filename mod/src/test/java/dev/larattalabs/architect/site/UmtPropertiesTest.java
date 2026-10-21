package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.cells;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/**
 * UMT's targeted properties (docs/UMT.md): each builds its world by hand and drives the production journal through placement,
 * world changes and removal. P3 the StillOurs equivalences (CU), P4 the neighbour effects, P5 accounting, P6 the history's undo bugs
 * as fixed cases, and the coordinator's crash window (R2 to R4). Every one ends with everything removed and settled and the world
 * equal to the world before, cell for cell (block entities and player records included).
 */
class UmtPropertiesTest {
	static {
		UmtRunner.boot(); // before the block constants below
	}

	static final BlockState COPPER = Blocks.COPPER_BLOCK.asList().get(0).defaultBlockState();
	static final BlockState OXIDIZED = Blocks.COPPER_BLOCK.asList().get(3).defaultBlockState();
	static final Pt PLAYER = new Pt(new UUID(9L, 9L), null);

	private static void exact(List<String> v) {
		assertTrue(v.isEmpty(), "not exact:\n" + String.join("\n", v));
	}

	// ------------------------------------------------------------------ P3: StillOurs equivalences (CU)

	/** (CU, history: copper weathering a3478515) A road's copper weathers, is waxed, weathers on: still the road's; its removal puts grass back. */
	@Test
	void p3_weatheredAndWaxedCopperIsStillOurs() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.sim.cells(UmtOps.Kind.ROAD, 0, cells(p(1, G, 1), COPPER, p(2, G, 1), COPPER, p(3, G, 1), COPPER));
			c.sim.world.natural(p(1, G, 1), Blocks.COPPER_BLOCK.asList().get(2).defaultBlockState()); // weathered
			c.sim.world.natural(p(2, G, 1), Blocks.COPPER_BLOCK.asList().get(4).defaultBlockState()); // waxed in place (no record)
			c.sim.world.natural(p(3, G, 1), OXIDIZED);
			exact(c.sim.end());
		}
	}

	/** (CU S-CU-1) A player who mined the road's copper and placed their own oxidized block (a record): the player's, the removal leaves it. */
	@Test
	void p3_aPlayersCopperWins() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.sim.cells(UmtOps.Kind.ROAD, 0, cells(p(1, G, 1), COPPER, p(2, G, 1), COPPER));
			c.sim.world.player(p(1, G, 1), Blocks.AIR.defaultBlockState(), null, null);
			c.sim.world.player(p(1, G, 1), OXIDIZED, PLAYER, null);
			c.sim.tainted.add(p(1, G, 1));
			exact(c.sim.end());
			assertEquals(OXIDIZED, c.at(p(1, G, 1)), "the player's block stays");
			assertEquals(PLAYER, c.record(p(1, G, 1)), "with its record");
			assertEquals(Blocks.GRASS_BLOCK, c.at(p(2, G, 1)).getBlock(), "the road's own cell comes back");
		}
	}

	/**
	 * (4e S2, StillOurs.VOLATILE and CONNECTIONS; vanilla V10) A road's stair changes shape, its lamp is lit, its fence connects, its
	 * trapdoor opens, its leaves' distance changes: still the road's, the removal puts the ground back. A stair a player turned
	 * (facing is not volatile, a record) is the player's: the removal leaves it.
	 */
	@Test
	void p3_volatilePropertiesStayOursAndAFacingIsThePlayers() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			BlockState stair = Blocks.OAK_STAIRS.defaultBlockState();
			c.sim.cells(UmtOps.Kind.ROAD, 0, cells(p(1, G + 1, 1), stair, p(2, G + 1, 1), Blocks.REDSTONE_LAMP, p(3, G + 1, 1), Blocks.OAK_FENCE, p(4, G + 1, 1),
				Blocks.OAK_TRAPDOOR, p(5, G + 1, 1), Blocks.OAK_LEAVES, p(1, G + 1, 3), stair));
			c.sim.world.natural(p(1, G + 1, 1), stair.setValue(net.minecraft.world.level.block.StairBlock.SHAPE,
				net.minecraft.world.level.block.state.properties.StairsShape.INNER_LEFT));
			c.sim.world.natural(p(2, G + 1, 1), Blocks.REDSTONE_LAMP.defaultBlockState().setValue(net.minecraft.world.level.block.RedstoneLampBlock.LIT, true));
			c.sim.world.natural(p(3, G + 1, 1), Blocks.OAK_FENCE.defaultBlockState().setValue(net.minecraft.world.level.block.FenceBlock.NORTH, true));
			c.sim.world.natural(p(4, G + 1, 1), Blocks.OAK_TRAPDOOR.defaultBlockState().setValue(net.minecraft.world.level.block.TrapDoorBlock.OPEN, true));
			c.sim.world.natural(p(5, G + 1, 1), Blocks.OAK_LEAVES.defaultBlockState().setValue(net.minecraft.world.level.block.LeavesBlock.DISTANCE, 3));
			BlockState turned = stair.setValue(net.minecraft.world.level.block.StairBlock.FACING, net.minecraft.core.Direction.EAST);
			c.sim.world.player(p(1, G + 1, 3), Blocks.AIR.defaultBlockState(), null, null);
			c.sim.world.player(p(1, G + 1, 3), turned, PLAYER, null);
			c.sim.tainted.add(p(1, G + 1, 3));
			exact(c.sim.end());
			assertEquals(turned, c.at(p(1, G + 1, 3)), "the player's turned stair stays");
		}
	}

	/** (CU S-CU-3) Farmland a tile wrote that dried to dirt, and dirt a tile wrote that a hoe made farmland: both still the tile's. */
	@Test
	void p3_farmlandAndDirtAreInterchangeable() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.FARMLAND, p(2, G, 1), Blocks.DIRT));
			c.sim.world.natural(p(1, G, 1), Blocks.DIRT.defaultBlockState());
			c.sim.world.natural(p(2, G, 1), Blocks.FARMLAND.defaultBlockState());
			exact(c.sim.end());
		}
	}

	/** (6a) Water that flowed into air a tile cleared, and a source it wrote that froze: still the tile's. */
	@Test
	void p3_fluidInClearedAirAndIceAreStillOurs() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.AIR, p(1, G - 1, 1), Blocks.AIR, p(3, G, 1), Blocks.WATER));
			c.sim.world.natural(p(1, G - 1, 1), Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 7));
			c.sim.world.natural(p(3, G, 1), Blocks.ICE.defaultBlockState());
			exact(c.sim.end());
		}
	}

	/**
	 * (CU through a hand-down) A tile's copper weathered, then a site stacked over it captured the weathered stage as its before. The tile
	 * is removed first (covered): its cell hands down only if the weathered stage still matches what it wrote (WorldJournal.same).
	 */
	@Test
	void p3_aCoveredWeatheredCellHandsDown() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(2, G, 2), COPPER));
			c.sim.world.natural(p(2, G, 2), Blocks.COPPER_BLOCK.asList().get(1).defaultBlockState());
			c.site(1, G, 1, 3, G + 1, 3, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
			c.sim.removeGroup(List.of(t), null);
			exact(c.sim.end());
		}
	}

	/** (6c PT) A site placed over a player's wall (records): its removal gives the blocks and their records back. */
	@Test
	void p3_aBoxGivesPlayerRecordsBack() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
			for (int i = 1; i <= 3; i++) {
				w.put0(p(i, G + 1, 2), Blocks.COBBLESTONE.defaultBlockState(), null, PLAYER);
			}
		})) {
			c.site(0, G, 0, 4, G + 2, 4, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 0);
			assertEquals(null, c.record(p(2, G + 1, 2)), "Architect's write cleared the record");
			exact(c.sim.end());
			assertEquals(PLAYER, c.record(p(2, G + 1, 2)));
		}
	}

	// ------------------------------------------------------------------ P4: neighbour effects

	/**
	 * (history: relief re-tick 7bd8c817; vanilla V9) A tile over a stream's flowing cells: its removal writes the flowing water back with
	 * no side effects, so production SiteJournal.writeCells queues each for one fluid tick (FluidRearm); sources are never woken.
	 */
	@Test
	void p4_restoredFlowingWaterIsQueuedForATick() throws Exception {
		BlockState flow3 = Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 3);
		BlockState flow5 = Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 5);
		try (UmtCase c = UmtCase.of(w -> {
			w.put0(p(1, G, 1), Blocks.WATER.defaultBlockState(), null, null);
			w.put0(p(2, G, 1), flow3, null, null);
			w.put0(p(3, G, 1), flow5, null, null);
		})) {
			UmtSim.Rec t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.DIRT, p(2, G, 1), Blocks.DIRT, p(3, G, 1), Blocks.DIRT));
			FluidRearm.clear();
			c.sim.removeGroup(List.of(t), null);
			assertTrue(FluidRearm.pending(UmtWorld.DIM, p(2, G, 1)) && FluidRearm.pending(UmtWorld.DIM, p(3, G, 1)), "every flowing cell waits for its tick");
			assertFalse(FluidRearm.pending(UmtWorld.DIM, p(1, G, 1)), "a source is never woken");
			exact(c.sim.end());
		}
	}

	/**
	 * (history: the sand vanish 70fc0dd0; vanilla V2) A tile that changes a cell under sand whose support stays solid leaves the sand
	 * (TileCheck.keepsGravity): it stands while the tile stands, and the removal is exact. Over a cell that becomes free it is cleared
	 * with the tile and comes back.
	 */
	@Test
	void p4_supportedSandStaysOverATile() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
			w.put0(p(1, G, 1), Blocks.STONE.defaultBlockState(), null, null);
			w.put0(p(1, G + 1, 1), Blocks.SAND.defaultBlockState(), null, null);
			w.put0(p(3, G, 1), Blocks.STONE.defaultBlockState(), null, null);
			w.put0(p(3, G + 1, 1), Blocks.SAND.defaultBlockState(), null, null);
		})) {
			c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.COBBLESTONE, p(3, G, 1), Blocks.AIR));
			c.sim.world.tick();
			assertEquals(Blocks.SAND, c.at(p(1, G + 1, 1)).getBlock(), "the sand over a cell paved solid stays while the tile stands");
			assertEquals(Blocks.AIR, c.at(p(3, G + 1, 1)).getBlock(), "the sand over a carved cell went with the tile");
			exact(c.sim.end());
		}
	}

	/**
	 * (vanilla V3, lamp-path's chain) A path the world held before anything turns to dirt under a site's solid write only if the path is
	 * outside the site's box; inside, the box's undo restores it. Here the box covers it: exact.
	 */
	@Test
	void p4_aPathInsideABoxComesBack() throws Exception {
		try (UmtCase c = UmtCase.of(w -> w.put0(p(2, G, 2), Blocks.DIRT_PATH.defaultBlockState(), null, null))) {
			c.site(1, G, 1, 3, G + 1, 3, Blocks.AIR.defaultBlockState(), cells(p(2, G + 1, 2), Blocks.OAK_FENCE), 0);
			exact(c.sim.end());
		}
	}

	// ------------------------------------------------------------------ the crash window between R2 and R4 (coordinator, GPT-6.1 review of 6d)

	/** A kill right after the durable R2 commit (K6) and mid-R4 (K7), single and group removal, a region (tile) among them: recovery is exact. */
	@Test
	void r2r4_killAfterTheDurableUndoAndMidWritesRecovers() throws Exception {
		for (String point : new String[] {"K6", "K7", "R5"}) {
			for (boolean group : new boolean[] {false, true}) {
				for (int n = 0; n < 3; n++) {
					try (UmtCase c = UmtCase.of(w -> {
					})) {
						// side by side (a stacked pair is F1's ground, a finding of its own)
						UmtSim.Rec t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(5, G, 1), Blocks.COBBLESTONE, p(6, G, 1), Blocks.DIRT_PATH, p(5, G, 2),
							Blocks.AIR));
						UmtSim.Rec s = c.site(0, G, 0, 3, G + 2, 3, Blocks.AIR.defaultBlockState(), cells(p(1, G, 1), Blocks.STONE_BRICKS, p(2, G + 1, 2),
							Blocks.OAK_PLANKS), 1);
						UmtOps.Crash k = new UmtOps.Crash(point, null, n * 7, n == 1);
						try {
							if (group) {
								c.sim.removeGroup(List.of(t, s), k);
							} else {
								c.sim.remove(s, k);
							}
						} catch (UmtSim.Halt h) {
							c.sim.restart(true);
						}
						List<String> v = new ArrayList<>(c.sim.end().stream().filter(x -> !x.startsWith("[UC] ")).toList());
						if (!v.isEmpty()) {
							v.add(0, point + " group " + group + " n " + n + "\n" + c.sim.report());
						}
						exact(v);
					}
				}
			}
		}
	}

	/**
	 * (F1, fixed) Two stacked sites removed upper first, then lower, then a start: the upper's undo wrote the lower's blocks, and the
	 * lower's undo has since written the ground there. Sites.evidence reads the later undo of the cell's holder below, so the upper
	 * settles as restored: no record and no journal entry is left, and the world is exact. Also with a lot over a site and a site over
	 * a tile (a BOX entry over a CELL one).
	 */
	@Test
	void f1_aStackedPairRemovedTopDownSettles() throws Exception {
		for (int variant = 0; variant < 3; variant++) {
			try (UmtCase c = UmtCase.of(w -> {
			})) {
				UmtSim.Rec lower = variant == 2 ? c.sim.cells(UmtOps.Kind.TILE, 0, cells(p(1, G, 1), Blocks.COBBLESTONE, p(2, G, 2), Blocks.COBBLESTONE, p(3, G,
					3), Blocks.DIRT_PATH)) : c.site(0, G, 0, 5, G + 2, 5, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 0);
				UmtSim.Rec upper = c.site(1, G, 1, 4, G + 3, 4, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), variant == 1 ? 1 : 0);
				c.sim.remove(upper, null);
				if (lower.kind == UmtOps.Kind.TILE) {
					c.sim.removeGroup(List.of(lower), null);
				} else {
					c.sim.remove(lower, null);
				}
				c.sim.restart(false);
				assertTrue(c.sim.recs.isEmpty(), "variant " + variant + ": pending records left: " + c.sim.recs.values() + "; kept on " + c.sim.kept + "\n"
					+ c.sim.report());
				assertTrue(c.sim.store.index().entries().isEmpty(), "variant " + variant + ": journal entries left: " + c.sim.store.index().entries().keySet());
				exact(c.sim.end());
			}
		}
	}

	/**
	 * (F4, fixed) A kill inside a group removal's R2 commit (the K8 window: files written, index not): Groups.committed had saved the
	 * removal with its undo group. Groups.Removal.fromJson finds that group in no journal entry and plans the removal again, so the
	 * resumed removal restores every member and the end is exact. Each I/O step of the commit (the last, after the index: durable, the saved
	 * group kept), with and without an autosave.
	 */
	@Test
	void f4_aGroupRemovalKilledInsideR2IsPlannedAgain() throws Exception {
		for (String step : new String[] {"write", "move", "index", "committed"}) {
			for (boolean save : new boolean[] {false, true}) {
				try (UmtCase c = UmtCase.of(w -> {
				})) {
					UmtSim.Rec t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(1, G, 1), Blocks.COBBLESTONE, p(2, G, 1), Blocks.DIRT_PATH));
					UmtSim.Rec s = c.site(3, G, 3, 5, G + 2, 5, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
					try {
						c.sim.removeGroup(List.of(t, s), new UmtOps.Crash("R2", step, 0, save));
					} catch (UmtSim.Halt h) {
						c.sim.restart(true);
					}
					List<String> v = new ArrayList<>(c.sim.end().stream().filter(x -> !x.startsWith("[UC] ")).toList());
					if (!v.isEmpty()) {
						v.add(0, "R2 " + step + " save " + save + "\n" + c.sim.report());
					}
					exact(v);
				}
			}
		}
	}

	/**
	 * (F6 hazard, crash-safety review) An unclean stop during a group removal's writes, the world back at an autosave before the
	 * removal: a member already written (out of the saved removal's sites, so the settle judges it) shows its blocks again and settles
	 * RECOVER. Its reactivation must not take back the members the resumed removal is still writing (the removal would write their
	 * restore over ACTIVE entries); the members stay pending while the removal is persisted, and a RECOVER takes back only the members
	 * whose own evidence stands; the written member whose writes were lost is written again by the resumed removal (roll forward), so
	 * the next start settles the whole removal. Three side-by-side members (a tile among them), the stop at each member.
	 */
	@Test
	void f6_aRecoverNeverReactivatesMembersOfAResumingRemoval() throws Exception {
		for (int n = 0; n < 3; n++) {
			for (boolean tileFirst : new boolean[] {false, true}) {
				try (UmtCase c = UmtCase.of(w -> {
				})) {
					List<UmtSim.Rec> members = new ArrayList<>();
					UmtSim.Rec t = null;
					if (tileFirst) {
						t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(6, G, 6), Blocks.COBBLESTONE, p(7, G, 6), Blocks.DIRT_PATH));
					}
					members.add(c.site(0, G, 0, 1, G + 2, 1, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1));
					members.add(c.site(3, G, 0, 4, G + 2, 1, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 1));
					if (!tileFirst) {
						t = c.sim.cells(UmtOps.Kind.TILE, 1, cells(p(6, G, 6), Blocks.COBBLESTONE, p(7, G, 6), Blocks.DIRT_PATH));
					}
					members.add(t);
					c.sim.world.autosave();
					try {
						c.sim.removeGroup(members, new UmtOps.Crash("K7", null, n, false));
					} catch (UmtSim.Halt h) {
						String g = SiteJournal.lastGroup(members.get(0).id);
						c.sim.restart(true);
						// the resumed removal kept its undo group: no member was taken back and planned again under another group
						for (UmtSim.Rec m : members) {
							String now = SiteJournal.lastGroup(m.id);
							assertTrue(now == null || now.equals(g), "K7 n " + n + " tileFirst " + tileFirst + ": " + m.id + " was taken back from " + g
								+ " while its removal was queued (now " + now + ")\n" + c.sim.report());
						}
						// a written member whose writes the stop lost was written again (Groups.writeAgainIn): the next start settles every member
						c.sim.restart(false);
						assertTrue(c.sim.recs.isEmpty() && c.sim.store.index().entries().isEmpty(), "K7 n " + n + " tileFirst " + tileFirst
							+ ": the next start settles the whole removal: records " + c.sim.recs.values() + ", entries " + c.sim.store.index().entries()
								.keySet() + "\n" + c.sim.report());
					}
					List<String> v = new ArrayList<>(c.sim.end().stream().filter(x -> !x.startsWith("[UC] ")).toList());
					if (!v.isEmpty()) {
						v.add(0, "K7 n " + n + " tileFirst " + tileFirst + "\n" + c.sim.report());
					}
					exact(v);
				}
			}
		}
	}

	/**
	 * (F6) A stacked pair removed as one group; the upper's writes are lost (it stands again), the lower's landed (restored). The lower
	 * settles RELEASE, the upper RECOVER alone (Sites.recoverScope). Its before at the shared cells was the lower's block: Journal.reactivate
	 * gives it what the group's undo wrote there, so removing the upper again puts back the ground, not the lower's bricks.
	 */
	@Test
	void f6_anUpperTakenBackAloneGetsTheUndosValuesUnderIt() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec lower = c.site(0, G, 0, 5, G + 2, 5, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 1);
			UmtSim.Rec upper = c.site(5, G, 5, 7, G + 3, 7, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
			c.sim.removeGroup(List.of(lower, upper), null);
			for (int y = G; y <= G + 3; y++) {
				for (int z = 5; z <= 7; z++) {
					for (int x = 5; x <= 7; x++) {
						c.sim.world.put0(p(x, y, z), Blocks.OAK_PLANKS.defaultBlockState(), null, null); // the upper's restore lost
					}
				}
			}
			c.sim.restart(false);
			assertTrue(!c.sim.recs.get(upper.id).pending && !c.sim.recs.containsKey(lower.id), "the upper stands again, the lower is settled:\n" + c.sim
				.report());
			exact(c.sim.end());
		}
	}

	/**
	 * (F6, fixed; was UmtFindingsTest's repro) Sites.reconcile settles each pending site on its own evidence; a RECOVER takes back
	 * only the members whose own evidence stands (Sites.recoverScope), so a member whose cells show it removed is not brought back.
	 */
	@Test
	void f6_oneMembersRecoverTakesBackOnlyStandingMembers() throws Exception {
		UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(1991L, List.of(new UmtOps.Place(UmtOps.Kind.SITE, 27, 26, 9, 3, 3, 5368466833381451274L, 1,
			null), new UmtOps.Restart(), new UmtOps.Place(UmtOps.Kind.TILE, 28, 29, 7, 7, 6, -4780181343283276411L, 1, null), new UmtOps.RemoveGroup(1, null),
			new UmtOps.Place(UmtOps.Kind.LOT, 23, 28, 9, 5, 6, 3259127719780762313L, 0, null), new UmtOps.Place(UmtOps.Kind.LOT, 26, 16, 2, 4, 6,
				-2838765659432227269L, 2, new UmtOps.Crash("P3", "index", 20, false))), UmtOps.Gen.ALL));
		assertTrue(r.violations().stream().noneMatch(v -> v.startsWith("[F6]")), r.report());
	}

	/**
	 * (F4) Groups.Removal.toJson, production: while the R2 commit is not durable (Groups.committed has submitted it), the removal's undo
	 * group is saved as planned, so a stop inside the commit loads as planned and the journal decides; once durable, as its undo.
	 */
	@Test
	void f4_aPendingCommitIsSavedAsPlanned() {
		Groups.Removal r = new Groups.Removal("g", null, null, false);
		r.sites.add("s1");
		r.undo = "u:group-g:1";
		r.undoSites.add("s1");
		r.commit = new java.util.concurrent.CompletableFuture<>();
		com.google.gson.JsonObject pending = r.toJson();
		assertFalse(pending.has("undo"), "no undo while its commit is not durable: " + pending);
		assertEquals("u:group-g:1", pending.get("planned").getAsString());
		assertEquals("s1", pending.getAsJsonArray("plannedSites").get(0).getAsString());
		r.commit = null; // Groups.tick: the commit completed
		com.google.gson.JsonObject durable = r.toJson();
		assertEquals("u:group-g:1", durable.get("undo").getAsString());
		assertFalse(durable.has("planned"), durable.toString());
	}

	/**
	 * (LP, fixed by fix/lamp-path; was UmtFindingsTest's repro) Lamp on dirt path, the journal half: a road's dirt path under a site's solid block
	 * written just above it (Sites.FLAGS, outside the road's cells) turns to dirt (V3); the road's removal finds dirt, not its path,
	 * leaves it, and the grass never comes back.
	 */
	@Test
	void lp_aJournaledPathTurnedToDirtIsStillOurs() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec road = c.sim.cells(UmtOps.Kind.ROAD, 0, cells(p(2, G, 2), Blocks.DIRT_PATH, p(3, G, 2), Blocks.DIRT_PATH));
			UmtSim.Rec post = c.site(2, G + 1, 2, 2, G + 2, 2, Blocks.AIR.defaultBlockState(), cells(p(2, G + 1, 2), Blocks.OAK_FENCE, p(2, G + 2, 2),
				Blocks.LANTERN), 0);
			assertEquals(Blocks.DIRT, c.at(p(2, G, 2)).getBlock(), "V3: the path under the post turned to dirt");
			c.sim.remove(post, null);
			c.sim.remove(road, null);
			exact(c.sim.end());
		}
	}

	/** (F4) Groups.Removal.fromJson, production: a saved undo group the journal has is kept; one it never got is dropped (planned again). */
	@Test
	void f4_aSavedRemovalFollowsTheJournalsCommit() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec s = c.site(1, G, 1, 3, G + 2, 3, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
			c.sim.removeGroup(List.of(s), null);
			String committed = SiteJournal.lastGroup(s.id);
			assertNotNull(committed, "the group removal's undo is in the journal");
			for (String undo : new String[] {committed, "u:group-never:1"}) {
				com.google.gson.JsonObject o = com.google.gson.JsonParser.parseString("{\"group\":\"g\",\"sites\":[\"" + s.id + "\"],\"force\":false,"
					+ "\"started\":true,\"waited\":0,\"refund\":{},\"undo\":\"" + undo + "\",\"undoSites\":[\"" + s.id + "\"],\"handed\":{\"" + s.id
					+ "\":3},\"restoredCells\":7}").getAsJsonObject();
				Groups.Removal r = Groups.Removal.fromJson(o);
				if (undo.equals(committed)) {
					assertEquals(committed, r.undo);
					assertEquals(List.of(s.id), r.undoSites);
					assertEquals(7, r.restoredCells);
				} else {
					assertEquals(null, r.undo, "an undo group the journal never got is not resumed as committed");
					assertEquals(undo, r.planned, "it is kept as planned: the load asks the journal (resumeCommitted: planned again)");
					assertTrue(r.undoSites.isEmpty() && r.handed.isEmpty() && r.restoredCells == 0);
					assertEquals(List.of(s.id), r.sites, "its sites stay to be removed");
				}
			}
		}
	}

	// ------------------------------------------------------------------ P5: accounting

	/**
	 * (C29, 6c Y) A removal credits a stockpile's refund once its restore is written, once per key: a crash anywhere between the credit,
	 * the ledger's save and the removal's own save, then the resumed removal crediting again, books it exactly once. The ledger
	 * (StockLedger.credit, toJson/fromJson) is production; the saves around it are modelled as Groups.credit and Stockpiles do them.
	 */
	@Test
	void p5_aRefundIsCreditedOncePerKeyAcrossCrashes() {
		Map<String, Integer> items = Map.of("minecraft:cobblestone", 12, "minecraft:oak_planks", 5);
		for (int crashAt = 0; crashAt <= 3; crashAt++) {
			StockLedger live = new StockLedger();
			com.google.gson.JsonObject savedLedger = live.toJson();
			boolean removalSaved = false;
			// 0: credit in memory, 1: ledger saved, 2: removal moved past the member and saved, 3: no crash
			live.credit("road:r1@1", items, 27, i -> 64);
			if (crashAt > 0) {
				savedLedger = live.toJson();
			}
			if (crashAt > 1) {
				removalSaved = true;
			}
			StockLedger after = StockLedger.fromJson(savedLedger);
			if (!removalSaved) {
				after.credit("road:r1@1", items, 27, i -> 64); // the resumed removal credits the member again
			}
			assertEquals(12, after.stock("minecraft:cobblestone"), "crash at " + crashAt + ": once");
			assertEquals(5, after.stock("minecraft:oak_planks"), "crash at " + crashAt + ": once");
			assertTrue(after.identityHolds());
		}
	}

	// ------------------------------------------------------------------ P6: the history's other undo cases

	/**
	 * (H §4.2, the drain's rule the breach-sweep fix c170b161 refined; RegionFluids.drain, production, through its seam) A body's drain
	 * puts its own sources back and takes its own predicted flow, but water that was there before the write (a watched cell holding its
	 * before state) and water outside every list stay. The breach sweep itself (breachFlow) reads the level: in game only (irr-ingame).
	 */
	@Test
	void p6_aDrainKeepsForeignWater() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			long src = p(1, G, 1);
			long flow = p(2, G, 1);
			long foreign = p(4, G, 1);
			String grass = dev.larattalabs.architect.region.UmtDrain.stateString(Blocks.GRASS_BLOCK.defaultBlockState());
			c.sim.world.put0(src, Blocks.WATER.defaultBlockState(), null, null);
			c.sim.world.put0(flow, Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 1), null, null);
			c.sim.world.put0(foreign, Blocks.WATER.defaultBlockState(), null, PLAYER);
			long beside = p(5, G, 1);
			c.sim.world.put0(beside, Blocks.WATER.defaultBlockState(), null, PLAYER);
			int n = dev.larattalabs.architect.region.UmtDrain.drain(drainCells(c), new long[] {src}, new String[] {grass}, new long[] {foreign}, new String[] {
				dev.larattalabs.architect.region.UmtDrain.stateString(Blocks.WATER.defaultBlockState())}, new long[] {flow});
			assertEquals(2, n);
			assertEquals(Blocks.GRASS_BLOCK, c.at(src).getBlock());
			assertEquals(Blocks.AIR, c.at(flow).getBlock());
			assertEquals(Blocks.WATER, c.at(foreign).getBlock(), "water that was there before the write stays");
			assertEquals(Blocks.WATER, c.at(beside).getBlock(), "a player's water outside the body stays");
		}
	}

	static dev.larattalabs.architect.region.UmtDrain.Cells drainCells(UmtCase c) {
		return new dev.larattalabs.architect.region.UmtDrain.Cells() {
			@Override
			public BlockState get(net.minecraft.core.BlockPos p) {
				return c.sim.world.get(p.asLong());
			}

			@Override
			public void set(net.minecraft.core.BlockPos p, BlockState s, int flags) {
				c.sim.world.write(p.asLong(), s, null, flags);
			}
		};
	}

	/** Every kill point of a fixed two-site, one-road scenario, each I/O step of each commit: recovery and the final removal are exact. */
	@Test
	void p2_everyKillPointOfOneScenario() throws Exception {
		List<String> bad = new ArrayList<>();
		int runs = 0;
		List<UmtOps.Crash> crashes = new ArrayList<>();
		for (String pt : UmtOps.PLACE_POINTS) {
			for (String io : pt.equals("P3") || pt.equals("P7") ? UmtOps.IO : new String[] {null}) {
				crashes.add(new UmtOps.Crash(pt, io, 5, false));
				crashes.add(new UmtOps.Crash(pt, io, 5, true));
			}
		}
		for (String pt : UmtOps.REMOVE_POINTS) {
			for (String io : pt.equals("R2") ? UmtOps.IO : new String[] {null}) {
				crashes.add(new UmtOps.Crash(pt, io, 3, false));
				crashes.add(new UmtOps.Crash(pt, io, 3, true));
			}
		}
		for (UmtOps.Crash k : crashes) {
			boolean place = List.of(UmtOps.PLACE_POINTS).contains(k.point());
			for (UmtOps.Kind kind : new UmtOps.Kind[] {UmtOps.Kind.SITE, UmtOps.Kind.ROAD}) {
				List<UmtOps.Op> ops = List.of(new UmtOps.Place(UmtOps.Kind.SITE, 20, 20, 5, 5, 4, 11L, 1, null), new UmtOps.Place(kind, 22, 22, 6, 4, 4, 12L, 1,
					place ? k : null), new UmtOps.Remove(1, place ? null : k), new UmtOps.Autosave(), new UmtOps.Remove(0, null));
				UmtRunner.Result r = UmtRunner.run(new UmtOps.Scenario(4242L, ops, UmtOps.Gen.CRASH));
				runs++;
				for (String v : r.violations()) {
					if (!UmtRunner.known(v)) {
						bad.add(k + " " + kind + ": " + v);
					}
				}
			}
		}
		assertTrue(runs > 60);
		assertTrue(bad.isEmpty(), String.join("\n", bad));
	}

	/** The table's rows that can fire do (a generator that stopped reaching one is a gap). */
	@Test
	void vanillaTableIsWellFormed() {
		assertNotNull(UmtVanilla.TABLE);
		for (UmtVanilla.Rule r : UmtVanilla.TABLE) {
			assertFalse(r.probe().isBlank(), r.id());
			assertFalse(r.covers().isBlank(), r.id());
		}
	}
}
