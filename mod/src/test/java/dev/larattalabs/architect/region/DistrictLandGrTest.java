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
 * (6d GR §7) {@code architect_mc:land} v 2: {@link DistrictLand#of} equals the kit's districtLand on the parity fixture
 * (kit/test/fixtures/gr/land.json: a beside district and an outpost, each grown by a revision): grown (the effective IR), undone (the base
 * IR with {@code revised}: v 2, the grown part gone) and never revised (v 1, as D3's).
 */
class DistrictLandGrTest {
	static final Path FIXTURE = Path.of("../kit/test/fixtures/gr/land.json");

	@Test
	void landV2EqualsTheKits() throws Exception {
		JsonArray cases = JsonParser.parseString(Files.readString(FIXTURE)).getAsJsonObject().getAsJsonArray("cases");
		assertTrue(cases.size() >= 2);
		for (JsonElement e : cases) {
			JsonObject c = e.getAsJsonObject();
			String name = c.get("name").getAsString();
			JsonArray tc = c.getAsJsonArray("townClaim");
			int[] town = {tc.get(0).getAsInt(), tc.get(1).getAsInt(), tc.get(2).getAsInt(), tc.get(3).getAsInt()};
			assertEquals(c.getAsJsonObject("land"), DistrictLand.of(c.getAsJsonObject("effective"), town, null, false), name + ": grown");
			assertEquals(c.getAsJsonObject("land"), DistrictLand.of(c.getAsJsonObject("effective"), town, null, true), name + ": grown, revised");
			assertEquals(c.getAsJsonObject("landUndone"), DistrictLand.of(c.getAsJsonObject("base"), town, null, true), name + ": undone");
			assertEquals(c.getAsJsonObject("landBase"), DistrictLand.of(c.getAsJsonObject("base"), town, null), name + ": never revised");
			assertEquals(2, c.getAsJsonObject("land").get("v").getAsInt());
		}
	}
}
