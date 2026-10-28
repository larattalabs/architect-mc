package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BubbleColumnBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7a LF, "Phase 7a slice LF" §4, §7) The fluids stage's reading of a lift's {@code bubble} set: the cells and their drags (an up column
 * over soul sand, a down column over magma), a lift is no course (not ordered), the gate's check reads a bubble cell holding its column as
 * open, a bubble column's fluid is a water source (the census counts it as the body's), the written state, the IR kind appended last (an
 * older mod's list lacks it: PLAN_STALE).
 */
class RegionFluidsLFTest {
	/** A lift: an up column 65..70 at (0, 0) and a down column 65..70 at (2, 0), as the kit writes the op (cells, bubble by state). */
	static final String IR = "{\"parts\":["
		+ "{\"id\":\"lift_lift\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"lift_lift\",\"part\":\"lift\",\"fluid\":\"water\",\"level\":70,"
		+ "\"cells\":[[0,0,65,70],[2,0,65,70]],\"shell\":[[0,0,64,64],[2,0,64,64]],\"settleTicks\":30,"
		+ "\"bubble\":[{\"state\":\"minecraft:bubble_column[drag=false]\",\"cells\":[[0,0,65,70]]},{\"state\":\"minecraft:bubble_column[drag=true]\",\"cells\":[[2,0,65,70]]}]}]},"
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
	void theBubbleSet() {
		RegionFluids.Body b = bodies().get(0);
		assertEquals(12, b.cells.length);
		assertEquals(12, b.bubble.size(), "every cell of the lift is a column cell");
		assertFalse(b.bubble.get(BlockPos.asLong(0, 65, 0)), "the up column: drag=false");
		assertTrue(b.bubble.get(BlockPos.asLong(2, 70, 0)), "the down column: drag=true");
		assertEquals(0, bodies().get(1).bubble.size(), "a pond reads none");
		assertFalse(b.course(), "a lift is no course member");
		assertFalse(new RegionFluids.Regional(bodies()).ordered, "a lift is written by the stage's tiles with the others, not in waves");
	}

	@Test
	void theWrittenStateAndItsFluid() {
		for (boolean drag : new boolean[] {false, true}) {
			BlockState s = RegionFluids.bubbleState(drag);
			assertTrue(s.is(Blocks.BUBBLE_COLUMN));
			assertEquals(drag, s.getValue(BubbleColumnBlock.DRAG_DOWN));
			assertEquals(s, RegionFluids.parse("minecraft:bubble_column[drag=" + drag + "]"), "the kit's state string");
			FluidState f = s.getFluidState();
			assertTrue(f.isSource() && f.getType().isSame(Fluids.WATER), "a column's fluid is a water source: the census's source");
		}
	}

	@Test
	void theGateReadsAColumnAsOpen() {
		RegionFluids.Body b = bodies().get(0);
		long up = BlockPos.asLong(0, 66, 0);
		assertTrue(RegionFluids.openCell(b, up, Blocks.AIR.defaultBlockState()));
		assertTrue(RegionFluids.openCell(b, up, Blocks.WATER.defaultBlockState()));
		assertTrue(RegionFluids.openCell(b, up, RegionFluids.bubbleState(false)), "the tiles wrote it before a stop");
		assertTrue(RegionFluids.openCell(b, up, RegionFluids.bubbleState(true)), "a column of the other drag: still open (re-written)");
		assertFalse(RegionFluids.openCell(b, up, Blocks.COBBLESTONE.defaultBlockState()), "a player's block in a shaft cell");
		assertFalse(RegionFluids.openCell(bodies().get(1), BlockPos.asLong(9, 63, 9), RegionFluids.bubbleState(false)), "a pond's cell holding a column is not its own");
	}

	@Test
	void theKindIsAppended() {
		assertEquals(IrStale.KINDS_FORMAT2.size() - 1, IrStale.KINDS_FORMAT2.indexOf("bubbleColumns"), "appended at the end, after coralDecor");
		assertEquals(IrStale.KINDS_FORMAT2.indexOf("coralDecor") + 1, IrStale.KINDS_FORMAT2.indexOf("bubbleColumns"));
		assertNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "bubbleColumns"), null), "this mod reads it");
		assertNotNull(IrStale.reason(PlanStaleTest.ir(2, IrStale.KIT_VERSION, "fluid", "bubbleColumns"), new IrStale.Hello(IrStale.KIT_VERSION, List.of(1, 2),
			IrStale.KINDS_FORMAT2.subList(0, IrStale.KINDS_FORMAT2.indexOf("bubbleColumns")))), "a helper before LF can't write the column: PLAN_STALE");
	}
}
