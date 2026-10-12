package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * API 1.20.0 placeholder (docs/CONTRACT.md phase 6c slice SCH §1): the new Library and Sites methods are defaults that throw
 * "needs Architect API 1.20.0", {@link Reason#FORMAT} is appended last, and {@code schematics} is always a feature.
 */
class ApiSchTest {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 20, ArchitectApi.VERSION); // a placeholder; the coordinator sets it
	}

	@Test
	void formatIsAppended() {
		Reason[] r = Reason.values();
		assertEquals(Reason.FORMAT, r[r.length - 1]);
		assertEquals(Reason.FIELD_LIMIT, r[r.length - 2]);
	}

	@Test
	void schematicsFeature() {
		assertTrue(ApiRules.features(0, List.of()).contains("schematics"));
	}

	/** An implementation compiled before 1.20.0 (no overrides): the new methods throw. */
	@Test
	void defaultsThrow() throws Exception {
		Library lib = (Library) Proxy.newProxyInstance(Library.class.getClassLoader(), new Class<?>[] {Library.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		for (Method m : List.of(Library.class.getMethod("importSchematic", Path.class, String.class), Library.class.getMethod("importSchematic", Path.class,
			String.class, com.google.gson.JsonObject.class), Library.class.getMethod("exportSchematic", String.class, Integer.class, Path.class))) {
			assertTrue(m.isDefault(), m.toString());
		}
		var e = assertThrows(UnsupportedOperationException.class, () -> lib.importSchematic(Path.of("x.schem"), null));
		assertTrue(e.getMessage().contains("1.20.0"), e.getMessage());
		assertThrows(UnsupportedOperationException.class, () -> lib.importSchematic(Path.of("x.schem"), null, null));
		assertThrows(UnsupportedOperationException.class, () -> lib.exportSchematic("x", null, Path.of(".")));
		assertTrue(Sites.class.getMethod("exportSiteSchematic", String.class, Path.class).isDefault());
	}
}
