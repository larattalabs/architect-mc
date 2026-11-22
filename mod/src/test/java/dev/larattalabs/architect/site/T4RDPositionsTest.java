package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D, D3; T4R-N's P2) Positions in the recording contract. A player's drop is booked only with its position, block, items and
 * (when known) recipient: rows T4RD-crop (a player-planted field crop's seed recorded at its cell, so a recovered removal owes it) and
 * T4RD-lint (a positionless PLAYER_DROP throws; the item map of the player's cells equals the player's blocks).
 */
class T4RDPositionsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void aPlayersFieldCropIsRecordedAtItsCell() {
		System.out.println("ROW T4RD-crop (unit)");
		FieldCells f = FieldCells.of(FieldCellsTest.ext());
		long crop = Journal.pos(10, 65, 5);
		Refunds.Tally t = new Refunds.Tally();
		assertTrue(Builder.fieldCell(f, crop, Blocks.WHEAT.defaultBlockState().setValue(CropBlock.AGE, 7), true, t));
		System.out.println("ROW T4RD-crop: playerBlocks=" + t.playerBlocks() + " playerCells=" + t.playerCells());
		assertEquals(1, t.playerCells().size(), "T4RD-crop: the player's field crop has no recorded cell (its seed is lost by a recovered removal)");
		Refunds.Cell c = t.playerCells().get(0);
		assertEquals(crop, c.pos(), "T4RD-crop: at its cell");
		assertEquals("minecraft:wheat", c.block(), "T4RD-crop: the crop's block id (what stands)");
		assertEquals(Map.of("minecraft:wheat_seeds", 1), c.items(), "T4RD-crop: its planting item");
	}

	@Test
	void aPositionlessPlayerDropThrows() {
		System.out.println("ROW T4RD-lint (unit)");
		Refunds.Tally t = new Refunds.Tally();
		Throwable th = null;
		try {
			t.add(Refunds.Outcome.PLAYER_DROP, List.of(new SurvivalItems.Cost("minecraft:sponge", 1)));
		} catch (RuntimeException e) {
			th = e;
		}
		System.out.println("ROW T4RD-lint: positionless PLAYER_DROP -> " + (th == null ? "accepted, playerBlocks=" + t.playerBlocks() : th.toString()));
		assertTrue(th != null, "T4RD-lint: a positionless PLAYER_DROP was accepted (booked in playerBlocks with no cell)");
	}

	@Test
	void thePlayersCellsSumToThePlayersBlocks() {
		System.out.println("ROW T4RD-lint-maps (unit)");
		Refunds.Tally t = new Refunds.Tally();
		Builder.fieldCell(FieldCells.of(FieldCellsTest.ext()), Journal.pos(10, 65, 5), Blocks.WHEAT.defaultBlockState(), true, t);
		Builder.fieldCell(FieldCells.of(FieldCellsTest.ext()), Journal.pos(11, 65, 5), Blocks.CARROTS.defaultBlockState(), true, t);
		Map<String, Integer> sum = new TreeMap<>();
		t.playerCells().forEach(c -> c.items().forEach((k, v) -> sum.merge(k, v, Integer::sum)));
		System.out.println("ROW T4RD-lint-maps: cells " + sum + " blocks " + t.playerBlocks());
		assertEquals(t.playerBlocks(), sum, "T4RD-lint: the item map of the player's cells equals the player's blocks");
	}
}
