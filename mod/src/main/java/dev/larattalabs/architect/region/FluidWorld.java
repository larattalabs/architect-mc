package dev.larattalabs.architect.region;

import dev.larattalabs.architect.txn.TestMove;
import it.unimi.dsi.fastutil.ints.Int2ObjectLinkedOpenHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.Fluid;

/**
 * (slice T5F fix round, P2-7) Where the fluid Ws read and write: a chunk's blocks, its {@code fluid_prov} marks, its receipts and its scheduled
 * ticks. The level ({@link #of(ServerLevel)}) in game; an in-memory world in the units, so the real adapters run against saved state.
 */
public interface FluidWorld {
	BlockState get(long p);

	/** An Architect write of one cell ({@code Placed.set}, no update): true only when the world took it (a hold may refuse it). */
	boolean set(long p, BlockState s);

	/** A grate's bars joined to their neighbours, as vanilla's update would (the level's shape); the same state elsewhere. */
	default BlockState joined(long p, BlockState now) {
		return now;
	}

	int minY();

	Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks(int cx, int cz, String rec);

	void putMarks(int cx, int cz, String rec, Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks);

	void tick(long p, Fluid f);

	void blockTick(long p, Block b);

	/** Whether a player placed what the cell holds (its {@code Placed} record). */
	boolean playerPlaced(long p);

	long gameTime();

	/** Whether the chunk holds effect {@code key}'s receipt (exact, or with fields). */
	boolean hasReceipt(int cx, int cz, String key);

	void addReceipt(int cx, int cz, String receipt);

	/** (round 2, P2-c) The chunk's receipts (every txn's). */
	java.util.List<String> receipts(int cx, int cz);

	default int index(long p) {
		return FluidProv.cellIndex(minY(), BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p));
	}

	/** The level as a fluid world. */
	static FluidWorld of(ServerLevel level) {
		return new FluidWorld() {
			@Override
			public BlockState get(long p) {
				return level.getBlockState(BlockPos.of(p));
			}

			@Override
			public boolean set(long p, BlockState s) {
				return dev.larattalabs.architect.placed.Placed.set(level, BlockPos.of(p), s, Block.UPDATE_CLIENTS | Block.UPDATE_SKIP_ALL_SIDEEFFECTS);
			}

			@Override
			public BlockState joined(long p, BlockState now) {
				return Block.updateFromNeighbourShapes(now, level, BlockPos.of(p));
			}

			@Override
			public int minY() {
				return level.getMinY();
			}

			LevelChunk chunk(int cx, int cz) {
				return level.getChunk(cx, cz);
			}

			@Override
			public Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks(int cx, int cz, String rec) {
				return FluidProv.marks(chunk(cx, cz), rec);
			}

			@Override
			public void putMarks(int cx, int cz, String rec, Int2ObjectLinkedOpenHashMap<FluidProv.Mark> marks) {
				FluidProv.put(chunk(cx, cz), rec, marks);
			}

			@Override
			public void tick(long p, Fluid f) {
				level.scheduleTick(BlockPos.of(p), f, 1);
			}

			@Override
			public void blockTick(long p, Block b) {
				level.scheduleTick(BlockPos.of(p), b, 1);
			}

			@Override
			public boolean playerPlaced(long p) {
				return dev.larattalabs.architect.placed.Placed.record(level, BlockPos.of(p)) != null;
			}

			@Override
			public long gameTime() {
				return level.getGameTime();
			}

			@Override
			public boolean hasReceipt(int cx, int cz, String key) {
				return TestMove.hasReceipt(chunk(cx, cz), key);
			}

			@Override
			public void addReceipt(int cx, int cz, String receipt) {
				TestMove.addReceiptTo(chunk(cx, cz), receipt);
			}

			@Override
			public java.util.List<String> receipts(int cx, int cz) {
				return TestMove.receiptsOf(chunk(cx, cz));
			}
		};
	}
}
