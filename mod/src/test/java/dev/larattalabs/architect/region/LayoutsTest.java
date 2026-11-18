package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.PartShape;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (8b LY) Regions.layout's geometry over real IRs: a village golden (lots with boxes, the IR's parts as tiles, its streets as routes with
 * their polylines), a plan/0 artifact's parts (a connector's two ends, a route's legs, a zone's rect), the 64-point cap; the same in both
 * modes (the geometry reads the IR and the artifact only).
 */
class LayoutsTest {
	private static JsonObject golden(String id) throws Exception {
		return JsonParser.parseString(Files.readString(Path.of("..", "scenarios", "goldens", id, "ir.json"))).getAsJsonObject();
	}

	@Test
	void aVillage() throws Exception {
		JsonObject ir = golden("s7");
		List<PartShape> s = Layouts.shapes(ir, List.of(), -64, 319, id -> 0);
		List<PartShape> lots = s.stream().filter(p -> "lot".equals(p.kind())).toList();
		assertEquals(ir.getAsJsonArray("lots").size(), lots.size(), "every lot, pads too");
		assertTrue(lots.stream().allMatch(p -> p.part().equals(p.lot())));
		List<PartShape> routes = s.stream().filter(p -> "route".equals(p.kind())).toList();
		assertEquals(ir.getAsJsonArray("roads").size(), routes.size());
		assertTrue(routes.stream().allMatch(p -> p.ends().size() >= 2 && p.box().minX() <= p.ends().get(0).getX() && p.ends().get(0).getX() <= p.box().maxX()));
		assertTrue(s.stream().anyMatch(p -> "tile".equals(p.kind())), "the IR's parts");
		assertEquals(s, Layouts.shapes(ir, List.of(), -64, 319, id -> 0), "deterministic");
	}

	@Test
	void everyGoldenHasAShape() throws Exception {
		for (String g : List.of("crossings_demo_flat", "districts_demo", "forms_demo", "crater_toolbox")) {
			List<PartShape> s = Layouts.shapes(golden(g), List.of(), -64, 319, id -> 0);
			assertTrue(!s.isEmpty(), g);
			assertTrue(s.stream().allMatch(p -> p.box().minX() <= p.box().maxX() && p.box().minY() <= p.box().maxY()), g);
		}
	}

	@Test
	void aPlan0ArtifactsParts() {
		JsonObject body = JsonParser.parseString("{\"parts\":[{\"part\":\"link\",\"block\":\"connector.rope_bridge\",\"geometry\":{\"link\":{\"kind\":\"rope_bridge\","
			+ "\"from\":[10,70,0],\"to\":[10,72,30]}}},{\"part\":\"main\",\"block\":\"route.street\",\"geometry\":{\"legs\":[{\"from\":[0,64,0],\"to\":[20,64,0],"
			+ "\"path\":[[0,64,0],[10,64,0],[20,64,5]]}]}},{\"part\":\"square\",\"block\":\"zone.standard\",\"geometry\":{\"rect\":[1,2,8,9]}},{\"part\":\"x\","
			+ "\"block\":\"form.crater\"}]}").getAsJsonObject();
		List<PartShape> s = Layouts.shapes(new JsonObject(), List.of(new Layouts.Body(body, 0)), 60, 100, id -> 0);
		assertEquals(List.of("link", "main", "square"), s.stream().map(PartShape::part).toList(), "a part with no geometry has no shape");
		assertEquals(List.of(new BlockPos(10, 70, 0), new BlockPos(10, 72, 30)), s.get(0).ends());
		assertEquals("connector.rope_bridge", s.get(0).kind());
		assertEquals(3, s.get(1).ends().size());
		assertEquals(List.of(1, 60, 2, 8, 100, 9), List.of(s.get(2).box().minX(), s.get(2).box().minY(), s.get(2).box().minZ(), s.get(2).box().maxX(), s.get(2)
			.box().maxY(), s.get(2).box().maxZ()));
	}

	@Test
	void aRevisedPlan0RegionFollowsTheHead() {
		// (8b review P2-3) the realised artifact's parts, a revision artifact's connector, and the effective IR's road a growth added
		JsonObject base = JsonParser.parseString("{\"parts\":[{\"part\":\"square\",\"block\":\"zone.standard\",\"geometry\":{\"rect\":[1,2,8,9]}}]}")
			.getAsJsonObject();
		JsonObject rev = JsonParser.parseString("{\"parts\":[{\"part\":\"link2\",\"block\":\"connector.ladder\",\"geometry\":{\"link\":{\"from\":[0,64,0],"
			+ "\"to\":[0,70,3]}}},{\"part\":\"square\",\"block\":\"zone.standard\",\"geometry\":{\"rect\":[1,2,20,20]}}]}").getAsJsonObject();
		JsonObject ir = JsonParser.parseString("{\"roads\":[{\"id\":\"street_ext\",\"stage\":\"rv1\",\"rid\":1,\"points\":[[0,64,0],[30,64,0]],\"width\":3}],"
			+ "\"parts\":[{\"id\":\"rv1_fill\",\"stage\":\"rv1\",\"rid\":1,\"ops\":[{\"bounds\":{\"minX\":0,\"minY\":60,\"minZ\":0,\"maxX\":4,\"maxY\":64,"
			+ "\"maxZ\":4}}]}]}").getAsJsonObject();
		List<PartShape> s = Layouts.shapes(ir, List.of(new Layouts.Body(base, 0), new Layouts.Body(rev, 1)), 60, 100, id -> 0);
		var byId = s.stream().collect(Collectors.toMap(PartShape::part, p -> p));
		assertEquals(20, byId.get("square").box().maxX(), "a changed zone: the head's geometry");
		assertEquals(1, byId.get("link2").revision(), "a revision's connector, its rid");
		assertEquals("route", byId.get("street_ext").kind(), "a growth's road, from the effective IR");
		assertEquals(1, byId.get("street_ext").revision());
		assertTrue(!byId.containsKey("rv1_fill"), "a plan/0 region's IR parts are its plan parts' writes, not shapes of their own");
		assertTrue(Layouts.shapes(ir, List.of(), 60, 100, id -> 0).stream().anyMatch(p -> p.part().equals("rv1_fill") && p.revision() == 1),
			"a bundled program's grown part, from the effective IR");
	}

	@Test
	void polylinesKeepAtMost64Points() {
		List<BlockPos> line = new ArrayList<>();
		for (int i = 0; i < 500; i++) {
			line.add(new BlockPos(i, 64, i % 7));
			line.add(new BlockPos(i, 64, i % 7)); // a duplicate, dropped
		}
		List<BlockPos> s = Layouts.simplify(line);
		assertEquals(PartShape.MAX_ENDS, s.size());
		assertEquals(line.get(0), s.get(0));
		assertEquals(line.get(line.size() - 1), s.get(s.size() - 1), "the last point kept");
		assertNotNull(Layouts.opsBox(JsonParser.parseString("{\"ops\":[{\"bounds\":{\"minX\":0,\"minY\":null,\"minZ\":0,\"maxX\":2,\"maxY\":5,\"maxZ\":2}}]}")
			.getAsJsonObject(), -64, 319));
		assertEquals(Layouts.simplify(line).stream().map(BlockPos::getX).collect(Collectors.toList()), s.stream().map(BlockPos::getX).toList());
	}
}
