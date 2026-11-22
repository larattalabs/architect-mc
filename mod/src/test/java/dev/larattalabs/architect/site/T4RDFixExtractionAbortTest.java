package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnKind;
import dev.larattalabs.architect.txn.TxnStore;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D fix round, P1-5; row T4RDF-abort-hold) An extraction whose txn intent was durable but undecided at a crash: recovery adopts
 * ABORT, but its retirement waits for the first tick's barrier, so at the table's load the txn is still open and the attempt is left alone.
 * Once that txn retires, the resolver the start scheduled (each tick while an attempt is open) marks it aborted and releases its cells; a
 * further restart is not needed. Red before the fix: after the first tick the txn was gone and the attempt stayed planned, its cell held.
 */
class T4RDFixExtractionAbortTest {
	@AfterEach
	void reset() {
		Extractions.read(null);
	}

	static final class Env implements TxnEnv {
		JsonObject disk;
		boolean barriers = true;

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject o) {
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
			return barriers ? Barrier.ok(List.of()) : Barrier.refused("SERVER_STARTED: deferred to first tick");
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
						return dev.larattalabs.architect.txn.Probe.ABSENT;
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
	void anAbortRetiredAfterTheStartReleasesItsHold() throws Exception {
		System.out.println("ROW T4RDF-abort-hold (unit)");
		Extractions.read(JsonParser.parseString("{\"r1@5\":{\"gen\":1,\"attempts\":{\"1\":{\"key\":\"pblocks:r1@5#1\",\"dim\":\"minecraft:overworld\","
			+ "\"target\":\"r1\",\"cells\":[{\"pos\":" + net.minecraft.core.BlockPos.asLong(0, 1, 0) + ",\"block\":\"minecraft:sponge\"}],\"state\":\"planned\"}}}}"));
		// before the crash: its intent persisted, undecided
		Env env = new Env();
		TxnCore before = new TxnCore(env).register(inert(Extractions.KIND));
		before.load(null, null);
		TxnCore.Started intent = before.begin(Extractions.KIND, "pblocks:r1@5#1", List.of("cell:minecraft:overworld@0,1,0"), null);
		before.plan(intent.entry(), Effect.of("cells.restore", EffectClass.W).data("dim", "minecraft:overworld"));
		before.persist(intent.entry());
		// the restart: recovery adopts ABORT; its retirement waits for the first tick (the start's barrier is deferred)
		TxnCore after = new TxnCore(env).register(inert(Extractions.KIND));
		after.load(env.disk, null);
		env.barriers = false;
		after.recover();
		assertEquals(1, after.open().size(), "fixture: the aborting txn is still open at the table's load");
		Predicate<String> open = k -> after.open().stream().anyMatch(t -> k.equals(t.key));
		Predicate<String> committed = k -> after.cache().committed(k) != null;
		List<Runnable> queued = new ArrayList<>();
		Consumer<Runnable> later = queued::add;
		Method atStart;
		try {
			atStart = Extractions.class.getDeclaredMethod("atStart", net.minecraft.server.MinecraftServer.class, Predicate.class, Predicate.class, Consumer.class);
		} catch (NoSuchMethodException e) {
			atStart = null;
		}
		if (atStart != null) {
			atStart.setAccessible(true);
			atStart.invoke(null, null, open, committed, later);
		} else {
			Extractions.atStart(null, open, committed); // the red base: one pass at the start, nothing after it
		}
		assertEquals(1, Extractions.holds().size(), "while its txn is open its cell stays held");
		// the first tick: the barrier passes, the abort retires; then the scheduled resolver runs (as TxnServer.later does, each tick)
		env.barriers = true;
		after.tick();
		assertEquals(0, after.open().size(), "fixture: the abort retired at the first tick");
		for (int i = 0; i < 3 && !queued.isEmpty(); i++) {
			List<Runnable> now = new ArrayList<>(queued);
			queued.clear();
			now.forEach(Runnable::run);
		}
		JsonObject t = Extractions.json();
		System.out.println("ROW T4RDF-abort-hold: after the first tick " + t + "; holds " + Extractions.holds().size());
		String st = t.getAsJsonObject("r1@5").getAsJsonObject("attempts").getAsJsonObject("1").get("state").getAsString();
		assertEquals("aborted", st, "T4RDF-abort-hold: the attempt is aborted once its txn retired aborted (no second restart)");
		assertEquals(0, Extractions.holds().size(), "T4RDF-abort-hold: its cell is released");
		assertTrue(!CrateSettle.stashBoxHeld("minecraft:overworld", 0, 1, 0), "T4RDF-abort-hold: the cell is free");
		assertTrue(queued.isEmpty(), "the resolver stops once nothing is open");
		JsonArray unused = new JsonArray();
		assertEquals(0, unused.size());
	}

	@Test
	void aRoadsOwnPlannedAttemptNeverRefusesItsRetry() throws Exception {
		System.out.println("ROW T4RDF-abort-hold (unit): the road's retry reaches its attempt");
		Extractions.read(JsonParser.parseString("{\"r1@5\":{\"gen\":1,\"attempts\":{\"1\":{\"key\":\"pblocks:r1@5#1\",\"dim\":\"minecraft:overworld\","
			+ "\"target\":\"r1\",\"cells\":[{\"pos\":" + net.minecraft.core.BlockPos.asLong(1, 65, 1) + ",\"block\":\"minecraft:sponge\"}],\"state\":\"planned\"}}}}"));
		Infra r1 = new Infra("r1", "road", "p", new JsonObject(), "minecraft:overworld", new dev.larattalabs.architect.placement.Anchors.Bounds(0, 64, 0, 2, 66,
			2), 5, null, false, new JsonObject());
		java.util.List<RemovalAreas.Area> areas = new ArrayList<>();
		Extractions.areas(areas);
		java.util.Set<String> self = new java.util.HashSet<>(java.util.Set.of("r1"));
		assertTrue(RemovalAreas.first(areas, "minecraft:overworld", List.of(r1.box()), self) != null, "fixture: the attempt's cell is an admission area");
		Method keys;
		try {
			keys = Extractions.class.getDeclaredMethod("keysOf", Infra.class);
		} catch (NoSuchMethodException e) {
			keys = null;
		}
		org.junit.jupiter.api.Assertions.assertNotNull(keys, "T4RDF-abort-hold: a road's retry is refused by its own planned attempt (never reaches Extractions.run)");
		keys.setAccessible(true);
		@SuppressWarnings("unchecked")
		java.util.Set<String> own = (java.util.Set<String>) keys.invoke(null, r1);
		self.addAll(own);
		assertEquals(null, RemovalAreas.first(areas, "minecraft:overworld", List.of(r1.box()), self), "T4RDF-abort-hold: its own attempt is no blocker of its retry");
		String src = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/site/InfraPlace.java"));
		// (REL-v0910 fix round, P1) through the one self rule every removal's admission uses (RemovalAreas.withOwnAttempts: Extractions.keysOf)
		String areasSrc = java.nio.file.Files.readString(java.nio.file.Path.of("src/main/java/dev/larattalabs/architect/site/RemovalAreas.java"));
		assertTrue(src.contains("RemovalAreas.withOwnAttempts(java.util.Set.of(id), List.of(id))") && areasSrc.contains("out.addAll(Extractions.keysOf(t))"),
			"T4RDF-abort-hold: the road's admission excludes its own attempts");
	}
}
