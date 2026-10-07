package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Critique;
import dev.larattalabs.architect.api.CritiqueMode;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.JobSpec;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Phase 5a wire forms and views (sidecar/src/protocol.ts and critique.ts, the exact shapes): the critique spec as sent, a
 * critique from a design record, a group item's and an entry's summary, an entry's critique.json (fresh and stale), the rounds
 * that fire DESIGN_CRITIQUED, the estimate's critique figures, job images, bible restraint and archive, and the request rules.
 */
class Wire5aTest {
	private static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	static DesignRequest req() {
		return new DesignRequest("cabin", "rustic", null, List.of(), new BlockSize(21, 14, 21), null, null, null, null, null, null, null, null, null);
	}

	/** A design record mid-loop and one ended (CritiqueRecord: rounds in full, cost {critic, revise}). */
	static final String RUNNING = """
		{"mode":"loop","rounds":[
		  {"n":0,"verdict":"iterate","overall":5.6,"scores":{"silhouette":6,"legibility":5,"craft":5,"materials":6,"brief":6},
		   "issues":[{"priority":"P1","part":"roof","view":"iso","what":"roof hides the walls","fix":"lower the eaves"},
		             {"priority":"P2","part":null,"view":"front","what":"door reads small","fix":"widen the surround"}],
		   "resolved":[],"summary":"heavy roof","ship":false,"cost":0.07,"ms":61000,"kept":true},
		  {"n":1,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0.4,"ms":120000,"kept":true}],
		 "pending":"critic","cost":{"critic":{"usd":0.07,"inputTokens":9000,"outputTokens":3000,"cacheReadTokens":0,"cacheWriteTokens":0,"turns":1},
		 "revise":{"usd":0.4,"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4,"turns":2}}}""";

	static final String ENDED = """
		{"mode":"loop","rounds":[
		  {"n":0,"verdict":"iterate","overall":5.6,"scores":{"silhouette":6,"legibility":5,"craft":5,"materials":6,"brief":6},
		   "issues":[{"priority":"P1","part":"roof","view":"iso","what":"roof hides the walls","fix":"lower the eaves"}],
		   "resolved":[],"ship":false,"cost":0.07,"ms":61000,"kept":true},
		  {"n":1,"verdict":"ship","overall":7.4,"scores":{"silhouette":8,"legibility":7,"craft":7,"materials":7,"brief":8},
		   "issues":[{"priority":"P2","part":"porch","view":"iso_back","what":"bare back","fix":"add a window"}],"resolved":[0],
		   "summary":"reads as a cabin","ship":true,"cost":0.48,"ms":180000,"kept":true,"notes":["part \\"attic\\" is not a named part"],"unknownParts":1},
		  {"n":2,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0.3,"ms":90000,"kept":false,
		   "error":"check failed: floating blocks"}],
		 "best":1,"end":"ship","overall":7.4,
		 "cost":{"critic":{"usd":0.15,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"turns":2},
		 "revise":{"usd":0.7,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"turns":3}}}""";

	@Test
	void recordWhileRunning() {
		Critique c = Wire5a.record(json(RUNNING)).orElseThrow();
		assertEquals(CritiqueMode.LOOP, c.mode());
		assertFalse(c.ended());
		assertNull(c.end());
		assertEquals("critic", c.pending().orElseThrow());
		assertEquals(2, c.rounds().size());
		assertEquals(0, c.best(), "while running the best round so far stands in (round 1 is unscored)");
		assertEquals(5.6, c.overall());
		assertEquals(5, c.scores().get("legibility"));
		assertEquals(2, c.openIssues().size());
		Critique.Issue i = c.openIssues().get(0);
		assertEquals(Critique.Priority.P1, i.priority());
		assertEquals("roof", i.part());
		assertEquals("iso", i.view());
		assertNull(c.openIssues().get(1).part(), "a null part = the whole building");
		Critique.Round r1 = c.rounds().get(1);
		assertFalse(r1.scored());
		assertTrue(Double.isNaN(r1.overall()));
		assertNull(r1.verdict());
		assertEquals(0.07, c.critic().usd());
		assertEquals(9000, c.critic().inputTokens());
		assertEquals(0.4, c.revise().usd());
		assertEquals(0.47, c.usd(), 1e-9);
		assertEquals(List.of(c.rounds().get(0)), Wire5a.verdictRounds(c), "only the scored round has its verdict");
	}

