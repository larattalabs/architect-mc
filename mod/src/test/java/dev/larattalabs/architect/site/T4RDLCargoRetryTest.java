package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.txn.TxnKind.Adapter;
import dev.larattalabs.architect.txn.TxnEnv.Barrier;
import dev.larattalabs.architect.txn.CargoTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnStore;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T4R-D last round, P1; row T4RDL-cargo-retry) Ported from the reviewer's {@code T4RDCargoRetryProbe}. A standalone road's holder cargo
 * takes a chest's 3 diamonds (TAKE applied, the slot empty), then its prepare barrier fails and its ABORTING save is refused once: the cargo stays
 * open, undecided, the stack in transit. Red at ae97e9da: the road's own retry exempted its own cargo ({@code Extractions.keysOf} added
 * {@code cargoSelf}), so it was admitted, {@code takeContents} saw the empty chest and P0 saved the extraction's hold over it: the extraction's W
 * waited on the cargo's cell, the cargo's compensation on P0's hold, for good (and across a restart). And a group's retry
 * ({@code Groups.prepareTail}) calls {@code Extractions.run} with no admission at all.
 * <p>
 * The rule now: a target's own open cargo txn is like any other open txn. Its retry is refused while it is open (admission counts its cells), and
 * {@code Extractions.run} itself waits before {@code takeContents} while one of the target's cargo txns is open (every caller). The cargo then
 * compensates (the slot back to 3), retires, and the retry is admitted; the same from {@code txn.json} after a reload.
 */
class T4RDLCargoRetryTest {
	static final String DIM = T4RDFixAdmissionTest.DIM;
	static final String CK = "cargo:roadB@1@100#7";

	@TempDir
	Path tmp;

	/** The model chest's slot: 3 diamonds; taken out by the TAKE, put back by its compensation. */
	static int slot;
	static boolean taken, compensated;

	@BeforeEach
	void setUp() throws Exception {
		slot = 3;
		taken = false;
		compensated = false;
		Stockpiles.loadFrom(Files.createDirectories(tmp.resolve("world")));
		Extractions.read(null);
		OwnerRemovals.read(null, null);
	}

	@AfterEach
	void reset() {
		Extractions.read(null);
		OwnerRemovals.read(null, null);
	}

