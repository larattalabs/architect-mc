package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlanBudget;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Regions;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Phase 6c slice P0 (docs/CONTRACT.md "Phase 6c slice P0" §2): API 1.23.0 (placeholder): the plan-check methods as defaults that throw,
 * the records, {@code PlanCheck.Overall} in its order, the two Reasons appended last, the features {@code planCheck} and
 * {@code planCatalogue}, the kit's catalogue API equal to {@code ArchitectApi.VERSION}; the pure parts of {@link PlanChecks}: the
 * budget, the kit's answer as a PlanCheck, the exact stale rule over the plan's tiles, a sandbox-stopped check.
 */
class ApiP0Test {
	@Test
	void version() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.23.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.25.0") >= 0, IrStale.KIT_VERSION);
	}

	@Test
	void kitCatalogueApiIsThisApi() throws Exception {
		// the kit stamps its catalogue with PLAN_API (kit/lib/plan/catalogue.mjs); a release moves both together
		Path f = Path.of("..", "kit", "lib", "plan", "catalogue.mjs");
		String src = Files.readString(f);
		var m = java.util.regex.Pattern.compile("export const PLAN_API = '([^']+)'").matcher(src);
		assertTrue(m.find(), "PLAN_API in " + f);
		assertEquals(ArchitectApi.VERSION, m.group(1), "kit PLAN_API = ArchitectApi.VERSION");
	}

	@Test
	void reasonsAppended() {
		Reason[] v = Reason.values();
		// later slices append after P0's two (PT: PLAYER_BUILD)
		assertEquals(Reason.ARTIFACT_STALE.ordinal() + 1, Reason.ARTIFACT_UNAPPROVED.ordinal());
		assertEquals(Reason.PERMISSION.ordinal() + 1, Reason.ARTIFACT_STALE.ordinal(), "after B's PERMISSION");
	}

	@Test
	void overallOrder() {
		assertEquals(List.of("READY", "NEEDS_REPAIR", "REQUIRED_BLOCKED", "INCOMPLETE", "MALFORMED"), java.util.Arrays.stream(PlanCheck.Overall.values()).map(Enum::name)
			.toList());
	}

	@Test
	void defaultsThrow() {
		Regions r = new Regions() {
			public java.util.concurrent.CompletableFuture<dev.larattalabs.architect.api.RegionPlan> plan(dev.larattalabs.architect.api.RegionPlanRequest q) {
				return null;
			}

			public java.util.concurrent.CompletableFuture<dev.larattalabs.architect.api.PrepareView> prepare(dev.larattalabs.architect.api.PrepareRequest q) {
				return null;
			}

			public void cancelPrepare(String id) {
			}

			public java.util.concurrent.CompletableFuture<String> realise(dev.larattalabs.architect.api.RealiseRequest q) {
				return null;
			}

			public java.util.concurrent.CompletableFuture<dev.larattalabs.architect.api.RemoveResult> remove(String id, dev.larattalabs.architect.api.RemoveOptions o) {
				return null;
			}

			public java.util.Optional<dev.larattalabs.architect.api.RegionView> get(String id) {
				return java.util.Optional.empty();
			}

			public List<dev.larattalabs.architect.api.RegionView> list(String owner) {
				return List.of();
			}
		};
		for (Runnable call : List.<Runnable>of(() -> r.checkPlan(null), () -> r.cancelCheck(null, "k"), () -> r.checkByKey(null, "k"), () -> r.planImages("c", Set.of()),
			() -> r.artifact("a"), () -> r.realiseApproved(null), () -> r.pinArtifact("a", "o"), () -> r.unpinArtifact("a", "o"))) {
			UnsupportedOperationException e = assertThrows(UnsupportedOperationException.class, call::run);
			assertTrue(e.getMessage().contains("1.23.0"), e.getMessage());
		}
	}

	@Test
	void features() {
		Set<String> p0 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.route", "region.planCheck"));
		assertTrue(p0.contains("planCheck"));
		assertTrue(p0.contains("planCatalogue"));
		Set<String> t2 = ApiRules.features(2, List.of("region.plan", "region.tiles", "region.route"));
		assertTrue(!t2.contains("planCheck") && !t2.contains("planCatalogue"), "a T2 helper has no plan check");
	}

	@Test
	void budget() {
		PlanBudget d = PlanBudget.defaults().resolved();
		assertEquals(new PlanBudget(2_000_000, 128, 20_000_000L, 120_000, 2048), d);
		// a request may only lower a cap
		assertEquals(new PlanBudget(1000, 128, 20_000_000L, 1, 2048), new PlanBudget(1000, 500, 99_000_000L, 1, 9999).resolved());
		ApprovedRealise a = new ApprovedRealise("s", null, null, null, null, null);
		assertEquals(Mode.INSTANT, a.mode());
		assertEquals(Map.of(), a.lotEntries());
	}

	@Test
	void fromPlanned() {
		JsonObject planned = JsonParser.parseString("""
			{"surveySha":"aa","kitVersion":"0.25.0","sitePlan":{"format":1},"previews":{"siteplan":["/x/siteplan.svg"]},
			 "planCheck":{"overall":"NEEDS_REPAIR","planSha":"pp","schemaVersion":"plan/0","kitVersion":"0.25.0","artifactSha":"%s",
			  "parts":[{"part":"town","class":"fits"},{"part":"wall","class":"unsupported","block":"connector.wall"}],
			  "cost":{"cells":10},"catalogue":{"entries":[]},"preview":{"bounds":{}},"notes":["n"]}}""".formatted("b".repeat(64))).getAsJsonObject();
		PlanCheck pc = PlanChecks.fromPlanned("p1", planned);
		assertEquals("p1", pc.checkId());
		assertEquals(PlanCheck.Overall.NEEDS_REPAIR, pc.overall());
		assertEquals("pp", pc.planSha());
		assertEquals("aa", pc.surveySha());
		assertEquals(2, pc.parts().size());
		assertEquals("b".repeat(64), pc.artifactSha());
		assertEquals(1, pc.preview().getAsJsonObject("siteplan").get("format").getAsInt());
		// the record survives its JSON (a keyed check after a restart)
		PlanCheck back = PlanChecks.fromJson(PlanChecks.toJson(pc));
		assertEquals(PlanChecks.toJson(pc), PlanChecks.toJson(back));
		JsonObject mal = JsonParser.parseString("{\"planCheck\":{\"overall\":\"MALFORMED\",\"malformed\":{\"code\":\"SCHEMA\",\"path\":\"$\"},\"parts\":[]}}").getAsJsonObject();
		PlanCheck m = PlanChecks.fromPlanned("p2", mal);
		assertEquals(PlanCheck.Overall.MALFORMED, m.overall());
		assertNull(m.artifactSha());
		assertEquals("$", m.preview().getAsJsonObject("malformed").get("path").getAsString());
	}

	@Test
	void incompleteWhenTheSandboxStops() {
		JsonObject plan = JsonParser.parseString("{\"schemaVersion\":\"plan/0\",\"zones\":[{\"id\":\"a\"}],\"connectors\":[{\"id\":\"r\",\"kind\":\"road\"}]}").getAsJsonObject();
		PlanCheck pc = PlanChecks.incomplete(plan, "maxMs", "the plan took longer than 1 s");
		assertEquals(PlanCheck.Overall.INCOMPLETE, pc.overall());
		assertNull(pc.artifactSha());
		assertEquals(List.of("a", "r"), pc.parts().stream().map(p -> p.get("part").getAsString()).toList());
		assertTrue(pc.parts().stream().allMatch(p -> p.get("class").getAsString().equals("incomplete")));
		assertEquals("maxMs", pc.parts().get(0).getAsJsonArray("reasons").get(0).getAsJsonObject().getAsJsonObject("evidence").get("cap").getAsString());
	}

	@Test
	void staleRuleIsExactOverThePlansTiles() {
		Columns plan = new Columns(0, 0, 128, 128, 1);
		for (int k = 0; k < 128 * 128; k++) {
			plan.ground[k] = 64;
			plan.height[k] = 64;
			plan.floor[k] = 64;
			plan.flags[k] = 0;
		}
		Columns now = new Columns(0, 0, 128, 128, 1);
		System.arraycopy(plan.ground, 0, now.ground, 0, plan.ground.length);
		System.arraycopy(plan.height, 0, now.height, 0, plan.height.length);
		System.arraycopy(plan.floor, 0, now.floor, 0, plan.floor.length);
		System.arraycopy(plan.flags, 0, now.flags, 0, plan.flags.length);
		JsonObject tiles = JsonParser.parseString("{\"ground\":{\"terrain\":{\"0,0\":\"s\"},\"path\":{}}}").getAsJsonObject();
		assertNull(PlanChecks.terrainDiff(plan, now, tiles, 0, 0, 127, 127), "unchanged");
		// one block placed outside the plan's tiles: not judged
		now.height[now.index(100, 100)] = 65;
		assertNull(PlanChecks.terrainDiff(plan, now, tiles, 0, 0, 127, 127));
		// one block on a planned tile: stale, naming the column
		now.height[now.index(10, 20)] = 65;
		String d = PlanChecks.terrainDiff(plan, now, tiles, 0, 0, 127, 127);
		assertNotNull(d);
		assertTrue(d.startsWith("1 column: (10, 20) ground 64->64 height 64->65"), d);
		// a column missing in either survey is not judged
		now.flags[now.index(10, 20)] = (byte) Columns.MISSING;
		assertNull(PlanChecks.terrainDiff(plan, now, tiles, 0, 0, 127, 127));
	}

	@Test
	void lotProblem() {
		JsonObject body = JsonParser.parseString("{\"lots\":[{\"id\":\"h1\",\"provisional\":true,\"costRange\":[100,400],\"fitBox\":[0,64,0,8,96,8]},"
			+ "{\"id\":\"h2\",\"provisional\":false,\"entry\":\"x\"}]}").getAsJsonObject();
		assertNull(PlanChecks.lotProblem(body, Map.of()));
		assertTrue(PlanChecks.lotProblem(body, Map.of("ghost", "x")).contains("not a lot of the artifact"));
		assertTrue(PlanChecks.lotProblem(body, Map.of("h1", "no_such_entry")).contains("no library entry"));
		JsonObject none = new JsonObject();
		none.add("lots", new JsonArray());
		assertTrue(PlanChecks.lotProblem(none, Map.of("h1", "x")).contains("not a lot"));
	}
}
