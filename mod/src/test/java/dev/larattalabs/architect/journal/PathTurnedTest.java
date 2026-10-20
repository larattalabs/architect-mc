package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * fix/lamp-path: a cell an entry wrote as a dirt path that vanilla turned to dirt (a solid block over it; the shape update that converts
 * it is no write of ours) is still the entry's for the journal's ownership, so an undo restores what was under the path. On Steward's
 * farm hamlet a road's lantern post stood on the lane's dirt path; a lot's write beside the post reconnected the fence, the path under
 * it ticked to dirt, and the removal kept the dirt (E-flat 1 at the lane's cell). One way only, a player's record (PT) wins, and the
 * builder's own test ({@link StillOurs#holds}) is unchanged.
 */
class PathTurnedTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void ourPathTurnedToDirtIsStillOurs() {
		BlockState path = Blocks.DIRT_PATH.defaultBlockState();
		BlockState dirt = Blocks.DIRT.defaultBlockState();
		assertTrue(StillOurs.pathTurned(dirt, path), "a path we wrote, turned to dirt under a solid block: ours");
		assertTrue(StillOurs.pathTurned(Blocks.GRASS_BLOCK.defaultBlockState(), path), "and grass spread onto that dirt: ours");
		assertTrue(WorldJournal.same(WorldJournal.value(dirt), WorldJournal.value(path)), "the journal's own comparison");
		assertTrue(WorldJournal.cuEquivalent(dirt, path), "a player's record (PT) there wins: a player who dug our path and placed dirt");
		// one way only, and nothing else
		assertFalse(StillOurs.pathTurned(path, dirt), "a path where we wrote dirt is a shovel's: not ours");
		assertFalse(StillOurs.pathTurned(Blocks.FARMLAND.defaultBlockState(), path), "a hoe's");
		assertFalse(StillOurs.pathTurned(Blocks.STONE.defaultBlockState(), path));
		assertFalse(StillOurs.pathTurned(Blocks.AIR.defaultBlockState(), path));
		assertFalse(WorldJournal.same(WorldJournal.value(path), WorldJournal.value(dirt)));
		assertFalse(WorldJournal.cuEquivalent(path, path), "the same block: as before");
		// the builder asks StillOurs.holds whether a path is built: dirt is still not a built path
		assertFalse(StillOurs.holds(dirt, null, path, null));
	}
}
