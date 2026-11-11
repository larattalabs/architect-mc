package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Since NEXT (6d LC): the feature landCheck (Java side), Regions.landCheck a default that throws, the records copy their lists. */
class ApiLCTest {
	@Test
	void landCheckFeatureAndDefault() {
		assertTrue(ApiRules.features(1, List.of()).contains("landCheck"), "a Java feature: no helper needed");
		Regions old = (Regions) java.lang.reflect.Proxy.newProxyInstance(Regions.class.getClassLoader(), new Class<?>[] {Regions.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		assertThrows(UnsupportedOperationException.class, () -> old.landCheck("r1", null));
		java.util.ArrayList<PartLand> parts = new java.util.ArrayList<>(List.of(new PartLand("square", 10, 1, 2, 3, 0, Map.of("minecraft:dirt", 1L), List.of())));
		LandReport r = new LandReport("r1", 0, parts, List.of(new LotLand("hall_1", "s1", "placed", 1.0, 0, 0)), 10, 0, 5);
		parts.clear();
		assertEquals(1, r.parts().size(), "the report keeps its own copy");
	}
}
