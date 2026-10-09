package dev.larattalabs.architect.region;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.material.FluidState;

/**
 * A grid of surveyed columns and its byte layout, {@code ARSV} (kit/REGIONS.md "Columns codec"): the plan survey (resolution
 * 1 or 4) and a tile's frozen heights (its 80x80 window at resolution 1). Per column {@code ground} (the region's surface: the
 * first block under {@code height} that is not air, a log, leaves or a plant; water counts), {@code height} (motion-blocking
 * without leaves, the top block's y), {@code floor} (the first block under {@code ground} that is not a fluid) and flags.
 */
public final class Columns {
	public static final int WATER = 1;
	public static final int MISSING = 2;
	public static final int TREE = 4;
	public static final int LAVA = 8;
	static final int HEADER = 28;
	private static final byte[] MAGIC = "ARSV".getBytes(StandardCharsets.US_ASCII);

	public final int minX;
	public final int minZ;
	public final int width;
	public final int depth;
	public final int resolution;
	public final short[] ground;
	public final short[] height;
	public final short[] floor;
	public final byte[] flags;

	public Columns(int minX, int minZ, int width, int depth, int resolution) {
		this.minX = minX;
		this.minZ = minZ;
		this.width = width;
		this.depth = depth;
		this.resolution = resolution;
		int n = width * depth;
		ground = new short[n];
		height = new short[n];
		floor = new short[n];
		flags = new byte[n];
		java.util.Arrays.fill(flags, (byte) MISSING);
	}

	public int index(int i, int j) {
		return i + j * width;
	}

	/** The index of world column (x, z), or -1 outside (resolution 1 grids). */
	public int at(int x, int z) {
		int i = Math.floorDiv(x - minX, resolution);
		int j = Math.floorDiv(z - minZ, resolution);
		return i < 0 || j < 0 || i >= width || j >= depth || (x - minX) % resolution != 0 || (z - minZ) % resolution != 0 ? -1 : i + j * width;
	}

	public boolean missing(int k) {
		return (flags[k] & MISSING) != 0;
	}

	public int missingCount() {
		int n = 0;
		for (byte f : flags) {
			n += (f & MISSING) != 0 ? 1 : 0;
		}
		return n;
	}

	public void set(int k, int g, int h, int fl, int f) {
		ground[k] = (short) g;
		height[k] = (short) h;
		floor[k] = (short) fl;
		flags[k] = (byte) f;
	}

	/** The column (x, z) of a loaded chunk, into slot {@code k}. */
	public void survey(int k, LevelChunk c, int x, int z) {
		int lx = x & 15;
		int lz = z & 15;
		int h = c.getHeight(Heightmap.Types.MOTION_BLOCKING_NO_LEAVES, lx, lz);
		int minY = c.getMinY();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos(x, h, z);
		int g = h;
		boolean tree = false;
		while (g > minY) {
			BlockState s = c.getBlockState(p.setY(g));
			if (!s.getFluidState().isEmpty()) {
				break;
			}
			if (s.isAir()) {
				g--;
				continue;
			}
			if (treeLike(s)) {
				tree = true;
				g--;
				continue;
			}
			if (!s.isSolid()) {
				g--; // flowers, grass, snow layers... above the ground
				continue;
			}
			break;
		}
		// leaves above the ground (MOTION_BLOCKING with leaves) count as a tree too
		int withLeaves = c.getHeight(Heightmap.Types.MOTION_BLOCKING, lx, lz); // ChunkAccess.getHeight is the top block's y
		if (withLeaves > g && c.getBlockState(p.setY(withLeaves)).is(BlockTags.LEAVES)) {
			tree = true;
		}
		BlockState top = c.getBlockState(p.setY(g));
		FluidState fs = top.getFluidState();
		int f = 0;
		int fl = g;
		if (!fs.isEmpty()) {
			f |= fs.is(FluidTags.LAVA) ? LAVA : WATER;
			while (fl > minY && !c.getBlockState(p.setY(fl)).getFluidState().isEmpty()) {
				fl--;
			}
		}
		if (tree) {
			f |= TREE;
		}
		set(k, g, h, fl, f);
	}

	/** Logs, leaves and the plants that stand on the ground like trees (the region's ground is below them). */
	public static boolean treeLike(BlockState s) {
		return s.is(BlockTags.LOGS) || s.is(BlockTags.LEAVES) || s.is(Blocks.BAMBOO) || s.is(Blocks.CACTUS) || s.is(Blocks.SUGAR_CANE)
			|| s.is(Blocks.MUSHROOM_STEM) || s.is(Blocks.BROWN_MUSHROOM_BLOCK) || s.is(Blocks.RED_MUSHROOM_BLOCK) || s.is(Blocks.VINE)
			|| s.is(Blocks.COCOA) || s.is(BlockTags.WART_BLOCKS);
	}

	// ------------------------------------------------------------------ ARSV

	public byte[] encode() {
		int n = width * depth;
		ByteBuffer b = ByteBuffer.allocate(HEADER + n * 7).order(ByteOrder.LITTLE_ENDIAN);
		b.put(MAGIC).put((byte) 1).put((byte) 0).put((byte) 0).put((byte) 0);
		b.putInt(minX).putInt(minZ).putInt(width).putInt(depth).putInt(resolution);
		for (short v : ground) {
			b.putShort(v);
		}
		for (short v : height) {
			b.putShort(v);
		}
		for (short v : floor) {
			b.putShort(v);
		}
		b.put(flags);
		return b.array();
	}

	public static Columns decode(byte[] a) {
		ByteBuffer b = ByteBuffer.wrap(a).order(ByteOrder.LITTLE_ENDIAN);
		byte[] m = new byte[4];
		b.get(m);
		if (!java.util.Arrays.equals(m, MAGIC) || b.get() != 1) {
			throw new IllegalArgumentException("not an ARSV v1 buffer");
		}
		b.position(8);
		Columns c = new Columns(b.getInt(), b.getInt(), b.getInt(), b.getInt(), b.getInt());
		int n = c.width * c.depth;
		if (a.length != HEADER + n * 7) {
			throw new IllegalArgumentException("ARSV size " + a.length + " for " + n + " columns");
		}
		for (int k = 0; k < n; k++) {
			c.ground[k] = b.getShort();
		}
		for (int k = 0; k < n; k++) {
			c.height[k] = b.getShort();
		}
		for (int k = 0; k < n; k++) {
			c.floor[k] = b.getShort();
		}
		b.get(c.flags);
		return c;
	}

	/** Copies the columns of {@code from} that fall in this grid (resolution 1 both). */
	public void copyFrom(Columns from) {
		for (int j = 0; j < from.depth; j++) {
			for (int i = 0; i < from.width; i++) {
				int k = from.index(i, j);
				if (from.missing(k)) {
					continue;
				}
				int t = at(from.minX + i * from.resolution, from.minZ + j * from.resolution);
				if (t >= 0) {
					set(t, from.ground[k], from.height[k], from.floor[k], from.flags[k]);
				}
			}
		}
	}
}
