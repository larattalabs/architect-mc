package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnServer;
import dev.larattalabs.architect.txn.TxnStore;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-4; rows T4RDF-crate-cycle and T4RDF-old-txn) A new removal is admitted over exactly the footprint its owner
 * record will hold: every member's box and every crate cell its settles touch (a historical crate outside its boxes included), against every
 * durable footprint and every open txn's cell resources as loaded. Red before the fix: B, whose crate cell lies inside A's write box, passed
 * admission (only its member boxes were checked), saved a hold over A's cell and waited on A's pile while A's W was refused by B: a cycle,
 * kept across a restart. And an open txn holding a crate cell (not a group's) was invisible to admission.
 */
class T4RDFixAdmissionTest {
	static final String DIM = "minecraft:overworld";

	@AfterEach
	void reset() throws Exception {
		OwnerRemovals.read(null, null);
	}

	static void setCore(TxnCore c) throws Exception {
		Field f = TxnServer.class.getDeclaredField("core");
		f.setAccessible(true);
		f.set(null, c);
	}

	static JsonArray a(int... ns) {
		JsonArray x = new JsonArray();
		for (int n : ns) {
			x.add(n);
		}
		return x;
	}

	/** A paid single removal's record of site {@code id} with its box at x..x+2, its crate (if any) at (crateX, 65, 1), crediting {@code pile}. */
	static JsonObject rec(String id, int x, Integer crateX, String pile) {
		JsonObject r = new JsonObject();
		r.addProperty("v", 1);
		r.addProperty("kind", "site");
		r.addProperty("base", id);
		r.addProperty("undoGroup", "u:" + id);
		r.addProperty("dim", DIM);
		JsonArray order = new JsonArray();
		order.add(id);
		r.add("order", order);
		JsonObject ms = new JsonObject(), m = new JsonObject();
		m.add("box", a(x, 64, 0, x + 2, 66, 2));
		m.add("player", new JsonArray());
		m.addProperty("paid", true);
		JsonObject st = new JsonObject();
		st.addProperty("dim", DIM);
		if (crateX != null) {
			st.addProperty("pos", net.minecraft.core.BlockPos.asLong(crateX, 65, 1));
			st.addProperty("crateOwner", id);
			st.addProperty("key", "crate:" + id);
			st.addProperty("recipient", "p");
			st.addProperty("state", "{Name:\"minecraft:air\"}");
			st.add("refund", new JsonObject());
		}
		if (pile != null) {
			st.addProperty("pile", pile);
		}
		m.add("settle", st);
		ms.add(id, m);
		r.add("members", ms);
		r.add("r1", new JsonArray());
		return r;
	}

	static Method refusal() {
		try {
			Method m = RemovalAreas.class.getDeclaredMethod("footprintRefusal", List.class, Set.class, String.class, TxnCore.class);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	@Test
	void aCrateCellInsideAnotherOwnersBoxIsRefused() throws Exception {
		System.out.println("ROW T4RDF-crate-cycle (unit)");
		Method m = refusal();
		assertNotNull(m, "T4RDF-crate-cycle: removals are admitted over their member boxes only, not the footprint their record holds");
		OwnerRemovals.put("removal:a@u:a", rec("a", 0, null, "sameOwner"));
		JsonObject b = rec("b", 10, 1, "sameOwner"); // B's crate cell (1,65,1) lies inside A's box
		Object busy = m.invoke(null, OwnerRemovals.holdsOf(b), Set.of("b"), "remove b", null);
		System.out.println("ROW T4RDF-crate-cycle: B's admission " + busy);
		assertNotNull(busy, "T4RDF-crate-cycle: B's footprint (its crate cell in A's write box) is refused before B saves a hold over A's cell");
		assertNull(m.invoke(null, OwnerRemovals.holdsOf(rec("c", 20, 21, "sameOwner")), Set.of("c"), "remove c", null), "a disjoint footprint is admitted");
		// the other order: B saved first, then A's box over B's crate cell
		OwnerRemovals.read(null, null);
		OwnerRemovals.put("removal:b@u:b", b);
		assertNotNull(m.invoke(null, OwnerRemovals.holdsOf(rec("a", 0, null, "sameOwner")), Set.of("a"), "remove a", null), "T4RDF-crate-cycle: and the other order");
	}

	static final class Env implements TxnEnv {
		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject o) {
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
		public void kill(String s) {
		}

		@Override
		public boolean emit(TxnEntry t, String e, JsonObject p, boolean r) {
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

	static TxnKind inert(String name) {
		return new TxnKind() {
			@Override
			public String name() {
				return name;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public Adapter adapter(Effect e) {
				return new Adapter() {
					@Override
					public dev.larattalabs.architect.txn.Probe probe(TxnEntry t, Effect f) {
						return dev.larattalabs.architect.txn.Probe.UNKNOWN;
					}

					@Override
					public void apply(TxnEntry t, Effect f) {
					}

					@Override
					public void compensate(TxnEntry t, Effect f) {
					}
				};
			}
		};
	}

	@Test
	void anOpenTxnsCellIsRefused() throws Exception {
		System.out.println("ROW T4RDF-old-txn (unit)");
		Method m = refusal();
		assertNotNull(m, "T4RDF-old-txn: no admission over the record's footprint");
		TxnCore c = new TxnCore(new Env()).register(inert("crate.settle"));
		c.load(null, null);
		TxnCore.Started old = c.begin("crate.settle", "built:other", List.of("crate:" + DIM + "@9,65,1"), null);
		c.plan(old.entry(), Effect.of("pending.write", EffectClass.W));
		c.persist(old.entry());
		Object busy = m.invoke(null, OwnerRemovals.holdsOf(rec("a", 0, 9, null)), Set.of("a"), "remove a", c);
		System.out.println("ROW T4RDF-old-txn: admission at the held crate " + busy);
		assertNotNull(busy, "T4RDF-old-txn: an open (non-group) txn holding the record's crate cell refuses the new footprint");
		assertNull(m.invoke(null, OwnerRemovals.holdsOf(rec("d", 30, 31, null)), Set.of("d"), "remove d", c), "elsewhere: admitted");
	}
}
