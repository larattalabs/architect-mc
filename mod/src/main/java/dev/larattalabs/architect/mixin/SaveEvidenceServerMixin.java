package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.larattalabs.architect.site.DurableBarrier;
import dev.larattalabs.architect.site.SaveEvidence;
import dev.larattalabs.architect.site.SaveHold;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice SOFF; SOFF2: per invocation) Each save method's own record ({@link SaveEvidence}): saveAllChunks, saveEverything and stopServer each
 * push a frame for the whole method (Fabric's BEFORE_SAVE and AFTER_SAVE run inside it) and pop it in a finally, an exception included. In
 * saveEverything and stopServer the players count as saved only once their PlayerList.saveAll returned with no player save failing, and only
 * for the method's own saveAllChunks call after it. /save-off ({@code setAutoSave(false)}) runs Architect's hold and confirmed save first.
 */
@Mixin(MinecraftServer.class)
public abstract class SaveEvidenceServerMixin {
	@WrapMethod(method = "saveAllChunks")
	private boolean architect$chunksFrame(boolean silent, boolean flush, boolean force, Operation<Boolean> original) {
		SaveEvidence.Frame f = SaveEvidence.enter(SaveEvidence.Kind.CHUNKS);
		boolean done = false;
		try {
			boolean r = original.call(silent, flush, force);
			done = true;
			return r;
		} finally {
			SaveEvidence.exit(f, done);
		}
	}

	@WrapMethod(method = "saveEverything")
	private boolean architect$everythingFrame(boolean silent, boolean flush, boolean force, Operation<Boolean> original) {
		SaveEvidence.Frame f = SaveEvidence.enter(SaveEvidence.Kind.EVERYTHING);
		boolean done = false;
		try {
			boolean r = original.call(silent, flush, force);
			done = true;
			return r;
		} finally {
			SaveEvidence.exit(f, done);
		}
	}

	@WrapMethod(method = "stopServer")
	private void architect$stopFrame(Operation<Void> original) {
		SaveEvidence.Frame f = SaveEvidence.enter(SaveEvidence.Kind.STOP);
		boolean done = false;
		try {
			original.call();
			done = true;
		} finally {
			SaveEvidence.exit(f, done);
		}
	}

	@WrapOperation(method = {"saveEverything", "stopServer"}, at = @At(value = "INVOKE", target = "Lnet/minecraft/server/players/PlayerList;saveAll()V"))
	private void architect$players(PlayerList list, Operation<Void> original) {
		SaveEvidence.Frame owner = SaveEvidence.top();
		int failed0 = DurableBarrier.PLAYER_SAVE_FAILURES.get();
		original.call(list);
		if (SaveEvidence.owner(owner)) {
			SaveEvidence.playersSaved(owner, DurableBarrier.PLAYER_SAVE_FAILURES.get() == failed0); // only after it completed
		}
	}

	@WrapOperation(method = {"saveEverything", "stopServer"}, at = @At(value = "INVOKE", target = "Lnet/minecraft/server/MinecraftServer;saveAllChunks(ZZZ)Z"))
	private boolean architect$ownChunkSave(MinecraftServer srv, boolean silent, boolean flush, boolean force, Operation<Boolean> original) {
		SaveEvidence.Frame owner = SaveEvidence.top();
		if (SaveEvidence.owner(owner)) {
			SaveEvidence.ownChunkSave(owner);
		}
		return original.call(srv, silent, flush, force);
	}

	@Inject(method = "setAutoSave", at = @At("HEAD"), cancellable = true)
	private void architect$beforeSavingOff(boolean on, CallbackInfoReturnable<Boolean> cir) {
		if (!on && SaveHold.beforeSavingOff((MinecraftServer) (Object) this) != null) {
			cir.setReturnValue(false); // (SOFF2 fix round, finding 3) refused: no level's saving turns off
		}
	}
}
