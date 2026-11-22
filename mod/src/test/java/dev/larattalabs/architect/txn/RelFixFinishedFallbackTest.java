package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RemovalFinished;
import dev.larattalabs.architect.site.OwedLedger;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (REL-v0910 fix round, P2-1; row RELF-owed-parts-fallback) A group's REMOVAL_FINISHED redelivered after its snapshot left the results table
 * (bounded, oldest out). Red at 68d2b065: the fallback built an eight-argument result (owed keys, no parts). Now the same parts by the
 * snapshot's own rule, from the txn's applied O effects.
 */
class RelFixFinishedFallbackTest {
	static final String GKEY = "group:gfb@u1";
	static final String OKEY = "player:" + GKEY + "/m:p";

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static final class Env implements TxnEnv {
		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public dev.larattalabs.architect.site.DurableFile.Outcome write(JsonObject o) {
					return dev.larattalabs.architect.site.DurableFile.Outcome.OK;
				}

				@Override
				public dev.larattalabs.architect.site.DurableFile.Outcome confirm() {
					return dev.larattalabs.architect.site.DurableFile.Outcome.OK;
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
		public boolean satisfied(Await a) {
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

	@Test
	void theFallbackEventCarriesTheSamePartsAsTheSnapshot() {
		System.out.println("ROW RELF-owed-parts-fallback (unit)");
		TxnCore c = new TxnCore(new Env()).register(new TxnKind() {
			@Override
			public String name() {
				return RemovalTxn.GROUP;
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
						return Probe.ABSENT;
					}

					@Override
					public void apply(TxnEntry t, Effect f) {
					}

					@Override
					public void compensate(TxnEntry t, Effect f) {
					}
				};
			}
		});
		c.load(null, null);
		TxnEntry t = c.begin(RemovalTxn.GROUP, GKEY, List.of(), "o").entry();
		Effect f = c.plan(t, Effect.of(CrateTxn.OWE, EffectClass.O).items(Map.of("minecraft:sponge", 2)).data("key", OKEY).data("recipient", "p").data(
			"reason", OwedLedger.PLAYER_BLOCKS).data("site", "m").member("m"));
		OwedLedger.owe(new OwedLedger.Entry(OKEY, "p", "minecraft:overworld", 1, 65, 1, Map.of("minecraft:sponge", 2), OwedLedger.PLAYER_BLOCKS, 0, 0, "m",
			null), f.key(t.id));
		JsonObject p = new JsonObject();
		p.addProperty("group", "gfb");
		RemovalFinished ev = RemovalTxn.finished(t, p); // no snapshot under its key
		System.out.println("ROW RELF-owed-parts-fallback: " + ev.result().owed() + " " + ev.result().owedParts());
		assertEquals(1, ev.result().owedParts().size(), "RELF-owed-parts-fallback: the event with no snapshot still carries the owed part");
		assertEquals("p", ev.result().owedParts().get(0).recipient(), "its recipient");
		assertEquals(Map.of(net.minecraft.world.item.Items.SPONGE, 2), ev.result().owedParts().get(0).items(), "its amount");
		assertEquals(List.of(OKEY), ev.result().owed(), "its owed key once");
	}
}
