package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * (RTE4) kit/test/fixtures/rte4/land-irs.json, the IR kit/test/rte4.test.mjs reads, with the same numbers: districts {@code b} and
 * {@code b_street}, each district's roads tagged {@code architect_mc:district {id}}; b's street roads {@code b_street_w}, {@code b_street_e}
 * are b's (by id they read as b_street's, 1411 cells). Untagged (planned before RTE4) and malformed tags read by id, as before.
 */
class DistrictLandRte4Test {
	static final Path IRS = Path.of("../kit/test/fixtures/rte4/land-irs.json");

	private static JsonObject ir() throws Exception {
		return JsonParser.parseString(Files.readString(IRS)).getAsJsonObject().getAsJsonObject("bStreet");
	}

	/** The fixture with every district tag edited by {@code f}; an emptied ext is dropped, as rte4.test.mjs. */
	private static JsonObject retag(Consumer<JsonObject> f) throws Exception {
		JsonObject o = ir();
		for (JsonElement e : o.getAsJsonArray("roads")) {
			JsonObject r = e.getAsJsonObject();
			if (r.get("ext") instanceof JsonObject ex && ex.has(DistrictLand.DISTRICT_EXT)) {
				f.accept(ex);
				if (ex.size() == 0) {
					r.remove("ext");
				}
			}
		}
		return o;
	}

	private static Map<String, String> summary(JsonObject land) {
		Map<String, String> out = new TreeMap<>();
		for (JsonElement e : land.getAsJsonArray("parts")) {
			JsonObject p = e.getAsJsonObject();
			out.put(p.get("kind").getAsString() + ":" + p.get("id").getAsString(), p.get("cells").getAsString());
		}
		return out;
	}

	@Test
	void eachDistrictsRoadsByItsTag() throws Exception {
		assertEquals(Map.of("district:b", "408", "district:b_street", "408", "route:d_b__b_street", "185"), summary(DistrictLand.of(ir(), null, null)));
	}

	@Test
	void untaggedAndMalformedReadByIdAsBefore() throws Exception {
		Map<String, String> legacy = Map.of("district:b", "408", "district:b_street", "1411", "route:d_b__b_street", "185");
		assertEquals(legacy, summary(DistrictLand.of(retag(ex -> ex.remove(DistrictLand.DISTRICT_EXT)), null, null)));
		assertEquals(legacy, summary(DistrictLand.of(retag(ex -> {
			JsonObject t = new JsonObject();
			if ("b".equals(ex.getAsJsonObject(DistrictLand.DISTRICT_EXT).get("id").getAsString())) {
				t.addProperty("id", 17);
			} else {
				t.addProperty("id", false);
			}
			ex.add(DistrictLand.DISTRICT_EXT, t);
		}), null, null)));
	}

	@Test
	void aTagNamingNoDistrictIsNobodys() throws Exception {
		assertEquals(Map.of("district:b", "408", "district:b_street", "408", "route:d_b__b_street", "185"), summary(DistrictLand.of(retag(ex -> {
			JsonObject t = new JsonObject();
			t.addProperty("id", "c");
			ex.add(DistrictLand.DISTRICT_EXT, t);
		}), null, null)));
	}
}
