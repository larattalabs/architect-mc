package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.region.IrStale;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * API PT2 placeholder 1.28.0 (docs/CONTRACT.md "Phase 6c slice PT2" §1): adopt and adoptedSite are defaults that throw "needs
 * Architect API 1.28.0"; ADOPT_REFUSED and ADOPTED are appended; Build, DeltaVerdict and EntryVersion keep their old constructors
 * (siteId null, capturedChanged and capturedTotal 0).
 */
class ApiPT2Test {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void versionAndEnums() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.28.0") >= 0, ArchitectApi.VERSION);
		assertEquals(Reason.PLAYER_BUILD.ordinal() + 1, Reason.ADOPT_REFUSED.ordinal());
		assertEquals(BuildState.PROVISIONAL.ordinal() + 1, BuildState.ADOPTED.ordinal());
	}

	@Test
	void defaultsThrow() {
		Sites old = (Sites) Proxy.newProxyInstance(Sites.class.getClassLoader(), new Class<?>[] {Sites.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		List<Runnable> calls = List.of(() -> old.adopt("build-1", null, new BuildConsent(Set.of("build-1"), null), new com.google.gson.JsonObject()),
			() -> old.adoptedSite("build-1"));
		for (Runnable r : calls) {
			var e = assertThrows(UnsupportedOperationException.class, r::run);
			assertTrue(e.getMessage().contains("1.28.0"), e.getMessage());
		}
	}

	@Test
	void oldConstructors() {
		Build b = new Build("build-1", Level.OVERWORLD, new BoundingBox(0, 0, 0, 1, 1, 1), new int[0], List.of(), BuildKind.HOUSE, 1f, 40, Map.of(),
			BuildState.ACTIVE, 1L);
		assertNull(b.siteId());
		DeltaVerdict v = new DeltaVerdict(true, List.of(), 0, 0, 0, Map.of(), List.of(), List.of(), Map.of(), Map.of(), new BoundingBox(0, 0, 0, 0, 0, 0),
			Mode.INSTANT, List.of());
		assertEquals(0, v.capturedChanged());
		assertEquals(0, v.capturedTotal());
		EntryVersion e = new EntryVersion(1, 0L, "design", null, null, "", "", false);
		assertEquals(0, e.capturedChanged());
		assertEquals(0, e.capturedTotal());
	}
}
