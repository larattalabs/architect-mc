package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.apiimpl.ApiRules;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (7a K3; docs/CONTRACT.md "Phase 7a slice K3" §8): no new records, methods, reasons or IR kinds; the feature wallLots
 * (sidecar region.walls.lots).
 */
class ApiK3Test {
	@Test
	void features() {
		assertTrue(ApiRules.features(2, List.of("region.walls.lots")).contains("wallLots"));
		assertFalse(ApiRules.features(2, List.of("region.walls", "region.walls.walk", "region.walls.along")).contains("wallLots"), "a K1/K2 helper has no wallLots");
		assertFalse(ApiRules.features(1, List.of("region.walls.lots")).contains("wallLots"), "protocol 1 has no helper features");
		// (since NEXT) a wall lot's massing takes its box, its detail's cap is the box
		assertTrue(ApiRules.features(2, List.of("wallLots.exactMassing")).contains("wallLots.exactMassing"));
		assertFalse(ApiRules.features(2, List.of("region.walls.lots")).contains("wallLots.exactMassing"), "a K3 helper before NEXT caps by massing + 2");
	}

	/** design.opKeys (7a K3, Steward's RC): the feature, the record component, the copy methods, the new methods and types. */
	@Test
	void designOpKeys() throws Exception {
		assertTrue(ApiRules.features(2, List.of("design.opKeys")).contains("design.opKeys"));
		assertFalse(ApiRules.features(2, List.of("opKeys")).contains("design.opKeys"), "6c 0a's group and bible keys are not design keys");
		assertFalse(ApiRules.features(1, List.of("design.opKeys")).contains("design.opKeys"));

		DesignRequest base = new DesignRequest("house", "rustic", null, List.of(), new BlockSize(13, 12, 13), "Lot", null, null, "steward_mc:s1",
			new JsonObject(), null, null, null, null);
		assertNull(base.opKey());
		DesignRequest k = base.withOpKey("st:lot:1");
		assertEquals("st:lot:1", k.opKey());
		// every copy method keeps the key
		for (DesignRequest c : List.of(k.withProfile(List.of("door")), k.withBible("b", 1), k.massing(true), k.massing(false), k.fromMassing("m1"),
			k.fromMassing("m1", 2), k.withContext("ctx"), k.withContext(new JsonPrimitive("ctx")), k.critique(null), k.versionOf("gen_x", null),
			k.withReserved(null), k.withPalette(new JsonPrimitive("oak")))) {
			assertEquals("st:lot:1", c.opKey(), c.toString());
		}
		assertNull(k.withOpKey(null).opKey());
		// the 1.41.0 canonical constructor is kept (binary compatibility) and means no key
		DesignRequest.class.getConstructor(String.class, String.class, String.class, List.class, BlockSize.class, String.class, String.class, String.class,
			String.class, JsonObject.class, String.class, Double.class, String.class, String.class, List.class, Integer.class, boolean.class, String.class,
			Integer.class, com.google.gson.JsonElement.class, CritiqueSpec.class, String.class, String.class, DesignRequest.Reserved.class,
			com.google.gson.JsonElement.class);

		Method byKey = Designs.class.getMethod("designByKey", String.class, String.class);
		Method cancel = Designs.class.getMethod("cancelDesign", String.class);
		assertTrue(byKey.isDefault() && cancel.isDefault(), "new methods are defaults");
		assertEquals(CompletableFuture.class, byKey.getReturnType());
		assertEquals(CompletableFuture.class, cancel.getReturnType());
		assertEquals(List.of(CancelOutcome.Kind.CANCELLED, CancelOutcome.Kind.ALREADY_FINAL, CancelOutcome.Kind.UNKNOWN), List.of(CancelOutcome.Kind.values()));
		assertEquals(Optional.empty(), new CancelOutcome(CancelOutcome.Kind.UNKNOWN, null).design());
	}
}
