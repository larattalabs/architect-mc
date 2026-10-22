package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (6c close-out A, §2, §3, §14; docs/CONTRACT.md "Phase 6c close-out A"): plans' last use and the world-start sweep (7 days unkeyed, 30
 * keyed, from the last use), discard's tombstone and its held rules, keyed artifact pins (their end at the key's realise, their sweep
 * from their last use, an unpin), and an old pins file.
 */
class PlanRetentionTest {
	static final long DAY = 24L * 3600 * 1000;
	static final String A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

	@TempDir
	Path w;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@AfterEach
	void clock() {
		PlanRetention.clockOffset(0);
		PlanRetention.DISCARDED_KEYS.clear();
	}

	private Path plans() throws IOException {
		Path p = PlanRetention.plans(w);
		Files.createDirectories(p);
		return p;
	}

	/** A plan file (and its key file when {@code key}), last used now. */
	private void plan(String id, String key) throws IOException {
		Path p = plans();
		JsonObject o = new JsonObject();
		o.addProperty("planId", id);
		RegionStore.writeJson(p.resolve(id + ".json"), o);
		Files.write(p.resolve(id + ".survey.bin"), new byte[] {1, 2, 3});
		if (key != null) {
			JsonObject k = new JsonObject();
			k.addProperty("owner", "steward");
			k.addProperty("opKey", key);
			k.addProperty("opHash", "h-" + key);
			k.addProperty("planId", id);
			RegionStore.writeJson(p.resolve(id + ".key.json"), k);
		}
		PlanRetention.touchAt(w, id);
	}

	/** An artifact of a plan, with plain pins. */
	private void artifact(String sha, String planId, String... owners) throws IOException {
		Path dir = PlanChecks.artifacts(w);
		Files.createDirectories(dir);
		RegionStore.writeJson(dir.resolve(sha + ".json"), new JsonObject());
		JsonObject meta = new JsonObject();
		meta.addProperty("planId", planId);
		RegionStore.writeJson(dir.resolve(sha + ".meta.json"), meta);
		if (owners.length > 0) {
			JsonObject p = new JsonObject();
			JsonArray a = new JsonArray();
			for (String o : owners) {
				a.add(o);
			}
			p.add("owners", a);
			RegionStore.writeJson(dir.resolve(sha + ".pins.json"), p);
		}
	}

	private boolean alive(String sha) {
		return Files.isRegularFile(PlanChecks.artifacts(w).resolve(sha + ".json"));
	}

	private boolean tomb(String sha) {
		return Files.isRegularFile(PlanChecks.artifacts(w).resolve(sha + ".removed.json"));
	}

	private boolean planThere(String id) {
		return Files.isRegularFile(PlanRetention.plans(w).resolve(id + ".json"));
	}

	@Test
	void sweepAgesFromLastUseNotCreation() throws IOException {
		plan("k_touched", "vplan:1");
		plan("k_idle", "vplan:2");
		plan("u_touched", null);
		plan("u_idle", null);
		PlanRetention.clockOffset(29 * DAY);
		PlanRetention.touchAt(w, "k_touched"); // Steward's world-start lookup of its keyed plan
		PlanRetention.touchAt(w, "u_touched");
		PlanRetention.clockOffset(35 * DAY);
		List<String> swept = PlanRetention.sweepAt(null, w);
		assertEquals(List.of("k_idle", "u_idle"), swept);
		assertTrue(planThere("k_touched"), "a keyed plan touched at day 29 survives a sweep at day 35");
		assertTrue(planThere("u_touched"), "6 days since its last use: under 7");
		assertFalse(planThere("k_idle"));
		assertFalse(Files.exists(PlanRetention.plans(w).resolve("k_idle.survey.bin")));
		assertFalse(Files.exists(PlanRetention.plans(w).resolve("k_idle.key.json")));
		assertTrue(PlanRetention.discardedAt(w, "k_idle"));
		// the discarded keyed plan's key answers PLAN_STALE (its tombstone keeps the key and body hash)
		String[] gone = PlanRetention.DISCARDED_KEYS.get(RegionKeys.scope("steward", "region.plan", "vplan:2"));
		assertNotNull(gone);
		assertEquals("k_idle", gone[0]);
		assertEquals("h-vplan:2", gone[1]);
		PlanRetention.DISCARDED_KEYS.clear();
		PlanRetention.loadTombstones(w);
		assertNotNull(PlanRetention.DISCARDED_KEYS.get(RegionKeys.scope("steward", "region.plan", "vplan:2")), "after a restart too");
		// the helper's dirs wait for its connect
		JsonObject pend = RegionStore.readJson(PlanRetention.plans(w).resolve("discard-pending.json"));
		assertEquals(2, pend.getAsJsonArray("plans").size());
	}

