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
 * API 1.18.0 (docs/CONTRACT.md phase 6c slice SCH §1): the new Library and Sites methods are defaults that throw
 * "needs Architect API 1.18.0", {@link Reason#FORMAT} is appended after FIELD_LIMIT, and {@code schematics} is always a feature.
 */
class ApiSchTest {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 18, ArchitectApi.VERSION); // later slices append (6c SCH: 1.18.0, v0.21.0)
	}

	@Test
	void formatIsAppended() {
		// appended after 1.12.0's PROTECTED, FIELD_LIMIT (another slice of the batch may append before or after it)
		assertEquals(Reason.PROTECTED.ordinal() + 1, Reason.FIELD_LIMIT.ordinal());
		assertTrue(Reason.FORMAT.ordinal() > Reason.FIELD_LIMIT.ordinal());
	}

	@Test
	void schematicsFeature() {
		assertTrue(ApiRules.features(0, List.of()).contains("schematics"));
	}

	/** An implementation compiled before 1.18.0 (no overrides): the new methods throw. */
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
		assertTrue(e.getMessage().contains("1.18.0"), e.getMessage());
		assertThrows(UnsupportedOperationException.class, () -> lib.importSchematic(Path.of("x.schem"), null, null));
		assertThrows(UnsupportedOperationException.class, () -> lib.exportSchematic("x", null, Path.of(".")));
		assertTrue(Sites.class.getMethod("exportSiteSchematic", String.class, Path.class).isDefault());
	}
}
