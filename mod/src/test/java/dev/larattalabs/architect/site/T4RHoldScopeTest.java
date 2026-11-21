package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnStore;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-L) The removal holds' scope, through the production guard's own reads ({@link CrateSettle#stashBoxHeldBy}, the set
 * {@code TxnServer.boxHeld} passes for the writing txn, {@link RemovalTxn#sitesOf}).
 * <ul>
 * <li>T4RL-P1-1: a {@code removal.group} txn's adapter writes every member's restore: each member's hold (a pre-T4R credit's load-time hold)
 * accepts it, not only its first member's. The base (9913d902) exempted the first member only: B's restore write was refused.</li>
 * <li>T4RL-writing (the fix round's P2, kept): while one removal writes its own restore ({@link CrateSettle#WRITING}), every other removal's
 * hold still refuses (a player, or that writer).</li>
 * </ul>
 */
class T4RHoldScopeTest {
	static final String DIM = "minecraft:overworld";

	static JsonObject stash(String site, int x) {
		JsonObject st = new JsonObject();
		st.addProperty("dim", DIM);
		st.addProperty("site", site);
		JsonArray b = new JsonArray();
		for (int v : new int[] {x, 64, 0, x + 2, 66, 2}) {
			b.add(v);
		}
		st.add("box", b);
		st.addProperty("legacy", true);
		return st;
	}

	@AfterEach
	void clear() {
		CrateSettle.clearDevHolds();
		CrateSettle.WRITING = Set.of();
	}

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
		public boolean satisfied(dev.larattalabs.architect.txn.Await a) {
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
	void aGroupTxnWritesEveryMembersHoldNotOnlyItsFirst() {
		System.out.println("ROW T4RL-P1-1 (unit)");
		CrateSettle.devHoldStash("a", stash("a", 0));
		CrateSettle.devHoldStash("b", stash("b", 20));
		CrateSettle.devHoldStash("c", stash("c", 40)); // an unrelated removal's hold
		TxnCore c = new TxnCore(new Env());
		c.register(RemovalTxn.GROUP_KIND);
		c.load(null, null);
		TxnEntry t = c.begin(RemovalTxn.GROUP, "group:g@u:group-g:1", List.of("site:group:g"), null).entry();
		c.plan(t, RemovalTxn.undoDecision("u:group-g:1"));
		for (String m : List.of("a", "b")) {
			c.plan(t, RemovalTxn.restore(DIM, m, "u:group-g:1", List.of(new long[] {0, 0})).member(m));
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(m));
		}
		Set<String> own = RemovalTxn.sitesOf(t);
		boolean a = CrateSettle.stashBoxHeldBy(DIM, 1, 65, 1, own);
		boolean b = CrateSettle.stashBoxHeldBy(DIM, 21, 65, 1, own);
		boolean cc = CrateSettle.stashBoxHeldBy(DIM, 41, 65, 1, own);
		boolean player = CrateSettle.stashBoxHeldBy(DIM, 21, 65, 1, null);
		System.out.println("ROW T4RL-P1-1 the group txn's own sites " + own + ": A refused " + a + ", B refused " + b + ", unrelated C refused " + cc
			+ ", a player at B refused " + player);
		assertFalse(a, "T4RL-P1-1: the group txn writes member A's restore");
		assertFalse(b, "T4RL-P1-1: the group txn writes member B's restore too (the base: refused, only the first member exempt)");
		assertTrue(cc, "T4RL-P1-1: an unrelated removal's hold still refuses the group txn");
		assertTrue(player, "T4RL-P1-1: a player is refused at B");
	}

	@Test
	void oneRemovalsWritesNeverOpenAnothersHold() {
		System.out.println("ROW T4RL-writing (unit)");
		CrateSettle.devHoldStash("a", stash("a", 0));
		CrateSettle.devHoldStash("b", stash("b", 20));
		CrateSettle.WRITING = Set.of("a");
		boolean a = CrateSettle.stashBoxHeld(DIM, 1, 65, 1);
		boolean b = CrateSettle.stashBoxHeld(DIM, 21, 65, 1);
		boolean bByOther = CrateSettle.stashBoxHeldBy(DIM, 21, 65, 1, Set.of());
		System.out.println("ROW T4RL-writing while A writes: A held " + a + ", B held " + b + ", B for a txn that is no removal's " + bByOther);
		assertFalse(a, "T4RL-writing: A's own restore writes its held box");
		assertTrue(b, "T4RL-writing: B's hold still refuses while A writes (cross-removal isolation)");
		assertTrue(bByOther, "T4RL-writing: B's hold refuses another txn while A writes");
		CrateSettle.WRITING = Set.of();
		assertEquals(true, CrateSettle.stashBoxHeld(DIM, 1, 65, 1), "T4RL-writing: A held again once its write ends");
	}
}
