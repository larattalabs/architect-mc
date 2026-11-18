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
		List<PartShape> s = Layouts.shapes(ir, null, -64, 319, id -> 0);
		List<PartShape> lots = s.stream().filter(p -> "lot".equals(p.kind())).toList();
		assertEquals(ir.getAsJsonArray("lots").size(), lots.size(), "every lot, pads too");
		assertTrue(lots.stream().allMatch(p -> p.part().equals(p.lot())));
		List<PartShape> routes = s.stream().filter(p -> "route".equals(p.kind())).toList();
		assertEquals(ir.getAsJsonArray("roads").size(), routes.size());
		assertTrue(routes.stream().allMatch(p -> p.ends().size() >= 2 && p.box().minX() <= p.ends().get(0).getX() && p.ends().get(0).getX() <= p.box().maxX()));
		assertTrue(s.stream().anyMatch(p -> "tile".equals(p.kind())), "the IR's parts");
		assertEquals(s, Layouts.shapes(ir, null, -64, 319, id -> 0), "deterministic");
	}

	@Test
	void everyGoldenHasAShape() throws Exception {
		for (String g : List.of("crossings_demo_flat", "districts_demo", "forms_demo", "crater_toolbox")) {
			List<PartShape> s = Layouts.shapes(golden(g), null, -64, 319, id -> 0);
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
		List<PartShape> s = Layouts.shapes(new JsonObject(), body, 60, 100, id -> 0);
		assertEquals(List.of("link", "main", "square"), s.stream().map(PartShape::part).toList(), "a part with no geometry has no shape");
		assertEquals(List.of(new BlockPos(10, 70, 0), new BlockPos(10, 72, 30)), s.get(0).ends());
		assertEquals("connector.rope_bridge", s.get(0).kind());
		assertEquals(3, s.get(1).ends().size());
		assertEquals(List.of(1, 60, 2, 8, 100, 9), List.of(s.get(2).box().minX(), s.get(2).box().minY(), s.get(2).box().minZ(), s.get(2).box().maxX(), s.get(2)
			.box().maxY(), s.get(2).box().maxZ()));
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
