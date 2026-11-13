package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (slice TJ, docs/CONTRACT.md "Slice TJ"): AV's runtime {@link ArchitectApi#apiVersion()} and its feature, and the camelCase
 * aliases of the dotted feature names (the dotted ones kept).
 */
class ApiTJTest {
	@Test
	void apiVersionIsADefaultAnsweringTheLoadedVersion() throws Throwable {
		Method m = ArchitectApi.class.getMethod("apiVersion");
		assertTrue(m.isDefault(), "apiVersion is a default (additive: an old implementation still loads)");
		assertEquals(String.class, m.getReturnType());
		InvocationHandler h = (proxy, method, a) -> method.isDefault() ? InvocationHandler.invokeDefault(proxy, method, a) : null;
		ArchitectApi api = (ArchitectApi) Proxy.newProxyInstance(ArchitectApi.class.getClassLoader(), new Class<?>[] {ArchitectApi.class}, h);
		// the body reads VERSION inside Architect's own class: what a consumer gets is this build's version, whatever it compiled against
		assertEquals(ArchitectApi.VERSION, api.apiVersion());
		assertTrue(api.apiVersion().matches("\\d+\\.\\d+\\.\\d+"), api.apiVersion());
	}

	@Test
	void apiVersionIsAlwaysAdvertised() {
		assertTrue(ApiRules.JAVA_FEATURES.contains("apiVersion"));
		assertTrue(ApiRules.features(1, List.of()).contains("apiVersion"));
		assertTrue(ApiRules.features(2, List.of("job.run")).contains("apiVersion"));
	}

	@Test
	void dottedNamesGetCamelCaseAliasesAndKeepTheirOldNames() {
		Set<String> f = ApiRules.features(2, List.of("job.run", "job.systemRefs", "design.opKeys", "wallLots.exactMassing"));
		for (String n : List.of("job.systemRefs", "jobSystemRefs", "design.opKeys", "designOpKeys", "wallLots.exactMassing", "wallLotsExactMassing")) {
			assertTrue(f.contains(n), n + " in " + f);
		}
		Set<String> none = ApiRules.features(2, List.of("job.run"));
		for (String n : List.of("jobSystemRefs", "designOpKeys", "wallLotsExactMassing")) {
			assertFalse(none.contains(n), "no alias without its dotted name: " + n);
		}
		// every alias is camelCase (no dot) and every key is a dotted name
		for (var e : ApiRules.CAMEL_ALIASES.entrySet()) {
			assertTrue(e.getKey().contains(".") && !e.getValue().contains(".") && Character.isLowerCase(e.getValue().charAt(0)), e.toString());
		}
	}
}
