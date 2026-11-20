package dev.larattalabs.architect.txn;

import com.google.gson.JsonParser;
import com.mojang.serialization.JsonOps;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R, R5; N6, docs/CONTRACT.md "Phase T4" §3 "a stack with its own data is an O cargo entry") A player-placed holder's stack that
 * carries its own data (a name, an enchantment, contents) in a group removal's region target: taken out of its holder (B {@code cargo.take},
 * a prepare effect: put back on an abort, its receipt in the chunk) and owed whole to the pile's owner (O {@code owed.owe}, reason
 * {@code cargo}, the stack kept as its own data on the owed entry: collected back exactly, never credited by id). One txn per removal's
 * holders, kind {@code removal.cargo}, run before the holders are replaced; nothing strands the removal any more.
 */
public final class CargoTxn {
	private CargoTxn() {
	}

	public static final String KIND = "removal.cargo", TAKE = "cargo.take";

	/** One data-bearing stack: its holder's cell and slot, the stack (its count included) and who it is owed to. */
	public record Stack(String key, String recipient, String dim, BlockPos pos, int slot, ItemStack stack, @Nullable String site) {
	}

	/** The stack as JSON text (the registry's codec: every component kept). */
	public static String encode(ServerLevel level, ItemStack st) {
		return ItemStack.CODEC.encodeStart(level.registryAccess().createSerializationContext(JsonOps.INSTANCE), st).getOrThrow().toString();
	}

	/** {@link #encode}'s stack back; empty when it can't be read. */
	public static ItemStack decode(MinecraftServer srv, String json) {
		return ItemStack.CODEC.parse(srv.registryAccess().createSerializationContext(JsonOps.INSTANCE), JsonParser.parseString(json)).result().orElse(
			ItemStack.EMPTY);
	}

	static String itemId(ItemStack st) {
		return net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
	}

	/**
	 * Owes {@code stacks} (each taken out of its holder first) in one txn, keyed {@code key}. Null when done (or replayed); else why not (refused
	 * before anything changed, or held after the decision: then its stacks are owed by recovery, never lost). Server thread.
	 */
	public static @Nullable String owe(ServerLevel level, String key, List<Stack> stacks) {
		if (stacks.isEmpty()) {
			return null;
		}
		TxnCore c = TxnServer.core();
		List<String> res = new java.util.ArrayList<>();
		String dim = stacks.get(0).dim();
		for (Stack s : stacks) {
			String r = CrateTxn.resource(dim, s.pos());
			if (!res.contains(r)) {
				res.add(r);
			}
		}
		TxnCore.Started st = c.begin(KIND, key, res, stacks.get(0).recipient());
		if (st.status() == TxnCore.Begin.REPLAYED) {
			return null;
		}
		if (st.status() != TxnCore.Begin.NEW) {
			return st.status().name().toLowerCase(java.util.Locale.ROOT) + ": " + st.detail();
		}
		TxnEntry t = st.entry();
		for (Stack s : stacks) {
			Map<String, Integer> items = Map.of(itemId(s.stack()), s.stack().getCount());
			String enc = encode(level, s.stack());
			c.plan(t, Effect.of(TAKE, EffectClass.B).prepare().items(items).move("holder", Effect.TRANSIT).data("dim", dim).data("pos", CrateTxn.posJson(s
				.pos())).data("slot", s.slot()).data("stack", enc));
			Effect.Builder ow = Effect.of(CrateTxn.OWE, EffectClass.O).items(items).move(Effect.TRANSIT, "owed").data("key", s.key()).data("recipient", s
				.recipient()).data("dim", dim).data("pos", CrateTxn.posJson(s.pos())).data("reason", dev.larattalabs.architect.site.OwedLedger.CARGO).data(
					"stack", enc);
			if (s.site() != null) {
				ow.data("site", s.site());
			}
			c.plan(t, ow);
		}
		if (c.persist(t) == dev.larattalabs.architect.site.DurableFile.Outcome.REFUSED) {
			return "txn.json refused";
		}
		TxnCore.Status s = c.drive(t);
		if (t.decision != null && t.decision.isAbort()) {
			return "aborted: " + t.result.get("refused");
		}
		return s == TxnCore.Status.HELD || t.held() != null ? "held(decided): " + Holds.decided(t) : null;
	}

	static final TxnKind.Adapter TAKER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("dim") && e.data().has("pos") && e.data().has("slot") && e.data().has("stack") ? null : "dim, pos, slot and stack are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = CrateTxn.level(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, TestMove.posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			List<String> r = TestMove.receipts(ch);
			return r.contains(e.compKey(t.id)) ? Probe.COMPENSATED : r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = CrateTxn.level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null || !(level.getBlockEntity(p) instanceof Container box)) {
					throw new IllegalStateException("the holder is not loaded or gone");
				}
				int slot = e.data().get("slot").getAsInt();
				ItemStack now = box.getItem(slot);
				ItemStack want = decode(level.getServer(), e.data().get("stack").getAsString());
				if (want.isEmpty() || !ItemStack.matches(now, want)) {
					throw new IllegalStateException("the holder's slot " + slot + " no longer holds " + itemId(want)); // checked before any change
				}
				box.setItem(slot, ItemStack.EMPTY);
				box.setChanged();
				TestMove.addReceipt(ch, e.key(t.id)); // the same tick, the same chunk
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = CrateTxn.level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null || !(level.getBlockEntity(p) instanceof Container box)) {
					throw new IllegalStateException("the holder is not loaded or gone: its stack stays in transit (held)");
				}
				int slot = e.data().get("slot").getAsInt();
				if (!box.getItem(slot).isEmpty()) {
					throw new IllegalStateException("the holder's slot " + slot + " is taken: its stack stays in transit (held)");
				}
				box.setItem(slot, decode(level.getServer(), e.data().get("stack").getAsString()));
				box.setChanged();
				TestMove.addReceipt(ch, e.compKey(t.id));
			});
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "holder at " + TestMove.posOf(e).toShortString();
		}
	};

	public static final TxnKind KIND_DEF = new TxnKind() {
		@Override
		public String name() {
			return KIND;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return switch (e.op()) {
				case TAKE -> TAKER;
				case CrateTxn.OWE -> CrateTxn.OWER;
				default -> null;
			};
		}

		@Override
		public com.google.gson.JsonObject result(TxnEntry t) {
			return CrateTxn.resultOf(t);
		}
	};
}
