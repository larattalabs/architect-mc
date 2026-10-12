package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 6c slice MP gate item 6 (schema drift): on the kit's 200 generated specs (kit/test/fixtures/mp/specs.json: masks and patterns,
 * valid and broken, each with the kit's verdict), {@link Mask#error} and {@link Pattern#error} give the same verdict, and a valid
 * spec makes a record while a broken one refuses FIELD_LIMIT. The kit's test keeps the fixture current.
 */
class MaskPatternDriftTest {
	@Test
	void javaAgreesWithTheKit() throws Exception {
		JsonObject f = JsonParser.parseString(Files.readString(Path.of("../kit/test/fixtures/mp/specs.json"))).getAsJsonObject();
		List<String> disagree = new ArrayList<>();
		int valid = 0;
		int n = 0;
		for (JsonElement e : f.getAsJsonArray("specs")) {
			JsonObject s = e.getAsJsonObject();
			String kind = s.get("kind").getAsString();
			JsonElement spec = s.get("spec");
			boolean kit = s.get("valid").getAsBoolean();
			String why = kind.equals("mask") ? Mask.error(spec) : Pattern.error(spec);
			boolean java = why == null;
			if (java != kit) {
				disagree.add(n + " " + kind + " " + spec + ": kit " + (kit ? "valid" : s.get("error").getAsString()) + ", java " + (java ? "valid" : why));
			}
			// the record and parse agree with error()
			boolean parsed;
			try {
				if (kind.equals("mask")) {
					Mask.parse(spec.toString());
				} else {
					Pattern.parse(spec.toString());
				}
				parsed = true;
			} catch (ArchitectRefused r) {
				assertEquals(Reason.FIELD_LIMIT, r.reason());
				parsed = false;
			}
			assertEquals(java, parsed, n + " " + spec);
			valid += kit ? 1 : 0;
			n++;
		}
		assertEquals(200, n);
		assertTrue(valid >= 90 && valid <= 110, valid + " valid");
		assertEquals(List.of(), disagree);
	}
}
