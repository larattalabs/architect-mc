package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/**
 * (7a GJ, §2, §5, §11 item 1) The mod's halves equal the kit's on the parity fixture (kit/test/fixtures/gj/parity.json, the kit's own
 * answers: kit/test/gj.test.mjs): {@link GateJoin#gates} equals besideGates on every wall (a C38 ring with an open gate, a double door,
 * a fence gate and a 1-wide gate), and {@link DistrictLand#of} equals districtLand on a district joined through a gate (its join's
 * junction the gate's `then`, its `via` the gate).
 */
class GateJoinTest {
	static final Path FIXTURE = Path.of("../kit/test/fixtures/gj/parity.json");

	static JsonObject fixture() throws Exception {
		return JsonParser.parseString(Files.readString(FIXTURE)).getAsJsonObject();
	}

	@Test
	void gatesEqualTheKits() throws Exception {
		JsonArray ws = fixture().getAsJsonArray("walls");
		assertTrue(ws.size() >= 4);
		java.util.Set<String> doors = new java.util.TreeSet<>();
		for (JsonElement e : ws) {
			JsonObject w = e.getAsJsonObject();
			JsonArray got = GateJoin.gates(w.get("id").getAsString(), w.getAsJsonObject("ir"));
			assertEquals(w.getAsJsonArray("gates"), got, w.get("name").getAsString());
			got.forEach(g -> doors.add(g.getAsJsonObject().get("door").getAsString() + "/" + g.getAsJsonObject().get("width").getAsInt()));
		}
		assertEquals(java.util.Set.of("none/3", "door/2", "fence_gate/3", "none/1"), doors);
	}

	@Test
	void landThroughAGateEqualsTheKits() throws Exception {
		for (JsonElement e : fixture().getAsJsonArray("districts")) {
			JsonObject d = e.getAsJsonObject();
			int[] tc = DistrictLandTest.arr(d.getAsJsonArray("townClaim"));
			JsonObject ir = d.getAsJsonObject("ir");
			assertEquals(d.getAsJsonObject("land"), DistrictLand.of(ir, tc, null), d.get("name").getAsString());
			assertEquals(d.getAsJsonObject("landRemoved"), DistrictLand.of(ir, tc, 1234567L), d.get("name").getAsString());
		}
	}

	@Test
	void doorKinds() {
		assertEquals("door", GateJoin.doorOf("minecraft:oak_door[facing=east,half=lower]"));
		assertEquals("fence_gate", GateJoin.doorOf("minecraft:spruce_fence_gate[open=false]"));
		assertEquals("none", GateJoin.doorOf(null));
		assertEquals("none", GateJoin.doorOf("minecraft:stone_bricks"));
	}
}