	@Test
	void recordEnded() {
		Critique c = Wire5a.record(json(ENDED)).orElseThrow();
		assertTrue(c.ended());
		assertEquals(Critique.EndReason.SHIP, c.end());
		assertEquals("shipped", c.end().label());
		assertEquals(1, c.best());
		assertEquals(7.4, c.overall());
		assertEquals(Map.of("silhouette", 8, "legibility", 7, "craft", 7, "materials", 7, "brief", 8), c.scores());
		assertEquals(1, c.openIssues().size());
		assertEquals("porch", c.openIssues().get(0).part());
		Critique.Round r1 = c.bestRound().orElseThrow();
		assertEquals("ship", r1.verdict());
		assertTrue(r1.ship());
		assertEquals(List.of(0), r1.resolved());
		assertEquals(0.48, r1.usd());
		assertEquals(180000, r1.ms());
		assertEquals("reads as a cabin", r1.summary().orElseThrow());
		assertEquals(1, r1.notes().size());
		Critique.Round r2 = c.rounds().get(2);
		assertFalse(r2.kept());
		assertEquals("check failed: floating blocks", r2.error().orElseThrow());
		assertEquals(List.of(0, 1), Wire5a.verdictRounds(c).stream().map(Critique.Round::n).toList(), "a round that failed the check had no critic");
		assertTrue(c.pending().isEmpty());
		assertFalse(c.stale());
	}

	@Test
	void criticFailedRoundFires() {
		Critique c = Wire5a.record(json("""
			{"mode":"report","rounds":[{"n":0,"verdict":null,"overall":null,"scores":{},"issues":[],"resolved":[],"ship":false,"cost":0,"ms":3000,
			 "kept":true,"error":"the critic call failed twice"}],"best":0,"end":"critic_failed","overall":null,
			 "cost":{"critic":{"usd":0},"revise":{"usd":0}}}""")).orElseThrow();
		assertEquals(CritiqueMode.REPORT, c.mode());
		assertEquals(Critique.EndReason.CRITIC_FAILED, c.end());
		assertFalse(c.scored());
		assertEquals(1, Wire5a.verdictRounds(c).size(), "a kept round the critic failed on fires (with its error)");
	}

	@Test
	void endReasons() {
		for (String w : List.of("ship", "max_revisions", "budget", "time", "regressed", "check_failed", "critic_failed", "off")) {
			assertEquals(w, Critique.EndReason.of(w).wire());
		}
		assertEquals(Critique.EndReason.UNKNOWN, Critique.EndReason.of("polished"), "a newer reason");
		assertNull(Critique.EndReason.of(null));
		assertEquals("max revisions", Critique.EndReason.MAX_REVISIONS.label());
	}

	@Test
	void absentIsEmpty() {
		assertTrue(Wire5a.record(null).isEmpty());
		assertTrue(Wire5a.summary(null).isEmpty());
		assertTrue(Wire5a.record(json("{}").get("critique")).isEmpty());
	}

	@Test
	void designViewCarriesTheCritique() {
		// the design status: critiquing sits before done (the API enum mirrors the sidecar's DesignStatus)
		assertEquals(Design.Status.CRITIQUING, Design.Status.of("critiquing"));
		assertTrue(Design.Status.CRITIQUING.isRunning());
		assertFalse(Design.Status.CRITIQUING.isFinal());
		assertTrue(Design.Status.CRITIQUING.ordinal() < Design.Status.DONE.ordinal());
		Design d = new Design("d1", Design.Status.DONE, "", java.util.Optional.empty(), dev.larattalabs.architect.api.Cost.NONE, java.util.Optional.empty(),
			new JsonObject(), java.util.Optional.empty(), 1, 2);
		assertTrue(d.critique().isEmpty(), "the 1.2.0 constructor: no critique");
		assertFalse(d.isReport());
	}

