package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.txn.Probe;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * (slice T3b fix round) The pure seams of two GPT findings. P1: the start's repair clears a reference only to a credited crate that no longer
 * stands (a standing one is legacy FINISH, held for ops); before, every credited reference was cleared. P2-3: a journal release whose commit
 * is still pending probes UNKNOWN (before, the optimistic head read it as released). The in-game rows are txn-crash-adopt's
 * legacy-finish-at-start, gone-save-refused and the matrix's stockpile_changed check.
 */
class PileAdoptFixT3bTest {
	@Test
	void theStartRepairsOnlyACreditedCrateThatIsGone() {
		assertTrue(Stockpiles.startRepairs(true, false), "JOINED: credited, gone: references cleared");
		assertFalse(Stockpiles.startRepairs(true, true), "FINISH: credited, still standing: kept (held for ops), never freed");
		assertFalse(Stockpiles.startRepairs(false, false));
		assertFalse(Stockpiles.startRepairs(false, true));
	}

	@Test
	void aPendingReleaseIsNeverReadAsDone() {
		CompletableFuture<Void> pending = new CompletableFuture<>();
		assertEquals(Probe.UNKNOWN, PileAdopt.releaseProbe(pending, true), "the head shows it released; its commit is not durable yet");
		CompletableFuture<Void> failed = CompletableFuture.failedFuture(new java.io.IOException("disk"));
		assertEquals(Probe.ABSENT, PileAdopt.releaseProbe(failed, true), "a failed commit: released again");
		assertEquals(Probe.APPLIED, PileAdopt.releaseProbe(CompletableFuture.completedFuture(null), true));
		assertEquals(Probe.APPLIED, PileAdopt.releaseProbe(null, true), "after a restart the head is the durable index");
		assertEquals(Probe.ABSENT, PileAdopt.releaseProbe(null, false));
	}
}