	@Test
	void unkeyedSevenKeyedThirty() throws IOException {
		plan("u", null);
		plan("k", "k1");
		PlanRetention.clockOffset(8 * DAY);
		assertEquals(List.of("u"), PlanRetention.sweepAt(null, w));
		PlanRetention.clockOffset(31 * DAY);
		assertEquals(List.of("k"), PlanRetention.sweepAt(null, w));
	}

	@Test
	void aPinnedArtifactHoldsItsPlanAndAnUnpinnedOneGoesWithIt() throws IOException {
		plan("held", null);
		plan("free", null);
		artifact(A, "held", "steward");
		artifact(B, "free");
		assertNotNull(PlanRetention.held(w, "held"));
		assertEquals("pinned", PlanRetention.held(w, "held")[0]);
		assertNull(PlanRetention.held(w, "free"));
		PlanRetention.clockOffset(60 * DAY);
		assertEquals(List.of("free"), PlanRetention.sweepAt(null, w));
		assertTrue(alive(A));
		assertFalse(alive(B), "the discarded plan's unpinned artifact goes");
		assertTrue(tomb(B));
	}

	@Test
	void keyedPinsEndAtTheKeysRealiseAndAreSweptFromTheirLastUse() throws IOException {
		plan("p1", null);
		artifact(A, "p1");
		artifact(B, "p1");
		artifact(C, "p1", "steward"); // a plain pin
		PlanChecks.pinKeyedAt(w, A, "steward", "vrealise");
		PlanChecks.pinKeyedAt(w, B, "steward", "vrealise"); // the re-check's
		PlanChecks.pinKeyedAt(w, C, "steward", "vrealise");
		PlanChecks.pinKeyedAt(w, C, "other", "vrealise"); // another owner's key
		assertTrue(alive(A) && alive(B) && alive(C));
		// the key's realise: every keyed pin of (steward, vrealise) ends; plain pins and other owners' stay
		PlanChecks.keyedAt(w, "steward", "vrealise", true);
		assertFalse(alive(A), "no pin, no region: tombstone");
		assertFalse(alive(B));
		assertTrue(alive(C));
		JsonObject pc = RegionStore.readJson(PlanChecks.artifacts(w).resolve(C + ".pins.json"));
		assertEquals("[\"steward\"]", pc.get("owners").toString());
		assertEquals(1, pc.getAsJsonArray("keyed").size());
		assertEquals("other", pc.getAsJsonArray("keyed").get(0).getAsJsonObject().get("owner").getAsString());
	}

	@Test
	void keyedPinsSweptThirtyDaysAfterTheirLastUse() throws IOException {
		plan("p2", null);
		artifact(A, "p2");
		artifact(B, "p2");
		PlanChecks.pinKeyedAt(w, A, "steward", "k_a");
		PlanChecks.pinKeyedAt(w, B, "steward", "k_b");
		PlanRetention.clockOffset(29 * DAY);
		PlanChecks.pinKeyedAt(w, A, "steward", "k_a"); // re-pinned at day 29
		PlanRetention.clockOffset(35 * DAY);
		assertEquals(1, PlanChecks.sweepKeyedPinsAt(w));
		assertTrue(alive(A));
		assertFalse(alive(B));
		// a realise attempt under the key refreshes the pin's last use
		PlanRetention.clockOffset(60 * DAY);
		PlanChecks.keyedAt(w, "steward", "k_a", false);
		PlanRetention.clockOffset(70 * DAY);
		assertEquals(0, PlanChecks.sweepKeyedPinsAt(w));
		assertTrue(alive(A));
	}

	@Test
	void anOldPinsFileReadsAsPlainPins() throws IOException {
		plan("p3", null);
		artifact(A, "p3", "steward");
		assertEquals("pinned", PlanRetention.held(w, "p3")[0]);
		PlanRetention.clockOffset(400 * DAY);
		assertEquals(0, PlanChecks.sweepKeyedPinsAt(w));
		assertTrue(alive(A), "a plain pin never expires");
	}

	@Test
	void aRemovedRegionsPlanAgesFromTheRemoval() throws IOException {
		plan("p4", null);
		assertEquals(0, RegionsImpl.removedAtOfPlan("p4"));
		PlanRetention.clockOffset(6 * DAY);
		assertTrue(PlanRetention.sweepAt(null, w).isEmpty());
	}
}
