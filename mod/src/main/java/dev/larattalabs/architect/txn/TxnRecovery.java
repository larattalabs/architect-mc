package dev.larattalabs.architect.txn;

import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Phase × decision × evidence") The recovery table as code: given an entry's immutable decision, its
 * phase, the D effect's probe (journal-decided kinds) and whether its own operation drives it this session, the next action. The forward
 * path and recovery run the same table ({@link TxnCore#drive}); only {@code live} differs (an undecided entry recovered after a restart is
 * compensated, never decided by inference). Per-effect evidence (an UNKNOWN probe holds that effect, W before credits) is applied inside
 * each action.
 */
public final class TxnRecovery {
	private TxnRecovery() {
	}

	/** What the core does next with an entry. */
	public enum Action {
		/** Forward: apply each prepare effect (probe first), a barrier, then PREPARED_DONE (confirmed). */
		PREPARE,
		/** Forward: ask the kind (blockers) and decide: commit (the decision write, or the D effect), or abort. */
		DECIDE,
		/** The D effect is APPLIED with no decision written: write {@code decision: commit} (the external decision happened). */
		ADOPT_COMMIT,
		/** Write {@code decision: abort} with phase ABORTING and the abort's payload (one write); compensation follows. */
		ABORT,
		/** Committed, effects pending: redo every effect not APPLIED in plan order (W before credits), a barrier, EFFECTS_DONE. */
		REDO,
		/** EFFECTS_DONE (still committed: never compensated): fire every event not in {@code emitted}, then RETIRING. */
		FINISH,
		/** Aborting: finish compensation newest first ({@code !c} receipts), a barrier, the abort's events, then RETIRING. */
		COMPENSATE,
		/** Abandon: resume the recorded split (written members forward, unwritten ones compensate), then EFFECTS_DONE. */
		SPLIT,
		/** RETIRING: confirm the persisted awaits; done only when every one is met. */
		AWAIT,
		/** Never compensate, never guess: the decision's evidence is UNKNOWN or IN_DOUBT. Retried each tick. */
		HOLD,
		/** An impossible combination: the entry is quarantined, its resources held (§3.8). */
		QUARANTINE
	}

	/** The rule function (TEST seam: TxnCrashModel's naive variants replace it to show the counterexamples failing first). */
	@FunctionalInterface
	public interface Rules {
		Action next(@Nullable Decision d, Phase p, @Nullable Probe dProbe, boolean live);
	}

	/** The §3.6 table. */
	public static final Rules TABLE = TxnRecovery::table;

	static Action table(@Nullable Decision d, Phase p, @Nullable Probe dProbe, boolean live) {
		if (d == null) {
			if (dProbe == Probe.APPLIED) {
				return Action.ADOPT_COMMIT; // row 3: null × any × D APPLIED
			}
			if (dProbe == Probe.UNKNOWN) {
				return Action.HOLD; // row 4: null × any × D UNKNOWN or IN_DOUBT
			}
			return switch (p) {
				case PREPARED -> live ? Action.PREPARE : Action.ABORT; // row 1
				case PREPARED_DONE -> live ? Action.DECIDE : Action.ABORT; // row 2: the default is abort
				default -> Action.QUARANTINE; // EFFECTS_DONE / ABORTING / RETIRING with no decision can't occur
			};
		}
		if (d.isCommit()) {
			return switch (p) {
				case PREPARED_DONE -> Action.REDO; // row 5
				case EFFECTS_DONE -> Action.FINISH; // row 6: still committed
				case RETIRING -> Action.AWAIT; // row 7
				default -> Action.QUARANTINE;
			};
		}
		if (d.isAbort()) {
			return switch (p) {
				case ABORTING -> Action.COMPENSATE; // row 8
				case RETIRING -> Action.AWAIT;
				default -> Action.QUARANTINE;
			};
		}
		return switch (p) { // abandon: row 9
			case PREPARED_DONE -> Action.SPLIT;
			case EFFECTS_DONE -> Action.FINISH;
			case RETIRING -> Action.AWAIT;
			default -> Action.QUARANTINE;
		};
	}
}
