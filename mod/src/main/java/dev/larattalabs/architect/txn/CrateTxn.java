package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2b) The crate's side of the txn layer, for every kind that takes a construction crate's stock (T2b's removal kinds, T3b's
 * adoption). <b>Stable interface</b> (docs/CONTRACT.md "Slice T2b part 2a as built"):
 * <ul>
 * <li>{@link #resource(String, BlockPos)}: the hold, {@code crate:<dim>@x,y,z}. While a txn holds it, the crate's cell is frozen (the T2a
 * holds) and its ledger refuses every writer but the holder's adapter: inserts (screen, hopper, dropper, dev), the feed's consume, any
 * {@code takeStock} (a finish, a deconstruct, an orphan click, a road), {@code adopt} (skipped, retried later).</li>
 * <li>{@link #take(String, BlockPos, Map)}: the B effect {@code crate.take} (a prepare effect): exactly {@code items} out of the crate's
 * stock into transit, its receipt {@code tx-n/i} in the chunk attachment {@code architect_mc:txn_receipts} in the same change; its
 * compensation puts them back with {@code tx-n/i!c}. Its probe reads the chunk: APPLIED / COMPENSATED / ABSENT, UNKNOWN when the chunk is not
 * loaded (a live txn) or the crate is gone without a receipt. A kind answers {@link #ADAPTER} for op {@link #TAKE}.</li>
 * </ul>
 * The crate's block entity carries nothing of the txn: a restore that removes it leaves the chunk's receipts (§3.4 B).
 */
public final class CrateTxn {
	private CrateTxn() {
	}

	public static final String TAKE = "crate.take";
	/** (slice T3b) The W effect: a crate cell restored to its snapshot. */
	public static final String RESTORE = "crate.restore";

	/**
	 * (slice T3b) The W effect {@code crate.restore}: the crate cell at {@code p} restored to the block (and block entity) it held before the
	 * crate ({@code Builder.restoreCrateCell}: the crate's block entity goes with it), from the snapshot copied into the intent, so recovery
	 * never reads the record the txn clears. Its receipt {@code tx-n/i@restored} goes in the same chunk's {@code architect_mc:txn_receipts}
	 * in the same change. Run after the decision only (never compensated).
	 */
	public static Effect.Builder restore(String dim, BlockPos p, String snapshotState, @Nullable String snapshotNbt) {
		Effect.Builder b = Effect.of(RESTORE, EffectClass.W).data("dim", dim).data("pos", TestMove.pos(p)).data("state", snapshotState);
		return snapshotNbt == null ? b : b.data("nbt", snapshotNbt);
	}

	/** (slice T3b) A W restore's receipt in the chunk: {@code tx-n/i@restored}. */
	public static String restoredKey(TxnEntry t, Effect e) {
		return e.key(t.id) + "@restored";
	}

	/** The crate hold resource. */
	public static String resource(String dim, BlockPos p) {
		return "crate:" + dim + "@" + p.getX() + "," + p.getY() + "," + p.getZ();
	}

	/** The {@code crate.take} effect of {@code items} from the crate at {@code p} (a prepare effect: compensated on an abort). */
	public static Effect.Builder take(String dim, BlockPos p, Map<String, Integer> items) {
		return Effect.of(TAKE, EffectClass.B).prepare().items(items).move("crate", Effect.TRANSIT).data("dim", dim).data("pos", TestMove.pos(p));
	}

	/** (slice T3b) The {@code crate.restore} adapter: probe the chunk's {@code tx-n/i@restored}; apply restores the cell and writes it. */
	public static final TxnKind.Adapter RESTORE_ADAPTER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			if (!(e.data().get("dim") instanceof com.google.gson.JsonPrimitive d) || !d.isString() || !(e.data().get("pos") instanceof JsonArray a)
				|| a.size() != 3 || !e.data().has("state")) {
				return "dim, pos and state are required";
			}
			return TestMoveCells.dimRefusal(d.getAsString());
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = ADAPTER_LEVEL.apply(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, TestMove.posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			return TestMove.receipts(ch).contains(restoredKey(t, e)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = ADAPTER_LEVEL.apply(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null) {
					throw new IllegalStateException("the crate's chunk is not loaded");
				}
				String nbt = e.data().has("nbt") ? e.data().get("nbt").getAsString() : null;
				dev.larattalabs.architect.site.Builder.restoreCrateCell(level, new dev.larattalabs.architect.site.Construction.Crate(p.getX(), p.getY(),
					p.getZ(), e.data().get("state").getAsString(), nbt));
				TestMove.addReceipt(ch, restoredKey(t, e)); // the same tick, the same chunk as the cell
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a crate restore is never a prepare effect");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			BlockPos p = TestMove.posOf(e);
			return "chunk " + (p.getX() >> 4) + "," + (p.getZ() >> 4);
		}
	};

	private static final java.util.function.Function<Effect, @Nullable ServerLevel> ADAPTER_LEVEL = e -> {
		MinecraftServer s = TxnServer.server();
		return s == null ? null : Sites.levelOf(s, e.data().get("dim").getAsString());
	};

	public static final TxnKind.Adapter ADAPTER = new TxnKind.Adapter() {
		@Nullable ServerLevel level(Effect e) {
			MinecraftServer s = TxnServer.server();
			return s == null ? null : Sites.levelOf(s, e.data().get("dim").getAsString());
		}

		@Nullable CrateBlockEntity crate(ServerLevel level, BlockPos p) {
			return level.getBlockEntity(p) instanceof CrateBlockEntity c ? c : null;
		}

		@Override
		public @Nullable String invalid(Effect e) {
			if (!(e.data().get("dim") instanceof com.google.gson.JsonPrimitive d) || !d.isString() || !(e.data().get("pos") instanceof JsonArray a)
				|| a.size() != 3) {
				return "dim and pos are required";
			}
			String bad = TestMoveCells.dimRefusal(d.getAsString());
			return bad != null ? bad : e.items().isEmpty() ? "no items" : null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, TestMove.posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			List<String> r = TestMove.receipts(ch);
			if (r.contains(e.compKey(t.id))) {
				return Probe.COMPENSATED;
			}
			return r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				CrateBlockEntity c = level == null ? null : crate(level, p);
				if (ch == null || c == null) {
					throw new IllegalStateException("the crate is not loaded or gone");
				}
				if (!c.ledger().take(e.items())) {
					throw new IllegalStateException("the crate no longer holds " + e.items()); // checked before any change
				}
				TestMove.addReceipt(ch, e.key(t.id)); // the same tick, the same chunk: one snapshot holds both
				c.ledgerChanged();
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				CrateBlockEntity c = level == null ? null : crate(level, p);
				if (ch == null || c == null) {
					throw new IllegalStateException("the crate is not loaded or gone: its stock stays in transit (held)");
				}
				c.ledger().putBack(e.items());
				TestMove.addReceipt(ch, e.compKey(t.id));
				c.ledgerChanged();
			});
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			BlockPos p = TestMove.posOf(e);
			return "crate at " + p.toShortString();
		}
	};
}
