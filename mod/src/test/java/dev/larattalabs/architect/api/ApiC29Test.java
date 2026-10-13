package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * C29 (docs/CONTRACT.md "C29 as built"): {@code Sites.pause} is a default that throws on an older implementation (binary
 * compatible), the features name both halves, and no Reason is added.
 */
class ApiC29Test {
	@Test
	void features() {
		Set<String> f = ApiRules.features(1, List.of());
		assertTrue(f.contains("targetPause") && f.contains("removalLeavesFeed"), f.toString());
	}

	@Test
	void pauseIsADefaultThatThrows() throws Exception {
		Method m = Sites.class.getMethod("pause", String.class, boolean.class);
		assertTrue(m.isDefault() && !Modifier.isAbstract(m.getModifiers()) && m.getReturnType() == void.class, m.toString());
		// an implementation written before C29: only the default methods run
		Sites old = (Sites) java.lang.reflect.Proxy.newProxyInstance(Sites.class.getClassLoader(), new Class<?>[] {Sites.class}, (p, x, args) -> x.isDefault()
			? java.lang.reflect.InvocationHandler.invokeDefault(p, x, args) : null);
		UnsupportedOperationException e = assertThrows(UnsupportedOperationException.class, () -> old.pause("s1", true));
		assertTrue(e.getMessage().contains("Sites.pause needs Architect API 1."), e.getMessage());
	}

	@Test
	void noNewReason() {
		assertTrue(java.util.Arrays.stream(Reason.values()).noneMatch(x -> x.name().contains("PAUSE") || x.name().contains("REMOV")), "no new Reason");
	}
}
