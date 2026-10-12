package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Slice MP's API (docs/CONTRACT.md phase 6c slice MP; 1.16.0, shipped with F1): the {@link Mask} and {@link Pattern} records validate with the kit's own
 * bundled schemas, a bad spec refuses FIELD_LIMIT with its path, no Reason is added, the features come from the helper, and the
 * mod knows the IR kinds {@code mask} and {@code pattern}.
 */
class ApiMPTest {
	@Test
	void version() {
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 16, ArchitectApi.VERSION);
	}

	@Test
	void masksParse() {
		String text = "{\"all\":[{\"block\":[\"#minecraft:dirt\",\"minecraft:grass_block\"]},{\"height\":[60,90]},{\"slope\":[0,2]},{\"depth\":[0,3]},"
			+ "{\"field\":\"wet\",\"gte\":170},{\"not\":{\"noise\":{\"kind\":\"simplex\",\"dims\":2,\"scale\":32,\"octaves\":1,\"seed\":\"0123456789abcdef\"},\"gte\":0.6}},"
			+ "{\"class\":[\"ROCK\",\"SOIL\"]}]}";
		Mask m = Mask.parse(text);
		assertEquals(JsonParser.parseString(text), m.spec());
		assertEquals(m, Mask.parse(m.toText()), "toText round-trips");
		JsonObject copy = m.spec();
		copy.addProperty("x", 1);
		assertFalse(m.spec().has("x"), "the record keeps its own copy");
		assertNotSame(m.spec(), m.spec());
	}

	@Test
	void badMasksRefuseFieldLimitWithThePath() {
		for (String[] c : new String[][] {
			{"{\"slope\":[3,1]}", "mask.slope: [a, b] needs a <= b"},
			{"{\"all\":[{\"height\":[1,2]},{\"foo\":1}]}", "mask.all[1]"},
			{"{\"height\":[1.5,3]}", "mask.height[0]: expected integer, got number"},
			{"{\"field\":\"wet\",\"gte\":5,\"lt\":5}", "mask: gte must be under lt"},
			{"{\"class\":[\"GRANITE\"]}", "mask.class[0]: must be one of"},
			{"{\"not\":{\"not\":{\"not\":{\"not\":{\"not\":{\"not\":{\"not\":{\"not\":{\"height\":[0,1]}}}}}}}}}", "nested more than 8 deep"},
			{"[1]", "mask: a mask is a JSON object"},
			{"{", "mask: not JSON"}}) {
			ArchitectRefused e = assertThrows(ArchitectRefused.class, () -> Mask.parse(c[0]), c[0]);
			assertEquals(Reason.FIELD_LIMIT, e.reason());
			assertTrue(e.getMessage().contains(c[1]), e.getMessage());
		}
		assertThrows(ArchitectRefused.class, () -> new Mask(new JsonObject()));
	}

	@Test
	void patternsParse() {
		Pattern p = Pattern.parse("{\"mix\":[{\"w\":6,\"mat\":\"stone\"},{\"w\":3,\"mat\":\"andesite\"},{\"w\":1,\"mat\":\"cobblestone\"}],\"seedLabel\":\"wall\"}");
		assertEquals(3, p.spec().getAsJsonArray("mix").size());
		Pattern g = Pattern.parse("{\"gradient\":{\"by\":{\"field\":\"wet\"},\"stops\":[{\"at\":60,\"mat\":\"minecraft:sand\"},{\"at\":64,\"mat\":null}]},\"dither\":\"ordered4\"}");
		assertEquals(g, Pattern.parse(g.toText()));
		for (String[] c : new String[][] {
			{"{\"gradient\":{\"by\":\"y\",\"stops\":[{\"at\":64,\"mat\":\"grass_block\"},{\"at\":60,\"mat\":\"sand\"}]}}", "pattern.gradient.stops[1].at must be over the stop before it"},
			{"{\"mix\":[{\"w\":0,\"mat\":\"stone\"}]}", "pattern.mix[0].w: under 1"},
			{"{\"mix\":[]}", "pattern.mix: fewer than 1 items"},
			{"{\"gradient\":{\"by\":\"x\",\"stops\":[{\"at\":1,\"mat\":\"sand\"},{\"at\":2,\"mat\":\"stone\"}]}}", "pattern.gradient.by"}}) {
			ArchitectRefused e = assertThrows(ArchitectRefused.class, () -> Pattern.parse(c[0]), c[0]);
			assertEquals(Reason.FIELD_LIMIT, e.reason());
			assertTrue(e.getMessage().contains(c[1]), e.getMessage());
		}
	}

	@Test
	void noNewReason() {
		Reason[] r = Reason.values();
		assertEquals(Reason.FIELD_LIMIT, r[r.length - 1]);
	}

	@Test
	void featuresComeFromTheHelper() {
		Set<String> off = ApiRules.features(1, List.of());
		assertFalse(off.contains("masks") || off.contains("patterns"));
		Set<String> on = ApiRules.features(2, List.of("masks", "patterns"));
		assertTrue(on.contains("masks") && on.contains("patterns"), on.toString());
	}

	@Test
	void irKindsAndKitVersion() {
		assertTrue(IrStale.KINDS_FORMAT2.contains("mask") && IrStale.KINDS_FORMAT2.contains("pattern"));
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.19.0") >= 0, IrStale.KIT_VERSION);
	}

	/** The bundled schemas are the kit's files, byte for byte. */
	@Test
	void bundledSchemasAreTheKits() throws Exception {
		for (String n : new String[] {"mask", "pattern"}) {
			try (InputStream in = Mask.class.getResourceAsStream("/architect_mc/schemas/" + n + ".json")) {
				assertTrue(in != null, n);
				assertEquals(Files.readString(Path.of("../kit/schemas/" + n + ".json")), new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8), n);
			}
		}
	}
}
