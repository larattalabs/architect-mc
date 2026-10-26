package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.BubbleColumnBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (7a LF §4, §9 item 9; the verifier re-runs it) "Still ours" for a lift's column, a global row: a cell written as a bubble column holds as
 * any bubble column (either drag: vanilla turns the column over its base), as a water source or as air; a cell written as a water source
 * holds as a bubble column (water over soul sand or magma becomes one); a player's block in a shaft cell does not; the journal's own
 * readings (holds, same: what deltas, versionOf, adopt counts and survival matches ask) agree, so the column's drag ticks change none of
 * them. Nothing else moves: an ice cap is no bubble column, lava is not water, a flowing state written is no source.
 */
class StillOursLFTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static BlockState bubble(boolean drag) {
		return Blocks.BUBBLE_COLUMN.defaultBlockState().setValue(BubbleColumnBlock.DRAG_DOWN, drag);
	}

	static boolean holds(BlockState now, BlockState after) {
		return StillOurs.holds(now, null, after, null);
	}

	@Test
	void aWrittenColumnHoldsAsAnyColumnAWaterSourceOrAir() {
		BlockState water = Blocks.WATER.defaultBlockState(), air = Blocks.AIR.defaultBlockState();
		for (boolean wrote : new boolean[] {false, true}) {
			for (BlockState now : new BlockState[] {bubble(false), bubble(true), water, air}) {
				assertTrue(StillOurs.fluidHolds(now, bubble(wrote)), "bubble(drag=" + wrote + ") written, now " + now);
				assertTrue(holds(now, bubble(wrote)), "holds: bubble(drag=" + wrote + ") written, now " + now);
				assertTrue(WorldJournal.same(WorldJournal.value(now), WorldJournal.value(bubble(wrote))), "same (deltas, versionOf, adopt): " + now);
				assertTrue(WorldJournal.holds(now, () -> null, WorldJournal.value(bubble(wrote))), "the journal's holds (undo, survival matches): " + now);
			}
			// a player's block in a shaft cell is not the entry's; nor is flowing water or lava
			for (BlockState now : new BlockState[] {Blocks.COBBLESTONE.defaultBlockState(), Blocks.SOUL_SAND.defaultBlockState(), water.setValue(LiquidBlock.LEVEL, 3),
				Blocks.LAVA.defaultBlockState(), Blocks.ICE.defaultBlockState()}) {
				assertFalse(holds(now, bubble(wrote)), "bubble(drag=" + wrote + ") written, now " + now);
				assertFalse(WorldJournal.holds(now, () -> null, WorldJournal.value(bubble(wrote))), "the journal's holds, now " + now);
			}
		}
	}

	@Test
	void aWrittenWaterSourceHoldsAsAColumn() {
		BlockState water = Blocks.WATER.defaultBlockState();
		for (boolean drag : new boolean[] {false, true}) {
			assertTrue(StillOurs.fluidHolds(bubble(drag), water), "a source over soul sand or magma");
			assertTrue(holds(bubble(drag), water));
			assertTrue(WorldJournal.same(WorldJournal.value(bubble(drag)), WorldJournal.value(water)));
			// an ice cap is no column; lava never holds as one
			assertFalse(holds(bubble(drag), Blocks.ICE.defaultBlockState()), "an ice cap is not a bubble column");
			assertFalse(holds(bubble(drag), Blocks.LAVA.defaultBlockState()), "lava is not water");
		}
		// the rows before LF are unchanged
		assertTrue(holds(Blocks.ICE.defaultBlockState(), water));
		assertTrue(holds(Blocks.AIR.defaultBlockState(), water));
		assertFalse(holds(Blocks.COBBLESTONE.defaultBlockState(), water), "a player's block in a pond");
		assertFalse(StillOurs.fluidHolds(bubble(true), water.setValue(LiquidBlock.LEVEL, 2)), "a flowing state written is no source");
		assertFalse(StillOurs.fluidHolds(bubble(false), Blocks.STONE.defaultBlockState()));
	}
}
