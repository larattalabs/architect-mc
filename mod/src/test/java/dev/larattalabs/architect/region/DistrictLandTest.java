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

	/** (the RC's finding 2) A region's own wall: its `w_<id>` parts' columns as {@code walls} (as the kit's besideStanding), only when it has one. */
	@Test
	void standingCarriesItsOwnWalls() {
		JsonObject ir = JsonParser.parseString("{\"roads\": [], \"lots\": [], \"paths\": [], \"graph\": {\"nodes\": [], \"edges\": []}, \"parts\": [{\"id\": \"w_town_wall\", "
			+ "\"ops\": [{\"op\": \"columns\", \"cols\": [4, 4, 64, 66, 0, 5, 4, 64, 66, 0, 6, 4, 64, 66, 0]}]}]}").getAsJsonObject();
		assertEquals(JsonParser.parseString("[[4, 4, 6, 4]]"), BesideReach.standing("rg9", new int[] {0, 0, 95, 95}, ir).get("walls"));
		ir.add("parts", new JsonArray());
		assertNull(BesideReach.standing("rg9", new int[] {0, 0, 95, 95}, ir).get("walls"));
	}

	/** (RTE) The route parts' cells by id (kit/test/rte.test.mjs's two districtLand cases, the same numbers). */
	private static java.util.Map<String, Integer> routeCells(String roads, String paths) {
		JsonObject ir = JsonParser.parseString("{\"params\":{\"spec\":{\"districts\":[{\"id\":\"a\"},{\"id\":\"b\"},{\"id\":\"b_1\"}]}},\"parts\":[],\"lots\":[],"
			+ "\"roads\":[" + roads + "],\"paths\":[" + paths + "],\"graph\":{\"nodes\":[],\"edges\":[{\"id\":\"route_d_a__b\",\"path\":\"route_d_a__b\"},"
			+ "{\"id\":\"route_d_a__b_1\",\"path\":\"route_d_a__b_1\"}]}}").getAsJsonObject();
		java.util.Map<String, Integer> out = new java.util.TreeMap<>();
		for (JsonElement e : DistrictLand.of(ir, null, null).getAsJsonArray("parts")) {
			if ("route".equals(e.getAsJsonObject().get("kind").getAsString())) {
				out.put(e.getAsJsonObject().get("id").getAsString(), e.getAsJsonObject().get("cells").getAsInt());
			}
		}
		return out;
	}

	private static String road(String id, int x0, int x1, String edge) {
		return "{\"id\":\"" + id + "\",\"points\":[[" + x0 + ",64,0],[" + x1 + ",64,0]],\"width\":1"
			+ (edge == null ? "" : ",\"ext\":{\"architect_mc:route\":{\"edge\":\"" + edge + "\"}}") + "}";
	}

	@Test
	void anUntaggedLongRoadsGroupsAreTheirEdgesRoute() {
		assertEquals(java.util.Map.of("d_a__b", 90), routeCells(road("route_d_a__b_1", 0, 9, null) + "," + road("route_d_a__b_3_1", 20, 29, null) + ","
			+ road("route_d_a__b_3_2", 30, 39, null), ""));
	}

	@Test
	void aTaggedPieceIsItsRecordedEdgesRoute() {
		assertEquals(java.util.Map.of("d_a__b", 60, "d_a__b_1", 5), routeCells(road("route_d_a__b_1_1", 0, 9, "route_d_a__b") + ","
			+ road("route_d_a__b_1_2", 10, 19, "route_d_a__b"), "{\"id\":\"route_d_a__b_1_3\",\"box\":{\"minX\":0,\"minY\":64,\"minZ\":10,\"maxX\":0,"
			+ "\"maxY\":70,\"maxZ\":14},\"ext\":{\"architect_mc:route\":{\"edge\":\"route_d_a__b_1\"}}}"));
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
