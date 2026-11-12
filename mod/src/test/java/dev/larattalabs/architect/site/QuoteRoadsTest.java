package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.TerrainFit;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (M5 QT) A quote's lot verdict sees the plan's own 4e roads as standing ({@link Sites#QUOTE_ROADS}): the approach stops at them as it does at
 * put-down, so a lot facing a plan road has no approach and its bill is its template's, while a lot with no road in front gets its approach's
 * cells billed over the template's. A quote's verdict never seeds the placement's check cache.
 */
class QuoteRoadsTest {
	/** A 10 x 10 x 10 box at (0, 10, 0), the door's feet at y 11, the entrance column x 4, the front south (ApproachTest's). */
	static final Anchors.Bounds BOX = new Anchors.Bounds(0, 10, 0, 9, 19, 9);
	static final int FEET = 11;
	/** The template: a 3-cell plank floor inside the box. */
	static final int[] TEMPLATE = {3, 10, 5, 4, 10, 5, 5, 10, 5};

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void clear() {
		Sites.QUOTE_ROADS.remove();
	}

	/** Flat natural ground up to y 10, air above, with checkSite's ROAD flag over {@code roads} (Sites.approachRoads of none standing). */
	static TerrainFit.World world() {
		LongOpenHashSet roads = Sites.approachRoads(new LongOpenHashSet());
		return (x, y, z) -> (y <= 10 ? TerrainFit.NATURAL : TerrainFit.FILLABLE) | (roads.contains(BlockPos.asLong(x, y, z)) ? TerrainFit.ROAD : 0);
	}

	static Approach.Plan approach() {
		return Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, world());
	}

	/** The lot's bill as Sites.quoteBill sums it: C26's full bill of the template and the approach (FullBom.compute over air). */
	static FullBom.Result bill(Approach.Plan a) {
		BlockState plank = Blocks.OAK_PLANKS.defaultBlockState();
		FullBom.Inputs in = new FullBom.Inputs(net.minecraft.world.level.block.Rotation.NONE, TEMPLATE, new BlockState[] {plank, plank, plank}, (p, s) -> false,
			new int[0], new int[0], a.clear(), a.fill(), a.path(), a.slabs(), Blocks.STONE_BRICKS.defaultBlockState(), Blocks.COBBLESTONE.defaultBlockState(),
			Blocks.DIRT_PATH.defaultBlockState(), Blocks.OAK_SLAB.defaultBlockState());
		return FullBom.compute(in, p -> Blocks.AIR.defaultBlockState());
	}

	@Test
	void aLotWithNoRoadInFrontBillsItsApproachOverItsTemplate() {
		Approach.Plan a = approach();
		assertEquals(Approach.DEFAULT_LENGTH, a.rows(), "flat ground, no road: the whole default approach");
		assertEquals(18, a.pathCount(), "3 wide x 6 rows of path");
		FullBom.Result r = bill(a);
		assertEquals(3 + 18, r.cells(), "the template's 3 cells and the approach's 18");
		assertEquals(Map.of("minecraft:oak_planks", 3, "minecraft:dirt", 18), r.items(), "the approach's dirt path over the template's planks");
	}

	@Test
	void aLotFacingAPlanRoadHasNoApproachWhileItsQuoteRuns() {
		// the plan's street: the row just outside the box's south face (z 10, x 0..9) at the path's height (y 10), as its road's surface
		LongOpenHashSet street = new LongOpenHashSet();
		for (int x = 0; x <= 9; x++) {
			street.add(BlockPos.asLong(x, 10, 10));
		}
		Sites.QUOTE_ROADS.set(street);
		Approach.Plan a = approach();
		assertEquals(0, a.rows(), "the approach stops before its first row: a plan road stands there");
		assertEquals(0, a.pathCount());
		FullBom.Result r = bill(a);
		assertEquals(3, r.cells(), "the template's cells only");
		assertEquals(Map.of("minecraft:oak_planks", 3), r.items(), "the bill is the template's");
		Sites.QUOTE_ROADS.remove();
		assertEquals(18, approach().pathCount(), "outside the quote the same land has its approach again (the roads are the quote's alone)");
	}

	@Test
	void approachRoadsWidensTheStandingSetOnlyWhileAQuoteRuns() {
		LongOpenHashSet standing = new LongOpenHashSet(new long[] {BlockPos.asLong(1, 2, 3)});
		assertEquals(1, Sites.approachRoads(standing).size());
		Sites.QUOTE_ROADS.set(new LongOpenHashSet(new long[] {BlockPos.asLong(4, 5, 6), BlockPos.asLong(1, 2, 3)}));
		LongOpenHashSet w = Sites.approachRoads(new LongOpenHashSet(new long[] {BlockPos.asLong(1, 2, 3)}));
		assertEquals(2, w.size());
		assertTrue(w.contains(BlockPos.asLong(4, 5, 6)));
	}

	@Test
	void aQuotesVerdictNeverSeedsTheCheckCache() {
		assertTrue(Sites.seedsCheck(true, true, true, true), "a plain verdict with no refusal seeds it");
		assertFalse(Sites.seedsCheck(false, true, true, true));
		assertFalse(Sites.seedsCheck(true, false, true, true));
		Sites.QUOTE_ROADS.set(new LongOpenHashSet());
		assertFalse(Sites.seedsCheck(true, true, true, true), "never while a quote runs, even with no plan road");
		Sites.QUOTE_ROADS.remove();
		assertTrue(Sites.seedsCheck(true, true, true, true));
	}
}
