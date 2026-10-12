package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** C26 (docs/CONTRACT.md phase 6c slice Y, gate item 1): the full bill's exclusions and drift sources, over plain maps. */
class FullBomTest {
	private static final int[] NONE = new int[0];

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static BlockState air() {
		return Blocks.AIR.defaultBlockState();
	}

	private static FullBom.Inputs inputs(int[] xyz, BlockState[] states, int[] fill, int[] clear, int[] aClear, int[] aFill, int[] aPath, int[] aSlabs) {
		return new FullBom.Inputs(xyz, states, (p, s) -> false, fill, clear, aClear, aFill, aPath, aSlabs, Blocks.STONE_BRICKS.defaultBlockState(),
			Blocks.COBBLESTONE.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState(), Blocks.OAK_SLAB.defaultBlockState());
	}

	@Test
	void templateFoundationAndApproachAddUp() {
		int[] xyz = {0, 10, 0, 1, 10, 0, 2, 10, 0};
		BlockState[] st = {Blocks.OAK_PLANKS.defaultBlockState(), air(), Blocks.OAK_PLANKS.defaultBlockState()};
		FullBom.Result r = FullBom.compute(inputs(xyz, st, new int[] {0, 9, 0, 1, 9, 0}, NONE, NONE, new int[] {5, 9, 0}, new int[] {5, 10, 0},
			new int[] {6, 10, 0}), p -> air());
		assertEquals(Map.of("minecraft:oak_planks", 2, "minecraft:stone_bricks", 2, "minecraft:cobblestone", 1, "minecraft:dirt", 1, "minecraft:oak_slab", 1),
			r.items());
		assertTrue(r.exact(), r.driftCells().toString());
		assertEquals(7, r.cells());
	}

	@Test
	void aCutCellAndAClearedCellAreFree() {
		// the template writes a plank at 0; the terrain cut and the approach cut both clear cells that were also filled/written
		int[] xyz = {0, 10, 0, 1, 10, 0};
		BlockState[] st = {Blocks.OAK_PLANKS.defaultBlockState(), Blocks.OAK_PLANKS.defaultBlockState()};
		FullBom.Result r = FullBom.compute(inputs(xyz, st, NONE, new int[] {0, 10, 0}, new int[] {1, 10, 0}, NONE, NONE, NONE), p -> air());
		assertTrue(r.items().isEmpty(), r.items().toString());
		assertEquals(0, r.cells());
	}

	@Test
	void theLastWriteWins() {
		// the approach's path overwrites the foundation fill at the same cell: one dirt path (a dirt), not a stone brick as well
		FullBom.Result r = FullBom.compute(inputs(NONE, new BlockState[0], new int[] {4, 9, 4}, NONE, NONE, NONE, new int[] {4, 9, 4}, NONE), p -> air());
		assertEquals(Map.of("minecraft:dirt", 1), r.items());
	}

	@Test
	void anUnsafeBedIsLeftOut() {
		// the predicate is asked only for bed blocks, so an air cell is never a bed: this checks the plumbing, the bed rule itself is the level's
		FullBom.Inputs in = new FullBom.Inputs(new int[] {0, 10, 0}, new BlockState[] {air()}, (p, s) -> true, NONE, NONE, NONE, NONE, NONE, NONE,
			Blocks.STONE.defaultBlockState(), Blocks.STONE.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState(), Blocks.OAK_SLAB.defaultBlockState());
		assertTrue(FullBom.compute(in, p -> air()).items().isEmpty());
	}

	@Test
	void aGravityBlockOverAFreeCellIsADriftSource() {
		int[] xyz = {0, 10, 0};
		BlockState[] st = {Blocks.GRAVEL.defaultBlockState()};
		Map<Long, BlockState> world = new HashMap<>();
		FullBom.Result over = FullBom.compute(inputs(xyz, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> world.getOrDefault(p, air()));
		assertFalse(over.exact());
		assertEquals(1, over.driftCells().size());
		assertTrue(over.driftCells().get(0).startsWith("0,10,0 minecraft:gravel"), over.driftCells().toString());
		assertEquals(Map.of("minecraft:gravel", 1), over.items(), "the bill is the plan's count; the note says it may differ");
		world.put(BlockPos.asLong(0, 9, 0), Blocks.STONE.defaultBlockState());
		assertTrue(FullBom.compute(inputs(xyz, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> world.getOrDefault(p, air())).exact(), "supported by the world");
		// supported by a cell the plan itself writes
		BlockState[] two = {Blocks.GRAVEL.defaultBlockState(), Blocks.STONE.defaultBlockState()};
		assertTrue(FullBom.compute(inputs(new int[] {0, 10, 0, 0, 9, 0}, two, NONE, NONE, NONE, NONE, NONE, NONE), p -> air()).exact());
	}

	@Test
	void anUnknownNeighbourMakesTheBillInexact() {
		BlockState[] st = {Blocks.SAND.defaultBlockState()};
		assertFalse(FullBom.compute(inputs(new int[] {0, 10, 0}, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> null).exact());
	}

	@Test
	void aDirtPathUnderASolidBlockCostsTheSameDirtSoIsNotADrift() {
		// dirt_path costs a dirt and so does the dirt it turns to: the settle changes nothing the bill counts
		BlockState[] st = {Blocks.DIRT_PATH.defaultBlockState(), Blocks.STONE.defaultBlockState()};
		FullBom.Result r = FullBom.compute(inputs(new int[] {0, 9, 0, 0, 10, 0}, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> air());
		assertTrue(r.exact(), r.driftCells().toString());
		assertEquals(Map.of("minecraft:dirt", 1, "minecraft:stone", 1), r.items());
	}

	private static BlockState door(String half) {
		return Blocks.SPRUCE_DOOR.defaultBlockState().setValue(net.minecraft.world.level.block.DoorBlock.HALF,
			net.minecraft.world.level.block.state.properties.DoubleBlockHalf.valueOf(half));
	}

	@Test
	void aDoorWhoseFloorTheApproachLaterReplacesPopsWithItsUpperHalf() {
		// a door on a stone floor; the approach then writes a dirt path (not a sturdy face) under it: updateShape returns air for both halves
		int[] xyz = {0, 10, 0, 0, 11, 0, 0, 12, 0};
		BlockState[] st = {Blocks.STONE.defaultBlockState(), door("LOWER"), door("UPPER")};
		FullBom.Result popped = FullBom.compute(inputs(xyz, st, NONE, NONE, NONE, NONE, new int[] {0, 10, 0}, NONE), p -> air());
		assertEquals(Map.of("minecraft:dirt", 1), popped.items(), popped.items().toString());
		assertTrue(popped.exact());
		FullBom.Result stays = FullBom.compute(inputs(xyz, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> air());
		assertEquals(Map.of("minecraft:stone", 1, "minecraft:spruce_door", 1), stays.items(), stays.items().toString());
	}

	@Test
	void aDoorWrittenAfterItsFloorWasChangedIsNotRechecked() {
		// the path is written under the cell first (fill phase), the door comes with the template: nothing later touches it
		int[] xyz = {0, 11, 0, 0, 12, 0};
		BlockState[] st = {door("LOWER"), door("UPPER")};
		FullBom.Result r = FullBom.compute(inputs(xyz, st, NONE, NONE, NONE, NONE, NONE, NONE), p -> p == net.minecraft.core.BlockPos.asLong(0, 10, 0)
			? Blocks.DIRT_PATH.defaultBlockState() : air());
		assertEquals(Map.of("minecraft:spruce_door", 1), r.items());
	}
}
