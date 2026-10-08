package dev.larattalabs.architect.journal;

import java.util.Set;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.world.level.block.AbstractCauldronBlock;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.ComposterBlock;
import net.minecraft.world.level.block.CrossCollisionBlock;
import net.minecraft.world.level.block.FenceBlock;
import net.minecraft.world.level.block.IronBarsBlock;
import net.minecraft.world.level.block.RedstoneWireBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.WallBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import org.jspecify.annotations.Nullable;

/**
 * "Still ours" for CELL entries (docs/CONTRACT.md "Phase 4e contract", "Still ours", with Steward's S2): a cell's world state
 * still holds {@code after} when it is the same block, every property is equal except the volatile ones, it has a block
 * entity exactly when {@code after} does, and a container is empty when {@code after}'s was empty. For leaves the volatile
 * {@code distance} (and {@code waterlogged}) leave only the block and {@code persistent}, which is AgentCraft's
 * {@code LeafGuard.stillHeld}. Since phase 6a a fluid in air the entry cleared counts as still the entry's (it flowed in after the
 * write: the undo puts the cell back and the flow recedes).
 */
public final class StillOurs {
	/** Volatile on every block. */
	static final Set<String> VOLATILE = Set.of("open", "powered", "power", "lit", "triggered", "enabled", "extended", "occupied", "in_wall", "snowy",
		"waterlogged", "distance", "moisture", "age", "stage", "honey_level", "bites");
	/** Volatile on fences, walls, panes, iron bars and redstone wire. */
	static final Set<String> CONNECTIONS = Set.of("north", "east", "south", "west", "up");

	private StillOurs() {
	}

	/** Whether {@code p} of {@code s} is ignored when deciding a cell is still ours. */
	public static boolean volatileProperty(BlockState s, String p) {
		if (VOLATILE.contains(p)) {
			return true;
		}
		var b = s.getBlock();
		if (CONNECTIONS.contains(p)) {
			return b instanceof CrossCollisionBlock || b instanceof WallBlock || b instanceof RedstoneWireBlock || b instanceof FenceBlock
				|| b instanceof IronBarsBlock;
		}
		if (p.equals("shape")) {
			return b instanceof StairBlock || b instanceof BaseRailBlock;
		}
		if (p.equals("level")) {
			return b instanceof ComposterBlock || b instanceof AbstractCauldronBlock;
		}
		return false;
	}

	/** Whether {@code now} (with its block entity data {@code nowNbt}, null without one) still holds {@code after}. */
	public static boolean holds(BlockState now, @Nullable CompoundTag nowNbt, BlockState after, @Nullable CompoundTag afterNbt) {
		if (after.isAir() && (now.getBlock() == net.minecraft.world.level.block.Blocks.WATER || now.getBlock() == net.minecraft.world.level.block.Blocks.LAVA)) {
			// phase 6a: water or lava that flowed into air an entry cleared is the entry's doing, not a player's: still ours
			return true;
		}
		if (now.getBlock() != after.getBlock()) {
			return false;
		}
		if (now != after) {
			for (Property<?> p : now.getProperties()) {
				if (!volatileProperty(now, p.getName()) && !now.getValue(p).equals(after.getValue(p))) {
					return false;
				}
			}
		}
		if (now.hasBlockEntity() != after.hasBlockEntity()) {
			return false;
		}
		return !(emptyContainer(afterNbt) && !emptyContainer(nowNbt));
	}

	/** A container's data with no items (no data at all counts as empty). */
	static boolean emptyContainer(@Nullable CompoundTag nbt) {
		if (nbt == null) {
			return true;
		}
		for (String k : new String[] {"Items", "item", "RecordItem", "Book"}) {
			var t = nbt.get(k);
			if (t instanceof ListTag l && !l.isEmpty()) {
				return false;
			}
			if (t instanceof CompoundTag c && !c.isEmpty()) {
				return false;
			}
		}
		return true;
	}
}
