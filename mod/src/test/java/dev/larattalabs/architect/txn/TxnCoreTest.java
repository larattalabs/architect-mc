package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile.Outcome;
import dev.larattalabs.architect.txn.TxnRecovery.Action;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T1) The core without crashes: the §3.6 table cell by cell, the format-1 schema (versioned, validated, quarantine), begin's
 * attempt/dedupe rules and holds, the result cache's bound, and ops resolve's refusals.
 */
class TxnCoreTest {
	final TxnCrashModel m = new TxnCrashModel();

	TxnCrashModel.World world() {
		return m.fresh(TxnCrashModelTest.MOVE, TxnCrashModel.Naive.NONE);
	}

	/** Every cell of docs/TXN-DESIGN.md §3.6's table: decision × phase × D probe × live. */
	@Test
	void theRecoveryTableIsTheDesignsTable() {
		Decision[] ds = {null, Decision.commit(), Decision.abort(), Decision.abandon(java.util.Set.of("m1"))};
		Probe[] dps = {null, Probe.ABSENT, Probe.APPLIED, Probe.UNKNOWN};
		int cells = 0;
		for (Decision d : ds) {
			for (Phase p : Phase.values()) {
				for (Probe dp : dps) {
					for (boolean live : new boolean[] {true, false}) {
						Action a = TxnRecovery.TABLE.next(d, p, dp, live);
						Action want;
						if (d == null) {
							if (dp == Probe.APPLIED) {
								want = Action.ADOPT_COMMIT; // the external decision happened
							} else if (dp == Probe.UNKNOWN) {
								want = Action.HOLD; // never compensate
							} else if (p == Phase.PREPARED) {
								want = live ? Action.PREPARE : Action.ABORT;
							} else if (p == Phase.PREPARED_DONE) {
								want = live ? Action.DECIDE : Action.ABORT; // the default is abort
							} else {
								want = Action.QUARANTINE;
							}
						} else if (d.isCommit()) {
							want = Map.of(Phase.PREPARED_DONE, Action.REDO, Phase.EFFECTS_DONE, Action.FINISH, Phase.RETIRING, Action.AWAIT).getOrDefault(p,
								Action.QUARANTINE);
						} else if (d.isAbort()) {
							want = Map.of(Phase.ABORTING, Action.COMPENSATE, Phase.RETIRING, Action.AWAIT).getOrDefault(p, Action.QUARANTINE);
						} else {
							want = Map.of(Phase.PREPARED_DONE, Action.SPLIT, Phase.EFFECTS_DONE, Action.FINISH, Phase.RETIRING, Action.AWAIT).getOrDefault(p,
								Action.QUARANTINE);
						}
						assertEquals(want, a, d + " × " + p + " × " + dp + " × live " + live);
						cells++;
					}
				}
			}
		}
		assertEquals(4 * 5 * 4 * 2, cells);
		// a decided entry never compensates (no COMPENSATE outside abort), and EFFECTS_DONE under a commit stays forward
		Map<Action, Integer> seen = new EnumMap<>(Action.class);
		for (Phase p : Phase.values()) {
			seen.merge(TxnRecovery.TABLE.next(Decision.commit(), p, null, false), 1, Integer::sum);
		}
		assertNull(seen.get(Action.COMPENSATE));
		assertNull(seen.get(Action.ABORT));
	}

