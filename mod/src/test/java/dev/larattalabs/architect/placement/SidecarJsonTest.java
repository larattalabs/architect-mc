package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.Site;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The library sidecar (docs/CONTRACT.md "Sidecar") and the sites file. */
class SidecarJsonTest {
	/** The contract's example sidecar. */
	static final String SIDECAR = """
		{
		  "id": "gen_lakeside_cabin",
		  "name": "Lakeside Cabin",
		  "description": "A one-room log cabin with a porch and a stone chimney.",
		  "type": "cabin",
		  "tags": ["rustic", "small"],
		  "size": { "x": 11, "y": 9, "z": 13 },
		  "groundY": 1,
		  "front": "south",
		  "materials": ["minecraft:spruce_log", "minecraft:cobblestone"],
		  "foundationBlock": "minecraft:cobblestone",
		  "approach": { "length": 4, "width": 3, "block": "minecraft:dirt_path", "slab": "minecraft:cobblestone_slab" },
		  "interior": { "minX": 1, "minY": 1, "minZ": 1, "maxX": 9, "maxY": 6, "maxZ": 11 },
		  "anchors": {
		    "entrance": { "x": 5.5, "y": 1.0, "z": 12.5, "yaw": 0.0, "pitch": 0.0 },
		    "spawn":    { "x": 5.5, "y": 1.0, "z": 14.5, "yaw": 180.0, "pitch": 0.0 },
		    "cam_overview": { "x": -6.0, "y": 10.0, "z": 22.0, "yaw": -140.0, "pitch": 25.0 }
		  },
		  "source": "gen_lakeside_cabin.mjs",
		  "createdAt": 1759600000000,
		  "request": { "type": "cabin", "style": "rustic" }
		}
		""";

	static Blueprint sidecar() {
		return Blueprint.fromJson(JsonParser.parseString(SIDECAR).getAsJsonObject());
	}

	@Test
	void contractExampleParses() {
		Blueprint bp = sidecar();
		assertEquals("gen_lakeside_cabin", bp.id());
		assertEquals("cabin", bp.type());
		assertEquals(List.of("rustic", "small"), bp.tags());
		assertEquals(11, bp.sizeX());
		assertEquals(9, bp.sizeY());
		assertEquals(13, bp.sizeZ());
		assertEquals(1, bp.groundY());
		assertEquals("south", bp.front());
		assertEquals("minecraft:cobblestone", bp.foundationBlock());
		assertEquals(4, bp.approach().length());
		assertEquals("minecraft:cobblestone_slab", bp.approach().slab());
		assertEquals(new Anchors.Bounds(1, 1, 1, 9, 6, 11), bp.interior());
		assertEquals(List.of("entrance", "spawn", "cam_overview"), List.copyOf(bp.anchors().keySet()));
		assertEquals("gen_lakeside_cabin.mjs", bp.source());
		assertEquals(1759600000000L, bp.createdAt());
		assertNotNull(bp.request());
		// the camera may stand outside the template; nothing else is missing
		assertEquals(List.of(), bp.warnings());
	}

	@Test
	void roundTripAndDefaults() {
		Blueprint bp = sidecar();
		assertEquals(bp.toJson(), Blueprint.fromJson(bp.toJson()).toJson());
		JsonObject min = JsonParser.parseString("{\"id\":\"hut\",\"size\":{\"x\":5,\"y\":4,\"z\":5}}").getAsJsonObject();
		Blueprint m = Blueprint.fromJson(min);
		assertEquals("custom", m.type());
		assertEquals("south", m.front());
		assertEquals(Blueprint.DEFAULT_FOUNDATION, m.foundationBlock());
		assertNull(m.interior());
		assertNull(m.request());
		assertTrue(m.warnings().contains("missing anchor entrance"));
		assertTrue(m.warnings().contains("missing anchor spawn"));
		// an unknown type reads as custom; an AgentCraft-style "materials" string is kept as one entry
		min.addProperty("type", "castle");
		min.addProperty("materials", "vanilla");
		assertEquals("custom", Blueprint.fromJson(min).type());
		assertEquals(List.of("vanilla"), Blueprint.fromJson(min).materials());
	}

