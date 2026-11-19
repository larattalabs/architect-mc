package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import org.junit.jupiter.api.Test;

/** (slice T4b fix round, N3) A W receipt's found amounts survive their encoding (replay reads them, never the world again). */
class RemovalFoundT4bTest {
	@Test
	void foundAmountsRoundTrip() {
		Map<String, Integer> m = Map.of("minecraft:cobblestone", 7, "minecraft:oak_planks", 2);
		assertEquals(m, RemovalTxn.decode(RemovalTxn.encode(m)));
		assertEquals(Map.of(), RemovalTxn.decode(RemovalTxn.encode(Map.of())));
	}
}
