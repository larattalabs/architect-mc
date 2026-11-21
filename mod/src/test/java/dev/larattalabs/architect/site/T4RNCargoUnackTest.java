package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.Await;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnStore;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-N, the final check of f7607b13's P2 "phantom cargo key") A cargo txn whose take and prepare barrier passed, then whose
 * decision write was refused, has COMMIT in memory only: the acknowledged {@code txn.json} holds no decision, and recovery after a crash
 * aborts it (the stack goes back to its holder). The queue must never save its owed key in {@code cargoKept} on that unacknowledged
 * decision: {@link Groups#resolveCargo} leaves the key unresolved until the decision is on disk, and drops it once the abort is known.
 */
class T4RNCargoUnackTest {
	/** The holder's stack: present in the holder while not taken. */
	static final Set<String> TAKEN = new HashSet<>();

	static final TxnKind.Adapter TAKE = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return TAKEN.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TAKEN.add(e.key(t.id));
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			TAKEN.remove(e.key(t.id));
		}
	};

	static final TxnKind KIND = new TxnKind() {
		@Override
		public String name() {
			return "cargo.test";
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return TAKE;
		}
	};

	/** A store that keeps the last acknowledged file; {@code refuseDecided}: a write naming any decision is refused (nothing reaches disk). */
	static final class Env implements TxnEnv {
		JsonObject file;
		boolean refuseDecided;

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject doc) {
					if (refuseDecided && decided(doc)) {
						return DurableFile.Outcome.REFUSED;
					}
					file = doc.deepCopy();
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

		static boolean decided(JsonObject doc) {
			if (!(doc.get("open") instanceof com.google.gson.JsonArray a)) {
				return false;
			}
			for (JsonElement x : a) {
				JsonElement d = x.getAsJsonObject().get("decision");
				if (d != null && !d.isJsonNull()) {
					return true;
				}
			}
			return false;
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

	@Test
	void anUnacknowledgedCommitNeverSavesItsKey() throws Exception {
		System.out.println("ROW T4RN-cargo-unack (unit)");
		TAKEN.clear();
		OwedLedger.clear();
		Env env = new Env();
		TxnCore c = new TxnCore(env).register(KIND);
		c.load(null, null);
		TxnEntry t = c.begin(KIND.name(), "cargo-unack", List.of("cargo:t@1:0,65,0"), "owner").entry();
		c.plan(t, Effect.of("cargo.take", EffectClass.B).prepare());
		assertEquals(DurableFile.Outcome.OK, c.persist(t));
		String key = CargoTxn.oweKey(t.id, 0, "cargo:t@1:0,65,0#0");
		Groups.Removal r = new Groups.Removal("cargo-group", null, null, false);
		r.cargoOwed.add(key);
		env.refuseDecided = true; // the take and its barrier pass; the decision's write is refused
		c.drive(t);
		assertTrue(t.decision() != null && t.decision().isCommit() && c.unsynced() && !Env.decided(env.file),
			"fixture: COMMIT in memory only, the acknowledged file undecided");
		Groups.resolveCargo(r, c);
		JsonObject saved = r.toJson();
		System.out.println("ROW T4RN-cargo-unack: after resolveCargo on the unacknowledged commit: cargoOwed=" + r.cargoOwed + " cargoKept=" + r.cargoKept);
		assertTrue(r.cargoKept.isEmpty(), "T4RN-cargo-unack: an unacknowledged COMMIT was saved as kept: " + r.cargoKept);
		assertEquals(List.of(key), r.cargoOwed, "T4RN-cargo-unack: the key stays unresolved until its decision is durable");
		// the crash: the acknowledged image loads, recovery aborts the undecided txn (the stack back in its holder)
		Env re = new Env();
		TxnCore rc = new TxnCore(re).register(KIND);
		rc.load(env.file, null);
		rc.recover();
		Groups.Removal back = Groups.Removal.fromJson(saved);
		List<String> result = Groups.cargoOwed(back, rc);
		System.out.println("ROW T4RN-cargo-unack: after the crash and recovery: holder restored " + TAKEN.isEmpty() + ", result " + result + ", owed "
			+ OwedLedger.all().size());
		assertTrue(TAKEN.isEmpty(), "fixture: recovery aborted the take");
		assertTrue(result.isEmpty(), "T4RN-cargo-unack: the aborted txn's phantom owed key is in the result: " + result);
		assertTrue(back.cargoOwed.isEmpty(), "T4RN-cargo-unack: the known abort drops the key");
	}

	@Test
	void anAcknowledgedCommitIsKept() throws Exception {
		System.out.println("ROW T4RN-cargo-ack (unit)");
		TAKEN.clear();
		Env env = new Env();
		TxnCore c = new TxnCore(env).register(KIND);
		c.load(null, null);
		TxnEntry t = c.begin(KIND.name(), "cargo-ack", List.of("cargo:t@1:1,65,0"), "owner").entry();
		c.plan(t, Effect.of("cargo.take", EffectClass.B).prepare());
		assertEquals(DurableFile.Outcome.OK, c.persist(t));
		String key = CargoTxn.oweKey(t.id, 0, "cargo:t@1:1,65,0#0");
		Groups.Removal r = new Groups.Removal("cargo-group2", null, null, false);
		r.cargoOwed.add(key);
		c.drive(t);
		Groups.resolveCargo(r, c);
		assertEquals(List.of(key), r.cargoKept, "T4RN-cargo-ack: a durable COMMIT keeps its key");
	}
}
