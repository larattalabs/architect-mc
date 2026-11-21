package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.Await;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.ResultCache;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnStore;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-M, the final check of eca131b6's P2) An aborted cargo txn's owed key never comes back in its group removal's result, however
 * many txns complete (the result cache is bounded: {@value ResultCache#MAX}) or restarts happen in between. The queue (the removal's entry,
 * which already holds the association) is the durable owner of the outcome. Through production: {@code Groups.cargoOwed} over a real
 * {@link TxnCore} and its cache, the queue entry's JSON round trip.
 */
class T4RMCargoAbortTest {
	static final class Env implements TxnEnv {
		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject doc) {
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
			return Barrier.ok(List.of());
		}

		@Override
		public boolean satisfied(Await a) {
			return true;
		}

		@Override
		public void kill(String point) {
		}

		@Override
		public boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
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

	TxnCore core;

	TxnCore install() throws Exception {
		TxnCore c = new TxnCore(new Env()).register(CargoTxn.KIND_DEF);
		c.load(null, null);
		core = c;
		return c;
	}

	@AfterEach
	void restore() throws Exception {
		OwedLedger.clear();
	}

	static void done(TxnCore c, String id, String decision) throws Exception {
		var add = ResultCache.class.getDeclaredMethod("add", ResultCache.Done.class);
		add.setAccessible(true);
		add.invoke(c.cache(), new ResultCache.Done(id, null, decision, new JsonObject(), new JsonObject()));
	}

	static void churn(TxnCore c, int n) throws Exception {
		for (int i = 0; i < n; i++) {
			done(c, "tx-churn" + i, "commit");
		}
	}

	@SuppressWarnings("unchecked")
	static List<String> owedField(Groups.Removal r) throws Exception {
		var f = Groups.Removal.class.getDeclaredField("cargoOwed");
		f.setAccessible(true);
		return (List<String>) f.get(r);
	}

	@Test
	void anAbortedCargoKeyNeverComesBack() throws Exception {
		System.out.println("ROW T4RM-cargo-abort (unit)");
		TxnCore c = install();
		OwedLedger.clear();
		String aborted = CargoTxn.oweKey("tx-7", 2, "cargo:t@1:1,2,3#0");
		String kept = CargoTxn.oweKey("tx-8", 2, "cargo:t@1:4,5,6#0");
		done(c, "tx-7", "abort"); // recovery compensated it (a crash after the queue's association, before its drive)
		done(c, "tx-8", "commit");
		OwedLedger.TEST_UNMARKED = true;
		try {
			OwedLedger.owe(new OwedLedger.Entry(kept, "tcc:o", "minecraft:overworld", 4, 5, 6, Map.of("minecraft:diamond_sword", 1), OwedLedger.CARGO, 0L, 0L, null, null),
				null);
		} finally {
			OwedLedger.TEST_UNMARKED = false;
		}
		Groups.Removal r = new Groups.Removal("g1", null, null, false);
		owedField(r).add(aborted);
		owedField(r).add(kept);
		assertEquals(List.of(kept), Groups.cargoOwed(r, core), "T4RM: while the abort is known, its key is out of the result");
		churn(c, ResultCache.MAX + 8);
		List<String> after = Groups.cargoOwed(r, core);
		System.out.println("ROW T4RM-cargo-abort after " + (ResultCache.MAX + 8) + " completions: " + after);
		assertEquals(List.of(kept), after, "T4RM: after the cache evicted the abort, its key stays out (the committed one stays in)");
		Groups.Removal b = Groups.Removal.fromJson(r.toJson());
		assertEquals(List.of(kept), Groups.cargoOwed(b, core), "T4RM: and after a restart (the queue entry reloaded)");
	}

	@Test
	void anAbortEvictedBeforeTheRemovalLookedIsStillOut() throws Exception {
		System.out.println("ROW T4RM-cargo-abort-unseen (unit)");
		TxnCore c = install();
		OwedLedger.clear();
		String aborted = CargoTxn.oweKey("tx-9", 2, "cargo:t@1:7,8,9#0");
		done(c, "tx-9", "abort");
		Groups.Removal r = new Groups.Removal("g2", null, null, false);
		owedField(r).add(aborted);
		churn(c, ResultCache.MAX + 8); // a stalled removal, never ticked meanwhile
		Groups.Removal b = Groups.Removal.fromJson(r.toJson());
		List<String> got = Groups.cargoOwed(b, core);
		System.out.println("ROW T4RM-cargo-abort-unseen: " + got);
		assertTrue(got.isEmpty(), "T4RM: a key whose txn owed nothing (no owed entry, ever) never reaches the result: " + got);
	}
}
