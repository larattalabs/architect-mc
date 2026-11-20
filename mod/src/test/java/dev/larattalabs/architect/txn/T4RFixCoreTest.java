package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R fix round, P1-1 and P1-2 of the T4R early review of df7b6afa) Compiled-core probes, as the reviewer ran them.
 * <ul>
 * <li>P1-1: a {@code removal.group} txn begins after its journal undo committed; its first barrier refused once must never abort it (it
 * acknowledges the committed undo: a journal decision), and a member is "done" only for a committed txn.</li>
 * <li>P1-2: a member barrier refused once, then the txn driven again: no effect after it runs before a barrier has passed over what came
 * before it, and the member never reads durable while every barrier since its effects was refused.</li>
 * </ul>
 */
class T4RFixCoreTest {
	/** A scripted env: each barrier answers the next scripted outcome (true = OK), OK once the script is spent; the store always writes. */
	static final class Env implements TxnEnv {
		final Deque<Boolean> script = new ArrayDeque<>();
		int barriers;
		boolean defaultOk = true;

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
			barriers++;
			Boolean ok = script.poll();
			return ok == null ? defaultOk ? Barrier.ok(List.of()) : Barrier.refused("scripted") : ok ? Barrier.ok(List.of()) : Barrier.refused("scripted");
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

	/** In-memory effects: applied (RAM) and durable (what a passed barrier published). */
	static final Set<String> RAM = new HashSet<>(), ORDER_VIOLATIONS = new HashSet<>();

	static final TxnKind.Adapter MEM = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return RAM.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			if (e.data().has("after")) {
				// a credit: the W it follows must have been published by a passed member barrier
				if (!t.durableThrough(e.data().get("after").getAsInt())) {
					ORDER_VIOLATIONS.add(e.key(t.id));
				}
			}
			RAM.add(e.key(t.id));
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			RAM.remove(e.key(t.id));
		}
	};

	static TxnKind memKind() {
		return new TxnKind() {
			@Override
			public String name() {
				return "mem";
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public TxnKind.Adapter adapter(Effect e) {
				return MEM;
			}
		};
	}

	@Test
	void p1_2_aRefusedMemberBarrierIsNeverSkippedOnARetry() {
		System.out.println("ROW T4R-P1-2 (unit)");
		RAM.clear();
		ORDER_VIOLATIONS.clear();
		Env env = new Env();
		TxnCore c = new TxnCore(env);
		c.register(memKind());
		c.load(null, null);
		TxnCore.Started s = c.begin("mem", "k", List.of("r"), null);
		TxnEntry t = s.entry();
		c.plan(t, Effect.of("w", EffectClass.W).member("b")); // 0: B's W
		c.plan(t, Effect.of("txn.barrier", EffectClass.R).member("b")); // 1
		c.plan(t, Effect.of("credit", EffectClass.L).member("b").data("after", 1)); // 2: B's credit, after barrier 1
		c.plan(t, Effect.of("txn.barrier", EffectClass.R).member("b")); // 3
		assertEquals(DurableFile.Outcome.OK, c.persist(t));
		env.script.add(true); // the prepare barrier
		env.defaultOk = false; // every barrier after it refused
		c.drive(t);
		c.drive(t);
		c.drive(t);
		System.out.println("ROW T4R-P1-2 after three drives (every member barrier refused): barriers " + env.barriers + ", credit applied " + RAM.contains(
			t.effects().get(2).key(t.id)) + ", durableThrough(3) " + t.durableThrough(3));
		assertTrue(ORDER_VIOLATIONS.isEmpty(), "T4R-P1-2: B's credit ran before a barrier published its W: " + ORDER_VIOLATIONS);
		assertFalse(t.durableThrough(3), "T4R-P1-2: B reads durable although every barrier since its effects was refused");
		assertFalse(RAM.contains(t.effects().get(2).key(t.id)), "T4R-P1-2: B was credited while its W's barrier is refused");
		env.defaultOk = true;
		c.drive(t);
		assertTrue(t.durableThrough(3) && ORDER_VIOLATIONS.isEmpty(), "T4R-P1-2: once a barrier passes, B is credited after its W and is durable");
	}

	@Test
	void p1_1_aCommittedGroupUndoIsNeverAbortedByItsTxn() throws Exception {
		System.out.println("ROW T4R-P1-1 (unit)");
		assertEquals("journal", RemovalTxn.GROUP_KIND.decider(), "T4R-P1-1: removal.group must be decided by its committed journal undo, not its file");
		Env env = new Env();
		TxnCore c = new TxnCore(env);
		c.register(RemovalTxn.GROUP_KIND);
		c.load(null, null);
		java.lang.reflect.Field probe = RemovalTxn.class.getDeclaredField("UNDO_COMMITTED");
		probe.setAccessible(true);
		Object was = probe.get(null);
		probe.set(null, (java.util.function.Predicate<String>) g -> true); // the journal holds the undo group: it committed
		try {
			TxnCore.Started s = c.begin(RemovalTxn.GROUP, "group:g@u:group-g:1", List.of("site:group:g"), null);
			TxnEntry t = s.entry();
			Effect.Builder d = (Effect.Builder) RemovalTxn.class.getDeclaredMethod("undoDecision", String.class).invoke(null, "u:group-g:1");
			c.plan(t, d);
			c.plan(t, Effect.of("txn.barrier", EffectClass.R).member("a"));
			assertEquals(DurableFile.Outcome.OK, c.persist(t));
			env.script.add(false); // its first barrier refused once
			c.drive(t);
			c.drive(t);
			assertNotNull(t.decision(), "T4R-P1-1: decided");
			assertTrue(t.decision().isCommit(), "T4R-P1-1: a refused barrier aborted a txn whose undo had committed: " + t.decision().v());
		} finally {
			probe.set(null, was);
		}
	}
}