	@Test
	void groupItemSummary() {
		Group g = Wire4b.group(json("""
			{"id":"g1","name":"Set","bible":{"id":"oak","version":1},"concurrency":3,"softBudgetFraction":0.8,"status":"running","wave":1,"done":1,
			 "failed":0,"cost":{"usd":1},"createdAt":1,"updatedAt":2,"items":[
			  {"itemKey":"a","designId":"d1","status":"critiquing","step":"critic: round 1","wave":1,"role":"ordinary","model":"m","type":"house",
			   "critique":{"rounds":2,"best":0,"overall":6.2}},
			  {"itemKey":"b","designId":"d2","status":"done","step":"","wave":1,"role":"ordinary","model":"m","type":"house",
			   "critique":{"rounds":1,"best":0,"end":"ship","overall":7.8}},
			  {"itemKey":"c","designId":"d3","status":"done","step":"","wave":1,"role":"ordinary","model":"m","type":"house"}]}"""));
		Group.Item a = g.item("a").orElseThrow();
		assertEquals(Design.Status.CRITIQUING, a.status());
		Critique ca = a.critique().orElseThrow();
		assertFalse(ca.ended());
		assertEquals(0, ca.best());
		assertEquals(6.2, ca.overall());
		assertTrue(ca.rounds().isEmpty(), "a summary counts rounds; the record has them");
		assertEquals(Critique.EndReason.SHIP, g.item("b").orElseThrow().critique().orElseThrow().end());
		assertTrue(g.item("c").orElseThrow().critique().isEmpty());
		assertEquals(2, Wire5a.summaryRounds(json("{\"rounds\":2}")));
	}

	@Test
	void entrySummaryFromTheBlueprintJson() {
		JsonObject bp = json("""
			{"id":"gen_cabin","critique":{"mode":"loop","end":"max_revisions","best":2,"rounds":3,"overall":6.8,
			 "scores":{"silhouette":7,"legibility":6.6},"openIssues":[{"priority":"P2","part":"chimney","view":"top","what":"thin","fix":"wider"}]}}""");
		Critique c = Wire5a.entry(null, "gen_cabin", bp).orElseThrow();
		assertEquals(Critique.EndReason.MAX_REVISIONS, c.end());
		assertEquals(2, c.best());
		assertEquals(6.8, c.overall());
		assertEquals(7, c.scores().get("legibility"), "scores round to whole numbers");
		assertEquals("chimney", c.openIssues().get(0).part());
		assertFalse(c.stale(), "a summary has no revision to compare");
		assertTrue(Wire5a.entry(null, "gen_x", json("{}")).isEmpty());
	}

	static String critiqueJson(String revision) {
		return """
			{"format":1,"entryId":"gen_cabin","entryRevision":%s,"at":5,"designId":"d9","mode":"report","end":"max_revisions","best":0,
			 "model":"claude-sonnet-5-5","effort":"medium","bible":null,"renders":{"iso":"ab12"},
			 "verdict":{"overall":6.4,"scores":{"silhouette":7,"legibility":6,"craft":6,"materials":7,"brief":6},
			   "issues":[{"priority":"P1","part":"door","view":"front","what":"door hidden","fix":"frame it"}],"summary":"ok","modelVerdict":"iterate",
			   "ship":false},
			 "openIssues":[{"priority":"P1","part":"door","view":"front","what":"door hidden","fix":"frame it"}],
			 "rounds":[{"n":0,"overall":6.4,"ship":false,"issues":1,"kept":true}],"cost":{"critic":0.09,"revise":0}}""".formatted(revision);
	}

