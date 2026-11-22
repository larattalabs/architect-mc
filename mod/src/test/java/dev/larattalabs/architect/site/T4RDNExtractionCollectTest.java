package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.TxnKind.Adapter;
import dev.larattalabs.architect.txn.CrateTxn;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnKind;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D narrowing round, P2-2; row T4RDN-late-collect) An extraction attempt completed by a later core tick (its caller saw it held and
 * left) still auto-collects its owed player blocks, once, after its txn retired. Red at e1a7aad7: only the caller that saw the retirement
 * scheduled the collect; the core tick's snapshot kept the attempt, the resolver and later retries skip kept attempts, so the online
 * recipient's 2 sponges stayed owed with no collect.
 */
class T4RDNExtractionCollectTest {
	static final String DIM = T4RDFixAdmissionTest.DIM;
	final Map<String, Object> saved = new java.util.HashMap<>();

	@AfterEach
	void reset() throws Exception {
		for (var e : saved.entrySet()) {
			Field f = Extractions.class.getDeclaredField(e.getKey());
			f.setAccessible(true);
			f.set(null, e.getValue());
		}
		Extractions.read(null);
	}

	/** Sets the TEST seam {@code name} of Extractions; false when it does not exist (red: no such rule). */
	boolean seam(String name, Object v) throws Exception {
		Field f;
		try {
			f = Extractions.class.getDeclaredField(name);
		} catch (NoSuchFieldException e) {
			return false;
		}
		f.setAccessible(true);
		saved.putIfAbsent(name, f.get(null));
		f.set(null, v);
		return true;
	}

	@Test
	void aLaterTickCompletionAutoCollectsOnce() throws Exception {
		System.out.println("ROW T4RDN-late-collect (unit)");
		Stockpiles.loadFrom(Files.createTempDirectory("t4rdn-collect-"));
		String tk = "roadB@1", key = "pblocks:roadB@1#1";
		Extractions.read(JsonParser.parseString("{\"roadB@1\":{\"gen\":1,\"attempts\":{\"1\":{\"key\":\"" + key + "\",\"dim\":\"" + DIM
			+ "\",\"target\":\"roadB\",\"cells\":[],\"state\":\"open\"}}}}"));
		T4RDFixExtractionAbortTest.Env env = new T4RDFixExtractionAbortTest.Env();
		boolean[] allowSnapshot = {false};
		TxnKind kind = new TxnKind() {
			@Override
			public String name() {
				return Extractions.KIND;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public Adapter adapter(Effect e) {
				if (e.op().equals(RemovalTxn.EXTRACTION_SNAPSHOT)) {
					Adapter prod = RemovalTxn.PBLOCKS_KIND.adapter(e); // the production snapshot
					return new Adapter() {
						@Override
						public Probe probe(TxnEntry t, Effect f) {
							return allowSnapshot[0] ? prod.probe(t, f) : Probe.UNKNOWN; // held at the snapshot until the later tick
						}

						@Override
						public void apply(TxnEntry t, Effect f) {
							prod.apply(t, f);
						}

						@Override
						public void compensate(TxnEntry t, Effect f) {
							prod.compensate(t, f);
						}
					};
				}
				return new Adapter() {
					@Override
					public Probe probe(TxnEntry t, Effect f) {
						return OwedLedger.amountOf(f.key(t.id)) == null ? Probe.ABSENT : Probe.APPLIED;
					}

					@Override
					public void apply(TxnEntry t, Effect f) {
						OwedLedger.owe(new OwedLedger.Entry("owed:" + key, "online-player", DIM, 1, 65, 1, Map.of("minecraft:sponge", 2), OwedLedger.PLAYER_BLOCKS,
							0, 0, "roadB", null), f.key(t.id));
					}

					@Override
					public void compensate(TxnEntry t, Effect f) {
					}
				};
			}
		};
		TxnCore c = new TxnCore(env).register(kind);
		c.load(null, null);
		List<Runnable> queue = new ArrayList<>();
		List<JsonArray> collected = new ArrayList<>();
		boolean[] stillOpen = {false};
		Predicate<String> open = k -> stillOpen[0] || c.open().stream().anyMatch(x -> k.equals(x.key));
		assertTrue(seam("collectQueue", (Consumer<Runnable>) queue::add) && seam("txnOpen", open) && seam("collector",
			(BiConsumer<String, JsonArray>) (title, parts) -> collected.add(parts)),
			"T4RDN-late-collect: a kept attempt's collect is scheduled where the attempt becomes kept (seams collectQueue, txnOpen, collector)");
		TxnEntry t = c.begin(Extractions.KIND, key, List.of("cell:" + DIM + "@1,65,1"), null).entry();
		c.plan(t, Effect.of(CrateTxn.OWE, EffectClass.O).data("key", "owed:" + key).data("recipient", "online-player").data("reason",
			OwedLedger.PLAYER_BLOCKS));
		c.plan(t, Effect.of(RemovalTxn.EXTRACTION_SNAPSHOT, EffectClass.R).data("target", tk).data("gen", key));
		c.persist(t);
		c.drive(t);
		assertEquals(1, c.open().size(), "fixture: the caller sees it held (deferred to a later tick)");
		assertTrue(queue.isEmpty() && collected.isEmpty(), "nothing scheduled while it is not kept");
		allowSnapshot[0] = true;
		c.tick(); // the later core tick: the snapshot keeps it, the txn retires
		assertTrue(c.open().isEmpty() && Extractions.snapshotted(tk, key), "fixture: completed by the core tick");
		assertEquals(1, queue.size(), "T4RDN-late-collect: one collect scheduled at the attempt's kept transition (" + queue.size() + ")");
		// while its txn still counts as open, the collect waits (re-queued), nothing collected
		stillOpen[0] = true;
		List<Runnable> run = new ArrayList<>(queue);
		queue.clear();
		run.forEach(Runnable::run);
		assertTrue(collected.isEmpty() && queue.size() == 1, "T4RDN-late-collect: no collect while its txn is open; re-queued");
		stillOpen[0] = false;
		run = new ArrayList<>(queue);
		queue.clear();
		run.forEach(Runnable::run);
		System.out.println("ROW T4RDN-late-collect: collected " + collected);
		assertEquals(1, collected.size(), "T4RDN-late-collect: collected once after retirement");
		assertNotNull(collected.get(0));
		assertEquals("owed:" + key, collected.get(0).get(0).getAsJsonObject().get("key").getAsString(), "its owed part");
		assertEquals(2, collected.get(0).get(0).getAsJsonObject().getAsJsonObject("items").get("minecraft:sponge").getAsInt());
		assertTrue(queue.isEmpty(), "nothing more queued: exactly once");
	}
}
