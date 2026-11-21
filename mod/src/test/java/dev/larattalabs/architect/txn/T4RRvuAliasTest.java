package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-L; the fix round's P2 "RVU aliases precede D", kept) A revision undo's stage removal answers Steward's kill points at its
 * {@code removal.group} txn's own points, through the production core and {@link RemovalTxn#GROUP_KIND}'s alias: RVU1 only once the
 * committed journal undo is adopted (its D applied and the txn's {@code decision: commit} written), RVU2 at its effects' barrier (after D,
 * after every member barrier, before its REMOVAL_FINISHED). A stage txn without a revision answers neither.
 */
class T4RRvuAliasTest {
	/** Records the order of kills, barriers, writes (with the entry's decision) and emits. */
	static final class Env implements TxnEnv {
		final List<String> log = new ArrayList<>();
		String lastDecision = "none";

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject doc) {
					lastDecision = "none";
					for (String part : new String[] {"open", "retiring"}) {
						if (doc.get(part) instanceof com.google.gson.JsonArray a) {
							for (JsonElement e : a) {
								if (e.getAsJsonObject().get("decision") instanceof JsonElement d && !d.isJsonNull()) {
									lastDecision = d.toString().contains(Decision.COMMIT) ? "commit" : d.toString();
								}
							}
						}
					}
					log.add("write:" + lastDecision);
					return DurableFile.Outcome.OK;
				}

				@Override
				public DurableFile.Outcome confirm() {
					return DurableFile.Outcome.OK;
				}

				@Override
				public boolean inDoubt() {
					return false;
				}
			};
		}

		@Override
		public Barrier barrier() {
			log.add("barrier");
			return Barrier.ok(List.of());
		}

		@Override
		public boolean satisfied(Await a) {
			return true;
		}

		@Override
		public void kill(String point) {
			if (point.startsWith("RVU")) {
				log.add(point + "@" + lastDecision);
			}
		}

		@Override
		public boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
			log.add("emit:" + event);
			return true;
		}

		@Override
		public long tick() {
			return 0;
		}

		@Override
		public long wall() {
			return 0;
		}
	}

	static List<String> run(boolean revision) throws Exception {
		Env env = new Env();
		TxnCore c = new TxnCore(env);
		c.register(RemovalTxn.GROUP_KIND);
		c.load(null, null);
		java.lang.reflect.Field probe = RemovalTxn.class.getDeclaredField("UNDO_COMMITTED");
		probe.setAccessible(true);
		Object was = probe.get(null);
		probe.set(null, (java.util.function.Predicate<String>) g -> true); // the stage's undo committed in the journal
		try {
			TxnEntry t = c.begin(RemovalTxn.GROUP, "group:g/s1@u:stage-g-s1:1", List.of("site:group:g/s1"), null).entry();
			c.plan(t, RemovalTxn.undoDecision("u:stage-g-s1:1"));
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member("m1"));
			JsonObject p = new JsonObject();
			p.addProperty("kind", "group");
			p.addProperty("group", "g");
			p.addProperty("stage", "s1");
			if (revision) {
				p.addProperty("revisionId", 7);
			}
			c.payload(t, "removal_finished", p);
			assertEquals(DurableFile.Outcome.OK, c.persist(t));
			c.drive(t);
			return env.log;
		} finally {
			probe.set(null, was);
		}
	}

	@Test
	void rvuAliasesFollowTheAdoptedDecision() throws Exception {
		System.out.println("ROW T4RL-rvu (unit)");
		List<String> log = run(true);
		System.out.println("ROW T4RL-rvu order: " + log);
		int rvu1 = log.indexOf("RVU1@commit");
		int firstCommit = log.indexOf("write:commit");
		int rvu2 = log.indexOf("RVU2@commit");
		int emit = log.indexOf("emit:removal_finished");
		int lastBarrier = log.lastIndexOf("barrier");
		assertTrue(log.stream().noneMatch(x -> x.startsWith("RVU") && !x.endsWith("@commit")), "T4RL-rvu: an RVU alias fired before the txn wrote its commit: "
			+ log);
		assertTrue(rvu1 > firstCommit && firstCommit >= 0, "T4RL-rvu: RVU1 after the adopted commit is written: " + log);
		assertTrue(rvu2 > rvu1 && rvu2 > lastBarrier && lastBarrier > rvu1, "T4RL-rvu: RVU2 at the effects barrier, after D and every member barrier: "
			+ log);
		assertTrue(emit > rvu2, "T4RL-rvu: RVU2 before its REMOVAL_FINISHED: " + log);
		List<String> plain = run(false);
		assertTrue(plain.stream().noneMatch(x -> x.startsWith("RVU")), "T4RL-rvu: a stage removal with no revision answers no RVU point: " + plain);
	}
}
