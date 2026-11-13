package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.BitSet;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Slice RL: a construction run's owed cells. An owed cell is never built (a rescan or the builder's "already there" finds its block and
 * marks nothing), attaching owed bits unbuilds a cell a rescan marked built first, its cost stays in what the target still needs (the
 * feed asks the stock for it, the site waits for it), and once the bit is cleared (the feed paid it) the cell builds as any.
 */
class RunOwedRLTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static Builder.Run run() {
		Anchors.Bounds box = new Anchors.Bounds(0, 64, 0, 0, 66, 0);
		Map<Long, Journal.Value> values = new HashMap<>();
		for (int y = 64; y <= 66; y++) {
			values.put(new BlockPos(0, y, 0).asLong(), WorldJournal.value(Blocks.COBBLESTONE.defaultBlockState()));
		}
		Cells c = Cells.fromValues(box, values);
		int[] q = {Construction.index(0, 0, 0, 1, 1), Construction.index(0, 1, 0, 1, 1), Construction.index(0, 2, 0, 1, 1)};
		Site probe = new Site("rl", "probe", "none", box, box, Map.of(), 0L, Site.OVERWORLD, box, "none", null, null,
			new Construction(Construction.BUILDING, q, Builder.JOURNAL_TARGET, null, new BitSet(), false, null));
		return new Builder.Run(probe, c);
	}

	@Test
	void anOwedCellIsBuiltOnlyOncePaid() {
		Builder.Run r = run();
		assertEquals(3, r.unbuiltCost("minecraft:cobblestone"));
		r.markBuilt(0, true);
		r.markBuilt(1, true); // a rescan before the feed attached the owed bits
		assertEquals(1, r.unbuiltCost("minecraft:cobblestone"));
		BitSet owed = new BitSet();
		owed.set(1);
		r.attachOwed(owed);
		assertFalse(r.built.get(1), "attaching unbuilds an owed cell");
		assertTrue(r.built.get(0));
		assertEquals(2, r.unbuiltCost("minecraft:cobblestone"), "the owed cell's cost is still needed");
		r.markBuilt(1, true); // a rescan or the builder's "already there" finds its block
		assertFalse(r.built.get(1), "an owed cell is never built for free");
		owed.clear(1); // the feed paid it
		r.markBuilt(1, true);
		assertTrue(r.built.get(1));
		assertEquals(1, r.unbuiltCost("minecraft:cobblestone"));
		assertTrue(r.seen.get(0) && r.seen.get(1) && !r.seen.get(2), "seen: the cells whose state the run has read");
	}
}
