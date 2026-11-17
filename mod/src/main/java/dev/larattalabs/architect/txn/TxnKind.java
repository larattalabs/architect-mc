package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.5, §3.6) A txn kind: its name and schema version, who decides (this file's write, or a D effect),
 * and the adapter of each op. Every effect probes its own store's marker, applies with its marker (R-3), and compensates with a {@code !c}
 * marker; all three are idempotent from the entry alone.
 */
public interface TxnKind {
	String name();

	/** The kind's schema version; an entry with a newer one is quarantined (§3.8). */
	int kv();

	/** {@code "txn"} or {@code "journal"}. */
	default String decider() {
		return "txn";
	}

	/** The adapter of {@code e.op()}, or null (the entry is quarantined). */
	@Nullable Adapter adapter(Effect e);

	/** Forward only: after PREPARED_DONE, commit (true) or abort (false: a blocker found before the decision). Recovery never asks. */
	default boolean commitAfterPrepare(TxnEntry t) {
		return true;
	}

	/** The abort's own event payload (an owed BATCH_DONE, §3.7 round 4), written with {@code decision: abort}; null for none. */
	default @Nullable JsonObject abortPayload(TxnEntry t) {
		return null;
	}

	/** The terminal result written at EFFECTS_DONE (the refund, removed, ...). */
	default JsonObject result(TxnEntry t) {
		return new JsonObject();
	}

	/** An op's store side. Server thread. */
	interface Adapter {
		/** The marker: APPLIED, ABSENT, COMPENSATED, or UNKNOWN when its store can't be read now. */
		Probe probe(TxnEntry t, Effect e);

		/** Applies the effect with its marker in the same atomic unit; throws to refuse (a prepare effect refused aborts the txn). */
		void apply(TxnEntry t, Effect e);

		/** Undoes an applied prepare effect, leaving the {@code !c} marker in the same unit. */
		void compensate(TxnEntry t, Effect e);

		/** The resource a hold on this effect names ({@code chunk x,z}, {@code player <name>}). */
		default String where(TxnEntry t, Effect e) {
			return e.op();
		}
	}
}
