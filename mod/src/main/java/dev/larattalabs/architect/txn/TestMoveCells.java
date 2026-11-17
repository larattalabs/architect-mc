package dev.larattalabs.architect.txn;

import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.entity.BlockEntityTypes;
import net.minecraft.world.level.block.entity.RandomizableContainerBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.ChestType;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1b; widened in slice T2a) What the TEST kind {@code test.move} accepts, kept apart from {@link TestMove} (no Fabric statics) so units
 * can judge it.
 * <ul>
 * <li>A cell is a vanilla container whose every writer a txn hold refuses (docs/TXN-DESIGN.md §6.1, T2a): chests (plain, trapped, copper;
 * either half of a double chest, whose partner the txn holds too), barrels, shulker boxes, hoppers, droppers, dispensers, crafters, the
 * furnace family and brewing stands ({@link #HELD_TYPES}). Every other block entity is refused: campfires, lecterns, jukeboxes, chiseled
 * bookshelves, decorated pots, shelves, brushable blocks, Architect's crates (T2b's own kind) and every modded type, whose writers are not
 * enumerated. A container with a loot table still to unpack is refused too (unpacking writes its slots outside any guarded path).</li>
 * <li>A dimension is a registry key in its canonical form ({@code minecraft:overworld}), so the box resource a txn holds is the very key
 * the hold mixins look up ({@link TxnServer#boxHeld}); {@code overworld} would name a box no writer ever checks.</li>
 * </ul>
 */
public final class TestMoveCells {
	private TestMoveCells() {
	}

	/** The block entity types whose every writer the T2a holds refuse (each has a row in the in-game step txn-holds). */
	public static final Set<BlockEntityType<?>> HELD_TYPES = Set.of(BlockEntityTypes.CHEST, BlockEntityTypes.TRAPPED_CHEST, BlockEntityTypes.BARREL,
		BlockEntityTypes.SHULKER_BOX, BlockEntityTypes.HOPPER, BlockEntityTypes.DROPPER, BlockEntityTypes.DISPENSER, BlockEntityTypes.CRAFTER,
		BlockEntityTypes.FURNACE, BlockEntityTypes.BLAST_FURNACE, BlockEntityTypes.SMOKER, BlockEntityTypes.BREWING_STAND);

	/** Why the cell at {@code p} can't take part in a test.move, or null when every writer of its type is held. */
	public static @Nullable String refusal(BlockPos p, @Nullable BlockEntity be) {
		String at = "[" + p.getX() + ", " + p.getY() + ", " + p.getZ() + "]";
		String only = "test.move moves only between held container types (chests, barrels, shulker boxes, hoppers, droppers, dispensers, crafters, "
			+ "furnaces, brewing stands); ";
		if (be == null) {
			return only + at + " has no block entity";
		}
		BlockState st = be.getBlockState();
		if (!HELD_TYPES.contains(be.getType()) || !(be instanceof Container)) {
			Identifier k = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType());
			return only + at + " is " + (k == null ? be.getClass().getSimpleName() : k) + " (" + BuiltInRegistries.BLOCK.getKey(st.getBlock()) + ")";
		}
		boolean chestType = be.getType() == BlockEntityTypes.CHEST || be.getType() == BlockEntityTypes.TRAPPED_CHEST;
		if (chestType != st.getBlock() instanceof ChestBlock) {
			return only + at + " is a chest block entity on " + BuiltInRegistries.BLOCK.getKey(st.getBlock());
		}
		if (be instanceof RandomizableContainerBlockEntity r && r.getLootTable() != null) {
			return only + at + " still has a loot table to unpack";
		}
		return null;
	}

	/**
	 * The other half of a double chest at {@code p} (its state names the partner), or null for a single chest or any other cell. A txn on
	 * either half holds both: the combined container reaches this half's slots through the other (§6.1 item 1).
	 */
	public static @Nullable BlockPos partner(BlockPos p, @Nullable BlockState st) {
		if (st == null || !(st.getBlock() instanceof ChestBlock) || !st.hasProperty(ChestBlock.TYPE) || st.getValue(ChestBlock.TYPE) == ChestType.SINGLE) {
			return null;
		}
		return ChestBlock.getConnectedBlockPos(p, st);
	}

	/** The canonical form of dimension key {@code dim} ({@code namespace:path}), or null when it is not a well-formed key in that form. */
	public static @Nullable String canonicalDim(@Nullable String dim) {
		if (dim == null || dim.isEmpty()) {
			return null;
		}
		Identifier id = Identifier.tryParse(dim);
		return id == null || !id.toString().equals(dim) ? null : dim;
	}

	/** Why dimension {@code dim} is refused, or null when it is a canonical key (the level itself is looked up by the caller). */
	public static @Nullable String dimRefusal(@Nullable String dim) {
		if (dim == null || dim.isEmpty()) {
			return "dimension is required";
		}
		Identifier id = Identifier.tryParse(dim);
		if (id == null) {
			return "dimension " + dim + " is not a resource key";
		}
		return id.toString().equals(dim) ? null : "dimension " + dim + " is not canonical (use " + id + ")";
	}
}