	@Test
	void critiqueJsonFreshAndStale(@TempDir Path dir) throws Exception {
		Path entry = dir.resolve("gen_cabin");
		Files.createDirectories(entry);
		Files.write(entry.resolve("gen_cabin.nbt"), new byte[] {1, 2, 3});
		String sha = Wire5a.sha256(entry.resolve("gen_cabin.nbt"));
		assertEquals("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", sha, "sha256 of 01 02 03");
		Files.writeString(entry.resolve(Wire5a.CRITIQUE_FILE), critiqueJson("\"" + sha + "\""), StandardCharsets.UTF_8);
		JsonObject bp = json("{\"critique\":{\"mode\":\"loop\",\"end\":\"ship\",\"best\":0,\"rounds\":1,\"overall\":9}}");
		Critique fresh = Wire5a.entry(entry, "gen_cabin", bp).orElseThrow();
		assertFalse(fresh.stale());
		assertEquals(CritiqueMode.REPORT, fresh.mode(), "critique.json wins over the blueprint summary");
		assertEquals(6.4, fresh.overall());
		assertEquals(6, fresh.scores().get("craft"));
		assertEquals("door", fresh.openIssues().get(0).part());
		assertEquals(0.09, fresh.critic().usd());
		Critique.Round r0 = fresh.rounds().get(0);
		assertEquals(1, r0.issueCount());
		assertEquals("iterate", r0.verdict());
		assertEquals(1, r0.issues().size(), "the best round's issues come from the verdict");
		// the entry changed (a re-install, a hand edit): the verdict is stale, not reused
		Files.write(entry.resolve("gen_cabin.nbt"), new byte[] {1, 2, 3, 4});
		Critique stale = Wire5a.entry(entry, "gen_cabin", bp).orElseThrow();
		assertTrue(stale.stale());
		assertEquals(6.4, stale.overall(), "a stale verdict still says what it judged");
		// no revision recorded: unverifiable, stale
		assertTrue(Wire5a.critiqueFile(json(critiqueJson("null")), sha).stale());
		assertFalse(Wire5a.critiqueFile(json(critiqueJson("\"" + sha.toUpperCase() + "\"")), sha).stale());
		// an unreadable critique.json falls back to the summary
		Files.writeString(entry.resolve(Wire5a.CRITIQUE_FILE), "{not json", StandardCharsets.UTF_8);
		assertEquals(9.0, Wire5a.entry(entry, "gen_cabin", bp).orElseThrow().overall());
	}

	@Test
	void estimateCritiqueFigures() {
		Estimate e = Wire4b.estimate(json("""
			{"usdLow":1.6,"usdHigh":5,"minutesLow":8,"minutesHigh":20,"basis":"claude-sonnet-5-5: seed; critique: up to 2 revisions",
			 "critiqueUsdLow":0.08,"critiqueUsdHigh":4.5,"critiqueMinutesLow":1,"critiqueMinutesHigh":24,
			 "items":[{"itemKey":"a","usdLow":0.8,"usdHigh":2.5,"minutesLow":4,"minutesHigh":10,"critiqueUsdLow":0.04,"critiqueUsdHigh":2.25,
			   "critiqueMinutesLow":0.5,"critiqueMinutesHigh":12},{"itemKey":"b","usdLow":0.8,"usdHigh":2.5,"minutesLow":4,"minutesHigh":10}]}"""));
		assertTrue(e.critique());
		assertEquals(0.08, e.critiqueUsdLow());
		assertEquals(4.5, e.critiqueUsdHigh());
		assertEquals(9.5, e.withCritiqueUsdHigh(), 1e-9);
		assertEquals(44, e.withCritiqueMinutesHigh(), 1e-9);
		assertEquals(2, e.items().size());
		assertTrue(e.items().get(0).critique());
		assertEquals(2.25, e.items().get(0).critiqueUsdHigh());
		assertFalse(e.items().get(1).critique(), "an item with critique off");
		Estimate old = Wire4b.estimate(json("{\"usdLow\":1,\"usdHigh\":2,\"minutesLow\":3,\"minutesHigh\":4,\"basis\":\"seed\"}"));
		assertFalse(old.critique());
		assertEquals(0, old.critiqueUsdHigh());
		assertTrue(old.items().isEmpty());
		assertEquals(new Estimate(1, 2, 3, 4, "seed"), old, "the 1.2.0 constructor equals an estimate without critique");
		assertEquals("$0.04-2.25", Estimate.usd(0.04, 2.25));
	}

