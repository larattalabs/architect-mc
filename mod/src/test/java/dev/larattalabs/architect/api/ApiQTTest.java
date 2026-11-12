package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Since NEXT (M5 QT): the feature quote (Java side), Regions.quote and quoteApproved defaults that throw, Quote copies its members. */
class ApiQTTest {
	private static Regions old() {
		return (Regions) java.lang.reflect.Proxy.newProxyInstance(Regions.class.getClassLoader(), new Class<?>[] {Regions.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
	}

	@Test
	void featureAndDefaults() throws Exception {
		assertTrue(ApiRules.features(1, List.of()).contains("quote"), "a Java feature: no helper needed");
		assertTrue(Regions.class.getMethod("quote", String.class, Map.class).isDefault(), "quote is a default (binary compatible)");
		assertTrue(Regions.class.getMethod("quoteApproved", String.class, Map.class).isDefault(), "quoteApproved is a default (binary compatible)");
		Regions r = old();
		assertThrows(UnsupportedOperationException.class, () -> r.quote("p1", Map.of()));
		assertThrows(UnsupportedOperationException.class, () -> r.quoteApproved("a".repeat(64), Map.of()));
	}

	@Test
	void quoteCopiesItsMembers() {
		Map<String, String> lots = new LinkedHashMap<>(Map.of("qa", "qt_hut"));
		List<String> notes = new ArrayList<>(List.of("n"));
		Quote q = new Quote("p1", null, "rg1", true, null, null, lots, true, notes);
		lots.put("qb", "rs_shed");
		notes.clear();
		assertEquals(Map.of("qa", "qt_hut"), q.lotEntries(), "its own copy of the entries");
		assertEquals(List.of("n"), q.notes(), "its own copy of the notes");
		assertTrue(q.bom().isEmpty() && q.bomParts().isEmpty(), "null bills read as empty");
		assertThrows(UnsupportedOperationException.class, () -> q.lotEntries().put("x", "y"));
		Quote empty = new Quote("p2", "s", null, false, new JsonObject(), new JsonObject(), null, true, null);
		assertTrue(empty.lotEntries().isEmpty() && empty.notes().isEmpty());
	}
}
