package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import dev.larattalabs.architect.site.CrateSettle;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4b, docs/CONTRACT.md "Phase T4" §3, findings 1-3 of the T2b last-round review) A removal's refunds on the txn layer: the kinds
 * {@code removal.site} (a single site's removal, its cascade's members each their own) and {@code removal.road} (a road or cell site's).
 * Each runs after the removal's undo is committed (the journal's undo group is the decision, made durable before the txn begins, with the
 * removal's stash saved confirmed before that commit), and its plan starts with the W effect {@link #RESTORE} for the removed site: its
 * committed restore written again from the journal (idempotent) with the receipt {@code tx-n/i@restored} in every chunk it writes. Every
 * refund and the crate's settle come after it (T2b's crate.settle effects, and the L {@link #PILE_REFUND} of a stockpile's site), so a
 * barrier that publishes the ledger has saved the restored chunks first: a refund is never paid while its paid blocks stand (1a, 1b), never
 * on the evidence of a threshold or of a missing record (3a, 3b). The undo group's entries are kept until the txn retires (2a); a W apply
 * that fails holds and is retried, never paid past (2b).
 */
public final class RemovalTxn {
	private RemovalTxn() {
	}

	public static final String SITE = "removal.site", ROAD = "removal.road";
	/** The W effect: the removed site's committed restore. Data {@code dim}, {@code site}, {@code group}, {@code chunks} ([[cx, cz], ...]). */
	public static final String RESTORE = "site.restore";
	/**
	 * The L effect: a stockpile's site's refund credited into its pile under its own credit key ({@code site:<id>@<placedAt>}, the key
	 * {@code Builder.creditRefund} books), so the custody held for it comes back with it and its paid record goes. Data {@code owner},
	 * {@code key}, {@code pos}. Its items may be empty (a custody-only or a nothing credit).
	 */
	public static final String PILE_REFUND = "pile.refund";

	/** The W {@link #RESTORE} effect for {@code site}'s committed restore in undo group {@code group}, over {@code chunks}. */
	public static Effect.Builder restore(String dim, String site, String group, List<long[]> chunks) {
		JsonArray cs = new JsonArray();
		for (long[] c : chunks) {
			JsonArray a = new JsonArray();
			a.add(c[0]);
			a.add(c[1]);
			cs.add(a);
		}
		return Effect.of(RESTORE, EffectClass.W).data("dim", dim).data("site", site).data("group", group).data("chunks", cs);
	}

	/** The L {@link #PILE_REFUND} effect. */
	public static Effect.Builder pileRefund(String owner, String key, java.util.Map<String, Integer> items, BlockPos at) {
		return Effect.of(PILE_REFUND, EffectClass.L).items(items).move("world", "stock").data("owner", owner).data("key", key).data("pos", CrateTxn
			.posJson(at));
	}

	static @Nullable ServerLevel level(Effect e) {
		MinecraftServer s = TxnServer.server();
		return s == null ? null : dev.larattalabs.architect.site.Sites.levelOf(s, e.data().get("dim").getAsString());
	}

	static String restoredKey(TxnEntry t, Effect e) {
		return e.key(t.id) + "@restored";
	}

	/** The chunks of a {@link #RESTORE} effect, loaded when recovering (a live txn reads only loaded ones): null when one is not loaded. */
	static java.util.@Nullable List<LevelChunk> chunks(TxnEntry t, ServerLevel level, Effect e) {
		java.util.List<LevelChunk> out = new java.util.ArrayList<>();
		for (JsonElement el : e.data().getAsJsonArray("chunks")) {
			JsonArray a = el.getAsJsonArray();
			LevelChunk ch = TestMove.chunkFor(t, level, new BlockPos(a.get(0).getAsInt() << 4, 0, a.get(1).getAsInt() << 4));
			if (ch == null) {
				return null;
			}
			out.add(ch);
		}
		return out;
	}

	static final TxnKind.Adapter RESTORER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("dim") && e.data().has("site") && e.data().has("group") && e.data().get("chunks") instanceof JsonArray ? null
				: "dim, site, group and chunks are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			String site = e.data().get("site").getAsString();
			String group = e.data().get("group").getAsString();
			if (!CrateSettle.undoneExists(site, group)) {
				// its undo group's entries are released only after this txn retires (or, for a removal settled before T4, once its restore read
				// restored at a start): nothing of it is left to write
				return Probe.APPLIED;
			}
			ServerLevel level = level(e);
			java.util.List<LevelChunk> cs = level == null ? null : chunks(t, level, e);
			if (cs == null) {
				return Probe.UNKNOWN;
			}
			String k = restoredKey(t, e);
			for (LevelChunk ch : cs) {
				if (!TestMove.receipts(ch).contains(k)) {
					return Probe.ABSENT;
				}
			}
			return Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			if (level == null) {
				throw new IllegalStateException("its dimension is not loaded");
			}
			java.util.List<LevelChunk> cs = chunks(t, level, e);
			if (cs == null) {
				throw new IllegalStateException("a chunk of its restore is not loaded");
			}
			TxnServer.asHolder(t, () -> CrateSettle.restoreSite(level, e.data().get("site").getAsString(), e.data().get("group").getAsString()));
			String k = restoredKey(t, e);
			for (LevelChunk ch : cs) {
				TestMove.addReceipt(ch, k); // the same tick as its cells: the chunk's save holds both
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a restore is never a prepare effect");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			JsonArray first = e.data().getAsJsonArray("chunks").isEmpty() ? null : e.data().getAsJsonArray("chunks").get(0).getAsJsonArray();
			return first == null ? "the restore of " + e.data().get("site").getAsString() : "chunk " + first.get(0).getAsInt() + "," + first.get(1).getAsInt();
		}
	};

	static final TxnKind.Adapter PILE_REFUNDER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("owner") && e.data().has("key") && e.data().has("pos") ? null : "owner, key and pos are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return CrateSettle.refundBooked(e.data().get("owner").getAsString(), e.data().get("key").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			CrateSettle.bookRefund(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), e.items(), TestMove.posOf(e));
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a refund is never a prepare effect");
		}
	};

	static TxnKind kind(String name) {
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
			public TxnKind.Adapter adapter(Effect e) {
				return switch (e.op()) {
					case RESTORE -> RESTORER;
					case PILE_REFUND -> PILE_REFUNDER;
					case CrateTxn.TAKE -> CrateTxn.ADAPTER;
					case CrateTxn.RESTORE -> CrateTxn.RESTORE_ADAPTER;
					case CrateTxn.RELEASE -> CrateTxn.RELEASER;
					case CrateTxn.PILE_CREDIT -> CrateTxn.CREDITOR;
					case CrateTxn.OWE -> CrateTxn.OWER;
					default -> null;
				};
			}
		};
	}

	public static final TxnKind SITE_KIND = kind(SITE), ROAD_KIND = kind(ROAD);

	/** A removal box (N3): {@code rbox:<dim>@x0,y0,z0:x1,y1,z1}. While an open removal txn names one, no player breaks a block in it. */
	public static String box(String dim, int x0, int y0, int z0, int x1, int y1, int z1) {
		return "rbox:" + dim + "@" + x0 + "," + y0 + "," + z0 + ":" + x1 + "," + y1 + "," + z1;
	}

	/** Whether {@code pos} lies in a removal box an open (or retiring) removal txn names (N3's hold). O(open txns), none open: O(1). */
	public static boolean boxHeld(String dim, int x, int y, int z) {
		TxnCore c = TxnServer.core();
		if (c.holds().isEmpty()) {
			return false;
		}
		for (TxnEntry t : c.open()) {
			if (!t.kind.startsWith("removal.")) {
				continue;
			}
			for (String r : t.resources) {
				if (r.startsWith("rbox:") && inBox(r, dim, x, y, z)) {
					return true;
				}
			}
		}
		return false;
	}

	static boolean inBox(String r, String dim, int x, int y, int z) {
		int at = r.lastIndexOf('@');
		if (at < 0 || !r.substring(5, at).equals(dim)) {
			return false;
		}
		String[] ab = r.substring(at + 1).split(":");
		if (ab.length != 2) {
			return false;
		}
		String[] a = ab[0].split(","), b = ab[1].split(",");
		try {
			return x >= Integer.parseInt(a[0]) && y >= Integer.parseInt(a[1]) && z >= Integer.parseInt(a[2]) && x <= Integer.parseInt(b[0])
				&& y <= Integer.parseInt(b[1]) && z <= Integer.parseInt(b[2]);
		} catch (NumberFormatException e) {
			return false;
		}
	}
}
