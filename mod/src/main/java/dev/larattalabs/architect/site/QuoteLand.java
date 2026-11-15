package dev.larattalabs.architect.site;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (QL-c) The land a quote's lot is put down on, as the realise finds it: the world with the plan's own writes before the lot on top (its 4e
 * roads' cells, air included, and the tiles' writes in the lot's approach window, plan.json's {@code approachGround}). Set on the quote's
 * thread ({@link #QUOTE}) while its lot's dry-run verdict runs: the verdict's terrain reads (outside the placed box's columns) and the entrance
 * style's surface reads see it, so the quote plans the approach the realise plans. Inside the box's columns the world is read as before
 * (QL-b: every cell there is the template's and is paid).
 *
 * @param states the cells the plan's writes change (cell -> the state they leave)
 * @param tiles the cells a tile of the plan queues (its journal entry owns them at put-down: the style's region-made ground)
 * @param changedByTiles the cells of {@code states} a tile changed (not only a road)
 */
public record QuoteLand(Long2ObjectOpenHashMap<BlockState> states, LongOpenHashSet tiles, LongOpenHashSet changedByTiles) {
	public QuoteLand() {
		this(new Long2ObjectOpenHashMap<>(), new LongOpenHashSet(), new LongOpenHashSet());
	}

	/** Set while a quote's lot verdict runs on this thread; null otherwise. */
	public static final ThreadLocal<@Nullable QuoteLand> QUOTE = new ThreadLocal<>();

	/** The state the plan leaves at a cell, or null when its writes leave the world's. */
	public @Nullable BlockState at(int x, int y, int z) {
		return states.isEmpty() ? null : states.get(BlockPos.asLong(x, y, z));
	}

	/** The quote's land on this thread at a cell outside {@code box}'s columns (null: the world's, or no quote). */
	static @Nullable BlockState outside(dev.larattalabs.architect.placement.Anchors.@Nullable Bounds box, int x, int y, int z) {
		QuoteLand l = QUOTE.get();
		return l == null ? null : l.outsideOf(box, x, y, z);
	}

	/** This land at a cell outside {@code box}'s columns (null: the world's there). */
	public @Nullable BlockState outsideOf(dev.larattalabs.architect.placement.Anchors.@Nullable Bounds box, int x, int y, int z) {
		if (box != null && x >= box.minX() && x <= box.maxX() && z >= box.minZ() && z <= box.maxZ()) {
			return null;
		}
		return at(x, y, z);
	}

	/**
	 * How many cells the tiles changed where an approach plan reads the land: its bounds widened by 2 across and {@code Approach.MAX_CUT} +
	 * {@code Approach.SCAN_UP} up and {@code TerrainFit.MAX_FILL} down, and its stop cell's column (a plan with no rows: its stop only).
	 */
	public int tilesTouching(dev.larattalabs.architect.placement.Approach.Plan a) {
		if (changedByTiles.isEmpty()) {
			return 0;
		}
		int n = 0;
		var b = a.bounds();
		int[] r = a.road();
		for (long p : changedByTiles) {
			int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
			boolean in = b != null && x >= b.minX() - 2 && x <= b.maxX() + 2 && z >= b.minZ() - 2 && z <= b.maxZ() + 2 && y >= b.minY()
				- dev.larattalabs.architect.placement.TerrainFit.MAX_FILL && y <= b.maxY() + dev.larattalabs.architect.placement.Approach.MAX_CUT + 12;
			if (!in && r != null) {
				in = Math.abs(x - r[0]) <= 3 && Math.abs(z - r[2]) <= 3 && Math.abs(y - r[1]) <= 12;
			}
			if (in) {
				n++;
			}
		}
		return n;
	}
}
