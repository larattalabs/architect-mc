package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.PartShape;
import dev.larattalabs.architect.api.RegionLayout;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (LYW) Regions.layout of a walled town: the wall (its line, thickness, height), its gatehouse's passage and listed gates, its corner
 * towers, and its tower and gatehouse lots linked to it; an unwalled town has none; a district's stair route from the graph edge and its
 * IR paths; the 1.69.0 constructors still work. The castle_city answer is trimmed from the kit's castle_city ask (kit/test k3).
 */
class LayoutsWallTest {
	/** castle_city's curtain_wall answer (kit checkPlanLocal of the castle_city ask), trimmed; zone and lots as the IR would give them. */
	private static final String WALL = "{\"part\":\"curtain_wall\",\"block\":\"connector.wall\",\"class\":\"fits\",\"geometry\":{\"form\":\"around\","
		+ "\"line\":[[102,102],[217,102],[217,217],[102,217],[102,103]],\"closed\":true,\"height\":8,\"thickness\":2,\"cells\":790,\"top\":[72,72],"
		+ "\"gates\":[{\"id\":\"gatehouse_1_passage\",\"at\":[94,65,157],\"width\":3,\"door\":\"none\",\"auto\":false,\"kind\":\"passage\"},"
		+ "{\"id\":\"curtain_wall_g1\",\"at\":[160,65,217],\"width\":3,\"door\":\"none\",\"auto\":true}],\"ring\":[102,102,217,217],"
		+ "\"wallLots\":[{\"lot\":\"tower_1\",\"at\":\"corner\",\"box\":[97,65,96,107,104,108],\"front\":\"east\"},"
		+ "{\"lot\":\"tower_2\",\"at\":\"corner\",\"box\":[212,65,96,222,104,108],\"front\":\"west\"},"
		+ "{\"lot\":\"gatehouse_1\",\"at\":\"gate\",\"box\":[95,65,149,109,104,165],\"front\":\"west\",\"passage\":{\"width\":3,\"height\":3,"
		+ "\"front\":[94,65,157],\"back\":[110,65,157]}}]}}";
	private static final String ZONE = "{\"part\":\"castle\",\"block\":\"zone.standard\",\"geometry\":{\"rect\":[112,112,207,207]}}";
	private static final String LOTS = "{\"lots\":[{\"id\":\"keep_1\",\"box\":{\"minX\":148,\"minY\":65,\"minZ\":133,\"maxX\":170,\"maxY\":96,\"maxZ\":151}},"
		+ "{\"id\":\"tower_1\",\"box\":{\"minX\":97,\"minY\":65,\"minZ\":96,\"maxX\":107,\"maxY\":104,\"maxZ\":108}},"
		+ "{\"id\":\"tower_2\",\"box\":{\"minX\":212,\"minY\":65,\"minZ\":96,\"maxX\":222,\"maxY\":104,\"maxZ\":108}},"
		+ "{\"id\":\"gatehouse_1\",\"box\":{\"minX\":95,\"minY\":65,\"minZ\":149,\"maxX\":109,\"maxY\":104,\"maxZ\":165}}],"
		+ "\"roads\":[{\"id\":\"street_w\",\"points\":[[112,65,157],[150,65,157]],\"width\":3}]}";

	private static JsonObject body(String plan, String... parts) {
		return JsonParser.parseString("{\"plan\":" + plan + ",\"parts\":[" + String.join(",", parts) + "]}").getAsJsonObject();
	}

	private static Map<String, PartShape> byId(List<PartShape> s) {
		return s.stream().collect(Collectors.toMap(PartShape::part, p -> p));
	}

	private static JsonObject ir() {
		JsonObject ir = JsonParser.parseString(LOTS).getAsJsonObject();
		// (the lots' boxes as LotViews reads them)
		return ir;
	}

