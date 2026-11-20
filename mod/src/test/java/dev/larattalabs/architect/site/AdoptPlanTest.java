package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.site.AdoptPlan.CrateRead;
import dev.larattalabs.architect.site.AdoptPlan.Defer;
import dev.larattalabs.architect.site.AdoptPlan.Fate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** (slice T3a) The adoption classifier and planning rules (T3 design §1 R-1, §4; Noah's decisions 1, 3, 4, 6). */
class AdoptPlanTest {
	static CrateRead read(String key, int x, boolean crate, boolean be, String beOwner, boolean readable) {
		return new CrateRead(key, "minecraft:overworld", x, 64, 0, 1000L + x, crate, be, beOwner, readable);
	}

	static CrateRead ok(String key, int x) {
		return read(key, x, true, true, key, true);
	}

	@Test
	void aCrateThatReadsAsItsOwnersJoins() {
		assertEquals(Fate.JOIN, AdoptPlan.classify(ok("group:g1", 5), false).fate());
	}

	@Test
	void everyDeferReasonHasItsStableWireValue() {
		// (T3b, DFG's fix round) "not a crate" is a cell not read; a read cell with no crate is GONE (nothing to take: its targets are freed)
		assertEquals(Defer.NOT_A_CRATE, AdoptPlan.classify(new CrateRead("s1", "minecraft:overworld", 1, 64, 0, 1001L, false, false, null, false, false), false)
			.why());
		assertEquals(Fate.GONE, AdoptPlan.classify(read("s1", 1, false, false, null, false), false).fate());
		assertEquals(Fate.DEFER, AdoptPlan.classify(new CrateRead("s1", "minecraft:overworld", 1, 64, 0, 1001L, false, false, null, false, false), true)
			.fate(), "credited, the cell not read: deferred (DFG), never JOINED");
		assertEquals(Defer.UNREADABLE, AdoptPlan.classify(read("s1", 1, true, false, null, false), false).why());
		assertEquals(Defer.UNREADABLE, AdoptPlan.classify(read("s1", 1, true, true, "s1", false), false).why());
		assertEquals(Defer.UNREADABLE, AdoptPlan.classify(read("s1", 1, true, true, null, true), false).why());
		assertEquals(Defer.RETAGGED, AdoptPlan.classify(read("group:g1", 1, true, true, "adp:other", true), false).why());
		assertEquals(List.of("unreadable", "retagged", "not a crate", "chunks unloaded"), java.util.Arrays.stream(Defer.values()).map(d -> d.wire).toList());
	}

	@Test
	void aCreditedKeyIsLegacyNeverJoinedAgain() {
		// FINISH: an A-model crate still stands (held for ops, decision 3); JOINED: the crate is gone (the start's repair)
		assertEquals(Fate.FINISH, AdoptPlan.classify(ok("s1", 1), true).fate());
		assertEquals(Fate.FINISH, AdoptPlan.classify(read("s1", 1, true, true, "adp:other", true), true).fate());
		assertEquals(Fate.JOINED, AdoptPlan.classify(read("s1", 1, false, false, null, false), true).fate());
	}

	@Test
	void theAdoptKeyAndTheCrateResourceAreTheLedgersAndTheHoldsNames() {
		CrateRead r = new CrateRead("group:g1", "minecraft:overworld", -3, 70, 12, 42L, true, true, "group:g1", true);
		assertEquals("adopt:group:g1@42", r.adoptKey());
		assertEquals("crate:minecraft:overworld@-3,70,12", r.resource());
		assertTrue(dev.larattalabs.architect.txn.Holds.cell(r.resource()) != null, "the crate resource names a held cell (T2a's Holds.cell)");
	}

	// ------------------------------------------------------------------ the road chunk rule (decision 4)

	@Test
	void exactlyTheBoundLoadsAndOneMoreDefersTheWholeCrate() {
		Map<String, List<Long>> needs = new LinkedHashMap<>();
		needs.put("road:r1", List.of(1L, 2L, 3L));
		AdoptPlan.Chunks at = AdoptPlan.chunks(needs, c -> false, 3);
		assertEquals(List.of(1L, 2L, 3L), at.load());
		assertTrue(at.deferred().isEmpty());
		AdoptPlan.Chunks over = AdoptPlan.chunks(needs, c -> false, 2);
		assertEquals(List.of(), over.load(), "never a partial rescan: nothing of a deferred crate loads");
		assertEquals(Set.of("road:r1"), over.deferred());
	}

	@Test
	void loadedChunksChargeNothingAndASharedChunkIsChargedOnce() {
		Map<String, List<Long>> needs = new LinkedHashMap<>();
		needs.put("a", List.of(1L, 2L, 9L));
		needs.put("b", List.of(2L, 3L));
		AdoptPlan.Chunks c = AdoptPlan.chunks(needs, x -> x == 9L, 3);
		assertEquals(List.of(1L, 2L, 3L), c.load());
		assertTrue(c.deferred().isEmpty());
	}

	@Test
	void aDeferredCrateChargesNothingSoALaterSmallerOneStillFits() {
		Map<String, List<Long>> needs = new LinkedHashMap<>();
		needs.put("big", List.of(1L, 2L, 3L, 4L));
		needs.put("small", List.of(7L));
		needs.put("none", List.of());
		AdoptPlan.Chunks c = AdoptPlan.chunks(needs, x -> false, 2);
		assertEquals(Set.of("big"), c.deferred());
		assertEquals(List.of(7L), c.load());
	}

	@Test
	void aBoundOfZeroDefersEveryCrateWithAnUnloadedChunkOnly() {
		Map<String, List<Long>> needs = new LinkedHashMap<>();
		needs.put("far", List.of(5L));
		needs.put("near", List.of(6L));
		AdoptPlan.Chunks c = AdoptPlan.chunks(needs, x -> x == 6L, 0);
		assertEquals(Set.of("far"), c.deferred());
		assertEquals(List.of(), c.load());
	}

	// ------------------------------------------------------------------ the plan (decision 6: one txn per call)

	@Test
	void aDeferredCrateIsInNeitherThePlanNorTheResourcesAndItsRecordsAreUntouched() {
		List<CrateRead> reads = List.of(ok("group:g1", 1), read("s4", 2, true, true, "adp:other", true), ok("road:r1", 3), ok("group:g1", 1));
		Map<String, List<Long>> paid = Map.of("road:r1", List.of(10L, 11L, 12L), "group:g1", List.of(20L));
		Map<String, List<String>> records = Map.of("group:g1", List.of("group:g1", "site:s3", "site:s4"), "s4", List.of("site:s4"), "road:r1", List.of(
			"road:r1"));
		AdoptPlan.Plan p = AdoptPlan.plan("steward", reads, k -> false, paid, c -> false, 2, records);
		assertEquals(List.of("group:g1"), p.join().stream().map(CrateRead::key).toList(), "the shared crate once; the road past the bound");
		assertEquals(Map.of("s4", Defer.RETAGGED, "road:r1", Defer.CHUNKS_UNLOADED), p.deferred());
		assertEquals(List.of("pile:steward", "crate:minecraft:overworld@1,64,0", "group:g1", "site:s3", "site:s4"), p.resources());
		assertFalse(p.resources().contains("crate:minecraft:overworld@2,64,0"), "the retagged crate is not held");
		assertFalse(p.resources().contains("road:r1"), "the deferred road's record is not held");
		assertEquals(List.of(20L), p.load());
	}

	@Test
	void legacyKeysAreReportedApartAndHoldNothing() {
		List<CrateRead> reads = List.of(ok("s1", 1), read("s2", 2, false, false, null, false), ok("s3", 3));
		Set<String> credited = Set.of(AdoptPlan.adoptKey("s1", 1001L), AdoptPlan.adoptKey("s2", 1002L));
		AdoptPlan.Plan p = AdoptPlan.plan("o", reads, credited::contains, Map.of(), c -> true, 8, Map.of());
		assertEquals(List.of("s1"), p.finish());
		assertEquals(List.of("s2"), p.joined());
		assertEquals(List.of("s3"), p.join().stream().map(CrateRead::key).toList());
		assertEquals(List.of("pile:o", "crate:minecraft:overworld@3,64,0"), p.resources());
	}

	@Test
	void nothingToAdoptStillTakesOnlyThePile() {
		AdoptPlan.Plan p = AdoptPlan.plan("o", List.of(), k -> false, Map.of(), c -> true, 8, Map.of());
		assertTrue(p.join().isEmpty() && p.deferred().isEmpty());
		assertEquals(List.of("pile:o"), p.resources());
	}
}
