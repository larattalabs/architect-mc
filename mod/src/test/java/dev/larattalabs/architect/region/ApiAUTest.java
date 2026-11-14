package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.AuthorRequest;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (7c AU) Program authoring on the mod side: {@code programAuthoring} comes with the helper's {@code region.author}; the
 * {@code region.author} message (the owner, Style and round cap from the request's ext keys); a program design reads as
 * {@link Design.Kind#PROGRAM} (appended last); the world-local store: an AUTHORED result installs once, only when its bytes hash to its sha
 * (a lone surrogate, a wrong sha or a non-program id install nothing); a plan check sends the owner's named sources only; an approved
 * artifact's frozen programs re-hashed from the file: an edit or a removal is AUTHORED_STALE, naming the id.
 */
class ApiAUTest {
	@TempDir
	Path world;

	private static final String SRC = "import { region } from '../lib/region/program.mjs';\nexport const id = 'au_x';\nexport default function (ctx) { return region(ctx); }\n";

	private static JsonObject result(String source, String sha) {
		JsonObject o = new JsonObject();
		o.addProperty("outcome", "AUTHORED");
		o.addProperty("source", source);
		o.addProperty("sha", sha);
		o.addProperty("partId", "hall");
		return o;
	}

	private static String sha(String s) {
		return Packed.sha256(s.getBytes(StandardCharsets.UTF_8));
	}

	@Test
	void programAuthoringFollowsTheHelper() {
		assertEquals("region.author", Authors.FEATURE);
		assertTrue(ApiRules.features(2, List.of("job.run", "region.design", Authors.FEATURE)).contains("programAuthoring"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.compose")).contains("programAuthoring"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("programAuthoring"));
		assertEquals(Reason.values().length - 1, Reason.AUTHORED_STALE.ordinal(), "7cF's reason, still last");
	}

	@Test
	void theAuthorMessage() {
		JsonObject ext = new JsonObject();
		ext.addProperty(AuthorRequest.EXT_OWNER, "steward:s1");
		ext.addProperty(AuthorRequest.EXT_STYLE, "gothic");
		ext.addProperty(AuthorRequest.EXT_ROUNDS, 2);
		AuthorRequest r = new AuthorRequest("a sea stack monastery", new BoundingBox(0, 0, 10, 95, 0, 105), "p1", "hall", 3.0, "k.1", ext);
		JsonObject m = Authors.message(r, "k.1", -64, 319, "b1", "flat");
		assertEquals(JsonParser.parseString("{\"type\":\"region.author\",\"brief\":\"a sea stack monastery\",\"claim\":{\"minX\":0,\"minZ\":10,\"maxX\":95,"
			+ "\"maxZ\":105,\"minY\":-64,\"maxY\":319},\"surveyBlobId\":\"b1\",\"surveySummary\":\"flat\",\"style\":\"gothic\",\"planId\":\"p1\",\"partId\":\"hall\","
			+ "\"budgetUsd\":3.0,\"opKey\":\"k.1\",\"owner\":\"steward:s1\",\"ext\":{\"architect_mc:owner\":\"steward:s1\",\"architect_mc:style\":\"gothic\","
			+ "\"architect_mc:authorRounds\":2}}"), m);
		JsonObject bare = Authors.message(new AuthorRequest("b", new BoundingBox(0, 0, 0, 9, 0, 9), null, null, null, "k", null), null, -64, 319, "b2", "");
		assertFalse(bare.has("owner") || bare.has("style") || bare.has("planId") || bare.has("ext") || bare.has("surveySummary"));
		assertNull(Authors.ownerOf(new AuthorRequest("b", new BoundingBox(0, 0, 0, 9, 0, 9), null, null, null, "k", null)));
	}

	@Test
	void aProgramDesignIsKindProgram() {
		JsonObject req = new JsonObject();
		req.addProperty("kind", "program");
		Design d = new Design("d7", Design.Status.DONE, "", Optional.empty(), Cost.NONE, Optional.empty(), req, Optional.empty(), 0, 0);
		assertEquals(Design.Kind.PROGRAM, d.kind());
		assertEquals(Design.Kind.values().length - 1, Design.Kind.PROGRAM.ordinal(), "appended last");
		assertEquals(Design.Kind.SETTLEMENT.ordinal() + 1, Design.Kind.PROGRAM.ordinal());
	}

	@Test
	void anAuthoredResultInstallsOnceWhenItsBytesHashToItsSha() throws Exception {
		assertEquals("the source hashes to " + sha(SRC).substring(0, 12) + ", not the result's 000000000000", Authors.install(world, "d7", result(SRC, "0".repeat(64)),
			"o", null));
		assertFalse(Files.exists(Authors.dir(world).resolve("d7.mjs")));
		String lone = SRC + "// \uD800\n";
		assertEquals("the source has a lone UTF-16 surrogate", Authors.install(world, "d7", result(lone, sha(SRC)), "o", null));
		assertNotNull(Authors.install(world, "D7", result(SRC, sha(SRC)), "o", null), "not a program id");
		assertNull(Authors.install(world, "d7", result(SRC, sha(SRC)), "o", null));
		assertArrayEquals(SRC.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(Authors.dir(world).resolve("d7.mjs")));
		JsonObject rec = Authors.record(world, "d7");
		assertEquals(sha(SRC), rec.get("sha").getAsString());
		assertEquals("o", rec.get("owner").getAsString());
		assertEquals("hall", rec.get("partId").getAsString());
		// a second install of the same id leaves the first
		assertNull(Authors.install(world, "d7", result(SRC + "\n", sha(SRC + "\n")), "o", null));
		assertArrayEquals(SRC.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(Authors.dir(world).resolve("d7.mjs")));
		assertTrue(Authors.wellFormed("a😀b"));
		assertFalse(Authors.wellFormed("a\uDE00"));
	}

	@Test
	void aCheckSendsTheOwnersNamedSourcesOnly() throws Exception {
		Authors.install(world, "d7", result(SRC, sha(SRC)), "o", null);
		Authors.install(world, "d8", result(SRC, sha(SRC)), null, null);
		JsonObject plan = JsonParser.parseString("{\"schemaVersion\":\"plan/0\",\"zones\":[{\"id\":\"a\",\"program\":{\"template\":\"authored\",\"params\":{\"id\":\"d7\","
			+ "\"sha\":\"x\"}}},{\"id\":\"b\",\"program\":{\"template\":\"authored\",\"params\":{\"id\":\"d8\",\"sha\":\"x\"}}},{\"id\":\"c\",\"program\":{\"template\":\"authored\","
			+ "\"params\":{\"id\":\"../etc\",\"sha\":\"x\"}}},{\"id\":\"d\",\"program\":{\"template\":\"crater_works\"}}]}").getAsJsonObject();
		assertEquals(List.of("d7", "d8"), Authors.named(plan));
		assertEquals(List.of("d7"), List.copyOf(Authors.sourcesFor(world, plan, "o").keySet()));
		assertEquals(SRC, Authors.sourcesFor(world, plan, "o").getAsJsonObject("d7").get("source").getAsString());
		assertEquals(List.of("d8"), List.copyOf(Authors.sourcesFor(world, plan, null).keySet()));
		assertEquals(0, Authors.sourcesFor(world, plan, "someone").size());
	}

	@Test
	void anApprovedArtifactsProgramsAreReHashedFromTheFile() throws Exception {
		Authors.install(world, "d7", result(SRC, sha(SRC)), "o", null);
		JsonObject body = JsonParser.parseString("{\"authored\":[{\"part\":\"hall\",\"id\":\"d7\",\"sha\":\"" + sha(SRC) + "\"}]}").getAsJsonObject();
		assertNull(Authors.stale(world, body));
		assertNull(Authors.stale(world, new JsonObject()), "an artifact with no authored program");
		Files.writeString(Authors.dir(world).resolve("d7.mjs"), SRC.replace("au_x", "au_y"));
		String[] st = Authors.stale(world, body);
		assertEquals("d7", st[0]);
		assertTrue(st[1].contains("not the approved " + sha(SRC).substring(0, 12)), st[1]);
		Files.delete(Authors.dir(world).resolve("d7.mjs"));
		assertEquals("authored program d7 is not installed", Authors.stale(world, body)[1]);
	}
}
