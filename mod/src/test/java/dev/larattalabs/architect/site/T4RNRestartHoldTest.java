package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.txn.Await;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnStore;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-N, the final check of f7607b13's P1-1) Admission reads the removal holds loaded from disk. A group removal A that began its
 * {@code removal.group} txn (its {@code rbox} holds) and stalled, then a restart: its txn is open again in the loaded core, while the queue's
 * transient {@code gtx} is null until A's entry reattaches. A second removal B over an overlapping box (another owner, another box string, so
 * the core's own resource check never meets it) must still wait: before the fix {@link RemovalAreas#heldAreas} indexed only {@code r.gtx},
 * B began first after the restart and the two held each other for good.
 */
class T4RNRestartHoldTest {
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

	@Test
	void aLoadedGroupHoldIsSeenBeforeItsQueueEntryReattaches() throws Exception {
		System.out.println("ROW T4RN-restart-hold (unit)");
		java.lang.reflect.Field probe = RemovalTxn.class.getDeclaredField("UNDO_COMMITTED");
		probe.setAccessible(true);
		Object probeWas = probe.get(null);
		probe.set(null, (java.util.function.Predicate<String>) g -> true);
		try {
			// A's txn begun live over its member's box (its rbox hold), then the session stops
			TxnCore live = new TxnCore(new Env()).register(RemovalTxn.GROUP_KIND);
			live.load(null, null);
			String rboxA = RemovalTxn.box("minecraft:overworld", 0, 64, 0, 2, 66, 2);
			TxnCore.Started s = live.begin(RemovalTxn.GROUP, GroupTxn.key("ga", null, "u:aa"), List.of("site:group:ga", rboxA, "pile:owner-ga"), "owner-ga");
			TxnEntry a = s.entry();
			Effect.Builder d = (Effect.Builder) RemovalTxn.class.getDeclaredMethod("undoDecision", String.class).invoke(null, "u:aa");
			live.plan(a, d);
			live.plan(a, Effect.of(TxnCore.BARRIER, EffectClass.R).member("aa"));
			assertEquals(DurableFile.Outcome.OK, live.persist(a));
			JsonObject onDisk = live.toJson();
			// the restart: the core loads A's open txn (its holds); no queue entry has attached it (every gtx is null)
			TxnCore loaded = new TxnCore(new Env()).register(RemovalTxn.GROUP_KIND);
			loaded.load(onDisk, null);
			assertEquals(1, loaded.open().size(), "fixture: A's txn loaded open");
			assertTrue(loaded.open().get(0).resources.contains(rboxA), "fixture: A's rbox held by the loaded core");
			// B: another removal whose box overlaps A's (a different resource string, another owner)
			Anchors.Bounds boxB = new Anchors.Bounds(1, 64, 0, 3, 66, 2);
			String why = RemovalAreas.overlapWhy("minecraft:overworld", List.of(boxB), Set.of("group:gb"), loaded);
			System.out.println("ROW T4RN-restart-hold: B's admission over A's loaded hold: " + why);
			assertNotNull(why, "T4RN-restart-hold: B was admitted over A's loaded core hold (A's queue entry not yet reattached): the restart deadlock");
			assertNull(RemovalAreas.overlapWhy("minecraft:overworld", List.of(new Anchors.Bounds(0, 64, 0, 2, 66, 2)), Set.of("group:ga"), loaded),
				"T4RN-restart-hold: A's own hold never refuses A");
			assertNull(RemovalAreas.overlapWhy("minecraft:overworld", List.of(new Anchors.Bounds(10, 64, 10, 12, 66, 12)), Set.of("group:gb"), loaded),
				"T4RN-restart-hold: a box apart from A's is free");
			assertNull(RemovalAreas.overlapWhy("minecraft:the_nether", List.of(boxB), Set.of("group:gb"), loaded), "T4RN-restart-hold: another dimension is free");
		} finally {
			probe.set(null, probeWas);
		}
	}
}
