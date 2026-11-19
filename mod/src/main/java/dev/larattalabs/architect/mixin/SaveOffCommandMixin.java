package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.brigadier.exceptions.SimpleCommandExceptionType;
import dev.larattalabs.architect.site.SaveHold;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.commands.SaveOffCommand;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * (slice SOFF2 fix round, finding 3) /save-off refused by Architect (its barrier could not make pending stock changes durable): the op is told
 * why, instead of vanilla's "saving is already off".
 */
@Mixin(SaveOffCommand.class)
public abstract class SaveOffCommandMixin {
	@WrapOperation(method = "lambda$register$0", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/MinecraftServer;setAutoSave(Z)Z"))
	private static boolean architect$refused(MinecraftServer srv, boolean on, Operation<Boolean> original) throws CommandSyntaxException {
		boolean changed = original.call(srv, on);
		String why = SaveHold.takeSaveOffRefusal();
		if (why != null) {
			throw new SimpleCommandExceptionType(Component.literal(why)).create();
		}
		return changed;
	}
}
