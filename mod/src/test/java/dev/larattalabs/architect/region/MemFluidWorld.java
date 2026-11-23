package dev.larattalabs.architect.region;

import dev.larattalabs.architect.txn.Receipts;
import it.unimi.dsi.fastutil.ints.Int2ObjectLinkedOpenHashMap;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluid;

/**
 * (slice T5F fix round, P2-7) An in-memory {@link FluidWorld} with per-chunk snapshots: each chunk's blocks, marks, receipts and scheduled
 * ticks are one versioned unit ({@link #save}, {@link #lose}: a chunk whose snapshot is lost comes back as last saved, all four together,
 * I1/I6). Cells in {@link #refuse} refuse every write (a T4 hold). Writes per cell are counted.
 */
class MemFluidWorld implements FluidWorld {
	static final class Chunk {
		Map<Long, BlockState> blocks = new HashMap<>();
		Map<String, Int2ObjectLinkedOpenHashMap<FluidProv.Mark>> marks = new HashMap<>();
		List<String> receipts = new ArrayList<>();
		List<Long> ticks = new ArrayList<>();

		Chunk copy() {
			Chunk c = new Chunk();
			c.blocks = new HashMap<>(blocks);
			marks.forEach((k, v) -> c.marks.put(k, new Int2ObjectLinkedOpenHashMap<>(v)));
			c.receipts = new ArrayList<>(receipts);
			c.ticks = new ArrayList<>(ticks);
			return c;
		}
	}

	final Map<Long, Chunk> live = new HashMap<>();
	final Map<Long, Chunk> disk = new HashMap<>();
	final Set<Long> refuse = new HashSet<>();
	final Set<Long> playerPlaced = new HashSet<>();
	final Map<Long, Integer> writes = new HashMap<>();
	long time = 100;

	static long ck(long p) {
		return RegionFluids.chunkKey(p);
	}

	static long ck(int cx, int cz) {
		return (long) cx << 32 | cz & 0xffffffffL;
	}

	Chunk chunk(long key) {
		return live.computeIfAbsent(key, k -> new Chunk());
	}

	/** The chunk's snapshot written to disk now. */
	void save(int cx, int cz) {
		disk.put(ck(cx, cz), chunk(ck(cx, cz)).copy());
	}

	void saveAll() {
		new ArrayList<>(live.keySet()).forEach(k -> disk.put(k, live.get(k).copy()));
	}

	/** A crash lost the chunk's unsaved state: it reads as last saved (or empty). */
	void lose(int cx, int cz) {
		Chunk d = disk.get(ck(cx, cz));
		live.put(ck(cx, cz), d == null ? new Chunk() : d.copy());
	}

	/** A player's (or a dispenser's) change, no Architect write. */
	void put(long p, BlockState s) {
		chunk(ck(p)).blocks.put(p, s);
	}

	List<Long> ticksIn(int cx, int cz) {
		return chunk(ck(cx, cz)).ticks;
	}

	@Override
	public BlockState get(long p) {
		return chunk(ck(p)).blocks.getOrDefault(p, Blocks.AIR.defaultBlockState());
	}

	@Override
	public boolean set(long p, BlockState s) {
		if (refuse.contains(p) || get(p) == s) {
			return false;
		}
		chunk(ck(p)).blocks.put(p, s);
		writes.merge(p, 1, Integer::sum);
		return true;
	}

	@Override
	public int minY() {
		return -64;
	}

	@Override
	public Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks(int cx, int cz, String rec) {
		var m = chunk(ck(cx, cz)).marks.get(rec);
		return m == null ? new Int2ObjectLinkedOpenHashMap<>() : new Int2ObjectLinkedOpenHashMap<>(m);
	}

	@Override
	public void putMarks(int cx, int cz, String rec, Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks) {
		if (marks.isEmpty()) {
			chunk(ck(cx, cz)).marks.remove(rec);
		} else {
			chunk(ck(cx, cz)).marks.put(rec, new Int2ObjectLinkedOpenHashMap<>(marks));
		}
	}

	FluidProv.Mark mark(long p, String rec) {
		return marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec).get(index(p));
	}

	@Override
	public void tick(long p, Fluid f) {
		chunk(ck(p)).ticks.add(p);
	}

	@Override
	public void blockTick(long p, Block b) {
		chunk(ck(p)).ticks.add(p);
	}

	@Override
	public boolean playerPlaced(long p) {
		return playerPlaced.contains(p);
	}

	@Override
	public long gameTime() {
		return time;
	}

	@Override
	public boolean hasReceipt(int cx, int cz, String key) {
		return chunk(ck(cx, cz)).receipts.stream().anyMatch(r -> Receipts.fields(r, key) != null);
	}

	@Override
	public void addReceipt(int cx, int cz, String receipt) {
		chunk(ck(cx, cz)).receipts.add(receipt);
	}

	@Override
	public List<String> receipts(int cx, int cz) {
		return List.copyOf(chunk(ck(cx, cz)).receipts);
	}

	Map<String, String> receipt(int cx, int cz, String key) {
		for (String r : chunk(ck(cx, cz)).receipts) {
			var f = Receipts.fields(r, key);
			if (f != null) {
				return f;
			}
		}
		return null;
	}
}
