package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.network.protocol.game.ServerboundContainerButtonClickPacket;
import net.minecraft.network.protocol.game.ServerboundContainerClickPacket;
import net.minecraft.network.protocol.game.ServerboundContainerSlotStateChangedPacket;
import net.minecraft.network.protocol.game.ServerboundPlaceRecipePacket;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T2a fix round, GPT P1-2) Menus over a held box, structurally: whatever the menu type and whatever its own {@code stillValid}
 * says (the crafter's does not call the guarded base), a click, a slot-state toggle, a button or a recipe placement in a menu any of whose
 * slots is backed by a held box (a double chest's compound included) is refused and the menu closed, on the server thread before the menu
 * touches a stack. {@link TxnServer#closeHeldMenus} closes such menus each tick and when a hold begins.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public abstract class TxnHoldMenuMixin {
	@Shadow
	public ServerPlayer player;

	private static final String SAME = "Lnet/minecraft/network/protocol/PacketUtils;ensureRunningOnSameThread(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketListener;Lnet/minecraft/server/level/ServerLevel;)V";

	private boolean architect$heldMenu(CallbackInfo ci) {
		if (TxnServer.menuHeld(player.containerMenu)) {
			player.closeContainer();
			ci.cancel();
			return true;
		}
		return false;
	}

	@Inject(method = "handleContainerClick", at = @At(value = "INVOKE", target = SAME, shift = At.Shift.AFTER), cancellable = true)
	private void architect$txnHeldClick(ServerboundContainerClickPacket p, CallbackInfo ci) {
		architect$heldMenu(ci);
	}

	@Inject(method = "handleContainerSlotStateChanged", at = @At(value = "INVOKE", target = SAME, shift = At.Shift.AFTER), cancellable = true)
	private void architect$txnHeldSlotState(ServerboundContainerSlotStateChangedPacket p, CallbackInfo ci) {
		architect$heldMenu(ci);
	}

	@Inject(method = "handleContainerButtonClick", at = @At(value = "INVOKE", target = SAME, shift = At.Shift.AFTER), cancellable = true)
	private void architect$txnHeldButton(ServerboundContainerButtonClickPacket p, CallbackInfo ci) {
		architect$heldMenu(ci);
	}

	@Inject(method = "handlePlaceRecipe", at = @At(value = "INVOKE", target = SAME, shift = At.Shift.AFTER), cancellable = true)
	private void architect$txnHeldRecipe(ServerboundPlaceRecipePacket p, CallbackInfo ci) {
		architect$heldMenu(ci);
	}
}
