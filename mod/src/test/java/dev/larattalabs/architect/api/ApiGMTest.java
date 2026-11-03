package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Since NEXT (7a GM-a; docs/CONTRACT.md "Slice GM" §5): the feature gateMechanisms (sidecar region.walls.mechanisms); no new records. */
class ApiGMTest {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.walls.mechanisms")).contains("gateMechanisms"));
		assertFalse(ApiRules.features(2, List.of("region.walls.lots")).contains("gateMechanisms"), "a K3 helper has no gate mechanisms");
		assertFalse(ApiRules.features(1, List.of("region.walls.mechanisms")).contains("gateMechanisms"), "protocol 1 has no helper features");
	}
}
