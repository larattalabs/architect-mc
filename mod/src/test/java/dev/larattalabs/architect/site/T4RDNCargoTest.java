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
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
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
 * The rule now: every open txn's cells count in admission (the target's own cargo excepted for its own retry), and a TAKE (or its
 * compensation) has a receipt only when the slot held exactly the planned stack before and holds nothing (or the stack again) after.
 */
class T4RDNCargoTest {
	static final String DIM = T4RDFixAdmissionTest.DIM;
	static final String CARGO = "cargo:roadB@1@100#7";

	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

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
	void aTargetsOwnCargoNeverRefusesItsOwnRetry() throws Exception {
		System.out.println("ROW T4RDN-cargo-self (unit)");
		Method own = null;
		try {
			own = Extractions.class.getDeclaredMethod("ownCargo", String.class, TxnCore.class);
			own.setAccessible(true);
		} catch (NoSuchMethodException e) {
			// red: no rule for the target's own cargo
		}
		assertNotNull(own, "T4RDN-cargo-self: the target's own open cargo txns are named for its own retry's admission");
		TxnCore c = core();
		openCargo(c);
		@SuppressWarnings("unchecked")
		Set<String> self = (Set<String>) own.invoke(null, "roadB@1", c);
		@SuppressWarnings("unchecked")
		Set<String> other = (Set<String>) own.invoke(null, "roadB@10", c);
		assertTrue(other.isEmpty(), "another target's (roadB@10) cargo is not its own: " + other);
		JsonObject a = T4RDFixAdmissionTest.rec("roadB", 0, null, "sameOwner");
		java.util.Set<String> s = new java.util.HashSet<>(self);
		s.add("roadB");
		assertNull(T4RDFixAdmissionTest.refusal().invoke(null, OwnerRemovals.holdsOf(a), s, "remove roadB", c),
			"T4RDN-cargo-self: roadB's retry is not refused by its own cargo (" + self + ")");
	}

	/** A chest whose writes a hold cancels, as TxnHoldContentMixin cancels {@code setItem} in a held cell. */
	static final class HeldChest extends SimpleContainer {
		boolean held;

		HeldChest() {
			super(27);
		}

		@Override
		public void setItem(int slot, ItemStack stack) {
			if (!held) {
				super.setItem(slot, stack);
			}
		}
	}

	static Method take(String name) {
		try {
			Method m = CargoTxn.class.getDeclaredMethod(name, net.minecraft.world.Container.class, int.class, ItemStack.class);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	@Test
	void aTakeTheHoldCancelledHasNoReceipt() throws Exception {
		System.out.println("ROW T4RDN-cargo-credit (unit)");
		Method take = take("takeOut"), back = take("putBack");
		assertNotNull(take, "T4RDN-cargo-credit: a TAKE checks its write took effect (CargoTxn.takeOut)");
		assertNotNull(back, "T4RDN-cargo-credit: and its compensation (CargoTxn.putBack)");
		HeldChest box = new HeldChest();
		box.setItem(0, new ItemStack(Items.DIAMOND, 3));
		box.held = true; // an owner record's hold over the chest: setItem cancelled
		InvocationTargetException x = assertThrows(InvocationTargetException.class, () -> take.invoke(null, box, 0, new ItemStack(Items.DIAMOND, 3)),
			"T4RDN-cargo-credit: a TAKE whose write was cancelled is refused (no receipt, no credit)");
		assertTrue(x.getCause() instanceof IllegalStateException, "refused as an IllegalStateException: " + x.getCause());
		assertEquals(3, box.getItem(0).getCount(), "the diamonds stay in the chest");
		box.held = false;
		take.invoke(null, box, 0, new ItemStack(Items.DIAMOND, 3));
		assertTrue(box.getItem(0).isEmpty(), "unheld: taken out");
		box.held = true;
		assertThrows(InvocationTargetException.class, () -> back.invoke(null, box, 0, new ItemStack(Items.DIAMOND, 3)),
			"T4RDN-cargo-credit: a compensation whose write was cancelled is refused (stays in transit, held)");
		box.held = false;
		back.invoke(null, box, 0, new ItemStack(Items.DIAMOND, 3));
		assertEquals(3, box.getItem(0).getCount(), "unheld: put back");
		assertThrows(InvocationTargetException.class, () -> take.invoke(null, box, 0, new ItemStack(Items.DIAMOND, 2)),
			"a slot that does not hold exactly the planned stack is refused before any change");
		assertEquals(3, box.getItem(0).getCount(), "unchanged");
	}
}