	@Test
	void theSchemaRoundTripsAndKeepsTheDecisionBesideThePhase() {
		TxnCrashModel.World w = world();
		TxnEntry t = TxnCrashModelTest.begin(w, "move", "move:1", "box:X", "box:Y");
		w.core.plan(t, TxnCrashModelTest.fx("take", EffectClass.B, "chunk:X", Map.of("planks", 12), "crate", Effect.TRANSIT).prepare());
		w.core.plan(t, TxnCrashModelTest.fx("put", EffectClass.B, "chunk:Y", Map.of("planks", 12), Effect.TRANSIT, "chest"));
		w.core.payload(t, "site_removed", obj("id", "s1"));
		assertEquals(Outcome.OK, w.core.persist(t));
		JsonObject doc = w.store("txn").disk;
		assertEquals(TxnCore.FORMAT, doc.get("format").getAsInt());
		assertEquals(2, doc.get("next").getAsLong());
		JsonObject e = doc.getAsJsonArray("open").get(0).getAsJsonObject();
		assertTrue(e.get("decision").isJsonNull(), "undecided is null, never a journal descriptor (round 4 P3)");
		assertEquals("txn", e.getAsJsonObject("decider").get("kind").getAsString());
		assertEquals("PREPARED", e.get("phase").getAsString());
		assertEquals("s1", e.getAsJsonObject("payloads").getAsJsonObject("site_removed").get("id").getAsString(), "payloads are in the intent");
		TxnEntry back = TxnEntry.fromJson(e);
		assertEquals(t.toJson(), back.toJson());
		w.core.drive(t);
		JsonObject done = w.store("txn").disk.getAsJsonArray("done").get(0).getAsJsonObject();
		assertEquals("move:1", done.get("key").getAsString());
		assertEquals("commit", done.get("decision").getAsString());
		assertTrue(done.has("result"));
		assertThrows(IllegalStateException.class, () -> w.core.plan(t, Effect.of("put", EffectClass.B)), "a persisted plan is fixed");
	}

	@Test
	void badEntriesAreQuarantinedWithTheirResourcesHeldAndTheOthersLoad() {
		TxnCrashModel.World w = world();
		TxnEntry t = TxnCrashModelTest.begin(w, "move", null, "box:X", "box:Y");
		w.core.plan(t, TxnCrashModelTest.fx("take", EffectClass.B, "chunk:X", Map.of("planks", 12), "crate", Effect.TRANSIT).prepare());
		w.core.plan(t, TxnCrashModelTest.fx("put", EffectClass.B, "chunk:Y", Map.of("planks", 12), Effect.TRANSIT, "chest"));
		assertEquals(Outcome.OK, w.core.persist(t));
		JsonObject good = w.store("txn").disk.getAsJsonArray("open").get(0).getAsJsonObject();
		JsonObject doc = new JsonObject();
		doc.addProperty("format", 1);
		doc.addProperty("next", 9);
		JsonArray open = new JsonArray();
		open.add(good);
		JsonObject unknownKind = good.deepCopy();
		unknownKind.addProperty("id", "tx-5");
		unknownKind.addProperty("kind", "from.the.future");
		unknownKind.add("resources", arr("box:Q"));
		open.add(unknownKind);
		JsonObject newerKv = good.deepCopy();
		newerKv.addProperty("id", "tx-6");
		newerKv.addProperty("kv", 99);
		newerKv.add("resources", arr("box:R"));
		open.add(newerKv);
		JsonObject negative = good.deepCopy();
		negative.addProperty("id", "tx-7");
		negative.getAsJsonArray("effects").get(0).getAsJsonObject().getAsJsonObject("items").addProperty("planks", -3);
		negative.add("resources", arr("box:S"));
		open.add(negative);
		JsonObject impossible = good.deepCopy();
		impossible.addProperty("id", "tx-8");
		impossible.addProperty("phase", "EFFECTS_DONE"); // EFFECTS_DONE with no decision
		impossible.add("resources", arr("box:T"));
		open.add(impossible);
		doc.add("open", open);
		TxnCore c = w.newCore();
		c.load(doc, null);
		assertNull(c.loadFailed());
		assertEquals(1, c.open().size(), "the good entry loads");
		assertEquals(4, c.quarantined().size(), c.quarantined().toString());
		for (String r : List.of("box:Q", "box:R", "box:S", "box:T")) {
			assertNotNull(c.holds().holder(r), r + " stays held for ops");
		}
		assertEquals(5, c.toJson().getAsJsonArray("open").size(), "quarantined entries are kept in the file for ops");
		JsonObject newer = doc.deepCopy();
		newer.addProperty("format", 2);
		c.load(newer, null);
		assertNotNull(c.loadFailed(), "a newer format fails closed");
		assertEquals(TxnCore.Begin.UNAVAILABLE, c.begin("move", null, List.of("box:Z"), null).status());
		c.load(null, "unparseable");
		assertEquals(TxnCore.Begin.UNAVAILABLE, c.begin("move", null, List.of("box:Z"), null).status());
	}

