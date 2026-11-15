package dev.larattalabs.architect.mixin;

import java.util.function.BiConsumer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Explosion;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/**
 * (J1, RS-c, audit F8) An explosion over a survival region's free write: the block goes as vanilla's, without its loot (a free block never
 * turns into an item), and is remembered as mined so the region's removal puts it back first ({@code RegionFreeDrops}).
 */
@Mixin(BlockBehaviour.class)
public abstract class BlockBehaviourExplosionMixin {
	@Redirect(method = "onExplosionHit", at = @At(value = "INVOKE", target =
		"Lnet/minecraft/world/level/block/Block;dropFromExplosion(Lnet/minecraft/world/level/Explosion;)Z"))
	private boolean architect$freeNoLoot(Block block, Explosion explosion, BlockState state, ServerLevel level, BlockPos pos, Explosion e2,
		BiConsumer<ItemStack, BlockPos> drops) {
		if (dev.larattalabs.architect.site.RegionFreeDrops.takenWithoutDrop(level, pos, true)) {
			return false;
		}
		return block.dropFromExplosion(explosion);
	}
}