	@Test
	void specAsSent() {
		CritiqueSpec s = CritiqueSpec.builder(CritiqueMode.LOOP).maxRevisions(1).budgetUsd(5.0).views(List.of("iso", "front")).extraCriterion(
			"reads as a mine").shipScore(7.5).effort("high").maxMinutes(10.0).neighbours(false).model("claude-sonnet-5-5").build();
		JsonObject w = Wire5a.spec(s);
		assertEquals("loop", w.get("mode").getAsString());
		assertEquals(1, w.get("maxRevisions").getAsInt());
		assertEquals(5.0, w.get("budgetUsd").getAsDouble());
		assertEquals(2, w.getAsJsonArray("views").size());
		assertEquals("reads as a mine", w.getAsJsonArray("extraCriteria").get(0).getAsString());
		assertFalse(w.get("neighbours").getAsBoolean());
		assertEquals(s, Wire5a.spec(w), "a spec round-trips");
		JsonObject plain = Wire5a.spec(CritiqueSpec.loop());
		assertEquals(Set.of("mode"), plain.keySet(), "unset fields are left out (the helper's defaults)");
		assertNull(Wire5a.spec(json("{\"mode\":\"loop\",\"maxRevisions\":9}")), "an invalid spec from the wire is dropped, not thrown");
	}

	@Test
	void requestWire() {
		DesignRequest loop = req().critique(CritiqueSpec.loop(2));
		JsonObject w = DesignsImpl.wire(loop, 2);
		assertEquals("loop", w.getAsJsonObject("critique").get("mode").getAsString());
		assertEquals(2, w.getAsJsonObject("critique").get("maxRevisions").getAsInt());
		assertFalse(DesignsImpl.wire(loop, 1).has("critique"), "protocol 1 never");
		assertFalse(DesignsImpl.wire(req(), 2).has("critique"), "off: the 4c shape");
		assertNull(req().critique(CritiqueSpec.OFF).critique(), "OFF is stored as none");
		assertEquals(req(), req().critique(CritiqueSpec.OFF), "a request with critique off equals one without");
		// the helper must have the loop
		assertNull(DesignsImpl.refusal5a(loop.critique(), 2, Set.of("critique")));
		assertTrue(DesignsImpl.refusal5a(loop.critique(), 2, Set.of("massing")).contains("phase 5a"));
		assertTrue(DesignsImpl.refusal5a(loop.critique(), 1, Set.of("critique")).contains("phase 5a"));
		assertNull(DesignsImpl.refusal5a((CritiqueSpec) null, 1, Set.of()), "off needs nothing");
	}

	@Test
	void everyCopierKeepsTheCritique() {
		CritiqueSpec spec = CritiqueSpec.loop(1);
		DesignRequest r = req().critique(spec).withProfile(List.of("door")).withBible("oak", 1).massing(true).massing(false).fromMassing("mas_x")
			.fromMassing(null, null).withContext("by the river").withContext((com.google.gson.JsonElement) null);
		assertSame(spec, r.critique());
		// the 1.3.0 constructor has no critique
		DesignRequest old = new DesignRequest("cabin", "rustic", null, List.of(), new BlockSize(21, 14, 21), null, null, null, null, null, null, null,
			null, null, List.of(), null, false, null, null, null);
		assertNull(old.critique());
		GroupRequest.Item it = GroupRequest.Item.of("a", req());
		GroupRequest g = new GroupRequest("Set", "oak", null, null, null, null, null, List.of(it)).critique(spec).withMassingFirst(null, null)
			.withContext("ctx").withContext((com.google.gson.JsonElement) null);
		assertSame(spec, g.critique());
		assertNull(new GroupRequest("Set", "oak", null, null, null, null, null, List.of(it), false, null, null, null).critique());
		assertSame(spec, it.critique(spec).critique());
		assertNull(new GroupRequest.Item("a", req(), GroupRequest.Role.ORDINARY, null, false).critique(), "the 1.2.0 item constructor");
		JobSpec js = new JobSpec("structured", "p", null, null, null, new JsonObject(), List.of(), null, null, null, null, null, null, List.of());
		assertTrue(js.images().isEmpty());
		assertEquals(1, js.images(List.of(new JobSpec.ImageRef("blob1", "iso"))).images().size());
		BibleRequest br = BibleRequest.of("a village", null);
		assertFalse(br.sheetCritique());
		assertTrue(br.withSheetCritique(true).sheetCritique());
	}

