package dev.larattalabs.architect.survival;

import dev.larattalabs.architect.site.Builder;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.BaseEntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import org.jspecify.annotations.Nullable;

/**
 * {@code architect_mc:construction_crate} (docs/CONTRACT.md phase 3 "The crate"): put at a construction site's approach end;
 * hoppers and droppers feed it ({@link CrateBlockEntity}), right-click opens the crate screen. While its site builds it is
 * unbreakable for players (a message points to Deconstruct), explosion-immune (blast resistance of bedrock; in the
 * {@code wither_immune} and {@code dragon_immune} tags) and immovable by pistons. No item, no drops: the site puts it down and
 * takes it away. Lava, {@code /setblock} and the like can still remove it: that is the "crate missing" case.
 */
public final class CrateBlock extends BaseEntityBlock {
	public CrateBlock(BlockBehaviour.Properties properties) {
		super(properties);
	}

	@Override
	protected InteractionResult useWithoutItem(BlockState state, Level level, BlockPos pos, Player player, BlockHitResult hit) {
		if (level instanceof ServerLevel sl && player instanceof ServerPlayer sp && level.getBlockEntity(pos) instanceof CrateBlockEntity crate) {
			Builder.openCrate(sl, sp, crate);
		}
		return InteractionResult.SUCCESS;
	}

	@Override
	public @Nullable BlockEntity newBlockEntity(BlockPos pos, BlockState state) {
		return new CrateBlockEntity(pos, state);
	}
}
