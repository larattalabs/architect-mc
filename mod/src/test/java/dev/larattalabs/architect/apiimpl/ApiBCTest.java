package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Sites;
import dev.larattalabs.architect.region.IrStale;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** (BC) Items 5 and 6: the runtime kit and checker versions, the sites store's load health; their feature names. */
class ApiBCTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void theImplementationAnswersThem() throws Exception {
		// ApiImpl needs a Fabric loader to start: its bodies are checked here, their values in game (dev.api.versions)
		assertEquals(ApiImpl.class, ApiImpl.class.getMethod("kitVersion").getDeclaringClass());
		assertEquals(ApiImpl.class, ApiImpl.class.getMethod("checkerVersion").getDeclaringClass());
		assertEquals(SitesImpl.class, SitesImpl.class.getMethod("loadHealthy").getDeclaringClass());
		assertTrue(IrStale.KIT_VERSION.matches("\\d+\\.\\d+\\.\\d+"), IrStale.KIT_VERSION);
	}

	@Test
	void theStoreIsNotHealthyWithoutAWorld() {
		assertFalse(new SitesImpl(null).loadHealthy(), "no world running");
		assertFalse(dev.larattalabs.architect.site.Sites.loadHealthy());
	}

	@SuppressWarnings("unchecked")
	private static <T> T older(Class<T> c) {
		return (T) java.lang.reflect.Proxy.newProxyInstance(c.getClassLoader(), new Class<?>[] {c}, (proxy, m, args) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(proxy, m, args);
			}
			throw new AssertionError("not a default: " + m);
		});
	}

	@Test
	void anOlderImplementationThrows() {
		ArchitectApi old = older(ArchitectApi.class);
		assertThrows(UnsupportedOperationException.class, old::kitVersion);
		assertThrows(UnsupportedOperationException.class, old::checkerVersion);
		assertThrows(UnsupportedOperationException.class, () -> older(Sites.class).loadHealthy());
	}

	@Test
	void theFeaturesNameThem() {
		var f = ApiRules.features(0, java.util.List.of());
		assertTrue(f.contains("kitVersion") && f.contains("sitesLoadHealthy") && f.contains("maxBill"), f.toString());
	}
}
