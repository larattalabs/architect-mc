package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.begin;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.fx;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.it;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.run;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.TxnCrashModel.Naive;
import dev.larattalabs.architect.txn.TxnCrashModel.Result;
import dev.larattalabs.architect.txn.TxnCrashModel.Scenario;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R, row T4R-group-model; P1-1 of the T4 combined final review) A group removal's members, A mostly unbuilt (the start's threshold
 * reads it "restored" whatever stands) and B built. The as-built group path ({@link Naive#NO_JOURNAL}): each member's restore is written in
 * memory, the member leaves the queue's remaining list at once, its settle (no W effect) is tried and its barrier refused, the advanced
 * queue is saved; at the start a member no longer in the remaining list is judged by the threshold (released, never written again) and the
 * queue's stash pays it: refunds owed while A's paid blocks stand. It must be found failing at GQ. The T4R path: one {@code removal.group}
 * txn, each member's W restore, a member barrier, its owe, a member barrier (op {@code txn.barrier}): clean over every schedule.
 * Stores: {@code chunk:a}, {@code chunk:b} the paid blocks standing; {@code queue} the group's remaining members and stashes; {@code ledger}
 * owed; {@code journal} the committed undo group; {@code sites} the pending records.
 */
class T4RGroupModelTest {
	final TxnCrashModel m = new TxnCrashModel();
	static final Map<String, Map<String, Integer>> MEMBERS = new LinkedHashMap<>();

	static {
		MEMBERS.put("a", it("planks", 4)); // mostly unbuilt: the threshold reads it restored
		MEMBERS.put("b", it("planks", 2));
	}

	static String chunk(String m) {
		return "chunk:" + m;
	}

	static boolean standing(World w, String m) {
		JsonObject it = w.store(chunk(m)).mem.getAsJsonObject("items");
		return it != null && it.entrySet().stream().anyMatch(e -> e.getValue().getAsInt() > 0);
	}

	static List<String> remaining(World w) {
		List<String> out = new java.util.ArrayList<>();
		if (w.store("queue").mem.get("remaining") instanceof JsonArray a) {
			a.forEach(x -> out.add(x.getAsString()));
		}
		return out;
	}

	static void setRemaining(World w, List<String> ids) {
		JsonObject q = w.store("queue").edit();
		JsonArray a = new JsonArray();
		ids.forEach(a::add);
		q.add("remaining", a);
		w.store("queue").set(q);
	}

	static boolean stashed(World w, String m) {
		return w.store("queue").mem.get("stash") instanceof JsonObject s && s.has(m);
	}

	/** The as-built settle of one member: its refund owed (no W before it), its stash dropped from the queue, the ledger's barrier. */
	static void settle(World w, String m, boolean barrierOk) {
		if (!stashed(w, m)) {
			return;
		}
		JsonObject l = w.store("ledger").edit();
		TxnCrashModel.addItems(l, "owed", MEMBERS.get(m), +1);
		w.store("ledger").set(l);
		if (!barrierOk) {
			return; // held: retried later (the owe stays in memory; the stash stays in the queue)
		}
		w.barrier();
		JsonObject q = w.store("queue").edit();
		q.getAsJsonObject("stash").remove(m);
		w.store("queue").set(q);
		w.store("queue").save();
	}

	/** The as-built start: a pending member out of the remaining list judged by the threshold, then the queue's stashes paid. */
	static void legacyStart(World w) {
		if (!(w.store("journal").mem.get("groups") instanceof JsonArray g) || g.isEmpty()) {
			return;
		}
		List<String> rem = remaining(w);
		for (String m : MEMBERS.keySet()) {
			if (!rem.contains(m)) {
				boolean restored = m.equals("a") || !standing(w, m); // Sites.reconcile's evidence: A mostly unbuilt reads restored
				if (!restored) {
					JsonObject c = w.store(chunk(m)).edit(); // F6 writeAgain: the group writes it again (roll forward)
					c.add("items", new JsonObject());
					w.store(chunk(m)).set(c);
				}
				settle(w, m, true); // settleWritten: the queue's stash for a member out of the list, paid
			}
		}
		for (String m : rem) {
			JsonObject c = w.store(chunk(m)).edit(); // the group resumes: written, then settled
			c.add("items", new JsonObject());
			w.store(chunk(m)).set(c);
			settle(w, m, true);
		}
		setRemaining(w, List.of());
		w.store("queue").save();
	}

	static Scenario scenario() {
		return new Scenario() {
			@Override
			public void setup(World w) {
				MEMBERS.forEach((k, v) -> w.add(chunk(k), true, false, obj("items", v)));
				w.add("ledger", false, true, obj());
				w.add("journal", false, true, obj());
				w.add("sites", false, true, obj());
				w.add("queue", false, true, obj());
				if (w.naive == Naive.NO_JOURNAL) {
					w.startHook = T4RGroupModelTest::legacyStart;
				}
			}

			@Override
			public void op(World w) {
				// the pre-save: the planned undo, its members and their stashes on disk before the commit
				JsonObject q = w.store("queue").edit();
				JsonObject st = new JsonObject();
				MEMBERS.forEach((k, v) -> st.add(k, obj("refund", v)));
				q.add("stash", st);
				w.store("queue").set(q);
				setRemaining(w, List.copyOf(MEMBERS.keySet()));
				w.store("queue").save();
				w.kill("presave");
				JsonObject js = w.store("journal").edit();
				TxnCrashModel.put(js, "groups", "u:group-g");
				w.store("journal").set(js);
				w.store("journal").save();
				w.kill("K6");
				if (w.naive == Naive.NO_JOURNAL) {
					for (String mm : MEMBERS.keySet()) {
						JsonObject c = w.store(chunk(mm)).edit(); // finishGroupDeconstruct: the restore in memory
						c.add("items", new JsonObject());
						w.store(chunk(mm)).set(c);
						List<String> rem = remaining(w);
						rem.remove(mm); // r.sites.remove(0): the member leaves the list before its settle
						setRemaining(w, rem);
						settle(w, mm, false); // its settle's barrier refused (held)
						w.store("queue").save(); // Placement.save: the advanced cursor
						w.kill("GQ");
						settle(w, mm, true); // the retry: its barrier OK
						w.kill("settled:" + mm);
					}
					return;
				}
				// T4R: one removal.group txn; per member its W restore, a member barrier, its owe, a member barrier
				TxnEntry t = begin(w, "move", "group:g@u:group-g", "group:g");
				for (var e : MEMBERS.entrySet()) {
					w.core.plan(t, fx("restore", EffectClass.W, chunk(e.getKey()), e.getValue(), "site", Effect.TRANSIT).member(e.getKey()));
					w.core.plan(t, Effect.of("txn.barrier", EffectClass.R).member(e.getKey()));
					w.core.plan(t, fx("owe", EffectClass.O, "ledger", e.getValue(), Effect.TRANSIT, "owed").data("key", "refund:" + e.getKey()).member(e
						.getKey()));
					w.core.plan(t, Effect.of("txn.barrier", EffectClass.R).member(e.getKey()));
				}
				// (fix round, P2 coverage) B's chunk write fails once: its member barrier is refused, the txn held; then the live retries drive it
				// again (each a full drive from the entry), and nothing of B is paid before a barrier published its W
				w.serializeFails.add(chunk("b"));
				run(w, t);
				for (int i = 0; i < 2 && w.core.get(t.id) != null; i++) {
					w.core.drive(t);
				}
				setRemaining(w, List.of());
				w.store("queue").save();
			}
		};
	}

	@Test
	void groupCrash_aMembersRefundIsPaidOnlyAfterItsWReceipts() {
		System.out.println("ROW T4R-group-model");
		Scenario sc = scenario();
		Result red = m.explore(sc, Naive.NO_JOURNAL, 2);
		assertFalse(red.clean(), "T4R-group-model: the as-built group path (no per-member W) must be found failing");
		var hit = red.violations().stream().filter(v -> v.schedule().contains(" GQ ")).findFirst();
		assertTrue(hit.isPresent(), "T4R-group-model: the counterexample at GQ must be red; found " + red.violations());
		System.out.println("ROW T4R-group-model as-built counterexample: " + hit.get());
		Result green = m.explore(sc, Naive.NONE, 2);
		assertTrue(green.clean(), "T4R-group-model: the T4R group path: " + green.violations());
		System.out.println("ROW T4R-group-model: as-built " + red.violations().size() + " violation(s); the T4R path clean over " + green.schedules()
			+ " schedules");
	}
}
