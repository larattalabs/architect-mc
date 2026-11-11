package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Since NEXT (6d AD): the feature regionAdopt (Java side), Regions.adopt and unadopt defaults that throw, the records copy their inputs. */
class ApiADTest {
	@Test
	void adoptFeatureDefaultsAndRecords() {
		assertTrue(ApiRules.features(1, List.of()).contains("regionAdopt"), "a Java feature");
		Regions old = (Regions) java.lang.reflect.Proxy.newProxyInstance(Regions.class.getClassLoader(), new Class<?>[] {Regions.class}, (p, m, a) -> {
			if (m.isDefault()) {
				return java.lang.reflect.InvocationHandler.invokeDefault(p, m, a);
			}
			throw new AssertionError(m.getName());
		});
		assertThrows(UnsupportedOperationException.class, () -> old.adopt(null));
		assertThrows(UnsupportedOperationException.class, () -> old.unadopt("rg1"));
		List<String> roads = new ArrayList<>(List.of("r1"));
		Map<String, String> lots = new LinkedHashMap<>(Map.of("house_1", "s1"));
		JsonObject g = new JsonObject();
		g.addProperty("streetZ", 10);
		AdoptRegionRequest r = new AdoptRegionRequest("steward", null, new net.minecraft.world.level.levelgen.structure.BoundingBox(0, 0, 0,
			9, 9, 9), AdoptRegionRequest.VILLAGE_LAYOUT, g, roads, lots, null, null);
		roads.clear();
		lots.clear();
		g.addProperty("streetZ", 11);
		assertEquals(List.of("r1"), r.roadSiteIds());
		assertEquals(Map.of("house_1", "s1"), r.lots());
		assertEquals(10, r.geometry().get("streetZ").getAsInt());
		assertEquals(0, r.ext().size());
		Map<String, String> gs = new LinkedHashMap<>(Map.of("s1", "g1"));
		UnadoptResult u = new UnadoptResult("rg1", gs, null);
		gs.clear();
		assertEquals(Map.of("s1", "g1"), u.groups());
		assertEquals(List.of(), u.newGroups());
	}
}
