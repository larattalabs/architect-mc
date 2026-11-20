package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import dev.larattalabs.architect.region.FluidCrashModelT5F.Naive;
import java.util.EnumSet;
import java.util.Map;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;

/**
 * (slice T5Fa, CONTRACT T5F §7.1) The per-kind crash model ({@link FluidCrashModelT5F}).
 * <ul>
 * <li>{@code model_*} (always run, green): T5F as designed (NONE) passes every schedule; each Naive switch is red with the violation it is
 * for. These prove the design, not the code.</li>
 * <li>{@code runtime_*} (failing first: run with {@code -Dred.T5F=true}, red on dc814bb1 plus the T5Fa hooks commit): each binds one switch
 * to a marker in the runtime and fails, with the model's counterexample, while the marker shows the 8cT behaviour. T5Fb/T5Fc turn them
 * green by building what the marker names (docs: architect-T5F-prep-notes.md), then drop the guard.</li>
 * </ul>
 */
class FluidCrashModelT5FTest {
	static Map<String, String> explore(Naive n) {
		return new FluidCrashModelT5F(EnumSet.of(n)).explore();
	}

	static void red(Naive n, String kind) {
		Map<String, String> bad = explore(n);
		assertTrue(bad.keySet().stream().anyMatch(k -> k.startsWith(kind)), n + " must be red with a " + kind + " violation; got " + bad.values());
	}

	@Test
	void model_noneIsGreenOverEverySchedule() {
		Map<String, String> bad = explore(Naive.NONE);
		assertTrue(bad.isEmpty(), "T5F as designed: " + bad.values());
	}

	@Test
	void model_activeAsProofIsRed() {
		red(Naive.ACTIVE_AS_PROOF, "conservation"); // P1-1: a chunk lost after ACTIVE is neither rewritten nor refunded
	}

	@Test
	void model_seenAheadIsRed() {
		red(Naive.SEEN_AHEAD, "conservation"); // P1-2a: a harvest in the window after the counts is refunded again
	}

	@Test
	void model_aggregateWIsRed() {
		red(Naive.AGGREGATE_W, "conservation"); // P1-2b: a receipt-present chunk drained again erases a dispensed source
	}

	@Test
	void model_lBeforeBarrierIsRed() {
		red(Naive.L_BEFORE_BARRIER, "conservation"); // P1-2c: the ledger durable, the drain's chunks lost, the restored source harvested
	}

	@Test
	void model_waterRefillIsRed() {
		red(Naive.WATER_REFILL, "refill"); // P2-a: a harvested cell written again
	}

	@Test
	void model_forceInRIsRed() {
		red(Naive.FORCE_IN_R, "physics"); // P2-b: the R skipped on replay, the redone chunk never forced
	}

	@Test
	void model_storedUntilIsRed() {
		red(Naive.STORED_UNTIL, "deadline"); // F: the redone drain's chunk settles past a stored deadline
	}

	// ------------------------------------------------------------------ failing first: the runtime's markers (-Dred.T5F=true)

	static void guard() {
		Assumptions.assumeTrue(Boolean.getBoolean("red.T5F"), "T5Fa red record: run with -Dred.T5F=true");
	}

	static boolean hasClass(String name) {
		try {
			Class.forName(name, false, FluidCrashModelT5FTest.class.getClassLoader());
			return true;
		} catch (ClassNotFoundException e) {
			return false;
		}
	}

	static boolean hasMethod(Class<?> c, String name) {
		for (var m : c.getDeclaredMethods()) {
			if (m.getName().equals(name)) {
				return true;
			}
		}
		return false;
	}

	static void bound(Naive n, boolean naiveInRuntime, String marker) {
		if (naiveInRuntime) {
			fail("not built (T5F): " + marker + " - the runtime still has 8cT's " + n + "; the model's counterexample: " + explore(n).values());
		}
	}

	@Test
	void runtime_activeAsProof_provenanceInTheChunk() {
		guard();
		bound(Naive.ACTIVE_AS_PROOF, !hasClass("dev.larattalabs.architect.region.FluidProv") || hasClass(
			"dev.larattalabs.architect.region.RegionFluids$JournalWrites"), "region.FluidProv (architect_mc:fluid_prov) present and RegionFluids.JournalWrites deleted");
	}

	@Test
	void runtime_seenAhead_noSeenReceipt() {
		guard();
		bound(Naive.SEEN_AHEAD, hasMethod(FluidTxns.class, "seenOf"), "FluidTxns.seenOf (the @seen receipt) deleted; counts in the drain W's own receipt");
	}

	@Test
	void runtime_aggregateW_perChunkDrainEffects() {
		guard();
		// 8cT's drain W carries every chunk ("chunks"), its probe ABSENT when any lacks the receipt; T5F plans one W per (body, chunk) ("chunk")
		bound(Naive.AGGREGATE_W, !hasMethod(FluidTxns.class, "drainEffects"),
			"FluidTxns.drainEffects (the per-(body, chunk) drain plan, each effect's data naming its one chunk)");
	}

	@Test
	void runtime_lBeforeBarrier_noLedgerEffectInTheDrain() {
		guard();
		boolean naive = FluidTxns.DRAIN_KIND.adapter(FluidsT5FRedTest.effect("pile.scoop", "L")) != null;
		bound(Naive.L_BEFORE_BARRIER, naive, "fluid.drain has no pile.scoop (L) adapter; region.scoop is its own kind");
	}

	@Test
	void runtime_waterRefill_neverRefillWrote() {
		guard();
		bound(Naive.WATER_REFILL, !hasClass("dev.larattalabs.architect.region.FluidProv"), "region.FluidProv: writeBody's I2 rule (no mark or CLEARED, and open) for every fluid");
	}

	@Test
	void runtime_forceInR_forceIsAW() {
		guard();
		boolean naive = FluidTxns.WRITE_KIND.adapter(FluidsT5FRedTest.effect("fluid.force", "W")) == null;
		bound(Naive.FORCE_IN_R, naive, "fluid.write's fluid.force W adapter (the ticks scheduled in each chunk's W)");
	}

	@Test
	void runtime_storedUntil_deadlineFromReceipts() {
		guard();
		bound(Naive.STORED_UNTIL, !hasMethod(RegionFluids.class, "settleDeadline"),
			"RegionFluids.settleDeadline (max(receipt t) + bound over the drain's receipts), and no stored until read (FluidsT5FRedTest.f_*)");
	}

	@Test
	void model_explorationCoversEveryBoundary() {
		assertFalse(new FluidCrashModelT5F(EnumSet.of(Naive.NONE)).boundaries() < 20, "the lifecycle has its tile, write, drain and scoop boundaries");
	}
}
