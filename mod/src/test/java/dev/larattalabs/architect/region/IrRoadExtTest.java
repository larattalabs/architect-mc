package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (6c FL, S-FL-5) A plan region's street road carries its ext in the IR ({@code roads[].ext}: {@code architect_mc:street {zone,
 * district?}}); {@link Ir#of} reads it onto {@link Ir.Road#ext()}, which RegionsImpl puts on the road's batch item. A road without one
 * reads null, and the 6- and 7-argument Road constructors stay.
 */
class IrRoadExtTest {
	static JsonObject ir() {
		return JsonParser.parseString("""
			{"format": 1, "id": "plan_v0", "kitVersion": "0.38.0", "seed": "7",
			 "claim": {"minX": 0, "minZ": 0, "maxX": 63, "maxZ": 63, "minY": -64, "maxY": 320},
			 "stages": ["ground", "street"], "tiles": {"ground": {"terrain": [], "path": []}, "street": {"terrain": [], "path": []}},
			 "roads": [
			   {"id": "street_ring", "stage": "street", "part": "street", "points": [[10, 64, 10], [20, 64, 10]], "width": 3, "lanterns": true,
			    "ext": {"architect_mc:street": {"zone": "camp"}}},
			   {"id": "market_street_w", "stage": "street", "part": "market_street", "points": [[10, 64, 20], [20, 64, 20]], "width": 3, "lanterns": true,
			    "ext": {"architect_mc:street": {"district": "market", "zone": "quarters"}}},
			   {"id": "route_c0l0_1", "stage": "street", "part": "routes_0", "points": [[10, 64, 30], [20, 64, 30]], "width": 3, "lanterns": true}
			 ],
			 "anchors": {"entrance": [1, 64, 1], "spawn": [2, 64, 2]}, "budget": {"cells": 10, "removed": 4, "added": 6}}
			""").getAsJsonObject();
	}

	@Test
	void streetRoadsCarryTheirExt() {
		Ir i = Ir.of(ir());
		List<Ir.Road> roads = i.roads();
		assertEquals(3, roads.size());
		assertEquals("camp", roads.get(0).ext().getAsJsonObject("architect_mc:street").get("zone").getAsString());
		JsonObject d = roads.get(1).ext().getAsJsonObject("architect_mc:street");
		assertEquals("quarters", d.get("zone").getAsString());
		assertEquals("market", d.get("district").getAsString());
		assertNull(roads.get(2).ext(), "a connector's route carries no street ext");
		assertEquals(RegionsImpl.STREET_EXT, "architect_mc:street");
	}

	@Test
	void oldConstructorsStay() {
		Ir.Road a = new Ir.Road("r", "ground", List.of(new int[] {0, 64, 0}, new int[] {4, 64, 0}), 3, null, true);
		Ir.Road b = new Ir.Road("r", "ground", List.of(new int[] {0, 64, 0}, new int[] {4, 64, 0}), 3, null, true, null);
		assertNull(a.ext());
		assertNull(b.ext());
		assertTrue(a.lanterns() && b.lanterns());
	}
}