	@Test
	void brokenSidecarsAreRejected() {
		for (String bad : List.of("{\"size\":{\"x\":1,\"y\":1,\"z\":1}}", "{\"id\":\"Bad Id\",\"size\":{\"x\":1,\"y\":1,\"z\":1}}",
			"{\"id\":\"a\"}", "{\"id\":\"a\",\"size\":{\"x\":0,\"y\":1,\"z\":1}}", "{\"id\":\"a\",\"size\":{\"x\":3,\"y\":3,\"z\":3},\"front\":\"up\"}",
			"{\"id\":\"a\",\"size\":{\"x\":3,\"y\":3,\"z\":3},\"groundY\":3}")) {
			assertThrows(IllegalArgumentException.class, () -> Blueprint.fromJson(JsonParser.parseString(bad).getAsJsonObject()), bad);
		}
	}

	@Test
	void placedAnchorsFollowTheRotation() {
		Blueprint bp = sidecar();
		Map<String, Anchor> w = BlueprintTransform.worldAnchors(bp, 2, 100, 64, -40);
		// 180: (x, z) -> (sx - x, sz - z); the entrance (5.5, 12.5) faces north now
		Anchor e = w.get("entrance");
		assertEquals(100 + 11 - 5.5, e.x(), 1e-9);
		assertEquals(65.0, e.y(), 1e-9);
		assertEquals(-40 + 13 - 12.5, e.z(), 1e-9);
		assertEquals(180f, e.yaw(), 1e-4);
		assertEquals(new Anchors.Bounds(101, 65, -39, 109, 70, -29), BlueprintTransform.worldBounds(bp, 2, 100, 64, -40));
	}

	@Test
	void sitesFileRoundTrip() {
		Anchors.Bounds box = new Anchors.Bounds(100, 64, -40, 110, 72, -28);
		Anchors.Bounds snap = new Anchors.Bounds(100, 60, -40, 110, 72, -22);
		Site s = new Site("s3", "gen_lakeside_cabin", "clockwise_180", box, box, BlueprintTransform.worldAnchors(sidecar(), 2, 100, 64, -40),
			1759600000000L, "minecraft:overworld", snap, "s3-1759600000000.nbt", new Site.Location(0, 64, 0, "none", "minecraft:overworld"),
			new Site.Pin("abc123", List.of(1, 2, 3)));
		Site.Pending gone = new Site.Pending(new Site("s1", "hut", "none", box, box, Map.of(), 1L, "minecraft:overworld", null, "s1-1.nbt", null, null),
			5L, "removed");
		JsonObject file = Site.fileJson(List.of(s), 4, List.of(gone));
		Site.FileData back = Site.fileFromJson(JsonParser.parseString(file.toString()).getAsJsonObject());
		assertEquals(List.of(s), back.sites());
		assertEquals(List.of(gone), back.pending());
		assertEquals(4, back.next());
		assertEquals(snap, back.sites().get(0).restoreBox());
		assertEquals(box, back.pending().get(0).site().restoreBox());
		// next never goes below an id in the file
		assertEquals(4, Site.fileFromJson(JsonParser.parseString("{\"next\":1,\"sites\":[" + s.toJson() + "]}").getAsJsonObject()).next());
		assertEquals(0, Site.idNumber("b3"));
	}

	@Test
	void boxesIntersect() {
		Anchors.Bounds a = new Anchors.Bounds(0, 0, 0, 4, 4, 4);
		assertTrue(Anchors.intersects(a, new Anchors.Bounds(4, 4, 4, 9, 9, 9)));
		assertTrue(!Anchors.intersects(a, new Anchors.Bounds(5, 0, 0, 9, 4, 4)));
		assertEquals(new Anchors.Bounds(-1, -1, -1, 5, 5, 5), a.grow(1));
		assertEquals(125, a.volume());
	}
}
