package dev.larattalabs.architect.placed;

import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.IntegerProperty;
import net.minecraft.world.level.block.state.properties.SlabType;
import org.jspecify.annotations.Nullable;

/** The pure rules of what records and what clears a cell (docs/CONTRACT.md "Phase 6c slice PT" §2, §3); {@link Placed} applies them. */
public final class PlacedRules {
	private PlacedRules() {
	}


	/** A player's use of an item (§2): who, where they clicked, what kind of use records. */
	public record Use(@Nullable ServerLevel level, UUID placer, Kind kind, @Nullable BlockPos click, @Nullable Direction face) {
	}

	public enum Kind {
		/** A block item (seeds, lily pads and powder snow included): every cell going from empty or replaceable to a block. */
		BLOCK,
		/** A fluid bucket: the placed source. */
		BUCKET,
		/** A hoe, shovel or axe: the converted cell within 1 of the click. */
		TOOL,
		/** Anything else (bone meal, fire, spawn eggs): nothing records. */
		NONE
	}

	/** Fluid blocks and air: a cell holding one is never tracked (a placed bucket source is the exception, recorded by its use). */
	public static boolean empty(BlockState s) {
		return s.isAir() || s.getBlock() instanceof LiquidBlock;
	}

	/**
	 * (C34) The other half of a two-part block at {@code p}: a door's lower or upper half, a bed's head or foot. Null for anything else.
	 * A claim takes the partner of a half it holds when the partner falls outside the box, so a door whose lower half sits in the
	 * floor row below a box that starts at the player's feet is still the build's entrance.
	 */
	public static @org.jspecify.annotations.Nullable BlockPos partner(BlockState s, BlockPos p) {
		net.minecraft.world.level.block.Block b = s.getBlock();
		if (b instanceof net.minecraft.world.level.block.DoorBlock) {
			return s.getValue(net.minecraft.world.level.block.DoorBlock.HALF) == net.minecraft.world.level.block.state.properties.DoubleBlockHalf.LOWER
				? p.above() : p.below();
		}
		if (b instanceof net.minecraft.world.level.block.BedBlock) {
			return p.relative(net.minecraft.world.level.block.BedBlock.getConnectedDirection(s));
		}
		return null;
	}

	/** Whether a player's use records this change (§2). */
	public static boolean records(Use u, BlockPos pos, BlockState old, BlockState now) {
		BlockPos c = u.click;
		if (c == null) {
			return false;
		}
		int d = Math.max(Math.abs(pos.getX() - c.getX()), Math.max(Math.abs(pos.getY() - c.getY()), Math.abs(pos.getZ() - c.getZ())));
		switch (u.kind) {
			case BLOCK -> {
				if (d > 2 || empty(now)) {
					return false;
				}
				if (empty(old) || old.canBeReplaced()) {
					return true;
				}
				// a block added into its own cell: a slab made double, a candle, pickle, egg or petal more, a snow layer more
				BlockPos target = u.face == null ? c : c.relative(u.face);
				return (pos.equals(c) || pos.equals(target)) && old.getBlock() == now.getBlock() && stacked(old, now);
			}
			case BUCKET -> {
				return d <= 2 && now.getBlock() instanceof LiquidBlock && now.getFluidState().isSource() && !(old.getBlock() instanceof LiquidBlock
					&& old.getFluidState().isSource());
			}
			case TOOL -> {
				return d <= 1 && !empty(old) && !empty(now) && old.getBlock() != now.getBlock();
			}
			default -> {
				return false;
			}
		}
	}

	private static final IntegerProperty[] COUNTS = {BlockStateProperties.CANDLES, BlockStateProperties.PICKLES, BlockStateProperties.EGGS,
		BlockStateProperties.FLOWER_AMOUNT, BlockStateProperties.SEGMENT_AMOUNT, BlockStateProperties.LAYERS};

	private static boolean stacked(BlockState old, BlockState now) {
		if (now.hasProperty(BlockStateProperties.SLAB_TYPE)) {
			return now.getValue(BlockStateProperties.SLAB_TYPE) == SlabType.DOUBLE && old.getValue(BlockStateProperties.SLAB_TYPE) != SlabType.DOUBLE;
		}
		for (IntegerProperty q : COUNTS) {
			if (now.hasProperty(q) && old.hasProperty(q)) {
				return now.getValue(q) > old.getValue(q);
			}
		}
		return false;
	}

}
