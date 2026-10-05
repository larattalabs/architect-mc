package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Reskin;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Phase 4b wire forms and views (sidecar/README.md "Phase 4b", the exact shapes). */
class Wire4bTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	static final String GROUP = """
		{"id":"g3","name":"Ashfall hamlet","bible":{"id":"bib_ashfall","version":2},"owner":"steward_mc:set/1","ext":{"steward_mc:k":1},
		 "concurrency":3,"budgetUsd":5,"softBudgetFraction":0.8,"status":"paused_budget","reason":"soft budget: $4.10 of $5 spent",
		 "items":[{"itemKey":"lot_a","ext":{"steward_mc:lot":"A"},"designId":"d7","entryId":"gen_tower","status":"done","step":"done",
		           "cost":{"usd":1.2,"inputTokens":10,"outputTokens":20,"cacheReadTokens":30,"cacheWriteTokens":0,"turns":4},
		           "wave":0,"role":"landmark","model":"claude-opus-5-5","type":"tower","name":"Watch"},
		          {"itemKey":"lot_b","designId":"d8","status":"queued","step":"waiting","cost":{"usd":0},"wave":1,"role":"ordinary",
		           "model":"claude-sonnet-5-5","type":"hellish_lair","error":"x"}],
		 "designs":[{"id":"d7","status":"done","step":"done"}],"wave":1,"done":1,"failed":0,
		 "cost":{"usd":4.1,"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4,"turns":5},"createdAt":10,"updatedAt":20}""";

	@Test
	void group() {
		Group g = Wire4b.group(json(GROUP));
		assertEquals("g3", g.id());
		assertEquals("bib_ashfall", g.bible().id());
		assertEquals(2, g.bible().version());
		assertEquals(Group.Status.PAUSED_BUDGET, g.status());
		assertFalse(g.finished());
		assertEquals(5.0, g.budgetUsd().orElseThrow());
		assertEquals(4.1, g.cost().usd());
		assertEquals(2, g.items().size());
		Group.Item a = g.item("lot_a").orElseThrow();
		assertEquals("A", a.ext().get("steward_mc:lot").getAsString());
		assertEquals("gen_tower", a.entryId().orElseThrow());
		assertEquals(Design.Status.DONE, a.status());
		assertEquals(GroupRequest.Role.LANDMARK, a.role());
		assertEquals(0, a.wave());
		assertEquals(30, a.cost().cacheReadTokens());
		Group.Item b = g.item("lot_b").orElseThrow();
		assertTrue(b.entryId().isEmpty());
		assertEquals("hellish_lair", b.type());
		assertEquals(0, b.ext().size());
		assertEquals(Group.Status.HELD_USAGE, Group.Status.of("held_usage"));
		assertEquals(Group.Status.UNKNOWN, Group.Status.of("weird"));
	}

	@Test
	void groupRequestWire() {
		DesignRequest tower = new DesignRequest("tower", "spiky", null, List.of(), new BlockSize(15, 30, 15), "Watch", null, null, null, null, null,
			null, "ignored", null);
		DesignRequest lair = new DesignRequest("hellish_lair", "spiky", null, List.of(), new BlockSize(21, 16, 21), null, "sim:usage_limit", null,
			null, null, "claude-haiku-5", 0.5, null, null).withProfile(List.of("door", "lit"));
		JsonObject ext = new JsonObject();
		ext.addProperty("apitest:i", 1);
		DesignRequest withExt = new DesignRequest("house", "x", null, List.of(), new BlockSize(13, 10, 13), null, null, null, null, ext, null, null,
			null, null);
		GroupRequest r = new GroupRequest("Set", "oak", 1, "apitest:o", null, 2, 3.0, List.of(new GroupRequest.Item("t", tower,
			GroupRequest.Role.LANDMARK, null, true), new GroupRequest.Item("l", lair, null, 2, false), GroupRequest.Item.of(null, withExt)));
		JsonObject w = Wire4b.group(r);
		assertEquals("Set", w.get("name").getAsString());
		assertEquals("oak", w.getAsJsonObject("bible").get("id").getAsString());
		assertEquals(1, w.getAsJsonObject("bible").get("version").getAsInt());
		assertEquals(2, w.get("concurrency").getAsInt());
		assertEquals(3.0, w.get("budgetUsd").getAsDouble());
		var items = w.getAsJsonArray("items");
		JsonObject t = items.get(0).getAsJsonObject();
		assertEquals("t", t.get("itemKey").getAsString());
		assertEquals("landmark", t.get("role").getAsString());
		assertTrue(t.get("anchor").getAsBoolean());
		assertFalse(t.has("wave") || t.has("bible") || t.has("group"), "the group sets the bible; an anchor has no wave");
		JsonObject l = items.get(1).getAsJsonObject();
		assertEquals("ordinary", l.get("role").getAsString());
		assertEquals(2, l.get("wave").getAsInt());
		assertEquals(2, l.getAsJsonArray("profile").size());
		assertEquals("claude-haiku-5", l.get("model").getAsString());
		JsonObject h = items.get(2).getAsJsonObject();
		assertFalse(h.has("itemKey"), "null key: the sidecar's item<n>");
		assertEquals(1, h.getAsJsonObject("ext").get("apitest:i").getAsInt());
		// a plain bible id when no version is pinned
		JsonObject w2 = Wire4b.group(new GroupRequest("S", "bib_x", null, null, null, null, null, List.of(GroupRequest.Item.of("a", withExt))));
		assertEquals("bib_x", w2.get("bible").getAsString());
		assertThrows(IllegalArgumentException.class, () -> Wire4b.group(new GroupRequest("S", "oak", null, null, null, null, null, List.of())));
	}

	@Test
	void bibleInfoAndJob() {
		JsonObject info = json("""
			{"id":"bib_ashfall","name":"Ashfall","version":2,"versions":[1,2],"builtin":false,"scope":"settlement","prompt":"lair",
			 "roles":{"wall":"minecraft:blackstone","roof":"minecraft:deepslate_tiles"},"prose":"# Ashfall","sheetPath":"/tmp/x/sheet.png",
			 "components":["window","door_surround","lantern_post","roof_trim","chimney","spike"],"owner":"apitest:o","ext":{"apitest:k":true}}""");
		Bible b = Wire4b.bibleInfo(info);
		assertEquals(List.of(1, 2), b.versions());
		assertEquals("settlement", b.scope());
		assertEquals("minecraft:blackstone", b.roles().get("wall"));
		assertEquals(Path.of("/tmp/x/sheet.png"), b.sheetPath().orElseThrow());
		assertEquals(6, b.components().size());
		assertEquals("apitest:o", b.owner().orElseThrow());
		Bible builtin = Wire4b.bibleInfo(json("{\"id\":\"oak\",\"name\":\"Oak\",\"version\":1,\"builtin\":true,\"roles\":{}}"));
		assertTrue(builtin.builtin());
		assertEquals(List.of(1), builtin.versions());
		assertEquals(Wire4b.REQUIRED_COMPONENTS, builtin.components());
		assertTrue(builtin.prose().isEmpty() && builtin.sheetPath().isEmpty());
		JsonObject job = json("{\"id\":\"b4\",\"kind\":\"revise\",\"bibleId\":\"bib_ashfall\",\"version\":2,\"request\":{\"prompt\":\"p\",\"owner\":\"o\","
			+ "\"notes\":\"darker\"},\"status\":\"done\",\"step\":\"done\",\"cost\":{\"usd\":0.5},\"rounds\":2,\"createdAt\":1,\"updatedAt\":2}");
		job.add("bible", info);
		BibleJob j = Wire4b.bibleJob(job);
		assertEquals(BibleJob.Status.DONE, j.status());
		assertTrue(j.finished());
		assertEquals("o", j.owner().orElseThrow());
		assertEquals(2, j.bible().orElseThrow().version());
		assertEquals(2, j.rounds());
	}

	@Test
	void bibleRequestWire() {
		JsonObject w = Wire4b.bibleRequest(new BibleRequest(" a lair ", "Ashfall", "apitest:o", null, null, 2.0, List.of("gen_x"), "settlement", "oak"));
		assertEquals("a lair", w.get("prompt").getAsString());
		assertEquals("settlement", w.get("scope").getAsString());
		assertEquals("oak", w.get("seedPreset").getAsString());
		assertEquals("gen_x", w.getAsJsonArray("references").get(0).getAsString());
		assertFalse(w.has("model") || w.has("ext"));
		assertThrows(IllegalArgumentException.class, () -> Wire4b.bibleRequest(BibleRequest.of(" ", null)));
	}

	@Test
	void reskinAndCollection() {
		Reskin r = Wire4b.reskin(json("{\"id\":\"r2\",\"bible\":{\"id\":\"oak\",\"version\":1},\"from\":{\"group\":\"g3\"},\"status\":\"done\",\"step\":\"s\","
			+ "\"variants\":[\"v1\",\"v2\"],\"entries\":[\"gen_a_oak\"],\"done\":1,\"failed\":1,\"error\":\"gen_b: x\",\"createdAt\":1,\"updatedAt\":2}"));
		assertEquals(Reskin.Status.DONE, r.status());
		assertEquals("g3", r.from().group());
		assertEquals(List.of("gen_a_oak"), r.entries());
		assertEquals(1, r.failed());
		JsonObject f = Wire4b.collection(Library.CollectionRef.ofBible("bib_ashfall", 2));
		assertEquals("bib_ashfall", f.get("bible").getAsString());
		assertEquals(2, f.get("bibleVersion").getAsInt());
		assertFalse(f.has("group"));
		assertEquals(List.of("a", "b"), Wire4b.collection(Library.CollectionRef.ofEntries(List.of("a", "b"))).getAsJsonArray("entries").asList().stream()
			.map(e -> e.getAsString()).toList());
		assertThrows(IllegalArgumentException.class, () -> new Library.CollectionRef(null, null, null, List.of()));
	}

	@Test
	void entryParts() {
		JsonObject e = json("{\"parts\":{\"main\":{\"box\":[0,0,0,8,5,6],\"cells\":200},\"roof\":{\"box\":[0,5,0,8,9,6],\"cells\":80},"
			+ "\"bad\":{\"box\":[1,2],\"cells\":1}},\"bible\":{\"id\":\"oak\",\"version\":1}}");
		Map<String, Library.Part> p = Wire4b.parts(e);
		assertEquals(List.of("main", "roof"), List.copyOf(p.keySet()));
		assertEquals(8, p.get("main").box().maxX());
		assertEquals(80, p.get("roof").cells());
		assertEquals("oak", Wire4b.pin(e.get("bible")).orElseThrow().id());
		assertTrue(Wire4b.pin(null).isEmpty());
		assertTrue(Wire4b.parts(new JsonObject()).isEmpty());
	}

	@Test
	void estimate() {
		var est = Wire4b.estimate(json("{\"usdLow\":1.5,\"usdHigh\":3,\"minutesLow\":4,\"minutesHigh\":9.5,\"basis\":\"seed\"}"));
		assertEquals(1.5, est.usdLow());
		assertEquals(9.5, est.minutesHigh());
		assertEquals("seed", est.basis());
	}

	@Test
	void installedBiblesOnDisk(@TempDir Path dir) throws Exception {
		Path v1 = dir.resolve("bib_ashfall/versions/1");
		Path v2 = dir.resolve("bib_ashfall/versions/2");
		Files.createDirectories(v1);
		Files.createDirectories(v2);
		Files.writeString(v1.resolve("bible.json"), "{\"name\":\"Ashfall\",\"roles\":{\"wall\":\"minecraft:stone\"}}", StandardCharsets.UTF_8);
		Files.writeString(v2.resolve("bible.json"), "{\"name\":\"Ashfall\",\"roles\":{\"wall\":\"minecraft:blackstone\"},\"owner\":\"apitest:o\"}",
			StandardCharsets.UTF_8);
		Files.writeString(v2.resolve("bible.md"), "# Ashfall\nlow, warm light", StandardCharsets.UTF_8);
		Files.write(v2.resolve("sheet.png"), new byte[] {1});
		Files.createDirectories(dir.resolve("not a bible"));
		List<Bible> all = Wire4b.installed(dir);
		assertEquals(1, all.size());
		Bible b = all.get(0);
		assertEquals(2, b.version());
		assertEquals(List.of(1, 2), b.versions());
		assertEquals("minecraft:blackstone", b.roles().get("wall"));
		assertTrue(b.prose().orElseThrow().contains("warm light"));
		assertTrue(b.sheetPath().isPresent());
		assertFalse(b.builtin());
		Bible one = Wire4b.installed(dir, "bib_ashfall", 1);
		assertNotNull(one);
		assertEquals("minecraft:stone", one.roles().get("wall"));
		assertTrue(one.sheetPath().isEmpty());
		assertEquals(null, Wire4b.installed(dir, "bib_ashfall", 3));
	}

	@Test
	void recordBookFiresOnceAcrossRestarts(@TempDir Path dir) {
		Path f = dir.resolve("api-groups.json");
		RecordBook b = new RecordBook("group", f, 10, g -> Group.Status.of(RecordBook.str(g, "status")).isFinal(), g -> new JobLedger.Mark(
			RecordBook.str(g, "status"), "", RecordBook.num(g, "updatedAt"), 0));
		JsonObject running = json("{\"id\":\"g1\",\"status\":\"running\",\"createdAt\":5,\"updatedAt\":6,\"owner\":\"o\"}");
		JsonObject done = json("{\"id\":\"g1\",\"status\":\"done\",\"createdAt\":5,\"updatedAt\":9,\"owner\":\"o\"}");
		var a = b.fire(b.merge(running));
		assertTrue(a.updated() && !a.done());
		assertFalse(b.fire(b.merge(running)).updated(), "same state: no update");
		var c = b.fire(b.merge(done));
		assertTrue(c.updated() && c.done());
		var again = b.fire(b.merge(done));
		assertFalse(again.updated() || again.done(), "a snapshot after a reconnect fires nothing");
		// a new game: the done set and the record come back from the file
		RecordBook b2 = new RecordBook("group", f, 10, g -> Group.Status.of(RecordBook.str(g, "status")).isFinal(), g -> new JobLedger.Mark(
			RecordBook.str(g, "status"), "", RecordBook.num(g, "updatedAt"), 0));
		assertEquals("done", RecordBook.str(b2.get("g1"), "status"));
		assertTrue(b2.pendingDone().isEmpty());
		assertFalse(b2.fire(b2.merge(done)).done());
		// a group that finished while no world was loaded: pending until fired
		JsonObject other = json("{\"id\":\"g2\",\"status\":\"failed\",\"createdAt\":7,\"updatedAt\":8}");
		b2.merge(other);
		assertEquals(1, b2.pendingDone().size());
		assertTrue(b2.fire(other).done());
		assertTrue(b2.pendingDone().isEmpty());
		assertEquals(List.of("g2", "g1"), b2.all().stream().map(x -> RecordBook.str(x, "id")).toList(), "newest first");
	}
}
