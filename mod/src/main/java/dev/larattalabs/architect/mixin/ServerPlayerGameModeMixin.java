package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.ServerPlayerGameMode;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.BlockHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 6c PT §2: a player's use of an item is the scope inside which the cells it places are recorded as theirs. */
@Mixin(ServerPlayerGameMode.class)
public abstract class ServerPlayerGameModeMixin {
	@Inject(method = "useItemOn", at = @At("HEAD"))
	private void architect$useOnBegin(ServerPlayer player, Level level, ItemStack stack, InteractionHand hand, BlockHitResult hit,
		CallbackInfoReturnable<InteractionResult> cir) {
		Placed.beginUse(player, level, stack, hit);
	}

	@Inject(method = "useItemOn", at = @At("RETURN"))
	private void architect$useOnEnd(ServerPlayer player, Level level, ItemStack stack, InteractionHand hand, BlockHitResult hit,
		CallbackInfoReturnable<InteractionResult> cir) {
		Placed.endUse();
	}

	@Inject(method = "useItem", at = @At("HEAD"))
	private void architect$useBegin(ServerPlayer player, Level level, ItemStack stack, InteractionHand hand, CallbackInfoReturnable<InteractionResult> cir) {
		Placed.beginUse(player, level, stack, null);
	}

	@Inject(method = "useItem", at = @At("RETURN"))
	private void architect$useEnd(ServerPlayer player, Level level, ItemStack stack, InteractionHand hand, CallbackInfoReturnable<InteractionResult> cir) {
		Placed.endUse();
	}
}