	static JsonArray arr(String... xs) {
		JsonArray a = new JsonArray();
		for (String x : xs) {
			a.add(x);
		}
		return a;
	}

	@Test
	void beginAttachesToAnOpenKeyAndRefusesAHeldResourceWithItsDetail() {
		TxnCrashModel.World w = world();
		w.unknown.add("chunk:Y"); // the put can't be read: the txn stays open (committed, held)
		TxnEntry t = TxnCrashModelTest.begin(w, "move", "move:1", "box:X", "box:Y");
		w.core.plan(t, TxnCrashModelTest.fx("take", EffectClass.B, "chunk:X", Map.of("planks", 12), "crate", Effect.TRANSIT).prepare());
		w.core.plan(t, TxnCrashModelTest.fx("put", EffectClass.B, "chunk:Y", Map.of("planks", 12), Effect.TRANSIT, "chest"));
		TxnCrashModelTest.run(w, t);
		assertEquals(Decision.COMMIT, t.decision().v());
		assertEquals("chunk:Y", t.heldAt());
		TxnCore.Started again = w.core.begin("move", "move:1", List.of("box:X", "box:Y"), null);
		assertEquals(TxnCore.Begin.ATTACHED, again.status());
		assertEquals("held(decided) tx-1: chunk:Y", again.detail());
		TxnCore.Started other = w.core.begin("move", "move:2", List.of("box:Y"), null);
		assertEquals(TxnCore.Begin.HELD, other.status());
		assertEquals("held(other) tx-1: chunk:Y", other.detail());
		assertNull(w.core.holds().refusal(List.of("box:elsewhere")), "a hold is scoped to the txn's own resources");
		w.unknown.clear();
		w.core.tick();
		assertTrue(w.core.open().isEmpty());
		assertTrue(w.core.holds().isEmpty(), "released at retirement");
		assertEquals(TxnCore.Begin.REPLAYED, w.core.begin("move", "move:1", List.of("box:X"), null).status());
	}

	@Test
	void theResultCacheIsBoundedAndForgetsAnEvictedKey() {
		ResultCache c = new ResultCache(3, false);
		for (int i = 1; i <= 5; i++) {
			c.add(new ResultCache.Done("tx-" + i, "k" + i, "commit", obj("n", i), new JsonObject()));
		}
		assertEquals(3, c.size());
		assertNull(c.committed("k1"), "evicted");
		assertEquals(5, c.committed("k5").result().get("n").getAsInt());
		c.add(new ResultCache.Done("tx-6", "k5", "abort", new JsonObject(), new JsonObject()));
		assertEquals("tx-5", c.committed("k5").id(), "an aborted attempt never answers its key");
	}

	@Test
	void opsResolveRefusesAbortOverAnExternalCommitAndCommitBeforePreparedDone() {
		TxnCrashModel.World w = m.fresh(TxnCrashModelTest.REMOVAL, TxnCrashModel.Naive.NONE);
		w.store("journal").doubtWrites = 1;
		TxnCrashModelTest.REMOVAL.op(w);
		TxnEntry t = w.core.open().get(0);
		assertNull(t.decision());
		String why = w.core.resolve(t.id, "abort");
		assertNotNull(why, "abort refused while the decision probe is UNKNOWN (in doubt)");
		assertTrue(why.contains("UNKNOWN"), why);
		w.settle();
		assertTrue(w.core.open().isEmpty(), "confirmed: committed forward");
		assertEquals(12, TxnCrashModel.items(w.store("ledger").mem, "stock").get("planks"));
	}
}
