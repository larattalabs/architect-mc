package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.region.IrStale;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * API 1.39.0 (6c slice F3, a placeholder the coordinator sets at merge; docs/CONTRACT.md "Phase 6c slice F3" §7): a forms-II helper's
 * {@code plan.forms2} gives {@code "formsTrees"}, {@code "formsCave"} and {@code "formsWater"}; no public type changes; the versions;
 * the cave forms make a check plan twice (PlanChecks.hasCaveForm, as a tunnel does).
 */
class ApiF3Test {
	@Test
	void versionsAndFeatures() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.39.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.40.0") >= 0, IrStale.KIT_VERSION);
		Set<String> f = ApiRules.features(2, List.of("region.fluids", "plan.forms2"));
		assertTrue(f.contains("formsTrees") && f.contains("formsCave") && f.contains("formsWater"), f.toString());
		Set<String> g = ApiRules.features(2, List.of("region.fluids", "plan.rules"));
		assertFalse(g.contains("formsTrees") || g.contains("formsCave") || g.contains("formsWater"), "a helper before F3 has none of them");
		assertFalse(ApiRules.features(1, List.of("plan.forms2")).contains("formsTrees"), "protocol 1: no helper features");
	}

	@Test
	void caveFormsPlanTwice() {
		JsonObject drips = JsonParser.parseString("{\"forms\":[{\"id\":\"d\",\"kind\":\"stalactites\"}]}").getAsJsonObject();
		JsonObject roots = JsonParser.parseString("{\"forms\":[{\"id\":\"r\",\"kind\":\"roots\"}]}").getAsJsonObject();
		JsonObject tree = JsonParser.parseString("{\"forms\":[{\"id\":\"t\",\"kind\":\"giant_tree\"}]}").getAsJsonObject();
		assertTrue(dev.larattalabs.architect.region.PlanChecksF3Access.hasCaveForm(drips));
		assertTrue(dev.larattalabs.architect.region.PlanChecksF3Access.hasCaveForm(roots));
		assertFalse(dev.larattalabs.architect.region.PlanChecksF3Access.hasCaveForm(tree), "a tree asks no volume");
		assertFalse(dev.larattalabs.architect.region.PlanChecksF3Access.hasCaveForm(new JsonObject()));
		assertEquals(0, new JsonArray().size());
	}
}
