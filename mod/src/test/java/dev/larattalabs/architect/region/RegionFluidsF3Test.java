package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.StillOurs;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c F3-c, "Phase 6c slice F3" §3.4, §6, §7) The fluids stage's reading of a body's {@code decor} set (the coral grown in it): the
 * cells and their states, a coral pond is not a course (not ordered), the gate's check reads a decor cell holding its decor as open, a
 * drain never takes a decor cell (the group undo restores it after the drain, with the bed), a waterlogged decor block is a water source
 * for the census, an older mod's list lacks the kind (PLAN_STALE), and a dead coral still holds the live one the entry wrote.
 */
class RegionFluidsF3Test {
	/** A 3-cell column pond (63..65 at 0,0) with a fan in its lowest cell and a coral block in its bed (0,62,0), and a plain pond. */
	static final String IR = "{\"parts\":["
		+ "{\"id\":\"w_pond\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"w_pond\",\"part\":\"pond\",\"fluid\":\"water\",\"level\":65,"
		+ "\"cells\":[[0,0,63,65],[1,0,63,65]],\"shell\":[[0,0,62,62],[1,0,62,62]],\"settleTicks\":30,"
		+ "\"decor\":[{\"state\":\"minecraft:brain_coral_block\",\"cells\":[[0,0,62,62]]},{\"state\":\"minecraft:brain_coral_fan[waterlogged=true]\",\"cells\":[[0,0,63,63]]},"
		+ "{\"state\":\"minecraft:sea_pickle[pickles=1,waterlogged=true]\",\"cells\":[[1,0,63,63]]}]}]},"
		+ "{\"id\":\"w_plain\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"w_plain\",\"part\":\"plain\",\"fluid\":\"water\",\"level\":63,\"cells\":[[9,9,63,63]],\"settleTicks\":30}]}]}";

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static List<RegionFluids.Body> bodies() {
		return RegionFluids.bodiesOf(JsonParser.parseString(IR).getAsJsonObject());
	}

	@Test
	void theDecorSet() {
		RegionFluids.Body b = bodies().get(0);
		assertEquals(3, b.decor.length);
		assertEquals("minecraft:brain_coral_block", b.decorState.get(BlockPos.asLong(0, 62, 0)), "a bed cell's coral block");
		assertEquals("minecraft:brain_coral_fan[waterlogged=true]", b.decorState.get(BlockPos.asLong(0, 63, 0)));
		assertEquals("minecraft:sea_pickle[pickles=1,waterlogged=true]", b.decorState.get(BlockPos.asLong(1, 63, 0)));
		assertTrue(b.decorSet().contains(BlockPos.asLong(0, 62, 0)));
		RegionFluids.Body plain = bodies().get(1);
		assertEquals(0, plain.decor.length, "a body without coral reads none");
		assertArrayEquals(new long[0], plain.decor);
	}

	@Test
	void aCoralPondIsNoCourse() {
		List<RegionFluids.Body> b = bodies();
		assertFalse(b.get(0).course(), "decor is no course member");
		RegionFluids.Regional st = new RegionFluids.Regional(b);
		assertFalse(st.ordered, "a coral pond is written by the tiles with the others, not in waves");
	}

	@Test
	void theGateReadsDecorAsOpen() {
		RegionFluids.Body b = bodies().get(0);
		long fan = BlockPos.asLong(0, 63, 0), pickle = BlockPos.asLong(1, 63, 0), water = BlockPos.asLong(0, 64, 0);
		assertTrue(RegionFluids.openCell(b, fan, Blocks.AIR.defaultBlockState()));
		assertTrue(RegionFluids.openCell(b, fan, Blocks.WATER.defaultBlockState()));
		assertTrue(RegionFluids.openCell(b, fan, RegionFluids.parse("minecraft:brain_coral_fan[waterlogged=true]")), "the tiles wrote it before a stop");
		assertTrue(RegionFluids.openCell(b, pickle, RegionFluids.parse("minecraft:sea_pickle[pickles=1,waterlogged=true]")));
		assertFalse(RegionFluids.openCell(b, water, RegionFluids.parse("minecraft:brain_coral_fan[waterlogged=true]")), "a fan in a cell that is not its decor");
		assertFalse(RegionFluids.openCell(b, fan, Blocks.STONE.defaultBlockState()), "a player's block in a decor cell");
		assertFalse(RegionFluids.openCell(b, fan, RegionFluids.parse("minecraft:tube_coral_fan[waterlogged=true]")), "another coral is not its decor");
	}

	@Test
	void aDrainLeavesTheDecor() {
		RegionFluids.Body b = bodies().get(0);
		// (drainSkips is read by the removal's drain only: drain(level, st, b, bs, strays) passes removal = true, every other drain false)
		assertTrue(RegionFluids.drainSkips(b, BlockPos.asLong(0, 63, 0)), "a waterlogged fan: the undo restores it after the removal's drain");
		assertTrue(RegionFluids.drainSkips(b, BlockPos.asLong(0, 62, 0)), "a bed cell");
		assertFalse(RegionFluids.drainSkips(b, BlockPos.asLong(0, 64, 0)), "a source");
		assertFalse(RegionFluids.drainSkips(bodies().get(1), BlockPos.asLong(9, 63, 9)));
	}

	@Test
	void waterloggedDecorIsASourceForTheCensus() {
		// the census reads a body cell as its source when its fluid state is a water source: a waterlogged fan, plant, wall fan or pickle is
		for (String s : List.of("minecraft:brain_coral_fan[waterlogged=true]", "minecraft:fire_coral[waterlogged=true]",
			"minecraft:horn_coral_wall_fan[facing=north,waterlogged=true]", "minecraft:sea_pickle[pickles=4,waterlogged=true]")) {
			BlockState st = RegionFluids.parse(s);
			assertFalse(st.isAir(), s);
			FluidState f = st.getFluidState();
			assertTrue(f.isSource() && f.getType().isSame(Fluids.WATER), s + " is a water source");
		}
		// a coral block in the bed holds no fluid (the census never reads it: a shell cell) and stops a flow
		assertTrue(RegionFluids.parse("minecraft:brain_coral_block").getFluidState().isEmpty());
	}

	@Test
	void theKindAndStillOurs() {
		assertTrue(IrStale.KINDS_FORMAT2.contains("coralDecor"));
		assertEquals(IrStale.KINDS_FORMAT2.indexOf("survival") + 1, IrStale.KINDS_FORMAT2.indexOf("coralDecor"), "appended at the end (then 7a LF's bubbleColumns after it)");
		assertNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "coralDecor"), null), "this mod reads it");
		assertNotNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "coralDecor-v2"), null), "an unknown kind is refused");
		// a coral that died in a drained pond is still the live one the entry wrote (CU's chain, F3-a's Coral), a fan's facing compares
		assertTrue(StillOurs.holds(Blocks.DEAD_BRAIN_CORAL_BLOCK.defaultBlockState(), null, Blocks.BRAIN_CORAL_BLOCK.defaultBlockState(), null));
		assertTrue(StillOurs.holds(RegionFluids.parse("minecraft:dead_brain_coral_fan[waterlogged=false]"), null, RegionFluids.parse("minecraft:brain_coral_fan[waterlogged=true]"), null));
		assertFalse(StillOurs.holds(RegionFluids.parse("minecraft:dead_horn_coral_wall_fan[facing=south,waterlogged=false]"), null,
			RegionFluids.parse("minecraft:horn_coral_wall_fan[facing=north,waterlogged=true]"), null));
	}
}
