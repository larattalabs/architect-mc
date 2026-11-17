package dev.larattalabs.architect.site;

import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import java.util.Arrays;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * (DR2, P1-3) One chunk's journal-owned cells a player broke: position -> when (wall-clock ms). The Fabric data attachment
 * {@code architect_mc:mined}, saved inside the chunk's own NBT, so the evidence is on disk exactly when the block it explains is: a chunk
 * lost in a crash loses both, a chunk saved (an autosave, an unload) keeps both. A cell holding its owner's pre-op value with a mark newer
 * than the operation's commit is a player's mining, never a lost write ({@link RepairCore#classify(RepairCore.Reader, RepairCore.Want)}:
 * FOREIGN). Immutable (copy on write): the chunk may be serialised off the server thread. Bounded: marks older than {@link #KEEP_MS}
 * are dropped as a chunk gains one, and at most {@link #MAX} a chunk (the oldest go first). (DR2 fix, P1-3) A dropped mark is never
 * forgotten silently: {@code lost} keeps the newest time among them, and an unmarked cell of the chunk whose owner committed at or
 * before it may be one of them, so it is never LAGGING ({@link RepairCore#classify(RepairCore.Reader, RepairCore.Want)}: FOREIGN).
 */
public record MinedCells(long[] pos, long[] at, long lost) {
	MinedCells(long[] pos, long[] at) {
		this(pos, at, -1);
	}

	static final int MAX = 1024;
	static final long KEEP_MS = 24L * 3600 * 1000;
	static final MinedCells EMPTY = new MinedCells(new long[0], new long[0]);

	public static final Codec<MinedCells> CODEC = CompoundTag.CODEC.xmap(MinedCells::read, MinedCells::write);

	static MinedCells read(CompoundTag t) {
		long[] p = t.getLongArray("p").orElse(new long[0]);
		long[] a = t.getLongArray("t").orElse(new long[0]);
		int n = Math.min(p.length, a.length);
		return new MinedCells(Arrays.copyOf(p, n), Arrays.copyOf(a, n), t.getLongOr("l", -1));
	}

	CompoundTag write() {
		CompoundTag t = new CompoundTag();
		t.putLongArray("p", pos.clone());
		t.putLongArray("t", at.clone());
		if (lost >= 0) {
			t.putLong("l", lost);
		}
		return t;
	}

	/** When the cell was broken, or -1. */
	long at(long p) {
		for (int i = 0; i < pos.length; i++) {
			if (pos[i] == p) {
				return at[i];
			}
		}
		return -1;
	}

	/** This set with {@code p} marked at {@code time}: marks older than {@code time - KEEP_MS} dropped, then the oldest past {@link #MAX}. */
	MinedCells with(long p, long time) {
		long[][] kept = keep(p, time - KEEP_MS);
		long gone = lost;
		for (int i = 0; i < pos.length; i++) {
			if (pos[i] != p && at[i] < time - KEEP_MS) {
				gone = Math.max(gone, at[i]); // expired: remembered as lost
			}
		}
		int n = kept[0].length;
		long[] np = Arrays.copyOf(kept[0], n + 1);
		long[] na = Arrays.copyOf(kept[1], n + 1);
		np[n] = p;
		na[n] = time;
		if (np.length > MAX) { // insertion order is time order: the oldest are first
			int cut = np.length - MAX;
			for (int i = 0; i < cut; i++) {
				gone = Math.max(gone, na[i]); // evicted by the cap: remembered as lost
			}
			np = Arrays.copyOfRange(np, cut, np.length);
			na = Arrays.copyOfRange(na, cut, na.length);
		}
		return new MinedCells(np, na, gone);
	}

	/**
	 * (DR2 fix) When an unmarked cell of this chunk may have been broken: the newest dropped mark's time ({@code lost}), or -1. A marked cell
	 * reads its own mark ({@link #at}).
	 */
	long evicted() {
		return lost;
	}

	/** This set without {@code p} (an Architect write made the cell its own again). */
	MinedCells without(long p) {
		long[][] kept = keep(p, Long.MIN_VALUE);
		return new MinedCells(kept[0], kept[1], lost);
	}

	private long[][] keep(long drop, long olderThan) {
		long[] np = new long[pos.length];
		long[] na = new long[pos.length];
		int n = 0;
		for (int i = 0; i < pos.length; i++) {
			if (pos[i] != drop && at[i] >= olderThan) {
				np[n] = pos[i];
				na[n++] = at[i];
			}
		}
		return new long[][] {Arrays.copyOf(np, n), Arrays.copyOf(na, n)};
	}

	// ------------------------------------------------------------------ the world

	/** The chunk attachment and its reads and writes (apart, so the pure set above loads without the game). */
	static final class World {
		private World() {
		}

		/** The attachment: persistent, never synced to clients. */
		static final AttachmentType<MinedCells> TYPE = AttachmentRegistry.<MinedCells>builder().persistent(CODEC).buildAndRegister(Architect.id(
			"mined"));

		/** Registers the attachment (at mod init, before any world loads). */
		static void init() {
			Architect.LOGGER.debug("DR2 attachment {}", TYPE.identifier());
		}

		/** Marks a player's break of a cell (server thread). */
		static void mark(ServerLevel level, BlockPos p, long time) {
			LevelChunk c = level.getChunkSource().getChunkNow(p.getX() >> 4, p.getZ() >> 4);
			if (c == null) {
				return;
			}
			MinedCells m = c.getAttached(TYPE);
			c.setAttached(TYPE, (m == null ? EMPTY : m).with(p.asLong(), time));
			c.markUnsaved();
		}

		/** Clears a cell's mark (an Architect write; server thread). */
		static void clear(ServerLevel level, long p) {
			LevelChunk c = level.getChunkSource().getChunkNow(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
			MinedCells m = c == null ? null : c.getAttached(TYPE);
			if (m == null || m.at(p) < 0) {
				return;
			}
			MinedCells n = m.without(p);
			if (n.pos().length == 0 && n.lost() < 0) {
				c.removeAttached(TYPE);
			} else {
				c.setAttached(TYPE, n);
			}
			c.markUnsaved();
		}

		/** (DR2 fix) The newest dropped mark's time in a loaded cell's chunk, or -1. */
		static long evicted(ServerLevel level, long p) {
			LevelChunk c = level.getChunkSource().getChunkNow(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
			MinedCells m = c == null ? null : c.getAttached(TYPE);
			return m == null ? -1 : m.lost();
		}

		/** When a loaded cell was broken by a player, or -1 (none, or its chunk not loaded). */
		static long at(ServerLevel level, long p) {
			LevelChunk c = level.getChunkSource().getChunkNow(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4);
			MinedCells m = c == null ? null : c.getAttached(TYPE);
			return m == null ? -1 : m.at(p);
		}
	}
}