	/** One failed prepare barrier, then the ABORTING save refused once; otherwise every write durable ({@link #disk}). */
	static final class Env implements TxnEnv {
		@Nullable
		JsonObject disk;
		boolean failPrepare = true, failAbortOnce = true;

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject o) {
					boolean abort = o.getAsJsonArray("open").asList().stream().anyMatch(x -> x.getAsJsonObject().get("phase").getAsString().equalsIgnoreCase(
						"ABORTING"));
					if (abort && failAbortOnce) {
						failAbortOnce = false;
						return DurableFile.Outcome.REFUSED;
					}
					disk = o.deepCopy();
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
			if (failPrepare) {
				failPrepare = false;
				return Barrier.refused("one failed prepare barrier");
			}
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
		public boolean emit(TxnEntry t, String e, JsonObject p, boolean recovered) {
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

	/** The cargo kind over the model chest; its compensation goes through the same hold guard as {@code CargoTxn.TAKER.compensate}. */
	static TxnKind cargo() {
		return new TxnKind() {
			@Override
			public String name() {
				return CargoTxn.KIND;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public Adapter adapter(Effect e) {
				return new Adapter() {
					@Override
					public Probe probe(TxnEntry t, Effect f) {
						return compensated ? Probe.COMPENSATED : taken ? Probe.APPLIED : Probe.ABSENT;
					}

					@Override
					public void apply(TxnEntry t, Effect f) {
						assertEquals(3, slot, "the TAKE finds the planned stack");
						slot = 0;
						taken = true;
					}

					@Override
					public void compensate(TxnEntry t, Effect f) {
						// CargoTxn.TAKER.compensate -> putBack -> TxnServer.boxHeld -> TxnHoldContentMixin: refused under another hold
						if (!CrateSettle.stashBoxHeldBy(DIM, 1, 65, 1, RemovalTxn.sitesOf(t))) {
							slot = 3;
						}
						if (slot != 3) {
							throw new IllegalStateException("the verified putBack was cancelled by a hold over the chest");
						}
						compensated = true;
					}
				};
			}
		};
	}

	static TxnCore core(Env env) {
		TxnCore c = new TxnCore(env).register(cargo());
		return c;
	}

	/** The window: TAKE applied, the prepare barrier refused, the ABORTING save refused once; the cargo open, the stack in transit. */
	static TxnCore window(Env env) {
		TxnCore c = core(env);
		c.load(null, null);
		TxnEntry t = c.begin(CargoTxn.KIND, CK, List.of("crate:" + DIM + "@1,65,1", "pile:sameOwner"), "sameOwner").entry();
		c.plan(t, Effect.of(CargoTxn.TAKE, EffectClass.B).prepare());
		c.persist(t);
		c.drive(t);
		assertEquals(0, slot, "fixture: the chest's slot is empty (the stack in transit)");
		assertEquals(1, c.open().size(), "fixture: the cargo is still open (its abort not saved)");
		assertFalse(compensated, "fixture: not compensated yet");
		assertFalse(env.failAbortOnce, "fixture: the ABORTING save was refused once");
		return c;
	}

	static Infra road() {
		return new Infra("roadB", "road", "p", new JsonObject(), DIM, new dev.larattalabs.architect.placement.Anchors.Bounds(0, 64, 0, 2, 66, 2), 1, null,
			false, new JsonObject());
	}

	/** The road's own retry's admission, exactly as InfraPlace builds its self: its id and {@code Extractions.keysOf}. */
	static Object retry(TxnCore c) throws Exception {
		Infra road = road();
		Set<String> self = new HashSet<>(Extractions.keysOf(road));
		self.add(road.id());
		return T4RDFixAdmissionTest.refusal().invoke(null, OwnerRemovals.holdsOf(T4RDFixAdmissionTest.rec("roadB", 0, null, null)), self, "remove roadB",
			c);
	}

	/** {@code Extractions.ownCargo(TxnCore, String)}: the target's open cargo txn {@code run} waits for, or null (red: none). */
	static @Nullable Object ownCargo(TxnCore c) throws Exception {
		Method m = null;
		try {
			m = Extractions.class.getDeclaredMethod("ownCargo", TxnCore.class, String.class);
			m.setAccessible(true);
		} catch (NoSuchMethodException e) {
			// red: run goes on to takeContents and P0 with its own cargo open
		}
		assertNotNull(m, "T4RDL-cargo-retry: Extractions.run waits for the target's own open cargo (Extractions.ownCargo)");
		return m.invoke(null, c, Extractions.tkey(road()));
	}

	static void ticks(TxnCore c) {
		for (int i = 0; i < 5; i++) {
			c.tick();
		}
	}

	@Test
	void theRetryWaitsForItsOwnCargoWhichCompensatesAndRetires() throws Exception {
		System.out.println("ROW T4RDL-cargo-retry (unit)");
		Env env = new Env();
		TxnCore c = window(env);
		Object refused = retry(c);
		System.out.println("ROW T4RDL-cargo-retry: the retry with its own cargo open: " + refused);
		assertNotNull(refused, "T4RDL-cargo-retry: the road's own retry is refused while its own cargo is open (no own-cargo exemption)");
		assertNotNull(ownCargo(c), "T4RDL-cargo-retry: and run itself waits for it (a group's retry has no admission)");
		ticks(c);
		System.out.println("ROW T4RDL-cargo-retry: after 5 ticks: slot " + slot + ", open " + c.open().size());
		assertEquals(3, slot, "T4RDL-cargo-retry: the cargo compensated: the 3 diamonds back in the chest");
		assertTrue(compensated, "compensated");
		assertTrue(c.open().isEmpty(), "T4RDL-cargo-retry: the cargo retired");
		assertNull(retry(c), "T4RDL-cargo-retry: then the retry is admitted");
		assertNull(ownCargo(c), "and run goes on");
	}

	@Test
	void theSameFromTxnJsonAfterAReload() throws Exception {
		System.out.println("ROW T4RDL-cargo-retry-reload (unit)");
		Env env = new Env();
		window(env);
		JsonObject onDisk = env.disk;
		assertNotNull(onDisk, "txn.json saved");
		assertEquals(1, onDisk.getAsJsonArray("open").size(), "fixture: txn.json lists the cargo open (its ABORTING save was refused)");
		TxnCore restarted = core(env);
		restarted.load(onDisk.deepCopy(), null);
		assertEquals(1, restarted.open().size(), "the cargo is loaded open");
		Object refused = retry(restarted);
		System.out.println("ROW T4RDL-cargo-retry-reload: the retry after a reload: " + refused);
		assertNotNull(refused, "T4RDL-cargo-retry: after a reload the retry is still refused by the loaded cargo");
		assertNotNull(ownCargo(restarted), "T4RDL-cargo-retry: and run still waits for it");
		restarted.recover();
		ticks(restarted);
		System.out.println("ROW T4RDL-cargo-retry-reload: after recovery and 5 ticks: slot " + slot + ", open " + restarted.open().size());
		assertEquals(3, slot, "T4RDL-cargo-retry: recovery compensated: the 3 diamonds back in the chest");
		assertTrue(restarted.open().isEmpty(), "T4RDL-cargo-retry: the cargo retired");
		assertNull(retry(restarted), "T4RDL-cargo-retry: then the retry is admitted");
		assertNull(ownCargo(restarted), "and run goes on");
	}

	@Test
	void runChecksItsOwnCargoBeforeTakeContents() throws Exception {
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Extractions.java"));
		int run = src.indexOf("static @Nullable String run(MinecraftServer srv");
		int take = src.indexOf("takeContents(level, t, tk, cells)", run);
		assertTrue(run > 0 && take > run, "run and its takeContents call");
		assertTrue(src.substring(run, take).contains("ownCargo("), "T4RDL-cargo-retry: run waits for the target's own open cargo before takeContents");
		assertFalse(src.contains("cargoSelf"), "T4RDL-cargo-retry: no own-cargo exemption left in admission");
	}
}