	@Test
	void groupWire() {
		DesignRequest withOwn = req().critique(CritiqueSpec.report());
		GroupRequest g = new GroupRequest("Set", "oak", null, null, null, null, null, List.of(GroupRequest.Item.of("a", req()), GroupRequest.Item.of("b",
			req()).critique(CritiqueSpec.OFF), GroupRequest.Item.of("c", withOwn), GroupRequest.Item.of("d", withOwn).critique(CritiqueSpec.loop(2))))
			.critique(CritiqueSpec.loop(1));
		JsonObject w = Wire4b.group(g);
		assertEquals("loop", w.getAsJsonObject("critique").get("mode").getAsString());
		var items = w.getAsJsonArray("items");
		assertFalse(items.get(0).getAsJsonObject().has("critique"), "no own critique: the group's");
		assertEquals("off", items.get(1).getAsJsonObject().getAsJsonObject("critique").get("mode").getAsString(), "OFF is sent to turn it off");
		assertEquals("report", items.get(2).getAsJsonObject().getAsJsonObject("critique").get("mode").getAsString(), "the request's own");
		assertEquals(2, items.get(3).getAsJsonObject().getAsJsonObject("critique").get("maxRevisions").getAsInt(), "the item's wins");
		assertFalse(Wire4b.group(new GroupRequest("Set", "oak", null, null, null, null, null, List.of(GroupRequest.Item.of("a", req())))).has("critique"));
		assertNull(DesignsImpl.refusal5a(new GroupRequest("Set", "oak", null, null, null, null, null, List.of(GroupRequest.Item.of("a", req()))), 2,
			Set.of()), "a group without critique needs nothing");
		assertTrue(DesignsImpl.refusal5a(new GroupRequest("Set", "oak", null, null, null, null, null, List.of(GroupRequest.Item.of("c", withOwn))), 2,
			Set.of()) != null, "an item's own critique needs the helper's");
	}

	@Test
	void reportMessage() {
		JsonObject m = Wire5a.critiqueMessage("gen_cabin", null);
		assertEquals("design.critique", m.get("type").getAsString());
		assertEquals("report", m.getAsJsonObject("spec").get("mode").getAsString());
		JsonObject m2 = Wire5a.critiqueMessage("gen_cabin", CritiqueSpec.builder(CritiqueMode.REPORT).views(List.of("iso")).build());
		assertEquals(1, m2.getAsJsonObject("spec").getAsJsonArray("views").size());
		assertThrows(IllegalArgumentException.class, () -> Wire5a.critiqueMessage("gen_cabin", CritiqueSpec.loop()), "no loop on an entry in 5a");
		assertThrows(IllegalArgumentException.class, () -> Wire5a.critiqueMessage("../x", null));
	}

	@Test
	void jobImages() {
		JobSpec js = new JobSpec("structured", "p", null, null, null, new JsonObject(), List.of(), null, null, null, null, null, null, List.of())
			.images(List.of(new JobSpec.ImageRef("b1", " iso "), new JobSpec.ImageRef("b2", "top")));
		JsonObject w = JobsImpl.wire(js);
		assertEquals(2, w.getAsJsonArray("images").size());
		assertEquals("iso", w.getAsJsonArray("images").get(0).getAsJsonObject().get("label").getAsString(), "labels are stripped");
		assertFalse(JobsImpl.wire(js.images(List.of())).has("images"), "none: the 4a shape");
		List<JobSpec.ImageRef> nine = java.util.Collections.nCopies(9, new JobSpec.ImageRef("b", "x"));
		assertThrows(IllegalArgumentException.class, () -> js.images(nine));
		assertThrows(IllegalArgumentException.class, () -> new JobSpec.ImageRef("b", ""));
		assertThrows(IllegalArgumentException.class, () -> new JobSpec.ImageRef(" ", "x"));
	}

	@Test
	void features() {
		var f = ApiRules.features(2, List.of("job.run", "critique", "critique.report", "job.images", "bible.admin", "bible.restraint"));
		assertTrue(f.containsAll(List.of("critique", "critiqueReport", "jobImages", "bibleAdmin", "bibleRestraint")), f.toString());
		assertFalse(ApiRules.features(1, List.of("critique")).contains("critique"));
	}

