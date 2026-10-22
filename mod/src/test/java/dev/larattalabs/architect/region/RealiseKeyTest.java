package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * (6c close-out A, §1 and its §14 amendment; docs/CONTRACT.md "Phase 6c close-out A"): the realise key rule. A realise refused before its
 * region record (ARTIFACT_STALE among them) binds nothing, so the stale retry under the same key realises the re-checked artifact; a
 * standing region holds its key (the same body adopts, another conflicts); a REMOVED region frees it (as since C20), so the same key
 * realises afresh after an undo.
 */
class RealiseKeyTest {
	private static final String A = "hash-of-artifact-A", B = "hash-of-artifact-B";

	@Test
	void aStaleRetryUnderTheSameKeyRealisesTheRecheckedArtifact() {
		// realiseApproved(A, k) refused ARTIFACT_STALE: no region record, nothing starting under k
		assertEquals(RegionsImpl.KeyOutcome.NEW, outcome(null, null, B));
	}

	@Test
	void aStandingRegionHoldsItsKey() {
		assertEquals(RegionsImpl.KeyOutcome.ADOPT_REGION, outcome(B, null, B));
		assertEquals(RegionsImpl.KeyOutcome.CONFLICT, outcome(B, null, A));
		assertEquals(RegionsImpl.KeyOutcome.ADOPT_STARTING, outcome(null, B, B));
		assertEquals(RegionsImpl.KeyOutcome.CONFLICT, outcome(null, B, A));
	}

	@Test
	void anUndoFreesTheKey() {
		// the region realised under k was removed: regionByKey no longer finds it (REMOVED is a tombstone, not a standing region)
		assertEquals(RegionsImpl.KeyOutcome.NEW, outcome(null, null, A));
		assertEquals(RegionsImpl.KeyOutcome.NEW, outcome(null, null, B));
	}

	private static RegionsImpl.KeyOutcome outcome(String standing, String starting, String hash) {
		return RegionsImpl.keyOutcome(standing, starting, hash);
	}
}
