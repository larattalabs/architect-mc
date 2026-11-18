package dev.larattalabs.architect.txn;

import static dev.larattalabs.architect.txn.TxnCrashModel.obj;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.begin;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.fx;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.it;
import static dev.larattalabs.architect.txn.TxnCrashModelTest.run;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.TxnCrashModel.Naive;
import dev.larattalabs.architect.txn.TxnCrashModel.Result;
import dev.larattalabs.architect.txn.TxnCrashModel.Scenario;
import dev.larattalabs.architect.txn.TxnCrashModel.World;
import org.junit.jupiter.api.Test;

/**
 * (slice T2b) The owed kinds in the crash model, at every kill point and every combination of persisted versions, recovery crashed at its own
 * points (depth 2): {@code owed.collect} (the entry's debit, L, then the give to the player, P) and {@code owed.credit} (the entry's debit
 * and the stock's credit in one ledger change). Failing first: the legacy shapes, with no txn (NO_JOURNAL): a collect that gives the player
 * the items and lets the ledger save later (the player's file can reach the disk first: paid twice), and a credit as two ledger writes (a
 * crash between them loses it).
 */
class TxnOwedModelTest {
	final TxnCrashModel m = new TxnCrashModel();

	static final Scenario COLLECT = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("player:P", true, false, obj());
			w.add("ledger", false, true, obj("owed", it("planks", 10)));
		}

		@Override
		public void op(World w) {
			if (w.naive == Naive.NO_JOURNAL) {
				TxnCrashModel.Store p = w.store("player:P");
				JsonObject ps = p.edit();
				TxnCrashModel.addItems(ps, "inv", it("planks", 10), +1);
				p.set(ps);
				w.kill("legacy:given");
				TxnCrashModel.Store l = w.store("ledger");
				JsonObject ls = l.edit();
				TxnCrashModel.addItems(ls, "owed", it("planks", 10), -1);
				l.set(ls);
				w.kill("legacy:debited");
				w.barrier();
				return;
			}
			TxnEntry t = begin(w, "move", null, "owed:k", "player:P");
			w.core.plan(t, fx("unowe", EffectClass.L, "ledger", it("planks", 10), "owed", Effect.TRANSIT));
			w.core.plan(t, fx("give", EffectClass.P, "player:P", it("planks", 10), Effect.TRANSIT, "player"));
			run(w, t);
		}
	};

	static final Scenario CREDIT = new Scenario() {
		@Override
		public void setup(World w) {
			w.add("ledger", false, true, obj("owed", it("planks", 10)));
		}

		@Override
		public void op(World w) {
			TxnCrashModel.Store l = w.store("ledger");
			if (w.naive == Naive.NO_JOURNAL) {
				JsonObject a = l.edit();
				TxnCrashModel.addItems(a, "owed", it("planks", 10), -1);
				l.set(a);
				l.save();
				w.kill("legacy:debit saved");
				JsonObject b = l.edit();
				TxnCrashModel.addItems(b, "stock", it("planks", 10), +1);
				l.set(b);
				l.save();
				w.kill("legacy:credit saved");
				return;
			}
			TxnEntry t = begin(w, "move", null, "owed:k");
			// one ledger change: the model's two effects on the one ledger store, each marked; production applies them as one
			w.core.plan(t, fx("unowe", EffectClass.L, "ledger", it("planks", 10), "owed", Effect.TRANSIT));
			w.core.plan(t, fx("credit", EffectClass.L, "ledger", it("planks", 10), Effect.TRANSIT, "stock"));
			run(w, t);
		}
	};

	Result failingFirst(String name, Scenario sc) {
		Result red = m.explore(sc, Naive.NO_JOURNAL, 2);
		assertFalse(red.clean(), name + ": the legacy shape must be found failing first");
		Result green = m.explore(sc, Naive.NONE, 2);
		assertTrue(green.clean(), name + " as built: " + green.violations());
		System.out.println(name + ": legacy " + red.violations().size() + " violation(s), e.g. " + red.violations().get(0) + "; as built clean over "
			+ green.schedules() + " schedules");
		return green;
	}

	@Test
	void aCollectGivesExactlyOnceAcrossEveryCrash() {
		failingFirst("owed.collect", COLLECT);
	}

	@Test
	void aCreditToStockIsOneLedgerChange() {
		failingFirst("owed.credit", CREDIT);
	}
}
