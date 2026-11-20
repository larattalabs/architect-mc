package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.PartShape;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (RTE3) Regions.layout on an IR the kit's numbering skip renumbered (RTE2): kit/test/fixtures/rte3/layout-ir.json, written by
 * kit/tools/rte3-fixture.mjs from a tagged districts-style route pass. Edge d_a__b sits beside d_a__b_1, so b's pieces skip n = 1
 * (route_d_a__b_2, _3 a stair, _4) while b_1 keeps route_d_a__b_1_1, _2 (a stair), _3. Each route is drawn whole from only its own pieces,
 * in piece order across the gap, in either edge order; no road is lost or listed twice.
 */
class LayoutsRte3Test {
	static final Path IR = Path.of("../kit/test/fixtures/rte3/layout-ir.json");

	private static Map<String, PartShape> shapes(boolean reversed, boolean untagged) throws Exception {
		JsonObject o = JsonParser.parseString(Files.readString(IR)).getAsJsonObject();
		if (reversed) {
			JsonArray es = o.getAsJsonObject("graph").getAsJsonArray("edges");
			es.add(es.remove(0));
		}
		if (untagged) {
			for (String k : List.of("roads", "paths")) {
				for (JsonElement x : o.getAsJsonArray(k)) {
					x.getAsJsonObject().remove("ext");
				}
			}
		}
		return Layouts.shapes(o, List.of(), -64, 319, id -> 0).stream().collect(Collectors.toMap(PartShape::part, x -> x));
	}

	@Test
	void theFixtureIsRenumbered() throws Exception {
		JsonObject o = JsonParser.parseString(Files.readString(IR)).getAsJsonObject();
		List<String> roads = o.getAsJsonArray("roads").asList().stream().map(x -> x.getAsJsonObject().get("id").getAsString()).toList();
		assertEquals(List.of("route_d_a__b_2", "route_d_a__b_4", "route_d_a__b_1_1", "route_d_a__b_1_3"), roads, "b skipped n = 1");
	}

	@Test
	void eachRenumberedRouteFoldsOnlyItsOwnPiecesInOrder() throws Exception {
		for (boolean reversed : new boolean[] {false, true}) {
			Map<String, PartShape> m = shapes(reversed, false);
			assertEquals(Set.of("route_d_a__b", "route_d_a__b_1"), m.keySet(), "one route per edge, no road listed alone (reversed=" + reversed + ")");
			assertEquals("route", m.get("route_d_a__b").kind());
			assertEquals(List.of(new BlockPos(8, 65, 8), new BlockPos(8, 64, 8), new BlockPos(45, 64, 8), new BlockPos(48, 64, 8), new BlockPos(51, 70, 8),
				new BlockPos(88, 70, 8), new BlockPos(88, 71, 8)), m.get("route_d_a__b").ends(), "b: road 2, stair 3, road 4 (reversed=" + reversed + ")");
			assertEquals(List.of(new BlockPos(8, 65, 30), new BlockPos(8, 64, 30), new BlockPos(45, 64, 30), new BlockPos(48, 64, 30), new BlockPos(51, 70, 30),
				new BlockPos(88, 70, 30), new BlockPos(88, 71, 30)), m.get("route_d_a__b_1").ends(), "b_1: its own 1, 2, 3, none of b's (reversed=" + reversed + ")");
		}
	}

	@Test
	void untaggedTheSameIrLosesNoRoad() throws Exception {
		// (an IR without tags reads as v0.83.0: every road piece listed alone as well as folded; none dropped)
		for (boolean reversed : new boolean[] {false, true}) {
			Map<String, PartShape> m = shapes(reversed, true);
			for (String rd : List.of("route_d_a__b_2", "route_d_a__b_4", "route_d_a__b_1_1", "route_d_a__b_1_3")) {
				assertEquals("route", m.get(rd).kind(), rd + " (reversed=" + reversed + ")");
			}
		}
	}
}
