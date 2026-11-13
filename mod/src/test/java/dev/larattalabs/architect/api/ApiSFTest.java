package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.apiimpl.Wire5a;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** Since NEXT (docs/CONTRACT.md "Phase 7c" §3 row 4, slice SF): Style format 3's feature and its restraint read as format 2's. */
class ApiSFTest {
	@Test
	void styleFormat3AdvertisedOnlyWithTheHelpersFeature() {
		Set<String> on = ApiRules.features(2, List.of("job.run", "bible.format3"));
		assertTrue(on.contains("styleFormat3"));
		assertFalse(on.contains("bible.format3"), "the sidecar name maps to the stable one");
		assertFalse(ApiRules.features(2, List.of("job.run")).contains("styleFormat3"));
		assertFalse(ApiRules.features(1, List.of("bible.format3")).contains("styleFormat3"), "protocol 1 advertises no sidecar feature");
		assertFalse(ApiRules.JAVA_FEATURES.contains("styleFormat3"));
	}

	@Test
	void format3RestraintIsFormat2s() {
		String body = "\"motifs\": [\"a\", \"b\", \"c\", \"d\"], \"restraint\": {\"heroMotifs\": [\"d\"], \"accentShareMax\": 0.06, \"detailDensity\": \"sparse\", "
			+ "\"windowsPerFacadeMin\": 3}";
		Bible.Restraint two = Wire5a.restraintOf(JsonParser.parseString("{\"format\": 2, " + body + "}").getAsJsonObject());
		Bible.Restraint three = Wire5a.restraintOf(JsonParser.parseString("{\"format\": 3, \"settlement\": {\"density\": \"low\"}, " + body + "}")
			.getAsJsonObject());
		assertEquals(two, three);
		assertEquals(List.of("d"), three.heroMotifs());
		assertEquals("sparse", three.detailDensity());
		// format 1 still ignores a restraint member
		Bible.Restraint one = Wire5a.restraintOf(JsonParser.parseString("{" + body + "}").getAsJsonObject());
		assertEquals(List.of("a", "b", "c"), one.heroMotifs());
	}
}
