package dev.larattalabs.architect.txn;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityTypes;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.ChestType;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1b) What the TEST kind {@code test.move} accepts, kept apart from {@link TestMove} (no Fabric statics) so units can judge it.
 * <ul>
 * <li>A cell is a <b>single plain chest</b> or it is refused. The T1 holds don't cover a double chest's partner (its combined
 * container reaches this half's slots), the per-type writers of droppers, dispensers and furnaces, or anything else with its own
 * block entity type (barrels, hoppers, shulker boxes, trapped chests, Architect's crates). docs/TXN-DESIGN.md §6.1 makes complete holds
 * for those T2's entry criterion.</li>
 * <li>A dimension is a registry key in its canonical form ({@code minecraft:overworld}), so the box resource a txn holds is the very key
 * the hold mixins look up ({@link TxnServer#boxHeld}); {@code overworld} would name a box no writer ever checks.</li>
 * </ul>
 */
public final class TestMoveCells {
	private TestMoveCells() {
	}

	/** Why the cell at {@code p} can't take part in a test.move, or null when it is a single plain chest. */
	public static @Nullable String refusal(BlockPos p, @Nullable BlockEntity be) {
		String at = "[" + p.getX() + ", " + p.getY() + ", " + p.getZ() + "]";
		String only = "test.move moves only between single plain chests; ";
		if (be == null) {
			return only + at + " has no block entity";
		}
		BlockState st = be.getBlockState();
		if (be.getType() != BlockEntityTypes.CHEST || !st.is(Blocks.CHEST)) {
			Identifier k = BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType());
			return only + at + " is " + (k == null ? be.getClass().getSimpleName() : k) + " (" + BuiltInRegistries.BLOCK.getKey(st.getBlock()) + ")";
		}
		if (!st.hasProperty(ChestBlock.TYPE) || st.getValue(ChestBlock.TYPE) != ChestType.SINGLE) {
			return only + at + " is half of a double chest (its partner is not held)";
		}
		return null;
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