	@Test
	void aWalledTownListsItsWallGatesAndTowers() {
		String plan = "{\"connectors\":[{\"id\":\"curtain_wall\",\"kind\":\"wall\",\"corners\":\"tower\"}]}";
		List<PartShape> s = Layouts.shapes(ir(), List.of(new Layouts.Body(body(plan, ZONE, WALL), 0)), -64, 319, id -> 0);
		Map<String, PartShape> m = byId(s);
		PartShape w = m.get("curtain_wall");
		assertEquals("connector.wall", w.kind());
		assertEquals(2, w.width(), "its thickness");
		assertEquals(8, w.height());
		assertEquals("curtain_wall", w.wall());
		assertEquals(List.of(new BlockPos(102, 65, 102), new BlockPos(217, 65, 102), new BlockPos(217, 65, 217), new BlockPos(102, 65, 217), new BlockPos(102, 65,
			103), new BlockPos(102, 65, 102)), w.ends(), "the line at its foot (top 72 - 8 + 1), closed back to its first point: five runs");
		assertEquals(65, w.box().minY());
		assertEquals(72, w.box().maxY());
		// the gatehouse's passage, from its lot (front and back), not repeated from the wall's gates
		PartShape p = m.get("gatehouse_1_passage");
		assertEquals("connector.gate", p.kind());
		assertEquals(List.of(new BlockPos(94, 65, 157), new BlockPos(110, 65, 157)), p.ends());
		assertEquals(3, p.width());
		assertEquals("gate", p.wallAt());
		assertEquals("curtain_wall", p.wall());
		assertEquals(1, s.stream().filter(x -> x.part().equals("gatehouse_1_passage")).count());
		// an auto gate the wall lists
		PartShape g = m.get("curtain_wall_g1");
		assertEquals(List.of(new BlockPos(160, 65, 217)), g.ends());
		assertEquals(new BoundingBox(159, 65, 216, 161, 67, 218), g.box());
		// the tower and gatehouse lots stay lots, linked to the wall
		assertEquals("lot", m.get("tower_1").kind());
		assertEquals("curtain_wall", m.get("tower_1").wall());
		assertEquals("corner", m.get("tower_1").wallAt());
		assertEquals("gate", m.get("gatehouse_1").wallAt());
		assertNull(m.get("keep_1").wall(), "a lot off the wall");
		// corners: tower: a stub at each corner no lot holds (tower_1 and tower_2 hold the two north corners)
		List<PartShape> stubs = s.stream().filter(x -> "tower".equals(x.kind())).toList();
		assertEquals(List.of("curtain_wall_tower_3", "curtain_wall_tower_4"), stubs.stream().map(PartShape::part).toList());
		assertEquals(new BoundingBox(217, 65, 217, 219, 75, 219), stubs.get(0).box(), "a 3x3 square, 3 above the wall");
		assertEquals("corner", stubs.get(0).wallAt());
		// the zone and streets as before
		assertEquals(new BoundingBox(112, -64, 112, 207, 319, 207), m.get("castle").box());
		assertEquals(3, m.get("street_w").width(), "a route's width");
		assertEquals(s, Layouts.shapes(ir(), List.of(new Layouts.Body(body(plan, ZONE, WALL), 0)), -64, 319, id -> 0), "deterministic");
	}

	@Test
	void aNamedGatePartWinsOverTheWallsListAndPlainCornersHaveNoStubs() {
		String gatePart = "{\"part\":\"curtain_wall_g1\",\"block\":\"connector.gate\",\"geometry\":{\"wall\":\"curtain_wall\",\"at\":[160,65,217],\"width\":5,"
			+ "\"height\":4}}";
		List<PartShape> s = Layouts.shapes(ir(), List.of(new Layouts.Body(body("{\"connectors\":[{\"id\":\"curtain_wall\",\"kind\":\"wall\"}]}", ZONE, gatePart,
			WALL), 0)), -64, 319, id -> 0);
		PartShape g = byId(s).get("curtain_wall_g1");
		assertEquals(5, g.width(), "the gate part's own answer");
		assertEquals(4, g.height());
		assertTrue(s.stream().noneMatch(x -> "tower".equals(x.kind())), "corners plain (the default)");
	}

	@Test
	void anUnwalledTownListsNone() {
		List<PartShape> s = Layouts.shapes(ir(), List.of(new Layouts.Body(body("{\"zones\":[]}", ZONE), 0)), -64, 319, id -> 0);
		assertTrue(s.stream().allMatch(x -> x.wall() == null && x.wallAt() == null), "no wall, gate or tower");
		assertTrue(s.stream().noneMatch(x -> x.kind().startsWith("connector.") || "tower".equals(x.kind())));
		assertEquals(List.of("keep_1", "tower_1", "tower_2", "gatehouse_1", "castle", "street_w"), s.stream().map(PartShape::part).toList());
	}

	@Test
	void aDistrictsStairRouteIsOneRoute() throws Exception {
		// districts_demo: its routes between districts are stairs and graded sections in the IR's paths, not roads
		JsonObject ir = JsonParser.parseString(Files.readString(Path.of("..", "scenarios", "goldens", "districts_demo", "ir.json"))).getAsJsonObject();
		Map<String, PartShape> m = byId(Layouts.shapes(ir, List.of(), -64, 319, id -> 0));
		PartShape r = m.get("route_d_cloister__village");
		assertEquals("route", r.kind());
		assertEquals(3, r.width());
		assertEquals(new BlockPos(3685, 152, -1021), r.ends().get(0), "from the edge's from node");
		assertEquals(new BlockPos(3700, 135, -959), r.ends().get(r.ends().size() - 1), "to its to node");
		assertTrue(r.ends().size() >= 4, "through its sections");
		assertTrue(m.containsKey("route_d_village__fields"));
		assertTrue(r.box().minY() <= 135 && r.box().maxY() >= 152);
	}

	@Test
	void theOldConstructorsStillWork() {
		var s = new PartShape("p", "tile", null, new BoundingBox(0, 0, 0, 1, 1, 1), List.of(), 0, null, List.of());
		assertEquals(0, s.width());
		assertEquals(0, s.height());
		assertNull(s.wall());
		assertNull(s.wallAt());
		assertEquals(s, new PartShape("p", "tile", null, new BoundingBox(0, 0, 0, 1, 1, 1), null, 0, null, null, 0, 0, null, null));
		var l = new RegionLayout("r", "sha", 0, List.of(s));
		assertEquals(List.of(s), l.parts());
	}
}
