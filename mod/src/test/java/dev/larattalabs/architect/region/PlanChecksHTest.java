package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (6c H §10, docs/CONTRACT.md "Phase 6c slice H"): the plan check's two-plan flow runs for a plan with an H part (a body form, a moat, a
 * quay, a farm pond) or one whose first plan took the wet fallback, as for a tunnel part; every other plan plans once. A fluid guard's
 * stale rule compares the classes and the fluid layer and names the body, its part and the cells.
 */
class PlanChecksHTest {
	private static JsonObject j(String json) {
		return JsonParser.parseString(json).getAsJsonObject();
	}

	@Test
	void hPartsAskForVolumes() {
		for (String k : List.of("pond", "fountain", "waterfall", "quay")) {
			assertTrue(PlanChecks.hasH(j("{\"forms\":[{\"id\":\"f\",\"kind\":\"" + k + "\"}]}")), k);
		}
		assertTrue(PlanChecks.hasH(j("{\"connectors\":[{\"id\":\"m\",\"kind\":\"channel\"}]}")));
		assertTrue(PlanChecks.hasH(j("{\"zones\":[{\"id\":\"z\",\"farmPond\":true,\"program\":{}}]}")));
		assertTrue(PlanChecks.hasH(j("{\"zones\":[{\"id\":\"z\",\"program\":{\"lots\":[{\"id\":\"a\",\"farmPond\":true}]}}]}")));
		assertFalse(PlanChecks.hasH(j("{\"forms\":[{\"id\":\"t\",\"kind\":\"terrace\"}],\"connectors\":[{\"id\":\"r\",\"kind\":\"road\"},{\"id\":\"b\",\"kind\":\"bridge\"}]}")));
		assertFalse(PlanChecks.hasH(j("{\"zones\":[{\"id\":\"z\",\"farmPond\":false,\"program\":{}}]}")));
		// (S-H-2) a farm pond has no part of its own: a lot of a district, and JSON however spaced
		assertTrue(PlanChecks.hasH(j("{\"zones\":[{\"id\":\"z\",\"program\":{\"districts\":[{\"id\":\"d\",\"lots\":[{\"id\":\"a\",\"farmPond\":true}]}]}}]}")));
		assertTrue(PlanChecks.hasH(j("{ \"zones\" : [ { \"id\" : \"z\", \"farmPond\" : true } ] }")));
		assertFalse(PlanChecks.hasH(j("{\"zones\":[{\"id\":\"z\",\"notes\":\"farmPond\\\":true\"}]}")), "a string is no farm pond");
		assertFalse(PlanChecks.hasH(j("{}")));
		assertTrue(PlanChecks.wetAsked(j("{\"planCheck\":{\"wetAsked\":true}}")));
		assertFalse(PlanChecks.wetAsked(j("{\"planCheck\":{}}")));
		assertFalse(PlanChecks.wetAsked(j("{}")));
	}

	/** A 1x3x1 volume: rock, water, air, with the fluid codes given. */
	private static Arvx.Decoded vol(int cls1, int f1) {
		int[] box = {0, 0, 0, 0, 2, 0};
		byte[] cells = {(byte) VoxelClass.ROCK.ordinal(), (byte) cls1, (byte) VoxelClass.AIR.ordinal()};
		int[] blocks = {1, cls1 == VoxelClass.WATER.ordinal() ? 2 : 0, 0};
		byte[] fluids = {0, (byte) f1, 0};
		return Arvx.decode(VolumeSurvey.encode(box, cells, Map.of(), new boolean[1], blocks, List.of(Arvx.AIR, "minecraft:stone", "minecraft:water"), fluids).raw());
	}

	@Test
	void waterGuards() {
		JsonArray runs = j("{\"r\":[0,0,0,2]}").getAsJsonArray("r");
		Arvx.Decoded src = vol(VoxelClass.WATER.ordinal(), 1);
		assertNull(PlanChecks.waterDiff("body pond of p", src, vol(VoxelClass.WATER.ordinal(), 1), runs));
		// a source turned flowing (a drained lake upstream): the same class, a new fluid code
		String m = PlanChecks.waterDiff("body pond of p", src, vol(VoxelClass.WATER.ordinal(), 2), runs);
		assertTrue(m != null && m.startsWith("body pond of p: the water it was checked against changed since the check, 1 cell: (0, 1, 0) WATER/water_source->WATER/water_flowing"), m);
		// a player's block in the lake
		m = PlanChecks.waterDiff("wet q of quay", src, vol(VoxelClass.PLAYER.ordinal(), 0), runs);
		assertTrue(m != null && m.contains("WATER/water_source->PLAYER"), m);
		// MISSING now is not judged
		assertNull(PlanChecks.waterDiff("x", src, vol(VoxelClass.MISSING.ordinal(), 0), runs));
		assertEquals(Arvx.VERSION_FLUIDS, VolumeSurvey.encode(new int[] {0, 0, 0, 0, 0, 0}, new byte[1], Map.of(), new boolean[1], new int[1], List.of(Arvx.AIR),
			new byte[1]).raw()[4]);
	}

	/** (housekeeping 3) a malformed guard is answered by name, never Gson's "Array must have size 1". */
	@Test
	void malformedGuards() {
		String vol = "\"volume\":{\"sha\":\"abc\",\"box\":[0,0,0,1,1,1]}";
		assertNull(PlanChecks.guardMalformed(0, j("{\"part\":\"t\"," + vol + ",\"runs\":[0,0,0,2,1,1,0,1]}")));
		assertNull(PlanChecks.guardMalformed(0, j("{\"part\":\"t\"," + vol + ",\"runs\":[]}")));
		// H RC3's shape: the farm pond's runs nested per column
		String m = PlanChecks.guardMalformed(2, j("{\"fluids\":true,\"kind\":\"farmPond\",\"body\":\"fp1\",\"part\":\"farm_1\"," + vol
			+ ",\"runs\":[[0,0,0,2],[1,1,0,1]]}"));
		assertTrue(m != null && m.startsWith("guard 2 (farmPond fp1 of farm_1): the artifact's guard is malformed (runs must be a flat array"), m);
		m = PlanChecks.guardMalformed(0, j("{\"part\":\"bore\"," + vol + ",\"runs\":[0,0,0,2,1]}"));
		assertTrue(m != null && m.contains("guard 0 (bore)") && m.contains("runs has 5 integers"), m);
		m = PlanChecks.guardMalformed(0, j("{\"part\":\"bore\"," + vol + ",\"runs\":[0,0,0.5,2]}"));
		assertTrue(m != null && m.contains("flat array of integers"), m);
		m = PlanChecks.guardMalformed(0, j("{\"part\":\"bore\"," + vol + "}"));
		assertTrue(m != null && m.contains("(no runs)"), m);
		m = PlanChecks.guardMalformed(0, j("{\"part\":\"bore\",\"volume\":{\"sha\":\"abc\",\"box\":[0,0,0]},\"runs\":[]}"));
		assertTrue(m != null && m.contains("box is not 6 integers"), m);
		m = PlanChecks.guardMalformed(0, j("{\"part\":\"bore\",\"runs\":[]}"));
		assertTrue(m != null && m.contains("(no volume)"), m);
		m = PlanChecks.guardMalformed(4, JsonParser.parseString("[1,2]"));
		assertTrue(m != null && m.startsWith("guard 4: the artifact's guard is malformed (not an object)"), m);
	}
}
