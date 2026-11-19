package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.addItems;
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
import dev.larattalabs.architect.txn.TxnCrashModel.Store;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T4a) The legacy kinds of T2b's removal refunds (the T4 base, docs/CONTRACT.md "Phase T4" §0, findings 1-3 of the T2b last-round
 * review), each red at the reviewer's kill point, and T4's planned shape (a removal's refund paid only after every one of its W chunk
 * receipts: W per chunk, then the O owe, as {@code TxnCrateSettleModelTest.GROUP}'s as built) clean over every schedule, recovery crashed
 * at its own points (depth 2). The legacy start ({@link World#startHook}) is the base's Sites check, its pending-settle resume and its
 * durable-stash sweep, reduced to their decisions:
 * <ul>
 * <li>the evidence is a threshold, not a receipt: a site mostly unbuilt reads "restored" while its paid blocks stand; a 40% site reads
 * neither (KEEP), and KEEP settles its stash (1a);</li>
 * <li>a shared crate's member has no CRATE entry, so its RELEASE writes nothing before the sweep pays (1b);</li>
 * <li>the start writes the committed restore in memory, then releases the journal before the chunks are saved: a second crash keeps the
 * stash and loses the restore (2a); a failed write-now still pays through the queued settle (2b);</li>
 * <li>a road is judged by its majority, and the sweep pays any stash whose record is gone (3a).</li>
 * </ul>
 * Stores: {@code chunk:*} the paid blocks standing ({@code items}); {@code ledger} the stash (not counted) and {@code owed}; {@code journal}
 * the undo group; {@code sites} the record (standing, pending).
 */
class TxnRemovalModelT4Test {
	final TxnCrashModel m = new TxnCrashModel();
	static final Map<String, Integer> R = it("planks", 4);

	/** A legacy removal's shape: which chunks hold its paid blocks, and how the base's start judges and settles it. */
	record Legacy(Map<String, Map<String, Integer>> chunks, boolean unbuiltMajority, boolean writeNow, boolean writeNowFails, boolean road) {
		Map<String, Integer> refund() {
			Map<String, Integer> t = new LinkedHashMap<>();
			chunks.values().forEach(c -> c.forEach((k, v) -> t.merge(k, v, Integer::sum)));
			return t;
		}
	}

	static void move(World w, String store, String field, Map<String, Integer> items, int sign) {
		Store s = w.store(store);
		JsonObject o = s.edit();
		addItems(o, field, items, sign);
		s.set(o);
	}

	static void set(World w, String store, String field, boolean v) {
		Store s = w.store(store);
		JsonObject o = s.edit();
		o.addProperty(field, v);
		s.set(o);
	}

	static boolean flag(World w, String store, String field) {
		JsonObject o = w.store(store).mem;
		return o.has(field) && o.get(field).getAsBoolean();
	}

	static boolean committed(World w) {
		return w.store("journal").mem.get("groups") instanceof JsonArray a && !a.isEmpty();
	}

	static boolean standingIn(World w, String chunk) {
		JsonObject it = w.store(chunk).mem.getAsJsonObject("items");
		return it != null && it.entrySet().stream().anyMatch(e -> e.getValue().getAsInt() > 0);
	}

	/** The base's settle: the stash's refund owed, the stash and the pending record gone, published by a barrier (chunks, then the ledger). */
	static void settle(World w, Legacy l) {
		JsonObject ls = w.store("ledger").edit();
		if (!ls.has("stash")) {
			return;
		}
		ls.remove("stash");
		addItems(ls, "owed", l.refund(), +1);
		w.store("ledger").set(ls);
		w.barrier();
		set(w, "sites", "pending", false);
		w.store("sites").save();
	}

	/** The base's restore: each chunk's paid blocks gone (in memory: an async chunk save, or the next barrier, publishes it). */
	static void restore(World w, Legacy l, String chunk) {
		move(w, chunk, "items", l.chunks().get(chunk), -1);
	}

	/** The base's start for this removal (Sites.reconcile's K6 loop and pending loop, CrateSettle.resumeNow and sweep). */
	static void legacyStart(World w, Legacy l) {
		if (!w.store("ledger").mem.has("stash")) {
			return;
		}
		boolean pending = flag(w, "sites", "pending");
		if (!committed(w)) {
			if (pending) {
				settle(w, l); // group == null && p.settle() != null: its undo released, its settle not done: it settles (Sites:3306)
			} else if (flag(w, "sites", "stands")) {
				JsonObject ls = w.store("ledger").edit(); // the sweep: it stands, the removal never committed: the stash dropped
				ls.remove("stash");
				w.store("ledger").set(ls);
				w.store("ledger").save();
			} else {
				settle(w, l); // the sweep: no record, so "gone"
			}
			return;
		}
		set(w, "sites", "stands", false); // the K6 loop: the record follows the journal (pending)
		set(w, "sites", "pending", true);
		w.store("sites").save();
		int standing = 0;
		int all = 0;
		for (var c : l.chunks().entrySet()) {
			int n = c.getValue().values().stream().mapToInt(Integer::intValue).sum();
			all += n;
			if (standingIn(w, c.getKey())) {
				standing += n;
			}
		}
		boolean restored = l.road() ? standing * 2 <= all : standing == 0 || l.unbuiltMajority();
		if (!restored) {
			settle(w, l); // KEEP: CrateSettle.resumeLater pays the durable stash (Sites:3401)
			return;
		}
		if (l.writeNow()) {
			if (l.writeNowFails()) {
				settle(w, l); // the write failed ("stays pending, unsettled"), but the K6 loop's queued resumeLater pays (Sites:3246)
				return;
			}
			for (String c : l.chunks().keySet()) {
				if (standingIn(w, c)) {
					restore(w, l, c); // SiteJournal.writeNow: in memory
				}
			}
			w.kill("start:written");
		}
		Store j = w.store("journal"); // releaseAfter (Sites:3463): the journal release, the chunks not saved
		JsonObject js = j.edit();
		js.add("groups", new JsonArray());
		j.set(js);
		j.save();
		w.kill("KS1");
		settle(w, l); // RELEASE: settled on the next tick (resumeNow), or by the sweep for a record already dropped
	}

	static Scenario scenario(Legacy l) {
		return new Scenario() {
			@Override
			public void setup(World w) {
				l.chunks().forEach((c, items) -> w.add(c, true, false, obj("items", items)));
				w.add("ledger", false, true, obj());
				w.add("journal", false, true, obj());
				w.add("sites", false, true, obj("stands", true));
				if (w.naive == Naive.NO_JOURNAL) {
					w.startHook = x -> legacyStart(x, l);
				}
			}

			@Override
			public void op(World w) {
				if (w.naive == Naive.NO_JOURNAL) {
					JsonObject ls = w.store("ledger").edit(); // (T2b fix round P1-c) the stash with its refunds, saved confirmed before the commit
					ls.add("stash", obj("refund", l.refund()));
					w.store("ledger").set(ls);
					w.store("ledger").save();
					w.kill("stash saved");
					Store j = w.store("journal");
					JsonObject js = j.edit();
					TxnCrashModel.put(js, "groups", "rm");
					j.set(js);
					j.save();
					w.kill("K6");
					set(w, "sites", "stands", false);
					set(w, "sites", "pending", true);
					w.store("sites").save();
					w.kill("pending");
					for (String c : l.chunks().keySet()) {
						restore(w, l, c);
						w.kill(l.road() ? "K7" : "R4");
					}
					settle(w, l);
					w.kill("settled");
					return;
				}
				// T4's shape: the removal's W effect per chunk, then the refund owed once every one is DONE (one txn)
				TxnEntry t = begin(w, "move", "site:s@1", "site:s");
				for (var c : l.chunks().entrySet()) {
					w.core.plan(t, fx("restore", EffectClass.W, c.getKey(), c.getValue(), "site", Effect.TRANSIT));
				}
				w.core.plan(t, fx("owe", EffectClass.O, "ledger", l.refund(), Effect.TRANSIT, "owed").data("key", "refund:site:s@1"));
				run(w, t);
			}
		};
	}

	Result failingFirst(String name, Scenario sc, String at) {
		Result red = m.explore(sc, Naive.NO_JOURNAL, 2);
		assertFalse(red.clean(), name + ": the T4a base's shape must be found failing first");
		var hit = red.violations().stream().filter(v -> v.schedule().contains(" " + at + " ")).findFirst();
		assertTrue(hit.isPresent(), name + ": the counterexample at " + at + " must be red; found " + red.violations());
		System.out.println("TXN-MODEL " + name + " counterexample: " + hit.get());
		Result green = m.explore(sc, Naive.NONE, 2);
		assertTrue(green.clean(), name + ": T4's shape: " + green.violations());
		System.out.println("TXN-MODEL " + name + ": base " + red.violations().size() + " violation(s); T4's shape clean over " + green.schedules()
			+ " schedules");
		return green;
	}

	@Test
	void finding1a_aPartlyBuiltSitesKeepNeverPaysWhileItsBlocksStand() {
		failingFirst("1a K6 KEEP", scenario(new Legacy(Map.of("chunk:site", R), false, true, false, false)), "K6");
	}

	@Test
	void finding1b_aSharedCratesMemberIsPaidOnlyAfterItsRestore() {
		failingFirst("1b shared member", scenario(new Legacy(Map.of("chunk:site", R), true, false, false, false)), "K6");
	}

	@Test
	void finding2a_theStartsRestoreIsDurableBeforeItsJournalGoes() {
		failingFirst("2a second crash", scenario(new Legacy(Map.of("chunk:site", R), true, true, false, false)), "KS1");
	}

	@Test
	void finding2b_aFailedWriteNowPaysNothing() {
		failingFirst("2b write-now fails", scenario(new Legacy(Map.of("chunk:site", R), true, true, true, false)), "K6");
	}

	@Test
	void finding3a_aPartlyRestoredRoadIsNeverPaidByItsMajority() {
		Map<String, Map<String, Integer>> road = new LinkedHashMap<>();
		road.put("chunk:r1", it("gravel", 64));
		road.put("chunk:r2", it("gravel", 36));
		failingFirst("3a road majority", scenario(new Legacy(road, false, false, false, true)), "K7");
	}
}
