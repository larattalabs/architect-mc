package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (6c D3, §6, §14 item 1) The mod's halves equal the kit's on the parity fixture (kit/test/fixtures/d3/parity.json, the kit's own answers:
 * kit/test/districts-d3-parity.test.mjs): {@link BesideReach#standing} equals besideStanding on the town, {@link DistrictLand#of} equals
 * districtLand on every district IR (a reach join at a street end, a side T, a seam join, an outpost), with the town, without one, and
 * with standingRemoved.
 */
class DistrictLandTest {
	static final Path FIXTURE = Path.of("../kit/test/fixtures/d3/parity.json");

	static JsonObject fixture() throws Exception {
		return JsonParser.parseString(Files.readString(FIXTURE)).getAsJsonObject();
	}

	static int[] arr(JsonArray a) {
		int[] o = new int[a.size()];
		for (int i = 0; i < o.length; i++) {
			o[i] = a.get(i).getAsInt();
		}
		return o;
	}

	@Test
	void standingEqualsTheKits() throws Exception {
		JsonObject t = fixture().getAsJsonObject("town");
		JsonObject got = BesideReach.standing(t.get("id").getAsString(), arr(t.getAsJsonArray("claim")), t.getAsJsonObject("ir"));
		assertEquals(t.getAsJsonObject("standing"), got);
	}

	@Test
	void landEqualsTheKits() throws Exception {
		JsonArray ds = fixture().getAsJsonArray("districts");
		assertTrue(ds.size() >= 4);
		for (JsonElement e : ds) {
			JsonObject d = e.getAsJsonObject();
			String name = d.get("name").getAsString();
			JsonObject ir = d.getAsJsonObject("ir");
			int[] town = arr(d.getAsJsonArray("townClaim"));
			assertEquals(d.getAsJsonObject("land"), DistrictLand.of(ir, town, null), name);
			assertEquals(d.getAsJsonObject("landNoTown"), DistrictLand.of(ir, null, null), name);
			assertEquals(d.getAsJsonObject("landRemoved"), DistrictLand.of(ir, town, 1234567L), name);
		}
	}

	@Test
	void notADistrictsPlan() throws Exception {
		JsonObject t = fixture().getAsJsonObject("town");
		assertNull(DistrictLand.of(t.getAsJsonObject("ir"), null, null), "a village is no districts plan");
	}

	@Test
	void streetIds() {
		assertTrue(BesideReach.isStreetId("street_w"));
		assertTrue(BesideReach.isStreetId("east_street_e"));
		assertTrue(BesideReach.isStreetId("route_st_quay"));
		assertTrue(!BesideReach.isStreetId("d_a__b") && !BesideReach.isStreetId("lane_x") && !BesideReach.isStreetId("join"));
	}

	@Test
	void verdictCodes() {
		assertEquals("NO_JOIN [route]", BesideVerdicts.code(null, "NO_JOIN: [route] no route from a district to region rg1's 9 street end(s)"));
		assertEquals("NO_JOIN [apart]", BesideVerdicts.code(null, "Error: NO_JOIN: [apart] this claim neither overlaps nor touches region rg1's claim"));
		assertEquals("NO_JOIN", BesideVerdicts.code(null, "NO_JOIN: no street end of region rg1 lies inside this claim"));
		assertEquals("NO_ROOM", BesideVerdicts.code(null, "NO_ROOM: no district could be placed (east: no_candidate)"));
		assertEquals("OVERLAP", BesideVerdicts.code(dev.larattalabs.architect.api.Reason.OVERLAP, "beside rg1: the claim overlaps the standing region's 20 columns deep"));
		assertNull(BesideVerdicts.code(null, "something else"));
		assertEquals(15, BesideReach.lightLevelOf("minecraft:lantern[hanging=false,waterlogged=false]"));
		assertEquals(10, BesideReach.lightLevelOf("minecraft:soul_lantern[hanging=false]"));
		assertEquals(0, BesideReach.lightLevelOf("minecraft:oak_fence[east=false]"));
	}

	@Test
	void colsRuns() {
		BesideReach.Cols c = new BesideReach.Cols();
		c.add(3, 1);
		c.add(1, 1);
		c.add(2, 1);
		c.add(5, 1);
		c.add(0, 0);
		assertEquals("[[0,0,0,0],[1,1,3,1],[5,1,5,1]]", c.runs().toString());
		assertEquals(5, c.size());
		assertEquals(5, BesideReach.colsOf(c.runs()).size());
	}
}
