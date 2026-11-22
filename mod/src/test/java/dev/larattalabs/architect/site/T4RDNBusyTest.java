package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import dev.larattalabs.architect.api.Busy;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D narrowing round, P2-3; row T4RDN-busy-kind) A removal refused because another open txn that is not a removal (a crate settle,
 * a take, a holder's cargo) holds one of its cells gets a Busy whose wait the caller can end: {@code OPERATION_IN_PROGRESS} naming that txn
 * (its id and kind), retried by time; no REMOVAL_FINISHED is promised. Red at e1a7aad7: {@code REMOVAL_IN_PROGRESS} with the made-up removal id
 * {@code txn:built:other} (kind {@code site}), whose REMOVAL_FINISHED never comes.
 */
class T4RDNBusyTest {
	static final String DIM = T4RDFixAdmissionTest.DIM;

	@AfterEach
	void reset() {
		OwnerRemovals.read(null, null);
	}

	static Busy busyOver(TxnCore c) throws Exception {
		Object e = T4RDFixAdmissionTest.refusal().invoke(null, OwnerRemovals.holdsOf(T4RDFixAdmissionTest.rec("a", 0, null, null)), Set.of("a"),
			"remove a", c);
		assertNotNull(e, "refused over the held cell");
		return ((Sites.SiteException) e).busy();
	}

	@Test
	void aNonRemovalBlockerAnswersATimeRetry() throws Exception {
		System.out.println("ROW T4RDN-busy-kind (unit)");
		for (String kind : List.of("crate.settle", CargoTxn.KIND)) {
			TxnCore c = new TxnCore(new T4RDFixAdmissionTest.Env()).register(T4RDFixAdmissionTest.inert(kind));
			c.load(null, null);
			TxnEntry t = c.begin(kind, "built:other", List.of("crate:" + DIM + "@1,65,1"), "sameOwner").entry();
			c.plan(t, Effect.of("pending.write", EffectClass.W));
			c.persist(t);
			Busy b = busyOver(c);
			System.out.println("ROW T4RDN-busy-kind: " + kind + " -> " + b + " " + (b == null ? null : b.token()));
			assertNotNull(b, "typed");
			assertEquals("OPERATION_IN_PROGRESS", b.kind().name(), "T4RDN-busy-kind: a non-removal blocker (" + kind + ") is a time retry, no removal's event");
			assertEquals(t.id, b.blockingId(), "T4RDN-busy-kind: it names the blocking txn's id");
			assertEquals(kind, b.blockingKind(), "T4RDN-busy-kind: and its kind");
		}
	}
}
