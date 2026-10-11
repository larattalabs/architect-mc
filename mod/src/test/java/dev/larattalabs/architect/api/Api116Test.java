package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * API 1.16.0 (docs/CONTRACT.md phase 6c slice F1 §1): no new records or methods. The features come with a forms-I helper
 * ({@code region.forms1}); a plan with a {@code voxels} op requires the {@code voxels} kind, which this game knows and an older
 * one refuses PLAN_STALE.
 */
class Api116Test {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 16, ArchitectApi.VERSION); // later slices append
	}

	@Test
	void featuresComeWithAFormsHelper() {
		Set<String> f = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut", "region.forms1"));
		for (String x : List.of("formsIce", "formsRock", "voxelsOp")) {
			assertTrue(f.contains(x), x);
		}
		assertFalse(f.contains("region.forms1"), "the wire name is not a feature");
		Set<String> old = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.keepOut"));
		for (String x : List.of("formsIce", "formsRock", "voxelsOp")) {
			assertFalse(old.contains(x), x);
		}
		assertFalse(ApiRules.features(1, List.of("region.forms1")).contains("voxelsOp"), "protocol 1 carries no helper features");
	}

	@Test
	void voxelsIsAKnownKind() {
		assertTrue(IrStale.KINDS_FORMAT2.contains("voxels"));
		JsonObject ir = new JsonObject();
		ir.addProperty("format", 2);
		ir.addProperty("kitVersion", IrStale.KIT_VERSION);
		JsonArray req = new JsonArray();
		req.add("forms");
		req.add("voxels");
		ir.add("requires", req);
		assertEquals(null, IrStale.reason(ir, null));
		// a helper whose kit predates F1 (its hello lists no voxels) refuses it, naming the kind
		IrStale.Hello older = new IrStale.Hello("0.16.0", List.of(1, 2), List.of("blobs:side", "fields", "forms", "material:rule", "volumes"));
		JsonObject ir16 = ir.deepCopy();
		ir16.addProperty("kitVersion", "0.16.0");
		assertEquals("plan needs kinds [voxels]; this is kit 0.16.0", IrStale.reason(ir16, older));
	}
}
