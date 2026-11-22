package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D narrowing round, P1; rows T4RDN-cargo-admit and T4RDN-cargo-credit) A standalone road's (or region target's) holder contents are
 * taken out by a {@code removal.cargo} txn that runs before any extraction attempt exists. Red at e1a7aad7:
 * <ul>
 * <li>admission exempted every {@code removal.cargo} txn by kind, so while one was open over a chest (its intent in doubt before its TAKE) a
 * new removal's owner record was admitted over that chest, live and after a reload, and saved a hold there;</li>
 * <li>the TAKE wrote its receipt without checking that its {@code setItem} took effect, so with that hold cancelling the write the cargo
 * credited the pile with the stack still in the chest.</li>
 * </ul>
 * The rule now: every open txn's cells count in admission (since the last round, the target's own cargo too: T4RDLCargoRetryTest), and a TAKE (or its
 * compensation) has a receipt only when the slot held exactly the planned stack before and holds nothing (or the stack again) after.
 */
class T4RDNCargoTest {
	static final String DIM = T4RDFixAdmissionTest.DIM;
	static final String CARGO = "cargo:roadB@1@100#7";

	@AfterEach
	void reset() {
		OwnerRemovals.read(null, null);
	}

	static TxnCore core() {
		TxnCore c = new TxnCore(new T4RDFixAdmissionTest.Env()).register(T4RDFixAdmissionTest.inert(CargoTxn.KIND));
		c.load(null, null);
		return c;
	}

	/** An open removal.cargo txn over the chest at (1,65,1), its TAKE planned and not applied (held before it). */
	static TxnEntry openCargo(TxnCore c) {
		TxnEntry t = c.begin(CargoTxn.KIND, CARGO, List.of("crate:" + DIM + "@1,65,1", "pile:sameOwner"), "sameOwner").entry();
		c.plan(t, Effect.of(CargoTxn.TAKE, EffectClass.B).prepare().data("dim", DIM));
		c.plan(t, Effect.of("pile.credit", EffectClass.L).data("owner", "sameOwner"));
		c.persist(t);
		return t;
	}

	@Test
	void anOpenCargoRefusesAdmissionLiveAndAfterAReload() throws Exception {
		System.out.println("ROW T4RDN-cargo-admit (unit)");
		Method m = T4RDFixAdmissionTest.refusal();
		TxnCore c = core();
		openCargo(c);
		JsonObject a = T4RDFixAdmissionTest.rec("a", 0, null, "sameOwner"); // its box (0..2, 64..66, 0..2) covers the chest
		Object live = m.invoke(null, OwnerRemovals.holdsOf(a), Set.of("a"), "remove a", c);
		System.out.println("ROW T4RDN-cargo-admit: live " + live);
		assertNotNull(live, "T4RDN-cargo-admit: an open removal.cargo txn's chest refuses a new owner record over it (live)");
		TxnCore restarted = core();
		restarted.load(c.toJson(), null);
		assertEquals(1, restarted.open().size(), "the cargo txn is loaded open");
		Object reloaded = m.invoke(null, OwnerRemovals.holdsOf(a), Set.of("a"), "remove a", restarted);
		System.out.println("ROW T4RDN-cargo-admit: after a reload " + reloaded);
		assertNotNull(reloaded, "T4RDN-cargo-admit: and after a reload (the cargo loaded from txn.json)");
		assertNotNull(restarted.holds().cellHolder(DIM, 1, 65, 1), "T4RDN-cargo-admit: the loaded cargo holds the chest's cell");
		assertNull(m.invoke(null, OwnerRemovals.holdsOf(T4RDFixAdmissionTest.rec("d", 30, null, "sameOwner")), Set.of("d"), "remove d", restarted),
			"elsewhere: admitted");
	}

	@Test
	void aTakeTheHoldCancelledHasNoReceipt() throws Exception {
		System.out.println("ROW T4RDN-cargo-credit (unit)");
		Method m = null;
		try {
			m = CargoTxn.class.getDeclaredMethod("verifiedWrite", String.class, java.util.function.BooleanSupplier.class, Runnable.class,
				java.util.function.BooleanSupplier.class);
			m.setAccessible(true);
		} catch (NoSuchMethodException e) {
			// red: the TAKE wrote its receipt without checking its write
		}
		assertNotNull(m, "T4RDN-cargo-credit: a TAKE (and its compensation) checks its write took effect before its receipt (CargoTxn.verifiedWrite)");
		Method w = m;
		// a slot of 3 diamonds; a hold over the chest cancels every write (as TxnHoldContentMixin cancels setItem)
		int[] slot = {3};
		boolean[] held = {true}, receipt = {false};
		Runnable take = () -> {
			try {
				w.invoke(null, "take", (java.util.function.BooleanSupplier) () -> slot[0] == 3, (Runnable) () -> {
					if (!held[0]) {
						slot[0] = 0;
					}
				}, (java.util.function.BooleanSupplier) () -> slot[0] == 0);
				receipt[0] = true; // as TAKER.apply: the receipt only after the verified write
			} catch (InvocationTargetException e) {
				throw (RuntimeException) e.getCause();
			} catch (IllegalAccessException e) {
				throw new AssertionError(e);
			}
		};
		assertThrows(IllegalStateException.class, take::run, "T4RDN-cargo-credit: a TAKE whose write the hold cancelled is refused");
		assertEquals(3, slot[0], "the diamonds stay in the chest");
		assertTrue(!receipt[0], "T4RDN-cargo-credit: no receipt (so no credit) for a take that did not happen");
		held[0] = false;
		take.run();
		assertEquals(0, slot[0], "unheld: taken out");
		assertTrue(receipt[0], "and receipted");
		slot[0] = 2;
		receipt[0] = false;
		assertThrows(IllegalStateException.class, take::run, "a slot not holding the planned stack is refused before any change");
		assertEquals(2, slot[0], "unchanged");
		// the production TAKE and its compensation go through it
		String src = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/txn/CargoTxn.java"));
		int apply = src.indexOf("public void apply(TxnEntry t, Effect e)"), comp = src.indexOf("public void compensate(TxnEntry t, Effect e)", apply);
		assertTrue(src.substring(apply, comp).matches("(?s).*takeOut\\(.*addReceipt.*"), "TAKER.apply: takeOut (verified) before its receipt");
		assertTrue(src.substring(comp, comp + 900).matches("(?s).*putBack\\(.*addReceipt.*"), "TAKER.compensate: putBack (verified) before its receipt");
	}
}
