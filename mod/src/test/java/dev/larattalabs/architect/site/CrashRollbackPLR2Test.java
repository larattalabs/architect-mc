package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (slice PLR2) PLR's final review left three P1s in the crash rollback of a road's or cell site's placement:
 * <ol>
 * <li>a rollback that broke before its box was restored still released its item's hold and queued it again (placed over cells that were
 * not restored);</li>
 * <li>an ACTIVE extra target was released (async) with its record dropped (at once): a second crash before the release reached the journal
 * left an ACTIVE entry with no record, rebuilt from the journal at the next start as an untracked target;</li>
 * <li>the rollback of a survival region tile's free pass that took up another writer's paid block (XR: its items given back, unkeyed) wrote
 * the block back while the items stayed given back.</li>
 * </ol>
 * The decisions are pure seams; the in-game rows are tools/gate6crp.mjs crash (RG4 broken) and xcrash.
 */
class CrashRollbackPLR2Test {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	private static final QItem.Status PLACING = QItem.Status.PLACING;
	private static final String BROKE = "its undo could not be saved to the world journal";

	// ------------------------------------------------------------------ 1. a broken rollback fails its item

	@Test
	void aBrokenCrashRollbackFailsItsItemInsteadOfQueueingItAgain() {
		assertEquals(Placement.RollbackEnd.FAIL, Placement.rollbackEnd(PLACING, "c1", "c1", false, BROKE, false, true, true),
			"broken before its box was restored: the item fails (its cells stay recorded under c1), never placed over them");
		assertEquals(Placement.RollbackEnd.FAIL, Placement.rollbackEnd(QItem.Status.QUEUED, null, "c1", false, BROKE, false, true, true),
			"an item already queued again (the last save's) fails too: it would read cells the rollback never restored");
		// unchanged: a rollback that restored its box queues the item again
		assertEquals(Placement.RollbackEnd.REQUEUE, Placement.rollbackEnd(PLACING, "c1", "c1", false, null, false, true, true));
	}

	@Test
	void aBrokenRollbackFailsTheItemEvenWhileAnotherRollbackOfTheAttemptIsQueued() {
		// the main ends broken first, its extra target still restoring: the hold is not handed on (it would be released when the extra ends)
		assertEquals(Placement.RollbackEnd.FAIL, Placement.rollbackEnd(PLACING, "c1", "c1", false, BROKE, true, true, true));
		// an extra target (c2) ends broken first while the item is held as the main's (c1, a rollback, not a live placement): it fails now
		assertEquals(Placement.RollbackEnd.FAIL, Placement.rollbackEnd(PLACING, "c1", "c2", false, BROKE, true, true, true),
			"a sibling rollback's break is not lost");
		// then the main ends clean: the item is done, left as it is (not queued again)
		assertEquals(Placement.RollbackEnd.LEAVE, Placement.rollbackEnd(QItem.Status.FAILED, "c1", "c1", false, null, false, true, true));
		// unchanged: a clean end with another rollback queued waits for it
		assertEquals(Placement.RollbackEnd.WAIT, Placement.rollbackEnd(PLACING, "c1", "c1", false, null, true, true, true));
	}

	@Test
	void aBrokenStrayRollbackLeavesAnItemPlacedOrPlacingAgainAsAnotherSite() {
		// (PLR's evidence) c46's rollback broke after its item was placed again as c49: c49's, left as it is
		assertEquals(Placement.RollbackEnd.LEAVE, Placement.rollbackEnd(QItem.Status.PLACED, "c49", "c46", false, BROKE, false, true, true));
		assertEquals(Placement.RollbackEnd.LEAVE, Placement.rollbackEnd(PLACING, "c49", "c46", true, BROKE, false, true, true),
			"placing again as c49 (its job runs): c49's attempt, not this rollback's");
	}

	// ------------------------------------------------------------------ 2. ACTIVE extra targets roll back through a tracked job

	@Test
	void anActiveExtraTargetRollsBackThroughItsOwnJob() {
		assertTrue(Placement.extraRollsBack(Journal.Status.ACTIVE, true),
			"ACTIVE (P7 durable): a tracked RestoreJob, the record kept until R3 (never dropped beside an ACTIVE entry)");
		assertFalse(Placement.extraRollsBack(Journal.Status.PLACING, true), "PLACING: released (the start's K2 settle releases it again after a crash)");
		assertFalse(Placement.extraRollsBack(null, true), "no entry: wrote nothing, the record goes");
		assertFalse(Placement.extraRollsBack(Journal.Status.ACTIVE, false), "no record to roll back with");
	}

	// ------------------------------------------------------------------ 3. a free pass over another writer's paid cell is refused

	private static final BlockPos P = new BlockPos(3, 64, 5);
	private static final BlockPos Q = new BlockPos(9, 64, 9);

	@Test
	void theCrashRollbackOfAFreePassOverAPaidCellIsRefused() {
		RegionOverwrites.Live paid = RegionOverwritesTest.writer("t1", 1, Blocks.BRICKS.defaultBlockState(), true);
		RegionOverwrites.Live free = RegionOverwritesTest.writer("t2", 2, Blocks.BRICKS.defaultBlockState(), false);
		String no = RegionOverwrites.crashRollbackRefusal("c9", true, true, "rg1", new long[] {Q.asLong(), P.asLong()}, List.of(paid), List.of());
		assertNotNull(no, "c9's free pass writes t1's paid cell: its items may have been given back");
		assertTrue(no.contains("c9") && no.contains("t1") && no.contains("rg1"), no);
		assertNotNull(RegionOverwrites.crashRollbackRefusal("c9", true, null, "rg1", new long[] {P.asLong()}, List.of(paid), List.of()),
			"the region not known yet: refused (a guard never misses one)");
		assertNotNull(RegionOverwrites.crashRollbackRefusal("c9", true, true, "rg1", new long[] {P.asLong()}, List.of(),
			List.of(new Anchors.Bounds(0, 60, 0, 5, 70, 5))), "a writer whose run can't be read: its box counts");
	}

	@Test
	void theCrashRollbackIsLeftAloneWhereNothingPaidCouldHaveBeenTakenUp() {
		RegionOverwrites.Live paid = RegionOverwritesTest.writer("t1", 1, Blocks.BRICKS.defaultBlockState(), true);
		RegionOverwrites.Live free = RegionOverwritesTest.writer("t2", 2, Blocks.BRICKS.defaultBlockState(), false);
		assertNull(RegionOverwrites.crashRollbackRefusal("c9", true, true, "rg1", new long[] {Q.asLong()}, List.of(paid), List.of()), "no paid cell written");
		assertNull(RegionOverwrites.crashRollbackRefusal("c9", true, true, "rg1", new long[] {P.asLong()}, List.of(free), List.of()), "a held (free) cell");
		assertNull(RegionOverwrites.crashRollbackRefusal("c9", true, false, "rg1", new long[] {P.asLong()}, List.of(paid), List.of()),
			"not a survival region: nothing is ever given back");
		assertNull(RegionOverwrites.crashRollbackRefusal("c9", false, true, "rg1", new long[] {P.asLong()}, List.of(paid), List.of()),
			"a target (Steward's c46: written by the builder, fed) never took up a block at its put-down");
		assertNull(RegionOverwrites.crashRollbackRefusal("c9", true, true, "rg1", new long[] {P.asLong()}, List.of(), List.of(new Anchors.Bounds(6, 60, 6, 9, 70, 9))));
	}
}
