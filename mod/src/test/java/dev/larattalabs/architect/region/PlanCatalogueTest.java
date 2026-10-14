package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Regions;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * (C38) {@code Regions.planCatalogue()} (docs/CONTRACT.md "C38 as built"): the catalogue read from the mod jar equals, entry for entry,
 * the one the kit stamps on every plan check ({@code planCatalogue()} in kit/lib/plan/catalogue.mjs, run here with node and compared
 * with the committed golden), is a defensive copy, needs no sidecar, server, claim or chunk, and is a Java feature.
 */
class PlanCatalogueTest {
	private static final Path KIT = Path.of("..", "kit");

	private static JsonObject json(Path p) throws Exception {
		return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
	}

	@Test
	void equalsTheGolden() throws Exception {
		// the golden is regenerated with each release (kit test "item 9"); this is the mod's half of "the two can never differ"
		JsonObject golden = json(KIT.resolve("schemas").resolve("plan-catalogue.golden.json"));
		assertEquals(golden, PlanCatalogue.get());
		assertEquals(ArchitectApi.VERSION, golden.get("api").getAsString());
		assertEquals(IrStale.KIT_VERSION, golden.get("kitVersion").getAsString());
	}

	@Test
	void equalsTheKitsPlanCatalogueEntryForEntry() throws Exception {
		Process p;
		try {
			p = new ProcessBuilder("node", "--input-type=module", "-e",
				"import { planCatalogue } from '" + KIT.toAbsolutePath().normalize().resolve("lib/plan/catalogue.mjs").toUri() + "'; process.stdout.write(JSON.stringify(planCatalogue()));")
				.redirectErrorStream(true).start();
		} catch (java.io.IOException e) {
			Assumptions.abort("node is not on the PATH: " + e.getMessage());
			return;
		}
		String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
		assertTrue(p.waitFor(60, TimeUnit.SECONDS) && p.exitValue() == 0, out);
		JsonObject kit = JsonParser.parseString(out).getAsJsonObject();
		JsonObject mod = PlanCatalogue.get();
		for (String k : new String[] {"catalogueVersion", "api", "kitVersion", "schemaVersion"}) {
			assertEquals(kit.get(k), mod.get(k), k);
		}
		JsonArray ke = kit.getAsJsonArray("entries"), me = mod.getAsJsonArray("entries");
		assertEquals(ke.size(), me.size(), "entry count");
		for (int i = 0; i < ke.size(); i++) {
			assertEquals(ke.get(i), me.get(i), "entry " + i + " " + ke.get(i).getAsJsonObject().get("id"));
		}
		assertEquals(kit, mod);
	}

	@Test
	void bundledSchemaIsTheKitsSchema() throws Exception {
		// the build copies kit/schemas/plan.json to /architect_mc/schemas/plan.json (mod/build.gradle); the test classpath has that resource
		try (var in = PlanCatalogue.class.getResourceAsStream("/architect_mc/schemas/plan.json")) {
			Assumptions.assumeTrue(in != null, "the bundled plan.json is on the test classpath");
			assertEquals(json(KIT.resolve("schemas").resolve("plan.json")), JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)));
		}
	}

	@Test
	void shape() {
		JsonObject c = PlanCatalogue.get();
		assertEquals("plan/0", c.get("schemaVersion").getAsString());
		assertTrue(c.get("catalogueVersion").getAsInt() >= 4);
		JsonArray e = c.getAsJsonArray("entries");
		assertTrue(e.size() > 40, "entries: " + e.size());
		java.util.Set<String> ids = new java.util.HashSet<>();
		for (var el : e) {
			JsonObject o = el.getAsJsonObject();
			for (String k : new String[] {"id", "state", "sinceApi", "schemaVersion"}) {
				assertTrue(o.has(k), o + " lacks " + k);
			}
			assertTrue(ids.add(o.get("id").getAsString()), "duplicate id " + o.get("id"));
			assertFalse(o.has("def") || o.has("draft"), "schema-only members are not part of an answer: " + o);
		}
		assertTrue(ids.contains("connector.wall"), "connector.wall is in the catalogue (reserved until K1)");
	}

	@Test
	void everyCallIsADefensiveCopy() {
		JsonObject a = PlanCatalogue.get();
		JsonObject b = PlanCatalogue.get();
		assertEquals(a, b);
		assertNotSame(a, b);
		a.addProperty("scribble", 1);
		a.getAsJsonArray("entries").get(0).getAsJsonObject().addProperty("state", "retired");
		a.getAsJsonArray("entries").remove(1);
		JsonObject c = PlanCatalogue.get();
		assertEquals(b, c, "changing a returned catalogue changes nothing");
		assertFalse(c.has("scribble"));
	}

	@Test
	void needsNoServerNoClaimNoSidecar() throws Exception {
		// a bare JVM: no Minecraft server, no sidecar, no chunk; another thread gets the same
		JsonObject[] other = new JsonObject[1];
		Thread t = new Thread(() -> other[0] = PlanCatalogue.get(), "not-the-server-thread");
		t.start();
		t.join();
		assertEquals(PlanCatalogue.get(), other[0]);
	}

	@Test
	void theApiMethodAndTheFeature() throws Exception {
		assertTrue(ApiRules.JAVA_FEATURES.contains("planCatalogueView"));
		assertTrue(ApiRules.features(1, java.util.List.of()).contains("planCatalogueView"), "present without a helper too");
		String[] v = ArchitectApi.VERSION.split("\\.");
		assertTrue(Integer.parseInt(v[0]) == 1 && Integer.parseInt(v[1]) >= 31, ArchitectApi.VERSION);
		// additive: a default that throws on an older implementation, overridden by the mod's
		assertTrue(Regions.class.getMethod("planCatalogue").isDefault());
		assertEquals(RegionsImpl.class, RegionsImpl.class.getMethod("planCatalogue").getDeclaringClass());
	}
}
