package dev.larattalabs.architect.journal;

import java.util.Set;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.world.level.block.AbstractCauldronBlock;
import net.minecraft.world.level.block.BaseRailBlock;
import net.minecraft.world.level.block.ComposterBlock;
import net.minecraft.world.level.block.CrossCollisionBlock;
import net.minecraft.world.level.block.FenceBlock;
import net.minecraft.world.level.block.HugeMushroomBlock;
import net.minecraft.world.level.block.IronBarsBlock;
import net.minecraft.world.level.block.RedstoneWireBlock;
import net.minecraft.world.level.block.SpeleothemBlock;
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
 * write: the undo puts the cell back and the flow recedes). Since 6c CU a copper block at another weathering stage of its chain, waxed or
 * scraped, still holds the stage we wrote ({@link Copper}: the same form; shape-defining properties still compare), and farmland and dirt
 * are interchangeable. Since 6c F3 a huge mushroom block's six faces and pointed dripstone's {@code thickness} are volatile, and a dead coral
 * still holds the live coral we wrote ({@link Coral}). Pure: a player's record (PT) is the caller's to consult first.
 */
public final class StillOurs {
	/** Volatile on every block. */
	static final Set<String> VOLATILE = Set.of("open", "powered", "power", "lit", "triggered", "enabled", "extended", "occupied", "in_wall", "snowy",
		"waterlogged", "distance", "moisture", "age", "stage", "honey_level", "bites");
	/** Volatile on fences, walls, panes, iron bars and redstone wire. */
	static final Set<String> CONNECTIONS = Set.of("north", "east", "south", "west", "up");
	/**
	 * (6c F3 §6) Volatile on huge mushroom blocks and stems: the six faces, which {@code HugeMushroomBlock.updateShape} sets false next to
	 * the same block whenever a neighbour changes (a player's block beside a cap, the cap's own neighbour removed).
	 */
	static final Set<String> FACES = Set.of("north", "east", "south", "west", "up", "down");

	private StillOurs() {
	}

	/** Whether {@code p} of {@code s} is ignored when deciding a cell is still ours. */
	public static boolean volatileProperty(BlockState s, String p) {
		if (VOLATILE.contains(p)) {
			return true;
		}
		var b = s.getBlock();
		if (b instanceof HugeMushroomBlock && FACES.contains(p)) {
			return true; // (6c F3 §6)
		}
		if (b instanceof SpeleothemBlock && p.equals("thickness")) {
			return true; // (6c F3 §6) pointed dripstone: its thickness follows its neighbours (vertical_direction stays shape-defining)
		}
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

	/**
	 * (6c H §4.3) A cell an entry wrote as a water source or an ice cap is still the entry's in any water state (any level), as ice or
	 * frosted ice, or as air (it froze, thawed, flowed, or a bucket took it); one written as a lava source in any lava state or as air.
	 * Nothing else changes: a player's block in a pond is not the entry's.
	 */
	public static boolean fluidHolds(BlockState now, BlockState after) {
		var a = after.getBlock();
		var n = now.getBlock();
		boolean waterOrIce = n == net.minecraft.world.level.block.Blocks.WATER || n == net.minecraft.world.level.block.Blocks.ICE
			|| n == net.minecraft.world.level.block.Blocks.FROSTED_ICE || now.isAir();
		if (a == net.minecraft.world.level.block.Blocks.WATER && after.getFluidState().isSource() || a == net.minecraft.world.level.block.Blocks.ICE) {
			return waterOrIce;
		}
		if (a == net.minecraft.world.level.block.Blocks.LAVA && after.getFluidState().isSource()) {
			return n == net.minecraft.world.level.block.Blocks.LAVA || now.isAir();
		}
		return false;
	}

	/** Whether {@code now} (with its block entity data {@code nowNbt}, null without one) still holds {@code after}. */
	public static boolean holds(BlockState now, @Nullable CompoundTag nowNbt, BlockState after, @Nullable CompoundTag afterNbt) {
		if (fluidHolds(now, after)) {
			return true; // (6c H §4.3)
		}
		if (after.isAir() && (now.getBlock() == net.minecraft.world.level.block.Blocks.WATER || now.getBlock() == net.minecraft.world.level.block.Blocks.LAVA)) {
			// phase 6a: water or lava that flowed into air an entry cleared is the entry's doing, not a player's: still ours
			return true;
		}
		if (spread(now) && spread(after) && now.getBlock() != after.getBlock()) {
			// phase 6a: grass, mycelium and podzol die to dirt under a block and spread back onto it by random ticks: the world's doing
			return true;
		}
		// (6c CU §2.2) a copper block at any weathering stage, waxed or not, is the same block as the stage we wrote: the same form
		boolean copper = now.getBlock() != after.getBlock() && Copper.sameBlock(now.getBlock(), after.getBlock());
		// (6c F3 §6) a coral that died (its pond drained, its water gone) is the live coral we wrote: the same form, as copper's stages
		copper = copper || now.getBlock() != after.getBlock() && Coral.sameBlock(now.getBlock(), after.getBlock());
		if (now.getBlock() != after.getBlock() && !copper) {
			return false;
		}
		if (now != after) {
			for (Property<?> p : now.getProperties()) {
				if (volatileProperty(now, p.getName())) {
					continue;
				}
				if (copper && !after.hasProperty(p) || !now.getValue(p).equals(after.getValue(p))) {
					return false;
				}
			}
			if (copper) {
				for (Property<?> p : after.getProperties()) {
					if (!now.hasProperty(p) && !volatileProperty(after, p.getName())) {
						return false;
					}
				}
			}
		}
		if (now.hasBlockEntity() != after.hasBlockEntity()) {
			return false;
		}
		return !(emptyContainer(afterNbt) && !emptyContainer(nowNbt));
	}

	/**
	 * Dirt and the blocks random ticks turn it into and back. (6c CU, S-CU-3) Farmland too: it dries or is trampled to dirt, so a cell we
	 * wrote as farmland or as dirt is ours as either.
	 */
	static boolean spread(BlockState s) {
		var b = s.getBlock();
		return b == net.minecraft.world.level.block.Blocks.DIRT || b == net.minecraft.world.level.block.Blocks.GRASS_BLOCK
			|| b == net.minecraft.world.level.block.Blocks.MYCELIUM || b == net.minecraft.world.level.block.Blocks.PODZOL
			|| b == net.minecraft.world.level.block.Blocks.FARMLAND;
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
