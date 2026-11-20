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
 * (RTE2) District ownership from records, not id prefixes: kit/test/fixtures/rte2/land-irs.json, the IRs kit/test/rte2.test.mjs reads, with
 * the same numbers. District b never absorbs district b_1's parts, lots, roads or street; a join road's long groups are the join's.
 */
class DistrictLandRte2Test {
	static final Path IRS = Path.of("../kit/test/fixtures/rte2/land-irs.json");

	private static JsonObject ir(String name) throws Exception {
		return JsonParser.parseString(Files.readString(IRS)).getAsJsonObject().getAsJsonObject(name);
	}

	/** {@code kind:id} -> cells (a join's or a grown part's: "cells district"), as rte2.test.mjs's summary. */
	private static Map<String, String> summary(JsonObject land) {
		Map<String, String> out = new TreeMap<>();
		for (JsonElement e : land.getAsJsonArray("parts")) {
			JsonObject p = e.getAsJsonObject();
			String kind = p.get("kind").getAsString();
			String v = p.get("cells").getAsString();
			if ("join".equals(kind) || "grown".equals(kind)) {
				v += " " + (p.get("district").isJsonNull() ? "null" : p.get("district").getAsString());
			}
			out.put(kind + ":" + p.get("id").getAsString(), v);
		}
		return out;
	}

	@Test
	void taggedEachDistrictGetsOnlyItsOwn() throws Exception {
		assertEquals(Map.of("district:a", "25", "district:b", "9", "district:b_1", "18", "join:join", "12 b_1"), summary(DistrictLand.of(ir("tagged"), null, null)));
	}

	@Test
	void untaggedByTheLongestDistrictId() throws Exception {
		assertEquals(Map.of("district:a", "25", "district:b", "3", "district:b_1", "24", "join:join", "12 b_1"), summary(DistrictLand.of(ir("untagged"), null, null)));
	}

	@Test
	void aGrownPartIsItsLongestDistrictsAlone() throws Exception {
		Map<String, String> s = summary(DistrictLand.of(ir("grown"), null, null, true));
		assertEquals("1 b_1", s.get("grown:rv1"));
		assertEquals("9", s.get("district:b"));
	}
}
