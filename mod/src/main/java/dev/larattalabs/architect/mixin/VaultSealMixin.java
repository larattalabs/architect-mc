package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.vault.VaultBlockEntity;
import net.minecraft.world.level.block.entity.vault.VaultConfig;
import net.minecraft.world.level.block.entity.vault.VaultServerData;
import net.minecraft.world.level.block.entity.vault.VaultSharedData;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (Slice LC3 fix, review 5) A vault in a box being removed ({@code RemovalSeal}) takes no key: refused at the head of {@code tryInsertKey},
 * so no key is consumed and no reward queued for ejection before the restore overwrites the vault.
 */
@Mixin(VaultBlockEntity.Server.class)
public abstract class VaultSealMixin {
	@Inject(method = "tryInsertKey", at = @At("HEAD"), cancellable = true)
	private static void architect$sealedKey(ServerLevel level, BlockPos pos, BlockState state, VaultConfig config, VaultServerData server,
		VaultSharedData shared, Player player, ItemStack key, CallbackInfo ci) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesVaultKey(level, pos, player)) {
			ci.cancel();
		}
	}
}
