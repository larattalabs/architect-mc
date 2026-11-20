package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R, row T4R-cargo-data, unit part; N6, R5) A player-placed holder's contents with a stack carrying its own data no longer refuse
 * the removal: the plain stacks are credited by id, the data-bearing one becomes an O {@code cargo} entry (kept whole, never credited by id).
 */
class T4RCargoDataTest {
	@Test
	void aDataStackNoLongerRefuses() {
		System.out.println("ROW T4R-cargo-data (unit)");
		Map<String, Integer> byId = Groups.cargoOf(List.of(new Groups.Stack("minecraft:stone", 5, false), new Groups.Stack("minecraft:diamond_sword", 1, true)));
		assertNotNull(byId, "T4R-cargo-data: a data stack must not refuse the removal (null = refused)");
		assertEquals(5, byId.getOrDefault("minecraft:stone", 0), "T4R-cargo-data: the plain stack credited by id");
		assertFalse(byId.containsKey("minecraft:diamond_sword"), "T4R-cargo-data: the data stack is never credited by id (it is owed whole)");
	}
}
