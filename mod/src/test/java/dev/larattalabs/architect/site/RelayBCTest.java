package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (BC, S-M5-10) A soil cell Architect wrote that vanilla turned into another soil block (farmland dried, grass spread over it, a path under
 * a block) is still the cell it paid for: built, never re-laid or paid again, refunded what it was paid. Durable across a restart through the
 * ledger book's standing bits ({@link Builder.Run#paidBefore}).
 */
class RelayBCTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static int farmlandCell(Builder.Run r) {
		for (int q = 0; q < r.size(); q++) {
			if (r.target[q].is(Blocks.FARMLAND)) {
				return q;
			}
		}
		throw new AssertionError("no farmland cell");
	}

	@Test
	void aWrittenSoilCellVanillaChangedStaysBuilt() {
		LedgerSim s = new LedgerSim();
		Builder.Run r = s.place("farm", "farm").run;
		int q = farmlandCell(r);
		r.tilled.clear(); // a farm over the ground's own dirt (the sim's is over air)
		// not written yet: the ground's soil there is not ours (it is still to be written)
		assertFalse(r.matches(Blocks.DIRT.defaultBlockState(), q));
		assertFalse(r.matches(Blocks.GRASS_BLOCK.defaultBlockState(), q));
		r.markBuilt(q, true);
		for (var now : new net.minecraft.world.level.block.state.BlockState[] {Blocks.DIRT.defaultBlockState(), Blocks.GRASS_BLOCK.defaultBlockState(),
			Blocks.DIRT_PATH.defaultBlockState(), Blocks.FARMLAND.defaultBlockState(), Blocks.PODZOL.defaultBlockState()}) {
			assertTrue(r.matches(now, q), "built farmland reads " + now + " as ours");
			assertEquals(r.cost.get(q), r.refundCost(now, q), "refunds what was paid over " + now);
		}
		// anything else is not ours (mined to air, replaced by stone)
		assertFalse(r.matches(Blocks.AIR.defaultBlockState(), q));
		assertFalse(r.matches(Blocks.STONE.defaultBlockState(), q));
	}

	@Test
	void theBookKeepsItAcrossARestart() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt f = s.place("farm", "farm");
		Builder.Run fresh = s.runOf(f); // a run made after a restart: no built bits
		int q = farmlandCell(fresh);
		fresh.tilled.clear(); // a farm over the ground's own dirt: the befores can't tell
		assertFalse(fresh.matches(Blocks.DIRT.defaultBlockState(), q), "without the book a dried cell over dirt reads unbuilt");
		fresh.paidBefore.set(q); // the book: it stood paid at the last save
		assertTrue(fresh.matches(Blocks.DIRT.defaultBlockState(), q));
		assertTrue(fresh.matches(Blocks.GRASS_BLOCK.defaultBlockState(), q));
		assertFalse(fresh.matches(Blocks.AIR.defaultBlockState(), q), "mined since: not built, the builder places and pays it again");
	}
}
