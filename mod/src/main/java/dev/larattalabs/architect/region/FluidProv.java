package dev.larattalabs.architect.region;

import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import it.unimi.dsi.fastutil.ints.Int2ObjectLinkedOpenHashMap;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T5F, contract §3, Noah's N1) Per-cell fluid provenance: {@code architect_mc:fluid_prov}, a persistent chunk attachment (never synced)
 * holding, per fluids record ({@code rec}, {@link FluidTxns#recKey}), the body cells that record wrote ({@link Mark#WROTE}) or its own stage
 * cleared for a later wave ({@link Mark#CLEARED}). A mark is set in the same tick and chunk as the block it describes (I1): a chunk snapshot
 * carries both or neither, so the journal is never write evidence for a fluid cell.
 *
 * <p>Only R's own writers clear R's marks (§3.2): R's txn W effects, explicitly, and a rollback of R's own fluids-stage tile, whose writes run
 * inside {@link #scope}. Any other write leaves the mark: the cell reads as taken (refund 0).
 */
public final class FluidProv {
	private FluidProv() {
	}

	/** The attachment's id. */
	public static final String ID = "architect_mc:fluid_prov";

	/** A body cell's mark. */
	public enum Mark {
		/** Record R wrote its fluid, ice, bars or decor here (the stage's tile or the place W). */
		WROTE,
		/** R's own stage cleared what it wrote (a waiting reach): written again when its body is due. */
		CLEARED,
		/**
		 * (T5Fc fix round) R delivered here and an Architect drain of R took it back, set in the same accepted write: the cell's refund
		 * entitlement, kept with its block until R's removal drain counts it into its receipt (and deletes it in that same apply). Never
		 * written again (I2), never read as taken.
		 */
		DRAINED
	}

	/** One row of §3.3: whether a fluid writer writes the cell, whether the drain takes it, and its refund on a charged body. */
	public record Cell(boolean write, boolean take, int refund) {
	}

	/**
	 * §3.3, the one read of a body cell, for the write, the drain and the refund. {@code open}: air, or what the body itself would write
	 * there (RegionFluids' open rule); {@code ours}: it holds what R wrote ({@code ownStillOurs}). Pure.
	 * <ul>
	 * <li>no mark: written when open; never taken; refunded (paid, never delivered: P1-1);</li>
	 * <li>CLEARED: written when open; refunded while still unwritten;</li>
	 * <li>WROTE: never written again (I2, N3); taken when ours; refunded only then (a harvested cell refunds 0: A).</li>
	 * </ul>
	 */
	public static Cell read(@Nullable Mark mark, boolean open, boolean ours) {
		if (mark == Mark.DRAINED) {
			return new Cell(false, false, 1); // (T5Fc fix round) drained by Architect: never written again, refunded by the removal's drain
		}
		if (mark == Mark.WROTE) {
			return new Cell(false, ours, ours ? 1 : 0);
		}
		return new Cell(open, false, 1);
	}

	/** §3.1: a cell's index in its chunk: {@code (y - minY) << 8 | lz << 4 | lx}. */
	public static int cellIndex(int minY, int x, int y, int z) {
		return (y - minY) << 8 | (z & 15) << 4 | (x & 15);
	}

	/**
	 * (§4.7, Noah's N2) A body cell of a record built before T5F, at adoption: our fluid (or bars) standing there, or absent with an ACTIVE
	 * journal entry of the record's tiles writing it (harvested, or lost at a main-era K4: never minted), is WROTE; else unmarked.
	 */
	public static @Nullable Mark adopt(boolean ourFluidStands, boolean activeTileEntry) {
		return ourFluidStands || activeTileEntry ? Mark.WROTE : null;
	}

	/** (N2) A record charged on main ({@code survival.chargedAt}): every lava and grate body of it counts as paid. */
	public static boolean mainEraPaid(JsonObject survival) {
		return survival.has("chargedAt") && !survival.get("chargedAt").isJsonNull();
	}

	// ------------------------------------------------------------------ the store

	/** The attachment (its class init registers it: never touched by a unit). */
	static final class Store {
		/** rec -> packed marks ({@code cellIndex << 1 | (CLEARED ? 1 : 0)}; (T5Fc fix round) DRAINED as {@code ~cellIndex}, negative). */
		static final AttachmentType<Map<String, List<Integer>>> TYPE = AttachmentRegistry.<Map<String, List<Integer>>>builder().persistent(Codec
			.unboundedMap(Codec.STRING, Codec.INT.listOf())).buildAndRegister(Architect.id("fluid_prov"));
	}

	/** Registers the attachment (mod init). */
	public static void init() {
		Architect.LOGGER.debug("Fluid provenance attachment {}", Store.TYPE.identifier());
	}

	/** R's marks in one chunk, by cell index (a copy). */
	static Int2ObjectLinkedOpenHashMap<Mark> marks(LevelChunk ch, String rec) {
		Int2ObjectLinkedOpenHashMap<Mark> out = new Int2ObjectLinkedOpenHashMap<>();
		Map<String, List<Integer>> all = ch.getAttached(Store.TYPE);
		List<Integer> l = all == null ? null : all.get(rec);
		if (l != null) {
			for (int v : l) {
				if (v < 0) {
					out.put(~v, Mark.DRAINED);
				} else {
					out.put(v >>> 1, (v & 1) == 1 ? Mark.CLEARED : Mark.WROTE);
				}
			}
		}
		return out;
	}

	/** Replaces R's marks in one chunk (none: R's entry goes); marks the chunk unsaved, so the marks reach disk with its blocks. */
	static void put(LevelChunk ch, String rec, Int2ObjectLinkedOpenHashMap<Mark> marks) {
		Map<String, List<Integer>> all = ch.getAttached(Store.TYPE);
		Map<String, List<Integer>> next = all == null ? new HashMap<>() : new HashMap<>(all);
		if (marks.isEmpty()) {
			if (next.remove(rec) == null) {
				return;
			}
		} else {
			List<Integer> l = new ArrayList<>(marks.size());
			marks.int2ObjectEntrySet().forEach(e -> l.add(pack(e.getIntKey(), e.getValue())));
			next.put(rec, List.copyOf(l));
		}
		if (next.isEmpty()) {
			ch.removeAttached(Store.TYPE);
		} else {
			ch.setAttached(Store.TYPE, Map.copyOf(next));
		}
		ch.markUnsaved();
	}

	/** One mark packed: WROTE {@code idx << 1}, CLEARED {@code idx << 1 | 1}, DRAINED {@code ~idx} (negative: a save before T5Fc has none). */
	static int pack(int idx, Mark m) {
		return m == Mark.DRAINED ? ~idx : idx << 1 | (m == Mark.CLEARED ? 1 : 0);
	}

	static int index(Level level, long p) {
		return cellIndex(level.getMinY(), BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p));
	}

	static LevelChunk chunkAt(Level level, long p) {
		return level.getChunk(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
	}

	/** R's mark on one cell, or null. */
	public static @Nullable Mark get(Level level, long p, String rec) {
		return marks(chunkAt(level, p), rec).get(index(level, p));
	}

	/** Sets (or, with null, removes) R's mark on one cell. */
	static void set(Level level, long p, String rec, @Nullable Mark m) {
		LevelChunk ch = chunkAt(level, p);
		Int2ObjectLinkedOpenHashMap<Mark> marks = marks(ch, rec);
		int i = index(level, p);
		if (m == null ? marks.remove(i) == null : marks.put(i, m) == m) {
			return;
		}
		put(ch, rec, marks);
	}

	// ------------------------------------------------------------------ R's scope (§3.2: a rollback of R's own fluids tile)

	/** R's scope: its record, and whether a cell's state before a write was R's own (what R's body wrote there). */
	public record Scope(String rec, java.util.function.BiPredicate<Long, net.minecraft.world.level.block.state.BlockState> ours) {
	}

	private static @Nullable Scope scope;

	/** Runs {@code r} with every Architect write ({@code Placed.set}) inside R's scope; {@code sc} null: no scope. */
	public static void inScope(@Nullable Scope sc, Runnable r) {
		if (sc == null) {
			r.run();
			return;
		}
		Scope was = scope;
		scope = sc;
		try {
			r.run();
		} finally {
			scope = was;
		}
	}

	/**
	 * (fix round, P1-2 and the PLACING harvest) Whether a write in R's scope clears the cell's R mark: only when the cell held R's own before
	 * the write ({@code prevOurs}) and the write took ({@code accepted}), or the cell already holds its target (a verified completion). A
	 * refused write keeps the mark; a cell taken before the rollback (harvested while its tile was PLACING) keeps WROTE, so the tile's retry
	 * never delivers it again. Pure.
	 */
	public static boolean clearsOnWrite(boolean prevOurs, boolean accepted, boolean nowIsTarget) {
		return prevOurs && (accepted || nowIsTarget);
	}

	/** {@code Placed.set}'s hook before the write: inside R's scope, whether the cell holds R's own now (else null: no scope). */
	public static @Nullable Boolean beforeArchitectWrite(Level level, BlockPos pos) {
		Scope sc = scope;
		if (sc == null || !(level instanceof ServerLevel)) {
			return null;
		}
		return sc.ours().test(pos.asLong(), level.getBlockState(pos));
	}

	/** {@code Placed.set}'s hook after the write ({@code prevOurs} from {@link #beforeArchitectWrite}). */
	public static void afterArchitectWrite(Level level, BlockPos pos, @Nullable Boolean prevOurs, net.minecraft.world.level.block.state.BlockState target,
		boolean accepted) {
		Scope sc = scope;
		if (sc != null && prevOurs != null && clearsOnWrite(prevOurs, accepted, level.getBlockState(pos) == target)) {
			set(level, pos.asLong(), sc.rec(), null);
		}
	}
}
