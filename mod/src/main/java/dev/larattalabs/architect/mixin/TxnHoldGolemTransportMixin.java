package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.behavior.TransportItemsBetweenContainers;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T2a fix round, GPT P1-3) A copper golem that chose its target before the hold keeps it (vanilla re-checks only the block
 * entity's identity): its take and its put are refused at the moment they would touch a held box (a compound's half included), before
 * any stack changes, so the golem keeps what it carries and the box keeps its slots.
 */
@Mixin(TransportItemsBetweenContainers.class)
public abstract class TxnHoldGolemTransportMixin {
	@Inject(method = "pickUpItems", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldTake(PathfinderMob mob, Container c, CallbackInfo ci) {
		if (TxnServer.containerHeld(c)) {
			ci.cancel();
		}
	}

	@Inject(method = "putDownItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldPut(PathfinderMob mob, Container c, CallbackInfo ci) {
		if (TxnServer.containerHeld(c)) {
			ci.cancel();
		}
	}
}
