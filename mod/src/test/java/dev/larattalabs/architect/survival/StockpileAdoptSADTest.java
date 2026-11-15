package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * (SAD) adoptCrates' repair after a crash between its two saves (SAC2): the crate's adoption key survives the save, so the next
 * adoptCrates sees it credited ({@link StockLedger#credited}) and credits nothing twice; a BUILT target's keyed record round-trips.
 */
class StockpileAdoptSADTest {
	static final String COBBLE = "minecraft:cobblestone";
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;

	@Test
	void anAdoptedCrateIsCreditedOnceAcrossASave() {
		StockLedger l = new StockLedger();
		Map<String, Map<String, Integer>> by = new LinkedHashMap<>();
		by.put("site:s3@1", Map.of(COBBLE, 6)); // the BUILT lot
		by.put("site:s4@2", Map.of(COBBLE, 2)); // the building one
		String key = "adopt:group:g2@42";
		assertFalse(l.credited(key));
		l.adopt(key, Map.of(COBBLE, 12), Map.of(COBBLE, 8), by, CAP, MAX);
		assertTrue(l.credited(key));
		StockLedger back = StockLedger.fromJson(l.toJson(), 0L);
		assertTrue(back.credited(key), "the key is saved with the ledger: a repair after SAC2 sees it");
		String before = back.toJson().toString();
		assertTrue(back.adopt(key, Map.of(COBBLE, 12), Map.of(COBBLE, 8), by, CAP, MAX).isEmpty());
		assertEquals(before, back.toJson().toString(), "a second adoption of the same crate changes nothing");
		assertEquals(Map.of(COBBLE, 6), back.toJson().getAsJsonObject("paid").getAsJsonObject("site:s3@1").entrySet().stream()
			.collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, e -> e.getValue().getAsInt())));
	}
}