	@Test
	void bibleRestraint(@TempDir Path dir) throws Exception {
		// format 1: the defaults, the first 3 motifs as heroes (strings or {name})
		Bible.Restraint r1 = Wire5a.restraintOf(json("{\"motifs\":[\"moss\",{\"name\":\"red trim\"},\"bundles\",\"lanterns\"]}"));
		assertEquals(List.of("moss", "red trim", "bundles"), r1.heroMotifs());
		assertEquals(0.12, r1.accentShareMax());
		assertEquals("moderate", r1.detailDensity());
		assertEquals(2, r1.windowsPerFacadeMin());
		// format 1 ignores a restraint block (it is format 2's)
		assertEquals(0.12, Wire5a.restraintOf(json("{\"format\":1,\"motifs\":[],\"restraint\":{\"accentShareMax\":0.05}}")).accentShareMax());
		// format 2: its own, with the out-of-range values defaulted
		Bible.Restraint r2 = Wire5a.restraintOf(json("""
			{"format":2,"motifs":["a","b","c","d"],"restraint":{"heroMotifs":["d"],"accentShareMax":0.5,"detailDensity":"sparse","windowsPerFacadeMin":3}}"""));
		assertEquals(List.of("d"), r2.heroMotifs());
		assertEquals(0.12, r2.accentShareMax(), "0.5 is outside 0.04-0.20");
		assertEquals("sparse", r2.detailDensity());
		assertEquals(3, r2.windowsPerFacadeMin());
		// the helper's index sends the effective restraint and archived
		Bible fromIndex = Wire4b.bibleInfo(json("""
			{"id":"bib_moss","name":"Mosswater","version":2,"builtin":false,"scope":"building","roles":{},"format":2,"archived":true,
			 "restraint":{"heroMotifs":["moss"],"accentShareMax":0.08,"detailDensity":"sparse","windowsPerFacadeMin":2},
			 "critique":{"overall":7.1}}"""));
		assertTrue(fromIndex.archived());
		assertEquals(2, fromIndex.format());
		assertEquals(0.08, fromIndex.restraint().accentShareMax());
		assertEquals(7.1, fromIndex.critique().orElseThrow().get("overall").getAsDouble());
		Bible builtin = Wire4b.bibleInfo(json("{\"id\":\"oak\",\"builtin\":true,\"roles\":{}}"));
		assertFalse(builtin.archived());
		assertEquals(1, builtin.format());
		assertEquals(Bible.Restraint.DEFAULT, builtin.restraint());
		// installed on disk: archive state from admin.json, restraint computed from bible.json
		Path v1 = dir.resolve("bib_moss").resolve("versions").resolve("1");
		Files.createDirectories(v1);
		Files.writeString(v1.resolve("bible.json"), "{\"name\":\"Mosswater\",\"roles\":{},\"motifs\":[\"moss\",\"trim\"]}", StandardCharsets.UTF_8);
		Bible disk = Wire4b.installed(dir, "bib_moss", 1);
		assertFalse(disk.archived());
		assertEquals(List.of("moss", "trim"), disk.restraint().heroMotifs());
		Files.writeString(dir.resolve("bib_moss").resolve("admin.json"), "{\"archived\":true}", StandardCharsets.UTF_8);
		assertTrue(Wire4b.installed(dir, "bib_moss", 1).archived());
		// the 1.2.0 constructor
		Bible old = new Bible("x", "X", 1, List.of(1), false, "building", Map.of(), java.util.Optional.empty(), java.util.Optional.empty(), List.of(),
			java.util.Optional.empty(), null);
		assertEquals(Bible.Restraint.DEFAULT, old.restraint());
		assertFalse(old.archived());
	}

	@Test
	void bibleRequestWire() {
		assertFalse(Wire4b.bibleRequest(BibleRequest.of("a village", null)).has("critique"));
		assertEquals("report", Wire4b.bibleRequest(BibleRequest.of("a village", null).withSheetCritique(true)).getAsJsonObject("critique").get("mode")
			.getAsString());
	}
}
