package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The tile writer's dependents rule for gravity blocks (the T3 sand-vanish anomaly): a gravity block on a changed cell stays only when
 * that cell holds it up before and after the write; otherwise it is cleared with the entry as before. Other dependents always go.
 */
class TileGravityTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static BlockState s(Block b) {
		return b.defaultBlockState();
	}

	@Test
	void sandOnASolidSupportRewrittenSolidStays() {
		for (Block above : new Block[] {Blocks.SAND, Blocks.RED_SAND, Blocks.GRAVEL}) {
			assertTrue(TileCheck.keepsGravity(s(above), s(Blocks.GRASS_BLOCK), s(Blocks.STONE)), above + " on grass -> stone");
			assertTrue(TileCheck.keepsGravity(s(above), s(Blocks.STONE), s(Blocks.STONE_BRICKS)), above + " on stone -> stone bricks (a tunnel lining)");
			assertTrue(TileCheck.keepsGravity(s(above), s(Blocks.SANDSTONE), s(Blocks.SAND)), above + " on sandstone -> sand");
			assertTrue(TileCheck.keepsGravity(s(above), s(Blocks.DIRT), s(Blocks.STONE_SLAB)), above + " on dirt -> a slab (not free in vanilla)");
		}
	}

	@Test
	void aSupportThatBecomesFreeClearsIt() {
		assertFalse(TileCheck.keepsGravity(s(Blocks.SAND), s(Blocks.STONE), s(Blocks.AIR)), "a carved support");
		assertFalse(TileCheck.keepsGravity(s(Blocks.SAND), s(Blocks.STONE), s(Blocks.WATER)), "a support turned to water");
		assertFalse(TileCheck.keepsGravity(s(Blocks.GRAVEL), s(Blocks.DIRT), s(Blocks.SHORT_GRASS)), "a replaceable new state");
		assertFalse(TileCheck.keepsGravity(s(Blocks.SAND), s(Blocks.STONE), null), "no planned state");
	}

	@Test
	void sandHangingOverAFreeCellIsClearedSoTheUndoRestoresIt() {
		// worldgen sand over air (or water) whose free cell the tile fills: kept, it would stay hanging after the undo puts the air
		// back only until its next update; clearing it makes the undo exact
		assertFalse(TileCheck.keepsGravity(s(Blocks.SAND), s(Blocks.AIR), s(Blocks.STONE)));
		assertFalse(TileCheck.keepsGravity(s(Blocks.SAND), s(Blocks.WATER), s(Blocks.STONE)));
		assertFalse(TileCheck.keepsGravity(s(Blocks.GRAVEL), s(Blocks.SHORT_GRASS), s(Blocks.DIRT)));
	}

	@Test
	void otherDependentsAreNeverKept() {
		for (Block above : new Block[] {Blocks.SHORT_GRASS, Blocks.SNOW, Blocks.POPPY, Blocks.SUGAR_CANE, Blocks.MOSS_CARPET}) {
			assertTrue(TileCheck.dependent(s(above)), above + " is a dependent");
			assertFalse(TileCheck.keepsGravity(s(above), s(Blocks.GRASS_BLOCK), s(Blocks.STONE)), above + " on grass -> stone still goes");
		}
	}
}
