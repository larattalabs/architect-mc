package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * API 1.17.0 (docs/CONTRACT.md phase 6c slice Y1, C24): the stockpile methods are defaults that throw on an older implementation,
 * the records have the frozen shapes (Y2's SiteWait and ItemCount included), STOCKPILE_CHANGED is a new static field, and no
 * Reason is added.
 */
class ApiY1Test {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 17, ArchitectApi.VERSION);
	}

	@Test
	void featureAndLimit() {
		Set<String> f = ApiRules.features(1, List.of());
		assertTrue(f.contains("stockpile"), f.toString());

		assertEquals(16, Limits.STOCKPILE_CRATES);
	}

	@Test
	void newMethodsAreDefaultsThatThrow() throws Exception {
		// an implementation written before 1.17.0: only the default methods run
		Sites old = (Sites) java.lang.reflect.Proxy.newProxyInstance(Sites.class.getClassLoader(), new Class<?>[] {Sites.class}, (p, m, args) -> m.isDefault()
			? java.lang.reflect.InvocationHandler.invokeDefault(p, m, args) : null);
		for (Method m : Sites.class.getMethods()) {
			if (List.of("createStockpile", "addStockpileCrate", "removeStockpileCrate", "stockpile", "feedOrder", "setFeedOrder", "withdraw", "adoptCrates",
				"dissolveStockpile").contains(m.getName())) {
				assertTrue(m.isDefault() && !Modifier.isAbstract(m.getModifiers()), m.getName());
			}
		}
		UnsupportedOperationException e = assertThrows(UnsupportedOperationException.class, () -> old.stockpile("test:x"));
		assertTrue(e.getMessage().contains("1.17.0"), e.getMessage());
		assertThrows(UnsupportedOperationException.class, () -> old.feedOrder("test:x"));
		assertThrows(UnsupportedOperationException.class, () -> old.adoptCrates("test:x"));
		assertThrows(UnsupportedOperationException.class, () -> old.dissolveStockpile("test:x", null));
	}

	@Test
	void recordShapesAsFrozen() {
		assertEquals(List.of("owner", "dimension", "crates", "capacityStacks", "usedStacks", "stock", "reserved", "credit", "delivered", "consumed",
			"returned", "withdrawn", "dropped", "refundOverflow", "outstandingByTarget", "outstanding", "feedOrder", "waiting", "missingCrates"), names(
				Stockpile.class));
		assertEquals(List.of("owner", "dimension", "crates"), names(StockpileRequest.class));
		assertEquals(List.of("targetId", "waiting", "waitingSince", "nextNeeded", "moreUnits"), names(SiteWait.class));
		assertEquals(List.of("item", "count"), names(ItemCount.class));
	}

	@Test
	void stockpileChangedIsANewStaticField() throws Exception {
		var f = SiteEvents.class.getField("STOCKPILE_CHANGED");
		assertTrue(Modifier.isStatic(f.getModifiers()));
		Reason[] r = Reason.values();
		assertTrue(java.util.Arrays.stream(r).noneMatch(x -> x.name().contains("STOCKPILE")), "no new Reason");
	}

	static List<String> names(Class<?> c) {
		return java.util.Arrays.stream(c.getRecordComponents()).map(java.lang.reflect.RecordComponent::getName).toList();
	}
}
