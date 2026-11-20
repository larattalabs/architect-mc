package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/**
 * (RTE3, the v0.87.0 review's P2 and P3) kit/test/fixtures/rte3/land-irs.json, the IRs kit/test/rte3.test.mjs reads, with the same
 * numbers: a grouped growth street's one band is one district part (was one per group); a malformed route tag (edge false, edge 17) reads
 * as untagged, as land.mjs (was taken as its text).
 */
class DistrictLandRte3Test {
	static final Path IRS = Path.of("../kit/test/fixtures/rte3/land-irs.json");

	private static JsonObject ir(String name) throws Exception {
		return JsonParser.parseString(Files.readString(IRS)).getAsJsonObject().getAsJsonObject(name);
	}

	/** {@code kind:id[@revision]} -> cells (a join's or a grown part's: "cells district"); a duplicate key gains a "+", as rte3.test.mjs. */
	private static Map<String, String> summary(JsonObject land) {
		Map<String, String> out = new TreeMap<>();
		for (JsonElement e : land.getAsJsonArray("parts")) {
			JsonObject p = e.getAsJsonObject();
			String kind = p.get("kind").getAsString();
			String v = p.get("cells").getAsString();
			if ("join".equals(kind) || "grown".equals(kind)) {
				v += " " + (p.get("district") == null || p.get("district").isJsonNull() ? "null" : p.get("district").getAsString());
			}
			int rev = p.get("revision") == null ? 0 : p.get("revision").getAsInt();
			String k = kind + ":" + p.get("id").getAsString() + (rev != 0 ? "@" + rev : "");
			while (out.containsKey(k)) {
				k += "+";
			}
			out.put(k, v);
		}
		return out;
	}

	@Test
	void aGroupedGrowthStreetsBandIsOneDistrictPart() throws Exception {
		assertEquals(Map.of("district:quay@1", "16", "grown:rv1@1", "311 quay"), summary(DistrictLand.of(ir("grownGrouped"), null, null, true)));
	}

	@Test
	void aMalformedRouteTagReadsAsUntagged() throws Exception {
		assertEquals(Map.of("district:a", "25", "district:b", "3", "district:b_1", "24", "join:join", "12 b_1"), summary(DistrictLand.of(ir("malformed"), null, null)));
	}
}
