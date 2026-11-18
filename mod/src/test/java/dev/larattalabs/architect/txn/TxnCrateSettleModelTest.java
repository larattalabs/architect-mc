package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.addItems;
import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.begin;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.fx;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.it;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.run;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile.Outcome;
import dev.larattalabs.architect.txn.TxnCrashModel.Naive;
import dev.larattalabs.architect.txn.TxnCrashModel.Result;
import dev.larattalabs.architect.txn.TxnCrashModel.Scenario;
import dev.larattalabs.architect.txn.TxnCrashModel.Store;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (slice T2b part 2b) The {@code crate.settle} kind in the crash model, every kill point x every combination of persisted versions,
 * recovery crashed at its own points (depth 2). As built: the crate's stock stays in the crate through the removal's commit; one keyed
 * txn then takes it (B, prepare), owes it (O, the owed ledger keyed by the source's key) or credits it to the pile (L, keyed), restores
 * the crate's cell (W, {@code tx-n/i@restored}) and releases the crate's journal entry (R). Failing first (NO_JOURNAL): main's shape (the
 * stock taken and the cell restored at prepare, the stock dropped as an entity after the restore), and one case per P1 of CXD's last GPT
 * review (CXD-gpt2.log, round 2) in CXD's record-and-drop shape:
 * <ol>
 * <li>pickup evidence does not survive another crash (the record pays again);</li>
 * <li>an IN_DOUBT drop barrier discards the drops and reopens the record in memory only (no record, no payment);</li>
 * <li>a group's refunds reach the disk ahead of the queue's advance (the member resumes and pays again);</li>
 * <li>an unconfirmed put-back releases the fence (the builder consumes the stock, the open record pays it again).</li>
 * </ol>
 * The entity store {@code ents:crate} is an item entity beside the crate (an async chunk-entity save); {@code queue} is CXD's owed
 * record (the model's legacy resolver pays an open record at start).
 */
class TxnCrateSettleModelTest {
	final TxnCrashModel m = new TxnCrashModel();
	static final Map<String, Integer> S = it("planks", 10);

	static void move(World w, String store, String field, Map<String, Integer> items, int sign) {
		Store s = w.store(store);
		JsonObject o = s.edit();
		addItems(o, field, items, sign);
		s.set(o);
	}

	/** The settle txn as built: take, owe (or credit to a pile), restore the cell, release the crate's journal entry. */
	static TxnEntry settle(World w, String key, boolean pile) {
		TxnEntry t = begin(w, "move", key, "crate:c");
		w.core.plan(t, fx("take", EffectClass.B, "chunk:crate", S, "crate", Effect.TRANSIT).prepare());
		w.core.plan(t, (pile ? fx("credit", EffectClass.L, "ledger", S, Effect.TRANSIT, "stock") : fx("owe", EffectClass.O, "ledger", S, Effect.TRANSIT,
			"owed")).data("key", key));
		w.core.plan(t, Effect.of("restore", EffectClass.W).data("store", "chunk:crate"));
		w.core.plan(t, Effect.of("drop", EffectClass.R).data("store", "cj").data("id", "crate"));
		run(w, t);
		return t;
	}

	static void commitRemoval(World w) {
		Store j = w.store("journal");
		JsonObject s = j.edit();
		TxnCrashModel.put(s, "groups", "rm");
		j.set(s);
		j.save();
		w.kill("removal:committed");
	}

	static Scenario single(boolean pile) {
		return new Scenario() {
			@Override
			public void setup(World w) {
				w.add("chunk:crate", true, false, obj("items", S));
				w.add("ents:crate", true, false, obj());
				w.add("ledger", false, true, obj());
				w.add("journal", false, true, obj());
				w.add("cj", false, true, obj("records", obj("crate", obj())));
			}

			@Override
			public void op(World w) {
				if (w.naive == Naive.NO_JOURNAL) {
					// main: Builder.prepareDeconstruct takes the stock and restores the cell before the commit; dropDeconstruction drops it after
					move(w, "chunk:crate", "items", S, -1);
					w.kill("legacy:taken");
					commitRemoval(w);
					move(w, "ents:crate", "items", S, +1);
					w.kill("legacy:dropped");
					w.barrier();
					w.kill("legacy:saved");
					return;
				}
				commitRemoval(w);
				settle(w, "crate:s@1,2,3/site:s@1", pile);
			}
		};
	}

	/** P1-1: the owed entry is collected (P) after the settle; legacy: the dropped entity picked up, the record's close not yet on disk. */
	static final Scenario PICKUP = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("chunk:crate", true, false, obj("items", S));
			w.add("ents:crate", true, false, obj());
			w.add("player:P", true, false, obj());
			w.add("ledger", false, true, obj());
			if (w.naive == Naive.NO_JOURNAL) {
				w.add("queue", false, true, obj("records", obj()));
			} else {
				w.add("journal", false, true, obj());
				w.add("cj", false, true, obj("records", obj("crate", obj())));
			}
		}

		@Override
		public void op(World w) {
			if (w.naive == Naive.NO_JOURNAL) {
				Store q = w.store("queue");
				JsonObject qs = q.edit();
				qs.getAsJsonObject("records").add("k", obj("items", S)); // CXD: the record saved confirmed, then the take
				q.set(qs);
				q.save();
				move(w, "chunk:crate", "items", S, -1);
				w.kill("cxd:taken");
				move(w, "ents:crate", "items", S, +1); // the settle's tagged drop
				w.barrier();
				w.kill("cxd:dropped");
				move(w, "ents:crate", "items", S, -1); // a player picks it up (the FOUND evidence lives in memory only)
				move(w, "player:P", "inv", S, +1);
				w.barrier();
				w.kill("cxd:picked up");
				JsonObject c = q.edit();
				c.getAsJsonObject("records").remove("k");
				q.set(c);
				q.save();
				w.kill("cxd:closed");
				return;
			}
			commitRemoval(w);
			settle(w, "crate:s@1,2,3/site:s@1", false);
			TxnEntry t = begin(w, "move", null, "owed:crate:s", "player:P");
			w.core.plan(t, fx("unowe", EffectClass.L, "ledger", S, "owed", Effect.TRANSIT));
			w.core.plan(t, fx("give", EffectClass.P, "player:P", S, Effect.TRANSIT, "player"));
			run(w, t);
		}
	};

	/** P1-2: the settle's barrier IN_DOUBT; legacy: the drops discarded and the record reopened in memory only. */
	static final Scenario IN_DOUBT = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("chunk:crate", true, false, obj("items", S));
			w.add("ents:crate", true, false, obj());
			w.add("ledger", false, true, obj());
			if (w.naive == Naive.NO_JOURNAL) {
				w.add("queue", false, true, obj("records", obj("k", obj("items", S))));
				w.add("pre", false, false, obj()); // keeps the model's legacy resolver from settling the record before the op runs
			} else {
				w.add("journal", false, true, obj());
				w.add("cj", false, true, obj("records", obj("crate", obj())));
			}
		}

		@Override
		public void op(World w) {
			if (w.naive == Naive.NO_JOURNAL) {
				Store q = w.store("queue");
				// the record (saved before the op: setup) and the take; the settle drops, closes the record; its save is IN_DOUBT (on disk)
				JsonObject qs0 = q.edit();
				qs0.getAsJsonObject("records").remove("k");
				move(w, "chunk:crate", "items", S, -1);
				move(w, "ents:crate", "items", S, +1);
				q.set(qs0);
				q.doubtWrites = 1;
				Outcome o = q.save();
				w.kill("cxd:close " + o);
				move(w, "ents:crate", "items", S, -1); // not OK: the drops discarded, the record reopened in memory
				JsonObject re = q.edit();
				re.getAsJsonObject("records").add("k", obj("items", S));
				q.mem = re;
				w.barrier(); // the retry's preliminary barrier saves the entities' absence
				w.kill("cxd:retry barrier");
				q.save();
				w.kill("cxd:reopened");
				return;
			}
			commitRemoval(w);
			w.store("ledger").doubtWrites = 1; // the settle's barrier after the decision: in doubt (held, retried, never compensated)
			settle(w, "crate:s@1,2,3/site:s@1", false);
		}

		@Override
		public boolean heldAllowed() {
			return false;
		}
	};

	/** P1-3: member A's refunds; legacy: dropped, the queue's advance async, B's barrier saves A's drop first; A resumes from its record. */
	static final Scenario GROUP = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("ents:crate", true, false, obj());
			w.add("ledger", false, true, obj());
			if (w.naive == Naive.NO_JOURNAL) {
				w.add("queue", true, false, obj("records", obj("A", obj("items", S)))); // decItems of A in the saved queue (async)
			} else {
				w.add("chunk:A", true, false, obj("items", S)); // A's paid blocks standing: its refund comes out of their restore
			}
		}

		@Override
		public void op(World w) {
			if (w.naive == Naive.NO_JOURNAL) {
				Store q = w.store("queue");
				move(w, "ents:crate", "items", S, +1); // A's refunds drop
				JsonObject qs = q.edit();
				qs.getAsJsonObject("records").remove("A"); // A out of the queue (Placement.save, async)
				q.set(qs);
				w.kill("group:A settled");
				w.barrier(); // member B's settle barrier: chunks (A's drop) saved, the queue not
				w.kill("group:B barrier");
				q.save();
				w.kill("group:queue saved");
				return;
			}
			// as built: A's refund an O effect of A's keyed settle txn; the queue holds no amount (R-7)
			TxnEntry t = begin(w, "move", "site:A@1", "site:A");
			w.core.plan(t, fx("restore", EffectClass.W, "chunk:A", S, "site", Effect.TRANSIT));
			w.core.plan(t, fx("owe", EffectClass.O, "ledger", S, Effect.TRANSIT, "owed").data("key", "refund:site:A@1"));
			run(w, t);
		}
	};

	/** P1-4: the removal ends before its commit; legacy: put back, the record's cancel unsaved, the builder consumes, the chunk saved. */
	static final Scenario PUT_BACK = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("chunk:crate", true, false, obj("items", S));
			w.add("chunk:site", true, false, obj());
			w.add("ledger", false, true, obj());
			if (w.naive == Naive.NO_JOURNAL) {
				w.add("queue", false, true, obj("records", obj()));
			}
		}

		@Override
		public void op(World w) {
			if (w.naive == Naive.NO_JOURNAL) {
				Store q = w.store("queue");
				JsonObject qs = q.edit();
				qs.getAsJsonObject("records").add("k", obj("items", S));
				q.set(qs);
				q.save();
				move(w, "chunk:crate", "items", S, -1);
				w.kill("cxd:taken");
				move(w, "chunk:crate", "items", S, +1); // the commit failed: put back, OPEN dropped in memory
				JsonObject c = q.edit();
				c.getAsJsonObject("records").remove("k");
				q.set(c);
				q.failWrites = 1;
				q.save(); // refused: only logged, no retry
				w.kill("cxd:put back");
			} else {
				w.kill("removal:refused"); // as built: an end before the commit never touched the crate (no take, nothing to put back)
			}
			move(w, "chunk:crate", "items", S, -1); // the builder consumes the stock into the site
			move(w, "chunk:site", "items", S, +1);
			w.barrier();
			w.kill("built");
		}
	};

	/** {@code at}: the reviewer's counterexample, a crash at this legacy point, must be among the violations found. */
	Result failingFirst(String name, Scenario sc, String at) {
		Result red = m.explore(sc, Naive.NO_JOURNAL, 2);
		assertFalse(red.clean(), name + ": the legacy shape must be found failing first");
		var hit = red.violations().stream().filter(v -> v.schedule().contains(" " + at + " ")).findFirst();
		assertTrue(hit.isPresent(), name + ": the counterexample at " + at + " must be red; found " + red.violations());
		System.out.println("TXN-MODEL " + name + " counterexample: " + hit.get());
		Result green = m.explore(sc, Naive.NONE, 2);
		assertTrue(green.clean(), name + " as built: " + green.violations());
		System.out.println("TXN-MODEL " + name + ": legacy " + red.violations().size() + " violation(s), e.g. " + red.violations().get(0)
			+ "; as built clean over " + green.schedules() + " schedules");
		return green;
	}

	@Test
	void aSettleOwesTheCrateStockExactlyOnceAcrossEveryCrash() {
		failingFirst("crate.settle (owed)", single(false), "removal:committed");
	}

	@Test
	void aSettleCreditsAPileExactlyOnceAcrossEveryCrash() {
		failingFirst("crate.settle (pile)", single(true), "removal:committed");
	}

	@Test
	void cxdP1_1_pickupEvidenceIsTheOwedLedgerNotAnEntity() {
		failingFirst("CXD P1-1 pickup", PICKUP, "cxd:picked up");
	}

	@Test
	void cxdP1_2_anInDoubtSettleIsHeldNeverDiscarded() {
		failingFirst("CXD P1-2 in doubt", IN_DOUBT, "cxd:retry barrier");
	}

	@Test
	void cxdP1_3_groupRefundsAreKeyedEffectsNeverQueueAmounts() {
		failingFirst("CXD P1-3 group refunds", GROUP, "group:B barrier");
	}

	@Test
	void cxdP1_4_anEndBeforeTheCommitNeverTouchedTheCrate() {
		failingFirst("CXD P1-4 put-back fence", PUT_BACK, "built");
	}
}
