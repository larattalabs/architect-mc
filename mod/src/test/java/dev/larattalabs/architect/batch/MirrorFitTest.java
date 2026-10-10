package dev.larattalabs.architect.batch;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Slice 0b gate item 2 (the fit half): a mirrored copy's lot fit agrees with its archetype's massing mirrored with it (C6's
 * prediction: the same rotation, the origin within +-2 in x and z, equal in y), on 4 street sides x 3 lot sizes, for every kit
 * example (kit/test/fixtures/mirror-fit.json, written by kit/tools/mirror-fit-fixture.mjs from the copy stage's own recipe).
 * fitToLot and fitMassingToLot both run {@link LotFitting#fit} on these inputs.
 */
class MirrorFitTest {
	@Test
	void mirroredCopyFitsLikeItsMirroredMassing() throws Exception {
		JsonObject f = JsonParser.parseString(Files.readString(Path.of("../kit/test/fixtures/mirror-fit.json"))).getAsJsonObject();
		List<String> bad = new ArrayList<>();
		int n = 0;
		for (JsonElement e : f.getAsJsonArray("pairs")) {
			JsonObject p = e.getAsJsonObject();
			for (String side : new String[] {"north", "east", "south", "west"}) {
				for (int s : new int[] {24, 30, 40}) {
					Anchors.Bounds lot = new Anchors.Bounds(100, 64, 200, 100 + s - 1, 64, 200 + s - 1);
					LotFitting.Fit d = fit(p.getAsJsonObject("detail"), lot, side);
					LotFitting.Fit m = fit(p.getAsJsonObject("massing"), lot, side);
					n++;
					if (d.turns() != m.turns() || Math.abs(d.box().minX() - m.box().minX()) > 2 || Math.abs(d.box().minZ() - m.box().minZ()) > 2 || d.box().minY() != m
						.box().minY()) {
						bad.add(p.get("id").getAsString() + " " + p.get("label").getAsString() + " " + side + " " + s + ": detail " + d.turns() + "@" + d.box()
							.minX() + "," + d.box().minY() + "," + d.box().minZ() + " massing " + m.turns() + "@" + m.box().minX() + "," + m.box().minY() + "," + m.box()
							.minZ());
					}
				}
			}
		}
		assertTrue(n >= 4 * 3 * 8, "pairs: " + n);
		assertEquals(List.of(), bad);
	}

	private static LotFitting.Fit fit(JsonObject o, Anchors.Bounds lot, String side) {
		JsonArray size = o.getAsJsonArray("size");
		boolean has = o.has("entrance") && o.get("entrance").isJsonArray();
		double ex = has ? o.getAsJsonArray("entrance").get(0).getAsDouble() : 0;
		double ez = has ? o.getAsJsonArray("entrance").get(1).getAsDouble() : 0;
		return LotFitting.fit(size.get(0).getAsInt(), size.get(1).getAsInt(), size.get(2).getAsInt(), o.get("front").getAsString(), ex, ez, has, o.get(
			"groundY").getAsInt(), o.get("approach").getAsInt(), lot, side, false, null, false);
	}
}
