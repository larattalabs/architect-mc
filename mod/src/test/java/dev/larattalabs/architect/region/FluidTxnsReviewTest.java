package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.txn.Await;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnStore;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (slice 8cTb review, P1-1) A fluids txn (the charge's shape: an L then an R, decided by the core after its prepare barrier) whose prepare
 * barrier is refused aborts having applied nothing. At 3f86e1ee {@code FluidTxns.after} read any retired attempt as DONE, so the gate
 * set {@code chargedAt} and wrote lava unpaid (GPT's in-memory probe: DONE, decision abort, applied 0). Now it is REFUSED and the caller
 * tries again; a later attempt with the barrier back commits and applies both effects once.
 */
class FluidTxnsReviewTest {
	static final class Env implements TxnEnv {
		int refuse;
		final List<String> points = new ArrayList<>();

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
			if (refuse > 0) {
				refuse--;
				return Barrier.refused("TEST: a player's save refused");
			}
			return Barrier.ok(List.of());
		}

		@Override
		public boolean satisfied(Await a) {
			return true;
		}

		@Override
		public void kill(String point) {
			points.add(point);
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

	/** Counts the applies of each op (a ledger debit, a record write). */
	static final class Kind implements TxnKind {
		final List<String> applied = new ArrayList<>();

		@Override
		public String name() {
			return "test.charge";
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public Adapter adapter(Effect e) {
			return new Adapter() {
				@Override
				public Probe probe(TxnEntry t, Effect x) {
					return applied.contains(t.id + "/" + x.op()) ? Probe.APPLIED : Probe.ABSENT;
				}

				@Override
				public void apply(TxnEntry t, Effect x) {
					applied.add(t.id + "/" + x.op());
				}

				@Override
				public void compensate(TxnEntry t, Effect x) {
					throw new IllegalStateException("never");
				}
			};
		}
	}

	@Test
	void anAbortedChargeIsNeverDone() {
		Env env = new Env();
		Kind k = new Kind();
		TxnCore core = new TxnCore(env).register(k);
		core.load(null, null);
		env.refuse = 2; // the prepare barrier and the abort's own barrier... the abort retires once one of them passes
		TxnCore.Started s = core.begin("test.charge", "region:r@1:fluids:charge", List.of("charge:r"), null);
		TxnEntry t = s.entry();
		core.plan(t, Effect.of("pile.charge", EffectClass.L).items(java.util.Map.of("minecraft:lava_bucket", 2)));
		core.plan(t, Effect.of("region.charged", EffectClass.R));
		assertEquals(DurableFile.Outcome.OK, core.persist(t));
		env.refuse = 1; // only the prepare barrier: the abort's barrier passes, the attempt retires
		core.drive(t);
		assertTrue(t.decision() != null && t.decision().isAbort(), "the refused prepare barrier aborts");
		assertTrue(k.applied.isEmpty(), "nothing applied");
		assertEquals(FluidTxns.Step.Kind.REFUSED, FluidTxns.after(core, t).kind(), "an aborted charge is not charged: the gate never goes on as if it were");
		// the caller's next attempt (a fresh one: an abort never answers the key) commits and applies both effects once
		TxnCore.Started s2 = core.begin("test.charge", "region:r@1:fluids:charge", List.of("charge:r"), null);
		assertEquals(TxnCore.Begin.NEW, s2.status());
		TxnEntry t2 = s2.entry();
		core.plan(t2, Effect.of("pile.charge", EffectClass.L).items(java.util.Map.of("minecraft:lava_bucket", 2)));
		core.plan(t2, Effect.of("region.charged", EffectClass.R));
		core.persist(t2);
		core.drive(t2);
		assertEquals(FluidTxns.Step.Kind.DONE, FluidTxns.after(core, t2).kind());
		assertEquals(List.of(t2.id + "/pile.charge", t2.id + "/region.charged"), k.applied);
	}
}
